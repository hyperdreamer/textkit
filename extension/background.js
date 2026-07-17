
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8765;
const FILE_BRIDGE_DEFAULT_PORT = 8766;
const OVERLAP_PX = 50;
const AFTER_SEND_DELAY_MS = 0;
const DEFAULT_CAPTURE_INTERVAL_MS = 100;
const BACKEND_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_CAPTURE_PAGES = 500;
const MAX_SAVE_PATH_CHARS = 1024;
const LOCAL_BACKEND_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

let _backendBaseUrl = null;
let _backendBaseUrlExpiry = 0;
let _fileBridgeBaseUrl = null;
let _fileBridgeBaseUrlExpiry = 0;

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes.backendHost || changes.backendPort) {
    _backendBaseUrl = null;
    _backendBaseUrlExpiry = 0;
  }
  if (changes.fileBridgeHost || changes.fileBridgePort) {
    _fileBridgeBaseUrl = null;
    _fileBridgeBaseUrlExpiry = 0;
  }
});

async function getBackendEndpoint(path) {
  if (!_backendBaseUrl || Date.now() > _backendBaseUrlExpiry) {
    const items = await chrome.storage.sync.get({ backendHost: DEFAULT_HOST, backendPort: DEFAULT_PORT });
    _backendBaseUrl = buildBackendEndpoint(items.backendHost, items.backendPort, '');
    _backendBaseUrlExpiry = Date.now() + 60_000;  // cache 1 minute
  }
  return _backendBaseUrl + path;
}

async function getFileBridgeEndpoint(path) {
  if (!_fileBridgeBaseUrl || Date.now() > _fileBridgeBaseUrlExpiry) {
    const items = await chrome.storage.sync.get({
      fileBridgeHost: '',
      fileBridgePort: FILE_BRIDGE_DEFAULT_PORT
    });
    const hasFileBridgeHost = String(items.fileBridgeHost || '').trim().length > 0;
    const host = hasFileBridgeHost ? items.fileBridgeHost : DEFAULT_HOST;
    const port = items.fileBridgePort || FILE_BRIDGE_DEFAULT_PORT;
    _fileBridgeBaseUrl = buildBackendEndpoint(host, port, '');
    _fileBridgeBaseUrlExpiry = Date.now() + 60_000;
  }
  return _fileBridgeBaseUrl + path;
}

async function getBackendHeaders(contentType) {
  const { backendToken } = await chrome.storage.sync.get({ backendToken: '' });
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (String(backendToken || '').trim()) headers['X-TextKit-Token'] = String(backendToken).trim();
  return headers;
}

async function getFileBridgeHeaders(contentType = 'application/json') {
  const { fileBridgeToken } = await chrome.storage.sync.get({ fileBridgeToken: '' });
  const token = String(fileBridgeToken || '').trim();
  if (!token) throw new Error('File bridge token is required. Configure it in Settings.');
  return {
    ...(contentType ? { 'Content-Type': contentType } : {}),
    'X-TextKit-Bridge-Token': token
  };
}

function normalizeSavePath(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Save path is required.');
  if (raw.length > MAX_SAVE_PATH_CHARS || raw.includes('\0')) throw new Error('Save path is invalid or too long.');
  const slashPath = raw.replace(/\\/g, '/');
  if (slashPath.startsWith('/') || /^[A-Za-z]:\//.test(slashPath)) {
    throw new Error('Save path must be relative to the file bridge root.');
  }
  const parts = slashPath.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) {
    throw new Error('Save path must not contain traversal segments.');
  }
  return parts.join('/');
}

async function readJsonObject(response, label) {
  const raw = await response.text();
  if (!raw.trim()) throw new Error(`${label} returned an empty response.`);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${label} returned an invalid response schema.`);
  }
  return payload;
}

function requireTextPayload(payload, label) {
  if (payload.error) throw new Error(String(payload.error));
  if (typeof payload.text !== 'string') throw new Error(`${label} response is missing text.`);
  return payload.text;
}

function buildBackendEndpoint(host, port, path) {
  const normalized = normalizeBackendSettings(host, port);
  return `http://${normalized.host}:${normalized.port}${path}`;
}

function normalizeBackendSettings(host, port) {
  let normalizedHost = String(host || DEFAULT_HOST).trim();
  if (/^https?:\/\//i.test(normalizedHost)) {
    normalizedHost = new URL(normalizedHost).hostname;
  }
  normalizedHost = normalizedHost.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!LOCAL_BACKEND_HOSTS.has(normalizedHost)) {
    throw new Error('Backend host must be localhost, 127.0.0.1, or ::1.');
  }

  const normalizedPort = Number.parseInt(port, 10);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    throw new Error('Backend port must be between 1 and 65535.');
  }

  return {
    host: normalizedHost === '::1' ? '[::1]' : normalizedHost,
    port: normalizedPort
  };
}

function normalizeCustomPrompt(value) {
  const prompt = value == null ? '' : String(value);
  return prompt.trim() ? prompt : undefined;
}

function normalizeCapturePrompts(prompts = {}) {
  return {
    ocr: normalizeCustomPrompt(prompts.ocr),
    dedup: normalizeCustomPrompt(prompts.dedup)
  };
}

function createSelectionToken() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function snapshotCapturePrompts() {
  const stored = await chrome.storage.local.get(['ocrPrompt', 'dedupPrompt']);
  return normalizeCapturePrompts({
    ocr: stored.ocrPrompt,
    dedup: stored.dedupPrompt
  });
}

let states = new Map();
let savedLastRegion = null;
const windowActivationGenerations = new Map();
const targetTabWaiters = new Set();
let targetTabChangeRevision = 0;
const pendingOffscreenCopies = new Map();
let nextOffscreenCopyId = 1;

function getState(tabId) {
  if (!states.has(tabId)) {
    states.set(tabId, {
      active: false, status: 'Idle', currentPage: 0, fragmentsCollected: 0,
      progress: 'Ready', mergedText: '', fragments: [], error: '',
      lastRegion: savedLastRegion, stopRequested: false, retryState: null,
      retryStage: null, pendingText: '', captureInFlight: false,
      targetRemoved: false, navigationChanged: false, captureUrl: null,
      collectionComplete: false, partialReason: '', partialError: '', operationPrompts: null,
      selectionToken: null
    });
  }
  return states.get(tabId);
}

async function getRecoverableState(tabId) {
  const state = getState(tabId);
  if (state.status !== 'Idle' || state.captureInFlight || state.retryState) return state;
  const retryState = await loadRetryState(tabId);
  if (!retryState) return state;

  const fragments = Array.isArray(retryState.fragments) ? retryState.fragments : [];
  Object.assign(state, {
    active: true,
    status: 'Error',
    progress: retryState.stage === 'dedup'
      ? 'Dedup retry was interrupted. Click Retry to continue.'
      : 'OCR retry was interrupted. Click Retry to continue.',
    error: 'The extension service worker restarted during a backend retry.',
    fragments,
    fragmentsCollected: fragments.length,
    retryState,
    operationPrompts: normalizeCapturePrompts(retryState.promptSnapshot)
  });
  return state;
}

// Load saved region on startup
chrome.storage.local.get('lastRegion', (items) => {
  if (items.lastRegion) {
    savedLastRegion = items.lastRegion;
    states.forEach((state) => { state.lastRegion = savedLastRegion; });
  }
});

async function recoverScrollLocks() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs
    .filter((tab) => tab?.id)
    .map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'page:unlock-scroll' })));
}

recoverScrollLocks().catch(() => {});

function notifyTargetTabChange() {
  targetTabChangeRevision += 1;
  for (const notify of [...targetTabWaiters]) notify();
}

chrome.tabs.onActivated.addListener(({ windowId }) => {
  windowActivationGenerations.set(windowId, (windowActivationGenerations.get(windowId) || 0) + 1);
  notifyTargetTabChange();
});
chrome.tabs.onAttached?.addListener(notifyTargetTabChange);
chrome.tabs.onDetached?.addListener(notifyTargetTabChange);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const state = states.get(tabId);
  if (!state?.captureInFlight || state.collectionComplete || !state.captureUrl || changeInfo.url === state.captureUrl) return;
  markTargetNavigated(tabId, state);
});

// Clean up per-tab state and storage when a tab is closed, so the in-memory
// Map and chrome.storage.local don't grow unbounded over a browsing session.
chrome.tabs.onRemoved.addListener((tabId) => {
  const state = states.get(tabId);
  const captureInFlight = Boolean(state?.captureInFlight);
  if (captureInFlight) {
    state.targetRemoved = true;
    state.partialReason = 'tab_closed';
  }
  else states.delete(tabId);
  notifyTargetTabChange();
  handleTranslateStop(tabId);
  handleFormatStop(tabId);
  captureControllers.get(tabId)?.abort();
  captureControllers.delete(tabId);
  if (captureInFlight) return;
  chrome.storage.local.remove([
    `lastResult:${tabId}`,
    `tl2Result:${tabId}`,
    `tl2Status:${tabId}`,
    `tl2Translating:${tabId}`,
    `fmtResult:${tabId}`,
    `fmtStatus:${tabId}`,
    `fmtFormatting:${tabId}`,
    `retryState:${tabId}`,
    `preDedup:${tabId}`,
    `postDedup:${tabId}`,
    `lastStatus:${tabId}`
  ]).catch(() => {});
});
// ── keyboard shortcut ──────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-region-capture') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return;
    }
    const state = getState(tab.id);
    if (state.active || state.captureInFlight || state.status === 'Selecting') {
      console.warn('A capture is already active for this tab.');
      return;
    }
    await ensureContentScript(tab.id);
    state.operationPrompts = await snapshotCapturePrompts();
    state.selectionToken = createSelectionToken();

    updateState(tab.id, { active: true, status: 'Selecting', progress: 'Drag a rectangle.' });
    await chrome.tabs.sendMessage(tab.id, {
      type: 'selection:start',
      lastRegion: state.lastRegion || undefined,
      selectionToken: state.selectionToken
    });
  } catch (e) {
    console.error('Command handler failed:', e);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      getState(tab.id).selectionToken = null;
      updateState(tab.id, { active: false, status: 'Error', error: e.message, progress: 'Failed.' });
    }
  }
});

// ── message routing ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'popup:start') {
    handlePopupStart(message).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'popup:get-state') {
    getActiveTab()
      .then(async (tab) => sendResponse({ ok: true, state: await getRecoverableState(tab.id), tabId: tab.id }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'offscreen:copied' || message?.type === 'offscreen:copy-failed') {
    handleOffscreenCopyResult(message);
    return false;
  }
  if (message?.type === 'selection:complete') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No sender tab found.' });
      return false;
    }
    if (!isValidRegion(message.region)) {
      updateState(tabId, { active: false, status: 'Error', error: 'Invalid selected region.', progress: 'Failed.' });
      sendResponse({ ok: false, error: 'Invalid selected region.' });
      return false;
    }
    const state = getState(tabId);
    if (state.status !== 'Selecting' || !state.selectionToken || message.selectionToken !== state.selectionToken) {
      sendResponse({ ok: false, error: 'Selection confirmation is stale or unauthorized.' });
      return false;
    }
    state.selectionToken = null;
    // Remember region for reuse
    const { x, y, width, height } = message.region;
    const saved = { x, y, width, height };
    chrome.storage.local.set({ lastRegion: saved });
    savedLastRegion = saved;
    states.forEach((state) => { state.lastRegion = saved; });
    broadcastState(tabId);
    // Acknowledge immediately and let the background service worker own the
    // long-running OCR → dedup → translate pipeline.  Keeping this message
    // channel open until capture completes couples the pipeline lifetime to the
    // sender context; if the popup/content context disappears, the backend
    // connection can be aborted before uvicorn logs the /dedup 200.
    sendResponse({ ok: true });
    runCaptureLoop(sender.tab, message.region)
      .catch((error) => handleCaptureLoopFailure(tabId, error, 'Capture loop failed:'));
    return false;
  }
  if (message?.type === 'popup:start-with-region') {
    handleReuseRegion().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'selection:cancelled') {
    const tabId = sender.tab?.id;
    const state = tabId ? getState(tabId) : null;
    if (state && message.selectionToken === state.selectionToken) {
      state.selectionToken = null;
      updateState(tabId, { active: false, status: 'Cancelled', progress: 'Selection cancelled.' });
    }
    return false;
  }
  if (message?.type === 'popup:stop') {
    handleStop().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'popup:retry') {
    handleRetry().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'translate:start') {
    handleTranslateStart(message).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'translate:stop') {
    handleTranslateStop(message.tabId);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'save:translation') {
    handleSaveTranslation(message).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'format:start') {
    handleFormatStart(message).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'format:stop') {
    handleFormatStop(message.tabId);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ── popup start ────────────────────────────────────────────────

async function handlePopupStart(message = {}) {
  const tab = await getActiveTab();
  const state = getState(tab.id);
  if (state.active || state.captureInFlight || state.status === 'Selecting') {
    throw new Error('A capture is already active for this tab.');
  }
  await ensureContentScript(tab.id);
  state.operationPrompts = message.prompts
    ? normalizeCapturePrompts(message.prompts)
    : await snapshotCapturePrompts();
  state.selectionToken = createSelectionToken();
  updateState(tab.id, { active: true, status: 'Selecting', progress: 'Drag a rectangle.' });
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'selection:start',
      lastRegion: state.lastRegion || undefined,
      selectionToken: state.selectionToken
    });
  } catch (error) {
    state.selectionToken = null;
    updateState(tab.id, {
      active: false,
      status: 'Error',
      error: error.message,
      progress: 'Failed.'
    });
    throw error;
  }
  return { ok: true };
}

async function handleReuseRegion() {
  const tab = await getActiveTab();
  const state = getState(tab.id);
  if (state.active || state.captureInFlight || state.status === 'Selecting') {
    throw new Error('A capture is already active for this tab.');
  }
  const region = state.lastRegion;
  if (!region) throw new Error('No saved region. Select a region first.');
  if (tab.windowId == null || tab.windowId < 0) throw new Error('Invalid windowId.');
  await ensureContentScript(tab.id);
  state.operationPrompts = await snapshotCapturePrompts();
  // Get actual viewport dimensions from the content script
  const vp = await chrome.tabs.sendMessage(tab.id, { type: 'get-viewport' });
  const fullRegion = {
    ...region,
    viewportWidth: vp?.width || 1920,
    viewportHeight: vp?.height || 1080,
    devicePixelRatio: vp?.dpr || 1
  };
  // Run capture directly — no overlay needed
  runCaptureLoop(tab, fullRegion)
    .catch((error) => handleCaptureLoopFailure(tab.id, error, 'Reuse capture failed:'));
  return { ok: true };
}

async function handleCaptureLoopFailure(tabId, error, logPrefix) {
  console.error(logPrefix, error);
  const state = getState(tabId);
  if (state.fragments?.length > 0) {
    try {
      state.partialReason = 'error';
      state.partialError = error.message || 'Capture failed.';
      updateState(tabId, { error: state.partialError });
      await finalizePostCapture(tabId, mergeFragments(state.fragments), state.fragments);
      return;
    } catch (finalizeError) {
      error = finalizeError;
    }
  }
  updateState(tabId, {
    active: false,
    status: 'Error',
    error: error.message,
    progress: 'Failed.'
  });
}

async function handleStop() {
  const tab = await getActiveTab();
  const state = getState(tab.id);
  state.stopRequested = true;
  state.partialReason = 'stopped';
  if (state.status === 'Selecting') {
    updateState(tab.id, {
      active: false,
      status: 'Cancelled',
      progress: 'Selection cancelled.'
    });
    await chrome.tabs.sendMessage(tab.id, { type: 'selection:cancel' }).catch(() => {});
    return { ok: true };
  }
  // Abort in-flight OCR AND translation so Stop responds immediately
  captureControllers.get(tab.id)?.abort();
  handleTranslateStop(tab.id);
  handleFormatStop(tab.id);
  // If in error state
  // If in error state (waiting for retry), finalize collected fragments now
  if (state.status === 'Error' && state.fragments?.length > 0) {
    await finalizePostCapture(tab.id, mergeFragments(state.fragments), state.fragments);
  } else {
    updateState(tab.id, { progress: 'Stopping...' });
  }
  return { ok: true };
}

async function handleRetry() {
  const tab = await getActiveTab();
  const state = getState(tab.id);

  if (state.retryStage === 'dedup') {
    const pendingText = state.pendingText;
    updateState(tab.id, { active: true, status: 'Deduplicating', progress: 'Retrying dedup...', error: '' });
    await finalizePostCapture(tab.id, pendingText, state.fragments || []);
    return { ok: true };
  }

  const rs = state.retryState || await loadRetryState(tab.id);
  if (!rs) throw new Error('No retry state saved.');
  state.retryState = null;
  chrome.storage.local.remove(`retryState:${tab.id}`).catch(() => {});
  if (rs.stage === 'dedup') {
    state.operationPrompts = normalizeCapturePrompts(rs.promptSnapshot);
    updateState(tab.id, { active: true, status: 'Deduplicating', progress: 'Retrying dedup...', error: '' });
    await finalizePostCapture(tab.id, rs.mergedText || mergeFragments(rs.fragments || []), rs.fragments || []);
    return { ok: true };
  }
  updateState(tab.id, { active: true, status: 'Capturing', progress: 'Retrying...', error: '' });
  await resumeCaptureLoop(rs);
  return { ok: true };
}

// ── manual translation (delegated to background so it survives popup close) ─

const translateControllers = new Map();
const formatControllers = new Map();
const captureControllers = new Map();
let keepAliveIntervalId = null;

function startKeepAlive() {
  if (keepAliveIntervalId) return;
  keepAliveIntervalId = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20_000);
}

function stopKeepAlive() {
  if (!keepAliveIntervalId) return;
  clearInterval(keepAliveIntervalId);
  keepAliveIntervalId = null;
}

async function handleTranslateStart(msg) {
  const { tabId, text, language, host, port } = msg;
  if (!tabId || !text) return { ok: false, error: 'Missing tabId or text' };
  const promptWasProvided = Object.prototype.hasOwnProperty.call(msg, 'prompt');
  let promptSnapshot = promptWasProvided ? normalizeCustomPrompt(msg.prompt) : undefined;
  if (!promptWasProvided) {
    const key = `translatePrompt:${language}`;
    const stored = await chrome.storage.local.get(key);
    promptSnapshot = normalizeCustomPrompt(stored[key]);
  }

  // Abort any in-flight translation for this tab
  handleTranslateStop(tabId);

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId = null;

  try {
    translateControllers.set(tabId, controller);
    startKeepAlive();
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, BACKEND_TIMEOUT_MS);

    // Persist state so popup reopen shows "Stop" button.
    // Clear any stale result so init() doesn't mistake an old result
    // for a just-completed translation.
    await chrome.storage.local.set({
      [`tl2Translating:${tabId}`]: true,
      [`tl2Status:${tabId}`]: `Translating to ${language}...`
    });
    await chrome.storage.local.remove(`tl2Result:${tabId}`);
    chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: true }).catch(() => {});

    try {
      const customPrompt = renderTranslationPrompt(promptSnapshot, language);
      // "Original" with no custom prompt → pass through unchanged
      if (language === 'original' && !promptSnapshot) {
        const translated = text;
        await chrome.storage.local.set({ [`tl2Result:${tabId}`]: translated });
        chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: translated }).catch(() => {});
        if (translated) autoCopyIfEnabled(translated);
        if (translated) autoSaveIfEnabled(translated);
        if (translated) autoFormatIfEnabled(tabId, translated, host, port);
        return { ok: true };
      }
      const url = buildBackendEndpoint(host || DEFAULT_HOST, port || DEFAULT_PORT, `/translate?_=${Date.now()}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: await getBackendHeaders('application/json'),
        body: JSON.stringify({ text, language, prompt: customPrompt || undefined }),
        signal: controller.signal
      });
      const payload = await readJsonObject(response, 'Translation backend');
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const translated = requireTextPayload(payload, 'Translation backend');
      await chrome.storage.local.set({ [`tl2Result:${tabId}`]: translated });
      chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: translated }).catch(() => {});
      // Auto-copy / auto-save translated text
      if (translated) autoCopyIfEnabled(translated);
      if (translated) autoSaveIfEnabled(translated);
      // Auto-format: trigger from background so it survives popup close
      if (translated) autoFormatIfEnabled(tabId, translated, host, port);
    } catch (e) {
      if (e.name === 'AbortError') {
        const message = timedOut ? 'Translation timed out.' : 'Translation stopped.';
        await chrome.storage.local.set({ [`tl2Status:${tabId}`]: message });
        if (timedOut) chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: '', error: message }).catch(() => {});
        return { ok: !timedOut, error: timedOut ? message : undefined };
      }
      const errorMessage = e.message || 'Translation failed.';
      await chrome.storage.local.set({ [`tl2Status:${tabId}`]: errorMessage });
      chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: '', error: errorMessage }).catch(() => {});
      return { ok: false, error: errorMessage };
    }
  } finally {
    clearTimeout(timeoutId);
    if (controller && translateControllers.get(tabId) === controller) {
      translateControllers.delete(tabId);
      await chrome.storage.local.remove(`tl2Translating:${tabId}`).catch((error) => {
        console.error('Failed to clear translation state:', error);
      });
      chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: false }).catch(() => {});
    }
    if (captureControllers.size === 0 && translateControllers.size === 0 && formatControllers.size === 0) stopKeepAlive();
  }

  return { ok: true };
}

function handleTranslateStop(tabId) {
  const controller = translateControllers.get(tabId);
  if (controller) {
    controller.abort();
    translateControllers.delete(tabId);
    chrome.storage.local.remove(`tl2Translating:${tabId}`);
  }
}

async function handleSaveTranslation(msg) {
  const { text, path } = msg;
  if (!text || !path) return { ok: false, error: 'Missing text or path' };
  let normalizedPath;
  try {
    normalizedPath = normalizeSavePath(path);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const url = await getFileBridgeEndpoint('/save');
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: await getFileBridgeHeaders(),
    body: JSON.stringify({ text, path: normalizedPath })
  });
  let payload;
  try {
    payload = await readJsonObject(response, 'File bridge');
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (!response.ok || payload.success !== true) {
    return { ok: false, error: payload.error || payload.detail || `HTTP ${response.status}` };
  }
  return { ok: true, path: normalizedPath };
}

// ── manual format (delegated to background so it survives popup close) ─

async function handleFormatStart(msg) {
  const { tabId, text, host, port } = msg;
  if (!tabId || !text) return { ok: false, error: 'Missing tabId or text' };
  const promptWasProvided = Object.prototype.hasOwnProperty.call(msg, 'prompt');
  let prompt = promptWasProvided ? normalizeCustomPrompt(msg.prompt) : undefined;
  if (!promptWasProvided) {
    const stored = await chrome.storage.local.get('formatPrompt');
    prompt = normalizeCustomPrompt(stored.formatPrompt);
  }

  // Abort any in-flight formatting for this tab
  handleFormatStop(tabId);

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId = null;

  try {
    formatControllers.set(tabId, controller);
    startKeepAlive();
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, BACKEND_TIMEOUT_MS);

    // Persist state so popup reopen shows "Stop" button.
    await chrome.storage.local.set({
      [`fmtFormatting:${tabId}`]: true,
      [`fmtStatus:${tabId}`]: 'Formatting...'
    });
    await chrome.storage.local.remove(`fmtResult:${tabId}`);
    chrome.runtime.sendMessage({ type: 'fmt:formatting', tabId, value: true }).catch(() => {});

    try {
      const url = buildBackendEndpoint(host || DEFAULT_HOST, port || DEFAULT_PORT, `/format?_=${Date.now()}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: await getBackendHeaders('application/json'),
        body: JSON.stringify({ text, prompt }),
        signal: controller.signal
      });
      const payload = await readJsonObject(response, 'Format backend');
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const formatted = requireTextPayload(payload, 'Format backend');
      await chrome.storage.local.set({ [`fmtResult:${tabId}`]: formatted });
      chrome.runtime.sendMessage({ type: 'format:update', tabId, text: formatted }).catch(() => {});
      // Auto-copy / auto-save formatted text (background-side, survives popup close)
      if (formatted) fmtAutoCopyIfEnabled(formatted);
      if (formatted) fmtAutoSaveIfEnabled(formatted);
    } catch (e) {
      if (e.name === 'AbortError') {
        const message = timedOut ? 'Formatting timed out.' : 'Formatting stopped.';
        await chrome.storage.local.set({ [`fmtStatus:${tabId}`]: message });
        if (timedOut) chrome.runtime.sendMessage({ type: 'format:update', tabId, text: '', error: message }).catch(() => {});
        return { ok: !timedOut, error: timedOut ? message : undefined };
      }
      const errorMessage = e.message || 'Formatting failed.';
      await chrome.storage.local.set({ [`fmtStatus:${tabId}`]: errorMessage });
      chrome.runtime.sendMessage({ type: 'format:update', tabId, text: '', error: errorMessage }).catch(() => {});
      return { ok: false, error: errorMessage };
    }
  } finally {
    clearTimeout(timeoutId);
    if (formatControllers.get(tabId) === controller) {
      formatControllers.delete(tabId);
      await chrome.storage.local.remove(`fmtFormatting:${tabId}`).catch((error) => {
        console.error('Failed to clear format state:', error);
      });
      chrome.runtime.sendMessage({ type: 'fmt:formatting', tabId, value: false }).catch(() => {});
    }
    if (captureControllers.size === 0 && translateControllers.size === 0 && formatControllers.size === 0) stopKeepAlive();
  }

  return { ok: true };
}

function handleFormatStop(tabId) {
  const controller = formatControllers.get(tabId);
  if (controller) {
    controller.abort();
    formatControllers.delete(tabId);
    chrome.storage.local.remove(`fmtFormatting:${tabId}`);
  }
}

async function autoFormatIfEnabled(tabId, text, host, port, source = 'translation') {
  const [settings, prompt] = await Promise.all([
    chrome.storage.sync.get({ fmtAutoFormat: false, fmtSourceVal: 'translation' }),
    chrome.storage.local.get('formatPrompt')
  ]);
  if (!settings.fmtAutoFormat) return;
  if (settings.fmtSourceVal !== source) return;
  // Fall back to sync storage if caller didn't provide host/port (e.g. auto-translate path)
  if (!host || port === undefined) {
    const backend = await chrome.storage.sync.get({ backendHost: 'localhost', backendPort: 8765 });
    host = backend.backendHost;
    port = backend.backendPort;
  }
  handleFormatStart({ tabId, text, prompt: prompt.formatPrompt, host, port })
    .catch(() => {});
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  return tab;
}

// ── ensure content script is loaded ────────────────────────────

async function ensureContentScript(tabId) {
  // Try injecting — content.js has an IIFE guard so it's safe to call
  // even if already loaded by the manifest's content_scripts.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['overlay.css'] });
  } catch (e) {
    // Script already loaded or cannot inject — either way, try messaging next.
  }
}

// ── capture loop ───────────────────────────────────────────────

async function runCaptureLoop(tab, region) {
  if (!tab?.id) throw new Error('Missing tab id.');
  const tabId = tab.id;
  const promptSnapshot = getState(tabId).operationPrompts || await snapshotCapturePrompts();
  const normalizedRegion = normalizeRegion(region);
  if (normalizedRegion.width < 2 || normalizedRegion.height < 2) {
    throw new Error('Selected region is too small.');
  }
  return executeCaptureLoop({
    tabId,
    region: normalizedRegion,
    fragments: [],
    lastScrollY: -1,
    resetBeforeStart: true,
    refreshAutoscroll: false,
    captureUrl: tab.url || null,
    promptSnapshot
  });
}

async function resumeCaptureLoop(rs) {
  const tabId = rs?.tabId ?? rs?.tab?.id;
  if (!tabId) throw new Error('Missing tab id.');
  return executeCaptureLoop({
    tabId,
    region: normalizeRegion(rs.region),
    fragments: rs.fragments || [],
    lastScrollY: rs.lastScrollY ?? -1,
    resetBeforeStart: false,
    refreshAutoscroll: true,
    captureUrl: rs.captureUrl || null,
    promptSnapshot: rs.promptSnapshot || getState(tabId).operationPrompts || await snapshotCapturePrompts()
  });
}

async function executeCaptureLoop({
  tabId,
  region,
  fragments,
  lastScrollY,
  resetBeforeStart,
  refreshAutoscroll,
  captureUrl,
  promptSnapshot
}) {
  const state = getState(tabId);

  // Prevent concurrent captures on the same tab
  if (state.captureInFlight) throw new Error('Capture already in progress for this tab.');
  state.captureInFlight = true;

  const controller = new AbortController();
  captureControllers.set(tabId, controller);
  startKeepAlive();

  let scrollLocked = false;
  let fixedAutoscroll;
  try {
    if (resetBeforeStart) {
      resetState(tabId);
      state.operationPrompts = normalizeCapturePrompts(promptSnapshot);
      updateState(tabId, { active: true, status: 'Capturing', progress: 'Starting capture loop.' });
    } else if (!state.operationPrompts) {
      state.operationPrompts = normalizeCapturePrompts(promptSnapshot);
    }

    const initialTab = await getLiveTargetTab(tabId);
    state.captureUrl = captureUrl || initialTab?.url || state.captureUrl || null;

    let scrollY = lastScrollY;
    let atBottom = false;

    capturePages: while (true) {
      if (state.stopRequested || state.targetRemoved) break;
      if (fixedAutoscroll === undefined || refreshAutoscroll) {
        const settings = await chrome.storage.sync.get({ ocrAutoscroll: true });
        fixedAutoscroll = settings.ocrAutoscroll;
      }
      const ocrAutoscroll = fixedAutoscroll;
      const { captureIntervalMs } = await chrome.storage.sync.get({
        captureIntervalMs: DEFAULT_CAPTURE_INTERVAL_MS
      });
      if (!ocrAutoscroll && fragments.length > 0) {
        updateState(tabId, { progress: 'Single capture complete (autoscroll off).' });
        break;
      }
      const pageNumber = fragments.length + 1;
      updateState(tabId, {
        currentPage: pageNumber,
        fragmentsCollected: fragments.length,
        progress: `Capturing page ${pageNumber}...`
      });

      if (!scrollLocked) {
        const lockResult = await sendMessageToActiveTarget(tabId, state, controller.signal, {
          type: 'page:lock-scroll'
        }, `Capturing page ${pageNumber}...`);
        if (lockResult.status !== 'sent') break;
        scrollLocked = true;
      }

      const frame = await captureTargetFrame(tabId, state, controller.signal, `Capturing page ${pageNumber}...`);
      if (frame.status !== 'accepted') break;
      const dataUrl = frame.dataUrl;
      const croppedBlob = await cropVisibleCapture(dataUrl, region);

      updateState(tabId, { progress: `Sending page ${pageNumber} to OCR...` });
      state.retryState = {
        stage: 'ocr',
        tabId,
        region,
        fragments: [...fragments],
        lastScrollY: scrollY,
        promptSnapshot: state.operationPrompts,
        ...(state.captureUrl ? { captureUrl: state.captureUrl } : {})
      };
      await chrome.storage.local.set({ [`retryState:${tabId}`]: state.retryState });
      for (let attempt = 1; ; attempt++) {
        const target = await waitForTargetActive(
          tabId,
          state,
          controller.signal,
          attempt === 1
            ? `Sending page ${pageNumber} to OCR...`
            : `Retrying page ${pageNumber} (attempt ${attempt})...`
        );
        if (target.status !== 'active') {
          await clearRetryState(tabId, state);
          break capturePages;
        }
        try {
          const text = await postImageForOcr(
            croppedBlob,
            pageNumber,
            controller.signal,
            state.operationPrompts?.ocr
          );
          fragments.push(text);
          await clearRetryState(tabId, state);
          break;
        } catch (e) {
          if (state.stopRequested || state.targetRemoved || controller.signal.aborted) {
            await clearRetryState(tabId, state);
            break capturePages;
          }
          updateState(tabId, { progress: `Retrying page ${pageNumber} (attempt ${attempt + 1})...` });
          await sleep(2000);
        }
      }

      updateState(tabId, {
        fragments,
        fragmentsCollected: fragments.length,
        progress: `Collected ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}.`
      });

      await sleep(AFTER_SEND_DELAY_MS);

      if (!ocrAutoscroll) break;

      if (fragments.length >= MAX_CAPTURE_PAGES) {
        updateState(tabId, { progress: `Reached page limit (${MAX_CAPTURE_PAGES}). Stopping.` });
        break;
      }

      if (atBottom) {
        await sleep(500);
        const recheckResult = await sendMessageToActiveTarget(tabId, state, controller.signal, {
          type: 'page:scroll-down',
          overlapPx: OVERLAP_PX
        }, `Rechecking page ${pageNumber}...`);
        if (recheckResult.status !== 'sent') break;
        const recheck = requireScrollResponse(recheckResult.response);
        if (recheck?.changed) {
          atBottom = false;
          scrollY = recheck.scrollY;
          await sleep(captureIntervalMs);
          continue;
        }
        break;
      }

      const sentScroll = await sendMessageToActiveTarget(tabId, state, controller.signal, {
        type: 'page:scroll-down',
        overlapPx: OVERLAP_PX
      }, `Scrolling after page ${pageNumber}...`);
      if (sentScroll.status !== 'sent') break;
      const scrollResult = requireScrollResponse(sentScroll.response);

      if (scrollResult?.atBottom) {
        if (!scrollResult.changed && fragments.length > 0) break;
        atBottom = true;
        await sleep(captureIntervalMs);
        continue;
      }
      scrollY = scrollResult.scrollY;
      await sleep(captureIntervalMs);
    }

    state.collectionComplete = true;
    const mergedText = mergeFragments(fragments);
    if (state.navigationChanged) state.partialReason = 'navigation';
    else if (state.stopRequested) state.partialReason = 'stopped';
    else if (state.targetRemoved) state.partialReason = 'tab_closed';
    if (state.partialReason) {
      // An interrupted capture preserves every fragment collected so far but
      // must not present or automate the result as a complete capture.
      await finalizeCapture(tabId, mergedText, fragments);
    } else {
      updateState(tabId, { progress: 'Deduplicating merged text...', fragments });
      await finalizePostCapture(tabId, mergedText, fragments);
    }
  } finally {
    state.captureInFlight = false;
    captureControllers.delete(tabId);
    if (captureControllers.size === 0 && translateControllers.size === 0 && formatControllers.size === 0) stopKeepAlive();
    // Unlock page scroll
    if (scrollLocked) chrome.tabs.sendMessage(tabId, { type: 'page:unlock-scroll' }).catch(() => {});
  }
}

async function getLiveTargetTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.id === tabId ? tab : null;
  } catch {
    return null;
  }
}

function markTargetNavigated(tabId, state = getState(tabId)) {
  if (state.navigationChanged) return;
  state.navigationChanged = true;
  state.partialReason = 'navigation';
  captureControllers.get(tabId)?.abort();
  updateState(tabId, {
    progress: 'Capture stopped because the page navigated. Preserving collected fragments.'
  });
  notifyTargetTabChange();
}

function targetDocumentChanged(tabId, state, tab) {
  if (!state.captureUrl || !tab?.url || tab.url === state.captureUrl) return false;
  markTargetNavigated(tabId, state);
  return true;
}

function waitForTargetTabChange(revision, signal) {
  if (targetTabChangeRevision !== revision || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      targetTabWaiters.delete(finish);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    targetTabWaiters.add(finish);
    signal?.addEventListener('abort', finish, { once: true });
    if (targetTabChangeRevision !== revision || signal?.aborted) finish();
  });
}

async function waitForTargetActive(tabId, state, signal, resumeProgress) {
  let paused = false;
  while (true) {
    if (state.targetRemoved) return { status: 'removed' };
    if (state.navigationChanged) return { status: 'navigated' };
    if (state.stopRequested || signal?.aborted) return { status: 'stopped' };

    const revision = targetTabChangeRevision;
    const tab = await getLiveTargetTab(tabId);
    if (!tab) {
      state.targetRemoved = true;
      return { status: 'removed' };
    }
    if (targetDocumentChanged(tabId, state, tab)) return { status: 'navigated' };
    if (tab.active && tab.windowId != null && tab.windowId >= 0) {
      if (paused) {
        updateState(tabId, {
          active: true,
          status: 'Capturing',
          progress: resumeProgress
        });
      }
      return {
        status: 'active',
        tab,
        windowId: tab.windowId,
        generation: windowActivationGenerations.get(tab.windowId) || 0
      };
    }

    paused = true;
    updateState(tabId, {
      active: true,
      status: 'Paused',
      progress: 'Capture paused — return to the capture tab to continue.'
    });
    await waitForTargetTabChange(revision, signal);
  }
}

function isSameActiveTarget(snapshot, tab) {
  return Boolean(
    tab
    && tab.active
    && tab.id === snapshot.tab.id
    && tab.windowId === snapshot.windowId
    && (windowActivationGenerations.get(snapshot.windowId) || 0) === snapshot.generation
  );
}

async function captureTargetFrame(tabId, state, signal, resumeProgress) {
  while (true) {
    const snapshot = await waitForTargetActive(tabId, state, signal, resumeProgress);
    if (snapshot.status !== 'active') return snapshot;

    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(snapshot.windowId, { format: 'png' });
    } catch (error) {
      if (state.targetRemoved) return { status: 'removed' };
      if (state.stopRequested || signal?.aborted) return { status: 'stopped' };
      const liveAfterError = await getLiveTargetTab(tabId);
      if (isSameActiveTarget(snapshot, liveAfterError)) throw error;
      if (!liveAfterError) {
        state.targetRemoved = true;
        return { status: 'removed' };
      }
      continue;
    }

    if (state.targetRemoved) return { status: 'removed' };
    if (state.navigationChanged) return { status: 'navigated' };
    if (state.stopRequested || signal?.aborted) return { status: 'stopped' };
    const liveAfterCapture = await getLiveTargetTab(tabId);
    if (targetDocumentChanged(tabId, state, liveAfterCapture)) return { status: 'navigated' };
    if (isSameActiveTarget(snapshot, liveAfterCapture)) {
      return { status: 'accepted', dataUrl, windowId: snapshot.windowId };
    }
    if (!liveAfterCapture) {
      state.targetRemoved = true;
      return { status: 'removed' };
    }
  }
}

async function sendMessageToActiveTarget(tabId, state, signal, message, resumeProgress) {
  while (true) {
    const snapshot = await waitForTargetActive(tabId, state, signal, resumeProgress);
    if (snapshot.status !== 'active') return snapshot;
    const liveBeforeSend = await getLiveTargetTab(tabId);
    if (targetDocumentChanged(tabId, state, liveBeforeSend)) return { status: 'navigated' };
    if (!isSameActiveTarget(snapshot, liveBeforeSend)) {
      if (!liveBeforeSend) {
        state.targetRemoved = true;
        return { status: 'removed' };
      }
      continue;
    }
    try {
      return {
        status: 'sent',
        response: await chrome.tabs.sendMessage(tabId, message),
        windowId: snapshot.windowId
      };
    } catch (error) {
      const liveAfterError = await getLiveTargetTab(tabId);
      if (targetDocumentChanged(tabId, state, liveAfterError)) return { status: 'navigated' };
      if (!liveAfterError) {
        state.targetRemoved = true;
        return { status: 'removed' };
      }
      throw error;
    }
  }
}

async function finalizePostCapture(tabId, mergedText, fragments) {
  const state = getState(tabId);
  // Save pre-dedup text for debugging
  chrome.storage.local.set({ [`preDedup:${tabId}`]: mergedText }).catch(() => {});
  const signal = captureControllers.get(tabId)?.signal;
  state.retryStage = 'dedup';
  state.pendingText = mergedText;
  state.retryState = {
    stage: 'dedup',
    tabId,
    mergedText,
    fragments: [...fragments],
    promptSnapshot: state.operationPrompts,
    ...(state.captureUrl ? { captureUrl: state.captureUrl } : {})
  };
  await chrome.storage.local.set({ [`retryState:${tabId}`]: state.retryState });
  let finalText;
  for (let attempt = 1; ; attempt++) {
    try {
      finalText = await postTextForDedup(
        mergedText,
        signal,
        state.operationPrompts?.dedup
      );
      // Save post-dedup text for debugging
      chrome.storage.local.set({ [`postDedup:${tabId}`]: finalText }).catch(() => {});
      await clearRetryState(tabId, state);
      break;
    } catch (e) {
      if (state.stopRequested) {
        await clearRetryState(tabId, state);
        finalText = null;
        break;
      }
      updateState(tabId, { progress: `Retrying dedup (${attempt + 1})...` });
      await sleep(2000);
    }
  }

  if (!finalText) {
    // Stop requested during retry — finalize raw text
    await finalizeCapture(tabId, mergedText, fragments);
    return;
  }

  await finalizeCapture(tabId, finalText, fragments);
}

async function finalizeCapture(tabId, finalText, fragments) {
  const state = getState(tabId);
  state.retryStage = null;
  state.pendingText = '';

  const isPartial = Boolean(state.partialReason);
  let progress = 'Finished.';
  if (state.partialReason === 'navigation') {
    progress = `Partial capture: page navigation stopped capture after ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'stopped') {
    progress = `Partial capture stopped after ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'tab_closed') {
    progress = `Partial capture: the tab closed after ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'error') {
    progress = `Partial capture ended after an error; saved ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}.`;
  }
  const finalStatus = isPartial ? 'Partial' : 'Done';

  updateState(tabId, {
    active: false,
    status: finalStatus,
    currentPage: fragments.length,
    fragmentsCollected: fragments.length,
    progress,
    fragments,
    mergedText: finalText
  });
  try {
    await chrome.storage.local.set({
      [`lastResult:${tabId}`]: finalText,
      [`lastStatus:${tabId}`]: finalStatus
    });
  } catch (error) {
    updateState(tabId, {
      status: 'Error',
      error: `Failed to persist capture result: ${error.message}`,
      progress: 'Capture finished, but its result could not be saved.'
    });
    throw error;
  }

  // Run post-capture automation only for a normally completed capture.
  if (!isPartial) {
    await autoFormatIfEnabled(tabId, finalText, undefined, undefined, 'ocr');
    await autoTranslateIfEnabled(tabId, finalText);
  }

  return finalText;
}

async function autoTranslateIfEnabled(tabId, originalText) {
  const { ocrAutoTranslate } = await chrome.storage.sync.get({
    ocrAutoTranslate: false
  });
  if (!ocrAutoTranslate) return;

  // Read language from the global Translation tab setting
  const tl2Lang = await chrome.storage.local.get('tl2Language');
  const language = tl2Lang.tl2Language || 'original';
  const key = `translatePrompt:${language}`;
  const stored = await chrome.storage.local.get(key);
  const promptSnapshot = normalizeCustomPrompt(stored[key]);
  // "Original" with no custom prompt → skip (nothing to do)
  if (language === 'original' && !promptSnapshot) return;

  // Abort any in-flight translation for this tab
  handleTranslateStop(tabId);

  let controller = null;
  let timedOut = false;
  let timeoutId = null;

  try {
    controller = new AbortController();
    translateControllers.set(tabId, controller);
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, BACKEND_TIMEOUT_MS);

    updateState(tabId, { tl2Translating: true });
    await chrome.storage.local.set({
      [`tl2Translating:${tabId}`]: true,
      [`tl2Status:${tabId}`]: `Translating to ${language}...`
    });
    await chrome.storage.local.remove(`tl2Result:${tabId}`);
    chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: true }).catch(() => {});
    const customPrompt = renderTranslationPrompt(promptSnapshot, language);
    const url = await getBackendEndpoint('/translate');
    const response = await fetch(url + '?_=' + Date.now(), {
      method: 'POST',
      headers: await getBackendHeaders('application/json'),
      body: JSON.stringify({ text: originalText, language, prompt: customPrompt || undefined }),
      signal: controller.signal
    });
    const payload = await readJsonObject(response, 'Translation backend');
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    const translated = requireTextPayload(payload, 'Translation backend');
    updateState(tabId, { tl2Translating: false });
    await chrome.storage.local.set({ [`tl2Result:${tabId}`]: translated });
    chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: translated }).catch(() => {});
    // Auto-copy / auto-save translated text
    if (translated) autoCopyIfEnabled(translated);
    if (translated) autoSaveIfEnabled(translated);
    // Auto-format if enabled
    if (translated) autoFormatIfEnabled(tabId, translated);
  } catch (e) {
    if (e.name === 'AbortError' && !timedOut) return; // User clicked Stop — silent
    console.error('Auto-translate failed:', e);
    const errorMessage = timedOut ? 'Translation timed out.' : (e.message || 'Translation failed.');
    await chrome.storage.local.set({ [`tl2Status:${tabId}`]: errorMessage });
    updateState(tabId, { tl2Translating: false });
    await chrome.storage.local.remove(`tl2Translating:${tabId}`).catch((error) => {
      console.error('Failed to clear auto-translation state:', error);
    });
    chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: '', error: errorMessage }).catch(() => {});
  } finally {
    clearTimeout(timeoutId);
    if (controller && translateControllers.get(tabId) === controller) {
      translateControllers.delete(tabId);
      await chrome.storage.local.remove(`tl2Translating:${tabId}`).catch((error) => {
        console.error('Failed to clear auto-translation state:', error);
      });
      chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: false }).catch(() => {});
    }
  }
}

function renderTranslationPrompt(template, language) {
  if (!template) return '';
  return String(template).replace(/\{language\}/g, language);
}

// ── crop ───────────────────────────────────────────────────────

async function cropVisibleCapture(dataUrl, region) {
  const imageBitmap = await createImageBitmap(await dataUrlToBlob(dataUrl));
  try {
    const scaleX = imageBitmap.width / region.viewportWidth;
    const scaleY = imageBitmap.height / region.viewportHeight;
    const cropX = Math.max(0, Math.round(region.x * scaleX));
    const cropY = Math.max(0, Math.round(region.y * scaleY));
    const cropWidth = Math.min(imageBitmap.width - cropX, Math.round(region.width * scaleX));
    const cropHeight = Math.min(imageBitmap.height - cropY, Math.round(region.height * scaleY));

    if (cropWidth <= 0 || cropHeight <= 0) {
      throw new Error('Crop region outside viewport.');
    }

    const canvas = new OffscreenCanvas(cropWidth, cropHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create crop canvas context.');
    ctx.drawImage(imageBitmap, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    return canvas.convertToBlob({ type: 'image/png' });
  } finally {
    imageBitmap.close();
  }
}

// ── OCR call ───────────────────────────────────────────────────

async function postImageForOcr(blob, pageNumber, signal, customPrompt) {
  if (arguments.length < 4) {
    const stored = await chrome.storage.local.get('ocrPrompt');
    customPrompt = normalizeCustomPrompt(stored.ocrPrompt);
  }
  const formData = new FormData();
  formData.append('image', blob, `page-${String(pageNumber).padStart(4, '0')}.png`);
  if (customPrompt) formData.append('prompt', customPrompt);

  const url = await getBackendEndpoint('/ocr');
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: await getBackendHeaders(),
    body: formData
  }, signal);

  if (!response.ok) {
    throw new Error(`OCR HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const payload = await readJsonObject(response, 'OCR backend');
    return requireTextPayload(payload, 'OCR backend').trim();
  }
  return (await response.text()).trim();
}

async function postTextForDedup(text, signal, customPrompt) {
  if (arguments.length < 3) {
    const stored = await chrome.storage.local.get('dedupPrompt');
    customPrompt = normalizeCustomPrompt(stored.dedupPrompt);
  }
  const url = await getBackendEndpoint('/dedup');

  const body = { text };
  if (customPrompt) body.prompt = customPrompt;

  const response = await fetchWithTimeout(url + '?_=' + Date.now(), {
    method: 'POST',
    headers: await getBackendHeaders('application/json'),
    body: JSON.stringify(body)
  }, signal);

  if (!response.ok) {
    throw new Error(`Dedup HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  const payload = await readJsonObject(response, 'Dedup backend');
  return requireTextPayload(payload, 'Dedup backend').trim();
}

// ── merge logic ────────────────────────────────────────────────

function mergeFragments(fragments) {
  return fragments.reduce((merged, f) => {
    const clean = normalizeText(f);
    return merged ? mergeTwoFragments(merged, clean) : clean;
  }, '');
}

function mergeTwoFragments(prev, next) {
  if (!next) return prev;
  const pLines = splitLines(prev);
  const nLines = splitLines(next);
  const overlap = findLineOverlap(pLines, nLines);
  return pLines.concat(nLines.slice(overlap)).join('\n');
}

function findLineOverlap(pLines, nLines) {
  const max = Math.min(pLines.length, nLines.length);
  for (let len = max; len > 0; len--) {
    const suffix = pLines.slice(-len).map(normalizeLine);
    const prefix = nLines.slice(0, len).map(normalizeLine);
    const nonblankMatches = suffix.filter((line) => line !== '').length;
    if (nonblankMatches >= 2 && suffix.every((line, i) => line === prefix[i])) return len;
  }
  return 0;
}

function normalizeText(t) {
  const normalized = String(t || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  if (!normalized.trim()) return '';
  const lines = normalized.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

function splitLines(t) {
  const normalized = normalizeText(t);
  return normalized ? normalized.split('\n') : [];
}

function normalizeLine(l) {
  return l.replace(/\s+/g, ' ').trim();
}

// ── helpers ────────────────────────────────────────────────────

function normalizeRegion(r) {
  return {
    x: Math.max(0, +r.x || 0),
    y: Math.max(0, +r.y || 0),
    width: Math.max(0, +r.width || 0),
    height: Math.max(0, +r.height || 0),
    viewportWidth: Math.max(1, +r.viewportWidth || 1),
    viewportHeight: Math.max(1, +r.viewportHeight || 1)
  };
}

function requireScrollResponse(response) {
  if (response?.error) throw new Error(`Page scroll failed: ${response.error}`);
  if (!response || typeof response.changed !== 'boolean' || !Number.isFinite(Number(response.scrollY))) {
    throw new Error('Page scroll returned an invalid response.');
  }
  return response;
}

function isValidRegion(r) {
  return r && Number.isFinite(+r.x) && Number.isFinite(+r.y)
    && Number.isFinite(+r.width) && Number.isFinite(+r.height)
    && Number.isFinite(+r.viewportWidth) && Number.isFinite(+r.viewportHeight)
    && +r.width > 0 && +r.height > 0 && +r.viewportWidth > 0 && +r.viewportHeight > 0;
}

async function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then((r) => r.blob());
}

async function fetchWithTimeout(url, options = {}, externalSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  // Wire external signal (e.g. user Stop) to the internal controller
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
      clearTimeout(timeoutId);
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resetState(tabId) {
  Object.assign(getState(tabId), {
    active: false,
    status: 'Idle',
    currentPage: 0,
    fragmentsCollected: 0,
    progress: 'Ready',
    mergedText: '',
    fragments: [],
    error: '',
    lastRegion: savedLastRegion,
    stopRequested: false,
    retryState: null,
    retryStage: null,
    pendingText: '',
    targetRemoved: false,
    navigationChanged: false,
    captureUrl: null,
    collectionComplete: false,
    partialReason: '',
    partialError: '',
    operationPrompts: null,
    selectionToken: null
  });
  broadcastState(tabId);
  // Clear stale stored result/status so popup init() doesn't reload old capture
  chrome.storage.local.remove([
    `lastResult:${tabId}`,
    `lastStatus:${tabId}`,
    `retryState:${tabId}`,
    `tl2Result:${tabId}`,
    `tl2Status:${tabId}`,
    `fmtResult:${tabId}`,
    `fmtStatus:${tabId}`,
    `preDedup:${tabId}`,
    `postDedup:${tabId}`
  ]).catch(() => {});
}

async function copyToClipboard(text) {
  if (!text) return false;
  let hasDocument = false;
  if (typeof chrome.offscreen.hasDocument === 'function') {
    hasDocument = await chrome.offscreen.hasDocument();
  } else if (typeof chrome.runtime.getContexts === 'function' && typeof chrome.runtime.getURL === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')]
    });
    hasDocument = contexts.length > 0;
  }
  if (!hasDocument) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Clipboard access for TextKit results'
    });
  }
  const copyId = nextOffscreenCopyId++;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      finishOffscreenCopy(copyId, new Error('Clipboard copy timed out.'));
    }, 2000);
    pendingOffscreenCopies.set(copyId, { resolve, reject, timeoutId });
    chrome.runtime.sendMessage({ type: 'offscreen:copy', copyId, text }).catch((error) => {
      finishOffscreenCopy(copyId, error);
    });
  });
}

function handleOffscreenCopyResult(message) {
  const error = message.type === 'offscreen:copy-failed'
    ? new Error(message.error || 'Clipboard copy failed.')
    : null;
  finishOffscreenCopy(message.copyId, error);
}

function finishOffscreenCopy(copyId, error = null) {
  const pending = pendingOffscreenCopies.get(copyId);
  if (pending) {
    pendingOffscreenCopies.delete(copyId);
    clearTimeout(pending.timeoutId);
    if (error) pending.reject(error);
    else pending.resolve(true);
  }
  if (pendingOffscreenCopies.size === 0) {
    chrome.offscreen.closeDocument().catch(() => {});
  }
}

function updateState(tabId, partial) {
  Object.assign(getState(tabId), partial);
  broadcastState(tabId);
}

function broadcastState(tabId) {
  chrome.runtime.sendMessage({ type: 'state:update', tabId, state: getState(tabId) }).catch(() => {});
}

// ── Auto-copy / auto-save helpers (for auto-translate) ─────────

async function autoCopyIfEnabled(text) {
  const { tl2AutoCopy } = await chrome.storage.sync.get({ tl2AutoCopy: false });
  if (!tl2AutoCopy || !text) return;
  try {
    await copyToClipboard(text);
    chrome.notifications.create('auto-copy', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Copied',
      message: 'Translation copied to system clipboard.',
      priority: 0
    });
  } catch (e) {
    console.error('Auto-copy failed:', e);
    chrome.notifications.create('auto-copy-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Copy failed',
      message: e.message,
      priority: 1
    });
  }
}

async function autoSaveIfEnabled(text) {
  const { tl2AutoSave, tl2AutoSavePath } = await chrome.storage.sync.get({
    tl2AutoSave: false, tl2AutoSavePath: ''
  });
  if (!tl2AutoSave || !tl2AutoSavePath || !text) return;
  try {
    const result = await handleSaveTranslation({ text, path: tl2AutoSavePath });
    if (!result.ok) throw new Error(result.error || 'Save failed');
    chrome.notifications.create('auto-save', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Saved',
      message: `Translation saved to ${result.path || tl2AutoSavePath}.`,
      priority: 0
    });
  } catch (e) {
    console.error('Auto-save failed:', e);
    chrome.notifications.create('auto-save-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Save failed',
      message: e.message,
      priority: 1
    });
  }
}

// ── Auto-copy / auto-save helpers (for auto-format) ──────────

async function fmtAutoCopyIfEnabled(text) {
  const { fmtAutoCopy } = await chrome.storage.sync.get({ fmtAutoCopy: false });
  if (!fmtAutoCopy || !text) return;
  try {
    await copyToClipboard(text);
    chrome.notifications.create('fmt-auto-copy', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Copied',
      message: 'Formatted text copied to system clipboard.',
      priority: 0
    });
  } catch (e) {
    console.error('Auto-copy format failed:', e);
    chrome.notifications.create('fmt-auto-copy-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Copy failed',
      message: e.message,
      priority: 1
    });
  }
}

async function fmtAutoSaveIfEnabled(text) {
  const { fmtAutoSave, fmtSavePath } = await chrome.storage.sync.get({
    fmtAutoSave: false, fmtSavePath: ''
  });
  if (!fmtAutoSave || !fmtSavePath || !text) return;
  try {
    const result = await handleSaveTranslation({ text, path: fmtSavePath });
    if (!result.ok) throw new Error(result.error || 'Save failed');
    chrome.notifications.create('fmt-auto-save', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Saved',
      message: `Formatted text saved to ${result.path || fmtSavePath}.`,
      priority: 0
    });
  } catch (e) {
    console.error('Auto-save format failed:', e);
    chrome.notifications.create('fmt-auto-save-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Save failed',
      message: e.message,
      priority: 1
    });
  }
}

async function loadRetryState(tabId) {
  const key = `retryState:${tabId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

async function clearRetryState(tabId, state = getState(tabId)) {
  state.retryState = null;
  await chrome.storage.local.remove(`retryState:${tabId}`);
}

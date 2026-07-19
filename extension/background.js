
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8765;
const FILE_BRIDGE_DEFAULT_PORT = 8964;
const OVERLAP_PX = 50;
const AFTER_SEND_DELAY_MS = 0;
const DEFAULT_CAPTURE_INTERVAL_MS = 100;
const BACKEND_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_CAPTURE_PAGES = 500;
const MAX_SAVE_PATH_CHARS = 1024;
const MAX_PERSISTED_TEXT_BYTES = 1_000_000;
const OPERATION_SCHEMA_VERSION = 1;
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

function invalidateBackendEndpointCache() {
  _backendBaseUrl = null;
  _backendBaseUrlExpiry = 0;
}

async function snapshotBackendSettings() {
  const items = await chrome.storage.sync.get({ backendHost: DEFAULT_HOST, backendPort: DEFAULT_PORT });
  return normalizeBackendSettings(items.backendHost, items.backendPort);
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

async function hasFileBridgePermission() {
  if (!chrome.permissions?.contains) return true;
  const items = await chrome.storage.sync.get({
    fileBridgeHost: '',
    fileBridgePort: FILE_BRIDGE_DEFAULT_PORT
  });
  const fileBridge = normalizeBackendSettings(
    items.fileBridgeHost || DEFAULT_HOST,
    items.fileBridgePort || FILE_BRIDGE_DEFAULT_PORT
  );
  return chrome.permissions.contains({ origins: [`http://${fileBridge.host}/*`] });
}

async function getBackendHeaders(contentType, operationId = '') {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (operationId) headers['X-TextKit-Operation-Id'] = operationId;
  return headers;
}

function normalizeSavePath(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Save path is required.');
  if (raw.length > MAX_SAVE_PATH_CHARS || raw.includes('\0')) throw new Error('Save path is invalid or too long.');
  const slashPath = raw.replace(/\\/g, '/');
  if (slashPath.startsWith('/') || /^[A-Za-z]:/.test(slashPath)) {
    throw new Error('Save path must be relative to the file bridge root.');
  }
  const parts = slashPath.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..' || part.includes(':'))) {
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

function requirePersistableText(text, label) {
  if (encodedTextByteLength(text) > MAX_PERSISTED_TEXT_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_PERSISTED_TEXT_BYTES}-byte storage safety limit.`);
  }
  return text;
}

function encodedTextByteLength(text) {
  return new TextEncoder().encode(String(text)).length;
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

  const portText = String(port ?? '').trim();
  const normalizedPort = /^\d+$/.test(portText) ? Number(portText) : NaN;
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
const tabDocumentGenerations = new Map();
const targetTabWaiters = new Set();
let targetTabChangeRevision = 0;
const pendingOffscreenCopies = new Map();
let nextOffscreenCopyId = 1;
let offscreenDocumentCreationPromise = null;

function getState(tabId) {
  if (!states.has(tabId)) {
    states.set(tabId, {
      active: false, status: 'Idle', currentPage: 0, fragmentsCollected: 0,
      progress: 'Ready', mergedText: '', fragments: [], error: '',
      lastRegion: savedLastRegion, stopRequested: false, retryState: null,
      retryStage: null, pendingText: '', captureInFlight: false,
      targetRemoved: false, navigationChanged: false, captureUrl: null,
      collectionComplete: false, partialReason: '', partialError: '', operationPrompts: null,
      operationBackend: null,
      selectionToken: null, checkpointText: '', captureDocumentGeneration: 0,
      captureOperationId: null, captureDocumentId: null
    });
  }
  return states.get(tabId);
}

async function getRecoverableState(tabId) {
  const state = getState(tabId);
  if (state.status !== 'Idle' || state.captureInFlight || state.retryState) return state;
  const retryState = await loadRetryState(tabId);
  if (!retryState) return state;

  const legacyFragments = Array.isArray(retryState.fragments) ? retryState.fragments : [];
  const checkpointText = retryState.mergedText || mergeFragments(legacyFragments);
  const fragmentsCollected = retryState.fragmentsCollected ?? legacyFragments.length;
  Object.assign(state, {
    active: true,
    status: 'Error',
    progress: retryState.stage === 'dedup'
      ? 'Dedup retry was interrupted. Click Retry to continue.'
      : 'OCR retry was interrupted. Click Retry to continue.',
    error: 'The extension service worker restarted during a backend retry.',
    checkpointText,
    fragmentsCollected,
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

let startupReadiness = Promise.resolve();

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
  if (changeInfo.status === 'loading') {
    tabDocumentGenerations.set(tabId, (tabDocumentGenerations.get(tabId) || 0) + 1);
  }
  const state = states.get(tabId);
  if (!state?.captureInFlight) return;
  if (changeInfo.status !== 'loading' && (!changeInfo.url || !state.captureUrl || changeInfo.url === state.captureUrl)) return;
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
  handleTranslateStop(tabId).catch(() => {});
  handleFormatStop(tabId).catch(() => {});
  captureControllers.get(tabId)?.abort();
  if (captureInFlight) return;
  cleanupClosedTab(tabId).catch(() => {});
});

async function cleanupClosedTab(tabId) {
  states.delete(tabId);
  tabDocumentGenerations.delete(tabId);
  captureControllers.delete(tabId);
  captureOperationIds.delete(tabId);
  translateOperationIds.delete(tabId);
  formatOperationIds.delete(tabId);
  await chrome.storage.local.remove([
    `lastResult:${tabId}`,
    `tl2Result:${tabId}`,
    `tl2Status:${tabId}`,
    `tl2Translating:${tabId}`,
    `fmtResult:${tabId}`,
    `fmtStatus:${tabId}`,
    `fmtFormatting:${tabId}`,
    `retryState:${tabId}`,
    `lastStatus:${tabId}`,
    operationStorageKey('capture', tabId),
    operationStorageKey('translate', tabId),
    operationStorageKey('format', tabId)
  ]);
}
// ── keyboard shortcut ──────────────────────────────────────────

async function ensureBackendPermission() {
  if (!chrome.permissions?.contains || !chrome.permissions?.request) return true;
  const settings = await chrome.storage.sync.get({ backendHost: DEFAULT_HOST, backendPort: DEFAULT_PORT });
  const backend = normalizeBackendSettings(settings.backendHost, settings.backendPort);
  const origins = [`http://${backend.host}/*`];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-region-capture') return;
  try {
    await startupReadiness;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return;
    }
    const state = getState(tab.id);
    if (state.active || state.captureInFlight || state.status === 'Selecting') {
      console.warn('A capture is already active for this tab.');
      return;
    }
    if (!await ensureBackendPermission()) throw new Error('Backend permission was not granted.');
    await abortDownstreamOperations(tab.id);
    await ensureContentScript(tab.id);
    state.operationBackend = await snapshotBackendSettings();
    invalidateBackendEndpointCache();
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
    startupReadiness.then(() => handlePopupStart(message)).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'popup:get-state') {
    getActiveTab()
      .then(async (tab) => sendResponse({ ok: true, state: getPublicState(await getRecoverableState(tab.id)), tabId: tab.id }))
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
    startupReadiness.then(() => handleStop()).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'popup:retry') {
    startupReadiness.then(() => handleRetry()).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'translate:start') {
    startupReadiness.then(() => handleTranslateStart(message)).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'translate:stop') {
    startupReadiness.then(() => handleTranslateStop(message.tabId))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'save:translation') {
    handleSaveTranslation(message).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'format:start') {
    startupReadiness.then(() => handleFormatStart(message)).then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'format:stop') {
    startupReadiness.then(() => handleFormatStop(message.tabId))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
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
  await abortDownstreamOperations(tab.id);
  await ensureContentScript(tab.id);
  state.operationBackend = message.backend
    ? normalizeBackendSettings(message.backend.host, message.backend.port)
    : await snapshotBackendSettings();
  invalidateBackendEndpointCache();
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

async function handleCaptureLoopFailure(tabId, error, logPrefix) {
  console.error(logPrefix, error);
  const state = getState(tabId);
  if (state.fragmentsCollected > 0 && state.checkpointText) {
    try {
      state.partialReason = 'error';
      state.partialError = error.message || 'Capture failed.';
      updateState(tabId, { error: state.partialError });
      await runDedupLifecycle(tabId, state.checkpointText, state.fragmentsCollected);
      if (state.captureOperationId) await clearOperation('capture', tabId, state.captureOperationId).catch(() => {});
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
  const operationId = state.captureOperationId;
  if (operationId) {
    await clearOperation('capture', tabId, operationId).catch((clearError) => {
      console.error('Failed to clear terminal capture checkpoint:', clearError);
    });
    if (state.captureOperationId === operationId) state.captureOperationId = null;
  }
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
  await Promise.all([handleTranslateStop(tab.id), handleFormatStop(tab.id)]);
  // If in error state
  // If in error state (waiting for retry), finalize collected fragments now
  if (state.status === 'Error' && state.fragmentsCollected > 0 && state.checkpointText) {
    await clearRetryState(tab.id, state);
    await finalizeCapture(tab.id, state.checkpointText, state.fragmentsCollected);
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
    runDedupLifecycle(tab.id, pendingText, state.fragmentsCollected || 0)
      .catch((error) => handleRetryFailure(tab.id, error));
    return { ok: true };
  }

  const rs = state.retryState || await loadRetryState(tab.id);
  if (!rs) throw new Error('No retry state saved.');
  state.retryState = null;
  chrome.storage.local.remove(`retryState:${tab.id}`).catch(() => {});
  if (rs.stage === 'dedup') {
    state.operationPrompts = normalizeCapturePrompts(rs.promptSnapshot);
    state.operationBackend = rs.backendSnapshot
      ? normalizeBackendSettings(rs.backendSnapshot.host, rs.backendSnapshot.port)
      : await snapshotBackendSettings();
    updateState(tab.id, { active: true, status: 'Deduplicating', progress: 'Retrying dedup...', error: '' });
    runDedupLifecycle(
      tab.id,
      rs.mergedText || mergeFragments(rs.fragments || []),
      rs.fragmentsCollected ?? (rs.fragments || []).length
    ).catch((error) => handleRetryFailure(tab.id, error));
    return { ok: true };
  }
  updateState(tab.id, { active: true, status: 'Capturing', progress: 'Retrying...', error: '' });
  resumeCaptureLoop(rs).catch((error) => handleCaptureLoopFailure(tab.id, error, 'Capture retry failed:'));
  return { ok: true };
}

function handleRetryFailure(tabId, error) {
  console.error('Retry failed:', error);
  updateState(tabId, {
    active: true,
    status: 'Error',
    error: error.message || 'Retry failed.',
    progress: 'Retry failed. Click Retry to continue.'
  });
}

// ── manual translation (delegated to background so it survives popup close) ─

const translateControllers = new Map();
const formatControllers = new Map();
const captureControllers = new Map();
const translateOperationIds = new Map();
const formatOperationIds = new Map();
const captureOperationIds = new Map();
const operationCheckpointQueues = new Map();
const operationMutationQueues = new Map();
let keepAliveIntervalId = null;

function createOperationId(type, tabId) {
  return `${type}:${tabId}:${createSelectionToken()}`;
}

function isCurrentOperation(operationMap, tabId, operationId) {
  return operationMap.get(tabId) === operationId;
}

function operationStorageKey(type, tabId) {
  return `operation:${type}:${tabId}`;
}

function serializeQueuedOperation(queues, key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  queues.set(key, current);
  const cleanup = () => {
    if (queues.get(key) === current) queues.delete(key);
  };
  current.then(cleanup, cleanup);
  return current;
}

function serializeOperationMutation(type, tabId, task) {
  return serializeQueuedOperation(operationMutationQueues, `${type}:${tabId}`, task);
}

function commitCurrentOperation(type, operationMap, tabId, operationId, task) {
  return serializeOperationMutation(type, tabId, async () => {
    if (!isCurrentOperation(operationMap, tabId, operationId)) return false;
    await task();
    return isCurrentOperation(operationMap, tabId, operationId);
  });
}

function persistOperation(type, tabId, operationId, input, status = 'running') {
  const key = operationStorageKey(type, tabId);
  return serializeQueuedOperation(operationCheckpointQueues, key, () => {
    return chrome.storage.local.set({
      [key]: {
        version: OPERATION_SCHEMA_VERSION,
        type,
        tabId,
        operationId,
        status,
        input,
        updatedAt: Date.now()
      }
    });
  });
}

function clearOperation(type, tabId, operationId) {
  const key = operationStorageKey(type, tabId);
  return serializeQueuedOperation(operationCheckpointQueues, key, async () => {
    const stored = await chrome.storage.local.get(key);
    if (stored[key]?.operationId === operationId) await chrome.storage.local.remove(key);
  });
}

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

function maybeStopKeepAlive() {
  if (captureControllers.size === 0 && translateControllers.size === 0 && formatControllers.size === 0) {
    stopKeepAlive();
  }
}

async function abortDownstreamOperations(tabId) {
  await Promise.all([handleTranslateStop(tabId), handleFormatStop(tabId)]);
}

async function handleTranslateStart(msg) {
  const { tabId, text, language, host, port } = msg;
  if (!tabId || !text) return { ok: false, error: 'Missing tabId or text' };
  try {
    requirePersistableText(text, 'Translation input');
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const operationId = msg.operationId || createOperationId('translate', tabId);
  const promptWasProvided = Object.prototype.hasOwnProperty.call(msg, 'prompt');
  let promptSnapshot = promptWasProvided ? normalizeCustomPrompt(msg.prompt) : undefined;
  if (!promptWasProvided) {
    const key = `translatePrompt:${language}`;
    const stored = await chrome.storage.local.get(key);
    promptSnapshot = normalizeCustomPrompt(stored[key]);
  }

  const controller = new AbortController();

  try {
    await serializeOperationMutation('translate', tabId, async () => {
      await stopTranslateOperation(tabId);
      translateControllers.set(tabId, controller);
      translateOperationIds.set(tabId, operationId);
      startKeepAlive();

      // Replace the previous checkpoint and visible state as one per-tab
      // mutation, so old cleanup cannot remove the new operation.
      await persistOperation('translate', tabId, operationId, {
        text, language, host: host || DEFAULT_HOST, port: port || DEFAULT_PORT,
        prompt: promptSnapshot
      });
      await chrome.storage.local.set({
        [`tl2Translating:${tabId}`]: true,
        [`tl2Status:${tabId}`]: `Translating to ${language}...`
      });
      await chrome.storage.local.remove(`tl2Result:${tabId}`);
      chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: true }).catch(() => {});
    });
    msg.recoveryStarted?.();

    try {
      const customPrompt = renderTranslationPrompt(promptSnapshot, language);
      // "Original" with no custom prompt → pass through unchanged
      if (language === 'original' && !promptSnapshot) {
        const translated = text;
        const committed = await commitCurrentOperation(
          'translate', translateOperationIds, tabId, operationId, async () => {
            await chrome.storage.local.set({
              [`tl2Result:${tabId}`]: translated,
              [`tl2Status:${tabId}`]: 'Complete'
            });
            await clearOperation('translate', tabId, operationId);
            chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: translated }).catch(() => {});
            if (translated) {
              await Promise.allSettled([
                autoCopyIfEnabled(translated),
                autoSaveIfEnabled(translated),
                autoFormatIfEnabled(tabId, translated, host, port)
              ]);
            }
          }
        );
        if (!committed) return { ok: false, error: 'Translation superseded.' };
        return { ok: true };
      }
      const url = buildBackendEndpoint(host || DEFAULT_HOST, port || DEFAULT_PORT, `/translate?_=${Date.now()}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: await getBackendHeaders('application/json', operationId),
        body: JSON.stringify({ text, language, prompt: customPrompt || undefined }),
        signal: controller.signal
      });
      const payload = await readJsonObject(response, 'Translation backend');
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const translated = requireTextPayload(payload, 'Translation backend');
      requirePersistableText(translated, 'Translation result');
      const committed = await commitCurrentOperation(
        'translate', translateOperationIds, tabId, operationId, async () => {
          await chrome.storage.local.set({
            [`tl2Result:${tabId}`]: translated,
            [`tl2Status:${tabId}`]: 'Complete'
          });
          await clearOperation('translate', tabId, operationId);
          chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: translated }).catch(() => {});
          if (translated) {
            await Promise.allSettled([
              autoCopyIfEnabled(translated),
              autoSaveIfEnabled(translated),
              autoFormatIfEnabled(tabId, translated, host, port)
            ]);
          }
        }
      );
      if (!committed) return { ok: false, error: 'Translation superseded.' };
    } catch (e) {
      if (!isCurrentOperation(translateOperationIds, tabId, operationId)) {
        return { ok: false, error: 'Translation superseded.' };
      }
      if (e.name === 'AbortError') {
        const message = 'Translation stopped.';
        const committed = await commitCurrentOperation(
          'translate', translateOperationIds, tabId, operationId, async () => {
            await clearOperation('translate', tabId, operationId).catch(() => {});
            await chrome.storage.local.set({ [`tl2Status:${tabId}`]: message });
          }
        );
        if (!committed) return { ok: false, error: 'Translation superseded.' };
        return { ok: true };
      }
      const errorMessage = e.message || 'Translation failed.';
      const committed = await commitCurrentOperation(
        'translate', translateOperationIds, tabId, operationId, async () => {
          await clearOperation('translate', tabId, operationId).catch(() => {});
          await chrome.storage.local.set({ [`tl2Status:${tabId}`]: errorMessage });
          chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: '', error: errorMessage }).catch(() => {});
        }
      );
      if (!committed) return { ok: false, error: 'Translation superseded.' };
      return { ok: false, error: errorMessage };
    }
  } finally {
    await serializeOperationMutation('translate', tabId, async () => {
      if (translateControllers.get(tabId) !== controller
          || !isCurrentOperation(translateOperationIds, tabId, operationId)) return;
      translateControllers.delete(tabId);
      translateOperationIds.delete(tabId);
      await chrome.storage.local.remove(`tl2Translating:${tabId}`).catch((error) => {
        console.error('Failed to clear translation state:', error);
      });
      chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: false }).catch(() => {});
    });
    maybeStopKeepAlive();
  }

  return { ok: true };
}

async function stopTranslateOperation(tabId) {
  const controller = translateControllers.get(tabId);
  const operationId = translateOperationIds.get(tabId);
  controller?.abort();
  translateControllers.delete(tabId);
  translateOperationIds.delete(tabId);
  await Promise.all([
    chrome.storage.local.remove(`tl2Translating:${tabId}`),
    operationId ? clearOperation('translate', tabId, operationId) : Promise.resolve()
  ]);
  chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: false }).catch(() => {});
}

async function handleTranslateStop(tabId) {
  await serializeOperationMutation('translate', tabId, () => stopTranslateOperation(tabId));
  maybeStopKeepAlive();
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, path: normalizedPath })
  });
  let payload;
  try {
    payload = await readJsonObject(response, 'File bridge');
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (!response.ok || payload.ok !== true) {
    return { ok: false, error: payload.error || payload.detail || `HTTP ${response.status}` };
  }
  return { ok: true, path: normalizedPath };
}

// ── manual format (delegated to background so it survives popup close) ─

async function handleFormatStart(msg) {
  const { tabId, text, host, port } = msg;
  if (!tabId || !text) return { ok: false, error: 'Missing tabId or text' };
  try {
    requirePersistableText(text, 'Format input');
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const operationId = msg.operationId || createOperationId('format', tabId);
  const promptWasProvided = Object.prototype.hasOwnProperty.call(msg, 'prompt');
  let prompt = promptWasProvided ? normalizeCustomPrompt(msg.prompt) : undefined;
  if (!promptWasProvided) {
    const stored = await chrome.storage.local.get('formatPrompt');
    prompt = normalizeCustomPrompt(stored.formatPrompt);
  }

  const controller = new AbortController();

  try {
    await serializeOperationMutation('format', tabId, async () => {
      await stopFormatOperation(tabId);
      formatControllers.set(tabId, controller);
      formatOperationIds.set(tabId, operationId);
      startKeepAlive();

      await persistOperation('format', tabId, operationId, {
        text, host: host || DEFAULT_HOST, port: port || DEFAULT_PORT, prompt
      });
      await chrome.storage.local.set({
        [`fmtFormatting:${tabId}`]: true,
        [`fmtStatus:${tabId}`]: 'Formatting...'
      });
      await chrome.storage.local.remove(`fmtResult:${tabId}`);
      chrome.runtime.sendMessage({ type: 'fmt:formatting', tabId, value: true }).catch(() => {});
    });
    msg.recoveryStarted?.();

    try {
      const url = buildBackendEndpoint(host || DEFAULT_HOST, port || DEFAULT_PORT, `/format?_=${Date.now()}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: await getBackendHeaders('application/json', operationId),
        body: JSON.stringify({ text, prompt }),
        signal: controller.signal
      });
      const payload = await readJsonObject(response, 'Format backend');
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const formatted = requireTextPayload(payload, 'Format backend');
      requirePersistableText(formatted, 'Format result');
      const committed = await commitCurrentOperation(
        'format', formatOperationIds, tabId, operationId, async () => {
          await chrome.storage.local.set({
            [`fmtResult:${tabId}`]: formatted,
            [`fmtStatus:${tabId}`]: 'Complete'
          });
          await clearOperation('format', tabId, operationId);
          chrome.runtime.sendMessage({ type: 'format:update', tabId, text: formatted }).catch(() => {});
          if (formatted) {
            await Promise.allSettled([
              fmtAutoCopyIfEnabled(formatted),
              fmtAutoSaveIfEnabled(formatted)
            ]);
          }
        }
      );
      if (!committed) return { ok: false, error: 'Formatting superseded.' };
    } catch (e) {
      if (!isCurrentOperation(formatOperationIds, tabId, operationId)) {
        return { ok: false, error: 'Formatting superseded.' };
      }
      if (e.name === 'AbortError') {
        const message = 'Formatting stopped.';
        const committed = await commitCurrentOperation(
          'format', formatOperationIds, tabId, operationId, async () => {
            await clearOperation('format', tabId, operationId).catch(() => {});
            await chrome.storage.local.set({ [`fmtStatus:${tabId}`]: message });
          }
        );
        if (!committed) return { ok: false, error: 'Formatting superseded.' };
        return { ok: true };
      }
      const errorMessage = e.message || 'Formatting failed.';
      const committed = await commitCurrentOperation(
        'format', formatOperationIds, tabId, operationId, async () => {
          await clearOperation('format', tabId, operationId).catch(() => {});
          await chrome.storage.local.set({ [`fmtStatus:${tabId}`]: errorMessage });
          chrome.runtime.sendMessage({ type: 'format:update', tabId, text: '', error: errorMessage }).catch(() => {});
        }
      );
      if (!committed) return { ok: false, error: 'Formatting superseded.' };
      return { ok: false, error: errorMessage };
    }
  } finally {
    await serializeOperationMutation('format', tabId, async () => {
      if (formatControllers.get(tabId) !== controller
          || !isCurrentOperation(formatOperationIds, tabId, operationId)) return;
      formatControllers.delete(tabId);
      formatOperationIds.delete(tabId);
      await chrome.storage.local.remove(`fmtFormatting:${tabId}`).catch((error) => {
        console.error('Failed to clear format state:', error);
      });
      chrome.runtime.sendMessage({ type: 'fmt:formatting', tabId, value: false }).catch(() => {});
    });
    maybeStopKeepAlive();
  }

  return { ok: true };
}

async function stopFormatOperation(tabId) {
  const controller = formatControllers.get(tabId);
  const operationId = formatOperationIds.get(tabId);
  controller?.abort();
  formatControllers.delete(tabId);
  formatOperationIds.delete(tabId);
  await Promise.all([
    chrome.storage.local.remove(`fmtFormatting:${tabId}`),
    operationId ? clearOperation('format', tabId, operationId) : Promise.resolve()
  ]);
  chrome.runtime.sendMessage({ type: 'fmt:formatting', tabId, value: false }).catch(() => {});
}

async function handleFormatStop(tabId) {
  await serializeOperationMutation('format', tabId, () => stopFormatOperation(tabId));
  maybeStopKeepAlive();
}

async function autoFormatIfEnabled(tabId, text, host, port, source = 'translation') {
  const state = getState(tabId);
  const captureAutomation = source === 'ocr' || state.captureInFlight;
  const canStart = () => !captureAutomation || canStartPostCaptureAutomation(state);
  if (!canStart()) return;
  const [settings, prompt] = await Promise.all([
    chrome.storage.sync.get({ fmtAutoFormat: false, fmtSourceVal: 'translation' }),
    chrome.storage.local.get('formatPrompt')
  ]);
  if (!settings.fmtAutoFormat) return;
  if (settings.fmtSourceVal !== source) return;
  if (!canStart()) return;
  // Fall back to sync storage if caller didn't provide host/port (e.g. auto-translate path)
  if (!host || port === undefined) {
    const backend = await chrome.storage.sync.get({ backendHost: 'localhost', backendPort: 8765 });
    host = backend.backendHost;
    port = backend.backendPort;
  }
  if (!canStart()) return;
  return handleFormatStart({ tabId, text, prompt: prompt.formatPrompt, host, port });
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
  const backendSnapshot = getState(tabId).operationBackend || await snapshotBackendSettings();
  const normalizedRegion = normalizeRegion(region);
  if (normalizedRegion.width < 2 || normalizedRegion.height < 2) {
    throw new Error('Selected region is too small.');
  }
  return executeCaptureLoop({
    tabId,
    region: normalizedRegion,
    mergedText: '',
    fragmentsCollected: 0,
    lastScrollY: -1,
    resetBeforeStart: true,
    refreshAutoscroll: false,
    captureUrl: tab.url || null,
    promptSnapshot,
    backendSnapshot
  });
}

async function resumeCaptureLoop(rs) {
  const tabId = rs?.tabId ?? rs?.tab?.id;
  if (!tabId) throw new Error('Missing tab id.');
  return executeCaptureLoop({
    tabId,
    region: normalizeRegion(rs.region),
    mergedText: rs.mergedText || mergeFragments(rs.fragments || []),
    fragmentsCollected: rs.fragmentsCollected ?? (rs.fragments || []).length,
    lastScrollY: rs.lastScrollY ?? -1,
    resetBeforeStart: false,
    refreshAutoscroll: true,
    captureUrl: rs.captureUrl || null,
    promptSnapshot: rs.promptSnapshot || getState(tabId).operationPrompts || await snapshotCapturePrompts(),
    backendSnapshot: rs.backendSnapshot || getState(tabId).operationBackend || await snapshotBackendSettings(),
    operationId: rs.operationId,
    captureDocumentId: rs.captureDocumentId || null
  });
}

async function runCaptureLifecycle(tabId, operationId, operation) {
  const state = getState(tabId);
  if (state.captureInFlight) throw new Error('Capture already in progress for this tab.');

  state.captureInFlight = true;
  const controller = new AbortController();
  captureControllers.set(tabId, controller);
  captureOperationIds.set(tabId, operationId);
  startKeepAlive();

  let completed = false;
  try {
    const result = await operation(controller, state);
    completed = true;
    return result;
  } finally {
    state.captureInFlight = false;
    if (captureControllers.get(tabId) === controller) captureControllers.delete(tabId);
    if (isCurrentOperation(captureOperationIds, tabId, operationId)) captureOperationIds.delete(tabId);
    if (completed) await clearOperation('capture', tabId, operationId).catch(() => {});
    maybeStopKeepAlive();
    if (state.targetRemoved) await cleanupClosedTab(tabId).catch(() => {});
  }
}

function runDedupLifecycle(tabId, mergedText, fragmentsOrCount) {
  const state = getState(tabId);
  const operationId = state.captureOperationId
    || state.retryState?.operationId
    || createOperationId('capture', tabId);
  state.captureOperationId = operationId;
  return runCaptureLifecycle(
    tabId,
    operationId,
    () => finalizePostCapture(tabId, mergedText, fragmentsOrCount)
  );
}

async function executeCaptureLoop({
  tabId,
  region,
  mergedText,
  fragmentsCollected,
  lastScrollY,
  resetBeforeStart,
  refreshAutoscroll,
  captureUrl,
  promptSnapshot,
  backendSnapshot,
  operationId: recoveredOperationId,
  captureDocumentId: recoveredDocumentId = null
}) {
  const operationId = recoveredOperationId || createOperationId('capture', tabId);
  return runCaptureLifecycle(tabId, operationId, async (controller, state) => {
    const accumulator = new IncrementalFragmentMerger(mergedText || '');
    let fragmentCount = Number(fragmentsCollected) || 0;
    let scrollLocked = false;
    let fixedAutoscroll;
    try {
      backendSnapshot = backendSnapshot || state.operationBackend || await snapshotBackendSettings();
      if (resetBeforeStart) {
        resetState(tabId);
        state.operationPrompts = normalizeCapturePrompts(promptSnapshot);
        state.operationBackend = normalizeBackendSettings(backendSnapshot.host, backendSnapshot.port);
        updateState(tabId, { active: true, status: 'Capturing', progress: 'Starting capture loop.' });
      } else if (!state.operationPrompts) {
        state.operationPrompts = normalizeCapturePrompts(promptSnapshot);
      }
      if (!state.operationBackend) {
        state.operationBackend = normalizeBackendSettings(backendSnapshot.host, backendSnapshot.port);
      }

      const initialTab = await getLiveTargetTab(tabId);
      state.captureUrl = captureUrl || initialTab?.url || state.captureUrl || null;
      state.captureDocumentGeneration = tabDocumentGenerations.get(tabId) || 0;
      const identity = await chrome.tabs.sendMessage(tabId, { type: 'page:get-document-id' }).catch(() => null);
      if (recoveredDocumentId && identity?.documentId && recoveredDocumentId !== identity.documentId) {
        state.navigationChanged = true;
        state.partialReason = 'navigation';
      }
      state.captureDocumentId = recoveredDocumentId || identity?.documentId || null;
      state.captureOperationId = operationId;
      state.checkpointText = accumulator.text;

      let scrollY = lastScrollY;
      let atBottom = false;

      const persistCheckpoint = async (stage = 'capture') => {
        const input = {
          region,
          mergedText: accumulator.text,
          fragmentsCollected: fragmentCount,
          lastScrollY: scrollY,
          captureUrl: state.captureUrl,
          captureDocumentId: state.captureDocumentId,
          promptSnapshot: state.operationPrompts,
          ...(state.operationBackend ? { backendSnapshot: state.operationBackend } : {}),
          stage
        };
        await persistOperation('capture', tabId, operationId, input);
        return input;
      };
      await persistCheckpoint();

      capturePages: while (true) {
        if (state.stopRequested || state.targetRemoved || state.navigationChanged) break;
        if (fixedAutoscroll === undefined || refreshAutoscroll) {
          const settings = await chrome.storage.sync.get({ ocrAutoscroll: true });
          fixedAutoscroll = settings.ocrAutoscroll;
        }
        const ocrAutoscroll = fixedAutoscroll;
        const { captureIntervalMs } = await chrome.storage.sync.get({
          captureIntervalMs: DEFAULT_CAPTURE_INTERVAL_MS
        });
        if (!ocrAutoscroll && fragmentCount > 0) {
          updateState(tabId, { progress: 'Single capture complete (autoscroll off).' });
          break;
        }
        const pageNumber = fragmentCount + 1;
        updateState(tabId, {
          currentPage: pageNumber,
          fragmentsCollected: fragmentCount,
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
        const checkpoint = await persistCheckpoint('ocr');
        state.retryState = {
          stage: 'ocr',
          tabId,
          operationId,
          ...checkpoint
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
              state.operationPrompts?.ocr,
              operationId,
              state.operationBackend
            );
            accumulator.append(text);
            fragmentCount += 1;
            state.checkpointText = accumulator.text;
            await clearRetryState(tabId, state);
            await persistCheckpoint();
            break;
          } catch (e) {
            if (e?.code === 'TEXT_LIMIT') {
              state.partialReason = 'text_limit';
              state.partialError = e.message;
              await clearRetryState(tabId, state);
              break capturePages;
            }
            if (state.stopRequested || state.targetRemoved || controller.signal.aborted) {
              await clearRetryState(tabId, state);
              break capturePages;
            }
            updateState(tabId, { progress: `Retrying page ${pageNumber} (attempt ${attempt + 1})...` });
            await abortableSleep(2000, controller.signal);
          }
        }

        updateState(tabId, {
          fragmentsCollected: fragmentCount,
          progress: `Collected ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}.`
        });

        await sleep(AFTER_SEND_DELAY_MS);

        if (!ocrAutoscroll) break;

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
            if (fragmentCount >= MAX_CAPTURE_PAGES) {
              state.partialReason = 'page_limit';
              state.partialError = `Capture truncated at the ${MAX_CAPTURE_PAGES}-page limit.`;
              updateState(tabId, { progress: state.partialError });
              break;
            }
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
          if (!scrollResult.changed && fragmentCount > 0) break;
          atBottom = true;
          if (fragmentCount >= MAX_CAPTURE_PAGES) {
            state.partialReason = 'page_limit';
            state.partialError = `Capture truncated at the ${MAX_CAPTURE_PAGES}-page limit.`;
            updateState(tabId, { progress: state.partialError });
            break;
          }
          await sleep(captureIntervalMs);
          continue;
        }
        scrollY = scrollResult.scrollY;
        if (fragmentCount >= MAX_CAPTURE_PAGES) {
          state.partialReason = 'page_limit';
          state.partialError = `Capture truncated at the ${MAX_CAPTURE_PAGES}-page limit.`;
          updateState(tabId, { progress: state.partialError });
          break;
        }
        await sleep(captureIntervalMs);
      }

      state.collectionComplete = true;
      const finalMergedText = accumulator.text;
      if (state.navigationChanged) state.partialReason = 'navigation';
      else if (state.stopRequested) state.partialReason = 'stopped';
      else if (state.targetRemoved) state.partialReason = 'tab_closed';
      if (state.partialReason) {
        // An interrupted capture preserves every fragment collected so far but
        // must not present or automate the result as a complete capture.
        await finalizeCapture(tabId, finalMergedText, fragmentCount);
      } else {
        updateState(tabId, { progress: 'Deduplicating merged text...' });
        await finalizePostCapture(tabId, finalMergedText, fragmentCount);
      }
    } finally {
      // Unlock page scroll
      if (scrollLocked) chrome.tabs.sendMessage(tabId, { type: 'page:unlock-scroll' }).catch(() => {});
    }
  });
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
  abortDownstreamOperations(tabId).catch(() => {});
  updateState(tabId, {
    progress: 'Capture stopped because the page navigated. Preserving collected fragments.'
  });
  notifyTargetTabChange();
}

function targetDocumentChanged(tabId, state, tab) {
  const generationChanged = (tabDocumentGenerations.get(tabId) || 0) !== state.captureDocumentGeneration;
  if (!generationChanged && (!state.captureUrl || !tab?.url || tab.url === state.captureUrl)) return false;
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
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response?.documentId) {
        if (state.captureDocumentId && response.documentId !== state.captureDocumentId) {
          markTargetNavigated(tabId, state);
          return { status: 'navigated' };
        }
        state.captureDocumentId ||= response.documentId;
      }
      return {
        status: 'sent',
        response,
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

function fragmentCountOf(fragmentsOrCount) {
  return Array.isArray(fragmentsOrCount) ? fragmentsOrCount.length : Math.max(0, Number(fragmentsOrCount) || 0);
}

function captureCancellationRequested(state, signal) {
  return Boolean(
    state.stopRequested
    || state.targetRemoved
    || state.navigationChanged
    || signal?.aborted
  );
}

function applyCaptureCancellationReason(state, signal) {
  if (state.navigationChanged) state.partialReason = 'navigation';
  else if (state.targetRemoved) state.partialReason = 'tab_closed';
  else if (state.stopRequested || signal?.aborted) state.partialReason = 'stopped';
}

async function finalizePostCapture(tabId, mergedText, fragmentsOrCount) {
  const state = getState(tabId);
  const fragmentCount = fragmentCountOf(fragmentsOrCount);
  const signal = captureControllers.get(tabId)?.signal;
  state.retryStage = 'dedup';
  state.pendingText = mergedText;
  state.retryState = {
    stage: 'dedup',
    tabId,
    mergedText,
    fragmentsCollected: fragmentCount,
    promptSnapshot: state.operationPrompts,
    ...(state.operationBackend ? { backendSnapshot: state.operationBackend } : {}),
    operationId: state.captureOperationId,
    ...(state.captureUrl ? { captureUrl: state.captureUrl } : {})
  };
  await chrome.storage.local.set({ [`retryState:${tabId}`]: state.retryState });
  if (state.captureOperationId) {
    await persistOperation('capture', tabId, state.captureOperationId, {
      stage: 'dedup',
      mergedText,
      fragmentsCollected: fragmentCount,
      promptSnapshot: state.operationPrompts,
      ...(state.operationBackend ? { backendSnapshot: state.operationBackend } : {}),
      captureUrl: state.captureUrl
    });
  }
  let finalText;
  for (let attempt = 1; ; attempt++) {
    if (captureCancellationRequested(state, signal)) {
      applyCaptureCancellationReason(state, signal);
      await clearRetryState(tabId, state);
      finalText = null;
      break;
    }
    try {
      finalText = await postTextForDedup(
        mergedText,
        signal,
        state.operationPrompts?.dedup,
        state.captureOperationId,
        state.operationBackend
      );
      await clearRetryState(tabId, state);
      break;
    } catch (e) {
      if (captureCancellationRequested(state, signal)) {
        applyCaptureCancellationReason(state, signal);
        await clearRetryState(tabId, state);
        finalText = null;
        break;
      }
      updateState(tabId, { progress: `Retrying dedup (${attempt + 1})...` });
      await abortableSleep(2000, signal);
    }
  }

  if (!finalText) {
    // Stop requested during retry — finalize raw text
    await finalizeCapture(tabId, mergedText, fragmentCount);
    return;
  }

  await finalizeCapture(tabId, finalText, fragmentCount);
}

function canStartPostCaptureAutomation(state) {
  return !state.targetRemoved && !state.stopRequested && !state.partialReason;
}

async function finalizeCapture(tabId, finalText, fragmentsOrCount) {
  const state = getState(tabId);
  const fragmentCount = fragmentCountOf(fragmentsOrCount);
  state.retryStage = null;
  state.pendingText = '';

  const isPartial = Boolean(state.partialReason);
  const isEmptyCancellation = !String(finalText || '').length
    && ['stopped', 'navigation', 'tab_closed'].includes(state.partialReason);
  if (isEmptyCancellation) {
    let progress = 'Capture cancelled before any text was collected.';
    if (state.partialReason === 'navigation') {
      progress = 'Capture cancelled because the page navigated before any text was collected.';
    } else if (state.partialReason === 'tab_closed') {
      progress = 'Capture cancelled because the tab closed before any text was collected.';
    }
    updateState(tabId, {
      active: false,
      status: 'Cancelled',
      currentPage: 0,
      fragmentsCollected: 0,
      progress,
      fragments: [],
      checkpointText: '',
      mergedText: ''
    });
    await chrome.storage.local.remove(`lastResult:${tabId}`);
    await clearRetryState(tabId, state);
    await chrome.storage.local.set({ [`lastStatus:${tabId}`]: 'Cancelled' });
    if (state.captureOperationId) {
      await clearOperation('capture', tabId, state.captureOperationId);
    }
    return '';
  }

  requirePersistableText(finalText, 'Capture result');
  let progress = 'Finished.';
  if (state.partialReason === 'navigation') {
    progress = `Partial capture: page navigation stopped capture after ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'stopped') {
    progress = `Partial capture stopped after ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'tab_closed') {
    progress = `Partial capture: the tab closed after ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'error') {
    progress = `Partial capture ended after an error; saved ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'text_limit') {
    progress = `Partial capture stopped at the ${MAX_PERSISTED_TEXT_BYTES}-byte safety limit after ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'page_limit') {
    progress = `Partial capture truncated at the ${MAX_CAPTURE_PAGES}-page limit; more page content remains.`;
  }
  const finalStatus = isPartial ? 'Partial' : 'Done';

  updateState(tabId, {
    active: false,
    status: finalStatus,
    currentPage: fragmentCount,
    fragmentsCollected: fragmentCount,
    progress,
    fragments: [],
    checkpointText: finalText,
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

  await clearRetryState(tabId, state);
  if (state.captureOperationId) {
    await clearOperation('capture', tabId, state.captureOperationId);
  }

  // Run post-capture automation only for a normally completed capture.
  if (canStartPostCaptureAutomation(state)) {
    await autoFormatIfEnabled(tabId, finalText, undefined, undefined, 'ocr');
    if (canStartPostCaptureAutomation(state)) {
      try {
        await autoTranslateIfEnabled(tabId, finalText);
      } catch (error) {
        const message = error?.message || 'Auto-translation failed.';
        await chrome.storage.local.set({ [`tl2Status:${tabId}`]: message }).catch((storageError) => {
          console.error('Failed to persist auto-translation error:', storageError);
        });
        console.error('Auto-translation failed after capture completed:', error);
      }
    }
  }

  return finalText;
}

async function autoTranslateIfEnabled(tabId, originalText) {
  const state = getState(tabId);
  if (!canStartPostCaptureAutomation(state)) return;
  const { ocrAutoTranslate } = await chrome.storage.sync.get({
    ocrAutoTranslate: false
  });
  if (!ocrAutoTranslate) return;

  const tl2Lang = await chrome.storage.local.get('tl2Language');
  if (!canStartPostCaptureAutomation(state)) return;
  const language = tl2Lang.tl2Language || 'original';
  const backend = state.operationBackend || await snapshotBackendSettings();
  if (!canStartPostCaptureAutomation(state)) return;
  const result = await handleTranslateStart({
    tabId,
    text: originalText,
    language,
    host: backend.host,
    port: backend.port
  });
  if (!result?.ok) throw new Error(result?.error || 'Auto-translation failed.');
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

async function postImageForOcr(blob, pageNumber, signal, customPrompt, operationId = '', backendSnapshot = null) {
  if (arguments.length < 4) {
    const stored = await chrome.storage.local.get('ocrPrompt');
    customPrompt = normalizeCustomPrompt(stored.ocrPrompt);
  }
  const formData = new FormData();
  formData.append('image', blob, `page-${String(pageNumber).padStart(4, '0')}.png`);
  if (customPrompt) formData.append('prompt', customPrompt);

  const url = backendSnapshot
    ? buildBackendEndpoint(backendSnapshot.host, backendSnapshot.port, '/ocr')
    : await getBackendEndpoint('/ocr');
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: await getBackendHeaders(undefined, operationId ? `${operationId}:page:${pageNumber}` : ''),
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

async function postTextForDedup(text, signal, customPrompt, operationId = '', backendSnapshot = null) {
  if (arguments.length < 3) {
    const stored = await chrome.storage.local.get('dedupPrompt');
    customPrompt = normalizeCustomPrompt(stored.dedupPrompt);
  }
  const url = backendSnapshot
    ? buildBackendEndpoint(backendSnapshot.host, backendSnapshot.port, '/dedup')
    : await getBackendEndpoint('/dedup');

  const body = { text };
  if (customPrompt) body.prompt = customPrompt;

  const response = await fetchWithTimeout(url + '?_=' + Date.now(), {
    method: 'POST',
    headers: await getBackendHeaders('application/json', operationId ? `${operationId}:dedup` : ''),
    body: JSON.stringify(body)
  }, signal);

  if (!response.ok) {
    throw new Error(`Dedup HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  const payload = await readJsonObject(response, 'Dedup backend');
  return requireTextPayload(payload, 'Dedup backend').trim();
}

// ── merge logic ────────────────────────────────────────────────

class IncrementalFragmentMerger {
  constructor(initialText = '') {
    this.text = normalizeText(initialText);
    this.lines = this.text ? this.text.split('\n') : [];
    this.byteLength = encodedTextByteLength(this.text);
  }

  append(fragment) {
    const nextLines = splitLines(fragment);
    if (!nextLines.length) return;
    const overlap = findLineOverlap(this.lines, nextLines);
    const appendedLines = nextLines.slice(overlap);
    if (!appendedLines.length) return;
    const appendedText = appendedLines.join('\n');
    const candidateByteLength = this.byteLength + (this.text ? 1 : 0) + encodedTextByteLength(appendedText);
    if (candidateByteLength > MAX_PERSISTED_TEXT_BYTES) {
      const error = new Error(`Capture text exceeded the ${MAX_PERSISTED_TEXT_BYTES}-byte checkpoint limit.`);
      error.code = 'TEXT_LIMIT';
      throw error;
    }
    this.lines.push(...appendedLines);
    this.text = this.text ? `${this.text}\n${appendedText}` : appendedText;
    this.byteLength = candidateByteLength;
  }
}

function mergeFragments(fragments) {
  const merger = new IncrementalFragmentMerger();
  for (const fragment of fragments || []) merger.append(fragment);
  return merger.text;
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

function abortableSleep(ms, signal) {
  if (!signal) return sleep(ms);
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
    operationBackend: null,
    selectionToken: null,
    checkpointText: '',
    captureDocumentGeneration: 0,
    captureOperationId: null,
    captureDocumentId: null
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
    `fmtStatus:${tabId}`
  ]).catch(() => {});
}

async function copyToClipboard(text) {
  if (!text) return false;
  await ensureOffscreenDocument();
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

async function hasOffscreenDocument() {
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
  return hasDocument;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!offscreenDocumentCreationPromise) {
    offscreenDocumentCreationPromise = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Clipboard access for TextKit results'
    }).finally(() => {
      offscreenDocumentCreationPromise = null;
    });
  }
  await offscreenDocumentCreationPromise;
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

function getPublicState(state) {
  return {
    active: state.active,
    status: state.status,
    currentPage: state.currentPage,
    fragmentsCollected: state.fragmentsCollected,
    progress: state.progress,
    mergedText: state.mergedText,
    error: state.error,
    lastRegion: state.lastRegion,
    retryStage: state.retryStage,
    retryState: state.retryState ? { stage: state.retryState.stage } : null,
    partialReason: state.partialReason
  };
}

function broadcastState(tabId) {
  chrome.runtime.sendMessage({ type: 'state:update', tabId, state: getPublicState(getState(tabId)) }).catch(() => {});
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
    if (!await hasFileBridgePermission()) {
      throw new Error('File bridge permission is missing or was revoked.');
    }
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
    if (!await hasFileBridgePermission()) {
      throw new Error('File bridge permission is missing or was revoked.');
    }
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

async function removeScannedOperationIfCurrent(key, scannedOperation) {
  await serializeQueuedOperation(operationCheckpointQueues, key, async () => {
    const stored = await chrome.storage.local.get(key);
    if (JSON.stringify(stored[key]) === JSON.stringify(scannedOperation)) {
      await chrome.storage.local.remove(key);
    }
  });
}

async function rereadRecoveryCheckpoint(key, scannedOperation) {
  const stored = await chrome.storage.local.get(key);
  const current = stored[key];
  if (!current || current.status !== 'running') return null;
  if (current.operationId !== scannedOperation.operationId
      || current.updatedAt !== scannedOperation.updatedAt) return null;
  return current;
}

async function waitForRecoveryHandoff(startOperation) {
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const operation = startOperation(signalStarted);
  await Promise.race([started, operation]);
  return { operation };
}

async function recoverPersistedOperations() {
  const stored = await chrome.storage.local.get(null);
  const operations = Object.entries(stored)
    .filter(([key, value]) => key.startsWith('operation:') && value?.status === 'running');
  for (let [key, operation] of operations) {
    if (operation.version !== OPERATION_SCHEMA_VERSION
        || !Number.isInteger(operation.tabId)
        || typeof operation.operationId !== 'string'
        || !operation.input || typeof operation.input !== 'object') {
      await removeScannedOperationIfCurrent(key, operation);
      continue;
    }
    const tab = await getLiveTargetTab(operation.tabId);
    if (!tab) {
      await removeScannedOperationIfCurrent(key, operation);
      continue;
    }
    operation = await rereadRecoveryCheckpoint(key, operation);
    if (!operation) continue;
    if (operation.type === 'translate' && !translateControllers.has(operation.tabId)) {
      const { operation: recovered } = await waitForRecoveryHandoff((recoveryStarted) => handleTranslateStart({
        ...operation.input,
        tabId: operation.tabId,
        operationId: operation.operationId,
        recoveryStarted
      }));
      recovered.catch((error) => console.error('Translation recovery failed:', error));
    } else if (operation.type === 'format' && !formatControllers.has(operation.tabId)) {
      const { operation: recovered } = await waitForRecoveryHandoff((recoveryStarted) => handleFormatStart({
        ...operation.input,
        tabId: operation.tabId,
        operationId: operation.operationId,
        recoveryStarted
      }));
      recovered.catch((error) => console.error('Format recovery failed:', error));
    } else if (operation.type === 'capture' && !captureControllers.has(operation.tabId)) {
      const input = operation.input;
      const state = getState(operation.tabId);
      Object.assign(state, {
        active: true,
        status: input.stage === 'dedup' ? 'Deduplicating' : 'Capturing',
        progress: 'Resuming after service worker restart...',
        checkpointText: input.mergedText || '',
        fragmentsCollected: input.fragmentsCollected || 0,
        operationPrompts: normalizeCapturePrompts(input.promptSnapshot),
        operationBackend: input.backendSnapshot
          ? normalizeBackendSettings(input.backendSnapshot.host, input.backendSnapshot.port)
          : await snapshotBackendSettings(),
        captureUrl: input.captureUrl || tab.url || null,
        captureOperationId: operation.operationId,
        captureDocumentId: input.captureDocumentId || null
      });
      if (input.stage === 'dedup') {
        runDedupLifecycle(
          operation.tabId,
          input.mergedText || '',
          input.fragmentsCollected || 0
        ).then(() => clearOperation('capture', operation.tabId, operation.operationId))
          .catch((error) => console.error('Dedup recovery failed:', error))
      } else {
        resumeCaptureLoop({ ...input, tabId: operation.tabId, operationId: operation.operationId })
          .catch((error) => handleCaptureLoopFailure(operation.tabId, error, 'Capture recovery failed:'));
      }
    }
  }
}

startupReadiness = (async () => {
  try {
    await recoverScrollLocks();
  } catch (error) {
    console.error('Stale scroll-lock cleanup failed:', error);
  }
  try {
    await recoverPersistedOperations();
  } catch (error) {
    console.error('Operation recovery scan failed:', error);
  }
})();


const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8765;
const OVERLAP_PX = 50;
const AFTER_SEND_DELAY_MS = 0;
const BACKEND_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_CAPTURE_PAGES = 500;
const LOCAL_BACKEND_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

let _backendBaseUrl = null;
let _backendBaseUrlExpiry = 0;

async function getBackendEndpoint(path) {
  if (!_backendBaseUrl || Date.now() > _backendBaseUrlExpiry) {
    const items = await chrome.storage.sync.get({ ocrHost: DEFAULT_HOST, ocrPort: DEFAULT_PORT });
    _backendBaseUrl = buildBackendEndpoint(items.ocrHost, items.ocrPort, '');
    _backendBaseUrlExpiry = Date.now() + 60_000;  // cache 1 minute
  }
  return _backendBaseUrl + path;
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

let states = new Map();
let savedLastRegion = null;

function getState(tabId) {
  if (!states.has(tabId)) {
    states.set(tabId, {
      active: false, status: 'Idle', currentPage: 0, fragmentsCollected: 0,
      progress: 'Ready', mergedText: '', fragments: [], error: '',
      lastRegion: savedLastRegion, stopRequested: false, retryState: null,
      retryStage: null, pendingText: '', captureInFlight: false
    });
  }
  return states.get(tabId);
}

// Load saved region on startup
chrome.storage.local.get('lastRegion', (items) => {
  if (items.lastRegion) {
    savedLastRegion = items.lastRegion;
    states.forEach((state) => { state.lastRegion = savedLastRegion; });
  }
});

// Clean up per-tab state and storage when a tab is closed, so the in-memory
// Map and chrome.storage.local don't grow unbounded over a browsing session.
chrome.tabs.onRemoved.addListener((tabId) => {
  states.delete(tabId);
  handleTranslateStop(tabId);
  captureControllers.get(tabId)?.abort();
  captureControllers.delete(tabId);
  chrome.storage.local.remove([
    `lastResult:${tabId}`,
    `tl2Result:${tabId}`,
    `tl2Language:${tabId}`,
    `tl2Status:${tabId}`,
    `tl2Translating:${tabId}`,
    `retryState:${tabId}`,
    `preDedup:${tabId}`,
    `postDedup:${tabId}`
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
    await ensureContentScript(tab.id);

    updateState(tab.id, { active: true, status: 'Selecting', progress: 'Drag a rectangle.' });
    await chrome.tabs.sendMessage(tab.id, {
      type: 'selection:start',
      lastRegion: getState(tab.id).lastRegion || undefined
    });
  } catch (e) {
    console.error('Command handler failed:', e);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) updateState(tab.id, { active: false, status: 'Error', error: e.message, progress: 'Failed.' });
  }
});

// ── message routing ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'popup:start') {
    handlePopupStart().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'popup:get-state') {
    getActiveTab()
      .then((tab) => sendResponse({ ok: true, state: getState(tab.id), tabId: tab.id }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
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
      .catch((error) => {
        console.error('Capture loop failed:', error);
        updateState(tabId, { active: false, status: 'Error', error: error.message, progress: 'Failed.' });
      });
    return false;
  }
  if (message?.type === 'popup:start-with-region') {
    handleReuseRegion().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'selection:cancelled') {
    const tabId = sender.tab?.id;
    if (tabId) updateState(tabId, { active: false, status: 'Cancelled', progress: 'Selection cancelled.' });
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
  return false;
});

// ── popup start ────────────────────────────────────────────────

async function handlePopupStart() {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id);
  updateState(tab.id, { active: true, status: 'Selecting', progress: 'Drag a rectangle.' });
  await chrome.tabs.sendMessage(tab.id, {
    type: 'selection:start',
    lastRegion: getState(tab.id).lastRegion || undefined
  });
  return { ok: true };
}

async function handleReuseRegion() {
  const tab = await getActiveTab();
  const region = getState(tab.id).lastRegion;
  if (!region) throw new Error('No saved region. Select a region first.');
  if (tab.windowId == null || tab.windowId < 0) throw new Error('Invalid windowId.');
  await ensureContentScript(tab.id);
  // Get actual viewport dimensions from the content script
  const vp = await chrome.tabs.sendMessage(tab.id, { type: 'get-viewport' });
  const fullRegion = {
    ...region,
    viewportWidth: vp?.width || 1920,
    viewportHeight: vp?.height || 1080,
    devicePixelRatio: vp?.dpr || 1
  };
  // Run capture directly — no overlay needed
  runCaptureLoop(tab, fullRegion).catch((e) => {
    console.error('Reuse capture failed:', e);
    updateState(tab.id, { active: false, status: 'Error', error: e.message, progress: 'Failed.' });
  });
  return { ok: true };
}

async function handleStop() {
  const tab = await getActiveTab();
  const state = getState(tab.id);
  state.stopRequested = true;
  // Abort in-flight OCR AND translation so Stop responds immediately
  captureControllers.get(tab.id)?.abort();
  handleTranslateStop(tab.id);
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

  if (state.retryStage === 'translate') {
    const pendingText = state.pendingText;
    updateState(tab.id, { active: true, status: 'Translating', progress: 'Retrying translation...', error: '' });
    const result = await finalizeCapture(tab.id, pendingText, state.fragments || []);
    return { ok: true, result };
  }

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
  updateState(tab.id, { active: true, status: 'Capturing', progress: 'Retrying...', error: '' });
  await resumeCaptureLoop(rs);
  return { ok: true };
}

// ── manual translation (delegated to background so it survives popup close) ─

const translateControllers = new Map();
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

  // Abort any in-flight translation for this tab
  handleTranslateStop(tabId);

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId = null;

  try {
    translateControllers.set(tabId, controller);
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
      const key = `translatePrompt:${language}`;
      const stored = await chrome.storage.local.get(key);
      // "Original" with no custom prompt → pass through unchanged
      if (language === 'original' && !stored[key]) {
        const translated = text;
        await chrome.storage.local.set({ [`tl2Result:${tabId}`]: translated });
        chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: translated }).catch(() => {});
        if (translated) autoCopyIfEnabled(translated);
        if (translated) autoSaveIfEnabled(translated);
        return { ok: true };
      }
      const url = buildBackendEndpoint(host || DEFAULT_HOST, port || DEFAULT_PORT, `/translate?_=${Date.now()}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language, prompt: stored[key] || undefined }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (payload.error) throw new Error(payload.error);

      const translated = payload.text || '';
      await chrome.storage.local.set({ [`tl2Result:${tabId}`]: translated });
      chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: translated }).catch(() => {});
      // Auto-copy / auto-save translated text
      if (translated) autoCopyIfEnabled(translated);
      if (translated) autoSaveIfEnabled(translated);
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
    if (translateControllers.get(tabId) === controller) {
      translateControllers.delete(tabId);
      chrome.storage.local.remove(`tl2Translating:${tabId}`);
      chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: false }).catch(() => {});
    }
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
  const url = await getBackendEndpoint('/save');
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, path })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) return { ok: false, error: payload.error || `HTTP ${response.status}` };
  return { ok: true, path: payload.path || path };
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
  const winId = tab?.windowId;
  if (!tab?.id) throw new Error('Missing tab id.');
  if (winId == null || winId < 0) throw new Error('Invalid windowId for capture.');
  const tabId = tab.id;
  const state = getState(tabId);

  // Prevent concurrent captures on the same tab
  if (state.captureInFlight) throw new Error('Capture already in progress for this tab.');

  const normalizedRegion = normalizeRegion(region);
  if (normalizedRegion.width < 2 || normalizedRegion.height < 2) {
    throw new Error('Selected region is too small.');
  }

  // Set up abort controller so Stop can interrupt OCR/dedup
  const controller = new AbortController();
  captureControllers.set(tabId, controller);
  startKeepAlive();
  state.captureInFlight = true;

  try {
    resetState(tabId);
    updateState(tabId, { active: true, status: 'Capturing', progress: 'Starting capture loop.' });

    // Lock page scroll — user scrolling during autoscroll desyncs overlap tracking
    chrome.tabs.sendMessage(tab.id, { type: 'page:lock-scroll' }).catch(() => {});

    const fragments = [];
    let lastScrollY = -1;
    let atBottom = false;
    const { ocrAutoscroll } = await chrome.storage.sync.get({ ocrAutoscroll: true });

    while (true) {
      if (state.stopRequested) break;
      const pageNumber = fragments.length + 1;
      updateState(tabId, {
        currentPage: pageNumber,
        fragmentsCollected: fragments.length,
        progress: `Capturing page ${pageNumber}...`
      });

      const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });
      const croppedBlob = await cropVisibleCapture(dataUrl, normalizedRegion);

      updateState(tabId, { progress: `Sending page ${pageNumber} to OCR...` });
      let ocrErr = null;
      for (let attempt = 1; ; attempt++) {
        try {
          const text = await postImageForOcr(croppedBlob, pageNumber, controller.signal);
          fragments.push(text);
          ocrErr = null;
          break;
        } catch (e) {
          if (state.stopRequested) { ocrErr = null; break; }  // user Stop only — not timeout
          ocrErr = e;
          updateState(tabId, { progress: `Retrying page ${pageNumber} (attempt ${attempt + 1})...` });
          await sleep(2000);
        }
      }
      if (ocrErr) {
        // Should never reach here with infinite retry, but guard anyway
        state.retryState = { tab, region: normalizedRegion, winId, fragments, lastScrollY };
        chrome.storage.local.set({ [`retryState:${tabId}`]: state.retryState }).catch(() => {});
        updateState(tabId, {
          active: true,
          status: 'Error',
          error: ocrErr.message,
          progress: `Failed on page ${pageNumber}. Click Retry to continue.`,
          fragmentsCollected: fragments.length
        });
        chrome.storage.local.set({ [`lastStatus:${tabId}`]: 'Error' }).catch(() => {});
        return;
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

      if (atBottom) break;

      const scrollResult = await chrome.tabs.sendMessage(tab.id, {
        type: 'page:scroll-down',
        overlapPx: OVERLAP_PX
      });

      if (scrollResult?.atBottom) {
        if (!scrollResult.changed && fragments.length > 0) break;
        atBottom = true; continue;
      }
      lastScrollY = scrollResult.scrollY;
    }

    const mergedText = mergeFragments(fragments);
    if (state.stopRequested) {
      // User stopped — skip dedup/translate, finalize raw text immediately
      await finalizeCapture(tabId, mergedText, fragments);
    } else {
      updateState(tabId, {
        progress: 'Deduplicating merged text...',
        fragments
      });
      await finalizePostCapture(tabId, mergedText, fragments);
    }
  } finally {
    state.captureInFlight = false;
    captureControllers.delete(tabId);
    if (captureControllers.size === 0 && translateControllers.size === 0) stopKeepAlive();
    // Unlock page scroll
    chrome.tabs.sendMessage(tab.id, { type: 'page:unlock-scroll' }).catch(() => {});
  }
}

async function resumeCaptureLoop(rs) {
  const { tab, region, winId, fragments, lastScrollY } = rs;
  if (!tab?.id) throw new Error('Missing tab id.');
  const tabId = tab.id;
  const state = getState(tabId);

  // Prevent concurrent captures on the same tab
  if (state.captureInFlight) throw new Error('Capture already in progress for this tab.');
  state.captureInFlight = true;

  const controller = new AbortController();
  captureControllers.set(tabId, controller);
  startKeepAlive();

  try {
    // Lock page scroll — user scrolling during autoscroll desyncs overlap tracking
    chrome.tabs.sendMessage(tab.id, { type: 'page:lock-scroll' }).catch(() => {});

    let scrollY = lastScrollY;
    let atBottom = false;

    while (true) {
      if (state.stopRequested) break;
      // Check autoscroll setting
      const { ocrAutoscroll } = await chrome.storage.sync.get({ ocrAutoscroll: true });
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

      const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });
      const croppedBlob = await cropVisibleCapture(dataUrl, region);

      updateState(tabId, { progress: `Sending page ${pageNumber} to OCR...` });
      let ocrErr = null;
      for (let attempt = 1; ; attempt++) {
        try {
          const text = await postImageForOcr(croppedBlob, pageNumber, controller.signal);
          fragments.push(text);
          ocrErr = null;
          break;
        } catch (e) {
          if (state.stopRequested) { ocrErr = null; break; }  // user Stop only — not timeout
          ocrErr = e;
          updateState(tabId, { progress: `Retrying page ${pageNumber} (attempt ${attempt + 1})...` });
          await sleep(2000);
        }
      }
      if (ocrErr) {
        state.retryState = { tab, region, winId, fragments, lastScrollY: scrollY };
        chrome.storage.local.set({ [`retryState:${tabId}`]: state.retryState }).catch(() => {});
        updateState(tabId, {
          active: true,
          status: 'Error',
          error: ocrErr.message,
          progress: `Failed on page ${pageNumber}. Click Retry to continue.`,
          fragmentsCollected: fragments.length
        });
        chrome.storage.local.set({ [`lastStatus:${tabId}`]: 'Error' }).catch(() => {});
        return;
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

      if (atBottom) break;

      const scrollResult = await chrome.tabs.sendMessage(tab.id, {
        type: 'page:scroll-down',
        overlapPx: OVERLAP_PX
      });

      if (scrollResult?.atBottom) {
        if (!scrollResult.changed && fragments.length > 0) break;
        atBottom = true; continue;
      }
      scrollY = scrollResult.scrollY;
    }

    const mergedText = mergeFragments(fragments);
    if (state.stopRequested) {
      await finalizeCapture(tabId, mergedText, fragments);
    } else {
      updateState(tabId, { progress: 'Deduplicating merged text...', fragments });
      await finalizePostCapture(tabId, mergedText, fragments);
    }
  } finally {
    state.captureInFlight = false;
    captureControllers.delete(tabId);
    if (captureControllers.size === 0 && translateControllers.size === 0) stopKeepAlive();
    // Unlock page scroll
    chrome.tabs.sendMessage(tab.id, { type: 'page:unlock-scroll' }).catch(() => {});
  }
}

async function finalizePostCapture(tabId, mergedText, fragments) {
  const state = getState(tabId);
  // Save pre-dedup text for debugging
  chrome.storage.local.set({ [`preDedup:${tabId}`]: mergedText }).catch(() => {});
  const signal = captureControllers.get(tabId)?.signal;
  let finalText;
  for (let attempt = 1; ; attempt++) {
    try {
      finalText = await postTextForDedup(mergedText, signal);
      // Save post-dedup text for debugging
      chrome.storage.local.set({ [`postDedup:${tabId}`]: finalText }).catch(() => {});
      break;
    } catch (e) {
      if (state.stopRequested) { finalText = null; break; }
      updateState(tabId, { progress: `Retrying dedup (${attempt + 1})...` });
      await sleep(2000);
    }
  }

  if (!finalText) {
    // Stop requested during retry — finalize raw text
    await finalizeCapture(tabId, mergedText, fragments);
    return;
  }

  // Persist dedup-pending state so handleRetry can re-run dedup on failure
  state.retryStage = 'dedup';
  state.pendingText = mergedText;

  await finalizeCapture(tabId, finalText, fragments);
}

async function finalizeCapture(tabId, finalText, fragments) {
  const state = getState(tabId);
  state.retryStage = null;
  state.pendingText = '';

  updateState(tabId, {
    active: false,
    status: 'Done',
    currentPage: fragments.length,
    fragmentsCollected: fragments.length,
    progress: 'Finished.',
    fragments,
    mergedText: finalText
  });
  chrome.storage.local.set({ [`lastResult:${tabId}`]: finalText });
  chrome.storage.local.set({ [`lastStatus:${tabId}`]: 'Done' });

  // Auto-translate to Translation tab if enabled (skip if user stopped)
  if (!state.stopRequested) {
    await autoTranslateIfEnabled(tabId, finalText);
  }

  return finalText;
}

async function autoTranslateIfEnabled(tabId, originalText) {
  const { ocrAutoTranslate } = await chrome.storage.sync.get({
    ocrAutoTranslate: false
  });
  if (!ocrAutoTranslate) return;

  // Read language from Translation tab's per-tab setting
  const tl2LangKey = `tl2Language:${tabId}`;
  const tl2Lang = await chrome.storage.local.get(tl2LangKey);
  const language = tl2Lang[tl2LangKey] || 'original';
  // "Original" with no custom prompt → skip (nothing to do)
  if (language === 'original') {
    const promptKey = 'translatePrompt:original';
    const promptStored = await chrome.storage.local.get(promptKey);
    if (!promptStored[promptKey]) return;
  }

  // Abort any in-flight translation for this tab
  handleTranslateStop(tabId);

  const controller = new AbortController();
  translateControllers.set(tabId, controller);
  let timedOut = false;
  const timeoutId = setTimeout(() => {
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
  try {
    const key = `translatePrompt:${language}`;
    const stored = await chrome.storage.local.get(key);
    const url = await getBackendEndpoint('/translate');
    const response = await fetch(url + '?_=' + Date.now(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: originalText, language, prompt: stored[key] || undefined }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (payload.error) throw new Error(payload.error);
    const translated = payload.text || '';
    updateState(tabId, { tl2Translating: false });
    await chrome.storage.local.set({ [`tl2Result:${tabId}`]: translated });
    chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: translated }).catch(() => {});
    // Auto-copy / auto-save translated text
    if (translated) autoCopyIfEnabled(translated);
    if (translated) autoSaveIfEnabled(translated);
  } catch (e) {
    if (e.name === 'AbortError' && !timedOut) return; // User clicked Stop — silent
    console.error('Auto-translate failed:', e);
    const errorMessage = timedOut ? 'Translation timed out.' : (e.message || 'Translation failed.');
    await chrome.storage.local.set({ [`tl2Status:${tabId}`]: errorMessage });
    updateState(tabId, { tl2Translating: false });
    chrome.storage.local.remove(`tl2Translating:${tabId}`);
    chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: '', error: errorMessage }).catch(() => {});
  } finally {
    clearTimeout(timeoutId);
    if (translateControllers.get(tabId) === controller) {
      translateControllers.delete(tabId);
      chrome.storage.local.remove(`tl2Translating:${tabId}`);
      chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: false }).catch(() => {});
    }
  }
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

async function postImageForOcr(blob, pageNumber, signal) {
  const formData = new FormData();
  formData.append('image', blob, `page-${String(pageNumber).padStart(4, '0')}.png`);

  const url = await getBackendEndpoint('/ocr');
  const response = await fetchWithTimeout(url, { method: 'POST', body: formData }, signal);

  if (!response.ok) {
    throw new Error(`OCR HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const payload = await response.json().catch(() => {
      throw new Error('OCR backend returned invalid JSON.');
    });
    const t = payload.text ?? payload.result ?? payload.content ?? '';
    if (payload.error) throw new Error(`OCR backend error: ${payload.error}`);
    return String(t).trim();
  }
  return (await response.text()).trim();
}

async function postTextForDedup(text, signal) {
  const url = await getBackendEndpoint('/dedup');
  const response = await fetchWithTimeout(url + '?_=' + Date.now(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  }, signal);

  if (!response.ok) {
    throw new Error(`Dedup HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  const payload = await response.json().catch(() => {
    throw new Error('Dedup backend returned invalid JSON.');
  });
  if (payload.error) throw new Error(`Dedup backend error: ${payload.error}`);
  return String(payload.text ?? '').trim();
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
  return pLines.concat(nLines.slice(overlap)).join('\n').trim();
}

function findLineOverlap(pLines, nLines) {
  const max = Math.min(pLines.length, nLines.length);
  for (let len = max; len > 0; len--) {
    const suffix = pLines.slice(-len).map(normalizeLine);
    const prefix = nLines.slice(0, len).map(normalizeLine);
    if (suffix.every((l, i) => l === prefix[i])) return len;
  }
  return findLcsPrefixOverlap(pLines, nLines);
}

function findLcsPrefixOverlap(pLines, nLines) {
  const tail = pLines.slice(-20).map(normalizeLine);
  const head = nLines.slice(0, 20).map(normalizeLine);
  let best = 0;
  for (let s = 0; s < tail.length; s++) {
    let m = 0;
    for (let i = s, j = 0; i < tail.length && j < head.length; i++, j++) {
      if (tail[i] === head[j]) m++;
    }
    if (m >= 2 && m > best) best = m;
  }
  return best;
}

function normalizeText(t) {
  return String(t || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function splitLines(t) {
  return normalizeText(t).split('\n').map((l) => l.trim()).filter(Boolean);
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
    pendingText: ''
  });
  broadcastState(tabId);
  // Clear stale stored result/status so popup init() doesn't reload old capture
  chrome.storage.local.remove([
    `lastResult:${tabId}`,
    `lastStatus:${tabId}`,
    `retryState:${tabId}`,
    `tl2Result:${tabId}`,
    `tl2Status:${tabId}`,
    `preDedup:${tabId}`,
    `postDedup:${tabId}`
  ]).catch(() => {});
}

async function copyToClipboard(text) {
  if (!text) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD', 'DOM_PARSER'],
      justification: 'Clipboard and download access for OCR results'
    });
  } catch (e) {
    // Document may already exist — that's fine
  }
  chrome.runtime.sendMessage({ type: 'offscreen:copy', text }).catch(() => {});
  // Close the offscreen document after the copy completes so it doesn't block
  // future offscreen operations (MV3 allows only one at a time).
  setTimeout(() => {
    chrome.offscreen.closeDocument().catch(() => {});
  }, 2000);
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
  // Use offscreen clipboard so it works from service worker
  copyToClipboard(text);
  // Notify user
  chrome.notifications.create('auto-copy', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'AI OCR — Copied',
    message: 'Translation copied to system clipboard.',
    priority: 0
  });
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
      title: 'AI OCR — Saved',
      message: `Translation saved to ${result.path || tl2AutoSavePath}.`,
      priority: 0
    });
  } catch (e) {
    console.error('Auto-save failed:', e);
    chrome.notifications.create('auto-save-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'AI OCR — Save failed',
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

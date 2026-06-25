
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8765;
const DEFAULT_LANGUAGE = 'original';
const OVERLAP_PX = 50;
const AFTER_SEND_DELAY_MS = 0;

async function getBackendEndpoint(path) {
  const items = await chrome.storage.sync.get({ ocrHost: DEFAULT_HOST, ocrPort: DEFAULT_PORT });
  return `http://${items.ocrHost}:${items.ocrPort}${path}`;
}

let states = new Map();
let savedLastRegion = null;

function getState(tabId) {
  if (!states.has(tabId)) {
    states.set(tabId, {
      active: false, status: 'Idle', currentPage: 0, fragmentsCollected: 0,
      progress: 'Ready', mergedText: '', fragments: [], error: '',
      lastRegion: savedLastRegion, stopRequested: false, retryState: null,
      retryStage: null, pendingText: ''
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
// ── keyboard shortcut ──────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-region-capture') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return;
    }
    await ensureContentScript(tab.id);

    resetState(tab.id);
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
    // Remember region for reuse
    const { x, y, width, height } = message.region;
    const saved = { x, y, width, height };
    chrome.storage.local.set({ lastRegion: saved });
    savedLastRegion = saved;
    states.forEach((state) => { state.lastRegion = saved; });
    broadcastState(tabId);
    runCaptureLoop(sender.tab, message.region)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error('Capture loop failed:', error);
        updateState(tabId, { active: false, status: 'Error', error: error.message, progress: 'Failed.' });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
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
  return false;
});

// ── popup start ────────────────────────────────────────────────

async function handlePopupStart() {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id);
  resetState(tab.id);
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
  // If in error state (waiting for retry), finalize collected fragments now
  if (state.status === 'Error' && state.fragments?.length > 0) {
    finalizePostCapture(tab.id, mergeFragments(state.fragments), state.fragments);
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

  if (state.retryStage === 'translate') {
    const pendingText = state.pendingText;
    updateState(tab.id, { active: true, status: 'Translating', progress: 'Retrying translation...', error: '' });
    const result = await finalizeCapture(tab.id, pendingText, state.fragments || []);
    return { ok: true, result };
  }

  const rs = state.retryState;
  if (!rs) throw new Error('No retry state saved.');
  state.retryState = null;
  updateState(tab.id, { active: true, status: 'Capturing', progress: 'Retrying...', error: '' });
  await resumeCaptureLoop(rs);
  return { ok: true };
}

// ── manual translation (delegated to background so it survives popup close) ─

const translateControllers = new Map();

async function handleTranslateStart(msg) {
  const { tabId, text, language, host, port } = msg;
  if (!tabId || !text) return { ok: false, error: 'Missing tabId or text' };

  // Abort any in-flight translation for this tab
  handleTranslateStop(tabId);

  const controller = new AbortController();
  translateControllers.set(tabId, controller);

  // Client-side safety timeout
  const TIMEOUT_MS = 12 * 60 * 1000;
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Persist state so popup reopen shows "Stop" button.
  // Clear any stale result so init() doesn't mistake an old result
  // for a just-completed translation.
  await chrome.storage.local.set({
    [`tl2Translating:${tabId}`]: true,
    [`tl2Progress:${tabId}`]: `Translating to ${language}...`
  });
  await chrome.storage.local.remove(`tl2Result:${tabId}`);
  chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: true }).catch(() => {});

  try {
    const key = `translatePrompt:${language}`;
    const stored = await chrome.storage.local.get(key);
    const url = `http://${host || 'localhost'}:${port || 8765}/translate?_=${Date.now()}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language, prompt: stored[key] || undefined }),
      signal: controller.signal
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (payload.error) throw new Error(payload.error);

    chrome.storage.local.set({ [`tl2Result:${tabId}`]: payload.text || '' });
    chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: payload.text || '' }).catch(() => {});
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: '' }).catch(() => {});
    // Clear translating state so the popup doesn't reopen stuck on "Stop"
    chrome.storage.local.remove(`tl2Translating:${tabId}`);
    chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: false }).catch(() => {});
  } finally {
    clearTimeout(timeoutId);
    translateControllers.delete(tabId);
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

  const normalizedRegion = normalizeRegion(region);
  if (normalizedRegion.width < 2 || normalizedRegion.height < 2) {
    throw new Error('Selected region is too small.');
  }

  resetState(tabId);
  updateState(tabId, { active: true, status: 'Capturing', progress: 'Starting capture loop.' });

  const fragments = [];
  let lastScrollY = -1;
  const { ocrAutoscroll } = await chrome.storage.sync.get({ ocrAutoscroll: true });

  while (true) {
    if (state.stopRequested) {
      await finalizePostCapture(tabId, mergeFragments(fragments), fragments);
      return;
    }
    const pageNumber = fragments.length + 1;
    updateState(tabId, {
      currentPage: pageNumber,
      fragmentsCollected: fragments.length,
      progress: `Capturing page ${pageNumber}...`
    });

    const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });
    const croppedBlob = await cropVisibleCapture(dataUrl, normalizedRegion);

    updateState(tabId, { progress: `Sending page ${pageNumber} to OCR...` });
    try {
      const text = await postImageForOcr(croppedBlob, pageNumber);
      fragments.push(text);
    } catch (e) {
      // Save retry state so user can resume
      state.retryState = { tab, region: normalizedRegion, winId, fragments, lastScrollY };
      updateState(tabId, {
        active: true,
        status: 'Error',
        error: e.message,
        progress: `Failed on page ${pageNumber}. Click Retry to continue.`,
        mergedText: mergeFragments(fragments),
        fragmentsCollected: fragments.length
      });
      return;
    }

    updateState(tabId, {
      fragments,
      fragmentsCollected: fragments.length,
      mergedText: mergeFragments(fragments),
      progress: `Collected ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}.`
    });

    await sleep(AFTER_SEND_DELAY_MS);

    if (!ocrAutoscroll) break;

    const scrollResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'page:scroll-down',
      overlapPx: OVERLAP_PX
    });

    if (!scrollResult?.changed || scrollResult.scrollY === lastScrollY) break;
    lastScrollY = scrollResult.scrollY;
  }

  const mergedText = mergeFragments(fragments);
  updateState(tabId, {
    progress: 'Deduplicating merged text...',
    fragments,
    mergedText
  });
  await finalizePostCapture(tabId, mergedText, fragments);
}

async function resumeCaptureLoop(rs) {
  const { tab, region, winId, fragments, lastScrollY } = rs;
  if (!tab?.id) throw new Error('Missing tab id.');
  const tabId = tab.id;
  const state = getState(tabId);
  let scrollY = lastScrollY;

  while (true) {
    if (state.stopRequested) {
      await finalizePostCapture(tabId, mergeFragments(fragments), fragments);
      return;
    }
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
    try {
      const text = await postImageForOcr(croppedBlob, pageNumber);
      fragments.push(text);
    } catch (e) {
      state.retryState = { tab, region, winId, fragments, lastScrollY: scrollY };
      updateState(tabId, {
        active: true,
        status: 'Error',
        error: e.message,
        progress: `Failed on page ${pageNumber}. Click Retry to continue.`,
        mergedText: mergeFragments(fragments),
        fragmentsCollected: fragments.length
      });
      return;
    }

    updateState(tabId, {
      fragments,
      fragmentsCollected: fragments.length,
      mergedText: mergeFragments(fragments),
      progress: `Collected ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}.`
    });

    await sleep(AFTER_SEND_DELAY_MS);

    if (!ocrAutoscroll) break;

    const scrollResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'page:scroll-down',
      overlapPx: OVERLAP_PX
    });

    if (!scrollResult?.changed || scrollResult.scrollY === scrollY) break;
    scrollY = scrollResult.scrollY;
  }

  const mergedText = mergeFragments(fragments);
  updateState(tabId, { progress: 'Deduplicating merged text...', fragments, mergedText });
  await finalizePostCapture(tabId, mergedText, fragments);
}

async function finalizePostCapture(tabId, mergedText, fragments) {
  const state = getState(tabId);
  let finalText;
  try {
    finalText = await postTextForDedup(mergedText);
  } catch (e) {
    console.error('Dedup failed:', e);
    state.retryStage = 'dedup';
    state.pendingText = mergedText;
    chrome.storage.local.set({ [`lastResult:${tabId}`]: mergedText });
    updateState(tabId, {
      active: true,
      status: 'Error',
      error: 'Dedup failed. Click Retry.',
      progress: 'Dedup failed. Click Retry.',
      fragments,
      mergedText,
      fragmentsCollected: fragments.length
    });
    return;
  }

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
  const { ocrAutoCopy } = await chrome.storage.sync.get({ ocrAutoCopy: true });
  if (ocrAutoCopy) copyToClipboard(finalText);

  // Auto-translate to Translation tab if enabled
  await autoTranslateIfEnabled(tabId, finalText);

  return finalText;
}

async function autoTranslateIfEnabled(tabId, originalText) {
  const { ocrAutoTranslate, ocrLanguage } = await chrome.storage.sync.get({
    ocrAutoTranslate: false, ocrLanguage: 'original'
  });
  if (!ocrAutoTranslate || ocrLanguage === 'original') return;

  updateState(tabId, { tl2Translating: true });
  await chrome.storage.local.set({
    [`tl2Translating:${tabId}`]: true,
    [`tl2Progress:${tabId}`]: `Translating to ${ocrLanguage}...`
  });
  await chrome.storage.local.remove(`tl2Result:${tabId}`);
  chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: true }).catch(() => {});
  try {
    const key = `translatePrompt:${ocrLanguage}`;
    const stored = await chrome.storage.local.get(key);
    const url = await getBackendEndpoint('/translate');
    const response = await fetch(url + '?_=' + Date.now(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: originalText, language: ocrLanguage, prompt: stored[key] || undefined })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const translated = payload.text || '';
    updateState(tabId, { tl2Translating: false });
    chrome.storage.local.set({ [`tl2Result:${tabId}`]: translated });
    chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: translated }).catch(() => {});
  } catch (e) {
    console.error('Auto-translate failed:', e);
    updateState(tabId, { tl2Translating: false });
    chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: '' }).catch(() => {});
  }
}

// ── crop ───────────────────────────────────────────────────────

async function cropVisibleCapture(dataUrl, region) {
  const imageBitmap = await createImageBitmap(await dataUrlToBlob(dataUrl));
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
  ctx.drawImage(imageBitmap, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  imageBitmap.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

// ── OCR call ───────────────────────────────────────────────────

async function postImageForOcr(blob, pageNumber) {
  const formData = new FormData();
  formData.append('image', blob, `page-${String(pageNumber).padStart(4, '0')}.png`);

  const url = await getBackendEndpoint('/ocr');
  const response = await fetch(url, { method: 'POST', body: formData });

  if (!response.ok) {
    throw new Error(`OCR HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const payload = await response.json();
    const t = payload.text ?? payload.result ?? payload.content ?? '';
    if (payload.error) throw new Error(`OCR backend error: ${payload.error}`);
    return String(t).trim();
  }
  return (await response.text()).trim();
}

async function postTextForDedup(text) {
  const url = await getBackendEndpoint('/dedup');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    throw new Error(`Dedup HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  const payload = await response.json();
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

async function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then((r) => r.blob());
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
}

async function copyToClipboard(text) {
  if (!text) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy OCR result to clipboard'
    });
  } catch (e) {
    // Document may already exist — that's fine
  }
  chrome.runtime.sendMessage({ type: 'offscreen:copy', text }).catch(() => {});
}

function updateState(tabId, partial) {
  Object.assign(getState(tabId), partial);
  broadcastState(tabId);
}

function broadcastState(tabId) {
  chrome.runtime.sendMessage({ type: 'state:update', tabId, state: getState(tabId) }).catch(() => {});
}

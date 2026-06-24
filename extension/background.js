
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8000;
const DEFAULT_LANGUAGE = 'original';
const OVERLAP_PX = 50;
const AFTER_SEND_DELAY_MS = 200;

async function getBackendEndpoint(path) {
  const items = await chrome.storage.sync.get({ ocrHost: DEFAULT_HOST, ocrPort: DEFAULT_PORT });
  return `http://${items.ocrHost}:${items.ocrPort}${path}`;
}

const state = {
  active: false,
  status: 'Idle',
  currentPage: 0,
  fragmentsCollected: 0,
  progress: 'Ready',
  mergedText: '',
  fragments: [],
  error: '',
  lastRegion: null,
  stopRequested: false,
  retryState: null,
  retryStage: null,
  pendingText: ''
};

// Load saved region on startup
chrome.storage.local.get('lastRegion', (items) => {
  if (items.lastRegion) state.lastRegion = items.lastRegion;
});
// Restore last result from previous session
chrome.storage.local.get('lastResult', (items) => {
  if (items.lastResult) state.mergedText = items.lastResult;
});

// ── keyboard shortcut ──────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-region-capture') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      updateState({ status: 'Error', error: 'No active tab found.' });
      return;
    }
    await ensureContentScript(tab.id);

    resetState();
    updateState({ active: true, status: 'Selecting', progress: 'Drag a rectangle.' });
    await chrome.tabs.sendMessage(tab.id, {
      type: 'selection:start',
      lastRegion: state.lastRegion || undefined
    });
  } catch (e) {
    console.error('Command handler failed:', e);
    updateState({ active: false, status: 'Error', error: e.message, progress: 'Failed.' });
  }
});

// ── message routing ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'popup:start') {
    handlePopupStart().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'popup:get-state') {
    sendResponse({ ok: true, state });
    return false;
  }
  if (message?.type === 'selection:complete') {
    // Remember region for reuse
    const { x, y, width, height } = message.region;
    const saved = { x, y, width, height };
    chrome.storage.local.set({ lastRegion: saved });
    state.lastRegion = saved;
    broadcastState();
    runCaptureLoop(sender.tab, message.region)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error('Capture loop failed:', error);
        updateState({ active: false, status: 'Error', error: error.message, progress: 'Failed.' });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (message?.type === 'popup:start-with-region') {
    handleReuseRegion().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'selection:cancelled') {
    updateState({ active: false, status: 'Cancelled', progress: 'Selection cancelled.' });
    return false;
  }
  if (message?.type === 'popup:stop') {
    state.stopRequested = true;
    // If in error state (waiting for retry), finalize collected fragments now
    if (state.status === 'Error' && state.fragments?.length > 0) {
      finalizePostCapture(mergeFragments(state.fragments), state.fragments);
    } else {
      updateState({ progress: 'Stopping...' });
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'popup:retry') {
    handleRetry().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

// ── popup start ────────────────────────────────────────────────

async function handlePopupStart() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  await ensureContentScript(tab.id);
  resetState();
  updateState({ active: true, status: 'Selecting', progress: 'Drag a rectangle.' });
  await chrome.tabs.sendMessage(tab.id, {
    type: 'selection:start',
    lastRegion: state.lastRegion || undefined
  });
  return { ok: true };
}

async function handleReuseRegion() {
  const region = state.lastRegion;
  if (!region) throw new Error('No saved region. Select a region first.');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
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
    updateState({ active: false, status: 'Error', error: e.message, progress: 'Failed.' });
  });
  return { ok: true };
}

async function handleRetry() {
  if (state.retryStage === 'dedup') {
    const pendingText = state.pendingText;
    updateState({ active: true, status: 'Deduplicating', progress: 'Retrying dedup...', error: '' });
    await finalizePostCapture(pendingText, state.fragments || []);
    return { ok: true };
  }

  if (state.retryStage === 'translate') {
    const pendingText = state.pendingText;
    updateState({ active: true, status: 'Translating', progress: 'Retrying translation...', error: '' });
    const translatedText = await retryTranslateAndFinalize(pendingText, state.fragments || []);
    return { ok: true, translatedText };
  }

  const rs = state.retryState;
  if (!rs) throw new Error('No retry state saved.');
  state.retryState = null;
  updateState({ active: true, status: 'Capturing', progress: 'Retrying...', error: '' });
  await resumeCaptureLoop(rs);
  return { ok: true };
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
    console.debug('ensureContentScript inject skipped:', e.message);
  }
}

// ── capture loop ───────────────────────────────────────────────

async function runCaptureLoop(tab, region) {
  const winId = tab?.windowId;
  if (!tab?.id) throw new Error('Missing tab id.');
  if (winId == null || winId < 0) throw new Error('Invalid windowId for capture.');

  const normalizedRegion = normalizeRegion(region);
  if (normalizedRegion.width < 2 || normalizedRegion.height < 2) {
    throw new Error('Selected region is too small.');
  }

  resetState();
  updateState({ active: true, status: 'Capturing', progress: 'Starting capture loop.' });

  const fragments = [];
  let lastScrollY = -1;

  while (true) {
    if (state.stopRequested) {
      await finalizePostCapture(mergeFragments(fragments), fragments);
      return;
    }
    // Check autoscroll setting
    const { ocrAutoscroll } = await chrome.storage.sync.get({ ocrAutoscroll: true });
    if (!ocrAutoscroll && fragments.length > 0) {
      updateState({ progress: 'Single capture complete (autoscroll off).' });
      break;
    }
    const pageNumber = fragments.length + 1;
    updateState({
      currentPage: pageNumber,
      fragmentsCollected: fragments.length,
      progress: `Capturing page ${pageNumber}...`
    });

    const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });
    const croppedBlob = await cropVisibleCapture(dataUrl, normalizedRegion);

    updateState({ progress: `Sending page ${pageNumber} to OCR...` });
    try {
      const text = await postImageForOcr(croppedBlob, pageNumber);
      fragments.push(text);
    } catch (e) {
      // Save retry state so user can resume
      state.retryState = { tab, region: normalizedRegion, winId, fragments, lastScrollY };
      updateState({
        active: true,
        status: 'Error',
        error: e.message,
        progress: `Failed on page ${pageNumber}. Click Retry to continue.`,
        mergedText: mergeFragments(fragments),
        fragmentsCollected: fragments.length
      });
      return;
    }

    updateState({
      fragments,
      fragmentsCollected: fragments.length,
      mergedText: mergeFragments(fragments),
      progress: `Collected ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}.`
    });

    await sleep(AFTER_SEND_DELAY_MS);

    const scrollResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'page:scroll-down',
      overlapPx: OVERLAP_PX
    });

    if (!scrollResult?.changed || scrollResult.scrollY === lastScrollY) break;
    lastScrollY = scrollResult.scrollY;
  }

  const mergedText = mergeFragments(fragments);
  updateState({
    progress: 'Deduplicating merged text...',
    fragments,
    mergedText
  });
  await finalizePostCapture(mergedText, fragments);
}

async function resumeCaptureLoop(rs) {
  const { tab, region, winId, fragments, lastScrollY } = rs;
  let scrollY = lastScrollY;

  while (true) {
    if (state.stopRequested) {
      await finalizePostCapture(mergeFragments(fragments), fragments);
      return;
    }
    // Check autoscroll setting
    const { ocrAutoscroll } = await chrome.storage.sync.get({ ocrAutoscroll: true });
    if (!ocrAutoscroll && fragments.length > 0) {
      updateState({ progress: 'Single capture complete (autoscroll off).' });
      break;
    }
    const pageNumber = fragments.length + 1;
    updateState({
      currentPage: pageNumber,
      fragmentsCollected: fragments.length,
      progress: `Capturing page ${pageNumber}...`
    });

    const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });
    const croppedBlob = await cropVisibleCapture(dataUrl, region);

    updateState({ progress: `Sending page ${pageNumber} to OCR...` });
    try {
      const text = await postImageForOcr(croppedBlob, pageNumber);
      fragments.push(text);
    } catch (e) {
      state.retryState = { tab, region, winId, fragments, lastScrollY: scrollY };
      updateState({
        active: true,
        status: 'Error',
        error: e.message,
        progress: `Failed on page ${pageNumber}. Click Retry to continue.`,
        mergedText: mergeFragments(fragments),
        fragmentsCollected: fragments.length
      });
      return;
    }

    updateState({
      fragments,
      fragmentsCollected: fragments.length,
      mergedText: mergeFragments(fragments),
      progress: `Collected ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}.`
    });

    await sleep(AFTER_SEND_DELAY_MS);

    const scrollResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'page:scroll-down',
      overlapPx: OVERLAP_PX
    });

    if (!scrollResult?.changed || scrollResult.scrollY === scrollY) break;
    scrollY = scrollResult.scrollY;
  }

  const mergedText = mergeFragments(fragments);
  updateState({ progress: 'Deduplicating merged text...', fragments, mergedText });
  await finalizePostCapture(mergedText, fragments);
}

async function finalizePostCapture(mergedText, fragments) {
  let finalText;
  try {
    finalText = await postTextForDedup(mergedText);
  } catch (e) {
    console.error('Dedup failed:', e);
    state.retryStage = 'dedup';
    state.pendingText = mergedText;
    chrome.storage.local.set({ lastResult: mergedText });
    updateState({
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

  await retryTranslateAndFinalize(finalText, fragments);
}

async function retryTranslateAndFinalize(finalText, fragments) {
  let translatedText;
  try {
    state.retryStage = null;
    state.pendingText = '';
    translatedText = await translateIfNeeded(finalText);
  } catch (e) {
    console.error('Translation failed:', e);
    state.retryStage = 'translate';
    state.pendingText = finalText;
    chrome.storage.local.set({ lastResult: finalText });
    updateState({
      active: true,
      status: 'Error',
      error: 'Translation failed. Click Retry.',
      progress: 'Translation failed. Click Retry.',
      fragments,
      mergedText: finalText,
      fragmentsCollected: fragments.length
    });
    return null;
  }

  state.retryStage = null;
  state.pendingText = '';
  updateState({
    active: false,
    status: 'Done',
    currentPage: fragments.length,
    fragmentsCollected: fragments.length,
    progress: 'Finished.',
    fragments,
    mergedText: translatedText
  });
  chrome.storage.local.set({ lastResult: translatedText });
  return translatedText;
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

async function translateIfNeeded(text) {
  const items = await chrome.storage.sync.get({ ocrLanguage: DEFAULT_LANGUAGE });
  const language = items.ocrLanguage || DEFAULT_LANGUAGE;
  if (language === DEFAULT_LANGUAGE) return text;

  updateState({ progress: `Translating to ${language}...` });
  return postTextForTranslation(text, language);
}

async function postTextForTranslation(text, language) {
  const url = await getBackendEndpoint('/translate');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language })
  });

  if (!response.ok) {
    throw new Error(`Translate HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }

  const payload = await response.json();
  if (payload.error) throw new Error(`Translate backend error: ${payload.error}`);
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

function resetState() {
  Object.assign(state, { active: false, status: 'Idle', currentPage: 0, fragmentsCollected: 0,
    progress: 'Ready', fragments: [], error: '', stopRequested: false,
    retryState: null, retryStage: null, pendingText: '' });
  broadcastState();
}

function updateState(partial) {
  Object.assign(state, partial);
  broadcastState();
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'state:update', state }).catch(() => {});
}

// ── OCR panel elements ────────────────────────────────────────
const statusEl = document.getElementById('status');
const currentPageEl = document.getElementById('current-page');
const fragmentsEl = document.getElementById('fragments');
const shortProgressEl = document.getElementById('short-progress');
const progressEl = document.getElementById('progress');
const resultEl = document.getElementById('result');
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const retryButton = document.getElementById('retry');
const copyButton = document.getElementById('copy');
const downloadButton = document.getElementById('download');
const hostInput = document.getElementById('ocr-host');
const portInput = document.getElementById('ocr-port');
const autoscrollCheckbox = document.getElementById('ocr-autoscroll');
const lastRegionEl = document.getElementById('last-region');

// ── Translate panel elements ──────────────────────────────────
const tlLanguage = document.getElementById('tl-language');
const translatePrompt = document.getElementById('translate-prompt');

// ── OCR/Dedup prompt elements ─────────────────────────────────
const ocrPromptEl = document.getElementById('ocr-prompt');
const dedupPromptEl = document.getElementById('dedup-prompt');

// ── Translation panel elements ────────────────────────────────
const tl2Language = document.getElementById('tl2-language');
const tl2StatusText = document.getElementById('tl2-status-text');
const tl2Result = document.getElementById('tl2-result');
const tl2Translate = document.getElementById('tl2-translate');
const tl2Copy = document.getElementById('tl2-copy');
const tl2Save = document.getElementById('tl2-save');
const tl2Download = document.getElementById('tl2-download');
const tl2AutocopyCheckbox = document.getElementById('tl2-autocopy');
const tl2AutosaveCheckbox = document.getElementById('tl2-autosave');
const tl2AutotranslateCheckbox = document.getElementById('tl2-autotranslate');
const tl2AutosavePath = document.getElementById('tl2-autosave-path');
const tl2PathSuggestions = document.getElementById('tl2-path-suggestions');

// ── Format panel elements ─────────────────────────────────────
const formatPrompt = document.getElementById('format-prompt');
const fmtStatusText = document.getElementById('fmt-status-text');
const fmtResult = document.getElementById('fmt-result');
const fmtFormat = document.getElementById('fmt-format');
const fmtCopy = document.getElementById('fmt-copy');
const fmtSave = document.getElementById('fmt-save');
const fmtDownload = document.getElementById('fmt-download');
const fmtSavePath = document.getElementById('fmt-save-path');
const fmtAutocopy = document.getElementById('fmt-autocopy');
const fmtAutosave = document.getElementById('fmt-autosave');
const fmtAutoformat = document.getElementById('fmt-autoformat');
const fmtSource = document.getElementById('fmt-source');

// ── Tab state ─────────────────────────────────────────────────
const tabs = document.querySelectorAll('.tab');
const panels = {
  'ocr-panel': document.getElementById('ocr-panel'),
  'translate-panel': document.getElementById('translate-panel'),
  'translation-panel': document.getElementById('translation-panel'),
  'format-panel': document.getElementById('format-panel')
};

let latestState = null;
let currentTabId = null;
let userEditedResult = false;
let lastStoredStatus = '';
const LOCAL_BACKEND_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// ── Tab switching ─────────────────────────────────────────────
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    Object.values(panels).forEach(p => p.classList.add('hidden'));
    panels[tab.dataset.panel].classList.remove('hidden');
  });
});

// ── OCR panel listeners ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    progressEl.textContent = `Initialization failed: ${error.message}`;
    setTl2Progress(`Initialization failed: ${error.message}`);
  });
});
startButton.addEventListener('click', startCapture);
stopButton.addEventListener('click', stopCapture);
retryButton.addEventListener('click', retryCapture);
copyButton.addEventListener('click', copyOcrText);
downloadButton.addEventListener('click', downloadOcrText);
resultEl.addEventListener('input', saveOcrText);
hostInput.addEventListener('change', saveSettings);
portInput.addEventListener('change', saveSettings);
autoscrollCheckbox.addEventListener('change', saveSettings);

// ── Translate panel listeners ─────────────────────────────────
tlLanguage.addEventListener('change', () => { onTlLanguageChange(); syncLanguage('prompt'); });
translatePrompt.addEventListener('input', saveTlState);

// ── Translation panel listeners ───────────────────────────────
tl2Translate.addEventListener('click', doTranslation);
tl2Copy.addEventListener('click', () => copyResult(tl2Result, tl2Copy));
tl2Download.addEventListener('click', () => downloadAsFile(tl2Result.value.trim(), 'translate'));
tl2Save.addEventListener('click', saveTranslation);
tl2Language.addEventListener('change', () => { saveTl2Language(); syncLanguage('translation'); });
tl2AutocopyCheckbox.addEventListener('change', saveTl2Settings);
tl2AutosaveCheckbox.addEventListener('change', saveTl2Settings);
tl2AutotranslateCheckbox.addEventListener('change', saveTl2Settings);
tl2AutosavePath.addEventListener('input', () => {
  saveTl2Settings();
  updatePathSuggestions(tl2AutosavePath.value);
});

// ── Format panel listeners ─────────────────────────────────────
fmtFormat.addEventListener('click', doFormat);
fmtCopy.addEventListener('click', () => copyResult(fmtResult, fmtCopy));
fmtDownload.addEventListener('click', () => downloadAsFile(fmtResult.value.trim(), 'format'));
fmtSave.addEventListener('click', saveFormatResult);
formatPrompt.addEventListener('input', saveFormatPrompt);
ocrPromptEl.addEventListener('input', saveOcrPrompt);
dedupPromptEl.addEventListener('input', saveDedupPrompt);
fmtSavePath.addEventListener('input', () => {
  saveFormatSettings();
  updatePathSuggestions(fmtSavePath.value);
});
fmtAutocopy.addEventListener('change', saveFormatSettings);
fmtAutosave.addEventListener('change', saveFormatSettings);
fmtAutoformat.addEventListener('change', saveFormatSettings);
fmtSource.addEventListener('change', () => { saveFormatSettings(); updateFormatButtons(); });

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state:update') {
    if (message.tabId !== currentTabId) return;
    renderState(message.state);
  }
  if (message?.type === 'translation:update') {
    if (message.tabId !== currentTabId) return;
    if (message.text) {
      tl2Result.value = message.text;
      chrome.storage.local.set({ [`tl2Result:${currentTabId}`]: message.text });
    }
    tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = !message.text;
    tl2Translate.textContent = 'Translate';
    tl2Translate.classList.remove('danger');
    chrome.storage.local.remove(`tl2Translating:${currentTabId}`);
    setTl2Progress(message.text ? 'Translation complete.' : (message.error || 'Translation failed.'));
    updateTranslationButtons();
    // Auto-copy / auto-save is handled by the background service worker
    // (autoCopyIfEnabled / autoSaveIfEnabled) — doing it here as well would
    // double-copy and double-save.
    // Auto-format is also handled by the background (autoFormatIfEnabled).
  }
  if (message?.type === 'tl2:translating') {
    if (message.tabId !== currentTabId) return;
    if (message.value) {
      tl2Translate.textContent = 'Stop';
      tl2Translate.classList.add('danger');
      tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = true;
      setTl2Progress('Translating...');
    } else {
      tl2Translate.textContent = 'Translate';
      tl2Translate.classList.remove('danger');
      updateTranslationButtons();
    }
  }
  if (message?.type === 'format:update') {
    if (message.tabId !== currentTabId) return;
    if (message.text) {
      fmtResult.value = message.text;
      chrome.storage.local.set({ [`fmtResult:${currentTabId}`]: message.text });
    }
    fmtCopy.disabled = fmtSave.disabled = fmtDownload.disabled = !message.text;
    fmtFormat.textContent = 'Format';
    fmtFormat.classList.remove('danger');
    chrome.storage.local.remove(`fmtFormatting:${currentTabId}`);
    setFmtProgress(message.text ? 'Formatting complete.' : (message.error || 'Formatting failed.'));
    updateFormatButtons();
    // Auto-copy / auto-save is handled by the background service worker
    // (fmtAutoCopyIfEnabled / fmtAutoSaveIfEnabled).
  }
  if (message?.type === 'fmt:formatting') {
    if (message.tabId !== currentTabId) return;
    if (message.value) {
      fmtFormat.textContent = 'Stop';
      fmtFormat.classList.add('danger');
      fmtCopy.disabled = fmtSave.disabled = fmtDownload.disabled = true;
      setFmtProgress('Formatting...');
    } else {
      fmtFormat.textContent = 'Format';
      fmtFormat.classList.remove('danger');
      updateFormatButtons();
    }
  }
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;

  const items = await chrome.storage.sync.get({
    ocrHost: 'localhost', ocrPort: 8765,
    ocrAutoscroll: true
  });
  hostInput.value = items.ocrHost;
  portInput.value = items.ocrPort;
  tlLanguage.value = tlLanguage.value || 'original';
  tl2Language.value = tl2Language.value || 'original';
  autoscrollCheckbox.checked = items.ocrAutoscroll;

  const resultKey = currentTabId ? `lastResult:${currentTabId}` : null;
  // Get live state first so renderState has the right mergedText
  await refreshState();
  // Always restore from storage if textarea is empty — survives popup close + SW restart
  if (!resultEl.value.trim() && resultKey) {
    const stored = await chrome.storage.local.get(resultKey);
    if (stored[resultKey]) resultEl.value = stored[resultKey];
  }

  // Load last persisted status for status bar
  const statusKey = currentTabId ? `lastStatus:${currentTabId}` : null;
  if (statusKey) {
    const { [statusKey]: storedStatus } = await chrome.storage.local.get(statusKey);
    if (storedStatus) lastStoredStatus = storedStatus;
  }

  // Load translate language and prompt
  const tl = await chrome.storage.local.get('tlLanguage');
  if (tl.tlLanguage) tlLanguage.value = tl.tlLanguage;
  await loadPromptForLanguage();

  // Load OCR and dedup prompts
  await loadOcrPrompt();
  await loadDedupPrompt();

  // Load Translation tab language and last result (per-tab) -- single atomic load
  const tl2k = (k) => currentTabId ? `${k}:${currentTabId}` : k;
  const tl2Keys = currentTabId ? [tl2k('tl2Language'), tl2k('tl2Result'), tl2k('tl2Status'), tl2k('tl2Translating')] : [];
  const tl2 = await chrome.storage.local.get(tl2Keys);
  if (tl2[tl2k('tl2Language')]) tl2Language.value = tl2[tl2k('tl2Language')];
  if (tl2[tl2k('tl2Result')]) { tl2Result.value = tl2[tl2k('tl2Result')]; tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = false; }
  if (tl2[tl2k('tl2Status')]) {
    // Clear stale "Translating..." state from previous session
    const p = tl2[tl2k('tl2Status')];
    if (p === 'Translating...') {
      tl2StatusText.textContent = 'Ready';
    } else {
      tl2StatusText.textContent = p;
    }
  }
  // Restore translating state from the same atomic load
  const wasTranslating = !!tl2[tl2k('tl2Translating')];
  const hasTl2Result = !!tl2[tl2k('tl2Result')];

  if (wasTranslating && hasTl2Result) {
    // Translation completed while popup was closed — show result
    tl2Translate.textContent = 'Translate';
    tl2Translate.classList.remove('danger');
    tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = false;
    chrome.storage.local.remove(tl2k('tl2Translating'));
    tl2StatusText.textContent = 'Completed while popup was closed';
  } else if (wasTranslating) {
    tl2Translate.textContent = 'Stop';
    tl2Translate.classList.add('danger');
    tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = true;
    tl2StatusText.textContent = 'Translating...';
  } else {
    tl2Translate.textContent = 'Translate';
    tl2Translate.classList.remove('danger');
    tl2StatusText.textContent = 'Ready';
  }
  updateTranslationButtons();

  // Load Translation tab settings (auto-copy, auto-save, auto-translate, auto-save-path)
  const tl2Settings = await chrome.storage.sync.get({
    tl2AutoCopy: false, tl2AutoSave: false,
    ocrAutoTranslate: false, tl2AutoSavePath: ''
  });
  tl2AutocopyCheckbox.checked = tl2Settings.tl2AutoCopy;
  tl2AutosaveCheckbox.checked = tl2Settings.tl2AutoSave;
  tl2AutotranslateCheckbox.checked = tl2Settings.ocrAutoTranslate;
  tl2AutosavePath.value = tl2Settings.tl2AutoSavePath || '';
  loadPathSuggestions();

  // Load Format tab prompt and last result (per-tab) — single atomic load
  const fmtSaveSettings = await chrome.storage.sync.get({ fmtSavePath: '', fmtAutoCopy: false, fmtAutoSave: false, fmtAutoFormat: false, fmtSourceVal: 'translation' });
  if (fmtSaveSettings.fmtSavePath) fmtSavePath.value = fmtSaveSettings.fmtSavePath;
  fmtAutocopy.checked = fmtSaveSettings.fmtAutoCopy;
  fmtAutosave.checked = fmtSaveSettings.fmtAutoSave;
  fmtAutoformat.checked = fmtSaveSettings.fmtAutoFormat;
  if (fmtSaveSettings.fmtSourceVal) fmtSource.value = fmtSaveSettings.fmtSourceVal;
  const fmtk = (k) => currentTabId ? `${k}:${currentTabId}` : k;
  const fmtKeys = currentTabId ? [fmtk('fmtResult'), fmtk('fmtStatus'), fmtk('fmtFormatting'), 'formatPrompt'] : ['formatPrompt'];
  const fmt = await chrome.storage.local.get(fmtKeys);
  if (fmt['formatPrompt']) formatPrompt.value = fmt['formatPrompt'];
  if (fmt[fmtk('fmtResult')]) { fmtResult.value = fmt[fmtk('fmtResult')]; fmtCopy.disabled = fmtSave.disabled = fmtDownload.disabled = false; }
  if (fmt[fmtk('fmtStatus')]) {
    const p = fmt[fmtk('fmtStatus')];
    if (p === 'Formatting...') {
      fmtStatusText.textContent = 'Ready';
    } else {
      fmtStatusText.textContent = p;
    }
  }
  // Restore formatting state from the same atomic load
  const wasFormatting = !!fmt[fmtk('fmtFormatting')];
  const hasFmtResult = !!fmt[fmtk('fmtResult')];

  if (wasFormatting && hasFmtResult) {
    // Formatting completed while popup was closed — show result
    fmtFormat.textContent = 'Format';
    fmtFormat.classList.remove('danger');
    fmtCopy.disabled = fmtSave.disabled = fmtDownload.disabled = false;
    chrome.storage.local.remove(fmtk('fmtFormatting'));
    fmtStatusText.textContent = 'Completed while popup was closed';
  } else if (wasFormatting) {
    fmtFormat.textContent = 'Stop';
    fmtFormat.classList.add('danger');
    fmtCopy.disabled = fmtSave.disabled = fmtDownload.disabled = true;
    fmtStatusText.textContent = 'Formatting...';
  } else {
    fmtFormat.textContent = 'Format';
    fmtFormat.classList.remove('danger');
    fmtStatusText.textContent = 'Ready';
  }
  updateFormatButtons();

  chrome.storage.local.get('lastRegion', (r) => {
    lastRegionEl.textContent = r.lastRegion
      ? `Last region: ${r.lastRegion.width}x${r.lastRegion.height}px`
      : 'No saved region';
  });
}

// ── Per-language prompt persistence ───────────────────────────
async function loadPromptForLanguage() {
  const lang = tlLanguage.value;
  // Backend wins over local storage
  try {
    const backend = normalizeBackendSettings(hostInput.value, portInput.value);
    const resp = await fetch(`http://${backend.host}:${backend.port}/prompts/translate?language=${encodeURIComponent(lang)}`);
    if (resp.ok) {
      const data = await resp.json();
      translatePrompt.value = data.template || '';
      return;
    }
  } catch {}
  // Fallback to local storage
  const key = `translatePrompt:${lang}`;
  const result = await chrome.storage.local.get(key);
  translatePrompt.value = result[key] || '';
}

async function saveTlState() {
  const lang = tlLanguage.value;
  await chrome.storage.local.set({
    tlLanguage: lang,
    [`translatePrompt:${lang}`]: translatePrompt.value
  });
  // Sync to backend (fire-and-forget)
  try {
    const backend = normalizeBackendSettings(hostInput.value, portInput.value);
    fetch(`http://${backend.host}:${backend.port}/prompts/translate?language=${encodeURIComponent(lang)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: translatePrompt.value })
    });
  } catch {}
}

async function saveTl2Language() {
  if (!currentTabId) return;
  await chrome.storage.local.set({ [`tl2Language:${currentTabId}`]: tl2Language.value });
}

function syncLanguage(source) {
  const lang = {
    prompt: tlLanguage,
    translation: tl2Language
  }[source];
  if (!lang) return;
  const value = lang.value;
  if (source !== 'prompt') tlLanguage.value = value;
  if (source !== 'translation') tl2Language.value = value;
  if (source !== 'translation') saveTl2Language();
  if (source === 'translation') {
    chrome.storage.local.set({ tlLanguage: value });
    loadPromptForLanguage();
  }
}

async function onTlLanguageChange() {
  const oldLang = (await chrome.storage.local.get('tlLanguage')).tlLanguage;
  if (oldLang) {
    await chrome.storage.local.set({ [`translatePrompt:${oldLang}`]: translatePrompt.value });
  }
  await chrome.storage.local.set({ tlLanguage: tlLanguage.value });
  await loadPromptForLanguage();
}

async function saveSettings() {
  let backend;
  try {
    backend = normalizeBackendSettings(hostInput.value, portInput.value);
  } catch (e) {
    progressEl.textContent = e.message;
    return;
  }
  await chrome.storage.sync.set({
    ocrHost: backend.host,
    ocrPort: backend.port,
    ocrAutoscroll: autoscrollCheckbox.checked
  });
  hostInput.value = backend.host;
  portInput.value = backend.port;
}

// ── OCR actions ───────────────────────────────────────────────
async function saveOcrText() {
  if (!currentTabId) return;
  userEditedResult = true;
  await chrome.storage.local.set({ [`lastResult:${currentTabId}`]: resultEl.value });
  // Update button states when user edits text
  const hasText = resultEl.value.trim().length > 0;
  copyButton.disabled = !hasText;
  downloadButton.disabled = !hasText;
  updateTranslationButtons();
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ type: 'popup:get-state' });
  if (response?.ok) {
    currentTabId = response.tabId || currentTabId;
    // Check storage for retry state that survived a SW restart
    const rsKey = currentTabId ? `retryState:${currentTabId}` : null;
    if (rsKey && response.state.status === 'Error' && !response.state.retryState && !response.state.retryStage) {
      const stored = await chrome.storage.local.get(rsKey);
      if (stored[rsKey]) response.state._hasStoredRetry = true;
    }
    renderState(response.state);
  }
}

async function startCapture() {
  userEditedResult = false;
  resultEl.value = '';
  copyButton.disabled = true;
  downloadButton.disabled = true;
  tl2Result.value = '';
  tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = true;
  setTl2Progress('Ready');
  fmtResult.value = '';
  fmtCopy.disabled = fmtSave.disabled = fmtDownload.disabled = true;
  setFmtProgress('Ready');
  startButton.disabled = true;
  progressEl.textContent = 'Starting region selection.';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup:start' });
    if (!response?.ok) {
      progressEl.textContent = response?.error || 'Unable to start capture.';
      startButton.disabled = false;
    }
  } catch (e) {
    progressEl.textContent = e.message || 'Unable to start capture.';
    startButton.disabled = false;
  }
}

async function stopCapture() {
  stopButton.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'popup:stop' });
  } catch (e) {
    progressEl.textContent = e.message || 'Unable to stop capture.';
    stopButton.disabled = false;
  }
}
async function retryCapture() {
  retryButton.disabled = true;
  progressEl.textContent = 'Retrying...';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'popup:retry' });
    if (!r?.ok) { progressEl.textContent = r?.error || 'Retry failed.'; retryButton.disabled = false; }
  } catch (e) {
    progressEl.textContent = e.message || 'Retry failed.';
    retryButton.disabled = false;
  }
}

function renderState(state) {
  latestState = state || {};
  const mergedText = latestState.mergedText || '';
  const hasText = (mergedText || resultEl.value || '').trim().length > 0;
  const isActive = Boolean(latestState.active);
  const isError = latestState.status === 'Error';
  // Check for retry capability: in-memory retryState/stage OR persisted retryState in storage
  const canRetry = (isError && latestState.active && (latestState.retryState || latestState.retryStage || latestState._hasStoredRetry)) || !!latestState.retryStage;

  statusEl.textContent = latestState.status === 'Idle' && lastStoredStatus
    ? lastStoredStatus
    : (latestState.status || 'Idle');
  currentPageEl.textContent = String(latestState.currentPage || 0);
  fragmentsEl.textContent = String(latestState.fragmentsCollected || 0);
  shortProgressEl.textContent = latestState.progress || 'Ready';
  progressEl.textContent = latestState.error || latestState.progress || 'Ready';
  if (!userEditedResult) resultEl.value = mergedText;

  // Clear translation result when a new capture starts
  if (latestState.status === 'Selecting') {
    userEditedResult = false;  // reset for keyboard-shortcut path
    lastStoredStatus = '';
    resultEl.value = '';
    tl2Result.value = '';
    tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = true;
    setTl2Progress('Ready');
    // Also clear format result when OCR restarts
    fmtResult.value = '';
    fmtCopy.disabled = fmtSave.disabled = fmtDownload.disabled = true;
    setFmtProgress('Ready');
    // Clear stale auto-translate data from storage
    if (currentTabId) {
      chrome.storage.local.remove([`tl2Result:${currentTabId}`, `tl2Status:${currentTabId}`, `tl2Translating:${currentTabId}`, `fmtResult:${currentTabId}`, `fmtStatus:${currentTabId}`, `fmtFormatting:${currentTabId}`]).catch(() => {});
    }
  }

  startButton.disabled = isActive;
  stopButton.classList.toggle('hidden', !isActive);
  retryButton.classList.toggle('hidden', !canRetry);
  copyButton.disabled = !hasText;
  downloadButton.disabled = !hasText;

  const sr = latestState.lastRegion;
  if (sr) lastRegionEl.textContent = `Last region: ${sr.width}x${sr.height}px`;

  updateTranslationButtons();

  // Handle auto-translate state from background
  if (latestState.tl2Translating) {
    tl2Translate.textContent = 'Stop';
    tl2Translate.classList.add('danger');
    tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = true;
    setTl2Progress('Translating...');
  }
}

async function copyOcrText() {
  const t = resultEl.value.trim(); if (!t) return;
  try { await navigator.clipboard.writeText(t); copyButton.textContent = 'Copied!'; setTimeout(() => copyButton.textContent = 'Copy', 1500); }
  catch { resultEl.select(); document.execCommand('copy'); }
}
function downloadOcrText() {
  const t = resultEl.value.trim(); if (!t) return;
  downloadAsFile(t, 'textkit');
}

// ── Translation panel actions ─────────────────────────────────

async function doTranslation() {
  // Button shows "Stop" — abort the background translation
  if (tl2Translate.textContent === 'Stop') {
    stopTranslation();
    return;
  }

  const text = resultEl.value.trim();
  if (!text || !currentTabId) return;
  const language = tl2Language.value;
  let backend;
  try {
    backend = normalizeBackendSettings(hostInput.value, portInput.value);
  } catch (e) {
    setTl2Progress(e.message);
    return;
  }

  tl2Translate.textContent = 'Stop';
  tl2Translate.classList.add('danger');
  tl2Result.value = '';
  tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = true;
  setTl2Progress(`Translating to ${language}...`);

  // Fire-and-forget: the background service worker handles the fetch
  // and sends translation:update / tl2:translating when done.
  // Don't await — the popup must stay responsive so Stop works.
  chrome.runtime.sendMessage({
    type: 'translate:start',
    tabId: currentTabId,
    text,
    language,
    host: backend.host,
    port: backend.port
  }).then((response) => {
    if (!response?.ok) {
      tl2Translate.textContent = 'Translate';
      tl2Translate.classList.remove('danger');
      updateTranslationButtons();
      setTl2Progress(response?.error || 'Translation failed.');
    }
  }).catch((e) => {
    tl2Translate.textContent = 'Translate';
    tl2Translate.classList.remove('danger');
    updateTranslationButtons();
    setTl2Progress(e.message || 'Translation failed.');
  });
}

function stopTranslation() {
  if (!currentTabId) return;
  chrome.runtime.sendMessage({ type: 'translate:stop', tabId: currentTabId }).catch(() => {});
  tl2Translate.textContent = 'Translate';
  tl2Translate.classList.remove('danger');
  if (currentTabId) chrome.storage.local.remove(`tl2Translating:${currentTabId}`);
  updateTranslationButtons();
  setTl2Progress('Translation stopped.');
}

async function copyResult(textarea, button) {
  const t = textarea.value.trim(); if (!t) return;
  try { await navigator.clipboard.writeText(t); button.textContent = 'Copied!'; setTimeout(() => button.textContent = 'Copy', 1500); }
  catch { textarea.select(); document.execCommand('copy'); }
}

function setTl2Progress(text) {
  tl2StatusText.textContent = text;
  if (currentTabId) chrome.storage.local.set({ [`tl2Status:${currentTabId}`]: text });
}

function updateTranslationButtons() {
  const hasSource = resultEl.value.trim().length > 0;
  const hasResult = tl2Result.value.trim().length > 0;
  tl2Translate.disabled = !hasSource;
  tl2Copy.disabled = !hasResult;
  tl2Save.disabled = !hasResult;
  tl2Download.disabled = !hasResult;
  // Also update Format button state (depends on tl2Result)
  updateFormatButtons();
}

// ── Format panel actions ───────────────────────────────────────

async function doFormat() {
  // Button shows "Stop" — abort the background formatting
  if (fmtFormat.textContent === 'Stop') {
    stopFormat();
    return;
  }

  const text = (fmtSource.value === 'ocr' ? resultEl : tl2Result).value.trim();
  if (!text || !currentTabId) return;
  const prompt = formatPrompt.value.trim();
  if (!prompt) {
    setFmtProgress('Enter a formatting prompt first.');
    return;
  }
  let backend;
  try {
    backend = normalizeBackendSettings(hostInput.value, portInput.value);
  } catch (e) {
    setFmtProgress(e.message);
    return;
  }

  fmtFormat.textContent = 'Stop';
  fmtFormat.classList.add('danger');
  fmtResult.value = '';
  fmtCopy.disabled = fmtSave.disabled = fmtDownload.disabled = true;
  setFmtProgress('Formatting...');

  // Fire-and-forget: the background service worker handles the fetch
  chrome.runtime.sendMessage({
    type: 'format:start',
    tabId: currentTabId,
    text,
    prompt,
    host: backend.host,
    port: backend.port
  }).then((response) => {
    if (!response?.ok) {
      fmtFormat.textContent = 'Format';
      fmtFormat.classList.remove('danger');
      updateFormatButtons();
      setFmtProgress(response?.error || 'Formatting failed.');
    }
  }).catch((e) => {
    fmtFormat.textContent = 'Format';
    fmtFormat.classList.remove('danger');
    updateFormatButtons();
    setFmtProgress(e.message || 'Formatting failed.');
  });
}

function stopFormat() {
  if (!currentTabId) return;
  chrome.runtime.sendMessage({ type: 'format:stop', tabId: currentTabId }).catch(() => {});
  fmtFormat.textContent = 'Format';
  fmtFormat.classList.remove('danger');
  if (currentTabId) chrome.storage.local.remove(`fmtFormatting:${currentTabId}`);
  updateFormatButtons();
  setFmtProgress('Formatting stopped.');
}

function setFmtProgress(text) {
  fmtStatusText.textContent = text;
  if (currentTabId) chrome.storage.local.set({ [`fmtStatus:${currentTabId}`]: text });
}

function updateFormatButtons() {
  const sourceEl = fmtSource.value === 'ocr' ? resultEl : tl2Result;
  const hasSource = sourceEl.value.trim().length > 0;
  const hasResult = fmtResult.value.trim().length > 0;
  fmtFormat.disabled = !hasSource;
  fmtCopy.disabled = !hasResult;
  fmtSave.disabled = !hasResult;
  fmtDownload.disabled = !hasResult;
}

async function saveFormatResult() {
  const text = fmtResult.value.trim();
  if (!text) return;
  const path = fmtSavePath.value.trim();
  if (!path) {
    setFmtProgress('Set a Save path first.');
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'save:translation',
      text,
      path
    });
    if (!response?.ok) throw new Error(response?.error || 'Save failed');

    fmtSave.textContent = 'Saved!';
    setTimeout(() => fmtSave.textContent = 'Save', 1500);
    setFmtProgress(`Saved to ${response.path || path}.`);
    chrome.notifications.create('fmt-manual-save', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Saved',
      message: `Formatted text saved to ${response.path || path}.`,
      priority: 0
    });
  } catch (e) {
    setFmtProgress(`Save failed: ${e.message}`);
    chrome.notifications.create('fmt-manual-save-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Save failed',
      message: e.message,
      priority: 1
    });
  }
}

// ── OCR/Dedup prompt load/save ────────────────────────────────
async function loadOcrPrompt() {
  // Backend wins over local storage
  try {
    const backend = normalizeBackendSettings(hostInput.value, portInput.value);
    const resp = await fetch(`http://${backend.host}:${backend.port}/prompts/ocr`);
    if (resp.ok) {
      const data = await resp.json();
      ocrPromptEl.value = data.template || '';
      return;
    }
  } catch {}
  const result = await chrome.storage.local.get('ocrPrompt');
  ocrPromptEl.value = result.ocrPrompt || '';
}

async function saveOcrPrompt() {
  const value = ocrPromptEl.value;
  await chrome.storage.local.set({ ocrPrompt: value });
  try {
    const backend = normalizeBackendSettings(hostInput.value, portInput.value);
    fetch(`http://${backend.host}:${backend.port}/prompts/ocr`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: value })
    });
  } catch {}
}

async function loadDedupPrompt() {
  // Backend wins over local storage
  try {
    const backend = normalizeBackendSettings(hostInput.value, portInput.value);
    const resp = await fetch(`http://${backend.host}:${backend.port}/prompts/dedup`);
    if (resp.ok) {
      const data = await resp.json();
      dedupPromptEl.value = data.template || '';
      return;
    }
  } catch {}
  const result = await chrome.storage.local.get('dedupPrompt');
  dedupPromptEl.value = result.dedupPrompt || '';
}

async function saveDedupPrompt() {
  const value = dedupPromptEl.value;
  await chrome.storage.local.set({ dedupPrompt: value });
  try {
    const backend = normalizeBackendSettings(hostInput.value, portInput.value);
    fetch(`http://${backend.host}:${backend.port}/prompts/dedup`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: value })
    });
  } catch {}
}

function saveFormatPrompt() {
  const value = formatPrompt.value.trim();
  chrome.storage.local.set({ formatPrompt: value });
  // Sync to backend (fire-and-forget)
  try {
    const backend = normalizeBackendSettings(hostInput.value, portInput.value);
    fetch(`http://${backend.host}:${backend.port}/prompts/format`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: value })
    });
  } catch {}
}

function saveFormatSettings() {
  chrome.storage.sync.set({
    fmtSavePath: fmtSavePath.value.trim(),
    fmtAutoCopy: fmtAutocopy.checked,
    fmtAutoSave: fmtAutosave.checked,
    fmtAutoFormat: fmtAutoformat.checked,
    fmtSourceVal: fmtSource.value
  });
}

async function saveTranslation() {
  const text = tl2Result.value.trim();
  if (!text) return;
  const path = tl2AutosavePath.value.trim();
  if (!path) {
    setTl2Progress('Set a Save path first.');
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'save:translation',
      text,
      path
    });
    if (!response?.ok) throw new Error(response?.error || 'Save failed');

    tl2Save.textContent = 'Saved!';
    setTimeout(() => tl2Save.textContent = 'Save', 1500);
    setTl2Progress(`Saved to ${response.path || path}.`);
    chrome.notifications.create('tl2-manual-save', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Saved',
      message: `Translation saved to ${response.path || path}.`,
      priority: 0
    });
  } catch (e) {
    setTl2Progress(`Save failed: ${e.message}`);
    chrome.notifications.create('tl2-manual-save-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'TextKit — Save failed',
      message: e.message,
      priority: 1
    });
  }
}

function downloadAsFile(text, prefix) {
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  chrome.downloads.download({ url, filename: `${prefix}-${ts}.txt`, saveAs: true },
    () => setTimeout(() => URL.revokeObjectURL(url), 30000));
}

// ── Translation tab settings ──────────────────────────────────

async function saveTl2Settings() {
  await chrome.storage.sync.set({
    tl2AutoCopy: tl2AutocopyCheckbox.checked,
    tl2AutoSave: tl2AutosaveCheckbox.checked,
    tl2AutoSavePath: tl2AutosavePath.value.trim(),
    ocrAutoTranslate: tl2AutotranslateCheckbox.checked
  });
}

// ── Filepath autocompletion ───────────────────────────────────

const PATH_HISTORY_KEY = 'tl2PathHistory';
const MAX_PATH_HISTORY = 20;
let _pathDebounceTimer = null;

function loadPathSuggestions() {
  // Initial load: fetch root-level paths from backend
  fetchPathSuggestions('');
}

async function fetchPathSuggestions(prefix) {
  try {
    const resp = await fetch(`http://${hostInput.value || 'localhost'}:${portInput.value || 8765}/paths?prefix=${encodeURIComponent(prefix)}`);
    const data = await resp.json().catch(() => ({}));
    const paths = data.paths || [];
    // If user typed a ~ prefix, prepend ~/ so the browser's <datalist>
    // filtering matches. The backend returns paths relative to save_root;
    // we only need to restore the tilde the user typed.
    const tildePrefix = prefix.startsWith('~/') ? '~/' : (prefix === '~' ? '~/' : '');
    tl2PathSuggestions.replaceChildren(...paths.map((path) => {
      const option = document.createElement('option');
      option.value = tildePrefix + path;
      return option;
    }));
  } catch {
    // Backend unreachable — keep existing suggestions
  }
}

function updatePathSuggestions(current) {
  if (!current) return;
  // Save to history for offline fallback
  chrome.storage.local.get(PATH_HISTORY_KEY, (r) => {
    let history = r[PATH_HISTORY_KEY] || [];
    history = history.filter(p => p !== current);
    history.unshift(current);
    if (history.length > MAX_PATH_HISTORY) history = history.slice(0, MAX_PATH_HISTORY);
    chrome.storage.local.set({ [PATH_HISTORY_KEY]: history });
  });
  // Debounce: fetch real filesystem paths after typing stops
  clearTimeout(_pathDebounceTimer);
  _pathDebounceTimer = setTimeout(() => fetchPathSuggestions(current), 300);
}

function normalizeBackendSettings(host, port) {
  let normalizedHost = String(host || 'localhost').trim();
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

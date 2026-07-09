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
const tl2AutosavePathRow = document.getElementById('tl2-autosave-path-row');
const tl2PathSuggestions = document.getElementById('tl2-path-suggestions');

// ── Tab state ─────────────────────────────────────────────────
const tabs = document.querySelectorAll('.tab');
const panels = {
  'ocr-panel': document.getElementById('ocr-panel'),
  'translate-panel': document.getElementById('translate-panel'),
  'translation-panel': document.getElementById('translation-panel')
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
tl2AutosaveCheckbox.addEventListener('change', () => {
  tl2AutosavePathRow.classList.toggle('hidden', !tl2AutosaveCheckbox.checked);
  saveTl2Settings();
});
tl2AutotranslateCheckbox.addEventListener('change', saveTl2Settings);
tl2AutosavePath.addEventListener('input', () => {
  saveTl2Settings();
  updatePathSuggestions(tl2AutosavePath.value);
});

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

  // Load Translation tab language and last result (per-tab)
  const tl2k = (k) => currentTabId ? `${k}:${currentTabId}` : k;
  const tl2 = currentTabId ? await chrome.storage.local.get([
    `tl2Language:${currentTabId}`, `tl2Result:${currentTabId}`, `tl2Status:${currentTabId}`
  ]) : {};
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
  // Restore translating state from storage (survives popup close/reopen)
  const tl2transKey = currentTabId ? `tl2Translating:${currentTabId}` : null;
  const tl2trans = tl2transKey ? await chrome.storage.local.get(tl2transKey) : {};
  const tl2resKey = currentTabId ? `tl2Result:${currentTabId}` : null;
  const tl2res = tl2resKey ? await chrome.storage.local.get(tl2resKey) : {};

  if (tl2trans[tl2transKey] && tl2res[tl2resKey]) {
    // Translation completed while popup was closed — show result
    tl2Translate.textContent = 'Translate';
    tl2Translate.classList.remove('danger');
    tl2Result.value = tl2res[tl2resKey];
    tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = false;
    chrome.storage.local.remove(tl2transKey);
    tl2StatusText.textContent = 'Completed while popup was closed';
  } else if (tl2trans[tl2transKey]) {
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
  tl2AutosavePathRow.classList.toggle('hidden', !tl2AutosaveCheckbox.checked);
  loadPathSuggestions();

  chrome.storage.local.get('lastRegion', (r) => {
    lastRegionEl.textContent = r.lastRegion
      ? `Last region: ${r.lastRegion.width}x${r.lastRegion.height}px`
      : 'No saved region';
  });
}

// ── Per-language prompt persistence ───────────────────────────
async function loadPromptForLanguage() {
  const lang = tlLanguage.value;
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
    // Clear stale auto-translate data from storage
    if (currentTabId) {
      chrome.storage.local.remove([`tl2Result:${currentTabId}`, `tl2Status:${currentTabId}`]).catch(() => {});
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
  downloadAsFile(t, 'textcap');
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
      title: 'AI OCR — Saved',
      message: `Translation saved to ${response.path || path}.`,
      priority: 0
    });
  } catch (e) {
    setTl2Progress(`Save failed: ${e.message}`);
    chrome.notifications.create('tl2-manual-save-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'AI OCR — Save failed',
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

function loadPathSuggestions() {
  chrome.storage.local.get(PATH_HISTORY_KEY, (r) => {
    const history = r[PATH_HISTORY_KEY] || [];
    tl2PathSuggestions.replaceChildren(...history.map((path) => {
      const option = document.createElement('option');
      option.value = path;
      return option;
    }));
  });
}

function updatePathSuggestions(current) {
  if (!current) return;
  chrome.storage.local.get(PATH_HISTORY_KEY, (r) => {
    let history = r[PATH_HISTORY_KEY] || [];
    history = history.filter(p => p !== current);
    history.unshift(current);
    if (history.length > MAX_PATH_HISTORY) history = history.slice(0, MAX_PATH_HISTORY);
    chrome.storage.local.set({ [PATH_HISTORY_KEY]: history });
    loadPathSuggestions();
  });
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12 * 60 * 1000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
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

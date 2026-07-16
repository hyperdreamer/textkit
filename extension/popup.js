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
const hostInput = document.getElementById('backend-host');
const portInput = document.getElementById('backend-port');
const fileBridgeHostInput = document.getElementById('file-bridge-host');
const fileBridgePortInput = document.getElementById('file-bridge-port');
const settingsGear = document.getElementById('settings-gear');
const settingsPanel = document.getElementById('backend-settings-panel');
const autoscrollCheckbox = document.getElementById('ocr-autoscroll');
const captureIntervalInput = document.getElementById('ocr-capture-interval');
const lastRegionEl = document.getElementById('last-region');

// ── Translate panel elements ──────────────────────────────────
const tlLanguage = document.getElementById('tl-language');
const translatePrompt = document.getElementById('translate-prompt');
const translatePromptHint = document.getElementById('translate-prompt-hint');

// ── OCR/Dedup prompt elements ─────────────────────────────────
const ocrPromptEl = document.getElementById('ocr-prompt');
const dedupPromptEl = document.getElementById('dedup-prompt');

// ── Prompt edit/fallback state ─────────────────────────────────
const _promptRefreshState = new WeakMap();

function _getPromptRefreshState(el) {
  if (!_promptRefreshState.has(el)) {
    _promptRefreshState.set(el, { generation: 0, dirty: false });
  }
  return _promptRefreshState.get(el);
}

function _beginPromptRefresh(el, { resetDirty = false } = {}) {
  const state = _getPromptRefreshState(el);
  state.generation += 1;
  if (resetDirty) state.dirty = false;
  return state.generation;
}

function _markPromptDirty(el) {
  const state = _getPromptRefreshState(el);
  state.dirty = true;
  state.generation += 1;
}

function _applyIfDifferent(el, newValue, generation) {
  const state = _getPromptRefreshState(el);
  if (generation !== state.generation || state.dirty || newValue == null) return false;
  if (el.value !== newValue) el.value = newValue;
  state.dirty = false;
  return true;
}

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
const PROMPT_CONFIGS = {
  ocr: { name: 'ocr', element: ocrPromptEl, storageKey: () => 'ocrPrompt' },
  dedup: { name: 'dedup', element: dedupPromptEl, storageKey: () => 'dedupPrompt' },
  translate: { name: 'translate', element: translatePrompt, storageKey: () => `translatePrompt:${tlLanguage.value}` },
  format: { name: 'format', element: formatPrompt, storageKey: () => 'formatPrompt' }
};
const _fallbackRequests = new Map();
const _fallbackData = new Map();
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
let promptEditorLanguage = 'original';
const LOCAL_BACKEND_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const FILE_BRIDGE_DEFAULT_PORT = 8766;

function fallbackElements(config) {
  return {
    container: document.getElementById(`${config.name}-fallback`),
    template: document.getElementById(`${config.name}-fallback-template`),
    source: document.getElementById(`${config.name}-fallback-source`),
    use: document.getElementById(`${config.name}-use-default`),
    reset: document.getElementById(`${config.name}-reset-default`)
  };
}

function fallbackIdentity(config, backend) {
  const language = config.name === 'translate' ? tlLanguage.value : '';
  return `${backend.host}:${backend.port}:${config.name}:${language}`;
}

function fallbackStorageKey(identity) {
  return `promptFallback:${identity}`;
}

function updatePromptUi(config) {
  const elements = fallbackElements(config);
  const hasCustom = config.element.value.trim().length > 0;
  let backend;
  try { backend = normalizeBackendSettings(hostInput.value, portInput.value); } catch { backend = null; }
  const fallback = backend ? _fallbackData.get(fallbackIdentity(config, backend)) : null;
  elements.reset.disabled = !hasCustom;
  elements.container.classList.toggle('hidden', hasCustom || !fallback);
  if (fallback) {
    elements.template.textContent = fallback.template;
    elements.source.textContent = fallback.source === 'file' ? 'backend file' : 'hardcoded failsafe';
  }
  if (config.name === 'translate') updateTranslateHintFromValue();
}

async function persistPrompt(config, key, value) {
  await chrome.storage.local.set({ [key]: value });
}

function schedulePromptSave(config) {
  const key = config.storageKey();
  const value = config.element.value;
  persistPrompt(config, key, value).catch(() => {});
}

function handlePromptInput(config) {
  _markPromptDirty(config.element);
  schedulePromptSave(config);
  updatePromptUi(config);
  if (!config.element.value.trim()) refreshFallback(config).catch(() => {});
}

async function refreshFallback(config, { force = false } = {}) {
  if (config.element.value.trim()) {
    updatePromptUi(config);
    return;
  }
  let backend;
  try { backend = normalizeBackendSettings(hostInput.value, portInput.value); } catch { return; }
  const identity = fallbackIdentity(config, backend);
  const cacheKey = fallbackStorageKey(identity);
  const stored = await chrome.storage.local.get(cacheKey);
  const cached = stored[cacheKey];
  if (cached?.version) {
    _fallbackData.set(identity, cached);
    updatePromptUi(config);
  }
  if (!force && _fallbackRequests.has(identity)) return _fallbackRequests.get(identity);

  const generation = (_fallbackRequests.get(`${identity}:generation`) || 0) + 1;
  _fallbackRequests.set(`${identity}:generation`, generation);
  const languageQuery = config.name === 'translate'
    ? `?language=${encodeURIComponent(tlLanguage.value)}`
    : '';
  const headers = cached?.version ? { 'If-None-Match': `"${cached.version}"` } : {};
  const request = (async () => {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 3000);
    try {
      const response = await fetch(
        `http://${backend.host}:${backend.port}/prompts/${config.name}/fallback${languageQuery}`,
        { headers, signal: ctrl.signal }
      );
      if (response.status === 304) return;
      if (!response.ok) return;
      const data = await response.json();
      if (!data || typeof data.template !== 'string' || !data.version) return;
      const liveBackend = normalizeBackendSettings(hostInput.value, portInput.value);
      if (_fallbackRequests.get(`${identity}:generation`) !== generation) return;
      if (fallbackIdentity(config, liveBackend) !== identity) return;
      if (cached?.version !== data.version) await chrome.storage.local.set({ [cacheKey]: data });
      if (_fallbackRequests.get(`${identity}:generation`) !== generation) return;
      _fallbackData.set(identity, data);
      updatePromptUi(config);
    } finally {
      clearTimeout(timeoutId);
      if (_fallbackRequests.get(identity) === request) _fallbackRequests.delete(identity);
    }
  })().catch(() => {});
  _fallbackRequests.set(identity, request);
  return request;
}

function refreshAllFallbacks(options = {}) {
  return Promise.allSettled(Object.values(PROMPT_CONFIGS).map((config) => refreshFallback(config, options)));
}

async function useFallbackAsCustom(config) {
  let backend;
  try { backend = normalizeBackendSettings(hostInput.value, portInput.value); } catch { return; }
  const fallback = _fallbackData.get(fallbackIdentity(config, backend));
  if (!fallback || config.element.value.trim()) return;
  config.element.value = fallback.template;
  _markPromptDirty(config.element);
  await persistPrompt(config, config.storageKey(), config.element.value);
  updatePromptUi(config);
}

async function resetPromptToFallback(config) {
  config.element.value = '';
  _beginPromptRefresh(config.element, { resetDirty: true });
  await chrome.storage.local.remove(config.storageKey());
  updatePromptUi(config);
  await refreshFallback(config, { force: true });
}

// ── Tab switching ─────────────────────────────────────────────
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    Object.values(panels).forEach(p => p.classList.add('hidden'));
    panels[tab.dataset.panel].classList.remove('hidden');
  });
});

document.querySelectorAll('.prompt-section').forEach((section) => {
  section.addEventListener('toggle', () => {
    if (!section.open) return;
    document.querySelectorAll('.prompt-section').forEach((other) => {
      if (other !== section) other.open = false;
    });
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
fileBridgeHostInput.addEventListener('change', saveFileBridgeSettings);
fileBridgePortInput.addEventListener('change', saveFileBridgeSettings);
settingsGear.addEventListener('click', () => {
  const isOpen = !settingsPanel.classList.contains('hidden');
  settingsPanel.classList.toggle('hidden', isOpen);
  settingsGear.classList.toggle('active', !isOpen);
});
autoscrollCheckbox.addEventListener('change', saveSettings);
captureIntervalInput.addEventListener('change', saveSettings);

// ── Translate panel listeners ─────────────────────────────────
tlLanguage.addEventListener('change', () => { onTlLanguageChange(); syncLanguage('prompt'); });
translatePrompt.addEventListener('input', () => {
  handlePromptInput(PROMPT_CONFIGS.translate);
});

// ── Translation panel listeners ───────────────────────────────
tl2Translate.addEventListener('click', doTranslation);
tl2Copy.addEventListener('click', () => copyResult(tl2Result, tl2Copy, setTl2Progress));
tl2Download.addEventListener('click', () => downloadAsFile(
  tl2Result.value.trim(), 'translate', tl2Download, setTl2Progress
));
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
fmtCopy.addEventListener('click', () => copyResult(fmtResult, fmtCopy, setFmtProgress));
fmtDownload.addEventListener('click', () => downloadAsFile(
  fmtResult.value.trim(), 'format', fmtDownload, setFmtProgress
));
fmtSave.addEventListener('click', saveFormatResult);
formatPrompt.addEventListener('input', () => {
  handlePromptInput(PROMPT_CONFIGS.format);
});
ocrPromptEl.addEventListener('input', () => {
  handlePromptInput(PROMPT_CONFIGS.ocr);
});
dedupPromptEl.addEventListener('input', () => {
  handlePromptInput(PROMPT_CONFIGS.dedup);
});
Object.values(PROMPT_CONFIGS).forEach((config) => {
  const elements = fallbackElements(config);
  elements.use.addEventListener('click', () => useFallbackAsCustom(config));
  elements.reset.addEventListener('click', () => resetPromptToFallback(config));
});
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
    backendHost: 'localhost', backendPort: 8765,
    fileBridgeHost: '', fileBridgePort: FILE_BRIDGE_DEFAULT_PORT,
    ocrAutoscroll: true,
    captureIntervalMs: 100,
    ocrHost: null, ocrPort: null
  });
  // Migrate old storage keys
  if (items.ocrHost !== null && items.backendHost === 'localhost') {
    await chrome.storage.sync.set({ backendHost: items.ocrHost, backendPort: items.ocrPort || 8765 });
    await chrome.storage.sync.remove(['ocrHost', 'ocrPort']);
    hostInput.value = items.ocrHost;
    portInput.value = items.ocrPort || 8765;
  } else {
    hostInput.value = items.backendHost;
    portInput.value = items.backendPort;
  }
  fileBridgeHostInput.value = items.fileBridgeHost || '';
  fileBridgePortInput.value = items.fileBridgePort || FILE_BRIDGE_DEFAULT_PORT;
  tlLanguage.value = tlLanguage.value || 'original';
  tl2Language.value = tl2Language.value || 'original';
  autoscrollCheckbox.checked = items.ocrAutoscroll;
  captureIntervalInput.value = items.captureIntervalMs;

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

  // Load translate language (set value so translatePrompt key is correct)
  const tl = await chrome.storage.local.get('tlLanguage');
  if (tl.tlLanguage) tlLanguage.value = tl.tlLanguage;

  // Load plugin-owned prompt overrides from chrome.storage.local.
  const ocrLocalGeneration = _beginPromptRefresh(ocrPromptEl, { resetDirty: true });
  const dedupLocalGeneration = _beginPromptRefresh(dedupPromptEl, { resetDirty: true });
  const tlLangKey = `translatePrompt:${tlLanguage.value}`;
  const tlLocalGeneration = _beginPromptRefresh(translatePrompt, { resetDirty: true });
  const fmtLocalGeneration = _beginPromptRefresh(formatPrompt, { resetDirty: true });
  const [ocrStored, dedupStored, tlStored, fmtStored] = await Promise.all([
    chrome.storage.local.get('ocrPrompt'),
    chrome.storage.local.get('dedupPrompt'),
    chrome.storage.local.get(tlLangKey),
    chrome.storage.local.get('formatPrompt')
  ]);
  _applyIfDifferent(ocrPromptEl, ocrStored.ocrPrompt || '', ocrLocalGeneration);
  _applyIfDifferent(dedupPromptEl, dedupStored.dedupPrompt || '', dedupLocalGeneration);
  _applyIfDifferent(translatePrompt, tlStored[tlLangKey] || '', tlLocalGeneration);
  promptEditorLanguage = tlLanguage.value;
  _applyIfDifferent(formatPrompt, fmtStored.formatPrompt || '', fmtLocalGeneration);
  updateTranslateHintFromValue();
  Object.values(PROMPT_CONFIGS).forEach(updatePromptUi);
  refreshAllFallbacks({ force: true }).catch(() => {});

  // Load Translation tab language and last result (per-tab) -- single atomic load
  const tl2k = (k) => currentTabId ? `${k}:${currentTabId}` : k;
  const tl2Keys = currentTabId ? [tl2k('tl2Result'), tl2k('tl2Status'), tl2k('tl2Translating')] : [];
  const tl2 = await chrome.storage.local.get([...tl2Keys, 'tl2Language']);
  if (tl2.tl2Language) tl2Language.value = tl2.tl2Language;
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
function updateTranslateHintFromValue() {
  // Used when only the textarea value is known (e.g. on input, after
  // localStorage seed, or after explicit edits). Without backend metadata
  // we infer the flag from the literal text.
  if (!translatePromptHint) return;
  const hasVar = translatePrompt.value.includes('{language}');
  if (hasVar) {
    translatePromptHint.textContent = `{language} will be replaced with "${tlLanguage.value}"`;
    translatePromptHint.classList.remove('hidden');
  } else {
    translatePromptHint.classList.add('hidden');
  }
}

async function loadPromptForLanguage() {
  const lang = tlLanguage.value;
  const key = `translatePrompt:${lang}`;
  const localGeneration = _beginPromptRefresh(translatePrompt, { resetDirty: true });
  const stored = await chrome.storage.local.get(key);
  if (!_applyIfDifferent(translatePrompt, stored[key] || '', localGeneration)) return;
  promptEditorLanguage = lang;
  updateTranslateHintFromValue();
  updatePromptUi(PROMPT_CONFIGS.translate);
  refreshFallback(PROMPT_CONFIGS.translate, { force: true }).catch(() => {});
}

async function saveTl2Language() {
  await chrome.storage.local.set({ tl2Language: tl2Language.value });
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
  clearTimeout(_tlSaveTimer);
  if (oldLang && oldLang !== tlLanguage.value) {
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
  const intervalVal = parseInt(captureIntervalInput.value, 10);
  const captureIntervalMs = (Number.isFinite(intervalVal) && intervalVal >= 50 && intervalVal <= 2000)
    ? intervalVal : 100;
  await chrome.storage.sync.set({
    backendHost: backend.host,
    backendPort: backend.port,
    ocrAutoscroll: autoscrollCheckbox.checked,
    captureIntervalMs
  });
  hostInput.value = backend.host;
  portInput.value = backend.port;
  await refreshAllFallbacks({ force: true });
}

async function saveFileBridgeSettings() {
  const rawHost = fileBridgeHostInput.value.trim();
  if (!rawHost) {
    let port;
    try {
      port = normalizeBackendSettings('localhost', fileBridgePortInput.value || FILE_BRIDGE_DEFAULT_PORT).port;
    } catch (e) {
      progressEl.textContent = e.message;
      return;
    }
    await chrome.storage.sync.set({ fileBridgeHost: '', fileBridgePort: port });
    fileBridgeHostInput.value = '';
    fileBridgePortInput.value = port;
    return;
  }

  let fileBridge;
  try {
    fileBridge = normalizeBackendSettings(rawHost, fileBridgePortInput.value || FILE_BRIDGE_DEFAULT_PORT);
  } catch (e) {
    progressEl.textContent = e.message;
    return;
  }
  await chrome.storage.sync.set({
    fileBridgeHost: fileBridge.host,
    fileBridgePort: fileBridge.port
  });
  fileBridgeHostInput.value = fileBridge.host;
  fileBridgePortInput.value = fileBridge.port;
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
    const response = await chrome.runtime.sendMessage({
      type: 'popup:start',
      prompts: {
        ocr: ocrPromptEl.value,
        dedup: dedupPromptEl.value
      }
    });
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
  return copyResult(resultEl, copyButton, (message) => { progressEl.textContent = message; });
}
function downloadOcrText() {
  const t = resultEl.value.trim(); if (!t) return;
  return downloadAsFile(t, 'textkit', downloadButton, (message) => {
    progressEl.textContent = message;
  });
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
  let prompt = translatePrompt.value;
  if (promptEditorLanguage !== language) {
    const key = `translatePrompt:${language}`;
    const stored = await chrome.storage.local.get(key);
    prompt = stored[key] || '';
  }
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
    prompt,
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

async function copyResult(textarea, button, setProgress = () => {}) {
  const t = textarea.value.trim(); if (!t) return;
  try {
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      textarea.select();
      if (!document.execCommand('copy')) throw new Error('Clipboard copy was rejected.');
    }
    button.textContent = 'Copied!';
    setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    setProgress('Copied to clipboard.');
    return true;
  } catch (error) {
    setProgress(`Copy failed: ${error.message || 'clipboard unavailable'}`);
    return false;
  }
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
  const prompt = formatPrompt.value;
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

function downloadAsFile(text, prefix, button, setProgress = () => {}) {
  if (!text) return Promise.resolve(false);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return new Promise((resolve) => {
    const finish = (downloadId) => {
      const runtimeError = chrome.runtime.lastError;
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      if (runtimeError || downloadId == null) {
        setProgress(`Download failed: ${runtimeError?.message || 'browser rejected the download'}`);
        resolve(false);
        return;
      }
      if (button) {
        button.textContent = 'Downloaded!';
        setTimeout(() => { button.textContent = 'Download'; }, 1500);
      }
      setProgress('Download started.');
      resolve(true);
    };
    try {
      chrome.downloads.download(
        { url, filename: `${prefix}-${ts}.txt`, saveAs: true },
        finish
      );
    } catch (error) {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setProgress(`Download failed: ${error.message || 'browser rejected the download'}`);
      resolve(false);
    }
  });
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
let _pathSuggestionGeneration = 0;

function loadPathSuggestions() {
  // Initial load: fetch root-level paths from backend
  fetchPathSuggestions('', ++_pathSuggestionGeneration);
}

async function fetchPathSuggestions(prefix, generation = ++_pathSuggestionGeneration) {
  if (generation > _pathSuggestionGeneration) _pathSuggestionGeneration = generation;
  try {
    const items = await chrome.storage.sync.get({
      fileBridgeHost: '',
      fileBridgePort: FILE_BRIDGE_DEFAULT_PORT
    });
    const hasFileBridgeHost = String(items.fileBridgeHost || '').trim().length > 0;
    const fileBridge = normalizeBackendSettings(
      hasFileBridgeHost ? items.fileBridgeHost : 'localhost',
      items.fileBridgePort || FILE_BRIDGE_DEFAULT_PORT
    );
    const resp = await fetch(`http://${fileBridge.host}:${fileBridge.port}/paths?prefix=${encodeURIComponent(prefix)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json().catch(() => ({}));
    const paths = data.paths || [];
    // If user typed a ~ prefix, prepend ~/ so the browser's <datalist>
    // filtering matches. The backend returns paths relative to save_root;
    // we only need to restore the tilde the user typed.
    const tildePrefix = prefix.startsWith('~/') ? '~/' : (prefix === '~' ? '~/' : '');
    if (generation !== _pathSuggestionGeneration) return false;
    populatePathSuggestions(paths.map((path) => tildePrefix + path));
    return true;
  } catch {
    const stored = await chrome.storage.local.get(PATH_HISTORY_KEY);
    if (generation !== _pathSuggestionGeneration) return false;
    const history = Array.isArray(stored[PATH_HISTORY_KEY]) ? stored[PATH_HISTORY_KEY] : [];
    const prefixLower = prefix.toLowerCase();
    populatePathSuggestions(history.filter((path) => (
      !prefixLower || String(path).toLowerCase().startsWith(prefixLower)
    )));
    return true;
  }
}

function populatePathSuggestions(paths) {
  tl2PathSuggestions.replaceChildren(...paths.map((path) => {
    const option = document.createElement('option');
    option.value = path;
    return option;
  }));
}

function updatePathSuggestions(current) {
  const generation = ++_pathSuggestionGeneration;
  // Save to history for offline fallback
  if (current) {
    chrome.storage.local.get(PATH_HISTORY_KEY, (r) => {
      let history = r[PATH_HISTORY_KEY] || [];
      history = history.filter(p => p !== current);
      history.unshift(current);
      if (history.length > MAX_PATH_HISTORY) history = history.slice(0, MAX_PATH_HISTORY);
      chrome.storage.local.set({ [PATH_HISTORY_KEY]: history });
    });
  }
  // Debounce: fetch real filesystem paths after typing stops
  clearTimeout(_pathDebounceTimer);
  _pathDebounceTimer = setTimeout(() => fetchPathSuggestions(current, generation), 300);
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

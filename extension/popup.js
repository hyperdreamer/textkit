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
const autocopyCheckbox = document.getElementById('ocr-autocopy');
const lastRegionEl = document.getElementById('last-region');

// ── Translate panel elements ──────────────────────────────────
const tlLanguage = document.getElementById('tl-language');
const translatePrompt = document.getElementById('translate-prompt');

// ── Translation panel elements ────────────────────────────────
const tl2Language = document.getElementById('tl2-language');
const tl2Progress = document.getElementById('tl2-progress');
const tl2Result = document.getElementById('tl2-result');
const tl2Translate = document.getElementById('tl2-translate');
const tl2Copy = document.getElementById('tl2-copy');
const tl2Download = document.getElementById('tl2-download');

// ── Tab state ─────────────────────────────────────────────────
const tabs = document.querySelectorAll('.tab');
const panels = {
  'ocr-panel': document.getElementById('ocr-panel'),
  'translate-panel': document.getElementById('translate-panel'),
  'translation-panel': document.getElementById('translation-panel')
};

let latestState = null;
let currentTabId = null;

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
document.addEventListener('DOMContentLoaded', init);
startButton.addEventListener('click', startCapture);
stopButton.addEventListener('click', stopCapture);
retryButton.addEventListener('click', retryCapture);
copyButton.addEventListener('click', copyOcrText);
downloadButton.addEventListener('click', downloadOcrText);
hostInput.addEventListener('change', saveSettings);
portInput.addEventListener('change', saveSettings);
autoscrollCheckbox.addEventListener('change', saveSettings);
autocopyCheckbox.addEventListener('change', saveSettings);

// ── Translate panel listeners ─────────────────────────────────
tlLanguage.addEventListener('change', onTlLanguageChange);
translatePrompt.addEventListener('input', saveTlState);

// ── Translation panel listeners ───────────────────────────────
tl2Translate.addEventListener('click', doTranslation);
tl2Copy.addEventListener('click', () => copyResult(tl2Result, tl2Copy));
tl2Download.addEventListener('click', () => downloadAsFile(tl2Result.value.trim(), 'translate'));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state:update') {
    if (message.tabId !== currentTabId) return;
    renderState(message.state);
  }
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;

  const items = await chrome.storage.sync.get({
    ocrHost: 'localhost', ocrPort: 8000,
    ocrAutoscroll: true, ocrAutoCopy: true
  });
  hostInput.value = items.ocrHost;
  portInput.value = items.ocrPort;
  autoscrollCheckbox.checked = items.ocrAutoscroll;
  autocopyCheckbox.checked = items.ocrAutoCopy;

  const resultKey = currentTabId ? `lastResult:${currentTabId}` : null;
  const stored = resultKey ? await chrome.storage.local.get(resultKey) : {};
  if (resultKey && stored[resultKey]) resultEl.value = stored[resultKey];
  await refreshState();
  if (!resultEl.value && resultKey) {
    const fb = await chrome.storage.local.get(resultKey);
    if (fb[resultKey]) resultEl.value = fb[resultKey];
  }

  // Load translate language and prompt
  const tl = await chrome.storage.local.get('tlLanguage');
  if (tl.tlLanguage) tlLanguage.value = tl.tlLanguage;
  await loadPromptForLanguage();

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

async function onTlLanguageChange() {
  const oldLang = (await chrome.storage.local.get('tlLanguage')).tlLanguage;
  if (oldLang) {
    await chrome.storage.local.set({ [`translatePrompt:${oldLang}`]: translatePrompt.value });
  }
  await chrome.storage.local.set({ tlLanguage: tlLanguage.value });
  await loadPromptForLanguage();
}

async function saveSettings() {
  await chrome.storage.sync.set({
    ocrHost: hostInput.value.trim() || 'localhost',
    ocrPort: parseInt(portInput.value, 10) || 8000,
    ocrAutoscroll: autoscrollCheckbox.checked,
    ocrAutoCopy: autocopyCheckbox.checked
  });
}

// ── OCR actions ───────────────────────────────────────────────
async function refreshState() {
  const response = await chrome.runtime.sendMessage({ type: 'popup:get-state' });
  if (response?.ok) {
    currentTabId = response.tabId || currentTabId;
    renderState(response.state);
  }
}

async function startCapture() {
  startButton.disabled = true;
  progressEl.textContent = 'Starting region selection.';
  const response = await chrome.runtime.sendMessage({ type: 'popup:start' });
  if (!response?.ok) {
    progressEl.textContent = response?.error || 'Unable to start capture.';
    startButton.disabled = false;
  }
}

async function stopCapture() { stopButton.disabled = true; await chrome.runtime.sendMessage({ type: 'popup:stop' }); }
async function retryCapture() {
  retryButton.disabled = true;
  progressEl.textContent = 'Retrying...';
  const r = await chrome.runtime.sendMessage({ type: 'popup:retry' });
  if (!r?.ok) { progressEl.textContent = r?.error || 'Retry failed.'; retryButton.disabled = false; }
}

function renderState(state) {
  latestState = state || {};
  const mergedText = latestState.mergedText || '';
  const hasText = (mergedText || resultEl.value || '').trim().length > 0;
  const isActive = Boolean(latestState.active);
  const isError = latestState.status === 'Error';
  const canRetry = (isError && latestState.active && latestState.retryState) || !!latestState.retryStage;

  statusEl.textContent = latestState.status || 'Idle';
  currentPageEl.textContent = String(latestState.currentPage || 0);
  fragmentsEl.textContent = String(latestState.fragmentsCollected || 0);
  shortProgressEl.textContent = latestState.progress || 'Ready';
  progressEl.textContent = latestState.error || latestState.progress || 'Ready';
  if (mergedText) resultEl.value = mergedText;

  startButton.disabled = isActive;
  stopButton.classList.toggle('hidden', !isActive);
  retryButton.classList.toggle('hidden', !canRetry);
  copyButton.disabled = !hasText;
  downloadButton.disabled = !hasText;

  const sr = latestState.lastRegion;
  if (sr) lastRegionEl.textContent = `Last region: ${sr.width}x${sr.height}px`;

  updateTranslationButtons();
}

async function copyOcrText() {
  const t = resultEl.value.trim(); if (!t) return;
  try { await navigator.clipboard.writeText(t); copyButton.textContent = 'Copied!'; setTimeout(() => copyButton.textContent = 'Copy', 1500); }
  catch { resultEl.select(); document.execCommand('copy'); }
}
function downloadOcrText() {
  const t = resultEl.value.trim(); if (!t) return;
  downloadAsFile(t, 'qidian-ocr');
}

// ── Translation panel actions ─────────────────────────────────
async function doTranslation() {
  const text = resultEl.value.trim();
  if (!text) return;
  const language = tl2Language.value;
  tl2Translate.disabled = true;
  tl2Progress.textContent = `Translating to ${language}...`;
  try {
    const host = hostInput.value.trim() || 'localhost';
    const port = parseInt(portInput.value, 10) || 8000;
    const key = `translatePrompt:${language}`;
    const stored = await chrome.storage.local.get(key);
    const response = await fetch(`http://${host}:${port}/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language, prompt: stored[key] || undefined })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    tl2Result.value = payload.text || '';
    tl2Copy.disabled = tl2Download.disabled = false;
    tl2Progress.textContent = 'Translation complete.';
    updateTranslationButtons();
  } catch (e) {
    tl2Result.value = `Error: ${e.message}`;
    tl2Progress.textContent = `Translation failed: ${e.message}`;
    updateTranslationButtons();
  } finally {
    tl2Translate.disabled = false;
  }
}

function copyResult(textarea, button) {
  const t = textarea.value.trim(); if (!t) return;
  try { navigator.clipboard.writeText(t); button.textContent = 'Copied!'; setTimeout(() => button.textContent = 'Copy', 1500); }
  catch { textarea.select(); document.execCommand('copy'); }
}

function updateTranslationButtons() {
  const hasSource = resultEl.value.trim().length > 0;
  const hasResult = tl2Result.value.trim().length > 0;
  tl2Translate.disabled = !hasSource;
  tl2Copy.disabled = !hasResult;
  tl2Download.disabled = !hasResult;
}

function downloadAsFile(text, prefix) {
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  chrome.downloads.download({ url, filename: `${prefix}-${ts}.txt`, saveAs: true },
    () => setTimeout(() => URL.revokeObjectURL(url), 30000));
}

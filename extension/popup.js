const statusEl = document.getElementById('status');
const currentPageEl = document.getElementById('current-page');
const fragmentsEl = document.getElementById('fragments');
const shortProgressEl = document.getElementById('short-progress');
const progressEl = document.getElementById('progress');
const resultEl = document.getElementById('result');
const startButton = document.getElementById('start');
const translateButton = document.getElementById('translate-text');
const stopButton = document.getElementById('stop');
const retryButton = document.getElementById('retry');
const copyButton = document.getElementById('copy');
const downloadButton = document.getElementById('download');
const hostInput = document.getElementById('ocr-host');
const portInput = document.getElementById('ocr-port');
const languageSelect = document.getElementById('ocr-language');
const autoscrollCheckbox = document.getElementById('ocr-autoscroll');
const autocopyCheckbox = document.getElementById('ocr-autocopy');
const lastRegionEl = document.getElementById('last-region');

let latestState = null;

document.addEventListener('DOMContentLoaded', init);
startButton.addEventListener('click', startCapture);
translateButton.addEventListener('click', translateText);
stopButton.addEventListener('click', stopCapture);
retryButton.addEventListener('click', retryCapture);
copyButton.addEventListener('click', copyText);
downloadButton.addEventListener('click', downloadText);
hostInput.addEventListener('change', saveSettings);
portInput.addEventListener('change', saveSettings);
languageSelect.addEventListener('change', saveSettings);
autoscrollCheckbox.addEventListener('change', saveSettings);
autocopyCheckbox.addEventListener('change', saveSettings);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state:update') {
    renderState(message.state);
  }
});

async function init() {
  const items = await chrome.storage.sync.get({
    ocrHost: 'localhost',
    ocrPort: 8000,
    ocrLanguage: 'original',
    ocrAutoscroll: true,
    ocrAutoCopy: true
  });
  hostInput.value = items.ocrHost;
  portInput.value = items.ocrPort;
  languageSelect.value = items.ocrLanguage;
  autoscrollCheckbox.checked = items.ocrAutoscroll;
  autocopyCheckbox.checked = items.ocrAutoCopy;

  // Load stored last result in case background state is empty (race condition on startup)
  const stored = await chrome.storage.local.get('lastResult');
  if (stored.lastResult) resultEl.value = stored.lastResult;

  await refreshState();

  // Fallback: if background state was empty, restore from storage again
  if (!resultEl.value) {
    const fb = await chrome.storage.local.get('lastResult');
    if (fb.lastResult) resultEl.value = fb.lastResult;
  }

  chrome.storage.local.get('lastRegion', (r) => {
    if (r.lastRegion) {
      lastRegionEl.textContent = `Last region: ${r.lastRegion.width}×${r.lastRegion.height}px`;
    } else {
      lastRegionEl.textContent = 'No saved region';
    }
  });
}

async function saveSettings() {
  await chrome.storage.sync.set({
    ocrHost: hostInput.value.trim() || 'localhost',
    ocrPort: parseInt(portInput.value, 10) || 8000,
    ocrLanguage: languageSelect.value || 'original',
    ocrAutoscroll: autoscrollCheckbox.checked,
    ocrAutoCopy: autocopyCheckbox.checked
  });
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ type: 'popup:get-state' });
  if (response?.ok) {
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

async function translateText() {
  const text = resultEl.value.trim();
  if (!text) return;

  const language = languageSelect.value;
  if (language === 'original') {
    progressEl.textContent = 'Select a target language first.';
    return;
  }

  translateButton.disabled = true;
  progressEl.textContent = `Translating to ${language}...`;

  try {
    const host = hostInput.value.trim() || 'localhost';
    const port = parseInt(portInput.value, 10) || 8000;
    const response = await fetch(`http://${host}:${port}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);

    const translated = payload.text || '';
    resultEl.value = translated;
    latestState.mergedText = translated;
    progressEl.textContent = 'Translation complete.';
    copyButton.disabled = false;
    downloadButton.disabled = false;
  } catch (e) {
    progressEl.textContent = `Translation failed: ${e.message}`;
  } finally {
    translateButton.disabled = false;
  }
}

async function stopCapture() {
  stopButton.disabled = true;
  await chrome.runtime.sendMessage({ type: 'popup:stop' });
}

async function retryCapture() {
  retryButton.disabled = true;
  progressEl.textContent = 'Retrying...';
  const response = await chrome.runtime.sendMessage({ type: 'popup:retry' });
  if (!response?.ok) {
    progressEl.textContent = response?.error || 'Retry failed.';
    retryButton.disabled = false;
  }
}

function renderState(state) {
  latestState = state || {};
  const mergedText = latestState.mergedText || resultEl.value || '';
  const hasText = mergedText.trim().length > 0;
  const savedRegion = latestState.lastRegion;
  const isActive = Boolean(latestState.active);
  const isError = latestState.status === 'Error';
  const canRetry = (isError && latestState.active && latestState.retryState) || !!latestState.retryStage;

  statusEl.textContent = latestState.status || 'Idle';
  currentPageEl.textContent = String(latestState.currentPage || 0);
  fragmentsEl.textContent = String(latestState.fragmentsCollected || 0);
  shortProgressEl.textContent = latestState.progress || 'Ready';
  progressEl.textContent = latestState.error || latestState.progress || 'Ready';
  resultEl.value = mergedText;

  startButton.disabled = isActive;
  translateButton.disabled = !hasText || isActive || languageSelect.value === 'original';
  stopButton.classList.toggle('hidden', !isActive);
  retryButton.classList.toggle('hidden', !canRetry);
  copyButton.disabled = !hasText;
  downloadButton.disabled = !hasText;

  if (savedRegion) {
    lastRegionEl.textContent = `Last region: ${savedRegion.width}×${savedRegion.height}px`;
  }
}

async function copyText() {
  const text = resultEl.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const prev = copyButton.textContent;
    copyButton.textContent = 'Copied!';
    setTimeout(() => { copyButton.textContent = prev; }, 1500);
  } catch {
    resultEl.select();
    document.execCommand('copy');
  }
}

function downloadText() {
  const text = resultEl.value.trim();
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  chrome.downloads.download({
    url,
    filename: `qidian-ocr-${timestamp}.txt`,
    saveAs: true
  }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}

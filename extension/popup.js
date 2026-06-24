const statusEl = document.getElementById('status');
const currentPageEl = document.getElementById('current-page');
const fragmentsEl = document.getElementById('fragments');
const shortProgressEl = document.getElementById('short-progress');
const progressEl = document.getElementById('progress');
const resultEl = document.getElementById('result');
const startButton = document.getElementById('start');
const reuseButton = document.getElementById('reuse');
const stopButton = document.getElementById('stop');
const retryButton = document.getElementById('retry');
const copyButton = document.getElementById('copy');
const downloadButton = document.getElementById('download');
const hostInput = document.getElementById('ocr-host');
const portInput = document.getElementById('ocr-port');
const languageSelect = document.getElementById('ocr-language');
const lastRegionEl = document.getElementById('last-region');

let latestState = null;

document.addEventListener('DOMContentLoaded', init);
startButton.addEventListener('click', startCapture);
reuseButton.addEventListener('click', reuseCapture);
stopButton.addEventListener('click', stopCapture);
retryButton.addEventListener('click', retryCapture);
copyButton.addEventListener('click', copyText);
downloadButton.addEventListener('click', downloadText);
hostInput.addEventListener('change', saveSettings);
portInput.addEventListener('change', saveSettings);
languageSelect.addEventListener('change', saveSettings);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state:update') {
    renderState(message.state);
  }
});

async function init() {
  const items = await chrome.storage.sync.get({
    ocrHost: 'localhost',
    ocrPort: 8000,
    ocrLanguage: 'original'
  });
  hostInput.value = items.ocrHost;
  portInput.value = items.ocrPort;
  languageSelect.value = items.ocrLanguage;
  await refreshState();
  chrome.storage.local.get('lastRegion', (r) => {
    if (r.lastRegion) {
      lastRegionEl.textContent = `Last region: ${r.lastRegion.width}×${r.lastRegion.height}px`;
      reuseButton.disabled = false;
    } else {
      lastRegionEl.textContent = 'No saved region';
    }
  });
}

async function saveSettings() {
  await chrome.storage.sync.set({
    ocrHost: hostInput.value.trim() || 'localhost',
    ocrPort: parseInt(portInput.value, 10) || 8000,
    ocrLanguage: languageSelect.value || 'original'
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
  reuseButton.disabled = true;
  progressEl.textContent = 'Starting region selection.';
  const response = await chrome.runtime.sendMessage({ type: 'popup:start' });
  if (!response?.ok) {
    progressEl.textContent = response?.error || 'Unable to start capture.';
    startButton.disabled = false;
  }
}

async function reuseCapture() {
  reuseButton.disabled = true;
  startButton.disabled = true;
  progressEl.textContent = 'Reusing last region...';
  const response = await chrome.runtime.sendMessage({ type: 'popup:start-with-region' });
  if (!response?.ok) {
    progressEl.textContent = response?.error || 'No saved region.';
    reuseButton.disabled = false;
    startButton.disabled = false;
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
  const mergedText = latestState.mergedText || '';
  const hasText = mergedText.trim().length > 0;
  const savedRegion = latestState.lastRegion;
  const isActive = Boolean(latestState.active);
  const isError = latestState.status === 'Error';
  const canRetry = isError && latestState.active && state.retryState;

  statusEl.textContent = latestState.status || 'Idle';
  currentPageEl.textContent = String(latestState.currentPage || 0);
  fragmentsEl.textContent = String(latestState.fragmentsCollected || 0);
  shortProgressEl.textContent = latestState.progress || 'Ready';
  progressEl.textContent = latestState.error || latestState.progress || 'Ready';
  resultEl.value = mergedText;

  startButton.disabled = isActive;
  reuseButton.disabled = !savedRegion || isActive;
  stopButton.classList.toggle('hidden', !isActive);
  retryButton.classList.toggle('hidden', !canRetry);
  copyButton.disabled = !hasText;
  downloadButton.disabled = !hasText;

  if (savedRegion) {
    lastRegionEl.textContent = `Last region: ${savedRegion.width}×${savedRegion.height}px`;
  }
}

async function copyText() {
  const text = latestState?.mergedText || resultEl.value || '';
  if (!text.trim()) return;
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
  const text = latestState?.mergedText || resultEl.value || '';
  if (!text.trim()) return;
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

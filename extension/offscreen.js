// Offscreen document for clipboard + download access from service worker

// Offscreen documents are never focused, so the async Clipboard API
// (navigator.clipboard.writeText) rejects with "Document is not focused".
// Use a hidden textarea + execCommand('copy'), which works without focus.
function copyTextViaTextarea(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep it out of view but still selectable.
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand("copy") returned false');
    return true;
  } finally {
    textarea.remove();
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'offscreen:copy') {
    try {
      copyTextViaTextarea(message.text || '');
      chrome.runtime.sendMessage({ type: 'offscreen:copied', copyId: message.copyId });
    } catch (e) {
      console.error('Offscreen copy failed:', e);
      chrome.runtime.sendMessage({
        type: 'offscreen:copy-failed',
        copyId: message.copyId,
        error: e.message
      });
    }
  }
  if (message?.type === 'offscreen:download') {
    const { text, filename } = message;
    if (!text || !filename) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      if (chrome.runtime.lastError) {
        console.error('Download failed:', chrome.runtime.lastError.message);
      }
    });
  }
});

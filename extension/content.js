(() => {
  if (window.__qidianOcrContentLoaded) {
    return;
  }
  window.__qidianOcrContentLoaded = true;

  let overlay = null;
  let selection = null;
  let startPoint = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'selection:start') {
      startSelectionMode();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'page:scroll-down') {
      scrollDown(message.overlapPx)
        .then(sendResponse)
        .catch((error) => sendResponse({ changed: false, error: error.message }));
      return true;
    }

    if (message?.type === 'get-viewport') {
      sendResponse({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 });
      return false;
    }

    return false;
  });

  function startSelectionMode() {
    removeOverlay();

    overlay = document.createElement('div');
    overlay.className = 'qidian-ocr-overlay';
    overlay.innerHTML = '<div class="qidian-ocr-selection"></div><div class="qidian-ocr-hint">Drag to select OCR region. Press Esc to cancel.</div>';
    document.documentElement.appendChild(overlay);

    selection = overlay.querySelector('.qidian-ocr-selection');
    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown, true);
  }

  function onPointerDown(event) {
    if (!overlay) {
      return;
    }

    overlay.setPointerCapture(event.pointerId);
    startPoint = {
      x: clamp(event.clientX, 0, window.innerWidth),
      y: clamp(event.clientY, 0, window.innerHeight)
    };
    drawSelection(startPoint.x, startPoint.y, 0, 0);
  }

  function onPointerMove(event) {
    if (!startPoint) {
      return;
    }

    const currentX = clamp(event.clientX, 0, window.innerWidth);
    const currentY = clamp(event.clientY, 0, window.innerHeight);
    const x = Math.min(startPoint.x, currentX);
    const y = Math.min(startPoint.y, currentY);
    const width = Math.abs(currentX - startPoint.x);
    const height = Math.abs(currentY - startPoint.y);
    drawSelection(x, y, width, height);
  }

  function onPointerUp(event) {
    if (!startPoint) {
      return;
    }

    const currentX = clamp(event.clientX, 0, window.innerWidth);
    const currentY = clamp(event.clientY, 0, window.innerHeight);
    const region = {
      x: Math.min(startPoint.x, currentX),
      y: Math.min(startPoint.y, currentY),
      width: Math.abs(currentX - startPoint.x),
      height: Math.abs(currentY - startPoint.y),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    };

    removeOverlay();

    if (region.width < 2 || region.height < 2) {
      chrome.runtime.sendMessage({ type: 'selection:cancelled' });
      return;
    }

    chrome.runtime.sendMessage({ type: 'selection:complete', region });
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') {
      return;
    }

    removeOverlay();
    chrome.runtime.sendMessage({ type: 'selection:cancelled' });
  }

  function drawSelection(x, y, width, height) {
    selection.style.left = `${x}px`;
    selection.style.top = `${y}px`;
    selection.style.width = `${width}px`;
    selection.style.height = `${height}px`;
  }

  function removeOverlay() {
    if (overlay) {
      overlay.removeEventListener('pointerdown', onPointerDown);
      overlay.removeEventListener('pointermove', onPointerMove);
      overlay.removeEventListener('pointerup', onPointerUp);
      overlay.remove();
    }
    window.removeEventListener('keydown', onKeyDown, true);
    overlay = null;
    selection = null;
    startPoint = null;
  }

  async function scrollDown(overlapPx = 50) {
    const before = window.scrollY;
    const distance = Math.max(1, window.innerHeight - Number(overlapPx || 0));
    window.scrollBy({ top: distance, left: 0, behavior: 'instant' });
    await waitForScrollSettle();

    const after = window.scrollY;
    const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return {
      before,
      scrollY: after,
      changed: Math.abs(after - before) > 1,
      atBottom: after >= maxScrollY - 1,
      maxScrollY
    };
  }

  function waitForScrollSettle() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();

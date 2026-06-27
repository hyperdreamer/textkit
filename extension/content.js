(() => {
  if (window.__qidianOcrContentLoaded) return;
  window.__qidianOcrContentLoaded = true;

  let overlay = null;
  let selection = null;
  let handles = [];
  let dragMode = null; // 'new' | 'move' | 'resize-nw' | 'resize-ne' | ...
  let dragStart = null;
  let region = null; // { x, y, width, height }

  const MIN_SIZE = 10;
  const HANDLE_SIZE = 8;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'selection:start') {
      startSelectionMode(message.lastRegion || null);
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

  function startSelectionMode(saved) {
    removeOverlay();

    overlay = document.createElement('div');
    overlay.className = 'qidian-ocr-overlay';
    overlay.innerHTML = '<div class="qidian-ocr-selection"></div>'
      + '<div class="qidian-ocr-handle nw"></div>'
      + '<div class="qidian-ocr-handle n"></div>'
      + '<div class="qidian-ocr-handle ne"></div>'
      + '<div class="qidian-ocr-handle e"></div>'
      + '<div class="qidian-ocr-handle se"></div>'
      + '<div class="qidian-ocr-handle s"></div>'
      + '<div class="qidian-ocr-handle sw"></div>'
      + '<div class="qidian-ocr-handle w"></div>'
      + '<div class="qidian-ocr-hint"></div>';
    document.documentElement.appendChild(overlay);

    selection = overlay.querySelector('.qidian-ocr-selection');
    handles = [...overlay.querySelectorAll('.qidian-ocr-handle')];
    const hint = overlay.querySelector('.qidian-ocr-hint');

    // Pre-draw saved region if available
    if (saved && saved.width >= MIN_SIZE && saved.height >= MIN_SIZE) {
      region = {
        x: clamp(saved.x, 0, window.innerWidth - MIN_SIZE),
        y: clamp(saved.y, 0, window.innerHeight - MIN_SIZE),
        width: clamp(saved.width, MIN_SIZE, window.innerWidth - clamp(saved.x, 0, window.innerWidth)),
        height: clamp(saved.height, MIN_SIZE, window.innerHeight - clamp(saved.y, 0, window.innerHeight))
      };
      hint.textContent = 'Drag to adjust. Ctrl+Space to confirm. Esc to cancel.';
    } else {
      region = { x: 0, y: 0, width: 0, height: 0 };
      hint.textContent = 'Drag to select OCR region. Ctrl+Space to confirm. Esc to cancel.';
    }

    drawRegion();

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown, true);
  }

  function getHandleAt(ex, ey) {
    if (!region || region.width < MIN_SIZE || region.height < MIN_SIZE) return null;
    const h = HANDLE_SIZE;
    const cx = region.x + region.width / 2;
    const cy = region.y + region.height / 2;
    const hits = [
      { id: 'nw', x: region.x, y: region.y },
      { id: 'n',  x: cx, y: region.y },
      { id: 'ne', x: region.x + region.width, y: region.y },
      { id: 'e',  x: region.x + region.width, y: cy },
      { id: 'se', x: region.x + region.width, y: region.y + region.height },
      { id: 's',  x: cx, y: region.y + region.height },
      { id: 'sw', x: region.x, y: region.y + region.height },
      { id: 'w',  x: region.x, y: cy },
    ];
    for (const hit of hits) {
      if (Math.abs(ex - hit.x) <= h && Math.abs(ey - hit.y) <= h) return hit.id;
    }
    // Check if inside the region (for move)
    if (ex >= region.x && ex <= region.x + region.width &&
        ey >= region.y && ey <= region.y + region.height) {
      return 'move';
    }
    return null;
  }

  function onPointerDown(event) {
    if (!overlay) return;
    overlay.setPointerCapture(event.pointerId);
    const ex = clamp(event.clientX, 0, window.innerWidth);
    const ey = clamp(event.clientY, 0, window.innerHeight);

    dragMode = getHandleAt(ex, ey);
    if (dragMode) {
      dragStart = { ex, ey, rx: region.x, ry: region.y, rw: region.width, rh: region.height };
    } else {
      // New region
      dragMode = 'new';
      dragStart = { ex, ey };
      region = { x: ex, y: ey, width: 0, height: 0 };
    }
    drawRegion();
  }

  function onPointerMove(event) {
    if (!dragMode || !dragStart) return;
    const ex = clamp(event.clientX, 0, window.innerWidth);
    const ey = clamp(event.clientY, 0, window.innerHeight);
    const dx = ex - dragStart.ex;
    const dy = ey - dragStart.ey;

    switch (dragMode) {
      case 'new':
        region.x = Math.min(dragStart.ex, ex);
        region.y = Math.min(dragStart.ey, ey);
        region.width = Math.abs(ex - dragStart.ex);
        region.height = Math.abs(ey - dragStart.ey);
        break;
      case 'move':
        region.x = clamp(dragStart.rx + dx, 0, window.innerWidth - region.width);
        region.y = clamp(dragStart.ry + dy, 0, window.innerHeight - region.height);
        break;
      case 'nw':
        region.x = clamp(dragStart.rx + dx, 0, dragStart.rx + dragStart.rw - MIN_SIZE);
        region.y = clamp(dragStart.ry + dy, 0, dragStart.ry + dragStart.rh - MIN_SIZE);
        region.width = dragStart.rx + dragStart.rw - region.x;
        region.height = dragStart.ry + dragStart.rh - region.y;
        break;
      case 'n':
        region.y = clamp(dragStart.ry + dy, 0, dragStart.ry + dragStart.rh - MIN_SIZE);
        region.height = dragStart.ry + dragStart.rh - region.y;
        break;
      case 'ne':
        region.y = clamp(dragStart.ry + dy, 0, dragStart.ry + dragStart.rh - MIN_SIZE);
        region.width = clamp(dragStart.rw + dx, MIN_SIZE, window.innerWidth - dragStart.rx);
        region.height = dragStart.ry + dragStart.rh - region.y;
        break;
      case 'e':
        region.width = clamp(dragStart.rw + dx, MIN_SIZE, window.innerWidth - dragStart.rx);
        break;
      case 'se':
        region.width = clamp(dragStart.rw + dx, MIN_SIZE, window.innerWidth - dragStart.rx);
        region.height = clamp(dragStart.rh + dy, MIN_SIZE, window.innerHeight - dragStart.ry);
        break;
      case 's':
        region.height = clamp(dragStart.rh + dy, MIN_SIZE, window.innerHeight - dragStart.ry);
        break;
      case 'sw':
        region.x = clamp(dragStart.rx + dx, 0, dragStart.rx + dragStart.rw - MIN_SIZE);
        region.width = dragStart.rx + dragStart.rw - region.x;
        region.height = clamp(dragStart.rh + dy, MIN_SIZE, window.innerHeight - dragStart.ry);
        break;
      case 'w':
        region.x = clamp(dragStart.rx + dx, 0, dragStart.rx + dragStart.rw - MIN_SIZE);
        region.width = dragStart.rx + dragStart.rw - region.x;
        break;
    }
    drawRegion();
  }

  function onPointerUp() {
    dragMode = null;
    dragStart = null;
  }

  function confirmSelection() {
    if (!region || region.width < MIN_SIZE || region.height < MIN_SIZE) return;

    const result = {
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    };

    removeOverlay();
    // Wait for the browser to finish painting the overlay removal so
    // captureVisibleTab doesn't snapshot the hint text or selection UI.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chrome.runtime.sendMessage({ type: 'selection:complete', region: result });
      });
    });
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      removeOverlay();
      chrome.runtime.sendMessage({ type: 'selection:cancelled' });
    }
    if (event.key === ' ' && event.ctrlKey) {
      event.preventDefault();
      confirmSelection();
    }
  }

  function drawRegion() {
    if (!selection) return;
    const r = region || { x: 0, y: 0, width: 0, height: 0 };
    selection.style.left = r.x + 'px';
    selection.style.top = r.y + 'px';
    selection.style.width = r.width + 'px';
    selection.style.height = r.height + 'px';

    const ids = ['nw','n','ne','e','se','s','sw','w'];
    const positions = {
      nw: [r.x, r.y],
      n:  [r.x + r.width/2, r.y],
      ne: [r.x + r.width, r.y],
      e:  [r.x + r.width, r.y + r.height/2],
      se: [r.x + r.width, r.y + r.height],
      s:  [r.x + r.width/2, r.y + r.height],
      sw: [r.x, r.y + r.height],
      w:  [r.x, r.y + r.height/2],
    };
    handles.forEach((h, i) => {
      const [px, py] = positions[ids[i]];
      h.style.left = (px - HANDLE_SIZE) + 'px';
      h.style.top = (py - HANDLE_SIZE) + 'px';
      h.style.display = r.width >= MIN_SIZE ? '' : 'none';
    });
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
    handles = [];
    dragMode = null;
    dragStart = null;
    region = null;
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

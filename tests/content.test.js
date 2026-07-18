'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_PATH = path.join(ROOT, 'extension', 'content.js');

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    }
  };
}

test('selection cancel messages are acknowledged by the content script', () => {
  const runtimeMessage = createEvent();
  const window = {
    addEventListener() {},
    removeEventListener() {},
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0
  };
  const context = {
    chrome: { runtime: { onMessage: runtimeMessage } },
    console,
    document: {},
    requestAnimationFrame(callback) { callback(); },
    window
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), context, { filename: CONTENT_PATH });

  let response;
  runtimeMessage.emit({ type: 'selection:cancel' }, {}, (value) => { response = value; });

  assert.equal(response.ok, true);
});

test('selection overlay uses a closed shadow root and ignores synthetic pointer input', () => {
  const runtimeMessage = createEvent();
  const overlayListeners = new Map();
  let shadowMode = '';
  let pointerCaptureCalls = 0;
  const makeVisual = () => ({ style: {} });
  const selection = makeVisual();
  const handles = Array.from({ length: 8 }, makeVisual);
  const hint = { ...makeVisual(), textContent: '' };
  const shadowRoot = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '.textkit-selection') return selection;
      if (selector === '.textkit-hint') return hint;
      return null;
    },
    querySelectorAll(selector) { return selector === '.textkit-handle' ? handles : []; }
  };
  const overlay = {
    className: '',
    style: {},
    attachShadow(options) { shadowMode = options.mode; return shadowRoot; },
    addEventListener(type, listener) { overlayListeners.set(type, listener); },
    removeEventListener() {},
    setPointerCapture() { pointerCaptureCalls += 1; },
    remove() {}
  };
  const windowListeners = new Map();
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    removeEventListener() {},
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0,
    devicePixelRatio: 1
  };
  const context = {
    chrome: {
      runtime: {
        onMessage: runtimeMessage,
        sendMessage: async () => ({ ok: true })
      }
    },
    console,
    document: {
      createElement() { return overlay; },
      documentElement: { appendChild() {}, scrollHeight: 800 }
    },
    requestAnimationFrame(callback) { callback(); },
    window
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), context, { filename: CONTENT_PATH });

  let response;
  runtimeMessage.emit(
    { type: 'selection:start', selectionToken: 'one-time-token' },
    {},
    (value) => { response = value; }
  );
  overlayListeners.get('pointerdown')({
    isTrusted: false,
    pointerId: 1,
    clientX: 100,
    clientY: 100
  });

  assert.equal(response.ok, true);
  assert.equal(shadowMode, 'closed');
  assert.equal(pointerCaptureCalls, 0);
  assert.ok(windowListeners.has('keydown'));
});

test('selection start without a confirmation token is rejected', () => {
  const runtimeMessage = createEvent();
  const context = {
    chrome: { runtime: { onMessage: runtimeMessage } },
    console,
    document: {},
    requestAnimationFrame(callback) { callback(); },
    window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200, scrollY: 0 }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), context, { filename: CONTENT_PATH });

  let response;
  runtimeMessage.emit({ type: 'selection:start' }, {}, (value) => { response = value; });

  assert.equal(response.ok, false);
});

test('scroll-down responds with overlap, scrollY, and atBottom detection', async () => {
  const runtimeMessage = createEvent();
  let scrollByCalls = [];
  let rafCallbacks = [];
  let rafIdx = 0;
  const window = {
    addEventListener() {},
    removeEventListener() {},
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0,
    scrollBy(opts) { scrollByCalls.push(opts); window.scrollY += opts.top; },
    devicePixelRatio: 1
  };
  const document = {
    documentElement: { scrollHeight: 2000 }
  };
  const context = {
    chrome: { runtime: { onMessage: runtimeMessage } },
    console,
    document,
    requestAnimationFrame(callback) {
      rafCallbacks.push(callback);
      return rafIdx++;
    },
    performance: { now: () => 0 },
    window
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), context, { filename: CONTENT_PATH });

  // Fire scroll-down with overlapPx=100
  let response;
  runtimeMessage.emit({ type: 'page:scroll-down', overlapPx: 100 }, {}, (value) => { response = value; });

  // Flush the waitForScrollSettle: need 2 stable rAF ticks
  const rafLen = rafCallbacks.length;
  for (let i = 0; i < rafLen; i++) rafCallbacks[i]();
  // After those callbacks, waitForScrollSettle may have registered more
  const moreRafs = rafCallbacks.length - rafLen;
  for (let i = 0; i < moreRafs; i++) rafCallbacks[rafLen + i]();

  // Need to await the async response
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(response, 'scroll-down should send a response');
  assert.equal(response.before, 0);
  assert.equal(response.scrollY, 700); // 800 - 100 = 700
  assert.equal(response.changed, true);
  assert.equal(response.atBottom, false);
  assert.equal(response.maxScrollY, 1200); // 2000 - 800
  assert.equal(typeof response.documentId, 'string');
  assert.equal(scrollByCalls.length, 1);
  assert.equal(scrollByCalls[0].top, 700);
  assert.equal(scrollByCalls[0].behavior, 'instant');
});

test('scroll-down with overlapPx >= innerHeight uses minimum distance of 1', async () => {
  const runtimeMessage = createEvent();
  let scrollByCalls = [];
  let rafCallbacks = [];
  let rafIdx = 0;
  const window = {
    addEventListener() {},
    removeEventListener() {},
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0,
    scrollBy(opts) { scrollByCalls.push(opts); window.scrollY += opts.top; },
    devicePixelRatio: 1
  };
  const document = {
    documentElement: { scrollHeight: 2000 }
  };
  const context = {
    chrome: { runtime: { onMessage: runtimeMessage } },
    console,
    document,
    requestAnimationFrame(callback) {
      rafCallbacks.push(callback);
      return rafIdx++;
    },
    performance: { now: () => 0 },
    window
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), context, { filename: CONTENT_PATH });

  let response;
  runtimeMessage.emit({ type: 'page:scroll-down', overlapPx: 900 }, {}, (value) => { response = value; });

  const rafLen = rafCallbacks.length;
  for (let i = 0; i < rafLen; i++) rafCallbacks[i]();
  const moreRafs = rafCallbacks.length - rafLen;
  for (let i = 0; i < moreRafs; i++) rafCallbacks[rafLen + i]();

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(response.scrollY, 1); // Math.max(1, 800 - 900) = 1
  assert.equal(scrollByCalls[0].top, 1);
});

test('scroll lock adds wheel, touchmove, and keydown prevention listeners', () => {
  const runtimeMessage = createEvent();
  const windowListeners = new Map();
  const window = {
    addEventListener(type, listener, opts) {
      windowListeners.set(type, { listener, opts });
    },
    removeEventListener() {},
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0,
    devicePixelRatio: 1
  };
  const context = {
    chrome: { runtime: { onMessage: runtimeMessage } },
    console,
    document: {},
    requestAnimationFrame(callback) { callback(); },
    window
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), context, { filename: CONTENT_PATH });

  let response;
  runtimeMessage.emit({ type: 'page:lock-scroll' }, {}, (value) => { response = value; });

  assert.equal(response.ok, true);
  assert.ok(windowListeners.has('wheel'), 'wheel listener should be added');
  assert.ok(windowListeners.has('touchmove'), 'touchmove listener should be added');
  assert.ok(windowListeners.has('keydown'), 'keydown listener should be added');

  // Verify wheel listener prevents default
  const wheelEvent = { preventDefault: () => {} };
  let wheelPrevented = false;
  const wheelEvt = { preventDefault() { wheelPrevented = true; } };
  windowListeners.get('wheel').listener(wheelEvt);
  assert.equal(wheelPrevented, true);

  // Verify keydown listener prevents scroll keys
  let keyPrevented = false;
  const keyEvt = { key: 'ArrowDown', preventDefault() { keyPrevented = true; } };
  windowListeners.get('keydown').listener(keyEvt);
  assert.equal(keyPrevented, true);

  // Verify keydown listener does not prevent non-scroll keys
  let nonScrollPrevented = false;
  const nonScrollEvt = { key: 'a', preventDefault() { nonScrollPrevented = true; } };
  windowListeners.get('keydown').listener(nonScrollEvt);
  assert.equal(nonScrollPrevented, false);
});

test('scroll unlock removes wheel, touchmove, and keydown listeners', () => {
  const runtimeMessage = createEvent();
  const removedTypes = [];
  const window = {
    addEventListener() {},
    removeEventListener(type) { removedTypes.push(type); },
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0,
    devicePixelRatio: 1
  };
  const context = {
    chrome: { runtime: { onMessage: runtimeMessage } },
    console,
    document: {},
    requestAnimationFrame(callback) { callback(); },
    window
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), context, { filename: CONTENT_PATH });

  // Lock first
  let lockResp;
  runtimeMessage.emit({ type: 'page:lock-scroll' }, {}, (value) => { lockResp = value; });
  assert.equal(lockResp.ok, true);

  // Now unlock
  let unlockResp;
  runtimeMessage.emit({ type: 'page:unlock-scroll' }, {}, (value) => { unlockResp = value; });

  assert.equal(unlockResp.ok, true);
  assert.ok(removedTypes.includes('wheel'));
  assert.ok(removedTypes.includes('touchmove'));
  assert.ok(removedTypes.includes('keydown'));
});

test('selection confirmation uses double-requestAnimationFrame before sending', async () => {
  const runtimeMessage = createEvent();
  let sendMessageCalls = [];
  let rafCallbacks = [];
  let rafIdx = 0;
  const overlayListeners = new Map();
  const makeVisual = () => ({ style: {} });
  const selection = makeVisual();
  const handles = Array.from({ length: 8 }, makeVisual);
  const hint = { ...makeVisual(), textContent: '' };
  const shadowRoot = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '.textkit-selection') return selection;
      if (selector === '.textkit-hint') return hint;
      return null;
    },
    querySelectorAll(selector) { return selector === '.textkit-handle' ? handles : []; }
  };
  const overlay = {
    className: '',
    style: { display: '' },
    attachShadow(options) { return shadowRoot; },
    addEventListener(type, listener) { overlayListeners.set(type, listener); },
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    remove() {}
  };
  const windowListeners = new Map();
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    removeEventListener() {},
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0,
    devicePixelRatio: 1
  };
  const context = {
    chrome: {
      runtime: {
        onMessage: runtimeMessage,
        sendMessage: async (msg) => { sendMessageCalls.push(msg); return { ok: true }; }
      }
    },
    console,
    document: {
      createElement() { return overlay; },
      documentElement: { appendChild() {}, scrollHeight: 800 }
    },
    requestAnimationFrame(callback) {
      rafCallbacks.push(callback);
      return rafIdx++;
    },
    window
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), context, { filename: CONTENT_PATH });

  // Start selection mode
  let startResp;
  runtimeMessage.emit(
    { type: 'selection:start', selectionToken: 'confirm-token' },
    {},
    (value) => { startResp = value; }
  );
  assert.equal(startResp.ok, true);

  // Simulate a pointerdown to create a region, then pointermove to size it
  overlayListeners.get('pointerdown')({
    isTrusted: true,
    pointerId: 1,
    clientX: 100,
    clientY: 100
  });
  overlayListeners.get('pointermove')({
    isTrusted: true,
    pointerId: 1,
    clientX: 300,
    clientY: 250
  });
  overlayListeners.get('pointerup')({
    isTrusted: true,
    pointerId: 1
  });

  // Now confirm via Ctrl+Space
  assert.equal(sendMessageCalls.length, 0, 'no sendMessage before confirmation');
  const keydownListener = windowListeners.get('keydown');
  assert.ok(keydownListener, 'keydown listener should be registered');

  keydownListener({ isTrusted: true, key: ' ', ctrlKey: true, preventDefault() {} });

  // After confirmSelection, overlay should be hidden and confirmPending set
  assert.equal(overlay.style.display, 'none');

  // sendMessage should NOT have been called yet (waiting for double rAF)
  assert.equal(sendMessageCalls.length, 0, 'sendMessage should not be called before double rAF');

  // Flush first rAF
  const rafCountBefore = rafCallbacks.length;
  for (let i = 0; i < rafCountBefore; i++) rafCallbacks[i]();
  // Still no sendMessage after first rAF
  assert.equal(sendMessageCalls.length, 0, 'sendMessage should not be called after first rAF');

  // Flush second rAF (the inner one registered by the first rAF callback)
  const rafCountAfter = rafCallbacks.length;
  for (let i = rafCountBefore; i < rafCountAfter; i++) rafCallbacks[i]();

  // Now sendMessage should have been called
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sendMessageCalls.length, 1, 'sendMessage should be called after double rAF');
  assert.equal(sendMessageCalls[0].type, 'selection:complete');
  assert.equal(sendMessageCalls[0].selectionToken, 'confirm-token');
  const region = sendMessageCalls[0].region;
  assert.equal(region.x, 100);
  assert.equal(region.y, 100);
  assert.equal(region.width, 200);
  assert.equal(region.height, 150);
  assert.equal(region.viewportWidth, 1200);
  assert.equal(region.viewportHeight, 800);
  assert.equal(region.devicePixelRatio, 1);
});

test('region coordinates are clamped to viewport boundaries', () => {
  const runtimeMessage = createEvent();
  const overlayListeners = new Map();
  const makeVisual = () => ({ style: {} });
  const selection = makeVisual();
  const handles = Array.from({ length: 8 }, makeVisual);
  const hint = { ...makeVisual(), textContent: '' };
  const shadowRoot = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '.textkit-selection') return selection;
      if (selector === '.textkit-hint') return hint;
      return null;
    },
    querySelectorAll(selector) { return selector === '.textkit-handle' ? handles : []; }
  };
  const overlay = {
    className: '',
    style: {},
    attachShadow(options) { return shadowRoot; },
    addEventListener(type, listener) { overlayListeners.set(type, listener); },
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    remove() {}
  };
  const window = {
    addEventListener() {},
    removeEventListener() {},
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0,
    devicePixelRatio: 1
  };
  const context = {
    chrome: {
      runtime: {
        onMessage: runtimeMessage,
        sendMessage: async () => ({ ok: true })
      }
    },
    console,
    document: {
      createElement() { return overlay; },
      documentElement: { appendChild() {}, scrollHeight: 800 }
    },
    requestAnimationFrame(callback) { callback(); },
    window
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), context, { filename: CONTENT_PATH });

  // Start selection
  let startResp;
  runtimeMessage.emit(
    { type: 'selection:start', selectionToken: 'region-token' },
    {},
    (value) => { startResp = value; }
  );
  assert.equal(startResp.ok, true);

  // Drag from bottom-right to beyond viewport (should clamp)
  overlayListeners.get('pointerdown')({
    isTrusted: true,
    pointerId: 1,
    clientX: 1000,
    clientY: 600
  });
  overlayListeners.get('pointermove')({
    isTrusted: true,
    pointerId: 1,
    clientX: 1500,  // beyond viewport width of 1200
    clientY: 1000   // beyond viewport height of 800
  });
  overlayListeners.get('pointerup')({ isTrusted: true, pointerId: 1 });

  // Verify the selection div was positioned correctly (clamped)
  // Region x should be 1000, y=600, width=200 (1200-1000), height=200 (800-600)
  assert.equal(selection.style.left, '1000px');
  assert.equal(selection.style.top, '600px');
  assert.equal(selection.style.width, '200px');
  assert.equal(selection.style.height, '200px');
});

test('region rejects areas smaller than MIN_SIZE', () => {
  const runtimeMessage = createEvent();
  const overlayListeners = new Map();
  let sendMessageCalls = [];
  const makeVisual = () => ({ style: {} });
  const selection = makeVisual();
  const handles = Array.from({ length: 8 }, makeVisual);
  const hint = { ...makeVisual(), textContent: '' };
  const shadowRoot = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '.textkit-selection') return selection;
      if (selector === '.textkit-hint') return hint;
      return null;
    },
    querySelectorAll(selector) { return selector === '.textkit-handle' ? handles : []; }
  };
  const overlay = {
    className: '',
    style: { display: '' },
    attachShadow(options) { return shadowRoot; },
    addEventListener(type, listener) { overlayListeners.set(type, listener); },
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    remove() {}
  };
  const windowListeners = new Map();
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    removeEventListener() {},
    innerHeight: 800,
    innerWidth: 1200,
    scrollY: 0,
    devicePixelRatio: 1
  };
  const context = {
    chrome: {
      runtime: {
        onMessage: runtimeMessage,
        sendMessage: async (msg) => { sendMessageCalls.push(msg); return { ok: true }; }
      }
    },
    console,
    document: {
      createElement() { return overlay; },
      documentElement: { appendChild() {}, scrollHeight: 800 }
    },
    requestAnimationFrame(callback) { callback(); },
    window
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), context, { filename: CONTENT_PATH });

  // Start selection
  runtimeMessage.emit(
    { type: 'selection:start', selectionToken: 'tiny-token' },
    {},
    () => {}
  );

  // Create a tiny region (5x5, below MIN_SIZE of 10)
  overlayListeners.get('pointerdown')({
    isTrusted: true,
    pointerId: 1,
    clientX: 100,
    clientY: 100
  });
  overlayListeners.get('pointermove')({
    isTrusted: true,
    pointerId: 1,
    clientX: 104,
    clientY: 104
  });
  overlayListeners.get('pointerup')({ isTrusted: true, pointerId: 1 });

  // Try to confirm via Ctrl+Space — should be rejected by confirmSelection guard
  const keydownListener = windowListeners.get('keydown');
  keydownListener({ isTrusted: true, key: ' ', ctrlKey: true, preventDefault() {} });

  // No sendMessage should have been triggered
  assert.equal(sendMessageCalls.length, 0, 'tiny region should not trigger confirmation');
  // Overlay should NOT be hidden
  assert.equal(overlay.style.display, '');
});

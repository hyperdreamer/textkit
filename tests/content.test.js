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
      return listeners.map((listener) => listener(...args));
    }
  };
}

const SELECTION_R = { x: 100, y: 100, width: 200, height: 150 };
const selectionPlain = (value) => JSON.parse(JSON.stringify(value));
const selectionSettled = () => new Promise((resolve) => setImmediate(resolve));
function selectionDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function selectionHarness() {
  const runtimeMessage = createEvent();
  const windowListeners = new Map();
  const h = {
    overlays: [], frames: [], sends: [], bindings: [], pointerEvents: 0,
    bindingSend: null, completeSend: () => Promise.resolve({ ok: true })
  };
  h.window = {
    innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, scrollY: 0,
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (windowListeners.get(type) === listener) windowListeners.delete(type);
    }
  };
  const document = {
    documentElement: { appendChild() {}, scrollHeight: 800 },
    createElement() {
      const listeners = new Map();
      const selection = { style: {} };
      const handles = Array.from({ length: 8 }, () => ({ style: {} }));
      const writes = [];
      let text = '';
      const hint = {
        style: {},
        get textContent() { return text; },
        set textContent(value) { text = value; writes.push(value); },
        set innerHTML(_value) { assert.fail('hint must use textContent'); }
      };
      const root = {
        innerHTML: '',
        querySelector(selector) {
          return selector === '.textkit-selection' ? selection
            : selector === '.textkit-hint' ? hint : null;
        },
        querySelectorAll(selector) { return selector === '.textkit-handle' ? handles : []; }
      };
      const owner = {
        style: { display: '' }, listeners, selection, hint, root, writes,
        removed: false, captures: 0, shadowMode: null,
        attachShadow(options) { owner.shadowMode = options.mode; return root; },
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type) { listeners.delete(type); },
        setPointerCapture() { owner.captures += 1; },
        releasePointerCapture() {},
        remove() { owner.removed = true; }
      };
      h.overlays.push(owner);
      return owner;
    }
  };
  const context = {
    console, document, window: h.window,
    requestAnimationFrame(callback) { h.frames.push(callback); },
    chrome: { runtime: {
      onMessage: runtimeMessage,
      sendMessage(message) {
        h.sends.push(selectionPlain(message));
        if (message.type === 'commands:binding') {
          const gate = selectionDeferred();
          h.bindings.push(gate);
          return h.bindingSend ? h.bindingSend(gate) : gate.promise;
        }
        if (message.type === 'selection:complete') return h.completeSend(message);
        return Promise.resolve();
      }
    } }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CONTENT_PATH, 'utf8'), context, { filename: CONTENT_PATH });
  Object.defineProperty(h, 'current', { get: () => h.overlays.at(-1) });
  h.deliver = (message) => {
    const responses = [];
    const returns = runtimeMessage.emit(message, {}, (value) => responses.push(selectionPlain(value)));
    return { returns, responses };
  };
  h.start = (saved, token = 'confirm-token') => h.deliver({
    type: 'selection:start', lastRegion: saved, selectionToken: token
  });
  h.confirm = () => h.deliver({ type: 'selection:confirm' });
  h.completions = () => h.sends.filter((message) => message.type === 'selection:complete');
  h.pointer = (type, x, y, trusted = true) => {
    h.pointerEvents += 1;
    h.current.listeners.get(type)({
      isTrusted: trusted, pointerId: 1, clientX: x, clientY: y
    });
  };
  h.draw = (x1 = 100, y1 = 100, x2 = 300, y2 = 250) => {
    h.pointer('pointerdown', x1, y1);
    h.pointer('pointermove', x2, y2);
    h.pointer('pointerup', x2, y2);
  };
  h.key = (fields) => {
    let prevented = false;
    windowListeners.get('keydown')?.({
      isTrusted: true, preventDefault() { prevented = true; }, ...fields
    });
    return prevented;
  };
  h.flushFrame = () => {
    const batch = h.frames.splice(0);
    batch.forEach((callback) => callback());
    return batch.length;
  };
  h.finish = async () => {
    const before = h.completions().length;
    assert.equal(h.flushFrame(), 1);
    assert.equal(h.completions().length, before);
    assert.equal(h.flushFrame(), 1);
    assert.equal(h.completions().length, before + 1);
    await selectionSettled();
  };
  return h;
}
function assertConfirmReply(h) {
  assert.deepEqual(h.confirm(), { returns: [false], responses: [{ ok: true }] },
    'C01 confirm route must reply synchronously');
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

  overlayListeners.get('pointermove')({
    isTrusted: false, pointerId: 1, clientX: 300, clientY: 250
  });
  assert.equal(selection.style.left, '0px');
  assert.equal(selection.style.top, '0px');
  assert.equal(selection.style.width, '0px');
  assert.equal(selection.style.height, '0px');
  assert.equal(pointerCaptureCalls, 0);
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

// C01: preserve this test name; Task 7 adds the pinned fixture comparison.
test('selection confirmation uses double-requestAnimationFrame before sending', async () => {
  const h = selectionHarness();
  assert.deepEqual(h.start(), { returns: [false], responses: [{ ok: true }] });
  h.draw();
  const owner = h.current;
  assertConfirmReply(h);
  assert.equal(owner.style.display, 'none');
  assert.equal(h.completions().length, 0);
  assert.equal(h.frames.length, 1);
  await h.finish();
  assert.deepEqual(h.completions(), [{
    type: 'selection:complete',
    region: { ...SELECTION_R, viewportWidth: 1200, viewportHeight: 800, devicePixelRatio: 1 },
    selectionToken: 'confirm-token'
  }]);
  assert.equal(owner.removed, true);
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

// C05: negative control cannot pass by removing all confirmation behavior.
test('region rejects areas smaller than MIN_SIZE', async () => {
  const h = selectionHarness();
  h.start();
  h.draw(100, 100, 104, 104);
  assertConfirmReply(h);
  assert.equal(h.frames.length, 0);
  assert.deepEqual(h.completions(), []);
  assert.equal(h.current.style.display, '');
  assert.equal(h.current.removed, false);
  h.draw(100, 100, 300, 250);
  assertConfirmReply(h);
  await h.finish();
  assert.deepEqual(h.completions()[0].region,
    { ...SELECTION_R, viewportWidth: 1200, viewportHeight: 800, devicePixelRatio: 1 });
  assert.equal(h.current.removed, true);
});

test('C02 duplicate confirms while framed or awaiting admission emit once', async () => {
  const h = selectionHarness();
  const completion = selectionDeferred();
  h.completeSend = () => completion.promise;
  h.start();
  h.draw();
  assertConfirmReply(h);
  assertConfirmReply(h);
  assert.equal(h.frames.length, 1);
  await h.finish();
  assertConfirmReply(h);
  assert.equal(h.frames.length, 0);
  assert.equal(h.completions().length, 1);
  completion.resolve({ ok: true });
  await selectionSettled();
  assert.equal(h.current.removed, true);
});

test('C03 absent or dismissed overlay acknowledges without creation then admits live control', async () => {
  const h = selectionHarness();
  assertConfirmReply(h);
  assert.equal(h.overlays.length, 0);
  assert.equal(h.frames.length, 0);
  h.start(SELECTION_R);
  h.deliver({ type: 'selection:cancel' });
  assert.equal(h.current.removed, true);
  assertConfirmReply(h);
  assert.equal(h.overlays.length, 1);
  assert.equal(h.frames.length, 0);
  assert.deepEqual(h.completions(), []);
  h.start(SELECTION_R);
  assertConfirmReply(h);
  await h.finish();
  assert.equal(h.completions().length, 1);
});

test('C04 missing empty and non-string tokens reject start and cannot confirm', async () => {
  for (const token of [undefined, '', null, 42]) {
    const h = selectionHarness();
    assert.deepEqual(h.deliver({ type: 'selection:start', selectionToken: token }), {
      returns: [false],
      responses: [{ ok: false, error: 'Missing selection confirmation token.' }]
    });
    assertConfirmReply(h);
    assert.equal(h.overlays.length, 0);
    assert.equal(h.frames.length, 0);
    assert.deepEqual(h.completions(), []);
    h.start(SELECTION_R);
    assertConfirmReply(h);
    await h.finish();
    assert.equal(h.completions().length, 1);
  }
});

test('C06 exactly ten by ten remains a valid region', async () => {
  const h = selectionHarness();
  h.start();
  h.draw(100, 100, 110, 110);
  assertConfirmReply(h);
  await h.finish();
  assert.equal(h.completions()[0].region.width, 10);
  assert.equal(h.completions()[0].region.height, 10);
});

test('C08 trusted idle Escape preserves cancellation token and prevents later confirmation', () => {
  const h = selectionHarness();
  h.start(SELECTION_R);
  h.key({ key: 'Escape' });
  assert.equal(h.current.removed, true);
  assert.deepEqual(h.sends.filter((m) => m.type === 'selection:cancelled'), [
    { type: 'selection:cancelled', selectionToken: 'confirm-token' }
  ]);
  assertConfirmReply(h);
  assert.equal(h.frames.length, 0);
  assert.deepEqual(h.completions(), []);
});

test('C09 untrusted and missing-trust Escape leave selection usable', async () => {
  for (const trust of [false, undefined]) {
    const h = selectionHarness();
    h.start(SELECTION_R);
    h.key({ key: 'Escape', isTrusted: trust });
    assert.equal(h.current.removed, false);
    assert.deepEqual(h.sends.filter((m) => m.type === 'selection:cancelled'), []);
    assertConfirmReply(h);
    await h.finish();
    assert.equal(h.completions().length, 1);
  }
});

test('C10 pending guard prevents Escape from clearing the queued token', async () => {
  const h = selectionHarness();
  h.start(SELECTION_R);
  assertConfirmReply(h);
  h.key({ key: 'Escape' });
  assert.equal(h.current.removed, false);
  assert.equal(h.current.style.display, 'none');
  assert.deepEqual(h.sends.filter((m) => m.type === 'selection:cancelled'), []);
  await h.finish();
  assert.equal(h.completions().length, 1);
  assert.equal(h.completions()[0].selectionToken, 'confirm-token');
});

test('C35 rejected completion restores diagnostic without resend and permits later acceptance', async () => {
  const h = selectionHarness();
  h.completeSend = () => Promise.resolve({
    ok: false, error: 'Selection confirmation is stale or unauthorized.'
  });
  h.start(SELECTION_R);
  assertConfirmReply(h);
  await h.finish();
  assert.equal(h.current.style.display, '');
  assert.equal(h.current.removed, false);
  assert.equal(h.current.hint.textContent,
    'Selection confirmation is stale or unauthorized. Adjust the region and try again.');
  assert.equal(h.frames.length, 0);
  assert.equal(h.completions().length, 1);
  h.completeSend = () => Promise.resolve({ ok: true });
  assertConfirmReply(h);
  await h.finish();
  assert.equal(h.completions().length, 2);
  assert.equal(h.current.removed, true);
});

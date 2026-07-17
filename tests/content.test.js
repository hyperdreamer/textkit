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

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

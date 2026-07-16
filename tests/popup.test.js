'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const POPUP_PATH = path.join(ROOT, 'extension', 'popup.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(1);
  }
  assert.fail(message);
}

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    }
  };
}

function createElement(id = '') {
  const listeners = new Map();
  const classes = new Set();
  return {
    id,
    value: '',
    checked: false,
    disabled: false,
    readOnly: false,
    textContent: '',
    dataset: {},
    children: [],
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const shouldAdd = force === undefined ? !classes.has(name) : force;
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      }
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener({ target: this });
    },
    replaceChildren(...children) { this.children = children; },
    select() {}
  };
}

function createPopupHarness(options = {}) {
  const elements = new Map();
  const localData = { ...(options.localData || {}) };
  const syncData = { ...(options.syncData || {}) };
  let timerId = 0;

  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    createElement(tagName) { return createElement(tagName); },
    addEventListener() {},
    execCommand() { return true; }
  };
  document.getElementById('backend-host').value = 'localhost';
  document.getElementById('backend-port').value = '8765';
  document.getElementById('tl-language').value = 'original';
  document.getElementById('tl2-language').value = 'original';

  const runtimeMessage = createEvent();
  const chrome = {
    runtime: {
      onMessage: runtimeMessage,
      sendMessage() { return Promise.resolve({ ok: true }); }
    },
    storage: {
      local: {
        get(keys, callback) {
          let result = {};
          if (typeof keys === 'string') result[keys] = localData[keys];
          else if (Array.isArray(keys)) {
            for (const key of keys) result[key] = localData[key];
          } else if (keys && typeof keys === 'object') {
            result = { ...keys };
            for (const key of Object.keys(keys)) {
              if (Object.hasOwn(localData, key)) result[key] = localData[key];
            }
          } else result = { ...localData };
          if (callback) {
            callback(result);
            return undefined;
          }
          return Promise.resolve(result);
        },
        set(values) { Object.assign(localData, values); return Promise.resolve(); },
        remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete localData[key];
          return Promise.resolve();
        }
      },
      sync: {
        get(defaults) { return Promise.resolve({ ...defaults, ...syncData }); },
        set(values) { Object.assign(syncData, values); return Promise.resolve(); },
        remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete syncData[key];
          return Promise.resolve();
        }
      }
    },
    tabs: { query: async () => [{ id: 1, windowId: 10, active: true }] },
    downloads: { download() {} },
    notifications: { create() {} }
  };

  const context = {
    AbortController,
    Blob,
    URL,
    chrome,
    clearTimeout() {},
    console,
    document,
    fetch: options.fetch || fetch,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout() { timerId += 1; return timerId; }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(POPUP_PATH, 'utf8'), context, { filename: POPUP_PATH });

  return { context, elements, localData, runtimeMessage, syncData };
}

test('prompt refresh rejects stale generations and dirty textareas', () => {
  const harness = createPopupHarness();
  const prompt = harness.elements.get('ocr-prompt');
  const staleGeneration = harness.context._beginPromptRefresh(prompt, { resetDirty: true });
  const currentGeneration = harness.context._beginPromptRefresh(prompt);

  assert.equal(harness.context._applyIfDifferent(prompt, 'stale', staleGeneration), false);
  assert.equal(harness.context._applyIfDifferent(prompt, 'current', currentGeneration), true);
  harness.context._markPromptDirty(prompt);
  assert.equal(harness.context._applyIfDifferent(prompt, 'server overwrite', currentGeneration), false);
  assert.equal(prompt.value, 'current');
});

test('language prompt refresh does not clobber an edit made while fetch is pending', async () => {
  const response = deferred();
  let fetchCalls = 0;
  const harness = createPopupHarness({
    localData: { 'translatePrompt:English': 'local prompt' },
    fetch: async () => {
      fetchCalls += 1;
      return response.promise;
    }
  });
  const language = harness.elements.get('tl-language');
  const prompt = harness.elements.get('translate-prompt');
  language.value = 'English';

  await harness.context.loadPromptForLanguage();
  await waitFor(() => fetchCalls === 1, 'language prompt fetch did not start');
  assert.equal(prompt.value, 'local prompt');

  prompt.value = 'user edit';
  prompt.dispatch('input');
  response.resolve({
    ok: true,
    json: async () => ({ template: 'backend prompt', has_language_param: false })
  });
  await delay();
  await delay();

  assert.equal(prompt.value, 'user edit');
});

test('path suggestions fall back to local history when the backend fails', async () => {
  const harness = createPopupHarness({
    localData: {
      tl2PathHistory: ['notes/today.md', 'notes/archive.md', 'other/file.txt']
    },
    fetch: async () => { throw new Error('offline'); }
  });

  await harness.context.fetchPathSuggestions('notes/');

  assert.deepEqual(
    harness.elements.get('tl2-path-suggestions').children.map((option) => option.value),
    ['notes/today.md', 'notes/archive.md']
  );
});

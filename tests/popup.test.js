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
  const syncData = { fileBridgeToken: 'bridge-secret', ...(options.syncData || {}) };
  let timerId = 0;
  const timers = new Map();

  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    createElement(tagName) { return createElement(tagName); },
    addEventListener() {},
    execCommand() { return options.execCommand ? options.execCommand() : true; }
  };
  document.getElementById('backend-host').value = 'localhost';
  document.getElementById('backend-port').value = '8765';
  document.getElementById('file-bridge-host').value = '';
  document.getElementById('file-bridge-port').value = '8766';
  document.getElementById('tl-language').value = 'original';
  document.getElementById('tl2-language').value = 'original';

  const runtimeMessage = createEvent();
  const chrome = {
    runtime: {
      lastError: options.runtimeLastError,
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
    downloads: {
      download(downloadOptions, callback) {
        if (options.download) return options.download(downloadOptions, callback);
        callback?.(1);
        return undefined;
      }
    },
    notifications: { create() {} }
  };

  const context = {
    AbortController,
    Blob,
    URL,
    chrome,
    clearTimeout(id) { timers.delete(id); },
    console,
    document,
    fetch: options.fetch || fetch,
    navigator: {
      clipboard: {
        writeText: options.writeText || (async () => {})
      }
    },
    setTimeout(callback) {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(POPUP_PATH, 'utf8'), context, { filename: POPUP_PATH });

  async function runTimers() {
    const callbacks = [...timers.values()];
    timers.clear();
    await Promise.all(callbacks.map((callback) => callback()));
  }

  return { context, elements, localData, runTimers, runtimeMessage, syncData };
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

test('fallback refresh does not clobber an edit made while fetch is pending', async () => {
  const response = deferred();
  let fetchCalls = 0;
  const harness = createPopupHarness({
    fetch: async () => {
      fetchCalls += 1;
      return response.promise;
    }
  });
  const language = harness.elements.get('tl-language');
  const prompt = harness.elements.get('translate-prompt');
  language.value = 'English';

  await harness.context.loadPromptForLanguage();
  await waitFor(() => fetchCalls === 1, 'fallback fetch did not start');
  assert.equal(prompt.value, '');

  prompt.value = 'user edit';
  prompt.dispatch('input');
  response.resolve({
    ok: true,
    status: 200,
    json: async () => ({ template: 'backend prompt', source: 'file', version: 'v1' })
  });
  await delay();
  await delay();

  assert.equal(prompt.value, 'user edit');
});

test('fallback preview stays separate and can be copied or reset', async () => {
  const harness = createPopupHarness({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ template: 'Server OCR default', source: 'file', version: 'abc' })
    })
  });
  const config = vm.runInContext('PROMPT_CONFIGS.ocr', harness.context);
  const prompt = harness.elements.get('ocr-prompt');

  await harness.context.refreshFallback(config, { force: true });
  assert.equal(prompt.value, 'Server OCR default');

  // Simulate user edit: typing marks dirty and saves to localStorage
  prompt.value = 'Server OCR default';
  prompt.dispatch('input');
  assert.equal(harness.localData.ocrPrompt, 'Server OCR default');

  await harness.context.resetPromptToFallback(config);
  assert.equal(prompt.value, 'Server OCR default');
  assert.equal(Object.hasOwn(harness.localData, 'ocrPrompt'), false);
});

test('prompt edits save immediately without writing backend prompts', async () => {
  const fetchCalls = [];
  const harness = createPopupHarness({
    fetch: async (...args) => { fetchCalls.push(args); return { ok: true, status: 200 }; }
  });
  const prompt = harness.elements.get('dedup-prompt');

  prompt.value = 'First edit';
  prompt.dispatch('input');
  prompt.value = 'Final edit';
  prompt.dispatch('input');

  assert.equal(harness.localData.dedupPrompt, 'Final edit');
  assert.equal(fetchCalls.length, 0);
});

test('stale forced fallback response cannot overwrite the current cache', async () => {
  const first = deferred();
  const second = deferred();
  let fetchCalls = 0;
  const harness = createPopupHarness({
    fetch: async () => {
      fetchCalls += 1;
      return fetchCalls === 1 ? first.promise : second.promise;
    }
  });
  const config = vm.runInContext('PROMPT_CONFIGS.ocr', harness.context);
  const prompt = harness.elements.get('ocr-prompt');

  const firstRefresh = harness.context.refreshFallback(config, { force: true });
  await waitFor(() => fetchCalls === 1, 'first fallback request did not start');
  const secondRefresh = harness.context.refreshFallback(config, { force: true });
  await waitFor(() => fetchCalls === 2, 'second fallback request did not start');

  second.resolve({
    ok: true,
    status: 200,
    json: async () => ({ template: 'new prompt', source: 'file', version: 'new' })
  });
  await secondRefresh;
  first.resolve({
    ok: true,
    status: 200,
    json: async () => ({ template: 'stale prompt', source: 'file', version: 'old' })
  });
  await firstRefresh;

  const cacheKey = 'promptFallback:localhost:8765:ocr:';
  assert.equal(harness.localData[cacheKey].template, 'new prompt');
  assert.equal(prompt.value, 'new prompt');
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

test('path suggestions use configured file bridge settings', async () => {
  let requestedUrl = '';
  const harness = createPopupHarness({
    syncData: { fileBridgeHost: '127.0.0.1', fileBridgePort: 8766 },
    fetch: async (url) => {
      requestedUrl = String(url);
      return { ok: true, json: async () => ({ paths: ['notes/today.md'] }) };
    }
  });

  await harness.context.fetchPathSuggestions('notes/');

  assert.equal(requestedUrl, 'http://127.0.0.1:8766/paths?prefix=notes%2F');
  assert.deepEqual(
    harness.elements.get('tl2-path-suggestions').children.map((option) => option.value),
    ['notes/today.md']
  );
});

test('blank file bridge host uses localhost with its configured port', async () => {
  let requestedUrl = '';
  const harness = createPopupHarness({
    syncData: {
      backendHost: '127.0.0.1',
      backendPort: 9876,
      fileBridgeHost: '',
      fileBridgePort: 9777
    },
    fetch: async (url) => {
      requestedUrl = String(url);
      return { ok: true, json: async () => ({ paths: [] }) };
    }
  });

  await harness.context.fetchPathSuggestions('');

  assert.equal(requestedUrl, 'http://localhost:9777/paths?prefix=');
});

test('slow path response cannot overwrite newer suggestions', async () => {
  const first = deferred();
  const second = deferred();
  let fetchCalls = 0;
  const harness = createPopupHarness({
    fetch: async () => {
      fetchCalls += 1;
      return fetchCalls === 1 ? first.promise : second.promise;
    }
  });

  const oldRequest = harness.context.fetchPathSuggestions('old');
  const newRequest = harness.context.fetchPathSuggestions('new');
  second.resolve({ ok: true, json: async () => ({ paths: ['new/result.txt'] }) });
  await newRequest;
  first.resolve({ ok: true, json: async () => ({ paths: ['old/stale.txt'] }) });
  await oldRequest;

  assert.deepEqual(
    harness.elements.get('tl2-path-suggestions').children.map((option) => option.value),
    ['new/result.txt']
  );
});

test('manual clipboard failure is reported instead of silently succeeding', async () => {
  const harness = createPopupHarness({
    writeText: async () => { throw new Error('clipboard denied'); },
    execCommand: () => false
  });
  harness.elements.get('result').value = 'text to copy';

  const copied = await harness.context.copyOcrText();

  assert.equal(copied, false);
  assert.equal(harness.elements.get('progress').textContent, 'Copy failed: Clipboard copy was rejected.');
  assert.equal(harness.elements.get('copy').textContent, '');
});

test('manual download failure is reported instead of silently succeeding', async () => {
  const harness = createPopupHarness({
    runtimeLastError: { message: 'downloads blocked' },
    download(_options, callback) { callback(undefined); }
  });
  harness.elements.get('result').value = 'text to download';

  const downloaded = await harness.context.downloadOcrText();

  assert.equal(downloaded, false);
  assert.equal(harness.elements.get('progress').textContent, 'Download failed: downloads blocked');
  assert.equal(harness.elements.get('download').textContent, '');
});

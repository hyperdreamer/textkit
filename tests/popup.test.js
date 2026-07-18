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
  const runtimeMessages = [];
  const syncWrites = [];
  const permissionContainsCalls = [];
  const permissionRequestCalls = [];
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
  document.getElementById('file-bridge-port').value = '8964';
  document.getElementById('tl-language').value = 'original';
  document.getElementById('tl2-language').value = 'original';

  const runtimeMessage = createEvent();
  const chrome = {
    runtime: {
      lastError: options.runtimeLastError,
      onMessage: runtimeMessage,
      sendMessage(message) {
        runtimeMessages.push(message);
        return options.runtimeSendMessage ? options.runtimeSendMessage(message) : Promise.resolve({ ok: true });
      }
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
        set(values) { syncWrites.push(values); Object.assign(syncData, values); return Promise.resolve(); },
        remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete syncData[key];
          return Promise.resolve();
        }
      }
    },
    permissions: {
      async contains(details) {
        permissionContainsCalls.push(details);
        return options.permissionContains ? options.permissionContains(details) : true;
      },
      async request(details) {
        permissionRequestCalls.push(details);
        return options.permissionRequest ? options.permissionRequest(details) : true;
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

  return {
    context,
    elements,
    localData,
    permissionContainsCalls,
    permissionRequestCalls,
    runTimers,
    runtimeMessage,
    runtimeMessages,
    syncData,
    syncWrites
  };
}

test('popup backend ports must be complete decimal strings', () => {
  const harness = createPopupHarness();

  assert.equal(harness.context.normalizeBackendSettings('localhost', ' 8765 ').port, 8765);
  for (const malformed of ['8765junk', '1e3', '8765.9', '', '  ']) {
    assert.throws(
      () => harness.context.normalizeBackendSettings('localhost', malformed),
      /Backend port must be between 1 and 65535/
    );
  }
});

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

test('server fallback shown inline in textarea, reset clears custom', async () => {
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
  // Fallback shown inline in textarea, grayed out
  assert.equal(prompt.value, 'Server OCR default');
  assert.ok(prompt.classList.contains('server-default'));

  // User types a custom prompt — dirty flag set, class removed
  prompt.value = 'Custom OCR prompt';
  prompt.dispatch('input');
  assert.equal(harness.localData.ocrPrompt, 'Custom OCR prompt');
  assert.ok(!prompt.classList.contains('server-default'));

  // Reset to server default
  await harness.context.resetPromptToFallback(config);
  assert.equal(prompt.value, 'Server OCR default');
  assert.ok(prompt.classList.contains('server-default'));
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

test('unedited server default in textarea is not sent as custom prompt', async () => {
  const harness = createPopupHarness({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ template: 'Server fallback', source: 'file', version: 'v1' })
    })
  });
  const config = vm.runInContext('PROMPT_CONFIGS.ocr', harness.context);
  await harness.context.refreshFallback(config, { force: true });

  // Fallback shown inline but dirty=false — not sent
  await harness.context.startCapture();
  const first = harness.runtimeMessages.find((message) => message.type === 'popup:start');
  assert.equal(Object.hasOwn(first, 'prompts'), false);

  // User explicitly edits — now it's a custom prompt
  const promptEl = harness.elements.get('ocr-prompt');
  promptEl.value = 'Explicit override';
  promptEl.dispatch('input');  // sets dirty flag
  await harness.context.startCapture();
  const starts = harness.runtimeMessages.filter((message) => message.type === 'popup:start');
  assert.equal(starts.at(-1).prompts.ocr, 'Explicit override');
  assert.equal(Object.hasOwn(starts.at(-1).prompts, 'dedup'), false);
});

test('capture start persists and sends one normalized backend snapshot', async () => {
  const harness = createPopupHarness();
  harness.elements.get('backend-host').value = 'HTTP://LOCALHOST';
  harness.elements.get('backend-port').value = '9876';
  harness.elements.get('ocr-autoscroll').checked = true;
  harness.elements.get('ocr-capture-interval').value = '250';

  await harness.context.startCapture();

  const start = harness.runtimeMessages.find((message) => message.type === 'popup:start');
  assert.deepEqual({ ...start.backend }, { host: 'localhost', port: 9876 });
  assert.equal(harness.syncData.backendHost, 'localhost');
  assert.equal(harness.syncData.backendPort, 9876);
  assert.equal(harness.syncData.captureIntervalMs, 250);
});

test('popup restores persisted OCR status before rendering Idle state', async () => {
  const harness = createPopupHarness({
    localData: { 'lastResult:1': 'restored result', 'lastStatus:1': 'Done' },
    runtimeSendMessage: async (message) => message.type === 'popup:get-state'
      ? { ok: true, tabId: 1, state: { status: 'Idle', active: false, progress: 'Ready' } }
      : { ok: true },
    fetch: async () => ({ ok: false, status: 503 })
  });

  await harness.context.init();

  assert.equal(harness.elements.get('status').textContent, 'Done');
  assert.equal(harness.elements.get('result').value, 'restored result');
});

test('popup preserves terminal translation and format errors when no operation is active', async () => {
  const harness = createPopupHarness({
    localData: {
      'tl2Status:1': 'Translation provider unavailable',
      'fmtStatus:1': 'Formatting provider unavailable'
    },
    runtimeSendMessage: async (message) => message.type === 'popup:get-state'
      ? { ok: true, tabId: 1, state: { status: 'Idle', active: false, progress: 'Ready' } }
      : { ok: true },
    fetch: async () => ({ ok: false, status: 503 })
  });

  await harness.context.init();

  assert.equal(harness.elements.get('tl2-status-text').textContent, 'Translation provider unavailable');
  assert.equal(harness.elements.get('fmt-status-text').textContent, 'Formatting provider unavailable');
});

test('successful host permission refreshes fallback previews', async () => {
  let fetchCalls = 0;
  let granted = false;
  const harness = createPopupHarness({
    permissionContains: async () => granted,
    permissionRequest: async () => { granted = true; return true; },
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ template: 'Granted preview', source: 'file', version: 'v1' })
      };
    }
  });

  assert.equal(await harness.context.ensureHostPermission('localhost'), true);
  await waitFor(() => fetchCalls === 4, 'fallback previews were not refreshed after permission grant');
});

test('failed translation and format Stop responses preserve running UI', async () => {
  const harness = createPopupHarness({
    runtimeSendMessage: async (message) => {
      if (message.type === 'translate:stop') return { ok: false, error: 'translation stop rejected' };
      if (message.type === 'format:stop') return { ok: false, error: 'format stop rejected' };
      return { ok: true };
    }
  });
  vm.runInContext('currentTabId = 1', harness.context);
  harness.elements.get('tl2-translate').textContent = 'Stop';
  harness.elements.get('fmt-format').textContent = 'Stop';

  assert.equal(await harness.context.stopTranslation(), false);
  assert.equal(await harness.context.stopFormat(), false);

  assert.equal(harness.elements.get('tl2-translate').textContent, 'Stop');
  assert.ok(harness.elements.get('tl2-translate').classList.contains('danger'));
  assert.match(harness.elements.get('tl2-status-text').textContent, /translation stop rejected/);
  assert.equal(harness.elements.get('fmt-format').textContent, 'Stop');
  assert.ok(harness.elements.get('fmt-format').classList.contains('danger'));
  assert.match(harness.elements.get('fmt-status-text').textContent, /format stop rejected/);
});

test('persisted prompt overrides survive fallback refresh and are sent as custom', async () => {
  const harness = createPopupHarness({
    localData: { ocrPrompt: 'Persisted OCR override' },
    runtimeSendMessage: async (message) => message.type === 'popup:get-state'
      ? { ok: true, tabId: 1, state: { status: 'Idle', active: false, progress: 'Ready' } }
      : { ok: true },
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => String(url).includes('/fallback')
        ? { template: 'Server fallback', source: 'file', version: 'v1' }
        : { paths: [] }
    })
  });

  await harness.context.init();
  await delay();
  const prompt = harness.elements.get('ocr-prompt');
  assert.equal(prompt.value, 'Persisted OCR override');
  assert.ok(!prompt.classList.contains('server-default'));

  await harness.context.startCapture();
  const start = harness.runtimeMessages.find((message) => message.type === 'popup:start');
  assert.equal(start.prompts.ocr, 'Persisted OCR override');
});

test('inline translation and format fallbacks are not sent as overrides', async () => {
  const harness = createPopupHarness({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ template: 'Inline server fallback', source: 'file', version: 'v1' })
    }),
    runtimeSendMessage: async (message) => message.type === 'popup:get-state'
      ? { ok: true, tabId: 1, state: { status: 'Idle', active: false, progress: 'Ready' } }
      : { ok: true }
  });
  await harness.context.init();
  harness.elements.get('result').value = 'source text';
  harness.elements.get('tl2-result').value = 'translated text';

  await harness.context.refreshFallback(vm.runInContext('PROMPT_CONFIGS.translate', harness.context), { force: true });
  await harness.context.refreshFallback(vm.runInContext('PROMPT_CONFIGS.format', harness.context), { force: true });
  await harness.context.doTranslation();
  harness.elements.get('tl2-result').value = 'translated text';
  harness.elements.get('fmt-result').value = 'formatted text';
  await harness.context.doFormat();

  const translate = harness.runtimeMessages.find((message) => message.type === 'translate:start');
  const format = harness.runtimeMessages.find((message) => message.type === 'format:start');
  assert.ok(translate, 'translate:start message was not sent');
  assert.ok(format, 'format:start message was not sent');
  assert.equal(Object.hasOwn(translate, 'prompt'), false);
  assert.equal(Object.hasOwn(format, 'prompt'), false);
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
  // Fallback shown inline in textarea
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

test('path suggestions reject drive-relative, UNC, device, and colon paths', () => {
  const harness = createPopupHarness();
  for (const unsafe of [
    'C:relative.txt',
    'C:/absolute.txt',
    '//server/share/file.txt',
    '\\\\?\\C:\\device.txt',
    'notes/name:stream.txt'
  ]) {
    assert.equal(harness.context.isSafeRelativePath(unsafe), false, unsafe);
  }
  assert.equal(harness.context.isSafeRelativePath('notes/safe.txt'), true);
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

test('path suggestion requests abort after the timeout', async () => {
  const harness = createPopupHarness({
    localData: { tl2PathHistory: ['notes/fallback.txt'] },
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      if (options.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  });

  const request = harness.context.fetchPathSuggestions('notes/');
  await harness.runTimers();
  await request;

  assert.deepEqual(
    harness.elements.get('tl2-path-suggestions').children.map((option) => option.value),
    ['notes/fallback.txt']
  );
});

test('path setting writes are debounced and flush on blur', async () => {
  const harness = createPopupHarness({
    fetch: async () => ({ ok: true, json: async () => ({ paths: [] }) })
  });
  const input = harness.elements.get('tl2-autosave-path');

  input.value = 'n';
  input.dispatch('input');
  input.value = 'notes/out.txt';
  input.dispatch('input');
  assert.equal(harness.syncWrites.length, 0);

  input.dispatch('blur');
  await delay();
  assert.equal(harness.syncWrites.length, 1);
  assert.equal(harness.syncData.tl2AutoSavePath, 'notes/out.txt');
});

test('OCR edits and format path settings flush only on commit events', async () => {
  const harness = createPopupHarness({
    fetch: async () => ({ ok: true, json: async () => ({ paths: [] }) })
  });
  vm.runInContext('currentTabId = 1', harness.context);
  const result = harness.elements.get('result');
  const formatPath = harness.elements.get('fmt-save-path');

  result.value = 'draft';
  result.dispatch('input');
  result.value = 'final OCR edit';
  result.dispatch('input');
  formatPath.value = 'draft.md';
  formatPath.dispatch('input');
  formatPath.value = 'notes/final.md';
  formatPath.dispatch('input');

  assert.equal(Object.hasOwn(harness.localData, 'lastResult:1'), false);
  assert.equal(Object.hasOwn(harness.syncData, 'fmtSavePath'), false);
  result.dispatch('change');
  formatPath.dispatch('blur');
  await delay();

  assert.equal(harness.localData['lastResult:1'], 'final OCR edit');
  assert.equal(harness.syncData.fmtSavePath, 'notes/final.md');
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

test('manual file bridge saves request configured host permission', async () => {
  const harness = createPopupHarness({
    syncData: { fileBridgeHost: '127.0.0.1', fileBridgePort: 8766 },
    permissionContains: async () => false,
    permissionRequest: async () => false
  });
  vm.runInContext('currentTabId = 1', harness.context);
  harness.elements.get('tl2-result').value = 'translation';
  harness.elements.get('tl2-autosave-path').value = 'notes/translation.txt';
  harness.elements.get('fmt-result').value = 'formatted';
  harness.elements.get('fmt-save-path').value = 'notes/formatted.txt';

  await harness.context.saveTranslation();
  await harness.context.saveFormatResult();

  assert.equal(harness.permissionContainsCalls.length, 2);
  assert.equal(harness.permissionContainsCalls[0].origins.length, 1);
  assert.equal(harness.permissionContainsCalls[0].origins[0], 'http://127.0.0.1/*');
  assert.equal(harness.permissionContainsCalls[1].origins.length, 1);
  assert.equal(harness.permissionContainsCalls[1].origins[0], 'http://127.0.0.1/*');
  assert.equal(harness.permissionRequestCalls.length, 2);
  assert.equal(harness.permissionRequestCalls[0].origins.length, 1);
  assert.equal(harness.permissionRequestCalls[0].origins[0], 'http://127.0.0.1/*');
  assert.equal(harness.permissionRequestCalls[1].origins.length, 1);
  assert.equal(harness.permissionRequestCalls[1].origins[0], 'http://127.0.0.1/*');
  assert.equal(
    harness.runtimeMessages.filter((message) => message.type === 'save:translation').length,
    0
  );
  assert.match(harness.elements.get('tl2-status-text').textContent, /permission was not granted/);
  assert.match(harness.elements.get('fmt-status-text').textContent, /permission was not granted/);
});

test('auto-save toggles refuse to enable without file bridge permission', async () => {
  const harness = createPopupHarness({
    syncData: { fileBridgeHost: '127.0.0.1', fileBridgePort: 8766 },
    permissionContains: async () => false,
    permissionRequest: async () => false
  });
  const translationAutoSave = harness.elements.get('tl2-autosave');
  const formatAutoSave = harness.elements.get('fmt-autosave');

  translationAutoSave.checked = true;
  translationAutoSave.dispatch('change');
  formatAutoSave.checked = true;
  formatAutoSave.dispatch('change');
  await waitFor(() => harness.syncWrites.length === 2, 'auto-save settings were not persisted');

  assert.equal(translationAutoSave.checked, false);
  assert.equal(formatAutoSave.checked, false);
  assert.equal(harness.syncData.tl2AutoSave, false);
  assert.equal(harness.syncData.fmtAutoSave, false);
  assert.equal(harness.permissionRequestCalls.length, 2);
  assert.match(harness.elements.get('tl2-status-text').textContent, /was not enabled/);
  assert.match(harness.elements.get('fmt-status-text').textContent, /was not enabled/);
});

test('language switch does not save server fallback as a custom prompt', async () => {
  const harness = createPopupHarness({
    localData: {},
    runtimeSendMessage: async (message) => message.type === 'popup:get-state'
      ? { ok: true, tabId: 1, state: { status: 'Idle', active: false, progress: 'Ready' } }
      : { ok: true },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ template: 'Server fallback for {language}', source: 'file', version: 'v1' })
    })
  });
  await harness.context.init();

  // Simulate: user was on 'original', server fallback is shown, never customized.
  const promptEl = harness.elements.get('translate-prompt');
  promptEl.value = 'Server fallback for {language}';
  promptEl.classList.add('server-default');
  vm.runInContext('promptEditorLanguage = "original"', harness.context);
  vm.runInContext('tlLanguage.value = "English"', harness.context);

  // Switch language to English
  await harness.context.onTlLanguageChange();

  // The server fallback should NOT have been saved under translatePrompt:original
  assert.equal(Object.hasOwn(harness.localData, 'translatePrompt:original'), false);

  // The async refreshFallback re-applies server-default after fetch completes.
  // Wait for the fallback to land (fetch mock resolves immediately, but it's async).
  await delay();
  assert.ok(promptEl.classList.contains('server-default'));
  assert.ok(promptEl.value.includes('Server fallback'));
});

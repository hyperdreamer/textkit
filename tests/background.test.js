'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const BACKGROUND_PATH = path.join(ROOT, 'extension', 'background.js');

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
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    }
  };
}

function createBackgroundHarness(options = {}) {
  const tabs = new Map((options.tabs || [{ id: 1, windowId: 10, active: true }])
    .map((tab) => [tab.id, { ...tab }]));
  const onActivated = createEvent();
  const onRemoved = createEvent();
  const onAttached = createEvent();
  const onDetached = createEvent();
  const onStorageChanged = createEvent();
  const captureCalls = [];
  const messageCalls = [];
  const ocrCalls = [];
  const cropCalls = [];
  const finalized = [];
  const localData = { ...(options.localData || {}) };
  const syncValues = {
    ocrAutoscroll: false,
    captureIntervalMs: 0,
    ...(options.syncValues || {})
  };

  const events = {
    runtimeMessage: createEvent(),
    command: createEvent(),
    onActivated,
    onRemoved,
    onAttached,
    onDetached,
    onStorageChanged
  };

  const chrome = {
    storage: {
      onChanged: onStorageChanged,
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
        set(values) {
          Object.assign(localData, values);
          return Promise.resolve();
        },
        remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete localData[key];
          return Promise.resolve();
        }
      },
      sync: {
        get(defaults) {
          return Promise.resolve({ ...defaults, ...syncValues });
        },
        set(values) {
          Object.assign(syncValues, values);
          return Promise.resolve();
        }
      }
    },
    tabs: {
      onActivated,
      onRemoved,
      onAttached,
      onDetached,
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return { ...tab };
      },
      async query(queryInfo = {}) {
        if (Object.keys(queryInfo).length === 0) {
          return [...tabs.values()].map((tab) => ({ ...tab }));
        }
        const tabId = options.popupTabId || 1;
        const tab = tabs.get(tabId);
        return tab ? [{ ...tab }] : [];
      },
      async captureVisibleTab(windowId, captureOptions) {
        captureCalls.push({ windowId, captureOptions });
        if (options.captureVisibleTab) {
          return options.captureVisibleTab(windowId, captureOptions, captureCalls.length);
        }
        return `data:image/png;base64,frame-${captureCalls.length}`;
      },
      async sendMessage(tabId, message) {
        messageCalls.push({ tabId, message });
        if (options.sendMessage) return options.sendMessage(tabId, message);
        if (message.type === 'page:scroll-down') return { changed: false, atBottom: true, scrollY: 100 };
        return { ok: true };
      }
    },
    commands: { onCommand: events.command },
    runtime: {
      onMessage: events.runtimeMessage,
      sendMessage() { return Promise.resolve(); },
      getPlatformInfo(callback) { if (callback) callback({}); }
    },
    scripting: {
      executeScript() { return Promise.resolve(); },
      insertCSS() { return Promise.resolve(); }
    },
    offscreen: {
      createDocument() { return Promise.resolve(); },
      closeDocument() { return Promise.resolve(); }
    },
    notifications: { create() {} },
    downloads: { download() { return Promise.resolve(1); } }
  };

  const context = {
    AbortController,
    Blob,
    FormData,
    URL,
    chrome,
    clearInterval,
    clearTimeout,
    console,
    fetch: options.fetch || fetch,
    setInterval: () => 1,
    setTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  context.importScripts = (...scriptPaths) => {
    for (const scriptPath of scriptPaths) {
      const absolutePath = path.join(ROOT, 'extension', scriptPath);
      vm.runInContext(fs.readFileSync(absolutePath, 'utf8'), context, { filename: absolutePath });
    }
  };
  vm.runInContext(fs.readFileSync(BACKGROUND_PATH, 'utf8'), context, { filename: BACKGROUND_PATH });
  const originalFinalizeCapture = vm.runInContext('finalizeCapture', context);

  context.__testCrop = async (dataUrl, region) => {
    cropCalls.push({ dataUrl, region });
    return new Blob(['cropped'], { type: 'image/png' });
  };
  context.__testOcr = async (blob, pageNumber) => {
    ocrCalls.push({ blob, pageNumber });
    return `page ${pageNumber}`;
  };
  context.__testFinalize = async (tabId, text, fragments) => {
    finalized.push({ tabId, text, fragments: [...fragments] });
    return text;
  };
  vm.runInContext(`
    cropVisibleCapture = (...args) => __testCrop(...args);
    postImageForOcr = (...args) => __testOcr(...args);
    finalizePostCapture = (...args) => __testFinalize(...args);
    finalizeCapture = (...args) => __testFinalize(...args);
  `, context);

  function setActive(tabId) {
    const target = tabs.get(tabId);
    assert(target, `missing tab ${tabId}`);
    for (const tab of tabs.values()) {
      if (tab.windowId === target.windowId) tab.active = false;
    }
    target.active = true;
    onActivated.emit({ tabId, windowId: target.windowId });
  }

  function removeTab(tabId) {
    tabs.delete(tabId);
    onRemoved.emit(tabId, { windowId: -1, isWindowClosing: false });
  }

  return {
    captureCalls,
    context,
    cropCalls,
    finalized,
    events,
    localData,
    messageCalls,
    ocrCalls,
    originalFinalizeCapture,
    removeTab,
    setActive,
    syncValues,
    tabs
  };
}

const REGION = {
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  viewportWidth: 100,
  viewportHeight: 100
};

test('safe capture accepts a frame when the target stays active', async () => {
  const harness = createBackgroundHarness();
  await harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  assert.equal(harness.captureCalls.length, 1);
  assert.equal(harness.captureCalls[0].windowId, 10);
  assert.equal(harness.cropCalls.length, 1);
  assert.deepEqual(harness.ocrCalls.map((call) => call.pageNumber), [1]);
});

test('inactive target pauses without capture, OCR, or scroll, then resumes the same page', async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 1, windowId: 10, active: false },
      { id: 2, windowId: 10, active: true }
    ]
  });
  const capturePromise = harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  await delay(10);

  assert.equal(harness.context.getState(1).status, 'Paused');
  assert.equal(harness.context.getState(1).active, true);
  assert.equal(harness.context.getState(1).currentPage, 1);
  assert.equal(
    harness.context.getState(1).progress,
    'Capture paused — return to the capture tab to continue.'
  );
  assert.equal(harness.captureCalls.length, 0);
  assert.equal(harness.ocrCalls.length, 0);
  assert.equal(harness.messageCalls.filter((call) => call.message.type === 'page:scroll-down').length, 0);

  harness.setActive(1);
  await capturePromise;
  assert.equal(harness.captureCalls.length, 1);
  assert.deepEqual(harness.ocrCalls.map((call) => call.pageNumber), [1]);
});

test('A to B during capture rejects the frame before crop and retries the same page', async () => {
  const firstFrame = deferred();
  const harness = createBackgroundHarness({
    tabs: [
      { id: 1, windowId: 10, active: true },
      { id: 2, windowId: 10, active: false }
    ],
    captureVisibleTab(_windowId, _captureOptions, callNumber) {
      return callNumber === 1 ? firstFrame.promise : 'data:image/png;base64,good';
    }
  });
  const capturePromise = harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  await waitFor(() => harness.captureCalls.length === 1, 'first capture did not start');

  harness.setActive(2);
  firstFrame.resolve('data:image/png;base64,wrong-tab');
  await delay(10);
  assert.equal(harness.cropCalls.length, 0);
  assert.equal(harness.ocrCalls.length, 0);

  harness.setActive(1);
  await capturePromise;
  assert.equal(harness.captureCalls.length, 2);
  assert.deepEqual(harness.ocrCalls.map((call) => call.pageNumber), [1]);
});

test('A to B to A during capture rejects the frame by activation generation', async () => {
  const firstFrame = deferred();
  const harness = createBackgroundHarness({
    tabs: [
      { id: 1, windowId: 10, active: true },
      { id: 2, windowId: 10, active: false }
    ],
    captureVisibleTab(_windowId, _captureOptions, callNumber) {
      return callNumber === 1 ? firstFrame.promise : 'data:image/png;base64,good';
    }
  });
  const capturePromise = harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  await waitFor(() => harness.captureCalls.length === 1, 'first capture did not start');

  harness.setActive(2);
  harness.setActive(1);
  firstFrame.resolve('data:image/png;base64,stale');
  await capturePromise;

  assert.equal(harness.captureCalls.length, 2);
  assert.equal(harness.cropCalls.length, 1);
  assert.deepEqual(harness.ocrCalls.map((call) => call.pageNumber), [1]);
});

test('a target moved to another window uses its live window id', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 22, active: true }]
  });
  await harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  assert.deepEqual(harness.captureCalls.map((call) => call.windowId), [22]);
});

test('Stop while paused resolves promptly without starting capture', async () => {
  const frame = deferred();
  const harness = createBackgroundHarness({
    tabs: [
      { id: 1, windowId: 10, active: false },
      { id: 2, windowId: 10, active: true }
    ],
    popupTabId: 1,
    captureVisibleTab() { return frame.promise; }
  });
  const capturePromise = harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  await delay(10);
  await harness.context.handleStop();
  const outcome = await Promise.race([
    capturePromise.then(() => 'resolved'),
    delay(100).then(() => 'timeout')
  ]);

  if (outcome === 'timeout') frame.resolve('data:image/png;base64,cleanup');
  await capturePromise;
  assert.equal(outcome, 'resolved');
  assert.equal(harness.captureCalls.length, 0);
});

test('a missing target exits without capturing a replacement tab', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 2, windowId: 10, active: true }]
  });
  await harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  assert.equal(harness.captureCalls.length, 0);
  assert.equal(harness.cropCalls.length, 0);
  assert.equal(harness.ocrCalls.length, 0);
});

test('a stable captureVisibleTab error surfaces as a genuine error', async () => {
  const harness = createBackgroundHarness({
    captureVisibleTab() { throw new Error('screen capture unavailable'); }
  });
  await assert.rejects(
    harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION),
    /screen capture unavailable/
  );
  assert.equal(harness.captureCalls.length, 1);
  assert.equal(harness.cropCalls.length, 0);
  assert.equal(harness.ocrCalls.length, 0);
});

test('normal scroll waits for the target to become active again', async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 1, windowId: 10, active: true },
      { id: 2, windowId: 10, active: false }
    ],
    syncValues: { ocrAutoscroll: true }
  });
  harness.context.__testOcr = async (blob, pageNumber) => {
    harness.ocrCalls.push({ blob, pageNumber });
    harness.setActive(2);
    return `page ${pageNumber}`;
  };
  const capturePromise = harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  await waitFor(() => harness.context.getState(1).status === 'Paused', 'capture did not pause before scroll');

  assert.equal(harness.context.getState(1).fragmentsCollected, 1);
  assert.equal(harness.messageCalls.filter((call) => call.message.type === 'page:scroll-down').length, 0);
  harness.setActive(1);
  await capturePromise;
  assert.equal(harness.messageCalls.filter((call) => call.message.type === 'page:scroll-down').length, 1);
});

test('bottom recheck scroll also waits for the active target', async () => {
  let scrollCalls = 0;
  const harness = createBackgroundHarness({
    tabs: [
      { id: 1, windowId: 10, active: true },
      { id: 2, windowId: 10, active: false }
    ],
    syncValues: { ocrAutoscroll: true },
    sendMessage(_tabId, message) {
      if (message.type !== 'page:scroll-down') return { ok: true };
      scrollCalls += 1;
      if (scrollCalls === 1) return { changed: true, atBottom: true, scrollY: 100 };
      return { changed: false, atBottom: true, scrollY: 100 };
    }
  });
  vm.runInContext('sleep = async () => {};', harness.context);
  harness.context.__testOcr = async (blob, pageNumber) => {
    harness.ocrCalls.push({ blob, pageNumber });
    if (pageNumber === 2) harness.setActive(2);
    return `page ${pageNumber}`;
  };
  const capturePromise = harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  await waitFor(() => harness.context.getState(1).status === 'Paused', 'capture did not pause before bottom recheck');

  assert.equal(scrollCalls, 1);
  assert.equal(harness.context.getState(1).fragmentsCollected, 2);
  harness.setActive(1);
  await capturePromise;
  assert.equal(scrollCalls, 2);
});

for (const mode of ['run', 'resume']) {
  test(`${mode} loop uses the shared inactive-target safeguard`, async () => {
    const harness = createBackgroundHarness({
      tabs: [
        { id: 1, windowId: 10, active: false },
        { id: 2, windowId: 10, active: true }
      ]
    });
    const capturePromise = mode === 'run'
      ? harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION)
      : harness.context.resumeCaptureLoop({
          tab: { id: 1, windowId: 10, active: true },
          region: REGION,
          fragments: [],
          lastScrollY: -1,
          winId: 10
        });
    await delay(10);
    const capturesWhileInactive = harness.captureCalls.length;
    harness.setActive(1);
    await capturePromise;

    assert.equal(capturesWhileInactive, 0);
    assert.deepEqual(harness.ocrCalls.map((call) => call.pageNumber), [1]);
  });
}

test('uncertain aligned anchors retain the complete next fragment', () => {
  const { context } = createBackgroundHarness();
  assert.equal(context.mergeFragments(['A\nX\nC', 'A\nY\nC']), 'A\nX\nC\nA\nY\nC');
});

test('two-line exact contiguous overlap deduplicates once', () => {
  const { context } = createBackgroundHarness();
  assert.equal(context.mergeFragments(['A\nB\nC', 'B\nC\nD']), 'A\nB\nC\nD');
});

test('singleton repeated line does not authorize deletion', () => {
  const { context } = createBackgroundHarness();
  assert.equal(context.mergeFragments(['A\nB', 'B\nC']), 'A\nB\nB\nC');
});

test('no overlap retains both complete fragments', () => {
  const { context } = createBackgroundHarness();
  assert.equal(context.mergeFragments(['A\nB', 'C\nD']), 'A\nB\nC\nD');
});

test('internal blank paragraphs survive two and three merges', () => {
  const { context } = createBackgroundHarness();
  assert.equal(
    context.mergeFragments(['A\n\nB\nC', 'B\nC\n\nD']),
    'A\n\nB\nC\n\nD'
  );
  assert.equal(
    context.mergeFragments(['A\n\nB\nC', 'B\nC\n\nD\nE', 'D\nE\n\nF']),
    'A\n\nB\nC\n\nD\nE\n\nF'
  );
});

test('blank-only overlap does not authorize deletion', () => {
  const { context } = createBackgroundHarness();
  assert.equal(context.findLineOverlap(['A', '', ''], ['', '', 'B']), 0);
  assert.equal(context.mergeFragments(['A\n\n', '\n\nB']), 'A\nB');
});

test('indentation and internal spaces of unmatched lines survive', () => {
  const { context } = createBackgroundHarness();
  assert.equal(
    context.mergeFragments(['  indented\nshared one\nshared two', 'shared one\nshared two\nkept  internal   spaces']),
    '  indented\nshared one\nshared two\nkept  internal   spaces'
  );
});

test('CRLF is normalized without losing paragraph boundaries', () => {
  const { context } = createBackgroundHarness();
  assert.equal(
    context.mergeFragments(['A\r\n\r\nB\r\nC', 'B\r\nC\r\n\r\nD']),
    'A\n\nB\nC\n\nD'
  );
});

test('a mismatching line between equal anchors is retained', () => {
  const { context } = createBackgroundHarness();
  assert.equal(
    context.mergeFragments(['start\nanchor one\nleft only\nanchor two', 'anchor one\nright only\nanchor two\nend']),
    'start\nanchor one\nleft only\nanchor two\nanchor one\nright only\nanchor two\nend'
  );
});

test('worker startup broadcasts scroll unlock to every open tab', async () => {
  const harness = createBackgroundHarness({
    tabs: [
      { id: 1, windowId: 10, active: true },
      { id: 2, windowId: 10, active: false }
    ]
  });
  await waitFor(
    () => harness.messageCalls.filter((call) => call.message.type === 'page:unlock-scroll').length === 2,
    'startup scroll recovery did not message all tabs'
  );
  assert.deepEqual(
    harness.messageCalls
      .filter((call) => call.message.type === 'page:unlock-scroll')
      .map((call) => call.tabId)
      .sort(),
    [1, 2]
  );
});

test('backend endpoint cache is invalidated when host settings change', async () => {
  const harness = createBackgroundHarness({ syncValues: { backendPort: 8765 } });
  assert.equal(await harness.context.getBackendEndpoint('/ocr'), 'http://localhost:8765/ocr');
  harness.syncValues.backendPort = 9876;
  assert.equal(await harness.context.getBackendEndpoint('/ocr'), 'http://localhost:8765/ocr');

  harness.events.onStorageChanged.emit({ backendPort: { oldValue: 8765, newValue: 9876 } }, 'sync');
  assert.equal(await harness.context.getBackendEndpoint('/ocr'), 'http://localhost:9876/ocr');
});

test('file bridge endpoint uses separate settings and invalidates its cache', async () => {
  const harness = createBackgroundHarness({
    syncValues: { fileBridgeHost: '127.0.0.1', fileBridgePort: 8766 }
  });
  assert.equal(await harness.context.getFileBridgeEndpoint('/save'), 'http://127.0.0.1:8766/save');
  harness.syncValues.fileBridgePort = 9777;
  assert.equal(await harness.context.getFileBridgeEndpoint('/save'), 'http://127.0.0.1:8766/save');

  harness.events.onStorageChanged.emit({ fileBridgePort: { oldValue: 8766, newValue: 9777 } }, 'sync');
  assert.equal(await harness.context.getFileBridgeEndpoint('/save'), 'http://127.0.0.1:9777/save');
});

test('file bridge endpoint falls back to the main backend during migration', async () => {
  const harness = createBackgroundHarness({
    syncValues: { backendHost: 'localhost', backendPort: 8765, fileBridgeHost: '' }
  });

  assert.equal(await harness.context.getFileBridgeEndpoint('/save'), 'http://localhost:8765/save');
});

test('a non-OCR capture failure finalizes fragments already collected', async () => {
  const harness = createBackgroundHarness();
  const state = harness.context.getState(1);
  state.fragments = ['first fragment', 'second fragment'];
  vm.runInContext("runCaptureLoop = async () => { throw new Error('scroll failed'); };", harness.context);

  let response;
  harness.events.runtimeMessage.emit(
    { type: 'selection:complete', region: REGION },
    { tab: { id: 1, windowId: 10, active: true } },
    (value) => { response = value; }
  );
  assert.equal(response.ok, true);
  await waitFor(() => harness.finalized.length === 1, 'partial fragments were not finalized');
  assert.equal(harness.finalized[0].tabId, 1);
  assert.deepEqual(harness.finalized[0].fragments, ['first fragment', 'second fragment']);
});

test('failed selection start resets active state to Error', async () => {
  const harness = createBackgroundHarness({
    sendMessage(_tabId, message) {
      if (message.type === 'selection:start') throw new Error('content script unavailable');
      return { ok: true };
    }
  });
  await assert.rejects(harness.context.handlePopupStart(), /content script unavailable/);
  assert.equal(harness.context.getState(1).active, false);
  assert.equal(harness.context.getState(1).status, 'Error');
});

test('Stop cancels an in-progress selection', async () => {
  const harness = createBackgroundHarness();
  harness.context.updateState(1, { active: true, status: 'Selecting' });

  await harness.context.handleStop();

  assert.equal(harness.context.getState(1).active, false);
  assert.equal(harness.context.getState(1).status, 'Cancelled');
  assert.equal(
    harness.messageCalls.filter((call) => call.message.type === 'selection:cancel').length,
    1
  );
});

test('manual translation substitutes every language placeholder in a custom prompt', async () => {
  let requestBody;
  const harness = createBackgroundHarness({
    localData: {
      'translatePrompt:French': 'Translate to {language}. Answer only in {language}.'
    },
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ text: 'bonjour' }) };
    }
  });

  const result = await harness.context.handleTranslateStart({
    tabId: 1,
    text: 'hello',
    language: 'French',
    host: 'localhost',
    port: 8765
  });

  assert.equal(result.ok, true);
  assert.equal(requestBody.prompt, 'Translate to French. Answer only in French.');
});

test('capture prompt overrides are snapshotted when selection starts', async () => {
  const harness = createBackgroundHarness({
    localData: { ocrPrompt: 'stored OCR', dedupPrompt: 'stored dedup' }
  });

  await harness.context.handlePopupStart({
    prompts: { ocr: 'popup OCR', dedup: 'popup dedup' }
  });
  await harness.context.chrome.storage.local.set({
    ocrPrompt: 'edited later',
    dedupPrompt: 'edited later'
  });

  assert.deepEqual(
    { ...harness.context.getState(1).operationPrompts },
    { ocr: 'popup OCR', dedup: 'popup dedup' }
  );
});

test('manual format reads the stored prompt once when the operation starts', async () => {
  let requestBody;
  const response = deferred();
  const harness = createBackgroundHarness({
    localData: { formatPrompt: 'Initial format prompt' },
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return response.promise;
    }
  });

  const operation = harness.context.handleFormatStart({
    tabId: 1,
    text: 'hello',
    host: 'localhost',
    port: 8765
  });
  await waitFor(() => requestBody, 'format request did not start');
  await harness.context.chrome.storage.local.set({ formatPrompt: 'Edited later' });
  response.resolve({ ok: true, json: async () => ({ text: 'HELLO' }) });

  const result = await operation;
  assert.equal(result.ok, true);
  assert.equal(requestBody.prompt, 'Initial format prompt');
});

test('OCR-source auto-format runs once even when auto-translate also completes', async () => {
  const harness = createBackgroundHarness({
    localData: { formatPrompt: 'Clean up the text.' },
    syncValues: {
      fmtAutoFormat: true,
      fmtSourceVal: 'ocr',
      ocrAutoTranslate: true
    }
  });
  harness.context.__formatCalls = [];
  vm.runInContext(`
    handleFormatStart = async (message) => { __formatCalls.push(message); return { ok: true }; };
    autoTranslateIfEnabled = async (tabId) => {
      await autoFormatIfEnabled(tabId, 'translated text', undefined, undefined, 'translation');
    };
  `, harness.context);

  await harness.originalFinalizeCapture(1, 'ocr text', ['ocr text']);

  assert.equal(harness.context.__formatCalls.length, 1);
  assert.equal(harness.context.__formatCalls[0].text, 'ocr text');
});

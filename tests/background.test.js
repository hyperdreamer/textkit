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

function jsonResponse(payload, status = 200) {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? 'application/json' : null },
    text: async () => body
  };
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
  const onUpdated = createEvent();
  const onRemoved = createEvent();
  const onAttached = createEvent();
  const onDetached = createEvent();
  const onStorageChanged = createEvent();
  const captureCalls = [];
  const messageCalls = [];
  const ocrCalls = [];
  const cropCalls = [];
  const finalized = [];
  const runtimeMessages = [];
  const notifications = [];
  const permissionContainsCalls = [];
  const permissionRequestCalls = [];
  let offscreenCreateCalls = 0;
  let offscreenCloseCalls = 0;
  const localData = { ...(options.localData || {}) };
  const syncValues = {
    ocrAutoscroll: false,
    ...(options.syncValues || {})
  };

  const events = {
    runtimeMessage: createEvent(),
    command: createEvent(),
    onActivated,
    onUpdated,
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
      onUpdated,
      onRemoved,
      onAttached,
      onDetached,
      async get(tabId) {
        if (options.getTab) return options.getTab(tabId, tabs);
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
    runtime: {
      onMessage: events.runtimeMessage,
      sendMessage(message) {
        runtimeMessages.push(message);
        if (options.runtimeSendMessage) return options.runtimeSendMessage(message);
        return Promise.resolve();
      },
      getPlatformInfo(callback) { if (callback) callback({}); }
    },
    scripting: {
      executeScript() { return Promise.resolve(); },
      insertCSS() { return Promise.resolve(); }
    },
    offscreen: {
      hasDocument() {
        return options.offscreenHasDocument ? options.offscreenHasDocument() : Promise.resolve(false);
      },
      createDocument() {
        offscreenCreateCalls += 1;
        return options.offscreenCreateDocument ? options.offscreenCreateDocument() : Promise.resolve();
      },
      closeDocument() { offscreenCloseCalls += 1; return Promise.resolve(); }
    },
    notifications: {
      create(id, options) { notifications.push({ id, options }); }
    },
    downloads: { download() { return Promise.resolve(1); } }
  };

  const context = {
    AbortController,
    Blob,
    FormData,
    OffscreenCanvas: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        this.record = { width, height, drawImage: null };
        cropCalls.push(this.record);
      }
      getContext(type) {
        if (type !== '2d') return null;
        return {
          drawImage: (_bitmap, ...args) => { this.record.drawImage = args; }
        };
      }
      convertToBlob() {
        return Promise.resolve(new Blob([`${this.width}x${this.height}`], { type: 'image/png' }));
      }
    },
    TextEncoder,
    URL,
    chrome,
    clearInterval,
    clearTimeout,
    console,
    createImageBitmap: async () => ({
      width: options.imageBitmapSize?.width || 100,
      height: options.imageBitmapSize?.height || 100,
      close() {}
    }),
    fetch: (url, ...args) => String(url).startsWith('data:')
      ? fetch(url, ...args)
      : (options.fetch || fetch)(url, ...args),
    setInterval: () => 1,
    setTimeout: options.setTimeout || setTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  context.importScripts = (...scriptPaths) => {
    for (const scriptPath of scriptPaths) {
      const absolutePath = path.join(ROOT, 'extension', scriptPath);
      vm.runInContext(fs.readFileSync(absolutePath, 'utf8'), context, { filename: absolutePath });
    }
  };
  let backgroundSource = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  if (options.maxCapturePages) {
    backgroundSource = backgroundSource.replace(
      'const MAX_CAPTURE_PAGES = 500;',
      `const MAX_CAPTURE_PAGES = ${options.maxCapturePages};`
    );
  }
  vm.runInContext(backgroundSource, context, { filename: BACKGROUND_PATH });
  const originalFinalizeCapture = vm.runInContext('finalizeCapture', context);
  const originalFinalizePostCapture = vm.runInContext('finalizePostCapture', context);

  context.__testCrop = async (dataUrl, region) => {
    cropCalls.push({ dataUrl, region });
    return new Blob(['cropped'], { type: 'image/png' });
  };
  context.__testOcr = async (blob, pageNumber) => {
    ocrCalls.push({ blob, pageNumber });
    return `page ${pageNumber}`;
  };
  context.__testFinalize = async (tabId, text, fragmentsOrCount) => {
    finalized.push({
      tabId,
      text,
      fragmentCount: Array.isArray(fragmentsOrCount) ? fragmentsOrCount.length : fragmentsOrCount
    });
    return text;
  };
  if (!options.useRealPipeline) {
    vm.runInContext('cropVisibleCapture = (...args) => __testCrop(...args);', context);
  }
  if (!options.useRealPipeline) {
    vm.runInContext(`
      postImageForOcr = (...args) => __testOcr(...args);
      finalizePostCapture = (...args) => __testFinalize(...args);
      finalizeCapture = (...args) => __testFinalize(...args);
    `, context);
  }

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

  function navigate(tabId, url) {
    const tab = tabs.get(tabId);
    assert(tab, `missing tab ${tabId}`);
    tab.url = url;
    onUpdated.emit(tabId, { url }, { ...tab });
  }

  return {
    captureCalls,
    context,
    cropCalls,
    finalized,
    events,
    localData,
    messageCalls,
    navigate,
    notifications,
    ocrCalls,
    originalFinalizeCapture,
    originalFinalizePostCapture,
    permissionContainsCalls,
    permissionRequestCalls,
    get offscreenCreateCalls() { return offscreenCreateCalls; },
    get offscreenCloseCalls() { return offscreenCloseCalls; },
    removeTab,
    runtimeMessages,
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

test('abortable retry sleep wakes on abort without rejecting', async () => {
  const harness = createBackgroundHarness();
  const controller = new AbortController();
  const sleepPromise = vm.runInContext('abortableSleep', harness.context)(60_000, controller.signal);

  controller.abort();
  await Promise.race([
    sleepPromise,
    delay(100).then(() => assert.fail('abortable sleep did not wake promptly'))
  ]);
});

test('abortable retry sleep tolerates an absent signal', async () => {
  const harness = createBackgroundHarness();
  await vm.runInContext('abortableSleep', harness.context)(0);
});

test('safe capture accepts a frame when the target stays active', async () => {
  const harness = createBackgroundHarness();
  await harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  assert.equal(harness.captureCalls.length, 1);
  assert.equal(harness.captureCalls[0].windowId, 10);
  assert.equal(harness.cropCalls.length, 1);
  assert.deepEqual(harness.ocrCalls.map((call) => call.pageNumber), [1]);
});

test('page limit is partial only when more content remains', async () => {
  let scrollCalls = 0;
  const harness = createBackgroundHarness({
    maxCapturePages: 2,
    syncValues: { ocrAutoscroll: true },
    sendMessage(_tabId, message) {
      if (message.type !== 'page:scroll-down') return { ok: true };
      scrollCalls += 1;
      return { changed: true, atBottom: false, scrollY: scrollCalls * 100 };
    }
  });
  vm.runInContext('sleep = async () => {};', harness.context);

  await harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);

  assert.equal(harness.captureCalls.length, 2);
  assert.equal(harness.context.getState(1).partialReason, 'page_limit');
  assert.equal(harness.context.getState(1).partialError, 'Capture truncated at the 2-page limit.');
});

test('page limit remains complete when the last allowed page is actually the bottom', async () => {
  let scrollCalls = 0;
  const harness = createBackgroundHarness({
    maxCapturePages: 2,
    syncValues: { ocrAutoscroll: true },
    sendMessage(_tabId, message) {
      if (message.type !== 'page:scroll-down') return { ok: true };
      scrollCalls += 1;
      return scrollCalls === 1
        ? { changed: true, atBottom: false, scrollY: 100 }
        : { changed: false, atBottom: true, scrollY: 100 };
    }
  });
  vm.runInContext('sleep = async () => {};', harness.context);

  await harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);

  assert.equal(harness.captureCalls.length, 2);
  assert.equal(harness.context.getState(1).partialReason, '');
  assert.equal(harness.finalized[0].text, 'page 1\npage 2');
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

test('same-tab navigation stops before a new document frame can be mixed in', async () => {
  const secondFrame = deferred();
  let scrollCalls = 0;
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: 'https://example.test/first' }],
    syncValues: { ocrAutoscroll: true },
    captureVisibleTab(_windowId, _captureOptions, callNumber) {
      return callNumber === 2 ? secondFrame.promise : 'data:image/png;base64,first-page';
    },
    sendMessage(_tabId, message) {
      if (message.type !== 'page:scroll-down') return { ok: true };
      scrollCalls += 1;
      return { changed: true, atBottom: false, scrollY: scrollCalls * 100 };
    }
  });
  vm.runInContext('sleep = async () => {};', harness.context);

  const capturePromise = harness.context.runCaptureLoop(
    { id: 1, windowId: 10, active: true, url: 'https://example.test/first' },
    REGION
  );
  await waitFor(() => harness.captureCalls.length === 2, 'second capture did not start');

  harness.navigate(1, 'https://example.test/second');
  secondFrame.resolve('data:image/png;base64,new-document');
  await capturePromise;

  assert.equal(harness.cropCalls.length, 1);
  assert.deepEqual(harness.ocrCalls.map((call) => call.pageNumber), [1]);
  assert.equal(harness.finalized[0].text, 'page 1');
  assert.equal(harness.finalized[0].fragmentCount, 1);
  assert.equal(harness.context.getState(1).partialReason, 'navigation');
});

test('same-URL reload stops capture on the loading document boundary', async () => {
  const secondFrame = deferred();
  let scrollCalls = 0;
  const url = 'https://example.test/same';
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url }],
    syncValues: { ocrAutoscroll: true },
    captureVisibleTab(_windowId, _captureOptions, callNumber) {
      return callNumber === 2 ? secondFrame.promise : 'data:image/png;base64,first-page';
    },
    sendMessage(_tabId, message) {
      if (message.type !== 'page:scroll-down') return { ok: true, documentId: 'document-one' };
      scrollCalls += 1;
      return { changed: true, atBottom: false, scrollY: scrollCalls * 100, documentId: 'document-one' };
    }
  });
  vm.runInContext('sleep = async () => {};', harness.context);

  const capturePromise = harness.context.runCaptureLoop(
    { id: 1, windowId: 10, active: true, url },
    REGION
  );
  await waitFor(() => harness.captureCalls.length === 2, 'second capture did not start');
  harness.events.onUpdated.emit(1, { status: 'loading' }, { ...harness.tabs.get(1), url });
  secondFrame.resolve('data:image/png;base64,reloaded-document');
  await capturePromise;

  assert.equal(harness.ocrCalls.length, 1);
  assert.equal(harness.context.getState(1).partialReason, 'navigation');
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

test('scroll starts while OCR is in flight and uses OCR latency as settle time', async () => {
  const firstOcr = deferred();
  let scrollCalls = 0;
  const harness = createBackgroundHarness({
    syncValues: { ocrAutoscroll: true },
    sendMessage(_tabId, message) {
      if (message.type !== 'page:scroll-down') return { ok: true };
      scrollCalls += 1;
      return scrollCalls === 1
        ? { changed: true, atBottom: false, scrollY: 100 }
        : { changed: false, atBottom: true, scrollY: 100 };
    }
  });
  harness.context.__testOcr = async (blob, pageNumber) => {
    harness.ocrCalls.push({ blob, pageNumber });
    if (pageNumber === 1) return firstOcr.promise;
    return `page ${pageNumber}`;
  };

  const capturePromise = harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  await waitFor(() => scrollCalls === 1, 'scroll did not start while first OCR was pending');
  assert.equal(harness.ocrCalls.length, 1);
  assert.equal(harness.context.getState(1).fragmentsCollected, 0);

  firstOcr.resolve('page 1');
  await capturePromise;

  assert.equal(harness.captureCalls.length, 2);
  assert.deepEqual(harness.ocrCalls.map((call) => call.pageNumber), [1, 2]);
  assert.equal(harness.finalized[0].text, 'page 1\npage 2');
});

test('normal scroll waits for the target to become active again', async () => {
  const firstOcr = deferred();
  const harness = createBackgroundHarness({
    tabs: [
      { id: 1, windowId: 10, active: true },
      { id: 2, windowId: 10, active: false }
    ],
    syncValues: { ocrAutoscroll: true }
  });
  harness.context.__testOcr = async (blob, pageNumber) => {
    harness.ocrCalls.push({ blob, pageNumber });
    if (pageNumber === 1) {
      // Deactivate before yielding so the parallel scroll path must wait.
      harness.setActive(2);
      return firstOcr.promise;
    }
    return `page ${pageNumber}`;
  };
  const capturePromise = harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  await waitFor(() => harness.context.getState(1).status === 'Paused', 'capture did not pause before scroll');

  assert.equal(harness.ocrCalls.length, 1);
  assert.equal(harness.context.getState(1).fragmentsCollected, 0);
  assert.equal(harness.messageCalls.filter((call) => call.message.type === 'page:scroll-down').length, 0);
  firstOcr.resolve('page 1');
  harness.setActive(1);
  await capturePromise;
  assert.equal(harness.messageCalls.filter((call) => call.message.type === 'page:scroll-down').length, 1);
  assert.equal(harness.context.getState(1).fragmentsCollected, 1);
});

test('bottom recheck scroll also waits for the active target', async () => {
  let scrollCalls = 0;
  const secondOcr = deferred();
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
  harness.context.__testOcr = async (blob, pageNumber) => {
    harness.ocrCalls.push({ blob, pageNumber });
    if (pageNumber === 2) {
      // Deactivate before yielding so the parallel bottom-recheck scroll must wait.
      harness.setActive(2);
      return secondOcr.promise;
    }
    return `page ${pageNumber}`;
  };
  const capturePromise = harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  await waitFor(() => harness.context.getState(1).status === 'Paused', 'capture did not pause before bottom recheck');

  assert.equal(scrollCalls, 1);
  assert.equal(harness.ocrCalls.length, 2);
  assert.equal(harness.context.getState(1).fragmentsCollected, 1);
  secondOcr.resolve('page 2');
  harness.setActive(1);
  await capturePromise;
  assert.equal(scrollCalls, 2);
  assert.equal(harness.context.getState(1).fragmentsCollected, 2);
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

test('startup recovery waits for stale scroll-lock cleanup', async () => {
  const unlock = deferred();
  let fetchCalls = 0;
  const operationId = 'translate:1:recovered';
  const harness = createBackgroundHarness({
    localData: {
      'operation:translate:1': {
        version: 1,
        type: 'translate',
        tabId: 1,
        operationId,
        status: 'running',
        updatedAt: 1,
        input: { text: 'source', language: 'French', host: 'localhost', port: 8765 }
      }
    },
    sendMessage(_tabId, message) {
      if (message.type === 'page:unlock-scroll') return unlock.promise;
      return { ok: true };
    },
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse({ text: 'translated' });
    }
  });

  await delay(5);
  assert.equal(fetchCalls, 0);
  unlock.resolve({ ok: true });
  await waitFor(() => fetchCalls === 1, 'persisted operation did not recover after unlock cleanup');
  await waitFor(() => harness.localData['tl2Result:1'] === 'translated', 'recovered translation did not finish');
});

test('startup recovery re-reads a checkpoint and ignores a superseding operation', async () => {
  const tabLookup = deferred();
  let fetchCalls = 0;
  const oldOperation = {
    version: 1,
    type: 'translate',
    tabId: 1,
    operationId: 'translate:1:old',
    status: 'running',
    updatedAt: 1,
    input: { text: 'old', language: 'French' }
  };
  const harness = createBackgroundHarness({
    localData: { 'operation:translate:1': oldOperation },
    getTab: async (tabId, tabs) => {
      await tabLookup.promise;
      return { ...tabs.get(tabId) };
    },
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse({ text: 'stale' });
    }
  });
  await delay(5);
  harness.localData['operation:translate:1'] = {
    ...oldOperation,
    operationId: 'translate:1:new',
    updatedAt: 2,
    input: { text: 'new', language: 'German' }
  };
  tabLookup.resolve();
  await harness.context.startupReadiness;

  assert.equal(fetchCalls, 0);
  assert.equal(harness.localData['operation:translate:1'].operationId, 'translate:1:new');
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

test('blank file bridge host uses localhost and the configured file bridge port', async () => {
  const harness = createBackgroundHarness({
    syncValues: {
      backendHost: '127.0.0.1',
      backendPort: 9876,
      fileBridgeHost: '',
      fileBridgePort: 9777
    }
  });

  assert.equal(await harness.context.getFileBridgeEndpoint('/save'), 'http://localhost:9777/save');
  harness.events.onStorageChanged.emit({ backendPort: { oldValue: 9876, newValue: 9999 } }, 'sync');
  assert.equal(await harness.context.getFileBridgeEndpoint('/save'), 'http://localhost:9777/save');
});

test('backend headers forward operation IDs without adding authentication', async () => {
  const harness = createBackgroundHarness();

  assert.deepEqual(
    { ...await harness.context.getBackendHeaders('application/json', 'translate:1:stable') },
    {
      'Content-Type': 'application/json',
      'X-TextKit-Operation-Id': 'translate:1:stable'
    }
  );
  assert.deepEqual({ ...await harness.context.getBackendHeaders() }, {});
});

test('OCR retry snapshot is persisted before the infinite retry loop', async () => {
  const retryDelay = deferred();
  const harness = createBackgroundHarness({ syncValues: { ocrAutoscroll: true } });
  harness.context.__testOcr = async (_blob, pageNumber) => {
    harness.ocrCalls.push({ pageNumber });
    throw new Error('OCR unavailable');
  };
  harness.context.__retryDelay = retryDelay.promise;
  vm.runInContext('sleep = (ms) => ms === 2000 ? __retryDelay : Promise.resolve();', harness.context);

  const operation = harness.context.executeCaptureLoop({
    tabId: 1,
    region: REGION,
    mergedText: 'first page',
    fragmentsCollected: 1,
    lastScrollY: 100,
    resetBeforeStart: false,
    refreshAutoscroll: false,
    promptSnapshot: { ocr: 'OCR prompt', dedup: 'Dedup prompt' }
  });
  await waitFor(() => harness.ocrCalls.length === 1, 'OCR request did not start');

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.localData['retryState:1'])),
    {
      stage: 'ocr',
      tabId: 1,
      region: REGION,
      mergedText: 'first page',
      fragmentsCollected: 1,
      lastScrollY: 100,
      captureUrl: null,
      captureDocumentId: null,
      backendSnapshot: { host: 'localhost', port: 8765 },
      operationId: harness.localData['retryState:1'].operationId,
      promptSnapshot: { ocr: 'OCR prompt', dedup: 'Dedup prompt' }
    }
  );

  harness.context.getState(1).stopRequested = true;
  retryDelay.resolve();
  await operation;
  assert.equal(Object.hasOwn(harness.localData, 'retryState:1'), false);
});

test('dedup retry snapshot is persisted before the infinite retry loop', async () => {
  const retryDelay = deferred();
  const harness = createBackgroundHarness();
  harness.context.getState(1).operationPrompts = { dedup: 'Dedup prompt' };
  harness.context.__testDedup = async () => { throw new Error('Dedup unavailable'); };
  harness.context.__retryDelay = retryDelay.promise;
  vm.runInContext(`
    postTextForDedup = (...args) => __testDedup(...args);
    sleep = (ms) => ms === 2000 ? __retryDelay : Promise.resolve();
  `, harness.context);

  const operation = harness.originalFinalizePostCapture(1, 'merged text', ['first', 'second']);
  await waitFor(() => harness.localData['retryState:1'], 'dedup retry state was not saved');

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.localData['retryState:1'])),
    {
      stage: 'dedup',
      tabId: 1,
      mergedText: 'merged text',
      fragmentsCollected: 2,
      operationId: null,
      promptSnapshot: { dedup: 'Dedup prompt' }
    }
  );

  harness.context.getState(1).stopRequested = true;
  retryDelay.resolve();
  await operation;
  assert.equal(Object.hasOwn(harness.localData, 'retryState:1'), false);
});

test('stored retry state becomes actionable after a service worker restart', async () => {
  const storedRetry = {
    stage: 'ocr',
    tabId: 1,
    region: REGION,
    fragments: ['recovered fragment'],
    lastScrollY: 100,
    promptSnapshot: { ocr: 'Saved OCR prompt' }
  };
  const harness = createBackgroundHarness({ localData: { 'retryState:1': storedRetry } });
  const recovered = await harness.context.getRecoverableState(1);

  assert.equal(recovered.status, 'Error');
  assert.equal(recovered.active, true);
  assert.equal(recovered.checkpointText, 'recovered fragment');
  assert.equal(recovered.fragmentsCollected, 1);

  harness.context.__resumedRetry = null;
  vm.runInContext('resumeCaptureLoop = async (retryState) => { __resumedRetry = retryState; };', harness.context);
  const result = await harness.context.handleRetry();

  assert.equal(result.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.context.__resumedRetry)),
    storedRetry
  );
});

test('Retry acknowledges after validation without holding the popup channel open', async () => {
  const resumed = deferred();
  const harness = createBackgroundHarness();
  const state = harness.context.getState(1);
  state.retryStage = 'dedup';
  state.pendingText = 'checkpoint';
  state.fragmentsCollected = 1;
  harness.context.__resumedDedup = resumed.promise;
  vm.runInContext('finalizePostCapture = () => __resumedDedup;', harness.context);

  const result = await Promise.race([
    harness.context.handleRetry(),
    delay(50).then(() => ({ timeout: true }))
  ]);

  assert.deepEqual({ ...result }, { ok: true });
  resumed.resolve();
});

test('Stop finalizes a recovered retry checkpoint without another dedup request', async () => {
  let dedupCalls = 0;
  const harness = createBackgroundHarness();
  const state = harness.context.getState(1);
  Object.assign(state, {
    active: true,
    status: 'Error',
    retryStage: 'dedup',
    checkpointText: 'raw recovered text',
    fragmentsCollected: 2
  });
  harness.context.__testDedup = async () => { dedupCalls += 1; return 'unexpected'; };
  vm.runInContext('postTextForDedup = (...args) => __testDedup(...args);', harness.context);

  const result = await harness.context.handleStop();

  assert.equal(result.ok, true);
  assert.equal(dedupCalls, 0);
  assert.equal(harness.finalized.at(-1).text, 'raw recovered text');
});

test('a non-OCR capture failure finalizes fragments already collected', async () => {
  const harness = createBackgroundHarness();
  const state = harness.context.getState(1);
  state.fragmentsCollected = 2;
  state.checkpointText = 'first fragment\nsecond fragment';
  state.active = true;
  state.status = 'Selecting';
  state.selectionToken = 'selection-token';
  vm.runInContext("runCaptureLoop = async () => { throw new Error('scroll failed'); };", harness.context);

  let response;
  harness.events.runtimeMessage.emit(
    { type: 'selection:complete', region: REGION, selectionToken: 'selection-token' },
    { tab: { id: 1, windowId: 10, active: true } },
    (value) => { response = value; }
  );
  assert.equal(response.ok, true);
  await waitFor(() => harness.finalized.length === 1, 'partial fragments were not finalized');
  assert.equal(harness.finalized[0].tabId, 1);
  assert.equal(harness.finalized[0].text, 'first fragment\nsecond fragment');
  assert.equal(harness.finalized[0].fragmentCount, 2);
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

test('keyboard capture command does not mutate an active capture', async () => {
  const harness = createBackgroundHarness();
  const state = harness.context.getState(1);
  Object.assign(state, { active: true, captureInFlight: true, status: 'Capturing', progress: 'Page 2' });

  harness.events.command.emit('start-region-capture');
  await delay();

  assert.equal(state.active, true);
  assert.equal(state.captureInFlight, true);
  assert.equal(state.status, 'Capturing');
  assert.equal(
    harness.messageCalls.filter(({ message }) => message.type === 'selection:start').length,
    0
  );
});

test('keyboard capture requests backend permission before starting selection', async () => {
  const harness = createBackgroundHarness({
    permissionContains: async () => false,
    permissionRequest: async () => false
  });

  harness.events.command.emit('start-region-capture');
  await waitFor(() => harness.context.getState(1).status === 'Error', 'permission denial was not reported');

  assert.equal(harness.permissionContainsCalls.length, 1);
  assert.equal(harness.permissionContainsCalls[0].origins.length, 1);
  assert.equal(harness.permissionContainsCalls[0].origins[0], 'http://localhost/*');
  assert.equal(harness.permissionRequestCalls.length, 1);
  assert.equal(harness.permissionRequestCalls[0].origins.length, 1);
  assert.equal(harness.permissionRequestCalls[0].origins[0], 'http://localhost/*');
  assert.equal(
    harness.messageCalls.filter(({ message }) => message.type === 'selection:start').length,
    0
  );
});

test('keyboard capture snapshots current backend settings when selection starts', async () => {
  const harness = createBackgroundHarness({
    syncValues: { backendHost: '127.0.0.1', backendPort: 9876 }
  });
  harness.context.getState(1).operationBackend = { host: 'localhost', port: 8765 };

  harness.events.command.emit('start-region-capture');
  await waitFor(() => harness.context.getState(1).status === 'Selecting', 'selection did not start');

  assert.deepEqual(
    { ...harness.context.getState(1).operationBackend },
    { host: '127.0.0.1', port: 9876 }
  );
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

test('stopped captures are persisted and displayed as partial', async () => {
  const harness = createBackgroundHarness();
  const state = harness.context.getState(1);
  state.stopRequested = true;
  state.partialReason = 'stopped';

  await harness.originalFinalizeCapture(1, 'partial text', ['first', 'second']);

  assert.equal(state.status, 'Partial');
  assert.equal(state.progress, 'Partial capture stopped after 2 fragments.');
  assert.equal(harness.localData['lastStatus:1'], 'Partial');
  assert.equal(harness.localData['lastResult:1'], 'partial text');
});

test('stopped captures with no fragments are cancelled without persisting empty text', async () => {
  const harness = createBackgroundHarness({
    localData: { 'lastResult:1': 'stale result' }
  });
  const state = harness.context.getState(1);
  state.stopRequested = true;
  state.partialReason = 'stopped';
  state.captureOperationId = 'capture:1:test';
  harness.localData['operation:capture:1'] = { operationId: state.captureOperationId };
  harness.context.__persistableChecks = 0;
  vm.runInContext(`
    requirePersistableText = () => {
      __persistableChecks += 1;
      throw new Error('empty text must not be checked');
    };
  `, harness.context);

  const result = await harness.originalFinalizeCapture(1, '', 0);

  assert.equal(result, '');
  assert.equal(state.status, 'Cancelled');
  assert.equal(state.progress, 'Capture cancelled before any text was collected.');
  assert.equal(harness.context.__persistableChecks, 0);
  assert.equal(harness.localData['lastStatus:1'], 'Cancelled');
  assert.equal(Object.hasOwn(harness.localData, 'lastResult:1'), false);
  assert.equal(Object.hasOwn(harness.localData, 'operation:capture:1'), false);
});

test('persisted text limits use UTF-8 byte size', () => {
  const harness = createBackgroundHarness();

  assert.equal(harness.context.requirePersistableText('a'.repeat(1_000_000), 'ASCII'), 'a'.repeat(1_000_000));
  assert.throws(
    () => harness.context.requirePersistableText('汉'.repeat(333_334), 'CJK'),
    /1000000-byte storage safety limit/
  );
  assert.throws(
    () => vm.runInContext("new IncrementalFragmentMerger().append('汉'.repeat(333334))", harness.context),
    /1000000-byte checkpoint limit/
  );
});

test('capture checkpoints are cleared before downstream automation', async () => {
  const operationId = 'capture:1:test';
  const harness = createBackgroundHarness({
    localData: {
      'retryState:1': { stage: 'dedup', mergedText: 'final text' },
      'operation:capture:1': { operationId, input: { mergedText: 'final text' } }
    }
  });
  const state = harness.context.getState(1);
  state.captureOperationId = operationId;
  harness.context.__checkpointStateDuringAutomation = null;
  vm.runInContext(`
    autoFormatIfEnabled = async () => {
      __checkpointStateDuringAutomation = {
        retry: Object.hasOwn(__localData, 'retryState:1'),
        operation: Object.hasOwn(__localData, 'operation:capture:1')
      };
    };
    autoTranslateIfEnabled = async () => {};
  `, harness.context);
  harness.context.__localData = harness.localData;

  await harness.originalFinalizeCapture(1, 'final text', 1);

  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.context.__checkpointStateDuringAutomation)),
    { retry: false, operation: false }
  );
});

test('tab closure during dedup is terminal and cleans up the shared capture lifecycle', async () => {
  let dedupCalls = 0;
  const harness = createBackgroundHarness({ useRealPipeline: true });
  harness.context.__testDedup = (_text, signal) => {
    dedupCalls += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  vm.runInContext('postTextForDedup = (...args) => __testDedup(...args);', harness.context);

  const operation = harness.context.runDedupLifecycle(1, 'raw text', 1);
  await waitFor(() => dedupCalls === 1, 'dedup request did not start');
  assert.equal(harness.context.getState(1).captureInFlight, true);

  harness.removeTab(1);
  await operation;

  assert.equal(dedupCalls, 1);
  assert.equal(vm.runInContext('states.has(1)', harness.context), false);
  assert.equal(Object.keys(harness.localData).some((key) => key.endsWith(':1')), false);
});

test('tab closure during auto-format prevents auto-translation from starting', async () => {
  const format = deferred();
  const harness = createBackgroundHarness();
  harness.context.__format = format.promise;
  harness.context.__translateCalls = 0;
  vm.runInContext(`
    autoFormatIfEnabled = () => __format;
    autoTranslateIfEnabled = async () => { __translateCalls += 1; };
  `, harness.context);

  const operation = harness.context.runCaptureLifecycle(
    1,
    'capture:1:automation-close',
    () => harness.originalFinalizeCapture(1, 'final text', 1)
  );
  await delay();
  harness.removeTab(1);
  format.resolve();
  await operation;

  assert.equal(harness.context.__translateCalls, 0);
  assert.equal(vm.runInContext('states.has(1)', harness.context), false);
});

test('backend ports must be complete decimal strings', () => {
  const harness = createBackgroundHarness();

  assert.equal(harness.context.normalizeBackendSettings('localhost', ' 8765 ').port, 8765);
  for (const malformed of ['8765junk', '1e3', '8765.9', '', '  ']) {
    assert.throws(
      () => harness.context.normalizeBackendSettings('localhost', malformed),
      /Backend port must be between 1 and 65535/
    );
  }
});

test('terminal capture failure clears its persisted operation checkpoint', async () => {
  const operationId = 'capture:1:terminal-error';
  const harness = createBackgroundHarness({
    localData: { 'operation:capture:1': { operationId } }
  });
  const state = harness.context.getState(1);
  state.captureOperationId = operationId;

  await harness.context.handleCaptureLoopFailure(1, new Error('crop failed'), 'Capture failed:');

  assert.equal(state.status, 'Error');
  assert.equal(Object.hasOwn(harness.localData, 'operation:capture:1'), false);
  assert.equal(state.captureOperationId, null);
});

test('auto-translation failure preserves a completed OCR result', async () => {
  const harness = createBackgroundHarness({
    localData: { tl2Language: 'French' },
    syncValues: { ocrAutoTranslate: true },
    fetch: async () => jsonResponse({ error: 'translation provider unavailable' }, 503)
  });
  const state = harness.context.getState(1);
  state.operationBackend = { host: '127.0.0.1', port: 9876 };

  await harness.originalFinalizeCapture(1, 'completed OCR text', 1);

  assert.equal(state.status, 'Done');
  assert.equal(state.partialReason, '');
  assert.equal(harness.localData['lastResult:1'], 'completed OCR text');
  assert.equal(harness.localData['lastStatus:1'], 'Done');
  assert.equal(harness.localData['tl2Status:1'], 'translation provider unavailable');
});

test('manual translation substitutes every language placeholder in a custom prompt', async () => {
  let requestBody;
  const harness = createBackgroundHarness({
    localData: {
      'translatePrompt:French': 'Translate to {language}. Answer only in {language}.'
    },
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, text: async () => JSON.stringify({ text: 'bonjour' }) };
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

test('manual translation rejects invalid JSON instead of storing an empty success', async () => {
  const harness = createBackgroundHarness({
    fetch: async () => ({ ok: true, text: async () => '<html>proxy error</html>' })
  });

  const result = await harness.context.handleTranslateStart({
    tabId: 1,
    text: 'hello',
    language: 'French',
    host: 'localhost',
    port: 8765
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /invalid JSON/);
  assert.equal(Object.hasOwn(harness.localData, 'tl2Result:1'), false);
});

test('translation liveness remains registered until automation settles', async () => {
  const automation = deferred();
  const harness = createBackgroundHarness({
    fetch: async () => jsonResponse({ text: 'translated' })
  });
  harness.context.__automation = automation.promise;
  vm.runInContext(`
    autoCopyIfEnabled = () => __automation;
    autoSaveIfEnabled = () => __automation;
    autoFormatIfEnabled = () => __automation;
  `, harness.context);

  const operation = harness.context.handleTranslateStart({
    tabId: 1,
    text: 'source',
    language: 'French'
  });
  await waitFor(() => harness.localData['tl2Result:1'] === 'translated', 'translation did not reach automation');

  assert.equal(vm.runInContext('translateControllers.has(1)', harness.context), true);
  assert.equal(await Promise.race([operation.then(() => 'done'), delay(20).then(() => 'pending')]), 'pending');
  automation.resolve();
  assert.equal((await operation).ok, true);
  assert.equal(vm.runInContext('translateControllers.has(1)', harness.context), false);
});

test('superseded translation cannot overwrite a newer result', async () => {
  const firstResponse = deferred();
  let call = 0;
  const harness = createBackgroundHarness({
    fetch: async () => {
      call += 1;
      if (call === 1) return firstResponse.promise;
      return { ok: true, text: async () => JSON.stringify({ text: 'new result' }) };
    }
  });

  const first = harness.context.handleTranslateStart({ tabId: 1, text: 'old', language: 'French' });
  await waitFor(() => call === 1, 'first translation did not start');
  const second = await harness.context.handleTranslateStart({ tabId: 1, text: 'new', language: 'French' });
  firstResponse.resolve({ ok: true, text: async () => JSON.stringify({ text: 'stale result' }) });
  const firstResult = await first;

  assert.equal(second.ok, true);
  assert.equal(firstResult.ok, false);
  assert.equal(harness.localData['tl2Result:1'], 'new result');
});

test('starting a capture aborts translation and format work from the previous capture', async () => {
  const translationResponse = deferred();
  const formatResponse = deferred();
  const signals = [];
  const harness = createBackgroundHarness({
    fetch: async (url, options) => {
      signals.push({ url: String(url), signal: options.signal });
      return String(url).includes('/translate') ? translationResponse.promise : formatResponse.promise;
    }
  });

  const translation = harness.context.handleTranslateStart({ tabId: 1, text: 'old', language: 'French' });
  const format = harness.context.handleFormatStart({ tabId: 1, text: 'old' });
  await waitFor(() => signals.length === 2, 'downstream requests did not start');

  await harness.context.handlePopupStart();
  assert.ok(signals.every(({ signal }) => signal.aborted));

  translationResponse.resolve({ ok: true, text: async () => JSON.stringify({ text: 'stale translation' }) });
  formatResponse.resolve({ ok: true, text: async () => JSON.stringify({ text: 'stale format' }) });
  assert.equal((await translation).ok, false);
  assert.equal((await format).ok, false);
  assert.equal(Object.hasOwn(harness.localData, 'tl2Result:1'), false);
  assert.equal(Object.hasOwn(harness.localData, 'fmtResult:1'), false);
});

test('checkpoint clear and replacement are atomic per tab', async () => {
  const harness = createBackgroundHarness();
  const key = 'operation:translate:1';
  harness.localData[key] = { operationId: 'old' };
  const readOldCheckpoint = deferred();
  const releaseOldClear = deferred();
  const originalGet = harness.context.chrome.storage.local.get.bind(harness.context.chrome.storage.local);
  let delayed = false;
  harness.context.chrome.storage.local.get = async (keys, callback) => {
    if (callback || keys !== key || delayed) return originalGet(keys, callback);
    delayed = true;
    const snapshot = await originalGet(keys);
    readOldCheckpoint.resolve();
    await releaseOldClear.promise;
    return snapshot;
  };

  const clearing = harness.context.clearOperation('translate', 1, 'old');
  await readOldCheckpoint.promise;
  const replacing = harness.context.persistOperation('translate', 1, 'new', { text: 'new' });
  releaseOldClear.resolve();
  await Promise.all([clearing, replacing]);

  assert.equal(harness.localData[key].operationId, 'new');
  assert.equal(harness.localData[key].input.text, 'new');
});

test('persisted translation resumes after a service worker restart', async () => {
  const operation = {
    version: 1,
    type: 'translate',
    tabId: 1,
    operationId: 'translate:1:recovery-id',
    status: 'running',
    input: { text: 'hello', language: 'French', host: 'localhost', port: 8765 },
    updatedAt: Date.now()
  };
  const harness = createBackgroundHarness({
    localData: { 'operation:translate:1': operation },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ text: 'bonjour' }) })
  });

  await waitFor(() => harness.localData['tl2Result:1'] === 'bonjour', 'translation was not recovered');

  assert.equal(Object.hasOwn(harness.localData, 'operation:translate:1'), false);
});

test('file bridge saves require safe paths and explicit ok', async () => {
  let fetchCalls = 0;
  const harness = createBackgroundHarness({
    fetch: async (_url, options) => {
      fetchCalls += 1;
      return { ok: true, text: async () => JSON.stringify({ ok: true, path: '/ignored' }) };
    }
  });

  const traversal = await harness.context.handleSaveTranslation({ text: 'hello', path: '../escape.txt' });
  const saved = await harness.context.handleSaveTranslation({ text: 'hello', path: 'notes//today.txt' });

  assert.equal(traversal.ok, false);
  assert.equal(fetchCalls, 1);
  assert.equal(saved.ok, true);
  assert.equal(saved.path, 'notes/today.txt');
});

test('save paths reject Windows drive-relative, UNC, device, and colon forms', () => {
  const harness = createBackgroundHarness();
  for (const unsafe of [
    'C:relative.txt',
    'C:/absolute.txt',
    '\\\\server\\share\\file.txt',
    '\\\\?\\C:\\device.txt',
    'notes/name:stream.txt'
  ]) {
    assert.throws(() => harness.context.normalizeSavePath(unsafe), /relative|traversal/);
  }
  assert.equal(harness.context.normalizeSavePath('notes/safe.txt'), 'notes/safe.txt');
});

test('file bridge empty or implicit-ok responses are rejected', async () => {
  let responseBody = '';
  const harness = createBackgroundHarness({
    fetch: async () => ({ ok: true, text: async () => responseBody })
  });

  const empty = await harness.context.handleSaveTranslation({ text: 'hello', path: 'notes.txt' });
  responseBody = JSON.stringify({ path: 'notes.txt' });
  const implicit = await harness.context.handleSaveTranslation({ text: 'hello', path: 'notes.txt' });

  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty response/);
  assert.equal(implicit.ok, false);
});

test('scroll response errors are not treated as reaching the bottom', () => {
  const harness = createBackgroundHarness();

  assert.throws(
    () => harness.context.requireScrollResponse({ changed: false, error: 'scroll blocked' }),
    /Page scroll failed: scroll blocked/
  );
});

test('stale selection completion tokens are rejected', () => {
  const harness = createBackgroundHarness();
  const state = harness.context.getState(1);
  state.active = true;
  state.status = 'Selecting';
  state.selectionToken = 'expected';
  let response;

  harness.events.runtimeMessage.emit(
    { type: 'selection:complete', region: REGION, selectionToken: 'forged' },
    { tab: { id: 1 } },
    (value) => { response = value; }
  );

  assert.equal(response.ok, false);
  assert.equal(state.status, 'Selecting');
});

test('offscreen creation failures are surfaced', async () => {
  const harness = createBackgroundHarness();
  harness.context.chrome.offscreen.createDocument = async () => {
    throw new Error('offscreen unavailable');
  };

  await assert.rejects(harness.context.copyToClipboard('text'), /offscreen unavailable/);
});

test('concurrent clipboard copies share one offscreen document creation', async () => {
  const creation = deferred();
  const harness = createBackgroundHarness({
    offscreenCreateDocument: () => creation.promise
  });

  const first = harness.context.copyToClipboard('first');
  const second = harness.context.copyToClipboard('second');
  await waitFor(() => harness.offscreenCreateCalls === 1, 'offscreen creation did not start');
  creation.resolve();
  await waitFor(
    () => harness.runtimeMessages.filter((message) => message.type === 'offscreen:copy').length === 2,
    'clipboard requests were not sent'
  );
  const requests = harness.runtimeMessages.filter((message) => message.type === 'offscreen:copy');
  for (const request of requests) {
    harness.events.runtimeMessage.emit({ type: 'offscreen:copied', copyId: request.copyId }, {}, () => {});
  }

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(harness.offscreenCreateCalls, 1);
  assert.equal(harness.offscreenCloseCalls, 1);
});

test('auto-save logs a user-visible failure when file bridge permission was revoked', async () => {
  let fetchCalls = 0;
  const harness = createBackgroundHarness({
    syncValues: {
      tl2AutoSave: true,
      tl2AutoSavePath: 'notes/translation.txt',
      fileBridgeHost: '127.0.0.1',
      fileBridgePort: 8766
    },
    permissionContains: async () => false,
    fetch: async () => {
      fetchCalls += 1;
      return { ok: true, text: async () => JSON.stringify({ ok: true }) };
    }
  });

  await harness.context.autoSaveIfEnabled('translated text');

  assert.equal(fetchCalls, 0);
  assert.deepEqual(harness.notifications.map(({ id }) => id), ['auto-save-failed']);
  assert.match(harness.notifications[0].options.message, /missing or was revoked/);
});

test('state broadcasts omit fragment arrays and private retry payloads', () => {
  const harness = createBackgroundHarness();
  const state = harness.context.getState(1);
  state.fragments = ['large fragment'];
  state.retryState = { stage: 'ocr', mergedText: 'private checkpoint' };

  harness.context.updateState(1, { progress: 'working' });
  const message = harness.runtimeMessages.at(-1);

  assert.equal(Object.hasOwn(message.state, 'fragments'), false);
  assert.equal(message.state.retryState.stage, 'ocr');
  assert.equal(Object.hasOwn(message.state.retryState, 'mergedText'), false);
});

test('tab close during capture cleans state and persisted operation data', async () => {
  const frame = deferred();
  const harness = createBackgroundHarness({
    localData: { 'lastResult:1': 'stale' },
    captureVisibleTab: () => frame.promise
  });

  const capture = harness.context.runCaptureLoop({ id: 1, windowId: 10, active: true }, REGION);
  await waitFor(() => harness.captureCalls.length === 1, 'capture did not start');
  harness.removeTab(1);
  frame.resolve('data:image/png;base64,closed-tab');
  await capture;

  assert.equal(vm.runInContext('states.has(1)', harness.context), false);
  assert.equal(Object.hasOwn(harness.localData, 'lastResult:1'), false);
  assert.equal(Object.hasOwn(harness.localData, 'operation:capture:1'), false);
});

test('auto-copy waits for offscreen confirmation before showing success', async () => {
  const harness = createBackgroundHarness({ syncValues: { tl2AutoCopy: true } });

  const operation = harness.context.autoCopyIfEnabled('translated text');
  await waitFor(
    () => harness.runtimeMessages.some((message) => message.type === 'offscreen:copy'),
    'offscreen copy request was not sent'
  );
  const request = harness.runtimeMessages.find((message) => message.type === 'offscreen:copy');
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.offscreenCloseCalls, 0);

  harness.events.runtimeMessage.emit({ type: 'offscreen:copied', copyId: request.copyId }, {}, () => {});
  await operation;

  assert.deepEqual(harness.notifications.map(({ id }) => id), ['auto-copy']);
  assert.equal(harness.offscreenCloseCalls, 1);
});

test('offscreen copy failure suppresses success and reports failure', async () => {
  const harness = createBackgroundHarness({ syncValues: { fmtAutoCopy: true } });

  const operation = harness.context.fmtAutoCopyIfEnabled('formatted text');
  await waitFor(
    () => harness.runtimeMessages.some((message) => message.type === 'offscreen:copy'),
    'offscreen copy request was not sent'
  );
  const request = harness.runtimeMessages.find((message) => message.type === 'offscreen:copy');
  harness.events.runtimeMessage.emit({
    type: 'offscreen:copy-failed',
    copyId: request.copyId,
    error: 'clipboard denied'
  }, {}, () => {});
  await operation;

  assert.deepEqual(harness.notifications.map(({ id }) => id), ['fmt-auto-copy-failed']);
  assert.equal(harness.notifications[0].options.message, 'clipboard denied');
  assert.equal(harness.offscreenCloseCalls, 1);
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
  response.resolve({ ok: true, text: async () => JSON.stringify({ text: 'HELLO' }) });

  const result = await operation;
  assert.equal(result.ok, true);
  assert.equal(requestBody.prompt, 'Initial format prompt');
});

test('format liveness remains registered until copy/save automation settles', async () => {
  const automation = deferred();
  const harness = createBackgroundHarness({
    fetch: async () => jsonResponse({ text: 'formatted' })
  });
  harness.context.__automation = automation.promise;
  vm.runInContext(`
    fmtAutoCopyIfEnabled = () => __automation;
    fmtAutoSaveIfEnabled = () => __automation;
  `, harness.context);

  const operation = harness.context.handleFormatStart({ tabId: 1, text: 'source' });
  await waitFor(() => harness.localData['fmtResult:1'] === 'formatted', 'format did not reach automation');

  assert.equal(vm.runInContext('formatControllers.has(1)', harness.context), true);
  assert.equal(await Promise.race([operation.then(() => 'done'), delay(20).then(() => 'pending')]), 'pending');
  automation.resolve();
  assert.equal((await operation).ok, true);
  assert.equal(vm.runInContext('formatControllers.has(1)', harness.context), false);
});

test('superseded format operation cannot overwrite a newer result', async () => {
  const firstResponse = deferred();
  let call = 0;
  const harness = createBackgroundHarness({
    fetch: async () => {
      call += 1;
      if (call === 1) return firstResponse.promise;
      return { ok: true, text: async () => JSON.stringify({ text: 'new format' }) };
    }
  });

  const first = harness.context.handleFormatStart({ tabId: 1, text: 'old' });
  await waitFor(() => call === 1, 'first format did not start');
  const second = await harness.context.handleFormatStart({ tabId: 1, text: 'new' });
  firstResponse.resolve({ ok: true, text: async () => JSON.stringify({ text: 'stale format' }) });
  const firstResult = await first;

  assert.equal(second.ok, true);
  assert.equal(firstResult.ok, false);
  assert.equal(harness.localData['fmtResult:1'], 'new format');
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

test('fake backend workflow covers selection, capture, dedup, automation, Stop, and recovery', async () => {
  const routes = [];
  const origins = [];
  const harness = createBackgroundHarness({
    useRealPipeline: true,
    imageBitmapSize: { width: 200, height: 300 },
    captureVisibleTab: async () => 'data:image/png;base64,c2NyZWVuc2hvdA==',
    localData: {
      tl2Language: 'French',
      formatPrompt: 'Format clearly.'
    },
    syncValues: {
      ocrAutoscroll: false,
      ocrAutoTranslate: true,
      fmtAutoFormat: true,
      fmtSourceVal: 'translation'
    },
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const route = parsed.pathname;
      routes.push(route);
      origins.push(parsed.origin);
      if (route === '/ocr') return jsonResponse({ text: 'raw OCR text' });
      if (route === '/dedup') return jsonResponse({ text: 'deduplicated text' });
      if (route === '/translate') return jsonResponse({ text: 'translated text' });
      if (route === '/format') return jsonResponse({ text: 'formatted text' });
      throw new Error(`Unexpected fake backend route: ${route}`);
    }
  });
  await harness.context.startupReadiness;
  const state = harness.context.getState(1);
  Object.assign(state, {
    active: true,
    status: 'Selecting',
    selectionToken: 'workflow-selection',
    operationPrompts: {},
    operationBackend: { host: '127.0.0.1', port: 9876 }
  });
  const workflowRegion = {
    x: 10,
    y: 20,
    width: 50,
    height: 40,
    viewportWidth: 100,
    viewportHeight: 100
  };
  let selectionResponse;
  harness.events.runtimeMessage.emit(
    { type: 'selection:complete', region: workflowRegion, selectionToken: 'workflow-selection' },
    { tab: { id: 1, windowId: 10, active: true, url: 'https://example.test/' } },
    (response) => { selectionResponse = response; }
  );

  assert.deepEqual({ ...selectionResponse }, { ok: true });
  await waitFor(() => harness.localData['fmtResult:1'] === 'formatted text', 'automation workflow did not finish');
  assert.deepEqual(routes, ['/ocr', '/dedup', '/translate', '/format']);
  assert.deepEqual(origins, Array(4).fill('http://127.0.0.1:9876'));
  assert.deepEqual(harness.cropCalls, [{
    width: 100,
    height: 120,
    drawImage: [20, 60, 100, 120, 0, 0, 100, 120]
  }]);
  assert.equal(harness.localData['lastResult:1'], 'deduplicated text');
  assert.equal(harness.localData['tl2Result:1'], 'translated text');
  assert.equal(harness.localData['tl2Status:1'], 'Complete');
  assert.equal(harness.localData['fmtStatus:1'], 'Complete');

  let recoveryRequestStarted = false;
  const recoveredOperationId = 'capture:1:recovered-stop';
  const recoveryHarness = createBackgroundHarness({
    useRealPipeline: true,
    localData: {
      'operation:capture:1': {
        version: 1,
        type: 'capture',
        tabId: 1,
        operationId: recoveredOperationId,
        status: 'running',
        updatedAt: 1,
        input: {
          stage: 'dedup',
          mergedText: 'raw recovery checkpoint',
          fragmentsCollected: 1,
          promptSnapshot: {},
          backendSnapshot: { host: 'localhost', port: 8765 }
        }
      }
    },
    fetch: async (_url, options) => {
      recoveryRequestStarted = true;
      return new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
    }
  });
  await waitFor(() => recoveryRequestStarted, 'dedup recovery did not contact the fake backend');
  const stopResult = await recoveryHarness.context.handleStop();
  assert.equal(stopResult.ok, true);
  await waitFor(
    () => recoveryHarness.localData['lastResult:1'] === 'raw recovery checkpoint',
    'Stop did not finalize the recovered raw checkpoint'
  );
  assert.equal(recoveryHarness.context.getState(1).status, 'Partial');
});
test('explicit stopTranslateOperation emits tl2:translating false', async () => {
  const harness = createBackgroundHarness({
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    })
  });

  const operation = harness.context.handleTranslateStart({
    tabId: 1,
    text: 'source',
    language: 'French'
  });

  await waitFor(
    () => vm.runInContext('translateControllers.has(1)', harness.context),
    'translate controller was not registered'
  );

  const pre = harness.runtimeMessages.filter(
    (m) => m.type === 'tl2:translating' && m.tabId === 1 && m.value === false
  ).length;

  await harness.context.handleTranslateStop(1);

  const result = await operation;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Translation superseded.');
  assert.equal(vm.runInContext('translateControllers.has(1)', harness.context), false);
  assert.equal(vm.runInContext('translateOperationIds.has(1)', harness.context), false);

  const count = harness.runtimeMessages.filter(
    (m) => m.type === 'tl2:translating' && m.tabId === 1 && m.value === false
  ).length;
  assert.equal(count - pre, 1);
});

test('explicit stopFormatOperation emits fmt:formatting false', async () => {
  const harness = createBackgroundHarness({
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    })
  });

  const operation = harness.context.handleFormatStart({
    tabId: 1,
    text: 'source'
  });

  await waitFor(
    () => vm.runInContext('formatControllers.has(1)', harness.context),
    'format controller was not registered'
  );

  const pre = harness.runtimeMessages.filter(
    (m) => m.type === 'fmt:formatting' && m.tabId === 1 && m.value === false
  ).length;

  await harness.context.handleFormatStop(1);

  const result = await operation;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Formatting superseded.');
  assert.equal(vm.runInContext('formatControllers.has(1)', harness.context), false);
  assert.equal(vm.runInContext('formatOperationIds.has(1)', harness.context), false);

  const count = harness.runtimeMessages.filter(
    (m) => m.type === 'fmt:formatting' && m.tabId === 1 && m.value === false
  ).length;
  assert.equal(count - pre, 1);
});

test('translation has no fixed timeout — Stop still aborts via AbortController', async () => {
  const scheduledTimeouts = [];
  const harness = createBackgroundHarness({
    setTimeout: (callback, delay, ...args) => {
      scheduledTimeouts.push(delay);
      return setTimeout(callback, delay, ...args);
    },
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    })
  });

  const operation = harness.context.handleTranslateStart({
    tabId: 1,
    text: 'source',
    language: 'French'
  });

  await waitFor(
    () => vm.runInContext('translateControllers.has(1)', harness.context),
    'translate controller was not registered'
  );

  assert.equal(
    scheduledTimeouts.includes(12 * 60 * 1000),
    false,
    'translation must not schedule the fixed backend timeout'
  );
  assert.equal(
    vm.runInContext('translateControllers.has(1)', harness.context),
    true,
    'translate controller should still be registered (no fixed timeout fired)'
  );

  // Stop via user path — must still work.
  await harness.context.handleTranslateStop(1);

  const result = await operation;
  // After stop, the operation returns superseded since the controller/operationId are cleared.
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Translation superseded.');
  assert.equal(vm.runInContext('translateControllers.has(1)', harness.context), false);
});

test('format has no fixed timeout — Stop still aborts via AbortController', async () => {
  const scheduledTimeouts = [];
  const harness = createBackgroundHarness({
    setTimeout: (callback, delay, ...args) => {
      scheduledTimeouts.push(delay);
      return setTimeout(callback, delay, ...args);
    },
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    })
  });

  const operation = harness.context.handleFormatStart({
    tabId: 1,
    text: 'source'
  });

  await waitFor(
    () => vm.runInContext('formatControllers.has(1)', harness.context),
    'format controller was not registered'
  );

  assert.equal(
    scheduledTimeouts.includes(12 * 60 * 1000),
    false,
    'format must not schedule the fixed backend timeout'
  );
  assert.equal(
    vm.runInContext('formatControllers.has(1)', harness.context),
    true,
    'format controller should still be registered (no fixed timeout fired)'
  );

  // Stop via user path — must still work.
  await harness.context.handleFormatStop(1);

  const result = await operation;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Formatting superseded.');
  assert.equal(vm.runInContext('formatControllers.has(1)', harness.context), false);
});

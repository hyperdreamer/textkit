# Configurable OCR Confirmation Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking; leave this pinned plan unticked.

**Goal:** Replace page-key OCR confirmation with a configurable native Chrome command while preserving the existing confirmation and capture mechanism.

**Architecture:** Chrome declares and owns two independent shortcuts; the existing service-worker command listener routes confirmation to the resolved tab's top-frame content script without awaiting startup readiness. The content route calls the existing `confirmSelection()` synchronously, while one asynchronous binding lookup per overlay drives presentation state owned by that overlay's DOM identity. Existing selection tokens, admission ordering, double animation frames, cancellation, and capture/recovery remain intact.

**Tech Stack:** Chromium Manifest V3, Chrome Commands API, Vanilla JS / ES2020+ with no framework, Node's built-in test runner and VM harnesses, FastAPI/Python regression suite.

**Authority:** `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-spec.md`, verified SHA-256 `e7065697a94eef00ba87007ef90dfeac2e7fa5b008d00b21391113466193b8a5`.

**Approved design:** `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md`, verified SHA-256 `50e4b4ae20f6afb8ecbc883f9c85a30900a417db2954ff3994d714d57940a9a5`.

**Source coordinates:** All modification ranges below were read in the planning checkout; use their accompanying exact anchors after earlier tasks shift line numbers. Product/test sources match oracle `c47dec6a24b42bcdb25f2c4fbe731deca8ce4431`. Planning verification ran the four Node suites: background 84, popup 27, content 10, E2E 1; total 122 passed, 0 failed, 0 skipped. Expected counts below count Node tests, independently of specification case IDs.

**Decomposition:** Eight tasks retain the requested review seams: declaration/registration, command routing, binding replies, content routing/admission regressions, key removal, hint presentation, historical equivalence/interleavings, and documentation. The VM scaffolding lives with its first consumer. Task 7 integrates the worker/content test interfaces and supplies the historical fixture; it adds no product behavior. Economy tasks provide literal transcription; Standard tasks need local integration review; Advanced tasks coordinate asynchronous ownership or multiple VM receivers.

## Global Constraints

- No new permissions. No new `host_permissions` or `global` setting; preserve both existing permissions arrays and all other manifest fields.
- `minimum_chrome_version: 116`; retain the manifest's exact string value `"116"`.
- Vanilla JS / ES2020+ with no framework. No new runtime dependencies or build step.
- Required Node command: `node --test tests/background.test.js tests/popup.test.js tests/content.test.js tests/extension_e2e.test.js`.
- Required Python command: `python -m pytest tests/ -v`.
- `selection:start` and `selection:complete` contracts must not change.
- `selection:cancel` and `selection:cancelled` shapes must not change. Preserve both `onKeyDown` guards verbatim: `if (event.isTrusted !== true || confirmPending) return;`.
- Added worker-to-content request is exactly `{type: 'selection:confirm'}`, sent with `{frameId: 0}`; content replies exactly `{ok: true}` synchronously and returns literal `false`. It calls the existing `confirmSelection()`.
- Added binding request is exactly `{type: 'commands:binding'}`; replies are exactly `{state: 'assigned', label: L}`, `{state: 'unassigned'}`, or `{state: 'unavailable'}`. `L` is the verbatim nonempty Chrome string. Worker uses a `replied` latch and literal `return true`, even after synchronous failure.
- Confirmation uses supplied truthy `tab.id`, otherwise exactly one `{active: true, currentWindow: true}` query. Query/delivery failures are swallowed; no startup-readiness await, timer, queue, retry, state update, permission request, injection, or direct capture in this branch.
- Preserve `confirmSelection()` admission guard, synchronous snapshot, pending/hide, two nested `requestAnimationFrame` callbacks, completion payload, acknowledgment handling, and overlay restoration; its only internal edit is diagnostic presentation routing.
- Preserve worker completion order: sender tab, region shape, `Selecting`/matching nonempty token, consume token, save region, acknowledge, launch capture. Numeric-string/negative-coordinate shape behavior and unexamined DPR remain unchanged.
- No durable selection records, selection-ID round trips, request/response confirmation protocol, claim maps, `stopEpoch`, terminal-checkpoint immutability, `retryState` changes, operation/checkpoint writes, or screenshot changes. Do not edit `handleStop`, `runCaptureLoop`, `recoverPersistedOperations`, or any screenshot/capture helper.
- No popup shortcut control, custom recorder, page confirmation substitute, or popup confirmation fallback.
- A command confirms the overlay present in its resolved tab at delivery, subject to unchanged worker admission. Do not promise invocation-time identity or a wall-clock bound. A restored valid saved region can confirm with zero pointer input.
- One binding snapshot per overlay; four UI states: checking, assigned, unassigned, unavailable. Normalize malformed replies to unavailable. Use `textContent`; preserve labels verbatim. Both fulfillment/failure processing and painting recheck DOM owner and diagnostic precedence.
- Diagnostic clears only after a trusted pointer mutation actually changes `x`, `y`, `width`, or `height`; preserve geometry and trust handling. Both hint stylesheet owners remove `white-space: nowrap` and add `max-width: calc(100vw - 32px);` and `overflow-wrap: anywhere;`.
- Implementation artifact allowlist: `extension/manifest.json`, `extension/background.js`, `extension/content.js`, `extension/overlay.css`, `tests/background.test.js`, `tests/content.test.js`, `tests/extension_e2e.test.js`, `tests/fixtures/selection-complete-baseline.json`, `README.md`. The approved spec/design and this pinned plan are read only during execution. No extra recorder, harness, report, or documentation file in the repository.
- Manual M01–M04 and source checks V01–V03 are required acceptance evidence, separate from automated counts. A Chromium skip leaves registration unverified; never replace effective-shortcut assertions with manifest defaults. Physical keys require headed manual execution.

## Task 1: Declare the native confirmation command and verify Chromium registration

**Implementer tier:** Economy

**Files:**

- Modify: `extension/manifest.json:36-45` — existing commands object.
- Modify: `tests/background.test.js:2074-2116` — append W15 after the final existing test.
- Modify: `tests/extension_e2e.test.js:74-85` — Chromium launch flags.
- Modify: `tests/extension_e2e.test.js:121-142` — popup snapshot and manifest assertions.
- Test: `tests/background.test.js`.
- Test: `tests/extension_e2e.test.js`.

**Interfaces:**

- Consumes: existing `start-region-capture` declaration with `{default: 'Ctrl+Shift+S', mac: 'Command+Shift+S'}`; `chrome.commands.getAll(): Promise<Array<{name: string, description: string, shortcut: string}>>`; `chrome.runtime.getPlatformInfo(): Promise<{os: string}>`.
- Produces: exact command `confirm-region-capture`, description `Confirm selected OCR region`, suggested keys `{default: 'Ctrl+Shift+Space', mac: 'Command+Shift+Space'}`. Tasks 2 and 3 consume that exact name; Task 6 displays the effective returned shortcut, independent of these suggestions.
- Produces: one W15 static test and an enhanced existing E2E test owning E01/E02. No E2E test is added: baseline background grows 84→85; E2E remains 1.

- [ ] **Step 1: Append W15 and extend the existing E2E test before editing the manifest.** Append this complete test to `tests/background.test.js`:

```js
// W15: full command declaration and unchanged non-command manifest.
test('W15 manifest declares two commands without changing other metadata', () => {
  const { execFileSync } = require('node:child_process');
  const manifestPath = path.join(ROOT, 'extension', 'manifest.json');
  const currentText = fs.readFileSync(manifestPath, 'utf8');
  const pinnedText = execFileSync('git', [
    'show', 'c47dec6a24b42bcdb25f2c4fbe731deca8ce4431:extension/manifest.json'
  ], { cwd: ROOT, encoding: 'utf8' });
  const current = JSON.parse(currentText);
  const pinned = JSON.parse(pinnedText);
  assert.deepEqual(current.commands, {
    'start-region-capture': {
      suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
      description: 'Select a region and start OCR capture'
    },
    'confirm-region-capture': {
      suggested_key: { default: 'Ctrl+Shift+Space', mac: 'Command+Shift+Space' },
      description: 'Confirm selected OCR region'
    }
  }, 'W15 requires both exact commands');
  delete current.commands;
  delete pinned.commands;
  assert.deepEqual(current, pinned);
  assert.equal(currentText.slice(0, currentText.indexOf('  "commands":')),
    pinnedText.slice(0, pinnedText.indexOf('  "commands":')));
});
```

Add `'--lang=en-US',` immediately after `'--headless=new',` in the browser arguments. Replace only the `snapshot` evaluation and its assertions through the permissions assertion with:

```js
  const snapshot = await popup.send('Runtime.evaluate', {
    expression: `(async () => ({
      title: document.title,
      mainCount: document.querySelectorAll('main').length,
      tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('aria-selected')),
      panels: document.querySelectorAll('[role="tabpanel"]').length,
      liveRegions: document.querySelectorAll('[aria-live="polite"]').length,
      manifest: chrome.runtime.getManifest(),
      platform: await chrome.runtime.getPlatformInfo(),
      commands: await chrome.commands.getAll()
    }))()`,
    awaitPromise: true,
    returnByValue: true
  });
  assert.equal(snapshot.exceptionDetails, undefined);
  const value = snapshot.result.value;
  assert.equal(value.title, 'TextKit');
  assert.equal(value.mainCount, 1);
  assert.deepEqual(value.tabs, ['true', 'false', 'false', 'false']);
  assert.equal(value.panels, 4);
  assert.ok(value.liveRegions >= 3);
  assert.equal(value.manifest.manifest_version, 3);
  assert.equal(value.manifest.minimum_chrome_version, '116');
  assert.deepEqual(value.manifest.permissions, [
    'activeTab', 'scripting', 'downloads', 'storage', 'offscreen',
    'clipboardWrite', 'notifications'
  ]);
  assert.deepEqual(value.manifest.optional_host_permissions, [
    'http://localhost/*', 'http://127.0.0.1/*', 'http://[::1]/*'
  ]);
  const expectedCommands = {
    'start-region-capture': {
      suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
      description: 'Select a region and start OCR capture'
    },
    'confirm-region-capture': {
      suggested_key: { default: 'Ctrl+Shift+Space', mac: 'Command+Shift+Space' },
      description: 'Confirm selected OCR region'
    }
  };
  assert.deepEqual(value.manifest.commands, expectedCommands);
  const effective = value.platform.os === 'mac'
    ? { 'start-region-capture': '⇧⌘S', 'confirm-region-capture': '⇧⌘Space' }
    : { 'start-region-capture': 'Ctrl+Shift+S', 'confirm-region-capture': 'Ctrl+Shift+Space' };
  for (const [name, declared] of Object.entries(expectedCommands)) {
    const rows = value.commands.filter((row) => row.name === name);
    assert.equal(rows.length, 1, `one registered row for ${name}`);
    assert.equal(rows[0].description, declared.description);
    assert.equal(rows[0].shortcut, effective[name], `effective shortcut for ${name}`);
    assert.ok(rows[0].shortcut.length > 0);
  }
```

Retain the rest of the smoke test, particularly worker close/wake/reappearance.

- [ ] **Step 2: Observe the declaration failure.** Run `node --test --test-reporter=tap --test-name-pattern='^W15 ' tests/background.test.js`. Expected diagnostic contains `W15 requires both exact commands`; summary contains exactly `# tests 1`, `# pass 0`, `# fail 1`, `# skipped 0`. The existing manifest lacks `confirm-region-capture`.

- [ ] **Step 3: Replace the manifest's complete `commands` value with this exact JSON; preserve everything preceding it.**

```json
  "commands": {
    "start-region-capture": {
      "suggested_key": {
        "default": "Ctrl+Shift+S",
        "mac": "Command+Shift+S"
      },
      "description": "Select a region and start OCR capture"
    },
    "confirm-region-capture": {
      "suggested_key": {
        "default": "Ctrl+Shift+Space",
        "mac": "Command+Shift+Space"
      },
      "description": "Confirm selected OCR region"
    }
  }
```

- [ ] **Step 4: Verify static declaration and real registration.** Run `node --test --test-reporter=tap tests/background.test.js tests/extension_e2e.test.js`. Expected final summary: `# tests 86`, `# pass 86`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`. This is 85 worker tests and the one enhanced Chromium test. Any empty effective shortcut fails; a skipped browser is an unverified registration outcome to report, not permission to weaken assertions.

- [ ] **Step 5: Commit.**

```bash
git add extension/manifest.json tests/background.test.js tests/extension_e2e.test.js
git commit -m "feat(extension): declare native OCR confirmation command"
```

## Task 2: Route confirmation commands independently of worker readiness

**Implementer tier:** Standard

**Files:**

- Modify: `extension/background.js:323-358` — existing command listener only.
- Modify: `tests/background.test.js:45-54` — return captured listener results.
- Modify: `tests/background.test.js:2074-2116` — append helper and W01–W08 after existing tests, including Task 1's appended test.
- Test: `tests/background.test.js`.

**Interfaces:**

- Consumes Task 1: `confirm-region-capture` and existing `start-region-capture` command names; optional Chrome `tab?: {id?: number}` argument.
- Produces: existing `chrome.commands.onCommand` listener accepting `(command, tab)`, with detached confirmation delivery `chrome.tabs.sendMessage(target.id, {type: 'selection:confirm'}, {frameId: 0})`. It ignores reply values and does not change state. Task 4 supplies that content receiver.
- Produces test-only `createEvent().emit(...args): Array<unknown>`; command results may be promises, runtime listener results remain raw literals.
- Produces test-only `shortcutWorker(options = {}): Promise<h>` using existing `createBackgroundHarness(options)`, settled startup, then test-owned `h.queries`, `h.sends`, `h.effects`, `h.deliver(tabId,message,options)`, and `h.assertQuiet()`. `h.context.chrome` APIs remain replaceable after initialization. Task 3 consumes this helper for no-side-effect binding checks; Task 7 consumes it for routing into real content VMs. `sends` records `{tabId, message, options}` with plain JSON values.

- [ ] **Step 1: Make event returns observable and append the helper plus eight tests.** Replace only `emit` in worker `createEvent()` with:

```js
    emit(...args) {
      return [...listeners].map((listener) => listener(...args));
    }
```

Append:

```js
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function shortcutWorker(options = {}) {
  const h = createBackgroundHarness(options);
  await vm.runInContext('startupReadiness', h.context);
  h.queries = [];
  h.sends = [];
  h.effects = [];
  h.deliver = async () => ({ ok: true });
  const c = h.context.chrome;
  c.tabs.query = async (query) => {
    h.queries.push(plain(query));
    return [{ id: 11 }];
  };
  c.tabs.sendMessage = async (tabId, message, sendOptions) => {
    h.sends.push({ tabId, message: plain(message), options: plain(sendOptions || {}) });
    return h.deliver(tabId, message, sendOptions);
  };
  for (const [owner, name] of [
    [c.permissions, 'contains'], [c.permissions, 'request'],
    [c.scripting, 'executeScript'], [c.scripting, 'insertCSS'],
    [c.storage.local, 'set'], [c.storage.local, 'remove'],
    [c.storage.sync, 'set']
  ]) {
    const original = owner[name].bind(owner);
    owner[name] = (...args) => {
      h.effects.push(name);
      return original(...args);
    };
  }
  h.context.__shortcutEffects = h.effects;
  vm.runInContext(`
    const shortcutOriginalUpdateState = updateState;
    updateState = (...args) => {
      __shortcutEffects.push('updateState');
      return shortcutOriginalUpdateState(...args);
    };
    runCaptureLoop = async () => { __shortcutEffects.push('runCaptureLoop'); };
  `, h.context);
  const beforeStates = vm.runInContext('JSON.stringify([...states])', h.context);
  const beforeStorage = JSON.stringify(h.localData);
  const beforeBroadcasts = h.runtimeMessages.length;
  h.assertQuiet = () => {
    assert.deepEqual(h.effects, []);
    assert.equal(vm.runInContext('JSON.stringify([...states])', h.context), beforeStates);
    assert.equal(JSON.stringify(h.localData), beforeStorage);
    assert.equal(h.runtimeMessages.length, beforeBroadcasts);
    assert.equal(h.captureCalls.length, 0);
  };
  return h;
}

const CONFIRM_SEND = {
  tabId: 11, message: { type: 'selection:confirm' }, options: { frameId: 0 }
};

test('W01 supplied tab receives exactly one top-frame confirmation', async () => {
  const h = await shortcutWorker();
  await Promise.all(h.events.command.emit('confirm-region-capture', { id: 11 }));
  assert.equal(h.sends.length, 1, 'W01 expected one top-frame send');
  assert.deepEqual(h.sends, [CONFIRM_SEND]);
  assert.deepEqual(h.queries, []);
  h.assertQuiet();
});

test('W02 absent or falsy supplied ID uses one exact fallback query', async () => {
  for (const supplied of [undefined, {}, { id: 0 }]) {
    const h = await shortcutWorker();
    await Promise.all(h.events.command.emit('confirm-region-capture', supplied));
    await delay();
    assert.deepEqual(h.queries, [{ active: true, currentWindow: true }]);
    assert.deepEqual(h.sends, [CONFIRM_SEND]);
    h.assertQuiet();
  }
});

test('W03 rejected query settles silently without delivery or side effects', async () => {
  const h = await shortcutWorker();
  h.context.chrome.tabs.query = async (query) => {
    h.queries.push(plain(query));
    throw new Error('query failed');
  };
  await Promise.all(h.events.command.emit('confirm-region-capture'));
  await delay();
  assert.deepEqual(h.queries, [{ active: true, currentWindow: true }]);
  assert.deepEqual(h.sends, []);
  h.assertQuiet();
});

test('W04 empty or unusable first query result never retries', async () => {
  for (const rows of [[], [{}], [{ id: 0 }, { id: 11 }]]) {
    const h = await shortcutWorker();
    h.context.chrome.tabs.query = async (query) => {
      h.queries.push(plain(query));
      return rows;
    };
    await Promise.all(h.events.command.emit('confirm-region-capture'));
    await delay();
    assert.deepEqual(h.queries, [{ active: true, currentWindow: true }]);
    assert.deepEqual(h.sends, []);
    h.assertQuiet();
  }
});

test('W05 missing content receiver is swallowed without fallback actions', async () => {
  const h = await shortcutWorker();
  h.deliver = async () => { throw new Error('no receiver'); };
  await Promise.all(h.events.command.emit('confirm-region-capture', { id: 11 }));
  await delay();
  assert.deepEqual(h.sends, [CONFIRM_SEND]);
  assert.deepEqual(h.queries, []);
  h.assertQuiet();
});

test('W06 unrelated command has no confirmation effect or binding lookup', async () => {
  const h = await shortcutWorker();
  h.context.chrome.commands.getAll = () => assert.fail('unexpected binding lookup');
  await Promise.all(h.events.command.emit('unrelated', { id: 11 }));
  await delay();
  assert.deepEqual(h.queries, []);
  assert.deepEqual(h.sends, []);
  h.assertQuiet();
});

test('W07 confirmation sends before unresolved startup readiness', async () => {
  const h = await shortcutWorker();
  const readiness = deferred();
  h.context.__heldReadiness = readiness.promise;
  vm.runInContext('startupReadiness = __heldReadiness;', h.context);
  const results = h.events.command.emit('confirm-region-capture', { id: 11 });
  assert.deepEqual(h.sends, [CONFIRM_SEND]);
  assert.deepEqual(h.queries, []);
  h.assertQuiet();
  readiness.resolve();
  await Promise.all(results);
});

test('W08 launch retains readiness permission injection and token flow', async () => {
  const h = createBackgroundHarness({
    syncValues: { backendHost: '127.0.0.1', backendPort: 9876 },
    localData: { ocrPrompt: 'ocr', dedupPrompt: 'dedup' },
    permissionContains: async () => false,
    permissionRequest: async () => true
  });
  await vm.runInContext('startupReadiness', h.context);
  const gate = deferred();
  h.context.__launchGate = gate.promise;
  vm.runInContext('startupReadiness = __launchGate;', h.context);
  const queries = [];
  const injections = [];
  const c = h.context.chrome;
  c.tabs.query = async (query) => { queries.push(plain(query)); return [{ id: 1 }]; };
  c.scripting.executeScript = async (args) => { injections.push(plain(args)); };
  c.scripting.insertCSS = async (args) => { injections.push(plain(args)); };
  h.messageCalls.length = 0;
  const results = h.events.command.emit('start-region-capture');
  assert.deepEqual(queries, []);
  assert.equal(h.permissionContainsCalls.length, 0);
  assert.deepEqual(injections, []);
  gate.resolve();
  await Promise.all(results);
  assert.deepEqual(queries, [{ active: true, currentWindow: true }]);
  assert.deepEqual(plain(h.permissionRequestCalls), [{ origins: ['http://127.0.0.1/*'] }]);
  assert.deepEqual(injections, [
    { target: { tabId: 1 }, files: ['content.js'] },
    { target: { tabId: 1 }, files: ['overlay.css'] }
  ]);
  const state = h.context.getState(1);
  assert.equal(state.status, 'Selecting');
  assert.equal(state.active, true);
  assert.ok(typeof state.selectionToken === 'string' && state.selectionToken.length > 0);
  assert.deepEqual(plain(state.operationBackend), { host: '127.0.0.1', port: 9876 });
  assert.deepEqual(plain(state.operationPrompts), { ocr: 'ocr', dedup: 'dedup' });
  assert.deepEqual(plain(h.messageCalls), [{
    tabId: 1,
    message: { type: 'selection:start', selectionToken: state.selectionToken }
  }]);
});
```

The event-loop turns in W02–W06 drain already-controlled promise continuations; they introduce no production delay or deadline. Node's test runner must report escaped rejections as failures. W01/W02 are the admitted controls; W08 and existing active-capture/permission-denial tests retain launch behavior.

- [ ] **Step 2: Observe the routing failure.** Run `node --test --test-reporter=tap --test-name-pattern='^W01 ' tests/background.test.js`. Expected diagnostic `W01 expected one top-frame send`; summary `# tests 1`, `# pass 0`, `# fail 1`, `# skipped 0`.

- [ ] **Step 3: Replace only the existing command listener with this implementation.**

```js
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'start-region-capture') {
    try {
      await startupReadiness;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        return;
      }
      const state = getState(tab.id);
      if (state.active || state.captureInFlight || state.status === 'Selecting') {
        console.warn('A capture is already active for this tab.');
        return;
      }
      if (!await ensureBackendPermission()) throw new Error('Backend permission was not granted.');
      await abortDownstreamOperations(tab.id);
      await ensureContentScript(tab.id);
      state.operationBackend = await snapshotBackendSettings();
      invalidateBackendEndpointCache();
      state.operationPrompts = await snapshotCapturePrompts();
      state.selectionToken = createSelectionToken();

      updateState(tab.id, { active: true, status: 'Selecting', progress: 'Drag a rectangle.' });
      await chrome.tabs.sendMessage(tab.id, {
        type: 'selection:start',
        lastRegion: state.lastRegion || undefined,
        selectionToken: state.selectionToken
      });
    } catch (e) {
      console.error('Command handler failed:', e);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        getState(tab.id).selectionToken = null;
        updateState(tab.id, { active: false, status: 'Error', error: e.message, progress: 'Failed.' });
      }
    }
    return;
  }
  if (command !== 'confirm-region-capture') return;
  void (async () => {
    let target = tab;
    if (!target?.id) {
      try {
        [target] = await chrome.tabs.query({ active: true, currentWindow: true });
      } catch {
        return;
      }
    }
    if (!target?.id) return;
    try {
      await chrome.tabs.sendMessage(
        target.id,
        { type: 'selection:confirm' },
        { frameId: 0 }
      );
    } catch {
      // Failed delivery has no confirmation effect.
    }
  })();
});
```

- [ ] **Step 4: Verify worker regressions.** Run `node --test --test-reporter=tap tests/background.test.js`. Expected `# tests 93`, `# pass 93`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`: prior 85 plus W01–W08.

- [ ] **Step 5: Commit.**

```bash
git add extension/background.js tests/background.test.js
git commit -m "feat(extension): route native OCR confirmation to the top frame"
```

## Task 3: Reply to binding lookups exactly once on every completed path

**Implementer tier:** Economy

**Files:**

- Modify: `extension/background.js:448-453` — insert binding branch immediately before final runtime-listener `return false`.
- Modify: `tests/background.test.js:2074-2116` — append six binding tests after prior appended tests.
- Test: `tests/background.test.js`.

**Interfaces:**

- Consumes Task 1: exact row name `confirm-region-capture`; `chrome.commands.getAll(): Promise<Array<{name: string, shortcut: string}>>`.
- Consumes Task 2 test helper `shortcutWorker(options = {}): Promise<h>`, `h.context.chrome`, `h.events.runtimeMessage.emit(...args): Array<unknown>`, `h.assertQuiet()`, and existing `deferred(): {promise, resolve, reject}`. These APIs permit post-startup replacement without counting recovery traffic.
- Produces `commands:binding` listener contract: request `{type: 'commands:binding'}`, literal return `true`, and one reply of `{state: 'assigned', label: string}` for nonempty shortcut, `{state: 'unassigned'}` for `''`, or `{state: 'unavailable'}` for missing/rejected/throwing lookup. Task 6 consumes these three wire shapes and owns local `checking`.

- [ ] **Step 1: Append six binding tests.**

```js
async function bindingProbe(getAll) {
  const h = await shortcutWorker();
  h.context.chrome.commands.getAll = getAll;
  const responses = [];
  const returns = h.events.runtimeMessage.emit(
    { type: 'commands:binding' }, {}, (value) => responses.push(plain(value))
  );
  return { h, returns, responses };
}

test('W09 assigned binding uses exact-name row and asynchronous channel', async () => {
  const gate = deferred();
  const { h, returns, responses } = await bindingProbe(() => gate.promise);
  assert.deepEqual(returns, [true], 'W09 listener must return true');
  assert.deepEqual(responses, []);
  gate.resolve([
    { name: 'start-region-capture', shortcut: 'Ctrl+Shift+S' },
    { name: 'confirm-region-capture-extra', shortcut: 'WRONG' },
    { name: 'confirm-region-capture', shortcut: 'Alt+Shift+O' }
  ]);
  await delay();
  assert.deepEqual(responses, [{ state: 'assigned', label: 'Alt+Shift+O' }]);
  assert.deepEqual(h.queries, []);
  assert.deepEqual(h.sends, []);
  h.assertQuiet();
});

test('W10 empty shortcut is unassigned with no label', async () => {
  const p = await bindingProbe(() => Promise.resolve([
    { name: 'confirm-region-capture', shortcut: '' }
  ]));
  await delay();
  assert.deepEqual(p.returns, [true]);
  assert.deepEqual(p.responses, [{ state: 'unassigned' }]);
  p.h.assertQuiet();
});

test('W11 missing exact command row is unavailable', async () => {
  const p = await bindingProbe(() => Promise.resolve([
    { name: 'start-region-capture', shortcut: 'Ctrl+Shift+S' },
    { name: 'confirm-region-capture-extra', shortcut: 'Alt+Shift+O' }
  ]));
  await delay();
  assert.deepEqual(p.returns, [true]);
  assert.deepEqual(p.responses, [{ state: 'unavailable' }]);
  p.h.assertQuiet();
});

test('W12 rejected lookup replies unavailable without escaped rejection', async () => {
  const p = await bindingProbe(() => Promise.reject(new Error('getAll rejected')));
  await delay();
  assert.deepEqual(p.returns, [true]);
  assert.deepEqual(p.responses, [{ state: 'unavailable' }]);
  p.h.assertQuiet();
});

test('W13 synchronous getAll throw replies before listener returns true', async () => {
  const h = await shortcutWorker();
  h.context.chrome.commands.getAll = () => { throw new Error('getAll threw'); };
  let returned = false;
  const responses = [];
  const returns = h.events.runtimeMessage.emit({ type: 'commands:binding' }, {}, (value) => {
    assert.equal(returned, false);
    responses.push(plain(value));
  });
  returned = true;
  assert.deepEqual(returns, [true]);
  assert.deepEqual(responses, [{ state: 'unavailable' }]);
  await delay();
  assert.equal(responses.length, 1);
  h.assertQuiet();
});

test('W14 replied latch defeats a second failure path', async () => {
  const p = await bindingProbe(() => ({
    then(fulfilled) {
      fulfilled([{ name: 'confirm-region-capture', shortcut: 'Alt+Shift+O' }]);
      return { catch(rejected) { rejected(new Error('late failure')); } };
    }
  }));
  assert.deepEqual(p.returns, [true]);
  assert.deepEqual(p.responses, [{ state: 'assigned', label: 'Alt+Shift+O' }]);
  p.h.assertQuiet();
  const h = await shortcutWorker();
  h.context.chrome.commands.getAll = () => Promise.resolve([
    { name: 'confirm-region-capture', shortcut: 'Alt+Shift+O' }
  ]);
  let calls = 0;
  const returns = h.events.runtimeMessage.emit({ type: 'commands:binding' }, {}, () => {
    calls += 1;
    throw new Error('response delivery threw');
  });
  await delay();
  assert.deepEqual(returns, [true]);
  assert.equal(calls, 1, 'latch is set before sendResponse can throw');
  h.assertQuiet();
});
```

- [ ] **Step 2: Observe the missing async route.** Run `node --test --test-reporter=tap --test-name-pattern='^W09 ' tests/background.test.js`. Expected diagnostic `W09 listener must return true`; summary `# tests 1`, `# pass 0`, `# fail 1`, `# skipped 0`.

- [ ] **Step 3: Insert this branch before the final runtime-listener return.**

```js
  if (message?.type === 'commands:binding') {
    let replied = false;
    const reply = (payload) => {
      if (!replied) {
        replied = true;
        sendResponse(payload);
      }
    };
    try {
      chrome.commands.getAll()
        .then((rows) => {
          const row = rows.find(
            (candidate) => candidate.name === 'confirm-region-capture'
          );
          if (!row) return reply({ state: 'unavailable' });
          return reply(row.shortcut
            ? { state: 'assigned', label: row.shortcut }
            : { state: 'unassigned' });
        })
        .catch(() => reply({ state: 'unavailable' }));
    } catch {
      reply({ state: 'unavailable' });
    }
    return true;
  }
```

- [ ] **Step 4: Verify all worker tests.** Run `node --test --test-reporter=tap tests/background.test.js`. Expected `# tests 99`, `# pass 99`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`: 93 plus six binding tests. W09 is the positive control for all lookup failures; W14 proves the second reply path is actually exercised.

- [ ] **Step 5: Commit.**

```bash
git add extension/background.js tests/background.test.js
git commit -m "feat(extension): expose effective confirmation shortcut binding"
```

## Task 4: Add synchronous content confirmation and preserve admission guards

**Implementer tier:** Standard

**Files:**

- Modify: `extension/content.js:23-38` — insert the new route alongside start/cancel.
- Modify: `tests/content.test.js:12-20` — expose listener returns.
- Modify: `tests/content.test.js:48-120` — retain closed-root/untrusted-pointer regression and strengthen rectangle assertions.
- Modify: `tests/content.test.js:334-457` — replace the positive test with public message-route timing assertions.
- Modify: `tests/content.test.js:544-629` — replace the small-region test with message rejection plus successful adjustment; append test-local scaffolding and eight tests.
- Test: `tests/content.test.js`.

**Interfaces:**

- Consumes Task 2: worker sends exactly `{type: 'selection:confirm'}` to frame 0. Existing `confirmSelection(): void` sets pending/hides synchronously and emits `{type: 'selection:complete', region: {x,y,width,height,viewportWidth,viewportHeight,devicePixelRatio}, selectionToken: string}` only after two nested frames. Admission acknowledgment remains `{ok: true}` or `{ok: false, error: string}`.
- Produces: synchronous content route calls that function, replies exactly `{ok: true}`, returns literal `false` for every guard outcome. Existing start/cancel routes and key guards are unchanged.
- Produces test-local `selectionHarness(): h` with real content VM; `h.deliver(message): {returns: unknown[], responses: object[]}`, `h.start(saved = undefined, token = 'confirm-token')`, `h.confirm()`, `h.draw(x1=100,y1=100,x2=300,y2=250)`, `h.pointer(type,x,y,trusted=true)`, `h.key(fields): boolean` (whether prevented), `h.flushFrame()`, `h.finish(): Promise<void>`, `h.completions(): object[]`, `h.current` (last overlay), `h.overlays`, `h.frames`, `h.sends`, `h.bindings` (controllable `{promise,resolve,reject}` per lookup), `h.window`, `h.pointerEvents`, `h.bindingSend` and `h.completeSend` replaceable functions. Each overlay owns distinct `hint`, `selection`, `root`, `writes`, `listeners`, `removed`, and `captures` fields. Tasks 5–7 consume these exact shapes.
- Produces test helpers `selectionDeferred()`, `selectionPlain(value)`, `selectionSettled(): Promise<void>` (one `setImmediate` turn), `assertConfirmReply(h)` and `SELECTION_R = {x:100,y:100,width:200,height:150}`. Tests do not set private selection state.

- [ ] **Step 1: Add test scaffolding and replace the two legacy-key positive tests.** Change content `createEvent().emit` to:

```js
    emit(...args) {
      return listeners.map((listener) => listener(...args));
    }
```

Insert the following helpers after `createEvent()`; they are available to all subsequent content tests. Expose them only inside this test module, without a new harness file:

```js
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
```

Replace the whole existing test named `selection confirmation uses double-requestAnimationFrame before sending` with:

```js
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
```

Replace the whole existing `region rejects areas smaller than MIN_SIZE` test with:

```js
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
```

In the existing closed-shadow-root/untrusted-pointer test, append these assertions after its existing `windowListeners.has('keydown')` assertion (retain the original test):

```js
  overlayListeners.get('pointermove')({
    isTrusted: false, pointerId: 1, clientX: 300, clientY: 250
  });
  assert.equal(selection.style.left, '0px');
  assert.equal(selection.style.top, '0px');
  assert.equal(selection.style.width, '0px');
  assert.equal(selection.style.height, '0px');
  assert.equal(pointerCaptureCalls, 0);
```

Append these eight new tests:

```js
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
```

- [ ] **Step 2: Observe the missing content route.** Run `node --test --test-reporter=tap --test-name-pattern='^selection confirmation uses double-requestAnimationFrame before sending$' tests/content.test.js`. Expected diagnostic `C01 confirm route must reply synchronously`; summary `# tests 1`, `# pass 0`, `# fail 1`, `# skipped 0`.

- [ ] **Step 3: Insert this branch between existing start and cancel handling.** Do not edit `confirmSelection()` in this task.

```js
    if (message?.type === 'selection:confirm') {
      confirmSelection();
      sendResponse({ ok: true });
      return false;
    }
```

- [ ] **Step 4: Verify content behavior and existing regressions.** Run `node --test --test-reporter=tap tests/content.test.js`. Expected `# tests 18`, `# pass 18`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`: baseline 10, two replaced in place, plus eight new tests. C01/C06 control rejection cases; C08 controls C09/C10; C35 separately tests retrying after an admission rejection without asserting restored worker authorization.

- [ ] **Step 5: Commit.**

```bash
git add extension/content.js tests/content.test.js
git commit -m "feat(extension): confirm OCR selection through the content message route"
```

## Task 5: Remove page Ctrl+Space confirmation while retaining both key guards

**Implementer tier:** Economy

**Files:**

- Modify: `extension/content.js:306-318` — delete only the old confirmation branch.
- Modify: `tests/content.test.js:544-629` — append key-removal regression after existing/prior appended tests.
- Test: `tests/content.test.js`.

**Interfaces:**

- Consumes Task 4: `selectionHarness()`, `h.start(saved, token)`, `h.draw()`, `h.key(fields): boolean`, `h.frames`, `h.completions()`, `h.finish(): Promise<void>`, `assertConfirmReply(h)`; command reply is exactly `{ok:true}` with literal `false` listener result.
- Produces: `onKeyDown(event): void` retains `if (event.isTrusted !== true || confirmPending) return;` and the existing Escape body, and has no confirmation-key branch. `_preventScrollKeys` is unchanged; this is removal of OCR confirmation only.
- Produces: C07 demonstrates the former trusted page event fails to confirm while the real message route still succeeds on the same valid overlay.

- [ ] **Step 1: Append the removal regression.**

```js
test('C07 page Ctrl+Space and Ctrl+Shift+Space no longer confirm OCR', async () => {
  const h = selectionHarness();
  h.start();
  h.draw();
  for (const shiftKey of [false, true]) {
    assert.equal(h.key({ key: ' ', ctrlKey: true, shiftKey }), false,
      'C07 selection handler must leave the former confirmation key unhandled');
    assert.equal(h.frames.length, 0);
    assert.deepEqual(h.completions(), []);
    assert.equal(h.current.removed, false);
    assert.equal(h.current.style.display, '');
  }
  assertConfirmReply(h);
  await h.finish();
  assert.equal(h.completions().length, 1);
  assert.equal(h.current.removed, true);
});
```

- [ ] **Step 2: Observe the legacy branch failure.** Run `node --test --test-reporter=tap --test-name-pattern='^C07 ' tests/content.test.js`. Expected diagnostic `C07 selection handler must leave the former confirmation key unhandled`; summary `# tests 1`, `# pass 0`, `# fail 1`, `# skipped 0`.

- [ ] **Step 3: Replace `onKeyDown` with this exact body.**

```js
  function onKeyDown(event) {
    if (event.isTrusted !== true || confirmPending) return;
    if (event.key === 'Escape') {
      const cancelledToken = selectionToken;
      removeOverlay();
      chrome.runtime.sendMessage({ type: 'selection:cancelled', selectionToken: cancelledToken }).catch(() => {});
    }
  }
```

- [ ] **Step 4: Verify removal and Escape/pending regressions together.** Run `node --test --test-reporter=tap tests/content.test.js`. Expected `# tests 19`, `# pass 19`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`. C08–C10 must remain present and passing; unchanged scroll-lock tests must still pass.

- [ ] **Step 5: Commit.**

```bash
git add extension/content.js tests/content.test.js
git commit -m "fix(extension): stop confirming OCR with page Ctrl Space"
```

## Task 6: Render binding hints with overlay ownership and diagnostic precedence

**Implementer tier:** Advanced

**Files:**

- Modify: `extension/content.js:5-14` — presentation-only state beside existing DOM references.
- Modify: `extension/content.js:101-154` — inline hint CSS, saved/fresh initialization, and helper insertion before `getHandleAt`.
- Modify: `extension/content.js:179-259` — snapshot before existing trusted pointer mutations and clear diagnostics after actual changes.
- Modify: `extension/content.js:295-300` — route the existing diagnostic text through presentation ownership.
- Modify: `extension/content.js:345-363` — discard presentation state with overlay cleanup.
- Modify: `extension/overlay.css:40-52` — external hint wrapping.
- Modify: `tests/content.test.js:544-629` — append hint helpers, seventeen hint tests, and one style test after previous appended tests.
- Test: `tests/content.test.js`.

**Interfaces:**

- Consumes Task 3: exact request `{type: 'commands:binding'}`; reply `{state:'assigned',label:string}` / `{state:'unassigned'}` / `{state:'unavailable'}`. Missing/malformed/unknown replies normalize to unavailable. Synchronous throws and promise rejections are distinct failure paths.
- Consumes Task 4 test helpers `selectionHarness()`, `selectionSettled()`, `assertConfirmReply(h)`, `SELECTION_R`, and harness fields `h.current.{hint,selection,root,writes,removed,captures}`, `h.bindings[i].{resolve,reject,promise}`, `h.sends`, `h.frames`, `h.pointer(type,x,y,trusted)`, `h.draw()`, `h.start(saved,token)`, `h.deliver(message)`, `h.finish()`, `h.bindingSend`, `h.completeSend`.
- Consumes existing `startSelectionMode(saved,token)`, `onPointerDown(event)`, `onPointerMove(event)`, `removeOverlay()`, and unchanged `confirmSelection()` mechanism. The only edit within confirmation is replacing its direct hint write with `showHintDiagnostic(text)`.
- Produces presentation-only `hintPresentation = {owner: HTMLElement,node: HTMLElement,prefix: string,binding: {state:string,label?:string},diagnostic: string|null} | null`; `initializeHint(owner,node,prefix): void`, `receiveBinding(p,reply): void`, `paintBindingHint(p): void`, `showHintDiagnostic(text): void`, `clearHintDiagnosticAfterChange(before): void`. These are internal content helpers, never messages/authorization fields.
- Produces test-only `HINTS`, `HINT_DIAGNOSTIC`, and `rejectSelection(h): Promise<void>` for exact text and diagnostic setup. Task 7 uses the existing harness unchanged, so it remains independent of presentation internals.

- [ ] **Step 1: Append exact-text, failure, ownership, diagnostic, and style tests.**

```js
const HINTS = {
  fresh: {
    checking: 'Drag to select OCR region. Confirmation shortcut checking… Set it at chrome://extensions/shortcuts. Esc to cancel.',
    assigned: 'Drag to select OCR region. Alt+Shift+O to confirm. Esc to cancel.',
    unassigned: 'Drag to select OCR region. Confirmation shortcut not set; set “Confirm selected OCR region” at chrome://extensions/shortcuts. Esc to cancel.',
    unavailable: 'Drag to select OCR region. Confirmation shortcut unavailable; check “Confirm selected OCR region” at chrome://extensions/shortcuts. Esc to cancel.'
  },
  saved: {
    checking: 'Drag to adjust. Confirmation shortcut checking… Set it at chrome://extensions/shortcuts. Esc to cancel.',
    assigned: 'Drag to adjust. Alt+Shift+O to confirm. Esc to cancel.',
    unassigned: 'Drag to adjust. Confirmation shortcut not set; set “Confirm selected OCR region” at chrome://extensions/shortcuts. Esc to cancel.',
    unavailable: 'Drag to adjust. Confirmation shortcut unavailable; check “Confirm selected OCR region” at chrome://extensions/shortcuts. Esc to cancel.'
  }
};
const HINT_DIAGNOSTIC = 'Selection confirmation is stale or unauthorized. Adjust the region and try again.';
async function rejectSelection(h) {
  h.completeSend = () => Promise.resolve({
    ok: false, error: 'Selection confirmation is stale or unauthorized.'
  });
  assertConfirmReply(h);
  await h.finish();
  assert.equal(h.current.style.display, '');
  assert.equal(h.current.removed, false);
  assert.equal(h.current.hint.textContent, HINT_DIAGNOSTIC);
}

for (const [kind, saved, checkingID, assignedID, unassignedID, unavailableID] of [
  ['fresh', undefined, 'C11', 'C13', 'C15', 'C17'],
  ['saved', SELECTION_R, 'C12', 'C14', 'C16', 'C18']
]) {
  test(`${checkingID} ${kind} checking is synchronous and requests once`, () => {
    const h = selectionHarness();
    assert.deepEqual(h.start(saved), { returns: [false], responses: [{ ok: true }] });
    assert.equal(h.current.hint.textContent, HINTS[kind].checking,
      `${checkingID} must render ${kind} checking text synchronously`);
    assert.deepEqual(h.sends, [{ type: 'commands:binding' }]);
    assert.equal(h.bindings.length, 1);
    assert.equal(h.current.hint.textContent.includes('Ctrl+Space'), false);
    assert.equal(h.current.hint.textContent.includes('Ctrl+Shift+Space'), false);
    if (saved) {
      assert.equal(h.current.selection.style.left, '100px');
      assert.equal(h.current.selection.style.top, '100px');
      assert.equal(h.current.selection.style.width, '200px');
      assert.equal(h.current.selection.style.height, '150px');
    }
  });
  test(`${assignedID} ${kind} assigned renders Chrome label verbatim as text`, async () => {
    const h = selectionHarness();
    h.start(saved);
    h.bindings[0].resolve({ state: 'assigned', label: 'Alt+Shift+O' });
    await selectionSettled();
    assert.equal(h.current.hint.textContent, HINTS[kind].assigned);
    const literal = selectionHarness();
    literal.start(saved);
    literal.bindings[0].resolve({ state: 'assigned', label: ' <b>Alt+O</b> ' });
    await selectionSettled();
    const prefix = kind === 'saved' ? 'Drag to adjust.' : 'Drag to select OCR region.';
    assert.equal(literal.current.hint.textContent, `${prefix}  <b>Alt+O</b>  to confirm. Esc to cancel.`);
  });
  test(`${unassignedID} ${kind} unassigned is explicit and preserves initial verb`, async () => {
    const h = selectionHarness();
    h.start(saved);
    h.bindings[0].resolve({ state: 'unassigned' });
    await selectionSettled();
    assert.equal(h.current.hint.textContent, HINTS[kind].unassigned);
  });
  test(`${unavailableID} ${kind} unavailable differs from intentionally unassigned`, async () => {
    const h = selectionHarness();
    h.start(saved);
    h.bindings[0].resolve({ state: 'unavailable' });
    await selectionSettled();
    assert.equal(h.current.hint.textContent, HINTS[kind].unavailable);
    assert.notEqual(h.current.hint.textContent, HINTS[kind].unassigned);
  });
}

test('C19 rejected binding transport shows unavailable and still permits confirmation', async () => {
  const h = selectionHarness();
  h.start();
  assert.equal(h.current.hint.textContent, HINTS.fresh.checking);
  h.bindings[0].reject(new Error('binding transport rejected'));
  await selectionSettled();
  assert.equal(h.current.hint.textContent, HINTS.fresh.unavailable);
  h.draw();
  assertConfirmReply(h);
  await h.finish();
  assert.equal(h.completions().length, 1);
});

test('C20 synchronous binding transport throw is unavailable immediately', async () => {
  const h = selectionHarness();
  h.bindingSend = () => { throw new Error('binding transport threw'); };
  assert.deepEqual(h.start(), { returns: [false], responses: [{ ok: true }] });
  assert.equal(h.current.hint.textContent, HINTS.fresh.unavailable);
  assert.equal(h.bindings.length, 1);
  h.draw();
  assertConfirmReply(h);
  await h.finish();
  assert.equal(h.completions().length, 1);
});

test('C21 malformed binding replies normalize to unavailable', async () => {
  for (const reply of [
    undefined, null, {}, { state: 'mystery' }, { state: 'checking' },
    { state: 'assigned' }, { state: 'assigned', label: '' },
    { state: 'assigned', label: 7 }, { state: 'assigned', label: null }
  ]) {
    const h = selectionHarness();
    h.start();
    h.bindings[0].resolve(reply);
    await selectionSettled();
    assert.equal(h.current.hint.textContent, HINTS.fresh.unavailable);
  }
});

test('C22 closed A reply cannot repaint detached A or checking B', async () => {
  const h = selectionHarness();
  h.start();
  const a = h.current;
  h.deliver({ type: 'selection:cancel' });
  h.start(SELECTION_R, 'B');
  const b = h.current;
  const aWrites = a.writes.length;
  const bWrites = b.writes.length;
  h.bindings[0].resolve({ state: 'assigned', label: 'Old+A' });
  await selectionSettled();
  assert.equal(a.removed, true);
  assert.equal(a.writes.length, aWrites);
  assert.equal(b.writes.length, bWrites);
  assert.equal(b.hint.textContent, HINTS.saved.checking);
  h.bindings[1].resolve({ state: 'assigned', label: 'Alt+Shift+O' });
  await selectionSettled();
  assert.equal(b.hint.textContent, HINTS.saved.assigned);
});

test('C23 stale success or rejection cannot overwrite assigned B', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const h = selectionHarness();
    h.start();
    const a = h.current;
    h.start(SELECTION_R, 'B');
    const b = h.current;
    h.bindings[1].resolve({ state: 'assigned', label: 'Alt+Shift+O' });
    await selectionSettled();
    const aWrites = a.writes.length;
    const bWrites = b.writes.length;
    h.bindings[0][outcome](outcome === 'resolve'
      ? { state: 'assigned', label: 'Old+A' } : new Error('old failure'));
    await selectionSettled();
    assert.equal(a.writes.length, aWrites);
    assert.equal(b.writes.length, bWrites);
    assert.equal(b.hint.textContent, HINTS.saved.assigned);
  }
});

test('C24 diagnostic precedes later binding success or failure', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const h = selectionHarness();
    h.start(SELECTION_R);
    await rejectSelection(h);
    const writes = h.current.writes.length;
    h.bindings[0][outcome](outcome === 'resolve'
      ? { state: 'assigned', label: 'Alt+Shift+O' } : new Error('lookup failed'));
    await selectionSettled();
    assert.equal(h.current.hint.textContent, HINT_DIAGNOSTIC);
    assert.equal(h.current.writes.length, writes);
    h.pointer('pointerdown', 150, 150);
    h.pointer('pointermove', 170, 180);
    h.pointer('pointerup', 170, 180);
    assert.equal(h.current.hint.textContent, outcome === 'resolve'
      ? HINTS.saved.assigned : HINTS.saved.unavailable);
  }
});

test('C25 diagnostic replaces an earlier assigned binding', async () => {
  const h = selectionHarness();
  h.start(SELECTION_R);
  h.bindings[0].resolve({ state: 'assigned', label: 'Alt+Shift+O' });
  await selectionSettled();
  assert.equal(h.current.hint.textContent, HINTS.saved.assigned);
  await rejectSelection(h);
  await selectionSettled();
  assert.equal(h.current.hint.textContent, HINT_DIAGNOSTIC);
  assert.equal(h.bindings.length, 1);
});

test('C26 only trusted actual rectangle changes clear diagnostic', async () => {
  for (const bound of [false, true]) {
    const h = selectionHarness();
    h.start(SELECTION_R);
    await rejectSelection(h);
    if (bound) {
      h.bindings[0].resolve({ state: 'assigned', label: 'Alt+Shift+O' });
      await selectionSettled();
    }
    h.pointer('pointerdown', 400, 400, false);
    assert.equal(h.current.hint.textContent, HINT_DIAGNOSTIC);
    h.pointer('pointerdown', 150, 150);
    h.pointer('pointermove', 150, 150);
    h.pointer('pointerup', 150, 150);
    assert.equal(h.current.hint.textContent, HINT_DIAGNOSTIC);
    h.pointer('pointerdown', 150, 150);
    h.pointer('pointermove', 170, 180, false);
    assert.equal(h.current.hint.textContent, HINT_DIAGNOSTIC);
    h.pointer('pointermove', 170, 180);
    h.pointer('pointerup', 170, 180);
    assert.equal(h.current.hint.textContent, bound ? HINTS.saved.assigned : HINTS.saved.checking);
  }
  const h = selectionHarness();
  h.start(SELECTION_R);
  await rejectSelection(h);
  h.pointer('pointerdown', 400, 400);
  assert.equal(h.current.hint.textContent, HINTS.saved.checking,
    'a new-region pointerdown that actually changes geometry also clears diagnostic');
});

test('C27 reopening resets ownership diagnostic and binding snapshot', async () => {
  const h = selectionHarness();
  h.start(SELECTION_R);
  h.bindings[0].resolve({ state: 'assigned', label: 'Alt+Shift+O' });
  await selectionSettled();
  await rejectSelection(h);
  const old = h.current;
  h.deliver({ type: 'selection:cancel' });
  h.start();
  assert.notEqual(h.current, old);
  assert.equal(h.current.hint.textContent, HINTS.fresh.checking);
  assert.equal(h.bindings.length, 2);
  h.bindings[1].resolve({ state: 'assigned', label: 'Ctrl+Shift+Space' });
  await selectionSettled();
  assert.equal(h.current.hint.textContent,
    'Drag to select OCR region. Ctrl+Shift+Space to confirm. Esc to cancel.');
  h.draw();
  await selectionSettled();
  assert.equal(h.bindings.length, 2);
});

test('C36 injected closed-root and external hint styles both allow wrapping', () => {
  const h = selectionHarness();
  h.start();
  assert.equal(h.current.shadowMode, 'closed');
  const external = fs.readFileSync(path.join(ROOT, 'extension', 'overlay.css'), 'utf8');
  for (const source of [h.current.root.innerHTML, external]) {
    const rule = source.match(/\.textkit-hint\s*\{([^}]+)\}/)[1];
    assert.match(rule, /max-width:\s*calc\(100vw - 32px\);/);
    assert.match(rule, /overflow-wrap:\s*anywhere;/);
    assert.doesNotMatch(rule, /white-space:\s*nowrap/);
  }
});
```

- [ ] **Step 2: Observe the stale initial hint failure.** Run `node --test --test-reporter=tap --test-name-pattern='^C11 ' tests/content.test.js`. Expected diagnostic `C11 must render fresh checking text synchronously`; summary `# tests 1`, `# pass 0`, `# fail 1`, `# skipped 0`.

- [ ] **Step 3: Add presentation state and helpers.** Add `let hintPresentation = null;` immediately after `let hint = null;`. Insert these complete functions between `startSelectionMode` and `getHandleAt`:

```js
  function paintBindingHint(p) {
    if (p.owner !== overlay || hintPresentation !== p || p.diagnostic !== null) return;
    let clause;
    if (p.binding.state === 'assigned') {
      clause = `${p.binding.label} to confirm.`;
    } else if (p.binding.state === 'unassigned') {
      clause = 'Confirmation shortcut not set; set “Confirm selected OCR region” at chrome://extensions/shortcuts.';
    } else if (p.binding.state === 'unavailable') {
      clause = 'Confirmation shortcut unavailable; check “Confirm selected OCR region” at chrome://extensions/shortcuts.';
    } else {
      clause = 'Confirmation shortcut checking… Set it at chrome://extensions/shortcuts.';
    }
    if (p.owner !== overlay || hintPresentation !== p || p.diagnostic !== null) return;
    p.node.textContent = `${p.prefix} ${clause} Esc to cancel.`;
  }

  function receiveBinding(p, reply) {
    if (p.owner !== overlay || hintPresentation !== p) return;
    if (reply?.state === 'assigned' && typeof reply.label === 'string' && reply.label.length > 0) {
      p.binding = { state: 'assigned', label: reply.label };
    } else if (reply?.state === 'unassigned') {
      p.binding = { state: 'unassigned' };
    } else {
      p.binding = { state: 'unavailable' };
    }
    if (p.diagnostic !== null) return;
    paintBindingHint(p);
  }

  function initializeHint(owner, node, prefix) {
    const p = { owner, node, prefix, binding: { state: 'checking' }, diagnostic: null };
    hintPresentation = p;
    paintBindingHint(p);
    try {
      chrome.runtime.sendMessage({ type: 'commands:binding' })
        .then((reply) => receiveBinding(p, reply))
        .catch(() => receiveBinding(p, { state: 'unavailable' }));
    } catch {
      receiveBinding(p, { state: 'unavailable' });
    }
  }

  function showHintDiagnostic(text) {
    const p = hintPresentation;
    if (!p || p.owner !== overlay) return;
    p.diagnostic = text;
    if (p.owner !== overlay || hintPresentation !== p || p.diagnostic !== text) return;
    p.node.textContent = text;
  }

  function clearHintDiagnosticAfterChange(before) {
    const p = hintPresentation;
    if (!p || p.owner !== overlay || p.diagnostic === null || !region) return;
    if (['x', 'y', 'width', 'height'].some((key) => before[key] !== region[key])) {
      p.diagnostic = null;
      paintBindingHint(p);
    }
  }
```

`receiveBinding` is the reply/failure check point; `paintBindingHint` checks ownership/diagnostic again immediately before writing. Diagnostic and binding state are stored only in this overlay's presentation object; no selection ID, token lookup, capture state, or deferred painter is added.

- [ ] **Step 4: Replace `startSelectionMode` with this complete version.** It retains all DOM, saved-region, listener, and geometry behavior, while choosing the initial verb once and starting exactly one non-awaited lookup.

```js
  function startSelectionMode(saved, token) {
    removeOverlay();

    overlay = document.createElement('div');
    overlay.className = 'textkit-overlay';
    overlayRoot = overlay.attachShadow({ mode: 'closed' });
    overlayRoot.innerHTML = `<style>${OVERLAY_STYLES}</style>`
      + '<div class="textkit-selection"></div>'
      + '<div class="textkit-handle nw"></div>'
      + '<div class="textkit-handle n"></div>'
      + '<div class="textkit-handle ne"></div>'
      + '<div class="textkit-handle e"></div>'
      + '<div class="textkit-handle se"></div>'
      + '<div class="textkit-handle s"></div>'
      + '<div class="textkit-handle sw"></div>'
      + '<div class="textkit-handle w"></div>'
      + '<div class="textkit-hint"></div>';
    document.documentElement.appendChild(overlay);
    selectionToken = token;

    selection = overlayRoot.querySelector('.textkit-selection');
    handles = [...overlayRoot.querySelectorAll('.textkit-handle')];
    hint = overlayRoot.querySelector('.textkit-hint');

    // Pre-draw saved region if available
    const restored = saved && saved.width >= MIN_SIZE && saved.height >= MIN_SIZE;
    if (restored) {
      region = {
        x: clamp(saved.x, 0, Math.max(0, window.innerWidth - MIN_SIZE)),
        y: clamp(saved.y, 0, Math.max(0, window.innerHeight - MIN_SIZE)),
        width: clamp(saved.width, MIN_SIZE, Math.max(MIN_SIZE, window.innerWidth - clamp(saved.x, 0, window.innerWidth))),
        height: clamp(saved.height, MIN_SIZE, Math.max(MIN_SIZE, window.innerHeight - clamp(saved.y, 0, window.innerHeight)))
      };
    } else {
      region = { x: 0, y: 0, width: 0, height: 0 };
    }
    initializeHint(overlay, hint, restored ? 'Drag to adjust.' : 'Drag to select OCR region.');

    drawRegion();

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown, true);
  }
```

- [ ] **Step 5: Hook only presentation clearing around existing trusted mutations.** In `onPointerDown`, immediately after its unchanged guard, insert `const before = { ...region };`. Immediately before that function's final `drawRegion();`, insert `clearHintDiagnosticAfterChange(before);`. In `onPointerMove`, immediately after its unchanged guard, insert the same snapshot, and immediately before its final `drawRegion();`, insert the same clear call. The resulting entry/end anchors are:

```js
  function onPointerDown(event) {
    if (!overlay || event.isTrusted !== true || confirmPending) return;
    const before = { ...region };
    overlay.setPointerCapture(event.pointerId);
```

```js
    overlay.style.cursor = CURSOR_MAP[dragMode] || '';
    clearHintDiagnosticAfterChange(before);
    drawRegion();
  }
```

```js
  function onPointerMove(event) {
    if (event.isTrusted !== true || !dragMode || !dragStart) return;
    const before = { ...region };
    const ex = clamp(event.clientX, 0, window.innerWidth);
```

```js
          region.width = dragStart.rx + dragStart.rw - region.x;
          break;
      }
    clearHintDiagnosticAfterChange(before);
    drawRegion();
  }
```

Leave every line between these anchors, including the complete geometry switch, unchanged. Replace the single diagnostic write inside `confirmSelection()` with:

```js
          showHintDiagnostic(`${error.message} Adjust the region and try again.`);
```

In `removeOverlay()`, immediately after `hint = null;`, add:

```js
    hintPresentation = null;
```

- [ ] **Step 6: Change both hint style rules.** In `OVERLAY_STYLES`, replace the `white-space` line with:

```css
      max-width: calc(100vw - 32px);
      overflow-wrap: anywhere; }
```

In external `.textkit-hint`, replace its `white-space` declaration with:

```css
  max-width: calc(100vw - 32px);
  overflow-wrap: anywhere;
```

- [ ] **Step 7: Verify the content suite.** Run `node --test --test-reporter=tap tests/content.test.js`. Expected `# tests 37`, `# pass 37`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`: prior 19 plus C11–C27 (17) and C36 (1). Existing tests with permissive `{ok:true}` binding stubs now normalize to unavailable; they must not count lookup traffic as completion traffic. C01/C05 already filter through `h.completions()`. Do not change assertions to count every runtime send.

- [ ] **Step 8: Commit.**

```bash
git add extension/content.js extension/overlay.css tests/content.test.js
git commit -m "feat(extension): show effective OCR shortcut in owned overlay hints"
```

## Task 7: Record the pinned oracle and prove delivery-time/admission semantics

**Implementer tier:** Advanced

**Files:**

- Create: `tests/fixtures/selection-complete-baseline.json` — generated only from the pinned original test.
- Modify: `tests/content.test.js:334-457` — upgrade C01's full payload assertion to the recorded fixture.
- Modify: `tests/content.test.js:544-629` — append C28–C34 after prior appended tests.
- Modify: `tests/background.test.js:2074-2116` — append test-local content loader, admission spy, and W16–W23 after prior appended tests.
- Test: `tests/background.test.js`.
- Test: `tests/content.test.js`.

**Interfaces:**

- Consumes Task 4 content helpers `selectionHarness()`, `selectionPlain(value)`, `assertConfirmReply(h)`, `SELECTION_R`, with `h.deliver(message): {returns,responses}`, `h.start(saved,token)`, `h.draw()`, `h.pointer(type,x,y,trusted=true)`, `h.current.{style,selection,removed,captures}`, `h.window.{innerWidth,innerHeight,devicePixelRatio}`, `h.finish(): Promise<void>`, `h.completions(): object[]`, `h.frames`, `h.overlays`, `h.pointerEvents`. Tasks 5/6 do not rename these.
- Consumes Task 2 `shortcutWorker(options): Promise<h>`, `plain(value)`, `h.events.command.emit(...): unknown[]`, `h.queries`, `h.sends`, replaceable `h.deliver(tabId,message,options): Promise<unknown>`, and `h.assertQuiet()`; existing `createBackgroundHarness(options)`, `deferred()`, `delay()`, `REGION` remain available.
- Produces test-only `commandReceiver(): h`, loading the already-authored real content harness in memory while suppressing its test registration; no tracked helper file. W17/W18 call the actual content router and inspect real content completions. The tests stub completion admission, so neither claims a real inactive-tab capture began.
- Produces test-only `admissionHarness(seed = true): Promise<h>` with real worker runtime listener and a replaced `runCaptureLoop(tab,region): Promise<void>` spy; `h.admissions`, `h.admissionEvents`, `h.probe(region=REGION,token='expected',sender={tab:{id:1,windowId:10,active:true}}): {returns,responses}`. It asserts the unchanged worker block, never edits that product block.
- Produces fixture schema exactly `{type:'selection:complete',region:{x:number,y:number,width:number,height:number,viewportWidth:number,viewportHeight:number,devicePixelRatio:number},selectionToken:string}` with two-space JSON indentation and final LF. Values come exclusively from pinned oracle `c47dec6a24b42bcdb25f2c4fbe731deca8ce4431`.

- [ ] **Step 1: Make C01 require the historical fixture and append delivery/admission tests.** Replace only C01's current literal `assert.deepEqual(h.completions(), [{...}]);` with:

```js
  const fixture = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests', 'fixtures', 'selection-complete-baseline.json'), 'utf8'
  ));
  assert.deepEqual(h.completions(), [fixture]);
```

Append the seven delivery cases to `tests/content.test.js`:

```js
const DELIVERY_B = { x: 30, y: 40, width: 80, height: 60 };
function heldConfirm(receiver) {
  const message = { type: 'selection:confirm' };
  return () => {
    const h = receiver();
    assert.deepEqual(h.deliver(message), { returns: [false], responses: [{ ok: true }] });
    return h;
  };
}
function expectedCompletion(region, token, viewportWidth = 1200, viewportHeight = 800, devicePixelRatio = 1) {
  return {
    type: 'selection:complete',
    region: { ...region, viewportWidth, viewportHeight, devicePixelRatio },
    selectionToken: token
  };
}

test('C28 held confirm with live A uses unchanged A region token and viewport', async () => {
  const h = selectionHarness();
  h.start(SELECTION_R, 'A');
  const deliver = heldConfirm(() => h);
  assert.deepEqual(h.completions(), []);
  deliver();
  await h.finish();
  assert.deepEqual(h.completions(), [expectedCompletion(SELECTION_R, 'A')]);
});

test('C29 same-document A replacement confirms only current B', async () => {
  const h = selectionHarness();
  h.start(SELECTION_R, 'A');
  const a = h.current;
  const deliver = heldConfirm(() => h);
  h.deliver({ type: 'selection:cancel' });
  h.start(DELIVERY_B, 'B');
  deliver();
  await h.finish();
  assert.equal(a.removed, true);
  assert.equal(h.overlays.length, 2);
  assert.deepEqual(h.completions(), [expectedCompletion(DELIVERY_B, 'B')]);
});

test('C30 press with no overlay may confirm one started before delivery', async () => {
  const h = selectionHarness();
  const deliver = heldConfirm(() => h);
  assert.equal(h.overlays.length, 0);
  h.start(DELIVERY_B, 'B');
  deliver();
  await h.finish();
  assert.deepEqual(h.completions(), [expectedCompletion(DELIVERY_B, 'B')]);
});

test('C31 replacement top document without overlay creates and confirms nothing', () => {
  let topDocument = selectionHarness();
  const oldDocument = topDocument;
  oldDocument.start(SELECTION_R, 'old-doc');
  const deliver = heldConfirm(() => topDocument);
  topDocument = selectionHarness();
  deliver();
  assert.equal(topDocument.overlays.length, 0);
  assert.equal(topDocument.frames.length, 0);
  assert.deepEqual(topDocument.completions(), []);
  assert.deepEqual(oldDocument.completions(), []);
});

test('C32 replacement top document with a started overlay confirms its new token', async () => {
  let topDocument = selectionHarness();
  const oldDocument = topDocument;
  oldDocument.start(SELECTION_R, 'old-doc');
  const deliver = heldConfirm(() => topDocument);
  topDocument = selectionHarness();
  topDocument.start(DELIVERY_B, 'new-doc');
  deliver();
  await topDocument.finish();
  assert.deepEqual(topDocument.completions(), [expectedCompletion(DELIVERY_B, 'new-doc')]);
  assert.deepEqual(oldDocument.completions(), []);
});

test('C33 pre-delivery adjustment uses delivery-time rectangle viewport and DPR', async () => {
  const h = selectionHarness();
  h.start(SELECTION_R, 'A');
  const deliver = heldConfirm(() => h);
  h.pointer('pointerdown', 150, 150);
  h.pointer('pointermove', 170, 180);
  h.pointer('pointerup', 170, 180);
  h.window.innerWidth = 1000;
  h.window.innerHeight = 700;
  h.window.devicePixelRatio = 2;
  deliver();
  await h.finish();
  assert.deepEqual(h.completions(), [expectedCompletion(
    { x: 120, y: 130, width: 200, height: 150 }, 'A', 1000, 700, 2
  )]);
});

test('C34 restored region confirms before any pointer event and equals fixture', async () => {
  const h = selectionHarness();
  h.start(SELECTION_R);
  assert.equal(h.current.selection.style.left, '100px');
  assert.equal(h.current.selection.style.top, '100px');
  assert.equal(h.current.selection.style.width, '200px');
  assert.equal(h.current.selection.style.height, '150px');
  assert.equal(h.pointerEvents, 0);
  assert.equal(h.current.captures, 0);
  assertConfirmReply(h);
  await h.finish();
  const fixture = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tests', 'fixtures', 'selection-complete-baseline.json'), 'utf8'
  ));
  assert.equal(h.pointerEvents, 0);
  assert.equal(h.current.captures, 0);
  assert.deepEqual(h.completions(), [fixture]);
});
```

Append this exact receiver loader, worker spy, and eight tests to `tests/background.test.js`:

```js
function commandReceiver() {
  const filename = path.join(ROOT, 'tests', 'content.test.js');
  const localRequire = require('node:module').createRequire(filename);
  const receiverModule = { exports: {} };
  const source = fs.readFileSync(filename, 'utf8') + '\nmodule.exports = { selectionHarness };\n';
  const evaluate = new Function('require', 'module', 'exports', '__dirname', '__filename', source);
  evaluate(
    (name) => name === 'node:test' ? () => {} : localRequire(name),
    receiverModule, receiverModule.exports, path.dirname(filename), filename
  );
  return receiverModule.exports.selectionHarness();
}

async function admissionHarness(seed = true) {
  const h = createBackgroundHarness();
  await vm.runInContext('startupReadiness', h.context);
  if (seed) Object.assign(h.context.getState(1), {
    status: 'Selecting', active: true, selectionToken: 'expected'
  });
  h.admissions = [];
  h.admissionEvents = [];
  h.context.__admissions = h.admissions;
  h.context.__admissionEvents = h.admissionEvents;
  vm.runInContext(`
    runCaptureLoop = async (tab, region) => {
      __admissionEvents.push('pipeline');
      __admissions.push({ tab, region, tokenAtLaunch: getState(tab.id).selectionToken });
    };
  `, h.context);
  h.probe = (region = REGION, token = 'expected', sender = {
    tab: { id: 1, windowId: 10, active: true }
  }) => {
    const responses = [];
    const returns = h.events.runtimeMessage.emit({
      type: 'selection:complete', region, selectionToken: token
    }, sender, (reply) => {
      h.admissionEvents.push('reply');
      responses.push(plain(reply));
    });
    return { returns, responses };
  };
  return h;
}

test('W16 worker admits valid completion consumes token saves and acknowledges before capture', async () => {
  for (const [token, region] of [
    ['expected', { ...REGION, devicePixelRatio: 1 }],
    ['new-doc', { x: 30, y: 40, width: 80, height: 60,
      viewportWidth: 1200, viewportHeight: 800, devicePixelRatio: 1 }],
    ['expected', { x: '-5', y: '-6', width: '100', height: '80',
      viewportWidth: '1200', viewportHeight: '800', devicePixelRatio: 'unexamined' }]
  ]) {
    const h = await admissionHarness();
    h.context.getState(1).selectionToken = token;
    const result = h.probe(region, token);
    assert.deepEqual(result, { returns: [false], responses: [{ ok: true }] });
    assert.deepEqual(h.admissionEvents, ['reply', 'pipeline']);
    assert.equal(h.context.getState(1).selectionToken, null);
    const saved = { x: region.x, y: region.y, width: region.width, height: region.height };
    assert.deepEqual(plain(h.localData.lastRegion), saved);
    assert.deepEqual(plain(h.context.getState(1).lastRegion), saved);
    assert.equal(h.admissions.length, 1);
    assert.deepEqual(plain(h.admissions[0].region), region);
    assert.equal(h.admissions[0].tab.id, 1);
    assert.equal(h.admissions[0].tokenAtLaunch, null);
  }
});

test('W17 supplied tab stays the receiver after focus changes before delivery', async () => {
  const h = await shortcutWorker({ tabs: [
    { id: 11, windowId: 10, active: true },
    { id: 12, windowId: 10, active: false }
  ] });
  const t = commandReceiver();
  const u = commandReceiver();
  const rT = { x: 100, y: 100, width: 200, height: 150 };
  const rU = { x: 30, y: 40, width: 80, height: 60 };
  t.start(rT, 'T');
  u.start(rU, 'U');
  const delivery = deferred();
  let focus = 11;
  h.context.chrome.tabs.query = async (query) => {
    h.queries.push(plain(query));
    return [{ id: focus }];
  };
  h.deliver = async (tabId, message, options) => {
    await delivery.promise;
    assert.deepEqual(plain(options), { frameId: 0 });
    const receiver = tabId === 11 ? t : u;
    const result = receiver.deliver(plain(message));
    assert.deepEqual(result, { returns: [false], responses: [{ ok: true }] });
    return result.responses[0];
  };
  await Promise.all(h.events.command.emit('confirm-region-capture', { id: 11 }));
  focus = 12;
  assert.deepEqual(h.sends, [CONFIRM_SEND]);
  assert.deepEqual(h.queries, []);
  assert.deepEqual(t.completions(), []);
  delivery.resolve();
  await delay();
  await t.finish();
  assert.deepEqual(t.completions(), [{
    type: 'selection:complete',
    region: { ...rT, viewportWidth: 1200, viewportHeight: 800, devicePixelRatio: 1 },
    selectionToken: 'T'
  }]);
  assert.deepEqual(u.completions(), []);
  assert.equal(u.frames.length, 0);
  h.assertQuiet();
});

test('W18 one delayed fallback query resolves to newly focused live receiver', async () => {
  const h = await shortcutWorker({ tabs: [
    { id: 11, windowId: 10, active: true },
    { id: 12, windowId: 10, active: false }
  ] });
  const t = commandReceiver();
  const u = commandReceiver();
  const rU = { x: 30, y: 40, width: 80, height: 60 };
  t.start({ x: 100, y: 100, width: 200, height: 150 }, 'T');
  u.start(rU, 'U');
  const query = deferred();
  let focus = 11;
  h.context.chrome.tabs.query = (args) => {
    h.queries.push(plain(args));
    return query.promise;
  };
  h.deliver = async (tabId, message, options) => {
    assert.deepEqual(plain(options), { frameId: 0 });
    const result = (tabId === 12 ? u : t).deliver(plain(message));
    assert.deepEqual(result, { returns: [false], responses: [{ ok: true }] });
    return result.responses[0];
  };
  await Promise.all(h.events.command.emit('confirm-region-capture'));
  assert.deepEqual(h.queries, [{ active: true, currentWindow: true }]);
  assert.deepEqual(h.sends, []);
  focus = 12;
  query.resolve([{ id: focus }]);
  await delay();
  assert.deepEqual(h.sends, [{
    tabId: 12, message: { type: 'selection:confirm' }, options: { frameId: 0 }
  }]);
  assert.equal(h.queries.length, 1);
  await u.finish();
  assert.deepEqual(u.completions(), [{
    type: 'selection:complete',
    region: { ...rU, viewportWidth: 1200, viewportHeight: 800, devicePixelRatio: 1 },
    selectionToken: 'U'
  }]);
  assert.deepEqual(t.completions(), []);
  assert.equal(t.frames.length, 0);
  h.assertQuiet();
});

test('W19 invalid shape takes precedence over forged token and retains Error update', async () => {
  const h = await admissionHarness();
  assert.deepEqual(h.probe({ ...REGION, width: 0 }, 'forged'), {
    returns: [false], responses: [{ ok: false, error: 'Invalid selected region.' }]
  });
  assert.equal(h.context.getState(1).status, 'Error');
  assert.equal(h.context.getState(1).active, false);
  assert.equal(h.context.getState(1).selectionToken, 'expected');
  assert.deepEqual(h.admissions, []);
});

test('W20 stale token rejects with matching worker token retained', async () => {
  const h = await admissionHarness();
  assert.deepEqual(h.probe(REGION, 'forged'), {
    returns: [false], responses: [{
      ok: false, error: 'Selection confirmation is stale or unauthorized.'
    }]
  });
  assert.equal(h.context.getState(1).selectionToken, 'expected');
  assert.deepEqual(h.admissions, []);
});

test('W21 consumed completion token cannot launch capture twice', async () => {
  const h = await admissionHarness();
  assert.deepEqual(h.probe(), { returns: [false], responses: [{ ok: true }] });
  assert.deepEqual(h.probe(), {
    returns: [false], responses: [{
      ok: false, error: 'Selection confirmation is stale or unauthorized.'
    }]
  });
  assert.equal(h.admissions.length, 1);
  assert.deepEqual(h.admissionEvents, ['reply', 'pipeline', 'reply']);
});

test('W22 fresh-worker loss and non-Selecting state reject old authorization', async () => {
  const fresh = await admissionHarness(false);
  assert.equal(fresh.context.getState(1).status, 'Idle');
  assert.equal(fresh.context.getState(1).selectionToken, null);
  const idle = await admissionHarness();
  Object.assign(idle.context.getState(1), { status: 'Idle', active: false });
  for (const h of [fresh, idle]) {
    assert.deepEqual(h.probe(), {
      returns: [false], responses: [{
        ok: false, error: 'Selection confirmation is stale or unauthorized.'
      }]
    });
    assert.deepEqual(h.admissions, []);
    assert.equal(h.localData.lastRegion, undefined);
  }
});

test('W23 completion without sender tab rejects before capture', async () => {
  const h = await admissionHarness();
  assert.deepEqual(h.probe(REGION, 'expected', {}), {
    returns: [false], responses: [{ ok: false, error: 'No sender tab found.' }]
  });
  assert.deepEqual(h.admissions, []);
  assert.equal(h.context.getState(1).selectionToken, 'expected');
  assert.equal(h.localData.lastRegion, undefined);
});
```

- [ ] **Step 2: Observe the deliberately missing oracle failure.** Before recording the fixture, run `node --test --test-reporter=tap --test-name-pattern='^selection confirmation uses double-requestAnimationFrame before sending$' tests/content.test.js`. Expected diagnostic contains `ENOENT` and `selection-complete-baseline.json`; summary `# tests 1`, `# pass 0`, `# fail 1`, `# skipped 0`. This is a tests/fixture task, so its missing implementation is the pinned artifact; do not introduce a production change merely to make these already-supported interleavings pass.

- [ ] **Step 3: Implement F01 by executing the original named test in memory and recording only its completion.** Run this exact command from repository root. It uses read-only `git show`, intercepts only the content read, selects the original callback without editing its inputs/assertions, wraps/delegates its runtime send solely for recording, awaits its assertions, and writes only the allowed fixture:

```bash
node <<'NODE'
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
(async () => {
  const root = process.cwd();
  const commit = 'c47dec6a24b42bcdb25f2c4fbe731deca8ce4431';
  const filename = path.join(root, 'tests', 'content.test.js');
  const contentPath = path.join(root, 'extension', 'content.js');
  const show = (name) => execFileSync('git', ['show', `${commit}:${name}`], {
    cwd: root, encoding: 'utf8'
  });
  const originalTest = show('tests/content.test.js');
  const originalContent = show('extension/content.js');
  const recorded = [];
  const pending = [];
  let selected = 0;
  const selectTest = (name, options, callback) => {
    if (name !== 'selection confirmation uses double-requestAnimationFrame before sending') return;
    const body = typeof options === 'function' ? options : callback;
    selected += 1;
    pending.push(Promise.resolve().then(() => body()));
  };
  const originalRead = fs.readFileSync.bind(fs);
  const pinnedFs = new Proxy(fs, {
    get(target, key) {
      if (key === 'readFileSync') return (file, ...args) => path.resolve(String(file)) === contentPath
        ? originalContent : originalRead(file, ...args);
      return target[key];
    }
  });
  const pinnedVm = {
    ...vm,
    runInContext(source, context, options) {
      const runtime = context.chrome.runtime;
      const originalSend = runtime.sendMessage;
      runtime.sendMessage = function (message, ...args) {
        if (message.type === 'selection:complete') recorded.push(JSON.parse(JSON.stringify(message)));
        return originalSend.call(this, message, ...args);
      };
      return vm.runInContext(source, context, options);
    }
  };
  const localRequire = createRequire(filename);
  const recordingRequire = (name) => name === 'node:test' ? selectTest
    : name === 'node:fs' ? pinnedFs : name === 'node:vm' ? pinnedVm : localRequire(name);
  const originalModule = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', '__filename', originalTest)(
    recordingRequire, originalModule, originalModule.exports, path.dirname(filename), filename
  );
  await Promise.all(pending);
  assert.equal(selected, 1);
  assert.deepEqual(recorded, [{
    type: 'selection:complete',
    region: { x: 100, y: 100, width: 200, height: 150,
      viewportWidth: 1200, viewportHeight: 800, devicePixelRatio: 1 },
    selectionToken: 'confirm-token'
  }]);
  const destination = path.join(root, 'tests', 'fixtures', 'selection-complete-baseline.json');
  const bytes = JSON.stringify(recorded[0], null, 2) + '\n';
  if (fs.existsSync(destination)) {
    assert.equal(originalRead(destination, 'utf8'), bytes);
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
  }
  process.stdout.write('F01: pinned test passed; 1 completion; fixture recorded\n');
})().catch((error) => { console.error(error); process.exitCode = 1; });
NODE
```

Expected exact stdout: `F01: pinned test passed; 1 completion; fixture recorded` followed by LF; exit 0. The resulting bytes are:

```json
{
  "type": "selection:complete",
  "region": {
    "x": 100,
    "y": 100,
    "width": 200,
    "height": 150,
    "viewportWidth": 1200,
    "viewportHeight": 800,
    "devicePixelRatio": 1
  },
  "selectionToken": "confirm-token"
}
```

This fixed-input oracle checks payload equivalence. It does not establish function identity or physical browser key dispatch; V01 and manual cases own those claims.

- [ ] **Step 4: Verify worker/content integration and full Node regressions.** Run `node --test --test-reporter=tap tests/background.test.js tests/content.test.js`. Expected `# tests 151`, `# pass 151`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`: background 107, content 44. Then run the required `node --test tests/background.test.js tests/popup.test.js tests/content.test.js tests/extension_e2e.test.js`. Expected 179 tests/pass, zero failures/cancellations/skips/todos: 107 worker + 44 content + 27 popup + 1 Chromium. A browser skip remains unverified E01/E02 and must be reported. F01 is the separate recorder invocation, not an extra Node test.

- [ ] **Step 5: Commit.**

```bash
git add tests/background.test.js tests/content.test.js tests/fixtures/selection-complete-baseline.json
git commit -m "test(extension): pin OCR confirmation equivalence and delivery races"
```

## Task 8: Document native shortcut setup and complete acceptance evidence

**Implementer tier:** Standard

**Files:**

- Modify: `README.md:16-20` — typical launch/confirmation flow and platform defaults.
- Modify: `README.md:272-277` — plural native command architecture wording.
- Modify: `README.md:289-300` — capture controls and new setup subsection before auto-scroll.
- Test: `tests/background.test.js`.
- Test: `tests/popup.test.js`.
- Test: `tests/content.test.js`.
- Test: `tests/extension_e2e.test.js`.
- Review only: `extension/background.js:323-453`, `extension/background.js:458-2337`, `extension/content.js:179-318`, `extension/overlay.css:40-52`, and frozen spec/design.

**Interfaces:**

- Consumes Tasks 1–7: two exact native command rows/defaults, wire replies, saved-region behavior, four hint states/snapshot policy, and retained capture/scroll semantics. No product interface is introduced by this documentation task.
- Consumes verification obligations: F01 recorder (1), W01–W23 (23), C01–C37 (37), E01/E02 (2), and physical M01–M04 (4): 67 specification cases, of which 63 are automated obligations. V01–V03 are separate source checks. Node's final expected 179 tests includes baseline regressions and may cover several obligations per test; never relabel those 179 as 179 specification cases.
- Produces: README instructions for independent command editing, both platform defaults, reopening, unassigned versus unavailable, no popup confirmation fallback, old-key removal with the scroll-lock qualification, and zero-pointer saved-region confirmation. Record validation/manual outcomes in the existing controller-assigned report outside the delivery worktree, without editing this pinned plan or creating a repository ledger.

- [ ] **Step 1: Run the inline documentation acceptance check and observe its failure.** This creates no test/script artifact:

```bash
node <<'NODE'
const assert = require('node:assert/strict');
const readme = require('node:fs').readFileSync('README.md', 'utf8');
const has = (text) => readme.includes(text);
assert.ok(has('keyboard commands for selection start and confirmation'),
  'README must describe independent keyboard commands');
assert.ok(['`Ctrl+Shift+S`', '`Command+Shift+S`', '`Ctrl+Shift+Space`',
  '`Command+Shift+Space`'].every(has), 'README must include both platform defaults');
assert.ok(has('### Configure keyboard shortcuts') && has('chrome://extensions/shortcuts') &&
  has('Locate TextKit') && has('Choose a Chrome-supported binding'), 'README must explain native setup');
assert.ok(has('Confirm selected OCR region') && has('Select a region and start OCR capture') &&
  has('independently'), 'README must name both independent rows');
assert.ok(has('reopen selection to refresh the hint') &&
  has('does not automatically refresh while that overlay remains open'), 'README must explain binding snapshots');
assert.ok(has('not set') && has('unavailable') && has('lookup failed'),
  'README must distinguish cleared and unreadable bindings');
assert.ok(has('There is no popup confirmation fallback.') &&
  has('confirm it without drawing or adjusting it first'), 'README must explain fallback and saved-region behavior');
assert.ok(has('Ctrl+Space no longer confirms an OCR region') &&
  has('Space interception for scroll lock during active capture is unchanged') &&
  !has('press `Ctrl+Space`') && !has('Press `Ctrl+Space` to confirm'), 'README must remove old-key instructions precisely');
console.log('README acceptance: 8 checks passed');
NODE
```

Expected failure diagnostic: `README must describe independent keyboard commands`; exit 1. This checks the documentation contract inline rather than introducing a permanent README test file.

- [ ] **Step 2: Make the exact README replacements.** In typical flow, replace items 3 and 4 with:

```markdown
3. Press `Ctrl+Shift+S` (`Command+Shift+S` on macOS) or click `Select Region` in the popup.
4. Draw or adjust the capture region, or use its restored saved rectangle, then press the configured confirmation shortcut: `Ctrl+Shift+Space` by default, or `Command+Shift+Space` on macOS.
```

Replace the singular `manifest.json` architecture bullet with:

```markdown
- `manifest.json`: extension metadata, permissions, host access, and independent native keyboard commands for selection start and confirmation. The page content script and overlay CSS are injected on demand with `chrome.scripting`.
```

Replace the entire `### Capture controls` section, stopping immediately before `### Auto-scroll and page capture`, with:

```markdown
### Capture controls

- Press `Ctrl+Shift+S` to open the region selection overlay. On macOS, the suggested default is `Command+Shift+S`.
- Click `Select Region` in the popup to start the same selection flow.
- Drag on the page to draw the region.
- If a region was previously saved, it is pre-drawn when selection starts; you can confirm it without drawing or adjusting it first.
- The saved region has 8 resize handles: corners, edges, and side midpoints.
- Drag inside the saved region to reposition it.
- Press the configured **Confirm selected OCR region** shortcut to confirm: the suggested default is `Ctrl+Shift+Space`, or `Command+Shift+Space` on macOS. The overlay shows the binding Chrome reports.
- Press `Esc` to cancel selection before confirmation is pending.

Ctrl+Space no longer confirms an OCR region. Space interception for scroll lock during active capture is unchanged.

### Configure keyboard shortcuts

1. Open `chrome://extensions/shortcuts`.
2. Locate TextKit.
3. Edit **Confirm selected OCR region** independently of **Select a region and start OCR capture**.
4. Choose a Chrome-supported binding, such as `Alt+Shift+O`, and reopen selection to refresh the hint.

Chrome owns shortcut editing, persistence, conflicts, clearing, and scope. Selection start and confirmation have separate rows. The overlay reads the confirmation binding once when it opens and does not automatically refresh while that overlay remains open; a Chrome reassignment can take effect immediately, so reopen selection to refresh the hint.

A **not set** hint means the confirmation shortcut was cleared; assign it on the shortcuts page, then reopen selection. An **unavailable** hint means the binding lookup failed, so the shortcut may still be assigned and able to dispatch. There is no popup confirmation fallback.

Confirmation acts on the overlay present in the resolved tab when the message arrives. A delayed command can confirm a selection opened or adjusted after the keypress, including a newly started selection in a replacement document. Delivery into a document without an overlay creates no selection. The service-worker hop has no guaranteed wall-clock deadline.

```

- [ ] **Step 3: Verify documentation, semantic rewrites, and source checks V01–V03.** Rerun Step 1's exact inline command. Expected exact stdout `README acceptance: 8 checks passed`, exit 0. Then run this read-only protection check:

```bash
node <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const base = 'c47dec6a24b42bcdb25f2c4fbe731deca8ce4431';
const pinned = (name) => execFileSync('git', ['show', `${base}:${name}`], { encoding: 'utf8' });
const read = (name) => fs.readFileSync(name, 'utf8');
const between = (text, start, end) => {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `missing anchors ${start} / ${end}`);
  return text.slice(first, last);
};
const oldContent = pinned('extension/content.js');
const content = read('extension/content.js');
const oldDiagnostic = 'if (hint) hint.textContent = `${error.message} Adjust the region and try again.`;';
const newDiagnostic = 'showHintDiagnostic(`${error.message} Adjust the region and try again.`);';
assert.equal(between(content, '  function confirmSelection() {', '  function onKeyDown(event) {')
  .replace(newDiagnostic, oldDiagnostic),
  between(oldContent, '  function confirmSelection() {', '  function onKeyDown(event) {'));
assert.ok(content.includes("if (message?.type === 'selection:confirm') {\n      confirmSelection();\n      sendResponse({ ok: true });\n      return false;\n    }"));
const oldKeyBranch = "    if (event.key === ' ' && event.ctrlKey) {\n      event.preventDefault();\n      confirmSelection();\n    }\n";
assert.equal(between(content, '  function onKeyDown(event) {', '  function drawRegion() {'),
  between(oldContent, '  function onKeyDown(event) {', '  function drawRegion() {').replace(oldKeyBranch, ''));
assert.equal(between(content, '  function onPointerDown(event) {', '  function confirmSelection() {')
  .replaceAll('    const before = { ...region };\n', '')
  .replaceAll('    clearHintDiagnosticAfterChange(before);\n', ''),
  between(oldContent, '  function onPointerDown(event) {', '  function confirmSelection() {'));
console.log('V01: confirmation mechanism, both key guards, Escape, and pointer geometry preserved');
const oldWorker = pinned('extension/background.js');
const worker = read('extension/background.js');
const commandAnchor = 'chrome.commands.onCommand.addListener';
assert.equal(worker.slice(0, worker.indexOf(commandAnchor)), oldWorker.slice(0, oldWorker.indexOf(commandAnchor)));
const tailAnchor = 'async function handlePopupStart(';
assert.ok(worker.includes(tailAnchor) && oldWorker.includes(tailAnchor));
assert.equal(worker.slice(worker.indexOf(tailAnchor)), oldWorker.slice(oldWorker.indexOf(tailAnchor)));
const runtimeAnchor = 'chrome.runtime.onMessage.addListener';
const oldRuntime = between(oldWorker, runtimeAnchor, tailAnchor);
const runtime = between(worker, runtimeAnchor, tailAnchor);
const bindingStart = runtime.indexOf("  if (message?.type === 'commands:binding') {");
const bindingEnd = runtime.indexOf('\n  return false;', bindingStart);
assert.ok(bindingStart >= 0 && bindingEnd > bindingStart);
assert.equal(runtime.slice(0, bindingStart) + runtime.slice(bindingEnd + 1), oldRuntime);
const confirmBranch = worker.slice(worker.indexOf("  if (command !== 'confirm-region-capture') return;"), worker.indexOf(runtimeAnchor));
assert.doesNotMatch(confirmBranch, /startupReadiness|setTimeout|persistOperation|retryState|checkpoint/);
console.log('V02: existing worker admissions, Stop, recovery, persistence, and capture code byte-identical');
for (const [name, expected] of [
  ['docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-spec.md', 'e7065697a94eef00ba87007ef90dfeac2e7fa5b008d00b21391113466193b8a5'],
  ['docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md', '50e4b4ae20f6afb8ecbc883f9c85a30900a417db2954ff3994d714d57940a9a5']
]) {
  assert.equal(createHash('sha256').update(fs.readFileSync(name)).digest('hex'), expected);
}
const allow = new Set([
  'extension/manifest.json', 'extension/background.js', 'extension/content.js', 'extension/overlay.css',
  'tests/background.test.js', 'tests/content.test.js', 'tests/extension_e2e.test.js',
  'tests/fixtures/selection-complete-baseline.json', 'README.md',
  'docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-spec.md',
  'docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md',
  'docs/superpowers/plans/2026-10-17-ocr-confirm-shortcut.md'
]);
const changed = execFileSync('git', ['diff', '--name-only', base], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
assert.deepEqual(changed.filter((name) => !allow.has(name)), []);
console.log('V03 automated portion: frozen input hashes and tracked artifact inventory verified');
NODE
```

Expected exactly the three `V01: …`, `V02: …`, and `V03 automated portion: …` stdout lines above; exit 0. This is deliberately stricter than individual function comparison: the complete worker tail, including `handleStop`, all screenshot/capture helpers, `runCaptureLoop`, `recoverPersistedOperations`, and terminal/retry code, must be byte-identical. The new runtime branch is removed in memory before comparing all existing runtime handling. Run `git status --short` and include untracked files in V03's manual inventory review; the automated `git diff` checks tracked files only.

Run `rg -n -e 'Ctrl\+Space' -e 'ctrlKey' extension/content.js tests/content.test.js README.md`. Expected exit 0 with only deliberate negative coverage/README removal wording; inspect semantics instead of enforcing a raw hit count. Verify the six old semantic references were rewritten, including both replaced tests and both initial hint verbs. For V03 also read the hint handlers/painter to confirm both owner/diagnostic check points; read both style owners and eight exact strings. Passing fixture equality alone cannot establish these source properties.

- [ ] **Step 4: Run full regressions in the known locked environment.** Run the required Node command from the repository root:

```bash
node --test tests/background.test.js tests/popup.test.js tests/content.test.js tests/extension_e2e.test.js
```

Expected 179 tests passed, 0 failures, 0 cancellations, 0 skips, 0 todos, as counted in Task 7. Run the required Python command with the run-local locked environment's `python` first on PATH; no dependency install or checkout change is needed:

```bash
OCR_SHORTCUT_TEST_VENV=/data/home/henry-arch/.local/state/pi/project-manager/runs/a99c4e8f3a53db949536faaf82ae7e05434575914b9d7384123b18c280633079/pm-run-20261017-115722-e169d2eb/venv
PATH="$OCR_SHORTCUT_TEST_VENV/bin:$PATH" python -m pytest tests/ -v
```

Expected pytest summary contains `120 passed` with no failures/errors/skips; elapsed time varies. Run `git diff --check`; expected no output and exit 0. Report actual counts and any unavailable checks; these are expected totals for the frozen eight-task decomposition, not authority to delete extra regressions or weaken Chromium assertions.

- [ ] **Step 5: Complete headed M01–M04 and record each separately from automated results.** Launch headed Chromium with the unpacked `extension/` directory, a permitted normal page, and working backend. Record browser version, OS, initial shortcut rows and actual observations in the controller-assigned implementation report. The existing automated fresh-profile E2E test covers load/registration and restart, so it cannot replace these physical checks:

| ID | Exact procedure | Expected observable result |
| --- | --- | --- |
| M01 | Record both rows at `chrome://extensions/shortcuts`. Physically press default launch (`Ctrl+Shift+S`, macOS `Command+Shift+S`), draw/adjust, then physically press default confirm (`Ctrl+Shift+Space`, macOS `Command+Shift+Space`). Reopen a saved region and confirm before drawing/adjusting. | Both defaults dispatch; capture begins after the overlay disappears. The restored rectangle also confirms with zero pointer input. |
| M02 | Edit only **Confirm selected OCR region** to supported `Alt+Shift+O`. Press it physically for a valid selection; reopen fresh/saved selection forms to inspect the new label. | Chrome dispatches the reassigned command immediately; the next overlay displays Chrome's reported label, while launch retains its independent row. |
| M03 | Clear confirmation; reopen a valid overlay. Observe not-set guidance, press Ctrl+Space physically, then reassign and confirm. Open another idle overlay and press Escape. | Cleared shortcut is explicitly not set; Ctrl+Space does not confirm. Reassignment restores confirmation; idle Escape still cancels. Make no claim that Space is inert during active scroll-locked capture. |
| M04 | Narrow the headed window to approximately 360 CSS px. Inspect fresh/saved hints and not-set URL guidance, then restore an assigned binding. | Text/URLs/labels wrap readably without offscreen overflow in both overlay forms. |

If no headed physical-input session is available, record exactly which M cases remain unverified and report the acceptance limitation; do not synthesize CDP keys or a trusted-event double and label it physical evidence. Do not modify scope to solve environment constraints.

- [ ] **Step 6: Commit the documentation and hand verification evidence to the existing PM audit gate.**

```bash
git add README.md
git commit -m "docs: explain native OCR confirmation shortcut setup"
```

The implementation report must enumerate all F/W/C/E/M outcomes and V01–V03, provide the final full-suite commands/counts, commit IDs, and unresolved observational/environment limitations. The independent implementation audit already required by PM remains the final gate; do not create a new audit artifact in the repository, merge, publish, or change the approved spec/design.

### Implementation risks to report without redesign

- **R1 — delivery time:** same-document A→B, supplied-tab/fallback focus switching, replacement top documents with newly started overlays, no overlay at press but one at delivery, and adjusted region/viewport before delivery can change what confirms. C28–C34/W17/W18 demonstrate the specified outcomes. An overlay created by selection start plus worker `Selecting`/matching token still gates capture admission. A saved rectangle can already be valid with zero pointer input. Neither a one-hop description nor `frameId: 0` establishes invocation-time identity or a wall-clock bound.
- **R2 — hint snapshot:** Chrome may apply a changed binding immediately, but an open overlay retains its lookup snapshot until reopened. A never-settled binding promise remains checking; no timeout/polling is authorized. Tests cover deferred, rejected, throwing, missing, malformed, and out-of-order paths, including cached state beneath diagnostics.
- **R3 — worker restart:** in-memory `Selecting`/token loss can reject a surviving overlay's completion. W22 must preserve that inherited limitation; no persistence/recovery extension is allowed. A local content attempt is not proof of worker admission.
- **R4 — scroll lock:** Space interception during capture remains unchanged even after OCR's Ctrl+Space branch disappears. Documentation must make the narrower confirmation claim.
- **Registration and input environment:** effective Chrome strings depend on platform and en-US accelerator formatting; an empty/different effective shortcut is a real E01 failure. OS conflicts, unsupported browser setups, missing Chromium, or lack of a headed physical session must be recorded as validation limits instead of substituting manifest suggestions, changing the approved defaults, or claiming unrun manual outcomes.
- **Historical fixture limit:** F01 must run the original callback and content source from the pinned Git objects. Payload equality proves fixed-input output equivalence; V01 proves reuse of the original mechanism, and manual checks prove actual keyboard dispatch. Exact test totals in this plan are separately verified expectations; report a legitimate additional test rather than forcing counts by deleting coverage.

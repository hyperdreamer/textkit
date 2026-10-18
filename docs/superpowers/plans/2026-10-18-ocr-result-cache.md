# TextKit OCR Result Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the TextKit extension reuse a completed OCR capture for a page it already captured, keyed only by the normalized page URL, with a popup Force refresh checkbox that bypasses the lookup.

**Architecture:** A new classic service-worker helper, `extension/ocr-cache.js`, is a deep module that owns URL normalization, SHA-256 key derivation, the `ocrCache:*` record and index layout in `chrome.storage.local`, the 2 MB / 50-entry LRU budget, and the failure policy that turns every storage problem into an ordinary miss. `extension/background.js` loads it with `importScripts`, routes capture publication through one extracted seam, and consults the cache only for complete (`Done`) captures. `extension/popup.js` sends `force: true` from one new checkbox. The backend is untouched.

**Tech Stack:** Vanilla ES2020 service-worker JavaScript with `crypto.subtle.digest` and the `URL` API, `chrome.storage.local`, the Node `node:test` + `node:vm` harnesses already in `tests/`, and Python `pytest` for extension asset assertions.

## Global Constraints

- The approved specification is `docs/superpowers/specs/2026-10-18-ocr-result-cache-design.md` with SHA-256 `ceecab0b3907e37f8947299d87c21c2c2109450068600b4e5941c7b8e9d4cf02`; implementation must preserve it and the approved design.
- No backend change: do not modify `backend/main.py`, `backend/transformation_cache.py`, `backend/config.yaml`, or `backend/config.example.yaml`, and do not add an OCR cache route or a `force` field to `POST /ocr`.
- Only complete captures are cached. A capture published with status `Partial` or `Cancelled` is never stored and never satisfies a lookup.
- Cache identity is the normalized page URL alone. Region, autoscroll, prompt snapshot, backend host/port, tab ID, window ID, and timestamps are never part of the key.
- Cacheable protocols are `http:` and `https:` only. `chrome:`, `file:`, `about:`, `view-source:`, `data:`, extension pages, and unparseable strings perform neither lookup nor store.
- Budget values are exactly `OCR_CACHE_MAX_BYTES = 2_000_000` and `OCR_CACHE_MAX_ENTRIES = 50`, with LRU eviction by `lastUsedAt`. There is no TTL and no `unlimitedStorage` permission.
- Cache failures never change capture behavior: every cache error degrades to an ordinary miss or a silent store skip, and no cache error may propagate into `runCaptureLifecycle`, `publishCaptureResult`, or a popup message handler.
- Force refresh is never persisted to `chrome.storage.sync`; it is read once per start and reset to unchecked after a successful start.
- `extension/ocr-cache.js` is the only file that reads or writes `ocrCache:*` keys. No other file may construct an `ocrCache:` key or parse the index.
- Node tests run from the repository root as `node tests/background.test.js`, `node tests/popup.test.js`, and `node tests/content.test.js`; Python tests run as `python -m pytest -q tests/`. No test may contact a live backend or a paid provider.
- Do not commit `backend/transformation_cache.db`, its `-wal`/`-shm` sidecars, or any other local runtime data.

## File Structure

- Create `extension/ocr-cache.js` — URL normalization, key derivation, record and index storage, budget enforcement, failure policy. Loaded by `background.js` through `importScripts` and by the Node harnesses through `vm.runInContext`.
- Modify `extension/background.js` — the `importScripts` line, the `publishCaptureResult` seam, the cache-aware capture start, and `cacheHit` public state.
- Modify `extension/popup.html` — one checkbox in the OCR `.option-row`.
- Modify `extension/popup.js` — send `force`, reset it after a start, disable it while active, render `Cached` status.
- Modify `extension/manifest.json` — version `2.2.0`.
- Modify `tests/background.test.js` — cache behavior tests plus the VM globals the module needs.
- Create `tests/ocr-cache.test.js` — module unit tests.
- Modify `tests/popup.test.js` — force-checkbox and status-rendering tests.
- Modify `tests/test_extension_assets.py` — markup assertions for the new control.
- Modify `README.md` and `CLAUDE.md` — documentation.

## Task 1: Build the OCR cache storage module

**Implementer tier:** Capable

**Files:**

- Create: `extension/ocr-cache.js`
- Create: `tests/ocr-cache.test.js`
- Modify: `tests/background.test.js:200-246` (add `crypto` and `URL` to the VM context)

**Interfaces:**

- Consumes: `crypto.subtle.digest` and `TextEncoder` from the worker global scope, the `URL` constructor, and `chrome.storage.local` with promise-returning `get(keys)`, `set(values)`, and `remove(keys)`. No access to `background.js`, the DOM, or `chrome.tabs`.
- Produces: exactly one global binding `OcrCache`, frozen, whose members are and only are: `MAX_BYTES` (`2_000_000`), `MAX_ENTRIES` (`50`), `ENTRY_PREFIX` (`'ocrCache:'`), `INDEX_KEY` (`'ocrCacheIndex'`), `SCHEMA_VERSION` (`1`), `cacheKeyFor(url)`, `lookup(url)`, `store(url, text)`, `clear()`.
- Produces: `OcrCache.cacheKeyFor(url: string) => Promise<string | null>` resolving to the 64-character lowercase hex SHA-256 of the normalized URL, or `null` when the URL is uncacheable. Never rejects.
- Produces: `OcrCache.lookup(url: string) => Promise<{ text: string, savedAt: number } | null>`. Returns `null` on a miss, an uncacheable URL, a malformed record, or any storage failure. Bumps recency and re-indexes on a hit. Never rejects.
- Produces: `OcrCache.store(url: string, text: string) => Promise<boolean>`. Resolves `true` only when a record was committed; `false` for an uncacheable URL, empty text, an oversized entry, or any storage failure. Never rejects.
- Produces: `OcrCache.clear() => Promise<void>`, removing every `ocrCache:*` record and the index. Never rejects.

- [ ] **Step 1: Write the failing module tests**

Create `tests/ocr-cache.test.js`. The module declares `const OcrCache`, which is reachable through `vm.runInContext('OcrCache', context)` but is not a property of the sandbox object.

```js
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'extension', 'ocr-cache.js');

function createStorage(localData, overrides = {}) {
  return {
    async get(keys) {
      if (overrides.get) return overrides.get(keys, localData);
      if (typeof keys === 'string') return { [keys]: localData[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, localData[key]]));
      if (keys && typeof keys === 'object') {
        return {
          ...keys,
          ...Object.fromEntries(
            Object.keys(keys)
              .filter((key) => Object.hasOwn(localData, key))
              .map((key) => [key, localData[key]])
          )
        };
      }
      return { ...localData };
    },
    async set(values) {
      if (overrides.set) return overrides.set(values, localData);
      Object.assign(localData, values);
    },
    async remove(keys) {
      if (overrides.remove) return overrides.remove(keys, localData);
      for (const key of Array.isArray(keys) ? keys : [keys]) delete localData[key];
    }
  };
}

function createCacheHarness(options = {}) {
  const localData = { ...(options.localData || {}) };
  const context = {
    chrome: { storage: { local: createStorage(localData, options.storage) } },
    console,
    crypto: require('node:crypto').webcrypto,
    TextEncoder,
    URL
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(MODULE_PATH, 'utf8'), context, { filename: MODULE_PATH });
  return { context, localData, OcrCache: vm.runInContext('OcrCache', context) };
}

async function storageKeyFor(OcrCache, url) {
  return `ocrCache:${await OcrCache.cacheKeyFor(url)}`;
}

test('normalization drops the fragment, folds scheme and host case, and drops default ports', async () => {
  const { OcrCache } = createCacheHarness();
  const base = await OcrCache.cacheKeyFor('https://example.test/article?id=7');
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(await OcrCache.cacheKeyFor('HTTPS://Example.TEST/article?id=7#section-2'), base);
  assert.equal(await OcrCache.cacheKeyFor('https://example.test:443/article?id=7'), base);
  assert.equal(await OcrCache.cacheKeyFor('  https://example.test/article?id=7  '), base);
  assert.equal(
    await OcrCache.cacheKeyFor('http://example.test:80/x'),
    await OcrCache.cacheKeyFor('http://example.test/x')
  );
});

test('normalization keeps query, path case, trailing slash, and scheme distinct', async () => {
  const { OcrCache } = createCacheHarness();
  const base = await OcrCache.cacheKeyFor('https://example.test/article?id=7');
  assert.notEqual(await OcrCache.cacheKeyFor('https://example.test/article?id=8'), base);
  assert.notEqual(await OcrCache.cacheKeyFor('https://example.test/article/'), base);
  assert.notEqual(await OcrCache.cacheKeyFor('https://example.test/Article'), base);
  assert.notEqual(await OcrCache.cacheKeyFor('http://example.test/article?id=7'), base);
});

test('normalization rejects non-http protocols and unparseable input', async () => {
  const { OcrCache } = createCacheHarness();
  for (const url of [
    'chrome://extensions',
    'file:///tmp/page.html',
    'about:blank',
    'view-source:https://example.test/',
    'data:text/html,hi',
    'not a url',
    '',
    null,
    undefined
  ]) {
    assert.equal(await OcrCache.cacheKeyFor(url), null, `expected ${String(url)} to be uncacheable`);
  }
});

test('cacheKeyFor resolves the pinned digest for a fixed url', async () => {
  const { OcrCache } = createCacheHarness();
  const expected = createHash('sha256').update('https://example.com/a?b=1', 'utf8').digest('hex');
  assert.equal(await OcrCache.cacheKeyFor('https://example.com/a?b=1#frag'), expected);
});

test('uncacheable urls neither read nor write storage', async () => {
  const { OcrCache, localData } = createCacheHarness();
  assert.equal(await OcrCache.lookup('chrome://extensions'), null);
  assert.equal(await OcrCache.store('chrome://extensions', 'text'), false);
  assert.deepEqual(Object.keys(localData), []);
});

test('store then lookup round-trips the text and the index', async () => {
  const { OcrCache, localData } = createCacheHarness();
  assert.equal(await OcrCache.store('https://example.test/a', 'page text'), true);

  const storageKey = await storageKeyFor(OcrCache, 'https://example.test/a');
  assert.equal(localData[storageKey].text, 'page text');
  assert.equal(localData[storageKey].v, 1);
  assert.equal(localData[storageKey].bytes, 9);
  assert.equal(localData[OcrCache.INDEX_KEY].length, 1);
  assert.equal(localData[OcrCache.INDEX_KEY][0].key, storageKey);

  const hit = await OcrCache.lookup('https://example.test/a');
  assert.equal(hit.text, 'page text');
  assert.equal(typeof hit.savedAt, 'number');
});

test('a hit bumps lastUsedAt and moves the entry to the newest index slot', async () => {
  const { OcrCache, localData } = createCacheHarness();
  await OcrCache.store('https://example.test/old', 'old text');
  await OcrCache.store('https://example.test/new', 'new text');
  const oldKey = await storageKeyFor(OcrCache, 'https://example.test/old');
  const newKey = await storageKeyFor(OcrCache, 'https://example.test/new');
  localData[oldKey].lastUsedAt = 1;
  localData[newKey].lastUsedAt = 2;

  await OcrCache.lookup('https://example.test/old');

  assert.ok(localData[oldKey].lastUsedAt > 2);
  const index = localData[OcrCache.INDEX_KEY];
  assert.equal(index[index.length - 1].key, oldKey);
});

test('the entry cap evicts the oldest lastUsedAt first', async () => {
  const { OcrCache, localData } = createCacheHarness();
  for (let position = 0; position < OcrCache.MAX_ENTRIES; position += 1) {
    await OcrCache.store(`https://example.test/page-${position}`, `text ${position}`);
    const storageKey = await storageKeyFor(OcrCache, `https://example.test/page-${position}`);
    localData[storageKey].lastUsedAt = 1_000 + position;
  }
  assert.equal(localData[OcrCache.INDEX_KEY].length, OcrCache.MAX_ENTRIES);
  const oldestKey = await storageKeyFor(OcrCache, 'https://example.test/page-0');

  assert.equal(await OcrCache.store('https://example.test/page-new', 'fresh text'), true);

  assert.equal(localData[OcrCache.INDEX_KEY].length, OcrCache.MAX_ENTRIES);
  assert.equal(Object.hasOwn(localData, oldestKey), false);
  assert.equal(await OcrCache.lookup('https://example.test/page-0'), null);
  assert.equal((await OcrCache.lookup('https://example.test/page-new')).text, 'fresh text');
});

test('the byte budget evicts until the new entry fits', async () => {
  const { OcrCache, localData } = createCacheHarness();
  const chunk = Math.floor(OcrCache.MAX_BYTES / 2);
  assert.equal(await OcrCache.store('https://example.test/one', 'a'.repeat(chunk)), true);
  assert.equal(await OcrCache.store('https://example.test/two', 'b'.repeat(chunk)), true);
  localData[await storageKeyFor(OcrCache, 'https://example.test/one')].lastUsedAt = 1;
  localData[await storageKeyFor(OcrCache, 'https://example.test/two')].lastUsedAt = 2;
  assert.equal(localData[OcrCache.INDEX_KEY].length, 2);

  const bigger = chunk + 10;
  assert.equal(await OcrCache.store('https://example.test/three', 'c'.repeat(bigger)), true);

  assert.equal(localData[OcrCache.INDEX_KEY].length, 1);
  assert.equal(await OcrCache.lookup('https://example.test/one'), null);
  assert.equal(await OcrCache.lookup('https://example.test/two'), null);
  assert.equal((await OcrCache.lookup('https://example.test/three')).text.length, bigger);
});

test('a single entry larger than the budget is skipped without touching the cache', async () => {
  const { OcrCache, localData } = createCacheHarness();
  assert.equal(await OcrCache.store('https://example.test/huge', 'x'.repeat(OcrCache.MAX_BYTES + 1)), false);
  assert.deepEqual(Object.keys(localData), []);
});

test('a clock-skewed cache never evicts the entry being written', async () => {
  const { OcrCache, localData } = createCacheHarness();
  // Every existing entry looks newer than the one about to be written, which is
  // what a backwards clock adjustment produces. The new entry must still land.
  const future = Date.now() + 1_000_000;
  for (let position = 0; position < OcrCache.MAX_ENTRIES; position += 1) {
    const url = `https://example.test/skew-${position}`;
    await OcrCache.store(url, `text ${position}`);
    const storageKey = await storageKeyFor(OcrCache, url);
    localData[storageKey].lastUsedAt = future + position;
    localData[OcrCache.INDEX_KEY].find((row) => row.key === storageKey).lastUsedAt = future + position;
  }

  assert.equal(await OcrCache.store('https://example.test/fresh', 'fresh text'), true);
  assert.equal((await OcrCache.lookup('https://example.test/fresh')).text, 'fresh text');
});

test('the byte budget counts UTF-8 bytes, not characters', async () => {
  const { OcrCache } = createCacheHarness();
  const cjk = '\u6c49'.repeat(Math.floor(OcrCache.MAX_BYTES / 3) + 1);
  assert.equal(await OcrCache.store('https://example.test/cjk', cjk), false);
});

test('a malformed record is a miss and is pruned', async () => {
  const { OcrCache, localData } = createCacheHarness();
  await OcrCache.store('https://example.test/a', 'page text');
  const storageKey = await storageKeyFor(OcrCache, 'https://example.test/a');
  for (const broken of [{ v: 2, text: 'x' }, { v: 1 }, { v: 1, text: 42 }, 'garbage', null]) {
    localData[storageKey] = broken;
    assert.equal(await OcrCache.lookup('https://example.test/a'), null, JSON.stringify(broken));
    assert.equal(Object.hasOwn(localData, storageKey), false);
  }
});

test('a malformed index row does not abort lookup or pruning', async () => {
  const { OcrCache, localData } = createCacheHarness();
  await OcrCache.store('https://example.test/a', 'page text');
  localData[OcrCache.INDEX_KEY] = [null, 5, { key: 'ocrCache:missing' }, ...localData[OcrCache.INDEX_KEY]];

  assert.equal((await OcrCache.lookup('https://example.test/a')).text, 'page text');
  assert.equal(localData[OcrCache.INDEX_KEY].every((row) => row && typeof row.key === 'string'), true);
});

test('a record without an index row is re-indexed by a lookup', async () => {
  const { OcrCache, localData } = createCacheHarness();
  await OcrCache.store('https://example.test/a', 'page text');
  const storageKey = await storageKeyFor(OcrCache, 'https://example.test/a');
  localData[OcrCache.INDEX_KEY] = [];

  assert.equal((await OcrCache.lookup('https://example.test/a')).text, 'page text');
  assert.equal(localData[OcrCache.INDEX_KEY].some((row) => row.key === storageKey), true);
});

test('empty or non-string text is never stored', async () => {
  const { OcrCache, localData } = createCacheHarness();
  assert.equal(await OcrCache.store('https://example.test/a', ''), false);
  assert.equal(await OcrCache.store('https://example.test/a', null), false);
  assert.deepEqual(Object.keys(localData), []);
});

test('a read failure degrades to a miss', async () => {
  const { OcrCache } = createCacheHarness({
    storage: { get: async () => { throw new Error('storage unavailable'); } }
  });
  assert.equal(await OcrCache.lookup('https://example.test/a'), null);
});

test('a write failure degrades to a skipped store', async () => {
  const { OcrCache } = createCacheHarness({
    storage: { set: async () => { throw new Error('QUOTA_BYTES quota exceeded'); } }
  });
  assert.equal(await OcrCache.store('https://example.test/a', 'page text'), false);
});

test('clear removes every record and the index but nothing else', async () => {
  const { OcrCache, localData } = createCacheHarness();
  await OcrCache.store('https://example.test/a', 'one');
  await OcrCache.store('https://example.test/b', 'two');
  localData['lastResult:1'] = 'keep me';

  await OcrCache.clear();

  assert.equal(Object.keys(localData).some((key) => key.startsWith('ocrCache')), false);
  assert.equal(localData['lastResult:1'], 'keep me');
});

test('the public surface is exactly the documented members', () => {
  const { OcrCache } = createCacheHarness();
  assert.deepEqual(
    Object.keys(OcrCache).sort(),
    ['ENTRY_PREFIX', 'INDEX_KEY', 'MAX_BYTES', 'MAX_ENTRIES', 'SCHEMA_VERSION', 'cacheKeyFor', 'clear', 'lookup', 'store']
  );
  assert.equal(Object.isFrozen(OcrCache), true);
});
```

- [ ] **Step 2: Run the module tests and confirm the red state**

Run from the TextKit repository root:

```sh
node tests/ocr-cache.test.js
```

Expected: FAIL at module load with `ENOENT` for `extension/ocr-cache.js`, before any assertion runs.

- [ ] **Step 3: Add the VM globals the background harness needs**

In `tests/background.test.js`, the object passed to `vm.createContext` must expose `crypto` and `URL` so `importScripts('ocr-cache.js')` can digest and parse. In the `context` literal, immediately before `OffscreenCanvas: class {`, insert two properties:

```js
    crypto: require('node:crypto').webcrypto,
    URL,
```

Also confirm `URL` is not already destructured onto that object; if it is, keep the existing entry rather than adding a duplicate key.

- [ ] **Step 4: Run the existing suites and confirm they still pass**

```sh
node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js
```

Expected: PASS with the same test counts as before this task, proving the VM change is inert.

- [ ] **Step 5: Implement the module**

Create `extension/ocr-cache.js` as a classic service-worker script with no `module.exports`, no `import`, no top-level `await`, and no `console` calls on failure paths. It must declare exactly one `const OcrCache` binding, because it is loaded both by `importScripts` and by `vm.runInContext`.

```js
// OCR result cache — whole-page capture results keyed by normalized URL.
//
// This module owns every ocrCache:* key in chrome.storage.local. Callers get
// URL normalization, a recency-aware lookup, and a bounded store; they never
// see the record layout, the index, the eviction policy, or a storage
// exception. Every failure degrades to an ordinary miss or a skipped store,
// because caching must never change whether a capture succeeds.
//
// Records hold the capture text that is already persisted in lastResult:<tabId>
// plus bookkeeping. No prompts, credentials, backend settings, or tab IDs.

const OcrCache = (() => {
  const MAX_BYTES = 2_000_000;
  const MAX_ENTRIES = 50;
  const ENTRY_PREFIX = 'ocrCache:';
  const INDEX_KEY = 'ocrCacheIndex';
  const SCHEMA_VERSION = 1;
  const KEY_RE = /^[0-9a-f]{64}$/;
  const CACHEABLE_PROTOCOLS = new Set(['http:', 'https:']);

  function normalizeUrl(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!CACHEABLE_PROTOCOLS.has(parsed.protocol)) return null;
    if (!parsed.hostname) return null;
    // The fragment never identifies different content; everything else does.
    parsed.hash = '';
    return parsed.href;
  }

  async function cacheKeyFor(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      return KEY_RE.test(hex) ? hex : null;
    } catch {
      return null;
    }
  }

  function isRecord(value) {
    return Boolean(value)
      && typeof value === 'object'
      && value.v === SCHEMA_VERSION
      && typeof value.text === 'string'
      && value.text.length > 0
      && Number.isFinite(value.bytes)
      && Number.isFinite(value.savedAt)
      && Number.isFinite(value.lastUsedAt);
  }

  function byRecency(left, right) {
    return left.lastUsedAt - right.lastUsedAt || left.key.localeCompare(right.key);
  }

  // The index is a hint, never authority: rows it names are re-validated
  // against their record, and unusable rows are dropped instead of aborting.
  async function readIndex() {
    const stored = await chrome.storage.local.get(INDEX_KEY);
    const raw = stored ? stored[INDEX_KEY] : undefined;
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const rows = [];
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      if (typeof row.key !== 'string' || !row.key.startsWith(ENTRY_PREFIX)) continue;
      if (!KEY_RE.test(row.key.slice(ENTRY_PREFIX.length))) continue;
      if (!Number.isFinite(row.bytes) || !Number.isFinite(row.lastUsedAt)) continue;
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      rows.push({ key: row.key, bytes: row.bytes, lastUsedAt: row.lastUsedAt });
    }
    return rows.sort(byRecency);
  }

  // Evict oldest-first until both bounds hold, never dropping a key the caller
  // is about to use. Returns the surviving rows and the keys to delete.
  function planBudget(rows, keepKeys) {
    const alive = rows.slice().sort(byRecency);
    const dropped = [];
    let totalBytes = alive.reduce((sum, row) => sum + row.bytes, 0);
    while (alive.length > MAX_ENTRIES || totalBytes > MAX_BYTES) {
      const oldest = alive[0];
      if (!oldest || keepKeys.has(oldest.key)) break;
      alive.shift();
      totalBytes -= oldest.bytes;
      dropped.push(oldest.key);
    }
    return { rows: alive, dropped };
  }

  async function commitBudget(rows, dropped) {
    if (dropped.length > 0) await chrome.storage.local.remove(dropped);
    await chrome.storage.local.set({ [INDEX_KEY]: rows });
  }

  async function lookup(url) {
    try {
      const key = await cacheKeyFor(url);
      if (!key) return null;
      const storageKey = `${ENTRY_PREFIX}${key}`;
      const stored = await chrome.storage.local.get(storageKey);
      const record = stored ? stored[storageKey] : undefined;

      if (!isRecord(record)) {
        if (record !== undefined) await chrome.storage.local.remove(storageKey).catch(() => {});
        return null;
      }

      try {
        const lastUsedAt = Date.now();
        await chrome.storage.local.set({ [storageKey]: { ...record, lastUsedAt } });
        const index = (await readIndex()).filter((row) => row.key !== storageKey);
        index.push({ key: storageKey, bytes: record.bytes, lastUsedAt });
        const planned = planBudget(index, new Set([storageKey]));
        await commitBudget(planned.rows, planned.dropped);
      } catch {
        // A failed recency bump only degrades eviction order.
      }

      return { text: record.text, savedAt: record.savedAt };
    } catch {
      return null;
    }
  }

  async function store(url, text) {
    try {
      const key = await cacheKeyFor(url);
      if (!key) return false;
      if (typeof text !== 'string' || text.length === 0) return false;
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > MAX_BYTES) return false;

      const storageKey = `${ENTRY_PREFIX}${key}`;
      const now = Date.now();
      // Record first, then index: an interrupted write leaves a readable record
      // that the next lookup re-indexes, never an index row with no record.
      await chrome.storage.local.set({
        [storageKey]: { v: SCHEMA_VERSION, url: normalizeUrl(url), text, bytes, savedAt: now, lastUsedAt: now }
      });

      const index = (await readIndex()).filter((row) => row.key !== storageKey);
      index.push({ key: storageKey, bytes, lastUsedAt: now });
      const planned = planBudget(index, new Set([storageKey]));
      await commitBudget(planned.rows, planned.dropped);
      return true;
    } catch {
      return false;
    }
  }

  async function clear() {
    try {
      const stored = await chrome.storage.local.get(null);
      const keys = Object.keys(stored || {}).filter((key) => key.startsWith(ENTRY_PREFIX));
      keys.push(INDEX_KEY);
      await chrome.storage.local.remove(keys);
    } catch {
      // Clearing is best effort; a failed clear leaves only the cache behind.
    }
  }

  return Object.freeze({
    MAX_BYTES,
    MAX_ENTRIES,
    ENTRY_PREFIX,
    INDEX_KEY,
    SCHEMA_VERSION,
    cacheKeyFor,
    lookup,
    store,
    clear
  });
})();
```

Implementation requirements beyond passing the tests: `planBudget` must never drop a key in `keepKeys` — without that guard a backwards clock adjustment evicts the entry just written and `store` returns `true` for a record that no longer exists; `store` must leave the index no longer than `MAX_ENTRIES` and no larger than `MAX_BYTES` in total; `lookup` must never throw; and no failure path may log, because a warning per capture would flood the worker console.

- [ ] **Step 6: Run the module tests and confirm they pass**

```sh
node tests/ocr-cache.test.js
```

Expected: PASS for every test in the file. If any eviction test is order-sensitive, set explicit `lastUsedAt` values on the records before asserting rather than relying on `Date.now()` resolution.

- [ ] **Step 7: Commit the module**

```sh
git add extension/ocr-cache.js tests/ocr-cache.test.js tests/background.test.js
git commit -m "feat(ocr-cache): add URL-keyed capture result store"
```

## Task 2: Publish through one seam and reuse completed captures

**Implementer tier:** Capable

**Files:**

- Modify: `extension/background.js:1-10` (add `importScripts('ocr-cache.js')` as the first statement)
- Modify: `extension/background.js:457-491` (`handlePopupStart` delegates to the new flow)
- Modify: `extension/background.js:331-355` (keyboard command uses the same flow)
- Modify: `extension/background.js:1629-1730` (`finalizeCapture` split around `publishCaptureResult`)
- Modify: `extension/background.js:193-210` and `extension/background.js:1980-2020` (`cacheHit` in the state shape and in `resetState`)
- Modify: `extension/background.js:2090-2105` (`getPublicState` exposes `cacheHit`)
- Test: `tests/background.test.js`

**Interfaces:**

- Consumes: Task 1's frozen `OcrCache` with `cacheKeyFor(url)`, `lookup(url)`, `store(url, text)`; existing `getState(tabId)`, `updateState(tabId, partial)`, `getPublicState(state)`, `canStartPostCaptureAutomation(state)`, `clearRetryState(tabId, state)`, `clearOperation(type, tabId, operationId)`, `getLiveTargetTab(tabId)`, `createOperationId(type, tabId)`, `runCaptureLifecycle(tabId, operationId, operation)`, `requirePersistableText(text, label)`, `fragmentCountOf(fragmentsOrCount)`, `autoFormatIfEnabled(tabId, text, host, port, source)`, and `autoTranslateIfEnabled(tabId, originalText)`.
- Produces: `async publishCaptureResult(tabId, text, options)` returning the published text, where `options` is `{ status, progress, fragmentCount = 0, cacheHit = false, storeResult = true }`. It owns the state transition, the `lastResult:<tabId>`/`lastStatus:<tabId>` write and its failure handling, `clearRetryState`, `clearOperation`, the optional cache store, and the post-capture automation gate.
- Produces: `async publishCachedCapture(tabId, url, cachedText) => Promise<boolean>` — `true` when the cached text was published, `false` when the hit was abandoned because the live tab no longer matches.
- Produces: `async startCaptureFlow(tabId, { force, startSelection }) => Promise<{ ok: true, cacheHit?: true }>`.
- Preserves: `async finalizeCapture(tabId, finalText, fragmentsOrCount)` with unchanged observable behavior for every existing case, including returning `''` for an empty cancellation.

- [ ] **Step 1: Write the failing behavioral tests**

Append to `tests/background.test.js`, which already defines `createBackgroundHarness`, `REGION`, `deferred`, `delay`, and `waitFor`.

```js
const CACHE_URL = 'https://example.test/article?id=7';

test('a complete capture is stored and a repeat start publishes it without OCR', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: CACHE_URL }]
  });
  await harness.originalFinalizeCapture(1, 'fresh page text', 3);

  assert.equal(harness.context.getState(1).status, 'Done');
  assert.equal((await harness.context.OcrCache.lookup(CACHE_URL)).text, 'fresh page text');

  const capturesBefore = harness.captureCalls.length;
  await harness.context.handlePopupStart();
  await waitFor(
    () => harness.context.getState(1).status === 'Done'
      && harness.context.getState(1).mergedText === 'fresh page text'
      && harness.context.getState(1).cacheHit === true,
    'cached result was not published'
  );

  assert.equal(harness.captureCalls.length, capturesBefore);
  assert.equal(harness.ocrCalls.length, 0);
  assert.equal(
    harness.messageCalls.filter(({ message }) => message.type === 'selection:start').length,
    0
  );
  assert.match(harness.context.getState(1).progress, /loaded page result from cache/i);
});

test('force refresh captures the page even when a cached entry exists', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: CACHE_URL }]
  });
  await harness.context.OcrCache.store(CACHE_URL, 'cached page text');

  const response = await harness.context.handlePopupStart({ force: true });

  assert.deepEqual({ ...response }, { ok: true });
  assert.equal(harness.context.getState(1).status, 'Selecting');
  assert.equal(harness.context.getState(1).cacheHit, false);
  assert.match(harness.context.getState(1).progress, /force refresh/i);
  assert.equal(
    harness.messageCalls.filter(({ message }) => message.type === 'selection:start').length,
    1
  );
});

test('a forced capture replaces the stored entry on completion', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: CACHE_URL }]
  });
  await harness.context.OcrCache.store(CACHE_URL, 'old text');

  await harness.originalFinalizeCapture(1, 'new text', 2);

  assert.equal((await harness.context.OcrCache.lookup(CACHE_URL)).text, 'new text');
});

test('a partial capture neither stores its text nor overwrites a good entry', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: CACHE_URL }]
  });
  await harness.context.OcrCache.store(CACHE_URL, 'good text');

  const state = harness.context.getState(1);
  state.partialReason = 'stopped';
  state.stopRequested = true;
  await harness.originalFinalizeCapture(1, 'short text', 1);

  assert.equal(state.status, 'Partial');
  assert.equal((await harness.context.OcrCache.lookup(CACHE_URL)).text, 'good text');
});

test('a partial first capture stores nothing at all', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: CACHE_URL }]
  });
  harness.context.getState(1).partialReason = 'error';

  await harness.originalFinalizeCapture(1, 'half text', 1);

  assert.equal(await harness.context.OcrCache.lookup(CACHE_URL), null);
});

test('an uncacheable page falls through to selection and stores nothing', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: 'chrome://extensions' }]
  });

  await harness.context.handlePopupStart();
  assert.equal(harness.context.getState(1).status, 'Selecting');

  await harness.originalFinalizeCapture(1, 'extension page text', 1);
  assert.equal(Object.keys(harness.localData).some((key) => key.startsWith('ocrCache')), false);
});

test('a cache lookup failure degrades to a normal selection flow', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: CACHE_URL }]
  });
  harness.context.OcrCache.lookup = async () => { throw new Error('storage down'); };

  await harness.context.handlePopupStart();

  assert.equal(harness.context.getState(1).status, 'Selecting');
});

test('a cache store failure still publishes the fresh result', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: CACHE_URL }]
  });
  harness.context.OcrCache.store = async () => { throw new Error('quota'); };

  const published = await harness.originalFinalizeCapture(1, 'fresh text', 2);

  assert.equal(published, 'fresh text');
  assert.equal(harness.localData['lastResult:1'], 'fresh text');
  assert.equal(harness.context.getState(1).status, 'Done');
});

test('a cached hit still runs post-capture automation', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: CACHE_URL }]
  });
  await harness.context.OcrCache.store(CACHE_URL, 'cached page text');
  vm.runInContext(`
    autoFormatIfEnabled = async () => { __formatCalls += 1; };
    autoTranslateIfEnabled = async () => { __translateCalls += 1; };
  `, harness.context);
  harness.context.__formatCalls = 0;
  harness.context.__translateCalls = 0;

  await harness.context.handlePopupStart();
  await waitFor(() => harness.context.getState(1).status === 'Done', 'cached publish did not finish');
  await delay(1);

  assert.equal(harness.context.__formatCalls, 1);
  assert.equal(harness.context.__translateCalls, 1);
});

test('a cached hit publishes into lastResult and the public state', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: CACHE_URL }],
    localData: { 'lastResult:1': 'stale tab text' }
  });
  await harness.context.OcrCache.store(CACHE_URL, 'cached page text');

  await harness.context.handlePopupStart();
  await waitFor(() => harness.context.getState(1).status === 'Done', 'cached publish did not finish');

  assert.equal(harness.localData['lastResult:1'], 'cached page text');
  assert.equal(harness.localData['lastStatus:1'], 'Done');
  assert.equal(harness.context.getState(1).mergedText, 'cached page text');
  assert.equal(
    harness.context.getPublicState(harness.context.getState(1)).cacheHit,
    true
  );
});

test('a cached hit is abandoned when the live tab url no longer matches', async () => {
  const harness = createBackgroundHarness({
    tabs: [{ id: 1, windowId: 10, active: true, url: CACHE_URL }]
  });

  const published = await harness.context.publishCachedCapture(
    1,
    'https://example.test/other',
    'foreign text'
  );

  assert.equal(published, false);
  assert.equal(Object.hasOwn(harness.localData, 'lastResult:1'), false);
  assert.equal(harness.context.getState(1).cacheHit, false);
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

```sh
node tests/background.test.js
```

Expected: FAIL. `handlePopupStart` ignores `force`, `getState(1).cacheHit` is `undefined`, `publishCachedCapture` is not defined, and `originalFinalizeCapture` stores nothing.

- [ ] **Step 3: Load the cache module in the service worker**

Add as the very first line of `extension/background.js`, above `const DEFAULT_HOST = 'localhost';`:

```js
importScripts('ocr-cache.js');
```

`importScripts` must run before any code reads `OcrCache`, and the module declares a single `const OcrCache`, so it must be loaded exactly once. Do not add a second call.

- [ ] **Step 4: Extract the publication seam**

Replace `finalizeCapture` with the two functions below. The partial-reason strings, the empty-cancellation semantics, and the return values are copied from the current implementation unchanged; only the terminal publish moves into the shared seam.

```js
async function publishCaptureResult(tabId, text, options = {}) {
  const {
    status,
    progress,
    fragmentCount = 0,
    cacheHit = false,
    storeResult = true
  } = options;
  const state = getState(tabId);
  state.retryStage = null;
  state.pendingText = '';

  requirePersistableText(text, 'Capture result');

  updateState(tabId, {
    active: false,
    status,
    currentPage: fragmentCount,
    fragmentsCollected: fragmentCount,
    progress,
    fragments: [],
    checkpointText: text,
    mergedText: text,
    cacheHit
  });
  try {
    await chrome.storage.local.set({
      [`lastResult:${tabId}`]: text,
      [`lastStatus:${tabId}`]: status
    });
  } catch (error) {
    updateState(tabId, {
      status: 'Error',
      error: `Failed to persist capture result: ${error.message}`,
      progress: 'Capture finished, but its result could not be saved.'
    });
    throw error;
  }

  await clearRetryState(tabId, state);
  if (state.captureOperationId) {
    await clearOperation('capture', tabId, state.captureOperationId);
  }

  // Only a complete capture is reusable for this page later. The URL comes from
  // the capture binding, falling back to the live tab for direct finalization.
  if (storeResult && status === 'Done') {
    let cacheUrl = state.captureUrl;
    if (!cacheUrl) {
      const tab = await getLiveTargetTab(tabId).catch(() => null);
      cacheUrl = tab?.url || null;
    }
    if (cacheUrl) await OcrCache.store(cacheUrl, text).catch(() => {});
  }

  if (canStartPostCaptureAutomation(state)) {
    await autoFormatIfEnabled(tabId, text, undefined, undefined, 'ocr');
    if (canStartPostCaptureAutomation(state)) {
      try {
        await autoTranslateIfEnabled(tabId, text);
      } catch (error) {
        const message = error?.message || 'Auto-translation failed.';
        await chrome.storage.local.set({ [`tl2Status:${tabId}`]: message }).catch((storageError) => {
          console.error('Failed to persist auto-translation error:', storageError);
        });
        console.error('Auto-translation failed after capture completed:', error);
      }
    }
  }

  return text;
}

async function finalizeCapture(tabId, finalText, fragmentsOrCount) {
  const state = getState(tabId);
  const fragmentCount = fragmentCountOf(fragmentsOrCount);

  const isEmptyCancellation = !String(finalText || '').length
    && ['stopped', 'navigation', 'tab_closed'].includes(state.partialReason);
  if (isEmptyCancellation) {
    state.retryStage = null;
    state.pendingText = '';
    let progress = 'Capture cancelled before any text was collected.';
    if (state.partialReason === 'navigation') {
      progress = 'Capture cancelled because the page navigated before any text was collected.';
    } else if (state.partialReason === 'tab_closed') {
      progress = 'Capture cancelled because the tab closed before any text was collected.';
    }
    updateState(tabId, {
      active: false,
      status: 'Cancelled',
      currentPage: 0,
      fragmentsCollected: 0,
      progress,
      fragments: [],
      checkpointText: '',
      mergedText: ''
    });
    await chrome.storage.local.remove(`lastResult:${tabId}`);
    await clearRetryState(tabId, state);
    await chrome.storage.local.set({ [`lastStatus:${tabId}`]: 'Cancelled' });
    if (state.captureOperationId) {
      await clearOperation('capture', tabId, state.captureOperationId);
    }
    return '';
  }

  const isPartial = Boolean(state.partialReason);
  let progress = 'Finished.';
  if (state.partialReason === 'navigation') {
    progress = `Partial capture: page navigation stopped capture after ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'stopped') {
    progress = `Partial capture stopped after ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'tab_closed') {
    progress = `Partial capture: the tab closed after ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'error') {
    progress = `Partial capture ended after an error; saved ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'text_limit') {
    progress = `Partial capture stopped at the ${MAX_PERSISTED_TEXT_BYTES}-byte safety limit after ${fragmentCount} fragment${fragmentCount === 1 ? '' : 's'}.`;
  } else if (state.partialReason === 'page_limit') {
    progress = `Partial capture truncated at the ${MAX_CAPTURE_PAGES}-page limit; more page content remains.`;
  }

  return publishCaptureResult(tabId, finalText, {
    status: isPartial ? 'Partial' : 'Done',
    progress,
    fragmentCount
  });
}
```

- [ ] **Step 5: Add `cacheHit` to the state shape**

In `getState`, add `cacheHit: false,` beside `partialError: ''` in the object literal that seeds a tab state. In `resetState`, add `cacheHit: false,` beside `partialReason: ''` in the `Object.assign` literal. In `getPublicState`, add `cacheHit: state.cacheHit === true,` immediately after `mergedText: state.mergedText,`.

- [ ] **Step 6: Add the cache-aware capture start**

Insert both functions immediately after `handlePopupStart`:

```js
async function publishCachedCapture(tabId, url, cachedText) {
  const operationId = createOperationId('capture', tabId);
  return runCaptureLifecycle(tabId, operationId, async () => {
    // A hit is only valid for the page that produced it: re-read the live tab so
    // a navigation between lookup and publish cannot publish foreign text.
    const live = await getLiveTargetTab(tabId);
    if (!live) return false;
    const liveKey = await OcrCache.cacheKeyFor(live.url || '');
    const expectedKey = await OcrCache.cacheKeyFor(url);
    if (!liveKey || liveKey !== expectedKey) return false;

    const state = getState(tabId);
    state.captureUrl = live.url || url;
    state.partialReason = '';
    state.partialError = '';
    await publishCaptureResult(tabId, cachedText, {
      status: 'Done',
      progress: 'Loaded page result from cache. Check Force refresh to capture again.',
      fragmentCount: 0,
      cacheHit: true,
      storeResult: false
    });
    return true;
  });
}

async function startCaptureFlow(tabId, { force = false, startSelection }) {
  const state = getState(tabId);
  state.cacheHit = false;

  const tab = await getLiveTargetTab(tabId);
  const url = tab?.url || null;

  if (!force && url) {
    const cached = await OcrCache.lookup(url).catch(() => null);
    if (cached?.text) {
      const published = await publishCachedCapture(tabId, url, cached.text).catch(() => false);
      if (published) return { ok: true, cacheHit: true };
      // The page changed under us, so fall through to a normal capture once.
      if (!await getLiveTargetTab(tabId)) throw new Error('The page is no longer available.');
    }
  }

  updateState(tabId, {
    active: true,
    status: 'Selecting',
    progress: force ? 'Force refresh: capturing this page again.' : 'Drag a rectangle.'
  });
  return startSelection();
}
```

Then delegate both entry points to it. In `handlePopupStart`, replace the block that runs from `state.selectionToken = createSelectionToken();` through the `try { await chrome.tabs.sendMessage(...) } catch (error) { ... }` with:

```js
  state.selectionToken = createSelectionToken();
  try {
    return await startCaptureFlow(tab.id, {
      force: message.force === true,
      startSelection: async () => {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'selection:start',
          lastRegion: state.lastRegion || undefined,
          selectionToken: state.selectionToken
        });
        return { ok: true };
      }
    });
  } catch (error) {
    state.selectionToken = null;
    updateState(tab.id, {
      active: false,
      status: 'Error',
      error: error.message,
      progress: 'Failed.'
    });
    throw error;
  }
```

The function's trailing `return { ok: true };` is removed because the `try` now returns. In the `chrome.commands.onCommand` handler, replace the block that runs from `state.selectionToken = createSelectionToken();` through the `await chrome.tabs.sendMessage(tab.id, { type: 'selection:start', ... });` call with:

```js
    state.selectionToken = createSelectionToken();

    // The keyboard shortcut has no popup, so force is always false.
    await startCaptureFlow(tab.id, {
      force: false,
      startSelection: async () => {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'selection:start',
          lastRegion: state.lastRegion || undefined,
          selectionToken: state.selectionToken
        });
        return { ok: true };
      }
    });
```

`startCaptureFlow` performs the `active: true` / `status: 'Selecting'` transition, so the keyboard path keeps its existing observable state changes.

- [ ] **Step 7: Run the full Node suites**

```sh
node tests/ocr-cache.test.js && node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js
```

Expected: PASS. These pre-existing tests must still pass unchanged, because they pin the seam and both entry points: `stopped captures are persisted and displayed as partial`, `stopped captures with no fragments are cancelled without persisting empty text`, `capture checkpoints are cleared before downstream automation`, `keyboard capture does not mutate an active capture`, and `keyboard capture snapshots current backend settings when selection starts`.

- [ ] **Step 8: Commit the integration**

```sh
git add extension/background.js tests/background.test.js
git commit -m "feat(ocr): reuse cached page captures unless forced"
```

## Task 3: Add the Force refresh control

**Implementer tier:** Standard

**Files:**

- Modify: `extension/popup.html:365-368`
- Modify: `extension/popup.js:18-25` (element binding), `extension/popup.js:806-836` (`startCapture`), `extension/popup.js:860-900` (`renderState`)
- Test: `tests/popup.test.js`
- Test: `tests/test_extension_assets.py`

**Interfaces:**

- Consumes: `chrome.runtime.sendMessage({ type: 'popup:start', backend, force })` and the `cacheHit: boolean` field of the `popup:get-state` response produced by Task 2.
- Produces: element id `ocr-force-refresh`; a `popup:start` message that carries `force: true` only when the box is checked; a **Status** stat that renders `Cached` when `cacheHit` is true and `status` is `Done`.

- [ ] **Step 1: Write the failing markup assertion**

Append to `tests/test_extension_assets.py`. Ensure `import re` is present in the module's import block; add it if it is missing.

```python
def test_ocr_panel_exposes_a_force_refresh_checkbox() -> None:
    html = (ROOT / "extension" / "popup.html").read_text(encoding="utf-8")
    popup_js = (ROOT / "extension" / "popup.js").read_text(encoding="utf-8")

    assert re.search(
        r'<label><input id="ocr-force-refresh" type="checkbox">\s*Force refresh</label>',
        html,
    )
    assert "ocr-force-refresh" in popup_js
    # Force refresh is a per-start action, never a persisted setting.
    assert "ocrForceRefresh" not in popup_js
```

- [ ] **Step 2: Write the failing popup behavior tests**

Append to `tests/popup.test.js`:

```js
test('the force refresh checkbox starts unchecked and is sent only when checked', async () => {
  const harness = createPopupHarness();
  const forceBox = harness.elements.get('ocr-force-refresh');
  assert.equal(forceBox.checked, false);

  await harness.context.startCapture();
  const firstStart = harness.runtimeMessages.filter((message) => message.type === 'popup:start');
  assert.equal(firstStart.length, 1);
  assert.equal(Object.hasOwn(firstStart[0], 'force'), false);
  assert.equal(forceBox.checked, false);

  forceBox.checked = true;
  await harness.context.startCapture();
  const starts = harness.runtimeMessages.filter((message) => message.type === 'popup:start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].force, true);
  assert.equal(forceBox.checked, false);
});

test('the force refresh checkbox is disabled while a capture is active', () => {
  const harness = createPopupHarness();
  const forceBox = harness.elements.get('ocr-force-refresh');

  harness.context.renderState({ active: true, status: 'Capturing', progress: 'Page 2', mergedText: '' });
  assert.equal(forceBox.disabled, true);

  harness.context.renderState({ active: false, status: 'Done', progress: 'Finished.', mergedText: 'text' });
  assert.equal(forceBox.disabled, false);
});

test('a cached result renders as Cached rather than Done', () => {
  const harness = createPopupHarness();
  const statusEl = harness.elements.get('status');

  harness.context.renderState({
    active: false,
    status: 'Done',
    progress: 'Loaded page result from cache. Check Force refresh to capture again.',
    mergedText: 'cached page text',
    cacheHit: true
  });
  assert.equal(statusEl.textContent, 'Cached');

  harness.context.renderState({
    active: false,
    status: 'Done',
    progress: 'Finished.',
    mergedText: 'fresh text',
    cacheHit: false
  });
  assert.equal(statusEl.textContent, 'Done');
});
```

- [ ] **Step 3: Run the popup and asset tests and confirm they fail**

```sh
node tests/popup.test.js && python -m pytest -q tests/test_extension_assets.py
```

Expected: FAIL. The popup tests fail because `startCapture` never reads or resets the checkbox and `renderState` does not mark `Cached`; the asset test fails because the markup does not exist.

- [ ] **Step 4: Add the markup**

In `extension/popup.html`, replace

```html
      <div class="option-row">
        <label><input id="ocr-autoscroll" type="checkbox" checked> Auto-scroll</label>
      </div>
```

with

```html
      <div class="option-row">
        <label><input id="ocr-autoscroll" type="checkbox" checked> Auto-scroll</label>
        <label><input id="ocr-force-refresh" type="checkbox"> Force refresh</label>
      </div>
```

- [ ] **Step 5: Bind and use the control in the popup**

Add the binding beside the existing OCR element bindings near the top of `extension/popup.js`:

```js
const forceRefreshCheckbox = document.getElementById('ocr-force-refresh');
```

In `startCapture`, send the flag and clear it only after an accepted start. Replace

```js
    const response = await chrome.runtime.sendMessage({
      type: 'popup:start',
      backend,
      ...(Object.keys(prompts).length ? { prompts } : {})
    });
    if (!response?.ok) {
```

with

```js
    const force = forceRefreshCheckbox.checked;
    const response = await chrome.runtime.sendMessage({
      type: 'popup:start',
      backend,
      ...(force ? { force: true } : {}),
      ...(Object.keys(prompts).length ? { prompts } : {})
    });
    if (response?.ok) forceRefreshCheckbox.checked = false;
    if (!response?.ok) {
```

Do not write the checkbox value to `chrome.storage.sync` or `chrome.storage.local`.

The replacement above stops at the existing `if (!response?.ok) {` line on purpose: that branch's body — which sets `progressEl.textContent` and re-enables `startButton` — is preserved exactly as it is, and the new `if (response?.ok) forceRefreshCheckbox.checked = false;` line goes immediately before it. Do not delete or reorder the error branch.

In `renderState`, replace

```js
  statusEl.textContent = latestState.status === 'Idle' && lastStoredStatus
    ? lastStoredStatus
    : (latestState.status || 'Idle');
```

with

```js
  statusEl.textContent = latestState.cacheHit && latestState.status === 'Done'
    ? 'Cached'
    : (latestState.status === 'Idle' && lastStoredStatus ? lastStoredStatus : (latestState.status || 'Idle'));
```

and add `forceRefreshCheckbox.disabled = isActive;` immediately after the existing `startButton.disabled = isActive;` line.

- [ ] **Step 6: Run the tests and confirm they pass**

```sh
node tests/popup.test.js
python -m pytest -q tests/test_extension_assets.py
```

Expected: PASS for both suites.

- [ ] **Step 7: Commit the control**

```sh
git add extension/popup.html extension/popup.js tests/popup.test.js tests/test_extension_assets.py
git commit -m "feat(popup): add OCR force refresh control"
```

## Task 4: Document the cache and bump the version

**Implementer tier:** Fast

**Files:**

- Modify: `README.md:76-94` and `README.md:350-384` and `README.md:398-422`
- Modify: `CLAUDE.md:17-22`
- Modify: `extension/manifest.json:4`

**Interfaces:**

- Consumes: the behavior implemented by Tasks 1-3, including the 2 MB / 50-entry budget, the `Done`-only rule, and URL-only identity.
- Produces: no code interface; documentation and the manifest version only.

- [ ] **Step 1: Document the extension-side cache in the README**

At the end of `### POST /ocr`, add:

```markdown
`POST /ocr` has no result cache and no `force` field. Reuse of a whole page capture happens in the extension, not in this endpoint.
```

Under `### Capture controls`, add a bullet:

```markdown
- `Force refresh` in the OCR panel skips the page cache and captures the page again. It resets to unchecked after every accepted start and is never saved as a setting.
```

Under `### OCR, deduplication, translation, and formatting`, add a paragraph:

```markdown
A capture that completes normally is also stored in `chrome.storage.local` under a key derived from the page URL, so capturing the same page again publishes the stored text immediately: no region drag, no screenshots, and no `/ocr` calls. Only complete captures are stored; a `Partial` or `Cancelled` capture is never cached and never served from the cache. The key is the normalized URL alone — lowercase scheme and host, no default port, no `#fragment`, query and path preserved — so the selected region, autoscroll, prompts, and backend settings do not affect it. A changed page or a different region therefore requires `Force refresh`. `chrome://`, `file://`, `about:`, `view-source:`, and `data:` pages are never cached. The popup reports a reused result with the status `Cached`.
```

Under `### Settings and persistence`, in the Chrome local storage list, add:

```markdown
- Captured OCR results keyed by normalized page URL, bounded to 2 MB of text and at most 50 entries, evicting the least recently used entry first. No expiry is applied; removing the cache requires clearing extension data or capturing with `Force refresh`.
```

- [ ] **Step 2: Document the cache in CLAUDE.md**

In `## Code Standards`, after the line describing `chrome.storage.sync` and `chrome.storage.local`, add:

```markdown
- Completed OCR captures are cached in `chrome.storage.local` keyed only by the normalized page URL (`extension/ocr-cache.js`; 2 MB / 50-entry LRU, no TTL). Partial captures are never cached. Force refresh bypasses the lookup and is never persisted.
```

- [ ] **Step 3: Bump the manifest version**

Change `"version": "2.1.2",` to `"version": "2.2.0",` in `extension/manifest.json`.

- [ ] **Step 4: Verify the documentation and version**

```sh
python -m pytest -q tests/test_extension_assets.py
node -e "const m=require('./extension/manifest.json'); if (m.version !== '2.2.0') throw new Error('version not bumped'); console.log('manifest', m.version);"
```

Expected: the asset tests pass and the check prints `manifest 2.2.0`.

- [ ] **Step 5: Run every default suite once more**

```sh
node tests/ocr-cache.test.js && node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js
python -m pytest -q tests/
```

Expected: PASS everywhere. `tests/extension_e2e.test.js` needs a Chrome binary and is not part of the default command in `CLAUDE.md`; run it separately with `node tests/extension_e2e.test.js` if it is available locally.

- [ ] **Step 6: Commit the documentation and version**

```sh
git add README.md CLAUDE.md extension/manifest.json
git commit -m "docs(ocr-cache): document page capture cache and bump to 2.2.0"
```

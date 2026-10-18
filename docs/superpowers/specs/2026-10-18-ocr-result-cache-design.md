# TextKit OCR result cache — design

Date: 2026-10-18
Status: accepted, pending specification and implementation plan
Base: `28fda71` (`main`), extension `2.1.2`

## Background and goal

Capturing a long page with the OCR loop is expensive: hundreds of `captureVisibleTab`
frames, one `/ocr` request per frame, and a `/dedup` pass at the end. YT2TXT avoids
repeating the same work for the same page by caching its transcript under a
URL-derived key and offering a **Force refresh** checkbox. TextKit has the same
shape of problem and no equivalent.

The goal is to skip the whole capture for a page that was already captured, while
keeping the user in control of when cached output is reused. This is deliberately
not a correctness mechanism: the user accepts that a URL-keyed hit may return text
produced from a different scroll start or a different region, and Force refresh is
the only correction.

Scope is the OCR capture result only. `/ocr`, `/dedup`, the transformation cache for
`/format` and `/translate`, and the save/path-suggestion file bridge are unchanged.

## Scope and alternatives

The selected design has five properties. Each was chosen over alternatives during
design review:

1. **Extension-side storage, not backend.** The cache lives in
   `chrome.storage.local`. `POST /ocr` receives one image and never sees the page
   URL, so a backend URL cache would require a new endpoint pair and would move raw
   capture results into a second backend store. TextKit is a single-user local tool
   with one browser, so per-browser storage is the right scope, and
   `lastResult:<tabId>` already proves extension-side result persistence works here.
2. **URL-only identity.** The key is the normalized page URL. Region, autoscroll,
   effective OCR prompt, and backend endpoint are deliberately excluded. A hit may
   therefore return output from a different region or prompt than the current
   settings would produce; Force refresh is the escape hatch.
3. **Complete captures only.** A `Partial` capture is never stored and never
   satisfies a lookup. `Partial` is exactly the signal that the page was not fully
   read, and it is the one case where a hit is silently *wrong* rather than merely
   *old*.
4. **A hit short-circuits selection.** "Select Region" performs the lookup first; on
   a hit the result is published immediately and no region drag occurs. The URL
   determines the identity, so the drag that produced the entry is irrelevant.
5. **Bounded bytes with LRU eviction.** No TTL. Capacity, not time, is the guarantee;
   a TTL would be a second, redundant staleness mechanism on top of the one the user
   already owns.

Rejected alternatives: a backend cache sharing `transformation_cache.py` (URL never
reaches the backend, and raw capture text does not belong in a transformation store);
in-memory-only caching (dies with the service worker); storing `Partial` results;
select-then-lookup ordering (the drag would dominate the latency of an instant
result).

## Cache identity

A capture key is the SHA-256 hex digest of the normalized page URL:

- Reject any URL whose parsed protocol is not `http:` or `https:`. `chrome://`,
  `file://`, `about:`, `view-source:`, `data:`, extension pages, and unparseable
  strings are uncacheable: lookup is skipped and no entry is written.
- Lowercase the scheme and host; drop default ports (`:80` for http, `:443` for
  https).
- Drop the `#fragment`.
- Keep the path and query string verbatim, including a trailing slash and percent
  encoding. `/page` and `/page/` are different keys; the user can force refresh.
- The original (pre-hash) URL is stored in the record for diagnostics only. It is
  never displayed and is not part of any user-visible contract.

Nothing else enters the key: not the tab ID, not the window, not the selected region,
not the scroll position, not the prompt snapshot, not the backend host/port, not a
timestamp. The key is stable across tabs, windows, and service-worker restarts.

## Identity of the cached value

The stored text is the result the user would otherwise have seen: the post-dedup
`finalText` that `finalizeCapture` publishes, not the raw merged fragments and not
the per-page OCR text. The cache is written from the same publication seam that
handles a fresh capture, so there is no second definition of "the result".

Automatic formatting and translation produced by `autoFormatIfEnabled` /
`autoTranslateIfEnabled` after a capture are **not** part of the OCR record. They
remain governed by the existing `/format` and `/translate` transformation cache.
Consequently an OCR Force refresh forces only the capture; downstream stages still
follow their own cache rules.

## Popup control

One checkbox in the OCR panel, added to the existing `.option-row` beside
`Auto-scroll` (matching YT2TXT's placement directly above the action buttons):

```html
<label><input id="ocr-force-refresh" type="checkbox"> Force refresh</label>
```

Behavior:

- The checkbox is unchecked by default, is never written to `chrome.storage.sync`,
  and is reset to unchecked after each successful `popup:start`. A sticky force flag
  would silently disable the cache forever and present as "the cache is broken".
- The checkbox is disabled while a capture is active or while the OCR panel is in
  the `Selecting` state, so it never implies a change to a capture already running.
- The popup sends `force: true` in the `popup:start` message only when the box is
  checked. Otherwise the field is omitted, matching the convention already used for
  `prompts`.
- The `Ctrl+Shift+S` keyboard command has no popup context and always uses
  `force: false`.

## Flow

Both entry points call one new background function, `handleCaptureStart`, so the path
cannot diverge between the popup button and the keyboard shortcut.

```
resolve active tab ──> URL snapshot ──> cacheable?
    │                                     │
    │                                     no ──────────────┐
    └── force? ──> yes ──────────────────────────────────>  │
                                  │ (skip lookup)           │
                                  no                        │
                                  ▼                         │
                       cache lookup (hit?)                  │
                        │            │                      │
                      hit          miss/error               │
                        │            │                      │
                        ▼            └──────────────────────┤
                publish cached text                          ▼
                (no selection, no OCR)            selection → capture loop
                                                            │
                                                            ▼
                                                  publish + store if Done
```

### Hit path

1. The lookup result is published inside `runCaptureLifecycle` with a fresh capture
   operation ID. Reusing the lifecycle means the existing in-flight guard rejects a
   double click, `Stop` and tab-close handling behave identically, and
   `captureOperationId` bookkeeping is unchanged. A hit does not persist an operation
   checkpoint, because there is no resumable work.
2. Before publishing, the live tab URL is re-read. If it no longer normalizes to the
   same key, the hit is discarded and the flow restarts once from the top with the
   new URL (lookup, then normal selection on a miss). This keeps the standing rule
   that capture is bound to the starting URL.
3. Publication uses the extracted `publishCaptureResult` seam (below) with
   `status: 'Done'`, `fragmentsCollected: 0`, and
   `progress: 'Loaded page result from cache. Check Force refresh to capture again.'`.
   The explicit provenance text is required: an instant capture with no scrolling
   and no screenshots is otherwise indistinguishable from a broken capture.
4. The entry's `lastUsedAt` is bumped, then the existing post-capture automation runs
   unchanged (auto-copy, auto-save, auto-format, auto-translate) through the existing
   `canStartPostCaptureAutomation` gate.
5. The fresh capture is not re-stored; the entry already holds this text.

### Miss path

Unchanged selection and capture loop. The only addition is the store step at
publication.

### Publication seam

`finalizeCapture` currently mixes four concerns: partial-reason progress strings,
empty-cancellation handling, persistence, and automation. Extract a private
`publishCaptureResult(tabId, text, options)` used by both `finalizeCapture` and the
cache-hit path. It owns:

- `requirePersistableText` validation,
- the `updateState` transition (`active: false`, `status`, `currentPage`,
  `fragmentsCollected`, `progress`, cleared `fragments`/`checkpointText`, `mergedText`),
- `lastResult:<tabId>` / `lastStatus:<tabId>` writes with the existing failure
  handling,
- `clearRetryState` and `clearOperation` for the terminal operation,
- the post-capture automation gate.

`finalizeCapture` keeps its partial-reason logic and calls the seam with the strings
it computes today. The cache store call lives in the seam and runs only when
`status === 'Done'` and the URL snapshot is cacheable. The hit path passes
`storeResult: false`.

`getPublicState` gains `cacheHit: boolean` so the popup can render provenance without
parsing progress text. It defaults to `false` and is reset by `resetState`. The popup
uses it for one thing: when `cacheHit` is true, the **Status** stat renders `Cached`
instead of the ordinary status word, so a reopened popup still shows provenance after
the progress line has been replaced by a later automation message. No new DOM node is
added.

## Storage record and eviction

Keys are namespaced and never collide with per-tab keys:

```js
// ocrCache:<64-hex sha256>
{ v: 1, url, text, bytes, savedAt, lastUsedAt }

// ocrCacheIndex — array of { key, bytes, savedAt, lastUsedAt }
```

- `v` is a schema version. A record with a different `v`, a missing field, or a
  malformed index row is treated as a miss and pruned; it is never migrated.
- `bytes` is the UTF-8 byte length of `text` via the existing
  `encodedTextByteLength` helper.
- **Budget: `2_000_000` bytes of text total, and 50 entries.** Both bounds are
  enforced on write by evicting the oldest `lastUsedAt` first. The byte budget is the
  binding limit in practice; the entry cap only guards the pathological many-small-
  entries case. 2 MB keeps the cache a courteous share of `chrome.storage.local`
  next to `lastResult:<tabId>` (itself up to 1 MB per tab) and the operation
  checkpoints.
- A new entry whose `bytes` alone exceeds the budget is not written; the capture
  still publishes normally. With `MAX_PERSISTED_TEXT_BYTES` at 1,000,000 this is
  unreachable through a normal capture, so it guards only a future budget change.
- Pruning reads `ocrCacheIndex` and the records it names, never all of
  `chrome.storage.local`. `recoverPersistedOperations` already performs a `get(null)`
  at startup and must not gain megabyte-scale text scanning.
- Index and records are reconciled on write: an index row whose record is missing or malformed
  is dropped, and a record is always written before its index row, so an interrupted
  write leaves a record that a later read re-indexes instead of an index row pointing at
  nothing.
- On a hit, `lastUsedAt` is bumped in the record and the index in one `set` call.
  A failed bump is ignored; it only degrades eviction order.
- No `unlimitedStorage` permission is added.

## Failure policy

Caching never changes whether a capture succeeds.

- A lookup failure (read error, malformed index, malformed record, absent
  `chrome.storage.local`) is treated as a miss. The capture proceeds normally.
- A store or prune failure is logged once via a fixed message and does not affect the
  published result, `lastResult`, or automation.
- A quota error from `chrome.storage.local` is treated as cache-unavailable: log
  once, keep the fresh result, do not retry and do not attempt emergency eviction
  beyond the normal budget enforcement already applied before the write.
- Cache code never throws into `runCaptureLifecycle`.

## Invalidation

- Entries are removed only by LRU eviction, by an incompatible `v`, by index
  reconciliation, or by the user clearing extension storage.
- A new capture for the same URL with Force refresh replaces the entry on completion.
- A `Partial` capture leaves any existing entry untouched: it neither replaces a good
  entry nor is stored.
- Navigating a tab, closing a tab, or reloading the page does not affect entries;
  the cache is per page, not per tab.
- `resetState` does not clear the cache. It continues to clear only per-tab results.

## Testing

Node tests use the existing `localData` fake in `tests/background.test.js`; the fake
gains nothing new. All tests use fake providers and no live backend.

- **Lookup and publication:** a hit publishes without `captureVisibleTab`, without
  OCR, and without `/dedup`; `cacheHit` is `true`; progress carries the cache
  provenance text; `lastResult:<tabId>` is written; auto-format/auto-translate still
  run.
- **Force:** `force: true` in `popup:start` performs a full capture even when an entry
  exists, and the completed capture replaces the stored text.
- **Eligibility:** a `Partial` capture is not stored, does not overwrite an existing
  entry, and its result is never served from cache.
- **Keys:** the `#fragment` is dropped; scheme/host case and default ports are
  normalized; the query string and trailing slash are preserved; a `chrome://`,
  `file://`, and `view-source:` URL performs neither lookup nor store; two URLs
  differing only by query produce independent entries.
- **Eviction:** writing past 50 entries evicts the oldest `lastUsedAt`; writing past
  the byte budget evicts until it fits; a hit moves an entry to the newest position;
  an oversized single entry is skipped.
- **Resilience:** `chrome.storage.local.get` rejection degrades to a normal capture;
  `set` rejection still publishes and still writes `lastResult`; a malformed record
  is treated as a miss and pruned; a malformed index entry does not abort the prune.
- **Concurrency and lifecycle:** a second start while a hit is publishing is rejected
  by the existing in-flight guard; `Stop` during publication does not leave the popup
  in `Capturing`; a URL change between lookup and publish discards the hit and
  restarts once.
- **Popup (`tests/popup.test.js`):** the checkbox defaults to unchecked, sends
  `force: true` only when checked, resets to unchecked after a successful start, and
  is disabled while a capture is active.
- **Assets (`tests/test_extension_assets.py`):** the OCR panel keeps one `main`, four
  tabs with matching panels, the new checkbox has an associated label, and its `id`
  is referenced from `popup.js`.

## Documentation and delivery

- `README.md`: an OCR cache section covering URL-only identity, complete-captures-only
  eligibility, the 2 MB / 50-entry budget, local-only retention, Force refresh, and
  the fact that a hit makes no backend call.
- `CLAUDE.md`: one line under Key Files/Code Standards noting that OCR results are
  cached in `chrome.storage.local` keyed by normalized page URL, with Force refresh
  bypassing the lookup.
- `extension/manifest.json`: version bump to `2.2.0` for the feature.
- No backend, config, or prompt-file changes; no rollback hazard for the backend.
  Rolling back the extension leaves orphaned `ocrCache:*` keys in local storage,
  which are inert and removable by clearing extension data.

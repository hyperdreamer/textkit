# TextKit backend cache store — design

Date: 2026-10-20
Status: accepted, pending specification and implementation plan
Base: `b34ada3` (`main`), extension `2.1.3`
Supersedes: `2026-10-18-ocr-result-cache-design.md` (storage decision only)

## Background and goal

The approved 2026-10-18 OCR result cache design keeps complete capture results in
`chrome.storage.local`, keyed by the normalized page URL, bounded at 2,000,000 bytes
and 50 entries, with LRU eviction and **no TTL**. That design existed to avoid a
second backend store. Its own budget is the problem: 2 MB is roughly two long pages,
and it competes with per-tab result blobs that are themselves capped at 1 MB each.

The backend already owns a SQLite store for completed `/format` and `/translate`
results (`backend/transformation_cache.py` → `backend/transformation_cache.db`) with
a 30-day TTL and a 1000-row capacity bound. Disk-backed storage has no browser quota
and no meaningful size ceiling.

The goal is therefore twofold:

1. Move the OCR capture result cache out of `chrome.storage.local` and into the
   backend store, so cached capture results are limited by disk rather than by a
   10 MiB extension quota.
2. Put **all** cached entries under one expiration policy — one `enabled` switch, one
   `ttl_days`, one `max_entries` — with the operational shape YT2TXT uses: expired
   rows are deleted rather than ignored, expired rows are swept at startup, and a
   daily sweep runs at a fixed local hour.

Per-tab results (`lastResult:`, `tl2Result:`, `fmtResult:`), operation checkpoints,
prompt overrides, and UI state stay in `chrome.storage.local`. They are display state
and restart-recovery state, not cache; moving them would make a backend outage blank
the popup and would break the guarantee that an MV3 worker restart can resume an
operation without a live server.

## Scope and alternatives

Five decisions were made, each over an alternative:

1. **One module, two tables, schema version 2 — not a second module or a second
   file.** `transformation_cache.py` remains the single owner of SQLite, the 500 ms
   deadline budget, `BEGIN IMMEDIATE`, failure classification, and typed outcomes. It
   gains an `ocr_result_cache` table and two public operations. Rejected: a sibling
   `ocr_result_cache.db` (duplicates the engine); extracting a shared engine module
   first (the existing test suite monkeypatches `transformation_cache._open_connection`
   and `_monotonic`, so extraction churns a proven 280-test suite for no user-visible
   gain); a separate `ocr` operation inside the existing table (the schema validator
   pins the table SQL and its CHECK constraint token for token).
2. **In-place v1 → v2 migration — not "delete your database".** The module's documented
   rollback contract promises that an incompatible schema is never silently migrated,
   deleted, or recreated. A version bump that forced users to delete the file would
   break that promise in the one place it matters. Migration runs inside the same
   `BEGIN IMMEDIATE` transaction as the first maintenance pass, so it is atomic and a
   crash rolls it back.
3. **Backend-owned identity — not extension-side normalization.** The design's URL
   normalization and SHA-256 derivation move to Python. The extension sends the raw
   URL. One implementation, one fixture table, and a normalization change is a
   backend-only change.
4. **TTL — not LRU recency.** The 2026-10-18 design rejected TTL as "a second,
   redundant staleness mechanism" because the browser store had no time guarantee and
   needed capacity to bound growth. Disk storage plus a TTL removes both reasons: a
   time bound is what the user asked for, and it makes a hit a pure read instead of a
   read-modify-write recency bump.
5. **One body per request — two endpoints, not fields on `/ocr`.** `/ocr` receives one
   image and never sees the final published text: the extension assembles it from
   per-frame OCR and a dedup pass, and only it knows that a capture is complete. A
   store call from the extension is unavoidable, so a `page_url` field on `/ocr` would
   add nothing and would still need a store path.

Rejected wholesale: storing the URL itself in the row (breaks the "URLs are never
stored" invariant for no diagnostic value the extension cannot reproduce); a shared
cross-table capacity pool (one burst of OCR captures would evict every format entry);
keeping a browser-side fallback copy (dead weight, and a second identity
implementation).

## Cache identity

A capture key is the SHA-256 hex digest of the normalized page URL.

Normalization (backend, `_normalize_url`):

- Reject the URL if it is not a string, is empty, differs from its `strip()`ed form,
  has no scheme in `{http, https}` after lowercasing, or has an empty host. These are
  uncacheable: lookup reports a miss and store stores nothing.
- Lowercase the scheme and the host. `urllib.parse.urlsplit` already lowercases
  `.hostname`; the normalized string is rebuilt from `.hostname`, `.port`, and the
  preserved userinfo.
- Drop the port when it is the scheme default (`80` for `http`, `443` for `https`).
  Keep any other port verbatim.
- Drop the `#fragment`.
- Keep `.path` and `.query` exactly as parsed. An empty path stays empty, so
  `https://example.test` and `https://example.test/` are different keys, and percent
  encoding is never decoded or re-encoded.
- A URL whose port is syntactically invalid (`.port` raises `ValueError`) is
  uncacheable.

Nothing else enters the key: not the tab ID, window ID, selected region, autoscroll
state, prompt snapshot, backend host/port, or a timestamp. The key is stable across
tabs, windows, browser restarts, and backend restarts.

The stored row contains **no URL**. The digest is the only representation of the page.

## Identity of the cached value

The stored text is exactly the string `publishCaptureResult` publishes as the capture
result: the post-dedup `finalText`, not the raw merged fragments and not per-frame OCR
text. It is written from the same publication seam that handles a fresh capture, so
there is no second definition of "the result".

Automatic formatting and translation triggered by `autoFormatIfEnabled` /
`autoTranslateIfEnabled` are **not** part of the OCR row. They remain governed by
`/format` and `/translate` caching under their own request identity.

## Store schema and retention

Schema version 2 adds one table and one index to the existing database file:

```sql
CREATE TABLE ocr_result_cache (
    cache_key    TEXT NOT NULL PRIMARY KEY,
    output_text  TEXT NOT NULL,
    generated_at REAL NOT NULL CHECK (generated_at >= 0)
)

CREATE INDEX idx_ocr_result_cache_generation
    ON ocr_result_cache (generated_at ASC, cache_key ASC)
```

The existing `transformation_cache` table and `idx_transformation_cache_generation`
index are unchanged; their pinned column list and SQL tokens are unchanged.

### Migration

`_schema_state(connection)` classifies the file as `empty`, `v1`, or `v2`, and raises
the `schema` failure for anything else (unknown `user_version`, unrecognized
application objects).

- `empty` (version 0, no application objects): create both tables and both indexes,
  set `user_version=2`.
- `v1` (version 1, exactly the transformation table and its index): validate them
  exactly as today, then create the OCR table and index and set `user_version=2`, all
  inside the current `BEGIN IMMEDIATE` transaction. Every existing row survives and
  stays readable.
- `v2`: validate all four objects — both tables, both indexes, exact pinned columns
  and normalized SQL tokens.
- Any other version, or a version whose object set does not match: `schema` failure,
  file untouched, no migration attempted.

The connection preflight validates the same state without writing, so a `v1` file is
never rejected and never mutated outside a transaction.

### TTL

`cache.ttl_days` (default 30, range 1–3650) applies to both tables, measured from
`generated_at`, which is the store time of that row. Every read and every write
deletes rows whose `generated_at` is at or before `now - ttl_days * 86400`, in both
tables, inside its transaction. Expired rows are deleted, not merely ignored.

There is no per-operation TTL. `/format`, `/translate`, and OCR results expire under
the same rule, which is what "one policy for all cached entries" means.

### Capacity

`cache.max_entries` (default 1000, range 1–100 000) applies **per table**. After
expiry pruning, a table holding more rows than the bound loses its oldest
`generated_at` rows first, with `cache_key` ascending as the deterministic tie-break.
Per-table capacity means a burst of OCR captures cannot evict every format result.

### Scheduling

Two sweeps, following YT2TXT:

- **Startup.** The application lifespan runs one maintenance pass over both tables
  after configuration loads. A failure is logged once and does not prevent startup.
- **Daily.** The lifespan schedules a task that sleeps until the next 20:00 local
  time, then runs one maintenance pass, then repeats. The policy is re-read from
  configuration at each sweep, so an edited `ttl_days` takes effect without a restart.
  The task handles `asyncio.CancelledError` by returning, and the lifespan's `finally`
  cancels and awaits it before shutdown completes.

Per-request maintenance is unchanged: each `read`/`write` still prunes expiry and
enforces capacity for its own tables, so the scheduled sweeps are an idle-time
guarantee, not the correctness mechanism.

## HTTP contracts

Two POST endpoints, added after `/dedup` and before `/translate`. POST rather than GET
so a page URL never appears in an access-log query string.

### `POST /ocr-cache/lookup`

Request (strict, `extra="forbid"`):

```json
{"url": "https://example.test/page?x=1"}
```

- `url`: string, 1–8192 characters.

Responses:

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{"hit": true, "text": "...", "generated_at": 1697...}` | A non-expired row matched. No OCR, no provider call occurs. |
| 200 | `{"hit": false}` | Miss, uncacheable URL, disabled policy, or any cache failure. |
| 400 | `{"error": "..."}` | Body failed validation. |

`generated_at` is the stored UTC epoch seconds of the row and exists for observability
and tests. The extension does not display it.

### `POST /ocr-cache/store`

Request:

```json
{"url": "https://example.test/page?x=1", "text": "..."}
```

- `url`: as above.
- `text`: string of at most 1,000,000 characters and at most 1,000,000 UTF-8 bytes; the
  byte bound is checked explicitly because a character bound alone does not bound
  multi-byte text. A capture result larger than that is never produced under the
  extension's own 1,000,000-byte cap, so this is a failsafe.

Responses:

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{"stored": true}` | Row inserted or replaced. |
| 200 | `{"stored": false, "reason": "disabled"}` | Caching disabled; no storage work happened. |
| 200 | `{"stored": false, "reason": "uncacheable"}` | URL normalization rejected the URL, or `text` was empty. |
| 200 | `{"stored": false, "reason": "error"}` | Any storage failure or budget expiry. |
| 400 | `{"error": "..."}` | Body failed validation (including an oversized `text`). |
| 413 | `{"error": "Request body is too large"}` | The global body limit rejected it before parsing. |

A store for an existing key replaces the row and refreshes `generated_at`. That is the
Force refresh write path: after a forced recapture the entry holds the new text.

### Headers, limits, and inventory

Both endpoints set exactly one `X-TextKit-Cache` header: `hit`, `miss`, `disabled`, or
`error` for lookup; `stored`, `disabled`, `uncacheable`, or `error` for store. The
header is absent on a `400` or `413`, matching the existing rule that non-success
responses carry no cache header. The README sentence claiming that no endpoint other
than `/format` and `/translate` adds one is amended.

Neither endpoint is added to `_AI_ENDPOINTS`. They make no provider call, so the
per-minute rate and concurrency limits that protect paid calls do not apply; they are
bounded instead by the 2 MiB global body limit and the 500 ms cache budget.

`cache.enabled: false` short-circuits before any storage work: lookup answers
`{"hit": false}` with `disabled`, store answers `{"stored": false, "reason":
"disabled"}`, and neither touches SQLite. Existing rows in both tables are retained,
not erased, exactly as the transformation cache already behaves, and become reachable
again when caching is re-enabled. This mirrors the existing `_require_enabled`
contract; the cache module never expresses a "disabled" result.

## Extension flow

### Client module

`extension/ocr-cache.js` becomes a deep module with exactly one global binding,
`OcrCache`, exposing `lookup(endpoint, url)` and `store(endpoint, url, text)`. It owns
the request shape, JSON validation, the abort timeout, and the never-reject failure
policy. It reads no settings and constructs no endpoint.

- `lookup` resolves to `{ text }` only when the response is 2xx, parses as JSON,
  `hit === true`, and `text` is a non-empty string. Every other outcome — non-2xx,
  malformed JSON, `hit` false, timeout, transport error — resolves to `null`.
- `store` resolves to `true` only for a 2xx body with `stored === true`; every other
  outcome resolves to `false`.
- Both use a 1500 ms `AbortController` timeout. A hung backend delays capture start by
  at most 1.5 s and never blocks it.

`background.js` builds the endpoint with the existing memoized `getBackendEndpoint`,
so no new settings read is introduced.

### Start flow

One function, `startCaptureFlow(tabId, { force, startSelection })`, remains the single
entry point for the popup button and the keyboard command.

1. Claim the tab synchronously (`startInFlight`), so a second click cannot race a hit
   into publishing twice.
2. Read the live tab URL.
3. Unless `force` is set, look up the URL.
4. On a hit, publish inside `runCaptureLifecycle` with a fresh operation ID, after
   re-reading the live tab URL. If the live URL string differs from the URL the lookup
   used, discard the hit and restart from step 2, at most once (`attempt < 2`). A raw
   string comparison is deliberately stricter than normalized comparison: a
   fragment-only change looks like a navigation, and the resulting extra lookup is
   cheap and still hits.
5. On a miss, an uncacheable URL, or any failure, set `Selecting` and call
   `startSelection`.

### Hit publication

The hit publishes through `publishCaptureResult` with `status: 'Done'`,
`fragmentsCollected: 0`, `cacheHit: true`, `storeResult: false`, and the progress text
`Loaded page result from cache. Check Force refresh to capture again.` The provenance
text is required: an instant capture with no scrolling and no screenshots is otherwise
indistinguishable from a broken capture. `getPublicState` exposes `cacheHit`, so a
reopened popup still renders `Cached` after the progress line has been replaced by a
later automation message.

Post-capture automation runs unchanged through `canStartPostCaptureAutomation`, so a
hit still auto-copies, auto-saves, auto-formats, and auto-translates under the same
rules as a fresh capture.

### Miss publication

The only addition to the ordinary path is the store call inside `publishCaptureResult`,
made only when `status === 'Done'` and an endpoint is available. `Partial` and
`Cancelled` captures are never stored and never replace an existing entry.

### Popup control

Unchanged from the approved 2026-10-18 design: one `<input type="checkbox"
id="ocr-force-refresh">` in the OCR panel's existing `.option-row`, unchecked by
default, never persisted to `sync` storage, reset after a successful start, disabled
while a capture is active or the panel is `Selecting`, and sent as `force: true` only
when checked. The keyboard command always uses `force: false`. No visual mockup is
required because this control and its placement were approved in the superseded design
and are carried over without change.

## Failure policy

Caching never changes whether a capture succeeds.

- Lookup failure of any kind — timeout, transport error, non-2xx, malformed JSON,
  missing text, disabled policy, uncacheable URL — is an ordinary miss.
- Store failure of any kind is a silent skip. The published result, `lastResult`, and
  automation are unaffected.
- No cache error may propagate into `runCaptureLifecycle`, `publishCaptureResult`, a
  popup message handler, or a keyboard command handler.
- Backend-side, storage failures remain sanitized: callers receive a typed
  `unavailable` outcome with an allowlisted reason (`busy`, `timeout`, `permission`,
  `schema`, `corrupt`) and never see an exception, path, or SQL text.
- A `cache.db` file that is corrupt, unrecognized, or locked is bypassed for that
  request and never rewritten, deleted, or recreated.

## Privacy and rollback

- Rows hold the SHA-256 digest, the captured text, and `generated_at`. They do not hold
  the URL, prompt, credentials, tab ID, operation ID, or readable configuration. The
  digest remains the only representation of the page.
- Captured page text is therefore retained on local disk. This is a new retention
  surface relative to the superseded design, which kept it in browser storage.
- `backend/transformation_cache.db` and its `-wal`/`-shm` sidecars remain Git-ignored
  and must never be committed.
- Rolling the backend back: an older backend reads the file at version 2 as an
  unrecognized schema and bypasses it, leaving the file untouched. Deleting
  `ocr_result_cache` rows or the whole database is safe while the backend is stopped.
- Rolling the extension back: the feature never shipped, so no `ocrCache:*` keys exist
  in any browser profile. Nothing is orphaned.

## Testing

No test contacts a live backend or a paid provider.

### `tests/test_ocr_result_cache.py`

URL normalization fixture table (scheme/host case, default ports, fragment removal,
trailing slash, query preservation, percent encoding, IPv6 host, userinfo,
`chrome:`/`file:`/`about:`/`view-source:`/`data:`/unparseable/whitespace-padded) with
the expected normalized string or `None`; digest stability; round-trip store/read;
upsert replaces text and refreshes `generated_at`; expired row deleted on read and on
write; per-table capacity eviction order; disabled policy rejected before any storage
work; corrupt file, locked file, and deadline expiry each produce `unavailable` with an
allowlisted reason; oversized text rejected at the endpoint, not in the module.

### `tests/test_cache_schema_migration.py`

A `v1` file seeded with format and translate rows migrates to `v2` preserving every
row and every column value; the migrated file validates; `v2` validates both tables and
both indexes; a `v2` file with a missing or extra application object is rejected
without modification; an unknown `user_version` is rejected without modification; a
`v0` file containing foreign objects is rejected; a failure injected mid-migration
leaves the file at `v1` with its rows intact.

### `tests/test_ocr_cache_endpoints.py`

Both contracts including every status/body pair; `X-TextKit-Cache` values and its
absence on non-success; strict-field rejection; `text` over 1,000,000 bytes; disabled
policy performing no storage work; a storage failure mapping to `{"stored": false,
"reason": "error"}` with a 200; a forced `store` over an existing key; independence
from `_AI_ENDPOINTS` rate limiting.

### `tests/background.test.js`

A hit publishes without `captureVisibleTab`, OCR, or `/dedup`, sets `cacheHit`, writes
`lastResult`, and still runs auto-format and auto-translate; `force: true` performs a
full capture and stores the replacement; a `Partial` capture is neither stored nor
served; a `Partial` never overwrites an existing entry; a URL change between lookup and
publish discards the hit and restarts exactly once, with a test that fails if the
restart bound is removed; backend refusal, non-2xx, malformed JSON, and timeout each
degrade to an ordinary capture; a store failure still publishes and still writes
`lastResult`; a second start during a hit is rejected by the in-flight guard; `Stop`
during publication leaves no `Capturing` state.

### `tests/popup.test.js`

The checkbox defaults to unchecked, sends `force: true` only when checked, resets after
a successful start, is disabled while a capture is active or `Selecting`, and renders
`Cached` when `cacheHit` is true.

### `tests/test_extension_assets.py`

The OCR panel keeps one `main`, four tabs with matching panels, the new checkbox has an
associated label, and its `id` is referenced from `popup.js`.

## Documentation and delivery

- `README.md`: rewrite the cache section to cover both operations, the shared
  `enabled`/`ttl_days`/`max_entries` policy, the two sweeps, the new endpoints and
  their `X-TextKit-Cache` values, "URLs are never stored; captured page text is", and
  the amended header sentence.
- `README.md`: add the OCR cache section — URL-only identity, complete captures only,
  Force refresh, no provider call on a hit, disk-backed retention.
- `CLAUDE.md`: one line noting that all cached entries live in the backend SQLite store
  and expire under one TTL.
- `backend/config.example.yaml`: note that the existing `cache:` block governs OCR
  results too. No new keys.
- `extension/manifest.json`: version bump for the feature, applied to whatever `main`
  holds at implementation time.
- No prompt-file, provider, or file-bridge changes.

## Relationship to the 2026-10-18 artifacts

Preserved at `~/Ramdisk/ocr-result-cache/` from PM run `pm-run-20261018-164457-763f3e24`:

- **Reused unchanged:** the `publishCaptureResult` publication seam, `startCaptureFlow`,
  the `cacheHit` public-state field, the Force refresh control and its popup behaviour,
  `finalizeCapture`'s partial-reason logic, the restart-once structure, and the eight
  defect fixes recorded in that directory's `STATUS.md`.
- **Replaced:** `extension/ocr-cache.js` storage, index, budget, eviction, and
  reconciliation logic and its 821-line test file. Identity tests move to pytest.
- **Resolved from that run's open items:** the unbounded-restart mutant
  (`attempt < 2` without a failing test) is covered by an explicit test here, and the
  incomplete third design-review pass is replaced by a fresh review of this document.

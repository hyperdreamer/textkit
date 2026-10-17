# TextKit Transformation Cache — Technical Specification

**Date:** 2026-10-16  
**Status:** Implementation specification pending review and user sign-off  
**Design authority:** `docs/superpowers/specs/2026-10-16-transformation-cache-design.md`  
**Approved design digest:** `acb1a7728dd75ebbf09a56c6ea528dd76e0e51058bd91a7937ac501f884e7df1`  
**Delivery order:** TextKit first, then YT2TXT  
**Scope:** Formatting and translation result caching, whole-chain Force refresh, and explicit restart recovery

## 1. Purpose, scope, and module seams

This change adds a shared SQLite result cache to TextKit `POST /format` and
`POST /translate`. The cache belongs to TextKit because TextKit owns the
transformation pipeline, the effective prompt, the inherited text-provider
configuration, and the output-verification rules. YT2TXT remains responsible
for per-tab presentation, refresh propagation, persistence, and recovery of its
service-worker operation. OCR and Dedup are outside this change.

The implementation must preserve the approved behavior in the design document.
It must not add popup controls, move caching into the extension, cache provider
credentials, or introduce in-flight request merging. Force refresh is one
logical chain: a forced transcript request produces forced format and conditional
translation requests. A standalone format or translation action remains an
ordinary cacheable operation with `force: false`.

The main seam in TextKit is a new deep module, `backend/transformation_cache.py`.
Its small interface accepts an immutable policy snapshot, a cache key, and a
completed result, while hiding SQLite connections, schema validation, pruning,
permissions, contention, deadlines, and safe failure outcomes. Endpoint code
must not execute SQL or interpret SQLite exceptions. The module has an internal
seam for a clock and worker executor so tests can use deterministic time and
barriers without changing production behavior.

The second TextKit seam is the private execution outcome returned by the format
and translation pipelines. The public `format_text` and `translate_text` helpers
continue to return `OCRResponse`, so existing callers and tests retain their
public contract. Endpoint code calls private execution functions that return
`OCRResponse` plus cache eligibility and leaf-repair metadata. This keeps the
new policy local to the endpoint and preserves the depth of the existing public
helpers.

The main YT2TXT seam is a private per-tab operation-ownership module in
`extension/background.js` (it may be extracted to a classic-worker helper file
if that improves test isolation without changing the manifest contract). It
owns root tokens, stage tokens, controllers, closed-tab fencing, and guarded
publication. A separate per-tab serial storage-queue module hides queue
ordering, snapshots, stale-write rollback, and cleanup. Worker handlers call
these seams instead of manipulating `states`, controller maps, or storage
keys directly. The popup continues to use existing controls; it consumes a
reconciled state response from the worker before restoring saved values.

No application or test code is changed by this specification deliverable.
Implementation is a later step after independent specification review and user
sign-off.

## Requirement map

- `REQ-CACHE-IDENTITY` — Section 2.
- `REQ-CACHE-STORAGE` — Section 3.
- `REQ-CACHE-ENDPOINT` — Section 4.
- `REQ-OP-OWNERSHIP` — Section 5.
- `REQ-OP-RECOVERY` — Section 6.
- `REQ-VERIFICATION` — Section 8.
- `REQ-DELIVERY` — Section 7.

## 2. TextKit configuration, identity, and prompt resolution [REQ-CACHE-IDENTITY]

### 2.1 Strict cache policy

Add a `cache` field to `AppConfig` with a default `CachePolicy` value. The
policy model is frozen and forbids extra fields, consistent with `FrozenModel`
and the existing configuration models. Its exact fields and defaults are:

```yaml
cache:
  enabled: true
  ttl_days: 30
  max_entries: 1000
```

`enabled` accepts only a Boolean. `ttl_days` accepts only a non-Boolean integer
from 1 through 3650. `max_entries` accepts only a non-Boolean integer from 1
through 100000. Fractional numbers, numeric strings, `null`, zero, negative
values, and out-of-range values are configuration errors. An omitted cache
mapping or omitted individual field uses the defaults. A `cache: null` mapping
is invalid. The implementation may use Pydantic strict scalar types or
validators, but validation must reject Boolean values where integers are
expected; ordinary Pydantic coercion is insufficient.

The policy object is copied into each accepted request as an immutable request
snapshot. A request that has already resolved its policy keeps that snapshot
through provider execution and its eventual cache write. A later config-file
edit applies to the next request. Disabling caching prevents initialization,
maintenance, lookup, and writes for requests that observe the disabled policy;
it does not erase existing rows. Re-enabling caching applies the current TTL and
capacity at the next enabled access. Startup initialization and pruning are
best effort and occur only when the loaded policy is enabled.

### 2.2 Canonical cache identity

Define `CACHE_FORMAT_VERSION = 1` and independent initial revisions
`PIPELINE_REVISIONS = {"format": 1, "translate": 1}`. The operation revision
must be incremented whenever chunking, validation, joining, prompt semantics,
provider-call semantics, or another output-affecting behavior changes. A cache
format change, such as a changed serialization contract, increments the cache
format version. Neither a client operation ID nor Force changes a key.

Construct a canonical object before any cache lookup:

```json
{
  "cache_format_version": 1,
  "input_text": "exact request text",
  "max_tokens": null,
  "model": "effective text-provider model",
  "operation": "format",
  "pipeline_revision": 1,
  "prompt": "effective resolved prompt",
  "provider_endpoint": "effective text-provider endpoint"
}
```

For translation, add exactly one field, `language`, containing the already
validated language string. Do not include a `language` field for format. Encode
this object with `json.dumps(..., ensure_ascii=False, sort_keys=True,
separators=(",", ":"))`, then UTF-8 encode it and SHA-256 hash it. The stored
identity is the lowercase 64-character hexadecimal digest. The exact input
text is used: do not trim, normalize Unicode, collapse whitespace, or alter
line endings during key construction. `None` for `max_tokens` remains distinct
from an explicit integer. The endpoint and model are taken from the effective
configuration snapshot after `config.text` inheritance, not from the base values
before resolution. `provider_endpoint` is the exact final request URL
`f"{effective_ai.api_base}/v1/chat/completions"`, using the existing validated
`api_base` normalization. Do not add another normalization step when hashing;
the provider must execute against that same URL.

The following canonical UTF-8 bytes form a fixed digest vector. The input text
contains one LF; its JSON representation contains the two characters `\n`:

```json
{"cache_format_version":1,"input_text":"Hello\nworld","max_tokens":null,"model":"test-model","operation":"format","pipeline_revision":1,"prompt":"Format {verbatim}","provider_endpoint":"https://example.invalid/v1/chat/completions"}
```

The expected SHA-256 is
`c80b950b5bce10ffac6026037fe4649111381531b1f932892844fc43cab0e1ff`.

Resolve the effective `AIConfig`, the effective prompt, and the policy once.
Pass those immutable values to both key construction and the provider pipeline.
The existing `_resolve_ai_config` operation must therefore run once for each
endpoint request, and the private format/translation executors must accept the
resolved configuration rather than resolving it again. API keys remain lazy:
`_resolve_ai_api_key` is called only inside the provider-call path. A cache hit
must not require an environment variable or an otherwise unavailable key.

Prompt selection is explicit and must use a resolved-prompt value object or an
equivalent marker so that an already-resolved empty prompt is not replaced by a
fallback through a second truthiness check. A nonempty request prompt, including
whitespace-only text and literal `{language}`, is used verbatim and is never
template-rendered. An omitted, null, or empty-string prompt selects the
server-side default. Translation checks `translate.<ValidatedLanguage>.txt`
first and then `translate.txt`; format checks `format.txt`. Existing files are
stripped at the outside when loaded. An existing empty file is an explicit empty
prompt and stops fallback. If no selected file exists, use the built-in
failsafe. Only the server template path replaces the literal `{language}`
placeholder; unrelated braces remain unchanged. Prompt resolution is performed
off the event loop using the existing prompt-loading path.

The translation skip gate remains before prompt resolution and cache access.
After the existing text-size and prompt-size validation, a truthy request
prompt bypasses the gate. With a falsy prompt, `Original` and detected
same-language inputs retain the current skip response. Force does not bypass
this gate, and an empty request prompt remains different from a whitespace-only
override. A skipped response makes no cache attempt.

## 3. SQLite cache module [REQ-CACHE-STORAGE]

### 3.1 External interface and outcomes

`TransformationCache` exposes only these operations to endpoint/lifecycle code:

```python
async def initialize(policy: CachePolicy, now: float | None = None) -> CacheMaintenanceResult
async def read(key: str, policy: CachePolicy, now: float | None = None) -> CacheReadResult
async def write(key: str, record: CacheRecord, policy: CachePolicy,
               now: float | None = None) -> CacheWriteResult
```

`now` is an optional UTC epoch-second override used by tests; production uses
`time.time()` in the operation worker. The interface never exposes a connection,
SQL cursor, filesystem handle, or raw exception. `CacheRecord` contains only
`key`, `operation`, `text`, `model`, `generation_tokens`, and `generated_at`.
The caller supplies the key and the private eligibility decision; the module
must still reject malformed keys, unsupported operations, empty output, negative
tokens, and non-finite timestamps.

`CacheReadResult` has exactly one of `hit`, `miss`, or `unavailable`. A hit
contains the stored record. A miss means maintenance and lookup completed
successfully but no unexpired valid row matched. Unavailable carries only an
allowlisted reason: `busy`, `timeout`, `permission`, `schema`, or `corrupt`.
`CacheWriteResult` has `stored` or `unavailable` with the same reason set.
Initialization returns `ready` or `unavailable`, using the same allowlisted
reasons. Every `initialize` call performs schema validation plus expiry and
capacity maintenance, including calls on an already initialized database; it
never looks up a result. `read` performs schema setup/validation, maintenance,
and lookup in one operation. Startup and forced requests use `initialize`;
ordinary requests use `read` without a preceding initialization call. Each
operation has its own 500 ms budget. Cancellation is not converted to
`unavailable`; `asyncio.CancelledError` is re-raised.

A disabled policy never enters this interface. The endpoint handles disabled
policy directly and emits the disabled header value. The cache module is
therefore a deep module: callers learn only result statuses and record shape,
while storage behavior stays local.

### 3.2 Exact schema and validation

The database path is `backend/transformation_cache.db`; the `-wal` and `-shm`
sidecars are also ignored by Git. The database uses SQLite `user_version=1` and
this exact logical schema:

```sql
CREATE TABLE transformation_cache (
    cache_key TEXT NOT NULL PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN ('format', 'translate')),
    output_text TEXT NOT NULL,
    model TEXT NOT NULL,
    generation_tokens INTEGER NOT NULL CHECK (generation_tokens >= 0),
    generated_at REAL NOT NULL CHECK (generated_at >= 0)
);

CREATE INDEX idx_transformation_cache_generation
    ON transformation_cache (generated_at ASC, cache_key ASC);
```

A fresh empty version-0 database is initialized in one transaction: begin an
immediate transaction, create the table and index, set `PRAGMA user_version=1`,
and commit. An existing version-1 database is accepted only if the expected
table, columns, declared types, not-null flags, primary-key position, check
constraints, and expected index are present. The validator must reject extra
application tables or incompatible indexes/columns. It may ignore SQLite
internal metadata. A different `user_version`, unexpected existing tables, or
any incompatible schema returns `schema` and leaves the file untouched. The
module never deletes, recreates, or migrates an incompatible database.

Rows are validated on read. A malformed row is `corrupt`, not a miss. A write
uses parameterized SQL and validates the operation, key format, nonempty output,
model, nonnegative generation token count, and finite UTC timestamp before the
transaction. The record key must equal the separate key argument. Invalid
records return `unavailable/corrupt`. Eligible writes use an upsert: the last
successful committed write replaces every stored value for that key. Capture
`generated_at` when the provider pipeline and its eligibility decision finish,
before queueing the write; worker execution time is only the maintenance clock.
No prompt, input text, API key, authorization header, credential
hash, tab ID, URL, operation ID, or readable configuration is stored. The
identity digest is the only representation of the request.

### 3.3 Transaction, expiry, and capacity behavior

Every synchronous SQLite operation opens its own connection on the worker
thread, configures it, performs its complete transaction, commits or rolls back,
and closes it in a `finally` path. Connections are never shared between
threads and never held while a provider, settings, clipboard, or save operation
runs. Enable WAL for the database and use parameterized short transactions.
Both read and write operations use an immediate transaction because maintenance
and lookup/capacity decisions must be atomic across workers.

The operation receives its request's policy snapshot and a single UTC `now`.
Expiry is exact: delete rows where `now >= generated_at + ttl_days * 86400`,
which is equivalent to `generated_at <= now - ttl_days * 86400`. Reads do not
extend TTL. After expiry pruning, enforce `max_entries` across both operations.
If there are too many rows, delete the oldest `generated_at` values first, with
`cache_key` ascending as the deterministic tie-breaker. The same expiry and
capacity rules run in the read transaction, including a hit, and in the write
transaction, including a forced request. A lower capacity therefore applies on
the next enabled access; a longer TTL can retain rows still present but cannot
restore rows already removed.

A read/prune error makes caching unavailable for that request. The endpoint must
not attempt a later write after that result. A write/prune error does not change
the successful provider response; it changes the cache header to `error`. A
valid old row is never replaced by a failed or ineligible generation. A forced
request skips completed-result lookup after successful maintenance, but a
valid old row survives a degraded/error attempt except for ordinary expiry or
capacity pruning.

Set SQLite busy timeout to no more than 100 ms. The async caller has a 500 ms
absolute monotonic deadline beginning before queue submission, including worker
queue delay. Pass that deadline into the synchronous function. Use a SQLite
progress handler to interrupt SQL work when the deadline is reached and check
the deadline before opening, before mutation, and before commit. `wait_for` or
an equivalent wrapper bounds the caller wait, but cancellation cannot stop an
OS call already running in the worker. The worker still closes its connection
and honors the same deadline. A completed eligible write already issued may
finish after caller cancellation; an incomplete provider pipeline is never
submitted to the cache. Do not add an indefinitely waiting async cache lock.

On POSIX, pre-create a new main database with `os.open(..., O_CREAT|O_EXCL,
0o600)` before SQLite can create journals. For an existing database or sidecar,
require a regular, nonsymlink file owned by the backend user and establish mode
0600 without changing the process umask or repository-directory permissions.
If the main file or a present sidecar cannot meet these conditions, return
`permission`. Verify sidecar modes after a real WAL write in tests. Shutdown has
no persistent cache connection or cache task to stop.

All cache failures, including startup, schema, pruning, read, write, and
cleanup failures, log one fixed event with only an allowlisted reason. Do not
log SQL parameters, identity digests, prompts, text, credentials, paths beyond
the fixed event classification, or raw exception messages/tracebacks. Logical
expiry and eviction are not secure erasure; documentation must explain local
output retention, disabled-cache retention, and sidecar/backup limits.

## 4. Endpoint execution and eligibility [REQ-CACHE-ENDPOINT]

Add `force: bool = False` to `FormatRequest` and `TranslateRequest`. Keep
`extra="forbid"`, existing required fields, existing error payloads, and the
existing translation skip fields. The request flow is exact:

1. Middleware performs body-size, admission/rate/concurrency, and operation-ID
   checks. These checks run even when a cache hit is possible.
2. The endpoint loads validated config, rejects missing AI configuration,
   validates text size and optional prompt size, and applies the translation
   skip gate.
3. The endpoint resolves effective provider settings, effective prompt, and
   current cache policy once; it constructs the canonical key from that
   snapshot.
4. If caching is enabled and `force` is false, call `read` for schema validation,
   maintenance, and lookup. Return a hit immediately. If enabled and forced,
   call `initialize` for schema validation and maintenance only; no lookup is
   performed. Either operation returning `unavailable` disables all later cache
   work for this request and selects the `error` header on provider success.
5. Otherwise it runs the existing verified pipeline with the same resolved
   settings and prompt.
6. If the response is successful and eligible, it writes the completed result
   under the key and returns the normal JSON shape. A write failure still
   returns success.

A cache hit returns the stored output and provider-reported model, but
`tokens_used` is exactly zero because this request made no provider calls. The
stored `generation_tokens` remains available only inside the row and is never
used as the hit's usage value. A hit does not resolve an API key. Force bypasses
only the TextKit completed-result lookup; it does not bypass admission, input
validation, prompt resolution, provider idempotency, or the translation skip
gate. Existing provider chunk idempotency remains keyed by caller operation ID,
operation, and chunk digest. A new logical fresh attempt needs a new operation
ID; Force is not added to that provider key.

Use one `X-TextKit-Cache` header on successful format/translation responses,
with this first-match precedence:

| Condition | Header |
| --- | --- |
| Translation returned by the existing skip gate | `skipped` |
| Request policy disabled caching | `disabled` |
| Fresh completed row returned | `hit` |
| Any attempted cache operation failed or timed out | `error` |
| Result is empty or known degraded | `uncacheable` |
| Forced eligible result was stored | `refresh` |
| Ordinary eligible miss was stored | `miss` |

Non-success responses, including provider errors, have no cache header. The
header is added only to `/format` and `/translate`; no CORS change is needed.
A skipped translation response preserves its current JSON fields and receives
`skipped` even though it never resolves a prompt or touches the cache.

The private outcome must distinguish accepted output from degraded output. A
format leaf is accepted only when it is not cut off and passes
`_content_preserved`; a translation leaf is accepted only when it is not cut
off and passes `_translation_looks_complete`. Recursive repair returns a leaf
or aggregate outcome containing text, accepted status, and a degraded/fallback
flag. A failed parent that is fully repaired by accepted children does not make
the final result degraded. Any source-text floor at a minimum chunk, any final
join fallback, any failed acceptance that emits source text, an empty final
result, or an error makes the response uncacheable. An unchanged but fully
accepted format result is eligible; comparing output with input is not an
eligibility test. The public helpers continue to discard private metadata and
return `OCRResponse`.

If a forced eligible result stores successfully, use `refresh`; if an ordinary
eligible result stores successfully, use `miss`. If the provider succeeds but
output is empty/degraded, use `uncacheable` and do not write. If maintenance
failed before provider execution, skip all later cache work and use `error` even
if the provider succeeds. If a valid forced generation is ineligible or fails,
leave an unexpired old row intact; normal maintenance may still prune it.

## 5. YT2TXT ownership and refresh propagation [REQ-OP-OWNERSHIP]

Introduce an immutable operation context for every accepted root:

```js
{
  tabId,
  rootId,
  url,
  force,
  stageId,
  controller,
  signal
}
```

`force` is captured only as `msg.force === true` when a transcript root is
accepted. The context is not reread from popup state or storage during the
chain. Internal transcript-to-format and format-to-translation handoffs inherit
the root ID, URL, and force value. Standalone Format, standalone Translate,
and keyboard-triggered ordinary work use `force: false` unless the action is a
dedicated retry of a persisted record. Force never enables translation and
never changes its language.

Build TextKit request bodies from the context. Omit `force` when false; include
`"force": true` only for a forced format or translation request. Ordinary
requests therefore remain compatible with an older TextKit that does not know
the new field. A forced request sent to an old TextKit may receive its ordinary
validation error; the worker surfaces that error and never silently retries
without Force.

The ownership interface has these operations: `claimRoot(tabId, details)`,
`claimStage(root, stage)`, `isCurrent(context)`, `invalidate(tabId, reason)`,
`invalidateStage(context)`, `markClosed(tabId)`, and `releaseStage(context)`.
`isCurrent` checks the live root token, the live stage token/controller, the
controller signal, and the closed-tab set. It must not call a state-creating
`getState` on a stale path. A non-current operation cannot create state, update
activity markers, publish a result, launch a handoff, or issue a copy/save
effect.

The state consequences are fixed:

| Event | Required result |
| --- | --- |
| Transcript while transcript extraction is active | Reject as today; do not replace it |
| Accepted transcript request | New root; abort/supersede downstream work; preserve completed text and persistence while extraction runs. |
| Successful transcript publication by the current root | Publish new transcript provenance and initial format record; clear obsolete downstream results at this point. |
| Standalone Format/Translate or explicit retry | New root and stage; abort older tab work; force false unless retry provenance says true |
| Transcript to Format to Translate | Inherit the live root and force; register successor before retiring predecessor |
| Transcript Stop | Invalidate root, abort stages, mark stopped, reconcile storage |
| Format/Translate Stop | Invalidate the root owned by that active stage; absent/stale stage is a no-op |
| Tab close | Fence the tab for the worker lifetime, abort, delete state and all tab persistence |

Root acceptance happens before the transcript backend request; successful
publication happens only after a valid response and a current-ownership check.
Transcript failure or Stop preserves previously completed text for display and
leaves the operation idle with its error/stopped status. It never installs new
raw text, Force provenance, or a format record. Superseded running downstream
records are made terminal through the queue when the new root is accepted, so
failure of the replacement cannot revive them on restart.

Stop handlers synchronously invalidate the matching ownership token before
any await. This change explicitly replaces the old synchronous Stop
acknowledgment: `popup:stop`, `format:stop`, and `translate:stop` respond
`{ok:true}` only after queued stale-write repair, terminal-marker persistence,
and operation/activity cleanup finish. The listener returns `true` to retain
the response channel and holds keepalive through cleanup. A storage failure
returns `{ok:false,error}` while the operation remains invalidated; it cannot
claim durable Stop success. An absent or stale owned stage is a no-op and
cannot stop a replacement root.

Guard after response parsing, endpoint/settings reads, every storage await,
copy/save setup, and before every broadcast, handoff, notification, or effect.
Catch and finally blocks must also check ownership before changing state or
markers. `autoTranslate` reads its enabled flag and language in one
`chrome.storage.sync.get` call, then checks ownership both after the read and
immediately before starting inherited translation. Keepalive remains held for
the root chain until a successor stage is registered. A stage finalizer may
remove only its own controller/keepalive registration.

Auto-copy and auto-save helpers accept the operation context. They check
ownership before settings access, after settings access, immediately before
clipboard/offscreen dispatch or save fetch, and after the awaited save response.
Save fetches use the stage signal where possible. A dispatched clipboard or
save operation cannot be undone; stale completion and error notifications are
suppressed, and invalidated work cannot issue a later effect.

## 6. Persisted operation records and recovery [REQ-OP-RECOVERY]

Existing keys remain in use: `transcript:<tabId>` stores `{text,url}` in its
current shape, `transcript_raw:<tabId>` stores the raw transcript string,
`fmtResult:<tabId>` stores formatted text, `translate:result:<tabId>` stores
translation text, and `tl2Translating:<tabId>` is the transient activity marker.
Add `transcript_force:<tabId>` and `transcript_recovery:<tabId>`. The force key
is Boolean and is written/removed with the raw transcript; absent legacy data
means false. The recovery discriminator is a small object:

```json
{"version":1,"rootId":"uuid","terminal":"available"}
```

`rootId` identifies the owning operation generation. `terminal` is `available`,
`stopped`, or `completed`. Every new downstream root installs its running record
and its own `available` marker together. Terminal writes retain that root ID,
allowing reconciliation to distinguish a tombstone for an old root from a
newer record. Raw transcript data can remain after terminal cleanup.

Add one versioned record at `transform:operation:<tabId>`:

```json
{
  "version": 1,
  "rootId": "uuid",
  "stageId": "uuid",
  "tabId": 17,
  "stage": "format",
  "status": "running",
  "sourceText": "text used by this stage",
  "sourceUrl": "owned tab URL",
  "sourceKind": "transcript",
  "language": null,
  "force": true,
  "error": ""
}
```

For translation, `stage` is `translate`, `language` is the validated selected
language, and `sourceText` is the exact stage input. `sourceKind` is one of
`transcript`, `format`, or `standalone`: automatic format uses `transcript`,
automatic translation uses `format`, and both standalone actions use
`standalone`. A retry retains the saved source kind.
`sourceUrl` is retained for the existing tab/URL ownership
check. `status` is `running` or `failed`; a failure retains its source,
language, Force, IDs, and error for explicit retry. Unknown versions, malformed
records, wrong tab IDs, unsupported languages, empty source text, and URL
mismatches are ignored or rejected with a usable status and no provider work.

All successful transcript publication fields are written through one per-tab
storage-queue action after ownership is rechecked: transcript result, raw
transcript, force Boolean, the root-owned `transcript_recovery:available`
marker, and the initial format operation record. Group these fields in one
`chrome.storage.local.set` call. The same ordered queue action removes obsolete
format/translation results and transient markers before launching format.
Claim the successor's stage token/controller before persisting its running
record; retain the predecessor registration until the queued publication
completes. Reconciliation therefore never sees a current running record whose
stage is still waiting to be registered. Failed publication prevents the
successor provider call. A successful new transcript cannot leave an old chain
looking current.

Operation transitions are:

| Event | Record and key transition |
| --- | --- |
| Accepted transcript request | Supersede older running records; preserve previous completed results while extracting. |
| Successful transcript publication | Publish transcript/raw/force/root-owned recovery and running format record together; clear old results. |
| Standalone action | New running record and matching available marker, Force false; retain prior completed result until replacement succeeds. |
| Explicit retry | New IDs; reuse validated saved source, language, Force, and URL. |
| Stage success | Publish stage result; register successor record before handoff, or remove record at terminal success. |
| Provider failure | Mark current record failed; retain provenance and prior result. |
| Stop | Invalidate first, remove operation/activity markers, mark recovery stopped, retain raw transcript. |
| Replacement or tab close | Invalidate first; replacement installs its new record, while close deletes all tab keys/state. |

The queue is a promise chain per tab. Ownership invalidation happens
synchronously before enqueueing any cleanup or replacement. Each queued write
captures the prior values for its affected keys, performs the storage write,
then checks the ownership token. If the operation became stale during the
storage await, it restores the captured values in the same queue before any
new work, recovery read, or cleanup proceeds. Restoration is conditional on
those keys still containing the stale values, so the queue preserves the last
accepted value. New work waits behind this repair. The queue is never held over
provider, settings, clipboard, or save work. Cleanup/terminalization actions are
authorized by the invalidating tab generation rather than the aborted stage's
signal; closing a tab authorizes deletion despite its closed fence. Such an
action must not touch a newer root's keys. A rejected queue action must not
poison the promise chain and prevent later reconciliation or cleanup.

A format or translation record remains present through its provider result and
its automatic copy/save/handoff activity. A format success writes
`fmtResult:<tabId>` and, if auto-translation is enabled, replaces the format
record with a translation record before handing off, using the same successor
registration/publication ordering. If auto-translation is
disabled or resolves to `Original`, it completes the chain and removes the
record after effects. A translation success writes its result and removes the
record after its automatic effects. Provider failure updates the record to
`failed`; Stop invalidates the root, writes its `stopped` marker, then removes
the active record/marker while retaining raw transcript content. A successful
chain writes its root-owned `completed` marker after effects and before final
cleanup. These steps share the per-tab queue. If the worker dies between a
terminal write and record removal, the matching tombstone still wins.

`popup:get-state` is a reconciliation operation. The worker obtains the live
tab, checks the closed-tab fence, then reads all record, raw, force, saved
result, recovery, and activity keys through the same queue. Preserve a live
transcript stage's in-memory activity even though it has no downstream record;
recheck current ownership after the tab query and every queue await. Reconciliation
uses this precedence:

1. A present malformed/unknown operation record produces a safe idle status
   and no retry; it must never fall through to legacy raw recovery.
2. A valid record with a matching-root `stopped` or `completed` marker is
   terminal. Suppress retry, clear orphan record/activity keys, and retain
   completed results. This applies even if record cleanup was interrupted.
3. Otherwise a valid record matching a live root/stage is active. Without
   matching live ownership, a running record becomes interrupted/failed and
   retryable, with idle controllers and a clear message. Failed records remain
   retryable. A terminal marker belonging to a different root cannot suppress
   this record. Clear orphan `tl2Translating` markers.
4. With no record, a stopped/completed marker suppresses raw recovery; an
   unknown/malformed marker gives a safe idle status and also suppresses it.
   Only absent markers (genuine legacy data) or a valid `available` marker
   allow raw format recovery, and only if no completed format result exists.
   Read raw and force together; absent legacy force means false.

Recovery performs no provider work, copy, save, or automatic translation.
Existing saved results may remain visible beside a retryable record.

The response contains one fully hydrated state with all restoration text and
activity flags; popup initialization does not read operation/result/activity
keys independently and never writes or removes worker-owned markers. Register
broadcast listeners before requesting the snapshot. A popup-local generation
counter advances on every relevant background event and local start/stop/retry
command. Capture it before the request and check it after each initialization
await. Discard a snapshot if the counter or current tab changed while awaiting
it; request a fresh snapshot when restoration is still needed. Full state
broadcasts identify their tab and current root/stage. Partial result/activity
messages must carry those IDs and may apply only to the latest matching full
state. A full update for a newer root replaces the previous view. This prevents
a delayed initial response or partial event from overwriting newer state.

The hydrated state includes `format.retry` and `translate.retry`, each null or
a descriptor. Versioned-record descriptors contain `kind: "record"`, `rootId`,
and `stageId`; translation also includes the saved language. A legacy format
descriptor is `{kind: "legacy"}`. It includes current ownership IDs for active
stage controls as well. The popup enables the existing retry control from
these descriptors even when its current textarea is empty. Stop messages
include the displayed stage ownership IDs; the worker rejects a stale target.

The Format Transcript retry row sends `format:retry` with its descriptor; the
Translation button sends `translate:retry` with its descriptor. The worker
reconciles and validates that it still names the saved operation before
claiming a new root/stage. It uses saved source, language, Force, and URL, rather
than the current textarea or global settings. Legacy retry must still satisfy
the raw-recovery gate. Ordinary Format/Translate messages retain their existing
payloads and use current text/settings with Force false.

## 7. Files, deployment, compatibility, and privacy [REQ-DELIVERY]

TextKit files affected or added are:

- `backend/transformation_cache.py`: cache policy-independent SQLite module,
  outcome types, schema validation, deadlines, permissions, pruning, and safe
  logging.
- `backend/main.py`: strict `CachePolicy`, request `force` fields, immutable
  execution snapshot, private eligibility outcomes, endpoint ordering, headers,
  and public-helper wrappers.
- `backend/config.example.yaml`: documented cache defaults.
- `.gitignore`: database and `-wal`/`-shm` sidecars.
- `README.md`: configuration, cache headers, retention/privacy, and rollback.
- Existing TextKit cache/pipeline test files plus focused cache endpoint tests,
  using temporary paths and disabled/isolated caches.

YT2TXT files affected or added are:

- `extension/background.js`: ownership integration, force propagation, operation
  records, guarded handoffs/effects, reconciliation, and queue calls.
- `extension/popup.js`: render hydrated reconciled state with guarded initialization,
  remove orphan-marker resurrection and popup writes to worker-owned keys, and
  select existing retry controls from recovered state.
- `README.md`: whole-chain Force refresh, manual retry, and deployment order.
- If extraction is used for testability, a classic-worker helper such as
  `extension/operation_ownership.js` and/or `extension/storage_queue.js` may be
  added and loaded by the existing worker without changing popup layout or
  introducing a new runtime dependency.

The application adds no runtime package; SQLite, `asyncio`, `hashlib`, and
existing configuration/runtime libraries are sufficient. Deploy the updated
TextKit backend first, then YT2TXT. Ordinary consumer requests omit Force and
remain compatible with the old TextKit. Forced requests require the updated
TextKit and surface its normal error if an older backend rejects the field.
Rolling back TextKit requires removing the new `cache` stanza because the old
configuration model rejects unknown fields. The transformation database may be
retained as local data or removed with the backend stopped; it is never
silently migrated or recreated by an older version. Rolling back YT2TXT leaves
new storage keys harmlessly ignored by the old popup/worker.

The cache is local shared storage, not an account or credential partition. A
credential rotation alone does not invalidate rows. Output text is stored on
disk. The key digest represents request input, effective prompt, and execution
settings; credentials and credential-derived values are excluded entirely.
Disabling caching retains existing rows. Expiry and capacity
eviction remove logical availability but do not promise physical erasure or
file shrinkage; manual removal must include WAL/SHM sidecars with the backend
stopped, and backups may retain old output.

## 8. Verification matrix and commands [REQ-VERIFICATION]

All tests use temporary databases/config/prompts, a fake UTC clock and provider,
deterministic async barriers, and no paid calls. Existing pipeline suites use
isolated or disabled caching unless explicitly testing it.

TextKit test responsibilities:

- `tests/test_transformation_cache.py`: strict policy, key bytes/revisions,
schema/version, expiry boundary, capacity ties, policy edits, disabled retention,
permissions, safe errors, independent handles, contention/deadline/cancellation,
and event-loop responsiveness.
- `tests/test_format_pipeline.py` and `tests/test_translate_pipeline.py`:
public `OCRResponse` contract; accepted unchanged output; fully repaired,
source-floor, empty, and final-fallback cases. Use the known `safe_chars=400`
repaired fixture and `safe_chars=120` degraded fixture.
- `tests/test_transformation_endpoints.py`: ordering/admission, credential-free
hits, zero hit tokens and saved model, Force/idempotency, skip/JSON behavior, and
all header precedence.
- `tests/test_prompt_snapshot.py`: override truthiness, empty request/file,
language precedence, template substitution, mid-request edits, and effective-key
changes.

```sh
cd <TextKit-integration-root>
python -m pytest -q tests/test_transformation_cache.py tests/test_transformation_endpoints.py tests/test_prompt_snapshot.py tests/test_format_pipeline.py tests/test_translate_pipeline.py
```

YT2TXT tests load the actual worker and popup with fake Chrome APIs and fake
backends. Use Node's built-in test runner for worker cases and the existing
Chromium harness (or a temporary real profile) for popup cases.

- `tests/operation_lifecycle.test.js`: replacement, Stop/close,
keepalive handoff, post-await guards, durable Stop acknowledgments, and no stale
publication/effects. Verify transcript failure/Stop preserves prior completed
results and publishes no new provenance; successful publication clears them.
- `tests/storage_reconciliation.test.js`: stale-write barrier and
rollback ordering, grouped transcript/force, matching-root terminal precedence,
newer-root recovery despite an older marker, corrupt-record suppression of
legacy fallback, orphan activity, URL ownership, and restart between terminal
write and record cleanup. Stop before the first format result must suppress
legacy raw/force retry after restart.
- `tests/popup_recovery.test.js`: worker/popup reopen, interrupted or
failed work, legacy/stopped/completed recovery, forced-to-ordinary replacement,
Original, auto-translation off, saved results, empty-textarea saved-source retry,
and delayed initial response after a newer event or command.
- `tests/force_propagation.test.js`: exact bodies for forced chains,
ordinary/keyboard/standalone actions, and provenance-based retries.

```sh
cd <YT2TXT-integration-root>
node --test tests/background.test.js tests/popup.test.js tests/operation_lifecycle.test.js tests/storage_reconciliation.test.js tests/popup_recovery.test.js tests/force_propagation.test.js
```

Suspend response parsing, storage writes, settings reads, copy setup, and save
responses independently. Interleave Stop, replacement, close, and new work at
each barrier; assert stale work cannot publish, recreate state, overwrite
accepted persistence, resurrect activity, or launch effects. Cache hits use the
same accepted publication path as misses.

Mutation probes must fail if key construction drops input Unicode, effective
prompt/provider settings, max-token distinction, language, format version, or
pipeline revision; Force is ignored; degraded/empty output becomes eligible; a
repair loses leaf metadata; a post-await ownership guard or stale-write rollback
is removed; an orphan marker controls popup state; or retry omits saved source,
language, or Force. Verify behavior through module seams, not implementation
line structure.

## 9. Unresolved issues

None. The accepted design supplies the required policy, storage, endpoint,
ownership, recovery, deployment, and privacy decisions. Any implementation
choice that does not alter those contracts may be resolved locally during
implementation and documented in the resulting code review.

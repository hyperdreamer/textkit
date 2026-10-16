# TextKit formatting and translation result cache — design

Date: 2026-10-16
Status: Shared cache, whole-chain refresh, and manual restart recovery accepted;
revised after independent design review
Delivery repositories: TextKit (cache) and YT2TXT (refresh propagation)
TextKit base: `c47dec6a24b42bcdb25f2c4fbe731deca8ce4431`
YT2TXT base: `b46b8fb29343f8b361a8b1024a7b9bbaee907b52`

## Background and goal

YT2TXT caches extracted transcripts, but a transcript-cache hit still starts
formatting and, when enabled, translation. Per-tab saved output restores the
popup; it does not avoid repeated TextKit operations. The user selected a shared
TextKit result cache because TextKit owns the transformation pipelines, effective
prompts, and provider configuration. Identical completed transformations can then
be reused by any client of that backend.

The user also selected whole-chain Force refresh and manual recovery after a
service-worker restart. Refresh applies to one transcript and its automatic
formatting/translation descendants. Recovery waits for an explicit user action.

## Scope and alternatives

Add caching to TextKit `POST /format` and `POST /translate`. OCR and Dedup retain
their current behavior. Implement YT2TXT refresh propagation as a coordinated
consumer change, delivered after TextKit. Keep existing per-tab result storage,
auto-copy, auto-save, and conditional translation on every accepted completion,
including a cache hit.

The alternatives were an extension cache, which cannot reliably observe server
prompt/configuration changes and benefits only one browser, and a YT2TXT backend
cache, which would put transformation ownership in the transcript backend.

No new popup controls or layout changes are required. Manual recovery uses the
existing Format Transcript retry row and the Translation action button. After
interruption, the latter can read “Retry translation”; status text explains the
interruption. These are states of existing controls, so separate layout mockups
are unnecessary.

## Cache identity and immutable execution settings

Hash a deterministic serialization of the following with SHA-256:

- Cache-format version and operation-specific pipeline revision.
- Operation: format or translate.
- Exact input text, including whitespace and Unicode representation.
- Translation language as returned by the existing request validator; no language
  field for format.
- Effective system prompt actually supplied to the pipeline.
- Effective text-provider endpoint, requested model, and `max_tokens` (including
  the distinction between unset and an explicit cap).

Resolve the endpoint handler's validated application configuration once, including
its cache policy. Resolve inherited `ai.text` settings and the prompt once before
cache lookup. Use that same immutable execution snapshot for the key and every
initial/recursive provider call. Concurrent file edits affect later requests.
Credentials remain lazily resolved at provider-call time under existing rules.

Never persist API keys, authorization headers, credential-derived hashes, input
text, or readable prompts in cache records. The identity digest is sufficient.
Credentials and timeouts do not change identity. This is a shared cache within one
local backend, without account partitioning; credential rotation alone does not
invalidate entries. A hit may succeed when configured credential references are
unavailable, because no provider call is needed. Missing `ai` configuration and
ordinary input/admission failures still fail before lookup.

Any change to chunking, validation, joining, or other output-affecting operation
semantics requires that operation's pipeline-revision bump. Request operation IDs,
client identity, tab/video IDs, timestamps, and cache-busting query parameters are
excluded from identity.

## Exact prompt behavior

Preserve the current public request behavior:

1. A request `prompt` that is any nonempty string is used verbatim, including
   whitespace-only strings and literal `{language}`. The backend does not render
   placeholders in request overrides.
2. An omitted, null, or empty-string request prompt selects the backend default.
   For translation, try `translate.{ValidatedLanguage}.txt` before `translate.txt`.
   For format, try `format.txt`.
3. Existing file loading strips outer whitespace. An existing empty file is an
   explicit empty prompt; it does not fall through to another file or failsafe.
4. If no selected file exists, use the matching built-in failsafe.
5. Render the selected server template using only literal `{language}` replacement
   with the validated translation language, or the empty string for format.
   Preserve unrelated braces.

An internal resolved-prompt argument must distinguish “already resolved, empty”
from “resolve a default now”; it must never apply truthiness fallback a second
time. Both public pipelines and cached endpoint execution must share the same
resolution rules. Editing an overridden server prompt does not invalidate a
request whose effective override is unchanged.

Keep the existing translation skip gate before prompt resolution/cache access:
a truthy request override bypasses that gate; otherwise Original or detected
same-language input returns the existing skip response. Force does not bypass the
gate. This retains current behavior, including empty versus whitespace overrides.

## Storage module and configuration

Use a dedicated SQLite cache module with a small interface for reading and storing
completed results under a supplied key/policy. Hide connection ownership, schema,
pruning, contention, permissions, and safe failure outcomes behind that interface.
Use Python's standard library; add no runtime dependency.

Database: `backend/transformation_cache.db`. Ignore it and its `-wal`/`-shm`
sidecars in Git. Defaults apply when the cache stanza or individual fields are
omitted:

```yaml
cache:
  enabled: true
  ttl_days: 30
  max_entries: 1000
```

`enabled` is a Boolean; `ttl_days` is an integer from 1 through 3650;
`max_entries` is an integer from 1 through 100000. Zero, negative, fractional,
Boolean-as-integer, null, and out-of-range numeric settings are invalid, under the
existing configuration error behavior. Use `enabled: false` to disable caching.

TTL is measured from verified generation completion in UTC epoch seconds. An entry
is expired when `now >= generated_at + ttl_days * 86400`. Reads do not extend TTL.
Each enabled cache transaction prunes expired entries using its request's policy
and enforces capacity by evicting oldest generation timestamps first, with the
identity digest as a deterministic tie-breaker. Capacity is shared by both
operations. The read/prune transaction and write/prune transaction each apply
these rules atomically across workers.

Policy edits affect the next request snapshot: shortening TTL can immediately
expire older rows at its next access; increasing TTL can retain rows still
present but cannot restore deleted rows. A lower capacity takes effect at the
next enabled access, even if it is a hit or forced request. Existing in-flight
requests retain their policy snapshot, including write/prune policy; therefore an
older in-flight write can temporarily restore a larger capacity until the next
access under the newer policy. No persistent global policy authority is added.

Disabling caching performs no database initialization, reads, writes, or pruning
for requests that observe it; it does not erase existing data. Already-started
requests retain their prior policy. Re-enabling applies current TTL/capacity on
the next access. Startup performs best-effort initialization/pruning only when
enabled. There is no background maintenance scheduler in this version.

Rows contain the identity digest, operation, output text, provider-reported model,
original generation token usage, and generation timestamp. Use a schema version
separate from key/pipeline versions: SQLite `user_version=1`. Initialize an empty
version-0 database transactionally. Unexpected existing tables, a different schema
version, or incompatible columns disable cache use for that attempt without
recreating, deleting, or migrating the database. A later operation retries safely,
so repairing permissions, releasing a lock, or replacing a corrupt file restores
cache availability without restarting the backend.

## SQLite ownership, bounded work, and privacy

Each synchronous cache operation opens, uses, commits/rolls back, and closes its
own connection on the same worker thread, including every error path. No connection
is shared between threads or held during provider calls. Startup follows the same
operation path; shutdown has no long-lived cache connection or cache task to stop.
Separate backend workers share completed rows through SQLite WAL and short,
parameterized transactions. Simultaneous misses may call the provider separately;
there is no in-flight job merging. Last successful committed write wins for the
same identity. Generation failure never replaces a good row, subject to ordinary
expiry/eviction.

Bound lock contention with a busy timeout of at most 100 ms, SQL work with a
monotonic progress-handler deadline, and each awaited cache operation with a
500 ms caller budget, including worker-queue delay. Run all file/SQLite work off
the event loop. The synchronous operation receives that same deadline and checks
it before mutation/commit. Do not add an indefinitely waiting async cache lock or
hold a transaction across network/settings awaits. A caller timeout or
cancellation cannot terminate an operating-system call already running in a
thread; its connection still closes and its local deadline remains in force.
These bounds cover caller waiting and ordinary local SQLite contention, not a
hard real-time guarantee for a stalled filesystem. A completed, eligible write
already issued may finish after caller cancellation; an incomplete pipeline is
never submitted for storage. Propagate cancellation rather than swallowing it as
an ordinary cache error.

On POSIX, create the main database with mode 0600 before SQLite can create its
journals; require existing database/sidecars to be regular, nonsymlink files owned
by the backend user, and restrict their modes to 0600. SQLite WAL sidecars inherit
the private main-file mode. Do not change the process umask or repository-directory
permissions. If private storage cannot be established, bypass caching. The local
backend directory remains a trusted path; same-user filesystem sabotage is outside
this feature's threat model. Tests verify permissions after real WAL writes.

Cache failures at startup, schema checks, pruning, read, write, or shutdown cleanup
must not prevent serving ordinary requests. Log a fixed event and allowlisted
reason such as `busy`, `timeout`, `permission`, `schema`, or `corrupt`; do not log SQL
parameters, raw exception messages/tracebacks, identity digests, text, prompts,
credentials, or file contents. Documentation states that output is stored locally,
that disabling retains it, and that logical expiry/eviction does not promise
physical erasure or database shrinkage. Manual removal must include sidecars while
the backend is stopped; backups can retain earlier copies.

## Request flow and public contract

Add `force: bool = false` to both request models, preserving existing model
validation conventions. Process a request in this order:

1. Existing middleware admission/body/operation-ID checks and endpoint validation.
2. Existing translation skip gate.
3. Immutable prompt/provider/cache-policy snapshot and identity construction.
4. If enabled, maintenance and, unless forced, lookup. Return a fresh hit directly.
5. Otherwise run the existing verified pipeline using the snapshot.
6. When enabled and eligible, write the completed result. Return normal JSON.

A cache read/maintenance error makes the cache unavailable for that request: run
the provider normally and skip further cache work for it. A write failure still
returns the successful provider result. A forced attempt skips completed-result
lookup but still applies enabled maintenance and can store a good replacement.
Failed/degraded forced attempts leave a still-valid prior result intact.

Hits preserve saved output and provider-reported model, with `tokens_used: 0`
because that request made no provider calls. Historical usage stays in the row.
Keep existing success/error JSON shapes and translation skip fields; no private
eligibility metadata appears in JSON.

For successful format/translate responses, send one `X-TextKit-Cache` value using
this precedence table (first matching row wins):

| Condition | Header value |
| --- | --- |
| Translation returned through existing skip gate | `skipped` |
| Cache disabled in request policy | `disabled` |
| A fresh completed entry was returned | `hit` |
| Any attempted cache operation failed/timed out | `error` |
| Generated result is empty or known degraded | `uncacheable` |
| Forced, eligible result successfully stored | `refresh` |
| Ordinary miss, eligible result successfully stored | `miss` |

Non-success responses, including provider failures, carry no cache header. No cache
header is added to other endpoints. Disabled or skipped requests never attempt
storage; `error` does not claim the provider failed. Browser clients may ignore
this additive header. No browser CORS policy change is required for current
extension clients.

Force bypasses TextKit's completed-result cache only. Preserve existing provider
idempotency behavior: retrying with the same `X-TextKit-Operation-Id` can still reuse
a provider-side response. Clients seeking a fresh logical attempt should use a
new operation ID. YT2TXT currently sends no provider operation ID. Do not change
provider retries or invent credential checks on hits.

## Cache eligibility

HTTP 200 alone is insufficient: both pipelines can recover from token caps and
then emit source text if a chunk remains unsafe. Propagate private metadata through
every recursive branch for source fallback, failed acceptance, empty/final-join
fallback, and the final result. Cache only nonempty results whose emitted chunks
all passed the existing checks without fallback. Failed parent attempts that were
fully repaired by accepted child results do not poison the final eligibility.
Unchanged but accepted formatting is eligible; comparing output to input cannot
determine eligibility. Keep heuristic translation checks and public JSON behavior.

Use distinct fixtures for fully repaired results and degraded results. Existing
`safe_chars=120` recovery tests also exercise source fallback and cannot alone
prove the positive eligibility case.

## YT2TXT operation ownership and refresh propagation

Snapshot `msg.force === true` at accepted transcript start. Carry that Boolean in
immutable local operation context through transcript, automatic format, and its
conditional automatic translation. Force never enables translation or changes its
language. Ordinary transcript requests, keyboard shortcut, and standalone Format
or Translate use ordinary caching. Omit `force` from TextKit JSON unless true.
Never retry an incompatible backend request by silently dropping refresh intent.

Give each accepted root action a per-tab ownership token and each active stage its
own AbortController. Internal handoffs inherit the root token and force value.
Ownership is checked against the live token, the stage controller, and its abort
signal, without calling a state-creating getter on a stale path.

| Event | Ownership consequence |
| --- | --- |
| New transcript while extraction is active | Reject under existing behavior |
| Accepted new transcript | Replace old downstream chain and abort its controllers |
| Standalone Format/Translate or manual retry | Claim a new root; supersede and abort older tab work |
| Internal transcript → format → translate handoff | Inherit current root, preserving force |
| Transcript Stop | Invalidate current root and abort its stages |
| Format/Translate Stop | Invalidate the root currently owned by that active stage; an absent/stale stage is a no-op |
| Tab closure | Invalidate token, abort all stages, delete state and all tab persistence |

Track closed tabs for the worker lifetime so a pre-close tab-query continuation
cannot start a new root. A stale handler, catch, finally, timeout, storage callback,
or settings callback must not create tab state, change new state/activity markers,
publish results, or launch downstream work. Recheck after awaited response parsing,
settings reads, persistence, copy/save setup, and before handoff/effect dispatch.
`autoTranslate` reads enabled/language together and rechecks ownership after that
read, immediately before starting the inherited translation.

Serialize per-tab persistence mutations and recovery reads through a short queue;
never hold that queue over provider, clipboard, save, or settings work. Ownership
invalidation occurs synchronously before waiting for the queue. Queue result,
raw/force, operation-record, activity-marker, and cleanup mutations together.
An already-issued storage write cannot be cancelled: if invalidated during its
await, repair it within the queue before a replacement/cleanup/recovery read can
proceed. Preserve the last accepted value when rolling back stale writes. Stop
acknowledgement and closed-tab cleanup finish after this ordered reconciliation;
new work cannot be overwritten by a late old write.

Only accepted publication runs auto-copy, auto-save, and conditional translation.
Their helpers carry the ownership guard/signal through awaits, guard immediately
before effect issuance, and suppress late completion/error notifications after
invalidation. Abort in-flight save fetches where possible. A clipboard/save effect
already dispatched before Stop cannot be undone; no subsequent effect may begin
from invalidated work. Cache hits follow exactly the same accepted path.

Preserve keepalive coverage through persistence and automatic handoffs. Register
the successor controller before removing its predecessor, and let stale finalizers
remove only their own controller. A completed extraction's chain ownership lasts
through downstream work even after its extraction controller is retired.

## Manual restart recovery and existing controls

Persist `transcript_raw:<tabId>` and Boolean `transcript_force:<tabId>` together
with the successful transcript/provenance write, never as an independently sticky
setting. Replace both on each successful transcript. Remove both on tab closure.
Absent legacy force metadata means false. Standalone actions never inherit this
saved force unless explicitly retrying its transcript-format chain.

Persist one versioned downstream operation record per tab before launching format
or translate. It contains an operation ID, stage, source text, source URL/provenance
when available, language for translation, force intent, and running/failed status.
For automatic format, write the initial record with raw/force metadata so a worker
exit at the transcript handoff is recoverable. Keep the record through that stage's
auto-actions until the next stage record replaces it or the chain completes.
Record updates/terminal cleanup are ownership-checked and serialized with result
storage. A successful new transcript clears obsolete downstream results/markers
so popup restoration cannot present a prior chain as the new result.

On `popup:get-state`, reconcile saved downstream records with the current worker's
live controllers before returning state. A running record without a matching live
operation is interrupted: restore its source, force provenance, retry availability,
and an idle interrupted status; clear stale translating markers. Failed records
also remain retryable. Do not call a provider, copy, save, translate, or resume
anything during recovery. Validate record versions/shape/tab existence; unknown
records are ignored with a usable status, without provider work. Existing saved
results can still be shown alongside a retryable interrupted record.

Use the existing Format Transcript retry row for a recovered format operation and
the existing Translation button for a recovered translation. The latter retries
the saved source/language/force, not whatever transcript happens to be displayed.
An ordinary Format or Translate action starts fresh with force false. Dedicated
internal `format:retry` and `translate:retry` messages let the background read and
validate the current record; popup code does not reconstruct provenance from
current settings. Read legacy raw/force together in one storage read when no
versioned record exists; expose the format retry row if raw is available and no
completed format result exists. A stopped operation is cleared and is not treated
as an interrupted operation on reopen. A user retry starts a new root operation
ID and can repeat that stage's auto-actions, because it is explicit new work.

There is no automatic retry of an interrupted transcript download in this scope;
use Get Transcript again. Closing and reopening the popup while the worker is
still running must preserve its live Stop/progress state and never label it
interrupted. Popup rendering uses the reconciled worker state instead of reviving
an orphaned `tl2Translating` flag independently.

## Validation and delivery

Use temporary databases/prompt/config directories, fake providers, and controlled
clocks/barriers. No paid provider calls or live config/prompt dependencies.

- Prove repeat-request reuse across independent handles/processes. Change every
  identity dimension individually, including exact text/Unicode, inherited provider
  settings, token cap, effective prompt, and operation revision.
- Pin prompt precedence, empty-file versus empty-request behavior, verbatim
  overrides, supported substitution, and snapshot edits during provider execution.
- Prove fully repaired and accepted unchanged output is cached; every recursive or
  final source fallback, empty result, validation failure, or error is excluded.
- Verify exact expiry, current-policy edits, disabled retention, capacity on hits
  and forced requests, atomic concurrent eviction, and last-successful-write rules.
- Inject initialization, schema, corruption, permission, read, write, prune, and
  contention failures; verify private modes, sanitized logs, bounded caller wait,
  cancellation propagation, and event-loop responsiveness.
- Assert exact JSON/header precedence, zero hit tokens, hits with missing credential
  references, preserved admission checks, and provider idempotency semantics.
- Execute the real YT2TXT worker and popup with fake Chrome APIs/backends. Check
  forced/ordinary/keyboard/standalone bodies, disabled translation, Original,
  legacy recovery, interrupted format/translation, and fresh ordinary replacement
  of forced metadata. Verify both popup-only and fresh-worker reopen behavior.
- Suspend response parsing, storage writes, settings reads, copy setup, and save
  responses. Stop/replace/close/interleave tabs and assert that stale work cannot
  publish, resurrect state, overwrite persistence, or launch downstream effects.
- Mutation probes must fail when removing key fields, eligibility propagation,
  force propagation, ownership guards, serialized stale-write repair, or recovery
  exposure. Existing suites run with isolated/disabled test caches.

Document expanded Force refresh, manual recovery, local output retention, and the
cache settings/header contract. Deploy TextKit first, then YT2TXT. Ordinary consumer
requests remain compatible with old TextKit because `force` is omitted. Forced
requests require updated TextKit and must surface its ordinary error if rejected.
A TextKit rollback requires removing the new `cache` stanza from configuration
because older versions reject unknown fields; retain/remove database files as a
separate local-data choice. No target checkout is changed during design/planning.

Technical specification, independent specification review, and user sign-off follow
a passing independent design review. Implementation follows that sign-off.

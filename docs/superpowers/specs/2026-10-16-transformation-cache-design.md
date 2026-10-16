# TextKit formatting and translation result cache — design

Date: 2026-10-16
Status: User accepted shared caching and whole-chain refresh; ready for design review
Delivery repositories: TextKit (cache) and YT2TXT (refresh propagation)
Base commit: `c47dec6a24b42bcdb25f2c4fbe731deca8ce4431`
Consumer examined: YT2TXT at `b46b8fb29343f8b361a8b1024a7b9bbaee907b52`

## Background and goal

YT2TXT caches extracted transcripts, but each successful transcript request still
starts formatting, including transcript-cache hits. Formatting can start another
translation when auto-translate is enabled. The extension's per-tab saved output
restores the popup; it does not avoid repeated TextKit operations.

The user accepted placing reusable formatting and translation caching in TextKit
so all clients benefit. TextKit owns both pipelines, provider configuration, and
prompt resolution. Clients can supply prompt overrides, and server prompts can
change on disk between requests.

The goal is to reuse previously completed transformations when the effective input
and processing settings match, reducing provider calls and repeat-request latency.

## Scope and placement

Add persistent result caching to TextKit's `POST /format` and `POST /translate`.
Existing requests automatically participate without a browser update. OCR and
Dedup continue to use their existing behavior. The cache is an implementation of
these text operations; it does not depend on video URLs, tab IDs, or client identity.

The backend work needs no new popup controls. An optional `force` request field
provides explicit regeneration to API clients. The user also accepted extending
YT2TXT's existing Force refresh action through its automatic formatting and
translation chain. Deliver this as two coordinated changes: the reusable cache in
TextKit and per-operation refresh propagation in YT2TXT. Deploy TextKit first.
The popup's layout and existing control set do not change.

## Alternatives considered

1. TextKit cache: selected. It sees the effective prompt and text-provider settings,
   and all clients benefit.
2. Extension cache: would avoid a localhost request but would be browser-specific
   and could not reliably observe TextKit's prompt or provider changes.
3. YT2TXT backend cache: could reuse SQLite infrastructure but would make the
   transcript service responsible for transformations owned by another service.

## Cache identity

Build a SHA-256 key from a deterministic serialization of:

- Operation: format or translate.
- Exact input text, preserving whitespace and Unicode representation.
- Target language for translation, using the backend's validated representation.
- Effective system prompt after request/file/failsafe precedence and supported
  placeholder substitution have been resolved.
- Effective text-provider endpoint, requested model, and `max_tokens`.
- A cache-format version and an operation-specific pipeline revision.

Resolve the provider configuration and prompt once for the request. Use that same
snapshot both for the key and the provider calls. A prompt or configuration edit
while a request is running must not store a result under a different snapshot.
The internal pipeline interface must permit an explicitly resolved prompt even
when it is empty; it must not reload a default merely because that value is falsey.

Never persist API keys, authorization headers, or credential-derived hashes in the
key or cache records. Credentials and timeout values are excluded from operation
identity. The cache is shared within one local TextKit backend, rather than being
partitioned by provider account. Rotating credentials alone does not invalidate
entries; force regeneration remains available. Changes to operation semantics,
chunking, or validation that can affect output require a pipeline-revision bump.

Identical source text used by different videos or clients can share a result.
Changing the text, target language, effective prompt, provider endpoint, requested
model, output-token setting, or pipeline revision produces a cache miss.

## Storage and configuration

Use a small SQLite store in a dedicated backend cache module, with the database at
`backend/transformation_cache.db`. Keep the database and its WAL/SHM sidecars out
of Git. Use the Python standard library without a new runtime dependency.

Initial configuration:

```yaml
cache:
  enabled: true
  ttl_days: 30
  max_entries: 1000
```

Defaults apply to existing configuration files that omit `cache`. TTL is measured
from successful generation and is not extended by reads. Disabling caching bypasses
both reads and writes. Retain at most the configured number of entries, evicting
oldest generated entries first. Prune expired entries at startup and during cache
access/write; no new background scheduler is required for the first version.

Store the hashed identity, operation, output text, provider-reported model, original
generation token usage, and generation timestamp. The input and system prompt need
not be stored as readable fields. Output text is stored on local disk under the
same local trust assumptions as the existing backend's generated results.

Use WAL, short transactions, parameterized SQL, and a bounded database busy timeout.
Run SQLite work off the event loop. Never hold a SQLite transaction or an asyncio
cache lock during provider calls. Separate workers can share completed entries.

The first version does not merge simultaneous cache misses into one provider job.
Such requests may make duplicate calls, and atomic completed writes use the last
successful write. This keeps existing cancellation and retry behavior intact while
providing reuse for repeated completed operations.

## Request flow and API compatibility

1. Apply existing request, text, prompt, operation-ID, rate, and concurrency checks.
2. For translation, apply the existing Original/already-in-target-language gate.
   Return its existing skip response directly without persistent caching.
3. Resolve the effective prompt/provider snapshot and build the cache key.
4. When enabled and `force` is false, read a fresh cache entry and return it on hit.
5. Otherwise run the existing verified transformation pipeline with that snapshot.
6. Store the result only if it is eligible, then return the ordinary result.

Both request models add `force: bool = false`. `force: true` bypasses the read for
that operation; a fully completed new result replaces the prior entry. If a forced
attempt fails or returns a degraded result, keep any previous good entry intact.
Force regeneration still honors the existing translation skip gate.

Preserve the JSON response fields used by current clients. On a cache hit, return
the saved text and provider-reported model with `tokens_used: 0`, since that request
made no provider call. Keep historical generation usage in the cache record, rather
than presenting it as newly consumed tokens.

Expose cache outcome in an additive `X-TextKit-Cache` response header. The technical
specification will enumerate the exact values for hit, miss, forced bypass, disabled,
skipped, and an otherwise successful result that was ineligible for storage. Browser
clients can initially ignore this header. Request cache-busting query parameters
do not change the operation key.

## Eligibility and partial results

HTTP 200 alone is insufficient. Both existing pipelines can recover from token
caps by splitting and retrying, then fall back to the source if a chunk cannot be
processed. Translation already propagates a source-floor flag internally;
formatting needs equivalent internal metadata propagated through recursive chunks.

Cache only nonempty operations whose returned chunks all passed the pipeline's
existing acceptance checks and used no source fallback. Successfully repaired
chunks are eligible even if an earlier provider attempt hit its token cap.
Do not cache errors, empty results, failed validation, or source-fallback results.

Determine eligibility from explicit pipeline metadata, not by comparing output to
input: a valid formatting result may already match its source. Internal eligibility
metadata must not leak into the public JSON response. An ordinary translation skip
remains an immediate pass-through and is not an AI result to store.

The current translation checks are heuristic; caching does not claim to prove
translation quality. This work retains those checks and avoids retaining results
that the pipeline itself knows are degraded.

## Error handling and observable behavior

Cache reads/writes are best effort. A cache storage failure logs a concise event
without input, prompt, credentials, or generated text and allows normal processing
to continue. A failed cache write must not turn a successful transformation into an
HTTP error. Failed generation does not replace a previous good cache entry.

Keep the existing provider retry, operation-ID, chunk completeness, and cancellation
behavior. Do not add indefinitely waiting cache locks or change admission limits.
Clients continue to receive their normal success response on a hit, so YT2TXT's
existing auto-copy, auto-save, and downstream chain still run. Reopening a popup
continues to use its separate per-tab persistence.

## YT2TXT whole-chain refresh

Snapshot `msg.force === true` at the beginning of a transcript operation. Pass that
immutable value to the transcript request, its automatic format operation, and
translation started by that format operation. Translation remains conditional on
the existing Auto-translate setting and selected language; force does not turn
translation on. The checkbox applies to this chain only, rather than becoming a
saved preference or a flag read from the current UI at a later stage.

Ordinary transcript requests, the keyboard shortcut, and standalone Format and
Translate actions use the cache normally. For TextKit requests, omit `force` unless
it is true. This preserves the existing request bodies for ordinary requests and
avoids sending an unknown field to an older TextKit backend. Forced downstream
operations require the updated backend; never retry an incompatible request after
silently dropping the force intent.

Save `transcript_force:<tabId>` alongside the existing `transcript_raw:<tabId>` in
one `chrome.storage.local.set` call after successful extraction. Retry format reads
both in one storage read and forwards the saved Boolean; an absent legacy flag
means false. This lets retry continue a forced chain after a popup or worker restart
without forcing an unrelated standalone Format action. Overwrite both on every
successful transcript and remove both when the tab closes.

Keep force intent in the operation's local arguments as it crosses awaited calls.
Only the current, non-aborted format controller may publish its result or start
its downstream automatic translation. Guard that ownership at completion and
before the downstream action so replacing an older run cannot start its follow-on
operation after the replacement took ownership. All existing auto-copy/auto-save
and conditional auto-translate actions still execute for an accepted cache hit.

Document the expanded meaning of Force refresh in YT2TXT's user documentation.
Use its existing checkbox, error/status surfaces, and retry action without adding
controls or changing the popup layout.

## Validation strategy

Use temporary databases and a fake provider that records calls; do not call a paid
provider or use live prompt/config files. Prove the following behaviors:

- Two identical completed requests cause provider calls only on the first request,
  including reuse through a separate application/database handle.
- Formatting and translation have separate namespaces; changed text, language,
  effective prompt, provider/model, token cap, or pipeline revision causes a miss.
- Request overrides and language-specific file prompts follow actual precedence.
  Editing an overridden server prompt does not invalidate the unchanged override.
- Prompt/config changes during a request cannot mismatch its key and execution.
- Expiry, capacity eviction, disabled caching, and forced regeneration behave as
  specified, including preservation of good entries after a failed forced request.
- A recovered token-cap response is reusable; any source fallback or empty/failed
  response is not. An unchanged but accepted formatting result remains reusable.
- Translation skip responses, public JSON shapes, provider model attribution, and
  zero token usage on a hit remain consistent.
- Database failures do not prevent ordinary operation; reads and writes leave the
  event loop responsive and have bounded contention.
- Existing formatting/translation regressions, backend API tests, and extension
  tests continue to pass without depending on a shared on-disk cache.
- YT2TXT behavioral tests execute the real service-worker source with fake Chrome
  APIs and backends. Observe POST bodies across transcript → format → translate
  for forced and ordinary runs, including auto-translate disabled and Original.
- A forced format retry retains intent after popup/worker restart; legacy raw
  transcript storage defaults to ordinary cache use. Closing a tab cleans up the
  added metadata, and the next ordinary transcript replaces prior forced metadata.
- Interleaved tabs and replaced operations cannot transfer force intent or start
  a stale downstream translation. Cache-hit completion still runs the normal
  enabled auto-actions.

The implementation plan follows the design review and specification sign-off.

# TextKit Transformation Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared, private SQLite result cache to TextKit `/format` and `/translate` while preserving the public pipeline helpers, response JSON, provider idempotency, and verified-output behavior.

**Architecture:** `backend/transformation_cache.py` is a deep standard-library-only module that owns SQLite connections, schema/version validation, permissions, WAL, pruning, bounded worker execution, cancellation deadlines, and sanitized failure outcomes. `backend/main.py` resolves the effective provider, prompt, and cache policy once, constructs an exact SHA-256 identity, carries private eligibility metadata through recursive format/translation repair, and lets endpoints orchestrate cache reads and writes without executing SQL. The extension is out of scope for this plan; the later YT2TXT plan consumes the endpoint contract produced by Task 4.

**Tech Stack:** Python 3.10-compatible syntax, FastAPI, Pydantic v2, `sqlite3`, `asyncio`, `hashlib`, `pathlib`, `pytest`, `httpx`, and temporary fake providers/clocks/barriers. No new runtime dependency.

## Global Constraints

- The approved specification is `docs/superpowers/specs/2026-10-16-transformation-cache-spec.md` with SHA-256 `5b8c735c073e1523fe1e9ad82b454e0237269f4c6e0eede3a7bcbfe90e01684f`; implementation must preserve it and the approved design.
- TextKit is delivered before YT2TXT; no extension code, specification text, design text, commits outside the task commits, paid provider calls, or live credentials are part of this plan.
- The cache is only for `/format` and `/translate`; do not add in-flight request merging, move cache logic into YT2TXT, or change OCR/Dedup behavior.
- Python 3.10-compatible code is required even when local verification uses a newer interpreter; use `asyncio.CancelledError` propagation, `asyncio.to_thread` or an equivalent executor boundary, and no newer-only syntax or APIs.
- `backend/transformation_cache.py` is the only module allowed to execute SQL or interpret raw SQLite exceptions. Endpoint code receives only typed hit/miss/unavailable, stored/unavailable, and ready/unavailable outcomes.
- The cache database is `backend/transformation_cache.db`; its `-wal` and `-shm` sidecars are private local data and must never be committed.
- `CachePolicy` defaults are `enabled: true`, `ttl_days: 30`, and `max_entries: 1000`; `ttl_days` is a strict non-Boolean integer from 1 through 3650 and `max_entries` is a strict non-Boolean integer from 1 through 100000.
- Enabled cache operations use SQLite WAL, a busy timeout no greater than 100 ms, independent short-lived connections, immediate transactions, a 500 ms monotonic budget including worker queue delay, and a single maintenance clock value per operation. Cancellation is re-raised and worker cleanup still closes the connection.
- Cache rows contain only the identity digest, operation, output text, provider-reported model, original generation token count, and UTC generation timestamp. Never persist prompts, input text, API keys, authorization headers, credential-derived values, URLs, tab IDs, operation IDs, or readable configuration.
- Tests use temporary database/config/prompt paths, deterministic clocks, fake providers, and barriers. Existing pipeline tests use disabled or isolated caching unless a test explicitly exercises the cache. No test may contact a paid provider.
- `backend/main.py` is modified by Tasks 2, 3, and 4 in that order. Task 3 starts only after Task 2's commit, and Task 4 starts only after Task 3's commit; later tasks must preserve earlier interfaces rather than reworking them in parallel.

## Task 1: Build the Deep SQLite Transformation Cache

**Implementer tier:** Capable

**Files:**

- Create: `backend/transformation_cache.py`
- Test: `tests/test_transformation_cache.py`

**Interfaces:**

- Consumes: standard-library `sqlite3`, `asyncio`, `concurrent.futures.Executor`, `os`, `stat`, `time`, `math`, `re`, and `pathlib.Path`; no import from `backend.main` and no FastAPI/Pydantic dependency.
- Produces: `CacheRecord(key: str, operation: str, text: str, model: str, generation_tokens: int, generated_at: float)`; `CachePolicyView` with immutable `enabled`, `ttl_days`, and `max_entries` attributes; `CacheReadResult` with exactly `status: "hit" | "miss" | "unavailable"`, optional `record`, and allowlisted `reason`; `CacheWriteResult` with exactly `status: "stored" | "unavailable"` and allowlisted `reason`; `CacheMaintenanceResult` with exactly `status: "ready" | "unavailable"` and allowlisted `reason`.
- Produces: `TransformationCache(path: Path, *, clock: Callable[[], float] = time.time, executor: Executor | None = None)` with `async initialize(policy: CachePolicyView, now: float | None = None)`, `async read(key: str, policy: CachePolicyView, now: float | None = None)`, and `async write(key: str, record: CacheRecord, policy: CachePolicyView, now: float | None = None)`; each method returns only the typed result above and never exposes a connection, cursor, file handle, SQL statement, or raw exception.
- The internal synchronous worker receives one absolute monotonic deadline before queue submission and one UTC `now`; it configures a progress handler and checks the deadline before opening, before mutation, and before commit. The test-only executor and clock seams must not alter production defaults.

- [ ] **Step 1: Write failing tests for the public result types, record validation, and exact schema contract**

Create `tests/test_transformation_cache.py` with a temporary-path fixture and deterministic `FakeClock`. Add tests named `test_cache_record_rejects_malformed_key_and_values`, `test_initialize_creates_exact_version_one_schema`, `test_empty_version_zero_database_is_initialized_transactionally`, `test_incompatible_schema_returns_schema_without_recreating_file`, `test_unexpected_application_table_returns_schema_without_touching_file`, and `test_malformed_existing_row_returns_corrupt_not_miss`.

Pin the exact table, columns, declared types, not-null flags, primary-key position, `CHECK` constraints, `idx_transformation_cache_generation`, and `PRAGMA user_version=1`. Assert that a fresh database has no application table before initialization, that a version-0 empty database becomes version 1 in one transaction, and that an incompatible file's bytes, mode, and schema remain unchanged. Use a 64-character lowercase hexadecimal key, reject all other key forms, reject operations outside `format` and `translate`, reject empty output, negative tokens, non-string model values, and non-finite timestamps.

- [ ] **Step 2: Write failing tests for maintenance, ordering, upserts, WAL, and private permissions**

Add `test_expiry_boundary_uses_greater_equal`, `test_capacity_evicts_oldest_with_key_tie_breaker`, `test_capacity_is_shared_between_operations_on_read_and_write`, `test_last_successful_write_wins_for_one_key`, `test_read_hit_does_not_extend_ttl`, `test_policy_edit_applies_on_next_enabled_access`, `test_disabled_policy_retains_rows_and_does_no_database_work`, `test_wal_sidecars_are_private_after_a_real_write`, and `test_independent_handles_share_committed_rows`.

Use `now == generated_at + ttl_days * 86400` as the deletion boundary. Insert equal timestamps with keys in reverse order and assert eviction uses ascending key order. Verify that `read` and `write` both prune expired rows and enforce capacity atomically across format and translation. Verify that an old valid row survives an invalid or failed write, while a valid later committed write replaces every stored value for the key. On POSIX, create a new main file with mode 0600 before SQLite opens it, reject non-regular/symlink/unowned or overly permissive main and sidecar files, and inspect the mode of the real `-wal` and `-shm` files after a WAL write. Verify disabled policy never initializes, reads, prunes, or writes and does not delete existing rows.

- [ ] **Step 3: Write failing tests for contention, deadlines, cancellation, event-loop responsiveness, and sanitized errors**

Add `test_busy_timeout_is_bounded_and_returns_busy`, `test_queue_delay_counts_against_the_500ms_budget`, `test_progress_handler_interrupts_sql_work`, `test_cancelled_read_reraises_and_closes_worker_connection`, `test_eligible_write_may_finish_after_caller_cancellation`, `test_cache_work_does_not_block_the_event_loop`, `test_permission_schema_and_corrupt_failures_are_allowlisted`, and `test_cache_failure_logs_no_identity_text_or_raw_exception`.

Use a barrier executor and a blocking fake connection to prove the 500 ms budget starts before queue submission. Use a `CancelledError` barrier to prove cancellation is not converted to `unavailable`, while the worker still closes its connection. Use a successful write barrier to prove an already-issued eligible write can commit after the caller is cancelled. Capture the logger and assert the only public failure data is one fixed event plus one of `busy`, `timeout`, `permission`, `schema`, or `corrupt`; do not expose paths, SQL parameters, digests, prompts, text, or exception messages.

- [ ] **Step 4: Run the focused tests and confirm the red state**

Run from the TextKit repository root:

```sh
python -m pytest -q tests/test_transformation_cache.py
```

Expected: FAIL because `backend.transformation_cache` and `TransformationCache` do not yet exist. The failure must occur during test collection or the first import, before any real database or provider operation.

- [ ] **Step 5: Implement the cache module behind the typed interface**

Implement immutable result dataclasses and a structural policy protocol. Validate input before opening SQLite. On POSIX, pre-create a missing main database with `os.open(path, O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)`, then verify regular-file, non-symlink, owner, and mode requirements for the main database and present sidecars without changing the process umask or parent-directory mode.

Open one connection per worker invocation, set `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=100`, `PRAGMA foreign_keys=ON`, and a progress handler tied to the absolute monotonic deadline. Use `BEGIN IMMEDIATE`; for version 0 with no application tables create exactly the specified table/index and set `user_version=1`; for version 1 validate every expected schema property and reject extra application objects. Never migrate, delete, or recreate an incompatible file.

In `read`, perform schema setup/validation, expiry pruning, deterministic capacity eviction, row validation, and lookup in one transaction. Return `miss` only after successful maintenance and a missing key; return `corrupt` when a matching row is malformed. In `write`, validate the separate key and record key match, perform the same maintenance, and use parameterized upsert SQL. Never write a failed or ineligible provider result through this module. Map all local failures to the fixed allowlist, log one sanitized event, roll back, and close the connection in `finally`.

Wrap synchronous work with the executor seam and a 500 ms caller deadline that includes executor queue delay. Use the same deadline in the worker, preserve `CancelledError`, and do not introduce an indefinitely waiting async lock. Ensure every operation closes its own connection and that `initialize` always validates schema and performs maintenance without reading a result.

- [ ] **Step 6: Run all cache tests and inspect the public surface**

Run:

```sh
python -m pytest -q tests/test_transformation_cache.py
python - <<'PY'
from backend.transformation_cache import TransformationCache

public = {name for name in dir(TransformationCache) if not name.startswith("_")}
assert public == {"initialize", "read", "write"}
PY
```

Expected: the focused suite passes, and the public surface assertion confirms endpoint callers cannot reach SQL helpers or connection state.

- [ ] **Step 7: Commit the standalone cache module**

```sh
git add backend/transformation_cache.py tests/test_transformation_cache.py
git commit -m "feat(textkit): add bounded SQLite transformation cache"
```

## Task 2: Resolve Strict Policy, Prompt, Provider, and Cache Identity Snapshots

**Implementer tier:** Capable

**Files:**

- Modify: `backend/main.py:AppConfig and adjacent immutable configuration models`
- Modify: `backend/main.py:prompt resolution and text-provider resolution helpers`
- Test: `tests/test_prompt_snapshot.py`

**Interfaces:**

- Consumes: Task 1's `TransformationCache` policy shape and `CachePolicyView`; existing `FrozenModel`, `AIConfig`, `ProviderOverride`, `_resolve_ai_config(base: AIConfig, override: ProviderOverride | None) -> AIConfig`, `_load_prompt(name: str, language: str | None = None) -> str`, `_render_prompt(name: str, **kwargs: str) -> str`, `PROMPTS_DIR`, `_DEFAULT_PROMPTS`, `SUPPORTED_LANGUAGES`, and the existing `config.yaml` loading path.
- Produces: frozen strict `CachePolicy(enabled: bool = True, ttl_days: int = 30, max_entries: int = 1000)` used as `AppConfig.cache`; `CachePolicy` rejects extra fields, `null`, numeric strings, fractional values, zero/negative values, out-of-range values, and Boolean integers while allowing omitted defaults.
- Produces: frozen `_ResolvedTextSettings(config: AIConfig, prompt: str, provider_endpoint: str)` and `async _resolve_text_settings(base: AIConfig, operation: Literal["format", "translate"], request_prompt: str | None, language: str | None = None) -> _ResolvedTextSettings`; it calls `_resolve_ai_config` exactly once, resolves the prompt off the event loop exactly once, and computes `provider_endpoint` as `f"{effective_ai.api_base}/v1/chat/completions"`.
- Produces: `_cache_identity(operation: Literal["format", "translate"], input_text: str, language: str | None, settings: _ResolvedTextSettings, pipeline_revision: int = 1) -> str` with `CACHE_FORMAT_VERSION = 1` and `PIPELINE_REVISIONS = {"format": 1, "translate": 1}`. It uses sorted compact JSON with `ensure_ascii=False`, UTF-8 encoding, and lowercase SHA-256; format omits `language`, translation includes the validated language exactly once, and `None` `max_tokens` remains distinct from an integer.
- Prompt resolution treats a nonempty request string, including whitespace-only and literal `{language}`, as an already-resolved verbatim prompt. Only an omitted, `null`, or empty-string request uses the language-specific file, base file, or built-in default, with outside stripping and only literal `{language}` replacement. An existing empty file stops fallback.

- [ ] **Step 1: Write failing strict-policy and snapshot tests**

Create `tests/test_prompt_snapshot.py` with `pytest` fixtures that reset `main._config_cache` and `main._prompt_cache`. Add `test_cache_policy_defaults_when_mapping_is_omitted`, `test_cache_policy_accepts_documented_values`, `test_cache_policy_rejects_boolean_integer_and_numeric_string_values`, `test_cache_policy_rejects_null_extra_zero_negative_and_out_of_range_values`, `test_resolved_text_settings_use_text_override_once`, and `test_api_key_is_not_resolved_by_settings_snapshot`.

Assert that `AppConfig().cache` has the three defaults, that `enabled` accepts only Boolean values, that `ttl_days` and `max_entries` reject Boolean-as-integer, strings, floats, `null`, zero, negative, and out-of-range values, and that an extra cache field is rejected. Monkeypatch `_resolve_ai_config` and `_resolve_ai_api_key` to count calls; settings resolution must call the former once and the latter zero times.

- [ ] **Step 2: Write the canonical identity and prompt precedence tests before implementation**

Add `test_cache_identity_matches_the_fixed_utf8_digest_vector`, `test_identity_changes_for_each_dimension`, `test_identity_preserves_exact_whitespace_unicode_and_line_endings`, `test_identity_distinguishes_unset_and_explicit_max_tokens`, `test_translation_identity_includes_validated_language_but_format_does_not`, `test_request_prompt_override_is_verbatim`, `test_empty_request_prompt_uses_language_file_then_base_file`, `test_empty_prompt_file_is_explicit_and_stops_fallback`, `test_server_template_replaces_only_language_token`, `test_prompt_edits_affect_later_snapshots_only`, and `test_effective_provider_settings_change_the_identity`.

For the fixed vector, construct the exact canonical object from the approved specification and assert the digest is `c80b950b5bce10ffac6026037fe4649111381531b1f932892844fc43cab0e1ff`. Change one of input text, Unicode form, line ending, effective prompt, provider endpoint, model, `max_tokens`, operation, language, cache-format version, or pipeline revision and assert the key changes. Use temporary `translate.French.txt`, `translate.txt`, and `format.txt` files, including an empty file, and edit a prompt/config while a fake provider barrier is held; the in-flight snapshot must remain unchanged while a later snapshot reflects the edit.

- [ ] **Step 3: Run the new tests and confirm the red state**

Run:

```sh
python -m pytest -q tests/test_prompt_snapshot.py
```

Expected: FAIL because `AppConfig.cache`, `CachePolicy`, `_resolve_text_settings`, and `_cache_identity` are not present and the current prompt helpers still use truthiness-based fallback for text transformations.

- [ ] **Step 4: Implement strict policy and immutable settings resolution**

Add strict scalar fields to a frozen `CachePolicy` model and a default factory on `AppConfig`. Preserve `AppConfig`'s existing `extra="forbid"` behavior and all existing configuration fields. Keep policy snapshots immutable after request acceptance; a later config reload must affect only later requests.

Add a dedicated resolved-prompt path for format and translation. Use an explicit resolved value rather than passing an empty string back through `prompt or fallback`. Run file reads and template resolution via `asyncio.to_thread`; use `translate.<ValidatedLanguage>.txt` before `translate.txt`, use `format.txt` for format, strip file edges, preserve an existing empty file, and replace only literal `{language}` in server templates. Do not change request overrides or existing OCR/Dedup prompt behavior.

Resolve the inherited `text` provider once from the accepted base AI configuration. Store that immutable AI model, prompt, endpoint, and effective `max_tokens` in `_ResolvedTextSettings`; do not resolve API keys here. Construct the canonical object in the exact field order/serialization contract from the specification and hash its UTF-8 bytes with SHA-256. Keep the operation revisions in one named constant so future output-affecting changes can increment the correct operation independently.

- [ ] **Step 5: Run the focused and regression tests**

Run:

```sh
python -m pytest -q tests/test_prompt_snapshot.py tests/test_backend.py tests/test_format_pipeline.py tests/test_translate_pipeline.py
```

Expected: PASS for the new strict-policy, prompt, identity, and existing prompt/pipeline regression tests. The existing public helper and prompt endpoint JSON contracts must remain unchanged.

- [ ] **Step 6: Run mutation probes for identity and snapshot integrity**

Run the named tests individually:

```sh
python -m pytest -q tests/test_prompt_snapshot.py -k "fixed_utf8_digest_vector or identity_changes_for_each_dimension or request_prompt_override_is_verbatim or prompt_edits_affect_later_snapshots_only or api_key_is_not_resolved"
```

Expected: all probes pass. The implementer must also locally invert each asserted field one at a time during development and observe a failure before restoring the implementation; the committed source must retain every identity dimension and the lazy-secret boundary.

- [ ] **Step 7: Commit the immutable snapshot and identity layer**

```sh
git add backend/main.py tests/test_prompt_snapshot.py
git commit -m "feat(textkit): snapshot transformation settings and cache identity"
```

## Task 3: Carry Cache Eligibility Through Verified Format and Translation Repair

**Implementer tier:** Capable

**Files:**

- Modify: `backend/main.py:verified format and translation recursion plus public helpers`
- Modify: `tests/test_format_pipeline.py:verified-output fixtures and assertions`
- Modify: `tests/test_translate_pipeline.py:verified-output fixtures and assertions`

**Interfaces:**

- Consumes: Task 2's `_ResolvedTextSettings(config: AIConfig, prompt: str, provider_endpoint: str)`, `async _resolve_text_settings(...)`, existing `_CompletionStats`, `_content_preserved`, `_translation_looks_complete`, `_format_idempotency_key`, `_chunk_idempotency_key`, `_segment_for_format`, `_split_in_half`, and the existing `_request_chat_completion` fake-provider seam.
- Produces: frozen private `_PipelineOutcome(response: OCRResponse, eligible: bool, degraded: bool)`; `async _execute_format(settings: _ResolvedTextSettings, text: str) -> _PipelineOutcome`; `async _execute_translate(settings: _ResolvedTextSettings, text: str, language: str) -> _PipelineOutcome`.
- Produces: recursive private leaf/aggregate results that retain `text`, `accepted`, and `degraded` metadata through every branch. A parent that fails acceptance but is fully repaired by accepted children is eligible; source-floor fallback, final join fallback, empty output, provider error, and any degraded leaf are ineligible.
- Preserves: `async format_text(config: AIConfig, text: str, prompt: str | None = None) -> OCRResponse` and `async translate_text(config: AIConfig, text: str, language: str, prompt: str | None = None) -> OCRResponse`; these wrappers resolve settings and return only `OCRResponse`, discarding private eligibility metadata.

- [ ] **Step 1: Add positive and negative eligibility tests before changing recursion**

Extend `tests/test_format_pipeline.py` with `test_fully_repaired_format_result_is_eligible`, `test_source_floor_format_result_is_degraded_and_ineligible`, `test_accepted_unchanged_format_result_is_eligible`, `test_format_final_empty_join_is_ineligible`, and `test_public_format_text_still_returns_only_ocr_response`.

Use the approved deterministic fake provider with `safe_chars=400` for a fully repaired result and `safe_chars=120` for a degraded/source-floor result. Assert the positive output preserves all source content and has `eligible is True`, while the degraded output preserves content but has `eligible is False` and `degraded is True`. Verify unchanged accepted formatting is eligible; do not compare output to input as the eligibility criterion.

Extend `tests/test_translate_pipeline.py` with `test_fully_repaired_translation_is_eligible`, `test_translation_source_floor_is_ineligible`, `test_translation_empty_result_is_ineligible`, `test_translation_final_join_fallback_is_ineligible`, and `test_public_translate_text_still_returns_only_ocr_response`. Assert that all recursive children must be accepted and that a failed parent repaired entirely by accepted children does not poison the aggregate.

- [ ] **Step 2: Run the eligibility tests and confirm the red state**

Run:

```sh
python -m pytest -q tests/test_format_pipeline.py tests/test_translate_pipeline.py -k "eligible or degraded or source_floor or final_join or public_.*ocr_response"
```

Expected: FAIL because the current recursive functions return strings or `(text, floor)` tuples and the public helpers expose no private outcome carrying acceptance metadata.

- [ ] **Step 3: Refactor format recursion to return accepted/degraded metadata**

Change the internal format recursion to return a leaf object containing emitted text, acceptance, and degraded/fallback state. Mark a provider leaf accepted only when `finish_reason` is not `length` and `_content_preserved(source, result)` succeeds. At the minimum chunk/depth floor, emit the source with `accepted=False` and `degraded=True`. When recursively repairing a rejected parent, aggregate the child texts and set the aggregate accepted flag from the children rather than the rejected parent; a parent repaired entirely by accepted children is therefore eligible.

Keep `_CompletionStats` and chunk idempotency unchanged. Build the final join in original order, mark an empty final result or source-text final fallback degraded, and return `_PipelineOutcome` with the existing `OCRResponse` model/token totals. Preserve all provider calls, warnings, and public JSON behavior.

- [ ] **Step 4: Refactor translation recursion to return accepted/degraded metadata**

Change `_translate_verified` to return a private leaf object rather than only `(text, floor)`. Mark a leaf accepted only when `finish_reason` is not `length` and `_translation_looks_complete(source, result)` succeeds. Mark source floors and empty/final fallback output degraded. Aggregate recursive children with `accepted = all(child.accepted for child in children)` and `degraded = any(child.degraded for child in children)`; a rejected parent repaired by accepted children remains eligible.

Keep the translation heuristic, source-preserving behavior, sentence segmentation, bounded concurrency, idempotency keys, token totals, and warning behavior. Ensure private flags never enter `OCRResponse` or endpoint JSON.

- [ ] **Step 5: Keep public helper wrappers compatible**

Make `format_text` and `translate_text` resolve settings through Task 2's explicit resolver, call `_execute_format` or `_execute_translate`, and return only `.response`. Never use truthiness fallback on an already-resolved empty prompt. Keep their existing signatures and existing tests for model, token count, segmentation, content preservation, and idempotency passing.

- [ ] **Step 6: Run the complete pipeline tests and mutation probes**

Run:

```sh
python -m pytest -q tests/test_format_pipeline.py tests/test_translate_pipeline.py
python -m pytest -q tests/test_format_pipeline.py tests/test_translate_pipeline.py -k "repaired or source_floor or unchanged or empty or fallback"
```

Expected: PASS. During development, mutate each of these mechanisms once and confirm the named tests fail before restoring them: drop leaf acceptance in a recursive return, treat source fallback as accepted, make unchanged output ineligible, remove the aggregate child flag, or expose private metadata through `OCRResponse`.

- [ ] **Step 7: Commit the private eligibility outcome layer**

```sh
git add backend/main.py tests/test_format_pipeline.py tests/test_translate_pipeline.py
git commit -m "feat(textkit): preserve transformation eligibility through repair"
```

## Task 4: Integrate Force, Cache Transactions, Headers, and Endpoint Ordering

**Implementer tier:** Capable

**Files:**

- Modify: `backend/main.py:lifespan, request models, and /format and /translate endpoints`
- Create: `tests/test_transformation_endpoints.py`

**Interfaces:**

- Consumes: Task 1's `TransformationCache.initialize/read/write` and typed outcomes; Task 2's `CachePolicy`, `_ResolvedTextSettings`, `_resolve_text_settings`, `_cache_identity`, `CACHE_FORMAT_VERSION`, and `PIPELINE_REVISIONS`; Task 3's `_PipelineOutcome`, `_execute_format`, `_execute_translate`, and public `OCRResponse` wrappers; existing middleware admission/body/operation-ID checks and `_should_skip_translation`.
- Produces: `FormatRequest.force: bool = False` and `TranslateRequest.force: bool = False`, still with `extra="forbid"` and all existing required fields; a cache instance rooted at `backend/transformation_cache.db` with no persistent connection; successful `/format` and `/translate` responses with one additive `X-TextKit-Cache` header and unchanged JSON fields.
- Produces: exact header outcomes `skipped`, `disabled`, `hit`, `error`, `uncacheable`, `refresh`, and `miss` with the specification's first-match precedence. Non-success responses, including provider errors, have no cache header.
- The endpoint flow is fixed: middleware admission and operation-ID validation, config/AI/text/prompt validation, translation skip gate, one immutable provider/prompt/policy snapshot and key, enabled read or forced initialize, provider execution on miss, eligible write, then response. A hit returns stored text/model with `tokens_used: 0` and never resolves an API key.

- [ ] **Step 1: Write endpoint tests for request shape, ordering, and cache outcomes**

Create `tests/test_transformation_endpoints.py` with temporary database and fake provider fixtures. Add `test_force_defaults_false_and_extra_fields_remain_forbidden`, `test_admission_runs_before_cache_hit`, `test_ordinary_miss_calls_read_then_provider_then_write`, `test_forced_request_initializes_without_lookup`, `test_cache_hit_returns_saved_model_and_zero_tokens`, `test_cache_hit_does_not_resolve_api_key`, `test_cache_disabled_does_no_cache_work`, `test_cache_read_failure_runs_provider_without_later_write`, `test_cache_write_failure_keeps_success_and_uses_error_header`, `test_forced_failure_preserves_old_row`, and `test_provider_error_has_no_cache_header`.

Use a fake `TransformationCache` that records calls and returns typed results, and a fake `_request_chat_completion`/pipeline seam. Assert no SQL-like call is possible from endpoint code, admission and validation still run on hits, forced requests call `initialize` rather than `read`, an unavailable read/initialize prevents later writes, and a write failure does not turn a successful provider response into an HTTP error.

- [ ] **Step 2: Write tests for prompt/skip behavior, headers, idempotency, and JSON compatibility**

Add `test_translation_skip_returns_existing_fields_and_skipped_header`, `test_force_does_not_bypass_original_or_same_language_skip`, `test_whitespace_prompt_bypasses_skip_gate`, `test_header_precedence_for_all_success_paths`, `test_hit_uses_stored_model_and_zero_tokens`, `test_force_does_not_change_provider_idempotency_key`, `test_ordinary_and_forced_results_keep_existing_json_shape`, `test_empty_or_degraded_result_is_uncacheable_and_not_written`, and `test_cache_hit_succeeds_without_available_environment_key`.

Pin that skipped translation never resolves prompt or cache and retains `text`, `model`, `tokens_used`, `skipped`, `detected_language`, and `skip_reason`. Assert ordinary eligible storage returns `miss`, forced eligible storage returns `refresh`, degraded/empty successful output returns `uncacheable`, cache-disabled returns `disabled`, cache failure takes precedence over degraded status as `error`, and a cached hit returns `hit`. Use a new operation ID for a fresh forced logical attempt but assert Force is absent from the provider idempotency key.

- [ ] **Step 3: Run the endpoint tests and confirm the red state**

Run:

```sh
python -m pytest -q tests/test_transformation_endpoints.py
```

Expected: FAIL because the request models lack `force`, the endpoints do not instantiate/use `TransformationCache`, no cache header is emitted, and the existing endpoint path directly calls the public wrappers without a private eligibility outcome.

- [ ] **Step 4: Implement request models, cache lifecycle, and exact endpoint orchestration**

Add strict Boolean `force` fields to both request models. Instantiate `TransformationCache` with the fixed backend path and no persistent connection. During lifespan startup, call `initialize` best-effort only when the loaded policy is enabled; log only the cache module's sanitized outcome and never make startup failure fatal. Do not add a maintenance scheduler.

Replace the format and translation endpoint body with the fixed ordering. Resolve `AIConfig`, prompt, provider endpoint, max-token value, and policy once and pass the same immutable values to the key builder and private executor. Keep API-key resolution inside `_request_chat_completion`; cache lookup must be possible with a missing environment reference.

For enabled ordinary requests call `read`; for enabled forced requests call `initialize` and never look up the completed row. On `hit`, return a `JSONResponse` with stored text/model, `tokens_used: 0`, and `X-TextKit-Cache: hit`. On unavailable maintenance/read, run the provider but skip all later cache work and remember `error`. On successful eligible provider completion, capture `generated_at` immediately before cache submission, write the `CacheRecord`, and select `miss` or `refresh` only if storage succeeds. Preserve an old row when a forced provider result is failed, degraded, empty, or uncacheable.

Keep the translation skip gate before prompt resolution and cache access. Add headers only to successful format/translate responses. Preserve all existing error payloads and JSON fields, with no private eligibility data.

- [ ] **Step 5: Run focused endpoint, pipeline, and backend suites**

Run:

```sh
python -m pytest -q tests/test_transformation_endpoints.py tests/test_prompt_snapshot.py tests/test_transformation_cache.py tests/test_format_pipeline.py tests/test_translate_pipeline.py tests/test_backend.py
```

Expected: PASS for the cache, snapshot, endpoint, pipeline, and existing backend suites. The test provider must be the only provider used by this command.

- [ ] **Step 6: Run endpoint mutation and race probes**

Run:

```sh
python -m pytest -q tests/test_transformation_endpoints.py -k "force or hit or disabled or failure or header or skip or idempotency"
```

Expected: PASS. During development, temporarily remove one identity field, move the skip gate after cache access, resolve the API key during snapshot construction, perform a lookup for Force, write after an unavailable read, or expose `generation_tokens` as hit `tokens_used`; each named test must fail before the mutation is restored.

- [ ] **Step 7: Commit the endpoint contract consumed by YT2TXT**

```sh
git add backend/main.py tests/test_transformation_endpoints.py
git commit -m "feat(textkit): integrate transformation cache with endpoints"
```

## Task 5: Document Local Retention, Headers, Configuration, and Verification

**Implementer tier:** Standard

**Files:**

- Modify: `backend/config.example.yaml:cache configuration section`
- Modify: `.gitignore:TextKit cache database and sidecars`
- Modify: `README.md:TextKit configuration, API, privacy, and rollback sections`

**Interfaces:**

- Consumes: the committed endpoint contract from Task 4: optional `force` defaults to false, successful `/format` and `/translate` responses add `X-TextKit-Cache`, existing JSON shapes remain unchanged, and forced requests require the updated TextKit backend.
- Produces: a committed example configuration with `cache.enabled`, `cache.ttl_days`, and `cache.max_entries`; Git ignores for `backend/transformation_cache.db`, `backend/transformation_cache.db-wal`, and `backend/transformation_cache.db-shm`; README instructions covering cache behavior, headers, retention/privacy, disabled-cache retention, manual sidecar removal, incompatible-schema handling, and rollback.
- Produces: a final verification record from commands only; do not claim test success in the plan artifact or documentation before the commands have actually run.

- [ ] **Step 1: Write the documentation checks before editing documentation**

Use a shell check in the repository root that reads the three target files and asserts the exact setting names and all seven header values appear in the documented API section. Also assert that the example file contains `enabled: true`, `ttl_days: 30`, and `max_entries: 1000`, and that `.gitignore` contains the database plus both sidecars.

Run:

```sh
python - <<'PY'
from pathlib import Path
example = Path("backend/config.example.yaml").read_text()
ignore = Path(".gitignore").read_text()
readme = Path("README.md").read_text()
for token in ("enabled: true", "ttl_days: 30", "max_entries: 1000"):
    assert token in example, token
for token in ("backend/transformation_cache.db", "backend/transformation_cache.db-wal", "backend/transformation_cache.db-shm"):
    assert token in ignore, token
for token in ("X-TextKit-Cache", "skipped", "disabled", "hit", "error", "uncacheable", "refresh", "miss", "force"):
    assert token in readme, token
PY
```

Expected: FAIL until the documentation and ignore entries are added.

- [ ] **Step 2: Update the example config and ignore rules**

Add the exact cache mapping under the TextKit example configuration with comments explaining strict Boolean/integer validation and that disabling retains existing rows. Add the main database and both SQLite sidecars to `.gitignore` without broadening the ignore pattern to unrelated databases or source files.

- [ ] **Step 3: Update README behavior and operational guidance**

Document the default policy, exact header meanings and precedence, Force bypassing only completed-result lookup, zero token usage on hits, prompt/provider identity snapshotting, no credential/input/prompt persistence, local output retention, disabled-cache retention, logical expiry/eviction not guaranteeing physical erasure or file shrinkage, manual sidecar removal only with the backend stopped, and the fact that incompatible schema is bypassed rather than silently migrated. Document rollback: remove the new `cache` stanza before running an older TextKit because its configuration model rejects unknown fields; retain or remove the database as a separate local-data decision.

Document that ordinary clients may omit `force` for old-backend compatibility, forced requests require the updated backend and surface its normal validation error if rejected, and YT2TXT must be deployed only after TextKit. Do not add popup controls or imply provider calls occur on cache hits.

- [ ] **Step 4: Run documentation checks and the complete focused verification command**

Run:

```sh
python - <<'PY'
from pathlib import Path
example = Path("backend/config.example.yaml").read_text()
ignore = Path(".gitignore").read_text()
readme = Path("README.md").read_text()
for token in ("enabled: true", "ttl_days: 30", "max_entries: 1000"):
    assert token in example, token
for token in ("backend/transformation_cache.db", "backend/transformation_cache.db-wal", "backend/transformation_cache.db-shm"):
    assert token in ignore, token
for token in ("X-TextKit-Cache", "skipped", "disabled", "hit", "error", "uncacheable", "refresh", "miss", "force"):
    assert token in readme, token
PY
python -m pytest -q tests/test_transformation_cache.py tests/test_transformation_endpoints.py tests/test_prompt_snapshot.py tests/test_format_pipeline.py tests/test_translate_pipeline.py
python -m pytest -q tests/
```

Expected: the documentation assertions and both pytest commands complete without failures. The full suite must still use temporary or disabled caches everywhere except explicit cache tests.

- [ ] **Step 5: Commit the documented deployment contract**

```sh
git add backend/config.example.yaml .gitignore README.md
git commit -m "docs(textkit): document transformation cache operations and retention"
```

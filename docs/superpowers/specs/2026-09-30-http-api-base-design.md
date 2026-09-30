# Allow Plain HTTP for `api_base` — Design

- Date: 2026-09-30
- Status: Approved by user (design gate); revised after frontier design review rounds 1–2; round 2 confirmed zero blockers
- Topic slug: `http-api-base`
- Integration base: `d2fcdaf3b724a359c7c592760ef0c38e4b628461`

## Background

Today the backend rejects a plain-HTTP provider endpoint unless the host is
loopback. The validator `_validate_api_base_value` in `backend/main.py` performs
all structural checks and then raises:

```python
loopback = parsed.hostname.lower().strip("[]") in {"localhost", "127.0.0.1", "::1"}
if parsed.scheme != "https" and not loopback:
    raise ValueError("api_base must use HTTPS unless it targets a loopback provider")
```

The rule is reachable from two config surfaces:

- `AIConfig.api_base` — the base provider endpoint (`AIConfig.validate_api_base`,
  `backend/main.py:188-191`).
- `ProviderOverride.api_base` — the per-task `ai.ocr` / `ai.text` overrides
  (`ProviderOverride.validate_api_base`, `backend/main.py:171-174`).

It is pinned by `tests/test_backend.py::test_non_loopback_provider_requires_https`
(line 283) and documented in `README.md` ("Non-loopback providers must use HTTPS.")
and `backend/config.example.yaml` ("Non-loopback providers must use HTTPS. Plain
HTTP is accepted only for localhost, 127.0.0.1, and ::1 development providers.").

`AppConfig.ai` is `AIConfig | None = Field(default_factory=AIConfig)`
(`backend/main.py:207`), and endpoints explicitly handle `None` with a 500 "AI
provider configuration is missing", so `ai: null` is a supported configuration.

The user has explicitly requested that plain HTTP be permitted for any host, while
acknowledging that non-loopback HTTP is unencrypted. The chosen policy is to allow
it and emit a load-time warning rather than to gate it behind new config surface.

## Goals

1. `api_base` may use `http://` for any host, including non-loopback hosts.
2. A non-loopback `http://` endpoint produces one clear warning at config load.
3. No behavior change for the three loopback literals (`localhost`, `127.0.0.1`,
   `::1`) over `http://` (still silent), or for any `https://` endpoint.
4. Structural validation is unchanged: only the HTTPS-vs-loopback rejection is
   removed, nothing else is loosened.
5. A config with `ai: null` continues to load exactly as it does today.

## Non-Goals

- No opt-in config flag (e.g. `allow_insecure_http`); the request was to allow the
  scheme, and the warning is the only safety signal.
- No changes to the Chrome extension. The extension's `normalizeBackendSettings`
  validates only the localhost *backend* host, not the provider `api_base`.
- No acceptance of schemes other than `http`/`https`.
- No relaxation of hostname, port, query, fragment, or user-info checks.
- No expansion of the loopback literal set. Only exact `localhost`, `127.0.0.1`,
  `::1` (after lowercasing and stripping brackets) are exempt from the warning.
  `127.0.0.2`, `localhost.`, and canonical-expanded IPv6 loopback forms do warn;
  those forms also required HTTPS before this change, so the classification is
  preserved exactly.

## Design

### Validation change

`_validate_api_base_value` drops only the scheme/loopback rejection and the now-dead
`loopback` local. It continues to require:

- a parseable absolute URL with scheme in `{http, https}` and a non-empty hostname;
- a port, when present, in `1..65535`;
- no query, fragment, user-info, username, or password components;
- trailing-slash normalization (`value.strip().rstrip("/")`).

The function keeps returning the original-case normalized string, unchanged.

### Loopback classification

One private helper is the single source of truth:

```python
def _is_loopback_hostname(hostname: str) -> bool:
    """True only for the exact literals localhost, 127.0.0.1, and ::1."""
    return hostname.lower().strip("[]") in {"localhost", "127.0.0.1", "::1"}
```

The warning pass calls it; the validator no longer needs it. No other call site
re-implements the comparison.

### Warning policy

A warning is emitted once per insecure endpoint per config load:

- Trigger: parsed scheme is `http` (case-insensitively) **and**
  `_is_loopback_hostname(parsed.hostname or "")` is false.
- Coverage: `ai.api_base`, `ai.ocr.api_base`, `ai.text.api_base`, in that order;
  empty/whitespace override values are skipped.
- Deduplication: by the validator-normalized URL string, first occurrence wins.
- Emission point: `load_config()`, which already caches on the config file
  signature (`mtime_ns`, `size`). The warning therefore fires once per process per
  config version — at startup and again only when the config file actually changes
  (including a reload while serving). Multiple workers may each warn once; that is
  acceptable and documented.
- Sink: the existing `textkit` JSON logger. In `load_config`, for each returned URL,
  `host = urlsplit(url).hostname or ""`, and the call is exactly:

  ```python
  logger.warning(
      "api_base uses unencrypted HTTP for non-loopback host %s; prefer HTTPS",
      host,
      extra={"event": "config.insecure_api_base"},
  )
  ```

  The message interpolates the parsed hostname, not the netloc, so an explicit port
  never appears in the warning. `extra` carries only `event`, matching the
  repository's `extra={"event": ...}` lifecycle-log convention; `JsonFormatter`
  emits only `event` from extras and would silently drop any other key.
- Explicitly **not** emitted from `_resolve_ai_config` or from any pydantic
  validator. `_resolve_ai_config` reconstructs an `AIConfig` on every request that
  uses a provider override (`backend/main.py:345-357`); warning there would spam
  once per OCR/dedup/translate/format request. Every override value originates from
  config.yaml and is covered by the load-time pass.

### None-safety

The warning pass is skipped when `config.ai is None`. The helper accepts
`AIConfig | None` and returns `[]` for `None`, so a config with `ai: null` loads
without a warning and without raising, preserving today's behavior.

### Helper

`_insecure_api_base_urls(ai: AIConfig | None) -> list[str]` returns the deduplicated
non-loopback `http://` URLs among the base and the two overrides, parsing each value
with `urlsplit` so scheme casing is handled, and classifying hosts with
`_is_loopback_hostname`. The validator stays pure; the warning policy and its
message live in exactly one place. `load_config()` calls the helper after
`AppConfig.model_validate` succeeds and logs one warning per returned URL.

## Error Handling

- Malformed URL, non-HTTP(S) scheme, missing host, invalid port, query, fragment, or
  user-info continue to raise the same `ValueError` messages as today.
- An `http://` endpoint with an invalid port still fails validation before any
  warning is considered, because validation precedes the warning pass.
- A config that fails validation never reaches the warning pass.
- `ai: null` skips the warning pass entirely.

## Testing Strategy

Replace `test_non_loopback_provider_requires_https` and add:

1. `test_non_loopback_provider_allows_http` — `AIConfig(api_base="http://provider.example/", ...)`
   validates and returns `"http://provider.example"` (trailing-slash stripping), with
   the slashless literal as a second case; loopback `http://127.0.0.1:8000` still
   validates.
2. `test_provider_override_allows_http` — a direct `ProviderOverride(api_base="http://provider.example")`
   validates (the second named surface).
3. `test_provider_rejects_invalid_structure` — parameterized regression tests for
   bad scheme, missing host, malformed bracketed IPv6, query, fragment, and
   user-info, asserting the existing messages (`must be a valid absolute HTTP(S)
   URL`, `must not include query, fragment, or user-info components`). The
   repository currently has none of these.
4. `_insecure_api_base_urls` unit tests: base-only, override-only, both overrides,
   duplicate URL dedup (base vs. override), empty/whitespace override skipped,
   loopback literals `[localhost, LOCALHOST, 127.0.0.1, [::1], [::1]:8000]`
   excluded, non-exempt forms (`127.0.0.2`, `localhost.`, `[0:0:0:0:0:0:0:1]`)
   included, uppercase `HTTP://PROVIDER.EXAMPLE` included, and `ai=None` → `[]`.
5. `test_load_config_warns_on_insecure_api_base` — modeled on
   `test_config_schema_rejects_invalid_ranges` (tmp `CONFIG_PATH`, reset
   `main._config_cache`): one non-loopback `http://` base with an explicit port
   (`http://provider.example:8080`, pinning hostname-not-netloc in the warning
   argument) plus one insecure `text` override with a distinct URL produces two
   warnings (one per URL, in base → ocr → text order); an all-HTTPS/loopback config
   produces none; `ai: null` produces none and does not raise. Warning capture
   patches `main.logger.warning` because `textkit` sets `propagate = False` and
   `caplog` cannot see it.
6. `test_load_config_does_not_rewarn_for_unchanged_config` — a second `load_config()`
   with the same unchanged tmp file adds zero warnings, and
   `_resolve_ai_config(config.ai, config.ai.text)` with an insecure override adds
   zero warnings; a direct `_insecure_api_base_urls(...)` call also adds zero
   warnings. This is the falsifiable pin against warning-at-validation-time and
   helper-side logging. `config` is the `AppConfig` returned by `load_config`.

Test hygiene: add `main._config_cache = None` to the autouse `reset_backend_globals`
fixture so a tmp-config test cannot leak a cache entry into another test, and reset
it between positive/negative phases inside the warning test.

The backend suite is run with `python -m pytest tests/ -v` from the repository root.

## Documentation

Exact replacements:

- `README.md`, `api_base` bullet — replace only the final sentence
  "Non-loopback providers must use HTTPS." with: "HTTP is accepted for any host, but
  non-loopback HTTP is unencrypted and the backend logs a startup warning; prefer
  HTTPS."
- `backend/config.example.yaml` — replace the two-line comment

  ```text
  # Non-loopback providers must use HTTPS. Plain HTTP is accepted only for
  # localhost, 127.0.0.1, and ::1 development providers.
  ```

  with

  ```text
  # HTTP is accepted for any provider host. Non-loopback HTTP is unencrypted and
  # the backend logs a startup warning at config load; prefer HTTPS.
  ```

## Verification

1. `python -m pytest tests/ -v` (from the repository root) passes; this includes
   `tests/test_extension_assets.py`.
2. Node suite from the repository root:
   `node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js`.
   `tests/extension_e2e.test.js` exists but is not part of the CLAUDE.md command;
   the implementation audit runs it as an extra check and records the outcome
   (including a missing-prerequisite skip).
3. Manual smoke: a config with a non-loopback `http://` endpoint logs exactly one
   warning line per process at startup and none on a loopback `http://` config.
4. `git diff` against the pinned base contains only the validator change, the two
   helpers, `load_config` wiring, tests, and the two documentation edits.

# Allow Plain HTTP for `api_base` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Accept plain `http://` for any `api_base` provider host and emit one load-time warning per non-loopback insecure URL, without loosening any other validation.

**Architecture:** The HTTPS-only rejection is deleted from `_validate_api_base_value`. Two new private helpers classify the exact loopback literals and collect the deduplicated non-loopback `http://` values from `ai.api_base`, `ai.ocr.api_base`, and `ai.text.api_base` in that order. `load_config` runs the collector once per cache miss, after publishing the validated `AppConfig`, and logs one warning per URL through the existing `textkit` JSON logger.

**Tech Stack:** Python 3.10+, Pydantic v2, FastAPI, pytest; the documentation edits are Markdown and YAML.

## Global Constraints

- Only these four files may change: `backend/main.py`, `tests/test_backend.py`, `README.md`, and `backend/config.example.yaml`.
- The loopback literal set stays exactly `localhost`, `127.0.0.1`, and `::1` (after lowercasing and stripping square brackets); do not broaden or shrink it.
- Accepted schemes stay exactly `http` and `https`; every other scheme remains rejected.
- A port, when present, stays exactly within `1..65535`; query, fragment, and user-info components stay rejected with their existing exact messages.
- `_validate_api_base_value` keeps its `value.strip().rstrip("/")` normalization, its original-case return value, and its missing docstring.
- No opt-in config flag, no Chrome extension changes, and no new URL components or schemes.
- `_insecure_api_base_urls` is pure: it never logs and has no globals or side effects.
- The warning call is exactly `logger.warning("api_base uses unencrypted HTTP for non-loopback host %s; prefer HTTPS", host, extra={"event": "config.insecure_api_base"})`; `extra` carries `event` only.
- Warnings are emitted exactly once per cache miss per unique normalized URL, in base then `ocr` then `text` order.
- `ai: null` loads without raising and without warning.
- Backend tests run from the repository root: `python -m pytest tests/ -v`.
- Node tests run from the repository root: `node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js`.

## Task 1: Allow HTTP in `_validate_api_base_value` and add the loopback and insecure-URL helpers

**Implementer tier:** Standard
**Lane hint:** backend-core

**Files:**

- Modify: `backend/main.py:157-159` — delete the HTTPS-only rejection from `_validate_api_base_value`.
- Modify: `backend/main.py:160-163` — insert `_is_loopback_hostname` between `_validate_api_base_value` and `class ProviderOverride`.
- Modify: `backend/main.py:191-194` — insert `_insecure_api_base_urls` between `AIConfig` and `class AppConfig`.
- Test: `tests/test_backend.py:283-288` — replace `test_non_loopback_provider_requires_https` with the new provider tests.
- Test: `tests/test_backend.py:297-300` — insert the `_insecure_api_base_urls` tests after `test_provider_rejects_invalid_ports`.

**Interfaces:**

- Consumes: existing `_validate_api_base_value(value: str) -> str` (`backend/main.py:136`), existing `ProviderOverride` (`backend/main.py:163`) and `AIConfig` (`backend/main.py:177`) pydantic models, the existing `urlsplit` import from `urllib.parse`, `FrozenModel`, and `field_validator`; on the test side, `from backend import main` and `import pytest` (`tests/test_backend.py:1-12`).
- Produces:
  - `_validate_api_base_value(value: str) -> str` — same name, signature, normalization, and error messages as before; it no longer rejects a non-loopback `http://` URL.
  - `_is_loopback_hostname(hostname: str) -> bool` — returns `hostname.lower().strip("[]") in {"localhost", "127.0.0.1", "::1"}`.
  - `_insecure_api_base_urls(ai: AIConfig | None) -> list[str]` — returns deduplicated non-loopback `http://` values in base then `ocr` then `text` order, original case preserved, and `[]` for `None`.
  - `tests/test_backend.py` test functions: `test_non_loopback_provider_allows_http`, `test_provider_override_allows_http`, `test_provider_rejects_invalid_structure`, `test_insecure_api_base_urls_base_and_override_coverage`, `test_insecure_api_base_urls_loopback_literals_are_excluded`, `test_insecure_api_base_urls_non_exempt_forms_are_included`, `test_insecure_api_base_urls_emits_no_warnings`.

- [ ] **Step 1: Replace the HTTPS-rejection test with the new provider tests**

In `tests/test_backend.py`, replace the entire `test_non_loopback_provider_requires_https` function (lines 283-288) with:

```python
@pytest.mark.parametrize(
    ("api_base", "expected"),
    [
        ("http://provider.example/", "http://provider.example"),
        ("http://provider.example", "http://provider.example"),
        ("http://127.0.0.1:8000", "http://127.0.0.1:8000"),
    ],
)
def test_non_loopback_provider_allows_http(api_base: str, expected: str) -> None:
    config = main.AIConfig(api_base=api_base, api_key="key", model="model")

    assert config.api_base == expected


def test_provider_override_allows_http() -> None:
    override = main.ProviderOverride(api_base="http://provider.example")

    assert override.api_base == "http://provider.example"


@pytest.mark.parametrize(
    ("api_base", "message"),
    [
        ("http://[bad", "api_base must be a valid absolute HTTP(S) URL"),
        ("ftp://provider.example", "api_base must be a valid absolute HTTP(S) URL"),
        ("provider.example", "api_base must be a valid absolute HTTP(S) URL"),
        ("http://", "api_base must be a valid absolute HTTP(S) URL"),
        (
            "http://provider.example/v1?key=1",
            "api_base must not include query, fragment, or user-info components",
        ),
        (
            "http://provider.example/v1#frag",
            "api_base must not include query, fragment, or user-info components",
        ),
        (
            "http://user@provider.example",
            "api_base must not include query, fragment, or user-info components",
        ),
        (
            "http://user:pass@provider.example",
            "api_base must not include query, fragment, or user-info components",
        ),
    ],
)
def test_provider_rejects_invalid_structure(api_base: str, message: str) -> None:
    with pytest.raises(main.ValidationError) as exc_info:
        main.AIConfig(api_base=api_base, api_key="key", model="model")

    assert message in str(exc_info.value)
```

- [ ] **Step 2: Add the `_insecure_api_base_urls` tests after `test_provider_rejects_invalid_ports`**

In `tests/test_backend.py`, insert this block immediately after the body of `test_provider_rejects_invalid_ports` (after line 297 in the base commit, before `def test_provider_response_requires_choices`):

```python
@pytest.mark.parametrize(
    ("ai", "expected"),
    [
        (
            main.AIConfig(api_base="http://provider.example"),
            ["http://provider.example"],
        ),
        (
            main.AIConfig(
                api_base="https://api.example",
                text=main.ProviderOverride(api_base="http://text.example"),
            ),
            ["http://text.example"],
        ),
        (
            main.AIConfig(
                api_base="http://base.example",
                ocr=main.ProviderOverride(api_base="http://ocr.example"),
                text=main.ProviderOverride(api_base="http://text.example"),
            ),
            ["http://base.example", "http://ocr.example", "http://text.example"],
        ),
        (
            main.AIConfig(
                api_base="http://provider.example",
                text=main.ProviderOverride(api_base="http://provider.example"),
            ),
            ["http://provider.example"],
        ),
        (
            main.AIConfig(
                api_base="https://api.example",
                text=main.ProviderOverride(api_base="   "),
            ),
            [],
        ),
        (
            main.AIConfig(api_base="HTTP://PROVIDER.EXAMPLE"),
            ["HTTP://PROVIDER.EXAMPLE"],
        ),
        (
            main.AIConfig(
                api_base="http://provider.example",
                text=main.ProviderOverride(api_base="HTTP://PROVIDER.EXAMPLE"),
            ),
            ["http://provider.example", "HTTP://PROVIDER.EXAMPLE"],
        ),
        (None, []),
    ],
)
def test_insecure_api_base_urls_base_and_override_coverage(
    ai: main.AIConfig | None, expected: list[str]
) -> None:
    assert main._insecure_api_base_urls(ai) == expected


@pytest.mark.parametrize(
    "api_base",
    [
        "http://localhost",
        "http://LOCALHOST",
        "http://127.0.0.1",
        "http://[::1]",
        "http://[::1]:8000",
    ],
)
def test_insecure_api_base_urls_loopback_literals_are_excluded(api_base: str) -> None:
    assert main._insecure_api_base_urls(main.AIConfig(api_base=api_base)) == []


@pytest.mark.parametrize(
    "api_base",
    [
        "http://127.0.0.2",
        "http://localhost.",
        "http://[0:0:0:0:0:0:0:1]",
    ],
)
def test_insecure_api_base_urls_non_exempt_forms_are_included(api_base: str) -> None:
    assert main._insecure_api_base_urls(main.AIConfig(api_base=api_base)) == [api_base]


def test_insecure_api_base_urls_emits_no_warnings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    warnings: list[object] = []
    monkeypatch.setattr(main.logger, "warning", lambda *args, **kwargs: warnings.append(args))

    assert main._insecure_api_base_urls(
        main.AIConfig(api_base="http://provider.example")
    ) == ["http://provider.example"]
    assert warnings == []
```

- [ ] **Step 3: Run the new tests and confirm they fail**

If pytest or its plugins are missing from the environment, install the backend dev dependencies first with `(cd backend && pip install --require-hashes -r requirements-dev.lock)` so the working directory stays at the repository root.

Run: `python -m pytest tests/test_backend.py -v -k "provider_allows_http or insecure_api_base_urls or rejects_invalid_structure"`

Expected: FAIL. `test_non_loopback_provider_allows_http` fails for the two non-loopback rows with `api_base must use HTTPS unless it targets a loopback provider` (the `http://127.0.0.1:8000` row passes); `test_provider_override_allows_http` fails with the same message; all four `test_insecure_api_base_urls_*` tests fail with `AttributeError: module 'backend.main' has no attribute '_insecure_api_base_urls'`; `test_provider_rejects_invalid_structure` passes because those rejection messages already exist and are regression-pinned by this test.

- [ ] **Step 4: Implement the `backend/main.py` changes**

Edit 4a: replace the body of `_validate_api_base_value` (base-commit lines 136-160) with exactly:

```python
def _validate_api_base_value(value: str) -> str:
    normalized = value.strip().rstrip("/")
    try:
        parsed = urlsplit(normalized)
    except ValueError as exc:
        raise ValueError("api_base must be a valid absolute HTTP(S) URL") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("api_base must be a valid absolute HTTP(S) URL")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("api_base must include a valid port between 1 and 65535") from exc
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("api_base must include a valid port between 1 and 65535")
    if (
        "?" in normalized
        or "#" in normalized
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("api_base must not include query, fragment, or user-info components")
    return normalized
```

This deletes the final `loopback = ...` local and the two statements after it, and adds nothing else. The function keeps no docstring.

Edit 4b: insert `_is_loopback_hostname` immediately after `_validate_api_base_value`, before `class ProviderOverride` (base-commit insertion point between lines 160 and 163):

```python
def _is_loopback_hostname(hostname: str) -> bool:
    """True only for the exact literals localhost, 127.0.0.1, and ::1."""
    return hostname.lower().strip("[]") in {"localhost", "127.0.0.1", "::1"}
```

Edit 4c: insert `_insecure_api_base_urls` immediately after the `AIConfig` class, before `class AppConfig` (base-commit insertion point between lines 191 and 194):

```python
def _insecure_api_base_urls(ai: AIConfig | None) -> list[str]:
    """Return the deduplicated non-loopback http:// api_base values, base first."""

    if ai is None:
        return []
    candidates: list[str] = [ai.api_base]
    if ai.ocr is not None:
        candidates.append(ai.ocr.api_base)
    if ai.text is not None:
        candidates.append(ai.text.api_base)
    seen: set[str] = set()
    insecure: list[str] = []
    for value in candidates:
        normalized = value.strip()
        if not normalized or normalized in seen:
            continue
        parsed = urlsplit(normalized)
        if parsed.scheme != "http" or _is_loopback_hostname(parsed.hostname or ""):
            continue
        seen.add(normalized)
        insecure.append(normalized)
    return insecure
```

Do not add any `try`/`except` around `urlsplit` in this helper and do not call the helper from `load_config` in this task.

- [ ] **Step 5: Run the backend tests and confirm they pass**

Run: `python -m pytest tests/test_backend.py -v`

Expected: PASS, zero failures and zero errors, including the deleted `test_non_loopback_provider_requires_https`, which no longer exists.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py tests/test_backend.py
git commit -m "feat(backend): allow plain http api_base and add insecure-url helper"
```

## Task 2: Warn once per insecure `api_base` from `load_config`

**Implementer tier:** Standard
**Lane hint:** backend-core

**Files:**

- Modify: `backend/main.py:307-308` — insert the warning pass between `_config_cache = (signature, config)` and `return config` inside `load_config` (base-commit lines; after Task 1's insertions, locate those two lines by their exact content).
- Modify: `tests/test_backend.py:23-27` — add `main._config_cache = None` to `reset_backend_globals`.
- Test: `tests/test_backend.py:425-428` — insert the two `load_config` warning tests after `test_config_schema_rejects_invalid_ranges` (base-commit lines; locate the function by name because Task 1 shifts it down).

**Interfaces:**

- Consumes: `_insecure_api_base_urls(ai: AIConfig | None) -> list[str]` and `_is_loopback_hostname(hostname: str) -> bool` produced by Task 1 and already present in `backend/main.py`; existing `load_config() -> AppConfig` (`backend/main.py:293`), the `textkit` `logger` (`backend/main.py:114`), `_config_cache` (`backend/main.py:261`), `CONFIG_PATH` (`backend/main.py:43`), `urlsplit`, and `_resolve_ai_config(base: AIConfig, override: ProviderOverride | None) -> AIConfig` (`backend/main.py:345`).
- Produces:
  - `load_config() -> AppConfig` emits exactly one warning per URL returned by `_insecure_api_base_urls(config.ai)`, after `_config_cache = (signature, config)` and before `return config`; the early cache-hit return above the pass guarantees no warning on a cache hit.
  - `tests/test_backend.py` test functions: `test_load_config_warns_on_insecure_api_base`, `test_load_config_does_not_rewarn_for_unchanged_config`.
  - `reset_backend_globals` fixture also resets `main._config_cache` to `None`.

- [ ] **Step 1: Reset the config cache in the autouse fixture**

In `tests/test_backend.py`, replace `reset_backend_globals` (lines 23-27) with exactly:

```python
@pytest.fixture(autouse=True)
def reset_backend_globals() -> None:
    main._prompt_cache.clear()
    main._rate_events.clear()
    main._active_requests = 0
    main._config_cache = None
```

- [ ] **Step 2: Write the two failing `load_config` warning tests**

In `tests/test_backend.py`, insert this block immediately after the final `main.load_config()` line of `test_config_schema_rejects_invalid_ranges` and before `def test_credentials_are_resolved_lazily_per_operation` (base-commit insertion point between lines 425 and 428):

```python
def test_load_config_warns_on_insecure_api_base(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.yaml"
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    warnings: list[tuple[str, tuple[object, ...], object]] = []

    def capture(message: str, *args: object, **kwargs: object) -> None:
        warnings.append((message, args, kwargs.get("extra")))

    monkeypatch.setattr(main.logger, "warning", capture)

    config_path.write_text(
        "ai:\n"
        "  api_base: http://provider.example:8080\n"
        "  text:\n"
        "    api_base: http://text.example\n",
        encoding="utf-8",
    )
    main._config_cache = None
    config = main.load_config()

    assert config.ai is not None
    assert warnings == [
        (
            "api_base uses unencrypted HTTP for non-loopback host %s; prefer HTTPS",
            ("provider.example",),
            {"event": "config.insecure_api_base"},
        ),
        (
            "api_base uses unencrypted HTTP for non-loopback host %s; prefer HTTPS",
            ("text.example",),
            {"event": "config.insecure_api_base"},
        ),
    ]

    warnings.clear()
    config_path.write_text(
        "ai:\n"
        "  api_base: https://provider.example\n"
        "  text:\n"
        "    api_base: http://127.0.0.1:9000\n",
        encoding="utf-8",
    )
    main._config_cache = None
    main.load_config()

    assert warnings == []

    warnings.clear()
    config_path.write_text("ai: null\n", encoding="utf-8")
    main._config_cache = None
    config = main.load_config()

    assert config.ai is None
    assert warnings == []


def test_load_config_does_not_rewarn_for_unchanged_config(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "ai:\n"
        "  api_base: http://provider.example\n"
        "  text:\n"
        "    api_base: http://text.example\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    warnings: list[tuple[str, tuple[object, ...], object]] = []

    def capture(message: str, *args: object, **kwargs: object) -> None:
        warnings.append((message, args, kwargs.get("extra")))

    monkeypatch.setattr(main.logger, "warning", capture)

    main._config_cache = None
    config = main.load_config()
    assert len(warnings) == 2

    assert main.load_config() is config
    assert len(warnings) == 2

    main._resolve_ai_config(config.ai, config.ai.text)
    assert len(warnings) == 2
```

- [ ] **Step 3: Run the new tests and confirm they fail**

Run: `python -m pytest tests/test_backend.py -v -k "load_config_warns or does_not_rewarn"`

Expected: FAIL. `test_load_config_warns_on_insecure_api_base` fails at `assert warnings == [...]` because no warning pass exists yet, so `warnings` is empty. `test_load_config_does_not_rewarn_for_unchanged_config` fails at `assert len(warnings) == 2` with `assert 0 == 2`.

- [ ] **Step 4: Wire the warning pass into `load_config`**

In `backend/main.py`, replace the current `load_config` function (base-commit lines 293-308) with exactly:

```python
def load_config() -> AppConfig:
    """Load and validate config.yaml, caching it until the file changes."""

    global _config_cache
    signature = _config_signature()
    if _config_cache and _config_cache[0] == signature:
        return _config_cache[1]
    raw = _load_yaml_config()
    if "save_root" in raw:
        raise RuntimeError("save_root was removed; file saving belongs to the authenticated file bridge")
    try:
        config = AppConfig.model_validate(raw)
    except ValidationError as exc:
        raise RuntimeError(f"Invalid config.yaml: {exc}") from exc
    _config_cache = (signature, config)
    for url in _insecure_api_base_urls(config.ai):
        host = urlsplit(url).hostname or ""
        logger.warning(
            "api_base uses unencrypted HTTP for non-loopback host %s; prefer HTTPS",
            host,
            extra={"event": "config.insecure_api_base"},
        )
    return config
```

The only delta is the warning loop between `_config_cache = (signature, config)` and `return config`. Keep the format string, the `host` argument, and the `extra` dict exactly as written.

- [ ] **Step 5: Run the full backend suite and the manual smoke check**

Run: `python -m pytest tests/ -v`

Expected: PASS, zero failures and zero errors. The new/changed tests are all present and passing: `test_non_loopback_provider_allows_http` (3 cases), `test_provider_override_allows_http`, `test_provider_rejects_invalid_structure` (8 cases), `test_insecure_api_base_urls_base_and_override_coverage` (8 cases), `test_insecure_api_base_urls_loopback_literals_are_excluded` (5 cases), `test_insecure_api_base_urls_non_exempt_forms_are_included` (3 cases), `test_insecure_api_base_urls_emits_no_warnings`, `test_load_config_warns_on_insecure_api_base`, `test_load_config_does_not_rewarn_for_unchanged_config`.

Run this smoke check from the repository root:

```sh
printf 'ai:\n  api_base: http://provider.example\n' > /tmp/textkit-smoke.yaml
python - <<'EOF'
from pathlib import Path
from backend import main
main.CONFIG_PATH = Path("/tmp/textkit-smoke.yaml")
main._config_cache = None
main.load_config()
main.load_config()  # cache hit: must print nothing extra
EOF
```

Expected: exactly one JSON line on stderr whose `level` is `WARNING`, `logger` is `textkit`, `message` is `api_base uses unencrypted HTTP for non-loopback host provider.example; prefer HTTPS`, and `event` is `config.insecure_api_base`; the second in-process call prints no warning. Then run the same script with the file written as `ai:\n  api_base: http://127.0.0.1:8000\n` and again as `ai:\n  api_base: https://provider.example\n`; each run prints no warning line.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py tests/test_backend.py
git commit -m "feat(backend): warn on insecure non-loopback http api_base at config load"
```

## Task 3: Update the README and example config for HTTP acceptance

**Implementer tier:** Standard
**Lane hint:** docs

**Files:**

- Modify: `README.md:240` — replace the final sentence of the `api_base` bullet.
- Modify: `backend/config.example.yaml:64-65` — replace the two-line HTTPS comment.

**Interfaces:**

- Consumes: nothing from code; both replacements are exact text from the approved specification.
- Produces: no callable interface; the README `api_base` bullet and the `backend/config.example.yaml` comment both state that HTTP is accepted for any provider host and that non-loopback HTTP logs a startup warning.

- [ ] **Step 1: Replace the README sentence**

In `README.md`, replace the `api_base` bullet at line 240 with exactly:

```markdown
- `api_base`: base provider URL without a trailing slash. Must expose `/v1/chat/completions`. HTTP is accepted for any host, but non-loopback HTTP is unencrypted and the backend logs a startup warning; prefer HTTPS.
```

No other README text changes.

- [ ] **Step 2: Replace the example-config comment**

In `backend/config.example.yaml`, replace the two-line comment at lines 64-65:

```text
  # Non-loopback providers must use HTTPS. Plain HTTP is accepted only for
  # localhost, 127.0.0.1, and ::1 development providers.
```

with exactly:

```text
  # HTTP is accepted for any provider host. Non-loopback HTTP is unencrypted and
  # the backend logs a startup warning at config load; prefer HTTPS.
```

No other example-config text changes.

- [ ] **Step 3: Run the backend and Node suites**

Run: `python -m pytest tests/ -v`

Expected: PASS, zero failures and zero errors.

Run: `node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js`

Expected: each script exits 0 with no failures.

- [ ] **Step 4: Run the extra extension end-to-end check**

Run: `node tests/extension_e2e.test.js`

Expected: exits 0, or reports a missing-prerequisite skip. Record the outcome (pass, or skip with its reason) in the task report; this check is not part of the CLAUDE.md command.

- [ ] **Step 5: Verify the implementation diff contains exactly the four target files**

Run:

```bash
START_OID=$(git log -1 --format=%H -- docs/superpowers/plans/2026-09-30-http-api-base.md)
git diff --stat "$START_OID"
```

Expected: exactly these four tracked files appear: `backend/main.py`, `backend/config.example.yaml`, `README.md`, `tests/test_backend.py`. The spec and design documents were committed before implementation and must not appear.

- [ ] **Step 6: Commit**

```bash
git add README.md backend/config.example.yaml
git commit -m "docs(config): document http api_base acceptance and load-time warning"
```

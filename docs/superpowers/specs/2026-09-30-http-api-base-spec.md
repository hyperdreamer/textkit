# Allow Plain HTTP for `api_base` — Technical Specification

- Date: 2026-09-30
- Topic slug: `http-api-base`
- Approved design: `docs/superpowers/specs/2026-09-30-http-api-base-design.md`
- Integration base: `d2fcdaf3b724a359c7c592760ef0c38e4b628461`
- Status: ready for implementation

Implementation targets (all four, and only these four, may change):

| File | Change |
| --- | --- |
| `backend/main.py` | Drop HTTPS-only rejection; add `_is_loopback_hostname`, `_insecure_api_base_urls`, warning pass in `load_config` |
| `tests/test_backend.py` | Fixture reset; replace/add validation tests; add helper and `load_config` warning tests |
| `README.md` | Replace one sentence in the `api_base` bullet |
| `backend/config.example.yaml` | Replace the two-line HTTPS comment |

Out of scope (from design): no opt-in config flag, no extension changes, no new
schemes, no widened hostname/port/query/fragment/user-info acceptance, no change
to loopback literal set, no change to `ai: null` behavior.

---

## 1. `backend/main.py`

### 1.1 `_validate_api_base_value` — post-change contract

Placement is unchanged (currently `backend/main.py:136`, between `TimeoutConfig`
and `ProviderOverride`). Signature is unchanged. **Docstring: none** — the design
does not add one and the existing function has none (spec decision S1).

Exact post-change function body:

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

The only delta from today: the final two statements

```python
    loopback = parsed.hostname.lower().strip("[]") in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not loopback:
        raise ValueError("api_base must use HTTPS unless it targets a loopback provider")
```

are deleted. `value.strip().rstrip("/")` normalization and original-case return are
preserved. `ProviderOverride.validate_api_base` and `AIConfig.validate_api_base`
are untouched and still delegate to this function.

### 1.2 `_is_loopback_hostname`

Placement: immediately after `_validate_api_base_value` (before `ProviderOverride`).
The validator no longer calls it; it is called only from `_insecure_api_base_urls`.

```python
def _is_loopback_hostname(hostname: str) -> bool:
    """True only for the exact literals localhost, 127.0.0.1, and ::1."""
    return hostname.lower().strip("[]") in {"localhost", "127.0.0.1", "::1"}
```

Exact behavior (do not broaden the set): `localhost.`, `127.0.0.2`,
`[0:0:0:0:0:0:0:1]`, and any other hostname are **not** loopback. `urlsplit`
already lowercases the scheme and hostname, but the `.lower()` keeps the helper
correct when called directly.

### 1.3 `_insecure_api_base_urls`

Placement: immediately after the `AIConfig` class definition (before `AppConfig`),
so the annotation resolves naturally. **Docstring text is a spec decision (S2)** —
the design specifies behavior but not wording.

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

Contract details:

- Candidate order is fixed: base → `ocr` → `text`. `ocr`/`text` are appended only
  when their override object is not `None`.
- Values arriving from a validated `AIConfig` are already normalized by
  `_validate_api_base_value` (trimmed, no trailing slash). `value.strip()` is the
  defensive equivalent; dedup key is the validator-normalized string.
- Empty/whitespace override values are skipped (`ProviderOverride` maps whitespace
  to `""`). A base `api_base` can never be empty after validation.
- Dedup is first-occurrence-wins and case-sensitive on the exact normalized
  string: the string is returned in original case, so `HTTP://PROVIDER.EXAMPLE`
  is returned unchanged, and `http://provider.example` vs. `HTTP://PROVIDER.EXAMPLE`
  are two distinct entries that each warn.
- `urlsplit` lowercases the scheme, so uppercase `HTTP://` is detected as insecure
  without extra casing logic.
- No `try`/`except` around `urlsplit`: the input is preconditioned to be a
  validated value; a malformed value raises from the validator before this helper
  is ever called (spec decision S8).
- The helper is pure: no logging, no globals, no side effects.

### 1.4 `load_config` wiring — exact placement

Exact resulting function:

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

Placement decision (S3): the warning pass goes **after** the successful
`AppConfig.model_validate`, **after** `_config_cache = (signature, config)`, and
immediately **before** `return config`.

- The early cache-hit `return` at the top of the function is above the pass, so the
  pass runs exactly once per cache miss (once per process per config version) and
  never on a hit. Whether the pass is before or after cache assignment does not
  change that; the early return is the guarantee.
- Publishing the cache first means a hypothetical exception from the log sink
  cannot leave the config uncached and cause repeated re-validation and repeated
  warnings on subsequent `_get_config()` calls. This is the reason for choosing
  "after assignment".
- A config that fails validation raises `RuntimeError` before the pass, so it can
  never warn.

---

## 2. Warning behavior contract

The **only** new warning call added by this change is the one inside
`load_config` above.

- Trigger: `urlsplit(url).scheme == "http"` (lowercased by `urlsplit`, so uppercase
  schemes match) **and** `_is_loopback_hostname(hostname)` is false.
- Hostname derivation: `host = urlsplit(url).hostname or ""`. The port never
  appears in the message (`urlsplit("http://provider.example:8080").hostname` is
  `"provider.example"`). IPv6 brackets are stripped by `urlsplit`.
- Exact log call (format string, argument, and extras are pinned):

  ```python
  logger.warning(
      "api_base uses unencrypted HTTP for non-loopback host %s; prefer HTTPS",
      host,
      extra={"event": "config.insecure_api_base"},
  )
  ```

- Ordering: `_insecure_api_base_urls` yields base → `ocr` → `text`; warnings are
  emitted in that order.
- Dedup: one warning per unique normalized URL. If the base and an override carry
  the same URL, the first occurrence (base) wins.
- None-safety: `config.ai is None` yields `[]` and emits nothing.
- Sink: the existing `textkit` JSON logger, formatter `JsonFormatter`. It emits
  `event` from `record.event` and silently drops any other extra key, so `extra`
  must contain `event` only.
- Non-emission guarantee: no warning is emitted from `_resolve_ai_config`, from
  `_validate_api_base_value`, from any pydantic `field_validator`, or from
  `_insecure_api_base_urls`. `_resolve_ai_config` is not modified by this change;
  every override value it consumes already passed through the load-time pass.
- Re-warning semantics: multiple worker processes may each warn once per config
  version (acceptable, documented). Within one process, an unchanged
  `(mtime_ns, size)` signature hits the cache and does not re-validate or re-warn.

---

## 3. Error behavior — unchanged

`_validate_api_base_value` raises `ValueError` (wrapped by pydantic as
`ValidationError` at the model boundary). All messages below are exactly the
current ones; none change.

| Rejected shape | Example input | Exact message |
| --- | --- | --- |
| Unparseable URL (bad IPv6 brackets) | `http://[bad` | `api_base must be a valid absolute HTTP(S) URL` |
| Scheme not `http`/`https` | `ftp://provider.example`, `provider.example` | `api_base must be a valid absolute HTTP(S) URL` |
| Missing hostname | `http://`, `http:///v1` | `api_base must be a valid absolute HTTP(S) URL` |
| Non-numeric / out-of-range port (raised by `parsed.port`) | `https://example.com:bad`, `https://example.com:70000` | `api_base must include a valid port between 1 and 65535` |
| Port below range (surfaced by explicit check) | `https://example.com:0` | `api_base must include a valid port between 1 and 65535` |
| Query | `http://provider.example/v1?key=1` | `api_base must not include query, fragment, or user-info components` |
| Fragment | `http://provider.example/v1#frag` | `api_base must not include query, fragment, or user-info components` |
| User-info | `http://user@provider.example`, `http://user:pass@provider.example` | `api_base must not include query, fragment, or user-info components` |

Additional unchanged guarantees: an `http://` endpoint with an invalid port fails
at validation, before the warning pass is reached; a config that fails validation
never reaches the warning pass; `ai: null` loads without warning and without
raising.

---

## 4. Tests — `tests/test_backend.py`

### 4.1 Autouse fixture change

Replace `reset_backend_globals` with:

```python
@pytest.fixture(autouse=True)
def reset_backend_globals() -> None:
    main._prompt_cache.clear()
    main._rate_events.clear()
    main._active_requests = 0
    main._config_cache = None
```

The added line prevents a tmp-config `load_config()` test from leaking a cache
entry into any later test.

Test placement (S10): provider-validation tests replace
`test_non_loopback_provider_requires_https` (in place, immediately before
`test_provider_rejects_invalid_ports`); the `_insecure_api_base_urls` tests go
immediately after `test_provider_rejects_invalid_ports`; the two `load_config`
warning tests go immediately after `test_config_schema_rejects_invalid_ranges`.

### 4.2 Deleted test

Delete `test_non_loopback_provider_requires_https` exactly as it exists today.

### 4.3 `test_non_loopback_provider_allows_http` (replacement)

Arrange: construct `AIConfig` for each parameter row. Act: construct the model.
Assert: normalized `api_base` equals expected. Matrix:

| `api_base` input | expected `config.api_base` |
| --- | --- |
| `"http://provider.example/"` | `"http://provider.example"` |
| `"http://provider.example"` | `"http://provider.example"` |
| `"http://127.0.0.1:8000"` | `"http://127.0.0.1:8000"` |

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
```

### 4.4 `test_provider_override_allows_http`

Arrange: construct `ProviderOverride`. Act: construct the model. Assert: value is
preserved.

```python
def test_provider_override_allows_http() -> None:
    override = main.ProviderOverride(api_base="http://provider.example")

    assert override.api_base == "http://provider.example"
```

### 4.5 `test_provider_rejects_invalid_structure`

Arrange: parametrized invalid value with its expected message. Act: construct
`AIConfig`. Assert: `ValidationError` whose text contains the exact message.
Rejection is exercised through `AIConfig` only; `_validate_api_base_value` is the
shared implementation used by `ProviderOverride` (spec decision S9). The assertion
uses `message in str(exc_info.value)` rather than `pytest.raises(match=...)`
because the first message contains regex metacharacters in `HTTP(S)` (spec
decision S11).

| `api_base` input | expected message |
| --- | --- |
| `"http://[bad"` | `api_base must be a valid absolute HTTP(S) URL` |
| `"ftp://provider.example"` | `api_base must be a valid absolute HTTP(S) URL` |
| `"provider.example"` | `api_base must be a valid absolute HTTP(S) URL` |
| `"http://"` | `api_base must be a valid absolute HTTP(S) URL` |
| `"http://provider.example/v1?key=1"` | `api_base must not include query, fragment, or user-info components` |
| `"http://provider.example/v1#frag"` | `api_base must not include query, fragment, or user-info components` |
| `"http://user@provider.example"` | `api_base must not include query, fragment, or user-info components` |
| `"http://user:pass@provider.example"` | `api_base must not include query, fragment, or user-info components` |

```python
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

### 4.6 `_insecure_api_base_urls` unit tests

Test names for the three helper tests are spec decisions (S5); the design names
only the provider and `load_config` tests.

**`test_insecure_api_base_urls_base_and_override_coverage`** — one parameter row
per scenario. Arrange: build the `AIConfig | None` in the row. Act: call the
helper. Assert: `== expected`.

| `ai` | expected |
| --- | --- |
| `AIConfig(api_base="http://provider.example")` | `["http://provider.example"]` |
| `AIConfig(api_base="https://api.example", text=ProviderOverride(api_base="http://text.example"))` | `["http://text.example"]` |
| `AIConfig(api_base="http://base.example", ocr=ProviderOverride(api_base="http://ocr.example"), text=ProviderOverride(api_base="http://text.example"))` | `["http://base.example", "http://ocr.example", "http://text.example"]` (pins the full base → ocr → text order) |
| `AIConfig(api_base="http://provider.example", text=ProviderOverride(api_base="http://provider.example"))` | `["http://provider.example"]` (dedup, base wins) |
| `AIConfig(api_base="https://api.example", text=ProviderOverride(api_base="   "))` | `[]` (whitespace override skipped) |
| `AIConfig(api_base="HTTP://PROVIDER.EXAMPLE")` | `["HTTP://PROVIDER.EXAMPLE"]` (uppercase scheme detected; original case preserved) |
| `AIConfig(api_base="http://provider.example", text=ProviderOverride(api_base="HTTP://PROVIDER.EXAMPLE"))` | `["http://provider.example", "HTTP://PROVIDER.EXAMPLE"]` (case-sensitive dedup) |
| `None` | `[]` |

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
```

**`test_insecure_api_base_urls_loopback_literals_are_excluded`** — each row builds
`AIConfig(api_base=api_base)` and asserts `[]`. Matrix:
`["http://localhost", "http://LOCALHOST", "http://127.0.0.1", "http://[::1]", "http://[::1]:8000"]`.

```python
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
```

**`test_insecure_api_base_urls_non_exempt_forms_are_included`** — each row builds
`AIConfig(api_base=api_base)` and asserts `[api_base]`. Matrix:
`["http://127.0.0.2", "http://localhost.", "http://[0:0:0:0:0:0:0:1]"]`.

```python
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
```

### 4.6b `test_insecure_api_base_urls_emits_no_warnings`

Pins the purity clause: the helper itself never logs. Patch `main.logger.warning`
with a recording callable, call the helper on a non-loopback `http://` config, and
assert the recording is empty.

```python
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

### 4.7 `test_load_config_warns_on_insecure_api_base`

Strategy: tmp `CONFIG_PATH` (modeled on `test_config_schema_rejects_invalid_ranges`),
`main._config_cache = None` before every load, and warning capture by patching
`main.logger.warning` (the `textkit` logger sets `propagate = False`, so `caplog`
cannot see these records). The capture records
`(format_string, args_tuple, extra)` so the exact message, host argument, and
`event` extra are all pinned (spec decision S6).

Phase 1 (two warnings, base → text): write
`ai.api_base: http://provider.example:8080` plus
`ai.text.api_base: http://text.example`; reset cache; `load_config()`; assert the
two captured warnings are exactly (the explicit port pins `hostname` rather than
`netloc` in the warning argument):

```python
[
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
```

Phase 2 (no warnings): write `ai.api_base: https://provider.example` plus
`ai.text.api_base: http://127.0.0.1:9000` (HTTPS base and loopback override — spec
decision S7); reset cache; clear captured warnings; `load_config()`; assert `[]`.

Phase 3 (`ai: null`): write `ai: null`; reset cache; clear captured warnings;
`load_config()`; assert `config.ai is None` and `[]`.

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
```

### 4.8 `test_load_config_does_not_rewarn_for_unchanged_config`

Purpose: falsifiable pin against warning-at-validation-time and against
`_resolve_ai_config` warning. Arrange/write the same two-insecure-URL config as
phase 1, patch capture and `CONFIG_PATH`, reset cache. Act/assert:

1. First `load_config()` → `len(warnings) == 2`.
2. Second `load_config()` with the unchanged file → returns the **same object**
   (`is config`) and `len(warnings) == 2` (cache hit, no re-validation, no
   re-warning).
3. `main._resolve_ai_config(config.ai, config.ai.text)` → `len(warnings) == 2`
   (request path is silent). `config` is the `AppConfig` returned by `load_config`;
   the AI config is `config.ai` and the text override is `config.ai.text`.

```python
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

---

## 5. Documentation — exact replacement text

### 5.1 `README.md`

In the `api_base` bullet (currently `README.md:240`), replace **only** the final
sentence `Non-loopback providers must use HTTPS.` so the bullet reads exactly:

```markdown
- `api_base`: base provider URL without a trailing slash. Must expose `/v1/chat/completions`. HTTP is accepted for any host, but non-loopback HTTP is unencrypted and the backend logs a startup warning; prefer HTTPS.
```

### 5.2 `backend/config.example.yaml`

Replace the two-line comment (currently inside the `ai:` block, two-space indent):

```text
  # Non-loopback providers must use HTTPS. Plain HTTP is accepted only for
  # localhost, 127.0.0.1, and ::1 development providers.
```

with exactly:

```text
  # HTTP is accepted for any provider host. Non-loopback HTTP is unencrypted and
  # the backend logs a startup warning at config load; prefer HTTPS.
```

No other README or example-config text changes.

---

## 6. Verification

Run from the repository root unless noted.

1. Install backend dev dependencies if the environment lacks them (README
   "Development Notes"):
   `cd backend && pip install --require-hashes -r requirements-dev.lock`
2. `python -m pytest tests/ -v` → zero failures, zero errors. Expected new/changed
   tests all present and passing: `test_non_loopback_provider_allows_http` (3
   parameter cases), `test_provider_override_allows_http`,
   `test_provider_rejects_invalid_structure` (8 cases),
   `test_insecure_api_base_urls_base_and_override_coverage` (8 cases),
   `test_insecure_api_base_urls_loopback_literals_are_excluded` (5 cases),
   `test_insecure_api_base_urls_non_exempt_forms_are_included` (3 cases),
   `test_insecure_api_base_urls_emits_no_warnings`,
   `test_load_config_warns_on_insecure_api_base`,
   `test_load_config_does_not_rewarn_for_unchanged_config`.
3. `node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js`
   → each exits 0 with no failures.
4. Extra check (not in the CLAUDE.md command): `node tests/extension_e2e.test.js` →
   record pass or missing-prerequisite skip in the implementation notes.
5. Manual smoke (programmatic equivalent of the startup path, which calls
   `load_config` in `lifespan`). Run from the **repository root** so
   `from backend import main` resolves:

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

   Expected: exactly one JSON line to stderr whose `level` is `WARNING`, `logger`
   is `textkit`, `message` is
   `api_base uses unencrypted HTTP for non-loopback host provider.example; prefer HTTPS`,
   and `event` is `config.insecure_api_base`; the second in-process call prints no
   warning. A fresh process run warns again (once per process). Replacing the URL
   with `http://127.0.0.1:8000` or `https://provider.example` prints no warning line.
6. `git diff --stat <implementation-start-oid>` — the implementation plan pins the
   OID of the integration-branch tip immediately before the first implementation
   commit (after the design, spec, and plan commits); the diff must show exactly
   four tracked files: `backend/main.py`, `backend/config.example.yaml`, `README.md`,
   `tests/test_backend.py`. The spec and design documents are committed before
   implementation and do not appear in the implementation diff.

---

## 7. Spec decisions log

| ID | Decision | Rationale |
| --- | --- | --- |
| S1 | `_validate_api_base_value` keeps no docstring. | Design changes behavior only and does not add one; smallest diff. |
| S2 | `_insecure_api_base_urls` docstring: `"""Return the deduplicated non-loopback http:// api_base values, base first."""` | Design pins behavior, not wording; a one-line docstring documents the private contract. |
| S3 | Warning pass after `_config_cache = (signature, config)`, before `return config`. | Early cache-hit return already guarantees once-per-cache-miss; publishing first prevents repeated re-validation/warning if the log sink ever raises. |
| S4 | `_is_loopback_hostname` directly after `_validate_api_base_value`; `_insecure_api_base_urls` directly after `AIConfig`. | Keeps helpers adjacent to their contracts; `AIConfig` is the annotation type. |
| S5 | Helper test names: `test_insecure_api_base_urls_base_and_override_coverage`, `..._loopback_literals_are_excluded`, `..._non_exempt_forms_are_included`. | Design names only provider and `load_config` tests; these names are explicit and scenario-descriptive. |
| S6 | Warning capture records `(format_string, args, extra)` rather than just rendered messages. | Directly pins the exact format string, host argument, and `event` extra required by this spec. |
| S7 | Phase 2 "all-HTTPS/loopback" config: base `https://provider.example`, text override `http://127.0.0.1:9000`. | Exercises both silent classes (HTTPS and loopback HTTP) in one load. |
| S8 | `_insecure_api_base_urls` has no `try`/`except` around `urlsplit`; dedup `seen` grows only when a URL is appended. | Inputs are validator-normalized by the `AIConfig` contract; append-only dedup implements "first occurrence wins". |
| S9 | `test_provider_rejects_invalid_structure` exercises `AIConfig` only. | Both surfaces share `_validate_api_base_value`; acceptance of the second surface is covered by `test_provider_override_allows_http`. |
| S10 | Placement of new tests: provider/helper tests replace/join lines around the old HTTPS test; `load_config` tests follow `test_config_schema_rejects_invalid_ranges`. | Keeps related tests together and reuses the existing tmp-config pattern. |
| S11 | `test_provider_rejects_invalid_structure` asserts `message in str(exc_info.value)` instead of `pytest.raises(match=message)`. | The `api_base must be a valid absolute HTTP(S) URL` message contains regex groups; a literal `match=` pattern would look for `HTTPS` and fail. |

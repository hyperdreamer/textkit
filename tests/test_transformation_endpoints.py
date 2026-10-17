"""Endpoint orchestration tests for the completed-transformation cache."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend import main
from backend.transformation_cache import (
    CacheMaintenanceResult,
    CacheReadResult,
    CacheRecord,
    CacheWriteResult,
)


@pytest.fixture(autouse=True)
def isolate_endpoint_settings(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "CONFIG_PATH", tmp_path / "config.yaml")
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path / "prompts")
    monkeypatch.setattr(main, "_config_cache", None)
    monkeypatch.setattr(main, "_prompt_cache", {})
    main._rate_events.clear()
    monkeypatch.setattr(main, "_active_requests", 0)


def _ai_config(**overrides) -> main.AIConfig:
    values = {
        "api_base": "https://example.invalid",
        "api_key": "test-key",
        "model": "configured-model",
    }
    values.update(overrides)
    return main.AIConfig(**values)


def _app_config(*, enabled=True, ai=None) -> main.AppConfig:
    return main.AppConfig(
        host="localhost",
        ai=_ai_config() if ai is None else ai,
        cache=main.CachePolicy(enabled=enabled),
    )


def _format_outcome(
    text: str = "formatted output",
    *,
    model: str = "provider-model",
    tokens_used: int = 11,
    eligible: bool = True,
    degraded: bool = False,
) -> main._PipelineOutcome:
    return main._PipelineOutcome(
        response=main.OCRResponse(text=text, model=model, tokens_used=tokens_used),
        eligible=eligible,
        degraded=degraded,
    )


def _translate_outcome(
    text: str = "translated output",
    *,
    model: str = "provider-model",
    tokens_used: int = 13,
    eligible: bool = True,
    degraded: bool = False,
) -> main._PipelineOutcome:
    return main._PipelineOutcome(
        response=main.OCRResponse(text=text, model=model, tokens_used=tokens_used),
        eligible=eligible,
        degraded=degraded,
    )


def _record(
    key: str = "a" * 64,
    *,
    operation: str = "format",
    text: str = "cached output",
    model: str = "cached-model",
    generation_tokens: int = 99,
) -> CacheRecord:
    return CacheRecord(
        key=key,
        operation=operation,
        text=text,
        model=model,
        generation_tokens=generation_tokens,
        generated_at=1_000_000.0,
    )


@dataclass
class FakeTransformationCache:
    read_result: CacheReadResult = field(default_factory=lambda: CacheReadResult(status="miss"))
    initialize_result: CacheMaintenanceResult = field(
        default_factory=lambda: CacheMaintenanceResult(status="ready")
    )
    write_result: CacheWriteResult = field(
        default_factory=lambda: CacheWriteResult(status="stored")
    )
    calls: list[tuple] = field(default_factory=list)

    async def initialize(self, policy):
        self.calls.append(("initialize", policy))
        return self.initialize_result

    async def read(self, key, policy):
        self.calls.append(("read", key, policy))
        return self.read_result

    async def write(self, key, record, policy):
        self.calls.append(("write", key, record, policy))
        return self.write_result


def _install_config(monkeypatch, config):
    monkeypatch.setattr(main, "load_config", lambda: config)


def _client() -> TestClient:
    return TestClient(main.app, raise_server_exceptions=False)


def test_force_defaults_false_and_extra_fields_remain_forbidden():
    assert main.FormatRequest(text="hello").force is False
    assert main.TranslateRequest(text="hello", language="English").force is False

    with pytest.raises(ValidationError):
        main.FormatRequest(text="hello", force=1)
    with pytest.raises(ValidationError):
        main.TranslateRequest(text="hello", language="English", force=1)
    with pytest.raises(ValidationError):
        main.FormatRequest(text="hello", unexpected="value")
    with pytest.raises(ValidationError):
        main.TranslateRequest(text="hello", language="English", unexpected="value")


def test_admission_runs_before_cache_hit(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache(
        read_result=CacheReadResult(status="hit", record=_record())
    )
    events: list[str] = []
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def admit(_request, _config):
        events.append("admission")
        return None

    async def release(_config):
        events.append("release")

    monkeypatch.setattr(main, "_acquire_request_slot", admit)
    monkeypatch.setattr(main, "_release_request_slot", release)

    original_read = cache.read

    async def read(key, policy):
        events.append("cache")
        return await original_read(key, policy)

    monkeypatch.setattr(cache, "read", read)
    response = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert response.status_code == 200
    assert response.headers["x-textkit-cache"] == "hit"
    assert events.index("admission") < events.index("cache")


def test_validation_and_operation_id_rejection_precede_cache_hit(monkeypatch):
    config = _app_config().model_copy(update={"max_text_chars": 3})
    cache = FakeTransformationCache(
        read_result=CacheReadResult(status="hit", record=_record())
    )
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    invalid_text = _client().post("/format", json={"text": "long", "prompt": "fmt"})
    invalid_operation_id = _client().post(
        "/format",
        json={"text": "ok", "prompt": "fmt"},
        headers={"X-TextKit-Operation-ID": "not valid"},
    )

    assert invalid_text.status_code == 413
    assert invalid_operation_id.status_code == 400
    assert cache.calls == []


def test_ordinary_miss_calls_read_then_provider_then_write(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache()
    events: list[str] = []
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def execute(_settings, _text):
        events.append("provider")
        return _format_outcome()

    async def read(key, policy):
        events.append("read")
        return await FakeTransformationCache.read(cache, key, policy)

    async def write(key, record, policy):
        events.append("write")
        return await FakeTransformationCache.write(cache, key, record, policy)

    monkeypatch.setattr(cache, "read", read)
    monkeypatch.setattr(cache, "write", write)
    monkeypatch.setattr(main, "_execute_format", execute)

    response = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert response.status_code == 200
    assert response.headers["x-textkit-cache"] == "miss"
    assert events == ["read", "provider", "write"]
    assert [call[0] for call in cache.calls] == ["read", "write"]


def test_forced_request_initializes_without_lookup(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache()
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def execute(_settings, _text):
        return _format_outcome()

    monkeypatch.setattr(main, "_execute_format", execute)

    response = _client().post(
        "/format", json={"text": "hello", "prompt": "fmt", "force": True}
    )

    assert response.status_code == 200
    assert response.headers["x-textkit-cache"] == "refresh"
    assert [call[0] for call in cache.calls] == ["initialize", "write"]


def test_cache_hit_returns_saved_model_and_zero_tokens(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache(
        read_result=CacheReadResult(
            status="hit", record=_record(text="saved", model="saved-model", generation_tokens=42)
        )
    )
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def unexpected_provider(*_args, **_kwargs):
        raise AssertionError("cache hit must not execute the provider")

    monkeypatch.setattr(main, "_execute_format", unexpected_provider)
    response = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert response.status_code == 200
    assert response.json() == {"text": "saved", "model": "saved-model", "tokens_used": 0}
    assert response.headers["x-textkit-cache"] == "hit"


def test_cache_hit_does_not_resolve_api_key(monkeypatch):
    config = _app_config(ai=_ai_config(api_key_env="MISSING_TEXTKIT_KEY", api_key=""))
    cache = FakeTransformationCache(
        read_result=CacheReadResult(status="hit", record=_record(text="saved"))
    )
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    def resolve_key(_config):
        raise AssertionError("cache hit must not resolve an API key")

    monkeypatch.setattr(main, "_resolve_ai_api_key", resolve_key)
    response = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert response.status_code == 200
    assert response.json()["text"] == "saved"


def test_cache_disabled_does_no_cache_work(monkeypatch):
    config = _app_config(enabled=False)
    cache = FakeTransformationCache()
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def execute(_settings, _text):
        return _format_outcome()

    monkeypatch.setattr(main, "_execute_format", execute)
    response = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert response.status_code == 200
    assert response.headers["x-textkit-cache"] == "disabled"
    assert cache.calls == []


def test_cache_read_failure_runs_provider_without_later_write(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache(
        read_result=CacheReadResult(status="unavailable", reason="busy")
    )
    events: list[str] = []
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def execute(_settings, _text):
        events.append("provider")
        return _format_outcome()

    monkeypatch.setattr(main, "_execute_format", execute)
    response = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert response.status_code == 200
    assert response.headers["x-textkit-cache"] == "error"
    assert events == ["provider"]
    assert [call[0] for call in cache.calls] == ["read"]


def test_cache_write_failure_keeps_success_and_uses_error_header(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache(
        write_result=CacheWriteResult(status="unavailable", reason="busy")
    )
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def execute(_settings, _text):
        return _format_outcome(text="provider result")

    monkeypatch.setattr(main, "_execute_format", execute)
    response = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert response.status_code == 200
    assert response.json() == {
        "text": "provider result",
        "model": "provider-model",
        "tokens_used": 11,
    }
    assert response.headers["x-textkit-cache"] == "error"


def test_forced_initialization_failure_skips_write(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache(
        initialize_result=CacheMaintenanceResult(status="unavailable", reason="busy")
    )
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def execute(_settings, _text):
        return _format_outcome()

    monkeypatch.setattr(main, "_execute_format", execute)
    response = _client().post(
        "/format", json={"text": "hello", "prompt": "fmt", "force": True}
    )

    assert response.status_code == 200
    assert response.headers["x-textkit-cache"] == "error"
    assert [call[0] for call in cache.calls] == ["initialize"]


def test_forced_failure_preserves_old_row(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache()
    old = _record(text="old result", model="old-model")
    cache.read_result = CacheReadResult(status="hit", record=old)
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def provider_failure(_settings, _text):
        raise HTTPException(status_code=502, detail="provider failed")

    monkeypatch.setattr(main, "_execute_format", provider_failure)
    response = _client().post(
        "/format", json={"text": "hello", "prompt": "fmt", "force": True}
    )

    assert response.status_code == 502
    assert "x-textkit-cache" not in response.headers
    assert [call[0] for call in cache.calls] == ["initialize"]
    assert old.text == "old result"


def test_provider_error_has_no_cache_header(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache()
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def provider_failure(_settings, _text):
        raise HTTPException(status_code=502, detail="provider failed")

    monkeypatch.setattr(main, "_execute_format", provider_failure)
    response = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert response.status_code == 502
    assert "x-textkit-cache" not in response.headers


def test_translation_skip_returns_existing_fields_and_skipped_header(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache()
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def unexpected_provider(*_args, **_kwargs):
        raise AssertionError("skipped translation must not execute the provider")

    monkeypatch.setattr(main, "_execute_translate", unexpected_provider)
    response = _client().post(
        "/translate", json={"text": "hello", "language": "original", "force": True}
    )

    assert response.status_code == 200
    assert response.json() == {
        "text": "hello",
        "model": "",
        "tokens_used": 0,
        "skipped": True,
        "detected_language": None,
        "skip_reason": "original_target",
    }
    assert response.headers["x-textkit-cache"] == "skipped"
    assert cache.calls == []


def test_force_does_not_bypass_original_or_same_language_skip(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache()
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)
    calls = []

    async def provider(*_args, **_kwargs):
        calls.append(True)
        return _translate_outcome()

    monkeypatch.setattr(main, "_execute_translate", provider)
    monkeypatch.setattr(main, "_detect_language", lambda _text: "en")

    original = _client().post(
        "/translate", json={"text": "hello", "language": "original", "force": True}
    )
    same_language = _client().post(
        "/translate",
        json={
            "text": "This is a sufficiently long English sentence for detection.",
            "language": "English",
            "force": True,
        },
    )

    assert original.status_code == same_language.status_code == 200
    assert original.headers["x-textkit-cache"] == "skipped"
    assert same_language.headers["x-textkit-cache"] == "skipped"
    assert original.json()["skip_reason"] == "original_target"
    assert same_language.json()["skip_reason"] == "same_language"
    assert calls == []
    assert cache.calls == []


def test_whitespace_prompt_bypasses_skip_gate(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache()
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def execute(_settings, _text, _language):
        return _translate_outcome()

    monkeypatch.setattr(main, "_execute_translate", execute)
    response = _client().post(
        "/translate",
        json={
            "text": "hello",
            "language": "original",
            "prompt": "   ",
        },
    )

    assert response.status_code == 200
    assert response.headers["x-textkit-cache"] == "miss"
    assert response.json()["text"] == "translated output"
    assert [call[0] for call in cache.calls] == ["read", "write"]


def test_header_precedence_for_all_success_paths(monkeypatch):
    cases = []

    skip_cache = FakeTransformationCache()
    cases.append((
        _app_config(),
        skip_cache,
        "/translate",
        {"text": "hello", "language": "original", "force": True},
        "skipped",
        "skip",
    ))

    disabled_cache = FakeTransformationCache()
    cases.append((
        _app_config(enabled=False),
        disabled_cache,
        "/format",
        {"text": "hello", "prompt": "fmt"},
        "disabled",
        "format",
    ))

    hit_cache = FakeTransformationCache(
        read_result=CacheReadResult(status="hit", record=_record())
    )
    cases.append((
        _app_config(),
        hit_cache,
        "/format",
        {"text": "hello", "prompt": "fmt"},
        "hit",
        "hit",
    ))

    error_cache = FakeTransformationCache(
        read_result=CacheReadResult(status="unavailable", reason="busy")
    )
    cases.append((
        _app_config(),
        error_cache,
        "/format",
        {"text": "hello", "prompt": "fmt"},
        "error",
        "format",
    ))

    uncacheable_cache = FakeTransformationCache()
    cases.append((
        _app_config(),
        uncacheable_cache,
        "/format",
        {"text": "hello", "prompt": "fmt"},
        "uncacheable",
        "degraded",
    ))

    miss_cache = FakeTransformationCache()
    cases.append((
        _app_config(),
        miss_cache,
        "/format",
        {"text": "hello", "prompt": "fmt"},
        "miss",
        "format",
    ))

    refresh_cache = FakeTransformationCache()
    cases.append((
        _app_config(),
        refresh_cache,
        "/format",
        {"text": "hello", "prompt": "fmt", "force": True},
        "refresh",
        "format",
    ))

    for config, cache, path, payload, expected, behavior in cases:
        # Each case uses its own patched app dependencies but can share the test process.
        _install_config(monkeypatch, config)
        monkeypatch.setattr(main, "_transformation_cache", cache)

        async def execute_format(_settings, _text, behavior=behavior):
            if behavior == "degraded":
                return _format_outcome(text="source", eligible=False, degraded=True)
            return _format_outcome()

        async def execute_translate(_settings, _text, _language):
            return _translate_outcome()

        monkeypatch.setattr(main, "_execute_format", execute_format)
        monkeypatch.setattr(main, "_execute_translate", execute_translate)

        response = _client().post(path, json=payload)

        assert response.status_code == 200
        assert response.headers["x-textkit-cache"] == expected


def test_hit_uses_stored_model_and_zero_tokens(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache(
        read_result=CacheReadResult(
            status="hit", record=_record(text="stored", model="stored-model", generation_tokens=88)
        )
    )
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)
    response = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert response.status_code == 200
    assert response.json() == {"text": "stored", "model": "stored-model", "tokens_used": 0}
    assert response.headers["x-textkit-cache"] == "hit"


def test_force_does_not_change_provider_idempotency_key(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache()
    provider_keys: list[str] = []
    written_keys: list[str] = []
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def provider(_config, _messages, *, idempotency_key=None):
        provider_keys.append(idempotency_key or "")
        return main._ChatCompletion("hello", "provider-model", 3, "stop")

    async def write(key, record, policy):
        written_keys.append(key)
        return await FakeTransformationCache.write(cache, key, record, policy)

    monkeypatch.setattr(main, "_request_chat_completion", provider)
    monkeypatch.setattr(cache, "write", write)

    ordinary = _client().post(
        "/format",
        json={"text": "hello", "prompt": "fmt"},
        headers={"X-TextKit-Operation-ID": "ordinary-attempt"},
    )
    forced = _client().post(
        "/format",
        json={"text": "hello", "prompt": "fmt", "force": True},
        headers={"X-TextKit-Operation-ID": "refresh-attempt"},
    )

    assert ordinary.status_code == forced.status_code == 200
    assert len(provider_keys) == 2
    assert all("force" not in key for key in provider_keys)
    assert len(written_keys) == 2
    assert written_keys[0] == written_keys[1]


def test_ordinary_and_forced_results_keep_existing_json_shape(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache()
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def execute(_settings, _text):
        return _format_outcome(text="same", model="same-model", tokens_used=4)

    monkeypatch.setattr(main, "_execute_format", execute)
    ordinary = _client().post("/format", json={"text": "hello", "prompt": "fmt"})
    forced = _client().post(
        "/format", json={"text": "hello", "prompt": "fmt", "force": True}
    )

    assert ordinary.status_code == forced.status_code == 200
    assert set(ordinary.json()) == {"text", "model", "tokens_used"}
    assert set(forced.json()) == {"text", "model", "tokens_used"}
    assert ordinary.json() == forced.json()


def test_empty_or_degraded_result_is_uncacheable_and_not_written(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache()
    outcomes = iter(
        [
            _format_outcome(text="", eligible=False, degraded=True),
            _format_outcome(text="source", eligible=False, degraded=True),
        ]
    )
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def execute(_settings, _text):
        return next(outcomes)

    monkeypatch.setattr(main, "_execute_format", execute)
    first = _client().post("/format", json={"text": "hello", "prompt": "fmt"})
    second = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert first.status_code == second.status_code == 200
    assert first.headers["x-textkit-cache"] == "uncacheable"
    assert second.headers["x-textkit-cache"] == "uncacheable"
    assert [call[0] for call in cache.calls] == ["read", "read"]


def test_cache_hit_succeeds_without_available_environment_key(monkeypatch):
    config = _app_config(ai=_ai_config(api_key="", api_key_env="UNSET_TEXTKIT_KEY"))
    cache = FakeTransformationCache(
        read_result=CacheReadResult(status="hit", record=_record(text="cached"))
    )
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)
    monkeypatch.delenv("UNSET_TEXTKIT_KEY", raising=False)

    response = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert response.status_code == 200
    assert response.json()["text"] == "cached"
    assert response.headers["x-textkit-cache"] == "hit"


def test_cache_failure_takes_precedence_over_degraded_result(monkeypatch):
    config = _app_config()
    cache = FakeTransformationCache(
        read_result=CacheReadResult(status="unavailable", reason="busy")
    )
    monkeypatch.setattr(main, "_transformation_cache", cache)
    _install_config(monkeypatch, config)

    async def execute(_settings, _text):
        return _format_outcome(text="source", eligible=False, degraded=True)

    monkeypatch.setattr(main, "_execute_format", execute)
    response = _client().post("/format", json={"text": "hello", "prompt": "fmt"})

    assert response.status_code == 200
    assert response.headers["x-textkit-cache"] == "error"

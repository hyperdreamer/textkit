"""Strict policy and immutable prompt/provider snapshots for transformation keys."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from typing import Iterator

import httpx
import pytest
from pydantic import ValidationError

from backend import main
from backend.transformation_cache import CachePolicyView


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    prompts = tmp_path / "prompts"
    prompts.mkdir()
    monkeypatch.setattr(main, "PROMPTS_DIR", prompts)
    monkeypatch.setattr(main, "CONFIG_PATH", tmp_path / "config.yaml")
    main._config_cache = None
    main._prompt_cache.clear()
    yield
    main._config_cache = None
    main._prompt_cache.clear()


def _ai_config(**overrides: object) -> main.AIConfig:
    values = {
        "api_base": "https://example.invalid",
        "model": "test-model",
    }
    values.update(overrides)
    return main.AIConfig(**values)


def _settings(**overrides: object) -> main._ResolvedTextSettings:
    values = {
        "config": _ai_config(),
        "prompt": "Format {verbatim}",
        "provider_endpoint": "https://example.invalid/v1/chat/completions",
    }
    values.update(overrides)
    return main._ResolvedTextSettings(**values)


def test_cache_policy_defaults_when_mapping_is_omitted() -> None:
    config = main.AppConfig()

    assert config.cache.model_dump() == {
        "enabled": True,
        "ttl_days": 30,
        "max_entries": 1000,
    }
    assert main.load_config().cache == config.cache
    assert main.AppConfig(cache={}).cache == config.cache
    assert isinstance(config.cache, CachePolicyView)
    assert main.AppConfig(cache={"enabled": False}).cache.model_dump() == {
        "enabled": False,
        "ttl_days": 30,
        "max_entries": 1000,
    }


@pytest.mark.parametrize(
    "values",
    [
        {"enabled": True, "ttl_days": 1, "max_entries": 1},
        {"enabled": False, "ttl_days": 3650, "max_entries": 100000},
        {"enabled": True, "ttl_days": 30, "max_entries": 1000},
    ],
)
def test_cache_policy_accepts_documented_values(values: dict[str, object]) -> None:
    policy = main.AppConfig(cache=values).cache

    assert policy.model_dump() == values
    with pytest.raises(ValidationError, match="frozen_instance"):
        policy.ttl_days = 2


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("enabled", 0),
        ("enabled", 1),
        ("enabled", 1.0),
        ("enabled", "true"),
        ("enabled", "false"),
        ("ttl_days", True),
        ("ttl_days", False),
        ("ttl_days", "30"),
        ("ttl_days", 30.0),
        ("ttl_days", 1.5),
        ("max_entries", True),
        ("max_entries", False),
        ("max_entries", "1000"),
        ("max_entries", 1000.0),
        ("max_entries", 1.5),
    ],
)
def test_cache_policy_rejects_boolean_integer_and_numeric_string_values(
    field: str, value: object
) -> None:
    with pytest.raises(ValidationError):
        main.AppConfig(cache={field: value})


@pytest.mark.parametrize(
    "values",
    [
        None,
        {"enabled": None},
        {"ttl_days": None},
        {"max_entries": None},
        {"unknown": 1},
        {"ttl_days": 0},
        {"ttl_days": -1},
        {"ttl_days": 3651},
        {"max_entries": 0},
        {"max_entries": -1},
        {"max_entries": 100001},
    ],
)
def test_cache_policy_rejects_null_extra_zero_negative_and_out_of_range_values(
    values: object,
) -> None:
    with pytest.raises(ValidationError):
        main.AppConfig(cache=values)


@pytest.mark.parametrize("operation", ["format", "translate"])
def test_resolved_text_settings_use_text_override_once(
    monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    base = _ai_config(
        max_tokens=1024,
        text=main.ProviderOverride(
            api_base=" https://text.invalid/custom/ ",
            api_key_env="TEXTKIT_TEST_MISSING_KEY",
            model="text-model",
        ),
    )
    resolutions: list[tuple[main.AIConfig, main.ProviderOverride | None]] = []
    prompt_threads: list[int] = []
    resolve = main._resolve_ai_config
    render = main._render_prompt
    event_loop_thread = threading.get_ident()

    def resolve_once(config, override):
        resolutions.append((config, override))
        return resolve(config, override)

    def render_once(name, **kwargs):
        prompt_threads.append(threading.get_ident())
        return render(name, **kwargs)

    monkeypatch.setattr(main, "_resolve_ai_config", resolve_once)
    monkeypatch.setattr(main, "_render_prompt", render_once)
    settings = asyncio.run(
        main._resolve_text_settings(base, operation, None, language="French")
    )

    assert resolutions == [(base, base.text)]
    assert len(prompt_threads) == 1
    assert prompt_threads[0] != event_loop_thread
    assert settings.config.api_base == "https://text.invalid/custom"
    assert settings.config.model == "text-model"
    assert settings.config.max_tokens == 1024
    assert settings.config.api_key_env == "TEXTKIT_TEST_MISSING_KEY"
    assert settings.provider_endpoint == "https://text.invalid/custom/v1/chat/completions"
    expected_prompt = (
        "Translate the following text to French. Return only the translation. "
        "Preserve paragraph structure and line breaks."
        if operation == "translate"
        else "Format the following text for readability and clarity. Preserve its meaning "
        "and all important details. Return only the formatted text."
    )
    assert settings.prompt == expected_prompt
    with pytest.raises(ValidationError, match="frozen_instance"):
        settings.prompt = "changed"
    with pytest.raises(ValidationError, match="frozen_instance"):
        settings.config.model = "changed"


@pytest.mark.parametrize("operation", ["format", "translate"])
def test_api_key_is_not_resolved_by_settings_snapshot(
    monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    monkeypatch.delenv("TEXTKIT_TEST_MISSING_KEY", raising=False)
    key_calls = 0

    def forbidden_key_resolution(config):
        nonlocal key_calls
        key_calls += 1
        raise AssertionError("settings must not read provider secrets")

    monkeypatch.setattr(main, "_resolve_ai_api_key", forbidden_key_resolution)
    settings = asyncio.run(
        main._resolve_text_settings(
            _ai_config(text=main.ProviderOverride(api_key_env="TEXTKIT_TEST_MISSING_KEY")),
            operation,
            None,
            language="French",
        )
    )

    assert settings.config.api_key_env == "TEXTKIT_TEST_MISSING_KEY"
    assert len(main._cache_identity(operation, "hello", "French", settings)) == 64
    assert key_calls == 0


def test_cache_identity_matches_the_fixed_utf8_digest_vector() -> None:
    # The specification pins these exact UTF-8 bytes, including the escaped LF.
    canonical = {
        "cache_format_version": 1,
        "input_text": "Hello\nworld",
        "max_tokens": None,
        "model": "test-model",
        "operation": "format",
        "pipeline_revision": 1,
        "prompt": "Format {verbatim}",
        "provider_endpoint": "https://example.invalid/v1/chat/completions",
    }
    assert json.dumps(
        canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ) == (
        '{"cache_format_version":1,"input_text":"Hello\\nworld","max_tokens":null,'
        '"model":"test-model","operation":"format","pipeline_revision":1,'
        '"prompt":"Format {verbatim}",'
        '"provider_endpoint":"https://example.invalid/v1/chat/completions"}'
    )
    assert main._cache_identity("format", canonical["input_text"], None, _settings()) == (
        "c80b950b5bce10ffac6026037fe4649111381531b1f932892844fc43cab0e1ff"
    )


@pytest.mark.parametrize(
    "dimension",
    [
        "input_text",
        "unicode_form",
        "line_ending",
        "prompt",
        "provider_endpoint",
        "model",
        "max_tokens",
        "operation",
        "language",
        "cache_format_version",
        "pipeline_revision",
    ],
)
def test_identity_changes_for_each_dimension(
    monkeypatch: pytest.MonkeyPatch, dimension: str
) -> None:
    text = "Café\nworld"
    settings = _settings()
    operation = "translate"
    language = "French"
    revision = 1
    baseline = main._cache_identity(operation, text, language, settings)

    if dimension == "input_text":
        text += "!"
    elif dimension == "unicode_form":
        text = "Cafe\u0301\nworld"
    elif dimension == "line_ending":
        text = "Café\r\nworld"
    elif dimension == "prompt":
        settings = _settings(prompt="Another prompt")
    elif dimension == "provider_endpoint":
        settings = _settings(provider_endpoint="https://other.invalid/v1/chat/completions")
    elif dimension == "model":
        settings = _settings(config=_ai_config(model="other-model"))
    elif dimension == "max_tokens":
        settings = _settings(config=_ai_config(max_tokens=4096))
    elif dimension == "operation":
        operation = "format"
    elif dimension == "language":
        language = "German"
    elif dimension == "cache_format_version":
        monkeypatch.setattr(main, "CACHE_FORMAT_VERSION", 2)
    elif dimension == "pipeline_revision":
        revision = 2

    assert main._cache_identity(operation, text, language, settings, revision) != baseline


def test_identity_preserves_exact_whitespace_unicode_and_line_endings() -> None:
    texts = [
        "Café\nworld",
        " Café\nworld",
        "Café\nworld ",
        "Café\r\nworld",
        "Cafe\u0301\nworld",
        "Café\n world",
        "Café\n\nworld",
    ]
    keys = [main._cache_identity("format", text, None, _settings()) for text in texts]

    assert len(set(keys)) == len(texts)
    # Independent non-ASCII vector catches JSON ASCII escaping as well as UTF-8 encoding.
    assert keys[0] == "6d0ff28299ba213b2643a4abc48681b23c130ab69ec91adef5ddb3d3ae37b61b"


def test_identity_distinguishes_unset_and_explicit_max_tokens() -> None:
    unset = main._cache_identity("format", "Hello\nworld", None, _settings())
    explicit = main._cache_identity(
        "format", "Hello\nworld", None, _settings(config=_ai_config(max_tokens=1))
    )

    assert unset != explicit


def test_translation_identity_includes_validated_language_but_format_does_not() -> None:
    french = main.TranslateRequest(text="hello", language=" fReNcH ").language
    german = main.TranslateRequest(text="hello", language="german").language
    settings = _settings()

    assert main._cache_identity("translate", "hello", french, settings) == (
        "cc691dda35c0a5a7daeaaf9c5b8c857bc51c48627a87ab938c14fec7e8ff4f60"
    )
    assert main._cache_identity("translate", "hello", french, settings) != (
        main._cache_identity("translate", "hello", german, settings)
    )
    assert main._cache_identity("format", "hello", french, settings) == (
        main._cache_identity("format", "hello", None, settings)
    ) == main._cache_identity("format", "hello", german, settings)


@pytest.mark.parametrize("operation", ["format", "translate"])
@pytest.mark.parametrize("prompt", [" ", "\t\n", " {language}\n", '{"key": true}'])
def test_request_prompt_override_is_verbatim(
    monkeypatch: pytest.MonkeyPatch, operation: str, prompt: str
) -> None:
    def forbidden_fallback(*args, **kwargs):
        raise AssertionError("request overrides must not load or render a server template")

    monkeypatch.setattr(main, "_render_prompt", forbidden_fallback)
    settings = asyncio.run(
        main._resolve_text_settings(_ai_config(), operation, prompt, language="French")
    )

    assert settings.prompt == prompt


@pytest.mark.parametrize("request_prompt", [None, ""])
def test_empty_request_prompt_uses_language_file_then_base_file(
    request_prompt: str | None,
) -> None:
    language_file = main.PROMPTS_DIR / "translate.French.txt"
    base_file = main.PROMPTS_DIR / "translate.txt"
    language_file.write_text(" \nFrench-specific {language}\n ", encoding="utf-8")
    base_file.write_text(" \nBase {language}\n ", encoding="utf-8")

    async def resolve():
        return await main._resolve_text_settings(
            _ai_config(), "translate", request_prompt, language="French"
        )

    assert asyncio.run(resolve()).prompt == "French-specific French"
    language_file.unlink()
    assert asyncio.run(resolve()).prompt == "Base French"
    base_file.unlink()
    assert asyncio.run(resolve()).prompt == (
        "Translate the following text to French. Return only the translation. "
        "Preserve paragraph structure and line breaks."
    )


@pytest.mark.parametrize("filename", ["translate.French.txt", "translate.txt", "format.txt"])
@pytest.mark.parametrize("content", ["", " \n\t"])
def test_empty_prompt_file_is_explicit_and_stops_fallback(filename: str, content: str) -> None:
    (main.PROMPTS_DIR / filename).write_text(content, encoding="utf-8")
    if filename == "translate.French.txt":
        (main.PROMPTS_DIR / "translate.txt").write_text("must not be selected", encoding="utf-8")
    operation = "format" if filename == "format.txt" else "translate"
    settings = asyncio.run(
        main._resolve_text_settings(_ai_config(), operation, "", language="French")
    )

    assert settings.prompt == ""


@pytest.mark.parametrize("operation", ["format", "translate"])
def test_server_template_replaces_only_language_token(operation: str) -> None:
    (main.PROMPTS_DIR / f"{operation}.txt").write_text(
        ' \nKeep {verbatim} and {"key": true}; {language} / {language}\n ', encoding="utf-8"
    )
    settings = asyncio.run(
        main._resolve_text_settings(_ai_config(), operation, None, language="French")
    )

    assert settings.prompt == (
        'Keep {verbatim} and {"key": true}; French / French'
        if operation == "translate"
        else 'Keep {verbatim} and {"key": true};  / '
    )


@pytest.mark.parametrize("operation", ["format", "translate"])
def test_prompt_edits_affect_later_snapshots_only(
    monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    prompt_file = main.PROMPTS_DIR / f"{operation}.txt"
    prompt_file.write_text("First {language} template", encoding="utf-8")
    main.CONFIG_PATH.write_text(
        "cache:\n  ttl_days: 1\n  max_entries: 10\n"
        "ai:\n  api_base: https://base.invalid\n  api_key: test-key\n"
        "  text:\n    api_base: https://first.invalid\n    model: first-model\n    max_tokens: 100\n",
        encoding="utf-8",
    )

    async def run():
        entered = asyncio.Event()
        release = asyncio.Event()
        seen: list[tuple[str, dict[str, object]]] = []

        async def provider(request: httpx.Request) -> httpx.Response:
            entered.set()
            await release.wait()
            seen.append((str(request.url), json.loads(request.content)))
            return httpx.Response(
                200,
                json={
                    "choices": [{"message": {"content": "hello"}, "finish_reason": "stop"}],
                    "model": "first-reported-model",
                    "usage": {"total_tokens": 7},
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
            monkeypatch.setattr(main, "_http_client", client)
            accepted = await main._get_config()
            first = await main._resolve_text_settings(
                accepted.ai, operation, None, language="French"
            )
            first_key = main._cache_identity(operation, "hello", "French", first)
            task = asyncio.create_task(
                main._post_openai_chat_completion(
                    first.config,
                    [
                        {"role": "system", "content": first.prompt},
                        {"role": "user", "content": "hello"},
                    ],
                )
            )
            try:
                await asyncio.wait_for(entered.wait(), timeout=2)
                prompt_file.write_text("Second prompt {language} template", encoding="utf-8")
                main.CONFIG_PATH.write_text(
                    "cache:\n  enabled: false\n  ttl_days: 2\n  max_entries: 20\n"
                    "ai:\n  api_base: https://base.invalid\n  api_key: test-key\n"
                    "  text:\n    api_base: https://second.invalid\n    model: second-model\n"
                    "    max_tokens: 200\n",
                    encoding="utf-8",
                )
                later_config = await main._get_config()
                later = await main._resolve_text_settings(
                    later_config.ai, operation, None, language="French"
                )
                assert first.prompt == (
                    "First French template" if operation == "translate" else "First  template"
                )
                assert first.config.model == "first-model"
                assert first.config.max_tokens == 100
                assert main._cache_identity(operation, "hello", "French", first) == first_key
                assert later.prompt == (
                    "Second prompt French template"
                    if operation == "translate"
                    else "Second prompt  template"
                )
                assert later.config.model == "second-model"
                assert later.config.max_tokens == 200
                assert later.provider_endpoint == "https://second.invalid/v1/chat/completions"
                assert main._cache_identity(operation, "hello", "French", later) != first_key
                assert accepted.cache.model_dump() == {
                    "enabled": True, "ttl_days": 1, "max_entries": 10
                }
                assert later_config.cache.model_dump() == {
                    "enabled": False, "ttl_days": 2, "max_entries": 20
                }
            finally:
                release.set()
                result = await asyncio.wait_for(task, timeout=2)
            assert result.model == "first-reported-model"
            assert result.tokens_used == 7
            assert seen == [
                (
                    first.provider_endpoint,
                    {
                        "model": "first-model",
                        "max_tokens": 100,
                        "messages": [
                            {"role": "system", "content": first.prompt},
                            {"role": "user", "content": "hello"},
                        ],
                    },
                )
            ]

    asyncio.run(run())


@pytest.mark.parametrize(
    "override",
    [
        {"api_base": "https://other.invalid"},
        {"model": "other-model"},
        {"max_tokens": 4096},
    ],
)
def test_effective_provider_settings_change_the_identity(override: dict[str, object]) -> None:
    async def resolve_keys():
        baseline = await main._resolve_text_settings(_ai_config(), "format", "prompt")
        effective = await main._resolve_text_settings(
            _ai_config(text=main.ProviderOverride(**override)), "format", "prompt"
        )
        return (
            main._cache_identity("format", "hello", None, baseline),
            main._cache_identity("format", "hello", None, effective),
        )

    baseline, effective = asyncio.run(resolve_keys())
    assert effective != baseline


def test_credentials_and_timeouts_do_not_change_the_identity() -> None:
    async def resolve_keys():
        baseline = await main._resolve_text_settings(_ai_config(), "format", "prompt")
        changed = await main._resolve_text_settings(
            _ai_config(
                api_key="different-test-key",
                api_key_env="TEXTKIT_TEST_MISSING_KEY",
                timeout=main.TimeoutConfig(read=100),
            ),
            "format",
            "prompt",
        )
        return (
            main._cache_identity("format", "hello", None, baseline),
            main._cache_identity("format", "hello", None, changed),
        )

    baseline, changed = asyncio.run(resolve_keys())
    assert changed == baseline

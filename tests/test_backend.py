from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from typing import Awaitable, Callable, Iterator

import pytest
import httpx
from fastapi.testclient import TestClient
from PIL import Image

from backend import main


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(main, "load_config", lambda: _app_config())
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def reset_backend_globals() -> None:
    main._prompt_cache.clear()
    main._rate_events.clear()
    main._active_requests = 0
    main._config_cache = None


def _ai_config() -> main.AIConfig:
    return main.AIConfig(
        api_base="https://example.invalid",
        api_key="test-key",
        model="test-model",
    )


def _app_config(*, host: str = "localhost", debug: bool = False) -> main.AppConfig:
    return main.AppConfig(
        host=host,
        debug=debug,
        ai=_ai_config(),
        cache=main.CachePolicy(enabled=False),
    )


def _png_bytes() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (1, 1), color="white").save(buffer, format="PNG")
    return buffer.getvalue()


def _jpeg_bytes() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (1, 1), color="white").save(buffer, format="JPEG")
    return buffer.getvalue()


def test_image_data_url_uses_detected_type_not_claimed_mime() -> None:
    data_url = main._image_to_data_url(_jpeg_bytes(), "image/png")

    assert data_url.startswith("data:image/jpeg;base64,")


def test_image_data_url_rejects_truncated_png() -> None:
    with pytest.raises(main.HTTPException) as exc_info:
        main._image_to_data_url(_png_bytes()[:-4], "image/png")

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Uploaded file is not a valid image"


def test_debug_artifacts_are_written_only_when_debug_is_enabled(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _app_config(debug=False)
    monkeypatch.setattr(main, "load_config", lambda: config)

    async def fake_ocr(
        _config: main.AIConfig, _data_url: str, _prompt: str | None = None
    ) -> main.OCRResponse:
        return main.OCRResponse(text="ocr text", model="test-model", tokens_used=1)

    async def fake_dedup(
        _config: main.AIConfig, _text: str, _prompt: str | None = None
    ) -> main.OCRResponse:
        return main.OCRResponse(text="dedup text", model="test-model", tokens_used=1)

    monkeypatch.setattr(main, "transcribe_image", fake_ocr)
    monkeypatch.setattr(main, "deduplicate_text", fake_dedup)
    writes: list[tuple[str, bytes]] = []

    def record_private(name: str, data: bytes) -> None:
        writes.append((name, data))

    monkeypatch.setattr(main, "_write_private_file", record_private)

    ocr_response = client.post(
        "/ocr",
        files={"image": ("page.png", _png_bytes(), "image/png")},
        data={"prompt": "transcribe"},
    )
    dedup_response = client.post(
        "/dedup", json={"text": "raw text", "prompt": "deduplicate"}
    )

    assert ocr_response.status_code == 200
    assert dedup_response.status_code == 200
    assert writes == []

    config = _app_config(debug=True)
    client.post(
        "/ocr",
        files={"image": ("page.png", _png_bytes(), "image/png")},
        data={"prompt": "transcribe"},
    )
    client.post("/dedup", json={"text": "raw text", "prompt": "deduplicate"})

    assert [name for name, _data in writes] == [
        "last_screenshot.png",
        "last_ocr.txt",
        "pre_dedup.txt",
        "after_dedup.txt",
    ]


def test_prompt_fallback_reports_file_source_and_version(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path)
    template = "Translate specifically to French"
    (tmp_path / "translate.French.txt").write_text(template, encoding="utf-8")

    response = client.get("/prompts/translate/fallback?language=French")

    assert response.status_code == 200
    assert response.json() == {
        "template": template,
        "source": "file",
        "version": hashlib.sha256(template.encode("utf-8")).hexdigest(),
    }


def test_prompt_fallback_reports_hardcoded_source_and_supports_etag(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path)

    response = client.get("/prompts/ocr/fallback")

    assert response.status_code == 200
    payload = response.json()
    assert payload["template"] == main._DEFAULT_PROMPTS["ocr"]
    assert payload["source"] == "hardcoded"
    assert payload["version"] == hashlib.sha256(
        main._DEFAULT_PROMPTS["ocr"].encode("utf-8")
    ).hexdigest()

    cached = client.get(
        "/prompts/ocr/fallback", headers={"If-None-Match": response.headers["etag"]}
    )
    assert cached.status_code == 304
    assert cached.content == b""


def test_translate_prompt_get_falls_back_to_base_language_file(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path)
    (tmp_path / "translate.txt").write_text("Base translation {language}", encoding="utf-8")

    response = client.get("/prompts/translate?language=French")

    assert response.status_code == 200
    assert response.json()["template"] == "Base translation {language}"


def test_list_prompts_returns_only_canonical_keys(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path)
    (tmp_path / "translate.txt").write_text("base {language}", encoding="utf-8")
    (tmp_path / "translate.English.txt").write_text(
        "English-specific", encoding="utf-8"
    )

    response = client.get("/prompts")

    assert response.status_code == 200
    assert response.json()["prompts"] == {
        "ocr": main._DEFAULT_PROMPTS["ocr"],
        "dedup": main._DEFAULT_PROMPTS["dedup"],
        "translate": "base {language}",
        "format": main._DEFAULT_PROMPTS["format"],
    }


def test_fresh_install_has_nonempty_format_prompt(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path)
    main._prompt_cache.clear()

    assert main._render_prompt("format").strip()


@pytest.mark.parametrize("name", ["ocr", "dedup", "format"])
def test_language_parameter_is_rejected_for_non_translation_prompts(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    name: str,
) -> None:
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path)

    response = client.get(f"/prompts/{name}?language=French")

    assert response.status_code == 400
    assert response.json()["error"] == (
        "The language parameter is only supported for the translate prompt"
    )
    assert not (tmp_path / f"{name}.French.txt").exists()


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("post", "/save", {"json": {"text": "hello", "path": "notes.txt"}}),
        ("get", "/paths", {}),
    ],
)
def test_file_bridge_routes_are_not_exposed_by_textkit(
    client: TestClient, method: str, path: str, kwargs: dict[str, object]
) -> None:
    response = getattr(client, method)(path, **kwargs)

    assert response.status_code == 404


def test_health_endpoint(client: TestClient) -> None:
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_image_pixel_limit_is_checked_before_decode() -> None:
    buffer = BytesIO()
    Image.new("RGB", (4, 4), color="white").save(buffer, format="PNG")

    with pytest.raises(main.HTTPException) as exc_info:
        main._image_to_data_url(buffer.getvalue(), "image/png", max_pixels=15)

    assert exc_info.value.status_code == 413


def test_zero_image_pixel_limit_disables_check() -> None:
    buffer = BytesIO()
    Image.new("RGB", (4, 4), color="white").save(buffer, format="PNG")

    assert main._image_to_data_url(
        buffer.getvalue(), "image/png", max_pixels=0
    ).startswith("data:image/png;base64,")


def test_animated_images_are_rejected_for_ocr() -> None:
    buffer = BytesIO()
    frames = [Image.new("RGB", (2, 2), color=color) for color in ("white", "black")]
    frames[0].save(buffer, format="GIF", save_all=True, append_images=frames[1:], loop=0)

    with pytest.raises(main.HTTPException) as exc_info:
        main._image_to_data_url(buffer.getvalue(), "image/gif")

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Animated images are not supported for OCR"


def test_zero_upload_limit_reads_entire_upload() -> None:
    upload = main.UploadFile(file=BytesIO(b"complete upload"), filename="test.txt")

    assert asyncio.run(main._read_limited_upload(upload, 0)) == b"complete upload"


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


@pytest.mark.parametrize(
    "api_base",
    [
        "https://example.com:bad",
        "https://example.com:0",
        "https://example.com:70000",
        "http://example.com:0",
        "http://example.com:70000",
    ],
)
def test_provider_rejects_invalid_ports(api_base: str) -> None:
    with pytest.raises(main.ValidationError, match="valid port between 1 and 65535"):
        main.AIConfig(api_base=api_base, api_key="key", model="model")


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


def test_provider_response_requires_choices() -> None:
    from backend import providers

    with pytest.raises(providers.ProviderProtocolError) as exc_info:
        providers.ChatCompletionsAdapter().parse_response(
            {"model": "test"}, configured_model="test"
        )

    assert "missing choices" in str(exc_info.value)


def test_prompt_render_preserves_unrelated_braces(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path)
    (tmp_path / "translate.txt").write_text(
        'Translate {language}; preserve JSON like {"key": true}.', encoding="utf-8"
    )

    assert main._render_prompt("translate", language="French") == (
        'Translate French; preserve JSON like {"key": true}.'
    )


def test_request_and_model_fields_are_bounded(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(main, "load_config", lambda: _app_config())

    oversized = client.post(
        "/format",
        content=b"x" * (main.DEFAULT_MAX_REQUEST_BODY_BYTES + 1),
        headers={"Content-Type": "application/json"},
    )
    unsupported_language = client.post(
        "/translate", json={"text": "hello", "language": "Klingon"}
    )

    assert oversized.status_code == 413
    assert unsupported_language.status_code == 400


def test_translate_request_canonicalizes_language_casing() -> None:
    assert main.TranslateRequest(text="hello", language="fReNcH").language == "French"
    assert main.TranslateRequest(text="hello", language=" original ").language == "original"


def test_chunked_request_body_is_limited_without_content_length(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        main,
        "load_config",
        lambda: _app_config().model_copy(update={"max_request_body_bytes": 1024}),
    )

    response = client.post(
        "/format",
        content=(chunk for chunk in (b'{"text":"', b"x" * 1200, b'"}')),
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 413


def test_zero_request_and_character_limits_disable_checks(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _app_config().model_copy(
        update={
            "max_request_body_bytes": 0,
            "max_text_chars": 0,
            "max_prompt_chars": 0,
        }
    )
    monkeypatch.setattr(main, "load_config", lambda: config)

    async def fake_format(_settings: main._ResolvedTextSettings, text: str) -> main._PipelineOutcome:
        return main._PipelineOutcome(
            response=main.OCRResponse(text=text, model="test-model", tokens_used=1),
            eligible=True,
            degraded=False,
        )

    monkeypatch.setattr(main, "_execute_format", fake_format)
    text = "x" * (main.DEFAULT_MAX_TEXT_CHARS + 1)
    prompt = "p" * (main.DEFAULT_MAX_PROMPT_CHARS + 1)

    response = client.post("/format", json={"text": text, "prompt": prompt})

    assert response.status_code == 200
    assert response.json()["text"] == text


def test_config_schema_accepts_zero_for_all_limits() -> None:
    values = {
        "max_upload_bytes": 0,
        "max_image_pixels": 0,
        "max_text_chars": 0,
        "max_prompt_chars": 0,
        "max_request_body_bytes": 0,
        "requests_per_minute": 0,
        "max_concurrent_requests": 0,
    }

    config = main.AppConfig(**values)

    assert all(getattr(config, name) == 0 for name in values)


def test_zero_rate_limits_disable_limiter_state() -> None:
    config = _app_config().model_copy(
        update={"requests_per_minute": 0, "max_concurrent_requests": 0}
    )
    request = main.Request({"type": "http", "client": ("127.0.0.1", 1234)})

    assert asyncio.run(main._acquire_request_slot(request, config)) is None
    assert not main._rate_events
    assert main._active_requests == 0


def test_config_schema_rejects_invalid_ranges(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text("port: 70000\n", encoding="utf-8")
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    warnings: list[tuple[object, ...]] = []
    monkeypatch.setattr(
        main.logger, "warning", lambda *args, **kwargs: warnings.append(args)
    )
    main._config_cache = None

    with pytest.raises(RuntimeError, match="Invalid config.yaml"):
        main.load_config()

    assert warnings == []


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


def test_load_config_caches_before_insecure_warning_pass(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    class InsecureWarningRaised(Exception):
        pass

    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "ai:\n  api_base: http://provider.example\n", encoding="utf-8"
    )
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    warning_calls: list[tuple[object, ...]] = []

    def raise_on_warning(*args: object, **kwargs: object) -> None:
        warning_calls.append(args)
        raise InsecureWarningRaised(args)

    monkeypatch.setattr(main.logger, "warning", raise_on_warning)
    main._config_cache = None

    with pytest.raises(InsecureWarningRaised):
        main.load_config()

    assert len(warning_calls) == 1
    assert main._config_cache is not None
    cached = main._config_cache[1]
    assert isinstance(cached, main.AppConfig)
    assert cached.ai is not None
    assert cached.ai.api_base == "http://provider.example"

    second = main.load_config()

    assert second is cached
    assert len(warning_calls) == 1


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


@pytest.mark.parametrize(
    "endpoint",
    ["/v1/chat/completions", "/v1/responses", "/v1/messages"],
)
def test_load_config_accepts_each_supported_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, endpoint: str
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "ai:\n"
        '  api_base: "https://example.invalid"\n'
        '  api_key: "test-key"\n'
        f'  endpoint: "{endpoint}"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "_config_cache", None)
    assert main.load_config().ai.endpoint == endpoint


def test_load_config_omitted_endpoint_selects_legacy_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "ai:\n"
        '  api_base: "https://example.invalid"\n'
        '  api_key: "test-key"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "_config_cache", None)

    config = main.load_config()

    assert config.ai is not None
    assert config.ai.endpoint is None
    assert config.ai.messages_default_max_tokens == 4096


@pytest.mark.parametrize(
    ("raw", "expected_repr"),
    [
        ("null", "None"),
        ("123", "123"),
        ("true", "True"),
        ("'chat/completions'", "'chat/completions'"),
        ("'/responses'", "'/responses'"),
        ("'https://api.openai.com/v1/messages'", "'https://api.openai.com/v1/messages'"),
        ("'/v1/chat/completion'", "'/v1/chat/completion'"),
    ],
)
def test_load_config_rejects_invalid_endpoint_with_exact_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, raw: str, expected_repr: str
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "ai:\n"
        '  api_base: "https://example.invalid"\n'
        '  api_key: "test-key"\n'
        f"  endpoint: {raw}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "_config_cache", None)

    with pytest.raises(RuntimeError) as exc_info:
        main.load_config()

    assert str(exc_info.value) == (
        f"Unsupported ai.endpoint value: {expected_repr}. "
        "Use one of: /v1/chat/completions, /v1/messages, /v1/responses"
    )


def test_rejected_endpoint_does_not_populate_config_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "ai:\n"
        '  api_base: "https://example.invalid"\n'
        '  api_key: "test-key"\n'
        '  endpoint: "/nope"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "_config_cache", None)

    with pytest.raises(RuntimeError):
        main.load_config()

    assert main._config_cache is None


def test_valid_config_loads_after_a_rejected_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "ai:\n"
        '  api_base: "https://example.invalid"\n'
        '  api_key: "test-key"\n'
        '  endpoint: "/nope"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "_config_cache", None)

    with pytest.raises(RuntimeError):
        main.load_config()

    config_path.write_text(
        "ai:\n"
        '  api_base: "https://example.invalid"\n'
        '  api_key: "test-key"\n'
        '  endpoint: "/v1/messages"\n'
        "  messages_default_max_tokens: 2048\n",
        encoding="utf-8",
    )

    config = main.load_config()

    assert config.ai is not None
    assert config.ai.endpoint == "/v1/messages"
    assert config.ai.messages_default_max_tokens == 2048


def test_resolve_ai_config_carries_endpoint_and_messages_default() -> None:
    base = main.AIConfig(
        api_base="https://example.invalid",
        api_key="k",
        model="m",
        endpoint="/v1/messages",
        messages_default_max_tokens=2048,
        text=main.ProviderOverride(model="other"),
    )
    effective = main._resolve_ai_config(base, base.text)
    assert effective.endpoint == "/v1/messages"
    assert effective.messages_default_max_tokens == 2048


def test_provider_override_rejects_endpoint() -> None:
    with pytest.raises(Exception):
        main.ProviderOverride(endpoint="/v1/messages")


@pytest.mark.parametrize("value", [0, -1, True, "5", 1.0])
def test_messages_default_max_tokens_rejects_invalid(value: object) -> None:
    with pytest.raises(Exception):
        main.AIConfig(messages_default_max_tokens=value)


def test_messages_default_max_tokens_defaults_and_accepts_positive() -> None:
    assert main.AIConfig().messages_default_max_tokens == 4096
    assert main.AIConfig(messages_default_max_tokens=1).messages_default_max_tokens == 1


# ── configuration error paths: startup refusal and request-time reload ──


def _write_config(path: Path, *, endpoint_line: str) -> None:
    path.write_text(
        "ai:\n"
        '  api_base: "https://example.invalid"\n'
        '  api_key: "test-key"\n' + endpoint_line,
        encoding="utf-8",
    )


def test_lifespan_invalid_endpoint_refuses_startup_without_http_response(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, endpoint_line='  endpoint: "/bad/path"\n')
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "_config_cache", None)

    async def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("startup refusal must not reach the provider")

    with _mocked_provider(handler) as requests:
        # The bare ``client`` fixture skips lifespan startup; only the
        # context-managed form runs it, so the refusal surfaces as RuntimeError.
        with pytest.raises(RuntimeError, match="Unsupported ai.endpoint value"):
            with TestClient(main.app):
                pass

    assert requests == []


def test_request_time_reload_invalid_endpoint_returns_exact_500_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, endpoint_line='  endpoint: "/v1/responses"\n')
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "_config_cache", None)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_protocol_envelope("/v1/responses", "deduped"))

    with _mocked_provider(handler) as requests:
        client = TestClient(main.app)
        ok = client.post("/dedup", json={"text": "hello"})
        assert ok.status_code == 200
        assert ok.json()["text"] == "deduped"
        assert len(requests) == 1

        _write_config(config_path, endpoint_line='  endpoint: "/v1/bogus"\n')
        # Clear the cache explicitly so the reload does not depend on the
        # filesystem timestamp granularity of the edited file.
        monkeypatch.setattr(main, "_config_cache", None)
        response = client.post("/dedup", json={"text": "hello"})

    assert response.status_code == 500
    body = response.json()
    assert body["text"] == ""
    assert body["model"] == ""
    assert body["tokens_used"] == 0
    assert "Unsupported ai.endpoint value" in body["error"]
    # The structured 500 comes from security_and_limits before any AI work.
    assert body["error"] != "Internal server error"
    assert len(requests) == 1, "an invalid reload must not make a second upstream call"


def test_invalid_endpoint_paths_make_zero_upstream_calls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client_calls: list[str] = []

    async def spy_client() -> httpx.AsyncClient:
        client_calls.append("client")
        raise AssertionError("rejecting a config needs no provider client")

    monkeypatch.setattr(main, "_get_http_client", spy_client)
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, endpoint_line="  endpoint: null\n")
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "_config_cache", None)

    with pytest.raises(RuntimeError, match="Unsupported ai.endpoint value: None"):
        main.load_config()
    with pytest.raises(RuntimeError, match="Unsupported ai.endpoint value: None"):
        with TestClient(main.app):
            pass

    assert client_calls == []


def test_credentials_are_resolved_lazily_per_operation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MISSING_TEXT_KEY", raising=False)
    config = main.AIConfig(
        api_base="https://example.invalid",
        api_key="base-key",
        model="base-model",
        text=main.ProviderOverride(api_key_env="MISSING_TEXT_KEY"),
    )

    assert main._resolve_ai_api_key(main._resolve_ai_config(config, config.ocr)) == "base-key"
    with pytest.raises(main.HTTPException, match="MISSING_TEXT_KEY"):
        main._resolve_ai_api_key(main._resolve_ai_config(config, config.text))


def test_operation_id_is_forwarded_as_provider_idempotency_key() -> None:
    seen_headers: httpx.Headers | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_headers
        seen_headers = request.headers
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "done"}}],
                "model": "test-model",
                "usage": {"total_tokens": 1},
            },
        )

    async def run_request() -> main.OCRResponse:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        previous = main._http_client
        token = main._operation_id.set("translate:1:stable-id")
        main._http_client = client
        try:
            return await main._post_openai_chat_completion(
                _ai_config(), [{"role": "user", "content": "hello"}]
            )
        finally:
            main._operation_id.reset(token)
            main._http_client = previous
            await client.aclose()

    result = asyncio.run(run_request())

    assert result.text == "done"
    assert seen_headers is not None
    assert seen_headers["idempotency-key"] == "translate:1:stable-id"


# ── provider protocol facade ─────────────────────────────────────

def _provider_config(**overrides: object) -> main.AIConfig:
    values: dict[str, object] = {
        "api_base": "https://example.invalid",
        "api_key": "test-key",
        "model": "test-model",
    }
    values.update(overrides)
    return main.AIConfig(**values)


def test_chat_completion_is_the_provider_class() -> None:
    from backend import providers

    assert main._ChatCompletion is providers.ChatCompletion


def test_extract_finish_reason_wrapper_stays_tolerant() -> None:
    assert main._extract_finish_reason(
        {"choices": [{"message": {}, "finish_reason": "length"}]}
    ) == "length"
    assert main._extract_finish_reason({"choices": [{"message": {}}]}) is None
    assert main._extract_finish_reason({}) is None


def test_legacy_chat_request_body_and_headers_are_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(
            {
                "url": str(request.url),
                "headers": dict(request.headers),
                "body": json.loads(request.content),
            }
        )
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "done"}, "finish_reason": "stop"}],
                "model": "reported-model",
                "usage": {"total_tokens": 3},
            },
        )

    async def run() -> main._ChatCompletion:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        previous = main._http_client
        main._http_client = client
        try:
            return await main._request_chat_completion(
                _provider_config(),
                [
                    {"role": "system", "content": "sys"},
                    {"role": "user", "content": "hello"},
                ],
            )
        finally:
            main._http_client = previous
            await client.aclose()

    result = asyncio.run(run())

    assert (result.text, result.model, result.tokens_used, result.finish_reason) == (
        "done",
        "reported-model",
        3,
        "stop",
    )
    assert len(seen) == 1
    request = seen[0]
    assert request["url"] == "https://example.invalid/v1/chat/completions"
    assert request["headers"]["authorization"] == "Bearer test-key"
    assert "idempotency-key" not in request["headers"]
    assert request["body"] == {
        "model": "test-model",
        "messages": [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hello"},
        ],
    }
    assert "temperature" not in request["body"]


# ── legacy Chat wire goldens (captured before protocol adapters) ──

LEGACY_CASES: dict[str, tuple[list[dict], bytes]] = {
    "ocr": (
        [
            {
                "role": "user",
                "content": [
                    main.TextPart("OCR prompt"),
                    main.ImagePart("data:image/png;base64,AA=="),
                ],
            }
        ],
        b'{"model":"test-model","messages":[{"role":"user","content":[{"type":"text","text":"OCR prompt"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]}]}',
    ),
    "dedup": (
        [
            {"role": "system", "content": "Dedup prompt"},
            {"role": "user", "content": "first page\nsecond page"},
        ],
        b'{"model":"test-model","messages":[{"role":"system","content":"Dedup prompt"},{"role":"user","content":"first page\\nsecond page"}]}',
    ),
    "translate": (
        [
            {"role": "system", "content": "Translate to English"},
            {"role": "user", "content": "Hello\nworld"},
        ],
        b'{"model":"test-model","messages":[{"role":"system","content":"Translate to English"},{"role":"user","content":"Hello\\nworld"}]}',
    ),
    "format": (
        [
            {"role": "system", "content": "Format prompt"},
            {"role": "user", "content": "Hello\nworld"},
        ],
        b'{"model":"test-model","messages":[{"role":"system","content":"Format prompt"},{"role":"user","content":"Hello\\nworld"}]}',
    ),
}


def _default_accept_encoding() -> bytes:
    """Read the ``Accept-Encoding`` httpx derives from installed decoders.

    It is ``gzip, deflate`` here and ``gzip, deflate, br, zstd`` where brotli or
    zstandard is installed, so a literal would only pin this machine.
    """

    async def run() -> bytes:
        client = httpx.AsyncClient()
        try:
            return httpx.Headers(client.headers.raw)["accept-encoding"].encode()
        finally:
            await client.aclose()

    return asyncio.run(run())


def _expected_legacy_raw_headers(
    body: bytes, *, idempotency_key: str | None = None
) -> list[tuple[bytes, bytes]]:
    raw = [
        (b"Host", b"example.invalid"),
        (b"Accept", b"*/*"),
        (b"Accept-Encoding", _default_accept_encoding()),
        (b"Connection", b"keep-alive"),
        (b"User-Agent", b"python-httpx/" + httpx.__version__.encode("ascii")),
        (b"Authorization", b"Bearer test-key"),
    ]
    if idempotency_key is not None:
        raw.append((b"Idempotency-Key", idempotency_key.encode("ascii")))
    raw.append((b"Content-Length", str(len(body)).encode("ascii")))
    raw.append((b"Content-Type", b"application/json"))
    return raw


def _capture_legacy_chat_request(
    messages: list[dict], *, idempotency_key: str | None = None
) -> httpx.Request:
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": "ok"}, "finish_reason": "stop"}
                ],
                "model": "test-model",
                "usage": {"total_tokens": 1},
            },
        )

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        previous = main._http_client
        main._http_client = client
        try:
            await main._request_chat_completion(
                main.AIConfig(
                    api_base="https://example.invalid",
                    api_key="test-key",
                    model="test-model",
                ),
                messages,
                idempotency_key=idempotency_key,
            )
        finally:
            main._http_client = previous
            await client.aclose()

    asyncio.run(run())
    assert len(seen) == 1
    return seen[0]


@pytest.mark.parametrize("operation", sorted(LEGACY_CASES))
def test_legacy_chat_wire_goldens_match_pre_change_bytes(operation: str) -> None:
    messages, expected_body = LEGACY_CASES[operation]
    request = _capture_legacy_chat_request(messages)

    assert str(request.url) == "https://example.invalid/v1/chat/completions"
    assert request.content == expected_body
    raw = list(request.headers.raw)
    expected_raw = _expected_legacy_raw_headers(expected_body)
    assert dict(raw) == dict(expected_raw)
    # ``Accept-Encoding`` is host-derived; every other pair is pinned exactly and
    # in order, including the four after httpx's own default headers.
    assert [pair for pair in raw if pair[0] != b"Accept-Encoding"] == [
        pair for pair in expected_raw if pair[0] != b"Accept-Encoding"
    ]
    names = [name for name, _ in raw]
    assert names.index(b"Authorization") < names.index(b"Content-Length")
    assert names.index(b"Content-Length") < names.index(b"Content-Type")
    assert (b"Content-Type", b"application/json") in raw
    assert b"temperature" not in request.content


@pytest.mark.parametrize("operation", sorted(LEGACY_CASES))
def test_legacy_chat_wire_goldens_include_idempotency_without_reordering_headers(
    operation: str,
) -> None:
    messages, expected_body = LEGACY_CASES[operation]
    idempotency_key = f"{operation}-op-1"
    unkeyed = _capture_legacy_chat_request(messages)
    request = _capture_legacy_chat_request(messages, idempotency_key=idempotency_key)

    assert str(request.url) == "https://example.invalid/v1/chat/completions"
    assert request.url == unkeyed.url
    assert request.content == unkeyed.content == expected_body
    raw = list(request.headers.raw)
    names = [name for name, _ in raw]
    assert (b"Idempotency-Key", idempotency_key.encode("ascii")) in raw
    assert names.index(b"Authorization") < names.index(b"Idempotency-Key")
    assert names.index(b"Idempotency-Key") < names.index(b"Content-Length")
    assert names.index(b"Content-Length") < names.index(b"Content-Type")
    expected_raw = _expected_legacy_raw_headers(
        expected_body, idempotency_key=idempotency_key
    )
    assert dict(raw) == dict(expected_raw)
    assert [pair for pair in raw if pair[0] != b"Accept-Encoding"] == [
        pair for pair in expected_raw if pair[0] != b"Accept-Encoding"
    ]
    assert [pair for pair in raw if pair[0] != b"Idempotency-Key"] == list(
        unkeyed.headers.raw
    )


def test_facade_routes_to_the_configured_messages_protocol(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append({"url": str(request.url), "headers": dict(request.headers)})
        return httpx.Response(
            200,
            json={
                "content": [{"type": "text", "text": "bonjour"}],
                "stop_reason": "end_turn",
                "model": "claude-test",
                "usage": {"input_tokens": 5, "output_tokens": 7},
            },
        )

    async def run() -> main._ChatCompletion:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        previous = main._http_client
        main._http_client = client
        try:
            return await main._request_chat_completion(
                _provider_config(endpoint="/v1/messages"),
                [
                    {"role": "system", "content": "sys"},
                    {"role": "user", "content": "hello"},
                ],
            )
        finally:
            main._http_client = previous
            await client.aclose()

    result = asyncio.run(run())

    assert (result.text, result.model, result.tokens_used, result.finish_reason) == (
        "bonjour",
        "claude-test",
        12,
        "end_turn",
    )
    assert seen[0]["url"] == "https://example.invalid/v1/messages"
    assert seen[0]["headers"]["x-api-key"] == "test-key"
    assert seen[0]["headers"]["anthropic-version"] == "2023-06-01"
    assert "authorization" not in seen[0]["headers"]


@pytest.mark.parametrize(
    ("usage", "expected_detail"),
    [
        ({"total_tokens": 3}, "OpenAI API response has invalid model"),
        ({"total_tokens": -1}, "OpenAI API response has invalid token usage"),
    ],
    ids=["invalid-model", "usage-before-model"],
)
def test_legacy_chat_facade_preserves_model_error_detail_and_usage_precedence(
    usage: dict[str, object], expected_detail: str
) -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
                "model": None,
                "usage": usage,
            },
        )

    result, error = _call_facade(_provider_config(), handler)

    assert result is None
    assert isinstance(error, main.HTTPException)
    assert error.status_code == 502
    assert error.detail == expected_detail


def test_facade_reports_malformed_protocol_response_as_bad_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": [], "stop_reason": "end_turn"})

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        previous = main._http_client
        main._http_client = client
        try:
            await main._request_chat_completion(
                _provider_config(endpoint="/v1/messages"),
                [{"role": "user", "content": "hello"}],
            )
        finally:
            main._http_client = previous
            await client.aclose()

    with pytest.raises(main.HTTPException) as exc_info:
        asyncio.run(run())

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == (
        "Anthropic Messages response contains no text content"
    )


_MALFORMED_DATA_URL_DETAIL = (
    "Unsupported image data URL: expected data:<media type>;base64,<payload>"
)


def test_facade_maps_request_construction_failure_to_bad_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested: list[str] = []

    async def forbid_http_client() -> None:
        requested.append("http client")
        raise AssertionError("no network request should be attempted")

    monkeypatch.setattr(main, "_get_http_client", forbid_http_client)

    with pytest.raises(main.HTTPException) as exc_info:
        asyncio.run(
            main._request_chat_completion(
                _provider_config(endpoint="/v1/messages"),
                [
                    {
                        "role": "user",
                        "content": [main.TextPart("prompt"), main.ImagePart("not-a-data-url")],
                    }
                ],
            )
        )

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == _MALFORMED_DATA_URL_DETAIL
    assert requested == []


def test_ocr_maps_request_construction_failure_to_bad_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _app_config().model_copy(
        update={"ai": _provider_config(endpoint="/v1/messages")}
    )
    monkeypatch.setattr(main, "load_config", lambda: config)
    monkeypatch.setattr(
        main, "_image_to_data_url", lambda *_args, **_kwargs: "not-a-data-url"
    )
    requested: list[str] = []

    async def forbid_http_client() -> None:
        requested.append("http client")
        raise AssertionError("no network request should be attempted")

    monkeypatch.setattr(main, "_get_http_client", forbid_http_client)

    client = TestClient(main.app, raise_server_exceptions=False)
    response = client.post(
        "/ocr", files={"image": ("page.png", _png_bytes(), "image/png")}
    )

    assert response.status_code == 502
    assert response.json() == {
        "text": "",
        "model": "",
        "tokens_used": 0,
        "error": _MALFORMED_DATA_URL_DETAIL,
    }
    assert requested == []


def test_ocr_sends_provider_neutral_parts_for_each_protocol(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bodies: list[dict] = []
    responses = {
        "/v1/chat/completions": {
            "choices": [{"message": {"content": "ocr text"}, "finish_reason": "stop"}],
            "model": "chat-model",
            "usage": {"total_tokens": 2},
        },
        "/v1/messages": {
            "content": [{"type": "text", "text": "ocr text"}],
            "stop_reason": "end_turn",
            "model": "messages-model",
        },
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        endpoint = str(request.url).removeprefix("https://example.invalid")
        return httpx.Response(200, json=responses[endpoint])

    async def run(endpoint: str | None) -> main.OCRResponse:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        previous = main._http_client
        main._http_client = client
        try:
            return await main._call_openai(
                _provider_config(endpoint=endpoint),
                "data:image/png;base64,AAAA",
                "ocr prompt",
            )
        finally:
            main._http_client = previous
            await client.aclose()

    chat_result = asyncio.run(run(None))
    messages_result = asyncio.run(run("/v1/messages"))

    assert chat_result.model_dump() == {
        "text": "ocr text",
        "model": "chat-model",
        "tokens_used": 2,
        "error": None,
    }
    assert messages_result.model_dump() == {
        "text": "ocr text",
        "model": "messages-model",
        "tokens_used": 0,
        "error": None,
    }
    assert bodies[0]["messages"] == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "ocr prompt"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            ],
        }
    ]
    assert bodies[1]["messages"] == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "ocr prompt"},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "AAAA",
                    },
                },
            ],
        }
    ]
    assert bodies[1]["max_tokens"] == 4096
    assert "system" not in bodies[1]


def test_blank_route_result_is_rejected_with_the_existing_detail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def blank(_config, _messages, *, idempotency_key=None):
        return main._ChatCompletion("   ", "test-model", 4, "length")

    monkeypatch.setattr(main, "_request_chat_completion", blank)

    with pytest.raises(main.HTTPException) as exc_info:
        asyncio.run(
            main._post_openai_chat_completion(
                _provider_config(), [{"role": "user", "content": "hello"}]
            )
        )

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == "OpenAI API response contains no text content"


def _settings(
    endpoint: str | None = None,
    fallback: int = 4096,
    api_base: str = "https://example.invalid",
) -> main._ResolvedTextSettings:
    config = main.AIConfig(
        api_base=api_base,
        api_key="k",
        model="test-model",
        endpoint=endpoint,
        messages_default_max_tokens=fallback,
    )
    return main._ResolvedTextSettings(
        config=config, prompt="p", provider_endpoint=main.resolve_endpoint(config)
    )


def test_legacy_chat_cache_entry_is_reused_by_resolved_format_settings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Freeze the identity written before protocol selection added endpoint and
    # messages_default_max_tokens; neither new field belongs in this legacy key.
    legacy_identity = {
        "cache_format_version": 1,
        "input_text": "Hello\nworld",
        "max_tokens": None,
        "model": "test-model",
        "operation": "format",
        "pipeline_revision": 1,
        "prompt": "Format {verbatim}",
        "provider_endpoint": "https://example.invalid/v1/chat/completions",
    }
    legacy_digest = hashlib.sha256(
        json.dumps(
            legacy_identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()
    assert legacy_digest == (
        "c80b950b5bce10ffac6026037fe4649111381531b1f932892844fc43cab0e1ff"
    )
    policy = main.CachePolicy()
    generated_at = 1_000_000.0
    cache_path = tmp_path / "legacy-chat-cache.db"
    record = main.CacheRecord(
        key=legacy_digest,
        operation="format",
        text="Legacy Chat output persisted before protocol adapters",
        model="legacy-saved-model",
        generation_tokens=42,
        generated_at=generated_at,
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        writer = main.TransformationCache(
            cache_path, clock=lambda: generated_at, executor=executor
        )
        assert asyncio.run(writer.write(legacy_digest, record, policy)).status == "stored"
        assert cache_path.exists()

        base = _ai_config()
        settings = asyncio.run(
            main._resolve_text_settings(base, "format", legacy_identity["prompt"])
        )
        resolved_digest = main._cache_identity(
            "format", legacy_identity["input_text"], None, settings
        )
        assert resolved_digest == legacy_digest

        # A separate handle must recover the committed SQLite row from disk.
        reader = main.TransformationCache(
            cache_path, clock=lambda: generated_at, executor=executor
        )
        cached = asyncio.run(reader.read(resolved_digest, policy))
        assert cached.status == "hit"
        assert cached.record == record

        config = main.AppConfig(host="localhost", ai=base, cache=policy)
        monkeypatch.setattr(main, "load_config", lambda: config)
        monkeypatch.setattr(main, "_transformation_cache", reader)

        async def unexpected_provider(_request: httpx.Request) -> httpx.Response:
            raise AssertionError("a persisted legacy Chat hit must not call the provider")

        with _mocked_provider(unexpected_provider) as requests:
            response = TestClient(main.app, raise_server_exceptions=False).post(
                "/format",
                json={
                    "text": legacy_identity["input_text"],
                    "prompt": legacy_identity["prompt"],
                },
            )

        assert requests == []
        assert response.status_code == 200
        assert response.headers["x-textkit-cache"] == "hit"
        assert response.json() == {
            "text": record.text,
            "model": record.model,
            "tokens_used": 0,
        }


def test_cache_identity_is_isolated_between_protocols() -> None:
    chat = main._cache_identity("format", "hello", None, _settings())
    responses = main._cache_identity(
        "format", "hello", None, _settings("/v1/responses")
    )
    messages = main._cache_identity("format", "hello", None, _settings("/v1/messages"))
    assert len({chat, responses, messages}) == 3


def test_messages_default_max_tokens_changes_messages_identity_only() -> None:
    first = main._cache_identity(
        "format", "hello", None, _settings("/v1/messages", 4096)
    )
    second = main._cache_identity(
        "format", "hello", None, _settings("/v1/messages", 2048)
    )
    assert first != second
    legacy_a = main._cache_identity("format", "hello", None, _settings(fallback=4096))
    legacy_b = main._cache_identity("format", "hello", None, _settings(fallback=2048))
    assert legacy_a == legacy_b
    responses_a = main._cache_identity(
        "format", "hello", None, _settings("/v1/responses", 4096)
    )
    responses_b = main._cache_identity(
        "format", "hello", None, _settings("/v1/responses", 2048)
    )
    assert responses_a == responses_b


@pytest.mark.parametrize(
    ("endpoint", "expected"),
    [
        (None, "https://example.invalid/v1/chat/completions"),
        ("/v1/chat/completions", "https://example.invalid/v1/chat/completions"),
        ("/v1/responses", "https://example.invalid/v1/responses"),
        ("/v1/messages", "https://example.invalid/v1/messages"),
    ],
)
def test_resolved_text_settings_endpoint_follows_the_protocol(
    endpoint: str | None, expected: str
) -> None:
    base = main.AIConfig(
        api_base="https://example.invalid",
        api_key="k",
        model="test-model",
        endpoint=endpoint,
    )
    settings = asyncio.run(main._resolve_text_settings(base, "format", "p"))
    assert settings.config.endpoint == endpoint
    assert settings.provider_endpoint == expected


# ── per-protocol OCR wire shapes, malformed envelopes, and real transport ──

_PROTOCOL_ENDPOINTS: list[str | None] = [None, "/v1/responses", "/v1/messages"]
_PROTOCOL_IDS = ["chat", "responses", "messages"]

# Long enough to be split by both repair pipelines, so a truncation signal can
# be proven to reach them: above FORMAT_MIN_CHUNK_CHARS and
# TRANSLATE_MIN_CHUNK_CHARS, splitting into two halves that stay non-empty.
_REPAIR_SOURCE = (
    "The formatting pipeline verifies that every single word of the source text "
    "survives a provider call. It splits a truncated chunk at the nearest sentence "
    "boundary and repairs each half independently. Only accepted halves are joined, "
    "and the route then returns the joined result to the caller."
)


def _protocol(endpoint: str | None) -> str:
    return {
        None: "chat",
        "/v1/chat/completions": "chat",
        "/v1/responses": "responses",
        "/v1/messages": "messages",
    }[endpoint]


def _route_config(endpoint: str | None) -> main.AppConfig:
    return main.AppConfig(
        host="localhost",
        ai=_provider_config(endpoint=endpoint),
        cache=main.CachePolicy(enabled=False),
    )


def _protocol_envelope(
    endpoint: str | None, text: str, *, truncated: bool = False
) -> dict:
    """One deterministic valid envelope shaped for the configured protocol."""

    protocol = _protocol(endpoint)
    if protocol == "responses":
        output = (
            []
            if text == ""
            else [{"type": "message", "content": [{"type": "output_text", "text": text}]}]
        )
        if truncated:
            return {
                "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "output": output,
                "model": "reported-model",
                "usage": {"input_tokens": 2, "output_tokens": 3},
            }
        return {
            "status": "completed",
            "output": output,
            "model": "reported-model",
            "usage": {"input_tokens": 2, "output_tokens": 3},
        }
    if protocol == "messages":
        return {
            "content": [] if text == "" else [{"type": "text", "text": text}],
            "stop_reason": "max_tokens" if truncated else "end_turn",
            "model": "reported-model",
            "usage": {"input_tokens": 2, "output_tokens": 3},
        }
    return {
        "choices": [
            {
                "message": {"content": text},
                "finish_reason": "length" if truncated else "stop",
            }
        ],
        "model": "reported-model",
        "usage": {"total_tokens": 5},
    }


def _user_text(endpoint: str | None, body: dict) -> str:
    """The protocol-neutral user text carried by one captured request body."""

    if _protocol(endpoint) == "responses":
        value = body["input"]
    else:
        value = body["messages"][-1]["content"]
    if isinstance(value, list):
        return "".join(
            part.get("text", "") for part in value if isinstance(part, dict)
        )
    assert isinstance(value, str)
    return value


@contextlib.contextmanager
def _mocked_provider(
    handler: Callable[[httpx.Request], Awaitable[httpx.Response]],
) -> Iterator[list[httpx.Request]]:
    """Swap the shared pooled client for a recording ``MockTransport`` client."""

    requests: list[httpx.Request] = []

    async def recording(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return await handler(request)

    async def close() -> None:
        await client.aclose()

    client = httpx.AsyncClient(transport=httpx.MockTransport(recording))
    previous = main._http_client
    main._http_client = client
    try:
        yield requests
    finally:
        main._http_client = previous
        asyncio.run(close())


def _run_ocr(
    monkeypatch: pytest.MonkeyPatch, endpoint: str | None
) -> tuple[httpx.Request, str, dict]:
    monkeypatch.setattr(main, "load_config", lambda: _route_config(endpoint))
    png = _png_bytes()
    data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_protocol_envelope(endpoint, "ocr text"))

    with _mocked_provider(handler) as requests:
        response = TestClient(main.app, raise_server_exceptions=False).post(
            "/ocr",
            files={"image": ("page.png", png, "image/png")},
            data={"prompt": "OCR prompt"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "text": "ocr text",
        "model": "reported-model",
        "tokens_used": 5,
        "error": None,
    }
    assert len(requests) == 1
    return requests[0], data_url, json.loads(requests[0].content)


def test_chat_ocr_uses_image_url_object(monkeypatch: pytest.MonkeyPatch) -> None:
    request, data_url, body = _run_ocr(monkeypatch, None)

    assert str(request.url) == "https://example.invalid/v1/chat/completions"
    assert body["messages"] == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "OCR prompt"},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }
    ]
    assert list(body) == ["model", "messages"]
    assert "system" not in {message["role"] for message in body["messages"]}
    assert request.headers["authorization"] == "Bearer test-key"
    assert request.headers["content-type"] == "application/json"


def test_responses_ocr_uses_wrapped_input_parts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, data_url, body = _run_ocr(monkeypatch, "/v1/responses")

    assert str(request.url) == "https://example.invalid/v1/responses"
    assert body["input"] == [
        {
            "role": "user",
            "content": [
                {"type": "input_text", "text": "OCR prompt"},
                {"type": "input_image", "image_url": data_url},
            ],
        }
    ]
    assert list(body) == ["model", "input", "store"]
    assert body["store"] is False
    assert "instructions" not in body
    assert request.headers["authorization"] == "Bearer test-key"
    assert request.headers["content-type"] == "application/json"


def test_messages_ocr_uses_base64_source_object(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, data_url, body = _run_ocr(monkeypatch, "/v1/messages")

    _media_type, _marker, payload = data_url.partition(";base64,")
    assert str(request.url) == "https://example.invalid/v1/messages"
    assert body["messages"] == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "OCR prompt"},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": payload,
                    },
                },
            ],
        }
    ]
    assert list(body) == ["model", "messages", "max_tokens"]
    assert body["max_tokens"] == 4096
    assert "system" not in body
    assert request.headers["x-api-key"] == "test-key"
    assert request.headers["anthropic-version"] == "2023-06-01"
    assert "authorization" not in request.headers
    assert request.headers["content-type"] == "application/json"


@pytest.mark.parametrize("endpoint", _PROTOCOL_ENDPOINTS, ids=_PROTOCOL_IDS)
def test_idempotency_key_is_sent_for_chat_responses_and_messages(
    monkeypatch: pytest.MonkeyPatch, endpoint: str | None
) -> None:
    monkeypatch.setattr(main, "load_config", lambda: _route_config(endpoint))

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_protocol_envelope(endpoint, "deduped"))

    with _mocked_provider(handler) as requests:
        response = TestClient(main.app, raise_server_exceptions=False).post(
            "/dedup",
            json={"text": "raw text", "prompt": "dedup prompt"},
            headers={"X-TextKit-Operation-Id": "dedup:1:stable-id"},
        )

    assert response.status_code == 200
    assert response.json()["text"] == "deduped"
    assert len(requests) == 1
    assert requests[0].headers["idempotency-key"] == "dedup:1:stable-id"


_UNUSABLE_ENVELOPES: list[tuple[str | None, dict]] = [
    ("/v1/responses", {"status": "failed", "output": []}),
    ("/v1/responses", {"status": "cancelled", "output": []}),
    (
        "/v1/responses",
        {
            "status": "incomplete",
            "incomplete_details": {"reason": "content_filter"},
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "visible"}],
                }
            ],
        },
    ),
    ("/v1/responses", {"status": "in_progress", "output": []}),
    ("/v1/responses", {"status": "queued", "output": []}),
    ("/v1/responses", {"status": "unknown", "output": []}),
    ("/v1/responses", {"model": "reported-model"}),
    ("/v1/responses", {"status": None, "output": []}),
    ("/v1/responses", {"status": 7, "output": []}),
    (
        "/v1/responses",
        {
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": [],
            "error": {"code": "boom"},
        },
    ),
    (
        "/v1/responses",
        {
            "status": "completed",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "visible"}],
                }
            ],
        },
    ),
    (
        "/v1/responses",
        {
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": 5}]}],
        },
    ),
    ("/v1/responses", {"status": "completed", "output": ["not-an-object"]}),
    (
        "/v1/messages",
        {
            "content": [{"type": "thinking", "thinking": "no"}],
            "stop_reason": "end_turn",
        },
    ),
    ("/v1/messages", {"content": [{"type": "text", "text": "   "}], "stop_reason": "end_turn"}),
    ("/v1/messages", {"content": [], "stop_reason": "end_turn"}),
    ("/v1/messages", {"content": "not-a-list", "stop_reason": "end_turn"}),
    (
        "/v1/messages",
        {"content": [{"type": "text", "text": "ok"}], "stop_reason": "pause_turn"},
    ),
    (
        "/v1/messages",
        {
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "error": {"type": "overloaded_error"},
        },
    ),
    (
        "/v1/messages",
        {
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": True},
        },
    ),
    (
        "/v1/messages",
        {
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
            "usage": [],
        },
    ),
]


@pytest.mark.parametrize(
    ("endpoint", "payload"),
    _UNUSABLE_ENVELOPES,
    ids=[
        f"{_protocol(endpoint)}-{index}"
        for index, (endpoint, _payload) in enumerate(_UNUSABLE_ENVELOPES)
    ],
)
def test_malformed_provider_envelopes_return_502_not_500(
    monkeypatch: pytest.MonkeyPatch, endpoint: str | None, payload: dict
) -> None:
    monkeypatch.setattr(main, "load_config", lambda: _route_config(endpoint))

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with _mocked_provider(handler) as requests:
        response = TestClient(main.app, raise_server_exceptions=False).post(
            "/dedup", json={"text": "raw text"}
        )

    assert len(requests) == 1
    assert response.status_code == 502
    body = response.json()
    assert body["text"] == ""
    assert body["tokens_used"] == 0
    assert body["error"]
    assert body["error"] != "Internal server error"


@pytest.mark.parametrize("endpoint", _PROTOCOL_ENDPOINTS, ids=_PROTOCOL_IDS)
def test_malformed_json_and_unexpected_shape_are_502(
    monkeypatch: pytest.MonkeyPatch, endpoint: str | None
) -> None:
    monkeypatch.setattr(main, "load_config", lambda: _route_config(endpoint))
    replies = [httpx.Response(200, text="not json"), httpx.Response(200, json=[1, 2])]

    async def handler(_request: httpx.Request) -> httpx.Response:
        return replies.pop(0)

    with _mocked_provider(handler) as requests:
        client = TestClient(main.app, raise_server_exceptions=False)
        invalid_json = client.post("/dedup", json={"text": "raw text"})
        unexpected_shape = client.post("/dedup", json={"text": "raw text"})

    assert len(requests) == 2
    for response in (invalid_json, unexpected_shape):
        assert response.status_code == 502
        assert response.json()["error"]
    # The provider label in these details is protocol-owned and pinned
    # elsewhere; assert the stable suffix here so the shared decode path stays
    # covered for every protocol.
    assert invalid_json.json()["error"].endswith("API returned invalid JSON")
    assert unexpected_shape.json()["error"].endswith(
        "API returned an unexpected response shape"
    )


def _run_repair(
    monkeypatch: pytest.MonkeyPatch,
    endpoint: str | None,
    route: str,
    *,
    truncation_text: str,
) -> tuple[httpx.Response, list[str]]:
    """Drive one repair route through the real facade against a recording transport.

    Every request carries the protocol's truncation signal, and the response text
    for each call is chosen by the caller: the first reply is ``truncation_text``
    and later replies echo their own input.  A non-empty ``truncation_text`` is
    what proves the stop signal (not blankness) forced the split.
    """

    monkeypatch.setattr(main, "load_config", lambda: _route_config(endpoint))
    seen: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        chunk = _user_text(endpoint, json.loads(request.content))
        seen.append(chunk)
        if len(seen) == 1:
            return httpx.Response(
                200, json=_protocol_envelope(endpoint, truncation_text, truncated=True)
            )
        return httpx.Response(200, json=_protocol_envelope(endpoint, chunk))

    with _mocked_provider(handler):
        payload = (
            {"text": _REPAIR_SOURCE, "prompt": "format prompt"}
            if route == "/format"
            else {"text": _REPAIR_SOURCE, "language": "French", "prompt": "translate prompt"}
        )
        response = TestClient(main.app, raise_server_exceptions=False).post(
            route, json=payload
        )

    return response, seen


@pytest.mark.parametrize("route", ["/format", "/translate"])
@pytest.mark.parametrize("endpoint", _PROTOCOL_ENDPOINTS, ids=_PROTOCOL_IDS)
def test_nonempty_truncation_signal_forces_split_through_real_transport(
    monkeypatch: pytest.MonkeyPatch, endpoint: str | None, route: str
) -> None:
    response, seen = _run_repair(
        monkeypatch, endpoint, route, truncation_text=_REPAIR_SOURCE
    )

    # The truncated reply is non-empty and would pass the normal completeness
    # check, so only the forwarded stop signal can produce child requests.
    assert len(seen) == 3
    assert seen[0] == _REPAIR_SOURCE
    assert sorted(len(chunk) for chunk in seen[1:]) == [145, 146]
    assert response.status_code == 200
    assert main._content_only(response.json()["text"]) == main._content_only(
        _REPAIR_SOURCE
    )
    assert response.json()["tokens_used"] == 15


def test_responses_empty_truncation_reaches_format_repair_through_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response, seen = _run_repair(monkeypatch, "/v1/responses", "/format", truncation_text="")

    assert len(seen) == 3
    assert response.status_code == 200
    assert main._content_only(response.json()["text"]) == main._content_only(
        _REPAIR_SOURCE
    )


def test_responses_empty_truncation_reaches_translate_repair_through_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response, seen = _run_repair(
        monkeypatch, "/v1/responses", "/translate", truncation_text=""
    )

    assert len(seen) == 3
    assert response.status_code == 200
    assert main._content_only(response.json()["text"]) == main._content_only(
        _REPAIR_SOURCE
    )


def test_messages_max_tokens_reaches_existing_route_parser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for route in ("/format", "/translate"):
        response, seen = _run_repair(
            monkeypatch, "/v1/messages", route, truncation_text=""
        )

        assert len(seen) == 3
        assert response.status_code == 200
        assert main._content_only(response.json()["text"]) == main._content_only(
            _REPAIR_SOURCE
        )


@pytest.mark.parametrize("endpoint", _PROTOCOL_ENDPOINTS, ids=_PROTOCOL_IDS)
def test_blank_truncation_is_502_for_ocr_and_dedup(
    monkeypatch: pytest.MonkeyPatch, endpoint: str | None
) -> None:
    monkeypatch.setattr(main, "load_config", lambda: _route_config(endpoint))

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_protocol_envelope(endpoint, "", truncated=True))

    with _mocked_provider(handler) as requests:
        client = TestClient(main.app, raise_server_exceptions=False)
        ocr_response = client.post(
            "/ocr", files={"image": ("page.png", _png_bytes(), "image/png")}
        )
        dedup_response = client.post("/dedup", json={"text": "raw text"})

    assert len(requests) == 2
    for response in (ocr_response, dedup_response):
        assert response.status_code == 502
        assert response.json()["error"] == (
            "OpenAI API response contains no text content"
        )


@pytest.mark.parametrize("endpoint", _PROTOCOL_ENDPOINTS, ids=_PROTOCOL_IDS)
def test_normal_blank_completion_is_502_for_all_protocols(
    monkeypatch: pytest.MonkeyPatch, endpoint: str | None
) -> None:
    """A blank non-truncated completion is never a successful empty response."""

    monkeypatch.setattr(main, "load_config", lambda: _route_config(endpoint))

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_protocol_envelope(endpoint, ""))

    with _mocked_provider(handler) as requests:
        client = TestClient(main.app, raise_server_exceptions=False)
        ocr_response = client.post(
            "/ocr", files={"image": ("page.png", _png_bytes(), "image/png")}
        )
        dedup_response = client.post("/dedup", json={"text": "raw text"})

    assert len(requests) == 2
    for response in (ocr_response, dedup_response):
        assert response.status_code == 502
        assert response.json()["error"]


# ── shared transport: retry, deadline, and pooled client ─────────


def _call_facade(
    config: main.AIConfig,
    handler: Callable[[httpx.Request], Awaitable[httpx.Response]],
) -> tuple[main._ChatCompletion | None, BaseException | None]:
    """Run the real facade against a mock transport, returning result or error."""

    result: main._ChatCompletion | None = None
    error: BaseException | None = None

    async def run() -> None:
        nonlocal result, error
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        previous = main._http_client
        main._http_client = client
        try:
            result = await main._request_chat_completion(
                config, [{"role": "user", "content": "hello"}]
            )
        except BaseException as exc:  # noqa: BLE001 - asserted by the caller
            error = exc
        finally:
            main._http_client = previous
            await client.aclose()

    asyncio.run(run())
    return result, error


def _spy_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    delays: list[float] = []

    async def fake_sleep(delay: float) -> None:
        delays.append(delay)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    return delays


def _spy_wait_for(monkeypatch: pytest.MonkeyPatch) -> list[float | None]:
    recorded: list[float | None] = []
    real_wait_for = asyncio.wait_for

    async def spy(awaitable, timeout=None):
        recorded.append(timeout)
        return await real_wait_for(awaitable, timeout=timeout)

    monkeypatch.setattr(asyncio, "wait_for", spy)
    return recorded


def test_connect_error_retries_exactly_twice(monkeypatch: pytest.MonkeyPatch) -> None:
    delays = _spy_sleep(monkeypatch)
    calls: list[int] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("connection refused", request=request)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "done"}, "finish_reason": "stop"}],
                "model": "test-model",
                "usage": {"total_tokens": 1},
            },
        )

    result, error = _call_facade(_provider_config(), handler)

    assert error is None
    assert result is not None
    assert result.text == "done"
    assert len(calls) == 2
    assert delays == [1]


def test_connect_error_exhausts_after_exactly_two_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every attempt failing pins the ceiling: exactly two calls, one delay."""

    delays = _spy_sleep(monkeypatch)
    calls: list[int] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        raise httpx.ConnectError("connection refused", request=request)

    result, error = _call_facade(_provider_config(), handler)

    assert result is None
    assert isinstance(error, main.HTTPException)
    assert error.status_code == 502
    assert len(calls) == 2, f"expected exactly two attempts, got {len(calls)}"
    assert delays == [1], f"expected exactly one retry delay, got {delays}"


def test_other_request_errors_are_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    delays = _spy_sleep(monkeypatch)
    calls: list[int] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        raise httpx.ReadTimeout("read timed out", request=request)

    _result, error = _call_facade(_provider_config(), handler)

    assert isinstance(error, main.HTTPException)
    assert error.status_code == 502
    assert error.detail == "OpenAI API request failed: ReadTimeout: read timed out"
    assert len(calls) == 1
    assert delays == []


def test_deadline_is_read_timeout_plus_sixty(monkeypatch: pytest.MonkeyPatch) -> None:
    recorded = _spy_wait_for(monkeypatch)
    timeouts: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        timeouts.append(dict(request.extensions["timeout"]))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]},
        )

    config = _provider_config(
        timeout=main.TimeoutConfig(connect=1.5, read=7.5, write=2.5, pool=3.5)
    )
    result, error = _call_facade(config, handler)

    assert error is None
    assert result is not None and result.text == "ok"
    assert recorded == [67.5]
    assert timeouts == [{"connect": 1.5, "read": 7.5, "write": 2.5, "pool": 3.5}]


def test_deadline_expiry_maps_to_504(monkeypatch: pytest.MonkeyPatch) -> None:
    delays = _spy_sleep(monkeypatch)
    calls: list[int] = []

    async def handler(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        raise asyncio.TimeoutError("deadline expired")

    _result, error = _call_facade(_provider_config(), handler)

    assert isinstance(error, main.HTTPException)
    assert error.status_code == 504
    assert error.detail == "OpenAI API did not respond within 660.0s"
    assert len(calls) == 1
    assert delays == []


def test_malformed_envelope_does_not_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    delays = _spy_sleep(monkeypatch)
    calls: list[int] = []

    async def handler(_request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"model": "test"})

    _result, error = _call_facade(_provider_config(), handler)

    assert isinstance(error, main.HTTPException)
    assert error.status_code == 502
    assert "missing choices" in error.detail
    assert len(calls) == 1
    assert delays == []


def test_transport_failure_label_follows_the_resolved_protocol(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Spec decision 5: Messages details say Anthropic, OpenAI details stay OpenAI."""

    delays = _spy_sleep(monkeypatch)

    async def failing(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    messages_result, messages_error = _call_facade(
        _provider_config(endpoint="/v1/messages"), failing
    )
    chat_result, chat_error = _call_facade(_provider_config(), failing)

    assert messages_result is None
    assert isinstance(messages_error, main.HTTPException)
    assert messages_error.status_code == 502
    assert messages_error.detail.startswith("Anthropic API connection failed: ")

    assert chat_result is None
    assert isinstance(chat_error, main.HTTPException)
    assert chat_error.status_code == 502
    assert chat_error.detail.startswith("OpenAI API connection failed: ")

    assert delays == [1, 1]


@pytest.mark.parametrize(
    ("endpoint", "expected_label"),
    [
        (None, "OpenAI"),
        ("/v1/chat/completions", "OpenAI"),
        ("/v1/responses", "OpenAI"),
        ("/v1/messages", "Anthropic"),
    ],
    ids=["legacy", "chat", "responses", "messages"],
)
def test_decode_failure_label_follows_the_resolved_protocol(
    monkeypatch: pytest.MonkeyPatch, endpoint: str | None, expected_label: str
) -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json")

    _result, error = _call_facade(_provider_config(endpoint=endpoint), handler)

    assert isinstance(error, main.HTTPException)
    assert error.status_code == 502
    assert error.detail == f"{expected_label} API returned invalid JSON"


def test_legacy_chat_http_error_detail_keeps_its_wording(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The is_error branch keeps the byte-identical legacy ``OpenAI`` prefix."""

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="bad request")

    _result, error = _call_facade(_provider_config(), handler)

    assert isinstance(error, main.HTTPException)
    assert error.status_code == 502
    assert error.detail == "OpenAI API failed: bad request"


@pytest.mark.parametrize(
    ("endpoint", "expected_label"),
    [
        (None, "OpenAI"),
        ("/v1/chat/completions", "OpenAI"),
        ("/v1/responses", "OpenAI"),
        ("/v1/messages", "Anthropic"),
    ],
    ids=["legacy", "chat", "responses", "messages"],
)
@pytest.mark.parametrize(
    ("upstream_detail", "expected_detail"),
    [
        ("anthropic says no", "anthropic says no"),
        ("x" * 500, "x" * 500),
        ("x" * 501, "x" * 500 + "..."),
    ],
    ids=["short", "at-limit", "truncated"],
)
def test_http_error_detail_uses_protocol_label_and_preserves_truncation(
    endpoint: str | None,
    expected_label: str,
    upstream_detail: str,
    expected_detail: str,
) -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text=upstream_detail)

    result, error = _call_facade(_provider_config(endpoint=endpoint), handler)

    assert result is None
    assert isinstance(error, main.HTTPException)
    assert error.status_code == 502
    assert error.detail == f"{expected_label} API failed: {expected_detail}"


def test_shared_pooled_client_is_reused() -> None:
    """Two sequential lookups share one client, rebuilt only after it is closed."""

    async def run() -> None:
        main._http_client = None
        try:
            first = await main._get_http_client()
            second = await main._get_http_client()
            assert first is second

            # The pool limits live behind httpx internals; the repository pins
            # httpx==0.28.1, and a dependency bump must revisit this assertion.
            pool = first._transport._pool  # type: ignore[attr-defined]
            assert pool._max_connections == 20
            assert pool._max_keepalive_connections == 10

            await first.aclose()
            replacement = await main._get_http_client()
            assert replacement is not first
            assert replacement.is_closed is False
            await replacement.aclose()
        finally:
            main._http_client = None

    asyncio.run(run())

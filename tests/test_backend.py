from __future__ import annotations

import asyncio
import hashlib
import json
import os
from io import BytesIO
from pathlib import Path

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
    with pytest.raises(main.HTTPException) as exc_info:
        main._extract_openai_text({"model": "test"})

    assert exc_info.value.status_code == 502
    assert "missing choices" in exc_info.value.detail


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


def test_legacy_chat_wire_golden_includes_idempotency_without_reordering_json_headers() -> (
    None
):
    messages, expected_body = LEGACY_CASES["ocr"]
    request = _capture_legacy_chat_request(messages, idempotency_key="ocr-op-1")

    raw = list(request.headers.raw)
    names = [name for name, _ in raw]
    assert (b"Idempotency-Key", b"ocr-op-1") in raw
    assert names.index(b"Authorization") < names.index(b"Idempotency-Key")
    assert names.index(b"Idempotency-Key") < names.index(b"Content-Length")
    assert names.index(b"Content-Length") < names.index(b"Content-Type")
    assert request.content == expected_body
    expected_raw = _expected_legacy_raw_headers(
        expected_body, idempotency_key="ocr-op-1"
    )
    assert dict(raw) == dict(expected_raw)
    assert [pair for pair in raw if pair[0] != b"Accept-Encoding"] == [
        pair for pair in expected_raw if pair[0] != b"Accept-Encoding"
    ]


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

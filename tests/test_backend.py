from __future__ import annotations

import asyncio
import hashlib
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
    ["https://example.com:bad", "https://example.com:0", "https://example.com:70000"],
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

    async def fake_format(
        _config: main.AIConfig, text: str, _prompt: str | None = None
    ) -> main.OCRResponse:
        return main.OCRResponse(text=text, model="test-model", tokens_used=1)

    monkeypatch.setattr(main, "format_text", fake_format)
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
    main._config_cache = None

    with pytest.raises(RuntimeError, match="Invalid config.yaml"):
        main.load_config()


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

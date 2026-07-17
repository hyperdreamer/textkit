from __future__ import annotations

import hashlib
import os
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import main


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(main, "load_config", lambda: _app_config())
    return TestClient(main.app, headers={"X-TextKit-Admin-Token": "test-admin"})


@pytest.fixture(autouse=True)
def reset_backend_globals() -> None:
    main._prompt_cache.clear()
    main._rate_events.clear()
    main._active_requests = 0


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
        extension_token="test-extension",
        admin_token="test-admin",
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


@pytest.mark.parametrize("path", ["/ocr", "/dedup", "/translate", "/format"])
def test_ai_endpoints_reject_untrusted_web_origins(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, path: str
) -> None:
    monkeypatch.setattr(main, "load_config", lambda: _app_config())

    response = client.post(path, headers={"Origin": "https://malicious.example"})

    assert response.status_code == 403
    assert response.json()["error"] == "Extension origin is not authorized"


@pytest.mark.parametrize(
    "origin",
    [None, "http://localhost:3000"],
)
def test_ai_endpoints_allow_curl_extension_and_configured_host_origins(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    origin: str | None,
) -> None:
    monkeypatch.setattr(main, "load_config", lambda: _app_config(host="localhost"))

    async def fake_format(
        _config: main.AIConfig, _text: str, _prompt: str | None = None
    ) -> main.OCRResponse:
        return main.OCRResponse(text="formatted", model="test-model", tokens_used=1)

    monkeypatch.setattr(main, "format_text", fake_format)
    headers = {"Origin": origin} if origin else {}

    response = client.post(
        "/format", json={"text": "source", "prompt": "format it"}, headers=headers
    )

    assert response.status_code == 200
    assert response.json()["text"] == "formatted"


def test_extension_origin_requires_shared_secret(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(main, "load_config", lambda: _app_config())
    origin = "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef"

    rejected = client.post("/format", json={"text": "source"}, headers={"Origin": origin})
    assert rejected.status_code == 403

    async def fake_format(
        _config: main.AIConfig, _text: str, _prompt: str | None = None
    ) -> main.OCRResponse:
        return main.OCRResponse(text="formatted", model="test-model", tokens_used=1)

    monkeypatch.setattr(main, "format_text", fake_format)
    accepted = client.post(
        "/format",
        json={"text": "source"},
        headers={"Origin": origin, "X-TextKit-Token": "test-extension"},
    )
    assert accepted.status_code == 200


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


def test_put_base_prompt_invalidates_language_fallback_cache(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path)
    main._prompt_cache.clear()
    (tmp_path / "translate.txt").write_text("old {language}", encoding="utf-8")
    assert main._load_prompt("translate", "French") == "old {language}"

    response = client.put(
        "/prompts/translate", json={"template": "new {language}"}
    )

    assert response.status_code == 200
    assert main._load_prompt("translate", "French") == "new {language}"


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


def test_prompt_put_returns_400_for_malformed_json(client: TestClient) -> None:
    response = client.put(
        "/prompts/ocr",
        content="{",
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 400
    assert response.json()["error"] == "Malformed JSON request body"


def test_prompt_put_returns_422_for_invalid_model(client: TestClient) -> None:
    response = client.put("/prompts/ocr", json={"wrong": "field"})

    assert response.status_code == 422
    assert "template" in response.json()["error"]


@pytest.mark.parametrize("method", ["get", "put"])
@pytest.mark.parametrize("name", ["ocr", "dedup", "format"])
def test_language_parameter_is_rejected_for_non_translation_prompts(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    method: str,
    name: str,
) -> None:
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path)
    kwargs = {"json": {"template": "custom prompt"}} if method == "put" else {}

    response = getattr(client, method)(f"/prompts/{name}?language=French", **kwargs)

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


def test_non_loopback_provider_requires_https() -> None:
    with pytest.raises(main.ValidationError, match="must use HTTPS"):
        main.AIConfig(api_base="http://provider.example", api_key="key", model="model")

    config = main.AIConfig(api_base="http://127.0.0.1:8000", api_key="key", model="model")
    assert config.api_base == "http://127.0.0.1:8000"


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


def test_prompt_put_requires_admin_authentication(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(main, "load_config", lambda: _app_config())
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path)
    unauthenticated = TestClient(main.app)

    response = unauthenticated.put("/prompts/ocr", json={"template": "safe"})

    assert response.status_code == 401
    assert not (tmp_path / "ocr.txt").exists()


def test_prompt_put_is_atomic_private_and_versioned(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(main, "load_config", lambda: _app_config())
    monkeypatch.setattr(main, "PROMPTS_DIR", tmp_path)

    response = client.put("/prompts/ocr", json={"template": "new template"})

    assert response.status_code == 200
    prompt_path = tmp_path / "ocr.txt"
    assert prompt_path.read_text(encoding="utf-8") == "new template"
    assert os.stat(prompt_path).st_mode & 0o777 == 0o600
    assert response.json()["version"] == hashlib.sha256(b"new template").hexdigest()
    assert not list(tmp_path.glob("*.tmp"))


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


def test_config_schema_rejects_invalid_ranges(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text("port: 70000\n", encoding="utf-8")
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    main._config_cache = None

    with pytest.raises(RuntimeError, match="Invalid config.yaml"):
        main.load_config()


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

from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import main


@pytest.fixture
def client() -> TestClient:
    return TestClient(main.app)


def _ai_config() -> main.AIConfig:
    return main.AIConfig(
        api_base="https://example.invalid",
        api_key="test-key",
        model="test-model",
    )


def _app_config(*, host: str = "localhost", debug: bool = False) -> main.AppConfig:
    return main.AppConfig(host=host, debug=debug, ai=_ai_config())


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
    assert response.json()["error"] == (
        "Origin not allowed for AI endpoint: https://malicious.example"
    )


@pytest.mark.parametrize(
    "origin",
    [None, "chrome-extension://abcdefghijklmnop", "http://localhost:3000"],
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
    writes: list[str] = []

    def record_bytes(path: Path, _data: bytes) -> int:
        writes.append(str(path))
        return 1

    def record_text(path: Path, _data: str, **_kwargs: object) -> int:
        writes.append(str(path))
        return 1

    monkeypatch.setattr(Path, "write_bytes", record_bytes)
    monkeypatch.setattr(Path, "write_text", record_text)

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

    assert writes == [
        "/tmp/last_screenshot.png",
        "/tmp/last_ocr.txt",
        "/tmp/pre_dedup.txt",
        "/tmp/after_dedup.txt",
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

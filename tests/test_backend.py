from __future__ import annotations

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

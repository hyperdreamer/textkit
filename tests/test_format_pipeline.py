"""Tests for the verified, lossless /format pipeline.

The provider may silently truncate a response at an output-token cap.  The
pipeline splits text into sentence-aligned chunks, verifies every result kept the
input's words, repairs a bad chunk by splitting further, and ultimately falls
back to the raw chunk — so no content can be dropped.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import main


def _ai_config(**overrides) -> main.AIConfig:
    values: dict = {
        "api_base": "https://example.invalid",
        "api_key": "test-key",
        "model": "test-model",
    }
    values.update(overrides)
    return main.AIConfig(**values)


class FakeProvider:
    """Echoes input, but truncates any request longer than ``safe_chars``."""

    def __init__(self, safe_chars: int = 10_000):
        self.safe_chars = safe_chars
        self.calls: list[str] = []
        self.idempotency_keys: list[str] = []

    async def __call__(self, config, messages, *, idempotency_key=None):
        chunk = messages[-1]["content"]
        self.calls.append(chunk)
        self.idempotency_keys.append(idempotency_key or "")
        if len(chunk) > self.safe_chars:
            return main._ChatCompletion(
                text=chunk[: len(chunk) // 2],
                model=config.model,
                tokens_used=7,
                finish_reason="length",
            )
        return main._ChatCompletion(
            text=chunk, model=config.model, tokens_used=7, finish_reason="stop"
        )


# ── content preservation ─────────────────────────────────────────

class TestContentOnly:
    def test_strips_punctuation_and_whitespace(self):
        assert main._content_only("Hello, world!\n 你好。") == "Helloworld你好"

    def test_keeps_letters_digits_and_cjk(self):
        assert main._content_only("A1中") == "A1中"


class TestContentPreserved:
    def test_accepts_inserted_punctuation(self):
        assert main._content_preserved("你好世界", "你好，世界。") is True

    def test_rejects_truncation(self):
        source = "第一句话。第二句话。第三句话。第四句话。第五句话。"
        assert main._content_preserved(source, "第一句话。第二句话。") is False

    def test_rejects_empty_result(self):
        assert main._content_preserved("some words here", "") is False

    def test_tolerates_a_tiny_edit(self):
        source = "abcdefghij" * 20
        assert main._content_preserved(source, source[:-1] + "X") is True


# ── segmentation ─────────────────────────────────────────────────

class TestSegmentation:
    @pytest.mark.parametrize(
        "text",
        [
            "第一句。第二句。第三句。",
            "no punctuation run on sentence " * 50,
            "line one\nline two\nline three",
            "a" * 5000,
            "",
        ],
    )
    def test_reproduces_input_exactly(self, text):
        chunks = main._segment_for_format(text, 100)
        assert "".join(chunks) == text

    def test_respects_target_size(self):
        text = "".join(f"这是第{i}句话。" for i in range(200))
        chunks = main._segment_for_format(text, 100)
        assert chunks
        assert all(len(chunk) <= 100 for chunk in chunks)

    def test_runon_without_punctuation_is_hard_split(self):
        text = "x" * 1000
        chunks = main._segment_for_format(text, 100)
        assert all(len(chunk) <= 100 for chunk in chunks)
        assert "".join(chunks) == text


class TestSplitInHalf:
    def test_splits_at_a_sentence_boundary(self):
        text = "第一句。第二句。第三句。第四句。"
        parts = main._split_in_half(text)
        assert len(parts) == 2
        assert "".join(parts) == text
        assert parts[0].endswith("。")

    def test_runon_splits_at_midpoint(self):
        text = "x" * 100
        parts = main._split_in_half(text)
        assert "".join(parts) == text
        assert all(parts)


# ── format_text pipeline ─────────────────────────────────────────

class TestFormatTextPipeline:
    def test_passthrough_for_short_text(self, monkeypatch):
        provider = FakeProvider()
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        result = asyncio.run(main.format_text(_ai_config(), "你好。世界。", prompt="fmt"))
        assert result.text == "你好。世界。"
        assert len(provider.calls) == 1

    def test_recovers_from_provider_truncation(self, monkeypatch):
        provider = FakeProvider(safe_chars=120)
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        text = "".join(f"这是第{i}句测试内容。" for i in range(200))
        result = asyncio.run(main.format_text(_ai_config(), text, prompt="fmt"))
        assert main._content_only(result.text) == main._content_only(text)
        assert provider.calls

    def test_lossless_fallback_when_provider_always_truncates(self, monkeypatch):
        provider = FakeProvider(safe_chars=0)
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        text = "".join(f"内容{i}。" for i in range(300))
        result = asyncio.run(main.format_text(_ai_config(), text, prompt="fmt"))
        # Even a permanently-truncating provider cannot remove words.
        assert main._content_only(result.text) == main._content_only(text)

    def test_reports_provider_model_and_tokens(self, monkeypatch):
        provider = FakeProvider()
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        result = asyncio.run(main.format_text(_ai_config(), "你好。", prompt="fmt"))
        assert result.model == "test-model"
        assert result.tokens_used == 7

    def test_chunks_get_distinct_idempotency_keys(self, monkeypatch):
        provider = FakeProvider()
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        text = "".join(f"句子{i}。" for i in range(500))  # forces several chunks
        token = main._operation_id.set("op-1")
        try:
            asyncio.run(main.format_text(_ai_config(), text, prompt="fmt"))
        finally:
            main._operation_id.reset(token)

        keys = provider.idempotency_keys
        assert len(keys) > 1
        assert len(keys) == len(set(keys))
        assert all(key.startswith("op-1:format:") for key in keys)

    def test_whitespace_only_text_is_safe(self, monkeypatch):
        provider = FakeProvider()
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        result = asyncio.run(main.format_text(_ai_config(), " ", prompt="fmt"))
        assert result.text.strip() == ""


def test_format_endpoint_uses_verified_pipeline(monkeypatch):
    provider = FakeProvider(safe_chars=80)
    monkeypatch.setattr(main, "_request_chat_completion", provider)
    monkeypatch.setattr(
        main, "load_config", lambda: main.AppConfig(host="localhost", ai=_ai_config())
    )
    client = TestClient(main.app)
    text = "".join(f"句子{i}。" for i in range(100))

    response = client.post("/format", json={"text": text})

    assert response.status_code == 200
    assert main._content_only(response.json()["text"]) == main._content_only(text)


# ── max_tokens wiring ────────────────────────────────────────────

def _mock_transport(seen: dict):
    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "x"}, "finish_reason": "stop"}],
                "model": "test-model",
                "usage": {"total_tokens": 1},
            },
        )

    return httpx.MockTransport(handler)


class TestMaxTokensWiring:
    def test_included_when_configured(self):
        seen: dict = {}

        async def run():
            client = httpx.AsyncClient(transport=_mock_transport(seen))
            previous = main._http_client
            main._http_client = client
            try:
                await main._request_chat_completion(
                    _ai_config(max_tokens=4096), [{"role": "user", "content": "hi"}]
                )
            finally:
                main._http_client = previous
                await client.aclose()

        asyncio.run(run())
        assert seen["max_tokens"] == 4096

    def test_omitted_when_unset(self):
        seen: dict = {}

        async def run():
            client = httpx.AsyncClient(transport=_mock_transport(seen))
            previous = main._http_client
            main._http_client = client
            try:
                await main._request_chat_completion(
                    _ai_config(), [{"role": "user", "content": "hi"}]
                )
            finally:
                main._http_client = previous
                await client.aclose()

        asyncio.run(run())
        assert "max_tokens" not in seen


class TestMaxTokensConfig:
    def test_accepts_positive_value(self):
        assert _ai_config(max_tokens=1).max_tokens == 1

    @pytest.mark.parametrize("value", [0, -1, 1_000_001])
    def test_rejects_out_of_range(self, value):
        with pytest.raises(Exception):
            _ai_config(max_tokens=value)

    def test_provider_override_propagates(self):
        config = _ai_config(max_tokens=1000, text=main.ProviderOverride(max_tokens=2000))
        assert main._resolve_ai_config(config, config.text).max_tokens == 2000

    def test_provider_override_inherits_when_unset(self):
        config = _ai_config(max_tokens=1000, text=main.ProviderOverride(model="other"))
        assert main._resolve_ai_config(config, config.text).max_tokens == 1000


class TestFinishReason:
    def test_extracts_reason(self):
        payload = {"choices": [{"message": {"content": "x"}, "finish_reason": "length"}]}
        assert main._extract_finish_reason(payload) == "length"

    def test_missing_reason_is_none(self):
        assert main._extract_finish_reason({"choices": [{"message": {"content": "x"}}]}) is None
        assert main._extract_finish_reason({}) is None

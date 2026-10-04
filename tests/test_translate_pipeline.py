"""Tests for the truncation-safe /translate pipeline.

Translation cannot be content-verified across languages, so the pipeline relies on
the provider's ``finish_reason`` plus structural sanity checks.  Text is split into
sentence-aligned chunks translated independently; a chunk the provider truncates is
split and retried, and once it is too small to split the *source* chunk is emitted
rather than a silently truncated translation.
"""

from __future__ import annotations

import asyncio

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


def _is_subsequence(needle: str, haystack: str) -> bool:
    haystack_iter = iter(haystack)
    return all(char in haystack_iter for char in needle)


class FakeTranslator:
    """Wraps each accepted chunk in «», but truncates requests over ``safe_chars``.

    The wrapper stands in for a real translation: it changes the surface text while
    keeping the source's word content intact (the markers are punctuation, which
    :func:`main._content_only` removes), so tests can assert that no source content
    was dropped or reordered.
    """

    def __init__(self, safe_chars: int = 10_000):
        self.safe_chars = safe_chars
        self.calls: list[str] = []
        self.idempotency_keys: list[str] = []
        self.finish_reasons: list[str | None] = []

    async def __call__(self, config, messages, *, idempotency_key=None):
        chunk = messages[-1]["content"]
        self.calls.append(chunk)
        self.idempotency_keys.append(idempotency_key or "")
        if len(chunk) > self.safe_chars:
            self.finish_reasons.append("length")
            return main._ChatCompletion(
                text="«" + chunk[: len(chunk) // 2],
                model=config.model,
                tokens_used=7,
                finish_reason="length",
            )
        self.finish_reasons.append("stop")
        return main._ChatCompletion(
            text="«" + chunk + "»",
            model=config.model,
            tokens_used=7,
            finish_reason="stop",
        )


class DroppingTranslator:
    """Always returns a one-character "translation" with ``finish_reason: "stop"``.

    This stands in for a provider that silently drops content without flagging a
    length stop; the output-length sanity check must catch it.
    """

    def __init__(self):
        self.calls: list[str] = []

    async def __call__(self, config, messages, *, idempotency_key=None):
        self.calls.append(messages[-1]["content"])
        return main._ChatCompletion(
            text="x", model=config.model, tokens_used=1, finish_reason="stop"
        )


# ── completeness heuristic ───────────────────────────────────────

class TestTranslationLooksComplete:
    def test_rejects_empty_output(self):
        assert main._translation_looks_complete("你好世界", "") is False
        assert main._translation_looks_complete("你好世界", "   ") is False

    def test_rejects_grossly_short_output(self):
        source = "这是一段足够长的中文文本需要被完整翻译。" * 20
        assert main._translation_looks_complete(source, "x") is False

    def test_accepts_expanded_translation(self):
        # CJK -> English expands, so the output is longer than the source.
        assert main._translation_looks_complete("你好世界", "Hello world") is True

    def test_accepts_compacted_translation(self):
        # English -> CJK is much shorter but still a plausible translation.
        source = "hello world how are you doing today my friend"
        assert main._translation_looks_complete(source, "你好朋友") is True

    def test_accepts_punctuation_only_source(self):
        assert main._translation_looks_complete("。。。", "…") is True


# ── translate_text pipeline ──────────────────────────────────────

class TestTranslateTextPipeline:
    def test_short_text_is_translated_in_one_call(self, monkeypatch):
        provider = FakeTranslator()
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        result = asyncio.run(
            main.translate_text(_ai_config(), "你好。世界。", "English", prompt="tr")
        )
        assert len(provider.calls) == 1
        assert result.text == "«你好。世界。»"

    def test_recovers_from_provider_truncation_without_dropping_content(self, monkeypatch):
        provider = FakeTranslator(safe_chars=120)
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        text = "".join(f"这是第{i}句测试内容。" for i in range(200))
        result = asyncio.run(main.translate_text(_ai_config(), text, "English", prompt="tr"))
        # Every source chunk appears, in order, and none was silently dropped.
        assert main._content_only(result.text) == main._content_only(text)
        assert _is_subsequence(main._content_only(text), main._content_only(result.text))
        assert len(provider.calls) > 1

    def test_lossless_fallback_when_provider_always_truncates(self, monkeypatch):
        provider = FakeTranslator(safe_chars=0)
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        text = "".join(f"内容{i}。" for i in range(300))
        result = asyncio.run(main.translate_text(_ai_config(), text, "English", prompt="tr"))
        # A permanently-truncating provider yields the source text, never a
        # truncated translation.
        assert main._content_only(result.text) == main._content_only(text)
        assert result.text.strip()

    def test_silently_dropped_output_falls_back_to_source(self, monkeypatch):
        provider = DroppingTranslator()
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        text = "".join(f"句子{i}。" for i in range(100))
        result = asyncio.run(main.translate_text(_ai_config(), text, "English", prompt="tr"))
        assert main._content_only(result.text) == main._content_only(text)

    def test_run_on_sentence_is_hard_split(self, monkeypatch):
        provider = FakeTranslator(safe_chars=100)
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        text = "x" * 500  # no punctuation, so segmentation must hard-split
        result = asyncio.run(main.translate_text(_ai_config(), text, "English", prompt="tr"))
        assert main._content_only(result.text) == main._content_only(text)
        assert all(len(call) <= main.TRANSLATE_CHUNK_CHARS for call in provider.calls)

    def test_reports_provider_model_and_aggregate_tokens(self, monkeypatch):
        provider = FakeTranslator()
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        result = asyncio.run(
            main.translate_text(_ai_config(), "你好。", "English", prompt="tr")
        )
        assert result.model == "test-model"
        assert result.tokens_used == 7

    def test_chunks_get_distinct_idempotency_keys(self, monkeypatch):
        provider = FakeTranslator()
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        text = "".join(f"句子{i}。" for i in range(500))  # forces several chunks
        token = main._operation_id.set("op-1")
        try:
            asyncio.run(main.translate_text(_ai_config(), text, "English", prompt="tr"))
        finally:
            main._operation_id.reset(token)

        keys = provider.idempotency_keys
        assert len(keys) > 1
        assert len(keys) == len(set(keys))
        assert all(key.startswith("op-1:translate:") for key in keys)

    def test_whitespace_only_text_is_safe(self, monkeypatch):
        provider = FakeTranslator()
        monkeypatch.setattr(main, "_request_chat_completion", provider)
        result = asyncio.run(main.translate_text(_ai_config(), " ", "English", prompt="tr"))
        assert result.text.strip() == ""


def test_translate_endpoint_uses_chunked_pipeline(monkeypatch):
    provider = FakeTranslator(safe_chars=80)
    monkeypatch.setattr(main, "_request_chat_completion", provider)
    monkeypatch.setattr(
        main, "load_config", lambda: main.AppConfig(host="localhost", ai=_ai_config())
    )
    client = TestClient(main.app)
    text = "".join(f"句子{i}。" for i in range(100))

    response = client.post("/translate", json={"text": text, "language": "English", "prompt": "tr"})

    assert response.status_code == 200
    body = response.json()
    assert set(body) >= {"text", "model", "tokens_used"}
    assert main._content_only(body["text"]) == main._content_only(text)


def test_translate_endpoint_response_shape(monkeypatch):
    provider = FakeTranslator()
    monkeypatch.setattr(main, "_request_chat_completion", provider)
    monkeypatch.setattr(
        main, "load_config", lambda: main.AppConfig(host="localhost", ai=_ai_config())
    )
    client = TestClient(main.app)

    response = client.post("/translate", json={"text": "你好。", "language": "English", "prompt": "tr"})

    assert response.status_code == 200
    assert set(response.json()) == {"text", "model", "tokens_used"}


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
def test_translate_segmentation_never_loses_or_reorders(monkeypatch, text):
    provider = FakeTranslator(safe_chars=200)
    monkeypatch.setattr(main, "_request_chat_completion", provider)
    result = asyncio.run(main.translate_text(_ai_config(), text, "English", prompt="tr"))
    assert main._content_only(result.text) == main._content_only(text)

# Upstream Protocol Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Add an optional `ai.endpoint` config key that selects OpenAI Chat Completions (legacy default), OpenAI Responses, or Anthropic Messages, without changing the extension or any local route contract.

**Architecture:** A new deep module `backend/providers.py` owns request serialization, auth headers, token-limit field naming, response envelope validation, and stop-signal normalization behind a small `ProtocolAdapter` contract that takes protocol-neutral content parts. `backend/main.py` keeps configuration, the HTTP client, retry/deadline policy, caching, and route handlers, and delegates through a preserved `_request_chat_completion` facade whose signature is unchanged so 32 existing monkeypatch sites keep working.

**Tech Stack:** Python 3.10+, FastAPI, pydantic 2, httpx 0.28.1, pytest. Vanilla JS extension tests are unchanged.

**Authority:** `docs/superpowers/specs/2026-10-18-upstream-protocol-adapters-spec.md` (approved). Where this plan and the spec disagree, the spec wins.

## Global Constraints

- Supported `ai.endpoint` values are exactly `/v1/chat/completions`, `/v1/responses`, `/v1/messages`. Present `null`, non-string, alias, or full URL is a config error.
- Absent `ai.endpoint` reproduces today's request URL, headers, and body byte-for-byte, and TextKit never sends `temperature`.
- `ai.endpoint` is a base `ai` field only; `ai.ocr` and `ai.text` may not override it (`FrozenModel(extra="forbid")`).
- Auth: `Authorization: Bearer` for both OpenAI protocols; `x-api-key` plus `anthropic-version: 2023-06-01` for Messages.
- No adapter may set `Content-Type`; httpx derives it from `json=`.
- Token limits: Chat `max_tokens`; Responses `max_output_tokens`; Messages `max_tokens` always, falling back to `ai.messages_default_max_tokens` (default 4096, `strict=True, gt=0`).
- `CACHE_FORMAT_VERSION` stays `1`; the legacy digest `c80b950b5bce10ffac6026037fe4649111381531b1f932892844fc43cab0e1ff` must not change.
- `_request_chat_completion` keeps its exact signature and remains the monkeypatched seam; `main._ChatCompletion is providers.ChatCompletion`.
- `main._extract_finish_reason` and `main._extract_openai_text` must remain importable from `main`.
- No changes under `extension/`. No streaming, tools, conversation state, provider autodetection, arbitrary paths, or provider SDKs.
- `backend/config.yaml` is git-ignored: never commit it.
- Verification: `python -m pytest tests/ -v` and `node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js`.
- Baseline before any change: 278 Python tests pass; Node 84/28/10 pass.

## Task 1: Provider module types, URL resolver, and adapters

**Implementer tier:** Advanced

**Files:**

- Create: `backend/providers.py`
- Test: `tests/test_providers.py`

**Interfaces:**

- Consumes: nothing; this is the first task. `AIConfig` is imported under `TYPE_CHECKING` only.
- Produces: `TextPart(text: str)`, `ImagePart(data_url: str)`, `ProviderRequest` TypedDict with keys `url`, `headers`, `body`, `ChatCompletion(text, model, tokens_used, finish_reason=None)` frozen dataclass in that field order, `ProviderProtocolError`, `ProtocolAdapter` Protocol with `build_request(*, config, system_prompt, content)` and `parse_response(payload, *, configured_model)`, `resolve_endpoint(config) -> str`, `select_adapter(config) -> ProtocolAdapter`, and `ChatCompletionsAdapter` / `ResponsesAdapter` / `MessagesAdapter`, each with no constructor arguments.

- [ ] **Step 1: Write the failing test for the URL resolver and selector**

```python
from __future__ import annotations

import pytest

from backend import providers


def _config(**overrides):
    values = {
        "api_base": "https://example.invalid",
        "api_key": "test-key",
        "model": "test-model",
    }
    values.update(overrides)
    from backend import main

    return main.AIConfig(**values)


@pytest.mark.parametrize(
    ("endpoint", "expected"),
    [
        (None, "https://example.invalid/v1/chat/completions"),
        ("/v1/chat/completions", "https://example.invalid/v1/chat/completions"),
        ("/v1/responses", "https://example.invalid/v1/responses"),
        ("/v1/messages", "https://example.invalid/v1/messages"),
    ],
)
def test_resolve_endpoint_is_plain_concatenation(endpoint, expected):
    assert providers.resolve_endpoint(_config(endpoint=endpoint)) == expected


@pytest.mark.parametrize(
    ("endpoint", "adapter_type"),
    [
        (None, providers.ChatCompletionsAdapter),
        ("/v1/chat/completions", providers.ChatCompletionsAdapter),
        ("/v1/responses", providers.ResponsesAdapter),
        ("/v1/messages", providers.MessagesAdapter),
    ],
)
def test_select_adapter_maps_exactly(endpoint, adapter_type):
    assert type(providers.select_adapter(_config(endpoint=endpoint))) is adapter_type


def test_resolve_endpoint_preserves_gateway_prefix():
    config = _config(api_base="https://gateway.example/proxy", endpoint="/v1/messages")
    assert providers.resolve_endpoint(config) == "https://gateway.example/proxy/v1/messages"
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `python -m pytest tests/test_providers.py -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'backend.providers'`.

- [ ] **Step 3: Create the module with types, resolver, and selector**

```python
"""Provider wire protocols: request serialization, auth, and response normalization."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, TypedDict

if TYPE_CHECKING:  # pragma: no cover - annotations only, avoids an import cycle
    from .main import AIConfig

_ABSENT = object()

_DATA_URL_PATTERN = re.compile(r"^data:([^;]+);base64,(.+)$", re.DOTALL)


@dataclass(frozen=True)
class TextPart:
    text: str


@dataclass(frozen=True)
class ImagePart:
    data_url: str


class ProviderRequest(TypedDict):
    url: str
    headers: dict[str, str]
    body: dict[str, Any]


@dataclass(frozen=True)
class ChatCompletion:
    text: str
    model: str
    tokens_used: int
    finish_reason: str | None = None


class ProviderProtocolError(Exception):
    """A malformed request part or provider response envelope."""


class ProtocolAdapter(Protocol):
    def build_request(
        self,
        *,
        config: AIConfig,
        system_prompt: str | None,
        content: str | Sequence[TextPart | ImagePart],
    ) -> ProviderRequest: ...

    def parse_response(
        self, payload: object, *, configured_model: str
    ) -> ChatCompletion: ...


def resolve_endpoint(config: AIConfig) -> str:
    """Return the one request URL for the effective protocol.

    ``api_base`` is already stripped of trailing slashes by
    ``_validate_api_base_value``, so this is plain concatenation in both modes.
    """
    if config.endpoint is None:
        return config.api_base + "/v1/chat/completions"
    return config.api_base + config.endpoint


def select_adapter(config: AIConfig) -> ProtocolAdapter:
    """Select the exact configured protocol; Chat is the legacy default."""
    if config.endpoint == "/v1/responses":
        return ResponsesAdapter()
    if config.endpoint == "/v1/messages":
        return MessagesAdapter()
    return ChatCompletionsAdapter()
```

Then add the three adapter classes with `build_request` and `parse_response`, plus the private helpers listed in the spec. Start with Chat only in this task; Tasks 2 and 3 add the other two protocol bodies and response rules.

```python
class ChatCompletionsAdapter:
    """Concrete adapter for legacy and explicit Chat Completions."""

    def build_request(self, *, config, system_prompt, content):
        messages: list[dict[str, Any]] = []
        if system_prompt is not None:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": _render_chat_content(content)})
        body: dict[str, Any] = {"model": config.model, "messages": messages}
        if config.max_tokens:
            body["max_tokens"] = config.max_tokens
        return {
            "url": resolve_endpoint(config),
            "headers": {"Authorization": f"Bearer {config.api_key}"},
            "body": body,
        }

    def parse_response(self, payload, *, configured_model):
        raise NotImplementedError
```

Add stubs for `ResponsesAdapter` and `MessagesAdapter` whose `build_request` and `parse_response` raise `NotImplementedError`, so the selector test passes now and Tasks 2 and 3 replace them.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `python -m pytest tests/test_providers.py -v`
Expected: PASS, 9 tests.

- [ ] **Step 5: Add failing tests for Chat request bytes and no-temperature rule**

```python
def test_chat_request_omits_temperature_and_content_type():
    request = providers.ChatCompletionsAdapter().build_request(
        config=_config(),
        system_prompt="sys",
        content="user text",
    )
    assert request["body"] == {
        "model": "test-model",
        "messages": [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "user text"},
        ],
    }
    assert list(request["body"]) == ["model", "messages"]
    assert request["headers"] == {"Authorization": "Bearer test-key"}


def test_chat_request_includes_max_tokens_only_when_positive():
    with_limit = providers.ChatCompletionsAdapter().build_request(
        config=_config(max_tokens=4096),
        system_prompt="sys",
        content="user text",
    )
    assert with_limit["body"]["max_tokens"] == 4096

    without_limit = providers.ChatCompletionsAdapter().build_request(
        config=_config(),
        system_prompt="sys",
        content="user text",
    )
    assert "max_tokens" not in without_limit["body"]
```

- [ ] **Step 6: Commit**

```bash
git add backend/providers.py tests/test_providers.py
git commit -m "feat(providers): add protocol types, URL resolver, and Chat adapter"
```

## Task 2: Chat response normalization preserving legacy semantics

**Implementer tier:** Advanced

**Files:**

- Modify: `backend/providers.py`
- Test: `tests/test_providers.py`

**Interfaces:**

- Consumes: `ChatCompletion`, `ProviderProtocolError`, `_ABSENT`, `ChatCompletionsAdapter` from Task 1.
- Produces: working `ChatCompletionsAdapter.parse_response(payload, *, configured_model) -> ChatCompletion`, plus `_extract_chat_text`, `_chat_usage_tokens`, `_chat_finish_reason`, `_require_mapping`, `_require_model`, `_require_non_negative_int`, all raising `ProviderProtocolError`.

- [ ] **Step 1: Write the failing tests for Chat text extraction**

```python
import pytest

from backend import providers


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("  hello  ", "hello"),
        ([{"type": "text", "text": " a "}, {"type": "text", "text": " b "}], "a\nb"),
    ],
)
def test_chat_text_is_stripped_and_list_parts_join_with_newline(content, expected):
    payload = {"choices": [{"message": {"content": content}}]}
    result = providers.ChatCompletionsAdapter().parse_response(
        payload, configured_model="cfg"
    )
    assert result.text == expected


@pytest.mark.parametrize("content", ["", "   ", None])
def test_chat_blank_content_is_rejected(content):
    payload = {"choices": [{"message": {"content": content}}]}
    with pytest.raises(providers.ProviderProtocolError):
        providers.ChatCompletionsAdapter().parse_response(payload, configured_model="cfg")


def test_chat_missing_choices_message_mentions_missing_choices():
    with pytest.raises(providers.ProviderProtocolError, match="missing choices"):
        providers.ChatCompletionsAdapter().parse_response(
            {"model": "m"}, configured_model="cfg"
        )
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `python -m pytest tests/test_providers.py -v -k chat`
Expected: FAIL, `NotImplementedError`.

- [ ] **Step 3: Implement Chat normalization preserving today's rules exactly**

Reuse the current `_extract_openai_text` logic, replacing `HTTPException` with `ProviderProtocolError` and keeping the detail strings.

```python
def _require_mapping(payload: object, label: str) -> Mapping[str, Any]:
    if not isinstance(payload, Mapping):
        raise ProviderProtocolError(
            f"provider {label} must be an object, got {type(payload).__name__}"
        )
    return payload


def _require_model(payload: Mapping[str, Any], configured_model: str) -> str:
    raw = payload.get("model", _ABSENT)
    if raw is _ABSENT:
        return configured_model
    if not isinstance(raw, str):
        raise ProviderProtocolError(
            f"provider response field model must be a string, got {raw!r}"
        )
    return raw


def _extract_chat_text(payload: Mapping[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ProviderProtocolError("OpenAI API response is missing choices")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise ProviderProtocolError("OpenAI API response is missing choices[0].message")
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    if isinstance(content, list):
        parts = [
            part["text"].strip()
            for part in content
            if isinstance(part, dict)
            and part.get("type") == "text"
            and isinstance(part.get("text"), str)
            and part["text"].strip()
        ]
        if parts:
            return "\n".join(parts)
    raise ProviderProtocolError("OpenAI API response contains no text content")


def _chat_usage_tokens(payload: Mapping[str, Any]) -> int:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return 0
    total = usage.get("total_tokens", 0)
    if not isinstance(total, int) or total < 0:
        raise ProviderProtocolError("OpenAI API response has invalid token usage")
    return total


def _chat_finish_reason(payload: Mapping[str, Any]) -> str | None:
    choices = payload.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        reason = choices[0].get("finish_reason")
        if isinstance(reason, str):
            return reason
    return None
```

`parse_response` then becomes:

```python
def parse_response(self, payload, *, configured_model):
    mapping = _require_mapping(payload, "response")
    return ChatCompletion(
        text=_extract_chat_text(mapping),
        model=_require_model(mapping, configured_model),
        tokens_used=_chat_usage_tokens(mapping),
        finish_reason=_chat_finish_reason(mapping),
    )
```

Do not call `_reject_non_null_error` in Chat.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `python -m pytest tests/test_providers.py -v -k chat`
Expected: PASS.

- [ ] **Step 5: Add the Chat usage compatibility table test**

```python
_CHAT_PAYLOAD = {
    "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]
}


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        (None, 0),
        ({}, 0),
        ({"total_tokens": 3}, 3),
        ({"total_tokens": True}, 1),
        ({"total_tokens": 0}, 0),
        ({"prompt_tokens": "bad"}, 0),
        ({"total_tokens": 3, "prompt_tokens": "bad"}, 3),
    ],
)
def test_chat_usage_compatibility_table(usage, expected):
    payload = dict(_CHAT_PAYLOAD)
    if usage is not None:
        payload["usage"] = usage
    result = providers.ChatCompletionsAdapter().parse_response(
        payload, configured_model="cfg"
    )
    assert result.tokens_used == expected


def test_chat_usage_absent_normalizes_to_zero():
    result = providers.ChatCompletionsAdapter().parse_response(
        _CHAT_PAYLOAD, configured_model="cfg"
    )
    assert result.tokens_used == 0


@pytest.mark.parametrize(
    "usage",
    [
        {"total_tokens": -1},
        {"total_tokens": 1.0},
        {"total_tokens": "3"},
        {"total_tokens": None},
    ],
)
def test_chat_rejects_invalid_total_tokens(usage):
    payload = dict(_CHAT_PAYLOAD)
    payload["usage"] = usage
    with pytest.raises(providers.ProviderProtocolError):
        providers.ChatCompletionsAdapter().parse_response(
            payload, configured_model="cfg"
        )
```

- [ ] **Step 6: Add a regression test that Chat ignores a populated `error`**

```python
def test_chat_ignores_populated_error_field():
    payload = {
        "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
        "usage": {"total_tokens": 3},
        "model": "upstream",
        "error": {"code": "server_error"},
    }
    result = providers.ChatCompletionsAdapter().parse_response(
        payload, configured_model="cfg"
    )
    assert result.text == "ok"
    assert result.tokens_used == 3
```

- [ ] **Step 7: Run the full provider test file and commit**

Run: `python -m pytest tests/test_providers.py -v`
Expected: PASS, all tests.

```bash
git add backend/providers.py tests/test_providers.py
git commit -m "feat(providers): normalize Chat responses with legacy semantics"
```

## Task 3: Responses and Messages adapters

**Implementer tier:** Advanced

**Files:**

- Modify: `backend/providers.py`
- Test: `tests/test_providers.py`

**Interfaces:**

- Consumes: `resolve_endpoint`, `_require_mapping`, `_require_model`, `_require_non_negative_int`, `_ABSENT`, `TextPart`, `ImagePart`, `ProviderProtocolError` from Tasks 1-2.
- Produces: working `ResponsesAdapter` and `MessagesAdapter`, plus `_render_responses_input`, `_render_messages_content`, `_render_chat_content`, `_parse_messages_data_url`, `_reject_non_null_error`, `_responses_usage_tokens`, `_messages_usage_tokens`, `_extract_responses_text`, `_extract_messages_text`, `_responses_finish_reason`, `_messages_finish_reason`.

- [ ] **Step 1: Write the failing tests for the two request bodies**

```python
def test_responses_request_wraps_parts_in_a_user_message():
    request = providers.ResponsesAdapter().build_request(
        config=_config(endpoint="/v1/responses"),
        system_prompt=None,
        content=(providers.TextPart("caption"), providers.ImagePart("data:image/png;base64,AA==")),
    )
    assert request["body"] == {
        "model": "test-model",
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "caption"},
                    {"type": "input_image", "image_url": "data:image/png;base64,AA=="},
                ],
            }
        ],
        "store": False,
    }
    assert request["headers"] == {"Authorization": "Bearer test-key"}


def test_responses_string_input_stays_a_string():
    request = providers.ResponsesAdapter().build_request(
        config=_config(endpoint="/v1/responses"), system_prompt="sys", content="body"
    )
    assert request["body"]["input"] == "body"
    assert request["body"]["instructions"] == "sys"
    assert request["body"]["store"] is False


def test_messages_request_parses_data_url_into_source():
    request = providers.MessagesAdapter().build_request(
        config=_config(endpoint="/v1/messages"),
        system_prompt=None,
        content=(providers.TextPart("caption"), providers.ImagePart("data:image/png;base64,AA==")),
    )
    assert request["body"]["messages"] == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "caption"},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "AA==",
                    },
                },
            ],
        }
    ]
    assert request["body"]["max_tokens"] == 4096
    assert request["headers"] == {
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
    }
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `python -m pytest tests/test_providers.py -v -k "responses_request or messages_request"`
Expected: FAIL, `NotImplementedError`.

- [ ] **Step 3: Implement the three renderers and the data-URL parser**

```python
def _render_chat_content(content):
    if isinstance(content, str):
        return content
    rendered = []
    for part in content:
        if isinstance(part, TextPart):
            rendered.append({"type": "text", "text": part.text})
        elif isinstance(part, ImagePart):
            rendered.append({"type": "image_url", "image_url": {"url": part.data_url}})
        else:
            raise ProviderProtocolError(f"unsupported content part {type(part).__name__}")
    return rendered


def _render_responses_input(content):
    if isinstance(content, str):
        return content
    rendered = []
    for part in content:
        if isinstance(part, TextPart):
            rendered.append({"type": "input_text", "text": part.text})
        elif isinstance(part, ImagePart):
            rendered.append({"type": "input_image", "image_url": part.data_url})
        else:
            raise ProviderProtocolError(f"unsupported content part {type(part).__name__}")
    return [{"role": "user", "content": rendered}]


def _parse_messages_data_url(data_url):
    match = _DATA_URL_PATTERN.fullmatch(data_url)
    if match is None:
        raise ProviderProtocolError("malformed image data URL for the Messages protocol")
    return match.group(1), match.group(2)


def _render_messages_content(content):
    if isinstance(content, str):
        return content
    rendered = []
    for part in content:
        if isinstance(part, TextPart):
            rendered.append({"type": "text", "text": part.text})
        elif isinstance(part, ImagePart):
            media_type, payload = _parse_messages_data_url(part.data_url)
            rendered.append(
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": payload},
                }
            )
        else:
            raise ProviderProtocolError(f"unsupported content part {type(part).__name__}")
    return rendered
```

`ResponsesAdapter.build_request` builds `{"model": ...}`, adds `instructions` only when `system_prompt is not None`, adds `input`, always adds `"store": False`, and adds `max_output_tokens` only when `config.max_tokens` is truthy. `MessagesAdapter.build_request` builds `{"model": ...}`, adds `system` only when not `None`, adds `messages` with one user turn, and always sets `max_tokens` to `config.max_tokens if config.max_tokens else config.messages_default_max_tokens`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `python -m pytest tests/test_providers.py -v -k "responses_request or messages_request"`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for Responses and Messages response normalization**

```python
def test_responses_concatenates_output_text_and_prefers_total_tokens():
    payload = {
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "output": [
            {"type": "reasoning", "summary": [{"type": "output_text", "text": "no"}]},
            {"type": "message", "content": [
                {"type": "output_text", "text": "p1"},
                {"type": "refusal", "text": "no"},
                {"type": "output_text", "text": "p2"},
            ]},
            {"type": "message", "content": [{"type": "output_text", "text": "p3"}]},
        ],
        "usage": {"input_tokens": 7, "output_tokens": 8, "total_tokens": 99},
        "model": "upstream",
    }
    result = providers.ResponsesAdapter().parse_response(payload, configured_model="cfg")
    assert result.text == "p1p2p3"
    assert result.tokens_used == 99
    assert result.model == "upstream"
    assert result.finish_reason is None


def test_responses_max_output_tokens_truncation_maps_to_length():
    payload = {
        "status": "incomplete",
        "incomplete_details": {"reason": "max_output_tokens"},
        "output": [{"type": "message", "content": [{"type": "output_text", "text": "cut"}]}],
    }
    result = providers.ResponsesAdapter().parse_response(payload, configured_model="cfg")
    assert result.finish_reason == "length"
    assert result.text == "cut"


def test_responses_empty_truncation_is_valid():
    payload = {
        "status": "incomplete",
        "incomplete_details": {"reason": "max_output_tokens"},
        "output": [],
    }
    result = providers.ResponsesAdapter().parse_response(payload, configured_model="cfg")
    assert result.text == ""
    assert result.finish_reason == "length"


def test_messages_concatenates_text_blocks_and_sums_usage():
    payload = {
        "content": [
            {"type": "thinking", "thinking": "no"},
            {"type": "text", "text": "p1"},
            {"type": "text", "text": "p2"},
        ],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 7, "output_tokens": 8},
        "model": "upstream",
    }
    result = providers.MessagesAdapter().parse_response(payload, configured_model="cfg")
    assert result.text == "p1p2"
    assert result.tokens_used == 15


def test_messages_max_tokens_maps_to_length():
    payload = {
        "content": [{"type": "text", "text": "cut"}],
        "stop_reason": "max_tokens",
    }
    result = providers.MessagesAdapter().parse_response(payload, configured_model="cfg")
    assert result.finish_reason == "length"
```

- [ ] **Step 6: Run the tests and confirm they fail**

Run: `python -m pytest tests/test_providers.py -v -k "responses_ or messages_"`
Expected: FAIL, `NotImplementedError`.

- [ ] **Step 7: Implement Responses and Messages normalization**

`_reject_non_null_error` rejects any present non-null `error`. `_responses_finish_reason` returns `"length"` only for `status == "incomplete"` with `incomplete_details` an object whose `reason` is `"max_output_tokens"`, `None` for `completed`, and raises otherwise. `_extract_responses_text` scans `output` as specified, joining `output_text` parts with no separator, and honours an `allow_empty` flag that is true only for a recognized truncation. `_messages_finish_reason` maps `max_tokens` to `"length"`, allows `end_turn`/`stop_sequence`/absent, and raises otherwise. `_extract_messages_text` joins `text` blocks with no separator and honours `allow_empty` for `max_tokens`.

Both use `strip()` on normal output and raise `ProviderProtocolError` when the stripped text is empty. Usage helpers implement the strict rules from the spec, using `_require_non_negative_int`.

- [ ] **Step 8: Run the full provider test file and commit**

Run: `python -m pytest tests/test_providers.py -v`
Expected: PASS, all tests.

```bash
git add backend/providers.py tests/test_providers.py
git commit -m "feat(providers): add Responses and Messages adapters"
```

## Task 4: Config fields, raw-YAML validation, and inheritance

**Implementer tier:** Advanced

**Files:**

- Modify: `backend/main.py:217-232` (`AIConfig`), `backend/main.py:392-415` (`load_config`), `backend/main.py:451-463` (`_resolve_ai_config`)
- Test: `tests/test_backend.py`

**Interfaces:**

- Consumes: `backend.providers` is not needed here; this task only adds configuration.
- Produces: `AIConfig.endpoint` (`Literal["/v1/chat/completions", "/v1/responses", "/v1/messages"] | None`, default `None`) and `AIConfig.messages_default_max_tokens` (`int`, `Field(default=4096, strict=True, gt=0)`); `load_config` raising `RuntimeError` with the exact unsupported-endpoint text; `_resolve_ai_config` carrying both fields.

- [ ] **Step 1: Write the failing tests for acceptance and the exact rejection message**

```python
import pytest

from backend import main


@pytest.mark.parametrize(
    "endpoint",
    ["/v1/chat/completions", "/v1/responses", "/v1/messages"],
)
def test_load_config_accepts_each_supported_endpoint(tmp_path, monkeypatch, endpoint):
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


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("null", "Unsupported ai.endpoint value: None."),
        ("/chat/completions", "Unsupported ai.endpoint value: '/chat/completions'."),
        ("https://api.openai.com/v1/messages", "Unsupported ai.endpoint value:"),
        ("123", "Unsupported ai.endpoint value: 123."),
    ],
)
def test_load_config_rejects_present_invalid_endpoint(tmp_path, monkeypatch, raw, expected):
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
    with pytest.raises(RuntimeError, match=expected):
        main.load_config()
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `python -m pytest tests/test_backend.py -v -k endpoint`
Expected: FAIL, `AIConfig` has no field `endpoint` / no error raised.

- [ ] **Step 3: Add the fields and the raw-YAML validation**

Add to `AIConfig`:

```python
    endpoint: Literal["/v1/chat/completions", "/v1/responses", "/v1/messages"] | None = None
    messages_default_max_tokens: int = Field(default=4096, strict=True, gt=0)
```

Add a module constant near the other config constants:

```python
SUPPORTED_ENDPOINTS = ("/v1/chat/completions", "/v1/responses", "/v1/messages")
```

In `load_config`, after `raw = _load_yaml_config()` and before `AppConfig.model_validate(raw)`, insert:

```python
    raw_ai = raw.get("ai")
    if isinstance(raw_ai, dict) and "endpoint" in raw_ai:
        raw_endpoint = raw_ai["endpoint"]
        if not isinstance(raw_endpoint, str) or raw_endpoint not in SUPPORTED_ENDPOINTS:
            ordered = ", ".join(sorted(SUPPORTED_ENDPOINTS))
            raise RuntimeError(
                f"Unsupported ai.endpoint value: {raw_endpoint!r}. "
                f"Use one of: {ordered}"
            )
```

Add to the `AIConfig(...)` construction inside `_resolve_ai_config`:

```python
        endpoint=base.endpoint,
        messages_default_max_tokens=base.messages_default_max_tokens,
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `python -m pytest tests/test_backend.py -v -k endpoint`
Expected: PASS.

- [ ] **Step 5: Add tests for inheritance, nested rejection, and the fallback validator**

```python
def test_resolve_ai_config_carries_endpoint_and_messages_default():
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


def test_provider_override_rejects_endpoint():
    with pytest.raises(Exception):
        main.ProviderOverride(endpoint="/v1/messages")


@pytest.mark.parametrize("value", [0, -1, True, "5", 1.0])
def test_messages_default_max_tokens_rejects_invalid(value):
    with pytest.raises(Exception):
        main.AIConfig(messages_default_max_tokens=value)


def test_messages_default_max_tokens_defaults_and_accepts_positive():
    assert main.AIConfig().messages_default_max_tokens == 4096
    assert main.AIConfig(messages_default_max_tokens=1).messages_default_max_tokens == 1
```

- [ ] **Step 6: Run the full backend test file and commit**

Run: `python -m pytest tests/test_backend.py -v`
Expected: PASS.

```bash
git add backend/main.py tests/test_backend.py
git commit -m "feat(config): add ai.endpoint and messages_default_max_tokens"
```

## Task 5: Facade wiring, OCR parts, and blank-completion rejection

**Implementer tier:** Advanced

**Files:**

- Modify: `backend/main.py:695-762` (`_ChatCompletion` alias, extraction helpers, `_request_chat_completion`), `backend/main.py:764-782` (`_post_openai_chat_completion`, `_call_openai`)
- Test: `tests/test_backend.py`

**Interfaces:**

- Consumes: `providers.TextPart`, `providers.ImagePart`, `providers.ChatCompletion`, `providers.ProviderProtocolError`, `providers.select_adapter`, `providers.resolve_endpoint` from Tasks 1-3; `AIConfig.endpoint` from Task 4.
- Produces: `main._ChatCompletion is providers.ChatCompletion`; `main._extract_openai_text` and `main._extract_finish_reason` retained as wrappers over provider helpers; `_request_chat_completion` unchanged in signature and delegating to the adapter; `_call_openai` building provider-neutral parts; `_post_openai_chat_completion` rejecting blank results with the existing detail.

- [ ] **Step 1: Write the failing test for the class identity and the wrappers**

```python
def test_chat_completion_is_the_provider_class():
    from backend import providers

    assert main._ChatCompletion is providers.ChatCompletion


def test_extract_finish_reason_wrapper_stays_tolerant():
    assert main._extract_finish_reason({"choices": [{"message": {}, "finish_reason": "length"}]}) == "length"
    assert main._extract_finish_reason({"choices": [{"message": {}}]}) is None
    assert main._extract_finish_reason({}) is None
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `python -m pytest tests/test_backend.py -v -k "provider_class or finish_reason_wrapper"`
Expected: FAIL, `main._ChatCompletion is not providers.ChatCompletion`.

- [ ] **Step 3: Relocate the dataclass and keep the wrappers**

Delete the local `_ChatCompletion` dataclass and the bodies of `_extract_openai_text` and `_extract_finish_reason`, then add near the existing `if __package__:` import block:

```python
if __package__:
    from .providers import (
        ChatCompletion as _ChatCompletion,
        ImagePart,
        ProviderProtocolError,
        TextPart,
        resolve_endpoint,
        select_adapter,
    )
else:
    from providers import (  # type: ignore[no-redef]
        ChatCompletion as _ChatCompletion,
        ImagePart,
        ProviderProtocolError,
        TextPart,
        resolve_endpoint,
        select_adapter,
    )
```

Keep the two compatibility wrappers:

```python
def _extract_finish_reason(payload: dict[str, Any]) -> str | None:
    """Backward-compatible wrapper over the provider finish-reason helper."""
    from . import providers as _providers

    return _providers._chat_finish_reason(payload)


def _extract_openai_text(payload: dict[str, Any]) -> str:
    """Backward-compatible wrapper over the provider Chat text helper."""
    from . import providers as _providers

    return _providers._extract_chat_text(payload)
```

Use the `import providers as _providers` form in the `else` branch, matching the existing dual-import convention.

- [ ] **Step 4: Rewrite `_request_chat_completion` as the protocol facade**

Preserve the signature exactly. Normalize the internal message list, then delegate:

```python
async def _request_chat_completion(
    config: AIConfig,
    messages: list[dict[str, Any]],
    *,
    idempotency_key: str | None = None,
) -> _ChatCompletion:
    api_key = _resolve_ai_api_key(config)
    system_prompt: str | None = None
    content: Any = messages[-1]["content"]
    if len(messages) > 1 and messages[0].get("role") == "system":
        system_prompt = messages[0].get("content")
    resolved = config.model_copy(update={"api_key": api_key})
    adapter = select_adapter(resolved)
    request = adapter.build_request(
        config=resolved, system_prompt=system_prompt, content=content
    )
    operation_id = _operation_id.get() if idempotency_key is None else idempotency_key
    if operation_id:
        request["headers"]["Idempotency-Key"] = operation_id
    timeout = httpx.Timeout(
        connect=config.timeout.connect,
        read=config.timeout.read,
        write=config.timeout.write,
        pool=config.timeout.pool,
    )

    async def _do_request() -> httpx.Response:
        client = await _get_http_client()
        response = await client.post(
            request["url"],
            headers=request["headers"],
            json=request["body"],
            timeout=timeout,
        )
        if response.is_error:
            detail = response.text[:500] + ("..." if len(response.text) > 500 else "")
            raise HTTPException(status_code=502, detail=f"OpenAI API failed: {detail}")
        return response

    payload = _decode_provider_json(
        await _call_with_retry(config, _do_request, "OpenAI"), "OpenAI"
    )
    try:
        return adapter.parse_response(payload, configured_model=config.model)
    except ProviderProtocolError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
```

- [ ] **Step 5: Build OCR parts and reject blank route results**

Change `_call_openai` to send provider-neutral parts:

```python
    return await _post_openai_chat_completion(
        config,
        [{
            "role": "user",
            "content": [TextPart(effective_prompt), ImagePart(data_url)],
        }],
    )
```

Change `_post_openai_chat_completion` to reject blank results:

```python
async def _post_openai_chat_completion(
    config: AIConfig, messages: list[dict[str, Any]]
) -> OCRResponse:
    result = await _request_chat_completion(config, messages)
    if not result.text.strip():
        raise HTTPException(
            status_code=502, detail="OpenAI API response contains no text content"
        )
    return OCRResponse(
        text=result.text, model=result.model, tokens_used=result.tokens_used
    )
```

- [ ] **Step 6: Run the full Python suite and confirm nothing regressed**

Run: `python -m pytest tests/ -q`
Expected: PASS. The 32 existing monkeypatch sites and the pipeline suites must pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add backend/main.py tests/test_backend.py
git commit -m "feat(backend): route provider calls through protocol adapters"
```

## Task 6: Cache identity and the two URL call sites

**Implementer tier:** Standard

**Files:**

- Modify: `backend/main.py:521-561` (`_resolve_text_settings`, `_cache_identity`)
- Test: `tests/test_backend.py`

**Interfaces:**

- Consumes: `resolve_endpoint` from Task 1; `AIConfig.endpoint` and `messages_default_max_tokens` from Task 4.
- Produces: `_ResolvedTextSettings.provider_endpoint` equal to `resolve_endpoint(effective_ai)`; `_cache_identity` adding `messages_default_max_tokens` only when `settings.config.endpoint == "/v1/messages"`.

- [ ] **Step 1: Write the failing tests**

```python
def _settings(endpoint=None, fallback=4096, api_base="https://example.invalid"):
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


def test_provider_endpoint_uses_the_resolver_per_protocol():
    for endpoint, suffix in [
        (None, "/v1/chat/completions"),
        ("/v1/responses", "/v1/responses"),
        ("/v1/messages", "/v1/messages"),
    ]:
        assert _settings(endpoint=endpoint).provider_endpoint.endswith(suffix)


def test_cache_identity_is_isolated_between_protocols():
    chat = main._cache_identity("format", "hello", None, _settings())
    responses = main._cache_identity("format", "hello", None, _settings("/v1/responses"))
    messages = main._cache_identity("format", "hello", None, _settings("/v1/messages"))
    assert len({chat, responses, messages}) == 3


def test_messages_default_max_tokens_changes_messages_identity_only():
    first = main._cache_identity("format", "hello", None, _settings("/v1/messages", 4096))
    second = main._cache_identity("format", "hello", None, _settings("/v1/messages", 2048))
    assert first != second
    legacy_a = main._cache_identity("format", "hello", None, _settings(fallback=4096))
    legacy_b = main._cache_identity("format", "hello", None, _settings(fallback=2048))
    assert legacy_a == legacy_b
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `python -m pytest tests/test_backend.py -v -k "cache_identity or provider_endpoint"`
Expected: FAIL, `AttributeError: module 'backend.main' has no attribute 'resolve_endpoint'` until Step 3 exports it.

- [ ] **Step 3: Replace both URL sites and add the conditional cache key**

In `_resolve_text_settings`, replace the f-string with:

```python
        provider_endpoint=resolve_endpoint(effective_ai),
```

In `_cache_identity`, after the `if operation == "translate":` block, add:

```python
    if settings.config.endpoint == "/v1/messages":
        canonical["messages_default_max_tokens"] = (
            settings.config.messages_default_max_tokens
        )
```

Confirm no other hardcoded `/v1/chat/completions` remains in `backend/`:

```bash
grep -rn '/v1/chat/completions' backend/main.py backend/providers.py
```

Expected: the only hits are inside `providers.resolve_endpoint` and the `SUPPORTED_ENDPOINTS` tuple.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `python -m pytest tests/test_backend.py tests/test_prompt_snapshot.py -v`
Expected: PASS, including the pinned digest `c80b950b5bce10ffac6026037fe4649111381531b1f932892844fc43cab0e1ff`.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_backend.py
git commit -m "feat(cache): resolve provider endpoint and key Messages fallback"
```

## Task 7: Legacy byte-identity goldens

**Implementer tier:** Advanced

**Files:**

- Test: `tests/test_backend.py`

**Interfaces:**

- Consumes: the facade from Task 5 and `resolve_endpoint` from Task 1.
- Produces: `test_legacy_chat_wire_goldens_match_pre_change_bytes` and `test_legacy_chat_wire_golden_includes_idempotency_without_reordering_json_headers`.

- [ ] **Step 1: Write the golden test with the captured pre-change bytes**

```python
LEGACY_CASES = {
    "ocr": (
        [{"role": "user", "content": [
            main.TextPart("OCR prompt"),
            main.ImagePart("data:image/png;base64,AA=="),
        ]}],
        b'{"model":"test-model","messages":[{"role":"user","content":[{"type":"text","text":"OCR prompt"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]}]}',
    ),
    "dedup": (
        [{"role": "system", "content": "Dedup prompt"},
         {"role": "user", "content": "first page\nsecond page"}],
        b'{"model":"test-model","messages":[{"role":"system","content":"Dedup prompt"},{"role":"user","content":"first page\\nsecond page"}]}',
    ),
    "translate": (
        [{"role": "system", "content": "Translate to English"},
         {"role": "user", "content": "Hello\nworld"}],
        b'{"model":"test-model","messages":[{"role":"system","content":"Translate to English"},{"role":"user","content":"Hello\\nworld"}]}',
    ),
    "format": (
        [{"role": "system", "content": "Format prompt"},
         {"role": "user", "content": "Hello\nworld"}],
        b'{"model":"test-model","messages":[{"role":"system","content":"Format prompt"},{"role":"user","content":"Hello\\nworld"}]}',
    ),
}


@pytest.mark.parametrize("operation", sorted(LEGACY_CASES))
def test_legacy_chat_wire_goldens_match_pre_change_bytes(operation):
    messages, expected_body = LEGACY_CASES[operation]
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "model": "test-model",
            "usage": {"total_tokens": 1},
        })

    async def run():
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
            )
        finally:
            main._http_client = previous
            await client.aclose()

    asyncio.run(run())
    request = seen[0]
    assert str(request.url) == "https://example.invalid/v1/chat/completions"
    assert request.content == expected_body
    raw = request.headers.raw
    names = [name for name, _ in raw]
    assert names.index(b"Authorization") < names.index(b"Content-Length")
    assert names.index(b"Content-Length") < names.index(b"Content-Type")
    assert (b"Content-Type", b"application/json") in raw
    assert b"temperature" not in request.content
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `python -m pytest tests/test_backend.py -v -k legacy_chat_wire`
Expected: PASS, 4 cases.

- [ ] **Step 3: Add the idempotency ordering test**

```python
def test_legacy_chat_wire_golden_includes_idempotency_without_reordering_json_headers():
    messages, expected_body = LEGACY_CASES["ocr"]
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "model": "test-model",
            "usage": {"total_tokens": 1},
        })

    async def run():
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
                idempotency_key="ocr-op-1",
            )
        finally:
            main._http_client = previous
            await client.aclose()

    asyncio.run(run())
    request = seen[0]
    raw = request.headers.raw
    names = [name for name, _ in raw]
    assert (b"Idempotency-Key", b"ocr-op-1") in raw
    assert names.index(b"Authorization") < names.index(b"Idempotency-Key")
    assert names.index(b"Idempotency-Key") < names.index(b"Content-Length")
    assert names.index(b"Content-Length") < names.index(b"Content-Type")
    assert request.content == expected_body
```

- [ ] **Step 4: Run the full suite and commit**

Run: `python -m pytest tests/ -q`
Expected: PASS.

```bash
git add tests/test_backend.py
git commit -m "test(providers): pin legacy Chat wire bytes and header order"
```

## Task 8: Per-protocol request, response, OCR, and truncation tests

**Implementer tier:** Advanced

**Files:**

- Modify: `tests/test_backend.py`, `tests/test_providers.py`
- Test: `tests/test_backend.py`, `tests/test_providers.py`

**Interfaces:**

- Consumes: adapters from Tasks 1-3, facade from Task 5, config from Task 4.
- Produces: per-protocol URL, header, body, extraction, model, token, truncation, malformed-envelope, OCR-wire, and Idempotency-Key tests; the retargeted `test_provider_response_requires_choices`.

- [ ] **Step 1: Retarget the one existing Chat test**

Change `tests/test_backend.py::test_provider_response_requires_choices` to:

```python
def test_provider_response_requires_choices() -> None:
    from backend import providers

    with pytest.raises(providers.ProviderProtocolError) as exc_info:
        providers.ChatCompletionsAdapter().parse_response(
            {"model": "test"}, configured_model="test"
        )

    assert "missing choices" in str(exc_info.value)
```

- [ ] **Step 2: Add the per-protocol OCR wire-shape tests**

For each protocol, drive `/ocr` through `TestClient` with a valid PNG and a mocked transport, and assert the exact image part:

```python
def test_chat_ocr_uses_image_url_object(...)
def test_responses_ocr_uses_wrapped_input_parts(...)
def test_messages_ocr_uses_base64_source_object(...)
```

Each asserts the full `request.json()["messages"][0]["content"]` or `["input"]` structure from Task 3, and that no system prompt is sent for OCR.

- [ ] **Step 3: Add the malformed-envelope and Idempotency tests**

Parameterize the unusable Responses statuses (`failed`, `cancelled`, `incomplete` with a different reason, `in_progress`, `queued`, unknown, missing, `null`, non-string), the populated `error` and `incomplete_details` cases for both new protocols, and the Messages non-text/blank/usage cases. Assert HTTP 502, never 500.

Add `test_idempotency_key_is_sent_for_chat_responses_and_messages` asserting the header on all three protocols.

- [ ] **Step 4: Add the real-transport truncation tests**

```python
def test_nonempty_truncation_signal_forces_split_through_real_transport(...)
def test_responses_empty_truncation_reaches_format_repair_through_transport(...)
def test_blank_truncation_is_502_for_ocr_and_dedup(...)
```

The non-empty case must use response text that would pass the completeness check, plus the protocol's truncation signal, and assert child requests occur. The blank cases assert 502 on `/ocr` and `/dedup`.

- [ ] **Step 5: Add the shared transport tests from spec section 9.6**

Cover `ConnectError` retrying exactly twice, other `RequestError` not retrying, the exact `read + 60` deadline, `asyncio.TimeoutError` mapping to 504, a malformed envelope not retrying, and pooled client reuse.

- [ ] **Step 6: Run the full suite and commit**

Run: `python -m pytest tests/ -q`
Expected: PASS.

```bash
git add tests/test_backend.py tests/test_providers.py
git commit -m "test(providers): cover all protocols, truncation, and transport"
```

## Task 9: Configuration error paths and documentation

**Implementer tier:** Standard

**Files:**

- Modify: `backend/main.py` (startup behaviour is already correct; add tests only), `backend/config.example.yaml`, `README.md`
- Test: `tests/test_backend.py`

**Interfaces:**

- Consumes: everything from Tasks 1-8.
- Produces: startup and request-time config error-path tests plus the documented configuration surface.

- [ ] **Step 1: Write the two config error-path tests**

```python
def _write_config(path, *, endpoint_line):
    path.write_text(
        "ai:\n"
        '  api_base: "https://example.invalid"\n'
        '  api_key: "test-key"\n' + endpoint_line,
        encoding="utf-8",
    )


def test_lifespan_invalid_endpoint_refuses_startup_without_http_response(
    tmp_path, monkeypatch
):
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, endpoint_line='  endpoint: "/bad/path"\n')
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "_config_cache", None)
    with pytest.raises(RuntimeError, match="Unsupported ai.endpoint value"):
        with TestClient(main.app):
            pass


def test_request_time_reload_invalid_endpoint_returns_exact_500_envelope(
    tmp_path, monkeypatch
):
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, endpoint_line='  endpoint: "/v1/responses"\n')
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "_config_cache", None)
    client = TestClient(main.app)

    ok = client.post("/dedup", json={"text": "hello"})
    assert ok.status_code in {200, 502}

    _write_config(config_path, endpoint_line='  endpoint: "/v1/bogus"\n')
    monkeypatch.setattr(main, "_config_cache", None)
    response = client.post("/dedup", json={"text": "hello"})
    assert response.status_code == 500
    body = response.json()
    assert body["text"] == ""
    assert body["model"] == ""
    assert body["tokens_used"] == 0
    assert "Unsupported ai.endpoint value" in body["error"]


def test_invalid_endpoint_paths_make_zero_upstream_calls(tmp_path, monkeypatch):
    calls: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={})

    config_path = tmp_path / "config.yaml"
    _write_config(config_path, endpoint_line="  endpoint: null\n")
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "_config_cache", None)

    with pytest.raises(RuntimeError, match="Unsupported ai.endpoint value: None"):
        main.load_config()
    assert calls == []
```

- [ ] **Step 2: Update `backend/config.example.yaml`**

Add under `ai:` the documented endpoint block: the three accepted values, that omitting it keeps legacy behaviour, that it is base-only, that explicit mode preserves gateway prefixes, and `messages_default_max_tokens: 4096` with its strict-positive-integer rule and Messages-only use. State that legacy mode appends `/v1/chat/completions` verbatim to the validated base URL and does not normalize a standalone `/v1`.

- [ ] **Step 3: Update `README.md`**

Replace the `api_base` line that says it "Must expose `/v1/chat/completions`" with the protocol-selection description: legacy omission, the three explicit values, auth differences (`Authorization: Bearer` versus `x-api-key` plus `anthropic-version`), the Messages fallback setting, and that the extension and local route contracts are unchanged.

- [ ] **Step 4: Run the full verification gate and commit**

Run:

```bash
python -m pytest tests/ -v
node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js
```

Expected: all Python tests pass; Node reports 84 background, 28 popup, 10 content, 0 fail.

```bash
git add backend/config.example.yaml README.md tests/test_backend.py
git commit -m "docs: document upstream protocol selection and config errors"
```

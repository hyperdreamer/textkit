# TextKit Upstream Protocol Adapters Specification

Date: 2026-10-18
Status: Implementation specification derived from the approved design
Authority: `docs/superpowers/specs/2026-10-18-upstream-protocol-adapters-design.md`

The approved design is authoritative. This document turns it into an implementation contract. A requirement below must not be weakened because the reference implementation in `ai-grammar` uses different TextKit semantics.

## Requirement Map

| ID | Requirement | This specification | Primary verification |
| --- | --- | --- | --- |
| R1 | Scope, allowed files, and seam | Sections 1 and 5 | `git diff --name-only`, full suite |
| R2 | Provider module surface and dependency boundary | Section 2 | `tests/test_providers.py` |
| R3 | Exact requests and headers | Section 3 | provider request tests and legacy goldens |
| R4 | Exact response normalization | Section 4 | provider response tests |
| R5 | Config declarations and raw-YAML validation | Section 5 | config tests in `tests/test_backend.py` |
| R6 | Main facade and OCR integration | Section 5 | facade, OCR, dedup, and route tests |
| R7 | URL resolution and cache identity | Section 6 | cache and digest tests |
| R8 | Error, retry, and deadline behavior | Section 7 | shared transport tests |
| R9 | Idempotency on every protocol | Sections 3, 5, and 7 | per-protocol header tests |
| R10 | Documentation changes | Section 8 | documentation review and static assertions |
| R11 | Verification-gate test plan | Section 9 | named tests and commands |
| R12 | Completion conditions | Section 10 | numbered acceptance checklist |

## 1. Scope, Files, and Seam

### 1.1 Scope

Implement configurable upstream protocol selection for the TextKit FastAPI backend. The optional base-level setting `ai.endpoint` selects one of exactly three protocols:

| `ai.endpoint` | Protocol |
| --- | --- |
| absent or `/v1/chat/completions` | OpenAI Chat Completions |
| `/v1/responses` | OpenAI Responses |
| `/v1/messages` | Anthropic Messages |

An absent `ai.endpoint` is legacy mode. It must preserve the current URL, headers, JSON body bytes, response extraction, Chat token-usage behavior, retry behavior, local route shapes, and cache digest behavior. Explicit endpoint mode adds protocol selection without changing any local TextKit route contract.

There is no streaming, tool-call support, conversation state, provider autodetection, arbitrary endpoint path, provider SDK, extension request change, extension UI change, or provider-specific field outside the contracts in this document.

### 1.2 Files changed by the implementation

The implementation may change only these repository files:

- `backend/providers.py` - new deep module containing protocol request and response behavior.
- `backend/main.py` - configuration fields, config validation, provider facade integration, URL resolver calls, OCR content parts, and blank-completion handling.
- `backend/config.example.yaml` - configuration example and protocol comments.
- `README.md` - provider protocol and configuration documentation.
- `tests/test_providers.py` - new pure adapter and normalization tests.
- `tests/test_backend.py` - provider integration, config, transport, route, OCR, dedup, cache, and compatibility additions; one existing test is retargeted as specified in Section 9.

### 1.3 Files that must not change

The implementation must not modify:

- any file under `extension/`;
- `backend/config.yaml`;
- `backend/transformation_cache.py`;
- `backend/requirements.txt`;
- `backend/requirements.lock`;
- `backend/requirements-dev.txt`;
- `backend/requirements-dev.lock`;
- `tests/test_format_pipeline.py`;
- `tests/test_translate_pipeline.py`;
- `tests/test_prompt_snapshot.py`;
- `tests/test_transformation_endpoints.py`;
- the approved design document;
- any local database or generated artifact.

The existing tests in the four test files above must continue to run unchanged. In particular, all existing `monkeypatch.setattr(main, "_request_chat_completion", ...)` sites remain valid, and positional construction such as `main._ChatCompletion("x", "m", 1, "stop")` remains valid.

### 1.4 Module seam

`backend/providers.py` is a deep, network-free module. It owns protocol-specific request serialization, protocol authentication headers, token-limit field names, response envelope validation, output extraction, usage normalization, and provider stop-signal normalization.

`backend/main.py` owns configuration loading and inheritance, lazy API-key resolution, the shared pooled HTTP client, timeout construction, retry and deadline policy, HTTP error mapping, JSON decoding, operation idempotency, prompts, cache identity, route handlers, and the format/translate repair pipelines.

The dependency direction is:

```text
main.py -> providers.py
providers.py -/-> main.py at runtime
```

`providers.py` must perform no network I/O and must not construct FastAPI or HTTPX exceptions. Malformed request parts and response envelopes leave `providers.py` as `ProviderProtocolError`; `main.py` maps that exception to the existing HTTP 502 envelope.

## 2. `backend/providers.py` Contract

### 2.1 Import and dependency rules

The module must begin with postponed annotations and must import only standard-library facilities needed for dataclasses, mappings/sequences, typing, and regular-expression parsing. It must not import `httpx`, `fastapi`, or `backend.main` at runtime.

`AIConfig` is available to the type checker only:

```python
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .main import AIConfig
```

When the backend is run as `python main.py` from `backend/`, the type-checking import may use the same relative/absolute dual-import convention as `main.py`. It must remain inside `if TYPE_CHECKING:` in either case. Postponed annotations are required so no runtime import cycle is introduced.

### 2.2 Public data types

These are the complete provider-layer public types and functions used by `main.py`.

```python
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, TypedDict

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
        self,
        payload: object,
        *,
        configured_model: str,
    ) -> ChatCompletion: ...

def resolve_endpoint(config: AIConfig) -> str: ...

def select_adapter(config: AIConfig) -> ProtocolAdapter: ...
```

`ChatCompletion` must be the one frozen dataclass used by the provider layer. Its field order is exactly `text, model, tokens_used, finish_reason`; `finish_reason` alone has a default of `None`. `main._ChatCompletion` must be an alias to this class, not a second dataclass:

```python
main._ChatCompletion is providers.ChatCompletion
```

```python
class ChatCompletionsAdapter:
    """Concrete adapter for legacy and explicit Chat Completions."""

class ResponsesAdapter:
    """Concrete adapter for OpenAI Responses."""

class MessagesAdapter:
    """Concrete adapter for Anthropic Messages."""
```

Each concrete adapter has the exact `build_request` and `parse_response` methods from `ProtocolAdapter`, takes no constructor arguments, and exposes no network or HTTPX method.

### 2.3 Required private helpers

The following helper responsibilities and signatures make the provider module independently testable. The names are part of the implementation specification so request and response behavior is not re-derived in each adapter.

```python
_ABSENT: object

def _require_mapping(payload: object, label: str) -> Mapping[str, Any]: ...
def _reject_non_null_error(payload: Mapping[str, Any]) -> None: ...
def _require_model(payload: Mapping[str, Any], configured_model: str) -> str: ...
def _require_non_negative_int(value: object, field: str) -> int: ...

def _chat_usage_tokens(payload: Mapping[str, Any]) -> int: ...
def _responses_usage_tokens(payload: Mapping[str, Any]) -> int: ...
def _messages_usage_tokens(payload: Mapping[str, Any]) -> int: ...

def _render_chat_content(
    content: str | Sequence[TextPart | ImagePart],
) -> str | list[dict[str, Any]]: ...
def _render_responses_input(
    content: str | Sequence[TextPart | ImagePart],
) -> str | list[dict[str, Any]]: ...
def _render_messages_content(
    content: str | Sequence[TextPart | ImagePart],
) -> str | list[dict[str, Any]]: ...
def _parse_messages_data_url(data_url: str) -> tuple[str, str]: ...

def _extract_chat_text(payload: Mapping[str, Any]) -> str: ...
def _extract_responses_text(
    payload: Mapping[str, Any], *, allow_empty: bool,
) -> str: ...
def _extract_messages_text(
    payload: Mapping[str, Any], *, allow_empty: bool,
) -> str: ...

def _chat_finish_reason(payload: Mapping[str, Any]) -> str | None: ...
def _responses_finish_reason(payload: Mapping[str, Any]) -> str | None: ...
def _messages_finish_reason(payload: Mapping[str, Any]) -> str | None: ...
```

The helpers must raise `ProviderProtocolError` for malformed input or envelopes. They must not leak `KeyError`, `IndexError`, `TypeError`, or `AttributeError`.

`_require_mapping` accepts a JSON object representation and rejects all other top-level values. `_require_model` uses a sentinel: an absent `model` returns `configured_model`; a present non-string, including `null`, raises; a present string, including an empty string, is returned unchanged.

`_require_non_negative_int` uses exact type semantics:

```python
type(value) is int and value >= 0
```

It rejects `bool`, floats including `1.0`, numeric strings, arrays, objects, `null`, and negative integers.

`_reject_non_null_error` is called before status, output, or content inspection for **Responses and Messages only**. A missing `error` or `error: null` is allowed. Any present non-null value is an error, including `{}`, `[]`, `""`, `false`, `0`, and `0.0`.

**Chat never calls `_reject_non_null_error`.** The current Chat parser ignores `error` entirely, and a valid `choices` array alongside a populated `error` field is accepted today. Rejecting it would turn a legacy success into a 502 and violate the byte-identity requirement. A regression fixture pins this: a Chat envelope with valid choices, usage, and model plus a populated `error` must still normalize successfully.

The three request renderers accept a string as a plain protocol string. For a sequence, each item must be exactly a `TextPart` or `ImagePart`; an unsupported runtime item raises `ProviderProtocolError`. An empty sequence is rendered as an empty array. `system_prompt is None` is handled by each adapter and omits the protocol system/instructions field; an empty string is present and is not treated as absent.

`_parse_messages_data_url` must accept exactly the shape `data:<non-empty media type>;base64,<non-empty payload>`, using a full match equivalent to `^data:([^;]+);base64,(.+)$` with dot matching newlines. It returns `(media_type, payload)` without decoding the payload. Every other value raises `ProviderProtocolError`.

### 2.4 Adapter selection and URL resolution

`resolve_endpoint` is the only provider URL resolver:

```python
if config.endpoint is None:
    return config.api_base + "/v1/chat/completions"
return config.api_base + config.endpoint
```

`AIConfig.api_base` has already been stripped of trailing slashes by `_validate_api_base_value`, so this is plain concatenation. Do not append `/v1`, call `urljoin`, or otherwise rewrite a gateway prefix.

`select_adapter` maps exactly as follows:

```text
None                       -> ChatCompletionsAdapter()
/v1/chat/completions      -> ChatCompletionsAdapter()
/v1/responses             -> ResponsesAdapter()
/v1/messages              -> MessagesAdapter()
```

The config validator prevents any other value from reaching this mapping. The selector must not autodetect based on URL, key, model, response, or provider.

### 2.5 `ChatCompletionsAdapter`

`ChatCompletionsAdapter.build_request` implements both legacy and explicit Chat mode. It uses `resolve_endpoint(config)` and returns only the `Authorization` header. `parse_response` implements the legacy-compatible Chat extraction and usage rules in Section 4.

### 2.6 `ResponsesAdapter`

`ResponsesAdapter.build_request` implements `/v1/responses`, including the two distinct `input` shapes in Section 3. `parse_response` implements the exact status, error precedence, truncation, output, and usage rules in Section 4.

### 2.7 `MessagesAdapter`

`MessagesAdapter.build_request` implements `/v1/messages`, including the mandatory fallback `max_tokens` and parsed image `source` object in Section 3. `parse_response` implements the exact stop-reason, content, error precedence, and usage rules in Section 4.

## 3. Exact Upstream Requests

All adapters return a JSON object in `ProviderRequest.body`. They do not serialize JSON bytes themselves. `main.py` passes the body through `httpx.AsyncClient.post(..., json=body)`, which derives `Content-Length` and `Content-Type`.

No adapter may set `Content-Type`. No adapter may add `temperature`, `stream`, `tools`, `response_format`, metadata, storage fields other than Responses `store: false`, or any other unlisted field.

### 3.1 Chat Completions request

The URL is `resolve_endpoint(config)`. The header mapping contains exactly one entry, inserted in this order:

```python
{"Authorization": f"Bearer {config.api_key}"}
```

The body insertion order is exactly `model`, `messages`, then optional `max_tokens`:

```json
{
  "model": "<config.model>",
  "messages": [
    {"role": "system", "content": "<system prompt>"},
    {"role": "user", "content": "<user text>"}
  ]
}
```

The system message is omitted when `system_prompt is None`. The user content is a string when the facade supplies a string. A parts sequence is an array of these exact objects, in input order:

```json
{"type": "text", "text": "<text>"}
{"type": "image_url", "image_url": {"url": "<complete data URL>"}}
```

For a positive `config.max_tokens`, append:

```json
"max_tokens": <config.max_tokens>
```

For `None` or any non-positive effective limit, omit the key. Existing TextKit Pydantic validation normally permits only `None` or positive values; the adapter still applies the positive-only rule.

Chat never sends a `temperature` field. This is required for legacy byte identity.

### 3.2 Responses request

The URL is `resolve_endpoint(config)`, and explicit configuration makes it `api_base + "/v1/responses"`.

The header mapping contains exactly:

```python
{"Authorization": f"Bearer {config.api_key}"}
```

The body insertion order is:

1. `model`;
2. `instructions`, only when `system_prompt is not None`;
3. `input`;
4. `store`, always `False`;
5. `max_output_tokens`, only for a positive `config.max_tokens`.

For text-only content:

```json
{
  "model": "<config.model>",
  "instructions": "<system prompt>",
  "input": "<user text>",
  "store": false
}
```

If `system_prompt is None`, omit `instructions` entirely. For parts content, `input` is not a bare array of parts. It is exactly one user message wrapping the parts:

```json
"input": [
  {
    "role": "user",
    "content": [
      {"type": "input_text", "text": "<text>"},
      {"type": "input_image", "image_url": "<complete data URL>"}
    ]
  }
]
```

The Responses part objects are exactly:

```json
{"type": "input_text", "text": "<text>"}
{"type": "input_image", "image_url": "<complete data URL>"}
```

For a positive `config.max_tokens`, append `"max_output_tokens": <config.max_tokens>`. Otherwise omit it. `store` is always present and exactly the JSON boolean `false`; this controls API storage only and does not promise anything about provider or gateway operational logs.

### 3.3 Messages request

The URL is `resolve_endpoint(config)`, and explicit configuration makes it `api_base + "/v1/messages"`.

The header mapping contains exactly these entries in this order:

```python
{
    "x-api-key": config.api_key,
    "anthropic-version": "2023-06-01",
}
```

There is no `Authorization` header and no explicit `Content-Type` header.

The body insertion order is:

1. `model`;
2. `system`, only when `system_prompt is not None`;
3. `messages`;
4. mandatory `max_tokens`.

A text-only request is:

```json
{
  "model": "<config.model>",
  "system": "<system prompt>",
  "messages": [
    {"role": "user", "content": "<user text>"}
  ],
  "max_tokens": 4096
}
```

Omit `system` when `system_prompt is None`. A parts sequence is an array in the user content:

```json
"messages": [
  {
    "role": "user",
    "content": [
      {"type": "text", "text": "<text>"},
      {
        "type": "image",
        "source": {
          "type": "base64",
          "media_type": "<media type>",
          "data": "<base64 payload>"
        }
      }
    ]
  }
]
```

The Messages image block never has a `url` field. For input `D = data:<media_type>;base64,<payload>`, `source` is exactly:

```json
{
  "type": "base64",
  "media_type": "<media_type>",
  "data": "<payload>"
}
```

`max_tokens` is always present. Use positive `config.max_tokens` when set; otherwise use `config.messages_default_max_tokens`.

### 3.4 Idempotency header insertion

`main._request_chat_completion` adds `Idempotency-Key` after the adapter returns its protocol headers. It adds the header only when the effective operation ID is non-empty. The effective operation ID is the explicit `idempotency_key` argument when it is not `None`; otherwise it is the `_operation_id` context value. An explicit empty string disables the context value, preserving current behavior.

Therefore the provider-derived header order is:

```text
Chat/Responses: Authorization, [Idempotency-Key]
Messages:       x-api-key, anthropic-version, [Idempotency-Key]
```

HTTPX then adds the JSON-derived `Content-Length` and `Content-Type`. This is true for all three protocols. The adapter itself must never add either derived header.

## 4. Exact Response Normalization

### 4.1 Common rules

Every `parse_response` first requires a top-level JSON object. Responses and
Messages then check a present non-null `error` before inspecting protocol status,
output, or content; a non-null `error` there always raises
`ProviderProtocolError`, even if other fields contain valid text or a recognized
truncation status. Chat does not check `error` at all (see §2.3), because doing so
would change established legacy behavior.

A present `model` must be a string. Only an absent `model` falls back to `configured_model`. `null` is present and malformed.

Responses and Messages use `_require_non_negative_int` for every present token count. Chat preserves the current `isinstance(value, int)` behavior exactly, including its acceptance of `bool` and its omission of sibling validation.

All response-validation failures become local HTTP 502 through the facade. They must never reach the application catch-all as HTTP 500.

### 4.2 Chat extraction and finish reason

Chat requires:

- a top-level object;
- `choices` to be a non-empty list;
- `choices[0]` to be an object;
- `choices[0].message` to be an object.

The exact legacy missing-choice detail remains observable and must include `"missing choices"`; the retargeted existing test continues to assert that phrase.

`message.content` preserves the current `_extract_openai_text` behavior:

- a string is stripped and returned only when non-empty after stripping;
- `null`, an empty string, and whitespace-only strings are rejected;
- a list is scanned in order; only objects with `type == "text"` and a non-empty string `text` are selected;
- each selected part is stripped and selected parts are joined with one `\n`;
- a list with no selected non-empty text is rejected;
- other list entries and non-text entries are ignored as they are today.

Thus these base-commit observations are required:

| `message.content` | Result |
| --- | --- |
| `"  hello  "` | normalized text `"hello"` |
| `""` | 502 |
| `"   "` | 502 |
| `null` | 502 |
| `[{"type":"text","text":" a "},{"type":"text","text":" b "}]` | `"a\nb"` |

The Chat adapter selects `choices[0]` only. It does not concatenate choices. `finish_reason` is the first choice's string value when it is a string; absent or non-string values normalize to `None`, preserving `_extract_finish_reason` behavior. A string `"length"` maps to `finish_reason="length"`; any other string passes through unchanged.

### 4.3 Chat token-usage compatibility

Chat usage must preserve today's total-token-only behavior. The table is normative:

| Payload usage | Result |
| --- | --- |
| usage absent | `tokens_used = 0` |
| `usage: null` | `tokens_used = 0` |
| `usage: {}` | `tokens_used = 0` |
| `usage` is any non-dict value | `tokens_used = 0` |
| `usage: {"total_tokens": 3}` | `3` |
| `usage: {"total_tokens": true}` | `1`; accepted because `isinstance(true, int)` is true |
| `usage: {"total_tokens": 0}` | `0` |
| `usage: {"total_tokens": -1}` | 502 |
| `usage: {"total_tokens": 1.0}` | 502 |
| `usage: {"total_tokens": "3"}` | 502 |
| `usage: {"total_tokens": null}` | 502 |
| `usage: {"prompt_tokens": "bad"}` | `0`; sibling fields are ignored |
| `usage: {"total_tokens": 3, "prompt_tokens": "bad"}` | `3`; sibling fields are ignored |

When `usage` is a dict, only `total_tokens` is read. Do not tighten this to exact-int validation and do not synthesize a prompt/completion sum.

### 4.4 Responses extraction, status, and truncation

Responses checks the non-null `error` field before status. Then:

- `status == "completed"` is the only normal completion status;
- `status == "incomplete"` is accepted only when `incomplete_details` is an object whose `reason` is exactly `"max_output_tokens"`; it normalizes to `finish_reason="length"`;
- `failed`, `cancelled`, `in_progress`, `queued`, unknown, missing, `null`, non-string, and every other status are upstream errors;
- for `completed`, `incomplete_details` must be absent or `null`;
- for every status, a present non-null `error` is an upstream error before any output access;
- for `completed`, `error` must be absent or `null`.

Responses output extraction scans `output` in provider order. `output` must be a list. Every output item must be an object. Non-`message` items are ignored and do not require a `content` field. A message item must have a list `content`; every content item must be an object. Only `type == "output_text"` contributes, and its `text` must be a string. Selected text is concatenated without a separator. Non-message items and non-`output_text` parts are ignored.

For normal `completed` output, at least one selected text part is required, and the concatenated result is stripped. A missing/malformed output list, malformed message/content list, non-string selected text, or no selected text is a provider error.

For recognized `incomplete` truncation, `output` must still be a list and its entries must satisfy the same structural validation. An empty list, or a list with no selected `output_text`, is the valid no-visible-text truncation representation and normalizes to `text=""`, `finish_reason="length"`. This is the only empty-output exception. A missing or non-list `output` remains malformed even for truncation.

The `output` shape for a no-visible-text truncation is therefore:

```json
{
  "status": "incomplete",
  "error": null,
  "incomplete_details": {"reason": "max_output_tokens"},
  "output": []
}
```

A normal non-empty Responses text result is stripped. Whitespace-only normal output is a provider error. A recognized truncation may return an empty string or stripped partial text.

Responses usage is strict and normalizes as follows:

- absent or `usage: null` -> `0`;
- present non-null usage must be an object;
- `input_tokens` and `output_tokens` absent or `null` contribute zero;
- any present non-null component must be an exact non-negative integer;
- when `total_tokens` is absent or `null`, return the validated component sum;
- when `total_tokens` is present and non-null, validate it and return it, while still independently validating every present non-null component.

A recognized truncation has `finish_reason="length"`; a completed result has `finish_reason=None`.

### 4.5 Messages extraction, stop reason, and truncation

Messages checks a present non-null `error` before inspecting content. `content` must be a list. Every content block must be an object. Only blocks with `type == "text"` contribute; their `text` values must be strings and are concatenated without separators. Non-text blocks are ignored.

`stop_reason` is interpreted exactly as follows:

| `stop_reason` | Normalized `finish_reason` |
| --- | --- |
| absent | `None` |
| `"end_turn"` | `"end_turn"` |
| `"stop_sequence"` | `"stop_sequence"` |
| `"max_tokens"` | `"length"` |
| any other string | provider error |
| present `null` or any other non-string | provider error |

For a normal stop, at least one text block is required and the concatenated text is stripped; whitespace-only output is a provider error. For `stop_reason == "max_tokens"`, an empty content list or no text blocks is allowed and normalizes to `text=""`, `finish_reason="length"`. This permits the format/translate repair pipelines to see the truncation signal.

Messages usage is strict:

- absent usage -> `0`;
- present `usage: null` -> provider error;
- present non-null usage must be an object;
- `input_tokens` and `output_tokens` absent or `null` contribute zero;
- every present non-null count must be an exact non-negative integer;
- normalized usage is the sum of the two validated counts;
- unknown usage fields are ignored.

### 4.6 Truncation and route mapping

The normalized result uses the following table:

| Protocol | Truncation | Normal stop | Upstream error |
| --- | --- | --- | --- |
| Chat | `choices[0].finish_reason == "length"` | any other string or absent | malformed Chat envelope, invalid Chat text/usage/model. A present non-null `error` is **ignored**, as today |
| Responses | `status == "incomplete"` and `incomplete_details.reason == "max_output_tokens"`, with `error` absent/null | `status == "completed"` and `incomplete_details` absent/null | every other status/details combination, non-null `error`, malformed output/usage/model |
| Messages | `stop_reason == "max_tokens"` | `end_turn`, `stop_sequence`, or absent | `pause_turn`, `tool_use`, `refusal`, any other string, non-string stop reason, non-null `error`, malformed content/usage/model |

`main._post_openai_chat_completion` is the OCR/dedup route wrapper. It must reject a blank normalized result with HTTP 502 for both normal and truncation finish reasons. The detail remains the current blank-content detail, `"OpenAI API response contains no text content"`, to preserve the existing Chat path.

The chunked format/translate pipelines call `_request_chat_completion` directly. They must receive `text=""` and `finish_reason="length"` from a valid empty truncation so their existing split-and-retry logic runs. The resulting route behavior is:

| Route | Blank text with `finish_reason="length"` | Blank text with normal/absent finish reason |
| --- | --- | --- |
| `/ocr` | 502 from `_post_openai_chat_completion` | 502 |
| `/dedup` | 502 from `_post_openai_chat_completion` | 502 |
| `/format` | accepted by the facade and repaired/falls back through the existing pipeline | 502 from provider normalization or existing verification |
| `/translate` | accepted by the facade and repaired/falls back through the existing pipeline | 502 from provider normalization or existing verification |

No user-visible route returns a successful empty completion for non-empty input.

## 5. `backend/main.py` Integration

### 5.1 Imports and class alias

Add the provider imports using the existing relative/absolute import pattern:

```python
from .providers import (
    ChatCompletion as _ChatCompletion,
    ImagePart,
    ProviderProtocolError,
    TextPart,
    resolve_endpoint,
    select_adapter,
)
```

Use the absolute `from providers import ...` equivalent when `__package__` is false. Remove the local `_ChatCompletion` dataclass. `main._ChatCompletion` must remain available to existing tests and must be the provider `ChatCompletion` class object.

The old `_extract_openai_text` and `_extract_finish_reason` implementations move into provider helpers and are no longer the main response-normalization seam. **Both names must remain importable from `main`**: `_extract_finish_reason` is called directly by three assertions at `tests/test_format_pipeline.py:414`, `:417`, and `:418`, so removing the symbol would produce `AttributeError` failures in an otherwise unchanged test file. `main._extract_finish_reason` is therefore kept as a thin wrapper (or module-level alias) around the provider helper and must preserve its tolerant behavior, including `{}` → `None` and a non-string reason → `None`. `main._extract_openai_text` is kept as a wrapper for the same reason; its only direct test is the one retargeted in §9.8.

The existing test named `test_provider_response_requires_choices` is retargeted to `ChatCompletionsAdapter.parse_response` and `ProviderProtocolError` as described in Section 9; no other existing test is changed.

### 5.2 Exact `AIConfig` declarations

Add these fields to `AIConfig` exactly:

```python
endpoint: Literal["/v1/chat/completions", "/v1/responses", "/v1/messages"] | None = None
messages_default_max_tokens: int = Field(default=4096, strict=True, gt=0)
```

`endpoint` is a base `ai` field. Do not add it to `ProviderOverride`. `messages_default_max_tokens` is also base-only and is inherited unchanged by `ai.ocr` and `ai.text` resolution.

The exact declaration is required because `strict=True` rejects booleans and numeric strings, while `gt=0` rejects zero and negative values. Do not replace it with a non-strict field or a plain default.

### 5.3 Raw-YAML endpoint validation in `load_config`

Pydantic's `Literal[...] | None = None` cannot distinguish an omitted endpoint from a present YAML `null`. `load_config` must inspect the raw YAML mapping before `AppConfig.model_validate`:

- if the raw `ai` value is a mapping and does not contain `endpoint`, continue in legacy mode;
- if the raw `ai` mapping contains `endpoint`, require a string equal byte-for-byte to one of the three supported paths;
- reject `null`, non-string values, aliases, full URLs, and arbitrary paths before an `AppConfig` is accepted;
- if `ai` itself is `null`, retain the existing `ai=None` behavior and do not invent an endpoint;
- leave `_resolve_ai_config` calls with `endpoint=None` valid, because those are constructed effective snapshots rather than raw YAML.

Use this exact error text, including `repr()` formatting and sorted endpoint order:

```text
Unsupported ai.endpoint value: <repr(raw_endpoint)>. Use one of: /v1/chat/completions, /v1/messages, /v1/responses
```

For example, a YAML `endpoint: null` must raise:

```text
Unsupported ai.endpoint value: None. Use one of: /v1/chat/completions, /v1/messages, /v1/responses
```

The raw check runs before the existing `Invalid config.yaml: ...` Pydantic wrapper for this field. It must not update `_config_cache` and must not create an HTTP client. Other existing config validation and warning behavior remains unchanged.

`messages_default_max_tokens` uses the exact Pydantic declaration above. Its absent value is 4096; present `null`, zero, negative, boolean, numeric string, float, and other non-exact-positive-integer values raise the existing `RuntimeError("Invalid config.yaml: ...")` path.

### 5.4 `_resolve_ai_config` inheritance

`_resolve_ai_config` currently rebuilds `AIConfig` field by field. Its returned `AIConfig(...)` must carry both new base-only fields:

```python
endpoint=base.endpoint,
messages_default_max_tokens=base.messages_default_max_tokens,
```

The existing override selection for `api_base`, keys, model, max tokens, and timeout is unchanged. In particular, `ai.text` cannot silently revert a configured Responses or Messages endpoint to legacy Chat mode, and `ai.ocr.endpoint`/`ai.text.endpoint` remain forbidden by `FrozenModel(extra="forbid")`.

### 5.5 `_resolve_text_settings` and cache identity

`_resolve_text_settings` must set:

```python
provider_endpoint=resolve_endpoint(effective_ai)
```

It must not contain a hardcoded `/v1/chat/completions` suffix.

`_cache_identity` keeps `CACHE_FORMAT_VERSION = 1` and the existing canonical keys. Add only this conditional key:

```python
if settings.config.endpoint == "/v1/messages":
    canonical["messages_default_max_tokens"] = (
        settings.config.messages_default_max_tokens
    )
```

The condition is on the effective config, not the base config and not the URL string. Legacy Chat and Responses identities must remain byte-identical to their pre-change dictionaries. A Messages identity must change when the fallback token value changes.

The existing UTF-8 digest vector remains required:

```text
serialized = {"cache_format_version":1,"input_text":"Hello\nworld","max_tokens":null,"model":"test-model","operation":"format","pipeline_revision":1,"prompt":"Format {verbatim}","provider_endpoint":"https://example.invalid/v1/chat/completions"}
sha256 = c80b950b5bce10ffac6026037fe4649111381531b1f932892844fc43cab0e1ff
```

The displayed serialized form means the exact JSON string asserted by `tests/test_prompt_snapshot.py::test_cache_identity_matches_the_fixed_utf8_digest_vector`; the conditional Messages key must not appear in that legacy vector.

### 5.6 `_request_chat_completion` facade

Keep this exact signature and return annotation:

```python
async def _request_chat_completion(
    config: AIConfig,
    messages: list[dict[str, Any]],
    *,
    idempotency_key: str | None = None,
) -> _ChatCompletion:
```

The facade must preserve the existing caller seam and perform these steps in order:

1. Resolve the API key with `_resolve_ai_api_key(config)`, preserving lazy secret lookup and existing HTTP 500 details.
2. Normalize the existing OpenAI-shaped internal messages into `system_prompt` and `content`:
   - text operations have a system message followed by a user message, so pass the system content string and the user content string unchanged;
   - OCR has one user message whose content is a `list[TextPart | ImagePart]`, so pass `system_prompt=None` and that parts sequence unchanged;
   - the user content passed to a monkeypatched facade remains exactly `messages[-1]["content"]`, so existing fakes continue to receive a string for text operations.
3. Make a resolved-config copy whose `api_key` is the resolved secret, without changing the original immutable config. All other fields, including endpoint and fallback token settings, remain unchanged.
4. Select the adapter with `select_adapter(resolved_config)` and call its `build_request` with the normalized prompt/content.
5. Add `Idempotency-Key` to the returned request headers using the precedence in Section 3.4.
6. Build the existing `httpx.Timeout` from `config.timeout.connect`, `.read`, `.write`, and `.pool`.
7. Use `_get_http_client()` and the existing `_call_with_retry` deadline/retry policy to POST `request["url"]` with `headers=request["headers"]`, `json=request["body"]`, and the constructed timeout.
8. Preserve the existing `response.is_error` branch: truncate the upstream body to 500 characters and append `...` only when it was longer, then map it to HTTP 502.
9. After `_call_with_retry` returns, call `_decode_provider_json` and then `adapter.parse_response(payload, configured_model=config.model)`. Parsing is after the retry wrapper, as in today's TextKit code; malformed JSON and malformed envelopes do not become a second transport attempt.
10. Catch `ProviderProtocolError` at this facade boundary and raise `HTTPException(status_code=502, detail=str(exc))`.
11. Return the adapter's frozen `ChatCompletion` unchanged.

Do not build a Chat-specific body in `main.py`. The facade is the only transport entry point for all three protocols and remains the function monkeypatched by the existing format, translate, and transformation tests.

### 5.7 OCR and blank-completion integration

Change `_call_openai`/`transcribe_image` so the OCR user content is built with provider-neutral parts:

```python
[
    {"role": "user", "content": [
        TextPart(effective_prompt),
        ImagePart(data_url),
    ]}
]
```

Do not pass the old raw Chat-specific `{"type": ...}` image objects from the OCR call site. The adapter owns their wire rendering. The local OCR request and response shape do not change.

`deduplicate_text` continues to pass a system string and a user string. The format and translate pipelines continue to pass the same system/user string messages, the same chunking, the same `_CompletionStats`, and the same per-chunk idempotency keys.

`_post_openai_chat_completion` must reject `result.text.strip() == ""` before constructing `OCRResponse`, regardless of `finish_reason`. This prevents `/ocr` and `/dedup` from returning an empty HTTP 200, while leaving empty length completions available to `_format_verified` and `_translate_verified` through the lower-level facade.

## 6. URL Resolution and Cache Isolation

### 6.1 Both URL call sites

Replace both hardcoded TextKit URL sites with `resolve_endpoint`:

- `_resolve_text_settings`/cache settings, currently the `provider_endpoint` assignment near `main.py:534`;
- the POST URL in `_request_chat_completion`, currently the `f"{config.api_base}/v1/chat/completions"` expression near `main.py:737`.

A source search after implementation must find no other hardcoded provider POST URL in `main.py` or `providers.py`.

The expected URLs are:

| Mode | `api_base` | Endpoint | URL |
| --- | --- | --- | --- |
| legacy | `https://gateway` | absent | `https://gateway/v1/chat/completions` |
| legacy | `https://gateway/v1` | absent | `https://gateway/v1/v1/chat/completions` |
| explicit | raw `https://gateway/proxy/`, stored as `https://gateway/proxy` | `/v1/responses` | `https://gateway/proxy/v1/responses` |
| explicit | `https://gateway/proxy/v1` | `/v1/messages` | `https://gateway/proxy/v1/v1/messages` |

The existing validator strips trailing slash characters before either resolution path. There is no `/v1` auto-append in `load_config`.

### 6.2 Cache isolation and reuse

`CACHE_FORMAT_VERSION` remains 1. The resolved URL is part of the identity, so Chat, Responses, and Messages cannot collide. A legacy Chat cache entry remains reusable after the code change because its provider endpoint and canonical JSON remain unchanged. Changing `messages_default_max_tokens` changes only a Messages identity.

The test suite must prove all three cases: existing Chat digest reuse, Chat/Responses/Messages isolation, and Messages fallback changes moving the key.

## 7. Error Mapping, Retry, Deadline, and Client Reuse

### 7.1 Shared client

Keep `_get_http_client()` unchanged as the pooled singleton seam:

- reuse `_http_client` while it exists and is not closed;
- create one `httpx.AsyncClient` with the existing `httpx.Limits(max_connections=20, max_keepalive_connections=10)` when needed;
- guard creation with `_http_client_lock`;
- close and clear it in `lifespan` as today.

Do not create a client in an adapter or per provider call.

### 7.2 Retry and deadline

Keep `_call_with_retry` semantics exactly:

- `deadline = config.timeout.read + 60` seconds;
- at most two attempts total;
- `asyncio.TimeoutError` maps immediately to HTTP 504 with the existing `"<provider> API did not respond within <deadline>s"` detail;
- `httpx.ConnectError` is the only retryable exception;
- after the first `ConnectError`, sleep one second and retry once;
- final `ConnectError` maps to HTTP 502 with the existing connection-failed detail;
- any other `httpx.RequestError` maps immediately to HTTP 502 and is not retried;
- an HTTPException raised for an upstream HTTP error is not retried;
- adapter parsing occurs after `_call_with_retry`, so `ProviderProtocolError` is not retried;
- the timeout object still uses the four configured phase values unchanged.

This differs intentionally from the read-only `ai-grammar` transport, which retries more exception types. TextKit's existing `httpx.ConnectError`-only policy is authoritative.

### 7.3 HTTP and protocol error mapping

Inside the request closure, preserve `response.is_error` handling. Map it to HTTP 502 with the provider label and at most the first 500 characters of `response.text`, plus `...` only when truncated. Do not decode a provider error body as a successful protocol envelope.

`_decode_provider_json` remains in `main.py` and keeps its current invalid-JSON and unexpected-shape 502 behavior. After it returns a dict, `ProviderProtocolError` from any adapter is mapped to HTTP 502, never 500. The local error envelope remains:

```json
{"text":"","model":"","tokens_used":0,"error":"<detail>"}
```

Legacy Chat retains the existing `OpenAI` provider label and exact existing details. Responses uses the OpenAI label. Messages uses the `Anthropic` label for transport/decode details; this does not alter local response keys or status codes.

Configuration errors remain `RuntimeError` from `load_config` and are handled by the existing 500 paths. They are not converted into `ProviderProtocolError`.

## 8. Documentation Changes

### 8.1 `backend/config.example.yaml`

Replace the current Chat-only AI comment and fields with this explicit configuration shape, preserving the existing unrelated server, limits, timeout, override, and cache examples:

```yaml
# AI API settings. Explicit mode is shown below.
ai:
  # Exact explicit choices are:
  #   /v1/chat/completions, /v1/responses, /v1/messages
  # Omitting endpoint retains legacy Chat behavior and the existing /v1 URL
  # normalization. In explicit mode the endpoint is appended to api_base after
  # trailing slashes are removed, preserving custom gateway path prefixes.
  endpoint: "/v1/chat/completions"

  # Explicit mode defaults api_base to https://api.openai.com when omitted.
  # Legacy mode uses TextKit's existing https://api.openai.com base and appends
  # /v1/chat/completions through the legacy resolver.
  api_base: "https://api.openai.com"
  api_key: "$OCR_API_KEY"
  model: "gpt-4.1-mini"

  # Used only by /v1/messages when max_tokens is not a positive effective
  # caller/base limit. Must be a strict positive integer.
  messages_default_max_tokens: 4096
```

The comments must also state that:

- `/v1/chat/completions`, `/v1/responses`, and `/v1/messages` are the only accepted endpoint values;
- a base-level endpoint is inherited by OCR and text operations and cannot be overridden in `ai.ocr` or `ai.text`;
- Legacy mode appends `/v1/chat/completions` verbatim to the validated base URL; there is no standalone `/v1` normalization or auto-append, so a base that already ends in `/v1` produces a doubled segment exactly as it does today;
- Messages authenticates with `x-api-key` and `anthropic-version: 2023-06-01`;
- Chat and Responses authenticate with `Authorization: Bearer`;
- the Messages fallback defaults to 4096 and is used only without a positive effective `max_tokens`.

Keep the existing per-task override documentation for model, API base, key, and `max_tokens`; do not document an endpoint override under either nested override.

### 8.2 `README.md`

Make these documentation changes only:

1. Replace the statement that the backend always calls `/v1/chat/completions` with a statement that TextKit selects one of OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages through `ai.endpoint`.
2. State that omitting `ai.endpoint` keeps the legacy Chat URL and request bytes unchanged.
3. Add this configuration example:

   ```yaml
   ai:
     endpoint: "/v1/chat/completions"
     api_base: "https://api.openai.com"
     api_key: "$OCR_API_KEY"
     model: "gpt-4.1-mini"
     messages_default_max_tokens: 4096
   ```

4. Show `/v1/responses` and `/v1/messages` as the only alternatives.
5. Explain that both modes use the `AIConfig.api_base` default `https://api.openai.com`, that legacy mode appends `/v1/chat/completions`, that explicit mode appends the complete endpoint path after trimming trailing slashes, and that custom gateway prefixes are preserved.
6. Explain Bearer authentication for the two OpenAI protocols and `x-api-key` plus `anthropic-version` for Messages.
7. Explain that `messages_default_max_tokens` applies only to Messages when no positive effective token limit is configured.
8. State that the extension and local route request bodies, local route names, response keys, status behavior, prompt endpoints, and cache headers remain unchanged.
9. Leave extension setup, route descriptions, response JSON keys, and UI documentation unchanged except where the provider description needs the protocol-selection clarification.

## 9. Verification and Test Plan

All tests use deterministic local mocks. No test may contact a real provider.

### 9.1 New pure provider tests

Create `tests/test_providers.py` with at least these named tests or parametrized equivalents:

- `test_resolve_endpoint_legacy_and_explicit_paths`
- `test_select_adapter_maps_legacy_and_explicit_chat`
- `test_chat_request_field_order_and_no_temperature_or_content_type`
- `test_chat_request_renders_text_and_image_parts`
- `test_responses_request_uses_string_or_wrapped_parts_input`
- `test_responses_request_uses_store_false_and_max_output_tokens`
- `test_messages_request_uses_source_object_and_fallback_tokens`
- `test_messages_request_rejects_malformed_data_url`
- `test_chat_response_extracts_first_choice_and_preserves_text_rules`
- `test_chat_usage_compatibility_table`
- `test_responses_response_extracts_selected_output_text_parts`
- `test_responses_usage_total_precedence_and_component_validation`
- `test_responses_status_and_error_precedence_table`
- `test_responses_empty_length_output_normalizes_to_empty_text`
- `test_messages_response_extracts_text_blocks_and_usage`
- `test_messages_stop_reason_table`
- `test_all_adapters_fallback_to_configured_model_only_when_model_absent`
- `test_non_null_error_is_rejected_before_output_access`

The output-access test must use a mapping or sentinel that records access and prove a populated falsey or truthy `error` is rejected before Responses output or Messages content extraction.

### 9.2 Pre-change legacy byte goldens

Add a `tests/test_backend.py` golden test that drives the current facade with `httpx.MockTransport` and the following fixed fixture values:

```text
api_base: https://example.invalid
api_key: test-key
model: test-model
```

The four operation inputs are:

```text
OCR prompt:       OCR prompt
image data URL:   data:image/png;base64,AA==
dedup system:     Dedup prompt
dedup/user text:  first page\nsecond page
translate system: Translate to English
translate/user:  Hello\nworld
format system:   Format prompt
format/user:     Hello\nworld
```

The handler must return a valid legacy Chat response and the test must capture the outgoing URL, complete `request.headers.raw`, and exact `request.content` bytes before parsing the response. The pre-change capture was taken from `main @ 6d3c267f1f05fdf167de07f6ddea5f74194a4e84` with the repository-pinned `httpx==0.28.1`. The body bytes are:

| Operation | URL | Content-Length | Exact body bytes |
| --- | --- | ---: | --- |
| OCR | `https://example.invalid/v1/chat/completions` | 169 | `b'{"model":"test-model","messages":[{"role":"user","content":[{"type":"text","text":"OCR prompt"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]}]}'` |
| dedup | `https://example.invalid/v1/chat/completions` | 130 | `b'{"model":"test-model","messages":[{"role":"system","content":"Dedup prompt"},{"role":"user","content":"first page\\nsecond page"}]}'` |
| translate | `https://example.invalid/v1/chat/completions` | 127 | `b'{"model":"test-model","messages":[{"role":"system","content":"Translate to English"},{"role":"user","content":"Hello\\nworld"}]}'` |
| format | `https://example.invalid/v1/chat/completions` | 120 | `b'{"model":"test-model","messages":[{"role":"system","content":"Format prompt"},{"role":"user","content":"Hello\\nworld"}]}'` |

For each body length, the complete captured `request.headers.raw` without an operation id is:

```python
[
    (b"Host", b"example.invalid"),
    (b"Accept", b"*/*"),
    (b"Accept-Encoding", EXPECTED_ACCEPT_ENCODING),  # environment-derived; see below
    (b"Connection", b"keep-alive"),
    (b"User-Agent", b"python-httpx/0.28.1"),
    (b"Authorization", b"Bearer test-key"),
    (b"Content-Length", b"<body length>"),
    (b"Content-Type", b"application/json"),
]
```

**`Accept-Encoding` must not be pinned to a literal.** httpx derives it from the
optional decoders it finds installed (`httpx._decoders.SUPPORTED_DECODERS`), so it
is `gzip, deflate` where brotli and zstandard are absent and
`gzip, deflate, br, zstd` where they are present. Pinning either literal makes the
golden fail on another machine. Derive it from an independent, otherwise
unmodified default `httpx.AsyncClient` in the test:

```python
EXPECTED_ACCEPT_ENCODING = next(
    value for name, value in httpx.AsyncClient().headers.items()
    if name.lower() == "accept-encoding"
).encode("ascii")
```

Alternatively, drop that one pair from the complete-list comparison and assert the
remaining pairs exactly. Nothing else about the header set is environment
dependent.

Substitute 169, 130, 127, and 120 from the body table. With the OCR operation id `ocr-op-1`, the complete captured sequence is:

```python
[
    (b"Host", b"example.invalid"),
    (b"Accept", b"*/*"),
    (b"Accept-Encoding", EXPECTED_ACCEPT_ENCODING),
    (b"Connection", b"keep-alive"),
    (b"User-Agent", b"python-httpx/0.28.1"),
    (b"Authorization", b"Bearer test-key"),
    (b"Idempotency-Key", b"ocr-op-1"),
    (b"Content-Length", b"169"),
    (b"Content-Type", b"application/json"),
]
```

The golden test must assert the complete raw list above and separately assert the provider-specific subsequence (`Authorization`, optional `Idempotency-Key`, `Content-Length`, `Content-Type`) so an adapter cannot explicitly set `Content-Type` or reorder the idempotency header. Run each operation with and without an operation id and assert that only the idempotency header changes.

Name the tests:

- `test_legacy_chat_wire_goldens_match_pre_change_bytes`
- `test_legacy_chat_wire_golden_includes_idempotency_without_reordering_json_headers`

### 9.3 Per-protocol request and OCR tests

In `tests/test_backend.py` and `tests/test_providers.py`, cover all three explicit endpoint values and legacy mode. Assert:

- exact URL, including custom gateway prefixes;
- exact protocol authentication headers and absence of the wrong authentication header;
- adapter header mappings contain no `Content-Type`; after HTTPX transport construction, its derived `Content-Length` and `Content-Type` must be present;
- body key insertion order and exact field names;
- Chat `max_tokens` omission for unset/zero and inclusion for positive;
- Responses `max_output_tokens` omission for unset/zero and inclusion for positive;
- Responses `store: false` in every request;
- Messages mandatory fallback `max_tokens`, positive override behavior, and no `Authorization`;
- text parts and image parts in the exact wire shapes;
- full Responses OCR `input` wrapper, not just its image object;
- Messages image `source` with the prefix removed.

Use these names:

- `test_chat_ocr_uses_image_url_object`
- `test_responses_ocr_uses_wrapped_input_parts`
- `test_messages_ocr_uses_base64_source_object`
- `test_idempotency_key_is_sent_for_chat_responses_and_messages`
- `test_provider_headers_never_include_adapter_content_type`

### 9.4 Per-protocol response and local route tests

Use deterministic Chat, Responses, and Messages envelopes and assert normalized text, model, usage, and finish reason. Cover `/ocr`, `/dedup`, `/format`, and `/translate` local response keys and status behavior.

Required fixtures include:

- Chat first-choice extraction, second-choice decoy, `.strip()` behavior, list-of-text content, the complete Chat usage table, model fallback, and malformed choices;
- Responses `completed` output with reasoning and non-`output_text` decoys, concatenated selected text, total-token precedence, component fallback, all invalid status values, all non-null error values, malformed output/content, and model fallback;
- Messages thinking/tool decoys, concatenated text blocks, usage sum, allowed stop reasons, rejected stop reasons, malformed content/usage, and model fallback.

Required test names include:

- `test_chat_response_uses_first_choice_and_legacy_usage_rules`
- `test_responses_response_concatenates_output_text_across_messages`
- `test_messages_response_concatenates_text_blocks`
- `test_malformed_provider_envelopes_return_502_not_500`
- `test_ocr_and_dedup_keep_response_shapes_for_all_protocols`

### 9.5 Real-transport truncation tests

Add route-level tests that use the real `_request_chat_completion` facade, real adapter selection, and `httpx.MockTransport`. Do not monkeypatch `_request_chat_completion` for these tests.

- A Responses `incomplete` envelope with `incomplete_details.reason == "max_output_tokens"` and `output: []` must reach `/format` and `/translate` as an empty `length` completion and trigger the existing split-and-retry/source-floor logic.
- A Messages `stop_reason: "max_tokens"` envelope must reach the existing route parser and repair pipeline.
- A Chat `finish_reason: "length"` envelope must retain existing pipeline behavior.
- `/ocr` and `/dedup` must return 502 for a blank length completion from every protocol.
- Normal blank output must be 502 and must not become a successful empty response.
- Existing fence stripping, JSON-substring recovery, required-field checks, and source fallback remain unchanged.

Use these names:

- `test_responses_empty_truncation_reaches_format_repair_through_transport`
- `test_responses_empty_truncation_reaches_translate_repair_through_transport`
- `test_messages_max_tokens_reaches_existing_route_parser`
- `test_blank_truncation_is_502_for_ocr_and_dedup`
- `test_normal_blank_completion_is_502_for_all_protocols`

### 9.6 Shared transport, retry, deadline, and stop-signal tests

The existing suite does not protect these seams: mutating the deadline from
`read + 60` to `read + 5`, or broadening the retry condition from
`ConnectError` to every `RequestError`, leaves all 278 baseline tests passing.
Add explicit coverage:

- `test_connect_error_retries_exactly_twice` — one `ConnectError` then success
  yields two calls and one result;
- `test_other_request_errors_are_not_retried` — `ReadTimeout` yields exactly one
  call and a 502;
- `test_deadline_is_read_timeout_plus_sixty` — assert the exact value passed to
  `asyncio.wait_for`, mocking the seam rather than sleeping;
- `test_deadline_expiry_maps_to_504` — an `asyncio.TimeoutError` maps to 504;
- `test_malformed_envelope_does_not_retry` — one call, then 502;
- `test_shared_pooled_client_is_reused` — two sequential calls use the same
  `_get_http_client()` instance.

**Stop-signal forwarding must be tested with a non-empty truncation.** Both repair
pipelines already split blank output even when `finish_reason` is absent, because
their completeness checks fail on empty text, so an empty-truncation test passes
even if the facade drops the stop signal entirely. Add at least one fixture whose
response text is **non-empty and would pass the normal completeness check** while
carrying the protocol's truncation signal, with input above the split floor, and
assert that child requests occur. Deleting the `"length"` mapping must then fail
the test. Name it
`test_nonempty_truncation_signal_forces_split_through_real_transport`.

### 9.7 Configuration and URL error-path tests

Add tests for:

- each supported endpoint accepted;
- omitted endpoint selecting legacy mode;
- present `null`, non-string, alias, full URL, missing-leading-slash value, arbitrary path, and nested `ai.ocr.endpoint`/`ai.text.endpoint` rejected;
- `messages_default_max_tokens` absent/default, positive exact int, zero, negative, bool, numeric string, float, and null;
- explicit empty/non-string `api_base` rejected by the existing config validation path;
- legacy and explicit URL tables in Section 6.

Use these names:

- `test_load_config_accepts_each_supported_endpoint`
- `test_load_config_rejects_present_null_endpoint_with_exact_message`
- `test_load_config_rejects_invalid_endpoint_before_provider_call`
- `test_provider_override_rejects_endpoint`
- `test_messages_default_max_tokens_is_strict_and_positive`
- `test_lifespan_invalid_endpoint_refuses_startup_without_http_response`
- `test_request_time_reload_invalid_endpoint_returns_exact_500_envelope`
- `test_invalid_endpoint_paths_make_zero_upstream_calls`

The startup test must use a context-managed `TestClient(main.app)` so lifespan runs and assert `RuntimeError` with the exact endpoint message; there is no HTTP response on this path. The request-time test must mutate `config.yaml` between requests so `(mtime_ns, size)` invalidates `_config_cache`, then assert the structured 500 body and zero provider calls.

### 9.8 Cache and snapshot tests

Keep `tests/test_prompt_snapshot.py` unchanged and require its existing tests, especially:

- `test_cache_identity_matches_the_fixed_utf8_digest_vector`
- `test_effective_provider_settings_change_the_identity`
- `test_credentials_and_timeouts_do_not_change_the_identity`

Add cache protocol isolation and Messages fallback coverage in `tests/test_backend.py` with names:

- `test_legacy_chat_cache_digest_reuses_pre_change_entry`
- `test_cache_identity_isolated_between_chat_responses_and_messages`
- `test_messages_default_max_tokens_changes_cache_identity`
- `test_text_override_inherits_endpoint_and_messages_fallback`

The existing `tests/test_transformation_endpoints.py` cache orchestration tests must remain unchanged and pass, including existing JSON shapes and `X-TextKit-Cache` behavior.

### 9.9 Retargeted existing test and unchanged monkeypatch suite

Change only `tests/test_backend.py::test_provider_response_requires_choices` so it calls `ChatCompletionsAdapter().parse_response({"model": "test"}, configured_model="test")`, expects `ProviderProtocolError`, and still asserts that the detail contains `"missing choices"`.

Do not change any monkeypatch site in:

- `tests/test_format_pipeline.py`;
- `tests/test_translate_pipeline.py`;
- `tests/test_transformation_endpoints.py`.

Those tests must continue constructing `main._ChatCompletion` positionally and replacing `main._request_chat_completion` with fakes that receive the same string user content and per-chunk idempotency key.

### 9.10 Verification-gate map

| Design gate | Verification file and test names |
| --- | --- |
| 1. Full Python suite, 278 clean-base tests before additions | `python -m pytest tests/ -v`; all existing tests, including the unchanged pipeline/cache suites |
| 2. Extension regression commands | `node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js` |
| 3. Legacy byte identity | `tests/test_backend.py::test_legacy_chat_wire_goldens_match_pre_change_bytes`, `test_legacy_chat_wire_golden_includes_idempotency_without_reordering_json_headers` |
| 4. Per-protocol request contracts | `tests/test_providers.py::test_chat_request_field_order_and_no_temperature_or_content_type`, `test_responses_request_uses_string_or_wrapped_parts_input`, `test_messages_request_uses_source_object_and_fallback_tokens` |
| 5. Per-protocol response contracts | `tests/test_providers.py::test_chat_response_uses_first_choice_and_legacy_usage_rules`, `test_responses_response_concatenates_output_text_across_messages`, `test_messages_response_concatenates_text_blocks`, `test_malformed_provider_envelopes_return_502_not_500` |
| 6. OCR wire shapes | `tests/test_backend.py::test_chat_ocr_uses_image_url_object`, `test_responses_ocr_uses_wrapped_input_parts`, `test_messages_ocr_uses_base64_source_object` |
| 7. Cache isolation and reuse | `tests/test_backend.py::test_legacy_chat_cache_digest_reuses_pre_change_entry`, `test_cache_identity_isolated_between_chat_responses_and_messages`; unchanged `tests/test_prompt_snapshot.py::test_cache_identity_matches_the_fixed_utf8_digest_vector` |
| 8. Config acceptance/rejection | `tests/test_backend.py::test_load_config_accepts_each_supported_endpoint`, `test_load_config_rejects_present_null_endpoint_with_exact_message`, `test_provider_override_rejects_endpoint`, `test_messages_default_max_tokens_is_strict_and_positive` |
| 9. Idempotency on all protocols | `tests/test_backend.py::test_idempotency_key_is_sent_for_chat_responses_and_messages` plus both legacy golden tests; Section 9.2 pins complete `request.headers.raw` with and without an operation id |
| 10. Truncation through real transport | `tests/test_backend.py::test_responses_empty_truncation_reaches_format_repair_through_transport`, `test_responses_empty_truncation_reaches_translate_repair_through_transport`, `test_messages_max_tokens_reaches_existing_route_parser` |
| 11. Route-level response contracts | `tests/test_backend.py::test_ocr_and_dedup_keep_response_shapes_for_all_protocols`, `test_blank_truncation_is_502_for_ocr_and_dedup`, `test_normal_blank_completion_is_502_for_all_protocols` |
| 12. Startup and request-time config failures | `tests/test_backend.py::test_lifespan_invalid_endpoint_refuses_startup_without_http_response`, `test_request_time_reload_invalid_endpoint_returns_exact_500_envelope`, `test_invalid_endpoint_paths_make_zero_upstream_calls` |
| 13. Messages cache fallback identity | `tests/test_backend.py::test_messages_default_max_tokens_changes_cache_identity`; unchanged legacy digest test in `tests/test_prompt_snapshot.py` |
| 14. Chat usage compatibility | `tests/test_providers.py::test_chat_usage_compatibility_table` |

The complete verification command set is:

```sh
python -m pytest tests/ -v
node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js
```

No provider request in these tests may leave the integration worktree or contact the network.

## 10. Acceptance Criteria

1. `backend/providers.py` exists, imports neither `httpx` nor `fastapi`, imports `AIConfig` only under `TYPE_CHECKING`, and exposes the exact public types, adapter methods, resolver, and selector in Section 2.
2. `ChatCompletion` is frozen, has field order `text, model, tokens_used, finish_reason=None`, and `main._ChatCompletion` is the same class object.
3. Omitted `ai.endpoint` selects Chat legacy mode and reproduces the captured URL, provider headers, JSON field order, and body bytes in Section 9.2, including no `temperature` and no adapter-supplied `Content-Type`.
4. The three supported endpoint values select exactly the documented adapter and no alias, full URL, arbitrary path, nested override, or present null is accepted.
5. Chat, Responses, and Messages request bodies match Section 3 exactly, including Responses string versus wrapped-parts `input`, `store: false`, Messages `source`, mandatory Messages `max_tokens`, and header order.
6. Every provider call sends `Idempotency-Key` when an operation id exists, including all chunk repair calls and all three protocols.
7. Response normalization matches Section 4, including Chat's permissive legacy usage rule, strict Responses/Messages counts, model fallback, Responses/Messages error-first validation (Chat ignores `error`), stop/truncation mapping, and protocol-specific text extraction.
8. A valid no-visible-text truncation reaches the format/translate repair pipelines as `text=""` plus `finish_reason="length"`, while `/ocr` and `/dedup` return 502 for every blank completion.
9. `ProviderProtocolError`, invalid JSON, malformed envelopes, and upstream HTTP errors map to local HTTP 502; the existing `asyncio.TimeoutError` deadline remains HTTP 504; only `httpx.ConnectError` retries.
10. `_get_http_client` remains the shared pooled client, and the deadline remains `config.timeout.read + 60`.
11. `_resolve_ai_config` preserves endpoint and Messages fallback through OCR/text overrides, and `ProviderOverride` rejects endpoint keys through `extra="forbid"`.
12. Both hardcoded URL sites use `resolve_endpoint`; legacy and Chat/Responses cache digests remain unchanged; Messages fallback changes its own identity.
13. `backend/config.example.yaml` and `README.md` describe legacy mode, all explicit paths, URL behavior, authentication, and the Messages fallback without changing extension or local route documentation.
14. The one existing choice-validation test is retargeted to `ProviderProtocolError`; all other existing tests and monkeypatch seams remain unchanged.
15. The full Python and Node verification commands pass without network access, and only the files allowed in Section 1 are modified by the implementation.

## 11. Explicit Spec Decisions

The approved design leaves a few mechanical details unstated. The following narrow choices make the implementation deterministic without changing the approved behavior:

1. The raw endpoint validation message uses the read-only reference implementation's deterministic format and sorted endpoint order: `Unsupported ai.endpoint value: <repr>. Use one of: /v1/chat/completions, /v1/messages, /v1/responses`. This supplies the design's requirement for byte-exact text while preserving the existing `RuntimeError` configuration path.
2. A recognized empty truncation must contain an explicit, **structurally valid list** container (`output` for Responses, `content` for Messages). The list may be empty *or* may contain items with no selected text (a reasoning-only `output`, a thinking-only `content`); both normalize to `text=""` with the truncation stop signal. A missing or non-list container remains malformed. This distinguishes a valid provider envelope with no visible text from an absent/malformed envelope.
3. Runtime request parts outside `TextPart` and `ImagePart` raise `ProviderProtocolError`; empty valid part sequences serialize as empty arrays. The design specifies the two part classes but does not authorize coercion of arbitrary objects.
4. The golden fixture prompts, text, model, key, and short image data URL in Section 9.2 are fixed test inputs chosen because the design requires captured bytes but does not name fixture values. Their compact JSON bytes, content lengths, and complete `request.headers.raw` lists were captured from the base implementation with the repository-pinned `httpx==0.28.1`.
5. Transport/decode details use `OpenAI` for Chat and Responses and `Anthropic` for Messages, while the local error envelope and status behavior remain identical. Legacy Chat detail text is unchanged; no local client contract depends on the new protocol label.
6. The facade supports exactly the two internal message layouts already produced by TextKit: optional first system message followed by a user message, or one user message containing provider-neutral parts. It does not add a general conversation-message normalization layer or authorize additional roles.
7. The private helper names and signatures in Section 2.3 are fixed as the implementation decomposition, while the concrete adapters share the public method contract. This keeps request rendering, protocol-specific usage, and envelope validation independently testable without adding another public abstraction.

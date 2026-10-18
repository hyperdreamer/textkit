"""Provider wire protocols: request serialization, auth, and response normalization.

This module owns everything protocol-specific: request bodies, auth headers,
token-limit field naming, response-envelope validation, and stop-signal
normalization.  It never performs I/O: an adapter builds a plain request mapping
and the caller (``backend.main``) hands the JSON body to ``httpx``.

A JSON-shaped ``messages`` list is *not* the contract here.  Adapters accept
protocol-neutral content parts (``TextPart`` / ``ImagePart``) so each protocol can
own its own image wire shape.
"""

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
    """One text segment of a protocol-neutral user content array."""

    text: str


@dataclass(frozen=True)
class ImagePart:
    """One image segment, carried as a complete ``data:`` URL."""

    data_url: str


class ProviderRequest(TypedDict):
    """One fully serialized provider request, ready for ``httpx``."""

    url: str
    headers: dict[str, str]
    body: dict[str, Any]


@dataclass(frozen=True)
class ChatCompletion:
    """One provider completion: text, model, usage, and stop reason."""

    text: str
    model: str
    tokens_used: int
    finish_reason: str | None = None


class ProviderProtocolError(Exception):
    """A malformed request part or provider response envelope."""


class ProtocolAdapter(Protocol):
    """One upstream wire protocol."""

    def build_request(
        self,
        *,
        config: AIConfig,
        system_prompt: str | None,
        content: str | Sequence[TextPart | ImagePart],
    ) -> ProviderRequest: ...

    def parse_response(self, payload: object, *, configured_model: str) -> ChatCompletion: ...


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


def _require_non_negative_int(value: object, field: str) -> int:
    if type(value) is not int or value < 0:
        raise ProviderProtocolError(
            f"provider response field {field} must be a non-negative integer, got {value!r}"
        )
    return value


def _reject_non_null_error(payload: Mapping[str, Any]) -> None:
    """Reject any present non-null ``error`` value, including empty containers."""

    error = payload.get("error", _ABSENT)
    if error is _ABSENT or error is None:
        return
    raise ProviderProtocolError(f"provider response reports an error: {error!r}")


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


def _responses_usage_tokens(payload: Mapping[str, Any]) -> int:
    usage = payload.get("usage", _ABSENT)
    if usage is _ABSENT or usage is None:
        return 0
    if not isinstance(usage, Mapping):
        raise ProviderProtocolError(
            f"provider response field usage must be an object, got {type(usage).__name__}"
        )
    components = 0
    for field in ("input_tokens", "output_tokens"):
        value = usage.get(field, _ABSENT)
        if value is _ABSENT or value is None:
            continue
        components += _require_non_negative_int(value, f"usage.{field}")
    total = usage.get("total_tokens", _ABSENT)
    if total is _ABSENT or total is None:
        return components
    return _require_non_negative_int(total, "usage.total_tokens")


def _messages_usage_tokens(payload: Mapping[str, Any]) -> int:
    usage = payload.get("usage", _ABSENT)
    if usage is _ABSENT:
        return 0
    if not isinstance(usage, Mapping):
        raise ProviderProtocolError(
            f"provider response field usage must be an object, got {type(usage).__name__}"
        )
    total = 0
    for field in ("input_tokens", "output_tokens"):
        value = usage.get(field, _ABSENT)
        if value is _ABSENT or value is None:
            continue
        total += _require_non_negative_int(value, f"usage.{field}")
    return total


def _extract_responses_text(payload: Mapping[str, Any], *, allow_empty: bool) -> str:
    output = payload.get("output", _ABSENT)
    if not isinstance(output, list):
        raise ProviderProtocolError(
            "OpenAI Responses response field output must be a list, "
            f"got {type(output).__name__}"
        )
    pieces: list[str] = []
    for item in output:
        if not isinstance(item, Mapping):
            raise ProviderProtocolError(
                "OpenAI Responses response output items must be objects, "
                f"got {type(item).__name__}"
            )
        if item.get("type") != "message":
            continue
        content = item.get("content", _ABSENT)
        if not isinstance(content, list):
            raise ProviderProtocolError(
                "OpenAI Responses message item field content must be a list, "
                f"got {type(content).__name__}"
            )
        for block in content:
            if not isinstance(block, Mapping):
                raise ProviderProtocolError(
                    "OpenAI Responses content items must be objects, "
                    f"got {type(block).__name__}"
                )
            if block.get("type") != "output_text":
                continue
            text = block.get("text", _ABSENT)
            if not isinstance(text, str):
                raise ProviderProtocolError(
                    f"OpenAI Responses output_text field text must be a string, got {text!r}"
                )
            pieces.append(text)
    if not pieces:
        if allow_empty:
            return ""
        raise ProviderProtocolError("OpenAI API response contains no text content")
    stripped = "".join(pieces).strip()
    if not stripped and not allow_empty:
        raise ProviderProtocolError("OpenAI API response contains no text content")
    return stripped


def _extract_messages_text(payload: Mapping[str, Any], *, allow_empty: bool) -> str:
    content = payload.get("content", _ABSENT)
    if not isinstance(content, list):
        raise ProviderProtocolError(
            "Anthropic Messages response field content must be a list, "
            f"got {type(content).__name__}"
        )
    pieces: list[str] = []
    for block in content:
        if not isinstance(block, Mapping):
            raise ProviderProtocolError(
                "Anthropic Messages response content blocks must be objects, "
                f"got {type(block).__name__}"
            )
        if block.get("type") != "text":
            continue
        text = block.get("text", _ABSENT)
        if not isinstance(text, str):
            raise ProviderProtocolError(
                f"Anthropic Messages text block field text must be a string, got {text!r}"
            )
        pieces.append(text)
    if not pieces:
        if allow_empty:
            return ""
        raise ProviderProtocolError("Anthropic Messages response contains no text content")
    stripped = "".join(pieces).strip()
    if not stripped and not allow_empty:
        raise ProviderProtocolError("Anthropic Messages response contains no text content")
    return stripped


def _responses_finish_reason(payload: Mapping[str, Any]) -> str | None:
    status = payload.get("status", _ABSENT)
    details = payload.get("incomplete_details", _ABSENT)
    if status == "completed":
        if details is not _ABSENT and details is not None:
            raise ProviderProtocolError(
                "OpenAI Responses response completed with incomplete_details"
            )
        return None
    if status == "incomplete":
        if isinstance(details, Mapping) and details.get("reason") == "max_output_tokens":
            return "length"
        raise ProviderProtocolError(
            "OpenAI Responses response is incomplete for an unsupported reason"
        )
    raise ProviderProtocolError(
        f"OpenAI Responses response has unsupported status {status!r}"
    )


def _messages_finish_reason(payload: Mapping[str, Any]) -> str | None:
    reason = payload.get("stop_reason", _ABSENT)
    if reason is _ABSENT:
        return None
    if not isinstance(reason, str):
        raise ProviderProtocolError(
            f"Anthropic Messages stop_reason must be a string, got {reason!r}"
        )
    if reason == "max_tokens":
        return "length"
    if reason in ("end_turn", "stop_sequence"):
        return reason
    raise ProviderProtocolError(
        f"Anthropic Messages response has unsupported stop_reason {reason!r}"
    )


def _render_chat_content(
    content: str | Sequence[TextPart | ImagePart],
) -> str | list[dict[str, Any]]:
    if isinstance(content, str):
        return content
    if not isinstance(content, Sequence):
        raise ProviderProtocolError(
            f"Unsupported content: {type(content).__name__}"
        )
    parts: list[dict[str, Any]] = []
    for part in content:
        if isinstance(part, TextPart):
            parts.append({"type": "text", "text": part.text})
        elif isinstance(part, ImagePart):
            parts.append({"type": "image_url", "image_url": {"url": part.data_url}})
        else:
            raise ProviderProtocolError(f"Unsupported content part: {type(part).__name__}")
    return parts


def _render_responses_input(
    content: str | Sequence[TextPart | ImagePart],
) -> str | list[dict[str, Any]]:
    if isinstance(content, str):
        return content
    if not isinstance(content, Sequence):
        raise ProviderProtocolError(
            f"Unsupported content: {type(content).__name__}"
        )
    parts: list[dict[str, Any]] = []
    for part in content:
        if isinstance(part, TextPart):
            parts.append({"type": "input_text", "text": part.text})
        elif isinstance(part, ImagePart):
            parts.append({"type": "input_image", "image_url": part.data_url})
        else:
            raise ProviderProtocolError(f"Unsupported content part: {type(part).__name__}")
    return [{"role": "user", "content": parts}]


def _parse_messages_data_url(data_url: str) -> tuple[str, str]:
    match = _DATA_URL_PATTERN.fullmatch(data_url)
    if match is None:
        raise ProviderProtocolError(
            "Unsupported image data URL: expected data:<media type>;base64,<payload>"
        )
    return match.group(1), match.group(2)


def _render_messages_content(
    content: str | Sequence[TextPart | ImagePart],
) -> str | list[dict[str, Any]]:
    if isinstance(content, str):
        return content
    if not isinstance(content, Sequence):
        raise ProviderProtocolError(
            f"Unsupported content: {type(content).__name__}"
        )
    parts: list[dict[str, Any]] = []
    for part in content:
        if isinstance(part, TextPart):
            parts.append({"type": "text", "text": part.text})
        elif isinstance(part, ImagePart):
            media_type, payload = _parse_messages_data_url(part.data_url)
            parts.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": payload,
                    },
                }
            )
        else:
            raise ProviderProtocolError(f"Unsupported content part: {type(part).__name__}")
    return parts


class ChatCompletionsAdapter:
    """Concrete adapter for legacy and explicit Chat Completions."""

    def build_request(
        self,
        *,
        config: AIConfig,
        system_prompt: str | None,
        content: str | Sequence[TextPart | ImagePart],
    ) -> ProviderRequest:
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

    def parse_response(self, payload: object, *, configured_model: str) -> ChatCompletion:
        mapping = _require_mapping(payload, "response")
        text = _extract_chat_text(mapping)
        tokens_used = _chat_usage_tokens(mapping)
        model = mapping.get("model", configured_model)
        if not isinstance(model, str):
            raise ProviderProtocolError("OpenAI API response has invalid model")
        return ChatCompletion(
            text=text,
            model=model,
            tokens_used=tokens_used,
            finish_reason=_chat_finish_reason(mapping),
        )


class ResponsesAdapter:
    """Concrete adapter for OpenAI Responses."""

    def build_request(
        self,
        *,
        config: AIConfig,
        system_prompt: str | None,
        content: str | Sequence[TextPart | ImagePart],
    ) -> ProviderRequest:
        body: dict[str, Any] = {"model": config.model}
        if system_prompt is not None:
            body["instructions"] = system_prompt
        body["input"] = _render_responses_input(content)
        body["store"] = False
        if config.max_tokens:
            body["max_output_tokens"] = config.max_tokens
        return {
            "url": resolve_endpoint(config),
            "headers": {"Authorization": f"Bearer {config.api_key}"},
            "body": body,
        }

    def parse_response(self, payload: object, *, configured_model: str) -> ChatCompletion:
        mapping = _require_mapping(payload, "response")
        _reject_non_null_error(mapping)
        finish_reason = _responses_finish_reason(mapping)
        return ChatCompletion(
            text=_extract_responses_text(mapping, allow_empty=finish_reason == "length"),
            model=_require_model(mapping, configured_model),
            tokens_used=_responses_usage_tokens(mapping),
            finish_reason=finish_reason,
        )


class MessagesAdapter:
    """Concrete adapter for Anthropic Messages."""

    def build_request(
        self,
        *,
        config: AIConfig,
        system_prompt: str | None,
        content: str | Sequence[TextPart | ImagePart],
    ) -> ProviderRequest:
        body: dict[str, Any] = {"model": config.model}
        if system_prompt is not None:
            body["system"] = system_prompt
        body["messages"] = [
            {"role": "user", "content": _render_messages_content(content)}
        ]
        body["max_tokens"] = config.max_tokens or config.messages_default_max_tokens
        return {
            "url": resolve_endpoint(config),
            "headers": {
                "x-api-key": config.api_key,
                "anthropic-version": "2023-06-01",
            },
            "body": body,
        }

    def parse_response(self, payload: object, *, configured_model: str) -> ChatCompletion:
        mapping = _require_mapping(payload, "response")
        _reject_non_null_error(mapping)
        finish_reason = _messages_finish_reason(mapping)
        return ChatCompletion(
            text=_extract_messages_text(mapping, allow_empty=finish_reason == "length"),
            model=_require_model(mapping, configured_model),
            tokens_used=_messages_usage_tokens(mapping),
            finish_reason=finish_reason,
        )

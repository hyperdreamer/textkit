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
        return ChatCompletion(
            text=_extract_chat_text(mapping),
            model=_require_model(mapping, configured_model),
            tokens_used=_chat_usage_tokens(mapping),
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
        raise NotImplementedError

    def parse_response(self, payload: object, *, configured_model: str) -> ChatCompletion:
        raise NotImplementedError


class MessagesAdapter:
    """Concrete adapter for Anthropic Messages."""

    def build_request(
        self,
        *,
        config: AIConfig,
        system_prompt: str | None,
        content: str | Sequence[TextPart | ImagePart],
    ) -> ProviderRequest:
        raise NotImplementedError

    def parse_response(self, payload: object, *, configured_model: str) -> ChatCompletion:
        raise NotImplementedError

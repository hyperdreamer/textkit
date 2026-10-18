"""Pure provider-layer tests: URL resolution, adapter selection, Chat request bytes.

Nothing here opens a socket, imports ``httpx``, or touches ``backend.main`` beyond
constructing an ``AIConfig`` value.
"""

from __future__ import annotations

import dataclasses

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


def test_chat_request_renders_text_and_image_parts():
    request = providers.ChatCompletionsAdapter().build_request(
        config=_config(),
        system_prompt=None,
        content=[
            providers.TextPart("OCR prompt"),
            providers.ImagePart("data:image/png;base64,AA=="),
        ],
    )
    assert request["body"] == {
        "model": "test-model",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "OCR prompt"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/png;base64,AA=="},
                    },
                ],
            }
        ],
    }


def test_chat_request_omits_system_message_when_prompt_is_none():
    request = providers.ChatCompletionsAdapter().build_request(
        config=_config(),
        system_prompt=None,
        content="user text",
    )
    assert request["body"]["messages"] == [{"role": "user", "content": "user text"}]


def test_chat_request_keeps_empty_system_prompt_and_empty_parts_array():
    request = providers.ChatCompletionsAdapter().build_request(
        config=_config(),
        system_prompt="",
        content=[],
    )
    assert request["body"]["messages"] == [
        {"role": "system", "content": ""},
        {"role": "user", "content": []},
    ]


def test_chat_request_rejects_unsupported_content_part():
    with pytest.raises(providers.ProviderProtocolError):
        providers.ChatCompletionsAdapter().build_request(
            config=_config(),
            system_prompt=None,
            content=[{"type": "text", "text": "raw dict"}],
        )


def test_chat_request_rejects_non_sequence_content():
    with pytest.raises(providers.ProviderProtocolError):
        providers.ChatCompletionsAdapter().build_request(
            config=_config(),
            system_prompt=None,
            content=42,  # type: ignore[arg-type]
        )


def test_chat_request_uses_resolved_endpoint():
    request = providers.ChatCompletionsAdapter().build_request(
        config=_config(endpoint="/v1/chat/completions"),
        system_prompt=None,
        content="user text",
    )
    assert request["url"] == "https://example.invalid/v1/chat/completions"


def test_chat_completion_field_order_and_default_finish_reason():
    completion = providers.ChatCompletion("text", "model", 3)
    assert [field.name for field in dataclasses.fields(completion)] == [
        "text",
        "model",
        "tokens_used",
        "finish_reason",
    ]
    assert (completion.text, completion.model, completion.tokens_used) == ("text", "model", 3)
    assert completion.finish_reason is None
    with pytest.raises(dataclasses.FrozenInstanceError):
        completion.text = "other"  # type: ignore[misc]


def test_messages_default_max_tokens_defaults_to_4096():
    assert _config().messages_default_max_tokens == 4096

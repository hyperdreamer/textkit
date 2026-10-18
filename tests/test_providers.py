"""Pure provider-layer tests: URL resolution, adapter selection, Chat request bytes.

Nothing here opens a socket, imports ``httpx``, or touches ``backend.main`` beyond
constructing an ``AIConfig`` value.
"""

from __future__ import annotations

import dataclasses

import pytest

from backend import providers

_OMITTED = object()


def _config(**overrides):
    values = {
        "api_base": "https://example.invalid",
        "api_key": "test-key",
        "model": "test-model",
    }
    values.update(overrides)
    for key, value in overrides.items():
        if value is _OMITTED:
            values.pop(key, None)
    from backend import main

    return main.AIConfig(**values)


def test_omitted_endpoint_defaults_to_none_without_being_explicitly_set():
    config = _config(endpoint=_OMITTED)
    assert config.endpoint is None
    assert "endpoint" not in config.model_fields_set


@pytest.mark.parametrize(
    ("endpoint", "expected"),
    [
        (_OMITTED, "https://example.invalid/v1/chat/completions"),
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
        (_OMITTED, providers.ChatCompletionsAdapter),
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


def test_responses_request_uses_store_false_and_max_output_tokens():
    with_limit = providers.ResponsesAdapter().build_request(
        config=_config(endpoint="/v1/responses", max_tokens=2048),
        system_prompt=None,
        content="body",
    )
    assert list(with_limit["body"]) == [
        "model",
        "input",
        "store",
        "max_output_tokens",
    ]
    assert with_limit["body"]["max_output_tokens"] == 2048
    assert with_limit["body"]["store"] is False

    without_limit = providers.ResponsesAdapter().build_request(
        config=_config(endpoint="/v1/responses"),
        system_prompt=None,
        content="body",
    )
    assert "max_output_tokens" not in without_limit["body"]
    assert list(without_limit["body"]) == ["model", "input", "store"]


def test_messages_request_uses_source_object_and_fallback_tokens():
    fallback = providers.MessagesAdapter().build_request(
        config=_config(endpoint="/v1/messages"),
        system_prompt="sys",
        content="body",
    )
    assert list(fallback["body"]) == ["model", "system", "messages", "max_tokens"]
    assert fallback["body"]["messages"] == [{"role": "user", "content": "body"}]
    assert fallback["body"]["max_tokens"] == 4096
    assert "Authorization" not in fallback["headers"]

    custom_fallback = providers.MessagesAdapter().build_request(
        config=_config(endpoint="/v1/messages", messages_default_max_tokens=512),
        system_prompt=None,
        content="body",
    )
    assert custom_fallback["body"]["max_tokens"] == 512
    assert "system" not in custom_fallback["body"]

    explicit = providers.MessagesAdapter().build_request(
        config=_config(endpoint="/v1/messages", max_tokens=100),
        system_prompt=None,
        content="body",
    )
    assert explicit["body"]["max_tokens"] == 100


@pytest.mark.parametrize(
    "data_url",
    [
        "data:image/png;base64,",
        "data:;base64,AA==",
        "data:image/png,AA==",
        "AA==",
        "data:image/png;charset=utf-8;base64,AA==",
    ],
)
def test_messages_request_rejects_malformed_data_url(data_url):
    with pytest.raises(providers.ProviderProtocolError):
        providers.MessagesAdapter().build_request(
            config=_config(endpoint="/v1/messages"),
            system_prompt=None,
            content=[providers.ImagePart(data_url)],
        )


def test_parse_messages_data_url_splits_media_type_and_payload():
    assert providers._parse_messages_data_url("data:image/jpeg;base64,/9j/AA==") == (
        "image/jpeg",
        "/9j/AA==",
    )


def test_renderers_reject_unsupported_parts_and_non_sequences():
    for renderer in (
        providers._render_chat_content,
        providers._render_responses_input,
        providers._render_messages_content,
    ):
        assert renderer("text") == "text"
        empty = [] if renderer is not providers._render_responses_input else [
            {"role": "user", "content": []}
        ]
        assert renderer([]) == empty
        with pytest.raises(providers.ProviderProtocolError):
            renderer([{"type": "text", "text": "raw dict"}])
        with pytest.raises(providers.ProviderProtocolError):
            renderer(42)


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (
            {
                "status": "completed",
                "output": [
                    {"type": "message", "content": [{"type": "output_text", "text": "ok"}]}
                ],
            },
            "ok",
        ),
        (
            {
                "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "output": [],
            },
            "",
        ),
    ],
)
def test_responses_status_and_error_precedence_table(payload, expected):
    result = providers.ResponsesAdapter().parse_response(payload, configured_model="cfg")
    assert result.text == expected


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"status": None},
        {"status": 7},
        {"status": "failed"},
        {"status": "cancelled"},
        {"status": "in_progress"},
        {"status": "queued"},
        {"status": "unknown"},
        {"status": "incomplete"},
        {"status": "incomplete", "incomplete_details": None},
        {"status": "incomplete", "incomplete_details": {"reason": "content_filter"}},
        {"status": "incomplete", "incomplete_details": []},
        {"status": "completed", "incomplete_details": {"reason": "max_output_tokens"}},
        {
            "status": "completed",
            "output": [
                {"type": "message", "content": [{"type": "output_text", "text": "x"}]}
            ],
            "error": {"code": "boom"},
        },
        {"status": "completed", "output": []},
        {
            "status": "completed",
            "output": [
                {"type": "message", "content": [{"type": "output_text", "text": "  "}]}
            ],
        },
        {"status": "completed", "output": [{"type": "message"}]},
        {
            "status": "completed",
            "output": [
                {"type": "message", "content": [{"type": "output_text", "text": 5}]}
            ],
        },
        {"status": "completed", "output": ["not-an-object"]},
        {"status": "completed", "output": {}},
        {"status": "completed"},
    ],
)
def test_responses_rejects_unsupported_status_and_envelopes(payload):
    with pytest.raises(providers.ProviderProtocolError):
        providers.ResponsesAdapter().parse_response(payload, configured_model="cfg")


def test_responses_usage_total_precedence_and_component_validation():
    def usage(value):
        return providers._responses_usage_tokens({"usage": value})

    assert usage({"input_tokens": 7, "output_tokens": 8}) == 15
    assert usage({"input_tokens": 7, "output_tokens": 8, "total_tokens": 99}) == 99
    assert usage({"input_tokens": 0}) == 0
    assert usage({}) == 0
    assert usage({"input_tokens": None, "output_tokens": 8}) == 8
    assert providers._responses_usage_tokens({}) == 0
    assert providers._responses_usage_tokens({"usage": None}) == 0

    for bad in (
        {"input_tokens": True},
        {"output_tokens": 1.0},
        {"input_tokens": "7"},
        {"total_tokens": True},
        {"total_tokens": 1.0},
        {"input_tokens": 7, "total_tokens": -1},
    ):
        with pytest.raises(providers.ProviderProtocolError):
            usage(bad)
    with pytest.raises(providers.ProviderProtocolError):
        usage([])


def test_messages_stop_reason_table():
    def finish(payload):
        return providers._messages_finish_reason(payload)

    assert finish({}) is None
    assert finish({"stop_reason": "end_turn"}) == "end_turn"
    assert finish({"stop_reason": "stop_sequence"}) == "stop_sequence"
    assert finish({"stop_reason": "max_tokens"}) == "length"
    for reason in ("pause_turn", "tool_use", "refusal", "unknown"):
        with pytest.raises(providers.ProviderProtocolError):
            finish({"stop_reason": reason})
    for reason in (None, 7, [], {}):
        with pytest.raises(providers.ProviderProtocolError):
            finish({"stop_reason": reason})


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"content": None},
        {"content": {}},
        {"content": ["not-an-object"]},
        {"content": [{"type": "text"}]},
        {"content": [{"type": "text", "text": 5}]},
        {"content": [{"type": "thinking", "thinking": "no"}]},
        {"content": [{"type": "text", "text": "   "}]},
        {"content": [], "stop_reason": "end_turn"},
    ],
)
def test_messages_rejects_blank_or_malformed_content(payload):
    with pytest.raises(providers.ProviderProtocolError):
        providers.MessagesAdapter().parse_response(payload, configured_model="cfg")


def test_messages_usage_sum_and_strict_validation():
    payload = {"content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"}
    adapter = providers.MessagesAdapter()
    assert adapter.parse_response(payload, configured_model="cfg").tokens_used == 0
    with_usage = dict(payload, usage={"input_tokens": 7, "output_tokens": 8, "cache_read": 5})
    assert adapter.parse_response(with_usage, configured_model="cfg").tokens_used == 15
    with_null_component = dict(payload, usage={"input_tokens": None, "output_tokens": 8})
    assert (
        adapter.parse_response(with_null_component, configured_model="cfg").tokens_used == 8
    )
    for bad_usage in (
        None,
        [],
        {"input_tokens": True},
        {"output_tokens": 1.0},
        {"input_tokens": "7"},
        {"input_tokens": -1},
    ):
        with pytest.raises(providers.ProviderProtocolError):
            adapter.parse_response(dict(payload, usage=bad_usage), configured_model="cfg")


def test_all_adapters_fallback_to_configured_model_only_when_model_absent():
    responses_payload = {
        "status": "completed",
        "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}],
    }
    messages_payload = {
        "content": [{"type": "text", "text": "ok"}],
        "stop_reason": "end_turn",
    }
    chat_payload = {"choices": [{"message": {"content": "ok"}}]}

    assert providers.ResponsesAdapter().parse_response(
        responses_payload, configured_model="cfg"
    ).model == "cfg"
    assert providers.MessagesAdapter().parse_response(
        messages_payload, configured_model="cfg"
    ).model == "cfg"
    assert providers.ChatCompletionsAdapter().parse_response(
        chat_payload, configured_model="cfg"
    ).model == "cfg"

    for adapter, payload in (
        (providers.ResponsesAdapter(), responses_payload),
        (providers.MessagesAdapter(), messages_payload),
        (providers.ChatCompletionsAdapter(), chat_payload),
    ):
        empty_model = adapter.parse_response(
            dict(payload, model=""), configured_model="cfg"
        )
        assert empty_model.model == ""
        with pytest.raises(providers.ProviderProtocolError):
            adapter.parse_response(dict(payload, model=None), configured_model="cfg")


class _AccessSpy(dict):
    """Mapping that records which keys were read."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.reads: list[str] = []

    def __getitem__(self, key):
        self.reads.append(key)
        return super().__getitem__(key)

    def get(self, key, default=None):
        self.reads.append(key)
        return super().get(key, default)


@pytest.mark.parametrize("error", [{}, [], "", False, 0, 0.0, "boom", {"code": "x"}])
def test_non_null_error_is_rejected_before_output_access(error):
    responses_payload = _AccessSpy(
        status="incomplete",
        incomplete_details={"reason": "max_output_tokens"},
        output=[],
        error=error,
    )
    with pytest.raises(providers.ProviderProtocolError):
        providers.ResponsesAdapter().parse_response(
            responses_payload, configured_model="cfg"
        )
    assert "output" not in responses_payload.reads
    assert "status" not in responses_payload.reads

    messages_payload = _AccessSpy(
        content=[{"type": "text", "text": "ok"}], stop_reason="max_tokens", error=error
    )
    with pytest.raises(providers.ProviderProtocolError):
        providers.MessagesAdapter().parse_response(
            messages_payload, configured_model="cfg"
        )
    assert "content" not in messages_payload.reads
    assert "stop_reason" not in messages_payload.reads


def test_null_or_absent_error_is_accepted():
    responses_payload = {
        "status": "completed",
        "error": None,
        "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}],
    }
    assert providers.ResponsesAdapter().parse_response(
        responses_payload, configured_model="cfg"
    ).text == "ok"
    assert providers.MessagesAdapter().parse_response(
        {"content": [{"type": "text", "text": "ok"}], "error": None},
        configured_model="cfg",
    ).text == "ok"


def test_messages_empty_max_tokens_truncation_is_valid():
    result = providers.MessagesAdapter().parse_response(
        {"content": [], "stop_reason": "max_tokens"}, configured_model="cfg"
    )
    assert result.text == ""
    assert result.finish_reason == "length"


def test_responses_rejects_incomplete_for_another_reason_despite_valid_output():
    payload = {
        "status": "incomplete",
        "incomplete_details": {"reason": "content_filter"},
        "output": [
            {"type": "message", "content": [{"type": "output_text", "text": "visible"}]}
        ],
    }
    with pytest.raises(providers.ProviderProtocolError):
        providers.ResponsesAdapter().parse_response(payload, configured_model="cfg")


def test_messages_blank_output_with_max_tokens_keeps_the_truncation_signal():
    result = providers.MessagesAdapter().parse_response(
        {"content": [{"type": "text", "text": "   "}], "stop_reason": "max_tokens"},
        configured_model="cfg",
    )
    assert (result.text, result.finish_reason) == ("", "length")

    with pytest.raises(providers.ProviderProtocolError):
        providers.MessagesAdapter().parse_response(
            {"content": [{"type": "text", "text": "   "}], "stop_reason": "end_turn"},
            configured_model="cfg",
        )


def test_provider_headers_never_include_adapter_content_type():
    responses = providers.ResponsesAdapter().build_request(
        config=_config(endpoint="/v1/responses"), system_prompt=None, content="body"
    )
    messages = providers.MessagesAdapter().build_request(
        config=_config(endpoint="/v1/messages"), system_prompt=None, content="body"
    )
    assert list(responses["headers"]) == ["Authorization"]
    assert list(messages["headers"]) == ["x-api-key", "anthropic-version"]
    for request in (responses, messages):
        assert "content-type" not in {name.lower() for name in request["headers"]}

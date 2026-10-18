# TextKit configurable upstream protocol — design

Date: 2026-10-18
Status: Accepted by user (sealing point, Idempotency-Key, error mapping); revised
after independent design review (round 1)
Base: main @ `6d3c267f1f05fdf167de07f6ddea5f74194a4e84`
Reference (read-only): `/data/home/guest/Development/ai/ai-grammar` @ `6f8c42d`

## Background and goal

TextKit's backend speaks exactly one upstream wire protocol: OpenAI Chat
Completions, hardcoded in two places (`backend/main.py:534` for cache identity and
`backend/main.py:737` for the POST). ai-grammar already shipped an adapter layer
that additionally supports OpenAI Responses and Anthropic Messages. This change
brings the same protocol choice to TextKit.

The goal is a new optional `ai.endpoint` key accepting exactly
`/v1/chat/completions`, `/v1/responses`, or `/v1/messages`. Absent keeps today's
behavior byte-for-byte. Present selects a protocol through adapters that own
request serialization, authentication headers, and response normalization. The
extension and every local route contract (`/ocr`, `/dedup`, `/translate`,
`/format`, `/prompts/*`) are unchanged.

## Binding decisions (recorded, not re-litigated)

1. Endpoint values are exactly the three strings above, validated at config load
   in the existing pydantic `FrozenModel` `extra="forbid"` style. A present
   `null`, non-string, unsupported string, or alias (`chat/completions`, a full
   URL) is a config error surfaced as the existing HTTP 500 path, never an
   upstream request. (Two distinct 500 paths — startup refusal and request-time
   reload failure — are described in "Configuration surface".)
2. Absent `ai.endpoint` selects legacy mode and reproduces today's request URL,
   headers, and body byte-for-byte — including that TextKit sends **no
   `temperature` field** (ai-grammar always sends one; TextKit never has).
3. `ai.endpoint` is a base-section setting only. `ai.ocr` and `ai.text` inherit it
   and may not override the protocol. Their existing model/api_base/key/max_tokens
   override semantics are unchanged.
4. Auth: `Authorization: Bearer` for both OpenAI protocols; `x-api-key` plus
   `anthropic-version: 2023-06-01` for Messages.
5. Token limits: Chat → `max_tokens`; Responses → `max_output_tokens`; Messages →
   `max_tokens` is mandatory, so use the positive effective limit when set and a
   new validated `ai.messages_default_max_tokens` (positive int, default 4096)
   otherwise. Existing `ai.max_tokens` / per-override behavior is unchanged.
6. Normalized result carries a stop signal equivalent to today's
   `_ChatCompletion.finish_reason`, with provider truncation mapped to `"length"`.
7. Cache identity uses the resolved endpoint for the effective protocol, with no
   `CACHE_FORMAT_VERSION` bump.
8. One shared URL resolver replaces both hardcoded `/v1/chat/completions` sites.

## What differs from ai-grammar, and why

The reference implementation is the semantic source, not the file layout. Three
differences are forced by TextKit's existing behavior and are the main design risk.

### No `temperature`

ai-grammar always sends `temperature`; TextKit never has, and requirement 2 makes
that byte-identical forever in legacy mode. The adapter contract therefore takes
**no `temperature` parameter at all**. It cannot be forgotten or reintroduced by
accident: there is no field to fill.

### No `/v1` auto-append

ai-grammar's legacy algorithm rewrites a base that does not end in `/v1` by
appending `/v1`, and its default base is `https://api.openai.com/v1`. TextKit's
`_validate_api_base_value` already strips trailing slashes and defaults the base
to `https://api.openai.com`, and its URL is the plain concatenation
`api_base + "/v1/chat/completions"`.

Adopting ai-grammar's resolver unchanged would therefore change existing URLs.
TextKit instead resolves both modes by plain concatenation:

| Mode | URL |
| --- | --- |
| legacy (`endpoint is None`) | `api_base + "/v1/chat/completions"` |
| explicit | `api_base + endpoint` |

Because `api_base` is already stripped and validated, legacy is byte-identical by
construction, and explicit mode needs no `/v1` special-casing at all: the
endpoint string is the complete path.

### The IR is content parts, not `system_prompt + user_text`

ai-grammar's contract cannot express TextKit's OCR request. Today `/ocr` sends a
single user message whose content is an array of a `text` part and an
`image_url` part, and no system message. Text operations send a `system` and a
`user` message whose contents are plain strings. A contract of
`system_prompt + user_text` cannot represent either faithfully.

The contract therefore takes `system_prompt: str | None` plus
`content: str | Sequence[ContentPart]`, where the parts are protocol-neutral:

```python
@dataclass(frozen=True)
class TextPart:
    text: str

@dataclass(frozen=True)
class ImagePart:
    data_url: str
```

A `str` content is rendered as the protocol's plain string content (today's exact
bytes for text operations). A parts sequence is rendered as an array, with each
adapter owning its own image wire format. There is no `image_data_url` part that
raises for two of three protocols: all three are implemented now.

| | Chat Completions | Responses | Messages |
| --- | --- | --- | --- |
| text part type | `text` | `input_text` | `text` |
| image part type | `image_url` | `input_image` | `image` |
| image URL field | `image_url.url` (object) | `image_url` (plain string) | `source` object |
| data-URL handling | kept whole in the URL field | kept whole in the URL field | parsed into `source` |

Exact image part objects, where `D` is the complete data URL and the input is
`data:<media_type>;base64,<payload>`:

```jsonc
// Chat Completions
{"type": "image_url", "image_url": {"url": D}}

// Responses
{"type": "input_image", "image_url": D}

// Messages — no url field; the prefix is parsed, not kept
{"type": "image",
 "source": {"type": "base64", "media_type": "<media_type>", "data": "<payload>"}}
```

For Messages, `source.data` is the base64 payload **without** the
`data:...;base64,` prefix and `source.media_type` is the portion between `data:`
and `;base64`. A data URL that does not match
`data:<non-empty media type>;base64,<non-empty payload>` raises
`ProviderProtocolError`, which the facade maps to the existing 502 path. Chat and
Responses require no parsing and therefore never raise for an image part.

## Architecture

A new deep module, `backend/providers.py`, owns everything protocol-specific:
request serialization, auth headers, token-limit field naming, response envelope
validation, and stop-signal normalization. `backend/main.py` keeps configuration,
the HTTP client, retry/deadline policy, prompt handling, caching, and all route
handlers.

### Module boundary

`providers.py` must not import `main`, because `main` imports it. The shared
config type is imported under `TYPE_CHECKING` only and used for annotations.

```python
class ProviderRequest(TypedDict):
    url: str
    headers: dict[str, str]
    body: dict[str, Any]

class ChatCompletion:                     # normalized result
    text: str
    model: str
    tokens_used: int
    finish_reason: str | None

class ProviderProtocolError(Exception): ...

class ProtocolAdapter(Protocol):
    def build_request(
        self, *, config, system_prompt: str | None,
        content: str | Sequence[TextPart | ImagePart],
    ) -> ProviderRequest: ...
    def parse_response(self, payload: object, *, configured_model: str) -> ChatCompletion: ...

def resolve_endpoint(config) -> str: ...        # the one URL resolver
def select_adapter(config) -> ProtocolAdapter: ...
```

`select_adapter` maps `None` and `/v1/chat/completions` to
`ChatCompletionsAdapter`, `/v1/responses` to `ResponsesAdapter`, and
`/v1/messages` to `MessagesAdapter`.

### The preserved seam

`main._request_chat_completion` keeps its **exact current signature**
`(config, messages, *, idempotency_key=None)` and return type. It normalizes the
OpenAI-shaped `messages` list into `(system_prompt, content)`, delegates to the
adapter, and performs the existing HTTP call. The 32 existing
`monkeypatch.setattr(main, "_request_chat_completion", …)` sites in
`tests/test_format_pipeline.py`, `tests/test_translate_pipeline.py`, and
`tests/test_transformation_endpoints.py` are therefore untouched.

Text operations still pass their user turn as a `str`, so the existing fakes keep
receiving a string at `messages[-1]["content"]`. Only the OCR call site changes,
to build `TextPart`/`ImagePart` instead of a raw dict array; no test observes that
wire shape.

`ChatCompletion` is re-exported as `main._ChatCompletion` with the same field
order (`text, model, tokens_used, finish_reason`), so positional construction in
tests (`main._ChatCompletion("x", "m", 1, "stop")`) keeps working and
`main._ChatCompletion` stays one class object.

### Shared URL resolver

`providers.resolve_endpoint(config)` replaces both hardcoded sites:
`main.py:534` (cache identity) and `main.py:737` (the POST). A grep confirms
there are no others in source.

### Config inheritance

`_resolve_ai_config` (`main.py:451`) rebuilds `AIConfig` field by field. It must
carry `endpoint` and `messages_default_max_tokens` through, or a `ai.text`
override would silently drop the protocol back to legacy. This is the single most
likely silent bug in the change and gets a direct test.

`ProviderOverride` is a `FrozenModel` with `extra="forbid"`, so `ai.ocr.endpoint`
and `ai.text.endpoint` are already rejected by validation. That keeps requirement
3 satisfied with no new code; a test pins it.

## Request and response contracts

### Chat Completions (legacy and explicit)

Headers: `Authorization: Bearer <key>` only (see "Headers" — never an explicit
`Content-Type`).

Body fields in insertion order: `model`, `messages`, then `max_tokens` only when
the effective limit is positive. A text-only turn renders
`{"role": "system", "content": <str>}` and `{"role": "user", "content": <str>}`;
a parts turn renders the array form. The system message is omitted entirely when
`system_prompt` is `None`.

### Responses

Headers: `Authorization: Bearer <key>` only.

Body: `model`, `instructions` (omitted when `system_prompt` is `None`), `input`,
`store: false`, and `max_output_tokens` only when positive. `store` is always
present and exactly `false`; it disables API storage only and promises nothing
about gateway-side operational logs.

`input` has **two shapes**, and a parts turn is not a bare array of parts:

```jsonc
// text-only turn (dedup / translate / format)
"input": "<user text>"

// parts turn (OCR)
"input": [{
  "role": "user",
  "content": [
    {"type": "input_text",  "text": "<prompt>"},
    {"type": "input_image", "image_url": "<data url>"}
  ]
}]
```

The parts array is wrapped in a `{"role": "user", "content": [...]}` message;
raw `input_text`/`input_image` parts at the top level of `input` are an invalid
Responses request. Tests assert the **whole body**, not just the image object.

### Messages

Headers: `x-api-key: <key>` and `anthropic-version: 2023-06-01` only. No
`Authorization` header, no explicit `Content-Type`.

Body: `model`, `system` (omitted when `None`), `messages: [{"role": "user",
"content": …}]`, and `max_tokens` always, using the positive effective limit when
set and `ai.messages_default_max_tokens` otherwise. A text turn uses a plain
string content; a parts turn uses an array of `text` / `image` blocks. For an
image part the data-URL prefix is parsed into `source`; a malformed data URL
raises `ProviderProtocolError`.

### Response normalization and truncation mapping

Every adapter returns `ChatCompletion` and validates its own envelope, raising
`ProviderProtocolError` rather than leaking `KeyError`/`TypeError`.

**Chat text extraction is preserved verbatim, not replaced.** TextKit's current
Chat extraction (`_extract_openai_text`, `main.py:640`) is observably different
from ai-grammar's: it `.strip()`s string content, rejects empty and
whitespace-only content with 502, and accepts a *list* of `text` parts by
stripping each and joining with `\n`. Verified against the base commit:
`'  hello  '` → `'hello'`, `''`/`'   '`/`null` → 502, `[{"type":"text","text":" a "},
{"type":"text","text":" b "}]` → `'a\nb'`. `/ocr` and `/dedup` responses depend
on this. The Chat adapter therefore reuses that behavior, moved into the provider
layer with its HTTP exception replaced by `ProviderProtocolError` (same message
text, so the retargeted test still asserts `"missing choices"`). Adopting
ai-grammar's accept-empty-string rule would silently change `/dedup` and `/ocr`.

**Messages text extraction** strips the concatenated result and rejects
whitespace-only normal output, mirroring Chat's current behavior so `/ocr` and
`/dedup` keep their contract across protocols. It concatenates the `text` of
`{"type": "text"}` blocks in provider order with no separator, ignores non-text
blocks, and treats a non-string `text`, a missing/non-list `content`, or the
absence of any text block as an upstream error.

**Responses text extraction** concatenates `output_text` parts of `message`
items in provider order with no separator, ignoring non-message items and
non-`output_text` parts, then strips and rejects whitespace-only normal output.
A malformed `output`/`content` list or a non-string `text` is an upstream error.

**Chat token usage stays exactly as it is today.** `main.py:750`–`:753` validates
only `total_tokens`, with `isinstance(value, int)`. Probes against the base commit
confirm today's accepted set: absent usage → `0`, `usage: null` → `0`,
`usage: {}` → `0`, `total_tokens: 3` → `3`, `total_tokens: true` → `1` (accepted,
because `bool` passes `isinstance`), a malformed sibling `prompt_tokens` ignored,
and `total_tokens` of `-1`, `1.0`, `"3"`, or `null` → 502 with the existing
detail string. The Chat adapter reproduces this verbatim rather than applying the
stricter cross-protocol rule; tightening it would turn legacy successes into 502s
and violate requirement 2. Messages and Responses, which have no legacy
behavior, use the strict exact-integer rule.

| Protocol | `"length"` | normal stop | upstream error |
| --- | --- | --- | --- |
| Chat | `finish_reason == "length"` | any other string, or absent (passed through, as today) | — |
| Responses | `error` absent/null **and** `status == "incomplete"` **and** `incomplete_details` is an object with `reason == "max_output_tokens"` | `error` and `incomplete_details` both absent or null **and** `status == "completed"` | any other status (`failed`, `cancelled`, `incomplete` with another/absent/malformed reason, `in_progress`, `queued`, unknown, missing, null, non-string); **or a present non-null `error` on any status**; or `status == "completed"` with a present non-null `incomplete_details` |
| Messages | `stop_reason == "max_tokens"` | `end_turn`, `stop_sequence`, or absent | `pause_turn`, `tool_use`, `refusal`, any other string, or a present non-string (including `null`) |

**A present non-null `error` is checked first and wins on every status.** An
envelope carrying `status: "incomplete"`,
`incomplete_details: {"reason": "max_output_tokens"}`, *and* a populated `error`
is an upstream error, never a truncation signal: requirement 6 says erroring
responses stay errors. This ordering is pinned by a conflicting-envelope test.

**A recognized truncation with no visible text is a valid `"length"` result, not
an error.** OpenAI documents that `status: "incomplete"` with
`reason: "max_output_tokens"` can occur before any visible output is produced
(for example when the whole budget is consumed by reasoning). Such an envelope
normalizes to `text=""`, `finish_reason="length"`. This matters: `/format`
(`main.py:1049`) and `/translate` (`main.py:1163`) fall back to split-and-retry
precisely on `"length"`, and the existing code path for a too-long chunk returns
the *source* text. Raising instead would abort the request and defeat the
repair pipeline.

**That exception is scoped to the pipelines, not to `/ocr` and `/dedup`.** Those
two routes do **not** chunk, split, or retry: `_post_openai_chat_completion`
(`main.py:764`) constructs `OCRResponse` directly and discards `finish_reason`.
An empty completion there would otherwise return HTTP 200 with `text: ""`, a
silent empty transcription, which is exactly what the current Chat path prevents
by rejecting blank content with 502. The shared wrapper therefore rejects a blank
normalized completion with 502 when `finish_reason` is absent or is not
`"length"`, and **also** rejects a blank completion whose `finish_reason` *is*
`"length"`, because there is no repair available to consume it. Chat's existing
blank rejection is therefore unconditional on both routes.

Net effect by route:

| Route | blank text, length | blank text, normal stop |
| --- | --- | --- |
| `/format`, `/translate` | accepted; pipeline splits and falls back to source | 502 |
| `/ocr`, `/dedup` | 502 | 502 |

The `text=""` normalization exists solely so the two chunked pipelines can see
`"length"` and repair. It is never a user-visible empty success.

**This design deliberately diverges from ai-grammar in three places, each by
user mandate or by TextKit's own route contract.**

1. ai-grammar rejects every non-`completed` Responses status and every non-null
   `incomplete_details` with 502; requirement 6 instead makes
   `status == "incomplete"` with `incomplete_details.reason == "max_output_tokens"`
   the truncation signal.
2. ai-grammar passes unknown Messages `stop_reason` strings through; TextKit
   treats them as upstream errors because requirement 6 says everything "failed,
   cancelled, erroring, or incomplete for another reason is an upstream error".
3. ai-grammar accepts empty Chat content as legitimate; TextKit keeps its own
   existing strip-and-reject rule, and additionally rejects a blank
   no-visible-text truncation on the two routes that cannot repair it.

All three are intentional and pinned by test. No other legacy-visible behavior
changes.

Responses `incomplete_details` handling is deliberately narrow: truncation is
recognized only when `incomplete_details` is an object whose `reason` is the
exact string `max_output_tokens`. A missing, null, non-object, or differently
reasoned `incomplete_details` on a non-`completed` status is an upstream error,
never a silent empty result.

This mapping is load-bearing: `main.py:999`, `:1049`, and `:1163` decide whether
to split-and-retry a chunk from `finish_reason == "length"`. A wrong mapping
silently disables `/format` and `/translate` truncation repair.

Normalized model falls back to `config.model` only when the field is absent; a
present non-string model is malformed in all three protocols (Chat currently does
this too, at `main.py:754`–`:755`). Token usage follows the protocol split above:
Chat preserves today's exact rules; Responses and Messages validate every present
count as an exact non-negative `int`, reject `bool`, floats, and strings, apply
their per-protocol null handling, and normalize to an integer.

## Error mapping, retry, and deadlines

One exception class, `ProviderProtocolError`, covers a malformed request part and
a malformed response envelope. The facade maps it to the existing 502 shape. The
following are preserved exactly:

- the shared pooled `_get_http_client()`;
- `_call_with_retry` with its **2 attempts** and `httpx.ConnectError`-only retry,
  which is TextKit's policy (ai-grammar retries every error class);
- the 504 deadline path (`config.timeout.read + 60`);
- `response.is_error` → 502 with the truncated upstream body.

TextKit parses JSON after the retry wrapper returns, unlike ai-grammar. The
adapter's `parse_response` is called at the same point, so retry and error
ordering are unchanged. A config error is not a `ProviderProtocolError`: it stays
a `RuntimeError` from `load_config` and reaches the existing catch-all 500.

`providers.py` must stay free of `httpx` and `fastapi`: it performs no network
I/O and raises only `ProviderProtocolError`. All transport, `HTTPException`
construction, logging, and debug dumping stay in `main`.

## Headers: do not set `Content-Type` explicitly

Today `_request_chat_completion` passes only `Authorization` (plus an optional
`Idempotency-Key`) and lets httpx derive `Content-Type` from `json=`. The
resulting raw header order is `Authorization`, optional `Idempotency-Key`,
`Content-Length`, `Content-Type`. An explicit `Content-Type` in the dict instead
produces `Authorization`, `Content-Type`, `Content-Length` (verified with an
httpx probe).

Adapters therefore return only their **protocol-defining** headers —
`Authorization` for the two OpenAI protocols, `x-api-key` plus
`anthropic-version` for Messages — and never `Content-Type`. httpx adds it from
`json=` in every case, which keeps legacy Chat byte-identical and gives the two
new protocols a correct `application/json` without a second header policy. The
golden tests assert `request.headers.raw` with **and without** an operation id.

## Idempotency-Key

TextKit sets `Idempotency-Key` on every provider call when an operation id exists,
and the chunked `/format` and `/translate` repair loops depend on per-chunk keys
(`_chunk_idempotency_key`). The header is textkit-originated and
protocol-independent, so it is sent on **all three** protocols. Chat stays
byte-identical because it already sent it. Dropping it for two protocols would
silently change retry semantics for users who switch protocol. A per-protocol test
pins it.

## Cache identity

`_resolve_text_settings` (`main.py:534`) hashes `provider_endpoint` into the
SQLite cache key. That value becomes `resolve_endpoint(effective_ai)`.

`CACHE_FORMAT_VERSION` stays **1**. The resolved string is byte-identical for
every existing config, because the legacy concatenation is unchanged and the
validator already stripped trailing slashes. Two different protocols can never
resolve to the same URL because their path suffixes differ. Requirements: an
existing Chat entry stays reusable after the change, and a Chat entry is never
returned for a Responses or Messages request. Both are pinned by test.

### The Messages fallback must be part of the identity

`_cache_identity` (`main.py:538`) hashes effective `max_tokens` and
`provider_endpoint`. Under Messages with no `ai.max_tokens`, the *effective*
upstream limit is `ai.messages_default_max_tokens`, so editing that fallback
changes the request while the identity stays the same — a stale hit that returns
a result produced under a different token ceiling.

The canonical digest dictionary therefore gains one **conditional** key, added
only when the effective protocol is Messages:

```python
if settings.config.endpoint == "/v1/messages":
    canonical["messages_default_max_tokens"] = settings.config.messages_default_max_tokens
```

Because the dictionary is serialized with `sort_keys=True`, a conditional key
would normally perturb every digest. Gating on the protocol keeps legacy and
Chat/Responses dictionaries byte-identical to today, so the pinned digest vector
in `tests/test_prompt_snapshot.py:236` still passes unchanged and existing Chat
entries remain reachable. A test changes the fallback and asserts the identity
moves.

## Configuration surface

`ai.endpoint: Literal["/v1/chat/completions", "/v1/responses", "/v1/messages"] | None = None`
and `ai.messages_default_max_tokens: int = Field(default=4096, strict=True, gt=0)`
on `AIConfig`. **`strict=True` alone is not enough**: a probe shows pydantic
accepts `0` and `-1` with `strict=True` but rejects them with `strict=True, gt=0`,
and `gt=0` alone would accept `true` and `"5"`. Both constraints are required —
`strict` rejects booleans and numeric strings, `gt=0` enforces positivity. A
non-positive fallback would otherwise become the mandatory Messages `max_tokens`
and reach upstream instead of failing configuration validation.

Absent-vs-present is decided by inspecting the **raw YAML mapping**, not by a
pydantic `Literal` default alone: a `Literal` annotation with a `None` default
does not distinguish an explicit `null` from an omitted key, and
`_resolve_ai_config` legitimately passes `endpoint=None` explicitly. The
`Literal` still earns its place as a second, typed line of defence; the raw-dict
check in `load_config` runs first and produces the byte-exact error message.

### Two distinct HTTP 500 paths

An invalid `ai.endpoint` can surface as a 500 in two different ways, and both are
specified and tested:

1. **Startup.** `lifespan` (`main.py:1245`) calls `_get_config()` before the
   server accepts traffic, so an invalid endpoint raises `RuntimeError` and the
   process refuses to start. **No HTTP response exists on this path** — it is a
   startup failure, asserted with a lifespan-scoped client. No request can ever
   reach an upstream call.
2. **Request-time reload.** `security_and_limits` (`main.py:1338`) calls
   `_get_config()` per request and converts a `RuntimeError` directly into the
   structured 500 envelope (it does not go through the catch-all handler). Editing
   `config.yaml` to an invalid endpoint while the server runs therefore yields
   500 on the next request, again with no upstream call.

The bare `TestClient(main.app)` fixture cannot observe path 1 because it does not
run lifespan startup, so that test must use a context-managed client.

Because `load_config` caches on the file's `(mtime_ns, size)` signature
(`_config_signature`), the second path is exercised by mutating the file between
requests.

## Testing strategy

The verification gate, all inside the integration worktree:

1. `python -m pytest tests/ -v` — full suite. **Baseline in the clean integration
   worktree is 278 passing** (the dirty base checkout additionally carries one
   uncommitted test change, which is why it reports 279).
2. `node tests/background.test.js && node tests/popup.test.js &&
   node tests/content.test.js`.
3. **Legacy byte-identity goldens.** A test captures URL, headers, and exact JSON
   body bytes for `/ocr` (image parts), `/dedup` (system+user strings),
   `/translate` and `/format` (system+user strings) in legacy mode and asserts
   them against the values captured from `main @ 6d3c267` before the change.
4. Per-protocol request tests: URL, headers, body field names, text part type,
   model, token-limit field, and `store: false` for Responses.
5. Per-protocol response tests: text extraction, model fallback, token
   normalization, truncation mapping to `"length"`, and rejection of malformed
   envelopes with 502 (not 500).
6. Per-protocol OCR tests asserting the image wire shape from the table above.
7. Cache tests: protocol isolation and cross-version reuse of an existing Chat
   entry, plus a legacy digest equal to the pre-change literal.
8. Config tests: each of the three values accepted; `null`, non-string, alias,
   full URL, arbitrary path, and `ai.ocr.endpoint`/`ai.text.endpoint` rejected
   with no upstream request; `messages_default_max_tokens` validation.
9. Idempotency-Key present on all three protocols, and the golden tests assert
   `request.headers.raw` with and without an operation id.
10. **Route-level truncation, through the real adapters.** A test drives a raw
    protocol envelope through `httpx.MockTransport` with the real facade and the
    real adapter selected, asserting that a recognized truncation reaches
    `/format` and `/translate` split-and-retry. Faking
    `_request_chat_completion` is not sufficient, because it bypasses adapter
    selection and stop mapping. Include the Responses no-visible-text truncation
    case from above.
11. **Route-level response contracts.** `/ocr` and `/dedup` return the unchanged
    JSON shapes for all three protocols, including Chat's `.strip()` behavior and
    whitespace-only rejection, the new protocols' matching strip/blank rule, and
    explicit raw-envelope tests proving a blank truncation is 502 on these two
    routes while it reaches split-and-retry on `/format` and `/translate`.
12. **Config error paths.** Startup refusal asserts `RuntimeError` with no HTTP
    response through a lifespan-scoped client; request-time reload asserts the
    exact 500 envelope; both assert zero upstream calls.
13. **Messages cache identity.** Changing `messages_default_max_tokens` changes
    the identity, while the legacy Chat digest vector is unchanged.
14. **Chat usage compatibility.** The full accepted/rejected token-usage table
    probed from the base commit (including `total_tokens: true` → `1`, `usage:
    null` → `0`, and a malformed sibling component being ignored) is pinned, so
    the adapter cannot silently tighten legacy behavior.

One existing test changes: `tests/test_backend.py:446
test_provider_response_requires_choices` asserts that `_extract_openai_text`
raises `HTTPException` with `"missing choices"`. Chat envelope parsing moves into
the adapter, so this test is retargeted to the adapter's
`ProviderProtocolError`, still matching `"missing choices"` because the message
text is carried over. No other existing test is modified.

Byte-level detail: header **order** is observable and is handled by never setting
`Content-Type` explicitly (see "Headers" above).

## Non-goals

No changes under `extension/` (no request or response contract change, no UI). No
streaming, tool calls, conversation state, provider autodetection, arbitrary
endpoint paths, or provider SDK dependencies. Unchanged: `/ocr`, `/dedup`,
`/translate`, `/format`, `/prompts/*` request and response shapes and status
codes; `X-TextKit-Cache` semantics; translation skip-gate fields; the chunked
format/translate pipelines; rate/concurrency and body-size limits;
`backend/requirements.lock`. `backend/config.yaml` stays local and git-ignored.

## Deliverables

- `backend/providers.py` (new)
- `backend/main.py` (config fields, `_resolve_ai_config` passthrough, facade
  delegation, both URL sites, OCR call site)
- `backend/config.example.yaml`, `README.md`
- `tests/test_providers.py` (new) plus additions to `tests/test_backend.py`

"""FastAPI OCR backend using OpenAI-compatible chat completion APIs."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import tempfile
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from contextvars import ContextVar
from io import BytesIO
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlsplit

import httpx
import yaml
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

try:
    from langdetect import DetectorFactory, detect
    from langdetect.lang_detect_exception import LangDetectException

    DetectorFactory.seed = 0
    _LANGDETECT_AVAILABLE = True
except Exception:  # pragma: no cover - exercised only if langdetect is missing
    detect = None  # type: ignore[assignment]
    LangDetectException = Exception  # type: ignore[assignment, misc]
    _LANGDETECT_AVAILABLE = False


CONFIG_PATH = Path(__file__).with_name("config.yaml")
PROMPTS_DIR = Path(__file__).with_name("prompts")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024
DEFAULT_MAX_IMAGE_PIXELS = 40_000_000
DEFAULT_MAX_TEXT_CHARS = 200_000
DEFAULT_MAX_PROMPT_CHARS = 20_000
DEFAULT_MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
MULTIPART_HEADER_OVERHEAD_BYTES = 8 * 1024
MAX_LANGUAGE_CHARS = 32
MIN_DETECT_CHARS = 20
SUPPORTED_LANGUAGES = frozenset(
    {"original", "chinese", "english", "japanese", "korean", "french", "german", "spanish"}
)

# Enforce the configurable pixel limit ourselves after Pillow parses the image
# header, so max_image_pixels=0 can explicitly disable the check.
Image.MAX_IMAGE_PIXELS = None


_DEFAULT_PROMPTS: dict[str, str] = {
    "ocr": (
        "Transcribe all visible text from this image. Return only the transcription, "
        "verbatim — preserve exact wording, punctuation, and line breaks. "
        "Do not add commentary, interpret, or guess illegible text."
    ),
    "dedup": (
        "Remove duplicate and overlapping passages from the text below. "
        "Return only the deduplicated result. Do not reword, paraphrase, or add "
        "anything — only strip repeated or overlapping content."
    ),
    "translate": (
        "Translate the following text to {language}. Return only the translation. "
        "Preserve paragraph structure and line breaks."
    ),
    "format": (
        "Format the following text for readability and clarity. Preserve its meaning "
        "and all important details. Return only the formatted text."
    ),
}

_LANGUAGE_TO_ISO: dict[str, str] = {
    "chinese": "zh-cn",
    "english": "en",
    "japanese": "ja",
    "korean": "ko",
    "french": "fr",
    "german": "de",
    "spanish": "es",
}


class JsonFormatter(logging.Formatter):
    """Small JSON formatter suitable for process supervisors and log shippers."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        event = getattr(record, "event", None)
        if event:
            payload["event"] = event
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


logger = logging.getLogger("textkit")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
logger.setLevel(logging.INFO)
logger.propagate = False


class FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class TimeoutConfig(FrozenModel):
    """Per-phase provider timeouts, in seconds."""

    connect: float = Field(default=10.0, gt=0, le=300)
    read: float = Field(default=600.0, gt=0, le=3600)
    write: float = Field(default=60.0, gt=0, le=600)
    pool: float = Field(default=10.0, gt=0, le=300)


def _validate_api_base_value(value: str) -> str:
    normalized = value.strip().rstrip("/")
    try:
        parsed = urlsplit(normalized)
    except ValueError as exc:
        raise ValueError("api_base must be a valid absolute HTTP(S) URL") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("api_base must be a valid absolute HTTP(S) URL")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("api_base must include a valid port between 1 and 65535") from exc
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("api_base must include a valid port between 1 and 65535")
    if (
        "?" in normalized
        or "#" in normalized
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("api_base must not include query, fragment, or user-info components")
    loopback = parsed.hostname.lower().strip("[]") in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not loopback:
        raise ValueError("api_base must use HTTPS unless it targets a loopback provider")
    return normalized


class ProviderOverride(FrozenModel):
    """Optional per-task provider values; empty values inherit from the base."""

    api_base: str = ""
    api_key: str = ""
    api_key_env: str = ""
    model: str = Field(default="", max_length=200)

    @field_validator("api_base")
    @classmethod
    def validate_api_base(cls, value: str) -> str:
        return _validate_api_base_value(value) if value.strip() else ""


class AIConfig(FrozenModel):
    """OpenAI-compatible provider configuration with lazy secret references."""

    api_base: str = "https://api.openai.com"
    api_key: str = ""
    api_key_env: str = ""
    model: str = Field(default="gpt-4.1-mini", min_length=1, max_length=200)
    timeout: TimeoutConfig = Field(default_factory=TimeoutConfig)
    ocr: ProviderOverride | None = None
    text: ProviderOverride | None = None

    @field_validator("api_base")
    @classmethod
    def validate_api_base(cls, value: str) -> str:
        return _validate_api_base_value(value)


class AppConfig(FrozenModel):
    """Validated application settings loaded from YAML."""

    host: str = DEFAULT_HOST
    port: int = Field(default=DEFAULT_PORT, ge=1, le=65535)
    max_upload_bytes: int = Field(default=DEFAULT_MAX_UPLOAD_BYTES, ge=0, le=100 * 1024 * 1024)
    max_image_pixels: int = Field(default=DEFAULT_MAX_IMAGE_PIXELS, ge=0, le=200_000_000)
    max_text_chars: int = Field(default=DEFAULT_MAX_TEXT_CHARS, ge=0, le=2_000_000)
    max_prompt_chars: int = Field(default=DEFAULT_MAX_PROMPT_CHARS, ge=0, le=100_000)
    max_request_body_bytes: int = Field(default=DEFAULT_MAX_REQUEST_BODY_BYTES, ge=0, le=20 * 1024 * 1024)
    requests_per_minute: int = Field(default=60, ge=0, le=10_000)
    max_concurrent_requests: int = Field(default=4, ge=0, le=100)
    debug: bool = False
    ai: AIConfig | None = Field(default_factory=AIConfig)

    @field_validator("host")
    @classmethod
    def validate_host(cls, value: str) -> str:
        host = value.strip().strip("[]")
        if not host or any(char.isspace() for char in host):
            raise ValueError("host must be a valid bind address")
        return host


BoundedText = Annotated[str, Field(min_length=1)]


class OCRResponse(BaseModel):
    text: str
    model: str
    tokens_used: int
    error: str | None = None


class DedupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: BoundedText
    prompt: str | None = None


class TranslateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: BoundedText
    language: Annotated[str, Field(min_length=1, max_length=MAX_LANGUAGE_CHARS)]
    prompt: str | None = None

    @field_validator("language")
    @classmethod
    def validate_language(cls, value: str) -> str:
        cleaned = value.strip()
        if cleaned.lower() not in SUPPORTED_LANGUAGES:
            raise ValueError(f"language must be one of: {', '.join(sorted(SUPPORTED_LANGUAGES))}")
        return cleaned if cleaned.lower() == "original" else cleaned.title()


class FormatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: BoundedText
    prompt: str | None = None


class _PromptCacheEntry(FrozenModel):
    template: str
    signature: tuple[int, int]


_prompt_cache: dict[str, _PromptCacheEntry | str] = {}
_config_cache: tuple[tuple[int, int] | None, AppConfig] | None = None
_config_lock = asyncio.Lock()
_http_client: httpx.AsyncClient | None = None
_debug_dir: Path | None = None
_rate_events: defaultdict[str, deque[float]] = defaultdict(deque)
_active_requests = 0
_limit_lock = asyncio.Lock()
_operation_id: ContextVar[str] = ContextVar("textkit_operation_id", default="")


def _load_yaml_config(path: Path | None = None) -> dict[str, Any]:
    path = CONFIG_PATH if path is None else path
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as config_file:
        loaded = yaml.safe_load(config_file) or {}
    if not isinstance(loaded, dict):
        raise RuntimeError("config.yaml must contain a YAML mapping at the top level")
    return loaded


def _config_signature(path: Path | None = None) -> tuple[int, int] | None:
    path = CONFIG_PATH if path is None else path
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return stat.st_mtime_ns, stat.st_size


def load_config() -> AppConfig:
    """Load and validate config.yaml, caching it until the file changes."""

    global _config_cache
    signature = _config_signature()
    if _config_cache and _config_cache[0] == signature:
        return _config_cache[1]
    raw = _load_yaml_config()
    if "save_root" in raw:
        raise RuntimeError("save_root was removed; file saving belongs to the authenticated file bridge")
    try:
        config = AppConfig.model_validate(raw)
    except ValidationError as exc:
        raise RuntimeError(f"Invalid config.yaml: {exc}") from exc
    _config_cache = (signature, config)
    return config


async def _get_config() -> AppConfig:
    """Avoid filesystem metadata/config reads on the async event loop."""

    async with _config_lock:
        return await asyncio.to_thread(load_config)


def _resolve_secret(raw: str, env_name: str = "") -> str:
    if env_name:
        name = env_name[1:] if env_name.startswith("$") else env_name
        return os.getenv(name, "")
    if raw.startswith("$"):
        return os.getenv(raw[1:], "")
    return raw


def _resolve_ai_api_key(config: AIConfig) -> str:
    explicit = bool(config.api_key or config.api_key_env)
    resolved = _resolve_secret(config.api_key, config.api_key_env)
    if resolved:
        return resolved
    if explicit:
        reference = config.api_key_env or config.api_key
        raise HTTPException(status_code=500, detail=f"API key reference is not available: {reference}")
    for env_name in ("OCR_API_KEY", "OPENAI_API_KEY"):
        value = os.getenv(env_name)
        if value:
            return value
    raise HTTPException(
        status_code=500,
        detail="No API key configured. Set ai.api_key/api_key_env or OCR_API_KEY.",
    )


def _resolve_ai_config(base: AIConfig, override: ProviderOverride | None) -> AIConfig:
    if override is None:
        return base
    override_has_key = bool(override.api_key or override.api_key_env)
    return AIConfig(
        api_base=override.api_base or base.api_base,
        api_key=override.api_key if override_has_key else base.api_key,
        api_key_env=override.api_key_env if override_has_key else base.api_key_env,
        model=override.model or base.model,
        timeout=base.timeout,
    )


def _prompt_path(name: str, language: str | None = None) -> Path:
    return PROMPTS_DIR / (f"{name}.{language}.txt" if language else f"{name}.txt")


def _read_prompt_path(path: Path) -> tuple[str, tuple[int, int]] | None:
    try:
        stat = path.stat()
        template = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    return template, (stat.st_mtime_ns, stat.st_size)


def _load_prompt(name: str, language: str | None = None) -> str:
    """Load a prompt with signature-based cache invalidation across workers."""

    candidates: list[tuple[str, Path]] = []
    if language:
        candidates.append((f"{name}.{language}", _prompt_path(name, language)))
    candidates.append((name, _prompt_path(name)))
    for cache_key, path in candidates:
        loaded = _read_prompt_path(path)
        if loaded is None:
            continue
        template, signature = loaded
        cached = _prompt_cache.get(cache_key)
        if isinstance(cached, _PromptCacheEntry) and cached.signature == signature:
            return cached.template
        # Compatibility with older tests/tools that may insert a plain string.
        _prompt_cache[cache_key] = _PromptCacheEntry(template=template, signature=signature)
        return template
    return _DEFAULT_PROMPTS.get(name, "")


def _render_prompt(name: str, **kwargs: str) -> str:
    """Substitute only the supported literal placeholder, preserving other braces."""

    language = kwargs.get("language")
    template = _load_prompt(name, language)
    return template.replace("{language}", language or "")


def _read_prompt_direct(name: str, language: str | None = None) -> str | None:
    loaded = _read_prompt_path(_prompt_path(name, language))
    return loaded[0] if loaded is not None else None


def _fallback_prompt(name: str, language: str | None = None) -> tuple[str, str]:
    template = _read_prompt_direct(name, language)
    if template is not None:
        return template, "file"
    if language:
        template = _read_prompt_direct(name)
        if template is not None:
            return template, "file"
    return _DEFAULT_PROMPTS.get(name, ""), "hardcoded"


def _validate_text_size(text: str, config: AppConfig) -> None:
    if config.max_text_chars and len(text) > config.max_text_chars:
        raise HTTPException(status_code=413, detail=f"Text exceeds configured limit of {config.max_text_chars} characters")


def _validate_optional_prompt(prompt: str | None, config: AppConfig) -> None:
    if prompt is not None and config.max_prompt_chars and len(prompt) > config.max_prompt_chars:
        raise HTTPException(status_code=413, detail=f"Prompt exceeds configured limit of {config.max_prompt_chars} characters")


async def _read_limited_upload(image: UploadFile, max_bytes: int) -> bytes:
    image_bytes = await image.read(max_bytes + 1) if max_bytes else await image.read()
    if max_bytes and len(image_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail=f"Image exceeds configured limit of {max_bytes} bytes")
    return image_bytes


def _image_to_data_url(
    image_bytes: bytes,
    _content_type: str | None,
    max_pixels: int = DEFAULT_MAX_IMAGE_PIXELS,
) -> str:
    """Inspect dimensions before decoding and encode with the detected MIME type."""

    if not image_bytes:
        raise HTTPException(status_code=400, detail="Missing image data")
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            inferred_format = (image.format or "").upper()
            width, height = image.size
            if getattr(image, "n_frames", 1) > 1:
                raise HTTPException(status_code=400, detail="Animated images are not supported for OCR")
            if width <= 0 or height <= 0 or (max_pixels and width * height > max_pixels):
                raise HTTPException(status_code=413, detail=f"Image exceeds configured pixel limit of {max_pixels}")
            image.verify()
        with Image.open(BytesIO(image_bytes)) as image:
            image.load()
    except HTTPException:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(status_code=413, detail="Image dimensions are too large") from exc
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid image") from exc
    if inferred_format == "PNG" and not image_bytes.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82"):
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid image")
    mime_type = Image.MIME.get(inferred_format)
    if not mime_type:
        raise HTTPException(status_code=400, detail="Unsupported image format")
    return f"data:{mime_type};base64,{base64.b64encode(image_bytes).decode('ascii')}"


def _decode_provider_json(response: httpx.Response, provider_name: str) -> dict[str, Any]:
    try:
        payload = response.json()
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"{provider_name} API returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail=f"{provider_name} API returned an unexpected response shape")
    return payload


def _extract_openai_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise HTTPException(status_code=502, detail="OpenAI API response is missing choices")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise HTTPException(status_code=502, detail="OpenAI API response is missing choices[0].message")
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
    raise HTTPException(status_code=502, detail="OpenAI API response contains no text content")


async def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(limits=httpx.Limits(max_connections=20, max_keepalive_connections=10))
    return _http_client


async def _call_with_retry(config: AIConfig, make_request: Any, provider_name: str) -> httpx.Response:
    deadline = config.timeout.read + 60
    last_exc: Exception | None = None
    for attempt in (1, 2):
        try:
            return await asyncio.wait_for(make_request(), timeout=deadline)
        except asyncio.TimeoutError as exc:
            raise HTTPException(status_code=504, detail=f"{provider_name} API did not respond within {deadline}s") from exc
        except httpx.ConnectError as exc:
            last_exc = HTTPException(status_code=502, detail=f"{provider_name} API connection failed: {exc}")
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"{provider_name} API request failed: {type(exc).__name__}: {exc}",
            ) from exc
        if attempt == 1:
            await asyncio.sleep(1)
    assert last_exc is not None
    raise last_exc


async def _post_openai_chat_completion(config: AIConfig, messages: list[dict[str, Any]]) -> OCRResponse:
    api_key = _resolve_ai_api_key(config)
    request_body = {"model": config.model, "messages": messages}
    headers = {"Authorization": f"Bearer {api_key}"}
    operation_id = _operation_id.get()
    if operation_id:
        headers["Idempotency-Key"] = operation_id
    timeout = httpx.Timeout(
        connect=config.timeout.connect,
        read=config.timeout.read,
        write=config.timeout.write,
        pool=config.timeout.pool,
    )

    async def _do_request() -> httpx.Response:
        client = await _get_http_client()
        response = await client.post(
            f"{config.api_base}/v1/chat/completions",
            headers=headers,
            json=request_body,
            timeout=timeout,
        )
        if response.is_error:
            detail = response.text[:500] + ("..." if len(response.text) > 500 else "")
            raise HTTPException(status_code=502, detail=f"OpenAI API failed: {detail}")
        return response

    payload = _decode_provider_json(await _call_with_retry(config, _do_request, "OpenAI"), "OpenAI")
    text = _extract_openai_text(payload)
    usage = payload.get("usage")
    total_tokens = usage.get("total_tokens", 0) if isinstance(usage, dict) else 0
    if not isinstance(total_tokens, int) or total_tokens < 0:
        raise HTTPException(status_code=502, detail="OpenAI API response has invalid token usage")
    model = payload.get("model", config.model)
    if not isinstance(model, str):
        raise HTTPException(status_code=502, detail="OpenAI API response has invalid model")
    return OCRResponse(text=text, model=model, tokens_used=total_tokens)


async def _call_openai(config: AIConfig, data_url: str, prompt: str | None = None) -> OCRResponse:
    effective_prompt = prompt or await asyncio.to_thread(_render_prompt, "ocr")
    return await _post_openai_chat_completion(
        config,
        [{
            "role": "user",
            "content": [
                {"type": "text", "text": effective_prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }],
    )


async def transcribe_image(config: AIConfig, data_url: str, prompt: str | None = None) -> OCRResponse:
    return await _call_openai(_resolve_ai_config(config, config.ocr), data_url, prompt)


async def deduplicate_text(config: AIConfig, text: str, prompt: str | None = None) -> OCRResponse:
    cfg = _resolve_ai_config(config, config.text)
    effective_prompt = prompt or await asyncio.to_thread(_render_prompt, "dedup")
    return await _post_openai_chat_completion(
        cfg,
        [
            {"role": "system", "content": effective_prompt},
            {"role": "user", "content": text},
        ],
    )


def _detect_language(text: str) -> str | None:
    if not _LANGDETECT_AVAILABLE:
        return None
    try:
        return detect(text)
    except (LangDetectException, Exception):
        return None


def _should_skip_translation(
    text: str,
    language: str,
    prompt: str | None,
    *,
    debug: bool = False,
) -> tuple[bool, str, str | None]:
    if prompt:
        return False, "", None
    lang_key = language.strip().lower()
    if lang_key == "original":
        return True, "original_target", None
    if len(text.strip()) < MIN_DETECT_CHARS:
        return False, "", None
    target_iso = _LANGUAGE_TO_ISO.get(lang_key)
    detected = _detect_language(text)
    if target_iso and detected == target_iso:
        if debug:
            logger.info("translation skipped: detected=%s target=%s", detected, target_iso, extra={"event": "translate.skip"})
        return True, "same_language", detected
    return False, "", detected


async def translate_text(config: AIConfig, text: str, language: str, prompt: str | None = None) -> OCRResponse:
    cfg = _resolve_ai_config(config, config.text)
    effective_prompt = prompt or await asyncio.to_thread(_render_prompt, "translate", language=language)
    return await _post_openai_chat_completion(
        cfg,
        [
            {"role": "system", "content": effective_prompt},
            {"role": "user", "content": text},
        ],
    )


async def format_text(config: AIConfig, text: str, prompt: str | None = None) -> OCRResponse:
    cfg = _resolve_ai_config(config, config.text)
    effective_prompt = prompt or await asyncio.to_thread(_render_prompt, "format")
    return await _post_openai_chat_completion(
        cfg,
        [
            {"role": "system", "content": effective_prompt},
            {"role": "user", "content": text},
        ],
    )


def _error_payload(error: str) -> dict[str, str | int | None]:
    return {"text": "", "model": "", "tokens_used": 0, "error": error}


_AI_ENDPOINTS = {"/ocr", "/dedup", "/translate", "/format"}


async def _acquire_request_slot(request: Request, config: AppConfig) -> JSONResponse | None:
    global _active_requests
    key = request.client.host if request.client else "unknown"
    now = time.monotonic()
    async with _limit_lock:
        events = _rate_events[key] if config.requests_per_minute else None
        if events is not None:
            while events and now - events[0] >= 60:
                events.popleft()
        if events is not None and len(events) >= config.requests_per_minute:
            return JSONResponse(status_code=429, content=_error_payload("Rate limit exceeded"), headers={"Retry-After": "60"})
        if config.max_concurrent_requests and _active_requests >= config.max_concurrent_requests:
            return JSONResponse(status_code=429, content=_error_payload("Too many concurrent requests"), headers={"Retry-After": "1"})
        if events is not None:
            events.append(now)
        if config.max_concurrent_requests:
            _active_requests += 1
    return None


async def _release_request_slot(config: AppConfig) -> None:
    global _active_requests
    if not config.max_concurrent_requests:
        return
    async with _limit_lock:
        _active_requests = max(0, _active_requests - 1)


def _private_debug_dir() -> Path:
    global _debug_dir
    if _debug_dir is None:
        _debug_dir = Path(tempfile.mkdtemp(prefix="textkit-debug-"))
        _debug_dir.chmod(0o700)
    return _debug_dir


def _write_private_file(name: str, data: bytes) -> None:
    path = _private_debug_dir() / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(data)


async def _debug_dump(config: AppConfig, name: str, data: bytes | str) -> None:
    if not config.debug:
        return
    raw = data.encode("utf-8") if isinstance(data, str) else data
    await asyncio.to_thread(_write_private_file, name, raw)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config = await _get_config()
    await asyncio.to_thread(lambda: [_load_prompt(name) for name in _DEFAULT_PROMPTS])
    await _get_http_client()
    if config.debug:
        await asyncio.to_thread(_private_debug_dir)
    logger.info("TextKit backend started on %s:%s", config.host, config.port, extra={"event": "server.start"})
    try:
        yield
    finally:
        global _http_client
        if _http_client is not None:
            await _http_client.aclose()
            _http_client = None
        logger.info("TextKit backend stopped", extra={"event": "server.stop"})


def _request_body_limit(config: AppConfig, path: str) -> int:
    if path == "/ocr":
        if not config.max_upload_bytes or not config.max_prompt_chars:
            return 0
        return (
            config.max_upload_bytes
            + config.max_prompt_chars * 4
            + MULTIPART_HEADER_OVERHEAD_BYTES
        )
    return config.max_request_body_bytes


class RequestBodyLimitMiddleware:
    """Limit streamed/chunked bodies before Starlette buffers or parses them."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or scope.get("method") not in {"POST", "PUT", "PATCH"}:
            await self.app(scope, receive, send)
            return
        try:
            config = await _get_config()
        except RuntimeError as exc:
            await JSONResponse(status_code=500, content=_error_payload(str(exc)))(scope, receive, send)
            return
        limit = _request_body_limit(config, scope.get("path", ""))
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        try:
            declared_length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            declared_length = 0
        if limit and declared_length > limit:
            await JSONResponse(status_code=413, content=_error_payload("Request body is too large"))(scope, receive, send)
            return

        messages: list[dict[str, Any]] = []
        received = 0
        while True:
            message = await receive()
            messages.append(message)
            if message.get("type") == "http.disconnect":
                break
            if message.get("type") == "http.request":
                received += len(message.get("body", b""))
                if limit and received > limit:
                    await JSONResponse(status_code=413, content=_error_payload("Request body is too large"))(scope, receive, send)
                    return
                if not message.get("more_body", False):
                    break

        message_index = 0

        async def replay_receive() -> dict[str, Any]:
            nonlocal message_index
            if message_index < len(messages):
                message = messages[message_index]
                message_index += 1
                return message
            return {"type": "http.disconnect"}

        await self.app(scope, replay_receive, send)


app = FastAPI(title="TextKit Backend v0.0.0", lifespan=lifespan)
app.add_middleware(RequestBodyLimitMiddleware)


@app.middleware("http")
async def security_and_limits(request: Request, call_next: Any) -> Response:
    try:
        config = await _get_config()
    except RuntimeError as exc:
        return JSONResponse(status_code=500, content=_error_payload(str(exc)))

    if request.method in {"POST", "PUT", "PATCH"}:
        content_length = request.headers.get("content-length")
        body_limit = _request_body_limit(config, request.url.path)
        if body_limit and content_length:
            try:
                too_large = int(content_length) > body_limit
            except ValueError:
                return JSONResponse(status_code=400, content=_error_payload("Invalid Content-Length header"))
            if too_large:
                return JSONResponse(status_code=413, content=_error_payload("Request body is too large"))

    limited = request.url.path in _AI_ENDPOINTS
    if not limited:
        return await call_next(request)
    limiter_enabled = bool(config.requests_per_minute or config.max_concurrent_requests)
    if limiter_enabled:
        rejected = await _acquire_request_slot(request, config)
        if rejected:
            return rejected
    operation_id = request.headers.get("x-textkit-operation-id", "").strip()
    if operation_id and (len(operation_id) > 200 or not re.fullmatch(r"[A-Za-z0-9:._-]+", operation_id)):
        if limiter_enabled:
            await _release_request_slot(config)
        return JSONResponse(status_code=400, content=_error_payload("Invalid operation ID"))
    operation_token = _operation_id.set(operation_id)
    try:
        return await call_next(request)
    finally:
        _operation_id.reset(operation_token)
        if limiter_enabled:
            await _release_request_slot(config)


@app.exception_handler(HTTPException)
async def http_error_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=_error_payload(str(exc.detail)))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=400, content=_error_payload(str(exc)))


@app.exception_handler(Exception)
async def catch_all_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled request error for %s", request.url.path, extra={"event": "request.error"})
    return JSONResponse(status_code=500, content=_error_payload("Internal server error"))


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/ocr", response_model=OCRResponse)
async def ocr(
    image: UploadFile | None = File(default=None),
    prompt: Annotated[str | None, Form()] = None,
) -> OCRResponse:
    if image is None:
        raise HTTPException(status_code=400, detail='Missing required form file field "image"')
    config = await _get_config()
    if config.ai is None:
        raise HTTPException(status_code=500, detail="AI provider configuration is missing")
    _validate_optional_prompt(prompt, config)
    image_bytes = await _read_limited_upload(image, config.max_upload_bytes)
    await _debug_dump(config, "last_screenshot.png", image_bytes)
    data_url = await asyncio.to_thread(_image_to_data_url, image_bytes, image.content_type, config.max_image_pixels)
    result = await transcribe_image(config.ai, data_url, prompt)
    await _debug_dump(config, "last_ocr.txt", result.text)
    return result


@app.post("/dedup")
async def dedup(request: DedupRequest) -> dict[str, str | int]:
    config = await _get_config()
    if config.ai is None:
        raise HTTPException(status_code=500, detail="AI provider configuration is missing")
    _validate_text_size(request.text, config)
    _validate_optional_prompt(request.prompt, config)
    await _debug_dump(config, "pre_dedup.txt", request.text)
    result = await deduplicate_text(config.ai, request.text, request.prompt)
    await _debug_dump(config, "after_dedup.txt", result.text)
    return {"text": result.text, "model": result.model, "tokens_used": result.tokens_used}


@app.post("/translate")
async def translate(request: TranslateRequest) -> dict[str, Any]:
    config = await _get_config()
    if config.ai is None:
        raise HTTPException(status_code=500, detail="AI provider configuration is missing")
    _validate_text_size(request.text, config)
    _validate_optional_prompt(request.prompt, config)
    skip, reason, detected_iso = await asyncio.to_thread(
        _should_skip_translation,
        request.text,
        request.language,
        request.prompt,
        debug=config.debug,
    )
    if skip:
        return {
            "text": request.text,
            "model": "",
            "tokens_used": 0,
            "skipped": True,
            "detected_language": detected_iso,
            "skip_reason": reason,
        }
    result = await translate_text(config.ai, request.text, request.language, request.prompt)
    return {"text": result.text, "model": result.model, "tokens_used": result.tokens_used}


@app.post("/format")
async def format_text_endpoint(request: FormatRequest) -> dict[str, str | int]:
    config = await _get_config()
    if config.ai is None:
        raise HTTPException(status_code=500, detail="AI provider configuration is missing")
    _validate_text_size(request.text, config)
    _validate_optional_prompt(request.prompt, config)
    result = await format_text(config.ai, request.text, request.prompt)
    return {"text": result.text, "model": result.model, "tokens_used": result.tokens_used}


def _validate_prompt_request(name: str, language: str | None) -> str | None:
    if name not in _DEFAULT_PROMPTS:
        raise HTTPException(status_code=404, detail=f"Unknown prompt: '{name}'")
    if language is None:
        return None
    normalized = language.strip()
    if normalized.lower() not in SUPPORTED_LANGUAGES - {"original"}:
        raise HTTPException(status_code=400, detail="Unsupported language parameter")
    if name != "translate":
        raise HTTPException(status_code=400, detail="The language parameter is only supported for the translate prompt")
    return normalized.title()


@app.get("/prompts")
async def list_prompts() -> dict[str, dict[str, str]]:
    prompts = await asyncio.to_thread(
        lambda: {name: (_read_prompt_direct(name) or default) for name, default in _DEFAULT_PROMPTS.items()}
    )
    return {"prompts": prompts}


@app.get("/prompts/{name}/fallback")
async def get_prompt_fallback(name: str, request: Request) -> Response:
    language = _validate_prompt_request(name, request.query_params.get("language"))
    template, source = await asyncio.to_thread(_fallback_prompt, name, language if name == "translate" else None)
    version = hashlib.sha256(template.encode("utf-8")).hexdigest()
    etag = f'"{version}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return JSONResponse(content={"template": template, "source": source, "version": version}, headers={"ETag": etag})


@app.get("/prompts/{name}")
async def get_prompt(name: str, request: Request) -> dict[str, object]:
    language = _validate_prompt_request(name, request.query_params.get("language"))
    template, _source = await asyncio.to_thread(
        _fallback_prompt, name, language if name == "translate" else None
    )
    result: dict[str, object] = {
        "name": name,
        "template": template,
        "version": hashlib.sha256(template.encode("utf-8")).hexdigest(),
        "has_language_param": "{language}" in template,
    }
    if language:
        result["language"] = language
    return result


if __name__ == "__main__":
    import uvicorn

    cfg = load_config()
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_config=None)

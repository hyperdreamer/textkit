"""FastAPI OCR backend using vision-capable AI chat models."""

from __future__ import annotations

import asyncio
import base64
import json
import os
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
import yaml
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel


CONFIG_PATH = Path(__file__).with_name("config.yaml")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_SAVE_ROOT = "~"
DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024
DEFAULT_MAX_TEXT_CHARS = 200_000


PROMPTS_DIR = Path(__file__).with_name("prompts")
_prompt_cache: dict[str, str] = {}

_DEFAULT_PROMPTS: dict[str, str] = {
    "ocr": "Transcribe all text visible in this image. Return only the transcription.",
    "dedup": (
        "Remove any duplicate or overlapping content. Return only the deduplicated text. "
        "Do not reword or change any text -- only remove exact duplicates and overlapping passages."
    ),
    "translate": "Translate the following text to {language}. Return only the translation.",
}


def _load_prompt(name: str) -> str:
    """Load a prompt from disk, falling back to the built-in default."""
    if name not in _prompt_cache:
        prompt_path = PROMPTS_DIR / f"{name}.txt"
        if prompt_path.is_file():
            _prompt_cache[name] = prompt_path.read_text(encoding="utf-8").strip()
        else:
            _prompt_cache[name] = _DEFAULT_PROMPTS.get(name, "")
    return _prompt_cache[name]


def _render_prompt(name: str, **kwargs: str) -> str:
    """Load a prompt and substitute template variables."""
    template = _load_prompt(name)
    try:
        return template.format(**kwargs)
    except KeyError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Prompt '{name}' references unknown variable: {e}",
        )


class OCRResponse(BaseModel):
    """Response body returned by the OCR endpoint."""

    text: str
    model: str
    tokens_used: int
    error: str | None = None


class DedupRequest(BaseModel):
    """Request body accepted by the dedup endpoint."""

    text: str


class TranslateRequest(BaseModel):
    """Request body accepted by the translate endpoint."""

    text: str
    language: str
    prompt: str | None = None


class FormatRequest(BaseModel):
    """Request body accepted by the format endpoint."""

    text: str
    prompt: str


class SaveRequest(BaseModel):
    """Request body accepted by the save endpoint."""

    text: str
    path: str


@dataclass(frozen=True)
class TimeoutConfig:
    """Per-phase HTTP timeouts for AI provider calls (all in seconds)."""

    connect: float = 10.0
    read: float = 600.0
    write: float = 60.0
    pool: float = 10.0


@dataclass(frozen=True)
class ProviderOverride:
    """Per-task model/API override.  Empty fields inherit from the parent AIConfig.

    When a field is left empty (the default), the parent ``AIConfig`` value is used.
    This lets you override the model or API endpoint for a specific task.
    """

    api_base: str = ""
    api_key: str = ""
    model: str = ""


@dataclass(frozen=True)
class AIConfig:
    """Settings needed to call an OpenAI-compatible chat completions API.

    ``model`` is the fallback used when a per-task override does not specify one.
    ``ocr`` and ``text`` are optional per-task :class:`ProviderOverride` sections.
    """

    api_base: str
    api_key: str
    model: str
    timeout: TimeoutConfig = TimeoutConfig()
    ocr: ProviderOverride | None = None
    text: ProviderOverride | None = None


@dataclass(frozen=True)
class AppConfig:
    """Application settings loaded from YAML and environment variables."""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    save_root: Path = Path(DEFAULT_SAVE_ROOT)
    max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES
    max_text_chars: int = DEFAULT_MAX_TEXT_CHARS
    debug: bool = False
    ai: AIConfig | None = None


def _debug(tag: str, msg: str, *, enabled: bool = False) -> None:
    """Print a timestamped debug message when *enabled* is True."""
    if not enabled:
        return
    import sys
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[DEBUG][{tag}] {ts} {msg}", file=sys.stderr, flush=True)


def _load_yaml_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    """Load config.yaml if it exists, otherwise return an empty configuration."""

    if not path.exists():
        return {}

    with path.open("r", encoding="utf-8") as config_file:
        loaded = yaml.safe_load(config_file) or {}

    if not isinstance(loaded, dict):
        raise RuntimeError("config.yaml must contain a YAML mapping at the top level")

    return loaded


def _read_api_key(ai_section: dict[str, Any]) -> str:
    """Resolve an API key from config.yaml — plaintext or environment variable.

    ``api_key_env`` names an environment variable to read the key from.
    ``api_key`` is treated as a plaintext value and returned as-is, unless it
    is prefixed with ``$`` (e.g. ``$OCR_API_KEY`` resolves
    ``os.getenv("OCR_API_KEY")``).

    When neither ``api_key`` nor ``api_key_env`` is configured, the function
    falls back to ``OCR_API_KEY`` and ``OPENAI_API_KEY``.
    """

    # ``api_key_env`` is always an environment variable name.
    env_ref = ai_section.get("api_key_env")
    if isinstance(env_ref, str) and env_ref:
        env_name = env_ref[1:] if env_ref.startswith("$") else env_ref
        api_key = os.getenv(env_name)
        if api_key:
            return api_key
        raise RuntimeError(f"API key not found in environment variable: {env_name}")

    raw = ai_section.get("api_key")
    if isinstance(raw, str) and raw:
        # Explicit $ prefix → resolve as environment variable
        if raw.startswith("$"):
            env_name = raw[1:]
            api_key = os.getenv(env_name)
            if api_key:
                return api_key
            raise RuntimeError(
                f"API key not found in environment variable: {env_name}"
            )
        # Plaintext key — use the value directly
        return raw

    # Neither api_key nor api_key_env configured → fall back to env vars
    candidates = ["OCR_API_KEY", "OPENAI_API_KEY"]

    for env_name in dict.fromkeys(candidates):
        api_key = os.getenv(env_name)
        if api_key:
            return api_key

    searched = ", ".join(dict.fromkeys(candidates))
    raise RuntimeError(f"API key not found. Set one of: {searched}")


def load_config() -> AppConfig:
    """Load application configuration from config.yaml with documented defaults."""

    raw_config = _load_yaml_config()
    ai_section = raw_config.get("ai") or {}
    if not isinstance(ai_section, dict):
        raise RuntimeError("AI provider configuration must be a YAML mapping")

    api_base = str(ai_section.get("api_base", "https://api.openai.com")).rstrip("/")
    model = str(ai_section.get("model", "gpt-4.1-mini"))

    def _parse_override(section: Any) -> ProviderOverride | None:
        """Parse an optional nested ``ocr`` / ``text`` config section.

        API keys are resolved eagerly here so that ``api_key_env``,
        ``$ENV_VAR`` references, and fallbacks all
        work correctly.  The resolved config stores the actual key.
        """
        if not isinstance(section, dict):
            return None
        has_key = bool(section.get("api_key") or section.get("api_key_env"))
        api_key = (
            _read_api_key(section) if has_key else ""
        )
        return ProviderOverride(
            api_base=str(section.get("api_base", "")).rstrip("/") or "",
            api_key=api_key,
            model=str(section.get("model", "")) or "",
        )

    ocr_override = _parse_override(ai_section.get("ocr"))
    text_override = _parse_override(ai_section.get("text"))

    # Optional timeout overrides
    timeout_raw = ai_section.get("timeout")
    timeout_section = timeout_raw if isinstance(timeout_raw, dict) else {}
    timeout = TimeoutConfig(
        connect=float(timeout_section.get("connect", 10.0)),
        read=float(timeout_section.get("read", 600.0)),
        write=float(timeout_section.get("write", 60.0)),
        pool=float(timeout_section.get("pool", 10.0)),
    )

    # Resolve API key now if available, otherwise store empty string.
    # Actual key requirement is enforced at request time.
    try:
        api_key = _read_api_key(ai_section)
    except RuntimeError:
        api_key = ""

    return AppConfig(
        host=str(raw_config.get("host", DEFAULT_HOST)),
        port=int(raw_config.get("port", DEFAULT_PORT)),
        save_root=Path(str(raw_config.get("save_root", DEFAULT_SAVE_ROOT))).expanduser(),
        max_upload_bytes=int(raw_config.get("max_upload_bytes", DEFAULT_MAX_UPLOAD_BYTES)),
        max_text_chars=int(raw_config.get("max_text_chars", DEFAULT_MAX_TEXT_CHARS)),
        debug=bool(raw_config.get("debug", False)),
        ai=AIConfig(
            api_base=api_base,
            api_key=api_key,
            model=model,
            timeout=timeout,
            ocr=ocr_override,
            text=text_override,
        ),
    )


def _resolve_ai_config(base: AIConfig, override: ProviderOverride | None) -> AIConfig:
    """Merge a per-task ``ProviderOverride`` into the base ``AIConfig``.

    Every field that is empty in *override* falls back to *base*.
    API keys in *override* are resolved through ``_read_api_key`` so
    ``$ENV_VAR`` references and fallbacks work.
    """
    if override is None:
        return base

    api_base = override.api_base or base.api_base
    model = override.model or base.model

    # API key was already resolved eagerly in _parse_override.
    # If the override provided a key, use it; otherwise inherit.
    api_key = override.api_key or base.api_key

    return AIConfig(
        api_base=api_base,
        api_key=api_key,
        model=model,
        timeout=base.timeout,
    )


def _validate_text_size(text: str, config: AppConfig) -> None:
    """Reject oversized text requests before sending them to costly model APIs."""

    if len(text) > config.max_text_chars:
        raise HTTPException(
            status_code=413,
            detail=f"Text exceeds configured limit of {config.max_text_chars} characters",
        )


async def _read_limited_upload(image: UploadFile, max_bytes: int) -> bytes:
    """Read an upload with a hard size limit to avoid unbounded memory use."""

    image_bytes = await image.read(max_bytes + 1)
    if len(image_bytes) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Image exceeds configured limit of {max_bytes} bytes",
        )
    return image_bytes


def _image_to_data_url(image_bytes: bytes, content_type: str | None) -> str:
    """Validate image bytes and encode them as a base64 data URL."""

    if not image_bytes:
        raise HTTPException(status_code=400, detail="Missing image data")

    try:
        image = Image.open(BytesIO(image_bytes))
        image.verify()
        inferred_format = (image.format or "").lower()
    except UnidentifiedImageError as exc:
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid image") from exc
    finally:
        try:
            image.close()
        except NameError:
            pass

    mime_type = content_type if content_type and content_type.startswith("image/") else None
    if not mime_type and inferred_format:
        mime_type = f"image/{'jpeg' if inferred_format == 'jpg' else inferred_format}"
    if not mime_type:
        mime_type = "application/octet-stream"

    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _extract_openai_text(payload: dict[str, Any]) -> str:
    """Extract OCR text from an OpenAI-compatible chat completion response."""

    choices = payload.get("choices") or []
    if not choices:
        return ""

    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "\n".join(
            part.get("text", "").strip()
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        ).strip()
    return ""


async def _call_with_retry(
    config: AIConfig,
    make_request: Any,
    provider_name: str,
) -> httpx.Response:
    """Call the AI provider with a hard asyncio deadline and one retry.

    The deadline is set slightly above ``config.timeout.read`` so the
    per-phase httpx timeouts fire first in normal cases.  If the proxy
    or network silently drops the connection, the hard deadline ensures
    the backend always returns a response instead of hanging forever.

    Only retries on connect errors (connection never established) to
    avoid sending the same image/text twice when the request body
    already reached the provider but the response was dropped.
    """
    deadline = config.timeout.read + 60

    last_exc: Exception | None = None
    for attempt in (1, 2):
        try:
            return await asyncio.wait_for(make_request(), timeout=deadline)
        except asyncio.TimeoutError:
            raise HTTPException(
                status_code=504,
                detail=f"{provider_name} API did not respond within {deadline}s",
            )
        except httpx.ConnectError as exc:
            last_exc = HTTPException(
                status_code=502,
                detail=f"{provider_name} API connection failed: {exc}",
            )
        except (httpx.RequestError) as exc:
            # Read/Write errors — do NOT retry, body may have been sent already
            raise HTTPException(
                status_code=502,
                detail=f"{provider_name} API request failed: {type(exc).__name__}: {exc}",
            ) from exc
        if attempt == 1:
            await asyncio.sleep(1)

    assert last_exc is not None
    raise last_exc


async def _post_openai_chat_completion(
    config: AIConfig,
    messages: list[dict[str, Any]],
) -> OCRResponse:
    """Send messages to an OpenAI-compatible /v1/chat/completions API."""

    if not config.api_key:
        raise HTTPException(
            status_code=500,
            detail="No API key configured. Set ai.api_key in config.yaml or the OCR_API_KEY environment variable.",
        )

    request_body = {
        "model": config.model,
        "messages": messages,
    }
    headers = {"Authorization": f"Bearer {config.api_key}"}

    async def _do_request() -> httpx.Response:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=config.timeout.connect,
                read=config.timeout.read,
                write=config.timeout.write,
                pool=config.timeout.pool,
            )
        ) as client:
            response = await client.post(
                f"{config.api_base}/v1/chat/completions",
                headers=headers,
                json=request_body,
            )
            if response.is_error:
                detail = response.text
                if len(detail) > 500:
                    detail = detail[:500] + "..."
                raise HTTPException(status_code=502, detail=f"OpenAI API failed: {detail}")
            return response

    response = await _call_with_retry(config, _do_request, "OpenAI")
    # Parse response body (covered by asyncio deadline + httpx read timeout)
    payload = _decode_provider_json(response, "OpenAI")
    _text = _extract_openai_text(payload)
    usage = payload.get("usage") or {}
    return OCRResponse(
        text=_text,
        model=str(payload.get("model") or config.model),
        tokens_used=int(usage.get("total_tokens") or 0),
    )


async def _call_openai(config: AIConfig, data_url: str) -> OCRResponse:
    """Send the image to an OpenAI-compatible /v1/chat/completions API."""

    return await _post_openai_chat_completion(
        config,
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _render_prompt("ocr")},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    )


def _decode_provider_json(response: httpx.Response, provider_name: str) -> dict[str, Any]:
    """Decode provider JSON without leaking tracebacks to API clients."""

    try:
        payload = response.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"{provider_name} API returned invalid JSON",
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502,
            detail=f"{provider_name} API returned an unexpected response shape",
        )
    return payload


async def transcribe_image(config: AIConfig, data_url: str) -> OCRResponse:
    """Route an OCR request to the configured provider."""

    cfg = _resolve_ai_config(config, config.ocr)
    return await _call_openai(cfg, data_url)


async def deduplicate_text(config: AIConfig, text: str) -> OCRResponse:
    """Route a deduplication request to the configured provider."""

    cfg = _resolve_ai_config(config, config.text)
    return await _post_openai_chat_completion(
        cfg,
        [
            {"role": "system", "content": _render_prompt("dedup")},
            {"role": "user", "content": text},
        ],
    )


async def translate_text(config: AIConfig, text: str, language: str, prompt: str | None = None) -> OCRResponse:
    """Route a translation request to the configured provider."""

    system_prompt = prompt or _render_prompt("translate", language=language)
    cfg = _resolve_ai_config(config, config.text)
    return await _post_openai_chat_completion(
        cfg,
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text},
        ],
    )


async def format_text(config: AIConfig, text: str, prompt: str) -> OCRResponse:
    """Route a format request to the configured provider.

    Uses the user-provided *prompt* directly as the system prompt.
    """

    cfg = _resolve_ai_config(config, config.text)
    return await _post_openai_chat_completion(
        cfg,
        [
            {"role": "system", "content": prompt},
            {"role": "user", "content": text},
        ],
    )


app = FastAPI(title="TextKit Backend")


def _error_payload(error: str) -> dict[str, str | int | None]:
    """Build the standard response shape for failed OCR requests."""

    return {"text": "", "model": "", "tokens_used": 0, "error": error}


@app.exception_handler(HTTPException)
async def http_error_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    """Return HTTP errors in the standard OCR response envelope."""

    return JSONResponse(status_code=exc.status_code, content=_error_payload(str(exc.detail)))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """Return request validation errors in the standard OCR response envelope."""

    return JSONResponse(status_code=400, content=_error_payload(str(exc)))


@app.exception_handler(Exception)
async def catch_all_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Catch-all: ensure the backend ALWAYS returns a response.
    
    Catches anything the route handlers or other exception handlers miss
    (e.g. MemoryError during large JSON parsing, serialization failures).
    Without this, an unhandled exception can leave uvicorn waiting for a
    response that never comes, causing the client to hang on "Translating...".
    """
    import traceback

    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content=_error_payload("Internal server error"),
    )


@app.post("/ocr", response_model=OCRResponse)
async def ocr(image: UploadFile | None = File(default=None)) -> OCRResponse:
    """Accept an image upload and return text transcribed by the configured AI model."""

    if image is None:
        raise HTTPException(status_code=400, detail='Missing required form file field "image"')

    try:
        config = load_config()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if config.ai is None:
        raise HTTPException(status_code=500, detail="AI provider configuration is missing")

    image_bytes = await _read_limited_upload(image, config.max_upload_bytes)
    _debug("ocr", f"request: {len(image_bytes)} bytes", enabled=config.debug)

    # Debug: save last screenshot for manual inspection
    try:
        Path("/tmp/last_screenshot.png").write_bytes(image_bytes)
    except OSError:
        pass

    data_url = _image_to_data_url(image_bytes, image.content_type)
    _debug("ocr", f"calling model={config.ai.model} ocr_model={config.ai.ocr.model if config.ai.ocr else '-'}", enabled=config.debug)
    result = await transcribe_image(config.ai, data_url)
    _debug("ocr", f"response: {len(result.text)} chars model={result.model}", enabled=config.debug)

    # Debug: save last OCR text (before dedup) for manual inspection
    try:
        Path("/tmp/last_ocr.txt").write_text(result.text, encoding="utf-8")
    except OSError:
        pass

    return result


@app.post("/dedup", response_model=None)
async def dedup(request: DedupRequest) -> Response:
    """Accept merged OCR text and return deduplicated text from the configured AI model."""

    try:
        config = load_config()
    except RuntimeError as exc:
        return JSONResponse(status_code=500, content=_error_payload(str(exc)))

    if config.ai is None:
        return JSONResponse(status_code=500, content=_error_payload("AI provider configuration is missing"))

    _validate_text_size(request.text, config)
    _debug("dedup", f"request: {len(request.text)} chars", enabled=config.debug)
    # Debug: save pre-dedup text for retry troubleshooting
    try:
        Path("/tmp/pre_dedup.txt").write_text(request.text, encoding="utf-8")
    except OSError:
        pass
    _debug("dedup", "calling provider...", enabled=config.debug)
    result = await deduplicate_text(config.ai, request.text)
    _debug("dedup", f"AI returned {len(result.text)} chars model={result.model}", enabled=config.debug)
    # Debug: save post-dedup text for quick comparison
    try:
        Path("/tmp/after_dedup.txt").write_text(result.text, encoding="utf-8")
    except OSError:
        pass
    body = {"text": result.text, "model": result.model, "tokens_used": result.tokens_used}
    body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
    _debug("dedup", f"sending {len(body_bytes)} byte response", enabled=config.debug)
    return Response(
        content=body_bytes,
        media_type="application/json",
        headers={"Connection": "close"},
    )


@app.post("/translate", response_model=None)
async def translate(request: TranslateRequest) -> Response:
    """Accept text and return a translation from the configured AI model."""

    try:
        config = load_config()
    except RuntimeError as exc:
        return JSONResponse(status_code=500, content=_error_payload(str(exc)))

    if config.ai is None:
        return JSONResponse(status_code=500, content=_error_payload("AI provider configuration is missing"))

    _validate_text_size(request.text, config)
    _debug("translate", f"request: {len(request.text)} chars lang={request.language}", enabled=config.debug)
    _debug("translate", "calling provider...", enabled=config.debug)
    result = await translate_text(config.ai, request.text, request.language, request.prompt)
    _debug("translate", f"AI returned {len(result.text)} chars model={result.model}", enabled=config.debug)
    body = {"text": result.text, "model": result.model, "tokens_used": result.tokens_used}
    body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
    _debug("translate", f"sending {len(body_bytes)} byte response", enabled=config.debug)
    return Response(
        content=body_bytes,
        media_type="application/json",
        headers={"Connection": "close"},
    )


@app.post("/format", response_model=None)
async def format_text_endpoint(request: FormatRequest) -> Response:
    """Accept text and a custom prompt, return formatted text from the configured AI model."""

    try:
        config = load_config()
    except RuntimeError as exc:
        return JSONResponse(status_code=500, content=_error_payload(str(exc)))

    if config.ai is None:
        return JSONResponse(status_code=500, content=_error_payload("AI provider configuration is missing"))

    _validate_text_size(request.text, config)
    _debug("format", f"request: {len(request.text)} chars prompt_len={len(request.prompt)}", enabled=config.debug)
    _debug("format", "calling provider...", enabled=config.debug)
    result = await format_text(config.ai, request.text, request.prompt)
    _debug("format", f"AI returned {len(result.text)} chars model={result.model}", enabled=config.debug)
    body = {"text": result.text, "model": result.model, "tokens_used": result.tokens_used}
    body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
    _debug("format", f"sending {len(body_bytes)} byte response", enabled=config.debug)
    return Response(
        content=body_bytes,
        media_type="application/json",
        headers={"Connection": "close"},
    )


@app.post("/save")
async def save_text(request: SaveRequest) -> dict[str, str | bool]:
    """Write text to a local path on the backend machine."""

    try:
        config = load_config()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    raw_path = request.path.strip()
    if not raw_path:
        raise HTTPException(status_code=400, detail="Missing save path")

    _validate_text_size(request.text, config)
    save_root_expanded = config.save_root.expanduser()
    save_root = save_root_expanded.resolve()
    candidate = Path(raw_path).expanduser()
    path = candidate if candidate.is_absolute() else save_root_expanded / candidate

    # Guard: collapse .. (prevents traversal) without resolving symlinks (allows ~/Ramdisk)
    clean = Path(os.path.normpath(str(path)))
    try:
        clean.relative_to(save_root_expanded)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Save path must stay under configured save_root: {save_root}",
        ) from exc

    path = path.resolve()

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(request.text, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save text: {exc.strerror or exc}") from exc
    return {"ok": True, "path": str(path)}


@app.get("/prompts")
async def list_prompts() -> dict[str, dict[str, str]]:
    """Return all available prompt templates."""
    prompts: dict[str, str] = {}
    if PROMPTS_DIR.is_dir():
        for entry in sorted(PROMPTS_DIR.iterdir()):
            if entry.suffix == ".txt":
                name = entry.stem
                prompts[name] = _load_prompt(name)
    for name, default in _DEFAULT_PROMPTS.items():
        prompts.setdefault(name, default)
    return {"prompts": prompts}


@app.get("/prompts/{name}")
async def get_prompt(name: str) -> dict[str, object]:
    """Return a specific prompt template."""
    if name not in _DEFAULT_PROMPTS:
        raise HTTPException(status_code=404, detail=f"Unknown prompt: '{name}'")
    template = _load_prompt(name)
    return {
        "name": name,
        "template": template,
        "has_language_param": "{language}" in template,
    }

if __name__ == "__main__":
    import uvicorn

    cfg = load_config()
    uvicorn.run(app, host=cfg.host, port=cfg.port)

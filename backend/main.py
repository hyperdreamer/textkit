"""FastAPI OCR backend using vision-capable AI chat models."""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
import yaml
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel


CONFIG_PATH = Path(__file__).with_name("config.yaml")
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8765
OCR_PROMPT = "Transcribe all text visible in this image. Return only the transcription."
DEDUP_PROMPT = (
    "Remove any duplicate or overlapping content. Return only the deduplicated text. "
    "Do not reword or change any text -- only remove exact duplicates and overlapping passages."
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


@dataclass(frozen=True)
class AIConfig:
    """Settings needed to call a configured AI provider."""

    provider: str
    api_base: str
    api_key: str
    model: str


@dataclass(frozen=True)
class AppConfig:
    """Application settings loaded from YAML and environment variables."""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    ai: AIConfig | None = None


def _load_yaml_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    """Load config.yaml if it exists, otherwise return an empty configuration."""

    if not path.exists():
        return {}

    with path.open("r", encoding="utf-8") as config_file:
        loaded = yaml.safe_load(config_file) or {}

    if not isinstance(loaded, dict):
        raise RuntimeError("config.yaml must contain a YAML mapping at the top level")

    return loaded


def _read_api_key(ai_section: dict[str, Any], provider: str) -> str:
    """Resolve an API key from config.yaml — plaintext or environment variable.

    By default ``api_key`` is treated as a plaintext value and returned as-is.
    Prefix the value with ``$`` to treat it as an environment variable name
    (e.g. ``$OCR_API_KEY`` resolves ``os.getenv("OCR_API_KEY")``).

    When neither ``api_key`` nor ``api_key_env`` is configured, the function
    falls back to ``OCR_API_KEY`` and provider-specific environment variables.
    """

    raw = ai_section.get("api_key_env") or ai_section.get("api_key")
    if isinstance(raw, str) and raw:
        # Explicit $ prefix → resolve as environment variable
        if raw.startswith("$"):
            env_name = raw.lstrip("$")
            api_key = os.getenv(env_name)
            if api_key:
                return api_key
            raise RuntimeError(
                f"API key not found in environment variable: {env_name}"
            )
        # Plaintext key — use the value directly
        return raw

    # Neither api_key nor api_key_env configured → fall back to env vars
    candidates = ["OCR_API_KEY"]
    if provider == "openai":
        candidates.append("OPENAI_API_KEY")
    elif provider == "anthropic":
        candidates.append("ANTHROPIC_API_KEY")

    for env_name in dict.fromkeys(candidates):
        api_key = os.getenv(env_name)
        if api_key:
            return api_key

    searched = ", ".join(dict.fromkeys(candidates))
    raise RuntimeError(f"API key not found. Set one of: {searched}")


def load_config() -> AppConfig:
    """Load application configuration from config.yaml with documented defaults."""

    raw_config = _load_yaml_config()
    ai_section = raw_config.get("ai") or raw_config.get("provider") or {}
    if not isinstance(ai_section, dict):
        raise RuntimeError("AI provider configuration must be a YAML mapping")

    provider = str(ai_section.get("provider", "openai")).lower()
    api_base = str(ai_section.get("api_base", "https://api.openai.com")).rstrip("/")
    model = str(ai_section.get("model", "gpt-4.1-mini"))

    # Lazy: resolve API key now if available, otherwise store empty string.
    # Actual key requirement is enforced at request time in _call_openai / _call_anthropic.
    try:
        api_key = _read_api_key(ai_section, provider) if provider in {"openai", "anthropic"} else ""
    except RuntimeError:
        api_key = ""

    return AppConfig(
        host=str(raw_config.get("host", DEFAULT_HOST)),
        port=int(raw_config.get("port", DEFAULT_PORT)),
        ai=AIConfig(
            provider=provider,
            api_base=api_base,
            api_key=api_key,
            model=model,
        ),
    )


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


def _extract_anthropic_text(payload: dict[str, Any]) -> str:
    """Extract OCR text from an Anthropic messages response."""

    content = payload.get("content") or []
    return "\n".join(
        block.get("text", "").strip()
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    ).strip()


async def _post_openai_chat_completion(config: AIConfig, messages: list[dict[str, Any]]) -> OCRResponse:
    """Send messages to an OpenAI-compatible /v1/chat/completions API."""

    request_body = {
        "model": config.model,
        "messages": messages,
    }
    headers = {"Authorization": f"Bearer {config.api_key}"}

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=600.0, write=60.0, pool=10.0)
        ) as client:
            response = await client.post(
                f"{config.api_base}/v1/chat/completions",
                headers=headers,
                json=request_body,
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=502,
            detail="OpenAI API timed out — the text may be too long for the model to process in time",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"OpenAI API request failed: {type(exc).__name__}: {exc}") from exc

    if response.is_error:
        raise HTTPException(status_code=502, detail=f"OpenAI API failed: {response.text}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="OpenAI API returned invalid JSON") from exc

    usage = payload.get("usage") or {}
    return OCRResponse(
        text=_extract_openai_text(payload),
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
                    {"type": "text", "text": OCR_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    )


def _anthropic_image_source(data_url: str) -> dict[str, str]:
    """Convert a data URL into Anthropic's base64 image source shape."""

    header, encoded = data_url.split(",", 1)
    media_type = header.removeprefix("data:").removesuffix(";base64")
    return {"type": "base64", "media_type": media_type, "data": encoded}


async def _post_anthropic_message(config: AIConfig, messages: list[dict[str, Any]]) -> OCRResponse:
    """Send messages to Anthropic's /v1/messages API."""

    request_body = {
        "model": config.model,
        "max_tokens": 4096,
        "messages": messages,
    }
    headers = {
        "x-api-key": config.api_key,
        "anthropic-version": "2023-06-01",
    }

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=600.0, write=60.0, pool=10.0)
        ) as client:
            response = await client.post(
                f"{config.api_base}/v1/messages",
                headers=headers,
                json=request_body,
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=502,
            detail="Anthropic API timed out — the text may be too long for the model to process in time",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Anthropic API request failed: {exc}") from exc

    if response.is_error:
        raise HTTPException(status_code=502, detail=f"Anthropic API failed: {response.text}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Anthropic API returned invalid JSON") from exc

    usage = payload.get("usage") or {}
    tokens_used = int(usage.get("input_tokens") or 0) + int(usage.get("output_tokens") or 0)
    return OCRResponse(
        text=_extract_anthropic_text(payload),
        model=str(payload.get("model") or config.model),
        tokens_used=tokens_used,
    )


async def _call_anthropic(config: AIConfig, data_url: str) -> OCRResponse:
    """Send the image to Anthropic's /v1/messages API."""

    return await _post_anthropic_message(
        config,
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": OCR_PROMPT},
                    {"type": "image", "source": _anthropic_image_source(data_url)},
                ],
            }
        ],
    )


async def transcribe_image(config: AIConfig, data_url: str) -> OCRResponse:
    """Route an OCR request to the configured provider."""

    if config.provider == "openai":
        return await _call_openai(config, data_url)
    if config.provider == "anthropic":
        return await _call_anthropic(config, data_url)

    raise HTTPException(status_code=400, detail=f"Unsupported AI provider: {config.provider}")


async def deduplicate_text(config: AIConfig, text: str) -> OCRResponse:
    """Route a deduplication request to the configured provider."""

    if config.provider == "openai":
        return await _post_openai_chat_completion(
            config,
            [
                {"role": "system", "content": DEDUP_PROMPT},
                {"role": "user", "content": text},
            ],
        )
    if config.provider == "anthropic":
        return await _post_anthropic_message(
            config,
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": DEDUP_PROMPT},
                        {"type": "text", "text": text},
                    ],
                }
            ],
        )

    raise HTTPException(status_code=400, detail=f"Unsupported AI provider: {config.provider}")


async def translate_text(config: AIConfig, text: str, language: str, prompt: str | None = None) -> OCRResponse:
    """Route a translation request to the configured provider."""

    system_prompt = prompt or f"Translate the following text to {language}. Return only the translation."

    if config.provider == "openai":
        return await _post_openai_chat_completion(
            config,
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
        )
    if config.provider == "anthropic":
        return await _post_anthropic_message(
            config,
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": system_prompt},
                        {"type": "text", "text": text},
                    ],
                }
            ],
        )

    raise HTTPException(status_code=400, detail=f"Unsupported AI provider: {config.provider}")


app = FastAPI(title="Qidian OCR Backend")


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

    image_bytes = await image.read()
    data_url = _image_to_data_url(image_bytes, image.content_type)
    return await transcribe_image(config.ai, data_url)


@app.post("/dedup", response_model=OCRResponse)
async def dedup(request: DedupRequest) -> OCRResponse:
    """Accept merged OCR text and return deduplicated text from the configured AI model."""

    try:
        config = load_config()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if config.ai is None:
        raise HTTPException(status_code=500, detail="AI provider configuration is missing")

    return await deduplicate_text(config.ai, request.text)


@app.post("/translate", response_model=OCRResponse)
async def translate(request: TranslateRequest) -> OCRResponse:
    """Accept text and return a translation from the configured AI model."""

    try:
        config = load_config()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    if config.ai is None:
        raise HTTPException(status_code=500, detail="AI provider configuration is missing")

    return await translate_text(config.ai, request.text, request.language, request.prompt)


if __name__ == "__main__":
    import uvicorn

    cfg = load_config()
    uvicorn.run(app, host=cfg.host, port=cfg.port)

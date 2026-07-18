# TextKit

TextKit is a text capture and processing tool for reading long web pages through a browser extension and an AI-backed FastAPI service. The Chromium Manifest V3 extension lets you select a fixed region of the current page, capture that region page-by-page while scrolling, merge overlapping OCR fragments, optionally translate or format the result, and copy, download, or save the final text.

The backend is provider-neutral: it calls OpenAI-compatible chat completion APIs, configured through `backend/config.yaml`.

## Architecture

The project has two parts:

- `backend/`: a Python FastAPI server that exposes OCR, deduplication, translation, format, and read-only prompt-preview endpoints. It validates uploaded images, sends requests to the configured AI provider, and returns endpoint-specific JSON responses. File saving and path suggestions are provided by a separate localhost file-bridge service.
- `extension/`: a Chromium Manifest V3 extension that runs a popup, background service worker, and page content script. The content script draws the capture overlay and scrolls the page. The background service worker captures screenshots, crops the selected region, calls the backend, merges fragments, retries failed work, and stores the last region/result.

Typical flow:

1. Start the backend locally.
2. Load the extension in Chrome or another Chromium browser.
3. Press `Ctrl+Shift+S` or click `Select Region` in the popup.
4. Draw or adjust the capture region and press `Ctrl+Space`.
5. The extension captures the selected region, sends each page image to `POST /ocr`, merges fragments, sends merged text to `POST /dedup`, optionally sends the result to `POST /translate`, optionally formats the configured OCR or Translation source via `POST /format`, and stores the results per tab.

The popup has four tabs:

- **OCR** — capture controls, progress, raw result, copy/download.
- **Translation** — translate OCR result to a target language, with auto-copy/auto-save/auto-translate.
- **Format** — format the translated text with a custom AI prompt, with auto-copy/auto-save/auto-format.
- **Prompts** — edit extension-local OCR, Dedup, Translation, and Format overrides in a compact accordion, with server-default previews.

## Quick Start

### Backend

```sh
cd backend
cp config.example.yaml config.yaml
```

Edit `config.yaml` for your provider, model, and API key.

The backend supports Python 3.10 through Python 3.14.

```sh
export OCR_API_KEY="your-api-key"
pip install --require-hashes -r requirements.lock
python main.py
```

By default, the server binds to `127.0.0.1:8765`. Keep the loopback bind unless the service is placed behind an authenticated TLS reverse proxy with equivalent shared rate limits.

### Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `extension/` directory.
5. Open the extension popup and confirm the backend host and port, usually `localhost` and `8765`.

## Backend API

The backend is implemented in `backend/main.py` and serves a FastAPI app named `TextKit Backend`.

The four AI endpoints (`/ocr`, `/dedup`, `/translate`, and `/format`) return the core result fields:

```json
{
  "text": "result text",
  "model": "provider-model-name",
  "tokens_used": 123
}
```

`/translate` adds `skipped`, `detected_language`, and `skip_reason` when language detection bypasses the provider. Errors from the AI endpoints use `{"text":"","model":"","tokens_used":0,"error":"..."}`. Utility and prompt endpoints use the shapes documented in their sections below.

The backend is fully usable as a standalone API — you can call any endpoint directly with `curl` or any HTTP client without the extension.

### `POST /ocr`

Transcribes text from an image using a vision-capable AI model.

**Request:** multipart form data with fields:
- `image` (file, required) — the image to transcribe.
- `prompt` (string, optional) — custom system prompt that overrides the default OCR prompt.

```sh
curl -X POST "http://localhost:8765/ocr" \
  -F "image=@page.png"

# With custom prompt
curl -X POST "http://localhost:8765/ocr" \
  -F "image=@page.png" \
  -F "prompt=Transcribe all visible Japanese text"
```

The backend validates and fully decodes the image with Pillow, rejects corrupt or truncated PNGs, derives the MIME type from the decoded bytes rather than the multipart claim, encodes it as a data URL, and sends it to the configured AI model.

### `POST /dedup`

Removes duplicate or overlapping content from merged OCR text.

**Request:** JSON body with fields:
- `text` (string, required) — the text to deduplicate.
- `prompt` (string, optional) — custom system prompt that overrides the default dedup prompt.

```sh
curl -X POST "http://localhost:8765/dedup" \
  -H "Content-Type: application/json" \
  -d '{"text":"first page\nfirst page\nsecond page"}'

# With custom prompt
curl -X POST "http://localhost:8765/dedup" \
  -H "Content-Type: application/json" \
  -d '{"text":"...","prompt":"Remove duplicates and fix OCR errors"}'
```

### `POST /translate`

Translates text to a target language.

**Request:** JSON body with fields:
- `text` (string, required) — the text to translate.
- `language` (string, required) — target language, e.g. `"Chinese"`, `"English"`.
- `prompt` (string, optional) — custom system prompt that overrides the default translation prompt. The backend uses custom prompts verbatim; the extension replaces `{language}` with the selected language before sending one.

```sh
curl -X POST "http://localhost:8765/translate" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world","language":"Chinese"}'
```

To save tokens and latency, the endpoint short-circuits the AI call when the input is already in the target language. Detection uses `langdetect` with a 20-character minimum and a fixed seed; the gate is bypassed whenever a custom `prompt` is provided. When the AI is skipped, the response includes:

- `skipped` (boolean) — `true` when the AI was bypassed.
- `detected_language` (string|null) — ISO 639-1 code.
- `skip_reason` (string) — `"original_target"` or `"same_language"`.

### `POST /format`

Formats text using a user-provided custom AI prompt. Designed to run on the *output* of translation (or any text).

**Request:** JSON body with fields:
- `text` (string, required) — the text to format.
- `prompt` (string, optional) — custom system prompt that overrides the default format prompt. When omitted, the backend uses `backend/prompts/format.txt` when present, otherwise its nonempty built-in readability prompt. Examples: `"Convert to ALL CAPS"`, `"Reformat as clean Markdown with headings and bullet points"`, `"Summarise this text in 3 bullet points"`.

```sh
curl -X POST "http://localhost:8765/format" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world this is a test","prompt":"Convert this text to ALL CAPS. Return only the converted text."}'
```

Uses the same AI text provider as `/translate` and `/dedup` (`config.text` override if configured).

### Three-tier prompt precedence

Every AI endpoint (`/ocr`, `/dedup`, `/translate`, `/format`) accepts an optional `prompt` field. The effective prompt is selected in this order:

1. **Plugin prompt** — a nonempty custom prompt sent with the request. The extension stores these overrides only in `chrome.storage.local`.
2. **Backend file** — `backend/prompts/{name}.txt`, or `translate.{Language}.txt` before the base translate file.
3. **Hardcoded failsafe** — the matching entry in `_DEFAULT_PROMPTS` when no prompt file exists.

The extension never writes canonical backend prompt files. Its Prompts tab leaves an empty editor empty, shows the server fallback separately, and sends a prompt only after the user enters an explicit override. **Reset to server default** removes that override.

### `GET /prompts`

Returns exactly the four canonical AI prompt templates (`ocr`, `dedup`, `translate`, and `format`) as JSON. Language-specific translation files are selected through the language-aware prompt endpoints and are not exposed as extra keys such as `translate.English`.

Response shape: `{"prompts": {"ocr": "...", "dedup": "...", "translate": "...", "format": "..."}}`.

```sh
curl "http://localhost:8765/prompts"
```

### `GET /prompts/{name}/fallback`

Returns the prompt the server would use if no custom prompt were supplied. The response includes the source tier and a SHA-256 version used by the extension's preview cache:

```json
{"template":"...","source":"file","version":"<sha256>"}
```

Translation fallbacks accept a language selector:

```sh
curl "http://localhost:8765/prompts/translate/fallback?language=French"
```

`source` is `file` for a language-specific or base prompt file and `hardcoded` for `_DEFAULT_PROMPTS`.

### `GET /prompts/{name}`

Returns the stored or hardcoded prompt template for a given prompt name (`ocr`, `dedup`, `translate`, or `format`). The `translate` prompt supports per-language variants via the `?language=` query parameter (e.g. `?language=French`).

```sh
# Read
curl "http://localhost:8765/prompts/translate"

# Read per-language
curl "http://localhost:8765/prompts/translate?language=French"
```

Prompt templates are edited directly on disk in `backend/prompts/*.txt`. There is no write API — open the file in a text editor, save it, and the backend picks up changes on the next request.

### Configuration

Create `backend/config.yaml` from the included template:

```sh
cd backend
cp config.example.yaml config.yaml
```

Example:

```yaml
host: "127.0.0.1"
port: 8765

# Request limits — set to 0 to disable.
max_upload_bytes: 15728640
max_image_pixels: 40000000
max_text_chars: 200000
max_prompt_chars: 20000
max_request_body_bytes: 2097152
requests_per_minute: 60
max_concurrent_requests: 4

ai:
  api_base: "https://api.openai.com"
  api_key: "$OCR_API_KEY"
  model: "gpt-4.1-mini"

  # Optional per-task overrides:
  # ocr:
  #   model: "gpt-4.1"
  # text:
  #   model: "gpt-4.1-mini"
```

Supported `ai` fields:

- `api_base`: base provider URL without a trailing slash. Must expose `/v1/chat/completions`. Non-loopback providers must use HTTPS.
- `api_key`: the API key. Plaintext values are used directly. Prefix with `$` to treat the value as an environment variable name (e.g. `$OCR_API_KEY`). `api_key_env` is also accepted.
- `model`: the model name to send to the provider. Fallback model used for all operations unless per-task overrides are set.
- `ocr` (optional): nested section to override model/endpoint for vision (OCR) requests. Fields: `api_base`, `api_key`, `model`. Empty fields inherit from the parent `ai` section.
- `text` (optional): nested section to override model/endpoint for text processing (dedup, translation, and format). Same fields as `ocr`.

The backend falls back to these environment variable names:

- `OCR_API_KEY`
- `OPENAI_API_KEY`

API key loading is lazy. The app can start without an API key in the environment; missing credentials are reported when an endpoint tries to call the configured provider.

### Launching

```sh
cd backend
python main.py
```

`main.py` reads `config.yaml` and starts Uvicorn with the configured `host` and `port`.

`GET /healthz` returns `{"status":"ok"}` for local health checks. Logs are emitted as structured JSON.

## Extension

The extension lives in `extension/` and uses Manifest V3.

Main files:

- `manifest.json`: extension metadata, permissions, host access, and keyboard command. The page content script and overlay CSS are injected on demand with `chrome.scripting`.
- `popup.html` and `popup.js`: popup UI with four tabs (OCR, Translation, Format, Prompts) for status, backend settings, language selection, custom prompts, and output actions.
- `background.js`: capture orchestration, backend calls, fragment merging, retry state, and persistence.
- `content.js`: selection overlay, saved-region editing, viewport reporting, and page scrolling.
- `overlay.css`: region selection overlay styling.

Backend and file-bridge host/port are stored in Chrome sync storage. The file-bridge is a separate localhost service; a blank host defaults to `localhost` with the configured file-bridge port.

### Popup tabs

| Tab | Purpose |
|-----|---------|
| **OCR** | Start/stop capture, view status/progress, copy/download OCR result. |
| **Translation** | Translate OCR result to a target language. Auto-copy, auto-save (with save path), and auto-translate checkboxes. |
| **Format** | Format text with a custom AI prompt. Choose source (OCR or Translation), auto-copy, auto-save (with dedicated save path), and auto-format checkboxes. Auto-format fires when the selected source completes. |
| **Prompts** | Edit extension-local OCR, Dedup, per-language Translation, and Format overrides in a one-at-a-time accordion. Empty editors show the server fallback without copying it into the custom value. |

### Capture controls

- Press `Ctrl+Shift+S` to open the region selection overlay. On macOS, the manifest suggests `Command+Shift+S`.
- Click `Select Region` in the popup to start the same selection flow.
- Drag on the page to draw the region.
- If a region was previously saved, it is pre-drawn when selection starts.
- The saved region has 8 resize handles: corners, edges, and side midpoints.
- Drag inside the saved region to reposition it.
- Press `Ctrl+Space` to confirm the selected region.
- Press `Esc` to cancel selection.

### Auto-scroll and page capture

- **Auto-scroll enabled:** the extension captures the selected region, scrolls down by about one viewport with overlap, captures again, and repeats until the page stops scrolling.
- **Auto-scroll disabled:** the extension captures only the current viewport region once.

During capture, the popup shows status, current page, fragment count, and progress. The Stop button requests capture to stop and preserves fragments already collected as a result marked `Partial`; partial results do not trigger automatic translation or formatting. Navigating the capture tab to another URL also stops capture as partial before content from the new document can be accepted.

### OCR, deduplication, translation, and formatting

For each captured page region, the extension:

1. Captures the visible tab.
2. Crops the selected region in an `OffscreenCanvas`.
3. Sends the cropped PNG to `POST /ocr`.
4. Stores the returned text as a fragment.
5. Merges fragments locally using line-overlap detection.
6. Sends the merged text to `POST /dedup`.
7. If a language other than `Original` is selected, sends the deduplicated text to `POST /translate`.
8. If auto-format is enabled, sends the selected source (Translation or OCR Result) to `POST /format`, using the extension override when set or the server fallback otherwise.

The popup language dropdown supports `Original`, `Chinese`, `English`, `Japanese`, `Korean`, `French`, `German`, and `Spanish`. Choosing `Original` skips translation.

### Retry behavior

OCR and deduplication provider failures retry indefinitely in the background, preserving collected fragments, until the user presses Stop. There is intentionally no retry limit for either stage.

The Retry button is reserved for a resumable error state that was persisted across a worker restart or for a later-stage retry state. Pressing Stop during an OCR/dedup retry finalizes the text collected so far; a translation failure leaves the OCR result available for another translation attempt.

### Output actions

Every result panel (OCR, Translation, Format) supports:

- **Copy** — copies the text to the clipboard and reports clipboard permission or fallback failures in the panel status.
- **Download** — saves the text as a `.txt` file (named `textkit-*.txt`, `translate-*.txt`, or `format-*.txt`) and reports browser download failures.
- **Save** — writes the text through the separate localhost file-bridge service, using the tab's save path.

### Settings and persistence

Settings persisted to Chrome sync storage:

- Backend host and port.
- File-bridge host and port. A blank host uses `localhost` with the configured file-bridge port (default `8766`), independently of the main backend settings.
- Auto-scroll on/off.
- Translation auto-copy, auto-save, auto-translate toggles and save path.
- Format auto-copy, auto-save, auto-format toggles, save path, and source selector (Translation or OCR Result).

Settings persisted to Chrome local storage:

- Last region size and position.
- Target language.
- Per-tab: OCR result, translation result, format result, status messages.
- OCR prompt and dedup prompt (extension-local user overrides).
- Format prompt (extension-local user override).
- Translation prompts (extension-local, per-language user overrides).
- Cached server fallback previews and their SHA-256 versions.
- Save path autocomplete — queried in real time from file-bridge (with local history fallback).
- Bounded, versioned checkpoints for active MV3 capture/translate/format operations so a restarted service worker can resume safely.

High-frequency text and path edits are debounced and flushed on blur/change to avoid exhausting Chrome storage write quotas.

## Development Notes

Install backend dependencies with:

```sh
cd backend
pip install --require-hashes -r requirements-dev.lock
```

The backend dependencies are:

- `fastapi`
- `uvicorn`
- `python-multipart`
- `httpx`
- `pyyaml`
- `pillow`
- `langdetect`
- `pytest`
- `httpx2` (for Starlette's test client)

The extension does not require a build step. Load the `extension/` folder directly as an unpacked extension.

### Tests

Run tests from the repository root:

```sh
python -m pytest tests/ -v
node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js
node tests/extension_e2e.test.js
```

## Troubleshooting

### Backend starts but requests fail with an API key error

Confirm that `backend/config.yaml` points to the correct API key or environment variable name and that the variable is exported in the shell running `python main.py`.

```sh
export OCR_API_KEY="your-api-key"
```

### Extension cannot reach the backend

Check the popup Host and Port fields. For the default backend config, use:

- Host: `localhost`
- Port: `8765`

Also confirm that the backend is running and listening on the configured port.

### Region selection does not open

Refresh the target page and try again. Some browser-internal pages and restricted pages do not allow content scripts or tab capture.

### Capture stops early

Make sure Auto-scroll is enabled if you want full-page capture. With Auto-scroll disabled, only the current viewport region is captured.

### Translation does not run automatically

Select a language other than `Original` before starting capture. You can also use the `Translate` button after OCR completes.

### Format does not run automatically

Make sure **Auto-format** is checked on the Format tab. Auto-format runs after the selected source completes and uses the custom Format prompt when present, otherwise the server fallback.

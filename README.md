# TextKit

TextKit is a text capture and processing tool for reading long web pages through a browser extension and an AI-backed FastAPI service. The Chromium Manifest V3 extension lets you select a fixed region of the current page, capture that region page-by-page while scrolling, merge overlapping OCR fragments, optionally translate and format the result, and copy or download the final text.

The backend is provider-neutral: it calls OpenAI-compatible chat completion APIs, configured through `backend/config.yaml`.

## Architecture

The project has two parts:

- `backend/`: a Python FastAPI server that exposes OCR, deduplication, translation, format, and save endpoints. It validates uploaded images, sends requests to the configured AI provider, and returns a consistent JSON response.
- `extension/`: a Chromium Manifest V3 extension that runs a popup, background service worker, and page content script. The content script draws the capture overlay and scrolls the page. The background service worker captures screenshots, crops the selected region, calls the backend, merges fragments, retries failed work, and stores the last region/result.

Typical flow:

1. Start the backend locally.
2. Load the extension in Chrome or another Chromium browser.
3. Press `Ctrl+Shift+S` or click `Select Region` in the popup.
4. Draw or adjust the capture region and press `Ctrl+Space`.
5. The extension captures the selected region, sends each page image to `POST /ocr`, merges fragments, sends merged text to `POST /dedup`, optionally sends the result to `POST /translate`, optionally formats the translation via `POST /format`, and stores the final text.

The popup has four tabs:

- **OCR** — capture controls, progress, raw result, copy/download.
- **Translation** — translate OCR result to a target language, with auto-copy/auto-save/auto-translate.
- **Format** — format the translated text with a custom AI prompt, with auto-copy/auto-save/auto-format.
- **Prompts** — configure the custom AI prompts used by OCR, Dedup, Translation, and Format.

## Quick Start

### Backend

```sh
cd backend
cp config.example.yaml config.yaml
```

Edit `config.yaml` for your provider, model, and API key.

```sh
export OCR_API_KEY="your-api-key"
pip install -r requirements.txt
python main.py
```

By default, the server binds to `127.0.0.1:8765`. Change `host` in `config.yaml` to `0.0.0.0` to listen on all interfaces.

### Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `extension/` directory.
5. Open the extension popup and confirm the backend host and port, usually `localhost` and `8765`.

## Backend API

The backend is implemented in `backend/main.py` and serves a FastAPI app named `TextKit Backend`.

All endpoints return the same JSON response shape:

```json
{
  "text": "result text",
  "model": "provider-model-name",
  "tokens_used": 123,
  "error": null
}
```

On errors, the response uses the same envelope with an empty `text`, empty `model`, `tokens_used: 0`, and an `error` message.

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

The backend validates the image with Pillow, encodes it as a data URL, and sends it to the configured AI model.

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
- `prompt` (string, optional) — custom system prompt that overrides the default translation prompt. When provided, the `{language}` template variable is ignored.

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
- `prompt` (string, required) — the system prompt sent to the AI model. Describes how to transform the text. Examples: `"Convert to ALL CAPS"`, `"Reformat as clean Markdown with headings and bullet points"`, `"Summarise this text in 3 bullet points"`.

```sh
curl -X POST "http://localhost:8765/format" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world this is a test","prompt":"Convert this text to ALL CAPS. Return only the converted text."}'
```

Uses the same AI text provider as `/translate` and `/dedup` (`config.text` override if configured).

### `POST /save`

Writes text to a local file on the backend machine.

**Request:** JSON body with fields:
- `text` (string, required) — the text to save.
- `path` (string, required) — file path relative to the configured `save_root`.

```sh
curl -X POST "http://localhost:8765/save" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world","path":"ocr/output.txt"}'
```

### `GET /paths`

Returns filesystem paths under `save_root` matching a prefix, for autocomplete in the extension's save path fields.

**Query parameters:**
- `prefix` (string, optional) — path prefix to filter by. Supports `~` for home directory expansion.

```sh
# List everything under save_root
curl "http://localhost:8765/paths"

# Filter by prefix
curl "http://localhost:8765/paths?prefix=ocr/"

# Use ~ to browse the home directory
curl "http://localhost:8765/paths?prefix=~/Documents"
```

Returns `{"paths": ["ocr/output.txt", "ocr/notes.md", ...]}`. Directories have a trailing `/`. Results are capped at 30 entries.

### Prompts: shared defaults vs per-request overrides

Every AI endpoint (`/ocr`, `/dedup`, `/translate`) accepts an **optional** `prompt` field. This gives you two usage patterns that coexist without conflict:

**Shared prompt (omit `prompt`):** The backend uses the default template from `backend/prompts/{name}.txt`. All apps and the extension share the same prompt. Edit it once via the Prompts tab, `PUT /prompts/{name}`, or by editing the file directly.

**Per-app override (include `prompt`):** Send your own prompt in the request body. The backend uses it *instead* of the disk file — no other app is affected. Your app can use whatever prompt logic it wants.

Format (`/format`) is the exception: it always requires a prompt in the request (no disk default).

### `GET /prompts`

Returns all available AI prompt templates (ocr, dedup, translate, format) as JSON.

```sh
curl "http://localhost:8765/prompts"
```

### `GET /prompts/{name}` · `PUT /prompts/{name}`

Read or update a prompt template by name (`ocr`, `dedup`, `translate`, or `format`).

The `translate` prompt supports per-language variants via the `?language=` query parameter (e.g. `?language=French` writes `translate.French.txt`). Other prompts ignore the parameter.

```sh
# Read
curl "http://localhost:8765/prompts/translate"

# Read per-language
curl "http://localhost:8765/prompts/translate?language=French"

# Write (extension syncs after a short delay)
curl -X PUT "http://localhost:8765/prompts/ocr" \
  -H "Content-Type: application/json" \
  -d '{"template": "Transcribe all visible text in Japanese"}'
```

Prompts are persisted to `backend/prompts/*.txt` on disk and survive backend restarts. Other apps or scripts can read and write them through the same API.

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

- `api_base`: base provider URL without a trailing slash. Must expose `/v1/chat/completions`.
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

## Extension

The extension lives in `extension/` and uses Manifest V3.

Main files:

- `manifest.json`: extension metadata, permissions, content script registration, and keyboard command.
- `popup.html` and `popup.js`: popup UI with four tabs (OCR, Translation, Format, Prompts) for status, backend settings, language selection, custom prompts, and output actions.
- `background.js`: capture orchestration, backend calls, fragment merging, retry state, and persistence.
- `content.js`: selection overlay, saved-region editing, viewport reporting, and page scrolling.
- `overlay.css`: region selection overlay styling.

### Popup tabs

| Tab | Purpose |
|-----|---------|
| **OCR** | Start/stop capture, view status/progress, copy/download OCR result. |
| **Translation** | Translate OCR result to a target language. Auto-copy, auto-save (with save path), and auto-translate checkboxes. |
| **Format** | Format text with a custom AI prompt. Choose source (OCR or Translation), auto-copy, auto-save (with dedicated save path), and auto-format checkboxes. Auto-format fires automatically when translation completes. |
| **Prompts** | Configure the four AI prompts: **OCR Prompt**, **Dedup Prompt**, **Translation Prompt** (per-language), and **Format Prompt**. OCR, Dedup, and Translation prompts sync to the backend so they can be used by other apps. Format prompts are local-only (user-supplied per request). |

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

During capture, the popup shows status, current page, fragment count, and progress. The Stop button requests capture to stop and preserves fragments already collected.

### OCR, deduplication, translation, and formatting

For each captured page region, the extension:

1. Captures the visible tab.
2. Crops the selected region in an `OffscreenCanvas`.
3. Sends the cropped PNG to `POST /ocr`.
4. Stores the returned text as a fragment.
5. Merges fragments locally using line-overlap detection.
6. Sends the merged text to `POST /dedup`.
7. If a language other than `Original` is selected, sends the deduplicated text to `POST /translate`.
8. If auto-format is enabled and a format prompt is set, sends the translated text to `POST /format`.

The popup language dropdown supports `Original`, `Chinese`, `English`, `Japanese`, `Korean`, `French`, `German`, and `Spanish`. Choosing `Original` skips translation.

### Retry behavior

The Retry button appears when OCR, deduplication, or translation fails.

- OCR failure: retry resumes capture from the failed page while preserving already collected fragments.
- Dedup failure: retry runs deduplication again on the pending merged text.
- Translation failure: retry runs translation again on the pending deduplicated text.

### Output actions

Every result panel (OCR, Translation, Format) supports:

- **Copy** — copies the text to the clipboard.
- **Download** — saves the text as a `.txt` file (named `textkit-*.txt`, `translate-*.txt`, or `format-*.txt`).
- **Save** — writes the text to a local file on the backend machine via `POST /save`, using the tab's save path.

### Settings and persistence

Settings persisted to Chrome sync storage:

- Backend host and port.
- Auto-scroll on/off.
- Target language.
- Translation auto-copy, auto-save, auto-translate toggles and save path.
- Format auto-copy, auto-save, auto-format toggles, save path, and source selector (Translation or OCR Result).

Settings persisted to Chrome local storage:

- Last region size and position.
- Per-tab: OCR result, translation result, format result, status messages.
- OCR prompt, dedup prompt (user-defined, synced to backend after a short delay).
- Format prompt (user-defined, local-only — not synced to backend).
- Translation prompts (per-language, user-defined, synced to backend after a short delay).
- Save path autocomplete — queried in real time from the backend's `GET /paths` endpoint (with local history fallback).

## Development Notes

Install backend dependencies with:

```sh
cd backend
pip install -r requirements.txt
```

The backend dependencies are:

- `fastapi`
- `uvicorn`
- `python-multipart`
- `httpx`
- `pyyaml`
- `pillow`

The extension does not require a build step. Load the `extension/` folder directly as an unpacked extension.

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

Make sure **Auto-format** is checked on the Format tab and a **Format Prompt** is configured on the Prompt tab. Auto-format triggers when translation completes.

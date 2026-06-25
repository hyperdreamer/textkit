# AI OCR

AI OCR is a local OCR capture tool for reading long web pages through a browser extension and an AI-backed FastAPI service. The Chromium Manifest V3 extension lets you select a fixed region of the current page, capture that region page-by-page while scrolling, merge overlapping OCR fragments, optionally translate the result, and copy or download the final text.

The backend is provider-neutral: it can call OpenAI-compatible chat completion APIs or Anthropic's Messages API, depending on `backend/config.yaml`.

## Architecture

The project has two parts:

- `backend/`: a Python FastAPI server that exposes OCR, deduplication, and translation endpoints. It validates uploaded images, sends requests to the configured AI provider, and returns a consistent JSON response.
- `extension/`: a Chromium Manifest V3 extension that runs a popup, background service worker, and page content script. The content script draws the capture overlay and scrolls the page. The background service worker captures screenshots, crops the selected region, calls the backend, merges fragments, retries failed work, and stores the last region/result.

Typical flow:

1. Start the backend locally.
2. Load the extension in Chrome or another Chromium browser.
3. Press `Ctrl+Shift+C` or click `Select Region` in the popup.
4. Draw or adjust the capture region and press `Ctrl+Space`.
5. The extension captures the selected region, sends each page image to `POST /ocr`, merges fragments, sends merged text to `POST /dedup`, optionally sends the result to `POST /translate`, and stores the final text.

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

By default, the server binds to `0.0.0.0:8765`.

### Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `extension/` directory.
5. Open the extension popup and confirm the backend host and port, usually `localhost` and `8765`.

## Backend

The backend is implemented in `backend/main.py` and serves a FastAPI app named `Qidian OCR Backend`.

### Configuration

Create `backend/config.yaml` from the included template:

```sh
cd backend
cp config.example.yaml config.yaml
```

Example:

```yaml
host: "0.0.0.0"
port: 8765

ai:
  provider: "openai"
  api_base: "https://api.openai.com"
  api_key: "$OCR_API_KEY"
  model: "gpt-4.1-mini"
```

Supported `ai` fields:

- `provider`: `openai` or `anthropic`.
- `api_base`: base provider URL without a trailing slash.
  - OpenAI-compatible providers must expose `/v1/chat/completions`.
  - Anthropic-compatible providers must expose `/v1/messages`.
- `api_key`: the API key. Plaintext values are used directly. Prefix with `$` to treat the value as an environment variable name (e.g. `$OCR_API_KEY`). `api_key_env` is also accepted.
- `model`: the model name to send to the provider.

The backend also falls back to these environment variable names:

- `OCR_API_KEY`
- `OPENAI_API_KEY` when `provider: "openai"`
- `ANTHROPIC_API_KEY` when `provider: "anthropic"`

API key loading is lazy. The app can start without an API key in the environment; missing credentials are reported when an endpoint tries to call the configured provider.

### Launching

Run from the `backend/` directory:

```sh
cd backend
python main.py
```

`main.py` reads `config.yaml` and starts Uvicorn with the configured `host` and `port`.

### API

All backend endpoints return the same response shape:

```json
{
  "text": "result text",
  "model": "provider-model-name",
  "tokens_used": 123,
  "error": null
}
```

On errors, the response uses the same envelope with an empty `text`, empty `model`, `tokens_used: 0`, and an `error` message.

#### `POST /ocr`

Accepts a multipart image upload and returns transcribed text.

Form field:

- `image`: required image file.

Example:

```sh
curl -X POST "http://localhost:8765/ocr" \
  -F "image=@page.png"
```

The backend validates the image with Pillow, encodes it as a data URL, and sends it to the configured vision-capable model with an OCR prompt.

#### `POST /dedup`

Accepts merged OCR text and removes duplicate or overlapping content.

Request body:

```json
{
  "text": "..."
}
```

Example:

```sh
curl -X POST "http://localhost:8765/dedup" \
  -H "Content-Type: application/json" \
  -d '{"text":"first page\nfirst page\nsecond page"}'
```

This endpoint is used after multi-page capture to clean up repeated lines or overlapping page content.

#### `POST /translate`

Accepts text and a target language, then returns only the translation.

Request body:

```json
{
  "text": "...",
  "language": "Chinese"
}
```

Example:

```sh
curl -X POST "http://localhost:8765/translate" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world","language":"Chinese"}'
```

## Extension

The extension lives in `extension/` and uses Manifest V3.

Main files:

- `manifest.json`: extension metadata, permissions, content script registration, and keyboard command.
- `popup.html` and `popup.js`: popup UI for status, backend settings, language selection, copy/download, stop, and retry.
- `background.js`: capture orchestration, backend calls, fragment merging, retry state, and persistence.
- `content.js`: selection overlay, saved-region editing, viewport reporting, and page scrolling.
- `overlay.css`: region selection overlay styling.

### Capture controls

- Press `Ctrl+Shift+C` to open the region selection overlay. On macOS, the manifest suggests `Command+Shift+C`.
- Click `Select Region` in the popup to start the same selection flow.
- Drag on the page to draw the region.
- If a region was previously saved, it is pre-drawn when selection starts.
- The saved region has 8 resize handles: corners, edges, and side midpoints.
- Drag inside the saved region to reposition it.
- Press `Ctrl+Space` to confirm the selected region.
- Press `Esc` to cancel selection.

### Auto-scroll and page capture

The popup includes an Auto-scroll checkbox:

- Enabled: the extension captures the selected region, scrolls down by about one viewport with overlap, captures again, and repeats until the page stops scrolling.
- Disabled: the extension captures only the current viewport region once.

During capture, the popup shows status, current page, fragment count, and progress. The Stop button requests capture to stop and preserves fragments already collected. When stopped, the extension still finalizes the collected text through deduplication when possible.

### OCR, deduplication, and translation

For each captured page region, the extension:

1. Captures the visible tab.
2. Crops the selected region in an `OffscreenCanvas`.
3. Sends the cropped PNG to `POST /ocr`.
4. Stores the returned text as a fragment.
5. Merges fragments locally using line-overlap detection.
6. Sends the merged text to `POST /dedup`.
7. If a language other than `Original` is selected, sends the deduplicated text to `POST /translate`.

The popup language dropdown supports `Original`, `Chinese`, `English`, `Japanese`, `Korean`, `French`, `German`, and `Spanish`. Choosing `Original` skips translation.

The popup also includes a `Translate` button that can translate the current OCR result after capture if a target language is selected.

### Retry behavior

The Retry button appears when OCR, deduplication, or translation fails.

- OCR failure: retry resumes capture from the failed page while preserving already collected fragments.
- Dedup failure: retry runs deduplication again on the pending merged text.
- Translation failure: retry runs translation again on the pending deduplicated text.

### Output

After capture finishes, the popup shows the final text.

Available output actions:

- Copy: copies the text to the clipboard.
- Download: saves the text as a `.txt` file named like `qidian-ocr-YYYY-MM-DD...txt`.

### Settings and persistence

The popup lets you configure:

- Backend host.
- Backend port.
- Target language.
- Auto-scroll on or off.

The extension remembers:

- Last backend host and port in Chrome sync storage.
- Last selected language and auto-scroll setting in Chrome sync storage.
- Last region size and position in local storage.
- Last OCR result in local storage, so it is restored across browser or extension restarts.

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

Example:

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

Select a language other than `Original` before starting capture. You can also use the popup `Translate` button after OCR completes.

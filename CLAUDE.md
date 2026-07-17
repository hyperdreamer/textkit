# TextKit — Chrome Extension + FastAPI Backend

## Architecture
- Chrome MV3 extension: dynamically injected content script (selection and scrolling), service worker (capture and AI orchestration), popup (UI and settings)
- FastAPI backend at `backend/main.py`
- Saving and path suggestions use a separate localhost file-bridge service; they are not backend routes
- Four popup tabs: OCR, Translation, Format, Prompts

## Key Files
- `extension/background.js` — service worker: capture loop, translate, format, auto-* logic
- `extension/popup.js` — popup UI logic
- `extension/popup.html` — popup markup
- `backend/main.py` — FastAPI server: /ocr, /dedup, /translate, /format, and /prompts/*

## Key Commands
- Backend: `cd backend && python main.py`
- Python tests (from repository root): `python -m pytest tests/ -v`
- Node tests (from repository root): `node tests/background.test.js && node tests/popup.test.js && node tests/content.test.js`

## Code Standards
- Vanilla JS (no framework), ES2020+
- chrome.storage.sync for settings; chrome.storage.local for per-tab state and plugin prompt overrides
- Prompt precedence is extension request prompt > backend prompt file > hardcoded failsafe. Extension never writes canonical prompt files; server fallback previews stay separate from custom values.
- Long-running operations are owned by the service worker rather than the popup; OCR/dedup retry state is persisted for worker restart recovery
- Capture is bound to the starting tab URL; navigation stops the operation with a partial result. Same-URL reload is detected via document identity.
- Backend: FastAPI, Python 3.10+, type hints. Binds 127.0.0.1 by default, trusts localhost (no auth tokens).
- Config limits (max_upload_bytes, requests_per_minute, etc.) accept 0 to disable. /healthz returns {"status":"ok"}.

# TextKit — Chrome Extension + FastAPI Backend

## Architecture
- Chrome MV3 extension: content script (OCR capture), service worker (background.js), popup (popup.html + popup.js)
- FastAPI backend at `/data/home/guest/Development/ai/textkit/backend/main.py`
- Four popup tabs: OCR, Translation, Format, Prompts

## Key Files
- `extension/background.js` — service worker: capture loop, translate, format, auto-* logic
- `extension/popup.js` — popup UI logic
- `extension/popup.html` — popup markup
- `backend/main.py` — FastAPI server: /ocr, /dedup, /translate, /format, and /prompts/*

## Key Commands
- Backend: `cd backend && python main.py`
- Tests: `cd backend && python -m pytest tests/ -v`

## Code Standards
- Vanilla JS (no framework), ES2020+
- chrome.storage.sync for settings; chrome.storage.local for per-tab state and plugin prompt overrides
- Prompt precedence is plugin request prompt > backend prompt file > hardcoded failsafe. The extension never writes canonical prompt files.
- All background async work survives popup close via service worker
- Backend: FastAPI, Python 3.10+, type hints

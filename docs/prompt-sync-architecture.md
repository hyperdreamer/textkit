# Prompt Sync Architecture

## Status Summary

| Component | Status | Notes |
|-----------|--------|-------|
| PUT /prompts/{name} | ✅ Exists | `main.py:1002-1024` |
| DedupRequest.prompt field | ✅ Exists | `main.py:123` (`str \| None = None`) |
| GET /prompts, GET /prompts/{name} | ✅ Exists | `main.py:976-1033` |
| OCR prompt load/save | ✅ Exists | `popup.js:773-799` |
| Dedup prompt load/save | ✅ Exists | `popup.js:801-827` |
| Translate prompt per-language sync | ⚠️ Partial | Has gaps (see §3) |
| Format prompt backend sync | ❌ Remove | Should be local-only (see §3.4) |
| Prompt initialization ordering | ⚠️ Sequential | Should be parallelized (see §5) |

---

## 1. PUT /prompts/{name} Endpoint Design

### 1.1 Request

```
PUT /prompts/{name}[?language=<LanguageName>]
Content-Type: application/json

{"template": "<prompt text>"}
```

- **Path param** `name`: one of `ocr`, `dedup`, `translate`, `format`
- **Query param** `language` (optional): e.g. `English`, `Japanese`. When present, writes to `{name}.{language}.txt` (per-language override). Without it, writes to `{name}.txt` (base template).
- **Body**: `{"template": "..."}` — validated via `PromptUpdate` Pydantic model

### 1.2 Response (200 OK)

```json
{
  "name": "translate",
  "template": "Translate the following text to {language}...",
  "has_language_param": true,
  "language": "English"        // only present when ?language= was used
}
```

### 1.3 Behavior

1. Validate `name` is in `_DEFAULT_PROMPTS` (reject unknown names with 404)
2. Sanitize `language` query param — reject paths containing `/`, `\`, `..`
3. Construct filename: `{name}.{language}.txt` or `{name}.txt`
4. Create `PROMPTS_DIR` if missing (`mkdir(parents=True, exist_ok=True)`)
5. Write template to file (UTF-8)
6. Invalidate `_prompt_cache` for the cache key
7. Re-read via `_load_prompt()` and return

### 1.4 Edge Cases

| Scenario | Behavior |
|----------|----------|
| Unknown prompt name | 404 `"Unknown prompt: 'xyz'"` |
| Malformed JSON body | 400 — FastAPI validation error caught by `validation_error_handler` |
| Missing `template` field | 400 — Pydantic validation error |
| Invalid language param (path traversal) | 400 `"Invalid language parameter"` |
| Filesystem write fails (permissions) | 500 `"Failed to save prompt: ..."` via OSError |
| PROMPTS_DIR doesn't exist | Auto-created via `mkdir(parents=True)` |
| Concurrent PUT for same name | Last write wins (no locking — acceptable for single-user local backend) |
| Empty template string | Accepted — writes empty file, `_load_prompt` returns `""` |
| Template with only whitespace | Accepted — `write_text` preserves it, `_load_prompt` strips via `.strip()` |

### 1.5 Current Implementation Gap

The existing implementation (lines 1002-1024) is correct and complete. No changes needed.

---

## 2. DedupRequest Model

### 2.1 Current State (Already Implemented)

```python
class DedupRequest(BaseModel):
    text: str
    prompt: str | None = None
```

The `prompt` field is already optional. The backend dedup handler (`main.py:790`) already passes `request.prompt` to `deduplicate_text()`, which checks `prompt if prompt else _render_prompt("dedup")` (`main.py:583`).

The extension background (`background.js:995-1000`) already reads `dedupPrompt` from storage and includes it in the request body.

### 2.2 Verification Checklist

- [x] Model field exists and is optional
- [x] Handler reads and passes the field to business logic
- [x] Business logic uses custom prompt when provided, falls back to file template
- [x] Extension sends the field in requests

**No changes needed.**

---

## 3. Translate Prompt Sync

### 3.1 Data Model

The translate prompt has a two-tier hierarchy:

```
Level 1: Base template (translate.txt)
    "Translate the following text to {language}. Return only the translation.
     Preserve paragraph structure and line breaks."
    ↑ Contains {language} template variable

Level 2: Per-language overrides (translate.English.txt, translate.Japanese.txt, etc.)
    "Translate the following text to English. Return only the translation.
     Use past tense for narrative prose..."
    ↑ {language} is already resolved — no template variable
```

This is implemented in `_load_prompt()` with the `?language=` query parameter on the API.

### 3.2 Extension UX Flow

```
User opens Prompts tab
  → Language dropdown shows: Original, Chinese, English, Japanese, Korean, French, German, Spanish
  → User picks "English"
  → Extension calls GET /prompts/translate?language=English
    → Backend checks for translate.English.txt → found → returns it
    → has_language_param = false (it's a per-language override, not the base template)
  → Textarea shows the English-specific prompt

  → User picks "Chinese"
  → Extension calls GET /prompts/translate?language=Chinese
    → Backend checks for translate.Chinese.txt → not found
    → Falls back to translate.txt (base template)
    → has_language_param = true (the template still has {language})
  → Textarea shows: "Translate the following text to {language}. ..."
    → Extension can highlight or annotate the {language} placeholder
```

### 3.3 The `{language}` Template Variable UI

This is the key design question: **how should the extension handle `{language}` in the textarea?**

#### Option A: Display raw `{language}`, let user keep or replace it

- The textarea shows the literal string `{language}`
- User can leave it (dynamic, always resolves to current language dropdown selection)
- User can replace it with a concrete language name (creates a per-language override)
- **Trade-off**: Non-obvious to users what `{language}` means

#### Option B: Render `{language}` with the current language, save as override

- When loading, substitute `{language}` → current language name
- When saving, write as a per-language override (not the base template)
- **Trade-off**: Destroys the template variable — can never go back to dynamic

#### Option C (Recommended): Hybrid — display raw with visual hint

- Show the raw `{language}` in the textarea
- Add a small label/annotation next to the textarea: "`{language}` will be replaced with the selected language at request time"
- When `has_language_param` is true, show this hint
- When `has_language_param` is false, hide it (user already has a concrete override)

The `has_language_param` field from the backend response enables this:
```javascript
// In loadPromptForLanguage():
if (data.has_language_param) {
    languageHintEl.classList.remove('hidden');
    languageHintEl.textContent = `{language} will be replaced with "${lang}"`;
} else {
    languageHintEl.classList.add('hidden');
}
```

### 3.4 Format Prompt: Local-Only

**Design decision**: Format prompt should NOT sync with the backend.

**Current issue**: `saveFormatPrompt()` (`popup.js:829-841`) fires `PUT /prompts/format`, which saves to `backend/prompts/format.txt`. This violates the constraint that format is always user-supplied.

**Fix**:
- Remove the `PUT /prompts/format` call from `saveFormatPrompt()`
- Keep `localStorage.formatPrompt` as the sole storage
- Remove `"format": ""` from `_DEFAULT_PROMPTS` and the `format.txt` file (or keep as a documentation example only, not loaded by the API)
- Backend `/prompts/format` endpoint should be removed or return 404 — it's conceptually not a backend-managed template

**Revised `saveFormatPrompt()`**:
```javascript
function saveFormatPrompt() {
    const value = formatPrompt.value.trim();
    chrome.storage.local.set({ formatPrompt: value });
    // No backend sync — format prompt is user-supplied per-request
}
```

### 3.5 Translate Prompt Save Logic

Current implementation (`saveTlState`, `popup.js:370-385`):

```javascript
async function saveTlState() {
    const lang = tlLanguage.value;
    // Save locally
    await chrome.storage.local.set({
        tlLanguage: lang,
        [`translatePrompt:${lang}`]: translatePrompt.value
    });
    // Sync to backend (fire-and-forget)
    try {
        const backend = normalizeBackendSettings(hostInput.value, portInput.value);
        fetch(`http://${backend.host}:${backend.port}/prompts/translate?language=${encodeURIComponent(lang)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template: translatePrompt.value })
        });
    } catch {}
}
```

**Design note**: When `has_language_param` is true and the user edits the template (keeping `{language}`), we should save to the **base** file (no `?language=`), not the language-specific file. When the user replaces `{language}` with a concrete language, we save to the **per-language** file.

**Updated logic**:
```javascript
async function saveTlState() {
    const lang = tlLanguage.value;
    const value = translatePrompt.value;
    await chrome.storage.local.set({
        tlLanguage: lang,
        [`translatePrompt:${lang}`]: value
    });
    // Determine whether to save as base template or per-language override
    const hasLanguageParam = value.includes('{language}');
    // Base template: save without ?language= param
    // Per-language override: save with ?language=<lang>
    const langParam = hasLanguageParam ? '' : `?language=${encodeURIComponent(lang)}`;
    try {
        const backend = normalizeBackendSettings(hostInput.value, portInput.value);
        fetch(`http://${backend.host}:${backend.port}/prompts/translate${langParam}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template: value })
        });
    } catch {}
}
```

This way:
- Editing the base template (with `{language}`) → updates `translate.txt`
- Hardcoding "English" in the template → creates/updates `translate.English.txt`

---

## 4. Language Dropdown Sync

### 4.1 Two Language Selectors

The extension has two language dropdowns:
- `#tl-language` (Prompts tab) — controls which translate prompt is shown/edited
- `#tl2-language` (Translation tab) — controls which language to translate TO

They are kept in sync by `syncLanguage()` (`popup.js:392-406`).

### 4.2 Language Options

```
Original   — pass-through, needs no prompt unless user provides one
Chinese    — maps to zh-cn ISO code
English    — maps to en ISO code
Japanese   — maps to ja ISO code
Korean     — maps to ko ISO code
French     — maps to fr ISO code
German     — maps to de ISO code
Spanish    — maps to es ISO code
```

"Original" is special: it skips translation entirely unless a custom prompt is provided (see `_should_skip_translation`, `main.py:628-630`).

### 4.3 Behavior When Switching Language in Prompts Tab

```
1. Save current textarea content to translatePrompt:{oldLang}
2. Update tlLanguage storage key
3. Load prompt for new language from GET /prompts/translate?language={newLang}
4. Render in textarea with {language} hint if applicable
```

This is already implemented in `onTlLanguageChange()` (`popup.js:408-415`).

---

## 5. Initialization Flow

### 5.1 Current Flow (Sequential)

When the popup opens (`DOMContentLoaded` → `init()`):

```
1. Load sync settings (host, port, autoscroll)        ─┐
2. Migrate old ocrHost/ocrPort keys if present          │ ~1ms
3. Set default language dropdowns                       │
4. Restore autoscroll checkbox                          ─┘
5. refreshState() — get capture state from background   ─┐~5ms (IPC)
6. Restore lastResult from storage if textarea empty     ─┘~1ms
7. Restore lastStatus                                   ~1ms
8. loadPromptForLanguage() — GET /prompts/translate     ─┐
9. loadOcrPrompt()         — GET /prompts/ocr           ├ NETWORK (can block)
10. loadDedupPrompt()       — GET /prompts/dedup         ─┘
11. Load Translation tab state (language, result)        ~2ms
12. Load Translation tab settings (auto-copy/save/etc)   ~1ms
13. Load Format tab state + settings                     ~2ms
14. Load last region                                     ~1ms
```

**Problem**: Steps 8-10 are sequential network calls. If backend is slow or unreachable, each one times out before falling back to localStorage, causing noticeable popup load delay (potentially 30+ seconds for 3 sequential timeouts).

### 5.2 Recommended Flow (Parallel + Stale-while-revalidate)

```
PHASE 1: Instant render (synchronous / local-only, <5ms)
─────────────────────────────────────────────────────────
1. Load all sync settings (host, port, autoscroll, etc.)
2. Set default language dropdowns
3. Immediately populate textareas from localStorage:
   - ocrPromptEl.value = localStorage.ocrPrompt || ''
   - dedupPromptEl.value = localStorage.dedupPrompt || ''
   - translatePrompt.value = localStorage['translatePrompt:' + currentLang] || ''
   - formatPrompt.value = localStorage.formatPrompt || ''
4. refreshState() — fire-and-forget, UI updates via message listener
5. Restore Translation/Format tab state from localStorage

PHASE 2: Background sync (parallel network, non-blocking)
─────────────────────────────────────────────────────────
Promise.allSettled([
    syncOcrPrompt(),       // GET /prompts/ocr → update textarea if changed
    syncDedupPrompt(),     // GET /prompts/dedup → update textarea if changed
    syncTranslatePrompt(), // GET /prompts/translate?language=X → update textarea if changed
]).then(() => {
    // All synced — nothing to do, textareas already updated
});
```

**Key principle**: Show the user what's in localStorage immediately (the last known state), then update in the background when the backend responds. This is the "stale-while-revalidate" pattern.

### 5.3 Network Timeout

Each backend fetch should have a short timeout (e.g., 3 seconds) to avoid blocking the UI:

```javascript
async function fetchWithShortTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}
```

If the fetch times out or fails, the user still sees their localStorage content — no disruption.

### 5.4 What Loads First — Priority Order

| Priority | Data | Source | Rationale |
|----------|------|--------|-----------|
| P0 | Host, port, autoscroll | chrome.storage.sync | Needed to construct backend URLs |
| P0 | Current tab ID | chrome.tabs.query | Needed to key per-tab state |
| P1 | OCR/dedup/translate prompts | localStorage (instant) | User sees prompt editor immediately |
| P1 | Language dropdown value | localStorage | Controls which translate prompt variant |
| P2 | Capture state | background.js IPC | Controls OCR panel buttons |
| P2 | Last region | localStorage | Shown in OCR panel footer |
| P3 | Translation/Format tab state | localStorage | Only visible when user switches tabs |
| P4 | Backend prompt sync | Network GET | Updates textareas if server has newer content |

---

## 6. Edge Cases

### 6.1 Backend Unreachable

**Scenario**: User opens popup, backend is not running.

**Behavior**:
1. Phase 1 loads all prompts from localStorage immediately — user sees their prompts
2. Phase 2 network requests fail (timeout or connection refused)
3. UI shows localStorage content, no error message needed (this is normal operation)
4. If user edits and saves a prompt, `saveOcrPrompt()` / `saveDedupPrompt()` / `saveTlState()` saves to localStorage synchronously, then attempts backend PUT as fire-and-forget (`.catch(() => {})`)
5. Next time backend is reachable and popup opens, Phase 2 sync will push the newer localStorage content to backend (or the user can manually trigger by editing)

**Design rule**: LocalStorage is authoritative for the extension. The backend is a sync target, not the source of truth during active editing.

### 6.2 Files Deleted from Disk

**Scenario**: User or external process deletes `backend/prompts/ocr.txt`.

**Behavior**:
- `_load_prompt("ocr")` checks file existence → `prompt_path.is_file()` returns False
- Falls back to `_DEFAULT_PROMPTS.get("ocr", "")` — the hardcoded default
- Returns the built-in default prompt
- Next GET /prompts/ocr returns the hardcoded default
- Next PUT /prompts/ocr recreates the file

**No data loss**: The hardcoded fallback in `_DEFAULT_PROMPTS` acts as a safety net.

### 6.3 User Edits Prompt While Offline

**Scenario**: Backend is down, user edits OCR prompt in extension and saves.

**Behavior**:
1. `saveOcrPrompt()` saves to localStorage → succeeds immediately
2. Attempts `PUT /prompts/ocr` → fails (backend unreachable)
3. Error is silently caught (`} catch {}`)
4. User's edit is persisted in localStorage
5. Later, backend comes back online, user opens popup
6. Phase 2: `loadOcrPrompt()` gets from backend (old content), but localStorage has newer content
7. **Conflict!** Current code overwrites textarea with backend content, losing the offline edit.

**Required fix**: When loading from backend, compare with localStorage. If localStorage is newer/different and backend is stale, keep localStorage or (better) push localStorage to backend.

**Resolution strategy — "Last Write Wins with Timestamp"**:

```javascript
const STORAGE_KEY = 'ocrPrompt';
const TIMESTAMP_KEY = 'ocrPrompt:updatedAt';

async function saveOcrPrompt() {
    const value = ocrPromptEl.value;
    const now = Date.now();
    await chrome.storage.local.set({
        [STORAGE_KEY]: value,
        [TIMESTAMP_KEY]: now
    });
    // Background sync...
}

async function loadOcrPrompt() {
    // Phase 1: always load localStorage immediately
    const local = await chrome.storage.local.get([STORAGE_KEY, TIMESTAMP_KEY]);
    ocrPromptEl.value = local[STORAGE_KEY] || '';

    // Phase 2: try backend
    try {
        const backend = normalizeBackendSettings(hostInput.value, portInput.value);
        const resp = await fetchWithShortTimeout(
            `http://${backend.host}:${backend.port}/prompts/ocr`
        );
        if (!resp.ok) return;
        const data = await resp.json();
        const remoteTemplate = data.template || '';

        // Conflict resolution: compare timestamps
        const syncResult = await chrome.storage.local.get('ocrPrompt:lastSync');
        const lastSync = syncResult['ocrPrompt:lastSync'] || 0;

        if (local[TIMESTAMP_KEY] > lastSync) {
            // Local is newer → push to backend, don't overwrite
            return; // Keep localStorage content
        }

        if (remoteTemplate !== local[STORAGE_KEY]) {
            // Backend is newer or first sync → update textarea
            ocrPromptEl.value = remoteTemplate;
            await chrome.storage.local.set({
                [STORAGE_KEY]: remoteTemplate,
                [TIMESTAMP_KEY]: Date.now(),
                [STORAGE_KEY + ':lastSync']: Date.now()
            });
        }
    } catch {
        // Backend unreachable — keep localStorage content
    }
}
```

**Simpler alternative (recommended for this project's scale)**: Since this is a single-user local tool, just use a simpler rule: **push on save, compare on load**. If the remote template differs from the local one, show both and let the user decide. Or even simpler: **backend always wins on first load of a session, localStorage always wins after that** until the user explicitly reloads.

### 6.4 Concurrent Editing (Race Condition)

**Scenario**: User has popup open in two tabs, edits the same prompt in both.

**Resolution**: Last PUT wins. Both tabs write to the same file. The extension doesn't need distributed locking for a single-user local tool.

However, within a single popup session, debounce the PUT request:
- User types in textarea → `input` event fires on every keystroke
- `saveOcrPrompt()` is called on each keystroke
- Each call does `localStorage.set()` (instant) + `fetch(PUT)` (network)

**Fix**: Debounce the PUT (not the localStorage save) by 500ms:

```javascript
let _ocrPromptSaveTimer = null;

ocrPromptEl.addEventListener('input', () => {
    const value = ocrPromptEl.value;
    // Save locally immediately (no debounce)
    chrome.storage.local.set({ ocrPrompt: value });

    // Debounce backend sync
    clearTimeout(_ocrPromptSaveTimer);
    _ocrPromptSaveTimer = setTimeout(() => syncOcrPromptToBackend(value), 500);
});
```

### 6.5 Language-Specific File Not Found

**Scenario**: User selects "Korean" in Prompts tab, but `translate.Korean.txt` doesn't exist.

**Behavior**: `_load_prompt("translate", "Korean")` tries `translate.Korean.txt` → not found → falls back to `translate.txt` → returns base template with `{language}` → `has_language_param: true` in response.

This is correct. The extension shows the base template, and `{language}` will be resolved to "Korean" at request time.

### 6.6 User Deletes All Prompt Text

**Scenario**: User clears the OCR prompt textarea entirely.

**Behavior**:
- `_load_prompt("ocr")` loads `ocr.txt` (or hardcoded default)
- Extension `loadOcrPrompt()` backend fetch → gets populated template → populates textarea
- But if the user intentionally emptied it, the empty string is saved to localStorage
- Next Phase 2 sync, backend returns populated template → this would OVERWRITE the user's intentional empty value

**Resolution**: Treat empty string as "use default". If the textarea is empty:
- In `saveOcrPrompt()`: save empty string to localStorage (user's intent)
- In `postImageForOcr()` (`background.js:960-968`): if `stored.ocrPrompt` is falsy (empty string), don't append the prompt field → backend uses its default

This way, an empty textarea means "use the backend default," and the user doesn't need to manually type in the default prompt to get default behavior.

### 6.7 Template Variable Not Resolvable

**Scenario**: User edits translate prompt to include `{unknown_var}`.

**Behavior**: `_render_prompt("translate", language="English")` calls `template.format(language="English")` → `{unknown_var}` causes KeyError → caught by try/except → raises HTTPException 500 with detail about unknown variable.

This is already implemented in `main.py:97-107`. The error message tells the user which variable is unknown.

### 6.8 Format Prompt Saved to Backend (Current Bug)

**Scenario**: User edits format prompt → `saveFormatPrompt()` fires `PUT /prompts/format`.

**Current behavior**: The call succeeds because "format" is in `_DEFAULT_PROMPTS`. The file `backend/prompts/format.txt` gets overwritten with the user's custom prompt. Next time `GET /prompts/format` is called (if ever), it returns the user's custom prompt — which is misleading because format is supposed to be user-supplied per-request.

**Fix**: Remove the backend sync from `saveFormatPrompt()`. Format prompt stays in `localStorage.formatPrompt` only.

---

## 7. Implementation Checklist

### Backend Changes
- [ ] Remove `"format"` from `_DEFAULT_PROMPTS` dict (or keep as empty string but document it's not managed)
- [ ] Consider removing `format.txt` from `backend/prompts/` (or rename to `format.txt.example`)

### Extension Changes (popup.js)
- [ ] **Phase 1**: Populate textareas from localStorage before any network calls (instant render)
- [ ] **Phase 2**: Parallelize `loadOcrPrompt()`, `loadDedupPrompt()`, `loadPromptForLanguage()` via `Promise.allSettled()`
- [ ] **Timeout**: Add 3-second timeout to backend GET requests during load
- [ ] **saveFormatPrompt()**: Remove `PUT /prompts/format` backend sync
- [ ] **saveTlState()**: Use `has_language_param` check to decide whether to save as base template (no `?language=`) or per-language override (`?language=<lang>`)
- [ ] **{language} hint UI**: Add a small label that appears when `has_language_param` is true, saying `{language}` will be replaced with current language selection
- [ ] **Debounce**: Debounce backend PUT requests by 500ms (keep localStorage save immediate)
- [ ] **Empty prompt semantics**: When prompt textarea is empty, don't send prompt field in requests (let backend use its default)

### Extension Changes (popup.html)
- [ ] Add `#translate-prompt-hint` element (hidden by default, shown when `has_language_param` is true)
- [ ] Add `#save-status` indicator for "Saved locally" / "Synced to backend" feedback

### Extension Changes (background.js)
- [ ] No changes needed — already reads prompts from localStorage and includes in requests
- [ ] Verify empty prompt handling: if `stored.ocrPrompt` is falsy, don't append `prompt` FormData field

---

## 8. Storage Key Reference

| Key | Location | Purpose |
|-----|----------|---------|
| `ocrPrompt` | `chrome.storage.local` | OCR prompt text |
| `ocrPrompt:updatedAt` | `chrome.storage.local` | Last local edit timestamp (for conflict resolution) |
| `ocrPrompt:lastSync` | `chrome.storage.local` | Last backend sync timestamp |
| `dedupPrompt` | `chrome.storage.local` | Dedup prompt text |
| `translatePrompt:{lang}` | `chrome.storage.local` | Per-language translate prompt |
| `tlLanguage` | `chrome.storage.local` | Currently selected language in Prompts tab |
| `formatPrompt` | `chrome.storage.local` | Format prompt (local only, no backend sync) |
| `backendHost` | `chrome.storage.sync` | Backend hostname |
| `backendPort` | `chrome.storage.sync` | Backend port |

---

## 9. API Reference

### GET /prompts
```json
// Response 200
{
  "prompts": {
    "ocr": "Transcribe all visible text...",
    "dedup": "Remove duplicate and overlapping passages...",
    "translate": "Translate the following text to {language}...",
    "format": ""
  }
}
```

### GET /prompts/{name}[?language=<Name>]
```json
// Response 200
{
  "name": "translate",
  "template": "Translate the following text to {language}...",
  "has_language_param": true
}
// With ?language=English:
{
  "name": "translate",
  "template": "Translate the following text to English...",
  "has_language_param": false,
  "language": "English"
}
// 404 — Unknown prompt name
{"detail": "Unknown prompt: 'xyz'"}
```

### PUT /prompts/{name}[?language=<Name>]
```json
// Request
{"template": "New prompt text with {language} variable"}
// Response 200
{
  "name": "translate",
  "template": "New prompt text with {language} variable",
  "has_language_param": true
}
// 400 — Invalid language param (path traversal attempt)
{"detail": "Invalid language parameter"}
// 404 — Unknown prompt name
{"detail": "Unknown prompt: 'xyz'"}
```

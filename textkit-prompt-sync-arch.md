# PUT /prompts/{name} + Extension Prompt Sync — Architecture Design

## Current State Summary

### Backend (`backend/main.py`)
- `_DEFAULT_PROMPTS`: dict of 3 built-in prompts (`ocr`, `dedup`, `translate`)
- `PROMPTS_DIR`: `backend/prompts/` — `.txt` files override defaults (gitignored)
- `_prompt_cache`: module-level `dict[str, str]` — lazy-loaded, never invalidated
- `_load_prompt(name)`: checks cache → disk → default (in that order)
- `_render_prompt(name, **kwargs)`: calls `_load_prompt` then `str.format()`
- `GET /prompts`: lists all prompts (disk overrides + defaults)
- `GET /prompts/{name}`: returns `{name, template, has_language_param}`; 404 if name not in `_DEFAULT_PROMPTS`
- No write endpoint exists for prompts

### Extension popup.html (Prompt tab = `#translate-panel`)
- Language selector `#tl-language` (original/Chinese/English/…)
- Textarea `#translate-prompt` — the AI prompt, per-language
- Textarea `#format-prompt` — separate format prompt (out of scope for this task)

### Extension popup.js
- `loadPromptForLanguage()`: reads `translatePrompt:{language}` from `chrome.storage.local`
- `saveTlState()`: writes `translatePrompt:{language}` + `tlLanguage` to `chrome.storage.local`
- `onTlLanguageChange()`: switches language, saves old prompt, loads new
- `syncLanguage()`: keeps language dropdowns in sync across tabs
- Tab switching (line 66–73): just toggles `hidden` classes; no load-on-tab-open logic

### Extension background.js
- `handleTranslateStart()` (line 332–333): reads `translatePrompt:{language}` from storage, sends as `prompt` in POST body
- `autoTranslateIfEnabled()` (line 859–860): same pattern
- Translation POST goes to `/translate` with `{text, language, prompt}`

### How prompts flow today
```
User edits textarea (per-language)
  → chrome.storage.local[translatePrompt:{lang}]
    → background.js reads it
      → POST /translate {prompt: "Translate to formal Chinese."}
        → backend: prompt or _render_prompt("translate", language=language)
```
The `prompts/translate.txt` template is only used when the extension sends NO custom prompt.

---

## A. BACKEND: `PUT /prompts/{name}`

### Route definition
```python
class PromptUpdate(BaseModel):
    template: str

@app.put("/prompts/{name}")
async def put_prompt(name: str, request: PromptUpdate) -> dict[str, object]:
```

### Validation

1. **Name check**: `if name not in _DEFAULT_PROMPTS:` → 404 `f"Unknown prompt: '{name}'"`
   - Prevents creating arbitrary files outside the known prompt set
   - Same guard as `GET /prompts/{name}`

2. **Template check**: Reject empty/whitespace-only templates? **No.**
   - An empty template is valid (user intentionally clears it to use no prompt)
   - `_render_prompt` would return `""` for an empty template, which is fine

### Write
```python
PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
prompt_path = PROMPTS_DIR / f"{name}.txt"
prompt_path.write_text(request.template, encoding="utf-8")
```
- Uses `write_text` (atomic-ish on most Linux filesystems for small files)
- `mkdir` ensures directory exists (first run, or after `git clean`)

### Cache invalidation
```python
_prompt_cache.pop(name, None)
```
- Removes only the updated name from the in-memory cache
- Next `_load_prompt(name)` will re-read from disk
- Other cached prompts (ocr, dedup) are untouched

### Response
```python
return {
    "name": name,
    "template": request.template,
    "has_language_param": "{language}" in request.template,
}
```
- Same shape as `GET /prompts/{name}` for consistency

### Error handling

| Condition | Status | Detail |
|---|---|---|
| Unknown prompt name | `404` | `f"Unknown prompt: '{name}'"` |
| Disk write fails (OSError) | `500` | `f"Failed to save prompt: {exc.strerror or exc}"` |
| Request body missing `template` | `422` | FastAPI auto-validation |
| `PROMPTS_DIR` not writable | `500` | Caught by OSError handler |

The existing catch-all handler at main.py:595 already covers unhandled exceptions.

### Security considerations
- **Path traversal**: Not possible — `name` is validated against `_DEFAULT_PROMPTS` keys (only `ocr`, `dedup`, `translate`), all safe filenames
- **No shell injection**: `pathlib.Path` API, no shell calls
- **Content**: Any text is allowed — this is a user-editable template, not executable code

### Full pseudocode
```python
class PromptUpdate(BaseModel):
    template: str

@app.put("/prompts/{name}")
async def put_prompt(name: str, request: PromptUpdate) -> dict[str, object]:
    if name not in _DEFAULT_PROMPTS:
        raise HTTPException(status_code=404, detail=f"Unknown prompt: '{name}'")

    try:
        PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
        prompt_path = PROMPTS_DIR / f"{name}.txt"
        prompt_path.write_text(request.template, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to save prompt: {exc.strerror or exc}",
        ) from exc

    # Invalidate cache so next load picks up the new content
    _prompt_cache.pop(name, None)

    return {
        "name": name,
        "template": request.template,
        "has_language_param": "{language}" in request.template,
    }
```

---

## B. EXTENSION: Load prompt from backend on Prompt tab open

### Current behavior
- `loadPromptForLanguage()` runs at `init()` time, always from `chrome.storage.local`
- Language change triggers `loadPromptForLanguage()` again
- Tab switch does NOT trigger any load

### New behavior
When the user clicks the "Prompt" tab:
1. Fetch `GET /prompts/translate` from the backend
2. Populate `#translate-prompt` textarea with `response.template` (raw, includes `{language}`)
3. If fetch fails (network error, timeout, 4xx/5xx): fall back to current `chrome.storage.local` behavior — load `translatePrompt:{language}`

### Trigger point
Modify the tab click handler (popup.js line 66–73):
```javascript
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    Object.values(panels).forEach(p => p.classList.add('hidden'));
    panels[tab.dataset.panel].classList.remove('hidden');

    // NEW: When Prompt tab becomes visible, load from backend
    if (tab.dataset.panel === 'translate-panel') {
      loadPromptFromBackend();
    }
  });
});
```

### Fetch logic
```javascript
async function loadPromptFromBackend() {
  try {
    const host = hostInput.value || 'localhost';
    const port = portInput.value || 8765;
    const resp = await fetch(`http://${host}:${port}/prompts/translate`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    translatePrompt.value = data.template || '';
  } catch {
    // Backend unreachable — fall back to chrome.storage.local
    await loadPromptForLanguage();
  }
}
```

### Important: template vs per-language prompt
There is a conceptual mismatch between:
- **Backend template**: `"Translate the following text to {language}. Return only the translation."` (single, uses `{language}` placeholder)
- **Extension per-language prompts**: `"Translate to formal academic Chinese."` (language already baked in)

The design resolves this by:
1. The Prompt tab **textarea always shows the backend template** (with `{language}`).
2. The `loadPromptForLanguage()` fallback is still per-language — this maintains backward compat when the backend is unreachable.
3. The per-language overrides in `chrome.storage.local` continue to work for *translation* (background.js still reads them), but the Prompt tab's UI now reflects the canonical template.

This means the language selector in the Prompt tab becomes **advisory** — it still syncs with the Translation tab's language selector (`syncLanguage`), but it no longer drives which prompt is shown in the textarea. The textarea always shows the shared backend template.

**Alternative considered**: Keep per-language prompts in the textarea and PUT each one separately. Rejected because the backend model is one template per name, not one per language. Per-language variations are handled by `{language}` substitution.

### Edge cases

| Scenario | Behavior |
|---|---|
| Backend running, template exists | Textarea populated from backend |
| Backend running, no `translate.txt` on disk | Backend returns `_DEFAULT_PROMPTS["translate"]` — shown in textarea |
| Backend unreachable | Fall back to `chrome.storage.local` → `loadPromptForLanguage()` |
| Backend returns 404 (should not happen) | Fall back to `chrome.storage.local` |
| User has old per-language prompts stored | They remain in storage and are still used during translation, but the textarea shows the canonical template |
| Very first run, no backend, no stored prompts | Textarea empty (acceptable — user types their prompt) |

---

## C. EXTENSION: Save prompt to backend on edit

### Trigger strategy: debounced on-input + flush on tab switch

**Recommendation: 1.5-second debounce on `input` event, with immediate flush when switching away from the Prompt tab.**

Trade-off analysis:

| Strategy | Pros | Cons |
|---|---|---|
| **Save on every keystroke** | Instant sync | Excessive HTTP requests; partial/incomplete templates saved; backend disk writes on every char |
| **Debounced input (1–2s)** | Near real-time; avoids flooding backend; complete thoughts usually saved | Slight delay; requires flush-on-close |
| **Save on blur** | Minimal writes; template is complete when saved | Popup close ≠ blur event in Chrome extensions; user can close popup mid-edit and lose changes |
| **Save on tab switch** | Natural boundary; fewer writes | User might stay on Prompt tab for a long time; changes lost on crash |
| **Save button** | Explicit; user controls when | Extra UI element; easy to forget; not in the current design |

**Winner: debounced input + flush on tab switch.**

Rationale:
- The popup is transient — users open it, edit, close it. Blur alone is unreliable in the extension popup context.
- Debounce gives good UX (no "Saving…" spinner on every keystroke).
- Flush-on-tab-switch ensures the last edit is sent before the user moves on.
- This matches the existing pattern: the OCR result textarea already uses `input` event for auto-save (`resultEl.addEventListener('input', saveOcrText)` at popup.js:87).

### Save function
```javascript
let _promptSaveTimer = null;

function schedulePromptSave() {
  clearTimeout(_promptSaveTimer);
  _promptSaveTimer = setTimeout(() => savePromptToBackend(), 1500);
}

async function savePromptToBackend() {
  const template = translatePrompt.value;
  try {
    const host = hostInput.value || 'localhost';
    const port = portInput.value || 8765;
    const resp = await fetch(`http://${host}:${port}/prompts/translate`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template }),
    });
    if (!resp.ok) {
      console.warn('PUT /prompts/translate failed:', resp.status);
    }
  } catch {
    // Backend unreachable — silently ignore, template is still in textarea
    // and will be saved to chrome.storage.local below
  }

  // Always update chrome.storage.local for backward compat
  // Save BOTH: the raw template (for Prompt tab reload) AND per-language (for translation)
  const lang = tlLanguage.value;
  await chrome.storage.local.set({
    translatePromptTemplate: template,           // canonical template (new key)
    [`translatePrompt:${lang}`]: template,       // per-language backward compat (existing key)
    tlLanguage: lang,
  });
}
```

### Wiring
```javascript
// Replace existing listener (popup.js line 94):
// OLD: translatePrompt.addEventListener('input', saveTlState);
// NEW:
translatePrompt.addEventListener('input', () => {
  schedulePromptSave();
});
```

### Flush on tab switch
```javascript
// In tab click handler, BEFORE switching away from Prompt tab:
if (previousPanel === 'translate-panel') {
  clearTimeout(_promptSaveTimer);
  await savePromptToBackend();
}
```

Chrome extensions don't have a reliable `beforeunload`-equivalent for popups, but the tab switch handler is the closest we get. The debounce also means at most 1.5 seconds of typing is "at risk" if the user closes the popup without switching tabs first.

### What is NOT changed
- `saveTlState()` is replaced by `schedulePromptSave()` + `savePromptToBackend()`
- `onTlLanguageChange()` still saves the per-language prompt via `savePromptToBackend()` (which updates `translatePrompt:{lang}`)
- `loadPromptForLanguage()` remains as the fallback path
- The per-language overrides in `chrome.storage.local` (`translatePrompt:{lang}`) remain the source of truth for *translation* — background.js continues to read them
- The language selector in the Prompt tab still works — it drives which per-language key is used during translation

### Data flow after changes
```
User edits textarea
  ├─(debounced)→ PUT /prompts/translate  → backend/prompts/translate.txt
  │                                       → _prompt_cache.pop("translate")
  │
  └→ chrome.storage.local
       ├─ translatePromptTemplate (new key, for reload)
       └─ translatePrompt:{lang}  (existing key, for translation)
```

---

## D. Cache Invalidation

### Current cache behavior
```python
_prompt_cache: dict[str, str] = {}

def _load_prompt(name: str) -> str:
    if name not in _prompt_cache:
        prompt_path = PROMPTS_DIR / f"{name}.txt"
        if prompt_path.is_file():
            _prompt_cache[name] = prompt_path.read_text(encoding="utf-8").strip()
        else:
            _prompt_cache[name] = _DEFAULT_PROMPTS.get(name, "")
    return _prompt_cache[name]
```

The cache is **write-through only on miss** — once loaded, a prompt never changes until the process restarts. This is fine for a read-only world, but breaks when PUT is added.

### Invalidation on PUT
```python
_prompt_cache.pop(name, None)
```
- Called in the PUT handler after writing to disk
- Uses `dict.pop(key, None)` to avoid `KeyError` if the name was never cached
- Only invalidates the modified prompt — other cached prompts are unaffected

### Consumers that benefit
All callers of `_load_prompt("translate")` or `_render_prompt("translate", ...)` automatically pick up the new template on their next call:

| Consumer | Code path |
|---|---|
| `GET /prompts` | `_load_prompt(name)` in the loop |
| `GET /prompts/{name}` | `_load_prompt(name)` |
| `POST /translate` (no custom prompt) | `_render_prompt("translate", language=language)` |
| `POST /ocr` | `_render_prompt("ocr")` |
| `POST /dedup` | `_render_prompt("dedup")` |

### What is NOT needed
- No timestamp/file-watch mechanism — the cache is in-memory, single-process. A simple `pop()` is sufficient.
- No lock/synchronization — asyncio is single-threaded, and the `pop` + disk write happen in the same coroutine.
- No cache-busting for the ocr/dedup templates unless they are also PUT-updated (they can be, using the same endpoint).

### Edge case: concurrent PUT + GET
```
Request A: PUT /prompts/translate  → writes disk, pops cache
Request B: GET /prompts/translate  → cache miss, reads disk
```
This is fine — asyncio processes one request at a time. Request B will always see the disk state **after** Request A's write.

### Edge case: PUT while translate is in-flight
```
Request A: POST /translate  → _render_prompt("translate") loads from cache (old template)
Request B: PUT /prompts/translate  → updates disk + invalidates cache
Request C: POST /translate  → _render_prompt("translate") loads from disk (new template)
```
Request A uses the old template — this is expected and acceptable. The alternative (re-loading mid-request) would be surprising and complex.

---

## Implementation Order

### Phase 1: Backend (independent, testable with curl)
1. Add `PromptUpdate(BaseModel)` to `main.py`
2. Add `PUT /prompts/{name}` route
3. Test: `curl -X PUT -H 'Content-Type: application/json' -d '{"template":"hello"}' localhost:8765/prompts/translate`
4. Verify: `curl localhost:8765/prompts/translate` returns the new template
5. Verify: `curl localhost:8765/prompts/ocr` still returns the OCR default (cache isolation)

### Phase 2: Extension — Load on tab open
1. Add `loadPromptFromBackend()` to `popup.js`
2. Modify tab click handler to call it when Prompt tab opens
3. Test: open Prompt tab → textarea populated from backend
4. Test: stop backend → open Prompt tab → fallback to storage

### Phase 3: Extension — Save on edit
1. Add `schedulePromptSave()` and `savePromptToBackend()` to `popup.js`
2. Wire `input` event listener (replacing `saveTlState`)
3. Add flush-on-tab-switch logic
4. Test: edit textarea → wait 1.5s → curl backend → verify new template
5. Test: edit → close popup immediately → reopen → changes persisted (via storage fallback)

### Phase 4: Integration test
1. Edit prompt in extension → PUT to backend
2. Use `/translate` endpoint without custom prompt → verify new template used
3. Kill/restart backend → verify template persists on disk
4. Edit prompt while backend is down → verify `chrome.storage.local` fallback works

---

## Files Changed

| File | Changes |
|---|---|
| `backend/main.py` | Add `PromptUpdate` model, `PUT /prompts/{name}` route (~20 lines) |
| `extension/popup.js` | Add `loadPromptFromBackend()`, `schedulePromptSave()`, `savePromptToBackend()`, modify tab click handler, modify `input` listener (~50 lines) |
| `extension/popup.html` | No changes needed |

No changes to `extension/background.js` — it continues to read `translatePrompt:{language}` from storage as before.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Backend writes to disk on every debounce fire (potentially many writes) | Debounce reduces frequency; prompt files are tiny (<1KB); modern SSDs handle this trivially |
| Extension popup closes before debounce fires | Flush-on-tab-switch; max 1.5s of typing lost; `chrome.storage.local` always updated synchronously on each debounce fire |
| Two extension instances edit simultaneously | Last-write-wins (acceptable — this is a single-user local tool) |
| PUT to wrong prompt name | Name validated against `_DEFAULT_PROMPTS` keys; only `ocr`/`dedup`/`translate` are valid |
| `prompts/*.txt` is in `.gitignore` — no version control | Intended — these are user customizations; `.example` files provide the defaults |

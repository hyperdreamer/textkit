# Known Non-Issues (Design Decisions)

These findings have been evaluated and deliberately left unfixed.
Future audits should NOT re-report these.

---

## 3. OCR/dedup retry loops have no maximum retry count
**File:** `extension/background.js` (`executeCaptureLoop`, `finalizePostCapture`)

Both loops use `for (let attempt = 1; ; attempt++)` — infinite retry with only
user Stop as exit. The "guard" code after the loop is dead code (never reached).

**Decision:** NOT fixing — user preference. User explicitly wants infinite retry
on OCR AND dedup backend errors. Only user Stop breaks the loop. Both use
`for (let attempt = 1; ; attempt++)` by design.

---

## 4. `normalizeBackendSettings` duplicated in background.js and popup.js
**Files:** `extension/background.js`, `extension/popup.js`

Both files define the same function with identical logic. `LOCAL_BACKEND_HOSTS`
is also duplicated.

**Decision:** NOT fixing. Service worker and popup are separate JS contexts;
extracting a shared module for 13 lines adds more complexity than it removes.
The function is stable and won't drift.

---

## 5. ~~`fetchWithTimeout` in popup.js is unused dead code~~ → FIXED
**File:** `extension/popup.js:941-949`

Was dead code — removed in commit `7d78b25` (10 audit fixes).

---

## 6. ~~Service worker retry state stored a non-serializable `tab` object~~ → FIXED
**File:** `extension/background.js`

Retry snapshots now store serializable scalar/plain-data fields such as `tabId`,
`captureUrl`, region, fragments, scroll position, stage, and prompt snapshot.
Live tab data is re-queried with `chrome.tabs.get(tabId)` when work resumes.

---

## 7. ~~Offscreen document lifecycle — timer-based close~~ → FIXED
**Files:** `extension/background.js`, `extension/offscreen.js`

Copy requests now carry a correlation ID. The background worker consumes the
offscreen success/failure response, closes the document when all pending copies
finish, and uses the 2-second timer only as a failure fallback. Success
notifications are emitted only after confirmed clipboard completion. Manual
popup copy and download actions also check their fallback/API results and expose
failures in the relevant status panel.

---

## 8. `manifest.json` version is `0.0.0`
**File:** `extension/manifest.json:4`

Version `0.0.0` on a dev branch prevents Chrome auto-update and makes builds
indistinguishable.

**Decision:** NOT fixing — dev branch convention. All dev-* branches use
version `0.0.0` for testing. Version is bumped only on master before merge/tag.
See memory for version management rules.

---

## 9. Single module-level `keepAlive` interval
**File:** `extension/background.js` (`startKeepAlive`, `stopKeepAlive`)

A single `keepAliveIntervalId` is shared across all tabs. `stopKeepAlive()` is
called only when ALL controllers are empty.

**Decision:** NOT fixing — correct behavior. The keepalive should persist as
long as ANY tab has an active capture/translate/format operation. A per-tab
keepalive would add complexity with no benefit.

---

## 10. Format save path shares datalist ID with Translation save path
**File:** `extension/popup.html`

Both the Format save path input (`#fmt-save-path`) and Translation save path input (`#tl2-autosave-path`) reference `list="tl2-path-suggestions"` — the same `<datalist>`. 

**Decision:** NOT fixing — correct by design. Both inputs share a single datalist because `updatePathSuggestions()` regenerates suggestions based on whichever input the user is currently typing in. Separate datalists would duplicate fetch logic with no benefit.

---

## 12. Auto-scroll distance uses viewport height rather than selected-region height
**Files:** `extension/content.js`, `extension/background.js`

The capture loop crops screenshots to the selected region but advances the page by
`window.innerHeight - overlapPx`, so a region shorter than the viewport does not
provide continuous document-coordinate coverage.

**Decision:** NOT fixing — intentional capture behavior. Auto-scroll advances one
viewport at a time while preserving a small viewport overlap; the selected region
is a fixed sampling window, not the scrolling step size. Users who require
continuous full-page coverage should select a region spanning the relevant
viewport height. Future audits should not report this as a defect.

---

*Last updated: 2026-07-17 — no auth tokens, 0=unlimited limits, same-URL reload detection, prompt fallback separation*

---

## 13. No backend auth (extension_token, admin_token) — stripped by design

**Decision:** Removed. The backend binds 127.0.0.1 by default. For a single-user localhost tool, extension/auth tokens add configuration burden without meaningful security — any local process or installed extension can already hit the port. Prompt templates are edited directly in `backend/prompts/*.txt` (no write API). File-bridge likewise runs on localhost with no token.

---

## 14. PUT /prompts/{name} removed

**Decision:** Removed. The endpoint mutated prompt files on disk but served no real workflow — per-request custom prompts come from the extension, and persistent templates are edited in a text editor. Removing it eliminates auth, validation, and file-write attack surface.

---

## 15. Config limits accept 0 to mean "unlimited"

**Decision:** All `max_*` and rate/currency settings (`requests_per_minute`, `max_concurrent_requests`) accept 0 to disable the check entirely. Defaults are conservative; run with limits at 0 for unrestricted local use.

---

## 16. `_prompt_cache` can perform duplicate reads on concurrent cache misses

**File:** `backend/main.py` (`_load_prompt`)

Two `asyncio.to_thread` calls can miss `_prompt_cache` concurrently, both read the
same small prompt file, and then store equivalent values. CPython protects the
individual dictionary operations, so this does not corrupt state or return an
incorrect prompt.

**Decision:** NOT fixing. The only consequence is an occasional duplicate read of
a tiny local file. Adding synchronization would increase complexity without a
meaningful correctness or performance benefit.

---

## 17. Worker recovery reads all extension-local storage

**File:** `extension/background.js` (`recoverPersistedOperations`)

Worker startup uses `chrome.storage.local.get(null)` and filters keys beginning
with `operation:` because Chrome storage has no prefix-query API. Maintaining a
separate active-operation index would avoid the scan, but would require migration
and atomic consistency handling across operation creation, completion, crashes,
and service-worker termination.

**Decision:** NOT fixing. Startup recovery correctness is more important than the
small local-storage read cost. A stale or incomplete index could silently prevent
recovery of interrupted operations.

---

## 18. Popup fallback Maps have no eviction

**File:** `extension/popup.js` (`_fallbackRequests`, `_fallbackData`)

Changing backend settings repeatedly can leave entries for old endpoints in these
Maps during the current popup session.

**Decision:** NOT fixing. A Chrome extension popup is a short-lived context and the
Maps are destroyed when it closes. There is no realistic persistent memory leak.

---

## 19. Rate-limit counter does not drift across config hot reloads

**File:** `backend/main.py` (`request_controls`, `_acquire_request_slot`,
`_release_request_slot`)

An audit claimed that changing `max_concurrent_requests` while a request is in
flight could make acquisition increment `_active_requests` while release skips the
decrement. This cannot occur: `request_controls` obtains one immutable `AppConfig`
object at request entry, computes `limiter_enabled` from it, and passes that same
object to both acquisition and release. A hot reload creates a new config object;
it does not mutate the request-local snapshot.

**Decision:** FALSE POSITIVE — do not change the release logic. Unconditionally
decrementing would obscure the acquire/release invariant without fixing a real
failure.

---

## 20. Origin validation remains a deferred item, not a non-issue

**File:** `AUDIT_TODO.md`

Origin/Fetch Metadata validation for CORS-safelisted OCR requests was deliberately
excluded from the completed safe-fix loop because it needs a separately designed
compatibility decision.

**Decision:** Keep deferred in `AUDIT_TODO.md`; do not report it as a newly
undocumented finding or silently implement it during unrelated audit fixes.

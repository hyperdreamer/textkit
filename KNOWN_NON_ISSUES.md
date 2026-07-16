# Known Non-Issues (Design Decisions)

These findings have been evaluated and deliberately left unfixed.
Future audits should NOT re-report these.

---

## 3. OCR/dedup retry loops have no maximum retry count
**File:** `extension/background.js:576-588`, `extension/background.js:772`

Both loops use `for (let attempt = 1; ; attempt++)` — infinite retry with only
user Stop as exit. The "guard" code after the loop is dead code (never reached).

**Decision:** NOT fixing — user preference. User explicitly wants infinite retry
on OCR AND dedup backend errors. Only user Stop breaks the loop. Both use
`for (let attempt = 1; ; attempt++)` by design.

---

## 4. `normalizeBackendSettings` duplicated in background.js and popup.js
**File:** `extension/background.js:27-46`, `extension/popup.js:951-970`

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

## 6. Service worker restart: `tab` object in `retryState` not fully serializable
**File:** `extension/background.js:591`

The `tab` object from `chrome.tabs.query()` contains non-serializable properties.
Only `tab.id` (a number) survives `chrome.storage.local.set`. `winId` is
redundantly stored as a top-level field, partially mitigating this.

**Decision:** NOT fixing. The code re-queries the tab if needed via
`chrome.tabs.get(tabId)`. This is a known MV3 limitation — tab objects can't be
fully serialized. The redundant `winId` field is sufficient for resume.

---

## 7. ~~Offscreen document lifecycle — timer-based close~~ → FIXED
**Files:** `extension/background.js`, `extension/offscreen.js`

Copy requests now carry a correlation ID. The background worker consumes the
offscreen success/failure response, closes the document when all pending copies
finish, and uses the 2-second timer only as a failure fallback. Success
notifications are emitted only after confirmed clipboard completion.

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
**File:** `extension/background.js:287-300`

A single `keepAliveIntervalId` is shared across all tabs. `stopKeepAlive()` is
called only when ALL controllers are empty.

**Decision:** NOT fixing — correct behavior. The keepalive should persist as
long as ANY tab has an active capture/translate/format operation. A per-tab
keepalive would add complexity with no benefit.

---

## 10. Format save path shares datalist ID with Translation save path
**File:** `extension/popup.html:387`

Both the Format save path input (`#fmt-save-path`) and Translation save path input (`#tl2-autosave-path`) reference `list="tl2-path-suggestions"` — the same `<datalist>`. 

**Decision:** NOT fixing — correct by design. Both inputs share a single datalist because `updatePathSuggestions()` regenerates suggestions based on whichever input the user is currently typing in. Separate datalists would duplicate fetch logic with no benefit.

---

## 12. Auto-scroll distance uses viewport height rather than selected-region height
**File:** `extension/content.js:308-320`, `extension/background.js:627-643`

The capture loop crops screenshots to the selected region but advances the page by
`window.innerHeight - overlapPx`, so a region shorter than the viewport does not
provide continuous document-coordinate coverage.

**Decision:** NOT fixing — intentional capture behavior. Auto-scroll advances one
viewport at a time while preserving a small viewport overlap; the selected region
is a fixed sampling window, not the scrolling step size. Users who require
continuous full-page coverage should select a region spanning the relevant
viewport height. Future audits should not report this as a defect.

---

*Last updated: 2026-07-16 — file-bridge, retry persistence, and offscreen copy fixes*

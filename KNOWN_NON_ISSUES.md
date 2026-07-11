# Known Non-Issues (Design Decisions)

These findings have been evaluated and deliberately left unfixed.
Future audits should NOT re-report these.

---

## 1. Path traversal in `POST /save` via symlink bypass
**File:** `backend/main.py:885-899`

The traversal guard uses unresolvable `save_root_expanded` (lexical check only), but
the actual write follows symlinks via `path.resolve()`. A symlink inside `save_root`
pointing outside would bypass the guard.

**Decision:** NOT fixing. The user's system uses symlinks everywhere
(`~/Ramdisk → /ramdisk/...`). Resolving before containment would break legitimate
saves to symlinked paths. The `normpath` guard already catches `../` escapes.
Symlink escapes require an attacker with filesystem access — out of scope for a
localhost-only tool.

---

## 2. Path traversal in `GET /paths` via symlink
**File:** `backend/main.py:909-964`

Same unresolved-`save_root_expanded` pattern as #1. `iterdir()` follows symlinks
but the guard is lexical only.

**Decision:** NOT fixing — same rationale as #1. Symlinks are intentional in
this user's environment.

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

## 7. Offscreen document lifecycle — timer-based close
**File:** `extension/background.js:1119-1135`

The 2-second `setTimeout` to close the offscreen document is not tied to actual
copy completion. In practice, the copy is synchronous and 2 seconds is ample.

**Decision:** NOT fixing. The fix (tracking document ownership, confirmation
messages) adds complexity disproportionate to the risk. The current pattern works
reliably; Chrome MV3 allows only one offscreen document, and the 2s delay is
conservative.

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

*Last updated: 2026-07-11 — post-Claude Code audit of dev-textkit branch*

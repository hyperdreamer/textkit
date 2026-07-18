# Known Non-Issues

These findings have been evaluated and deliberately left unchanged. Future audits
should not report them unless the documented behavior or threat model changes.

---

## 1. OCR and dedup retries have no maximum attempt count

**File:** `extension/background.js` (`executeCaptureLoop`, `finalizePostCapture`)

Both retry loops are intentionally unbounded. Backend failures retry until the
user presses Stop; Stop also interrupts the retry delay.

**Decision:** Keep infinite retries for both OCR and dedup.

---

## 2. Backend-setting normalization is duplicated across extension contexts

**Files:** `extension/background.js`, `extension/popup.js`

`normalizeBackendSettings` and `LOCAL_BACKEND_HOSTS` exist in both the service
worker and popup.

**Decision:** Keep the small duplication. The service worker and popup are separate
JavaScript contexts, and introducing a shared module for this stable helper would
add more complexity than it removes.

---

## 3. Development builds use version `0.0.0`

**File:** `extension/manifest.json`

Development branches intentionally use `0.0.0`; release versions are assigned on
`master`.

**Decision:** Do not bump versions or create tags on `dev-*` branches.

---

## 4. One keepalive interval is shared by all active operations

**File:** `extension/background.js` (`startKeepAlive`, `stopKeepAlive`)

The module-level keepalive remains active while any capture, translation, or format
controller exists.

**Decision:** Keep one shared interval. Per-tab intervals add complexity without a
lifecycle benefit.

---

## 5. Translation and format save paths share one datalist

**File:** `extension/popup.html`

The translation and format save-path inputs both use `tl2-path-suggestions`.
Suggestions are regenerated for the input currently being edited.

**Decision:** Keep one datalist and one fetch/update path.

---

## 6. Auto-scroll advances by viewport height, not selected-region height

**Files:** `extension/content.js`, `extension/background.js`

The selected region is a fixed sampling window. Auto-scroll advances by one
viewport minus overlap, even when the selected region is shorter than the viewport.

**Decision:** This is intentional capture behavior. Users needing continuous
full-page coverage should select a region spanning the relevant viewport height.

---

## 7. The localhost backend has no authentication tokens

The backend binds to `127.0.0.1` by default. For this single-user localhost tool,
extension/admin tokens add configuration burden without meaningful protection
against local processes or installed extensions. File Bridge follows the same
localhost model.

**Decision:** Do not add backend authentication unless the deployment threat model
changes.

---

## 8. Prompt templates have no HTTP write endpoint

Persistent prompt templates are edited directly in `backend/prompts/*.txt`.
Per-request custom prompts are sent by the extension. The former
`PUT /prompts/{name}` endpoint was removed because it served no required workflow
and added file-mutation surface.

**Decision:** Do not restore prompt-template mutation through HTTP without a new,
explicit workflow requirement.

---

## 9. Configuration value `0` means unlimited

All `max_*` limits and rate/concurrency settings, including
`requests_per_minute` and `max_concurrent_requests`, accept `0` to disable that
limit.

**Decision:** Preserve `0 = unlimited`; conservative nonzero defaults remain
available.

---

## 10. Concurrent prompt-cache misses may duplicate a file read

**File:** `backend/main.py` (`_load_prompt`)

Two `asyncio.to_thread` calls can miss `_prompt_cache` concurrently, read the same
small prompt file, and store equivalent values. Individual dictionary operations
remain safe under CPython; no incorrect prompt or state corruption results.

**Decision:** Do not add synchronization solely to avoid an occasional duplicate
read of a tiny local file.

---

## 11. Worker recovery scans all extension-local storage

**File:** `extension/background.js` (`recoverPersistedOperations`)

Chrome storage has no prefix-query API, so recovery uses
`chrome.storage.local.get(null)` and filters `operation:` keys. A separate active
operation index would require migration and atomic consistency across creation,
completion, crashes, and service-worker termination.

**Decision:** Prefer reliable recovery over the small startup read cost. Do not add
an index without a complete consistency and migration design.

---

## 12. Popup fallback Maps have no eviction

**File:** `extension/popup.js` (`_fallbackRequests`, `_fallbackData`)

Changing backend settings can retain entries for old endpoints during the current
popup session.

**Decision:** No eviction is needed. The popup is short-lived and its Maps are
destroyed when it closes.

---

## 13. Rate-limit counters cannot drift because of config hot reload

**File:** `backend/main.py` (`request_controls`, `_acquire_request_slot`,
`_release_request_slot`)

An audit claimed that a hot reload could make acquisition increment
`_active_requests` while release skips the decrement. This is false:
`request_controls` obtains one immutable `AppConfig` snapshot at request entry and
passes that same object to acquisition and release. Reloading creates a new object
without mutating the in-flight request's snapshot.

**Decision:** This is a verified false positive. Do not make release decrement
unconditionally to address it.

---

Deferred actionable work belongs in `AUDIT_TODO.md`, not this file.

*Last reviewed: 2026-07-18*

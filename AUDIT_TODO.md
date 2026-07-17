# Audit TODO — Deferred Items

## #1: Origin validation for CORS-safelisted OCR requests

**Severity:** High  
**File:** `backend/main.py` (OCR endpoint, ~line 834)

**Problem:** Backend has no Origin/Fetch Metadata validation. A hostile website can issue a CORS-safelisted `multipart/form-data` POST to `http://127.0.0.1:8765/ocr`. CORS blocks reading the response, but the billable AI call already happened — consuming configured AI key and rate-limit capacity.

**Suggested fix:** Reject browser requests whose `Origin` is `http://` or `https://`, while allowing `chrome-extension://...` and non-browser clients without an Origin header. Alternatively require a non-safelisted extension header and explicitly handle its preflight.

**Status:** Deferred — to be addressed separately

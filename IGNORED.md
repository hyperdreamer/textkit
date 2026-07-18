# Ignored Audit Findings

These findings were reviewed and intentionally left unfixed because the proposed
changes could regress supported workflows. They should not be reported as newly
discovered issues unless the implementation, requirements, or threat model changes.

---

## 1. Origin validation for CORS-safelisted OCR requests

**Severity:** High

**File:** `backend/main.py` (OCR endpoint)

### Finding

The backend does not validate `Origin` or Fetch Metadata headers. A hostile website
can submit a CORS-safelisted `multipart/form-data` request to
`http://127.0.0.1:8765/ocr`. CORS prevents the website from reading the response,
but the request can still trigger a billable AI call and consume rate-limit
capacity.

### Considered fixes

- Reject browser requests whose `Origin` uses `http://` or `https://`, while
  allowing `chrome-extension://` origins and clients that send no `Origin` header.
- Require a non-safelisted extension header so browser requests must pass a CORS
  preflight.

### Regression risk

Origin validation can reject legitimate local browser clients, development tools,
proxies, or future integrations with different origin behavior. Requiring a custom
header changes the OCR API contract and can break existing extension or third-party
clients until they are migrated together.

### Decision

Leave the endpoint unchanged during regression-safe audit work. Address this only
as a coordinated API change with an inventory of supported clients, compatibility
tests, and a migration plan.

### Reconsider when

- The backend is exposed beyond the single-user localhost threat model.
- Abuse or unexpected billable OCR requests are observed.
- All supported clients can be identified and migrated atomically.

---

*Last reviewed: 2026-07-18*

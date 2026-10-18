# Configurable OCR confirmation shortcut — technical specification

- Date: 2026-10-17
- PM run: `pm-run-20261017-115722-e169d2eb`
- Role: independent frontier `spec-drafter`, attempt 1
- Status: technical specification for review; approved design is settled
- Approved design: `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md`
- Approved design SHA-256: `50e4b4ae20f6afb8ecbc883f9c85a30900a417db2954ff3994d714d57940a9a5`
- Design approval/source inspection commit: `56bf8a3c4888f623a04ad459554a463312fa3201`
- Pre-change behavior oracle: `c47dec6a24b42bcdb25f2c4fbe731deca8ce4431`

## 1. Authority, scope, and implementation decisions

The approved design's hash was verified before drafting. The drafting brief records design approval at `56bf8a3` after 27 review rounds. This specification implements that design and the five final-review clarifications in the drafting brief. The design's historical draft/pending-review labels do not reopen approval. All existing-code `file:line` citations below refer to the inspected integration checkout at `56bf8a3`; product and test files also match the pinned oracle commit. New code examples are requirements, not claims that those routes already exist.

The feature replaces how OCR-region confirmation is triggered. Chrome owns shortcut editing at `chrome://extensions/shortcuts`, persistence, clearing, conflicts, and scope. The default confirmation binding is `Ctrl+Shift+Space`, with `Command+Shift+Space` on macOS; launch remains `Ctrl+Shift+S`, with `Command+Shift+S` on macOS. There is no popup shortcut control or page-key substitute for Chrome's command. The supported-key decision is settled by the design's platform investigation, at `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:13`.

Implementation consists of the manifest addition, a branch in the existing command listener, a content message route calling the existing confirmation function, removal of its old keyboard branch, the binding-driven hint and its two stylesheet adjustments, tests/fixture, and README updates. The complete artifact boundary is in §10. This drafting task creates only this specification; it does not execute that implementation.

The existing confirmation/cancellation and capture contracts in §2 and §4 stay unchanged. Explicit non-goals are durable pending-selection records, selection-ID lookup/echo round trips, request/response confirmation protocols, claim maps, `stopEpoch`, terminal-checkpoint immutability, and `retryState` changes. No capture-lifecycle redesign is required. In particular, `handleStop`, `runCaptureLoop`, and `recoverPersistedOperations` remain unchanged (`extension/background.js:523`, `extension/background.js:1045`, `extension/background.js:2259`). The implementation adds no operation/checkpoint writes and changes no screenshot pipeline.

Decisions filling details left open by the design are labeled **Decision** below. They constrain presentation, ordering, and test seams, without changing capture admission.

## 2. Verified source map and protected behavior

| Existing owner | Verified anchor and implication |
| --- | --- |
| Commands declaration | `extension/manifest.json:36` contains only `start-region-capture`; its suggested keys and description are at `extension/manifest.json:38`. Permissions and optional host permissions are at `extension/manifest.json:7` and `extension/manifest.json:16`. |
| Launch command | `extension/background.js:323` registers the current asynchronous command listener. Launch awaits readiness at `extension/background.js:326`, queries the active tab at `extension/background.js:327`, creates the token at `extension/background.js:342`, enters `Selecting` at `extension/background.js:344`, and sends `selection:start` at `extension/background.js:345`. |
| Popup selection start | `extension/background.js:472` creates its token, `extension/background.js:473` enters `Selecting`, and `extension/background.js:475` sends the same selection-start shape. These paths are unchanged. |
| Content selection router | `extension/content.js:23` registers the listener; `extension/content.js:25` rejects a missing/empty/non-string start token, and `extension/content.js:29` starts selection synchronously. `extension/content.js:33` handles worker cancellation. |
| Local selection ownership | `extension/content.js:5` through the declarations at `extension/content.js:14` hold the overlay, region, token, and pending flag. `extension/content.js:345` removes the overlay and clears those fields, including region at `extension/content.js:360`, token at `extension/content.js:361`, and pending at `extension/content.js:362`. |
| Saved region and drawing | `extension/content.js:132` restores a saved rectangle when both dimensions are at least `MIN_SIZE`; it clamps it at `extension/content.js:134`. Overlay creation/attachment is synchronous (`extension/content.js:110`, `extension/content.js:124`), as is `drawRegion()` at `extension/content.js:145`. |
| Pointer updates | Trusted pointer-down guard is at `extension/content.js:180`; new-region initialization is at `extension/content.js:192`; pointer movement mutates the rectangle at `extension/content.js:205`. Geometry and trust checks remain unchanged. |
| Confirmation | `extension/content.js:269` owns `confirmSelection()`. Its admission guard is at `extension/content.js:270`, result snapshot at `extension/content.js:272`, pending/hide at `extension/content.js:282`, nested animation frames at `extension/content.js:286`, and completion send at `extension/content.js:288`. Rejection restores the overlay and displays a diagnostic at `extension/content.js:295`. |
| Selection keys | `extension/content.js:306` has both trust and pending guards; Escape handling is at `extension/content.js:308`. Delete only the confirmation branch starting at `extension/content.js:314`. Space scroll prevention is a separate unchanged path at `extension/content.js:81`. |
| Worker completion admission | Sender-tab check begins at `extension/background.js:378`; region shape check is at `extension/background.js:383`; `Selecting`/token check is at `extension/background.js:389`; token consumption is at `extension/background.js:393`; immediate reply and background launch are at `extension/background.js:406` and `extension/background.js:407`. |
| Cancellation and restart | `extension/background.js:411` consumes matching cancellation tokens. Worker state is an in-memory map (`extension/background.js:183`); fresh state is `Idle` with a null token (`extension/background.js:196`, `extension/background.js:203`). Startup recovery at `extension/background.js:2333` invokes the operation recovery routine, whose branches recover translate/format/capture work, not a pending selection (`extension/background.js:2259`). |
| Hint styles | The rendered closed shadow root and inline stylesheet installation are at `extension/content.js:112` and `extension/content.js:113`; its hint currently has `nowrap` at `extension/content.js:104`. External hint styling starts at `extension/overlay.css:40`, with `nowrap` at `extension/overlay.css:51`. Injection of content/CSS is at `extension/background.js:1032`. |

These protected semantics are acceptance requirements:

1. Worker handling of `selection:complete` keeps its existing order: sender tab, region shape, then `Selecting` plus a nonempty matching token, then consume the token, save the rectangle, acknowledge, and launch background capture (`extension/background.js:377`, `extension/background.js:383`, `extension/background.js:389`, `extension/background.js:393`, `extension/background.js:394`, `extension/background.js:406`). The shape check is not promoted to authorization or bounds validation: unary numeric coercion accepts numeric strings, negative coordinates are not rejected, positive dimensions/viewports are required, and DPR is not examined (`extension/background.js:1925`). The invalid-region branch's existing state update remains in place (`extension/background.js:384`).
2. The token stays single-use: the worker clears it before acknowledging the first valid completion (`extension/background.js:393`); another completion cannot pass the same check. No new token fields are sent.
3. The content function still snapshots the rectangle, viewport, and DPR synchronously, sets `confirmPending`, hides the overlay, waits for two nested `requestAnimationFrame` callbacks, then sends the existing completion (`extension/content.js:272`, `extension/content.js:282`, `extension/content.js:286`). No timer substitutes for those frames.
4. Escape still removes an idle selection and emits `selection:cancelled` with the token saved before removal (`extension/content.js:308`). Both key-handler guards remain, so Escape cannot remove the overlay or null its token during pending confirmation (`extension/content.js:306`, `extension/content.js:361`). The regression assertion remains required even though Escape behavior is unchanged.
5. `Selecting` remains the existing worker admission state, entered by launch or popup start and checked by completion (`extension/background.js:344`, `extension/background.js:473`, `extension/background.js:389`). Neither new message sets that state or bypasses it.

## 3. Manifest contract

The `commands` object in `extension/manifest.json` must contain exactly the following two entries. Preserve other manifest fields, including both permissions arrays, byte-for-byte apart from necessary JSON punctuation around this addition. There is **no permissions change**, no new `host_permissions`, and no new `global` setting. The starting declaration and permissions are verified at `extension/manifest.json:36`, `extension/manifest.json:7`, and `extension/manifest.json:16`.

```json
{
  "commands": {
    "start-region-capture": {
      "suggested_key": {
        "default": "Ctrl+Shift+S",
        "mac": "Command+Shift+S"
      },
      "description": "Select a region and start OCR capture"
    },
    "confirm-region-capture": {
      "suggested_key": {
        "default": "Ctrl+Shift+Space",
        "mac": "Command+Shift+Space"
      },
      "description": "Confirm selected OCR region"
    }
  }
}
```

These are suggested defaults, not a hardcoded label to show when Chrome reports a different binding or an empty shortcut. Chrome's effective binding is authoritative for the hint (§6) and registration test (§9.4).

## 4. Message and key-trigger contracts

Only two message types are added. No existing message type is removed or changed. `T` below is the existing nonempty string selection token; `R` is the existing result object `{x, y, width, height, viewportWidth, viewportHeight, devicePixelRatio}`; `S` is an optional saved rectangle `{x, y, width, height}`.

| Status / direction | `type` or trigger | Exact request shape | Reply shape | Channel and waiting contract |
| --- | --- | --- | --- | --- |
| Added; worker → top-frame content | `selection:confirm` | `{type: 'selection:confirm'}` via `chrome.tabs.sendMessage(tabId, request, {frameId: 0})`; no other fields | Exactly `{ok: true}`, even when the function admits nothing | Content calls `confirmSelection()` synchronously, replies in the same listener turn, and returns literal `false`. Worker awaits only delivery/reply inside its detached command task, ignores the value, and swallows delivery failure. Neither party waits here for capture completion. |
| Added; content → worker | `commands:binding` | Exactly `{type: 'commands:binding'}` | Exactly one of `{state: 'assigned', label: L}` with nonempty Chrome shortcut string `L`; `{state: 'unassigned'}`; `{state: 'unavailable'}` | Asynchronous request. Worker uses `sendResponse` and literal `return true`; synchronous `getAll()` failure may reply immediately but still returns `true`. Content attaches fulfillment/rejection handlers for presentation only; selection start and confirmation do not await the lookup. |
| Unchanged; worker → content | `selection:start` | `{type: 'selection:start', lastRegion: S \| undefined, selectionToken: T}`; `lastRegion` may be absent on the wire | `{ok: true}`; invalid/missing token: `{ok: false, error: 'Missing selection confirmation token.'}` | Worker start paths await the existing `tabs.sendMessage`. Content calls `startSelectionMode(message.lastRegion \|\| null, T)` synchronously, replies, returns `false`. Existing send options remain unchanged. |
| Unchanged; content → worker | `selection:complete` | Exactly `{type: 'selection:complete', region: R, selectionToken: T}` | `{ok: true}`; or `{ok: false, error: 'No sender tab found.'}`; or `{ok: false, error: 'Invalid selected region.'}`; or `{ok: false, error: 'Selection confirmation is stale or unauthorized.'}` | Sent after the existing two-frame delay. Content waits for this admission acknowledgment and removes/restores its overlay as before. Worker replies synchronously and returns `false`; it starts `runCaptureLoop` without awaiting its completion. |
| Unchanged; worker → content | `selection:cancel` | `{type: 'selection:cancel'}` | `{ok: true}` | Content removes the overlay synchronously and returns `false`; the existing Stop caller awaits delivery and catches failure. |
| Unchanged; content → worker | `selection:cancelled` | `{type: 'selection:cancelled', selectionToken: T}` | No response payload | Escape sends it with a rejection handler. Worker handles a matching token and returns `false`; neither side waits for a result. |
| Removed; trusted page key handler, not a message | `event.key === ' ' && event.ctrlKey` | Former trusted Ctrl+Space event branch | None, before or after | Delete its `preventDefault()` and `confirmSelection()` call. Do not substitute another page confirmation key. Preserve the preceding `event.isTrusted !== true \|\| confirmPending` guard and the Escape branch. |

Existing request/reply evidence: selection start and cancel at `extension/content.js:24` and `extension/content.js:33`; worker start send at `extension/background.js:345` and `extension/background.js:475`; completion payload/response processing at `extension/content.js:288`; worker replies/order at `extension/background.js:377`; Escape/cancellation at `extension/content.js:308` and `extension/background.js:411`; Stop's cancel send at `extension/background.js:534`.

`selection:confirm` has no selection identifier, token, rectangle, or result field. Content already owns the current overlay and selection fields (`extension/content.js:5`, `extension/content.js:12`, `extension/content.js:13`, `extension/content.js:14`). A new identifier lookup could only learn the selection at a later time, not establish invocation-time intent. `{ok: true}` acknowledges route handling; it does not claim capture admission or distinguish a new confirmation from an already pending one. The worker must not interpret it as a capture result.

## 5. Service-worker behavior

### 5.1. Confirmation command branch

Extend the **existing** `chrome.commands.onCommand` listener to accept Chrome's optional second argument, `tab` (current listener at `extension/background.js:323`). Replace its initial start-only early return with an `if (command === 'start-region-capture')` block wrapping the original `try/catch`, followed by a return from that block; put the new branch afterward. Preserve the existing launch branch's readiness, query, permission, injection, state, and error behavior (`extension/background.js:325`). Do not place readiness or the launch branch's catch/fallback ahead of the new branch.

For `confirm-region-capture`, execute exactly this routing sequence:

```js
if (command !== 'confirm-region-capture') return;
void (async () => {
  let target = tab;
  if (!target?.id) {
    try {
      [target] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      return;
    }
  }
  if (!target?.id) return;
  try {
    await chrome.tabs.sendMessage(
      target.id,
      { type: 'selection:confirm' },
      { frameId: 0 }
    );
  } catch {
    // Failed delivery has no confirmation effect.
  }
})();
```

A truthy supplied `tab.id` wins, even if focus subsequently changes. If missing/falsy, make exactly **one** fallback query with the shown object and use its first result. Rejection, an empty result, or a first result with no truthy ID is a silent no-op; do not retry, query again, update selection state, request permissions, inject content, or launch capture directly. A successful resolution sends exactly one message to frame 0. Its rejection is swallowed with no user error or unhandled rejection.

**Decision — ordering:** run this branch independently of `startupReadiness`, with no timer, queue, or retry. Rationale: the old page key reached `confirmSelection()` directly (`extension/content.js:314`); waiting for worker recovery would change admission timing. The later completion continues to use its unchanged worker handler (`extension/background.js:377`). Keeping the outer listener asynchronous for the existing launch branch is acceptable; dispatching confirmation must not depend on any readiness await.

A failed delivery is a no-op. A successful delivery after navigation follows §7: a replacement document with an overlay can confirm it. Do not use “navigation means nothing to confirm” as a blanket promise.

### 5.2. Binding lookup route

Add this branch to the existing synchronous runtime listener (`extension/background.js:362`), before its final unhandled-message return (`extension/background.js:452`). It has no readiness dependency and no state or storage side effects.

```js
if (message?.type === 'commands:binding') {
  let replied = false;
  const reply = (payload) => {
    if (!replied) {
      replied = true;
      sendResponse(payload);
    }
  };
  try {
    chrome.commands.getAll()
      .then((rows) => {
        const row = rows.find(
          (candidate) => candidate.name === 'confirm-region-capture'
        );
        if (!row) return reply({ state: 'unavailable' });
        return reply(row.shortcut
          ? { state: 'assigned', label: row.shortcut }
          : { state: 'unassigned' });
      })
      .catch(() => reply({ state: 'unavailable' }));
  } catch {
    reply({ state: 'unavailable' });
  }
  return true;
}
```

Use an exact-name lookup, not array position, description, prefix, or the start command. For Chrome's string-valued `shortcut`, a nonempty string is `assigned` and is returned verbatim; `''` is `unassigned`. A missing row, rejected promise, or **synchronous throw before a promise exists** is `unavailable`. There are three wire shapes; `checking` is local presentation state only.

For every completed lookup path, the `replied` latch guarantees exactly one `sendResponse` invocation. Set it before calling `sendResponse` so a later error/catch cannot reply again. Return literal **`true`**, including after synchronous failure, to preserve asynchronous reply delivery. Do not return a promise or an object from the runtime listener. A promise which has not settled leaves checking pending; the feature adds no timeout.

## 6. Content behavior and hint state machine

### 6.1. New route and preserved key guards

Add this synchronous branch to the listener at `extension/content.js:23`:

```js
if (message?.type === 'selection:confirm') {
  confirmSelection();
  sendResponse({ ok: true });
  return false;
}
```

Call the existing function directly, preserving the listener's existing `_sender` policy; do not add a sender gate or an externally connectable surface. It already refuses a pending confirmation, missing token/region, or dimensions smaller than `MIN_SIZE = 10` (`extension/content.js:16`, `extension/content.js:270`). With no overlay, existing cleanup has cleared the region and token (`extension/content.js:357`, `extension/content.js:360`–`362`), so the same guard returns. Do not introduce selection fields or a second completion implementation. The only permitted adjustment inside the existing confirmation function is routing its hint diagnostic through the presentation ownership logic in §6.3; its guards, snapshot, frames, message, acknowledgment handling, and overlay restoration remain unchanged (`extension/content.js:269`, `extension/content.js:299`).

Delete the old Ctrl+Space branch at `extension/content.js:314`. Preserve this guard verbatim:

```js
if (event.isTrusted !== true || confirmPending) return;
```

Preserve the existing Escape body (`extension/content.js:308`). In particular, do not remove `confirmPending` while removing the old confirmation key: Escape during the two-frame interval would otherwise remove the overlay and clear the token before the queued completion reads it (`extension/content.js:286`, `extension/content.js:291`, `extension/content.js:361`). The unchanged scroll-lock key listener may still intercept Space during capture (`extension/content.js:81`); README must limit its claim to OCR confirmation.

### 6.2. One lookup and four presentation states

At each overlay creation, initialize the hint to `checking` synchronously and issue exactly one `{type: 'commands:binding'}` request. Do not wait for it to draw the overlay, acknowledge `selection:start`, or handle confirmation. Attach both promise failure handling and an enclosing synchronous `try/catch` around `chrome.runtime.sendMessage`. Either a rejected promise or a synchronous throw transitions that overlay's binding state to `unavailable`, subject to the ownership/diagnostic checks below.

**Decision — response normalization:** accept `assigned` only with a nonempty string `label`; accept `unassigned` and `unavailable` as their respective states. Missing/undefined/malformed replies, unknown state names, or `assigned` with a missing/empty/non-string label become `unavailable`. Rationale: transport/route failure must not masquerade as an intentionally cleared shortcut. Do not trim, translate, or reconstruct a valid label; render it with `textContent`, not HTML.

**Decision — exact text:** use the following strings, with single spaces between sentences, Unicode ellipsis `…`, and the displayed curly quotes. Newlines caused by wrapping are layout, not inserted text. Rationale: these strings instantiate the design's templates while retaining its fresh/saved distinction. `{L}` is replaced by the exact nonempty reply label, with no braces.

| UI state | Fresh-region exact `textContent` | Restored-saved-region exact `textContent` |
| --- | --- | --- |
| `checking` | `Drag to select OCR region. Confirmation shortcut checking… Set it at chrome://extensions/shortcuts. Esc to cancel.` | `Drag to adjust. Confirmation shortcut checking… Set it at chrome://extensions/shortcuts. Esc to cancel.` |
| `assigned` | `Drag to select OCR region. {L} to confirm. Esc to cancel.` | `Drag to adjust. {L} to confirm. Esc to cancel.` |
| `unassigned` | `Drag to select OCR region. Confirmation shortcut not set; set “Confirm selected OCR region” at chrome://extensions/shortcuts. Esc to cancel.` | `Drag to adjust. Confirmation shortcut not set; set “Confirm selected OCR region” at chrome://extensions/shortcuts. Esc to cancel.` |
| `unavailable` | `Drag to select OCR region. Confirmation shortcut unavailable; check “Confirm selected OCR region” at chrome://extensions/shortcuts. Esc to cancel.` | `Drag to adjust. Confirmation shortcut unavailable; check “Confirm selected OCR region” at chrome://extensions/shortcuts. Esc to cancel.` |

For example, an assigned fresh overlay with label `Ctrl+Shift+Space` renders `Drag to select OCR region. Ctrl+Shift+Space to confirm. Esc to cancel.` The hint must never name the **confirmation shortcut** before the binding reply arrives; `Esc to cancel` is intentional in every binding state. There is no temporary default/legacy confirmation label.

**Decision — initial verb:** choose the fresh/saved prefix using the existing saved-region validity branch (`extension/content.js:132`) and keep that prefix for the overlay's lifetime, including after diagnostic dismissal by adjustment. Rationale: existing code chooses the wording once at creation (`extension/content.js:139`, `extension/content.js:142`); changing that policy is unnecessary.

The state transition is `checking → assigned | unassigned | unavailable`. There is no binding refresh while that overlay remains open. Chrome may apply a reassignment immediately; the hint obtains a new snapshot when the user reopens selection, as required by the approved design's ownership/snapshot rule (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:306`).

### 6.3. Overlay ownership and diagnostic precedence

**Decision — presentation storage:** keep the initial verb, binding state, and active diagnostic in presentation-only state belonging to that overlay, capturing its existing overlay DOM object as the owner. Rationale: DOM identity prevents stale repaint without adding selection identifiers, selection fields, messages, or capture state. Do not reuse one hint object or one owner across successive overlays.

Apply both invariants at **both** check points:

1. **Binding fulfillment/failure handler:** compare the captured owner to the current `overlay`. If different or closed, discard the result. For the current owner, normalize/store the binding result, but do not schedule or perform a binding repaint while its diagnostic is active.
2. **Hint paint function immediately before writing `textContent`:** recheck current-owner identity and diagnostic ownership. A binding paint returns without writing if the owner is no longer current or a diagnostic is active. This applies to initial/reply/failure repaint and to any deferred paint the implementer uses.

When the existing completion catch displays `${error.message} Adjust the region and try again.` (`extension/content.js:299`), mark that current overlay's diagnostic active before writing it. A binding reply arriving afterward may update its stored binding result but must leave that diagnostic visible. If the binding paints first and a confirmation then fails, the diagnostic replaces it and owns the hint. Preserve the existing diagnostic text; it is a separate error presentation, not a fifth binding state.

Dismissal clears the overlay's presentation state. **Decision — adjustment boundary:** clear an active diagnostic only after a trusted pointer-down or pointer-move actually changes at least one of `x`, `y`, `width`, or `height`, then repaint the current binding state. Rationale: this gives “adjust the region” a concrete boundary and does not let a click without adjustment or an untrusted event erase the error. Hook only presentation clearing around the existing mutations (`extension/content.js:192`, `extension/content.js:205`); preserve geometry and trust logic. With no reply yet, adjustment restores `checking`; with a stored reply, it restores that state. No polling or timer is necessary.

### 6.4. Wrapping

In both `.textkit-hint` rules, delete `white-space: nowrap` and add exactly:

```css
max-width: calc(100vw - 32px);
overflow-wrap: anywhere;
```

The two owners are `OVERLAY_STYLES` (`extension/content.js:101`) and the external stylesheet (`extension/overlay.css:40`). Preserve their other styling. Checking only the external CSS is insufficient because overlay markup installs the inline stylesheet in its closed shadow root (`extension/content.js:112`, `extension/content.js:113`).

## 7. Delivery-time semantics and residual risks

**A command confirms whatever overlay is present in its resolved tab when `selection:confirm` arrives.** It does not identify what the user saw at keypress time. Neither the message nor an extra identity lookup can supply invocation context that the command event did not carry. The content function snapshots the region and viewport on its synchronous call (`extension/content.js:272`); its later two-frame completion remains unchanged.

| Documented interleaving | Required outcome | Control / tests in §9 |
| --- | --- | --- |
| 1. Same-document A → B | Hold delivery while A is visible; dismiss A and start B in the same document; delayed delivery confirms B's current rectangle/token. It does not restore or target A. | Live-A control C28; replacement C29. |
| 2. Optional-tab/focus race | With supplied tab T, switching focus to U does not retarget the message: T receives it. Without a supplied ID, the single query's returned tab wins, so a query resolving to U targets U. It may act in a tab the user has left. | W01/W02 controls; W17/W18 switches. |
| 3. Replacement document | Frame 0 denotes the current top document. Failed delivery, or delivery to a replacement document with no overlay, has no confirmation effect. If a new selection was started in that replacement document before delivery, the message confirms that overlay, subject to normal worker admission. | C31 empty document; C32 new overlay; W05 failed delivery; C28 live control. |
| 4. No overlay at press, overlay at delivery | A delayed message from a press with no overlay can confirm one started before delivery. If delivery happens before any overlay exists, it is a no-op. “Stray press is harmless” is conditional on no overlay at delivery. | C30 versus C03; C28 live control. |
| 5. Region adjusted after press | If the rectangle or viewport changes before delivery, completion contains the current rectangle and delivery-time viewport/DPR, not the keypress-time values. | C33 versus C28 without adjustment. |

What remains true in every case:

- Capture admission through this trigger requires an existing overlay created by `selection:start`, a valid local rectangle, and worker `Selecting` state plus the matching single-use token (`extension/content.js:29`, `extension/content.js:270`, `extension/background.js:389`). A content confirmation attempt can still be rejected by the worker; an attempt is not admission.
- A valid overlay may contain a **restored saved region**, with zero pointer events on that page (`extension/content.js:132`). The bound is an existing rectangle in a selection-start-created overlay, not a rectangle drawn on that page. Test it by confirming **before the user draws or adjusts** the restored region. Do not say “before the overlay is drawn”: creation and drawing are synchronous (`extension/content.js:110`, `extension/content.js:145`).
- A tab with no live overlay cannot be made to create one by `selection:confirm`; that route only calls the existing function (§6.1). If worker state/token is lost, completion is rejected (`extension/background.js:389`).
- One message hop through the service worker describes routing, **not a wall-clock bound**. Optional querying, worker wakeup, delivery scheduling, and frame scheduling have no deadline in this change. The existing capture pipeline may pause an inactive target until it becomes active (`extension/background.js:1416`, `extension/background.js:1430`, `extension/background.js:1449`).

Residual-risk labels used in §8: **R1** is the introduced/widened delivery-time risk with the five subcases above; **R2** is the binding hint snapshot until reopening; **R3** is inherited loss of worker selection state/token on suspension/restart; **R4** is inherited Space interception by capture scroll lock. The latter two follow the in-memory state initialization/recovery and scroll-key code (`extension/background.js:183`, `extension/background.js:203`, `extension/background.js:2259`, `extension/content.js:81`). These are accepted limits, not instructions to extend the lifecycle.

## 8. Error behavior matrix

“Started” distinguishes a content confirmation attempt from worker capture admission. A binding lookup alone starts neither. Tests observe completion messages separately from the extra binding message.

| Condition | Observable behavior | Anything started? | Residual risk |
| --- | --- | --- | --- |
| No overlay at delivery | Content replies `{ok: true}`; existing guard emits no completion and creates no overlay. | No attempt or capture. | R1.4 applies only if an overlay exists by delivery instead. |
| No content script in target tab | `tabs.sendMessage` rejects; command task swallows it with no UI/state change. | No. | None for failed delivery. |
| Tab query fails | Single fallback rejects; branch returns silently with no send or retry. | No. | R1.2 applies to a successful focus-dependent fallback, not this rejection. |
| Tab query succeeds but yields no usable tab (empty result, or a tab without `id`) | Branch returns silently; no send, no retry, no state change. | No. | None; delivery never occurs. |
| Confirmation `sendMessage` rejects | Worker swallows rejection; no error state, permission prompt, injection, or direct pipeline call. This row concerns worker → content delivery; binding transport failure is below. | No capture started by the failed delivery. | A replacement document receiving a successful delivery instead follows R1.3. |
| Confirmation already pending | Route still replies `{ok: true}`; existing `confirmPending` guard prevents a second completion. | No additional attempt/capture; the first may finish. | No new risk; existing pending path preserved. |
| Region too small | Route replies `{ok: true}`; guard leaves overlay visible and usable, with no completion or new size diagnostic (`extension/content.js:270`). | No; later valid adjustment can confirm. | None specific to this rejection. |
| Page navigated | Failed delivery or current-document delivery with no overlay is a no-op. A replacement document with a newly started valid overlay can emit completion and be admitted with its matching worker state/token. | Conditional: new overlay can be confirmed; navigation alone starts nothing. | R1.3; normal stale-token rejection still applies. |
| Shortcut unassigned | Binding row with `shortcut: ''` yields the exact not-set hint and shortcuts-page guidance. There is no physical command dispatch while unassigned; reassign and reopen to refresh. | No from clearing/lookup. | R2 until reopened; no popup confirmation fallback is introduced. |
| Binding lookup unavailable | Missing row, rejected/throwing `getAll`, rejected/throwing content send, or malformed reply yields exact unavailable hint, unless an active diagnostic owns it. An assigned command may still dispatch. | Lookup starts nothing; a separate valid command can confirm. | R2; inability to read a label does not imply inability to dispatch. |
| Completion rejected by the worker | The worker's existing admissions each reply `{ok: false, error}` and start nothing: no sender tab at `extension/background.js:379`; invalid region shape at `extension/background.js:383`; stale/unauthorized state or token at `extension/background.js:390`. The content catch restores the overlay and writes the diagnostic (`extension/content.js:295`). | No capture. | None new; these are the existing rejections, unchanged by this feature. |
| Worker suspended/restarted | Confirmation route does not await readiness. Content still calls the same function; a completion without matching worker `Selecting`/token is rejected with the existing stale/unauthorized error, and its catch restores the overlay/diagnostic (`extension/background.js:389`, `extension/content.js:295`). | A local attempt can start; admission still requires matching worker state/token. No promise of restored selection authorization. | R3, inherited; R1 scheduling remains possible. |

## 9. Test fixtures, suites, and execution

### 9.1. Pinned output fixture

Create `tests/fixtures/selection-complete-baseline.json` during implementation by executing the **pre-change** positive test named `selection confirmation uses double-requestAnimationFrame before sending` from pinned commit `c47dec6a24b42bcdb25f2c4fbe731deca8ce4431`. That test begins at `tests/content.test.js:334`; its trusted-keydown double is at `tests/content.test.js:426`. Do not derive the fixture by executing the changed content route or hand-authoring an expected region from the new implementation.

**Decision — recording seam:** load the pinned `tests/content.test.js` and `extension/content.js` blobs with read-only `git show`, run that named test in memory with its original content source, and wrap its runtime `sendMessage` stub solely to record `selection:complete` while delegating to the original stub. Intercept its content-file read to supply the pinned source, and select the original named test without altering its callback or event inputs. Await its existing assertions, require exactly one recorded completion, and serialize that message with two-space JSON indentation and a final LF to the fixture path. No extra recorder file is part of the inventory. Rationale: this runs the real baseline test without checking out history or letting the changed source generate its own oracle.

The fixed inputs already exist: viewport `1200 × 800` at `tests/content.test.js:367`–`368` and DPR `1` at `tests/content.test.js:370`; token `confirm-token` at `tests/content.test.js:397`; trusted pointer-down at `(100,100)` and move to `(300,250)` at `tests/content.test.js:404` and `tests/content.test.js:410`. The exact recorded fixture is:

```json
{
  "type": "selection:complete",
  "region": {
    "x": 100,
    "y": 100,
    "width": 200,
    "height": 150,
    "viewportWidth": 1200,
    "viewportHeight": 800,
    "devicePixelRatio": 1
  },
  "selectionToken": "confirm-token"
}
```

Drafting verification executed this pinned test in memory and obtained exactly that payload; it created no fixture. Implementation must still include the resulting fixture in its delivery. Post-change C01 drives the public `selection:confirm` route and deep-compares the entire emitted completion to this file; convert VM objects to plain JSON for realm-independent equality, but omit or rewrite no fields. Timing is tested separately; there is no timing field to filter out of the fixture.

This is a **fixed-input output oracle**, covering token, region, viewport, DPR, and message shape. It does not prove implementation identity: a different implementation reproducing these inputs' output would pass. Source-review check V01 establishes that the route still calls the same function and preserves its mechanism. The baseline's `{isTrusted: true}` plain object (`tests/content.test.js:426`) is a test double, not a browser-trusted event. It proves content handling under those inputs; real keyboard dispatch is manual only (§9.5).

### 9.2. Harness rules and case accounting

Specify **67 test cases**: F01 (1), W01–W23 (23), C01–C37 (37), E01–E02 (2), and M01–M04 (4). Of these, 63 are automated and four require headed manual execution. V01–V03 are three additional source-review checks, not test cases. IDs describe independently asserted obligations; an existing test may contain several IDs without artificially increasing the reported test runner count. Retain the rest of the baseline tests as regressions; the IDs are not a replacement for the full suites.

**Decision — deterministic seams:** extend only test-local helpers in the existing test files. Capture listener return values, response counts, tab-query arguments, and all three `tabs.sendMessage` arguments; provide controllable promises and a frame callback queue. Rationale: each ordering can be proven without elapsed-time guesses or production-only test hooks. Current event emitters discard returns (`tests/content.test.js:12`, `tests/background.test.js:45`); the worker harness's `sendMessage` records two arguments (`tests/background.test.js:160`) and its command mock has no `getAll` (`tests/background.test.js:167`), so those test doubles need extension.

Use existing worker harness/`deferred()` patterns (`tests/background.test.js:56`, `tests/background.test.js:12`). Allow stubbing the active-tab query after harness initialization; distinguish startup's `tabs.query({})` (`extension/background.js:243`) from the confirmation branch's `{active: true, currentWindow: true}` query. Either settle startup first or clear unrelated call logs; never count background recovery traffic as command traffic. W07 deliberately installs an unresolved readiness promise after initialization to prove that command delivery is independent.

Content tests must return a stubbed reply based on message `type`, with a separate controllable binding promise and completion promise. Count/filter `selection:complete` messages, not total runtime sends: opening an overlay now sends the binding request. The current positive and small-region tests count all sends (`tests/content.test.js:422`, `tests/content.test.js:626`), which must be adapted. Give each created overlay its own DOM/shadow-root/selection/hint stub; current hint stub is at `tests/content.test.js:343` and the single-overlay stub at `tests/content.test.js:353`. Record callback admission and run exactly one frame batch at a time as the baseline test does (`tests/content.test.js:384`, `tests/content.test.js:435`). Hold messages explicitly until their chosen delivery point; do not add production timers or identity requests to make a test ordering possible.

For every negative case, the control column names an admitted/working path. Run that control with equivalent stubs and relevant valid state; asserting an empty log alone is insufficient. For rejection tests, observe promise settlement/unhandled-rejection failure as well as the functional result. Test doubles may model otherwise unusual failures, such as a synchronous API throw, but are not evidence of physical browser input.

| ID | Fixture case and required evidence | Positive control |
| --- | --- | --- |
| F01 | Execute the pinned original trusted-keydown test using the recording seam in §9.1; require one completion exactly equal to the displayed JSON before creating the fixture. | Original baseline's positive test; post-change C01 command/fixture success. |

### 9.3. Worker suite — `tests/background.test.js`

| ID | Case, setup, and required assertions | Positive control |
| --- | --- | --- |
| W01 | Supplied-tab routing: emit `confirm-region-capture` with `{id: 11}`. Record exactly one send to 11 with exactly `{type: 'selection:confirm'}` and `{frameId: 0}`, zero confirmation fallback queries, and no direct pipeline call. | This is the supplied-tab delivery control. |
| W02 | Missing-tab routing: emit without the second argument; resolve the one exact active/current-window query to `[{id: 11}]`. Assert one top-frame confirmation send to 11 and no second query. | This is the successful fallback control. |
| W03 | Reject that fallback query. Assert no send, retry, state update, direct capture, or escaped rejection. | W02 successful fallback. |
| W04 | Resolve the fallback to `[]`, then in another isolated invocation to `[{}]`. Neither sends; each invocation performs exactly one query. | W02 successful fallback. |
| W05 | Reject the confirmation send as `no receiver`/missing content script. Assert it is swallowed and there is no direct capture, injection, permission request, error update, or second send. | W01 successful delivery; C01 live receiver. |
| W06 | Emit an unrelated command name. Assert no confirmation send, lookup, query, state change, or capture. | W01 recognized command. |
| W07 | Replace readiness with an unresolved promise; emit confirm with a supplied tab. Before resolving readiness, require the top-frame send. State/storage/permission/injection logs remain unchanged by this branch. | W01 delivery; W08 demonstrates the retained readiness gate on launch. |
| W08 | Existing launch control: hold readiness, emit `start-region-capture`, require no launch query until released, then verify original permission/injection/snapshot flow, `Selecting`, token, and unchanged start request. Retain existing active-capture rejection and permission-denial assertions, paired with this admitted launch. | This is the admitted launch control; existing cases are at `tests/background.test.js:1122`, `tests/background.test.js:1139`, and `tests/background.test.js:1160`. |
| W09 | Binding assigned: return a decoy start row followed by `{name: 'confirm-region-capture', shortcut: 'Alt+Shift+O'}`. Capture literal listener return `true`, defer fulfillment, then require exactly one `{state: 'assigned', label: 'Alt+Shift+O'}` with no extra fields. | This is the successful binding control. |
| W10 | Exact confirm row with `shortcut: ''`: return literal `true`, reply once with exactly `{state: 'unassigned'}` and no label. | W09 assigned lookup. |
| W11 | Return only the start/decoy rows: return literal `true`, reply once with exactly `{state: 'unavailable'}`. | W09 exact-name success. |
| W12 | `getAll()` returns a rejecting promise: literal `true`, exactly one unavailable reply, no escaped rejection. | W09 fulfilled lookup. |
| W13 | `getAll()` throws synchronously: unavailable reply occurs before listener invocation returns, exactly once; the listener still returns literal `true`. | W09 fulfilled lookup; W12 separately exercises promise rejection. |
| W14 | Latch totality: a test-only thenable calls fulfillment with the W09 row and then invokes its catch handler (or throws after fulfillment). Assert exactly one assigned reply despite the second path, and literal `true`. | W09 normal single fulfillment. |
| W15 | Parse manifest and deep-compare its complete commands object to §3. Compare the remainder to the pinned manifest: no permission/host/CSP/version changes. | E01 real accepted declaration/registration; W01 and W08 exercise both names. |
| W16 | Existing completion positive: seed `Selecting` and token `expected`; send valid region/token with a sender tab; spy on `runCaptureLoop`. Require token consumption, unchanged saved rectangle, `{ok: true}` before pipeline invocation, literal `false`, and exactly one pipeline invocation. | This is the worker admission control. |
| W17 | Supplied-tab focus switch: hold delivery for T=11, move focus to U=12, then deliver to T's live content receiver. Assert U receives no confirmation and T emits its own token/region. Return T to active before asserting a real capture if using the unchanged pipeline. | W01 without focus switch, plus C28 live overlay. |
| W18 | Fallback focus switch: omit tab; hold the active query, change focus, resolve it to U=12, and deliver to U's live receiver. Assert exactly one query, U receives/uses its region/token, and T receives nothing. | W02 without focus switch, plus C28 live overlay. |
| W19 | Send an invalid-shape region together with a wrong token. Require exact `Invalid selected region.` response and existing Error-state update, with no pipeline call, proving shape check still precedes token check. | W16 valid region/token admission. |
| W20 | Existing stale-token regression: valid region, worker `Selecting` with token `expected`, request token `forged`. Require exact stale/unauthorized reply, no capture, and token retained. | W16 matching-token admission; existing stale test at `tests/background.test.js:1586`. |
| W21 | Deliver W16's completion again with the consumed token; require stale/unauthorized and no second pipeline call. | W16 first single-use admission. |
| W22 | With valid region/token from an old selection, deliver to a fresh worker harness (`Idle`, null token), and separately to non-`Selecting` state with that token. Both reject stale/unauthorized without capture; do not repair/persist a selection. This covers suspension/restart authorization loss. | W16 matching `Selecting`/token admission; W07 proves dispatch itself is not readiness-gated. |
| W23 | Valid region/token but no `sender.tab.id`: exact `No sender tab found.`, literal `false`, no pipeline call. | W16 sender-tab admission. |

For W17/W18, compose the test-local worker send stub with content VM receivers, or combine the observed routing result with an explicitly invoked real content receiver in the same test. Do not replace the receiving confirmation function with a fake that would conceal its output. Supporting VM helpers stay inside the existing test files; there is no additional harness artifact.

### 9.4. Content suite and automated Chromium owner

The normal content setup uses fixture rectangle R=`{x:100,y:100,width:200,height:150}` and token `confirm-token` unless a row supplies different values. A “successful completion” below means one message after two frames and a stubbed `{ok:true}` admission reply; worker admission itself is tested by W16. Diagnostic setup rejects completion with `Selection confirmation is stale or unauthorized.` so the visible diagnostic is exactly `Selection confirmation is stale or unauthorized. Adjust the region and try again.`

| ID | Case, setup, and required assertions | Positive control |
| --- | --- | --- |
| C01 | Start and draw the fixed baseline selection. Deliver `selection:confirm` via the actual listener. In the same turn require `{ok:true}`, literal `false`, hidden overlay, and no completion. After frame 1 still none; after frame 2 exactly one completion deep-equal to the fixture; accepted reply removes the overlay. A second immediate message proves synchronous pending admission in C02. | This is command/fixture success, including the two-frame positive control. |
| C02 | Send two confirms before either frame, then another while awaiting completion response. Each route replies `{ok:true}`/`false`; only the first queues confirmation and there is exactly one completion overall. | C01 single admitted confirmation. |
| C03 | Deliver confirm before any selection and again after a live overlay is dismissed with `selection:cancel`. Require `{ok:true}`/`false`, zero frames/completions, no new overlay, and no restoration. Start a valid selection afterward and confirm successfully. | C01 live overlay; the case's later successful confirmation. |
| C04 | Start without `selectionToken`; require exact missing-token error and `false`. A following confirm sends no completion. Repeat for empty/non-string token as table-driven inputs. A later valid start/confirm works; no hidden module-field setter is needed to invent a tokenless overlay. | C01 valid start/token. |
| C05 | Rewrite the former small-region key test: draw from `(100,100)` to `(104,104)`, deliver the message, require no frame/completion and a visible usable overlay. Adjust to R and require successful completion. Filter binding traffic. | C01 valid region and the case's subsequent adjusted-region success. |
| C06 | Draw exactly `10×10`; message confirmation succeeds, preserving the existing inclusive `MIN_SIZE` boundary. | This is the threshold success control for C05. |
| C07 | With a valid overlay, call the actual key listener with the original trusted Ctrl+Space double. Require no completion/frame and no `preventDefault` from the selection handler. Direct page delivery of Ctrl+Shift+Space also adds no page confirmation path. Then `selection:confirm` succeeds. | C01 command success on the same valid selection. |
| C08 | Before confirmation, trusted Escape removes the overlay and sends exactly `{type:'selection:cancelled',selectionToken:'confirm-token'}`; a later confirm is a no-op. Keep this regression assertion. | This is successful Escape cancellation; C01 confirms instead. |
| C09 | Untrusted and missing-trust Escape doubles do not remove a valid overlay or send cancellation; subsequent command confirmation succeeds. | C08 trusted Escape; C01 command success. |
| C10 | After confirm but before frames, send trusted Escape. Require no cancellation/removal/token clearing; after two frames completion still carries the original token exactly once. | C08 Escape when idle; C01 completion after frames. |
| C11 | Fresh overlay with deferred lookup shows the exact fresh `checking` string synchronously. It includes `Esc to cancel`, no confirmation binding, and exactly one lookup. | C13 successful assigned transition after the same deferred request. |
| C12 | Restored overlay with deferred lookup shows the exact saved `checking` string synchronously and one lookup; region is already drawn. | C14 successful saved assigned transition. |
| C13 | Resolve current fresh lookup with `{state:'assigned',label:'Alt+Shift+O'}`; require exact fresh assigned string, using the reported label rather than a default. | This is fresh binding-paint success. |
| C14 | Resolve current saved lookup with the same label; require exact saved assigned string. | This is saved binding-paint success. |
| C15 | Fresh lookup replies `unassigned`; require the exact fresh not-set string, shortcuts URL, and Escape guidance. | C13 assigned fresh label. |
| C16 | Saved lookup replies `unassigned`; require the exact saved not-set string, preserving `Drag to adjust`. | C14 assigned saved label. |
| C17 | Fresh lookup replies `unavailable`; require exact fresh unavailable text distinct from unassigned. | C13 assigned fresh label. |
| C18 | Saved lookup replies `unavailable`; require exact saved unavailable text distinct from unassigned. | C14 assigned saved label. |
| C19 | Content `runtime.sendMessage` rejects for binding lookup. Require transition from checking to unavailable without escaped rejection; confirmation still works when its separate response succeeds. | C13 lookup success; C01 confirmation independent of lookup. |
| C20 | Content `runtime.sendMessage` throws synchronously for binding lookup. Require unavailable immediately, usable overlay, and no escaped exception/checking hang. | C13 lookup success; C01 confirmation independent of lookup. |
| C21 | Resolve lookup with `undefined`, null, unknown state, or assigned with empty/missing/non-string label in isolated inputs. Each normalizes to unavailable, never empty/default assigned wording. | C13 valid nonempty assigned reply; C15 intentional unassigned reply. |
| C22 | Open A, defer A binding, close it, open B with its own pending lookup. Resolve A while B is checking: neither B nor detached A is repainted. Then B's own reply paints B. | C13 current-owner success; B's own reply in this case. |
| C23 | Open A, replace with B, resolve B assigned first, then settle A's stale success or rejection. B's assigned text remains unchanged; stale failure does not paint unavailable. | C13 current-owner success; C19 current-owner failure. |
| C24 | Keep binding pending, confirm, reject completion to show the exact diagnostic, then resolve assigned binding. Diagnostic must remain; latest binding result is cached for later adjustment. | C13 assigned reply with no diagnostic; C35 rejection/restoration. |
| C25 | Resolve binding first, then reject completion. The diagnostic replaces binding text and remains authoritative; no binding repaint erases it. | C13 normal assigned paint; C35 rejection/restoration. |
| C26 | With active diagnostic, untrusted input and a trusted click/move that changes no coordinate leave it visible. A trusted actual rectangle change clears it and paints the cached binding state; repeat with binding still pending to recover checking. | C13 ordinary paint; actual-adjustment success in this case; C24 active-diagnostic protection. |
| C27 | Dismiss an overlay with diagnostic; reopen. Require a new owner, no inherited diagnostic, checking immediately, and a single new lookup. A changed reply label paints the new label; while an overlay remains open there is no automatic re-query. | C13 current reply paints; C24 keeps an undismissed diagnostic. |
| C28 | Live-A delivery control: hold one confirm, keep overlay A/token `A` and R unchanged, deliver, flush frames, and require exactly A/R with the original viewport/DPR. | This is the live-A/no-adjustment control for delivery races. |
| C29 | Same-document A→B: queue for A, dismiss it, start B/token `B` with saved `{x:30,y:40,width:80,height:60}`, then deliver. Require only B's completion; no A restoration or token/payload substitution. | C28 live-A delivery. |
| C30 | Queue when no overlay exists; start B with the C29 rectangle/token before delivery. Delayed message confirms B. | C03 delivery before any overlay; C28 live overlay. |
| C31 | Replacement-document negative: discard original content VM A, construct a fresh VM for the same tab's new top document with no overlay, then deliver. Require no completion/overlay creation. | C32 replacement document with a started overlay; C28 live overlay. |
| C32 | Replacement-document positive: in that fresh VM, first send valid `selection:start` with token `new-doc` and saved C29 rectangle, then deliver old queued confirm. Require completion with `new-doc` and the new rectangle. Pair worker acceptance with matching new `Selecting` state in W16; do not assume navigation creates authorization. | This is the replacement-document live-overlay control for C31. |
| C33 | Queue with A/R, then trusted-move inside the region from `(150,150)` to `(170,180)` and release: region becomes `{x:120,y:130,width:200,height:150}`. Before delivery set viewport `1000×700`, DPR `2`; deliver and assert those delivery-time values. | C28 unchanged R/viewport/DPR. |
| C34 | Fresh VM starts with saved R and a valid token; assert styles already draw R after `selection:start`. Confirm before the user draws or adjusts it; assert zero pointer events and the fixture geometry/token/viewport/DPR. | C01 drawn-region success; this is saved-region/zero-pointer success. |
| C35 | Reject a valid completion response with the exact stale/unauthorized error. Require pending cleared, overlay visible, exact existing diagnostic, no automatic re-send; a subsequent independently stubbed accepted confirmation can complete. This tests content error handling, not restored worker authorization. | C01 accepted completion; later accepted response in this case. |
| C36 | Read both style sources. In each hint rule require `max-width: calc(100vw - 32px)` and `overflow-wrap: anywhere`, and no `white-space: nowrap`. Inspect the closed-root injected style text as well as the external asset. | M04 visible narrow-window wrapping; C13 normal hint rendering. |
| C37 | Retain closed-shadow-root and untrusted-pointer rejection assertions from `tests/content.test.js:48`; untrusted pointer input must not change the rectangle or pointer capture. | C01 trusted draw/confirm; C34 saved-region confirmation. |

`tests/extension_e2e.test.js` owns **both** the declaration and effective registration assertion. Extend the existing unpacked-extension load/restart smoke test (`tests/extension_e2e.test.js:65`), whose snapshot already calls `chrome.runtime.getManifest()` (`tests/extension_e2e.test.js:129`) and whose CDP evaluation supports awaited promises (`tests/extension_e2e.test.js:157`). Do not create another E2E file or treat a manifest parse alone as registration evidence.

**Decision — registration expectations:** use a fresh existing temporary profile, run Chromium with `--lang=en-US`, obtain `chrome.runtime.getPlatformInfo()` and awaited `chrome.commands.getAll()` in the extension context using CDP `Runtime.evaluate` with `awaitPromise: true`/`returnByValue: true`. Rationale: this checks effective registration separately from manifest data and gives reproducible display labels. Compare manifest strings exactly as §3; independently compare each returned command's effective `shortcut` to this platform table. Under en-US, macOS uses the rendered modifier glyphs shown below; do not compare a macOS display label to the manifest's `Command+Shift+...` spelling. Chromium's display conversion is documented in its [accelerator source](https://github.com/chromium/chromium/blob/main/ui/base/accelerators/accelerator.cc).

| Runtime platform | Manifest expected start/confirm `suggested_key` value selected for platform | `getAll()` expected effective start `shortcut` | `getAll()` expected effective confirm `shortcut` |
| --- | --- | --- | --- |
| `mac` | `Command+Shift+S` / `Command+Shift+Space` from `mac` | `⇧⌘S` | `⇧⌘Space` |
| Other supported Chromium platforms | `Ctrl+Shift+S` / `Ctrl+Shift+Space` from `default` | `Ctrl+Shift+S` | `Ctrl+Shift+Space` |

Require one exact-name row for each command with the declared description, a nonempty effective shortcut, and the expected value above. An empty or different effective shortcut fails this assertion; do not substitute the manifest default or downgrade to checking only name presence. A smoke-test skip due to unavailable Chromium is not registration evidence and must be reported as unverified.

| ID | E2E case and required assertions | Positive control |
| --- | --- | --- |
| E01 | Load unpacked MV3; assert the full declared commands object, including both `default` and `mac`, descriptions, and unchanged permissions; independently await `getAll()` and assert both effective shortcuts against the platform table. | Both registered command rows are the positive controls; W15 supplies static declaration comparison. |
| E02 | Retain popup-load semantics, least-permission metadata, worker termination, wake by `popup:get-state`, and observed worker restart from the existing smoke (`tests/extension_e2e.test.js:134`, `tests/extension_e2e.test.js:154`, `tests/extension_e2e.test.js:157`). | Successful initial load and successful post-restart state response/reappearing worker. |

These automated assertions establish manifest acceptance and reported command registration. Headless registration does not demonstrate operating-system shortcut allocation or physical key dispatch. Physical dispatch is **manual only**; neither CDP-synthesized keys nor the baseline trusted-event double is a replacement.

### 9.5. Headed manual cases

Run with the unpacked extension and a functioning backend on a permitted normal page. Record browser version, OS, initial shortcuts-page rows, and observed results. Use the platform's launch/confirm defaults. Reopen selection after rebinding/clearing so the hint obtains a new snapshot. No additional product UI is needed.

| ID | Manual case and required observations | Positive control |
| --- | --- | --- |
| M01 | Record `chrome://extensions/shortcuts` rows; physically press default launch, draw/adjust, then physically press default confirm. Capture starts and the overlay disappears before screenshots. Also open a restored saved rectangle and confirm before drawing/adjusting it. | This is real default-dispatch success. |
| M02 | Change only `Confirm selected OCR region` to supported `Alt+Shift+O`; confirm immediate Chrome dispatch uses it, then reopen selection and verify the refreshed hint names it for fresh/saved overlay forms. The start row stays independent. | M01 defaults; successful reassigned physical dispatch in this case. |
| M03 | Clear confirmation, reopen, and observe exact not-set guidance. Physically press Ctrl+Space with a valid overlay: it does not confirm. Reassign and confirm successfully; check Escape still cancels when not pending. Do not infer that Space is inert during scroll-locked capture. | M01/M02 real confirmation; reassign-and-confirm and idle Escape in this case. |
| M04 | Narrow a headed window to about 360 CSS px wide. Inspect fresh/saved hints (including URL-bearing not-set state) for readable wrapping without offscreen text; restore a binding and verify its label also wraps as needed. | C13/C14 full hint rendering and visible normal-width M01; successful narrow wrapping in this case. |

### 9.6. Source review and full regression run

| Check | Required review evidence | Supporting controls |
| --- | --- | --- |
| V01 | Review the diff against `c47dec6a`: the new content route calls the original `confirmSelection()`; its guard, result snapshot, pending/hide, two frames, completion message, and acceptance/removal/error restoration are unchanged except diagnostic presentation routing. Both key guards/Escape body remain. | F01/C01 output oracle, C07/C08/C10 key regressions; source ownership at `extension/content.js:269`. |
| V02 | Compare protected worker completion/admission block and functions `handleStop`, `runCaptureLoop`, `recoverPersistedOperations`, and screenshot/capture helpers to the base. Require no new persistence/checkpoint or retry-state changes and no startup await in confirmation routing. | W07 independent delivery, W16/W19–W23 admission; existing full pipeline regression at `tests/background.test.js:1843`. |
| V03 | Check the artifact allowlist in §10, semantic legacy-reference rewrites, both style owners, exact strings, two ownership/diagnostic check points, README guidance, and unchanged approved-design hash. | W15 assets, C11–C27 hints, C36 wrapping, E01 registration, M01–M04 physical behavior. |

After implementation, run from repository root:

```sh
node --test tests/background.test.js tests/popup.test.js tests/content.test.js tests/extension_e2e.test.js
python -m pytest tests/ -v
git diff --check
```

Use the available locked-dependency Python environment if system Python lacks backend dependencies. The approved design records baseline evidence of 122 passing Node tests across those four files and 120 passing Python tests (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:377`, `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:378`); these are baseline observations, not a post-change target count or a claim that this drafting task reran Chromium/Python. Run all baseline regressions plus the new obligations, require passing available suites, record any skipped/unavailable validation honestly, complete manual checks, then perform the PM-required independent implementation audit. This draft verification ran only the read-only content suite (10 passed) and the in-memory pinned recording; Chromium was not launched during drafting.

## 10. Artifact inventory and README contract

This is the design's complete delivery inventory, one line per file. “Existing approved input” is included to account for the design's inventory; it is frozen and must not be edited. No other product, test, plan, ledger, dispatch, or history artifact is in scope.

| File | Delivery action and boundary |
| --- | --- |
| `extension/manifest.json` | Modify: add only the confirm command, preserving start and permissions (§3). |
| `extension/background.js` | Modify: extend existing command listener and add binding lookup route (§5); no other product behavior change. |
| `extension/content.js` | Modify: route confirm to existing function, remove Ctrl+Space branch, add hint state/ownership/diagnostic presentation and inline wrapping (§6); retain selection mechanism. |
| `extension/overlay.css` | Modify: remove hint `nowrap`, add the two wrapping declarations (§6.4). |
| `tests/content.test.js` | Modify: rewrite old confirmation/small-region triggers and add/retain C01–C37 obligations (§9.4). |
| `tests/background.test.js` | Modify: test-local harness extension and W01–W23 routing/binding/admission/manifest obligations (§9.3). |
| `tests/extension_e2e.test.js` | Modify: owner of unpacked manifest declaration **and** `getAll().shortcut` registration assertion, retaining smoke/restart (§9.4). |
| `tests/fixtures/selection-complete-baseline.json` | Create during implementation: F01's exact pinned completion payload (§9.1). |
| `README.md` | Modify: typical flow, capture controls, architecture wording, and short native-shortcut setup/snapshot explanation. |
| `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md` | Existing approved input: read only, keep the header hash exactly; no implementation edit. |
| `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-spec.md` | Create in this drafting task: this specification, the only new file authorized for the drafter. |

The six legacy **semantic references**, not a raw-text occurrence count, are:

| Reference | Required rewrite |
| --- | --- |
| `extension/content.js:139` | Saved-region hardcoded confirmation label → saved binding-state text. |
| `extension/content.js:142` | Fresh-region hardcoded confirmation label → fresh binding-state text. |
| `README.md:19` | Typical-flow confirmation instruction → effective/native default shortcut guidance. |
| `README.md:297` | Capture-control confirmation instruction → configured confirmation command guidance. |
| `tests/content.test.js:426` | Positive trusted Ctrl+Space confirmation → baseline recording source, then post-change command-route fixture comparison. |
| `tests/content.test.js:623` | Too-small Ctrl+Space confirmation → real message-driven guard rejection with valid-region positive control; prevent a vacuous pass. |

The adjacent comments at `tests/content.test.js:421` and `tests/content.test.js:621` are two additional **raw search hits**, and disappear with those test rewrites. The actual old branch at `extension/content.js:314` spells the key as `' '` plus `ctrlKey`, so it is not a literal `Ctrl+Space` hit. Audit both source behavior and text searches; do not enforce an incorrect raw count. After implementation, remaining legacy-key mentions may be deliberate removal-regression coverage and documentation saying Ctrl+Space no longer confirms, plus the design/specification's historical explanation; no remaining usage may instruct users/tests to confirm with the old key. C07 intentionally supplies the old event object as negative coverage.

README must state the two independent native command rows and both platform defaults; update the singular command architecture description at `README.md:272` and the two semantic instructions above. Its setup section must give these steps:

1. Open `chrome://extensions/shortcuts`.
2. Locate TextKit.
3. Edit `Confirm selected OCR region` independently of `Select a region and start OCR capture`.
4. Choose a Chrome-supported binding and reopen selection to refresh the hint.

Explain clearing/unassigned versus lookup-unavailable, the snapshot until reopening, and the absence of a popup confirmation fallback. State “Ctrl+Space no longer confirms an OCR region,” while preserving the qualification that Space interception for scroll lock during active capture is unchanged (`extension/content.js:81`). Keep README's saved-region behavior accurate (`README.md:294`): a restored region can be confirmed without drawing/adjusting it first.

## 11. Final-review clarifications and design consistency

These clarifications are explicit parts of the contract, not proposed redesigns:

| Final-review clarification | Resolution and enforcing sections |
| --- | --- |
| Navigation has a live-overlay exception | Only failed delivery or delivery into a replacement document without an overlay is a no-op. A newly started overlay in the replacement document can be confirmed with matching worker admission. §§5.1, 7, 8; C31/C32/W16. |
| “No key before reply” means no **confirmation shortcut** | `Esc to cancel` remains in all four binding states. Preserve both key guards and keep the Escape regression assertion despite unchanged behavior. §§2, 6.1–6.2; C08–C12. |
| Saved-region timing | Confirm before the user draws or adjusts the restored region; the overlay is synchronously created/drawn during start. §§2, 7, 9.1; C34. |
| Six-reference count | Count semantic references; comments at `:421` and `:621` are additional raw hits, and the source key branch is structural rather than a literal label. §10; C07/V03. |
| Declaration and registration both need an owner | Existing `tests/extension_e2e.test.js` asserts manifest `suggested_key` fields and independent effective `getAll().shortcut` values with platform expectations. Physical dispatch stays manual. §9.4; E01/M01–M03. |

Reportable wording inconsistencies in the frozen design are recorded here rather than silently propagated:

- `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:239` says “four shapes,” but its adjacent code and branch enumeration define **three** wire shapes. Its four states include local checking. §§4–6 explicitly pin three replies/four UI states, as the drafting brief requires.
- `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:330` says “never name a key,” although its exact hint templates include Escape (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:279`). The supplied final-review clarification limits that rule to the confirmation shortcut (§6.2).
- The saved-region test wording “before its overlay is drawn” at `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:334` conflicts with synchronous source drawing (`extension/content.js:145`). The supplied clarification replaces it with “before the user draws or adjusts” (§7, C34).
- The “no new Escape test is needed” sentence at `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:205` is not used to omit required regression evidence: the final-review brief expressly retains that assertion (C08/C10). No Escape production behavior is changed.

The design's semantic-six count and high-level E2E wording are made explicit above using the supplied clarifications. Historical pending-review labels are administrative, superseded by the drafting brief's approval at `56bf8a3`. No unresolved behavioral contradiction was found after applying those authoritative clarifications, and the approved design bytes remain unchanged.

## 12. Acceptance criteria and requirement traceability

An implementation audit can check these obligations directly:

- [ ] Only the inventory's implementation artifacts changed; the approved design hash matches the header and protected code checks V01/V02 pass.
- [ ] Manifest commands equal §3, including both platform keys/descriptions; permissions are unchanged; E01 independently checks effective registered shortcuts.
- [ ] Confirmation uses supplied tab first, at most one fallback query, frame 0, swallowed failed delivery, and no readiness wait/state/persistence/injection/permission path.
- [ ] Binding route uses exact command-name lookup, all five totality paths, a `replied` latch, and literal `return true`; content handles both rejection and synchronous throw.
- [ ] Content confirm route directly calls the existing function synchronously, replies only `{ok:true}`, returns `false`, and adds no selection fields/protocol.
- [ ] Old page confirmation branch is removed; both guards and Escape are retained and tested; fixture equality and double-frame checks pass.
- [ ] All eight fresh/saved hint strings equal §6.2; lookup happens once per overlay; owner/diagnostic checks exist at both reply and paint; both styles wrap.
- [ ] Error matrix, all five delivery-time interleavings, live-A control, replacement-document exception, and saved-region zero-pointer test match observed behavior.
- [ ] All 67 specified test obligations and three review checks have recorded outcomes, full available regressions pass, physical key tests are recorded separately, and required independent implementation audit is complete.
- [ ] README contains independent command setup/defaults, refresh-on-reopen behavior, and accurate old-key removal wording; all six semantic references are rewritten.

| Approved design requirement / location | Exact specification owner | Verification owner |
| --- | --- | --- |
| Native UI, supported default, unchanged launch (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:27`, `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:109`) | §§1, 3, 10 | W08/W15/E01; M01–M03 |
| Small trigger-only scope and non-goals (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:43`, `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:54`) | §§1–2, 10 | V01–V03; full regressions |
| Existing authorization order and post-admission equivalence (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:67`) | §§2, 4, 6.1, 9.1 | F01/C01/C02; W16/W19–W23; V01/V02 |
| Optional supplied tab, fallback, top frame, swallow, no readiness gate (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:130`) | §5.1 | W01–W08/W17/W18 |
| Arrival-time overlay semantics and five interleavings (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:163`) | §§7–8 | C03/C28–C34; W17/W18 |
| Shared confirm function, old-key removal, both key guards, response without result (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:191`) | §§4, 6.1 | C01–C10/C35; V01 |
| Binding lookup reply totality/latch/channel; both transport failure types (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:231`) | §§4, 5.2, 6.2 | W09–W14; C19–C21 |
| Four hints, fresh/saved distinction, no early confirmation key (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:279`) | §6.2 | C11–C21 |
| Per-overlay ownership and diagnostic precedence (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:297`) | §6.3 | C22–C27/C35; V03 |
| Snapshot until reopening and both stylesheet owners (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:306`) | §§6.2–6.4, 10 | C27/C36; M02/M04 |
| No-op/error cases and worker suspension limit (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:310`) | §§7–8 | W03–W05/W22; C02–C05/C19/C20/C31/C32/C35 |
| Paired negative/positive tests, pinned oracle and limitations (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:323`, `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:340`) | §§9.1–9.4 | F01, control columns, V01 |
| Semantic reference rewrites, full artifact ownership (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:346`, `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:349`) | §10 | V03; C07; E01 owner |
| Automated Chromium declaration/registration and manual dispatch (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:347`, `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:348`) | §§9.4–9.5 | E01/E02; M01–M04 |
| README setup and independent rows (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:362`) | §10 | V03; M01–M03 |
| Full regression evidence and final audit (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:360`, `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:373`) | §9.6; this checklist | Full Node/Python commands; independent implementation audit |
| Four accepted residual risks (`docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md:382`) | §§6.2, 7–8, 10 | W17/W18/W22; C27–C34; M02/M03 |
| Five final-review drafting clarifications | §11, with explicit enforcement references | C08/C10/C31/C32/C34; V03; E01 |

## 13. Open questions

None. The final-review clarifications resolve the recorded wording inconsistencies without changing the approved behavior. No deferred capture, cancellation, persistence, or recovery redesign is required to implement this specification.

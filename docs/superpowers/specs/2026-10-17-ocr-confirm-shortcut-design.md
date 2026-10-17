# Configurable OCR confirmation shortcut — design

Date: 2026-10-17
Status: Revised design draft; scope corrected to "replace the key trigger, not the confirmation mechanism"; pending independent review
Source and delivery target: `main`, pinned at `c47dec6a24b42bcdb25f2c4fbe731deca8ce4431`

## Problem and evidence

The OCR region overlay in `extension/content.js` confirms a selection through a hardcoded `event.key === ' ' && event.ctrlKey` handler. The same Ctrl+Space label is hardcoded into its new-region and saved-region hints and documented in README.md. fcitx5 commonly uses Ctrl+Space to toggle its input method, preventing reliable OCR confirmation.

The user wants the confirmation shortcut configured in Chrome's native Extensions Keyboard shortcuts page (`chrome://extensions/shortcuts`), alongside TextKit's existing capture-start command. The user initially suggested Alt+Enter; Chrome cannot register that key, so the approved supported default is Ctrl+Shift+Space. The existing OCR launch command remains Ctrl+Shift+S. This replaces the initial proposal for a custom popup control and Enter default.

## Verified platform constraint

Chrome's Commands API does not support Enter as a command key. The official supported-key list includes letters, numbers, and selected navigation/punctuation keys, but not Enter:

https://developer.chrome.com/docs/extensions/reference/api/commands#supported-keys

A read-only investigation used throwaway probe extensions, outside the delivery checkout, in installed Chromium 154.0.8037.97:

- Alt+Enter: extension fails to load with `Invalid value for 'commands[1].default': Alt+Enter.`
- Alt+Shift+O: extension loads successfully.
- Alt+Shift+Space: extension loads successfully.

Alt+Enter therefore cannot be the native command's suggested key. A separate page key handler could implement Alt+Enter, but Chrome's native shortcut editor would not configure that handler. The approved design uses one native configurable command with Ctrl+Shift+Space as its supported default; Chrome owns platform-specific display and editing.

## User decisions

- Delivery source and target: `main` (user selected inventory option 1).
- Settings location: Chrome's native Extensions Keyboard shortcuts page (explicit user correction).
- Default binding: **Ctrl+Shift+Space** for confirmation; the existing OCR launch binding remains **Ctrl+Shift+S** (with Chrome's existing macOS mapping).
- No custom popup control is proposed.

## Goals

- Replace the conflicting Ctrl+Space binding with a Chrome-supported default.
- Add a native Chrome command named `confirm-region-capture` with description `Confirm selected OCR region`.
- Let Chrome own shortcut editing, persistence, conflict handling, clearing, and scope controls.
- Confirm the current valid selection in the tab the command resolves for this invocation — Chrome's supplied tab when present, otherwise the focused tab at query time. A command that arrives while no selection exists is harmless; a command that arrives *after* a new selection was started confirms it, which is one of the documented delivery-time risks.
- Show the actual configured binding in the overlay for both new and saved regions.
- Leave every other part of the selection and capture contract exactly as it is today.

## Non-goals

This change replaces a key trigger. It does not redesign confirmation, cancellation, or capture recovery. Specifically unchanged and out of scope:

- The existing `selection:complete` / `selectionToken` handshake between the content script and the service worker, including its authorization order and its duplicate guard.
- The double-animation-frame delay before capture.
- Escape cancellation, the `Selecting` state, and the popup's Start/Stop behavior.
- Capture recovery, terminal-checkpoint durability, `retryState` eligibility, and screenshot/document atomicity.

These have their own pre-existing properties, reachable today through the keyboard shortcut and the popup buttons. Adding a second trigger for the same action must not change them, and this design verifies that it does not.

## Design scope

Three edits, plus documentation:

1. Declare one new command in `extension/manifest.json`.
2. Extend the existing `chrome.commands.onCommand` listener in `extension/background.js` with one new branch.
3. In `extension/content.js`, remove the Ctrl+Space key branch and accept a `selection:confirm` message that calls the *same* `confirmSelection()` function the key branch called; read the shortcut binding for the hint.
4. Update README.

Plus the artifacts those edits imply: new content tests, the pinned equivalence fixture, and the `overlay.css` wrapping rule beside the shadow-root one. The Verification section lists every file, fixture, and documentation artifact this change touches, so this scope line cannot be read as excluding them.

That is the whole change. The rest of this document explains why nothing more is needed.

## Why the confirmation mechanism does not change

The overlay already confirms through a single well-defined path:

```js
function confirmSelection() {
  if (confirmPending || !selectionToken || !region || tooSmall) return;
  const result = { ...region metrics... };
  confirmPending = true;
  overlay.style.display = 'none';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    chrome.runtime.sendMessage({ type: 'selection:complete', region: result, selectionToken })
      .then((response) => { if (!response?.ok) throw new Error(...); removeOverlay(); })
      .catch((error) => { confirmPending = false; overlay.style.display = ''; /* hint */ });
  }));
}
```

and the worker already validates it:

```js
if (!isValidRegion(message.region)) { /* reject */ }
if (state.status !== 'Selecting' || !state.selectionToken || message.selectionToken !== state.selectionToken) {
  sendResponse({ ok: false, error: 'Selection confirmation is stale or unauthorized.' });
  return false;
}
```

That pair is the authorization contract, and it is worth describing accurately rather than flatteringly: the token is single-use, the state must be `Selecting`, and the existing handler validates the region *shape* before the token check. This design does not change that ordering.

It is also not the security boundary it might appear to be. `isValidRegion` checks that the values are numeric (unary coercion means numeric strings pass), that width and height are positive, and that viewport dimensions are positive — it does **not** reject negative `x`/`y` and does not constrain the region to the viewport. It has no side effects, so running it first leaks nothing and authorizes nothing, but it is a shape check, not a bounds check. The handler's invalid-region branch does update UI state before the token check; that is pre-existing, and irrelevant here because the command never fabricates a region. Tightening either would be a separate change with its own risk, and this design does not need it.

**None of that depends on how confirmation was triggered.** The keyboard branch called `confirmSelection()`; the command branch will call `confirmSelection()`. Once a confirmation is admitted, the two are identical in every respect, because they are literally the same code path.

That equivalence has a precise boundary, and it is worth stating rather than overclaiming. It holds **after admission** — from the moment `confirmSelection()` runs. **Before** admission the two triggers genuinely differ: a keystroke runs in the page inside the key event, while a command crosses a service-worker hop and may include one `tabs.query`. A Stop, Escape, or a dismissal-then-reopen can therefore interleave in a way it could not for a keystroke.

What that interleaving can and cannot do is discussed in the next section. The message can reach any resolved tab, but delivering it into a tab with no live overlay cannot admit a capture, and it cannot invent a region; in the narrow races described there it can confirm an overlay other than the one the user was looking at when they pressed the key — including in a tab they have since left.

This is the correction that matters: an earlier revision of this document tried to redesign confirmation into a request/response protocol to make the *command* robust against worker suspension, Stop, and navigation. That was misdirected. The command does not need stronger guarantees than the keystroke it replaces — if confirming during a Stop race is imperfect today, it will be exactly as imperfect tomorrow, and fixing it is separate work. Scope discipline here is not laziness; it keeps a one-line trigger change from becoming a rewrite of the capture lifecycle.

## Architecture and data flow

### Manifest

Add a second command beside the existing one:

```json
{
  "commands": {
    "start-region-capture": {
      "suggested_key": { "default": "Ctrl+Shift+S", "mac": "Command+Shift+S" },
      "description": "Select a region and start OCR capture"
    },
    "confirm-region-capture": {
      "suggested_key": { "default": "Ctrl+Shift+Space", "mac": "Command+Shift+Space" },
      "description": "Confirm selected OCR region"
    }
  }
}
```

No new permissions. Chrome validates the suggested keys at load; `Ctrl+Shift+Space` is on the supported list, and `Alt+Enter` is not (see the verified constraint above).

### Service worker

The existing listener already handles `start-region-capture`; it grows one branch:

```js
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'start-region-capture') { /* unchanged, keeps its own awaits */ return; }
  if (command !== 'confirm-region-capture') return;
  void (async () => {
    let target = tab;
    if (!target?.id) {
      try { [target] = await chrome.tabs.query({ active: true, currentWindow: true }); }
      catch { return; }                            // query failed: nothing to confirm
    }
    if (!target?.id) return;                      // no tab: nothing to confirm
    try {
      await chrome.tabs.sendMessage(target.id, { type: 'selection:confirm' }, { frameId: 0 });
    } catch {
      // No content script, no overlay, or the page navigated: nothing to confirm.
    }
  })();
});
```

Three properties, and one deliberate omission:

- The command resolves its tab from Chrome's argument when available, so it confirms in the tab the shortcut was pressed in rather than whichever tab happens to be focused after an await.
- `frameId: 0` matches the top frame where the overlay lives.
- A failed `sendMessage` is swallowed. Absent content script, absent overlay, or a navigated page all mean "there was nothing to confirm", which is the right behavior for a stray press.
- **It does not await `startupReadiness`.** The confirmation's target is the content script, which is never suspended and knows nothing about worker readiness. The keyboard path also reached `confirmSelection()` without consulting readiness, and it is the content script that later sends `selection:complete` — which is the message that actually needs worker state, and which the existing handler already treats on its own terms. Adding a readiness gate here would be the only behavioral difference from the keyboard path, and it would shift the Stop-versus-confirm race, so it is omitted deliberately.

The worker does not need to know whether an overlay exists. That question is already answered by the content script, which owns the overlay.

### Confirmation applies to the overlay present when the message arrives

I want to be precise about a limit here, because an earlier revision claimed more than the platform allows.

Chrome's Commands API delivers a command with an optional tab. It does not deliver a timestamp, an overlay identity, or any token describing what the user was looking at at the moment of the keypress. The worker therefore cannot know the invocation-time selection. Any scheme that appears to establish it — including querying the page for its current `selectionId` and echoing it back — merely relearns whatever is on screen a moment later, so it adds a round trip without adding a guarantee.

The honest semantic is therefore: **a command confirms whatever overlay is present in its resolved tab when the message is delivered.**

For a keystroke this distinction is invisible, because the key handler runs in the page in the same synchronous turn. For a command it is real, and five interleavings follow from it. All five are recorded as residual risks rather than guarantees, because none can be excluded without invocation context the API does not provide.

1. **Same-document replacement.** The user presses the shortcut while overlay A is visible; before the message arrives, A is dismissed and a new selection B is started and shown. The delayed message confirms B.
2. **Tab fallback.** `onCommand`'s tab argument is optional. When Chrome omits it, the fallback queries the focused tab, so a focus change before that query resolves targets whichever tab is active then. Even when the argument is present, the user may switch tabs before delivery; the message still targets the invocation tab, so the effect may land in a tab the user is no longer looking at.
3. **Replacement document.** `frameId: 0` selects the tab's *current* top document, not the document that was present at the keypress. After a same-tab navigation, if a new selection is started in the new document before delivery, the message can confirm a selection in that replacement document.
4. **No overlay at the press, overlay by delivery.** The user presses the confirmation shortcut while nothing is selected — or presses it by mistake — and a selection is started before the message arrives. The delayed message finds a live overlay and confirms it. No overlay existed at the keypress, so this is not the A-to-B replacement case above, and it is the reason the Goals section says commands outside a selection are harmless **only when no selection exists at delivery**.

   This one is worth calling out because it also weakens a claim I made earlier: "a stray press does nothing" is true for a stray press that lands while nothing is selected, not for one that lands just as the user starts selecting. A user who presses the shortcut and then immediately starts a new selection can therefore have that new selection confirmed by the earlier press.

5. **Region adjusted after the press.** The overlay can still be dragged between the keypress and delivery. Pointer handling mutates the module-level `region` (`content.js:205`), and `confirmSelection()` snapshots whatever it holds at that moment, so the capture uses the rectangle and viewport as they are at delivery, not at the keypress. This is accepted and is arguably the better behavior — the user's most recent adjustment is what they mean — but it is a difference from the keystroke path, which read the region in the same turn.

What remains true, stated precisely because it is what actually bounds the damage:

- **Capture admission** requires an overlay that a selection-start created in that tab, in a document where the content script is running, with matching worker `Selecting` state and token. The command cannot invent a region and cannot capture where no overlay exists. (The content function may still run and send a completion that the worker then rejects — for example after worker suspension — which is rejection, not admission.)
- That overlay may already contain a **valid region without the user drawing anything on that page.** `startSelectionMode` restores the saved region from a previous capture (`content.js:131`), so an overlay opened on page B can be confirmable immediately. The correct bound is therefore "an existing valid rectangle in a user-started selection overlay with matching worker authorization," not "a rectangle the user drew on that page." This is inherited behavior, not something the command introduces, but the document must not describe it more flatteringly than it is.
- The single-use token and the worker's `Selecting`/token check are unchanged, so a confirmation landing in a document whose worker-side selection state has been discarded is rejected rather than captured.
- The window is one message hop through the service worker, which is short but is a routing description, not a guaranteed wall-clock bound.

The table stakes: this is a shortcut for an action the user already invokes deliberately; the failure mode is a capture the user can see and stop; and the alternative — no configurable shortcut — is the problem the change exists to solve.

### Content script

Two changes.

**Remove the key branch.** The window key handler loses its confirmation branch and is otherwise untouched:

```js
function onKeyDown(event) {
  if (event.isTrusted !== true || confirmPending) return;   // keep BOTH guards, exactly as today
  if (event.key === 'Escape') { /* unchanged: token, removeOverlay, selection:cancelled */ }
  // Ctrl+Space branch deleted
}
```

The `confirmPending` early return is deliberately **preserved**. It is what prevents Escape from tearing down an overlay while its two-frame confirmation is in flight: without it, Escape would remove the overlay and clear `selectionToken` while the pending callback was still queued, and the eventual `selection:complete` would carry a null token and be rejected. This design does not "improve" Escape; it leaves both guards alone, which is why the cancellation semantics are unchanged and why no new Escape test is needed.

Removing the Ctrl+Space branch is what resolves the reported conflict: Ctrl+Space no longer triggers confirmation, so fcitx5 can keep it for input-method toggling. Space remains intercepted by the scroll-lock path during an active capture for its own unrelated purpose, which this change does not touch.

**Accept the command message.** Add one route that calls the existing function:

The content script already tracks one selection through module-level `selectionToken`, `region`, `confirmPending`, and `overlay`, with `startSelectionMode(saved, token)` installing them and `removeOverlay()` clearing them. **No new field is needed.**

```js
if (message?.type === 'selection:confirm') {
  confirmSelection();          // synchronous; sets confirmPending before returning
  sendResponse({ ok: true });
  return false;                // synchronous response, matching the existing convention
}
```

`confirmSelection()` already refuses when the overlay is absent, a confirmation is pending, there is no token, or the region is too small. So a stray press, a double press, or a press during an in-flight confirmation is a no-op without any new guard.

The response carries no result field. The keyboard path had no acknowledgement at all, and any `confirmed` boolean would have to mean either "this call admitted a confirmation" or "a confirmation is pending now" — which differ exactly in the duplicate case, where it would misleadingly read `true`. The worker ignores the reply regardless.

**Trust.** The content listener does not currently inspect `_sender`, and this design does not add a check. The extension exposes no externally connectable surface, so `chrome.runtime.onMessage` in the content script receives only messages from the extension's own contexts; the page cannot send on that channel. Calling `confirmSelection()` from a worker message is therefore equivalent in trust to calling it from a trusted DOM event — both originate in the extension.

## Hint behavior

The overlay currently hardcodes `Ctrl+Space` in two strings. It must instead show the binding Chrome reports, so the hint never advertises a key the command does not have.

### Binding lookup contract

The content script asks the worker once per overlay:

```js
chrome.runtime.sendMessage({ type: 'commands:binding' })
```

The worker answers through `sendResponse` with exactly one of four shapes, and **must** return the literal `true` from the listener so the channel stays open for the asynchronous reply:

```js
if (message?.type === 'commands:binding') {
  let replied = false;
  const reply = (payload) => { if (!replied) { replied = true; sendResponse(payload); } };
  try {
    chrome.commands.getAll()
      .then((rows) => {
        const row = rows.find((candidate) => candidate.name === 'confirm-region-capture');
        if (!row) return reply({ state: 'unavailable' });
        return reply(row.shortcut ? { state: 'assigned', label: row.shortcut } : { state: 'unassigned' });
      })
      .catch(() => reply({ state: 'unavailable' }));
  } catch {
    // getAll() can throw synchronously before returning a promise; reply in this turn.
    reply({ state: 'unavailable' });
  }
  return true;              // required; without it the reply is dropped and the hint stays pending
}
```

Every branch replies exactly once, guarded by a `replied` latch so no path can double-reply: `assigned` when the row exists with a non-empty shortcut, `unassigned` when it exists with an empty string, and `unavailable` when the row is missing, the promise rejects, **or `getAll()` throws synchronously**. The synchronous `try` matters: a throw before `.then()` registration happens before the listener returns, so without it no reply would ever be sent and the hint would sit in `checking` forever.

A non-`true` return would close the MV3 channel and drop the reply, also leaving the hint pending, so the literal `return true` is a correctness requirement rather than a style note.

**The content side must also fail closed.** The request is fire-and-forget, but a rejected `sendMessage` (no worker, extension context gone, or the route missing) must transition the hint to `unavailable` rather than leaving it in `checking`:

```js
try {
  chrome.runtime.sendMessage({ type: 'commands:binding' })
    .then((reply) => paint(reply?.state ?? 'unavailable'))
    .catch(() => paint('unavailable'));  // transport failure is a state, not a hang
} catch {
  paint('unavailable');                  // context invalidated: sendMessage can throw synchronously
}
```

The `try` is not defensive noise. When the extension context is invalidated, `chrome.runtime.sendMessage` can throw synchronously, in which case no promise exists and `.catch()` would never be attached — leaving the hint in `checking` forever, which is precisely the state this code exists to prevent. Both sides of the lookup therefore need both a promise rejection path and a synchronous-throw path.

### Four states and their text

```text
assigned (new):     Drag to select OCR region. Ctrl+Shift+Space to confirm. Esc to cancel.
assigned (saved):   Drag to adjust. Ctrl+Shift+Space to confirm. Esc to cancel.
checking:           <same verb> Confirmation shortcut checking…
                    Set it at chrome://extensions/shortcuts. Esc to cancel.
unassigned:         <same verb> Confirmation shortcut not set;
                    set “Confirm selected OCR region” at chrome://extensions/shortcuts. Esc to cancel.
unavailable:        <same verb> Confirmation shortcut unavailable;
                    check “Confirm selected OCR region” at chrome://extensions/shortcuts.
                    Esc to cancel.
```

The existing strings distinguish a fresh selection ("Drag to select OCR region") from a restored saved region ("Drag to adjust"). That distinction is preserved in every state; only the shortcut clause changes. Collapsing them into one wording would be an unrelated regression in the hint's own information content.

`checking` is the state from overlay creation until the reply arrives. It deliberately names no key, so a stale `Ctrl+Space` label is never shown even briefly. `unassigned` and `unavailable` must stay distinct: the first means the user can fix it by assigning a binding, the second means the lookup itself failed and the key may well be set.

### Ownership and precedence

Two invariants, both of which the earlier draft stated only in test prose:

- **The reply belongs to one overlay.** The request is issued at overlay creation and the reply may repaint only if that overlay is still the current one. A late reply for a closed overlay must not repaint a newer overlay's hint.
- **A diagnostic outranks the binding label.** The overlay's hint is also where `confirmSelection()`'s catch writes errors, for example a stale or unauthorized confirmation. Once a diagnostic is displayed it owns the hint until the overlay is dismissed or the user adjusts the region; the binding label is not painted over it. Both conditions are evaluated when the reply arrives and again when painting, so neither ordering can clobber the other.

Without the second rule, a slow binding reply would erase an error the user is meant to act on — a failure mode created by making the lookup asynchronous.

Read the binding when an overlay opens. There is no Commands API change event, so a shortcut edited while an overlay is open takes effect in Chrome immediately but the hint refreshes only when selection is reopened; the README explains this.

Keep the hint readable at smaller widths. The overlay has two style sources — the inline shadow-root `OVERLAY_STYLES` string in `content.js` and `extension/overlay.css` — and both must allow wrapping (`max-width: calc(100vw - 32px)`, `overflow-wrap: anywhere`) with no remaining `white-space: nowrap`, because the shadow-root stylesheet is what actually renders.

## Error handling

- **No overlay open.** `confirmSelection()` returns immediately and the worker ignores the `{ok: true}` reply. Nothing is started.
- **Command in a tab without the content script.** `sendMessage` rejects; the worker swallows it. Nothing starts.
- **Confirmation already in flight.** `confirmPending` makes the extra call a no-op, so a double command cannot produce two captures.
- **Region too small.** `confirmSelection()` returns without sending, and the existing hint behavior applies. The overlay stays open.
- **Worker was suspended.** The command does not wait for `startupReadiness`, so it delivers the confirmation exactly as the keyboard path does; the content script is unaffected by worker suspension because it lives in the page. Whether the subsequent `selection:complete` is accepted depends on the worker having recovered its `Selecting` state and token, which is residual risk 3 and applies equally today.
- **Page navigated.** The message fails, or lands in the new document where there is no overlay and `confirmSelection()` returns immediately. It confirms nothing *unless* the user has already started a new selection in that new document, in which case residual risk 1, sub-case 3 (replacement document) applies.
- **Shortcut not assigned.** The hint says so and points at the shortcuts page. The command cannot fire while unassigned, so the user confirms by reassigning the binding. (An unreadable binding query is a separate case: the hint reports it as unavailable, and the command may still fire — the hint is only a label.)
- **Stale or unauthorized completion.** Unchanged: the existing worker check rejects it with the existing message.

Apart from the residual-risk cases listed above — notably a confirmation delivered into a tab whose document was replaced and where the user has meanwhile opened a new selection — nothing here starts capture, requests a permission, or affects another tab. The exceptions are the ones enumerated as residual risks, not silent gaps in this list.

## Verification strategy

Negative tests must be paired with positive controls, or a suite that rejects everything would pass vacuously.

- **Manifest/asset checks.** `confirm-region-capture` exists with the correct description and `Ctrl+Shift+Space` (with `Command+Shift+Space` on mac); `start-region-capture` is unchanged; no permissions added; both style sources carry the wrapping rules and neither retains `nowrap`.
- **Worker tests.** The command resolves the originating tab when Chrome supplies one; when it does not, it falls back to one `tabs.query`, and a rejected query is a silent no-op (control: a resolved query delivers the confirm). It sends exactly one `selection:confirm` to `frameId: 0`; a rejected `sendMessage` is swallowed and starts nothing; `start-region-capture` still dispatches its original path unchanged.
- **Binding-lookup failure tests.** `commands:binding` replies exactly once for each of: assigned, unassigned (empty string), missing row, rejected `getAll()` promise, **and synchronous throw from `getAll()`** — the last asserting a reply is still sent in the same turn rather than never. On the content side, both a rejected `sendMessage` **and a synchronous throw from it** move the hint to `unavailable` rather than leaving it in `checking` (control: a successful reply paints the assigned label).
- **Content tests.** `selection:confirm` calls the same `confirmSelection()` as before, so a positive control asserts that a command-driven confirmation produces exactly one `selection:complete` with the existing token and region; a second `selection:confirm` while pending produces none (control pair); `selection:confirm` with no overlay, no token, or a too-small region sends nothing and leaves the overlay usable (control: a subsequent valid confirmation succeeds); Escape still cancels and still emits `selection:cancelled`; **Ctrl+Space no longer confirms** (the regression this change exists to create); hints show the assigned, unassigned, unavailable, and checking wording, never name a key before the binding reply arrives, never overwrite an active diagnostic, and wrap in a narrow viewport.
- **Delivery-time semantics tests.** A `selection:confirm` delivered while an overlay is live confirms it (positive control); the same message delivered after that overlay was dismissed confirms nothing and restores nothing; a message delivered in a tab with no content script is swallowed. Each of the five documented interleavings is asserted to behave as described rather than as an unattainable guarantee:
  - **Supplied-tab switch.** Chrome supplies tab T; focus moves to U before delivery; the message still targets T and confirms T's overlay if one exists. Control: without the switch, the same flow captures T.
  - **Fallback-query switch.** Chrome omits the tab; focus moves to U before the query resolves; the resolved tab is U. Control: without the switch, the resolved tab is the invocation tab.
  - **Initial overlay creation with a saved region.** A saved region exists; the user starts selection and confirms before its overlay is drawn; the overlay is created with the restored rectangle and the confirmation succeeds with zero pointer events — matching the documented saved-region bound rather than an invented "user drew it here" guarantee.
  - **Same-document replacement.** A command is in flight for overlay A; A is dismissed; B is started and shown in the same document; the delayed message confirms B. Control: with A still live, the same flow confirms A.
  - **Replacement document.** After a same-tab navigation, a message delivered with no new overlay confirms nothing; if the user has already started a new selection there, it confirms that selection.
  - **No overlay at the press, overlay by delivery.** A `selection:confirm` sent while nothing is selected, delivered after a selection starts, confirms that new selection. Control: delivered before any selection starts, it does nothing.
  - **Region adjusted after the press.** The user presses the command while the overlay holds region R, then drags it before the message arrives; the capture uses the region and viewport at delivery. Control: with no adjustment, the same flow captures R unchanged.
  - **Stale binding-reply ownership.** A binding reply for a closed overlay does not repaint a newer overlay's hint, and does not overwrite an active diagnostic.
- **Equivalence test, against a pinned baseline.** After the change there is no keyboard confirmation surface left, so the comparison cannot be made by driving both paths in the post-change build. Instead, capture the *pre-change* behavior as the oracle: run the existing positive test (the trusted Ctrl+Space keydown at `tests/content.test.js:426`; `:421` is the preceding comment) against the code at the pinned base commit `c47dec6a`, record the exact `selection:complete` payload it produces for a fixed selection, and commit that recording as a fixture. The post-change test then drives `selection:confirm` through the message router and asserts the produced payload equals the fixture, apart from timing. This pins "the trigger changed, the mechanism did not" with evidence rather than by asserting a path that no longer exists. It reliably catches a bypass that changes the payload; a different implementation that happened to reproduce the identical payload would pass, which is why source review covers that separately.

  Note precisely what the fixture proves, and what it does not. It is a fixed-input output oracle: it proves the command-driven path produces the same region, viewport, DPR, and message shape as the pinned implementation did. It does **not** prove implementation identity — a different implementation producing the same payload would also pass — so "the shared function is still used" remains a source-review condition, checked by reading the diff.

  The synthetic-`isTrusted` caveat applies to the *baseline* half: the existing test constructs a plain JavaScript object with `isTrusted: true`, which the content script accepts because it cannot distinguish a real browser event from a property. That is sufficient to pin the content script's handling, but it means the baseline recording is not evidence about real browser key delivery. Real dispatch is covered by the headed manual procedure below, which presses actual keys.
- **Regression tests for non-goals.** Assert this change adds no new `persistOperation`, `retryState`, or checkpoint write, does not modify `handleStop`, and does not alter the token check or the animation-frame delay.
- **Existing-artifact updates.** Every existing reference that depends on Ctrl+Space must change in the same deliverable, or the suite and docs will contradict the shipped behavior. A repository-wide search at implementation time finds exactly six, and all six are in scope: `extension/content.js:139` and `:142` (the two hardcoded hint strings, replaced by the binding lookup), `README.md:19` and `:297` (user instructions), `tests/content.test.js:426` (the positive confirmation keydown — becomes the baseline source for the equivalence fixture; adjacent comment at `:421`) and `tests/content.test.js:623` (the too-small-region keydown, which would otherwise pass vacuously once the branch is removed; adjacent comment at `:621`). After the change, the only remaining occurrences must be the deliberate documentation stating that Ctrl+Space no longer confirms. (Count excludes this design document and the technical specification, which quote the old key on purpose.)
- **Chromium, automated.** The manifest loads in real MV3 Chromium, `chrome.commands.getAll()` contains both commands **as declared in the unpacked manifest**, and the existing load/restart smoke behavior still passes. Headless Chromium cannot allocate system shortcut bindings or synthesize browser-level key dispatch, so automated coverage stops at declaration and registration; physical dispatch is manual.
- **Chromium, manual and reproducible.** Launch headed Chromium with the unpacked extension and record the version; record the initial `chrome://extensions/shortcuts` rows; press `Ctrl+Shift+S` then `Ctrl+Shift+Space` and verify capture runs; reassign to another supported binding and verify both dispatch and the refreshed hint after reopening selection; clear it and verify the not-set hint and that Ctrl+Space still does nothing; narrow the window and verify wrapping.
- **Artifact inventory.** The complete set this change touches, so nothing is implied but unwritten:
  - `extension/manifest.json` — add `confirm-region-capture`.
  - `extension/background.js` — add the `confirm-region-capture` branch and the `commands:binding` route; no other change.
  - `extension/content.js` — delete the Ctrl+Space branch; add the `selection:confirm` route; generate the four hint states from the binding lookup; remove `white-space: nowrap` from `OVERLAY_STYLES`.
  - `extension/overlay.css` — remove `white-space: nowrap`; add the wrapping rules so it matches the shadow-root stylesheet.
  - `tests/content.test.js` — rewrite the Ctrl+Space confirmation at `:426` and the too-small-region case at `:623`; add the binding-state, diagnostic-precedence, and delivery-time cases.
  - `tests/background.test.js` — command routing, tab fallback, and the five `commands:binding` reply paths.
  - `tests/extension_e2e.test.js` — extend the existing real-Chromium smoke test to assert `chrome.commands.getAll()` contains both `start-region-capture` and `confirm-region-capture` with their declared defaults. This file is the owner of the automated registration check; without it that check has no home.
  - `tests/fixtures/selection-complete-baseline.json` (new) — the pinned payload oracle recorded from `c47dec6a`.
  - `README.md` — lines 19 and 297, plus a short native-shortcut setup section.
  - `docs/superpowers/specs/2026-10-17-ocr-confirm-shortcut-design.md` and the technical specification.
- Run the existing Node suites, Python tests, and Chromium smoke test, then complete an independent frontier implementation audit under the PM workflow.

## Documentation

Update README's typical flow, capture instructions, and architecture notes:

1. Open `chrome://extensions/shortcuts`.
2. Locate TextKit.
3. Edit `Confirm selected OCR region`.
4. Choose a Chrome-supported shortcut; reopen selection to refresh its hint.

Explain that capture-start and confirmation have separate rows, and that Ctrl+Space no longer confirms an OCR region.

## Baseline evidence

Before product-code changes:

- `node --test tests/background.test.js tests/popup.test.js tests/content.test.js tests/extension_e2e.test.js`: 122 passed, zero failures/skips, including the Chromium smoke test.
- Run-local locked-dependency Python environment, `python -m pytest tests/ -q`: 120 passed.

System Python lacks FastAPI. The run-local virtual environment is outside the delivery checkout and was installed from `backend/requirements-dev.lock` using `--require-hashes`.

## Residual risks

Risks 1–2 are **introduced or widened by this change**, because a browser command is asynchronous where a page keystroke was not. Risks 3–4 are inherited and unchanged. They are separated deliberately so a reader does not have to guess which ones this change is responsible for.

1. **A command confirms the overlay present when its message arrives, not necessarily the one visible at the keypress.** Sub-cases detailed above: same-document replacement; the optional-tab/`tabs.query` fallback under a focus change; a replacement document after navigation; no overlay at the press but one started before delivery; and a region adjusted between press and delivery. The Commands API carries no invocation context, so no worker-side scheme can exclude these. Bounds: a confirmation can only act on an overlay that a selection-start created, in a document where the content script runs with matching worker state; the overlay may hold a restored saved region rather than one drawn on that page; and the remaining window is one message hop through the service worker — short, but a routing description rather than a wall-clock guarantee. A capture in a tab the user has left may not begin until that tab is active again.
2. **Hint text snapshots at overlay creation.** There is no Commands API change event, so a rebinding takes effect in Chrome immediately but the visible hint updates only when selection is reopened. The snapshot behavior existed before, but it becomes newly visible now that the hint reflects a real configurable binding rather than a constant.
3. **A worker suspension while an overlay is open loses that selection.** The overlay survives in the page, but the worker's in-memory `Selecting` state and token do not, so a later `selection:complete` is rejected as stale or unauthorized. True today with the keyboard shortcut; the command neither fixes nor worsens it.
4. **Space remains intercepted elsewhere during capture.** The scroll-lock path uses Space for an unrelated purpose while a capture is running. Removing the confirmation branch frees `Ctrl+Space` for confirmation specifically; it does not make the key inert in TextKit during an active capture, and the README wording should say so.

Risks 1–2 are accepted because the alternative is no configurable shortcut, which is the problem this change exists to solve. Neither permits a capture of a page where no selection overlay was ever started. Risk 1 can confirm an overlay the user did not have in view at the keypress; risk 2 only affects which key the hint names.

## User decision and next gate

The user has approved the native Chrome shortcuts UI and selected Ctrl+Shift+Space as the confirmation default, with Ctrl+Shift+S remaining the OCR-region launch command.

Twenty-five independent frontier reviews blocked earlier revisions. Two lessons came out of them, and both are now built into the document rather than into more machinery.

**First, scope.** Eighteen of those reviews blocked on the confirmation and capture *protocol* — durable selection records, request/response inversion, sequence ordering, claim fencing, Stop admission windows, restoration receipts — because earlier revisions tried to make the *command* robust against worker suspension and cancellation. Each round closed one window and exposed another, since those windows belong to machinery this change does not need to touch. The command changes how confirmation is triggered, not what confirmation does. Its whole implementation is one manifest entry, one listener branch, one content route calling the existing `confirmSelection()`, removal of the Ctrl+Space branch, a binding lookup for the hint, and documentation.

**Second, honesty about what the platform provides.** Two successive revisions tried to guarantee "invocation-time" identity — first by binding confirmation to a token, then by asking the page for its current `selectionId` and echoing it back. Both were correctly rejected, because Chrome's Commands API carries no invocation context: the second scheme merely relearned what was on screen a moment later, adding a round trip and no guarantee. The design now states the real semantic — a command confirms whatever overlay is present in its resolved tab when the message arrives — and records the narrow dismissal-then-reopen race as an explicit residual risk instead of claiming it away. The same discipline corrected three factual errors in earlier drafts: the region-shape check's actual behavior, what a pinned fixture can prove, and whether the popup offers a confirmation fallback.

This design is awaiting a fresh independent frontier review, which should verify that the four edits do what they claim, that Ctrl+Space no longer confirms anything, that no new path to capture start or new persistence appears, and that the residual risks are stated at their true strength rather than optimistically. After a clean review, draft and review the technical specification, then obtain the PM-required specification sign-off before autonomous planning and implementation.

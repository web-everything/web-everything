---
kind: story
size: 2
status: open
scope: ["we:blocks/state-view/StateViewElement.ts"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from frontier-ui/frontierui#56 (head ed6db5363)

Filed mechanically by the red-team gate: the post-accept red team on frontier-ui/frontierui#56 (reviewed head `ed6db5363272913f6f1008a52a985ae2429f7e34`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:blocks/state-view/StateViewElement.ts:197` — (failing-input, degraded) Non-ready states leave direct text and SVG content visible
   - Scenario: Mount a loading element containing a direct text node or SVG child, then advance past 400 ms. Text remains alongside the skeleton because this.children excludes text nodes. SVG receives a hidden JavaScript property without a hidden attribute, so it also remains visible. Author content should remain hidden until state="ready".
   - Class: live-reproduced (basis: Executed the checked-out TypeScript using existing Happy DOM dependencies. Observed the direct text beside the skeleton and SVG markup without a hidden attribute.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:blocks/state-view/StateViewElement.ts:197` — (edge-case, degraded) Children appended after rendering bypass content hiding
   - Scenario: Mount state="loading", advance to the 30-second timeout, then append a paragraph containing data. The paragraph remains unhidden beside the error view indefinitely because hiding only runs during render and no timers remain. Newly inserted author content should stay hidden until state="ready".
   - Class: live-reproduced (basis: Executed against the checked-out implementation with controlled timers and Happy DOM. After timeout and append, the paragraph had hidden=false, the presentation remained error, and no timers remained.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:blocks/state-view/StateViewElement.ts:132` — (edge-case, degraded) Async Retry handlers lose keyboard focus when entering loading
   - Scenario: Mount state="error" with a retry listener that awaits Promise.resolve() before setting state="loading". Focus Retry and click it. After the microtask, focus moves to BODY because rendering removes the button, while the host-focus fallback only handles synchronous loading transitions during dispatch. Focus should remain on the state-view host while loading has no controls.
   - Class: live-reproduced (basis: Reproduced with the checked-out implementation in Happy DOM: activeElement changed from BUTTON to BODY, and the state-view no longer contained focus after the async loading transition.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.

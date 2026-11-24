---
kind: story
size: 2
status: open
scope: ["we:blocks/state-view/StateViewElement.ts"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from frontier-ui/frontierui#54 (head 278fd727f)

Filed mechanically by the red-team gate: the post-accept red team on frontier-ui/frontierui#54 (reviewed head `278fd727f45048d9d3b40d3d2085dc143928a688`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:blocks/state-view/StateViewElement.ts:36` — (edge-case, degraded) Reapplying the current state collapses open error details
   - Scenario: Mount a we-state-view with state="error" and details="HTTP 503", then open Details. Call element.setAttribute('state', 'error') again. The disclosure closes even though nothing changed. Attribute updates should preserve the user's open disclosure when the error details remain unchanged.
   - Class: correctness-in-normal-use (basis: Reactive consumers commonly reapply existing attribute values. attributeChangedCallback renders unconditionally when connected; replaceChildren creates a fresh, closed details element, and the restoration logic preserves only focus.)
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

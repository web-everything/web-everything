---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race] from web-everything/web-everything#7467 (head 190685f4c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7467 (reviewed head `190685f4cfbeeef03a2b487276f450473eb6cc09`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2491` — (edge-case, degraded) A late hold consumes dispatch capacity despite launching nothing
   - Scenario: Set fixer capacity to one with no live claims and queue two unrelated fixes. PR 1764 is clear at admission but held at the second read after lane selection; PR 1765 remains clear. The dispatcher returns the lane but retains the throttle admission spent on PR 1764. PR 1765 then receives fix-cap and neither launches. A hold refusal should return unused capacity so the next eligible PR can launch.
   - Class: live-reproduced (basis: Executed runReconcileFixDispatch with the real createDispatchThrottle configured to capacity one and a deterministic injected hold sequence. Observed push-hold for PR 1764, fix-cap for PR 1765, and zero launches.)
   - Also class: theoretical-race
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

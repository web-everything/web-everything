---
bornAs: xykubvu
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/test-gaming-route.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5537 (head 4ca02d50c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5537 (reviewed head `4ca02d50c509f225f91acc365bcee12df004b199`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/test-gaming-route.mjs:68` — (edge-case, degraded) A subsequent ordinary fix-end silently cancels an existing justification handoff.
   - Scenario: Route head H, append a trusted matching fix-end with 'test-removal-justified: obsolete behavior removed', and route again: the result is needs-you and advisory:changes is removed. Now append another trusted fix-end for H without that line, using buildFixEndComment. The parser selects only this last completion and forgets the earlier justification. Reproduced result: routing returns admitted, reinstates advisory:changes, and planReconcile offers another fixer; the advisory sweep leaves it eligible. This also affects a fixer that posts its justification before invoking the mandatory fix-end comm
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

---
bornAs: xg1jld9
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/test-gaming-route.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5537 (head 3bf522025)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5537 (reviewed head `3bf5220252b237d1145451dd9001ee6aa0f8491b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/test-gaming-route.mjs:64` — (edge-case, degraded) An intervening acceptance permanently hides the fixer's justification
   - Scenario: On one unchanged head, post the route, let an already-running panel post an accepting advisory, then post the routed fixer's matching-head fix-end containing test-removal-justified. episodeAfter truncates at the acceptance, excluding the justification. Routing reposts the binding finding after that fix-end, which leaves the justification outside the replacement episode too. Two repeated probes returned admitted, zero notifications and another advisory-fix dispatch. The same ordering loses completion when the repair marker precedes the acceptance. The original worker's completion or justificati
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/test-gaming-route.mjs:188` — (failing-input, degraded) Existing review:changes prevents the admitted finding reaching the fixer
   - Scenario: Start with a test-removal-only hold, review:changes and an ordinary changes-requested comment about an unrelated typo. Routing returns admit and adds review:human plus advisory:changes while retaining review:changes. The real planner dispatches an ordinary fix, and extractFindings with these labels returns only the typo comment, omitting the new restore-or-justify binding. The fix-agent brief explicitly selects ordinary mode whenever review:changes exists. Defer admission until that bounce is handled, or ensure the dispatched worker receives both obligations.
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

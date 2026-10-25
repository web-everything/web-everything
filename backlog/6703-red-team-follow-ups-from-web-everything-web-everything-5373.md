---
bornAs: x920b18
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5373 (head 74f8b9bf9)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5373 (reviewed head `74f8b9bf913ef19ecb52fbc237c903355e270ee9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:2072` — (failing-input, degraded) Consecutive grants lose authorized repair rounds
   - Scenario: With roundCap=6 and eight trusted rearm comments, post two authenticated +1 grants before another repair runs. Both grants validate through planRoundExtension, but anchoredCap computes max(6+2, 8+1, 8+1)=9. After one repair adds its rearm, planReconcile refuses the next fix as cap-exhausted at 9/9. The two additive grants should permit two repairs, producing cap 10; the second grant currently consumes grant budget without increasing the available repairs.
   - Claude's re-check: The diff shows anchoredCap = max(cap+sum, count(prefix)+by per grant). With 8 rearms and two consecutive +1 grants, both prefixes count 8, so the cap is 9, not 10. The second grant adds nothing.

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

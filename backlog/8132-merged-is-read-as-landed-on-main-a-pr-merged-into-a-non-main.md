---
bornAs: xbeulcr
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/supersede-watch.mjs", "we:scripts/conveyor/supersede-rule.mjs", "we:scripts/operations/prototype-retire.mjs", "we:scripts/conveyor/stand-down.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# 'Merged' is read as 'landed on main': a PR merged into a non-main base, or later reverted, still stands down …

Flow-sim gap R9b-G4, class K18 (state keyed to an identity never checked for liveness or retraction). Failing input: Trusted PR #B merged into base lane/stack-x (or release branch), or merged then reverted by a revert PR; body 'Supersedes: #A'; #A open.' 'supersede-watch tick. Cited: we:scripts/conveyor/supersede-watch.mjs:38-39, we:scripts/conveyor/supersede-rule.mjs:258, we:scripts/operations/prototype-retire.mjs:132-136, we:scripts/conveyor/stand-down.mjs:233. Soak-break sketch: fixture: merged row {number:B, baseRefName:'lane/stack-x', body:'Supersedes: #A'}, trusted author; open #A. action: planSupersedeHolds. assert no hold (superseder not on the default branch) - today a hold is planned.

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

---
kind: story
size: 5
parent: "5467"
status: open
blockedBy: ["xtxt36v"]
scope: ["["we:scripts/lib/review-timing.mjs"", ""we:scripts/lib/review-timing-settings.mjs"", ""we:scripts/operations/fix-run.mjs"", ""we:scripts/lib/__tests__/review-timing.test.mjs"]"]
dateOpened: "2026-11-01"
tags: []
---

# Live early start of review and fixer on confirmed findings while CI runs

Build the live half of decision xrz0ezn (R359), after the shadow story xtxt36v has its evidence. Eligible reviews start while CI runs; the fixer starts on confirmed findings (red team confirmed, or at least two seats agree, each naming the exact head sha) but holds its push until the previous head CI is complete, folding CI findings into the same push, and never pushes into a running CI. A started review keeps findings when CI goes red and joins one fix round. Settings default off; the flip is a human settings change. Acceptance: vitest cases for fixer starts on confirmed findings only, single-seat findings never start it, push held while previous CI runs, push only after CI complete at the hold bound, red CI joins findings into one round, head move voids early review and fix, hold timer not reset by polls, merge refuses with CI pending.

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

---
kind: story
size: 2
priority: high
parent: "3007"
status: open
blockedBy: ["5355", "5371"]
scope: ["we:scripts/conveyor/pr-label-mirror.mjs", "we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs", "we:scripts/conveyor/ruling-needed-sweep.mjs", "we:scripts/conveyor/review-hold-reconcile.mjs", "we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs", "we:scripts/operations/record-referral-ruling-io.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Ledger plan slice G2: the label mirror is the one writer of advisory:ruling-needed

Slice G2 of the verdict-ledger plan (#3007), D5 ruling: labels are the GitHub rendering of derived state and the mirror is their one writer. we:scripts/conveyor/pr-label-mirror.mjs moves from report mode (G1) to writing advisory:ruling-needed from derivePrState; we:scripts/conveyor/ruling-needed-sweep.mjs, we:scripts/conveyor/review-hold-reconcile.mjs and we:scripts/operations/record-referral-ruling-io.mjs stop writing it in the same PR. Done when a grep test shows no file but the mirror passes RULING_NEEDED_LABEL to setLabels, and the plateau-app #202 replay converges in one mirror pass. Depends on G1 (#5355), E1 and E2 (#5371), all delivered.

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

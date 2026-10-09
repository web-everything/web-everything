---
kind: story
size: 2
priority: high
parent: "3007"
status: open
blockedBy: ["5355"]
scope: ["we:scripts/review-set-label.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/conveyor/pr-label-mirror.mjs", "we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Ledger plan slice K: approvals and hand-moved labels become ledger events (tighten-only)

Slice K of the verdict-ledger plan (#3007), D5 ruling. Clearing ceremonies in we:scripts/review-set-label.mjs and the judge append an approval event (with delegation); the label mirror we:scripts/conveyor/pr-label-mirror.mjs records a hand-moved label as a label-input event that only counts if it tightens. Use the judge block planned by #5072/#5074, not a second shape. Done when an operator removing review:human by hand is restored by the mirror with a label-input row, and a judge clear writes an approval row. Depends on G1 (#5355) and the v2 event types (slice B), both delivered.

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

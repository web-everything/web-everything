---
kind: story
size: 8
parent: "xrlwbd7"
status: open
blockedBy: ["x77cl1h"]
dateOpened: "2026-10-17"
tags: []
---

# we: review stringency slice 3 — debt register (kind, expedite queue position, level gate)

Add backlog kind debt with its size and buildable rules and every kind-set reference in the same slice, the expedite queue position and deadline, and the level gate that blocks a move while due debt is open. Ruled in xugqjw1.

## Acceptance

- [A1] **Executable** — a test registers kind debt (size rule, buildable rule, all kind-set references), and a level-gate test fails while due debt is open and passes once paid or the must-pay-before level is edited by the operator.
- [A2] **Executable** — integration test `expedite-deadline-escalation` uses a controlled clock: an expedite ruling lets the PR land, puts its card at the top of the build queue, and assigns the configured deadline (initially 72 hours). Before the deadline it is not overdue; once past it, the item reaches the operator's needs-you feed (one row per class), counts as debt due now at the current level, and blocks a level move. Repeated checks neither auto-extend the deadline nor duplicate feed rows.
- [A3] **Executable** — clock-driven test `debt-staleness-resurface` keeps unpaid debt open across the 45-day staleness threshold: it is not resurfaced early, resurfaces when the threshold is reached, retains its must-pay-before level, and cannot expire or disappear from the register; paid debt does not resurface.
- [A4] **Executable** — level-write and gate integration test `level-edit-authority` rejects agent changes to the current level and to a debt item's must-pay-before level, leaving the stored levels and gate result unchanged. With due debt open, an operator's attempted level move still blocks; paying the debt or the operator's recorded edit of its must-pay-before level permits the move, with operator identity and old/new levels recorded.

Ruling and amended table: [we:backlog/xugqjw1](/backlog/xugqjw1-decision-review-stringency-classified-findings-per-level-out/) and the statute `we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes`.

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

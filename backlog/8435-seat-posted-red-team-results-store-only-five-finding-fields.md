---
bornAs: x4sb3um
kind: story
size: 3
status: active
scaffoldedBy: "fix-6622"
dateScaffolded: "2026-11-11"
scope: ["we:scripts/operations/review-job.mjs"]
dateOpened: "2026-11-11"
tags: []
related: ["6622"]
---

# Seat-posted red-team results store only five finding fields, so a later comment can still downgrade impact or class

we:scripts/operations/review-job.mjs writes the finished red-team status with findings reduced to summary/file/line/category/confirmed. The PR 6622 hold decision can therefore only compare those fields for a result the seat posted itself; a later trusted comment that keeps them but downgrades impact (broken to degraded) or class still releases the break through the normal disposition. Fix: seal the full normalized keys (sealedBreakKeys of the full findings, we:scripts/lib/red-team-gate.mjs) into the status when the seat posts, so every reader compares whole bodies.

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

## Duplicate admission

PR 6622 masks impact/scenario/class on the seat-posted path because the stored status lacks them

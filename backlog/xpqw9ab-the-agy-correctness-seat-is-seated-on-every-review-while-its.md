---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# The agy correctness seat is seated on every review while its quota is on hold until 10-20

[held entry 350] (coroner 2026-10-14, held — relates 287) The agy correctness seat is seated on every review while its quota is on hold until 10-20. 248/252 review runs paid for a skipped agy seat ("skip-quota-hold; reset 2026-10-20T18:18Z"), recorded as an accept, so the panel looks more diverse than it is. Fix idea: the roster reads the provider quota hold before seating. During a hold it backfills the seat with another provider (argon or Codex) for diversity, or marks the seat absent (never accept). A smell fires when a seat is skipped on more than 50% of runs in a day. Evidence: runs/review-pr-*.json judgeAgyCorrectness.skipped. Scope: we:scripts/operations/review-pr.mjs roster, review-seat-caps. Size 2.

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

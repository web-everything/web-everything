---
bornAs: xiu5hj7
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# stale in-flight review verdict `changes` lands on a human-cleared PR

Flow-sim gap R4-G1, class K6 (check-then-act race with no pin). Failing input: PR at head H carries review:pending (or review:human re-parked while a review job for H is already running). Job R started on H. operator runs clear-human (labels -> review:accepted, human/pending/changes removed, marker `cleared-human` for H). Then R finishes with verdict changes. Cited: we:scripts/operations/review-pr-io.mjs:991-1030, we:scripts/operations/review-pr-io.mjs:1587-1600, we:scripts/review-set-label.mjs, we:scripts/review-set-label.mjs:719-745. Soak-break sketch: wrong-clear (inverse). The operator's clearance is silently undone, the PR is sent to a fixer for a review the operator had superseded: one wasted fix round, possible round-cap spend. Same-head accept is a no-op, so only `changes` hits it.

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

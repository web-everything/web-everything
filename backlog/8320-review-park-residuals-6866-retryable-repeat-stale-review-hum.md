---
bornAs: xoenuge
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-pr-io.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Review park residuals (#6866): retryable repeat, stale review:human, head check, incomplete gate table

#6866 S2b residuals, all failing toward the human gate: park retryable is not guarded (repeat comment); an existing review:human is treated as complete without a head/run check; park does not check live head equals reviewed head; park trusts the mergeGateReviewHold parse that accepts incomplete gate tables (we:review-pr-io.mjs:1242): require the full required-gate table before parking.

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

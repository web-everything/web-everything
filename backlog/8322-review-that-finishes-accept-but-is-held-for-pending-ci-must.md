---
bornAs: xr9h8xy
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-job.mjs", "we:scripts/operations/review-pr-io.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Review that finishes ACCEPT but is held for pending CI must keep its verdict

A review job finishes ACCEPT, then halts 'review held: CI still pending on reviewed head' (effect-halted, exit 1) and posts nothing: 38 min of review discarded (#6769, 23:26-00:04Z, head 963cdb2c). Persist the verdict and record it once CI goes green on that head, or wait for CI before dispatching review. Never discard.

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

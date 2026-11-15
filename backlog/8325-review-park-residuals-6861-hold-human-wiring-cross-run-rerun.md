---
bornAs: xy778kc
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/review-job.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Review park residuals (#6861): hold-human wiring, cross-run rerun tracking, deferred-ci cooldown

B16 S2b: wire typed review-hold-human to record review:human with the converged accept as evidence (not done in #6861). Residuals: cross-run rerun tracking (we:review-pr-io.mjs:1257); deferred-ci bypasses the infra cooldown for the first 2 deferrals (we:review-job.mjs:212).

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

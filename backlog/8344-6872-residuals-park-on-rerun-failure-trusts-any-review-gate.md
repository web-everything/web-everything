---
bornAs: xkjf4o6
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/review-pr-io.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# #6872 residuals: park-on-rerun-failure trusts any review-gate failure; rerun tracking is per run id; rerun error is swallowed

we:scripts/conveyor/review-pr-io.mjs:1198 (2026-11-15 04:52 ET, R903, fail toward the human gate): park-on-rerun-failure trusts any review-gate failure beside a human-only hold (:1198); rerun tracking is scoped per run id (:1167); the rerun error is swallowed (catch returns error:true), so log the API error. Prove on the live case with before/after evidence, not only unit tests.

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

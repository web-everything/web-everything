---
kind: task
status: active
scaffoldedBy: "card-7526-sibling-advanced"
dateScaffolded: "2026-11-27"
scope: ["we:scripts/lib/pr-size-admission.mjs", "we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# open-pr sibling gate: an advanced sibling containing the submitted head skips the ownership check (PR #7526 follow-up)

Strictly-ahead sibling lanes skip the ownership check in we:scripts/lib/pr-size-admission.mjs, so an advancing source sibling is admitted (PR #7526 follow-up).

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

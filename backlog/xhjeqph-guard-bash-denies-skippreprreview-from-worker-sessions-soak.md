---
kind: story
size: 3
status: active
scaffoldedBy: "file-held-cards-nov12"
dateScaffolded: "2026-11-12"
dateOpened: "2026-11-12"
tags: []
related: ["7614"]
---

# guard-bash denies --skipPrePrReview from worker sessions; soak precheck keys on the diff, not the PR title

2026-11-12 00:56 ET: guard-bash should deny --skipPrePrReview from worker sessions (only the operator may). The soak precheck should key on the diff (fix-shaped change), not the PR title prefix: #6704 worker retitled fix to refactor to pass.

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

same worker-self-waiver family

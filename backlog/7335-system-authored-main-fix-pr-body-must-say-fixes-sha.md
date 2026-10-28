---
bornAs: xt6bsnc
kind: task
status: open
scope: ["we:scripts/conveyor/build-dispatch-hold-router.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# System-authored main-fix PR body must say 'Fixes <sha>'

2026-10-28 10:28 ET. System-authored main-fix PR #6031 body said 'Fixes red main. First red commit: <sha>' instead of literal 'Fixes <sha>' that drain hold + merge-gate main-fix admission recognise (runbook step 3). Fix the body template (or make the matcher accept it). Related: #5969.

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

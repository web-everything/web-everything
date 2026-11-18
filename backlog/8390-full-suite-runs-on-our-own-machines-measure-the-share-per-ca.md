---
bornAs: xxgx1wk
kind: story
size: 3
status: open
scope: ["we:scripts/ci"]
dateOpened: "2026-11-15"
tags: []
---

# Full-suite runs on our own machines: measure the share per cause, then cut

2026-11-15 14:06 ET HIGH (operator: "make sure this is addressed"): cut full-suite runs on our own machines. Known causes: affected-test fallback to full (docs-only #3774, affected-mode correctness #5733, broad 'affected' builder runs #4593), overlay-main-sync full suite from 3 daemons (#8256), daemon rebuild/prototype-load verification, red-main reproduction. First measure the share of local heavy time per cause from the heavy-queue run records in the operations runs dir (kind, hold, local vs remote), then prioritise the existing cards by that share. Proof: local full-suite runs/day and local heavy core-hours before/after.

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

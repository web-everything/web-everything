---
bornAs: xtwqa3k
kind: story
size: 3
status: active
scaffoldedBy: "fix-5273"
dateScaffolded: "2026-10-14"
scope: ["we:scripts/conveyor/review-hold-reconcile.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Hold-reconcile heal must re-check for a concurrent clear-human after its label write

PR #5273 red team (self-review): the we:scripts/conveyor/review-hold-reconcile.mjs heal reads labels, then removes review:accepted, with no re-check after the write. If it reads the brief accepted+human state before a clear-human comment lands and writes after it, the PR ends with neither label plus a valid clearance. Apply the same write-then-read re-check PR #5273 added to the human-surface park and the mechanical-hold hand-off (withdraw when a trusted clearance names the unchanged head), with a soak scenario.

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

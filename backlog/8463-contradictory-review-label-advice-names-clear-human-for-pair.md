---
bornAs: xdjrx6n
kind: story
size: 2
status: active
scaffoldedBy: "fix-5482"
dateScaffolded: "2026-10-18"
scope: ["we:scripts/conveyor/review-hold-reconcile.mjs", "we:scripts/lib/review-escalation.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Contradictory review-label advice names clear-human for pairs without review:human, where it refuses

Found in PR #5482's fix self-review. we:scripts/conveyor/review-hold-reconcile.mjs tells the operator to resolve any contradictory review label pair via review-set-label --to=clear-human. For pairs without review:human (review:pending+review:accepted, review:accepted+review:changes) clear-human refuses: no review:human label, nothing to clear. Advise a command that works for each pair.

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

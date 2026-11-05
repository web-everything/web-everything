---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/soak/breaks/unlabelled-bot-pr-on-non-lane-head-nothing-owed.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-11-05"
tags: []
---

# Reconcile: restore review label for unlabelled bot-authored PRs on non-lane heads

Slice 1 of re-sliced #6296 (R611). restore-review-label covers open non-draft bot-authored (app/ or [bot]) non-lane PRs with green checks. Lineage: #6254 (13x never-reviewed unlabelled PRs answered nothing-owed); branch lane/reconcile-unlabelled-nonlane-pr; soak break unlabelled-bot-pr-on-non-lane-head-nothing-owed.

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

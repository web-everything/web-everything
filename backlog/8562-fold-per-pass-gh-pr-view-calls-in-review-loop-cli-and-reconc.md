---
bornAs: x1me5en
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-11-16"
tags: []
---

# Fold per-pass gh pr view calls in review-loop-cli and reconcile-fix-dispatch into one view per PR

gh slot queue is the review bottleneck. we:scripts/operations/review-loop-cli.mjs defaultReadResumePr and we:scripts/conveyor/reconcile-fix-dispatch.mjs make several gh pr view calls per PR per pass; memoize one view per PR per pass with a union json field list and pass the snapshot down.

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

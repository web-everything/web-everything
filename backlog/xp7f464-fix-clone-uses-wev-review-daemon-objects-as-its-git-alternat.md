---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Fix clone uses wev-review-daemon objects as its git ALTERNATE

HIGH priority hint. - (HIGH, 11-02 10:03 ET) Fix clone uses wev-review-daemon objects as its git ALTERNATE; review's gc pruned commits the fix clone's commit-graph still named (b6cf8fa9, 2868f0a5, 09030ffd) → commit-graph verify fails → readonly rebuild job defers forever (#41). Daemon clones must not borrow objects from another daemon clone that repacks/prunes: use the primary reference repo (never gc --prune) or own objects. Also: #6251 PR body has a self-added soak-waiver line and the worker used --tests-run/--audit instead of fix-ready (both carded patterns, recurring).

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

---
kind: story
size: 3
status: open
scope: ["we:scripts/operations", "we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Diff-only check of the fix hunk against the findings it answers before a fixer pushes

coroner 2026-10-23: 11 'fix-introduced' findings cost 140 of 240 change-request minutes (58%) on code PRs, 34 rounds on 10 PRs (#5762 21 rounds, #5530 19, #5806 12, #5809 12, #5608 11). Before a fixer pushes, run a diff-only check of the fix hunk against the same lens set as the reviewer and refuse the push when it adds a new finding on its own lines. Prove on the #5806 rounds.

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

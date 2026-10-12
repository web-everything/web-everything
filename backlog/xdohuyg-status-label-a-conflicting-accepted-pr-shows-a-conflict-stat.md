---
kind: story
size: 1
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Status label: a conflicting accepted PR shows a conflict state, not ready-to-merge

Held finding 244 (2026-10-11). derivePrStatusLabel returns ready-to-merge on review:accepted before checking merge conflicts (ci-red is now checked first, conflicts are not). Live: #4792 CONFLICTING + red CI, labelled ready. Fix: a conflict state (mergeable CONFLICTING / mergeStateStatus DIRTY) ahead of the accepted check; test.

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

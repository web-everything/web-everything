---
bornAs: xqfah6d
kind: story
size: 2
status: open
scope: ["we:scripts/operations/file-item.mjs", "we:scripts/operations/__tests__/file-item.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Slices filed at a decision ruling must carry scope

Live 2026-10-17: decision xugqjw1's 5 slices were filed via the file-item operation; slice 1 (xdstsoh) had no scope, so the worker had to invent placement (PR #5516). An unscoped story cannot be dispatched by the conveyor (unshaped-no-scope). Fix: file-item refuses a buildable story or task without --scope (or a declared scope: tbd-prepare that routes it to prepare), and the decision-close procedure requires a scope per slice. [A1] Executable: node --test we:scripts/operations/__tests__/file-item.test.mjs, where a story with no scope is refused.

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

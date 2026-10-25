---
bornAs: xvs6bsd
kind: story
size: 3
status: open
scope: ["we:scripts/operations/free-scope.mjs", "we:scripts/operations/free-scope-io.mjs", "we:scripts/operations/__tests__/free-scope.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Free-scope claims files, not directories, and treats a stack base's files as available to its child

Free-scope registers whole directories, so two builders in the same folder block each other, and a child PR stacked on a base PR sees the base's files as taken. Fix: register exact files, and when the claimant is the child of a stacked base, treat the base's files as available. Links, does not duplicate: stacked-PR policy epic 6899, slice 6898. [A1] Executable: node --test we:scripts/operations/__tests__/free-scope.test.mjs, with a case for two files in one directory (both free) and a stack child over its base (free). Priority: top (operator 2026-10-17).

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

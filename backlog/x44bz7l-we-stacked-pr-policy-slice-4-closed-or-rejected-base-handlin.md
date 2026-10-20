---
kind: story
size: 5
parent: "xejcrh1"
status: open
blockedBy: ["xcq5jb9"]
scope: ["we:scripts/lib/pr-merge-gate.mjs", "we:scripts/conveyor/pr-stack.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: stacked PR policy slice 4 - closed or rejected base handling

When a stacked child's base PR is closed or rejected, rebase a low-risk child onto main only on a clean rebase with an unchanged delta fingerprint (a setting); every other child goes to the operator as needs-you. Ruled in xv85eqi.

## Acceptance

- [A1] **Executable** — `node --test` on we:scripts/lib/__tests__/pr-merge-gate-base-closed.test.mjs fails before and passes after. Named tests, one per guarantee:
  - `base closed: a low-risk child with a clean rebase and unchanged fingerprint is rebased onto main`.
  - `base closed: a low-risk child with a conflicting rebase goes to the operator`.
  - `base closed: a low-risk child whose fingerprint changed goes to the operator`.
  - `base closed: a normal or guard child always goes to the operator`.
  - `base rejected is handled the same as closed`.
  - `the auto-rebase behaviour follows the setting; turning it off sends every child to the operator`.
  - `an unreadable base state fails closed to the operator`.
  - `an incomplete diff read fails closed to the operator, never to an automatic rebase`.

## Non-goals

- [N1] Does not change the existing retarget when the base merges (retargetStackedPrs), and does not define the setting (slice 1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — class and fingerprint come from the diff and paths, not PR text.
2. **Truncated reads** — an incomplete diff or state read goes to the operator.
3. **Shared state files** — adds no new shared file; the operator route uses the existing needs-you channel.
4. **Fail closed** — any unknown goes to the operator, never to an automatic rebase.
5. **Identity scoping** — only trusted same-actor lane PRs are handled automatically.
6. **State over time** — evaluated when the base closes; a later reopen re-evaluates.
7. **Who wrote it** — an automation's comment never marks a child low-risk.

---
kind: story
size: 5
parent: "xejcrh1"
status: open
blockedBy: ["xcq5jb9", "xkmrswh"]
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
  - `base closed: gate-feeding settings and mixed docs-plus-guard children go to the operator even when settings and docs are in lowRiskClasses` (reuse slice 1's path-derived class precedence).
  - `base closed: an auto-rebased child receives no review:accepted label or carried approval from the rebase and must pass review, CI and proof-of-land gates for its new head` (integration through the rebase handler and drain, with a clean rebase and unchanged fingerprint; stale acceptance on the old head cannot authorize the new head).
  - `base rejected is handled the same as closed`.
  - `the auto-rebase behaviour follows the setting; turning it off sends every child to the operator`.
  - `an unreadable base state fails closed to the operator`.
  - `an incomplete diff read fails closed to the operator, never to an automatic rebase`.
  - `a partial base-state read (fields missing or cut short) fails closed to the operator`.
  - `a rebase that errors or times out without a conflict goes to the operator`.
  - `a fingerprint or risk class that cannot be computed goes to the operator`.
  - `auto-rebase setting: an unset repo layer resolves to the cascade default of enabled and a low-risk clean child with unchanged fingerprint rebases onto main`.
  - `auto-rebase setting: no resolved cascade value (including no default), or an unreadable cascade result, sends the child to the operator`.
  - `untrusted text: PR body or card text claiming low-risk does not change the class; class and fingerprint come from the diff and paths`.
  - `shared state: a child sent to the operator is posted on the existing needs-you channel and no new shared file is written`.
  - `identity: a child or base PR by a different actor goes to the operator`.
  - `identity: a child or base that is not a trusted lane PR goes to the operator`.
  - `state over time: the decision uses the base and child state read when the base closes, never an earlier cached read`.
  - `state over time: reopening a closed base re-evaluates the child at reopen time instead of reusing the close-time decision`.
  - `who wrote it: an automation's comment marking a child low-risk does not make it low-risk`.

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

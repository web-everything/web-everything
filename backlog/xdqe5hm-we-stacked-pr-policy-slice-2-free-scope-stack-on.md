---
kind: story
size: 5
parent: "xejcrh1"
status: open
blockedBy: ["xcq5jb9"]
scope: ["we:scripts/operations/free-scope.mjs", "we:scripts/operations/free-scope-cli.mjs", "we:scripts/operations/__tests__/free-scope.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: stacked PR policy slice 2 - free-scope --stack-on

Add --stack-on=<n> to free-scope: derive the base PR chain, ask the stack policy for the cell, and exclude only PR holders in that chain (never agent-registry holders). excludePr becomes a list. A cell that may not stack still reports OCCUPIED. Ruled in xv85eqi.

## Acceptance

- [A1] **Executable** — `node --test` on we:scripts/operations/__tests__/free-scope.test.mjs fails before the flag exists and passes after. Named tests, one per guarantee:
  - `stack-on: a stack-allowed child is FREE on its base PR's files`.
  - `stack-on: a never cell (guard child on an in-review base) stays OCCUPIED`.
  - `stack-on: only PR holders in the base chain are excluded; an agent-registry holder on the same file still reports OCCUPIED`.
  - `stack-on: a PR outside the chain on the same file still reports OCCUPIED`.
  - `excludePr accepts a list and keeps the single-number form working`.
  - `stack-on: an unreadable base state or file list fails closed to OCCUPIED`.

## Non-goals

- [N1] Does not change how the drain orders or restacks (slice 3), and does not define the policy values (slice 1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the base PR number is validated as a positive integer; chain and class come from API data and the diff, not PR text.
2. **Truncated reads** — a truncated or failed PR list or file list returns OCCUPIED.
3. **Shared state files** — only reads the agent-scope registry; writes nothing new.
4. **Fail closed** — any unknown state, unknown class or missing policy returns OCCUPIED.
5. **Identity scoping** — chain members must be trusted lane PRs of the same actor.
6. **State over time** — the chain and cell are evaluated at call time, not cached across calls.
7. **Who wrote it** — a comment by an automation never marks a PR urgent for this check.

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
  - `stack-on: a requested scope containing a gate-feeding settings file, or mixing docs with guard files, is guard class and stays OCCUPIED on an in-review base even with settings and docs in lowRiskClasses` (drive the free-scope entry point before a child lane, PR or diff exists; derive class from the requested scope paths using slice 1's classifier, including we:scripts/settings/pr-stack.json; compare with a docs-only scope that is FREE under the same policy).
  - `stack-on: only PR holders in the base chain are excluded; an agent-registry holder on the same file still reports OCCUPIED`.
  - `stack-on: a PR outside the chain on the same file still reports OCCUPIED`.
  - `excludePr accepts a list and keeps the single-number form working`.
  - `stack-on: an unreadable base state or file list fails closed to OCCUPIED`.
  - `stack-on: a base PR value that is not a positive integer (0, negative, decimal, non-numeric, leading --) is rejected and reports OCCUPIED`.
  - `stack-on: the chain comes from API data and the class from requested scope paths; PR body text naming another base or class is ignored` (no child diff exists yet).
  - `stack-on: a truncated or failed PR list fails closed to OCCUPIED`.
  - `stack-on: a truncated file list fails closed to OCCUPIED`.
  - `stack-on: the call writes no file; the agent-scope registry is only read`.
  - `stack-on: with maxDepth 1, a base PR that is itself stacked on another open PR reports OCCUPIED`.
  - `stack-on: an unknown base state, unknown class or missing policy reports OCCUPIED`.
  - `stack-on: a chain member by a different actor is not excluded and the file reports OCCUPIED`.
  - `stack-on: a chain member that is not a trusted lane PR is not excluded and the file reports OCCUPIED`.
  - `stack-on: a second call re-reads the chain and cell; a base state change between calls changes the result`.
  - `stack-on: an automation's comment marking a PR urgent does not change the cell`.

## Non-goals

- [N1] Does not change how the drain orders or restacks (slice 3), and does not define the policy values (slice 1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the base PR number is validated as a positive integer; the chain comes from API data and the class from requested scope paths through slice 1's classifier, not PR text. Gate-feeding settings are guard class, and guard paths take precedence in mixed scopes even when docs and settings are configured low-risk.
2. **Truncated reads** — a truncated or failed PR list or file list returns OCCUPIED.
3. **Shared state files** — only reads the agent-scope registry; writes nothing new.
4. **Fail closed** — any unknown state, unknown class or missing policy returns OCCUPIED.
5. **Identity scoping** — chain members must be trusted lane PRs of the same actor.
6. **State over time** — the chain and cell are evaluated at call time, not cached across calls.
7. **Who wrote it** — a comment by an automation never marks a PR urgent for this check.

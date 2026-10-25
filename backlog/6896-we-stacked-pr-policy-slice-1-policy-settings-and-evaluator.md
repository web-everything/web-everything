---
bornAs: xcq5jb9
kind: story
size: 5
parent: "6899"
status: open
scope: ["we:scripts/settings/stack.json", "we:scripts/lib/policy-cascade.mjs", "we:scripts/lib/stack-policy.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: stacked PR policy slice 1 - policy settings and evaluator

Add every stacking value as a cascade setting with its source logged in we:scripts/settings/stack.json (matrix cells, safety floor, urgent classes, smallChildMaxLines 50, lowRiskClasses, maxDepth 1, onBaseHeadMove, base-closed handling) and a pure evaluator in we:scripts/lib/stack-policy.mjs that returns stack or no-stack for a base state and child class (plus the two PRs' actor and lane-trust facts for the identity rule). Ruled in 6903.

## Acceptance

- [A1] **Executable** — `node --test` on we:scripts/lib/__tests__/stack-policy.test.mjs fails before the module exists and passes after. Named tests, one per guarantee:
  - `matrix: each of the nine cells returns the ruled default` (base state x child class table in the statute we:docs/agent/platform-decisions.md#stacked-pr-policy-configurable).
  - `matrix: each configured allowedBaseStates cell outside the safety floor overrides its default and changes the decision with all other inputs fixed` (parameterized over every configurable cell; floor-covered cells remain governed by the independent floor tests).
  - `class: a settings path that feeds drain, review or merge gates is guard even when settings is in lowRiskClasses` (enumerate the settings files those gates read, including we:scripts/settings/stack.json and we:scripts/settings/pr-stack.json).
  - `class: a mixed low-risk and guard or merge-path child is guard or merge-path; guard classification takes precedence over lowRiskClasses` (include docs plus a gate-feeding settings file, on both in-review and fixing bases).
  - `floor: guard or merge-path child on an in-review or fixing base never stacks, even with urgent or emergency set`.
  - `floor: only an operator-sourced setting can change the floor; an agent-sourced override is ignored and logged`.
  - `every value reports its source (default, repo, operator) from the cascade`.
  - `smallChildMaxLines, lowRiskClasses, urgentClasses, maxDepth and onBaseHeadMove are read from settings, not constants`.
  - `fail closed: unknown base state, unknown class, or missing proof gate returns no-stack`.
  - `class is derived from touched paths, not from card text or PR body`.
  - `untrusted text: child size is measured from the diff; a size claimed in the PR body or card text is ignored`.
  - `truncated read: an unreadable base state returns no-stack`.
  - `truncated read: an unreadable or truncated file list returns no-stack`.
  - `shared state: stack values resolve through the cascade with we:scripts/settings/stack.json as their tool layer, and the evaluator writes no settings file`.
  - `maxDepth: with the default of 1, a base that is itself stacked on another open PR returns no-stack`.
  - `smallChildMaxLines: with the default of 50, a 50-line child counts as small and a 51-line child does not`.
  - `emergency: an emergency flag set by an agent (a label, PR body text, or an agent-sourced setting) is ignored`.
  - `emergency: an operator-flagged emergency lets a normal child stack on an in-review or fixing base`.
  - `identity: a base PR by a different actor returns no-stack`.
  - `identity: a base or child that is not a trusted lane PR returns no-stack`.
  - `state over time: the evaluator is pure; the same inputs give the same result, and a different base state at call time gives the result for that state`.
  - `who wrote it: an urgent flag set by an automation's comment is ignored and the child is evaluated as not urgent`.
  - `who wrote it: an emergency flag set by an automation's comment is ignored; only an operator-flagged emergency counts`.

## Non-goals

- [N1] Does not wire the evaluator into free-scope or the drain (slices 2 to 4), and does not change the drain's proof-of-land gate.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the child's size and class are read from the diff and touched paths by code, never from the PR body or card text.
2. **Truncated reads** — an unreadable base state or file list returns no-stack.
3. **Shared state files** — settings stay in we:scripts/settings/stack.json (the cascade's tool layer); the evaluator writes no settings file.
4. **Fail closed** — unknown state, unknown class or missing gate means no stacking.
5. **Identity scoping** — a stack relation counts only between trusted lane PRs of the same actor.
6. **State over time** — the evaluator is pure and takes the base state at call time; callers re-evaluate when the base moves.
7. **Who wrote it** — an automation's own comments never set an urgent or emergency flag; emergency is operator-flagged only.

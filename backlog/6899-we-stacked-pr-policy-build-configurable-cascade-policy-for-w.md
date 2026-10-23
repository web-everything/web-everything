---
bornAs: xejcrh1
kind: epic
parent: "3383"
status: open
scope: ["we:scripts/settings/stack.json"]
dateOpened: "2026-10-17"
tags: []
---

# we: stacked PR policy build - configurable cascade policy for when PRs may stack

Build the ruling of decision 6903 (we:docs/agent/platform-decisions.md#stacked-pr-policy-configurable): a configurable cascade stacking policy (matrix, safety floor, urgent classes, size, risk classes, depth, base-move and base-closed handling), a free-scope --stack-on flag, drain ordered landing with restack and delta re-review, and base-closed handling. Four slices, in order.

## Acceptance

- [A1] **Executable** — all four slices' named tests pass: `node --test` on we:scripts/lib/__tests__/stack-policy.test.mjs, we:scripts/operations/__tests__/free-scope.test.mjs, we:scripts/conveyor/__tests__/pr-stack-policy.test.mjs, we:scripts/__tests__/merge-ai-prs-stack-order.test.mjs and we:scripts/lib/__tests__/pr-merge-gate-base-closed.test.mjs.

## Non-goals

- [N1] Max depth 2 and any change to the review-stringency class list are out of scope.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: epic; each slice carries its own handling.
2. **Truncated reads** — n/a: epic; each slice carries its own handling.
3. **Shared state files** — n/a: epic; each slice carries its own handling.
4. **Fail closed** — n/a: epic; each slice carries its own handling.
5. **Identity scoping** — n/a: epic; each slice carries its own handling.
6. **State over time** — n/a: epic; each slice carries its own handling.
7. **Who wrote it** — n/a: epic; each slice carries its own handling.

---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# Hydration refusals come after the planner refusal so the real reason shows first

Follow-up from the #3432 advisory (2026-10-02). we:scripts/conveyor/reconcile-pass.mjs:1112 prepends hydration refusals to plan.refusals, so first-match consumers such as pr-ownership reconcileRowFor show check-read-failed instead of the PR real planner refusal. Append them after plan.refusals (or have reconcileRowFor prefer REFUSAL_KINDS entries). Test: a PR with both refusals shows the planner one.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

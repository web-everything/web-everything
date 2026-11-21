---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/__tests__/reconcile-advisory-head-move.test.mjs", "we:scripts/operations/__tests__/", "we:scripts/operations/review-pr.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Test head-moved advisory completion authority

PR #7263's 2026-11-21 simplicity and codex-correctness reviews raised the same coverage gap: the planner test promises that an advisory never accepts `review:human`, but asserts only the dispatch row and explanation. Track both findings here as one execution-boundary regression test.

## Acceptance

- A deterministic test named `head-moved advisory completion preserves review:human and cannot accept` starts with a real `head-moved-advisory` planner row and executes advisory completion through the production review operation with isolated IO.
- For an accepting advisory verdict, assert that the resulting actions retain `review:human`, publish no acceptance action or human-clearance marker, and permit only the expected advisory effects.
- Cover changes and unreadable/failed completion as well as accept; none may clear the human hold. Do not substitute an explanation-string assertion for emitted actions and resulting labels.
- A mutation of the acceptance guard must make this named test fail. Record the precise guard and observed forbidden action.

## Test and proof plan

Use an in-memory PR/label adapter and the real operation runner so no live labels or comments change. Capture emitted effects and final labels. Run the focused integration test, then the scoped review-operation tests; retain mutation evidence with the implementation.

Review prevention keys: web-everything/web-everything#7263@b680c2923:simplicity, web-everything/web-everything#7263@b680c2923:codex-correctness

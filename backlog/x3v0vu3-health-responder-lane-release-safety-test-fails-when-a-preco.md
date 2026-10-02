---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/__tests__/health-responder-core.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# Health responder: lane-release safety test fails when a precondition is removed

Follow-up from the #3490 advisory (2026-10-02). we:scripts/conveyor/__tests__/health-responder-core.test.mjs:100 passes even if every release-lane precondition is removed, because a later adapter-unavailable branch also returns hold. Fix: assert the specific rule that fires for each negative lane case (dirty, reserved, live worker, unreachable), paired with a valid lane case that reaches adapter-unavailable; mutation proof: deleting a predicate check fails the named test.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

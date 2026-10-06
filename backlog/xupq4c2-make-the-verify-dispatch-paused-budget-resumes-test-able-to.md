---
kind: story
size: 1
status: open
scope: ["we:scripts/conveyor/__tests__/verify-dispatch.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Make the verify-dispatch paused-budget-resumes test able to fail

Goal: the test 'paused budget resumes, does not reset' must go red if armGate resets gateBudgetMs. Today we:scripts/conveyor/__tests__/verify-dispatch.test.mjs:329-334 uses gate 300 ms, requeue 200 ms, second gate 2000 ms, ceiling 500 ms, so a reset budget still rejects and the test passes either way (fixture writer writeRequeueGate at :300). Fix: ceiling 500 ms, first gate 350 ms, requeue 200 ms, second gate 350 ms exiting 0: correct code kills at 700 ms total (timedOutPhase gate), reset code resolves. Keep 150 ms or more margin each side. Done when: test asserts rejection with timedOutPhase gate and passes; mutation proof (make onRequeue skip the gateBudgetMs reduction in we:scripts/conveyor/verify-dispatch.mjs, test goes red; paste both runs in the PR); 5 runs, no flake. Test-only, no production change. Checklist: operator handoff checklist item 60. Follows #4054 (merged).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

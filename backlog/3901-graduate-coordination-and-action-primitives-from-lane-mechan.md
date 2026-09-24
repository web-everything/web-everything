---
bornAs: xvrxwha
kind: story
size: 3
parent: "3443"
status: open
scope: ["we:scripts/operations/__tests__/action-cli.test.mjs", "we:scripts/operations/__tests__/coordination-root.test.mjs", "we:scripts/operations/__tests__/tick-mutex.test.mjs", "we:scripts/operations/__tests__/tick-throttle.test.mjs", "we:scripts/operations/action-cli.mjs", "we:scripts/operations/action-dispatch.mjs", "we:scripts/operations/action-ground-truth.mjs", "we:scripts/operations/action-record.mjs", "we:scripts/operations/action-store.mjs", "we:scripts/operations/coordination-lock.mjs", "we:scripts/operations/coordination-root.mjs", "we:scripts/operations/session-role.mjs", "we:scripts/operations/tick-mutex.mjs", "we:scripts/operations/tick-throttle.mjs", "we:scripts/operations/__tests__/action-records.test.mjs", "we:scripts/operations/__tests__/coordination-cross-clone.test.mjs"]
dateOpened: "2026-09-22"
tags: []
---

# Graduate coordination and action primitives from lane/mechanical-dispatcher to main

Ports 10 files (we:scripts/operations/coordination-root.mjs, we:scripts/operations/coordination-lock.mjs, we:scripts/operations/action-record.mjs, we:scripts/operations/action-store.mjs, we:scripts/operations/action-ground-truth.mjs, we:scripts/operations/action-dispatch.mjs, we:scripts/operations/action-cli.mjs, we:scripts/operations/tick-mutex.mjs, we:scripts/operations/tick-throttle.mjs, we:scripts/operations/session-role.mjs) plus their tests. Leaf layer: imports nothing else that is branch-only. Imported by the dispatch path, the review loop, tick-once and the runner. Graduation slice of epic #3443 (see its Slice procedure). FAITHFUL PORT: no behaviour change while porting; the branch code lands as-is (operator, 2026-09-22). Port from snapshot 600acc14f of origin/lane/mechanical-dispatcher. For every file main has changed since the merge base ca7e68b71 (check with git log ca7e68b71..origin/main -- <file>), apply the branch diff onto main's current file; never copy the branch file over it. Add only this slice's own lines to we:scripts/operations/run.mjs and the we:scripts/operations/__tests__/http-adapter.test.mjs pin (append-only, so parallel slices merge cleanly). Full gate on main's tree: check:standards, test, smoke. Hold lifted 2026-09-24: the #3857 model-tier table passed a live probe and the operator started wave A.

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/action-cli.test.mjs we:scripts/operations/__tests__/coordination-root.test.mjs we:scripts/operations/__tests__/tick-mutex.test.mjs we:scripts/operations/__tests__/tick-throttle.test.mjs we:scripts/operations/__tests__/action-records.test.mjs we:scripts/operations/__tests__/coordination-cross-clone.test.mjs` passes on main's tree (all of this slice's tests; each fails before the port because its module is missing or differs).
2. **Executable** — `npm run check:standards` reports 0 errors, and the PR's required `test` and `smoke` checks are green.
3. **Faithful port** — for each ported file, `git diff 600acc14f -- <file>` (prototype snapshot vs main after the port) shows only main's own later changes kept by the merge notes, never a behaviour change of the branch code; runtime data files (e.g. `we:scripts/conveyor/run-scorecards.json`) are never edited.

## Wave A finding (2026-09-24)

The first lane found three of this slice's tests import modules owned by later slices, so they could not pass on main. Moved them to the owning slices:
- `we:scripts/operations/__tests__/action-dispatch-paths.test.mjs` imports `we:scripts/operations/land-advance-io.mjs` → #3856
- `we:scripts/operations/__tests__/action-ground-truth.test.mjs` imports `we:scripts/operations/review-dispatch-wrapper.mjs` → #3908
- `we:scripts/operations/__tests__/session-role.test.mjs` imports `we:scripts/operations/detached-dispatch.mjs` → #3902

## Graduation import check

- 2026-09-24: graduation-import-check made this a blocker of #3856 — its moved-in `we:scripts/operations/__tests__/action-dispatch-paths.test.mjs` imports a module this card owns.

---
bornAs: x9lo11a
kind: story
size: 5
parent: "3443"
status: open
blockedBy: ["3903"]
scope: ["we:scripts/operations/__tests__/prepare-decision-wrapper.test.mjs", "we:scripts/operations/__tests__/prepare-scope-wrapper.test.mjs", "we:scripts/operations/prepare-decision-run.mjs", "we:scripts/operations/prepare-decision-wrapper.mjs", "we:scripts/operations/prepare-scope-run.mjs", "we:scripts/operations/prepare-scope-wrapper.mjs", "we:skills-src/conveyor/prepare-decision-agent-brief-v2.md", "we:skills-src/conveyor/prepare-decision-agent-brief.md", "we:skills-src/conveyor/prepare-scope-agent-brief-v2.md", "we:skills-src/conveyor/prepare-scope-agent-brief.md", "we:scripts/operations/__tests__/dispatch-lane-prepare-decision-wiring.test.mjs"]
dateOpened: "2026-09-22"
tags: []
---

# Graduate prepare-scope and prepare-decision dispatch wrappers, runs and v2 briefs from lane/mechanical-dispatcher to main

Ports 9 files (we:scripts/operations/prepare-scope-wrapper.mjs, we:scripts/operations/prepare-scope-run.mjs, we:scripts/operations/prepare-decision-wrapper.mjs, we:scripts/operations/prepare-decision-run.mjs, we:skills-src/conveyor/prepare-scope-agent-brief-v2.md, we:skills-src/conveyor/prepare-decision-agent-brief-v2.md, we:skills-src/conveyor/prepare-scope-agent-brief.md, we:skills-src/conveyor/prepare-decision-agent-brief.md, we:skills-src/conveyor/investigation-agent-brief.md) plus their tests.  Graduation slice of epic #3443 (see its Slice procedure). FAITHFUL PORT: no behaviour change while porting; the branch code lands as-is (operator, 2026-09-22). Port from snapshot 600acc14f of origin/lane/mechanical-dispatcher. For every file main has changed since the merge base ca7e68b71 (check with git log ca7e68b71..origin/main -- <file>), apply the branch diff onto main's current file; never copy the branch file over it. Add only this slice's own lines to we:scripts/operations/run.mjs and the we:scripts/operations/__tests__/http-adapter.test.mjs pin (append-only, so parallel slices merge cleanly). Full gate on main's tree: check:standards, test, smoke. Hold lifted 2026-09-24: the #3857 model-tier table passed a live probe and the operator started wave A.

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/prepare-decision-wrapper.test.mjs we:scripts/operations/__tests__/prepare-scope-wrapper.test.mjs` passes on main's tree (all of this slice's tests; each fails before the port because its module is missing or differs).
2. **Executable** — `npm run check:standards` reports 0 errors, and the PR's required `test` and `smoke` checks are green.
3. **Faithful port** — for each ported file, `git diff 600acc14f -- <file>` (prototype snapshot vs main after the port) shows only main's own later changes kept by the merge notes, never a behaviour change of the branch code; runtime data files (e.g. `we:scripts/conveyor/run-scorecards.json`) are never edited.

## Graduation import check

- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/dispatch-lane-prepare-decision-wiring.test.mjs` here from #3906 — it imports a module this card owns.
- 2026-09-24: graduation-import-check made this a blocker of #3904 — its moved-in `we:scripts/operations/__tests__/dispatch-kind-axes.test.mjs` imports a module this card owns.
- 2026-09-24: graduation-import-check made this a blocker of #3908 — its moved-in `we:scripts/operations/__tests__/telemetry-wiring.test.mjs` imports a module this card owns.

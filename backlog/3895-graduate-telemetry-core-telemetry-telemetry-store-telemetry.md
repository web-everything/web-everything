---
bornAs: xm24wzq
kind: story
size: 5
parent: "3443"
status: resolved
scope: ["we:scripts/operations/__tests__/command-redact.test.mjs", "we:scripts/operations/command-redact.mjs", "we:scripts/operations/telemetry-cli.mjs", "we:scripts/operations/telemetry-store.mjs", "we:scripts/operations/telemetry.mjs"]
dateOpened: "2026-09-22"
dateStarted: "2026-09-24"
dateResolved: "2026-09-24"
tags: []
---

# Graduate telemetry core (telemetry, telemetry-store, telemetry-cli, command-redact) from lane/mechanical-dispatcher to main

Ports 4 files (we:scripts/operations/command-redact.mjs, we:scripts/operations/telemetry.mjs, we:scripts/operations/telemetry-store.mjs, we:scripts/operations/telemetry-cli.mjs) plus their tests. Leaf layer. telemetry-store is imported by gh-throttle, every dispatch wrapper, minimal-context-provider and the runner. Graduation slice of epic #3443 (see its Slice procedure). FAITHFUL PORT: no behaviour change while porting; the branch code lands as-is (operator, 2026-09-22). Port from snapshot 600acc14f of origin/lane/mechanical-dispatcher. For every file main has changed since the merge base ca7e68b71 (check with git log ca7e68b71..origin/main -- <file>), apply the branch diff onto main's current file; never copy the branch file over it. Add only this slice's own lines to we:scripts/operations/run.mjs and the we:scripts/operations/__tests__/http-adapter.test.mjs pin (append-only, so parallel slices merge cleanly). Full gate on main's tree: check:standards, test, smoke. Hold lifted 2026-09-24: the #3857 model-tier table passed a live probe and the operator started wave A.

**Scope correction (2026-09-24, at land time).** `we:scripts/operations/__tests__/telemetry-wiring.test.mjs` and `we:scripts/operations/__tests__/telemetry.test.mjs` were dropped from this slice's scope: both statically import modules that are true downstream leaves scoped to LATER slices — `we:scripts/operations/__tests__/telemetry-wiring.test.mjs` imports `we:scripts/operations/minimal-context-provider.mjs` (#3902), `we:scripts/operations/review-dispatch-wrapper.mjs` (#3908) and the prepare wrappers (#3905); `we:scripts/operations/__tests__/telemetry.test.mjs` imports `we:scripts/operations/host-process-sample.mjs` (#3915). Neither module exists yet, so both test files fail to even load (`Failed to resolve import`) — the original Done-when's "passes on main's tree" was unsatisfiable within this slice alone, since #3902/#3905/#3908 are themselves `blockedBy: 3895` (this item) and cannot land first. `we:scripts/operations/__tests__/telemetry.test.mjs` is re-homed to #3915 (its one dependency, `we:scripts/operations/host-process-sample.mjs`, is already that card's own scope). `we:scripts/operations/__tests__/telemetry-wiring.test.mjs` is re-homed to #3908 (the last-landing of its three dependencies per the epic's critical path `#3897 → #3902 → #3906 → #3903 → #3904 → #3908`, by which point #3902 and #3905 — `blockedBy: 3903`, itself before #3904/#3908 — will already be on `main`). `we:scripts/operations/__tests__/command-redact.test.mjs` is unaffected: it is a true, self-contained leaf (only imports `we:scripts/operations/command-redact.mjs`) and passes standalone.

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/command-redact.test.mjs` passes on main's tree (this slice's one remaining test file; it fails before the port because its module is missing).
2. **Executable** — `npm run check:standards` reports 0 errors, and the PR's required `test` and `smoke` checks are green.
3. **Faithful port** — for each ported file, `git diff 600acc14f -- <file>` (prototype snapshot vs main after the port) shows only main's own later changes kept by the merge notes, never a behaviour change of the branch code; runtime data files (e.g. `we:scripts/conveyor/run-scorecards.json`) are never edited.

## Graduation import check

- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/telemetry.test.mjs` to #3915 — it imports a module #3915 owns.
- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/telemetry-wiring.test.mjs` to #3908 — it imports a module #3908 owns.

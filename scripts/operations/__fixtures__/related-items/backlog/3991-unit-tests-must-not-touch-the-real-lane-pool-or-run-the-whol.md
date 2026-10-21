---
bornAs: x7xv2xt
kind: story
size: 3
status: resolved
scope: ["we:scripts/readiness/dispatch-plan.mjs", "we:scripts/readiness/conveyor-state.mjs", "we:scripts/conveyor/__tests__/dispatcher-fixture-harness.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs", "we:scripts/audit-backlog-health.mjs", "we:scripts/__tests__/audit-backlog-health.test.mjs"]
dateOpened: "2026-09-23"
dateResolved: "2026-09-23"
graduatedTo: none
tags: []
---

# Unit tests must not touch the real lane pool or run the whole backlog audit on import

Observed 2026-09-23: test-spawned processes were the majority of a host-wide git storm. (A) we:scripts/conveyor/__tests__/dispatcher-fixture-harness.test.mjs and we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs run we:scripts/readiness/dispatch-plan.mjs and we:scripts/readiness/conveyor-state.mjs with --backlog-dir=<tmp fixture>, but both still shell the REAL we:scripts/lane-pool.mjs (list --acquirable / status) and we:scripts/readiness/scope-lease-collect.mjs across ~129 real lanes; 13 such processes ran 10-60+ min, several orphaned (ppid 1) after vitest died. Fix: fixture mode (--backlog-dir, or an explicit --free-lanes=/WE_DISPATCH_FREE_LANES) never touches the pool; dispatch-plan child spawns get a timeout and die with the parent; production (no flag) unchanged. (B) we:scripts/__tests__/audit-backlog-health.test.mjs imports pure helpers from we:scripts/audit-backlog-health.mjs, whose top-level body runs the full audit (~10 min CLI; per-item git log walks in gitResolvedAt, and it rewrites the audit report) on import. Fix: main-guard the script body so import has no side effects.

## Done when

1. **Executable** — `npx vitest run` of we:scripts/conveyor/__tests__/dispatcher-fixture-harness.test.mjs and we:scripts/operations/__tests__/dispatch-lane-fixture-harness.test.mjs passes, and a `node` spy on `PATH` (we:scripts/conveyor/__tests__/helpers/node-spy.mjs) shows neither CLI started we:scripts/lane-pool.mjs or we:scripts/readiness/scope-lease-collect.mjs.
2. **Executable** — `npx vitest run` of we:scripts/lib/__tests__/bounded-child.test.mjs passes: a timed-out child is killed along with the processes it started, and an orphaned parent kills its children.
3. **Executable** — `npx vitest run` of we:scripts/__tests__/audit-backlog-health.test.mjs passes in seconds, including a case that imports the module in a fresh process and sees no audit output.
4. **Observable** — `npm run check:health` gives the same flags as before the change on the real repo (the per-item git walks become two whole-directory passes).

---
bornAs: xa9fkfz
kind: story
size: 5
parent: "3443"
status: resolved
scope: ["we:scripts/readiness/dispatch-pause.mjs", "we:scripts/readiness/__tests__/dispatch-pause.test.mjs", "we:scripts/readiness/dispatch-plan.mjs", "we:scripts/readiness/__tests__/dispatch-plan.test.mjs", "we:scripts/readiness/queue-report.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs", "we:scripts/conveyor/__tests__/tick-core-wall-clock-ttl.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-09-22"
dateStarted: "2026-09-24"
dateResolved: "2026-09-24"
tags: []
---

# Graduate dispatch gate and tick-core pure core from lane/mechanical-dispatcher to main

Ports we:scripts/readiness/dispatch-pause.mjs, we:scripts/readiness/dispatch-plan.mjs, we:scripts/readiness/queue-report.mjs, we:scripts/conveyor/tick-core.mjs and we:scripts/check-standards-rules.mjs, plus their tests. Graduation slice of epic #3443, split out of #3487 on 2026-09-22. FAITHFUL PORT: no behaviour change; port from snapshot 600acc14f of origin/lane/mechanical-dispatcher and diff-merge every file main has also changed (see the merge notes on this card). Full gate on main's tree: check:standards, test, smoke. Hold lifted 2026-09-24: the #3857 model-tier table passed a live probe and the operator started wave A.

## Done when

1. **Executable** — `npx vitest run we:scripts/readiness/__tests__/dispatch-pause.test.mjs we:scripts/readiness/__tests__/dispatch-plan.test.mjs we:scripts/conveyor/__tests__/tick-core.test.mjs we:scripts/conveyor/__tests__/tick-core-wall-clock-ttl.test.mjs we:scripts/__tests__/check-standards.test.mjs` passes on main's tree (all of this slice's tests; each fails before the port because its module is missing or differs).
2. **Executable** — `npm run check:standards` reports 0 errors, and the PR's required `test` and `smoke` checks are green.
3. **Faithful port** — for each ported file, `git diff 600acc14f -- <file>` (prototype snapshot vs main after the port) shows only main's own later changes kept by the merge notes, never a behaviour change of the branch code; runtime data files (e.g. `we:scripts/conveyor/run-scorecards.json`) are never edited.

### S2 — dispatch gate + tick-core pure core (size 5)

**Blockers:** none hard. Soft: #3897 (`validateSizePolicy` in `we:scripts/lib/dispatch-contracts.mjs`, `we:scripts/lib/dispatch-size-policy.json`) and #3906 (`defaultReadSizePolicy` in `we:scripts/operations/dispatch-lane-io.mjs`). `we:scripts/readiness/dispatch-plan.mjs` imports both dynamically and fails open, so before they land the size gate is simply off — which is main's behaviour today. Gate stays green either way.

**Files (incl. tests):**
- `we:scripts/readiness/dispatch-pause.mjs`, `we:scripts/readiness/__tests__/dispatch-pause.test.mjs`
- `we:scripts/readiness/dispatch-plan.mjs`, `we:scripts/readiness/__tests__/dispatch-plan.test.mjs`
- `we:scripts/readiness/queue-report.mjs`
- `we:scripts/conveyor/tick-core.mjs`, `we:scripts/conveyor/__tests__/tick-core.test.mjs`, `we:scripts/conveyor/__tests__/tick-core-wall-clock-ttl.test.mjs`
- `we:scripts/check-standards-rules.mjs`, `we:scripts/__tests__/check-standards.test.mjs`

**Branch commits / runner features carried:** `922be85b5` (kind-scoped dispatch-pause), `e3d11b713` (#3849 scope + size admission; tick-core + dispatch-plan + queue-report), `b696d6435` (#3839 `estimatedLoc:` field), `56a333e63` (locus-prefix auto-fix), `bf34fe609` (#3403 durable build-guard floor), `9a2c50c78` (session-reaper liveness), the tick-core half of `5f38cb023` (`computeTickCounts`) and of `bfa0e2c0d` (`guardTtlElapsed`, `TTL_MS_PER_TICK`, wall-clock guard stamps), the `--queue-file` / `queueFileRows` half of `c32f875e8` (#3720). `f21921302` is already on main as `8d8a85793` (#3567).

**Why the seam is clean (and where it is not):**
- Import order forces this grouping: `we:scripts/conveyor/tick-core.mjs` and `we:scripts/readiness/dispatch-plan.mjs` both import new `we:scripts/readiness/dispatch-pause.mjs` exports (`resolvePausedKinds`, `isScopedPause`, `PAUSABLE_KINDS`, `normalizePausedKinds`). `922be85b5` and `e3d11b713` each span these files, all inside this slice.
- Not fully clean: `5f38cb023` and `bfa0e2c0d` also edit runner / supervisor / tick-once (S4). Their tick-core halves are additive with defaults (`now = null` falls back to tick-counted TTLs), so tick-core behaves exactly like main until S4's runner starts passing `now`. `c32f875e8`'s dispatch-plan half adds an opt-in `--queue-file` flag; the runner half that uses it lands in S4.
- `we:scripts/conveyor/__tests__/tick-core.test.mjs` imports only tick-core and `sessionSlugFor` (already on main).

**Merge notes** (freshness rule: route tick-core, its test, queue-report and dispatch-plan through the staging ref `origin/lane/mechanical-dispatcher-catchup` — step 1 `git merge-file catchup <659744301> ff1618065`, step 2 `git merge-file origin/main 5ab140f50 <step1>`; a direct 3-way from `ca7e68b71` gives 7 / 4 / 1 / 7 conflicts instead):
- `we:scripts/conveyor/__tests__/tick-core.test.mjs`, `we:scripts/readiness/queue-report.mjs` — 0 conflicts via catchup.
- `we:scripts/conveyor/tick-core.mjs` — 1 region via catchup, the `planPrepareSpawns({...})` call in `planTick` (~L1266). Catchup passes `pausedKinds` into `planPrepareSpawns` (per-kind `dispatch-paused` trace, #3612); the branch empties each input per kind instead. Resolution: keep catchup's pass-through (`unshaped, decisions, investigations, ..., pausedKinds`) but with `unshaped: scopeOrSizeNeeded` (#3849), and take the branch's comment line about the `no-size` union.
- `we:scripts/readiness/dispatch-plan.mjs` — 5 regions via catchup:
  1. imports — keep main's `import { driftDefaults, findPocBranch, readRegistry } from we:scripts/lib/poc-branches.mjs` plus the branch's `import { PAUSABLE_KINDS, normalizePausedKinds, resolvePausedKinds } from we:scripts/readiness/dispatch-pause.mjs`.
  2. `dispatchPlan` signature — union: `{ queue, leases, freeLanes, driftBlockedScope, driftGraduationItem, maxConcurrentLanes = Infinity, dispatchPaused = false, dispatchPausedKinds = null, sizePolicy = null, trace = false }` (`driftGraduationItem` is main's #3836).
  3. keep the branch's new `queueFileRows(text, norm)` and catchup's `selectClearedRows(rows, clearedKeys, norm, observe = null)`.
  4. CLI row read — the branch's `if (queueFile) { ... } else { ... }`, with catchup's `selection` map / `observeSelection` kept inside the `else` and passed to `selectClearedRows`.
  5. CLI `dispatchPlan(...)` call — all args: `driftGraduationItem, maxConcurrentLanes, dispatchPaused, dispatchPausedKinds, sizePolicy, trace: true`.
- `we:scripts/readiness/__tests__/dispatch-plan.test.mjs` — clean direct 3-way (main `368e2155f`, `8d8a85793`).
- `we:scripts/check-standards-rules.mjs` — clean direct 3-way (main `be331b127`, `d9857a594`, #3567 on both sides).
- `we:scripts/readiness/dispatch-pause.mjs` (+test), `we:scripts/conveyor/__tests__/tick-core-wall-clock-ttl.test.mjs`, `we:scripts/__tests__/check-standards.test.mjs` — main untouched; apply as-is.

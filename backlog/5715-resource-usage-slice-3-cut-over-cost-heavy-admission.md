---
bornAs: x6nuodj
kind: story
size: 8
priority: high
parent: "5712"
status: resolved
blockedBy: ["5714"]
scope: ["we:scripts/lib/cost-admission.mjs", "we:scripts/lib/cost-admission-facts.mjs", "we:scripts/lib/__tests__/cost-admission.test.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/conveyor/__tests__/tick-core-cost-admission.test.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/lib/dispatch-throttle.mjs", "we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/lib/ci-heal-reserve.mjs"]
dateOpened: "2026-10-09"
dateResolved: "2026-10-10"
tags: []
---

# Resource service slice 3: cut builder cost admission, light caps and heavy load admission over to admit()

Builder cost admission (we:scripts/lib/cost-admission.mjs admitLaunch, CPU idle floors per kind from we:scripts/dispatch-settings.json cpuIdleMinPct, WE_COST_ADMISSION), the light-launch cap and floor (lightCapFor, WE_MIN_CPU_IDLE_PCT_LIGHT), the fix/ci-heal throttles (we:scripts/lib/dispatch-throttle.mjs, we:scripts/lib/fix-slot-borrow.mjs, we:scripts/lib/ci-heal-reserve.mjs, load per core) and heavy load admission (we:scripts/readiness/heavy-admission.mjs resolveLoadAdmission) decide through admit({kind}) for build, fix, ci-heal, review, prepare and light. The builder-daemon call site was held by PRs #4643/#4658/#4663/#4677 during slice 1, so its shadow call lands here first, then the cut-over. Done when: tests pin each gate's verdict comes from admit(); LIVE proof — a builder tick at high load average but healthy CPU idle launches, with the log naming the admit verdict and the snapshot age.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/resource-gate.test.mjs we:scripts/readiness/__tests__/heavy-admission.test.mjs we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs` (paths without the `we:` prefix) — fails before (no `we:scripts/lib/resource-gate.mjs`, no `fixQueueLengthOf`, `resolveLoadAdmission` ignores `admit()`), passes after.
- [A2] Each kind (build 15 %, fix 8 %, ci-heal 8 %, review 10 % CPU idle; prepare/light light) is admitted at its threshold and waits just below it, against a legacy verdict saying the opposite — the verdict comes from `admit()`.
- [A3] Stale or missing snapshot: heavy kinds hold, light kinds admit, always logged (`unknown: true`).
- [A4] The fixer cap is dynamic: floor = the old static cap (`WE_FIX_DISPATCH_MAX_CONCURRENT`), ceiling = floor + 4 (settings `resourceGate.fixCap`); raised only when the snapshot is fresh, `fix` is admitted, CPU idle ≥ 30 % and more than 5 PRs waited for a fixer last pass; at most 2 above the live count per pass; never on an unknown snapshot.
- [A5] Every gate logs `old … | new …` and then `decided by admit({kind})`; the settings line names each leaf's source.
- [A6] `resourceGate.cutover: shadow` (or `WE_RESOURCE_CUTOVER=shadow`) puts every gate back on its legacy verdict while still logging the pair.

Must: on any error reading the snapshot the shared rule refuses heavy work (hold) and admits light work; an unreadable settings (policy) layer drops only that layer and the standard thresholds apply (edge case 4); a failure of the observer itself leaves the legacy verdict (never an unconditional admit). An `unknown` (no-data) hold is never treated as outside evidence that the host is busy (the rebuild-smoke busy-pool skip keeps the legacy load rule).

## Non-goals

- [N1] Deleting the old checks (`gateHost`, `WE_MIN_CPU_IDLE_PCT_*`, the light floor) — slice 4 (xmd6ngm).
- [N2] The heavy SLOT count (`WE_HEAVY_ADMISSION_CAP` 4 + 2 fast) stays a semaphore; only the heavy LOAD admission (`load-status`, read by tick-core for the builder) moved onto `admit()`.
- [N3] The builder's per-launch host gate (`cliHostLoadGate` in we:skills-src/conveyor/build-dispatch-daemon.mjs) was held by another agent's scope; it keeps the legacy `gateHost` until slice 4 swaps it for `gateLaunch` (one line). The builder's tick-core load gate and its light gate do decide through `admit()` here.

## Edge cases this change must handle

1. **Untrusted text** — n/a: inputs are the sampler's own snapshot and declared settings files; no external text.
2. **Truncated reads** — a torn/unparseable snapshot reads as missing → unknown → hold heavy, admit light.
3. **Shared state files** — the snapshot is written atomically by the sampler; this slice only reads it; shadow rows use the existing locked append.
4. **Fail closed** — unknown/stale snapshot holds heavy; an unreadable settings layer drops only that layer (named in the settings log line); the cap never rises on an unknown snapshot.
5. **Identity scoping** — n/a: host-wide resource decision, no per-user identity.
6. **State over time** — the fix queue length is the previous pass's count (in-memory, null after a restart → floor); the raise is bounded per pass so the next pass re-reads CPU before adding more.
7. **Who wrote it** — n/a: only the sampler job writes the snapshot; settings come from the declared cascade.

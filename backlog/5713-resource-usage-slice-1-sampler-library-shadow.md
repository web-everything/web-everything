---
bornAs: xkuflno
kind: story
size: 8
priority: high
parent: "5712"
status: resolved
scope: ["we:scripts/lib/resource-admission.mjs", "we:scripts/lib/__tests__/resource-admission.test.mjs", "we:scripts/lib/resource-sampler.mjs", "we:scripts/lib/__tests__/resource-sampler.test.mjs", "we:scripts/conveyor/resource-sampler-job.mjs", "we:scripts/conveyor/resource-sampler-daemon.mjs", "we:scripts/conveyor/__tests__/resource-sampler-job.test.mjs", "we:skills-src/conveyor/launchd/com.we.resource-sampler.plist.example", "we:scripts/operations/resource-status.mjs", "we:scripts/operations/__tests__/resource-status.test.mjs", "we:scripts/operations/run.mjs", "we:scripts/dispatch-settings.json", "we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs"]
dateOpened: "2026-10-09"
dateResolved: "2026-10-09"
tags: []
---

# Resource service slice 1: sampler job, admission library, policy block, resource-status, shadow logging

SHADOW ONLY — no gate changes its decision. Build (a) the sampler: a long-running job on the job model (we:scripts/lib/daemon-jobs-runtime.mjs, #4125; reference adopter #4131 / PR #4691) supervised by a small job-loop daemon, sampling every ~10 s CPU idle % (os.cpus() deltas, not load average), memory pressure level, disk busy % and MB/s, fseventsd CPU %, heavy slots in use (heavy-admission admissionStatus), live agent sessions, lane count, and load average for comparison; it writes one snapshot with sampledAt and freshUntil to the coordination root plus a bounded history. (b) The reader library we:scripts/lib/resource-admission.mjs: admit({kind}) returns {verdict: admit|wait|hold, reason, projectedWaitMinutes, snapshotAge}; a stale or missing snapshot is 'unknown' (hold heavy kinds, admit light kinds, always logged). (c) The policy block: per-kind thresholds (build, prepare, fix, ci-heal, review, rebuild-smoke, load-flake-rearm, light) resolved standard default, then Platform Forever preference, then tool override (we:scripts/dispatch-settings.json resourceAdmission). (d) The read-only resource-status operation printing the snapshot and every kind's verdict. (e) Shadow logging in every gate whose file is free today: rebuild smoke busy test and load scaling (we:scripts/lib/daemon-live-smoke.mjs) and heavy load admission (we:scripts/readiness/heavy-admission.mjs) log the new verdict beside their own. Held gates (load-flake reverify, PR #4700; cost admission and light caps in the builder daemon, PRs #4643/#4658/#4663/#4677) get their shadow call in slices 2 and 3. Done when: unit tests for sampler parsing, admit() incl. stale snapshot, cascade, op; LIVE proof — sampler writes a snapshot every ~10 s, resource-status shows CPU idle/disk/fseventsd, and a shadowed gate logs 'new verdict: admit' beside its old 'hold' in the same tick while load average is high.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` over we:scripts/lib/__tests__/resource-sampler.test.mjs, we:scripts/lib/__tests__/resource-admission.test.mjs, we:scripts/conveyor/__tests__/resource-sampler-job.test.mjs, we:scripts/operations/__tests__/resource-status.test.mjs, we:scripts/lib/__tests__/daemon-live-smoke.test.mjs and we:scripts/readiness/__tests__/heavy-admission.test.mjs fails before (modules missing) and passes after; it pins load 63 / CPU idle 37% → `build` admits.
- [A2] **Live** — the `resource-status` operation of we:scripts/operations/run.mjs prints a fresh snapshot (age under 30 s) with CPU idle, disk and fseventsd, and the shadow log in the coordination root's resource folder holds a gate row with `old.verdict: hold` and `new.verdict: admit`.
- [A3] **No gate changes** — every shadowed gate returns exactly what it returned before (tests compare results with and without the shadow seam, and with a throwing seam).

## Non-goals

- [N1] No gate decides through `admit()` yet (slices 2 and 3), no old check is deleted (slice 4), and no disk threshold is set by default (calibrated in slice 2 from the shadow log).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the sampler parses only local command output (`ioreg`, `sysctl`, `ps`) with strict number regexes; unparseable output leaves the field null and is named in `errors`.
2. **Truncated reads** — a missing or half-written snapshot reads as null (written atomically); null means `unknown`: heavy kinds hold, light kinds admit, and it is always logged.
3. **Shared state files** — the snapshot is replaced atomically; history and shadow logs append under a file lock and are bounded by bytes (8 MB, keep the newest half).
4. **Fail closed** — the shadow call never throws into a gate and never writes to stdout (heavy admission's `--json` stays a clean contract); `WE_RESOURCE_SHADOW=off` in either env silences it.
5. **Identity scoping** — one sampler per host: the supervisor keeps one live job of kind `resource-sample` (cap 1, ensure-under-lock).
6. **State over time** — `freshUntil` is three sample intervals after `sampledAt`; past it the snapshot is stale and treated as unknown.
7. **Who wrote it** — only the sampler job writes the snapshot; shadow rows name the gate that wrote them.

## Progress (2026-10-09, build)

- **Where things live.** Sampler core we:scripts/lib/resource-sampler.mjs; reader + policy + storage we:scripts/lib/resource-admission.mjs (storage sits in the reader so imports stay one-way: the sampler imports we:scripts/readiness/heavy-admission.mjs for its slot count, and heavy admission imports the reader for its shadow call). The job is we:scripts/conveyor/resource-sampler-job.mjs (one long-running `sample-loop` step, heartbeated by the job runtime), supervised by we:scripts/conveyor/resource-sampler-daemon.mjs (`startJobLoop`, cap 1, enqueues a fresh job when the last one is terminal). The snapshot, a bounded history and the shadow log live in the coordination root's resource folder.
- **CPU idle comes from `os.cpus()` deltas**, never from load average. Load average is recorded for comparison only and never decides.
- **Disk is record-only by default.** ioreg's Total Time sums overlapping requests, so the first live sample read disk 100% busy (several I/Os in flight) while the CPU was 45% idle. A default disk limit would have re-created this epic's bug, so `maxDiskBusyPct` defaults to null; slice 2 calibrates it from the shadow log. `ioDepth` (average I/Os in flight) is recorded uncapped.
- **fsevents backlog** has no public macOS counter: recorded as `null`. fseventsd CPU % is recorded.
- **Policy cascade.** Standard default in the reader → Platform Forever preference (env `WE_PLATFORM_PREFERENCES` or the operator's platform-preferences JSON under their Claude home, key `resourceAdmission`) → tool override (we:scripts/dispatch-settings.json, key `resourceAdmission`). No override is set today.
- **Shadowed here:** rebuild smoke's busy-pool test and load-scaled budgets (we:scripts/lib/daemon-live-smoke.mjs), heavy load admission (we:scripts/readiness/heavy-admission.mjs `load-status`). **Moved because the file was held:** load-flake reverify (PR #4700), the load-shaped smoke hold in we:scripts/lib/daemon-rebuild/smoke.mjs (PR #4712) and the daemon-manifest registration (PR #4691) → slice 2; builder cost admission and light caps in we:skills-src/conveyor/build-dispatch-daemon.mjs (PRs #4643/#4658/#4663/#4677) → slice 3.

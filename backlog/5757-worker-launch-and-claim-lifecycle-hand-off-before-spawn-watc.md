---
bornAs: xt3sgtl
kind: story
size: 5
parent: "5767"
status: open
blockedBy: ["5754"]
scope: ["we:scripts/conveyor/fix-dispatch-claim.mjs", "we:scripts/operations/worker-wrapper.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Worker launch and claim lifecycle: hand-off before spawn, watchdog, terminal rule

Slice W1 of the async-daemons epic. Claim format N/N-1: the existing we:scripts/conveyor/fix-dispatch-claim.mjs entry stays (owner, meta, TTL, refresh up to `MAX_FIX_DISPATCH_CLAIM_REFRESH_MS`) plus optional `meta.ownerRun = {runId, handle|null}`; old code ignores it and still sees a foreign owner as held; new code treats an old-format claim under today's TTL rules. Hand-off before spawn: under the claim the task allocates the worker run record first (`status: launching`, runId, effectId, launchToken), sets `ownerRun = {runId, handle: null}` by CAS, then spawns; the worker's first act claims its own launch attempt and writes `handle = host:pid:procStart` (same rule as `runJob`: a worker whose record is no longer `launching` for its attempt refuses to run); no handle after the launch grace -> `launch-failed`, claim released by CAS on `runId + handle:null`. Refresh and release compare `runId + handle`. Watchdog: `maxLifetimeMs` and `progressStaleMs` (cascade) -> a `stop-worker` task runs `stopHandle` (SIGTERM, SIGCONT, SIGKILL), confirms gone by pid+procStart, releases by CAS. Terminal rule (O15): a process that cannot be confirmed gone or probed moves its claim to `quarantined` and the health daemon opens an episode; never lapses on TTL. The design named conveyor/worker-wrapper*.mjs; the live wrapper is we:scripts/operations/worker-wrapper.mjs. Coordinate with #5616 (worker result contract S3b, launches through the detached wrapper).

## Acceptance

- [A1] **Executable** — the worker run record and `ownerRun` are written before spawn; the worker claims its own launch attempt; the CAS key is `runId + handle`; a watchdog (`maxLifetimeMs`, `progressStaleMs`) feeds `stop-worker`; a `quarantined` state opens a health episode.
- [A2] **Crash test (a)** — kill the task between allocating the run record and spawning: no worker starts, and the claim is released by CAS after the launch grace (J2-5).
- [A3] **Crash test (b)** — kill between spawn and the worker's handle write: the late worker refuses to run if its record moved on, otherwise it is adopted; the claim never has two owners (J2-5).
- [A4] **Crash test (c)** — dispatch is idempotent through a run-store lookup by `effectId`, never a GitHub re-read; a re-run task finds the existing worker and launches no second one (J2-4).
- [A5] **Crash test (d)** — a late release or refresh from an old `runId` or handle does nothing (J2-2).
- [A6] **Crash test (e)** — a hung but alive worker (SIGSTOP) past `progressStaleMs` is stopped, confirmed gone, and its claim released (J2-1, J2-7).
- [A7] **Crash test (f)** — a worker that cannot be probed or killed moves its claim to `quarantined` and opens a health episode; the claim does not lapse on TTL (J2-14, J2-19).
- [A8] **Crash test (g)** — N/N-1 both directions: the old inline fixer honours a new-format claim, and the task path honours an old-format claim.
- [A9] **Live** — one real fix dispatch shows the run record created before the worker pid in the run store, and the claim owner moving from `runId/null` to `runId/handle`.

## Non-goals

- [N1] Review and build launches (S4, S5 reuse this lifecycle).
- [N2] Claim adoption across a blue-green hand-over (sibling epic).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — `ownerRun` fields are validated (runId shape, handle `host:pid:procStart`) before any compare; a malformed value is treated as an old-format claim under TTL rules.
2. **Truncated reads** — An unreadable claim or run record counts as held: nothing is dispatched on a partial read.
3. **Shared state files** — Refresh and release are CAS on `runId + handle` under the existing claim lock; a late writer with stale ids changes nothing.
4. **Fail closed** — A process that cannot be confirmed gone is quarantined, never released on TTL (O15).
5. **Identity scoping** — The handle includes host and process start time, so pid reuse never matches.
6. **State over time** — Watchdog limits `maxLifetimeMs` / `progressStaleMs` come from the cascade; both claim formats are tested both ways.
7. **Who wrote it** — Only the role holding the run record refreshes or releases it (R14).

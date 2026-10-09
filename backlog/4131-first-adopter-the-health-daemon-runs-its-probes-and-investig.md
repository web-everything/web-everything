---
bornAs: xqw7hb2
kind: story
size: 5
parent: "4075"
status: resolved
blockedBy: ["4125"]
scope: ["we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/health-watch-job.mjs", "we:scripts/conveyor/__tests__/health-watch*.test.mjs", "we:skills-src/conveyor/daemon-manifest.mjs", "we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs"]
dateOpened: "2026-09-24"
dateResolved: "2026-10-09"
preparedDate: "2026-10-08"
preparedAgainstSha: "47d73d01f584ded51a3a021b444c2b7f25bd7349"
tags: []
---

# First adopter: the health daemon runs its gh-cadence probes as a detached job

First slice of the health daemon's adoption of the shared job runtime (#4125, statute [we:docs/agent/platform-decisions.md#daemon-jobs](../docs/agent/platform-decisions.md#daemon-jobs)). The gh-cadence probe group (open PRs, the agent listing and every read off it, stale-state, merged PRs) runs every 15 minutes and was the slow part of a health tick: on the live daemon a tick that ran it took 139–162 s against a 60 s budget, every other tick 15–25 s. This slice moves that group into a detached, durable `health-gh-probe` job. The tick only queues it, reattaches it and consumes its finished result once; it never waits on it.

## Split (2026-10-09)

Prepared at size 8 for the whole adopter. It splits cleanly under the split-safety rubric: the remaining work is volume, not an open fork (the prepared design rules every part), each part is a ≤5 slice with named files, and each ships on its own. This card is now slice 1, the live adopter. The rest (other slow reads, diagnoses with durable intent, the investigation lifecycle job, the daemon-job-health smell) is filed as #xz5m67t with #4131's prepared design, test plan and proof plan moved there verbatim.

## Scope

- we:skills-src/conveyor/daemon-manifest.mjs — the health job kinds: `health-gh-probe` (`readonly-tree`, pinned snapshot plus a lockfile-keyed `node_modules` store), the daemon cap (2) and each kind's default rollout switch `HEALTH_WATCH_JOB_SWITCHES.ghProbes`. The health watch's own config file overrides it per kind without a deploy (`jobs: { ghProbes: true }` to turn it on, `false` to roll back). A dry run or a fixture tick never touches the host job store. After a rollback the tick still reconciles a job left in flight (reattach and consume, never queue) until no health job record remains, and a result sampled more than 30 minutes ago is consumed but never applied as the current sample.
- we:scripts/conveyor/health-watch-job.mjs — tick side (`runGhProbeJobs`: consume finished results once, queue when due with none in flight, reattach and admit through the shared runtime, evict unreferenced snapshots, prune consumed records after 24 h), the job child (claims through `runJob`, heartbeats from its own event loop) and the worker thread that runs the synchronous probe bodies. The worker thread dies with the job process. The probes' own subprocesses (`gh`, the stale-state CLI) sit in the job's process group: a graceful stop (SIGTERM) kills the whole group, while after a SIGKILL they may finish their own bounded timeouts (≤ 90 s) beside the retry. They only read, so such an overlap duplicates a read, never a write. The sleep rule works across single-shot tick processes from a persisted wall/host-monotonic sample (a monotonic clock that went backwards is a reboot and discards the sample).
- we:scripts/conveyor/health-watch.mjs — `collectGhProbes` (the same probes as before, now with explicit roots: `liveBindings` gets `[sourceRoot, ...daemon clone roots]`, identical to its old default when `sourceRoot` is this checkout) is shared by the inline path and the job; it takes the real clone as `sourceRoot`, so a job running from a snapshot still reads the clone's backlog, review jobs and stale-state CLI. The tick consumes a job result into the same probe slots; `ghCache.at` becomes the job's sample time. A queued or running job leaves the gh probes absent (not sampled), exactly as an off-cadence tick already did.

## Done when

1. **Executable** (run from the WE root with the `we:` locators removed) — `npm run test:unit -- we:scripts/conveyor/__tests__/health-watch-jobs.test.mjs we:scripts/conveyor/__tests__/health-watch-job.test.mjs we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs` fails before this lands (no job module, no kinds; the tick probes inline) and passes after; the existing health suites (`health-watch`, `health-watch-core`, `health-watch-operation-runs-bounded`, `health-watch-heavy-run`, `health-investigate-dispatch`) still pass.
2. **Live** — on the live health daemon a gh-probe job runs detached with a durable record, survives a daemon restart (same handle and attempt, reattached, result consumed once), and the ticks around it stay within budget.

## Progress

- **Built (2026-10-09).** Kinds, cap and switch in the manifest; the job module; `collectGhProbes` and the job branch in the tick. Real bug caught by the child test: a snapshot under a symlinked directory (macOS `/var` → `/private/var`) is spawned by its link path while `import.meta.url` is the resolved one, so the child's "am I the entry" check silently did nothing. It now compares real paths.
- **Tests.** we:scripts/conveyor/__tests__/health-watch-jobs.test.mjs (tick side: one job per due cadence and no duplicate in flight, result consumed once, failed job is a probe error and the cadence stays due, pruning, cross-process sleep rule, switch override, the tick never runs the group inline in job mode, inline when the switch is off); we:scripts/conveyor/__tests__/health-watch-job.test.mjs (a real detached child from a snapshot: heartbeat advances while its worker is blocked, result sidecar, consumed once; idempotent step; worker timeout); we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs (kind shape, entry exists, cap, switch). Red on main: both new test files fail to import the job module and the manifest test finds no kinds. All 271 tests across the eight health/manifest files pass after.
- **Converge (2 rounds, elevated).** The fixes that came out of it: job mode only when the switch is on, never on a dry run or on a fixture tick without its own store; a rollback keeps reconciling and drains the records; stale results are never applied; a graceful stop kills the job's process group, with a test that goes red when the handler is removed; the proof probe blocks on a real subprocess.
- **Rollout.** The manifest default stays `false` in this PR. The live health daemon is switched on through its own config file (`jobs.ghProbes: true`) for the live proof, which is recorded on the PR. Flipping the manifest default is a one-line follow-up once that proof is reviewed.
- **Not in this slice** (see #xz5m67t): diagnoses, investigations and the other command-backed reads still run inline; the daemon-job-health smell does not exist yet; we:scripts/conveyor/health-watch-core.mjs is unchanged (the gh probes were already absent on off-cadence ticks, so no new missing-sample semantics were introduced).

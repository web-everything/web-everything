---
bornAs: xxkqmjj
kind: story
size: 3
priority: high
parent: "4075"
status: open
blockedBy: ["4131"]
scope: ["we:scripts/conveyor/verify-dispatch.mjs", "we:skills-src/conveyor/verify-daemon.mjs", "we:scripts/conveyor/verify-gate-job.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# Verify daemon: each gate run is a detached job with its own record, not an awaited child

Slice of decision 4120 (daemon job model); audit we:reports/2026-09-24-daemon-blocking-antipatterns.md. Filed uncleared until 4120 is ratified; the shape below follows its bold defaults and changes with the ruling. Finding V1, structural part (after 4130 fixes the heartbeat). we:scripts/conveyor/verify-dispatch.mjs awaits each lane's gate (up to 30 min plus queue time) one lane after another. Shape: each gate run becomes a job keyed by (pool, lane, headSha), so a restart of the verify daemon reattaches instead of re-running, and lanes run up to the verify cap in parallel under the existing heavy-command admission. Done when: tests; LIVE proof: restart the verify daemon mid-gate and show the gate finishes once with one verdict marker.

## Done when

1. **Executable** — `npm run test:unit` over we:scripts/conveyor/__tests__/verify-gate-job.test.mjs,
   we:skills-src/conveyor/__tests__/verify-daemon.test.mjs and we:scripts/conveyor/__tests__/verify-dispatch.test.mjs
   fails before this lands (no gate-job module, no `launchGate`, a code-change restart waits on every in-flight run)
   and passes after.
2. **Live** — on the live verify daemon a gate runs as a detached job, survives a daemon restart (re-attached, one
   verdict stamped once), and ticks continue meanwhile.

## Progress

- **Before (live, 2026-10-09/10).** Ticks were already non-blocking (2026-10-05) and a graceful SIGTERM already
  handed gates to the successor (#65). What was left: the gate's ceilings, kill and settlement lived inside the
  daemon process. So (a) a code-change restart waited for the in-flight registry to empty — the clone
  `wev-control` moved at 2026-10-09T23:15:02Z and the daemon kept running the old code until a hand SIGTERM at
  2026-10-10T00:23:55Z, 4–5 gates in flight the whole time; (b) gates adopted after a SIGTERM had no ceilings and
  no verdict line (`adopted run 69b2edc3 finished (pid 94824 gone) — released`); (c) a crash or `kill -9` left no
  hand-off, so the next daemon re-dispatched a lane whose gate was still running.
- **Shape.** we:scripts/conveyor/verify-gate-job.mjs — job kind `verify-gate` (readonly-tree snapshot of the clone
  HEAD, `maxAttempts: 2`) on the #4125 runtime, records in `~/.claude/daemon-jobs/verify-daemon/`. The job child is
  the gate's supervisor: it re-checks that the marker is still this request (keyed by lane dir, runId, headSha),
  runs the SAME `runLaneGate` the in-process sweep uses (both ceilings, marker ownership, infrastructure-failure
  stamp — extracted, not copied), records the gate's `host:pid:procStart` handle and writes the verdict. A dead
  supervisor is relaunched once; the relaunch kills a surviving gate first and re-checks the marker, so a lane is
  never gated twice at once. SIGTERM to a supervisor takes its gate down with it.
- **Daemon.** we:skills-src/conveyor/verify-daemon.mjs rebuilds its in-flight registry from the job store every tick
  BEFORE dispatch, queues through `runVerifyDispatch`'s new `launchGate`, launches in the same tick, and consumes each
  finished job once (`gate job … settled: green — marker green @ <sha>`). A code-change restart no longer waits for
  jobs; no exit kills a job except `restartInFlight: kill`. Rollback: `WE_VERIFY_GATE_AS_JOB=0`.
- **Unchanged.** Marker keyed to exact HEAD, heavy admission (verify-lane's own slot), since-last-green selection
  (#4732, inside verify-lane), supersede rules (the daemon kills the job's gate group from its recorded handle), the
  max-in-flight cap, the drain file.
- **Edge.** Overlaid onto the verify daemon clone `wev-control` (PR 4764) and loaded 2026-10-10T13:30:24Z: the
  restarted daemon logs `gates run as detached jobs (~/.claude/daemon-jobs/verify-daemon)` and adopted the two
  in-process runs the old daemon handed off.

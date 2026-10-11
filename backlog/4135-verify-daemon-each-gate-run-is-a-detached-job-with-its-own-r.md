---
bornAs: xxkqmjj
kind: story
size: 3
priority: high
parent: "4075"
status: resolved
blockedBy: ["4131"]
scope: ["we:scripts/conveyor/verify-dispatch.mjs", "we:skills-src/conveyor/verify-daemon.mjs", "we:scripts/conveyor/verify-gate-job.mjs"]
dateOpened: "2026-09-24"
dateStarted: "2026-10-10"
dateResolved: "2026-10-10"
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
  jobs; no exit kills a job except `restartInFlight: kill`. Rollback: `WE_VERIFY_GATE_AS_JOB=0` runs NEW gates
  in-process and starts no gate supervisor (queued or relaunched), but the daemon still reads the job store and its
  lane claims each tick, so a detached gate still running — or not provably gone — holds its lane. Reverting the code
  itself is safe only once no lane claim is held: run with `WE_VERIFY_GATE_AS_JOB=0` until the daemon log shows no
  `⚠ HEALTH lane … is held` and no job entry, then revert.
- **One gate per lane (operator ruling 2026-10-10 on PR 4764, = daemon design O15).** A new gate starts on a lane only
  once the previous one is CONFIRMED gone: its handle probes dead by pid + start time and its process group is gone.
  An unreadable or foreign handle or record, a pid with no start time, a gate recorded only as pending: each means
  "possibly running" — the lane is held with a `⚠ HEALTH` log line, never treated as free, and an operator who has
  checked the gate is gone releases it with `node we:scripts/conveyor/verify-gate-job.mjs release-lane --dir=<lane>`.
  Between jobs this is the LANE CLAIM, taken before anything is recorded or spawned: the lane's next numbered claim
  file is created exclusively (`link`), so of two jobs racing for a lane exactly one wins whatever their clocks say;
  it passes on only once the holder's supervisor (its handle is in the claim) and its gate are proven gone. The
  dispatch sweep asks the same claims right before every start, in both modes.
- **Unchanged.** Marker keyed to exact HEAD, heavy admission (verify-lane's own slot), since-last-green selection
  (#4732, inside verify-lane), supersede rules (the daemon kills the job's gate group from its recorded handle), the
  max-in-flight cap, the drain file.
- **Edge.** Overlaid onto the verify daemon clone `wev-control` (PR 4764) and loaded 2026-10-10T13:30:24Z: the
  restarted daemon logs `gates run as detached jobs (~/.claude/daemon-jobs/verify-daemon)` and adopted the two
  in-process runs the old daemon handed off.
- **Live proof (2026-10-10, verify daemon on `wev-control`).** Lane 16 @ 284dda8f ran as job
  `job-verify-gate-ce46a837…` (gate pid 42698). Timeline from its record: queued 13:34:47Z · launched/started
  13:35:06Z (attempt 1) · gate started 13:35:21Z · finished 13:44:46Z — launched once, started once, finished once.
  Two daemon restarts happened mid-flight; both re-attached, neither killed nor re-dispatched:
  ```
  13:35:14.522Z SIGTERM — left 2 gate job(s) running detached — the next daemon re-attaches from the job store.
  13:35:14.782Z re-attached gate job job-verify-gate-ce46a837… for web-everything/lane-16 @ 284dda8f (gate pid 42698)
  13:37:47.752Z loop stopped (code-changed) — left 5 gate job(s) running detached
  13:37:48.332Z re-attached gate job job-verify-gate-ce46a837… for web-everything/lane-16 @ 284dda8f (gate pid 42698)
  13:37:48.332Z gates run as detached jobs (…/daemon-jobs/verify-daemon); 5 re-attached at boot.
  ```
  The code-change restart at 13:37:47Z exited at once with 5 gates in flight (before: it waited 69 minutes).
  Ticks kept running while the gate ran (13:37:58Z, 13:40:25Z, 13:42:43Z). One verdict: the lane marker is
  `green @ 284dda8f` finished 13:44:46.337Z, and the job result says `green`, attempt 1. Other lanes' jobs
  re-attached by the same restart settled once each (`gate job … for web-everything/lane-12 @ da4984d1 settled:
  green — marker green @ da4984d1 [attempt 1]`).
- **Supervisor `kill -9` (fixture lane, real detached job).** The dead supervisor was requeued, the new daemon did
  not re-dispatch the lane (`dispatched=0`), the orphaned gate settled green itself, and attempt 2 found the marker
  settled and ran nothing (`settled: stale — marker green`); the gate ran once.
- **Residuals** filed as x8ordg8: the first snapshot build per clone HEAD blocks one tick (28 s live), a relaunch
  kills a surviving gate instead of re-attaching to it, and verify-lane notice lines now land in the job log.

## Runner activity report

`node scripts/operations/run.mjs runner-activity --json` reports the liveness of all three known
standalone conveyor daemons in `verdict.runners` — an array of `{ name, present, pid, alive,
heartbeatAt, source, livenessSource, state, stalled, stalledReason, ... }`, one entry per daemon in
`KNOWN_DAEMONS` (`scripts/operations/runner-activity-io.mjs`): `dispatcher` (the mechanized tick
driver, `skills-src/conveyor/runner.mjs`), `fix-dispatch` (`reconcile-fix-dispatch-daemon.mjs`,
#3870), and `review` (`review-daemon.mjs`, #3876) — each its own machine-global singleton lease
under the same primitive (`skills-src/conveyor/runner-lock.mjs`), keyed distinctly so none contend.
Every entry uses the same four-state vocabulary — `down` (no lease) / `dead` (the recorded PID no
longer identifies that daemon's own process) / `alive-and-stalled` / `alive-and-idle` — computed
identically per daemon by `assessDaemonState`. Only `dispatcher` corroborates against a tick (the
driven checkout's `.conveyor/driver-status.json`: zero-based tick number, timestamp, planned
dispatch lists, the tick core's own held-work stalls); `fix-dispatch` and `review` have no tick
concept of their own and are assessed on heartbeat freshness alone. A single snapshot proves
recency, not continuous progress between observations. The stale window is the existing runner
lease duration. Missing first-tick data stays null, with the fresh lease providing startup evidence.

The top-level `state`/`stalled`/`stalledReason`/`dispatching`/`checkout` fields mirror the
`dispatcher` entry specifically — the pre-existing "driver health" vocabulary, kept so a caller that
only ever cared about the conveyor dispatcher reads the same shape as before this operation reported
on three daemons. `inFlightDispatches`, `completedDispatches`, `lastTick`, and `dispatching` stay
dispatcher-only top-level fields; the fix-dispatch/review daemons have no dispatch-lane or tick
concept of their own, so those are never forced into their `runners[]` entries.

**Failure isolation.** Reading ONE daemon's own lock directory (a corrupt `lock.json`, an unreadable
lock dir, or a lease with no usable PID) never aborts the whole snapshot: it surfaces only in that
daemon's own entry as `present: null` (distinct from `present: false`, a genuinely absent lease) plus
an `error` string, and `state: 'down'`. The other daemons' entries are unaffected. This is narrower
than it sounds — it covers only the lease file's own read/parse. A genuine `ps`/`lsof` infra failure
during a daemon's process-identity check (a permission error, a timeout — never a plain "no such
PID", which is ordinary process-gone evidence) still propagates as an operation error for the WHOLE
read, for every daemon, not just the dispatcher: the pre-existing #3884 fix (a timeout must never
silently masquerade as "dead") generalizes to all three rather than staying dispatcher-only.

In-flight rows reuse `inFlightDispatchesFor`, `stampLiveness`, and `dispatchStillHolds`. Terminal
dispatch effects supply `applied`/`failed` outcomes. Their dispatch-step finish time orders recent
outcomes; legacy records without it explicitly report a `last-attempt-proxy`. Call-log completion
is not dispatch completion: a dispatch call can complete without launching anything.

The IO shell places all synchronous file/store reads inside a 10-second, SIGKILL-bounded snapshot
subprocess; process/session reads have a 2-second bound within it. A failed required read is an
operation error, never `down`. Corrupt individual run records are counted as partial history, and
an unavailable session listing preserves unknown liveness. This report performs no restart,
reaping, tick execution, or liveness write-back. For runner-activity only, CLI persistence (including
resume reads, all run-record writes, and call-log appends) uses separate 2-second SIGKILL-bounded
children. Store failures refuse the invocation; call-log failures remain best-effort. Other operations
retain their existing CLI stores. Relative runner script paths are resolved against the runner PID's
cwd before identity checking and deriving the checkout; cwd itself is not the checkout.


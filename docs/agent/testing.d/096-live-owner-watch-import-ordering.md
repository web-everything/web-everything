## Live-owner watch import ordering

`createLiveOwnerWatchIo` loads dispatch and overlay module roots sequentially. These roots share
circular dependencies: starting them together with `Promise.all` deadlocks vite-node evaluation
before adapter construction. Keep the portable IO cases in `pr-live-owner-watch.test.mjs` at the
default timeout; injected dispatchers and lock identity probes keep their exercised IO local.
Load the real manual dispatcher and review job sequentially in the portable IO suite's bounded
`beforeAll` hook. The adapter tests share that production graph, including the job-side head
refusal cases; cold transforms must finish before the first adapter's five-second test budget
starts. Keep assertion timeouts unchanged and do not replace the real job dispatcher with a stub.
The fixture statically imports the real review-job module during collection and supplies it through
`loadReviewJob`. Keep that cyclic graph out of per-test dynamic loading; the head-change cases reuse
the same module and still exercise the production dispatchers with a fake job spawner.
Collect the review-job, manual-pass and reconcile-pass graph with static fixture imports so the
first review adapter case does not spend its five-second deadline on cold Vite transforms.
Retain the production lazy imports and the real dispatcher head-change refusal assertions.

Stalled living owners escalate to a rate-limited NEEDS-YOU event; activity age never proves death
or permits claim takeover. The portable IO regressions exercise production evidence, planning,
and admission for fix/build/review owners, retaining the live/unknown admission hold and checking
that fresh owners and unknown evidence cannot trigger takeover. The feed-tail regression uses
more than 2 MiB and spies on the actual read to pin offset, requested length, returned bytes, and
exclusion of the partial leading record.

Live-owner review recovery must use `runReconcilePass` admission with the complete comment
thread before the manual single-PR launcher. Re-arm comments, rather than the displayed round
label, carry the durable attempt budget. The manual launcher drops `expectedHead` on the review
path, so the watch IO hands it a loader that pins `expectedHead` and the resolved dispatch mode
on `dispatchReviewByMode`; the red-team path forwards it to `dispatchReviewJob` already. Session
mode has no job-side head pin, so review recovery refuses in that mode. The
`job refuses a head changed after the manual precheck` cases drive the real manual launcher and
job dispatcher with a job-side head that moved after the precheck, and assert no launch. Unknown
build-claim metadata blocks ownership classification; lease expiry alone never proves that its
owner is gone.

The decision log and smell state stay inside the 2 MiB read cap: the log is read as a byte tail
that must reach back past the one-hour dedup window (else it fails closed), and smell-state keys
older than the longest notify window are pruned on write. The hook-gap log is unpruned and written
by other sessions, so the self-audit tail-reads its newest records (byte and record caps) and says
so in its summary, rather than holding every pass once the log outgrows the read cap. The health
probe forwards only the tick budget to the bounded child, less a fixed start-up margin, and skips a
tick too short to leave one. That keeps the budget checks inside the kill timeout. It does not
bound the work after an intent record: with acting enabled, an action admitted near the end of
the budget can still be killed between `intent` and `did`, leaving a one-hour dedup hold with no
`action-failed` notice. This is a disclosed residual while acting is off by default; reserving
execute time before the intent write is owed before acting is enabled. Mode, `actEnabled` and
thresholds resolve in the child's own cascade, so health defaults never override a
settings-file or platform opt-in. The opt-in regression drives the real probe and child launch
and reads back the env the child received.

Live-owner watch ships report-only (R876): `actEnabled` defaults false regardless of mode.
The policy cascade logs its value and source; an explicit settings boolean true or
`WE_LIVE_OWNER_WATCH_ACT=1` opts in, and invalid policy closes acting. The pass keeps
would-do records and emits head-bound `no-live-owner` feed events (60-minute dedup),
system smells, and the self-audit line. The IO execution choke point refuses all mutations
before constructing action adapters, including red-team claim abandonment. Acting fixtures
must opt in explicitly; disabled-path tests cover each action kind even in mode on.

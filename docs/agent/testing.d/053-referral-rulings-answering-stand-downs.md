## Referral rulings answering stand-downs

The ruling pass relays a later trusted operator referral ruling through the existing operator-answer
builder only when the current head has no pending, blocked or disputed findings and later operator rulings
cover every explicit `{runId, key}` subject in the stand-down's final trailer. The stand-down CLI accepts
`--finding-refs='[{"runId":"review run","key":"finding key"}]'` for a referral question; legacy markers and
non-finding questions require an explicit operator answer. The builder encodes these subjects as base64url
JSON, so quoted/free-text trailers cannot inject them. Multiple unresolved stand-downs also require an
explicit answer: the shared answer ceremony supersedes older questions as well as the named question.
Replay with real referral, ruling and stand-down
builders; verify comment-before-label order, retry after either write fails, fresh same-head findings,
head movement during the answer post, and auto-policy exclusion. The fixer brief's referral escalation
command must pass `--finding-refs`; check that producer/consumer contract directly. Legacy holds,
including the original #5246 marker, still require an explicit operator answer; do not infer subjects
from free text. Failed label writes recover only with a complete paged label-event history that
strictly predates the relay answer (equal-second timestamps are ambiguous). Re-read the head and
revalidate comments and label history after posting the answer and before editing labels. Keep
resolution rows under `rulingStandDown`, outside the fix dispatch count. NEEDS YOU lists outstanding
findings before the first ruling.
The queue routes needs-judgment questions to NEEDS YOU
by default; select `WE_REVIEW_STAND_DOWN_QUEUE_SECTION=stood-down` for legacy-layout fixtures.

### PR movement health job (card 335)

`health-pr-sweep` runs the deterministic PR sweep separately from health gh probes. The health tick only
queues, reattaches and consumes; the child writes `pr-sweep.json` beside health `state.json` and appends
one ET line to the handoff home's `pr-sweep.log`. The sweep never writes health `episodes` or `daemons`.
Its worker keeps synchronous session/log reads off the durable job's heartbeat loop. Reuse the health
job's detached prewarm and trash eviction paths: cold snapshots and npm installs must not block a tick.
The reused reconcile agent-reader graph needs npm dependencies (`js-yaml`, `markdown-it`).

Settings resolve through `cascadePolicy('prSweep')`: standard/platform defaults, `scripts/settings/pr-sweep.json`,
the health `config.json` `prSweep` block, then `WE_PR_SWEEP_*` env values (for example
`WE_PR_SWEEP_IDLE_MINUTES`, `WE_PR_SWEEP_DISPATCH_DIAGNOSIS`, and comma-separated `WE_PR_SWEEP_REPOS`).
Sources are logged and carried into the child report. Diagnosis defaults off and delegates exclusively to
`stuck-pr-watch.mjs sweep`; alerts use the existing checked desktop/quiet-hours gate.

A session owns a PR only while it is actively running: every listed `state`/`status` value is
`working`, `running` or `busy`, its pid probes alive, and its transcript (or its start) is newer than
`sessionActiveWithinMinutes` (default 30). Finished fixers are listed `idle`, `offline`, `blocked` or
`waiting`, so those and any unknown state never own a PR. A PR is `unknown` when a session named for it
is running and alive but its transcript cannot be read (a review job has none; this lasts at most
`stuckAfterMinutes` after the session starts), or when the agent listing could not read that session's
record. An `unknown` PR is never owned: its episode clock keeps running and it alerts after twice
`stuckAlertMinutes`, so a brief unreadable tick never alerts and a permanent one still does. Item
sessions (`conveyor-N`, `prepare-N`) and unnamed rows never make a PR `unknown`.

A failed owner read pauses stuck-alert episode updates, and so does a listing gap that names no session,
since a missing session is unknown, not gone. An incomplete operator queue also pauses them,
since operator-owned PRs cannot safely be distinguished, and preserves the previous NEEDS YOU set.
A complete first queue sample records the set without alerting. A PR move or head change resets its
unowned episode; a recovered owner clears it. Failed notification delivery leaves the episode/set due
for retry. Dry runs and fixture health ticks never dispatch the sweep against the host.

Sessions marked `hung`, `idleFinished`, `authExpired` or `selfReportedDone`, and sessions whose pid is dead
or unprobed, cannot refresh sweep ownership. Recent daemon evidence still counts. Replay the PR #5323 findings
with the `pr-sweep-unhealthy-owner-and-symlink-entry` soak break: successive dry sweeps must alert once
after the delay (including for idle, offline, blocked and waiting fixers), and the three CLI entry points
(`pr-sweep-job.mjs`, `pr-sweep.mjs`, `health-watch.mjs`) must execute when reached through a symlink.

Dispatch refusals from health memory or daemon logs are diagnostic signals, never ownership or progress
(including review-daemon's `not dispatched`, `no review dispatched` and failed-dispatch formats).
Log ownership requires a recognized work event (start, dispatch, applied action, or completed movement);
rankings, repeated notes, dry runs and unknown diagnostic wording cannot renew ownership.
The same soak break refreshes refusals on every sweep through 24 hours and requires exactly one stalled
alert. Qualified daemon references (`repo#number`, `repo PR #number`, and GitHub PR URLs) override the
clone's default repository; replay colliding PR numbers to catch cross-repository ownership attribution.

Use the `pr-sweep*.test.mjs` files in `scripts/conveyor/__tests__/` through the heavy-admission queue.
Inject every owner/queue/PR reader and every send/dispatch sink; the IO collector exposes separate
agent, health-state, clone-root, log-listing and bounded-tail seams. Never let a missing test seam fall
through to the host's live agents or daemon clones.

### Fix verification infrastructure retries

An await-verify `infra` verdict for a fix stays in the harness: it persists a same-head
retry before requesting verification, with `verify.infraRetry.maxAttempts` (3) and
`verify.infraRetry.backoffMinutes` (15) resolved through the policy cascade and logged
with their sources. No model wakes during backoff or an infrastructure retry. Green
uses the existing evidence/hand-back resume; a real red resumes the repair loop.
Exhaustion is logged once and retains the infrastructure wait for operator recovery;
it never creates a new fixer. Probe restart persistence, write failure, head movement,
and both terminal verdicts with the pass's injected ports.

Timeout-only fix reds under high host load wait for a quiet host before a same-head
reverify. `verify.loadRetry.maxAttempts` defaults to 3 through the policy cascade;
`WE_VERIFY_LOAD_RETRY_MAX_ATTEMPTS` supplies the environment override. Its counter
is persisted before requesting and does not consume ordinary retries. If that request
fails (or never runs), the old red is not a new verdict: the harness re-requests it under
the ordinary retry and infra-retry bounds and never escalates it.
While a load retry exists on the record, its sha is known red: a running or overdue
retry is never pushed early or handed back as a no-op. A deferral refreshes the
record's `requestedAt`, so the session reaper keeps the fixer exempt until the
deferral's own two-hour cap; after that the red ladder resumes it.
Missing per-test timeout evidence, assertions, truncated inventories, low load on first
observation, and exhaustion retain the normal red/escalation path. Inject `loadHigh`
to probe both transitions, write failure, and the unchanged no-push kinds.

`verify.gateCeiling` defaults to `load-scaled`, using rebuild smoke's bounded load/core
factor; `fixed` restores 30 minutes. `VERIFY_DISPATCH_TIMEOUT_MS` is an absolute override.
The gate job records the same resolved budget its supervisor used; admission waits
still consume only the separate queue ceiling. Reconcile probes bound PIDs each pass
and must discard a previous `pidAlive` value if the new probe is unknown.

### Operator repair round replay

Replay round-extension grants after an already over-cap thread, then a completed repair and the
review of its new head. Fix admission uses `< cap`; the owed review uses `<= cap`.
`fix.roundExtensionAnchor` defaults to `grant` (env `WE_FIX_ROUND_EXTENSION_ANCHOR`); `off`
retains additive caps. Each cap anchors to its own counter on the thread prefix before the grant;
never use the current durable count map as historical evidence. Open send-back allowances use
trusted fix-end comments after the latest open operator ceremony and `fix.operatorRulingExtraRounds`.
Set that allowance to zero in tests isolating the older `operatorFixBudget` mechanism.
An open send-back allowance must preserve the takeover gate predicate: a reviewed head with zero
open defects and an own-gate hold still goes through cap handling for its advisory or operator note.
Replay human, awaiting-base, stacked-base, review-gate and merge-gate holds alongside the allowance.

### Stand-down head lifetime

Terminal stand-downs hold on their recorded head. Reconcile and operator/health listings use the shared
`stand-down.mjs` head reader; legacy unbound comments lapse with later current-head commit evidence, never
from PR `updatedAt` (comments also update it). `fix.standDownHoldsAcrossHeads` defaults to false through
the standard → platform → tool → env cascade and logs its source. Replay both raw planner inputs and
queue listings; include same-head holds, abbreviated legacy Head markers and missing/older timestamps.


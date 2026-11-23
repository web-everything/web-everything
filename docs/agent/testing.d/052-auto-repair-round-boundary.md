## Auto-repair round boundary

Reconcile permits the final review at the effective round cap; another fixer is refused at that cap.
Only generic fix exhaustion parks to `review:human`, independently of note-comment dedup.
`WE_REVIEW_ROUND_CAP` sets the positive integer base cap (default 5).
An operator can grant 1–5 extra rounds with
`node scripts/operations/run.mjs extend-rounds --pr=123 --repo=web-everything/web-everything --by=2 --actor=chalbert --channel=console --reason="Try two more rounds" --preview`.
Omit `--preview` to post the audited grant and verify its trusted count in the PR thread.
The grant must be posted under the operator's own GitHub credential: the operation refuses to post under any other
login, and a grant counts only when the comment's GitHub author is an operator and names a registered operator actor
(an automation-authored comment never counts, whatever its body says). Repo keys and slugs are equivalent.
Grants on one PR together add at most 10 rounds; a further grant is refused and the count is clamped.

### Card batch publication recovery

Batch publication shares admission's token lock. A seal journals each completed step and retains the
actual green `.lane-verify` receipt for the pinned head across lane release/reacquisition. A finished
or failed seal is archived before the active slot is replaced with its sequence seed; admission's
existing successor rule then allocates `seq + 1`. Keep real bare-origin coverage alongside transport
fakes: the former proves ref checks and rollover, while the latter pins park → hold-label ordering,
red verification, and each durable crash boundary. Health ticks only launch detached seal workers.

### Grouped build recovery

Grouped members have no worker run row of their own. Restart adoption must use the lead's
PID, session liveness or bound resume marker, using the single-card liveness classifier.
Only the lead resumes or settles that worker; the daemon's grouped retirement path owns
member cleanup. Probe real member claim files with a dead daemon PID and a live lead,
including session and resumed-worker evidence. Recovery carries the durable dispatch's
full member list through resumability, resume argv and wrapper publication; a missing
original dispatch record refuses publication. Member claim edits are wrapper-owned,
while unrelated card edits still refuse recovery. Test generated mixed numeric/hash
`Resolves` lines through the real resolution reader, retaining diff corroboration and
bornAs alias checks for hashes.

### Enqueue catch-up ordering

Catch-up children share `--listing-snapshot` within one round; the target is always re-read live. Replay
fresh, expired, foreign and malformed round files, and candidates missing labels or base `main`.
Queue eviction must use fresh, unfiltered rows even when candidates come from that round file.
The CLI regressions in `scripts/__tests__/merge-ai-prs.test.mjs` cover newly held manually queued PRs
with no follow-up record, omitted snapshot rows, reconciliation off, and failed eviction reads.


The enqueue catch-up regression must exercise spawned fast drains, not only the planner:
`duePending` can otherwise undo the selected priority order. Queue fill depth comes from
`mergeQueue.enqueueOnEvent.catchUp.maxQueued`, independently of `mergeDelivery.batchSize`.
First acceptance is the earliest structured accepted/clear-human comment across heads;
include a removal/restore replay, comment pagination, and the ready-time fallback.
Include an older PR with running checks ahead of a green PR at capacity one, and a window
that closes during the first wake read then reopens on a later interval. Skipped wakes must
allow later candidates to run; retained catch-up work reserves room in the next plan.
Confirmed drain gate skips and revalidation aborts also release room; successful enqueues
and ambiguous failures consume it. Give each fake child its actual target PR number.
Also cover a queue that fills while the window is closed and an unreadable next snapshot:
retained attempts must stay within the latest room, and cannot use a failed snapshot.

Catch-up concurrency tests use manually completed child processes to prove the cap while siblings
remain active, including concurrency 1. Re-read live queue depth/capacity before each start and
reserve room for active siblings; retain the round attempt budget for ambiguous outcomes.
Snapshot-first catch-up fixtures must model whether the fast-drain snapshot reader accepts the round file:
legacy concurrency contracts inject an already-published snapshot; writer tests hold it absent, publish during an active child,
and cover invalid/unreadable files and throwing checks keeping starts serial, plus failed/timed-out writers
releasing the next attempt. A published fixture must pass the real reader; released children must reuse it.
Clean-first applies within the same priority class and known-hold/recent-miss demotion group; test a BLOCKED P0 incident fix against an ordinary CLEAN PR at capacity one and retain every non-clean candidate.
Snapshot readiness and released-child reuse must require `defaultBranch`, as production does; a round file missing it keeps catch-up serial.
A batching deferral stops new starts but lets existing children finish their locked admission checks.
Probe busy scheduling from round completion with room and an unqueued runnable PR, and full-interval
scheduling with a full queue or backed-off work. Never start a second drain for an active PR; a
wake that arrives during its run stays pending until the run ends, unless that run verified the enqueue;
shutdown must kill every child and prevent further starts. Inject all GitHub reads in these tests.




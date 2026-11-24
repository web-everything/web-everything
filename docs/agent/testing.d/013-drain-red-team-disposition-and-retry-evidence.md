## Drain red-team disposition and retry evidence

Stale abandonment publishes a complete marker before replacing the writer, under the shared status
claim. Its intent binds the old writer digest, evidence digest, timestamp and the exact JSON bytes
of the abandoned writer. Recovery may finish that intent only while those inputs still match;
admission still requires the completed writer binding. Keep the atomic JSON rendering and digest
in agreement. The persistence-boundary matrix in `review-recovery-witness.test.mjs` interrupts
before/after each rename for queued/running owners and fresh/resume modes, then attempts admission
twice. The dead-owner soak also interrupts after marker publication and requires one dispatch.
Keep a named mutation row for each intent binding: old writer, evidence, expected writer and
abandonment timestamp. Change the timestamp alone to exercise its digest binding; for a non-string
timestamp, recompute the expected writer digest so the type guard is tested independently.
The same suite exercises production carry-conflict selection and isolates each admission codec
field and rollback identity check. Exact-head panel evidence takes precedence over a carry journal.

The status writer may repair truncated JSON, null JSON or a mismatched identity only when no retry
marker exists; readers still reject that evidence. The writer-contract table in
`drain-red-team-evidence.test.mjs` covers queued, running, finished, fresh-retry and refund writes,
with and without a marker. Marked damage requires operator inspection; filesystem errors and invalid
retry counts remain errors. Keep the negative refund table that varies queued state, explicit refund
inputs, PID, process start time, host and namespace independently: a refused refund must preserve both
the marker and spent count, and a later admission must still refuse. Existing review-job tests cover
cap, guard and disabled deferrals through the production writer with zero model calls before refund.
Run publication failures through both carry and clear: comment-post and label-sync failures become
skip rows without spending dispatch capacity. A successful post followed by failed label sync remains
visible to the next tick, which deduplicates the comment and leaves label repair to the label sweep.

Moved card-only skips recover through the normal red-team-only review job. The planner requires a
finished policy skip with a pinned card-only read and no seat, then proves the move with
`card-only-head-move.mjs` (shared numbering proof, otherwise a complete no-renames card-path diff).
The job repeats that proof before settling the policy comment on the new head; it never sends
the historical diff to a model or changes the original panel review. Unknown moves stay skipped.
Both initial recovery and failed-comment retries resolve the live `redTeam.skipCardOnly` cascade
after the proof/fetch; a disabled policy or missing/throwing policy hook refuses with
`red-team-not-owed` before admission or settlement. Cover card-only and numbering-only moves, retries, and old accepting
as well as non-accepting verdicts, including a policy change after IO construction.
Carried settlement payloads retain `carriedFrom` (the original reviewed head) and clear `verdict`;
their live `netBasis.rev` identifies settlement, not a panel read. The drain reader also strips
any verdict on a marked carry before exposing it to scheduling consumers. Persisted comment-failure
tests must prove that the payload cannot authorize a post-accept model pass and remains retryable.
Carry publication uses a separate `(repo, pr, head, kind)` journal in `red-team-status/carry`:
intent → clear label → result comment → done. The shared file lock serializes resumes; the
journal is not a panel verdict or a queued model job. Each unfinished step checks live policy,
head, holds and superseding review evidence, then its own observable postcondition before acting.
Crash tests must cover each boundary, including a successful remote effect whose reply/journal
write is lost. Exercise both accepting and non-accepting source verdicts through the persisted
evidence reader, recovery planner and job. For lost status-write, label and comment replies, assert
one status write, one label change, one comment and no model call after retry, with a null carried verdict.
Recovery discovery must include an unfinished journal even when the result comment
is already visible. A later real panel or changed head refuses recovery; it cannot inherit the
carry's null verdict. A contended lock or unreadable evidence leaves the journal for the next
recovery tick and reports an inspect/retry diagnostic; it never authorizes a model call.
The moved-card cases in `review-red-team-on-skip.test.mjs`, `drain-red-team-evidence.test.mjs`
and `review-job-red-team-only.test.mjs` pin selection, fail-closed proof and real comment settlement.
Keep these files in the affected-test gate whenever the moved-card readers, proof or job wiring change:
`npm run test:unit -- scripts/lib/__tests__/review-red-team-on-skip.test.mjs scripts/lib/__tests__/drain-red-team-evidence.test.mjs scripts/operations/__tests__/review-job-red-team-only.test.mjs`.
Exercise new factory IO members through `createReviewJobIo` with temporary persisted evidence and an
injected command reader; cover runner defaults as well as injected proofs. History cases must include
20 and 21 commits, a root, an intermediate code change, and a code-to-card rename whose source becomes
visible only with `--no-renames`. Historical evidence filters need a refusal case for each condition,
with distinct old and live heads. Byte fixtures exercise the complete numbering detector without Git writes.
Maintain a table with one independently falsified row per candidate-predicate conjunct, alongside
planner/job integration tests. The moved candidate table must isolate status/read head equality;
the historical fallback table must isolate `inFlight` from finished status (the reader currently
derives them together). Give the status its own read so a mismatch does not also invalidate the
status's internal provenance. Document logically implied clauses (real-head validity also follows
from matching a valid status head); otherwise require a named row that fails if the conjunct is
removed. Keep these tables in the affected-test gate above.

Accept carry-forward's advisory exemption must use `readConfirmedBreaks` and `planRedTeamActions`,
including settings and `WE_RED_TEAM_CONFIRMED_BREAKS` overrides. A send-back finding or an
unresolved policy supersedes the stale accept; the fallback is a fresh review. Regression cases
in `accept-carry-forward.replay.test.mjs` cover `degraded=send-back`, cosmetic classification,
non-blocking overrides, and throwing, missing, incomplete or unknown policy resolution.

Gate exemption tests must isolate each predicate with an otherwise valid envelope. The replay
cases **rejects complete gate envelopes with forbidden outcomes** retain a successful card action;
**rejects card-queued without a successful card line** covers absent, advisory-only, failed and
malformed card actions. A successful card beside a failed or unrecognized action must also refuse
carry, independently defending validation of every action line.

The drain owes a live-head red team only after a speculative or sequential pass is scheduled
(recorded queued/running status or seat evidence). The review job records the pass as queued as
soon as the loop returns an owed accept, before the added seats. Before that status exists, the
persisted accepting review run for the live head holds (the loop labels the accept first), while
the red team is enabled; the job's later status supersedes it, but a finished status older than
that run (an earlier review of the same head) does not. Labels alone never schedule one.
Card-only net diffs (including rename/copy sources) never owe a pass. A queued or running status
is live only while its writer's pid is. A crashed scheduled pass, or an accepting run no job
picked up, retains the 45-minute never-scheduled recovery path; live passes and recorded breaks
cannot use it.

Already-reviewed heads with an owed result can use the existing review job's `--red-team-only`
mode (`--red-team-only=resume|fresh`; the bare flag retains fresh guards). A completed scorecard seat (`completedRecorded === true`) plus a finished status whose `result` string or `result.status` is `ran` or `resumed`
resumes its missing comment/effects without another model call; a failed recovery persists `resumed` and remains eligible after cooldown, subject to the same clean-row guards.
Daemon and soak fixtures that expect legacy completion strings to resume must carry that seat evidence explicitly; with `recorded === true`, missing or incomplete completed-seat evidence refuses dispatch.
Only a head with neither status nor row starts fresh. A trusted result comment, live pass,
non-accept, unreadable evidence, recorded row without a status, or any prior result other than `ran` or `resumed`
prevents dispatch, except a finished `skipped` status with `skipCardOnly === true` and a
stored card-only net read with non-empty trimmed `diffText` and `netBasis.rev` matching the status head: that historical gap dispatches fresh to settle the skip. A structured result with an absent policy or any policy other than `card-only` never heals; legacy string `skipped` remains eligible.
The dispatcher carries the selected mode into the job. At job time, resume requires a clean row selected by `priorRedTeamRow` from a strict scorecard-store read, plus a finished `ran` or `resumed` status without a posted comment. Fresh mode re-reads and refuses any status or red-team seat row for that head; admission treats the validated historical card-only skip as fresh while retaining the seat-row and comment guards. Unreadable scorecards refuse with `red-team-not-owed`; inspect the stored evidence before retrying.

Settlement runs for skipped, error, disabled and unknown outcomes before the finished status write and gate in both normal and red-team-only jobs. Budget/guard deferrals (including `deferredByCap` and `deferredByGuard`) also reach non-policy settlement. An accepted head already owes a pass: even plain `not-owed` settles as non-policy needs-you with reason `red team reported not-owed on an accepted head`. Only completed (`ran`/`resumed`) outcomes with a `posted` or `deduped` result comment bypass settlement. Completion also requires no truthy guard/cap deferral flag, successful summary/diagnostic derivations, and a complete live comment read with a trusted result for exactly the settlement head. The production visibility hook shares settlement's `readCompletePrComments` reader and uses `redTeamForHead`; missing readers, unreadable/incomplete threads, other heads and untrusted authors fail closed to needs-you, without posting or clearing. Completed outcomes that fail these checks settle as `unpublished`; those with any other or missing comment status settle as `unpublished`, with reason `red team <status> but its result comment is <comment status or unknown>` through the same sanitized, bounded needs-you path; they never post a result comment or clear.
The persisted `skipCardOnly` boolean records the writer's resolved setting; consumers must still classify the stored net read, so a `.mjs` code diff remains owed. Settlement exception diagnostics cannot abort the finished status write or gate even if the logger throws.
Contain summary construction, seat diagnostics and unpublished-comment reason coercion too: malformed
findings or an unstringifiable comment status must still reach settlement and preserve the finished
status write and gate. Runner exceptions and policy-comment post failures use the shared
`safeErrorText` catch boundary (including message access and string coercion), falling back to
`unprintable error`; post failures still persist pending needs-you before publication and retry.
Guard deferrals clear queued admission for retry instead of writing finished status. A `ran` or
`resumed` result carrying a cap deferral suppresses the gate; a `skipped` cap attempt rolls back
admission and still runs the gate over existing findings. Completion-evidence and red-team-only
tests assert those lifecycle differences.
Gate suppression retains the completed status and runner's cap flag before reading comment
diagnostics, so a throwing comment-status accessor cannot admit a cap-deferred completion in either job mode.
The fallback summary also retains guard deferrals before diagnostics, preserving admission rollback.
Coerce diagnostic values with `String()` inside a catch boundary, using `unknown`
for an unreadable comment status; retain the original completed status when summary rows fail.
Only structured `status: 'skipped', policy: 'card-only'` without any truthy `deferredByGuard`
or `deferredByCap` flag, with a real 40-hex `readHead`
(the loop read's `netBasis.rev`) matching the settlement head case-insensitively produces a trusted,
head-bound zero-finding result comment. An absent, invalid or mismatched read head publishes
needs-you with reason `policy skip head not bound to the reviewed read`. Reason strings never grant clearance. Other skips and failed policy comment posts
publish needs-you with kind `red-team-skip-<first 26 hex of the SHA-256 identity key>`, so distinct reasons survive feed deduplication. Embedded reasons are sanitized with `sanitizeForFeed` and capped at 80 characters before constructing both the item and deterministic identity key. Markers deduplicate by repo/PR/head/sanitized bounded reason under `red-team-status/skip-published`;
Write the item atomically to `red-team-status/skip-pending/<key>.json` before publication, then write the published marker and remove the pending record after success. Before retry publication, re-sanitize and bound the embedded reason (80 characters) and title (200 characters), and require the filename and kind to match the content-addressed identity of the sanitized fields. Invalid records, including unreadable per-record metadata, move to `.json.bad` (or are removed if quarantine fails) with a quarantine diagnostic; an operator must inspect and repair or reissue them. Every settlement first retries up to 25 unpublished pending records without a model call, even when settling another PR. Failures retain their records and do not abort the current settlement; overflow is logged and remains for the next settlement. Already-published pending records are removed without republication. Settlement uses the stored review head, then the prepared lane head; the job refuses an invalid prepared lane head before running the arc. If no real head is available, publish with `head: 'unknown'` and include the run ID in the identity key (a fresh attempt ID if absent); the attempt ID is persisted as `attemptId` so retries can verify the key. Unknown-head pending records without that identity are quarantined. Fallback heads identify needs-you items but cannot authorize policy clearance.
Regressions: `red-team-skip-outcome.test.mjs`, `red-team-skip-outcome-regressions.test.mjs`, `review-job-red-team-skip.test.mjs`, `review-red-team-on-skip.test.mjs`, `review-red-team-resume-only.test.mjs`.
Regression mapping (one representative assertion per guarantee; names are in the files above unless noted):

- Sanitized bounded identity and publication: **sanitizes and bounds %s reasons before publication and deterministic deduplication**.
- Lane validation precedes the arc: **invalid prepared lane head stops the job before settlement (%s)**.
- Missing read revision needs no live read: **missing read revision uses the valid lane head without reading live carry evidence**.
- Settlement exceptions preserve the arc: **throwing settlement still writes finished status and runs gate (redTeamOnly=%s)**.
- Retry display bounds: **pending retry re-sanitizes and bounds reason and title before publication**.
- Retry content identity fails closed: **pending record with a valid-shaped kind but mismatched content key is quarantined**.
- Unknown-head retries preserve identity: **unknown-head pending records retain their attempt identity across retries**.
- Legacy unknown-head retries fail closed: **legacy unknown-head pending records without attempt identity are quarantined**.
- Production comment and feed effects: **production settlement posts marker via gh argv/body and publishes real needs-you**.
- Budget/guard deferrals escalate once per head/reason without posting a result: **unfinished publication or deferral publishes needs-you once without a result comment: %j**.
- A plain `not-owed` on an accepted code head is contradictory evidence and escalates in both job modes: **not-owed on an accepted head publishes needs-you (redTeamOnly=%s)** in `review-job-red-team-skip.test.mjs`.
- A terminal `not-owed` cannot grant policy clearance even with a card-only policy or a misleading reason, and repeated settlement notifies once: **contradictory not-owed never clears and notifies once: %j** in `red-team-skip-outcome.test.mjs`.
- Finished but unpublished results escalate once without posting or clearing: **unfinished publication or deferral publishes needs-you once without a result comment: %j**.
- Writer setting never classifies a code PR as card-only: **never exempts a code read from speculation, recovery guards or an owed pending label**.
- A throwing settlement logger preserves finished status and gate: **throwing settlement and logger still write finished status and run the gate**.
- Unreadable record metadata cannot block pending retries: **unreadable pending metadata is quarantined without blocking a valid pending record**.
- Healing retains fresh guards: **healed card-only fresh admission still refuses a prior %s**.
- Structured policy provenance: **policy predicate requires both structured fields: %s cannot clear**.
- Read/head binding fails closed: **policy cannot clear an unbound reviewed read (%s)**.
- Case-insensitive read/head binding: **policy read head binding is case-insensitive**.
- Missing read revision cannot clear a lane head: **policy skip without a valid netBasis.rev cannot clear the lane head (%s)**.
- Publication precedes deduplication: **failed publication leaves no marker; retry succeeds before deduplication begins**.
- Identity includes repo, PR, head and reason: **successful publication deduplicates by repo/PR/head/reason: changing %s publishes again**.
- Feed kinds preserve distinct reasons: **distinct reasons on one head survive real feed deduplication**.
- Kind collision regression: **colliding 32-bit reason prefixes produce two real feed lines with 40-character kinds**.
- Unknown heads retain run identity: **unknown heads deduplicate within a run but retain different attempts**.
- Absent run IDs retain attempt identity: **unknown-head skips without runId both publish with fresh attempt identities**.
- Unknown heads cannot clear policy: **policy cannot clear without a real head (%s)**.
- Incomplete outcomes reach settlement: **production dispatch settles every incomplete outcome %j**.
- Unverified, deferred or malformed completions notify without clearing: **completed result with %s notifies without posting or clearing**.
- Production completion evidence uses the complete trusted head-bound thread: **production visibility reader requires a complete trusted result on the settlement head**.
- Visible completed results bypass settlement: **completed %s with a visible result does not settle**.
- Fallback head identity survives feed deduplication: **two real lane heads without netBasis.rev publish twice**.
- Read head takes precedence: **stored review head takes precedence over the prepared lane head**.
- Prepared lane head fallback: **a missing pinned rev falls back to the prepared lane head, never a null identity**.
- Historical recovery rejects incomplete reads: **does not heal incomplete or mismatched stored read %j** in `review-red-team-on-skip.test.mjs`.
- Historical recovery requires provenance: **policy-absent object %j never heals even with a complete card-only read** in `review-red-team-on-skip.test.mjs`.
- Durable cross-PR retry: **failed publication persists the item before publishing and another PR retries it exactly once**.
- Retry failure retains pending evidence: **pending retry failure does not block current policy settlement or discard the item**.
- Parse failures quarantine pending evidence: **unparseable pending evidence is quarantined and cannot prevent current settlement**.
- Retry bound and overflow fallback: **flushes at most 25 pending records and leaves overflow for the next settlement**.
- Crash cleanup avoids duplicates: **already-published pending records are removed without republication**.
- Contradictory policy/deferral evidence fails closed and deduplicates escalation: **policy with contradictory %s=%j fails closed and notifies once**.
- Malformed completed results retain settlement, finished status and gate: **malformed result settles once without a comment and preserves finished status and gate: %j**.
- Malformed diagnostics cannot abort settlement: **malformed reason cannot prevent settlement or throw (redTeamOnly=%s)**.
- Finished status preserves provenance: **persists skip provenance and keeps other outcomes as strings: %j**.
- Persisted recovery honors policy: **real persisted skip survives drain reads and recovery admission (policy=%s)**.
- Poison records cannot consume retry slots: **30 invalid records do not consume the attempt budget; one valid record publishes and poison is never rescanned**.
- Failed attempts count toward the bound and rotate fairly: **failed valid publications count toward 25 attempts and rotate oldest-first across settlements (mtime=%s)**.

Recovery admission carries the `readRedTeamRecoveryStatus` normalization of a confirmed-dead queued
`ran`/`resumed` prior into the shared guard before writing its own queued status. A confirmed-dead
queued writer without a resumable prior becomes a finished null-result placeholder, so the planner
can dispatch fresh only when seat evidence establishes that no pass ran and the evidence reader
retains the original queued status. An ordinary finished null result has unknown run provenance
and never authorizes fresh dispatch. The shared placeholder predicate requires explicit original
queued provenance for null results; admission supplies its pre-write record only after recovery
normalization. The execution guard supplies no such provenance, so direct fresh calls and queued
handoffs carrying an ordinary finished/null prior both refuse before provider selection.
Regression prevention in `review-job-red-team-skip.test.mjs`:
**fresh guard refuses a finished null prior without queued provenance (admitted=%s)** and
**fresh admission preserves unknown null completion but recovers a dead queued writer (prior=%s)**.
The back-port from `8173660fcf` also pins the guard in `review-red-team-resume-only.test.mjs`:
**refuses a finished null result without queued provenance and with no seat or comment (admitted=%s)**.
Its production admission regression in `review-job-red-team-only.test.mjs` is
**fresh recovery preserves unknown finished-null history through production admission and launches no call**;
it verifies that refusal restores the original finished/null status and publishes no comment.
These exercise the shared execution guard and production admission, alongside the planner's
**f: a null completion without queued provenance skips (stored status %s)** in
`review-red-team-on-skip.test.mjs`. Live or unknown liveness
and invalid writer PIDs keep the queued record blocked. Regressions in `review-job-red-team-skip.test.mjs`:
**accepted code head dispatches fresh after queued fresh recovery crashes before running with no seat or result comment**,
**queued fresh recovery still skips with %s**, and
**dead queued fresh recovery cannot dispatch over an existing seat row**. A guard
refusal that launches no call rolls back admission (removes queued status when no prior exists, or restores the
prior status/result); only a trusted result already on the head is terminal. Regression:
**a transient comments-unreadable guard refusal leaves status absent and fresh recovery eligible**
and **a confirmed-dead queued/ran prior admits and reaches the shared resume path without a model call**.
Recovery shares the tick's lane/live-review capacity and host admission (including recovery-only ticks).
`reviewConcurrency.maxLiveReviewRounds` accepts 1..16 (configured default 8); the host per-tick
start burst remains independently bounded at 1..8. The review daemon's production lane scan budgets
two acquirable lanes per ordinary round. Red-team-only recovery starts need one lane each and use
the unhalved free lane count, less starts already accounted for in the tick (minimum zero); a failed
recovery lane read gives recovery zero lanes and never aborts ordinary dispatch.
Excess owed ordinary reviews, including a pool with only one lane left, stay
queued with the existing lane deferral / `poolExhaustion` reason. The focused live-cap-16 pool-fit
cases in `review-daemon.test.mjs` cover empty, single-lane, even and odd pools without dispatch failures.
Ordinary and recovery starts share the remaining host per-tick allowance; confirmed starts and
unknown outcomes consume the cross-repo host budget, while confirmed non-starts do not.
Recovery defaults to a 30-minute retry cooldown through
`reviewRedTeamOnSkip` (tool: `scripts/settings/review-red-team-on-skip.json`; environment:
`WE_REVIEW_RED_TEAM_ON_SKIP`, `WE_REVIEW_RED_TEAM_ON_SKIP_RETRY_COOLDOWN_MIN`). Focused cases
live in `review-red-team-on-skip.test.mjs` and `review-job-red-team-only.test.mjs`.
An accepted head move with no trusted carry and no stored review at the live head recovers through
an ordinary full review, provided live-head status/seat evidence is explicitly absent and the shared
hold guard permits it. It shares recovery's per-head cooldown and dispatch capacity; it publishes
no policy-clear. Unknown evidence stays skipped for operator inspection. The **unprovable accepted
head move — fresh full review** replay covers the planner and effects boundary; **plain recovery
dispatch spawns an ordinary job and runs its full loop plus red team** proves accepted labels do not
require a dispatcher bypass option.
Full-review recovery requires readable formal reviews independently of acceptance comments.
It applies `laterReviewHold` without a timestamp floor; an unreadable channel or formal
hold stays skipped for operator inspection. The same replay pins both refusals with
empty comments and absent live-head evidence, and allows a readable empty review list.
Red-team-only admission strictly persists `queued` and reads back that status with the current
process's pid before releasing the job slot. A write/read failure or mismatch refuses with
`red-team-not-owed` and `queued red-team status could not be persisted`, without running the
red team; label syncing remains best effort. Regression: **refuses a throwing strict queued
hook in %s mode with zero red-team calls** covers fresh and resume admission.

For filesystem settings and plain Node child imports, resolve paths with
`join(dirname(fileURLToPath(import.meta.url)), relativePath)`; wrap child import paths in
`pathToFileURL`. Vite rewrites literal `new URL(relativePath, import.meta.url)` expressions
as browser asset URLs, which can become HTTP URLs under Vitest's DOM environment.
Node's ESM loader refuses those URLs, and a settings read can silently fall back instead.
Assert tool-layer provenance when testing a real default settings path.

Async child output is complete at `close`; `exit` can precede the final stdout/stderr
chunks. Exercise that ordering for success and failure with an injected child, alongside
real-process tests. Keep timeout and output bounds active while draining pipes retained
by descendants; reaching either bound must still reject the result.
When updating the shared spawn wrapper, check every caller's injected child fixture:
emit `close` after `exit` and the final output, and use real streams when the wrapper
can destroy retained pipes. An exit-only fixture leaves the completion promise pending.

`redTeam.statusLabels` defaults true through the same cascade as the probe controls, with
`WE_RED_TEAM_STATUS_LABELS` as the environment override; effective value and source are logged.
The existing label provider provisions the known metadata and writes the mutually exclusive
`red-team:pending`, `red-team:clear`, and `red-team:blocked` labels. They describe scheduling
and the recorded disposition on the live head, never grant clearance. The conveyor's existing
label sweep removes stale head labels and repairs missed status writes. Re-arm removes merge
readiness and stale status labels atomically; missing-only re-arm preserves readiness only
when a trusted acceptance marker still names the unchanged live head.
CI-heal missing-only recovery carries `--expect-no-readiness` into the child command. Readiness
first observed by the child, or at its final pre-write read, supersedes the parent's earlier
observation of missing routing, even when no acceptance marker accompanies it.

Queue admission and operator escalation share `red-team-gate.mjs#readRedTeamDisposition`.
Read the live head's recorded per-finding gate actions before consulting current policy:
a card/advisory record releases that finding, while sent-back and round-cap records retain
only their unresolved findings. Without a recorded per-finding action, a policy send-back
candidate still blocks enqueue and derives `red-team:blocked`, even if no run is currently
owed. A card record for another finding (or a failed card action) cannot release it.
An action binds to the result it was recorded against: only gate records after that result
count, so an earlier same-head result's card cannot release a newer result's finding. Action
lines are read only as whole `buildGateComment` lines right after the gate marker, with indices
from the action's own `(#N, …)` list; text elsewhere (a carried finding summary, a landing-job
name) is never an action. A proven identical-contribution carry keeps the actions bound to the
result it was carried from; the new head's own records win.
Legacy cap comments omit indices; exclude separately
recorded card/advisory findings before surfacing the remaining confirmed breaks. Acceptance
labels alone do not prove an operator ruled on a cap-held break; use the sanctioned
head-bound clearance ceremony, including proven identical-contribution carries.

Persist red-team backoff independently of whether the scheduler currently owes a pass.
The observed comments and live reviews wake a pending head when their evidence changes;
otherwise a recorded break waits until its retry deadline, including after the health-smell
age. Only missing-result scheduling gaps retain the maximum-age scheduling fallback.


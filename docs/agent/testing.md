# Testing — Three-Tier Strategy

## Paused review recovery

The ruling ledger omits unattempted referrals and suppresses findings after an operator verdict.
A same-head pause can therefore need a separate report source: `pausedReviewRulingNeeded`
reads `liveReferralState` with the gate's PR body, creation time and readable-card rule, then
uses review-run evidence to prove the pause. Its findings flow through the existing operator
queue and needs-you feed. Partly ruled heads list only pending findings.
The pause notifier raises a ruling-needed notice rather than minting an automatic
same-head wake. Historical `paused-review-auto-rearm` receipts do not reset the
same-head counting window. Main's live-release, explicit operator events and
bounded missing-verdict retries retain their existing eligibility. No labels change.
Focused tests cover hold/feed/daemon integration, receipt dedupe, historical auto-rearm
markers, reason-token holds and explicit operator wakes. No live GitHub writes are needed.

## Drain red-team request recovery

The review daemon reads `drain-red-team-requests` in the shared coordination root each
pass. Requests join its existing bounded review dispatch batch; planner refusals,
auth pause, lane capacity and the live CI/head gate still apply. A moved head is
retired with status `stale`. Starting a detached job does not consume the request
or spend another jury round.

The job's internal request branch loads a completed `review-pr` for that exact
repo/PR/head and feeds its pinned read to the existing `review-extra-seats` red-team
runner. It rechecks the head and review-blocking labels before and after lane
acquisition, retains kill switches, provider caps and the card-only exemption, and
finishes the request only after the existing saved-result provenance writer confirms
success. Failures remain open for retry. No operator command or operation is added.
Focused coverage: `review-job-drain-red-team.test.mjs`, `review-job.test.mjs` and
`skills-src/conveyor/__tests__/review-daemon.test.mjs`.

Shared seat policy must not import `review-pr.mjs`: label acceptance reads that
policy, while the operation loads the label/stack/merge graph. Vitest can wait
indefinitely on that circular graph before collecting any tests. Keep the shared
Antigravity env/probation policy in `review-antigravity-policy.mjs`; the operation
re-exports the existing API. `review-referral-acceptance.test.mjs` exercises the
label reader through Vitest as well as a fresh Node dispatch import.

## Red-team panel timing

`redTeam.timing` defaults to `panel-seat`; `WE_RED_TEAM_TIMING=post-accept` exercises
the rollback path. Legacy tests of accept-only scheduling must select that timing in
their IO/environment fixture. The panel reuses the speculative call's pinned read and
finishes before the job reports done for accepted, owed heads. Non-accepted reviews
cancel and discard the speculative pass in every timing mode. Panel timing never
bypasses `redTeamOwedFor` at completion; comments, status labels, delegation trials
and send-back effects retain the existing acceptance predicate.
Missing/unrun seat evidence on a reviewed head stays held in drain beyond the pending
deadline; it cannot use the never-scheduled escape or trigger a second post-accept pass.
The focused timing, review-seat and drain-seat suites cover this boundary.


## Paused prevention filing obligations

A `prevention.filingEnabled=false` result remains a failed/paused filing. Both the spawn
seam and detached filer persist the card input under the shared card-batch state's
`owed-prevention/` directory. The obligation key excludes session/transport flags and includes
source repo/PR plus the card input. Exclusive publication preserves the first record;
completed records remain as dedupe tombstones. A subsequent landing call or the periodic
card-batch reconcile tick uses the existing filer under an obligation lease. Only a successful
filing (including a durable pending-card spool) marks it done; refused or failed filings stay owed.
A detached spawn alone never completes the obligation. Replay carries the original obligation
key across the CLI's text bounding so truncation cannot create another obligation identity.
Use temporary `WE_CARD_BATCH_STATE_DIR` roots when testing pause/replay.

## Periodic card batch recovery

`card-batch-reconcile.mjs` shares admission's terminal-PR retirement and per-state lease.
Health-watch samples `cardBatch.reconcileIntervalMin` through `readSettings` (positive integer,
default 5), persists `cardBatchReconcile.completedAt`, and skips fixture-root/dry-run ticks.
Reconciliation drains `pending-prevention` through the same lane-acquiring recovery path as
`land-prevention-card --drain-pending` after retirement or for open slots, releasing the state
lease before draining so admission can open sequence + 1. Terminal retirement requires the existing completed-seal condition plus a fresh
GitHub MERGED/CLOSED read for the recorded PR number and batch branch. Retirement
archives the generation and logs the outcome. Terminal PR archives carry
`terminalPrState`; an explicit seal retry revalidates that hint with GitHub before
returning sealed. Incomplete seals remain held. Its CLI dry-run only reads states.
Use temporary state directories, fake GitHub and local bare Git origins for these probes;
never run a recovery test against the automation state home.

## Label provisioning cache

All label provisioning uses `scripts/lib/label-cache.mjs`, including the review/land providers,
drain, CI hand-off, and stand-down paths. Per-repo label names live in atomic JSON files under
`.conveyor/label-cache` in the running WE checkout, shared by its processes. PR state and merge
admission are never cached here. `labels.cache.ttlMs` defaults to 3600000; 0 disables caching.
The source-logged cascade reads the platform `labels` block, then the `labels` block in
`scripts/settings/labels.json`, then `WE_LABELS_CACHE_TTL_MS` (nonnegative integer milliseconds).
A cached miss refreshes once before creation; creation adds the name without extending the
list timestamp. Failed list/cache IO falls back to provisioning; failed creation is excused
only if a fresh list confirms another process created the label. Focused coverage lives in
`scripts/lib/__tests__/label-cache.test.mjs`; adapter argv tests disable caching explicitly.

## Immutable PR field sharing

`scripts/lib/review-pr-snapshot.mjs` shares `files`, `commits` and the replay reader's `gh pr diff` across review readers
in atomic on-disk snapshots, keyed by host, repo, PR, head SHA and live base SHA.
`review.prSnapshot.ttlMs` defaults to 120000; 0 disables it. The source-logged cascade
reads the platform `review.prSnapshot` block, then `prSnapshot` in
`scripts/review-settings.json`, then `WE_REVIEW_PR_SNAPSHOT_TTL_MS`.
Metadata, comments, reviews, labels and mergeability stay live. Net and stack diff
bases also stay live: the current main/stack can change without the PR head moving.
Missing, expired, corrupt or unwritable caches fall back to fresh PR fields.
Focused coverage: `scripts/lib/__tests__/review-pr-snapshot.test.mjs`.

## Shared PR context for jurors and fixers

`review-pr-snapshot.mjs#readPinnedPrContext` shares informational body/files/commits/refs
and comments by host + repo + PR + full examined head SHA, with atomic publication and
a cross-process refresh lock. `scripts/pr-context.mjs <PR> --repo=<slug> --head=<full SHA>`
is the agent read port; it and the fix context pack use the complete paginated comment
reader, and cache that completeness separately from the CLI's capped comment connection.
A miss reads comments before the final view, rejects a mismatched PR/head, and never stores
a failed read. A different head selects a different file. An expired entry never serves.
The TTL uses the existing source-logged `review.prSnapshot.ttlMs` cascade documented above;
no separate context TTL or off-switch exists.

`review-pr-io.mjs#ghPrView` and unpinned `review-detail` reads remain live and seed this
context from their response. Juror requests carry the actual PR, examined SHA and absolute
WE script path, so sibling-repo jurors can use the same port. Fix/CI dispatchers pass their
planned head to the pack. Round history shares commit context, while its complete thread
stays live because repeated-finding guards consume it. All label, merge, CI, head-revalidation
and pre-mutation authority reads remain live; cached context cannot grant permission to act.
Net/stack diffs continue using live bases. The older immutable-field adapter retains its
head + base discriminator and live-metadata behavior.

Regression coverage: `scripts/lib/__tests__/pr-context-sharing.test.mjs` stubs gh and counts
calls across separate readers, changed heads, expiration, failures, context packs, the CLI,
review detail and juror request construction. The source scan inventory is in
[pr-read-inventory.md](pr-read-inventory.md).

## Review fetch sharing

The review daemon scopes `review.fetch.sharedPerTick` (default `true`) to one tick through
`scripts/lib/review-fetch.mjs`. The cascade reads `fetch.sharedPerTick` from the review platform
preference and `scripts/review-settings.json`; `WE_REVIEW_FETCH_SHARED_PER_TICK=true|false`
overrides it. The cascade logs the winning source. Review readers share branch tracking refs
per real clone path and remote, with targeted fetches for uncovered refs; failed shared fetches
retain each reader's existing fallback. No tick context means no command changes. Keep this
context inside the review daemon; merge admission must continue using its existing fresh reads.
Regression coverage uses real local Git repositories in `scripts/lib/__tests__/review-fetch.test.mjs`.

## Daemon entry boot smoke

Boot each entry in a fresh child to preserve cold import graphs. `rebuildSmoke.bootConcurrency`
(default 3) bounds initial boots; after those children drain, `rebuildSmoke.bootSignalRetries`
(default 1; zero disables) retries only SIGTRAP/SIGSEGV/SIGABRT/SIGBUS/SIGILL deaths, serially.
Exit failures and `ok:false` never receive this retry. Both settings use the policy cascade via
`scripts/settings/rebuild-smoke.json`, with env overrides `WE_SMOKE_BOOT_CONCURRENCY` and
`WE_SMOKE_BOOT_SIGNAL_RETRIES`; log effective values and sources. Env integers are strict
digits; empty is unset.

Smoke diagnostics never carry raw child stderr or stdout (operator decision, PR 5460). A boot or
dispatch smoke failure detail, held state, self-sync alert and PR comment carry only an
allow-listed summary (`daemon-boot-smoke.mjs#pickSmokeDiagnostics`): entry name, signal, exit
code, attempts, launch start time, session/transcript presence, and an error class. The class is
the first line matching `^[A-Z][A-Za-z]*Error:` that is not inside a quote opened on an earlier
line, cut to 80 chars, with its quoted text (ASCII, typographic, guillemet and fullwidth) replaced
by `<…>`: one cleanly bounded string in place, any other shape (several quotes, an unterminated
or glued-on one) from the first quote to the end, because V8's JSON parse messages copy input
with unescaped quotes. Control/format characters are dropped and token shapes redacted; a bare
`Error:` line has none, and unparsable child output gets a fixed class. The raw output's last 30 lines go only to a new owner-only (0600) file under
`<daemon state dir>/smoke-diagnostics` (0700, newest 500 kept), and the summary names its path.
Culprit attribution reads typed repo-relative `files` the boot check extracts from the raw text
in-process (`sourceFilesIn`), never the text itself.
A transcript denial is counted, never quoted. Test with sentinel words that are not
secret-shaped, so only the design can keep them out of every sink.
Cover retry recovery, exhausted retries, non-signal refusal and concurrency with injected children;
exercise diagnostic propagation through a real-git rebuild fixture. Run these suites through heavy admission.

## Red-team re-check evidence

The drain reads saved red-team evidence for the exact repository, PR and live head when no
trusted result comment exists. Saved rows require a completed `review-pr` run with
`findings.savedRedTeamResult = { writer: 'review-job', references: [{ path, index }], sha256 }`.
The review job attests the persisted result before running the gate, for panel-seat and
post-accept timing. Hash the referenced rows as one JSON array, sorting object keys recursively
and preserving array order, including all persisted fields. Readers verify every reference and
the hash against the same scorecard snapshot. Missing or invalid provenance returns no result
and logs a fixed `saved-red-team-ignored:` reason without row contents; the attempt still holds
and cannot age into the never-scheduled escape. Nominally clean rows rejected by provenance do
not launch another pass. Regression coverage: `saved-red-team-provenance.test.mjs` and the
production writer-to-reader cases in `review-job-red-team.test.mjs`. A completed clean result satisfies the hold; confirmed breaks
use the same gate, round cap and operator ruling as posted results. An identical result posted
after a named round-cap ruling keeps that ruling; changed results and unknown saved chronology
remain held. Saved finding text passes the publication scrub before comments or cards are written.
Corrupt or incomplete evidence refuses admission. Errored, crashed, unparseable and unusable runs
remain held and cannot use the never-scheduled fallback or re-request path. The existing broad
recorded-run guard is preserved. Card-only diffs owe no new pass when `skipCardOnly` is on;
recorded or started runs and confirmed breaks still hold. A saved-only gate decision cannot be
carried across a rebase without its result. Regression coverage: `drain-saved-red-team.test.mjs`,
`drain-merge-strategy.test.mjs`, and the saved round-cap soak case.

The post-accept re-check reads a separate, self-contained checkout pinned to `read.netBasis.rev`,
never the released review lane's current HEAD or the red-team probe's working tree. Its Claude
juror uses `judge-spawn.mjs` with `Read`, `Glob`, and `Grep` only, in an independent lane-shaped
scratch directory; cleanup runs after success or failure. A configured provider unable to honor
that tool allow-list fails the re-check rather than silently dropping repository access.
`review-red-team.test.mjs` pins this with **rejects incompatible providers when repository reads
are enabled**, parameterized over Codex and Antigravity, with a tool-free twin and zero spawns
on refusal.
The mandate requires reading cited files and callers and reporting repo-relative `filesRead`
per claim. A negative answer with no files read, missing answer, unavailable context, or failed
re-check is `unverifiable`, not `not confirmed`. That outcome and the files read survive evidence
storage and comment retries; only confirmed findings count as misses.
Model-reported paths pass the same secret scrub and strict ASCII path policy before evidence
storage and comment rendering, including legacy retries. Unsafe entries are discarded whole;
the policy checks at most 100 entries of at most 600 characters each, deduplicating valid paths.
While the pinned clone exists, paths must resolve to regular files inside it; missing files,
Git metadata, and symlinks escaping the clone are discarded. This validates reported evidence;
it does not prove a tool actually read the file or confine the tool's filesystem access.
Re-check reasons use a fixed vocabulary (`demonstrated break`, `relevant code refutes claim`,
`insufficient evidence`); unknown text becomes `reason withheld`. Enforce this in the answer
schema, parser, and publication paths, including completion of saved speculative passes and
legacy comment retries. Pattern-based secret scrubbing cannot safely publish arbitrary text
from a juror with filesystem access. Regression coverage: **withholds unrecognized re-check
reasons at every publication sink**. Filesystem read confinement remains separate work.
Provider failure text can contain raw juror output too: re-check statuses use fixed values
(`ok`, `pending`, `not-needed`, `error`), including saved-pass completion and legacy retries.
Regression coverage: **withholds raw juror errors and legacy re-check statuses from stored and
public evidence**.
Regression coverage: **scrubs unsafe filesRead at the comment and evidence sinks**,
**scrubs filesRead when completing speculative evidence and retrying legacy rows**, and
**the production re-check uses an independent pinned lane and cleans it**.
For evidence leak assertions, inspect nested string values directly: JSON property names can
match unsafe inputs such as `"file"`, while serialization can hide control characters by escaping them.

`redTeam.recheckReadsRepo` and `redTeam.skipCardOnly` default to true. The cascade is standard
→ platform (`delivery-platform-preferences.json`'s `redTeam` block) → tool
(`scripts/settings/red-team.json`'s `redTeam` block) → environment
(`WE_RED_TEAM_RECHECK_READS_REPO`, `WE_RED_TEAM_SKIP_CARD_ONLY`; true/false, on/off, 1/0).
Effective values and sources are logged before probes. Card-only detection reuses
`ci-card-only.mjs#isCardOnlyDiff` on the net changed-file list plus `netRenameSources` (both
rename and copy sources); unknown/empty destination lists or malformed source lists do not skip.
Moves into or out of `backlog/` probe whenever either side is code; card-to-card moves still skip.
Regression coverage: **includes rename sources before deciding to skip probes**, covering both
sequential and speculative paths. The speculative fingerprint also includes rename sources.
Replay derives rename/copy sources from diff headers using the review reader's existing parser;
**replay retains rename/copy sources so code moved into backlog still probes** pins that wiring.
The sequential and speculative paths skip before budget reservation and record the reason
`red team skipped: card-only`. Setting `recheckReadsRepo=false` restores a tool-free re-check;
negative answers without file reads remain unverifiable.

## Drain red-team disposition and retry evidence

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

## Heavy admission in a restricted filesystem

The host queue needs write access to the admission pool's parent as well as the pool:
`releaseLockDirIf` atomically renames a lock to a sibling tombstone before removal.
An `EPERM` on that rename is an admission infrastructure failure, not a suite result.
Keep the host queue; do not switch to a private pool or run tests directly.

## Prepare throughput

Prepare batches use `prepare.batchSize` (6) and the just-in-time window uses
`prepare.aheadCount` (20), standard → platform `prepare` → tool `prepare` → env
(`WE_PREPARE_BATCH_SIZE`, `WE_PREPARE_AHEAD_COUNT`). Effective values and sources are logged.
An explicit `--prepare-ahead-window` or `WE_BUILD_DAEMON_PREPARE_AHEAD_WINDOW`
overrides that cascade. Resolve it once per tick for planning, replanning, and batch
membership; `off` disables the window while keeping queued cards eligible for batches.
Only build-bound cards in that window are eligible, including stale stamps. Order is
`build.priority`, then ready-queue order. Batch members must belong to the same repository
and have disjoint scopes. Every card gets a fresh worker launch containing only its own
card and scope, and one commit. `prepare.batchParallel` (true) uses separate leased lanes;
`prepare.batchMaxParallel` (3) limits fan-out to the builder external concurrency cap.
Both follow the same cascade with `WE_PREPARE_BATCH_PARALLEL` and
`WE_PREPARE_BATCH_MAX_PARALLEL` overrides, logging effective values and sources.
Sequential mode still launches a fresh worker per card. Worker IO and gates carry the
card session identity; assembly reuses the first surviving card's lane and identity
so verify-lane observes its own lease. Local `lane/prep-<card>` refs
retain individual commits and never open PRs. An assembler lane cherry-picks them in
priority order onto `lane/prepare-batch-<first-id>-<n>`; conflicts are aborted with rerere
disabled and the card is deferred to the next batch, without manual resolution.
Only cherry-pick conflicts enter `deferredToNextBatch`: the daemon releases deferred lead/member
claims without a failure hold, then admits them again on the next tick. Each surviving card
passes its own checks and receives its own stamp; a failed card is restored and its reason
recorded in the batch result and PR body. One PR is titled `prepare: <ids>`.
Worker failures stay in `groupDropped` and enter the normal prepare failure/hold path,
including failed leads and members. A failed assembly gate or publication accounts for
every undelivered card except conflicts. Test consecutive ticks to prevent immediate
readmission; replay `prepare-batch-window-and-failure-accounting` for both cases.
The batch branch uses the first surviving card and surviving count; status reads require
that branch to agree with the exact title membership. Preserve the original group lead
in settlement fixtures, including when that lead failed but a member has a stamped OPEN PR.
Redact diagnostics before any head/tail limit and again at the public body writer;
replay `prepare-batch-publication-boundaries` for credential cuts and claim retirement.

`review.cardOnly.lightLane` (true) seats one blocking Codex correctness juror for a net
diff containing only direct `backlog/*.md` cards. `review.cardOnly.claudeSeat` (false)
adds a Claude seat when enabled. Both resolve standard → platform `review.cardOnly` →
tool `review.json` `cardOnly` → environment (`WE_REVIEW_CARD_ONLY_LIGHT_LANE`,
`WE_REVIEW_CARD_ONLY_CLAUDE_SEAT`), logging sources. Rename sources participate;
unreadable/empty lists keep the full roster. The pinned net read must confirm the
classification before judging, and resumes retain the saved roster.
The existing `redTeam.skipCardOnly` cascade and CI card-only path filter are reused.

## Codex usage accounting

Every direct task, Codex delivery/fix worker, wrapped Codex dispatch worker, and Codex review
seat appends through `scripts/lib/codex-usage-ledger.mjs`. The default ledger is
`<daemonConveyorStateRoot>/codex-usage.jsonl`; `WE_CODEX_USAGE_LEDGER` overrides the file.
Direct CLI attribution flags are `--caller`, `--repo`, `--pr`, `--card`, and
`--usage-task-kind` (an accounting label that preserves model routing).
Redirect the ledger to a temporary file in tests. Append/probe failures must preserve the launch's result
or original error. Unknown tokens, quota, file changes, and exit codes stay null; quota resets have no delta.
Persist repository identities as `owner/name`, stripping remote credentials, queries, and fragments.
Worker-writable snapshots use the shared Git hardening, refuse lane-defined filters, and never read
worktree contents or run Git diff/conversion commands. Fingerprints include HEAD, index entries,
and nanosecond file metadata; touches can count as changes. Snapshot limits are 4096 untracked
paths, 65536 tracked entries, 8 MiB per Git output, and a five-second budget. Lazy fetch is disabled;
submodules, sparse directory entries, and unsafe or incomplete snapshots record unknown file changes.
Delivery providers accept `usageTaskKind` separately from routing `taskKind`.
Quota is sampled from the newest persisted Codex rollout observations, so ephemeral runs may
have no fresh observation and concurrent runs can contribute to the observed bucket delta.
`node scripts/codex-usage-report.mjs --since=24h` (or `--json`) reads without launching Codex.
Cached input is a subset of input; reasoning is a subset of output when reported, not additive spend.


> Tier-1 reference. Read when writing or changing tests.

Keep the 50-tick daemon soak baseline alone in shard 1 when splitting the soak suite. Balance break
scenarios by measured time across the remaining shards; timing estimates must never put a sibling
scenario beside the baseline. Those scenarios fork real daemon and git children, so concurrent worlds
can exhaust the baseline's wall-clock timeout while its per-tick invariants continue to hold.

Injected Gemini subprocess tests must set `ANTIGRAVITY_QUOTA_DIR` to a per-test temporary directory:
real backend holds otherwise prevent even the fake child from starting. Real POC branch-sync fixtures
must pass a temporary `lockRoot` through `withPocLandLock`, preserving the mutex without touching host locks.

## PR time-loss safeguards

`fix.alertAtRoundCap` publishes through the needs-you feed as soon as the notes pass observes exhaustion,
independently of note-comment dedup and quiet-hour desktop delivery. Polling must include `needsPerson`
rows so it does not clear and reopen those events, losing the original idle timestamp.
`fix.resetOnRepeatedFinding` keys full normalised claims by lens and file (not moving line numbers),
requires a trusted completed fix between sightings, and accepts `scope-baseline: <full sha>` only from
an operator comment. Fix-end comments carrying the shared infrastructure-stall marker (including permission
stalls) do not complete a fix. Identity reads full finding text, including multiline continuations, and
binds it to the complete rendered Findings envelope: em dashes and apparent Markdown boundaries inside
summaries must not discard a distinguishing suffix. Source coordinates are ignored only when both the
envelope's total and anchored bullet counts agree with its declared count. Changed scenarios, metadata or companion findings can therefore
conservatively decline a repeat. Keep the coroner's compact display separate from this identity read.
A corrective tree reset preserves published ancestry and replays only whole linear
commits inside the declared scope; unreadable or ambiguous history stands down. Test real Git trees,
untrusted markers, changed lens/text, no intervening fix, and the launcher path for every executor.
A non-main merge fixture must reach history inspection with a valid scope and clean lane, then assert
refusal before `read-tree` or `cherry-pick`, with identical index bytes, HEAD, status and worktree bytes.

`review.carryAcrossIdenticalNetPatch` compares nonempty `git patch-id --stable` outputs for each head's
net diff against its own merge-base with main, then requires equal contribution fingerprints and
byte-identical added/removed lines (including the root manifest). Patch-id alone discards meaningful
whitespace and hunk locations. On an unchanged base, require the full positioned patch, including hunk
headings and context. When bases advance, require identical positioned base-to-base and head-to-head
deltas, ignoring only index blob IDs; unreadable deltas decline the proof. This preserves offset-only
rebases when the upstream edit lands at the same location in both trees, while conservatively declining
overlapping edits. Read raw buffers and refuse lossy UTF-8 decoding before computing equality. Exercise
non-UTF-8 source bytes, indentation, string whitespace, trailing spaces and CRLF through the writers,
as well as a successful offset-only rebase and edits moved between identical functions through both writers.
Changed context can decline this proof without disabling
independent contribution/replay or tree proofs; test those with the setting both on and off.
Human carries bind both Git diffs to the recorded and pinned fingerprints,
then re-read the complete thread and formal reviews through the existing writer. Automated carries use
the same guarded numbering-restamp writer. Keep numbering-only fixtures explicitly on that proof so they
cannot silently reach real Git when the new fallback runs. The tamper-park callback derives numbering-only
mode from missing recorded fingerprints; exercise its production callback with fingerprinted and SHA-only
clearances through the durable writer, including refusals and live holds.
Pass the evidence repository's `cwd` into `proveIdenticalNetPatch` even with a cwd-bound exec wrapper:
the reader supplies a `cwd` option, and an undefined value can otherwise override the wrapper's directory.

Review-held gates belong to review regardless of advisory settings; unrelated failed checks still need
repair. Cancelled test/soak shards, including long-running cancellations, use the existing rerun ledger
once per head before heal. Do not let the stale-CI fallback grant a second rerun after that allowance.
The read-only Actions workflow cannot keep a completed job pending, so its exit-code hold stays intact.

## Human clearance across empty commits

An empty recovery commit can carry a fingerprinted human clearance when `rev-parse --verify
<sha>^{tree}` proves the cleared and live heads have exactly the same root tree. This includes
paths, modes, blobs and the lane manifest; changed trees receive no tree-based carry.
Use `applyHumanClearanceCarry`, with a pinned scored diff and a fresh complete comment thread
from `readCompletePrComments` plus formal reviews before the durable record. Missing fingerprints,
unknown evidence and head mismatches refuse general carry before Git or the writer. SHA-only
clearances remain confined to the explicitly requested numbering-only proof. Test real empty
commits and changed trees through the writer, alongside refusal cases with zero writer calls.

## Human clearance across drain numbering

A `clear-human` record already counts as acceptance; a numbering carry must also run before
workflow and anti-test-gaming holds can re-park it. Use the existing human carry writer with a
fresh head, complete comment thread and formal reviews before posting. Its numbering tier uses
`proveNumberingOnlyMove` unchanged: exact blob bytes, file modes and a bounded linear chain.
A SHA-only clearance can use that proof without an old diff fingerprint; the new record still
requires a pinned, scored live diff and retains the original human actor and carried-from head.
`review.carryHumanClearanceAcrossNumbering` defaults true and resolves through standard,
platform, tool and env (`WE_REVIEW_CARRY_HUMAN_CLEARANCE_ACROSS_NUMBERING`), with its source logged.
The existing human carry master switch still applies. General refresh equivalence cannot waive
the exact-head workflow ceremony. Regress through the production gate with real numbering git
objects: a human clearance, numbering alone, numbering plus an unrelated byte, SHA-only markers,
a live objection, the disabled switch and an automated acceptance. Keep the automated restamp
suite intact; the human-specific switch must not disable automated acceptance carries.

## Human-only re-park net basis

The human-surface sweep uses `readHumanSurfaceNetFiles` over the shared `readNetFileSets` reader.
Unlike the scope reader, this gate requires a successful fetch of current `origin/main`; cached refs
following a failed fetch cannot prove the absence of a sensitive change. Test inherited-main identity
files separately from the PR's own identity edits (#5381). On an unavailable net basis, a complete
GitHub files API list below its 3000-file cap with no human-only hits skips the PR. A sensitive hit,
cap-sized list, malformed list or failed list read still fails closed. Inject a sweep-wide net outage
across several accepted PRs with clean lists and assert zero re-parks, including in the soak fixture.
The fallback provider must retain both rename paths: moving a workflow to an ordinary directory
still removes a human-only surface. Count both paths conservatively against the API cap.
Inject net reads into sweep and soak
fixtures so synthetic heads never cause real network fetches. `review.humanSurfaceUsesNetDiff`
(default true) resolves through the policy cascade; false explicitly restores the legacy list decision.
Public comments use fixed failure reasons; raw git diagnostics stay in local logs. Test fetch,
merge-base and diff failures containing private paths and remote URLs, plus thrown reader errors.
Every fail-closed branch needs a named test, including successful-looking net results with missing
or non-string file arrays, including sparse arrays whose empty slots `.every()` skips. Validate both
net and fallback lists with the same check. Deterministic reader tests must reject branch/worktree mutation commands;
real-git fixtures must preserve HEAD, branch, index, status and dirty file contents around each read.
Review checklist: for each new fail-closed path, does the failure mode scale per PR or per sweep?

## Quarantine proof fixtures

Quarantine addition scenarios using `red-main-quarantine-62da75ed3.json` must explicitly supply a
hypothetical earlier run of the failing sha whose re-run passed the job (run attempt 2, latest job
attempt `success`), never a passing attempt on the failing run itself (a job that passes there is no
longer failing): the recorded episode had none and must remain a negative replay. A green merge group is never flake
proof, because it tested its queued PR's changes, which may fix the failure. Keep proof validation
enabled and the recorded fixture unchanged, including when exercising the once-per-tick safety net
through both health smells.

## Soak shard isolation

Keep the 50-tick baseline alone in CI shard 1; balance break scenarios by measured time across the other
four shards. Each world spawns real daemon and Git subprocesses, so timing balance alone can put competing
worlds beside the baseline and exhaust its overall deadline even when completed ticks satisfy every invariant.
Regression coverage must preserve every file exactly once, the single-shard fallback, and baseline isolation
when its stored timing is missing or stale. Keep tick counts, invariants, and timeout limits intact.

## Model routing retry verification

Codex `modelByTask` resolves model, effort and the optional `retry` array as independent cascade
leaves. Each retry pair must use a catalogue model and one of its supported efforts; `[]` disables
same-provider retries. Cover standard, platform, tool and env provenance, invalid pair rejection,
and the actual launch sequence before Claude fallback. Routing-policy model vetoes must survive
settings expansion at the launch boundary. Only a definite pre-launch `notApplied` refusal advances
the chain; an indeterminate or already-started launch must never start a second worker.
Repair defaults (`operations.fix`, `operations.ci-heal`, `taskTypes.bugfix`) keep `inherit: true`
at high effort so evidence routing, backend holds and fixer escalation remain effective. Assert the
Codex retry order through `codex.modelByTask` settings; use an explicit route fixture for launch-boundary tests.
Claude helper defaults resolve through `claudeHelper` and `WE_CLAUDE_HELPER_MODEL`; explicit
per-lens design models still override the helper default.

## Rebuild smoke proof reuse

Rebuilds retain up to five complete passing smoke proofs in the existing per-clone rebuild state.
Keys bind clone kind, Git tree, lockfile, Node version and the running smoke harness hash.
`rebuildSmoke.reuseEnabled` (true) and `rebuildSmoke.reuseHours` (12) resolve through the
standard → platform → `scripts/settings/rebuild-smoke.json` → env cascade; env overrides are
`WE_REBUILD_SMOKE_REUSE_ENABLED=0|1` and `WE_REBUILD_SMOKE_REUSE_HOURS`. Log each leaf's source.
On reuse, materialize the candidate and skip only table rows declaring `kind: code`; every `env`
row runs again, including lane lease/release, daemon boot and tree cleanliness. A failed env
check refuses adoption. Reused passes never refresh the original proof timestamp; missing rows,
failures, disabled gates, busy-pool skips and other partial runs never establish a proof.
After a candidate failure, set-aside, plain-main, confirmation and last-good smokes run fresh
code checks, without cached proofs or unchanged-code skips. Even a fallback already running
must pass a fresh comparison before the rebuild blames and removes an overlay.
Probe identical-content commits, changed trees, expiry, disabled reuse, failure and partial
results through the real rebuild fixture, plus actual check selection through `runLiveSmoke`.
Run these suites through the host heavy-admission queue.

## Daemon entry import regression

`daemon-entries-import.test.mjs` cold-imports every `DAEMON_ENTRY_MODULES` entry from the
rebuild boot smoke in a separate eval-mode Node child, without invoking daemon main functions.
Keep this in the unit tier: shared-process imports can hide ordering-dependent ESM cycles.
Process liveness helpers shared by drain evidence and review jobs live in the dependency-free
`scripts/lib/pid-alive.mjs`; importing the job store for a helper pulls in dispatch and reconcile.

## Smoke sentinel worker isolation

Daemon rebuild dispatch dry-runs force `WE_WORKER_WRAPPER=off` so injected spawners capture both fix and
review prompts. Missing or blank captures fail; synthetic review PRs inject an allowed CI gate so the brief
check cannot silently skip dispatch. Wrapped launches also refuse sentinel PRs (`9xxxxx`) and session slugs
ending in that sentinel unless `smokeRealWorker.allowSentinel` resolves true through the shared cascade
(`scripts/settings/smoke-real-worker.json`, env `WE_SMOKE_ALLOW_REAL_WORKER=1|true`). The deliberate overlay
real-worker smoke sets this opt-in itself. Test refusal with an injected launcher, for every default-on role.

## Wrapped worker verification waits

For the 117 S3b regression (2026-10-08), replay the saved StructuredOutput fixtures against both
reader caps and the Claude launch schema. Keep the checked-in Codex schema unchanged. A wrapped
Claude turn may end while verification runs: the wrapper publishes its own live pid and idle status,
then consumes a resume request for the same session. Use temporary await/spec/completion stores,
a fake child, and an injected clock to cover expiry, the overall deadline, foreign requests, and the
six-resume limit. Only the last turn supplies the final result, including when it omits StructuredOutput.
A wait that ends with no verdict delivered (expired or cleared record, deadline, foreign request, or the
cap spent while the last turn still awaited) is not a completion: the awaiting turn's `done` becomes a
retryable `infra-transient` block (`verify-wait`), so nothing reads an unverified, unpushed run as done.
The await-verify pass treats a session missing from an incomplete listing (either population failed to
list, or a wrapped record was unreadable) as unknown, not gone: cover it with a listing that throws.

## GitHub priority admission

The throttle returns a JSON `deferred-low-budget` result without invoking GitHub when a fresh,
identity-scoped GraphQL observation crosses the caller's reservation threshold (background 25%,
normal 10%). CLI status is zero; stderr and the spend report distinguish a skipped pass from success.
Use `isGhDeferred` from `we:scripts/lib/gh-deferred.mjs` before parsing query data or caching results;
a deferred response is not an empty PR list. Discovery CLI passes can use `deferGhPass` to skip before
making decisions. Critical review/drain callers still respect actual exhaustion and secondary backoff.
Test with a temporary throttle root and injected subprocesses; never spend live GitHub quota to test scarcity.
The gh holder policy lives in `scripts/settings/gh-throttle.json` and resolves once per process/env object. Holder tests use a temporary lock root and injected clock/sleep; watch calls must remain unslotted. Watch detection and the write/op classifiers read gh argv the way gh's own parser does, so test leading global flags (`--repo o/r run watch`), `--flag=value` booleans and flag values that look like flags (`--body --watch`). Verify timeout fidelity against a real local child, preserving native timeout errors and releasing its slot without signalling the holder process.
Holder diagnostics persist only allowlisted command labels, omitting endpoints and all argument values. Sanitize old metadata and process-table commands at the output boundary as well as new lock writes. Cover admission with a decision table over caller-capped, pool-full and over-age states. Reaping waits for the greater of policy and the recorded effective timeout plus grace; an explicit zero timeout prevents age-based reaping of that holder. Metric operation labels use the same bounded vocabulary as default call logs.
Daemon simulator worlds with independent clocks must each override `WE_GH_THROTTLE_LOCK_ROOT`
and `WE_COORDINATION_ROOT`, even when Vitest already supplies per-file roots. A previous world's
future-dated exhausted budget can otherwise make a fresh world wait for the production timeout.
Use the clone's routing policy rather than an inherited daemon snapshot, and exclude generated
GitHub App shim directories before scanning the host's tool PATH.

General simulator and soak fixtures model the full required-check set and pin `WE_REVIEW_START_AFTER=ci-green`
in the shared world environment. Keep the planner and dispatch-time gate on the same fixture policy across
daemon restarts. Production fast-check eligibility is covered by `review-timing-dispatch.test.mjs` and
`review-ci-gate-io.test.mjs`; scenarios exercising that timing must explicitly set their world policy and checks.

Fake-`gh` CLI fixtures that exercise throttling must set `WE_GH_THROTTLE_LOCK_ROOT` to a temporary
directory per invocation and route the binary to their fake. An intentional rate-limit response writes
cooldown state; sharing that state with another test or the host delays unrelated reads.
Generated shims that embed functions with `Function#toString` must embed every dependency as well.
Keep the resource classifier and its argv parsers together in `scripts/lib/gh-argv.mjs`: imported
references inside a stringified function can retain Vite's SSR binding names. Exercise the emitted
source in an empty VM context and the real shim after its generating checkout is removed.
For Node subprocess script paths imported by Vitest's browser environment, use
`join(dirname(fileURLToPath(import.meta.url)), filename)`: Vite can rewrite a relative `new URL(...,
import.meta.url)` as a browser asset URL, which `fileURLToPath` then rejects.

## Standalone probation builds

`scripts/operations/probation-build-run.mjs` accepts `--taskType=doc-fix|bugfix|test-fix|prepare` (doc-fix default),
roster names or legacy JSON in `--worker`, and an allowlisted `--model`. Each omitted session is
generated independently. Different items use separate lane clones; do not reuse an explicit session
and lane for simultaneous runs. Task files, worker logs, commit messages and PR bodies are lane-local.
Before acquiring a lane or claiming, the runner reads the launch card’s `blockedBy` and checks blocker
frontmatter on `origin/main`. Unresolved or missing blockers return `blocked` with their IDs; a local
resolution does not count. The isolation tests cover this refusal and the resolved/no-blocker paths.
Pool discovery uses `defaultPoolRoot` with the script checkout root, never the caller cwd.
Mutation subprocesses must use both the lane cwd and the lane’s script copy: backlog and operation tools
derive their roots from `import.meta.url`. Daemon clones remain read-only launch sources. The isolation
test snapshots every launch-checkout file, including `.git`, across success and pre-worker failure.
Prepare edits only the target card body and preparation stamps, never claims/resolves it, and verifies
the runner-authored stamp before opening a parked PR. Its implementation scope does not bound preparation;
the card path does. `prepare.runner=codex` passes that card path to routing; `scope` retains implementation-scope
gating, and `claude` forces the daemon fallback. Use a named critical gate file (for example,
`scripts/lib/dispatch-contracts.mjs`) in scope-gating fixtures: arbitrary `scripts/lib/` files are not
critical by directory alone. Decision preparation remains a Claude judgment role.
Flash keeps the Codex read-only checker; a checker refusal undoes the attempt.
`test-fix` uses Flash without a separate simple flag and refuses non-test worker diffs.
The CI-heal decision currently has no structured failing-file list; do not infer one from check names.
Standalone Findings are publication text: strip absolute local paths, qualify code references using the
standards locus detector, and cap the final excerpt. The temporary-lane regression runs the actual
file-scoped standards gate on a written card. Envelope refusals discard and verify removal of the worker
diff before writing a card-only finding; preserve scope and hold for the builder rather than routing
these cards to auto-prepare. Capture the first gate error before truncating subprocess output, so the
runner result names the failed check even when the output tail only contains the summary.


Verify parallel isolation with the integration test
`scripts/__tests__/lane-pool-acquire-shares-scan-cache.test.mjs` (the three concurrent acquirers case).
The build-run tests separately race real scorecard writers in temporary storage. Probation builds
pass `requireLock: true` through scorecard migration and append, refusing the shared lock's usual
unlocked fallback on timeout. A refused scorecard write is reported on stderr without undoing a
successful build. Operation records use UUID filenames and atomic rename; call logs use append-only
writes, so they do not replace a sibling process's records.

## Shadow reviewer agreement evidence

The agy mandatory-seat shadows are off by default (operator 2026-10-16).
`review.shadowSeats.antigravity.enabled` / `WE_REVIEW_SHADOW_AGY_ENABLED` enables shadows only within the selected scope.
`scope` / `WE_REVIEW_SHADOW_AGY_SCOPE` defaults to `high-care`: use the read's
`earnedShape` from `review-core-cli.mjs shape`, seating elevated/high care and sensitive
escalation reasons (including human-required surfaces). Routine PRs stay unseated.
`sampled` restores the deterministic PR sample, with `sampleRate` / `WE_REVIEW_SHADOW_AGY_SAMPLE_RATE` defaulting to 0.1.
Rates must be finite numbers in `[0, 1)`; 1 is refused and the invalid layer is logged.
Selection uses SHA-256 of lowercase `owner/repo#pr` (first unsigned 32 bits below
`floor(sampleRate * 2^32)`; at least one bucket always excluded), shared across lenses and rounds. Missing PR identity does not seat a shadow.
Disabled panel rows say `agy shadow off (setting)`; unsampled rows say `off (sample)`.
Routing-policy declarations and model/trial settings alone do not enable live shadows.

`review.minNonClaudeSeats` / `WE_REVIEW_MIN_NON_CLAUDE_SEATS` defaults to 1, accepts
positive integers, and adds the Codex simplicity and then correctness advisory seats
as needed. These answers stay advisory. A skipped/unavailable answer does not count;
a shortfall (including a minimum above the two available Codex lenses) is recorded on
the verdict and printed in both the verdict write-up and human advisory note. Saved
runs retain their original roster, with the same explicit shortfall reporting.
These settings resolve through standard → platform `review` → tool
`scripts/settings/review.json` → env, logging effective values and sources.
Validate each complete scalar before cascading: nested and empty objects, arrays,
and null must be logged as invalid and fall through. Cover every safeguard setting at
both platform and tool layers, including platform `{value:false}` against tool
`enabled:false` through directive selection: neither lens may launch a shadow.
Test the actual judge request and panel reduction with injected providers, including
zero agy calls when disabled and failed Codex answers, through heavy-admission.
Historical optional-roster fixtures explicitly use a zero declaration minimum; the
operational settings never accept zero.
Exercise historical confirmation through both `resolveOperation('review-pr', {resumeId})`
and the real `run.mjs review-pr --resume=<id>` CLI, with Codex flags off and the default
minimum, then with changed flags and a minimum of two. Both CLI confirmation paths
use `reviewSeatOptionsForRun` to keep every saved optional seat; fresh registrations
still enforce the live minimum.

`dailyCap` / `WE_REVIEW_SHADOW_AGY_DAILY_CAP` defaults to 100 sessions per
America/New_York day (zero disables launches). The runner atomically reserves a
numbered slot under `agy-shadow-agreement.jsonl.sessions/<day>/` before each
attempt, including model retries. Reservations count starts rather than completions;
quota refusals and crashes conservatively consume a slot. Slots are shared across
lanes and survive process restarts; local midnight, including DST, selects a new day.
A full budget logs `daily cap reached` and records a skipped shadow. An unreadable
counter refuses admission. Neither a cap skip nor a quota hold retries on the
routing model or adds a Claude fallback; the original mandatory Claude answer remains.
Skipped shadows have their own count in agreement and trial reports; they are neither
failures nor comparisons and do not advance the trial. A primary `agy` seat still
falls back to Claude on quota or skip results when its `onEscape` policy is `claude`.
Use temporary stores and injected admission/providers in tests, never host quota.

Gemini admission settings leave Codex advisory selection to the requested roster and the non-Claude minimum.
Tests cover primary and shadow modes with each escape policy, quota holds, quota exhaustion, and cap skips,
all runner statuses through the real row builder and both reports, unavailable
budget storage, and reserving a second slot before a model retry at the cap.

`review-runner.mjs` appends each shadow prediction through `appendVerdict` as `verdict: observed`,
`mode: shadow`, boolean `wouldClear`, and `applied: false` / `mutated: false`. The builder and reader
reject shadow metadata on bearing verdicts. The existing non-bearing fold keeps these rows in history
without changing clearance, outstanding holds, review-round counts, or live label drift comparisons.
Append failures are reported best-effort on stderr and do not abort the shadow report.

Query the durable evidence offline with
`node scripts/lib/verdict-ledger.mjs shadow-agreement --repo=web-everything/web-everything --human-actor=nic --json`.
Use the exact declared human actor stored in your verdict rows. Without `--human-actor`, only the explicit
`clear-human` ceremony is a human outcome; with it, accepted/changes rows for that actor also qualify.
Declared attribution is not identity verification. `summarizeShadowAgreement` compares the latest preceding
prediction against the next qualifying human outcome for the same repo and PR, consuming each pair once.
It reports superseded predictions and unmatched pending predictions separately. This is PR-level outcome
agreement, not proof that two reviews covered identical content, and it does not enable enforcement.
`summarizeAgreement` retains its separate ledger-versus-live-label drift meaning.

Tests redirect `WE_VERDICT_LEDGER_DIR` and `CONVEYOR_JURY_DIR` into temporary directories and drive the
runner with a read-only `gh` fixture; a file in place of the ledger directory probes real append failure.

## Build-dispatch prepare retirement

A live daemon PID does not prove its prepare worker is live. Probe dispatch-entry `live`,
`expectedBy`, and `lastSeenLiveAt` independently: an explicitly dead session retires past its
expected deadline or after 20 minutes without a live observation. Settlement records
`prepare-session-dead`, clears the claim and guard, and increments `itemPrepareAttempts`
without double-counting a same-tick TTL retirement. Keep this outcome retryable rather than
turning it into a permanent `prepare-unstamped` hold on the next tick.

## Build-dispatch executor admission

Candidate executor prediction must call `decideDispatchRoute` with the dispatch loader's scope, size,
risk, tags and delivery-agent override, then `probationLaunchDecision` with the actual launch setting.
`routing.executed` alone is the fallback: an enabled probation worker can actually execute the build.
Test a real predicted external route with Claude capacity full, and preserve the run record's known
executor when deduplicating it with an earlier executor-less claim. The total own-item WIP cap applies
across both executor pools.

## Stacked PR check absence

`scripts/conveyor/reconcile-pass.mjs` treats complete required-check absence on a non-default base
as waiting for that base PR; an unowned base surfaces `stacked-base-orphaned`. Partial or truncated
rollups still hydrate. `WE_STACKED_PR_CHECK_POLICY=strict` restores the prior hydration behavior.
Replay #3915 with `scripts/conveyor/soak/breaks/stacked-pr-missing-checks-refused.soak.test.mjs`.
The review daemon tags stacks surfaced only in notes, and promotion clears `awaiting-base` via
`applyReviewStatus`'s shared status matcher.

## Constellation conveyor probes

Inject `exec` and `fetchOpenPrs` into `makeCliMechanicalPasses` to inspect each repo's argv
and snapshot lifetime without spawning workers. Review briefs select the checkout with
`--repo` on the pool `acquire`; release stays `--all-pools --session=<slug>` (it sweeps every pool).
The fix and review refusal writers preserve each other's actions in `unsupported-repo.json`.
CI history keeps WE's filename and adds the constellation key for sibling repos, including
when `CONVEYOR_CI_QUEUE_FILE` supplies the base path. Subprocess tests that use fake `gh`
still acquire the throttle lock; set `LANE_POOL_ROOT` to a temporary directory in a sandbox.

Daemon simulator worlds must override `WE_GH_THROTTLE_LOCK_ROOT` under their own temporary
root. Vitest's per-file override takes precedence over `LANE_POOL_ROOT` and otherwise shares
budget windows across worlds. A world that advances its clock can leave future-dated spend
that makes a later world wait; sibling daemons within one world should share its throttle.

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

## Proof-based verification — observe before you claim

The first rule of verifying anything here is **observe the real running system; don't reason about
what it probably does.** A diagnosis is a *finding* backed by output, not a plausible hunch. This
applies to every "does it work / why is it broken" moment, not just to written test files.

**The discipline:**
- **Reproduce against the live system first.** Probe what the user actually sees: `curl` the served
  HTML, drive a real browser (Playwright — see the recipe below), run the gate, `grep` the real
  output. Let the result name the cause.
  - **Ad-hoc Playwright recipe.** Node ESM resolves `import { chromium } from 'playwright'` relative
    to the *script file's* directory, **not** the cwd — so a script in `/tmp` fails even when you
    launch it from the repo root. Write the throwaway script **inside the repo tree** (e.g. a
    git-ignored `./.probe.mjs`), `node ./.probe.mjs`, then delete it. The first port is whatever the
    user named; otherwise probe 3000/8080 (WE) and 6000/6080 (FUI). Always capture `page.on('console')`
    + `page.on('pageerror')` so silent client-side failures surface. For "is the current page marked?"
    questions, dump each nav link's `aria-current` and class — don't eyeball the screenshot.
- **The render layer is not the server output.** A page can be in the DOM yet invisible because of
  client-side JS (a filter adding `is-filtered-out`, `display:none`) or persisted `localStorage`
  state. `curl` proves what the server *sent*; only a real browser proves what the user *sees*. If
  the claim is about visibility/interaction, the browser is the only valid probe.
- **"Cache / stale tab / hard-reload / it's just uncommitted" are hypotheses, never diagnoses.**
  They are the convenient explanations that *feel* right without a test. Rule each in or out by
  observation before you offer it. (Eleventy renders from disk regardless of git state — uncommitted
  is almost never why something is "missing"; the real cause is usually a render/wiring bug. The
  `/backlog/` type-filter once hid every `type: review` item this exact way — a one-`curl` find that
  three untested guesses missed.)
- **A probe can lie too.** If you guessed a selector, storage key, port, or fixture, the run may be
  inconclusive (it tested the wrong thing and "passed"). Say so — an inconclusive run is not proof,
  and presenting it as one repeats the original sin one level down.
- **When you fix a class of bug, add a gate guard and prove the guard fires** — reintroduce the bug,
  watch it error, restore. An untested guard is itself an untested claim. (Worked example: the
  type-filter-coverage guard in `scripts/check-standards.mjs` §10.) Note `check:standards` does **not**
  run the 11ty build, so render-layer bugs stay green-invisible — smoke template changes with a real
  build/probe too.

### Gates in git fixtures

When a publish gate runs the suite that tests its own caller, use a fixture-local npm script in the
temporary git repo to verify gate arguments and green/red handling without recursively launching the
suite. Exercise real subprocesses and git transport. Emit gate chatter in the fixture too: a CLI's
machine-readable JSON stdout must remain parseable when its child gate prints output.

### Passive-wait hook regression probes

Test Stop/SubagentStop with distinct parent and subagent JSONL files: SubagentStop prefers
`agent_transcript_path`, falling back to `transcript_path` only when absent; an unreadable or malformed
selected file fails open. Keep Monitor cases event-specific: any Monitor call plus passive-wait
language blocks SubagentStop, even with its immediate "started" result, while Stop permits it.
Agent/Task remain excluded for both events.
The PreToolUse Monitor guard denies only when `agent_id` identifies a subagent and leaves main-session
watches alone. Exercise each script through stdin as well as its pure decision functions; these
probes verify local decisions and wiring, not whether the upstream harness fires every hook.

### Nested CLI isolation probes

Establish an ordinary child CLI baseline before attributing failure to isolation. In #3371 Probe 10,
`codex exec` failed at app-server initialization and even Seatbelt's allow-all `true` control failed
at `sandbox_apply`; neither result tested doctrine exclusion. Parent-shell edits do not prove child
agent tools work. Deleting a tracked doctrine file also leaves it recoverable via `git show HEAD:AGENTS.md`,
which the same probe observed: distinguish automatic context exclusion from enforced read denial.
See [the commands and output](../../backlog/3371-probe-one-alternate-provider-against-the-judge-contract.md#probe-10--tool-bearing-doctrine-isolation-attempted-2026-09-10).

The dispatching session subsequently supplied successful unsandboxed baseline/deletion/tool-bearing
runs ([Probe 11](../../backlog/3371-probe-one-alternate-provider-against-the-judge-contract.md#probe-11--dispatching-sessions-unsandboxed-deletion-proof-2026-09-10)).
Attribute that evidence to its actual observer; do not repeat nested probes already blocked by Seatbelt
or describe supplied observations as locally reproduced. Root AGENTS.md deletion before child startup
prevents its automatic loading in that setup; it does not erase Git history or other instruction sources.
The `we:scripts/lib/isolation-provider.mjs` preparation port owns a disposable clone, not a process sandbox.
Await preparation before launch, preserve exclusive ownership until the child exits, collect results,
then await cleanup in `finally`. Injected-exec tests verify preparation mechanics, not model context.

**Correction — Probe 9's "no override flag" conclusion was wrong (#3371 Probe 12, 2026-09-11).** A real
Codex config override, `-c project_doc_max_bytes=0`, suppresses the CLI's automatic doctrine-file
injection, live-verified in both `-s read-only` and `-s workspace-write` (tool-bearing) modes, with real
tool use still working. It is weaker than deletion — the file stays on disk and a deliberate `cat
AGENTS.md` still recovers it, also live-verified — so `we:scripts/lib/isolation-provider.mjs` gained
`createConfigOverrideIsolationProvider` as a second backend alongside the deletion one, not a replacement.
Lesson for future nested-CLI probes: a probe that finds no override flag by trying one or two candidate
flags (`--ignore-user-config`, a bare `-C`) has not shown none exists — check the CLI's full `-c
key=value` config surface (`codex exec --help`, or grep the installed binary's embedded config schema)
before concluding a capability is absent.

### Hard rule — every verification must be agent-runnable; if it needs a real runtime, the harness is a dependency

A verification item is only *real* if an agent can **reproduce its proof mechanically** — run a
command, observe the result. "Verify end-to-end in a real browser / a real extension host / a real
device" is **not** a finished verification when no harness exists to drive that runtime headlessly;
it's a claim waiting on a human, and "I eyeballed it / I reasoned it works" is exactly the untested
guess the discipline above forbids.

So, as a **hard rule**:

- **If a verification's proof needs a runtime the standard tiers can't reach** — a real service worker
  / Background Fetch / push (happy-dom has none), a real VS Code Extension Development Host (Vitest
  never loads one), a real device sensor, a GPU, a secure-context-only API — then **the test harness
  that makes that runtime agent-runnable is its own backlog item, and the verification item carries a
  `blockedBy` edge to it.** Build the harness first; verify against it second.
- **Never claim a real-runtime verification you did not mechanically observe.** If part of a claim
  genuinely cannot be driven even with the harness (e.g. a network transfer that only survives in a
  flagged real profile), say so explicitly and file that residual — an inconclusive run is not proof
  (see "A probe can lie too").
- **The harness card's own DoD is a green sample** in that runtime (a trivial spec going green via the
  lane's command), so the harness itself is proven before anything depends on it.

This is why a card whose only remaining step is "verify in a real X" is **not agent-ready** until its
harness exists: at batch/selection pre-flight it reads as `blocked-in-fact` (a needed gate verified
absent) and the remediation is to scaffold the harness card and add the `blockedBy` edge — not to skip
the item, and never to mark it done off an un-run claim. Worked example: #675 (real SW + Background
Fetch) `blockedBy` #684 (the real-Chromium SW E2E lane); #676 (real extension host) `blockedBy` #685
(the `@vscode/test-electron` host harness).

## Pyramid

| Tier | Pattern | Runner | Env | Purpose |
|------|---------|--------|-----|---------|
| Unit | `*.test.ts` | Vitest | happy-dom | Single class/function, mocked deps |
| Integration | `*.test.ts` | Vitest | happy-dom | Multiple components together |
| E2E | `*.spec.ts` | Playwright (`chromium`) | real browser | User flows on the live demo |
| SW / durable-tier | `*.sw.spec.ts` | Playwright (`chromium-sw`) | real browser, **SW allowed** | Service-worker + Background-Fetch reload-survival |

> **Real-browser service-worker lane (#684).** Vitest runs under happy-dom — **no service
> worker, no Background Fetch** — and the default `chromium` E2E project neither allows SW
> registration nor serves a SW origin. A verification whose proof needs a real runtime (e.g.
> #675's durable-tier reload-survival) must depend on a harness that provides it. The
> `chromium-sw` Playwright project is that harness: it runs `*.sw.spec.ts` in a context with
> `serviceWorkers: 'allow'`, served by the zero-dependency static fixture server at
> `plugs/__tests__/e2e/sw-fixtures/serve.mjs` (http://localhost:3210 — a SW-capable origin
> sending `Service-Worker-Allowed: /`). Drive reload-survival via the reusable
> `sw-fixtures/rehydrate-helper.ts` (`assertSurvivesHardReload(page, task)`): register → arm →
> hard-reload → assert the worker re-hydrated. The fixture's Background-Fetch feature-detect
> honours `window.__forceNoBgFetch`, so the degraded (navigation-guard re-arm) branch is
> exercised deterministically. **Residual manual step:** a true Background-Fetch *network*
> transfer surviving reload may need a flagged/real Chromium profile — drive what headless can,
> document the rest as the one manual check.

### Locations
```
plugs/{module}/__tests__/unit/*.test.ts
plugs/{module}/__tests__/integration/*.test.ts
blocks/__tests__/unit/{group}/*.test.ts
blocks/__tests__/integration/*.test.ts
plugs/__tests__/e2e/*.spec.ts
plugs/__tests__/e2e/*.sw.spec.ts          # real-browser SW lane (chromium-sw project)
plugs/__tests__/e2e/sw-fixtures/          # static fixture server + SW/page + rehydrate-helper
```

## What to test where

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| New class/function | Yes | Maybe | No |
| Bug fix | Yes (reproduce) | If cross-component | If user-visible |
| New public method | Yes | If uses injectors | No |
| Parser | Yes | Yes (with registry) | No |
| Attribute | Yes | Yes (with DOM) | Yes (user flow) |
| Store | Yes | Maybe | If in demo |
| Demo feature | No | No | Yes |

## Quality guidelines
Real Git fixtures must pass `-c gc.auto=0 -c maintenance.auto=false` on their Git invocations.
A large seed commit can launch detached maintenance/repack that outlives `execFileSync`, racing
recursive snapshots and cleanup. Apply the same flags to bounded production freshness fetches;
do not hide the race with sleeps, cleanup retries, or exclusions from the snapshot.

1. Test behavior, not implementation.
2. One concept per test; descriptive names (`should notify listeners on setItem`).
3. Arrange-Act-Assert. Reset state in `beforeEach`/`afterEach`.
4. Mock external deps with `vi.fn()` / spies.
5. **Exercise default arguments by omitting them (#4412).** An exported function whose optional parameters have
   defaults (a clock, a sleep, a poll interval) needs at least one behavioral test that leaves those overrides
   out. Passing the default value explicitly does not test the default, and an immediate return never reaches a
   default timer. Required inputs are still supplied. Existing coverage counts; do not duplicate it for the
   sake of a new test name. Example: the default-timing case in `we:scripts/__tests__/lane-verify.test.mjs`
   (`waitForVerifySettle`), which omits `now`, `sleep` and `pollIntervalMs` and drives the real defaults under
   vitest fake timers.
6. **Integration-test a polling loop while its target changes (#4412).** A polling tool needs a case where the
   target moves from pending to terminal AFTER the loop has started, not only the start boundary (already
   terminal) and the timeout boundary (never terminal). Synchronize the writer to evidence that the loop is
   inside its first sleep, never a guessed delay, and assert more than one poll so a too-early update cannot
   pass as a first-poll success. Replace file-backed state atomically (write a temp file, then rename). Example:
   the running-to-green / running-to-red cases in `we:scripts/__tests__/verify-lane.test.mjs`
   (`check --wait=`), which hook the child's first 2000ms timer over IPC.

## Coverage
Enforced in `vitest.config.ts` — **80% minimum** for lines, functions, branches, statements over `plugs/**/*.ts` and `blocks/**/*.ts`. Excluded: `**/index.ts`, `**/__tests__/**`, `*.test.ts`, `*.spec.ts`, config files.

### Per-diff trust-chain branch floor (#2876)

`check:standards` runs the separate `diff-branch-coverage` check with an 80% floor
(`DIFF_BRANCH_COVERAGE_FLOOR` in `scripts/lib/diff-branch-coverage.mjs`). Generate
`coverage/coverage-final.json` with `npx vitest run --coverage` after editing source.
The default base is `HEAD` (staged + unstaged + untracked additions); for committed
branch changes, set `DIFF_COVERAGE_BASE` to the intended base commit, typically the
PR merge-base. The gate reports its base and does not fetch or guess a remote base.

Only added/replaced lines in `isTrustChainTier` files are attributed. Deletions,
empty diffs and changes outside the tier require no coverage report. Each Istanbul
branch outcome whose parent or arm range intersects changed lines counts once;
multiline ranges include body edits. This conservatively includes V8 function ranges.
An empty branch map is valid (no branches); missing files, malformed counters and
reports older than changed source fail closed. The timestamp check catches ordinary
stale local reports, but is not a source hash or provenance attestation: generate
coverage in the same checkout, after edits, and do not reuse copied reports.

The result says how many branches introduced or touched by this diff were exercised.
It does not establish implementation correctness or assertion quality. The existing
scoped-planes coverage thresholds remain independent.

## Commands
```bash
npm test                            # all unit + integration
npx vitest run blocks/              # a directory
npx vitest run path/to/file.test.ts # one file
npx vitest watch                    # watch mode
npm start                           # dev server (needed for E2E)
npm run test:integration            # E2E (Playwright)
npx vitest run --coverage           # coverage report
```

## Developing & manually testing in a lane

PR ownership regressions (#5649, #5675, #5647, #5664, #5628) live in
`scripts/conveyor/__tests__/pr-singleton-owners.test.mjs`. Reconcile (consumed by
both the review and fix daemons) and the conveyor tick share `ci-heal-rule.mjs`;
keep live green/pending evidence, the legacy `ci:failed` classifier guard and the
resolved CI-heal cap intact. A timeout retry without an Actions origin falls
through to CI-heal, and its diagnostic names that owner only when a heal is planned.
Withdrawn drafts surface through `needsPersonRow` with an operator release command;
they never auto-release. Missing review labels use the existing restoration pass.
Moved agent accepts use that pass's `stale-accept` variant, a live pinned diff read
and the existing accepted-only re-arm helper. Equal fingerprints, unreadable
fingerprints and human clearances must never be invalidated by this recovery.
No new thresholds are introduced: the existing CI-heal budget and
`WE_REVIEW_LABEL_HEAL` policy remain the controls.

Every edit — including an ad-hoc "just fix this one thing" — happens in an **isolated lane clone**, never the main checkout (#2123; the writer model in [platform-decisions.md#pr-flow-rollout-mechanism](platform-decisions.md#pr-flow-rollout-mechanism)). The lane trigger is *making an edit*, not *running a command*. The main checkout stays the human's — its dev server on `:3000`/`:8080` is theirs; don't build or serve into it.

**1 — Pick or provision a lane** (persistent clone pool under `~/workspace/.lanes/<repo>/lane-N`, git objects shared via `--reference`, own HEAD):
```bash
node scripts/lane-pool.mjs status --json     # per-lane path / head / clean / deps
node scripts/lane-pool.mjs provision --count=N   # create/refresh N lanes
```
Use a `clean` lane. `git -C <lane> reset --hard <sha>` to check out any local commit (shared objects — no fetch needed, works for un-pushed HEADs).

**2 — Boot the lane's OWN dev pair.** The `.env.local` port pair is **not auto-loaded** — export it first, or the servers fall back to the main band (`:3000`/`:8080`) and collide:
```bash
cd ~/workspace/.lanes/web-everything/lane-N
set -a; source .env.local; set +a        # sets WE_VITE_PORT / WE_ELEVENTY_PORT
npm run dev
```
Verify Playwright/curl against **that** lane's `WE_ELEVENTY_PORT` (the 11ty docs site) — not `:8080`.

**3 — The constellation render-siblings (#2166 → #2282 → #2349).** Every WE grid page SSRs through the pinned FUI build-artifact, resolved as a `frontierui` checkout *sibling* of the WE repo root — which a lane clone (`<pool>/lane-N`) has no sibling for, so `build:docs` and the 11ty dev-serve would hard-fail with *"pinned FUI artifact missing at …/.lanes/web-everything/frontierui/dist/tools/component-render/cli.mjs"*. `lane-pool.mjs provision`/`refresh` now provisions **real, pushable git clones** at the pool root (`~/workspace/.lanes/web-everything/frontierui`, `~/workspace/.lanes/web-everything/plateau-app`) — one clone per sibling repo, serving every lane at the same `../<name>` path. Each clone is fetched/reset to `origin/main` and rebuilt via its own `npm run build:tools` (where it has one — FUI does, ~1.2s; plateau-app doesn't, a plain clone is enough). You only need each sibling's PRIMARY checkout to exist locally (it's the source the pool-root clone's `origin` URL is derived from):
```bash
cd ~/workspace/frontierui && npm run build:tools   # optional — the pool-root clone builds its own dist/ on provision/refresh
```
If a sibling's primary checkout is missing entirely, provision warns and skips that sibling (the pool is still usable for non-render work). A pool-root sibling that is DIRTY or AHEAD of its own `origin/main` (real local state, now that it's a pushable clone) is left untouched on refresh, same as a lane (`--force` overrides).

**4 — Known lane limitations.**
- For rendering/screenshots, a **static build is most reliable**: `npx @11ty/eleventy --output=/tmp/site-X --quiet`, then `python3 -m http.server` in that dir. (This is how you diff two commits: build each into its own dir, serve on two ports, screenshot.)
- **Visual baselines**: `tests/visual/rendered-site-visual.spec.ts` (the snapshot-baseline spec, #2236) targets its OWN dedicated, Playwright-booted Eleventy server (`WE_VISUAL_FIXTURE_PORT`, default `:8099`) rendered from the checked-in frozen fixture set (`tests/visual/fixtures/backlog/*.md`, via `WE_VISUAL_FIXTURES=1`) — it needs no `:8080` at all, so it regenerates cleanly from ANY lane with no coordination or collision risk with the main checkout. The sibling `tests/visual/fui-card-cross-origin-render.spec.ts` is a live token-render check (not a snapshot baseline) and still reads `WE_ELEVENTY_PORT` (default `:8080`), so regenerate/run *that* one from a checkout that owns `:8080` (or the lane's own bound port, per step 2 above). To add a new frozen-fixture visual target, see the header comment in `tests/visual/pages.json`.

> **Visual-regression substrate is self-hosted Playwright, in-repo committed `-linux` PNG baselines — no hosted SaaS** (decision #2233, ratified 2026-07-09). The governing rule + rationale + evidence-gated escape hatches (Argos-as-review-UI-only #2233 fork 2; graduate-baselines-off-PNG #1967) live in [platform-decisions.md#visual-regression-substrate](./platform-decisions.md#visual-regression-substrate).

> **Skill/memory replay substrate is an ephemeral throwaway clone (`mkdtemp` + `git init`, `rmSync`), never the shared lane pool** (decision #2274, ratified 2026-07-09). Even testing the lane tooling itself uses a fabricated `LANE_POOL_ROOT` under a temp dir, never allocated production lanes; `--dry-run` is never the fidelity substrate. Full rule + rationale in [platform-decisions.md#skill-memory-replay-substrate](./platform-decisions.md#skill-memory-replay-substrate).

## Web Cases — protocol conformance fixtures
"Web Cases" are the source of truth for protocol conformity: live documentation examples **and** input fixtures for E2E conformance testing.
- **Directory**: `src/cases/<protocol-id>/`
- **Naming**: ordered — `01-registry-standard.html`, `02-edge-case.html`.
- **Format**: raw HTML fragments. ❌ No `<html>`/`<body>`/`div.wrapper`. ✅ Only the directive/component and its direct children.

**Mandatory coverage per protocol:**
1. **Registry Standard** — happy path using valid registry defaults.
2. **Visual Overrides** — inline slot/template customization.
3. **Parameterization** — passing args via attributes (`args-*`).
4. **Reliability** — error handling, timeouts, forgivable failures.
5. **Deferred/Lazy** — interaction with the loading/visibility Intent.

### Stale-state inventory

`node scripts/operations/run.mjs stale-state --json` inventories this checkout's active/preparing
backlog claims, its repository lane pool, and the configured operation run store. Read
`verdict.records` together with `verdict.gaps`; a failed source enumeration is never an empty-source
claim. Corrupt run records remain visible as unknown. Lane status preserves lease read/parse failures
as `readError`; the inventory retains each such lane as a lease record with unknown owner liveness.

`pidAlive` records the current probe of the recorded PID; `ownerPidAlive` drives the verdict.
The lease `pid` is the acquire CLI, not the agent, so leases without a durable `agentPid` have unknown
owner liveness even if their recorded PID is dead. Probes reuse `reconcile-pass.mjs#probePid`;
null/invalid PIDs and foreign-host PIDs remain unknown. TTL and run completion never prove death.
Claims do not normally record an owner or PID; the report preserves that missing evidence as null.

`hasUnsafeWork` reuses lane status cleanliness and supplements its behind count with a read-only
count of commits absent from local origin refs. No fetch occurs: remote ref freshness is a named
limit, and false is never cleanup authorization. Unassociated claims/runs have null work safety.
Age is milliseconds since the recorded acquisition/start time, or null when missing/unreadable.

The CLI normally persists runs and call telemetry even for compute-only operations. This inventory
uses the existing memory run store and omits the optional call logger to honor its zero-write contract.
All child git reads inherit `GIT_OPTIONAL_LOCKS=0` so status does not refresh an index. Cleanup stays
with supported manual lifecycle commands; never edit lease/claim files by hand.

## Builder prepare admission probes

The builder's `cliPlanTick` and `cliDispatch` must pass the same
`WE_MAX_CONCURRENT_LANES` override to their tick subprocesses. Otherwise the
second read can lose a planned prepare to capacity and report the original
build's `needs-prepare` hold. Probe both through `planTick`, `readTick`, and
`shapeDispatchRead` without applying dispatch effects. A refused prepare must
release its claim and discard its proposed guard so the next tick can retry;
only a claimed prepare guard's TTL retirement consumes the prepare retry budget.

## Dispatch eligibility reports

When the runner is alive but an item does not move, use
`node scripts/operations/run.mjs dispatch-eligibility --item=NNN --json` (omit `--item` for
all cleared queue entries). Supply the runner's `--bookkeepingFile=<path>` when available.
The report reuses `dispatch-lane-io.mjs#readTick` and `dispatch-lane.mjs#shapeDispatchRead`.
`verdict.items[].gates` records the executed short-circuit path; later gates were not evaluated.
`buildAdmission.selection` records the existing `selectClearedRows` / `clearedNotReady` checks;
`buildAdmission.gates` is `dispatchPlan`'s ordered build trace. A build hold can route to preparation
or PR repair; `buildAdmission.prepare` records `planPrepareSpawns`'s guard, existing-PR and lane checks.
The first blocking gate names the failing recorded condition, including that alternate prepare route. `markers` are observed values, not additional
admission rules: a missing `deliveryAgent` is not a refusal in this path, and an omitted
`deliveryTarget` resolves to `main`.

Attach the JSON, observation time, item id, and expected progress to a starvation bug filed
through the `file-item` operation. Preserve `guardsFrom`, dropped bookkeeping and unreadable
record counts: an incomplete observation must not read as a complete guard check.

Eligibility reads explicitly send `config.verbose: false` to the tick CLI: omitting it advances
and persists the runner's bounded diagnostic verbose window, even if liveness recording is disabled.
The prepare trace records `dispatch-paused` before its other gates so an unscoped item's build
`scope` hold does not mask the pause. Whole-queue shaping errors appear on the affected entry as
`error` with `eligible: false`; single-item invariant failures retain the CLI error contract.

### Standalone worker declines

No-change already-done reports must reach `planHoldRouting` before the decline prefix is added.
The shared classifier requires `spec already done on main: commit <sha>`; the worker verifies
Done-when against main and supplies that citation. Exercise the existing `landRoute` with a temporary
Git origin: assert `graduatedTo`, unchanged scope, unrelated-citation refusal, and launch-checkout
isolation. A bare already-exists assertion is insufficient and retains the decline path.

Standalone no-change builds (#4552): replay with an empty implementation diff and a launcher report (Codex `lastMessage` or Gemini `events.finalResponse`). Assert the Findings note and scope removal on disk, the `worker-declined` dispatch hold, and the router lease that prevents duplicate landing. The card stays open; the existing verified PR path parks it `review:pending`. Missing final text must exercise the same path with a generic finding. Codex `--json` can emit JSONL before its pretty-printed report: replay that mixed stdout, prefer the report, and fall back to completed agent-message events or a fresh lane log before cleanup. Gemini uses result responses or per-step agent-response deltas. Never reuse an untouched prior-run log. Blocker references in decline Findings are advisory (`possible blocker: #NNN`); prepare verifies them before setting `blockedBy`.

## Claude subagent usage

`node scripts/operations/agent-usage-report.mjs --session=<id>` extracts usage automatically from
Claude's persisted parent and child transcripts. Omit `--session` to use `CLAUDE_CODE_SESSION_ID`
with the cwd project slug; `--transcript=<parent.jsonl>` is the unambiguous cross-project form.
Run ingestion after the children finish: records are append-only snapshots, and a later scan of the
same agent does not update an earlier snapshot. This CLI does not install a scheduler or Claude hook.
It is suitable for a serialized session-end job; overlapping writers are not supported.

The script streams **every line** of each child, reusing `inspect-agent-health/agent-health.mjs`'s
project root, decorated-id handling and transcript resolver. `CLAUDE_PROJECTS_DIR` overrides that
root (set before module import). Sidecar `toolUseId` and parent `tool_result.tool_use_id` link the
actual `Agent` dispatch; structured `toolUseResult.agentId` or textual `agentId:` supplies the child
when the sidecar is absent. Task metadata prefers the sidecar description, then dispatch description,
otherwise null; raw prompts are never a fallback. Descriptions are capped at 200 characters, including
an ellipsis when truncated. Explicit child paths must resolve inside `PROJECTS_DIR` after symlink
resolution; outside paths (including sibling-prefix collisions) are rejected and counted in `skipped`.
The resolver compares against the physical project-store root while preserving `PROJECTS_DIR` for
diagnostics. ID-search candidates use the same containment check; escaping symlinks are skipped before
choosing the newest valid hit. Regression fixtures must include a deliberately symlinked store root:
realpath-normalized temporary roots alone mask mismatches between logical and physical paths.
Missing children and malformed transcript rows are counted explicitly.

The local sidecar is `.operations/agent-usage/<day>.jsonl`, covered by the existing `.operations/`
gitignore rule. Like `call-log-store.mjs`, its default root is the **script's checkout**, never cwd.
Separate physical lane clones therefore have separate defaults; set `OPERATION_AGENT_USAGE_DIR` to
one absolute directory to aggregate across them. Each timestamp day's `agentId` is the dedupe key;
no historical directory scan occurs on append. The first physical transcript line supplies the timestamp,
otherwise mtime does. For mtime-only transcripts, ingest after they stop changing so the day stays stable.

Records retain `task`, `modelTier`, `delegatedProvider`, `delegatedModel`, every `delegations` occurrence,
nullable `outcome`, `timestamp`/`timestampSource`, `agentId`, `sessionId`, transcript paths and `toolUseId`.
A single Claude model/provider is a string; multiple distinct models/providers are arrays so mixed runs
are not silently assigned to their last provider. `delegatedModel` is a `{command, model}` object, an
array for repeated invocations, or null for none. `delegations` additionally records the provider and
whether its model was explicit, the current script default, or unspecified. Codex's default comes from
its real exported `CODEX_MODEL`. Gemini's wrapper has **no pinned default**: it delegates model selection
to agy, so absent flags yield null, not a guessed model. The current Codex pin is a fallback inference,
not proof of the pin a historical checkout used.

Both command fields contain only the detected invocation's normalized argv, with content-bearing
`task`, `task-file`, `prompt`, `message`, `description`, `body` and `text` values replaced by
`[redacted]` (case-insensitive, both separate and equals forms). The result is capped at 300 characters,
including a truncation ellipsis. Shell wrappers and adjacent commands are not copied into this summary;
model extraction still uses the original parsed flags. Keep this transformation pure and redact before
capping: truncating raw content still leaks its prefix.

Only assistant `Bash` tool uses executing the named direct-task script count as delegation. The
conservative shell classifier understands literal script paths, node, common wrappers, shell `-c`,
quotes, comments, separators and heredocs. It does not evaluate shell variables, aliases or dynamically
generated commands. This counts recorded invocations, not proof that the external provider succeeded.
PR outcomes retain nearby text evidence for a created/opened/merged/rejected/closed PR or a bare PR URL;
these are best-effort transcript observations, not independently verified GitHub state or attribution.

`node scripts/operations/agent-usage-report.mjs --report --days=7` prints dispatch counts by exact
Claude model string, delegated provider and day. `--since=YYYY-MM-DD` is inclusive; `--days=N` includes
today in UTC. `--json` works in both scan and report modes. Each distinct model/provider observed in a
mixed dispatch receives one count, so category sums can exceed total dispatches. Missing models count
as `unknown`. Corrupt store rows are skipped and counted; scans also report corruption encountered in
target day files. Keep this unscored operational log separate from the committed delegation trial scorecard.

Tests under `scripts/operations/__tests__/agent-usage-report.test.mjs` create temporary project trees and
redirect the store. They exercise missing sidecars/children, full reads beyond the health helper's tail
budget, shell false positives, model changes, day rotation, reruns, corrupt rows and the actual CLI.

### Cross-clone numbering regression

`lane-drain-numbering.test.mjs` must exercise two separate repositories: a blocker numbered in
clone A, then a dependent landed in clone B with an empty local ledger. The shared `origin/main`
`bornAs` record supplies the fallback; local-ledger persistence alone cannot prove this path.
Unknown references report `in-flight` when a provisional item is visible in the checkout or a
local/remote branch tree, otherwise `unresolvable` (potentially dead, not proven dead: refs may be
unfetched). Dry-run returns the same diagnostics without changing numbering state. The fallback
visits explicit reference syntax, preserving bare birth-hash prose and `resolutionNote` quotes;
the older local-ledger blind-rewrite behavior is unchanged.

### Multi-repo check contract

`scripts/__tests__/multi-repo-checks.test.mjs` scans non-test JS/TS sources in
`scripts/conveyor`, `scripts/operations`, `skills-src/conveyor`, and `scripts/lib`.
The pure TypeScript-AST scanner ignores comments, checks repository scoping on gh
calls, and rejects duplicated constellation slugs. Specific exceptions live in
`scripts/lib/we-only-checks.json`; an exception with no remaining finding fails
with “remove this entry”. This is a Vitest contract, not a standards-gate rule.
The isolated parked-review workflow cannot import the shared table; its table is
pinned to `CONSTELLATION_REPOS` by `scripts/lib/__tests__/review-core.test.mjs`.

### Operator notification probes

Operator send-back regressions replay the whole PR thread, including a newer mechanical conflict bounce,
fix-end and advisory accept. `scripts/lib/operator-send-backs.mjs` owns resolution: trusted fix evidence must
explicitly name the request and a different head (short/full SHA spellings of the same commit do not count).
Acceptance labels alone never clear it. Evidence comments begin with a standalone `## Fix evidence` heading
or a standalone addresses marker (optionally preceded by `Head:`). Reviewer prose, blockquotes, fenced and
indented examples of those formats must never resolve a request, even from a trusted author. Keep evidence
markers in fixer prompts and replay quoted instructions through queue holds and verdict reduction. Verify the
complete comment reader retains URLs, and exercise planning, resumed prompts, review reduction, red-team
input fingerprints and both operator-queue entry paths. Unknown send-back heads remain open conservatively.
Partial operator-queue CLI copies load the send-back reader optionally, report import errors, and withhold
all readiness when it is unavailable. Notice retry receipts stay separate from thread-derived `noticedRungs`
and are scoped to the dispatch target, head and rung; a failed post must remain retryable.

`operator-notify` consumes only `operator-queue`'s `ready` rows. Tests inject the notifier,
including child CLI probes; never exercise real desktop delivery in this suite. Persisted
successes deduplicate until an item leaves NEEDS YOU; queue errors preserve all prior keys.
The operations IO fidelity gate requires the shared real-repo fixture even for filesystem
state: the notifier test proves its external state path leaves that checkout clean.

A core file that dynamically imports its CLI cannot await that import at module scope when
its CLI statically imports the core. A staged Node probe of that cycle exits 13 with unsettled
top-level await. Defer the import with `.then(...)`, and test both entry paths as subprocesses.

### Daemon worker risk routing

For the [daemon model rule](platform-decisions.md#daemon-claude-worker-risk), exercise
card loading through `readTick` and spawn argv: a pure router test cannot catch
`findItem` dropping frontmatter risk. Review daemon fixtures must inject both
`readPrs` and `readAgents` to exercise its shared PR snapshot; that snapshot carries
escalation reasons and touched paths into the session model selection.

### Explicit Claude spawn models

Operator rule (2026-09-29): every fresh daemon-launched Claude session must pass an explicit
`--model`; only `--resume` retains the existing session's model. `buildAgentArgv` refuses an
unresolvable model with `notApplied`. Its launch-kind table test covers every `LAUNCH_KINDS`
member, plus review/inspect, and the provider test checks that kind survives request narrowing.
Preserve routed choices; defaults use `workerTierFor` and `CLAUDE_SPAWN_MODEL_BY_TIER`.

### Automatic item-prepare retirement

Prepare claims reuse build claim locks and orphan PID classification, with the shared 15-minute heartbeat
TTL plus confirmed dead ownership (a known live worker still wins). Retirement reads the card from remote
main and checks this attempt's prepare PR; a failed read keeps the claim. Tests must cover stale run-store
rows and prior guards so a retired claim actually frees capacity. A completed unstamped result is held as
`prepare-unstamped`, including across daemon restarts and cooldown expiry; the hold clears when main carries
a valid `preparedDate`. An open PR's committed stamp is checked separately while it awaits landing.

Prepare result recovery: pass durable prepare holds into tick-core before candidate selection (including
its dispatch-lane re-read); filtering after its two-slot cap starves every later card. Held item guards
are excluded from capacity. Replay two held queue leaders plus two eligible successors. The daemon
uses `prepare-stamp-pending` for sectioned results and a detached lane worker to run `prepare-stamp`,
verify the committed stamp and submit via `open-pr --mode=label-on-green`; only missing sections retain
`prepare-unstamped`. Test fresh-main and existing-PR recovery, lane-local command paths, stale section
observations, resolved cards, failed stamps, freeze/dry-run, and a fresh Node `--bogus-flag` boot.

Duplicate-prepare guards must preserve recovery: cross OPEN/MERGED/CLOSED/no PR with main stamps,
sections and worker liveness in daemon-tick tests. An OPEN unstamped PR with a dead worker recovers
its stamp when sectioned and surfaces `prepare-unstamped` otherwise; a stamped OPEN PR awaits landing,
and a MERGED PR never triggers an unstamped retry. Keep replaced-stamp and live-worker cases pinned.
Offer two persistently refused candidates before a clean successor at cap two, across successive ticks:
refusals must not consume worker capacity. Missing, non-callable, throwing or malformed PR-list effects
must refuse dispatch. Reader integration fixtures must apply the actual search filters, including title-only
PRs outside `lane/`, `bornAs` branches, saturated shared listings, date-floor fallback and async prefetch.
Prepare launch fixtures, including grouped unit and soak scenarios, must supply `listPreparePrs: () => []`
when modeling no existing prepare PR; omitting the effect models an unavailable listing and refuses launch.
Every component search must be complete before its union can prove absence; cache by both identities.
When replacing a regression test, identify the replacement covering its original recovery behavior during review.


### Probation prepare validation and fallback

A prepare worker's clean exit is not a landable result. Require the substantive card sections, run
`prepare-stamp` in the acquired lane, and return a rejected stamp's diagnostic to the worker once
before abandoning. The #4325 regression produced 43 lines but lost them to the guarded writer's
locus-prefix validation; briefs must teach repository-prefixed code references. A no-diff result
must retain the worker's final explanation (#4322's old launcher log omitted it).

The build dispatcher reads durable `probation-launch` scorecard rows for WE `taskType: prepare`.
Two consecutive attempts without a PR activate `prepare-route-fallback`: subsequent prepares disable
probation and retain explicit Claude Sonnet argv. Re-reading history across ticks/restarts does not
reset this route; a newer successful probation prepare clears it. Test the diagnostic repair through
the parked-PR path, bounded refusal, and the daemon's dispatch environment as well as its route decision.

### Prepare launch evidence and brief boundaries

Standalone Claude prepares use `skills-src/conveyor/prepare-item-agent-brief.md`; probation's
runner reads `skills-src/conveyor/prepare-item-worker-brief.md`. Keep these separate: worker-only
instructions delegate stamping and publishing to a runner that standalone sessions do not have.
Dispatch success requires a persisted effect with a handle, never the planning verdict alone;
regress failed effects through the CLI reader and assert immediate claim release with the error.
Prepare retirement probes the worker handle independently of the daemon-owned claim PID.
A failed session listing remains unknown. The daemon's records live in the coordination
`build-dispatch-runs` store; scratch-started Claude transcripts live under dispatch project paths,
even after the session changes into a lane. Lane-only transcript searches miss those sessions.


### Builder postmortem accounting

Stream headless JSONL and match the first user message plus the dispatch attempt identity.
A session slug can be reused across attempts (observed for `conveyor-4341b`); join by
run/effect ID, worker UUID, implementation repo/lane and timestamps instead. Distinguish
preparation effects from build attempts: a `b` suffix alone does not prove a failed build.
Pair tool IDs and union their intervals before subtracting from wall time. Coalesce usage
by assistant message ID; split known external verify intervals from model/unobserved time
when a resumed transcript spans the gate. Tool `is_error=false` does not establish green
tests when output was piped through `tail` or a later report command succeeded. Intended
mutation RED runs and changed-input reruns are not waste. `lastSeenLiveAt` is not completion,
and `pr-opened` is not landed. Preserve unknown timings rather than converting them to zero.
The 2026-09-30 worked example and source offsets are in
`reports/2026-09-30-builder-postmortem.md`; operational metrics belong in the existing
`run-rating.mjs` / `run-scorecard-store.mjs` machinery, not a parallel history store.

## Prepare PR isolation

Prepare-item refs (`lane/<item>-prepare-item-*`) receive a fixed item-specific title from the open-pr producer,
never a commit subject. Other `-prepare-` refs (prepare-decision, prepare-stamp) are not guarded: decision
prepares legitimately touch research files. Its submission boundary fetches origin/main, checks the full three-dot diff
against the unique target card, rejects lane merge commits, and pins the observed source SHA before
calling pr-land. Observation failures refuse publication. Prepare agents acquire fresh origin/main
lanes and never merge another lane. Regression histories live in
`we:scripts/operations/__tests__/prepare-pr.test.mjs`.

Builder red-draft recovery: test the raw draft snapshot before normalization (the build-policy projection drops draft metadata). GitHub REST check-runs responses contain a `check_runs` array, unlike the bare arrays returned by annotations and pull files. Exercise that IO shape, author liveness, durable PR-level retry accounting, exact branch forwarding, and comment plus `blocked:needs-human` construction. The recovery pass runs before in-flight holds; dry runs never dispatch. `WE_BUILD_DAEMON_RED_DRAFT_MINUTES` defaults to 60.

## Prepare failure diagnosis and release

`we:scripts/conveyor/prepare-failure-policy.mjs` records evidence and cause per attempt in the
coordination-root prepare failure ledger. Only observed rate-limit/network faults permit two automatic
retries; wrapper errors, timeouts and missing output alone are unknown. Unknowns reserve a prevention
landing job once per cause and stay held. A pending/failed filing is not a landed card: inspect its
record and job output, never blindly respawn it.

Release through `we:scripts/conveyor/prepare-failure-releases.json`: cite the exact attempt, known cause,
report evidence and full fix commit. The daemon verifies the commit is in its own ancestry before
applying the data. A later attempt is not covered by an earlier release. Route entries use target
`route:prepare` and exact scorecard `handle:scoredAt` keys; every failed probation attempt must be covered
before the latched route returns. Neither elapsed time nor a later successful run clears that latch.
The incident report `reports/2026-09-30-prepare-failures-root-causes.md` distinguishes worker cause from
claim retirement: dead-session cleanup frees capacity but does not prove why authoring failed.

Prepare PR identity is shared in `we:scripts/conveyor/prepare-pr-match.mjs`: same-repo branches
accept one uniqueness letter after the card number (or `bornAs`), with the `WE #<num>: prepare`
title as a fallback. That fallback is refusal grade only (`isPreparePrFor`): it may refuse a launch,
never drive a write. The status reader, whose result drives retirement, holds and the stamp worker,
uses the write-grade `isLanePreparePrFor` (lane branch required). Test every write path with a
title-only PR outside `lane/` and assert no stamp, hold or retirement comes from it.
An ended attempt frees its prepare slot even while its PR is OPEN (that PR refuses the re-launch):
test cap-many ended OPEN-PR cards and assert a clean card still launches.
Probe OPEN and MERGED PRs without stamps: neither is an unstamped failure.
The launch guard must also run without a surviving claim, and refuse when PR listing throws.
Merged launch refusals measure age from `mergedAt`, falling back to `closedAt`, then `createdAt`,
under `prepare.mergedGuardHours` (default 24; 0 disables only the merged refusal). They apply even
without surviving dispatch history. Probe the time boundary with an injected clock, including a PR
created over 24 hours ago but merged 21 minutes ago. Scope drift on a recently merged prepare
records a "scope moved after prepare" note for the build step in the refusal and its persisted
bookkeeping; it must never dispatch another prepare within the window. A card the planning pre-scan
skips for that merge carries the same note and persists the same `prepareRefusals` record as a
launch refusal; assert both on the planning tick, not only on a merge that appears after planning.
A needs-you park in the newest ledger record refuses the launch while it is `held` and not `completed`.
Any one of three things clears it: a stamp on main (it completes the record, so a hand stamp resolves
the park), explicit `releasedAt`/`releasedBy` metadata, or a reviewed release of that exact attempt in
the releases store. Cover each clearing path, and an older park under a newer record, so an operator's
hand stamp never re-parks the card (the stale-reprepare livelock).
tick-core offers at most two item prepares and cannot see these launch refusals. The daemon keeps a
refused card out of the plan, and out of a clean lead's prepare group, for `PREPARE_REFUSAL_HOLD_MS`,
then checks it again. Build-backoff cards and group members in flight are held out the same way.
Every group member passes the same launch admission as its lead (`refusePrepareLaunch`); test a member
that was never refused before and has its own open PR. When nothing else tracks a card refused for its
own lane prepare PR, the daemon reads THAT PR once per refusal (`prNumber`). A finished but unstamped
result (open, with sections, no stamp, judged against the stamp a re-prepare replaces) goes to stamp
recovery, and later reads stay on that PR while its hold stands; anything else
stays a refusal that takes no prepare slot and places no hold. Test that capacity
rule with the REAL `planTick`, never a stub that offers more picks than the cap: two refused cards and
a clean third, across ticks.

Stamp-recovery reservations do not expire. A terminal recovery error is recorded in its dispatch log,
classified by the daemon, and cannot spawn again without a remaining transient budget or a cited fix.
A new starting marker prevents the previous failure from being mistaken for the newly running job.
Historical probation evidence can accompany an item release under its exact `probationAttempt` key;
this improves the recorded diagnosis but does not authorize a route release.

Red-draft inactivity in `we:skills-src/conveyor/build-dispatch-daemon.mjs` is measured from the later of the current head commit’s committed date and the builder effect’s `lastSeenLiveAt`. Never age recovery from PR `updated_at`: labels, check reruns and advisory notes refresh it without author activity. Replay a recent PR metadata update with old author evidence, and separately assert that a live author, a recent commit or recent live observation prevents recovery. Missing both usable timestamps fails closed.

### Preparation terminal handoff

Prepare probation launches carry the original dispatch run ID and effect key into the terminal writer.
A stamp on main invalidates prepare guards and holds before build planning; a positively live worker
still retains ownership. Probe with an in-flight run on disk, duplicate terminal delivery, a restarted
reader, and a stamped card at the next daemon tick. Held dispatch reads must not invoke the full planner.
Use the integration Vitest config for we:scripts/operations/__tests__/dispatch-lane-integration.test.mjs;
the default config excludes that file. Keep dead-PID and unknown-session crash recovery tests.

## GitHub spend regression probes

Use TOTAL App GraphQL counter movement over a named wall-clock window as the success metric.
Per-caller counter deltas include concurrent traffic and are not query costs. The metered read
queries in `we:scripts/lib/gh-metered-reads.mjs` include `rateLimit { cost }`; the throttle
records that response cost and a query hash without storing request variables or response bodies.
Historical ledger rows without cost remain estimates and cannot supply a measured per-shape projection.

Git-derived already-done results must preserve the body-disclaimer exclusion. Default GitHub
merge commits contain a title, not the original PR body; a potentially implementing match must
fall back unless that body is available. Older nonstandard merges are irrelevant only when git
ancestry proves they predate the item's creation (including its bornAs/JIT-number alias).
PR-limit fixtures should compare the existing authorship classifier over git's author, message,
and parsed co-author trailers, and assert no GitHub invocation on a successful git read.

Already-done CLI fixtures must run in their own git checkout: complete history proves zero host
calls; shallow history exercises the metered GraphQL fallback. Preserve exact stale-ID call counts
and cache replay assertions on that fallback. Keep the fake host's throttle store private so another
suite cannot consume its budget. Numbering fixtures likewise pass a private `lockRoot` to the real
mutex instead of acquiring the developer's shared drain lock.

### Dispatched conflict resolution

`we:scripts/conveyor/resolve-conflict.mjs` uses index stages only inside a lane clone with
an active merge. Probe with real conflicting repositories under `.lanes/<repo>/lane-<n>`;
assert stage 0 content and no unmerged entries (taking ours can leave no cached diff).
Redirect `WE_RESOLVE_CONFLICT_LOG` to temporary storage. Permission-denial completions carry
`denied`, hold for 60 minutes, and surface a `permission-blocked` note immediately; they are
separate from transient infrastructure failures and their retry streak.

### Direct heavy-run hook probes

The `heavy-enforce` guard requires admission even for one-file Vitest runs, `related`,
and direct `check-standards.mjs` execution. Use `node scripts/readiness/heavy-admission.mjs run -- npx vitest run <file>`
or the admitted `npm run test:unit -- <file>` / `npm run check:standards` scripts.
`WE_FULL_SUITE_OK` bypasses only full-suite selection, never admission. Guard tests should
assert the suggested command verbatim and probe stdin-to-stdout hook wiring; unrelated
allow-case fixtures must use admitted commands.

### Orchestrator responsiveness hook probes

`session.orchestratorMode` defaults to false and resolves through the shared policy cascade;
`WE_ORCHESTRATOR_SESSION=1` opts in. The Bash hook keeps policy diagnostics silent by default;
`WE_POLICY_CASCADE_LOG=1` logs the final effective value and source to stderr through the shared
cascade logger, and `WE_POLICY_CASCADE_LOG=0` silences it.
Subagent hook payloads (`agent_id`), dispatched agents, and marked daemon workers always resolve
false, even with inherited opt-in settings. `operator-session-bootstrap` currently records no
session ID, so it does not automatically enable this policy.

`session.orchestratorDelegateCommands` replaces the executable-prefix array declared in
`scripts/lib/orchestrator-session-settings.mjs`. Configure it in
`scripts/settings/orchestrator-session.json` (or platform preferences); an empty array disables
this delegation check. Match executable positions, including Node options before the script and
npm options before `run` or its script name. Heredocs fed to a shell (including `cat <<EOF | bash`)
are executable scripts and must be checked, as are shell here-strings. Unquoted heredoc bodies can
execute command substitutions even when used as data; quoted delimiters suppress those expansions.
Plain mentions and literal heredoc data stay opaque.
Probe hook stdin with both an interactive payload and a subagent payload sharing the same env.
The existing background-verification denial must still win in every session: delegate the work
to a background agent, which runs the command in its own foreground.

### Prepare queue admission

Operator decision 2026-10-06: prepare-family dispatches (`prepare`, `prepare-scope`, `prepare-decision`,
`prepare-item`, `investigate`) are gated by the same heavy-test queue budget (`queue-cap`) as builds. Each is
charged the rolling median of a prepare session's summed heavy holds (seeded with one selected run plus one
check:standards until three sessions are recorded). `WE_QUEUE_ADMISSION_PREPARE=exempt` restores the old
exemption. Review stays exempt.

### Ungated heavy-run observations

`we:scripts/conveyor/heavy-run-ungated.mjs` classifies executable/argv positions and walks
parent PIDs; shell command text alone is not proof that a heavy child started. Its sample
counts are observations across time, not distinct invocations. Exercise the sampler with
`--ps-fixture` and a private `--state-root`; health-watch fixture ticks never append their
synthetic process observations. For the tick's append path, supply a fake `ps` executable
through a temporary `PATH`: sandboxed hosts can deny real `ps` with “Operation not permitted”.
The CLI records that failure as an error sample, which does not count toward a breach.

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
A batching deferral stops new starts but lets existing children finish their locked admission checks.
Probe busy scheduling from round completion with room and an unqueued runnable PR, and full-interval
scheduling with a full queue or backed-off work. Never start a second drain for an active PR; a
wake that arrives during its run stays pending until the run ends, unless that run verified the enqueue;
shutdown must kill every child and prevent further starts. Inject all GitHub reads in these tests.

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

## Drain enqueue confirmation

Post-accept admission imports the review scheduler’s `redTeamOwedFor` and `redTeamEnabled` over
the exact repo/PR/head review payload; acceptance labels alone never establish an owed pass.
An owed pass waits for the trusted red-team result marker for the exact PR and live head. Replay both GraphQL `author.login` and REST `user.login` bot comments, plus untrusted
lookalikes. Persist red-team pending age and retry time per PR/head in queue state and preserve it
through follow-up writes. `drain.redTeamPendingBackoffSec` defaults to 300; a newly observed comment
can wake the head early. `drain.redTeamPendingMaxMin` defaults to 45; even during backoff, an accepted
head past that age must log a named health smell and recheck complete comments and run evidence.
A recorded or live pass still waits. With neither, request through an available review dispatch hook;
if unavailable, `drain.enqueueWhenRedTeamNeverScheduled` (default true) permits enqueue with a loud
“red team never scheduled” note and its source. The current drain has no standalone red-team request
queue, so it uses the fallback. Test restarts, head resets, request/fallback, policy provenance and
comment-read backoff before the deadline. Review jobs publish head-bound running/finished evidence
in the shared operations sidecar. Store the host, PID namespace (where available) and process birth time with the pid: a live pid
with a different birth time is a reused process, not an active red team. An unavailable birth-time
probe preserves the conservative liveness result. Normalize the birth-time probe to UTC and the C
locale in both writer and reader. A running status from another host or PID namespace stays held
until its result arrives; a local pid probe cannot prove a remote process has crashed. Replay both
cases, plus old records without birth-time metadata and finished records. Also replay acceptance
with empty status and run stores: labels alone still do not schedule work (#5439/#5443). The
persisted accepting run must hold admission before the job's first running-status write. Missing
or pruned run evidence remains the explicit label-only boundary, rather than an invented accept.
A confirmed send-back finding still holds during the result-comment → gate-label race. Queue
admission must also read the exact combined comment emitted by verdict carry: gate markers,
the carried marker and producer prose, then the re-keyed advisory. Test the real review job's
carry path, CRLF, stale/foreign/untrusted markers and malformed or quoted layouts. An operator's
later `clear-human` ceremony on the same head releases findings handed over at the round cap;
an ordinary accept, restamp alone, superseded clearance or ruling before the finding does not.
Preserve a proven ruling through chains of identical-contribution carries. Both paginated comment
reads (admission and clearance dedupe) allow 256 MiB with a timeout; exercise a thread above
Node's default 1 MiB using a real child process, retaining the complete thread and clearance stamp.
Queue removal probes must observe `isInMergeQueue=false` after `dequeuePullRequest`, and replay the gate and
drain backstop to verify one mutation and one reason comment. Include a PR missing `ready-to-merge`
from the unfiltered open listing, without a durable follow-up entry. Discover membership once per
sweep through the shared batched merge-queue reader before revalidating any individual PR. Assert
one discovery call and zero per-PR reads for 150 non-queued rows, for each send-back label shape;
mixed listings must revalidate only queued rows. Failed or incomplete discovery (including more
than 100 entries) skips the sweep and retries next pass, without an expensive per-row fallback.
Manual queue entries also follow the existing label policy; membership alone never authorizes a
dequeue without fresh labels. Table-test every gate outcome: only `sent-back` invokes removal;
`round-cap` stays operator-owned under the current ruling. Both safeguards resolve through
the `drain` policy cascade and default on; test off switches without using the host's live GitHub IO.

Queue enqueue tests must distinguish mutation responses from membership reads: a returned entry is
followed by GraphQL `isInMergeQueue` plus the judged head. The installed `gh pr view --json` does not
expose `isInMergeQueue`; use `readMergeQueueState`, not an invented CLI field. GraphQL errors (including
“already queued”), null payloads and missing entries are failures. An already queued PR is recovered
only by observing membership at the pinned head before mutation. Clearance comments follow confirmed
membership, with trusted live comments plus the shared follow-up state's `clearanceHead` deduping retries.
Failure counts/backoff live in that same state file; preserve them during follow-up writes. Exercise false
membership, conflicting refusal, transient backoff across restarts, threshold provenance and stamp recovery
with injected IO, never a live enqueue.

### Builder cap and prepare cooldown

`build.maxOpenPrsCounts` defaults to `builder`; `all` restores the earlier open-PR
population. The policy cascade logs the effective value and source. Builder provenance
is an explicit `lane/<card><optional-attempt>-build-*` or `lane/<card><optional-attempt>-prepare-*` ref (including hash identities)
or the mechanical delivery wrapper's body signature. A generic lane ref, fixer, or
Codex author does not prove ownership. The REST producer and normalized planner input
must preserve `body`; the producer-contract test pins that path. Existing card-only
and accepted exclusions still apply; scope and freeze-label guards inspect every PR.

Before finalizing prepare picks, inspect the actual planned picks using
`recentMergedPrepare`, shared with `prepareLaunchRefusal`. Add recent merges to the
planner's prepare exclusions and re-plan the same tick so the next candidate gets the
slot. Inspect selected group members before finalizing groups, refilling groups after
cooldown skips. Share the same lookahead budget between leads and members; never scan
the entire grouping pool. Bound it to eight distinct cards (at most 32 listing calls), leaving
the shared tick budget available for launch guards. Log the elapsed minutes and PR number.
Picks outside that window still pass the final launch guard. Replay a merge 20 minutes
ago with one slot and a clean second candidate; include grouped members, hash aliases,
guard-off, and older merges in the touched suites. Use the production reader in a tick
with more than 50 held cards and late-ordered picks; assert the picks launch without
listing-budget refusals. Also cover consecutive merged picks and group members beyond
the lookahead limit, with uninspected replacements still passing final launch admission.

### Build dispatch launch lifetime and prepare discovery

Dispatch confirmation consumes the real `run.mjs --json` envelope, not a synthetic full run. The
dispatch-lane envelope includes persisted effect receipts (`key`, `type`, `status`, `handle`, `error`);
an in-flight key alone does not prove a launch. Keep the serializer → daemon parser regression in
`build-dispatch-non-blocking-launch.test.mjs`. Live 2026-10-17, #4413/#4415 workers had PID receipts,
but the CLI omitted effects, making the primary confirmation falsely fail before live-session rescue.
The launch timeout was not involved. Both cards were real WE prevention stories scoped to lease-reaper tests.

Persist detached build launch failures before planning another launch in the same tick. Count unconfirmed
launches by card and launch base (the dispatch checkout HEAD, carried in the pending record); unknown
bases share a conservative bucket. At `build.unconfirmedLaunchMax` (2), hold for
`build.unconfirmedCooldownMin` (120) and expose a durable needs-you row with the card, base and last
redacted evidence. Both leaves use standard → platform `build` → tool `build` → environment
(`WE_BUILD_UNCONFIRMED_LAUNCH_MAX`, `WE_BUILD_UNCONFIRMED_COOLDOWN_MIN`), with source logging.
Replay two unconfirmed launches through detached settlement, restart, cooldown expiry and changed bases.
Attempt exhaustion takes precedence over the unconfirmed cooldown: replay mixed failures with the last
unconfirmed launch reaching the attempt cap, then verify the hold survives cooldown expiry until re-arm.
Guard the shared CLI/HTTP `outcomePayload` with secret-bearing dispatch error and handle fixtures;
new receipt fields require explicit payload assertions. Exercise raw producer envelopes too, since the
daemon parser must scrub effect errors and verdict reasons independently. Detached settlement must
redact stdout/stderr before truncating excerpts and attaching them to tick failure reasons. Decode
JSON string values before scrubbing; omit undecodable structured excerpts so escaped credentials
cannot return through the parse-error fallback.

Launch admission and launch confirmation do not prove delivery. Retain the build failure ledger across
both, including daemon restarts; clear it only after observing a delivering PR. Before releasing an
orphan claim, persist its failure so a failed ledger write keeps the claim. Regress the #4413 shape:
pending launch → confirmed run → dead worker with no delivery → backed-off retry → exhausted attempts.
Validate a build card against the fetched WE origin/main backlog before acquiring its claim; missing
identities are permanent card refusals, while an unavailable Git read remains a retryable observation:
the clone-wide `card-lookup-unavailable` code, never charged to the card's retry budget. Because history
outlives a launch, late-launch (quick-schedule) attempts are counted apart from real failures, and the
orphan pass keys its failure on the dead claim so a retried release never charges it twice. The ledger
keeps every key charged to a card, not only the last: orphan and fail-group records interleave every
tick while a release throws, and each must still dedupe its own attempt. Both key a dispatch on its run
row's start time (`dispatch:`), so the two paths charging one dead dispatch in one tick charge it once.
A run row can be unreadable on one pass and back on the next, so orphan adoption passes the claim
(`orphan:`) and the row as aliases of one attempt: any charged alias dedupes, and the new aliases join it.
Group member claims (`member:`) are aliases on both paths too: orphan adoption can release the lead claim
before the fail-group pass looks, but the member claims survive.

Prepare discovery searches each card's current lane identity, bornAs lane identity and title, then
unions the complete results. The title is searched under both ids: a batch published before numbering
names only the bornAs id, and its `lane/prepare-batch-<lead>-<n>` branch matches no per-id head search. Never use an unfiltered repository PR listing as the launch guard's proof
of absence. Cache component failures for the tick as well as successes. The prepare policy leaf
`maxPrListingCallsPerTick` defaults to 128, resolves through standard/platform/tool/env, and logs its
source; `WE_PREPARE_MAX_PR_LISTING_CALLS_PER_TICK` overrides it. Prefetch and lazy readers share the
same budget, including failed commands. A component at its result cap or a spent budget refuses only
that card. Test with over 500 unrelated PRs, all three identity forms, concurrency, repeated reads and
budget exhaustion. GitHub calls use the shared throttle in both synchronous and asynchronous paths.

### Nightly coroner health job

`nightly-coroner` is a detached health-watch job, independent of chat sessions and accounts.
`coroner.nightly.at` defaults to `22:17` in `America/New_York`; `coroner.nightly.enabled` defaults true.
Both resolve through standard → platform `coroner.nightly` → `scripts/settings/coroner.json`
(and health `config.json`'s `coroner.nightly`) → `WE_CORONER_NIGHTLY_AT` / `WE_CORONER_NIGHTLY_ENABLED`.
The health log records each effective value and source. Fixture and dry-run ticks never enqueue it.

A stable `nightly-coroner-YYYY-MM-DD` job ID and retained daily records enforce one job per ET night
without depending on health `state.json`. The next live tick catches up the most recent due night,
including before tonight's deadline after a restart; multiple missed nights coalesce into one extraction.
`coroner.nightly.laneWaitMs` defaults to 600000 and is passed to lane-pool's normal `--wait-ms`.
`attempts` defaults to 1 and has a hard upper bound of 1. Invalid settings fall back to 1;
persisted job allowances are clamped before reattachment without resetting their attempt counts.
`retryBackoffMin` (10 minutes) remains configured but cannot authorize an extra attempt. `deadlineEt` defaults to `03:30` on the following ET calendar date;
no attempts launch after that deadline, including late catch-up.
`runTimeoutMin` (default 30) caps each extractor CLI run; a run past it is killed and the attempt fails. DST uses New York wall time:
nonexistent deadlines expire at the first valid instant after the spring-forward gap; ambiguous
deadlines use the first occurrence. Pin ordinary, gap (multiple configured minutes), and repeated
wall times to explicit UTC instants in the named deadline tests.
Exhaustion or a missed deadline emits a deduplicated needs-you event and the `nightly-coroner-failed`
health smell, naming the job, last error and attempts. `alertAfterProbeFailures` (default 3) also
alerts on consecutive `nightlyCoronerJob` probe errors, including exceptions before a record exists.
This smell notifies in shadow mode. A successful probe resets the streak.
Earlier unresolved failed nights continue to contribute to `alerts`, `failures` and the
existing `nightlyCoronerJob` probe-error channel; a later successful night does not clear them.
The deduplicated current-night notification supplements that channel. Test this through the real job ledger and health tick, across a failed then successful
night and repeated later ticks; the `nightly-coroner-retained-failure` soak break preserves the incident.
Failure feed fields are scrubbed, sanitized and bounded before append; test the raw line with a
credential-shaped token, oversized text, line separators and bidi controls. Every configurable
behavior needs a valid nondefault value test asserting its observable effect, alongside fallback
tests. The named lane-wait and retry-backoff tests pin exact arguments and persisted retry times;
the fresh late-catch-up test asserts zero launches and lane acquisitions plus a deadline alert.
For alerts sourced from any persistent ledger, define and test when the active alert clears.
The next night's extraction still starts at the last successfully published cursor; retries recover
an existing report through its receipt rather than extracting twice. Never prune daily job records without preserving the once-per-night ledger.

The child leases a lane via the lane-pool CLI, runs its `coroner-extract.mjs` (which imports
`coroner-rounds.mjs`) with explicit `--since`/`--until`, `--json`, `--no-save`, and releases the lane in
`finally`. If present, `coroner-false-findings.mjs` is invoked with the same window and `--json`.
Both CLIs must declare every option in `coronerExtractorArgs`; a contract test runs that exact argv
through both real parsers, so the job and the scripts cannot drift.
Resolve both extractor filenames to physical paths before invoking Node: CLI entry guards may
compare argv with Node's canonical module URL, so a symlinked lane or script can otherwise exit
successfully without output. The `nightly-coroner-symlinked-lane` soak break exercises both CLIs
through real subprocesses, including report publication, lane release, and receipt recovery.
Extraction fixtures must inject `sweep` alongside `acquire` and `release` so orphan-lease cleanup
cannot invoke the real lane pool or be counted as an extractor subprocess.
The first window is 24 hours; subsequent windows begin at `nightly-coroner-cursor.json`'s `lastEnd`
beside health `state.json`. Cursor writes are atomic and follow atomic publication of the dated
`coroner-YYYY-MM-DD.md` in `handoffHome()`. The report carries a recovery receipt, so direct re-entry
can recover publication without extracting again. One `coroner-ready` line is appended to the existing
needs-you feed (honoring `WE_NEEDS_YOU_FEED`). No Claude session or judgment step is launched.

Run `nightly-coroner-*.test.mjs` under `scripts/conveyor/__tests__/` through heavy admission.
Cover ET boundaries and DST, persisted job adoption/catch-up, source logging, cursor continuity,
publication deduplication, real isolated extraction, and release without cursor advance on failure.

## Automated repair hand-offs

`review-set-label` and the red-team gate signal the local fix daemon after a successful
send-back. CI lifecycle/status writers use the same `scripts/lib/fix-handoff.mjs` wake
path after their existing classification; they do not classify failures a second time.
The mailbox survives signals during a tick; one-second file polling interrupts the plain
sleep without consuming native filesystem watchers, and the optional webhook sleep also checks the mailbox. `WE_FIX_HANDOFF_DIR`
provides an isolated mailbox for tests. A wake only schedules a normal pass; claims,
scope, host admission and attempt budgets remain authoritative.

The shared policy cascade resolves `fix.sendBackReservedSlots` (standard 1),
`fix.ciMissingAfterPushMin` (standard 10), and `drain.mergeableUnknownRepollSec`
(standard 20), independently through platform preferences, declared tool settings and
`WE_FIX_SEND_BACK_RESERVED_SLOTS`, `WE_FIX_CI_MISSING_AFTER_PUSH_MIN`, and
`WE_DRAIN_MERGEABLE_UNKNOWN_REPOLL_SEC`. The cascade logs the value and source in
daemons. Ordinary repairs cannot consume reserved slots, even after memory pressure
reduces the effective cap; a send-back still needs host admission.

The fixer pusher ensures `checking` and `status:awaiting-ci` exist before marking its new
head with them. Test an initially empty repository label catalog and a same-head retry;
`gh pr edit --add-label` refuses labels that have not been created. The existing
`ci-red-recovery-watch` missing-run pass re-requests absent CI after the configured
age (using a recorded fixer push time when available), retaining its conflict, claim, head and retry-budget guards. The drain re-reads
UNKNOWN listings before collecting head-bound context and also revalidates before
merging, waiting for the configured delay at most three times per read stage.

### Overlay dispatch launch timeouts

The real overlay dispatch smoke keeps its five-minute budget per attempt. Resolve
`overlaySmoke.dispatchLaunchRetries` through the policy cascade (default 1, allowed 0–1;
`WE_OVERLAY_DISPATCH_LAUNCH_RETRIES` overrides it) and log its source. Retry only a timeout
with no marker file, completion record, Claude session file, or transcript. Use a fresh
scratch store and session ID, retain both attempts' diagnostics, and report
“retried after launch timeout” on recovery. Assertion failures never retry.
The smoke opts into wrapper stderr capture and first-byte timing; missing output is
represented by `firstOutputMs: null`, not zero. Failure alerts retain the wrapper PID,
liveness at timeout, launch time, session/transcript presence, the error class and the path of
the 0600 file holding the last 30 stderr lines; the wrapper's raw capture is removed after each
attempt (see *Daemon entry boot smoke* above).
Exercise the launch with injected processes and isolated homes; wrapper output capture
also has a real Node-child probe in `worker-wrapper.test.mjs`. Run these suites through
`node scripts/readiness/heavy-admission.mjs run -- npx vitest run <files>`.

## Referral re-checks on the live head

`review.recheckCarriedReferrals` and `review.autoPolicyRespectsNotReal` default true in
`scripts/review-settings.json`, with standard → platform → tool → environment resolution and source diagnostics.
Historical referrals persist a `recheck` provenance marker and go through the existing mandatory review against the pinned live net diff;
changed or unavailable citations require re-check, never an inherited block. The reviewer must
check the condition asserted in the finding, including function replacements, resolved settings
and completed card splits or negative controls. Unchanged citation bytes alone do not prove a defect.
Auto-policy respects authenticated operator and counted reviewer not-real decisions across heads,
including exact claim copies with an empty or `(no file)` citation. Only proven changes at the
original citation permit another automatic block; unavailable comparison evidence refuses the write.
An interrupted re-check stays review-owned; auto-policy cannot replace its missing reviewer answer.
This protection is narrower than gate clearance: a policy skip never accepts a PR.

## False-finding coroner pass

`coroner-false-findings.mjs` reads PRs updated in the window (including older and closed PRs),
complete comment threads through the shared reader, and the shadow agreement store. It never advances
`WE_CORONER_STATE`; run it before the main extractor when using `--since=last`.
`coroner-extract` also includes it as `errorRates.falseFindings`, feeding daily `perf-snapshot` counts.
`WE_CORONER_NO_FALSE_FINDINGS=1` skips that census in the main extractor.

Confirm or override each rule guess using the ruling reason, the red-team Re-check, and a bounded
live-head probe when needed. Recorded `--cause` on `record-referral-ruling --ruling=not-real` takes
precedence; the writer also preserves the finding lens. Allowed causes are `diff-only-recheck`,
`stale-head-reraise`, `auto-policy-over-not-real`, `card-only-probe`, `config-prose`, `test-nit`, and `other`.
A repeated not-real on another head is a stale hint, not proof the newer finding is false for the same reason.
Report code and card-only separately and keep unknown PR types visible when file reads fail.

Counts describe source events, not unique defects: a fixer stand-down can overlap a ruling.
Unmatched agy findings are separately **unconfirmed**, never proven false by non-agreement alone.
Capped PR discovery and failed reads are explicit; do not present such a census as exhaustive or infer
false-findings / total-findings percentages without a matching denominator.
For each confirmed cause, name a prevention, rank by frequency and mark NEW or COVERED-BY using the
coroner's existing held-card checks. Daily summaries carry cause/lens/seat/PR-type counts plus the
separate shadow count and read completeness.

### Review seat timing

Review-pr run records retain `seatTimings` per attempt: seat, lens, provider, model,
ISO `startedAt`/`finishedAt`, verdict and findingsCount. Parallel seats persist at launch
and settlement, before declared-order reduction; retries retain separate start instants.
Extra-seat groups share their model call's instants. The speculative red team retains its
model call times through finish/discard, excluding sink wait and the subsequent re-check.
A cancelled call has no observed finish. `node scripts/operations/review-seat-timing.mjs`
reads the existing runs folder without migration or writes; `OPERATION_RUNS_DIR` overrides
it. `--since=<iso>` selects runs by earliest seat start. Incomplete runs are shown but
excluded from median, nearest-rank p90 and the >5-minute early-change share denominator.
Legacy runs without seat observations are omitted; absent times are never reconstructed.

### Scope-only prepare re-validation

The builder may send an individually dispatched `prepare-stale` card through a light
re-validation before full preparation, only when the hold says scope changed (age
holds still require full preparation). `prepare.lightRevalidate` defaults to true;
`prepare.lightRevalidateMaxDiffLines` defaults to 400. Both use the prepare policy
cascade and source logger, with `WE_PREPARE_LIGHT_REVALIDATE` and
`WE_PREPARE_LIGHT_REVALIDATE_MAX_DIFF_LINES` environment overrides.

The prepare runner supplies the existing card sections and the scope diff from
`preparedAgainstSha` to the pinned main base to Codex sol at low effort. The worker
must return JSON `{ "verdict": "still-valid" | "needs-reprepare", "reason": "one line" }`
and leave the checkout unchanged. Only `still-valid` allows the runner to append
`revalidated: <reason>` and refresh the sanctioned stamp. Missing evidence, invalid
answers, disabled policy, and diffs above the cap use full preparation. A worker
that changes files, HEAD, or hooks is refused. The worker runs in Codex's `--review`
read-only sandbox with no network; that sandbox is the guard for edits deep inside
collapsed ignored directories such as node_modules. As a second check, a fingerprint of
the gitignored entries git lists (content for files up to 1 MiB, mode/size/mtime for
collapsed directories, so only adding or removing a direct child shows there) is
compared after the run. A change escalates for a human because a discard does not
restore ignored files.
Re-stamps use the existing verified
card-only prepare PR lane; the builder waits for the stamp to land on main before
building. Light candidates are excluded from grouped prepares so each verdict
covers exactly the card and diff inspected. No direct write to main is permitted.

Regression coverage must pair dispatch eligibility with age-stale and policy-disabled
false cases, and exercise light candidates in both group-lead and group-member positions.
Drive each read-only refusal guard independently (card text, HEAD, hooks, ignored files, and numstat),
asserting discard and no stamp, commit, or PR. A failed stamp after `still-valid` must
retry full preparation with the original dispatched provider, model, and effort; the
result's scorecard and PR attribution follow whichever worker completed preparation.
The light worker bypasses the router, so it applies the router's admission itself: a
critical miss on its exact provider/model/prepare triple, an active provider quota hold,
or an unreadable trial history skips it for full preparation by the dispatched worker.
Prompt evidence uses the shared `fenceUntrusted` helper and `FENCED_DATA_RULE`; test
closing-tag injection in both the card and diff, including mixed case and whitespace.

## Drain CI pre-stage

The drain caches non-CI gate dispositions for accepted pending heads carrying `ready-to-merge` in coordination storage,
bound to repo, PR and head. Green check events may consume this preparation before listing;
head, label, body/base changes and TTL expiry require the full fast drain. So do the live fields the full
classifier reads that move no cached signature: a `CHANGES_REQUESTED`/`REVIEW_REQUIRED` review decision,
`mergeable` other than `MERGEABLE`, and a merge state other than `CLEAN`, `UNSTABLE` or `BLOCKED`. The required
set is GitHub's queue-required checks plus the drain's own `--check` (`prestageRequiredChecks`): a failed selected
check is never prepared, and the green event re-checks the `--check` it was invoked with. It reads that check
through the same full read as the listing (`resolveRequiredCheck`, past gh's 100-context rollup cap); a failed
full read falls back. Every required
context needs its own successful row before enqueue; missing, pending, cancelled and red
contexts never authorize enqueue. A newly failed optional CodeQL check also vetoes admission when
`drainBlocksOnCodeQL` is enabled. Red-team evidence and the complete comment thread are re-read at enqueue;
the cache never substitutes for live release-label or red-team authorization. `checking` alone is ineligible,
including at the event wake boundary. Cached admission also reads the live fix claim before admission and
again inside the locked enqueue callback: a claim acquired while waiting for the lock must still veto enqueue.
`enqueuePrestage` owns that in-lock re-read (`fixClaimHeld`), the cascade's pre-landing steps (`beforeEnqueue`:
the review-coverage notice and the stacked-PR retarget) and the post-enqueue ledger facts (`recordLanded`,
the same recorder the cascade calls after a confirmed enqueue: exemption, restamp, drain-hold release); it
refuses the shortcut when any of them is not wired.
Check-event marks lack required-context identity and head SHA: preserve pending wakes on non-success marks,
then let the live required-check read drop red preparation. Coupled candidates, manifest-carrying heads and branches requiring preparation
keep the full cascade. Keep pre-stage tests separate from ordinary classification tests:
preparation may evaluate the remaining gates while CI is pending, but must leave the real
merge cascade before any enqueue. Regression home: `scripts/lib/__tests__/drain-prestage.test.mjs`.

Pre-stage regression contracts (PR #5480): every enqueue entry point must cover throwing mutations
(including required-workflow, conflict and unreadable-state failures). A shortcut refusal drops its cache
and falls back without installing backoff that hides the error from ordinary cascade recovery. Keep
table-driven coverage of every GitHub check conclusion at the `enqueuePrestage` boundary (not only at
preparation), missing release labels, evidence added after
preparation, optional CodeQL failures, coupled candidates and branch preparation. Include claims acquired
after preparation, unreadable claim readers, and exceptions propagated through an async lock. The CLI fixture must
assert pending manifest candidates cause no head writes or review writes, including a stale acceptance.
The provisional `merge` disposition is used only to evaluate gates: collision healing, manifest rebuilding,
review-label provisioning, clearance carry, baseline/ledger writes, parking and skip comments must suppress
writes for `prestagePendingCi`; the actual merge set excludes these candidates.

Source-contract tests for review writes must follow `candidateDryRun` and assert that it includes both
`DRY_RUN` and `prestagePendingCi`. Queue fixtures must record membership only after a successful enqueue
response; recording a refused mutation as queued masks the ordinary recovery attempt with an idempotent success.

Prevention follow-up owed by this review: add an enqueue-call lint that recognizes both enclosing
try/catch and callbacks protected by `enqueuePrestage`. It must flag unprotected `mergeStrategy.enqueue`
calls without treating the protected callback as an uncaught call. The throwing-entry-point regression
contracts above are the immediate guard; the repository-wide lint remains separate tooling work.

The green-event shortcut must honor the full drain's resolved `--repos` / `--this-repo`
selection and exact `--label` / `--base` filters before consuming preparation. The listing and the
shortcut share one selection predicate (`operatorSelects`), so a new filter cannot reach only one path.
CLI regressions must pair excluded scopes (WE#42 under `--repos=frontier-ui/frontierui`, including the short
repo alias, cached main preparation under `--this-repo --base=release`, and cached `ready-to-merge`
preparation under `--label=other`) with matching scopes that still enqueue without listing. Excluded
repo/label/base scopes preserve preparation. A green mark that arrives while its PR's fast drain runs
must wake it again after that run (`enqueue-on-event.test.mjs`, "pre-staged green events").

## Review scratch disk retention

Review seats use independent shallow pinned checkouts: a released lane's objects cannot be
borrowed safely across reset/GC. Own the scratch immediately after allocation, clean failed
setup as well as the run's `finally`, and register catchable signal/exit cleanup. SIGKILL and
host crashes require the health-watch backstop. Ephemeral review paths bypass the persistent
backlog index to avoid a full snapshot for every seat.

Signal cleanup stops seats before deleting their checkouts. Direct-task wrappers receive
SIGTERM so their handlers can kill the models' separate detached process groups; cleanup
waits for wrapper close. After ten seconds, a stuck wrapper and its observed descendants
(including detached model groups) receive SIGKILL, with one further second to observe close.
Unknown descendant observation or failure to close retains scratch for recovery. The outer
timeout follows the same stop path. Re-check jurors are tracked too. Repeated signals cannot
interrupt that wait or start another seat. Speculative cancellation holds new seats only
until the cancellation finishes; process termination permanently stops further launches.
A synchronous process exit requests shutdown and retains any checkout whose stop cannot
be awaited. Retention survives callers' `finally` blocks for the health-watch sweeper.
Ownership metadata lives at the sibling `<scratch>.owner.json`, outside the pinned worktree,
so a tracked `.we-review-owner.json` cannot block checkout or forge the owner PID. Normal
cleanup and the sweeper remove the sibling metadata together with its checkout.

Each health-watch tick sweeps `we-review-seat-*`, `we-red-team-recheck-*`, and
`we-overlay-dispatch-smoke-*` older than
`config.json`'s `tmp.reviewSeatTtlMin` (120 minutes), preserving live owner PIDs and process
working directories. Allocation and recovery share the review prefix constants. Busy cwd
observation runs once only when an expired candidate needs it; unknown observation preserves
checkouts. It also caps all
`we-backlog-index-*` files together at `tmp.backlogIndexMaxMb` (2048 MiB), oldest first.
Sweep logs include counts and bytes freed. Symlinks are never traversed.
The `disk-space` smell probes available space on the checkout's writable data filesystem:
warn below `health.diskFreeMinGb` (30 GiB), critical below 10 GiB. It opens immediately,
notifies in shadow mode, and sends an opening event through the needs-you feed's serialized
publisher. Host, subject and opening time identify each event, including reopenings within
the same minute. Fixture state roots and dry runs never publish these events.

### Tests-first delivery settings

Prepared open cards must replace the Acceptance scaffold's `TODO: a command` with executable
acceptance, one `[A<n>] Executable` line per guarantee. Unprepared cards remain exempt. Builders
run and record failing acceptance tests before implementation, make their first commit contain
only those new or updated tests, and report the named tests' red-then-green results. Reviewers
map every stated Acceptance guarantee to a named test and report missing mappings as findings.

`build.requireExecutableAcceptance`, `build.redFirst`, and `build.guaranteesMapToTests` default
ON. They resolve through the shared policy cascade: standard → platform → repository
(`scripts/settings/tests-first.json`) → environment (the `WE_BUILD_*` names documented there),
with each source logged. Dispatch strips disabled brief sections. The verify step's first-commit
check applies to build lane branches and delivery leases on local `main`, and warns if no test was added or updated; this advisory
cannot prove a red run. Git-read errors are reported as unknown rather than evidence of compliance.

### Drain pass-start PR batching

`drain.prState.batched` defaults true in `scripts/settings/drain-pr-state.json` and
resolves through standard → platform `drain.prState` → tool → environment
(`WE_DRAIN_PR_STATE_BATCHED`). The drain logs the effective value and source each pass.
A single aliased GraphQL query (with open-set pagination when necessary) supplies
body, files and commits; existing live listing pages already batch the light state.
Batch heavy fields must match the live listing's head and update stamps. Failed
batches, missing PRs and nested connection overflow retain the original per-PR
reads. Pre-merge and pre-label-write reads stay live. PR-events remains wake-only;
its facts companion's existing freshness rules are unchanged.

Keep nested author windows bounded: 100 PRs × 100 commits × 100 authors exceeds
GitHub's node ceiling before a query runs. Overflow must use the original reader,
never truncate evidence. The focused regression is `scripts/lib/__tests__/drain-pr-state.test.mjs`;
run it through heavy admission.

### Drain recovery across review timing and clone selection

A panel seat being owed is policy evidence, not proof of queued work. For an already
accepted pinned head with no red-team attempt/result, the drain may request the ordinary
review dispatcher only after proving no review job is active or queued. Unknown job
reads keep the hold. Card-only producer settings and both seat kill switches still
apply; request failures use `redTeamRequestCooldownMin`, and a successful request never
substitutes for a usable result. The existing review-daemon consumer pins the request
head and retains its dispatch refusals.

Do not assume the drain's DATA clone is fresh: on 2026-10-18 the log selected
`lane-1 (no-overlays)` while that checkout was 367 commits behind and its sibling CODE
clone was current. The operator CLI fallback refuses when cwd resolves to that same
stale checkout. Acceptance restamps select `DRAIN_DAEMON_WE_CODE_CLONE` (default:
`code` beside `DRAIN_DAEMON_WE_CLONE`) when present, preserve the target repository cwd,
and still run the CLI's freshness refusal. Regression homes are
`drain-merge-strategy.test.mjs`, `merge-ai-prs-restamp-local-repo.test.mjs`, and the
existing review-daemon request and operator-fallback suites.

## Prototype guard audit verification

Prevention filing pauses return `ok: false` with `skipped: true`; CLI adapters
return nonzero and never record a filed card. Nightly coroner attempts have a hard
maximum of one, including direct job config. Earlier failed nights remain in both
the failure ledger and health-watch's existing probe-error channel. CI-heal requires
a definitive red rollup; a red label alone cannot authorize dispatch, and tick
retains its green-at-open provenance. Round-history metadata retries a head mismatch
at most three times and preserves comments already read even if metadata remains
unavailable. The focused regression suite is `guard-audit-regressions.test.mjs`.

The Also-raised-by card resolver uses `recoveryPushContext`
from `missing-run-push.mjs`: the owner installation token or a validated recovery
credential is required. Pushes pin `WE_CI_PUSH_TOKEN` and clear inherited `GIT_*`
configuration; `gitRun` must use `inheritEnv: false` for that exact environment,
otherwise its normal merge with `process.env` restores the rejected configuration.
Standalone red-team producers write `running` before the model call (best effort)
when recording and posting are enabled. Card rebase skips, errors and throws all
spend the existing unowned rebase cap. Nightly failure scans retain failed records
of every kind alongside the nightly-only deadline check.

## GitHub App daemon fallback probes

Daemon auth uses a 30-minute refresh lookahead (interactive callers keep 10 minutes).
Keep the legacy App cache fresh while it remains the last role fallback; its best-effort
refresh must not change the selected role, applied token provenance, or recorded outcome.
The standalone gh shim recognizes `WE_GH_DAEMON_CALLER` and launchd labels under
`com.we.` / `com.plateau.`. A daemon cache miss gets one synchronous refresh CLI attempt
(90-second timeout), then refuses personal auth by default, including after an App 401.
Only an inherited `GH_TOKEN` with matching `WE_GH_AUTH_TOKEN_HASH` is trusted as App auth.
`ghAuth.personalFallback` resolves default → platform → tool →
`WE_GH_AUTH_PERSONAL_FALLBACK`; refusals and explicit allows name the effective source.
Interactive shells retain their inherited-auth behavior. Dispatched shim settings carry
the daemon marker even when session spawning does not inherit the parent environment.

Exercise these paths with synthetic cache entries, fake gh/refresh executables, isolated
homes and ledgers, and injected minters. Cover `chalbert/web-everything` via `-R`, REST
paths, and a real temporary clone's SSH origin: each selects the worker installation for
canonical owner `web-everything`. Run the touched `gh-app-shim`, `github-app-auth-env`,
`github-app-per-owner-routing`, and `github-auth-policy` suites through heavy admission.

## Drain enqueue confirmation

Post-accept admission imports the review scheduler’s `redTeamOwedFor` and `redTeamEnabled` over
the exact repo/PR/head review payload; acceptance labels alone never establish an owed pass.
An owed pass waits for the trusted red-team result marker for the exact PR and live head. Replay both GraphQL `author.login` and REST `user.login` bot comments, plus untrusted
lookalikes. Persist red-team pending age and retry time per PR/head in queue state and preserve it
through follow-up writes. `drain.redTeamPendingBackoffSec` defaults to 300; a newly observed comment
can wake the head early. `drain.redTeamPendingMaxMin` defaults to 45; even during backoff, an accepted
head past that age must log a named health smell and recheck complete comments and run evidence.
Past the deadline the PR stays HELD: it never enqueues without a red-team result. `redTeam.deadlineAction`
(`requeue-then-hold` standard, or `hold`; env `WE_RED_TEAM_DEADLINE_ACTION`, source logged) decides whether a
missing pass is first re-requested once through an available review dispatch hook (its own full wait), then the
drain logs the hold and publishes one `red-team-deadline-held` needs-you note per repo/PR/head. A recorded or live
pass also holds with the note. Release needs a result on that head, a proven-identical carry, an operator ruling
through the red-team ruling path, or a card-only diff. The retired `drain.enqueueWhenRedTeamNeverScheduled` is
ignored; only the operator's env `WE_RED_TEAM_DEADLINE_ACTION=merge-without-result` with a named
`WE_RED_TEAM_DEADLINE_OVERRIDE_BY` enqueues without a result, logged on every use. Test restarts, head resets,
request-once (a refused or throwing hook is tried once per head, then holds), note dedupe and failed publication, policy provenance and comment-read backoff before the deadline. Review jobs publish head-bound running/finished evidence
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
`attempts` defaults to 3; the daemon retries the whole run with exponential backoff starting at
`retryBackoffMin` (10 minutes). `deadlineEt` defaults to `03:30` on the following ET calendar date;
no attempts launch after that deadline, including late catch-up.
`runTimeoutMin` (default 30) caps each extractor CLI run; a run past it is killed and the attempt fails. DST uses New York wall time:
nonexistent deadlines expire at the first valid instant after the spring-forward gap; ambiguous
deadlines use the first occurrence. Pin ordinary, gap (multiple configured minutes), and repeated
wall times to explicit UTC instants in the named deadline tests.
Exhaustion or a missed deadline emits a deduplicated needs-you event and the `nightly-coroner-failed`
health smell, naming the job, last error and attempts. `alertAfterProbeFailures` (default 3) also
alerts on consecutive `nightlyCoronerJob` probe errors, including exceptions before a record exists.
This smell notifies in shadow mode. A successful probe resets the streak.
Only the currently due night's job contributes to `alerts` and `failures`; retained failed nights
remain historical ledger entries and feed events. Advancing to the next night clears their health
episodes. A terminal job failure does not count as a supervisor probe error or emit a second probe
failure event. Test this through the real job ledger and health tick, across a failed then successful
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


# Testing — Three-Tier Strategy

> Authors: APPEND new sections at the END of this file, never right after the title (`.gitattributes` union-merges it, but appending avoids overlapping insertions).

## Human-only enqueue approval license (R212)

`human-only-enqueue-license.test.mjs` uses local Git repositories to exercise exact clearance,
the shared numbering proof, and main merges whose sensitive blobs match `origin/main`.
Admission reads complete comments and live head/labels; missing or unreadable evidence retains
the human hold. Successor proof is read-only, with 8 MiB per Git output and 1024 changed paths;
exceeding either limit asks the operator to re-approve the current head or queue it.
`drain-merge-strategy.test.mjs` covers the setting-off refusal and best-effort `needs-you` event.
Run these and `merge-queue-enqueue.test.mjs` through the host heavy-admission queue.

## Direction-aware operation evidence (R131)

In-process review callers import the pure shape derivation from `scripts/lib/review-shape.mjs`.
Keep CLI evidence loading outside that module: unknown dynamic imports make daemon/promotion import
closures incomplete and force conservative restart, smoke and staleness fallbacks.

Shape shadow evidence must preserve every current file-only shape field. Pass hunks through the scorer's
`proposalDiffHunks` input so the proposal proves changes against the historical hold and sensitive hits;
clearing the hunk-aware gate alone cannot clear the proposal. Self-contained read-only import and registration
wiring can be proven; stored-array additions retain human review without consumer evidence, even beside
provable wiring. A harmless comment retains the hold with a `no new op reference` reason. Classifier
self-changes retain proposed human review even when the current gate did not fire.
Diff lines over 2000 characters require human review before parsing expressions.

PR-head modules are untrusted data: never import them into the reviewer process, even in shadow mode.
Read-only proof first requires an explicit IO audit in `read-only-ops.mjs`: only `heavy-queue`
and `pr-reconcile` are currently admitted. Compute-only declarations alone cannot prove purity:
injected IO can execute arbitrary commands, as `verify` does in run mode. Audit every mode before
admitting an operation; unaudited operations retain human review. The verify regression exercises
its real `createChecksRunner` with an injected spawn, then checks loader exclusion and live scoring;
a separate regression rejects another unaudited compute-only operation with complete byte evidence.
Proof also uses the reviewer checkout's registry and unchanged declaration plus every runner-imported `-io.mjs` module and their closures, regardless of operation name; new or
unreadable operations retain human review. `direction-aware-shape.test.mjs` probes a top-level host-write
attempt in native Node, dependency tampering, and live-mode holds on registry/step-kind changes.
An operation reference in hunk context never proves allow-list membership: moving a write-capable
import into `zeroWrites` beside a read-only addition must retain human review in live mode.
Standalone entries and complete named arrays retain human review: insertions can change positional or
length-based write guards regardless of an array's name, freezing, or neighbouring entries.
Total diff text over 200000 characters retains human review with an oversized-diff reason.
Removal matching consumes indexed normalized-text buckets while preserving same-hunk ordering.
Allow-list additions accept only balanced import/registration wiring or
balanced re-adds preserving a removed line's bracket counts and executable structure. Replacements
must be identical apart from indentation. Replacement evidence
must be the immediately preceding removed line in the same hunk; matching text elsewhere cannot
prove control-flow scope. The guard-relocation regression also pins the live-mode human hold.
Word conservation alone
cannot prove semantics: the guard-inversion-with-comment regression must retain human review. Other structural
lines retain human review, as does any net bracket-count change outside pure entries/wiring.
Every removed allow-list line also needs a distinct added partner in the same hunk, in removal
order, identical after stripping newly introduced op references from the addition and whitespace
and commas from both. Unpaired deletions retain human review; the scheduled-sweep quiet-hours
bypass and duplicate-guard regressions prevent borrowing another guard's replacement.
The health early-return bypass and removed-bracket regressions pin these fail-closed paths;
the #5961/#5962 fixture preserves the real import, registration and array-replacement shapes and retains
human review. Shape wiring tests separately exercise provable registration and stored-array holds in
shadow/live output, including event emission only when the current and proposed decisions differ.
Sandbox tokens anywhere in a hunk and hidden separators/control characters in protection additions
retain the hold. Missing/invalid tool mode stays shadow even when the platform requests live;
dependency proof checks regular-file sizes before reads, and shadow event logging waits at most 2s.
Review each "nearest", "only", and "never" qualifier in this document against a named test
that would fail if the qualifier were removed; prose qualifiers require review, not a deterministic gate.
The array cases cover complete, partial, positional and frozen lists. The shape tests
read the shipped settings with an empty environment and require shadow mode. Loader rejection
cases start with successful read-only evidence, then isolate missing trusted declarations,
incomplete dependency graphs, and the accepted 512-file / rejected 513-file boundary.

## PR size admission trust-boundary fixtures

`scripts/lib/__tests__/pr-size-admission.test.mjs` exercises Git with real shadow refs and
round-trips hostile filenames through `planFileItem` and `js-yaml`. Size evidence must carry
full head/base SHAs; mock symbolic SHA strings no longer represent valid Git evidence.
Retry fixtures need a trusted card store keyed by repository and head SHA; assigning a PR
number after creation must reuse the initial card. Cover retries with and without a saved body.
Body markers are display hints; publication must be confirmed again from the store/publisher.
Size sections use exact `<!-- pr-size:begin -->` and `<!-- pr-size:end -->` markers on
their own lines. One unambiguous plain pair replaces the enclosed display text, even if
edited; no pair appends a fresh section. Malformed, partial, nested, duplicate or nonplain
markers preserve the entire body and append a fresh section. Identical retries are byte-stable,
including after a conservative append. No machine-local state is read or created (R126).
Test replacement across a fresh HOME and preserve all bytes before and after the pair,
including CRLF. PR text remains untrusted: neither delimiters nor enclosed receipts authorize
card filing or publication, which must be checked through the trusted store/publisher (R115).
The fresh-HOME child also records and rejects synchronous file open/read/write and subprocess
attempts after module loading, with diff/card effects injected. Assert no attempts on creation
or retries: an empty directory alone cannot detect a secret read whose failure was swallowed.
Without pinned evidence, the display key hashes repo, PR-or-ref, requested SHA and base; it
does not make an unresolved head eligible for trusted card lookup.
pr-land re-reads the live body after card filing and skips the note when it changed or is unreadable.
Author text is never truncated or escaped: past the forge body limit the note is skipped and the
body returned unchanged (no edit), and every fallback, including the runner's outer catch, returns
the caller's body. Reviewers are still requested in each case.
Unknown or stale evidence and unreadable/ambiguous stores file conservatively and request reviewers.

The legacy `file-item` scope flag is a comma list whose renderer supplies YAML double quotes.
Size admission JSON-escapes each scalar's contents before bounding entries; it also escapes YAML
line separators and trailing whitespace. Comma-bearing paths are omitted with an explicit count.
Every incomplete summary names human review of the full diff as its fallback. Keep these tests
in the shared suite and run it and the scoped producer/prepare suites through heavy admission.
Identity, path and published batch-ref validators use explicit absolute-end assertions
(`(?![\s\S])`). Keep the named trailing-newline regressions and the CR/CRLF/Unicode
line-separator suffix cases in that required scoped gate.

## Drain identity admission regressions

Identity admission must fetch the pinned PR head as well as main before reading cards.
Test a remote-only head by rejecting diff/show until that head has been fetched; use a real
temporary remote when Git writes are available. Prepared file lists never replace the guard's
fresh Git evidence, including empty, stale, or truncated lists. Any wrapper substituting synthetic
output for a guard's command needs named positive and negative tests for every eligibility check.

Infrastructure refusals must leave defect labels untouched. Test Git read failures through strategy
admission, and keep raw command errors out of public comment bodies. An unreadable check holds the
enqueue with a note and makes no PR comment or label edit of any kind. Corruption heals once per check
and retries the failed command once; prove it on a real temporary clone with a planted commit-graph
naming a missing object, and prove that a network failure or a surviving corruption is not healed again. Test notification retries after
comment and label failures independently, and deduplication across fresh strategy instances using
the paginated thread and trusted leading markers. Scope queue failure/rebuild history to the enqueue
identity; old persisted records without it start fresh. Keep enqueue result recording and event
emission in one helper, test each outcome and delivery failures, and exercise exported helpers
instead of evaluating extracted source with `new Function`.

## Established-overlay auto-rebase

Operator withdrawal wins over a detached repair: the worker rechecks its source registration
before push, then `addOverlay` compares the same snapshot under the overlay list mutex before
registering a replacement. An absent, changed (including a new `addedAt`) or corrupt source refuses registration,
creates no pending swap and reports `auto-rebase-needs-you`. A removal during push can leave an
unregistered remote branch; it never authorizes loading that branch. Unrelated list edits are preserved.
The `operator withdrawal during detached repair` tests cover each async phase and the final write boundary;
the `auto-rebase-operator-withdrawal` soak scenario uses the real removal CLI with injected Git and agents.
All three registration guards share `registrationIdentity`: cached `stackBases` rewrites do not change
operator intent, while every other field still participates in the comparison. Worker regressions rewrite
the cache during audit and at registration, then exercise adoption cleanup.
Pending evidence is persisted before replacement registration. Write or rename failure leaves only the
original registration; a rejected registration removes its pending file. An interruption between persistence
and registration leaves evidence for cleanup to escalate safely. The persistence regressions also retry the repair.
Under Vitest, `prepareRebuild` defaults auto-rebase to off without mutating the caller's environment;
tests exercising worker launch or pending cleanup must explicitly set `WE_DAEMON_AUTO_REBASE=1`.

The detached worker in `scripts/lib/daemon-rebuild/auto-rebase.mjs` merges main into a new
`<ref>-auto-<n>` branch so ancestry preserves the original tip. It retains the old registration
until the verified adopted HEAD contains the replacement SHA and the replacement contains a freshly
fetched origin tip of the old ref. An advanced or unreadable old tip retains both registrations and
escalates through `auto-rebase-needs-you`. Cleanup requires the replacement's freshly fetched origin
tip to contain the pending SHA, and `removeOverlay`'s `requireRef` checks the replacement is still
registered under the same list mutex that removes the original, so a withdrawal up to that write wins;
its `expectedOverlay` is the original's registration recorded in the pending file at swap time (never a
fresh read), so an original re-registered at any point since is never removed, on that pass or a later
one; a pending file without it fails closed. A replacement
unregistered before adoption escalates every cleanup pass instead of waiting silently;
the pending file stays, so a fresh repair is the operator's call;
missing or unreadable evidence retains the old registration and pending file and alerts in both sinks.
A mechanism-pinned original is never set aside as stack-contained, so the plan still lists it as lost
beside its applied repair. `prepareRebuild` does not hold for a lost overlay whose current tip the
build contains (git ancestry; an unreadable answer still holds), so the repair can be adopted and cleaned up.
In tops mode, deferring a pinned base behind its containing overlays requires proof that its exact
registered tip is already in the running HEAD and in each containing overlay's tip. Missing HEAD,
non-containment or unreadable ancestry preserves ordinary pin handling. The stack-tops regressions
cover those closed paths. Deferral also requires an unresolved conflict at the base's ordinary position against
the accumulated build. A clean base retains its position: applying it can make a containing top
merge cleanly even when that top conflicts directly with main because of a newer merge base.
The clean-base regressions cover explicit and mechanism pins, including a preceding overlay that
makes the base clean; `pinned-stack-clean-base-order` replays adoption through the daemon soak harness.
Each conflicting base can be deferred only once; failed tops return it to ordinary pin handling.
Reviewed edge resolution runs before deferral, and an unreadable merge cannot authorize reordering.
Edge-resolved rebuilds retain the registered overlay tip as their second parent and the approved edge tip
as a third parent. Copying only its tree loses ancestry when a later overlay has identical content.
History readers accept both merge shapes; ready-build verification allows only the approved edge as the
extra parent, still checks current approval and content, and accepts persisted two-parent builds.
Registered auto-rebase repairs do not trigger deferral; the mechanism-pinned
auto-rebase cases preserve the original's conflict/loss decision, repair adoption and loss protection.
Per-ref JSON sidecars next to the overlay
list survive ticks; per-ref markers expire after 30 minutes without a heartbeat. Live detached
workers touch their own token's marker every minute with an unrefed interval, cleared in `finally`.
Long-running agents and tests use asynchronous child processes so they cannot starve that timer.
Test liveness past expiry with a fake clock and injected filesystem touch. Failed workers retain their
marker until expiry to bound retry cost. `WE_DAEMON_AUTO_REBASE=0` disables
new jobs and pending-swap cleanup. Cleanup follows interrupted-build recovery and requires
`state.adopted.head === HEAD`. Launch and pending-swap failures write both the needs-you event and alert.
Pending files are isolated: unreadable JSON, invalid swaps and failed removal retain the evidence
and leave later files eligible for cleanup. Unexpected scan failures also escalate from prepare.
Both Codex JSON reports must carry exit code zero, no timeout, and terminal `turn.completed`;
the wrapper process exiting zero alone is insufficient. The source of the switch is logged on consultation. Missing related tests, incomplete
reads, more than 100 selected tests, failed tests, or an audit without the exact verdict
`NOT WEAKENED` escalate through `auto-rebase-needs-you`; the old registration remains.
Select scoped tests from the completed candidate diff against the old tip as well as the
original conflict paths: the fixer can edit modules beyond those conflicts.
Git path listings use `-z` and split on NUL without trimming, so non-ASCII and whitespace
paths match the import graph in conflict, candidate-diff and overlay-branch selection.
The static reverse-import graph supplies scoped tests, so dynamic-only relationships require human intervention. Exercise both registration and adoption with real git in temporary repos;
Codex and the queued test runner stay fake in `daemon-rebuild-auto-rebase.test.mjs`.
The queued test run must also produce a fresh Vitest JSON report proving every selected file executed.
Load its inventory helper only during validation: its dependency graph needs npm packages, while
the copied-script backlog CLI fixtures intentionally boot without `node_modules`.
Exit zero alone is insufficient: a mixed selection can pass while the unit config excludes an integration
file. Missing, malformed, partial, oversized (over 8 MiB), or entirely skipped inventories stop before audit, push and registration
with `auto-rebase-needs-you`; verifying excluded tiers requires human review. The worker uses the shared
`alwaysRunInventory` check, compares paths against the scratch clone's real path, and removes its private
report on exit. The `auto-rebase executed-test inventory` regression includes a real Vitest exclusion probe;
the existing `auto-rebase-operator-withdrawal` soak break also exercises the omitted-file refusal.
Cleanup attempts both the private report and the scratch clone before rejecting a removal failure.
It emits one cleanup needs-you event and alert, including both reasons if both removals fail,
and retains the original registration and pending swap. The report/scratch/both cleanup cases
in `daemon-rebuild-auto-rebase.test.mjs` pin those guarantees.
The existing [test-selection fallback and durable evidence](../../scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs) cases cover overlay tests, reverse imports, skipped empty runners and exact audit refusal.
Report and scratch cleanup are both attempted. A cleanup pass emits one needs-you incident containing
each removal failure; scratch cleanup failure still rejects the worker, while report-only failure remains
best-effort. The cleanup regression covers report-only, scratch-only and simultaneous failures.
Missing related tests fall back to overlay-branch tests plus import reach; fenced `noTestFiles` reaches the required audit, which must certify exactly `NOT WEAKENED`.
Selection rules and original conflict markers persist as JSONL evidence before tests; each conflict read and capture is capped at 65,536 bytes, with its descriptor closed in `finally`.
Evidence append failures stop at stage `tests` before tests, audit, push or registration; the needs-you event remains the fallback when the alerts file is unwritable.
Before test selection, list the candidate and both parent trees and require every parent's
`.test.*` or `.spec.*` JS/TS test path to remain at the same path in the candidate, including renames.
Any existing test removed by resolution requires human review at stage `tests`, even if other tests
remain or an auditor would certify the result. Unreadable tree listings also fail closed.
The `codex-audit-required` fallback covers genuinely uncovered files only; it cannot rescue deleted tests.
Capture skips non-regular files and platforms without `O_NOFOLLOW`; inspection, open and read failures remain best-effort omissions from evidence.

## Copied CLI fixtures

When copying `scripts/` into a throwaway checkout, link that checkout's `node_modules` to the source
checkout's installed dependencies. Run the copied entry point so its `import.meta.url` still resolves
mutations inside the fixture. Node resolves package imports from the copied modules' location, even
when the child process runs from another directory. Copy repository-relative imports outside `scripts/`
too: the transcript checker needs `skills-src/inspect-codex-transcript/` at the fixture root. When moving
`scripts/` for locus guards, move that dependency alongside it and retain access to `node_modules`.
Remove the fixture during teardown.

Post-run transcript diagnostics resolve their policy independently of the optional inspector dependency.
Keep the named checker-import failure regression in `scripts/__tests__/codex-direct-task.test.mjs`:
a completed run must still return its report, preserve the shipped warn default, and enforce fail in
both foreground output modes. `scripts/lib/__tests__/codex-transcript-check.test.mjs` pins the real
settings file to warn/3000000 with tool provenance, checks unreadable settings/platform sources, and
guards executable-looking custom input with an execution sentinel and a static evaluation check.
An unreadable policy source must retain a readable higher-priority mode; unknown mode fails closed.

## Health tick watchdog deadlines

`scripts/conveyor/__tests__/health-watch.test.mjs` keeps the real child-process kill probe and uses an
injected child with virtual time to cover production-sized deadlines without waiting minutes. Inject load
readings through `resolveTickWatchdogLimit.readLoad`; do not depend on the host's current load.
The deadline is `min(tickKillCeilingMs, tickBudgetMs * 3 * clamp(load1 / cores, 1, tickKillLoadScaleMax))`.
Defaults are a 60000ms budget, maximum scale 3 and absolute ceiling 540000ms. Policy
`healthWatchTickWatchdog` resolves standard → platform → flat health-dir `config.json` keys → environment
(`WE_HEALTH_TICK_KILL_LOAD_SCALE_MAX`, `WE_HEALTH_TICK_KILL_CEILING_MS`). Invalid settings fall back to
their standard values with provenance logged; invalid/unreadable load uses scale 1. Keep named cases for
healthy 174s completion under load, the idle 180s deadline, exact scaled-limit SIGKILL, actual-limit
`overrun.json` persistence, invalid knobs and oversized values capped by the absolute ceiling.

## Daemon entry boot smoke

Rebuild candidates must also work with the old live daemon's smoke environment: it exports
`WE_SMOKE_LIVE_CLONE` and `LANE_POOL_ROOT`, but may omit `LANE_POOL_CANONICAL_ORIGIN`.
The canonical-origin CLI fixture covers the named candidate's verified Git owner under a fake pool;
forged markers, lane owners and unreadable ownership must retain the explicit-origin refusal.
The candidate-env fixture also checks that configured local origins are anchored to the live root before
export, so changing to the candidate directory preserves the destination; explicit env values keep precedence.
The inherited origin applies only without `--reference`, `--repo` or `--pool`; those selectors resolve
their own primary. The CLI fixture exercises recovery against separate local bare repositories and
checks that cross-pool release never publishes another pool's work to the inherited origin, including
when that pool's primary is missing or has no origin.

Boot each entry in a fresh child to preserve cold import graphs. `rebuildSmoke.bootConcurrency`
(default 3) bounds initial boots; after those children drain, `rebuildSmoke.bootSignalRetries`
(default 1; zero disables) retries only SIGTRAP/SIGSEGV/SIGABRT/SIGBUS/SIGILL deaths, serially.
Exit failures and `ok:false` never receive this retry. Both settings use the policy cascade via
`scripts/settings/rebuild-smoke.json`, with env overrides `WE_SMOKE_BOOT_CONCURRENCY` and
`WE_SMOKE_BOOT_SIGNAL_RETRIES`; log effective values and sources. Env integers are strict
digits; empty is unset. `rebuildSmoke.bootMinChildMs` (default 10000; env
`WE_SMOKE_BOOT_MIN_CHILD_MS`) uses the same cascade and source log. Each boot asks for a
per-call floor of `min(daemonBootMs, bootMinChildMs)`; less shared rebuild budget means the
existing budget refusal, never a doomed short child. Live smoke tracks that same floor when
marking budget interruptions. Only an all-timeout boot failure set at the full requested caps
counts as env-timeout (caps at least `MIN_OWN_CAP_MS`, each attempt's measured `elapsedMs`
at least `min(minElapsedMs, cap * 0.9)`; aggregate row time cannot substitute for entry timing).
An import failure already reported on child stdout remains `import failed` even when a pending
timer keeps the child alive until a timeout kills it.
Mixed import failures, crashes, budget slices and missing entry evidence remain code failures.

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

Recovery distinguishes a policy-clear from a completed seat and a failed execution. A trusted
acceptance re-stamp at the live head can carry only the policy-clear of its preceding trusted
acceptance record. A newer result on another revision, including one posted after the live-head
re-stamp, or missing/untrusted source acceptance
refuses carry; recovery never searches older revisions for a convenient clear.
Stored-review recovery passes explicit `storedReviewPolicyClear` authority only after its acceptance/hold guards; ordinary job settlement still refuses contradictory `not-owed` results. The stored-context tests in `red-team-skip-outcome.test.mjs` require acceptance, a bound read and no guard/cap deferral.
Both carry and stored clear pass formal reviews into `latestAcceptRecord`; unreadable reviews
refuse publication and require operator inspection. A standing formal CHANGES_REQUESTED blocks both.
Stored clear (null status or finished/not-owed) requires a trusted acceptance record whose SHA is
the live head, alongside the matching stored read, no seats, and no deferral. An accepted label
alone cannot establish that boundary; keep real accept comments in R100 clear-success fixtures.
One non-completed seat with finished/ran permits one fresh retry under the daemon cooldown;
two failed seats retain the refusal and require operator inspection. Completed seats retain
result/effects-only resume. Preserve the failed status through queued admission so the shared
seat guard can independently recheck the same bound. The R100 regressions in
`review-red-team-on-skip`, `drain-red-team-evidence`, and `review-job-red-team-only` cover these paths.

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

Verify-daemon orphan fixtures must inject both `isAlive` and `groupAlive`: a fake dead PID
does not imply its host process group is gone. Signal-zero probes can return `EPERM` in a
restricted execution environment, which correctly retains the entry. The real-process adoption
test additionally requires permission to inspect child argv with `ps`.

Runner fixtures using synthetic PIDs must inject `identity` alongside `alive`: a successful
existence probe still checks process identity. Stamp fixtures must also inject `identityOf`
or supply both `runnerStart` and `runnerArgv`, so stamping cannot inspect a host process.

Keep production PID caller tests in a dedicated file using injected IO: the Vitest
`node:child_process` module mock does not reach `pid-alive.mjs` in this configuration.
Inject `buildLeaseSignalsFor`'s `isPidAlive`, composing `defaultIsPidAlive` with a fake
`kill` and `pidIdentity` with a fake `exec`. Assert the `ps` call as well as liveness
and reclamation outcomes; see `pid-identity-lease-reaper.test.mjs`.

PID identity probes return `true`, `false`, or `null`: callers must compare explicitly,
never truthiness-test `defaultIsPidAlive` or `probePid`. Only `false` establishes death;
unreadable identity or claim-runner command evidence retains a fresh claim's lane veto.
Test both wrapper and claim-runner wiring. Cover every changed `catch` branch with an
injected error: existence success and `EPERM` must consult identity (including false and
null verdicts), `ESRCH` proves death, and other errors remain unknown without identity IO.
Include invalid PID inputs and an identity probe that throws. A working Claude session
can retain `claude bg-spare` argv; require stored start/argv mismatch or other positive
death evidence to reclaim it. Legacy unstamped spares retain TTL recovery.

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

R125: `measureNonTestLines` excludes pure data from the 300-line budget and reports it separately as
`dataLines`; those files still require review. Built-in data extensions are `.json`, `.yaml`, `.yml`,
and `.csv`, under a `config/` or `data/` directory segment at any depth. Exact `dataPaths` add exceptions
only for those four extensions; `dataExtensions` may select only within that set. Code and markdown
cannot become data exemptions. Absolute paths and paths with empty, `.` or `..` segments always count.
The shared producer admission resolves `prSize` through the shared policy cascade and `scripts/pr-size-settings.json`;
JSON-array env overrides are `WE_PR_SIZE_DATA_EXTENSIONS`, `WE_PR_SIZE_DATA_DIRS`, and `WE_PR_SIZE_DATA_PATHS`.
Invalid present settings at any layer make size unknown, file a split card conservatively and request
extra reviewers without refusing PR creation; only an absent tool settings file uses lower layers and
built-in defaults. Restore valid settings before retrying measurement.
The counter defaults to dependency-free frozen built-ins to preserve the declaration's import safety.
Keep the classification, settings provenance, data accounting, binary/overflow errors, and conservative
rename cases in `scripts/operations/__tests__/open-pr-size-cap.test.mjs`.

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

An approved human-surface head hold suppresses rebasing, never pending-card numbering before
enqueue. Regress that preparation predicate with an approved human-only head carrying a hash card,
and run real branch numbering with workflow edits while unqueued. Queued human-only or
human-enqueued hash cards retain their skip event and emit `needs-you` with the files and
dequeue/re-queue instructions; hash-free branches emit no alert.

Branch preparation accepts flat backlog cards and `backlog/raised-by/<digits>/<basename>.md`
ledger files; ledger basenames allow ASCII letters, digits, dots, underscores and hyphens.
Reject `..`, NUL and symlinks at every parent or file before numbering. Keep nested ledgers
outside card discovery, renaming, number floors and reservation pruning.
`queue-branch-numbering.test.mjs` exercises real Git
numbering beside unchanged ledgers, including a hash-like ledger basename. Preparation skips
emit a best-effort `needs-you` event with the refusal and manual-numbering fallback; numbered
and final outcomes emit none. Regress both synchronous and asynchronous emitter failures.

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

## Antigravity quota hold evidence

Exercise holds with an injected temporary `dir` in
`scripts/lib/__tests__/antigravity-run-evidence.test.mjs`. Explicit Claude and Gemini
requests read their own backend folders; default or unrecognized models scan
`anthropic`, `google`, and `unknown`. Legacy root JSON holds use the known served
model's backend, falling back to the requested model's backend; unattributed legacy
holds apply globally. Reads leave legacy files untouched. A skipped run retains
`servedModel: 'unknown'` and `modelEvidence: 'not-launched'`; `heldBackend` and
`heldModel` identify the observation responsible for the refusal.

Judge scorecards and run-record telemetry keep the effective agy effort: a model-id
suffix takes precedence, otherwise apply the CLI map and legacy model override.
Use `antigravity-model-effort.mjs`'s shared predicate in both launchers. Regression
coverage lives in `antigravity-judge-spawn.test.mjs`; `parallel-judges.test.mjs` checks
that both drive modes preserve provider effort while retaining the request fallback.

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

### Default-parameter dependency tests

The lane-scan resolver's default-parameter tests must mock `platformPreference` and
`readDeclaredSettings` at the module boundary with hoisted `vi.mock` factories; post-import
namespace spies did not reach the resolver's named imports in this suite. Preserve the real
exports and use `mockReturnValueOnce` for each layer case so other callers retain real IO.
Also exercise the real platform reader with a temporary `WE_PLATFORM_PREFERENCES_FILE`
and an empty mocked tool layer, calling `resolveLaneScanPolicy()` without injected arguments.
For an unset environment layer, register the stub for restoration, then explicitly delete the
key; passing `undefined` to `vi.stubEnv` can leave a string value in older Vitest versions.

### Imported action-wrapper inventories

Lane-action boundary tests inventory imported helper targets from every module, including
module/export identity and aliased callees. Keep exact per-occurrence counts, keyed by file,
module, export and callee, for mutating helpers and every helper owned by the change. Only
known read-only/noise helpers (filesystem reads, pure formatters and renderers; redaction scrubbers keep exact counts) may vary in
count; a mutating name or target overrides that exemption. Keep distinct module/export identity
checks for every helper, including noise. Named negative controls must reject repeated existing
mutations as well as aliased cleanup wrappers imported from outside the owned modules.

### Gates in git fixtures

When a publish gate runs the suite that tests its own caller, use a fixture-local npm script in the
temporary git repo to verify gate arguments and green/red handling without recursively launching the
suite. Exercise real subprocesses and git transport. Emit gate chatter in the fixture too: a CLI's
machine-readable JSON stdout must remain parseable when its child gate prints output.

Keep real-Git fixtures compatible with Forge's Git 2.43. An unsupported repository extension can
prevent even read-only repository commands: inspect configuration with `git config --file`, and
prove refusal by comparing filesystem bytes. Git's fetch negotiation may avoid a stale commit-graph,
so verify an existing graph explicitly when testing corruption admission and repair. An `ls-files`
exit 1 alone does not prove an untracked path: sparse-tree read failures can share that exit status.
For a narrowed catch, keep one negative test per independent condition: the expected status with
an unrelated diagnostic, and the expected diagnostic with another status. Fail-closed hook checks
also need nonempty stdout and extra or partial stderr cases, in both reporting and repair modes.
A test promising "only" or "never" must exercise the excluded case as well as the permitted one;
assert the absence of retries or writes, not just the returned error.
Send repository-sized path lists through NUL-delimited stdin, not argv; real-Git regressions should
exceed the host's `getconf ARG_MAX` and prove the argv form fails with `E2BIG` while stdin succeeds.

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

## Delivery policy path probes

All worktree delivery-policy sources and journal IO use `resolveTrustedConfigPath` in
`scripts/lib/delivery-policy.mjs`. Canonical allowed bases may resolve platform aliases;
symlinks below those bases are refused, including parents whose targets stay inside the base.
Use its `beforeRead` hook to swap a leaf or directory after validation: reads/appends must
refuse the swap or retain the originally validated inode. The fd's device/inode and size
are checked before IO, and reads are bounded even if a concurrent writer grows the file.
Cache hits still check paths; the existing mtime-based content cache remains intentional.

Explicit journal redirects must stay inside the working directory, daemon state, or the
configured logs root. Fixtures should put journals under their isolated daemon state.
Invalid policy sources retain defaults (or the protective failsafe) with warnings; journal
failures remain best effort (empty reads, skipped writes). Journals reaching the 1 MiB source
limit require operator rotation before further reads/appends. Regression home:
`scripts/lib/__tests__/delivery-policy.test.mjs`.

Policy defaults use a code-owned runtime import allow-list (currently empty).
Check source before bundling, generated output after bundling, and the exact bytes at
the runtime import boundary. Computed imports, template specifiers (including plain
templates), concatenation, unlisted literals, `import.meta`, and dynamic code constructors
must be refused. Type-only imports are erased; strings and comments are inert data.
The `policy runtime import allow-list` tests pair an approved literal with isolated
refusals at both scan and runtime boundaries. Keep each refusal independent of unrelated
forbidden syntax so a second guard cannot mask a regression.

Journal append tests cover exclusive lock creation, owner-token checks before writes and
release, and size checks after acquisition. A stale lock with a live or unknown PID must
remain held. Competing stale removers must serialize through the same generation guard
as normal release, then recheck ownership; an abandoned generation guard requires
operator cleanup after checking that no writer is active. Preserve the synchronized
two-writer tests, including the case with capacity for only one more record.

## Quality guidelines
Real Git fixtures must pass `-c gc.auto=0 -c maintenance.auto=false` on their Git invocations.
A large seed commit can launch detached maintenance/repack that outlives `execFileSync`, racing
recursive snapshots and cleanup. Apply the same flags to bounded production freshness fetches;
do not hide the race with sleeps, cleanup retries, or exclusions from the snapshot.

Git path safety tests must preserve raw command-output bytes until UTF-8 round-trip validation;
include invalid filename bytes as well as a valid U+FFFD name. For generated safety attributes,
probe the effective value with `git check-attr`, and test encoded line lengths near Git 2.43's
2048-byte limit. An ignored override must refuse the merge before Git can allocate conflict markers.

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

An entry guard placed in the first side-effect import must finish synchronously before
transferring execution. Awaiting IO in that guard lets sibling entry dependencies evaluate.
The tools-root subprocess fixture pins this: a later dependency throws if local evaluation
starts, while the selected tools entry records its actual cwd, argv and exit status.
Tools-root redirection accepts only the three entries declared in `TOOLS_ROOT_ENTRIES`;
an ordinary `scripts/` runner importing one of them as a library must stay local, even
when a counterpart exists in the tools checkout. Pin both the no-spawn seam and the real
import path. Pin every explicit resolver rejection reason, including a successful Git
probe that names a different checkout root. The default event-writer fixtures must cover
both timeout and excessive-output recovery before selected tooling starts.

The synchronous tools-root wrapper cannot forward a signal addressed only to its PID;
the selected child (or the event writer) can outlive it. Supervisors must terminate the
whole process group. Moving to async signal forwarding also requires deferring sibling
entry imports; awaiting the first side-effect import alone does not defer them.
Oversized-input fixtures must measure requested ranges and cumulative bytes through the
filesystem seam, including short reads; rejection alone does not prove bounded IO.

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

`hasUnsafeWork` reuses lane status cleanliness and supplements it with a read-only count of commits
absent from the verified expected branch and main origin refs. Dirty status or a positive ahead
count reports true. A zero local ahead count reports null with a publication reason: even these
expected tracking refs are lane-writable and cannot prove publication. This reader never reports
false, whether fresh or cached; destructive actions require `guardLaneAction` with fresh trusted
publication evidence. Unassociated claims/runs have null work safety.
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

When spying on filesystem reads in a child process, reset observations after importing the
module and immediately before calling the operation. Node's module loader can use the same
filesystem API; including its startup reads makes bounded-read assertions runtime-dependent.

A core file that dynamically imports its CLI cannot await that import at module scope when
its CLI statically imports the core. A staged Node probe of that cycle exits 13 with unsettled
top-level await. Defer the import with `.then(...)`, and test both entry paths as subprocesses.

Keep the local admission heartbeat import graph free of remote CLI modules with top-level
await: terminating a watchdog worker during their evaluation can abort Node with SIGTRAP.
Load remote health only after selecting remote execution. The subprocess startup/stop case
in `scripts/__tests__/verify-lane.test.mjs` exercises that worker lifetime boundary.

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

### Card numbers at birth

`card-number-allocator.mjs` shares the drain numbering mutex and persists host reservations
before releasing it. Allocator tests must inject temporary `lockRoot` and `statePath` values;
remote-claim probes use an injected transport, never the live remote. Producers fall back to
hash paths on unavailable or truncated canonical main or remote-ref evidence; `backlog.cardNumbering.remote=required`
refuses instead. `WE_NUMBER_AT_BIRTH=off` retains hash naming. Numeric cards carry their fresh
hash only in `bornAs`. The drain's existing hash-only selection leaves these cards untouched.
CLI probes must also isolate `HOME` and Git transport so they cannot reserve production card numbers.
The create-only `refs/card-ids/<HASH_RE id>` mapping and number reservation share one blob and
one atomic push with empty-ref leases. Test replay with separate host state, two distinct ids,
and races on either claim; neither ref may be replaced. Settings resolve through the shared
cascade with each leaf’s source logged under `backlog.cardNumbering.*`.

Deferred numbering uses the same atomic remote reservations even when birth numbering is off.
With a configured remote, an unavailable canonical tree or reservation listing holds the hash cards;
only repositories without any remote retain local-only numbering. Test an outstanding birth claim
against the actual deferred-numbering dry run, and test allocation/replay races through the shared core.
Refresh canonical evidence before scanning landed `bornAs` identities. Cover a stale checkout
whose pending hash already landed without reservation refs: identical content deduplicates and
differing content holds, with no new claim. Deferred-numbering fixtures inject the `execFile`
option on `numberPendingHashes` and mock the shared process reader, so every Git path uses
the same fixture without depending on captured builtin imports or patching native ESM bindings.
Review staleness fixtures must use off-path files from the current sandbox import closure.
Collision healing now pulls `backlog/frontmatter.mjs` onto that path; cover its refusal and
use `backlog/capacity.mjs` for tolerated unrelated lag in both dispatch modes and the soak.
Both collision planners refuse to move a `bornAs` card or a reserved source number. Remote-backed
heals never reuse a gap below the frontier: trees and reservation refs cannot show whether a gap
held a legacy card deleted before reservation refs existed. They take a fresh number above every
reserved, canonical and local number, claim all targets atomically before rewriting, and refuse
for manual repair when the number range is exhausted. The manual `yield` command uses the same
guards, including with `--force`. Claims survive a failed rewrite or publish.
Test reserved legacy sources without `bornAs` independently in both planners and in `yield --force`.
Exercise `yield` and the renumber CLI with a stub Git transport: leave an untraced gap below the
frontier, include a canonical-tree number, and snapshot every backlog file at push time to prove
the claim precedes any write or delete. Rejected claims, unavailable evidence, and an exhausted
range must preserve all files; a renumber dry run must neither claim nor write. No-op renumber runs (including
base-owned or entirely published duplicates) must not read remote numbering evidence.
The allocator suite pins the held-fix-claim refusal before constraint reads or reservation
pushes, and asserts that reservations survive both failed index rewrites and failed publication.
It also observes the allocator's log callback for each effective setting and its source.
Remote-backed gap selection uses current trees and reservation refs, without historical deletion
evidence; the historical-number reuse policy is tracked in
#7317.
Canonical tree reads use NUL-delimited paths; cover Unicode, quotes, backslashes and embedded newlines.
Allocation and replay must obey the five-digit numeric ID grammar, including contention at 99999.
Numbering evidence reads leave tracking refs unchanged by default: fetch with an empty refmap
into a unique per-call `refs/tmp/numbering-*` ref without writing `FETCH_HEAD`, then delete the
private ref in `finally`. Interleaved readers must retain their own trees; failed fetches or
tree reads must still attempt cleanup. Collision healing cannot change a rebuild's parent
after its tree was computed. Deferred numbering explicitly opts into refreshing tracking
before its `bornAs` scan, while reading numeric evidence from its own private ref too.
Cover a remote main advance during the actual `rebaseDropManifest` collision-healing path and
assert that the committed parent and tree still describe the same main snapshot.
Permanent reservation listings use a bounded 32 MiB budget in both the parser and subprocess,
enough for paired number/card-id refs throughout the five-digit range, including SHA-256 OIDs.
Canonical path reads use the same budget so a full backlog does not hit a smaller output cap.
Cover 8,500 claims, allocation of 99999, replay after a lost push response, and oversized refusal;
also exercise the shared Git runner to catch adapters that silently discard `maxBuffer`.

### Dispatched conflict resolution

`we:scripts/conveyor/resolve-conflict.mjs` uses index stages only inside a lane clone with
an active merge. Probe with real conflicting repositories under `.lanes/<repo>/lane-<n>`;
assert stage 0 content and no unmerged entries (taking ours can leave no cached diff).
Redirect `WE_RESOLVE_CONFLICT_LOG` to temporary storage. Permission-denial completions carry
`denied`, hold for 60 minutes, and surface a `permission-blocked` note immediately; they are
separate from transient infrastructure failures and their retry streak.

### Forge client telemetry and remote admission

The runner's `telemetry` subcommand samples the host on demand, including on fresh installs
without `telemetry.json`; it never returns a saved timestamp as evidence of current health.
Keep the stale-idle-file → SSH adapter → health-check regression alongside the ten-second
cache boundary and SSH-failure/backoff recovery assertions. Boolean flags `--run`, `--silent`
and `--no-color` must reject immediately following tokens beginning with `true` or `false`:
Vitest can consume those positional-looking filters as flag values and change execution mode.

`forge-client-controls.test.mjs` pins strict bounded telemetry, the read-only single-SSH CLI,
runner sampling at prepare/run/finish and five-second in-process updates, fixed command
classes, receipt argv binding, separate remote capacity, and persisted health/cache state.
Use temporary lock roots and injected telemetry in legacy remote-contract fixtures; never
contact Forge or consume the real host's remote slots from a unit test. Retain the original
termination acknowledgements and refusal assertions when updating those fixtures.

Coverage transport fixtures must use absolute Istanbul source keys and preserve report/source
mtimes. Compare local and remote attribution after transport makes keys relative. Pin coverage
base refs to local commit SHAs in the manifest; reject bases outside reconstructed public ancestry,
including unrelated commits already present in the worker's object cache.

Remote telemetry older than 30 seconds or more than 60 seconds ahead routes through local
admission. Compare ET timestamps by instant with `Date.parse`, independent of the process timezone.
`forge-health-fresh.test.mjs` pins both freshness boundaries, winter/summer offsets, strict optional
boolean `prewarmed` entries, and stale persisted-cache recovery. Stale cached telemetry gets exactly
one fresh read under the mutex before deciding; a failed read is `forge-unreachable`, and a still-stale
sample is `telemetry-stale`. Fresh data and failed reads share the ten-second cache; an active backoff
still returns before reading. Back-off and failure counts are host-shared too.
Persist `slot-N.unconfirmed` exclusively before invoking the remote executor;
remove it only after confirmed completion or termination. Abrupt client death skips `finally`,
so quarantine cannot depend on cleanup running. A dead client PID or expired slot lease never
authorizes reusing an outstanding execution's capacity. An operator must confirm Forge termination
before manually clearing a retained marker. If marker creation fails, refuse remote dispatch and
fall back through local admission. The SIGKILL subprocess regression leaves its simulated remote
job alive and asserts that a second caller cannot reclaim that capacity. Keep this crash test
alongside the returned-result and confirmed-cleanup cases when changing remote-slot lifecycle.
Model the surviving job with `keepAliveScript()` anchored to the test runner, with a bounded
lifetime; anchoring to the simulated client would invalidate the crash-survival assertion.
The local host's heavy semaphore is acquired only on a safe local fallback.

### Forge warm bases and delta snapshots

The Mac client and public-base warmer share `forge-exec-manifest.mjs`: path bytes,
ordering, exclusions, credential-name policy, and leaf hashing must stay identical.
Run `forge-offload.test.mjs` alongside the existing remote client, runner, output-boundary,
and admission-contract test files through heavy-admission when changing this protocol.
Exercise the actual rsync file list and full reconstructed manifest, including executable
bits, worktree deletions, public credential-named sources, and ignored/excluded tests.
Give transport and retry cases an explicit 30-second deadline: they perform real Git and
runner subprocess work, and a safe retry repeats the complete transport/run/finish cycle.

Read-only `bases` discovery precedes local admission so older runners keep their original
full-ship order: no prepared run or transported bytes before snapshot admission/staging.
The subsequent `prepare` response must confirm the chosen base and pin it in ops-owned
state. Base pin creation and pruning share a guard; unknown or unreadable evidence keeps
pruning closed. A worker receives independent copies, and the existing full-tree manifest
and input-digest checks still run before cache extraction or npm. Pre-run delta build or
transport failures rebuild through full shipping; execution ambiguity never retries.
Delta membership compares each final Mac worktree leaf (plus its executable bit) against the base.
Git-clean leaves with verified base blob bytes and stable metadata reuse the base SHA-256; changed,
untracked, filtered/CRLF, index-flagged or unverifiable leaves are read and hashed, and any Git
evidence failure falls back to a full scan (see "Forge manifest reuse"). Transfer paths use byte order.
Unchanged leaves skip staging and rsync. Pin this with real Git autocrlf and post-diff race fixtures.
Each warm tick revalidates retained READY records and their tree count/metadata digest;
a missing tree marker requires one full manifest verification before publication, while
mismatched evidence removes and rebuilds the base. Test both legacy-marker migration and
same-size corruption. A bound protected delta rejection with `started=false` permits
exactly one fresh full prepare; test the second rejection and ambiguous receipt paths,
and require `shipMode: delta-then-full` in transfer timings.

The standalone installer embeds the fixed allowlisted dependency graph into both installed
programs. Probe both installed programs outside the repository's ESM package boundary.
The warmer fetches only the explicit public HTTPS URL with a fresh credential-free Git
environment; private siblings always remain Mac snapshots. Its timer runs as ops under
flock, and only atomically published READY trees are candidates.

Cache profiles retain their complete snapshot/sibling binding. The fixed warmer may seed
another complete profile only with matching registry-only install evidence (all package
manifests, lock, runtime/platform, fixed install flags). Workspaces, local dependencies,
unknown locks and unproven resolutions use the original full-input cache/install path.
Check archive hashes on both source and destination; normal runs still validate npm before
extracting a seeded profile. Cover sibling-bound profiles as well as primary-only runs.
Negative reuse cases must seed both a valid archive and the exact candidate
`.warm-inputs-*` index; a full profile alone cannot challenge the eligibility guard.
Include a supported-input control proving the seeded evidence can actually reuse
the archive, and inspect extracted dependency contents after changing the snapshot.

Stage timings use an injected millisecond clock and Eastern timestamps with the actual
seasonal offset. Install/run durations come from optional, strictly typed receipt timing
fields; older runners provide only a combined wall run duration. Transfer byte counts
represent staged file payload, including separately shipped sibling files.

### Direct heavy-run hook probes

Pool maintenance uses health-watch's existing tick and `scheduled-lane-maintenance.mjs`.
Its per-pool `.maintenance-stamp.json` records attempts before running the trim and gc
CLIs under a shared stamp lock; the interval is at least 24h, even with a shorter
`lanes.gc.schedule`. Invalid/oversized/future stamps refuse work: inspect and repair the
named stamp before retrying. Dry-run ticks do not consume the schedule. The named tests in
`scripts/lib/__tests__/scheduled-lane-maintenance.test.mjs` cover restart suppression,
lock contention, subprocess failures, du byte accounting, real trim lease protection,
and GC refusing lease markers (including a marker appearing during host admission).
GC conservatively skips even stale or malformed markers; lease reclamation stays with
lane-pool's existing trim/recovery paths.

Daemon clone GC is serialized by `clone-maintenance.mjs` with the shared WRITE lock;
keep Git asynchronous so its lock heartbeat can run during packing. The named cases in
`scripts/lib/__tests__/clone-maintenance.test.mjs` cover lock contention, persisted rate
limits, idle-hook order and real local packing that preserves recent unreachable objects.
`cloneMaintenance.intervalMs` resolves through the policy cascade with
`WE_DAEMON_CLONE_MAINTENANCE_INTERVAL_MS` as the environment override. A corrupt or
oversized stamp skips GC (`stamp-unreadable` in the `clone-maintenance` event); inspect
and repair `clone-maintenance-<cloneLockKey>.json` under the daemon state directory.

The `heavy-enforce` guard requires admission even for one-file Vitest runs, `related`,
and direct `check-standards.mjs` execution. Use `node scripts/readiness/heavy-admission.mjs run -- npx vitest run <file>`
or the admitted `npm run test:unit -- <file>` / `npm run check:standards` scripts.
If `run` exits 75 (host busy or queue full), do not loop: re-run it once with `run --wait-ms=540000 -- …`,
which keeps re-trying admission itself (load gate and slot queue, holding its queue place) and still exits 75
when the budget runs out. `heavyAdmission.runWaitMs` sets a default budget through the settings cascade.
`WE_FULL_SUITE_OK` bypasses only full-suite selection, never admission. Guard tests should
assert the suggested command verbatim and probe stdin-to-stdout hook wiring; unrelated
allow-case fixtures must use admitted commands.

For a CLI fixture that must preserve literal brace globs, spawn `process.execPath` with the repo's
`node_modules/vitest/vitest.mjs` and an argv array inside the admitted parent test. npm/npx introduce
an internal shell whose argument escaping leaves braces unquoted, so Bash can expand one brace
argument into multiple flags even when the fixture's own spawn uses no shell.

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

## Automated repair hand-offs

`review-set-label` and the red-team gate signal the local fix daemon after a successful
send-back. CI lifecycle/status writers use the same `scripts/lib/fix-handoff.mjs` wake
path after their existing classification; they do not classify failures a second time.
The mailbox survives signals during a tick; one-second file polling interrupts the plain
sleep without consuming native filesystem watchers, and the optional webhook sleep also checks the mailbox. `WE_FIX_HANDOFF_DIR`
provides an isolated mailbox for tests. A wake only schedules a normal pass; claims,
scope, host admission and attempt budgets remain authoritative.

Pinned plain re-arm fixtures must exercise the partial state between the label swap and
the durable marker: three failed comment attempts restore the pre-swap labels, while a
pending PR resumes by posting only its missing marker. Inject `rearmRetrySleep` to avoid
real delays. Assert head checks on comment retries and rollback, trusted verdict-bound
coverage in thread order (including the same timestamp second), and round counts after
rollback and successful retry. A rollback failure must name the unmarked pending state.
Compensating label writes must also revalidate the complete trusted review evidence
and the review/readiness labels created by the swap. Exercise a same-head human
clearance on the third failed comment attempt, a newer or edited verdict with labels
still pending, changed holds/readiness, and unreadable state. Refuse compensation
when superseded; preserve unrelated labels and ignore untrusted verdict claims.
The `pinned-rearm-orphan-marker` soak replay retains one provider's PR state across
exhausted HTTP 503 retries, successful or failed rollback, and subsequent retries.
Assert that failed rollback resumes with only a marker write, a completed retry writes
nothing further even within the verdict's timestamp second, and rollback spends no
repair round or bypasses the orphan redispatch cap.

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
Hermetic drain CLI fixtures with synthetic UNKNOWN reads pin
`WE_DRAIN_MERGEABLE_UNKNOWN_REPOLL_SEC=0` while retaining the retry count and
merge/hold assertions. Several read stages can otherwise exhaust a child-process
deadline with production waits alone. Verify production delay defaults separately
in the retry helper tests.

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

### Build completion safeguards

Builder, fixer and Codex briefs quote `reviewer-expectations.md` inside a data fence (it is derived
from untrusted PR and CI text). The coroner proposes its concrete examples from recurring findings by PR. `scripts/settings/build.json` overrides the platform's `build` block:
`finalGate` defaults to `full` (whole unit tier plus standards through heavy admission), with `related`
and `none` escape settings. `finalGateStandards` defaults to `always`: non-full gates keep related-test
selection but run standards on every diff, including code-only and card-only changes (scoped where safe),
and disable the local card-only skip, including since-last-green selection. Set it to `selected` to retain
`verify-settings.json` standards selection and card-only skipping. `full` is unchanged by this setting.
`node scripts/verify-lane.mjs --dry-run` prints the default command, reasons and standards decision without
running a gate or writing markers. `selfReview.enabled` defaults true and `selfReview.maxRounds` defaults 2
(0–10). `reviewerExpectations.enabled` defaults true. Sources use the shared policy-cascade formatter.
Environment overrides are `WE_BUILD_FINAL_GATE`, `WE_BUILD_FINAL_GATE_STANDARDS`, `WE_BUILD_SELF_REVIEW_ENABLED`,
`WE_BUILD_SELF_REVIEW_MAX_ROUNDS`, and `WE_BUILD_REVIEWER_EXPECTATIONS_ENABLED`.

The verify cache checks both the requested command (`suites`) and the executed command (`executedGate`).
A child's standards policy can change the execution plan while keeping the requester's stamp. An earlier
green cannot replace that changed plan; legacy markers without `executedGate` require one fresh run.

A green build gets one cheap correctness/security review of its net diff. Each repair resumes the
original builder and re-runs the gate; at most `maxRounds` repairs occur, with a final observation
and remaining notes carried into the PR body. The cheap self-check opens to independent review,
never directly to acceptance. An unavailable review or red repair gate stops publication; neither is a clear verdict. Disabling self-review keeps the existing
conveyor converge path; Codex skips the extra review. `finalGate=none` keeps Codex ungated and
leaves conveyor's existing verification selection in place; `related` requests diff selection.
Codex `--ephemeral` requires self-review disabled, since an ephemeral builder cannot be resumed.
The self-review adapter accepts at most 512 KiB of UTF-8 diff text. An oversized diff skips the
cheap review and repairs, then opens with an explicit incomplete-review note requiring human
review of the full diff. It is never reported as clear. Unknown input and failed reviewers still
stop publication. `build-safeguards.test.mjs` covers oversized ASCII and multibyte diffs, the exact
byte boundary, and **rejects nonzero reviewer exit with clear findings** / **rejects timed-out
reviewer with clear findings**. The unit gate includes these deterministic adapter tests.
Codex repairs reuse the fresh run's routed model, effort, sandbox, cwd, writable roots, network and
temporary-directory configuration. JSONL logs append across repairs; completion reports include
all turns and the latest final message. **uses full by default and resumes the original builder
within the cap** defends the production wiring, and **builds fresh and resumed argv with identical
routed configuration and directory grants** pins configuration parity.

The delivery wrapper's publication guarantees are defended where it publishes: **opens no PR and
settles a failure when the self-review is unavailable** / **…when the repair gate is red**. A diff
that overflows the bounded read gets the same incomplete-review note as an oversized one (**publishes
the incomplete note when the net diff overflows the bounded read, and reads it hardened**). The
builder can write its lane's git config, so every self-review diff read uses the shared lane pins
(`lane-git-hardening.mjs`) with external diff drivers and textconv off (**never runs a
builder-planted external diff, textconv or fsmonitor command**). A clean filter cannot be switched
off, so Codex's worktree read refuses a checkout that defines one (**refuses a checkout that defines
a filter driver before any worktree read runs it**). The reviewer verdict may be bare or in exactly
one fenced block, with prose around either; anything else is invalid, including a second `findings`
object outside the chosen fence (**rejects mixed fenced and unfenced verdicts** and its variants).
Notes reach the PR body as a
code block, with `<`, `>`, `@`, `#`, `GH-` and `://` swapped for look-alikes: no links, images,
issue references, mentions or machine markers. A blank or malformed `WE_BUILD_*` value is unset and
never turns a safeguard off (**%s=%j keeps the standard default**). With default settings a
Claude-executed delivery self-reviews once instead of running converge and parks `review:pending`
(**with default build settings, a Claude-executed delivery self-reviews once, skips converge and parks
review:pending**). That park replaces only the label-on-green fallthrough: a label the escalation score
asks for still wins (**with self-review on, %s parks at least as strictly as without it**), and an
incomplete self-review parks `review:human`. Codex repair-turn failures and a red repair gate reject the
build (**a real codexDirectTask rejects when %s**). A review run never self-reviews, resumes or gates itself (**a review run never
self-reviews, resumes or gates itself**).

`finalGate` changes the default of every `verify-lane.mjs` mode, including `request` and the
dispatched verify child, so a lane's marker means the same gate however it was requested. Only
`full` replaces the default selection; an explicit `--gate` always wins (**finalGate=%s runs the
whole unit tier only when full**). The full gate is still the default gate: its clean green feeds the
green ledger and the marker keeps the diff's changed files (**a default verify under finalGate=full
records the green ledger and the changed files**). Codex resolves its gate from the same policy
(**a real codexDirectTask with WE_BUILD_FINAL_GATE %s runs the policy gate**); `full` and `related`
need `scripts/verify-lane.mjs`, so a sibling-repo `--dir` without it gets the named failed outcome
`gate-unavailable` (**%s gate in a checkout without verify-lane is a named unavailable failure**),
refused before any Codex spend (**refuses --gate=%s in a checkout without verify-lane before any Codex
spend**), and must pass `--gate=standards` or `--gate=none`; a plateau-app worker brief does that
itself. A dispatched verify child also recognizes a default gate the requester stamped under the
other `finalGate` (**a child under finalGate=%2$s recognizes a default gate stamped under %1$s**). Briefs that append the checklist (fix, ci-heal, the dispatch
tick, the delivery v2 brief and its resume prompts, Codex) do it through `appendBuildRequirements`,
which appends it once and never to a brief that already has it (**brief composers carry the
checklist exactly once**); `worker-brief.mjs` places it inside its own template. Codex callers opt out of self-review with
`--no-self-review` (or `selfReview: false`). With `--json`, a completed run exits 0 and the report
carries its result, so machine callers keep their contract; text mode exits 1 on a failed run or red
gate.

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

## GitHub App daemon fallback probes

Daemon auth uses a 30-minute refresh lookahead (interactive callers keep 10 minutes).
Keep the legacy App cache fresh while it remains the last role fallback; its best-effort
refresh must not change the selected role, applied token provenance, or recorded outcome.
The standalone gh shim recognizes `WE_GH_DAEMON_CALLER` and launchd labels under
`com.we.` / `com.plateau.`. A daemon cache miss gets one synchronous refresh CLI attempt
(90-second timeout), then refuses personal auth by default, including after an App 401.
`gh-app-shim.test.mjs` names this boundary in `bounds on-demand refresh and refuses
after timeout`: intercept the refresh spawn, assert `timeout: 90000`, return
`ETIMEDOUT`, and assert refusal with zero real-gh invocations. No wall-clock wait is needed.
`github-app-auth-env.test.mjs` checks `refreshes legacy after the role applies,
without replacing role outcome` for successful and failed legacy refreshes with minted
and cached role tokens, including
caller/shared status writes and the selected role token's source, installation and SHA-256 hash.
Install the daemon refusal shim before reading keys/caches or refreshing tokens, including
when no App is configured. If installation fails, stop before the daemon tick runs.
The pass daemon and await-verify loop must propagate `GithubAppAuthGuardError` even
though they tolerate transient refresh failures. Replay first-refresh and later-refresh
installation failures with `daemon-gh-guard-refusal` in the daemon soak registry.
Only an inherited `GH_TOKEN` with matching `WE_GH_AUTH_TOKEN_HASH` is trusted as App auth
for github.com. Host flags, repository/URL arguments, `GH_HOST`, `GH_REPO`, and git
remotes or implicit gh configuration naming other hosts refuse by default, even with a fresh public-host App cache;
enterprise credentials and stored logins have no validated provenance here. Conflicting
host hints are handled conservatively. Explicit personal-fallback allows still apply.
Positional repository targets use the same host parser as `-R`, including single-label
`enterprise/owner/repo` and `git@enterprise:owner/repo`; relative REST paths remain public.
Check repository selectors in short-option bundles too (`-cRhost/owner/repo`), and
source repositories in create templates and sync sources. Known content options consume
their attached values; clone destinations and asset paths remain local arguments.
Built-in aliases (including `repo new`) use canonical argument rules. Cover clone `-u`
and repository branch/source option values before classifying positional targets. An
enterprise selector after a boolean bundle must still reach the host parser;
keep the command's boolean shorthands aligned with the supported CLI options.
URL text in bodies, titles, and API fields is content rather than a target host.
Unknown aliases, extension execution, and ambiguous URL-valued options refuse by default;
their command expansion cannot prove which credential gh will select. Short flag arity
must be resolved per command (for example checkout `-q` is boolean, API `-q` consumes jq).
`ghAuth.personalFallback` resolves default → platform → tool →
`WE_GH_AUTH_PERSONAL_FALLBACK`; refusals and explicit allows name the effective source.
The shim file is shared by every caller of a checkout, so it carries only the file policy;
the shim reads `WE_GH_AUTH_PERSONAL_FALLBACK` from each caller at run time. A daemon's shim
directory must be the first `PATH` entry, even when an inherited `PATH` lists it later.
Interactive shells retain their inherited-auth behavior. Dispatched shim settings carry
the daemon marker even for XPC-only parents and when session spawning does not inherit
the parent environment.
Daemon settings construction must throw on a missing binary or failed shim write;
returning no settings would leave the dispatched session outside the refusal boundary.

Exercise these paths with synthetic cache entries, fake gh/refresh executables, isolated
homes and ledgers, and injected minters. Cover `chalbert/web-everything` via `-R`, REST
paths, and a real temporary clone's SSH origin: each selects the worker installation for
canonical owner `web-everything`. Run the touched `gh-app-shim`, `github-app-auth-env`,
`github-app-per-owner-routing`, and `github-auth-policy` suites through heavy admission.

Drain CLI fixtures with fake `gh` binaries use `scripts/__tests__/fixtures/daemon-app-env.mjs`
to seed fresh synthetic App caches under their disposable home. Keep personal fallback refused:
the real guard and per-owner routing must still run before listing, freeze, or merge assertions.
Each fixture invocation also needs a fresh throttle ledger, even when it reuses a home:
fake merges consume the real per-minute write budget and can make later scenarios wait.
The synthetic CLI fixture gives fake writes a larger budget: a three-repo drain provisions
42 labels before merging, exceeding the production budget of 40. Keep accounting and the
auth guard enabled. App-enabled soak worlds must use numeric installation IDs in their
owner map and rotate both the legacy and per-installation caches together; otherwise the
guard cannot route the refreshed token and an expiry probe becomes an unrelated auth refusal.
On an App-token rejection, keep gh's original stderr before the daemon refusal diagnostic,
so callers that read the first error line still report GitHub's actual cause.
The simulator binds its synthetic `sim-token-1` to matching App-token provenance; its fake
GitHub still owns revocation checks. Never enable personal fallback globally in test setup.

### Adoption evidence and compact terminal output

The adoption matrix is read-only evidence and fails closed. Logged revisions must be full object IDs; probes
use a sanitized Git environment (no inherited `GIT_DIR`-style variables, `GIT_NO_LAZY_FETCH`,
`GIT_NO_REPLACE_OBJECTS`, no prompts), run only at a verified repository root, and treat a shallow or unreadable history as
unknown, never as a definitive "no". Corrupt log lines, bad timestamps or refs, unreadable logs or settings, and gaps in
clone discovery mark the snapshot incomplete. Reads are bounded (1 MiB log tail, 50 refs, 20 clones, 500 Git calls) and
omissions are reported as truncation. Clone paths must be absolute. The drain target is the code clone from the
prototype-load settings, not the plist's data clone; tests inject those settings. Matrix and PR table cells strip
Cc/Cf controls and are width-capped; table mode keeps the truncated-listing warning.


Recovery retries must spend their allowance in the head-bound red-team status before the model call.
Keep `retryCount` when writing running/finished statuses: a failed scorecard append is not evidence
that no model ran. Exercise both review-job admission and the shared runner with an append failure,
then verify that a later planner and admission pass refuse another call even after cooldown.
Cross spent counts (1 and greater), bare/object `ran` and `resumed` results, and zero/one/multiple
seat rows in planner and shared-runner regressions. An empty store must never restore a spent retry;
the shared `redTeamStatusWithoutRun` predicate must reject it before placeholder classification.

Policy-clear carry must bind the source acceptance and policy-clear SHA to the trusted re-stamp's
declared `from`, with its `to` equal to the live head. Reuse numbering-carry's `restampRecord` parser.
Keep a three-head regression: acceptance A, acceptance B, clear B, re-stamp A-to-C must not publish
or sync labels; changing only the declared source to B permits carry. Missing or malformed provenance
must also refuse carry. Never infer the declared source from comment order alone.

Retry admission uses an exclusive-create `<status-basename>.retry-1` marker before the model call.
An existing marker refuses with `retry already admitted`; never roll back another worker's status
or remove the marker on failure. Inspect the head-bound evidence before operator recovery.
Interleave two admissions after both read the old status and assert exactly one model call.

### Red-team disposition precedence

`red-team-disposition.test.mjs` pins all ranked pairs in both temporal and input
orders, alongside shared-reader regressions for carry, repost, per-key blocks and
legacy holds. Keep the oracle independent of `DISPOSITION_PRECEDENCE`.
The pure resolver consumes validated live rulings; the thread adapter owns trust,
head/result binding, carry eligibility and ceremony validity. Compatibility notes
beside the table are deliberate: later indexed gate holds retire older releases,
unindexed legacy holds do not. Operator blocks outrank clear-human regardless of
recency; recency breaks ties only within a rank. Clear-human clears only keys
the block does not name. A `NOT sent back` line is an ordinary hold even
inside an operator-block record. Preserve these fixtures when changing liveness;
rank alone cannot describe the historical wire protocol.

## Fixer lane HEAD and lease probe

`fix-run.mjs` retains the `holder` returned by `lane-pool acquire --json`; the ambient
session is not proof that a later lease belongs to the fixer. It checks the on-disk
`.git/.lane-lease` and exact PR head before starting the agent, preserves launcher
merge preparation, and checks ownership again before staging and pushing. Only an
owned, clean lane can be fetched/reset to the pinned PR SHA; recovery rechecks the
lease and HEAD. These checks detect takeover but do not make the allocator atomic.

Merge preparation rechecks the pinned PR head and holder after provider resolution,
immediately before merge, and immediately before either clean or resolved-conflict
merge commit. Drift refuses recovery and mutation, including aborting a merge in a
lane whose head or holder changed. Each merge commit's first parent must equal the
original pinned PR head before its SHA can authorize an agent launch or push.
Inject head and holder changes during provider resolution, fetch and merge preparation
in `fix-run-lane-head.test.mjs`; also reject missing or unexpected first-parent evidence.

Repeated-finding scope resets recheck the original pinned HEAD and acquired holder
immediately before `applyScopeReset`, with lane recovery disabled. Inject holder or
HEAD drift and missing/unreadable lease evidence during awaited provider resolution;
assert refusal before `merge-tree --write-tree`, `read-tree`, replay, commit or push.
Keep an unchanged-head/holder case that reaches the real reset path.

Keep disk-backed lease tests that omit the `readLease` injection: valid and foreign
markers, missing files, malformed JSON, missing holders, JSON null, and read errors
must exercise the production reader at `.git/.lane-lease`. A worktree marker is not
ownership evidence. Use a directory at the marker path for a deterministic read
error, including under root. After an agent leaves edits, change or remove its lease
and assert refusal before file reads for staging, index writes, commit, push, re-arm,
or lane release. Pair these cases with identical edits under an unchanged lease
that reach staging and push, so an inert fixture cannot prove the guard.

For a read-only observation, run
`node scripts/operations/fix-run.mjs --probe-lane-head --lane-path=<absolute lane path> --pr=<PR> --holder=<original acquired holder> [--repo=owner/repo]`.
The probe prints the observed lease, HEAD, current GitHub PR head and pure
`laneHeadCheck` decision. Omitting `--holder` refuses ownership rather than treating
the current occupant as ours. Git optional locks are disabled, so status does not
refresh the index. The live PR head may have advanced since an incident; compare
against the SHA the probe actually reports. Regression files: `fix-run-lane-head.test.mjs`,
`fix-run.test.mjs`, and `fix-run-borrow-dies.test.mjs` under `scripts/operations/__tests__/`.

## Forge worker reservations and Git gates

The fixed Forge wrapper discovers `slot-K` directories and matching system users;
client concurrency settings never define server identities. Pool prepare reserves
`forge-exec-K` through finish using an ops-protected `worker-active-K` directory
bound to run ID and nonce. An interrupted command leaves the reservation closed
until shutdown is confirmed. Age and an empty UID scan alone never authorize
reclamation: acquisition, prepare, execution, and finish hold shared leases on
persistent per-slot `.worker-active-K.writer` inodes. Pruning holds exclusive
leases through scanning and deletion and proves UID process absence before
removing a reservation.
The root supervisor requires reservation evidence and rechecks it under its own shared lease;
a forked child retains that lease through UID drop and closes it before task exec.
Only reservations declaring `writerGuard: 1` participate; historical or uncertain
reservations require operator cleanup. Missing, unreadable, malformed, or incomplete
reservation identity preserves all expired receipts and caches; a known run without
identifiable dependency-lock evidence preserves caches while unrelated receipts
can still expire. The prune tests cover empty historical reservations and resume
age pruning after operator removal. Never unlink writer guard files.
The worker-pool suite pauses a holder before launch, runs the real prune program
against an empty UID inventory, and proves a second controller cannot launch as
that UID. It also tests pruning winning first and refusal at each writer entry.
Hosts without pool directories retain the legacy UID and its own writer guard.
Only `testRoot` fixtures without `testWorkerIdentity` or `testSlotStat` use the
same-UID harness. Production and either explicit isolation injection enforce
worker identity, private groups, slot ownership and identity uniqueness. Pair
injected identities with matching slot stats unless the fixture sets real slot
ownership. Choose synthetic IDs relative to the operator, so host accounts cannot
mask the intended refusal. Model a distinct non-root receipt owner in prune
handoff probes even when tests run as root; otherwise a missing transfer passes.
The privileged fixed wrapper owns metadata operations; tasks and rsync run only
as the reserved UID. Slot roots are ops-owned with the worker's private group
and mode 0710 (traverse only); run containers remain operator-owned. Only work
and sibling trees belong to the worker. Receipts remain ops-only. Worker-owned
0700 slot roots from the earlier pool layout are refused until setup is redeployed.

Every worker ownership handoff opens each component relative to pinned directory
descriptors with `O_NOFOLLOW`, validates ownership, and uses `fchown`. Recursive
handoffs reject hardlinks and hand directories over after their children. Never
use path-following `chown` beneath a worker-writable parent, even for root-owned
children: owning the parent permits replacement of any child entry. Keep the
`forge-ownership.test.mjs` adversarial fixtures in the scoped gate. Its required
Linux test uses actual distinct UIDs through passwordless python sudo to attempt
work/container replacement during prepare and checks the other slot's ownership;
macOS cannot establish that cross-identity proof and skips it explicitly.

Git gates receive hash-bound logical Mac HEAD and per-entry `tracked` evidence
from Mac `git ls-files` in manifest v2. Older manifests (including warm bases)
are refused; rebuild bases or use local/full shipping rather than infer tracking.
Forge fetches current `origin/main` and the exact manifest-bound Mac HEAD from
the fixed public HTTPS origin with a credential-free environment, even when
that object is already cached. Its detached HEAD must equal the Mac SHA. It
stages exact tracked snapshot bytes and deletions, leaves Mac untracked leaves
untracked, and creates no snapshot commit. Unfetchable/unpublished HEAD or failed
Git setup returns protected `started:false`, `reason:git-head-unavailable` evidence;
the client falls back through Mac admission without retrying remote execution.
The separately installed wrapper advertises `gitWorktree:2`; clients refuse v1
(the historical base-HEAD behavior) before rsync and use local admission.
Snapshot inventory pins deletion evidence to that HEAD and refuses HEAD drift
before prepare. A warm base only saves hash-verified file transfers and dependency
work; its SHA/ancestry never defines Git scope. Pin both real guards
(`scanDiffBranchCoverage` and `validateUntrackedDerivedArtifacts`) against
materialized local-bare-origin fixtures, including Mac HEAD behind public main
with working tier bytes equal to main, both full and delta shipping, unavailable
HEAD, and Git setup failures with cached objects. Replace only public transport
in hermetic tests; never contact a developer remote or the network.
No Mac Git configuration, credentials, or verification marker path crosses SSH.
Verification marker authorship stays in the Mac gate driver and requires a
confirmed protected receipt. Run the scoped Forge tests through heavy-admission;
never execute setup in a development lane.

The run-scoped temp allocator canonicalizes its base before creating fixtures: macOS's
`/var` alias must not reach descriptor-relative snapshot copies, which reject symlink
ancestors. Preserve those production no-follow guards; test the allocator with an explicit
symlink alias rather than teaching the copy code to follow links.

Warm manifest reuse requires conservative Git stat evidence: disabled `core.trustctime`,
`core.checkStat=minimal`, or enabled `core.fsmonitor` (including a hook path) requires
`full-scan`. Unreadable or incomplete config evidence also requires that fallback.
Use `git ls-files -f -v -z` for index flags: fsmonitor-valid entries become lowercase
only with `-f` and must be hashed. The fast-manifest tests pin restored-mtime edits
and fsmonitor-valid entries; the offload tests require every final leaf to be read
and hashed when reuse is unavailable.

Git metadata setup runs entirely under an operator-owned 0700 temporary parent;
publish `.git` only after the final privileged Git command. A root-owned `.git`
under worker-owned `work` can still be renamed and replaced by that worker.
Never run privileged Git in `work`, or trust it through `safe.directory`; trust
only the protected clone and warm mirror, and disable `core.fsmonitor` as well
as hooks. The ownership tests substitute a real executable fsmonitor repository
at `update-index` and include a positive payload control. A required Linux test
uses root and an actual worker UID, proving that UID cannot reach the protected
metadata and its substituted config never executes as root; macOS skips this
cross-UID proof explicitly. Cross-UID fixtures that use absolute worker paths
must have traversable ancestors: changing only the fixture root's mode does not
grant traversal through Vitest's private 0700 run root. Allocate those Linux
fixtures under the system shared temporary directory with a privileged
`TemporaryDirectory` supervisor that cleans up on success, failure and child
timeout; keep shared ancestor permissions unchanged. The executable fsmonitor
positive control must still run as the actual worker UID before the attack.
Exercise Git's ownership checks with
`GIT_TEST_ASSUME_DIFFERENT_OWNER` and a mirror with only `origin/main`
(an unborn bare `HEAD` is normal for the warmer). Active base pins must remain
ops-owned and readable by the ops warmer even when the pool wrapper creates them
as root; pin creation and ownership changes stay inside the shared base guard.
### Single-pid process identity evidence

`scripts/lib/proc-identity.mjs` exposes `record` (canonical, null-free identity capture)
and `probe` (positive-evidence tri-state checks). UID remains a captured filter, not
a key for `probe`; legacy `liveness` and `sameIdentity` retain their UID comparison.
Live-process fixtures must supply Linux cmdline and namespace links as well as stat/status.
For an exited Linux leader, `probe` uses stat plus a bounded task census without reading
the namespace link (which can disappear at exit): all exited tasks plus an unchanged
task-ID set in a final census prove dead; any live task yields `unknown` with
`zombie-leader-live-tasks`. Changed, duplicate, unreadable, incomplete or over-budget
censuses yield `unknown` with `evidence-unavailable`; retry or inspect manually.
An initial task-directory `ENOENT`/`ESRCH` can also mean hidepid concealed live workers:
require independent absence confirmation (readable boot ID and signal-zero `ESRCH`)
before returning dead. Test both directory errors with signal-zero success, `EPERM`,
`EACCES`, and other failures (unknown), alongside confirmed absence (dead).
Race fixtures must include a worker spawning a live successor before its own stat is
read as Z/X/x, and a same-count task replacement. Reordering an unchanged set must
still permit dead. `record` still requires the namespace
link to capture a complete identity. Model removed evidence with a read error, not
an empty successful output or ENOENT: those can be positive absence evidence. Exhaustive
subset tests cover both absence and exited-task death as well as live and reused keys.
Race fixtures must change the second per-PID stat read: a changed start time or parent
PID makes `record` fail and `probe` return `unknown`, both with
`identity-changed-during-read`. Exercise each field separately and together so removing
either comparison is detectable. A second-read transition to Z/X/x keeps the captured
identity recordable when evidence is complete; `probe` must consult the task census,
returning dead for all exited tasks or unknown for a live task, never alive.
Linux `listGroup` fixtures must also provide `/proc/self/mountinfo`: a visible leader
does not prove that procfs exposes other users' group members. Require one full procfs
mount at `/proc`, with hidepid absent or explicitly zero, and unchanged mount evidence
before and after the census. Hidden, missing, malformed, unreadable or oversized mount
evidence yields unknown; retry or inspect the mount configuration manually. Keep a
visible-leader/hidden-member regression alongside the omitted-leader case.
The real-host cases require permission to execute `ps` and read the boot UUID on macOS;
a sandbox denying either operation produces unknown and cannot certify those cases.
## Optional early review and delayed fix push

`review.startBeforeCi` admits an early review only with `hasGreenLedger` evidence for the exact
head. Keep ledger IO in the reconcile/publish shells and skip it when disabled. The existing
red-main hold runs before CI-heal caps; test it with a PR behind main (`aheadByOnMain > 0`),
since a PR already containing main has its own failure. `fix.pushAfterCi` waits before the
agent so completed CI failures enter that same repair's fenced context. Its push boundary uses
the same first-held deadline; unreadable evidence waits until the bound, whose fallback is a
normal push. Inject the clock, sleep and checks; reads must be at least 30 seconds apart.
Claude repairs mark verify directly, so the verify harness must apply the same gate to both
early and green-verdict pushes. Persist its previous head and first-held time independently of
verify retries, retain the waiter on read/write failures, and log the timing policy's source.
`await-verify-pass-push-after-ci.test.mjs` and the `claude-fix-push-after-ci` soak scenario cover
this path with injected CI reads, including the bounded fallback when evidence is unavailable.
Completed previous-head failures must reach the fixer in a shared untrusted-data fence before
either push path runs. Persist the handoff and pending delivery together; retain the inventory
across busy/failed resumes and same-session re-marks until the repair push succeeds. A delivered
resume waits for a new mark; exhausted delivery retains the record for operator recovery.
Exercise busy, paused and failed delivery across multiple ticks with both push policies:
zero pushes until delivery and a subsequent re-mark, then a push of the follow-up commit.

## Archive-only host retention (R217)

`scripts/lib/archive-retention.mjs` uses the run store's shared directory resolver without triggering
legacy migration; `OPERATION_RUNS_DIR` wins. Tests use temporary source, Drive and stamp roots.
Run the archive-retention and archive-retention-tick fixtures through heavy admission. Real `tar`
creation/listing proves the happy path; injected post-bundle changes prove truncation, size/count
mismatch and concurrent-source protection. The Drive root must already exist. Never create a local
fallback archive or remove originals when Drive verification fails. An oversized scan retains all
sources and asks the operator to split the source or inspect and raise the scan bound. Stale lock
recovery requires operator inspection, never automatic lock stealing. Archives have no expiry.
The CLI defaults to both kinds; `--dry-run` creates no archive or stamp. Settings live in
`scripts/settings/archive-retention.json` and resolve through the shared policy cascade with sources
included in results and logged by the CLI/health-watch. Host health ticks invoke both kinds; fixture,
dry-run and redirected ticks skip retention. Each kind serializes with a lock and uses a 24-hour stamp.

A durable per-kind manifest beside the stamp records source-relative paths, size, mtime and
identity/ctime for verified bundles, scoped to the source and Drive paths. Retained unchanged
sources are skipped even after stamp expiry; changed sources and session companions remain eligible.
The manifest is read under the invocation lock and atomically replaced after bundle verification,
before source removal or stamp publication. Dry-run reads it without writing state. Invalid or
oversized manifests fail closed and ask the operator to inspect or restore the manifest; the read
and write limits are 128 MiB and `maxFiles` entries. Regression fixtures cross stamp expiry for both
kinds, change size/mtime or restore mtime after a same-size edit, and retry failed verification or
manifest publication. Existing bundles from before manifest tracking cannot be deduplicated by it.

The archiver's invocation lock serializes archivers only; it does **not** exclude run-store or
Claude writers. A stat/unlink pair cannot safely reclaim a mutable source. Source removal therefore
requires the injected `withSourceWriterExclusion(path, criticalSection)` provider to exclude **all**
writers, including already-open file descriptors and atomic replacements, throughout final identity
verification and unlink. The provider must await the critical section and leave it uncalled when
exclusion is unavailable. No production provider exists for Claude's external transcript writers;
the CLI and daily health-watch archive but retain originals, report `filesRetained` and an operator
fallback, and claim zero reclaimed bytes. Do not enable reclamation with a policy flag or quiet-time
heuristic. The operator must arrange actual writer exclusion before reclamation can be wired in.
Regression tests append in the final-stat/removal interval, hold an open transcript descriptor, test
unavailable exclusion, and queue a cooperating writer through the same exclusion used by removal.

### Security condition test shape

Every new bypass-widening condition needs one negative test per conjunct. Security
checks must not be hidden behind `!testRoot` guards; inject identity, ownership,
and other system evidence so hermetic tests exercise the production checks.

Security review checklist: for each new `localFallback(` call site under
`scripts/readiness/`, require a named negative test that reaches that call site,
asserts no remote dispatch, and checks the fallback reason. For a guard after a
wait, occupy capacity, change the evidence during the wait, and release capacity;
pin the expiry boundary and reservation cleanup as well as the refusal.

Standards-conformance review checklist: when remote execution consumes a gate's
output string to detect incomplete inputs, require a producer-side test that runs
the gate's emitting code with a skipping checker and asserts the warning. Test
stdout and stderr, successful non-skipping output, and failed checker output;
injecting a string only into the remote consumer does not cover the producer.

Writer guards shared by root cron and operator controllers must stay on one
private inode owned by the operator. Test first-use creation and migration of
existing root-owned guards, retaining mode 0600 and inode identity. The worker-pool
suite models ownership transfer on unprivileged hosts and includes a Linux/root
integration case that runs prune as root then reserves every slot as the operator.

### Remote diff coverage inputs

Remote coverage fixtures must create the ignored `coverage/coverage-final.json` locally,
then assert its manifest digest and snapshot bytes. Preserve source mtimes through staging
and full shipping so the freshness guard retains local semantics; warm delta assembly
recreates mtimes. Compare coverage scope with an explicit `DIFF_COVERAGE_BASE`, including
a clean HEAD whose changes exist only relative to that base. Invalid refs fall back locally.

The tracked `.claude/agent-memory` bridge is verified against its index blob and
projected from `agent-memory-src/` into regular snapshot leaves. Require `MEMORY.md`
and the complete target corpus; reject unsafe links or incomplete inputs before
transfer. These projected inputs require full shipping.

For remote `check:standards`, observe both output streams for skipped gates,
`no-scope`, and `ENOENT`. A matching protected completion receipt permits a failed
remote result to fall back through local admission; an invalid receipt keeps the
result unconfirmed. The single standards input parity test in `remote-exec.test.mjs`
compares local and shipped discovery of the base, coverage report, and memory index.

## Probe worker timeout teardown

Worker timeout promises allow at most one second for `worker.terminate()` before
rejecting. A synchronous native call such as `execFileSync` can prevent termination
from settling: every timeout-path termination wait needs a separate hard deadline.
Reserve the timeout outcome first so late message, error and exit events cannot
replace it. Await normal shutdown within the grace period so callers can tear down
safely; after the deadline, unreference the blocked worker and reject with the original
timeout error. Shutdown remains best effort after this bound; the worker may survive
until its native call returns or its owning process exits.
`scripts/conveyor/__tests__/probe-worker-lifecycle.test.mjs` covers pending, rejected
and synchronously throwing termination for both runners, plus a real probe blocked in
`execFileSync`. The `probe-worker-termination-blocks-timeout` daemon soak break runs
the equivalent real sweep worker case. Keep these bounded-wait cases when changing
timeout teardown; awaiting termination without a secondary deadline must fail them.

## Forge manifest reuse

`forge-fast-manifest.test.mjs` compares Git-based reuse with a full byte manifest and spies on
file reads. Git status is not sufficient byte evidence for filters, encodings, index flags,
or concurrent writes: hash those leaves normally, and use fresh stat/mode and base blob-size
checks before reuse. Also bind the warm SHA-256 to verified base Git blob bytes: a dirty
warm snapshot followed by a same-size clean reversion must hash the current leaf. Blob
read failures trigger full scans; blobs above the reader limit use normal leaf hashing.
Outside dependency/Git internals, ignored test-shaped files force local fallback, including
files under wholly ignored build directories: Git ignore evidence does not prove exclusion
from the test runner. The named
`refuses runnable scripts/build tests ignored by …` cases cover `.gitignore` and
`.git/info/exclude` for full and delta manifests; `remote-exec.test.mjs`'s
`falls back before transport for a whole-directory ignored test` table pins remote refusal.
Run this fixture and the affected Forge tests through heavy admission.

`forge-manifest-parity.test.mjs` checks full and delta inventories against an independent
filesystem oracle, including hostile `GIT_*` environments, omitted tests, memory bridges,
and replaced file identities. Mutation proofs remove each binding or walk guard separately
and restore it before the next run. Transport fixtures must ship every test-shaped leaf
they create; exact rsync lists and dependency-cache digests include those leaves. Keep
fixture-only Git metadata outside the worker snapshot (or remove it after client manifest
construction), since the runner rejects extra directories.

Stub SSH reachability in manifest-refusal fixtures and reject later transport calls;
real host availability must not decide whether a filesystem guard is exercised.

The named `refuses missing tracked leaves without explicit deletion evidence` table
must cover both Git inventories that retain a missing leaf and inventories that omit
it. Failed, thrown, malformed, truncated, absent, wrong-path and non-deletion evidence
must report `manifest-worktree-mismatch` before prepare or transfer, in full and delta
builds. The `deletion-evidence mutation gate` imports isolated in-memory copies of
the client and removes each cross-check (d) guard independently, including the whole
check; the same bad inventory must escape only in the mutant. Production files are
never rewritten by these probes, and a missing mutation target fails the test.

Keep direct bound-exec missing-cwd cases and the delta builder's default-cwd case.
Row 13 configures a side-effecting fsmonitor hook: require its sentinel to stay absent
and pin `-c core.fsmonitor=false` on every manifest Git command after binding.

Remote discovery may overlap reachability, HEAD and base discovery, but drain every
speculative process before returning fallback. `buildManifest` always lists ignored files
fresh after base-manifest retrieval; ignored tests created during retrieval must still
refuse admission (`forge-offload.test.mjs`). Capture all base lstat metadata before diff/status, attributes
and index flags. Metadata capture uses at most 16 workers and drains failures before
full scanning. Manifest timing substages appear inside the existing stage report;
`inventory-walk` includes `hashing` (do not add those two counters). SSH and rsync
share multiplexing options only after checking a short, owner-only 0700 directory;
unavailable, unsafe or overlong control paths retain ordinary SSH.

## Worker cancellation during module loading

Never terminate a worker while its ESM graph is loading: Node 22 can abort the entire process in
`AsyncModuleExecutionFulfilled`. The verify watchdog disarms its shared deadline before cooperative
shutdown, and `verify-lane` awaits its exit before emitting the final verdict, including timeout and
spawn-error paths. Keep the escape sweeps intact when the deadline already fired.

The health probe worker uses `worker-deadline.mjs`: announce readiness after all imports and before
synchronous probe work, check startup cancellation, and drain worker exit before reporting a timeout.
Module evaluation is allowed to finish during cancellation; the timeout prevents probe work from
starting but does not forcibly interrupt the loader. Do not use this readiness protocol for work
that dynamically imports additional modules after announcing readiness.
`bounded-child-tree-kill.test.mjs` and `worker-deadline.test.mjs` use subprocesses with delayed ESM
imports to exercise cancellation without taking down the test runner on a native loader regression.
Eval worker bootstraps must support inherited `--input-type=commonjs` and `--input-type=module`;
use dynamic imports for dependencies shared by both modes. Keep both caller modes in the watchdog's
heartbeat shutdown matrix, including live handles, in-flight imports and fired deadlines.
The named `hashes Git-clean … leaves` table covers every sensitive attribute:
`filter`, `working-tree-encoding`, `ident`, `text`, and `eol`, asserting actual leaf
reads and equality with full hashing. Include an identity encoding as well as a
byte-transforming encoding so base-blob size/hash checks cannot mask a missing
attribute guard. Same-size hidden-edit cases pin uppercase `S` (skip-worktree),
lowercase `h` (assume-unchanged), and lowercase `s` (both flags).


## Forge synchronous import closure

Keep the Forge runner, client, telemetry, warmer and limits modules free of top-level
`await` throughout their static import graph. Put async CLI execution inside the
guarded async wrapper used by `forge-exec-run.mjs`. The `Forge synchronous module loading`
cases in `forge-client-controls.test.mjs` use native Node require to check that importing
each module succeeds without executing its CLI, including the limits dependency.

## Forge prewarm claim boundary

`forge-prewarm.test.mjs` exercises real private trees and marker files. Model a foreign UID
through injected `lstat` results so ownership refusals run without root. Cover each pool/base/tree
owner and writable-directory check, private tree permissions, marker ownership/mode/link count/type,
and exact SHA/digest marker bytes. Rejection before claim must leave the source intact; verification
failure after rename must remove the destination without following links or exposing its permissions.
The success case observes mode 0700 during verification, inode preservation and single consumption.

Keep the runner reconstruction cases in `forge-offload.test.mjs`: they compare the complete input
digest and overlay/deletion results before worker commands run, including file-to-directory,
directory-to-file and nested deletion, while preserving unchanged prewarm inodes. When changing
these guards, check representative mutations for ownership, marker evidence, private verification,
failure cleanup and parent-directory removal through the heavy-admission queue. Temporary Vite
transform configs can substitute mutations without editing the working implementation.
## Live operator routing fixtures

Review-seat roster fixtures must cover scoped added seats as well as exact keys. Use
`rosterForKey` at every lookup: exact settings-backed contracts win, and other `review-seat:`
keys return the shared added-seat roster by identity so provider caps still apply. Pin primary
and fallback rejection, unchanged preference bytes, and default-zero versus explicitly enabled caps.

`dispatch-routing-policy-io.test.mjs` covers rejecting schema-valid live overrides with no usable
route, retaining the last-good policy and applied-event state, and recovering on a valid edit.
The reader and writer share the route probe and provider caps from `scripts/lib`; keep that
validation ahead of reload events and snapshot mutation. Atomic writer fixtures must assert
unchanged bytes and no leftover scratch/lock files on refusal, including a failed rename.
`dispatch-routing-policy.test.mjs` pins unlisted lens and extra-juror roster identity, rejects
lookalike operation names, and checks last-good retention and recovery for unsupported scoped overrides.
The named `preserves preferences and removes scratch and lock files when rename fails` case in
`routing-override.test.mjs` injects a native rename error in an isolated child, checks the scratch
payload and held lock before failure, and proves cleanup permits the next write.
`routing-overrides.test.mjs` covers the routing reader's last-good snapshot across repo edits and
operator `routingOverrides` changes, including clearing and one event per applied change.
`routing-override.test.mjs` exercises the declared CLI and atomic preference writer with a temporary
`WE_PLATFORM_PREFERENCES_FILE`; never point write tests at the operator's real preferences.
The red-team live-reload case injects `io.readRoutingPolicy` and keeps CLI, quota and reservation
checks in the selection path. Explicit provider selection enables a default-zero provider with a
finite daily cap only when its env cap is unset; explicit env caps (including zero) remain binding.
Clearing restores the repo/env defaults on the next pass. The preference writer holds the shared
file lock across the full read-modify-write; overlapping writer fixtures must preserve both updates.
Non-judged operation declarations may use `provider` and `model` as real inputs. On judged
operations those names remain reserved juror controls; undeclared juror flags still fail closed.
Repo platform files must ignore `routingOverrides` and warn, even when the operator file has no
override; only the operator file (or its explicit replacement) can supply them. In added-seat
fixtures, enable Gemini for one seat and leave other seats inherited or with Gemini fallbacks:
only the enabled seat may use the default-zero provider. Check both synchronous and rejected
event writes: neither may prevent applying or clearing a validated policy. Agy Sonnet aliases
must resolve to an effort-suffixed catalog ID; historical persisted IDs remain readable.
Provider-disable regressions must reach `decideDispatchRoute` with an inherited task such as
`bugfix`, as well as concrete task routes and both prepare branches. Constrained inheritance
refuses with a request for an explicit provider/fallback; it must never delegate an unchecked
provider choice to the evidence router. Added review seats may retain inherited evidence selection
when their supplied candidate list excludes every disabled provider and the critical-work gate is
open. Test missing and unfiltered lists, a closed gate, and mandatory/work routes to keep that
exception confined to added seats. Review settings seats accept only Claude and agy
adapters: test rejection through the CLI before a preference write and retention of last-good
settings during live reload. Disabling the optional agy advisory seat must still allow review
initialization; exhausting a mandatory seat's routes must fail validation.

## CI-heal check evidence (R272)

Check names and required rosters match exactly, including case: a passing `TEST`
never clears a failing or missing required `test`. Only status and conclusion values
are case-insensitive; CodeQL and hold-gate names retain their exact identity.
Every row for a required name must classify green under the shared check-state
predicate. Any failed, cancelled, stale, unfinished, unknown or unreadable row blocks
successful admission, even beside a success. No source tier, workflow run, attempt,
id or timestamp can discard evidence. Compatibility exports `latestAttempts` and
`latestRollupAttempts` retain all rows without ranking or mutation.
The regression suites retain timestamp, metadata, source-tier, undated and input-order
scenarios and require mixed evidence to fail closed. CodeQL failures always block
`not-a-ci-break` and gate-only excusal, including when CodeQL is outside the required
roster and the drain's CodeQL switch is off. A merge-gate name is excusable only when
every non-green row is positively classified as a review hold; each row is classified
independently, so one held job cannot excuse another job's failure or unfinished state.
The escalation CLI reuses `excusePrMergeGateHolds` for head-bound hold evidence, with
`prChecksOptions` supplying hermetic readers. A failed PR or roster read permits recording with a warning; an unreadable merge-gate verdict or freeze read still permits `needs-human` with a warning, but keeps the red-check refusal for `not-a-ci-break`.
Classification errors, including malformed rollup identities, propagate to the CLI's error handler and abort
before any escalation comment is posted. The read-error fallback never catches refusal classification.
`ci-heal-escalation-mark.test.mjs` pins both preflights and both CLI outcomes with nameless evidence beside a required failure.
## Remote client import failures

Importing a host-selected remote client executes its top-level code. Neither an import exception nor
a missing or non-callable `runRemote` export establishes that remote work never started: preserve
exit 124 and the operator instruction to confirm termination before retrying. Changes to this boundary must run
`scripts/readiness/__tests__/heavy-admission-remote-client.test.mjs` and
`scripts/readiness/__tests__/heavy-admission-remote.test.mjs` through the host heavy-run queue.
Only the real host preferences file may select `heavyAdmission.remote.clientPath`; fixtures use
`loadAdmissionPolicy({ home })` for this trust boundary, never an env-selected executable path.
An env-selected preferences file keeps its other settings but strips this leaf after last-good fallback,
logs the ignored path with bounded diagnostics, and uses a separate policy cache key from host selection.
Keep the named regression **refuses local rerun when import starts work before throwing**: it observes
an initialization side effect before the throw and requires exit 124 without local fallback.
Also keep **refuses local rerun when import starts work before a missing runRemote export**: it
observes initialization before export validation fails and requires the same refusal.

Remote override provenance runs after client invocation as a detached, best-effort task. SHA lookup
uses asynchronous Git so it cannot block the execution timer; neither its one-second bound nor the
100 ms persistence bound belongs on the client path. The never-resolving SHA/event regressions require
client invocation and success before advancing fake time. Provenance assertions must await background
writes explicitly while preserving once-per-process logs and change-only events.
Identify path changes with the persisted SHA-256 `pathKey` of the raw resolved client path plus the SHA;
sanitized display paths can collide. Legacy state without `pathKey` emits fresh provenance once, while
event details keep only sanitized paths and SHAs.
The real CLI drains tracked provenance only after the remote decision, for at most 1500 ms, with
an unref'd timer cleared on completion. Set the remote exit code before awaiting so natural exit
also preserves nonzero results. Keep native CLI regressions for fast event/state persistence and
never-settling provenance both with and without another live handle; fake timers separately prove
the drain cap, oversized/invalid budget clamping, timer cleanup, and removal of settled tasks.

The persistence deadline cannot cancel a filesystem open blocked on a FIFO. Before reading override
state, use `lstat` to reject symlinks and special files, and skip reads above the 4096-byte cap.
Open descriptors with `O_NONBLOCK | O_NOFOLLOW` where supported and verify the descriptor is regular.
Publish through an exclusive sibling temp file plus rename, checking the destination is still absent
or regular before replacement. Unreadable or special state skips persistence while the client runs.
The native FIFO regression in `heavy-admission-import-boundary.test.mjs` must let its subprocess exit
naturally under a timeout: observing the client result alone misses a live, abandoned filesystem request.
For the default override event append, resolve the destination with `daemonEventsPath`, then open it
with `O_WRONLY | O_APPEND | O_CREAT | O_NONBLOCK | O_NOFOLLOW` (guard optional flags). Check the
opened descriptor with `fstat` and write only to a regular file, always closing it. A path `lstat`
before a blocking append leaves a swap-to-FIFO race that the persistence timeout cannot cancel.
Skip errors and non-regular destinations without recording the pair as emitted; injected event
writers retain their IO seam. Keep the existing parent-directory restriction. Compare the emitted
JSON line byte-for-byte with `appendDaemonEvent` for the same input and timestamp.
Keep the separate native daemon-events FIFO case, including client success and absent pair state,
alongside symlink, directory and invalid-parent cases and real missing/existing regular-file writes.

## Admission imports and daemon closures

Heavy admission is imported by review, promotion, self-sync and smoke machinery. A computed import
anywhere in its static closure makes those consumers fall back to treating unrelated code as relevant.
Keep the host-selected client loader command-only: `remote-client-import.cjs` is required lazily at
remote execution, outside that static closure and Vitest's ESM transform. Preserve the bundled client's
relative resolution when `clientPath` is unset. Location-only event consumers import `handoff-path.mjs`,
not the handoff CLI with its Git publishing dependencies; the CLI re-exports the same path function.
`heavy-admission-import-boundary.test.mjs` proves the complete closure, actual bundled execution for
unset settings, lazy adapter loading in native Node, and real override event/provenance writes.
Run it alongside the remote-client, daemon closure/staleness, live-smoke and shape wiring regressions
through the host heavy-run queue; do not weaken their complete-closure assertions.
## Manual daemon pass (R247)

`node scripts/operations/run.mjs manual-daemon-pass --daemon=review --pr=123 --repo=owner/name --reason="daemon unavailable"`
runs one existing single-PR dispatch from the module's checkout, resolved from `import.meta.url`
independently of the caller's working directory. It reuses
`assertOperatorCliFresh` with automatic fallback disabled so a manual pass cannot silently move
to another checkout. The event and PR comment identify the executing checkout HEAD as `sha`.

Review uses `dispatchReviewByMode`; red-team uses `dispatchReviewJob({ redTeamOnly: true })`,
which owns the existing seat dispatch, result writing and gate application. Both belong to the
review daemon for health admission. A healthy, non-quarantined daemon refuses unless
`--force-while-healthy` is supplied. Unknown health or corrupt quarantine evidence refuses even
with that flag; restore the daemon-status readers before retrying.
Dispatch leaves `root` to the shared dispatcher's module checkout default, as the review daemon
does. Its lane-checkout refusal still applies; run from an up-to-date control clone when refused.

Fix refuses with “no entry point”: `reconcile-fix-dispatch.mjs#dispatchFix` requires the prepared
daemon plan and `fix-run.mjs#runFixCli` requires a session, ref and prompt file;
`runReconcileFixDispatch` sweeps a repository. Verify also refuses: `verify`/`createChecksRunner`
accepts a checkout, the verify daemon calls `verify-dispatch.mjs#runVerifyDispatch` to scan pools,
and `runLaneGate`/`createVerifyGateJobs.launch` require prepared lane/head/marker evidence.
Neither daemon exports a single-PR entry point accepting repo/pr. These refusals remain explicit until their owners
expose reusable entry points; do not reconstruct daemon planning in this operation.

Admitted passes post a manual R247 PR comment only after dispatch returns, so dispatch refusals
(including the real job/session lane-checkout guard) leave no comment. Every sink attempt, including
freshness/health/no-entry-point refusal, appends one `manual-daemon-pass` JSONL event using the
shared handoff event path (`WE_DAEMON_EVENTS` overrides it in tests). Events retain `at`, `kind`,
`repo`, `pr`, `daemon` and add `ts`, `reason`, `sha`, `result`. Invalid CLI arguments are rejected
by the generated declaration/parser before the sink runs. The effect is non-idempotent, so an
indeterminate run must be inspected before starting a new pass. Focused proof lives in
`scripts/operations/__tests__/manual-daemon-pass.test.mjs`; operation enumeration and declaration
map coverage live in `runner-freshness.test.mjs` and `http-adapter.test.mjs`. `scripts/codemap.mjs`
discovers script modules dynamically and has no hand-maintained operation list.

## Forge coverage timestamp parity

Remote transport stubs must answer the worktree-binding probe before inventory or SSH;
use `fixtures/forge-bound-git.mjs` in injected-Git fixtures so transport-failure tests
reach their intended run/finish branch. Keep their exact dispatch and no-local-rerun assertions.

Coverage report rewrites must restore the timestamp captured from the open source file.
Re-reading the staged timestamp and converting it again can truncate another microsecond,
making coverage older than a source with the same original mtime. The absolute-path coverage
table in `scripts/readiness/__tests__/remote-exec.test.mjs` pins equal fractional mtimes and
compares staged nanoseconds before its `cpSync` transport loses sub-millisecond precision.

## Forge tracked-symlink parity

Forge projects stage-0 index symlinks to regular files; it never ships or follows a
symlink during transfer. The link's working bytes must hash to its index blob OID,
all parent and target directories must be real directories, and the target
must stay inside the repository and contain tracked content. This rule applies to
every path, including the memory and skills bridges. Untracked, changed, unmerged,
escaping or incomplete links refuse with `unshipped-symlink`. Cyclic projections
also refuse; expanding links share the walk's count/byte limits and report
`manifest-walk-limit` when those limits are exceeded.

Apply the path policy to every projected leaf, including nested aliases and normalized
`node_modules` components. Excluded aliases refuse with `unshipped-symlink` in full
and delta builds. Only the exact `.claude/skills/` and `.claude/agent-memory/` prefixes
are exempt from the dot-directory exclusion; their remaining path components still
must pass policy. The named policy-excluded tracked-alias table includes credential,
dot-directory, NFKC and invisible-character variants and checks refusal before transport.

Manifest refusals keep the reason code separate from `detail`: the offending path
relative to the checkout, decoded as lossy UTF-8 and kept on one line. Preserve
this detail through verification wrappers and remote fallback; heavy admission
logs it with the shared `oneLine` sanitizer and bound.

Symlink-detail fixtures must use valid manifest byte paths: invalid UTF-8, tabs,
ESC, DEL and Unicode line separators can exercise lossy decoding and sanitization,
but LF/CR are rejected by `pathParts` before the inventory symlink check. Keep
separate negative cases for LF/CR that assert rejection before filesystem inspection.

Projected entries retain their regular `sourcePath` and link evidence for staging
reverification. Delta manifests always transfer projected leaves, including unchanged
ones: their alias paths have no corresponding regular Git blob for digest assembly.
Keep the full/delta filesystem oracle, negative admission cases and staging-swap
case in `forge-manifest-parity.test.mjs`, plus the real manifest/stager/worker fixture
in `remote-exec.test.mjs`. Run these and the affected fast-manifest/offload suites
through the host heavy-admission queue.

## Forge ignored leaves under tracked directory links

Ignored non-test regular files under a tracked directory link's source are omitted
at both ordinary and projected paths. The filesystem cross-check uses the fresh
ignored byte inventory; it still refuses untracked symlinks, missing projections
for non-ignored regular files, and policy-excluded source leaves, even when ignored.
`forge-manifest-parity.test.mjs` rows 20–25 and 31 cover those boundaries for full and
delta manifests, including ignored runtime JSON beside a `node_modules/.bin` symlink
and the earlier `ignored-test-file` refusal. Row 20 omits ignored runtime data at the
excluded `.claude/skills` alias only when the leaf is not source code and the remainder
after the link prefix is not policy-excluded; row 31 retains omission parity through an allowed alias.
Check every projected alias before skipping an ignored leaf, including nested link
projections: a non-test source can become a test under `tests/`, or acquire an
excluded component. Rows 26–30 pin those refusals and benign nested omissions for
full and delta manifests. Alias expansion shares the filesystem walk's limits and
refuses with `manifest-walk-limit` (local fallback) when that budget is exhausted.


## Forge ignored test discovery

Git ignores do not define Vitest discovery. Full and delta manifest admission omit ignored
test-shaped files only when Vitest's own `createVitest('test', options)` and
`globTestFiles(filters)` prove they are absent from the selected files. A native Node child
resolves `vitest/node` from the lane, forwards its environment, discovers the actual config
and workspace, and closes the context without running tests. Mirror the CLI's `TEST=true`,
`VITEST=true` and default `NODE_ENV=test` prelude (preserving an explicit `NODE_ENV`):
`createVitest` alone does not set them. Admission forwards the run's
argv and environment through full and delta paths. Only `npx vitest run` / `vitest run`
are understood, with `--config/-c`, `--root/-r`, `--dir`, repeated `--project`, and positional
filters. Reporting accepts `--reporter`, `--silent` and bare/boolean `--coverage` only;
unknown options, other commands and missing argv retain the existing ignored/unshipped-test
local fallback. Repeated scalar selection flags also retain fallback.

The listing has a 60-second SIGKILL deadline and a 4 MiB output bound. Child/listing errors,
timeouts, oversized output, invalid JSON or paths retain local fallback; use local execution
through heavy admission when evidence is unavailable. Keep native-child regressions for
config/workspace discovery and no test execution, plus injected full/delta parity and refusal
cases. Warm bases have no run argv and export tracked Git entries only; policy exclusions
still refuse test-shaped entries, as do commandless manifest callers.

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

Admission reaper fixtures pass through the real telemetry parser: use `easternTimestamp()` for
timestamps and include receipt `stageMs: {install, run}`. Reaper-only fixtures do not prove that
health admission accepts the same sample. Release logs keep their original five-key JSON and
byte order for markers without new provenance or exit evidence; PID accompanies new evidence,
and unknown optional values are omitted rather than logged as null or `no-exit-record`.

R1017 (under R1012): for a host-bound marker with a provably dead local owner, preserve the
marker grace and death-sample margin. With a persisted 32-hex nonce and fresh integer receipt
(including 97/254) still listed active, finish on the owner's behalf before claiming/removing
the marker. Bound SSH and output; failed or timed-out finishes retain capacity, log once and
retry no faster than 30 seconds per run. Legacy nonce-less markers keep their existing rules.
For 97/254, finishing on behalf requires a persisted numbered worker slot (`forge-exec-N`, N >= 1), since only that finish path proves descendant cleanup; missing, legacy or malformed slots keep the marker held.
A run-less dead-owner marker keeps the existing zero-active and 120-minute-plus-skew orphan
rules. R1017 also permits release when the marker is at least `RUNLESS_DEAD_GRACE_MS = 15 * 60_000`
old and a fresh sample is at least that grace after first-seen-dead. Require `activeRunIds` and
a parseable start in `recent` for every unclaimed active id, strictly outside the inclusive ownership
window `[marker.at - CLOCK_SKEW_MS, diedBy + CLOCK_SKEW_MS]`. Any in-window null-code or 97/254
receipt retains the marker.
Both the 15-minute and bounded-orphan checks skip active IDs bound to another marker in the
same root (inline or owner-matched `.run` sidecar), whether its owner is live or dead. This
permits recovery when that run has fallen out of the newest-50 receipt window. Unclaimed
active IDs missing from `recent` still fail closed; receipt-window guards remain unchanged.

The accepted residual risk is a request the dead client already dispatched that Forge starts
MORE than 15 minutes after owner death. Observed start lag is about one minute; client SSH
calls are short and bounded by `ConnectTimeout`. The dead client never issues `run`, so only
a prepared run can exist. The grace is an operator ruling, not an enforced remote start
deadline. If this residual occurs, the consequence is one extra concurrent Forge run until it
finishes (Forge enforces its own cap). No run is killed and no result is lost: the owner is dead
and cannot collect one. Pin that accepted behaviour explicitly: release at 15 minutes even if
a delayed request starts later and remains active at 28 minutes.

Missing IDs, receipts or parseable starts still fail closed; stuck-slot signals and
operator-confirmed cleanup remain the fallback while capacity is retained.
Cancel-finish waits for the supervisor, then proves the reserved UID empty before clearing a stale
`executing` lock; unprovable cleanup holds the marker and raises one needs-you alert naming the slot (throttled per slot).
Keep regressions for the exact seven-active-run live shape released at >=15 minutes, 14-minute retention, unknown evidence,
finish retries and legacy state. Markers carry optional caller/session/parent PID/command-word,
lane and PR tags; `.exit` records synchronous best-effort exit or signal evidence. Release logs
and stuck-slot detail carry these tags plus the exit record, or `no-exit-record` for a client
that had no chance to log. Remove `.exit` with its marker; operator-confirmed cleanup remains
the fallback when evidence stays incomplete.

For selected `npx vitest run` phases, verify-lane's remote admission plan rewrites plain
arguments to `npm run test:unit -- ...`; spawn that planned command without a local slot
or `WE_HEAVY_ADMISSION_HELD`, so the nested wrapper owns remote execution and local fallback.
Local decisions keep the raw command and slot. Env-prefixed scanners, JSON-report guards,
isolated retries and unsupported shell syntax stay local. Keep both planning and actual
spawn regressions in `scripts/__tests__/verify-remote-routing.test.mjs`.
When a phase planned without a local slot exits non-zero without proven local execution,
confirm it once with a second fresh Forge run of the planned command, with `WE_FORGE_GATE_DISPATCH`
and no local slot or `WE_HEAVY_ADMISSION_HELD`. The nested wrapper falls back to the Mac only
when Forge is unreachable. Log `confirming on Forge`; on fallback also log
`Forge unreachable for the confirm run - confirmed on the Mac`. Use the second run's verdict
and failure inventory, including a green result overriding the first red. Preserve that run's
own `ranOn` and record `remoteRedConfirmed: 'forge'` for remote/mixed execution, or
`remoteRedConfirmed: 'forge-unreachable'` for local fallback. Never acquire a confirmation
slot in verify-lane or write a `remote-red-confirm` fallback row.
A valid `local-fallback` report already supplies the local verdict: preserve its exit code and
failure details without another confirmation, including for edited tests and with isolated retry off.
Untouched failing files remain eligible for the existing one-time isolated retry, which acquires
its own local slot. The nested wrapper must report a local completion even when its policy/load
decision changes after verify's remote preflight, or admission takes a bypass branch.
The `proven local fallback verdict` regressions execute production `timedRunGate` with injected
child IO for Vitest and standards under both admission modes, offering a passing second child
to catch an unconditional retry into green.
Both the remote-planned first attempt and its Forge confirmation set `WE_FORGE_GATE_DISPATCH`,
without a held local slot. Local phases clear even an inherited dispatch flag so nested wrappers cannot
dispatch remotely while the local slot is held. Pin both environment shapes in the spawn fixture.
Each attempt retains its own phase timeout; admission heartbeats belong to the slot owner. Remote green never
reruns; watchdog timeouts and signal failures (including shell-inferred signals) retain their
infrastructure verdict without confirmation. Exit 124 never reruns and remains
infrastructure/unconfirmed until an operator confirms remote termination. Cover green,
red, 75 deferral, 124, watchdog timeouts, signals and local-planned red,
including Forge confirmation failure, unreachable-Forge local fallback, and preservation of command flags in the spawn fixture.
Set `WE_VERIFY_PHASE_ADMISSION` to `0`/`1` in fixtures and assert the recorded admission mode;
`false`/`true` strings are ignored and can silently exercise the default twice.
Wrapper eligibility checks the entire command: compound commands, redirections and shell
expansions retain a local slot and `WE_HEAVY_ADMISSION_HELD` for their full execution scope.
Direct wrapper paths must resolve to `scripts/readiness/heavy-admission.mjs` in the target
checkout; foreign directories with the same suffix retain local admission.
Keep the compound-wrapper table for both npm scripts and the direct heavy-admission wrapper,
plus the native spawn regression that observes HELD on both the wrapper and following scanner.
Plan each phase's own command even when admission spans the whole gate; never reuse an
earlier phase's rewrite for standards, scanners or guards. Check all original arguments with
Forge's existing `allowedCommand` guard. Unsupported flags, including `--passWithNoTests`,
`--testTimeout` and `--hookTimeout`, keep the original command and local admission. Never strip
flags to qualify a command for Forge: its nested wrapper may fall back locally, where losing
the requested timeouts or empty-match behavior changes the verdict. Keep the timeout-preservation
regression for both whole-gate and per-phase admission, including quoted flags. Remote location evidence
requires a non-empty receipt ID and an integer exit code; a dispatched attempt with an incomplete or missing report is location `unknown` (never local), and any unknown phase makes the overall location unknown.
Observe report reads in tests: reject an already oversized file before reading content, and
request at most 65,537 bytes even if a regular file grows after its size check.
Keep allowlisted reporters; unknown options retain the original local command and admission.

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

A settled integer receipt can coexist with its run in `activeRunIds` when finish has not removed
the prepared/running state. `runVerdict` treats that as finished, except supervisor codes 97/254,
which retain their conservative cleanup rules. Preserve the reaper's death margin and two-sample
guards. After a client failure, a local rerun needs the current execution's run ID and a fresh
telemetry sample taken after the failure; a bounded probe that stalls or returns incomplete evidence
keeps exit 124 and the marker. Telemetry confirms termination, never a verified remote success.
Regressions live in `forge-slot-markers-per-run.test.mjs` and `heavy-admission-remote.test.mjs`.

After a run timeout, allow 180 seconds for cancellation (`WE_HEAVY_TIMEOUT_CANCEL_WAIT_MS`,
validated as a nonnegative integer and capped at 300 seconds), probing fresh per-run telemetry
about every two seconds while also waiting for the executor. R989 accepts a late receipt-verified
`mode: 'remote'` answer with an integer code 0–254 only inside this cancel wait and only when
its string `run` strictly matches the non-null execution run recorded by `onRun` for this dispatch;
return its exit code (including failures), record it, and release the slot and both marker files.
Missing/mismatched run IDs, invalid codes, executor rejection and other ambiguous answers must
not stop telemetry probes. A client signal still wins. Only confirmed cancellation
or fresh `finished` telemetry permits local fallback; deadline expiry
keeps exit 124 and both marker files. Busy unit-run rejections preserve `forge-busy`;
only a matching finish from protected `prepared` state certifies `started: false`.
A protected `running` state and plain non-sibling snapshot rejection remain unconfirmed.
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

Memory-warn regression cases must distinguish missing free-memory evidence (hold, even with flat swap)
from missing swap growth (admit when free memory is readable and clean). Only pressure level 2 may relax;
level 3 and unknown levels above 1 still hold. Exercise the sampler's unrounded bytes ratio at 19.96% and
20%, and verify checkout-local/per-call warn overrides only tighten the resolved settings. Environment
variables remain the operator settings layer. Scoped coverage lives in `memory-available`,
`resource-sampler`, `resource-admission`, `resource-gate`, and `heavy-admission` tests.
Keep the shared pressure/floor decisions in the import-free `memory-warn-corroboration.mjs`:
read-only operations reach them via `resource-policy` and must never inherit the measurement module's IO imports.

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


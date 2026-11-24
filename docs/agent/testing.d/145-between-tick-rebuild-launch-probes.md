## Between-tick rebuild launch probes

`daemon-rebuild-force-adopt.test.mjs` distinguishes strict readers from between-tick launch
ownership: only `launchOnly && asJob && !adoptOnly` with early/recovery provenance leaves
the force watch untouched. Inline strict evidence refusals still probe health and execute
owed rollback, including refusals during reader validation before preparation. Assert the
`state-unreadable` result and unchanged unrelated corrupt bytes alongside the rollback;
between-tick refusal cases preserve the watch bytes and running head even when rollback is owed.

`daemon-rebuild-early-launch.test.mjs` runs with Node's test runner and also registers with Vitest.
Its hermetic `withSelfSync` probe drives the injected watcher timer between ticks, with real job-store
queue tests and no Git/network children. `daemon-rebuild-early-timing.test.mjs` advances separate
reader-lock, planning, smoke-slot and smoke clocks so planning/smoke time cannot masquerade as queue wait.
The early-launch setting is off by default; `daemon-rebuild-settings.json` `earlyLaunch.entries`
opts in an entry such as `health-watch.mjs`. `WE_DAEMON_REBUILD_EARLY_LAUNCH=0|1` overrides enablement;
`WE_DAEMON_REBUILD_EARLY_DEBOUNCE_MS` overrides the trailing debounce. Missing or oversized event
history defers to tick-start. The declared self-sync rebuild path must resolve to job mode;
`WE_DAEMON_REBUILD_AS_JOB=0` or an inline setting prevents early launch. The watcher only queues a job; ready candidates still adopt at tick boundaries.
`launchOnly` must run the shared adopt-only preparation with `readyOnly: true` before queuing, so sticky
rejections and smoke retry/backoff refusals still apply. `daemon-rebuild/__tests__/rebuild-job.test.mjs`
checks persisted refusal state through real preparation with controlled Git IO, including clean admission.
Early admission and timed recovery use `readRebuildStateStrict`: only ENOENT is empty state.
The declared schema requires every top-level slot, with explicit null for an unused slot.
For present records the admission inventory is: adopted head/inputsKey/mainSha/applied/at;
inProgress pid/host/startedAt/prevHead/target/inputsKey/mainSha/applied/verified; quarantine
prevHead/reason; unverified head/prevHead; building token/pid/host/startedAt/target/inputsKey/path (adoptOnly is optional);
held reason/since/updatedAt; rejected inputsKey/reason/at. Backoff retryAt/attempts and
harnessBroken/externalOnly/envLoad/dispatchSmoke booleans are typed when present. retryAt may be null;
transient rejection flags require a date. Legacy env-timeout holds may omit retryAt.
busySkippedTrees/forceUnverifiedTrees contain strings; smokePassed entries require key/tree/passedAt;
pinnedNotified is a string-valued map. Applied entries require ref/sha and a nonempty string for any pinnedFrom.
Strict ready pins require sha and pinnedFrom to be distinct full 40-hex SHAs.
Record readers validate shape; locked adoption separately proves the registered ref/PR,
exact held remote tip, latest rebuild-authored second-parent adopted SHA and audit membership.
Malformed records or unreadable proof refuse as `state-unreadable`, preserving evidence.
A readable record with expired proof is discarded as `ready-pin-stale` before any match,
including exact/same-tree matches, so a new smoke can proceed. Moved tips, retired overlays,
changed HEAD and revoked audit membership must not become permanent tick-start holds.
The real-Git table in `daemon-rebuild-ready.test.mjs` covers tip, registration and HEAD churn;
the pin-provenance table retains every audit/history refusal at the adoption boundary.
`daemon-rebuild-audited-tip.test.mjs` advances main while audited A is retained with
`pinnedFrom` naming unaudited B. Ready-pin proof must accept A's evidence and reject
missing A evidence even when B is audited. The `rebuild-evidence-compatibility` soak
replays adoption of that prepared candidate with no extra smoke and excludes B's content.
Ready records require prevHead/tree/passedAt/kind/forced and adopt.finalSha/inputsKey/mainSha/applied.
Fallbacks also require forInputsKey/dropRefs/failed, with ref/sha/pr on each drop (pr may be null).
Optional diagnostic ready metadata remains typed when present.

The job fixture injects EACCES/EIO and corrupt JSON, and a recursive table deletes and mistypes
every required field, asserting refusal, untouched bytes and no job. Historical incomplete files
are deliberately refused until operator repair; the legacy reader retains its compatibility behavior
for consumers outside a rebuild scope. Producers preserve legitimate legacy field absence rather than admission
inventing defaults. The pre-lock strict state read is an early refusal filter only. Launch-only
preparation re-reads and validates state under the clone write lock, using that locked snapshot
for every check; an unreadable locked read refuses as `state-unreadable`.
The ready snapshot still passes through `admissionEvidence`; missing handoff refuses.
The early/recovery race tests publish rejection, hold, lease or corrupt state between admission
and lock acquisition, assert the second strict read holds the lock, and verify newer evidence
survives refusal. Interrupted-rebuild bookkeeping defers to tick-start. Clean admission remains covered.
Between-tick admission never takes
a transient build lease, avoiding a second read-modify-write during lease release. An up-to-date
ready-only probe also leaves ready cleanup to the next tick: the fixture plants corrupt ready evidence
during planning and asserts that the indirect cleanup reader neither rereads nor deletes it.

The launch-path fallback audit covers state, prepare, rebuild, rebuild-job, recovery and
overlay-adoption. Rebuild-state coercions are confined to the legacy reader; strict validation
covers prepare's recovery/array/map/backoff defaults. Ready adoption and its lazy overlay-event-log
reader cannot run in launch-only admission: a ready snapshot defers immediately. Consumed-job and
finished-result bookkeeping use the strict precheck snapshots (including the finished-job roster);
later result/ready probes remain strict. Between-tick launches return before the wrapper's
best-effort pending-adoption notifications and force-watch. Remaining settings defaults choose
bounded standard policy; Git/process proof defaults retain holds or deny mutation; diagnostic
and best-effort logging defaults do not authorize launch or erase persisted evidence.
Job admission also strictly reads pending adoptions before job bookkeeping. Any `state-unreadable`
refusal logs the repair requirement and skips pending-adoption notifications/rewrites, including at
tick-start; the mixed overdue/malformed-record fixture asserts that the wrapper preserves file bytes.
Only explicit `launchOnly: true`, `asJob: true` early/recovery launches outside adopt-only skip
best-effort wrapper notifications and force-watch, including after successful queueing. Tick-start and unknown launch sources retain force-watch health checks and rollback
even when carrying `launchOnly: true`; strict early/recovery provenance defers them
also for inline and adopt-only callers.
Both rebuild soak wrappers also require an unconditional positive test, so a behavioural `fixPresent`
regression cannot turn the protected behaviour into an expected failure.

Timed rebuild recovery is covered by `daemon-rebuild-recovery.test.mjs` (Vitest)
and the `rebuild-held-recovery` soak break. Environment timeout
backoff lives on `state.held`, leaving candidate rejection semantics intact. Legacy holds
without a deadline derive one from `updatedAt`/`since`; invalid timestamps stay held for
operator repair. Recovery settings use the shared policy cascade and the detached job
queue retains its in-flight guard before considering any recovery trigger.
Recovery uses the existing rebuild minimum interval (including jitter), even after a ready-recorded
job; a `still-rejected` adopt-only result never launches recovery. The overdue threshold must be
at most 15 minutes (the default); settings may only shorten it, and oversized settings clamp
to that maximum and log the originating policy layer. The unit fixture drives the real ready-only rebuild through a
timeout and a later passing smoke on unchanged inputs; the soak fixture checks queueing only.


### Detached rebuild evidence policy

Evidence refusals emit exactly one `rebuild-failed` coordination event with reason
`state-unreadable` for every launch provenance, including between-tick launches.
The event never authorizes pending-adoption or rebuild-state rewrites. Keep the
fault/provenance matrix in `daemon-rebuild-events.test.mjs` and the request-failure
ledger regression in `daemon-rebuild-request-failures.test.mjs` in the affected gate.
`withSelfSync` uses the strict state reader for quarantine checks: ENOENT allows a
normal tick; read, parse or shape errors visibly skip with `state-unreadable` and
preserve the file. A rebuild returning that reason also skips before restarting
or ticking. `daemon-self-sync.test.mjs` pins these holds and real daemon loggers.
Its maintenance descendant assertions accept a reaped PID only when `kill(pid, 0)`
returns ESRCH; live PIDs still require the existing `ps` stopped/zombie proof, and
permission failures never count as proof of exit.

Early watcher jobs carry `early`; both timed env-timeout retries and overdue-registration
recovery jobs carry `recovery`. Only the ordinary tick-start launch carries `tick-start`.
`rebuildClone` uses strict evidence for early/recovery launches; ordinary tick-start and
inline rebuilds retain compatibility readers unless `WE_DAEMON_REBUILD_STRICT_EVIDENCE=1`.
Keep fleet-wide strict validation opt-in until captured, anonymised deployment files have
passed replay; the current writer-contract corpus is synthetic, not a fleet capture.
The strict async scope covers indirect legacy consumers as well as prepare, smoke, lease renewal,
cleanup and ready publication. Keep evidence entry points connected to this scope when adding
readers; do not add a child-specific permissive fallback. Only ENOENT means empty, including after queue admission and after waiting for the preparation lock.
The build lease lives in the strictly validated rebuild state. Ready, pending adoptions,
overlay registry/events, starvation, force request/watch, conflict wakes and pending drops
also refuse malformed or unreadable evidence; only ENOENT is absent. Writes revalidate evidence
before replacing or deleting it. Refusal requires operator repair of the persisted evidence.
For deployment schema incompatibility, `WE_DAEMON_REBUILD_STRICT_EVIDENCE=0` restores legacy
evidence readers for ordinary tick-start and inline rebuilds, including job admission and
the `withSelfSync` state check. Compatibility logs `strictEvidence=false` with source
`default` or `env`. Missing and invalid switch values retain the compatibility default.
Early/recovery provenance remains strict, even with this override; unknown provenance also
remains strict. Launch-only admission is strict even when provenance is omitted.
Tick-start compatibility ignores corrupt job records and treats unreadable consumed/results
as empty/null, preserving the legacy adoption and queue paths. Strict job-store refusal
reports `state-unreadable` and preserves bytes instead of reporting a live job.
Force-watch rollback safety and ready adoption
proof remain enforced. `evidence-readers.test.mjs`, `daemon-rebuild-early-launch.test.mjs` and
`daemon-self-sync.test.mjs` exercise the switch at each entry point.
`daemon-rebuild/__tests__/review-compatibility.test.mjs` tables torn job/consumed/result
evidence across tick-start, early and recovery, absent/disabled/enabled strict mode,
all documented early/recovery overrides, and nonzero-jitter recovery spacing.

**Evidence publication standard:** never use `writeFileSync` directly on a complete
JSON evidence document parsed by a strict reader. Use `writeJsonAtomic` (validated
same-directory temporary file then rename), or an equivalent existing atomic writer.
This includes the consumed-job ledger and job result sidecars. Atomic publication
prevents partial reads; it does not replace the existing locks for read-modify-write
state or serialize multiple ledger writers. Append-only event logs keep their own protocol.
`daemon-rebuild/__tests__/evidence-readers.test.mjs` tables both provenances against each reader
and corrupt JSON, EACCES and wrong shapes, at entry and after waiting for the write lock,
asserting unchanged bytes. It also pins indirect legacy-reader inheritance and late ready
corruption before publication/cleanup. The recovery suite pins both recovery launch origins
and successful strict-child smoke/ready publication. Real CLI child probes prove entry refusal before Git IO for every launch provenance.


Strict early/recovery preparation defers these mutators to tick-start: index-lock
unlink; interrupted/unverified recovery state writes and rollback; quarantine reset;
`finishPendingSwaps` (registration removal, events, swap deletion, needs-you reports);
`healWrongBranch`; `ensureSafeToMove` (claim/store recovery); `repairCloneRefs`;
sidecar pruning; `detectOverlayStale`; `persistStackBases`; conflict-wake mark/clear;
pin-notice, hold and up-to-date state writes; `kickAutoRebase`; registration removal
and overlay events; ready cleanup, forced-watch transitions and ready/skip-unrelated
finalization. Alert-file appends, wrapper pending-adoption rewrites/notifications,
force-watch checks/rollback, and starvation writes also defer. Fetch and deterministic
plan object creation remain part of rebuilding; admission never claims a lease, while
the detached child may claim its actual build lease before smoke. If an abandoned
lease still records a candidate path, the child returns `readonly-job-mutation-due`
(`abandoned-build-cleanup`) and leaves the lease intact for tick-start cleanup.
The actionable-swap fixture asserts registry, event, swap and abandoned lease bytes
survive child preparation, then proves ordinary preparation removes the candidate.
The `rebuild-evidence-compatibility` soak also checks removal of the real Git worktree
registration after an early claim defers, and tick adoption despite torn job sidecars.


### Tick-start pin and evidence security

`daemon-rebuild/__tests__/pin-provenance.test.mjs` checks the exact per-ref audit gate
membership of pinnedFrom, lowercase 40-hex syntax, revoked and other-ref evidence,
and unconditional ready pin history proof before adoption. Never replace the gate with a truthy or
format-only pin check. Tick-start defaults to the same strict record readers as early/recovery;
`evidence-readers.test.mjs` tables child and inline entry/locked refusal for malformed,
wrong-type, wrong-shape and EACCES evidence, preserving pending notifications and bytes.
Legacy records may omit backoff fields, env-timeout retryAt and lease adoptOnly.
Force-watch health checks and owed rollback still run outside between-tick launches
before strict admission reads, even when unrelated admission evidence refuses. Only
the watch record is required for that bounded scope. Corrupt ready/state evidence
must neither suppress rollback nor be erased or replaced with empty evidence: use
the intact watch's last-good target with the locked, clean-tree rollback helper when
normal finalization cannot preserve those files. Admission afterwards still refuses
adopt/launch with `state-unreadable` and emits its failure once. Preserve arrival health
checks for newly installed watched builds without counting an existing watch twice.
An in-memory owed rollback still refuses a second force request during that call,
including when the watch merely confirms HEAD is already at last-good; preserve
the existing request-consumption test alongside rollback-before-admission ordering.
Keep isBetweenTickLaunch and the once-per-tick watch tests; the force-adopt matrix
covers corrupt ready, rebuild state and pending adoptions, including owed rollback
and byte-preserving between-tick refusal.


### Persisted rebuild producer compatibility

Strict rebuild schemas must accept the records production writers leave on disk, without
adding plan evidence. A force watch can store only `lastGood.head`; its rollback through
`finalizeRebuild` writes swap/adopted records without `inputsKey` or `mainSha`. Interrupted
recovery can promote those unknown adopted plan keys as null. Pre-fix swap records omit
`verified`; recovery treats that absence as unsmoked and rolls back before rebuilding.
Keep those fields typed when present and keep head/swap identity, timestamps and applied
evidence mandatory. Production holds always write `since` and `updatedAt`: complete a
hand-written fixture missing them instead of making the validator permissive.
`rebuild-job.test.mjs` covers producer-shaped round trips and wrong types;
`daemon-rebuild.test.mjs` proves absent-verification rollback with real Git;
`daemon-rebuild-force-adopt.test.mjs` proves head-only force-watch rollback.

The result writer emits `reason: null` when child output has no reason. Strict job
admission accepts that value, consumes the terminal job once and reports `no-result`;
other non-string reasons and corrupt JSON still refuse without consuming evidence.
Keep round-trip coverage over absent, undefined and null child fields in
`daemon-rebuild/__tests__/rebuild-job.test.mjs`.

Environment-timeout holds record `inputsKey` and `target`. A changed value bypasses
the old plan's deadline and resets its attempt count if smoke times out again.
Legacy holds keep their deadline unless a recorded identity proves the plan changed.
`daemon-rebuild-recovery.test.mjs` covers input-only and target-only changes through
early admission, plus unchanged and legacy deadlines.

Legacy overlay registries may omit audit metadata and clone identity; overlay refs
remain required and present fields remain typed. Audit events may omit a single ref
(for example `auto-rebase-swapped`); per-overlay consumers must match their own ref
before using an event as evidence. Aggregate discard notices retain their full schema.
`evidence-readers.test.mjs` replays legacy shapes and production state, ready, pending,
registry and event writer output through `validate`, preserving file bytes. Its corpus
is reconstructed from writer contracts; captured deployment files can extend it.
The `rebuild-evidence-compatibility` soak replays null-result consumption, legacy
registry/events and changed-plan admission through the durable queue. It also publishes a
real smoke-passed pinned ready candidate, advances the overlay tip, and requires tick-start
to discard it, smoke once and adopt a fresh build. The job tests
snapshot the entire state directory on early/recovery lock contention and successful
preparation, including starvation evidence; tick-start remains the positive control.

Simulator runtime snapshots must also carry `.githooks/pre-commit` with its executable
mode: real lane provisioning verifies the tracked, runnable guard before handing out a
lane. The rebuild soak scenarios exercise this prerequisite through actual provisioning.
For real-process teardown assertions, signal-zero ESRCH proves the descendant was reaped;
other results still require the process-state check so live or unreadable processes never
count as stopped.
Cold imports of whole daemon module graphs belong in bounded suite setup (`beforeAll`),
so the skipped-tick assertion retains its own deadline under a busy runner.

Ready-candidate discard escalation writes an aggregate overlay event with `need`,
`target`, `reason` and `refs` (possibly empty), rather than a single `ref`. Exercise
`reportDiscardedCandidate` and `appendOverlayEvent` together when validating that shape;
missing or wrongly typed identity/audit fields still refuse without changing bytes.
Pin proof is checked under the preparation write lock before adoption. After the verified
reset, write guards continue to validate record shape, allowing adopted-state writes and
ready cleanup even if a registration or remote tip changes. The pin verifier also recognizes
an exact target with a matching durable verified swap or adopted record; its tests cover
both transitions and missing, corrupt, mismatched and revoked evidence.
The real-Git ready-adoption test asserts `readyToAdoptedMs` from the recorded pass through
preparation and the post-reset adopted-state writer. Shipped-setting tests use the real JSON:
early launch stays disabled with empty entries and health-watch, and env-timeout delays are
exactly 10, 20, 40 and 40 minutes with no environment or tool overrides.


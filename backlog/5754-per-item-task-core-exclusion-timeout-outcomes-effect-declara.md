---
bornAs: xs4ewgh
kind: story
size: 8
parent: "5767"
status: open
scope: ["we:scripts/lib/daemon-jobs.mjs", "we:scripts/lib/__tests__/daemon-jobs.test.mjs", "we:scripts/lib/daemon-jobs-runtime.mjs", "we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs", "we:scripts/lib/daemon-item-tasks.mjs", "we:scripts/lib/__tests__/daemon-item-tasks.test.mjs", "we:scripts/operations/job-record.mjs", "we:scripts/operations/__tests__/job-record.test.mjs", "we:scripts/operations/daemon-jobs-proof/run-proof.mjs", "we:scripts/operations/daemon-jobs-proof/demo-daemon.mjs", "we:scripts/operations/daemon-jobs-proof/noop-job.mjs", "we:scripts/lib/__tests__/daemon-item-tasks-proof.test.mjs", "we:scripts/operations/daemon-jobs-proof/__tests__/run-proof.test.mjs", "we:scripts/operations/daemon-jobs-proof/__tests__/demo-daemon.test.mjs", "we:scripts/operations/daemon-jobs-proof/__tests__/noop-job.test.mjs"]
dateOpened: "2026-10-10"
preparedDate: "2026-10-10"
preparedAgainstSha: "39c69a1e81cf41d5897272dd17d73e9991c5b5d5"
tags: []
---

# Per-item task core: exclusion, timeout, outcomes, effect declarations and a recording accessor

Slice S2a of the async-daemons epic. Add we:scripts/lib/daemon-item-tasks.mjs on the existing detached job core. This is new task orchestration, not a replacement job store. Task kinds use `defineJobKind`: planning runs in `readonly-tree`; rebase/push runs in `mutates-tree`. Inputs are `{daemon, repo, item, snapshotPath, snapshotAt, schedulerGeneration}`; generation is diagnostic, not a fence. Facts pass through a recording accessor; execution is read -> plan -> claim -> (per effect: probe -> fence -> act -> mark). Exclude every non-terminal task with the same `(kind, repo, item)` under a short file lock, independently of its sequence number. Preserve the logical task identity `<kind>:<repo>:<item>:<seq>`, but encode the on-disk run ID to satisfy the existing run-store validator (see Design).

Add elapsed `timeoutMs` enforcement (task default 300000 ms) to the existing reattach/stop path at we:scripts/lib/daemon-jobs-runtime.mjs:288-322; that path currently handles heartbeat stalls, not elapsed task deadlines. Outcomes remain `acted | nothing-owed | superseded | deferred-claim-held | deferred-read | failed`; only `failed` spends the task failure budget. Preserve the existing launch-attempt counter used to authenticate children. Persist result sidecars `{v:1, outcome, effects[], recordedReads[], timings, gh}` and emit `task-timing`. Compose job-slot admission with the existing resource service and policy cascade; acting concurrency is one per repo (O14). No daemon switches to tasks in this slice.

## Effects: declared inputs, applied-probe, server-side precondition

| Effect | Fence re-reads live | Already-applied probe | Server-side precondition |
|---|---|---|---|
| Fix / ci-heal worker dispatch | head sha, base sha, open, draft, `review:*` and hold labels, required checks, latest review id, claim | run store: worker run with this `effectId` in launching/running/done | none (the claim covers it) |
| Promote draft (`gh pr ready`) | head sha, draft, every required check green on that head, withdrawal mark | live `isDraft == false` | none |
| Label write | open, the label set the decision relied on | live label present/absent | none (idempotent) |
| Comment | open, the marker comment id | marker comment with the `effectId` exists | marker dedupe |
| Rebase / push (mutates-tree) | head sha, base sha | remote head equals the planned result sha | `--force-with-lease=<head>` |
| Drain merge (S6a) | live fix or ci-heal claim | already merged | `--match-head-commit` |

Residual window, stated plainly: fence-then-act is a check followed by an action, not an atomic guard, except where a server-side precondition is named. Other daemons are kept out by the per-PR claim; humans and CI changes are today's risk; the next tick reconciles.

## Done when

- [A1] **Executable** — the core covers per-item exclusion, `timeoutMs`, outcomes, effect declarations (inputs, probe, precondition), intent/applied marks, the recording accessor, timing lines and the `gh` budget assertion.
- [A2] **Crash test (a)** — scheduling the same `(kind, repo, item)` twice with a different seq is refused (J2-13). Fails before, passes after.
- [A3] **Crash test (b)** — every field read in `plan` is in the effect's fence list, and every effect declares a probe (J2-9, J2-24).
- [A4] **Crash test (c)** — kill between `act` and `applied` for each effect kind: the resume probe finds the effect and does not repeat it (J2-4, J2-24).
- [A5] **Crash test (d)** — a PR is merged or drafted between plan and fence: no effect happens.
- [A6] **Crash test (e)** — inject a change between fence and act: behaviour matches today's and the next tick reconciles (J2-8, J2-17).
- [A7] **Crash test (f)** — a task that ignores SIGTERM: its timeout escalates to SIGKILL, it is confirmed gone, and only then is its claim released (J2-1, J2-19).
- [A8] **Live** — the proof harness we:scripts/operations/daemon-jobs-proof/ runs one double-schedule (launched once) and one over-time task (killed once).

## Non-goals

- [N1] No daemon adopts the core here (S3, S4, S5, S9 do).
- [N2] No lease change (that is L1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Validate kind, canonical repo slug, positive item and sequence; derive bounded filesystem keys from the complete tuple rather than lossy punctuation replacement. PR titles and bodies never reach an id or path.
2. **Truncated reads** — A missing snapshot, one older than `snapshotMaxAgeMs`, or an unreadable sidecar ends the task `deferred-read`; nothing acts on a partial read.
3. **Shared state files** — Enqueue runs under the per-item file lock; records are written atomically (tmp + rename) under the daemon jobs root returned by `daemonJobsDir` in we:scripts/operations/run-store.mjs:143 (R2).
4. **Fail closed** — A fence mismatch ends `superseded`; a probe error ends `failed`, without invoking the affected action or any later effect. Earlier applied effects remain recorded. Unreadable facts produce `deferred-read`; unreadable owner liveness keeps the claim and slot held.
5. **Identity scoping** — The exclusion key is `(kind, repo, item)`, so the same PR number in two repos never collides; the handle is host:pid:procStart so pid reuse does not match.
6. **State over time** — Timeout escalates SIGTERM -> SIGCONT -> SIGKILL with confirm-gone; tasks from an older process or generation are adopted on reattach, not fenced.
7. **Who wrote it** — Only the role holding a run record resumes it (R14); records carry the launching handle.

## Progress

- Test-scope repair: the previous scope paired all three proof sources only with the planned integration test we:scripts/lib/__tests__/daemon-item-tasks-proof.test.mjs. Corrected scope retains that integration coverage and adds a planned matching test for each source: we:scripts/operations/daemon-jobs-proof/__tests__/run-proof.test.mjs, we:scripts/operations/daemon-jobs-proof/__tests__/demo-daemon.test.mjs and we:scripts/operations/daemon-jobs-proof/__tests__/noop-job.test.mjs. Source evidence: scenario dispatch and exit status at we:scripts/operations/daemon-jobs-proof/run-proof.mjs:130-139, enqueue and loop configuration at we:scripts/operations/daemon-jobs-proof/demo-daemon.mjs:38-57, and effect execution at we:scripts/operations/daemon-jobs-proof/noop-job.mjs:12-22 require distinct coverage. The implementation goal and size 8 remain unchanged.
- Preparation premise check: the goal is not already delivered. The existing core declares job kinds, caps slots, runs checkpoints and stops stale-heartbeat processes; it has no per-item task module, recording accessor or task outcome protocol. Evidence: we:scripts/lib/daemon-jobs.mjs:60-76, we:scripts/lib/daemon-jobs.mjs:120-138, we:scripts/lib/daemon-jobs-runtime.mjs:156-162 and we:scripts/lib/daemon-jobs-runtime.mjs:369-427. The existing core's delivering commit is `4d34c9fad`; it does not deliver S2a.
- Old premise: colon-separated task IDs could be passed directly to the job store. Corrected premise: we:scripts/operations/run-record.mjs:47 and we:scripts/operations/run-record.mjs:74-75 permit only alphanumeric/dot/underscore/dash IDs of at most 128 characters, and we:scripts/operations/run-store.mjs:149-151 validates them before forming a path. Keep the logical tuple and effect identity, encode the physical ID, and leave that validator unchanged.
- Old timeout citation was we:scripts/lib/daemon-jobs-runtime.mjs:273 (now the tail of the tick-clock helper). Correct integration is `reattachTick` at we:scripts/lib/daemon-jobs-runtime.mjs:288, with stop-before-transition at we:scripts/lib/daemon-jobs-runtime.mjs:302-321. `stopHandle` already escalates TERM/CONT/KILL at we:scripts/lib/daemon-jobs-runtime.mjs:242-261. Fresh heartbeats currently defeat any elapsed timeout because classification only checks heartbeat age at we:scripts/lib/daemon-jobs.mjs:120-138.
- Old scope listed four source files and no tests or proof implementation. Corrected scope keeps those four, pairs each with its existing or planned test, and adds the three existing proof files plus a planned harness test. The proof currently offers only `kill9` and `sigstop` (we:scripts/operations/daemon-jobs-proof/run-proof.mjs:130-131), enqueues by ID (we:scripts/operations/daemon-jobs-proof/demo-daemon.mjs:38-40), and appends a side-effect line without an applied probe (we:scripts/operations/daemon-jobs-proof/noop-job.mjs:12-20). Those files must change to prove A8 rather than merely naming their directory.
- Size **5 -> 8**: evidence expands the implementation beyond an enqueue wrapper. Launch authentication increments `job.attempts` at we:scripts/lib/daemon-jobs.mjs:235-241 and checks it in we:scripts/lib/daemon-jobs-runtime.mjs:382-387; failure-only task accounting needs a separate field. Admission is currently only per-store plus a serial lane (we:scripts/lib/daemon-jobs.mjs:181-202), so repo-scoped acting admission and durable timeout state also need integration. The proof changes above add real-process coverage, not just unit fixtures.
- Boundary check: W1 (#5757) owns worker run allocation, claim hand-off/CAS and quarantine health episodes. This slice supplies claim/effect adapter seams and exercises them with controlled stores; it does not edit production worker dispatch or claim formats. The settled detached-job rule is we:docs/agent/platform-decisions.md#daemon-jobs. No dependency-edge change is proposed.

## Design

### Task contract and storage

Add an opt-in task descriptor in we:scripts/lib/daemon-item-tasks.mjs that composes `defineJobKind`, snapshot reading, a planner, claim acquire/release hooks and named effect adapters. Declare `timeoutMs`, `snapshotMaxAgeMs`, acting status, resource-admission kind and the permitted GitHub-read budget. Resolve task settings with `cascadePolicy` from we:scripts/lib/policy-cascade.mjs:176 and retain its source-layer log. Keep old job kinds and old records valid; extend optional task fields and their validation in we:scripts/operations/job-record.mjs, without changing the five existing job lifecycle statuses.

Validate the full tuple and retain it in task metadata. Derive the physical run ID as `task-` plus a SHA-256 hex digest of a canonical JSON array `[kind, repo, item, seq]`; derive the exclusion lock from `[kind, repo, item]`. Persist the logical task ID for logs and `effectId = taskId:effectName`. Names of effects must be unique and stable across retries. Do not sanitize by simply replacing punctuation: distinct repo names must not collapse to one key.

Enqueue under `withFileLock` from we:scripts/lib/atomic-json-file.mjs:154. Within the lock, scan the task-owning daemon store, reject any queued/launching/running matching tuple, allocate the next sequence and create the record through `enqueueJob`. Queued/backoff work counts as non-terminal. A corrupt record makes the lookup inconclusive and refuses enqueue; it is never absence. A terminal predecessor permits a new sequence. The existing single scheduler/role owns each kind; cross-role PR exclusion belongs to the claim adapter, not to adding generation to the task key. Keep lock sections synchronous and limited to local reads/writes.

Persist task metadata, plan, effect intents/applied marks and terminal result in the locked run record; use atomic result sidecars as a projection, not a second authority. A resume/collector can recreate a missing sidecar from the durable result. Place sidecars in a dedicated results subdirectory so a torn sidecar is not confused with a job record. Existing store classification of non-record sidecars is covered at we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs:49-73.

### Recorded reads, claims and effects

Expose facts only through a recording accessor that records field path, source identity, source timestamp, observed value and age at read. Include nested fields, absent-field reads and collection membership; return immutable values so later mutation cannot change the recorded comparison. Reject missing, malformed, incomplete or over-age snapshots with `deferred-read` before claim/action. Age is based on the actual source timestamp, checked against task input, never the time the file was copied.

The planner returns no effects (`nothing-owed`) or a durable ordered plan. Validate every effect declaration before claiming: name, complete input/fence list, applied probe, action and explicit precondition descriptor (including explicit `none`). Conservatively require every recorded planning read in each effect's fence list, matching A3. Reject undeclared reads before any effect. Production adapters must not bypass the accessor by handing raw snapshots to the planner.

Acquire the claim after planning; an occupied claim ends `deferred-claim-held`. Recheck ownership at every effect and record write. For each effect, write intent before action, probe already-applied state, then obtain one complete live PR read for that effect's fence and compare every declared PR input. Claim and local-store inputs are checked at their authoritative local source alongside that read. Probe errors fail closed. A mismatch ends `superseded`; an unavailable/incomplete live read ends `deferred-read`. A positive applied probe records the effect without invoking its action. After a successful fence, pass the declared server-side precondition into the action and durably mark applied.

On resume, load the saved plan and intents; never generate new effect names or IDs for the same task. Probe every unresolved intent before repeating its action. Do not mistake an intent itself for proof that an effect happened. Worker-dispatch probes search the worker run store by `effectId`; local effects must not spend GitHub reads. Other probes and server preconditions follow the effect table above. Tests supply adapters for all six effect classes; production worker-launch integration belongs to W1, and production merge integration belongs to S6a. The existing noop append is not crash-idempotent; its proof adapter must use durable keyed effects so act-before-mark recovery can actually be observed.

The claim adapter reports retained versus transferred ownership and releases only the current owner. Normal completion releases task-owned claims; a worker hand-off retains the worker's claim. After task death or timeout, the parent invokes cleanup only after confirmed owner death. Failure to prove death preserves exclusion and the slot and reports the held owner; W1 owns production quarantine/health projection. The accepted fence-to-act window remains as stated above: test it honestly without promising atomicity for label/comment/ready effects.

### Timeout, accounting and admission

Extend the pure classifier/reattach plan in we:scripts/lib/daemon-jobs.mjs and enforcement in we:scripts/lib/daemon-jobs-runtime.mjs. Persist the resolved timeout and per-launch start/deadline when entering `launching`, after code preparation (the existing launch-grace regression is at we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs:256). Queue wait does not spend task runtime. A fresh heartbeat does not extend the deadline. A reattached process keeps its original deadline; diagnostic scheduler generation never resets it. A resumed launch receives its own bounded deadline. Host-sleep suppression still applies to heartbeat staleness; an elapsed deadline is checked independently when the host resumes.

A timed-out live handle enters a durable stopping state within task metadata while retaining its non-terminal job status, claim and slot. Reuse `stopHandle`, but require a definite local `dead` result before cleanup; foreign or failed probes are not evidence of death. Recheck record ownership/launch identity under the record lock before transitions; a concurrent success or replacement must not be overwritten. A failed stop remains held for another tick. Do not release/relaunch an unclaimed timed-out launch using only its bare spawned PID: retain it until its full handle or death can be established. Late child claims must refuse a launch already marked stopping.

Keep `job.attempts` as the launch-generation counter used by the existing child protocol. Add task failure accounting separately: `acted`, `nothing-owed`, `superseded`, `deferred-claim-held` and `deferred-read` finish the task without spending that budget; exceptions, confirmed crashes and timeouts count as `failed` once per launch. Retry failed tasks with the existing backoff/checkpoint model up to the resolved limit, preserving effect IDs; a final failure ends the job as failed. Non-task jobs retain current attempt semantics. Persist the task result before final lifecycle completion so a crash in sidecar/log output cannot rerun actions.

Compose `admitJobs` with `admit({kind})` from we:scripts/lib/resource-admission.mjs:91. Require an explicit resource kind from the existing vocabulary in we:scripts/lib/resource-policy.mjs:15-20, rather than passing arbitrary task names and silently falling back to build policy. Resource hold/wait leaves the task queued, without a launch or claim. Enforce acting concurrency independently from `codeMode`: a readonly-tree task can still write labels or dispatch workers. Under a short shared repo admission lock, count acting reservations across daemon task stores and atomically reserve a launching slot; release the lock before snapshot preparation/spawn. Unknown/corrupt occupancy holds admission. Reconcile abandoned reservations through the same launch/timeout lifecycle. The default is one acting task per repo, while planning tasks and other repos can proceed within their caps. Consume the existing cascade/resource services without changing their policy implementation.

Instrument all adapter GitHub reads (including probes and fences), with planning from a valid snapshot costing zero. The descriptor supplies the allowed read budget; assert before the next read would exceed it, retain the count and reason in `gh`, and fail without that read/action. This core does not guess S1's production budget. Record per-stage and total elapsed timings, effect outcomes and reads in the v1 result, and emit a `task-timing` line keyed by task ID, repo, item and launch. A log/sidecar failure cannot erase an applied mark.

## MVP

1. Extend optional record metadata/validation and pure job policy for deadlines, failure-only task accounting and repo acting reservations, preserving existing job behavior.
2. Add the per-item module: validated identity/locking, cascade-backed descriptor, snapshot accessor, effect declaration validation, claim hooks, durable plan/intent/applied/result state and measured read/timing output. Integrate it with the existing child runner and parent reattach path.
3. Exercise all six effect contracts through fixture adapters, including act-before-mark recovery, ownership loss and incomplete reads. Keep production daemon entrypoints, worker claim formats and leases unchanged.
4. Extend the three scoped proof scripts with `double-schedule` and `timeout` scenarios using disposable stores and real detached processes. Preserve the existing `kill9` and `sigstop` scenarios. All A1-A8 remain required; real daemon adoption is explicitly later work.

## Test plan

- **we:scripts/lib/__tests__/daemon-jobs.test.mjs** (existing; source we:scripts/lib/daemon-jobs.mjs): deadline despite fresh heartbeat, deadline boundary, host sleep, preserved deadline on adoption, retry/failure counters distinct from launch generations, exactly-once failure charging, legacy records/kinds, per-repo acting limits across kinds, and planning/other-repo admission.
- **we:scripts/operations/__tests__/job-record.test.mjs** (existing; source we:scripts/operations/job-record.mjs): old-record compatibility, valid optional task metadata/results, malformed deadlines/counters/outcomes/effect declarations, and a physical task ID that round-trips through the unchanged run-store validator.
- **we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs** (existing; source we:scripts/lib/daemon-jobs-runtime.mjs): timeout invokes TERM/CONT/KILL before cleanup/requeue; a child that continues heartbeating and ignores TERM still times out; failed/foreign probes and failed kills hold claim/slot; old-owner callbacks and late claims cannot write; completion during stopping is not overwritten; shared acting reservations race safely; resource hold does not launch. Retain current checkpoint, PID-reuse, snapshot and sidecar tests.
- **we:scripts/lib/__tests__/daemon-item-tasks.test.mjs** (planned; source we:scripts/lib/daemon-item-tasks.mjs): two independent enqueue processes race with different sequences and exactly one succeeds (A2); queued/backoff duplicates refuse, terminal predecessors allow, repo/item/kind identities do not collide, unsafe input/corruption refuses. Cover missing/stale/incomplete snapshots, nested/absent reads, undeclared input and missing probe/precondition rejection (A3), all six outcomes and read budgets. For each effect-table row, persist action output, interrupt before applied, resume from disk and assert one action and one recovered applied mark (A4). Cover merged/drafted and other input changes between plan/fence (A5), claim refusal/loss/transfer, changes between fence/action with explicit residual-window expectations (A6), and crash boundaries around durable result/sidecar projection.
- **we:scripts/lib/__tests__/daemon-item-tasks-proof.test.mjs** (planned; matching test for we:scripts/operations/daemon-jobs-proof/run-proof.mjs, we:scripts/operations/daemon-jobs-proof/demo-daemon.mjs and we:scripts/operations/daemon-jobs-proof/noop-job.mjs): launch the actual harness in temporary roots with bounded waits; assert double-schedule and timeout evidence, scenario failure exit codes and finally-block child cleanup. Timeout uses a fresh-heartbeating, TERM-ignoring child to distinguish deadline enforcement from the existing stale-heartbeat scenario (A7-A8).

- **we:scripts/operations/daemon-jobs-proof/__tests__/run-proof.test.mjs** (planned; source we:scripts/operations/daemon-jobs-proof/run-proof.mjs): scenario selection including the new double-schedule and timeout scenarios, aggregation of failed assertions into a nonzero exit, bounded wait failures and cleanup on success/error. Retain coverage of the existing kill9 and sigstop scenarios.
- **we:scripts/operations/daemon-jobs-proof/__tests__/demo-daemon.test.mjs** (planned; source we:scripts/operations/daemon-jobs-proof/demo-daemon.mjs): disposable store and snapshot setup, task enqueue inputs and duplicate refusal, explicit timeout/heartbeat settings reaching the loop, and restart adoption without another launch. Verify scheduler shutdown leaves jobs available for adoption; the test's final cleanup owns remaining children.
- **we:scripts/operations/daemon-jobs-proof/__tests__/noop-job.test.mjs** (planned; source we:scripts/operations/daemon-jobs-proof/noop-job.mjs): durable keyed fixture effects, an applied probe after act-before-mark interruption, checkpoint recovery without duplicate actions, and the timeout fixture continuing to heartbeat while ignoring TERM until KILL. Bound waits and confirm child cleanup.

Execute focused Vitest files and `npm run check:standards` only through the host heavy-run queue, using we:scripts/readiness/heavy-admission.mjs in `run --` mode. No live GitHub mutation or production daemon store is needed for these regressions. Implementation must show the new tests fail for the missing guarantees and pass after the change; preparation alone does not claim those guarantees pass.

## Proof plan

Use the extended we:scripts/operations/daemon-jobs-proof/run-proof.mjs, invoked by the queued proof test, with an isolated daemon jobs root and snapshots materialized from the implementation checkout. Record the checkout SHA/diff identity, settings and source layers, task tuple/sequence, physical run IDs, complete process handles, record timelines, claim events, effects, result sidecars and `task-timing` lines.

1. **Double schedule:** release two independent schedulers concurrently for the same tuple with different sequences. Observe one enqueue refusal, one non-terminal record and one launched child/effect. Restart the driver while that child lives; it must adopt the same handle without changing the deadline or launching another child.
2. **Elapsed timeout:** use an accelerated explicit timeout and a child that keeps its heartbeat fresh but ignores TERM. Observe deadline -> TERM -> CONT -> KILL -> confirmed-dead -> claim release/failure accounting, in that order. Allow only one failure attempt in this scenario so there is exactly one killed launch. Verify the exact handle is gone and no later tick launches an extra child.
3. **Recovery:** repeat act-before-applied interruption with durable fixture effect stores, resume the same task/effect IDs, and count exactly one action for each effect class. Save a fence mismatch trace with zero subsequent actions and a fence-to-act mutation trace documenting the accepted residual window.
4. **Failure control:** inject an inconclusive owner probe; observe no claim release or replacement admission. Restore probing, confirm death, and observe cleanup. Assert all spawned test children are cleaned up even if a scenario fails.

Archive evidence with the delivery run/PR, including failures; a unit-test pass alone is not the live proof. This is a core proof with controlled adapters, not evidence that fixer/reviewer/builder production adoption has shipped.

## Follow-ups

- W1 (#5757) connects the tested worker-dispatch/claim hooks to production run allocation, hand-off-before-spawn, CAS ownership and quarantine health episodes. Do not move those edits into this core slice.
- S3/S3t (#5759/#5765), S4 (#5763), S5 (#5764) and S9 (#5755) adopt the core, supply their production effect adapters and policy/read-budget values, and prove their own shadow/live behavior. S1's production shared-read budget is required for fixer adoption, not for building a budget assertion with controlled inputs here.
- L1 (#5762) supplies scheduler lease-generation ownership checks; S6a (#5745) supplies drain merge fencing. Preserve their separate ownership and the accepted fence/action window.
- Raising acting concurrency above one requires the already-required measurements and cascade change; blue-green adoption stays with epic #5766. No new policy fork or new dependency edge is introduced by this preparation.

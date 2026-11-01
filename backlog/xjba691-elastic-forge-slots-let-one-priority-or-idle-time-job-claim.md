---
kind: decision
size: 8
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/forge-gate-options.mjs"]
dateOpened: "2026-11-01"
preparedDate: "2026-11-01"
preparedAgainstSha: "7a8f51570435bc14cb2e13114cb1c7484119daf4"
tags: []
---

# Elastic Forge slots: let one priority or idle-time job claim N slots before slots shrink

R324 (2026-11-01 09:44 ET): "Before adding smaller slots, we need to allow priority work or when forge is idle to use multiple slots for a single job". 09:45 ET: "If we have cases we need more cpu and memory, accelerate some urgent tasks". Decision-first: six forks, then a build story. Smaller, more numerous slots (about 16) come only AFTER this lands.

## The axis

Grounded facts (read-only):
- Forge has 32 CPUs and 62G RAM. The runner (the Forge runner on Forge) gives every slot the same systemd slice: `slot` = CPUQuota 800%, MemoryMax 12G, TasksMax 2048; `parent` (`forge-exec.slice`) = CPUQuota 2800%, MemoryMax 56G. A per-slot override map `slots.K` already exists in the limits file, and `systemd-run --scope --slice=forge-exec-K.slice` launches each job into its slot slice.
- Mac side: `heavyAdmission.remote` in the platform preferences is `enabled: true, mode: always, maxConcurrent: 8`. The schema lives at we:scripts/readiness/heavy-admission.mjs (the `remote.*` leaves, about lines 243-277; remote has no env mapping). Gate-only vitest options are stripped for Forge by we:scripts/readiness/forge-gate-options.mjs, so the worker count is fixed by Forge's wrapper today.
- 8 slots x 800% = 6400% is already more than the 2800% parent ceiling. Slots are a fairness lane, not a hard partition. The parent ceiling is the real cap, so a "bigger share" is cheap to grant when other slots are idle and dangerous when they are busy.
- Known occurrences of the pattern: Kubernetes burstable QoS (request vs limit), systemd `CPUWeight` vs `CPUQuota`, GitHub Actions larger runners per job, Bazel `--local_cpu_resources` per action, make `-jN` job tokens (the GNU make jobserver, where a job borrows tokens only while others idle).

### Recommended path at a glance

| Fork | Question | Default |
|---|---|---|
| 1 | How a job asks for N slots, and who decides priority | **Job states a need (`--slots=N`); the admission layer decides the grant from a priority class it computes itself** |
| 2 | Idle rule: threshold, pre-empt or grow at start | **Grow at start only, never pre-empt; idle = free slots >= 4 of 8** |
| 3 | How the runner applies a bigger share | **Multi-slot lease on the Mac side; runner gets one per-job slice sized N x slot** |
| 4 | Fairness and starvation | **Waiting priority job always wins the next free slots; elastic grants cap at 3 and drain-down by never refilling** |
| 5 | Fail-closed fallback and settings | **Any doubt = grant 1 slot; settings via the policy cascade under `heavyAdmission.remote.elastic.*`** |
| 6 | Ordering with the later slot shrink | **Elastic first; shrink is a separate later card that depends on this one** |

## Fork 1 - how a job asks for N slots, and who decides priority

Fork-existence: a self-declared priority is broken (every worker would claim it), so the grant cannot be decided by the requester alone; the two coherent branches (requester decides vs admission decides) cannot both be the authority.

- Option A: the job's own flag decides (`--priority`). Excluded: unauthenticated, any lane can inflate itself, starvation of honest jobs.
- Option B: admission derives a priority class from facts it can check (branch name pattern for main-fix, backlog `priority:now` / focus membership, the verify gate blocking an open PR) and grants N from the job's stated need. **Default.**
- Option C: a central scheduler daemon assigns slots. Excluded for now: a new single point of failure for a gain B gets with existing signals.

**Default: B.** The job passes `--slots=N` (a need, capped by the cascade); we:scripts/readiness/heavy-admission.mjs already carries `priority.mode` and `repairPatterns`, which is the seed for the class. Class order: main-fix / repair > PR-blocking verify > priority:now or focus > normal. Only the top three may exceed 1 slot while others wait.

Skeptic: SURVIVES. The attack "derived signals are spoofable (a branch name is free text)" is answered by deriving from the lane lease and backlog state, not the branch string alone; branch pattern is only one of three signals and the cascade can narrow it.
Screen: clear

## Fork 2 - the idle rule

Fork-existence: pre-empting a running job would kill or throttle work already admitted (a running vitest cannot change worker count in flight), so grow-at-start and pre-empt are not both safe to default.

- Option A: grow at start only. A job starts with N slots if enough are free (or it is priority). **Default.**
- Option B: also pre-empt/shrink others to feed a priority job. Excluded: the runner would need live cgroup resizing of other tenants' jobs and the tests inside would have been sized by worker count at launch.
- Option C: grow mid-run (raise CPUQuota of a running job). Possible later because `systemctl set-property` is live, but vitest's worker count is fixed at launch, so the extra quota is wasted. Deferred.

**Default: A.** Idle means free slots >= 4 of 8 for a normal job (grant up to the free count, max 3 (the cascade cap)), and any free count for a priority job. Priority waiting stops idle growth immediately (Fork 4). Pre-emption stays out of scope.

Skeptic: SURVIVES-WITH-AMENDMENT. Attack: "a long grown job then blocks a new priority arrival for many minutes". Amendment folded in: grown idle jobs have a wall-clock cap (cascade, default 15 min) after which the next launch is back to 1 slot; and Fork 4 forbids refilling while a priority job waits.
Screen: clear

## Fork 3 - how the runner applies the bigger share

Fork-existence: the runner has one slice per slot; either a job gets a per-job slice sized to N, or it holds N slot leases, and holding N leases while running in one slice would not give it N x quota. The two cannot coexist as the single mechanism.

- Option A: slice size per job only (the runner resizes one slot's quota to N x 800%). Excluded alone: the other N-1 slots still look free and get double-booked.
- Option B: multi-slot lease on the Mac side (admission reserves N slot tokens, so the other tenants see them taken) plus the runner places the job in a slice sized for N slots (cpuQuota = N x slot, memoryMax = N x slot, capped by the parent). **Default.** The existing `slots.K` override map in the limits file shows the runner already reads per-slot limits; a lease lists the slot ids it holds and the runner uses the first as the slice.
- Option C: both done in the runner with no Mac-side change. Excluded: admission lives on the Mac (we:scripts/readiness/heavy-admission.mjs), so the reservation must live there.

**Default: B.** Vitest worker count = N x the per-slot default, passed through the Forge wrapper (the wrapper must accept a bounded `--maxWorkers`; this is part of the build story and is the one change on Forge, done through its sanctioned overlay, not here). Memory scales with workers, so MemoryMax scales with N.

Skeptic: SURVIVES. Attack "4 x 800% = 3200% exceeds the 2800% parent". Answer: the parent ceiling clamps the grant (N is capped at floor(parent / slot) = 3 on today's limits), so the realistic cap is 3, not 4. The default cap is therefore 3.
Screen: flagged(impl) -> fixed: the Mac side only sees a slot count N; slice mechanics stay inside the runner contract.

## Fork 4 - fairness and starvation

Fork-existence: letting a grown job refill its slots on finish would let a stream of idle-time growers starve a waiting priority job, so "never block a waiting priority job" has one correct branch.

- Option A: priority waiter holds a reservation; growers are not admitted while any priority waiter exists. **Default.**
- Option B: weighted fair share (priority gets weight 3). Excluded: still lets a normal job grow while a priority job waits.
- Option C: aging (a waiting job gains priority over time). Kept as a safety net for normal jobs only: after the cascade wait limit a normal waiter becomes the next to be admitted, so growers cannot starve normal single-slot jobs either.

**Default: A + the aging net from C.** A grower never takes slots that a queued job of equal or higher class is waiting for; a priority job that needs N slots holds the freed slots until it has N (no partial grants, but a bounded hold, then it falls back to what is free).

Skeptic: SURVIVES. Attack: "reservation deadlock when two priority jobs each need 3". Answer: reservations are granted strictly in queue order, one at a time, so no circular wait.
Screen: clear

## Fork 5 - fail-closed fallback and settings

Fork-existence: when Forge load, queue state or the grant cannot be read, an elastic grant on a guess can overload the box; the alternative (grant anyway) is broken, so only one branch is right.

- Option A: any doubt (unreadable load, queue file corrupt, remote client error, N over cap, unknown priority) grants exactly 1 slot, i.e. today's behaviour. **Default.**
- Option B: deny the run. Excluded: turns an optimisation failure into an outage.

**Default: A.** Settings via the policy cascade (standard -> platform preferences -> tool), new leaves next to the existing `remote.*` ones: `remote.elastic.enabled` (default **false** until the live proof, then true), `remote.elastic.maxSlots` (3), `remote.elastic.idleFreeSlots` (4), `remote.elastic.maxWallMinutes` (15), `remote.elastic.priorityClasses` (list). All validated like the existing leaves; an invalid value falls back to the standard value and logs.

Skeptic: SURVIVES. Citation-scope check: the existing `remote.*` validators are the authority for the shape of the new leaves only, not for the semantics.
Screen: clear

## Fork 6 - ordering with the later slot shrink

Fork-existence: shrinking to about 16 smaller slots first would make every normal job smaller and priority jobs unable to grow, the exact failure R324 names; so elastic must land first.

- Option A: elastic first, then shrink as its own card that depends on this one. **Default.**
- Option B: shrink first. Excluded by R324 itself.
- Option C: both in one change. Excluded: two risky changes with one proof; a regression could not be attributed.

**Default: A.** After this lands, 16 slots of 400% each make "N slots" a finer dial: a priority job asks for 4-6 of the small slots. The shrink card records that dependency and re-derives the cap (floor(parent / slot)).

Skeptic: SURVIVES.
Screen: clear

## Pre-mortem

It is three weeks later and elastic slots made the gate worse. Likely reasons:
1. A grown job ate the parent ceiling and a priority job waited behind it. Mitigation: Fork 4 reservation, wall cap, grow only at start.
2. Priority was spoofed or too broad, so everything grew and the host throttled. Mitigation: priority derived from lease/backlog state; cap 3; metric of grants per class in the heavy queue status.
3. More workers raised flakiness (memory pressure, shared ports). Mitigation: MemoryMax scales with N; the first proof compares pass/fail, not only time.
4. The Forge wrapper does not accept a worker count, so the grant gives quota but no speed. Mitigation: discovered in the proof; the build story's first step is the wrapper change.
5. A crash leaves a multi-slot lease held. Mitigation: leases carry the same TTL/reaper as single slots (state over time).

## Test and proof plan

- Unit (scoped, via heavy-admission): grant function table - idle/priority/normal x free slots x cap; fail-closed on each bad input; no grant when a priority waiter exists; reservation order; cascade validation of the new leaves.
- Runner: a limits-file render test that an N-slot slice has the expected CPUQuota/MemoryMax and never exceeds the parent.
- Live before/after (required by the operator's failure rule): pick one real priority job (a main-fix verify of a fixed scoped test set). Run it once on 1 slot and once with `--slots=3` on an otherwise idle Forge, same commit and same files; record wall time, CPU peak and memory peak from systemd accounting, and pass/fail. Then repeat once with Forge busy to prove it falls back to 1 slot and a waiting priority job is not delayed. Proof goes in the card's resolve note.

## Build story (after ratify)

Size 8 as a whole; slice at ratify: (a) pure grant function + cascade leaves in we:scripts/readiness/heavy-admission.mjs, (b) multi-slot lease in the queue state, (c) Forge wrapper worker-count + per-job slice (via the sanctioned Forge overlay, not by hand), (d) live proof. Scopes: we:scripts/readiness/heavy-admission.mjs, we:scripts/readiness/forge-gate-options.mjs.

## Acceptance

- [A1] **Executable** - `heavy-queue` operation (or the scoped heavy-admission unit test) shows an elastic grant for a priority job on an idle Forge and exactly 1 slot otherwise; the live before/after timing is attached.
- [A2] **Must refuse** - an unreadable load/queue state, an N above the cap, or an unknown priority class grants exactly 1 slot (fail closed); docs and config files given as inputs never raise the grant.

## Non-goals

- [N1] Not adding the smaller slots (about 16); that is a later card gated on this one.
- [N2] No pre-emption or live resize of running jobs.
- [N3] No change to the Forge runner in this card; this card only prepares the decision.

## Edge cases this change must handle

1. **Untrusted text** - priority is derived from lease and backlog state, never a free-text flag alone; a branch name is one signal of three.
2. **Truncated reads** - a partial queue or load read counts as unreadable and grants 1 slot.
3. **Shared state files** - the multi-slot lease uses the same atomic lock files as single slots; a half-written lease is reaped.
4. **Fail closed** - Fork 5: any doubt grants exactly 1 slot.
5. **Identity scoping** - a lease is owned by the lane/session that took it; only that owner releases it.
6. **State over time** - leases carry a TTL and the reaper; grown jobs have a wall-clock cap.
7. **Who wrote it** - the grant is decided by admission, not by the requesting worker or the Forge side.

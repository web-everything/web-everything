---
kind: decision
size: 8
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/forge-gate-options.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Elastic Forge slots: let one priority or idle-time job claim N slots before slots shrink

R324 (2026-11-01 09:44 ET): "Before adding smaller slots, we need to allow priority work or when forge is idle to use multiple slots for a single job". 09:45 ET: "If we have cases we need more cpu and memory, accelerate some urgent tasks". Decision-first: no fork survived the screen, so it is a set of rulings, then a build story. Smaller, more numerous slots (about 16) come only AFTER this lands.

## The axis

Grounded facts (read-only; checked against the code and the Forge runner):
- Forge has 32 CPUs and 62G RAM. The runner gives every slot the same systemd slice: `slot` = CPUQuota 800%, MemoryMax 12G, TasksMax 2048; `parent` (`forge-exec.slice`) = CPUQuota 2800%, MemoryMax 56G. The `slots.K` override map exists in the limits file but is empty and static (root-written config, not per-job).
- The runner, not the Mac, picks the slot: `reserveWorker` takes the first free `slot-K`; a caller-supplied `slot` is only validated. Each slot has its own user, run directory and writer guard. The Mac side only counts `remote.maxConcurrent` (8) local tokens, so it does not know Forge slot ids. A job runs in the static `forge-exec-K.slice`, so it can never exceed that slice's 800% quota whatever N is.
- Vitest worker count: the runner sets `WE_VITEST_MAX_WORKERS` from the slot's CPUs, and a request env value overrides it (the variable is already in the runner's env allowlist, checked only as digits, with no upper bound). So no new `--maxWorkers` flag is needed; an upper bound on Forge is.
- Mac side: `heavyAdmission.remote` standard is `enabled: false, mode: above-threshold, maxConcurrent: 8`; the platform preferences override it to `enabled: true, mode: always`. The schema is at we:scripts/readiness/heavy-admission.mjs (`remote.*` leaves, about lines 243-277; remote has no env mapping, so layers are standard -> platform preferences only for these leaves, plus tool for non-clientPath). Gate-only vitest options stripped for Forge: we:scripts/readiness/forge-gate-options.mjs (it strips `--passWithNoTests` and timeout flags, not a worker count).
- Priority today: admission has a red-main repair class (P0, from `priority.repairPatterns` matched on purpose / session / holder) plus a P1 tier (an `unblock-` purpose prefix or `WE_HEAVY_UNBLOCK=1`, both requester-set strings) (we:scripts/readiness/heavy-repair-priority.mjs). The delivery scale `deliveryPriority` (P0 incident, P1 unblocks, P2 operator asked, P3 normal, P4 low, with operator overrides and aging) lives in we:scripts/lib/delivery-priority.mjs. Statute `#heavy-command-admission-queue` ratified "v1 equal-cost named set, not weighted"; N-slot grants amend that, and this card is the amendment.
- 8 slots x 800% = 6400% already exceeds the 2800% parent; likewise 8 x 12G = 96G exceeds the 56G parent MemoryMax. Slots are a fairness lane, not a hard partition. The parent ceiling is the real cap, in CPU and in memory.
- Known occurrences of the pattern: Kubernetes burstable QoS (request vs limit), systemd `CPUWeight` vs `CPUQuota`, GitHub Actions larger runners per job, Bazel `--local_cpu_resources` per action, make `-jN` job tokens (a job borrows tokens only while others idle).

### Recommended path at a glance

No real fork survives the screen (see the rulings below). The call to ratify is the set of rulings as a whole, including the amendment of statute `#heavy-command-admission-queue`.

## Rulings to ratify (none is a fork)
- **Fairness (was Fork 1).** A lower class never takes slots a higher-class waiter needs; a higher-class job is served first and idle growth stops while one waits (weighted share was considered and rejected: it lets a normal job grow while a priority job waits, the slowdown R324 removes). Starvation of normal jobs needs a HARD bound, not just aging: `deliveryPriority` aging moves a waiter up only one class and only when `agingHours` is set (default null), so a P3 waiter still sits behind a P0-P2 stream. Therefore the wait limit is its own cascade leaf (`remote.elastic.normalMaxWaitMinutes`): after it, no grant above 1 slot is made to anyone while that waiter is queued. The hold a priority job keeps on freed slots is bounded by `reserveHoldSeconds`. Reservations are granted strictly in queue order, so there is no circular wait.
  Skeptic: SURVIVES-WITH-AMENDMENT (independent skeptic): reuse the delivery aging, bound the hold. Screen: the fresh screen found the fork was a tuning setting and an existing rule in costume, so it is a ruling with two cascade leaves.

- **Who decides the grant (was Fork 1).** Admission decides, never the requester: the job only states a need (`--slots=N`, capped); a self-declared priority is unauthenticated and broken. The class reuses the existing `deliveryPriority` scale (P0 to P4), not a second order. Only P0 to P2 may exceed 1 slot while others wait; P3 and P4 may exceed 1 slot only through the idle rule. The signals admission checks today are the lane lease and purpose/session (`repairPatterns`); backlog-state and open-PR-blocking signals are NOT read yet and are build work (slice b), and a signal admission cannot verify counts as normal class. The amendment to statute `#heavy-command-admission-queue` ("v1 equal-cost named set, not weighted") is this card. A central slot-scheduler daemon is a non-goal (N4).
  Skeptic: SURVIVES-WITH-AMENDMENT (independent skeptic): reuse `deliveryPriority`, unbuilt signals grant nothing, name the statute amendment. Screen: re-screen flagged it prio (self-declared priority is a strawman), so it is a ruling, not a fork.
- **No pre-emption (was Fork 2).** The grant is fixed at admission; admission never takes capacity from an admitted job (a running vitest cannot change its worker count in flight; the existing rule is already "a running holder is never preempted"). Mid-run growth is out of scope (N2). Idle growth thresholds (free slots >= 4 of 8 for a normal job, cap 3, wall cap 15 min) are cascade values below. Capacity ceilings (parent CPU and MemoryMax, N x 12G beside busy slots) are enforced by the runner, which clamps or refuses a request; the Mac only passes the requested N.
  Skeptic: SURVIVES-WITH-AMENDMENT (independent skeptic): thresholds are tuning, memory oversubscription (8 x 12G vs 56G) added. Screen: re-screen flagged it (existing ruling, and the memory guard belongs on the runner side), so it is a ruling and the guard moved to the runner.
- **End-to-end grant contract (was Fork 3; the first card's mechanism was wrong).** A grant of N is honoured end to end: the Mac counts N tokens and the runner gives that job N slots' worth of CPU and memory, never above the parent ceiling. The mechanism lives in the build story, not on the Mac side: the runner reserves N workers itself (it picks slots), places the job in a per-job slice or scope sized N x slot (a static `forge-exec-K.slice` cannot exceed 800%), and bounds the worker-count env (`WE_VITEST_MAX_WORKERS`) at or below the granted N x per-slot default. That is a runner change done through the sanctioned Forge overlay in the build story.
- **Fail closed (was Fork 5).** Any doubt (unreadable load, corrupt queue file, remote client error, N over cap, unknown priority) grants exactly 1 slot, today's behaviour; denying the run would turn an optimisation failure into an outage. This matches the existing `localFallback` pattern.
- **Settings.** New leaves next to the `remote.*` ones, validated like them, an invalid value falls back to the standard value and logs; layers are standard then platform preferences (remote has no env mapping): `remote.elastic.enabled` (default **false** until the live proof, then true), `maxSlots` (3: the cap is floor(parent / slot) = 3 on today's limits), `idleFreeSlots` (4), `maxWallMinutes` (15), `reserveHoldSeconds` (bounded), `priorityClasses` (list of classes allowed to exceed 1 slot), `normalMaxWaitMinutes` (hard starvation bound).
- **Ordering with the slot shrink (was Fork 6).** R324 already rules it: elastic lands first, the shrink to about 16 smaller slots is a separate later card that depends on this one and re-derives the cap (floor(parent / slot)); 16 x 400% is still above the 2800% parent.

## Pre-mortem

It is three weeks later and elastic slots made the gate worse. Likely reasons:
1. A grown job ate the parent ceiling and a priority job waited behind it. Mitigation: the fairness ruling, wall cap, grow only at start.
2. Priority was spoofed or too broad, so everything grew and the host throttled. Mitigation: unverifiable signals grant nothing; cap 3; grants per class shown in the heavy queue status.
3. More workers raised flakiness or hit parent memory OOM (8 x 12G exceeds 56G). Mitigation: memory guard on the grant; the first proof compares pass/fail, not only time.
4. The Forge side gave quota but the tests ran with the old worker count, or the slot was double-booked because the runner picks slots itself. Mitigation: the build story's first slice is the runner change (N-worker reservation, per-job slice, bounded worker env); nothing is enabled before it.
5. A crash leaves a multi-slot lease held. Mitigation: leases carry the same TTL/reaper as single slots.

## Test and proof plan

- Unit (scoped, via heavy-admission): grant function table - idle/priority/normal x free slots x cap x memory room; fail-closed on each bad input; no grant when a higher-class waiter exists; reservation order; cascade validation of the new leaves.
- Runner: a render test that an N-slot slice has the expected CPUQuota/MemoryMax and never exceeds the parent; the worker env above N is rejected.
- Live before/after (required by the operator's failure rule): pick one real priority job (a main-fix verify of a fixed scoped test set). Run it once on 1 slot and once with `--slots=3` on an otherwise idle Forge, same commit and files; record wall time, CPU peak and memory peak from systemd accounting, and pass/fail. Repeat once with Forge busy to prove it falls back to 1 slot and a waiting priority job is not delayed. Proof goes in the card's resolve note.

## Build story (after ratify)

Size 8 as a whole; slice at ratify: (a) pure grant function + cascade leaves in we:scripts/readiness/heavy-admission.mjs, (b) multi-slot lease in the queue state plus the missing admission signals (backlog state, PR-blocking verify), (c) Forge runner change (N-worker reservation, per-job slice, bounded worker env) via the sanctioned Forge overlay, not by hand, (d) live proof. Scopes: we:scripts/readiness/heavy-admission.mjs, we:scripts/readiness/forge-gate-options.mjs.

## Acceptance

- [A1] **Executable** - `heavy-queue` operation (or the scoped heavy-admission unit test) shows an elastic grant for a priority job on an idle Forge and exactly 1 slot otherwise; the live before/after timing is attached.
- [A2] **Must refuse** - an unreadable load/queue state, an N above the cap, or an unknown priority class grants exactly 1 slot (fail closed); docs and config files given as inputs never raise the grant.

## Non-goals

- [N1] Not adding the smaller slots (about 16); that is a later card gated on this one.
- [N2] No pre-emption, mid-run growth or live resize of running jobs.
- [N3] This card is decision-only: no runner or admission code changes here (the runner change is build slice c).
- [N4] No central slot-scheduler daemon.

## Edge cases this change must handle

1. **Untrusted text** - priority is derived from lease and backlog state, never a free-text flag alone; unverifiable signals grant nothing.
2. **Truncated reads** - a partial queue or load read counts as unreadable and grants 1 slot.
3. **Shared state files** - the multi-slot lease uses the same atomic lock files as single slots; a half-written lease is reaped.
4. **Fail closed** - any doubt grants exactly 1 slot.
5. **Identity scoping** - a lease is owned by the lane/session that took it; only that owner releases it.
6. **State over time** - leases carry a TTL and the reaper; grown jobs have a wall-clock cap.
7. **Who wrote it** - the grant is decided by admission, not by the requesting worker or the Forge side.

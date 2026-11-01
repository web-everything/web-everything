---
bornAs: xjba691
kind: decision
size: 8
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/forge-gate-options.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# (file slug still says priority-or-idle; v1 is idle only) Elastic Forge slots (v1: idle-time growth only): let one job claim N slots when Forge is idle

R331 (2026-11-01 11:22 ET) "Ok idle first": v1 is idle-time growth ONLY; priority claiming is off and moves to a later slice (see Later slice). R324 (2026-11-01 09:44 ET): "Before adding smaller slots, we need to allow priority work or when forge is idle to use multiple slots for a single job". 09:45 ET: "If we have cases we need more cpu and memory, accelerate some urgent tasks" (priority claiming deferred to the Later slice). Decision-first: no fork survived the screen, so it is a set of rulings, then a build story. Smaller, more numerous slots (about 16) come only AFTER this lands.

## The axis

Grounded facts (read-only; checked against the code and the Forge runner):
- Forge has 32 CPUs and 62G RAM. The runner gives every slot the same systemd slice: `slot` = CPUQuota 800%, MemoryMax 12G, TasksMax 2048; `parent` (`forge-exec.slice`) = CPUQuota 2800%, MemoryMax 56G. The `slots.K` override map exists in the limits file but is empty and static (root-written config, not per-job).
- The runner, not the Mac, picks the slot: `reserveWorker` takes the first free `slot-K`; a caller-supplied `slot` is only validated. Each slot has its own user, run directory and writer guard. The Mac side only counts `remote.maxConcurrent` (8) local tokens, so it does not know Forge slot ids. A job runs in the static `forge-exec-K.slice`, so it can never exceed that slice's 800% quota whatever N is.
- Vitest worker count: the runner sets `WE_VITEST_MAX_WORKERS` from the slot's CPUs, and a request env value overrides it (the variable is already in the runner's env allowlist, checked only as digits, with no upper bound). So no new `--maxWorkers` flag is needed; an upper bound on Forge is.
- Mac side: `heavyAdmission.remote` standard is `enabled: false, mode: above-threshold, maxConcurrent: 8`; the platform preferences override it to `enabled: true, mode: always`. The schema is at we:scripts/readiness/heavy-admission.mjs (`remote.*` leaves, about lines 243-277; remote has no env mapping, so layers are standard -> platform preferences only for these leaves, plus tool for non-clientPath). Gate-only vitest options stripped for Forge: we:scripts/readiness/forge-gate-options.mjs (it strips `--passWithNoTests` and timeout flags, not a worker count).
- Priority today (context only, NOT used in v1): admission has a red-main repair class and a P1 tier, both matched from requester-set strings (we:scripts/readiness/heavy-repair-priority.mjs); `deliveryPriority` lives in we:scripts/lib/delivery-priority.mjs. v1 reads none of it: every waiter is the same class. Remote admission today (we:scripts/readiness/heavy-admission.mjs about lines 802-817) is a polling `tryAcquireSlot` loop over `cap` tokens with no waiter queue; statute `#heavy-command-admission-queue` ratified "v1 equal-cost" and, in clause 1, "a plain named SET, not weighted"; N-slot grants amend that, and this card is the amendment.
- 8 slots x 800% = 6400% already exceeds the 2800% parent; likewise 8 x 12G = 96G exceeds the 56G parent MemoryMax. Slots are a fairness lane, not a hard partition. The parent ceiling is the real cap, in CPU and in memory.
- Known occurrences of the pattern: Kubernetes burstable QoS (request vs limit), systemd `CPUWeight` vs `CPUQuota`, GitHub Actions larger runners per job, Bazel `--local_cpu_resources` per action, make `-jN` job tokens (a job borrows tokens only while others idle).

### Recommended path at a glance

No real fork survives the screen. The call to ratify is the set of rulings below, including the amendment of statute `#heavy-command-admission-queue`.

## Rulings to ratify (none is a fork)
- **Idle-only growth (R331).** A job may claim N > 1 slots only when Forge is idle: free slots >= `idleFreeSlots` at admission AND the runner reports parent CPU and memory headroom for the request (the Mac cannot see Forge load, so the runner decides). Priority claiming is OFF: no P0/P1 string matching, no priority class, no spoofing bound is needed, because no signal a caller can spell raises the grant. The only caller input is `--slots=N`, a request that admission may refuse; absent, invalid or non-integer means 1, capped at `maxSlots`. Admission decides, never the requester. A full-suite run (matched by the exact named gate command, which can only lower a grant, never raise one) is never granted above 1.
- **Starvation bound.** A grown job takes tokens a later normal job would want, so growth has a HARD growth-stop bound: the wall cap `maxWallMinutes`, growth only at start, and `remote.elastic.normalMaxWaitMinutes`: once any waiter has waited that long, no grant above 1 slot is made to anyone while it is queued. The 35 min (`normalMaxWaitMinutes` + `maxWallMinutes`, 20 + 15) bounds only the delay CAUSED BY GROWTH, not all queueing (remote admission is a polling race, not FIFO). The wall cap is enforced: a grown job runs under a hard timeout of `maxWallMinutes` and is killed at it; a request whose declared timeout exceeds it is granted 1 slot (a timeout can only lower a grant). Build slice a2 gives a waiter past `normalMaxWaitMinutes` first claim on freed tokens. Measuring that wait needs the remote path to record each waiter's arrival (build slice a2, small: an arrival record, not a priority queue). Until it ships `remote.elastic.enabled` stays false.
- **No pre-emption.** The grant is fixed at admission; admission never takes capacity from an admitted job (a running vitest cannot change its worker count in flight; "a running holder is never preempted"). Mid-run growth is out of scope (N2). Capacity ceilings (parent CPU, MemoryMax, N x 12G beside busy slots) are enforced by the runner, which clamps or refuses a request; the Mac only passes the requested N. If the runner refuses or clamps, the Mac holds only what was granted and runs at 1 slot on refusal (fail closed); an old runner that ignores N is treated as 1 slot; elastic stays disabled until the runner change is live. Reply mechanics are in the build story.
- **End-to-end grant contract.** A grant of N is honoured end to end (Mac tokens and runner CPU/memory), never above the parent ceiling; refusal or doubt falls back to 1 slot. Mechanism is build slice c (runner N-worker reservation, per-job slice sized N x slot, bounded `WE_VITEST_MAX_WORKERS`), done through the sanctioned Forge overlay.
- **Fail closed.** Any doubt (unreadable load, corrupt queue file, remote client error, N over cap) grants exactly 1 slot, today's behaviour; denying the run would turn an optimisation failure into an outage. Matches the existing `localFallback` pattern.
- **Settings.** New leaves next to the `remote.*` ones, validated like them, an invalid value falls back to the standard value and logs; layers are standard then platform preferences only: `remote.elastic.enabled` (default **false** until the live before/after proof, then true), `maxSlots` (3 = min(floor(2800/800)=3, floor(56G/12G)=4) on today's limits), `idleFreeSlots` (4), `maxWallMinutes` (15), `normalMaxWaitMinutes` (20, the hard starvation bound).
- **Ordering with the slot shrink.** R324: elastic lands first; the shrink to about 16 smaller slots is a separate later card that depends on this one and re-derives the cap.

## Later slice: priority claiming (NOT in v1)

Separate card, blocked on a verified priority source. Open question: which source can admission trust that a requester cannot spell? Candidates: the lane lease record, or the main-red episode owner as `deliveryPriority` reads it. Until one is verified and named, priority grants nothing. This later slice would also add the priority-aware fairness (a lower class never takes slots a higher-class waiter needs, bounded hold) and the verified-signal admission reads.

## Pre-mortem

It is three weeks later and elastic slots made the gate worse. Likely reasons:
1. A grown job ate the parent ceiling and a normal job waited behind it. Mitigation: idle-only growth, wall cap, grow only at start, the `normalMaxWaitMinutes` bound.
2. A caller asks for many slots on a busy Forge. Mitigation: only idle admission grants more than 1; cap 3; the runner clamps; grants shown in the heavy queue status.
3. More workers raised flakiness or hit parent memory OOM (8 x 12G exceeds 56G). Mitigation: memory guard on the grant; the first proof compares pass/fail, not only time.
4. The Forge side gave quota but the tests ran with the old worker count, or the slot was double-booked because the runner picks slots itself. Mitigation: the build story's first slice is the runner change (N-worker reservation, per-job slice, bounded worker env); nothing is enabled before it.
5. A crash leaves a multi-slot lease held. Mitigation: leases carry the same TTL/reaper as single slots.

## Test and proof plan

- Unit (scoped, via heavy-admission): grant function table - idle/busy x free slots x cap x memory room; fail-closed on each bad input; no grant above 1 once a waiter passed `normalMaxWaitMinutes`; cascade validation of the new leaves.
- Runner: a render test that an N-slot slice has the expected CPUQuota/MemoryMax and never exceeds the parent; the worker env above N is rejected.
- Live before/after (required by the operator's failure rule): pick one real job (a scoped verify of a fixed scoped test set). Run it once on 1 slot and once with `--slots=3` on an otherwise idle Forge, same commit and files; record wall time, CPU peak and memory peak from systemd accounting, and pass/fail. Repeat once with Forge busy to prove it falls back to 1 slot and a waiting job is not delayed. Proof goes in the card's resolve note.

## Build story (after ratify)

Size 8 as a whole; slice at ratify: (a) pure idle grant function + cascade leaves in we:scripts/readiness/heavy-admission.mjs, (a2) remote waiter arrival record for the starvation bound, (b) multi-slot lease in the queue state, carried through the re-entrance marker, (c) Forge runner change (reply carries `grantedSlots`; refusal is a non-zero exit with `reason: slots-refused`; the Mac checks `grantedSlots` on every reply, a new per-reply probe, and releases surplus tokens right after the run starts; plus (N-worker reservation, per-job slice, bounded worker env)) via the sanctioned Forge overlay, not by hand, (d) live proof. Scopes: we:scripts/readiness/heavy-admission.mjs, we:scripts/readiness/forge-gate-options.mjs.

## Acceptance

- [A1] **Executable** - `heavy-queue` operation (or the scoped heavy-admission unit test) shows an elastic grant for a job on an idle Forge and exactly 1 slot otherwise; the live before/after timing is attached.
- [A2] **Must refuse** - an unreadable load/queue state, or an N above the cap grants exactly 1 slot (fail closed); no caller-supplied field (purpose, session, flag, input file type) raises the grant.

## Where this card amends the statute (for ratification)

Statute `#heavy-command-admission-queue` in we:docs/agent/platform-decisions.md (line ~4671) amended by v1 (idle growth only):
0. Scope: elastic applies to the `remote.*` (Forge) path only; the local pool (core budget cap 2) is unchanged.
1. Clause 1 "a plain named SET, not weighted" (equal-cost): a job may weigh up to `maxSlots` tokens, granted only on an idle Forge.
2. Clause 2 (where the cap applies, semaphore wording): becomes a counting semaphore with an N-token acquire.
3. Clause 4 (fixed cap): the cap counts one job as up to `maxSlots` tokens; the `remote.elastic.*` leaves have no env layer (standard then platform preferences only), `maxConcurrent` has none either.
4. Re-entrance rule (~lines 4724-4730, `WE_HEAVY_ADMISSION_HELD=1`): the marker carries the granted N, so a nested wrapper neither re-acquires nor double-counts.
5. The 30-minute `waiting`-marker reaper must treat a multi-slot marker as one owner holding N tokens (reaps all N).
Unchanged: clause 3 (waiting-for-capacity tick). Not clauses of this statute, so not amended, but consistent: "a running holder is never preempted" (code comment at we:scripts/readiness/heavy-admission.mjs:135); the #4294 statute (callers choosing the full gate) as context only; the separate delivery-decider statute (v1 does not read the decider).

## Non-goals

- [N1] Not adding the smaller slots (about 16); that is a later card gated on this one.
- [N2] No pre-emption, mid-run growth or live resize of running jobs.
- [N3] This card is decision-only: no runner or admission code changes here (the runner change is build slice c).
- [N4] No central slot-scheduler daemon.

## Edge cases this change must handle

1. **Untrusted text** - no free-text field (purpose, session, flag) can raise the grant; only measured idleness does.
2. **Truncated reads** - a partial queue or load read counts as unreadable and grants 1 slot.
3. **Shared state files** - the multi-slot lease uses the same atomic lock files as single slots; a half-written lease is reaped.
4. **Fail closed** - any doubt grants exactly 1 slot.
5. **Identity scoping** - a lease is owned by the lane/session that took it; only that owner releases it.
6. **State over time** - leases carry a TTL and the reaper; grown jobs have a wall-clock cap.
7. **Who wrote it** - the grant is decided by admission, not by the requesting worker or the Forge side.

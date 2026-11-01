---
kind: story
size: 8
parent: "xjba691"
status: open
blockedBy: ["xjba691"]
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/forge-gate-options.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Build elastic Forge slots mechanics (idle grant, starvation bound, multi-slot lease, runner N-slot reservation)

Build story for the ratified elastic-slot policy of xjba691: grant function, polling and starvation bound, timeout as lower-only input, multi-slot lease, runner N-slot reservation, marker reaping.

## Policy this story implements (ratified on xjba691; not re-decided here)

Growth only when Forge is idle; at most `maxSlots` (3) slots per job; `remote.elastic.enabled: false` until a live before/after proof; fail closed to 1 slot. Statute amendments 0-5 live on xjba691.

## Mechanics (moved from xjba691 per R350)

- **Idle grant.** N > 1 only when free slots >= `idleFreeSlots` (4) at admission AND the runner reports parent CPU and memory headroom (the Mac cannot see Forge load). Only caller input is `--slots=N`; absent, invalid or non-integer means 1; capped at `maxSlots`. Admission decides, never the requester.
- **Full-suite detection.** A full-suite run is matched by the exact named gate command; that match can only lower a grant to 1, never raise one.
- **Timeout is a lower-only input.** A grown job runs under a hard timeout of `maxWallMinutes` (15) and is killed at it; a request whose declared timeout exceeds it is granted 1 slot. A timeout can lower a grant, never raise one. Growth only at start; no mid-run resize.
- **Starvation bound.** `remote.elastic.normalMaxWaitMinutes` (20): once any waiter has waited that long, no grant above 1 is made to anyone while it is queued, and that waiter has first claim on freed tokens. Needs a remote waiter arrival record (arrival record, not a priority queue). The 35 min (20 + 15) bounds only delay CAUSED BY GROWTH; remote admission is a polling race, not FIFO.
- **Polling.** Remote admission polls; the grant is decided on each poll with the same idle test; a poll that cannot read load or queue state grants 1.
- **End-to-end grant contract.** Runner reply carries `grantedSlots`; refusal is a non-zero exit with `reason: slots-refused`; the Mac checks `grantedSlots` on every reply (a new per-reply probe) and releases surplus tokens right after the run starts. Runner: N-worker reservation, per-job slice sized N x slot, bounded `WE_VITEST_MAX_WORKERS` (digits-only today, no upper bound; add one), clamped to the parent ceiling (CPUQuota 2800%, MemoryMax 56G; 8 x 800% and 8 x 12G already exceed it). Delivered through the sanctioned Forge overlay, not by hand.
- **Multi-slot lease and marker.** One lease in the queue state holding N tokens, same atomic lock files as single slots; the `WE_HEAVY_ADMISSION_HELD=1` re-entrance marker carries the granted N so nested wrappers neither re-acquire nor double-count. The 30-minute `waiting`-marker reaper treats a multi-slot marker as one owner holding N tokens and reaps all N; half-written leases are reaped.
- **Env-layer facts.** `remote.*` leaves have no env mapping: layers are standard then platform preferences only (plus tool for non-clientPath). `remote.elastic.*` and `maxConcurrent` follow that. Invalid values fall back to the standard value and log. Leaves: `enabled` (false), `maxSlots` (3), `idleFreeSlots` (4), `maxWallMinutes` (15), `normalMaxWaitMinutes` (20), placed in we:scripts/readiness/heavy-admission.mjs near the `remote.*` leaves; we:scripts/readiness/forge-gate-options.mjs strips gate-only options and does not strip worker counts.
- **Slices (cut at pickup).** (a) pure idle grant function + cascade leaves; (a2) waiter arrival record; (b) multi-slot lease + marker; (c) Forge runner change via overlay; (d) live before/after proof (1 slot vs `--slots=3` on idle Forge, same commit; then busy Forge falls back to 1). Do not set `enabled: true` before (d).

## Acceptance

- [A1] **Executable** - scoped heavy-admission unit tests: grant table (idle/busy x free slots x cap x memory room) gives >1 only on idle Forge and exactly 1 otherwise.
- [A2] **Executable** - starvation bound: with a waiter past `normalMaxWaitMinutes`, no grant above 1 is made while it is queued, and it claims freed tokens first.
- [A3] **Must refuse** - a declared timeout above `maxWallMinutes` yields 1 slot; the timeout never raises a grant.
- [A4] **Must refuse** - a full-suite gate command (exact named match) never gets above 1 slot; no free-text field (purpose, session, flag) raises a grant.
- [A5] **Executable** - env-layer: a `WE_*` env value cannot set `remote.elastic.*`; invalid leaf values fall back to standard and log.
- [A6] **Executable** - runner render test: N-slot slice CPUQuota/MemoryMax never exceeds the parent; worker env above N is rejected; a multi-slot marker is reaped as one owner of N tokens.
- [A7] **Executable** - live before/after attached (wall time, CPU and memory peak, pass/fail) before `enabled` flips.
- [A8] **Ratification gap: values** - confirm `maxSlots` 3 and idle = at least 4 of 8 slots free (R354 flag 1).
- [A9] **Ratification gap: anchor amendment 0** - anchor statute amendment 0 to its exact text location (R354 flag 2).
- [A10] **Ratification gap: amendment 3 second insertion** - anchor amendment 3's second insertion (R354 flag 3).
- [A11] **Ratification gap: "as they already are"** - make amendment 3's "as they already are" verifiable or reword it (R354 flag 4).
- [A12] **Ratification gap: re-entrance note** - amend the re-entrance "one slot, not two" note (R354 flag 5).
- [A13] **Ratification gap: waiting-marker token** - decide the waiting-marker token semantics in the build (R354 flag 6).

## Non-goals

- [N1] Priority claiming, smaller slots (~16), pre-emption, mid-run growth, a central slot-scheduler daemon.

## Edge cases this change must handle

1. **Untrusted text** - no free-text field raises the grant; only measured idleness does.
2. **Truncated reads** - a partial queue or load read counts as unreadable and grants 1.
3. **Shared state files** - multi-slot lease uses the atomic lock files of single slots; half-written leases are reaped.
4. **Fail closed** - any doubt grants exactly 1 slot.
5. **Identity scoping** - a lease is released only by the lane/session that took it.
6. **State over time** - TTL, reaper and the wall cap bound every grown job.
7. **Who wrote it** - the grant is decided by admission, not the requester or the Forge side.

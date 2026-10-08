---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/lane-lease.mjs", "we:scripts/lib/lane-hold-io.mjs", "we:scripts/lane-pool.mjs", "we:scripts/conveyor/lease-reaper.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Lane hold rule: never release, reset, trim or reclaim a lane holding verifying or verified-unpushed work

A3 of the fixer-throughput proposal (2026-10-08). The lease reaper released 24 lanes with unpushed work and acquire reset 10 over unpushed work in 17:00-21:00Z; a fixer parked on await-verify looks gone. One pure rule (laneHoldVerdict in we:scripts/lib/lane-lease.mjs) over plain facts (await-verify records, verify marker state, unpushed) with declared settings gates reaper, release, acquire, trim, reclaim and refresh. Also: the batched patch-equivalence fallback treated ANY matching ahead commit as proof all were pushed (lane-5 4b254297 reset).

## Rule and settings

- **Rule `lane-hold`** — `laneHoldVerdict(facts, settings)` in we:scripts/lib/lane-lease.mjs. Pure. Facts: `action`
  (release / reset / remove / reclaim / take-over), `byHolder`, `nowMs`, `awaits[]` (await-verify records naming the
  lane), `verify` (running / passed / failed / unreadable + revision + time), `revision`, `unpushed`. Holds:
  `awaiting-verify`, `verifying`, `verified-unpushed`, `verify-unreadable`, `work-state-unknown`. Only the holder's
  own release bypasses it. Replay fixtures in we:scripts/lib/__tests__/lane-lease.test.mjs.
- **Settings** (built-in, env override; off value = the old behaviour): `mode` enforce|off (`WE_LANE_HOLD`),
  `holdMinutes` 150 (`WE_LANE_HOLD_MINUTES`), `aheadEquivalence` every|any (`WE_LANE_AHEAD_EQUIVALENCE`).
- **IO** — `checkLaneHold` in we:scripts/lib/lane-hold-io.mjs, called by we:scripts/lane-pool.mjs release, acquire reset,
  stale take-over, acquire-time reaper, trim, reclaim/salvage, refresh, and by the lease reaper's plan.
- **Holder liveness** — the reaper's `sessionPidAliveByName` kept whichever duplicate-name row sorted last, so a
  round-1 `done` row read a live round-N fixer as gone (lane-5 fix-4461 21:17Z, lane-20 fix-4433 21:25Z, both
  mid-edit, after the first edge load). It now keeps the most-alive reading (true > unknown > false).

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/__tests__/lane-pool-hold-rule.test.mjs` (path without the `we:` prefix) fails 7/12 on main's
   we:scripts/lane-pool.mjs and passes 12/12 after.
2. **Live** — after the edge load, the WE pool journal shows 0 `release` by `lease-reaper` and 0 `acquire-reset`
   with `unpushed:true` over a 4 h window (was 24 and 10 on 2026-10-08 17:00–21:00Z), and a parked fixer keeps its
   lane through a reaper pass (`hold-refused` / `kept … held:awaiting-verify` lines).

## Edge cases this change must handle

1. **Untrusted text** — n/a: the rule reads only timestamps, revisions and booleans; record text is never executed.
2. **Truncated reads** — an unreadable verify record is `unreadable` and holds a lane with unpushed work.
3. **Shared state files** — the await store is matched by the record's `lane` path (realpath), never by name.
4. **Fail closed** — malformed facts, a thrown read, or unknown push state on a verified head all hold.
5. **Identity scoping** — only the lease holder's own `release` bypasses the rule; `--force` and `--override` do not.
6. **State over time** — every hold expires after `holdMinutes` (150), after which salvage may take the work.
7. **Who wrote it** — refusals are journalled as `hold-refused` with the actor, once per unchanged state.

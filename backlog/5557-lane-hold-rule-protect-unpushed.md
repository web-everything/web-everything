---
bornAs: xbdixjc
kind: story
size: 3
status: open
parent: "5467"
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

## Residual (measured 2026-11-01, R357)

The rule shipped (PR 4508) and is `enforce` (`we:scripts/lib/lane-lease.mjs:553-558`, `BUILT_IN_LANE_HOLD_SETTINGS`). It works:
the WE pool journal (`<pool>/.lane-journal.jsonl`) shows 12 `hold-refused` lines in the last 24 h, e.g. lane 33 at 05:09Z
(`awaiting-verify`, verify running). But the Done-when Live target (0 reaper releases and 0 acquire-resets with `unpushed:true`)
is NOT met. Last 24 h: **22** `lease-reaper` releases with `unpushed:true` (10 over a lane with at least one unpushed commit,
reasons `ttl-stale` and `session-gone`) and **1** acquire-reset over unpushed work; 34 `reclaim-reset` lines with
`unpushed:true` after salvage. Live case: lane 44 released `ttl-stale` at 00:51Z with 5 unpushed commits, then
`acquire-reset` to `origin/main` and re-acquired for smoke. Those lanes had no live hold signal (no await-verify record, no
verify marker, nothing verified), so the rule correctly allowed them; the work is preserved only by the salvage-push
(`we:scripts/lib/lane-pool-salvage-push.mjs`) not by the hold.

## Supported by default - the hold stays narrow (no fork)

Screened 2026-11-01: widening the hold to every lane with unpushed commits has no merit. The holder is already gone
(`ttl-stale` / `session-gone`), so holding only costs pool capacity; the right protection for gone holders is that the work is
never lost, not that the lane stays held. So the hold predicate is unchanged (await-verify, verifying, verified-unpushed,
unreadable, unknown). The residual is a build:

- **R1 salvage before acquire-reset.** `salvagePushLane` is called only from `we:scripts/lane-pool.mjs:2844,3027` and
  `we:scripts/lib/lane-pool-recover.mjs:265`, gated by `recoveryEnabled()`; the acquire-reset path never calls it. Live case:
  lane 17, 05:40Z `acquire-reset` over d76c51f (1 unpushed commit), no salvage ref. Fix: acquire-reset over unpushed commits that
  are not patch-equivalent to the remote must salvage-push first and refuse if the push fails.
- **R2 corrected Live criterion.** Replace "0 reaper releases / resets with `unpushed:true`" with: every release or reset over
  unpushed commits in a 24 h window is followed by a salvage ref or is patch-equivalent to the remote, target 0 without either.

Measured (24 h to 22:42Z): of the 10 reaper releases over real commits only 2 have a recorded salvage ref (lane 44
`salvage/lane-44-20261101-0051`, lane 55 `salvage/lane-55-20261101-0618`, in `<ops>/backup/lane-N-preserve/salvage-ref.txt`);
6 more show a later `unpushedCommitsBefore:0` (likely already on the remote); lane 17 has no evidence either way.
So "nothing lost" is unproven today, not false.

**Proof plan on the live reaper case:** replay lane 44's 00:51Z facts through `laneHoldVerdict` (expect `allow`: no live hold
signal), show its salvage ref, then replay lane 17's acquire-reset and show it now salvage-pushes first. Before/after: the
journal count of unpushed releases/resets with neither salvage ref nor patch-equivalence, 24 h window, target 0.

**Rollback:** `WE_LANE_HOLD=off` restores the pre-rule behaviour; R1 sits behind `recoveryEnabled()`.

Skeptic: the Residual figures were re-measured by a separate skeptic (22 reaper unpushed releases, 12 hold-refused, 1 acquire-reset); the premise "salvage preserves it" was found only partly proven and the lane 17 gap is the one confirmed unprotected case; the hold-widening options were rejected for capacity cost.
Screen: flagged(residue) -> R2 rewrites the Done-when bar (0 becomes "salvage ref or patch-equivalent") in author prose while Done-when #2 still states the old bar: make it an explicit ruling/batch-confirm and edit Done-when; also R1 covers only acquire-reset but R2 covers reaper releases (8 of 10 lack a salvage ref): add a salvage-before-release item, or state the reaper path is deliberately left to the post-hoc salvage-push.

## Edge cases this change must handle

1. **Untrusted text** — n/a: the rule reads only timestamps, revisions and booleans; record text is never executed.
2. **Truncated reads** — an unreadable verify record is `unreadable` and holds a lane with unpushed work.
3. **Shared state files** — the await store is matched by the record's `lane` path (realpath), never by name.
4. **Fail closed** — malformed facts, a thrown read, or unknown push state on a verified head all hold.
5. **Identity scoping** — only the lease holder's own `release` bypasses the rule; `--force` and `--override` do not.
6. **State over time** — every hold expires after `holdMinutes` (150), after which salvage may take the work.
7. **Who wrote it** — refusals are journalled as `hold-refused` with the actor, once per unchanged state.

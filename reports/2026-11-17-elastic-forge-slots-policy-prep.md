# Elastic Forge slots (policy only): prep research for #7583

**Date:** 2026-11-17 · **For:** decision [#7583](/backlog/7583-elastic-forge-slots-let-one-priority-or-idle-time-job-claim/) · build story [#7615](/backlog/7615-build-elastic-forge-slots-mechanics/)

## Verdict

No fork survives. The five rulings (idle-only growth, at most 3 slots, off until proven, fail closed to 1, elastic before smaller slots) were ratified as R354 on 2026-11-01. Prep closes the six ratification clarifications and finds one new drift between the ratified policy and the shipped code, which goes to the build story, not to a new fork.

## Prior art (known occurrences)

- Kubernetes burstable QoS: a pod may use more than its request while the node has spare capacity, and is the first to be squeezed.
- GitHub Actions larger runners: capacity is chosen per job from a pool, with a fixed ceiling.
- Bazel `--local_cpu_resources` and `--jobs`: one build may take many cores up to a declared cap.
- GNU make `-jN` jobserver: extra job tokens are borrowed only while other jobs leave them free, and a running job is never revoked.

All four agree with the ratified shape: borrow only when idle, bounded ceiling, never preempt a running holder.

## Ground truth in the tree (lane at origin/main)

- Statute anchor: `#heavy-command-admission-queue` in `we:docs/agent/platform-decisions.md` (line 4671). The re-entrance sentence ("takes one slot, not two") and the reaper sentence sit in the 2026-09-21 paragraph below clause 4.
- Clarification 4 ("as they already are") is true: in `we:scripts/readiness/heavy-admission.mjs` the `remote.*` leaves are in `ADMISSION_VALID` (line ~290) and the layer loop at line ~382 throws on a non-standard layer unless the leaf is `remote.clientPath`, `remote.slotUnits*`, `remote.elasticSlots*` or `remote.autoSlotUnits`. So the statute may say it.
- Shipped R324 mechanics (commit 1975f61d05) already exist: `resolveRemoteSlotUnits` (line ~1081) grants units only when the Forge reports zero active runs (or the caller is priority), clamps to `remote.maxConcurrent`, and derives the count as parent quota / slot quota (2800% / 800% = 3).

## Drift found (goes to 7615, not a fork)

| Point | Ratified policy (R354) | Shipped code |
|---|---|---|
| Setting name | `remote.elastic.enabled` | `remote.elasticSlots.enabled` (line 252) |
| Default | `false` until proof | `true` (line 252) |
| Idle test | at least 4 of 8 slots free plus Forge headroom | `activeRuns === 0` (line ~1094) |
| Priority claim | off, deferred | `priority` argument still lifts the zero-run gate |
| Max slots | `maxSlots` = 3 | `autoSlotUnits` = 3, or parent/slot quota |

Why this is not a fork: R331/R354 already ruled "off until proven". The default is either on or off, so the shipped `true` is the broken branch. The statute lands the ratified text; 7615 renames, flips the default and tightens the idle test to match, with the live proof gating the flip back to true.

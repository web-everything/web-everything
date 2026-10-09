---
bornAs: x3cjzvz
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/build-dispatch-orphan-adopt.mjs", "we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs"]
dateOpened: "2026-09-29"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2921's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:330` — Track orphan-release counts per item (in a marker or hold) and place a hold after N consecutive releases. Add a test with repeated dead-wrapper cycles for one item.
2. `we:scripts/operations/deliver-item-wrapper.mjs:460` — In the resume path, fail the gate-retry step cleanly (settle as gate-red) when there is no real agent session id. Add a wrapper test where resume:true meets a red gate and asserts no `--resume` spawn.
3. `we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:200` — A unit test explicitly asserting that `checkResumable` rejects resumption when `rowStartedAt` is missing or invalid.
4. `we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs:66` — A code review focusing on keeping test prose aligned with assertions, or a lint rule against contradictory terms in test names.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2921@5264fae59e61a56c18c0c7f85c578b438fb5c900

## Ruling (operator, 2026-10-09 ~13:20 ET)

The open choice from the prepare run (threshold N, and when the per-item streak resets) is ruled:
- **N = 3** consecutive orphan releases of the same item → hold. N is a setting (policy cascade: standard
  default 3, platform preference, tool override), defaulting to `MAX_RESUME_ATTEMPTS`.
- **Reset only on a real outcome** (the item's dispatch opens a PR or resolves the card). Hold expiry does NOT
  reset the streak: one more orphan release after expiry re-holds at once.
- **Operator addition: a hold must trigger a root-cause investigation, not just park the card.** Placing the
  streak hold raises a health smell (one episode per item) that the health daemon's existing investigation
  dispatch (#4078, `we:scripts/conveyor/health-investigate-plan.mjs`) picks up; when the investigation names a
  product change, the existing filing path (#4079, `we:scripts/conveyor/health-file-request.mjs`) files it.
  The hold reason links the episode, so the item is visibly "under investigation", never silently parked.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

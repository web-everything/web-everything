---
bornAs: xkpbs7b
kind: story
size: 5
parent: "5112"
status: open
blockedBy: ["5113"]
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/readiness/heavy-queue-projection.mjs", "we:scripts/readiness/__tests__/heavy-admission-repairs-first.test.mjs", "we:scripts/readiness/__tests__/heavy-queue-projection.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "838e849ab8b35fa4b94216b7d474b3138d979ba5"
tags: [policy, heavy-admission, conveyor, repair]
---

# Heavy-admission serves repairs of open PRs before new builds

The heavy-command queue ranks a waiting repair (fix, ci-heal, conflict-fix, takeover) ahead of new-card
builds, and keeps slots free for repairs. Governed by `heavyQueue.priority` (default `repairs-first`),
`heavyQueue.reservedForRepairs` (default 1) and `heavyQueue.reservedBorrowAfterMin` (default 10, operator
ruling 2026-10-03: the reserved slot can be borrowed once it has sat idle that long).

## Progress

Prepared 2026-10-03 against `838e849ab`.

| Premise | Checked against the code |
| --- | --- |
| The queue is first come, first served. | Confirmed. `isOldestLiveWaiter` (`we:scripts/readiness/heavy-admission.mjs:853-867`) sorts live waiters by `requestedAt` only, within the fast or slow lane. The cap is 2 heavy slots plus 1 fast slot by default (`:161`, `WE_HEAVY_ADMISSION_CAP`). On 2026-10-03, three new-card builds held every heavy slot, one for 28 minutes, while the verify for #3507's conflict-fix waited. |
| The requester kind can be found from what the request already carries. | Yes. The waiter marker has `owner`, `lane`, `num`, `repo`, `pid` and `kind` (`:674-680`). Here `kind` is the command kind, not the dispatch kind. The lane comes from the repo path. Its lease's `purpose` and `session` map to a dispatch kind through `classifyDispatchKind` (`we:scripts/readiness/heavy-queue-projection.mjs:150-159`), which heavy-admission already uses for pending demand (`we:scripts/readiness/heavy-admission.mjs:1086-1091`, `readLaneLease` at `:734`). |
| Every repair kind is recognised. | **No.** `classifyDispatchKind` knows `ci-heal`, `fix`, `review`, `prepare` and `build`. It does not know `conflict-fix` (a repair kind in `REPAIR_KINDS`, `we:scripts/operations/land-advance-repair.mjs:12`) or takeover (a lane taken with `adopt --force`, `we:scripts/lane-pool.mjs:3893-3901`). |
| `verify-lane` goes through the same queue. | Yes. `we:scripts/verify-lane.mjs:386-392` calls `acquireSlotBlocking` directly with the lane, so it reaches the same ranking and slot code. |

## Design

1. **Requester class.** Extend `classifyDispatchKind` to return `conflict-fix` and `takeover`. The builder
   confirms the exact lease `purpose` and `session` strings these paths write; grep for the
   `dispatch-conflict-fix` consumers and `adopt --force`. Add `requesterClass(kind)`: `repair` for fix,
   ci-heal, conflict-fix and takeover; `other` for everything else, including an unknown lease.
2. **Stamp the waiter.** In `markWaiting`, resolve the lane's lease and add `requesterKind` and
   `requesterClass` to the marker. A marker written by older code has neither and ranks as `other`.
3. **Ranking.** In `isOldestLiveWaiter`, under `repairs-first`, sort by class (repair first), then by
   `requestedAt`, inside each queue lane. Under `fifo`, keep today's sort.
4. **Reservation.** In the heavy-slot acquire (`tryAcquireSlot`, `:568`), an `other` requester may take a heavy
   slot only while the number of free heavy slots is greater than `reservedForRepairs`. A repair may take any
   free slot. The value is clamped to cap minus 1, so builds can never be locked out completely. Fast slots are
   not reserved.
   - **Borrowing.** If the reserved slot has been free for `reservedBorrowAfterMin` minutes with **no repair
     waiting**, an `other` requester may take it. The idle clock is the time since the free-heavy-slot count
     last reached the reservation level with no repair waiter; it resets when a repair waits or any slot
     changes hands. A repair arriving while the slot is borrowed waits only for that borrowed job to finish
     (the borrowed job is not preempted).
5. **The turn goes to the oldest *eligible* waiter, not the oldest waiter.** Ranking and reservation must not
   fight. Under `fifo` with a nonzero reservation (a supported combination), take cap 2, one active build, an
   older waiting build and a newer waiting repair: plain FIFO picks the older build, the reservation refuses
   it, and the repair, never being first in line, never gets the reserved slot, so the slot idles until the
   active build ends. So `isOldestLiveWaiter` is evaluated **per slot class over the waiters the reservation
   would admit**: a waiter the reservation refuses for the current free-slot count is skipped, not allowed
   to hold the head of the line. The next free slot therefore goes to the oldest waiter that can actually
   take it (here the repair). A refused build keeps its place and is admitted as soon as the free count allows.
6. **Visibility.** Add `requesterKind` to the queue rows in `we:scripts/readiness/heavy-queue-projection.mjs`,
   so the queue operation shows why a waiter jumped ahead.

**Cost to state plainly:** with the default cap of 2 and 1 reserved, new builds use at most one heavy slot at
a time while a repair has waited recently; once the reserved slot has idled for 10 minutes with no repair
waiting, a build may borrow it (and a repair arriving then waits for that build to finish). Setting
`reservedForRepairs` to 0 keeps only the reordering.

## MVP

Steps 1 to 6.

## Test plan

- **Capability (RED today, fails before this lands):** `we:scripts/readiness/__tests__/heavy-admission-repairs-first.test.mjs`:
  - `fifo`: ranking equals today's (a regression copy of the existing first-come case).
  - `repairs-first`: three build waiters requested earlier and one fix waiter requested later; the fix is the
    oldest live waiter.
  - Reservation, cap 2, reserved 1: one build holds a slot, and a second build is not admitted with one slot
    free; a repair is admitted to that slot.
  - **Policy combination: `fifo` with a nonzero reservation.** Cap 2, reserved 1, one build holds a slot, an
    older build waits, a newer repair waits. The repair acquires the reserved slot at once (the reservation
    refuses the older build, which is skipped, not left at the head of the line). The older build is admitted
    when a slot frees. Run the same fixture under `repairs-first`: same outcome.
  - **Borrow after idle:** cap 2, reserved 1, one build holds a slot, the reserved slot idle for 9 minutes
    with no repair waiting: a second build is not admitted. At 10 minutes (injected clock) it is admitted. A
    repair that arrives afterwards waits for the borrowed job and is then admitted first. A repair waiting
    resets the idle clock, so no build borrows while a repair waits. `reservedBorrowAfterMin` bad value
    falls back to 10 through the loader.
  - Reserved 0: the second build is admitted.
  - Reserved 5 with cap 2 is clamped to 1.
  - An unknown lease and an old marker without the new fields count as `other`.
  - The classifier maps each repair kind, including conflict-fix and takeover.
  - Default (no config): `repairs-first` with 1 reserved, borrowable after 10 minutes.
  - **Replay of #3507:** three new-card build leases each hold or wait for a heavy slot, then the conflict-fix
    verify for #3507 arrives. Before this story: it waits behind all three (28 minutes on the day). After it:
    one heavy slot is held for it (no build has idled long enough to borrow it), so it starts at once.
- **Capability (RED today, fails before this lands):** `we:scripts/readiness/__tests__/heavy-queue-projection.test.mjs`: rows carry `requesterKind`.

## Proof plan

1. Live, on this host: in two lanes, one leased as a build and one leased as a conflict-fix, start long
   `we:scripts/readiness/heavy-admission.mjs run -- sleep` holders and waiters in the #3507 order. Show the queue operation's
   status output. **Before** (current main): the repair waits last. **After:** the repair is admitted first,
   and the second build waits with the reservation as its reason.
2. Paste both status outputs in the PR. Stop every holder you started, by PID.

## Follow-ups

- Card #3610 (how far to take heavy-admission control) is related. It is about adaptive capacity; this story
  is about ordering by requester.

## Done when

1. **Executable:** the #3507 replay case fails before this lands and passes after.
2. Proof step 1 is pasted in the PR.

---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/__tests__/merge-gate-inventory.test.mjs", "we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/lib/__tests__/drain-skip-reasons.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# merge-gate-inventory test fails: drain skip kinds merge-lock-held, numbering, red-team-pending are unclassified

we:scripts/lib/__tests__/merge-gate-inventory.test.mjs > 'exactly classifies every drain skip kind' fails on the drain overlay stack top (lane/hot-catchup-stale-pending-v2 lineage, seen 2026-10-20) with or without the xym8nt4 change: the received kind list has merge-lock-held, numbering and red-team-pending that the expected inventory lacks. The overlay stack added these skip kinds without updating the gate inventory. Fix: classify the three kinds in the inventory (and card-grouped from xym8nt4 if the inventory enumerates strategy kinds), so the test is green on the stack and on main once the stack graduates.

## Acceptance

- [A1] **Executable** — In we:scripts/lib/__tests__/merge-gate-inventory.test.mjs, “exactly classifies every drain skip kind” compares the sorted `SKIP_KINDS` set with `classifiedSkipKinds()` with no missing or stale entries. On the overlay stack this must classify `merge-lock-held`, `numbering`, and `red-team-pending` as well as `card-grouped`.
- [A2] **Executable** — The same command's “classifies card-group source, reserved-file and unreadable-state holds as enqueue scheduling” maps the real `cardGroupHold` reasons into `card-grouped` and proves the inventory places that kind at enqueue. PR #5762 supplies this case; preserve it while classifying the other overlay kinds.
- [A3] **Must** — An unknown skip kind still fails the inventory equality check. Do not remove a kind or weaken a landing gate to make the inventory agree.

## Non-goals

- [N1] Change scheduling or admission policy. This item documents the ownership of existing decisions.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: compare source-declared kinds, without executing reason text.
2. **Truncated reads** — n/a: the inventory test reads whole local source files.
3. **Shared state files** — n/a: inventory classification performs no shared writes.
4. **Fail closed** — Unknown kinds fail the equality assertion; never silently classify all unknowns as scheduling.
5. **Identity scoping** — Keep source, reserved-file and unreadable group holds classified identically across repos.
6. **State over time** — New and removed kinds must update the inventory and its named regression cases together.
7. **Who wrote it** — n/a: no external input gains admission authority through inventory data.

## Risks

Misclassifying an admission refusal as scheduling can hide a missing merge-gate counterpart. Review each overlay kind against its actual emitter; keep unknowns failing and preserve all existing refusals.

## Test plan

Run the A1 command on main and on the overlay stack. Both must have exact inventory equality; A2 must cover all three group-hold reasons. Add a new kind temporarily in a test fixture to prove that an unclassified kind fails, without changing production guards. The broader emitted-kind standards gate is tracked by prevention card xp7g4rd.

From the WE checkout:

```bash
npm run test:unit -- scripts/lib/__tests__/merge-gate-inventory.test.mjs
```

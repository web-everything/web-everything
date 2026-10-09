---
bornAs: xkfzukn
kind: story
size: 5
priority: high
status: open
scope: ["we:scripts/backlog.mjs", "we:scripts/lib/build-queue.mjs", "we:scripts/conveyor/queue-store.mjs", "we:scripts/conveyor/queue.mjs"]
dateOpened: "2026-09-28"
tags: []
---

# Build-queue ordering: read the real cleared queue, and let priority count

`we:scripts/backlog.mjs build-queue --json` still reads the old in-checkout `we:.conveyor/queue.json` instead of the state-home location PR #2816 moved the queue to, so it reports `cleared: 0` from every checkout even when work is genuinely cleared — a live probe from `~/workspace/wev-control` shows `build-queue --json` at `cleared: 0` while `node we:scripts/conveyor/queue.mjs list` (which does resolve through the state home) reports 77 cleared items in the same tree at the same moment. That makes the build queue's own headline "how much is ready to build" number silently wrong on every checkout, and it is the same class of bug already fixed for `/wip` on the plateau side (card 4341) — the fix here is the same shape: read `buildQueued`/cleared state through `we:scripts/conveyor/queue-store.mjs`'s state-home resolver instead of a hardcoded in-checkout path.

Separately, and compounding it: the ordering itself never looks at `priority`. `we:scripts/lib/build-queue.mjs`'s `orderQueueDetailed` sorts strictly `tier → effectiveScore (desc) → rank (asc) → dateOpened (asc) → num (asc)`, and `DEFAULT_CONFIG.criteria` is only `value` / `timeCriticality` / `unblocks` (`we:scripts/lib/build-queue.mjs:33-36`) — `priority: high` frontmatter (`we:scripts/backlog.mjs`'s own `prioritize` verb writes it) is never read anywhere in the scoring or sort. Concretely: #4348/#4352/#4353 were all filed today as `priority: high` blockers, but before this session hand-pinned them via `tier`/`rank` they sat in the `normal` tier behind 9 older ordinary cards purely on WSJF score — the frontmatter said "high priority" and the queue ignored it completely.

**Recommended default: make `priority: high` count as an in-tier boost (or, cheaper, auto-pin any card the priority verb marks high) rather than requiring a human to hand-run `tier`/`rank` every time, and fix the read path to the real state home first** — the read-path bug is the more urgent of the two since it makes the queue's `cleared` count actively lie on every checkout, not just mis-order within the truth. As a secondary, low-cost win: have the builder's `--dry-run` print the full pick order with the reason for each position (which criterion/tier/rank decided it), so a human auditing "why is X above Y" doesn't have to re-derive `orderQueueDetailed` by hand — this session had to read `we:scripts/lib/build-queue.mjs` source directly to explain the current order.

## Ruling (already settled: priority rulings Q1/Q2, operator 2026-10-08)

The prepare run reported an open choice ("boost within tier, or auto-pin?"). It is already ruled: priority is a
**class** (P0–P4) derived from facts by a pure rule plus an operator override label (Q1); queues order by class
first, then within a class by the fix-queue score (unblocks + time waited) (Q2). So `priority: high` maps to a
class, not a score boost or a pin. Aging moves an item up one class after 8 h, never into P0. Build to that.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/build-queue.test.mjs` (red before: 9/9 fail — no
   class fields, and the CLI case counts `cleared` from frontmatter instead of the state-home sidecar; green after).
2. **Live** — in `~/workspace/wev-control`, `node we:scripts/backlog.mjs build-queue --json` reports `cleared` from the
   same sidecar `node we:scripts/conveyor/queue.mjs list` reads (`sidecar.path` / `sidecar.entries` match), and every
   row is in class order (P0 → P4), with `priority: high` cards in P2 ahead of normal P3 cards.

## Design notes

- Class comes from the shared rule `we:scripts/lib/delivery-priority.mjs` (no re-derivation); the card adapter is
  `buildQueuePriorityFacts` in `we:scripts/lib/build-queue.mjs`: >= 2 pending dependents → P1, `priority: high` →
  P2, `priority: low` → the operator `low` override (P4), wait = time since the card was cleared (sidecar
  `addedAt`), aging +1 class after `agingHours`, never into P0.
- Sort: class → tier (hand pin, within a class) → fix-queue score (unblocks × 60 + minutes waited) → WSJF → rank →
  date → num. Mode `off` in `we:scripts/lib/delivery-priority-settings.json` gives the exact pre-class order.

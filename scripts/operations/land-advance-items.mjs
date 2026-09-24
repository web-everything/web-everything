/**
 * @file land-advance-items.mjs
 * The item-pull half of land-advance's pure plan (#3720), import-free so the read-only declaring module stays so.
 * The queue itself is read in `land-advance-items-io.mjs` (`priorityQueue`). Every hold (blockedBy, epics, no
 * `scope:`, scope overlap, free lanes, the pause) is dispatch-plan's rule: `planItems` only takes its launches up to
 * the budget land-advance has left, and never re-derives a hold.
 */
/** How many items one call may queue while the operator has not ruled otherwise (the safest non-zero value). */
export const DEFAULT_MAX_ITEMS_PER_CALL = 1;
export function planItems({ queue = [], skipped = [], itemPlan = {}, budget = 0, maxItems = DEFAULT_MAX_ITEMS_PER_CALL } = {}) {
  const rank = new Map(queue.map((q) => [String(q.num), q.rank])), take = Math.max(0, Math.min(budget, maxItems));
  const withRank = (x) => ({ ...x, num: String(x.num), rank: rank.get(String(x.num)) ?? null });
  const launch = (itemPlan.launch ?? []).map(withRank), proposed = launch.slice(0, take);
  const deferred = [...launch.slice(take).map((x) => ({ ...x, reason: proposed.length < budget ? 'per-call-cap' : 'capacity' })),
    ...(itemPlan.held ?? []).map((h) => withRank(h))].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  return { proposed, deferred, skipped };
}

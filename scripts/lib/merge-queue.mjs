/**
 * @file scripts/lib/merge-queue.mjs
 * @description PURE merge-queue rules for the Integration Authority protocol (delivery-standard epic 5407;
 *   card xs1hdl7). Facts in, verdict out. No IO, no clock, no forge, no label strings.
 *
 * The queue (operator direction 2026-10-08):
 *   - Ready PRs form one ordered queue: ruled priority class first, then in-class score (higher first), then
 *     today's order (item rank, then PR number).
 *   - Only the HEAD is acted on. It merges only when merge-fresh against the CURRENT main tip
 *     (`./merge-freshness.mjs`). If stale it is refreshed once per head (the IO side uses the existing
 *     `refreshOntoMain` path) and the queue waits for its new run. After a merge, the next head is re-judged
 *     against the new main.
 *   - The drain stays the single writer to main; this module only says what to do next.
 *
 * Reserved, NOT built (settings refuse them today):
 *   - batchSize > 1: test N heads together, split on failure.
 *   - strategy 'forge-native-queue': hand the queue to the forge's own merge queue (e.g. GitHub merge queue)
 *     through an adapter instead of the drain merging directly.
 *
 * Off (`enabled: false`, the default) is today: every ready PR is planned `merge` in today's order. The
 * freshness rule has its own off switch; with both off the plan is byte-for-byte today's.
 */
import { assessMergeFreshness, MERGE_FRESHNESS_DEFAULTS } from './merge-freshness.mjs';

export const BUILT_STRATEGIES = Object.freeze(['drain-direct']);
export const RESERVED_STRATEGIES = Object.freeze(['forge-native-queue']);

/** Declared settings. Off = today. */
export const MERGE_QUEUE_DEFAULTS = Object.freeze({
  enabled: false,
  /** Fixed at 1. Batching is a later policy. */
  batchSize: 1,
  /** Ruled priority classes, first = goes first. A class not listed sorts as `defaultClass`. */
  classOrder: Object.freeze(['main-fix', 'normal']),
  defaultClass: 'normal',
  strategy: 'drain-direct',
});

/** @returns {{ok: boolean, errors: string[]}} */
export function validateQueueSettings(settings) {
  const s = { ...MERGE_QUEUE_DEFAULTS, ...settings };
  const errors = [];
  if (s.batchSize !== 1) errors.push('batch-size-not-built');
  if (RESERVED_STRATEGIES.includes(s.strategy)) errors.push('strategy-not-built');
  else if (!BUILT_STRATEGIES.includes(s.strategy)) errors.push('strategy-unknown');
  if (!Array.isArray(s.classOrder) || !s.classOrder.includes(s.defaultClass)) errors.push('default-class-not-ruled');
  return { ok: errors.length === 0, errors };
}

const todayCompare = (a, b) => {
  const ra = Number.isFinite(a.itemRank) ? a.itemRank : Infinity;
  const rb = Number.isFinite(b.itemRank) ? b.itemRank : Infinity;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.num - b.num;
};

/**
 * Order queue entries `{key, num, itemRank, priorityClass, score}`. Returns a new array.
 * Off: today's order (item rank ascending, Infinity last, then PR number).
 */
export function orderQueue(entries, settings = MERGE_QUEUE_DEFAULTS) {
  const s = { ...MERGE_QUEUE_DEFAULTS, ...settings };
  const list = [...entries];
  if (!s.enabled) return list.sort(todayCompare);
  const fallback = s.classOrder.indexOf(s.defaultClass);
  const classRank = (e) => { const i = s.classOrder.indexOf(e.priorityClass); return i === -1 ? fallback : i; };
  const score = (e) => (Number.isFinite(e.score) ? e.score : 0);
  return list.sort((a, b) => (classRank(a) - classRank(b)) || (score(b) - score(a)) || todayCompare(a, b));
}

/** Decide one PR's action given its freshness facts. */
function decide(pr, { main, nowMs, refreshed, freshnessSettings }) {
  const f = { ...MERGE_FRESHNESS_DEFAULTS, ...freshnessSettings };
  if (!f.enabled) return { action: 'merge', reasons: ['rule-off'] };
  const state = pr.requiredCheck?.state;
  if (state === 'pending') return { action: 'wait', reasons: ['run-pending'] };
  if (state === 'failed') return { action: 'refuse', reasons: ['required-check-failed'] };
  const verdict = assessMergeFreshness({ pr, main: main(pr), nowMs, settings: f });
  if (verdict.fresh) return { action: 'merge', reasons: [] };
  if (verdict.reasons.includes('facts-incomplete')) return { action: 'refuse', reasons: verdict.reasons };
  if (refreshed?.[pr.key] === pr.headSha) return { action: 'wait', reasons: ['refresh-already-requested'] };
  return { action: 'refresh', reasons: verdict.reasons };
}

/**
 * Next action for every ready PR.
 * @param {{queue: object[], main: (pr: object) => object, nowMs: number, refreshed: Record<string,string>,
 *   queueSettings?: object, freshnessSettings?: object}} facts
 *   `main(pr)` gives the main facts relative to that PR's base. `refreshed` maps PR key → head already refreshed.
 * @returns {{key: string, num: number, action: 'merge'|'refresh'|'wait'|'refuse'|'queued', reasons: string[]}[]}
 */
export function planQueue({ queue, main, nowMs, refreshed = {}, queueSettings = MERGE_QUEUE_DEFAULTS, freshnessSettings = MERGE_FRESHNESS_DEFAULTS }) {
  const q = { ...MERGE_QUEUE_DEFAULTS, ...queueSettings };
  const valid = validateQueueSettings(q);
  if (!valid.ok) throw new Error(`merge-queue: invalid settings: ${valid.errors.join(', ')}`);
  const ordered = orderQueue(queue, q);
  const ctx = { main, nowMs, refreshed, freshnessSettings };
  return ordered.map((pr, i) => {
    if (q.enabled && i >= q.batchSize) return { key: pr.key, num: pr.num, action: 'queued', reasons: ['behind-head'] };
    return { key: pr.key, num: pr.num, ...decide(pr, ctx) };
  });
}

/**
 * @file scripts/lib/__tests__/merge-queue.replay.test.mjs
 * @description Replay fixtures for the merge-queue protocol rules (card xs1hdl7, Integration Authority under
 *   epic 5407): "is the head merge-fresh?", queue order, and "next action". Facts in, verdict out.
 *
 * Fixtures are real 2026-10-08 data (web-everything/web-everything), read from GitHub + git on that day:
 *   - #4361 merged 16:57:05Z on a `test` pass from 15:14:24Z (103 min old), its base 125 commits behind main.
 *     Main went red at 17:04Z and stayed red 6 h 41 min.
 *   - RED_WINDOW: all 60 PRs merged 16:00Z..23:59Z, with pass age, base lag, and file overlap with main's
 *     moves since the PR's base.
 */
import { describe, it, expect } from 'vitest';
import { assessMergeFreshness, MERGE_FRESHNESS_DEFAULTS } from '../merge-freshness.mjs';
import { orderQueue, planQueue, validateQueueSettings, MERGE_QUEUE_DEFAULTS } from '../merge-queue.mjs';

const MIN = 60_000;
const ON = { ...MERGE_FRESHNESS_DEFAULTS, enabled: true };
const ON_DISJOINT = { ...ON, allowDisjointMainMoves: true };
const QUEUE_ON = { ...MERGE_QUEUE_DEFAULTS, enabled: true };

const PR_4361 = {
  key: 'we#4361', num: 4361, itemRank: 4361, priorityClass: 'normal', score: 0,
  headSha: 'a5938d8938a20137e76d2145e49d40ee8fff4970',
  baseSha: '52c4af9c3a22fffe2a01965240bba0f1d328e00e',
  files: Array.from({ length: 14 }, (_, i) => `f${i}`), filesComplete: true,
  requiredCheck: { state: 'passed', headSha: 'a5938d8938a20137e76d2145e49d40ee8fff4970', completedAtMs: Date.parse('2026-10-08T15:14:24Z') },
};
const MAIN_AT_4361 = {
  tipSha: '26b439b79ec7a5b8b289c6fde54e8abc64a639d0', commitsSinceBase: 125,
  filesChangedSinceBase: ['f3', 'other'], complete: true,
};
const MERGED_4361_MS = Date.parse('2026-10-08T16:57:05Z');

// [pr, passAgeMin, commitsBehind, overlappingFiles] — every PR merged 2026-10-08 16:00Z..23:59Z.
const RED_WINDOW = [
  [4460, 46, 17, 0], [4464, 20, 32, 0], [4466, 20, 32, 0], [4469, 20, 20, 0], [4471, 18, 22, 0], [4443, 33, 107, 1],
  [4474, 9, 13, 0], [4470, 24, 39, 1], [4475, 11, 7, 0], [4361, 103, 125, 1], [4477, 7, 11, 0], [4480, 3, 12, 0],
  [4473, 35, 47, 0], [4476, 29, 21, 0], [4472, 29, 43, 0], [4482, 7, 5, 0], [4483, 10, 8, 0], [4463, 20, 94, 0],
  [4450, 161, 141, 0], [4486, 10, 6, 0], [4485, 33, 23, 0], [4489, 2, 0, 0], [4490, 2, 3, 0], [4487, 23, 32, 0],
  [4447, 12, 116, 2], [4398, 9, 6, 0], [4491, 6, 6, 0], [4492, 23, 3, 0], [4493, 17, 3, 0], [4497, 2, 5, 0],
  [4496, 5, 8, 0], [4468, 15, 146, 0], [4499, 1, 5, 0], [4500, 14, 8, 0], [4498, 25, 22, 0], [4503, 10, 7, 0],
  [4504, 12, 10, 0], [4507, 3, 0, 0], [4505, 23, 9, 0], [4509, 3, 4, 0], [4495, 12, 42, 0], [4513, 16, 6, 0],
  [4441, 28, 251, 1], [4488, 39, 43, 0], [4515, 26, 21, 0], [4517, 1, 0, 0], [4514, 56, 33, 0], [4484, 25, 106, 0],
  [4501, 54, 74, 0], [4506, 47, 60, 0], [4519, 14, 14, 0], [4520, 16, 17, 0], [4521, 16, 19, 0], [4518, 38, 29, 0],
  [4516, 23, 31, 0], [4523, 28, 20, 0], [4528, 15, 9, 0], [4529, 26, 12, 0], [4494, 31, 22, 0], [4530, 23, 11, 0],
];

function windowFacts([num, ageMin, behind, overlap]) {
  const nowMs = Date.parse('2026-10-08T20:00:00Z');
  const pr = {
    key: `we#${num}`, num, itemRank: num, priorityClass: 'normal', score: 0,
    headSha: `h${num}`, baseSha: behind ? `b${num}` : `tip${num}`, files: ['own', ...(overlap ? ['shared'] : [])], filesComplete: true,
    requiredCheck: { state: 'passed', headSha: `h${num}`, completedAtMs: nowMs - ageMin * MIN },
  };
  const main = { tipSha: `tip${num}`, commitsSinceBase: behind, filesChangedSinceBase: behind ? ['elsewhere', ...(overlap ? ['shared'] : [])] : [], complete: true };
  return { pr, main, nowMs };
}

describe('assessMergeFreshness', () => {
  it('off (the default) keeps today: every PR with a passed check is merge-fresh, #4361 included', () => {
    expect(MERGE_FRESHNESS_DEFAULTS.enabled).toBe(false);
    const v = assessMergeFreshness({ pr: PR_4361, main: MAIN_AT_4361, nowMs: MERGED_4361_MS, settings: MERGE_FRESHNESS_DEFAULTS });
    expect(v).toEqual({ fresh: true, reasons: ['rule-off'] });
  });

  it('replay #4361: on, it is NOT merge-fresh (base behind main AND pass 103 min old)', () => {
    const v = assessMergeFreshness({ pr: PR_4361, main: MAIN_AT_4361, nowMs: MERGED_4361_MS, settings: ON });
    expect(v.fresh).toBe(false);
    expect(v.reasons).toEqual(['base-behind-main', 'pass-too-old']);
  });

  it('replay #4361: the disjoint setting does not save it (main touched one of its files)', () => {
    const v = assessMergeFreshness({ pr: PR_4361, main: MAIN_AT_4361, nowMs: MERGED_4361_MS, settings: ON_DISJOINT });
    expect(v.reasons).toEqual(['base-behind-main', 'pass-too-old']);
  });

  it('a pass on the current tip, younger than max age, is merge-fresh', () => {
    const pr = { ...PR_4361, baseSha: MAIN_AT_4361.tipSha, requiredCheck: { ...PR_4361.requiredCheck, completedAtMs: MERGED_4361_MS - 5 * MIN } };
    const main = { ...MAIN_AT_4361, commitsSinceBase: 0, filesChangedSinceBase: [] };
    expect(assessMergeFreshness({ pr, main, nowMs: MERGED_4361_MS, settings: ON })).toEqual({ fresh: true, reasons: [] });
  });

  it('disjoint main moves: on → fresh, off → base-behind-main', () => {
    const pr = { ...PR_4361, requiredCheck: { ...PR_4361.requiredCheck, completedAtMs: MERGED_4361_MS - 5 * MIN } };
    const main = { ...MAIN_AT_4361, filesChangedSinceBase: ['unrelated'] };
    expect(assessMergeFreshness({ pr, main, nowMs: MERGED_4361_MS, settings: ON_DISJOINT })).toEqual({ fresh: true, reasons: [] });
    expect(assessMergeFreshness({ pr, main, nowMs: MERGED_4361_MS, settings: ON }).reasons).toEqual(['base-behind-main']);
  });

  it('a pass on an older head does not count', () => {
    const pr = { ...PR_4361, baseSha: MAIN_AT_4361.tipSha, requiredCheck: { ...PR_4361.requiredCheck, headSha: 'older', completedAtMs: MERGED_4361_MS - MIN } };
    const v = assessMergeFreshness({ pr, main: { ...MAIN_AT_4361, commitsSinceBase: 0 }, nowMs: MERGED_4361_MS, settings: ON });
    expect(v.reasons).toEqual(['pass-not-on-head']);
  });

  it('fails closed: truncated file lists, an incomplete main read, or a missing pass time are incomplete facts', () => {
    const base = { pr: PR_4361, main: MAIN_AT_4361, nowMs: MERGED_4361_MS, settings: ON_DISJOINT };
    expect(assessMergeFreshness({ ...base, pr: { ...PR_4361, filesComplete: false } }).reasons).toEqual(['facts-incomplete']);
    expect(assessMergeFreshness({ ...base, main: { ...MAIN_AT_4361, complete: false } }).reasons).toEqual(['facts-incomplete']);
    expect(assessMergeFreshness({ ...base, pr: { ...PR_4361, requiredCheck: { ...PR_4361.requiredCheck, completedAtMs: null } } }).reasons).toEqual(['facts-incomplete']);
    expect(assessMergeFreshness({ ...base, main: { ...MAIN_AT_4361, tipSha: '' } }).reasons).toEqual(['facts-incomplete']);
  });

  it('replay the 2026-10-08 window (60 merges): strict lets 3 through unchanged, disjoint+30 min lets 45; #4361 is caught by both', () => {
    const fresh = (settings) => RED_WINDOW.filter((row) => assessMergeFreshness({ ...windowFacts(row), settings }).fresh).map(([n]) => n);
    expect(fresh(ON)).toEqual([4489, 4507, 4517]);
    const loose = fresh(ON_DISJOINT);
    expect(loose).toHaveLength(45);
    expect(loose).not.toContain(4361);
    expect(fresh(MERGE_FRESHNESS_DEFAULTS)).toHaveLength(60);
  });
});

describe('orderQueue', () => {
  const entries = [
    { key: 'a', num: 30, itemRank: 3, priorityClass: 'normal', score: 0 },
    { key: 'b', num: 10, itemRank: 9, priorityClass: 'main-fix', score: 0 },
    { key: 'c', num: 20, itemRank: Infinity, priorityClass: 'normal', score: 5 },
    { key: 'd', num: 5, itemRank: 3, priorityClass: 'normal', score: 0 },
  ];
  it('off keeps today: item rank ascending, then PR number', () => {
    expect(orderQueue(entries, MERGE_QUEUE_DEFAULTS).map((e) => e.key)).toEqual(['d', 'a', 'b', 'c']);
  });
  it('on: ruled priority class first, then in-class score (higher first), then today’s order', () => {
    expect(orderQueue(entries, QUEUE_ON).map((e) => e.key)).toEqual(['b', 'c', 'd', 'a']);
  });
  it('an unknown class sorts with the default class, never ahead of a ruled one', () => {
    const odd = [{ key: 'x', num: 1, itemRank: 1, priorityClass: 'made-up', score: 0 }, entries[1]];
    expect(orderQueue(odd, QUEUE_ON).map((e) => e.key)).toEqual(['b', 'x']);
  });
  it('does not mutate its input', () => {
    const copy = entries.map((e) => ({ ...e }));
    orderQueue(entries, QUEUE_ON);
    expect(entries).toEqual(copy);
  });
});

describe('planQueue (next action)', () => {
  const fresh = (num, extra = {}) => ({
    key: `we#${num}`, num, itemRank: num, priorityClass: 'normal', score: 0, headSha: `h${num}`, baseSha: 'tip',
    files: ['x'], filesComplete: true, requiredCheck: { state: 'passed', headSha: `h${num}`, completedAtMs: 0 }, ...extra,
  });
  const main = { tipSha: 'tip', commitsSinceBase: 0, filesChangedSinceBase: [], complete: true };
  const facts = (queue, more = {}) => ({ queue, main: (pr) => (pr.baseSha === 'tip' ? main : { ...main, commitsSinceBase: 4, filesChangedSinceBase: ['x'] }), nowMs: MIN, refreshed: {}, ...more });

  it('both off: every PR merges, in today’s order (byte-for-byte today)', () => {
    const plan = planQueue({ ...facts([fresh(2), fresh(1, { baseSha: 'old' })]), queueSettings: MERGE_QUEUE_DEFAULTS, freshnessSettings: MERGE_FRESHNESS_DEFAULTS });
    expect(plan.map((p) => [p.key, p.action])).toEqual([['we#1', 'merge'], ['we#2', 'merge']]);
  });

  it('queue on: only the head gets an action; the rest are queued behind it', () => {
    const plan = planQueue({ ...facts([fresh(1), fresh(2)]), queueSettings: QUEUE_ON, freshnessSettings: ON });
    expect(plan.map((p) => [p.key, p.action])).toEqual([['we#1', 'merge'], ['we#2', 'queued']]);
  });

  it('queue on, stale head: refresh once per head, then wait for the new run', () => {
    const stale = fresh(1, { baseSha: 'old' });
    const first = planQueue({ ...facts([stale, fresh(2)]), queueSettings: QUEUE_ON, freshnessSettings: ON });
    expect(first[0]).toMatchObject({ key: 'we#1', action: 'refresh', reasons: ['base-behind-main'] });
    expect(first[1].action).toBe('queued');
    const again = planQueue({ ...facts([stale]), refreshed: { 'we#1': 'h1' }, queueSettings: QUEUE_ON, freshnessSettings: ON });
    expect(again[0]).toMatchObject({ action: 'wait', reasons: ['refresh-already-requested'] });
  });

  it('a pending run on the head waits; a failed one is refused (other gates own the fix)', () => {
    const pending = fresh(1, { requiredCheck: { state: 'pending', headSha: 'h1', completedAtMs: null } });
    expect(planQueue({ ...facts([pending]), queueSettings: QUEUE_ON, freshnessSettings: ON })[0]).toMatchObject({ action: 'wait', reasons: ['run-pending'] });
    const failed = fresh(1, { requiredCheck: { state: 'failed', headSha: 'h1', completedAtMs: 0 } });
    expect(planQueue({ ...facts([failed]), queueSettings: QUEUE_ON, freshnessSettings: ON })[0]).toMatchObject({ action: 'refuse', reasons: ['required-check-failed'] });
  });

  it('a P0 main-fix goes first but still needs a fresh run', () => {
    const fix = fresh(9, { priorityClass: 'main-fix', baseSha: 'old' });
    const plan = planQueue({ ...facts([fresh(1), fix]), queueSettings: QUEUE_ON, freshnessSettings: ON });
    expect(plan[0]).toMatchObject({ key: 'we#9', action: 'refresh' });
    expect(plan[1]).toMatchObject({ key: 'we#1', action: 'queued' });
  });

  it('incomplete facts refuse (fail closed), never merge', () => {
    const bad = fresh(1, { filesComplete: false });
    expect(planQueue({ ...facts([bad]), queueSettings: QUEUE_ON, freshnessSettings: ON_DISJOINT })[0]).toMatchObject({ action: 'refuse', reasons: ['facts-incomplete'] });
  });

  it('empty queue → no actions', () => {
    expect(planQueue({ ...facts([]), queueSettings: QUEUE_ON, freshnessSettings: ON })).toEqual([]);
  });
});

describe('validateQueueSettings', () => {
  it('accepts the defaults and queue-on', () => {
    expect(validateQueueSettings(MERGE_QUEUE_DEFAULTS)).toEqual({ ok: true, errors: [] });
    expect(validateQueueSettings(QUEUE_ON).ok).toBe(true);
  });
  it('batching and the forge-native queue are reserved future policies, refused today', () => {
    expect(validateQueueSettings({ ...QUEUE_ON, batchSize: 3 }).errors).toEqual(['batch-size-not-built']);
    expect(validateQueueSettings({ ...QUEUE_ON, strategy: 'forge-native-queue' }).errors).toEqual(['strategy-not-built']);
    expect(validateQueueSettings({ ...QUEUE_ON, strategy: 'nonsense' }).errors).toEqual(['strategy-unknown']);
  });
  it('planQueue throws on invalid settings rather than guessing', () => {
    expect(() => planQueue({ queue: [], main: () => ({}), nowMs: 0, refreshed: {}, queueSettings: { ...QUEUE_ON, batchSize: 2 }, freshnessSettings: ON })).toThrow(/batch-size-not-built/);
  });
});

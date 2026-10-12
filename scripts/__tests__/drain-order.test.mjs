/**
 * @file scripts/__tests__/drain-order.test.mjs
 * @description Drain order: serve the longest-waiting ready PR first (operator-approved 2026-10-10 ~22:15 ET).
 *   The order is (1) the merge-queue class (main-fix first — `prioritizeMainFix`, unchanged), (2) the delivery
 *   priority class from the shared rule (we:scripts/lib/delivery-priority.mjs) when the drain's priority mode is
 *   `enforce` (`shadow` only logs it), (3) the time since the PR became ready (its `ready-to-merge` label time),
 *   oldest first, (4) the PR number. `drain.order: card-number` keeps the old order (card NNN, then PR #).
 *
 *   The replay below is tonight's real ready set. Ready-label times are the LAST `labeled ready-to-merge` event of
 *   each PR, read from the GitHub issue-events timeline on 2026-10-10 (all added by `web-everything[bot]`). None of
 *   these PRs carries a lane manifest, so the drain sees `item: null` for all seven (the old order is then plain
 *   PR #). Facts: #4868/#4869/#4870 change only one backlog card each (no code); #4788's head
 *   `lane/resource-slice-3` is the base of open PR #4799 (one stacked change waits on it).
 */
import { describe, it, expect } from 'vitest';
import { planLabelDrain, orderReadyCandidates, drainPriorityFacts, resolveDrainOrderSettings, formatDrainOrderLines, DRAIN_ORDERS } from '../merge-ai-prs.mjs';
import { prioritizeMainFix } from '../lib/merge-queue-hook.mjs';
import { resolvePrioritySettings } from '../lib/delivery-priority.mjs';

const SHARED = { agingHours: 8, maxLiveP0: 2, unblockWeightMinutes: 60 };
const shadow = resolvePrioritySettings({ ...SHARED, mode: 'shadow' });
const enforce = resolvePrioritySettings({ ...SHARED, mode: 'enforce' });

// Real ready-to-merge label times (UTC; ET = UTC-4).
const TONIGHT = [
  { num: 4788, readyAt: '2026-10-11T01:53:33Z', changesCode: true, stackedDependents: 1 }, // 21:53 ET
  { num: 4814, readyAt: '2026-10-10T23:34:19Z', changesCode: true, stackedDependents: 0 }, // 19:34 ET
  { num: 4857, readyAt: '2026-10-11T01:22:33Z', changesCode: true, stackedDependents: 0 }, // 21:22 ET
  { num: 4860, readyAt: '2026-10-11T01:42:10Z', changesCode: true, stackedDependents: 0 }, // 21:42 ET
  { num: 4868, readyAt: '2026-10-11T01:56:13Z', changesCode: false, stackedDependents: 0 }, // 21:56 ET
  { num: 4869, readyAt: '2026-10-11T01:56:57Z', changesCode: false, stackedDependents: 0 }, // 21:56 ET
  { num: 4870, readyAt: '2026-10-11T02:02:46Z', changesCode: false, stackedDependents: 0 }, // 22:02 ET
];
const NOW = Date.parse('2026-10-11T02:15:00Z'); // 22:15 ET, the approval time

const cand = (row, extra = {}) => ({ num: row.num, repo: null, item: row.item ?? null, blockedBy: [], decision: 'merge', ...extra });
const infoFrom = (rows, extra = {}) => {
  const byNum = new Map(rows.map((r) => [r.num, r]));
  return (c) => {
    const r = byNum.get(c.num);
    const readyAtMs = r?.readyAt ? Date.parse(r.readyAt) : null;
    return { readyAtMs, facts: drainPriorityFacts(c, { readyAtMs, changesCode: r?.changesCode, stackedDependents: r?.stackedDependents, ...(extra[c.num] ?? {}) }) };
  };
};
const plan = (rows, readyOrder) => planLabelDrain(rows.map((r) => cand(r)), readyOrder ? { readyOrder } : {});
const nums = (p) => p.ready.map((c) => c.num);

describe('drain order — replay of tonight\'s ready set', () => {
  it('before: the old order (card NNN, then PR #) — no PR has a card, so it is plain PR #', () => {
    expect(nums(plan(TONIGHT))).toEqual([4788, 4814, 4857, 4860, 4868, 4869, 4870]);
    expect(nums(plan(TONIGHT, { order: 'card-number', priority: shadow, now: NOW, infoOf: infoFrom(TONIGHT) })))
      .toEqual([4788, 4814, 4857, 4860, 4868, 4869, 4870]);
  });

  it('after (priority shadow): oldest ready first; the class is logged but does not reorder', () => {
    const p = plan(TONIGHT, { order: 'ready-age', priority: shadow, now: NOW, infoOf: infoFrom(TONIGHT) });
    expect(nums(p)).toEqual([4814, 4857, 4860, 4788, 4868, 4869, 4870]);
    const byNum = new Map(p.readyOrder.map((r) => [r.num, r]));
    expect(byNum.get(4814).class).toBe('P3');
    expect(byNum.get(4788).class).toBe('P1'); // logged in shadow, not used
    expect(byNum.get(4868).class).toBe('P4');
    expect(byNum.get(4814).reason).toMatch(/ready 19:34 ET, waited 160 min/);
  });

  it('after (priority enforce): the stacked base #4788 (P1) first, then P3 oldest first, then P4 oldest first', () => {
    const p = plan(TONIGHT, { order: 'ready-age', priority: enforce, now: NOW, infoOf: infoFrom(TONIGHT) });
    expect(nums(p)).toEqual([4788, 4814, 4857, 4860, 4868, 4869, 4870]);
    expect(p.readyOrder[0].reason).toMatch(/P1 \(1 stacked change\(s\) wait on it\)/);
  });

  it('the log prints the order with a one-line reason per PR', () => {
    const p = plan(TONIGHT, { order: 'ready-age', priority: shadow, now: NOW, infoOf: infoFrom(TONIGHT) });
    const lines = formatDrainOrderLines(p.readyOrder, { order: 'ready-age', orderSource: 'standard', priorityMode: 'shadow', priorityModeSource: 'standard' });
    expect(lines[0]).toMatch(/drain-order: ready-age \(standard\) · priority shadow \(standard\) · 7 ready/);
    expect(lines).toHaveLength(8);
    expect(lines[1]).toMatch(/^ {4}1\. #4814 P3 · ready 19:34 ET, waited 160 min · normal$/);
    expect(lines[5]).toMatch(/^ {4}5\. #4868 P4 · ready 21:56 ET, waited 18 min · changes no code$/);
  });
});

describe('drain order — rules', () => {
  it('a new PR for an old card no longer jumps ahead; a PR with no card no longer waits behind every card', () => {
    const rows = [
      { num: 900, item: 5100, readyAt: '2026-10-11T02:00:00Z', changesCode: true },
      { num: 800, item: 'xhash01', readyAt: '2026-10-11T00:00:00Z', changesCode: true },
      { num: 850, item: null, readyAt: '2026-10-11T01:00:00Z', changesCode: true },
    ];
    const run = (order) => nums(planLabelDrain(rows.map((r) => cand(r)), { readyOrder: { order, priority: shadow, now: NOW, infoOf: infoFrom(rows) } }));
    expect(run('card-number')).toEqual([900, 800, 850]);
    expect(run('ready-age')).toEqual([800, 850, 900]);
  });

  it('no readyOrder keeps the legacy comparator exactly (every existing caller/test unchanged)', () => {
    const rows = [{ num: 3, item: 20 }, { num: 1, item: 'xabc123' }, { num: 2, item: 10 }];
    expect(nums(planLabelDrain(rows.map((r) => cand(r))))).toEqual([2, 3, 1]);
  });

  it('a PR whose ready time cannot be read sorts after every timed PR in its class, then by PR #', () => {
    const rows = [{ num: 7, readyAt: null, changesCode: true }, { num: 5, readyAt: null, changesCode: true }, { num: 9, readyAt: '2026-10-11T02:00:00Z', changesCode: true }];
    const p = planLabelDrain(rows.map((r) => cand(r)), { readyOrder: { order: 'ready-age', priority: shadow, now: NOW, infoOf: infoFrom(rows) } });
    expect(nums(p)).toEqual([9, 5, 7]);
    expect(p.readyOrder[1].reason).toMatch(/ready time unknown/);
  });

  it('aging: waiting past agingHours moves a PR up one class (enforce), never into P0', () => {
    const rows = [
      { num: 10, readyAt: '2026-10-10T17:00:00Z', changesCode: false }, // 9h15 — P4 aged to P3
      { num: 11, readyAt: '2026-10-11T02:00:00Z', changesCode: true }, // fresh P3
      { num: 12, readyAt: '2026-10-10T12:00:00Z', changesCode: true, stackedDependents: 1 }, // P1 aged — stays P1
    ];
    const p = planLabelDrain(rows.map((r) => cand(r)), { readyOrder: { order: 'ready-age', priority: enforce, now: NOW, infoOf: infoFrom(rows) } });
    const cls = Object.fromEntries(p.readyOrder.map((r) => [r.num, r.class]));
    expect(cls).toEqual({ 12: 'P1', 10: 'P3', 11: 'P3' });
    expect(nums(p)).toEqual([12, 10, 11]);
  });

  it('enforce vs shadow differ when a P4 is older than a P3', () => {
    const rows = [{ num: 20, readyAt: '2026-10-11T00:00:00Z', changesCode: false }, { num: 21, readyAt: '2026-10-11T01:00:00Z', changesCode: true }];
    const run = (priority) => nums(planLabelDrain(rows.map((r) => cand(r)), { readyOrder: { order: 'ready-age', priority, now: NOW, infoOf: infoFrom(rows) } }));
    expect(run(shadow)).toEqual([20, 21]);
    expect(run(enforce)).toEqual([21, 20]);
  });

  it('an operator override label counts only when the operator set it', () => {
    const rows = [{ num: 30, readyAt: '2026-10-11T00:00:00Z', changesCode: true }, { num: 31, readyAt: '2026-10-11T02:00:00Z', changesCode: true }];
    const run = (byOperator) => planLabelDrain(rows.map((r) => cand(r)), { readyOrder: { order: 'ready-age', priority: enforce, now: NOW,
      infoOf: infoFrom(rows, { 31: { override: { value: 'urgent', byOperator } } }) } });
    expect(nums(run(true))).toEqual([31, 30]);
    expect(run(true).readyOrder[0].class).toBe('P0');
    expect(nums(run(false))).toEqual([30, 31]);
  });

  it('the main-fix PR still goes first (merge-queue class), ahead of an older ready PR', () => {
    const p = plan(TONIGHT, { order: 'ready-age', priority: enforce, now: NOW, infoOf: infoFrom(TONIGHT, { 4870: { mainFix: { repo: 'we', pr: 4870 } } }) });
    expect(p.readyOrder.find((r) => r.num === 4870).class).toBe('P0'); // the shared rule agrees: owns the main-red fix
    const ordered = prioritizeMainFix(p.ready, { mainFix: { repo: 'we', pr: 4870 }, queueSettings: { enabled: true }, repoKeyOf: () => 'we' });
    expect(ordered[0].num).toBe(4870);
    // shadow: the shared class does not reorder, the merge-queue class alone still puts main-fix first
    const s = plan(TONIGHT, { order: 'ready-age', priority: shadow, now: NOW, infoOf: infoFrom(TONIGHT) });
    expect(prioritizeMainFix(s.ready, { mainFix: { repo: 'we', pr: 4870 }, queueSettings: { enabled: true }, repoKeyOf: () => 'we' }).map((c) => c.num))
      .toEqual([4870, 4814, 4857, 4860, 4788, 4868, 4869]);
  });

  it('orderReadyCandidates is stable and pure (input untouched)', () => {
    const ready = TONIGHT.map((r) => cand(r));
    const copy = ready.map((c) => c.num);
    const out = orderReadyCandidates(ready, { order: 'ready-age', priority: shadow, now: NOW, infoOf: infoFrom(TONIGHT) });
    expect(ready.map((c) => c.num)).toEqual(copy);
    expect(out.ordered.map((c) => c.num)).toEqual([4814, 4857, 4860, 4788, 4868, 4869, 4870]);
  });
});

describe('drain order — setting `drain.order` via the cascade', () => {
  it('defaults to ready-age + priority shadow from the standard layer', () => {
    const s = resolveDrainOrderSettings({ tool: undefined, platform: null, env: {} });
    expect(s).toMatchObject({ order: 'ready-age', orderSource: 'standard', priorityMode: 'shadow', priorityModeSource: 'standard' });
    expect(DRAIN_ORDERS).toEqual(['ready-age', 'card-number']);
  });
  it('tool block beats platform; env beats both; an invalid value is ignored', () => {
    expect(resolveDrainOrderSettings({ tool: { order: 'card-number' }, platform: { order: 'ready-age' }, env: {} })).toMatchObject({ order: 'card-number', orderSource: 'tool' });
    expect(resolveDrainOrderSettings({ tool: { order: 'card-number', priorityMode: 'enforce' }, platform: null, env: { WE_DRAIN_ORDER: 'ready-age' } }))
      .toMatchObject({ order: 'ready-age', orderSource: 'env', priorityMode: 'enforce', priorityModeSource: 'tool' });
    expect(resolveDrainOrderSettings({ tool: { order: 'bogus', priorityMode: 'loud' }, platform: null, env: {} }))
      .toMatchObject({ order: 'ready-age', orderSource: 'standard', priorityMode: 'shadow' });
  });
});

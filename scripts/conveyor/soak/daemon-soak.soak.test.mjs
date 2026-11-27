/**
 * @file daemon-soak.soak.test.mjs — #4075 (card x0zg44l). THE LONG SOAK: 25 rounds × {review, fix-dispatch} = 50
 * real daemon ticks, origin/main moving every 4 rounds, the default PR fleet, sessions that post verdicts, write
 * state, push fixes, crash, hang and leave junk. Every invariant in `invariants.mjs` is checked after every tick
 * and printed as one report line; any violation fails the test with the full list.
 */

import { expect, it } from 'vitest';
import { runLongSoak } from './run.mjs';

const claimBreak = async () => (await import('./breaks/no-code-rearm-active-claim.mjs')).default;

it('oversized threads retire superseded no-code rulings and resume ordinary planning', async () => {
  const { oversizedRulingPlans } = await import('./breaks/no-code-rearm-active-claim.mjs');
  const cases = oversizedRulingPlans();
  for (const c of cases) {
    expect(c.ruling.state, c.name).toBe(c.expected.state);
    expect(c.kinds, c.name).toEqual(c.expected.kinds);
    if (c.expected.state === 'none') {
      expect(c.refusals.filter(r => r.kind.startsWith('no-code-rearm')), c.name).toEqual([]);
    }
    if (c.name === 'live over limit') expect(c.ruling.why).toContain('operator must inspect');
  }
});

it('no-code rearm with active fix or ci-heal claim makes zero writes', async () => {
  const b = await claimBreak();
  const report = await b.run({ cases: ['active-fix', 'active-ci-heal', 'concurrent-fix', 'concurrent-ci-heal'] });
  expect(report.cases.map(c => c.name)).toEqual(['active-fix', 'active-ci-heal', 'concurrent-fix', 'concurrent-ci-heal']);
  expect(b.judge(report)).toEqual([]);
  for (const c of report.cases) {
    expect(c.planned).toEqual(['rearm-no-code']);
    expect(c.refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-claimed' }));
    expect(c.effects).toEqual({ labels: 0, comments: 0, receipts: 0, confirmations: 0, launches: 0, consumed: 0 });
    expect(c.after).toEqual(c.before);
    expect(c.claimReads).toBeGreaterThan(0);
    expect(c.lockReleased).toBe(true);
  }
});

it('completed and expired repair claims permit the real writer exactly once', async () => {
  const b = await claimBreak();
  const report = await b.run({ cases: ['completed-fix', 'completed-ci-heal', 'expired-fix', 'expired-ci-heal'] });
  expect(b.judge(report)).toEqual([]);
  for (const c of report.cases) {
    expect(c.effects).toEqual({ labels: 1, comments: 1, receipts: 1, confirmations: 1, launches: 1, consumed: 1 });
    expect(c.after.labels).toEqual(['review:pending']);
    expect(c.writerResult).toMatchObject({ status: 0, result: { ok: true, labelsObserved: true, labels: ['review:pending'] } });
    expect(c.replayed).toEqual(c.after);
    expect(c.lockReleased).toBe(true);
  }
}, 120000);

it('unknown claim evidence, stale heads and missing labels visibly refuse without spending an answer', async () => {
  const b = await claimBreak();
  const report = await b.run({ cases: ['missing-store', 'malformed-claim', 'invalid-heartbeat', 'unreadable-claim',
    'throwing-claim', 'timed-out-claim', 'moved-head', 'missing-labels', 'forged-answer', 'missing-thread', 'oversized-thread'] });
  expect(b.judge(report)).toEqual([]);
  for (const c of report.cases) {
    expect(c.refusals.length).toBeGreaterThan(0);
    expect(c.refusals.every(r => typeof r.why === 'string' && r.why.length > 0)).toBe(true);
    expect(c.effects).toEqual({ labels: 0, comments: 0, receipts: 0, confirmations: 0, launches: 0, consumed: 0 });
    expect(c.after).toEqual(c.before);
    expect(c.lockReleased).toBe(true);
  }
});

it('discovers the repair-claim break and detects writes when its guard is removed in a temporary fixture', async () => {
  const b = await claimBreak();
  const report = await b.proveGuard();
  expect(report.discovered).toEqual([b.id]);
  expect(report.red.cases[0].effects).toMatchObject({ labels: 1, receipts: 1, launches: 1 });
  expect(b.judge(report.red)).toContainEqual(expect.stringContaining('active-fix:'));
}, 120000);

it('50 real daemon ticks: every invariant holds after every tick', async () => {
  const report = await runLongSoak({ rounds: 25, seed: 1, mainEvery: 4 });
  expect(report.ticks.length).toBeGreaterThanOrEqual(50);
  expect(report.violations.map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`)).toEqual([]);
});

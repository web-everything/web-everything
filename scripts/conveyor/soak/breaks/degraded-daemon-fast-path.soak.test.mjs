import { expect, it } from 'vitest';
import scenario from './degraded-daemon-fast-path.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(scenario);
it.each([
  ['sibling ref', ({ ref }) => ({ ref: `${ref}-other` })],
  ['sibling refs array', ({ ref }) => ({ refs: [`${ref}-2`] })],
  ['ref mentioned in prose', ({ ref }) => ({ message: `refused ${ref}` })],
  ['malformed refs string', ({ ref }) => ({ refs: ref })],
  ['same ref at another SHA', ({ ref }) => ({ ref, sha: 'f'.repeat(40) })],
  ['same refs array at another SHA', ({ ref }) => ({ refs: [ref], sha: 'f'.repeat(40) })],
])('R1075 does not withdraw a pending registration for an unrelated refusal: %s', async (_, refusalDetail) => {
  const report = await scenario.run({ failure: 'ready-candidate-discarded', refusalDetail, expectRefusal: false });
  expect(report.violations).toEqual([]);
  expect(report.remains).toBe(true);
  expect(report.eventAttempts).toBe(0);
  expect(report.alerts).toBe('');
});
it.each([
  ['ref', ({ ref, sha }) => ({ ref, sha })],
  ['refs array', ({ ref }) => ({ refs: [`${ref}-other`, ref] })],
])('R1075 withdraws the exact registration identified by %s', async (_, refusalDetail) => {
  const report = await scenario.run({ failure: 'ready-candidate-discarded', refusalDetail });
  expect(report.violations).toEqual([]);
  expect(report.remains).toBe(false);
});
it.each(['pinned', 'edge', 'stacked', 'uncached-stack', 'moved-tip'])('R1075 preserves %s protections during withdrawal', async protection => {
  const report = await scenario.run({ protection });
  expect(report.violations).toEqual([]);
  expect(report.remains).toBe(true);
  expect(report.alerts).toContain('unload manually');
});
it('R1075 withdraws a refused open-PR candidate with the real planner', async () => {
  const report = await scenario.run({ protection: 'open-pr' });
  expect(report.violations).toEqual([]);
  expect(report.remains).toBe(false);
});
// Required independently of fix detection: an assessor regression must never turn cleanup into expected-fail.
it.each(['smoke-rejected', 'smoke-threw', 'dispatch-smoke-failed', 'ready-candidate-discarded'])(
  'R1075 asynchronously withdraws unmerged work using the real planner after %s', async failure => {
    expect(scenario.judge(await scenario.run({ failure }))).toEqual([]);
  });
it('R1075 failed withdrawal retains the registration and escalates manual recovery', async () => {
  const report = await scenario.run({ retire: async () => ({ retired: false, refused: 'registration-changed' }) });
  expect(report.violations).toEqual([]);
  expect(report.remains).toBe(true);
  expect(report.alerts).toContain('unload manually');
});
it('R1075 unreadable registry retains the registration and escalates manual recovery', async () => {
  const report = await scenario.run({ readState: () => ({ corrupt: true, overlays: [] }) });
  expect(report.violations).toEqual([]);
  expect(report.remains).toBe(true);
  expect(report.alerts).toContain('unload manually');
});

it.each([true, 'throw'])('R1075 retries the owed failure event on a benign rebuild after withdrawal (first append=%s)', async failEventOnce => {
  const report = await scenario.run({ failEventOnce });
  expect(report.violations).toEqual([]);
  expect(report.pendingAfterFailedEvent).toBe(1);
  expect(report.failureAfterFailedEvent).toMatchObject({ reason: 'smoke-rejected', rollback: { retired: true } });
  expect(report.eventAttempts).toBe(2);
  expect(report.events.filter(e => e.kind === 'prototype-load.degraded-fast-path-failed')).toHaveLength(1);
  expect(report.events.find(e => e.kind === 'prototype-load.degraded-fast-path-failed').detail).toMatchObject({
    reason: 'smoke-rejected', rollback: { retired: true }, marker: { sig: 'receipt-marker' },
  });
});

it('R1075 ignores a discarded older candidate when this rebuild successfully adopted the new build', async () => {
  const report = await scenario.run({ failure: 'ready-candidate-discarded', adopted: true });
  expect(report.violations).toEqual([]);
  expect(report.remains).toBe(true);
  expect(report.events.some(e => e.kind === 'prototype-load.degraded-fast-path-failed')).toBe(false);
});

import { expect, it } from 'vitest';
import scenario from './degraded-daemon-fast-path.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(scenario);
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

it('R1075 retains tracking until the failure event is durably appended', async () => {
  const report = await scenario.run({ failEventOnce: true });
  expect(report.violations).toEqual([]);
  expect(report.pendingAfterFailedEvent).toBe(1);
  expect(report.eventAttempts).toBe(2);
  expect(report.events.filter(e => e.kind === 'prototype-load.degraded-fast-path-failed')).toHaveLength(1);
});

it('R1075 ignores a discarded older candidate when this rebuild successfully adopted the new build', async () => {
  const report = await scenario.run({ failure: 'ready-candidate-discarded', adopted: true });
  expect(report.violations).toEqual([]);
  expect(report.remains).toBe(true);
  expect(report.events.some(e => e.kind === 'prototype-load.degraded-fast-path-failed')).toBe(false);
});

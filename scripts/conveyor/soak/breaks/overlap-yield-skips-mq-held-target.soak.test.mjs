import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import b, { replayCases } from './overlap-yield-skips-mq-held-target.mjs';
import { buildOverlapRows } from '../../../merge-ai-prs.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

// Pin policy even when the operator shell has an opt-out.
vi.stubEnv('WE_DRAIN_OVERLAP_YIELD_REQUIRES_LANDABLE', '1');
vi.stubEnv('WE_DRAIN_OVERLAP_YIELD_ONLY_TO_ENQUEUEABLE', '1');
beforeEach(() => {
  vi.stubEnv('WE_DRAIN_OVERLAP_YIELD_REQUIRES_LANDABLE', '1');
  vi.stubEnv('WE_DRAIN_OVERLAP_YIELD_ONLY_TO_ENQUEUEABLE', '1');
});
afterEach(() => vi.unstubAllEnvs());
defineBreakTest(b);
it('unconditionally releases S through the production row builder and planner', () => {
  expect(b.judge(replayCases())).toEqual([]);
});
it('reproduces the break if the held keys are lost at the row-builder boundary', () => {
  const report = replayCases(input => buildOverlapRows({ ...input, heldKeys: new Set() }));
  expect(report.after.ready).toEqual([]);
  expect(report.after.waits).toEqual([{ num: 7399, waitOn: ['overlap-yield:#7369'] }]);
  expect(b.judge(report)).toContain('after: S must be released and L must remain held');
});
it('keeps the unreadable live-state case yielded before its budget expires', () => {
  const report = replayCases();
  expect(report.unreadable.after.ready).toEqual([]);
  expect(report.unreadable.after.waits).toEqual([{ num: 7399, waitOn: ['overlap-yield:#7369'] }]);
  expect(report.unreadable.again).toEqual(report.unreadable.after);
});
it('fails the soak judge if every mq-same-head-failed outcome releases waiters again', () => {
  const report = replayCases(buildOverlapRows, outcome => outcome.outcome === 'not-enqueued' && outcome.kind === 'mq-same-head-failed');
  expect(report.unreadable.after.ready).toEqual([7399]);
  expect(b.judge(report)).toContain('after: unreadable queue state must keep S yielded');
});

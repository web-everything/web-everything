import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import b, { replay } from './overlap-yield-skips-mq-held-target.mjs';
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
  expect(b.judge(replay())).toEqual([]);
});
it('reproduces the break if the held keys are lost at the row-builder boundary', () => {
  const report = replay(input => buildOverlapRows({ ...input, heldKeys: new Set() }));
  expect(report.after.ready).toEqual([]);
  expect(report.after.waits).toEqual([{ num: 7399, waitOn: ['overlap-yield:#7369'] }]);
  expect(b.judge(report)).toContain('after: S must be released and L must remain held');
});

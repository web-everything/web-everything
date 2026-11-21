import { expect, it } from 'vitest';
import b from './conflict-fix-parallel-one-per-pass.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
it('dispatches all six conflicts in the current tree with no mechanical exemption', async () => {
  const report = await b.run();
  expect(b.judge(report)).toEqual([]);
  expect(report.dispatched).toHaveLength(6);
});

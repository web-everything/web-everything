import b from './accepted-red-team-repair-accounting.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';

defineBreakTest(b);

it('detects launcher refusal by replaying planner-selected ordinary repairs', async () => {
  const report = await b.run({ ordinaryLauncher: async () => ({ code: 1 }) });
  expect(b.judge(report)).toHaveLength(3);
  expect(report.ordinary.map(row => row.fixture)).toEqual(['conflict', 'ci-heal', 'ordinary']);
});

import { it, expect } from 'vitest';
import { defineBreakTest } from '../define-break-test.mjs';
import b, { replayUrgent } from './rebuild-job-urgent-stale-bypass.mjs';

defineBreakTest(b);
it('detects the fix by queueing a job; missing trees fail closed', () => {
  expect(b.fixPresent(process.cwd())).toBe(true);
  expect(b.fixPresent(new URL('./missing-tree', import.meta.url).pathname)).toBe(false);
});
it('recent terminal jobs stay spaced unless urgent', async () => {
  expect(await replayUrgent(process.cwd(), false)).toEqual({ reason: 'rebuild-job-spaced', jobs: 1 });
  expect(await replayUrgent(process.cwd(), true)).toEqual({ reason: 'rebuild-job-started', jobs: 2 });
});

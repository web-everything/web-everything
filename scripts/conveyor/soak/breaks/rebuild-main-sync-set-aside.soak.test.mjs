import { it, expect } from 'vitest';
import b from './rebuild-main-sync-set-aside.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);
it('adopts main through a real main-sync conflict and restores the repaired branch', async () => {
  expect(b.judge(await b.run({}))).toEqual([]);
});

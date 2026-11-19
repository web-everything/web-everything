import { it, expect } from 'vitest';
import b from './finished-red-team-publication-hold.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

// Keep regression enforcement independent of the harness's expected-failure selection.
it('the planner nominates finished publication holds and settlement clears them', async () => {
  expect(b.fixPresent(process.env.SOAK_TREE_ROOT || process.cwd())).toBe(true);
  expect(b.judge(await b.run())).toEqual([]);
});

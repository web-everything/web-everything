import { it, expect } from 'vitest';
import b from './finished-red-team-publication-hold.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

// Enforce the fix independently of the harness's expected-failure branch.
it('the planner nominates publication recovery and the scenario stays fixed', async () => {
  expect(b.fixPresent(process.env.SOAK_TREE_ROOT || process.cwd())).toBe(true);
  expect(b.judge(await b.run())).toEqual([]);
});

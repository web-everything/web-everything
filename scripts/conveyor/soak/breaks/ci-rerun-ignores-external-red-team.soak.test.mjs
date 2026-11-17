import { it, expect } from 'vitest';
import b, { scenario } from './ci-rerun-ignores-external-red-team.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

// Unconditional: if the exemption (or its loader) is removed, fixPresent turns false and the break above becomes an
// expected-fail, so THIS test is what turns red on the regression.
it('the configured red-team app check never defers the owed CI rerun (#6873)', async () => {
  expect((await scenario()).violations).toEqual([]);
  expect(b.fixPresent(process.cwd())).toBe(true);
});

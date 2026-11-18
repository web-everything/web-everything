import { it, expect } from 'vitest';
import b from './rebuild-job-ready-candidate-starvation.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

// Unconditional: if the fix is removed, fixPresent turns false and the break above becomes an expected-fail,
// so THIS test is what turns red on the regression.
it('the fix is present in the tree under test', () => {
  expect(b.fixPresent(process.cwd())).toBe(true);
});

import { it, expect } from 'vitest';
import b, { scenario } from './rerun-pending-lost-held-forever.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('a lost pending re-run marker re-plans instead of holding the PR forever (we#7431)', async () => {
  const out = await scenario();
  expect(out.violations).toEqual([]);
  expect(out.replans).toBe(true);
  expect(b.fixPresent(process.cwd())).toBe(true);
});

import { it, expect } from 'vitest';
import b, { probeUidCleanup } from './forge-uid-cleanup-loses-verdict.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('this tree keeps the verdict and fences only an unconfirmed uid', () => {
  expect(b.fixPresent()).toBe(true);
  expect(probeUidCleanup().violations).toEqual([]);
});

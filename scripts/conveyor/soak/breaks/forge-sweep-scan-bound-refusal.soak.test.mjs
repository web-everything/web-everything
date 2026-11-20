import {it, expect} from 'vitest';
import b, {probeSweepScanBound} from './forge-sweep-scan-bound-refusal.mjs';
import {defineBreakTest} from '../define-break-test.mjs';

defineBreakTest(b);

// Unconditional guard: a regressed fixPresent must never hide behind it.fails.
it('this tree preserves an over-bound tree and exits zero with partial evidence', () => {
  expect(b.fixPresent()).toBe(true);
  expect(probeSweepScanBound()).toMatchObject({violations: [], exitCode: 0});
});

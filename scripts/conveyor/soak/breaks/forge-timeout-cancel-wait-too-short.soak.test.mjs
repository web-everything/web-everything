import { it, expect } from 'vitest';
import b, { probeTimeoutCancelWait } from './forge-timeout-cancel-wait-too-short.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

// Unconditional guard (never it.fails): if the fix regresses or the probe breaks, fixPresent turns false and the
// harness test above flips to expected-fail, so this plain assertion is what keeps the regression visible.
it('this tree confirms a result that settles 60 seconds after the timeout', () => {
  expect(b.fixPresent()).toBe(true);
  expect(probeTimeoutCancelWait().violations).toEqual([]);
});

it('reproduces exit 124 and the retained slot with the historical 30-second wait', () => {
  const report = probeTimeoutCancelWait(undefined, 30000);
  expect(report).toMatchObject({exitCode:124,heldDuringCancel:true});
  expect(report.violations).toHaveLength(2);
});

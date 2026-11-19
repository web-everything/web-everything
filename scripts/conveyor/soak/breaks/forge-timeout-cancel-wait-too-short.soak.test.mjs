import { it, expect } from 'vitest';
import b, { probeTimeoutCancelWait } from './forge-timeout-cancel-wait-too-short.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('reproduces exit 124 and the retained slot with the historical 30-second wait', () => {
  const report = probeTimeoutCancelWait(undefined, 30000);
  expect(report).toMatchObject({exitCode:124,heldDuringCancel:true});
  expect(report.violations).toHaveLength(2);
});

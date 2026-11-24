import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import scenario from './review-pending-fast-pass.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(scenario);
it('detects the fix by behavior in this tree', () => {
  expect(scenario.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});
it('fails closed for a missing implementation', () => {
  expect(scenario.fixPresent(fileURLToPath(new URL('./missing-fixture/', import.meta.url)))).toBe(false);
});

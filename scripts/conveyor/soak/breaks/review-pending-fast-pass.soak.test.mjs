import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import scenario from './review-pending-fast-pass.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { exerciseFastCli } from '../../../lib/__tests__/fixtures/review-fast-cli-integration.mjs';
defineBreakTest(scenario);
it('logs ten pending PR dispatches within 180s of labelling and median under 3min with the ordinary daemon live', async () => {
  expect(await exerciseFastCli(['cadence'])).toEqual({ violations: [] });
});
it('ordinary and fast dispatch cannot both spend the last live seat', async () => {
  expect(await exerciseFastCli(['race'])).toEqual({ violations: [] });
});
it('detects the fix by behavior in this tree', () => {
  expect(scenario.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});
it('fails closed for a missing implementation', () => {
  expect(scenario.fixPresent(fileURLToPath(new URL('./missing-fixture/', import.meta.url)))).toBe(false);
});

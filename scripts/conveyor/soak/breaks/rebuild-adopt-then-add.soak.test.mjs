import b from './rebuild-adopt-then-add.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
import { registryContractViolations } from './rebuild-adopt-then-add.mjs';

defineBreakTest(b);

it('authenticated removal contract authorizes the smoke-passed build', async () => {
  expect(await registryContractViolations()).toEqual([]);
});

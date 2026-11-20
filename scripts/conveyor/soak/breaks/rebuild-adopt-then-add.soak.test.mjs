import b from './rebuild-adopt-then-add.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
import { registryContractViolations } from './rebuild-adopt-then-add.mjs';

defineBreakTest(b);

it('real registration and removal contracts authorize the smoke-passed build', async () => {
  expect(await registryContractViolations()).toEqual([]);
});

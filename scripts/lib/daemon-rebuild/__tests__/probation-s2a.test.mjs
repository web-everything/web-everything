import { expect, it } from 'vitest';
import * as probation from '../probation.mjs';

it('S2a exposes synchronous tick and boot hooks without an autonomous watch', () => {
  expect(typeof probation.checkProbationAtTick).toBe('function');
  expect(typeof probation.bootProbation).toBe('function');
  expect(probation.armProbationWatch).toBeUndefined();
});

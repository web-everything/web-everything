import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './added-seats-concurrent-head-binding.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

it('detects the fix by executing unchanged-head and moved-live-head review jobs', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

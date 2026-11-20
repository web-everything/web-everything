import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './parked-watch-skips-draft-withdrawn.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

it('detects the fix by sweeping a withdrawn and an ordinary conflicting parked PR', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

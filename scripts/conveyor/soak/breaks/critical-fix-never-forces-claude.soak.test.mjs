import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './critical-fix-never-forces-claude.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

it('detects the fix by executing critical, takeover and exhausted-chain routing', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

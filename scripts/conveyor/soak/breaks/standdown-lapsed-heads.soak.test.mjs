import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './standdown-lapsed-heads.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);
it('detects the fix by replaying a lapsed stand-down and consuming the answer in the guard', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

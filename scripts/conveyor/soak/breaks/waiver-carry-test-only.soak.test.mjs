import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './waiver-carry-test-only.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
it('detects the fix by admitting a real test-only descendant', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});
it('missing gate evidence refuses fix presence', () => {
  expect(b.fixPresent(fileURLToPath(new URL('./', import.meta.url)))).toBe(false);
});

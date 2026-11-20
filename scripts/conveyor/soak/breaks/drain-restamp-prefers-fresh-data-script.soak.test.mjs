import { expect, it } from 'vitest';
import b from './drain-restamp-prefers-fresh-data-script.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('fixPresent fails closed when the production module is unavailable', () => {
  expect(b.fixPresent(new URL('./missing-production-tree/', import.meta.url).pathname)).toBe(false);
});

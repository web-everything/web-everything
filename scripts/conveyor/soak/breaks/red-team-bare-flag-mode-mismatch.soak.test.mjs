import b from './red-team-bare-flag-mode-mismatch.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
import { resolve } from 'node:path';

defineBreakTest(b);
it('bare flag recovery behaviour is present in this tree', () => {
  expect(b.fixPresent(resolve('.'))).toBe(true);
});

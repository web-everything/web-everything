import b from './runtime-only-assignment-and-alias.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

defineBreakTest(b);

// This regression has landed: never silently downgrade it to expected-fail.
it('recognizes the shared runtime admission fix in the current tree', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './catch-up-clean-first-snapshot-first.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

// This landed contract must never become an expected failure when a default regresses.
it('requires CLEAN-first and serial-first behaviour with the real defaults', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b from './zero-success-record-cap.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('requires the landed retention behavior with the actual defaults', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

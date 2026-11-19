import b from './non-human-referral-hold-never-resumes.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
defineBreakTest(b);

it('keeps the current-tree referral resume replay out of expected-failure mode', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

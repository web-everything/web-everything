import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import b, { exercise } from './promoter-ignores-operator-park.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

it('detects the fix by evaluating parked, released and ordinary lane drafts', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

it('detects a promoter that ignores operator parks', () => {
  expect(exercise(() => ({ owed: true })).violations).toContain('operator-parked draft was not refused');
});

import { expect, it } from 'vitest';
import b from './orphan-active-attempt-defers.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('defers a concurrent orphan pass and resumes after the holder releases', () => {
  expect(b.judge(b.run())).toEqual([]);
});

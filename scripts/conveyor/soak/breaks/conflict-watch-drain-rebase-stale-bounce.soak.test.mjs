import { expect, it } from 'vitest';
import b from './conflict-watch-drain-rebase-stale-bounce.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);
it('runs the real two-head #7183 decision without a stale bounce', () => {
  expect(b.judge(b.run())).toEqual([]);
  expect(b.fixPresent()).toBe(true);
});

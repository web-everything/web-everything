import { it, expect } from 'vitest';
import b from './supersede-bot-author-shapes.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
it('the bot author identity fix is present in the tree under test', () => {
  expect(b.fixPresent(process.cwd())).toBe(true);
});

import { expect, it } from 'vitest';
import b from './ready-pin-moved-keeps-adopting.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('the current tree keeps adopting across three pushes and refuses a force-push', () => {
  expect(b.judge(b.run({}))).toEqual([]);
});

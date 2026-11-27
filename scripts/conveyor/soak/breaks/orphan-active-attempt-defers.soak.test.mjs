import { expect, it } from 'vitest';
import b from './orphan-active-attempt-defers.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('defers concurrent orphan passes, holds ambiguous launch timeouts, and retries proven prelaunch refusals', () => {
  expect(b.judge(b.run())).toEqual([]);
});

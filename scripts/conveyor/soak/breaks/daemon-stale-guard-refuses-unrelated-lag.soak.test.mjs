import { expect, it } from 'vitest';
import b from './daemon-stale-guard-refuses-unrelated-lag.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

// A strict-path regression must fail even when the presence probe selects it.fails.
it('unconditionally refuses gate and trust-chain lag independently of fixPresent', async () => {
  expect(b.judge(await b.run({ strictOnly: true }))).toEqual([]);
});

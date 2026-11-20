import { expect, it } from 'vitest';
import b, { probeFix } from './judge-runs-on-cap-trigger-mismatch.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('presence probe accepts the fixed sweep independently of the real judge scenario', async () => {
  expect(await probeFix()).toBe(true);
});
it('presence probe rejects a known-bad sweep that leaves the mismatch unjudged', async () => {
  expect(await probeFix(undefined, async () => ({ items: [{ verdict: null }], errors: [], act: [] }))).toBe(false);
});

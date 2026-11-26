import { expect, it } from 'vitest';
import b from './prepare-launched-while-external-cap-zero.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
it('reports a launch under cap 0 and a missing skip reason', () => {
  expect(b.judge({ zeroDispatches: 1, skipReason: null, positiveDispatches: 1 })).toHaveLength(2);
  expect(b.judge({ zeroDispatches: 0, skipReason: 'external concurrency 0', positiveDispatches: 1 })).toEqual([]);
});
it('fails closed when the probe cannot import the target daemon', () => {
  expect(b.fixPresent(new URL('./absent-daemon-root/', import.meta.url).pathname)).toBe(false);
});

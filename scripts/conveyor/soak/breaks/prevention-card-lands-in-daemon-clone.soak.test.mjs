import b from './prevention-card-lands-in-daemon-clone.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

defineBreakTest(b);

it('requires the landed diagnostic handoff instead of downgrading it to expected-fail', () => {
  expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
});

it.each(['probe', 'crash'])('rejects a %s failure even when the checkout stays clean', invariant => {
  expect(b.judge({ violations: [{ invariant, detail: 'handoff was never proved' }] }))
    .toEqual([`- tick -: [${invariant}] handoff was never proved`]);
});

import { expect, it } from 'vitest';
import b from './draft-park-respected.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

// These official guards already existed: keep this a mandatory regression pass.
it('keeps label and marker parks through a new head and promotes after label removal or release', async () => {
  expect(b.fixPresent()).toBe(true);
  expect(b.judge(await b.run())).toEqual([]);
});

import { it, expect } from 'vitest';
import b from './rebuild-fallback-fresh-smoke.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);
it('adopts immediate and deferred fallbacks after running fresh GitHub checks', async () => {
  expect(b.judge(await b.run())).toEqual([]);
}, 60_000);

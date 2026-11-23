import { it, expect } from 'vitest';
import b from './rebuild-main-sync-set-aside.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);
it('adopts main with complete smoke and preserves deferred set-aside history through repair', async () => {
  expect(b.judge(await b.run({}))).toEqual([]);
});

import { it, expect } from 'vitest';
import b from './rebuild-main-sync-set-aside.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);
it('adopts main with full smoke and holds independent children until the set-aside base is audited', async () => {
  expect(b.judge(await b.run({}))).toEqual([]);
});

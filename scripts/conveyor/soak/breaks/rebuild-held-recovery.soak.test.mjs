import { it, expect } from 'vitest';
import b from './rebuild-held-recovery.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);
it('recovers held rebuilds on the working tree', async () => {
  expect(b.judge(await b.run({}))).toEqual([]);
});

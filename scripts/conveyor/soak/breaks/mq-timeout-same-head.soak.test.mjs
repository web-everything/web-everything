import { expect, it } from 'vitest';
import b from './mq-timeout-same-head.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);
it('timeout recovery behaviour passes unconditionally on the fixed tree', async () => {
  expect(b.judge(await b.run())).toEqual([]);
});

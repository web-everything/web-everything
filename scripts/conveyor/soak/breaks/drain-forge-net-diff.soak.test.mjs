import { it, expect } from 'vitest';
import b from './drain-forge-net-diff.mjs';
it('real CLI scores clean forge evidence and holds HTTP 500 without delivery', async () => {
  expect(b.judge(await b.run({}))).toEqual([]);
}, 240000);

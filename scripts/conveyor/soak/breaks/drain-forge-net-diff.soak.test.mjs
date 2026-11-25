import { it, expect } from 'vitest';
import b from './drain-forge-net-diff.mjs';
it('real CLI holds empty and failed compares even after clear-human, delivers cleared tampering, and carries identical sibling diffs', async () => {
  expect(b.judge(await b.run({}))).toEqual([]);
}, 240000);

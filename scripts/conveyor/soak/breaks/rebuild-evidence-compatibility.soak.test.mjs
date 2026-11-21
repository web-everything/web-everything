import { describe, it, expect } from 'vitest';
import b from './rebuild-evidence-compatibility.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

describe('real Git persisted evidence recovery', () => { defineBreakTest(b); }, 60_000);
it('adopts audited pins while holding unaudited tips and recovers stale pins, torn tick evidence and abandoned worktrees', async () => {
  expect(b.judge(await b.run())).toEqual([]);
}, 60_000);

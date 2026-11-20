import { describe, it, expect } from 'vitest';
import b from './rebuild-evidence-compatibility.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

describe('real Git persisted evidence recovery', () => { defineBreakTest(b); }, 60_000);
it('recovers stale pinned ready candidates and preserves legacy evidence while queuing changed inputs', async () => {
  expect(b.judge(await b.run())).toEqual([]);
}, 60_000);

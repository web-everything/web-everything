import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import b from './fix-refusal-stale-read-no-fresh-reread.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

it('detects the fresh-read fix without running the guarded scenario', () => {
  const run = vi.spyOn(b, 'run').mockImplementation(() => { throw new Error('scenario regressed'); });
  try {
    expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
    expect(run).not.toHaveBeenCalled();
  } finally {
    run.mockRestore();
  }
});

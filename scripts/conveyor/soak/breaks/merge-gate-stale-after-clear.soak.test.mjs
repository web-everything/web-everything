import { it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import b from './merge-gate-stale-after-clear.mjs';
it('all three stale-gate shapes POST once without bouncing', async () => {
  expect(b.fixPresent(process.cwd())).toBe(true);
  expect(b.judge(await b.run())).toEqual([]);
});
it.each(['reverted', 'load-error'])('%s fails the break hard', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'soak-gate-broken-')), previous = process.env.SOAK_TREE_ROOT;
  try {
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    writeFileSync(join(root, 'scripts/lib/drain-blocked-reason.mjs'), mode === 'reverted'
      ? 'export const sendBackBlockedGate = () => ({ sent: false });' : 'throw Error("module load failed");');
    process.env.SOAK_TREE_ROOT = root;
    if (mode === 'reverted') {
      expect(b.fixPresent(root)).toBe(false);
      expect(b.judge(await b.run())).toHaveLength(3);
    } else {
      expect(() => b.fixPresent(root)).toThrow(/probe failed/);
      await expect(b.run()).rejects.toThrow(/probe failed/);
    }
  } finally {
    if (previous === undefined) delete process.env.SOAK_TREE_ROOT; else process.env.SOAK_TREE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

import { expect, it, vi } from 'vitest';
import b from '../soak/breaks/no-code-owed-stand-down-deadlock.mjs';

// A missed injection must fail instead of reaching GitHub or a local agent process.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal(),
  execFileSync: vi.fn(() => { throw new Error('unexpected external effect'); }),
  spawnSync: vi.fn(() => { throw new Error('unexpected external effect'); }),
}));

it('real daemon path requests exactly one fresh review per head and never writes elsewhere', async () => {
  const report = await b.run({});
  expect(report.scenarios.liveWrites).toBe('reserve,post');
  expect(b.judge(report)).toEqual([]);
}, 30_000);

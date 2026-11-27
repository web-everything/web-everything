import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../../../lib/resource-pool-io.mjs';
import { POOL_DEFAULTS } from '../../../lib/resource-pool.mjs';
import replay from './resource-pool-live-fix-workers.mjs';

it('a live leased fix worker consumes C3 shadow units; unreadable inventories hold and recovery stays counted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pool-workers-test-'));
  const nowMs = Date.parse('2026-11-22T12:00:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  try {
    const report = await replay.run({ core, defaults: POOL_DEFAULTS, tempRoot: root, nowMs,
      host: 'fixture-host', namespace: 'fixture-namespace' });
    expect(replay.judge(report)).toEqual([]);
  } finally {
    clock.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireGhPointsSync, ghPointsBudgetStatePath, ghThrottleLockRoot } from '../../lib/gh-throttle.mjs';
import { worldThrottleEnv } from './sim/world-env.mjs';

it('keeps a future, exhausted scenario budget out of the next world while sharing it within a world', () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-throttle-env-'));
  try {
    const ambient = { HOME: root, WE_GH_THROTTLE_LOCK_ROOT: join(root, 'file-throttle') };
    const first = worldThrottleEnv(join(root, 'first'), ambient);
    const second = worldThrottleEnv(join(root, 'second'), ambient);
    const firstRoot = ghThrottleLockRoot(null, first);
    const secondRoot = ghThrottleLockRoot(null, second);
    const nowMs = Date.now();
    const spend = (lockRoot, now, points) => acquireGhPointsSync({
      lockRoot, now: () => now, points, budgetPerMin: 1, owner: `test-${process.pid}`,
      timeoutMs: 0,
    });

    // The first scenario advances eleven minutes and exhausts its minute's budget.
    expect(spend(firstRoot, nowMs + 11 * 60_000, 1).ok).toBe(true);
    const before = readFileSync(ghPointsBudgetStatePath(firstRoot), 'utf8');
    // A sibling daemon in the SAME world must still respect that spend.
    expect(spend(ghThrottleLockRoot(null, worldThrottleEnv(join(root, 'first'), ambient)), nowMs + 11 * 60_000, 1).timedOut).toBe(true);
    // A new world starts at real time; it must not wait for the previous world's future window.
    expect(spend(secondRoot, nowMs, 1)).toMatchObject({ ok: true, waitedMs: 0, timedOut: false });
    expect(readFileSync(ghPointsBudgetStatePath(firstRoot), 'utf8')).toBe(before);
    expect(ambient.WE_GH_THROTTLE_LOCK_ROOT).toBe(join(root, 'file-throttle'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

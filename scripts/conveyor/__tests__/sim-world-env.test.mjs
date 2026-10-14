/** @file Per-world throttle isolation: independent simulated clocks must not share a budget window. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireGhPointsSync, ghPointsBudgetStatePath, ghThrottleLockRoot } from '../../lib/gh-throttle.mjs';
import { worldThrottleEnv } from './sim/world-env.mjs';
import { worldEnv } from './sim/world.mjs';

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

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sim-world-env-'));
  roots.push(root);
  return { root, ambient: { WE_GH_THROTTLE_LOCK_ROOT: join(root, 'ambient-throttle'), GH_TOKEN: 'sim-token' } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function spend(env, cwd, startMs) {
  let nowMs = startMs;
  const sleep = vi.fn((ms) => { nowMs += ms; });
  const result = acquireGhPointsSync({
    lockRoot: ghThrottleLockRoot(cwd, env), points: 1, budgetPerMin: 1,
    owner: `sim-${process.pid}`, now: () => nowMs, sleep, timeoutMs: 1_000,
  });
  return { result, sleep };
}

describe('simulated world environment', () => {
  it('a fresh world spends immediately after an earlier world exhausted its budget 11 simulated minutes ahead', () => {
    const { root, ambient } = fixture();
    const first = worldEnv(join(root, 'first'), ambient);
    const next = worldEnv(join(root, 'next'), ambient);
    const advancedMs = Date.now() + 11 * 60_000;
    expect(spend(first, join(root, 'first', 'clone'), advancedMs).result.ok).toBe(true);

    const fresh = spend(next, join(root, 'next', 'clone'), Date.now());
    expect(fresh.result).toEqual({ ok: true, waitedMs: 0, timedOut: false });
    expect(fresh.sleep).not.toHaveBeenCalled();
    expect(next.GH_TOKEN).toBe(ambient.GH_TOKEN);
    expect(ambient.WE_GH_THROTTLE_LOCK_ROOT).toBe(join(root, 'ambient-throttle'));
  });

  it('sibling hosts and smoke candidates within one world still share the throttle budget', () => {
    const { root, ambient } = fixture();
    const env = worldEnv(join(root, 'world'), ambient);
    const nowMs = Date.now();
    expect(spend(env, join(root, 'world', 'clone'), nowMs).result.ok).toBe(true);
    const sibling = spend(env, join(root, 'world', 'candidate'), nowMs);
    expect(sibling.result).toEqual({ ok: false, waitedMs: 1_000, timedOut: true });
    expect(sibling.sleep).toHaveBeenCalled();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireGhPointsSync, ghThrottleLockRoot } from '../../lib/gh-throttle.mjs';
import { isolatedProcessEnv, toolPathDirs } from './sim/environment.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function worldRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sim-env-'));
  roots.push(root);
  return root;
}

describe('simulated process environment', () => {
  it('keeps a future-dated exhausted budget out of a later world with a fresh clock', () => {
    const ambient = { WE_GH_THROTTLE_LOCK_ROOT: join(worldRoot(), 'per-file-throttle') };
    const first = isolatedProcessEnv(worldRoot(), ambient);
    const second = isolatedProcessEnv(worldRoot(), ambient);
    const spend = (env, nowMs) => acquireGhPointsSync({
      lockRoot: ghThrottleLockRoot('', env), owner: 'sim-environment-test', budgetPerMin: 1,
      now: () => nowMs, timeoutMs: 0,
      sleep: () => { throw new Error('a new world must not wait on another world\'s budget'); },
    });
    expect(spend(first, 11 * 60_000).ok).toBe(true);
    // Demonstrate the real throttle failure if the earlier world's root is reused after a clock reset.
    expect(spend(first, 0)).toMatchObject({ ok: false, timedOut: true });
    expect(spend(second, 0)).toMatchObject({ ok: true, waitedMs: 0 });
    expect(first.WE_COORDINATION_ROOT).not.toBe(second.WE_COORDINATION_ROOT);
    expect(ambient.WE_GH_THROTTLE_LOCK_ROOT).not.toBe(first.WE_GH_THROTTLE_LOCK_ROOT);
  });

  it('uses the clone policy and fake auth instead of an inherited daemon snapshot or credentials', () => {
    const ambient = {
      WE_DISPATCH_ROUTING_SNAPSHOT: '{"aliases":{"claude":{"haiku":"unknown-model"}}}',
      WE_GITHUB_APP_ID: 'live-app', WE_GITHUB_APP_INSTALLATION_ID: 'live-installation',
      WE_GITHUB_APP_PRIVATE_KEY_PATH: 'live-key', GITHUB_TOKEN: 'live-token', OTHER_SETTING: 'preserved',
    };
    const env = isolatedProcessEnv(worldRoot(), ambient);
    for (const key of Object.keys(ambient).filter(key => key !== 'OTHER_SETTING')) expect(env).not.toHaveProperty(key);
    expect(env.OTHER_SETTING).toBe('preserved');
    expect(ambient.WE_DISPATCH_ROUTING_SNAPSHOT).toBeDefined();
  });

  it('excludes App shim directories before scanning tools while retaining ordinary tool directories', () => {
    const dirs = ['/fixture/.claude/github-app-token/gh-shim.d/hash', '/usr/bin', '/tools/node/bin'];
    expect(toolPathDirs(dirs.join(delimiter))).toEqual(dirs.slice(1));
    expect(toolPathDirs('')).toEqual([]);
  });
});

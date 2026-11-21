import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireGhPointsSync, ghThrottleLockRoot } from '../../lib/gh-throttle.mjs';
import { isolatedProcessEnv, toolPathDirs } from './sim/environment.mjs';
import { prSnapshotEnabled } from '../../lib/pr-snapshot-store.mjs';
import { readSharedOpenPrs } from '../../lib/pr-snapshot.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function worldRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sim-env-'));
  roots.push(root);
  return root;
}

describe('simulated process environment', () => {
  it.each([{}, { WE_PR_SNAPSHOT_TTL_MS: '75000', WE_PR_SNAPSHOT_STALE_OK_MS: '900000' }])(
    'reads a newly accepted PR on the next immediate tick despite ambient cache settings %j', (ambient) => {
      const env = isolatedProcessEnv(worldRoot(), { VITEST: 'true', ...ambient });
      const head = 'a'.repeat(40);
      let labels = [{ name: 'review:pending' }];
      let pages = 0;
      let unreadable = false;
      const exec = (_file, args) => {
        if (unreadable) throw new Error('simulated GitHub read failure');
        if (args[0] === 'pr') return JSON.stringify({ comments: [], body: '', files: [] });
        pages += 1;
        return JSON.stringify({ data: { repository: { pullRequests: {
          totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ number: 1, headRefOid: head, updatedAt: String(pages), labels: { nodes: labels },
            commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: {
              totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [],
            } } } }] } }],
        } } } });
      };
      const read = () => readSharedOpenPrs({ repo: 'fixture/sim', env, exec,
        fields: ['number', 'labels', 'headRefOid', 'rowsComplete', 'rowsHead'],
        now: () => 1000, paging: { pageSize: 20, pageRetries: 0, heavyMaxAgeSeconds: 600 } });
      expect(read()).toEqual([{ number: 1, labels, headRefOid: head, rowsComplete: true, rowsHead: head }]);
      labels = [{ name: 'review:accepted' }];
      expect(read()).toEqual([{ number: 1, labels, headRefOid: head, rowsComplete: true, rowsHead: head }]);
      expect(pages).toBe(2);
      unreadable = true;
      expect(read).toThrow(/open-PR list unreadable/);
    },
  );

  it('uses a private paged check snapshot under Vitest instead of an unproven flattened listing', () => {
    const ambient = { VITEST: 'true', WE_PR_SNAPSHOT: '0', WE_PR_SNAPSHOT_DIR: '/ambient/snapshot' };
    const firstRoot = worldRoot(), nextRoot = worldRoot();
    const first = isolatedProcessEnv(firstRoot, ambient);
    const next = isolatedProcessEnv(nextRoot, ambient);
    expect(prSnapshotEnabled(first)).toBe(true);
    expect(first.WE_PR_SNAPSHOT_DIR).toBe(join(firstRoot, 'pr-snapshot'));
    expect(next.WE_PR_SNAPSHOT_DIR).toBe(join(nextRoot, 'pr-snapshot'));
    expect(first.WE_PR_SNAPSHOT_DIR).not.toBe(next.WE_PR_SNAPSHOT_DIR);
    expect(ambient.WE_PR_SNAPSHOT_DIR).toBe('/ambient/snapshot');
  });

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

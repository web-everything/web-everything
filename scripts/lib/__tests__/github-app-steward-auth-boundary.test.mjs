import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDeliveryIdentity, shimRoleTable } from '../github-app-identity.mjs';
import { ensureFreshGithubAppEnv } from '../github-app-auth-env.mjs';
import { buildGhShimSettingsEnv } from '../gh-app-shim.mjs';

vi.mock('../github-auth-policy.mjs', async original => ({
  ...await original(),
  readGhAuthPolicy: () => ({ personalFallback: 'allow', source: { personalFallback: 'fixture' } }),
}));

afterEach(() => vi.unstubAllEnvs());

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'steward-auth-boundary-'));
  const app = { appId: '900010', installations: { fixture: '101' }, key: { file: join(root, 'key.pem') } };
  const identity = resolveDeliveryIdentity({ tool: { steward: app }, env: {}, pinned: false });
  return Promise.resolve().then(() => run({ root, app, identity }))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('steward authentication refuses inherited identity', () => {
  it('default shim role table refuses an App shared with the legacy environment', () => fixture(({ root, app, identity }) => {
    vi.stubEnv('WE_GITHUB_APP_ID', app.appId);
    expect(shimRoleTable({ identity, cachePath: join(root, 'cache.json') })).not.toHaveProperty('steward');
  }));

  it('shim settings forward their explicit legacy environment to the separation check', () => fixture(({ root, app, identity }) => {
    vi.stubEnv('WE_GITHUB_APP_ID', 'different-host-app');
    let source;
    buildGhShimSettingsEnv({ identity, env: { WE_GITHUB_APP_ID: app.appId, WE_GITHUB_APP_ROLE: 'steward' },
      cwd: root, pathEnv: root, cachePath: join(root, 'cache.json'), dir: join(root, 'shim'),
      ghThrottleCliPath: join(root, 'scripts/lib/absent.mjs'), exists: path => path === join(root, 'gh'),
      mkdir: () => {}, chmod: () => {}, readFile: () => '{}',
      writeFile: (path, value) => { if (path === join(root, 'shim/gh')) source = value; } });
    expect(source).toBeTypeOf('string');
    expect(source).not.toContain('cache.app-900010.json');
  }));

  it.each(['unreadable key', 'failed mint', 'missing guard', 'throwing guard', 'personal policy'])(
    '%s refuses interactive steward without personal or other App fallback', failure => fixture(async ({ root, identity }) => {
      const env = { GH_TOKEN: 'personal', GITHUB_TOKEN: 'other-personal', PATH: root };
      const installShim = vi.fn(async () => {
        if (failure === 'throwing guard') throw Error('fixture guard failure');
        return { ok: failure !== 'missing guard' };
      });
      const mint = vi.fn(async () => { throw Error('fixture mint failure'); });
      const setEnv = vi.fn();
      await expect(ensureFreshGithubAppEnv({ env, identity, role: 'steward', daemon: false,
        caller: 'fixture-steward', now: Date.parse('2026-11-26T15:00:00Z'),
        cachePath: join(root, 'cache.json'), statusPath: join(root, 'status.json'), callerStatusDir: join(root, 'callers'),
        policy: { auth: failure === 'personal policy' ? 'personal' : 'app' },
        readCache: () => null, writeCache: vi.fn(), writeStatus: vi.fn(), writeCallerStatus: vi.fn(),
        canReadKey: () => failure !== 'unreadable key', canReadKeyRef: () => false,
        readKeyRef: () => { throw Error('unexpected key read'); }, mint, setEnv, installShim,
        listRepos: () => { throw Error('unexpected repo read'); },
        getInstallationInfo: () => { throw Error('unexpected installation read'); },
        extraInstallations: false, log: { error() {} },
      })).rejects.toThrow(/steward.*operator|gh auth guard/i);
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(setEnv).not.toHaveBeenCalled();
      if (failure === 'unreadable key' || failure === 'failed mint') expect(installShim).toHaveBeenCalledOnce();
      if (failure !== 'failed mint') expect(mint).not.toHaveBeenCalled();
      else expect(mint.mock.calls.map(([config]) => config.appId)).toEqual(['900010']);
    }));
});

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildGhShimSettingsEnv, renderGhShimScript } from '../gh-app-shim.mjs';
import { resolveDeliveryIdentity, roleCachePath, shimRoleTable } from '../github-app-identity.mjs';
import { installationCachePath } from '../github-app-installations.mjs';

vi.mock('node:os', async importOriginal => ({ ...await importOriginal(), homedir: () => '/fixture/home' }));

const SYNTHETIC_APP = '900010';
const SYNTHETIC_INSTALLATION = '101';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'steward-shim-boundary-'));
  try {
    const app = { appId: SYNTHETIC_APP, installations: { fixture: SYNTHETIC_INSTALLATION }, key: { file: join(root, 'steward.pem') } };
    return run({ root, app, cachePath: join(root, 'cache.json'), env: { WE_GITHUB_APP_ROLE: 'steward' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function runShim(root, source, env) {
  const shim = join(root, 'shim.cjs'), entry = join(root, 'entry.cjs');
  const effect = join(root, 'unexpected-gh');
  writeFileSync(shim, source);
  writeFileSync(entry, `const fs = require('node:fs');
const cp = require('node:child_process');
Date.now = () => Date.parse('2026-11-26T15:00:00Z');
for (const method of ['readFileSync', 'existsSync', 'realpathSync']) {
  const original = fs[method];
  fs[method] = (path, ...args) => {
    if (!String(path).startsWith(${JSON.stringify(root + '/')})) throw new Error('unexpected filesystem read: ' + path);
    return original(path, ...args);
  };
}
cp.spawnSync = (file) => {
  if (file === '/usr/bin/git') return { status: 0, stdout: '', stderr: '' };
  fs.writeFileSync(${JSON.stringify(effect)}, String(file));
  return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
};
require(${JSON.stringify(shim)});
`);
  const result = spawnSync(process.execPath, [entry, 'api', 'repos/fixture/repo'], {
    cwd: root, timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    env: { ...env, HOME: root, PATH: root, GH_CONFIG_DIR: root, GH_REPO: 'fixture/repo',
      GH_TOKEN: 'personal-token', GITHUB_TOKEN: 'personal-token', GH_CALLER: 'fixture',
      WE_GITHUB_APP_INSTALLATIONS: JSON.stringify({ fixture: SYNTHETIC_INSTALLATION }), WE_GH_THROTTLE_LOCK_ROOT: join(root, 'ledger') },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/steward.*operator/i);
  expect(existsSync(effect)).toBe(false);
}

describe('steward shim configuration boundary', () => {
  it.each(['shared worker App', 'invalid higher-layer override'])(
    'refuses cached steward credentials under %s', invalid => fixture(({ root, app, cachePath, env }) => {
      const identity = resolveDeliveryIdentity({ platform: { steward: app },
        tool: invalid === 'shared worker App' ? { worker: app } : { steward: { appId: 'invalid' } }, env: {}, pinned: false });
      writeFileSync(installationCachePath(roleCachePath(cachePath, app.appId), SYNTHETIC_INSTALLATION),
        JSON.stringify({ v: 2, token: 'cached-token', expiresAt: '2026-11-26T16:00:00Z', installationId: SYNTHETIC_INSTALLATION }));
      const roleTable = shimRoleTable({ identity, cachePath, env });
      runShim(root, renderGhShimScript({ realGhPath: join(root, 'gh'), cachePath, roleTable,
        ghThrottleCliPath: join(root, 'no-throttle'), refreshCliPath: join(root, 'no-refresh'),
        personalFallbackPolicy: { personalFallback: 'allow', source: { personalFallback: 'fixture' } } }), env);
    }));

  it('steward-only configuration returns a refusal shim for a non-daemon steward caller', () => fixture(({ root, app, cachePath, env }) => {
    const identity = resolveDeliveryIdentity({ tool: { steward: app }, env: {}, pinned: false });
    let source;
    const settings = buildGhShimSettingsEnv({ env, identity, cachePath, dir: join(root, 'shim-dir'),
      cwd: root, pathEnv: root, ghThrottleCliPath: join(root, 'scripts/lib/no-throttle.mjs'),
      exists: path => path === join(root, 'gh'), mkdir: () => {}, chmod: () => {},
      readFile: () => '{}', writeFile: (path, value) => { if (path === join(root, 'shim-dir/gh')) source = value; } });
    expect(settings).not.toBeNull();
    expect(settings.WE_GITHUB_APP_ROLE).toBe('steward');
    expect(source).toBeTypeOf('string');
    runShim(root, source, { ...env, ...settings });
  }));
});

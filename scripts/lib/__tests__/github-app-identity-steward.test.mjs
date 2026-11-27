import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderGhShimScript } from '../gh-app-shim.mjs';
import { installationCachePath } from '../github-app-installations.mjs';
import { buildIdentityChain, resolveDeliveryIdentity, resolveRequestedRole, stewardToken, shimRoleTable } from '../github-app-identity.mjs';

const fixtureIds = { steward: '900010', worker: '900011', installation: '101', otherInstallation: '102', publisher: '1' };
const app = { appId: fixtureIds.steward, installations: { fixture: fixtureIds.installation }, key: { name: 'steward' }, botLogin: 'fixture-steward[bot]' };
const identity = () => resolveDeliveryIdentity({ tool: { steward: app }, pinned: false });
const token = 'fixture-token';
const env = () => ({ WE_GITHUB_APP_KEY_DIR: '/fixture/keys' });
const now = () => Date.parse('2026-11-26T15:00:00Z');
const receipt = () => ({ token, appId: app.appId, installationId: fixtureIds.installation, expiresAt: '2026-11-26T16:00:00Z',
  permissions: { metadata: 'read', contents: 'read', pull_requests: 'write', issues: 'write' } });
const options = () => ({ identity: identity(), installationId: fixtureIds.installation, now, env: env(), readToken: async () => receipt() });
describe('HANDLING-COMBO-A-WE steward identity', () => {
  it.each(['worker', 'legacy', 'personal'])('shim refuses steward rather than falling back to %s credentials', fallback => {
    const root = mkdtempSync(join(tmpdir(), 'steward-shim-'));
    try {
      const cachePath = join(root, 'cache.json'), effect = join(root, 'effect');
      const fakeGh = join(root, 'gh');
      writeFileSync(fakeGh, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(effect)}, 'called');\n`, { mode: 0o755 });
      const id = resolveDeliveryIdentity({ tool: { steward: app, worker: { ...app, appId: fixtureIds.worker } }, env: {}, pinned: false });
      const roleTable = shimRoleTable({ identity: id, cachePath });
      if (fallback !== 'personal') writeFileSync(installationCachePath(fallback === 'worker' ? roleTable.worker.cachePath : cachePath, '101'),
        JSON.stringify({ v: 2, token: 'other-app', expiresAt: '2026-11-26T16:00:00Z' }));
      const shim = join(root, 'shim.cjs');
      writeFileSync(shim, renderGhShimScript({ realGhPath: fakeGh, cachePath, roleTable,
        ghThrottleCliPath: join(root, 'no-throttle'), refreshCliPath: join(root, 'no-refresh') })
        .replace('\n', `\nDate.now = () => ${now()};\n`));
      const result = spawnSync(process.execPath, [shim, 'api', 'repos/fixture/repo'], { cwd: root, timeout: 10000,
        maxBuffer: 1024 * 1024, encoding: 'utf8', env: { HOME: root, PATH: root, GH_TOKEN: 'personal',
          GH_CONFIG_DIR: root, GH_REPO: 'fixture/repo', WE_GITHUB_APP_INSTALLATIONS: '{"fixture":"101"}',
          WE_GITHUB_APP_ROLE: 'steward' } });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/steward.*operator/i);
      expect(existsSync(effect)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('legacy publisher App id cannot be configured as steward on either credential path', async () => {
    const legacyEnv = { ...env(), WE_GITHUB_APP_ID: app.appId };
    expect(() => buildIdentityChain({ requestedRole: 'steward', identity: identity(), env: legacyEnv, cachePath: '/fixture/cache.json' }))
      .toThrow(/steward.*operator/i);
    const readToken = vi.fn(() => receipt());
    await expect(stewardToken({ ...options(), env: legacyEnv, readToken })).rejects.toThrow(/steward.*operator/i);
    expect(readToken).not.toHaveBeenCalled();
  });
  it('token reader refuses malformed higher-layer steward configuration before reading credentials', async () => {
    const id = resolveDeliveryIdentity({ platform: { steward: app }, tool: { steward: { appId: 'bad' } }, env: {}, pinned: false });
    const readToken = vi.fn(() => receipt());
    await expect(stewardToken({ ...options(), identity: id, readToken })).rejects.toThrow(/steward.*operator/i);
    expect(readToken).not.toHaveBeenCalled();
  });
  it.each(['worker', 'reviewer', 'merger', 'ledger', 'observer'])('token reader refuses App sharing with %s before reading credentials', async role => {
    const id = resolveDeliveryIdentity({ tool: { steward: app, [role]: app }, env: {}, pinned: false });
    const readToken = vi.fn(() => receipt());
    await expect(stewardToken({ ...options(), identity: id, readToken })).rejects.toThrow(/steward.*operator/i);
    expect(readToken).not.toHaveBeenCalled();
  });
  it.each([NaN, undefined])('unknown clock %s cannot authorize an expired steward token', async timestamp => {
    await expect(stewardToken({ ...options(), now: () => timestamp,
      readToken: () => ({ ...receipt(), expiresAt: '2026-11-26T14:00:00Z' }) })).rejects.toThrow(/steward.*operator/i);
  });
  it('selects a steward App with scoped writer attribution and no worker or legacy fallback', async () => {
    expect(resolveRequestedRole({ caller: 'ops-steward.mjs', env: {} }).role).toBe('steward');
    expect(buildIdentityChain({ requestedRole: 'steward', identity: identity(), env: env(), cachePath: '/fixture/cache.json' })
      .candidates.map(c => c.role)).toEqual(['steward']);
    expect(await stewardToken(options())).toBe(token);
  });
  it.each([null, { token: '' }, { appId: 'publisher' }, { installationId: fixtureIds.otherInstallation },
    { expiresAt: 'invalid' }, { expiresAt: '2026-11-26T14:00:00Z' }, { permissions: {} }])('absent or wrong steward token refuses: %j', async patch => {
    await expect(stewardToken({ ...options(), readToken: async () => patch === null ? null : { ...receipt(), ...patch } }))
      .rejects.toThrow(/steward.*operator/i);
  });
  it('an unconfigured steward refuses despite publisher and operator credentials', () => {
    expect(() => buildIdentityChain({ requestedRole: 'steward', identity: resolveDeliveryIdentity({ pinned: false }),
      env: { GH_TOKEN: 'personal', WE_GITHUB_APP_ID: fixtureIds.publisher }, cachePath: '/fixture/cache.json' })).toThrow(/steward.*operator/i);
  });
  it('missing or throwing token reader refuses without consulting inherited credentials', async () => {
    await expect(stewardToken({ ...options(), readToken: undefined })).rejects.toThrow(/steward.*operator/i);
    await expect(stewardToken({ ...options(), readToken: () => { throw new Error('unknown'); } })).rejects.toThrow(/steward.*operator/i);
  });
  it('invalid higher-layer steward settings cannot revive an older App', () => {
    const id = resolveDeliveryIdentity({ platform: { steward: app }, tool: { steward: { appId: 'bad' } }, pinned: false });
    expect(() => buildIdentityChain({ requestedRole: 'steward', identity: id, env: env(), cachePath: '/fixture/cache.json' }))
      .toThrow(/steward.*operator/i);
  });
  it('a publisher App cannot also serve as the steward', () => {
    const id = resolveDeliveryIdentity({ tool: { steward: app, worker: app }, pinned: false });
    expect(() => buildIdentityChain({ requestedRole: 'steward', identity: id, env: env(), cachePath: '/fixture/cache.json' }))
      .toThrow(/steward.*operator/i);
  });
});

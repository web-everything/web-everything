import { describe, expect, it } from 'vitest';
import { buildIdentityChain, resolveDeliveryIdentity, resolveRequestedRole, stewardToken } from '../github-app-identity.mjs';

const app = { appId: '900010', installations: { fixture: '101' }, key: { name: 'steward' }, botLogin: 'fixture-steward[bot]' };
const identity = () => resolveDeliveryIdentity({ tool: { steward: app }, pinned: false });
const token = 'fixture-token';
const env = () => ({ WE_GITHUB_APP_KEY_DIR: '/fixture/keys' });
const now = () => Date.parse('2026-11-26T15:00:00Z');
const receipt = () => ({ token, appId: app.appId, installationId: '101', expiresAt: '2026-11-26T16:00:00Z',
  permissions: { metadata: 'read', contents: 'read', pull_requests: 'write', issues: 'write' } });
const options = () => ({ identity: identity(), installationId: '101', now, readToken: async () => receipt() });
describe('HANDLING-COMBO-A-WE steward identity', () => {
  it('selects a steward App with scoped writer attribution and no worker or legacy fallback', async () => {
    expect(resolveRequestedRole({ caller: 'ops-steward.mjs', env: {} }).role).toBe('steward');
    expect(buildIdentityChain({ requestedRole: 'steward', identity: identity(), env: env(), cachePath: '/fixture/cache.json' })
      .candidates.map(c => c.role)).toEqual(['steward']);
    expect(await stewardToken(options())).toBe(token);
  });
  it.each([null, { token: '' }, { appId: 'publisher' }, { installationId: '102' },
    { expiresAt: 'invalid' }, { expiresAt: '2026-11-26T14:00:00Z' }, { permissions: {} }])('absent or wrong steward token refuses: %j', async patch => {
    await expect(stewardToken({ ...options(), readToken: async () => patch === null ? null : { ...receipt(), ...patch } }))
      .rejects.toThrow(/steward.*operator/i);
  });
  it('an unconfigured steward refuses despite publisher and operator credentials', () => {
    expect(() => buildIdentityChain({ requestedRole: 'steward', identity: resolveDeliveryIdentity({ pinned: false }),
      env: { GH_TOKEN: 'personal', WE_GITHUB_APP_ID: '1' }, cachePath: '/fixture/cache.json' })).toThrow(/steward.*operator/i);
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

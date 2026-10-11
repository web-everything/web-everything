import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import configSmell from '../../conveyor/health-smells/github-app-config.mjs';
import tokenSmell from '../../conveyor/health-smells/github-app-token.mjs';
import { readGithubAppStatus } from '../github-app-auth-env.mjs';
import { buildGhShimSettingsEnv } from '../gh-app-shim.mjs';
import { GITHUB_APP_ROLES, resolveDeliveryIdentity, roleCachePath } from '../github-app-identity.mjs';

const now = Date.parse('2026-10-11T12:00:00Z');
const fresh = new Date(now + 3600000).toISOString();
const stale = new Date(now - 3600000).toISOString();
const identity = resolveDeliveryIdentity({ tool: Object.fromEntries(GITHUB_APP_ROLES.map((role, i) => [role, {
  appId: String(i + 1), installations: { 'web-everything': String(i + 10) }, key: { file: `/fixture/${role}.pem` },
}])) });
function probe(id = identity, { expiredRole, staleRole, legacyCaller = false, missingRole } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'app-gate-'));
  const cachePath = join(dir, 'web-everything.json');
  const statusPath = join(dir, 'status.json');
  const callerDir = join(dir, 'callers');
  mkdirSync(callerDir);
  writeFileSync(statusPath, JSON.stringify({ checkedAt: stale, reason: 'old' }));
  for (const [role, app] of Object.entries(id.roles)) {
    if (!app) continue;
    if (role !== missingRole) writeFileSync(roleCachePath(cachePath, app.appId), JSON.stringify({ expiresAt: role === expiredRole ? stale : fresh, token: 'NEVER-EXPOSE' }));
    for (const [suffix, checkedAt] of [['old', stale], ['new', role === staleRole ? stale : new Date(now).toISOString()]]) {
      writeFileSync(join(callerDir, `${role}-${suffix}.json`), JSON.stringify({ caller: `${role}-${suffix}.mjs`, role, requestedRole: role, applied: true, checkedAt, reason: 'cached' }));
    }
  }
  if (legacyCaller) writeFileSync(join(callerDir, 'legacy.json'), JSON.stringify({ caller: 'legacy.mjs', role: 'legacy', applied: true, checkedAt: new Date(now).toISOString() }));
  try {
    return readGithubAppStatus(statusPath, { callerDir, cachePath, identity: id, now });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function rows(appStatus) { return tokenSmell.evaluate({ appToken: { present: true, expiresAt: stale }, appStatus }, { now }); }

describe('role cutover preconditions', () => {
  it('alerts on fallback without a legacy cache, while retaining fixture safety', () => {
    expect(configSmell.evaluate({ appToken: { present: false }, appStatus: { callers: [{ caller: 'review-daemon.mjs', applied: true, fallback: true, requestedRole: 'reviewer', role: 'worker', fallbackFrom: [{ role: 'reviewer', reason: 'mint-failed' }] }] } })).toMatchObject([{ breach: true }]);
    expect(configSmell.evaluate({ appToken: { present: false }, appStatus: { callers: [{ caller: 'fixture.mjs', applied: false }] } })).toEqual([]);
  });
  it('bakes caller overrides and rewrites them when changed', () => {
    const writes = [];
    const build = (role) => buildGhShimSettingsEnv({ env: {}, identity: { ...identity, callerRoles: { 'my-custom-caller.mjs': role } }, cachePath: '/fixture/cache.json', dir: '/fixture/shim', pathEnv: '/fixture/bin', exists: () => true, mkdir: () => {}, chmod: () => {}, writeFile: (_p, src) => writes.push(src) });
    expect(build('observer')).not.toBeNull();
    expect(build('reviewer')).not.toBeNull();
    expect(writes[0]).toContain('const CALLER_ROLES = {"my-custom-caller.mjs":"observer"}');
    expect(writes[1]).toContain('const CALLER_ROLES = {"my-custom-caller.mjs":"reviewer"}');
  });
  it('uses all active caches and latest per-role refresh, ignoring retired legacy state', () => {
    const status = probe();
    expect(status.roleCaches).toHaveLength(5);
    expect(JSON.stringify(status)).not.toContain('NEVER-EXPOSE');
    expect(rows(status).map(r => [r.subject, r.breach])).toEqual(GITHUB_APP_ROLES.map(r => [`app-token:${r}`, false]));
  });
  it.each([{ expiredRole: 'reviewer' }, { staleRole: 'reviewer' }, { missingRole: 'reviewer' }])('detects role cache trouble: %j', (options) => {
    expect(rows(probe(identity, options)).filter(r => r.breach).map(r => r.subject)).toEqual(['app-token:reviewer']);
  });
  it('keeps legacy monitoring when a caller still uses it', () => {
    expect(rows(probe(identity, { legacyCaller: true })).filter(r => r.breach).map(r => r.subject)).toEqual(['app-token']);
  });
  it('preserves the legacy result with no roles configured', () => {
    const status = probe(resolveDeliveryIdentity({}));
    expect(status).toEqual({ checkedAt: stale, reason: 'old' });
    expect(rows(status)).toEqual(rows({ checkedAt: stale, reason: 'old' }));
    expect(rows(status)[0]).toMatchObject({ subject: 'app-token', breach: true });
  });
});

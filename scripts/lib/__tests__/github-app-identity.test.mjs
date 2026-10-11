/**
 * Per-role GitHub App identity (operator decision 2026-10-10 ~5:55 PM ET): five Apps — worker, reviewer, merger,
 * ledger, observer — each switched on by a SETTING, never a code change. Until a role is configured it uses
 * today's App, byte-for-byte. A configured role whose App is missing or fails falls back to the worker App, then
 * today's App, and says so loudly (log + per-caller status the github-app-config smell reads).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { OWNER_INSTALLATIONS } from '../github-app-installations.mjs';
import {
  GITHUB_APP_ROLES, resolveDeliveryIdentity, resolveRequestedRole, roleForCaller, buildIdentityChain,
  roleCachePath, resolveBotLogins, roleOfBotLogin, ROLE_REQUIRED_PERMISSIONS, shimRoleTable,
} from '../github-app-identity.mjs';
import { ensureFreshGithubAppEnv } from '../github-app-auth-env.mjs';
import { renderGhShimScript } from '../gh-app-shim.mjs';
import { readPrivateKeyRef } from '../github-app-token.mjs';
import { worktreeGitEnv } from '../git-transport-branch.mjs';
import githubAppConfigSmell from '../../conveyor/health-smells/github-app-config.mjs';

const REVIEWER = { appId: '900001', installations: { 'web-everything': '91', 'frontier-ui': '92', plateauapp: '93' }, key: { file: '/keys/reviewer.pem' }, botLogin: 'plateau-reviewer[bot]' };
const MERGER = { appId: '900002', installations: { 'web-everything': '81', 'frontier-ui': '82', plateauapp: '83' }, key: { keychain: { service: 'plateau-merger-app', account: 'ops' } }, botLogin: 'plateau-merger[bot]' };
const WORKER = { appId: '900003', installations: { 'web-everything': '71', 'frontier-ui': '72', plateauapp: '73' }, key: { file: '/keys/worker.pem' }, botLogin: 'plateau-worker[bot]' };

describe('resolveDeliveryIdentity — the policy cascade', () => {
  it('defaults every role to today\'s App (nothing configured)', () => {
    const id = resolveDeliveryIdentity({});
    expect(GITHUB_APP_ROLES).toEqual(['worker', 'reviewer', 'merger', 'ledger', 'observer']);
    for (const r of GITHUB_APP_ROLES) { expect(id.roles[r]).toBeNull(); expect(id.sources[r]).toBe('standard'); }
    expect(id.anyConfigured).toBe(false);
  });

  it('env beats tool beats platform, per role, and logs the source', () => {
    const id = resolveDeliveryIdentity({
      platform: { reviewer: { ...REVIEWER, appId: '1' }, merger: MERGER },
      tool: { reviewer: REVIEWER },
      env: { WE_DELIVERY_IDENTITY: JSON.stringify({ merger: { ...MERGER, appId: '777' } }) },
    });
    expect(id.roles.reviewer.appId).toBe('900001');
    expect(id.sources.reviewer).toBe('tool');
    expect(id.roles.merger.appId).toBe('777');
    expect(id.sources.merger).toBe('env');
    expect(id.anyConfigured).toBe(true);
  });

  it('never stores key material — an inline PEM is refused as invalid', () => {
    const id = resolveDeliveryIdentity({ tool: { worker: { ...WORKER, key: '-----BEGIN RSA PRIVATE KEY-----\nabc' } } });
    expect(id.roles.worker).toBeNull();
    expect(id.invalid.join(' ')).toMatch(/worker/);
  });

  it('accepts installations keyed by repo slug, collapsed to the owner', () => {
    const id = resolveDeliveryIdentity({ tool: { observer: { appId: '5', installations: { 'plateauapp/plateau-app': '55' }, key: { file: '/k' } } } });
    expect(id.roles.observer.installations).toEqual({ plateauapp: '55' });
  });
});

describe('role declaration', () => {
  it('callers map to roles: drain→merger, review→reviewer, ops writers→ledger, read-only→observer, else worker', () => {
    expect(roleForCaller('merge-ai-prs.mjs')).toBe('merger');
    expect(roleForCaller('review-daemon.mjs')).toBe('reviewer');
    expect(roleForCaller('review-pr.mjs')).toBe('reviewer');
    expect(roleForCaller('review-set-label.mjs')).toBe('reviewer');
    expect(roleForCaller('record-verdict.mjs')).toBe('ledger');
    expect(roleForCaller('collect-review-requests.mjs')).toBe('ledger');
    expect(roleForCaller('pass-daemon.mjs:health-watch')).toBe('observer');
    expect(roleForCaller('pass-daemon.mjs:coroner-sweep')).toBe('observer');
    expect(roleForCaller('operator-queue.mjs')).toBe('observer');
    expect(roleForCaller('review-hold-ledger-shadow.mjs')).toBe('observer');
    expect(roleForCaller('pass-daemon.mjs:merge-orphan-sweep')).toBe('merger');
    expect(roleForCaller('reconcile-fix-dispatch-daemon.mjs')).toBeNull();
  });

  it('explicit role > WE_GITHUB_APP_ROLE > caller map > worker', () => {
    expect(resolveRequestedRole({ role: 'observer', env: { WE_GITHUB_APP_ROLE: 'merger' }, caller: 'merge-ai-prs.mjs' })).toEqual({ role: 'observer', source: 'arg' });
    expect(resolveRequestedRole({ env: { WE_GITHUB_APP_ROLE: 'reviewer' }, caller: 'merge-ai-prs.mjs' })).toEqual({ role: 'reviewer', source: 'env' });
    expect(resolveRequestedRole({ env: {}, caller: 'merge-ai-prs.mjs' })).toEqual({ role: 'merger', source: 'caller' });
    expect(resolveRequestedRole({ env: {}, caller: 'reconcile-fix-dispatch-daemon.mjs' })).toEqual({ role: 'worker', source: 'default' });
    expect(resolveRequestedRole({ env: { WE_GITHUB_APP_ROLE: 'nope' }, caller: 'x.mjs' })).toEqual({ role: 'worker', source: 'default' });
  });
});

describe('buildIdentityChain — role → worker → today\'s App', () => {
  const legacyEnv = { WE_GITHUB_APP_ID: '1', WE_GITHUB_APP_INSTALLATION_ID: OWNER_INSTALLATIONS['web-everything'], WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k' };
  it('nothing configured: only today\'s App, and it is not a fallback', () => {
    const c = buildIdentityChain({ requestedRole: 'reviewer', identity: resolveDeliveryIdentity({}), env: legacyEnv, cachePath: '/c/web-everything.json' });
    expect(c.candidates.map((x) => x.role)).toEqual(['legacy']);
    expect(c.candidates[0].cachePath).toBe('/c/web-everything.json');
    expect(c.loud).toBe(false);
  });
  it('reviewer configured: reviewer first, then today\'s App; an unconfigured observer is loud', () => {
    const identity = resolveDeliveryIdentity({ tool: { reviewer: REVIEWER } });
    const r = buildIdentityChain({ requestedRole: 'reviewer', identity, env: legacyEnv, cachePath: '/c/web-everything.json' });
    expect(r.candidates.map((x) => x.role)).toEqual(['reviewer', 'legacy']);
    expect(r.candidates[0].cachePath).toBe(roleCachePath('/c/web-everything.json', '900001'));
    const o = buildIdentityChain({ requestedRole: 'observer', identity, env: legacyEnv, cachePath: '/c/web-everything.json' });
    expect(o.candidates.map((x) => x.role)).toEqual(['legacy']);
    expect(o.skipped).toEqual([{ role: 'observer', reason: 'unconfigured' }, { role: 'worker', reason: 'unconfigured' }]);
    expect(o.loud).toBe(true);
  });
});

describe('per-role required permissions — no App ever needs admin', () => {
  it('matches the operator\'s table', () => {
    expect(ROLE_REQUIRED_PERMISSIONS.reviewer).toMatchObject({ pull_requests: 'write', issues: 'write', contents: 'read', checks: 'read', statuses: 'read', actions: 'read' });
    expect(ROLE_REQUIRED_PERMISSIONS.merger).toMatchObject({ contents: 'write', pull_requests: 'write', issues: 'write', workflows: 'write', checks: 'read', statuses: 'read', actions: 'read' });
    expect(ROLE_REQUIRED_PERMISSIONS.worker).toMatchObject({ contents: 'write', pull_requests: 'write', issues: 'write', actions: 'write', workflows: 'write', checks: 'read' });
    expect(ROLE_REQUIRED_PERMISSIONS.ledger).toMatchObject({ contents: 'write' });
    expect(ROLE_REQUIRED_PERMISSIONS.observer).toMatchObject({ contents: 'read', pull_requests: 'read', issues: 'read', checks: 'read', statuses: 'read', actions: 'read' });
    for (const perms of Object.values(ROLE_REQUIRED_PERMISSIONS)) expect(Object.values(perms)).not.toContain('admin');
  });
});

describe('bot logins — delivery.botLogins', () => {
  it('defaults to today\'s bot, adds each configured role\'s bot (both login shapes)', () => {
    expect(resolveBotLogins({})).toEqual(['web-everything', 'web-everything[bot]']);
    const list = resolveBotLogins({ identity: resolveDeliveryIdentity({ tool: { reviewer: REVIEWER } }) });
    expect(list).toEqual(expect.arrayContaining(['web-everything', 'web-everything[bot]', 'plateau-reviewer', 'plateau-reviewer[bot]']));
    expect(resolveBotLogins({ tool: ['Plateau-Worker[bot]'] })).toEqual(['plateau-worker', 'plateau-worker[bot]']);
    expect(resolveBotLogins({ env: { WE_DELIVERY_BOT_LOGINS: 'a[bot],b' } })).toEqual(['a', 'a[bot]', 'b']);
  });
  it('names which role posted (proof of who posted)', () => {
    const identity = resolveDeliveryIdentity({ tool: { reviewer: REVIEWER, worker: WORKER } });
    expect(roleOfBotLogin('plateau-reviewer[bot]', identity)).toBe('reviewer');
    expect(roleOfBotLogin('app/plateau-worker', identity)).toBe('worker');
    expect(roleOfBotLogin('web-everything[bot]', identity)).toBe('legacy');
    expect(roleOfBotLogin('chalbert', identity)).toBeNull();
  });
  it('a review by plateau-reviewer[bot] is a trusted marker author like today\'s bot', async () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const m = await import(process.argv[1]); console.log(JSON.stringify([m.isTrustedMarkerAuthor({author:{login:'plateau-reviewer[bot]'}}), m.isTrustedMarkerAuthor({author:{login:'plateau-reviewer'}}), m.isTrustedMarkerAuthor({author:{login:'web-everything'}}), m.isTrustedMarkerAuthor({author:{login:'mallory[bot]'}})]))",
      pathToFileURL(join(process.cwd(), 'scripts/lib/marker-authorship.mjs')).href,
    ], { encoding: 'utf8', env: { ...process.env, WE_DELIVERY_BOT_LOGINS: '', WE_DELIVERY_IDENTITY: JSON.stringify({ reviewer: REVIEWER }) } });
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual([true, true, true, false]);
  });
});

describe('readPrivateKeyRef — file or keychain reference, never the key itself', () => {
  it('reads a file ref and a keychain ref (hex-encoded multi-line secret decoded)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyref-'));
    writeFileSync(join(dir, 'k.pem'), 'PEM-FILE');
    expect(readPrivateKeyRef({ file: join(dir, 'k.pem') })).toBe('PEM-FILE');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n';
    const calls = [];
    const exec = (cmd, args) => { calls.push([cmd, ...args]); return Buffer.from(pem).toString('hex') + '\n'; };
    expect(readPrivateKeyRef({ keychain: { service: 's', account: 'a' } }, { exec })).toBe(pem);
    expect(calls[0]).toEqual(['/usr/bin/security', 'find-generic-password', '-s', 's', '-a', 'a', '-w']);
  });
});

// ── the dry run: a fake second App, end to end through ensureFreshGithubAppEnv and the real rendered shim ──
const FAKE_GH = `#!/usr/bin/env node
process.stdout.write('token=' + (process.env.GH_TOKEN || '') + '\\n');
`;
function setup({ identity, roleTable }) {
  const dir = mkdtempSync(join(tmpdir(), 'role-id-'));
  const fakeGh = join(dir, 'gh');
  writeFileSync(fakeGh, FAKE_GH); chmodSync(fakeGh, 0o755);
  const cachePath = join(dir, 'web-everything.json');
  const exp = new Date(Date.now() + 3600e3).toISOString();
  const minted = [];
  const errors = [];
  const callerFiles = {};
  const env = { WE_GITHUB_APP_ID: '1', WE_GITHUB_APP_INSTALLATION_ID: OWNER_INSTALLATIONS['web-everything'], WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k', PATH: '/usr/bin' };
  const shimPath = join(dir, 'shim.js');
  const run = (opts = {}) => ensureFreshGithubAppEnv({
    env, cachePath, statusPath: join(dir, 'status.json'), now: Date.now(), identity,
    mint: async ({ appId, installationId }) => {
      minted.push(`${appId}/${installationId}`);
      if (opts.failApp === String(appId)) throw new Error('HTTP 401 bad credentials');
      return { token: `tok-${appId}-${installationId}`, expiresAt: exp, permissions: { ...ROLE_REQUIRED_PERMISSIONS.worker, statuses: 'read', merge_queues: 'write' } };
    },
    getInstallationInfo: async () => ({ repositorySelection: 'all' }),
    canReadKey: () => true,
    log: { error: (m) => errors.push(m) },
    writeStatus: () => {},
    writeCallerStatus: (p, s) => { callerFiles[s.caller] = s; },
    installShim: async () => { writeFileSync(shimPath, renderGhShimScript({ realGhPath: fakeGh, cachePath, ghThrottleCliPath: join(dir, 'none.mjs'), roleTable })); return { ok: true }; },
    perOwner: true,
    ...opts,
  });
  const gh = (args, extraEnv = {}) => spawnSync(process.execPath, [shimPath, ...args], { encoding: 'utf8', cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...extraEnv } });
  return { env, run, gh, minted, errors, callerFiles, cachePath, dir };
}

describe('dry run — a fake second App config', () => {
  const identity = resolveDeliveryIdentity({ tool: { reviewer: REVIEWER, merger: MERGER } });
  const roleShim = (t) => async () => {
    writeFileSync(join(t.dir, 'shim.js'), renderGhShimScript({ realGhPath: join(t.dir, 'gh'), cachePath: t.cachePath, ghThrottleCliPath: join(t.dir, 'none.mjs'), roleTable: shimRoleTable({ identity, cachePath: t.cachePath }) }));
    return { ok: true };
  };

  it('the review daemon resolves to the reviewer App, and its gh calls post as it', async () => {
    const t = setup({ identity, roleTable: null });
    const r = await t.run({ caller: 'review-daemon.mjs', installShim: roleShim(t) });
    expect(r).toMatchObject({ applied: true, role: 'reviewer', requestedRole: 'reviewer', appId: '900001' });
    expect(t.env.WE_GITHUB_APP_ROLE).toBe('reviewer');
    expect(existsSync(join(t.dir, 'web-everything.app-900001.91.json'))).toBe(true);
    const out = t.gh(['pr', 'view', '1', '--repo', 'web-everything/web-everything'], { WE_GITHUB_APP_ROLE: 'reviewer' });
    expect(out.stdout.trim()).toBe('token=tok-900001-91');
    expect(out.stderr).not.toMatch(/GitHub App role/);
  });

  it('the drain resolves to the merger App (keychain key reference)', async () => {
    const t = setup({ identity, roleTable: null });
    const r = await t.run({ caller: 'merge-ai-prs.mjs', readKeyRef: () => 'PEM' });
    expect(r).toMatchObject({ applied: true, role: 'merger', requestedRole: 'merger', appId: '900002' });
    expect(t.minted).toContain('900002/81');
  });

  it('an unconfigured role (observer) falls back to today\'s App LOUDLY: log, caller status, smell breach', async () => {
    const t = setup({ identity, roleTable: null });
    const r = await t.run({ caller: 'pass-daemon.mjs:health-watch' });
    expect(r).toMatchObject({ applied: true, role: 'legacy', requestedRole: 'observer', fallback: true });
    expect(r.fallbackFrom).toEqual([{ role: 'observer', reason: 'unconfigured' }, { role: 'worker', reason: 'unconfigured' }]);
    expect(t.errors.join('\n')).toMatch(/observer.*FALLING BACK.*today's App/);
    const status = t.callerFiles['pass-daemon.mjs:health-watch'];
    expect(status).toMatchObject({ applied: true, role: 'legacy', requestedRole: 'observer', fallback: true });
    const findings = githubAppConfigSmell.evaluate({ appToken: { present: true }, appStatus: { callers: [status] } });
    expect(findings[0]).toMatchObject({ subject: 'pass-daemon.mjs:health-watch', breach: true });
    expect(findings[0].summary).toMatch(/observer/);
  });

  it('a configured role whose mint fails falls back to the next App, loudly', async () => {
    const t = setup({ identity, roleTable: null });
    const r = await t.run({ caller: 'review-daemon.mjs', failApp: '900001' });
    expect(r).toMatchObject({ applied: true, role: 'legacy', requestedRole: 'reviewer', fallback: true });
    expect(r.fallbackFrom[0]).toMatchObject({ role: 'reviewer', reason: 'mint-failed' });
    expect(t.errors.join('\n')).toMatch(/reviewer.*FALLING BACK/);
  });

  it('nothing configured: byte-identical to today (no role fields beyond the role, no fallback noise)', async () => {
    const t = setup({ identity: resolveDeliveryIdentity({}), roleTable: null });
    const r = await t.run({ caller: 'merge-ai-prs.mjs' });
    expect(r).toMatchObject({ applied: true, reason: 'ok', perOwner: true });
    expect(r.fallback).toBeFalsy();
    expect(t.errors).toEqual([]);
    expect(t.minted.every((m) => m.startsWith('1/'))).toBe(true);
  });

  it('the shim falls back loudly when the role\'s token is not cached, never silently', async () => {
    const t = setup({ identity, roleTable: null });
    await t.run({ caller: 'reconcile-fix-dispatch-daemon.mjs', installShim: roleShim(t) });
    const out = t.gh(['pr', 'view', '1', '--repo', 'web-everything/web-everything'], { WE_GITHUB_APP_ROLE: 'merger' });
    expect(out.stdout.trim()).toBe(`token=tok-1-${OWNER_INSTALLATIONS['web-everything']}`);
    expect(out.stderr).toMatch(/role "merger".*using the legacy App/);
  });
});

describe('ops/** writers declare the ledger role', () => {
  it('every git call in a transport worktree carries WE_GITHUB_APP_ROLE=ledger', () => {
    expect(worktreeGitEnv('/tmp/x/wt', { PATH: '/bin' }).WE_GITHUB_APP_ROLE).toBe('ledger');
  });
});

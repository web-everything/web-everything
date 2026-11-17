import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL as NodeURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { lockDirFor } from '../../readiness/file-locks.mjs';
import { slotPath } from '../../readiness/heavy-admission.mjs';
import * as delivery from '../github-app-identity.mjs';
import { resolveGhSlotBucket } from '../gh-installation-bucket.mjs';
import { installationCachePath } from '../github-app-installations.mjs';
import * as authCache from '../github-app-auth-env.mjs';
import { defaultCachePath } from '../github-app-auth-env.mjs';
import { renderGhShimScript } from '../gh-app-shim.mjs';
import { ghInstallationCap, ghSlotPool, ghHolderMeta, ghHolderPolicy, readGhSlotHolders, ghHoldersSummary, loadGhThrottleSettings } from '../gh-throttle-holders.mjs';
import { acquireGhSlotSync, releaseGhSlotSync, runGhSync, runGhCliPassthrough, ghThrottleStatus } from '../gh-throttle.mjs';

let root;
const policy = { maxHoldSeconds: 90, reapGraceSeconds: 15, perCallerMax: 0, installationCap: 2 };
const args = ['pr', 'list', '--repo', 'example/repo'];
const appEnv = (id) => {
  const GH_TOKEN = `ghs_fixture_${id}`;
  return { GH_TOKEN, WE_GITHUB_APP_INSTALLATIONS: JSON.stringify({ example: id }), WE_GH_AUTH_INSTALLATION: id, WE_GH_AUTH_TOKEN_HASH: createHash('sha256').update(GH_TOKEN).digest('hex') };
};
const baseEnv = () => ({ WE_GH_THROTTLE_INSTALLATION_CAP: '2', WE_GH_THROTTLE_COST_HEADERS: '0', WE_GH_PERSONAL_READS: '0', WE_GH_READ_MEMO: '0', WE_PLATFORM_PREFERENCES_FILE: join(root, 'no-platform.json') });
const pool = bucket => ghSlotPool({ lockRoot: root, cap: 1, bucket, installationCap: 2 });
const acquire = (bucket, owner, extra = {}) => acquireGhSlotSync({ ...pool(bucket), owner, timeoutMs: 0, policy, logPath: join(root, 'calls.jsonl'), warn: () => {}, meta: ghHolderMeta({ caller: owner, args }), ...extra });
const rows = name => readFileSync(join(root, name), 'utf8').trim().split('\n').map(JSON.parse);
const ok = () => ({ status: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) });
function invoke(mode, env, execute, extra = {}) {
  // Installation calls use a high explicit cap so installationCap (2) binds (R1011: explicit cap = upper bound);
  // shared-pool fallbacks keep the tiny cap.
  const throttle = { lockRoot: root, cap: env.GH_TOKEN ? 20 : 1, env: { ...baseEnv(), ...env }, personalRoute: false, acquireTimeoutMs: 0, warn: () => {}, budgetPerMin: 10000, ...extra };
  const callArgs = extra.args ?? args;
  return mode === 'sync'
    ? runGhSync(callArgs, { cwd: extra.cwd, env: throttle.env, throttle: { ...throttle, exec: execute } })
    : runGhCliPassthrough(callArgs, { throttle, spawn: execute });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gh-installations-'));
  vi.spyOn(authCache, 'defaultCachePath').mockImplementation(() => join(root, 'token-cache.json'));
  vi.spyOn(delivery, 'readDeliveryIdentity').mockReturnValue({ roles: {}, callerRoles: {}, anyConfigured: false });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('installation bucket resolution', () => {
  it('uses known bound installation identities without reading caches', () => {
    const readFresh = vi.fn(() => { throw new Error('must not read'); });
    expect(resolveGhSlotBucket({ identity: 'app-installation-123', env: { WE_GITHUB_APP_INSTALLATIONS: '{"example":"123"}' }, readFresh })).toEqual({ bucket: '123', reason: 'identity' });
    expect(readFresh).not.toHaveBeenCalled();
    expect(delivery.readDeliveryIdentity).toHaveBeenCalledTimes(1);
  });
  it('rejects an unknown numeric installation identity', () => {
    const probeOrigin = vi.fn();
    expect(resolveGhSlotBucket({ identity: 'app-installation-999999', env: {}, probeOrigin })).toEqual({ bucket: null, reason: 'unknown-installation' });
    expect(probeOrigin).not.toHaveBeenCalled();
  });
  it('recognizes an installation configured only in the role table', () => {
    delivery.readDeliveryIdentity.mockReturnValue({ roles: { worker: { appId: '1', installations: { example: '303' } } } });
    expect(resolveGhSlotBucket({ identity: 'app-installation-303' })).toEqual({ bucket: '303', reason: 'identity' });
  });
  it('resolves an ownerless call with the same bounded origin probe as the shim', () => {
    const probeOrigin = vi.fn(() => ({ status: 0, stdout: 'git@github.com:example/repo.git\n' }));
    expect(resolveGhSlotBucket({ identity: 'default', args: ['pr', 'list'], env: { WE_GITHUB_APP_INSTALLATIONS: '{"example":"101"}' }, probeOrigin, readFresh: () => ({ installationId: '101' }) })).toEqual({ bucket: '101', reason: 'shim-cache' });
    expect(probeOrigin).toHaveBeenCalledTimes(1);
    expect(probeOrigin).toHaveBeenCalledWith('/usr/bin/git', ['remote', 'get-url', 'origin'], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
  });
  it.each(['throws', 'failed', 'invalid-remote'])('keeps an ownerless %s origin probe in the shared pool', kind => {
    const probeOrigin = () => { if (kind === 'throws') throw new Error('unavailable'); return { status: kind === 'failed' ? 1 : 0, stdout: 'not a GitHub origin' }; };
    expect(resolveGhSlotBucket({ identity: 'default', args: ['pr', 'list'], probeOrigin })).toEqual({ bucket: null, reason: 'no-owner' });
  });
  it('resolves the actual process cwd checkout origin for an ownerless call', () => {
    const checkout = join(root, 'checkout');
    mkdirSync(checkout);
    execFileSync('/usr/bin/git', ['init', '-q'], { cwd: checkout });
    execFileSync('/usr/bin/git', ['remote', 'add', 'origin', 'git@github.com:example/repo.git'], { cwd: checkout });
    const caches = join(root, '.claude', 'github-app-token');
    mkdirSync(caches, { recursive: true });
    writeFileSync(join(caches, 'web-everything.101.json'), JSON.stringify({ v: 2, installationId: '101', token: 'ghs_fixture', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
    const source = `import { resolveGhSlotBucket } from ${JSON.stringify(new NodeURL('../gh-installation-bucket.mjs', import.meta.url).href)}; console.log(JSON.stringify(resolveGhSlotBucket({ identity: 'default', env: process.env, args: ['pr', 'list'] })));`;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: checkout, encoding: 'utf8', maxBuffer: 65536, timeout: 10000, env: { ...process.env, ...baseEnv(), HOME: root, GH_REPO: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, WE_GITHUB_APP_INSTALLATIONS: '{"example":"101"}' } });
    expect(JSON.parse(result)).toEqual({ bucket: '101', reason: 'shim-cache' });
  });
  it.each(['app', 't-abc', 'actions-example/repo', 'unknown'])('keeps %s in the shared pool', identity => {
    expect(resolveGhSlotBucket({ identity, env: {}, args }).bucket).toBeNull();
  });
  it('routes runGhSync by the child checkout origin when the parent checkout has a different owner', () => {
    const parent = join(root, 'parent');
    const child = join(root, 'child');
    for (const [checkout, owner] of [[parent, 'parent-owner'], [child, 'child-owner']]) {
      mkdirSync(checkout);
      execFileSync('/usr/bin/git', ['init', '-q'], { cwd: checkout });
      execFileSync('/usr/bin/git', ['remote', 'add', 'origin', `git@github.com:${owner}/repo.git`], { cwd: checkout });
    }
    const caches = join(root, '.claude', 'github-app-token');
    mkdirSync(caches, { recursive: true });
    for (const id of ['101', '202']) writeFileSync(join(caches, `web-everything.${id}.json`), JSON.stringify({
      v: 2, installationId: id, token: 'ghs_fixture', expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }));
    const source = `
import { runGhSync } from ${JSON.stringify(new NodeURL('../gh-throttle.mjs', import.meta.url).href)};
import { readGhSlotHolders } from ${JSON.stringify(new NodeURL('../gh-throttle-holders.mjs', import.meta.url).href)};
const lockRoot = ${JSON.stringify(join(root, 'locks'))};
const result = runGhSync(['pr', 'list'], { cwd: ${JSON.stringify(child)}, env: process.env, throttle: {
  env: process.env, lockRoot, cap: 1, shimRouted: true, personalRoute: false,
  exec: (_args, opts) => JSON.stringify({ cwd: opts.cwd, holders: readGhSlotHolders({ lockRoot, cap: 1 }) }),
} });
console.log(result);`;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: parent, encoding: 'utf8', maxBuffer: 65536, timeout: 10000,
      env: { ...process.env, ...baseEnv(), HOME: root, GH_REPO: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
        WE_GITHUB_APP_ROLE: 'worker', WE_GITHUB_APP_INSTALLATIONS: '{"parent-owner":"101","child-owner":"202"}' },
    });
    expect(JSON.parse(result)).toMatchObject({ cwd: child, holders: [{ bucket: '202' }] });
  });
  it.each(['fresh', 'expired', 'malformed', 'wrong-version', 'missing-token'])('reads the %s cache with the shim freshness rules', kind => {
    const cache = { v: 2, token: 'ghs_fixture', installationId: '101', expiresAt: new Date(Date.now() + (kind === 'expired' ? 60000 : 3600000)).toISOString() };
    if (kind === 'wrong-version') cache.v = 1;
    if (kind === 'missing-token') delete cache.token;
    writeFileSync(installationCachePath(defaultCachePath(), '101'), kind === 'malformed' ? '{' : JSON.stringify(cache));
    const result = resolveGhSlotBucket({ identity: 'default', args, env: { WE_GITHUB_APP_INSTALLATIONS: '{"example":"101"}' } });
    expect(result.bucket).toBe(kind === 'fresh' ? '101' : null);
  });
  it('rejects a mismatched per-installation cache', () => {
    writeFileSync(installationCachePath(defaultCachePath(), '101'), JSON.stringify({
      v: 2, token: 'ghs_fixture', installationId: '999',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }));
    expect(resolveGhSlotBucket({
      identity: 'default', args, env: { WE_GITHUB_APP_INSTALLATIONS: '{"example":"101"}' },
    })).toEqual({ bucket: null, reason: 'ambiguous' });
  });
  it('keeps an unprobeable ownerless call shared and rejects a credentialed default', () => {
    const readFresh = vi.fn();
    expect(resolveGhSlotBucket({ identity: 'default', args: ['pr', 'list'], readFresh, probeOrigin: () => ({ status: 1 }) })).toEqual({ bucket: null, reason: 'no-owner' });
    expect(resolveGhSlotBucket({ identity: 'default', args, env: { GH_TOKEN: 'personal' }, readFresh }).bucket).toBeNull();
    expect(readFresh).not.toHaveBeenCalled();
  });
  it.each(['argv', 'GH_REPO'])('resolves a legacy installation via %s and its matching fresh cache', source => {
    const env = { WE_GITHUB_APP_INSTALLATIONS: '{"example":"101"}', ...(source === 'GH_REPO' ? { GH_REPO: 'github.com/example/repo' } : {}) };
    const readFresh = vi.fn(() => ({ installationId: '101' }));
    expect(resolveGhSlotBucket({ identity: 'default', args: source === 'argv' ? args : [], env, readFresh })).toEqual({ bucket: '101', reason: 'shim-cache' });
    expect(readFresh).toHaveBeenCalledWith(installationCachePath(defaultCachePath(), '101'));
  });
  it.each(['reviewer', 'worker', 'legacy'])('uses the shared shim role chain for %s', role => {
    delivery.readDeliveryIdentity.mockReturnValue({ roles: { reviewer: { appId: '1', installations: { example: '201' } }, worker: { appId: '2', installations: { example: '202' } } }, callerRoles: { reviewerCaller: 'reviewer' } });
    const env = { WE_GITHUB_APP_INSTALLATIONS: '{"example":"101"}', ...(role === 'reviewer' ? {} : { WE_GITHUB_APP_ROLE: role }) };
    const expected = { reviewer: '201', worker: '202', legacy: '101' }[role];
    expect(resolveGhSlotBucket({ identity: 'default', args, caller: 'reviewerCaller', env, readFresh: () => ({ installationId: expected }) }).bucket).toBe(expected);
  });
  it('refuses ambiguity when an earlier role misses its cache even if the lower role has a fresh token', () => {
    delivery.readDeliveryIdentity.mockReturnValue({ roles: { reviewer: { appId: '1', installations: { example: '201' } }, worker: { appId: '2', installations: { example: '202' } } } });
    expect(resolveGhSlotBucket({ identity: 'default', args, env: { WE_GITHUB_APP_ROLE: 'reviewer' }, readFresh: path => path.includes('.202.') ? { installationId: '202' } : null })).toEqual({ bucket: null, reason: 'ambiguous' });
  });
  it('skips roles without an installation for the owner', () => {
    delivery.readDeliveryIdentity.mockReturnValue({ roles: { reviewer: { appId: '1', installations: { other: '201' } } } });
    expect(resolveGhSlotBucket({ identity: 'default', args, env: { WE_GITHUB_APP_ROLE: 'reviewer', WE_GITHUB_APP_INSTALLATIONS: '{"example":"101"}' }, readFresh: () => ({ installationId: '101' }) }).bucket).toBe('101');
  });
  it('accepts the legacy single cache only for the matching installation', () => {
    const env = { WE_GITHUB_APP_INSTALLATIONS: '{"example":"101"}' };
    for (const installationId of ['101', '999']) {
      const result = resolveGhSlotBucket({ identity: 'default', args, env, readFresh: path => path === defaultCachePath() ? { installationId } : null });
      expect(result.bucket).toBe(installationId === '101' ? '101' : null);
    }
  });
  it.each(['reviewer', 'worker', 'legacy', 'unconfigured'])('executes the generated shim owner lookup and agrees with the resolver for %s', role => {
    const identity = { roles: { reviewer: { appId: '1', installations: { example: '201' } }, worker: { appId: '2', installations: { example: '202' } } } };
    delivery.readDeliveryIdentity.mockReturnValue(identity);
    const cachePath = defaultCachePath();
    const roleTable = delivery.shimRoleTable({ identity, cachePath });
    const expected = { reviewer: '201', worker: '202', legacy: '101', unconfigured: '101' }[role];
    if (role === 'unconfigured') { delete roleTable.worker; delete identity.roles.worker; }
    const selectedCache = ['legacy', 'unconfigured'].includes(role) ? cachePath : roleTable[role].cachePath;
    writeFileSync(installationCachePath(selectedCache, expected), JSON.stringify({ v: 2, token: `ghs_fixture_${expected}`, installationId: expected, expiresAt: new Date(Date.now() + 3600000).toISOString() }));
    const executable = join(root, 'fixture-executable');
    writeFileSync(executable, `#!${process.execPath}\nconsole.log(String(process.env.GH_TOKEN || '').replace(/^ghs_fixture_/, ''));\n`);
    chmodSync(executable, 0o755);
    const relay = join(root, 'relay.cjs');
    writeFileSync(relay, "const {spawnSync}=require('node:child_process'); const r=spawnSync(process.env.WE_GH_THROTTLE_GH_BIN,process.argv.slice(2),{stdio:'inherit'}); process.exit(r.status ?? 1);");
    const shim = join(root, 'shim.cjs');
    writeFileSync(shim, renderGhShimScript({ realGhPath: executable, cachePath, roleTable, ghThrottleCliPath: relay }));
    const env = { PATH: process.env.PATH, WE_GITHUB_APP_ROLE: role, WE_GITHUB_APP_INSTALLATIONS: '{"example":"101"}' };
    const bucket = resolveGhSlotBucket({ identity: 'default', args, env }).bucket;
    const actual = execFileSync(process.execPath, [shim, ...args], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    expect(actual.trim()).toBe(bucket);
    expect(bucket).toBe(expected);
  });
  it('fails closed on absent caches and unknown owners', () => {
    expect(resolveGhSlotBucket({ identity: 'default', args, readFresh: () => null }).bucket).toBeNull();
    expect(resolveGhSlotBucket({ identity: 'default', args, env: { WE_GITHUB_APP_INSTALLATIONS: '{"example":"101"}' }, readFresh: () => null })).toEqual({ bucket: null, reason: 'unresolved' });
  });
});

describe('per-installation semaphore', () => {
  it('caps more callers than capacity independently in two simultaneously held buckets', () => {
    for (const bucket of ['101', '202']) {
      expect(acquire(bucket, `${bucket}-first`).ok).toBe(true);
      expect(acquire(bucket, `${bucket}-second`).ok).toBe(true);
      for (let i = 0; i < 5; i++) expect(acquire(bucket, `${bucket}-extra-${i}`).ok).toBe(false);
    }
    expect(readGhSlotHolders({ lockRoot: root, cap: 1 })).toHaveLength(4);
    expect(ghThrottleStatus({ lockRoot: root, cap: 1, installationCap: 2 }).installations).toMatchObject({ '101': { heldCount: 2 }, '202': { heldCount: 2 } });
    releaseGhSlotSync({ ...pool('101'), owner: '101-first' });
    expect(acquire('101', 'replacement').ok).toBe(true);
    expect(acquire('202', 'still-full').ok).toBe(false);
  });
  it('never exceeds either cap with simultaneous cross-process contenders', async () => {
    const workerPath = join(root, 'contender.mjs');
    writeFileSync(workerPath, `import { acquireGhSlotSync, releaseGhSlotSync } from ${JSON.stringify(new NodeURL('../gh-throttle.mjs', import.meta.url).href)};
import { ghSlotPool } from ${JSON.stringify(new NodeURL('../gh-throttle-holders.mjs', import.meta.url).href)};
const pool = ghSlotPool({ lockRoot: process.argv[2], cap: 1, bucket: process.argv[3], installationCap: 2 });
process.on('message', message => {
  if (message === 'go') process.send(acquireGhSlotSync({ ...pool, owner: String(process.pid), timeoutMs: 0, policy: { maxHoldSeconds: 90, reapGraceSeconds: 15, perCallerMax: 0 } }));
  if (message === 'release') { releaseGhSlotSync({ ...pool, owner: String(process.pid) }); process.exit(0); }
});
process.send('ready');
`);
    const children = Array.from({ length: 10 }, (_, i) => spawn(process.execPath, [workerPath, root, i < 5 ? '101' : '202'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, ...baseEnv() } }));
    try {
      const ready = await Promise.all(children.map(child => once(child, 'message')));
      expect(ready.every(([message]) => message === 'ready')).toBe(true);
      const results = children.map(child => once(child, 'message'));
      children.forEach(child => child.send('go'));
      const acquired = await Promise.all(results);
      expect(acquired.slice(0, 5).filter(([r]) => r.ok)).toHaveLength(2);
      expect(acquired.slice(5).filter(([r]) => r.ok)).toHaveLength(2);
      expect(readGhSlotHolders({ lockRoot: root, cap: 1 })).toHaveLength(4);
      const exits = children.map(child => once(child, 'exit'));
      children.forEach(child => child.send('release'));
      await Promise.all(exits);
      expect(readGhSlotHolders({ lockRoot: root, cap: 1 })).toEqual([]);
    } finally { children.forEach(child => { if (child.exitCode == null) child.kill(); }); }
  }, 20000);
  it('does not log slot_wait when the first acquisition succeeds despite clock advancement', () => {
    let clock = Date.now();
    expect(acquire('101', 'immediate', { now: () => clock++ }).ok).toBe(true);
    expect(existsSync(join(root, 'calls.jsonl'))).toBe(false);
  });
  it('enforces perCallerMax across installation pools and the shared pool', () => {
    const extra = { policy: { ...policy, perCallerMax: 1 }, meta: ghHolderMeta({ caller: 'same', args }) };
    expect(acquire('101', 'first', extra).ok).toBe(true);
    expect(acquire('101', 'second', extra).ok).toBe(false);
    expect(acquire('202', 'third', extra).ok).toBe(false);
    expect(acquire(null, 'shared', extra).ok).toBe(false);
    expect(acquire('202', 'different-bucket').ok).toBe(true);
    releaseGhSlotSync({ ...pool('101'), owner: 'first' });
    expect(acquire('202', 'third', extra).ok).toBe(true);
    expect(acquire('101', 'different').ok).toBe(true);
  });
  it('reports bucket holders and reaps an aged bucket slot into the shared call log', () => {
    const clock = Date.now();
    expect(acquire(null, 'shared').ok).toBe(true);
    expect(acquire('101', 'old', { cap: 1, now: () => clock, meta: ghHolderMeta({ caller: 'old', args, nowMs: clock }) }).ok).toBe(true);
    const holders = readGhSlotHolders({ lockRoot: root, cap: 1 });
    expect(holders).toHaveLength(2);
    expect(ghHoldersSummary(holders)).toContain('[101] old');
    expect(ghThrottleStatus({ lockRoot: root, cap: 1, installationCap: 1 })).toMatchObject({ cap: 1, heldCount: 1, installations: { '101': { cap: 1, heldCount: 1 } } });
    expect(acquire('101', 'new', { cap: 1, now: () => clock + 106000 }).ok).toBe(true);
    expect(rows('calls.jsonl')).toContainEqual(expect.objectContaining({ outcome: 'slot_reaped', bucket: '101', caller: 'old' }));
    expect(existsSync(join(root, 'installations', '101', 'calls.jsonl'))).toBe(false);
  });
});

describe.each(['sync', 'passthrough'])('%s slot routing', mode => {
  it('passes the execution cwd to bucket resolution', () => {
    const resolveSlotBucket = vi.fn(() => ({ bucket: null }));
    const cwd = join(root, 'child');
    invoke(mode, {}, () => mode === 'sync' ? '[]' : ok(), { shimRouted: true, resolveSlotBucket, cwd });
    expect(resolveSlotBucket).toHaveBeenCalledWith(expect.objectContaining({ cwd: mode === 'sync' ? cwd : process.cwd() }));
  });
  it.each([
    ['default fallback cap', undefined, '12', 6],
    ['configured fallback cap', '2', '12', 2],
    ['lower explicit generic env cap', '6', '2', 2],
  ])('cannot exceed the %s, while installation pools remain independent', (_label, fallbackCap, genericCap, expected) => {
    for (let i = 0; i < expected; i++) expect(acquire(null, `shared-${i}`, { cap: expected }).ok).toBe(true);
    const env = { GH_TOKEN: 'personal', WE_GH_THROTTLE_CAP: genericCap, WE_GH_THROTTLE_SHARED_FALLBACK_CAP: fallbackCap };
    const execute = vi.fn(() => mode === 'sync' ? '[]' : ok());
    const extra = { cap: undefined };
    if (mode === 'sync') expect(() => invoke(mode, env, execute, extra)).toThrow(/no gh slot/);
    else expect(invoke(mode, env, execute, extra)).toMatchObject({ status: 1, throttled: true });
    expect(execute).not.toHaveBeenCalled();
    expect(rows('calls.jsonl').find(r => r.outcome === 'slot_throttled').bucket).toBe('shared');
    // A full shared fallback cannot block an installation or reduce its own cap.
    expect(acquire('101', 'installation-first').ok).toBe(true);
    invoke(mode, { ...env, ...appEnv('101'), WE_GH_THROTTLE_SHARED_FALLBACK_CAP: '1' }, execute, extra);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('bounds the shared fallback when an installation directory cannot be created', () => {
    writeFileSync(join(root, 'installations'), 'blocked');
    expect(acquire(null, 'shared-first').ok).toBe(true);
    const execute = vi.fn(ok);
    const env = { ...appEnv('101'), WE_GH_THROTTLE_SHARED_FALLBACK_CAP: '1' };
    const extra = { cap: 12 };
    if (mode === 'sync') expect(() => invoke(mode, env, execute, extra)).toThrow(/no gh slot/);
    else expect(invoke(mode, env, execute, extra)).toMatchObject({ status: 1, throttled: true });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    ['generic cap=2 with fallback=6', 2, 6, 2],
    ['fallback cap=1 with generic=12', 12, 1, 1],
  ])('refuses a reserved shared read at the full %s', (_label, cap, fallbackCap, occupied) => {
    for (let i = 0; i < occupied; i++) expect(acquire(null, `shared-${i}`, { cap: occupied }).ok).toBe(true);
    const execute = vi.fn(ok);
    const env = { GH_TOKEN: 'personal', WE_GH_THROTTLE_SHARED_FALLBACK_CAP: String(fallbackCap) };
    const extra = { cap, reservedSlot: true, caller: 'red-main-freeze-read', args: ['api', '-i', 'repos/example/repo/git/ref/heads/main'] };
    if (mode === 'sync') expect(() => invoke(mode, env, execute, extra)).toThrow(/no gh slot/);
    else expect(invoke(mode, env, execute, extra)).toMatchObject({ status: 1, throttled: true });
    expect(execute).not.toHaveBeenCalled();
    expect(rows('calls.jsonl').find(r => r.outcome === 'slot_throttled').bucket).toBe('shared');
    expect(readGhSlotHolders({ lockRoot: root, cap })).toHaveLength(occupied);
  });
  it('does not create an installation directory for an unknown numeric identity', () => {
    const execute = vi.fn(() => {
      expect(readGhSlotHolders({ lockRoot: root, cap: 1 })).toHaveLength(1);
      expect(existsSync(join(root, 'installations', '999999'))).toBe(false);
      return mode === 'sync' ? '[]' : ok();
    });
    invoke(mode, { ...appEnv('999999'), WE_GITHUB_APP_INSTALLATIONS: '{}' }, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(rows('calls.jsonl').find(r => r.outcome === 'call').bucket).toBe('shared');
  });
  it('refuses a caller already at perCallerMax in another installation', () => {
    const meta = ghHolderMeta({ caller: 'same', args });
    expect(acquire('101', 'first', { meta }).ok).toBe(true);
    const execute = vi.fn(ok);
    const extra = { caller: 'same' };
    const env = { ...appEnv('202'), WE_GH_THROTTLE_PER_CALLER_MAX: '1' };
    if (mode === 'sync') expect(() => invoke(mode, env, execute, extra)).toThrow(/no gh slot/);
    else expect(invoke(mode, env, execute, extra)).toMatchObject({ status: 1, throttled: true });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    ['caller', 3, undefined, undefined, 3],
    ['revert env', undefined, '6', undefined, 6],
    ['installation env', undefined, '6', '8', 8],
    ['installation env over caller', 3, undefined, '2', 2],
  ])('applies the %s cap independently to each installation', (_label, explicitCap, legacyEnv, installationEnv, expected) => {
    for (let i = 0; i < expected; i++) expect(acquire('101', `holder-${i}`, { cap: expected }).ok).toBe(true);
    const execute = vi.fn(() => mode === 'sync' ? '[]' : ok());
    const env = { ...appEnv('101'), WE_GH_THROTTLE_CAP: legacyEnv, WE_GH_THROTTLE_INSTALLATION_CAP: installationEnv, WE_GH_THROTTLE_PER_CALLER_MAX: '0' };
    if (mode === 'sync') expect(() => invoke(mode, env, execute, { cap: explicitCap })).toThrow(/no gh slot/);
    else expect(invoke(mode, env, execute, { cap: explicitCap })).toMatchObject({ status: 1, throttled: true });
    expect(execute).not.toHaveBeenCalled();
    // A full installation does not impose an aggregate ceiling on another installation.
    invoke(mode, { ...env, ...appEnv('202') }, execute, { cap: explicitCap });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each(['direct', 'shim', 'unknown'])('holds a slot during every %s call and releases the matching pool', kind => {
    const env = kind === 'direct' ? appEnv('101') : kind === 'shim' ? { WE_GITHUB_APP_INSTALLATIONS: '{"example":"101"}' } : { GH_TOKEN: 'personal' };
    const execute = vi.fn(() => {
      const holders = readGhSlotHolders({ lockRoot: root, cap: 1 });
      expect(holders).toHaveLength(1);
      expect(holders[0].bucket ?? 'shared').toBe(kind === 'unknown' ? 'shared' : '101');
      return mode === 'sync' ? '[]' : ok();
    });
    invoke(mode, env, execute, { shimRouted: kind === 'shim', ...(kind === 'shim' ? { resolveSlotBucket: input => resolveGhSlotBucket({ ...input, readFresh: () => ({ installationId: '101' }) }) } : {}) });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(readGhSlotHolders({ lockRoot: root, cap: 1 })).toEqual([]);
    expect(rows('calls.jsonl').find(r => r.outcome === 'call').bucket).toBe(kind === 'unknown' ? 'shared' : '101');
    expect(rows('gh-waitlog.jsonl')[0].bucket).toBe(kind === 'unknown' ? 'shared' : '101');
  });
  it.each(['unknown', 'ambiguous', 'throws'])('falls back to the shared cap for %s resolution without executing unslotted', reason => {
    expect(acquire(null, 'shared-holder').ok).toBe(true);
    const execute = vi.fn(ok);
    const extra = { shimRouted: true, resolveSlotBucket: () => { if (reason === 'throws') throw new Error('resolver failure'); return { bucket: null, reason }; } };
    if (mode === 'sync') expect(() => invoke(mode, {}, execute, extra)).toThrow(/no gh slot/);
    else expect(invoke(mode, {}, execute, extra)).toMatchObject({ status: 1, throttled: true });
    expect(execute).not.toHaveBeenCalled();
    expect(rows('calls.jsonl').find(r => r.outcome === 'slot_throttled').bucket).toBe('shared');
  });
  it('uses installationCap rather than the legacy cap and logs waits with the bucket', () => {
    expect(acquire('101', 'first').ok).toBe(true);
    const execute = vi.fn(() => mode === 'sync' ? '[]' : ok());
    invoke(mode, appEnv('101'), execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(acquire('101', 'second').ok).toBe(true);
    let clock = Date.now();
    // A successful wait has its own event; refusals already carry waitedMs on slot_throttled.
    const resumed = vi.fn(() => mode === 'sync' ? '[]' : ok());
    invoke(mode, appEnv('101'), resumed, {
      acquireTimeoutMs: 20, now: () => clock, pollMs: 10,
      sleep: ms => { clock += ms; releaseGhSlotSync({ ...pool('101'), owner: 'first' }); },
    });
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(acquire('101', 'first').ok).toBe(true);
    const extra = { acquireTimeoutMs: 10, now: () => clock, sleep: ms => { clock += ms; }, pollMs: 10 };
    if (mode === 'sync') expect(() => invoke(mode, appEnv('101'), execute, extra)).toThrow(/no gh slot/);
    else expect(invoke(mode, appEnv('101'), execute, extra).status).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(rows('calls.jsonl')).toContainEqual(expect.objectContaining({ outcome: 'slot_wait', bucket: '101', waitedMs: 10 }));
    expect(rows('gh-waitlog.jsonl').at(-1)).toMatchObject({ bucket: '101', ok: false });
  });
  it('keeps the reserved extra slot in its own installation pool', () => {
    acquire('101', 'first'); acquire('101', 'second');
    const execute = vi.fn(() => {
      expect(readGhSlotHolders({ lockRoot: root, cap: 1 }).filter(h => h.bucket === '101')).toHaveLength(3);
      return mode === 'sync' ? '[]' : ok();
    });
    invoke(mode, appEnv('101'), execute, { reservedSlot: true, caller: 'red-main-freeze-read', args: ['api', '-i', 'repos/example/repo/git/ref/heads/main'] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(readGhSlotHolders({ lockRoot: root, cap: 1 })).toHaveLength(2);
  });
  it('falls back to the shared pool if the installation directory cannot be created', () => {
    writeFileSync(join(root, 'installations'), 'blocked');
    const execute = vi.fn(() => {
      expect(readGhSlotHolders({ lockRoot: root, cap: 1 })).toHaveLength(1);
      expect(existsSync(lockDirFor(root, slotPath(0)))).toBe(true);
      return mode === 'sync' ? '[]' : ok();
    });
    invoke(mode, appEnv('101'), execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(rows('calls.jsonl').find(r => r.outcome === 'call').bucket).toBe('shared');
  });
});

describe('settings and compatibility', () => {
  it('resolves shared fallback caps through the policy cascade with provenance and rejects invalid bounds', () => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: join(root, 'platform.json') };
    const load = (file = {}, extra = {}) => loadGhThrottleSettings({ file, env: { ...env, ...extra } });
    expect(load()).toMatchObject({ value: { sharedFallbackCap: 6 }, sources: { sharedFallbackCap: 'standard' } });
    writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ ghThrottle: { sharedFallbackCap: 3 } }));
    expect(load()).toMatchObject({ value: { sharedFallbackCap: 3 }, sources: { sharedFallbackCap: 'platform' } });
    const tool = { ghThrottle: { sharedFallbackCap: 4 } };
    expect(load(tool)).toMatchObject({ value: { sharedFallbackCap: 4 }, sources: { sharedFallbackCap: 'tool' } });
    expect(load(tool, { WE_GH_THROTTLE_SHARED_FALLBACK_CAP: '5' })).toMatchObject({ value: { sharedFallbackCap: 5 }, sources: { sharedFallbackCap: 'env' } });
    for (const invalid of [0, -1, 51, 1.5, '12', true, null]) {
      expect(load({ ghThrottle: { sharedFallbackCap: invalid } })).toMatchObject({ value: { sharedFallbackCap: 3 }, sources: { sharedFallbackCap: 'platform' } });
    }
    for (const invalid of ['0', '-1', '51', '1.5', 'NaN', 'Infinity', ' ']) {
      expect(load(tool, { WE_GH_THROTTLE_SHARED_FALLBACK_CAP: invalid })).toMatchObject({ value: { sharedFallbackCap: 4 }, sources: { sharedFallbackCap: 'tool' } });
    }
    for (const cap of [1, 50]) expect(load({}, { WE_GH_THROTTLE_SHARED_FALLBACK_CAP: String(cap) }).value.sharedFallbackCap).toBe(cap);
    expect(ghHolderPolicy({ ...env, WE_GH_THROTTLE_SHARED_FALLBACK_CAP: '7' }).sharedFallbackCap).toBe(7);
    expect(ghSlotPool({ lockRoot: root, cap: 12, sharedFallbackCap: 2 }).cap).toBe(2);
    expect(ghThrottleStatus({ lockRoot: root, cap: 12, sharedFallbackCap: 2 }).cap).toBe(2);
  });
  it('resolves default, platform, file, and env installation caps with provenance', () => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: join(root, 'platform.json') };
    const load = (file = {}, extra = {}) => loadGhThrottleSettings({ file, env: { ...env, ...extra } });
    expect(load()).toMatchObject({ value: { installationCap: 12 }, sources: { installationCap: 'standard' } });
    writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ ghThrottle: { installationCap: 3 } }));
    expect(load()).toMatchObject({ value: { installationCap: 3 }, sources: { installationCap: 'platform' } });
    expect(load({ ghThrottle: { installationCap: 4 } })).toMatchObject({ value: { installationCap: 4 }, sources: { installationCap: 'tool' } });
    expect(load({ ghThrottle: { installationCap: 4 } }, { WE_GH_THROTTLE_INSTALLATION_CAP: '5' })).toMatchObject({ value: { installationCap: 5 }, sources: { installationCap: 'env' } });
    for (const invalid of [0, -1, 51, 1.5, '12', true, null]) expect(load({ ghThrottle: { installationCap: invalid } }).value.installationCap).toBe(3);
    for (const invalid of ['0', '-1', '51', '1.5', 'NaN', 'Infinity', ' ']) expect(load({ ghThrottle: { installationCap: 4 } }, { WE_GH_THROTTLE_INSTALLATION_CAP: invalid }).value.installationCap).toBe(4);
    for (const cap of [1, 50]) expect(load({}, { WE_GH_THROTTLE_INSTALLATION_CAP: String(cap) }).value.installationCap).toBe(cap);
    expect(ghHolderPolicy({ ...env, WE_GH_THROTTLE_INSTALLATION_CAP: '7' }).installationCap).toBe(7);
  });
  it('keeps file installation caps over defaults and explicit generic caps over lower layers', () => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: join(root, 'none.json') };
    const settings = loadGhThrottleSettings({ file: { ghThrottle: { installationCap: 9 } }, env });
    expect(ghInstallationCap({ cap: 6, env, settings })).toBe(9);
    expect(ghInstallationCap({ cap: 3, explicitCap: true, env, settings })).toBe(3);
    expect(ghInstallationCap({ cap: 6, env: { ...env, WE_GH_THROTTLE_CAP: '6' }, settings })).toBe(6);
    expect(ghInstallationCap({ cap: 6, env: { ...env, WE_GH_THROTTLE_CAP: 'invalid' }, settings })).toBe(9);
  });
  it('R1011: an explicit throttle.cap always bounds the pool, even above a specific installation setting', () => {
    const env = { WE_PLATFORM_PREFERENCES_FILE: join(root, 'none.json'), WE_GH_THROTTLE_INSTALLATION_CAP: '9' };
    const settings = loadGhThrottleSettings({ file: {}, env });
    expect(ghInstallationCap({ cap: 3, explicitCap: true, env, settings })).toBe(3);
    expect(ghInstallationCap({ cap: 20, explicitCap: true, env, settings })).toBe(9);
    const fileSettings = loadGhThrottleSettings({ file: { ghThrottle: { installationCap: 8 } }, env: { WE_PLATFORM_PREFERENCES_FILE: join(root, 'none.json') } });
    expect(ghInstallationCap({ cap: 2, explicitCap: true, env: {}, settings: fileSettings })).toBe(2);
  });
  it('R1011: WE_GH_THROTTLE_CAP bounds the pool above a specific installation setting; a specific setting only lowers', () => {
    const base = { WE_PLATFORM_PREFERENCES_FILE: join(root, 'none.json') };
    const settings = loadGhThrottleSettings({ file: { ghThrottle: { installationCap: 8 } }, env: base });
    expect(ghInstallationCap({ cap: 6, env: { ...base, WE_GH_THROTTLE_CAP: '6' }, settings })).toBe(6);
    expect(ghInstallationCap({ cap: 20, env: { ...base, WE_GH_THROTTLE_CAP: '20' }, settings })).toBe(8);
    const envSettings = loadGhThrottleSettings({ file: {}, env: { ...base, WE_GH_THROTTLE_INSTALLATION_CAP: '8' } });
    expect(ghInstallationCap({ cap: 6, env: { ...base, WE_GH_THROTTLE_INSTALLATION_CAP: '8', WE_GH_THROTTLE_CAP: '6' }, settings: envSettings })).toBe(6);
  });
  it('removes the obsolete single-installation assertion', () => {
    const source = readFileSync(new NodeURL('../gh-throttle.mjs', import.meta.url), 'utf8');
    expect(source).not.toContain('authenticate as ONE GitHub App installation');
    expect(source).toContain('one per owner/role App');
  });
});

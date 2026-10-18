import { it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'overload-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

it('provisioned lanes disable automatic git gc', () => {
  const root = temp(); const source = join(root, 'source'); const pool = join(root, 'pool');
  execFileSync('git', ['init', '-q', '--initial-branch=main', source]);
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.org', 'commit', '--allow-empty', '-qm', 'initial'], { cwd: source });
  const r = spawnSync(process.execPath, ['scripts/lane-pool.mjs', 'provision', '--count=1', '--no-install', `--origin=${source}`, `--reference=${source}`, '--name=overload'], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: pool } });
  expect(r.status, r.stderr).toBe(0);
  expect(execFileSync('git', ['config', '--get', 'gc.auto'], { cwd: join(pool, 'overload', 'lane-1'), encoding: 'utf8' }).trim()).toBe('0');
});
it('host admission defers above 2.0 load/core and refuses unknown readings', async () => {
  const { hostLoadAdmission } = await import(/* @vite-ignore */ String('../lib/host-load.mjs'));
  const policy = { settings: { host: { maxLoadPerCore: 2 } }, sources: { 'host.maxLoadPerCore': 'standard' } };
  expect(hostLoadAdmission({ policy, load: () => [25], cores: () => 12 }).admitted).toBe(false);
  expect(hostLoadAdmission({ policy, load: () => [24], cores: () => 12 }).admitted).toBe(true);
  expect(hostLoadAdmission({ policy, load: () => { throw Error('unavailable'); } }).admitted).toBe(false);
  expect(hostLoadAdmission({ policy, load: () => [NaN], cores: () => 12 }).admitted).toBe(false);
});
it('settings cascade logs sources and invalid settings refuse', async () => {
  const { resolveHostOverloadSettings } = await import(/* @vite-ignore */ String('../lib/host-overload-settings.mjs'));
  const log = vi.fn();
  const p = resolveHostOverloadSettings({ platform: { host: { maxLoadPerCore: 3 } }, tool: { host: { maxLoadPerCore: 4 } }, env: { WE_HOST_MAX_LOAD_PER_CORE: '5' }, log });
  expect(p.settings.host.maxLoadPerCore).toBe(5);
  expect(p.sources['host.maxLoadPerCore']).toMatch(/env/);
  expect(log.mock.calls.flat().join(' ')).toContain('host.maxLoadPerCore=5');
  expect(() => resolveHostOverloadSettings({ env: { WE_HOST_MAX_LOAD_PER_CORE: 'bad' }, log })).toThrow();
});
it('host wait defaults to 15 minutes and resolves validated per-leaf overrides with sources', async () => {
  const { resolveHostOverloadSettings } = await import('../lib/host-overload-settings.mjs');
  const log = vi.fn();
  const standard = resolveHostOverloadSettings({ env: {}, log });
  expect(standard.settings.host.maxWaitMs).toBe(900000);
  expect(standard.sources['host.maxWaitMs']).toBe('standard');
  expect(log.mock.calls.flat().join(' ')).toContain('host.maxWaitMs=900000 (standard)');
  const layers = { platform: { host: { maxWaitMs: 100 } }, tool: { host: { maxWaitMs: 200 } }, log };
  expect(resolveHostOverloadSettings({ platform: layers.platform, env: {}, log }).sources['host.maxWaitMs']).toBe('platform');
  expect(resolveHostOverloadSettings({ ...layers, env: {} }).settings.host.maxWaitMs).toBe(200);
  expect(resolveHostOverloadSettings({ ...layers, env: {} }).sources['host.maxWaitMs']).toBe('tool');
  const override = resolveHostOverloadSettings({ ...layers, env: { WE_HOST_MAX_WAIT_MS: '250' } });
  expect(override.settings.host.maxWaitMs).toBe(250);
  expect(override.sources['host.maxWaitMs']).toBe('env');
  expect(resolveHostOverloadSettings({ env: { WE_HOST_MAX_WAIT_MS: '0' }, log }).settings.host.maxWaitMs).toBe(0);
  for (const value of ['-1', 'bad', '1.5', 'Infinity']) {
    expect(() => resolveHostOverloadSettings({ env: { WE_HOST_MAX_WAIT_MS: value }, log })).toThrow('invalid policy');
  }
});
it('test load readings are deterministic, validated, and ignored outside Vitest', async () => {
  const { readHostLoad, hostLoadAdmission } = await import('../lib/host-load.mjs');
  const load = vi.fn(() => [100]);
  const fixture = { VITEST: 'true', WE_TEST_HOST_LOAD1: '0' };
  expect(readHostLoad({ env: fixture, load })).toEqual([0]);
  expect(load).not.toHaveBeenCalled();
  expect(readHostLoad({ env: { ...fixture, VITEST: undefined }, load })).toEqual([100]);
  expect(load).toHaveBeenCalledTimes(1);
  const policy = { settings: { host: { maxLoadPerCore: 2 } }, sources: {} };
  for (const value of ['bad', '', '-1', 'Infinity']) {
    expect(hostLoadAdmission({ policy, interactive: false, load: () => readHostLoad({ env: { ...fixture, WE_TEST_HOST_LOAD1: value }, load }) }).admitted).toBe(false);
  }
});
it('scheduled gc is host single-flight and skips before the next due pass', async () => {
  const { scheduledLaneGc } = await import(/* @vite-ignore */ String('../lib/host-load.mjs'));
  const stateRoot = temp(); const exec = vi.fn();
  const opts = { stateRoot, exec, admission: () => ({ admitted: true }), log: () => {}, schedule: 86400000, nowMs: 100000000 };
  expect(scheduledLaneGc(['/pool/lane-1', '/pool/lane-2'], opts).ran).toBe(true);
  expect(exec).toHaveBeenCalledTimes(2);
  expect(scheduledLaneGc(['/pool/lane-1'], opts).ran).toBe(false);
});

it('deferrable heavy admission never acquires a slot above the host threshold', async () => {
  const { acquireSlotBlocking } = await import('../readiness/heavy-admission.mjs');
  const lockRoot = temp();
  const opts = { lockRoot, cap: 1, owner: 'test', env: {}, interactive: false,
    hostAdmission: () => ({ admitted: false, reason: 'host.maxLoadPerCore=2 (standard)' }), log: () => {} };
  expect(await acquireSlotBlocking({ ...opts, canDefer: true })).toMatchObject({ ok: false, deferred: true });
});
it.each([false, true])('mandatory admission waits then proceeds when load drops=%s without throwing', async (drops) => {
  const { acquireSlotBlocking, heldSlots, listWaiting } = await import('../readiness/heavy-admission.mjs');
  const { hostLoadAdmission } = await import('../lib/host-load.mjs');
  const lockRoot = temp(); const log = vi.fn(); let clock = 0;
  const sleep = vi.fn(async (ms) => {
    expect(heldSlots({ lockRoot, cap: 1, nowMs: clock })).toHaveLength(0);
    clock += ms;
  });
  const hostAdmission = vi.fn((opts) => hostLoadAdmission({ ...opts,
    policy: { settings: { host: { maxLoadPerCore: 2 } }, sources: { 'host.maxLoadPerCore': 'standard' } },
    load: () => [drops && clock >= 200 ? 12 : 36], cores: () => 12,
  }));
  const result = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'mandatory', canDefer: false,
    env: { WE_PLATFORM_PREFERENCES: join(lockRoot, 'no-preferences.json'),
      WE_PLATFORM_PREFERENCES_FILE: join(lockRoot, 'no-preferences.json'), WE_HOST_MAX_WAIT_MS: '250' },
    interactive: false, hostAdmission, now: () => clock, sleep, pollMs: 100, log });
  expect(result).toMatchObject({ ok: true, slot: 0, timedOut: false, waitedMs: drops ? 200 : 250 });
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(drops ? [100, 100] : [100, 100, 50]);
  expect(hostAdmission).toHaveBeenCalledTimes(drops ? 3 : 4);
  expect(listWaiting(lockRoot)).toEqual([]);
  const lines = log.mock.calls.flat().join('');
  expect(lines).toContain('host.maxWaitMs=250 (env)');
  expect(lines.match(/waiting for host load/g)).toHaveLength(drops ? 2 : 3);
  expect(lines).toContain('host load 36.00/12=3.00');
  if (drops) expect(lines).not.toContain('proceeding despite host load');
  else expect(lines).toContain('proceeding despite host load');
});
it('interactive operator commands remain admitted above the load cap', async () => {
  const { hostLoadAdmission } = await import('../lib/host-load.mjs');
  expect(hostLoadAdmission({ interactive: true, load: () => [1000], cores: () => 1 }).admitted).toBe(true);
});
it('gc refuses concurrent passes and host overload before spawning git', async () => {
  const { scheduledLaneGc } = await import('../lib/host-load.mjs');
  const stateRoot = temp(); const opts = { stateRoot, schedule: 60000, nowMs: 100000, log: () => {} };
  const exec = vi.fn();
  expect(scheduledLaneGc(['/lane'], { ...opts, admission: () => ({ admitted: false, reason: 'overload' }), exec }).ran).toBe(false);
  expect(exec).not.toHaveBeenCalled();
  let nested;
  scheduledLaneGc(['/lane'], { ...opts, admission: () => ({ admitted: true }), exec: () => {
    nested = scheduledLaneGc(['/other'], { ...opts, admission: () => ({ admitted: true }), exec });
  } });
  expect(nested.reason).toMatch(/busy/);
  expect(exec).not.toHaveBeenCalled();
});

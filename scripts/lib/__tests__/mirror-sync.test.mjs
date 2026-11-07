import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  cascadePolicy, formatCascadeSourcesLine, resetCascadeLogForTest,
} from '../policy-cascade.mjs';
// Deliberately unresolved: this contract must fail red until the module is implemented.
import { mirrorSyncForTick, resolveMirrorSyncPolicy, syncMirror } from '../mirror-sync.mjs';

vi.mock('../policy-cascade.mjs', async (importOriginal) => ({
  ...await importOriginal(), cascadePolicy: vi.fn((...args) => realCascade(...args)),
}));
// Keep the shared cascade real, while observing that the new reader delegates to it.
const { cascadePolicy: realCascade } = await vi.importActual('../policy-cascade.mjs');

// Any accidental subprocess bypass fails without invoking Git (or any host command).
const subprocess = vi.hoisted(() => Object.fromEntries(
  ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'].map(name => [
    name, vi.fn(() => { throw new Error('Use the injected run(args, options)'); }),
  ]),
));
vi.mock('node:child_process', () => ({ ...subprocess, default: subprocess }));

const INTERVAL = 300_000;
const TIMEOUT = 120_000;
const LOCK_STALE = 60_000;
const START = 1_800_000_000_000;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
let roots;
let fixtures;

beforeEach(() => {
  roots = [];
  fixtures = [];
  vi.clearAllMocks();
  resetCascadeLogForTest();
});

function assertNoGc(f) {
  for (const [args, options] of f.run.mock.calls) {
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain(`--git-dir=${f.mirrorPath}`);
    expect(args).not.toEqual(expect.arrayContaining(['git']));
    for (const command of ['gc', 'repack', 'prune', 'maintenance']) {
      expect(args).not.toContain(command);
    }
    if (args.includes('--prune')) expect(args).toContain('fetch');
    if (args.includes('fetch')) {
      expect(args).toEqual(expect.arrayContaining(['fetch', '--prune', '--no-auto-gc']));
      expect(args).toEqual(expect.arrayContaining(['-c', 'gc.auto=0', 'maintenance.auto=false']));
      expect(args[args.indexOf('gc.auto=0') - 1]).toBe('-c');
      expect(args[args.indexOf('maintenance.auto=false') - 1]).toBe('-c');
      expect(options).toMatchObject({ timeoutMs: f.fetchTimeoutMs });
    }
  }
}

afterEach(() => {
  try {
    for (const f of fixtures) assertNoGc(f); // NO GC EVER, including negative paths.
    for (const fn of Object.values(subprocess)) expect(fn).not.toHaveBeenCalled();
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  // The task runner supplies TMPDIR; never fall back to a host checkout or shared scratch.
  const root = mkdtempSync(join(process.env.TMPDIR, 'mirror-sync-'));
  roots.push(root);
  const f = {
    mirrorPath: join(root, 'custom-setting.git'),
    stateDir: join(root, 'state'),
    now: START,
    fetchTimeoutMs: TIMEOUT,
    mirrorMain: A,
    originMain: B,
    bare: { status: 0, stdout: 'true\n', stderr: '' },
    fetchResult: { status: 0, stdout: '', stderr: '' },
    emit: vi.fn(),
  };
  mkdirSync(f.mirrorPath);
  mkdirSync(f.stateDir);
  f.exists = vi.fn(path => {
    expect(path).toBe(f.mirrorPath);
    return existsSync(path);
  });
  f.run = vi.fn(async args => {
    if (args.includes('rev-parse')) {
      expect(args.slice(-2)).toEqual(['rev-parse', '--is-bare-repository']);
      return f.bare;
    }
    if (args.includes('fetch')) {
      const result = f.onFetch ? await f.onFetch() : f.fetchResult;
      if (result.status === 0) f.mirrorMain = f.originMain;
      return result;
    }
    throw new Error(`Unexpected injected Git command: ${JSON.stringify(args)}`);
  });
  f.sync = async (overrides = {}) => {
    const log = vi.fn();
    const result = await syncMirror({
      mirrorPath: f.mirrorPath, stateDir: f.stateDir, now: f.now,
      intervalMs: INTERVAL, fetchTimeoutMs: f.fetchTimeoutMs,
      run: f.run, exists: f.exists, log, emit: f.emit, lockStale: LOCK_STALE,
      ...overrides,
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toHaveLength(1);
    expect(log.mock.calls[0][0]).toEqual(expect.stringContaining(result.status));
    expect(log.mock.calls[0][0]).not.toMatch(/[\r\n]/);
    return result;
  };
  fixtures.push(f);
  return f;
}

const fetchCalls = f => f.run.mock.calls.filter(([args]) => args.includes('fetch'));

// Observe the persisted contract without imposing a particular state filename.
function state(f) {
  const candidates = readdirSync(f.stateDir).map(name => {
    const path = join(f.stateDir, name);
    try { return { path, value: JSON.parse(readFileSync(path, 'utf8')) }; }
    catch { return null; }
  }).filter(entry => entry?.value && Object.hasOwn(entry.value, 'lastSyncAt'));
  expect(candidates).toHaveLength(1);
  return candidates[0];
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe('syncMirror', () => {
  it('stale-then-synced: custom mirror main A catches origin B and records lastSyncAt', async () => {
    const f = fixture();
    expect(f.mirrorMain).toBe(A);
    expect(f.originMain).toBe(B);
    expect(await f.sync()).toMatchObject({ status: 'synced' });
    expect(f.mirrorMain).toBe(B);
    expect(fetchCalls(f)).toHaveLength(1);
    expect(state(f).value.lastSyncAt).toBe(START);
    expect(f.exists).toHaveBeenCalledWith(f.mirrorPath);
    expect(f.emit).not.toHaveBeenCalled();
    expect(readdirSync(f.stateDir)).toHaveLength(1); // State remains; lock is released.
  });

  it('lock contention: second concurrent call is locked and only one fetch runs', async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    f.onFetch = () => { entered.resolve(); return release.promise; };
    const first = f.sync();
    try {
      await entered.promise;
      expect(await f.sync()).toMatchObject({ status: 'locked' });
      expect(fetchCalls(f)).toHaveLength(1);
    } finally {
      release.resolve(f.fetchResult);
      await expect(first).resolves.toMatchObject({ status: 'synced' });
    }
    expect(fetchCalls(f)).toHaveLength(1);
    expect(readdirSync(f.stateDir)).toEqual([state(f).path.split(/[/\\]/).at(-1)]);
  });

  it('lock contention: stale lock is taken over after lockStale', async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    f.onFetch = () => { entered.resolve(); return release.promise; };
    const first = f.sync();
    let lockPath;
    let lockBytes;
    try {
      await entered.promise;
      const names = readdirSync(f.stateDir);
      expect(names).toHaveLength(1); // Before first successful state write, only the lock exists.
      lockPath = join(f.stateDir, names[0]);
      lockBytes = readFileSync(lockPath);
    } finally {
      release.resolve(f.fetchResult);
      await first;
    }
    // Recreate an abandoned lock using its actual representation, with an expired lease.
    rmSync(state(f).path);
    writeFileSync(lockPath, lockBytes);
    utimesSync(lockPath, START / 1000, START / 1000);
    f.onFetch = undefined;
    f.now += LOCK_STALE + 1;
    expect(await f.sync()).toMatchObject({ status: 'synced' });
    expect(fetchCalls(f)).toHaveLength(2);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('lock contention: lock released after failed fetch permits an immediate retry', async () => {
    const f = fixture();
    f.fetchResult = { status: 1, stdout: '', stderr: 'network refused' };
    expect(await f.sync()).toMatchObject({ status: 'failed' });
    expect(readdirSync(f.stateDir)).toHaveLength(0);
    f.fetchResult = { status: 0, stdout: '', stderr: '' };
    expect(await f.sync()).toMatchObject({ status: 'synced' });
    expect(fetchCalls(f)).toHaveLength(2);
  });

  it('rate-limited skip: within interval makes no run call; at the interval syncs', async () => {
    const f = fixture();
    await f.sync();
    const callsBeforeSkip = f.run.mock.calls.length;
    f.now += INTERVAL - 1;
    expect(await f.sync()).toMatchObject({ status: 'rate-limited' });
    expect(f.run).toHaveBeenCalledTimes(callsBeforeSkip);
    expect(state(f).value.lastSyncAt).toBe(START);
    f.now += 1;
    expect(await f.sync()).toMatchObject({ status: 'synced' });
    expect(fetchCalls(f)).toHaveLength(2);
    expect(state(f).value.lastSyncAt).toBe(f.now);
  });

  it('rate-limited skip: failed fetch does not advance lastSyncAt', async () => {
    const f = fixture();
    await f.sync();
    f.now += INTERVAL;
    f.fetchResult = { status: 1, stdout: '', stderr: 'offline' };
    expect(await f.sync()).toMatchObject({ status: 'failed' });
    expect(state(f).value.lastSyncAt).toBe(START);
    f.fetchResult = { status: 0, stdout: '', stderr: '' };
    expect(await f.sync()).toMatchObject({ status: 'synced' });
    expect(fetchCalls(f)).toHaveLength(3);
  });

  it('corrupt state file is no state: fetch proceeds within the previous interval', async () => {
    const f = fixture();
    await f.sync();
    writeFileSync(state(f).path, '{torn');
    f.now += 1;
    expect(await f.sync()).toMatchObject({ status: 'synced' });
    expect(fetchCalls(f)).toHaveLength(2);
    expect(state(f).value.lastSyncAt).toBe(f.now);
  });

  it('missing mirror: fails closed, emits skipped-missing and never runs Git', async () => {
    const f = fixture();
    f.exists.mockReturnValue(false);
    expect(await f.sync()).toMatchObject({ status: 'skipped-missing' });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.emit).toHaveBeenCalledTimes(1);
    expect(f.emit).toHaveBeenCalledWith({ type: 'mirror-sync-skipped', reason: 'missing' });
  });

  it.each([
    ['not bare', { status: 0, stdout: 'false\n', stderr: '' }],
    ['incomplete evidence', { status: 0, stdout: '', stderr: '' }],
    ['misleading substring', { status: 0, stdout: 'not true\n', stderr: '' }],
    ['failed rev-parse', { status: 128, stdout: 'true\n', stderr: 'unreadable' }],
  ])('invalid mirror (%s): fails closed with skipped-invalid and emits', async (_label, bare) => {
    const f = fixture();
    f.bare = bare;
    expect(await f.sync()).toMatchObject({ status: 'skipped-invalid' });
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(fetchCalls(f)).toHaveLength(0);
    expect(f.emit).toHaveBeenCalledTimes(1);
    expect(f.emit).toHaveBeenCalledWith({ type: 'mirror-sync-skipped', reason: 'invalid' });
  });

  it.each(['returned timeout', 'thrown timeout'])('fetch timeout: %s is failed with one log line and no retained lock', async mode => {
    const f = fixture();
    f.fetchTimeoutMs = 4321;
    f.onFetch = () => {
      if (mode === 'thrown timeout') throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      return { status: null, stdout: '', stderr: 'timed out' };
    };
    expect(await f.sync()).toMatchObject({ status: 'failed' });
    expect(fetchCalls(f)).toHaveLength(1);
    expect(fetchCalls(f)[0][1]).toMatchObject({ timeoutMs: 4321 });
    expect(readdirSync(f.stateDir)).toHaveLength(0);
  });
});

describe('resolveMirrorSyncPolicy', () => {
  function resolve(options = {}) {
    const log = vi.fn();
    const result = resolveMirrorSyncPolicy({
      config: {}, platform: null, ...options,
      env: { WE_POLICY_CASCADE_LOG: '1', ...options.env }, log,
    });
    expect(cascadePolicy).toHaveBeenCalledTimes(1);
    expect(cascadePolicy.mock.calls[0][0]).toBe('mirrorSync');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(formatCascadeSourcesLine('mirrorSync', result));
    return result;
  }

  it('default 5min: every leaf has source standard', () => {
    expect(resolve()).toMatchObject({
      value: { intervalMs: INTERVAL, fetchTimeoutMs: TIMEOUT, mirrorPath: join(homedir(), 'workspace', '.mirrors', 'web-everything.git') },
      sources: { intervalMs: 'standard', fetchTimeoutMs: 'standard', mirrorPath: 'standard' },
    });
  });

  it('env override: custom path and timing have source env', () => {
    const mirrorPath = join('settings', 'custom.git');
    expect(resolve({ env: {
      WE_MIRROR_SYNC_INTERVAL_MS: '6000', WE_MIRROR_SYNC_TIMEOUT_MS: '7000', WE_MIRROR_PATH: mirrorPath,
    } })).toMatchObject({
      value: { intervalMs: 6000, fetchTimeoutMs: 7000, mirrorPath },
      sources: { intervalMs: 'env', fetchTimeoutMs: 'env', mirrorPath: 'env' },
    });
  });

  it.each(['nope', '-1', '0', 'Infinity', 'NaN', '6000junk', '9007199254740992'])(
    'invalid env (%s) falls back to standard', value => {
      expect(resolve({ env: {
        WE_MIRROR_SYNC_INTERVAL_MS: value, WE_MIRROR_SYNC_TIMEOUT_MS: value, WE_MIRROR_PATH: '   ',
      } })).toMatchObject({
        value: { intervalMs: INTERVAL, fetchTimeoutMs: TIMEOUT, mirrorPath: join(homedir(), 'workspace', '.mirrors', 'web-everything.git') },
        sources: { intervalMs: 'standard', fetchTimeoutMs: 'standard', mirrorPath: 'standard' },
      });
    },
  );

  it('platform and tool layers resolve each leaf independently', () => {
    expect(resolve({
      platform: { intervalMs: 6000, fetchTimeoutMs: 7000 },
      config: { mirrorSync: { fetchTimeoutMs: 8000, mirrorPath: join('tool', 'mirror.git') } },
    })).toMatchObject({
      value: { intervalMs: 6000, fetchTimeoutMs: 8000, mirrorPath: join('tool', 'mirror.git') },
      sources: { intervalMs: 'platform', fetchTimeoutMs: 'tool', mirrorPath: 'tool' },
    });
  });
});

describe('mirrorSyncForTick', () => {
  it.each([
    ['dryRun', { dryRun: true, fixtureTick: false }],
    ['fixtureTick', { dryRun: false, fixtureTick: true }],
  ])('%s: returns null and calls nothing, including policy resolution', async (_label, mode) => {
    const touch = vi.fn(() => { throw new Error('Skipped tick must not read dependencies or settings'); });
    const untouched = new Proxy({}, { get: touch });
    expect(await mirrorSyncForTick({
      ...mode, flags: untouched, deps: untouched, config: untouched, env: untouched, now: START,
    })).toBeNull();
    expect(touch).not.toHaveBeenCalled();
    expect(cascadePolicy).not.toHaveBeenCalled();
  });

  it('runs otherwise: resolves settings and forwards the custom path, clock and injected IO', async () => {
    const f = fixture();
    const sync = vi.fn().mockResolvedValue({ status: 'synced' });
    const log = vi.fn();
    const result = await mirrorSyncForTick({
      flags: {}, fixtureTick: false, dryRun: false, now: f.now,
      config: {}, env: {
        WE_PLATFORM_PREFERENCES_FILE: join(f.stateDir, 'absent-preferences.json'),
        WE_MIRROR_PATH: f.mirrorPath, WE_MIRROR_SYNC_INTERVAL_MS: '6000', WE_MIRROR_SYNC_TIMEOUT_MS: '7000',
      },
      deps: { syncMirror: sync, stateDir: f.stateDir, run: f.run, exists: f.exists, log, emit: f.emit },
    });
    expect(result).toEqual({ status: 'synced' });
    expect(cascadePolicy).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({
      mirrorPath: f.mirrorPath, intervalMs: 6000, fetchTimeoutMs: 7000, now: f.now,
      stateDir: f.stateDir, run: f.run, exists: f.exists, log, emit: f.emit,
    }));
    expect(f.run).not.toHaveBeenCalled();
  });

  it('runs otherwise: defaults to the real syncMirror with injected Git when no override is supplied', async () => {
    const f = fixture();
    const log = vi.fn();
    expect(await mirrorSyncForTick({
      flags: {}, fixtureTick: false, dryRun: false, now: f.now, config: {},
      env: {
        WE_POLICY_CASCADE_LOG: '0',
        WE_PLATFORM_PREFERENCES_FILE: join(f.stateDir, 'absent-preferences.json'),
        WE_MIRROR_PATH: f.mirrorPath,
      },
      deps: { stateDir: f.stateDir, run: f.run, exists: f.exists, log, emit: f.emit },
    })).toMatchObject({ status: 'synced' });
    expect(fetchCalls(f)).toHaveLength(1);
    expect(state(f).value.lastSyncAt).toBe(START);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('synced');
  });
});

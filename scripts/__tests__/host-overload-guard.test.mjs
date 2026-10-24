import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'overload-')); dirs.push(d); return d; };
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Exercise the command wiring without dispatching the lane-pool CLI or mutating Git metadata.
function poolFunction(name, seams) {
  const source = readFileSync(resolve('scripts/lane-pool.mjs'), 'utf8');
  const body = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  if (!body) throw Error(`missing lane-pool function ${name}`);
  return runInNewContext(`(${body})`, seams);
}

it.each(['absent .git', 'missing HEAD'])('refresh heals %s before configuring gc and continues to the next lane', (damage) => {
  let broken = true;
  const config = vi.fn((_args, dir) => { if (broken && dir.endsWith('lane-1')) throw Error(damage); });
  const heal = poolFunction('fetchOriginHealing', {
    laneDir: (_repo, n) => `/pool/lane-${n}`,
    fetchOriginPruneWithRetry: (dir) => { if (broken && dir.endsWith('lane-1')) throw Error('not a git repository'); },
    healSharedStoreFor: () => false, diagnoseLane: () => ({ ok: !broken, problems: [damage] }),
    looksLikeCorruption: () => false, msgOf: (e) => e.message, log: () => {}, healLaneRefs: () => {},
    recloneLane: () => { broken = false; },
  });
  const scrub = vi.fn(); const fetch = vi.fn(heal);
  const refresh = poolFunction('refreshLane', {
    laneDir: (_repo, n) => `/pool/lane-${n}`, gitQuiet: config, fetchOriginHealing: fetch,
    scrubClaimedLaneConfig: scrub,
    liveLease: () => null, ttlMsFromFlags: () => 0, laneHoldRefuses: () => false,
    laneDirtyOrAhead: () => ({ dirty: true, uncommitted: 1, ahead: 0 }), log: () => {},
  });
  for (const n of [1, 2]) expect(refresh({ branch: 'main' }, n).skipped).toBe(true);
  expect(broken).toBe(false);
  expect(scrub.mock.calls).toEqual([
    ['/pool/lane-1', 'before refresh fetch'],
    ['/pool/lane-2', 'before refresh fetch'],
  ]);
  for (const i of [0, 1]) expect(scrub.mock.invocationCallOrder[i]).toBeLessThan(fetch.mock.invocationCallOrder[i]);
  expect(config.mock.calls).toEqual([
    [['config', '--local', 'gc.auto', '0'], '/pool/lane-1'],
    [['config', '--local', 'gc.auto', '0'], '/pool/lane-2'],
  ]);
});

it.each([false, true])('sibling clone disables automatic gc (existing=%s)', (existing) => {
  const gitQuiet = vi.fn(); const tryGit = vi.fn(() => 'origin/main');
  const scrub = vi.fn();
  poolFunction('ensureOneSibling', {
    join, primarySiblingPath: () => '/primary/fui', lstatSync: () => { if (!existing) throw Error('absent'); return { isSymbolicLink: () => false }; },
    existsSync: () => true, tryGit, gitQuiet, cloneReferenceArgs: () => [], log: () => {},
    NETWORK_GIT_TIMEOUT_MS: 1, laneDirtyOrAhead: () => ({ dirty: true, ahead: 0 }),
    scrubClaimedLaneConfig: scrub,
  })({ poolDir: '/pool' }, 'fui');
  expect([...gitQuiet.mock.calls, ...tryGit.mock.calls]).toContainEqual([['config', '--local', 'gc.auto', '0'], '/pool/fui']);
  expect(scrub).toHaveBeenCalledWith('/pool/fui', 'before sibling fetch');
  const fetchIndex = tryGit.mock.calls.findIndex(([args]) => args[0] === 'fetch');
  expect(fetchIndex).toBeGreaterThanOrEqual(0);
  expect(scrub.mock.invocationCallOrder[0]).toBeLessThan(tryGit.mock.invocationCallOrder[fetchIndex]);
});

it('gc command runs one pass and watch re-resolves policy with interactive bypass disabled', async () => {
  const run = async (watch) => {
    const scheduledLaneGc = vi.fn(() => ({ ran: true }));
    const loadHostOverloadSettings = vi.fn().mockReturnValueOnce({ settings: { lanes: { gc: { schedule: 60000 } } } })
      .mockReturnValue({ settings: { lanes: { gc: { schedule: 120000 } } } });
    const timers = [];
    const command = poolFunction('cmdGc', { scheduledLaneGc, loadHostOverloadSettings, flags: { watch },
      existingLanes: () => [1], laneDir: () => '/pool/lane-1', log: () => {},
      process: { stdin: { isTTY: true } }, recoveryEnabled: () => false,
      setTimeout: (fn, ms) => timers.push({ fn, ms }) });
    await command({});
    expect(scheduledLaneGc).toHaveBeenLastCalledWith(['/pool/lane-1'], expect.objectContaining({ interactive: !watch }));
    if (watch) {
      expect(timers[0].ms).toBe(60000);
      await timers[0].fn();
      expect(timers[1].ms).toBe(120000);
      expect(scheduledLaneGc).toHaveBeenCalledTimes(2);
      expect(loadHostOverloadSettings).toHaveBeenCalledTimes(2);
    } else expect(timers).toEqual([]);
  };
  await run(false); await run(true);
});

// Exercise each scheduled-pass refusal in both command modes, including the next watch tick.
it.each([false, true])('gc recovery only follows completed scheduled passes (watch=%s)', async watch => {
  for (const reason of ['host overloaded', 'unreadable policy', 'gc lock held', 'gc schedule not due']) {
    const scheduledLaneGc = vi.fn().mockReturnValueOnce({ ran: false, reason }).mockReturnValue({ ran: true });
    const recoverRepoPool = vi.fn(async () => {}), timers = [], log = vi.fn();
    const command = poolFunction('cmdGc', {
      scheduledLaneGc, flags: { watch }, existingLanes: () => [1], laneDir: () => '/pool/lane-1',
      recoveryEnabled: () => true, recoverRepoPool, log, process: { stdin: {} },
      loadHostOverloadSettings: () => ({ settings: { lanes: { gc: { schedule: 60000 } } } }),
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
    });
    const repo = { originUrl: 'https://example.org/canonical.git' };
    await command(repo);
    expect(recoverRepoPool).not.toHaveBeenCalled();
    if (watch) {
      expect(timers[0].ms).toBe(60000);
      await timers[0].fn();
      expect(timers[1].ms).toBe(60000);
    } else await command(repo);
    expect(recoverRepoPool).toHaveBeenCalledTimes(1);
    expect(recoverRepoPool).toHaveBeenCalledWith(repo);
  }
});

it.each([false, true])('gc skips recovery without a resolved canonical origin (watch=%s)', async watch => {
  const recoverRepoPool = vi.fn(), log = vi.fn(), timers = [];
  const command = poolFunction('cmdGc', {
    scheduledLaneGc: () => ({ ran: true }), flags: { watch }, existingLanes: () => [], laneDir: vi.fn(),
    recoveryEnabled: () => true, recoverRepoPool, log, process: { stdin: {} },
    loadHostOverloadSettings: () => ({ settings: { lanes: { gc: { schedule: 60000 } } } }),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  });
  await command({ originUrl: null });
  expect(recoverRepoPool).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/gc recovery skipped:.*canonical origin.*--origin/));
  expect(timers).toHaveLength(watch ? 1 : 0);
});

it.each(['lane', 'linked lane worktree', 'unreadable owner', 'primary', 'explicit origin'])(
  'gc only resolves a canonical recovery origin from trusted evidence: %s', kind => {
    const reference = kind === 'lane' ? '/pool/project/lane-1' : '/primary/project';
    const origin = 'https://example.org/project.git';
    const tryGit = vi.fn((args) => {
      if (args[0] === 'remote') return origin;
      if (args[1] === '--show-toplevel') return reference;
      if (args[1] === '--git-dir' || args[1] === '--git-common-dir') {
        if (kind === 'unreadable owner') return null;
        return kind === 'linked lane worktree' ? '/pool/project/lane-1/.git' : join(reference, '.git');
      }
      return null;
    });
    const repo = poolFunction('resolveRepo', {
      flags: { repo: reference, pool: 'project', ...(kind === 'explicit origin' ? { origin } : {}) },
      cmd: 'gc', resolve, dirname, basename, join, sep, expandHome: value => value,
      resolveReal: value => value, POOL_ROOT: '/pool', CWD_TOP_LEVEL: true, CHECKOUT_ROOT: '/primary/project',
      process: { env: {} }, laneGitHardeningEnv: value => value, scrubGitRepoEnv: value => value,
      LOCAL_GIT_TIMEOUT_MS: 1000, tryGit, fail: message => { throw Error(message); },
    })();
    expect(repo.poolDir).toBe('/pool/project');
    expect(repo.originUrl).toBe(['primary', 'explicit origin'].includes(kind) ? origin : null);
  },
);

it('gc watch retries unreadable policy without running a pass or recovery', async () => {
  const scheduledLaneGc = vi.fn(), recoverRepoPool = vi.fn(), timers = [], log = vi.fn();
  const command = poolFunction('cmdGc', {
    scheduledLaneGc, recoverRepoPool, flags: { watch: true }, log,
    loadHostOverloadSettings: () => { throw Error('unreadable policy'); },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  });
  await command({ originUrl: 'https://example.org/canonical.git' });
  expect(scheduledLaneGc).not.toHaveBeenCalled();
  expect(recoverRepoPool).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('gc skipped: unreadable policy');
  expect(timers[0].ms).toBe(60000);
});

// Kept for the launcher gate: local repair sandboxes forbid executing lane-pool.mjs.
it.each([false, true])('gc CLI dispatch accepts watch=%s and schedules only watch mode', (watch) => {
  const root = temp();
  const preload = `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module';
    os.userInfo = () => ({ homedir: ${JSON.stringify(root)} }); syncBuiltinESMExports();
    ${watch ? "globalThis.setTimeout = (_fn, ms) => { process.stdout.write('GC_WATCH=' + ms); return { unref() {} }; };" : ''}`;
  const child = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(preload)}`,
    'scripts/lane-pool.mjs', 'gc', `--repo=${root}`, '--pool=fixture', ...(watch ? ['--watch'] : [])], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, LANE_POOL_ROOT: root,
      WE_LANES_GC_SCHEDULE_MS: '60000', VITEST: 'true', WE_TEST_HOST_LOAD1: '0' },
  });
  expect(child.status, child.stderr).toBe(0);
  if (watch) expect(child.stdout).toBe('GC_WATCH=60000');
  else {
    expect(child.stderr).toContain('gc: gc schedule not due');
    expect(child.stdout).not.toContain('GC_WATCH=');
  }
});

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
// These regressions run without lane-pool commands or Git metadata writes.
function hostPolicyFiles(legacy, canonical = {}, tool = {}) {
  const root = temp();
  const legacyPath = join(root, 'legacy.json');
  const canonicalPath = join(root, 'canonical.json');
  const toolPath = join(root, 'tool.json');
  for (const [path, value] of [[legacyPath, legacy], [canonicalPath, canonical], [toolPath, tool]]) {
    writeFileSync(path, JSON.stringify(value));
  }
  return { env: { WE_PLATFORM_PREFERENCES: legacyPath, WE_PLATFORM_PREFERENCES_FILE: canonicalPath },
    toolPath, log: () => {} };
}

it.each(['platform', 'tool'])('host policy regression: rejects malformed whole leaves in %s before overrides', async (layer) => {
  const { resolveHostOverloadSettings } = await import('../lib/host-overload-settings.mjs');
  const cases = [
    ['host.maxLoadPerCore', (v) => ({ host: { maxLoadPerCore: v } }), 1],
    ['host.maxWaitMs', (v) => ({ host: { maxWaitMs: v } }), 250],
    ['lanes.transcripts.explicitScan', (v) => ({ lanes: { transcripts: { explicitScan: v } } }), false],
    ['lanes.gc.schedule', (v) => ({ lanes: { gc: { schedule: v } } }), 60000],
  ];
  for (const [key, policy, valid] of cases) {
    for (const value of [{}, { enabled: valid }, [], [valid], null, 'invalid']) {
      expect(() => resolveHostOverloadSettings({ [layer]: policy(value), env: {
        WE_HOST_MAX_LOAD_PER_CORE: '2', WE_HOST_MAX_WAIT_MS: '250',
        WE_LANE_TRANSCRIPT_EXPLICIT_SCAN: 'true', WE_LANES_GC_SCHEDULE_MS: '60000',
      }, log: () => {} }), `${layer}.${key}=${JSON.stringify(value)}`).toThrow('invalid policy');
    }
  }
});

it.each(['platform', 'tool'])('host policy regression: rejects malformed parent blocks in %s', async (layer) => {
  const { resolveHostOverloadSettings } = await import('../lib/host-overload-settings.mjs');
  for (const value of [null, [], false, 1, 'invalid']) {
    for (const policy of [value, { host: value }, { lanes: value },
      { lanes: { transcripts: value } }, { lanes: { gc: value } }]) {
      expect(() => resolveHostOverloadSettings({ [layer]: policy, env: {}, log: () => {} })).toThrow('invalid policy');
    }
  }
});

it.each(['legacy', 'canonical'])('host policy regression: malformed %s file refuses admission, gc and scans', async (layer) => {
  const { hostLoadAdmission, scheduledLaneGc } = await import('../lib/host-load.mjs');
  const { cachedTranscriptAttribution } = await import('../lib/lane-transcript-backfill.mjs');
  for (const bad of [{ lanes: { transcripts: { explicitScan: { enabled: false } } } },
    { host: { maxLoadPerCore: {} } }, { host: null }]) {
    const { env, log } = hostPolicyFiles(layer === 'legacy' ? bad : {}, layer === 'canonical' ? bad : {});
    const stateRoot = temp(); const scan = vi.fn(() => new Map([['1', []]])); const exec = vi.fn();
    expect(hostLoadAdmission({ env, log, interactive: false, load: () => [0], cores: () => 1 }).admitted).toBe(false);
    expect(scheduledLaneGc(['/lane'], { env, log, stateRoot, exec }).ran).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(() => cachedTranscriptAttribution('/root', { 1: '/lane' }, { env, log, stateRoot, scan })).toThrow('invalid policy');
    expect(scan).not.toHaveBeenCalled();
  }
});

it('host policy regression: preference files merge per leaf and canonical conflicts win', async () => {
  const { loadHostOverloadSettings } = await import('../lib/host-overload-settings.mjs');
  const { hostLoadAdmission } = await import('../lib/host-load.mjs');
  const opts = hostPolicyFiles({ host: { maxLoadPerCore: 0.5, maxWaitMs: 100 },
    lanes: { transcripts: { explicitScan: false }, gc: { schedule: 60000 } } },
  { host: { maxWaitMs: 250 }, lanes: { gc: { schedule: 120000 } } });
  const policy = loadHostOverloadSettings(opts);
  expect(policy.settings).toEqual({ host: { maxLoadPerCore: 0.5, maxWaitMs: 250, minMemoryHeadroomMb: 2048, maxReviewDispatchPerTick: 2 },
    lanes: { transcripts: { explicitScan: false }, gc: { schedule: 120000 } } });
  expect(Object.values(policy.sources)).toEqual(['platform', 'platform', 'standard', 'standard', 'platform', 'platform']);
  expect(hostLoadAdmission({ ...opts, interactive: false, load: () => [1], cores: () => 1 }).admitted).toBe(false);
});

it('host policy regression: invalid legacy values cannot be hidden by canonical overrides', async () => {
  const { loadHostOverloadSettings } = await import('../lib/host-overload-settings.mjs');
  for (const legacy of [{ host: { maxLoadPerCore: {} } }, { host: null }, null, []]) {
    const opts = hostPolicyFiles(legacy, { host: { maxLoadPerCore: 0.5 } });
    expect(() => loadHostOverloadSettings(opts)).toThrow('invalid policy');
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
it('the shared test setup supplies a fixed host load inherited by admission subprocesses', () => {
  expect(process.env.WE_TEST_HOST_LOAD1).toBe('0');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { readHostLoad } from './scripts/lib/host-load.mjs'; process.stdout.write(JSON.stringify(readHostLoad({ load: () => { throw Error('sampled real host'); } })));"],
  { encoding: 'utf8', timeout: 5000, env: { ...process.env } });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe('[0]');
});
it('scheduled gc is host single-flight and skips before the next due pass', async () => {
  const { scheduledLaneGc } = await import(/* @vite-ignore */ String('../lib/host-load.mjs'));
  const stateRoot = temp(); const exec = vi.fn();
  const opts = { stateRoot, exec, admission: () => ({ admitted: true }), log: () => {}, schedule: 86400000, nowMs: 100000000 };
  expect(scheduledLaneGc(['/pool/lane-1', '/pool/lane-2'], opts).ran).toBe(true);
  expect(exec).toHaveBeenCalledTimes(2);
  expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['gc.autoDetach=false', '--no-detach']), expect.objectContaining({ timeout: 120000 }));
  expect(scheduledLaneGc(['/pool/lane-1'], opts).ran).toBe(false);
});

it('a failing gc lane does not starve later lanes or advance its successful-run cursor', async () => {
  const { scheduledLaneGc } = await import('../lib/host-load.mjs');
  const stateRoot = temp();
  const exec = vi.fn((_command, _args, { cwd }) => { if (cwd.endsWith('lane-1')) throw Error('broken repo'); });
  const log = vi.fn();
  const opts = { stateRoot, exec, admission: () => ({ admitted: true }), log, schedule: 60000, nowMs: 100000 };
  expect(scheduledLaneGc(['/pool/lane-1', '/pool/lane-2'], opts).ran).toBe(true);
  expect(exec.mock.calls.map(([, , { cwd }]) => cwd)).toEqual(['/pool/lane-1', '/pool/lane-2']);
  expect(log.mock.calls.flat().join(' ')).toContain('/pool/lane-1');
  exec.mockClear();
  scheduledLaneGc(['/pool/lane-1', '/pool/lane-2'], opts);
  expect(exec.mock.calls.map(([, , { cwd }]) => cwd)).toEqual(['/pool/lane-1']);
});

it('gc refuses cursor serialization beyond the read limit and preserves the readable cursor', async () => {
  const { scheduledLaneGc, digest } = await import('../lib/host-load.mjs');
  const { boundedText } = await import('../lib/host-overload-settings.mjs');
  const stateRoot = temp();
  const cursor = Object.fromEntries(Array.from({ length: 3700 }, (_, i) => [digest(`old-${i}`), 0]));
  const original = JSON.stringify(cursor);
  const file = join(stateRoot, 'gc-cursor.json');
  expect(Buffer.byteLength(original)).toBeLessThan(256 * 1024);
  expect(Buffer.byteLength(`${JSON.stringify(cursor, null, 2)}\n`)).toBeGreaterThan(256 * 1024);
  writeFileSync(file, original);
  const result = scheduledLaneGc(['/pool/lane-1'], { stateRoot, schedule: 60000, nowMs: 100000,
    admission: () => ({ admitted: true }), exec: vi.fn(), log: () => {} });
  expect(result.reason).toBe('gc cursor too large');
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(boundedText(file)).toBe(original);
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

it('default TTY admission bypasses host overload through acquireSlotBlocking', async () => {
  const { acquireSlotBlocking } = await import('../readiness/heavy-admission.mjs');
  vi.stubEnv('WE_TEST_HOST_LOAD1', '1000000');
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  try {
    const result = await acquireSlotBlocking({ lockRoot: temp(), cap: 1, owner: 'operator', canDefer: true,
      env: { WE_HOST_MAX_LOAD_PER_CORE: '0.000000001' }, log: () => {} });
    expect(result.ok).toBe(true);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete process.stdin.isTTY;
  }
});

it.each([false, true])('held bypass uses the injected environment (held=%s)', async (held) => {
  const { acquireSlotBlocking } = await import('../readiness/heavy-admission.mjs');
  vi.stubEnv('WE_HEAVY_ADMISSION_HELD', held ? '' : '1');
  // Invalid policy always refuses the unheld path, independent of real load or ambient test stubs.
  const result = await acquireSlotBlocking({ lockRoot: temp(), cap: 1, owner: 'held', canDefer: true,
    interactive: false, env: { WE_HEAVY_ADMISSION_HELD: held ? '1' : '', WE_HOST_MAX_LOAD_PER_CORE: 'bad' }, log: () => {} });
  expect(result.ok).toBe(held);
  expect(!!result.deferred).toBe(!held);
  vi.unstubAllEnvs();
});

it('overloaded deferrable heavy command exits 75 without executing work', () => {
  const pool = temp();
  const child = spawnSync(process.execPath, ['scripts/readiness/heavy-admission.mjs', 'run', `--repo=${pool}`,
    '--', process.execPath, '-e', "process.stdout.write('HEAVY WORK RAN')"], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, CI: '', WE_HEAVY_ADMISSION: 'on', WE_HEAVY_ADMISSION_HELD: '',
      LANE_POOL_ROOT: pool, VITEST: 'true', WE_TEST_HOST_LOAD1: '1000000' },
  });
  expect(child.status, child.stderr).toBe(75);
  expect(child.stderr).toContain('heavy-command admission deferred: host load');
  expect(child.stdout).not.toContain('HEAVY WORK RAN');
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

describe('memory-aware host admission (verify-admission, 2026-10-20)', () => {
  const policy = { settings: { host: { maxLoadPerCore: 2, minMemoryHeadroomMb: 2048 } }, sources: { 'host.maxLoadPerCore': 'standard', 'host.minMemoryHeadroomMb': 'standard' } };
  it('waits (not admitted) when free memory + swap headroom is below host.minMemoryHeadroomMb, and logs the source', async () => {
    const { hostLoadAdmission } = await import('../lib/host-load.mjs');
    const low = hostLoadAdmission({ policy, interactive: false, load: () => [1], cores: () => 12, memory: () => 1785 });
    expect(low).toMatchObject({ admitted: false });
    expect(low.reason).toContain('host memory headroom 1785MB (free+swap); host.minMemoryHeadroomMb=2048 (standard)');
    expect(hostLoadAdmission({ policy, interactive: false, load: () => [1], cores: () => 12, memory: () => 4096 }).admitted).toBe(true);
    // Unknown memory fails closed.
    expect(hostLoadAdmission({ policy, interactive: false, load: () => [1], cores: () => 12, memory: () => { throw Error('no vm_stat'); } }).admitted).toBe(false);
    expect(hostLoadAdmission({ policy, interactive: false, load: () => [1], cores: () => 12, memory: () => NaN }).admitted).toBe(false);
  });
  it('parses macOS vm_stat + swapusage without counting the inactive file cache', async () => {
    const { parseDarwinMemoryHeadroomMb } = await import('../lib/host-load.mjs');
    const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                   39424.\nPages active:  1.\nPages inactive:                               793701.\nPages speculative:                             0.\nPages purgeable:                                0.\n';
    expect(Math.round(parseDarwinMemoryHeadroomMb(vm, 'vm.swapusage: total = 6144.00M  used = 4974.94M  free = 1169.06M  (encrypted)'))).toBe(616 + 1169);
    expect(() => parseDarwinMemoryHeadroomMb('garbage', '')).toThrow();
  });
  it('readHostMemoryHeadroomMb: darwin reads vm_stat + swapusage (bounded), others use freemem; the Vitest seam is validated', async () => {
    const { readHostMemoryHeadroomMb } = await import('../lib/host-load.mjs');
    const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                   39424.\nPages inactive: 1.\nPages speculative: 0.\nPages purgeable: 0.\n';
    const exec = vi.fn((cmd) => (cmd === 'vm_stat' ? vm : 'vm.swapusage: total = 2048.00M  used = 1024.00M  free = 1024.00M'));
    const real = { VITEST: 'false' };
    expect(Math.round(readHostMemoryHeadroomMb({ env: real, platform: 'darwin', exec }))).toBe(616 + 1024);
    expect(exec.mock.calls).toEqual([['vm_stat', [], { encoding: 'utf8', timeout: 5000 }], ['sysctl', ['vm.swapusage'], { encoding: 'utf8', timeout: 5000 }]]);
    const free = vi.fn(() => 3 * 1048576);
    expect(readHostMemoryHeadroomMb({ env: real, platform: 'linux', exec, free })).toBe(3);
    expect(exec).toHaveBeenCalledTimes(2);
    // A hung vm_stat surfaces as a throw, which hostLoadAdmission turns into a closed (not admitted) verdict.
    expect(() => readHostMemoryHeadroomMb({ env: real, platform: 'darwin', exec: () => { throw Error('ETIMEDOUT'); } })).toThrow('ETIMEDOUT');
    expect(readHostMemoryHeadroomMb({ env: { VITEST: 'true', WE_TEST_HOST_MEMORY_MB: '512' }, platform: 'darwin', exec })).toBe(512);
    expect(exec).toHaveBeenCalledTimes(2);
    for (const bad of ['', ' ', '-1', 'x']) {
      expect(() => readHostMemoryHeadroomMb({ env: { VITEST: 'true', WE_TEST_HOST_MEMORY_MB: bad } })).toThrow('invalid test host memory');
    }
    // The seam is Vitest-only: outside Vitest the value is ignored and the host is read.
    expect(readHostMemoryHeadroomMb({ env: { WE_TEST_HOST_MEMORY_MB: '512' }, platform: 'linux', free })).toBe(3);
  });
  it('the cascade carries both new leaves with sources, and rejects a 0 (cannot switch the check off)', async () => {
    const { resolveHostOverloadSettings } = await import('../lib/host-overload-settings.mjs');
    const log = vi.fn();
    const p = resolveHostOverloadSettings({ env: { WE_HOST_MIN_MEMORY_HEADROOM_MB: '3000' }, log });
    expect(p.settings.host).toMatchObject({ minMemoryHeadroomMb: 3000, maxReviewDispatchPerTick: 2 });
    expect(log.mock.calls.flat().join(' ')).toMatch(/host\.minMemoryHeadroomMb=3000 \(env/);
    expect(() => resolveHostOverloadSettings({ env: { WE_HOST_MIN_MEMORY_HEADROOM_MB: '0' }, log })).toThrow();
    expect(() => resolveHostOverloadSettings({ env: { WE_HOST_MAX_REVIEW_DISPATCH_PER_TICK: '0' }, log })).toThrow();
  });
});

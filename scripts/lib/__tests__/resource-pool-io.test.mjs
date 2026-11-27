// @vitest-environment node
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const guard = vi.hoisted(() => ({ active: false, writes: [], children: [], checkout: '' }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  const wrap = api => Object.fromEntries(Object.entries(api).map(([key, value]) => {
    if (typeof value !== 'function') return [key, value];
    return [key, Object.assign((...args) => {
      const mutation = /^(?:write|append|mkdir|mkdtemp|rm|rmdir|unlink|rename|copy|cp|link|symlink|truncate|chmod|chown|utimes|lutimes|fchmod|fchown|futimes|ftruncate|createWriteStream)/.test(key)
        || (/^open(?:Sync)?$/.test(key) && args[1] !== actual.constants.O_RDONLY
          && args[1] !== (actual.constants.O_RDONLY | actual.constants.O_NONBLOCK | actual.constants.O_NOFOLLOW));
      if (guard.active && mutation) { guard.writes.push([key, ...args]); throw Error('inventory attempted fs mutation'); }
      return value(...args);
    }, value)];
  }));
  const guarded = { ...wrap(actual), promises: wrap(actual.promises) };
  return { ...guarded, default: guarded };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  const guarded = Object.fromEntries(Object.entries(actual).map(([key, value]) => [key,
    typeof value !== 'function' ? value : (...args) => {
      if (!guard.active) throw Error('unexpected child process');
      guard.children.push([key, ...args]);
      if (key !== 'execFileSync' || args[0] !== 'git') throw Error('allocator CLI must never run');
      return args[1].includes('--show-toplevel') ? guard.checkout : 'https://example.test/web-everything.git';
    }]));
  return { ...guarded, default: guarded };
});
const fs = await vi.importActual('node:fs');
const { mkdirSync, writeFileSync } = fs;
import { execFileSync } from 'node:child_process';
import { readPoolSource, readPoolJson, readPoolHeavyHeld, poolPidAlive, poolSourcePaths,
  SOURCES, RED_TEAM_HARD_LEASE_CEILING_MS, loadPoolSettings, readPoolSettingsChecked, readPoolOverrides } from '../resource-pool-io.mjs';
import { POOL_DEFAULTS, grantDecision, summarize } from '../resource-pool.mjs';
import { readPoolLaneStatus } from '../resource-pool-lanes.mjs';
import { lockDirFor } from '../../readiness/file-locks.mjs';
let coord, paths, env, laneDir;
const nowMs = 2000;
const lease = () => ({ session: 'fix-1', acquiredAt: new Date(1000).toISOString() });
const snap = () => ({ sampledAt: new Date(1000).toISOString(), freshUntil: new Date(3000).toISOString(),
  memory: { availableMb: 40000, floorMb: 4000, swapUsedPct: 10, swapGrowthMb: 0, pressureLevel: 1 }, cpu: { idlePct: 40 } });
const head = 'a'.repeat(40), filename = `we-12-${head}.json`;
const status = () => ({ repo: 'we', pr: 12, head, status: 'running', pid: 123, pidStart: 'owner-start' });
beforeEach(() => {
  coord = fs.mkdtempSync(join(tmpdir(), 'resource-pool-'));
  paths = { snapshot: join(coord, 'resource', 'snapshot.json'), fix: join(coord, 'fix'), redTeam: join(coord, 'red-team') };
  for (const path of [join(coord, 'resource'), paths.fix, paths.redTeam]) fs.mkdirSync(path);
  fs.writeFileSync(paths.snapshot, JSON.stringify(snap()));
  env = { LANE_POOL_ROOT: join(coord, 'pools') };
  laneDir = join(env.LANE_POOL_ROOT, 'web-everything', 'lane-1'); fs.mkdirSync(laneDir, { recursive: true });
  guard.checkout = join(coord, 'web-everything'); guard.writes = []; guard.children = [];
});
afterEach(() => { guard.active = false; fs.rmSync(coord, { recursive: true, force: true }); });
const read = (source, options = {}) => readPoolSource(source, { paths, env, nowMs, cwd: coord, readRegistry: () => ({ repos: [{ name: 'web-everything' }] }), namespace: 'local', host: 'studio',
  listCommands: () => `${process.pid} 1 node resource-pool.mjs`, roundBudget: () => ({ live: 2 }),
  laneStatus: () => ({ lanes: [] }), heavyStatus: () => ({ held: [] }), slotAlive: () => true, ...options });
const settingsArgs = () => ({ env: {}, read: () => ({ value: structuredClone(POOL_DEFAULTS), taint: [] }),
  platform: {}, operatorOverride: {}, enumOverride: { ok: false, reason: 'absent' } });
const expectClosed = settings => {
  expect(settings.unknown).toBe(true);
  expect(settings.value.mode).not.toBe('enforce');
  expect(grantDecision({ budget: 30, held: [], class: 4, size: 1,
    classes: settings.value.classes, unknown: settings.unknown })).toMatchObject({ decision: 'hold', unknown: true });
};
it.each(['tool', 'platform', 'env', 'enum'])('enforce in %s is unknown and never grants', layer => {
  const args = settingsArgs();
  if (layer === 'tool') args.read = () => ({ value: { mode: 'enforce' }, taint: [] });
  if (layer === 'platform') { args.read = () => ({ value: {}, taint: [] }); args.platform = { mode: 'enforce' }; }
  if (layer === 'env') args.env.WE_RESOURCE_POOL_MODE = 'enforce';
  if (layer === 'enum') args.enumOverride = { ok: true, value: 'enforce' };
  expectClosed(loadPoolSettings(args));
});
it.each([{}, [], null, 1])('invalid mode %j cannot disappear during flattening', mode => {
  for (const layer of ['tool', 'platform']) {
    const args = settingsArgs();
    if (layer === 'tool') args.read = () => ({ value: { mode }, taint: [] });
    else args.platform = { mode };
    expectClosed(loadPoolSettings(args));
  }
});
it('rejects typo keys and explicit null platform namespace', () => {
  expectClosed(loadPoolSettings({ ...settingsArgs(), platform: { builderFlor: 20 } }));
  const file = join(coord, 'preferences.json'); writeFileSync(file, '{"resourcePool":null}');
  const args = settingsArgs(); delete args.platform;
  expectClosed(loadPoolSettings({ ...args, env: { WE_PLATFORM_PREFERENCES_FILE: file } }));
});
it.each(['tool', 'platform'])('class aliases and invalid bounds cannot be hidden in %s', layer => {
  for (const value of [
    { class: {}, classes: {} }, { class: { 2: { max: -1 } }, classes: {} },
    { class: {}, classes: { 2: { max: 65 } } },
    ...['class', 'classes'].flatMap(key => [null, [], { 2: { reserve: 9, max: 8 } }]
      .map(bounds => ({ [key]: bounds }))),
  ]) {
    const args = settingsArgs();
    if (layer === 'tool') args.read = () => ({ value, taint: [] });
    else args.platform = value;
    expectClosed(loadPoolSettings(args));
  }
});
it('raw platform layers stay unknown when later preferences or tool settings overwrite invalid values', async () => {
  const { LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH, operatorPreferencesPath } = await import('../policy-cascade.mjs');
  const files = new Map();
  const spy = vi.spyOn(await import('node:fs'), 'readFileSync').mockImplementation(path => {
    if (files.has(path)) return JSON.stringify(files.get(path));
    throw Object.assign(Error('absent'), { code: 'ENOENT' });
  });
  try {
    for (const value of [null, [], { mode: {} }, { builderFloor: -1 },
      { class: { 2: { max: 65 } } }, { classes: { 2: { reserve: 9, max: 8 } } },
      { class: {}, classes: {} }]) {
      files.set(LEGACY_PLATFORM_PREFERENCES_PATHS[0], { resourcePool: value });
      files.set(PLATFORM_PREFERENCES_PATH, { resourcePool: POOL_DEFAULTS });
      files.set(operatorPreferencesPath({}), { resourcePool: POOL_DEFAULTS });
      const args = settingsArgs(); delete args.platform;
      expectClosed(loadPoolSettings(args));
    }
  } finally { spy.mockRestore(); }
});
it.each([undefined, null, ''])('active lane without purpose %j and an unknown session fails closed', purpose => {
  expect(read('workers', { laneStatus: () => ({ lanes: [{ path: laneDir, leased: true,
    lease: { ...lease(), session: 'unclassified-1', purpose } }] }) }))
    .toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
});
it.each([{ session: 'builder-1', purpose: 'build' }, { session: 'build-123' },
  { session: 'conveyor-123' }, { session: 'ordinary-1', purpose: 'manual-work' }])(
  'ordinary non-fix lane %j stays empty', identity => {
    expect(read('workers', { laneStatus: () => ({ lanes: [{ path: laneDir, leased: true,
      lease: { ...lease(), ...identity } }] }) })).toMatchObject({ ok: true, holders: [] });
  });
it('duplicate numeric override keys including escaped equivalents invalidate evidence', () => {
  const file = join(coord, 'overrides.json');
  for (const key of ['resourcePool.builderFloor', 'resourcePool.builderFlo\\u006fr']) {
    writeFileSync(file, `{"resourcePool.builderFloor":20,"${key}":0}`);
    expect(() => readPoolOverrides({ file })).toThrow(/duplicate/);
    const args = settingsArgs(); delete args.operatorOverride;
    // Exercise the loader's error path through its checked reader.
    expectClosed(loadPoolSettings({ ...args, overrideFile: file }));
  }
});
it('settings default shadow/floor4; enforce is refused; all sources logged', () => {
  const log = vi.fn(); const result = loadPoolSettings({ ...settingsArgs(), log });
  expect(result.value).toMatchObject({ mode: 'shadow', builderFloor: 4 }); expect(result.unknown).toBe(false);
  expect(log.mock.calls[0][0]).toContain('tool');
  const enforce = loadPoolSettings({ ...settingsArgs(), env: { WE_RESOURCE_POOL_MODE: 'enforce' } });
  expect(enforce).toMatchObject({ configuredMode: 'enforce', unknown: true, error: expect.stringContaining('not yet supported') });
  const overridden = loadPoolSettings({ ...settingsArgs(), operatorOverride: { builderFloor: 6, 'class.3.max': 10 }, enumOverride: { ok: true, value: 'off' } });
  expect(overridden.value).toMatchObject({ mode: 'off', builderFloor: 6, classes: { 3: { max: 10 } } });
  expect(overridden.provenance).toContain('operator-enum-db');
});
it('settings fail closed for unreadable layers, unknown enum and out-of-range/inverted bounds', () => {
  for (const patch of [{ operatorOverride: null }, { enumOverride: { ok: false, reason: 'unreadable' } },
    { enumOverride: { ok: true, value: 'live' } }, { read: () => { throw Error('unreadable'); } },
    { read: () => ({ value: {}, taint: [{ reason: 'malformed' }] }) }, { platform: null },
    { env: { WE_RESOURCE_POOL_MODE: 'live' } }]) expectClosed(loadPoolSettings({ ...settingsArgs(), ...patch }));
  for (const bad of [-1, 65, NaN, 0.1, null, {}, []]) {
    const args = settingsArgs(); args.read = () => ({ value: { builderFloor: bad }, taint: [] });
    expectClosed(loadPoolSettings(args));
    args.read = () => ({ value: { classes: { 2: { max: bad } } }, taint: [] });
    expectClosed(loadPoolSettings(args));
  }
  const args = settingsArgs(); args.read = () => ({ value: { classes: { 2: { reserve: 9, max: 8 } } }, taint: [] });
  expectClosed(loadPoolSettings(args));
});
it('unrelated dotted filenames do not taint pool settings, but unreadable or owning files do', () => {
  const dir = join(coord, 'settings'); mkdirSync(dir); const legacyPath = join(coord, 'legacy.json');
  writeFileSync(join(dir, 'pool.json'), JSON.stringify({ resourcePool: POOL_DEFAULTS }));
  writeFileSync(join(dir, 'other.json'), '{"other":{"file.mjs":true}}');
  expect(readPoolSettingsChecked({ dir, legacyPath }).taint).toEqual([]);
  writeFileSync(join(dir, 'other.json'), '{'); expect(readPoolSettingsChecked({ dir, legacyPath }).taint.length).toBeGreaterThan(0);
  const args = { ...settingsArgs(), read: () => readPoolSettingsChecked({ dir, legacyPath }) };
  expectClosed(loadPoolSettings(args));
  writeFileSync(join(dir, 'other.json'), '{"resourcePool":{"file.mjs":true}}');
  expectClosed(loadPoolSettings(args));
  writeFileSync(join(dir, 'other.json'), '{"resourcePool.mode":"off"}');
  expectClosed(loadPoolSettings(args));
  fs.rmSync(join(dir, 'other.json')); mkdirSync(join(dir, 'other.json'));
  expectClosed(loadPoolSettings(args));
});
it('workers and lane inventory perform zero fs writes and never launch the lane-pool CLI', () => {
  fs.writeFileSync(join(laneDir, '.lane-lease'), JSON.stringify(lease()));
  const pool = join(laneDir, '..'); fs.mkdirSync(join(pool, '.quarantine-state'));
  const sentinels = [join(pool, '.lane-status-cache.json'), join(pool, '.quarantine-state', 'lane-1.json')];
  for (const file of sentinels) fs.writeFileSync(file, 'preserve');
  guard.active = true;
  expect(read('workers', { laneStatus: undefined })).toMatchObject({ ok: true, holders: [{ jobId: 'fix-1' }] });
  expect(readPoolLaneStatus({ env, nowMs, cwd: coord, readRegistry: () => ({ repos: [{ name: 'web-everything' }] }), run: execFileSync, readJson: path => readPoolJson(path).data }).lanes)
    .toMatchObject([{ leased: true }]);
  expect(guard.writes).toEqual([]);
  expect(guard.children).toHaveLength(4);
  expect(guard.children.every(([method, command, args, options]) => method === 'execFileSync' && command === 'git'
    && (args[0] === 'rev-parse' || args[0] === 'config') && options.env.GIT_OPTIONAL_LOCKS === '0')).toBe(true);
  for (const file of sentinels) expect(fs.readFileSync(file, 'utf8')).toBe('preserve');
});
it.each([true, false])('readError is unknown even when leased=%s', leased => {
  expect(read('workers', { laneStatus: () => ({ lanes: [{ path: laneDir, leased,
    lease: leased ? lease() : null, readError: 'EACCES' }] }) })).toMatchObject({ ok: false });
});
it.each(['acquiredAt', 'renewedAt'])('malformed, future and non-ISO %s remain unknown before kind filtering', key => {
  for (const value of [undefined, null, 1000, 'bad', new Date(3000).toISOString(), '1970-01-01', '1969-02-30T00:00:00.000Z']) {
    expect(read('workers', { laneStatus: () => ({ lanes: [{ path: laneDir, leased: false,
      lease: { ...lease(), session: 'builder-1', [key]: value } }] }) })).toMatchObject({ ok: false });
  }
});
it('a non-ENOENT lease read error stays unknown', () => {
  const laneStatus = () => readPoolLaneStatus({ env, nowMs, cwd: coord, readRegistry: () => ({ repos: [{ name: 'web-everything' }] }), run: () => guard.checkout,
    readJson: () => { throw Object.assign(Error('permission denied'), { code: 'EACCES' }); } });
  expect(read('workers', { laneStatus })).toMatchObject({ ok: false, error: expect.stringContaining('permission denied') });
});
it('reads named sources and rejects every unavailable source and unknown names', () => {
  expect(Object.keys(SOURCES).sort()).toEqual(['fix', 'redTeam', 'rounds', 'snapshot', 'workers']);
  expect(Object.keys(poolSourcePaths({ coord, env })).sort()).toEqual(['fix', 'redTeam', 'snapshot']);
  for (const source of Object.keys(SOURCES)) expect(read(source).ok).toBe(true);
  for (const source of ['fix', 'redTeam', 'snapshot']) {
    fs.rmSync(paths[source], { recursive: true, force: true });
    expect(read(source)).toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
    fs.writeFileSync(paths[source], '{'); expect(read(source).ok).toBe(false);
  }
  expect(read('unknown').ok).toBe(false);
  expect(read('workers', { laneStatus: () => { throw Error('unreadable'); } }).ok).toBe(false);
  expect(read('workers', { heavyStatus: () => { throw Error('unreadable'); } }).ok).toBe(false);
});
it('requires complete snapshot evidence and bounds units, pressure, swap and CPU', () => {
  expect(read('snapshot').budget).toMatchObject({ unknown: false, units: 30 });
  for (const patch of [{ freshUntil: new Date(1999).toISOString() }, { sampledAt: new Date(3000).toISOString() },
    { cpu: {} }, { memory: {} }]) {
    fs.writeFileSync(paths.snapshot, JSON.stringify({ ...snap(), ...patch })); expect(read('snapshot').ok).toBe(false);
  }
  for (const patch of [{ pressureLevel: 2 }, { swapUsedPct: 80 }, { swapGrowthMb: 40000 }]) {
    fs.writeFileSync(paths.snapshot, JSON.stringify({ ...snap(), memory: { ...snap().memory, ...patch } }));
    expect(read('snapshot').budget.units).toBe(0);
  }
  fs.writeFileSync(paths.snapshot, JSON.stringify({ ...snap(), cpu: { idlePct: 14 } }));
  expect(read('snapshot').budget.units).toBe(0);
});
it('refuses oversized source files and unknown or oversized round inventories with a manual fallback', () => {
  fs.writeFileSync(paths.snapshot, ' '.repeat(16 * 1024 * 1024 + 1));
  expect(read('snapshot')).toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
  for (const output of ['', 'invalid', '123 1 node other.mjs'])
    expect(read('rounds', { listCommands: () => output }).ok).toBe(false);
  for (const live of [undefined, -1, 20001]) expect(read('rounds', { roundBudget: () => ({ live }) }).ok).toBe(false);
  expect(read('rounds').holders).toHaveLength(2);
  expect(read('rounds', { roundBudget: () => ({ live: 0 }) })).toMatchObject({ ok: true, holders: [] });
});
it('counts fixes and ci-heals, deduplicates heavy slots by lane and refuses unknown holders', () => {
  const row = { path: laneDir, leased: true, lease: lease() };
  const heavy = { owner: `${laneDir}#123`, meta: { dispatchKind: 'fix', session: 'fix-1' } };
  expect(read('workers', { laneStatus: () => ({ lanes: [row] }), heavyStatus: () => ({ held: [heavy] }) }))
    .toMatchObject({ ok: true, holders: [{ class: 3, size: 2, jobId: 'fix-1' }] });
  expect(read('workers', { heavyStatus: () => ({ held: [{ ...heavy, meta: { dispatchKind: 'ci-heal' } }] }) }).holders).toHaveLength(1);
  for (const held of [[{}], [{ meta: { dispatchKind: 'fix' } }], null])
    expect(read('workers', { heavyStatus: () => ({ held }) }).ok).toBe(false);
  expect(read('workers', { laneStatus: () => ({ lanes: Array(20001).fill(row) }) })).toMatchObject({ ok: false });
});
it('validates fix heartbeat before expiry, counts live ci-heals and expires only beyond TTL', () => {
  const dir = join(paths.fix, 'a'.repeat(16)); fs.mkdirSync(dir); const file = join(dir, 'lock.json');
  for (const heartbeatAt of ['bad', 1, new Date(nowMs + 1).toISOString()]) {
    fs.writeFileSync(file, JSON.stringify({ heartbeatAt })); expect(read('fix').ok).toBe(false);
  }
  const claim = { owner: 'fixer', heartbeatAt: new Date(nowMs - 600000).toISOString(), meta: { repo: 'we', pr: 1, kind: 'ci-heal' } };
  fs.writeFileSync(file, JSON.stringify(claim)); expect(read('fix').holders).toMatchObject([{ class: 3, size: 2 }]);
  expect(read('fix', { nowMs: nowMs + 1 })).toMatchObject({ ok: true, holders: [] });
  fs.writeFileSync(file, JSON.stringify({ ...claim, meta: {} })); expect(read('fix').ok).toBe(false);
  expect(read('fix', { nowMs: nowMs + 1 }).ok).toBe(true);
});
it('red-team companions are ignored, active rows require known liveness and explicit finished rows do not', () => {
  const file = join(paths.redTeam, filename);
  fs.writeFileSync(join(paths.redTeam, `${filename}.attempt.json`), '{');
  fs.writeFileSync(file, JSON.stringify(status()));
  expect(read('redTeam')).toMatchObject({ ok: true, holders: [{ class: 2, size: 1 }] });
  expect(read('redTeam', { slotAlive: () => false }).holders).toEqual([]);
  expect(read('redTeam', { slotAlive: () => null }).ok).toBe(false);
  for (const patch of [{ status: 'queued', pid: null }, { status: 'ended' }, { pid: '123' }, { repo: 'wrong' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...status(), ...patch })); expect(read('redTeam').ok).toBe(false);
  }
  fs.writeFileSync(file, JSON.stringify({ ...status(), status: 'finished' }));
  expect(read('redTeam', { slotAlive: () => { throw Error('must not probe'); } }).ok).toBe(true);
});
it('expires red-team leases strictly after 24h but never excuses unreadable evidence', () => {
  const clock = 200000000, file = join(paths.redTeam, filename);
  fs.writeFileSync(file, JSON.stringify(status()));
  fs.utimesSync(file, new Date(clock - RED_TEAM_HARD_LEASE_CEILING_MS), new Date(clock - RED_TEAM_HARD_LEASE_CEILING_MS));
  expect(read('redTeam', { nowMs: clock }).holders).toHaveLength(1);
  expect(read('redTeam', { nowMs: clock + 1, slotAlive: () => { throw Error('must not probe'); } }))
    .toMatchObject({ ok: true, holders: [], expiredRedTeamRows: 1 });
  fs.writeFileSync(file, '{'); expect(read('redTeam', { nowMs: clock + 1 }).ok).toBe(false);
});
it('counts an expired red-team lease before consulting slot liveness', () => {
  const clock = 200000000, file = join(paths.redTeam, filename);
  fs.writeFileSync(file, JSON.stringify(status()));
  const statusAt = clock - RED_TEAM_HARD_LEASE_CEILING_MS - 1;
  fs.utimesSync(file, new Date(statusAt), new Date(statusAt));
  const slotAlive = vi.fn(() => { throw Error('expired lease must not probe'); });
  expect(read('redTeam', { nowMs: clock, slotAlive }))
    .toMatchObject({ ok: true, holders: [], expiredRedTeamRows: 1 });
  expect(slotAlive).not.toHaveBeenCalled();
});
it('foreign hosts and unknown local probes stay unknown; only ESRCH proves death', () => {
  const file = join(paths.redTeam, filename);
  fs.writeFileSync(file, JSON.stringify({ ...status(), host: 'foreign' }));
  expect(read('redTeam', { slotAlive: undefined }).ok).toBe(false);
  fs.writeFileSync(file, JSON.stringify(status()));
  expect(read('redTeam', { slotAlive: undefined, processAlive: () => null }).ok).toBe(false);
  for (const [code, expected] of [['ESRCH', false], ['EPERM', true], ['EIO', null]])
    expect(poolPidAlive(123, () => { throw Object.assign(Error(), { code }); })).toBe(expected);
  expect(poolPidAlive(123, () => {})).toBe(true); expect(poolPidAlive(0)).toBe(null);
});
it('checks heavy lock JSON directly instead of accepting a tolerant empty status', () => {
  const root = join(coord, 'heavy'), dir = lockDirFor(root, 'slot-0'); fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, 'lock.json');
  for (const text of ['{', '{}']) { fs.writeFileSync(file, text); expect(() => readPoolHeavyHeld({ root, cap: 1 })).toThrow(); }
  const row = { owner: 'lane#123', heartbeatAt: new Date(nowMs).toISOString(), meta: { dispatchKind: 'fix' } };
  fs.writeFileSync(file, JSON.stringify(row)); expect(readPoolHeavyHeld({ root, cap: 1 })).toEqual({ held: [row] });
  expect(() => readPoolHeavyHeld({ root, cap: 20001 })).toThrow(/inspect/);
});
it('bounded JSON reads reject nonobjects, nonfiles and growth after fstat, and close descriptors', () => {
  for (const text of ['[]', 'null', '{']) { fs.writeFileSync(paths.snapshot, text); expect(() => readPoolJson(paths.snapshot)).toThrow(); }
  expect(() => readPoolJson(paths.fix)).toThrow();
  const closeSync = vi.fn(), io = { openSync: () => 1, fstatSync: () => ({ isFile: () => true, size: 1 }),
    readSync: () => 2, closeSync };
  expect(() => readPoolJson('virtual', { io })).toThrow(/grew/); expect(closeSync).toHaveBeenCalledWith(1);
});
it('rejects future, over-age and overlong snapshot evidence with an inspect-and-rerun fallback', () => {
  const clock = Date.parse('2026-11-23T12:00:00Z'), window = 5 * 60 * 1000;
  for (const [sample, until] of [[clock + 1, clock + window], [clock - window - 1, clock + 1],
    [clock, clock + window + 1], [Date.parse('2000-01-01'), Date.parse('2099-01-01')]]) {
    fs.writeFileSync(paths.snapshot, JSON.stringify({ ...snap(), sampledAt: new Date(sample).toISOString(),
      freshUntil: new Date(until).toISOString() }));
    expect(read('snapshot', { nowMs: clock })).toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
  }
  fs.writeFileSync(paths.snapshot, JSON.stringify({ ...snap(), sampledAt: new Date(clock - window).toISOString(),
    freshUntil: new Date(clock).toISOString() }));
  expect(read('snapshot', { nowMs: clock })).toMatchObject({ ok: true, budget: { unknown: false } });
});
it('scans scaled heavy slots beyond cap plus fastSlots using admission settings', () => {
  const root = join(coord, 'heavy'), dir = lockDirFor(root, 'slot-4'); fs.mkdirSync(dir, { recursive: true });
  const preferences = join(coord, 'preferences.json');
  fs.writeFileSync(preferences, JSON.stringify({ heavyAdmission: { cap: 2, fastSlots: 1, fastScale: { maxSlots: 3 } } }));
  const row = { owner: 'lane#123', heartbeatAt: new Date(nowMs).toISOString(), meta: { dispatchKind: 'fix' } };
  fs.writeFileSync(join(dir, 'lock.json'), JSON.stringify(row));
  expect(readPoolHeavyHeld({ root, env: { ...env, WE_PLATFORM_PREFERENCES: preferences } })).toEqual({ held: [row] });
  fs.writeFileSync(join(dir, 'lock.json'), '{}');
  expect(read('workers', { heavyStatus: () => readPoolHeavyHeld({ root,
    env: { ...env, WE_PLATFORM_PREFERENCES: preferences } }) })).toMatchObject({ ok: false });
});
it('missing heavy root is unknown while missing individual slots in an existing root are empty', () => {
  const root = join(coord, 'missing-heavy'), heavyStatus = () => readPoolHeavyHeld({ root, cap: 2 });
  expect(() => heavyStatus()).toThrow();
  expect(read('workers', { heavyStatus })).toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
  fs.mkdirSync(root);
  expect(read('workers', { heavyStatus })).toMatchObject({ ok: true, holders: [] });
});
it.each([undefined, null, '', 'unknown', 'fix-1', 3])('unknown heavy dispatchKind %s fails closed', dispatchKind => {
  expect(read('workers', { heavyStatus: () => ({ held: [{ owner: laneDir, meta: { dispatchKind } }] }) }))
    .toMatchObject({ ok: false, error: expect.stringContaining('unknown heavy holder identity') });
});
it.each(['build', 'review', 'prepare', 'prepare-scope', 'prepare-decision', 'prepare-item', 'investigate'])(
  'known non-fix heavy dispatchKind %s is empty', dispatchKind => {
    expect(read('workers', { heavyStatus: () => ({ held: [{ meta: { dispatchKind } }] }) }))
      .toMatchObject({ ok: true, holders: [] });
  });
it.each([undefined, null, '', ' ', 123, false, {}, []])('malformed red-team pidStart %j is unknown before probing', pidStart => {
  fs.writeFileSync(join(paths.redTeam, filename), JSON.stringify({ ...status(), pidStart }));
  const slotAlive = vi.fn(() => false);
  expect(read('redTeam', { slotAlive })).toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
  expect(slotAlive).not.toHaveBeenCalled();
});
it.each([undefined, null, 0, -1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1])('malformed red-team pid %s is unknown before probing', pid => {
  fs.writeFileSync(join(paths.redTeam, filename), JSON.stringify({ ...status(), pid }));
  const slotAlive = vi.fn(() => false);
  expect(read('redTeam', { slotAlive })).toMatchObject({ ok: false });
  expect(slotAlive).not.toHaveBeenCalled();
});
it('valid red-team identity delegates to the real probe for live, replaced and dead processes', () => {
  fs.writeFileSync(join(paths.redTeam, filename), JSON.stringify(status()));
  expect(read('redTeam', { slotAlive: undefined, processAlive: () => true, readStart: () => 'owner-start' }))
    .toMatchObject({ ok: true, holders: [{ kind: 'redTeam' }] });
  for (const options of [{ processAlive: () => false }, { processAlive: () => true, readStart: () => 'replacement' }])
    expect(read('redTeam', { slotAlive: undefined, ...options })).toMatchObject({ ok: true, holders: [] });
});

it('an over-24h live red-team holder is counted and a foreign-host holder makes inventory unknown', () => {
  const clock = 200000000, file = join(paths.redTeam, filename);
  const put = patch => {
    fs.writeFileSync(file, JSON.stringify({ ...status(), ...patch }));
    fs.utimesSync(file, new Date(0), new Date(0));
  };
  put({ host: 'studio', pidNamespace: 'local' });
  const probe = { nowMs: clock, slotAlive: undefined, processAlive: () => true, readStart: () => 'owner-start' };
  expect(read('redTeam', probe)).toMatchObject({ ok: true, holders: [{ kind: 'redTeam' }], expiredRedTeamRows: 0 });
  put({ host: 'foreign' });
  expect(read('redTeam', probe)).toMatchObject({ ok: false, error: expect.stringContaining('unknown red-team liveness') });
});
it('old red-team rows require proven death; unreadable liveness refuses and pid reuse never counts the replacement', () => {
  const file = join(paths.redTeam, filename); fs.writeFileSync(file, JSON.stringify(status()));
  fs.utimesSync(file, new Date(0), new Date(0));
  const probe = { nowMs: 200000000, slotAlive: undefined, processAlive: () => true };
  for (const readStart of [() => null, () => { throw Error('unreadable process'); }])
    expect(read('redTeam', { ...probe, readStart })).toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
  for (const patch of [{ processAlive: () => false }, { readStart: () => 'replacement' }])
    expect(read('redTeam', { ...probe, ...patch })).toMatchObject({ ok: true, holders: [], expiredRedTeamRows: 1 });
});
it('escaped duplicate key rejects in source JSON before last-wins parsing can erase evidence', () => {
  for (const text of ['{"cpu":{},"c\\u0070u":{}}', '{"outer":{"pid":123,"p\\u0069d":456}}']) {
    fs.writeFileSync(paths.snapshot, text);
    expect(() => readPoolJson(paths.snapshot)).toThrow(/duplicate/);
  }
  fs.writeFileSync(paths.snapshot, '{"left":{"pid":1},"right":{"pid":2},"text":"{\\\"pid\\\":3}"}');
  expect(readPoolJson(paths.snapshot).data).toMatchObject({ left: { pid: 1 }, right: { pid: 2 } });
});
it('per-source dedupe retains independent fix-claim and worker evidence for the same job', () => {
  const dir = join(paths.fix, 'b'.repeat(16)); fs.mkdirSync(dir);
  const claim = { owner: 'fixer', heartbeatAt: new Date(nowMs).toISOString(), meta: { repo: 'we', pr: 12, kind: 'fix' } };
  fs.writeFileSync(join(dir, 'lock.json'), JSON.stringify(claim));
  const fix = read('fix'); const session = fix.holders[0].jobId;
  const row = { owner: `${laneDir}#1`, meta: { dispatchKind: 'fix', session } };
  const workers = read('workers', { heavyStatus: () => ({ held: [row, row] }) });
  expect(workers.holders).toHaveLength(1);
  expect(fix.holders).toHaveLength(1);
  expect(workers.holders[0].jobId).toBe(session);
  expect(summarize([...fix.holders, ...workers.holders])['studio.units'].held).toBe(4);
});

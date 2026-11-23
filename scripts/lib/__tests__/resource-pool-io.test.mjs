// @vitest-environment node
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readPoolSource, collectResourcePool, loadPoolSettings, appendShadowRows, poolPidAlive,
  RED_TEAM_HARD_LEASE_CEILING_MS, poolSourcePaths, readPoolSettingsChecked, readPoolJson, readPoolOverrides, readPoolHeavyHeld, SOURCES } from '../resource-pool-io.mjs';
import { lockDirFor } from '../../readiness/file-locks.mjs';
import { POOL_DEFAULTS } from '../resource-pool.mjs';
import { resourcePoolOperation } from '../../operations/resource-pool.mjs';
import { createRegistry } from '../../operations/registry.mjs';
import { handleOperationRequest } from '../../operations/http-adapter.mjs';
let coord, paths;
const nowMs = 2000;
const snap = () => ({ sampledAt: new Date(1000).toISOString(), freshUntil: new Date(3000).toISOString(),
  memory: { availableMb: 40000, floorMb: 4000, swapUsedPct: 10, swapGrowthMb: 0, pressureLevel: 1 }, cpu: { idlePct: 40 } });
const head = 'a'.repeat(40);
const filename = `web-everything%2Ffrontierui-12-${head}.json`;
const status = () => ({ repo: 'web-everything/frontierui', pr: 12, head, status: 'running', pid: 123 });
const settingsArgs = () => ({ env: {}, read: () => ({ value: structuredClone(POOL_DEFAULTS), taint: [] }),
  platform: {}, operatorOverride: {}, enumOverride: { ok: false, reason: 'absent' } });
const settings = () => loadPoolSettings(settingsArgs());
const legacy = () => ({ verdict: 'admit', unknown: false });
beforeEach(() => {
  coord = mkdtempSync(join(tmpdir(), 'resource-pool-'));
  paths = { snapshot: join(coord, 'resource', 'snapshot.json'), fix: join(coord, 'fix'), redTeam: join(coord, 'red-team') };
  mkdirSync(join(coord, 'resource')); mkdirSync(paths.fix); mkdirSync(paths.redTeam);
  writeFileSync(paths.snapshot, JSON.stringify(snap()));
});
afterEach(() => rmSync(coord, { recursive: true, force: true }));
const read = (source, options = {}) => readPoolSource(source, { paths, coord, nowMs,
  listCommands: () => `${process.pid} 1 node resource-pool.mjs`,
  laneStatus: () => ({ lanes: [] }), heavyStatus: () => ({ held: [] }),
  roundBudget: () => ({ live: 2 }), slotAlive: () => true, ...options });
const collect = (options = {}) => collectResourcePool({ paths, coord, nowMs, settings: settings(), readSource: read, legacy, ...options });
it('reads ONLY the named S1a sources, counts C2/C3, names paths, and never claims shrink', () => {
  writeFileSync(join(paths.redTeam, filename), JSON.stringify(status()));
  const lockDir = join(paths.fix, 'a'.repeat(16)); mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'lock.json'), JSON.stringify({ owner: 'fixer', heartbeatAt: new Date(1000).toISOString(),
    meta: { repo: 'we', pr: 1, kind: 'fix' } }));
  const report = collect();
  expect(report.unknown).toBe(false);
  expect(report.holders.map(h => h.class)).toEqual([2, 2, 2, 3]);
  expect(report.digest).toBe('pool studio 5/30u · C2 3 C3 2 (floor 4)');
  expect(report.sources.map(s => s.source)).toEqual(Object.keys(SOURCES));
  expect(report.sources.every(s => s.description && s.path)).toBe(true);
  expect(report.shrink).toBe(null);
  expect(Object.keys(poolSourcePaths({ coord, env: {} })).sort()).toEqual(['fix', 'redTeam', 'snapshot']);
  expect(report.rows.every(r => r.legacyDecision === 'grant' && r.legacySource.includes('dispatch caps excluded'))).toBe(true);
});
it.each(['fix', 'redTeam', 'snapshot'])('missing or unreadable %s holds the whole resource with no shrink', source => {
  rmSync(paths[source], { recursive: true, force: true });
  for (const unreadable of [false, true]) {
    if (unreadable) writeFileSync(paths[source], 'wrong type');
    const report = collect();
    expect(report.unknown).toBe(true); expect(report.shrink).toBe(null);
    expect(report.rows.every(r => r.poolDecision === 'hold')).toBe(true);
    expect(report.sources.find(s => s.source === source)).toMatchObject({ ok: false });
    expect(report.digest).toContain('?/?');
  }
});
it('malformed holder files, unknown round probe and unknown liveness all hold', () => {
  writeFileSync(join(paths.redTeam, filename), '{');
  expect(collect().unknown).toBe(true);
  writeFileSync(join(paths.redTeam, filename), JSON.stringify(status()));
  expect(read('redTeam', { slotAlive: () => null }).ok).toBe(false);
  expect(read('redTeam', { slotAlive: () => { throw Error('probe failed'); } }).ok).toBe(false);
  expect(read('rounds', { roundBudget: () => ({ reason: 'ps failed' }) }).ok).toBe(false);
  expect(read('rounds', { roundBudget: () => { throw Error('ps failed'); } }).ok).toBe(false);
  expect(read('unknown').ok).toBe(false);
});
it('ignores nonholder companion files before parsing, including Frontier UI review companions', () => {
  writeFileSync(join(paths.redTeam, filename), JSON.stringify(status()));
  for (const name of ['review-12.frontierui.json', `${filename}.attempt.json`, `${filename}.unpublished`, 'attempt-metadata.json'])
    writeFileSync(join(paths.redTeam, name), 'not holder JSON');
  expect(read('redTeam')).toMatchObject({ ok: true, holders: [{ kind: 'redTeam' }] });
});
it('only confirmed dead red-team slots and explicit finished statuses are omitted', () => {
  writeFileSync(join(paths.redTeam, filename), JSON.stringify(status()));
  expect(read('redTeam', { slotAlive: () => false }).holders).toEqual([]);
  writeFileSync(join(paths.redTeam, filename), JSON.stringify({ ...status(), status: 'finished' }));
  expect(read('redTeam', { slotAlive: () => { throw Error('must not probe'); } }).ok).toBe(true);
  writeFileSync(join(paths.redTeam, filename), JSON.stringify({ ...status(), status: 'ended' }));
  expect(read('redTeam').ok).toBe(false);
});
it('validates fix heartbeat before expiry; excludes expired fixes and counts live ci-heal', () => {
  const lockDir = join(paths.fix, 'b'.repeat(16)); mkdirSync(lockDir);
  const file = join(lockDir, 'lock.json');
  for (const data of [{}, { owner: 'x', heartbeatAt: 'bad' }, { owner: 'x', heartbeatAt: new Date(1000).toISOString() }]) {
    writeFileSync(file, JSON.stringify(data)); expect(read('fix').ok).toBe(false);
  }
  const claim = { owner: 'x', heartbeatAt: new Date(-700000).toISOString(), meta: { repo: 'we', pr: 1, kind: 'fix' } };
  writeFileSync(file, JSON.stringify(claim)); expect(read('fix').holders).toEqual([]);
  writeFileSync(file, JSON.stringify({ ...claim, heartbeatAt: new Date(1000).toISOString(), meta: { ...claim.meta, kind: 'ci-heal' } }));
  expect(read('fix').holders).toHaveLength(1);
});
it.each([{ repo: 'we', pr: 1 }, { repo: 'we', pr: 1, kind: 'fixing' }, { kind: 'ci-heal', pr: 'old' }, null])(
  'ignores expired claims with legacy or malformed metadata %j, but holds fresh ones', meta => {
    const lockDir = join(paths.fix, 'c'.repeat(16)); mkdirSync(lockDir);
    const file = join(lockDir, 'lock.json');
    for (const age of [600001, 600000, 0]) {
      writeFileSync(file, JSON.stringify({ owner: 'fixer', heartbeatAt: new Date(nowMs - age).toISOString(), meta }));
      expect(read('fix')).toMatchObject(age > 600000 ? { ok: true, holders: [] } : { ok: false });
    }
  });
it('a proven expired heartbeat excludes a claim even when the owner is missing', () => {
  const lockDir = join(paths.fix, 'f'.repeat(16)); mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'lock.json'), JSON.stringify({ heartbeatAt: new Date(nowMs - 600001).toISOString() }));
  expect(read('fix')).toMatchObject({ ok: true, holders: [] });
});
it('counts a valid fix at the TTL boundary and expires it only after the boundary', () => {
  const lockDir = join(paths.fix, 'd'.repeat(16)); mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'lock.json'), JSON.stringify({ owner: 'fixer',
    heartbeatAt: new Date(nowMs - 600000).toISOString(), meta: { repo: 'we', pr: 1, kind: 'fix' } }));
  expect(read('fix').holders).toHaveLength(1);
  expect(read('fix', { nowMs: nowMs + 1 })).toMatchObject({ ok: true, holders: [] });
});
it('unreadable claims and invalid heartbeats fail closed even with an old file mtime', () => {
  const lockDir = join(paths.fix, 'e'.repeat(16)); mkdirSync(lockDir);
  const file = join(lockDir, 'lock.json');
  for (const data of ['{', JSON.stringify({ heartbeatAt: 'bad' }), JSON.stringify({ heartbeatAt: 1 }),
    JSON.stringify({ heartbeatAt: new Date(nowMs + 1).toISOString() })]) {
    writeFileSync(file, data); utimesSync(file, new Date(1), new Date(1));
    expect(read('fix')).toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
  }
  rmSync(file); mkdirSync(file);
  expect(read('fix').ok).toBe(false);
});
it('queued pidless rows are unknown and queued live pids occupy capacity', () => {
  writeFileSync(join(paths.redTeam, filename), JSON.stringify({ ...status(), status: 'queued' }));
  expect(read('redTeam')).toMatchObject({ ok: true, holders: [{ kind: 'redTeam' }] });
  writeFileSync(join(paths.redTeam, filename), JSON.stringify({ ...status(), status: 'queued', pid: null }));
  expect(read('redTeam').ok).toBe(false);
});
const writeRunningAt = (row, at) => {
  const file = join(paths.redTeam, filename); writeFileSync(file, JSON.stringify(row));
  utimesSync(file, new Date(at), new Date(at));
};
const liveNow = 10_000_000;
const localProbe = (extra = {}) => ({ nowMs: liveNow, env: {}, slotAlive: undefined,
  host: 'studio', namespace: 'local', processAlive: () => false, readStart: () => 'birth', ...extra });
it.each([
  { pid: undefined }, { host: 'Mac' }, { host: 'Mac', pid: undefined }, {},
])('ignores a 25h-old running lease regardless of pid or host %j and counts expiry', row => {
  const clock = 200_000_000;
  writeRunningAt({ ...status(), ...row }, clock - 25 * 60 * 60 * 1000);
  const slotAlive = vi.fn(() => { throw Error('expired lease must not be probed'); });
  expect(read('redTeam', { nowMs: clock, slotAlive })).toMatchObject({ ok: true, holders: [], expiredRedTeamRows: 1 });
  expect(slotAlive).not.toHaveBeenCalled();
});
it('keeps a 1h-old foreign-host running lease unknown', () => {
  writeRunningAt({ ...status(), host: 'Mac' }, liveNow - 60 * 60 * 1000);
  expect(read('redTeam', localProbe())).toMatchObject({ ok: false, error: expect.stringContaining('unknown red-team liveness') });
});
it('counts a 1h-old live local pid as a holder', () => {
  writeRunningAt(status(), liveNow - 60 * 60 * 1000);
  expect(read('redTeam', localProbe({ processAlive: () => true }))).toMatchObject({
    ok: true, holders: [{ kind: 'redTeam' }], expiredRedTeamRows: 0,
  });
});
it('expires only strictly beyond the 24h hard lease ceiling, even with a live pid', () => {
  const clock = 200_000_000;
  expect(RED_TEAM_HARD_LEASE_CEILING_MS).toBe(24 * 60 * 60 * 1000);
  writeRunningAt(status(), clock - RED_TEAM_HARD_LEASE_CEILING_MS);
  expect(read('redTeam', { nowMs: clock })).toMatchObject({ ok: true, holders: [{ kind: 'redTeam' }], expiredRedTeamRows: 0 });
  expect(read('redTeam', { nowMs: clock + 1 })).toMatchObject({ ok: true, holders: [], expiredRedTeamRows: 1 });
});
it('pidless running rows within the hard lease ceiling remain unknown', () => {
  for (const age of [1800001, 1800000, 1000, -1000]) {
    writeRunningAt({ ...status(), pid: undefined }, liveNow - age);
    expect(read('redTeam', localProbe())).toMatchObject({ ok: false });
  }
});
it.each([0, -1, '123', {}])('malformed running pid %j is unknown even on an old row', pid => {
  writeRunningAt({ ...status(), pid }, 1);
  expect(read('redTeam', localProbe()).ok).toBe(false);
});
it('foreign-host rows without namespace never infer death from local pid absence or reuse', () => {
  writeRunningAt({ ...status(), host: 'Mac', pidStart: 'old' }, liveNow - 1800001);
  expect(read('redTeam', localProbe())).toMatchObject({ ok: false });
  expect(read('redTeam', localProbe({ processAlive: () => true }))).toMatchObject({ ok: false });
});
it('fresh foreign hosts, foreign namespaces, live owners and unreadable probes remain unknown', () => {
  for (const [row, age, io] of [
    [{ host: 'Mac' }, 1000, {}],
    [{ host: 'Mac', pidNamespace: 'remote' }, 1800001, {}],
    [{ host: 'Mac', pidStart: 'birth' }, 1800001, { processAlive: () => true }],
    [{ host: 'Mac', pidStart: 'birth' }, 1800001, { processAlive: () => true, readStart: () => null }],
    [{ host: 'Mac' }, 1800001, { processAlive: () => null }],
    [{}, 1000, { processAlive: () => { throw Error('EIO'); } }],
    [{ pidStart: 'birth' }, 1000, { processAlive: () => true, readStart: () => null }],
  ]) {
    writeRunningAt({ ...status(), ...row }, liveNow - age);
    expect(read('redTeam', localProbe(io))).toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
  }
});
it('stale local running rows with live pid evidence still hold a slot', () => {
  writeRunningAt(status(), 1);
  expect(read('redTeam', localProbe({ processAlive: () => true }))).toMatchObject({ ok: true, holders: [{ kind: 'redTeam' }] });
});
it('an old mtime cannot excuse unreadable red-team JSON or an unknown local process probe', () => {
  const file = join(paths.redTeam, filename);
  writeFileSync(file, '{'); utimesSync(file, new Date(1), new Date(1));
  expect(read('redTeam', localProbe()).ok).toBe(false);
  writeRunningAt(status(), 1);
  expect(read('redTeam', localProbe({ processAlive: () => null })).ok).toBe(false);
});
it('rejects oversized files and round counts with an operator-visible manual fallback', () => {
  writeFileSync(paths.snapshot, ' '.repeat(16 * 1024 * 1024 + 1));
  expect(read('snapshot')).toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
  expect(read('rounds', { roundBudget: () => ({ live: 20001 }) })).toMatchObject({ ok: false, error: expect.stringContaining('manually') });
});
it('unknown or malformed reader results never grant', () => {
  for (const result of [undefined, { source: 'fix', ok: true, holders: [] }, { source: 'snapshot', ok: true, holders: [{}] }]) {
    const report = collect({ readSource: () => result });
    expect(report.unknown).toBe(true); expect(report.rows.every(r => r.poolDecision === 'hold')).toBe(true);
  }
});
it('only ESRCH proves death; unexpected process errors remain unknown', () => {
  expect(poolPidAlive(123, () => {})).toBe(true);
  for (const [code, expected] of [['ESRCH', false], ['EPERM', true], ['EIO', null]])
    expect(poolPidAlive(123, () => { throw Object.assign(Error(), { code }); })).toBe(expected);
  expect(poolPidAlive(0)).toBe(null);
});
it('settings default shadow/floor4; enforce is refused, off suppresses logging; all sources logged', () => {
  const log = vi.fn(); const result = loadPoolSettings({ ...settingsArgs(), log });
  expect(result.value).toMatchObject({ mode: 'shadow', builderFloor: 4 }); expect(result.unknown).toBe(false);
  expect(log.mock.calls[0][0]).toContain('tool');
  const enforce = loadPoolSettings({ ...settingsArgs(), env: { WE_RESOURCE_POOL_MODE: 'enforce' } });
  expect(enforce).toMatchObject({ configuredMode: 'enforce', unknown: true, error: expect.stringContaining('not yet supported') });
  const overridden = loadPoolSettings({ ...settingsArgs(), operatorOverride: { builderFloor: 6, 'class.3.max': 10 }, enumOverride: { ok: true, value: 'off' } });
  expect(overridden.value).toMatchObject({ mode: 'off', builderFloor: 6, classes: { 3: { max: 10 } } });
  expect(overridden.provenance).toContain('operator-enum-db');
  const append = vi.fn(); expect(appendShadowRows([], { coord, mode: 'off', append })).toBe(false); expect(append).not.toHaveBeenCalled();
});
it('settings fail closed for unreadable layers, unknown enum and out-of-range/inverted bounds', () => {
  for (const patch of [{ operatorOverride: null }, { enumOverride: { ok: false, reason: 'unreadable' } },
    { enumOverride: { ok: true, value: 'live' } }, { read: () => { throw Error('unreadable'); } },
    { read: () => ({ value: {}, taint: [{ reason: 'malformed' }] }) }, { platform: null },
    { env: { WE_RESOURCE_POOL_MODE: 'live' } }]) expect(loadPoolSettings({ ...settingsArgs(), ...patch }).unknown).toBe(true);
  for (const bad of [-1, 65, NaN, 0.1, null, {}, []]) {
    const args = settingsArgs(); args.read = () => ({ value: { builderFloor: bad }, taint: [] });
    expect(loadPoolSettings(args).unknown).toBe(true);
    args.read = () => ({ value: { classes: { 2: { max: bad } } }, taint: [] });
    expect(loadPoolSettings(args).unknown).toBe(true);
  }
  const args = settingsArgs(); args.read = () => ({ value: { classes: { 2: { reserve: 9, max: 8 } } }, taint: [] });
  expect(loadPoolSettings(args).unknown).toBe(true);
});
it('unrelated dotted filenames do not taint pool settings, but unreadable or owning files do', () => {
  const dir = join(coord, 'settings'); mkdirSync(dir); const legacyPath = join(coord, 'legacy.json');
  writeFileSync(join(dir, 'pool.json'), JSON.stringify({ resourcePool: POOL_DEFAULTS }));
  writeFileSync(join(dir, 'other.json'), '{"other":{"file.mjs":true}}');
  expect(readPoolSettingsChecked({ dir, legacyPath }).taint).toEqual([]);
  writeFileSync(join(dir, 'other.json'), '{'); expect(readPoolSettingsChecked({ dir, legacyPath }).taint.length).toBeGreaterThan(0);
});
it('collecting is read-only; only the explicit sink appends shadow evidence', () => {
  const report = collect(); expect(() => readFileSync(join(coord, 'resource', 'pool-shadow.jsonl'))).toThrow();
  const append = vi.fn(); expect(appendShadowRows(report.rows, { coord, append })).toBe(true);
  expect(append).toHaveBeenCalledTimes(3);
  expect(append.mock.calls[0][0]).toBe(join(coord, 'resource', 'pool-shadow.jsonl'));
  expect(appendShadowRows(report.rows, { coord, append: () => { throw Error('disk'); } })).toBe(false);
});

it.each([{}, [], null, 1])('invalid mode %j cannot disappear during flattening', mode => {
  for (const layer of ['tool', 'platform']) {
    const args = settingsArgs();
    if (layer === 'tool') args.read = () => ({ value: { mode }, taint: [] });
    else args.platform = { mode };
    expect(loadPoolSettings(args).unknown).toBe(true);
  }
});
it('rejects typo keys and explicit null platform namespace', () => {
  expect(loadPoolSettings({ ...settingsArgs(), platform: { builderFlor: 20 } }).unknown).toBe(true);
  const file = join(coord, 'preferences.json'); writeFileSync(file, '{"resourcePool":null}');
  const args = settingsArgs(); delete args.platform;
  expect(loadPoolSettings({ ...args, env: { WE_PLATFORM_PREFERENCES_FILE: file } }).unknown).toBe(true);
});
it('duplicate numeric override keys including escaped equivalents invalidate evidence', () => {
  const file = join(coord, 'overrides.json');
  for (const key of ['resourcePool.builderFloor', 'resourcePool.builderFlo\\u006fr']) {
    writeFileSync(file, `{"resourcePool.builderFloor":20,"${key}":0}`);
    expect(() => readPoolOverrides({ file })).toThrow(/duplicate/);
    const args = settingsArgs(); delete args.operatorOverride;
    // Exercise the loader's error path through its checked reader.
    expect(loadPoolSettings({ ...args, overrideFile: file }).unknown).toBe(true);
  }
});
it.each(['', 'unrecognized', '123 1 node other.mjs'])('incomplete ps inventory %j cannot prove zero rounds', output => {
  expect(read('rounds', { listCommands: () => output, roundBudget: () => ({ live: 0 }) }).ok).toBe(false);
});
it('complete ps inventory is passed unchanged to the review parser and permits observed zero', () => {
  const inventory = `${process.pid} 1 node resource-pool.mjs`;
  const roundBudget = vi.fn(({ listCommands }) => ({ live: listCommands() === inventory ? 0 : undefined }));
  expect(read('rounds', { listCommands: () => inventory, roundBudget })).toMatchObject({ ok: true, holders: [] });
});
it('compute-only GET reads lease files without launching mutable status or changing cache/quarantine', async () => {
  const pool = join(coord, 'pools', 'web-everything'), dir = join(pool, 'lane-1');
  mkdirSync(dir, { recursive: true }); mkdirSync(join(pool, '.quarantine-state'));
  writeFileSync(join(dir, '.lane-lease'), JSON.stringify({ session: 'fix-1', acquiredAt: new Date(1000).toISOString() }));
  const sentinels = [join(pool, '.lane-status-cache.json'), join(pool, '.quarantine-state', 'lane-1.json')];
  sentinels.forEach(file => writeFileSync(file, 'preserve'));
  const run = vi.fn((command, args) => {
    if (command !== 'git') throw Error('mutable lane-pool status must never run');
    return args.includes('--show-toplevel') ? join(coord, 'web-everything') : 'https://github.com/web-everything/web-everything.git';
  });
  const declaration = resourcePoolOperation({ collect: () => collect({ readSource: source => read(source, {
    env: { LANE_POOL_ROOT: join(coord, 'pools') }, run, laneStatus: undefined,
  }) }) }), registry = createRegistry();
  registry.register(declaration);
  const response = await handleOperationRequest({ method: 'GET', url: '/operations/resource-pool/run' }, {
    resolve: () => ({ declaration, registry, sinks: {} }), names: () => ['resource-pool'], newRunId: () => 'pool-read',
  });
  expect(response.status).toBe(200); expect(response.body.persisted).toBe(false);
  const result = response.body.verdict.sources.find(source => source.source === 'workers');
  expect(result).toMatchObject({ ok: true, holders: [{ jobId: 'fix-1' }] });
  expect(run.mock.calls.every(([command]) => command === 'git')).toBe(true);
  sentinels.forEach(file => expect(readFileSync(file, 'utf8')).toBe('preserve'));
  expect(fs.readdirSync(pool).sort()).toEqual(['.lane-status-cache.json', '.quarantine-state', 'lane-1']);
});
it.each([true, false])('lane readError remains unknown even when leased=%s', leased => {
  const lanes = [{ path: 'pool/lane-1', leased, lease: leased ? {
    session: 'fix-1', acquiredAt: new Date(1000).toISOString(),
  } : null, readError: 'EACCES' }];
  const report = collect({ readSource: source => read(source, {
    laneStatus: () => ({ lanes }),
  }) });
  expect(report.sources.find(s => s.source === 'workers')).toMatchObject({ ok: false });
  expect(report.unknown).toBe(true);
  expect(report.rows.every(row => row.poolDecision === 'hold')).toBe(true);
});
it.each([
  { acquiredAt: undefined }, { acquiredAt: null }, { acquiredAt: 1000 }, { acquiredAt: 'bad' },
  { acquiredAt: new Date(3000).toISOString() }, { renewedAt: 'bad' }, { renewedAt: null },
  { renewedAt: new Date(3000).toISOString() }, { ttlMinutes: -1 }, { ttlMinutes: '240' },
  { acquiredAt: '1969-02-30T00:00:00.000Z' }, { renewedAt: new Date(0).toISOString() },
  { ttlMinutes: 0 }, { ttlMinutes: null }, { ttlMinutes: 1e308 }, { reserved: 'true' },
])('invalid lease evidence %j stays unknown before leased/kind filtering', patch => {
  const lanes = [{ path: 'pool/lane-1', leased: false,
    lease: { session: 'builder-1', acquiredAt: new Date(1000).toISOString(), ...patch } }];
  expect(read('workers', { laneStatus: () => ({ lanes }) }))
    .toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
});
it.each(['{', '{}', 'directory', 'symlink', 'missing-pool', 'lane-file'])('disk lane evidence %s cannot become an empty successful inventory', shape => {
  const pool = join(coord, 'pools', 'web-everything'), dir = join(pool, 'lane-1');
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, '.lane-lease');
  if (shape === 'directory') mkdirSync(marker);
  else if (shape === 'symlink') fs.symlinkSync(join(coord, 'absent'), marker);
  else if (shape === 'missing-pool') rmSync(pool, { recursive: true });
  else if (shape === 'lane-file') { rmSync(dir, { recursive: true }); writeFileSync(dir, ''); }
  else writeFileSync(marker, shape);
  const options = { env: { LANE_POOL_ROOT: join(coord, 'pools') }, laneStatus: undefined,
    run: (command, args) => {
      if (command !== 'git') throw Error('unexpected child command');
      return args.includes('--show-toplevel') ? join(coord, 'web-everything') : 'https://github.com/web-everything/web-everything.git';
    } };
  const report = collect({ readSource: source => read(source, options) });
  expect(report.sources.find(s => s.source === 'workers')).toMatchObject({ ok: false });
  expect(report.rows.every(row => row.poolDecision === 'hold')).toBe(true);
});
it('disk inventory distinguishes absent, expired, renewed and permanent leases at the TTL boundary', () => {
  const pool = join(coord, 'pools', 'web-everything');
  const leases = [null,
    { session: 'fix-expired', acquiredAt: new Date(0).toISOString(), ttlMinutes: 1 / 30 },
    { session: 'fix-renewed', acquiredAt: new Date(0).toISOString(), renewedAt: new Date(1000).toISOString(), ttlMinutes: 1 / 30 },
    { session: 'fix-reserved', acquiredAt: new Date(0).toISOString(), ttlMinutes: 1 / 30, reserved: true }];
  leases.forEach((lease, i) => {
    const dir = join(pool, `lane-${i}`); mkdirSync(dir, { recursive: true });
    if (lease) writeFileSync(join(dir, '.lane-lease'), JSON.stringify(lease));
  });
  const result = read('workers', { env: { LANE_POOL_ROOT: join(coord, 'pools') }, laneStatus: undefined,
    run: (command, args) => {
      if (command !== 'git') throw Error('unexpected child command');
      return args.includes('--show-toplevel') ? join(coord, '.lanes', 'web-everything', 'lane-1') : 'unused';
    } });
  expect(result.ok).toBe(true);
  expect(result.holders.map(holder => holder.jobId).sort()).toEqual(['fix-renewed', 'fix-reserved']);
});
const lane = (path, session, purpose, leased = true) => ({ path, leased,
  lease: { session, purpose, acquiredAt: new Date(1000).toISOString(), ttlMinutes: leased ? 240 : 0.001 } });
it('counts both live conveyor-fix and conveyor-ci-heal leases as two C3 holders without heavy slots', () => {
  const lanes = [lane('pool/lane-1', 'fix-7343', 'conveyor-fix'),
    lane('pool/lane-2', 'ci-heal-7337', 'conveyor-ci-heal')];
  const result = read('workers', { laneStatus: () => ({ lanes }) });
  expect(result).toMatchObject({ ok: true, holders: [
    { class: 3, size: 2, jobId: 'fix-7343' },
    { class: 3, size: 2, jobId: 'ci-heal-7337' },
  ] });
  expect(result.holders.reduce((units, holder) => units + holder.size, 0)).toBe(4);
});
it('counts live fix-7343 and ci-heal-7337 leases and deduplicates heavy slots by lane', () => {
  const lanes = [lane('/pool/lane-1', 'fix-7343', 'conveyor-fix'), lane('/pool/lane-2', 'ci-heal-7337', 'conveyor-ci-heal'),
    lane('/pool/lane-3', 'fix-old', 'conveyor-fix', false), lane('/pool/lane-4', 'conveyor-fix-99', null)];
  const result = read('workers', { laneStatus: () => ({ lanes }), heavyStatus: () => ({ held: [
    { owner: '/pool/lane-1#123', meta: { dispatchKind: 'fix', lane: '1' } },
    { owner: '/pool/lane-2', meta: { dispatchKind: 'ci-heal', lane: '2' } },
    { owner: '/pool/lane-5#456', meta: { dispatchKind: 'ci-heal', session: 'ci-heal-1' } },
    { owner: '/pool/lane-5#789', meta: { dispatchKind: 'ci-heal' } },
  ] }) });
  expect(result.ok).toBe(true); expect(result.holders).toHaveLength(4);
  expect(result.holders.every(h => h.class === 3 && h.size === 2)).toBe(true);
});
it.each(['{', '{}', '{"lanes":[{}]}', '{"lanes":[{"path":"x","leased":true,"lease":null}]}'])('malformed lane status %s holds', output => {
  expect(read('workers', { laneStatus: () => JSON.parse(output) }).ok).toBe(false);
});
it('failed lane reads, oversized inventory and malformed heavy slots hold with manual fallback', () => {
  for (const options of [{ laneStatus: () => { throw Error('lane status failed'); } },
    { laneStatus: () => ({ lanes: Array(20001).fill(null) }) },
    { heavyStatus: () => ({}) }, { heavyStatus: () => ({ held: [{}] }) }])
    expect(read('workers', options)).toMatchObject({ ok: false, error: expect.stringContaining('inspect') });
});
it('terminal historical red-team files are readable without liveness probes', () => {
  for (const state of ['ok', 'failed', 'finished', 'cancelled', 'error']) {
    writeRunningAt({ ...status(), status: state, pid: null }, 1);
    expect(read('redTeam', { slotAlive: () => { throw Error('must not probe'); } })).toMatchObject({ ok: true, holders: [] });
  }
});
it('reads the validated fd despite pathname replacement and refuses nonregular or growing sources', () => {
  const replacement = join(coord, 'replacement'); writeFileSync(replacement, '{}');
  const io = { ...fs, fstatSync(fd) { const info = fs.fstatSync(fd); renameSync(replacement, paths.snapshot); return info; } };
  expect(readPoolJson(paths.snapshot, { io }).data).toEqual(snap());
  expect(() => readPoolJson(paths.fix)).toThrow(/regular/);
  const large = Buffer.alloc(16 * 1024 * 1024 + 1, 32);
  expect(() => readPoolJson(paths.snapshot, { io: { ...fs, readSync(fd, buf) { large.copy(buf); return large.length; } } })).toThrow(/grew/);
});
it('snapshot uses the validated object without calling a tolerant pathname reader', () => {
  const snapshotReader = vi.fn(() => null);
  expect(read('snapshot', { snapshotReader })).toMatchObject({ ok: true, snapshot: snap() });
  expect(snapshotReader).not.toHaveBeenCalled();
});
it('a sink returning false fails shadow appending', () => {
  expect(appendShadowRows([{}], { coord, append: () => false })).toBe(false);
});

it('strict heavy slots refuse entryless, malformed and oversized locks instead of silently freeing capacity', () => {
  const root = join(coord, 'heavy'); mkdirSync(root);
  expect(readPoolHeavyHeld({ root, cap: 1 })).toEqual({ held: [] });
  const dir = lockDirFor(root, 'slot-0'); mkdirSync(dir);
  expect(() => readPoolHeavyHeld({ root, cap: 1 })).toThrow();
  for (const text of ['{', '{}', ' '.repeat(16 * 1024 * 1024 + 1)]) {
    writeFileSync(join(dir, 'lock.json'), text);
    expect(() => readPoolHeavyHeld({ root, cap: 1 })).toThrow();
  }
  const row = { owner: '/pool/lane-1#123', heartbeatAt: new Date(nowMs).toISOString(), meta: { dispatchKind: 'fix' } };
  writeFileSync(join(dir, 'lock.json'), JSON.stringify(row));
  expect(readPoolHeavyHeld({ root, cap: 1 })).toEqual({ held: [row] });
});

it.each([true, false])('counts overlapping fresh claim, lane and heavy-slot evidence once as 2u (lane present: %s)', withLane => {
  const lockDir = join(paths.fix, 'e'.repeat(16)); mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'lock.json'), JSON.stringify({ owner: 'dispatcher',
    heartbeatAt: new Date(1000).toISOString(), meta: { repo: 'we', pr: 12, kind: 'fix' } }));
  const report = collect({ readSource: source => read(source, {
    roundBudget: () => ({ live: 0 }),
    laneStatus: () => ({ lanes: withLane ? [lane('/pool/lane-1', 'fix-12', 'conveyor-fix')] : [] }),
    heavyStatus: () => ({ held: [{ owner: '/pool/lane-1#123', meta: { dispatchKind: 'fix', session: 'fix-12' } }] }),
  }) });
  expect(report.unknown).toBe(false);
  expect(report.holders).toHaveLength(1);
  expect(report.summary['studio.units'].held).toBe(2);
  expect(report.holders[0].jobId).toBe('fix-12');
});
it('keeps different repo/kind jobs and workers without shared job identity separately counted', () => {
  const lockDir = join(paths.fix, 'e'.repeat(16)); mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'lock.json'), JSON.stringify({ owner: 'dispatcher',
    heartbeatAt: new Date(1000).toISOString(), meta: { repo: 'we', pr: 12, kind: 'fix' } }));
  const report = collect({ readSource: source => read(source, {
    roundBudget: () => ({ live: 0 }),
    laneStatus: () => ({ lanes: [
      lane('/pool/lane-2', 'fix-fui-12', 'conveyor-fix'),
      lane('/pool/lane-3', 'ci-heal-12', 'ci-heal'),
    ] }),
    heavyStatus: () => ({ held: [{ owner: '/pool/lane-4#123', meta: { dispatchKind: 'fix' } }] }),
  }) });
  expect(report.unknown).toBe(false);
  expect(report.holders).toHaveLength(4);
  expect(report.summary['studio.units'].held).toBe(8);
});

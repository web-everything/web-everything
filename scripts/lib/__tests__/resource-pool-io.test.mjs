// @vitest-environment node
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPoolSource, collectResourcePool, loadPoolSettings, appendShadowRows, poolPidAlive,
  poolSourcePaths, readPoolSettingsChecked, SOURCES } from '../resource-pool-io.mjs';
import { POOL_DEFAULTS } from '../resource-pool.mjs';
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
it('validates fix heartbeat before expiry; excludes expired fixes and live ci-heal from this slice', () => {
  const lockDir = join(paths.fix, 'b'.repeat(16)); mkdirSync(lockDir);
  const file = join(lockDir, 'lock.json');
  for (const data of [{}, { owner: 'x', heartbeatAt: 'bad' }, { owner: 'x', heartbeatAt: new Date(1000).toISOString() }]) {
    writeFileSync(file, JSON.stringify(data)); expect(read('fix').ok).toBe(false);
  }
  const claim = { owner: 'x', heartbeatAt: new Date(-700000).toISOString(), meta: { repo: 'we', pr: 1, kind: 'fix' } };
  writeFileSync(file, JSON.stringify(claim)); expect(read('fix').holders).toEqual([]);
  writeFileSync(file, JSON.stringify({ ...claim, heartbeatAt: new Date(1000).toISOString(), meta: { ...claim.meta, kind: 'ci-heal' } }));
  expect(read('fix').holders).toEqual([]);
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
it('queued rows never occupy slots or invoke a liveness probe, even with a live pid', () => {
  writeFileSync(join(paths.redTeam, filename), JSON.stringify({ ...status(), status: 'queued' }));
  const slotAlive = vi.fn(() => { throw Error('must not probe'); });
  expect(read('redTeam', { slotAlive })).toMatchObject({ ok: true, holders: [] });
  expect(slotAlive).not.toHaveBeenCalled();
});
const writeRunningAt = (row, at) => {
  const file = join(paths.redTeam, filename); writeFileSync(file, JSON.stringify(row));
  utimesSync(file, new Date(at), new Date(at));
};
const liveNow = 10_000_000;
const localProbe = (extra = {}) => ({ nowMs: liveNow, env: {}, slotAlive: undefined,
  host: 'studio', namespace: 'local', processAlive: () => false, readStart: () => 'birth', ...extra });
it('pidless running rows expire only beyond the shared 30-minute stale window', () => {
  for (const age of [1800001, 1800000, 1000, -1000]) {
    writeRunningAt({ ...status(), pid: undefined }, liveNow - age);
    expect(read('redTeam', localProbe())).toMatchObject(age > 1800000 ? { ok: true, holders: [] } : { ok: false });
  }
});
it.each([0, -1, '123', {}])('malformed running pid %j is unknown even on an old row', pid => {
  writeRunningAt({ ...status(), pid }, 1);
  expect(read('redTeam', localProbe()).ok).toBe(false);
});
it('stale foreign-host rows with dead or reused local pid are omitted using the shared owner rule', () => {
  writeRunningAt({ ...status(), host: 'Mac', pidStart: 'old' }, liveNow - 1800001);
  expect(read('redTeam', localProbe())).toMatchObject({ ok: true, holders: [] });
  expect(read('redTeam', localProbe({ processAlive: () => true }))).toMatchObject({ ok: true, holders: [] });
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
it('settings default shadow/floor4; enforce stays shadow, off suppresses logging; all sources logged', () => {
  const log = vi.fn(); const result = loadPoolSettings({ ...settingsArgs(), log });
  expect(result.value).toMatchObject({ mode: 'shadow', builderFloor: 4 }); expect(result.unknown).toBe(false);
  expect(log.mock.calls[0][0]).toContain('tool');
  const enforce = loadPoolSettings({ ...settingsArgs(), env: { WE_RESOURCE_POOL_MODE: 'enforce' } });
  expect(enforce).toMatchObject({ configuredMode: 'enforce', value: { mode: 'shadow' } });
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

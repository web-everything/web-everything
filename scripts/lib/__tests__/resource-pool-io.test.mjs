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
import { execFileSync } from 'node:child_process';
import { readPoolSource, readPoolJson, readPoolHeavyHeld, poolPidAlive, poolSourcePaths,
  SOURCES, RED_TEAM_HARD_LEASE_CEILING_MS } from '../resource-pool-io.mjs';
import { readPoolLaneStatus } from '../resource-pool-lanes.mjs';
import { lockDirFor } from '../../readiness/file-locks.mjs';
let coord, paths, env, laneDir;
const nowMs = 2000;
const lease = () => ({ session: 'fix-1', acquiredAt: new Date(1000).toISOString() });
const snap = () => ({ sampledAt: new Date(1000).toISOString(), freshUntil: new Date(3000).toISOString(),
  memory: { availableMb: 40000, floorMb: 4000, swapUsedPct: 10, swapGrowthMb: 0, pressureLevel: 1 }, cpu: { idlePct: 40 } });
const head = 'a'.repeat(40), filename = `we-12-${head}.json`;
const status = () => ({ repo: 'we', pr: 12, head, status: 'running', pid: 123 });
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
const read = (source, options = {}) => readPoolSource(source, { paths, env, nowMs, namespace: 'local', host: 'studio',
  listCommands: () => `${process.pid} 1 node resource-pool.mjs`, roundBudget: () => ({ live: 2 }),
  laneStatus: () => ({ lanes: [] }), heavyStatus: () => ({ held: [] }), slotAlive: () => true, ...options });
it('workers and lane inventory perform zero fs writes and never launch the lane-pool CLI', () => {
  fs.writeFileSync(join(laneDir, '.lane-lease'), JSON.stringify(lease()));
  const pool = join(laneDir, '..'); fs.mkdirSync(join(pool, '.quarantine-state'));
  const sentinels = [join(pool, '.lane-status-cache.json'), join(pool, '.quarantine-state', 'lane-1.json')];
  for (const file of sentinels) fs.writeFileSync(file, 'preserve');
  guard.active = true;
  expect(read('workers', { laneStatus: undefined })).toMatchObject({ ok: true, holders: [{ jobId: 'fix-1' }] });
  expect(readPoolLaneStatus({ env, nowMs, run: execFileSync, readJson: path => readPoolJson(path).data }).lanes)
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
  const laneStatus = () => readPoolLaneStatus({ env, nowMs, run: () => guard.checkout,
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

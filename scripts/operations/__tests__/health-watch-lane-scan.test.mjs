import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedLaneScan, resolveLaneScanPolicy, freshLaneSafety, guardLaneAction } from '../../lib/health-watch-lane-scan.mjs';
import { createStaleStateReader } from '../stale-state-io.mjs';

const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'health-lane-scan-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const policy = { interval: 300, source: 'standard', invalid: [] };
const rows = [{ lane: { path: '/fixture/lane-1', clean: false, lease: { agentPid: 123 } }, ahead: 2 }];

describe('health-watch persistent lane scan', () => {
  it('skips within the interval across readers, retains lane data and logs interval/source once', () => {
    const dir = temp();
    const scan = vi.fn(() => rows);
    const log = vi.fn();
    expect(cachedLaneScan(scan, { dir, root: '/fixture', now: 1000, policy, log })).toEqual(rows);
    const nextScan = vi.fn();
    expect(cachedLaneScan(nextScan, { dir, root: '/fixture', now: 42000, policy, log })).toEqual(rows.map(row => ({ ...row, cachedAt: 1000 })));
    expect(scan).toHaveBeenCalledTimes(1);
    expect(nextScan).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([
      ['health-watch: lane scan running (due, interval=300s, source=standard)'],
      ['health-watch: lane scan skipped (age 41s < 300s, source=standard)'],
    ]);
    expect(readdirSync(dir)).toEqual(['lane-scan.json']);
    expect(JSON.parse(readFileSync(join(dir, 'lane-scan.json'), 'utf8')).lanes).toEqual(rows);
  });

  it('runs the full scan when due at the boundary', () => {
    const dir = temp();
    const scan = vi.fn(() => rows);
    const opts = { dir, root: '/fixture', policy, log: vi.fn() };
    cachedLaneScan(scan, { ...opts, now: 1000 });
    cachedLaneScan(scan, { ...opts, now: 301000 });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, '{broken', '{}', '{"version":1,"root":"/fixture","at":1000,"lanes":[null]}'])(
    'runs when cache is missing or corrupt (%s)', content => {
      const dir = temp();
      if (content !== undefined) writeFileSync(join(dir, 'lane-scan.json'), content);
      const scan = vi.fn(() => rows);
      expect(cachedLaneScan(scan, { dir, root: '/fixture', now: 2000, policy, log: vi.fn() })).toEqual(rows);
      expect(scan).toHaveBeenCalledTimes(1);
    });

  it('does not write with caching disabled for a bare dry run/fixture', () => {
    const dir = temp();
    cachedLaneScan(() => rows, { dir, root: '/fixture', now: 1000, write: false, policy, log: vi.fn() });
    expect(readdirSync(dir)).toEqual([]);
    cachedLaneScan(() => rows, { dir: null, root: '/fixture', now: 1000, policy, log: vi.fn() });
  });

  it('retains expired leases, read errors and unsafe-work decisions while rechecking claims and owner liveness', () => {
    const dir = temp();
    let now = 1000;
    let alive = true;
    const lane = { path: '/fixture/lane-1', leased: false, clean: true,
      lease: { pid: 12, agentPid: 123, workerSession: 'worker', acquiredAt: '1970-01-01T00:00:00Z' } };
    const run = vi.fn((bin) => bin === 'git' ? '2' : JSON.stringify({ lanes: [lane, { path: '/fixture/lane-2', readError: 'bad lease' }] }));
    const readClaim = vi.fn(() => ({ found: true, status: 'active', rel: 'backlog/123-active.md',
      content: '---\nstatus: active\npid: 123\n---\n' }));
    const options = { root: '/fixture', run, now: () => now, probe: () => alive,
      listFiles: () => ['123-active.md'], readText: () => '---\nstatus: active\n---\n', readClaim,
      runStore: { list: () => [] }, laneScan: { dir, policy, log: vi.fn() } };
    const first = createStaleStateReader(options)();
    now = 42000;
    alive = false;
    const second = createStaleStateReader(options)();
    expect(run).toHaveBeenCalledTimes(2); // one full status and one leased-lane ahead probe
    expect(readClaim).toHaveBeenCalledTimes(2);
    expect(second.records.map(r => r.kind)).toEqual(['lane-lease', 'lane-lease', 'claim']);
    expect(first.records[0]).toMatchObject({ ownerPidAlive: true, hasUnsafeWork: true, lane: { ahead: 2 } });
    expect(second.records[0]).toMatchObject({ ownerPidAlive: false, hasUnsafeWork: true, lane: { ahead: 2 } });
    expect(second.records[1]).toMatchObject({ readError: 'bad lease' });
    expect(second.records[2]).toMatchObject({ ownerPidAlive: false });
    expect(Object.keys(second.records[0])).toEqual(Object.keys(first.records[0]));
  });
});

describe('cached lane safety is reporting only (operator ruling 2026-10-20)', () => {
  const lease = { pid: 12, agentPid: 123, workerSession: 'worker', acquiredAt: '1970-01-01T00:00:00Z' };
  const reader = (dir, lanes, aheadOut) => {
    let now = 1000;
    const run = vi.fn((bin) => bin === 'git' ? aheadOut : JSON.stringify({ lanes }));
    const options = { root: '/fixture', run, now: () => now, probe: () => false, listFiles: () => [], readText: () => '',
      readClaim: vi.fn(), runStore: { list: () => [] }, laneScan: { dir, policy, log: vi.fn() } };
    return { read: () => createStaleStateReader(options)(), tick: ms => { now += ms; }, run };
  };
  it('a cached SAFE row is reported unknown (never safe), keeps the cached value for reporting, and says so in gaps', () => {
    const dir = temp();
    const r = reader(dir, [{ path: '/fixture/lane-1', clean: true, lease }], '0');
    const first = r.read();
    expect(first.records[0]).toMatchObject({ hasUnsafeWork: false, safety: { source: 'fresh', cachedHasUnsafeWork: null } });
    r.tick(41000);
    const second = r.read();
    expect(second.records[0]).toMatchObject({ hasUnsafeWork: null,
      safety: { source: 'cache', observedAt: new Date(1000).toISOString(), cachedHasUnsafeWork: false } });
    expect(second.gaps.some(g => g.includes('reporting only, never safe'))).toBe(true);
    expect(Object.keys(second.records[0])).toEqual(Object.keys(first.records[0]));
  });
  it('a cached UNKNOWN row stays unknown and a cached UNSAFE row stays unsafe', () => {
    const dir = temp();
    const r = reader(dir, [{ path: '/fixture/a', clean: true, lease }, { path: '/fixture/b', clean: false, lease }], 'garbage');
    r.read();
    r.tick(1000);
    const [a, b] = r.read().records;
    expect(a).toMatchObject({ hasUnsafeWork: null, safety: { source: 'cache', cachedHasUnsafeWork: null } });
    expect(b).toMatchObject({ hasUnsafeWork: true, safety: { source: 'cache', cachedHasUnsafeWork: true } });
  });
  it('never writes an unsafe or unknown row into the cache as safe', () => {
    const dir = temp();
    const r = reader(dir, [{ path: '/fixture/a', clean: true, lease }, { path: '/fixture/b', clean: false, lease }], 'garbage');
    r.read();
    const cached = JSON.parse(readFileSync(join(dir, 'lane-scan.json'), 'utf8')).lanes;
    expect(cached.map(row => row.ahead)).toEqual([null, null]);
    expect(cached[1].lane.clean).toBe(false);
  });
});

describe('fresh per-lane safety check before any destructive action', () => {
  const git = outputs => vi.fn((bin, argv) => {
    const key = argv[0];
    const out = outputs[key];
    if (out instanceof Error) throw out;
    return out;
  });
  it('safe only when clean, no stash and nothing unpushed', () => {
    expect(freshLaneSafety({ path: '/l', exec: git({ status: '', stash: '', 'rev-list': '0\n' }) })).toMatchObject({ hasUnsafeWork: false, fresh: true });
    expect(freshLaneSafety({ path: '/l', exec: git({ status: ' M a.mjs\n', stash: '', 'rev-list': '0' }) })).toMatchObject({ hasUnsafeWork: true });
    expect(freshLaneSafety({ path: '/l', exec: git({ status: '?? new.mjs\n', stash: '', 'rev-list': '0' }) })).toMatchObject({ hasUnsafeWork: true });
    expect(freshLaneSafety({ path: '/l', exec: git({ status: '', stash: 'stash@{0}: x', 'rev-list': '0' }) })).toMatchObject({ hasUnsafeWork: true });
    expect(freshLaneSafety({ path: '/l', exec: git({ status: '', stash: '', 'rev-list': '3' }) })).toMatchObject({ hasUnsafeWork: true });
  });
  it('any error, timeout or unparseable output is unsafe', () => {
    for (const outputs of [{ status: new Error('timeout') }, { status: '', stash: new Error('locked') },
      { status: '', stash: '', 'rev-list': new Error('bad object') }, { status: '', stash: '', 'rev-list': 'nope' }]) {
      expect(freshLaneSafety({ path: '/l', exec: git(outputs) })).toMatchObject({ hasUnsafeWork: true, fresh: true });
    }
    expect(freshLaneSafety({ path: '', exec: git({}) })).toMatchObject({ hasUnsafeWork: true });
  });
  it('stale cached SAFE + fresh UNSAFE -> no action (the record is ignored, the fresh check decides)', () => {
    const cachedRecord = { kind: 'lane-lease', id: '/fixture/lane-1', hasUnsafeWork: null, safety: { source: 'cache', cachedHasUnsafeWork: false } };
    const log = vi.fn();
    const exec = git({ status: ' M work-in-progress.mjs\n', stash: '', 'rev-list': '0' });
    const verdict = guardLaneAction({ path: cachedRecord.id, action: 'release-on-behalf', exec, log });
    expect(verdict).toMatchObject({ act: false, fresh: { hasUnsafeWork: true, fresh: true } });
    expect(exec).toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain('refused');
    for (const action of ['reclaim', 'reset', 'reuse', 'release-on-behalf']) {
      expect(guardLaneAction({ path: '/fixture/lane-1', action, exec, log }).act).toBe(false);
    }
  });
  it('fresh check error -> no action; a throwing or non-fresh checker -> no action; only fresh safe -> act', () => {
    const log = vi.fn();
    expect(guardLaneAction({ path: '/l', action: 'reset', exec: git({ status: new Error('EACCES') }), log }).act).toBe(false);
    expect(guardLaneAction({ path: '/l', action: 'reset', check: () => { throw new Error('boom'); }, log }).act).toBe(false);
    expect(guardLaneAction({ path: '/l', action: 'reset', check: () => ({ hasUnsafeWork: false }), log }).act).toBe(false);
    expect(guardLaneAction({ path: '/l', action: 'reset', exec: git({ status: '', stash: '', 'rev-list': '0' }), log }).act).toBe(true);
  });
});

describe('lane scan setting cascade', () => {
  const resolve = options => resolveLaneScanPolicy({ env: {}, platform: {}, tool: {}, ...options });
  it('uses standard, platform, tool, then environment and logs the winning source', () => {
    expect(resolve()).toEqual(policy);
    expect(resolve({ platform: { laneScanIntervalSec: 60 } })).toMatchObject({ interval: 60, source: 'platform' });
    expect(resolve({ platform: { laneScanIntervalSec: 60 }, tool: { laneScanIntervalSec: 90 } })).toMatchObject({ interval: 90, source: 'tool' });
    const resolved = resolve({ platform: { laneScanIntervalSec: 60 }, tool: { laneScanIntervalSec: 90 },
      env: { WE_HEALTH_WATCH_LANE_SCAN_INTERVAL_SEC: '120' } });
    expect(resolved).toMatchObject({ interval: 120, source: 'env' });
    const log = vi.fn();
    cachedLaneScan(() => rows, { dir: null, root: '/fixture', policy: resolved, log });
    expect(log).toHaveBeenCalledWith('health-watch: lane scan running (due, interval=120s, source=env)');
  });
  it.each(['0', '-1', '1.5', 'abc', '', 'Infinity', '9007199254740992'])(
    'falls back to standard and says so for invalid env %s', value => {
      const resolved = resolve({ platform: { laneScanIntervalSec: 60 }, env: { WE_HEALTH_WATCH_LANE_SCAN_INTERVAL_SEC: value } });
      expect(resolved).toMatchObject({ interval: 300, source: 'standard' });
      const log = vi.fn();
      cachedLaneScan(() => rows, { dir: null, root: '/fixture', policy: resolved, log });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('source=standard');
      expect(log.mock.calls[0][0]).toContain('falling back to default 300s');
    });
  it.each([0, -1, 1.5, '300'])( 'falls back for invalid tool setting %s', value => {
    expect(resolve({ tool: { laneScanIntervalSec: value } })).toMatchObject({ interval: 300, source: 'standard' });
  });
});

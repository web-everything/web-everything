import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedLaneScan, resolveLaneScanPolicy } from '../../lib/health-watch-lane-scan.mjs';
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
    expect(cachedLaneScan(nextScan, { dir, root: '/fixture', now: 42000, policy, log })).toEqual(rows);
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

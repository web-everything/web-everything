import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { scheduledLaneMaintenance } from '../scheduled-lane-maintenance.mjs';
import { scheduledLaneGc } from '../host-load.mjs';
import { watchLanePoolHealth } from '../../conveyor/lane-pool-health-watch.mjs';
import { withGhStub } from '../../__tests__/fixtures/shared-git-fixture.mjs';

const DAY = 86400000;
let dir, poolDir, stamp, exec, emitEvent, log, opts;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scheduled-lanes-'));
  poolDir = join(dir, 'pool');
  mkdirSync(poolDir);
  stamp = join(poolDir, '.maintenance-stamp.json');
  exec = vi.fn((cmd, args) => cmd === 'du' ? '10\tpool\n' : args[1] === 'trim' ? JSON.stringify({ removed: [3], remaining: 2 }) : 'gc: completed');
  emitEvent = vi.fn();
  log = vi.fn();
  opts = { root: resolve('.'), poolDir, repoPath: 'fixture', nowMs: DAY * 2, exec, emitEvent, log,
    loadSettings: () => ({ settings: { lanes: { gc: { schedule: DAY } } } }) };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('scheduled lane maintenance', () => {
  it('runs only lease-guarded trim as a bounded CLI child, never force, and emits measured bytes and lanes trimmed', () => {
    exec.mockImplementation((cmd, args) => cmd === 'du' ? `${exec.mock.calls.length === 1 ? 20 : 10}\tpool\n` : args[1] === 'trim' ? '{"removed":[3]}' : '');
    const result = scheduledLaneMaintenance(opts);
    expect(result.trim.removed).toEqual([3]);
    expect(exec.mock.calls.map(([cmd, args]) => cmd === 'du' ? cmd : args[1])).toEqual(['du', 'trim', 'du']);
    for (const [, args, options] of exec.mock.calls) {
      expect(args).not.toContain('--force');
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.maxBuffer).toBeGreaterThan(0);
    }
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'lane-pool-maintenance', detail: expect.objectContaining({ lanesTrimmed: [3], bytesFreed: 10240 }) }));
  });

  it('persists the attempt before children and suppresses repeated ticks across restarts for 24h', () => {
    exec.mockImplementation(() => { expect(JSON.parse(readFileSync(stamp)).at).toBe(opts.nowMs); return '{"removed":[]}'; });
    scheduledLaneMaintenance(opts);
    exec.mockClear();
    scheduledLaneMaintenance({ ...opts, nowMs: opts.nowMs + DAY - 1 });
    expect(exec).not.toHaveBeenCalled();
    scheduledLaneMaintenance({ ...opts, nowMs: opts.nowMs + DAY });
    expect(exec).toHaveBeenCalled();
  });

  it('honors longer policy schedules but clamps shorter ones to 24h', () => {
    scheduledLaneMaintenance(opts);
    exec.mockClear();
    scheduledLaneMaintenance({ ...opts, nowMs: opts.nowMs + DAY, loadSettings: () => ({ settings: { lanes: { gc: { schedule: DAY * 2 } } } }) });
    expect(exec).not.toHaveBeenCalled();
    scheduledLaneMaintenance({ ...opts, nowMs: opts.nowMs + 60000, loadSettings: () => ({ settings: { lanes: { gc: { schedule: 60000 } } } }) });
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['{}', '{', '{"at":-1}', '{"at":9999999999999}', 'x'.repeat(1025)])('refuses invalid/oversized persisted evidence and names operator repair (%s)', value => {
    writeFileSync(stamp, value);
    expect(() => scheduledLaneMaintenance(opts)).not.toThrow();
    expect(exec).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toContain('inspect/repair');
  });

  it('skips a dry run without consuming its schedule', () => {
    scheduledLaneMaintenance({ ...opts, dryRun: true });
    expect(exec).not.toHaveBeenCalled();
    scheduledLaneMaintenance(opts);
    expect(exec).toHaveBeenCalled();
  });

  it('contains child and measurement failures, skips gc after failed trim, stamps failed attempts', () => {
    exec.mockImplementation(() => { throw Error('failed'); });
    expect(() => scheduledLaneMaintenance(opts)).not.toThrow();
    expect(exec.mock.calls.map(([cmd, args]) => cmd === 'du' ? cmd : args[1])).toEqual(['du', 'trim', 'du']);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ bytesFreed: null, lanesTrimmed: null }) }));
    exec.mockClear();
    scheduledLaneMaintenance(opts);
    expect(exec).not.toHaveBeenCalled();
  });

  it('skips scheduled gc when a concurrent process leases a lane after trim', () => {
    const lane = join(poolDir, 'lane-1');
    mkdirSync(join(lane, '.git'), { recursive: true });
    const marker = join(lane, '.git', '.lane-lease');
    const lease = JSON.stringify({ session: 'concurrent-holder', acquiredAt: new Date().toISOString() });
    exec.mockImplementation((cmd, args) => {
      if (cmd === 'du') return '10\tpool\n';
      if (args[1] === 'trim') {
        writeFileSync(marker, lease, { flag: 'wx' });
        return '{"removed":[]}';
      }
      return '';
    });
    const result = scheduledLaneMaintenance(opts);
    expect(result.trim.removed).toEqual([]);
    expect(exec.mock.calls.filter(([cmd]) => cmd === process.execPath).map(([, args]) => args[1])).toEqual(['trim']);
    expect(readFileSync(marker, 'utf8')).toBe(lease);
  });

  it('refuses unreadable policy or a busy maintenance lock without launching children', () => {
    scheduledLaneMaintenance({ ...opts, loadSettings: () => { throw Error('invalid policy'); } });
    writeFileSync(`${stamp}.lock`, JSON.stringify({ pid: process.pid }));
    scheduledLaneMaintenance(opts);
    expect(exec).not.toHaveBeenCalled();
  });

  it('serializes overlapping ticks and contains event-writer failure', () => {
    let nested = false;
    exec.mockImplementation(() => {
      if (!nested) {
        nested = true;
        expect(scheduledLaneMaintenance(opts).skipped).toBe(true);
      }
      return '{"removed":[]}';
    });
    expect(() => scheduledLaneMaintenance({ ...opts, emitEvent: () => { throw Error('offline'); } })).not.toThrow();
    expect(exec.mock.calls.filter(([, args]) => args[1] === 'trim')).toHaveLength(1);
  });

  it('the scheduled real trim CLI keeps a reserved leased lane even when the cap is zero', () => {
    const reference = join(dir, 'reference.git');
    execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'init', '--bare', '--quiet', reference]);
    const lane = join(poolDir, 'lane-1');
    mkdirSync(join(lane, '.git'), { recursive: true });
    const marker = join(lane, '.git', '.lane-lease');
    const lease = JSON.stringify({ reserved: true, session: 'fixture-holder', acquiredAt: new Date().toISOString() });
    writeFileSync(marker, lease);
    const realTrim = (cmd, args, options) => {
      expect(args).not.toContain('--force');
      if (args[1] !== 'trim') return exec(cmd, args, options);
      return execFileSync(cmd, [...args, `--origin=${reference}`, `--reference=${reference}`, '--name=pool'],
        { ...options, env: withGhStub({ ...process.env, LANE_POOL_ROOT: dir, WE_HERMETIC_GH: 'unauthenticated' }) });
    };
    const result = scheduledLaneMaintenance({ ...opts, max: 0, exec: realTrim });
    expect(result.trim?.removed).toEqual([]);
    expect(result.trim?.kept).toContainEqual(expect.objectContaining({ lane: 1, kind: 'reserved' }));
    expect(readFileSync(marker, 'utf8')).toBe(lease);
  });

  it('health-watch schedules maintenance with its observed pool path and preserves injected trim callers', () => {
    const maintenance = vi.fn(() => ({ trim: { removed: [] } }));
    const watchOpts = { listStatus: () => ({ root: poolDir, lanes: [] }), listAcquirable: () => null,
      listWhois: () => null, writeFreeLaneList: () => null, maintenance };
    expect(watchLanePoolHealth(watchOpts).trim).toEqual({ removed: [] });
    expect(maintenance).toHaveBeenCalledWith(expect.objectContaining({ poolDir, dryRun: false }));
    maintenance.mockClear();
    watchLanePoolHealth({ ...watchOpts, trimPool: () => null });
    expect(maintenance).not.toHaveBeenCalled();
  });
});

it('gc never passes a leased lane to git, including a lease acquired during admission', () => {
  const lanes = [1, 2, 3].map(n => join(poolDir, `lane-${n}`));
  for (const lane of lanes) mkdirSync(join(lane, '.git'), { recursive: true });
  writeFileSync(join(lanes[0], '.git', '.lane-lease'), '{}');
  const gcExec = vi.fn();
  scheduledLaneGc(lanes, { stateRoot: join(dir, 'state'), schedule: DAY, exec: gcExec,
    admission: () => { writeFileSync(join(lanes[1], '.git', '.lane-lease'), '{}'); return { admitted: true }; }, log });
  expect(gcExec.mock.calls.map(([, , o]) => o.cwd)).toEqual([lanes[2]]);
  expect(readFileSync(join(lanes[0], '.git', '.lane-lease'), 'utf8')).toBe('{}');
});

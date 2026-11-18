import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRuntimeAdmission } from '../../lib/runtime-admission.mjs';
import { startDetachedLaunch, settleLaunches, listPendingLaunches } from '../pending-launches.mjs';

describe('pending-launches (78b non-blocking launch)', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pending-launches-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const fakeSpawn = (pid) => vi.fn(() => ({ pid, unref() {} }));
  const start = (over = {}) => startDetachedLaunch({ root, num: '4131', kind: 'prepare-item', attempt: 'a1', argv: ['x.mjs'], env: {}, cwd: root, spawn: fakeSpawn(777), ...over });
  const readOutcome = (t) => ({ dispatching: t.includes('ok'), reason: t });

  it('non-blocking launch: spawns detached, records the launch and returns without waiting', () => {
    const spawn = fakeSpawn(777);
    const rec = start({ spawn });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][2]).toMatchObject({ detached: true });
    expect(rec).toMatchObject({ num: '4131', kind: 'prepare-item', attempt: 'a1', pid: 777 });
    expect(listPendingLaunches(root)).toHaveLength(1);
  });

  it('revocation during log setup leaves no process or pending artifacts', () => {
    const spawn = fakeSpawn(777);
    const readSettings = () => ({ mode: 'only', only: true, ids: readdirSync(root).length ? [] : ['4131'] });
    const result = withRuntimeAdmission({ num: '4131' }, 'prepare-item', () => start({ spawn }), { readSettings });
    expect(result).toMatchObject({ outcome: 'runtime-refused', spawned: false });
    expect(spawn).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it('a still-admitted complete group reaches the final pending-launch check', () => {
    const spawn = fakeSpawn(777);
    const result = withRuntimeAdmission({ num: '4131', groupMembers: ['4132'] }, 'prepare-item',
      () => start({ spawn, groupMembers: ['4132'] }),
      { readSettings: () => ({ mode: 'only', only: true, ids: ['4131', '4132'] }) });
    expect(result.pid).toBe(777);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('a still-running launch stays pending and is not settled', () => {
    start();
    const r = settleLaunches({ root, readOutcome, isPidAlive: () => true });
    expect(r.pending).toHaveLength(1);
    expect(r.settled).toEqual([]);
    expect(listPendingLaunches(root)).toHaveLength(1);
  });

  it('a finished launch with a result file settles through readOutcome and is removed', () => {
    const rec = start();
    writeFileSync(rec.outFile, 'ok launched');
    const r = settleLaunches({ root, readOutcome, isPidAlive: () => false });
    expect(r.settled).toHaveLength(1);
    expect(r.settled[0].outcome.dispatching).toBe(true);
    expect(listPendingLaunches(root)).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('a dead pid with no output is launch-died', () => {
    start();
    const r = settleLaunches({ root, readOutcome, isPidAlive: () => false });
    expect(r.settled[0].outcome).toMatchObject({ dispatching: false });
    expect(r.settled[0].outcome.reason).toMatch(/^launch-died/);
  });

  it('a launch older than the timeout is killed and settles as launch-timeout', () => {
    const rec = start();
    const kill = vi.fn();
    const r = settleLaunches({ root, readOutcome, isPidAlive: () => true, kill, now: () => Date.parse(rec.startedAt) + 16 * 60_000 });
    expect(kill).toHaveBeenCalledWith(777);
    expect(r.settled[0].outcome.reason).toMatch(/^launch-timeout/);
    expect(existsSync(rec.outFile)).toBe(false);
  });
});

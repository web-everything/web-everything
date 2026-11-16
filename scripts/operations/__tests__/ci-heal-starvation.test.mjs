/** @description CI-heal launch cost must not starve owed PRs or bypass admission. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReconcileCiHealDispatch } from '../ci-heal-pr-dispatch.mjs';
import * as daemon from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

const PRS = [1, 2, 3, 4];
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-heal-starvation-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  let time = 0;
  const dispatch = vi.fn(async planned => ({ pr: planned.pr, session: `heal-${planned.pr}` }));
  const dispatchThrottle = { tryAdmit: vi.fn(() => ({ admit: true })) };
  const queueAdmission = { tryAdmit: vi.fn(() => ({ admit: true })) };
  const fixLoop = {
    killed: () => false, readRows: () => [], append: vi.fn(async () => {}),
    currentBuild: () => 'test-build', readSessionLog: () => '',
  };
  const options = {
    root: dir, checkStaleness: () => ({ fresh: true, behind: 0 }),
    now: () => time, deadlineAt: 180_000,
    reconcile: () => ({ dispatch: PRS.map(prNumber => ({
      kind: 'ci-heal', prNumber, headRefName: `lane/pr-${prNumber}`, headRefOid: 'a'.repeat(40),
      waitingSince: `2026-11-01T00:00:0${prNumber}.000Z`,
    })), refusals: [] }),
    flushOwed: () => ({}), pollAttempts: () => [], flushTimeouts: async () => [],
    timeoutHold: () => null, salvage: async () => null,
    resolveProfile: () => ({ capabilities: { ciHeal: true } }),
    resolveWorkUnit: () => ({ itemNum: null, scope: [] }),
    pickFreeLanes: () => [11, 12, 13, 14], unsupportedPath: join(dir, 'unsupported.json'),
    fixConfig: { maxSessions: 3, windowHours: 6, hold: true }, fixLoop,
    dispatch, dispatchThrottle, queueAdmission, ciHealReserve: null,
  };
  return { options, dispatch, dispatchThrottle, queueAdmission, fixLoop, advance: ms => { time += ms; } };
}

describe('CI-heal starvation', () => {
  it('launches all four owed PRs concurrently even when the first dispatch exceeds the phase deadline', async () => {
    const f = fixture();
    let launchedAtFirstCompletion;
    f.dispatch.mockImplementation(async planned => {
      if (planned.pr === 1) {
        f.advance(317_151);
        await Promise.resolve();
        launchedAtFirstCompletion = f.dispatch.mock.calls.map(([p]) => p.pr);
      }
      return { pr: planned.pr, session: `heal-${planned.pr}` };
    });
    const out = await runReconcileCiHealDispatch(f.options);
    expect(out).toMatchObject({ handled: 4, deferred: [], nextCursor: null, refusals: [] });
    expect(out.dispatched.map(row => row.pr)).toEqual(PRS);
    expect(launchedAtFirstCompletion).toEqual(PRS);
    expect(f.dispatch.mock.calls.map(([p]) => p.lane)).toEqual([11, 12, 13, 14]);
    expect(f.dispatchThrottle.tryAdmit.mock.calls).toEqual(PRS.map(() => ['ci-heal']));
    expect(f.queueAdmission.tryAdmit.mock.calls).toEqual(PRS.map(id => ['ci-heal', { id }]));
    expect(f.fixLoop.append.mock.calls.map(([row]) => row.pr).sort()).toEqual(PRS);
  });

  it('keeps fix-cap refusals for entries 3 and 4 and calls admission exactly once per considered entry', async () => {
    const f = fixture();
    let admissions = 0;
    f.dispatchThrottle.tryAdmit.mockImplementation(() => ++admissions <= 2
      ? { admit: true } : { admit: false, kind: 'fix-cap', why: 'two launches already admitted' });
    f.dispatch.mockImplementation(async planned => {
      f.advance(317_151);
      return { pr: planned.pr };
    });
    const out = await runReconcileCiHealDispatch(f.options);
    expect(out).toMatchObject({ handled: 4, deferred: [], nextCursor: null });
    expect(out.refusals).toEqual([3, 4].map(pr => ({
      pr, kind: 'fix-cap', why: 'two launches already admitted',
    })));
    expect(out.dispatched.map(row => row.pr)).toEqual([1, 2]);
    expect(f.dispatch.mock.calls.map(([p]) => p.pr)).toEqual([1, 2]);
    expect(f.dispatchThrottle.tryAdmit.mock.calls).toEqual(PRS.map(() => ['ci-heal']));
    expect(f.queueAdmission.tryAdmit.mock.calls).toEqual([1, 2].map(id => ['ci-heal', { id }]));
  });

  it('refuses one throwing dispatch without preventing the other owed PRs from launching', async () => {
    const f = fixture();
    f.dispatch.mockImplementation(async planned => {
      if (planned.pr === 2) throw new Error('injected launch failure');
      f.advance(317_151);
      await Promise.resolve();
      return { pr: planned.pr };
    });
    const out = await runReconcileCiHealDispatch(f.options);
    expect(out).toMatchObject({ handled: 4, deferred: [], nextCursor: null });
    expect(f.dispatch.mock.calls.map(([p]) => p.pr)).toEqual(PRS);
    expect(out.dispatched.map(row => row.pr)).toEqual([1, 3, 4]);
    expect(out.refusals).toEqual([
      expect.objectContaining({ pr: 2, kind: 'dispatch-failed', why: expect.stringContaining('injected launch failure') }),
    ]);
    expect(f.fixLoop.append.mock.calls.map(([row]) => row.pr).sort()).toEqual([1, 3, 4]);
  });
});

describe('fix-pass cursor persistence', () => {
  it('round-trips rotation and per-repo PR cursors through injected file IO', async () => {
    const path = join(dir, 'fix-pass-cursors.json');
    const rotation = { 'ci-heal': 'web-everything/web-everything', fix: 'frontierui/frontierui' };
    const prCursors = { 'ci-heal': { 'web-everything/web-everything': 42 }, fix: { 'frontierui/frontierui': 73 } };
    const files = new Map();
    const write = vi.fn((file, content) => files.set(file, content));
    const readFile = vi.fn(file => files.get(file));
    await daemon.saveFixPassCursors({ path, rotation, prCursors, write });
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(files.get(path))).toEqual({ version: 1, rotation, prCursors });
    expect(await daemon.loadFixPassCursors({ path, readFile })).toEqual({ rotation, prCursors });
    expect(readFile).toHaveBeenCalledWith(path, 'utf8');
  });

  it.each(['missing', 'corrupt'])('returns empty cursor state for a %s file using injected reads', async mode => {
    const readFile = vi.fn(() => {
      if (mode === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return '{invalid json';
    });
    expect(await daemon.loadFixPassCursors({ path: join(dir, 'cursors.json'), readFile }))
      .toEqual({ rotation: {}, prCursors: {} });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('never throws when the injected cursor write fails', async () => {
    const write = vi.fn(() => { throw new Error('read-only filesystem'); });
    await daemon.saveFixPassCursors({
      path: join(dir, 'cursors.json'), rotation: {}, prCursors: {}, write,
    });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

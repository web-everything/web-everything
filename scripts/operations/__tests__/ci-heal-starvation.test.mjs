/** @description CI-heal launch cost must not starve owed PRs or bypass admission. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  const dispatchThrottle = { tryAdmit: vi.fn(() => ({ admit: true })), recheckHost: vi.fn(() => ({ admit: true })) };
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
  it('dispatches all six owed PRs when the pre-loop spends 192 seconds of the phase budget', async () => {
    const f = fixture();
    const prs = [1, 2, 3, 4, 5, 6];
    f.options.reconcile = () => ({ dispatch: prs.map(prNumber => ({
      kind: 'ci-heal', prNumber, headRefOid: 'a'.repeat(40),
    })), refusals: [] });
    f.options.pickFreeLanes = () => [11, 12, 13, 14, 15, 16];
    f.options.flushTimeouts = async () => { f.advance(192_000); return []; };
    f.dispatch.mockImplementation(async planned => {
      f.advance(5_000);
      return { pr: planned.pr };
    });

    const out = await runReconcileCiHealDispatch(f.options);

    expect(out).toMatchObject({ handled: 6, deferred: [], nextCursor: null, refusals: [] });
    expect(out.dispatched.map(row => row.pr)).toEqual(prs);
    expect(f.dispatch.mock.calls.map(([p]) => p.pr)).toEqual(prs);
    expect(f.dispatchThrottle.tryAdmit).toHaveBeenCalledTimes(6);
    expect(f.queueAdmission.tryAdmit.mock.calls).toEqual(prs.map(id => ['ci-heal', { id }]));
    expect(console.error.mock.calls.filter(([line]) => line.startsWith('ci-heal-pr-dispatch: gate slice')))
      .toEqual([['ci-heal-pr-dispatch: gate slice ms=120000 source=default']]);
  });

  it.each([
    { gateSliceMs: undefined, gateCost: 130_000, effective: 120_000, source: 'default' },
    { gateSliceMs: 60_000, gateCost: 70_000, effective: 60_000, source: 'option' },
  ])('defers remaining PRs with a cursor when Phase A exceeds its $source slice', async ({ gateSliceMs, gateCost, effective, source }) => {
    const f = fixture();
    if (gateSliceMs !== undefined) f.options.gateSliceMs = gateSliceMs;
    f.options.timeoutHold = vi.fn(() => { f.advance(gateCost); return null; });

    const out = await runReconcileCiHealDispatch(f.options);

    expect(out).toMatchObject({ handled: 1, deferred: [2, 3, 4], nextCursor: 2, refusals: [] });
    expect(out.dispatched.map(row => row.pr)).toEqual([1]);
    expect(f.dispatch.mock.calls.map(([p]) => p.pr)).toEqual([1]);
    expect(f.options.timeoutHold).toHaveBeenCalledTimes(1);
    expect(f.dispatchThrottle.tryAdmit).toHaveBeenCalledTimes(1);
    expect(f.queueAdmission.tryAdmit.mock.calls).toEqual([['ci-heal', { id: 1 }]]);
    expect(out.yieldedForAdoption).toBeUndefined();
    expect(console.error.mock.calls.filter(([line]) => line.startsWith('ci-heal-pr-dispatch: gate slice')))
      .toEqual([[`ci-heal-pr-dispatch: gate slice ms=${effective} source=${source}`]]);
  });

  it('preserves the adoption yield and cursor within the gate slice', async () => {
    const f = fixture();
    f.options.shouldYield = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);

    const out = await runReconcileCiHealDispatch(f.options);

    expect(out).toMatchObject({ handled: 1, deferred: [2, 3, 4], nextCursor: 2, yieldedForAdoption: true });
    expect(f.dispatch.mock.calls.map(([p]) => p.pr)).toEqual([1]);
  });

  it.each(['after-first-launch', 'one-shot-after-first-launch', 'during-admission', 'before-first-launch'])(
    'honors adoption requested %s while exempting only the first launch and retaining the earliest cursor', async mode => {
      const f = fixture();
      let yieldRequested = false;
      let probes = 0;
      // The pre-loop probe runs once before the Phase A probes for PRs 2 and 3.
      f.options.shouldYield = () => {
        if (mode === 'during-admission') return ++probes >= 3;
        const result = yieldRequested;
        if (mode === 'one-shot-after-first-launch') yieldRequested = false;
        return result;
      };
      if (mode === 'before-first-launch') {
        f.queueAdmission.tryAdmit.mockImplementation((_kind, { id }) => {
          if (id === 4) yieldRequested = true;
          return { admit: true };
        });
      }
      f.dispatch.mockImplementation(async planned => {
        yieldRequested = true;
        return { pr: planned.pr };
      });

      const out = await runReconcileCiHealDispatch(f.options);

      expect(f.dispatch.mock.calls.map(([p]) => p.pr)).toEqual([1]);
      expect(out).toMatchObject({ deferred: [2, 3, 4], nextCursor: 2, yieldedForAdoption: true });
      expect(out.refusals.map(row => [row.pr, row.kind])).toEqual(
        (mode === 'during-admission' ? [2] : [2, 3, 4]).map(pr => [pr, 'adoption-yield']));
    });

  it('retains yielded PRs in rotated traversal order rather than numeric order', async () => {
    const f = fixture();
    f.options.cursor = 3;
    let requested = false;
    f.options.shouldYield = () => requested;
    f.dispatch.mockImplementation(async planned => { requested = true; return { pr: planned.pr }; });
    const out = await runReconcileCiHealDispatch(f.options);
    expect(out.dispatched.map(row => row.pr)).toEqual([3]);
    expect(out).toMatchObject({ deferred: [4, 1, 2], nextCursor: 4, yieldedForAdoption: true });
  });

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
  it('round-trips and replaces cursors using the default filesystem writer and reader', async () => {
    const path = join(dir, 'nested', 'fix-pass-cursors.json');
    expect(daemon.loadFixPassCursors({ path })).toEqual({ rotation: {}, prCursors: {} });
    for (const pr of [42, 73]) {
      const rotation = { 'ci-heal': 'we' };
      const prCursors = { 'ci-heal': { we: pr } };
      await daemon.saveFixPassCursors({ path, rotation, prCursors });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, rotation, prCursors });
      expect(daemon.loadFixPassCursors({ path })).toEqual({ rotation, prCursors });
      expect(readdirSync(join(dir, 'nested'))).toEqual(['fix-pass-cursors.json']);
    }
  });

  it('restores persisted default rotation and PR cursors after daemon restart', async () => {
    const path = join(dir, 'restart', 'fix-pass-cursors.json');
    // Resolve through filesystem paths so Vite cannot rewrite the child import to an HTTP asset URL.
    const daemonUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)),
      '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs')).href;
    // Use actual process restarts: Vitest's module registry and builtin mock cache
    // are not daemon lifecycle boundaries. Only the default startup read is redirected;
    // parsing, persistence, and the default in-memory cursor state remain real.
    const restart = nextCursor => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const [path, daemonUrl, nextCursor] = process.argv.slice(1);
      const readFile = fs.readFileSync;
      let startupReads = 0;
      fs.readFileSync = (file, ...args) => {
        if (String(file).endsWith('/.conveyor/fix-pass-cursors.json')) {
          startupReads++;
          return readFile(path, ...args);
        }
        return readFile(file, ...args);
      };
      syncBuiltinESMExports();
      const daemon = await import(daemonUrl);
      const empty = () => ({ dispatched: [], refusals: [] });
      const recovery = () => ({ dispatch: [], refusals: [], applied: [] });
      const visited = [];
      await daemon.runTickAllRepos({
        repos: ['we', 'frontierui'], now: () => 0, fenceOk: () => true, authGateOverride: () => ({ paused: false }),
        fixTick: empty, promoteDraftTick: empty, hungCiTick: recovery, mainRedRebaseTick: recovery,
        missingRunTick: recovery, notesTick: () => ({ notes: [], prsByNumber: new Map() }),
        awaitVerifyTick: async () => ({ rows: [] }), stuckFixerTick: async () => ({ rows: [] }),
        supersedeTick: () => ({ holds: [], applied: [] }), rulingStandDownTick: () => ({ rows: [] }),
        orphanGuardTick: null, cursorPersistence: { path },
        ciHealTick: ({ repo, cursor }) => {
          visited.push({ repo, cursor });
          return { ...empty(), handled: 1, deferred: repo === 'frontierui' ? [Number(nextCursor)] : [],
            nextCursor: repo === 'frontierui' ? Number(nextCursor) : null };
        },
      });
      console.log(JSON.stringify({ pid: process.pid, startupReads, visited }));
    `, path, daemonUrl, String(nextCursor)], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, VITEST: '' },
    }));
    const firstDaemon = restart(73);
    expect(firstDaemon.startupReads).toBe(1);
    expect(firstDaemon.visited.map(({ repo, cursor }) => [repo, cursor]))
      .toEqual([['we', undefined], ['frontierui', undefined]]);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.rotation['ci-heal']).toBe('frontierui');
    expect(saved.prCursors['ci-heal']).toEqual({ frontierui: 73 });
    expect(daemon.loadFixPassCursors({ path })).toEqual({ rotation: saved.rotation, prCursors: saved.prCursors });

    const secondDaemon = restart(74);
    expect(secondDaemon.pid).not.toBe(firstDaemon.pid);
    expect(secondDaemon.startupReads).toBe(1);
    const visited = secondDaemon.visited.map(({ repo, cursor }) => [repo, cursor]);
    expect(visited).toEqual([['frontierui', 73], ['we', undefined]]);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.rotation).toEqual(saved.rotation);
    expect(after.prCursors).toEqual({ ...saved.prCursors, 'ci-heal': { frontierui: 74 } });
  }, 65_000);

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


describe('CI-heal accounting failure recovery', () => {
  it('waits for the previous ledger append before starting the next', async () => {
    const f = fixture();
    let releaseFirst;
    let firstStarted;
    const started = new Promise(resolve => { firstStarted = resolve; });
    const blocked = new Promise(resolve => { releaseFirst = resolve; });
    let outstanding = 0;
    let maximum = 0;
    f.fixLoop.append.mockImplementation(async row => {
      maximum = Math.max(maximum, ++outstanding);
      if (row.pr === 1) { firstStarted(); await blocked; }
      outstanding--;
    });
    const pending = runReconcileCiHealDispatch(f.options);
    await started;
    await Promise.resolve();
    const beforeRelease = f.fixLoop.append.mock.calls.map(([row]) => row.pr);
    releaseFirst();
    await pending;
    expect(beforeRelease).toEqual([1]);
    expect(maximum).toBe(1);
    expect(f.fixLoop.append.mock.calls.map(([row]) => row.pr)).toEqual(PRS);
  });

  it('executes later serialized ledger appends after the first append rejects', async () => {
    const f = fixture();
    const recorded = [];
    f.fixLoop.append.mockRejectedValueOnce(new Error('injected ledger failure'))
      .mockImplementation(async row => { recorded.push(row.pr); });

    const out = await runReconcileCiHealDispatch(f.options);

    expect(out.dispatched.map(row => row.pr)).toEqual(PRS);
    expect(out.refusals).toEqual([]);
    expect(f.fixLoop.append.mock.calls.map(([row]) => row.pr)).toEqual(PRS);
    expect(recorded).toEqual([2, 3, 4]);
  });
});

describe('fix-pass persistence failure recovery', () => {
  it.each([
    null,
    { version: 2, rotation: {}, prCursors: {} },
    { version: 1, rotation: [], prCursors: {} },
    { version: 1, rotation: { fix: 42 }, prCursors: {} },
    { version: 1, rotation: {}, prCursors: [] },
    { version: 1, rotation: {}, prCursors: { fix: null } },
    { version: 1, rotation: {}, prCursors: { fix: { we: -1 } } },
  ])('resets malformed cursor state to empty cursors: %j', async state => {
    const readFile = vi.fn(() => JSON.stringify(state));
    expect(await daemon.loadFixPassCursors({ path: join(dir, 'cursors.json'), readFile }))
      .toEqual({ rotation: {}, prCursors: {} });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('completes the daemon dispatch result when cursor persistence rejects asynchronously', async () => {
    const f = fixture();
    const write = vi.fn().mockRejectedValue(new Error('injected persistence failure'));
    const empty = () => ({ dispatched: [], refusals: [] });
    const recovery = () => ({ dispatch: [], refusals: [], applied: [] });

    const out = await daemon.runTickAllRepos({
      repos: ['we'], now: () => 0, fenceOk: () => true, authGateOverride: () => ({ paused: false }),
      fixTick: empty, ciHealTick: () => runReconcileCiHealDispatch(f.options),
      promoteDraftTick: empty, hungCiTick: recovery, mainRedRebaseTick: recovery,
      missingRunTick: recovery, notesTick: () => ({ notes: [], prsByNumber: new Map() }),
      awaitVerifyTick: async () => ({ rows: [] }), stuckFixerTick: async () => ({ rows: [] }),
      supersedeTick: () => ({ holds: [], applied: [] }),
      rulingStandDownTick: () => ({ rows: [] }), orphanGuardTick: null,
      cursorPersistence: { path: join(dir, 'cursors.json'), write },
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(out.dispatched.map(row => row.pr)).toEqual(PRS);
    expect(out.refusals).toEqual([]);
    expect(out.ciHeal.dispatched).toHaveLength(4);
  });
});


describe('CI-heal held-lane reuse', () => {
  it('dispatches the second PR on the same lane when the first PR is held', async () => {
    const f = fixture();
    f.options.pickFreeLanes = () => [11];
    f.dispatch.mockImplementation(async planned => planned.pr === 1
      ? { held: true, reason: 'already in flight' } : { pr: planned.pr });

    const out = await runReconcileCiHealDispatch(f.options);

    expect(out).toMatchObject({ handled: 4, deferred: [], nextCursor: null });
    expect(f.dispatch.mock.calls.map(([p]) => [p.pr, p.lane])).toEqual([[1, 11], [2, 11]]);
    expect(out.dispatched.map(row => row.pr)).toEqual([2]);
    expect(out.refusals.map(row => [row.pr, row.kind])).toEqual([
      [1, 'held'], [3, 'no-lane'], [4, 'no-lane'],
    ]);
    expect(f.dispatchThrottle.tryAdmit.mock.calls).toEqual(PRS.map(() => ['ci-heal']));
    expect(f.queueAdmission.tryAdmit.mock.calls).toEqual(PRS.map(id => ['ci-heal', { id }]));
    expect(f.fixLoop.append.mock.calls.map(([row]) => row.pr)).toEqual([2]);
  });
});

describe('CI-heal launch waves', () => {
  it('forwards the real daemon throttle through the all-repo CI-heal path and rechecks host memory before launch', async () => {
    const f = fixture();
    const now = Date.parse('2026-11-16T00:00:00Z');
    let availableMb = 8192;
    const throttle = daemon.buildFixThrottle({
      slotClaims: () => [], queueLength: () => 0, sendBackReservedSlots: 0, nowMs: () => now,
      settings: { cutover: 'enforce', fixCap: { floor: 4, ceiling: 4 } },
      readSnap: () => ({ sampledAt: new Date(now).toISOString(), freshUntil: new Date(now + 10_000).toISOString(),
        memory: { metric: 'available', availableMb, pressureLevel: 1 } }),
      resolveFloor: () => ({ floorMb: 2048, metric: 'available', source: 'test' }),
      readHeavyWait: () => 0, gate: () => ({ admit: true }), log: () => {},
    });
    expect(throttle.recheckHost).toBeTypeOf('function');
    const recheck = vi.spyOn(throttle, 'recheckHost');
    f.dispatch.mockImplementation(async planned => { availableMb = 1024; return { pr: planned.pr }; });
    const out = await daemon.runReconcileCiHealDispatchAllRepos({
      repos: ['we'], dispatchThrottle: throttle,
      tick: options => {
        expect(options.dispatchThrottle).toBe(throttle);
        return runReconcileCiHealDispatch({ ...f.options, ...options });
      },
    });
    expect(f.dispatch.mock.calls.map(([p]) => p.pr)).toEqual([1]);
    expect(recheck.mock.calls).toEqual([['ci-heal'], ['ci-heal']]);
    expect(out.refusals.map(row => [row.pr, row.kind])).toEqual([2, 3, 4].map(pr => [pr, 'host-load']));
  });

  it.each([4, 6])('latches host refusal after the first launch across %i owed PRs', async count => {
    const f = fixture();
    const prs = Array.from({ length: count }, (_, i) => i + 1);
    f.options.reconcile = () => ({ dispatch: prs.map(prNumber => ({ kind: 'ci-heal', prNumber,
      headRefName: `lane/pr-${prNumber}`, headRefOid: 'a'.repeat(40) })), refusals: [] });
    f.options.pickFreeLanes = () => prs.map(pr => pr + 10);
    f.dispatchThrottle.recheckHost = vi.fn(() => ({ admit: false, kind: 'host-load', why: 'host busy' }))
      .mockReturnValueOnce({ admit: true });
    const out = await runReconcileCiHealDispatch(f.options);
    expect(out.dispatched.map(row => row.pr)).toEqual([1]);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatchThrottle.recheckHost.mock.calls).toEqual([['ci-heal'], ['ci-heal']]);
    expect(out.refusals).toEqual(prs.slice(1).map(pr => ({ pr, kind: 'host-load', why: 'host busy' })));
    expect(console.error.mock.calls.filter(([line]) => line.includes('host busy'))).toHaveLength(count - 1);
  });

  it.each(['refuses', 'throws', 'unreadable', 'missing', 'not-callable'])('fails closed when the first host recheck %s', async mode => {
    const f = fixture();
    f.dispatchThrottle.recheckHost = vi.fn(() => {
      if (mode === 'throws') throw Error('host unreadable');
      return mode === 'unreadable' ? undefined : { admit: false, why: 'host busy' };
    });
    const recheck = f.dispatchThrottle.recheckHost;
    if (mode === 'missing') delete f.dispatchThrottle.recheckHost;
    if (mode === 'not-callable') f.dispatchThrottle.recheckHost = true;
    const out = await runReconcileCiHealDispatch(f.options);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(out.dispatched).toEqual([]);
    expect(out.refusals.map(row => [row.pr, row.kind])).toEqual(PRS.map(pr => [pr, 'host-load']));
    expect(new Set(out.refusals.map(row => row.why)).size).toBe(1);
    expect(out.refusals[0].why).toMatch(mode === 'refuses' ? /host busy/ : /unreadable/);
    expect(recheck.mock.calls).toEqual(['missing', 'not-callable'].includes(mode) ? [] : [['ci-heal']]);
  });

  it('re-reads the kill switch between waves: a stop requested during the first wave refuses later waves', async () => {
    const f = fixture();
    const prs = [1, 2, 3, 4, 5, 6];
    f.options.reconcile = () => ({ dispatch: prs.map(prNumber => ({ kind: 'ci-heal', prNumber, headRefName: `lane/pr-${prNumber}`,
      headRefOid: 'a'.repeat(40), waitingSince: `2026-11-01T00:00:0${prNumber}.000Z` })), refusals: [] });
    f.options.pickFreeLanes = () => [11, 12, 13, 14, 15, 16];
    let killed = false;
    f.fixLoop.killed = () => killed;
    f.dispatch.mockImplementation(async planned => { await Promise.resolve(); killed = true; return { pr: planned.pr, session: `heal-${planned.pr}` }; });
    const out = await runReconcileCiHealDispatch(f.options);
    expect(out.dispatched.map(row => row.pr)).toEqual([1, 2, 3, 4]);
    expect(out.refusals.map(row => [row.pr, row.kind])).toEqual([[5, 'fix-dispatch-killed'], [6, 'fix-dispatch-killed']]);
  });
});

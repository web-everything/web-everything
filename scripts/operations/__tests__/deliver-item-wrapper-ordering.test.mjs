/** #4410 — completed persistence boundaries, exercised through deliverItem and the real dispatch tick. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../dispatch-lane-io.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, findItem: vi.fn(actual.findItem) };
});
vi.mock('../delivery-report-store.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, tryReadDeliveryReport: vi.fn() };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = { ...actual, execFileSync: vi.fn() };
  return { ...mocked, default: mocked };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  const readFileSync = vi.fn((path, ...rest) => {
    if (String(path).includes('delivery-agent-brief-v2.md')) return 'Build item {{ITEM_SPEC_PATH_BASENAME}}.';
    return actual.readFileSync(path, ...rest);
  });
  const mocked = { ...actual, readFileSync };
  return { ...mocked, default: mocked };
});
// Throw once when the terminal branch closes its root span, after persistence has completed.
// The outer catch then attempts terminal cleanup again; the latch must suppress every repeated write.
const telemetryFaults = vi.hoisted(() => ({ throwOnNextRootClose: false, failures: [] }));
vi.mock('../telemetry-store.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recorderFor: (...args) => {
      const rec = actual.recorderFor(...args);
      return {
        ...rec,
        startSpan: (name, opts) => {
          const span = rec.startSpan(name, opts);
          if (name !== 'dispatch') return span;
          return {
            ...span,
            fail: (error, attrs) => {
              if (telemetryFaults.throwOnNextRootClose) {
                telemetryFaults.throwOnNextRootClose = false;
                throw new Error('injected: telemetry root close threw after settle');
              }
              telemetryFaults.failures.push({ error, attrs });
              return span.fail(error, attrs);
            },
            ok: (extra) => {
              if (telemetryFaults.throwOnNextRootClose) {
                telemetryFaults.throwOnNextRootClose = false;
                throw new Error('injected: telemetry root close threw after settle');
              }
              return span.ok(extra);
            },
          };
        },
      };
    },
  };
});

vi.mock('../../conveyor/build-dispatch-claim.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, placeBuildDispatchHold: vi.fn(actual.placeBuildDispatchHold),
    releaseBuildDispatchClaim: vi.fn(actual.releaseBuildDispatchClaim) };
});
vi.mock('../deliver-item-settle.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, settleDispatchEffect: vi.fn(actual.settleDispatchEffect) };
});

import { execFileSync } from 'node:child_process';
import { findItem } from '../dispatch-lane-io.mjs';
import { tryReadDeliveryReport } from '../delivery-report-store.mjs';
import { deliverItem } from '../deliver-item-wrapper.mjs';
import { settleDispatchEffect } from '../deliver-item-settle.mjs';
import { createFileRunStore, newRunRecord } from '../run-store.mjs';
import { acquireBuildDispatchClaim, listBuildDispatchClaims, listBuildDispatchHolds,
  placeBuildDispatchHold, releaseBuildDispatchClaim } from '../../conveyor/build-dispatch-claim.mjs';
import { runBuildDispatchTick, cliListSettledBuilds, cliListRunStoreInFlight }
  from '../../../skills-src/conveyor/build-dispatch-daemon.mjs';

const actualClaims = await vi.importActual('../../conveyor/build-dispatch-claim.mjs');
const actualSettle = await vi.importActual('../deliver-item-settle.mjs');
const NOW = new Date('2026-10-09T12:00:00.000Z');
const NUM = '9001';
const RUN = 'dispatch-lane-4410-ordering';
const KEY = 'dispatch:0:0';
let root, lane, runs, coord, snapshots, calls, settlementStart;

function selectStores(runsDir, coordinationRoot) {
  vi.stubEnv('OPERATION_RUNS_DIR', runsDir);
  vi.stubEnv('WE_COORDINATION_ROOT', coordinationRoot);
}

function capture(operation, result) {
  const dir = join(root, `snapshot-${snapshots.length}-${operation}`);
  mkdirSync(dir);
  cpSync(runs, join(dir, 'runs'), { recursive: true });
  cpSync(coord, join(dir, 'coord'), { recursive: true });
  snapshots.push({ operation, result, dir });
}

function instrument(name, mock, real) {
  mock.mockImplementation((args) => {
    calls.push(name);
    if (name === 'settle') settlementStart = {
      holds: listBuildDispatchHolds(), claims: listBuildDispatchClaims(),
    };
    const result = real(args);
    capture(name, result);
    return result;
  });
}

function seed() {
  createFileRunStore(runs).write({
    ...newRunRecord({ id: RUN, op: 'dispatch-lane' }),
    pending: { kind: 'effect', step: 'dispatch', stepIndex: 0 },
    effects: [{ key: KEY, type: 'conveyor.dispatch-delivery-agent', stepIndex: 0, index: 0,
      status: 'in-flight', startedAt: NOW.toISOString(), handle: 'pid:424242',
      expectedBy: new Date(+NOW + 90 * 60_000).toISOString(),
      payload: { num: NUM, launchKind: 'build', scope: [] }, result: null, error: null }],
  });
  expect(acquireBuildDispatchClaim({ num: NUM, scope: [], nowMs: +NOW })).toMatchObject({ ok: true });
}

function deliver(outcome = 'not-ready', identity = { runId: RUN, effectKey: KEY }) {
  tryReadDeliveryReport.mockReturnValue(outcome === 'not-ready'
    ? { status: 'done', outcome: 'blocked', filesTouched: [], reason: 'blockedBy 1 re-opened' }
    : { status: 'done', outcome: 'done', filesTouched: ['a.mjs'], reason: 'did it' });
  execFileSync.mockImplementation((cmd, a = []) => {
    if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && a[1] === 'status') {
      return JSON.stringify({ repo: 'web-everything', root: '/pool', lanes: [{ lane: 7, path: lane, exists: true }] });
    }
    if (cmd === 'node' && a[0] === 'scripts/lane-pool.mjs' && ['acquire', 'release'].includes(a[1])) return '';
    if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'claim') return '{}';
    if (cmd === 'node' && a[0] === 'scripts/backlog.mjs' && a[1] === 'release') return '';
    if (cmd === 'node' && a[0] === 'scripts/verify-lane.mjs') return '{}';
    if (cmd === 'node' && a[0] === 'scripts/operations/run.mjs' && a[1] === 'verify') {
      return JSON.stringify({ runId: 'verify-test', op: 'verify', stopped: 'complete', applied: [],
        verdict: { ok: outcome === 'pr-opened', cwd: lane, suite: 'run', passed: 1,
          failed: outcome === 'pr-opened' ? 0 : 1, unrun: 0, checks: [], blocking: [] } });
    }
    if (cmd === 'node' && a[0] === 'scripts/converge-cli.mjs' && a[1] === 'init') {
      return JSON.stringify({ action: 'land', round: 1, roundCap: 5, verdict: 'land', dismissed: [] });
    }
    if (cmd === 'node' && String(a[0]).endsWith('scripts/operations/run.mjs') && a[1] === 'open-pr') {
      return JSON.stringify({ runId: 'open-pr-test', op: 'open-pr', stopped: 'complete', applied: ['open-pr-test#1#0'],
        inFlight: [], pending: null, verdict: { ref: 'lane/test', base: 'main' },
        findings: { submit: { applied: true, effects: [{ type: 'open-pr.submit', status: 'applied',
          result: { outcome: 'opened', pr: 9876, url: 'https://example/pr/9876' }, error: null }] } } });
    }
    if (cmd === 'git') return ''; // All subprocess effects are stubs; never run host commands.
    throw new Error(`unexpected subprocess: ${cmd} ${a.join(' ')}`);
  });
  return deliverItem({ item: NUM, lane: 7, scope: [], sessionSlug: 'conveyor-9001', attemptTag: '', ...identity },
    { spawn: vi.fn(), vendor: 'claude' }, { newSessionId: () => 'uuid-fixed' });
}

// The saved evidence is never handed to a mutating tick. Each probe reads a fresh disposable copy.
async function tickSnapshot(snapshot, nums = [NUM]) {
  const work = mkdtempSync(join(root, 'tick-'));
  cpSync(snapshot.dir, work, { recursive: true });
  selectStores(join(work, 'runs'), join(work, 'coord'));
  try {
    const inFlight = await cliListRunStoreInFlight({ launchKind: 'build', now: NOW });
    const settled = await cliListSettledBuilds({ launchKind: 'build' });
    const holds = listBuildDispatchHolds();
    const claims = listBuildDispatchClaims();
    const dispatches = [];
    const result = await runBuildDispatchTick({ live: true, prepareEnabled: false, effects: {
      now: () => +NOW,
      planTick: () => ({ decisions: { counts: { buildingInFlight: 0 },
        spawnBuilds: nums.map(num => ({ num, lane: 7 })),
        admission: { queue: nums.map(num => ({ num, scope: [`we:scripts/ordering-${num}.mjs`] })), cleared: nums.map(num => ({ num, ready: true })) } },
        nextState: {} }),
      fetchOpenPrs: () => [],
      killSwitch: () => ({ engaged: false }), mainRedFreeze: () => null,
      listClaims: () => listBuildDispatchClaims(),
      releaseClaim: args => actualClaims.releaseBuildDispatchClaim(args),
      acquireClaim: args => acquireBuildDispatchClaim({ ...args, owner: 'tick:second-attempt', nowMs: +NOW }),
      listHolds: () => listBuildDispatchHolds().map(h => ({ num: h.meta.num, reason: h.meta.reason })),
      listRunStoreInFlight: () => inFlight, listSettledBuilds: () => settled,
      listBuildBackoffs: () => [], settleLaunches: () => ({ pending: [], settled: [] }),
      listPrepareInFlight: () => [], listPrepareClaims: () => [], listBorrowedFixes: () => [], listFixClaims: () => [],
      routeHeldItems: () => [], hostLoadGate: () => ({ admit: true }),
      dispatch: ({ num }) => { dispatches.push(num); return { dispatching: true, lane: 7 }; },
    } });
    return { inFlight, settled, holds, claims, dispatches, result };
  } finally { selectStores(runs, coord); }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  root = mkdtempSync(join(tmpdir(), 'deliver-ordering-'));
  lane = join(root, 'lane'); runs = join(root, 'runs'); coord = join(root, 'coord');
  for (const dir of [lane, runs, coord]) mkdirSync(dir);
  selectStores(runs, coord);
  snapshots = []; calls = []; settlementStart = null;
  vi.clearAllMocks();
  telemetryFaults.throwOnNextRootClose = false;
  telemetryFaults.failures = [];
  findItem.mockReturnValue({ num: NUM, slug: 'ordering', specPath: 'backlog/9001-ordering.md', scope: [] });
  instrument('hold', placeBuildDispatchHold, actualClaims.placeBuildDispatchHold);
  instrument('settle', settleDispatchEffect, actualSettle.settleDispatchEffect);
  instrument('release', releaseBuildDispatchClaim, actualClaims.releaseBuildDispatchClaim);
  seed();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('hold → settle → release completed persistence boundaries', () => {
  it.each(['not-ready', 'gate-red'])('%s: every successful persisted prefix prevents redispatch', async outcome => {
    const result = await deliver(outcome);
    expect(result.result).toContain(outcome);
    expect.soft(snapshots.map(s => s.operation)).toEqual(['hold', 'settle', 'release']);
    expect(snapshots.find(s => s.operation === 'settle').result).toEqual({ settled: true });
    expect(snapshots.find(s => s.operation === 'release').result).toEqual({ released: true });
    // Probe before checking order so the original settlement-first implementation produces behavioral red evidence too.
    for (const snapshot of snapshots) {
      const probe = await tickSnapshot(snapshot);
      console.log(JSON.stringify({ outcome, boundary: snapshot.operation, holds: probe.holds.map(h => h.meta.num),
        claims: probe.claims.map(c => c.meta.num), inFlight: probe.inFlight.length,
        settled: probe.settled.map(r => r.outcome), retired: probe.result.retired.length, dispatches: probe.dispatches }));
      expect.soft(probe.dispatches, `after ${snapshot.operation}`).toEqual([]);
      expect.soft(probe.holds.map(h => h.meta.num)).toEqual([NUM]);
      if (snapshot.operation === 'hold') {
        expect(snapshot.result).toMatchObject({ ok: true });
        expect.soft(probe.inFlight).toEqual([expect.objectContaining({ num: NUM, source: `run ${RUN}` })]);
        expect.soft(probe.settled).toEqual([]);
      } else {
        expect.soft(probe.inFlight).toEqual([]);
        expect.soft(probe.settled).toEqual([expect.objectContaining({ num: NUM, outcome, startedAt: NOW.toISOString() })]);
      }
      expect.soft(probe.claims.map(c => c.meta.num)).toEqual(snapshot.operation === 'release' ? [] : [NUM]);
    }
    expect.soft(calls).toEqual(['hold', 'settle', 'release']);
    expect.soft(settlementStart.holds.map(h => h.meta.num)).toEqual([NUM]);
    expect(settlementStart.claims.map(c => c.meta.num)).toEqual([NUM]);
    expect(listBuildDispatchClaims()).toEqual([]);
    // Same gates and disk snapshot, an eligible unrelated item really launches with spare capacity.
    const control = await tickSnapshot(snapshots.at(-1), [NUM, '9002']);
    expect(control.dispatches).toEqual(['9002']);
    expect(control.result.plan.freeze.frozen).toBe(false);
    // A second probe proves retirement/acquisition in the working copy never changed the immutable evidence.
    expect((await tickSnapshot(snapshots.at(-1))).dispatches).toEqual([]);
  });

  it.each([false, true])('PR success settles without hold or release (later telemetry throw: %s)', async telemetryThrow => {
    telemetryFaults.throwOnNextRootClose = telemetryThrow;
    if (telemetryThrow) await expect(deliver('pr-opened')).rejects.toThrow('telemetry root close threw after settle');
    else await deliver('pr-opened');
    expect(calls).toEqual(['settle']);
    expect(listBuildDispatchHolds()).toEqual([]);
    expect(listBuildDispatchClaims()).toHaveLength(1);
    expect(createFileRunStore(runs).read(RUN).effects[0].result.outcome).toBe('pr-opened');
  });

  it.each([{}, { runId: RUN }, { effectKey: KEY }])('missing run identity %j still holds and releases', async identity => {
    await deliver('not-ready', identity);
    expect(calls).toEqual(['hold', 'settle', 'release']);
    expect(snapshots.find(s => s.operation === 'settle').result).toMatchObject({ settled: false, reason: 'no-run-id-or-key' });
    expect(listBuildDispatchHolds()).toHaveLength(1);
    expect(listBuildDispatchClaims()).toEqual([]);
  });

  // Failures are best-effort exceptions to durability, never evidence for crash safety.
  const failures = ['hold', 'settle', 'release'].flatMap(operation =>
    ['throw', 'unsuccessful'].flatMap(mode => [false, true].map(telemetryThrow => ({ operation, mode, telemetryThrow }))));
  it.each(failures)(
    '$operation $mode preserves reporting (later telemetry throw: $telemetryThrow)', async ({ operation, mode, telemetryThrow }) => {
      const mock = { hold: placeBuildDispatchHold, settle: settleDispatchEffect, release: releaseBuildDispatchClaim }[operation];
      mock.mockImplementation(() => {
        calls.push(operation);
        if (mode === 'throw') throw new Error('injected persistence failure');
        return { ok: false, settled: false, released: false, reason: 'injected refusal' };
      });
      telemetryFaults.throwOnNextRootClose = telemetryThrow;
      if (telemetryThrow) await expect(deliver('gate-red')).rejects.toThrow('telemetry root close threw after settle');
      else expect((await deliver('gate-red')).result).toBe('gate-red');
      expect(calls).toEqual(['hold', 'settle', 'release']);
      for (const fn of [placeBuildDispatchHold, settleDispatchEffect, releaseBuildDispatchClaim]) expect(fn).toHaveBeenCalledTimes(1);
      expect(settleDispatchEffect.mock.calls[0][0].result).toEqual({ outcome: 'gate-red' });
      expect(listBuildDispatchHolds()).toHaveLength(operation === 'hold' ? 0 : 1);
      expect(listBuildDispatchClaims()).toHaveLength(operation === 'release' ? 1 : 0);
      expect(createFileRunStore(runs).read(RUN).effects[0].status).toBe(operation === 'settle' ? 'in-flight' : 'applied');
    });
});

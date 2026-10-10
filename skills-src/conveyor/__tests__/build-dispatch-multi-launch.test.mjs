// Card x3mdsyv — the builder launches up to the free slots per tick (bounded by `builder.maxLaunchesPerTick`), instead
// of one detached launch per tick (78b) that builds and prepares took turns on (#4658).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBuildDispatchTick, policyFrom } from '../build-dispatch-daemon.mjs';
import { BUILD_DISPATCH_POLICY } from '../../../scripts/conveyor/build-dispatch-policy.mjs';
import { listBuildDispatchClaims, acquireBuildDispatchClaim, releaseBuildDispatchClaim } from '../../../scripts/conveyor/build-dispatch-claim.mjs';

const BUILDS = [
  { num: '5001', scope: ['we:scripts/a.mjs'] },
  { num: '5002', scope: ['we:scripts/b.mjs'] },
  { num: '5003', scope: ['we:scripts/c.mjs'] },
];
const PREPARES = [{ num: '5101', lane: 21 }, { num: '5102', lane: 22 }];

function tickOut({ builds = BUILDS, prepares = [] } = {}) {
  return {
    decisions: {
      statusLine: 't', counts: { building: 0 },
      spawnBuilds: builds.map((b, i) => ({ num: b.num, lane: 10 + i })),
      admission: { queue: builds.map((b) => ({ num: b.num, scope: b.scope })), cleared: builds.map((b) => ({ num: b.num, ready: true })) },
      spawnPrepareItems: prepares,
    },
    nextState: { tick: 1, buildGuards: [], launchedNums: [] },
  };
}

function effectsFor(lockRoot, over = {}) {
  return {
    planTick: () => tickOut(),
    fetchOpenPrs: () => [{ repo: 'web-everything', prs: [] }],
    listClaims: () => listBuildDispatchClaims({ lockRoot }).filter((c) => !c.meta?.prepare),
    releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
    acquireClaim: ({ num, scope }) => acquireBuildDispatchClaim({ num, scope, owner: 'h:1', pid: process.pid, lockRoot }),
    listRunStoreInFlight: () => [],
    listSettledBuilds: () => [],
    killSwitch: () => ({ engaged: false }),
    // Detached launches (the live path): a pending launch is a success the next tick settles.
    settleLaunches: async () => ({ pending: [], settled: [] }),
    dispatch: vi.fn(() => ({ dispatching: true, pending: true })),
    ...over,
  };
}

const policy = (maxLaunchesPerTick, extra = {}) => ({ ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 3, maxLaunchesPerTick, ...extra });

describe('builder multi-launch per tick (x3mdsyv)', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-multi-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('N free slots → N launches in one tick (free-slots), in the planned order', async () => {
    const effects = effectsFor(lockRoot);
    const r = await runBuildDispatchTick({ live: true, effects, policy: policy('free-slots') });
    expect(r.dispatched.map((d) => d.num)).toEqual(['5001', '5002', '5003']);
    expect(effects.dispatch).toHaveBeenCalledTimes(3);
    expect(listBuildDispatchClaims({ lockRoot }).map((c) => c.meta.num).sort()).toEqual(['5001', '5002', '5003']);
    expect(r.launchPolicy).toMatchObject({ maxLaunchesPerTick: 'free-slots' });
  });

  it('never launches more than the free slots allow', async () => {
    const effects = effectsFor(lockRoot);
    const r = await runBuildDispatchTick({ live: true, effects, policy: policy('free-slots', { maxConcurrentBuilds: 2 }) });
    expect(r.dispatched.map((d) => d.num)).toEqual(['5001', '5002']);
  });

  it('maxLaunchesPerTick = 2 bounds the tick below the free slots', async () => {
    const effects = effectsFor(lockRoot);
    const r = await runBuildDispatchTick({ live: true, effects, policy: policy(2) });
    expect(r.dispatched.map((d) => d.num)).toEqual(['5001', '5002']);
  });

  it('maxLaunchesPerTick = 1 is the old behaviour: one launch, and none while an earlier one is still starting', async () => {
    const one = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot), policy: policy(1) });
    expect(one.dispatched.map((d) => d.num)).toEqual(['5001']);
    const dispatch = vi.fn(() => ({ dispatching: true, pending: true }));
    const settleLaunches = async () => ({ pending: [{ num: '5001', kind: 'build' }], settled: [] });
    const next = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { dispatch, settleLaunches }), policy: policy(1) });
    expect(dispatch).not.toHaveBeenCalled();
    expect(next.dispatched).toEqual([]);
  });

  it('a policy without the field (an older caller) keeps the one-launch behaviour', async () => {
    const r = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot), policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 3 } });
    expect(r.dispatched).toHaveLength(1);
  });

  it('same-tick scope overlap: two candidates on the same file → only the first launches', async () => {
    const builds = [{ num: '5001', scope: ['we:scripts/a.mjs'] }, { num: '5002', scope: ['we:scripts/a.mjs'] }, { num: '5003', scope: ['we:scripts/c.mjs'] }];
    const effects = effectsFor(lockRoot, { planTick: () => tickOut({ builds }) });
    const r = await runBuildDispatchTick({ live: true, effects, policy: policy('free-slots') });
    expect(r.dispatched.map((d) => d.num)).toEqual(['5001', '5003']);
    expect(r.plan.hold).toEqual(expect.arrayContaining([expect.objectContaining({ num: '5002', rule: 'hot-file' })]));
  });

  it('failure isolation: a throwing dispatch and a throwing claim never abort the other launches', async () => {
    const dispatch = vi.fn(({ num }) => {
      if (num === '5001') throw new Error('spawn exploded');
      return { dispatching: true, pending: true };
    });
    const base = effectsFor(lockRoot);
    const acquireClaim = vi.fn((o) => { if (o.num === '5002') throw new Error('lock dir unreadable'); return base.acquireClaim(o); });
    const r = await runBuildDispatchTick({ live: true, effects: { ...base, dispatch, acquireClaim }, policy: policy('free-slots') });
    expect(r.dispatched.map((d) => d.num)).toEqual(['5003']);
    expect(r.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ num: '5001', stage: 'dispatch', reason: 'spawn exploded' }),
      expect.objectContaining({ num: '5002', stage: 'claim', reason: expect.stringContaining('lock dir unreadable') }),
    ]));
    // The failed launch's claim is released; only the live one is held.
    expect(listBuildDispatchClaims({ lockRoot }).map((c) => c.meta.num)).toEqual(['5003']);
  });

  it('a host-load refusal of one launch does not stop the next (re-read per launch)', async () => {
    let n = 0;
    const hostLoadGate = vi.fn(() => (++n === 1 ? { admit: false, kind: 'host-load', why: 'busy' } : { admit: true }));
    const r = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { hostLoadGate }), policy: policy('free-slots') });
    expect(r.loadHolds).toEqual([expect.objectContaining({ num: '5001', reason: 'host-load' })]);
    expect(r.dispatched.map((d) => d.num)).toEqual(['5002', '5003']);
    expect(hostLoadGate).toHaveBeenCalledTimes(3);
  });

  it('builds and prepares launch in the same tick; the shared bound counts both kinds', async () => {
    const prepareRoot = mkdtempSync(join(tmpdir(), 'bdd-multi-prep-'));
    try {
      const prepareEffects = {
        placePrepareHold: vi.fn(), releasePrepareHold: vi.fn(),
        listPrepareInFlight: () => [],
        listPrepareClaims: () => listBuildDispatchClaims({ lockRoot: prepareRoot }),
        acquirePrepareClaim: (o) => acquireBuildDispatchClaim({ ...o, lockRoot: prepareRoot, owner: 'host:10', pid: 10 }),
        releasePrepareClaim: (o) => releaseBuildDispatchClaim({ ...o, lockRoot: prepareRoot }),
      };
      const builds = [BUILDS[0]];
      const all = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { ...prepareEffects, planTick: () => tickOut({ builds, prepares: PREPARES }) }), policy: policy('free-slots') });
      expect(all.dispatched.map((d) => d.num)).toEqual(['5001']);
      expect(all.prepare.launched.map((p) => p.num)).toEqual(['5101', '5102']);
      for (const p of PREPARES) releaseBuildDispatchClaim({ num: p.num, lockRoot: prepareRoot });
      releaseBuildDispatchClaim({ num: '5001', lockRoot });
      const two = await runBuildDispatchTick({ live: true, effects: effectsFor(lockRoot, { ...prepareEffects, planTick: () => tickOut({ builds, prepares: PREPARES }) }), policy: policy(2) });
      expect(two.dispatched.length + two.prepare.launched.length).toBe(2);
    } finally { rmSync(prepareRoot, { recursive: true, force: true }); }
  });

  it('a card is never launched twice in one tick (build and prepare of the same num)', async () => {
    const prepareRoot = mkdtempSync(join(tmpdir(), 'bdd-multi-dup-'));
    try {
      const effects = effectsFor(lockRoot, {
        planTick: () => tickOut({ builds: [BUILDS[0]], prepares: [{ num: '5001', lane: 21 }] }),
        placePrepareHold: vi.fn(), releasePrepareHold: vi.fn(), listPrepareInFlight: () => [],
        listPrepareClaims: () => listBuildDispatchClaims({ lockRoot: prepareRoot }),
        acquirePrepareClaim: (o) => acquireBuildDispatchClaim({ ...o, lockRoot: prepareRoot, owner: 'host:10', pid: 10 }),
        releasePrepareClaim: (o) => releaseBuildDispatchClaim({ ...o, lockRoot: prepareRoot }),
      });
      const r = await runBuildDispatchTick({ live: true, effects, policy: policy('free-slots') });
      expect(effects.dispatch).toHaveBeenCalledTimes(1);
      expect(r.dispatched.length + r.prepare.launched.length).toBe(1);
    } finally { rmSync(prepareRoot, { recursive: true, force: true }); }
  });

  it('policyFrom resolves builder.maxLaunchesPerTick through the cascade (env layer wins, source named)', () => {
    expect(policyFrom({}, { WE_BUILDER_MAX_LAUNCHES_PER_TICK: '2' })).toMatchObject({ maxLaunchesPerTick: 2, maxLaunchesPerTickSource: 'env' });
    const p = policyFrom({}, {});
    expect(['standard', 'platform', 'tool']).toContain(p.maxLaunchesPerTickSource);
  });
});

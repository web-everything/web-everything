import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESOURCE_GATE_STANDARD } from '../../../scripts/lib/resource-gate.mjs';
import { listFixDispatchClaims } from '../../../scripts/conveyor/fix-claim-store.mjs';
import * as healDispatch from '../../../scripts/operations/ci-heal-pr-dispatch.mjs';
import * as routing from '../../../scripts/lib/fix-slot-borrow.mjs';
import * as heavyAdmission from '../../../scripts/readiness/heavy-admission.mjs';
import * as daemon from '../reconcile-fix-dispatch-daemon.mjs';
import { runReconcileFixDispatch } from '../../../scripts/conveyor/reconcile-fix-dispatch.mjs';
import { sweepCiRedRecovery } from '../../../scripts/conveyor/ci-red-recovery-watch.mjs';

const empty = () => ({ dispatched: [], applied: [], refusals: [], notes: [], prsByNumber: new Map() });
export function tickFixture(extra = {}) {
  return { repos: ['a'], fixTick: empty, ciHealTick: empty, hungCiTick: empty,
    mainRedRebaseTick: empty, missingRunTick: empty, promoteDraftTick: empty, notesTick: empty,
    awaitVerifyTick: () => ({ rows: [] }), stuckFixerTick: () => ({ rows: [] }),
    budgetRotation: {}, prCursors: {}, fenceOk: () => true, ...extra };
}

describe('cooperative ci-heal slices', () => {
  it('ci-heal cadence is independent of slow phases', async () => {
    let time = 0;
    const slices = [];
    const maybe = daemon.createCiHealSlicer({ now: () => time, fenceOk: () => true,
      runSlice: () => slices.push(time), log: () => {} });
    // Three forty-minute ticks, with eight slow phases of ten 30-second PR steps each.
    for (let tick = 0; tick < 3; tick++) for (let phase = 0; phase < 8; phase++) {
      for (let pr = 0; pr < 10; pr++) { await maybe(); time += 30000; }
      await maybe();
    }
    expect(slices.length).toBeGreaterThanOrEqual(60);
    expect(Math.max(...slices.slice(1).map((at, i) => at - slices[i]))).toBeLessThanOrEqual(150000);
    expect(time - slices.at(-1)).toBeLessThanOrEqual(150000);
  });

  it('no slice runs after lease loss or when lease state is unknown or unreadable', async () => {
    let time = 0, lease = true, count = 0;
    const logs = [];
    const maybe = daemon.createCiHealSlicer({ now: () => time,
      fenceOk: () => { if (lease === 'throw') throw Error('unreadable'); return lease; },
      runSlice: () => count++, log: line => logs.push(line) });
    await maybe();
    for (lease of [false, undefined, null, 'throw']) { time += 120000; await maybe(); }
    expect(count).toBe(1);
    expect(logs.filter(line => line.includes('ci-heal-slice-skipped lease'))).toHaveLength(4);
  });

  it('a slice never nests and logs the nested refusal', async () => {
    let count = 0;
    const logs = [];
    const maybe = daemon.createCiHealSlicer({ now: () => 0, fenceOk: () => true,
      runSlice: async () => { count++; await maybe(); }, log: line => logs.push(line) });
    await maybe();
    expect(count).toBe(1);
    expect(logs.some(line => line.includes('ci-heal-slice-skipped nested'))).toBe(true);
  });

  it('a throwing slice is logged and the next interval still runs', async () => {
    let time = 0, count = 0;
    const logs = [];
    const maybe = daemon.createCiHealSlicer({ now: () => time, fenceOk: () => true,
      runSlice: () => { if (++count === 1) throw Error('broken'); }, log: line => logs.push(line) });
    await expect(maybe()).resolves.toBeUndefined();
    await maybe();
    expect(count).toBe(1);
    time += 120000;
    await maybe();
    expect(count).toBe(2);
    expect(logs.some(line => line.includes('ci-heal-slice-failed') && line.includes('broken'))).toBe(true);
    expect(logs.filter(line => /gate slice (done|admitted|refused) at=/.test(line))).toHaveLength(1);
  });

  it.each([
    [{ dispatched: [{}], refusals: [] }, 'admitted'],
    [{ dispatched: [], refusals: [{}] }, 'refused'],
    [{ dispatched: [], refusals: [] }, 'done'],
  ])('logs completion outcome only after dispatch resolves (%j)', async (result, outcome) => {
    const logs = [];
    let finish;
    const maybe = daemon.createCiHealSlicer({ fenceOk: () => true, now: () => 0,
      log: line => logs.push(line), runSlice: () => new Promise(resolve => { finish = resolve; }) });
    const pending = maybe();
    await Promise.resolve();
    expect(logs.filter(line => /gate slice (done|admitted|refused) at=/.test(line))).toEqual([]);
    finish(result);
    await pending;
    expect(logs.at(-1)).toContain(`gate slice ${outcome} at=`);
  });

  it('main-red-rebase honors budgetMs and reports budgetHit', async () => {
    let time = 0;
    const visited = [], deadlines = [];
    const result = await daemon.runTickAllRepos(tickFixture({ repos: ['a', 'b', 'c'], now: () => time,
      passBudgets: daemon.resolveFixPassBudgets({ env: {}, file: { fixPassBudget: { mainRedRebaseMs: 1000 } } }),
      mainRedRebaseTick: ({ repo, deadlineAt }) => { visited.push(repo); deadlines.push(deadlineAt); time += 1001; return empty(); },
    }));
    expect(visited).toEqual(['a']);
    expect(deadlines).toEqual([1000]);
    expect(result.budgets['main-red-rebase']).toMatchObject({ budgetMs: 1000, hit: true });
    expect(daemon.formatPassPhaseTiming(result).join(' ')).toContain('phase=main-red-rebase ms=1001 budgetMs=1000 budgetHit=true');
  });

  it('resolves the main-red-rebase default, env override, cap and invalid fallback', () => {
    const read = env => daemon.resolveFixPassBudgets({ env, file: {} }).mainRedRebaseMs;
    expect(read({})).toEqual({ value: 120000, source: 'standard' });
    expect(read({ WE_FIX_BUDGET_MAIN_RED_REBASE_MS: '5000' })).toEqual({ value: 5000, source: 'env' });
    expect(read({ WE_FIX_BUDGET_MAIN_RED_REBASE_MS: '99999999' }).value).toBe(600000);
    expect(read({ WE_FIX_BUDGET_MAIN_RED_REBASE_MS: 'bad' }).value).toBe(120000);
  });

  it('runTickAllRepos fires slices during slow phases at per-PR boundaries', async () => {
    let time = 0;
    const slices = [], phases = [];
    const slow = name => async ({ maybeCiHealSlice }) => {
      for (let pr = 0; pr < 10; pr++) { time += 30000; await maybeCiHealSlice(); }
      phases.push(name); return empty();
    };
    await daemon.runTickAllRepos(tickFixture({ now: () => time,
      ciHealTick: () => { slices.push(time); return empty(); },
      fixTick: slow('fix'), hungCiTick: slow('hung-ci'), mainRedRebaseTick: slow('main-red-rebase'),
      missingRunTick: slow('missing-run'), promoteDraftTick: slow('promote-draft'),
    }));
    expect(phases).toHaveLength(5);
    expect(slices.length).toBeGreaterThan(10);
    expect(Math.max(...slices.slice(1).map((at, i) => at - slices[i]))).toBeLessThanOrEqual(150000);
  });
  it('runTickAllRepos refuses all slices with no lease evidence', async () => {
    let count = 0;
    const logs = [];
    await expect(daemon.runTickAllRepos(tickFixture({ fenceOk: undefined,
      ciHealTick: () => { count++; return empty(); }, log: line => logs.push(line) }))).rejects.toThrow('lease lost or unreadable');
    expect(count).toBe(0);
    expect(logs.some(line => line.includes('ci-heal-slice-skipped lease'))).toBe(true);
  });

  it('a short tick keeps one phase-order slice and never double-runs it', async () => {
    let count = 0;
    await daemon.runTickAllRepos(tickFixture({ now: () => 0,
      ciHealTick: () => { count++; return empty(); }, log: () => {} }));
    expect(count).toBe(1);
  });

  it('main-red-rebase uses the smaller existing recovery apply budget', async () => {
    const prior = process.env.WE_RECOVERY_APPLY_BUDGET_MS;
    const received = [];
    process.env.WE_RECOVERY_APPLY_BUDGET_MS = '10000';
    try {
      await daemon.runTickAllRepos(tickFixture({ now: () => 0, log: () => {},
        mainRedRebaseTick: options => { received.push(options); return empty(); } }));
      expect(received[0].deadlineAt).toBe(10000);
      expect(received[0].applyBudgetMs).toBe(10000);
    } finally {
      if (prior === undefined) delete process.env.WE_RECOVERY_APPLY_BUDGET_MS;
      else process.env.WE_RECOVERY_APPLY_BUDGET_MS = prior;
    }
  });

  it('measures cadence from slice start rather than adding its duration to the interval', async () => {
    let time = 0;
    const starts = [];
    const maybe = daemon.createCiHealSlicer({ now: () => time, fenceOk: () => true, log: () => {},
      runSlice: () => { starts.push(time); time += 60000; } });
    await maybe();
    time = 120000;
    await maybe();
    expect(starts).toEqual([0, 120000]);
  });

  it('the real main-red PR loop stops at the daemon deadline even when the recovery progress floor remains', async () => {
    let time = 0, writes = 0, boundaries = 0;
    const prs = [1, 2, 3].map(number => ({ number, headRefName: `lane/${number}`, headRefOid: `head-${number}`,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE',
        completedAt: '2026-09-25T01:57:47Z' }] }));
    const result = await sweepCiRedRecovery({ requiredCheck: 'test', apply: true, now: () => time,
      deadlineAt: 1000, applyBudgetMs: 170000, readOpenPrs: () => prs,
      readMainRuns: () => [
        { status: 'completed', conclusion: 'failure', updatedAt: '2026-09-25T01:30:55Z', workflowName: 'CI' },
        { status: 'completed', conclusion: 'success', updatedAt: '2026-09-25T02:31:25Z', workflowName: 'CI' }],
      readMainLatestCheckRuns: () => [], readAheadBy: () => 33, readComments: () => [],
      readPriority: () => null, exhaustedRetrySettings: { enabled: false }, checkClaim: () => null,
      maybeCiHealSlice: async () => { boundaries++; },
      refresh: () => { writes++; time += 1001; return { ok: true, action: 'rebased' }; },
      postComment: () => {},
    });
    expect(writes).toBe(1);
    expect(boundaries).toBeGreaterThanOrEqual(3);
    expect(result.applied.slice(1)).toHaveLength(2);
    expect(result.applied.slice(1).every(row => row.budgetExhausted && row.deferred)).toBe(true);
  });

  it('each admission re-reads sibling claims and refuses unreadable claim evidence', () => {
    let claims = [];
    const now = Date.now();
    const throttle = daemon.buildFixThrottle({ slotClaims: () => {
      if (claims === null) throw Error('unreadable'); return claims;
    }, settings: { cutover: 'enforce', fixCap: { ...RESOURCE_GATE_STANDARD.fixCap, floor: 2, ceiling: 2 } },
      sendBackReservedSlots: 0, env: {}, gate: () => ({ admit: true }), log() {},
      readSnap: () => ({ sampledAt: new Date(now).toISOString(), freshUntil: new Date(now + 1000).toISOString(),
        memory: { metric: 'available', availableMb: 10000, pressureLevel: 1 } }),
      resolveFloor: () => ({ metric: 'available', floorMb: 1 }), nowMs: () => now });
    expect(throttle.tryAdmit('fix').admit).toBe(true);
    claims = [{ meta: { kind: 'fix' } }, { meta: { kind: 'ci-heal' } }];
    expect(throttle.tryAdmit('ci-heal')).toMatchObject({ admit: false, kind: 'fix-cap' });
    const launch = vi.fn();
    for (claims of [null, undefined, {}]) {
      const decision = throttle.tryAdmit('fix');
      if (decision.admit) launch();
      expect(decision).toMatchObject({ admit: false, kind: 'claims-unreadable' });
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it('strict live claim reads refuse corrupt persisted old state instead of counting zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heal-claims-'));
    try {
      mkdirSync(join(dir, 'old')); writeFileSync(join(dir, 'old', 'lock.json'), '{');
      expect(() => listFixDispatchClaims(dir, { strict: true, liveOnly: true })).toThrow('incomplete fix claim');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const assertDispatchFence = async evidence => {
    let owned = true;
    const dispatch = vi.spyOn(healDispatch, 'dispatchCiHeal').mockResolvedValue({});
    const realRoute = routing.createRoutedCiHealDispatch;
    const prepared = vi.fn();
    vi.spyOn(routing, 'createRoutedCiHealDispatch').mockImplementation(options => realRoute({ ...options,
      staleBaseGate: async () => { await Promise.resolve(); owned = evidence; prepared(); return {}; },
      route: () => ({ executor: 'claude' }), createSinks: () => ({}),
    }));
    vi.spyOn(heavyAdmission, 'resolveLiveQueueBaseline').mockReturnValue({ bypassed: 'fixture' });
    vi.spyOn(healDispatch, 'runReconcileCiHealDispatch').mockImplementation(async options => {
      // This reaches the daemon's actual routed-dispatch binding after asynchronous preparation.
      try { await options.dispatch({ pr: 7, scope: [] }, { repo: 'we' }); }
      catch (error) { return { ...empty(), refusals: [{ kind: 'dispatch-failed', why: error.message }] }; }
      return empty();
    });
    try {
      const tick = daemon.runTickAllRepos(tickFixture({ ciHealTick: undefined,
        fenceOk: () => { if (owned === 'unreadable') throw Error('lease read failed'); return owned; },
        authGateOverride: () => ({ paused: false }), log: () => {},
      }));
      await expect(tick).rejects.toThrow('lease lost or unreadable');
      expect(prepared).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  };
  it('dispatch boundary refuses lease loss after asynchronous preparation', () => assertDispatchFence(false));
  it.each([undefined, null, 'unreadable'])('dispatch boundary refuses unreadable lease evidence after preparation (%s)',
    assertDispatchFence);

  it.each([false, undefined, 'unreadable'])('lease loss between fix entries prevents subsequent launches (evidence=%s)', async lost => {
    let owned = true, time = 0;
    const launched = [];
    const fixTick = options => runReconcileFixDispatch({ ...options, repo: null, root: '/repo',
      checkStaleness: () => ({ fresh: true, behind: 0 }),
      reconcile: () => ({ dispatch: [41, 42].map(prNumber => ({ kind: 'fix', prNumber,
        headRefName: `fix-branch-${prNumber}` })), refusals: [] }),
      findItemFn: () => null, loadItems: () => [], fetchItemlessDiffPaths: pr => [`src/${pr}.ts`],
      pickFreeLanes: () => [2, 9], listBuildClaims: () => [], listFixClaims: () => [],
      priorityShadow: null, tryResume: () => ({ resumed: false }), tryResumeRound: null, stepLog: () => {},
      dispatch: entry => { launched.push(entry.pr); owned = lost; time += 120000; return { agentId: 'first' }; },
    });
    const tick = daemon.runTickAllRepos(tickFixture({ fixTick, now: () => time, log: () => {},
      fenceOk: () => { if (owned === 'unreadable') throw Error('unreadable lease'); return owned; },
    }));
    await expect(tick).rejects.toThrow(/lease.*retry|lease.*lost/);
    expect(launched).toEqual([41]);
  });

});

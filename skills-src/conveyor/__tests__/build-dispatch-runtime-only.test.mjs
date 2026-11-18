import { describe, it, expect, vi } from 'vitest';
import { planTick } from '../../../scripts/conveyor/tick-core.mjs';
import { runBuildDispatchTick, buildPriorityLog } from '../build-dispatch-daemon.mjs';
import { BUILD_DISPATCH_POLICY } from '../../../scripts/conveyor/build-dispatch-policy.mjs';
import { resolveCostAdmissionSettings } from '../../../scripts/lib/cost-admission.mjs';
import { resolvePreparePolicy } from '../../../scripts/conveyor/prepare-policy-settings.mjs';

const only = ids => ({ ids, source: 'runtime', mode: 'only', only: true });
const nums = rows => rows.map(r => String(r.num));
const builds = ['8001', '8002'].map(num => ({ num, ready: true, buildQueued: true, scope: [`we:scripts/build-${num}.mjs`] }));
const rows = ['7201', '7202', '7203', '7204'].map((num, i) => ({ num,
  kind: 'task', size: 1, parent: '7200', locus: 'we', scope: [`we:scripts/runtime-${i}.mjs`] }));
function input(buildPriority, extra = {}) {
  return {
    state: { queue: [...rows, ...builds], lanes: [], prs: [] },
    plan: { cleared: builds, launch: [{ num: '8001', lane: 20 }, { num: '8002', lane: 21 }],
      held: rows.map(r => ({ num: r.num, reason: 'needs-prepare' })) },
    freeLanes: [1, 2, 3, 4, 5, 6],
    config: { prepareAheadWindow: 2, ...(buildPriority ? { buildPriority } : {}) },
    now: Date.parse('2026-11-18T13:14:00Z'), ...extra,
  };
}
function effectsFor(out) {
  return {
    planTick: vi.fn(() => out), fetchOpenPrs: () => [], listClaims: () => [],
    listRunStoreInFlight: () => [], listPreparePrs: () => [],
    listPrepareInFlight: () => [], listPrepareClaims: () => [], listHolds: () => [],
    killSwitch: () => ({ engaged: false }),
    preparePolicy: () => resolvePreparePolicy({ env: {} }),
    readPrepareStatus: () => ({ preparedDate: null }),
    readPreparedStamp: () => ({ preparedDate: null }),
    acquirePrepareClaim: () => ({ ok: true }), releasePrepareClaim: vi.fn(),
    acquireClaim: () => ({ ok: true }), releaseClaim: vi.fn(),
    dispatch: vi.fn(() => ({ dispatching: true })),
  };
}
const policy = { ...BUILD_DISPATCH_POLICY, maxLaunchesPerTick: 'free-slots', maxConcurrentBuilds: 3 };

describe('runtime-only build dispatch', () => {
  it('filters new build and prepare candidates before admission, keeping listed cards', async () => {
    const settings = only(['8001', '7202']);
    const effects = effectsFor(null);
    effects.planTick = vi.fn((bookkeeping, { config }) => planTick({ ...input(), bookkeeping, config }));
    const tick = await runBuildDispatchTick({ live: true, effects, policy, buildPriority: settings });
    expect(effects.planTick.mock.calls[0][1].config.buildPriority).toBe(settings);
    expect(nums(tick.dispatched)).toEqual(['8001']);
    expect(nums(tick.prepare.launched)).toEqual(['7202']);
    expect(tick.runtimeOnly.filteredBuild).toEqual(['8002']);
    expect(tick.prepare.filteredByRuntimeOnly).toEqual(['7201', '7203', '7204']);
    expect(buildPriorityLog(settings, tick).line).toContain(' · runtime-only: filteredBuild=1 filteredPrepare=3');
  });

  it('drops outside members from an allowed lead’s prepare group', async () => {
    const out = { decisions: { spawnPrepareItems: [rows[0]], admission: { queue: rows,
      held: rows.map(r => ({ num: r.num, reason: 'needs-prepare' })) } }, nextState: {} };
    const effects = effectsFor(out);
    const tick = await runBuildDispatchTick({ live: true, effects, policy,
      buildPriority: only(['9999', '7201', '7202']) });
    expect(tick.prepare.planned[0]).toMatchObject({ num: '7201', groupMembers: ['7202'] });
    expect(effects.dispatch.mock.calls[0][0].groupMembers).toEqual(['7202']);
    expect(tick.prepare.filteredByRuntimeOnly).toEqual(['7203', '7204']);
  });

  it('held malformed settings plan no new builds or prepares, including with an older planner', async () => {
    const settings = { ...only([]), held: true, runtime: { warning: 'repair or remove the runtime file' } };
    const effects = effectsFor(planTick(input()));
    const tick = await runBuildDispatchTick({ live: true, effects, policy, buildPriority: settings });
    expect(tick.plan.dispatch).toEqual([]);
    expect(tick.prepare.planned).toEqual([]);
    expect(effects.dispatch).not.toHaveBeenCalled();
    expect(buildPriorityLog(settings, tick).line).toContain('repair or remove the runtime file');
    const core = planTick(input(settings));
    expect(core.decisions.spawnBuilds).toEqual([]);
    expect(core.decisions.spawnPrepareItems).toEqual([]);
  });

  it('lift and no runtime file preserve the complete pure-core output', () => {
    const baseline = planTick(input());
    expect(planTick(input({ ids: ['7204'], mode: 'lift', source: 'runtime', only: false }))).toEqual(baseline);
    expect(planTick(input({ ids: [], source: 'standard' }))).toEqual(baseline);
  });

  it('filters unshaped, decision, investigation, stale and auto-size lists before cost admission', () => {
    const data = input(only(['7202']), {
      state: { queue: rows, unshaped: [{ num: '9001' }], decisions: [{ num: '9002', prepared: false }], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: '7201', reason: 'prepare-stale' }, { num: '7202', reason: 'no-size' },
        { num: '9003', reason: 'needs-investigation' }, { num: '9004', reason: 'no-size' }] },
    });
    data.config.prepareAutoSize = true;
    const { decisions } = planTick(data);
    expect(nums(decisions.spawnPrepareItems)).toEqual(['7202']);
    expect(decisions.spawnPrepareScope).toEqual([]);
    expect(decisions.spawnPrepareDecision).toEqual([]);
    expect(decisions.spawnInvestigations).toEqual([]);
    expect(decisions.runtimeOnly.filteredPrepare.sort()).toEqual(['7201', '9001', '9002', '9003', '9004']);
  });

  it('gives only the new top id one extra prepare slot beyond the cap and window', async () => {
    const settings = only(['7204', '7201', '7202', '7203']);
    const out = planTick(input(settings));
    expect(nums(out.decisions.spawnPrepareItems)).toEqual(['7201', '7202', '7204']);
    const effects = effectsFor(out);
    effects.predictRoute = () => ({ groupCapable: false });
    const tick = await runBuildDispatchTick({ live: true, effects, policy, buildPriority: settings });
    expect(nums(tick.prepare.launched)).toEqual(['7201', '7202', '7204']);
    const absent = planTick(input(only(['9999', '7201', '7202', '7203', '7204'])));
    expect(nums(absent.decisions.spawnPrepareItems)).toEqual(['7201', '7202']);
  });

  it('reserves the bonus window for a top id at the head, and never lends it to another card', () => {
    const settings = only(['7201', '7202', '7203', '7204']);
    expect(nums(planTick(input(settings)).decisions.spawnPrepareItems)).toEqual(['7201', '7202', '7203']);
    const data = input(settings);
    data.bookkeeping = { tick: 1, prepareGuards: [{ num: '7201', kind: 'prepare-item', lane: 1, spawnedTick: 1 }] };
    expect(nums(planTick(data).decisions.spawnPrepareItems)).toEqual(['7202']);
  });

  it('honors the top-only bonus under light cost admission and still refuses the CPU floor', async () => {
    const settings = only(['7204', '7201', '7202', '7203']);
    const costAdmission = { ...resolveCostAdmissionSettings({ env: { WE_COST_ADMISSION: 'on' } }), lightMaxConcurrent: 2 };
    const data = input(settings);
    data.config.costAdmission = costAdmission;
    const make = idle => ({ ...effectsFor(planTick(data)),
      predictRoute: () => ({ groupCapable: false }), costFacts: () => ({ cpuIdlePct: idle }) });
    const tick = await runBuildDispatchTick({ live: true, effects: make(80), policy: { ...policy, costAdmission }, buildPriority: settings });
    expect(nums(tick.prepare.launched)).toEqual(['7201', '7202', '7204']);
    const blocked = await runBuildDispatchTick({ live: true, effects: make(0), policy: { ...policy, costAdmission }, buildPriority: settings });
    expect(blocked.prepare.launched).toEqual([]);
  });

  it('preserves daemon output for lift/no-file settings apart from timing measurements', async () => {
    const out = planTick(input());
    const run = async buildPriority => {
      const { timings, ...result } = await runBuildDispatchTick({ effects: effectsFor(out), policy, buildPriority });
      return result;
    };
    const baseline = await run();
    expect(await run({ ids: ['7204'], mode: 'lift', source: 'runtime', only: false })).toEqual(baseline);
    expect(await run({ ids: [], source: 'standard' })).toEqual(baseline);
  });

  it('retains in-flight guards outside the allowlist when held', () => {
    const data = input({ ...only([]), held: true });
    data.bookkeeping = { tick: 1, prepareGuards: [{ num: '7201', kind: 'prepare-item', lane: 1, spawnedTick: 1 }],
      buildGuards: [{ num: '8001', lane: 20, spawnedTick: 1 }] };
    const out = planTick(data);
    expect(nums(out.nextState.prepareGuards)).toContain('7201');
    expect(nums(out.nextState.buildGuards)).toContain('8001');
  });
});

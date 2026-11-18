import { describe, it, expect, vi } from 'vitest';
import { dispatchPlan, projectBuildQueueRow } from '../../../scripts/readiness/dispatch-plan.mjs';
import { shapeQueue } from '../../../scripts/readiness/conveyor-state.mjs';
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

  it('admits nothing for the top listed id with prepare concurrency 0', async () => {
    const settings = only(['7204']);
    const data = input(settings);
    data.config.maxConcurrentItemPrepares = 0;
    expect(planTick(data).decisions.spawnPrepareItems).toEqual([]);
    const costAdmission = { ...resolveCostAdmissionSettings({ env: { WE_COST_ADMISSION: 'on' } }), lightMaxConcurrent: 0 };
    data.config.costAdmission = costAdmission;
    expect(planTick(data).decisions.spawnPrepareItems).toEqual([]);
    // Older planner output must also obey the daemon's configured zero cap.
    const effects = effectsFor(planTick(input(settings)));
    effects.costFacts = () => ({ cpuIdlePct: 80 });
    const tick = await runBuildDispatchTick({ live: true, effects, policy: { ...policy, costAdmission }, buildPriority: settings });
    expect(tick.prepare.planned).toEqual([]);
    expect(tick.prepare.launched).toEqual([]);
    expect(effects.dispatch).not.toHaveBeenCalled();
  });

  it('launches no allowed prepare with prepareAheadWindow 0, including with an older planner', async () => {
    const effects = effectsFor({ decisions: { spawnPrepareItems: [rows[0]],
      admission: { queue: [rows[0]], held: [{ num: '7201', reason: 'needs-prepare' }] } }, nextState: {} });
    const tick = await runBuildDispatchTick({ live: true, effects,
      policy: { ...policy, prepareAheadWindow: 0, prepareAheadWindowExplicit: true },
      buildPriority: only(['7201']) });
    expect(tick.prepare.planned).toEqual([]);
    expect(tick.prepare.launched).toEqual([]);
    expect(effects.dispatch).not.toHaveBeenCalled();
  });

  it('admits nothing for the top listed id when builds fill prepareAheadWindow', async () => {
    const settings = only(['7204', '8001', '8002']);
    const data = input(settings);
    data.state.queue = [...builds, ...rows];
    const out = planTick(data);
    expect(out.decisions.spawnPrepareItems).toEqual([]);
    const effects = effectsFor(out);
    const tick = await runBuildDispatchTick({ live: true, effects,
      policy: { ...policy, prepareAheadWindow: 2, prepareAheadWindowExplicit: true }, buildPriority: settings });
    expect(tick.prepare.planned).toEqual([]);
    expect(tick.prepare.launched).toEqual([]);
    expect(effects.dispatch.mock.calls.every(([pick]) => pick.launchKind !== 'prepare-item')).toBe(true);
  });

  it('keeps top listed ids within the ordinary window, including with an in-flight top id', () => {
    const settings = only(['7201', '7202', '7203', '7204']);
    expect(nums(planTick(input(settings)).decisions.spawnPrepareItems)).toEqual(['7201', '7202']);
    const data = input(settings);
    data.bookkeeping = { tick: 1, prepareGuards: [{ num: '7201', kind: 'prepare-item', lane: 1, spawnedTick: 1 }] };
    expect(nums(planTick(data).decisions.spawnPrepareItems)).toEqual(['7202']);
  });

  it('obeys light concurrency and the CPU floor for the top listed id', async () => {
    const settings = only(['7204', '7201', '7202', '7203']);
    const costAdmission = { ...resolveCostAdmissionSettings({ env: { WE_COST_ADMISSION: 'on' } }), lightMaxConcurrent: 2 };
    const data = input(settings);
    data.config.costAdmission = costAdmission;
    const make = idle => ({ ...effectsFor(planTick(data)),
      predictRoute: () => ({ groupCapable: false }), costFacts: () => ({ cpuIdlePct: idle }) });
    const tick = await runBuildDispatchTick({ live: true, effects: make(80), policy: { ...policy, costAdmission }, buildPriority: settings });
    expect(nums(tick.prepare.launched)).toEqual(['7201', '7202']);
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

it('runtime-only removes an unlisted epic child before lane and rival-scope assignment', () => {
  const queue = [
    { num: '7000', kind: 'epic' },
    { num: '7001', parent: '7000', kind: 'task', scope: ['we:scripts/shared.mjs'] },
    { num: '8001', kind: 'task', scope: ['we:scripts/shared.mjs'] },
  ];
  const settings = only(['7000', '8001']);
  const plan = dispatchPlan({ queue, leases: [], freeLanes: [20, 21], buildPriority: settings });
  const out = planTick({ state: { queue }, plan, freeLanes: [20, 21], config: { buildPriority: settings } });
  expect(nums(out.decisions.spawnBuilds)).toEqual(['8001']);
  expect(plan.launch).toEqual([{ num: '8001', lane: 20 }]);
  expect(plan.held).toEqual([
    { num: '7000', reason: 'needs-slice' },
    { num: '7001', reason: 'runtime-only' },
  ]);
});

it.each(['build', 'prepare'])('durable bornAs alias survives the %s planning and daemon filters', async kind => {
  const row = { ...builds[0], id: '8001-renamed', bornAs: 'xabcdef0' };
  const settings = only(['xabcdef0']);
  const data = input(settings, {
    state: { queue: [row], lanes: [], prs: [] },
    plan: kind === 'build' ? { launch: [{ num: row.num, lane: 20 }], held: [] }
      : { launch: [], held: [{ num: row.num, reason: 'needs-prepare' }] },
  });
  const out = planTick(data);
  expect(nums(kind === 'build' ? out.decisions.spawnBuilds : out.decisions.spawnPrepareItems)).toEqual(['8001']);
  const tick = await runBuildDispatchTick({ live: true, effects: effectsFor(out), policy, buildPriority: settings });
  expect(nums(kind === 'build' ? tick.dispatched : tick.prepare.launched)).toEqual(['8001']);
  expect(projectBuildQueueRow(row, row)).toMatchObject({ bornAs: row.bornAs, id: row.id });
  expect(shapeQueue([row])[0]).toMatchObject({ bornAs: row.bornAs, id: row.id });
});

it.each([
  ['build', '42', '42'],
  ['prepare', '42', '42'],
  ['build', '42', 42],
  ['prepare', '42', 42],
  ['build', '42', '#42'],
  ['prepare', '42', '#42'],
  ['build', 'xabcdef0', 'xabcdef1'],
  ['prepare', 'xabcdef0', 'xabcdef1'],
])('%s allowlist %j rejects unauthorized bornAs %j', async (kind, listed, bornAs) => {
  const row = { ...builds[0], num: '9999', id: '9999-unlisted', bornAs };
  const settings = only([listed]);
  expect(dispatchPlan({ queue: [row], freeLanes: [20], buildPriority: settings }))
    .toEqual({ launch: [], held: [{ num: '9999', reason: 'runtime-only' }] });
  const out = planTick(input(settings, {
    state: { queue: [row], lanes: [], prs: [] },
    plan: kind === 'build' ? { launch: [{ num: row.num, lane: 20 }], held: [] }
      : { launch: [], held: [{ num: row.num, reason: 'needs-prepare' }] },
  }));
  expect(out.decisions.spawnBuilds).toEqual([]);
  expect(out.decisions.spawnPrepareItems).toEqual([]);
  const effects = effectsFor(out);
  const tick = await runBuildDispatchTick({ live: true, effects, policy, buildPriority: settings });
  expect(tick.dispatched).toEqual([]);
  expect(tick.prepare.launched).toEqual([]);
  expect(effects.dispatch).not.toHaveBeenCalled();
});

it.each([only([]), { ...only(['xabcdef0']), held: true }])('dispatch assignment fails closed for runtime settings %j', buildPriority => {
  const plan = dispatchPlan({ queue: [{ num: '8001', bornAs: 'xabcdef0', scope: ['scripts/shared.mjs'] }],
    leases: [], freeLanes: [20, 21], buildPriority });
  expect(plan.launch).toEqual([]);
  expect(plan.held).toEqual([{ num: '8001', reason: 'runtime-only' }]);
});


it('fresh spawn admission protects an older daemon plan and hold-routing effect', async () => {
  const effects = effectsFor(planTick(input()));
  effects.readRuntimeSettings = () => only(['8001', '7202']);
  effects.listHolds = () => [{ num: '9001', reason: 'spec already done on main: commit abcdef012' }];
  effects.routeHeldItems = vi.fn(() => []);
  const tick = await runBuildDispatchTick({ live: true, effects, policy });
  expect(nums(tick.dispatched)).toEqual(['8001']);
  expect(effects.dispatch.mock.calls.every(([row]) => ['8001', '7202'].includes(row.num))).toBe(true);
  expect(effects.routeHeldItems).toHaveBeenCalledWith([]);
  expect(tick.runtimeRefused).toEqual(expect.arrayContaining([
    { num: '8002', kind: 'build', reason: 'runtime-only' },
    { num: '9001', kind: 'route', reason: 'runtime-only' },
  ]));
});
it('CLI planning with fresh runtime settings retains a runtime-only guard but proposes no prepare-scope', () => {
  const data = input(only([]));
  data.state.unshaped = [{ num: '9001' }];
  data.plan = { launch: [], held: [{ num: '9001', reason: 'runtime-only' }] };
  data.bookkeeping = { tick: 1, prepareGuards: [{ num: '9001', kind: 'prepare', lane: 1, spawnedTick: 1 }] };
  const out = planTick(data);
  expect(out.decisions.spawnPrepareScope).toEqual([]);
  expect(out.nextState.prepareGuards.map(r => r.num)).toContain('9001');
});

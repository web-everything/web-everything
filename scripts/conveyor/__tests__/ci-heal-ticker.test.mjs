import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDaemonExits, createCiHealTicker, runTickAllRepos, wrapFixDaemonTick } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';
import { resolveDeliveryIdentity } from '../../lib/github-app-identity.mjs';
import * as fixFacts from '../../lib/fix-facts.mjs';
import * as heavyAdmission from '../../readiness/heavy-admission.mjs';
import * as resourceGate from '../../lib/resource-gate.mjs';
import * as authHealth from '../claude-auth-health.mjs';
import soakBreak from '../soak/breaks/ci-heal-runs-on-own-interval.mjs';

const empty = () => ({ dispatched: [], refusals: [], actions: [], notes: [], prs: [], rows: [] });
const fixture = () => ({
  repos: ['repo-a'], fixTick: vi.fn(empty), ciHealTick: vi.fn(empty),
  hungCiTick: vi.fn(empty), mainRedRebaseTick: vi.fn(empty), missingRunTick: vi.fn(empty),
  promoteDraftTick: vi.fn(empty), rulingStandDownTick: vi.fn(empty), notesTick: vi.fn(empty),
  awaitVerifyTick: vi.fn(empty), stuckFixerTick: vi.fn(empty), supersedeTick: vi.fn(empty),
  orphanGuardTick: vi.fn(empty), authGateOverride: () => ({ paused: false }),
  fixSettings: { skipEmptySteps: false }, budgetRotation: {}, prCursors: {}, reuseReconcilePlan: false,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const fakeTimer = () => {
  let callback;
  const handle = { unref: vi.fn() };
  return { handle, setTimer: vi.fn(fn => { callback = fn; return handle; }), clearTimer: vi.fn(), fire: () => callback() };
};
const log = () => ({ error: vi.fn() });

beforeEach(() => {
  vi.spyOn(fixFacts, 'warmFixFacts').mockResolvedValue({});
  vi.spyOn(heavyAdmission, 'resolveLiveQueueBaseline').mockReturnValue({
    slots: 1, backlogMinutes: 0, maxWaitMinutes: 3.25, dispatchMinutes: { fix: 3.25, 'ci-heal': 3.25 },
  });
  vi.spyOn(resourceGate, 'createResourceFixThrottle').mockReturnValue({ tryAdmit: vi.fn(() => ({ admit: true })) });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('in-process CI-heal ticker', () => {
  it('heals on the interval between passes, retaining supersede and no other phase effects', async () => {
    vi.useFakeTimers();
    const options = fixture(), healState = { healing: false }, dispatchState = { current: {} };
    const ticker = createCiHealTicker({ healState, intervalSec: 60,
      tick: () => runTickAllRepos({ ...options, ciHealOnly: true, healState, dispatchState }) });
    try {
      await vi.advanceTimersByTimeAsync(59_999);
      expect(options.ciHealTick).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(options.ciHealTick).toHaveBeenCalledOnce();
      expect(options.supersedeTick).toHaveBeenCalledOnce();
      expect(options.supersedeTick.mock.invocationCallOrder[0]).toBeLessThan(options.ciHealTick.mock.invocationCallOrder[0]);
      for (const [key, tick] of Object.entries(options)) {
        if (key.endsWith('Tick') && !['ciHealTick', 'supersedeTick'].includes(key)) expect(tick, key).not.toHaveBeenCalled();
      }
      expect(options.ciHealTick.mock.calls[0][0]).toMatchObject({
        deadlineAt: expect.any(Number), queueAdmission: expect.any(Object), dispatchThrottle: expect.any(Object),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(options.ciHealTick).toHaveBeenCalledTimes(2);
      expect(healState.healing).toBe(false);
    } finally { ticker.stop(); }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(options.ciHealTick).toHaveBeenCalledTimes(2);
  });

  it('shares admission and throttle: the second admit from a timer tick is refused at cap', async () => {
    const options = fixture(), healState = { healing: false }, dispatchState = { current: {} };
    const admissions = [], budgets = [], throttles = [];
    options.ciHealTick = vi.fn(({ queueAdmission, dispatchThrottle }) => {
      budgets.push(queueAdmission); throttles.push(dispatchThrottle);
      admissions.push(queueAdmission.tryAdmit('ci-heal').admit);
      return empty();
    });
    await runTickAllRepos({ ...options, healState, dispatchState });
    const clock = fakeTimer();
    const ticker = createCiHealTicker({ ...clock, healState,
      tick: () => runTickAllRepos({ ...options, healState, dispatchState, ciHealOnly: true }) });
    try {
      await clock.fire();
      expect(admissions).toEqual([true, false]);
      expect(budgets[1]).toBe(budgets[0]);
      expect(throttles[1]).toBe(throttles[0]);
      expect(heavyAdmission.resolveLiveQueueBaseline).toHaveBeenCalledOnce();
      expect(resourceGate.createResourceFixThrottle).toHaveBeenCalledOnce();
      await runTickAllRepos({ ...options, healState, dispatchState });
      expect(admissions).toEqual([true, false, true]);
      expect(budgets[2]).not.toBe(budgets[0]);
    } finally { ticker.stop(); }
  });

  it('a main pass skips timer healing and preserves its in-flight reservations', async () => {
    const options = fixture(), healState = { healing: false }, dispatchState = { current: {} };
    const clock = fakeTimer(), pending = deferred(), entered = deferred();
    let budget;
    const ticker = createCiHealTicker({ ...clock, healState,
      tick: () => runTickAllRepos({ ...options, healState, dispatchState, ciHealOnly: true,
        ciHealTick: async ({ queueAdmission }) => {
          budget = queueAdmission;
          expect(budget.tryAdmit('ci-heal').admit).toBe(true);
          entered.resolve(); await pending.promise;
          return empty();
        } }) });
    const healing = clock.fire();
    try {
      await entered.promise;
      const pass = await runTickAllRepos({ ...options, healState, dispatchState,
        fixTick: ({ queueAdmission }) => {
          expect(queueAdmission).toBe(budget);
          expect(queueAdmission.tryAdmit('fix').admit).toBe(false);
          return empty();
        } });
      expect(pass.ciHeal.skipped).toBe('busy');
      expect(options.ciHealTick).not.toHaveBeenCalled();
      expect(healState.healing).toBe(true);
    } finally { pending.resolve(); await healing; ticker.stop(); }
    expect(healState.healing).toBe(false);
  });

  it('the timer skips a healing pass and the pass releases the flag after a throwing heal', async () => {
    const options = fixture(), healState = { healing: false }, entered = deferred(), pending = deferred();
    options.ciHealTick = vi.fn(async () => { entered.resolve(); await pending.promise; throw Error('inline broke'); });
    const clock = fakeTimer(), tick = vi.fn();
    const ticker = createCiHealTicker({ ...clock, healState, tick });
    const pass = runTickAllRepos({ ...options, healState });
    try {
      await entered.promise;
      expect(healState.healing).toBe(true);
      await clock.fire();
      expect(tick).not.toHaveBeenCalled();
      pending.resolve();
      const result = await pass;
      expect(result.refusals).toContainEqual(expect.objectContaining({ why: 'inline broke' }));
      expect(healState.healing).toBe(false);
      await clock.fire();
      expect(tick).toHaveBeenCalledOnce();
    } finally { pending.resolve(); await pass; ticker.stop(); }
  });

  it('uses one unref timer, skips overlap, logs errors, releases the flag and stops queued callbacks', async () => {
    const clock = fakeTimer(), healState = { healing: false }, pending = deferred(), logger = log();
    const tick = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(empty());
    const ticker = createCiHealTicker({ ...clock, healState, tick, log: logger, intervalSec: 90 });
    try {
      expect(clock.setTimer).toHaveBeenCalledOnce();
      expect(clock.setTimer).toHaveBeenCalledWith(expect.any(Function), 90_000);
      expect(clock.handle.unref).toHaveBeenCalledOnce();
      const first = clock.fire();
      await clock.fire();
      expect(tick).toHaveBeenCalledOnce();
      pending.reject(Error('timer broke'));
      await expect(first).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('timer broke'));
      expect(healState.healing).toBe(false);
      await clock.fire();
      expect(tick).toHaveBeenCalledTimes(2);
    } finally { ticker.stop(); }
    ticker.stop(); await clock.fire();
    expect(clock.clearTimer).toHaveBeenCalledOnce();
    expect(clock.clearTimer).toHaveBeenCalledWith(clock.handle);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('keeps the production Claude auth pause in heal-only mode', async () => {
    const options = fixture();
    vi.spyOn(authHealth, 'planClaudeAuthDispatchGate').mockReturnValue({ paused: true, reason: 'login required' });
    const result = await runTickAllRepos({ ...options, ciHealOnly: true, authGateOverride: undefined });
    expect(result.authPaused).toBe(true);
    expect(options.ciHealTick).not.toHaveBeenCalled();
    expect(heavyAdmission.resolveLiveQueueBaseline).not.toHaveBeenCalled();
    expect(options.supersedeTick).toHaveBeenCalledOnce();
  });

  it.each(['shutdown', 'restartOntoNewCode', 'loopEnded'])('stops the timer on %s before releasing the lease', async method => {
    const clock = fakeTimer(), tick = vi.fn(), calls = [];
    const ticker = createCiHealTicker({ ...clock, healState: { healing: false }, tick });
    const exits = buildDaemonExits({ awaitLoop: { stop: vi.fn() }, stopCiHeal: () => { ticker.stop(); calls.push('timer-stop'); },
      releaseLease: () => calls.push('release'), exit: vi.fn(), log: log() });
    exits[method]('test'); await clock.fire();
    expect(tick).not.toHaveBeenCalled();
    expect(calls).toEqual(['timer-stop', 'release']);
  });

  it('the soak presence and regression checks exercise real ticker behavior', async () => {
    expect(soakBreak.fixPresent(process.cwd())).toBe(true);
    const report = await soakBreak.run();
    expect(soakBreak.judge(report)).toEqual([]);
    expect(soakBreak.judge({ ...report, betweenPasses: 0 })).not.toEqual([]);
    expect(soakBreak.judge({ ...report, whilePassHealing: 2 })).not.toEqual([]);
  });
});

function wrapperFixture() {
  const events = [], logger = log();
  const options = {
    root: '/fixture/clone', onRestart: vi.fn(),
    selfSync: {
      env: {}, log: logger, readHead: () => 'a'.repeat(40), readOriginRef: () => 'a'.repeat(40),
      rebuild: vi.fn(async () => ({ moved: false })),
      acquireRead: vi.fn(() => { events.push('lock'); return { ok: true }; }),
      releaseRead: vi.fn(() => { events.push('unlock'); }),
      readState: () => ({ adopted: null, rejected: null, inProgress: null, quarantine: null }),
      versions: null, background: false, entries: ['worker.mjs'],
      importClosure: () => ({ files: new Set(['worker.mjs']), complete: true, bareDeps: false, jsonNames: new Set() }),
      diffFiles: () => ['worker.mjs'],
    },
    auth: { env: {}, daemon: true, policy: { auth: 'app' },
      identity: resolveDeliveryIdentity({ env: {}, pinned: false }), log: logger,
      installShim: vi.fn(async () => { events.push('auth'); return { ok: true }; }),
      readCache: () => null, writeStatus: vi.fn(), writeCallerStatus: vi.fn(),
    },
    claims: { log: logger, refresh: vi.fn(async () => { events.push('claims'); return { refreshed: [] }; }) },
  };
  return { options, events, logger };
}

describe('shared main/heal wrapper stack', () => {
  it('a timer stale-main refusal releases the clone lock and triggers immediate recovery', async () => {
    const { options, events, logger } = wrapperFixture();
    options.selfSync.rebuild.mockResolvedValueOnce({ moved: false })
      .mockImplementationOnce(async () => { events.push('recover'); return { moved: true, adopted: true, head: 'b'.repeat(40) }; });
    const effects = wrapFixDaemonTick({ tickOnce: () => {
      events.push('heal'); return { refusals: [{ kind: 'tick-failed', why: 'STALE code from this checkout' }] };
    } }, { ...options, authOpts: options.auth });
    const clock = fakeTimer(), healState = { healing: false };
    const ticker = createCiHealTicker({ ...clock, healState, tick: effects.tickOnce, log: logger });
    try {
      await clock.fire();
      expect(events).toEqual(['lock', 'auth', 'claims', 'heal', 'unlock', 'recover']);
      expect(options.selfSync.rebuild).toHaveBeenCalledTimes(2);
      expect(options.onRestart).toHaveBeenCalledWith(expect.objectContaining({ moved: true, adopted: true }));
      expect(healState.healing).toBe(false);
    } finally { ticker.stop(); }
  });

  it('quarantine refuses a timer heal before auth, claims and dispatch', async () => {
    const { options, logger } = wrapperFixture(), tick = vi.fn();
    options.selfSync.readState = () => ({ quarantine: { reason: 'rejected tree' } });
    const clock = fakeTimer(), healState = { healing: false };
    const effects = wrapFixDaemonTick({ tickOnce: tick }, { ...options, authOpts: options.auth });
    const ticker = createCiHealTicker({ ...clock, healState, tick: effects.tickOnce, log: logger });
    try {
      await clock.fire();
      expect(tick).not.toHaveBeenCalled();
      expect(options.auth.installShim).not.toHaveBeenCalled();
      expect(options.claims.refresh).not.toHaveBeenCalled();
      expect(healState.healing).toBe(false);
    } finally { ticker.stop(); }
  });

  it('a strict auth guard failure refuses healing and releases the flag and clone lock', async () => {
    const { options, logger } = wrapperFixture(), tick = vi.fn();
    options.auth.installShim.mockResolvedValue({ ok: false });
    const clock = fakeTimer(), healState = { healing: false };
    const effects = wrapFixDaemonTick({ tickOnce: tick }, { ...options, authOpts: options.auth });
    const ticker = createCiHealTicker({ ...clock, healState, tick: effects.tickOnce, log: logger });
    try {
      await expect(clock.fire()).resolves.toBeUndefined();
      expect(tick).not.toHaveBeenCalled();
      expect(options.claims.refresh).not.toHaveBeenCalled();
      expect(options.selfSync.releaseRead).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('without the gh auth guard'));
      expect(healState.healing).toBe(false);
    } finally { ticker.stop(); }
  });
});

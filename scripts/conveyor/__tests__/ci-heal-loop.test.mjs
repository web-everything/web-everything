import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCiHealInterval, runCiHealLoopIteration, runCiHealLoop, spawnCiHealLoop } from '../ci-heal-loop.mjs';
import { buildDaemonExits, runTickAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';
import * as fixFacts from '../../lib/fix-facts.mjs';
import * as heavyAdmission from '../../readiness/heavy-admission.mjs';
import * as resourceGate from '../../lib/resource-gate.mjs';
import * as authHealth from '../claude-auth-health.mjs';
import { GithubAppAuthGuardError } from '../../lib/github-app-auth-env.mjs';

const empty = () => ({ dispatched: [], refusals: [], actions: [], notes: [], prs: [], rows: [] });
const fixture = () => ({
  repos: ['repo-a'], fixTick: vi.fn(empty), ciHealTick: vi.fn(empty),
  hungCiTick: vi.fn(empty), mainRedRebaseTick: vi.fn(empty), missingRunTick: vi.fn(empty),
  promoteDraftTick: vi.fn(empty), rulingStandDownTick: vi.fn(empty), notesTick: vi.fn(empty),
  awaitVerifyTick: vi.fn(empty), stuckFixerTick: vi.fn(empty), supersedeTick: vi.fn(empty),
  orphanGuardTick: vi.fn(empty), authGateOverride: () => ({ paused: false }),
  fixSettings: { skipEmptySteps: false }, budgetRotation: {}, prCursors: {}, reuseReconcilePlan: false,
});
const lockFixture = () => {
  let held = false;
  return {
    reserve: vi.fn(() => { if (held) return { ok: false }; held = true; return { ok: true }; }),
    release: vi.fn(() => { held = false; }),
  };
};
afterEach(() => vi.restoreAllMocks());

describe('ci-heal runs on its own interval', () => {
  const resolve = (settings = {}, env = {}) => resolveCiHealInterval({ settings, env });
  it('resolves setting, environment precedence, and the standard 300-second default', () => {
    expect(resolve()).toEqual({ seconds: 300, source: 'standard' });
    expect(resolve({ ciHeal: { intervalSec: 120 } })).toEqual({ seconds: 120, source: 'tool' });
    expect(resolve({ ciHeal: { intervalSec: 120 } }, { WE_CI_HEAL_INTERVAL_SEC: '90' }))
      .toEqual({ seconds: 90, source: 'env' });
  });
  it.each([0, 59, 1801, 'abc', '90', 90.5, null, NaN])('invalid setting %s falls back to 300', intervalSec => {
    expect(resolve({ ciHeal: { intervalSec } }).seconds).toBe(300);
  });
  it.each(['0', '59', '1801', 'abc', '90.5', '', 'NaN'])('invalid env %s uses 300 even over a valid tool value', value => {
    expect(resolve({ ciHeal: { intervalSec: 120 } }, { WE_CI_HEAL_INTERVAL_SEC: value }).seconds).toBe(300);
  });
  it.each([60, 1800])('accepts inclusive boundary %s', seconds => {
    expect(resolve({ ciHeal: { intervalSec: seconds } }).seconds).toBe(seconds);
  });
  it('skips a held lock without overlapping and releases after a throwing tick', async () => {
    const lock = lockFixture();
    let finish;
    const tick = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const options = { lock, tick, ensureAuth: vi.fn(), write: vi.fn(), now: () => 0 };
    const first = runCiHealLoopIteration(options);
    // Let the first iteration reach its asynchronous tick without real clocks or timers.
    await Promise.resolve();
    await Promise.resolve();
    expect(await runCiHealLoopIteration(options)).toEqual({ skipped: 'busy' });
    expect(tick).toHaveBeenCalledTimes(1);
    finish(empty());
    await first;
    expect(lock.release).toHaveBeenCalledTimes(1);
    await expect(runCiHealLoopIteration({ ...options, tick: () => { throw new Error('tick failed'); } }))
      .rejects.toThrow('tick failed');
    expect(lock.release).toHaveBeenCalledTimes(2);
  });
  it('refreshes App auth before dispatch; a guard error prevents tick and releases the lock', async () => {
    const lock = lockFixture(), calls = [], tick = vi.fn(() => { calls.push('tick'); return empty(); });
    const options = { lock, tick, write: vi.fn(), ensureAuth: () => { calls.push('auth'); } };
    await runCiHealLoopIteration(options);
    expect(calls).toEqual(['auth', 'tick']);
    tick.mockClear();
    await expect(runCiHealLoopIteration({ ...options,
      ensureAuth: () => { throw new GithubAppAuthGuardError(); },
    })).rejects.toThrow('without the gh auth guard');
    expect(tick).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledTimes(2);
  });
  it('sleeps exactly intervalSec*1000 between iterations and exits when its parent is gone', async () => {
    const events = [];
    let alive = true;
    await runCiHealLoop({ parentPid: 42, parentAlive: () => alive,
      resolveInterval: () => ({ seconds: 90, source: 'tool' }), write: vi.fn(),
      iteration: async () => { events.push('tick'); },
      sleep: async ms => { events.push(ms); if (events.length === 4) alive = false; },
    });
    expect(events).toEqual(['tick', 90000, 'tick', 90000]);
  });
  it('spawns a child with the parent PID, inherited environment and stdio', () => {
    const child = {}, spawnFn = vi.fn(() => child), env = { TEST: 'yes' };
    expect(spawnCiHealLoop({ spawnFn, env, parentPid: 42 })).toBe(child);
    expect(spawnFn).toHaveBeenCalledWith(process.execPath,
      [expect.stringMatching(/ci-heal-loop\.mjs$/), '--parent-pid=42'], { env, stdio: 'inherit' });
  });
  it('ciHealInline false skips the inline tick; the default retains existing behaviour', async () => {
    const options = fixture();
    const out = await runTickAllRepos({ ...options, ciHealInline: false });
    expect(options.ciHealTick).not.toHaveBeenCalled();
    expect(out.ciHeal).toMatchObject({ dispatched: [], refusals: [], reconcileRefusals: [] });
    await runTickAllRepos(options);
    expect(options.ciHealTick).toHaveBeenCalledTimes(1);
  });
  it('ciHealOnly calls ci-heal and no other half, with real admission and the existing PR budget', async () => {
    vi.spyOn(fixFacts, 'warmFixFacts').mockResolvedValue({});
    const baseline = vi.spyOn(heavyAdmission, 'resolveLiveQueueBaseline').mockReturnValue({ bypassed: 'fixture' });
    vi.spyOn(resourceGate, 'createResourceFixThrottle').mockReturnValue({ tryAdmit: () => ({ admit: true }) });
    const options = fixture();
    const result = await runTickAllRepos({ ...options, ciHealOnly: true });
    expect(options.ciHealTick).toHaveBeenCalledTimes(1);
    expect(options.ciHealTick.mock.calls[0][0]).toMatchObject({ repo: 'repo-a', deadlineAt: expect.any(Number),
      queueAdmission: expect.any(Object), dispatchThrottle: expect.any(Object) });
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(result.ciHeal.refusals).toEqual([]);
    for (const [key, tick] of Object.entries(options)) {
      if (key.endsWith('Tick') && key !== 'ciHealTick') expect(tick, key).not.toHaveBeenCalled();
    }
  });
  it('ciHealOnly retains the production auth gate and refuses healing when paused', async () => {
    vi.spyOn(fixFacts, 'warmFixFacts').mockResolvedValue({});
    const gate = vi.spyOn(authHealth, 'planClaudeAuthDispatchGate').mockReturnValue({ paused: true, reason: 'login required' });
    const baseline = vi.spyOn(heavyAdmission, 'resolveLiveQueueBaseline');
    const options = fixture();
    const result = await runTickAllRepos({ ...options, ciHealOnly: true, authGateOverride: undefined });
    expect(gate).toHaveBeenCalledOnce();
    expect(options.ciHealTick).not.toHaveBeenCalled();
    expect(baseline).not.toHaveBeenCalled();
    expect(result).toMatchObject({ authPaused: true, authPauseReason: 'login required' });
  });
  it.each(['shutdown', 'restartOntoNewCode', 'loopEnded'])('stops both children on %s', method => {
    const awaitLoop = { stop: vi.fn() }, ciHealLoop = { stop: vi.fn() };
    const exits = buildDaemonExits({ awaitLoop, ciHealLoop, releaseLease: vi.fn(), exit: vi.fn(), log: { error: vi.fn() } });
    exits[method]('test');
    expect(awaitLoop.stop).toHaveBeenCalledOnce();
    expect(ciHealLoop.stop).toHaveBeenCalledOnce();
  });
});

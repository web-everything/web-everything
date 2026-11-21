/**
 * @file Async fixer slice s2 (C2): the ci-heal child loop is wired into the fix daemon behind `ciHeal.loop`.
 * A live child means the inline ci-heal step is skipped; a dead or absent child means it runs under the
 * single-run lock; `off` spawns nothing; every exit path stops the child; a child `error` is retried.
 */
import { describe, it, expect, vi } from 'vitest';
import { runTickAllRepos, buildCliDaemonEffects, buildDaemonExits } from '../reconcile-fix-dispatch-daemon.mjs';
import { superviseAwaitVerifyLoop } from '../../../scripts/conveyor/await-verify-loop.mjs';
import { resolveCiHealLoopEnabled, spawnCiHealLoop } from '../../../scripts/conveyor/ci-heal-loop.mjs';

const quiet = () => ({ dispatched: [], refusals: [], actions: [], notes: [], rows: [] });
const passOptions = (extra = {}) => ({
  repos: ['repo-a'], allowStandDownAutoProceed: false, readPrs: () => [],
  authGateOverride: () => ({ paused: false, reason: null }),
  fixTick: vi.fn(quiet), ciHealTick: vi.fn(async () => ({ dispatched: [], refusals: [] })),
  hungCiTick: vi.fn(quiet), mainRedRebaseTick: vi.fn(quiet), missingRunTick: vi.fn(quiet),
  promoteDraftTick: vi.fn(quiet), rulingStandDownTick: vi.fn(quiet), notesTick: vi.fn(quiet),
  awaitVerifyTick: vi.fn(quiet), stuckFixerTick: vi.fn(quiet), supersedeTick: vi.fn(quiet), orphanGuardTick: null,
  ...extra,
});

describe('ci-heal child loop wiring (async slice s2)', () => {
  it('a live child skips the inline ci-heal step', async () => {
    const opts = passOptions({ ciHealInline: false });
    await runTickAllRepos(opts);
    expect(opts.ciHealTick).not.toHaveBeenCalled();
  });

  it('a dead or absent child runs the inline step under the single-run lock', async () => {
    const order = [];
    const withCiHealLock = vi.fn(async fn => { order.push('lock'); const r = await fn(); order.push('unlock'); return r; });
    const opts = passOptions({ ciHealInline: true, ciHealLock: true, withCiHealLock });
    opts.ciHealTick = vi.fn(async () => { order.push('heal'); return { dispatched: [], refusals: [] }; });
    await runTickAllRepos(opts);
    expect(order).toEqual(['lock', 'heal', 'unlock']);
  });

  it('a busy lock skips the inline step instead of double-dispatching', async () => {
    const opts = passOptions({ ciHealInline: true, ciHealLock: true, withCiHealLock: async () => ({ skipped: 'busy' }) });
    const result = await runTickAllRepos(opts);
    expect(opts.ciHealTick).not.toHaveBeenCalled();
    expect(result.ciHeal.skipped).toBe('busy');
  });

  it('the daemon tick asks the live child whether to skip inline, and always locks', async () => {
    // buildCliDaemonEffects calls runTickAllRepos from its own module, so assert the call site's contract.
    const effects = buildCliDaemonEffects({ owner: 'o', ciHealLoop: { current: () => ({ pid: 1 }) } });
    expect(typeof effects.tickOnce).toBe('function');
    const src = effects.tickOnce.toString();
    expect(src).toMatch(/ciHealInline:\s*!ciHealLoop\?\.current\(\)/);
    expect(src).toMatch(/ciHealLock:\s*true/);
  });

  it('off (and anything unknown) spawns no child; on spawns the loop with the parent pid', () => {
    expect(resolveCiHealLoopEnabled({ env: {}, settings: {} })).toBe(false);
    expect(resolveCiHealLoopEnabled({ env: {}, settings: { ciHeal: { loop: 'maybe' } } })).toBe(false);
    expect(resolveCiHealLoopEnabled({ env: {}, settings: { ciHeal: { loop: 'on' } } })).toBe(true);
    expect(resolveCiHealLoopEnabled({ env: { WE_CI_HEAL_LOOP: 'off' }, settings: { ciHeal: { loop: 'on' } } })).toBe(false);
    expect(resolveCiHealLoopEnabled({ env: { WE_CI_HEAL_LOOP: 'bogus' }, settings: { ciHeal: { loop: 'on' } } })).toBe(false);
    const spawnFn = vi.fn(() => ({ pid: 9 }));
    expect(spawnCiHealLoop({ env: {}, settings: {}, spawnFn, parentPid: 7 })).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    spawnCiHealLoop({ env: {}, settings: { ciHeal: { loop: 'on' } }, spawnFn, parentPid: 7 });
    expect(spawnFn.mock.calls[0][1]).toContain('--parent-pid=7');
  });

  it('every daemon exit path stops the ci-heal child', () => {
    const make = () => {
      const calls = [];
      const exits = buildDaemonExits({
        awaitLoop: { stop: () => calls.push('await') }, ciHealLoop: { stop: () => calls.push('heal') },
        releaseLease: () => calls.push('release'), exit: () => {}, log: { error: () => {} },
      });
      return { calls, exits };
    };
    const a = make(); a.exits.shutdown('SIGTERM');
    const b = make(); b.exits.restartOntoNewCode();
    const c = make(); c.exits.loopEnded('crashed');
    for (const { calls } of [a, b, c]) expect(calls).toContain('heal');
  });

  it('a child error event is retried after minGapMs', () => {
    const handlers = {};
    const timers = [];
    const spawnLoop = vi.fn(() => ({ on: (name, fn) => { handlers[name] = fn; }, kill: vi.fn() }));
    const sup = superviseAwaitVerifyLoop({
      spawnLoop, log: { error: vi.fn() }, setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
      now: () => 0, minGapMs: 60000,
    });
    sup.start();
    handlers.error(new Error('boom'));
    expect(sup.current()).toBeNull();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(60000);
    timers[0].fn();
    expect(spawnLoop).toHaveBeenCalledTimes(2);
  });
});

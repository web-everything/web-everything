/**
 * @file Async fixer slice s2 (C2): the ci-heal child loop is wired into the fix daemon behind `ciHeal.loop`.
 * A live child means the inline ci-heal step is skipped; a dead or absent child means it runs under the
 * single-run lock; `off` spawns nothing; every exit path stops the child; a child `error` is retried.
 */
import { describe, it, expect, vi } from 'vitest';
import { runTickAllRepos, buildCliDaemonEffects, buildDaemonExits } from '../reconcile-fix-dispatch-daemon.mjs';
import { superviseAwaitVerifyLoop } from '../../../scripts/conveyor/await-verify-loop.mjs';
import { resolveCiHealLoopEnabled, resolveCiHealLoop, spawnCiHealLoop, createCiHealLoopController } from '../../../scripts/conveyor/ci-heal-loop.mjs';

const noOverride = () => ({ ok: false, reason: 'not-set' });
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
    expect(resolveCiHealLoopEnabled({ readOverride: noOverride, env: {}, settings: {} })).toBe(false);
    expect(resolveCiHealLoopEnabled({ readOverride: noOverride, env: {}, settings: { ciHeal: { loop: 'maybe' } } })).toBe(false);
    expect(resolveCiHealLoopEnabled({ readOverride: noOverride, env: {}, settings: { ciHeal: { loop: 'on' } } })).toBe(true);
    expect(resolveCiHealLoopEnabled({ readOverride: noOverride, env: { WE_CI_HEAL_LOOP: 'off' }, settings: { ciHeal: { loop: 'on' } } })).toBe(false);
    expect(resolveCiHealLoopEnabled({ readOverride: noOverride, env: { WE_CI_HEAL_LOOP: 'bogus' }, settings: { ciHeal: { loop: 'on' } } })).toBe(false);
    const spawnFn = vi.fn(() => ({ pid: 9 }));
    expect(spawnCiHealLoop({ readOverride: noOverride, log: () => {}, env: {}, settings: {}, spawnFn, parentPid: 7 })).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    spawnCiHealLoop({ readOverride: noOverride, log: () => {}, env: {}, settings: { ciHeal: { loop: 'on' } }, spawnFn, parentPid: 7 });
    expect(spawnFn.mock.calls[0][1]).toContain('--parent-pid=7');
  });

  it('the operator override wins over env and the settings file, with provenance', () => {
    const on = () => ({ ok: true, value: 'on' });
    const off = () => ({ ok: true, value: 'off' });
    const none = () => ({ ok: false, reason: 'not-set' });
    expect(resolveCiHealLoop({ env: {}, settings: { ciHeal: { loop: 'off' } }, readOverride: on })).toEqual({ enabled: true, source: 'override' });
    expect(resolveCiHealLoop({ env: { WE_CI_HEAL_LOOP: 'on' }, settings: { ciHeal: { loop: 'on' } }, readOverride: off })).toEqual({ enabled: false, source: 'override' });
    expect(resolveCiHealLoop({ env: { WE_CI_HEAL_LOOP: 'on' }, settings: {}, readOverride: none })).toEqual({ enabled: true, source: 'env' });
    expect(resolveCiHealLoop({ env: {}, settings: { ciHeal: { loop: 'on' } }, readOverride: none })).toEqual({ enabled: true, source: 'file' });
    expect(resolveCiHealLoop({ env: {}, settings: {}, readOverride: none })).toEqual({ enabled: false, source: 'standard' });
    // an unreadable or invalid override store (a possibly lost "off") fails closed, even when env/file say on
    const hot = { env: { WE_CI_HEAL_LOOP: 'on' }, settings: { ciHeal: { loop: 'on' } } };
    expect(resolveCiHealLoop({ ...hot, readOverride: () => { throw new Error('x'); } })).toEqual({ enabled: false, source: 'override-unreadable' });
    expect(resolveCiHealLoop({ ...hot, readOverride: () => ({ ok: false, reason: 'invalid-store' }) })).toEqual({ enabled: false, source: 'override-unreadable' });
    expect(resolveCiHealLoop({ ...hot, readOverride: () => ({ ok: false, reason: 'unreadable' }) }).enabled).toBe(false);
    // a missing store file is not evidence of anything: lower layers apply
    expect(resolveCiHealLoop({ ...hot, readOverride: () => ({ ok: false, reason: 'absent' }) })).toEqual({ enabled: true, source: 'env' });
    expect(resolveCiHealLoopEnabled({ env: {}, settings: {}, readOverride: on })).toBe(true);
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

  describe('the supervisor re-reads ciHeal.loop every tick', () => {
    const make = (answers) => {
      const kills = [];
      const lines = [];
      const spawnLoop = vi.fn(() => ({ pid: 100 + spawnLoop.mock.calls.length, on: () => {}, kill: sig => kills.push(sig) }));
      const supervisor = superviseAwaitVerifyLoop({ spawnLoop, log: { error: vi.fn() }, setTimer: () => ({ unref() {} }), now: () => 0 });
      let i = 0;
      const resolve = vi.fn(() => answers[Math.min(i++, answers.length - 1)]);
      const controller = createCiHealLoopController({ supervisor, resolve, log: line => lines.push(line) });
      return { controller, supervisor, spawnLoop, kills, lines };
    };
    const on = { enabled: true, source: 'override' };
    const off = { enabled: false, source: 'override' };

    it('off to on starts the child once and logs the change with its source', () => {
      const t = make([off, on, on]);
      t.controller.tick();
      expect(t.spawnLoop).not.toHaveBeenCalled();
      t.controller.tick();
      expect(t.spawnLoop).toHaveBeenCalledOnce();
      expect(t.lines).toContain('ci-heal-loop: ciHeal.loop=on source=override');
    });

    it('never double-spawns while a child is alive', () => {
      const t = make([on]);
      t.controller.tick(); t.controller.tick(); t.controller.tick();
      expect(t.spawnLoop).toHaveBeenCalledOnce();
    });

    it('on to off stops the child gracefully (SIGTERM), logs it, and a later on starts a fresh one', () => {
      const t = make([on, off, off, on]);
      t.controller.tick();
      t.controller.tick();
      expect(t.kills).toEqual(['SIGTERM']);
      expect(t.supervisor.current()).toBeNull();
      expect(t.lines).toContain('ci-heal-loop: ciHeal.loop=off source=override');
      t.controller.tick();
      expect(t.kills).toHaveLength(1);
      t.controller.tick();
      expect(t.spawnLoop).toHaveBeenCalledTimes(2);
    });

    it('an unreadable store resolves to off (fail closed) and stops a running child', () => {
      const t = make([on, { enabled: false, source: 'override-unreadable' }]);
      t.controller.tick();
      t.controller.tick();
      expect(t.kills).toEqual(['SIGTERM']);
      expect(t.lines).toContain('ci-heal-loop: ciHeal.loop=off source=override-unreadable');
    });

    it('a resolver that throws counts as off', () => {
      const t = make([on]);
      t.controller.tick();
      const throwing = createCiHealLoopController({ supervisor: t.supervisor, resolve: () => { throw new Error('boom'); }, log: () => {} });
      throwing.tick();
      expect(t.kills).toEqual(['SIGTERM']);
    });
  });
});

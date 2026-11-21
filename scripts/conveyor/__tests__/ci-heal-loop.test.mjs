import { hostname } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { main, resolveCiHealInterval, runCiHealTick, runCiHealLoop, runCiHealLoopIteration } from '../ci-heal-loop.mjs';
import { HEARTBEAT_INTERVAL_MS } from '../../lib/daemon-clone-lock.mjs';
import { readLockEntry } from '../../readiness/file-locks.mjs';

function fixture() {
  let busy = false;
  const lock = {
    reserve: vi.fn(() => busy ? { ok: false } : (busy = true, { ok: true })),
    release: vi.fn(() => { busy = false; }),
    heartbeat: vi.fn(),
  };
  return {
    root: '/clone', lock,
    locks: { acquireRead: vi.fn(() => ({ ok: true })), releaseRead: vi.fn(), heartbeatRead: vi.fn() },
    tick: vi.fn(async () => ({ healed: true })), ensureAuth: vi.fn(),
    now: vi.fn().mockReturnValueOnce(10).mockReturnValue(25), write: vi.fn(),
    readHead: vi.fn(() => 'boot-head'), parentAlive: vi.fn(() => true),
    resolveInterval: vi.fn(() => ({ seconds: 300, source: 'standard' })), sleep: vi.fn(),
  };
}

describe('CI heal iteration', () => {
  it('skips a second concurrent run as busy without acquiring another read lock', async () => {
    const deps = fixture();
    let finish;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    deps.tick.mockImplementation(() => new Promise(resolve => { finish = resolve; entered(); }));
    const first = runCiHealLoopIteration(deps);
    await started;
    expect(await runCiHealLoopIteration(deps)).toEqual({ skipped: 'busy' });
    expect(deps.locks.acquireRead).toHaveBeenCalledOnce();
    expect(deps.locks.releaseRead).not.toHaveBeenCalled();
    finish('done');
    expect(await first).toBe('done');
    expect(deps.lock.release).toHaveBeenCalledOnce();
  });

  it('holds the own-child-pid read lock around the tick and releases it after success', async () => {
    const deps = fixture();
    const owner = `${hostname()}:${process.pid}`;
    deps.tick.mockImplementation(async () => {
      expect(deps.locks.acquireRead).toHaveBeenCalledWith('/clone', { owner });
      expect(deps.locks.releaseRead).not.toHaveBeenCalled();
      return 'done';
    });
    expect(await runCiHealLoopIteration(deps)).toBe('done');
    expect(deps.locks.releaseRead).toHaveBeenCalledOnce();
    expect(deps.locks.releaseRead).toHaveBeenCalledWith('/clone', { owner });
    expect(deps.write).toHaveBeenCalledWith('ci-heal-loop: completed in 15ms');
  });

  it('refuses a read-locked clone without ticking, authenticating or releasing its read lock', async () => {
    const deps = fixture();
    deps.locks.acquireRead.mockReturnValue({ ok: false });
    expect(await runCiHealLoopIteration(deps)).toEqual({ skipped: 'read-locked' });
    expect(deps.tick).not.toHaveBeenCalled();
    expect(deps.ensureAuth).not.toHaveBeenCalled();
    expect(deps.locks.releaseRead).not.toHaveBeenCalled();
    expect(deps.lock.release).toHaveBeenCalledOnce();
  });

  it.each(['tick', 'ensureAuth'])('releases acquired locks when %s throws', async failing => {
    const deps = fixture();
    deps[failing].mockRejectedValue(new Error('failed'));
    await expect(runCiHealLoopIteration(deps)).rejects.toThrow('failed');
    expect(deps.locks.releaseRead).toHaveBeenCalledOnce();
    expect(deps.lock.release).toHaveBeenCalledOnce();
  });

  it('never releases a read lock when acquisition throws', async () => {
    const deps = fixture();
    deps.locks.acquireRead.mockImplementation(() => { throw new Error('unreadable'); });
    await expect(runCiHealLoopIteration(deps)).rejects.toThrow('unreadable');
    expect(deps.tick).not.toHaveBeenCalled();
    expect(deps.locks.releaseRead).not.toHaveBeenCalled();
    expect(deps.lock.release).toHaveBeenCalledOnce();
  });
});

describe('CI heal audit regressions', () => {
  it('defaults to only ci-heal, with explicit empty injections and the real gate result forwarded', async () => {
    const gate = { paused: false, reason: null };
    const planAuth = vi.fn(() => gate);
    const heal = vi.fn(async () => ({ dispatched: ['healed'] }));
    const daemon = {
      defaultTagDispatchStatus: vi.fn(),
      withFixDispatchClaimRefresh: effects => effects,
      runTickAllRepos: vi.fn(async options => {
        expect(planAuth).toHaveBeenCalledOnce();
        expect(options).not.toHaveProperty('ciHealOnly');
        expect(options).not.toHaveProperty('ciHealTick');
        expect(options.authGateOverride()).toBe(gate);
        expect(options.orphanGuardTick).toBeNull();
        for (const key of ['fixTick', 'hungCiTick', 'mainRedRebaseTick', 'missingRunTick', 'promoteDraftTick',
          'rulingStandDownTick', 'notesTick', 'awaitVerifyTick', 'stuckFixerTick', 'supersedeTick']) {
          expect(typeof options[key]).toBe('function');
          const empty = await options[key]();
          expect(Object.values(empty).every(value => value instanceof Map ? value.size === 0 : value.length === 0)).toBe(true);
        }
        return heal();
      }),
    };
    expect(await runCiHealTick({ daemon, planAuth })).toEqual({ dispatched: ['healed'] });
    expect(daemon.runTickAllRepos).toHaveBeenCalledOnce();
    expect(heal).toHaveBeenCalledOnce();
  });

  it('skips an auth-paused tick before any daemon work', async () => {
    const daemon = { runTickAllRepos: vi.fn(), withFixDispatchClaimRefresh: vi.fn() };
    expect(await runCiHealTick({ daemon, planAuth: () => ({ paused: true }) })).toEqual({ skipped: 'auth-paused' });
    expect(daemon.runTickAllRepos).not.toHaveBeenCalled();
    expect(daemon.withFixDispatchClaimRefresh).not.toHaveBeenCalled();
  });

  it('rejects concurrent same-process cycles using the real reentrant cycle lock', async () => {
    const temp = mkdtempSync(join(process.env.TMPDIR, 'ci-heal-cycle-'));
    const deps = fixture();
    delete deps.lock;
    deps.env = { WE_COORDINATION_ROOT: temp };
    let finish, entered;
    const started = new Promise(resolve => { entered = resolve; });
    let first;
    try {
      deps.tick.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; entered(); }));
      first = runCiHealLoopIteration(deps);
      await started;
      const lockRoot = join(temp, 'ci-heal-cycle-lock');
      const held = readLockEntry(lockRoot, 'ci-heal-cycle');
      expect(held).not.toBeNull();
      expect(await runCiHealLoopIteration(deps)).toEqual({ skipped: 'busy' });
      expect(readLockEntry(lockRoot, 'ci-heal-cycle')).toEqual(held);
      expect(deps.locks.acquireRead).toHaveBeenCalledOnce();
      expect(deps.locks.releaseRead).not.toHaveBeenCalled();
    } finally {
      finish?.('done');
      await first;
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each([false, true])('heartbeats both locks and clears its unref timer after failure=%s', async fails => {
    const deps = fixture();
    const timer = { unref: vi.fn() };
    const interval = vi.fn(() => timer), clearInterval = vi.fn();
    deps.tick.mockImplementation(async () => {
      interval.mock.calls[0][0]();
      expect(deps.lock.heartbeat).toHaveBeenCalledOnce();
      expect(deps.locks.heartbeatRead).toHaveBeenCalledWith('/clone', { owner: `${hostname()}:${process.pid}` });
      if (fails) throw new Error('tick failed');
    });
    const running = runCiHealLoopIteration({ ...deps, interval, clearInterval });
    if (fails) await expect(running).rejects.toThrow('tick failed');
    else await running;
    expect(interval).toHaveBeenCalledWith(expect.any(Function), HEARTBEAT_INTERVAL_MS);
    expect(timer.unref).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledWith(timer);
  });

  it('resolves the default clone from the script checkout even with an unrelated cwd', async () => {
    const expected = execFileSync('git', ['-C', dirname(fileURLToPath(import.meta.url)), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(resolve(process.env.TMPDIR));
    const deps = fixture();
    delete deps.root;
    const iteration = vi.fn(async () => ({}));
    try {
      await runCiHealLoop({ ...deps, once: true, iteration });
      expect(iteration).toHaveBeenCalledWith(expect.objectContaining({ root: expected }));
    } finally { cwd.mockRestore(); }
  });

  it.each(['--parent-pid', '--parent-pid=', '--parent-pid=0', '--parent-pid=-1', '--parent-pid=1.5',
    '--parent-pid=abc', '--parent-pid=Infinity', '--parent-pid=9007199254740992'])('refuses invalid supervision flag %s', async flag => {
    const deps = fixture();
    await expect(main(['--once', flag], deps)).rejects.toThrow('parent-pid');
    expect(deps.tick).not.toHaveBeenCalled();
  });

  it('reports refusal/error counts and authPaused alongside completion timing', async () => {
    const deps = fixture();
    deps.tick.mockResolvedValue({ refusals: [{}, {}], errors: [{}], authPaused: true });
    await runCiHealLoopIteration(deps);
    expect(deps.write).toHaveBeenCalledWith('ci-heal-loop: refusals=2 errors=1 authPaused=true');
    expect(deps.write).toHaveBeenCalledWith('ci-heal-loop: completed in 15ms');
  });

  it.each([undefined])('returns error for a failed once iteration (%s) and main sets exit code 1', async code => {
    const deps = fixture();
    deps.tick.mockRejectedValue(Object.assign(new Error('failed'), { code }));
    expect(await runCiHealLoop({ ...deps, once: true })).toEqual({ exit: 'error' });
    const previous = process.exitCode;
    try {
      expect(await main(['--once'], deps)).toEqual({ exit: 'error' });
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = previous; }
  });

  it('rethrows the GitHub App auth guard refusal and never continues', async () => {
    const deps = fixture();
    deps.tick.mockRejectedValueOnce(Object.assign(new Error('guard'), { code: 'GITHUB_APP_AUTH_GUARD_UNAVAILABLE' }));
    await expect(runCiHealLoop({ ...deps, parentPid: 42 })).rejects.toThrow('guard');
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it.each([undefined])('logs an iteration error (%s) and continues in loop mode', async code => {
    const deps = fixture();
    deps.tick.mockRejectedValueOnce(Object.assign(new Error('failed'), { code }));
    deps.sleep.mockImplementation(async () => { deps.parentAlive.mockReturnValue(false); });
    expect(await runCiHealLoop({ ...deps, parentPid: 42 })).toEqual({ exit: 'parent-dead' });
    expect(deps.write).toHaveBeenCalledWith('ci-heal-loop: iteration failed: failed');
    expect(deps.sleep).toHaveBeenCalledOnce();
  });
});

describe('CI heal loop', () => {
  it('refuses HEAD moved before read-lock acquisition', async () => {
    const deps = fixture();
    deps.locks.acquireRead.mockImplementation(() => {
      deps.readHead.mockReturnValue('new-head');
      return { ok: true };
    });
    expect(await runCiHealLoop(deps)).toEqual({ exit: 'head-moved' });
    expect(deps.tick).not.toHaveBeenCalled();
    expect(deps.ensureAuth).not.toHaveBeenCalled();
    expect(deps.locks.releaseRead).toHaveBeenCalledOnce();
    expect(deps.locks.releaseRead).toHaveBeenCalledWith('/clone', { owner: `${hostname()}:${process.pid}` });
    expect(deps.lock.release).toHaveBeenCalledOnce();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('refuses unreadable HEAD after read-lock acquisition and releases acquired locks', async () => {
    const deps = fixture();
    deps.locks.acquireRead.mockImplementation(() => {
      deps.readHead.mockImplementation(() => { throw new Error('unreadable'); });
      return { ok: true };
    });
    expect(await runCiHealLoop(deps)).toEqual({ exit: 'head-unknown' });
    expect(deps.tick).not.toHaveBeenCalled();
    expect(deps.ensureAuth).not.toHaveBeenCalled();
    expect(deps.locks.releaseRead).toHaveBeenCalledOnce();
    expect(deps.lock.release).toHaveBeenCalledOnce();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('exits head-moved before any tick when HEAD differs from boot', async () => {
    const deps = fixture();
    deps.readHead.mockReturnValueOnce('boot-head').mockReturnValue('new-head');
    expect(await runCiHealLoop(deps)).toEqual({ exit: 'head-moved' });
    expect(deps.tick).not.toHaveBeenCalled();
    expect(deps.locks.acquireRead).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it.each(['boot', 'later', 'empty'])('exits head-unknown without ticking for %s HEAD read failure', async phase => {
    const deps = fixture();
    if (phase === 'later') deps.readHead.mockReturnValueOnce('boot-head');
    if (phase === 'empty') deps.readHead.mockReturnValue('  ');
    else deps.readHead.mockImplementation(() => { throw new Error('unreadable'); });
    expect(await runCiHealLoop(deps)).toEqual({ exit: 'head-unknown' });
    expect(deps.tick).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('checks HEAD again after sleeping before another iteration', async () => {
    const deps = fixture();
    deps.sleep.mockImplementation(async () => { deps.readHead.mockReturnValue('moved'); });
    expect(await runCiHealLoop(deps)).toEqual({ exit: 'head-moved' });
    expect(deps.tick).toHaveBeenCalledOnce();
    expect(deps.sleep).toHaveBeenCalledOnce();
    expect(deps.sleep).toHaveBeenCalledWith(300000);
    expect(deps.readHead).toHaveBeenCalledWith('/clone');
  });

  it('ends the loop for a dead parent', async () => {
    const deps = fixture();
    deps.parentAlive.mockReturnValue(false);
    expect(await runCiHealLoop({ ...deps, parentPid: 42 })).toEqual({ exit: 'parent-dead' });
    expect(deps.parentAlive).toHaveBeenCalledWith(42);
    expect(deps.tick).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('--once runs exactly one real iteration and never sleeps', async () => {
    const deps = fixture();
    await main(['--once', '--parent-pid=42'], deps);
    expect(deps.tick).toHaveBeenCalledOnce();
    expect(deps.parentAlive).toHaveBeenCalledWith(42);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.write).toHaveBeenCalledWith('ci-heal-loop: ciHeal.intervalSec=300 source=standard');
  });

  it('--once still refuses a dead parent', async () => {
    const deps = fixture();
    deps.parentAlive.mockReturnValue(false);
    expect(await main(['--once', '--parent-pid=42'], deps)).toEqual({ exit: 'parent-dead' });
    expect(deps.tick).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });
});

describe('CI heal interval', () => {
  it.each([undefined, null, 0, 59, 1801, 1000000, 60.5, '60', NaN])('falls back to 300 for invalid interval %s', value => {
    expect(resolveCiHealInterval({ env: {}, settings: { ciHeal: { intervalSec: value } } }).seconds).toBe(300);
  });
  it.each([60, 300, 1800])('accepts bounded interval %s', value => {
    expect(resolveCiHealInterval({ env: {}, settings: { ciHeal: { intervalSec: value } } }).seconds).toBe(value);
  });
  it('invalid environment override selects 300 over a valid tool interval', () => {
    expect(resolveCiHealInterval({ env: { WE_CI_HEAL_INTERVAL_SEC: '1801' }, settings: { ciHeal: { intervalSec: 60 } } }).seconds).toBe(300);
  });
});

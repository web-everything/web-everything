import { hostname } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { main, resolveCiHealInterval, runCiHealLoop, runCiHealLoopIteration } from '../ci-heal-loop.mjs';

function fixture() {
  let busy = false;
  const lock = {
    reserve: vi.fn(() => busy ? { ok: false } : (busy = true, { ok: true })),
    release: vi.fn(() => { busy = false; }),
  };
  return {
    root: '/clone', lock,
    locks: { acquireRead: vi.fn(() => ({ ok: true })), releaseRead: vi.fn() },
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

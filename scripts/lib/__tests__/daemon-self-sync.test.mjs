/**
 * @file scripts/lib/__tests__/daemon-self-sync.test.mjs
 * @description xv6fciw — the daemon clone self-sync. Pure decision + injected-git cases, plus one suite against
 *   REAL temporary git repos so the actual fetch/merge/abort commands are proven, not only mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  decideSelfSync, selfSyncCheckout, withSelfSync, readHeadSha, readOriginRefSha,
  DAEMON_SELF_SYNC_BRANCH_ENV, resolvePocSyncBranch, decidePocSelfSync, selfSyncCheckoutPoc,
  isSafeBranchName, decideRestart, collectImportClosure, changedFilesBetween, resolveRestartMinIntervalMs,
  DEFAULT_RESTART_MIN_INTERVAL_MS,
} from '../daemon-self-sync.mjs';
import { assertMainNotStale, isStaleMainRefusalMessage } from '../main-staleness.mjs';

describe('decideSelfSync — pure', () => {
  const base = { fetched: true, behind: 3, dirty: false, onBase: true };
  it('behind on a clean main → merge', () => expect(decideSelfSync(base).action).toBe('merge'));
  it('up to date → none', () => expect(decideSelfSync({ ...base, behind: 0 })).toEqual({ action: 'none', reason: 'up-to-date' }));
  it('a dirty tree is never touched', () => expect(decideSelfSync({ ...base, dirty: true })).toEqual({ action: 'skip', reason: 'dirty' }));
  it('not on main is never touched', () => expect(decideSelfSync({ ...base, onBase: false })).toEqual({ action: 'skip', reason: 'not-on-main' }));
  it('a failed fetch skips', () => expect(decideSelfSync({ ...base, fetched: false })).toEqual({ action: 'skip', reason: 'fetch-failed' }));
  it('an unknown tree state (status failed) fails closed — never merges', () => expect(decideSelfSync({ ...base, dirty: null })).toEqual({ action: 'skip', reason: 'status-failed' }));
  it('an unknown distance (count failed) is count-failed, NEVER up-to-date', () => expect(decideSelfSync({ ...base, behind: null })).toEqual({ action: 'skip', reason: 'count-failed' }));
  it('an unknown branch (symbolic-ref failed) is head-failed, not not-on-main', () => expect(decideSelfSync({ ...base, onBase: null })).toEqual({ action: 'skip', reason: 'head-failed' }));
});

describe('selfSyncCheckout — injected git', () => {
  const runner = (overrides = {}) => {
    const calls = [];
    const opts = [];
    const run = (args, o) => {
      calls.push(args.join(' '));
      opts.push(o);
      const key = args[0] === 'rev-list' ? 'rev-list' : args[0];
      const r = overrides[key];
      if (typeof r === 'function') return r(args);
      return r ?? { status: 0, stdout: key === 'symbolic-ref' ? 'main\n' : key === 'rev-list' ? '2\n' : '' };
    };
    return { run, calls, opts };
  };

  it('behind on a clean main → merges and reports the commit count', () => {
    const { run, calls } = runner();
    expect(selfSyncCheckout({ root: '/x', run })).toEqual({ merged: true, commits: 2, reason: 'merged' });
    expect(calls.some((c) => c.startsWith('merge origin/main'))).toBe(true);
  });

  it('a merge conflict is ABORTED — the tree is left as it was', () => {
    const { run, calls } = runner({ merge: (args) => (args[1] === '--abort' ? { status: 0, stdout: '' } : { status: 1, stdout: '', stderr: 'CONFLICT' }) });
    expect(selfSyncCheckout({ root: '/x', run })).toEqual({ merged: false, commits: 0, reason: 'conflict' });
    expect(calls).toContain('merge --abort');
  });

  it('a dirty tree never reaches merge', () => {
    const { run, calls } = runner({ status: { status: 0, stdout: ' M file.txt\n' } });
    expect(selfSyncCheckout({ root: '/x', run }).reason).toBe('dirty');
    expect(calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('runs every git command in the given root', () => {
    const seen = [];
    selfSyncCheckout({ root: '/the/clone', run: (args, opts) => { seen.push(opts.cwd); return { status: 0, stdout: args[0] === 'symbolic-ref' ? 'main' : '0' }; } });
    expect(new Set(seen)).toEqual(new Set(['/the/clone']));
  });

  it('every git command carries a timeout + SIGKILL, defaulting to 60s', () => {
    const { run, opts } = runner();
    selfSyncCheckout({ root: '/x', run });
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(o).toMatchObject({ cwd: '/x', timeout: 60_000, killSignal: 'SIGKILL' });
  });

  it('the timeout is overridable via timeoutMs, and reaches every call including merge --abort', () => {
    const { run, opts } = runner({ merge: (args) => (args[1] === '--abort' ? { status: 0, stdout: '' } : { status: 1, stdout: '', stderr: 'CONFLICT' }) });
    selfSyncCheckout({ root: '/x', run, timeoutMs: 5_000 });
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(o).toMatchObject({ timeout: 5_000, killSignal: 'SIGKILL' });
  });

  it('a timed-out fetch (null status, like a killed spawnSync) is treated as fetch-failed, never reaching merge', () => {
    const { run, calls } = runner({ fetch: { status: null, stdout: '', stderr: '', signal: 'SIGKILL' } });
    expect(selfSyncCheckout({ root: '/x', run })).toEqual({ merged: false, commits: 0, reason: 'fetch-failed' });
    expect(calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('a timed-out merge (null status) is ABORTED and reported the same as any other failed merge', () => {
    const { run, calls } = runner({
      merge: (args) => (args[1] === '--abort' ? { status: 0, stdout: '' } : { status: null, stdout: '', stderr: '', signal: 'SIGKILL' }),
    });
    expect(selfSyncCheckout({ root: '/x', run })).toEqual({ merged: false, commits: 0, reason: 'conflict' });
    expect(calls).toContain('merge --abort');
  });

  it('a timed-out git status is NOT read as a clean tree — skips as status-failed, never reaching merge', () => {
    const { run, calls } = runner({ status: { status: null, stdout: '', stderr: '', signal: 'SIGKILL' } });
    expect(selfSyncCheckout({ root: '/x', run })).toEqual({ merged: false, commits: 0, reason: 'status-failed' });
    expect(calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('a failed git status in gitRun\'s real shape (status 1, empty stdout) also skips as status-failed', () => {
    const { run } = runner({ status: { status: 1, stdout: '', stderr: 'fatal' } });
    expect(selfSyncCheckout({ root: '/x', run })).toEqual({ merged: false, commits: 0, reason: 'status-failed' });
  });

  it('a rev-list that "succeeds" but prints no number is count-failed, not up-to-date', () => {
    for (const stdout of ['', 'garbage\n']) {
      const { run } = runner({ 'rev-list': { status: 0, stdout } });
      expect(selfSyncCheckout({ root: '/x', run })).toEqual({ merged: false, commits: 0, reason: 'count-failed' });
    }
  });

  // Every git call site fed a timed-out (killed) or failed result: none may ever end in `merged: true`, AND each
  // must surface as its own distinct failure reason — never `up-to-date` (or any other success-looking reason).
  const TIMED_OUT = { status: null, stdout: '', stderr: '', signal: 'SIGKILL' };
  const FAILED = { status: 1, stdout: '', stderr: 'fatal' };
  const EXPECTED = { fetch: 'fetch-failed', 'rev-list': 'count-failed', 'symbolic-ref': 'head-failed', status: 'status-failed', merge: 'conflict' };
  for (const [site, reason] of Object.entries(EXPECTED)) {
    for (const [shape, result] of [['timed-out', TIMED_OUT], ['failed', FAILED]]) {
      it(`a ${shape} \`${site}\` never leads to merged:true and reports ${reason}`, () => {
        const { run } = runner({ [site]: result });
        expect(selfSyncCheckout({ root: '/x', run })).toEqual({ merged: false, commits: 0, reason });
      });
    }
  }
});

// #4044 Module E — the DEFAULT (non-POC) path no longer merges-then-gates in this wrapper; it calls the
// injectable `rebuild` (defaults to `daemon-rebuild.mjs#rebuildClone`, which takes its OWN write lock and runs
// the live smoke INSIDE itself — see that module's own test suite for the real-git/real-smoke proof), then
// gates the tick behind the clone's READ lock. Every test here injects a fake `rebuild`/`acquireRead`/
// `releaseRead`/`readState` so nothing ever touches a real git repo or `~/.claude/*` — the real wiring of each
// default param is proven once, separately, against mkdtemp'd dirs (last test in this block).
describe('withSelfSync — DEFAULT path: rebuild-driven (#4044 Module E)', () => {
  const emptyState = () => ({
    adopted: null, rejected: null, inProgress: null, quarantine: null,
  });
  const okLock = () => ({ ok: true });

  it('an ADOPTED rebuild restarts INSTEAD of ticking — the read lock is never even acquired', async () => {
    const tick = vi.fn();
    const onRestart = vi.fn(() => 'restarted');
    const rebuild = vi.fn(async () => ({
      moved: true, adopted: true, head: 'deadbeef', prevHead: 'old', plan: {},
    }));
    const acquireRead = vi.fn(okLock);
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x', onRestart, rebuild, acquireRead, releaseRead: vi.fn(), readState: emptyState, log: { error: vi.fn() },
    });
    await expect(w.tickOnce()).resolves.toBe('restarted');
    expect(tick).not.toHaveBeenCalled();
    expect(onRestart).toHaveBeenCalledWith(expect.objectContaining({ moved: true, adopted: true, head: 'deadbeef' }));
    expect(acquireRead).not.toHaveBeenCalled();
  });

  it('a rebuild that moves nothing still ticks, under the read lock', async () => {
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    const readState = vi.fn(emptyState);
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart: vi.fn(), rebuild, acquireRead: okLock, releaseRead: vi.fn(), readState,
    });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(readState).toHaveBeenCalledWith('/x', expect.anything());
  });

  it('a reason other than up-to-date is logged, and the tick still runs', async () => {
    const log = { error: vi.fn() };
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'fetch-failed' }));
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart: vi.fn(), rebuild, acquireRead: okLock, releaseRead: vi.fn(), readState: emptyState, log,
    });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('fetch-failed'));
  });

  it('a refused read lock skips the tick entirely — never reads a tree mid-move', async () => {
    const tick = vi.fn();
    const log = { error: vi.fn() };
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x', onRestart: vi.fn(), rebuild, acquireRead: () => ({ ok: false, reason: 'writer-active' }), log,
    });
    await expect(w.tickOnce()).resolves.toMatchObject({ skipped: true, reason: 'writer-active', repos: [], dispatched: [], failed: [] });
    expect(tick).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('writer-active'));
  });

  it('a quarantined rebuild state skips the tick and never restarts', async () => {
    const tick = vi.fn();
    const onRestart = vi.fn();
    const releaseRead = vi.fn();
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x',
      onRestart,
      rebuild,
      acquireRead: okLock,
      releaseRead,
      readState: () => ({
        adopted: null, rejected: null, inProgress: null, quarantine: { prevHead: 'x', reason: 'rollback-failed' },
      }),
      log: { error: vi.fn() },
    });
    await expect(w.tickOnce()).resolves.toMatchObject({ skipped: true, reason: 'quarantine', repos: [], dispatched: [], failed: [] });
    expect(tick).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    expect(releaseRead).toHaveBeenCalledTimes(1); // released even though the tick never ran
  });

  it('HEAD moved since boot (an adopted rebuild this process did not itself perform) restarts, releasing the read lock FIRST', async () => {
    const tick = vi.fn();
    const order = [];
    const onRestart = vi.fn((r) => { order.push('onRestart'); return `restarted:${r.reason}`; });
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    const readHead = vi.fn().mockReturnValueOnce('sha-boot').mockReturnValueOnce('sha-after');
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x',
      onRestart,
      rebuild,
      acquireRead: okLock,
      releaseRead: () => order.push('release'),
      readState: emptyState,
      readHead,
      log: { error: vi.fn() },
    });
    await expect(w.tickOnce()).resolves.toBe('restarted:head-moved');
    expect(tick).not.toHaveBeenCalled();
    expect(onRestart).toHaveBeenCalledWith(expect.objectContaining({ reason: 'head-moved', headSha: 'sha-after' }));
    expect(order).toEqual(['release', 'onRestart']); // released BEFORE onRestart, per spec
  });

  it('an unreadable HEAD (readHead null) never falsely restarts — skips the drift check, ticks normally', async () => {
    const onRestart = vi.fn();
    const readHead = vi.fn(() => null);
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart, rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
      acquireRead: okLock, releaseRead: vi.fn(), readState: emptyState, readHead,
    });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('HEAD unchanged since boot → ticks normally', async () => {
    const readHead = vi.fn(() => 'sha-boot'); // same value at boot and mid-tick
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart: vi.fn(), rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
      acquireRead: okLock, releaseRead: vi.fn(), readState: emptyState, readHead,
    });
    await expect(w.tickOnce()).resolves.toBe('ticked');
  });

  it('the read lock is released even when the wrapped tick throws', async () => {
    const releaseRead = vi.fn();
    const w = withSelfSync({ tickOnce: () => { throw new Error('boom'); } }, {
      root: '/x', onRestart: vi.fn(), rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
      acquireRead: okLock, releaseRead, readState: emptyState,
    });
    await expect(w.tickOnce()).rejects.toThrow('boom');
    expect(releaseRead).toHaveBeenCalledTimes(1);
  });

  it('at wrapper construction, sets WE_DAEMON_MANAGED_CLONE and GIT_OPTIONAL_LOCKS so children inherit them', () => {
    const prevManaged = process.env.WE_DAEMON_MANAGED_CLONE;
    const prevLocks = process.env.GIT_OPTIONAL_LOCKS;
    delete process.env.WE_DAEMON_MANAGED_CLONE;
    delete process.env.GIT_OPTIONAL_LOCKS;
    try {
      withSelfSync({ tickOnce: vi.fn() }, {
        root: '/x', onRestart: vi.fn(), rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
      });
      expect(process.env.WE_DAEMON_MANAGED_CLONE).toBe('1');
      expect(process.env.GIT_OPTIONAL_LOCKS).toBe('0');
    } finally {
      if (prevManaged === undefined) delete process.env.WE_DAEMON_MANAGED_CLONE; else process.env.WE_DAEMON_MANAGED_CLONE = prevManaged;
      if (prevLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS; else process.env.GIT_OPTIONAL_LOCKS = prevLocks;
    }
  });

  // The real default `rebuild` param really is `daemon-rebuild.mjs#rebuildClone`, wired with THIS wrapper's own
  // root/env/log/mainOnly — proven against a real (non-git) temp dir with lock/state roots pinned to mkdtemp
  // dirs via `env`, per the house rule (never `~/.claude/*` in tests). `rebuildClone`'s own real-git/real-smoke
  // behavior is proven end-to-end in `daemon-rebuild.test.mjs`; this only proves the WIRING.
  it('the default rebuild param wires straight to daemon-rebuild.mjs#rebuildClone (no injection needed)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'self-sync-default-rebuild-'));
    const lockRoot = mkdtempSync(join(tmpdir(), 'self-sync-default-rebuild-lock-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'self-sync-default-rebuild-state-'));
    try {
      const env = { ...process.env, WE_DAEMON_CLONE_LOCK_ROOT: lockRoot, WE_DAEMON_STATE_DIR: stateDir };
      // `root` is not a git repo at all — rebuildClone's own real, fail-closed `not-on-main` refusal (proven
      // end-to-end for real repos in daemon-rebuild.test.mjs) means the tick just runs through, unmodified.
      const w = withSelfSync({ tickOnce: () => 'ticked' }, {
        root, onRestart: vi.fn(), env, log: { error: vi.fn() },
        acquireRead: okLock, releaseRead: vi.fn(), readState: emptyState,
      });
      await expect(w.tickOnce()).resolves.toBe('ticked');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(lockRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('readOriginRefSha — injected git', () => {
  it('reads a ref sha', () => {
    const run = vi.fn(() => ({ status: 0, stdout: 'deadbeef\n' }));
    expect(readOriginRefSha({ root: '/x', ref: 'origin/main', run })).toBe('deadbeef');
    expect(run).toHaveBeenCalledWith(['rev-parse', 'origin/main'], expect.objectContaining({ cwd: '/x', timeout: 60_000, killSignal: 'SIGKILL' }));
  });
  it('a failed/timed-out read is null, never a guess', () => {
    expect(readOriginRefSha({ root: '/x', ref: 'origin/main', run: () => ({ status: 1, stdout: '' }) })).toBeNull();
    expect(readOriginRefSha({ root: '/x', ref: 'origin/main', run: () => ({ status: null, stdout: '' }) })).toBeNull();
  });
});

// #3383 bug 1 (unchanged in spirit, now rebuild-driven — #4044 Module E) — a tick that ITSELF hit the
// stale-main refusal (origin/main moved AFTER this tick-start rebuild, mid-tick, across a multi-repo loop)
// wasted the affected repo(s) this pass. Rebuild IMMEDIATELY when that happens, rather than let the daemon
// sleep the full interval and lose the SAME race again next tick — NEVER a raw sync/merge (see the file
// header: `sync` is accepted but unused on this path now).
describe('withSelfSync — mid-tick stale refusal reacts immediately (#3383 bug 1 / #4044)', () => {
  const emptyState = () => ({
    adopted: null, rejected: null, inProgress: null, quarantine: null,
  });
  const okLock = () => ({ ok: true });

  it('a tick result flagged by hasStaleRefusal triggers an immediate REBUILD + restart when it adopts', async () => {
    const onRestart = vi.fn(() => 'restarted');
    const tickResult = { refusals: [{ repo: 'frontier-ui/frontierui', kind: 'tick-failed', why: 'review-dispatch: ... STALE code from this checkout ... (#3439)' }] };
    const rebuild = vi.fn()
      .mockResolvedValueOnce({ moved: false, reason: 'up-to-date' }) // tick-start rebuild: nothing to do yet
      .mockResolvedValueOnce({ moved: true, adopted: true, head: 'newsha' }); // the immediate rebuild after the tick
    const w = withSelfSync({ tickOnce: () => tickResult }, {
      root: '/x', onRestart, rebuild, acquireRead: okLock, releaseRead: vi.fn(), readState: emptyState, log: { error: vi.fn() },
      hasStaleRefusal: (r) => (r.refusals ?? []).some((x) => /STALE code from this checkout/.test(x.why)),
    });
    await expect(w.tickOnce()).resolves.toBe('restarted');
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(onRestart).toHaveBeenCalledWith(expect.objectContaining({ moved: true, adopted: true, head: 'newsha' }));
  });

  it('a flagged tick result whose immediate rebuild adopts nothing still returns the tick result, never worse than before', async () => {
    const tickResult = { refusals: [{ repo: 'x', kind: 'tick-failed', why: 'STALE code from this checkout' }] };
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    const w = withSelfSync({ tickOnce: () => tickResult }, {
      root: '/x', onRestart: vi.fn(), rebuild, acquireRead: okLock, releaseRead: vi.fn(), readState: emptyState,
      hasStaleRefusal: (r) => (r.refusals ?? []).length > 0,
    });
    await expect(w.tickOnce()).resolves.toBe(tickResult);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('an UNFLAGGED tick result never triggers a second rebuild call at all (no hasStaleRefusal wired)', async () => {
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    const w = withSelfSync({ tickOnce: () => ({ ok: true }) }, {
      root: '/x', onRestart: vi.fn(), rebuild, acquireRead: okLock, releaseRead: vi.fn(), readState: emptyState,
    });
    await w.tickOnce();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
});

describe('withSelfSync — bounded stale recovery while main moves', () => {
  function harness({ imported = false, refuseAgain = false, quarantineRetry = false, lockRetry = false } = {}) {
    let head = 'boot';
    let origin = 'boot';
    let readLocked = false;
    const events = [];
    const stale = { failed: [{ error: 'STALE code from this checkout' }] };
    const success = { dispatched: [{ prNumber: 3176 }], failed: [] };
    const tick = vi.fn(() => {
      expect(readLocked).toBe(true);
      events.push('discover');
      if (tick.mock.calls.length === 1 || refuseAgain) origin = `main-${tick.mock.calls.length}`;
      try {
        assertMainNotStale('/fake', () => head === origin
          ? { fresh: true, behind: 0 }
          : { action: 'warn', behind: 1, dirty: false }, {
          listBehindFiles: () => ['child.mjs'], lastGood: () => null, write: () => {},
        });
        return success;
      } catch (error) {
        expect(isStaleMainRefusalMessage(error.message)).toBe(true);
        return stale;
      }
    });
    const rebuild = vi.fn(async () => {
      expect(readLocked).toBe(false);
      events.push('rebuild');
      if (rebuild.mock.calls.length === 1) return { moved: false, reason: 'up-to-date' };
      head = origin;
      return { moved: true, adopted: true, head };
    });
    const onRestart = vi.fn(() => 'restarted');
    const wrapped = withSelfSync({ tickOnce: tick }, {
      root: '/fake', rebuild, onRestart, readHead: () => head,
      now: () => 0, minRestartIntervalMs: 600_000,
      diffFiles: ({ from, to }) => from === to ? [] : [imported ? 'daemon.mjs' : 'child.mjs'],
      importClosure: () => ({ complete: true, files: new Set(['daemon.mjs']) }),
      acquireRead: () => {
        events.push('lock');
        if (lockRetry && tick.mock.calls.length) return { ok: false, reason: 'writer-active' };
        readLocked = true;
        return { ok: true };
      },
      releaseRead: () => { events.push('unlock'); readLocked = false; },
      readState: () => ({ quarantine: quarantineRetry && tick.mock.calls.length > 0 }),
      hasStaleRefusal: (r) => r.failed?.some((f) => isStaleMainRefusalMessage(f.error)),
      log: { error: vi.fn() },
    });
    return { wrapped, events, tick, rebuild, onRestart, stale, success };
  }

  it('re-discovers in the same pass after gated adoption, under a fresh read lock', async () => {
    const h = harness();
    await expect(h.wrapped.tickOnce('payload')).resolves.toBe(h.success);
    expect(h.events).toEqual(['rebuild', 'lock', 'discover', 'unlock', 'rebuild', 'lock', 'discover', 'unlock']);
    expect(h.tick.mock.calls).toEqual([['payload'], ['payload']]);
    expect(h.onRestart).not.toHaveBeenCalled();
  });

  it('ignores the restart debounce when stale recovery requires freshly loaded modules', async () => {
    const h = harness({ imported: true });
    await expect(h.wrapped.tickOnce()).resolves.toBe('restarted');
    expect(h.tick).toHaveBeenCalledTimes(1);
    expect(h.onRestart).toHaveBeenCalledTimes(1);
  });

  it('bounds recovery if main moves again during the retry', async () => {
    const h = harness({ refuseAgain: true });
    await expect(h.wrapped.tickOnce()).resolves.toBe(h.stale);
    expect(h.tick).toHaveBeenCalledTimes(2);
    expect(h.rebuild).toHaveBeenCalledTimes(2);
  });

  it.each([{ quarantineRetry: true }, { lockRetry: true }])('rechecks safety before retry: %j', async (opts) => {
    const h = harness(opts);
    expect(await h.wrapped.tickOnce()).toMatchObject({ skipped: true });
    expect(h.tick).toHaveBeenCalledTimes(1);
  });

  it('50 moving-main passes deliver owed reviews without waiting for another interval', async () => {
    for (let pass = 0; pass < 50; pass += 1) {
      const h = harness();
      const result = await h.wrapped.tickOnce();
      expect(result.dispatched).toEqual([{ prNumber: 3176 }]);
      expect(h.rebuild).toHaveBeenCalledTimes(2);
    }
  });
});

describe('selfSyncCheckout — REAL git (temp repos)', () => {
  let dir;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, file, text) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', file); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `edit ${file}`); };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'self-sync-'));
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(dir, 'clone', '-q', 'origin.git', 'upstream');
    const up = join(dir, 'upstream');
    git(up, 'checkout', '-q', '-b', 'main');
    commit(up, 'a.txt', 'one\n');
    git(up, 'push', '-q', 'origin', 'main');
    git(dir, 'clone', '-q', '-b', 'main', 'origin.git', 'daemon');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('behind AND ahead (the real daemon-clone shape) → a real merge lands both', () => {
    const up = join(dir, 'upstream'); const d = join(dir, 'daemon');
    commit(d, 'local.txt', 'run-ahead fix\n'); // the clone is ahead
    commit(up, 'b.txt', 'two\n'); git(up, 'push', '-q', 'origin', 'main'); // and behind
    const r = selfSyncCheckout({ root: d, run: (args, opts) => {
      try { return { status: 0, stdout: execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
      catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
    } });
    expect(r).toEqual({ merged: true, commits: 1, reason: 'merged' });
    expect(git(d, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('0');
    expect(git(d, 'ls-files').split('\n')).toEqual(expect.arrayContaining(['b.txt', 'local.txt']));
  });

  it('a conflicting upstream change → merge aborted, tree and HEAD unchanged', () => {
    const up = join(dir, 'upstream'); const d = join(dir, 'daemon');
    commit(d, 'a.txt', 'daemon side\n');
    commit(up, 'a.txt', 'upstream side\n'); git(up, 'push', '-q', 'origin', 'main');
    const headBefore = git(d, 'rev-parse', 'HEAD').trim();
    const r = selfSyncCheckout({ root: d, run: (args, opts) => {
      try { return { status: 0, stdout: execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
      catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
    } });
    expect(r.reason).toBe('conflict');
    expect(git(d, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(git(d, 'status', '--porcelain').trim()).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// POC MODE (#3383 daemon POC) — DAEMON_SELF_SYNC_BRANCH
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('resolvePocSyncBranch — pure', () => {
  it('unset env, no explicit option → null (default path)', () => expect(resolvePocSyncBranch({ env: {} })).toBeNull());
  it('blank env → null', () => expect(resolvePocSyncBranch({ env: { [DAEMON_SELF_SYNC_BRANCH_ENV]: '   ' } })).toBeNull());
  it('env set → that branch', () => expect(resolvePocSyncBranch({ env: { [DAEMON_SELF_SYNC_BRANCH_ENV]: 'lane/daemon-poc' } })).toBe('lane/daemon-poc'));
  it('an explicit option wins over env', () => expect(resolvePocSyncBranch({ pocBranch: 'lane/x', env: { [DAEMON_SELF_SYNC_BRANCH_ENV]: 'lane/y' } })).toBe('lane/x'));
});

describe('decidePocSelfSync — pure', () => {
  const clean = { dirty: false, onBranch: true };
  const src = (behind) => ({ fetched: true, behind });
  it('behind on main only → merge main, not poc', () => {
    expect(decidePocSelfSync({ ...clean, main: src(2), poc: src(0) })).toEqual({ action: 'merge', reason: 'behind', mergeMain: true, mergePoc: false });
  });
  it('behind on poc only → merge poc, not main', () => {
    expect(decidePocSelfSync({ ...clean, main: src(0), poc: src(3) })).toEqual({ action: 'merge', reason: 'behind', mergeMain: false, mergePoc: true });
  });
  it('behind on both → merge both', () => {
    expect(decidePocSelfSync({ ...clean, main: src(1), poc: src(1) })).toEqual({ action: 'merge', reason: 'behind', mergeMain: true, mergePoc: true });
  });
  it('up to date on both → none', () => {
    expect(decidePocSelfSync({ ...clean, main: src(0), poc: src(0) })).toEqual({ action: 'none', reason: 'up-to-date', mergeMain: false, mergePoc: false });
  });
  it('a dirty tree is never touched, whatever either source reports', () => {
    expect(decidePocSelfSync({ dirty: true, onBranch: true, main: src(5), poc: src(5) })).toEqual({ action: 'skip', reason: 'dirty', mergeMain: false, mergePoc: false });
  });
  it('not on the poc branch is never touched', () => {
    expect(decidePocSelfSync({ dirty: false, onBranch: false, main: src(5), poc: src(5) })).toEqual({ action: 'skip', reason: 'not-on-branch', mergeMain: false, mergePoc: false });
  });
  it('both fetches failed → skip fetch-failed', () => {
    expect(decidePocSelfSync({ ...clean, main: { fetched: false, behind: 0 }, poc: { fetched: false, behind: 0 } })).toEqual({ action: 'skip', reason: 'fetch-failed', mergeMain: false, mergePoc: false });
  });
  it('one fetch failed, the other behind → still merges the one that fetched', () => {
    expect(decidePocSelfSync({ ...clean, main: { fetched: false, behind: 0 }, poc: src(2) })).toEqual({ action: 'merge', reason: 'behind', mergeMain: false, mergePoc: true });
  });
  it('an unknown branch (symbolic-ref failed) is head-failed, not not-on-branch', () => {
    expect(decidePocSelfSync({ dirty: false, onBranch: null, main: src(5), poc: src(5) })).toEqual({ action: 'skip', reason: 'head-failed', mergeMain: false, mergePoc: false });
  });
  it('an unknown tree state (status failed) fails closed — never merges', () => {
    expect(decidePocSelfSync({ dirty: null, onBranch: true, main: src(5), poc: src(5) })).toEqual({ action: 'skip', reason: 'status-failed', mergeMain: false, mergePoc: false });
  });
  it('a fetched source with an unknown count (rev-list failed) never merges that source', () => {
    expect(decidePocSelfSync({ ...clean, main: { fetched: true, behind: null }, poc: src(0) })).toEqual({ action: 'skip', reason: 'count-failed', mergeMain: false, mergePoc: false });
  });
  it('an unknown count on one source does not block a real merge on the OTHER', () => {
    expect(decidePocSelfSync({ ...clean, main: { fetched: true, behind: null }, poc: src(3) })).toEqual({ action: 'merge', reason: 'behind', mergeMain: false, mergePoc: true });
  });
});

describe('selfSyncCheckoutPoc — injected git', () => {
  const runner = (overrides = {}) => {
    const calls = [];
    const opts = [];
    const run = (args, o) => {
      calls.push(args.join(' '));
      opts.push(o);
      const key = args[0] === 'rev-list' ? 'rev-list' : args[0];
      const r = overrides[key];
      if (typeof r === 'function') return r(args);
      return r ?? { status: 0, stdout: key === 'symbolic-ref' ? 'lane/daemon-poc\n' : key === 'rev-list' ? '1\n' : '' };
    };
    return { run, calls, opts };
  };

  it('requires a pocBranch', () => expect(() => selfSyncCheckoutPoc({ root: '/x', run: () => ({ status: 0, stdout: '' }) })).toThrow(/pocBranch/));

  it('behind on both, clean tree → merges both sources', () => {
    const { run, calls } = runner();
    expect(selfSyncCheckoutPoc({ root: '/x', pocBranch: 'lane/daemon-poc', run })).toEqual({ merged: true, commits: 2, reason: 'merged' });
    expect(calls.some((c) => c.startsWith('merge origin/main'))).toBe(true);
    expect(calls.some((c) => c.startsWith('merge origin/lane/daemon-poc'))).toBe(true);
  });

  it('a conflict on main STOPS the tick — poc is never attempted', () => {
    const { run, calls } = runner({ merge: (args) => (args[1] === '--abort' ? { status: 0, stdout: '' } : args[1] === 'origin/main' ? { status: 1, stdout: '', stderr: 'CONFLICT' } : { status: 0, stdout: '' }) });
    expect(selfSyncCheckoutPoc({ root: '/x', pocBranch: 'lane/daemon-poc', run })).toEqual({ merged: false, commits: 0, reason: 'conflict' });
    expect(calls).toContain('merge --abort');
    expect(calls.some((c) => c.startsWith('merge origin/lane/daemon-poc'))).toBe(false);
  });

  it('main merges clean, poc conflicts → merged-partial (main progress is kept)', () => {
    const { run } = runner({ merge: (args) => (args[1] === '--abort' ? { status: 0, stdout: '' } : args[1] === 'origin/main' ? { status: 0, stdout: '' } : { status: 1, stdout: '', stderr: 'CONFLICT' }) });
    expect(selfSyncCheckoutPoc({ root: '/x', pocBranch: 'lane/daemon-poc', run })).toEqual({ merged: true, commits: 1, reason: 'merged-partial' });
  });

  it('a dirty tree never reaches merge', () => {
    const { run, calls } = runner({ status: { status: 0, stdout: ' M file.txt\n' } });
    expect(selfSyncCheckoutPoc({ root: '/x', pocBranch: 'lane/daemon-poc', run }).reason).toBe('dirty');
    expect(calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('not on the poc branch is never touched', () => {
    const { run } = runner({ 'symbolic-ref': { status: 0, stdout: 'main\n' } });
    expect(selfSyncCheckoutPoc({ root: '/x', pocBranch: 'lane/daemon-poc', run }).reason).toBe('not-on-branch');
  });

  it('every git command carries a timeout + SIGKILL, defaulting to 60s, overridable via timeoutMs', () => {
    const { run, opts } = runner();
    selfSyncCheckoutPoc({ root: '/x', pocBranch: 'lane/daemon-poc', run });
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(o).toMatchObject({ cwd: '/x', timeout: 60_000, killSignal: 'SIGKILL' });

    const { run: run2, opts: opts2 } = runner();
    selfSyncCheckoutPoc({ root: '/x', pocBranch: 'lane/daemon-poc', run: run2, timeoutMs: 5_000 });
    for (const o of opts2) expect(o).toMatchObject({ timeout: 5_000 });
  });

  it('a timed-out status is NOT read as clean — status-failed, never reaching merge', () => {
    const { run, calls } = runner({ status: { status: null, stdout: '', stderr: '', signal: 'SIGKILL' } });
    expect(selfSyncCheckoutPoc({ root: '/x', pocBranch: 'lane/daemon-poc', run })).toEqual({ merged: false, commits: 0, reason: 'status-failed' });
    expect(calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('a rev-list that "succeeds" with no number on the only behind source is count-failed, not up-to-date', () => {
    const { run } = runner({
      'rev-list': (args) => (args.includes(`HEAD..origin/main`) ? { status: 0, stdout: 'garbage\n' } : { status: 0, stdout: '0\n' }),
    });
    expect(selfSyncCheckoutPoc({ root: '/x', pocBranch: 'lane/daemon-poc', run })).toEqual({ merged: false, commits: 0, reason: 'count-failed' });
  });
});

describe('withSelfSync — POC mode dispatch', () => {
  it('DAEMON_SELF_SYNC_BRANCH set → routes through syncPoc, not sync', async () => {
    const tick = vi.fn(); const onRestart = vi.fn(() => 'restarted');
    const syncPoc = vi.fn(() => ({ merged: true, commits: 3, reason: 'merged' }));
    const sync = vi.fn();
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x', onRestart, sync, syncPoc, log: { error: vi.fn() },
      env: { [DAEMON_SELF_SYNC_BRANCH_ENV]: 'lane/daemon-poc' },
    });
    await expect(w.tickOnce()).resolves.toBe('restarted');
    expect(syncPoc).toHaveBeenCalledWith({ root: '/x', base: 'main', pocBranch: 'lane/daemon-poc' });
    expect(sync).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });

  it('unset env → routes through the DEFAULT rebuild path, not syncPoc', async () => {
    const syncPoc = vi.fn();
    const rebuild = vi.fn(async () => ({ moved: false, reason: 'up-to-date' }));
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart: vi.fn(), rebuild, syncPoc, env: {},
      acquireRead: () => ({ ok: true }), releaseRead: vi.fn(), readState: () => ({
        adopted: null, rejected: null, inProgress: null, quarantine: null,
      }),
    });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(syncPoc).not.toHaveBeenCalled();
  });

  it('a merged-partial POC result still restarts, and logs that the other source needs a hand merge', async () => {
    const log = { error: vi.fn() };
    const w = withSelfSync({ tickOnce: vi.fn() }, {
      root: '/x', onRestart: vi.fn(() => 'restarted'), syncPoc: () => ({ merged: true, commits: 1, reason: 'merged-partial' }), log,
      env: { [DAEMON_SELF_SYNC_BRANCH_ENV]: 'lane/daemon-poc' },
    });
    await expect(w.tickOnce()).resolves.toBe('restarted');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('needs a hand merge'));
  });

  it('POC conflict still ticks (never worse than the default path)', async () => {
    const log = { error: vi.fn() };
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart: vi.fn(), syncPoc: () => ({ merged: false, commits: 0, reason: 'conflict' }), log,
      env: { [DAEMON_SELF_SYNC_BRANCH_ENV]: 'lane/daemon-poc' },
    });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('needs a hand merge'));
  });

  for (const reason of ['fetch-failed', 'count-failed', 'head-failed', 'status-failed']) {
    it(`POC ${reason} still ticks and is logged, not silent`, async () => {
      const log = { error: vi.fn() };
      const w = withSelfSync({ tickOnce: () => 'ticked' }, {
        root: '/x', onRestart: vi.fn(), syncPoc: () => ({ merged: false, commits: 0, reason }), log,
        env: { [DAEMON_SELF_SYNC_BRANCH_ENV]: 'lane/daemon-poc' },
      });
      await expect(w.tickOnce()).resolves.toBe('ticked');
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining(reason));
    });
  }

  it('an explicit timeoutMs is forwarded to the injected syncPoc', async () => {
    const syncPoc = vi.fn(() => ({ merged: false, commits: 0, reason: 'up-to-date' }));
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart: vi.fn(), syncPoc, timeoutMs: 5_000,
      env: { [DAEMON_SELF_SYNC_BRANCH_ENV]: 'lane/daemon-poc' },
    });
    await w.tickOnce();
    expect(syncPoc).toHaveBeenCalledWith({ root: '/x', base: 'main', pocBranch: 'lane/daemon-poc', timeoutMs: 5_000 });
  });
});

describe('selfSyncCheckoutPoc — REAL git (temp repos, two upstreams)', () => {
  let dir;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, file, text) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', file); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `edit ${file}`); };
  const realRun = (args, opts) => {
    try { return { status: 0, stdout: execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'self-sync-poc-'));
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(dir, 'clone', '-q', 'origin.git', 'upstream');
    const up = join(dir, 'upstream');
    git(up, 'checkout', '-q', '-b', 'main');
    commit(up, 'a.txt', 'one\n');
    git(up, 'push', '-q', 'origin', 'main');
    // lane/daemon-poc starts equal to main, then diverges with its own commit.
    git(up, 'push', '-q', 'origin', 'main:lane/daemon-poc');
    commit(up, 'poc-only.txt', 'poc side\n');
    git(up, 'push', '-q', 'origin', 'HEAD:lane/daemon-poc');
    git(up, 'reset', '-q', '--hard', 'origin/main'); // put upstream back on plain main for later commits
    git(dir, 'clone', '-q', '-b', 'main', 'origin.git', 'daemon');
    git(join(dir, 'daemon'), 'branch', '-q', 'lane/daemon-poc', 'origin/main');
    git(join(dir, 'daemon'), 'checkout', '-q', 'lane/daemon-poc');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('merges NEW commits from both origin/main and origin/lane/daemon-poc in one tick', () => {
    const up = join(dir, 'upstream'); const d = join(dir, 'daemon');
    commit(up, 'b.txt', 'two\n'); git(up, 'push', '-q', 'origin', 'main'); // main gets a new commit
    const r = selfSyncCheckoutPoc({ root: d, base: 'main', pocBranch: 'lane/daemon-poc', run: realRun });
    expect(r).toEqual({ merged: true, commits: 2, reason: 'merged' }); // 1 from main (b.txt) + 1 already on lane/daemon-poc (poc-only.txt)
    expect(git(d, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('0');
    expect(git(d, 'rev-list', '--count', 'HEAD..origin/lane/daemon-poc').trim()).toBe('0');
    expect(git(d, 'ls-files').split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'poc-only.txt']));
  });

  it('a conflicting origin/lane/daemon-poc change aborts cleanly — tree and HEAD unchanged', () => {
    const d = join(dir, 'daemon');
    // Make the daemon clone's own tip conflict with what's already on lane/daemon-poc (poc-only.txt content).
    commit(d, 'poc-only.txt', 'daemon side, conflicting\n');
    const headBefore = git(d, 'rev-parse', 'HEAD').trim();
    const r = selfSyncCheckoutPoc({ root: d, base: 'main', pocBranch: 'lane/daemon-poc', run: realRun });
    expect(r.reason).toBe('conflict');
    expect(r.merged).toBe(false);
    expect(git(d, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(git(d, 'status', '--porcelain').trim()).toBe('');
  });

  it('a leading-dash pocBranch is REFUSED before any git runs — never parsed as a git option (argv injection)', () => {
    const d = join(dir, 'daemon');
    const marker = join(dir, 'pwned');
    const evil = `--upload-pack=touch ${marker};`;
    expect(() => selfSyncCheckoutPoc({ root: d, base: 'main', pocBranch: evil, run: realRun })).toThrow(/not a safe branch name/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('isSafeBranchName — pure (argv-injection guard for an external branch string)', () => {
  it.each(['main', 'lane/daemon-poc', 'lane/xii6vye-daemon-poc-graduation', 'feature/a.b_c-1'])('accepts %s', (n) => expect(isSafeBranchName(n)).toBe(true));
  it.each([
    '', '-x', '--upload-pack=touch /tmp/pwned;', 'a b', 'a;b', 'a$(x)', 'a..b', 'a//b', '/a', 'a/', '.a', 'a/.b',
    'a.lock', 'a/b.lock', 'a@{1}', '@', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'a.', 'a\nb', null, undefined, 42,
  ])('rejects %j', (n) => expect(isSafeBranchName(n)).toBe(false));
});

describe('POC-mode branch validation — every entry point fails closed', () => {
  it('resolvePocSyncBranch throws on an unsafe explicit option', () => expect(() => resolvePocSyncBranch({ pocBranch: '--upload-pack=x', env: {} })).toThrow(/not a safe branch name/));
  it('resolvePocSyncBranch throws on an unsafe env value', () => expect(() => resolvePocSyncBranch({ env: { [DAEMON_SELF_SYNC_BRANCH_ENV]: '-evil' } })).toThrow(/not a safe branch name/));
  it('withSelfSync refuses to build (no git ever runs) when the env names an unsafe branch', () => {
    const syncPoc = vi.fn(); const sync = vi.fn();
    expect(() => withSelfSync({ tickOnce: vi.fn() }, {
      root: '/x', onRestart: vi.fn(), sync, syncPoc, log: { error: vi.fn() },
      env: { [DAEMON_SELF_SYNC_BRANCH_ENV]: '--upload-pack=touch /tmp/pwned;' },
    })).toThrow(/not a safe branch name/);
    expect(syncPoc).not.toHaveBeenCalled();
  });
  it('selfSyncCheckoutPoc fetches with a `--` separator so even a ref is never read as an option', () => {
    const calls = [];
    const run = (args) => { calls.push(args); return { status: 0, stdout: args[0] === 'symbolic-ref' ? 'lane/daemon-poc\n' : args[0] === 'rev-list' ? '0\n' : '' }; };
    selfSyncCheckoutPoc({ root: '/x', pocBranch: 'lane/daemon-poc', run });
    const fetches = calls.filter((a) => a[0] === 'fetch');
    expect(fetches).toHaveLength(2);
    for (const f of fetches) expect(f.indexOf('--')).toBeGreaterThan(-1);
    for (const f of fetches) expect(f.indexOf('--')).toBeLessThan(f.indexOf('origin'));
  });
});

// Advisory finding (PR #2625, correctness/test-pollution): withSelfSync sets WE_DAEMON_MANAGED_CLONE /
// GIT_OPTIONAL_LOCKS on process.env (on purpose — the real daemon's children must inherit them). In a reused
// vitest worker that leaked into LATER test files and flipped assertMainNotStale into managed-clone mode there.
// vitest.setup.ts now restores process.env after every test; these two tests prove it (order matters: the
// first deliberately leaves the vars set, the second must not see them).
describe('process.env writes never leak past one test (vitest.setup.ts restore)', () => {
  it('step 1: a bare withSelfSync call sets the managed-clone vars and does NOT restore them', () => {
    withSelfSync({ tickOnce: vi.fn() }, {
      root: '/x', onRestart: vi.fn(), rebuild: async () => ({ moved: false, reason: 'up-to-date' }),
    });
    expect(process.env.WE_DAEMON_MANAGED_CLONE).toBe('1');
  });
  it('step 2: the next test starts without them', () => {
    expect(process.env.WE_DAEMON_MANAGED_CLONE).toBeUndefined();
  });
});

// #4044 LIVE BUG 2 (2026-09-25): every rebuild that moved the clone restarted EVERY daemon on it — each main move,
// every few minutes during drain activity, though most moves only touch backlog/*.md — starving the fix-dispatch
// daemon's 120s ticks. The restart gate: restart only when a file the daemon IMPORTS changed, at most once per window.
describe('decideRestart — pure (#4044 restart gate)', () => {
  const closure = { files: new Set(['skills-src/conveyor/review-daemon.mjs', 'scripts/lib/x.mjs']), complete: true, bareDeps: true, jsonNames: new Set(['poc-branches.json']) };
  it('a move touching only files the daemon does not import → no restart', () => {
    expect(decideRestart({ changedFiles: ['backlog/4143.md', 'scripts/other.mjs'], closure, uptimeMs: 1e9, minIntervalMs: 0 }))
      .toMatchObject({ restart: false, reason: 'no-imported-change' });
  });
  it('an imported file changed, window elapsed → restart', () => {
    expect(decideRestart({ changedFiles: ['scripts/lib/x.mjs'], closure, uptimeMs: 700_000, minIntervalMs: 600_000 }))
      .toMatchObject({ restart: true, reason: 'imported-change', relevant: ['scripts/lib/x.mjs'] });
  });
  it('an imported file changed inside the window → deferred (min-interval), never dropped', () => {
    expect(decideRestart({ changedFiles: ['scripts/lib/x.mjs'], closure, uptimeMs: 60_000, minIntervalMs: 600_000 }))
      .toMatchObject({ restart: false, reason: 'min-interval' });
  });
  it('package.json / package-lock.json count when the daemon imports any package', () => {
    expect(decideRestart({ changedFiles: ['package-lock.json'], closure, uptimeMs: 1e9, minIntervalMs: 0 }).restart).toBe(true);
  });
  it('a .json the closure names as a string literal (a runtime-read config) counts', () => {
    expect(decideRestart({ changedFiles: ['scripts/lib/poc-branches.json'], closure, uptimeMs: 1e9, minIntervalMs: 0 }).restart).toBe(true);
  });
  it('an unknown diff (git failed) restarts NOW — the fail-safe, pre-gate behavior, never throttled', () => {
    expect(decideRestart({ changedFiles: null, closure, uptimeMs: 0, minIntervalMs: 600_000 })).toMatchObject({ restart: true, reason: 'diff-unknown' });
  });
  it('an unknown/incomplete closure falls back to "any non-test code file changed"', () => {
    expect(decideRestart({ changedFiles: ['backlog/1.md', 'scripts/__tests__/a.test.mjs'], closure: null, uptimeMs: 1e9, minIntervalMs: 0 }).restart).toBe(false);
    expect(decideRestart({ changedFiles: ['backlog/1.md', 'scripts/a.mjs'], closure: { ...closure, complete: false }, uptimeMs: 1e9, minIntervalMs: 0 }).restart).toBe(true);
  });
  it('the window reads WE_DAEMON_RESTART_MIN_INTERVAL_MS, defaulting to 2 minutes', () => {
    expect(resolveRestartMinIntervalMs({})).toBe(DEFAULT_RESTART_MIN_INTERVAL_MS);
    expect(DEFAULT_RESTART_MIN_INTERVAL_MS).toBe(120_000);
    expect(resolveRestartMinIntervalMs({ WE_DAEMON_RESTART_MIN_INTERVAL_MS: '0' })).toBe(0);
    expect(resolveRestartMinIntervalMs({ WE_DAEMON_RESTART_MIN_INTERVAL_MS: '45000' })).toBe(45000);
    expect(resolveRestartMinIntervalMs({ WE_DAEMON_RESTART_MIN_INTERVAL_MS: 'junk' })).toBe(DEFAULT_RESTART_MIN_INTERVAL_MS);
    expect(resolveRestartMinIntervalMs({ WE_DAEMON_RESTART_MIN_INTERVAL_MS: '-5' })).toBe(DEFAULT_RESTART_MIN_INTERVAL_MS);
    expect(resolveRestartMinIntervalMs({ WE_DAEMON_RESTART_MIN_INTERVAL_MS: '' })).toBe(DEFAULT_RESTART_MIN_INTERVAL_MS);
  });
});

describe('collectImportClosure — real tmpdir', () => {
  it('walks relative static + literal dynamic imports, notes packages and .json literals, stays inside root', () => {
    const root = mkdtempSync(join(tmpdir(), 'self-sync-closure-'));
    try {
      mkdirSync(join(root, 'd'), { recursive: true });
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'd', 'daemon.mjs'), "import { a } from '../lib/a.mjs';\nimport matter from 'gray-matter';\nconst cfg = 'cfg.json';\n");
      writeFileSync(join(root, 'lib', 'a.mjs'), "export { b } from './b.mjs';\nexport const a = async () => (await import('./lazy.mjs')).x;\n");
      writeFileSync(join(root, 'lib', 'b.mjs'), "// import('not-code') in a comment is ignored\nexport const b = 1;\n");
      writeFileSync(join(root, 'lib', 'lazy.mjs'), 'export const x = 1;\n');
      writeFileSync(join(root, 'lib', 'unrelated.mjs'), 'export const y = 1;\n');
      const c = collectImportClosure({ root, entries: [join(root, 'd', 'daemon.mjs')] });
      expect([...c.files].sort()).toEqual(['d/daemon.mjs', 'lib/a.mjs', 'lib/b.mjs', 'lib/lazy.mjs']);
      expect(c.complete).toBe(true);
      expect(c.bareDeps).toBe(true);
      expect(c.jsonNames.has('cfg.json')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('a non-literal dynamic import in code marks the closure incomplete', () => {
    const root = mkdtempSync(join(tmpdir(), 'self-sync-closure-'));
    try {
      writeFileSync(join(root, 'e.mjs'), 'const m = await import(process.env.X);\n');
      expect(collectImportClosure({ root, entries: [join(root, 'e.mjs')] }).complete).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('an entry outside root (or missing) yields null — the caller falls back conservatively', () => {
    expect(collectImportClosure({ root: '/nonexistent-root-xyz', entries: ['/elsewhere/entry.mjs'] })).toBeNull();
  });
  it('the real review/fix/pass daemons each have a complete closure that excludes backlog and tests', () => {
    const root = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
    for (const entry of ['skills-src/conveyor/review-daemon.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs', 'skills-src/conveyor/pass-daemon.mjs']) {
      const c = collectImportClosure({ root, entries: [entry] });
      expect(c.files.has(entry)).toBe(true);
      expect(c.files.has('scripts/lib/daemon-self-sync.mjs')).toBe(true);
      expect(c.complete).toBe(true);
      expect([...c.files].some((f) => f.startsWith('backlog/') || f.includes('__tests__/'))).toBe(false);
    }
  });
});

describe('changedFilesBetween — injected git', () => {
  it('lists the diff, or null on failure / missing sha', () => {
    const run = vi.fn(() => ({ status: 0, stdout: 'a.md\nscripts/x.mjs\n' }));
    expect(changedFilesBetween({ root: '/x', from: 'a', to: 'b', run })).toEqual(['a.md', 'scripts/x.mjs']);
    expect(run).toHaveBeenCalledWith(['diff', '--name-only', '--no-renames', 'a', 'b'], expect.objectContaining({ cwd: '/x', killSignal: 'SIGKILL' }));
    expect(changedFilesBetween({ root: '/x', from: 'a', to: 'b', run: () => ({ status: 128, stdout: '' }) })).toBeNull();
    expect(changedFilesBetween({ root: '/x', from: null, to: 'b', run })).toBeNull();
  });
});

describe('withSelfSync — restart gate wiring (#4044 live bug 2)', () => {
  const emptyState = () => ({ adopted: null, rejected: null, inProgress: null, quarantine: null });
  const okLock = () => ({ ok: true });
  const closure = { files: new Set(['skills-src/conveyor/review-daemon.mjs']), complete: true, bareDeps: false, jsonNames: new Set() };

  it('an ADOPTED rebuild that only moved backlog/*.md does NOT restart — the tick runs on (the churn fix)', async () => {
    const onRestart = vi.fn();
    const log = { error: vi.fn() };
    const readHead = vi.fn().mockReturnValueOnce('sha-boot').mockReturnValue('sha-new');
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart, log, readHead, acquireRead: okLock, releaseRead: vi.fn(), readState: emptyState,
      rebuild: async () => ({ moved: true, adopted: true, head: 'sha-new' }),
      importClosure: () => closure, diffFiles: () => ['backlog/4143.md'], minRestartIntervalMs: 0,
    });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    await expect(w.tickOnce()).resolves.toBe('ticked'); // later ticks too — HEAD != boot is not itself a reason
    expect(onRestart).not.toHaveBeenCalled();
    const gateLogs = log.error.mock.calls.filter(([m]) => /no restart needed/.test(m));
    expect(gateLogs).toHaveLength(1); // logged once per head, not every tick
  });

  it('an imported file changed → restarts (as before)', async () => {
    const onRestart = vi.fn(() => 'restarted');
    const w = withSelfSync({ tickOnce: vi.fn() }, {
      root: '/x', onRestart, log: { error: vi.fn() }, readHead: () => 'sha-boot', acquireRead: okLock, releaseRead: vi.fn(), readState: emptyState,
      rebuild: async () => ({ moved: true, adopted: true, head: 'sha-new' }),
      importClosure: () => closure, diffFiles: () => ['skills-src/conveyor/review-daemon.mjs'], minRestartIntervalMs: 0,
    });
    await expect(w.tickOnce()).resolves.toBe('restarted');
  });

  it('an imported change inside the window is deferred, then taken once the window has elapsed (never dropped)', async () => {
    let t = 1_000_000;
    const onRestart = vi.fn(() => 'restarted');
    const tick = vi.fn(() => 'ticked');
    const readHead = vi.fn().mockReturnValueOnce('sha-boot').mockReturnValue('sha-new');
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x', onRestart, log: { error: vi.fn() }, readHead, acquireRead: okLock, releaseRead: vi.fn(), readState: emptyState,
      rebuild: async () => ({ moved: false, reason: 'up-to-date' }), // a SIBLING's rebuild moved HEAD
      importClosure: () => closure, diffFiles: () => ['skills-src/conveyor/review-daemon.mjs'],
      minRestartIntervalMs: 600_000, now: () => t,
    });
    t += 120_000;
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(onRestart).not.toHaveBeenCalled();
    t += 600_000;
    await expect(w.tickOnce()).resolves.toBe('restarted');
    expect(onRestart).toHaveBeenCalledWith(expect.objectContaining({ reason: 'head-moved', headSha: 'sha-new' }));
  });
});

// #4044 live (2026-09-25 ~13:20Z): every skipped tick crashed review-daemon's onTick on `result.repos.map`.
describe('a skipped tick is an empty tick every real daemon onTick can log (#4044)', () => {
  it('review-daemon and reconcile-fix-dispatch-daemon onTick accept skippedTick() without throwing', async () => {
    const { skippedTick } = await import('../daemon-self-sync.mjs');
    const { buildCliDaemonEffects: reviewEffects } = await import('../../../skills-src/conveyor/review-daemon.mjs');
    const { buildCliDaemonEffects: fixEffects } = await import('../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
    for (const build of [reviewEffects, fixEffects]) {
      const log = { error: vi.fn() };
      const effects = build({ owner: 'test-owner', log });
      expect(() => effects.onTick(skippedTick('writer-active'), 0)).not.toThrow();
      expect(() => effects.onTick(skippedTick('quarantine'), 0)).not.toThrow();
    }
    // Two cold dynamic imports of whole daemon module graphs: ~1.6 s on an idle Mac, past vitest's 5 s default
    // under a loaded host (reproduced on origin/main at load average ~230, 2026-09-26). The assertion is about
    // onTick's behaviour, not import speed, so it gets an explicit budget rather than failing the gate on load.
  }, 60_000);
});

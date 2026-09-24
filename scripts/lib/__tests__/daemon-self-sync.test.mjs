/**
 * @file scripts/lib/__tests__/daemon-self-sync.test.mjs
 * @description xv6fciw — the daemon clone self-sync. Pure decision + injected-git cases, plus one suite against
 *   REAL temporary git repos so the actual fetch/merge/abort commands are proven, not only mocked.
 *
 * x3ecgta adds the per-clone reader/writer lock suites below: pure gate-decision cases, then a REAL-lock suite
 * (genuine `mkdir`/heartbeat/reclaim IO against a per-test temp `lockRootBase` — NEVER the real `~/.claude`
 * lock dirs) that proves the two invariants the ruling requires — "the tree never moves under a running tick"
 * and "two daemons never git-merge the same tree at once" — plus dead-holder (same-host PID) and TTL reclaim.
 * The pre-existing `selfSyncCheckout`/`withSelfSync` suites above/below are updated only where they now reach
 * the lock (the merge path, and every non-restart `withSelfSync` tick): they inject trivial always-ok fakes for
 * `acquireMoveLock`/`releaseMoveLock`/`acquireTickLock`/`releaseTickLock` (or a temp `lockRootBase` for the real
 * temp-repo suite) so they stay decoupled from — and never touch the fs for — this new lock, which is not what
 * they are testing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  decideSelfSync, selfSyncCheckout, withSelfSync, readHeadSha, readOriginRefSha,
  decideTickLockGate, decideMoveLockGate,
  acquireCloneTickLock, releaseCloneTickLock, acquireCloneMoveLock, releaseCloneMoveLock,
  DAEMON_SELF_SYNC_BRANCH_ENV, resolvePocSyncBranch, decidePocSelfSync, selfSyncCheckoutPoc,
  isSafeBranchName,
} from '../daemon-self-sync.mjs';
import { assertMainNotStale, isStaleMainRefusalMessage } from '../main-staleness.mjs';
import { SMOKE_KILL_SWITCH_ENV } from '../daemon-live-smoke.mjs';

/** Trivial always-ok lock fakes for suites that exercise `selfSyncCheckout`/`withSelfSync` behavior UNRELATED
 *  to the new per-clone lock (they never touch the fs for it). */
const NOOP_MOVE_LOCK = { acquireMoveLock: () => ({ ok: true, reason: 'writer' }), releaseMoveLock: () => true };
const NOOP_TICK_LOCK = { acquireTickLock: () => ({ ok: true, reason: 'reader' }), releaseTickLock: () => true };

/** For the REAL-git `withSelfSync` suites: routes BOTH halves of the real per-clone lock (the reader lease
 *  `withSelfSync` takes, and the writer lease its real default `selfSyncCheckout` takes) to one temp
 *  `lockRootBase`, so they still genuinely contend but never touch the real `~/.claude` lock dirs. */
const realLockOpts = (lockRootBase) => ({
  lock: { lockRootBase },
  sync: (o) => selfSyncCheckout({ ...o, lock: { lockRootBase } }),
});

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
    expect(selfSyncCheckout({ root: '/x', run, ...NOOP_MOVE_LOCK })).toEqual({ merged: true, commits: 2, reason: 'merged' });
    expect(calls.some((c) => c.startsWith('merge origin/main'))).toBe(true);
  });

  it('a merge conflict is ABORTED — the tree is left as it was', () => {
    const { run, calls } = runner({ merge: (args) => (args[1] === '--abort' ? { status: 0, stdout: '' } : { status: 1, stdout: '', stderr: 'CONFLICT' }) });
    expect(selfSyncCheckout({ root: '/x', run, ...NOOP_MOVE_LOCK })).toEqual({ merged: false, commits: 0, reason: 'conflict' });
    expect(calls).toContain('merge --abort');
  });

  it('a writer-lock refusal is its own reason, NEVER treated as a merge conflict', () => {
    const { run, calls } = runner();
    const acquireMoveLock = () => ({ ok: false, reason: 'tick-in-progress', heldBy: ['host:123'] });
    expect(selfSyncCheckout({ root: '/x', run, acquireMoveLock, releaseMoveLock: () => true }))
      .toEqual({ merged: false, commits: 0, reason: 'tick-in-progress' });
    expect(calls.some((c) => c.startsWith('merge'))).toBe(false);
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
    selfSyncCheckout({ root: '/x', run, ...NOOP_MOVE_LOCK });
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(o).toMatchObject({ cwd: '/x', timeout: 60_000, killSignal: 'SIGKILL' });
  });

  it('the timeout is overridable via timeoutMs, and reaches every call including merge --abort', () => {
    const { run, opts } = runner({ merge: (args) => (args[1] === '--abort' ? { status: 0, stdout: '' } : { status: 1, stdout: '', stderr: 'CONFLICT' }) });
    selfSyncCheckout({ root: '/x', run, timeoutMs: 5_000, ...NOOP_MOVE_LOCK });
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
    expect(selfSyncCheckout({ root: '/x', run, ...NOOP_MOVE_LOCK })).toEqual({ merged: false, commits: 0, reason: 'conflict' });
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
        expect(selfSyncCheckout({ root: '/x', run, ...NOOP_MOVE_LOCK })).toEqual({ merged: false, commits: 0, reason });
      });
    }
  }
});

describe('withSelfSync — restart INSTEAD of ticking when new code arrived', () => {
  // The live-smoke gate (#3383) sits between a merge and `onRestart` — these tests are about the
  // restart-vs-tick DECISION, not the gate itself (that's `withSelfSync — live smoke gate (#3383)` below), so
  // they inject a passing `gate` + a fake `readOriginRef` (no real git call against a mocked root that isn't a
  // real repo) to keep exercising exactly what they always did.
  const passingGate = vi.fn(async () => ({ adopt: true, reason: 'test-gate-pass' }));
  const fakeReadOriginRef = () => 'origin-sha';

  it('merged → onRestart runs, the tick does not', async () => {
    const tick = vi.fn(); const onRestart = vi.fn(() => 'restarted');
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x', onRestart, sync: () => ({ merged: true, commits: 4, reason: 'merged' }), log: { error: vi.fn() },
      gate: passingGate, readOriginRef: fakeReadOriginRef,
    });
    await expect(w.tickOnce()).resolves.toBe('restarted');
    expect(tick).not.toHaveBeenCalled();
  });

  it('up to date → the tick runs and its result passes through', async () => {
    const w = withSelfSync({ tickOnce: () => 'ticked' }, { root: '/x', onRestart: vi.fn(), sync: () => ({ merged: false, commits: 0, reason: 'up-to-date' }), ...NOOP_TICK_LOCK });
    await expect(w.tickOnce()).resolves.toBe('ticked');
  });

  it('a conflict still ticks (never worse than today) and says it needs a hand merge', async () => {
    const log = { error: vi.fn() };
    const w = withSelfSync({ tickOnce: () => 'ticked' }, { root: '/x', onRestart: vi.fn(), sync: () => ({ merged: false, commits: 0, reason: 'conflict' }), log, ...NOOP_TICK_LOCK });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('needs a hand merge'));
  });

  it('a status-failed sync still ticks and is logged, not silent', async () => {
    const log = { error: vi.fn() };
    const w = withSelfSync({ tickOnce: () => 'ticked' }, { root: '/x', onRestart: vi.fn(), sync: () => ({ merged: false, commits: 0, reason: 'status-failed' }), log, ...NOOP_TICK_LOCK });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('status-failed'));
  });

  for (const reason of ['fetch-failed', 'count-failed', 'head-failed']) {
    it(`a ${reason} sync still ticks and is logged, not silent`, async () => {
      const log = { error: vi.fn() };
      const w = withSelfSync({ tickOnce: () => 'ticked' }, { root: '/x', onRestart: vi.fn(), sync: () => ({ merged: false, commits: 0, reason }), log, ...NOOP_TICK_LOCK });
      await expect(w.tickOnce()).resolves.toBe('ticked');
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining(reason));
    });
  }

  for (const [reason, phrase] of [['tick-in-progress', 'sibling daemon'], ['concurrent-mover', 'another process']]) {
    it(`a ${reason} sync still ticks and is logged, not silent (the merge-side lock refusal)`, async () => {
      const log = { error: vi.fn() };
      const w = withSelfSync({ tickOnce: () => 'ticked' }, { root: '/x', onRestart: vi.fn(), sync: () => ({ merged: false, commits: 0, reason }), log, ...NOOP_TICK_LOCK });
      await expect(w.tickOnce()).resolves.toBe('ticked');
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining(phrase));
    });
  }

  it('an explicit timeoutMs is forwarded to the injected sync', async () => {
    const sync = vi.fn(() => ({ merged: false, commits: 0, reason: 'up-to-date' }));
    const w = withSelfSync({ tickOnce: () => 'ticked' }, { root: '/x', onRestart: vi.fn(), sync, timeoutMs: 5_000, ...NOOP_TICK_LOCK });
    await w.tickOnce();
    expect(sync).toHaveBeenCalledWith({ root: '/x', timeoutMs: 5_000 });
  });

  it('a writer active RIGHT NOW skips the entire tick (never partially reads a moving tree)', async () => {
    const tick = vi.fn(() => 'ticked');
    const log = { error: vi.fn() };
    const acquireTickLock = () => ({ ok: false, reason: 'writer-active', heldBy: 'host:99' });
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x', onRestart: vi.fn(), sync: () => ({ merged: false, commits: 0, reason: 'up-to-date' }), log,
      acquireTickLock, releaseTickLock: () => true,
    });
    const result = await w.tickOnce();
    expect(tick).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'writer-active' });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('writer-active'));
  });

  it('the reader (tick) lock is released even when the tick body throws', async () => {
    const release = vi.fn(() => true);
    const w = withSelfSync({ tickOnce: () => { throw new Error('boom'); } }, {
      root: '/x', onRestart: vi.fn(), sync: () => ({ merged: false, commits: 0, reason: 'up-to-date' }),
      acquireTickLock: () => ({ ok: true, reason: 'reader' }), releaseTickLock: release,
    });
    await expect(w.tickOnce()).rejects.toThrow('boom');
    expect(release).toHaveBeenCalled();
  });
});

// #3383 — THE LIVE SMOKE GATE. Sits between a merge landing and `onRestart` on the DEFAULT path only (POC mode
// is untouched, same scoping rule bugs 1/2 use — see the file header). `gate`/`readOriginRef` are injectable
// (parallel to `sync`/`readHead`) exactly so these wiring tests never need a real lane-pool/gh/reconcile-pass
// child process; the real behavior of `we:scripts/lib/daemon-live-smoke.mjs#gateMergedCommit` itself is proven
// in that file's own test suite, and the LIVE (real child processes, real lane, real gh) proof is a separate,
// deliberately-run script (see the PR body), not a vitest case.
describe('withSelfSync — live smoke gate (#3383)', () => {
  it('gate adopts → onRestart runs, exactly like before this fix', async () => {
    const onRestart = vi.fn(() => 'restarted');
    const w = withSelfSync({ tickOnce: vi.fn() }, {
      root: '/x', onRestart, sync: () => ({ merged: true, commits: 2, reason: 'merged' }),
      gate: async () => ({ adopt: true, reason: 'smoke-pass' }), readOriginRef: () => 'origin-sha', log: { error: vi.fn() },
    });
    await expect(w.tickOnce()).resolves.toBe('restarted');
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('gate rejects → onRestart is NOT called; the tick runs instead, as if nothing had merged', async () => {
    const tick = vi.fn(() => 'ticked');
    const onRestart = vi.fn();
    const log = { error: vi.fn() };
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x', onRestart, sync: () => ({ merged: true, commits: 2, reason: 'merged' }),
      gate: async () => ({ adopt: false, reason: 'smoke-fail' }), readOriginRef: () => 'origin-sha', log, ...NOOP_TICK_LOCK,
    });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(onRestart).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('LIVE SMOKE GATE rejected'));
  });

  it('the gate is called with the pre-merge HEAD (rollback target) and the merged origin sha (reject-cache identity)', async () => {
    const gate = vi.fn(async () => ({ adopt: true, reason: 'ok' }));
    const readHead = vi.fn(() => 'pre-sha');
    const readOriginRef = vi.fn(() => 'origin-sha-123');
    const w = withSelfSync({ tickOnce: vi.fn() }, {
      root: '/the/clone', onRestart: vi.fn(), sync: () => ({ merged: true, commits: 1, reason: 'merged' }),
      gate, readHead, readOriginRef, log: { error: vi.fn() },
    });
    await w.tickOnce();
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ root: '/the/clone', preMergeSha: 'pre-sha', mergedIdentitySha: 'origin-sha-123' }));
    expect(readOriginRef).toHaveBeenCalledWith(expect.objectContaining({ root: '/the/clone', ref: 'origin/main' }));
  });

  it('a not-merged tick never calls the gate at all', async () => {
    const gate = vi.fn();
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart: vi.fn(), sync: () => ({ merged: false, commits: 0, reason: 'up-to-date' }), gate, ...NOOP_TICK_LOCK,
    });
    await w.tickOnce();
    expect(gate).not.toHaveBeenCalled();
  });

  it('the REAL default gate (kill switch on) wires straight to daemon-live-smoke.mjs, no injection needed', async () => {
    // The kill switch short-circuits BEFORE any child process ever runs (see gateMergedCommit), so this proves
    // the default `gate`/`readOriginRef` params really are the real module's exports, with zero flakiness risk
    // (the one real subprocess this exercises, readOriginRefSha's own `git rev-parse`, fails fast and harmlessly
    // against the non-existent '/x' — exactly like readHeadSha already does elsewhere in this file).
    const onRestart = vi.fn(() => 'restarted');
    const w = withSelfSync({ tickOnce: vi.fn() }, {
      root: '/x', onRestart, sync: () => ({ merged: true, commits: 1, reason: 'merged' }),
      env: { [SMOKE_KILL_SWITCH_ENV]: '1' }, log: { error: vi.fn() },
    });
    await expect(w.tickOnce()).resolves.toBe('restarted');
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

// #3383 bug 1 — a tick that ITSELF hit the stale-main refusal (origin/main moved AFTER this tick-start sync,
// mid-tick, across a multi-repo loop) wasted the affected repo(s) this pass. Re-sync IMMEDIATELY when that
// happens, rather than let the daemon sleep the full interval and lose the SAME race again next tick.
describe('withSelfSync — mid-tick stale refusal reacts immediately (#3383 bug 1)', () => {
  it('a tick result flagged by hasStaleRefusal triggers an immediate re-sync + restart when it finds new commits', async () => {
    const onRestart = vi.fn(() => 'restarted');
    const tickResult = { refusals: [{ repo: 'chalbert/frontierui', kind: 'tick-failed', why: 'review-dispatch: ... STALE code from this checkout ... (#3439)' }] };
    const sync = vi.fn()
      .mockReturnValueOnce({ merged: false, commits: 0, reason: 'up-to-date' }) // tick-start sync: nothing to do yet
      .mockReturnValueOnce({ merged: true, commits: 1, reason: 'merged' }); // the immediate re-sync after the tick
    const w = withSelfSync({ tickOnce: () => tickResult }, {
      root: '/x', onRestart, sync, log: { error: vi.fn() }, ...NOOP_TICK_LOCK,
      hasStaleRefusal: (r) => (r.refusals ?? []).some((x) => /STALE code from this checkout/.test(x.why)),
    });
    await expect(w.tickOnce()).resolves.toBe('restarted');
    expect(sync).toHaveBeenCalledTimes(2);
    expect(onRestart).toHaveBeenCalledWith({ merged: true, commits: 1, reason: 'merged' });
  });

  it('a flagged tick result whose immediate re-sync finds nothing new (a false-positive/self-resolved case) still returns the tick result, never worse than before', async () => {
    const tickResult = { refusals: [{ repo: 'x', kind: 'tick-failed', why: 'STALE code from this checkout' }] };
    const sync = vi.fn(() => ({ merged: false, commits: 0, reason: 'up-to-date' }));
    const w = withSelfSync({ tickOnce: () => tickResult }, {
      root: '/x', onRestart: vi.fn(), sync, ...NOOP_TICK_LOCK,
      hasStaleRefusal: (r) => (r.refusals ?? []).length > 0,
    });
    await expect(w.tickOnce()).resolves.toBe(tickResult);
  });

  it('an UNFLAGGED tick result never triggers a second sync call at all (no hasStaleRefusal wired → byte-identical to today)', async () => {
    const sync = vi.fn(() => ({ merged: false, commits: 0, reason: 'up-to-date' }));
    const w = withSelfSync({ tickOnce: () => ({ ok: true }) }, { root: '/x', onRestart: vi.fn(), sync, ...NOOP_TICK_LOCK });
    await w.tickOnce();
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

// #3383 bug 2 — two daemons (review-daemon and reconcile-fix-dispatch-daemon) run from ONE shared dedicated
// clone. Whichever self-syncs FIRST merges and restarts (the existing `r.merged` branch above); the other used
// to see `up-to-date` (someone else already brought the checkout current) and tick on forever against its own
// now-stale in-memory code. Recording the HEAD sha at boot and restarting on ANY drift — not only a merge THIS
// process performed — closes that gap for whichever process didn't do the merging.
describe('withSelfSync — restarts on ANY HEAD drift since boot, not only its own merge (#3383 bug 2)', () => {
  it('HEAD moved (a sibling process merged first) → restarts even though THIS process\'s own sync found nothing to merge', async () => {
    const onRestart = vi.fn(() => 'restarted');
    const tick = vi.fn();
    // Call order: boot read (outside tickOnce) → this tick's preMergeSha read (the live-smoke gate's rollback
    // target, read before every `sync()` call, whether or not it ends up merging) → the bug-2 headNow read.
    const readHead = vi.fn().mockReturnValueOnce('sha-boot').mockReturnValueOnce('sha-boot').mockReturnValueOnce('sha-after-sibling-merge');
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x', onRestart, sync: () => ({ merged: false, commits: 0, reason: 'up-to-date' }),
      readHead, log: { error: vi.fn() },
    });
    await expect(w.tickOnce()).resolves.toBe('restarted');
    expect(tick).not.toHaveBeenCalled();
    expect(onRestart).toHaveBeenCalledWith(expect.objectContaining({ merged: false, reason: 'head-moved' }));
  });

  it('HEAD unchanged since boot → ticks normally', async () => {
    const readHead = vi.fn().mockReturnValue('sha-boot'); // same value every read
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart: vi.fn(), sync: () => ({ merged: false, commits: 0, reason: 'up-to-date' }), readHead, ...NOOP_TICK_LOCK,
    });
    await expect(w.tickOnce()).resolves.toBe('ticked');
  });

  it('an unreadable HEAD (readHead returns null) never falsely restarts — skips the drift check, fails safe', async () => {
    const onRestart = vi.fn();
    const readHead = vi.fn(() => null);
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart, sync: () => ({ merged: false, commits: 0, reason: 'up-to-date' }), readHead, ...NOOP_TICK_LOCK,
    });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('this process\'s OWN merge still restarts via the existing merged branch (unchanged)', async () => {
    const onRestart = vi.fn(() => 'restarted');
    const readHead = vi.fn(() => 'irrelevant'); // merged branch returns before HEAD drift is ever checked
    const w = withSelfSync({ tickOnce: vi.fn() }, {
      root: '/x', onRestart, sync: () => ({ merged: true, commits: 3, reason: 'merged' }), readHead,
      gate: async () => ({ adopt: true, reason: 'test-gate-pass' }), readOriginRef: () => 'origin-sha',
    });
    await expect(w.tickOnce()).resolves.toBe('restarted');
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
    const r = selfSyncCheckout({ root: d, lock: { lockRootBase: join(dir, '.locks') }, run: (args, opts) => {
      try { return { status: 0, stdout: execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
      catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
    } });
    expect(r).toEqual({ merged: true, commits: 1, reason: 'merged' });
    expect(git(d, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('0');
    expect(git(d, 'ls-files').split('\n')).toEqual(expect.arrayContaining(['b.txt', 'local.txt']));
    // the real move-lock is taken and released around the real merge — nothing left held afterward.
    expect(acquireCloneMoveLock(d, 'proof', { lockRootBase: join(dir, '.locks') })).toMatchObject({ ok: true });
  });

  it('a conflicting upstream change → merge aborted, tree and HEAD unchanged', () => {
    const up = join(dir, 'upstream'); const d = join(dir, 'daemon');
    commit(d, 'a.txt', 'daemon side\n');
    commit(up, 'a.txt', 'upstream side\n'); git(up, 'push', '-q', 'origin', 'main');
    const headBefore = git(d, 'rev-parse', 'HEAD').trim();
    const r = selfSyncCheckout({ root: d, lock: { lockRootBase: join(dir, '.locks') }, run: (args, opts) => {
      try { return { status: 0, stdout: execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
      catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
    } });
    expect(r.reason).toBe('conflict');
    expect(git(d, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(git(d, 'status', '--porcelain').trim()).toBe('');
  });
});

// ── x3ecgta: the per-clone reader/writer lock — pure gate decisions ────────────────────────────────────────
describe('decideTickLockGate / decideMoveLockGate — pure', () => {
  const nowMs = 1_000_000;

  it('no writer at all → a tick may start', () => {
    expect(decideTickLockGate({ writerEntry: null, nowMs })).toEqual({ ok: true, reason: 'clear' });
  });

  it('a LIVE writer blocks a new tick', () => {
    const writerEntry = { owner: 'host:1', heartbeatAt: new Date(nowMs).toISOString() };
    expect(decideTickLockGate({ writerEntry, nowMs, writerPidLiveness: 'alive' }))
      .toEqual({ ok: false, reason: 'writer-active', heldBy: 'host:1' });
  });

  it('a writer whose lease EXPIRED never blocks a tick', () => {
    const writerEntry = { owner: 'host:1', heartbeatAt: new Date(nowMs - 20 * 60_000).toISOString() }; // 20 min old
    expect(decideTickLockGate({ writerEntry, nowMs, leaseMinutes: 15 })).toEqual({ ok: true, reason: 'clear' });
  });

  it('a writer whose PID is PROVABLY DEAD never blocks a tick, even within the TTL', () => {
    const writerEntry = { owner: 'host:1', heartbeatAt: new Date(nowMs).toISOString() };
    expect(decideTickLockGate({ writerEntry, nowMs, writerPidLiveness: 'dead' })).toEqual({ ok: true, reason: 'clear' });
  });

  it('no readers at all → a mover may start', () => {
    expect(decideMoveLockGate({ readerEntries: [], nowMs })).toEqual({ ok: true, reason: 'clear' });
  });

  it('ANY live reader blocks the mover — the tree never moves under a running tick', () => {
    const readerEntries = [{ owner: 'host:2', heartbeatAt: new Date(nowMs).toISOString() }];
    expect(decideMoveLockGate({ readerEntries, nowMs, readerPidLivenessOf: () => 'alive' }))
      .toEqual({ ok: false, reason: 'tick-in-progress', heldBy: ['host:2'] });
  });

  it('a dead/expired reader never blocks the mover, but a live sibling among several still does', () => {
    const dead = { owner: 'host:dead', heartbeatAt: new Date(nowMs).toISOString() };
    const expired = { owner: 'host:expired', heartbeatAt: new Date(nowMs - 20 * 60_000).toISOString() };
    const live = { owner: 'host:live', heartbeatAt: new Date(nowMs).toISOString() };
    const readerPidLivenessOf = (e) => (e.owner === 'host:dead' ? 'dead' : 'alive');
    expect(decideMoveLockGate({ readerEntries: [dead, expired, live], nowMs, leaseMinutes: 15, readerPidLivenessOf }))
      .toEqual({ ok: false, reason: 'tick-in-progress', heldBy: ['host:live'] });
  });
});

// ── x3ecgta: the per-clone reader/writer lock — REAL fs IO, two simulated daemons on ONE clone ────────────────
// Genuine `mkdir`/heartbeat/reclaim IO against a per-test temp `lockRootBase` (never the real ~/.claude lock
// dirs). This is the "run 2 simulated daemons on one clone" proof: daemon A is the mover, daemon B is a tick.
describe('acquireCloneTickLock / acquireCloneMoveLock — real lock IO, two simulated daemons on one clone', () => {
  let lockRootBase;
  const ROOT = '/simulated/shared/clone'; // never actually read as a directory — only its resolved string is hashed
  beforeEach(() => { lockRootBase = mkdtempSync(join(tmpdir(), 'self-sync-lock-')); });
  afterEach(() => rmSync(lockRootBase, { recursive: true, force: true }));

  it('THE RACE THIS CARD FIXES: while daemon B is mid-tick, daemon A (the mover) is refused — never a race', () => {
    const tickB = acquireCloneTickLock(ROOT, 'daemonB', { lockRootBase });
    expect(tickB.ok).toBe(true); // B is mid-tick, holding the shared reader lease

    const moveA = acquireCloneMoveLock(ROOT, 'daemonA', { lockRootBase });
    expect(moveA).toEqual({ ok: false, reason: 'tick-in-progress', heldBy: ['daemonB'] }); // A must NOT move the tree

    expect(releaseCloneTickLock(ROOT, 'daemonB', { lockRootBase })).toBe(true); // B's tick ends
    const moveA2 = acquireCloneMoveLock(ROOT, 'daemonA', { lockRootBase });
    expect(moveA2).toEqual({ ok: true, reason: 'writer' }); // now A may move it
    expect(releaseCloneMoveLock(ROOT, 'daemonA', { lockRootBase })).toBe(true);
  });

  it('the reverse: while daemon A is mid-move, daemon B is refused a NEW tick — the tree never moves under a running tick', () => {
    const moveA = acquireCloneMoveLock(ROOT, 'daemonA', { lockRootBase });
    expect(moveA).toEqual({ ok: true, reason: 'writer' });

    const tickB = acquireCloneTickLock(ROOT, 'daemonB', { lockRootBase });
    expect(tickB).toEqual({ ok: false, reason: 'writer-active', heldBy: 'daemonA' });

    expect(releaseCloneMoveLock(ROOT, 'daemonA', { lockRootBase })).toBe(true);
    const tickB2 = acquireCloneTickLock(ROOT, 'daemonB', { lockRootBase });
    expect(tickB2).toEqual({ ok: true, reason: 'reader' });
    expect(releaseCloneTickLock(ROOT, 'daemonB', { lockRootBase })).toBe(true);
  });

  it('two movers never overlap — a second mover is refused while the first still holds the writer lease', () => {
    const moveA = acquireCloneMoveLock(ROOT, 'daemonA', { lockRootBase });
    expect(moveA).toEqual({ ok: true, reason: 'writer' });

    const moveC = acquireCloneMoveLock(ROOT, 'daemonC', { lockRootBase });
    expect(moveC).toEqual({ ok: false, reason: 'concurrent-mover', heldBy: 'daemonA' });
  });

  it('two ticks (readers) coexist freely — the shared hold never blocks a sibling tick', () => {
    expect(acquireCloneTickLock(ROOT, 'daemonB', { lockRootBase })).toEqual({ ok: true, reason: 'reader' });
    expect(acquireCloneTickLock(ROOT, 'daemonC', { lockRootBase })).toEqual({ ok: true, reason: 'reader' });
  });

  it('a DIFFERENT clone (a different root) never contends with this one', () => {
    expect(acquireCloneMoveLock(ROOT, 'daemonA', { lockRootBase })).toEqual({ ok: true, reason: 'writer' });
    expect(acquireCloneTickLock('/a/totally/different/clone', 'daemonB', { lockRootBase })).toEqual({ ok: true, reason: 'reader' });
  });

  it('AFTER: a dead reader (a real, provably-gone same-host PID) is reclaimed at once — never waits out the TTL', () => {
    // A real short-lived child process, waited out, so its pid is PROVABLY gone (never a mocked liveness verdict).
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid;
    expect(deadPid).toBeGreaterThan(0);
    // The STORED owner must be a real SAME-HOST identity (`host:pid`, exactly what `defaultLockOwner()` mints
    // for a real daemon) — the fast path only probes an owner recorded on THIS host (see the file header).
    const crashedOwner = `${hostname()}:${deadPid}`;

    // Seed a reader entry as if daemonB's tick had SIGKILLed mid-tick without releasing — heartbeat fresh, well
    // within the 15-minute TTL, so ONLY the pid-dead fast path can reclaim this, never the lease clock.
    const before = acquireCloneTickLock(ROOT, crashedOwner, { lockRootBase, pid: deadPid, nowMs: Date.now() });
    expect(before.ok).toBe(true);

    // dead reader IS reclaimed at once: the mover's PID-liveness probe (default `defaultProbePidLiveness`) sees
    // ESRCH for `deadPid` on this host and drops it from the "live readers" scan, well within the TTL.
    const mover = acquireCloneMoveLock(ROOT, 'daemonA', { lockRootBase, nowMs: Date.now() });
    expect(mover).toEqual({ ok: true, reason: 'writer' });
    expect(releaseCloneMoveLock(ROOT, 'daemonA', { lockRootBase })).toBe(true);
  });

  it('AFTER (TTL fallback): a stale reader past the lease, with an UNKNOWN-liveness pid, is still reclaimed', () => {
    const past = Date.now() - 20 * 60_000; // 20 minutes ago, past the 15-minute default lease
    // owner string is a different host — the fast path never even looks at the pid (see the file header).
    const before = acquireCloneTickLock(ROOT, 'other-host:4242', { lockRootBase, nowMs: past });
    expect(before.ok).toBe(true);
    const mover = acquireCloneMoveLock(ROOT, 'daemonA', { lockRootBase, nowMs: Date.now() });
    expect(mover).toEqual({ ok: true, reason: 'writer' }); // reclaimed via the TTL floor, not the pid fast path
    expect(releaseCloneMoveLock(ROOT, 'daemonA', { lockRootBase })).toBe(true);
  });

  it('a dead mover (writer) never blocks a fresh tick — pid-dead fast reclaim on the writer side too', () => {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid;
    const crashedOwner = `${hostname()}:${deadPid}`;
    const moveA = acquireCloneMoveLock(ROOT, crashedOwner, { lockRootBase, pid: deadPid, nowMs: Date.now() });
    expect(moveA.ok).toBe(true); // A "crashed" mid-move without releasing

    const tickB = acquireCloneTickLock(ROOT, 'daemonB', { lockRootBase, nowMs: Date.now() });
    expect(tickB).toEqual({ ok: true, reason: 'reader' }); // reclaimed at once, never stuck for the TTL
    expect(releaseCloneTickLock(ROOT, 'daemonB', { lockRootBase })).toBe(true);
  });

  it('re-acquiring your OWN tick lease is a heartbeat refresh, not a refusal', () => {
    expect(acquireCloneTickLock(ROOT, 'daemonB', { lockRootBase })).toEqual({ ok: true, reason: 'reader' });
    expect(acquireCloneTickLock(ROOT, 'daemonB', { lockRootBase })).toEqual({ ok: true, reason: 'reader' });
  });
});

// #3383 bug 1 — REALISTIC end-to-end simulation of the live 2026-09-23 incident: a bare "origin", a dedicated
// daemon clone that has ALREADY self-synced once before (so it carries a local-only merge commit and is
// DIVERGED from origin — exactly the real daemon clone's shape per the live log), then a genuine multi-repo
// tick during which origin/main is pushed to MID-TICK (a drain landing something while the tick is still
// running its later repos) — proving the fix syncs and restarts instead of refusing. No mocked git anywhere in
// this block: `withSelfSync`'s real default `sync` (`selfSyncCheckout`, which itself defaults to the real
// `gitRun`) runs against real temp repos, and `assertMainNotStale`'s own real default `checkStaleness` does too.
describe('withSelfSync — REAL git, bug 1 mid-tick race end-to-end (#3383)', () => {
  let dir;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, file, text) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', file); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `edit ${file}`); };

  // Repo-LOCAL identity (not the host's global ~/.gitconfig, which CI runners don't carry) — the SUT's own
  // `selfSyncCheckout` merge call (`withSelfSync`'s default, un-injected `sync`) runs plain `git merge`
  // with no identity flags of its own, exactly as it does in real production use; local config is what makes
  // that succeed on any host, not a machine-specific global default this test would otherwise depend on.
  const setLocalIdentity = (cwd) => { git(cwd, 'config', 'user.name', 't'); git(cwd, 'config', 'user.email', 't@t'); };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'self-sync-bug1-'));
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(dir, 'clone', '-q', 'origin.git', 'upstream');
    setLocalIdentity(join(dir, 'upstream'));
    commit(join(dir, 'upstream'), 'a.txt', 'one\n');
    git(join(dir, 'upstream'), 'push', '-q', 'origin', 'main');
    git(dir, 'clone', '-q', '-b', 'main', 'origin.git', 'daemon');
    setLocalIdentity(join(dir, 'daemon'));
    // Give the daemon clone a LOCAL-ONLY commit, exactly like the real dedicated clone accumulates over time
    // (its own prior self-sync merges and other locally-committing passes never get pushed anywhere) — the
    // clone is now permanently DIVERGED (ahead of origin), which is exactly why the live daemon's every
    // subsequent staleness read as "diverged", never a plain fast-forwardable "behind" (see
    // we:scripts/lib/main-staleness.mjs's own classifyStaleness: a diverged tree can never auto-ff, it can
    // only warn/refuse — matching the live log's "DIVERGED (N local commit(s) ahead of origin/main)").
    commit(join(dir, 'daemon'), 'local-only.txt', 'a local commit never pushed anywhere\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('BEFORE the fix (no hasStaleRefusal wired): the mid-tick refusal is just absorbed and lost for the tick', async () => {
    const daemon = join(dir, 'daemon'); const up = join(dir, 'upstream');
    const onRestart = vi.fn(() => 'restarted');
    let mainRefusalMessage = null;
    const tick = () => {
      // repo 1 of 3: nothing owed, fine.
      // repo 2 of 3: origin/main is pushed to MID-TICK (a drain landing something while THIS tick still runs) —
      // the exact race from the live incident. The dispatch chokepoint (assertMainNotStale) is real, not mocked.
      commit(up, 'mid-tick.txt', 'landed while the tick was running\n');
      git(up, 'push', '-q', 'origin', 'main');
      try {
        assertMainNotStale(daemon);
        throw new Error('test setup bug: expected assertMainNotStale to refuse (checkout should be diverged+behind)');
      } catch (e) {
        mainRefusalMessage = e.message;
      }
      // repo 3 of 3 would refuse identically — matches the live log's "all 3 repos refused this way".
      return { refusals: [{ repo: 'chalbert/frontierui', kind: 'tick-failed', why: mainRefusalMessage }] };
    };
    const w = withSelfSync({ tickOnce: tick }, { root: daemon, onRestart, log: { error: vi.fn() }, ...realLockOpts(join(dir, '.locks')) }); // no hasStaleRefusal — today's behavior
    const result = await w.tickOnce();
    expect(mainRefusalMessage).toMatch(/STALE code from this checkout/);
    expect(result.refusals).toHaveLength(1); // the tick's refusal is returned as-is — nothing reacted to it
    expect(onRestart).not.toHaveBeenCalled(); // BUG: still diverged+behind; next tick will lose the same race
    expect(git(daemon, 'rev-list', '--count', `HEAD..origin/main`).trim()).not.toBe('0'); // still behind
  });

  it('AFTER the fix (hasStaleRefusal wired): the SAME mid-tick refusal triggers an immediate sync + restart', async () => {
    const daemon = join(dir, 'daemon'); const up = join(dir, 'upstream');
    const onRestart = vi.fn((r) => ({ restarted: true, ...r }));
    let mainRefusalMessage = null;
    const tick = () => {
      commit(up, 'mid-tick.txt', 'landed while the tick was running\n');
      git(up, 'push', '-q', 'origin', 'main');
      try {
        assertMainNotStale(daemon);
        throw new Error('test setup bug: expected assertMainNotStale to refuse (checkout should be diverged+behind)');
      } catch (e) {
        mainRefusalMessage = e.message;
      }
      return { refusals: [{ repo: 'chalbert/frontierui', kind: 'tick-failed', why: mainRefusalMessage }] };
    };
    const w = withSelfSync({ tickOnce: tick }, {
      root: daemon, onRestart, log: { error: vi.fn() }, ...realLockOpts(join(dir, '.locks')),
      hasStaleRefusal: (r) => (r.refusals ?? []).some((x) => isStaleMainRefusalMessage(x.why)),
    });
    const result = await w.tickOnce();
    expect(mainRefusalMessage).toMatch(/STALE code from this checkout/);
    expect(result).toMatchObject({ restarted: true, merged: true }); // onRestart ran instead of the tick result passing through
    expect(onRestart).toHaveBeenCalledTimes(1);
    // The checkout is now caught up — the SAME repo that just refused would NOT refuse again immediately.
    expect(git(daemon, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('0');
    expect(() => assertMainNotStale(daemon)).not.toThrow();
    expect(git(daemon, 'ls-files')).toContain('mid-tick.txt');
  });
});

// #3383 bug 2 — REAL git test with two independent daemon "processes" (their whole self-sync decision logic,
// not mocked) sharing ONE clone directory, matching the live incident exactly (review-daemon and
// reconcile-fix-dispatch-daemon both run from /Users/nicolasgilbert/workspace/wev-review-daemon). Whichever
// self-syncs first merges and restarts (unchanged, pre-existing behavior); THE FIX proves the other one — which
// finds the checkout already "up-to-date" and would previously have ticked on forever against its own stale
// in-memory code — ALSO decides to restart.
describe('withSelfSync — REAL git, two processes sharing one clone (#3383 bug 2)', () => {
  let dir;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, file, text) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', file); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `edit ${file}`); };

  // See the bug-1 describe block above for why this is repo-local, not the host's global git identity.
  const setLocalIdentity = (cwd) => { git(cwd, 'config', 'user.name', 't'); git(cwd, 'config', 'user.email', 't@t'); };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'self-sync-bug2-'));
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(dir, 'clone', '-q', 'origin.git', 'upstream');
    setLocalIdentity(join(dir, 'upstream'));
    commit(join(dir, 'upstream'), 'a.txt', 'one\n');
    git(join(dir, 'upstream'), 'push', '-q', 'origin', 'main');
    // ONE shared clone — both "processes" below point at this exact directory, mirroring the real incident.
    git(dir, 'clone', '-q', '-b', 'main', 'origin.git', 'shared');
    setLocalIdentity(join(dir, 'shared'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('the daemon that did NOT merge still decides to restart, because HEAD moved out from under it', async () => {
    const shared = join(dir, 'shared'); const up = join(dir, 'upstream');
    // Two "processes" boot at the same moment, before either has ticked — each records its own boot HEAD sha
    // (identical, since neither has done anything yet), exactly like two real OS processes starting up.
    const tickReviewDaemon = vi.fn(() => 'review-ticked');
    const tickFixDaemon = vi.fn(() => 'fix-ticked');
    const onRestartReview = vi.fn(() => 'review-restarted');
    const onRestartFix = vi.fn(() => 'fix-restarted');
    // The live-smoke gate (#3383) would otherwise run REAL child processes (lane-pool, gh, reconcile-pass)
    // against this bare temp repo, which has none of that tooling — inject a passing gate + a fake
    // readOriginRef so this test keeps proving the bug-2 restart decision, not the gate itself.
    const passingGate = async () => ({ adopt: true, reason: 'test-gate-pass' });
    const reviewDaemon = withSelfSync({ tickOnce: tickReviewDaemon }, {
      root: shared, onRestart: onRestartReview, log: { error: vi.fn() }, gate: passingGate, readOriginRef: () => 'origin-sha',
      ...realLockOpts(join(dir, '.locks')),
    });
    const fixDaemon = withSelfSync({ tickOnce: tickFixDaemon }, {
      root: shared, onRestart: onRestartFix, log: { error: vi.fn() }, gate: passingGate, readOriginRef: () => 'origin-sha',
      ...realLockOpts(join(dir, '.locks')),
    });

    // main moves (a drain lands a PR) — the ordinary trigger for a self-sync.
    commit(up, 'b.txt', 'two\n');
    git(up, 'push', '-q', 'origin', 'main');

    // The review daemon's tick fires FIRST (real race): it self-syncs, merges for real, restarts.
    await expect(reviewDaemon.tickOnce()).resolves.toBe('review-restarted');
    expect(tickReviewDaemon).not.toHaveBeenCalled();
    expect(onRestartReview).toHaveBeenCalledTimes(1);
    expect(git(shared, 'ls-files')).toContain('b.txt'); // the merge really landed on disk

    // The fix daemon's tick fires next, against the SAME now-current clone. Its OWN self-sync finds
    // `behind: 0` (someone else already brought it current) — the exact "up-to-date" case that used to mean
    // "keep running on stale in-memory code forever". Proven here: it restarts anyway, because HEAD no longer
    // matches the sha it recorded at its own boot.
    await expect(fixDaemon.tickOnce()).resolves.toBe('fix-restarted');
    expect(tickFixDaemon).not.toHaveBeenCalled();
    expect(onRestartFix).toHaveBeenCalledTimes(1);
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

  it('unset env → routes through sync (default), not syncPoc — byte-identical to the pre-POC contract', async () => {
    const syncPoc = vi.fn();
    const sync = vi.fn(() => ({ merged: false, commits: 0, reason: 'up-to-date' }));
    const w = withSelfSync({ tickOnce: () => 'ticked' }, { root: '/x', onRestart: vi.fn(), sync, syncPoc, env: {}, ...NOOP_TICK_LOCK });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(sync).toHaveBeenCalledWith({ root: '/x' });
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

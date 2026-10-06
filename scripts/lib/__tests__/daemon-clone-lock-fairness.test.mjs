/**
 * @file scripts/lib/__tests__/daemon-clone-lock-fairness.test.mjs
 * @description Reader fairness on the per-clone lock (live 2026-10-05 20:18-20:37 ET: the review daemon skipped
 *   11 ticks in a row `writer-active` while sibling rebuilds kept re-reserving the writer; CI-green PRs got no
 *   review). Fake clocks only, mkdtemp lock roots only. Proves: the livelock reproduces with reader priority
 *   off, resolves with it on, and a writer that already holds the clone is never interrupted (the #4044
 *   never-read-a-tree-mid-move guarantee).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireRead, releaseRead, acquireWrite, releaseWrite, inspectCloneLock, resolveReaderPriorityAfter,
  DEFAULT_READER_PRIORITY_AFTER,
} from '../daemon-clone-lock.mjs';
import { withSelfSync, resolvePriorityWaitMs, DEFAULT_READER_PRIORITY_WAIT_MS } from '../daemon-self-sync.mjs';

const tmpDirs = [];
function mkTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const alive = () => 'alive';
const LEASE = 1e9; // minutes — fake clocks start at epoch 0 while some calls use the real clock; nothing may expire by age

/**
 * The live livelock, on a real lock dir with a fake clock. Per round (one review tick interval):
 *   - L, a long sibling tick, holds a read slot throughout (the mover is always waiting on SOMEONE);
 *   - W, a mover, reserves the writer and waits 60s for L to drain, gives up, and re-reserves next round (main
 *     keeps moving, so there is always a rebuild to try);
 *   - R, the review daemon, tries its read once per round, landing while W is draining.
 */
async function simulate({ rounds, readerPriorityAfter }) {
  const lockRoot = mkTmp('dclf-root-');
  const clone = mkTmp('dclf-clone-');
  let t = 0;
  const common = { lockRoot, probe: alive, leaseMinutes: LEASE };
  expect(acquireRead(clone, { ...common, owner: 'L', nowMs: t }).ok).toBe(true);
  const log = [];
  let readerIn = null;
  for (let round = 1; round <= rounds && readerIn === null; round += 1) {
    let rTried = false;
    const rTry = () => {
      rTried = true;
      const r = acquireRead(clone, { ...common, owner: 'R', readerKey: 'reader:review-daemon.mjs', nowMs: t });
      log.push({ round, ok: r.ok, starved: r.starved ?? 0 });
      if (r.ok) readerIn = round;
    };
    const w = await acquireWrite(clone, {
      ...common,
      owner: 'W',
      now: () => t,
      waitMs: 60_000,
      pollMs: 10_000,
      readerPriorityAfter,
      sleep: async (ms) => { t += ms; if (!rTried && t >= round * 120_000 - 90_000) rTry(); },
    });
    expect(w.ok).toBe(false); // L never drains, so W never moves anything in this scenario
    if (!rTried) rTry();
    t = round * 120_000;
  }
  return { log, readerIn, lockRoot, clone, common };
}

describe('reader fairness — the livelock', () => {
  it('REPRODUCES with reader priority off: the reader is refused every single round', async () => {
    const { log, readerIn } = await simulate({ rounds: 12, readerPriorityAfter: 0 });
    expect(readerIn).toBeNull();
    expect(log).toHaveLength(12);
    expect(log.every((r) => !r.ok)).toBe(true);
    expect(log.at(-1).starved).toBe(12); // the smell: K consecutive refusals is visible
  });

  it('RESOLVES with reader priority on: the reader gets in right after its K-th refusal', async () => {
    const { log, readerIn, clone, common } = await simulate({ rounds: 12, readerPriorityAfter: 3 });
    expect(log.map((r) => r.ok)).toEqual([false, false, false, true]);
    expect(readerIn).toBe(4);
    expect(inspectCloneLock(clone, common).starved).toEqual([]); // claim cleared once in
  });
});

describe('reader fairness — the lock protocol', () => {
  const base = () => ({ lockRoot: mkTmp('dclf-root-'), probe: alive, leaseMinutes: LEASE });

  it('a draining writer backs off (reader-priority, writer key released) once a reader is starved', async () => {
    const o = base();
    const clone = mkTmp('dclf-clone-');
    acquireRead(clone, { ...o, owner: 'L', nowMs: 0 });
    let t = 0;
    let polls = 0;
    const w = await acquireWrite(clone, {
      ...o, owner: 'W', now: () => t, waitMs: 600_000, pollMs: 1000, readerPriorityAfter: 2,
      sleep: async (ms) => {
        t += ms; polls += 1;
        if (polls <= 2) acquireRead(clone, { ...o, owner: 'R', nowMs: t });
      },
    });
    expect(w).toMatchObject({ ok: false, reason: 'reader-priority', heldBy: 'R', starved: 2 });
    expect(inspectCloneLock(clone, o).writer).toBeNull();
    expect(acquireRead(clone, { ...o, owner: 'R', nowMs: t }).ok).toBe(true);
  });

  it('a new writer never even reserves while a starved reader is waiting', async () => {
    const o = base();
    const clone = mkTmp('dclf-clone-');
    expect((await acquireWrite(clone, { ...o, owner: 'W1', nowMs: 0 })).ok).toBe(true);
    for (let i = 0; i < 3; i += 1) acquireRead(clone, { ...o, owner: 'R', nowMs: i });
    releaseWrite(clone, { ...o, owner: 'W1' });
    const w2 = await acquireWrite(clone, { ...o, owner: 'W2', readerPriorityAfter: 3 });
    expect(w2).toMatchObject({ ok: false, reason: 'reader-priority', heldBy: 'R', starved: 3 });
    expect(inspectCloneLock(clone, o).writer).toBeNull();
  });

  it('NEVER READ MID-MOVE: a writer that already holds the clone is not interrupted by a starved reader', async () => {
    const o = base();
    const clone = mkTmp('dclf-clone-');
    expect((await acquireWrite(clone, { ...o, owner: 'W', readerPriorityAfter: 1 })).ok).toBe(true);
    for (let i = 1; i <= 5; i += 1) {
      expect(acquireRead(clone, { ...o, owner: 'R', nowMs: i })).toMatchObject({ ok: false, reason: 'writer-active', starved: i });
    }
    expect(inspectCloneLock(clone, o).writer.owner).toBe('W');
    releaseWrite(clone, { ...o, owner: 'W' });
    expect(acquireRead(clone, { ...o, owner: 'R', nowMs: 6 }).ok).toBe(true);
  });

  it('the starved reader\'s own writer attempt is not blocked by its own claim', async () => {
    const o = base();
    const clone = mkTmp('dclf-clone-');
    await acquireWrite(clone, { ...o, owner: 'W', nowMs: 0 });
    for (let i = 0; i < 4; i += 1) acquireRead(clone, { ...o, owner: 'R', nowMs: i });
    releaseWrite(clone, { ...o, owner: 'W' });
    expect((await acquireWrite(clone, { ...o, owner: 'R', readerPriorityAfter: 3 })).ok).toBe(true);
  });

  it('a dead or lapsed claim never holds writers off (removed on sight)', async () => {
    const o = base();
    const clone = mkTmp('dclf-clone-');
    await acquireWrite(clone, { ...o, owner: 'W', nowMs: 0 });
    for (let i = 0; i < 3; i += 1) acquireRead(clone, { ...o, owner: 'R', nowMs: i });
    releaseWrite(clone, { ...o, owner: 'W' });
    const dead = await acquireWrite(clone, { ...o, owner: 'W2', readerPriorityAfter: 3, probe: (e) => (e?.owner === 'R' ? 'dead' : 'alive') });
    expect(dead.ok).toBe(true);
    expect(inspectCloneLock(clone, o).starved).toEqual([]);
  });

  it('a refusal that does not track starvation (same-tick retry) does not inflate the count', async () => {
    const o = base();
    const clone = mkTmp('dclf-clone-');
    await acquireWrite(clone, { ...o, owner: 'W', nowMs: 0 });
    acquireRead(clone, { ...o, owner: 'R', nowMs: 1 });
    const retry = acquireRead(clone, { ...o, owner: 'R', nowMs: 2, trackStarvation: false });
    expect(retry.starved).toBeUndefined();
    expect(inspectCloneLock(clone, o).starved[0].count).toBe(1);
    releaseRead(clone, { ...o, owner: 'R' });
  });

  it('settings: declared env knobs with safe defaults (0 turns priority off)', () => {
    expect(resolveReaderPriorityAfter({})).toBe(DEFAULT_READER_PRIORITY_AFTER);
    expect(resolveReaderPriorityAfter({ WE_DAEMON_CLONE_LOCK_READER_PRIORITY_AFTER: '0' })).toBe(0);
    expect(resolveReaderPriorityAfter({ WE_DAEMON_CLONE_LOCK_READER_PRIORITY_AFTER: 'x' })).toBe(DEFAULT_READER_PRIORITY_AFTER);
    expect(resolvePriorityWaitMs({})).toBe(DEFAULT_READER_PRIORITY_WAIT_MS);
    expect(resolvePriorityWaitMs({ WE_DAEMON_CLONE_LOCK_PRIORITY_WAIT_MS: '5000' })).toBe(5000);
  });
});

describe('withSelfSync — a starved reader waits a bounded moment instead of losing another tick', () => {
  const emptyState = () => ({ adopted: null, rejected: null, inProgress: null, quarantine: null });
  const rebuild = async () => ({ moved: false, reason: 'up-to-date' });

  it('logs the starvation smell, retries without counting, and ticks once the writer backs off', async () => {
    let t = 0;
    const calls = [];
    const acquireRead = vi.fn((root, opts) => {
      calls.push(opts);
      return calls.length < 3 ? { ok: false, reason: 'writer-active', heldBy: 'Mac:1', starved: 3 } : { ok: true };
    });
    const log = { error: vi.fn() };
    const w = withSelfSync({ tickOnce: () => 'ticked' }, {
      root: '/x', onRestart: vi.fn(), rebuild, acquireRead, releaseRead: vi.fn(), readState: emptyState, log,
      readHead: () => 'h', entries: ['/a/review-daemon.mjs'], now: () => t, sleep: async (ms) => { t += ms; },
      readerPriorityAfter: 3, priorityWaitMs: 30_000,
    });
    await expect(w.tickOnce()).resolves.toBe('ticked');
    expect(calls[0]).toMatchObject({ readerKey: 'reader:review-daemon.mjs' });
    expect(calls[0].trackStarvation).toBeUndefined();
    expect(calls.slice(1).every((c) => c.trackStarvation === false)).toBe(true);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('reader starved — read refused 3 consecutive time(s)'));
  });

  it('gives up after the bounded wait (a writer mid-move is never interrupted) and skips', async () => {
    let t = 0;
    const tick = vi.fn();
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x', onRestart: vi.fn(), rebuild, readState: emptyState, log: { error: vi.fn() }, readHead: () => 'h',
      acquireRead: () => ({ ok: false, reason: 'writer-active', heldBy: 'W', starved: 5 }), releaseRead: vi.fn(),
      now: () => t, sleep: async (ms) => { t += ms; }, readerPriorityAfter: 3, priorityWaitMs: 10_000,
    });
    await expect(w.tickOnce()).resolves.toMatchObject({ skipped: true, reason: 'writer-active' });
    expect(tick).not.toHaveBeenCalled();
    expect(t).toBe(10_000);
  });

  it('below the threshold (or priority off) a refusal skips at once, as before', async () => {
    const sleep = vi.fn();
    for (const [starved, after] of [[2, 3], [9, 0]]) {
      const w = withSelfSync({ tickOnce: vi.fn() }, {
        root: '/x', onRestart: vi.fn(), rebuild, readState: emptyState, log: { error: vi.fn() }, readHead: () => 'h',
        acquireRead: () => ({ ok: false, reason: 'writer-active', starved }), releaseRead: vi.fn(),
        sleep, readerPriorityAfter: after,
      });
      await expect(w.tickOnce()).resolves.toMatchObject({ skipped: true });
    }
    expect(sleep).not.toHaveBeenCalled();
  });
});

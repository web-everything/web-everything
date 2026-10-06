/**
 * @file scripts/lib/__tests__/daemon-clone-lock-writer-fairness.test.mjs
 * @description Writer fairness on the per-clone lock (live 2026-10-06 01:50-07:20 ET: the fix-dispatch daemon
 *   ticked back-to-back holding its read slot, the review daemon's rebuild waited 900s, gave up, and found the
 *   sibling mid-tick again on every retry — the shared clone did not move for 5.5 h). Fake clocks only, mkdtemp
 *   lock roots only. Proves: the writer starvation reproduces with writer priority off and resolves with it on;
 *   reader and writer priority never both back off (the older claim wins); the #4039 reader fairness still holds.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireRead, releaseRead, acquireWrite, releaseWrite, inspectCloneLock,
  resolveWriterPriorityAfter, DEFAULT_WRITER_PRIORITY_AFTER, resolveWriterClaimTtlMs, DEFAULT_WRITER_CLAIM_TTL_MS,
} from '../daemon-clone-lock.mjs';
import {
  withSelfSync, cloneStuckSmell, resolveCloneStuckSmellMs, DEFAULT_CLONE_STUCK_SMELL_MS,
} from '../daemon-self-sync.mjs';

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
const LEASE = 1e9; // minutes — nothing expires by age in these fake-clock runs
const TTL = 1e12;

/**
 * The live writer starvation. F (fix-dispatch) runs 1000s ticks back-to-back, starting a new one the moment the
 * last ends; W (review daemon) tries to move the clone once per cycle, waits 900s for F, gives up, ticks itself
 * (its own read, 100s), and retries. Returns the cycle W first got the clone in (null = never).
 */
async function simulateWriter({ cycles, writerPriorityAfter }) {
  const lockRoot = mkTmp('dcwf-root-');
  const clone = mkTmp('dcwf-clone-');
  let t = 0;
  const common = {
    lockRoot, probe: alive, leaseMinutes: LEASE, writerPriorityAfter, writerClaimTtlMs: TTL, readerPriorityAfter: 3,
  };
  let fUntil = null; // F's in-flight tick end
  const fRefusals = [];
  const fStep = () => {
    if (fUntil !== null && t >= fUntil) { releaseRead(clone, { lockRoot, owner: 'F' }); fUntil = null; }
    if (fUntil === null) {
      const r = acquireRead(clone, { ...common, owner: 'F', readerKey: 'reader:fix-dispatch-daemon.mjs', nowMs: t });
      if (r.ok) fUntil = t + 1000;
      else fRefusals.push(r.reason);
    }
  };
  fStep();
  t += 50;
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    fStep();
    const w = await acquireWrite(clone, {
      ...common, owner: 'W', waitMs: 900_000 / 1000, pollMs: 10, now: () => t,
      sleep: async (ms) => { t += ms; fStep(); },
    });
    if (w.ok) {
      releaseWrite(clone, { lockRoot, owner: 'W' });
      return { movedAt: cycle, fRefusals, lockRoot, clone };
    }
    // W ticks on its own read for 100s (phase-locked with F: both wake on the same PR events); F keeps ticking.
    expect(acquireRead(clone, { ...common, owner: 'W', nowMs: t }).ok).toBe(true);
    for (let i = 0; i < 10; i += 1) { t += 10; fStep(); }
    releaseRead(clone, { lockRoot, owner: 'W' });
  }
  return { movedAt: null, fRefusals, lockRoot, clone };
}

describe('writer fairness — a writer that gave up blocks NEW reads until a writer moves the clone', () => {
  it('reproduces the live starvation with writer priority off: the writer never gets the clone', async () => {
    const r = await simulateWriter({ cycles: 8, writerPriorityAfter: 0 });
    expect(r.movedAt).toBeNull();
  });

  it('resolves it with writer priority on: the writer moves on its next attempt, readers yield meanwhile', async () => {
    const r = await simulateWriter({ cycles: 8, writerPriorityAfter: DEFAULT_WRITER_PRIORITY_AFTER });
    expect(r.movedAt).toBe(2);
    expect(r.fRefusals).toContain('writer-priority');
    // The claim was cleared by the move, and writer-priority refusals never counted as reader starvation.
    const snap = inspectCloneLock(r.clone, { lockRoot: r.lockRoot, probe: alive, leaseMinutes: LEASE });
    expect(snap.writerClaim).toBeNull();
    expect(snap.starved).toEqual([]);
    // After the move, the reader gets in again.
    expect(acquireRead(r.clone, { lockRoot: r.lockRoot, owner: 'F', probe: alive, leaseMinutes: LEASE, writerClaimTtlMs: TTL }).ok).toBe(true);
  });

  it('never refuses the claimant itself, and the claim lapses when its owner is dead or past its TTL', async () => {
    const lockRoot = mkTmp('dcwf-root-');
    const clone = mkTmp('dcwf-clone-');
    let t = 0;
    const base = { lockRoot, leaseMinutes: LEASE, writerPriorityAfter: 1 };
    acquireRead(clone, { ...base, owner: 'F', probe: alive, nowMs: t });
    const w = await acquireWrite(clone, {
      ...base, owner: 'W', probe: alive, waitMs: 5, pollMs: 1, now: () => t, sleep: async (ms) => { t += ms; }, writerClaimTtlMs: TTL,
    });
    expect(w).toMatchObject({ ok: false, reason: 'tick-in-progress', writerStarved: 1 });
    releaseRead(clone, { lockRoot, owner: 'F' });
    expect(acquireRead(clone, { ...base, owner: 'W', probe: alive, nowMs: t, writerClaimTtlMs: TTL }).ok).toBe(true);
    releaseRead(clone, { lockRoot, owner: 'W' });
    expect(acquireRead(clone, { ...base, owner: 'F', probe: alive, nowMs: t, writerClaimTtlMs: TTL }))
      .toMatchObject({ ok: false, reason: 'writer-priority', heldBy: 'W', writerStarved: 1 });
    // Owner dead → lapses.
    const deadW = (e) => (e?.owner === 'W' ? 'dead' : 'alive');
    expect(acquireRead(clone, { ...base, owner: 'F', probe: deadW, nowMs: t, writerClaimTtlMs: TTL }).ok).toBe(true);
    releaseRead(clone, { lockRoot, owner: 'F' });
    // TTL → lapses (re-create the claim first).
    acquireRead(clone, { ...base, owner: 'F', probe: alive, nowMs: t });
    await acquireWrite(clone, {
      ...base, owner: 'W', probe: alive, waitMs: 5, pollMs: 1, now: () => t, sleep: async (ms) => { t += ms; }, writerClaimTtlMs: TTL,
    });
    releaseRead(clone, { lockRoot, owner: 'F' });
    expect(acquireRead(clone, { ...base, owner: 'F', probe: alive, nowMs: Date.now(), writerClaimTtlMs: 1000 }).ok).toBe(true);
  });
});

describe('reader and writer priority never both back off — the older claim wins', () => {
  it('a reader starved BEFORE the writer claim gets in first; then the writer claim wins the next gap', async () => {
    const lockRoot = mkTmp('dcwf-root-');
    const clone = mkTmp('dcwf-clone-');
    let t = 0;
    const base = { lockRoot, leaseMinutes: LEASE, probe: alive, writerPriorityAfter: 1, writerClaimTtlMs: TTL, readerPriorityAfter: 3 };
    // L holds a read; W reserves and waits; R is refused 3x during W's drain (starvation begins at t≈1s).
    acquireRead(clone, { ...base, owner: 'L', nowMs: t });
    let rStarved = 0;
    const w1 = await acquireWrite(clone, {
      ...base, owner: 'W', waitMs: 10_000, pollMs: 1000, now: () => t,
      sleep: async (ms) => {
        t += ms;
        if (rStarved < 3) {
          const r = acquireRead(clone, { ...base, owner: 'R', readerKey: 'reader:r', nowMs: t });
          rStarved = r.starved ?? rStarved;
        }
      },
    });
    // The reader starved first, so W yields to it (the #4039 behaviour, intact).
    expect(w1).toMatchObject({ ok: false, reason: 'reader-priority' });
    expect(acquireRead(clone, { ...base, owner: 'R', readerKey: 'reader:r', nowMs: t }).ok).toBe(true);
    releaseRead(clone, { lockRoot, owner: 'R' });
    // W now starves on L (gave up) → claim. R's starvation was cleared by its read, so the claim is older.
    const w2 = await acquireWrite(clone, {
      ...base, owner: 'W', waitMs: 3000, pollMs: 1000, now: () => t, sleep: async (ms) => { t += ms; },
    });
    expect(w2).toMatchObject({ ok: false, reason: 'tick-in-progress', writerStarved: 1 });
    const refused = acquireRead(clone, { ...base, owner: 'R', readerKey: 'reader:r', nowMs: t });
    expect(refused).toMatchObject({ ok: false, reason: 'writer-priority' });
    expect(refused.starved).toBeUndefined();
    // R keeps retrying (event wakes) while W drains: every refusal is uncounted, so R can never re-trigger
    // reader priority against the older writer claim — W is not made to back off, and gets the clone.
    let rCount = 0;
    const w3 = await acquireWrite(clone, {
      ...base, owner: 'W', waitMs: 60_000, pollMs: 1000, now: () => t,
      sleep: async (ms) => {
        t += ms;
        rCount += 1;
        expect(acquireRead(clone, { ...base, owner: 'R', readerKey: 'reader:r', nowMs: t }).ok).toBe(false);
        if (rCount === 5) releaseRead(clone, { lockRoot, owner: 'L' }); // L's in-flight tick ends
      },
    });
    expect(rCount).toBe(5);
    expect(w3).toEqual({ ok: true });
    releaseWrite(clone, { lockRoot, owner: 'W' });
    expect(inspectCloneLock(clone, { lockRoot, probe: alive, leaseMinutes: LEASE }).writerClaim).toBeNull();
    expect(acquireRead(clone, { ...base, owner: 'R', readerKey: 'reader:r', nowMs: t }).ok).toBe(true);
  });
});

describe('settings + withSelfSync wiring', () => {
  it('resolves declared settings with safe defaults', () => {
    expect(resolveWriterPriorityAfter({})).toBe(DEFAULT_WRITER_PRIORITY_AFTER);
    expect(resolveWriterPriorityAfter({ WE_DAEMON_CLONE_LOCK_WRITER_PRIORITY_AFTER: '0' })).toBe(0);
    expect(resolveWriterPriorityAfter({ WE_DAEMON_CLONE_LOCK_WRITER_PRIORITY_AFTER: 'x' })).toBe(DEFAULT_WRITER_PRIORITY_AFTER);
    expect(resolveWriterClaimTtlMs({})).toBe(DEFAULT_WRITER_CLAIM_TTL_MS);
    expect(resolveCloneStuckSmellMs({})).toBe(DEFAULT_CLONE_STUCK_SMELL_MS);
    expect(resolveCloneStuckSmellMs({ WE_DAEMON_CLONE_STUCK_SMELL_MS: '0' })).toBe(0);
  });

  it('cloneStuckSmell: stuck only when main moved past the adopted main AND the adoption is old', () => {
    const adopted = { at: new Date(0).toISOString(), mainSha: 'a' };
    const T = 30 * 60_000;
    expect(cloneStuckSmell({ adopted, originMain: 'b', nowMs: T + 1, thresholdMs: T })).toEqual({ stuck: true, ageMs: T + 1 });
    expect(cloneStuckSmell({ adopted, originMain: 'a', nowMs: T * 10, thresholdMs: T }).stuck).toBe(false);
    expect(cloneStuckSmell({ adopted, originMain: 'b', nowMs: T - 1, thresholdMs: T }).stuck).toBe(false);
    expect(cloneStuckSmell({ adopted, originMain: 'b', nowMs: T * 10, thresholdMs: 0 }).stuck).toBe(false);
    expect(cloneStuckSmell({ adopted: null, originMain: 'b', nowMs: T * 10, thresholdMs: T }).stuck).toBe(false);
  });

  it('a writer-priority refusal yields the tick (logged, never ticks) and the stuck smell is logged once per window', async () => {
    let t = 6 * 60 * 60_000;
    const tick = vi.fn();
    const log = { error: vi.fn() };
    const w = withSelfSync({ tickOnce: tick }, {
      root: '/x', onRestart: vi.fn(), log, readHead: () => 'h',
      rebuild: async () => ({ moved: false, reason: 'tick-in-progress' }),
      readState: () => ({ adopted: { at: new Date(0).toISOString(), mainSha: 'old' } }),
      readOriginRef: () => 'new',
      acquireRead: () => ({ ok: false, reason: 'writer-priority', heldBy: 'Mac:74387', writerStarved: 2, claimSince: 'x' }),
      releaseRead: vi.fn(), now: () => t, sleep: async (ms) => { t += ms; }, cloneStuckSmellMs: 30 * 60_000,
    });
    await expect(w.tickOnce()).resolves.toMatchObject({ skipped: true, reason: 'writer-priority' });
    await w.tickOnce();
    expect(tick).not.toHaveBeenCalled();
    const lines = log.error.mock.calls.map((c) => c[0]);
    expect(lines.some((l) => l.includes('yielding this tick — writer Mac:74387 gave up 2'))).toBe(true);
    expect(lines.filter((l) => l.includes('SMELL clone-stuck — the clone has not moved for 360 min'))).toHaveLength(1);
  });
});

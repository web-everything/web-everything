/** Phase 1 regressions for bounded hard writer priority. All lock state is task-local. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireRead, releaseRead, acquireWrite, releaseWrite, inspectCloneLock, cloneLockDirs } from '../daemon-clone-lock.mjs';

let scratch, root, lockRoot, t, common;
const T = 1_800_000_000_000;
const alive = () => 'alive';
beforeEach(() => {
  vi.stubEnv('WE_DAEMON_CLONE_LOCK_WRITER_HARD_MAX_MS', undefined);
  vi.stubEnv('WE_DAEMON_CLONE_LOCK_WRITER_HARD_AFTER', undefined);
  scratch = mkdtempSync(join(tmpdir(), 'clone-hard-writer-'));
  root = join(scratch, 'clone'); mkdirSync(root);
  lockRoot = join(scratch, 'locks'); t = T;
  common = { lockRoot, probe: alive, leaseMinutes: 1e9, writerClaimTtlMs: 1e12,
    writerPriorityAfter: 1, readerPriorityAfter: 3, writerPriorityMaxSkips: 2 };
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true }); });
const snapshot = () => inspectCloneLock(root, { ...common, nowMs: t });
const read = (owner, extra = {}) => acquireRead(root, { ...common, owner, readerKey: `reader:${owner}`, nowMs: t, ...extra });
const release = (owner) => releaseRead(root, { lockRoot, owner });
const write = (extra = {}) => acquireWrite(root, { ...common, owner: 'writer', waitMs: 10, pollMs: 1,
  now: () => t, sleep: async (ms) => { t += ms; }, ...extra });
function seedClaim({ owner = 'claimant', since = t, hard = true, count = 2 } = {}) {
  const { base } = cloneLockDirs(root, lockRoot); mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'writer-claim.json'), JSON.stringify({ owner, pid: process.pid, count, hard,
    since: new Date(since).toISOString(), lastAt: new Date(t).toISOString(), heldBy: 'existing-reader' }));
}
function seedOlderReader() {
  const { starvedRoot } = cloneLockDirs(root, lockRoot); mkdirSync(starvedRoot, { recursive: true });
  writeFileSync(join(starvedRoot, 'older.json'), JSON.stringify({ owner: 'older', readerKey: 'reader:older',
    pid: process.pid, count: 3, firstRefusedAt: new Date(t - 100).toISOString(), lastRefusedAt: new Date(t).toISOString() }));
}

describe('hard writer starvation reproduction with real timers', () => {
  it('ten continuously retrying readers drain for a hard writer within five seconds, with no reader slot at acquisition', async () => {
    let running = true;
    const held = new Set();
    const starts = Array.from({ length: 10 }, () => Promise.withResolvers());
    const workers = starts.map(async (start, i) => {
      const owner = `reader-${i}`;
      let first = true;
      try {
        while (running) {
          const r = acquireRead(root, { ...common, owner, readerKey: owner });
          if (r.ok) {
            held.add(owner);
            // Stagger the initial drain: early readers retry while later readers still hold their slots.
            const holdMs = first ? 20 + i * 2 : 20;
            if (first) { first = false; start.resolve(); }
            try { await delay(holdMs); }
            finally { releaseRead(root, { lockRoot, owner }); held.delete(owner); }
          } else {
            await delay(1);
          }
        }
      } finally { releaseRead(root, { lockRoot, owner }); held.delete(owner); }
    });
    try {
      await Promise.all(starts.map((s) => s.promise));
      const began = performance.now();
      const result = await acquireWrite(root, { ...common, owner: 'rebuild-job', hardClaim: true, waitMs: 4900, pollMs: 10 });
      const elapsed = performance.now() - began;
      expect(result).toEqual({ ok: true });
      expect(elapsed).toBeLessThan(5000);
      expect(held.size).toBe(0);
      const snap = inspectCloneLock(root, common);
      expect(snap.writerLive).toBe(true);
      expect(snap.readers.filter((r) => r.live)).toEqual([]);
      expect(snap.writerClaim).toBeNull();
      // During the move even relentless retries cannot take a read slot.
      await delay(30);
      expect(held.size).toBe(0);
      expect(inspectCloneLock(root, common).readers.filter((r) => r.live)).toEqual([]);
    } finally {
      running = false;
      releaseWrite(root, { lockRoot, owner: 'rebuild-job' });
      await Promise.all(workers);
    }
  }, 8000);
});

describe('hard claims, deterministic priority boundaries', () => {
  it('hardClaim publishes immediately before draining existing readers and clears only when write is acquired', async () => {
    expect(read('existing').ok).toBe(true);
    let polls = 0;
    const r = await write({ hardClaim: true, sleep: async (ms) => {
      t += ms; polls += 1;
      expect(snapshot().writerClaim).toMatchObject({ hard: true, owner: 'writer' });
      // Reservation may coexist with draining readers; movement may not begin until they release.
      expect(read('newcomer')).toMatchObject({ ok: false, reason: 'writer-priority' });
      expect(snapshot().starved).toEqual([]);
      release('existing');
    } });
    expect(polls).toBeGreaterThan(0);
    expect(r).toEqual({ ok: true });
    expect(snapshot().readers.filter((r) => r.live)).toEqual([]);
    expect(snapshot().writerClaim).toBeNull();
    releaseWrite(root, { lockRoot, owner: 'writer' });
  });
  it('hard claims ignore the skip cap and refusals never create starved readers', () => {
    seedClaim();
    for (let i = 0; i < 8; i += 1) {
      const r = read('retrying');
      if (r.ok) release('retrying');
      expect(r).toMatchObject({ ok: false, reason: 'writer-priority' });
      expect(r.starved).toBeUndefined();
    }
    expect(snapshot().starved).toEqual([]);
  });
  it('hard claims ignore the older-reader exception without incrementing existing starvation', () => {
    seedOlderReader(); seedClaim();
    expect(read('older')).toMatchObject({ ok: false, reason: 'writer-priority' });
    expect(snapshot().starved).toMatchObject([{ owner: 'older', count: 3 }]);
    expect(snapshot().readers).toEqual([]);
  });
  it('soft-claim control: the skip cap and older-reader exception still allow readers', () => {
    seedClaim({ hard: false });
    expect(read('retrying').reason).toBe('writer-priority');
    expect(read('retrying').reason).toBe('writer-priority');
    expect(read('retrying').ok).toBe(true); release('retrying');
    seedOlderReader();
    expect(read('older').ok).toBe(true); release('older');
  });
  it('default hard window expires after fifteen minutes despite a refreshed lastAt', () => {
    seedClaim();
    t += 15 * 60_000 - 1;
    seedClaim({ since: T });
    expect(read('retrying', { writerPriorityMaxSkips: 0 })).toMatchObject({ ok: false, reason: 'writer-priority' });
    t += 2;
    seedClaim({ since: T });
    expect(read('retrying', { writerPriorityMaxSkips: 0 }).ok).toBe(true); release('retrying');
  });
  it('configured hard window returns to older-reader priority after expiry', async () => {
    vi.stubEnv('WE_DAEMON_CLONE_LOCK_WRITER_HARD_MAX_MS', '100');
    seedOlderReader(); seedClaim();
    t += 101;
    expect(read('older').ok).toBe(true); release('older');
    seedOlderReader();
    expect(await write()).toMatchObject({ ok: false, reason: 'reader-priority' });
  });
  it.each(['writer', 'another-pid-rebuild-job'])('a live hard claim owned by %s prevents reader-priority backoff', async (owner) => {
    seedOlderReader(); seedClaim({ owner });
    expect(await write()).toEqual({ ok: true });
    expect(snapshot().readers).toEqual([]);
    expect(snapshot().writerClaim).toBeNull();
    releaseWrite(root, { lockRoot, owner: 'writer' });
  });
  it('hard claim remains hard with its original since across timeout refreshes', async () => {
    expect(read('existing').ok).toBe(true);
    seedClaim({ owner: 'writer', since: T - 1000 });
    expect(await write()).toMatchObject({ ok: false, reason: 'tick-in-progress' });
    expect(snapshot().writerClaim).toMatchObject({ hard: true, since: new Date(T - 1000).toISOString() });
    expect(snapshot().writerLive).toBe(false);
    release('existing');
  });
  it('two tick-in-progress give-ups promote a soft claim when explicitly enabled', async () => {
    vi.stubEnv('WE_DAEMON_CLONE_LOCK_WRITER_HARD_AFTER', '2');
    expect(read('existing').ok).toBe(true);
    expect(await write()).toMatchObject({ reason: 'tick-in-progress' });
    expect(snapshot().writerClaim?.hard).not.toBe(true);
    expect(await write()).toMatchObject({ reason: 'tick-in-progress' });
    expect(snapshot().writerClaim).toMatchObject({ count: 2, hard: true });
    release('existing');
  });
  it.each([undefined, '0'])('soft claims do not promote by default or when disabled (%s)', async (value) => {
    vi.stubEnv('WE_DAEMON_CLONE_LOCK_WRITER_HARD_AFTER', value);
    expect(read('existing').ok).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      expect(await write()).toMatchObject({ reason: 'tick-in-progress' });
      expect(snapshot().writerClaim?.hard).not.toBe(true);
    }
    expect(snapshot().writerClaim?.count).toBe(4);
    release('existing');
  });
  it('WE_DAEMON_CLONE_LOCK_WRITER_HARD_AFTER controls the promotion threshold', async () => {
    vi.stubEnv('WE_DAEMON_CLONE_LOCK_WRITER_HARD_AFTER', '3');
    expect(read('existing').ok).toBe(true);
    await write(); await write();
    expect(snapshot().writerClaim?.hard).not.toBe(true);
    await write();
    expect(snapshot().writerClaim).toMatchObject({ count: 3, hard: true });
    release('existing');
  });
  it('dead hard claimant does not block readers forever', () => {
    seedClaim();
    expect(read('new', { probe: (entry) => entry?.owner === 'claimant' ? 'dead' : 'alive' }).ok).toBe(true);
    release('new');
    expect(snapshot().writerClaim).toBeNull();
  });
});

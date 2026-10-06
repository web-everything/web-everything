/**
 * @file scripts/readiness/__tests__/file-locks.test.mjs
 * @description Unit proof of the mandatory write-time file-lock layer (#1945 — the #1935 Fork-2 / #1936
 *   pessimistic tier). Covers BOTH planes:
 *     • the PURE decision logic (reclaimDecision / isLeaseExpired / wasReclaimed / planReservations) —
 *       the heart of the #1936 ratified policy (lease floor + PID fast-path + broker fencing);
 *     • the ATOMIC fs primitives (acquireLockDir / reserve / heartbeat / release) against a real temp
 *       lock root, proving mkdir is the race gate and reserve applies the decision end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, utimesSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  DEFAULT_LEASE_MINUTES, ENTRYLESS_LOCK_DIR_GRACE_MS, lockIdFor, parseLockEntry, makeLockEntry, isLeaseExpired,
  reclaimDecision, wasReclaimed, planReservations,
  acquireLockDir, readLockEntry, heartbeat, heartbeatOwn, releaseLockDir, releaseLockDirIf, reserve, lockDirFor,
} from '../file-locks.mjs';

const T0 = Date.parse('2026-06-28T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const LEASE_MS = DEFAULT_LEASE_MINUTES * 60_000;

describe('parseLockEntry — tolerant, never throws', () => {
  it('parses a well-formed entry', () => {
    const e = parseLockEntry(JSON.stringify({ owner: 'A', path: 'p', pid: 42, heartbeatAt: iso(T0) }));
    expect(e).toEqual({ owner: 'A', path: 'p', pid: 42, heartbeatAt: iso(T0) });
  });
  it('returns null for corrupt / empty / partial entries', () => {
    expect(parseLockEntry('')).toBeNull();
    expect(parseLockEntry('{not json')).toBeNull();
    expect(parseLockEntry(JSON.stringify({ owner: 'A' }))).toBeNull();        // no heartbeatAt
    expect(parseLockEntry(JSON.stringify({ heartbeatAt: iso(T0) }))).toBeNull(); // no owner
  });
  it('normalizes a non-integer pid to null (fast-path metadata is optional)', () => {
    const e = parseLockEntry(JSON.stringify({ owner: 'A', heartbeatAt: iso(T0), pid: 'x' }));
    expect(e.pid).toBeNull();
  });
  it('preserves opaque owner meta round-trip; omits it when absent or non-object (#2458)', () => {
    const withMeta = parseLockEntry(JSON.stringify({ owner: 'A', path: 'p', heartbeatAt: iso(T0), meta: { scope: ['o/we'] } }));
    expect(withMeta.meta).toEqual({ scope: ['o/we'] });
    const noMeta = parseLockEntry(JSON.stringify({ owner: 'A', path: 'p', heartbeatAt: iso(T0) }));
    expect('meta' in noMeta).toBe(false); // no meta key when the entry has none (byte-identical to pre-#2458)
    const badMeta = parseLockEntry(JSON.stringify({ owner: 'A', path: 'p', heartbeatAt: iso(T0), meta: ['not', 'an', 'object'] }));
    expect('meta' in badMeta).toBe(false); // an array/non-object meta is ignored, never surfaced
  });
  it('makeLockEntry carries meta only when it is a non-empty object; reserve/heartbeat thread it through (#2458)', () => {
    expect('meta' in makeLockEntry('A', 'p', iso(T0))).toBe(false);
    expect('meta' in makeLockEntry('A', 'p', iso(T0), null, {})).toBe(false); // empty object adds no key
    expect(makeLockEntry('A', 'p', iso(T0), null, { scope: ['x'] }).meta).toEqual({ scope: ['x'] });
  });
});

describe('isLeaseExpired — Fork-2 correctness floor', () => {
  it('fresh heartbeat within the lease is live', () => {
    expect(isLeaseExpired(makeLockEntry('A', 'p', iso(T0)), T0 + LEASE_MS - 1)).toBe(false);
  });
  it('a heartbeat older than the lease is expired', () => {
    expect(isLeaseExpired(makeLockEntry('A', 'p', iso(T0)), T0 + LEASE_MS + 1)).toBe(true);
  });
  it('an unparseable heartbeat is treated as expired (Infinity age)', () => {
    expect(isLeaseExpired({ heartbeatAt: 'garbage' }, T0)).toBe(true);
    expect(isLeaseExpired(null, T0)).toBe(true);
  });
});

describe('reclaimDecision — #1936 Fork-2 (a)+(b)', () => {
  const live = makeLockEntry('owner-X', 'p', iso(T0));
  it('no entry → free', () => {
    expect(reclaimDecision(null, T0, 'me')).toEqual({ acquirable: true, reason: 'free', heldBy: null });
  });
  it("requester already owns it → own (re-acquire = refresh)", () => {
    const d = reclaimDecision(makeLockEntry('me', 'p', iso(T0)), T0, 'me');
    expect(d).toMatchObject({ acquirable: true, reason: 'own', heldBy: 'me' });
  });
  it('live owner, liveness unknown → BLOCKED (wait/defer)', () => {
    expect(reclaimDecision(live, T0 + 60_000, 'me', 'unknown')).toMatchObject({ acquirable: false, reason: 'held', heldBy: 'owner-X' });
  });
  it('PID fast path: provably-dead owner → reclaim immediately, BEFORE the lease expires', () => {
    const d = reclaimDecision(live, T0 + 60_000, 'me', 'dead'); // well within lease, but owner is gone
    expect(d).toMatchObject({ acquirable: true, reason: 'pid-dead', heldBy: 'owner-X' });
  });
  it('PID alive does NOT accelerate — a live (possibly PID-reused) owner falls through to the TTL floor', () => {
    expect(reclaimDecision(live, T0 + 60_000, 'me', 'alive')).toMatchObject({ acquirable: false, reason: 'held' });
  });
  it('lease expired → reclaim via the TTL floor even when liveness is unknown (host-independent)', () => {
    expect(reclaimDecision(live, T0 + LEASE_MS + 1, 'me', 'unknown')).toMatchObject({ acquirable: true, reason: 'lease-expired' });
  });

  describe('requesterPid (#3383 fix) — an owner string can be shared across DIFFERENT real processes; opt-in only', () => {
    it('default (no requesterPid, or null) — owner match alone is still "own", byte-identical to before this fix', () => {
      const entry = makeLockEntry('lane-34', 'p', iso(T0), 111); // held by real pid 111
      expect(reclaimDecision(entry, T0, 'lane-34')).toMatchObject({ acquirable: true, reason: 'own' });
      expect(reclaimDecision(entry, T0, 'lane-34', 'unknown', LEASE_MS / 60_000, null)).toMatchObject({ acquirable: true, reason: 'own' });
    });
    it('requesterPid matching the held entry\'s pid — same owner AND same real process — still "own"', () => {
      const entry = makeLockEntry('lane-34', 'p', iso(T0), 111);
      expect(reclaimDecision(entry, T0, 'lane-34', 'unknown', LEASE_MS / 60_000, 111)).toMatchObject({ acquirable: true, reason: 'own' });
    });
    it('requesterPid DIFFERENT from the held entry\'s pid — same owner string, but a genuinely different real process — falls through, NOT "own"', () => {
      const entry = makeLockEntry('lane-34', 'p', iso(T0), 111); // held by real pid 111
      const d = reclaimDecision(entry, T0 + 1000, 'lane-34', 'alive', LEASE_MS / 60_000, 222); // requester is pid 222
      expect(d).toMatchObject({ acquirable: false, reason: 'held', heldBy: 'lane-34' }); // occupied by the other real process
    });
    it('same owner string, different requesterPid, but the held pid is provably DEAD — still reclaimed via the pid-dead fast path', () => {
      const entry = makeLockEntry('lane-34', 'p', iso(T0), 111);
      const d = reclaimDecision(entry, T0 + 1000, 'lane-34', 'dead', LEASE_MS / 60_000, 222);
      expect(d).toMatchObject({ acquirable: true, reason: 'pid-dead', heldBy: 'lane-34' });
    });
    it('same owner string, different requesterPid, held pid unknown/alive but the lease is genuinely stale — still reclaimed via the TTL floor', () => {
      const entry = makeLockEntry('lane-34', 'p', iso(T0), 111);
      const d = reclaimDecision(entry, T0 + LEASE_MS + 1, 'lane-34', 'unknown', LEASE_MS / 60_000, 222);
      expect(d).toMatchObject({ acquirable: true, reason: 'lease-expired', heldBy: 'lane-34' });
    });
    it('requesterPid is a no-op when the held entry never recorded a pid (nothing to compare against)', () => {
      const entry = makeLockEntry('lane-34', 'p', iso(T0)); // no pid recorded
      expect(reclaimDecision(entry, T0, 'lane-34', 'unknown', LEASE_MS / 60_000, 222)).toMatchObject({ acquirable: true, reason: 'own' });
    });
  });
});

describe('wasReclaimed — broker fencing point (Kleppmann race)', () => {
  it('lane still owns the path → not reclaimed (accept push)', () => {
    expect(wasReclaimed(makeLockEntry('lane-A', 'p', iso(T0)), 'lane-A')).toBe(false);
  });
  it('path now owned by someone else → reclaimed mid-flight (REJECT push)', () => {
    expect(wasReclaimed(makeLockEntry('lane-B', 'p', iso(T0)), 'lane-A')).toBe(true);
  });
  it('path no longer held at all → reclaimed/freed (REJECT push)', () => {
    expect(wasReclaimed(null, 'lane-A')).toBe(true);
  });
});

describe('planReservations — partition wanted paths into acquire vs blocked', () => {
  it('separates free/reclaimable from live-held', () => {
    const liveHeld = makeLockEntry('other', 'busy', iso(T0));
    const probe = (path) => {
      if (path === 'free') return { entry: null };
      if (path === 'busy') return { entry: liveHeld, pidLiveness: 'unknown' };
      if (path === 'dead') return { entry: makeLockEntry('gone', 'dead', iso(T0)), pidLiveness: 'dead' };
      return { entry: null };
    };
    const plan = planReservations(['free', 'busy', 'dead'], 'me', T0 + 60_000, probe);
    expect(plan.acquire.map((a) => a.path).sort()).toEqual(['dead', 'free']);
    expect(plan.blocked.map((b) => b.path)).toEqual(['busy']);
    expect(plan.allAcquirable).toBe(false);
  });
  it('allAcquirable when nothing is live-held', () => {
    const plan = planReservations(['a', 'b'], 'me', T0, () => ({ entry: null }));
    expect(plan.allAcquirable).toBe(true);
    expect(plan.blocked).toHaveLength(0);
  });
});

describe('lockIdFor — stable, fs-safe, collision-distinct', () => {
  it('is deterministic and path-distinct', () => {
    expect(lockIdFor('src/_data/traits.json')).toBe(lockIdFor('src/_data/traits.json'));
    expect(lockIdFor('a')).not.toBe(lockIdFor('b'));
    expect(lockIdFor('a/b/c.json')).toMatch(/^[0-9a-f]{16}$/); // no slashes — flat lock home
  });
});

describe('atomic fs primitives — real temp lock root', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'we-locks-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('acquireLockDir wins exactly once; a second caller sees EEXIST (false)', () => {
    const path = 'src/_data/traits.json';
    expect(acquireLockDir(root, path, makeLockEntry('A', path, iso(T0), 100))).toBe(true);
    expect(existsSync(lockDirFor(root, path))).toBe(true);
    expect(acquireLockDir(root, path, makeLockEntry('B', path, iso(T0), 200))).toBe(false); // B loses the race
    expect(readLockEntry(root, path).owner).toBe('A'); // winner's entry intact
  });

  it('reserve: free path is acquired by the requester', () => {
    const r = reserve(root, 'p', 'A', T0, iso(T0), 100);
    expect(r).toMatchObject({ ok: true, reason: 'free', heldBy: 'A' });
  });

  it('reserve: a live foreign lock BLOCKS (wait/defer)', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100);
    const r = reserve(root, 'p', 'B', T0 + 60_000, iso(T0 + 60_000), 200, 'unknown');
    expect(r).toMatchObject({ ok: false, reason: 'held', heldBy: 'A' });
    expect(readLockEntry(root, 'p').owner).toBe('A'); // not stomped
  });

  it('reserve: a stale (lease-expired) lock is reclaimed by the new owner', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100);
    const r = reserve(root, 'p', 'B', T0 + LEASE_MS + 1, iso(T0 + LEASE_MS + 1), 200, 'unknown');
    expect(r).toMatchObject({ ok: true, reason: 'lease-expired', heldBy: 'B' });
    expect(readLockEntry(root, 'p').owner).toBe('B'); // reclaimed
  });

  it('reserve: a liveness PROBE function is judged against the entry reserve itself read — no stale double-read (review #2668)', () => {
    // The probe says only owner A's pid is dead. A caller that probed A, then lost the lock to a live C before
    // reserve re-read, must NOT reclaim C: the probe runs against C's entry, and C is alive.
    const seen = [];
    const probe = (entry) => { seen.push(entry && entry.owner); return entry && entry.owner === 'A' ? 'dead' : 'alive'; };
    reserve(root, 'p', 'C', T0, iso(T0), 300);
    const onLive = reserve(root, 'p', 'B', T0 + 60_000, iso(T0 + 60_000), 200, probe);
    expect(onLive).toMatchObject({ ok: false, reason: 'held', heldBy: 'C' });
    expect(readLockEntry(root, 'p').owner).toBe('C');
    releaseLockDir(root, 'p');
    reserve(root, 'p', 'A', T0, iso(T0), 100);
    const onDead = reserve(root, 'p', 'B', T0 + 60_000, iso(T0 + 60_000), 200, probe);
    expect(onDead).toMatchObject({ ok: true, reason: 'pid-dead', heldBy: 'B' });
    expect(seen).toEqual(['C', 'A']);
  });

  it('reserve: PID-dead owner is reclaimed immediately, before the lease lapses', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100);
    const r = reserve(root, 'p', 'B', T0 + 60_000, iso(T0 + 60_000), 200, 'dead'); // within lease, owner gone
    expect(r).toMatchObject({ ok: true, reason: 'pid-dead', heldBy: 'B' });
  });

  it('reserve: re-acquiring my own lock refreshes the heartbeat (own)', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100);
    const later = iso(T0 + 5 * 60_000);
    const r = reserve(root, 'p', 'A', T0 + 5 * 60_000, later, 100);
    expect(r).toMatchObject({ ok: true, reason: 'own' });
    expect(readLockEntry(root, 'p').heartbeatAt).toBe(later);
  });

  it('heartbeat extends a held lease in place; release frees the path', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100);
    expect(heartbeat(root, 'p', 'A', iso(T0 + 60_000), 100)).toBe(true);
    expect(readLockEntry(root, 'p').heartbeatAt).toBe(iso(T0 + 60_000));
    releaseLockDir(root, 'p');
    expect(readLockEntry(root, 'p')).toBeNull();
    expect(heartbeat(root, 'p', 'A', iso(T0), 100)).toBe(false); // no-op once gone
  });

  it('reserve persists meta and heartbeat can re-supply it (#2458)', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100, 'unknown', DEFAULT_LEASE_MINUTES, { scope: ['o/we'] });
    expect(readLockEntry(root, 'p').meta).toEqual({ scope: ['o/we'] });
    heartbeat(root, 'p', 'A', iso(T0 + 60_000), 100, { scope: ['o/we', 'o/frontierui'] });
    expect(readLockEntry(root, 'p').meta).toEqual({ scope: ['o/we', 'o/frontierui'] });
    heartbeat(root, 'p', 'A', iso(T0 + 120_000), 100); // no meta → entry has none (heartbeat rebuilds the payload)
    expect('meta' in readLockEntry(root, 'p')).toBe(false);
  });

  it('end-to-end fencing: after B reclaims A\'s stale lock, wasReclaimed flags A\'s push for rejection', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100);
    reserve(root, 'p', 'B', T0 + LEASE_MS + 1, iso(T0 + LEASE_MS + 1), 200, 'unknown'); // B reclaims
    const current = readLockEntry(root, 'p');
    expect(wasReclaimed(current, 'A')).toBe(true);  // A's lease lapsed under it → broker rejects A
    expect(wasReclaimed(current, 'B')).toBe(false); // B legitimately holds it
  });

  describe('reserve: requireOwnProcess (#3383 fix) — opt-in only, defaults false so every existing caller is unaffected', () => {
    it('default (requireOwnProcess omitted) — same owner, DIFFERENT pid, still fast-paths as "own" (the pre-fix, still-correct behavior for every OTHER file-locks.mjs consumer, e.g. file-locks-cli.mjs\'s session-spanning reservations)', () => {
      reserve(root, 'p', 'lane-5', T0, iso(T0), 100); // first CLI invocation, pid 100
      const r = reserve(root, 'p', 'lane-5', T0 + 1000, iso(T0 + 1000), 200); // a LATER, different CLI invocation, pid 200
      expect(r).toMatchObject({ ok: true, reason: 'own', heldBy: 'lane-5' });
    });

    it('requireOwnProcess:true — same owner, SAME pid, still fast-paths as "own" (the legitimate in-process reentrancy this fix must preserve)', () => {
      reserve(root, 'p', 'lane-34', T0, iso(T0), 100, 'unknown', DEFAULT_LEASE_MINUTES, null, true);
      const r = reserve(root, 'p', 'lane-34', T0 + 1000, iso(T0 + 1000), 100, 'unknown', DEFAULT_LEASE_MINUTES, null, true);
      expect(r).toMatchObject({ ok: true, reason: 'own', heldBy: 'lane-34' });
    });

    it('requireOwnProcess:true — same owner, DIFFERENT (live) pid — BLOCKED, not "own" (the #3383 fix: heavy-admission.mjs\'s lane-path-keyed slots)', () => {
      reserve(root, 'p', 'lane-34', T0, iso(T0), 100, 'unknown', DEFAULT_LEASE_MINUTES, null, true);
      // 'alive' liveness (as heavy-admission.mjs's tryAcquireSlot would probe for a real distinct pid) — must
      // be BLOCKED, never silently heartbeat-refreshed over the other real process.
      const r = reserve(root, 'p', 'lane-34', T0 + 1000, iso(T0 + 1000), 200, 'alive', DEFAULT_LEASE_MINUTES, null, true);
      expect(r).toMatchObject({ ok: false, reason: 'held', heldBy: 'lane-34' });
      expect(readLockEntry(root, 'p').pid).toBe(100); // untouched — the first process's slot survives intact
    });

    it('requireOwnProcess:true — same owner, DIFFERENT pid, held pid provably dead — still reclaimed (PID fast path unaffected)', () => {
      reserve(root, 'p', 'lane-34', T0, iso(T0), 100, 'unknown', DEFAULT_LEASE_MINUTES, null, true);
      const r = reserve(root, 'p', 'lane-34', T0 + 1000, iso(T0 + 1000), 200, 'dead', DEFAULT_LEASE_MINUTES, null, true);
      expect(r).toMatchObject({ ok: true, reason: 'pid-dead', heldBy: 'lane-34' });
      expect(readLockEntry(root, 'p').pid).toBe(200); // reclaimed by the new process
    });
  });
});

// xaipsbs — the mkdir/write gap: a loser that finds the winner's dir without its lock.json yet must NOT read
// it as free (it used to delete the winner's dir and take the lock too: two holders).
describe('reserve — a lock dir with no entry yet is a winner still writing, not a free lock', () => {
  it('refuses a fresh entryless dir, and reclaims one older than the grace period', async () => {
    const { mkdtempSync, mkdirSync, rmSync, utimesSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { reserve, lockDirFor, readLockEntry, ENTRYLESS_LOCK_DIR_GRACE_MS } = await import('../file-locks.mjs');
    const root = mkdtempSync(join(tmpdir(), 'file-locks-gap-'));
    try {
      const dir = lockDirFor(root, 'slot-0');
      mkdirSync(dir, { recursive: true });                     // the winner's mkdir, before its entry write
      const now = Date.now();
      const r = reserve(root, 'slot-0', 'LOSER', now, new Date(now).toISOString());
      expect(r).toEqual({ ok: false, reason: 'initializing', heldBy: null });
      expect(readLockEntry(root, 'slot-0')).toBeNull();        // the winner's dir was left alone
      const old = (Date.now() - ENTRYLESS_LOCK_DIR_GRACE_MS - 5_000) / 1000;
      utimesSync(dir, old, old);                               // …a crash between mkdir and the write
      const r2 = reserve(root, 'slot-0', 'LATE', now, new Date(now).toISOString());
      expect(r2.ok).toBe(true);
      expect(readLockEntry(root, 'slot-0').owner).toBe('LATE');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// #4017 — a stalled owner or reclaimer must never delete or overwrite a replacement owner's live lock.
describe('reclaim never destroys a lock another owner has taken since', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'we-locks-cas-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('a stalled acquirer (mkdir won, entry not yet written) loses to the owner that reclaimed its dir — and leaves that owner\'s lock intact', () => {
    const stalledEntry = makeLockEntry('A', 'p', iso(T0), 100);
    let reclaim;
    const won = acquireLockDir(root, 'p', stalledEntry, {
      afterMkdir: () => {
        // A stalls past the entry-less grace; B reclaims the dir and writes ITS entry first.
        const old = (Date.now() - ENTRYLESS_LOCK_DIR_GRACE_MS - 5_000) / 1000;
        utimesSync(lockDirFor(root, 'p'), old, old);
        reclaim = reserve(root, 'p', 'B', Date.now(), new Date().toISOString(), 200);
      },
    });
    expect(reclaim).toMatchObject({ ok: true, heldBy: 'B' });
    expect(won).toBe(false);                                  // A's exclusive entry write failed: it lost
    expect(readLockEntry(root, 'p').owner).toBe('B');         // B's entry not overwritten…
    expect(existsSync(lockDirFor(root, 'p'))).toBe(true);     // …and B's dir not removed
  });

  it('a stalled acquirer whose dir was reclaimed AWAY (not yet re-taken) also loses without error', () => {
    const won = acquireLockDir(root, 'p', makeLockEntry('A', 'p', iso(T0), 100), {
      afterMkdir: () => rmSync(lockDirFor(root, 'p'), { recursive: true }),
    });
    expect(won).toBe(false);
  });

  it('releaseLockDirIf removes only the entry the caller judged', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100);
    expect(releaseLockDirIf(root, 'p', { owner: 'B' })).toBe(false);                // someone else's: left standing
    expect(readLockEntry(root, 'p').owner).toBe('A');
    expect(releaseLockDirIf(root, 'p', { owner: 'A', heartbeatAt: iso(T0 + 1) })).toBe(false); // refreshed since it was read
    expect(readLockEntry(root, 'p').owner).toBe('A');
    expect(releaseLockDirIf(root, 'p', { owner: 'A', heartbeatAt: iso(T0) })).toBe(true);
    expect(existsSync(lockDirFor(root, 'p'))).toBe(false);
    expect(releaseLockDirIf(root, 'p', { owner: 'A' })).toBe(false);                // already gone
    expect(readdirSync(root)).toEqual([]);                                          // nothing left inside the lock root…
    expect(readdirSync(dirname(root)).filter((n) => n.includes('.gone-'))).toEqual([]); // …and no tombstone beside it
  });

  it('heartbeatOwn refreshes the owner\'s lease without rewriting lock.json, and refuses a lock that is no longer the caller\'s', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100);
    const raw = () => readFileSync(join(lockDirFor(root, 'p'), 'lock.json'), 'utf8');
    const before = raw();
    expect(heartbeatOwn(root, 'p', 'A', iso(T0 + 60_000))).toBe(true);
    expect(readLockEntry(root, 'p').heartbeatAt).toBe(iso(T0 + 60_000));
    expect(raw()).toBe(before);                                                    // the entry itself is immutable
    expect(heartbeatOwn(root, 'p', 'B', iso(T0 + 90_000))).toBe(false);
    expect(readLockEntry(root, 'p').heartbeatAt).toBe(iso(T0 + 60_000));
    releaseLockDir(root, 'p');
    expect(heartbeatOwn(root, 'p', 'A', iso(T0))).toBe(false);                     // gone
  });

  it('a stalled former owner\'s heartbeat file written into a reclaimed dir is inert: it neither revives nor rewrites the new owner\'s lock', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100);
    heartbeatOwn(root, 'p', 'A', iso(T0 + 1000));
    const after = T0 + LEASE_MS + 5000;
    expect(reserve(root, 'p', 'B', after, iso(after), 200)).toMatchObject({ ok: true, reason: 'lease-expired' });
    const bEntry = readFileSync(join(lockDirFor(root, 'p'), 'lock.json'), 'utf8');
    // A woke from its stall just after its owner check passed and writes its heartbeat file into B's dir.
    const aBeat = `hb.${createHash('sha256').update('A').digest('hex').slice(0, 16)}`;
    writeFileSync(join(lockDirFor(root, 'p'), aBeat), iso(after + 1));
    expect(readFileSync(join(lockDirFor(root, 'p'), 'lock.json'), 'utf8')).toBe(bEntry);
    expect(readLockEntry(root, 'p')).toMatchObject({ owner: 'B', heartbeatAt: iso(after) });
  });

  it('reserve reclaim with a refreshed holder: a heartbeatOwn refresh keeps the lease alive', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100);
    const near = T0 + LEASE_MS - 1000;
    heartbeatOwn(root, 'p', 'A', iso(near));
    const r = reserve(root, 'p', 'B', T0 + LEASE_MS + 5000, iso(T0 + LEASE_MS + 5000), 200);
    expect(r).toMatchObject({ ok: false, reason: 'held', heldBy: 'A' });
  });

  it('reserve: a reclaimer that read the SAME stale entry as a faster reclaimer leaves the faster one\'s lock standing', () => {
    reserve(root, 'p', 'A', T0, iso(T0), 100);                // A: stale holder both reclaimers read
    // The probe runs right after B reads A's entry and before B removes it: C (faster) reclaims A and takes the lock.
    const probe = () => {
      releaseLockDir(root, 'p');
      reserve(root, 'p', 'C', T0 + LEASE_MS + 2, iso(T0 + LEASE_MS + 2), 300);
      return 'dead';                                          // B's verdict on A: reclaimable
    };
    const r = reserve(root, 'p', 'B', T0 + LEASE_MS + 1, iso(T0 + LEASE_MS + 1), 200, probe);
    expect(r).toMatchObject({ ok: false, reason: 'held', heldBy: 'C' });
    expect(readLockEntry(root, 'p').owner).toBe('C');         // C's live lock was NOT deleted by B
  });
});

/**
 * @file scripts/readiness/__tests__/drain-lock.test.mjs
 * @description Unit proof of the drain's DUAL-LOCK guard (#2391) — the numbering-critical-section MUTEX and
 *   the whole-process drain LEASE, both built on the file-locks atomic-dir + TTL-lease primitive. Drives the
 *   thin drain-specific wiring against a REAL temp lock root (never the machine-global home dir), with an
 *   injected clock so the TTL/heartbeat paths are exercised deterministically. Covers the three item proofs:
 *   concurrent lands serialize with no duplicate NNN; a second drain launch no-ops on a held lease; a stale
 *   lease is reclaimable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { readLockEntry } from '../file-locks.mjs';
import {
  NUMBERING_LOCK_PATH, DRAIN_LEASE_PATH,
  makeOwner, tryAcquireNumberingLock, releaseNumberingLockIfOwned, withNumberingLock, withLandWriteLock,
  acquireDrainLease, heartbeatDrainLease, releaseDrainLease, drainLeaseStatus,
  drainLeasePathFor, localRepoSlug,
  POC_LAND_LOCK_PATH, pocLandLockPathFor, withPocLandLock,
} from '../drain-lock.mjs';

const T0 = Date.parse('2026-07-10T12:00:00.000Z');
const MIN = 60_000;

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'drain-lock-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('numbering-critical-section mutex — sole-serial-writer (#2391)', () => {
  it('BLOCKS a second entrant while the first holds the section (no interleaved number+publish) — DEFAULT keeps the never-hang fallback for backward compat', () => {
    // Land A holds the mutex, its lease fresh.
    expect(tryAcquireNumberingLock(root, 'A', { nowMs: T0, leaseMinutes: 5 }).ok).toBe(true);
    // Land B tries the wrapped section with a bounded wait; a fake clock advances per poll but never reaches
    // A's 5-min lease, so B can NEVER acquire while A holds it.
    let clock = T0;
    const now = () => clock;
    const sleep = () => { clock += 100; };
    let ran = 0;
    const r = withNumberingLock(() => { ran++; return 'B'; }, { lockRoot: root, owner: 'B', waitMs: 1000, pollMs: 100, leaseMinutes: 5, now, sleep });
    expect(r.held).toBe(false);       // B never seized the lock while A held it → mutual exclusion
    expect(r.heldBy).toBe('A');
    expect(r.contended).toBe(true);   // blocked past the budget → fell through un-locked rather than HANG
    // `runUnlockedOnContention` still DEFAULTS true (xuqk1vp: unchanged, for the out-of-scope call sites that
    // still read `.result` unconditionally) — fn runs, ran:true.
    expect(r.ran).toBe(true);
    expect(ran).toBe(1);              // the land never wedges: fn still ran (the never-hang fallback)
    // A still owns the lock (B's fallback never stomped it).
    expect(readLockEntry(root, NUMBERING_LOCK_PATH).owner).toBe('A');
  });

  it('opt-in `runUnlockedOnContention:false` (xuqk1vp) NEVER runs fn unlocked — the contract lane-drain.mjs uses', () => {
    expect(tryAcquireNumberingLock(root, 'A', { nowMs: T0, leaseMinutes: 5 }).ok).toBe(true);
    let clock = T0;
    const now = () => clock;
    const sleep = () => { clock += 100; };
    let ran = 0;
    const r = withNumberingLock(() => { ran++; return 'B'; }, {
      lockRoot: root, owner: 'B', waitMs: 1000, pollMs: 100, leaseMinutes: 5, now, sleep, runUnlockedOnContention: false,
    });
    expect(r).toMatchObject({ ran: false, held: false, contended: true, result: undefined, heldBy: 'A' });
    expect(ran).toBe(0); // fn never invoked — no second writer touched main
    expect(readLockEntry(root, NUMBERING_LOCK_PATH).owner).toBe('A'); // never stomped
  });

  it('a LIVE holder that heartbeats mid-section is NEVER reclaimed by the TTL alone (xuqk1vp)', () => {
    let clock = T0;
    const now = () => clock;
    // A holds the lock and, INSIDE its own section, heartbeats once past what would otherwise be the 5-min
    // TTL — simulating a genuinely long-running (but alive) numbering pass. A second acquire attempt AFTER
    // that heartbeat, at a clock that is stale relative to the ORIGINAL acquire but fresh relative to the
    // heartbeat, must still see A as live and refuse to reclaim.
    const r = withNumberingLock((heartbeat) => {
      clock = T0 + 6 * MIN; // would be lease-expired vs the ORIGINAL acquire timestamp
      heartbeat();          // refresh — A's heartbeatAt is now T0+6min
      // A second, concurrent acquire attempt right after the heartbeat sees a FRESH heartbeat, not a stale one.
      const second = tryAcquireNumberingLock(root, 'B', { nowMs: clock, leaseMinutes: 5 });
      expect(second.ok).toBe(false); // NOT reclaimed — A's heartbeat is fresh as of `clock`
      expect(second.reason).toBe('held');
      return 'done';
    }, { lockRoot: root, owner: 'A', leaseMinutes: 5, now });
    expect(r).toMatchObject({ ran: true, held: true, result: 'done' });
    expect(readLockEntry(root, NUMBERING_LOCK_PATH)).toBeNull(); // released after the section
  });

  it('once the holder releases, the next entrant acquires and runs INSIDE the lock, then frees it', () => {
    tryAcquireNumberingLock(root, 'A', { nowMs: T0 });
    releaseNumberingLockIfOwned(root, 'A');
    const r = withNumberingLock(() => 42, { lockRoot: root, owner: 'B', now: () => T0 });
    expect(r).toMatchObject({ held: true, contended: false, result: 42 });
    expect(readLockEntry(root, NUMBERING_LOCK_PATH)).toBeNull(); // released after the section
  });

  it('two mutex-guarded lands assign DISTINCT NNNs — never a duplicate number', () => {
    let maxNum = 100;
    const numberStep = () => ++maxNum; // the number step the mutex serializes: max+1
    const r1 = withNumberingLock(() => numberStep(), { lockRoot: root, owner: 'L1', now: () => T0 });
    const r2 = withNumberingLock(() => numberStep(), { lockRoot: root, owner: 'L2', now: () => T0 });
    expect(r1.result).toBe(101);
    expect(r2.result).toBe(102);      // distinct — serialization means L2 sees L1's increment
    expect(r1.held && r2.held).toBe(true);
  });

  it('a PROVABLY-DEAD same-host holder is reclaimed IMMEDIATELY, ignoring the 5-min TTL (xuqk1vp pid-dead fast path)', () => {
    const deadPid = 999999; // kill(pid,0) throws ESRCH — cannot exist
    const owner = `${hostname()}:${deadPid}:numbering`;
    expect(tryAcquireNumberingLock(root, owner, { nowMs: T0, pid: deadPid, leaseMinutes: 5 }).ok).toBe(true);
    // ONE millisecond later — nowhere near the 5-min TTL — a fresh acquirer still reclaims, because the
    // holder's pid is provably gone. Before xuqk1vp, `tryAcquireNumberingLock` always passed `pidLiveness:
    // 'unknown'`, so this reclaim would have to wait out the full 5-min lease instead.
    const r = tryAcquireNumberingLock(root, 'B', { nowMs: T0 + 1, leaseMinutes: 5 });
    expect(r).toMatchObject({ ok: true, reason: 'pid-dead', heldBy: 'B' }); // `heldBy` names the NEW winner (reserve()'s convention)
  });

  it('a LIVE same-host holder (a real pid) is NEVER reclaimed early just because its owner STRING looks stale-able', () => {
    const owner = `${hostname()}:${process.ppid}:numbering`; // the test runner's own parent — real, alive, not us
    expect(tryAcquireNumberingLock(root, owner, { nowMs: T0, pid: process.ppid, leaseMinutes: 5 }).ok).toBe(true);
    const r = tryAcquireNumberingLock(root, 'B', { nowMs: T0 + 1, leaseMinutes: 5 }); // 1ms later — TTL nowhere close
    expect(r).toMatchObject({ ok: false, reason: 'held', heldBy: owner }); // alive ⇒ blocked, not reclaimed
  });

  it('a foreign-host owner is NEVER pid-probed locally — only the TTL floor can reclaim it', () => {
    const foreignOwner = 'some-other-mac.local:1:numbering';
    expect(tryAcquireNumberingLock(root, foreignOwner, { nowMs: T0, pid: 1, leaseMinutes: 5 }).ok).toBe(true);
    // pid 1 (init/launchd) is very likely "alive" on THIS host too, which is exactly the hazard: reclaim must
    // not even attempt the local kill(pid,0) probe for a differently-hosted owner. 1ms later it is still held.
    const soon = tryAcquireNumberingLock(root, 'B', { nowMs: T0 + 1, leaseMinutes: 5 });
    expect(soon).toMatchObject({ ok: false, reason: 'held', heldBy: foreignOwner });
    // Only the TTL floor reclaims a foreign-host owner — 6 minutes later (past the 5-min lease) it frees up.
    const later = tryAcquireNumberingLock(root, 'B', { nowMs: T0 + 6 * MIN, leaseMinutes: 5 });
    expect(later).toMatchObject({ ok: true, reason: 'lease-expired', heldBy: 'B' }); // `heldBy` names the NEW winner
  });

  it('a STALE numbering lock (a crashed holder) is reclaimed via the TTL — the section never wedges', () => {
    tryAcquireNumberingLock(root, 'DEAD', { nowMs: T0, leaseMinutes: 5 });
    const later = T0 + 6 * MIN; // heartbeat now 6 min old vs a 5-min lease → reclaimable
    const r = withNumberingLock(() => 'ok', { lockRoot: root, owner: 'FRESH', leaseMinutes: 5, now: () => later });
    expect(r).toMatchObject({ held: true, reason: 'lease-expired', result: 'ok' });
  });

  it('a heartbeat AFTER the lock was reclaimed away is a no-op — it never re-seats the stale holder over the reclaimer (review #2668)', () => {
    let clock = T0;
    let reclaim = null;
    let lateBeat = null;
    withNumberingLock((heartbeat) => {
      // A's section stalls past its 5-min lease without heartbeating; B legitimately reclaims via the TTL.
      clock = T0 + 6 * MIN;
      reclaim = tryAcquireNumberingLock(root, 'B', { nowMs: clock, leaseMinutes: 5 });
      // A then heartbeats — an ordinary mid-section call. It must NOT overwrite B's entry.
      lateBeat = heartbeat();
    }, { lockRoot: root, owner: 'A', leaseMinutes: 5, now: () => clock });
    expect(reclaim).toMatchObject({ ok: true, reason: 'lease-expired' });
    expect(lateBeat).toBe(false);
    expect(readLockEntry(root, NUMBERING_LOCK_PATH).owner).toBe('B'); // B still owns it; A's release skipped too
  });

  it('releaseNumberingLockIfOwned never stomps a reclaimer that seized the section', () => {
    tryAcquireNumberingLock(root, 'A', { nowMs: T0, leaseMinutes: 5 });
    tryAcquireNumberingLock(root, 'B', { nowMs: T0 + 6 * MIN, leaseMinutes: 5 }); // B reclaims A's stale lock
    expect(releaseNumberingLockIfOwned(root, 'A')).toBe(false);                    // A's late release is a no-op
    expect(readLockEntry(root, NUMBERING_LOCK_PATH).owner).toBe('B');              // B's lock intact
  });
});

describe('withLandWriteLock — the merge write shares the serial-writer mutex (#2683)', () => {
  it('a merge write BLOCKS while a numbering section holds the SAME lock key (mutual exclusion across the two) — DEFAULT unchanged', () => {
    // A numbering land holds the mutex; a concurrent merge write must NOT proceed under the lock — they share
    // NUMBERING_LOCK_PATH, so the merge is what a --only fast drain serializes against a resident-daemon sweep.
    expect(tryAcquireNumberingLock(root, 'NUMBERING', { nowMs: T0, leaseMinutes: 5 }).ok).toBe(true);
    let clock = T0;
    const r = withLandWriteLock(() => 'merged', { lockRoot: root, waitMs: 500, pollMs: 100, leaseMinutes: 5, now: () => clock, sleep: () => { clock += 100; } });
    expect(r.held).toBe(false);        // never seized while numbering held it
    expect(r.heldBy).toBe('NUMBERING');
    expect(r.contended).toBe(true);    // never-hang fallback (default unchanged) — the merge still ran (fn), the idempotency guard is the backstop
    expect(r.ran).toBe(true);
    expect(r.result).toBe('merged');
    expect(readLockEntry(root, NUMBERING_LOCK_PATH).owner).toBe('NUMBERING'); // the fallback never stomped the holder
  });

  it('opt-in `runUnlockedOnContention:false` (xuqk1vp) is available to a merge-write caller that wants the strict contract too', () => {
    expect(tryAcquireNumberingLock(root, 'NUMBERING', { nowMs: T0, leaseMinutes: 5 }).ok).toBe(true);
    let clock = T0;
    let ran = false;
    const r = withLandWriteLock(() => { ran = true; return 'merged'; }, {
      lockRoot: root, waitMs: 500, pollMs: 100, leaseMinutes: 5, now: () => clock, sleep: () => { clock += 100; }, runUnlockedOnContention: false,
    });
    expect(r).toMatchObject({ ran: false, held: false, contended: true, result: undefined, heldBy: 'NUMBERING' });
    expect(ran).toBe(false);
    expect(readLockEntry(root, NUMBERING_LOCK_PATH).owner).toBe('NUMBERING');
  });

  it('two merge writes serialize on the shared key and release after each section', () => {
    const r1 = withLandWriteLock(() => 'A', { lockRoot: root, now: () => T0 });
    expect(r1).toMatchObject({ held: true, contended: false, result: 'A' });
    expect(readLockEntry(root, NUMBERING_LOCK_PATH)).toBeNull(); // released → the next writer can acquire
    const r2 = withLandWriteLock(() => 'B', { lockRoot: root, now: () => T0 });
    expect(r2).toMatchObject({ held: true, result: 'B' });
  });

  it('tags the owner "land" (diagnostics) while sharing the numbering lock key for exclusion', () => {
    let seenOwner = null;
    withLandWriteLock(() => { seenOwner = readLockEntry(root, NUMBERING_LOCK_PATH)?.owner; }, { lockRoot: root, now: () => T0 });
    expect(seenOwner).toMatch(/:land$/); // makeOwner('land')
  });
});

describe('whole-process drain lease — one drain at a time (#2391)', () => {
  it('a second drain launch NO-OPS on a live lease', () => {
    expect(acquireDrainLease(root, 'drainA', { nowMs: T0, leaseMinutes: 15 }).ok).toBe(true);
    const b = acquireDrainLease(root, 'drainB', { nowMs: T0 + MIN, leaseMinutes: 15 });
    expect(b).toMatchObject({ ok: false, reason: 'held', heldBy: 'drainA' });
    expect(drainLeaseStatus(root, { nowMs: T0 + MIN, leaseMinutes: 15 })).toMatchObject({ held: true, stale: false, owner: 'drainA' });
  });

  it('a STALE lease (a crashed drain) is reclaimable', () => {
    acquireDrainLease(root, 'drainA', { nowMs: T0, leaseMinutes: 15 });
    const stale = T0 + 16 * MIN; // heartbeat 16 min old vs a 15-min lease
    expect(drainLeaseStatus(root, { nowMs: stale, leaseMinutes: 15 })).toMatchObject({ held: false, stale: true, owner: 'drainA' });
    expect(acquireDrainLease(root, 'drainB', { nowMs: stale, leaseMinutes: 15 }).ok).toBe(true); // reclaimed via TTL
    expect(drainLeaseStatus(root, { nowMs: stale, leaseMinutes: 15 }).owner).toBe('drainB');
  });

  it('a heartbeat keeps a running drain live (not reclaimed under it)', () => {
    acquireDrainLease(root, 'drainA', { nowMs: T0, leaseMinutes: 15 });
    expect(heartbeatDrainLease(root, 'drainA', { nowMs: T0 + 14 * MIN })).toBe(true); // refresh before the TTL
    expect(drainLeaseStatus(root, { nowMs: T0 + 16 * MIN, leaseMinutes: 15 }).held).toBe(true); // 2 min past the refresh → still live
    // A stranger's heartbeat is a no-op (it does not own the lease).
    expect(heartbeatDrainLease(root, 'stranger', { nowMs: T0 + 14 * MIN })).toBe(false);
  });

  it('release frees the lease only for its owner (never stomps a reclaimer)', () => {
    acquireDrainLease(root, 'drainA', { nowMs: T0, leaseMinutes: 15 });
    acquireDrainLease(root, 'drainB', { nowMs: T0 + 16 * MIN, leaseMinutes: 15 }); // B reclaims after the TTL
    expect(releaseDrainLease(root, 'drainA')).toBe(false);                          // A's stale release is a no-op
    expect(drainLeaseStatus(root, { nowMs: T0 + 16 * MIN, leaseMinutes: 15 }).owner).toBe('drainB');
    expect(releaseDrainLease(root, 'drainB')).toBe(true);                           // B frees its own
    expect(drainLeaseStatus(root).owner).toBeNull();
  });

  it('the mutex and the lease are DISTINCT locks (never alias)', () => {
    tryAcquireNumberingLock(root, 'num', { nowMs: T0 });
    acquireDrainLease(root, 'drain', { nowMs: T0 });
    expect(readLockEntry(root, NUMBERING_LOCK_PATH).owner).toBe('num');
    expect(readLockEntry(root, DRAIN_LEASE_PATH).owner).toBe('drain');
    expect(NUMBERING_LOCK_PATH).not.toBe(DRAIN_LEASE_PATH);
  });

  it('makeOwner is stable per (host,pid,kind) and distinguishes kinds', () => {
    expect(makeOwner('drain')).toBe(makeOwner('drain'));
    expect(makeOwner('drain')).not.toBe(makeOwner('numbering'));
  });
});

describe('drain lease REPO-SCOPE metadata (#2458)', () => {
  it('records the drain repo scope in the lease and surfaces it via drainLeaseStatus (de-duped + sorted)', () => {
    acquireDrainLease(root, 'drainA', { nowMs: T0, scope: ['o/plateau-app', 'o/we', 'o/we'] });
    const st = drainLeaseStatus(root, { nowMs: T0 });
    expect(st.owner).toBe('drainA');
    expect(st.scope).toEqual(['o/plateau-app', 'o/we']); // normalized: unique + sorted
  });

  it('a lease acquired WITHOUT a scope has scope null (legacy/unscoped holder → gate treats as covers-all)', () => {
    acquireDrainLease(root, 'drainA', { nowMs: T0 });
    expect(drainLeaseStatus(root, { nowMs: T0 }).scope).toBeNull();
    expect(readLockEntry(root, DRAIN_LEASE_PATH).meta).toBeUndefined(); // no meta key when there is nothing to record
  });

  it('the recorded scope SURVIVES a heartbeat that supplies no scope (the resident-daemon case)', () => {
    acquireDrainLease(root, 'drainA', { nowMs: T0, scope: ['o/we'] });
    expect(heartbeatDrainLease(root, 'drainA', { nowMs: T0 + 5 * MIN })).toBe(true); // no scope re-supplied
    expect(drainLeaseStatus(root, { nowMs: T0 + 6 * MIN }).scope).toEqual(['o/we']); // preserved, not dropped
  });

  it('a heartbeat MAY refresh the scope when the holder re-supplies it', () => {
    acquireDrainLease(root, 'drainA', { nowMs: T0, scope: ['o/we'] });
    heartbeatDrainLease(root, 'drainA', { nowMs: T0 + 5 * MIN, scope: ['o/we', 'o/frontierui'] });
    expect(drainLeaseStatus(root, { nowMs: T0 + 6 * MIN }).scope).toEqual(['o/frontierui', 'o/we']);
  });

  it('re-acquiring an OWN live lease with no scope carries the recorded scope forward (never silently dropped)', () => {
    acquireDrainLease(root, 'drainA', { nowMs: T0, scope: ['o/we'] });
    expect(acquireDrainLease(root, 'drainA', { nowMs: T0 + MIN }).ok).toBe(true); // own re-acquire (reserve 'own' path), no scope re-supplied
    expect(drainLeaseStatus(root, { nowMs: T0 + 2 * MIN }).scope).toEqual(['o/we']);
  });

  it('reclaiming a STALE foreign lease does NOT inherit the dead holder\'s scope', () => {
    acquireDrainLease(root, 'drainA', { nowMs: T0, scope: ['o/we'] });
    const stale = T0 + 16 * MIN; // past the 15-min TTL
    expect(acquireDrainLease(root, 'drainB', { nowMs: stale }).ok).toBe(true); // B reclaims, supplies no scope
    expect(drainLeaseStatus(root, { nowMs: stale }).scope).toBeNull(); // B's lease is unscoped, not A's old scope
  });
});

describe('drain lease PER-REPO key (#3440 — one project\'s daemon never blocks another\'s)', () => {
  it('drainLeasePathFor: distinct repoKeys ⇒ distinct lock paths; null ⇒ the legacy global sentinel', () => {
    expect(drainLeasePathFor('o/web-everything')).not.toBe(drainLeasePathFor('o/plateau-app'));
    expect(drainLeasePathFor(null)).toBe(DRAIN_LEASE_PATH);
    expect(drainLeasePathFor()).toBe(DRAIN_LEASE_PATH);
    // both repo-keyed paths still derive from (and so remain distinguishable from) the base sentinel
    expect(drainLeasePathFor('o/web-everything')).toContain(DRAIN_LEASE_PATH);
  });

  it('THE CORE PROOF: two DIFFERENT repos\' drain runs hold their OWN leases concurrently on the same machine', () => {
    // Mirrors the #3440 incident: plateau-app's resident daemon (repoKey 'o/plateau-app') holds a live lease
    // while web-everything's own drain (repoKey 'o/web-everything') tries to acquire ITS lease on the SAME
    // lock root (a shared machine-global home, #91's whole point). Before this fix both shared ONE lock dir
    // (repoKey ignored) so the second acquire would have been BLOCKED; now it is NOT.
    expect(acquireDrainLease(root, 'plateau-daemon', { nowMs: T0, repoKey: 'o/plateau-app' }).ok).toBe(true);
    const weAcquire = acquireDrainLease(root, 'we-drain', { nowMs: T0 + MIN, repoKey: 'o/web-everything' });
    expect(weAcquire.ok).toBe(true); // NOT blocked by the other repo's live lease
    // Both leases are independently live, each reporting its OWN owner — proving true concurrency, not a race
    // where the second silently stomped the first.
    expect(drainLeaseStatus(root, { nowMs: T0 + MIN, repoKey: 'o/plateau-app' })).toMatchObject({ held: true, owner: 'plateau-daemon' });
    expect(drainLeaseStatus(root, { nowMs: T0 + MIN, repoKey: 'o/web-everything' })).toMatchObject({ held: true, owner: 'we-drain' });
  });

  it('the SAME repoKey still mutually excludes — the sole-serial-writer invariant is preserved WITHIN one repo', () => {
    expect(acquireDrainLease(root, 'drainA', { nowMs: T0, repoKey: 'o/web-everything' }).ok).toBe(true);
    const second = acquireDrainLease(root, 'drainB', { nowMs: T0 + MIN, repoKey: 'o/web-everything' });
    expect(second).toMatchObject({ ok: false, reason: 'held', heldBy: 'drainA' });
  });

  it('heartbeat and release are scoped by repoKey — they act on THAT repo\'s lease only, never a stranger repo\'s', () => {
    acquireDrainLease(root, 'we-drain', { nowMs: T0, repoKey: 'o/web-everything' });
    acquireDrainLease(root, 'plateau-daemon', { nowMs: T0, repoKey: 'o/plateau-app' });
    // Heartbeating the WE lease never touches plateau-app's, and vice versa.
    expect(heartbeatDrainLease(root, 'we-drain', { nowMs: T0 + MIN, repoKey: 'o/web-everything' })).toBe(true);
    expect(heartbeatDrainLease(root, 'we-drain', { nowMs: T0 + MIN, repoKey: 'o/plateau-app' })).toBe(false); // wrong repo's lease — not owned there
    // Releasing WE's lease leaves plateau-app's fully intact.
    expect(releaseDrainLease(root, 'we-drain', { repoKey: 'o/web-everything' })).toBe(true);
    expect(drainLeaseStatus(root, { nowMs: T0 + MIN, repoKey: 'o/web-everything' }).held).toBe(false);
    expect(drainLeaseStatus(root, { nowMs: T0 + MIN, repoKey: 'o/plateau-app' })).toMatchObject({ held: true, owner: 'plateau-daemon' });
  });

  it('a repoKey-scoped lease is invisible to a legacy (repoKey-less) status read — distinct lock dirs, not a filter', () => {
    acquireDrainLease(root, 'we-drain', { nowMs: T0, repoKey: 'o/web-everything' });
    expect(drainLeaseStatus(root, { nowMs: T0 }).held).toBe(false); // the legacy global path never saw this acquire
    acquireDrainLease(root, 'legacy-drain', { nowMs: T0 });
    expect(drainLeaseStatus(root, { nowMs: T0 }).owner).toBe('legacy-drain');
    expect(drainLeaseStatus(root, { nowMs: T0, repoKey: 'o/web-everything' }).owner).toBe('we-drain'); // untouched
  });

  describe('localRepoSlug — the invoking checkout\'s own repo identity, parsed from `git remote get-url origin`', () => {
    it('parses an https origin URL to an org/repo slug', () => {
      const exec = () => 'https://github.com/web-everything/web-everything.git\n';
      expect(localRepoSlug({ exec })).toBe('web-everything/web-everything');
    });
    it('parses an ssh origin URL (no .git suffix) the same way', () => {
      const exec = () => 'git@github.com:plateauapp/plateau-app\n';
      expect(localRepoSlug({ exec })).toBe('plateauapp/plateau-app');
    });
    it('returns null when git/origin is unavailable (no remote, detached, not a repo) — never throws', () => {
      const exec = () => { throw new Error('fatal: not a git repository'); };
      expect(localRepoSlug({ exec })).toBeNull();
    });
    it('threads `cwd` through to the git call, so it reads the RIGHT checkout\'s origin', () => {
      let seenCwd = null;
      const exec = (_cmd, _args, opts) => { seenCwd = opts.cwd; return 'https://github.com/o/r.git'; };
      localRepoSlug({ cwd: '/some/checkout', exec });
      expect(seenCwd).toBe('/some/checkout');
    });
  });
});


// ── #3637 — the PER-POC-BRANCH land lock ────────────────────────────────────────────────────────────────────

describe('#3637 — the per-POC-branch land lock', () => {
  it('keys a distinct lock dir per branch AND per repo, and never aliases the drain\'s own two locks', () => {
    expect(pocLandLockPathFor('lane/a', 'org/repo')).not.toBe(pocLandLockPathFor('lane/b', 'org/repo'));
    expect(pocLandLockPathFor('lane/a', 'org/one')).not.toBe(pocLandLockPathFor('lane/a', 'org/two'));
    expect(pocLandLockPathFor('lane/a')).toContain(POC_LAND_LOCK_PATH);
    expect(pocLandLockPathFor('lane/a')).not.toBe(NUMBERING_LOCK_PATH);
    expect(pocLandLockPathFor('lane/a')).not.toBe(DRAIN_LEASE_PATH);
  });

  it('treats `origin/x` and `x` as the SAME branch, so two spellings never split the lock', () => {
    expect(pocLandLockPathFor('origin/lane/a', 'org/repo')).toBe(pocLandLockPathFor('lane/a', 'org/repo'));
  });

  it('refuses a nameless branch rather than locking a key that means nothing', () => {
    expect(() => pocLandLockPathFor('')).toThrow(/needs a branch name/);
    expect(() => pocLandLockPathFor(null)).toThrow(/needs a branch name/);
  });

  it('does NOT degrade to running unlocked on contention — the one contract difference from withLandWriteLock', () => {
    const owner = makeOwner('poc-land');
    // A foreign holder, live.
    // A LIVE foreign holder: stamped at the real clock, since withPocLandLock reads the real one and would
    // otherwise reclaim a T0-dated lease as long expired.
    tryAcquireNumberingLock(root, 'someone:else:poc-land', { lockPath: pocLandLockPathFor('lane/a', 'org/repo'), nowMs: Date.now() });
    let ran = false;
    const out = withPocLandLock(() => { ran = true; return 'wrote'; }, {
      branch: 'lane/a', repoKey: 'org/repo', lockRoot: root, waitMs: 0, sleep: () => {}, owner,
    });
    expect(ran).toBe(false);
    expect(out).toMatchObject({ ran: false, held: false, contended: true, result: undefined });
  });

  it('withNumberingLock KEEPS its never-hang fallback BY DEFAULT — #2288/#2683 behaviour unchanged for out-of-scope callers', () => {
    tryAcquireNumberingLock(root, 'someone:else:numbering', { nowMs: T0 });
    // `now: () => T0` below keeps the holder live from withNumberingLock's point of view.
    let ran = false;
    const out = withNumberingLock(() => { ran = true; return 'numbered'; }, {
      lockRoot: root, owner: makeOwner('numbering'), waitMs: 0, sleep: () => {}, now: () => T0,
    });
    expect(ran).toBe(true);
    expect(out).toMatchObject({ ran: true, held: false, contended: true, result: 'numbered' });
  });

  it('RELEASES the branch lock afterwards, so the next lander gets in', () => {
    const first = withPocLandLock(() => 'a', { branch: 'lane/a', repoKey: 'org/repo', lockRoot: root, sleep: () => {} });
    expect(first).toMatchObject({ ran: true, held: true });
    expect(readLockEntry(root, pocLandLockPathFor('lane/a', 'org/repo'))).toBeNull();
    const second = withPocLandLock(() => 'b', { branch: 'lane/a', repoKey: 'org/repo', lockRoot: root, waitMs: 0, sleep: () => {}, owner: makeOwner('poc-land-2') });
    expect(second).toMatchObject({ ran: true, held: true, result: 'b' });
  });

  it('releases the branch lock even when the landing THROWS — a crash never wedges the branch', () => {
    expect(() => withPocLandLock(() => { throw new Error('boom'); }, { branch: 'lane/a', repoKey: 'org/repo', lockRoot: root, sleep: () => {} })).toThrow(/boom/);
    expect(readLockEntry(root, pocLandLockPathFor('lane/a', 'org/repo'))).toBeNull();
  });
});

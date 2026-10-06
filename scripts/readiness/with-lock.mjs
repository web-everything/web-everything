/**
 * @file scripts/readiness/with-lock.mjs
 * @description Blocking `withLock(fn)` over the repo's lock primitive ({@link ./file-locks.mjs}) — for a SYNC
 *   read-modify-write that must not interleave with another process's (the free-scope registry, the held-cards
 *   list and its filing run). It adds no lock logic of its own: acquisition, heartbeat-TTL lease, the dead-owner
 *   fast path and compare-and-remove reclaim all live in `file-locks.mjs`; this only loops `reserve` until it wins
 *   or the wait runs out, hands the holder a `touch()` that refreshes the lease, and releases ONLY a lock that is
 *   still the holder's.
 *
 *   A holder that outlives its lease (stalled, or a long run that never touched) can be reclaimed by a waiter.
 *   It then learns of the loss — `touch()` and the exit both throw `ELOCKLOST` — and never removes the
 *   replacement owner's live lock (the release is {@link releaseLockDirIf}, owner-checked).
 */
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { reserve, heartbeatOwn, releaseLockDirIf } from './file-locks.mjs';
import { sleepSyncMs } from './drain-lock.mjs';

/** Default wait for a contended lock — generous for a short read-modify-write, never meant to cover a hung holder. */
export const LOCK_TIMEOUT_MS_DEFAULT = 5000;
/** Default lease: a holder that has not touched for this long is reclaimable. A crashed holder on THIS host is
 *  reclaimed at once by the dead-pid fast path; the lease is the floor for everything else. */
export const LOCK_LEASE_MINUTES_DEFAULT = 0.5;
const LOCK_POLL_MS_DEFAULT = 25;

/** Where the lock dirs for files in `file`'s directory live. */
export const lockRootFor = (file) => path.join(path.dirname(path.resolve(file)), '.file-locks');

/** One owner id per acquisition (`host:pid:nonce`), so two acquisitions in one process never share an "own" slot. */
const newOwner = (pid) => `${os.hostname()}:${pid}:${randomBytes(8).toString('hex')}`;

/** `dead` ONLY on a proven ESRCH for a same-host owner; anything else is `unknown` (the lease decides). */
export function probeOwnerLiveness(entry) {
  const m = /^(.*):(\d+):[0-9a-f]+$/.exec(entry?.owner ?? '');
  if (!m || m[1] !== os.hostname()) return 'unknown';
  const pid = Number(m[2]);
  if (pid === process.pid) return 'alive';
  try { process.kill(pid, 0); return 'alive'; } catch (error) { return error?.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

/**
 * Run `fn({ touch })` while holding the lock for `key` under `lockRoot`. `touch()` refreshes the lease and throws
 * `ELOCKLOST` if the lock is no longer this holder's. A wait that times out throws `ELOCKTIMEOUT`.
 * @param {string} lockRoot
 * @param {string} key  what is locked (a path); same key ⇒ same lock
 * @param {(handle: { touch: () => void }) => any} fn  synchronous
 * @param {{ timeoutMs?: number, leaseMinutes?: number, pollMs?: number, pid?: number, now?: () => number, sleep?: (ms: number) => void }} [options]
 */
export function withLock(lockRoot, key, fn, { timeoutMs = LOCK_TIMEOUT_MS_DEFAULT, leaseMinutes = LOCK_LEASE_MINUTES_DEFAULT,
  pollMs = LOCK_POLL_MS_DEFAULT, pid = process.pid, now = Date.now, sleep = sleepSyncMs } = {}) {
  const owner = newOwner(pid), deadline = now() + timeoutMs;
  const lost = () => Object.assign(new Error(`file-lock: lost ${key}`), { code: 'ELOCKLOST' });
  for (;;) {
    const t = now();
    const result = reserve(lockRoot, key, owner, t, new Date(t).toISOString(), pid, probeOwnerLiveness, leaseMinutes);
    if (result.ok) break;
    if (now() >= deadline) {
      throw Object.assign(new Error(`file-lock: timed out acquiring ${key}${result.heldBy ? ` (held by ${result.heldBy})` : ''}`), { code: 'ELOCKTIMEOUT' });
    }
    sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  // Refresh only OUR lock: refreshing one another owner has since taken would keep THEIR lease alive for us.
  // `heartbeatOwn` never rewrites the entry, so a stalled former holder waking here cannot clobber the new owner's.
  // (Inherent limit: a touch-then-write is not fenced — a holder stalled BETWEEN them can still write before it
  // learns, via ELOCKLOST on its next touch or exit, that it was reclaimed.)
  const touch = () => { if (!heartbeatOwn(lockRoot, key, owner, new Date(now()).toISOString())) throw lost(); };
  let result, failure, failed = false;
  try { result = fn({ touch }); } catch (error) { failed = true; failure = error; }
  // Owner-checked removal: a holder reclaimed meanwhile leaves the new owner's lock standing, and learns of the loss
  // on the way out rather than returning success over a commit that may have raced. An error from `fn` stays the one reported.
  const released = releaseLockDirIf(lockRoot, key, { owner });
  if (failed) throw failure;
  if (!released) throw lost();
  return result;
}

/** {@link withLock} for a read-modify-write of `file`: the lock lives in `<dir of file>/.file-locks`, keyed by `file`. */
export const withPathLock = (file, fn, options) => withLock(lockRootFor(file), path.resolve(file), fn, options);

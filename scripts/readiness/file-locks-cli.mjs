#!/usr/bin/env node
/**
 * @file scripts/readiness/file-locks-cli.mjs
 * @description Shell entry for the mandatory write-time file-lock layer (#1945 — the #1935 Fork-2 /
 *   #1936 pessimistic tier). The thin IMPURE boundary the parallel-batch lanes call to RESERVE a
 *   merge-risk path before editing it (and release it after). Owns the fs root, the clock, and the
 *   same-machine PID-liveness probe; all the DECISION logic lives in the pure {@link ./file-locks.mjs}
 *   (proved by `scripts/readiness/__tests__/file-locks.test.mjs`).
 *
 * Lock home: `<central-checkout>/.claude/locks/<path-hash>/lock.json` — LOCAL, never committed/pushed
 * (the #1936 Fork-1a local home that sidesteps O_EXCL-on-NFS unreliability). Lanes run this in their WE
 * clone but point `--root` at the CENTRAL checkout's lock dir so all lanes share one lock authority.
 *
 * Usage (exit 0 = success/acquired; exit 3 = BLOCKED, a live owner holds it → caller waits/defers;
 * exit 1 = bad args/error):
 *   reserve  --owner=<session> --root=<abs .claude/locks> --pid=<n> <path…>   # acquire-or-reclaim each path
 *   release  --owner=<session> --root=<abs .claude/locks> <path…>             # free paths this owner holds
 *   heartbeat --owner=<session> --root=<abs .claude/locks> --pid=<n> <path…>  # refresh leases (keep-alive)
 *   fence    --owner=<session> --root=<abs .claude/locks> <path…>             # broker: did any lease get reclaimed?
 *   status   --root=<abs .claude/locks> <path…>                              # print each path's current holder
 * Emits a JSON line on stdout for the caller to parse.
 */
import {
  reserve, releaseLockDir, heartbeat, readLockEntry, wasReclaimed, DEFAULT_LEASE_MINUTES,
} from './file-locks.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
import { probePidLiveness } from './pid-liveness.mjs';

function parseArgs(argv) {
  const opts = { paths: [], pid: null };
  for (const a of argv) {
    if (a.startsWith('--owner=')) opts.owner = a.slice('--owner='.length);
    else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length);
    else if (a.startsWith('--pid=')) { const n = Number(a.slice('--pid='.length)); opts.pid = Number.isInteger(n) ? n : null; }
    else if (a.startsWith('--lease=')) { const n = Number(a.slice('--lease='.length)); if (Number.isFinite(n) && n > 0) opts.lease = n; }
    else if (!a.startsWith('--')) opts.paths.push(a);
  }
  return opts;
}

/**
 * Same-machine PID-liveness verdict (#1936 Fork-2 (b), layered NEVER primary because of PID reuse).
 * Returns 'dead' | 'alive' | 'unknown'. `kill(pid, 0)` throws ESRCH when no such process → provably gone
 * ('dead'); Linux zombie/dead states also prove death. Otherwise a process with that PID exists,
 * but the kernel REUSES PIDs so we cannot prove it's
 * the SAME owner — report 'alive' (do NOT accelerate; fall through to the TTL floor). A null/own pid, or
 * any other errno (e.g. EPERM), is 'unknown' (TTL-only). The pure reclaimDecision only fast-paths 'dead'.
 */

function emit(obj) { writeAllSync(1, JSON.stringify(obj) + '\n'); }

const [, , cmd, ...rest] = process.argv;
const o = parseArgs(rest);
const lease = o.lease || DEFAULT_LEASE_MINUTES;

if (!cmd || !o.root) {
  emit({ ok: false, error: 'usage: <reserve|release|heartbeat|fence|status> --owner=<s> --root=<abs .claude/locks> [--pid=n] <path…>' });
  process.exit(1);
}
const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
const selfPid = process.pid;

try {
  if (cmd === 'reserve') {
    if (!o.owner) { emit({ ok: false, error: 'reserve needs --owner' }); process.exit(1); }
    const acquired = [], blocked = [];
    for (const path of o.paths) {
      // Probe the CURRENT holder's liveness so a provably-dead owner is reclaimed without waiting the lease.
      const cur = readLockEntry(o.root, path);
      const liveness = cur && cur.owner !== o.owner ? probePidLiveness(cur.pid, selfPid) : 'unknown';
      const r = reserve(o.root, path, o.owner, nowMs, nowIso, o.pid, liveness, lease);
      (r.ok ? acquired : blocked).push({ path, reason: r.reason, heldBy: r.heldBy });
    }
    const ok = blocked.length === 0;
    emit({ ok, acquired, blocked });
    process.exit(ok ? 0 : 3); // 3 = a live owner holds a path → caller WAITS or DEFERS this item
  }

  if (cmd === 'release') {
    if (!o.owner) { emit({ ok: false, error: 'release needs --owner' }); process.exit(1); }
    const released = [], skipped = [];
    for (const path of o.paths) {
      const cur = readLockEntry(o.root, path);
      // Only release a lock this owner actually holds — never stomp a path reclaimed away mid-flight.
      if (!cur || cur.owner === o.owner) { releaseLockDir(o.root, path); released.push(path); }
      else skipped.push({ path, heldBy: cur.owner });
    }
    emit({ ok: true, released, skipped });
    process.exit(0);
  }

  if (cmd === 'heartbeat') {
    if (!o.owner) { emit({ ok: false, error: 'heartbeat needs --owner' }); process.exit(1); }
    const refreshed = [], lost = [];
    for (const path of o.paths) {
      const cur = readLockEntry(o.root, path);
      if (cur && cur.owner === o.owner) { heartbeat(o.root, path, o.owner, nowIso, o.pid); refreshed.push(path); }
      else lost.push({ path, heldBy: cur ? cur.owner : null }); // reclaimed under us — broker will fence the push
    }
    emit({ ok: lost.length === 0, refreshed, lost });
    process.exit(0);
  }

  if (cmd === 'fence') {
    // The broker fencing point (#1936 insurance invariant): reject a lane's push if ANY reserved path's
    // lease was reclaimed mid-flight (now owned by someone else, or freed). The lane runs this in its WE
    // clone right before pushing; a non-empty `reclaimed` ⇒ DO NOT PUSH (carry the item, re-attempt later).
    if (!o.owner) { emit({ ok: false, error: 'fence needs --owner' }); process.exit(1); }
    const reclaimed = [];
    for (const path of o.paths) {
      const cur = readLockEntry(o.root, path);
      if (wasReclaimed(cur, o.owner)) reclaimed.push({ path, heldBy: cur ? cur.owner : null });
    }
    const ok = reclaimed.length === 0;
    emit({ ok, reclaimed });
    process.exit(ok ? 0 : 3); // 3 = lease reclaimed mid-flight → the push must be rejected
  }

  if (cmd === 'status') {
    emit({ ok: true, held: o.paths.map((path) => ({ path, entry: readLockEntry(o.root, path) })) });
    process.exit(0);
  }

  emit({ ok: false, error: `unknown command: ${cmd}` });
  process.exit(1);
} catch (e) {
  emit({ ok: false, error: String(e && e.message || e) });
  process.exit(1);
}

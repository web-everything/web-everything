/**
 * @file lane-lease-heartbeat.mjs (RS-7179-1) — keep a lane's `.lane-lease` fresh while a long job runs in it.
 *
 * A Codex run (or a gate it waits on) can outlive the lane's 240-minute lease; the lane is then reclaimed and
 * reset under the worker. A holder that is still working renews (`renewedLease`, `lane-lease.mjs`). This module
 * is the timer around that renewal. Fail-closed rules (merge-path checklist 4 and 7):
 *   - no lease file, an unreadable or torn lease, or a non-object: NOTHING is written (never create a lease);
 *   - capture requires the caller's session or holder; the captured lease fixes the owner
 *     (`session` + `holder` + `acquiredAt`); a lease now held by someone else is never extended;
 *   - writes are atomic temp+rename; any error is swallowed (best-effort, never fails the job).
 * IO is injected (`fs`, `now`, `leaseDirFn`) so tests need no real lane.
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LEASE_FILENAME, renewedLease, isLeaseStale } from './lane-lease.mjs';
import { withLaneLeaseMutation } from './lane-lease-lock.mjs';

export const DEFAULT_LEASE_HEARTBEAT_MS = 10 * 60_000;

/** The git dir of the checkout holding `cwd` (a `.git` directory, or a `gitdir:` pointer file), no child process. */
const defaultLeaseDir = (cwd) => {
  try {
    let dir = resolve(cwd);
    for (let i = 0; i < 64; i += 1) {
      const dot = join(dir, '.git');
      if (existsSync(dot)) {
        if (statSync(dot).isDirectory()) return dot;
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'));
        return m ? resolve(dir, m[1].trim()) : null;
      }
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
    return null;
  } catch { return null; }
};

const ownerKey = (lease) => `${lease?.session ?? ''}|${lease?.holder ?? ''}|${lease?.acquiredAt ?? ''}`;

const belongsToCaller = (lease, { session, holder }) =>
  (!!holder && (lease.holder === holder || lease.session === holder)) ||
  (!!session && (lease.workerSession || lease.ownerSession || lease.session) === session);

/** A lease with credentials: a session, an acquire time, and (when present) a numeric ttl. Anything else is no lease. */
function readLease(file, fs) {
  try {
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!lease || typeof lease !== 'object' || Array.isArray(lease)) return null;
    if (typeof lease.session !== 'string' || !lease.session || Number.isNaN(Date.parse(lease.acquiredAt))) return null;
    if (lease.ttlMinutes !== undefined && !Number.isFinite(lease.ttlMinutes)) return null;
    return lease;
  } catch { return null; }
}

/**
 * Renew one lane lease once. Returns true only when a lease owned by `owner` (or, with no owner, the lease
 * as read) was rewritten with a fresh `renewedAt`.
 */
export function renewLaneLeaseOnce({ cwd, owner = null, caller = null, now = () => new Date(), leaseDirFn = defaultLeaseDir,
  fs = { existsSync, readFileSync, writeFileSync, renameSync, rmSync } } = {}) {
  try {
    const gitDir = leaseDirFn(cwd);
    if (!gitDir) return false;
    const file = join(gitDir, LEASE_FILENAME);
    return withLaneLeaseMutation(file, () => {
      if (!fs.existsSync(file)) return false;
      const lease = readLease(file, fs);
      if (!lease) return false;
      if (owner && ownerKey(lease) !== owner) return false;
      if (caller && !belongsToCaller(lease, caller)) return false;
      // An expired lease returns only through the allocator, never a renewal.
      if (isLeaseStale(lease, now().getTime())) return false;
      const next = renewedLease(lease, now().toISOString());
      if (!next || next === lease) return false;
      const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      try {
        fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
        // Defense in depth; the lock excludes writers through the swap,
        // including after this final read.
        const again = readLease(file, fs);
        if (!again || ownerKey(again) !== ownerKey(lease)) return false;
        fs.renameSync(tmp, file);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      return true;
    });
  } catch { return false; }
}

/**
 * Start renewing the lease of each checkout in `cwds` every `everyMs`. The owner of each lease is captured
 * now; a checkout with no readable lease is skipped for good. Returns `stop()`.
 */
export function startLaneLeaseHeartbeat({ cwds, everyMs = DEFAULT_LEASE_HEARTBEAT_MS, now, leaseDirFn = defaultLeaseDir,
  callerSession = process.env.CLAUDE_CODE_SESSION_ID || null, callerHolder = process.env.LANE_SESSION || null,
  fs = { existsSync, readFileSync, writeFileSync, renameSync, rmSync }, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  warn = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const caller = { session: callerSession, holder: callerHolder };
  const targets = [...new Set((cwds ?? []).filter(Boolean))].flatMap((cwd) => {
    const dir = leaseDirFn(cwd);
    const lease = dir ? readLease(join(dir, LEASE_FILENAME), fs) : null;
    return lease && !lease.reserved && belongsToCaller(lease, caller)
      ? [{ cwd, owner: ownerKey(lease), ttlMs: Number.isFinite(lease.ttlMinutes) ? lease.ttlMinutes * 60_000 : Infinity, lost: false }] : [];
  });
  if (!targets.length) return () => {};
  // The interval never exceeds a third of the shortest lease ttl, so a short lease cannot lapse between beats.
  const period = Math.max(1000, Math.min(everyMs, ...targets.map((t) => t.ttlMs / 3)));
  const tick = () => {
    for (const t of targets) {
      if (renewLaneLeaseOnce({ cwd: t.cwd, owner: t.owner, caller, now, leaseDirFn, fs })) { t.lost = false; continue; }
      if (!t.lost) { t.lost = true; try { warn(`lane-lease-heartbeat: could not renew the lease for ${t.cwd} (lost, replaced, expired, unreadable or mutation busy); the run continues unprotected. If a .lane-lease-lock persists, confirm no writer remains before removing it.`); } catch { /* best-effort */ } }
    }
  };
  tick();
  const timer = setIntervalFn(tick, period);
  timer?.unref?.();
  return () => clearIntervalFn(timer);
}

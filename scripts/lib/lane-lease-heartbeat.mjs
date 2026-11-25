/**
 * @file lane-lease-heartbeat.mjs (RS-7179-1) — keep a lane's `.lane-lease` fresh while a long job runs in it.
 *
 * A Codex run (or a gate it waits on) can outlive the lane's 240-minute lease; the lane is then reclaimed and
 * reset under the worker. A holder that is still working renews (`renewedLease`, `lane-lease.mjs`). This module
 * is the timer around that renewal. Fail-closed rules (merge-path checklist 4 and 7):
 *   - no lease file, an unreadable or torn lease, or a non-object: NOTHING is written (never create a lease);
 *   - the lease captured at start fixes the owner (`session` + `acquiredAt`); a lease now held by someone else
 *     is never extended;
 *   - writes are atomic temp+rename; any error is swallowed (best-effort, never fails the job).
 * IO is injected (`fs`, `now`, `gitDirFn`) so tests need no real lane.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LEASE_FILENAME, renewedLease } from './lane-lease.mjs';

export const DEFAULT_LEASE_HEARTBEAT_MS = 10 * 60_000;

const defaultGitDir = (cwd) => {
  try { return execFileSync('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', timeout: 15_000 }).trim() || null; }
  catch { return null; }
};

const ownerKey = (lease) => `${lease?.session ?? ''}|${lease?.acquiredAt ?? ''}`;

function readLease(file, fs) {
  try {
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    return lease && typeof lease === 'object' && !Array.isArray(lease) ? lease : null;
  } catch { return null; }
}

/**
 * Renew one lane lease once. Returns true only when a lease owned by `owner` (or, with no owner, the lease
 * as read) was rewritten with a fresh `renewedAt`.
 */
export function renewLaneLeaseOnce({ cwd, owner = null, now = () => new Date(), gitDirFn = defaultGitDir,
  fs = { existsSync, readFileSync, writeFileSync, renameSync, rmSync } } = {}) {
  try {
    const gitDir = gitDirFn(cwd);
    if (!gitDir) return false;
    const file = join(gitDir, LEASE_FILENAME);
    if (!fs.existsSync(file)) return false;
    const lease = readLease(file, fs);
    if (!lease) return false;
    if (owner && ownerKey(lease) !== owner) return false;
    const next = renewedLease(lease, now().toISOString());
    if (!next || next === lease) return false;
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return true;
  } catch { return false; }
}

/**
 * Start renewing the lease of each checkout in `cwds` every `everyMs`. The owner of each lease is captured
 * now; a checkout with no readable lease is skipped for good. Returns `stop()`.
 */
export function startLaneLeaseHeartbeat({ cwds, everyMs = DEFAULT_LEASE_HEARTBEAT_MS, now, gitDirFn = defaultGitDir,
  fs = { existsSync, readFileSync, writeFileSync, renameSync, rmSync }, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  const targets = [];
  for (const cwd of new Set((cwds ?? []).filter(Boolean))) {
    const gitDir = gitDirFn(cwd);
    const lease = gitDir ? readLease(join(gitDir, LEASE_FILENAME), fs) : null;
    if (lease) targets.push({ cwd, owner: ownerKey(lease) });
  }
  if (!targets.length) return () => {};
  const tick = () => { for (const t of targets) renewLaneLeaseOnce({ cwd: t.cwd, owner: t.owner, now, gitDirFn, fs }); };
  tick();
  const timer = setIntervalFn(tick, everyMs);
  timer?.unref?.();
  return () => clearIntervalFn(timer);
}

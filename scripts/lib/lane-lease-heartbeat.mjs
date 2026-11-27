/**
 * @file lane-lease-heartbeat.mjs (RS-7179-1) — keep a lane's `.lane-lease` fresh while a long job runs in it.
 *
 * A Codex run (or a gate it waits on) can outlive the lane's 240-minute lease; the lane is then reclaimed and
 * reset under the worker. A holder that is still working renews (`renewedLease`, `lane-lease.mjs`). This module
 * is the timer around that renewal. Fail-closed rules (merge-path checklist 4 and 7):
 *   - no lease file, an unreadable or torn lease, or a non-object: NOTHING is written (never create a lease);
 *   - capture requires the caller's session or holder; the captured lease fixes the owner
 *     (`session` + `holder` + `acquiredAt`); a lease now held by someone else is never extended;
 *   - writes are atomic temp+rename; startup failure refuses the job and renewal loss stops it.
 * IO is injected (`fs`, `now`, `leaseDirFn`) so tests need no real lane.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { LEASE_FILENAME, renewedLease, isLeaseStale, isConfirmedOwnLease } from './lane-lease.mjs';
import { withLaneLeaseMutation } from './lane-lease-lock.mjs';

export const DEFAULT_LEASE_HEARTBEAT_MS = 10 * 60_000;

/** The git dir of the checkout holding `cwd` (a `.git` directory, or a `gitdir:` pointer file), no child process. */
const defaultLeaseDir = (cwd) => {
  try {
    let dir = resolve(cwd);
    for (let i = 0; i < 64; i += 1) {
      const dot = join(dir, '.git');
      let stat;
      try { stat = statSync(dot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
        if (stat.isDirectory()) return dot;
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'));
        if (!m) throw new Error('invalid gitdir pointer');
        return resolve(dir, m[1].trim());
      }
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
    return null;
  } catch (error) { throw new Error('cannot inspect lane lease ownership', { cause: error }); }
};

const ownerKey = (lease) => `${lease?.session ?? ''}|${lease?.holder ?? ''}|${lease?.acquiredAt ?? ''}`;

// ownerSession is only evidence after checking every live sibling in the pool.
function belongsToCaller(lease, { session, holder }, gitDir) {
  if (lease.workerSession) return lease.workerSession === session;
  if (holder && (lease.holder === holder || lease.session === holder)) return true;
  if (!session) return false;
  if (lease.session === session) return true;
  if (lease.ownerSession !== session) return false;
  const checkout = basename(gitDir) === '.git' ? dirname(gitDir) : gitDir;
  const siblings = [];
  for (const entry of readdirSync(dirname(checkout), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^lane-\d+$/.test(entry.name)) continue;
    const siblingDir = defaultLeaseDir(join(dirname(checkout), entry.name));
    if (!siblingDir || resolve(siblingDir) === resolve(gitDir)) continue;
    const file = join(siblingDir, LEASE_FILENAME);
    if (!existsSync(file)) continue;
    const sibling = readLease(file, { readFileSync });
    if (!sibling) throw new Error('unreadable sibling lease ownership');
    if (!isLeaseStale(sibling, Date.now())) siblings.push(sibling);
  }
  return isConfirmedOwnLease({ lease, mySessionId: session, siblingLeases: siblings });
}

/** A lease with credentials: a session, an acquire time, and (when present) a numeric ttl. Anything else is no lease. */
function readLease(file, fs) {
  try {
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!lease || typeof lease !== 'object' || Array.isArray(lease)) return null;
    if (typeof lease.session !== 'string' || !lease.session || Number.isNaN(Date.parse(lease.acquiredAt))) return null;
    if (lease.ttlMinutes !== undefined && !Number.isFinite(lease.ttlMinutes)) return null;
    return lease;
  } catch (error) { return error.code === 'ENOENT' ? undefined : null; }
}

/**
 * Renew one lane lease once. Explicit owner and caller evidence are required. Returns true only when
 * the captured lease was rewritten with a fresh `renewedAt`.
 */
export function renewLaneLeaseOnce({ cwd, owner, caller, now = () => new Date(), leaseDirFn = defaultLeaseDir,
  fs = { existsSync, readFileSync, writeFileSync, renameSync, rmSync } } = {}) {
  try {
    if (typeof owner !== 'string' || !owner || !caller ||
        ![caller.session, caller.holder].some(v => typeof v === 'string' && v)) return false;
    const gitDir = leaseDirFn(cwd);
    if (!gitDir) return false;
    const file = join(gitDir, LEASE_FILENAME);
    return withLaneLeaseMutation(file, () => {
      if (!fs.existsSync(file)) return false;
      const lease = readLease(file, fs);
      if (!lease) return false;
      if (ownerKey(lease) !== owner) return false;
      if (!belongsToCaller(lease, caller, gitDir)) return false;
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

/** Capture and renew only proven ownership. Production ticks run in a separate process. */
export function startLaneLeaseHeartbeat({ cwds, everyMs = DEFAULT_LEASE_HEARTBEAT_MS, now, leaseDirFn = defaultLeaseDir,
  callerSession = process.env.CLAUDE_CODE_SESSION_ID || null, callerHolder = process.env.LANE_SESSION || null,
  fs = { existsSync, readFileSync, writeFileSync, renameSync, rmSync }, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  onLost = () => {}, warn = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const caller = { session: callerSession, holder: callerHolder };
  const targets = [...new Set((cwds ?? []).filter(Boolean))].flatMap((cwd) => {
    const dir = leaseDirFn(cwd);
    if (!dir) return [];
    const lease = readLease(join(dir, LEASE_FILENAME), fs);
    // Only ENOENT proves absence; existsSync also returns false for denied reads.
    if (lease === undefined) return [];
    if (!lease || lease.reserved || !belongsToCaller(lease, caller, dir)) {
      throw new Error(`lane lease ownership could not be confirmed for ${cwd}; acquire/adopt your own lane before retrying`);
    }
    return [{ cwd, dir, owner: ownerKey(lease), ttlMs: Number.isFinite(lease.ttlMinutes) ? lease.ttlMinutes * 60_000 : Infinity }];
  });
  if (!targets.length) return () => {};
  const period = Math.min(everyMs, ...targets.map(t => t.ttlMs / 3));
  if (!Number.isFinite(period) || period <= 0) throw new Error('invalid lane lease heartbeat period');
  // Prove startup synchronously before allowing any task code to run.
  for (const t of targets) {
    if (!renewLaneLeaseOnce({ cwd: t.cwd, owner: t.owner, caller, now, leaseDirFn, fs })) {
      throw new Error(`lane lease heartbeat startup renewal failed for ${t.cwd}`);
    }
  }
  let lost = false;
  const lose = () => {
    if (lost) return;
    lost = true;
    warn('lane-lease-heartbeat: could not renew lane ownership; stopping worker. Reacquire/adopt a lane before retrying. For an abandoned mutation lock, confirm no writer remains before removing it.');
    onLost();
  };
  // Injectable in-process clock for deterministic unit tests only.
  if (setIntervalFn !== setInterval) {
    let failures = 0;
    const timer = setIntervalFn(() => {
      const ok = targets.every(t => renewLaneLeaseOnce({ cwd: t.cwd, owner: t.owner, caller, now, leaseDirFn, fs }));
      failures = ok ? 0 : failures + 1;
      if (failures >= 3) lose();
    }, period);
    timer?.unref?.();
    return () => clearIntervalFn(timer);
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./lane-lease-heartbeat-child.mjs', import.meta.url)),
    JSON.stringify({ targets, caller, period: Math.min(period, 1000), parentPid: process.pid })],
  { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, NODE_OPTIONS: '' } });
  let stopped = false;
  let ready = false;
  let resolveReady, rejectReady;
  const readyPromise = new Promise((yes, no) => { resolveReady = yes; rejectReady = no; });
  // Consumers using the synchronous stop API may not await readiness.
  readyPromise.catch(() => {});
  const fail = () => {
    if (stopped) return;
    if (!ready) rejectReady(new Error('lane lease heartbeat child failed to start'));
    else lose();
  };
  const startupTimer = setTimeout(() => { fail(); child.kill('SIGTERM'); }, 5000);
  startupTimer.unref();
  child.on('message', message => {
    if (message === 'ready') { ready = true; clearTimeout(startupTimer); child.unref(); child.channel?.unref(); resolveReady(); }
    if (message === 'lost') lose();
  });
  child.on('error', fail);
  child.on('exit', fail);
  const workers = new Set();
  const started = pid => {
    if (!Number.isInteger(pid) || pid <= 0) return;
    workers.add(pid);
    if (child.connected) child.send({ workers: [...workers] });
  };
  const ended = pid => {
    workers.delete(pid);
    if (child.connected) child.send({ workers: [...workers] });
  };
  process.on('lane-lease-worker-started', started);
  process.on('lane-lease-worker-stopped', ended);
  const stop = () => {
    stopped = true;
    clearTimeout(startupTimer);
    process.removeListener('lane-lease-worker-started', started);
    process.removeListener('lane-lease-worker-stopped', ended);
    child.kill('SIGTERM');
    if (child.connected) child.disconnect();
  };
  stop.ready = readyPromise;
  return stop;
}

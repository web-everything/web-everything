/** Idle, serialized maintenance of one daemon clone. Never prunes recent objects. */
import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { cloneLockKey, inspectCloneLock, withWriteLock } from './daemon-clone-lock.mjs';
import { daemonStateDir } from './daemon-last-good.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { createJobStore } from './daemon-jobs-runtime.mjs';
import { rebuildJobsDir, REBUILD_JOB_KIND } from './daemon-rebuild/rebuild-job.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';

/** Resolve linked worktrees too; unreadable evidence must stop object maintenance. */
export function maintenanceGitDir(root) {
  const dot = join(root, '.git');
  const entry = lstatSync(dot);
  if (entry.isSymbolicLink()) {
    try { return realpathSync(dot); } catch { throw new Error('unreadable linked git directory'); }
  }
  if (entry.isDirectory()) return realpathSync(dot);
  const target = /^gitdir: (.+)$/m.exec(readFileSync(dot, 'utf8'))?.[1];
  if (!target) throw new Error('unreadable git directory');
  try { return realpathSync(resolve(root, target)); } catch { throw new Error('unreadable worktree git directory'); }
}

/** A lock or a live Git cwd blocks maintenance. Missing process evidence is not idle. */
export function cloneGitIsBusy(root, { exec = execFileSync } = {}) {
  const gitDir = maintenanceGitDir(root);
  try { statSync(join(gitDir, 'index.lock')); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const opts = { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 };
  const processes = exec('ps', ['-axo', 'pid=,comm='], opts);
  if (!String(processes).trim()) throw new Error('unreadable process table');
  const pids = String(processes).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (line.trim() && !match) throw new Error('incomplete process table');
    return match && /^git(?:-|$)/.test(basename(match[2].trim())) ? [match[1]] : [];
  });
  if (!pids.length) return false;
  const output = exec('lsof', ['-n', '-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'], opts);
  if (!String(output).includes('\nn')) throw new Error('unreadable Git cwd evidence');
  const checkout = realpathSync(root);
  const prefix = checkout.endsWith(sep) ? checkout : `${checkout}${sep}`;
  const pending = new Set(pids);
  let pid = null;
  let busy = false;
  for (const line of String(output).split('\n')) {
    if (line.startsWith('p')) { pid = line.slice(1); continue; }
    if (!line.startsWith('n') || !pending.has(pid)) continue;
    const cwd = realpathSync(line.slice(1));
    pending.delete(pid);
    if (cwd === checkout || cwd.startsWith(prefix)) busy = true;
  }
  // lsof may succeed with partial results (for example, if a process exited).
  // Only complete cwd evidence can establish that every Git process is elsewhere.
  return busy || pending.size > 0;
}

export const CLONE_MAINTENANCE_INTERVAL_ENV = 'WE_DAEMON_CLONE_MAINTENANCE_INTERVAL_MS';
const DAY = 24 * 60 * 60 * 1000;
export function resolveCloneMaintenanceSettings({
  env = process.env, tool = readSettings().cloneMaintenance, platform = platformPreference('cloneMaintenance', { env }),
} = {}) {
  const raw = env[CLONE_MAINTENANCE_INTERVAL_ENV];
  return cascadePolicy('cloneMaintenance', tool, {
    standard: { intervalMs: DAY }, platform, env,
    envValues: { intervalMs: raw === undefined ? undefined : /^\d+$/.test(raw) ? Number(raw) : raw },
    valid: { intervalMs: (v) => Number.isSafeInteger(v) && v >= 0 && v <= 365 * DAY },
  });
}

export function maintenanceStampPath(root, env = process.env) {
  return join(daemonStateDir(env), `clone-maintenance-${cloneLockKey(root)}.json`);
}

/** Unknown/corrupt records block maintenance; completed jobs do not. */
export function cloneHasRebuildJob(root, env = process.env) {
  const dir = rebuildJobsDir(root, env);
  // listRunIds uses existsSync, which can mistake inaccessible storage for absent storage.
  try { readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const { records, corrupt } = createJobStore(dir).list();
  return corrupt.length > 0 || records.some(({ job }) => job.kind === REBUILD_JOB_KIND.kind && !TERMINAL_JOB_STATUSES.includes(job.status));
}

// Async so the lock's heartbeat remains live during a large pack. Bound output and runtime.
export function runMaintenanceGit(args, opts) {
  return new Promise((resolve) => {
    // Git forks repack/prune. Kill the entire group on timeout/output overflow, so
    // a surviving repack cannot write after this callback releases the clone lock.
    let timer;
    const killGroup = () => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
    };
    // execFile does not forward detached to spawn; use spawn directly so the
    // child's PID really is the process-group ID targeted by killGroup.
    const child = spawn('git', args, { ...opts, timeout: 0, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failed = false;
    const stop = () => { failed = true; killGroup(); };
    child.stdout.on('data', chunk => {
      if (failed) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > 64 * 1024) { stop(); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (failed) return;
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) stop();
    });
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) killGroup();
      resolve({ status: failed || code !== 0 ? 1 : 0, stdout: Buffer.concat(chunks).toString('utf8') });
    });
    timer = setTimeout(stop, opts.timeout ?? 30 * 60_000);
    timer.unref();
  });
}

function readStamp(path) {
  try {
    if (statSync(path).size > 1024) throw new Error('oversized stamp');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(value.at) || value.at < 0) throw new Error('invalid stamp');
    return value.at;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Best effort; every attempt (including failure) is stamped under the WRITE lock.
 * Corrupt/unwritable stamps skip GC: inspect/repair the named state file before retrying.
 * `hasRebuildJob` must return exactly false to authorize maintenance and is checked again under lock.
 */
export async function maybeMaintainClone({
  root, env = process.env, now = Date.now, run = runMaintenanceGit, emitEvent = appendDaemonEvent,
  settings, hasRebuildJob = () => cloneHasRebuildJob(root, env), withLock = withWriteLock,
} = {}) {
  const start = now();
  let bytesBefore = null;
  let bytesAfter = null;
  const result = (reason, skipped = true) => ({
    clone: root, bytesBefore, bytesAfter,
    freed: bytesBefore === null || bytesAfter === null ? null : Math.max(0, bytesBefore - bytesAfter),
    durationMs: Math.max(0, now() - start), ...(skipped ? { skipped: true } : {}), ...(reason ? { reason } : {}),
  });
  const lockOpts = { ...(env.WE_DAEMON_CLONE_LOCK_ROOT ? { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT } : {}), waitMs: 0, owner: `clone-maintenance:${process.pid}` };
  const jobsReason = async () => {
    try {
      const active = await hasRebuildJob();
      return active === false ? null : active === true ? 'rebuild-active' : 'rebuild-state-unreadable';
    } catch { return 'rebuild-state-unreadable'; }
  };
  let detail;
  try {
    const intervalMs = (settings ?? resolveCloneMaintenanceSettings({ env })).value.intervalMs;
    const stamp = maintenanceStampPath(root, env);
    const limited = () => {
      try {
        const at = readStamp(stamp);
        return at !== null && now() - at < intervalMs ? 'rate-limited' : null;
      } catch { return 'stamp-unreadable'; }
    };
    const attempt = async () => {
      const reason = await jobsReason();
      if (reason) return result(reason);
      const snapshot = inspectCloneLock(root, lockOpts);
      if (snapshot.writer) return result('writer-active');
      if (snapshot.readers.length) return result('reader-active');
      const limit = limited();
      if (limit) return result(limit);
      const locked = await withLock(root, async () => {
        const reason = await jobsReason() || limited();
        if (reason) return result(reason);
        // Worktrees and symlinked git dirs may share an object store outside this clone.
        if (!lstatSync(join(root, '.git')).isDirectory()) return result('shared-git-dir');
        // Inherited Git routing/config overrides must not redirect maintenance to another clone.
        const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
        const opts = { cwd: root, env: childEnv };
        const measure = async () => {
          const r = await run(['count-objects', '-v'], opts);
          const values = ['size', 'size-pack'].map((key) => {
            const m = r.stdout?.match(new RegExp(`^${key}: (\\d+)$`, 'm'));
            return m ? Number(m[1]) : NaN;
          });
          const bytes = (values[0] + values[1]) * 1024;
          if (r.status !== 0 || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('measurement failed');
          return bytes;
        };
        try { bytesBefore = await measure(); } catch { return result('measurement-failed'); }
        try {
          mkdirSync(daemonStateDir(env), { recursive: true });
          const temp = `${stamp}.${process.pid}.tmp`;
          writeFileSync(temp, JSON.stringify({ at: now() }));
          renameSync(temp, stamp);
        } catch { return result('stamp-write-failed'); }
        let failed = false;
        try {
          // Explicit gc, default prune grace; never detach beyond our lock's lifetime.
          const r = await run(['-c', 'gc.autoDetach=false', 'gc'], opts);
          failed = r.status !== 0;
        } catch { failed = true; }
        try { bytesAfter = await measure(); } catch { return result(failed ? 'gc-failed' : 'measurement-failed', false); }
        return result(failed ? 'gc-failed' : null, false);
      }, lockOpts);
      return locked.ok ? locked.value : result(locked.reason || 'lock-unavailable');
    };
    detail = await attempt();
  } catch { detail = result('maintenance-unavailable'); }
  try { await emitEvent({ kind: 'clone-maintenance', daemon: basename(root), detail }, { env }); } catch { /* best effort */ }
  return detail;
}

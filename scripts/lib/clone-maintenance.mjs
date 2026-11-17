/** Idle, serialized maintenance of one daemon clone. Never prunes recent objects. */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { cloneLockKey, inspectCloneLock, withWriteLock } from './daemon-clone-lock.mjs';
import { daemonStateDir } from './daemon-last-good.mjs';
import { appendDaemonEvent, daemonEventsPath } from './daemon-events.mjs';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { createJobStore } from './daemon-jobs-runtime.mjs';
import { rebuildJobsDir, REBUILD_JOB_KIND } from './daemon-rebuild/rebuild-job.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';
import { hasUntrackedCards, loadCardTriage, salvageUntrackedCards } from './daemon-clone-card-salvage.mjs';

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
export const SKIP_RETRY_MS = 30 * 60 * 1000;
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
    const errChunks = []; // first 500 chars of git's stderr, so a gc-failed carries its cause
    let errKept = 0;
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
      if (errKept < 500) { errChunks.push(chunk.subarray(0, 500 - errKept)); errKept += Math.min(chunk.length, 500 - errKept); }
      if (stderrBytes > 64 * 1024) stop();
    });
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) killGroup();
      resolve({
        status: failed || code !== 0 ? 1 : 0, stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?'),
        exit: code, signal: failed ? 'stopped' : null,
      });
    });
    timer = setTimeout(stop, opts.timeout ?? 30 * 60_000);
    timer.unref();
  });
}

/** Ask git itself (`--type=expiry-date`, so `1 year ago`, `never` and every approxidate form parse as git parses them).
 *  Keep a configured retention that is `never` or at least 2 weeks; an UNSET or INVALID value (exit 1 / 128, B13: the live
 *  clone had `gc.pruneExpire = gc.auto`, which made every gc exit 128) gets the 2-week default; a shorter one is raised to it.
 *  Any other failure is unreadable evidence: returns null and gc is skipped (fail closed). */
export const PRUNE_FLOOR_MS = 14 * 24 * 60 * 60 * 1000;
export function pruneOverrideFor(r, nowMs) {
  if (!r || typeof r !== 'object') return null;
  if (r.status === 0) {
    const t = Number(String(r.stdout ?? '').trim());
    if (!Number.isFinite(t) || t < 0) return null;
    return t === 0 || nowMs - t * 1000 >= PRUNE_FLOOR_MS ? [] : ['-c', 'gc.pruneExpire=2.weeks.ago'];
  }
  return r.exit === 1 || r.exit === 128 ? ['-c', 'gc.pruneExpire=2.weeks.ago'] : null;
}
async function pruneOverride(run, opts, nowMs) {
  try { return pruneOverrideFor(await run(['config', '--type=expiry-date', '--get', 'gc.pruneExpire'], opts), nowMs); } catch { return null; }
}

const MAX_EVENT_SCAN_BYTES = 64 * 1024 * 1024;
/** Walk daemon-events.jsonl backwards in bounded chunks, yielding complete lines (newest first). A line cut by a chunk
 *  boundary is joined with the next chunk read; reading stops at `maxBytes` or the start of the file. */
function* linesNewestFirst(file, maxBytes, read = readSync) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('invalid event scan limit');
  maxBytes = Math.min(maxBytes, MAX_EVENT_SCAN_BYTES);
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  const CHUNK = 1024 * 1024;
  try {
    let pos = size;
    let carry = '';
    while (pos > 0 && size - pos < maxBytes) {
      const len = Math.min(CHUNK, pos, maxBytes - (size - pos));
      pos -= len;
      const buf = Buffer.alloc(len);
      if (read(fd, buf, 0, len, pos) !== len) throw new Error('incomplete event log read');
      const lines = (buf.toString('utf8') + carry).split('\n');
      carry = lines.shift() ?? '';
      for (let i = lines.length - 1; i >= 0; i -= 1) yield lines[i];
    }
    if (pos === 0 && carry) yield carry;
  } finally { closeSync(fd); }
}

/** Closest outcome for THIS clone at or after the stamp, within `windowMs`. Rate-limited ticks do not write stamps;
 *  preceding events cannot describe this attempt. Read back to the stamp's time, bounded to 64 MiB; null when absent.
 *  `maxBytes` can reduce the cap and `read` allows callers to observe the actual read ranges. */
export function readCloneMaintenanceEventNear(root, env = process.env, nearAt, windowMs = 5 * 60_000, {
  maxBytes = MAX_EVENT_SCAN_BYTES, read = readSync,
} = {}) {
  const file = daemonEventsPath({ env });
  let closest = null;
  let closestAt = Infinity;
  for (const line of linesNewestFirst(file, maxBytes, read)) {
    const at = /^\{"at":"([^"]+)"/.exec(line)?.[1];
    const atMs = at ? Date.parse(at) : NaN;
    if (Number.isFinite(atMs) && atMs < nearAt) break; // preceding evidence cannot classify this stamp
    if (!line.includes('"clone-maintenance"')) continue;
    try {
      const e = JSON.parse(line);
      const eventAt = Date.parse(e?.at ?? '');
      if (e?.kind !== 'clone-maintenance' || e.detail?.clone !== root || e.detail.reason === 'rate-limited'
        || !(eventAt >= nearAt && eventAt - nearAt <= windowMs)) continue;
      // If outcomes share a millisecond, ambiguous evidence must preserve the full GC interval.
      if (eventAt < closestAt || eventAt === closestAt && !(e.detail.skipped === true && LEGACY_SKIP_REASONS.has(e.detail.reason))) {
        closest = e;
        closestAt = eventAt;
      }
    } catch { /* a corrupt line */ }
  }
  return closest;
}

/** Latest clone-maintenance event for this clone (bounded read of daemon-events.jsonl); null when none is found. */
export function readLastCloneMaintenanceEvent(root, env = process.env) {
  const file = daemonEventsPath({ env });
  for (const line of linesNewestFirst(file, MAX_EVENT_SCAN_BYTES)) {
    if (!line.includes('"clone-maintenance"')) continue;
    try {
      const e = JSON.parse(line);
      if (e?.kind === 'clone-maintenance' && e.detail?.clone === root) return e;
    } catch { /* a corrupt line */ }
  }
  return null;
}
export const LEGACY_SKIP_REASONS = new Set(['git-busy', 'prune-expire-unreadable', 'measurement-failed']);

function readStamp(path) {
  try {
    if (statSync(path).size > 1024) throw new Error('oversized stamp');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(value.at) || value.at < 0) throw new Error('invalid stamp');
    const ran = value.ran === true;
    // Only a known skip reason without a conflicting `ran` counts as a skip; anything inconsistent keeps the full interval.
    return { at: value.at, skip: typeof value.skip === 'string' && LEGACY_SKIP_REASONS.has(value.skip) && !ran ? value.skip : null, ran: ran || typeof value.skip === 'string' && !LEGACY_SKIP_REASONS.has(value.skip) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Default card salvage: cheap lock-free pre-check, then the move under the clone write lock. Returns counts or null. */
export async function defaultSalvageCards({ root, env = process.env, withLock = withWriteLock, lockOpts = {} }) {
  if (!hasUntrackedCards(root)) return null;
  const dir = join(daemonStateDir(env), 'card-salvage');
  const locked = await withLock(root, async () => {
    const r = salvageUntrackedCards({ root, salvageDir: join(dir, cloneLockKey(root)), triaged: loadCardTriage(join(dir, 'triage.json')) });
    return { moved: r.moved.length, kept: r.kept.length, failed: r.failed.length };
  }, lockOpts);
  return locked.ok ? locked.value : null;
}

/**
 * Best effort; every attempt (including failure) is stamped under the WRITE lock.
 * Corrupt/unwritable stamps skip GC: inspect/repair the named state file before retrying.
 * `hasRebuildJob` must return exactly false to authorize maintenance and is checked again under lock.
 */
export async function maybeMaintainClone({
  root, env = process.env, now = Date.now, run = runMaintenanceGit, emitEvent = appendDaemonEvent,
  settings, hasRebuildJob = () => cloneHasRebuildJob(root, env), withLock = withWriteLock, isBusy = cloneGitIsBusy,
  readLastEvent = ({ nearAt, windowMs } = {}) => readCloneMaintenanceEventNear(root, env, nearAt, windowMs),
  salvageCards = defaultSalvageCards,
} = {}) {
  let cardSalvage = null;
  const start = now();
  let bytesBefore = null;
  let bytesAfter = null;
  let gcDiag = null; // git's stderr head + exit/signal when gc fails
  const result = (reason, skipped = true) => ({
    clone: root, bytesBefore, bytesAfter,
    freed: bytesBefore === null || bytesAfter === null ? null : Math.max(0, bytesBefore - bytesAfter),
    durationMs: Math.max(0, now() - start), ...(skipped ? { skipped: true } : {}), ...(reason ? { reason } : {}), ...(gcDiag ? { gcDiag } : {}),
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
    const limited = async () => {
      try {
        const rec = readStamp(stamp);
        if (rec === null || now() - rec.at >= intervalMs) return null; // nothing to classify when the full interval already passed
        // A skip (marked, or a LEGACY unmarked stamp whose closest following outcome is a skip) retries after 30 min;
        // a gc run, an unknown/unreadable history or no event keeps the full interval.
        let skipped = rec.skip !== null;
        if (!skipped && !rec.ran) {
          try {
            const e = await readLastEvent({ nearAt: rec.at, windowMs: 5 * 60_000 });
            // A skip event is written seconds after its stamp; an older skip must not reclassify a later attempt.
            const eventAt = Date.parse(e?.at ?? '');
            skipped = e?.detail?.skipped === true && LEGACY_SKIP_REASONS.has(e.detail.reason)
              && Number.isFinite(eventAt) && eventAt >= rec.at && eventAt - rec.at <= 5 * 60_000;
          } catch { skipped = false; }
        }
        return now() - rec.at < (skipped ? Math.min(intervalMs, SKIP_RETRY_MS) : intervalMs) ? 'rate-limited' : null;
      } catch { return 'stamp-unreadable'; }
    };
    const attempt = async () => {
      const reason = await jobsReason();
      if (reason) return result(reason);
      const snapshot = inspectCloneLock(root, lockOpts);
      if (snapshot.writer) return result('writer-active');
      if (snapshot.readers.length) return result('reader-active');
      // Card salvage (R955 item 3): move this clone's untracked cards that are on main or triaged DUP/STALE into the
      // salvage dir, under the clone WRITE lock, independent of the gc interval. Best effort; never blocks gc.
      // Skipped while Git is busy in the clone (or the evidence is unreadable), like gc.
      try { cardSalvage = await isBusy(root) === false ? await salvageCards({ root, env, withLock, lockOpts }) : null; } catch { cardSalvage = null; }
      const limit = await limited();
      if (limit) return result(limit);
      const locked = await withLock(root, async () => {
        const reason = await jobsReason() || await limited();
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
        // A skip BEFORE gc never burns the interval (the 2026-11-14 23:02 ET busy skip consumed the whole 24h window): it
        // leaves a short retry backoff instead. Same fail-closed process evidence maintainCloneObjects uses; the clone
        // lock does not exclude external Git.
        const writeStamp = (record) => {
          mkdirSync(daemonStateDir(env), { recursive: true });
          const temp = `${stamp}.${process.pid}.tmp`;
          writeFileSync(temp, JSON.stringify(record));
          renameSync(temp, stamp);
        };
        const backoff = (why) => {
          try { writeStamp({ at: now(), skip: why }); } catch { return result('stamp-write-failed'); }
          return result(why);
        };
        try { bytesBefore = await measure(); } catch { return backoff('measurement-failed'); }
        try { if (await isBusy(root) !== false) return backoff('git-busy'); } catch { return backoff('git-busy'); }
        const pruneArgs = await pruneOverride(run, opts, now());
        if (pruneArgs === null) return backoff('prune-expire-unreadable');
        try { writeStamp({ at: now(), ran: true }); } catch { return result('stamp-write-failed'); }
        let failed = false;
        try {
          // Explicit gc, default 2-week prune grace stated on the command line (B13: a config typo `gc.pruneExpire = gc.auto` made
          // every gc exit 128); never detach beyond our lock's lifetime.
          const r = await run(['-c', 'gc.autoDetach=false', ...pruneArgs, 'gc'], opts);
          failed = r.status !== 0;
          if (failed) gcDiag = { exit: r.exit ?? null, signal: r.signal ?? null, stderr: String(r.stderr ?? '').slice(0, 500) };
        } catch { failed = true; }
        try { bytesAfter = await measure(); } catch { return result(failed ? 'gc-failed' : 'measurement-failed', false); }
        return result(failed ? 'gc-failed' : null, false);
      }, lockOpts);
      return locked.ok ? locked.value : result(locked.reason || 'lock-unavailable');
    };
    detail = await attempt();
  } catch { detail = result('maintenance-unavailable'); }
  if (cardSalvage) detail = { ...detail, cardSalvage };
  try { await emitEvent({ kind: 'clone-maintenance', daemon: basename(root), detail }, { env }); } catch { /* best effort */ }
  return detail;
}

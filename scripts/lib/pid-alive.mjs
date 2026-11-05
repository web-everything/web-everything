/** Process liveness shared by job records and drain evidence; imports no job or dispatcher. */
import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';

/** Linux namespaces can share a hostname but have unrelated pid tables. Other hosts use null. */
export function pidNamespace() {
  try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; }
}

/** Birth time distinguishes a live job from a later process reusing its pid. Null means unknown. */
export function pidStartTime(pid, exec = execFileSync) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return String(exec('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })).trim() || null;
  } catch { return null; }
}

/** Existence-only probe (EPERM = exists); identity-aware callers also use pidIdentity. */
export function pidAlive(pid, kill = (p, s) => process.kill(p, s)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** One bounded, locale-stable snapshot; unreadable or malformed output is unknown. */
function readPidIdentity(pid, exec) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: null, reason: 'invalid-pid' };
  let output;
  try {
    output = String(exec('ps', ['-p', String(pid), '-o', 'stat=,lstart=,command='], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
    })).trim();
  } catch (error) {
    // ps exits 1 with empty output when the pid is absent; any diagnostic on stderr is NOT proof of death.
    const diagnostic = String(error?.stderr ?? '').trim();
    return error?.status === 1 && !error?.signal && !error?.code && !diagnostic
      ? { alive: false, reason: 'gone' } : { alive: null, reason: 'unreadable' };
  }
  if (!output) return { alive: false, reason: 'gone' };
  const row = /^(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([^\r\n]+)$/.exec(output);
  if (!row) return { alive: null, reason: 'unreadable' };
  const [, stat, start, argv] = row;
  return { stat, runnerStart: start.replace(/\s+/g, ' '), runnerArgv: argv };
}

/** Launch stamp from the same snapshot as the identity probe; null fields leave legacy TTL recovery. */
export function pidIdentityStamp(pid, exec = execFileSync) {
  const row = readPidIdentity(pid, exec);
  return { runnerStart: row.runnerStart ?? null, runnerArgv: row.runnerArgv ?? null };
}

export const PID_START_SLACK_MS = 120_000;

/** The `startedBy` bound for a listing row's pid, or null when the row's start time cannot bound it. A wrapped worker
 *  keeps its ORIGINAL launch time in `startedAt` while a harness resume spawns a new child (new pid, started later),
 *  so that start time proves nothing about the current process: arming the guard would call the live resumed child a
 *  reused pid. null skips only the started-after-holder check; unknown identity still retains the claim.
 *  @param {{kind?:string, startedAt?:*}} row
 *  @param {(startedAt:*) => number} toMs   the shared startedAt parser (`reconcile-core.mjs#startedAtMs`) */
export function holderStartedBy(row, toMs) {
  if (row?.kind === 'wrapped-worker') return null;
  const ms = toMs(row?.startedAt);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Three-valued identity: only positive evidence of death may reclaim a runner's claim. */
export function pidIdentity(pid, { expectStart = null, expectArgv = null, startedBy = null, exec = execFileSync } = {}) {
  const row = readPidIdentity(pid, exec);
  if ('alive' in row) return row;
  if (row.stat.startsWith('Z')) return { alive: false, reason: 'zombie' };
  // Working Claude sessions can retain their pre-warmed bg-spare argv. That command alone
  // cannot prove recycling: require a stored start/argv mismatch, zombie, or gone evidence.
  // A holder can only start BEFORE (or just at) the moment it registered: a process that started later than
  // `startedBy` (+ slack for clock/listing lag) is a different process that reused the pid.
  if (Number.isFinite(startedBy)) {
    const procMs = Date.parse(`${row.runnerStart} UTC`);
    if (Number.isFinite(procMs) && procMs > startedBy + PID_START_SLACK_MS) return { alive: false, reason: 'started-after-holder' };
  }
  if (expectStart && row.runnerStart !== String(expectStart).trim().replace(/\s+/g, ' ')) {
    return { alive: false, reason: 'start-mismatch' };
  }
  if (expectArgv && !row.runnerArgv.includes(expectArgv)) return { alive: false, reason: 'argv-mismatch' };
  return { alive: true, reason: 'match' };
}

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

/** Three-valued identity: only positive evidence of death may reclaim a runner's claim. */
export function pidIdentity(pid, { expectStart = null, expectArgv = null, exec = execFileSync } = {}) {
  const row = readPidIdentity(pid, exec);
  if ('alive' in row) return row;
  if (row.stat.startsWith('Z')) return { alive: false, reason: 'zombie' };
  // Working Claude sessions can retain their pre-warmed bg-spare argv. That command alone
  // cannot prove recycling: require a stored start/argv mismatch, zombie, or gone evidence.
  if (expectStart && row.runnerStart !== String(expectStart).trim().replace(/\s+/g, ' ')) {
    return { alive: false, reason: 'start-mismatch' };
  }
  if (expectArgv && !row.runnerArgv.includes(expectArgv)) return { alive: false, reason: 'argv-mismatch' };
  return { alive: true, reason: 'match' };
}

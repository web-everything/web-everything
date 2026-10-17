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

/** PID liveness probe, same contract as `reconcile-pass.mjs#probePid` (EPERM = alive, ESRCH = dead). */
export function pidAlive(pid, kill = (p, s) => process.kill(p, s)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

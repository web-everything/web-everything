/** Dependency-free process liveness shared by job records and drain evidence. */
/** PID liveness probe, same contract as `reconcile-pass.mjs#probePid` (EPERM = alive, ESRCH = dead). */
export function pidAlive(pid, kill = (p, s) => process.kill(p, s)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

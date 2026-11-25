/**
 * @file lane-lease-guard.mjs (RS-7179-2) — the take-over/reclaim guard: a ttl-stale lane with a live process
 * working inside it is not handed to someone else. Returns a refusal (with the pids) or null.
 */
import { liveCwdPids } from './lane-lease-liveness.mjs';

export function liveCwdRefusal(dir, action, io = {}) {
  const pids = liveCwdPids(dir, io);
  if (!pids || !pids.length) return null;
  return { action, pids, reason: `${action} refused: live process(es) ${pids.join(', ')} have their cwd in this lane` };
}

/**
 * @file scripts/readiness/drain-fence.mjs
 * @description BLUE-GREEN-SWAP S1.2 — the per-merge fence re-read a `--under-lease` child runs right before each
 *   merge write (FLOW-DMN-012/013/014/015). Pure over an injectable lease reader; every unreadable or mismatching
 *   case REFUSES (fail closed, never open).
 */
import { readLockEntry } from './file-locks.mjs';
import { drainLeasePathFor, DRAIN_LOCK_ROOT } from './drain-lock.mjs';

/**
 * @param {{lockRoot?:string, owner:string, fence:number|null, repoKey?:string|null, read?:Function}} o
 * @returns {{ok:true, skipped?:true}|{ok:false, reason:'lease-unknown'|'owner-changed'|'fence-advanced'}}
 */
export function checkDrainFence({ lockRoot = DRAIN_LOCK_ROOT, owner, fence, repoKey = null, read = readLockEntry } = {}) {
  if (fence == null) return { ok: true, skipped: true }; // legacy child: no fence declared, start gate only
  let entry;
  try { entry = read(lockRoot, drainLeasePathFor(repoKey)); } catch { return { ok: false, reason: 'lease-unknown' }; }
  if (!entry) return { ok: false, reason: 'lease-unknown' };
  if (entry.owner !== owner) return { ok: false, reason: 'owner-changed' };
  const stored = entry.meta && Number.isInteger(entry.meta.fence) ? entry.meta.fence : null;
  if (stored == null) return { ok: false, reason: 'lease-unknown' };
  if (stored > fence) return { ok: false, reason: 'fence-advanced' };
  return { ok: true };
}

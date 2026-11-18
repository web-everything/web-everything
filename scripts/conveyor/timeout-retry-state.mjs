/** Shared, read-only per-head retry budget for enrichment and dispatch. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { ghThrottleLockRoot } from '../lib/gh-throttle.mjs';

/** Missing/invalid dates remain held; only a dated reservation can expire. */
export function timeoutPendingIsStale(reservedAt, now = Date.now(), env = process.env) {
  const raw = Number(env.WE_TIMEOUT_RERUN_PENDING_STALE_MS);
  const policy = cascadePolicy('timeoutRerun', undefined, {
    env, standard: { pendingStaleMs: 20 * 60_000 },
    envValues: { pendingStaleMs: Number.isFinite(raw) && raw > 0 ? raw : undefined },
    valid: { pendingStaleMs: v => Number.isFinite(v) && v > 0 },
  });
  const at = Date.parse(reservedAt);
  return Number.isFinite(at) && now - at > policy.value.pendingStaleMs;
}

export const timeoutStateDir = () => join(ghThrottleLockRoot(), 'ci-timeout-reruns');
export const timeoutKey = ({ repo, pr, head }) => createHash('sha256')
  .update(JSON.stringify([repo, pr, head])).digest('hex');

export function readTimeoutStates(evidence, dir = timeoutStateDir()) {
  const canonical = join(dir, `${timeoutKey(evidence)}.json`);
  if (!existsSync(dir)) return [];
  const paths = existsSync(canonical) ? [canonical]
    : readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => join(dir, name));
  return paths.map((path) => JSON.parse(readFileSync(path, 'utf8'))).filter((state) => {
    if (state.version !== 1 || !state.evidence || !Array.isArray(state.requests)) throw new Error('corrupt-timeout-state');
    return ['repo', 'pr', 'head'].every((key) => state.evidence[key] === evidence[key]);
  });
}

export function readTimeoutBudget({ dir, now = Date.now(), ...evidence }) {
  try {
    dir ??= timeoutStateDir(); // resolved inside the guard: an unreadable lock root is "unreadable state", never a throw
    const requests = readTimeoutStates(evidence, dir).flatMap((state) => state.requests);
    // `rejected` = requests GitHub refused (4xx) or whose job was no longer failed at the evidenced attempt. They spend
    // no confirmed budget, but the planner counts them against the infra re-run cap so a persistently rejected re-run
    // reaches ci-heal instead of being re-planned forever. An early `released` reservation (a failed observation or a
    // stale head: nothing was ever sent) is transient and is NOT counted.
    const pending = requests.filter(r => r.status === 'pending');
    return { confirmed: requests.filter((r) => r.status === 'confirmed').length,
      rejected: requests.filter((r) => r.status === 'rejected' && !r.released).length,
      // Expiry schedules observation; it never proves an ambiguous request safe to heal.
      pending: pending.length > 0,
      ...(pending.length && pending.every(r => timeoutPendingIsStale(r.reservedAt, now)) ? { pendingStale: true } : {}),
      // When the oldest still-pending request was reserved: lets the planner tell a rerun that is simply in
      // flight (hold, no human) from one that has been unresolved too long (escalate).
      ...(requests.some((r) => r.status === 'pending')
        ? { pendingSince: requests.filter((r) => r.status === 'pending' && r.reservedAt).map((r) => r.reservedAt).sort()[0] }
        : {}) };
  } catch (error) { return { pending: true, reason: `timeout-state-unreadable:${error.message}` }; }
}

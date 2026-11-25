/** Shared, read-only per-head retry budget for enrichment and dispatch. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ghThrottleLockRoot } from '../lib/gh-throttle.mjs';

export const timeoutStateDir = () => join(ghThrottleLockRoot(), 'ci-timeout-reruns');
export const timeoutKey = ({ repo, pr, head }) => createHash('sha256')
  .update(JSON.stringify([repo, pr, head])).digest('hex');

/** Isolate bad files for recovery scans; ordinary budget reads throw and fail closed. */
export function readTimeoutStateFiles(dir, { paths, onError } = {}) {
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const path of paths ?? readdirSync(dir).filter(name => name.endsWith('.json')).map(name => join(dir, name))) {
    try {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      if (state?.version !== 1 || !state.evidence || !Array.isArray(state.requests)) throw new Error('corrupt-timeout-state');
      entries.push({ path, state });
    } catch (error) {
      if (!onError) throw error;
      onError(path, error);
    }
  }
  return entries;
}

export function readTimeoutStates(evidence, dir = timeoutStateDir()) {
  const canonical = join(dir, `${timeoutKey(evidence)}.json`);
  if (!existsSync(dir)) return [];
  const paths = existsSync(canonical) ? [canonical]
    : readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => join(dir, name));
  return readTimeoutStateFiles(dir, { paths }).map(({ state }) => state).filter((state) => {
    return ['repo', 'pr', 'head'].every((key) => state.evidence[key] === evidence[key]);
  });
}

export function readTimeoutBudget({ dir, ...evidence }) {
  try {
    dir ??= timeoutStateDir(); // resolved inside the guard: an unreadable lock root is "unreadable state", never a throw
    const states = readTimeoutStates(evidence, dir);
    const requests = states.flatMap((state) => state.requests);
    // Recovery cannot expire a retired marker. Keep its pending hold and expose why it needs a decision
    // to the planner, including on repositories where no ci-heal dispatcher is available.
    const retiredPending = states.find((state) => state.retired && state.requests.some((r) => r.status === 'pending'));
    // `rejected` = requests GitHub refused (4xx) or whose job was no longer failed at the evidenced attempt. They spend
    // no confirmed budget, but the planner counts them against the infra re-run cap so a persistently rejected re-run
    // reaches ci-heal instead of being re-planned forever. An early `released` reservation (a failed observation or a
    // stale head: nothing was ever sent) is transient and is NOT counted.
    // `expired` = a pending request that was LOST (no run ever observed; RERUN-PENDING-EXPIRY). It spent a re-run
    // attempt, so it counts toward `confirmed` (the cap) but is no longer `pending`.
    const expired = requests.filter((r) => r.status === 'expired').length;
    return { confirmed: requests.filter((r) => r.status === 'confirmed').length + expired,
      ...(expired ? { expired } : {}),
      ...(retiredPending ? { retired: true, reason: `timeout-state-retired:${retiredPending.retired.reason ?? 'unknown'}` } : {}),
      rejected: requests.filter((r) => r.status === 'rejected' && !r.released).length,
      pending: requests.some((r) => r.status === 'pending'),
      // When the oldest still-pending request was reserved: lets the planner tell a rerun that is simply in
      // flight (hold, no human) from one that has been unresolved too long (escalate).
      ...(requests.some((r) => r.status === 'pending')
        ? { pendingSince: requests.filter((r) => r.status === 'pending' && r.reservedAt).map((r) => r.reservedAt).sort()[0] }
        : {}) };
  } catch (error) { return { pending: true, reason: `timeout-state-unreadable:${error.message}` }; }
}

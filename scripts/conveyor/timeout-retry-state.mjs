/** Shared, read-only per-head retry budget for enrichment and dispatch. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ghThrottleLockRoot } from '../lib/gh-throttle.mjs';

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

export function readTimeoutBudget({ dir, ...evidence }) {
  try {
    dir ??= timeoutStateDir(); // resolved inside the guard: an unreadable lock root is "unreadable state", never a throw
    const requests = readTimeoutStates(evidence, dir).flatMap((state) => state.requests);
    // `rejected` = requests GitHub refused (4xx) or whose job was no longer failed at the evidenced attempt. They spend
    // no confirmed budget, but the planner counts them against the infra re-run cap so a persistently rejected re-run
    // reaches ci-heal instead of being re-planned forever. An early `released` reservation (a failed observation or a
    // stale head: nothing was ever sent) is transient and is NOT counted.
    return { confirmed: requests.filter((r) => r.status === 'confirmed').length,
      rejected: requests.filter((r) => r.status === 'rejected' && !r.released).length,
      pending: requests.some((r) => r.status === 'pending') };
  } catch (error) { return { pending: true, reason: `timeout-state-unreadable:${error.message}` }; }
}

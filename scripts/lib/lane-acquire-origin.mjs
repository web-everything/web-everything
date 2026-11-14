/**
 * Shared origin anchor for internal `lane-pool.mjs acquire` calls. Run from inside a lane, lane-pool refuses
 * ("acquire requires a canonical origin outside lane config") because a lane's own remote is never trusted.
 * This returns the extra argv that gives it a trusted anchor: the env `LANE_POOL_CANONICAL_ORIGIN` as `--origin`,
 * else the pool's primary checkout (found by pool name, never from lane paths) as `--reference`. From a primary: [].
 */
import { execFileSync } from 'node:child_process';
import { findPrimaryForPool, poolNameFromLanePath } from './lane-alternates.mjs';

const readOriginDefault = (dir) => {
  try { return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};

export function canonicalAcquireArgs({ repoRoot, env = process.env, findPrimary = null, readOrigin = readOriginDefault } = {}) {
  const fromEnv = env?.LANE_POOL_CANONICAL_ORIGIN?.trim();
  if (fromEnv) return [`--origin=${fromEnv}`];
  const poolName = poolNameFromLanePath(repoRoot);
  if (!poolName) return [];
  const workspaceDir = repoRoot.slice(0, repoRoot.indexOf('/.lanes/'));
  const find = findPrimary ?? ((a) => findPrimaryForPool({ ...a, readOrigin }));
  const primary = find({ workspaceDir, poolName });
  return primary?.path ? [`--reference=${primary.path}`] : [];
}

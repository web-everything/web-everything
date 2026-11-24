/** Read-only lane inventory for the shadow collector. Never invoke the allocator CLI. */
import { readdirSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import { guardedPoolRoot } from './lane-pool-paths.mjs';
import { poolNameFromLanePath } from './lane-alternates.mjs';
import { laneGitHardeningEnv, scrubGitRepoEnv } from './lane-git-hardening.mjs';
import { LEASE_FILENAME, isLeaseStale } from './lane-lease.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Validate before expiry: the allocator's tolerant stale predicate is unsafe for inventory. */
export function poolLaneLeased(lease, nowMs) {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw Error('invalid lane inventory clock');
  if (lease === null) return false;
  if (!object(lease) || typeof lease.session !== 'string' || !lease.session.trim()
    || (lease.purpose != null && typeof lease.purpose !== 'string')
    || (Object.hasOwn(lease, 'reserved') && typeof lease.reserved !== 'boolean')
    || (Object.hasOwn(lease, 'ttlMinutes') && (!Number.isFinite(lease.ttlMinutes)
      || lease.ttlMinutes <= 0 || !Number.isFinite(lease.ttlMinutes * 60000))))
    throw Error('malformed lane lease; inspect lane-pool manually');
  for (const key of ['acquiredAt', ...(Object.hasOwn(lease, 'renewedAt') ? ['renewedAt'] : [])]) {
    const value = lease[key], at = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(at) || at > nowMs || new Date(at).toISOString() !== value)
      throw Error(`invalid lane ${key}; inspect lane-pool manually`);
  }
  if (lease.renewedAt && Date.parse(lease.renewedAt) < Date.parse(lease.acquiredAt))
    throw Error('lane renewal predates acquisition; inspect lane-pool manually');
  return !isLeaseStale(lease, nowMs);
}

/** Only local git metadata reads for resolution; lane evidence uses bounded, checked JSON IO. */
export function readPoolLaneStatus({ env = process.env, nowMs = Date.now(), cwd = process.cwd(), run, readJson } = {}) {
  const options = { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    env: laneGitHardeningEnv({ ...scrubGitRepoEnv(env), GIT_OPTIONAL_LOCKS: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'] };
  const checkout = run('git', ['rev-parse', '--show-toplevel'], options).trim();
  if (!checkout) throw Error('unknown lane checkout; inspect lane-pool manually');
  const name = poolNameFromLanePath(checkout)
    ?? basename(run('git', ['config', '--get', 'remote.origin.url'], options).trim()).replace(/\.git$/, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw Error('invalid lane pool name');
  const pool = join(guardedPoolRoot(checkout, env), name);
  const entries = readdirSync(pool, { withFileTypes: true });
  if (entries.length > 20000) throw Error('oversized lane inventory; inspect lane-pool manually');
  const lanes = [];
  for (const entry of entries.filter(entry => /^lane-\d+$/.test(entry.name))) {
    if (!entry.isDirectory()) throw Error('invalid lane directory; inspect lane-pool manually');
    const path = join(pool, entry.name);
    let lease = null;
    try { lease = readJson(join(path, LEASE_FILENAME)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A disappearing directory is incomplete evidence, not a proven absent lease.
      if (!lstatSync(path).isDirectory()) throw Error('lane disappeared during inventory');
    }
    lanes.push({ path, lease, leased: poolLaneLeased(lease, nowMs) });
  }
  return { lanes };
}

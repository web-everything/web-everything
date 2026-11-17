/** Resolve a non-secret concurrency bucket without minting credentials. */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { defaultCachePath, CACHE_VERSION, REFRESH_BUFFER_MS } from './github-app-auth-env.mjs';
import { installationMap, installationForOwner, installationCachePath, ownerFromGhArgv, ownerOfSlug, ownerFromRemoteUrl } from './github-app-installations.mjs';
import { readDeliveryIdentity, shimRoleTable, roleForCaller } from './github-app-identity.mjs';

/** Shared with the generated shim (embedded with toString): role → worker → legacy. */
export function ghInstallationChain(role, roleTable, cachePath) {
  const chain = [];
  if (role !== 'legacy' && roleTable[role]) chain.push([role, roleTable[role]]);
  if (role !== 'legacy' && role !== 'worker' && roleTable.worker) chain.push(['worker', roleTable.worker]);
  chain.push(['legacy', { cachePath, installations: null }]);
  return chain;
}

/** Shared owner lookup; a role App must never borrow another App's installation map. */
export function ghInstallationForEntry(entry, owner, env, lookupOwner) {
  return entry.installations
    ? (Object.prototype.hasOwnProperty.call(entry.installations, String(owner).toLowerCase()) ? entry.installations[String(owner).toLowerCase()] : null)
    : lookupOwner(owner, env);
}

function readFreshCache(path) {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    return c?.v === CACHE_VERSION && typeof c.token === 'string' && typeof c.expiresAt === 'string'
      && Date.parse(c.expiresAt) - REFRESH_BUFFER_MS > Date.now() ? c : null;
  } catch { return null; }
}

/** Missing earlier tokens can be refreshed before the shim runs; refuse competing installations. */
export function resolveGhSlotBucket({ identity, env = {}, args = [], caller, cwd = process.cwd(), readFresh = readFreshCache, probeOrigin = spawnSync }) {
  const direct = /^app-installation-(\d+)$/.exec(identity);
  if (!direct && (identity !== 'default' || env.GH_TOKEN || env.GITHUB_TOKEN)) return { bucket: null, reason: 'unknown' };
  const delivery = readDeliveryIdentity({ env });
  const cachePath = defaultCachePath();
  const roles = shimRoleTable({ identity: delivery, cachePath });
  if (direct) {
    const known = [...Object.values(installationMap(env)), ...Object.values(roles).flatMap(entry => Object.values(entry.installations))].map(String);
    return known.includes(direct[1]) ? { bucket: direct[1], reason: 'identity' } : { bucket: null, reason: 'unknown-installation' };
  }
  let owner = ownerFromGhArgv(args) || ownerOfSlug(String(env.GH_REPO || '').split('/').slice(-2).join('/'));
  if (!owner) {
    // Match the shim's targetOwner: the child's cwd origin, never an inferred default owner.
    try {
      if (existsSync('/usr/bin/git')) {
        const result = probeOrigin('/usr/bin/git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
        if (result.status === 0) owner = ownerFromRemoteUrl(String(result.stdout || '').trim());
      }
    } catch { /* An unavailable origin leaves the call in the shared pool. */ }
  }
  if (!owner) return { bucket: null, reason: 'no-owner' };
  const role = String(env.WE_GITHUB_APP_ROLE || '').trim().toLowerCase() || roleForCaller(caller, delivery.callerRoles) || 'worker';
  const possible = new Set();
  for (const [, entry] of ghInstallationChain(role, roles, cachePath)) {
    const id = ghInstallationForEntry(entry, owner, env, installationForOwner);
    if (!/^\d+$/.test(String(id ?? ''))) continue;
    possible.add(String(id));
    if (possible.size > 1) return { bucket: null, reason: 'ambiguous' };
    let fresh = readFresh(installationCachePath(entry.cachePath, id));
    if (!fresh && !entry.installations) {
      const legacy = readFresh(cachePath);
      if (legacy && (legacy.installationId == null || String(legacy.installationId) === String(id))) fresh = legacy;
    }
    if (fresh) {
      // A stale/mismatched cache must not direct concurrency into another installation's pool.
      if (fresh.installationId != null && String(fresh.installationId) !== String(id)) return { bucket: null, reason: 'ambiguous' };
      return { bucket: String(id), reason: 'shim-cache' };
    }
  }
  return { bucket: null, reason: 'unresolved' };
}

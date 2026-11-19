/** Host-wide, advisory default-branch reads. One atomic file per GitHub host/repo,
 * outside checkouts, retained for one hour. Cache failures always leave the live
 * reader available; failed live reads retain the drain's existing hold-off warning.
 * Test/fake-GitHub processes require an explicit cache directory.
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { snapshotKey } from './pr-snapshot-store.mjs';
import { isUnderTest } from './under-test.mjs';

export const DEFAULT_BRANCH_CACHE_TTL_MS = 3_600_000;
const MAX_BYTES = 16 * 1024;
export const validDefaultBranch = name => typeof name === 'string' && !!name && name !== 'null' && !/[\s\x00-\x1f\x7f]/.test(name);

export function defaultBranchCacheFile(repo, { env = process.env } = {}) {
  const key = snapshotKey(repo);
  const host = String(env.GH_HOST || 'github.com').toLowerCase();
  if (!key || !/^[a-z0-9.-]+$/.test(host)) return null;
  const raw = String(env.WE_DEFAULT_BRANCH_CACHE_DIR || '').trim();
  if ((isUnderTest(env) || env.FAKE_GH_FIXTURE) && !raw) return null;
  const home = env.HOME || homedir();
  const root = raw ? resolve(raw.startsWith('~') ? join(home, raw.slice(1)) : raw) : join(home, '.claude', 'conveyor', 'default-branches');
  return root.split(sep).includes('.git') ? null : join(root, `${host}--${key}.json`);
}

export function cachedDefaultBranch(cached, nowMs, ttlMs = DEFAULT_BRANCH_CACHE_TTL_MS) {
  const age = nowMs - cached?.atMs;
  return Number.isFinite(cached?.atMs) && age >= 0 && age < ttlMs && validDefaultBranch(cached?.name) ? cached.name : null;
}

export function readDefaultBranchCache(repo, { env = process.env, now = Date.now } = {}) {
  try {
    const file = defaultBranchCacheFile(repo, { env });
    if (!file || statSync(file).size > MAX_BYTES) return null;
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    return cached.v === 1 && cached.repo === repo.toLowerCase() ? cachedDefaultBranch(cached, now()) : null;
  } catch { return null; }
}

export function writeDefaultBranchCache(repo, name, { env = process.env, now = Date.now, write = writeJsonAtomic } = {}) {
  try {
    const file = defaultBranchCacheFile(repo, { env });
    if (!file || !validDefaultBranch(name)) return false;
    mkdirSync(dirname(file), { recursive: true });
    write(file, { v: 1, repo: repo.toLowerCase(), name, atMs: now() });
    return true;
  } catch { return false; }
}

/** The drain's exact lookup order, with transport/cache IO injectable for hermetic probes. */
export async function resolveCachedDefaultBranch({ repo, map, key = repo, readRound = () => null,
  readCache = readDefaultBranchCache, writeCache = writeDefaultBranchCache, readLive, warn = () => {} }) {
  if (map.has(key)) return map.get(key);
  let name;
  try { name = readRound(); } catch { /* Corrupt round metadata cannot hide the other sources. */ }
  if (!validDefaultBranch(name)) {
    try { name = readCache(repo); } catch { /* Cache IO failure: read live. */ }
  }
  if (!validDefaultBranch(name)) {
    try {
      name = (await readLive()).trim();
      if (!validDefaultBranch(name)) throw new Error('default branch unreadable');
      try { writeCache(repo, name); } catch { /* Cache writes never fail a successful live read. */ }
    } catch (e) { warn(e); return null; }
  }
  map.set(key, name);
  return name;
}

/** Host-wide, advisory default-branch reads. One atomic file per GitHub host/repo,
 * outside checkouts, retained for one hour. Cache failures always leave the live
 * reader available. Hints never authorize a merge: gate-time verification is live,
 * once per repo/process, and failures defer. Test/fake-GitHub processes require an explicit cache directory.
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

/** Listing/ordering hints only. No network IO and no authority to merge. */
export async function resolveCachedDefaultBranch({ repo, map, key = repo, readRound = () => null,
  readCache = readDefaultBranchCache }) {
  if (map.has(key)) return map.get(key);
  let name;
  try { name = readRound(); } catch { /* Corrupt round metadata cannot hide the host hint. */ }
  if (!validDefaultBranch(name)) {
    try { name = readCache(repo); } catch { /* Gate-time verification remains mandatory. */ }
  }
  if (!validDefaultBranch(name)) return null;
  map.set(key, name);
  return name;
}

/** Call only after synchronous listing work. Memoize successes AND failures, so concurrent
 * admissions share one live read per repo/process. This map must never contain cache hints.
 */
export function createLiveDefaultBranchReader({ readLive, map = new Map(), writeCache = writeDefaultBranchCache,
  warn = () => {} }) {
  const pending = new Map();
  return repo => {
    if (!pending.has(repo)) pending.set(repo, (async () => {
      try {
        const raw = await readLive(repo);
        const name = typeof raw === 'string' ? raw.trim() : null;
        if (!validDefaultBranch(name)) throw new Error('default branch unreadable');
        map.set(repo, name);
        try { writeCache(repo, name); } catch { /* Cache failure cannot invalidate live evidence. */ }
        return name;
      } catch (e) { map.set(repo, null); warn(e, repo); return null; }
    })());
    return pending.get(repo);
  };
}

export function defaultBranchHold(base, liveBranch) {
  if (!validDefaultBranch(liveBranch)) return 'default branch unresolved live — deferring merge/enqueue; retry in a new drain process';
  if (typeof base !== 'string' || !base.trim()) return 'PR base branch unreadable — deferring merge/enqueue; retry with a complete live PR read';
  return base === liveBranch ? null : `base is not ${liveBranch} (${base || 'unreadable'})`;
}

/**
 * @file scripts/lib/lane-status-cache.mjs
 * @description Shared per-lane cache for `lane-pool.mjs status`'s git probe (rev-parse ×2, `status --porcelain`,
 *   rev-list). Host churn audit 2026-10-04: one full `status --json` over a 90-lane pool costs ~28 s wall and
 *   ~38 s of kernel time (a `git status` stats every one of ~10.6k tracked files per lane), and it was being run
 *   back-to-back by many independent processes — both wip publishers (`run.mjs live-state` shells it once per
 *   constellation pool, every read), the three pool health-watches, conveyor-state, the dispatch daemons. That
 *   made it the single largest `git` caller on the host (`fs_usage`: git 560k fs events / 10 s).
 *
 *   A caller that opts in (`--max-age-ms=N`, or env `WE_LANE_STATUS_MAX_AGE_MS`) RECORDS its per-lane probes here
 *   and may REUSE a row instead of re-probing, but only when BOTH hold (a default call neither reads nor writes
 *   the file — plain `status` stays strictly read-only):
 *     1. the row is younger than the caller's max age, and
 *     2. the lane's cheap git SIGNATURE is unchanged — `.git/HEAD`'s content plus the stat (mtime/size/inode)
 *        of `.git/index`, the checked-out branch ref, `refs/remotes/origin/<branch>`, and `packed-refs`. Any
 *        commit, checkout, reset, fetch, `add`, or stash rewrites one of those, so every git-level change
 *        invalidates the row at once regardless of age.
 *   The one thing the signature cannot see is an edit to a working-tree file that was never staged — so a
 *   reused `clean` can lag such an edit by at most the caller's max age. That is why the DEFAULT max age is 0
 *   (today's behaviour: always probe fresh), and only display-only readers (`live-state`, which just COUNTS
 *   free/leased/dirty for a dashboard) opt in. Anything that acts on `clean` (trim, reclaim, health-watch reap)
 *   keeps the default and always probes fresh. The lease marker is never cached — `laneStatus` reads it fresh
 *   on every call.
 */
import { readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const LANE_STATUS_CACHE_FILE = '.lane-status-cache.json';
export const LANE_STATUS_MAX_AGE_ENV = 'WE_LANE_STATUS_MAX_AGE_MS';
/** Today's behaviour: never reuse a cached row unless a caller explicitly opts in. */
export const DEFAULT_LANE_STATUS_MAX_AGE_MS = 0;

/** `--max-age-ms` flag wins, then the env knob, then the default (0 = always probe fresh). */
export function resolveStatusMaxAgeMs(flagValue, env = process.env) {
  for (const v of [flagValue, env[LANE_STATUS_MAX_AGE_ENV]]) {
    if (v === undefined || v === null || v === '' || v === true) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_LANE_STATUS_MAX_AGE_MS;
}

const statKey = (p, statFn) => {
  try {
    const s = statFn(p);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch (e) {
    return e && e.code === 'ENOENT' ? '-' : null;
  }
};

/**
 * The lane's cheap git signature, or `null` when it cannot be read (then nothing is cached or reused for it).
 * No `git` child — plain fs reads/stats only.
 * @param {string} dir lane checkout
 * @param {string} branch integration branch (e.g. `main`)
 */
export function laneGitSignature(dir, branch, { readFn = readFileSync, statFn = statSync } = {}) {
  const gitDir = join(dir, '.git');
  try {
    if (!statFn(gitDir).isDirectory()) return null; // a worktree's `.git` file — not handled, always probe
  } catch {
    return null;
  }
  let head;
  try { head = String(readFn(join(gitDir, 'HEAD'), 'utf8')).trim(); } catch { return null; }
  const parts = [head];
  const ref = /^ref: (.+)$/.exec(head);
  const paths = [
    'index',
    ...(ref ? [ref[1]] : []),
    `refs/remotes/origin/${branch}`,
    'packed-refs',
  ];
  for (const p of paths) {
    const k = statKey(join(gitDir, p), statFn);
    if (k === null) return null;
    parts.push(`${p}=${k}`);
  }
  return parts.join('|');
}

/** Read the pool's cache file; an unreadable/corrupt file reads as empty (it is only ever an optimisation). */
export function readStatusCache(poolDir, { readFn = readFileSync } = {}) {
  try {
    const j = JSON.parse(readFn(join(poolDir, LANE_STATUS_CACHE_FILE), 'utf8'));
    return j && typeof j === 'object' && j.lanes && typeof j.lanes === 'object' ? j : { lanes: {} };
  } catch {
    return { lanes: {} };
  }
}

/**
 * PURE: the cached git fields for lane `n`, or `null` when the row must be re-probed.
 * @returns {{head:string|null, branch:string|null, clean:boolean, behind:number|string}|null}
 */
export function cachedGitFields(cache, n, sig, nowMs, maxAgeMs) {
  if (!(maxAgeMs > 0) || !sig) return null;
  const row = cache && cache.lanes ? cache.lanes[String(n)] : null;
  if (!row || row.sig !== sig || typeof row.ts !== 'number') return null;
  const age = nowMs - row.ts;
  if (age < 0 || age > maxAgeMs) return null;
  return { head: row.head ?? null, branch: row.branch ?? null, clean: row.clean === true, behind: row.behind };
}

/** Merge freshly probed rows into the pool's cache file (atomic replace; best-effort — never throws). */
export function writeStatusCache(poolDir, updates, { nowMs = Date.now() } = {}) {
  const keys = Object.keys(updates || {});
  if (!keys.length) return false;
  try {
    const cur = readStatusCache(poolDir);
    for (const k of keys) cur.lanes[k] = { ...updates[k], ts: updates[k].ts ?? nowMs };
    mkdirSync(poolDir, { recursive: true });
    const file = join(poolDir, LANE_STATUS_CACHE_FILE);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, lanes: cur.lanes }));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

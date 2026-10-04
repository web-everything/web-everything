/**
 * @file scripts/lib/pr-snapshot-store.mjs
 * @description #gh-graphql-budget — the ON-DISK half of the host-shared open-PR snapshot (`pr-snapshot.mjs` is
 *   the fetch half). A LEAF module: fs/path/os only, no `gh`, so `gh-throttle.mjs` can import
 *   {@link markPrSnapshotDirty} (a successful write invalidates the snapshot) without an import cycle.
 *
 * WHY (live 2026-09-27 ~04:20-05:20Z landing freeze): the GitHub App installation's GraphQL budget (6100
 * points/hour) was exhausted every hour, ~30-40 min in, by ~10 daemons each re-listing the SAME open PRs every
 * 1-2 min across 3 repos (the fix daemon alone listed 6x per repo per tick). GitHub prices a `gh pr list` by
 * the page size it REQUESTS (`--limit`, capped at 100 per page) times the nested connections (labels, files,
 * comments, check contexts) — not by how many PRs come back — so a `--limit 200` list over 14 open PRs costs
 * the same 2-5 points as one over 100. One shared snapshot per repo, refreshed at most once per TTL with a
 * `--limit` sized to the real open count, turns ~70 list calls per tick-cycle into ~3 one-point calls.
 *
 * Layout: `<dir>/<owner>__<name>.json` = `{ v, repo, fetchedAtMs, fields:[...], limit, count, prs:[...] }`, and a
 * sibling `<owner>__<name>.dirty` (or `_all.dirty`) whose mtime marks "a write landed after this snapshot".
 */
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const PR_SNAPSHOT_VERSION = 1;
export const PR_SNAPSHOT_DIR_ENV = 'WE_PR_SNAPSHOT_DIR';
export const PR_SNAPSHOT_DISABLE_ENV = 'WE_PR_SNAPSHOT';
const ALL_DIRTY = '_all';

/**
 * Is the shared snapshot in effect for this process? OFF when `WE_PR_SNAPSHOT=0`, and OFF under a test runner
 * (`VITEST`) or a fake `gh` (`FAKE_GH_FIXTURE`, the conveyor soak/test harness) unless the caller named an
 * explicit `WE_PR_SNAPSHOT_DIR` — a fixture's fake PR list must never be cached into the REAL host snapshot
 * that live daemons read, and a test must never read a real one.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function prSnapshotEnabled(env = process.env) {
  if (String(env[PR_SNAPSHOT_DISABLE_ENV] ?? '').trim() === '0') return false;
  if (String(env[PR_SNAPSHOT_DIR_ENV] ?? '').trim()) return true;
  if (env.VITEST || env.FAKE_GH_FIXTURE) return false;
  return true;
}

/** `$WE_PR_SNAPSHOT_DIR` (a leading `~` expands) else `~/.claude/conveyor/pr-snapshot`. */
export function prSnapshotDir(env = process.env) {
  const home = env.HOME || homedir();
  const raw = String(env[PR_SNAPSHOT_DIR_ENV] ?? '').trim();
  if (raw) return resolve(raw.startsWith('~') ? join(home, raw.slice(1)) : raw);
  return join(home, '.claude', 'conveyor', 'pr-snapshot');
}

/** `web-everything/web-everything` → `web-everything__web-everything`; null for anything that is not a plain owner/name. */
export function snapshotKey(repo) {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(repo ?? '').trim());
  return m ? `${m[1].toLowerCase()}__${m[2].toLowerCase()}` : null;
}

export function snapshotPath(dir, repo) {
  const key = snapshotKey(repo);
  return key ? join(dir, `${key}.json`) : null;
}

function dirtyPath(dir, keyOrAll) {
  return join(dir, `${keyOrAll}.dirty`);
}

/** Parse a snapshot file; null when absent/corrupt/wrong version. Never throws. */
export function readSnapshotFile(path, { readFile = readFileSync } = {}) {
  if (!path) return null;
  try {
    const s = JSON.parse(readFile(path, 'utf8'));
    if (s?.v !== PR_SNAPSHOT_VERSION || !Array.isArray(s.prs) || !Array.isArray(s.fields) || !Number.isFinite(s.fetchedAtMs)) return null;
    return s;
  } catch {
    return null;
  }
}

/** Latest dirty-marker mtime (ms) that applies to `repo` (its own marker or the all-repos one); 0 if none. */
export function latestDirtyMs(dir, repo) {
  let latest = 0;
  const key = snapshotKey(repo);
  for (const k of [key, ALL_DIRTY]) {
    if (!k) continue;
    try { latest = Math.max(latest, statSync(dirtyPath(dir, k)).mtimeMs); } catch { /* no marker */ }
  }
  return latest;
}

/**
 * Mark `repo`'s snapshot (or EVERY repo's, when `repo` is null — a write from a cwd-resolved `gh` call whose
 * repo this module cannot name) as behind a write that just landed, so the next reader refreshes instead of
 * reading its own pre-write state back. Best-effort, never throws; a no-op when the snapshot is disabled.
 * @param {{repo?:string|null, env?:NodeJS.ProcessEnv, nowMs?:number}} [o]
 */
export function markPrSnapshotDirty({ repo = null, env = process.env, nowMs = Date.now() } = {}) {
  try {
    if (!prSnapshotEnabled(env)) return false;
    const dir = prSnapshotDir(env);
    if (!existsSync(dir)) return false; // nothing cached yet → nothing to invalidate
    const p = dirtyPath(dir, snapshotKey(repo) || ALL_DIRTY);
    if (!existsSync(p)) { mkdirSync(dir, { recursive: true }); writeFileSync(p, ''); }
    const t = new Date(nowMs);
    utimesSync(p, t, t);
    return true;
  } catch {
    return false;
  }
}

/** The `--repo`/`-R` slug a `gh` argv targets, or null (cwd-resolved). PURE. */
export function repoFromGhArgs(args) {
  const a = Array.isArray(args) ? args : [];
  for (let i = 0; i < a.length; i++) {
    const t = String(a[i]);
    if (t === '--repo' || t === '-R') return a[i + 1] != null ? String(a[i + 1]) : null;
    if (t.startsWith('--repo=')) return t.slice('--repo='.length);
  }
  return null;
}

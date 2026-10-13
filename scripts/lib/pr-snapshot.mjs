/**
 * @file scripts/lib/pr-snapshot.mjs
 * @description #gh-graphql-budget — ONE host-shared, cached open-PR snapshot per repo, read by every daemon/pass
 *   instead of each issuing its own `gh pr list`. See `pr-snapshot-store.mjs`'s header for the incident and the
 *   GraphQL cost model this exists to beat.
 *
 * CONTRACT for a caller (every `defaultList*`/`defaultRead*` open-PR discovery function):
 *   const shared = readSharedOpenPrs({ repo, fields });
 *   if (shared) return shared;            // served from the snapshot (fresh within the TTL)
 *   ...the caller's existing direct `gh pr list`...   // not applicable here → unchanged behaviour
 * `null` means NOT APPLICABLE — the snapshot is disabled (tests, `WE_PR_SNAPSHOT=0`), the repo is cwd-resolved
 * (no slug), a requested field is outside {@link SNAPSHOT_FIELDS}, or a concurrent refresher held the lock past
 * the wait. A FAILED refresh THROWS PrListUnreadableError (code 'pr-list-unreadable'): the direct call would hit
 * the same wall, so falling back would only double the failed spend.
 *
 * DISCOVERY ONLY: cached labels/head/comments can nominate candidates, never authorize a
 * comment-dependent mutation. GitHub CLI comment connections may contain only the first 100
 * comments; even a shorter array is cached, not proof of a complete, current thread. Writers
 * must re-read live metadata and the complete paginated thread, then recompute their plan.
 * Each composed mutation pass needs its own read, including after preceding passes write.
 * “Flags only” is a usage contract: the schema, field union and projection stay unchanged.
 * The review-hold chain enforces this boundary; other consumers need a separate inventory.
 *
 * FRESHNESS: a snapshot is served while younger than the TTL (`WE_PR_SNAPSHOT_TTL_MS`, default 75s — under the
 * 120s daemon tick, so each tick sees at most one refresh per repo) AND no write landed after it
 * (`gh-throttle.mjs` marks it dirty on every successful mutation), with a {@link DIRTY_REFRESH_FLOOR_MS} floor so
 * a burst of writes cannot turn into a refresh per write. Single-flight: one process refreshes under a file
 * lock; the rest wait for its result instead of fetching in parallel.
 *
 * COST: refreshes use small GraphQL pages configured by `prListPaging` (see pr-list-paged.mjs), without
 * comments/body/files. Per-PR `gh pr view` hydrates those heavy fields only when their cached identity or age
 * is stale; unchanged PRs reuse the previous snapshot's heavy fields.
 */
import { isUnderTest } from './under-test.mjs';
import { isGhDeferred } from './gh-deferred.mjs';
import { listOpenPrsLightPaged, hydrateHeavyFields, resolvePrListPaging } from './pr-list-paged.mjs';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { execFileSyncThrottled, deriveGhCaller, ghThrottleLockRoot, ghThrottleLogPath, recordGhCallLogEntry } from './gh-throttle.mjs';
import {
  PR_SNAPSHOT_VERSION, prSnapshotEnabled, prSnapshotDir, snapshotKey, snapshotPath, readSnapshotFile, latestDirtyMs,
} from './pr-snapshot-store.mjs';

/** The union of every open-PR reader's projected fields. Light fields come from GraphQL pages;
 *  comments/body/files come from cached per-PR hydration. */
export const SNAPSHOT_FIELDS = Object.freeze([
  'number', 'title', 'body', 'url', 'isDraft', 'createdAt', 'updatedAt',
  'headRefName', 'headRefOid', 'baseRefName', 'isCrossRepository', 'mergeable', 'mergeStateStatus', 'reviewDecision',
  'labels', 'files', 'comments', 'statusCheckRollup',
]);

export const DEFAULT_TTL_MS = 75_000;
/** Minimum age before a DIRTY snapshot is refreshed — bounds refresh spend under a write burst. */
export const DIRTY_REFRESH_FLOOR_MS = 10_000;
export const MIN_LIMIT = 25;
export const MAX_LIMIT = 500;
// Cold per-PR hydration can exceed 45s; wait longer to avoid a caller's heavy direct-read fallback (504s).
const LOCK_WAIT_MS = 90_000;
const LOCK_STALE_MS = 120_000;

export function resolveTtlMs(env = process.env) {
  const n = Number(env.WE_PR_SNAPSHOT_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_TTL_MS;
}

/** The `--limit` for the next refresh: last seen open count + headroom, rounded up to 5, at least MIN_LIMIT. PURE. */
export function nextLimit(prevCount) {
  const n = Number.isFinite(prevCount) && prevCount > 0 ? prevCount : 0;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.ceil((n + 10) / 5) * 5));
}

/** Is `snap` servable for `fields` at `nowMs`? PURE. */
export function isServable(snap, { fields, nowMs, ttlMs, dirtyMs = 0 }) {
  if (!snap) return false;
  const have = new Set(snap.fields);
  if (!fields.every((f) => have.has(f))) return false;
  const age = nowMs - snap.fetchedAtMs;
  if (age < 0 || age >= ttlMs) return false;
  if (dirtyMs > snap.fetchedAtMs && age >= DIRTY_REFRESH_FLOOR_MS) return false;
  return true;
}

/** Project each PR to just `fields` — a caller sees the exact shape its own `--json` would have returned. PURE. */
export function projectPrs(prs, fields) {
  return prs.map((p) => {
    const o = {};
    for (const f of fields) if (p && Object.prototype.hasOwnProperty.call(p, f)) o[f] = p[f];
    return o;
  });
}

function normalizeFields(fields) {
  const list = Array.isArray(fields) ? fields : String(fields || '').split(',');
  return [...new Set(list.map((f) => String(f).trim()).filter(Boolean))];
}

/** Fetch complete light pages and hydrate stale heavy fields. Failed reads throw PrListUnreadableError. */
export function fetchSnapshot({ repo, prevCount, prev = null, exec = execFileSyncThrottled, nowMs = Date.now(),
  deferrable = false, env = process.env, paging = resolvePrListPaging({ env }) }) {
  const light = listOpenPrsLightPaged({ repo, exec, pageSize: paging.pageSize, pageRetries: paging.pageRetries,
    maxRows: MAX_LIMIT, execOpts: { throttle: { op: 'pr list (snapshot page)', deferrable } } });
  if (light.deferred) return light.deferred;
  const cache = {};
  for (const p of prev?.prs ?? []) {
    if (prev.heavyMeta?.[p.number]) {
      cache[p.number] = { ...prev.heavyMeta[p.number], comments: p.comments, body: p.body, files: p.files };
    }
  }
  const heavy = hydrateHeavyFields({ repo, rows: light.rows, exec, cache, nowMs,
    maxAgeMs: paging.heavyMaxAgeSeconds * 1000, execOpts: { throttle: { op: 'pr view (snapshot hydrate)' } } });
  const heavyMeta = Object.fromEntries(Object.entries(heavy.cache).map(([n, { updatedAt, headRefOid, fetchedAtMs }]) =>
    [n, { updatedAt, headRefOid, fetchedAtMs }]));
  return { v: PR_SNAPSHOT_VERSION, repo, fetchedAtMs: nowMs, fields: [...SNAPSHOT_FIELDS], limit: MAX_LIMIT,
    count: heavy.rows.length, truncated: light.truncated, prs: heavy.rows, heavyMeta,
    paging: { pageSize: paging.pageSize, source: paging.source?.pageSize ?? 'standard', pages: light.pages,
      bytes: light.bytes, ms: light.ms, hydrated: heavy.fetched, reused: heavy.reused } };
}

function logSnapshot(env, entry) {
  // Never append to the REAL host call log from a test run (only an explicitly isolated lock root).
  if ((isUnderTest(env) || env.FAKE_GH_FIXTURE) && !env.WE_GH_THROTTLE_LOCK_ROOT && !env.LANE_POOL_ROOT) return;
  try { recordGhCallLogEntry(ghThrottleLogPath(ghThrottleLockRoot(undefined, env)), { op: 'pr list (snapshot)', ...entry }); } catch { /* best-effort */ }
}

function logHit(env, caller, repo) {
  logSnapshot(env, { outcome: 'snapshot_hit', repo, caller });
}

/**
 * The shared open-PR read. Returns the projected PR array, or `null` when not applicable (see the file header).
 * @param {{repo:string|null, fields:string|string[], env?:NodeJS.ProcessEnv, nowMs?:number, exec?:Function,
 *   dir?:string, ttlMs?:number, caller?:string, lockWaitMs?:number, allowDeferred?:boolean, paging?:object}} o
 *   `allowDeferred`: opt in to receiving the truthy `{outcome:'deferred-low-budget'}` object (the caller MUST
 *   check `isGhDeferred`); by default a deferral returns `null`, keeping the `Array|null` contract for every reader.
 * @returns {Array<object>|null}
 */
export function readSharedOpenPrs({
  repo, fields, env = process.env, now = () => Date.now(), exec = execFileSyncThrottled,
  dir = null, ttlMs = null, caller = null, lockWaitMs = LOCK_WAIT_MS, allowDeferred = false, cacheOnly = false,
  paging = null,
} = {}) {
  if (!prSnapshotEnabled(env) && !dir) return null;
  if (!snapshotKey(repo)) return null;
  const want = normalizeFields(fields);
  if (!want.length || !want.every((f) => SNAPSHOT_FIELDS.includes(f))) return null;
  const root = dir || prSnapshotDir(env);
  const path = snapshotPath(root, repo);
  const ttl = ttlMs != null ? ttlMs : resolveTtlMs(env);
  const who = caller || deriveGhCaller({}, env);

  const servable = () => {
    const snap = readSnapshotFile(path);
    return isServable(snap, { fields: want, nowMs: now(), ttlMs: ttl, dirtyMs: latestDirtyMs(root, repo) }) ? snap : null;
  };

  const hit = servable();
  if (hit) { logHit(env, who, repo); return projectPrs(hit.prs, want); }

  if (cacheOnly) return null;
  mkdirSync(root, { recursive: true });
  let result = null;
  try {
    result = withFileLock(join(root, `${snapshotKey(repo)}.lock`), () => {
      const again = servable(); // a concurrent refresher finished while we waited for the lock
      if (again) return { snap: again, fetched: false };
      const prev = readSnapshotFile(path);
      const snap = fetchSnapshot({ repo, prevCount: prev?.count, prev, exec, nowMs: now(), deferrable: allowDeferred, paging: paging ?? resolvePrListPaging({ env }), env });
      if (isGhDeferred(snap)) return { deferred: snap };
      writeJsonAtomic(path, snap);
      return { snap, fetched: true };
    }, { timeoutMs: lockWaitMs, staleMs: LOCK_STALE_MS });
  } catch (e) {
    if (/withFileLock: timed out/.test(String(e?.message))) return null; // a stuck refresher → caller's direct read
    throw e;
  }
  if (result.deferred) return allowDeferred ? result.deferred : null;
  if (!result.fetched) logHit(env, who, repo);
  else {
    const { pages, pageSize, source, bytes, ms, hydrated, reused } = result.snap.paging;
    logSnapshot(env, { outcome: 'paged', repo, caller: who, pages, pageSize, pageSizeSource: source,
      bytes, ms, hydrated, reused, count: result.snap.count });
  }
  return projectPrs(result.snap.prs, want);
}

/** The last snapshot's open-PR count for `repo` (no gh call, any age), or null when there is none / disabled. */
export function snapshotOpenCount(repo, { env = process.env, dir = null } = {}) {
  if (!prSnapshotEnabled(env) && !dir) return null;
  const snap = readSnapshotFile(snapshotPath(dir || prSnapshotDir(env), repo));
  return snap && Number.isFinite(snap.count) && !snap.truncated ? snap.count : null;
}

// ── per-(repo, PR, head SHA) read cache — for reads that are FIXED by the head SHA (a PR's commit list) ─────────

const SHA_RE = /^[0-9a-f]{7,64}$/i;
const SHA_CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

function shaCachePath(root, { repo, num, sha, kind }) {
  const key = snapshotKey(repo);
  if (!key || !Number.isInteger(Number(num)) || !SHA_RE.test(String(sha || '')) || !/^[a-z-]+$/.test(kind)) return null;
  return join(root, 'by-sha', `${key}-${Number(num)}-${String(sha).toLowerCase()}-${kind}.json`);
}

/** A cached value for (repo, PR, head SHA, kind), or undefined. Never throws; undefined when disabled. */
export function readShaCache({ repo, num, sha, kind, env = process.env, dir = null } = {}) {
  if (!prSnapshotEnabled(env) && !dir) return undefined;
  const p = shaCachePath(dir || prSnapshotDir(env), { repo, num, sha, kind });
  if (!p) return undefined;
  try { return JSON.parse(readFileSync(p, 'utf8')).value; } catch { return undefined; }
}

/** Persist a SUCCESSFUL read for (repo, PR, head SHA, kind); prunes entries older than 3 days now and then.
 *  Best-effort, never throws; a no-op when disabled or the SHA is unknown. */
export function writeShaCache({ repo, num, sha, kind, value, env = process.env, dir = null, nowMs = Date.now() } = {}) {
  try {
    if (!prSnapshotEnabled(env) && !dir) return false;
    const root = dir || prSnapshotDir(env);
    const p = shaCachePath(root, { repo, num, sha, kind });
    if (!p) return false;
    mkdirSync(join(root, 'by-sha'), { recursive: true });
    writeJsonAtomic(p, { at: nowMs, value });
    if (Math.random() < 0.05) {
      for (const f of readdirSync(join(root, 'by-sha'))) {
        const fp = join(root, 'by-sha', f);
        try { if (nowMs - statSync(fp).mtimeMs > SHA_CACHE_MAX_AGE_MS) unlinkSync(fp); } catch { /* raced */ }
      }
    }
    return true;
  } catch {
    return false;
  }
}

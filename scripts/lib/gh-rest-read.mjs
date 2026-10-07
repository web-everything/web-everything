/**
 * @file scripts/lib/gh-rest-read.mjs
 * @description #4351 — the shared REST read path with ETag CONDITIONAL REQUESTS. A caller moving a GraphQL-shaped
 *   read (`gh pr list/view --json …`) onto REST (`gh api repos/…`) goes through here so it spends the `core`
 *   bucket instead of the `graphql` one (separate primary buckets — the 2026-09-28 drain stop exhausted GraphQL
 *   while `core` sat at 6100/6100), and so an UNCHANGED answer costs nothing at all.
 *
 * MECHANISM: every GET is sent as `gh api -i [-H 'If-None-Match: <etag>'] <path>` through the shared throttle
 *   (`execFileSyncThrottled`), with the last ETag + body cached on disk, keyed by path + auth identity (+ the
 *   caller's repo context when the path leans on gh's `{owner}/{repo}` cwd resolution). GitHub answers an
 *   unchanged resource with `304 Not Modified`, which does NOT count against the REST limit (verified live
 *   2026-09-29: three back-to-back 304s left `X-Ratelimit-Used` unchanged). `gh api` exits 1 on a 304 (stderr
 *   `gh: HTTP 304`) but still prints the status line + headers to stdout under `-i`, so the 304 arrives here as
 *   a thrown error whose `.stdout` says 304 — served from the cache. Any OTHER failure is re-thrown unchanged,
 *   so a converted caller keeps `runGhSync`'s thrown-error contract.
 *
 * ENABLED unless `WE_GH_ETAG_CACHE=0`; off under vitest/fake-gh fixtures unless a dir is given (explicit `dir`
 *   or `WE_GH_ETAG_DIR`) — same discipline as `pr-snapshot-store.mjs#prSnapshotEnabled`. Disabled means plain
 *   unconditional REST GETs, never a failure.
 *
 * Follow-up (not here): webhook-driven invalidation of the cache.
 */
import { isUnderTest } from './under-test.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import {
  execFileSyncThrottled, ghAuthIdentity, deriveGhCaller, ghThrottleLockRoot, ghThrottleLogPath, recordGhCallLogEntry,
} from './gh-throttle.mjs';

export const GH_ETAG_DISABLE_ENV = 'WE_GH_ETAG_CACHE';
export const GH_ETAG_DIR_ENV = 'WE_GH_ETAG_DIR';
const CACHE_VERSION = 1;

export function ghEtagCacheEnabled(env = process.env) {
  if (String(env[GH_ETAG_DISABLE_ENV] ?? '').trim() === '0') return false;
  if (String(env[GH_ETAG_DIR_ENV] ?? '').trim()) return true;
  if (isUnderTest(env) || env.FAKE_GH_FIXTURE) return false;
  return true;
}

/** `$WE_GH_ETAG_DIR` (a leading `~` expands) else `~/.claude/conveyor/gh-etag`. */
export function ghEtagCacheDir(env = process.env) {
  const raw = String(env[GH_ETAG_DIR_ENV] ?? '').trim();
  const home = env.HOME || homedir();
  if (raw) return raw.startsWith('~') ? join(home, raw.slice(1)) : raw;
  return join(home, '.claude', 'conveyor', 'gh-etag');
}

/** The cache file for (path, identity, context). PURE. */
export function etagCachePath(dir, { path, identity, context = '' }) {
  const key = createHash('sha256').update(`${identity}\0${context}\0${path}`).digest('hex').slice(0, 32);
  return join(dir, `${key}.json`);
}

/**
 * Split `gh api -i` output into `{ status, headers, body }`. PURE. Output with no leading `HTTP/` status line
 * (a PATH-faked `gh` that only echoes a body) is read as a bare 200 body, so hermetic fakes keep working.
 * Header names are lower-cased.
 */
export function parseGhApiIncludeOutput(text) {
  const s = String(text ?? '');
  if (!/^HTTP\/\S+ \d{3}/.test(s)) return { status: 200, headers: {}, body: s };
  const m = /\r?\n\r?\n/.exec(s);
  const head = m ? s.slice(0, m.index) : s;
  const body = m ? s.slice(m.index + m[0].length) : '';
  const lines = head.split(/\r?\n/);
  const status = Number(/^HTTP\/\S+ (\d{3})/.exec(lines[0])[1]);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status, headers, body };
}

function parseJsonBody(body) {
  return JSON.parse(body || 'null');
}

function readCache(file) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return c && c.v === CACHE_VERSION && typeof c.etag === 'string' && typeof c.body === 'string' ? c : null;
  } catch {
    return null;
  }
}

function logNotModified(env, entry) {
  // Never append to the REAL host call log from a test run (only an explicitly isolated lock root).
  if ((isUnderTest(env) || env.FAKE_GH_FIXTURE) && !env.WE_GH_THROTTLE_LOCK_ROOT && !env.LANE_POOL_ROOT) return;
  try { recordGhCallLogEntry(ghThrottleLogPath(ghThrottleLockRoot(undefined, env)), { ...entry, outcome: 'not_modified', resource: 'core' }); } catch { /* best-effort */ }
}

/**
 * ONE conditional REST GET, parsed as JSON. Returns `{ status: 200|304, json, etag, notModified }`; throws the
 * underlying `gh` error unchanged for anything that is not a 2xx or a cache-served 304.
 * @param {string} path  a `gh api` endpoint (`repos/o/r/pulls?state=all`, or with `{owner}/{repo}` placeholders)
 * @param {{exec?:Function, env?:NodeJS.ProcessEnv, dir?:string|null, context?:string, op?:string,
 *   caller?:string, execOpts?:object, now?:()=>number}} [o]
 *   `context` — extra cache-key text; REQUIRED in spirit when `path` uses `{owner}/{repo}` (pass the cwd), so
 *   two checkouts of different repos never share an entry.
 */
export function ghRestGetJson(path, {
  exec = execFileSyncThrottled, env = process.env, dir = null, context = '', op = null, caller = null,
  execOpts = {}, now = () => Date.now(),
} = {}) {
  if (String(path).startsWith('repos/')) {
    const [, owner, rawRepo, ...suffix] = String(path).split('/');
    // A query on the repository itself is valid; delimiters inside a segment are not.
    const repo = suffix.length === 0 ? rawRepo?.split('?')[0] : rawRepo;
    const valid = (segment, placeholder) => segment === placeholder
      || (typeof segment === 'string' && /^[\w.-]+$/.test(segment) && segment !== '.' && segment !== '..');
    if (!valid(owner, '{owner}') || !valid(repo, '{repo}')) {
      throw new TypeError('Invalid REST repository endpoint');
    }
  }
  const enabled = !!dir || ghEtagCacheEnabled(env);
  const root = dir || ghEtagCacheDir(env);
  const identity = ghAuthIdentity(execOpts.env || env);
  const file = enabled ? etagCachePath(root, { path, identity, context }) : null;
  const opLabel = op || `rest ${String(path).split('?')[0].replace(/^repos\/[^/]+\/[^/]+\//, '')}`;
  const run = (etag) => {
    const argv = ['api', '-i', ...(etag ? ['-H', `If-None-Match: ${etag}`] : []), path];
    try {
      return parseGhApiIncludeOutput(exec('gh', argv, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
        killSignal: 'SIGKILL', ...execOpts, throttle: { op: opLabel },
      }));
    } catch (e) {
      const parsed = parseGhApiIncludeOutput(e && e.stdout);
      if (etag && parsed.status === 304) return parsed;
      throw e;
    }
  };

  const cached = file ? readCache(file) : null;
  let res = run(cached ? cached.etag : null);
  if (res.status === 304) {
    logNotModified(env, { op: opLabel, caller: caller || deriveGhCaller({}, env), id: identity });
    return { status: 304, json: parseJsonBody(cached.body), etag: cached.etag, notModified: true };
  }
  const json = parseJsonBody(res.body);
  const etag = res.headers.etag || null;
  if (file && etag) {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      writeJsonAtomic(file, { v: CACHE_VERSION, path, identity, context, etag, fetchedAtMs: now(), body: res.body }, { mode: 0o600 });
    } catch { /* best-effort — a cache write failure only costs the next call a full 200 */ }
  }
  return { status: res.status, json, etag, notModified: false };
}

/**
 * A page-numbered REST list (`per_page`/`page`), each page its own conditional GET, concatenated until a short
 * page or `maxItems`. Returns the item array. Throws like {@link ghRestGetJson}.
 * @param {string} path
 * @param {{perPage?:number, maxItems?:number} & Parameters<typeof ghRestGetJson>[1]} [o]
 */
export function ghRestGetPaged(path, { perPage = 100, maxItems = 500, ...o } = {}) {
  const out = [];
  const sep = String(path).includes('?') ? '&' : '?';
  for (let page = 1; out.length < maxItems; page += 1) {
    const { json } = ghRestGetJson(`${path}${sep}per_page=${perPage}&page=${page}`, o);
    const items = Array.isArray(json) ? json : [];
    out.push(...items);
    if (items.length < perPage) break;
  }
  return out.slice(0, maxItems);
}

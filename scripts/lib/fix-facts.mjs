/**
 * @file scripts/lib/fix-facts.mjs
 * @description perf item C1d — the FIX DISPATCHER's cheaper PR reads. The fix-dispatch daemon's timeout-evidence
 * collector (`reconcile-pass.mjs#readTimeoutEvidence`) re-read, for every red PR on every tick, `pulls/<n>`,
 * `pulls/<n>/files`, the head's check-runs and status, the failing run, job and job log: ~14k core API calls a day
 * for facts that almost never change. It hit the 5000/h core limit on 2026-10-06 (`gh-throttle: ... rate limit exceeded`).
 *
 * Three layers, safest first (mirrors the review daemon's {@link ./review-facts.mjs}, perf C1c):
 *   1. FACTS FIRST (head SHA, state). A fresh store row (shared PR-facts reader, perf C1b) that says "closed" or
 *      "head moved" refuses the dispatch with 0 GitHub calls. A stale/partial/unhealthy store returns `null` and the
 *      caller reads GitHub exactly as before. Facts only ever REFUSE earlier; an "agreeing" row never replaces a live
 *      read, so a stale row can delay a re-run by one tick at worst and never cause one.
 *   2. ETAG. Every other JSON `repos/...` GET goes through `ghRestGetJson`: a `304 Not Modified` is free against the
 *      core limit and is still an authoritative live answer (GitHub itself says "unchanged").
 *   3. IMMUTABLE CACHE (`readShaCache`/`writeShaCache`): a COMPLETED job, its log, and the file list at one
 *      (head, base) never change. In-progress jobs are never cached. A run is NOT cached by id: a re-run reuses the
 *      run id with a new attempt, so it stays on ETag.
 *
 * NEVER A COMMENT READ, NEVER A MERGE INPUT. Comment reads (#4091's full re-read) stay on GitHub. The drain and the
 * label writer never import this module (pinned by `__tests__/fix-facts.test.mjs`).
 *
 * DECLARED SETTING: `WE_FIX_FACTS=0` turns all three layers off (every read → plain `gh api`, byte for byte as
 * before). `WE_PR_FACTS=0` / `WE_PR_FACTS_TTL_MS` (shared reader) and `WE_GH_ETAG_CACHE=0` apply as well.
 */
import { lookupReviewFacts, warmReviewFacts } from './review-facts.mjs';
import { ghRestGetJson } from './gh-rest-read.mjs';
import { readShaCache, writeShaCache } from './pr-snapshot.mjs';
import { execFileSyncThrottled } from './gh-throttle.mjs';

export const FIX_FACTS_ENV = 'WE_FIX_FACTS';
export const FIX_FACTS_CALLER = 'reconcile-fix-dispatch-daemon.mjs';
export const fixFactsEnabled = (env = process.env) => String(env[FIX_FACTS_ENV] ?? '').trim() !== '0';

/** Per-tick counters; the daemon logs and resets them with {@link takeFixReadStats}. */
const stats = { factsStore: 0, factsGithub: 0, cacheHit: 0, notModified: 0, live: 0, reasons: {} };
export function takeFixReadStats() {
  const out = { ...stats, reasons: { ...stats.reasons } };
  Object.assign(stats, { factsStore: 0, factsGithub: 0, cacheHit: 0, notModified: 0, live: 0, reasons: {} });
  return out;
}
export const formatFixReadStats = (s) => `facts store=${s.factsStore} github=${s.factsGithub}`
  + `${Object.keys(s.reasons).length ? ` (${Object.entries(s.reasons).map(([k, v]) => `${k}:${v}`).join(',')})` : ''}`
  + ` cache_hit=${s.cacheHit} not_modified=${s.notModified} live=${s.live}`;

/** Once per tick: refresh the host-shared facts mirror from the Worker (never GitHub). Best-effort; never throws. */
export const warmFixFacts = (repos, o = {}) => warmReviewFacts(repos, { ...o, switchEnv: FIX_FACTS_ENV });

/**
 * Facts-first head/state gate for one PR. Returns `{ stale:true, reason }` ONLY when a trustworthy store row proves
 * the dispatch is moot (PR no longer open, or its head differs from the head the pass read); otherwise `{ stale:false }`
 * (store agreed, or store unusable → the caller proceeds with its live reads).
 */
export function checkFixFacts({ repo, number, head, env = process.env, lookup = lookupReviewFacts } = {}) {
  if (!fixFactsEnabled(env)) return { stale: false, source: 'github', reason: `${FIX_FACTS_ENV}=0` };
  const hit = lookup({ repo, number, env, caller: FIX_FACTS_CALLER, switchEnv: FIX_FACTS_ENV });
  if (!hit?.facts) {
    stats.factsGithub += 1;
    stats.reasons[hit?.reason ?? 'unknown'] = (stats.reasons[hit?.reason ?? 'unknown'] || 0) + 1;
    return { stale: false, source: 'github', reason: hit?.reason ?? 'unknown' };
  }
  stats.factsStore += 1;
  const f = hit.facts;
  if (f.state !== 'open' || f.merged) return { stale: true, source: 'store', reason: 'stale-head' };
  if (head && f.headSha && String(f.headSha).toLowerCase() !== String(head).toLowerCase()) return { stale: true, source: 'store', reason: 'stale-head' };
  return { stale: false, source: 'store', reason: 'served' };
}

const MAX_CACHED_LOG_BYTES = 4 * 1024 * 1024;
const FILES_RE = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files\?per_page=100&page=(\d+)$/;
const JOB_RE = /^repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)$/;

/**
 * Build the `api(path, raw?)` reader `readTimeoutEvidence` uses. With the setting off (or `rest` unavailable) it is the
 * old plain `gh api <path>`. `exec`/`rest`/`cacheDir` are injectable so a test counts every GitHub call.
 */
export function makeFixEvidenceReader({ repo, pr, head, exec = execFileSyncThrottled, deadline = Infinity, env = process.env, rest = ghRestGetJson, cacheDir = null } = {}) {
  const enabled = fixFactsEnabled(env);
  const remaining = () => { const left = deadline - Date.now(); if (left <= 0) throw new Error('evidence-read-deadline'); return left; };
  const plain = (path, raw) => {
    const value = exec('gh', ['api', path], { encoding: 'utf8', timeout: remaining(), maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    stats.live += 1;
    return raw ? String(value) : JSON.parse(value);
  };
  if (!enabled) return { api: plain, readLog: (job) => plain(`repos/${repo}/actions/jobs/${job.id}/logs`, true), enabled };
  const cacheOpts = { repo, num: pr, sha: head, env, ...(cacheDir ? { dir: cacheDir } : {}) };
  let baseSha = null; // remembered from the pulls/<n> read, part of the file-list cache's validity
  const restJson = (path) => {
    const r = rest(path, { exec, env, caller: FIX_FACTS_CALLER, execOpts: { timeout: remaining() }, ...(cacheDir ? { dir: cacheDir } : {}) });
    if (r.notModified) stats.notModified += 1; else stats.live += 1;
    return r.json;
  };
  const api = (path, raw = false) => {
    const jobId = JOB_RE.exec(path)?.[1];
    if (jobId) {
      const hit = readShaCache({ ...cacheOpts, num: Number(jobId), kind: 'job' });
      if (hit && hit.status === 'completed') { stats.cacheHit += 1; return hit; }
      const job = restJson(path);
      if (job?.status === 'completed') writeShaCache({ ...cacheOpts, num: Number(job.id), kind: 'job', value: job });
      return job;
    }
    const filesPage = FILES_RE.exec(path);
    if (filesPage) {
      // The whole list is cached as ONE value at (head, base): page 1 serves it, later pages are empty by design.
      const hit = readShaCache({ ...cacheOpts, kind: 'files' });
      if (hit && hit.base && hit.base === baseSha && Array.isArray(hit.changed)) {
        stats.cacheHit += 1;
        const page = Number(filesPage[2]);
        return hit.changed.slice((page - 1) * 100, page * 100);
      }
      const batch = restJson(path);
      if (Number(filesPage[2]) === 1 && Array.isArray(batch) && batch.length < 100 && baseSha) {
        writeShaCache({ ...cacheOpts, kind: 'files', value: { base: baseSha, changed: batch } });
      }
      return batch;
    }
    if (raw) return plain(path, true);
    const json = restJson(path);
    if (/\/pulls\/\d+$/.test(path) && json?.base?.sha) baseSha ??= json.base.sha;
    return json;
  };
  // A job log is immutable once its job is COMPLETED: serve it from the cache, else read it live and cache it.
  const readLog = (job) => {
    const hit = readShaCache({ ...cacheOpts, num: Number(job.id), kind: 'job-log' });
    if (typeof hit === 'string') { stats.cacheHit += 1; return hit; }
    const log = plain(`repos/${repo}/actions/jobs/${job.id}/logs`, true);
    if (job.status === 'completed' && Buffer.byteLength(log) <= MAX_CACHED_LOG_BYTES) {
      writeShaCache({ ...cacheOpts, num: Number(job.id), kind: 'job-log', value: log });
    }
    return log;
  };
  return { api, readLog, enabled };
}


#!/usr/bin/env node
/**
 * @file scripts/lib/pr-facts.mjs
 * @description THE shared PR-facts reader (perf item C1b): per-PR GitHub facts (head SHA, draft, state, merged,
 * labels, completed checks/suites, last review) served from the #4281 webhook store instead of each daemon
 * re-fetching them from GitHub every tick (165,587 GitHub calls in 24 h; the API limit was hit on 2026-10-05).
 *
 * ONE STORE, NOT TWO. This module is the only client of the Durable Object's `GET /prs` projection. The #3007
 * ledger's `derivePrState(events, facts, settings)` takes its `facts` from {@link readPrFacts} — there is no second
 * facts client and no second facts store. The local mirror below is a disposable cache of the Durable Object,
 * rebuildable from `/prs` at any time; it never holds judgments (verdicts, holds, rulings stay on the ledger).
 *
 * NEVER A MERGE GATE INPUT. `merge-ai-prs.mjs`, `pr-merge-gate.mjs`, `pr-land.mjs` and `review-set-label.mjs` never
 * import this module: the drain re-reads live state itself before each merge (`#event-driven-land-is-wake-only`),
 * and any read that leads to a label WRITE re-reads live. Pinned by `__tests__/pr-facts-merge-gate-isolation.test.mjs`.
 *
 * CONTRACT for a caller (same shape as `readSharedOpenPrs`):
 *   const facts = await readPrFacts({ repo, number, caller });
 *   if (facts) use(facts);              // served from the store — trustworthy right now
 *   else ...the caller's existing gh read...   // null = not applicable: fall back, unchanged behaviour
 * Or {@link readPrFactsOrGithub}, which does the fallback itself and reports `source: 'store' | 'github'` + why.
 *
 * SERVED ONLY WHEN TRUSTWORTHY — all of these must hold, else `null`:
 *   • the feed is `healthy` (`classifyFeedHealth`: the Worker answered last, and delivered within `staleAfterMs`);
 *   • the repo has a bootstrap baseline with `status: 'complete'` (so a missing open PR is a real miss, not a hole);
 *   • the PR row exists and is complete (head SHA, state, draft and labels all observed);
 *   • the mirror was refreshed less than `ttlMs` ago (THE staleness setting: `WE_PR_FACTS_TTL_MS`, default 120 s).
 *
 * MIRROR. One host-shared file per repo under `~/.claude/conveyor/pr-facts/` (`WE_PR_FACTS_DIR`). A refresh (at
 * most every `refreshAfterMs`, single-flight under a lock file) reads `/events?cursor=` deltas and folds them with
 * the Worker's OWN fold (`foldObservation`), so the mirror and the Durable Object can never disagree on a rule. A
 * `gap` or `reset` (or a delta that will not drain within `maxDeltaPages`) forces a full `/prs` pull.
 *
 * NOT SERVED (stay on gh): comments, files, bodies, mergeability, in-progress checks. `checks`/`suites` list
 * COMPLETED runs on the current head only — the webhook stores only completed runs, so absence never means green.
 *
 * Config reuses the pr-events read token (`WE_PR_EVENTS_URL` + `WE_PR_EVENTS_TOKEN_FILE`/`WE_PR_EVENTS_TOKEN`); no
 * new secret. `WE_PR_FACTS=0` turns the store off (every read → null → gh). Never logs the token.
 *
 * CLI: node scripts/lib/pr-facts.mjs <owner/repo> <number>   → prints `{ source, reason, facts }`
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { execFileSyncThrottled, deriveGhCaller, ghThrottleLockRoot, ghThrottleLogPath, recordGhCallLogEntry } from './gh-throttle.mjs';
import { PR_EVENTS_DEFAULTS, PR_EVENTS_FLAG_ENV, classifyFeedHealth, resolvePrEventsConfig } from './pr-events.mjs';
import { checkProjectionKey, foldObservation, projectPrRows } from '../conveyor/pr-events-worker/core.mjs';

export const PR_FACTS_VERSION = 1;
export const PR_FACTS_DISABLE_ENV = 'WE_PR_FACTS';
export const PR_FACTS_DIR_ENV = 'WE_PR_FACTS_DIR';
export const PR_FACTS_TTL_ENV = 'WE_PR_FACTS_TTL_MS';
export const PR_FACTS_REFRESH_ENV = 'WE_PR_FACTS_REFRESH_MS';

/** The declared settings. `ttlMs` is the staleness bound: an answer older than this is never served. */
export const PR_FACTS_DEFAULTS = Object.freeze({
  ttlMs: 120_000,          // mirror older than this → null → the caller reads GitHub
  refreshAfterMs: 15_000,  // mirror older than this → refresh from the Worker first (a Worker call, no GitHub budget)
  staleAfterMs: PR_EVENTS_DEFAULTS.staleAfterMs, // no webhook delivery for this long → feed 'stale' → null
  maxDeltaPages: 5,        // a backlog deeper than this many /events pages → one full /prs pull instead
  pageLimit: 500,
  timeoutMs: PR_EVENTS_DEFAULTS.timeoutMs,
  lockWaitMs: 10_000,
  lockStaleMs: 60_000,
});

/** The facts fields the store serves; everything else stays on gh. */
export const PR_FACTS_FIELDS = Object.freeze(['headSha', 'draft', 'state', 'merged', 'labels', 'checks', 'suites', 'review']);

const num = (v, d) => { const n = Number(v); return v != null && String(v).trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };

export function prFactsDir(env = process.env) {
  const home = env.HOME || homedir();
  const raw = String(env[PR_FACTS_DIR_ENV] ?? '').trim();
  if (raw) return resolve(raw.startsWith('~') ? join(home, raw.slice(1)) : raw);
  return join(home, '.claude', 'conveyor', 'pr-facts');
}

/** Endpoint + token (shared with pr-events) + settings. `enabled` needs URL + token and no `WE_PR_FACTS=0`. */
export function resolvePrFactsConfig(env = process.env, { readFile = readFileSync } = {}) {
  const ev = resolvePrEventsConfig({ ...env, [PR_EVENTS_FLAG_ENV]: '1' }, { readFile });
  const off = String(env[PR_FACTS_DISABLE_ENV] ?? '').trim() === '0';
  // A test run never reaches a real Worker unless it opts in explicitly.
  const testOff = !!(env.VITEST || env.FAKE_GH_FIXTURE) && String(env[PR_FACTS_DISABLE_ENV] ?? '').trim() !== '1';
  return {
    enabled: !off && !testOff && ev.enabled, url: ev.url, token: ev.token, dir: prFactsDir(env),
    disabledReason: off ? `${PR_FACTS_DISABLE_ENV}=0` : testOff ? 'test run' : ev.enabled ? null : `not configured (missing ${ev.missing.join(', ') || ev.tokenError})`,
    ttlMs: num(env[PR_FACTS_TTL_ENV], PR_FACTS_DEFAULTS.ttlMs),
    refreshAfterMs: num(env[PR_FACTS_REFRESH_ENV], PR_FACTS_DEFAULTS.refreshAfterMs),
    staleAfterMs: PR_FACTS_DEFAULTS.staleAfterMs,
  };
}

// ── PURE: the mirror ────────────────────────────────────────────────────────────────────────────────────────

const repoKey = (repo) => String(repo || '').toLowerCase();
const isSlug = (repo) => /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(String(repo || ''));

/** A projection-storage view over the mirror's plain-object buckets — the interface `foldObservation` folds into. */
function bucketStorage(buckets) {
  const b = (name) => { buckets[name] ||= {}; return buckets[name]; };
  return {
    getProjection: (bucket, key) => structuredClone(b(bucket)[key] ?? null),
    putProjection: (bucket, key, value) => { b(bucket)[key] = structuredClone(value); },
    listProjection: (bucket) => Object.values(b(bucket)).map((v) => structuredClone(v)),
  };
}

/**
 * Build a mirror from one full `/prs` answer, keeping only `repo`'s rows. The served rows are folded back into
 * projection buckets keyed exactly as the Worker keys them, so later deltas replace (never duplicate) entries.
 */
export function seedMirror({ repo, body, nowMs }) {
  const r = repoKey(repo);
  const buckets = { prs: {}, checks: {}, shas: {} };
  for (const row of body.prs || []) {
    if (repoKey(row.repo) !== r || !Number.isInteger(row.number)) continue;
    const { checks = [], suites = [], ...rest } = row;
    buckets.prs[JSON.stringify([r, row.number])] = { ...rest, repo: r, checks: [], suites: [], fields: {}, labelChanges: rest.labelChanges || {} };
    if (row.sha) {
      const k = JSON.stringify([r, row.sha]);
      buckets.shas[k] = [...new Set([...(buckets.shas[k] || []), row.number])];
    }
    for (const c of [...checks, ...suites]) {
      const k = checkProjectionKey({ ...c, repo: r });
      const prev = buckets.checks[k];
      // The served row proves this check is attached to this PR: keep that attachment explicitly.
      buckets.checks[k] = { ...c, repo: r, prs: [...new Set([...(prev?.prs || []), ...(c.prs || []), row.number])] };
    }
  }
  const bootstrap = (body.coverage?.bootstrap || []).find((x) => repoKey(x?.repo) === r) || null;
  return {
    v: PR_FACTS_VERSION, repo: r, buckets, cursor: body.stateCursor ?? body.head ?? null,
    fetchedAtMs: nowMs, lastOkAt: nowMs, lastFailAt: null, lastError: null,
    lastDeliveryAt: body.lastDeliveryAt ?? null, lastEventAt: body.lastEventAt ?? null,
    bootstrap: bootstrap ? { status: bootstrap.status, baseCursor: bootstrap.baseCursor, importId: bootstrap.importId } : null,
    fullPulls: 1,
  };
}

/** Fold `/events` records into the mirror with the Worker's own fold. Other repos' events are ignored. PURE (copies). */
export function applyDelta(mirror, events) {
  const next = structuredClone(mirror);
  const storage = bucketStorage(next.buckets);
  for (const e of events || []) {
    if (!e || repoKey(e.repo) !== next.repo || !Number.isInteger(e.seq)) continue;
    foldObservation(storage, e);
  }
  return next;
}

const sortBy = (...keys) => (a, b) => { for (const k of keys) { const x = String(a[k] ?? ''); const y = String(b[k] ?? ''); if (x !== y) return x < y ? -1 : 1; } return 0; };

/** Keep the latest record per identity (higher `rank` wins). */
function latestBy(list, idOf, rank) {
  const m = new Map();
  for (const x of list) { const k = idOf(x); const p = m.get(k); if (!p || rank(x) >= rank(p)) m.set(k, x); }
  return [...m.values()];
}

/** The normalized facts shape both sources produce (and `derivePrState` consumes). */
function factsShape({ repo, number, headSha, draft, state, merged, labels, checks, suites, review }) {
  return {
    repo: repoKey(repo), number, headSha, draft: !!draft, state, merged: state === 'closed' ? merged === true : false,
    labels: [...new Set(labels)].sort(),
    checks: checks.map((c) => ({ name: c.name ?? null, app: c.app ?? null, conclusion: c.conclusion ?? null })).sort(sortBy('name', 'app')),
    suites: suites.map((c) => ({ app: c.app ?? null, conclusion: c.conclusion ?? null })).sort(sortBy('app')),
    review: review && review.state ? { sha: review.sha ?? null, state: String(review.state).toLowerCase() } : null,
  };
}

/** One served `/prs` row → facts (head-SHA checks only). PURE. */
export function normalizeStoreRow(row) {
  const onHead = (c) => c.sha === row.sha;
  return factsShape({
    repo: row.repo, number: row.number, headSha: row.sha, draft: row.draft, state: row.state, merged: row.merged,
    labels: row.labels || [],
    checks: latestBy((row.checks || []).filter(onHead), (c) => JSON.stringify([c.name, c.app ?? null]), (c) => c.seq || 0),
    suites: latestBy((row.suites || []).filter(onHead), (c) => String(c.app ?? null), (c) => c.seq || 0),
    review: row.review,
  });
}

/** The mirror's feed health, as the pr-events waker classifies it. PURE. */
export function mirrorHealth(mirror, { nowMs, staleAfterMs = PR_FACTS_DEFAULTS.staleAfterMs }) {
  return classifyFeedHealth({ lastOkAt: mirror?.lastOkAt ?? null, lastFailAt: mirror?.lastFailAt ?? null,
    lastDeliveryAt: mirror?.lastDeliveryAt ?? null, now: nowMs, staleAfterMs });
}

/**
 * Is the mirror trustworthy for `repo` at `nowMs`? Returns `{ ok:true }` or `{ ok:false, reason }`. PURE.
 * Reasons: no-mirror | feed-unreachable | feed-stale | no-bootstrap | bootstrap-<status> | ttl-expired.
 */
export function judgeMirror(mirror, { nowMs, ttlMs = PR_FACTS_DEFAULTS.ttlMs, staleAfterMs = PR_FACTS_DEFAULTS.staleAfterMs }) {
  if (!mirror || mirror.v !== PR_FACTS_VERSION) return { ok: false, reason: 'no-mirror' };
  const health = mirrorHealth(mirror, { nowMs, staleAfterMs });
  if (health !== 'healthy') return { ok: false, reason: `feed-${health}` };
  if (!mirror.bootstrap) return { ok: false, reason: 'no-bootstrap' };
  if (mirror.bootstrap.status !== 'complete') return { ok: false, reason: `bootstrap-${mirror.bootstrap.status}` };
  const age = nowMs - mirror.fetchedAtMs;
  if (!(age >= 0 && age < ttlMs)) return { ok: false, reason: 'ttl-expired' };
  return { ok: true };
}

/** Every served row of the mirror (the Worker's own projection). PURE. */
export function mirrorRows(mirror) {
  return projectPrRows({ ...bucketStorage(structuredClone(mirror.buckets)) });
}

/** Look one PR up in a mirror. `{ facts }` or `{ facts:null, reason }`. PURE. */
export function lookupInMirror(mirror, { number, nowMs, ttlMs, staleAfterMs }) {
  const verdict = judgeMirror(mirror, { nowMs, ttlMs, staleAfterMs });
  if (!verdict.ok) return { facts: null, reason: verdict.reason };
  const row = mirrorRows(mirror).find((r) => r.number === Number(number));
  if (!row) return { facts: null, reason: 'no-row' };
  if (!row.sha || !row.state || row.draft == null || !Array.isArray(row.labels)) return { facts: null, reason: 'incomplete-row' };
  return { facts: { ...normalizeStoreRow(row), source: 'store', asOfMs: mirror.fetchedAtMs, cursor: mirror.cursor } };
}

// ── IO: the Worker and the mirror file ──────────────────────────────────────────────────────────────────────

async function getJson(url, token, { fetchImpl, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e?.message || e).split('\n')[0]);
  } finally { clearTimeout(timer); }
}

export function mirrorPath(dir, repo) {
  return isSlug(repo) ? join(dir, `${repoKey(repo).replace('/', '__')}.json`) : null;
}

export function readMirrorFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** An async single-flight file lock: `fn` runs alone; a waiter gives up after `waitMs` (→ `{ timedOut:true }`). */
async function withAsyncLock(lockPath, fn, { waitMs, staleMs }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lockPath).mtimeMs > staleMs) { unlinkSync(lockPath); continue; } } catch { continue; }
      if (Date.now() >= deadline) return { timedOut: true };
      await sleep(150);
    }
  }
  try { return { value: await fn() }; } finally { try { unlinkSync(lockPath); } catch { /* best-effort */ } }
}

/**
 * Bring the mirror up to date from the Worker: deltas from the cursor, or a full `/prs` pull on no mirror, a
 * `gap`, a `reset`, or an undrained backlog. A failure is recorded (`lastFailAt`), never thrown — the mirror then
 * judges `feed-unreachable` and every read falls back to GitHub.
 */
export async function refreshMirror(prev, { repo, url, token, fetchImpl = globalThis.fetch, nowMs = Date.now(),
  timeoutMs = PR_FACTS_DEFAULTS.timeoutMs, maxDeltaPages = PR_FACTS_DEFAULTS.maxDeltaPages, pageLimit = PR_FACTS_DEFAULTS.pageLimit } = {}) {
  const io = { fetchImpl, timeoutMs };
  const full = async () => seedMirror({ repo, body: await getJson(`${url}/prs`, token, io), nowMs });
  try {
    if (!prev || prev.v !== PR_FACTS_VERSION || !Number.isInteger(prev.cursor)) return { mirror: await full(), mode: 'full' };
    let m = prev;
    for (let page = 0; page < maxDeltaPages; page += 1) {
      const q = new URLSearchParams({ cursor: String(m.cursor), limit: String(pageLimit) });
      const b = await getJson(`${url}/events?${q}`, token, io);
      if (!b || !Number.isInteger(b.cursor) || !Array.isArray(b.events)) throw new Error('malformed /events response');
      if (b.gap || b.reset) {
        const mirror = await full();
        return { mirror: { ...mirror, fullPulls: (prev.fullPulls || 0) + 1 }, mode: b.gap ? 'full:gap' : 'full:reset' };
      }
      m = { ...applyDelta(m, b.events), cursor: b.cursor, lastDeliveryAt: b.lastDeliveryAt ?? m.lastDeliveryAt, lastEventAt: b.lastEventAt ?? m.lastEventAt };
      if (!b.more) return { mirror: { ...m, fetchedAtMs: nowMs, lastOkAt: nowMs, lastError: null }, mode: 'delta' };
    }
    const mirror = await full();
    return { mirror: { ...mirror, fullPulls: (prev.fullPulls || 0) + 1 }, mode: 'full:backlog' };
  } catch (e) {
    const base = prev && prev.v === PR_FACTS_VERSION ? prev : { v: PR_FACTS_VERSION, repo: repoKey(repo), buckets: { prs: {}, checks: {}, shas: {} }, cursor: null, fetchedAtMs: 0, lastOkAt: null, bootstrap: null };
    return { mirror: { ...base, lastFailAt: nowMs, lastError: String(e?.message || e) }, mode: 'failed', error: String(e?.message || e) };
  }
}

function logFactsHit(env, caller, repo, n) {
  // Never append to the REAL host call log from a test run (only an explicitly isolated lock root).
  if ((env.VITEST || env.FAKE_GH_FIXTURE) && !env.WE_GH_THROTTLE_LOCK_ROOT && !env.LANE_POOL_ROOT) return;
  try { recordGhCallLogEntry(ghThrottleLogPath(ghThrottleLockRoot(undefined, env)), { op: 'pr facts', outcome: 'facts_hit', repo, caller, n }); } catch { /* best-effort */ }
}

/**
 * Load the mirror for `repo`, refreshing it first when older than `refreshAfterMs`. Returns
 * `{ mirror, settings }` or `{ mirror:null, reason }` when the store is not applicable.
 * Options (all injectable for tests): env, fetchImpl, now, dir, url, token, ttlMs, refreshAfterMs, staleAfterMs.
 */
export async function loadMirror({ repo, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), ...o } = {}) {
  if (!isSlug(repo)) return { mirror: null, reason: 'no-repo-slug' };
  const cfg = resolvePrFactsConfig(env);
  const url = (o.url ?? cfg.url)?.replace(/\/+$/, '') || null;
  const token = o.token ?? cfg.token;
  const enabled = o.url && o.token ? true : cfg.enabled;
  if (!enabled || !url || !token) return { mirror: null, reason: `disabled: ${cfg.disabledReason || 'not configured'}` };
  const settings = {
    ttlMs: o.ttlMs ?? cfg.ttlMs, refreshAfterMs: o.refreshAfterMs ?? cfg.refreshAfterMs, staleAfterMs: o.staleAfterMs ?? cfg.staleAfterMs,
  };
  const dir = o.dir ?? cfg.dir;
  const path = mirrorPath(dir, repo);
  let mirror = readMirrorFile(path);
  const due = (m) => !m || m.v !== PR_FACTS_VERSION || !(now() - (m.lastFailAt && m.lastFailAt > (m.lastOkAt || 0) ? m.lastFailAt : m.fetchedAtMs) < settings.refreshAfterMs);
  if (due(mirror)) {
    mkdirSync(dir, { recursive: true });
    const locked = await withAsyncLock(`${path}.lock`, async () => {
      const again = readMirrorFile(path); // a concurrent refresher may have finished while we waited
      if (!due(again)) return again;
      const r = await refreshMirror(again, { repo, url, token, fetchImpl, nowMs: now(), timeoutMs: o.timeoutMs, maxDeltaPages: o.maxDeltaPages });
      writeJsonAtomic(path, r.mirror);
      return r.mirror;
    }, { waitMs: o.lockWaitMs ?? PR_FACTS_DEFAULTS.lockWaitMs, staleMs: PR_FACTS_DEFAULTS.lockStaleMs });
    mirror = locked.timedOut ? readMirrorFile(path) : locked.value;
  }
  return { mirror, settings };
}

/**
 * The per-PR facts lookup with its reason: `{ facts, reason }` — `facts` is null when not served, and `reason`
 * says why (disabled, feed-unreachable, feed-stale, no-bootstrap, ttl-expired, no-row, incomplete-row, ...).
 */
export async function lookupPrFacts({ repo, number, caller = null, env = process.env, now = () => Date.now(), ...o } = {}) {
  if (!Number.isInteger(Number(number)) || Number(number) <= 0) return { facts: null, reason: 'bad-number' };
  const { mirror, settings, reason } = await loadMirror({ repo, env, now, ...o });
  if (!mirror) return { facts: null, reason: reason || 'no-mirror' };
  const r = lookupInMirror(mirror, { number, nowMs: now(), ...settings });
  if (r.facts) logFactsHit(env, caller || deriveGhCaller({}, env), repoKey(repo), 1);
  return r.facts ? { facts: r.facts, reason: 'served' } : r;
}

/** One PR's facts from the store, or `null` (= do your existing gh read). See the file header. */
export async function readPrFacts(opts = {}) {
  return (await lookupPrFacts(opts)).facts;
}

/**
 * Every PR of `repo` the store knows, when the store is trustworthy for that repo; else `null`.
 * Rows that are incomplete are left out (a caller wanting one of them reads gh for that PR).
 */
export async function readRepoFacts({ repo, caller = null, env = process.env, now = () => Date.now(), ...o } = {}) {
  const { mirror, settings } = await loadMirror({ repo, env, now, ...o });
  if (!mirror || !judgeMirror(mirror, { nowMs: now(), ...settings }).ok) return null;
  const prs = mirrorRows(mirror)
    .filter((row) => row.sha && row.state && row.draft != null && Array.isArray(row.labels))
    .map((row) => ({ ...normalizeStoreRow(row), source: 'store', asOfMs: mirror.fetchedAtMs, cursor: mirror.cursor }))
    .sort((a, b) => a.number - b.number);
  logFactsHit(env, caller || deriveGhCaller({}, env), repoKey(repo), prs.length);
  return { repo: repoKey(repo), asOfMs: mirror.fetchedAtMs, cursor: mirror.cursor, prs };
}

// ── The GitHub answer, in the same shape (fallback + the contract test's other side) ────────────────────────

/** Raw REST payloads → facts. PURE. Completed runs only, latest per (name, app) / per app — the store's rule. */
export function normalizeGithubPr({ repo, pull, checkRuns = [], checkSuites = [], reviews = [] }) {
  const head = pull?.head?.sha || null;
  const done = (x) => x?.status === 'completed' && (x.head_sha == null || x.head_sha === head);
  const lastReview = [...(reviews || [])].filter((r) => r?.state && r.state !== 'PENDING')
    .sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')) || (a.id || 0) - (b.id || 0)).pop();
  return factsShape({
    repo, number: pull?.number, headSha: head, draft: pull?.draft, state: pull?.state, merged: pull?.merged === true || !!pull?.merged_at,
    labels: (pull?.labels || []).map((l) => l?.name).filter((n) => typeof n === 'string'),
    checks: latestBy(checkRuns.filter(done), (c) => JSON.stringify([c.name, c.app?.slug ?? null]), (c) => c.id || 0)
      .map((c) => ({ name: c.name, app: c.app?.slug ?? null, conclusion: c.conclusion })),
    suites: latestBy(checkSuites.filter(done), (c) => String(c.app?.slug ?? null), (c) => c.id || 0)
      .map((c) => ({ app: c.app?.slug ?? null, conclusion: c.conclusion })),
    review: lastReview ? { sha: lastReview.commit_id, state: lastReview.state } : null,
  });
}

/** The same facts straight from GitHub's REST API (4 reads). Throws the gh error unchanged. */
export function readPrFactsFromGithub({ repo, number, exec = execFileSyncThrottled, caller = null } = {}) {
  const api = (path) => JSON.parse(String(exec('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    throttle: { op: 'pr facts (github)', ...(caller ? { caller } : {}) },
  }) || 'null'));
  const pull = api(`repos/${repo}/pulls/${Number(number)}`);
  const sha = pull?.head?.sha;
  const checkRuns = sha ? api(`repos/${repo}/commits/${sha}/check-runs?per_page=100`)?.check_runs || [] : [];
  const checkSuites = sha ? api(`repos/${repo}/commits/${sha}/check-suites?per_page=100`)?.check_suites || [] : [];
  const reviews = api(`repos/${repo}/pulls/${Number(number)}/reviews?per_page=100`) || [];
  return { ...normalizeGithubPr({ repo, pull, checkRuns, checkSuites, reviews }), source: 'github', asOfMs: Date.now(), cursor: null };
}

/**
 * Facts from the store when it is trustworthy, else from GitHub — and which one answered:
 * `{ facts, source: 'store' | 'github', reason }` (`reason` = why the store did not answer, or 'served').
 */
export async function readPrFactsOrGithub({ repo, number, exec, ...o } = {}) {
  const r = await lookupPrFacts({ repo, number, ...o });
  if (r.facts) return { facts: r.facts, source: 'store', reason: 'served' };
  return { facts: readPrFactsFromGithub({ repo, number, exec, caller: o.caller }), source: 'github', reason: r.reason };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function main(argv) {
  const [repo, n] = argv;
  if (!isSlug(repo) || !Number.isInteger(Number(n))) { console.log('usage: node scripts/lib/pr-facts.mjs <owner/repo> <number>'); process.exitCode = 2; return; }
  const r = await lookupPrFacts({ repo, number: Number(n), caller: 'pr-facts-cli' });
  console.log(JSON.stringify({ source: r.facts ? 'store' : null, reason: r.reason, facts: r.facts }, null, 2));
  if (!r.facts) process.exitCode = 1;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) main(process.argv.slice(2));

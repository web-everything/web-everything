#!/usr/bin/env node
/**
 * @file scripts/conveyor/ci-queue-watch.mjs
 * @description The GITHUB ACTIONS RUN-QUEUE WAIT-TIME cadence (WE #3574, epic #3383). A 2026-09-07
 *   investigation (this item's own card) found no current evidence that GitHub Actions runner concurrency is a
 *   binding constraint on this repo — but ALSO found nothing tracks it over time: a genuine queueing
 *   regression (e.g. a burst of concurrent dispatched lanes each triggering CI at once) would go unnoticed
 *   until someone manually re-samples `gh run list` by hand. This module makes that sampling a periodic,
 *   mechanical pass instead, mirroring `we:scripts/conveyor/branch-drift.mjs`'s pure-classify + thin gh-IO-shell
 *   shape (same file this card's own investigation named as the pattern to follow).
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors branch-drift.mjs #3464 and infra-blocked.mjs #2659): the PURE core
 *   ({@link waitSecondsOf}, {@link summarizeRuns}, {@link classifyQueueWait}, {@link parseHistory},
 *   {@link appendSample}, {@link serializeHistory}) has NO fs / gh / clock — every input is injected, so it is
 *   unit-tested directly against precomputed run lists and history arrays. The thin IO shell
 *   ({@link defaultListRuns}, the sidecar path/read/write helpers, {@link sweepCiQueue}, the CLI) owns every
 *   `gh`/fs call.
 *
 * WHERE THE HISTORY LIVES — the PRIMARY checkout's session sidecar (`.conveyor/ci-queue-history.json`),
 *   gitignored like the conveyor queue (#2613) and the infra-blocked store (#2659). Unlike branch-drift's git
 *   note (needed because that cadence can be swept from many different scratch checkouts), this cadence is
 *   piggybacked on the resident runner's OWN tick (`skills-src/conveyor/runner.mjs`) — one long-lived process
 *   on one checkout — so a local sidecar is the simpler fit and needs no git-notes push/fetch dance. The
 *   runner's own tick is the ONLY expected writer, but the card's own investigation names a real second one:
 *   an operator re-sampling `gh run list` by hand, right now, while the runner ticks the same sidecar — so the
 *   read-modify-write in {@link sweepCiQueue} is still serialized with a cheap advisory lock
 *   ({@link withHistoryLock}, mirrors `infra-blocked.mjs`'s `withInfraLock` shape) rather than assuming a single
 *   writer away; a genuinely single-writer sidecar could skip it, this one has a second one by design. The path
 *   resolves by SCRIPT LOCATION (never CWD), so writer and readers can't diverge; `CONVEYOR_CI_QUEUE_FILE`
 *   overrides it (tests + out-of-tree).
 *
 * SHAPE: a JSON ARRAY of samples, oldest first, bounded to `DEFAULT_MAX_HISTORY` entries (a ring buffer — old
 *   samples fall off the front once the cap is hit, so the file never grows unbounded across months of ticks).
 *   Each sample: `{ checkedAt, sampled, started, maxWaitSeconds, avgWaitSeconds, status, reason }`.
 *
 * THE QUEUE-WAIT SAMPLE IS PURELY INFORMATIVE — no dispatch gate reads it (unlike branch-drift's `blocked`
 *   verdict, which `dispatch-plan.mjs` holds dispatch on). The card asks only to make the trend VISIBLE.
 *
 * HUNG JOBS ACT (we:backlog/xncfkf2) — the one part of this pass that writes to GitHub: a check stuck
 *   `in_progress` past `max(floor, k × p95)` of its own recent successful durations is cancelled (if its run is
 *   still running) and re-run ONCE per (PR, head, check); a second hang escalates via the `ci-job-hung` health
 *   smell. See {@link sweepHungJobs}. `WE_CI_HUNG_ACTION=0` / `--dry-run` turn the writes off.
 */

import { repoKeyForSlug, ghRepoSlug, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, statSync, unlinkSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import { sleepSyncMs } from '../readiness/drain-lock.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

// ── TUNING (exported so a caller/test can override) ─────────────────────────────────────────────────────────

/** How many recent runs `defaultListRuns` samples per sweep. Generous enough to catch a burst without a slow
 *  `gh` call — this repo's own investigation sampled 20 and found that plenty to judge "any queueing at all". */
export const DEFAULT_SAMPLE_LIMIT = 20;

/** Wait (seconds, `startedAt - createdAt`) past which a sweep reports `watch` — a real but modest queue, not
 *  yet a delivery problem. Env/flag overridable: `WE_CI_QUEUE_WATCH_SEC` / `--watch-sec=`. */
export const DEFAULT_WATCH_THRESHOLD_SEC = 60;
export const WATCH_THRESHOLD_ENV = 'WE_CI_QUEUE_WATCH_SEC';

/** Wait (seconds) past which a sweep reports `blocked` — sustained multi-minute queueing, the shape a runner
 *  concurrency ceiling being hit would actually produce. Env/flag overridable: `WE_CI_QUEUE_BLOCKED_SEC` /
 *  `--blocked-sec=`. */
export const DEFAULT_BLOCKED_THRESHOLD_SEC = 300;
export const BLOCKED_THRESHOLD_ENV = 'WE_CI_QUEUE_BLOCKED_SEC';

/** Ring-buffer cap on the persisted history — bounds the sidecar's size across months of ticks (see file
 *  header). Comfortably more than a day of 5-minute-cadence ticks. */
export const DEFAULT_MAX_HISTORY = 500;

// ── PURE CORE (no fs / gh / clock — every input is injected) ───────────────────────────────────────────────

/** The exact sentinel `gh run list --json startedAt` returns for a run that hasn't started yet — GitHub's zero
 *  `time.Time`, NOT an empty string. A truthy, `Date.parse`-able string that must still read as "unset", or a
 *  still-queued run reads as an instant (0s) start instead of excluded from the wait aggregate entirely (found
 *  by this item's own convergence red-team, mutation-confirmed against a real `gh run list` sample). */
export const GH_UNSTARTED_SENTINEL = '0001-01-01T00:00:00Z';

/**
 * The queue wait for one `gh run list` row, in seconds. PURE.
 * `startedAt` absent/empty/the GitHub zero-time sentinel ({@link GH_UNSTARTED_SENTINEL}) means the run is still
 * queued (not yet started) — returns `null` rather than 0, so {@link summarizeRuns} can tell "genuinely instant
 * start" (0) apart from "no data yet" (null) and exclude the latter from the wait aggregates instead of
 * dragging them toward zero.
 * @param {{createdAt?:string, startedAt?:string}} run
 * @returns {number|null}
 */
export function waitSecondsOf(run) {
  const startedAtRaw = run?.startedAt;
  if (!startedAtRaw || startedAtRaw === GH_UNSTARTED_SENTINEL) return null;
  const created = Date.parse(run?.createdAt);
  const started = Date.parse(startedAtRaw);
  if (!Number.isFinite(created) || !Number.isFinite(started)) return null;
  const deltaMs = started - created;
  // A clock skew / malformed pair reading NEGATIVE reads as 0 (the safe direction — never invent a queue that
  // isn't there), rather than propagating a negative number into an aggregate meant to only ever go up.
  return deltaMs > 0 ? deltaMs / 1000 : 0;
}

/**
 * Summarize a `gh run list` sample into the aggregate a sweep reports. PURE. Runs with no resolvable wait
 * (still queued, or malformed timestamps) count toward `sampled` but not `started`/the wait aggregates — an
 * all-queued sample must not silently read as "0s wait, all clear".
 * @param {Array<{createdAt?:string, startedAt?:string}>} runs
 * @returns {{sampled:number, started:number, maxWaitSeconds:number, avgWaitSeconds:number}}
 */
export function summarizeRuns(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const waits = list.map(waitSecondsOf).filter((w) => w !== null);
  const maxWaitSeconds = waits.length ? Math.max(...waits) : 0;
  const avgWaitSeconds = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;
  return { sampled: list.length, started: waits.length, maxWaitSeconds, avgWaitSeconds };
}

/**
 * The verdict for one sweep's aggregate. PURE, mirrors `classifyBranchDrift`'s ok/watch/blocked shape.
 * An EMPTY sample (`sampled === 0` — no runs to judge, e.g. a quiet repo) reads as `ok` with a distinct reason:
 * absence of data is not evidence of queueing, but it is also not the same "checked and it's fine" as a real
 * zero-wait sample, so a reader of the log can tell the two apart.
 *
 * A sample where NOTHING has started yet (`started === 0` but `sampled > 0`) is likewise never conflated with a
 * clean zero-wait sample. `maxWaitSeconds` computed from zero resolved waits is 0 by construction (there is no
 * wait DATA, not a wait of zero) — reading that as `ok` would misclassify the exact "a capacity crunch just
 * queued a burst of runs, none started yet" scenario this tool exists to surface as healthy. Reported as
 * `watch` instead: real signal (a real sample, genuinely nothing started), just not yet enough history to know
 * whether it is a transient blip or a live incident.
 * @param {{sampled?:number, started?:number, maxWaitSeconds?:number, watchThresholdSec?:number, blockedThresholdSec?:number}} input
 * @returns {{status:'ok'|'watch'|'blocked', reason:string}}
 */
export function classifyQueueWait({
  sampled = 0, started = 0, maxWaitSeconds = 0,
  watchThresholdSec = DEFAULT_WATCH_THRESHOLD_SEC, blockedThresholdSec = DEFAULT_BLOCKED_THRESHOLD_SEC,
} = {}) {
  if (!sampled) return { status: 'ok', reason: 'no runs sampled' };
  if (!started) return { status: 'watch', reason: `${sampled} run(s) sampled, none have started yet — no wait data to judge` };
  // `>= 0`, not `> 0` — an explicit 0 threshold ("flag everything") is a real, honored value, not the same as
  // "nothing was set"; only a negative/NaN/missing threshold falls back to the default (mirrors `numFlag`).
  const watchSec = Number.isFinite(watchThresholdSec) && watchThresholdSec >= 0 ? watchThresholdSec : DEFAULT_WATCH_THRESHOLD_SEC;
  const blockedSec = Number.isFinite(blockedThresholdSec) && blockedThresholdSec >= 0 ? blockedThresholdSec : DEFAULT_BLOCKED_THRESHOLD_SEC;
  const maxWait = Number(maxWaitSeconds) || 0;
  if (maxWait > blockedSec) {
    return { status: 'blocked', reason: `max wait ${Math.round(maxWait)}s past the ${blockedSec}s ceiling — sustained queueing` };
  }
  if (maxWait > watchSec) {
    return { status: 'watch', reason: `max wait ${Math.round(maxWait)}s past the ${watchSec}s watch line` };
  }
  return { status: 'ok', reason: `max wait ${Math.round(maxWait)}s` };
}

/** Tolerant parse of the sidecar text → a sample array. NEVER throws: empty/whitespace, bad JSON, or a
 *  non-array root all degrade to `[]` rather than breaking the reader (a corrupt sidecar must never wedge a
 *  tick). PURE. */
export function parseHistory(text) {
  if (!text || !String(text).trim()) return [];
  let raw;
  try { raw = JSON.parse(text); } catch { return []; }
  return Array.isArray(raw) ? raw.filter((e) => e && typeof e === 'object') : [];
}

/** Append one sample to the history, capping it to `maxEntries` (oldest dropped first — a ring buffer). PURE.
 * @param {Array<object>} history
 * @param {object} sample
 * @param {{maxEntries?:number}} [o]
 * @returns {Array<object>}
 */
export function appendSample(history, sample, { maxEntries = DEFAULT_MAX_HISTORY } = {}) {
  const next = [...(Array.isArray(history) ? history : []), sample];
  const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_HISTORY;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Pretty-printed, newline-terminated — diffable by a human reading the sidecar directly. PURE. */
export function serializeHistory(history) {
  return `${JSON.stringify(Array.isArray(history) ? history : [], null, 2)}\n`;
}

// ── HUNG CI JOBS (we:backlog/xncfkf2) ──────────────────────────────────────────────────────────────────────
//
// Live 2026-10-08: PR #4450's required `daemon-soak` job sat `in_progress` for 90+ minutes (GitHub kept the job
// `in_progress` although every step had finished and `completed_at` was set). Nothing noticed, so the PR would
// have waited for GitHub's 6-hour job timeout. The sweep below reads open PRs' check rollups, learns each
// check's recent successful durations, and calls a check HUNG when it has been `in_progress` longer than
// `max(floor, k × p95)`. A hung job is recovered ONCE per (PR, head, check): its run is cancelled if still
// running, then the job is re-run. A second hang on the same head is not retried — it is logged as an
// `ci-job-hung: ESCALATE {json}` line, which the `ci-job-hung` health smell raises as [high].

/** k in `max(floor, k × p95)`. Env/flag: `WE_CI_HUNG_K` / `--hung-k=`. */
export const DEFAULT_HUNG_K = 3;
export const HUNG_K_ENV = 'WE_CI_HUNG_K';
/** The floor (seconds) under which no check is ever called hung, whatever its history. Env/flag:
 *  `WE_CI_HUNG_FLOOR_SEC` / `--hung-floor-sec=`. 30 min: every real job here finishes well inside it. */
export const DEFAULT_HUNG_FLOOR_SEC = 30 * 60;
export const HUNG_FLOOR_ENV = 'WE_CI_HUNG_FLOOR_SEC';
/** How many automatic re-runs one (PR, head, check) gets before a further hang escalates instead. */
export const DEFAULT_HUNG_MAX_RERUNS = 1;
/** Rolling window of successful durations kept per check name. */
export const DEFAULT_DURATION_WINDOW = 50;
/** How many distinct check names the duration history keeps (names are chosen by PR authors). */
export const MAX_DURATION_NAMES = 200;
/** After a cancel, how long to wait for the run to complete before force-cancelling it. */
export const CANCEL_GRACE_MS = 5 * 60_000;
/** Ledger entries older than this are dropped (their PR has long since moved on). */
export const HUNG_LEDGER_TTL_MS = 7 * 24 * 3600_000;
/** Kill switch: `WE_CI_HUNG_ACTION=0` makes `sweep` detect and log only, never cancel or re-run. */
export const HUNG_ACTION_ENV = 'WE_CI_HUNG_ACTION';

const WE_SLUG = ghRepoSlug(DEFAULT_REPO_KEY);
const ACTIONS_JOB_PATH_RE = /^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/;

/** `{runId, jobId}` from a rollup entry's Actions `detailsUrl`; null for a check with no Actions job of THIS repo
 *  (no rerun handle — e.g. a third-party app's check run). The URL is attacker-influenceable (any app holding
 *  `checks:write` sets it) and its ids later drive cancel / re-run calls made with the App's `actions:write`
 *  token, so it must be exactly `https://github.com/<repo>/actions/runs/<n>/job/<n>` (query and fragment ignored),
 *  with both ids representable exactly as numbers. PURE. */
export function jobRefOf(check, repo = WE_SLUG) {
  let u;
  try { u = new URL(String(check?.detailsUrl || '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password) return null;
  const m = ACTIONS_JOB_PATH_RE.exec(u.pathname);
  if (!m || `${m[1]}/${m[2]}`.toLowerCase() !== String(repo).toLowerCase()) return null;
  const runId = Number(m[3]);
  const jobId = Number(m[4]);
  return Number.isSafeInteger(runId) && Number.isSafeInteger(jobId) && runId > 0 && jobId > 0 ? { runId, jobId } : null;
}

/** True for a rollup entry that is a GitHub Actions check run. Only Actions check runs carry a `workflowName`; a
 *  third-party app holding `checks:write` sets its own name, times and details URL but cannot set one — so without
 *  this a forged "success" under a real check name could inflate the learned p95 and mask a real hang. PURE. */
export function isActionsCheck(check) {
  return typeof check?.workflowName === 'string' && check.workflowName.trim() !== '';
}

/** A successful, completed check's duration in seconds; null for anything else. PURE. */
export function successDurationSec(check) {
  if (String(check?.status || '').toUpperCase() !== 'COMPLETED') return null;
  if (String(check?.conclusion || '').toUpperCase() !== 'SUCCESS') return null;
  const s = Date.parse(check.startedAt);
  const e = Date.parse(check.completedAt);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  return (e - s) / 1000;
}

/** Nearest-rank percentile; null for an empty list. PURE. */
export function percentile(values, p) {
  const v = (Array.isArray(values) ? values : []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.ceil((p / 100) * v.length);
  return v[Math.min(v.length, Math.max(1, rank)) - 1];
}

/** Fold the successful durations seen in `prs`' rollups into `durations` (`{name: [{jobId, sec}]}`), dedup by
 *  job id, newest last, capped to `window` per name. PURE (returns a new map). */
export function learnDurations(durations, prs, { window = DEFAULT_DURATION_WINDOW, repo = WE_SLUG } = {}) {
  // A check NAME is an attacker-chosen key: a null-prototype map, so `constructor` / `__proto__` / `toString` are
  // ordinary names, never Object's own members. New names stop being learned at MAX_DURATION_NAMES.
  const out = Object.create(null);
  for (const [name, list] of Object.entries(durations || {})) out[name] = Array.isArray(list) ? [...list] : [];
  for (const p of Array.isArray(prs) ? prs : []) {
    for (const c of p?.statusCheckRollup || []) {
      const sec = successDurationSec(c);
      const ref = jobRefOf(c, repo);
      if (sec === null || !ref || !c.name || !isActionsCheck(c)) continue;
      if (!(c.name in out) && Object.keys(out).length >= MAX_DURATION_NAMES) continue;
      const list = out[c.name] || (out[c.name] = []);
      if (list.some((s) => s.jobId === ref.jobId)) continue;
      list.push({ jobId: ref.jobId, sec });
    }
  }
  const cap = Number.isFinite(window) && window > 0 ? window : DEFAULT_DURATION_WINDOW;
  for (const name of Object.keys(out)) if (out[name].length > cap) out[name] = out[name].slice(out[name].length - cap);
  return out;
}

/** `max(floor, k × p95)` over one check's duration samples. PURE. */
export function hungThreshold(samples, { k = DEFAULT_HUNG_K, floorSec = DEFAULT_HUNG_FLOOR_SEC } = {}) {
  const secs = (Array.isArray(samples) ? samples : []).map((s) => s?.sec);
  const p95Sec = percentile(secs, 95);
  const thresholdSec = Math.max(floorSec, p95Sec === null ? 0 : k * p95Sec);
  return { thresholdSec, p95Sec, samples: secs.filter(Number.isFinite).length };
}

/** Every `in_progress` check (with an Actions job behind it) running longer than its threshold. PURE.
 *  `now` is epoch ms. */
export function findHungChecks(prs, durations, { now, k = DEFAULT_HUNG_K, floorSec = DEFAULT_HUNG_FLOOR_SEC, repo = WE_SLUG } = {}) {
  const out = [];
  for (const p of Array.isArray(prs) ? prs : []) {
    for (const c of p?.statusCheckRollup || []) {
      if (String(c?.status || '').toUpperCase() !== 'IN_PROGRESS') continue;
      const ref = jobRefOf(c, repo);
      const started = Date.parse(c.startedAt);
      if (!ref || !c.name || !isActionsCheck(c) || !Number.isFinite(started)) continue;
      const inProgressSec = (now - started) / 1000;
      const t = hungThreshold(durations?.[c.name], { k, floorSec });
      if (inProgressSec <= t.thresholdSec) continue;
      out.push({ pr: p.number, headSha: p.headRefOid, name: c.name, ...ref, startedAt: c.startedAt, inProgressSec, ...t });
    }
  }
  return out;
}

/** True for a gh failure that says nothing about whether GitHub would accept the call: gh-throttle's shared
 *  rate-limit backoff (the call was never sent — live 2026-10-08 on #4450's first recovery), a rate limit, a
 *  timeout, or a GitHub 5xx. PURE. */
export function isTransientGhError(message) {
  return /call not sent|rate limit|backoff|timed? ?out|ETIMEDOUT|ECONNRESET|HTTP 5\d\d|\b50[234]\b/i.test(String(message || ''));
}

/** The ledger key: one recovery budget per (PR, head, check). PURE. */
export function hungKey({ pr, headSha, name }) {
  return `${pr}@${headSha}:${name}`;
}

/** Decide per hung check: `recover` (first hang), `handled` (this exact job was already acted on — GitHub can
 *  keep reporting it in_progress), or `escalate` (a NEW hang on a head whose re-run budget is spent). PURE. */
export function planHungActions(hung, ledger, { maxReruns = DEFAULT_HUNG_MAX_RERUNS } = {}) {
  return (Array.isArray(hung) ? hung : []).map((h) => {
    const key = hungKey(h);
    const e = ledger?.[key];
    let action = 'recover';
    const stage = String(e?.stage || '');
    const last = (e?.actions || []).at(-1);
    // A recovery that never reached GitHub (throttle backoff, timeout, 5xx) is retried. One GitHub actually
    // refused (cancel/re-run failed for real) is not retried every sweep — it escalates instead.
    if (e && /-(failed|deferred)$/.test(stage) && last && !last.ok && isTransientGhError(last.error)) action = 'recover';
    else if (e && /-failed$/.test(stage)) action = 'escalate';
    else if (e && (e.jobIds || []).includes(h.jobId)) action = 'handled';
    else if (e && (e.reruns ?? 0) >= maxReruns) action = 'escalate';
    return { ...h, key, action };
  });
}


// ── IO SHELL (gh / fs only past this point) ─────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
export const CI_QUEUE_ROOT = resolve(HERE, '..', '..');

/** The `gh run list` sample. `exec` is injectable so the argv is assertable with no `gh` on PATH. Default `exec`
 *  is `we:scripts/lib/gh-throttle.mjs#execFileSyncThrottled` (#3621) — same `execFileSync(file, args, opts)`
 *  3-arg shape as the real thing, gated through the shared `gh`-call concurrency semaphore with rate-limit
 *  backoff. This pass runs every conveyor-runner tick (#3574), one of the runner's highest-volume `gh` callers.
 * @param {{exec?:Function, repo?:string|null, limit?:number}} [o]
 * @returns {Array<{databaseId:number, status:string, createdAt:string, startedAt:string}>}
 */
export function defaultListRuns({ exec = execFileSyncThrottled, repo = null, limit = DEFAULT_SAMPLE_LIMIT } = {}) {
  const argv = ['run', 'list', '--limit', String(limit), '--json', 'databaseId,status,createdAt,startedAt'];
  if (repo) argv.push('--repo', repo);
  // #x5n4zn3 — was bare (no timeout).
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? parsed : [];
}

/** The session sidecar path: `<root>/.conveyor/ci-queue-history.json`. */
export function ciQueueHistoryPath(root = CI_QUEUE_ROOT) {
  return join(root, '.conveyor', 'ci-queue-history.json');
}

/** The canonical sidecar path every consumer resolves to — `CONVEYOR_CI_QUEUE_FILE` override wins, else
 *  script-location (never CWD, so writer and readers can't diverge). */
export function resolveCiQueueHistoryPath(repo = null) {
  const env = process.env.CONVEYOR_CI_QUEUE_FILE;
  const path = env && env.trim() ? env.trim() : ciQueueHistoryPath();
  const key = repo == null ? 'we' : repoKeyForSlug(repo);
  if (!key) throw new Error(`unsupported-repo: ${repo} is not a constellation repo`);
  return key === 'we' ? path : path.replace(/(\.json)?$/, `-${key}$1`);
}

/** Read + parse the sidecar → the sample array (empty on a missing/corrupt file). */
export function readHistory(path = resolveCiQueueHistoryPath()) {
  if (!existsSync(path)) return [];
  try { return parseHistory(readFileSync(path, 'utf8')); }
  catch { return []; }
}

/** Write the history to the sidecar, ATOMICALLY (temp + rename), so a mid-write reader never sees partial JSON. */
export function writeHistory(history, path = resolveCiQueueHistoryPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, serializeHistory(history));
  renameSync(tmp, path);
}

/** How old a `<path>.lock` file may be before {@link withHistoryLock} treats it as abandoned (a crashed holder)
 *  and steals it, rather than waiting forever on a lock nothing will ever release. */
export const DEFAULT_HISTORY_LOCK_STALE_MS = 10_000;
/** How long {@link withHistoryLock} retries acquiring a FRESH (non-stale) lock before giving up and running
 *  `fn` unlocked anyway — a lock must never wedge a sweep. Independent of the staleness window: this is the
 *  ceiling on THIS caller's own patience, not on when a lock counts as abandoned. */
export const DEFAULT_HISTORY_LOCK_TIMEOUT_MS = 10_000;
/** Pause between failed acquire attempts — a real sleep (`sleepSyncMs`), never a hot busy-spin: contention here
 *  is brief (a fast in-memory read-modify-write), so this just avoids pegging a CPU core for however long a
 *  live holder takes, found by this item's own convergence red-team against the first, sleep-less cut. */
const HISTORY_LOCK_POLL_MS = 25;

/**
 * Run `fn` inside a cross-PROCESS advisory lock on `path`, so the read-modify-write in {@link sweepCiQueue} is
 * serialized. The resident runner's own tick is the common writer, but the card's own investigation names the
 * exact second writer this guards against: an operator manually running `sweep` by hand (to re-sample `gh run
 * list` right now) while the runner's tick is mid-write — an unserialized read→modify→write there can lose
 * whichever sample writes second, silently shrinking the very history this tool exists to grow (found by this
 * item's own convergence review). A `<path>.lock` exclusive-create file; a STALE lock (older than `staleMs` —
 * a crashed holder) is stolen; if a fresh lock can't be taken within `timeoutMs`, `fn` still runs UNLOCKED
 * (best-effort — a lock must never wedge a sweep; worst case is the pre-lock last-write-wins). `staleMs` /
 * `timeoutMs` are overridable (tests only need a few ms, not the real multi-second defaults).
 * @template T
 * @param {string} path
 * @param {() => T} fn
 * @param {{staleMs?:number, timeoutMs?:number}} [o]
 * @returns {T}
 */
export function withHistoryLock(path, fn, { staleMs = DEFAULT_HISTORY_LOCK_STALE_MS, timeoutMs = DEFAULT_HISTORY_LOCK_TIMEOUT_MS } = {}) {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const start = Date.now();
  let held = false;
  while (Date.now() - start < timeoutMs) {
    try {
      closeSync(openSync(lockPath, 'wx')); // atomic exclusive create — fails if a holder exists
      held = true;
      break;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) unlinkSync(lockPath); // steal a stale lock
      } catch { /* raced another stealer, or the holder just released it — either way, retry */ }
      sleepSyncMs(Math.min(HISTORY_LOCK_POLL_MS, Math.max(0, timeoutMs - (Date.now() - start))));
    }
  }
  try {
    return fn();
  } finally {
    if (held) { try { unlinkSync(lockPath); } catch { /* best-effort cleanup */ } }
  }
}

/**
 * THE IO SHELL. Samples `gh run list`, summarizes + classifies it, appends the result to the persisted
 * history, and returns the fresh sample (with the write outcome folded in). Never throws on a persistence
 * failure — a sweep that sampled fine but couldn't write the sidecar still reports what it found.
 * @param {{repo?:string|null, limit?:number, listRuns?:Function, historyPath?:string, now?:()=>string,
 *   watchThresholdSec?:number, blockedThresholdSec?:number, maxEntries?:number, persist?:boolean}} [o]
 * @returns {{checkedAt:string, sampled:number, started:number, maxWaitSeconds:number, avgWaitSeconds:number,
 *   status:string, reason:string, persisted:boolean}}
 */
export function sweepCiQueue({
  repo = null, limit = DEFAULT_SAMPLE_LIMIT, listRuns = defaultListRuns,
  historyPath = resolveCiQueueHistoryPath(repo), now = () => new Date().toISOString(),
  watchThresholdSec = DEFAULT_WATCH_THRESHOLD_SEC, blockedThresholdSec = DEFAULT_BLOCKED_THRESHOLD_SEC,
  maxEntries = DEFAULT_MAX_HISTORY, persist = true,
} = {}) {
  const runs = listRuns({ repo, limit });
  const agg = summarizeRuns(runs);
  const verdict = classifyQueueWait({ ...agg, watchThresholdSec, blockedThresholdSec });
  const sample = { checkedAt: now(), ...agg, ...verdict };
  let persisted = false;
  if (persist) {
    try {
      withHistoryLock(historyPath, () => writeHistory(appendSample(readHistory(historyPath), sample, { maxEntries }), historyPath));
      persisted = true;
    } catch { /* best-effort — a sweep that sampled fine still reports even if the sidecar write failed */ }
  }
  return { ...sample, persisted };
}

// ── HUNG CI JOBS: IO shell ────────────────────────────────────────────────────────────────────────────────

/** Every gh call below goes through `execFileSyncThrottled` (the shared gh-throttle semaphore + backoff), the
 *  same sanctioned path `defaultListRuns` uses. */
function ghJson(exec, argv) {
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  const text = String(out || '').trim();
  return text ? JSON.parse(text) : null;
}

/** The most open PRs one `gh pr list` call reads; a full page means the list may be cut off. */
export const PR_LIST_LIMIT = 100;

/** Open PRs with their check rollups (one `gh pr list` call). */
export function defaultListPrs({ exec = execFileSyncThrottled, repo = WE_SLUG } = {}) {
  const parsed = ghJson(exec, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', 'number,headRefOid,statusCheckRollup']);
  return Array.isArray(parsed) ? parsed : [];
}
export function defaultGetRun({ exec = execFileSyncThrottled, repo = WE_SLUG, runId }) {
  return ghJson(exec, ['api', `repos/${repo}/actions/runs/${runId}`]) || {};
}
/** One job (`actions/jobs/<id>`) — read before a job-scoped write to confirm it belongs to the run the check names. */
export function defaultGetJob({ exec = execFileSyncThrottled, repo = WE_SLUG, jobId }) {
  return ghJson(exec, ['api', `repos/${repo}/actions/jobs/${jobId}`]) || {};
}
const ghPost = (path) => ({ exec = execFileSyncThrottled, repo = WE_SLUG, runId, jobId }) => {
  ghJson(exec, ['api', '-X', 'POST', `repos/${repo}/actions/${path({ runId, jobId })}`]);
};
export const defaultCancelRun = ghPost(({ runId }) => `runs/${runId}/cancel`);
export const defaultForceCancelRun = ghPost(({ runId }) => `runs/${runId}/force-cancel`);
export const defaultRerunJob = ghPost(({ jobId }) => `jobs/${jobId}/rerun`);
export const defaultRerunRun = ghPost(({ runId }) => `runs/${runId}/rerun`);

/** The hung-job state sidecar, next to the queue history: `<history>.hung-jobs.json`. */
export function resolveHungStatePath(repo = null) {
  return resolveCiQueueHistoryPath(repo).replace(/(\.json)?$/, '.hung-jobs.json');
}
/** `{durations, hung}`; never throws (a corrupt sidecar reads as empty). */
export function readHungState(path) {
  try {
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    return { durations: raw?.durations && typeof raw.durations === 'object' ? raw.durations : {}, hung: raw?.hung && typeof raw.hung === 'object' ? raw.hung : {} };
  } catch { return { durations: {}, hung: {} }; }
}
function writeHungState(state, path) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

const errText = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0].slice(0, 200);

/**
 * THE HUNG-JOB SWEEP. Learns durations, finds hung checks, and (when `apply`) recovers each first hang:
 * cancel its run if still running (the WHOLE run is cancelled, healthy sibling jobs included, so the whole run
 * is re-run on a later sweep once it completes; a cancel that has not taken after {@link CANCEL_GRACE_MS} is
 * force-cancelled), else re-run the job (falling back to re-running the whole run if GitHub refuses the job
 * re-run). A second hang on the same head escalates (logged, never retried). A recovery that began with a cancel
 * is driven from the LEDGER from then on — the cancelled check leaves `in_progress`, so the hung scan never
 * sees it again: a deferred re-run is retried, a refused one escalates every sweep while the check stays
 * cancelled. No write is made unless the run belongs to the PR's head commit (and, for a job re-run, the job to
 * that run): the check's details URL is untrusted input. Every action is recorded in the ledger and logged as a
 * `ci-job-hung:` line. Never throws on a single GitHub write failing — it is recorded and the sweep moves on.
 */
export function sweepHungJobs({
  repo = null, statePath = resolveHungStatePath(repo), now = () => Date.now(),
  k = DEFAULT_HUNG_K, floorSec = DEFAULT_HUNG_FLOOR_SEC, maxReruns = DEFAULT_HUNG_MAX_RERUNS, apply = true,
  listPrs = defaultListPrs, getRun = defaultGetRun, getJob = defaultGetJob, cancelRun = defaultCancelRun, forceCancelRun = defaultForceCancelRun,
  rerunJob = defaultRerunJob, rerunRun = defaultRerunRun, log = (l) => writeLineSync(2, l),
} = {}) {
  const slug = repo ? ghRepoSlug(repo) : WE_SLUG; // the details-URL anchor and every API path use the canonical slug
  const nowMs = now();
  const at = new Date(nowMs).toISOString();
  const prs = listPrs({ repo: slug });
  return withHistoryLock(statePath, () => {
    const state = readHungState(statePath);
    state.durations = learnDurations(state.durations, prs, { repo: slug });
    for (const [key, e] of Object.entries(state.hung)) {
      if (!(nowMs - Date.parse(e?.updatedAt || 0) < HUNG_LEDGER_TTL_MS)) delete state.hung[key];
    }
    const actions = [];
    const record = (entry, action, h, ok, error = null) => {
      const a = { at, action, pr: h.pr, name: h.name, runId: h.runId, jobId: h.jobId, ok, ...(error ? { error } : {}) };
      entry.actions = [...(entry.actions || []), a].slice(-20);
      entry.updatedAt = at;
      actions.push(a);
      log(`ci-job-hung: ${ok ? 'RECOVER' : isTransientGhError(error) ? 'DEFERRED' : 'FAILED'} ${JSON.stringify({ repo: slug, ...a })}`);
    };
    // A transient failure (the call never reached GitHub, or GitHub 5xx'd) is DEFERRED — retried next sweep, and
    // never answered with the heavier whole-run fallback. Only a real refusal falls back / ends in `-failed`.
    // `viaCancel`: this recovery began by cancelling the WHOLE run, so the whole run is re-run (a job-only re-run
    // would leave the cancelled healthy siblings cancelled and the PR blocked) — and a refusal is never papered
    // over with a partial job re-run.
    const rerun = (entry, h, { viaCancel = false } = {}) => {
      const attempts = viaCancel
        ? [['rerun-run', () => rerunRun({ repo: slug, runId: h.runId })]]
        : [['rerun-job', () => rerunJob({ repo: slug, runId: h.runId, jobId: h.jobId })], ['rerun-run', () => rerunRun({ repo: slug, runId: h.runId })]];
      for (const [i, [action, send]] of attempts.entries()) {
        try { send(); entry.reruns = (entry.reruns ?? 0) + 1; entry.stage = 'rerun-requested'; record(entry, action, h, true); return; }
        catch (e) {
          const msg = errText(e);
          record(entry, action, h, false, msg);
          if (isTransientGhError(msg)) { entry.stage = 'rerun-deferred'; return; }
          if (i === attempts.length - 1) entry.stage = 'rerun-failed';
        }
      }
    };
    // `{error}` = unreadable (never guessed: acting blind on an unknown run state re-ran a job whose status read
    // had been refused, live 2026-10-08). `headSha` is the commit the run actually ran for.
    const readRun = (h) => {
      try {
        const run = getRun({ repo: slug, runId: h.runId });
        const status = String(run?.status || '');
        return status ? { status, headSha: String(run?.head_sha || '') } : { error: 'empty' };
      } catch (e) { return { error: errText(e) }; }
    };
    const readJob = (h) => {
      try {
        const job = getJob({ repo: slug, jobId: h.jobId });
        return { runId: Number(job?.run_id), name: String(job?.name || '') };
      } catch (e) { return { error: errText(e) }; }
    };
    const prByNumber = new Map(prs.map((p) => [p.number, p]));
    // `gh pr list` returns at most PR_LIST_LIMIT PRs: a PR missing from a FULL page is unknown, not closed.
    const listTruncated = prs.length >= PR_LIST_LIMIT;
    const UNKNOWN = Symbol('pr-not-in-a-truncated-list');
    // The PR's CURRENT check for a ledger entry — null once the PR has closed, moved to a new head, or no longer
    // carries a check from the entry's run (nothing more is owed to that entry then); UNKNOWN when the PR list was
    // cut off before it could be seen (the ledger keeps driving a cancel it already issued).
    const liveCheck = (entry) => {
      const p = prByNumber.get(entry.pr);
      if (!p) return listTruncated ? UNKNOWN : null;
      if (p.headRefOid !== entry.headSha) return null;
      return (p.statusCheckRollup || []).find((c) => c?.name === entry.name && jobRefOf(c, slug)?.runId === entry.runId) || null;
    };
    const isCompleted = (c, wantSuccess) => String(c?.status || '').toUpperCase() === 'COMPLETED' && (String(c?.conclusion || '').toUpperCase() === 'SUCCESS') === wantSuccess;
    const escalationView = (entry, h) => ({
      repo: slug, pr: entry.pr, headSha: entry.headSha, check: entry.name, runId: entry.runId, jobId: h.jobId,
      inProgressMin: Math.max(0, Math.round((nowMs - Date.parse(entry.startedAt || entry.detectedAt || at)) / 60_000)),
      thresholdMin: Math.round((entry.thresholdSec ?? 0) / 60),
    });
    const escalations = [];

    // 1. The ledger's own work for a recovery that began with a cancel. The cancelled check leaves `in_progress`,
    //    so step 2 never sees it again: only the ledger can finish, retry or escalate it.
    for (const entry of Object.values(state.hung)) {
      const h = { pr: entry.pr, name: entry.name, runId: entry.runId, jobId: entry.jobIds?.at(-1) };
      const check = liveCheck(entry);
      if (!check) continue;
      if (entry.stage === 'cancel-requested') {
        if (!apply) continue;
        const run = readRun(h);
        if (run.error) continue;
        if (run.status === 'completed') {
          // The cancel may have lost the race to the job (it finished green first): re-running a healthy run would
          // reset its passed checks for nothing.
          if (check !== UNKNOWN && isCompleted(check, true)) { entry.stage = 'cancel-outran'; entry.updatedAt = at; log(`ci-job-hung: RESOLVED ${JSON.stringify({ repo: slug, pr: entry.pr, check: entry.name, runId: entry.runId, reason: 'the job finished green before the cancel landed' })}`); }
          else rerun(entry, h, { viaCancel: true });
        } else if (nowMs - Date.parse(entry.cancelRequestedAt || 0) >= CANCEL_GRACE_MS && !entry.forceCancelledAt) {
          try { forceCancelRun({ repo: slug, runId: h.runId }); entry.forceCancelledAt = at; record(entry, 'force-cancel', h, true); }
          catch (e) { record(entry, 'force-cancel', h, false, errText(e)); }
        }
        continue;
      }
      // A cancel-origin recovery whose re-run did not land and whose check is still cancelled (not passed, not
      // re-running — an in_progress check is step 2's, via planHungActions).
      const stranded = entry.cancelRequestedAt && /^rerun-(deferred|failed)$/.test(entry.stage || '')
        && check !== UNKNOWN && isCompleted(check, false);
      if (!stranded) continue;
      const last = (entry.actions || []).at(-1);
      if (entry.stage === 'rerun-deferred' || (last && !last.ok && isTransientGhError(last.error))) {
        if (apply) rerun(entry, h, { viaCancel: true });
      } else {
        entry.escalatedAt = entry.escalatedAt || at;
        entry.updatedAt = at;
        escalations.push({ pr: entry.pr, headSha: entry.headSha, name: entry.name, runId: entry.runId, jobId: h.jobId, action: 'escalate', key: hungKey({ pr: entry.pr, headSha: entry.headSha, name: entry.name }) });
        // Logged EVERY sweep while the check stays cancelled, with a minute count that grows each time (so log
        // de-dup never folds it away) — the same contract as the step-2 escalation below.
        log(`ci-job-hung: ESCALATE ${JSON.stringify({ ...escalationView(entry, h), reruns: entry.reruns ?? 0, reason: 'rerun-refused-after-cancel' })}`);
      }
    }

    // 2. Newly detected hangs.
    const hung = planHungActions(findHungChecks(prs, state.durations, { now: nowMs, k, floorSec, repo: slug }), state.hung, { maxReruns });
    for (const h of hung) {
      const view = { repo: slug, pr: h.pr, headSha: h.headSha, check: h.name, runId: h.runId, jobId: h.jobId, inProgressMin: Math.round(h.inProgressSec / 60), thresholdMin: Math.round(h.thresholdSec / 60) };
      if (h.action === 'handled') continue;
      if (h.action === 'escalate') {
        const entry = state.hung[h.key];
        entry.escalatedAt = entry.escalatedAt || at;
        entry.updatedAt = at;
        escalations.push({ ...h });
        // Logged EVERY sweep while the hang lasts (inProgressMin changes, so log de-dup never folds it away):
        // the health smell's episode stays open exactly as long as this keeps appearing.
        log(`ci-job-hung: ESCALATE ${JSON.stringify({ ...view, reruns: entry.reruns ?? 0 })}`);
        continue;
      }
      log(`ci-job-hung: DETECTED ${JSON.stringify(view)}`);
      if (!apply) continue;
      const run = readRun(h);
      if (run.error) {
        log(`ci-job-hung: DEFERRED ${JSON.stringify({ ...view, reason: `run status unreadable: ${run.error}` })}`);
        continue;
      }
      // The run id came from the check's own (untrusted) details URL: act only on a run for THIS PR head.
      if (!run.headSha || run.headSha !== h.headSha) {
        log(`ci-job-hung: REFUSED ${JSON.stringify({ ...view, reason: 'run does not belong to the PR head commit' })}`);
        continue;
      }
      // The job id is a second untrusted number (a third-party check can name ANY real job of this repo): it must
      // belong to that same run AND be this check's own job — before a cancel as much as before a job re-run.
      const job = readJob(h);
      if (job.error) {
        log(`ci-job-hung: DEFERRED ${JSON.stringify({ ...view, reason: `job unreadable: ${job.error}` })}`);
        continue;
      }
      if (job.runId !== h.runId || job.name !== h.name) {
        log(`ci-job-hung: REFUSED ${JSON.stringify({ ...view, reason: 'job does not belong to the run and the check' })}`);
        continue;
      }
      const status = run.status;
      const entry = state.hung[h.key] || (state.hung[h.key] = { pr: h.pr, headSha: h.headSha, name: h.name, reruns: 0, jobIds: [] });
      entry.jobIds = [...new Set([...(entry.jobIds || []), h.jobId])];
      entry.runId = h.runId;
      entry.detectedAt = at;
      entry.startedAt = h.startedAt;
      entry.thresholdSec = h.thresholdSec;
      if (status !== 'completed') {
        try { cancelRun({ repo: slug, runId: h.runId }); entry.stage = 'cancel-requested'; entry.cancelRequestedAt = at; record(entry, 'cancel', h, true); }
        catch (e) { const msg = errText(e); entry.stage = isTransientGhError(msg) ? 'cancel-deferred' : 'cancel-failed'; record(entry, 'cancel', h, false, msg); }
      } else {
        // A recovery that began with a cancel killed the WHOLE run: finish it as one even if a lagging snapshot
        // still shows the cancelled job in_progress.
        rerun(entry, h, { viaCancel: !!entry.cancelRequestedAt });
      }
    }
    try { writeHungState(state, statePath); } catch { /* best-effort — the actions above already happened and were logged */ }
    return { checkedAt: at, prs: prs.length, hung, actions, escalations };
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

/** `n >= 0`, not `n > 0` — an explicit `0` (e.g. `--watch-sec=0`) is a real, honored override, never silently
 *  discarded back to the default the way a negative/NaN/missing value correctly is (found by this item's own
 *  convergence review: the original `n > 0` guard treated an explicit zero identically to "nothing set"). */
function numFlag(flags, name, envName, fallback) {
  // `parseFlags` sets a bare `--name` (no `=value`) to the BOOLEAN `true`, and `Number(true) === 1` — a
  // malformed/valueless flag must never silently read as the number 1 (found by this item's own convergence
  // red-team), so a boolean raw value is treated the same as absent.
  const raw = flags[name] ?? (envName ? process.env[envName] : undefined);
  const n = typeof raw === 'boolean' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function main(argv) {
  const [verbRaw, ...rest] = argv;
  const verb = verbRaw && !verbRaw.startsWith('--') ? verbRaw : 'sweep';
  const flags = parseFlags(verbRaw && !verbRaw.startsWith('--') ? rest : argv);
  const repo = typeof flags.repo === 'string' && flags.repo ? flags.repo : null;
  const asJson = !!flags.json;
  const historyPath = resolveCiQueueHistoryPath(repo);

  if (verb === 'check') {
    const history = readHistory(historyPath);
    const latest = history.length ? history[history.length - 1] : { status: 'unknown', reason: 'no sample yet' };
    if (asJson) writeAllSync(1, `${JSON.stringify({ ...latest, samples: history.length })}\n`);
    else writeLineSync(2, `ci-queue-watch check: ${latest.status}${latest.reason ? ` (${latest.reason})` : ''} — ${history.length} sample(s) on file`);
    process.exitCode = 0;
    return;
  }

  if (verb !== 'sweep' && verb !== 'hung') {
    writeLineSync(2, 'usage: ci-queue-watch.mjs [sweep|check|hung] [--repo=<owner/name>] [--limit=<n>] [--hung-k=<k>] [--hung-floor-sec=<s>] [--dry-run] [--json]');
    process.exitCode = 2;
    return;
  }

  // The hung-job sweep (we:backlog/xncfkf2): part of every `sweep` (so the existing per-repo pass daemon runs
  // it with no manifest change), or alone via `hung`. `--dry-run` / `WE_CI_HUNG_ACTION=0` → detect + log only.
  const hungOpts = {
    repo,
    statePath: historyPath.replace(/(\.json)?$/, '.hung-jobs.json'),
    k: numFlag(flags, 'hung-k', HUNG_K_ENV, DEFAULT_HUNG_K),
    floorSec: numFlag(flags, 'hung-floor-sec', HUNG_FLOOR_ENV, DEFAULT_HUNG_FLOOR_SEC),
    apply: !flags['dry-run'] && process.env[HUNG_ACTION_ENV] !== '0',
  };
  const runHung = () => {
    try { return sweepHungJobs(hungOpts); }
    catch (e) { writeLineSync(2, `ci-job-hung: ERROR ${errText(e)}`); return { error: errText(e), hung: [], actions: [], escalations: [] }; }
  };

  if (verb === 'hung') {
    const hungResult = runHung();
    if (asJson) writeAllSync(1, `${JSON.stringify(hungResult)}\n`);
    else writeLineSync(2, `ci-job-hung: ${hungResult.hung.length} hung check(s), ${hungResult.actions.length} action(s), ${hungResult.escalations.length} escalation(s)`);
    process.exitCode = hungResult.error ? 1 : 0;
    return;
  }

  const limit = numFlag(flags, 'limit', null, DEFAULT_SAMPLE_LIMIT);
  const watchThresholdSec = numFlag(flags, 'watch-sec', WATCH_THRESHOLD_ENV, DEFAULT_WATCH_THRESHOLD_SEC);
  const blockedThresholdSec = numFlag(flags, 'blocked-sec', BLOCKED_THRESHOLD_ENV, DEFAULT_BLOCKED_THRESHOLD_SEC);
  const result = { ...sweepCiQueue({ repo, limit, historyPath, watchThresholdSec, blockedThresholdSec }) };
  const hungResult = runHung();
  result.hung = { count: hungResult.hung.length, actions: hungResult.actions.length, escalations: hungResult.escalations.length, ...(hungResult.error ? { error: hungResult.error } : {}) };

  if (asJson) writeAllSync(1, `${JSON.stringify(result)}\n`);
  else {
    writeLineSync(
      2,
      `ci-queue-watch sweep: ${result.status} — ${result.started}/${result.sampled} run(s) started, ` +
        `max wait ${Math.round(result.maxWaitSeconds)}s, avg ${Math.round(result.avgWaitSeconds)}s` +
        `${result.persisted ? '' : ' [history not persisted]'}`,
    );
    if (result.reason) writeLineSync(2, `  ${result.reason}`);
  }
  process.exitCode = 0;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main(process.argv.slice(2)).catch((e) => {
    writeLineSync(2, `✗ ci-queue-watch error: ${String((e && e.stack) || e)}`);
    process.exit(1);
  });
}

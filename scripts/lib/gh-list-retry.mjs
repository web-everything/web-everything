/**
 * @file scripts/lib/gh-list-retry.mjs
 * @description Retry-with-backoff for an open-PR LIST read, plus a loud failure signal (504 incident 2026-11-03:
 * `gh pr list` over 200 PRs timed out all day and the review daemon read "0 owed").
 *
 * - A transient 502/503/504 (anywhere in the error's cause chain) is retried with backoff.
 * - A persistent failure is RETHROWN, never turned into an empty list.
 * - After `threshold` exhausted calls in a row for the same repo+op, a `gh-list-failed` health event is appended
 *   to the shared daemon-events file (sync, so a short-lived fast drain still records it). A success resets it.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { daemonEventsPath } from './daemon-events.mjs';
import { GH_TRANSIENT_SERVER_PATTERNS } from './gh-throttle.mjs';

// The sleep is SYNCHRONOUS inside the daemon's event loop: keep the total to a couple of seconds per read.
export const GH_LIST_BACKOFF_MS = Object.freeze([500, 1500]);
export const GH_LIST_FAIL_THRESHOLD = 3;

/** Backoff schedule, overridable by WE_GH_LIST_BACKOFF_MS (comma-separated ms) so sims and soaks need not sleep for real. */
export function listBackoffFromEnv(env = process.env) {
  const raw = env?.WE_GH_LIST_BACKOFF_MS;
  if (typeof raw !== 'string' || !raw.trim()) return GH_LIST_BACKOFF_MS;
  const parsed = raw.split(',').map((x) => Number(x.trim()));
  return parsed.every((n) => Number.isFinite(n) && n >= 0) ? Object.freeze(parsed) : GH_LIST_BACKOFF_MS;
}

const textOf = (e) => {
  const parts = [];
  for (let c = e, i = 0; c && i < 4; c = c.cause, i++) parts.push(c.message, c.stderr && String(c.stderr));
  return parts.filter(Boolean).join('\n');
};
/** PURE: is this list failure a transient server error worth retrying? */
export const isTransientListFailure = (e) => GH_TRANSIENT_SERVER_PATTERNS.some((re) => re.test(textOf(e)));

const syncSleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best-effort */ } };

const streakFile = (env) => join(dirname(daemonEventsPath({ env })), 'gh-list-streaks.json');
function loadStreaks(env) { try { return new Map(Object.entries(JSON.parse(readFileSync(streakFile(env), 'utf8')))); } catch { return new Map(); } }
function saveStreaks(env, m) { try { const f = streakFile(env); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(Object.fromEntries(m))); } catch { /* best-effort */ } }

function appendEvent(ev, env) {
  try {
    const p = daemonEventsPath({ env });
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), ...ev })}\n`);
  } catch { /* never interrupt a daemon */ }
}

/**
 * Run `fn` (a synchronous list read). Returns its result; throws its last error when it keeps failing.
 * @param {Function} fn
 * @param {{repo?:string, op?:string, attempts?:number, backoffMs?:number[], sleep?:Function, streaks?:Map,
 *   persist?:boolean, threshold?:number, onEvent?:Function, env?:object, daemon?:string}} [o]
 */
export function withListRetry(fn, { repo = '', op = 'pr-list', attempts, backoffMs, sleep = syncSleep, streaks, persist = true,
  threshold = GH_LIST_FAIL_THRESHOLD, onEvent, env = process.env, daemon } = {}) {
  backoffMs ??= listBackoffFromEnv(env);
  attempts ??= backoffMs.length + 1;
  const key = `${repo}:${op}`;
  const map = streaks ?? (persist ? loadStreaks(env) : new Map());
  const save = () => { if (!streaks && persist) saveStreaks(env, map); };
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const out = fn();
      if (map.delete(key)) save();
      return out;
    } catch (e) {
      lastError = e;
      if (!isTransientListFailure(e) || attempt === attempts - 1) break;
      sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
    }
  }
  if (isTransientListFailure(lastError)) {
    const consecutive = (Number(map.get(key)) || 0) + 1;
    map.set(key, consecutive);
    save();
    if (consecutive >= threshold && consecutive % threshold === 0) {
      const ev = { kind: 'gh-list-failed', repo, daemon: daemon ?? process.env.WE_DAEMON_NAME ?? undefined,
        detail: { op, consecutive, error: String(lastError?.message ?? lastError).split('\n')[0].slice(0, 300) } };
      (onEvent ?? ((x) => appendEvent(x, env)))(ev);
    }
  }
  throw lastError;
}

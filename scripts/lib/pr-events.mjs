#!/usr/bin/env node
/**
 * @file scripts/lib/pr-events.mjs
 * @description The daemon-side client of the PR-events webhook feed (`we:scripts/conveyor/pr-events-worker/`).
 *
 * WHY. The review/fix daemons (and the drain) found work by polling `gh pr list` every ~2 min from ~10 daemons,
 * which exhausted the GitHub App's GraphQL budget (2026-09-26/27) while a PR still waited a median 38 min from
 * open to review start. GitHub already knows when something happens and can push it to us. This module turns
 * that push into a WAKE: one cheap HTTPS call to the Worker (not GitHub) says "these PR events happened since
 * your cursor", and a relevant one ends the daemon's sleep early so its tick runs NOW.
 *
 * WAKE-ONLY. An event is never an instruction. It only shortens the sleep; the tick still re-derives everything
 * from GitHub as before (same principle as `docs/agent/platform-decisions.md#event-driven-land-is-wake-only`).
 *
 * THE INTERVAL STAYS AS A SAFETY NET. While the feed is healthy the between-tick sleep lengthens (default
 * 10 min instead of 2); the moment the feed is unreachable, or has delivered nothing for `staleAfterMs`, it drops
 * back to the daemon's own base interval automatically. The `pr-events-stale` health smell reads the status file
 * each waker writes (`<stateDir>/<role>.json`).
 *
 * FLAG, DEFAULT OFF. Nothing changes unless `WE_PR_EVENTS=1` AND a URL AND a read token are configured:
 *   WE_PR_EVENTS=1
 *   WE_PR_EVENTS_URL=https://we-pr-events.<account>.workers.dev
 *   WE_PR_EVENTS_TOKEN_FILE=/path/to/read-token   (or WE_PR_EVENTS_TOKEN=...; the file form keeps it out of plists)
 * With the flag off, {@link withPrEvents} returns the daemon's effects object UNCHANGED (same reference).
 *
 * CLI (operator check after setup):  node scripts/lib/pr-events.mjs poll [--cursor=N]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PR_EVENTS_FLAG_ENV = 'WE_PR_EVENTS';
export const PR_EVENTS_URL_ENV = 'WE_PR_EVENTS_URL';
export const PR_EVENTS_TOKEN_ENV = 'WE_PR_EVENTS_TOKEN';
export const PR_EVENTS_TOKEN_FILE_ENV = 'WE_PR_EVENTS_TOKEN_FILE';
export const PR_EVENTS_STATE_DIR_ENV = 'WE_PR_EVENTS_STATE_DIR';

export const PR_EVENTS_DEFAULTS = Object.freeze({
  healthyIntervalMs: 10 * 60_000, // the safety-net tick while events flow
  pollEveryMs: 15_000,            // how often a sleeping daemon asks the feed (a Worker call — no GitHub budget)
  staleAfterMs: 60 * 60_000,      // no delivery at all for this long → fall back to the base interval
  minWakeGapMs: 10_000,           // never tick back-to-back faster than this, however busy the feed is
  timeoutMs: 8_000,
  limit: 200,
});

export function defaultStateDir(env = process.env) {
  return env[PR_EVENTS_STATE_DIR_ENV] || join(homedir(), '.claude', 'pr-events');
}

/** Resolve the flag + endpoint + token. `enabled` is true only when all three are present. Never logs the token. */
export function resolvePrEventsConfig(env = process.env, { readFile = readFileSync } = {}) {
  const flag = env[PR_EVENTS_FLAG_ENV] === '1';
  const url = (env[PR_EVENTS_URL_ENV] || '').replace(/\/+$/, '') || null;
  let token = env[PR_EVENTS_TOKEN_ENV] || null;
  let tokenError = null;
  if (!token && env[PR_EVENTS_TOKEN_FILE_ENV]) {
    try { token = String(readFile(env[PR_EVENTS_TOKEN_FILE_ENV], 'utf8')).trim() || null; } catch (e) { tokenError = `token file unreadable (${e?.code || 'error'})`; }
  }
  const missing = [];
  if (flag && !url) missing.push(PR_EVENTS_URL_ENV);
  if (flag && !token) missing.push(`${PR_EVENTS_TOKEN_FILE_ENV} or ${PR_EVENTS_TOKEN_ENV}`);
  return { flag, enabled: flag && !!url && !!token, url, token, missing, tokenError, stateDir: defaultStateDir(env) };
}

/**
 * ONE HTTPS GET: every event since `cursor`. Never throws — `{ ok:false, error }` on any failure.
 * @returns {Promise<{ok:true, cursor:number, events:object[], gap:boolean, reset:boolean, more:boolean,
 *   lastEventAt:number|null, lastDeliveryAt:number|null} | {ok:false, error:string}>}
 */
export async function pollEvents(cursor, { url, token, fetchImpl = globalThis.fetch, timeoutMs = PR_EVENTS_DEFAULTS.timeoutMs, limit = PR_EVENTS_DEFAULTS.limit } = {}) {
  if (!url || !token) return { ok: false, error: 'not configured' };
  const q = new URLSearchParams({ limit: String(limit) });
  if (Number.isInteger(cursor)) q.set('cursor', String(cursor));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}/events?${q}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    if (!body || !Number.isInteger(body.cursor) || !Array.isArray(body.events)) return { ok: false, error: 'malformed response' };
    return {
      ok: true, cursor: body.cursor, events: body.events, gap: !!body.gap, reset: !!body.reset, more: !!body.more,
      lastEventAt: body.lastEventAt ?? null, lastDeliveryAt: body.lastDeliveryAt ?? null,
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e?.message || e).split('\n')[0] };
  } finally {
    clearTimeout(timer);
  }
}

/** PURE: 'unreachable' (last poll failed / never succeeded) | 'stale' (reachable but nothing delivered lately) | 'healthy'. */
export function classifyFeedHealth({ lastOkAt, lastFailAt, lastDeliveryAt, now, staleAfterMs = PR_EVENTS_DEFAULTS.staleAfterMs }) {
  if (lastOkAt == null || (lastFailAt != null && lastFailAt >= lastOkAt)) return 'unreachable';
  if (lastDeliveryAt == null || now - lastDeliveryAt > staleAfterMs) return 'stale';
  return 'healthy';
}

/** PURE: the between-tick sleep for a feed health. Only 'healthy' earns the long interval. */
export function effectiveIntervalMs(health, { baseIntervalMs, healthyIntervalMs = PR_EVENTS_DEFAULTS.healthyIntervalMs }) {
  return health === 'healthy' ? Math.max(baseIntervalMs, healthyIntervalMs) : baseIntervalMs;
}

const NOT_GREEN = (c) => c != null && !['success', 'neutral', 'skipped'].includes(c);

/** Which events wake which daemon. Anything not listed is ignored by that role. */
export const ROLE_RELEVANCE = Object.freeze({
  // Review daemon: a PR appearing, moving, changing labels or finishing CI can make a review owed.
  review: (e) => e.type === 'pull_request' || e.type === 'check_suite' || e.type === 'check_run',
  // Fix daemon: a red check, a changes-requested review, a label flip (review:changes / ci:failed), a new push.
  fix: (e) => (e.type === 'pull_request' && ['labeled', 'unlabeled', 'synchronize', 'closed'].includes(e.action))
    || ((e.type === 'check_suite' || e.type === 'check_run') && NOT_GREEN(e.conclusion))
    || (e.type === 'pull_request_review' && e.state === 'changes_requested')
    // An advisory note or an operator ruling can make a fix owed (live 2026-10-09, PR #4624).
    || (e.type === 'issue_comment' && (e.kind === 'advisory' || e.kind === 'ruling')),
  // Drain: the last land-precondition completing — green CI, an approving review, a review:* label, ready/closed.
  drain: (e) => (e.type === 'pull_request' && ['labeled', 'unlabeled', 'ready_for_review', 'closed'].includes(e.action))
    || (e.type === 'check_suite' && e.conclusion === 'success')
    || (e.type === 'pull_request_review' && e.action === 'submitted'),
});

export function isRelevantEvent(event, role, { repos = null } = {}) {
  if (!event || typeof event !== 'object') return false;
  if (Array.isArray(repos) && repos.length && !repos.includes(event.repo)) return false;
  const rule = ROLE_RELEVANCE[role];
  return rule ? !!rule(event) : true;
}

const describe = (e) => `${e.repo}#${(e.prs || []).join(',') || '?'} ${e.type}.${e.action}${e.label ? `(${e.label})` : ''}${e.conclusion ? `=${e.conclusion}` : ''}${e.state ? `=${e.state}` : ''}`;

export function writeStatusFile(dir, role, status) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${role}.json`);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status)}\n`);
  renameSync(tmp, p);
}

/** Every waker status file in `dir` (the `pr-events-stale` smell's probe). `[]` when the dir is absent. */
export function readPrEventsStatuses(dir = defaultStateDir()) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { /* torn write — next tick */ }
  }
  return out;
}

/**
 * The event-aware sleep. `sleep(baseIntervalMs)` returns when EITHER a relevant event arrives (after at least
 * `minWakeGapMs`) OR the effective interval elapses — `healthyIntervalMs` while the feed is healthy, the base
 * interval otherwise (re-evaluated on every poll, so a feed that dies mid-sleep shortens that same sleep).
 *
 * The cursor lives in this closure: events that arrive while a tick is running are seen by the NEXT sleep's
 * first poll, which wakes (after the min gap) — nothing is lost between ticks. A `gap` (pruned events) or a
 * `reset` after the first poll (the log was recreated) also wakes: "something may have happened" → full tick.
 *
 * @param {{role:string, repos?:string[]|null, url:string, token:string, stateDir?:string|null,
 *   healthyIntervalMs?:number, pollEveryMs?:number, staleAfterMs?:number, minWakeGapMs?:number,
 *   poll?:Function, now?:()=>number, rawSleep?:(ms:number)=>Promise<void>,
 *   forward?:Array<{role:string, send:(events:object[])=>any}>, writeStatus?:Function|null, log?:Console}} o
 */
export function createEventWaker(o) {
  const {
    role, repos = null, url, token, stateDir = null,
    healthyIntervalMs = PR_EVENTS_DEFAULTS.healthyIntervalMs, pollEveryMs = PR_EVENTS_DEFAULTS.pollEveryMs,
    staleAfterMs = PR_EVENTS_DEFAULTS.staleAfterMs, minWakeGapMs = PR_EVENTS_DEFAULTS.minWakeGapMs,
    poll = pollEvents, now = () => Date.now(), rawSleep = (ms) => new Promise((r) => { setTimeout(r, ms); }),
    forward = [], log = console,
  } = o;
  const writeStatus = o.writeStatus !== undefined ? o.writeStatus : (stateDir ? (s) => writeStatusFile(stateDir, role, s) : null);
  const st = { cursor: null, lastOkAt: null, lastFailAt: null, lastDeliveryAt: null, lastEventAt: null, lastError: null, initialized: false };
  let lastBase = null;

  const health = () => classifyFeedHealth({ ...st, now: now(), staleAfterMs });

  function report() {
    if (!writeStatus) return;
    const h = health();
    try {
      writeStatus({
        role, repos, health: h, cursor: st.cursor, lastOkAt: st.lastOkAt, lastFailAt: st.lastFailAt,
        lastDeliveryAt: st.lastDeliveryAt, lastEventAt: st.lastEventAt, lastError: st.lastError,
        effectiveIntervalMs: lastBase == null ? null : effectiveIntervalMs(h, { baseIntervalMs: lastBase, healthyIntervalMs }),
        pollEveryMs, staleAfterMs, updatedAt: now(),
      });
    } catch (e) { log.error(`pr-events(${role}): status write failed (non-fatal): ${String(e?.message || e).split('\n')[0]}`); }
  }

  /** One poll (plus follow-up pages while `more`, bounded). Returns `{ wake, reason, events }`. */
  async function pollOnce() {
    const relevant = [];
    const all = [];
    let wakeReason = null;
    for (let page = 0; page < 5; page += 1) {
      const r = await poll(st.cursor, { url, token });
      if (!r.ok) {
        st.lastFailAt = now();
        st.lastError = r.error;
        break;
      }
      st.lastOkAt = now();
      st.lastError = null;
      st.lastDeliveryAt = r.lastDeliveryAt;
      st.lastEventAt = r.lastEventAt;
      if (r.reset && st.initialized) wakeReason = 'feed reset';
      if (r.gap) wakeReason = 'feed gap (events pruned before read)';
      st.initialized = true;
      st.cursor = r.cursor;
      for (const e of r.events) {
        all.push(e);
        if (isRelevantEvent(e, role, { repos })) relevant.push(e);
      }
      if (!r.more) break;
    }
    for (const f of forward) {
      const hits = all.filter((e) => isRelevantEvent(e, f.role, { repos }));
      if (!hits.length) continue;
      try { await f.send(hits); } catch (e) { log.error(`pr-events(${role}): forward to ${f.role} failed (non-fatal): ${String(e?.message || e).split('\n')[0]}`); }
    }
    if (relevant.length) wakeReason = `${relevant.length} event(s): ${relevant.slice(0, 5).map(describe).join('; ')}${relevant.length > 5 ? '; …' : ''}`;
    report();
    return { wake: !!wakeReason, reason: wakeReason, events: relevant };
  }

  async function sleep(baseIntervalMs) {
    lastBase = baseIntervalMs;
    const start = now();
    let pendingWake = null;
    for (;;) {
      if (!pendingWake) {
        const r = await pollOnce();
        if (r.wake) pendingWake = r.reason;
      }
      const t = now();
      if (pendingWake && t - start >= minWakeGapMs) {
        log.error(`pr-events(${role}): woke early — ${pendingWake}`);
        return { woke: true, reason: pendingWake, sleptMs: t - start };
      }
      const deadline = start + effectiveIntervalMs(health(), { baseIntervalMs, healthyIntervalMs });
      if (t >= deadline) return { woke: false, reason: 'interval', sleptMs: t - start };
      const until = pendingWake ? start + minWakeGapMs : Math.min(deadline, t + pollEveryMs);
      await rawSleep(Math.max(1, until - t));
    }
  }

  return { sleep, pollOnce, state: st, health };
}

/** A forwarder that pokes the drain daemon's localhost `POST /nudge` (WE #2605) — a wake, never a land order. */
export function makeDrainNudgeForward({ port = Number(process.env.DRAIN_DAEMON_PORT) || 4599, fetchImpl = globalThis.fetch, timeoutMs = 3_000 } = {}) {
  return {
    role: 'drain',
    send: async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/nudge`, { method: 'POST', signal: ac.signal });
        if (!res.ok) throw new Error(`drain nudge HTTP ${res.status}`);
      } finally { clearTimeout(timer); }
    },
  };
}

/**
 * Wrap a daemon's `runDaemonLoop` effects so its sleep becomes event-aware. Flag OFF (or config incomplete) →
 * returns `effects` itself, unchanged. Composes with `withSelfSync`/`withGithubAppAuth` in any order.
 */
export function withPrEvents(effects, { role, env = process.env, repos = null, forward = [], log = console, ...overrides } = {}) {
  const cfg = resolvePrEventsConfig(env);
  if (!cfg.enabled) {
    if (cfg.flag) log.error(`pr-events(${role}): ${PR_EVENTS_FLAG_ENV}=1 but not configured (missing ${cfg.missing.join(', ') || cfg.tokenError}) — keeping the plain interval`);
    return effects;
  }
  const waker = createEventWaker({ role, repos, url: cfg.url, token: cfg.token, stateDir: cfg.stateDir, forward, log, ...overrides });
  log.error(`pr-events(${role}): event-driven wake ON (${cfg.url}); safety-net tick ${overrides.healthyIntervalMs ?? PR_EVENTS_DEFAULTS.healthyIntervalMs}ms while healthy`);
  return { ...effects, sleep: waker.sleep };
}

// ── CLI: an operator's one-shot check that the feed answers ─────────────────────────────────────────────────
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'poll') { console.log('usage: node scripts/lib/pr-events.mjs poll [--cursor=N]'); process.exitCode = 2; return; }
  const cfg = resolvePrEventsConfig({ ...process.env, [PR_EVENTS_FLAG_ENV]: '1' });
  if (!cfg.enabled) { console.error(`pr-events: not configured — set ${cfg.missing.join(', ')}${cfg.tokenError ? ` (${cfg.tokenError})` : ''}`); process.exitCode = 1; return; }
  const c = rest.find((a) => a.startsWith('--cursor='));
  const r = await pollEvents(c ? Number(c.slice(9)) : null, { url: cfg.url, token: cfg.token });
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exitCode = 1;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) main(process.argv.slice(2));

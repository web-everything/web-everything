/**
 * @file scripts/conveyor/fixer-stuck-reclaim.mjs
 * @description THE CONSUMER of the session watchdog's `session-watchdog.fixer-stuck` escalation events (card xccgzu5).
 *
 * LIVE INCIDENT 2026-10-08. The health watch flagged `[high] fixer-stuck pr:we#4453` for 14+ minutes, and nothing
 * happened. `ci-heal-4453` had pushed its heal, marked an await-verify wait, and gone idle for over an hour. It kept
 * the PR's fix claim and one of the two reserved ci-heal slots the whole time. That starved #4447 and #4439 (`refused
 * fix-cap … held by ci-heal #4453 … this PR is next in line`) and scope-blocked #4446. The watchdog
 * (we:scripts/conveyor/session-watchdog.mjs) writes one event per stuck episode to
 * `<coordination root>/session-watchdog/fixer-escalations.jsonl` (contract v1). Its contract says "consumed by the
 * fixer-escalation ladder once it lands". No reader was ever wired, so every event waited forever and the smell
 * told the operator to "decide by hand".
 *
 * WHAT THIS DOES. Once per fix-daemon tick, before any fresh dispatch, for each event nobody has acknowledged:
 *   - the claim is gone, or a different session holds it   → ack `superseded` (someone else owns the PR now);
 *   - the stuck session is waiting on a verify for a commit it has NOT pushed yet → hold (the await-verify harness
 *     owns that wait, and it is bounded by its own TTL and retry cap);
 *   - a `stalled` session that has done something recently  → hold (it came back; the watchdog re-judges it);
 *   - otherwise                                             → RECLAIM: stop the session, `fix-end` its fix claim
 *     (unlabel + the PR-thread fix-end comment), release its dispatch claim, clear its await-verify store record,
 *     and ack the event. The same tick's ci-heal/fix dispatch then sees a red PR with nobody on it and re-dispatches.
 *
 * A wait for a commit that IS already the PR head protects nothing: the push already happened and GitHub CI owns
 * that verdict. That is exactly #4453's shape (await record sha 299805a8 == PR head, CI already red on it).
 *
 * Kill switch `WE_FIXER_STUCK_RECLAIM=0` (report only). Every IO seam is injectable. PURE core:
 * {@link planFixerStuckReclaim}. IO shell: {@link runFixerStuckReclaimPass}.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ESCALATION_EVENT_TYPE, DEFAULT_SESSION_WATCHDOG, watchdogEventDir } from './session-watchdog.mjs';
import { listLiveFixClaims, fixEnd } from './fix-procedure.mjs';
import { releaseSessionFixDispatchClaims } from './fix-dispatch-claim.mjs';
import { readStoredAwaitVerify, clearStoredAwaitVerify, resolveAwaitVerifyTtlMs } from './await-verify.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

const MINUTE = 60_000;
export const RECLAIM_ACK_BY = 'fix-dispatch:stuck-fixer-reclaim';
/** A `waiting-loop` session is busy by definition (it loops), so idleness cannot prove it is still stuck. Its event
 *  gets this long for the ladder or the operator to act before the daemon reclaims. */
export const DEFAULT_WAIT_LOOP_GRACE_MINUTES = 15;

export function reclaimEnabled(env = process.env) { return String(env?.WE_FIXER_STUCK_RECLAIM ?? '').trim() !== '0'; }

const lower = (s) => String(s ?? '').toLowerCase();

/**
 * Decide, for every unacknowledged event, whether to reclaim, hold or ack it. PURE.
 * @param {{events:object[], acked:Set<string>, claims:object[], awaitFor:(sessionId:string, name:string)=>object|null,
 *   prHeadFor:(repo:string, pr:number)=>string|null, lastActivityMsFor:(sessionId:string)=>number|null,
 *   nowMs:number, awaitTtlMs?:number, stalledIdleMinutes?:number, waitLoopGraceMinutes?:number}} o
 * @returns {Array<{key:string, event:object, decision:'reclaim'|'hold'|'ack', reason:string, claim?:object}>}
 */
export function planFixerStuckReclaim({
  events, acked, claims, awaitFor = () => null, prHeadFor = () => null, lastActivityMsFor = () => null, nowMs,
  awaitTtlMs = resolveAwaitVerifyTtlMs(), stalledIdleMinutes = DEFAULT_SESSION_WATCHDOG.stalledIdleMinutes,
  waitLoopGraceMinutes = DEFAULT_WAIT_LOOP_GRACE_MINUTES,
}) {
  const out = [];
  const seen = new Set();
  for (const event of events || []) {
    if (event?.type !== ESCALATION_EVENT_TYPE || !event.key || acked.has(event.key) || seen.has(event.key)) continue;
    seen.add(event.key);
    const sid = event.session?.sessionId ?? null;
    const name = event.session?.name ?? null;
    const row = (decision, reason, extra = {}) => out.push({ key: event.key, event, decision, reason, ...extra });
    const claim = (claims || []).find((c) => c.meta?.repo === event.repo && Number(c.meta?.pr) === Number(event.pr));
    if (!claim) { row('ack', 'superseded: no live fix claim on the PR any more'); continue; }
    const holderSid = claim.meta?.sessionId ?? null;
    const sameHolder = holderSid ? holderSid === sid : (!!name && claim.meta?.who === name);
    if (!sameHolder) { row('ack', `superseded: the claim is now held by ${claim.meta?.who ?? claim.owner ?? 'someone else'}`); continue; }
    const record = awaitFor(sid, name);
    const recordAgeMs = record ? nowMs - Date.parse(record.requestedAt ?? '') : NaN;
    if (record && Number.isFinite(recordAgeMs) && recordAgeMs <= awaitTtlMs) {
      const head = prHeadFor(event.repo, event.pr);
      if (!head) { row('hold', 'awaiting-verify and the PR head is unknown — the harness owns the wait'); continue; }
      if (lower(head) !== lower(record.sha)) {
        row('hold', `awaiting-verify on unpushed ${String(record.sha).slice(0, 9)} — the harness owns the wait (TTL ${Math.round(awaitTtlMs / MINUTE)} min)`);
        continue;
      }
    }
    if (event.classification === 'stalled') {
      const last = lastActivityMsFor(sid);
      if (Number.isFinite(last) && nowMs - last < stalledIdleMinutes * MINUTE) {
        row('hold', `active ${Math.round((nowMs - last) / MINUTE)} min ago — no longer idle`);
        continue;
      }
    } else {
      const ageMs = nowMs - Date.parse(event.at ?? '');
      if (!Number.isFinite(ageMs) || ageMs < waitLoopGraceMinutes * MINUTE) {
        row('hold', `${event.classification} event is ${Number.isFinite(ageMs) ? Math.round(ageMs / MINUTE) : '?'} min old (grace ${waitLoopGraceMinutes} min)`);
        continue;
      }
    }
    const why = record ? `its verify wait is for ${String(record.sha).slice(0, 9)}, already the PR head (CI owns that verdict)` : 'no verify wait in flight';
    row('reclaim', `${event.classification} (${event.reason ?? '?'}); ${why}`, { claim });
  }
  return out;
}

// ── IO shell ─────────────────────────────────────────────────────────────────────────────────────────────────

function readJsonl(file, maxLines = 2000) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-maxLines)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Newest-entry timestamp in a session's own transcript (`~/.claude/projects/<any>/<sessionId>.jsonl`). Null when unknown. */
export function transcriptLastActivityMs(sessionId, { projectsDir = join(homedir(), '.claude', 'projects'), tailBytes = 256 * 1024 } = {}) {
  if (!sessionId || !/^[0-9a-f-]{8,}$/i.test(sessionId)) return null;
  let file = null;
  try {
    for (const d of readdirSync(projectsDir)) {
      const f = join(projectsDir, d, `${sessionId}.jsonl`);
      if (existsSync(f)) { file = f; break; }
    }
  } catch { return null; }
  if (!file) return null;
  try {
    const size = statSync(file).size;
    const text = readFileSync(file, 'utf8');
    const lines = (size > tailBytes ? text.slice(-tailBytes) : text).split('\n');
    let last = null;
    for (const l of lines) {
      const m = /"timestamp":"([^"]+)"/.exec(l);
      const t = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(t) && (last === null || t > last)) last = t;
    }
    return last;
  } catch { return null; }
}

/** PR head from the shared open-PR snapshot (cache only, the reader the watchdog itself uses), else ONE live
 *  `gh api` read. Only a claim-holding candidate ever asks, so this is a handful of reads per tick at most. */
async function defaultPrHeadFor({ exec = execFileSync } = {}) {
  const { makeSnapshotHeadReader } = await import('./session-watchdog.mjs');
  const cached = makeSnapshotHeadReader();
  return (repoKey, pr) => {
    const hit = cached(repoKey, pr);
    if (hit) return hit;
    const slug = CONSTELLATION_REPOS[repoKey]?.slug;
    if (!slug) return null;
    try {
      const sha = String(exec('gh', ['api', `repos/${slug}/pulls/${Number(pr)}`, '--jq', '.head.sha'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
      return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    } catch { return null; }
  };
}

/**
 * ONE reclaim pass. Never throws; one event's failure never stops the rest.
 * @returns {Promise<{enabled:boolean, rows:Array<object>}>}
 */
export async function runFixerStuckReclaimPass({
  env = process.env,
  nowMs = Date.now(),
  eventDir = watchdogEventDir(),
  readEvents = () => readJsonl(join(eventDir, 'fixer-escalations.jsonl')),
  readAcked = () => new Set(readJsonl(join(eventDir, 'fixer-escalations.ack.jsonl')).map((e) => e.key).filter(Boolean)),
  appendAck = (ack) => { mkdirSync(eventDir, { recursive: true }); appendFileSync(join(eventDir, 'fixer-escalations.ack.jsonl'), `${JSON.stringify(ack)}\n`); },
  listClaims = () => listLiveFixClaims({ nowMs }),
  awaitFor = (sid, name) => readStoredAwaitVerify(sid) ?? readStoredAwaitVerify(name),
  clearAwait = (sid, name) => (clearStoredAwaitVerify(sid).cleared || clearStoredAwaitVerify(name).cleared),
  prHeadFor = null,
  lastActivityMsFor = (sid) => transcriptLastActivityMs(sid),
  stopSession = null,
  endFix = (o) => fixEnd(o),
  releaseDispatch = releaseSessionFixDispatchClaims,
} = {}) {
  const enabled = reclaimEnabled(env);
  let plan = [];
  try {
    const headFor = prHeadFor ?? await defaultPrHeadFor();
    plan = planFixerStuckReclaim({
      events: readEvents(), acked: readAcked(), claims: listClaims(), awaitFor, prHeadFor: headFor, lastActivityMsFor, nowMs,
    });
  } catch (e) {
    return { enabled, rows: [{ decision: 'error', reason: String(e?.message ?? e).split('\n')[0] }] };
  }
  const stop = stopSession ?? (await import('../operations/dispatch-abort.mjs')).stopSession;
  const rows = [];
  for (const p of plan) {
    const row = { key: p.key, repo: p.event.repo, pr: p.event.pr, session: p.event.session?.name ?? null, decision: p.decision, reason: p.reason };
    rows.push(row);
    if (p.decision === 'hold') continue;
    if (!enabled) { row.result = 'report-only (WE_FIXER_STUCK_RECLAIM=0)'; continue; }
    try {
      if (p.decision === 'ack') {
        appendAck({ key: p.key, by: RECLAIM_ACK_BY, at: new Date(nowMs).toISOString(), action: 'superseded', reason: p.reason });
        row.result = 'acked';
        continue;
      }
      const steps = [];
      const handle = p.event.session?.id ?? p.event.session?.sessionId;
      try { const s = stop({ handle }); steps.push(s?.alreadyGone ? 'stop:already-gone' : 'stop'); } catch (e) { steps.push(`stop-failed: ${String(e?.message ?? e).split('\n')[0]}`); }
      const meta = p.claim.meta || {};
      const slug = CONSTELLATION_REPOS[meta.repo]?.slug ?? meta.repo;
      const ended = await endFix({ repo: meta.repo, pr: Number(meta.pr), who: meta.who, sessionId: meta.sessionId ?? null, token: null });
      steps.push(ended?.ok ? 'fix-end' : `fix-end-refused: ${ended?.reason ?? '?'}`);
      try {
        const r = releaseDispatch({ repo: meta.repo, pr: Number(meta.pr), who: p.event.session?.name ?? meta.who });
        steps.push(`dispatch-claims-released:${r?.released?.length ?? 0}`);
      } catch (e) { steps.push(`dispatch-release-failed: ${String(e?.message ?? e).split('\n')[0]}`); }
      try { if (clearAwait(p.event.session?.sessionId, p.event.session?.name)) steps.push('await-cleared'); } catch { /* best effort */ }
      if (ended?.ok) appendAck({ key: p.key, by: RECLAIM_ACK_BY, at: new Date(nowMs).toISOString(), action: 'reclaimed', repo: slug, pr: Number(meta.pr), steps });
      row.result = ended?.ok ? 'reclaimed' : 'reclaim-incomplete';
      row.steps = steps;
    } catch (e) {
      row.result = `error: ${String(e?.message ?? e).split('\n')[0]}`;
    }
  }
  return { enabled, rows };
}

/** One log line per acted-on or held event; quiet when nothing is pending. */
export function formatFixerStuckReclaimLines(result) {
  return (result?.rows ?? []).map((r) => `stuck-fixer-reclaim: ${r.repo ?? '?'} PR #${r.pr ?? '?'} ${r.session ?? ''} — ${r.decision}${r.result ? ` → ${r.result}` : ''} (${r.reason})${r.steps ? ` [${r.steps.join(', ')}]` : ''}`);
}

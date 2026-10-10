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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ESCALATION_EVENT_TYPE, DEFAULT_SESSION_WATCHDOG, watchdogEventDir } from './session-watchdog.mjs';
import { listLiveFixClaims, fixEnd } from './fix-procedure.mjs';
import { releaseSessionFixDispatchClaims } from './fix-dispatch-claim.mjs';
import { readStoredAwaitVerify, clearStoredAwaitVerify, resolveAwaitVerifyTtlMs } from './await-verify.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { runOrphanFixRoundPass, formatOrphanFixRoundLines } from './orphan-fix-round.mjs';

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
    const row = (decision, reason, extra = {}) => out.push({ key: event.key, event, decision, reason, ...extra });
    // One event's failing reader (await store, PR head, transcript) must not stop the others: it holds THIS event only.
    try { planOne(event, row); } catch (e) { row('hold', `planning failed (${String(e?.message ?? e).split('\n')[0]}) — held; other events are unaffected`); }
  }
  return out;

  function planOne(event, row) {
    const sid = event.session?.sessionId ?? null;
    const name = event.session?.name ?? null;
    const claim = (claims || []).find((c) => c.meta?.repo === event.repo && Number(c.meta?.pr) === Number(event.pr));
    if (!claim) { row('ack', 'superseded: no live fix claim on the PR any more'); return; }
    const holderSid = claim.meta?.sessionId ?? null;
    if (holderSid) {
      if (holderSid !== sid) { row('ack', `superseded: the claim is now held by ${claim.meta?.who ?? claim.owner ?? 'someone else'}`); return; }
    } else {
      // Name fallback: fixer names are per-PR (`ci-heal-4453`), so a name match alone cannot tell this session from a
      // newer one re-dispatched under the same name. Only an event NEWER than the claim can be about its holder.
      if (!name || claim.meta?.who !== name) { row('ack', `superseded: the claim is now held by ${claim.meta?.who ?? claim.owner ?? 'someone else'}`); return; }
      const claimedAt = Date.parse(claim.meta?.claimedAt ?? '');
      const eventAt = Date.parse(event.at ?? '');
      if (!Number.isFinite(claimedAt) || !Number.isFinite(eventAt)) { row('hold', 'unbound claim (no sessionId) and the claim or event time is unknown — cannot tell its holder from a re-dispatched session'); return; }
      if (eventAt < claimedAt) { row('ack', 'superseded: the event predates the current (unbound) claim, so it is about an earlier session'); return; }
    }
    const record = awaitFor(sid, name);
    const recordAgeMs = record ? nowMs - Date.parse(record.requestedAt ?? '') : NaN;
    if (record && Number.isFinite(recordAgeMs) && recordAgeMs <= awaitTtlMs) {
      const head = prHeadFor(event.repo, event.pr);
      if (!head) { row('hold', 'awaiting-verify and the PR head is unknown — the harness owns the wait'); return; }
      if (lower(head) !== lower(record.sha)) {
        row('hold', `awaiting-verify on unpushed ${String(record.sha).slice(0, 9)} — the harness owns the wait (TTL ${Math.round(awaitTtlMs / MINUTE)} min)`);
        return;
      }
    }
    if (event.classification === 'stalled') {
      // Hold unless POSITIVELY idle: reclaim stops a session and drops its claim, so missing evidence must not authorise it.
      const last = lastActivityMsFor(sid);
      if (!Number.isFinite(last)) { row('hold', 'session activity unknown (transcript not found or unreadable) — not reclaimed on missing evidence'); return; }
      if (nowMs - last < stalledIdleMinutes * MINUTE) {
        row('hold', `active ${Math.round((nowMs - last) / MINUTE)} min ago — no longer idle`);
        return;
      }
    } else {
      const ageMs = nowMs - Date.parse(event.at ?? '');
      if (!Number.isFinite(ageMs) || ageMs < waitLoopGraceMinutes * MINUTE) {
        row('hold', `${event.classification} event is ${Number.isFinite(ageMs) ? Math.round(ageMs / MINUTE) : '?'} min old (grace ${waitLoopGraceMinutes} min)`);
        return;
      }
    }
    const why = record ? `its verify wait is for ${String(record.sha).slice(0, 9)}, already the PR head (CI owns that verdict)` : 'no verify wait in flight';
    row('reclaim', `${event.classification} (${event.reason ?? '?'}); ${why}`, { claim });
  }
}

// ── IO shell ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Last `maxLines` records of an append-only jsonl, reading at most `tailBytes` from its end (the logs only grow). */
export function readJsonl(file, maxLines = 2000, { tailBytes = 4 * 1024 * 1024, readRange = readByteRange } = {}) {
  try {
    const size = statSync(file).size;
    const len = Math.min(size, tailBytes);
    // A tail read starts mid-line when the file is larger than the window: drop that partial first line.
    return readRange(file, size - len, len).split('\n').slice(size > tailBytes ? 1 : 0).filter(Boolean).slice(-maxLines)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Read exactly `len` bytes of `file` starting at byte `start` — never the whole file. */
function readByteRange(file, start, len) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    return buf.toString('utf8', 0, n);
  } finally { closeSync(fd); }
}

/** Newest-entry timestamp in a session's own transcript (`~/.claude/projects/<any>/<sessionId>.jsonl`). Null when unknown.
 *  Reads at most `tailBytes` from the END of the file (transcripts can be hundreds of MB). */
export function transcriptLastActivityMs(sessionId, { projectsDir = join(homedir(), '.claude', 'projects'), tailBytes = 256 * 1024, readRange = readByteRange } = {}) {
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
    const { size, mtimeMs } = statSync(file);
    const len = Math.min(size, tailBytes);
    const text = readRange(file, size - len, len);
    // A tail read starts mid-line when the file is larger than the window: drop that partial first line.
    const lines = text.split('\n').slice(size > tailBytes ? 1 : 0);
    let last = null;
    for (const l of lines) {
      const m = /"timestamp":"([^"]+)"/.exec(l);
      const t = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(t) && (last === null || t > last)) last = t;
    }
    // No parseable timestamp in the window (e.g. one entry longer than the window): the file's last write time is still
    // real evidence of activity, unlike a missing transcript.
    return last ?? (Number.isFinite(mtimeMs) ? mtimeMs : null);
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
  // Live #4715 (2026-10-10): a fix round that ENDED (not stuck) leaving `review:changes` with no owner. Runs after the
  // reclaim below, so a round this pass just reclaimed is seen on a later tick, past the guard's grace. Off under a
  // test run unless injected (the real pass reads GitHub).
  orphanPass = process.env.VITEST ? null : runOrphanFixRoundPass,
} = {}) {
  const result = await runReclaim();
  if (orphanPass) {
    try {
      const orphan = await orphanPass({ env, nowMs });
      result.orphanRounds = orphan;
      for (const r of orphan?.rows ?? []) result.rows.push({ ...r, kind: 'orphan-fix-round' });
    } catch (e) {
      result.rows.push({ kind: 'orphan-fix-round', decision: 'error', reason: String(e?.message ?? e).split('\n')[0] });
    }
  }
  return result;

  async function runReclaim() {
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
      // The claim is only released once the holder is KNOWN stopped. A session still running without a claim can push
      // beside the fixer the same tick re-dispatches, and the push guard no longer protects it. A failed stop leaves the
      // claim and the event untouched, so the next tick retries.
      try {
        const s = stop({ handle });
        if (s?.stopped === false) throw new Error('stop reported the session is still running');
        steps.push(s?.alreadyGone ? 'stop:already-gone' : 'stop');
      } catch (e) {
        steps.push(`stop-failed: ${String(e?.message ?? e).split('\n')[0]}`);
        row.result = 'stop-failed';
        row.steps = steps;
        continue;
      }
      const meta = p.claim.meta || {};
      const slug = CONSTELLATION_REPOS[meta.repo]?.slug ?? meta.repo;
      const ended = await endFix({ repo: meta.repo, pr: Number(meta.pr), who: meta.who, sessionId: meta.sessionId ?? null, token: null });
      steps.push(ended?.ok ? 'fix-end' : `fix-end-refused: ${ended?.reason ?? '?'}`);
      if (!ended?.ok) {
        // The fix claim is still held (e.g. an unbound claim needs its token, which only the fixer has; it then lapses by
        // its own TTL): freeing the dispatch claim or the await record now would let a second fixer start beside it.
        row.result = 'reclaim-incomplete';
        row.steps = steps;
        continue;
      }
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
}

/** One log line per acted-on or held event; quiet when nothing is pending. */
export function formatFixerStuckReclaimLines(result) {
  return (result?.rows ?? []).map((r) => (r.kind === 'orphan-fix-round' ? formatOrphanFixRoundLines({ rows: [r] })[0] : `stuck-fixer-reclaim: ${r.repo ?? '?'} PR #${r.pr ?? '?'} ${r.session ?? ''} — ${r.decision}${r.result ? ` → ${r.result}` : ''} (${r.reason})${r.steps ? ` [${r.steps.join(', ')}]` : ''}`));
}

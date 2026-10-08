/**
 * @file scripts/operations/sessions.mjs
 * @description Card 128 slice S1 — the `SessionRow` contract for Plateau's `/sessions` page, plus the PURE
 * projection from a `live-work` row to it (`toSessionRow`) and the operator's four-state mapping (`mapState`).
 * Definitions only: no fs, no clock, no process. Slice S2 adds the pure half of the `sessions` operation here
 * (job normalising, ended-row projection, window, subagent folding, live/ended dedupe, ordering, the declared
 * operation); the reads live in `./sessions-io.mjs`. This file is the shared vocabulary the Plateau relay
 * validator builds on.
 *
 * @typedef {Object} SessionRow
 * @property {string} id                 runId from agent-activity (sessionId, review slug, or codex-<threadId>)
 * @property {'build'|'fix'|'ci-heal'|'review'|'prepare'|'chat'|'other'} kind
 * @property {'claude'|'codex'} executor
 * @property {string|null} model         'sonnet', 'opus[1m]', ...; null when unknown
 * @property {string|null} name          the session slug (fix-4271, conveyor-4412 ...)
 * @property {string|null} card          backlog id
 * @property {{repo:string, number:number}|null} pr
 * @property {'working'|'awaiting-verify'|'blocked'|'done'} state
 * @property {string} detail             the raw sub-state: quiet|dead|permission|waiting-slot|active|done-ok|failed|stopped
 * @property {string} reason             one plain line
 * @property {string|null} startedAt     ISO
 * @property {string|null} lastActivityAt ISO
 * @property {string|null} endedAt       ISO; set only when state = done
 * @property {'pr-opened'|'verdict'|'no-pr'|'failed'|'stopped'|null} outcome
 * @property {{repo:string|null, n:number}|null} lane
 * @property {number} subagents          live subagent count under this session (S2 fills it)
 * @property {string} joinVia
 * @property {boolean} weak
 * @property {{ref:string}|null} transcript  opaque ref (the row id) - NEVER a path on the wire
 */

import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { ROLE_BY_KIND } from './agent-activity.mjs';
import { parseSessionSlug } from '../conveyor/session-slug.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';

export const SESSION_KINDS = Object.freeze(['build', 'fix', 'ci-heal', 'review', 'prepare', 'chat', 'other']);
export const SESSION_STATES = Object.freeze(['working', 'awaiting-verify', 'blocked', 'done']);
export const SESSION_EXECUTORS = Object.freeze(['claude', 'codex']);
export const SESSION_OUTCOMES = Object.freeze(['pr-opened', 'verdict', 'no-pr', 'failed', 'stopped']);

/** live-work RUN_STATES (+ the ended marker `done`) -> the operator's four states, with the raw sub-state. */
const STATE_MAP = Object.freeze({
  'working': { state: 'working', detail: 'active' },
  'idle-too-long': { state: 'working', detail: 'quiet' },
  'waiting-for-test-slot': { state: 'awaiting-verify', detail: 'waiting-slot' },
  'blocked-permission': { state: 'blocked', detail: 'permission' },
  'dead': { state: 'blocked', detail: 'dead' },
  'done': { state: 'done', detail: 'done-ok' },
});

/** @param {string} runState a live-work state or `done`. Unknown input is `working`/`unknown`, never thrown. */
export function mapState(runState) {
  return STATE_MAP[runState] ?? { state: 'working', detail: 'unknown' };
}

/** live-work `kind` (the agent-activity role, or session/subagent/background/...) -> SessionRow kind. */
export function mapKind(kind) {
  if (kind === 'session') return 'chat';
  return SESSION_KINDS.includes(kind) && kind !== 'chat' ? kind : 'other';
}

/**
 * Project one `live-work` running row to a {@link SessionRow}. PURE. Subagents are not sessions (they count on
 * their parent): returns null for them.
 * @param {object} r a `live-work` verdict.running[] row
 * @returns {SessionRow|null}
 */
export function toSessionRow(r) {
  if (!r || r.kind === 'subagent') return null;
  const { state, detail } = mapState(r.state);
  return {
    id: r.runId, kind: mapKind(r.kind), executor: r.executor === 'codex' ? 'codex' : 'claude',
    model: r.model ?? null, name: r.name ?? null, card: r.workItem ?? null, pr: r.pr ?? null,
    state, detail, reason: r.reason ?? '',
    startedAt: r.startedAt ?? null, lastActivityAt: r.lastActivityAt ?? null, endedAt: null, outcome: null,
    lane: r.lane ?? null, subagents: 0, joinVia: r.joinVia ?? 'none', weak: !!r.weak,
    transcript: r.runId ? { ref: String(r.runId) } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Slice S2 — the `sessions` operation (pure half). Reads are injected; see ./sessions-io.mjs.
// ---------------------------------------------------------------------------------------------------------------

export const SESSIONS_OP = 'sessions';

/** The review-history source reads a PER-CLONE store until D6 (run records into one shared folder) lands, so a
 *  reader in one clone cannot see another clone's review completions. Until then every verdict says so. */
export const REVIEW_HISTORY_GAP = 'review-history:per-clone-store-d6-pending';

const TERMINAL_JOB_STATES = new Set(['done', 'stopped', 'failed']);
const REASON_MAX = 140;

/** `24h` / `90m` / `2d` / `30s` / bare ms digits -> milliseconds. `''`/undefined -> 0 (live only). Anything else
 *  throws, so a typo never silently means "no history". PURE. */
export function parseWindow(text) {
  if (text === undefined || text === null || text === '') return 0;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(text).trim());
  if (!m) throw new TypeError(`sessions: ended-within ${JSON.stringify(String(text))} is not a duration like 24h, 90m or 2d`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? 'ms'];
  return Math.round(Number(m[1]) * unit);
}

const isoOrNull = (v) => {
  const ms = typeof v === 'number' ? v : Date.parse(typeof v === 'string' ? v : '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** The harness's `--model <x>` value from a job's respawn flags, or null. */
function modelOf(flags) {
  if (!Array.isArray(flags)) return null;
  const i = flags.indexOf('--model');
  return i >= 0 && typeof flags[i + 1] === 'string' && flags[i + 1] ? flags[i + 1] : null;
}

/** One tolerant parser for the harness's internal `~/.claude/jobs/<id>/state.json` (D7). Returns a small
 *  normalised job, or null when the record is not a usable ended-or-running job. PURE. */
export function normalizeJob(state) {
  if (!state || typeof state !== 'object' || typeof state.sessionId !== 'string' || !state.sessionId) return null;
  const children = Array.isArray(state.children) ? state.children : [];
  return {
    sessionId: state.sessionId,
    shortId: typeof state.daemonShort === 'string' ? state.daemonShort : null,
    name: typeof state.name === 'string' && state.name ? state.name : null,
    state: typeof state.state === 'string' ? state.state : null,
    detail: typeof state.detail === 'string' ? state.detail : '',
    model: modelOf(state.respawnFlags),
    startedAt: isoOrNull(state.createdAt),
    endedAt: isoOrNull(state.firstTerminalAt) ?? isoOrNull(state.updatedAt),
    lastActivityAt: isoOrNull(state.lastTerminalAt) ?? isoOrNull(state.updatedAt),
    prs: children.filter((c) => c && c.kind === 'pr' && typeof c.href === 'string').map((c) => c.href),
  };
}

const prFromHref = (href) => {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(href);
  if (!m) return null;
  return { repo: repoKeyForSlug(m[1]) ?? m[1], number: Number(m[2]) };
};

/** kind/card/pr a session name implies (`fix-4271` -> fix, PR 4271; `conveyor-4412` -> build, card 4412). */
function identityFromName(name) {
  const parsed = name ? parseSessionSlug(name) : null;
  const role = parsed ? ROLE_BY_KIND[parsed.kind] : null;
  const kind = role ? mapKind(role) : 'other';
  if (!parsed) return { kind, card: null, pr: null };
  return parsed.itemKind
    ? { kind, card: parsed.id, pr: null }
    : { kind, card: null, pr: { repo: parsed.repo, number: Number(parsed.id) } };
}

/** An ended Claude job -> a `done` {@link SessionRow}. PURE. Returns null for a job that has not ended. */
export function endedJobToRow(job) {
  if (!job || !TERMINAL_JOB_STATES.has(job.state)) return null;
  const id = identityFromName(job.name);
  const childPr = job.prs.map(prFromHref).find(Boolean) ?? null;
  let outcome = 'no-pr';
  if (job.state === 'failed') outcome = 'failed';
  else if (job.state === 'stopped') outcome = 'stopped';
  else if (childPr) outcome = 'pr-opened';
  return {
    id: job.sessionId, kind: id.kind, executor: 'claude', model: job.model, name: job.name, card: id.card,
    pr: childPr ?? id.pr, state: 'done', detail: job.state === 'done' ? 'done-ok' : job.state,
    reason: job.detail.slice(0, REASON_MAX) || `session ${job.state}`,
    startedAt: job.startedAt, lastActivityAt: job.lastActivityAt, endedAt: job.endedAt, outcome,
    lane: null, subagents: 0, joinVia: 'job', weak: false, transcript: { ref: job.sessionId },
  };
}

/** A review completion record (`completions/review-N.json`) -> a `done` {@link SessionRow}, or null when it is not
 *  a finished review. PURE. */
export function reviewCompletionToRow(c) {
  if (!c || c.kind !== 'review' || c.status !== 'done' || typeof c.session !== 'string') return null;
  const pr = /^\d+$/.test(String(c.pr ?? '')) ? Number(c.pr) : null;
  const ended = isoOrNull(c.updatedAt);
  return {
    id: typeof c.runId === 'string' && c.runId ? c.runId : c.session, kind: 'review',
    executor: c.provider === 'codex' ? 'codex' : 'claude', model: typeof c.model === 'string' ? c.model : null,
    name: c.session, card: null, pr: pr ? { repo: 'we', number: pr } : null, state: 'done', detail: 'done-ok',
    reason: String(c.verdict ?? c.outcome ?? 'review finished').slice(0, REASON_MAX),
    startedAt: isoOrNull(c.startedAt), lastActivityAt: ended, endedAt: ended, outcome: 'verdict',
    lane: null, subagents: 0, joinVia: 'completion', weak: false, transcript: { ref: c.session },
  };
}

/** Subagent id is `<parent id>:...`; a live subagent counts on the session whose runId (or job sessionId) it names. */
function subagentCounts(running, jobBySessionKey) {
  const counts = new Map();
  for (const r of running) {
    if (r.kind !== 'subagent') continue;
    const parent = String(r.runId).split(':')[0];
    const key = jobBySessionKey.get(parent)?.sessionId ?? parent;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const STATE_RANK = { blocked: 0, 'awaiting-verify': 1, working: 2, done: 3 };
const ms = (v) => (v ? Date.parse(v) : 0) || 0;

/** blocked, then awaiting verify, then working (latest activity first), then done (latest end first). */
export function sortSessions(rows) {
  return [...rows].sort((a, b) => {
    const r = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (r) return r;
    const t = a.state === 'done' ? ms(b.endedAt) - ms(a.endedAt) : ms(b.lastActivityAt) - ms(a.lastActivityAt);
    return t || String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Assemble the verdict. PURE: every read (live-work rows, job records, review completions) is an argument.
 *  - live rows project through {@link toSessionRow}; live subagents fold into their parent's `subagents` count;
 *  - an ended job inside `windowMs` becomes a `done` row (and so does a finished review completion);
 *  - a live row that an ended job names (by session id) is NOT live: it is shown once, as done, when the ended
 *    time is later than the live row's last activity and the job is inside the window, and dropped otherwise
 *    (an ended session never shows as running, window or not).
 * @param {{live:{observedAt:string, running:object[]}, jobs:object[], reviews:object[], windowMs:number, degraded?:string[]}} a
 */
export function assembleSessions({ live, jobs = [], reviews = [], windowMs = 0, degraded = [] }) {
  const now = Date.parse(live.observedAt);
  const running = live.running ?? [];
  const jobBySessionKey = new Map();
  for (const j of jobs) {
    jobBySessionKey.set(j.sessionId, j);
    if (j.shortId) jobBySessionKey.set(j.shortId, j);
  }
  const counts = subagentCounts(running, jobBySessionKey);
  const inWindow = (row) => windowMs > 0 && Number.isFinite(now)
    && ms(row.endedAt) >= now - windowMs && ms(row.endedAt) <= now + 60_000;

  const ended = new Map(); // id -> row
  for (const j of jobs) {
    const row = endedJobToRow(j);
    if (row) ended.set(row.id, row);
  }
  const rows = [];
  const shown = new Set();
  for (const r of running) {
    const base = toSessionRow(r);
    if (!base) continue;
    const twin = ended.get(jobBySessionKey.get(base.id)?.sessionId ?? base.id);
    if (twin) continue; // an ended session is never live; its ended row (if in the window) is added below
    base.subagents = counts.get(base.id) ?? 0;
    rows.push(base); shown.add(base.id);
  }
  for (const row of ended.values()) {
    if (!inWindow(row) || shown.has(row.id)) continue;
    row.subagents = counts.get(row.id) ?? 0;
    rows.push(row); shown.add(row.id);
  }
  for (const c of reviews) {
    const row = reviewCompletionToRow(c);
    if (!row || !inWindow(row) || shown.has(row.id)) continue;
    // A live review row for the same session slug is superseded by its completion.
    const liveIdx = rows.findIndex((x) => x.state !== 'done' && x.name === row.name && x.kind === 'review');
    if (liveIdx >= 0 && ms(row.endedAt) > ms(rows[liveIdx].lastActivityAt)) rows.splice(liveIdx, 1);
    else if (liveIdx >= 0) continue;
    rows.push(row); shown.add(row.id);
  }
  return {
    observedAt: live.observedAt, endedWindowMs: windowMs, rows: sortSessions(rows),
    degraded: [...new Set(degraded)],
  };
}

/**
 * The declared operation. Read-only; every step is `compute`. `collectLive` is the `live-work` collector's
 * `() => {observedAt, running}` (already assessed), `readHistory` returns `{jobs, reviews, degraded}`.
 * @param {{collectLive:() => object, readHistory:(o:{windowMs:number, now:number}) => object}} deps
 */
export function sessionsOperation({ collectLive, readHistory } = {}) {
  if (typeof collectLive !== 'function' || typeof readHistory !== 'function') {
    throw new TypeError('sessions needs collectLive and readHistory readers');
  }
  return op(SESSIONS_OP, {
    input: { 'ended-within': { type: 'string', required: false, default: '' } },
    verdictFrom: 'assess',
    read: compute({ reads: ['input.ended-within'], fn: ({ input }) => {
      const windowMs = parseWindow(input['ended-within']);
      const live = collectLive();
      const hist = readHistory({ windowMs, now: Date.parse(live.observedAt) });
      return { live, windowMs, jobs: hist.jobs, reviews: hist.reviews, degraded: hist.degraded };
    } }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => assembleSessions(findings.read) }),
  });
}

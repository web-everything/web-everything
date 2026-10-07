/**
 * @file scripts/operations/live-work.mjs
 * @description Card x20lkf6 (epic #3931, "Live work transparency on Plateau /wip") — the RUNNING section: one
 * row per session or job actually working right now (background dispatches: fix/ci-heal/build/prepare/review
 * jobs/canary; the operator's own interactive chats; orchestrator workers and their identifiable subagents),
 * each with the work item it is on, its kind, how long it has run, when it last did anything, a derived
 * "what's it actually doing" state, and its transcript path — so the operator stops having to open a
 * transcript by hand to answer "is anything stuck".
 *
 * REUSE, NEVER RE-DERIVE — same discipline `live-state.mjs`'s own header commits to:
 *   - the CARD/PR join is `resolveAgentActivity` (`./agent-activity.mjs`, card #3932), verbatim — this file
 *     never re-decides which card a session belongs to.
 *   - "blocked on a permission prompt" is `isPermissionWait` (`../conveyor/session-verdicts.mjs`), the SAME
 *     `status: 'waiting'` + `waitingFor` rule the session ladder already classifies on — never a second regex.
 *   - "waiting for a test slot" reuses the heavy queue's own assessed WAITING rows (`./heavy-queue.mjs`,
 *     `assessHeavyQueue`) — a run is waiting on the pool when its own lane lease's `purpose`/`session` matches
 *     a live WAITING row's `who`, never a re-guess from a pid or a command line.
 *   - pid liveness is the IO shell's own read (`./live-work-io.mjs`, reusing `review-job-store.mjs#pidAlive`)
 *     — this file only reads the already-computed `pidAlive: true|false|null` fact.
 *
 * PURE: no fs, no clock, no process. Every fact (`now`, each row's `lastActivityAt`/`pidAlive`, the heavy
 * queue's assessed rows) is injected by the IO shell or the caller.
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { resolveAgentActivity } from './agent-activity.mjs';
import { isPermissionWait } from '../conveyor/session-verdicts.mjs';

export const LIVE_WORK_OP = 'live-work';

/** The closed derived-state enum (the brief's own vocabulary, #3931). Order matters for {@link
 *  sortRunning}'s stuck/dead-first sort — a later entry is never sorted ahead of an earlier one. */
export const RUN_STATES = Object.freeze([
  'dead', 'blocked-permission', 'idle-too-long', 'waiting-for-test-slot', 'working',
]);

/** A run quiet (no transcript/log write) longer than this is `idle-too-long` — the brief's own "over 10 min". */
export const IDLE_TOO_LONG_MS = 10 * 60 * 1000;

/** `Set<string>` of every live-queue WAITING row's `who` (lease purpose/session) — {@link assessHeavyQueue}'s
 *  own already-classified rows, never re-read. A run whose OWN lease names one of these is queued on the pool.
 * @param {{rows?: Array<{state:string, who?:string|null}>}} heavyQueue - `assessHeavyQueue`'s return shape.
 */
export function waitingForSlotWhos(heavyQueue) {
  const out = new Set();
  for (const r of heavyQueue?.rows ?? []) {
    if (r.state === 'WAIT' && r.who) out.add(r.who);
  }
  return out;
}

/**
 * The DETERMINISTIC derived state for one row — pure, same inputs → byte-identical output. Checked in the
 * brief's own priority order: a confirmed-dead pid outranks everything else (a dead process cannot also be
 * "working"), then a permission-prompt block, then a heavy-queue wait, then plain idleness.
 *
 * @param {{pidAlive?:boolean|null, status?:string|null, waitingFor?:string|null, lease?:{purpose?:string,
 *   session?:string}|null, lastActivityAt?:number|null}} row
 * @param {{now:number, slotWhos?:Set<string>}} o
 * @returns {{state:string, reason:string}}
 */
export function classifyRunState(row, { now, slotWhos = new Set() } = {}) {
  if (row?.pidAlive === false) {
    return { state: 'dead', reason: 'no live process for this pid' };
  }
  if (isPermissionWait(row)) {
    return { state: 'blocked-permission', reason: `blocked on "${row.waitingFor}" — nobody to answer it` };
  }
  const who = row?.lease?.purpose || row?.lease?.session || null;
  if (who && slotWhos.has(who)) {
    return { state: 'waiting-for-test-slot', reason: 'queued on the heavy-admission pool' };
  }
  const last = row?.lastActivityAt;
  if (typeof last === 'number' && Number.isFinite(last) && Number.isFinite(now)) {
    const idleMs = Math.max(0, now - last);
    if (idleMs > IDLE_TOO_LONG_MS) {
      return { state: 'idle-too-long', reason: `quiet for ${Math.floor(idleMs / 60000)} min` };
    }
  }
  return { state: 'working', reason: 'active' };
}

/** Stuck-and-dead-first, per the brief ("sort stuck and dead first"); ties broken by the stalest first
 *  (oldest `lastActivityAt`, nulls last), then by `runId` for a fully deterministic order. */
export function sortRunning(rows) {
  const rank = new Map(RUN_STATES.map((s, i) => [s, i]));
  return [...rows].sort((a, b) => {
    const r = (rank.get(a.state) ?? RUN_STATES.length) - (rank.get(b.state) ?? RUN_STATES.length);
    if (r !== 0) return r;
    const la = typeof a.lastActivityAt === 'number' ? a.lastActivityAt : Infinity;
    const lb = typeof b.lastActivityAt === 'number' ? b.lastActivityAt : Infinity;
    if (la !== lb) return la - lb;
    return String(a.runId).localeCompare(String(b.runId));
  });
}

/** `{repo, n}` of the lane a row's lease names, or null (no lease / lease without a lane number). */
export function laneOf(lease) {
  return Number.isInteger(lease?.lane) ? { repo: lease.repo ?? null, n: lease.lane } : null;
}

/** The work-item label a row's resolved card/PR reduces to — a card wins (it is the more specific target); a
 *  bare PR (no card mapped yet) still names the PR rather than falling back to nothing. */
function workItemFor(card, pr) {
  if (card) return { card, pr: pr ?? null };
  if (pr) return { card: null, pr };
  return { card: null, pr: null };
}

/**
 * Build the RUNNING section — one row per raw session/job, joined to its card/PR via {@link
 * resolveAgentActivity}, classified via {@link classifyRunState}, sorted via {@link sortRunning}. Every raw row
 * the IO shell assembled becomes exactly one output row: matched (a `run`), unmatched-but-named (an
 * `unmatched` entry), or dropped-interactive (`resolveAgentActivity` never surfaces an unresolved interactive
 * session at all — this function still reports it, since the brief's whole point is "every session and job",
 * not only the ones already tied to a card).
 *
 * @param {object} read - {@link ./live-work-io.mjs#collectLiveWork}'s return shape: `{ observedAt, rows,
 *   prToCard, heavyQueue }`. `rows` carries every already-read fact (`pidAlive`, `lastActivityAt`,
 *   `transcriptPath`) alongside the plain fields {@link resolveAgentActivity} itself reads.
 */
export function assessLiveWork(read) {
  if (!read || !Array.isArray(read.rows)) throw new TypeError('live-work: unreadable snapshot has no rows');
  const now = Date.parse(read.observedAt);
  const slotWhos = waitingForSlotWhos(read.heavyQueue);
  const { runs, unmatched } = resolveAgentActivity(read.rows, { prToCard: read.prToCard || {} });
  const byId = new Map(read.rows.map((r) => [r.id, r]));
  const runById = new Map(runs.map((r) => [r.runId, r]));
  const unmatchedById = new Map(unmatched.map((r) => [r.runId, r]));
  const seen = new Set();
  const out = [];

  const push = (row, { kind, card = null, pr = null, weak = false, joinVia }) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    const { state, reason } = classifyRunState(row, { now, slotWhos });
    const startedAt = row.startedAt ?? null;
    const startedMs = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt ?? '');
    const wi = workItemFor(card, pr);
    out.push({
      runId: row.id, kind, workItem: wi.card, pr: wi.pr,
      startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null,
      runtimeMs: Number.isFinite(startedMs) && Number.isFinite(now) ? Math.max(0, now - startedMs) : null,
      lastActivityAt: typeof row.lastActivityAt === 'number'
        ? new Date(row.lastActivityAt).toISOString() : null,
      state, reason, transcriptPath: row.transcriptPath ?? null, joinVia, weak,
      executor: row.runtime || 'claude', model: row.model ?? null, name: row.name ?? null, lane: laneOf(row.lease),
    });
  };

  for (const run of runs) {
    const row = byId.get(run.runId);
    if (row) push(row, { kind: run.role, card: run.card, pr: run.pr ?? null, weak: !!run.weak, joinVia: run.joinVia });
  }
  for (const u of unmatched) {
    const row = byId.get(u.runId);
    if (row) push(row, { kind: row.kind, joinVia: 'unmatched' });
  }
  // Interactive sessions `resolveAgentActivity` resolved to nothing are DROPPED by that function (design intent:
  // an unresolved interactive session is not "unmatched work", it's just the operator's own chat) — but this
  // section's whole point is transparency into every session, so they are added back here, unresolved.
  for (const row of read.rows) {
    if (row.kind === 'interactive' && !runById.has(row.id) && !unmatchedById.has(row.id)) {
      push(row, { kind: 'session', joinVia: 'none' });
    }
  }
  return { observedAt: read.observedAt, running: sortRunning(out) };
}

/**
 * The declared operation. Read-only, no input required — same no-sinks reasoning as `agent-activity`/
 * `heavy-queue`: every step is `compute`. `collect` is the injected IO ({@link
 * ./live-work-io.mjs#collectLiveWork}), bound to every real read only in `run.mjs`.
 * @param {{collect: () => object}} deps
 */
export function liveWorkOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('live-work needs a collect reader');
  return op(LIVE_WORK_OP, {
    input: {},
    verdictFrom: 'assess',
    read: compute({ reads: [], fn: () => collect() }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => assessLiveWork(findings.read) }),
  });
}

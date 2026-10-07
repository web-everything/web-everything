/**
 * @file scripts/operations/sessions.mjs
 * @description Card 128 slice S1 — the `SessionRow` contract for Plateau's `/sessions` page, plus the PURE
 * projection from a `live-work` row to it (`toSessionRow`) and the operator's four-state mapping (`mapState`).
 * Definitions only: no fs, no clock, no process. The `sessions` operation itself (history readers, window,
 * dedupe) is slice S2; this file is the shared vocabulary it and the Plateau relay validator build on.
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

/**
 * @file scripts/operations/maintenance.mjs
 * @description Card 105 — the MAINTENANCE PAUSE, declared. `run.mjs maintenance --action=start|status|end --reason=…`
 *   replaces the hand-run sequence used for an account switch (dispatch-pause set + fix-dispatch.kill + a test
 *   `claude -p` after relogin + undoing both).
 *
 *   start  — pauses every Claude-starting dispatcher: the tick's build/prepare/fix/ci-heal kinds (blanket
 *            `dispatch-pause`), the fix-dispatch kill file, and the review + fix daemons (through the maintenance
 *            marker `claude-auth-health.mjs#planClaudeAuthDispatchGate` reads). Running sessions are NOT touched;
 *            they are listed (lane / PR) and finish normally.
 *   status — what is paused plus the running sessions.
 *   end    — runs ONE minimal test Claude session (policy: `scripts/lib/maintenance-policy.json`). If it fails the
 *            operation THROWS and everything stays paused; only a pass lifts the pause.
 *
 * A pause or kill file the operator set BEFORE `start` is recorded in the marker and left in place by `end`.
 * All side effects go through an injected `io` (real one: `maintenance-io.mjs`, bound as the effect sink), so tests use fakes.
 */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';

export const MAINTENANCE_OP = 'maintenance';
export const MAINTENANCE_EFFECT = 'maintenance';
export const MAINTENANCE_ACTIONS = Object.freeze(['start', 'status', 'end']);

/** A listed session → `{kind, pr, lane}` read off its name and cwd. */
export function classifySession(s) {
  const name = String(s?.name ?? '');
  const m = name.match(/^(ci-heal|fix|review)-(\d+)/);
  const lane = String(s?.cwd ?? '').match(/lane-(\d+)/);
  return {
    name, sessionId: s?.sessionId ?? null, startedAt: s?.startedAt ?? null,
    kind: m ? m[1] : 'other', pr: m ? Number(m[2]) : null, lane: lane ? Number(lane[1]) : null,
  };
}

function snapshot(io) {
  const marker = io.readMarker();
  const pause = io.readPause();
  return {
    state: marker ? 'paused' : 'running',
    marker,
    dispatchPaused: pause?.paused === true,
    killFile: io.killExists(),
    review: marker ? 'paused' : 'running',
    running: io.listSessions().map(classifySession),
  };
}

export function runMaintenance({ action, reason = '', by = 'operator' } = {}, io) {
  if (!MAINTENANCE_ACTIONS.includes(action)) throw new TypeError(`maintenance: --action must be one of ${MAINTENANCE_ACTIONS.join('|')}`);
  if (action === 'status') return snapshot(io);
  if (action === 'start') {
    if (!String(reason).trim()) throw new TypeError('maintenance start: --reason is required');
    const existing = io.readMarker();
    const prior = existing?.prior ?? { pause: io.readPause()?.paused === true, kill: io.killExists() };
    if (!prior.pause) io.setPause({ reason: `maintenance: ${reason}`, by });
    if (!prior.kill) io.touchKill();
    io.writeMarker({ startedAt: existing?.startedAt ?? io.now(), by, reason, prior });
    return snapshot(io);
  }
  // end
  const marker = io.readMarker();
  if (!marker) throw new Error('maintenance end: not in maintenance (no marker) — nothing to lift');
  const test = io.testSession();
  if (!test?.ok) {
    throw new Error(`maintenance end: login test FAILED (${String(test?.detail ?? 'no detail').slice(0, 300)}) — everything is still paused`);
  }
  if (!marker.prior?.pause) io.clearPause();
  if (!marker.prior?.kill) io.removeKill();
  io.clearMarker();
  return { ...snapshot(io), loginTest: test };
}

export function maintenanceOperation() {
  return op(MAINTENANCE_OP, {
    input: {
      action: { type: 'string', required: true, enum: [...MAINTENANCE_ACTIONS] },
      reason: { type: 'string', required: false, default: '' },
      by: { type: 'string', required: false, default: 'operator' },
    },
    verdictFrom: 'assess',
    // An `effect`, not a `compute`: this changes host state (pause files, kill file), so it must NOT read as
    // read-only to the HTTP adapter or the runner-freshness policy. The sink (`maintenance-io.mjs`) throws on a
    // failed login test, which halts the run loudly with everything still paused.
    act: effect({
      reads: ['input.action', 'input.reason', 'input.by'],
      effects: ({ input }) => [{ type: MAINTENANCE_EFFECT, payload: { action: input.action, reason: input.reason, by: input.by }, idempotent: true }],
    }),
    assess: compute({
      reads: ['findings.act'],
      fn: ({ findings }) => {
        const entry = (findings.act?.effects ?? [])[0];
        if (!entry || entry.status !== 'applied' || !entry.result) {
          throw new Error(`maintenance: the act effect did not complete. status=${entry?.status ?? 'missing'}${entry?.error ? ` error=${entry.error}` : ''}`);
        }
        return entry.result;
      },
    }),
  });
}

/**
 * @file scripts/conveyor/health-smells/build-session-idle.mjs
 * @description Health smell — a live Claude build/prepare session (`conveyor-<n>`, `prepare-item-<n>`, ...)
 *   whose transcript has not moved for `idleMs` (default 12 min). Supervision for "I don't want a model spinning
 *   for nothing" (operator 2026-10-06). DETECTION ONLY: never stops the session. Input is
 *   `probes.buildSessions` (`we:scripts/conveyor/build-supervision.mjs#probeBuildSessions`, bounded tail reads).
 *   A session blocked in a pending tool call is still reported, with that fact in the evidence.
 */
import { BUILD_SUPERVISION_DEFAULTS, fmtMin } from '../build-supervision.mjs';

export default {
  id: 'build-session-idle',
  scope: 'host',
  cadence: 'gh',
  probes: ['buildSessions'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'medium',
  action: 'alert',
  idleMs: BUILD_SUPERVISION_DEFAULTS.idleMs,
  recommendationHint: 'A build/prepare session has written nothing for a long time. Read its transcript tail before judging; do not kill it blind.',
  evaluate({ buildSessions }) {
    return (buildSessions || []).filter((s) => s.idleMs != null).map((s) => ({
      subject: `session:${s.name}`,
      breach: s.idleMs >= this.idleMs,
      measure: { session: s.name, kind: s.kind, card: s.card, pr: s.pr?.number ?? null, idleMin: Math.round(s.idleMs / 60_000),
        thresholdMin: Math.round(this.idleMs / 60_000), pendingToolCall: s.pendingToolCall, state: s.state, transcript: s.transcriptPath },
      summary: `${s.kind} session ${s.name} (card #${s.card}${s.pr ? `, PR #${s.pr.number}` : ''}) has been idle ${fmtMin(s.idleMs)}${s.pendingToolCall ? ' (blocked on a pending tool call)' : ''}.`,
      recommendation: `Read the tail of ${s.transcriptPath ?? `${s.name}'s transcript`} (inspect-agent-health). If it is blocked on a dead child or finished without exiting, stop it by hand and fix the finish detector; if it is in a long legitimate call, ignore.`,
    }));
  },
};

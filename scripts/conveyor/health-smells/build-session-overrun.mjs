/**
 * @file scripts/conveyor/health-smells/build-session-overrun.mjs
 * @description Health smell — a live Claude build/prepare session running longer than `overrunMs` (default 60
 *   min), however active its transcript looks. DETECTION ONLY. Input: `probes.buildSessions`.
 */
import { BUILD_SUPERVISION_DEFAULTS, fmtMin } from '../build-supervision.mjs';

export default {
  id: 'build-session-overrun',
  scope: 'host',
  cadence: 'gh',
  probes: ['buildSessions'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'medium',
  action: 'alert',
  overrunMs: BUILD_SUPERVISION_DEFAULTS.overrunMs,
  recommendationHint: 'A build/prepare session has run past its supervision budget. Check whether it is making real progress.',
  evaluate({ buildSessions }) {
    return (buildSessions || []).filter((s) => s.ageMs != null).map((s) => ({
      subject: `session:${s.name}`,
      breach: s.ageMs >= this.overrunMs,
      measure: { session: s.name, kind: s.kind, card: s.card, pr: s.pr?.number ?? null, ageMin: Math.round(s.ageMs / 60_000),
        thresholdMin: Math.round(this.overrunMs / 60_000), idleMin: s.idleMs == null ? null : Math.round(s.idleMs / 60_000), transcript: s.transcriptPath },
      summary: `${s.kind} session ${s.name} (card #${s.card}${s.pr ? `, PR #${s.pr.number}` : ''}) has been running ${fmtMin(s.ageMs)} (budget ${fmtMin(this.overrunMs)}).`,
      recommendation: `Read ${s.name}'s transcript tail: if it is producing commits/files, let it finish; if it is circling, stop it by hand and file the cause against the brief or the router.`,
    }));
  },
};

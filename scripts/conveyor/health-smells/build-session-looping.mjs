/**
 * @file scripts/conveyor/health-smells/build-session-looping.mjs
 * @description Health smell — a live Claude build/prepare session repeating the SAME Bash command `repeatCount`
 *   (default 4) or more times within its last 30 Bash calls: the "model spinning for nothing" shape. DETECTION
 *   ONLY. Input: `probes.buildSessions` (bounded transcript tail).
 */
import { BUILD_SUPERVISION_DEFAULTS } from '../build-supervision.mjs';

export default {
  id: 'build-session-looping',
  scope: 'host',
  cadence: 'gh',
  probes: ['buildSessions'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'high',
  action: 'alert',
  repeatCount: BUILD_SUPERVISION_DEFAULTS.repeatCount,
  recommendationHint: 'A build/prepare session keeps re-running the same command — it is likely stuck on a failure it cannot fix.',
  evaluate({ buildSessions }) {
    return (buildSessions || []).filter((s) => s.repeated).map((s) => ({
      subject: `session:${s.name}`,
      breach: s.repeated.count >= this.repeatCount,
      measure: { session: s.name, kind: s.kind, card: s.card, pr: s.pr?.number ?? null, repeats: s.repeated.count,
        threshold: this.repeatCount, command: s.repeated.command.slice(0, 200), transcript: s.transcriptPath },
      summary: `${s.kind} session ${s.name} (card #${s.card}${s.pr ? `, PR #${s.pr.number}` : ''}) ran the same command ${s.repeated.count}x recently: ${s.repeated.command.slice(0, 120)}`,
      recommendation: `Read ${s.name}'s transcript: it is retrying one command (${s.repeated.command.slice(0, 80)}). Find why it keeps failing; stop it by hand only if it is truly stuck, and fix the brief or tool that let it loop.`,
    }));
  },
};

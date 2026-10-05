/**
 * @file scripts/conveyor/health-smells/session-stuck.mjs
 * @description xegykal — a conveyor session past its kind's standard duration that the session watchdog reads as
 *   `waiting-loop` or `stalled` while holding NO PR fix claim (a build, prepare or review session; a fixer that
 *   holds a claim is the `fixer-stuck` smell instead). Visibility only: two consecutive passes before it opens,
 *   so one long legitimate wait does not alert.
 */
export default {
  id: 'session-stuck',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['sessionWatchdog'],
  openAfter: 2,
  closeAfter: 2,
  severity: 'medium',
  action: 'alert',
  recommendationHint: 'A conveyor session is looping or stalled past its standard duration. Read its transcript (inspect-agent-health) before stopping anything.',
  evaluate({ sessionWatchdog }) {
    return (sessionWatchdog?.findings || []).filter((f) => f.type === 'session-stuck').map((f) => {
      const ev = f.evidence || {};
      return {
        subject: `session:${f.session?.name}`,
        breach: true,
        measure: { kind: f.kind, classification: f.classification, reason: f.reason, runtimeMinutes: ev.runtimeMinutes ?? null, standardMinutes: ev.standardMinutes ?? null, idleMinutes: ev.idleMinutes ?? null, repeats: ev.repeats ?? null },
        summary: `${f.session?.name} (${f.kind}) is ${f.classification} (${f.reason}) after ${ev.runtimeMinutes ?? '?'}m, standard ${ev.standardMinutes ?? '?'}m${ev.repeats ? `; top command repeated ${ev.repeats}x` : ''}.`,
        recommendation: `Read ${f.session?.name}'s transcript tail (inspect-agent-health). The reaper's hung and no-outcome axes stop a truly dead session; this smell is the earlier warning.`,
      };
    });
  },
};

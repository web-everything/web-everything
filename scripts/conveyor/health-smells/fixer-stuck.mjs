/**
 * @file scripts/conveyor/health-smells/fixer-stuck.mjs
 * @description xegykal — a fixer that holds a PR fix claim while the session watchdog reads it as STUCK: a
 *   `waiting-loop` (the same command repeated, e.g. `verify-lane check --wait=540000` eleven times on fix-3771,
 *   2026-10-04) or `stalled` (idle, or one call pending, past the configured thresholds). The watchdog
 *   (`we:scripts/conveyor/session-watchdog.mjs`) also writes a typed `session-watchdog.fixer-stuck` event for the
 *   fixer-escalation ladder; until a consumer acknowledges that event, the episode is marked human-only so the
 *   WIP page lists it as needing a person. Shadow-safe: this smell never stops or re-dispatches anything.
 */
export default {
  id: 'fixer-stuck',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['sessionWatchdog'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'high',
  action: 'alert',
  recommendationHint: 'A fixer holds a PR fix claim but is looping or stalled. The escalation ladder owns the next step (see the session-watchdog event log).',
  evaluate({ sessionWatchdog }) {
    const acked = new Set(sessionWatchdog?.acked || []);
    return (sessionWatchdog?.findings || []).filter((f) => f.type === 'fixer-stuck').map((f) => {
      const ev = f.evidence || {};
      const what = f.classification === 'waiting-loop'
        ? `repeating the same command ${ev.repeats}x (${ev.signature ?? 'unknown'})`
        : `stalled (${f.reason}${ev.idleMinutes != null ? `, idle ${ev.idleMinutes}m` : ''}${ev.pendingTool ? `, pending ${ev.pendingTool}` : ''})`;
      const handedOff = acked.has(f.key);
      return {
        subject: `pr:${f.repo}#${f.pr}`,
        breach: true,
        measure: { session: f.session?.name ?? null, classification: f.classification, claimAgeMinutes: f.claimAgeMinutes, standardMinutes: f.standardMinutes, repeats: ev.repeats ?? null, idleMinutes: ev.idleMinutes ?? null, key: f.key, handedOff },
        summary: `${f.repo} PR #${f.pr}: fixer ${f.session?.name ?? '?'} has held the fix claim ${f.claimAgeMinutes ?? '?'}m (standard ${f.standardMinutes}m) and is ${what}.`,
        recommendation: handedOff
          ? `The escalation ladder acknowledged event ${f.key}; follow it there.`
          : `Escalation event ${f.key} is waiting for the fixer-escalation ladder. Until it is consumed, decide by hand whether to re-dispatch PR #${f.pr} on a stronger rung.`,
        escalation: {
          humanOnly: !handedOff, actionRef: `pr:${f.repo}#${f.pr}`,
          description: `Fixer ${f.session?.name ?? '?'} is ${f.classification} on ${f.repo} PR #${f.pr}`,
          status: 'observed', reason: handedOff ? 'handed to the escalation ladder' : 'escalation event not yet consumed',
        },
      };
    });
  },
};

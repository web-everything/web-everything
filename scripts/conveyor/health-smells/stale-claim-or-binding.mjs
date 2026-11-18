/**
 * @file scripts/conveyor/health-smells/stale-claim-or-binding.mjs
 * @description R502 item 3 — a PR fix claim held longer than `staleClaimMinutes` whose holder shows no transcript
 *   activity for `staleClaimIdleMinutes` while the PR head is still the head the claim was taken
 *   on. The orchestrator kept finding these by hand (fix claims and review-session bindings that outlived their
 *   holder). DETECTION AND ALERT ONLY: it never releases anything (auto-release is PR #6346). Thresholds are
 *   settings (`sessionWatchdog.staleClaimMinutes` / `staleClaimIdleMinutes`); the watchdog fails closed when the head
 *   or the holder's idle time is unknown. Notifies even in shadow (health-smells-notify-list.mjs).
 */
export default {
  id: 'stale-claim-or-binding',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['sessionWatchdog'],
  openAfter: 1,
  closeAfter: 3, // one inconclusive pass (missing evidence) must not close an open alert
  severity: 'high',
  action: 'alert',
  recommendationHint: 'A claim is held by a silent holder on an unmoved head. Read the holder\'s transcript (inspect-agent-health) before releasing anything.',
  evaluate({ sessionWatchdog } = {}) {
    return (sessionWatchdog?.findings || []).filter((f) => f.type === 'stale-claim').map((f) => ({
      subject: `pr:${f.repo}#${f.pr}`,
      breach: true,
      measure: { session: f.session?.name ?? null, claimAgeMinutes: f.claimAgeMinutes, holderIdleMinutes: f.holderIdleMinutes ?? null,
        holderClass: f.holderClass, headSha: f.headSha, thresholdMinutes: f.thresholdMinutes, idleThresholdMinutes: f.idleThresholdMinutes },
      summary: `${f.repo} PR #${f.pr}: claim by ${f.session?.name ?? '?'} held ${f.claimAgeMinutes}m (alert after ${f.thresholdMinutes}m); holder ${f.holderIdleMinutes == null ? 'is not listed' : `silent ${f.holderIdleMinutes}m`}; head still ${String(f.headSha).slice(0, 9)}.`,
      recommendation: `Read ${f.session?.name ?? 'the holder'}'s transcript tail (inspect-agent-health). If it is gone or looping, release the claim through the claim-release path; this smell only reports.`,
      escalation: {
        humanOnly: true, actionRef: `pr:${f.repo}#${f.pr}`,
        description: `Stale claim on ${f.repo} PR #${f.pr}: held ${f.claimAgeMinutes}m, holder silent, head unchanged`,
        status: 'observed', reason: 'claim held past the stale threshold by a silent holder, head unchanged',
      },
    }));
  },
};

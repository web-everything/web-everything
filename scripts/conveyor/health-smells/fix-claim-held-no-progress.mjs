/**
 * @file scripts/conveyor/health-smells/fix-claim-held-no-progress.mjs
 * @description xegykal — a PR fix claim (`fix-procedure.mjs`, kind `fixing`) held longer than its kind's standard
 *   duration while the PR head is still the head the claim was taken on: no push since the claim. Live
 *   2026-10-04: fix-3771 held its claim 1h27 with no push and no smell measured claim age. The PR head comes from
 *   the shared open-PR snapshot read cache-only (no API call); an unknown head never breaches.
 */
export default {
  id: 'fix-claim-held-no-progress',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['sessionWatchdog'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'medium',
  action: 'alert',
  recommendationHint: 'A fix claim has been held past the standard duration with no push. Read the fixer\'s transcript (inspect-agent-health) before anything else.',
  evaluate({ sessionWatchdog }) {
    return (sessionWatchdog?.findings || []).filter((f) => f.type === 'fix-claim-held-no-progress').map((f) => ({
      subject: `pr:${f.repo}#${f.pr}`,
      breach: true,
      measure: { session: f.session?.name ?? null, claimAgeMinutes: f.claimAgeMinutes, standardMinutes: f.standardMinutes, headSha: f.headSha, holderClass: f.holderClass },
      summary: `${f.repo} PR #${f.pr}: fix claim by ${f.session?.name ?? '?'} held ${f.claimAgeMinutes}m (standard ${f.standardMinutes}m); the PR head is still ${String(f.headSha).slice(0, 9)} — no push since the claim. The holder reads ${f.holderClass}.`,
      recommendation: `Check what ${f.session?.name ?? 'the holder'} is doing (inspect-agent-health on its transcript). If it is looping or gone, the fixer-stuck / ghost paths take over; otherwise it is slow, not stuck.`,
      escalation: {
        humanOnly: true, actionRef: `pr:${f.repo}#${f.pr}`,
        description: `Fix claim on ${f.repo} PR #${f.pr} held ${f.claimAgeMinutes}m with no push`,
        status: 'observed', reason: 'claim held past the standard duration, head unchanged',
      },
    }));
  },
};

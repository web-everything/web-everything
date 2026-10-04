import { missingReviewLabel } from '../reconcile-core.mjs';

export default {
  id: 'review-label-missing', scope: 'repo', cadence: 'gh', probes: ['prs'],
  openAfter: 2, closeAfter: 1, severity: 'medium', action: 'alert',
  missingSubjectsUnknown: true,
  evaluate({ prs }, { lastTick = null, now } = {}) {
    const out = [];
    const previousAt = lastTick?.completedAt ?? lastTick;
    for (const pr of prs || []) {
      const observed = pr.reviewObservation;
      if (!observed || !Number.isFinite(observed.observedAt)
        || observed.observedAt > now || (previousAt != null && observed.observedAt <= previousAt)) continue;
      const breach = missingReviewLabel(observed);
      if (breach === null) continue;
      out.push({ subject: `${pr.repo}#${pr.number}`, breach,
        measure: { repo: pr.repo, number: pr.number, observedAt: observed.observedAt, labels: observed.labels },
        summary: `${pr.repo}#${pr.number}: open agent PR has no review:* label.`,
        recommendation: 'Inspect the CI-heal completion handoff and restore independent review through the guarded re-arm command.',
      });
    }
    return out;
  },
};

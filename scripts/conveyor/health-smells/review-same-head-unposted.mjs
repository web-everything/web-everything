/** Live #202: completed panels silently parked and the daemon kept reviewing the same head. */
import { DEFAULT_HEALTH_CONFIG, fmtAge } from '../health-watch-core.mjs';

const POSTED_RESULT_TYPES = new Set(['review.advisory-note', 'review.write-up', 'review.label-swap']);

export default {
  id: 'review-same-head-unposted', scope: 'repo', cadence: 'every-tick',
  probes: ['operationRuns'], openAfter: 1, closeAfter: 1, severity: 'high', action: 'alert',
  recommendationHint: 'Check WE_REVIEW_SAME_HEAD_MAX_REVIEWS and WE_REVIEW_ADVISE_ON_PENDING_REFERRALS; inspect failed posting effects before re-arming.',
  evaluate({ operationRuns }, { now, config }) {
    const windowMs = config?.sameHeadReviewWindowMs ?? DEFAULT_HEALTH_CONFIG.sameHeadReviewWindowMs;
    const max = config?.sameHeadUnpostedReviews ?? DEFAULT_HEALTH_CONFIG.sameHeadUnpostedReviews;
    const groups = new Map();
    for (const run of operationRuns ?? []) {
      if (run?.op !== 'review-pr') continue;
      const { repo, pr } = run.input ?? {};
      const head = run.findings?.read?.netBasis?.rev;
      const at = Date.parse(run.stepTimings?.find(t => t.step === 'read')?.startedAt);
      if (!repo || !pr || !head || !Number.isFinite(at) || !Array.isArray(run.effects)
        || at < now - windowMs || at > now) continue;
      const key = `${repo}#${pr}@${head}`;
      if (!groups.has(key)) groups.set(key, { repo, pr, head, runs: [] });
      groups.get(key).runs.push({ at,
        posted: run.effects.some(e => POSTED_RESULT_TYPES.has(e.type) && e.status === 'applied') });
    }
    return [...groups.values()].map(({ repo, pr, head, runs }) => {
      const lastPosted = Math.max(-Infinity, ...runs.filter(r => r.posted).map(r => r.at));
      const count = runs.filter(r => r.at > lastPosted).length;
      return {
        subject: `${repo}#${pr}@${head.slice(0, 9)}`, breach: count >= max,
        measure: { count, head: head.slice(0, 9), windowMs },
        summary: `${repo}#${pr}: head ${head.slice(0, 9)} has ${count} review(s) without a posted result in ${fmtAge(windowMs)}.`,
        recommendation: this.recommendationHint,
      };
    });
  },
};

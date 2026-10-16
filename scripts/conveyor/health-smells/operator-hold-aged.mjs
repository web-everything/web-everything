/**
 * #5653 — an operator-only hold on a PR (`cap-exhausted`, `stood-down`, `review-referrals-pending`, `ruling-dispute`)
 * that has been continuously observed past `operatorHoldAgeMinutes` (default 30). Each such hold waits on a person
 * and nothing else ends it quickly; the aggregate `stood-down-prs` count does not say how long any one has waited.
 *
 * The input is not log prose: the review daemon appends one structured `operator-holds` snapshot per successfully
 * planned repository, and `we:scripts/conveyor/health-watch-core.mjs#foldOperatorHolds` folds them into per-hold
 * first/last observations (unknown, stale or malformed input never counts as clearance and never advances an age).
 * This detector only turns that folded view into results: a breach at/above the threshold, an explicit clean result
 * for a confirmed removal, and NO result for anything unknown (`missingSubjectsUnknown`). Alert-only: it never clears,
 * resolves or dispatches work for a hold. Subject and summary carry only validated identity, age and threshold.
 */
import { fmtAge, operatorHoldSubject, MINUTE } from '../health-watch-core.mjs';

export const DEFAULT_OPERATOR_HOLD_AGE_MINUTES = 30;

/** PURE: the configured threshold in minutes; anything but a finite positive number falls back to the default. */
export function operatorHoldAgeMinutes(config) {
  const v = config?.operatorHoldAgeMinutes;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_OPERATOR_HOLD_AGE_MINUTES;
}

export default {
  id: 'operator-hold-aged',
  scope: 'repo',
  cadence: 'every-tick',
  probes: ['operatorHolds'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'high',
  action: 'alert',
  missingSubjectsUnknown: true,
  recommendationHint: 'A PR has been held for a person longer than expected — read the hold kind and clear or decide it.',
  evaluate(_probes, { config, operatorHolds } = {}) {
    if (!operatorHolds) return [];
    const minutes = operatorHoldAgeMinutes(config);
    const out = [];
    const present = new Set();
    for (const h of operatorHolds.current) {
      const subject = operatorHoldSubject(h);
      present.add(subject);
      const ageMs = h.last - h.first;
      if (ageMs >= minutes * MINUTE) {
        out.push({
          subject, breach: true,
          measure: { repo: h.repo, prNumber: h.prNumber, kind: h.kind, observedAgeMs: ageMs, thresholdMinutes: minutes, ...(h.lowerBound ? { ageIsLowerBound: true } : {}) },
          summary: `${h.repo}#${h.prNumber} has been held (${h.kind}) for ${h.lowerBound ? 'at least ' : ''}${fmtAge(ageMs)}, past the ${minutes}-minute threshold.`,
          recommendation: `${h.repo}#${h.prNumber} is waiting on a person (${h.kind}). Open it and clear or decide the hold; this alert only reports.`,
        });
      } else if (operatorHolds.cleared.has(subject)) {
        // Removed and returned: the old episode ends, and the returned hold starts a new age.
        out.push({ subject, breach: false });
      }
      // Below threshold with an open episode (recovered after an unknown interval): leave the episode as it is.
    }
    for (const c of operatorHolds.clearedHolds) {
      const subject = operatorHoldSubject(c);
      if (!present.has(subject)) out.push({ subject, breach: false });
    }
    return out;
  },
};

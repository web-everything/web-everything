/** Lightweight review step shape shared with admission; checked against the declaration at construction. */
import { isComplete } from './engine.mjs';

export const DEFAULT_REVIEW_SEAT_STEPS = ['judge', 'judgeSecurity', 'judgeAdvisory'];
export function reviewPrStepNames(seats = DEFAULT_REVIEW_SEAT_STEPS, verifier = true) {
  return ['read', ...seats, ...(verifier ? ['judgeReferralVerifier'] : []),
    'reduce', 'mandatoryReferrals', 'referralVerdict', 'advise', 'confirm', 'stageVerdict', 'record', 'ledgerEvents'];
}

export function isCompletedReviewPr(run) {
  const read = run.findings?.read;
  const names = reviewPrStepNames(read?.seatSteps, read?.referralVerifierDeclared);
  return isComplete(run, { registry: { get: () => ({ steps: names.map(name => ({ name })) }) } });
}

/** The ONE definition of "live referral gate state" shared by the acceptance gate
 * (`we:scripts/review-set-label.mjs#assertMandatoryReferralsCleared`) and the review hold
 * (`we:scripts/conveyor/review-referral-hold.mjs#decideReferralHold`), so a hold can never release a PR the gate
 * would immediately re-park (the release/re-park loop the hold exists to prevent).
 *
 * Kept free of `review-seat-policy` / `review-set-label` imports on purpose: those import the hold, so importing
 * them here would close a cycle. The gate supplies its own `seatDisabled`; the hold omits it, which only ever
 * keeps a finding pending (a disabled seat can only retire an unruled finding), i.e. errs toward holding.
 */
import { mandatoryReferralState } from './jury-core.mjs';
import { referralCardReadable } from './referral-card-readable.mjs';
export { referralCardReadable };

/** The `mandatoryReferralState` context for a PR's live state (`headRefOid`, `body`, `createdAt`). */
export function referralLiveContext(state, { repo, pr, cardReadable = referralCardReadable, seatDisabled } = {}) {
  return { repo, pr, head: state.headRefOid, body: typeof state.body === 'string' ? state.body : '',
    createdAt: state.createdAt, cardReadable, ...(seatDisabled ? { seatDisabled } : {}) };
}

/** The live referral state of a PR, read the way the gate reads it. */
export function liveReferralState(state, options) {
  return mandatoryReferralState(state.comments, referralLiveContext(state, options));
}

import { openReferralKeys } from '../referrals.mjs';
/** Findings opened by a referral and not yet ruled or resolved-by-fix hold the PR. */
export default {
  id: 'referral-unruled',
  evaluate({ view }) {
    const open = openReferralKeys(view.referrals);
    return open.length ? { code: 'referral-unruled', reason: `${open.length} referral finding(s) unruled: ${open.join(', ')}`,
      needsYou: `rule on ${open.length} finding(s): ${open.join(', ')}` } : null;
  },
};

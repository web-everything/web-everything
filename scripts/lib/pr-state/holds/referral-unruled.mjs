import { openReferralKeys, blockedReferralKeys } from '../referrals.mjs';
/** Findings opened by a referral and not yet ruled or resolved-by-fix hold the PR; so do findings ruled `block` and not yet fixed. */
export default {
  id: 'referral-unruled',
  evaluate({ view }) {
    const out = [];
    const open = openReferralKeys(view.referrals);
    if (open.length) out.push({ code: 'referral-unruled', reason: `${open.length} referral finding(s) unruled: ${open.join(', ')}`,
      needsYou: `rule on ${open.length} finding(s): ${open.join(', ')}` });
    const blocked = blockedReferralKeys(view.referrals);
    // The author owns the next move (a fix on a new head), so nobody is asked to rule.
    if (blocked.length) out.push({ code: 'referral-blocked', reason: `${blocked.length} finding(s) ruled block and not yet fixed on a new head: ${blocked.join(', ')}` });
    return out.length ? out : null;
  },
};

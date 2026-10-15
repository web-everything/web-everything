/** Unattended acceptance preserves prevention filing while holding open referrals and unruled broken findings. */
import { readFileSync } from 'node:fs';
import { cascadePolicy } from './policy-cascade.mjs';
import { REVIEW_SETTINGS_FILE, normOnOff } from './review-seat-settings.mjs';
import { activeReferrals, mandatoryReferralState, referralRecordState, sameFindingForClearing } from './jury-core.mjs';
import { openReferralFindings } from '../operations/record-referral-ruling.mjs';

/** review.unattendedAcceptRequiresCleanReferrals: standard true → platform → tool → env. */
export function unattendedAcceptPolicy({ env = process.env, tool, platform, log } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFileSync(REVIEW_SETTINGS_FILE, 'utf8')); } catch { tool = {}; }
  }
  const raw = env.WE_REVIEW_UNATTENDED_ACCEPT_REQUIRES_CLEAN_REFERRALS;
  const parsed = normOnOff(raw);
  return cascadePolicy('review', { unattendedAcceptRequiresCleanReferrals: tool?.unattendedAcceptRequiresCleanReferrals }, {
    standard: { unattendedAcceptRequiresCleanReferrals: true }, platform, env, log,
    envValues: { unattendedAcceptRequiresCleanReferrals: parsed === null ? raw : parsed === 'on' },
    valid: { unattendedAcceptRequiresCleanReferrals: v => typeof v === 'boolean' },
  });
}

/** PURE. A non-null reason parks the run; it must never be used to clear labels or record acceptance. */
export function unattendedAcceptHold({ verdict, comments, repo, pr, head, body = '', createdAt = '', cardReadable,
  expectedHead = head, requiresCleanReferrals = true }) {
  if (!requiresCleanReferrals) return null;
  if (!['accept', 'prevention-outstanding'].includes(verdict?.verdict)) return `panel verdict is ${verdict?.verdict ?? 'unavailable'}`;
  if (verdict.pendingReferrals?.length || verdict.blockedReferrals?.length) return 'mandatory referrals remain open';
  if (!head || head !== expectedHead) return 'live head does not match the reviewed head';
  const state = openReferralFindings({ comments, repo, pr, head, body, createdAt, cardReadable });
  if (state.malformed || state.pending.length || state.blocked.length || state.open.length || state.disputed.length) {
    return 'mandatory referrals remain open on the live head';
  }
  if (verdict.verdict === 'prevention-outstanding') {
    const context = { repo, pr, head, body, createdAt, cardReadable };
    const referrals = mandatoryReferralState(comments, context);
    const cleared = referrals.records.filter(r => r.repo === repo && r.pr === Number(pr) && r.head === head)
      .flatMap(record => {
        const status = referralRecordState(record, { ...context, records: referrals.records,
          operatorRulings: referrals.operatorRulings });
        const held = new Set([...status.pending, ...status.blocked]);
        return activeReferrals(record).filter(f => !held.has(f.key)
          && status.rulings.some(r => r.key === f.key && ['card', 'not-real'].includes(r.result)))
          .map(f => f.finding);
      });
    if ((verdict.findings ?? []).some(f => f.impactIfUnfixed === 'broken'
      && !cleared.some(ruled => sameFindingForClearing(f, ruled)))) {
      return 'broken finding is not ruled card or not-real';
    }
  }
  return null;
}

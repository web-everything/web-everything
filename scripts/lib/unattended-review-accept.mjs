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

/** The verdicts the loop may accept unattended. `changes` only when the round-cards rule files every finding first. */
export function unattendedAcceptableVerdict(verdict, { roundCards = false } = {}) {
  return ['accept', 'prevention-outstanding'].includes(verdict?.verdict) || (roundCards === true && verdict?.verdict === 'changes');
}

/**
 * PURE. A non-null reason parks the run; it must never be used to clear labels or record acceptance.
 * `expectedHead` is the head the verdict was reviewed on and has no default: a missing one parks (fail closed).
 * `roundCards` is true only when the round-cards rule applies to this run (`roundCardsDecision(run).apply`).
 */
export function unattendedAcceptHold({ verdict, comments, repo, pr, head, body = '', createdAt = '', cardReadable,
  expectedHead, roundCards = false, requiresCleanReferrals = true }) {
  if (!requiresCleanReferrals) return null;
  if (!unattendedAcceptableVerdict(verdict, { roundCards })) return `panel verdict is ${verdict?.verdict ?? 'unavailable'}`;
  if (verdict.pendingReferrals?.length || verdict.blockedReferrals?.length) return 'mandatory referrals remain open';
  if (!head || !expectedHead || head !== expectedHead) return 'live head does not match the reviewed head';
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
      return BROKEN_UNRULED_HOLD;
    }
  }
  return null;
}

/** The hold reason a `broken` finding with no card/not-real ruling produces (see {@link unattendedAcceptHold}). */
export const BROKEN_UNRULED_HOLD = 'broken finding is not ruled card or not-real';

/**
 * PURE. The `broken` findings that hold a `prevention-outstanding` accept when NOTHING exists that could ever rule
 * them: no referral record on the PR (any head), no malformed one, no operator ruling, and no referral on the verdict.
 * Then the hold can never lift by itself (live #5608: 7 runs parked on the same head, no verdict), so the caller sends
 * the PR back with these findings instead. Returns null whenever a ruling path exists (behaviour unchanged there),
 * when the live head is not the reviewed one, or when no broken finding is outstanding. Never a reason to accept.
 */
export function unrulableBrokenFindings({ verdict, comments, repo, pr, head, body = '', createdAt = '', cardReadable,
  expectedHead }) {
  if (verdict?.verdict !== 'prevention-outstanding') return null;
  if (!head || !expectedHead || head !== expectedHead) return null;
  if (verdict.referrals?.length || verdict.pendingReferrals?.length || verdict.blockedReferrals?.length) return null;
  const referrals = mandatoryReferralState(comments, { repo, pr, body, createdAt, cardReadable });
  if (referrals.malformed || referrals.records.length || referrals.operatorRulings?.length) return null;
  const broken = (verdict.findings ?? []).filter(f => f?.impactIfUnfixed === 'broken');
  return broken.length ? broken : null;
}

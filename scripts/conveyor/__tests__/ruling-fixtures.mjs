/** Shared builders for the ruling-needed / ruling-not-addressed tests: real, valid referral records on a PR thread. */
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';

export const repo = 'web-everything/web-everything';
export const H1 = 'a'.repeat(40);
export const H2 = 'b'.repeat(40);
export const H3 = 'c'.repeat(40);
export const H4 = 'd'.repeat(40);
export const SUMMARY = 'policy pointer files are missing from the standards manifest so the gate cannot see them';
export const T0 = Date.parse('2026-10-03T08:00:00Z');
export const iso = (min) => new Date(T0 + min * 60_000).toISOString();

export function record({ head, runId, summary = SUMMARY, file = 'policy/pointer.md', rulings = [], pr = 3794 }) {
  const original = { summary, file, line: 12, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const key = referralFindingKey('judge', original);
  const reviewer = mandatoryReferralReviewer(runId);
  return { version: 1, repo, pr, head, runId, reviewer, authorBody: '<!-- authored-by-actor: author -->', attempted: true,
    referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }],
    rulings: rulings.map((r, i) => ({ id: `r${i}`, key, reviewerId: reviewer.id, lens: reviewer.lens,
      result: r.result, rationale: r.rationale ?? 'ruled', evidence: ['e'] })) };
}
export const recordComment = (rec, min, login = 'web-everything') =>
  ({ body: renderReferralRecord(rec), createdAt: iso(min), author: { login } });
export const BLOCK = { result: 'block', rationale: 'pointer files must be listed; do not ship without them' };

/** The live shape of PR #3794: ruled `block` on H1, fixer pushed H2, the re-review reports the same finding. */
export function ignoredRulingThread() {
  return [recordComment(record({ head: H1, runId: 'run-1' }), 1),
    recordComment(record({ head: H1, runId: 'run-1', rulings: [BLOCK] }), 3),
    recordComment(record({ head: H2, runId: 'run-2' }), 20)];
}

// A head pushed by a takeover earns ONE review beyond the round cap (live: #4708, takeover head 7e29b95c4 refused 5/5).
import { describe, it, expect } from 'vitest';
import { takeoverReviewGrant, OPERATOR_TAKEOVER_PREFIX } from '../takeover-review.mjs';
import { takeoverMarkerBody } from '../fix-takeover.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { resolveReviewSettings, validateReviewSettings } from '../../lib/review-settings.mjs';

const BOT = { login: 'web-everything' };
const OLD = '1'.repeat(40);   // the head the last bounce reviewed
const TAKE = '7'.repeat(40);  // the head the takeover pushed
const NEXT = '9'.repeat(40);  // a later push after the takeover's review
const at = (h) => `2026-10-10T${String(h).padStart(2, '0')}:00:00Z`;

const bounce = (head, h) => ({ author: BOT, createdAt: at(h),
  body: `🔁 review — changes requested\n\nRecorded by auto-policy\n\nruled \`block\` on head \`${head}\`.\n\n### Findings\n\n**correctness/logic** (1)\n- \`src/a.mjs:1\` — bad` });
const advisory = (head, h) => ({ author: BOT, createdAt: at(h),
  body: `**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.** Changes: 1 finding\n\nNet basis: \`${'0'.repeat(40)}..${head}\`` });
const marker = (head, h, author = BOT) => ({ author, createdAt: at(h),
  body: takeoverMarkerBody({ pr: 7, head, attempts: 5, cap: 5, rung: { id: 'stronger-model' } }) });
const operatorTakeover = (h) => ({ author: BOT, createdAt: at(h), body: `${OPERATOR_TAKEOVER_PREFIX} — all open findings fixed**` });
const rearm = (h) => ({ author: BOT, createdAt: at(h), body: '<!-- conveyor-rearm-review -->\n🔁 conveyor re-armed review' });

function pr(head, comments, labels = ['review:changes', 'review:human']) {
  return {
    number: 7, headRefName: 'lane/x-thing', headRefOid: head, isDraft: false, createdAt: at(0),
    labels: labels.map((name) => ({ name })), files: [{ path: 'src/a.mjs' }],
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: head }],
    comments,
  };
}
// #4708's shape: rounds spent (5/5), last bounce on OLD, then a takeover pushed TAKE.
const spent = [rearm(1), rearm(2), rearm(3), rearm(4), rearm(5), bounce(OLD, 6)];

describe('takeoverReviewGrant', () => {
  it('a takeover head (operator takeover comment + marker naming it) gets one review', () => {
    expect(takeoverReviewGrant({ pr: pr(TAKE, [...spent, operatorTakeover(7), marker(TAKE, 8)]), takeoverReviewAttempts: 1 }))
      .toMatchObject({ ok: true, allowance: 1, used: 0 });
  });
  it('the automatic marker naming the PRE-takeover head grants the head the takeover pushes, not that old head', () => {
    const comments = [...spent, marker(OLD, 7)];
    expect(takeoverReviewGrant({ pr: pr(TAKE, comments), takeoverReviewAttempts: 1 }).ok).toBe(true);
    expect(takeoverReviewGrant({ pr: pr(OLD, comments), takeoverReviewAttempts: 1 })).toMatchObject({ ok: false, reason: 'head-already-reviewed' });
  });
  it('after the takeover review lands, a second push is capped again', () => {
    const comments = [...spent, marker(TAKE, 8), advisory(TAKE, 9), bounce(TAKE, 10)];
    expect(takeoverReviewGrant({ pr: pr(NEXT, comments), takeoverReviewAttempts: 1 })).toMatchObject({ ok: false, reason: 'takeover-review-spent' });
  });
  it('a non-takeover head, the setting off, or a forged marker grant nothing', () => {
    expect(takeoverReviewGrant({ pr: pr(TAKE, spent), takeoverReviewAttempts: 1 })).toMatchObject({ ok: false, reason: 'no-takeover' });
    expect(takeoverReviewGrant({ pr: pr(TAKE, [...spent, marker(TAKE, 8)]), takeoverReviewAttempts: 0 })).toMatchObject({ ok: false, reason: 'off' });
    expect(takeoverReviewGrant({ pr: pr(TAKE, [...spent, marker(TAKE, 8, { login: 'mallory' })]), takeoverReviewAttempts: 1 }))
      .toMatchObject({ ok: false, reason: 'no-takeover' });
  });
});

describe('planReconcile with a takeover head over the cap', () => {
  const plan = (p, opts = {}) => planReconcile({
    prs: [p], agents: [], durableCounts: { 7: 5 }, now: Date.parse(at(12)), requiredChecks: ['test'],
    roundCapAction: 'takeover', takeoverReviewAttempts: 1, ...opts,
  });

  it('#4708 shape: the takeover head gets ONE review dispatch instead of cap-exhausted', () => {
    const p = plan(pr(TAKE, [...spent, operatorTakeover(7), marker(TAKE, 8)]));
    const d = p.dispatch.find((x) => x.prNumber === 7);
    expect(d).toMatchObject({ kind: 'review', takeoverReview: { ok: true, used: 0 } });
    expect(p.refusals.find((r) => r.prNumber === 7 && r.kind === 'cap-exhausted')).toBeUndefined();
  });
  it('a takeover that re-armed to review:pending (6 rounds > cap 5) is still reviewed once', () => {
    const p = plan(pr(TAKE, [...spent, marker(OLD, 7), rearm(8)], ['review:pending']), { durableCounts: { 7: 6 } });
    // The takeover's own re-arm (cap+1) is owed its final review on the ordinary path (card xx0055i's per-takeover
    // review cap); either path, the takeover head is reviewed exactly once.
    expect(p.dispatch.find((x) => x.prNumber === 7)).toMatchObject({ kind: 'review' });
  });
  it('a second push after the takeover review is capped again (cap-exhausted, no dispatch)', () => {
    const p = plan(pr(NEXT, [...spent, marker(TAKE, 8), advisory(TAKE, 9), bounce(TAKE, 10)]), { durableCounts: { 7: 6 } });
    expect(p.dispatch.find((x) => x.prNumber === 7)).toBeUndefined();
    expect(p.refusals.find((r) => r.prNumber === 7)?.kind).toBe('cap-exhausted');
  });
  it('a non-takeover head over the cap stays capped (person setting: no takeover fix either)', () => {
    const p = plan(pr(TAKE, spent), { roundCapAction: 'person' });
    expect(p.dispatch.find((x) => x.prNumber === 7)).toBeUndefined();
    expect(p.refusals.find((r) => r.prNumber === 7)?.kind).toBe('cap-exhausted');
  });
  it('red CI still refuses the takeover review (the review gate is not weakened)', () => {
    const p0 = pr(TAKE, [...spent, marker(TAKE, 8)]);
    const p = plan({ ...p0, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', headSha: TAKE }] });
    expect(p.dispatch.find((x) => x.prNumber === 7 && x.kind === 'review')).toBeUndefined();
  });
});

describe('review.takeoverReviewAttempts setting', () => {
  it('built-in 1, the file can set 0..5, env overrides, junk keeps the lower layer', () => {
    expect(validateReviewSettings(null).takeoverReviewAttempts).toBe(1);
    expect(validateReviewSettings({ takeoverReviewAttempts: 0 }).takeoverReviewAttempts).toBe(0);
    expect(validateReviewSettings({ takeoverReviewAttempts: 9 }).takeoverReviewAttempts).toBe(1);
    expect(resolveReviewSettings({ fileConfig: { takeoverReviewAttempts: 1 }, env: { WE_REVIEW_TAKEOVER_REVIEW_ATTEMPTS: '0' } }).takeoverReviewAttempts).toBe(0);
    expect(resolveReviewSettings({ fileConfig: { takeoverReviewAttempts: 2 }, env: { WE_REVIEW_TAKEOVER_REVIEW_ATTEMPTS: 'x' } }).takeoverReviewAttempts).toBe(2);
  });
});

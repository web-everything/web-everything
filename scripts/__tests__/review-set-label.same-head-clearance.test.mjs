/**
 * @file Unit proof of the review loop's write plan: keep current human clearance,
 * while retaining advisories, new findings, and the existing unknown-state fallback.
 */
import { describe, it, expect } from 'vitest';
import replay from './fixtures/review-clearance-7140.json';
import * as label from '../review-set-label.mjs';
import { parseLatestHumanClearedSha, decideReviewGate, REVIEW_LABELS } from '../lib/review-escalation.mjs';

const input = { to: 'accepted', comments: replay.comments.slice(0, 2), headSha: replay.headSha, headDiff: replay.reviewedDiff };
const post = { advisory: true, verdict: true, label: true };
const keep = { advisory: true, verdict: false, label: false };

describe('review loop same-head human clearance', () => {
  it('review loop keeps a same-head clearance', () => {
    expect(label.reviewLoopWritePlan(input)).toEqual(keep);
  });

  it('a head push invalidates the clearance', () => {
    expect(label.reviewLoopWritePlan({ ...input, headSha: 'e58066c5' })).toEqual(post);
  });

  it('a different reviewed-diff fingerprint posts accept as today', () => {
    expect(label.reviewLoopWritePlan({ ...input, headDiff: 'a'.repeat(64) })).toEqual(post);
  });

  it('a NEW finding is still posted and still ends the clearance', () => {
    const plan = label.reviewLoopWritePlan({ ...input, to: 'changes' });
    expect(plan).toEqual(post);
    const decision = label.decideSetLabel({ to: 'changes', currentLabels: [REVIEW_LABELS.accepted], findingCount: 1, reason: 'New finding' });
    expect(decision.addLabel).toBe(REVIEW_LABELS.changes);
    expect(decision.removeLabels).toContain(REVIEW_LABELS.accepted);
    // Changes revoke the acceptance through labels; the clearance parser itself is unchanged.
    expect(decideReviewGate({ escalate: true, labels: [decision.addLabel], humanClearedSha: input.headSha }).action).toBe('wait-author');
  });

  it.each([null, undefined, {}, []])('unknown clearance state (%j) posts as today', comments => {
    expect(label.reviewLoopWritePlan({ ...input, comments })).toEqual(post);
  });

  it('unreadable clearance evidence posts as today', () => {
    const comments = [{ get author() { throw new Error('unreadable author'); } }];
    expect(label.reviewLoopWritePlan({ ...input, comments })).toEqual(post);
  });

  it('a missing head cannot suppress the verdict', () => {
    expect(label.reviewLoopWritePlan({ ...input, headSha: '' })).toEqual(post);
  });

  it('an unscored diff posts as today, even if both diff markers are missing', () => {
    const comments = input.comments.map(c => ({ ...c, body: c.body.replace(/<!-- reviewed-diff: .*? -->/g, '') }));
    expect(label.reviewLoopWritePlan({ ...input, comments, headDiff: '' })).toEqual(post);
  });

  it('untrusted clearance cannot suppress the verdict', () => {
    const comments = input.comments.map(c => ({ ...c, author: { login: 'outsider' } }));
    expect(label.reviewLoopWritePlan({ ...input, comments })).toEqual(post);
  });

  it('a superseded clearance cannot suppress a later accept', () => {
    expect(label.reviewLoopWritePlan({ ...input, comments: replay.comments })).toEqual(post);
  });

  it('replays #7140 without the plain accept that ended human clearance', () => {
    expect(parseLatestHumanClearedSha(replay.comments)).toBeNull();
    expect(parseLatestHumanClearedSha(input.comments)).toBe(input.headSha);
    const plan = label.reviewLoopWritePlan(input);
    const emitted = [...input.comments, ...(plan.verdict ? replay.comments.slice(2) : [])];
    expect(plan.advisory).toBe(true);
    expect(plan.label).toBe(false);
    expect(parseLatestHumanClearedSha(emitted)).toBe(input.headSha);
  });
});

// Drain park-reason spam (PR #4017): the held-park comment is upserted — one comment, edited only on change.
import { describe, it, expect } from 'vitest';
import { planHeldParkUpsert, buildDrainReasonComment, buildHeldReviewHoldReason, PR_COMMENTS_MAX_BUFFER } from '../merge-ai-prs.mjs';

const reason = (l) => buildHeldReviewHoldReason({ labels: [l], body: '' });
const mk = (id, text) => ({ author: { login: 'chalbert' }, url: `https://github.com/o/r/pull/1#issuecomment-${id}`,
  body: buildDrainReasonComment('park', text) });

describe('planHeldParkUpsert', () => {
  it('posts once when no held comment exists', () => {
    expect(planHeldParkUpsert([], reason('review:human'))).toEqual({ action: 'post' });
  });
  it('repeated passes with the same reason write nothing', () => {
    let comments = [];
    const r = reason('review:human');
    let writes = 0;
    for (let i = 0; i < 5; i++) {
      const plan = planHeldParkUpsert(comments, r);
      if (plan.action === 'post') { writes++; comments = [mk(1, r)]; } else if (plan.action === 'edit') writes++;
    }
    expect(writes).toBe(1);
    expect(comments).toHaveLength(1);
  });
  it('a changed reason edits the one existing comment', () => {
    expect(planHeldParkUpsert([mk(7, reason('review:pending'))], reason('review:human'))).toEqual({ action: 'edit', commentId: '7' });
  });
  it('finds its marker past 100 comments', () => {
    const filler = Array.from({ length: 250 }, () => ({ author: { login: 'chalbert' }, body: 'noise', url: '' }));
    const r = reason('review:human');
    expect(planHeldParkUpsert([...filler.slice(0, 120), mk(9, r), ...filler.slice(120)], r)).toEqual({ action: 'none' });
  });
  it('ignores an untrusted author marker', () => {
    const c = { ...mk(3, reason('review:human')), author: { login: 'rando' } };
    expect(planHeldParkUpsert([c], reason('review:human'))).toEqual({ action: 'post' });
  });
  it('comment read buffer exceeds the 1 MiB node default', () => {
    expect(PR_COMMENTS_MAX_BUFFER).toBeGreaterThan(1024 * 1024 * 8);
  });
});

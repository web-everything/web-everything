/** R115: replay the accepted, conflicting #6911 shape through reconcile and dispatch planning. */
import fixture from './fixtures/accepted-conflict-rebase-6911.json';
import { it, expect } from 'vitest';
import { planReconcile, CONFLICT_FIX_ROUND_CAP, CONFLICT_FIX_ABSOLUTE_CEILING } from '../reconcile-core.mjs';
import { planFixesFromReconcile } from '../reconcile-fix-dispatch.mjs';
import { buildConflictRearmComment } from '../rearm-review.mjs';
import { conflictRebaseReceipt } from '../accepted-conflict-rebase.mjs';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';

it('replays #6911: one repair without CI, receipt stops the same head, holds and both caps refuse', () => {
  const run = (over = {}, options = {}) => planReconcile({ repo: 'we', agents: [], now: Date.parse('2026-11-17T12:00:00Z'),
    requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' }, mainSha: fixture.mainSha,
    prs: [{ ...structuredClone(fixture.pr), ...over }], ...options });
  const first = run();
  expect(first.refusals).toEqual([]);
  expect(first.dispatch).toHaveLength(1);
  expect(first.dispatch[0]).toMatchObject({ kind: 'fix', isConflict: true, mode: 'conflict-rebase', prNumber: 6911 });
  const dispatch = planFixesFromReconcile(first.dispatch, () => null, () => []);
  expect(dispatch.refusals).toEqual([]);
  expect(dispatch.planned).toHaveLength(1);
  expect(dispatch.planned[0].mode).toBe('conflict-rebase');

  const receipt = (target = fixture.mainSha, head = fixture.pr.headRefOid) => ({
    author: { login: AUTOMATION_LOGINS[0] },
    body: buildConflictRearmComment({ actor: conflictRebaseReceipt(head, target),
      decision: { keepsHuman: false }, mainRef: 'main', mainSha: target }),
  });
  const completed = run({ comments: [...fixture.pr.comments, receipt()] });
  expect(completed.dispatch).toEqual([]);
  expect(completed.refusals[0].why).toContain('already completed for this head');
  expect(run({ comments: [receipt()] }, { mainSha: 'c'.repeat(40) }).dispatch).toEqual([]);

  // review:changes belongs to the existing bounced conflict-fix route, never this admission.
  const bounced = run({ labels: [...fixture.pr.labels, { name: 'review:changes' }] });
  expect(bounced.dispatch.filter(entry => entry.mode === 'conflict-rebase')).toEqual([]);
  expect(bounced.dispatch).toMatchObject([{ kind: 'fix', isConflict: true, phase: 'bounced' }]);
  for (const label of ['review:held-mechanical', 'status:held']) {
    expect(run({ labels: [...fixture.pr.labels, { name: label }] }).dispatch, label).toEqual([]);
  }
  for (const hold of [{ fixClaim: { who: 'live-fixer' } }, { fixClaimUnknown: true }, { referralHold: { why: 'human ruling owed' } }]) {
    expect(run(hold).dispatch, JSON.stringify(hold)).toEqual([]);
  }
  for (const comments of [
    Array.from({ length: CONFLICT_FIX_ROUND_CAP }, (_, i) => receipt(fixture.mainSha, String(i).repeat(40))),
    Array.from({ length: CONFLICT_FIX_ABSOLUTE_CEILING }, (_, i) => receipt('c'.repeat(40), i.toString(16).repeat(40))),
  ]) {
    const capped = run({ comments: [...fixture.pr.comments, ...comments] });
    expect(capped.dispatch).toEqual([]);
    expect(capped.refusals).toMatchObject([{ kind: 'cap-exhausted', capKind: 'conflict-rebase', why: expect.stringContaining('person must take over') }]);
  }
});

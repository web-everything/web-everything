/** R115: replay the accepted, conflicting #6911 shape through reconcile and dispatch planning. */
import fixture from './fixtures/accepted-conflict-rebase-6911.json';
import { it, expect, vi } from 'vitest';
import { planReconcile, CONFLICT_FIX_ROUND_CAP, CONFLICT_FIX_ABSOLUTE_CEILING } from '../reconcile-core.mjs';
import { planFixesFromReconcile } from '../reconcile-fix-dispatch.mjs';
import { buildConflictRearmComment, buildConflictStartComment } from '../rearm-review.mjs';
import { buildConflictFixMarkComment } from '../conflict-fix-mark.mjs';
import { watchParkedPrConflicts, defaultListParkedPrs } from '../parked-pr-conflict-watch.mjs';
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


it.each(['live', 'admitted-before-crash', 'completed', 'historical-completed'])(
  'demoted pending conflict remains the same episode with %s evidence on both routes', state => {
    const head = fixture.pr.headRefOid;
    const actor = conflictRebaseReceipt(head, fixture.mainSha);
    const body = state === 'completed'
      ? buildConflictFixMarkComment({ actor, baseRefName: 'main', baseSha: fixture.mainSha })
      : state === 'historical-completed'
        ? buildConflictRearmComment({ actor, decision: { keepsHuman: false } })
        : buildConflictStartComment({ actor });
    const comments = state === 'live' ? [] : [{ author: { login: AUTOMATION_LOGINS[0] }, body }];
    const pr = { ...structuredClone(fixture.pr), labels: ['review:pending', 'merge-status:conflicting'],
      mergeable: 'CONFLICTING', comments, ...(state === 'live' ? { fixClaim: { who: 'fixer' } } : {}) };
    const run = current => planReconcile({ repo: 'we', agents: [], requiredChecks: ['gate'],
      reviewTiming: { startAfter: 'ci-green' }, mainSha: 'c'.repeat(40), prs: [current] });
    expect(run(pr).dispatch).toEqual([]);
    expect(run(pr).refusals[0].why).toMatch(/fix claim|already admitted/);
    const writes = { setLabels: vi.fn(), ensureLabel: vi.fn(), postComment: vi.fn() };
    const postFinding = vi.fn(), postStandDown = vi.fn();
    const watcher = (current, over = {}) => watchParkedPrConflicts({ repo: 'we', provider: writes,
      inCardGroupFn: () => false, cardGroupStateUnreadable: () => false,
      listPrs: () => [current], sameLineConflict: 'fixer',
      readFixClaim: () => state === 'live' ? { meta: { who: 'fixer' } } : null,
      listPrComments: () => comments, computeConflictingPaths: () => null, listPrPatches: () => [],
      labelRemovedAtMs: () => null, postFinding, postStandDown, ...over });
    expect(watcher(pr)[0].routedTo).toMatch(/held \(live fix claim|already admitted/);
    expect(postFinding).not.toHaveBeenCalled();
    expect(postStandDown).not.toHaveBeenCalled();
    for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
    if (state !== 'live') {
      // The receipt never owns a later pushed head, and untrusted prose cannot hold a PR.
      const next = run({ ...pr, headRefOid: 'd'.repeat(40) });
      expect(next.refusals.some(r => r.why.includes('already admitted'))).toBe(false);
      const forged = run({ ...pr, comments: comments.map(c => ({ ...c, author: { login: 'untrusted' } })) });
      expect(forged.refusals.some(r => r.why.includes('already admitted'))).toBe(false);
    }
    expect(watcher(pr, { readFixClaim: () => { throw new Error('unreadable'); } })).toEqual([]);
    expect(watcher(pr, { readFixClaim: () => null, listPrComments: () => null })).toEqual([]);
  });


it('production watcher requests the head used by receipt deduplication', () => {
  const exec = vi.fn(() => '[]');
  defaultListParkedPrs({ exec, repo: 'o/n' });
  const argv = exec.mock.calls[0][1];
  expect(argv[argv.indexOf('--json') + 1].split(',')).toContain('headRefOid');
});

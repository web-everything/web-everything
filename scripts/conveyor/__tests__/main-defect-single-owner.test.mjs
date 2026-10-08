// xh3ghy1 — LIVE 2026-10-08, PR #4368: the fix daemon said "owed a mechanical rebase", ci-red-recovery-watch said
// "own failure, owed a ci-heal"; each sent the PR to the other and nobody owned it. Cause: the watch gated its
// comment read on a `needs-human` label it never fetched, so it never saw the recorded "main's own defect"
// escalation. Both now call ONE classifier (`main-red-recovery.mjs#classifyMainDefect`). This replays #4368.
import { describe, it, expect, vi } from 'vitest';
import { buildCiHealEscalationComment } from '../ci-heal-escalation-mark.mjs';
import { classifyMainDefect, isPrCiFailureOwedRerun } from '../main-red-recovery.mjs';
import { sweepCiRedRecovery } from '../ci-red-recovery-watch.mjs';
import { planReconcile } from '../reconcile-core.mjs';

const headSha = '9ae391c37b80d02f5f2361425f527a8711da7e87';
const failedAt = '2026-10-08T01:06:55Z';
const escalation = { author: { login: 'web-everything' }, createdAt: '2026-10-08T01:11:25Z',
  body: buildCiHealEscalationComment({ headSha, outcome: 'needs-human',
    reason: "red is main's own defect, not this PR's diff: backlog hash xsjn0uf is the bornAs of both #5319 and #5321 on main" }) };
const green = { name: 'test', conclusion: 'success', status: 'completed', head_sha: 'newmain', completed_at: '2026-10-08T03:34:50Z' };
const greenAtBase = { ...green, head_sha: 'base', completed_at: '2026-10-08T00:52:35Z' };
// main's own CI never went red in the PR's window (its run was cancelled): no recorded red window at all.
const noWindows = [];

// The exact state: a live `gh pr list` row for the watch carries NO labels field.
const livePr = { number: 4368, state: 'OPEN', headRefName: 'lane/item-110', headRefOid: headSha,
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: failedAt }] };
const facts = { prContainsMainGreenSha: false, mergeBaseCheckRuns: [greenAtBase], mergeBaseRunConclusion: 'success' };

describe('#4368 replay: one classifier, one owner, one action', () => {
  it('the classifier counts a recorded main-defect escalation as main\'s defect even with no red window', () => {
    const c = classifyMainDefect({ requiredCheckCompletedAt: failedAt, mainRedWindows: noWindows, failingCheckName: 'test',
      mainLatestCheckRuns: [green], ...facts, comments: [escalation], headSha });
    expect(c).toMatchObject({ mainDefect: true, via: 'green-fix', escalation: true });
    expect(classifyMainDefect({ requiredCheckCompletedAt: failedAt, mainRedWindows: noWindows, failingCheckName: 'test',
      mainLatestCheckRuns: [green], ...facts, comments: [], headSha }).mainDefect).toBe(false);
  });

  it('the watch (label-less PR row) refreshes #4368 onto main instead of refusing own-failure', () => {
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased', newCommit: 'fresh' }));
    const result = sweepCiRedRecovery({ apply: true, readOpenPrs: () => [livePr], readRequiredContexts: () => ['test'],
      readMainRuns: () => [], readAheadBy: () => 3, readMainLatestCheckRuns: () => [green],
      readMainGreenFixFacts: () => facts, readComments: () => [escalation],
      refresh, postComment: vi.fn(), reconcileAcceptance: vi.fn() });
    expect(result.refusals).toEqual([]);
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 4368, kind: 'rebase-onto-main' })]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('the fix daemon\'s gate agrees: it is owed a rebase, not a ci-heal (the same verdict the watch acts on)', () => {
    expect(isPrCiFailureOwedRerun({ requiredCheckCompletedAt: failedAt, aheadBy: 3, mainRedWindows: noWindows,
      failingCheckName: 'test', mainLatestCheckRuns: [green], ...facts, comments: [escalation], headSha })).toBe(true);
  });

  it('reconcile plans owed-ci-rerun (no ci-heal dispatch) for the same state', () => {
    const plan = planReconcile({
      prs: [{ ...livePr, labels: [{ name: 'ci:failed' }, { name: 'review-status:needs-human' }], mergeStateStatus: 'BLOCKED',
        comments: [escalation], requiredCheckName: 'test', requiredCheckCompletedAt: failedAt, aheadByOnMain: 3, ...facts }],
      agents: [], now: Date.parse('2026-10-08T03:35:00Z'), requiredChecks: ['test'],
      mainRedWindows: noWindows, mainLatestCheckRuns: [green],
    });
    expect(plan.dispatch.filter((d) => d.kind === 'ci-heal')).toEqual([]);
    expect(plan.refusals.some((r) => r.kind === 'owed-ci-rerun')).toBe(true);
  });

  it('an own-diff escalation stays the PR\'s own: both sides route it to ci-heal / human, never a rebase', () => {
    const own = { ...escalation, body: buildCiHealEscalationComment({ headSha, outcome: 'needs-human', reason: 'the diff itself is wrong' }) };
    const result = sweepCiRedRecovery({ apply: false, readOpenPrs: () => [livePr], readRequiredContexts: () => ['test'],
      readMainRuns: () => [], readAheadBy: () => 3, readMainLatestCheckRuns: () => [green],
      readMainGreenFixFacts: () => facts, readComments: () => [own] });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals[0].kind).toBe('own-failure');
  });
});

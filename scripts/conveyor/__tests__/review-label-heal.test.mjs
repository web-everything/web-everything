/**
 * @file review-label-heal.test.mjs — #3902: a `ready-to-merge` lane PR with no review:* label went red after a
 *   second push. The drain scores review escalation only for merge candidates (all required checks green), so it
 *   was never scored, never reviewed, and the fix daemon only re-posted a `review-label-missing` note. The
 *   `restore-review-label` healer gains a STUCK variant (policy `WE_REVIEW_LABEL_HEAL`: stuck | green | off).
 */
import { describe, it, expect } from 'vitest';
import { planReconcile, resolveReviewLabelHealMode } from '../reconcile-core.mjs';
import { runReconcilePromoteDraftDispatch } from '../../operations/promote-draft-pr-dispatch.mjs';

const run = (name, conclusion, completedAt = '2026-10-04T16:24:53Z') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, completedAt });
const aiCommit = { messageHeadline: 'fix(x): y', messageBody: 'Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>', authors: [{ login: 'chalbert' }] };
const REQUIRED = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const pr3902 = (labels = ['ready-to-merge']) => ({
  number: 3902, state: 'OPEN', isDraft: false, headRefName: 'lane/pool-scan-skip-non-dir-entries',
  headRefOid: '8d0ccb4b51356f760172fb0e79ccc6000a0812a1', mergeStateStatus: 'BLOCKED', comments: [],
  labels: labels.map((name) => ({ name })), commits: [aiCommit, aiCommit],
  statusCheckRollup: [run('test', 'SUCCESS'), run('smoke', 'SUCCESS'), run('daemon-soak', 'SUCCESS'), run('soak-replay-gate', 'FAILURE')],
});
const plan = (pr, reviewLabelHeal) => planReconcile({
  prs: [pr], agents: [], durableCounts: {}, now: Date.parse('2026-10-04T17:30:00Z'), requiredChecks: REQUIRED,
  ...(reviewLabelHeal ? { reviewLabelHeal } : {}),
});
const owed = (p) => p.dispatch.filter((d) => d.prNumber === 3902 && d.kind === 'restore-review-label');

describe('#3902 — restore-review-label STUCK variant', () => {
  it('the live case: ready-to-merge, red required check, no review:* label → owed review:pending (default policy)', () => {
    const d = owed(plan(pr3902()));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ label: 'review:pending', variant: 'stuck' });
  });
  it('the open-only listing has no `state` field: absent state reads as open', () => {
    const { state, ...listed } = pr3902();
    expect(owed(plan(listed))).toHaveLength(1);
  });
  it('policy green/off: not owed', () => {
    expect(owed(plan(pr3902(), 'green'))).toEqual([]);
    expect(owed(plan(pr3902(), 'off'))).toEqual([]);
  });
  it('a PR that already carries a review label is never re-labelled', () => {
    expect(owed(plan(pr3902(['ready-to-merge', 'review:pending'])))).toEqual([]);
  });
  it('inside the grace after the red check completed: not yet owed', () => {
    const p = planReconcile({ prs: [pr3902()], agents: [], durableCounts: {}, now: Date.parse('2026-10-04T16:26:00Z'), requiredChecks: REQUIRED });
    expect(owed(p)).toEqual([]);
  });
  it('resolves the policy from env', () => {
    expect(resolveReviewLabelHealMode({})).toBe('stuck');
    expect(resolveReviewLabelHealMode({ WE_REVIEW_LABEL_HEAL: 'off' })).toBe('off');
    expect(resolveReviewLabelHealMode({ WE_REVIEW_LABEL_HEAL: 'GREEN' })).toBe('green');
    expect(resolveReviewLabelHealMode({ WE_REVIEW_LABEL_HEAL: 'junk' })).toBe('stuck');
  });
});

describe('#3902 — the write half applies the hold and strips the contradictory go-ahead', () => {
  const base = {
    root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }), clearAwaitingCi: () => {},
    readHeadCheckState: () => ({ state: 'green', why: '', counts: {} }), provider: { ready: () => { throw new Error('no'); } },
  };
  const stuckPlan = { dispatch: [{ kind: 'restore-review-label', prNumber: 3902, label: 'review:pending', variant: 'stuck' }], refusals: [] };
  it('adds review:pending and removes ready-to-merge', () => {
    const added = [], removed = [];
    const r = runReconcilePromoteDraftDispatch({ ...base, reconcile: () => stuckPlan, readPrLabels: () => [{ name: 'ready-to-merge' }],
      addLabel: (a) => added.push(a.label), removeLabel: (a) => removed.push(a.label) });
    expect(added).toEqual(['review:pending']);
    expect(removed).toEqual(['ready-to-merge']);
    expect(r.dispatched).toEqual([{ pr: 3902, kind: 'restore-review-label', label: 'review:pending' }]);
  });
  it('still refuses when a review label appeared since the plan', () => {
    const r = runReconcilePromoteDraftDispatch({ ...base, reconcile: () => stuckPlan, readPrLabels: () => [{ name: 'review:human' }],
      addLabel: () => { throw new Error('must not write'); }, removeLabel: () => { throw new Error('must not write'); } });
    expect(r.refusals).toEqual([expect.objectContaining({ pr: 3902, kind: 'label-already-set' })]);
  });
});

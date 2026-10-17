import { it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { enrichPrsWithTimeoutEvidence } from '../reconcile-pass.mjs';
const head = 'a'.repeat(40);
it.each(['review:pending', 'review:changes', 'review:human', 'review:held-mechanical'])('does not heal a review-gate held by %s with advisory disabled', label => {
  const pr = { number: 5439, headRefOid: head, state: 'OPEN', mergeStateStatus: 'CLEAN', labels: [{ name: label }, { name: 'ci:failed' }],
    statusCheckRollup: [{ name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }], comments: [] };
  const plan = planReconcile({ prs: [pr], agents: [], advisoryReviewOnHumanHandoff: 'off', requiredChecks: ['review-gate'] });
  expect(plan.dispatch.some(d => d.kind === 'ci-heal')).toBe(false);
});
it('gives cancelled shards one automatic rerun rather than the six infra retries', () => {
  const pr = { number: 5439, headRefOid: head, statusCheckRollup: [{ name: 'test-shard (1)', conclusion: 'cancelled', detailsUrl: 'https://github.com/owner/repo/actions/runs/1' }] };
  const [out] = enrichPrsWithTimeoutEvidence([pr], { repo: 'owner/repo', readBudget: () => ({ confirmed: 0, rejected: 0 }),
    read: () => ({ eligible: true, infraCancelled: true, cancelledShard: true, pr: pr.number, head, jobs: [{ run: 1, job: 2, attempt: 1 }] }) });
  expect(out.timeoutRetry.cap).toBe(1);
});
it('does not grant cancelled shards another stale-CI rerun after their first rerun', () => {
  const jobs = [{ run: 1, job: 2, attempt: 1 }, { run: 1, job: 3, attempt: 1 }];
  const retry = { eligible: true, infraCancelled: true, cancelledShard: true, cap: 1, head, pr: 5439, jobs };
  const pr = { number: 5439, state: 'OPEN', headRefOid: head, labels: [{ name: 'ci:failed' }], mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'failure' }], comments: [],
    timeoutRetry: retry, timeoutRetryBudget: { confirmed: 1, rejected: 0, pending: false },
    mainGreenNow: { red: false, sha: head }, owedCiRerunRetry: retry };
  const plan = planReconcile({ prs: [pr], agents: [], requiredChecks: ['test'] });
  expect(plan.dispatch.map(d => d.kind)).toEqual(['ci-heal']);
});
it('holds a merge-gate proven review-only, but still heals a real merge-gate failure', () => {
  const pr = { number: 5439, state: 'OPEN', headRefOid: head, labels: [{ name: 'review:human' }], mergeStateStatus: 'CLEAN', comments: [],
    statusCheckRollup: [{ name: 'merge-gate', status: 'completed', conclusion: 'failure', mergeGateReviewHold: true }] };
  const plan = checks => planReconcile({ prs: [{ ...pr, statusCheckRollup: checks }], agents: [], requiredChecks: ['merge-gate'], advisoryReviewOnHumanHandoff: 'off' });
  expect(plan(pr.statusCheckRollup).dispatch.some(d => d.kind === 'ci-heal')).toBe(false);
  expect(plan([{ ...pr.statusCheckRollup[0], mergeGateReviewHold: false }]).dispatch.some(d => d.kind === 'ci-heal')).toBe(true);
});

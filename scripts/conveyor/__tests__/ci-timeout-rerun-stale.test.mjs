import { describe, it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';

const repo = 'web-everything/web-everything';
const head = 'ab9985630d90019a07b94e946bc75f8de7a6161f';
const NOW = Date.parse('2026-10-14T17:00:00Z');
const failed = { name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-14T16:00:00Z',
  detailsUrl: `https://github.com/${repo}/actions/runs/123/job/456` };
const evidence = { eligible: true, repo, pr: 5273, head, signature: 's', variant: 'owed-ci-rerun',
  jobs: [{ repo, head, run: 123, job: 456, attempt: 1 }], infraCancelled: true };
const plan = (rollup) => planReconcile({
  prs: [{ number: 5273, state: 'OPEN', isDraft: true, headRefName: 'lane/x', headRefOid: head, labels: [],
    mergeStateStatus: 'BLOCKED', comments: [], statusCheckRollup: rollup, requiredCheckCompletedAt: '2026-10-14T16:00:00Z',
    requiredCheckName: 'test', aheadByOnMain: 0, mainGreenNow: { red: false, sha: '123456789abcdef', at: '2026-10-14T07:00:00Z' },
    owedCiRerunRetry: evidence, timeoutRetry: { eligible: false, reason: 'timeout-evidence:incomplete-failure-inventory' },
    timeoutRetryBudget: { confirmed: 0, rejected: 0 } }],
  agents: [], requiredChecks: ['test'], now: NOW, mainRedWindows: [], staleCiRerun: 'once-per-head' });
const reran = out => out.dispatch.some(r => r.kind === 'ci-timeout-rerun');
const iso = ms => new Date(NOW - ms).toISOString();

describe('a stale or unrelated live check does not defer the CI re-run forever (PR #6873)', () => {
  it('re-runs when the only live check is a non-required check of another workflow', () => {
    expect(reran(plan([failed, { name: 'review-gate', workflowName: 'Review gate', status: 'IN_PROGRESS', startedAt: iso(60_000) }]))).toBe(true);
  });
  it('re-runs when the only live check has been "running" past the stuck-marker age', () => {
    expect(reran(plan([failed, { name: 'smoke', workflowName: 'CI', status: 'IN_PROGRESS', startedAt: iso(3 * 3600_000) }]))).toBe(true);
  });
  it('still holds for a recent live run of the CI workflow', () => {
    const out = plan([failed, { name: 'test-shard (1)', workflowName: 'CI', status: 'IN_PROGRESS', startedAt: iso(5 * 60_000) }]);
    expect(reran(out)).toBe(false);
    expect(out.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-timeout-rerun-in-flight', why: expect.stringContaining('(live: test-shard (1))') }));
  });
});

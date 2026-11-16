import { describe, it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';

const repo = 'web-everything/web-everything';
const head = 'ab9985630d90019a07b94e946bc75f8de7a6161f';
const NOW = Date.parse('2026-10-14T17:00:00Z');
const failed = { name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-14T16:00:00Z',
  detailsUrl: `https://github.com/${repo}/actions/runs/123/job/456` };
const evidence = { eligible: true, repo, pr: 5273, head, signature: 's', variant: 'owed-ci-rerun',
  jobs: [{ repo, head, run: 123, job: 456, attempt: 1 }], infraCancelled: true };
const plan = (rollup) => planWith(['test'], rollup);
const planWith = (requiredChecks, rollup) => planReconcile({
  prs: [{ number: 5273, state: 'OPEN', isDraft: true, headRefName: 'lane/x', headRefOid: head, labels: [],
    mergeStateStatus: 'BLOCKED', comments: [], statusCheckRollup: rollup, requiredCheckCompletedAt: '2026-10-14T16:00:00Z',
    requiredCheckName: 'test', aheadByOnMain: 0, mainGreenNow: { red: false, sha: '123456789abcdef', at: '2026-10-14T07:00:00Z' },
    owedCiRerunRetry: evidence, timeoutRetry: { eligible: false, reason: 'timeout-evidence:incomplete-failure-inventory' },
    timeoutRetryBudget: { confirmed: 0, rejected: 0 } }],
  agents: [], requiredChecks, now: NOW, mainRedWindows: [], staleCiRerun: 'once-per-head' });
const reran = out => out.dispatch.some(r => r.kind === 'ci-timeout-rerun');
const iso = ms => new Date(NOW - ms).toISOString();

describe('a stale or unrelated live check does not defer the CI re-run forever (PR #6873)', () => {
  it('re-runs when the only live check is a non-required check of another workflow', () => {
    expect(reran(plan([failed, { name: 'review-gate', workflowName: 'Review gate', status: 'IN_PROGRESS', startedAt: iso(60_000) }]))).toBe(true);
  });
  it('holds for a long-running same-workflow check (no age cap) and for an unproven workflow', () => {
    expect(reran(plan([failed, { name: 'smoke', workflowName: 'CI', status: 'IN_PROGRESS', startedAt: iso(3 * 3600_000) }]))).toBe(false);
    expect(reran(plan([{ ...failed, workflowName: '' }, { name: 'review-gate', workflowName: 'Review gate', status: 'IN_PROGRESS' }]))).toBe(false);
    expect(reran(plan([failed, { __typename: 'CheckRun', name: 'x', startedAt: iso(3 * 3600_000) }]))).toBe(false);
  });
  it('re-runs only when the workflow-less check is posted by the configured red-team app (live #6873)', () => {
    const redTeam = { __typename: 'CheckRun', name: 'red-team', workflowName: '', status: 'IN_PROGRESS', conclusion: '', startedAt: iso(8 * 3600_000),
      detailsUrl: 'https://example.invalid/app-check', appSlug: 'web-everything', appId: 5037855 };
    expect(reran(plan([failed, redTeam]))).toBe(true);
    // same name from another app, name+link alone, or missing app metadata: fail closed
    expect(reran(plan([failed, { ...redTeam, appSlug: 'other-app', appId: 42 }]))).toBe(false);
    expect(reran(plan([failed, { ...redTeam, appSlug: undefined, appId: undefined }]))).toBe(false);
    expect(reran(plan([failed, { ...redTeam, appId: null }]))).toBe(false);
    expect(reran(plan([failed, { ...redTeam, name: 'smoke' }]))).toBe(false);
    expect(reran(plan([failed, { ...redTeam, detailsUrl: `https://github.com/${repo}/actions/runs/9/job/1` }]))).toBe(true);
    // a REQUIRED check still running holds
    expect(reran(plan([failed, { ...redTeam, name: 'test', detailsUrl: `https://github.com/${repo}/actions/runs/9/job/2` }]))).toBe(false);
  });
  it('ships the live red-team poster in settings and fails closed when settings are unreadable', async () => {
    const { loadExternalCheckApps } = await import('../external-check-apps.mjs');
    expect(loadExternalCheckApps()).toContainEqual({ name: 'red-team', appSlug: 'web-everything', appId: 5037855 });
    expect(loadExternalCheckApps({ read: () => { throw new Error('x'); } })).toEqual([]);
    expect(loadExternalCheckApps({ read: () => '{"fix":{"externalCheckApps":[{"name":"red-team"}]}}' })).toEqual([]);
  });
  it('holds when proof is partial or the live check shares a run with a required check (audit round 1)', () => {
    const run = `https://github.com/${repo}/actions/runs/123/job/9`;
    const out = (rollup) => reran(planWith(['test', 'lint'], rollup));
    expect(out([{ ...failed, workflowName: '' }, { name: 'lint', workflowName: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'smoke', workflowName: 'CI', status: 'IN_PROGRESS', detailsUrl: run }])).toBe(false);
    expect(out([failed, { name: 'smoke', workflowName: 'Other', status: 'IN_PROGRESS', detailsUrl: run }])).toBe(false);
  });
  it('holds when a configured required check is absent from the rollup (audit r3 finding 1)', () => {
    const smoke = { name: 'smoke', workflowName: 'Other', status: 'IN_PROGRESS', startedAt: iso(60_000) };
    // required `lint` is absent from the rollup: the workflow proof is incomplete, so the live check holds the rerun
    expect(reran(planWith(['test', 'lint'], [failed, smoke]))).toBe(false);
    // control: with `lint` present and named, a different-workflow live check is still ignored
    expect(reran(planWith(['test', 'lint'], [failed, { name: 'lint', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }, smoke]))).toBe(true);
  });
  it('still holds for a recent live run of the CI workflow', () => {
    const out = plan([failed, { name: 'test-shard (1)', workflowName: 'CI', status: 'IN_PROGRESS', startedAt: iso(5 * 60_000) }]);
    expect(reran(out)).toBe(false);
    expect(out.refusals).toContainEqual(expect.objectContaining({ kind: 'ci-timeout-rerun-in-flight', why: expect.stringContaining('(live: test-shard (1))') }));
  });
});

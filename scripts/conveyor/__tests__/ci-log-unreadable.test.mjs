import { describe, it, expect, vi } from 'vitest';
import { readTimeoutEvidence, enrichPrsWithTimeoutEvidence } from '../reconcile-pass.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { withPlannedContext, planFixesFromReconcile } from '../reconcile-fix-dispatch.mjs';
import { makeFixEvidenceReader } from '../../lib/fix-facts.mjs';

const repo = 'web-everything/web-everything', head = 'a'.repeat(40);
const prefix = `repos/${repo}`;
const job = { id: 20, run_id: 10, head_sha: head, run_attempt: 1, status: 'completed', conclusion: 'failure', name: 'test' };
const pr = (review = false) => ({ number: 42, state: 'OPEN', headRefName: 'lane/ci-log-fix', headRefOid: head,
  mergeStateStatus: 'CLEAN', aheadByOnMain: 0, labels: review ? [{ name: 'review:changes' }] : [],
  comments: review ? [{ body: '🔁 human review — changes requested\n\nFix the failing test.' }] : [],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: `https://github.com/${repo}/actions/runs/10/job/20` }] });
function fixture(error) {
  const data = {
    [`${prefix}/pulls/42`]: { state: 'open', head: { sha: head }, base: { sha: 'b'.repeat(40) }, changed_files: 1 },
    [`${prefix}/pulls/42/files?per_page=100&page=1`]: [{ filename: 'unit.test.mjs' }],
    [`${prefix}/commits/${head}/check-runs?per_page=100&page=1&filter=latest`]: { total_count: 1, check_runs: [{
      name: 'test', status: 'completed', conclusion: 'failure', details_url: `https://github.com/${repo}/actions/runs/10/job/20` }] },
    [`${prefix}/commits/${head}/status`]: { total_count: 0 },
    [`${prefix}/actions/jobs/20`]: job,
    [`${prefix}/actions/runs/10`]: { id: 10, head_sha: head, run_attempt: 1, repository: { full_name: repo }, path: '.github/workflows/ci.yml' },
  };
  return vi.fn((_command, args) => {
    const path = args.at(-1);
    if (path.endsWith('/logs')) { expect(args).toContain('--allow-escape-sequences'); throw error; }
    if (!Object.hasOwn(data, path)) throw new Error(`Unexpected endpoint: ${path}`);
    return JSON.stringify(data[path]);
  });
}
const plan = prs => planReconcile({ prs, requiredChecks: ['test'], agents: [] });
describe('unreadable CI logs keep bounded repair available', () => {
  it.each([false, true])('collects log-unreadable with the plain or shared facts reader (facts=%s)', facts => {
    const exec = fixture(new Error('HTTP 404'));
    const reader = facts ? makeFixEvidenceReader({ repo, exec, env: { WE_FIX_FACTS: '0' } }) : undefined;
    expect(readTimeoutEvidence(pr(), { repo, exec, reader, facts: () => ({ stale: false }) }))
      .toEqual({ eligible: false, reason: 'log-unreadable' });
  });
  it('log-unreadable does not block ci-heal dispatch or authorize a timeout rerun', () => {
    const prs = enrichPrsWithTimeoutEvidence([pr()], { repo, enabled: true, readBudget: () => ({ confirmed: 0, pending: false }),
      read: input => readTimeoutEvidence(input, { repo, exec: fixture(new Error('HTTP 404')) }) });
    expect(plan(prs).dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal', ciLogEvidenceReason: 'log-unreadable' }));
    expect(plan(prs).dispatch.some(row => row.kind === 'ci-timeout-rerun')).toBe(false);
  });
  it('review:changes own-failure dispatches a fixer carrying log-unreadable into its brief', () => {
    const input = { ...pr(true), timeoutRetry: { eligible: false, reason: 'log-unreadable' } };
    const result = plan([input]);
    expect(result.dispatch).toContainEqual(expect.objectContaining({ kind: 'fix', ciLogEvidenceReason: 'log-unreadable' }));
    const entry = result.dispatch.find(row => row.kind === 'fix');
    const launch = planFixesFromReconcile([{ ...entry, files: ['unit.test.mjs'] }], () => null, () => []).planned[0];
    expect(launch).toMatchObject({ ciLogEvidenceReason: 'log-unreadable' });
    expect(withPlannedContext('Fix brief', launch)).toContain('CI log evidence: log-unreadable');
  });
  it('actual log-read timeouts stay unknown, retry, and block dispatch', () => {
    const sleep = vi.fn(), exec = fixture(Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    const evidence = readTimeoutEvidence(pr(), { repo, exec, sleep });
    expect(evidence).toMatchObject({ eligible: false, unknown: true });
    expect(sleep).toHaveBeenCalledTimes(3);
    const result = plan([{ ...pr(), timeoutRetry: evidence }]);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'timeout-evidence-unknown' }));
  });
  it('log-unreadable cannot bypass the review round cap', () => {
    const input = { ...pr(true), timeoutRetry: { eligible: false, reason: 'log-unreadable' } };
    const result = planReconcile({ prs: [input], requiredChecks: ['test'], agents: [], roundCap: 0, roundCapAction: 'person' });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted' }));
  });
});

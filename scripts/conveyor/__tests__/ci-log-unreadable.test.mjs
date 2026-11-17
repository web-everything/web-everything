import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTimeoutEvidence, enrichPrsWithTimeoutEvidence } from '../reconcile-pass.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { withPlannedContext, planFixesFromReconcile } from '../reconcile-fix-dispatch.mjs';
import { makeFixEvidenceReader } from '../../lib/fix-facts.mjs';
import { REVIEW_PR_CHANNEL } from '../../lib/review-escalation.mjs';

const repo = 'web-everything/web-everything', head = 'a'.repeat(40);
const prefix = `repos/${repo}`;
const job = { id: 20, run_id: 10, head_sha: head, run_attempt: 1, status: 'completed', conclusion: 'failure', name: 'test' };
const pr = (review = false) => ({ number: 42, state: 'OPEN', headRefName: 'lane/ci-log-fix', headRefOid: head,
  mergeStateStatus: 'CLEAN', aheadByOnMain: 0, labels: review ? [{ name: 'review:changes' }] : [],
  comments: review ? [{ body: '🔁 human review — changes requested\n\nFix the failing test.' }] : [],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: `https://github.com/${repo}/actions/runs/10/job/20` }] });
function fixture(error, escapeLog = null) {
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
    if (path.endsWith('/logs')) {
      if (escapeLog !== null && args.includes('--allow-escape-sequences')) return escapeLog;
      expect(args).toEqual(['api', path]);
      throw error;
    }
    if (!Object.hasOwn(data, path)) throw new Error(`Unexpected endpoint: ${path}`);
    return JSON.stringify(data[path]);
  });
}
const plan = prs => planReconcile({ prs, requiredChecks: ['test'], agents: [] });
describe('unreadable CI logs keep bounded repair available', () => {
  it.each(['plain', 'facts-disabled', 'facts-enabled', 'facts-raw-api'])(
    'escape-coded logs are unreadable and never eligible or read with the allow flag (%s)', mode => {
      // A passing step's timeout and an unrelated deploy failure must not authorize a rerun.
      const log = '\x1b[31mFAIL passing.test.mjs > timeout fixture\x1b[0m\nError: Test timed out in 5000ms.\n'
        + 'Test Files  1 failed (1)\nTests  1 failed (1)\nDeploy failed: permission denied\n';
      const exec = fixture(new Error('API response contains terminal escape sequences'), log);
      const cacheDir = mkdtempSync(join(tmpdir(), 'timeout-classifier-'));
      try {
        let reader;
        if (mode !== 'plain') {
          reader = makeFixEvidenceReader({ repo, pr: 42, head, exec, cacheDir,
            env: { WE_FIX_FACTS: mode === 'facts-disabled' ? '0' : '1' },
            rest: path => ({ json: JSON.parse(exec('gh', ['api', path])) }) });
          if (mode === 'facts-raw-api') reader = { api: reader.api };
        }
        const sleep = vi.fn();
        expect(readTimeoutEvidence(pr(), { repo, exec, reader, sleep, facts: () => ({ stale: false }) }))
          .toEqual({ eligible: false, reason: 'log-unreadable' });
        const logCalls = exec.mock.calls.filter(([, args]) => args.at(-1).endsWith('/logs'));
        expect(logCalls).toHaveLength(1);
        expect(logCalls[0][1]).toEqual(['api', `${prefix}/actions/jobs/20/logs`]);
        expect(sleep).not.toHaveBeenCalled();
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });
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
  it.each([false, true])('log-unreadable retains the readable-failure ci-heal path (bounced=%s)', bounced => {
    const input = pr(bounced);
    const readable = plan([{ ...input, timeoutRetry: { eligible: false, reason: 'no-timeout-signature' } }]);
    const unreadable = plan([{ ...input, timeoutRetry: { eligible: false, reason: 'log-unreadable' } }]);
    for (const result of [readable, unreadable]) {
      expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', attempts: 0 })]);
    }
    expect(unreadable.dispatch[0]).toMatchObject({ ciLogEvidenceReason: 'log-unreadable', timeoutRetryFallback: 'log-unreadable' });
  });
  it('review:changes own-failure keeps the existing joined fixer carrying log-unreadable into its brief', () => {
    // A trusted current-head verdict already joins CI and review repair, independently of log readability.
    const finding = { author: { login: 'web-everything' }, body:
      `🔁 review — changes requested\n\nRecorded by juror via ${REVIEW_PR_CHANNEL}.\n\nFix the failing test.\n\n---\n\nNet basis: \`0000..${head}\` — 1 net changed file(s) vs current main\n\n_Recorded through ${REVIEW_PR_CHANNEL}._` };
    const input = { ...pr(true), comments: [finding], timeoutRetry: { eligible: false, reason: 'log-unreadable' } };
    expect(plan([{ ...input, timeoutRetry: { eligible: false, reason: 'no-timeout-signature' } }]).dispatch)
      .toEqual([expect.objectContaining({ kind: 'fix', joinedInputs: { head, ciFailures: [expect.objectContaining({ name: 'test' })], reviewFindings: [finding.body] } })]);
    const result = plan([input]);
    expect(result.dispatch).toContainEqual(expect.objectContaining({ kind: 'fix', ciLogEvidenceReason: 'log-unreadable' }));
    expect(result.dispatch).toHaveLength(1);
    expect(result.dispatch[0].joinedInputs.reviewFindings).toEqual([finding.body]);
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

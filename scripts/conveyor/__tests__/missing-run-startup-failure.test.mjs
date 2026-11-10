import { describe, it, expect, vi } from 'vitest';
import { buildMissingRunCandidates, buildMissingRunComment, isStalledPartialRollup } from '../main-red-recovery.mjs';
import { defaultReadHeadRuns, sweepMissingRunRecovery, triggerCiForPr } from '../ci-red-recovery-watch.mjs';

vi.mock('../../lib/gh-throttle.mjs', async original => ({
  ...await original(), execFileSyncThrottled: vi.fn(() => { throw new Error('unexpected live IO'); }),
}));

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const CLASSIC = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const REQUIRED = [...CLASSIC, 'merge-gate'];
const done = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion });
const run = (conclusion = 'startup_failure') => ({
  id: 5060, name: 'Merge gate', path: '.github/workflows/merge-gate.yml', event: 'pull_request_target',
  head_sha: HEAD, status: 'completed', conclusion, created_at: '2026-11-08T00:00:00Z',
});
const pr = (rows = [done('merge-gate', 'STARTUP_FAILURE')], workflowRuns = [run()]) => ({
  number: 5060, state: 'OPEN', headRefName: 'lane/5060', headRefOid: HEAD,
  baseRefName: 'main', isCrossRepository: false, mergeable: 'MERGEABLE',
  statusCheckRollup: [...CLASSIC.map(name => done(name)), ...rows], workflowRuns,
});
const candidates = value => buildMissingRunCandidates([value], {
  requiredContexts: CLASSIC, stalledPartialContexts: REQUIRED,
});

describe('required ruleset context startup failures use missing-run push recovery', () => {
  it.each([
    ['startup_failure dispatches', [run()], true],
    ['plain-absent stays refused', [], false],
    ['unreadable runs stay refused', null, false],
    ['startup_failure stays per-SHA capped', [run()], false, 2],
  ])('reads head runs when the PR-wide cap is exhausted: %s', (_, runs, allowed, currentAttempts = 0) => {
    // Match the open-PR listing: no merge-gate row or workflowRuns field.
    const value = pr([]);
    delete value.workflowRuns;
    const readHeadRuns = vi.fn(() => runs);
    const trigger = vi.fn(() => ({ ok: true }));
    const result = sweepMissingRunRecovery({
      repo: REPO, apply: true, mainRuns: [], now: Date.parse('2026-11-09T12:00:00Z'),
      readOpenPrs: () => [value], readRequiredContexts: () => CLASSIC, readAttributedRequiredChecks: () => REQUIRED,
      readHeadRuns, readPush: () => null, readHeadCommittedAt: () => '2026-11-08T00:00:00Z',
      readComments: () => ['old-head-1', 'old-head-2', ...Array(currentAttempts).fill(HEAD)].map(headSha => ({
        viewerDidAuthor: true, body: buildMissingRunComment({ headSha }),
      })),
      maxRetriesPerSha: 2, maxRetriesPerPr: 2, trigger, postComment: vi.fn(), clearLabel: vi.fn(),
    });
    if (currentAttempts === 2) {
      expect(readHeadRuns).not.toHaveBeenCalled();
      expect(result.dispatch).toEqual([]);
      expect(result.refusals).toEqual([expect.objectContaining({ kind: 'missing-run-cap-exhausted', attempts: 2 })]);
      expect(trigger).not.toHaveBeenCalled();
      return;
    }
    expect(readHeadRuns).toHaveBeenCalledTimes(1);
    expect(readHeadRuns).toHaveBeenCalledWith({ repo: REPO, headSha: HEAD });
    if (allowed) {
      expect(result.dispatch).toEqual([expect.objectContaining({ headSha: HEAD, attempts: 0 })]);
      expect(result.refusals).toEqual([]);
      expect(trigger).toHaveBeenCalledTimes(1);
    } else {
      expect(result.dispatch).toEqual([]);
      expect(result.refusals).toEqual([expect.objectContaining({ kind: 'missing-run-pr-cap-exhausted', attempts: 2,
        why: expect.stringContaining('needs human/ci-heal inspection') })]);
      expect(trigger).not.toHaveBeenCalled();
    }
  });

  it('reads complete head runs with one bounded GitHub call', () => {
    const runs = [run()];
    const exec = vi.fn(() => JSON.stringify({ total_count: 1, workflow_runs: runs }));
    expect(defaultReadHeadRuns({ repo: REPO, headSha: HEAD, exec })).toEqual(runs);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('gh', ['api', `repos/${REPO}/actions/runs?head_sha=${HEAD}&per_page=100`],
      expect.objectContaining({ maxBuffer: 4 * 1024 * 1024, timeout: expect.any(Number), killSignal: 'SIGKILL' }));
    expect(defaultReadHeadRuns({ repo: REPO, headSha: HEAD,
      exec: () => JSON.stringify({ total_count: 0, workflow_runs: [] }) })).toEqual([]);
  });

  it.each([
    ['read error', () => { throw new Error('unreadable'); }],
    ['invalid JSON', () => '{'],
    ['missing count', () => JSON.stringify({ workflow_runs: [run()] })],
    ['incomplete page', () => JSON.stringify({ total_count: 2, workflow_runs: [run()] })],
    ['full page', () => JSON.stringify({ total_count: 100, workflow_runs: Array(100).fill(run()) })],
    ['oversized result', () => JSON.stringify({ total_count: 101, workflow_runs: Array(100).fill(run()) })],
  ])('head-run reader fails closed on %s', (_, exec) => {
    expect(defaultReadHeadRuns({ repo: REPO, headSha: HEAD, exec })).toBeNull();
  });

  it.each([0, 1, 2])('uses the current-head budget with two old-head comments and %s current-head attempts', attempts => {
    const value = pr();
    const comments = ['old-head-1', 'old-head-2', ...Array(attempts).fill(HEAD)].map(headSha => ({
      viewerDidAuthor: true, body: buildMissingRunComment({ headSha }),
    }));
    const trigger = vi.fn(() => ({ ok: true, action: 'pull-request-push' }));
    const postComment = vi.fn();
    const result = sweepMissingRunRecovery({
      repo: REPO, apply: true, mainRuns: [], now: Date.parse('2026-11-09T12:00:00Z'),
      readOpenPrs: () => [value], readRequiredContexts: () => CLASSIC, readAttributedRequiredChecks: () => REQUIRED,
      readRecoveryPr: () => value,
      readRecoveryEvidence: () => ({ requiredContexts: REQUIRED, rollup: value.statusCheckRollup, workflowRuns: value.workflowRuns }),
      readRecoveryCredential: () => ({ token: 'ghp_fixture', env: {} }), checkClaim: () => null,
      readPush: () => null, readHeadCommittedAt: () => '2026-11-08T00:00:00Z', readComments: () => comments,
      maxRetriesPerSha: 2, maxRetriesPerPr: 2, trigger, postComment, clearLabel: vi.fn(),
    });
    if (attempts < 2) {
      expect(result.dispatch).toEqual([expect.objectContaining({ headSha: HEAD, attempts, kind: 'trigger-ci' })]);
      expect(result.refusals).toEqual([]);
      expect(result.applied).toEqual([expect.objectContaining({ ok: true })]);
      expect(trigger).toHaveBeenCalledTimes(1);
      expect(postComment).toHaveBeenCalledTimes(1);
    } else {
      expect(result.dispatch).toEqual([]);
      expect(result.refusals).toEqual([expect.objectContaining({ kind: 'missing-run-cap-exhausted', attempts: 2 })]);
      expect(trigger).not.toHaveBeenCalled();
      expect(postComment).not.toHaveBeenCalled();
    }
  });

  it.each([1, 2])('startup_failure-only context counts as absent (%s rollup rows)', count => {
    const value = pr(Array.from({ length: count }, () => done('merge-gate', 'STARTUP_FAILURE')));
    expect(isStalledPartialRollup(value.statusCheckRollup, REQUIRED)).toBe(true);
    expect(candidates(value)).toEqual([expect.objectContaining({ prNumber: 5060, headSha: HEAD })]);
  });

  it('startup_failure-only context counts as absent with workflow evidence and no row', () => {
    expect(candidates(pr([], [run(), { ...run(), id: 5061 }]))).toHaveLength(1);
  });

  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT'])('failed context is not absent (%s)', conclusion => {
    for (const rows of [[done('merge-gate', conclusion)],
      [done('merge-gate', 'STARTUP_FAILURE'), done('merge-gate', conclusion)]]) {
      expect(candidates(pr(rows))).toEqual([]);
    }
    // A missing rollup row must not hide a workflow that actually ran and failed.
    expect(candidates(pr([], [run(), { ...run(conclusion.toLowerCase()), id: 5061 }]))).toEqual([]);
  });

  it.each(['PENDING', 'QUEUED', 'IN_PROGRESS'])('pending context is not absent (%s)', status => {
    const pending = { ...done('merge-gate'), status, conclusion: null };
    expect(candidates(pr([done('merge-gate', 'STARTUP_FAILURE'), pending]))).toEqual([]);
    expect(candidates(pr([], [run(), { ...run(null), id: 5061, status: status.toLowerCase() }]))).toEqual([]);
  });

  it('sweeps a startup_failure-only merge-gate through one push and caps a second sweep on the same head', () => {
    const value = pr();
    const comments = [];
    const pushes = vi.fn();
    const checkClaim = vi.fn(() => null);
    const evidence = { requiredContexts: REQUIRED, rollup: value.statusCheckRollup, workflowRuns: value.workflowRuns };
    const exec = vi.fn((command, args) => {
      if (command === 'gh') {
        if (args.join(' ') !== `api repos/${REPO}/pulls/5060`) throw new Error('unexpected GitHub mutation/read');
        return JSON.stringify({ state: 'open', mergeable: true, base: { ref: 'main' },
          head: { sha: HEAD, ref: value.headRefName, repo: { full_name: REPO } } });
      }
      if (command !== 'git') throw new Error('unexpected command');
      if (args.includes('FETCH_HEAD')) return HEAD;
      if (args.includes('show')) return 'original commit';
      if (args.includes(`${HEAD}^{tree}`)) return 'c'.repeat(40);
      if (args.includes('commit-tree')) return NEXT;
      if (args.includes('push')) pushes(args);
      return '';
    });
    const trigger = vi.fn((dispatch, options) => triggerCiForPr(dispatch, {
      ...options, exec, checkClaim, env: { GH_TOKEN: 'ghp_acceptance_fixture' }, readCache: () => null,
      recoveryEvidence: evidence, attemptsForSha: comments.length, attemptsForPr: comments.length,
      maxRetriesPerSha: 1, maxRetriesPerPr: 1,
    }));
    const options = {
      repo: REPO, apply: true, mainRuns: [], now: Date.parse('2026-11-09T12:00:00Z'),
      readOpenPrs: () => [value], readRequiredContexts: () => CLASSIC, readAttributedRequiredChecks: () => REQUIRED,
      readRecoveryEvidence: vi.fn(() => evidence), readRecoveryPr: vi.fn(() => value),
      readRecoveryCredential: vi.fn(() => ({ token: 'ghp_acceptance_fixture', env: {} })),
      checkClaim, readPush: () => null,
      readHeadCommittedAt: () => '2026-11-08T00:00:00Z', readComments: () => comments,
      maxRetriesPerSha: 1, maxRetriesPerPr: 1, trigger,
      postComment: (_, facts) => comments.push({ viewerDidAuthor: true, body: buildMissingRunComment(facts) }),
      clearLabel: vi.fn(() => true), restack: vi.fn(() => { throw new Error('must use the push path'); }),
    };
    const first = sweepMissingRunRecovery(options);
    expect(first.applied).toEqual([expect.objectContaining({ ok: true, action: 'pull-request-push', newHeadSha: NEXT })]);
    expect(pushes).toHaveBeenCalledTimes(1);
    expect(options.readRecoveryPr).toHaveBeenCalledTimes(1);
    expect(options.readRecoveryCredential).toHaveBeenCalledTimes(1);
    expect(options.readRecoveryEvidence).toHaveBeenCalledWith(expect.objectContaining({ headSha: HEAD }),
      { repo: REPO, requiredContexts: REQUIRED });
    expect(checkClaim).toHaveBeenCalledWith({ repo: REPO, branch: value.headRefName });
    expect(comments).toHaveLength(1);
    const second = sweepMissingRunRecovery(options);
    expect(second.dispatch).toEqual([]);
    expect(second.refusals).toEqual([expect.objectContaining({ kind: expect.stringMatching(/^missing-run-(pr-)?cap-exhausted$/) })]);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(pushes).toHaveBeenCalledTimes(1);
    expect(options.readRecoveryPr).toHaveBeenCalledTimes(1);
    expect(options.readRecoveryEvidence).toHaveBeenCalledTimes(1);
    expect(options.restack).not.toHaveBeenCalled();
  });
});

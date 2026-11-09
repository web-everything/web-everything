import { describe, expect, it, vi } from 'vitest';
import { buildMissingRunCandidates, buildMissingRunComment, countMissingRunComments } from '../main-red-recovery.mjs';
import { recoveryPreflight } from '../recovery-preflight.mjs';
import { defaultReadRecoveryCredential, defaultReadRecoveryEvidence, defaultReadRecoveryPr,
  sweepMissingRunRecovery } from '../ci-red-recovery-watch.mjs';

vi.mock('../../lib/gh-throttle.mjs', async original => ({
  ...await original(), execFileSyncThrottled: vi.fn(() => { throw new Error('unexpected live IO'); }),
}));

const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40);
const pr = { number: 5060, state: 'OPEN', baseRefName: 'main', headRefName: 'lane/5060',
  headRefOid: head, isCrossRepository: false, mergeable: 'MERGEABLE',
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }] };
const evidence = { requiredContexts: ['test'], rollup: [], workflowRuns: [] };

function sweep(patch = {}) {
  const options = { repo, apply: true, mainRuns: [], now: Date.parse('2026-11-09T12:00:00Z'),
    readOpenPrs: () => [pr], readRequiredContexts: () => ['test'], readAttributedRequiredChecks: () => ['test'],
    readPush: () => null, readHeadCommittedAt: () => '2026-11-08T00:00:00Z', readComments: () => [],
    readRecoveryPr: vi.fn(() => pr), readRecoveryEvidence: vi.fn(() => evidence),
    readRecoveryCredential: vi.fn(() => ({ token: 'ghp_fixture', env: {} })),
    checkClaim: vi.fn(() => null), trigger: vi.fn(() => ({ ok: true, action: 'pull-request-push' })),
    postComment: vi.fn(), clearLabel: vi.fn(), maxRetriesPerSha: 1, maxRetriesPerPr: 1, ...patch };
  return { result: sweepMissingRunRecovery(options), options };
}

describe('missing-run sweep owns preflight admission', () => {
  it('refuses recovery when all required contexts appear in live evidence', () => {
    // The listing still has a startup failure, but a newer live read proves
    // that the required check has since executed successfully.
    const readRecoveryEvidence = vi.fn(() => ({ ...evidence,
      rollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    }));
    const { result, options } = sweep({ readRecoveryEvidence });
    expect(readRecoveryEvidence).toHaveBeenCalledTimes(1);
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: pr.number })]);
    expect(result.refusals).toEqual([expect.objectContaining({
      kind: 'missing-run-preflight-refused',
      why: expect.stringContaining('no required context is absent'),
    })]);
    expect(result.applied).toEqual([expect.objectContaining({ ok: false, deferred: true, labelCleared: false })]);
    expect(options.trigger).not.toHaveBeenCalled();
    expect(options.postComment).not.toHaveBeenCalled();
    expect(options.clearLabel).not.toHaveBeenCalled();
  });

  it.each([
    ['unreadable live PR', null],
    ['closed live PR', { ...pr, state: 'CLOSED' }],
    ['merged live PR', { ...pr, state: 'MERGED' }],
    ['unknown live PR state', { ...pr, state: undefined }],
    ['nondefault live base', { ...pr, baseRefName: 'lane/parent' }],
    ['unreadable live base', { ...pr, baseRefName: undefined }],
    ['fork live PR', { ...pr, isCrossRepository: true }],
    ['unknown live fork status', { ...pr, isCrossRepository: undefined }],
    ['conflicting live PR', { ...pr, mergeable: 'CONFLICTING' }],
    ['unknown live mergeability', { ...pr, mergeable: 'UNKNOWN' }],
    ['unreadable live mergeability', { ...pr, mergeable: undefined }],
    ['moved live head SHA', { ...pr, headRefOid: 'b'.repeat(40) }],
    ['unreadable live head SHA', { ...pr, headRefOid: undefined }],
    ['moved live head branch', { ...pr, headRefName: 'lane/other' }],
    ['unreadable live head branch', { ...pr, headRefName: undefined }],
  ])('refuses %s without triggering, commenting, or changing labels', (_, livePr) => {
    const { result, options } = sweep({ readRecoveryPr: () => livePr });
    expect(result.refusals).toEqual([expect.objectContaining({
      kind: 'missing-run-preflight-refused',
      why: expect.stringContaining('live PR state is ineligible, moved or unreadable'),
    })]);
    expect(result.applied).toEqual([expect.objectContaining({ ok: false, deferred: true, labelCleared: false })]);
    expect(options.trigger).not.toHaveBeenCalled();
    expect(options.postComment).not.toHaveBeenCalled();
    expect(options.clearLabel).not.toHaveBeenCalled();
  });

  it.each([[], [{ name: 'smoke', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    [{ name: 'smoke', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }],
  ])('preserves the legacy call path for a classic rollup %j', statusCheckRollup => {
    const { result, options } = sweep({
      readOpenPrs: () => [{ ...pr, statusCheckRollup }],
      readRequiredContexts: () => ['test', 'smoke'],
      readAttributedRequiredChecks: () => ['test', 'smoke', 'merge-gate'],
      readComments: () => ['old-head-1', 'old-head-2'].map(headSha => ({
        viewerDidAuthor: true, body: buildMissingRunComment({ headSha }),
      })),
    });
    expect(result.refusals).toEqual([]);
    expect(options.trigger).toHaveBeenCalledTimes(1);
    for (const reader of ['readRecoveryPr', 'readRecoveryEvidence', 'readRecoveryCredential', 'checkClaim']) {
      expect(options[reader]).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, [{ id: 1, name: 'Other', path: '.github/workflows/other.yml',
    status: 'completed', conclusion: 'startup_failure' }]])(
    'preserves plain-absent ruleset admission with unrelated workflow evidence %j', workflowRuns => {
      const { result, options } = sweep({
        readOpenPrs: () => [{ ...pr, workflowRuns,
          statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }],
        readAttributedRequiredChecks: () => ['test', 'merge-gate'],
      });
      expect(result.refusals).toEqual([]);
      expect(options.trigger).toHaveBeenCalledTimes(1);
      for (const reader of ['readRecoveryPr', 'readRecoveryEvidence', 'readRecoveryCredential', 'checkClaim']) {
        expect(options[reader]).not.toHaveBeenCalled();
      }
    });

  it('requires full admission for workflow-only startup-failure evidence of a required context', () => {
    const { result, options } = sweep({
      readOpenPrs: () => [{ ...pr,
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        workflowRuns: [{ name: 'Merge gate', path: '.github/workflows/merge-gate.yml',
          status: 'completed', conclusion: 'startup_failure' }],
      }],
      readAttributedRequiredChecks: () => ['test', 'merge-gate'],
      readRecoveryEvidence: () => null,
    });
    expect(options.readRecoveryPr).toHaveBeenCalledTimes(1);
    expect(options.trigger).not.toHaveBeenCalled();
    expect(result.refusals).toEqual([expect.objectContaining({ kind: 'missing-run-preflight-refused' })]);
  });

  it('requires full admission for a ruleset-only startup-failure context', () => {
    const { result, options } = sweep({
      readOpenPrs: () => [{ ...pr, statusCheckRollup: [
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'merge-gate', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' },
      ] }],
      readAttributedRequiredChecks: () => ['test', 'merge-gate'],
      readRecoveryEvidence: () => null,
    });
    expect(options.readRecoveryPr).toHaveBeenCalledTimes(1);
    expect(options.checkClaim).toHaveBeenCalledTimes(1);
    expect(options.readRecoveryCredential).toHaveBeenCalledTimes(1);
    expect(options.trigger).not.toHaveBeenCalled();
    expect(result.refusals).toEqual([expect.objectContaining({ kind: 'missing-run-preflight-refused' })]);
  });

  it('admits a ruleset-only startup-failure candidate with complete live inputs', () => {
    const value = { ...pr, statusCheckRollup: [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'merge-gate', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' },
    ] };
    const { result, options } = sweep({
      readOpenPrs: () => [value], readRecoveryPr: vi.fn(() => value),
      readAttributedRequiredChecks: () => ['test', 'merge-gate'],
      readRecoveryEvidence: vi.fn(() => ({ requiredContexts: ['test', 'merge-gate'],
        rollup: value.statusCheckRollup, workflowRuns: [] })),
    });
    expect(result.refusals).toEqual([]);
    expect(options.trigger).toHaveBeenCalledTimes(1);
    expect(options.readRecoveryEvidence).toHaveBeenCalledWith(expect.objectContaining({ headSha: head }),
      { repo, requiredContexts: ['test', 'merge-gate'] });
    expect(options.checkClaim).toHaveBeenCalledTimes(1);
    expect(options.readRecoveryCredential).toHaveBeenCalledTimes(1);
  });

  it('triggers once only after complete live evidence allows admission', () => {
    const { result, options } = sweep();
    expect(result.applied).toEqual([expect.objectContaining({ ok: true })]);
    expect(options.trigger).toHaveBeenCalledTimes(1);
    expect(options.checkClaim).toHaveBeenCalledWith({ repo, branch: pr.headRefName });
    expect(options.readRecoveryPr).toHaveBeenCalledWith(expect.objectContaining({ headSha: head }), { repo });
  });

  it.each([
    ['held claim', { checkClaim: () => ({ message: 'held' }) }],
    ['unreadable claim', { checkClaim: () => undefined }],
    ['false claim response', { checkClaim: () => false }],
    ['throwing claim', { checkClaim: () => { throw new Error('unreadable'); } }],
    ['missing evidence', { readRecoveryEvidence: () => null }],
    ['failed workflow', { readRecoveryEvidence: () => ({ ...evidence, workflowRuns: [{}] }) }],
    ['moved live head', { readRecoveryPr: () => ({ ...pr, headRefOid: 'b'.repeat(40) }) }],
    ['non-lane branch', { readOpenPrs: () => [{ ...pr, headRefName: 'fix/5060' }] }],
    ['ineligible credential', { readRecoveryCredential: () => ({ token: 'ghs_actions', env: {} }) }],
    ['spent PR cap', { maxRetriesPerPr: 0 }],
  ])('defers %s without invoking the trigger or consuming an attempt', (_, patch) => {
    const { result, options } = sweep(patch);
    expect(options.trigger).not.toHaveBeenCalled();
    expect(options.postComment).not.toHaveBeenCalled();
    expect(options.clearLabel).not.toHaveBeenCalled();
    expect(result.refusals).toContainEqual(expect.objectContaining({
      kind: 'missing-run-preflight-refused', why: expect.stringMatching(/human|operator|ci-heal/),
    }));
    expect(result.applied).toEqual([expect.objectContaining({ ok: false, deferred: true })]);
  });

  it('refuses an exhausted SHA budget while the PR budget remains without trigger, comment, or label mutation', () => {
    const comments = [{ viewerDidAuthor: true, body: buildMissingRunComment({
      headSha: head, headRefName: pr.headRefName, ok: true, action: 'pull-request-push',
    }) }];
    // Pin both independent counts so the fixture cannot pass through a spent PR
    // budget or an untrusted marker that was never counted.
    expect(countMissingRunComments(comments, head)).toBe(1);
    expect(countMissingRunComments(comments, null)).toBe(1);
    const { result, options } = sweep({
      readComments: () => comments, maxRetriesPerSha: 1, maxRetriesPerPr: 2,
    });
    expect(result.dispatch).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.refusals).toEqual([expect.objectContaining({ kind: 'missing-run-cap-exhausted' })]);
    expect(options.trigger).not.toHaveBeenCalled();
    expect(options.postComment).not.toHaveBeenCalled();
    expect(options.clearLabel).not.toHaveBeenCalled();
  });

  it('preflight independently refuses the SHA cap while the PR cap is available', () => {
    const input = { repo, head, headRefName: pr.headRefName, pr, recoveryEvidence: evidence,
      claimed: false, token: 'ghp_fixture', env: {}, attemptsForSha: 1, attemptsForPr: 1,
      maxRetriesPerSha: 1, maxRetriesPerPr: 2 };
    // The planner already checks this limit. Exercise admission itself too, so
    // deleting its per-SHA comparison cannot hide behind that earlier refusal.
    expect(recoveryPreflight(input)).toEqual({
      allow: false, reason: expect.stringMatching(/cap exhausted.*human\/operator or ci-heal/),
    });
    expect(recoveryPreflight({ ...input, maxRetriesPerSha: 2 })).toMatchObject({ allow: true });
  });

  it('does not read admission inputs in a dry run', () => {
    const { options } = sweep({ apply: false });
    for (const reader of ['readRecoveryPr', 'readRecoveryEvidence', 'readRecoveryCredential', 'checkClaim', 'trigger']) {
      expect(options[reader]).not.toHaveBeenCalled();
    }
  });

  it('default PR and credential readers use bounded production calls and refuse read failures', () => {
    const exec = vi.fn(() => { throw new Error('unreadable'); });
    expect(defaultReadRecoveryPr({ prNumber: 5060 }, { repo, exec })).toBeNull();
    expect(defaultReadRecoveryCredential({ repo, exec, env: {}, readCache: () => null })).toMatchObject({ token: null });
    expect(exec).toHaveBeenCalledTimes(2);
    for (const [command, , options] of exec.mock.calls) {
      expect(command).toBe('gh');
      expect(options.maxBuffer).toBeGreaterThan(0);
      expect(options.timeout).toBeGreaterThan(0);
    }
  });

  it('oversized workflow evidence defers with operator fallback instead of assuming absent runs', () => {
    const exec = vi.fn((command, args) => JSON.stringify(args[0] === 'pr'
      ? { headRefOid: head, statusCheckRollup: [] } : { total_count: 100, workflow_runs: [] }));
    const { result, options } = sweep({ readRecoveryEvidence: d => defaultReadRecoveryEvidence(d, {
      repo, requiredContexts: ['test'], exec,
    }) });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(options.trigger).not.toHaveBeenCalled();
    expect(result.applied[0]).toMatchObject({ deferred: true, error: expect.stringMatching(/human|ci-heal/) });
  });
});

describe('missing-run candidate classification with workflow evidence', () => {
  const startupRow = { name: 'merge-gate', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' };
  const workflow = { id: 5060, name: 'Merge gate', path: '.github/workflows/merge-gate.yml',
    event: 'pull_request_target', head_sha: head, status: 'completed', conclusion: 'startup_failure' };
  const candidates = (workflowRuns, statusCheckRollup = [startupRow]) => buildMissingRunCandidates([
    { ...pr, statusCheckRollup, workflowRuns },
  ], { requiredContexts: ['merge-gate'] });

  it.each(['present', 'absent'])('includes startup-only workflow evidence with its rollup row %s', row => {
    expect(candidates([workflow], row === 'present' ? [startupRow] : [])).toEqual([
      { prNumber: pr.number, headSha: head, headRefName: pr.headRefName, baseRefName: 'main' },
    ]);
  });

  it.each([
    ['exact workflow name', { name: 'merge-gate', path: '.github/workflows/other.yml' }],
    ['normalized workflow name', { name: 'Merge Gate', path: '.github/workflows/other.yml' }],
    ['workflow path', { name: 'Other workflow', path: '.github/workflows/merge-gate.yml' }],
  ])('excludes successful workflow evidence preceding its rollup row via %s', (_, identity) => {
    const succeeded = { ...workflow, ...identity, id: 5061, conclusion: 'success' };
    // The old startup-failure row may still be visible while the successful
    // run's check row has not arrived. Both timing shapes must suppress recovery.
    expect(candidates([workflow, succeeded])).toEqual([]);
    expect(candidates([workflow, succeeded], [])).toEqual([]);
  });

  it.each(['neutral', 'skipped'])('excludes an executed %s workflow before its rollup row arrives', conclusion => {
    expect(candidates([{ ...workflow, conclusion }], [])).toEqual([]);
  });

  it.each(['queued', 'in_progress', 'pending'])('excludes startup-only rollup when another workflow is %s', status => {
    // An unrelated name leaves merge-gate absent even after synthesizing rows;
    // only the explicit pending-workflow guard can suppress this candidate.
    const pending = { ...workflow, id: 5061, name: 'Other workflow', path: '.github/workflows/other.yml',
      status, conclusion: null };
    expect(candidates([workflow, pending])).toEqual([]);
    expect(candidates([workflow, pending], [])).toEqual([]);
  });

  it.each(['failure', 'cancelled', 'timed_out'])('excludes startup-only rollup when another workflow concluded %s', conclusion => {
    const failed = { ...workflow, id: 5061, name: 'Other workflow', path: '.github/workflows/other.yml', conclusion };
    expect(candidates([workflow, failed])).toEqual([]);
    expect(candidates([workflow, failed], [])).toEqual([]);
  });

  it('excludes recovery when additional workflow evidence is unreadable', () => {
    expect(candidates([workflow, {}])).toEqual([]);
  });
});

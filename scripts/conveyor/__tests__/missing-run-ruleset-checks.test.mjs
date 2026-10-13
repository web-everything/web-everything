import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sweepMissingRunRecovery, triggerCiForPr } from '../ci-red-recovery-watch.mjs';
import { buildMissingRunComment } from '../main-red-recovery.mjs';
import { getRequiredStatusChecks } from '../../lib/required-status-checks.mjs';
import { execFileSyncThrottled } from '../../lib/gh-throttle.mjs';

vi.mock('../../lib/required-status-checks.mjs', async (original) => ({
  ...await original(), getRequiredStatusChecks: vi.fn(),
}));
vi.mock('../../lib/gh-throttle.mjs', async (original) => ({
  ...await original(), execFileSyncThrottled: vi.fn(() => { throw new Error('unexpected live read'); }),
}));

const CLASSIC_CONTEXTS = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const ATTRIBUTED_CONTEXTS = [...CLASSIC_CONTEXTS, 'merge-gate'];
const done = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion });
const PR_5060 = {
  number: 5060, headRefName: 'lane/5060', baseRefName: 'main', headRefOid: '9cb7cc0', mergeable: 'MERGEABLE',
  statusCheckRollup: [...CLASSIC_CONTEXTS.map((name) => done(name)), done('review-gate', 'FAILURE')],
};
const REPO = 'web-everything/web-everything';

function sweep({ pr = PR_5060, ...options } = {}) {
  const readAttributedRequiredChecks = Object.hasOwn(options, 'readAttributedRequiredChecks')
    ? options.readAttributedRequiredChecks : vi.fn(() => ATTRIBUTED_CONTEXTS);
  const trigger = vi.fn(() => ({ ok: true, action: 'pull-request-push' }));
  const restack = vi.fn(() => ({ ok: true, action: 'restacked' }));
  const result = sweepMissingRunRecovery({
    repo: REPO, apply: true, mainRuns: [], now: Date.parse('2026-10-13T12:00:00Z'),
    readOpenPrs: () => [pr], readRequiredContexts: () => CLASSIC_CONTEXTS, readAttributedRequiredChecks,
    readHeadCommittedAt: () => '2026-10-12T00:00:00Z', readComments: () => [],
    trigger, restack, postComment: vi.fn(), clearLabel: vi.fn(() => true), ...options,
  });
  return { result, trigger, restack, readAttributedRequiredChecks };
}

describe('missing-run recovery — ruleset-only required checks (live #5060)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['lane/parent', undefined])('does not restack a healthy PR on base %s for a default-base ruleset check', baseRefName => {
    const { result, trigger, restack } = sweep({ pr: { ...PR_5060, baseRefName } });
    expect(result.dispatch).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
    expect(restack).not.toHaveBeenCalled();
  });

  it('honors a custom default branch', () => {
    const { result, trigger } = sweep({ pr: { ...PR_5060, baseRefName: 'trunk' }, defaultBranch: 'trunk' });
    expect(result.dispatch).toHaveLength(1);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('bounds a permanently absent ruleset check across successive head SHAs', () => {
    const comments = [];
    const options = { maxRetriesPerSha: 1, readComments: () => comments,
      postComment: (_, facts) => comments.push({ viewerDidAuthor: true, body: buildMissingRunComment(facts) }) };
    expect(sweep(options).trigger).toHaveBeenCalledTimes(1);
    const { result, trigger } = sweep({ ...options, pr: { ...PR_5060, headRefOid: 'next-head' } });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual([expect.objectContaining({ kind: 'missing-run-pr-cap-exhausted' })]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('does not allow forged comments to consume the PR-wide budget', () => {
    const { trigger } = sweep({ maxRetriesPerSha: 1,
      readComments: () => [{ author: { login: 'untrusted' }, body: buildMissingRunComment({ headSha: 'old-head' }) }] });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('does not refund the PR-wide budget when main becomes green on a different SHA', () => {
    const { result, trigger } = sweep({ maxRetriesPerSha: 1,
      mainRuns: [{ status: 'completed', conclusion: 'success', headSha: 'new-main', updatedAt: '2026-10-13T11:00:00Z' }],
      readComments: () => [{ viewerDidAuthor: true,
        body: buildMissingRunComment({ headSha: 'old-head', mainGreen: { sha: 'old-main', red: false } }) }] });
    expect(result.dispatch).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('retains classic missing-run recovery for genuinely stalled stacks', () => {
    const { result, restack } = sweep({ pr: { ...PR_5060, baseRefName: 'lane/parent', statusCheckRollup: [] } });
    expect(result.dispatch).toHaveLength(1);
    expect(restack).toHaveBeenCalledTimes(1);
  });

  it('refuses a fork at the real push preflight and bounds repeated attempts', () => {
    const sha = 'a'.repeat(40);
    const exec = vi.fn(() => JSON.stringify({ state: 'open', mergeable: true,
      head: { sha, ref: PR_5060.headRefName, repo: { full_name: 'someone/web-everything' } }, base: { ref: 'main' } }));
    const comments = [];
    const options = { pr: { ...PR_5060, headRefOid: sha }, maxRetriesPerSha: 1,
      trigger: (d, opts) => triggerCiForPr(d, { ...opts, exec }), readComments: () => comments,
      postComment: (_, facts) => comments.push({ viewerDidAuthor: true, body: buildMissingRunComment(facts) }) };
    expect(sweep(options).result.applied).toEqual([expect.objectContaining({ ok: false, error: expect.stringContaining('fork') })]);
    expect(sweep(options).result.dispatch).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toBe('gh');
  });

  it('uses the attributed reader by default', () => {
    execFileSyncThrottled.mockReturnValueOnce(JSON.stringify(CLASSIC_CONTEXTS));
    getRequiredStatusChecks.mockReturnValueOnce({ checks: ATTRIBUTED_CONTEXTS });
    const { trigger } = sweep({ readRequiredContexts: undefined, readAttributedRequiredChecks: undefined });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(getRequiredStatusChecks).toHaveBeenCalledWith({ repo: REPO, branch: 'main' });
    expect(execFileSyncThrottled).toHaveBeenCalledTimes(1);
  });

  it('reuses an injected protection reader without live ruleset access', () => {
    const reader = vi.fn(() => CLASSIC_CONTEXTS);
    const { result } = sweep({ readRequiredContexts: reader, readAttributedRequiredChecks: undefined });
    expect(result.dispatch).toEqual([]);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(getRequiredStatusChecks).not.toHaveBeenCalled();
    expect(execFileSyncThrottled).not.toHaveBeenCalled();
  });
  it('triggers #5060 when merge-gate never reported beside completed classic checks', () => {
    const { result, trigger, readAttributedRequiredChecks } = sweep();
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 5060, kind: 'trigger-ci' })]);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 5060, kind: 'trigger-ci' }),
      { repo: REPO, defaultBranch: 'main' });
    expect(readAttributedRequiredChecks).toHaveBeenCalledTimes(1);
    expect(readAttributedRequiredChecks).toHaveBeenCalledWith({ repo: REPO, branch: 'main' });
  });

  it('does not trigger when merge-gate reported a completed failure', () => {
    const { result, trigger } = sweep({
      pr: { ...PR_5060, statusCheckRollup: [...PR_5060.statusCheckRollup, done('merge-gate', 'FAILURE')] },
    });
    expect(result.dispatch).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it.each(['null', 'throws'])('preserves classic-only behavior when the attributed read %s', (mode) => {
    const { result, trigger } = sweep({ readAttributedRequiredChecks: () => {
      if (mode === 'throws') throw new Error('ruleset read unavailable');
      return null;
    } });
    expect(result.dispatch).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('does not trigger a conflicting PR with a missing ruleset check', () => {
    const { result, trigger } = sweep({ pr: { ...PR_5060, mergeable: 'CONFLICTING' } });
    expect(result.dispatch).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { sweepMissingRunRecovery } from '../ci-red-recovery-watch.mjs';

const CLASSIC_CONTEXTS = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const ATTRIBUTED_CONTEXTS = [...CLASSIC_CONTEXTS, 'merge-gate'];
const done = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion });
const PR_5060 = {
  number: 5060, headRefName: 'lane/5060', baseRefName: 'main', headRefOid: '9cb7cc0', mergeable: 'MERGEABLE',
  statusCheckRollup: [...CLASSIC_CONTEXTS.map((name) => done(name)), done('review-gate', 'FAILURE')],
};
const REPO = 'web-everything/web-everything';

function sweep({ pr = PR_5060, readAttributedRequiredChecks = vi.fn(() => ATTRIBUTED_CONTEXTS) } = {}) {
  const trigger = vi.fn(() => ({ ok: true, action: 'pull-request-push' }));
  const result = sweepMissingRunRecovery({
    repo: REPO, apply: true, mainRuns: [], now: Date.parse('2026-10-13T12:00:00Z'),
    readOpenPrs: () => [pr], readRequiredContexts: () => CLASSIC_CONTEXTS, readAttributedRequiredChecks,
    readHeadCommittedAt: () => '2026-10-12T00:00:00Z', readComments: () => [],
    trigger, postComment: vi.fn(), clearLabel: vi.fn(() => true),
  });
  return { result, trigger, readAttributedRequiredChecks };
}

describe('missing-run recovery — ruleset-only required checks (live #5060)', () => {
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

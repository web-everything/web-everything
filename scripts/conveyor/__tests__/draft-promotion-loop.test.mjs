// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runDraftPromotionStep } from '../draft-promotion-loop.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/draft-promotion/pr4567-2026-10-09.json', import.meta.url), 'utf8'));
const draft = fixture.drafts[0];
const check = (name, conclusion = 'success', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });

describe('runDraftPromotionStep — forwards reviewHoldOnly from the fresh head read', () => {
  const run = (fresh) => {
    const ready = vi.fn();
    const clearAwaiting = vi.fn();
    const readHeadCheckState = vi.fn(() => fresh);
    const readPrView = vi.fn(() => ({
      ...draft, baseRefName: 'main', comments: [], isCrossRepository: false,
      mergeStateStatus: 'CLEAN', body: '',
      statusCheckRollup: [check('test'), check('review-gate', 'failure'),
        check('merge-gate', 'failure', { mergeGateReviewHold: { holds: ['review-gate'], jobId: 123 } })],
    }));
    const result = runDraftPromotionStep({
      repos: [fixture.repo], listDrafts: () => [draft], readHeadCheckState, readPrView,
      readAgents: () => [], readClaim: () => null,
      readRequiredChecks: () => ({ checks: ['test', 'review-gate', 'merge-gate'] }),
      // The view carries the planner's existing annotation; no live evidence reads are needed.
      mergeGateSetting: { value: 'off' }, absentNotApplicable: [],
      readMergeGateVerdict: () => { throw new Error('must not read live job evidence'); },
      readFreeze: () => { throw new Error('must not read a live freeze'); },
      ready, clearAwaiting, now: () => Date.parse('2026-10-09T08:00:00Z'),
    });
    return { result, ready, clearAwaiting, readHeadCheckState, readPrView };
  };

  it('owes and performs promotion when fresh red checks explicitly prove reviewHoldOnly', () => {
    const { result, ready, clearAwaiting, readHeadCheckState, readPrView } = run({ state: 'red', reviewHoldOnly: true });
    expect(readHeadCheckState).toHaveBeenCalledTimes(1);
    expect(readHeadCheckState).toHaveBeenCalledWith({ repoSlug: fixture.repo, sha: draft.headRefOid, prNumber: draft.number });
    expect(readPrView).toHaveBeenCalledTimes(1);
    expect(readPrView).toHaveBeenCalledWith({ repoSlug: fixture.repo, prNumber: draft.number });
    expect(result.rows).toEqual([expect.objectContaining({ repo: fixture.repo, pr: draft.number, action: 'promoted' })]);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(fixture.repo, draft.number);
    expect(clearAwaiting).toHaveBeenCalledTimes(1);
    expect(clearAwaiting).toHaveBeenCalledWith(fixture.repo, draft.number);
  });

  it.each([
    ['absent', {}],
    ['false', { reviewHoldOnly: false }],
    ['null', { reviewHoldOnly: null }],
    ['a truthy string', { reviewHoldOnly: 'true' }],
  ])('does not owe promotion for fresh red checks when reviewHoldOnly is %s', (_, extra) => {
    const { result, ready, clearAwaiting, readPrView } = run({ state: 'red', ...extra });
    expect(result.rows).toEqual([expect.objectContaining({
      repo: fixture.repo, pr: draft.number, action: 'skip', why: expect.stringContaining('required checks read red'),
    })]);
    expect(readPrView).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(clearAwaiting).not.toHaveBeenCalled();
  });

  it.each(['pending', 'unchecked', undefined])('still refuses %s evidence even with reviewHoldOnly true', state => {
    const { result, ready, readPrView } = run({ state, reviewHoldOnly: true });
    expect(result.rows).toEqual([expect.objectContaining({ action: 'skip' })]);
    expect(readPrView).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runDraftPromotionStep, runDraftPromotionIfDue, formatDraftPromotionLines } from '../draft-promotion-loop.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/draft-promotion/pr4567-2026-10-09.json', import.meta.url), 'utf8'));
const draft = fixture.drafts[0];
const check = (name, conclusion = 'success', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });

describe('runDraftPromotionStep — forwards reviewHoldOnly from the fresh head read', () => {
  const run = (fresh, view = {}) => {
    const ready = vi.fn();
    const clearAwaiting = vi.fn();
    const readHeadCheckState = vi.fn(() => fresh);
    const readPrView = vi.fn(() => ({
      ...draft, baseRefName: 'main', comments: [], isCrossRepository: false,
      mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', body: '', ...view,
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
    [{ mergeable: 'MERGEABLE', labels: [] }, 'awaiting-ci-trigger', /missing-run recovery/],
    [{ mergeable: 'CONFLICTING', labels: [] }, 'ci-blocked-by-conflict', /until rebased/],
    [{ mergeable: 'MERGEABLE', labels: [{ name: 'status:conflict' }] }, 'ci-blocked-by-conflict', /until rebased/],
    [{ mergeable: 'MERGEABLE', labels: ['merge-status:conflicting'] }, 'ci-blocked-by-conflict', /until rebased/],
  ])('types unchecked skips from the fresh view: %j', (view, reason, explanation) => {
    const { result, ready, readPrView } = run({ state: 'unchecked' }, view);
    expect(readPrView).toHaveBeenCalledTimes(1);
    expect(result.rows[0]).toMatchObject({ action: 'skip', reason, why: expect.stringMatching(explanation) });
    expect(formatDraftPromotionLines(result)[0]).toContain(`— ${reason}:`);
    expect(ready).not.toHaveBeenCalled();
  });

  it('fails closed when the unchecked PR view is unreadable', () => {
    const ready = vi.fn();
    const result = runDraftPromotionStep({
      repos: [fixture.repo], listDrafts: () => [draft], absentNotApplicable: [],
      readHeadCheckState: () => ({ state: 'unchecked' }),
      readPrView: () => { throw new Error('unreadable PR view'); }, ready,
    });
    expect(result.rows).toEqual([expect.objectContaining({ action: 'error', why: 'pr view: unreadable PR view' })]);
    expect(ready).not.toHaveBeenCalled();
  });

  it('fails closed when the unchecked head moves during the fresh view read', () => {
    const { result, ready } = run({ state: 'unchecked' }, { headRefOid: 'b'.repeat(40) });
    expect(result.rows[0]).toMatchObject({ action: 'skip', why: expect.stringContaining('head moved') });
    expect(ready).not.toHaveBeenCalled();
  });

  it('re-logs a changed typed reason and dedups an unchanged reason', () => {
    const write = vi.fn();
    const invoke = (reason, now, previous = {}) => runDraftPromotionIfDue({ ...previous, write,
      now: () => now, resolveSettings: () => ({ loop: true, intervalSeconds: 60 }),
      step: () => ({ rows: [{ repo: fixture.repo, pr: draft.number, action: 'skip', why: 'no checks', reason }] }),
    });
    let state = invoke('awaiting-ci-trigger', 0);
    state = invoke('awaiting-ci-trigger', 60_000, state);
    expect(write).toHaveBeenCalledTimes(1);
    invoke('ci-blocked-by-conflict', 120_000, state);
    expect(write).toHaveBeenCalledTimes(2);
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
    expect(readPrView).toHaveBeenCalledTimes(state === 'unchecked' ? 1 : 0);
    expect(ready).not.toHaveBeenCalled();
  });
});

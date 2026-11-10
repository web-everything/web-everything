// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runDraftPromotionStep, runDraftPromotionIfDue } from '../draft-promotion-loop.mjs';
import { DRAFT_PROMOTION_DEFAULTS, resolveDraftPromotionSettings } from '../draft-promotion-rule.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/draft-promotion/pr4567-2026-10-09.json', import.meta.url), 'utf8'));
const draft = fixture.drafts[0];
const check = (name, conclusion = 'success', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });

describe('draft promotion requests a review wake only after promotion', () => {
  const setup = (overrides = {}) => {
    const touchWake = vi.fn(() => true);
    const ready = vi.fn();
    const drafts = [draft];
    const options = {
      repos: [fixture.repo], listDrafts: () => drafts,
      readHeadCheckState: () => ({ state: 'green' }),
      readPrView: ({ prNumber }) => ({
        ...drafts.find(pr => pr.number === prNumber), baseRefName: 'main', comments: [],
        isCrossRepository: false, mergeStateStatus: 'CLEAN', body: '',
        statusCheckRollup: [check('test')],
      }),
      readAgents: () => [], readClaim: () => null,
      readRequiredChecks: () => ({ checks: ['test'] }),
      mergeGateSetting: { value: 'off' }, absentNotApplicable: [],
      readFreeze: () => { throw new Error('unexpected live freeze read'); },
      readMergeGateVerdict: () => { throw new Error('unexpected live job read'); },
      ready, clearAwaiting: vi.fn(), touchWake,
      now: () => Date.parse('2026-10-09T08:00:00Z'), ...overrides,
    };
    return { options, drafts, ready, touchWake };
  };

  it('requests one review wake after a green draft is promoted', () => {
    const { options, ready, touchWake } = setup();
    touchWake.mockImplementation(() => {
      expect(ready).toHaveBeenCalledTimes(1);
      return true;
    });
    expect(runDraftPromotionStep(options).rows).toEqual([
      expect.objectContaining({ action: 'promoted', pr: draft.number }),
    ]);
    expect(touchWake).toHaveBeenCalledTimes(1);
  });

  it.each(['red', 'pending', 'unchecked'])('does not wake review for %s checks', state => {
    const { options, ready, touchWake } = setup({ readHeadCheckState: () => ({ state }) });
    expect(runDraftPromotionStep(options).rows).toEqual([expect.objectContaining({ action: 'skip' })]);
    expect(ready).not.toHaveBeenCalled();
    expect(touchWake).not.toHaveBeenCalled();
  });

  it('does not wake review when a fresh head change skips a green draft', () => {
    const { options, ready, touchWake } = setup({ readPrView: () => ({ ...draft, headRefOid: 'new-head' }) });
    expect(runDraftPromotionStep(options).rows).toEqual([expect.objectContaining({ action: 'skip' })]);
    expect(ready).not.toHaveBeenCalled();
    expect(touchWake).not.toHaveBeenCalled();
  });

  it.each(['check read', 'ready write'])('fails closed without a wake after a failed %s', failure => {
    const { options, ready, touchWake } = setup();
    if (failure === 'check read') options.readHeadCheckState = () => { throw new Error('unreadable checks'); };
    else ready.mockImplementation(() => { throw new Error('ready refused'); });
    expect(runDraftPromotionStep(options).rows).toEqual([expect.objectContaining({ action: 'error' })]);
    if (failure === 'check read') expect(ready).not.toHaveBeenCalled();
    expect(touchWake).not.toHaveBeenCalled();
  });

  it('touches once for two promoted rows in one step', () => {
    const { options, drafts, ready, touchWake } = setup();
    drafts.push({ ...draft, number: draft.number + 1 });
    expect(runDraftPromotionStep(options).rows.map(row => row.action)).toEqual(['promoted', 'promoted']);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(touchWake).toHaveBeenCalledTimes(1);
  });

  it.each(['false', 'throw'])('keeps a successful promotion when the wake fails: %s', failure => {
    const { options, ready, touchWake } = setup();
    touchWake.mockImplementation(() => {
      if (failure === 'throw') throw new Error('wake directory unwritable');
      return false;
    });
    expect(runDraftPromotionStep(options).rows).toEqual([expect.objectContaining({ action: 'promoted' })]);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(touchWake).toHaveBeenCalledTimes(1);
  });

  it.each(['promoted', 'skip', 'error'])('due hook requests a wake only for promoted rows: %s', action => {
    const touchWake = vi.fn(() => true);
    const result = runDraftPromotionIfDue({
      resolveSettings: () => ({ loop: true, intervalSeconds: 60 }), now: () => 100_000,
      step: () => ({ rows: [{ repo: fixture.repo, pr: draft.number, action, why: 'fixture' }] }),
      write: vi.fn(), touchWake,
    });
    expect(result.ran).toBe(true);
    expect(result.result.rows[0].action).toBe(action);
    expect(touchWake).toHaveBeenCalledTimes(action === 'promoted' ? 1 : 0);
  });

  it('due hook keeps a successful step when requesting its wake throws', () => {
    const touchWake = vi.fn(() => { throw new Error('wake unavailable'); });
    const result = runDraftPromotionIfDue({
      resolveSettings: () => ({ loop: true, intervalSeconds: 60 }), now: () => 100_000,
      step: () => ({ rows: [{ repo: fixture.repo, pr: draft.number, action: 'promoted', why: 'green' }] }),
      write: vi.fn(), touchWake,
    });
    expect(result.ran).toBe(true);
    expect(result.result.rows[0].action).toBe('promoted');
    expect(touchWake).toHaveBeenCalledTimes(1);
  });

  it('due hook and real step together request only one wake for two promotions', () => {
    const { options, drafts, touchWake } = setup();
    drafts.push({ ...draft, number: draft.number + 1 });
    const result = runDraftPromotionIfDue({
      resolveSettings: () => ({ loop: true, intervalSeconds: 60 }), now: options.now,
      step: (deps = {}) => runDraftPromotionStep({ ...options, ...deps }),
      write: vi.fn(), touchWake,
    });
    expect(result.result.rows.map(row => row.action)).toEqual(['promoted', 'promoted']);
    expect(touchWake).toHaveBeenCalledTimes(1);
  });
});

describe('draft promotion latency settings guard', () => {
  it('keeps the default interval within one minute', () => {
    expect(DRAFT_PROMOTION_DEFAULTS.intervalSeconds).toBeGreaterThan(0);
    expect(DRAFT_PROMOTION_DEFAULTS.intervalSeconds).toBeLessThanOrEqual(60);
  });

  it('ships an enabled loop whose resolved interval is within five minutes', () => {
    const shipped = JSON.parse(readFileSync(new URL('../draft-promotion-settings.json', import.meta.url), 'utf8'));
    expect(shipped.draftPromotion.loop).toBe('on');
    expect(shipped.draftPromotion.intervalSeconds).toBeGreaterThan(0);
    expect(shipped.draftPromotion.intervalSeconds).toBeLessThanOrEqual(300);
    const resolved = resolveDraftPromotionSettings({}, { read: () => JSON.stringify(shipped) });
    expect(resolved.loop).toBe(true);
    expect(resolved.intervalSeconds).toBeGreaterThan(0);
    expect(resolved.intervalSeconds).toBeLessThanOrEqual(300);
  });
});

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
      ready, clearAwaiting, touchWake: vi.fn(() => true), now: () => Date.parse('2026-10-09T08:00:00Z'),
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

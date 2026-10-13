// Replay live #5060 (2026-10-13) without GitHub reads or writes.
import { describe, it, expect, vi } from 'vitest';
import { promotionRequiredChecks, loadPromotionRequiredChecksSetting } from '../promotion-required-checks.mjs';
import { runDraftPromotionStep } from '../../conveyor/draft-promotion-loop.mjs';
import { defaultReadHeadCheckState } from '../../operations/promote-draft-pr-dispatch.mjs';

const required = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'];
const green = required.slice(0, -1).map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }));
const rollup = [...green, { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }];
const load = (over = {}) => loadPromotionRequiredChecksSetting({ env: {}, readFile: () => '{}',
  readDeclared: () => ({ settings: {} }), log: () => {}, ...over });

describe('promotion required checks', () => {
  it('drops only listed absent checks', () => {
    expect(promotionRequiredChecks(required, rollup, ['merge-gate'])).toEqual(required.slice(0, -1));
    expect(promotionRequiredChecks(required, [], ['merge-gate'])).toContain('test');
  });
  it.each([
    { name: 'merge-gate', conclusion: 'FAILURE', status: 'COMPLETED' },
    { name: 'merge-gate', status: 'IN_PROGRESS' },
    { context: 'merge-gate', state: 'PENDING' },
    { name: 'merge-gate', conclusion: 'CANCELLED' },
    { name: 'merge-gate', conclusion: 'SUCCESS' },
  ])('keeps any existing row: %j', row => {
    expect(promotionRequiredChecks(required, [...rollup, row], ['merge-gate'])).toEqual(required);
  });
  it('fails closed when filtering would empty the list', () => {
    const only = ['merge-gate'];
    expect(promotionRequiredChecks(only, [], only)).toBe(only);
  });
  it.each([undefined, null, [], 'invalid'])('preserves invalid or empty inputs: %j', value => {
    expect(promotionRequiredChecks(value, rollup, ['merge-gate'])).toBe(value);
    expect(promotionRequiredChecks(required, value, ['merge-gate'])).toEqual(Array.isArray(value) ? required.slice(0, -1) : required);
    expect(promotionRequiredChecks(required, rollup, value)).toBe(required);
  });
});

describe('setting cascade', () => {
  it('logs the resolved setting and ignored source once per process', async () => {
    vi.resetModules();
    const { loadPromotionRequiredChecksSetting: freshLoad } = await import('../promotion-required-checks.mjs');
    const log = vi.fn();
    const options = { env: { WE_DRAFT_PROMOTION_ABSENT_NOT_APPLICABLE: 42 }, readFile: () => '{}',
      readDeclared: () => ({ settings: {} }), log };
    freshLoad(options);
    freshLoad(options);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'draft-promotion · draftPromotion.absentRequiredChecksNotApplicable=["merge-gate"] (source: standard)',
      expect.stringContaining('ignored env:'),
    ]);
  });
  it('uses the standard default', () => expect(load()).toMatchObject({ value: ['merge-gate'], source: 'standard' }));
  it('uses platform preferences then repo settings', () => {
    const readFile = () => JSON.stringify({ draftPromotion: { absentRequiredChecksNotApplicable: ['platform-check'] } });
    expect(load({ readFile })).toMatchObject({ value: ['platform-check'], source: 'platform' });
    expect(load({ readFile, readDeclared: () => ({ settings: { draftPromotion: { absentRequiredChecksNotApplicable: [] } } }) }))
      .toMatchObject({ value: [], source: 'repo' });
  });
  it('allows env override and explicit empty env', () => {
    expect(load({ env: { WE_DRAFT_PROMOTION_ABSENT_NOT_APPLICABLE: 'merge-gate, smoke' } })).toMatchObject({ value: ['merge-gate', 'smoke'], source: 'env' });
    expect(load({ env: { WE_DRAFT_PROMOTION_ABSENT_NOT_APPLICABLE: '' } })).toMatchObject({ value: [], source: 'env' });
  });
  it('ignores invalid env and reports its source', () => {
    expect(load({ env: { WE_DRAFT_PROMOTION_ABSENT_NOT_APPLICABLE: 42 },
      readDeclared: () => ({ settings: { draftPromotion: { absentRequiredChecksNotApplicable: ['repo-check'] } } }) }))
      .toMatchObject({ value: ['repo-check'], source: 'repo', ignored: [expect.objectContaining({ source: 'env' })] });
  });
  it('ignores invalid platform and repo layers', () => {
    expect(load({ readFile: () => '{"draftPromotion":null}', readDeclared: () => ({ settings: { draftPromotion: { absentRequiredChecksNotApplicable: 'bad' } } }) }))
      .toMatchObject({ value: ['merge-gate'], source: 'standard', ignored: [expect.objectContaining({ source: 'platform' }), expect.objectContaining({ source: 'repo' })] });
  });
});

describe('live #5060 promotion', () => {
  const reader = (rows, options = {}) => defaultReadHeadCheckState({ repoSlug: 'web-everything/web-everything', sha: 'a'.repeat(40),
    runGh: () => rows.map(row => JSON.stringify(row)).join('\n'), getRequiredChecks: () => ({ checks: required }),
    mergeGateSetting: { value: 'off' }, ...options });
  it('changes only the promotion head read', () => {
    expect(reader(rollup).state).toBe('unchecked');
    expect(reader(rollup, { forPromotion: true, absentNotApplicable: ['merge-gate'] }).state).toBe('green');
  });
  it.each([
    ['absent', rollup, ['merge-gate'], true],
    ['failure', [...rollup, { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE' }], ['merge-gate'], false],
    ['pending', [...rollup, { name: 'merge-gate', status: 'IN_PROGRESS' }], ['merge-gate'], false],
    ['disabled', rollup, [], false],
  ])('%s merge-gate: promotion=%s', (_name, rows, absentNotApplicable, promoted) => {
    const pr = { number: 5060, state: 'OPEN', isDraft: true, headRefName: 'lane/live-5060', baseRefName: 'main',
      headRefOid: 'a'.repeat(40), labels: [], comments: [], body: '', isCrossRepository: false, statusCheckRollup: rows };
    const ready = vi.fn();
    const result = runDraftPromotionStep({ repos: ['web-everything/web-everything'], listDrafts: () => [pr],
      readHeadCheckState: args => reader(rows, { ...args, forPromotion: true, absentNotApplicable }), readPrView: () => pr, readAgents: () => [], readClaim: () => null,
      readRequiredChecks: () => ({ checks: required }), ready, clearAwaiting: () => {}, absentNotApplicable, mergeGateSetting: { value: 'off' } });
    expect(ready).toHaveBeenCalledTimes(promoted ? 1 : 0);
    expect(result.rows[0].action).toBe(promoted ? 'promoted' : 'skip');
  });
  it('keeps the injected reader call shape unchanged', () => {
    const pr = { number: 5060, state: 'OPEN', isDraft: true, headRefName: 'lane/live-5060', baseRefName: 'main',
      headRefOid: 'a'.repeat(40), labels: [], isCrossRepository: false };
    const readHeadCheckState = vi.fn(() => ({ state: 'unchecked' }));
    runDraftPromotionStep({ repos: ['web-everything/web-everything'], listDrafts: () => [pr],
      readHeadCheckState, absentNotApplicable: ['merge-gate'] });
    expect(readHeadCheckState.mock.calls).toEqual([[{
      repoSlug: 'web-everything/web-everything', sha: pr.headRefOid, prNumber: 5060,
    }]]);
  });
  it('resolves settings only at the first candidate check read and respects explicit values', async () => {
    const settings = await import('../promotion-required-checks.mjs');
    const { runDraftPromotionStep: step } = await import('../../conveyor/draft-promotion-loop.mjs');
    const loadSetting = vi.spyOn(settings, 'loadPromotionRequiredChecksSetting').mockReturnValue({ value: ['merge-gate'] });
    try {
      const pr = { number: 5060, state: 'OPEN', isDraft: true, headRefName: 'lane/live-5060', baseRefName: 'main',
        headRefOid: 'a'.repeat(40), labels: [], isCrossRepository: false };
      const readHeadCheckState = vi.fn(() => {
        expect(loadSetting).toHaveBeenCalledTimes(1);
        return { state: 'unchecked' };
      });
      const options = { repos: ['web-everything/web-everything'], readHeadCheckState };
      step({ ...options, listDrafts: () => [] });
      step({ ...options, listDrafts: () => [{ ...pr, isDraft: false }] });
      expect(loadSetting).not.toHaveBeenCalled();
      step({ ...options, listDrafts: () => [pr, { ...pr, number: 5061 }] });
      expect(readHeadCheckState).toHaveBeenCalledTimes(2);
      expect(loadSetting).toHaveBeenCalledTimes(1);
      loadSetting.mockClear();
      step({ ...options, listDrafts: () => [pr], readHeadCheckState: () => ({ state: 'unchecked' }) });
      expect(loadSetting).toHaveBeenCalledTimes(1);
      loadSetting.mockClear();
      step({ ...options, listDrafts: () => [pr], readHeadCheckState: () => ({ state: 'unchecked' }), absentNotApplicable: [] });
      expect(loadSetting).not.toHaveBeenCalled();
    } finally { loadSetting.mockRestore(); }
  });
});

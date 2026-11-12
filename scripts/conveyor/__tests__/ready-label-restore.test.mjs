import { describe, expect, it, vi } from 'vitest';
import { planReadyRestore, sweepReadyRestore } from '../ready-label-restore.mjs';
import { sweepReviewHoldLabels } from '../review-hold-reconcile.mjs';

const live = (extra = {}) => ({
  number: 7, state: 'OPEN', isDraft: false, headRefOid: 'a'.repeat(40),
  labels: ['review:accepted', 'red-team:clear'],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  ...extra,
});
const fixture = (extra = {}) => {
  const provider = { readPrState: vi.fn(() => live()), setLabels: vi.fn() };
  const readPr = vi.fn(() => live());
  return { repo: 'o/r', prs: [live()], provider, readPr, log: vi.fn(), ...extra };
};

describe('planReadyRestore', () => {
  it('restores accepted + clear + green without a ready label', () => {
    expect(planReadyRestore(live())).toEqual({ restore: true });
  });
  it.each(['review:pending', 'review:human', 'review:changes', 'review:held-mechanical',
    'review:awaiting-advisory', 'review:future-hold', 'red-team:pending', 'red-team:blocked', 'ready-to-merge'])(
    'refuses %s', (label) => {
      expect(planReadyRestore(live({ labels: [...live().labels, { name: label }] })))
        .toEqual({ restore: false, reason: expect.any(String) });
    });
  it.each([
    ['red CI', { statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] }],
    ['missing CI', { statusCheckRollup: [] }],
    ['missing red-team clear', { labels: ['review:accepted'] }],
    ['missing acceptance', { labels: ['red-team:clear'] }],
    ['draft', { isDraft: true }],
    ['unknown draft state', { isDraft: undefined }],
    ['closed', { state: 'CLOSED' }],
    ['unreadable labels', { labels: null }],
    ['missing head', { headRefOid: undefined }],
  ])('refuses %s', (_name, extra) => {
    expect(planReadyRestore(live(extra))).toEqual({ restore: false, reason: expect.any(String) });
  });
  it('refuses an absent state (fails closed)', () => {
    expect(planReadyRestore(live({ state: undefined })).restore).toBe(false);
  });
  it('uses the configured required check', () => {
    expect(planReadyRestore(live({ statusCheckRollup: [{ name: 'build', conclusion: 'SUCCESS' }] }),
      { requiredCheck: 'build' })).toEqual({ restore: true });
  });
});

describe('sweepReadyRestore', () => {
  it('reads a candidate live and adds through the provider after checking the head', () => {
    const f = fixture();
    expect(sweepReadyRestore(f)).toEqual([{ num: 7, readyRestore: 'restored', detail: expect.any(String) }]);
    expect(f.readPr).toHaveBeenCalledTimes(2);
    expect(f.readPr).toHaveBeenCalledWith('o/r', 7);
    expect(f.provider.setLabels).toHaveBeenCalledTimes(1);
    expect(f.provider.setLabels).toHaveBeenCalledWith('o/r', 7, { add: 'ready-to-merge' });
  });
  it('prefilters listed labels without any live reads', () => {
    const f = fixture({ prs: [live({ labels: ['review:accepted'] }), live({ labels: [...live().labels, 'ready-to-merge'] })] });
    expect(sweepReadyRestore(f)).toEqual([]);
    expect(f.readPr).not.toHaveBeenCalled();
    expect(f.provider.readPrState).not.toHaveBeenCalled();
  });
  it('replans on live labels rather than the listing', () => {
    const f = fixture({ readPr: () => live({ labels: [...live().labels, 'review:changes'] }) });
    expect(sweepReadyRestore(f)[0].readyRestore).toBe('skip');
    expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it.each(['b'.repeat(40), undefined])('refuses a moved or unreadable final head (%s)', (headRefOid) => {
    const f = fixture();
    f.readPr.mockReturnValueOnce(live()).mockReturnValueOnce(live({ headRefOid }));
    expect(sweepReadyRestore(f)[0].readyRestore).toBe('skip');
    expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it('refuses a required check that went red at the final read (same head)', () => {
    const f = fixture();
    f.readPr.mockReturnValueOnce(live()).mockReturnValueOnce(live({ statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }));
    expect(sweepReadyRestore(f)[0].readyRestore).toBe('skip');
    expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it('refuses a hold added at the final read', () => {
    const f = fixture();
    f.readPr.mockReturnValueOnce(live()).mockReturnValueOnce(live({ labels: [...live().labels, 'review:human'] }));
    expect(sweepReadyRestore(f)[0].readyRestore).toBe('skip');
    expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it('dry-run writes nothing', () => {
    const f = fixture({ dryRun: true });
    expect(sweepReadyRestore(f)[0].readyRestore).toBe('would-restore');
    expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it.each(['read', 'head', 'write'])('contains a %s error per PR and continues', (phase) => {
    const f = fixture({ prs: [live(), live({ number: 8 })] });
    const fail = () => { throw new Error('unavailable'); };
    if (phase === 'read') f.readPr.mockImplementationOnce(fail);
    if (phase === 'head') f.readPr.mockReturnValueOnce(live()).mockImplementationOnce(fail);
    if (phase === 'write') f.provider.setLabels.mockImplementationOnce(fail);
    expect(sweepReadyRestore(f).map(r => r.readyRestore)).toEqual(['skip', 'restored']);
  });
});

describe('review-hold wiring', () => {
  const run = (extra = {}) => sweepReviewHoldLabels({
    repo: 'o/r', listPrs: () => [live()], provider: fixture().provider,
    readPr: () => ({ ...live(), labels: [], comments: [] }),
    readComments: () => [], numberingRestamp: () => null,
    settings: { referralDefault: 'operator' }, log: vi.fn(), ...extra,
  });
  it('composes the injected restore with the shared listing and dryRun', () => {
    const f = fixture();
    const readyRestore = vi.fn(opts => sweepReadyRestore({ ...opts, readPr: f.readPr }));
    const rows = run({ provider: f.provider, readyRestore, dryRun: true });
    expect(readyRestore).toHaveBeenCalledTimes(1);
    expect(readyRestore).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'o/r', prs: [live()], provider: f.provider, dryRun: true,
    }));
    expect(rows).toContainEqual({ num: 7, readyRestore: 'would-restore', detail: expect.any(String) });
    expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it('skips the default restore for an injected listing', () => {
    const f = fixture();
    expect(run({ provider: f.provider }).some(r => r.readyRestore)).toBe(false);
    expect(f.provider.readPrState).not.toHaveBeenCalled();
  });
  it('contains a throwing restore seam', () => {
    expect(run({ readyRestore: () => { throw new Error('unavailable'); } }))
      .toContainEqual({ num: 0, readyRestore: 'skip', detail: 'unavailable' });
  });
});

describe('capped rollup evidence', () => {
  it('refuses when the rollup is capped at 100 contexts', async () => {
    const { planReadyRestore } = await import('../ready-label-restore.mjs');
    const rollup = Array.from({ length: 100 }, (_, i) => ({ __typename: 'CheckRun', name: i ? `c${i}` : 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }));
    const pr = { state: 'OPEN', isDraft: false, headRefOid: 'a', labels: [{ name: 'review:accepted' }, { name: 'red-team:clear' }], statusCheckRollup: rollup };
    expect(planReadyRestore(pr).restore).toBe(false);
  });
});

// card 302 — red-main repairs get capacity while ordinary fixes wait.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as settings from '../../lib/settings-files.mjs';
import { resolveMainFixCapacity, runReconcileFixDispatch } from '../reconcile-fix-dispatch.mjs';

const MAIN_PR = 5269;
const ordinary = { kind: 'fix', prNumber: 5268, headRefName: 'lane/304-ordinary' };
const main = { kind: 'fix', prNumber: MAIN_PR, headRefName: 'lane/302-red-main', mainFix: true };
const refusal = (kind = 'fix-cap') => ({ admit: false, kind, why: 'all slots occupied' });

function run(entries = [ordinary, main], extra = {}) {
  const dispatch = vi.fn((entry) => ({ pr: entry.pr, lane: entry.lane }));
  const borrowGate = { consider: vi.fn(() => ({ borrow: false, why: 'borrow-off' })), clear: vi.fn() };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = runReconcileFixDispatch({
    root: '.', repo: 'we', checkStaleness: () => ({ fresh: true, behind: 0 }),
    reconcile: () => ({ dispatch: entries, refusals: [] }),
    findItemFn: key => ({ num: key, scope: [`we:scripts/${key}.mjs`] }),
    fetchItemlessDiffPaths: () => [], resolveFallbackScope: () => [],
    loadItems: () => [], pickFreeLanes: () => [3], listBuildClaims: () => [], listFixClaims: () => [],
    dispatch, borrowGate, priorityShadow: null, readMainRedPriorityRecord: () => null,
    dispatchThrottle: { tryAdmit: vi.fn(() => refusal()) }, ...extra,
  });
  return { result, dispatch, borrowGate, log };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('main-fix capacity, card 302', () => {
  it('admits the main fix past a full cap without borrowing and refuses an ordinary fix', () => {
    const { result, dispatch, borrowGate, log } = run();
    expect(result.dispatched).toEqual([{ pr: MAIN_PR, lane: 3 }]);
    expect(result.refusals).toEqual([{ pr: ordinary.prNumber, kind: 'fix-cap', why: 'all slots occupied' }]);
    expect(dispatch.mock.calls[0][1]).not.toHaveProperty('borrowed');
    expect(borrowGate.consider).toHaveBeenCalledTimes(1);
    expect(borrowGate.consider).toHaveBeenCalledWith({ repo: 'we', pr: ordinary.prNumber });
    expect(log.mock.calls.filter(([line]) => line.includes('red-main fix admitted past'))).toEqual([
      ['reconcile-fix-dispatch: PR #5269 red-main fix admitted past the fixer cap (all slots occupied) — mainFixCapacity.pastFixCap=true (source tool)'],
    ]);
  });

  it('recognizes the published rank-0 owner even without mainFix', () => {
    const { mainFix, ...unmarked } = main;
    const { result } = run([unmarked], { readMainRedPriorityRecord: () => ({ repo: 'we', pr: MAIN_PR, expiresAt: Date.now() + 60000 }) });
    expect(result.dispatched).toEqual([{ pr: MAIN_PR, lane: 3 }]);
  });

  it.each([
    { repo: 'we', pr: MAIN_PR, expiresAt: 0 },
    { repo: 'frontierui', pr: MAIN_PR, expiresAt: Date.now() + 60000 },
  ])('refuses an expired or foreign priority record: %j', record => {
    const { mainFix, ...unmarked } = main;
    const { result } = run([unmarked], { readMainRedPriorityRecord: () => record });
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toEqual([{ pr: MAIN_PR, kind: 'fix-cap', why: 'all slots occupied' }]);
  });

  it.each(['host-load', 'other-refusal'])('keeps refusing the main fix for %s', kind => {
    const { result, dispatch, borrowGate } = run([main], { dispatchThrottle: { tryAdmit: () => refusal(kind) } });
    expect(result.refusals).toEqual([{ pr: MAIN_PR, kind, why: 'all slots occupied' }]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(borrowGate.consider).not.toHaveBeenCalled();
  });

  it('env off preserves the cap refusal', () => {
    vi.stubEnv('WE_MAIN_FIX_PAST_FIX_CAP', 'off');
    const { result, dispatch } = run([main]);
    expect(result.refusals).toEqual([{ pr: MAIN_PR, kind: 'fix-cap', why: 'all slots occupied' }]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('gives the main fix the single free lane ahead of an ordinary fix', () => {
    const { result } = run([ordinary, main], { dispatchThrottle: { tryAdmit: () => ({ admit: true }) } });
    expect(result.dispatched).toEqual([{ pr: MAIN_PR, lane: 3 }]);
    expect(result.refusals).toEqual([{ pr: ordinary.prNumber, kind: 'no-lane', why: expect.stringContaining('no free lane') }]);
  });

  it('does not bypass the heavy queue cap', () => {
    const { result, dispatch } = run([main], {
      queueAdmission: { tryAdmit: () => ({ admit: false, why: 'queue full' }) },
      readPrComments: () => [], postQueueCapComment: vi.fn(), notifyQueueCapOperator: vi.fn(),
    });
    expect(result.refusals[0]).toMatchObject({ pr: MAIN_PR, kind: 'queue-cap' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('resolveMainFixCapacity sources, card 302', () => {
  const env = { WE_PLATFORM_PREFERENCES_FILE: 'missing-card-302-platform.json' };
  it('uses the standard when no tool value exists', () => {
    vi.spyOn(settings, 'readDeclaredSettings').mockReturnValue({ settings: {} });
    expect(resolveMainFixCapacity(env)).toEqual({ pastFixCap: true, source: 'standard' });
  });
  it('reads the declared tool setting', () => {
    expect(settings.readDeclaredSettings().settings.mainFixCapacity).toEqual({ pastFixCap: true });
    expect(resolveMainFixCapacity(env)).toEqual({ pastFixCap: true, source: 'tool' });
    vi.spyOn(settings, 'readDeclaredSettings').mockReturnValue({ settings: { mainFixCapacity: { pastFixCap: false } } });
    expect(resolveMainFixCapacity(env)).toEqual({ pastFixCap: false, source: 'tool' });
  });
  it.each([['on', true], ['true', true], ['1', true], ['off', false], ['false', false], ['0', false]])('env %s wins', (value, expected) => {
    expect(resolveMainFixCapacity({ ...env, WE_MAIN_FIX_PAST_FIX_CAP: value })).toEqual({ pastFixCap: expected, source: 'env' });
  });
  it('ignores invalid values and never throws on a failed settings read', () => {
    vi.spyOn(settings, 'readDeclaredSettings').mockReturnValue({ settings: { mainFixCapacity: { pastFixCap: 'off' } } });
    expect(resolveMainFixCapacity({ ...env, WE_MAIN_FIX_PAST_FIX_CAP: 'invalid' })).toEqual({ pastFixCap: true, source: 'standard' });
    settings.readDeclaredSettings.mockImplementation(() => { throw new Error('unreadable'); });
    expect(resolveMainFixCapacity(env)).toEqual({ pastFixCap: true, source: 'standard' });
  });
});

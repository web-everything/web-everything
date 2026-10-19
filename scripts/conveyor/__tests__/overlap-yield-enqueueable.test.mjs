import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOverlapRows } from '../../merge-ai-prs.mjs';
import { computeOverlapContext, overlapRowKey, overlapYieldWaits } from '../land-overlap-yield.mjs';

const repo = 'web-everything/web-everything';
const settingEnv = 'WE_DRAIN_OVERLAP_YIELD_ONLY_TO_ENQUEUEABLE';
const load = () => import('../overlap-yield-enqueueable.mjs');
const raw = (number, additions) => ({ number, baseRefName: 'main', labels: ['review:accepted'],
  files: [{ path: 'scripts/merge-ai-prs.mjs', additions, deletions: 0 }] });
function fixture(decision = 'skip', reason = 'red-team-pending') {
  const verdicts = [{ num: 5482, repo: null, decision: 'merge' }, { num: 5461, repo, decision, reason }];
  const openPrContext = { prsByRepo: new Map([[null, [raw(5482, 1), raw(5461, 100)]]]) };
  return { candidates: verdicts, verdicts, openPrContext, localSlug: repo };
}
function waits(rows) {
  return overlapYieldWaits({ candidates: rows.candidateRows, openPrs: rows.openPrRows, nowMs: 0, ignoreBudget: true });
}

afterEach(() => vi.unstubAllEnvs());

describe('enqueueable overlap targets through buildOverlapRows', () => {
  it.each([
    ['skip', 'red-team-pending'], ['skip', 'carry-refused'], ['skip', 'checks-pending'],
    ['park', 'parked'], ['skip', 'unrecognized-reason'],
  ])('does not defer to a held PR (%s: %s), preserving its verdict', (decision, reason) => {
    vi.stubEnv(settingEnv, '1');
    const input = fixture(decision, reason);
    const before = structuredClone(input.verdicts);
    const rows = buildOverlapRows(input);
    expect(waits(rows).size).toBe(0);
    expect(rows.candidateRows.map((r) => r.number)).toEqual([5482]);
    expect(input.verdicts).toEqual(before);
    expect(input.verdicts[1].decision).toBe(decision);
    // The real context's trial must also short-circuit without label-time/network reads.
    const ghExec = vi.fn(() => { throw new Error('unexpected fetch'); });
    expect(computeOverlapContext({ ...rows, nowMs: 0, ghExec, overrides: { enable: true } }).waits.size).toBe(0);
    expect(ghExec).not.toHaveBeenCalled();
  });

  it('still defers to a merge verdict', () => {
    vi.stubEnv(settingEnv, '1');
    expect(waits(buildOverlapRows(fixture('merge'))).get(`${repo}#5482`).yieldTo).toBe(5461);
  });

  it('OFF restores the old wait for a held target', () => {
    vi.stubEnv(settingEnv, '0');
    expect(waits(buildOverlapRows(fixture())).get(`${repo}#5482`).yieldTo).toBe(5461);
  });

  it('still yields to a non-candidate with no verdict this pass', () => {
    vi.stubEnv(settingEnv, '1');
    const input = fixture();
    input.verdicts.pop();
    expect(waits(buildOverlapRows(input)).get(`${repo}#5482`).yieldTo).toBe(5461);
  });
});

describe('pure overlap target filter and setting provenance', () => {
  it('scopes verdict identities by repository, normalizes local keys, and never mutates inputs', async () => {
    const { filterEnqueueableOverlapRows } = await load();
    const rows = [Object.freeze({ number: 5461, repo }), Object.freeze({ number: 5461, repo: 'other/repo' })];
    const verdicts = [Object.freeze({ num: 5461, repo: null, decision: 'park' })];
    Object.freeze(rows); Object.freeze(verdicts);
    expect(filterEnqueueableOverlapRows({ openPrRows: rows, verdicts, localSlug: repo })).toEqual([rows[1]]);
    expect(filterEnqueueableOverlapRows({ openPrRows: rows, verdicts, localSlug: repo, enabled: false })).toEqual(rows);
    expect(rows.map(overlapRowKey)).toEqual([`${repo}#5461`, 'other/repo#5461']);
  });

  it('reports default, environment and CLI sources with CLI precedence', async () => {
    const { resolveOverlapYieldOnlyToEnqueueableSetting: resolve, formatOverlapYieldOnlyToEnqueueableSetting: format } = await load();
    expect(resolve()).toEqual({ value: true, source: 'default' });
    for (const [rawValue, value] of [['1', true], ['0', false], ['on', true], ['off', false], ['true', true], ['false', false]]) {
      expect(resolve({ env: { [settingEnv]: rawValue } })).toEqual({ value, source: 'env' });
    }
    const setting = resolve({ argv: ['--overlap-yield-only-to-enqueueable'], env: { [settingEnv]: '0' } });
    expect(setting).toEqual({ value: true, source: 'cli' });
    expect(resolve({ argv: ['--no-overlap-yield-only-to-enqueueable'] })).toEqual({ value: false, source: 'cli' });
    expect(format(setting)).toContain('drain.overlapYieldOnlyToEnqueueable=on (source: cli)');
  });

  it('rejects contradictory CLI flags and invalid environment values', async () => {
    const { resolveOverlapYieldOnlyToEnqueueableSetting: resolve } = await load();
    expect(() => resolve({ argv: ['--overlap-yield-only-to-enqueueable', '--no-overlap-yield-only-to-enqueueable'] })).toThrow(/mutually exclusive/);
    expect(() => resolve({ env: { [settingEnv]: 'maybe' } })).toThrow(/WE_DRAIN_OVERLAP_YIELD_ONLY_TO_ENQUEUEABLE/);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOverlapRows } from '../../merge-ai-prs.mjs';
import { computeOverlapContext, overlapRowKey, overlapYieldWaits } from '../land-overlap-yield.mjs';

const repo = 'web-everything/web-everything';
const settingEnv = 'WE_DRAIN_OVERLAP_YIELD_ONLY_TO_ENQUEUEABLE';
const landableEnv = 'WE_DRAIN_OVERLAP_YIELD_REQUIRES_LANDABLE';
const load = () => import('../overlap-yield-enqueueable.mjs');
const raw = (number, additions) => ({ number, baseRefName: 'main', labels: ['review:accepted', 'ready-to-merge'],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
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

  it.each([
    ['missing required check', { statusCheckRollup: [] }],
    ['only another check is green', { statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }] }],
    ['red required check', { statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }],
    ['no ready label', { labels: ['review:accepted'] }],
    ...['blocked', 'ci:failed', 'review:changes'].map((label) => [label, { labels: ['review:accepted', 'ready-to-merge', label] }]),
  ])('does not yield to a non-candidate with %s', (_name, changes) => {
    vi.stubEnv(settingEnv, '1');
    vi.stubEnv(landableEnv, '1');
    const input = fixture();
    input.verdicts.pop(); // reproduces a target with no verdict this pass
    Object.assign(input.openPrContext.prsByRepo.get(null)[1], changes);
    const rows = buildOverlapRows(input);
    expect(waits(rows).size).toBe(0);
    expect(rows.candidateRows.map((r) => r.number)).toEqual([5482]);
  });

  it('accepts object labels on a landable target and a custom required check', () => {
    vi.stubEnv(landableEnv, '1');
    const input = fixture('merge');
    for (const pr of input.openPrContext.prsByRepo.get(null)) {
      pr.labels = pr.labels.map((name) => ({ name }));
      pr.statusCheckRollup[0].name = 'custom-test';
    }
    expect(waits(buildOverlapRows({ ...input, requiredCheck: 'custom-test' })).get(`${repo}#5482`).yieldTo).toBe(5461);
  });

  it('landable OFF restores the old yield to a target with no required check or ready label', () => {
    vi.stubEnv(settingEnv, '1');
    vi.stubEnv(landableEnv, '0');
    const input = fixture();
    input.verdicts.pop();
    const target = input.openPrContext.prsByRepo.get(null)[1];
    target.labels = ['review:accepted'];
    target.statusCheckRollup = [];
    expect(waits(buildOverlapRows(input)).get(`${repo}#5482`).yieldTo).toBe(5461);
  });

  it('landable OFF preserves the existing non-merge verdict exclusion', () => {
    vi.stubEnv(settingEnv, '1');
    vi.stubEnv(landableEnv, '0');
    expect(waits(buildOverlapRows(fixture())).size).toBe(0);
  });

  it('does not filter candidate rows when their listing is not landable', () => {
    vi.stubEnv(landableEnv, '1');
    const input = fixture('merge');
    const candidate = input.openPrContext.prsByRepo.get(null)[0];
    candidate.labels = [];
    candidate.statusCheckRollup = [];
    const rows = buildOverlapRows(input);
    expect(rows.candidateRows.map((r) => r.number)).toEqual([5482, 5461]);
    expect(rows.openPrRows.map((r) => r.number)).toEqual([5461]);
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
    const rows = [Object.freeze({ number: 5461, repo, requiredCheckGreen: true, labels: ['ready-to-merge'] }), Object.freeze({ number: 5461, repo: 'other/repo', requiredCheckGreen: true, labels: [{ name: 'ready-to-merge' }] })];
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


describe('landable overlap target setting provenance', () => {
  it('resolves CLI > env > default and formats each source', async () => {
    const { resolveOverlapYieldRequiresLandableSetting: resolve, formatOverlapYieldRequiresLandableSetting: format } = await load();
    expect(resolve()).toEqual({ value: true, source: 'default' });
    expect(format(resolve())).toBe('policy · drain.overlapYieldRequiresLandable=on (source: default)');
    for (const [rawValue, value] of [['1', true], ['0', false], ['on', true], ['off', false], ['true', true], ['false', false], [' TRUE ', true]]) {
      const setting = resolve({ env: { [landableEnv]: rawValue } });
      expect(setting).toEqual({ value, source: 'env' });
      expect(format(setting)).toBe(`policy · drain.overlapYieldRequiresLandable=${value ? 'on' : 'off'} (source: env)`);
    }
    for (const [flag, value] of [['--overlap-yield-requires-landable', true], ['--no-overlap-yield-requires-landable', false]]) {
      const setting = resolve({ argv: [flag], env: { [landableEnv]: value ? '0' : '1' } });
      expect(setting).toEqual({ value, source: 'cli' });
      expect(format(setting)).toBe(`policy · drain.overlapYieldRequiresLandable=${value ? 'on' : 'off'} (source: cli)`);
      expect(resolve({ argv: [flag], env: { [landableEnv]: 'invalid' } })).toEqual(setting);
    }
  });

  it('rejects conflicting flags and invalid environment values', async () => {
    const { resolveOverlapYieldRequiresLandableSetting: resolve } = await load();
    expect(() => resolve({ argv: ['--overlap-yield-requires-landable', '--no-overlap-yield-requires-landable'], env: { [landableEnv]: '1' } })).toThrow(/usage:.*mutually exclusive/);
    for (const value of ['', 'maybe', '2']) {
      expect(() => resolve({ env: { [landableEnv]: value } })).toThrow(/usage: WE_DRAIN_OVERLAP_YIELD_REQUIRES_LANDABLE/);
    }
  });
});

describe('planOverlapYieldAroundBlockedTargets — a blocked target never makes others wait', () => {
  // The 2026-10-20 17:58Z shape: #5659/#5655/#5653 (card PRs) all yield to #5485, which is red-team-pending.
  const row = (number, additions) => ({ number, repo, baseRefName: 'main', isDraft: false, labels: ['review:accepted', 'ready-to-merge'],
    files: [{ path: 'backlog/x.md', additions, deletions: 0 }], filesComplete: true, readyAtMs: null, windowMs: null, item: null,
    exempt: false, requiredCheckRed: false, dependsOn: new Set() });
  const xs = [row(5659, 1), row(5655, 2), row(5653, 3)];
  const ys = [...xs, row(5485, 500)];
  const compute = (openPrRows) => ({ waits: overlapYieldWaits({ candidates: xs, openPrs: openPrRows, nowMs: 0, ignoreBudget: true }), skips: new Map() });

  it('baseline: every waiter yields to the biggest overlapping PR (#5485)', () => {
    const w = compute(ys).waits;
    expect([...w.values()].map((x) => x.yieldTo)).toEqual([5485, 5485, 5485]);
  });

  it('a blocked #5485 is skipped and logged; waiters proceed in normal order (here: the next eligible target)', async () => {
    const { planOverlapYieldAroundBlockedTargets, formatBlockedYieldTargetLine } = await load();
    const blockOf = vi.fn((r) => (r.number === 5485 ? { kind: 'red-team-pending', reason: 'post-accept red team has no recorded result on the live head' } : null));
    const r = planOverlapYieldAroundBlockedTargets({ openPrRows: ys, compute, blockOf });
    expect(r.ctx.waits.has(overlapRowKey({ repo, number: 5653 }))).toBe(false); // the biggest remaining one leads
    expect([...r.ctx.waits.values()].every((w) => w.yieldTo !== 5485)).toBe(true);
    expect(r.skipped).toEqual([expect.objectContaining({ pr: 5485, kind: 'red-team-pending', waiters: expect.arrayContaining([`${repo}#5659`, `${repo}#5655`, `${repo}#5653`]) })]);
    expect(formatBlockedYieldTargetLine(r.skipped[0])).toMatch(/^overlap-yield skipped: #5485 blocked \(red-team-pending\)/);
    expect(blockOf.mock.calls.filter(([x]) => x.number === 5485)).toHaveLength(1); // decided once per pass
  });

  it('keeps going past many blocked targets (no round cap leaves a blocked target in place)', async () => {
    const { planOverlapYieldAroundBlockedTargets } = await load();
    const big = Array.from({ length: 12 }, (_, i) => row(6000 + i, 1000 - i));
    const all = [...xs, ...big];
    const comp = (openPrRows) => ({ waits: overlapYieldWaits({ candidates: xs, openPrs: openPrRows, nowMs: 0, ignoreBudget: true }), skips: new Map() });
    const r = planOverlapYieldAroundBlockedTargets({ openPrRows: all, compute: comp, blockOf: (x) => (x.number >= 6000 ? { kind: 'red-team-pending', reason: 'x' } : null) });
    expect([...r.ctx.waits.values()].some((w) => w.yieldTo >= 6000)).toBe(false);
    expect(r.skipped).toHaveLength(12);
  });

  it('when every target is blocked, nobody waits', async () => {
    const { planOverlapYieldAroundBlockedTargets } = await load();
    const r = planOverlapYieldAroundBlockedTargets({ openPrRows: ys, compute, blockOf: () => ({ kind: 'review-hold', reason: 'x' }) });
    expect(r.ctx.waits.size).toBe(0);
  });

  it('an eligible target keeps today\'s yield', async () => {
    const { planOverlapYieldAroundBlockedTargets } = await load();
    const r = planOverlapYieldAroundBlockedTargets({ openPrRows: ys, compute, blockOf: () => null });
    expect([...r.ctx.waits.values()].map((x) => x.yieldTo)).toEqual([5485, 5485, 5485]);
    expect(r.skipped).toEqual([]);
  });

  it('fail closed: a target whose eligibility cannot be read keeps the yield', async () => {
    const { planOverlapYieldAroundBlockedTargets } = await load();
    const r = planOverlapYieldAroundBlockedTargets({ openPrRows: ys, compute, blockOf: (x) => { if (x.number === 5485) throw new Error('gh down'); return null; } });
    expect([...r.ctx.waits.values()].map((x) => x.yieldTo)).toEqual([5485, 5485, 5485]);
    expect(r.unknown).toEqual([expect.objectContaining({ pr: 5485, error: 'gh down' })]);
  });

  it('disabled setting keeps today\'s behaviour and never calls blockOf', async () => {
    const { planOverlapYieldAroundBlockedTargets } = await load();
    const blockOf = vi.fn(() => ({ kind: 'red-team-pending', reason: 'x' }));
    const r = planOverlapYieldAroundBlockedTargets({ openPrRows: ys, compute, blockOf, enabled: false });
    expect([...r.ctx.waits.values()].map((x) => x.yieldTo)).toEqual([5485, 5485, 5485]);
    expect(blockOf).not.toHaveBeenCalled();
  });

  it('drain.overlapYieldSkipsBlockedTarget resolves CLI > env > default ON, with source', async () => {
    const { resolveOverlapYieldSkipsBlockedTargetSetting: r, formatOverlapYieldSkipsBlockedTargetSetting: f } = await load();
    expect(r({})).toEqual({ value: true, source: 'default' });
    expect(r({ env: { WE_DRAIN_OVERLAP_YIELD_SKIPS_BLOCKED_TARGET: 'off' } })).toEqual({ value: false, source: 'env' });
    expect(r({ argv: ['--overlap-yield-skips-blocked-target'], env: { WE_DRAIN_OVERLAP_YIELD_SKIPS_BLOCKED_TARGET: '0' } })).toEqual({ value: true, source: 'cli' });
    expect(() => r({ argv: ['--overlap-yield-skips-blocked-target', '--no-overlap-yield-skips-blocked-target'] })).toThrow(/mutually exclusive/);
    expect(() => r({ env: { WE_DRAIN_OVERLAP_YIELD_SKIPS_BLOCKED_TARGET: 'maybe' } })).toThrow(/must be/);
    expect(f({ value: true, source: 'default' })).toBe('policy · drain.overlapYieldSkipsBlockedTarget=on (source: default)');
  });
});

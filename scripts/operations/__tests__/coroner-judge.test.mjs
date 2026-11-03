// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { rankFrictions, judgeFrictions, fileNewCards, runCoronerJudge } from '../coroner-judge.mjs';

// Judge IO uses the codexJudgeSpawn port: { mandate, input, shape } -> { value }.
// No model, filesystem, GitHub, or real file-item operation is used by these tests.
const example = (ref) => [{ ref, at: '2026-10-16T12:00:00.000Z' }];
const cause = (ref, count, minutes) => ({ count, ...(minutes === undefined ? {} : { minutes }), examples: example(ref) });
const metrics = () => ({ errorRates: {
  gateRuns: { causes: {
    timeout: cause('PR #101', 2, 60),
    flaky: cause('PR #102', 8, 20),
    defect: cause('PR #103', 3, 20),
    brief: cause('PR #104', 1, 0),
  } },
  daemonErrors: { causes: {
    unavailable: cause('daemon-a', 100),
    refused: cause('daemon-b', 10),
    rare: cause('daemon-c', 1),
  } },
} });
const answer = (verdicts) => ({ value: { verdicts } });
const allNew = (ranked) => ranked.map(({ key }) => ({ key, verdict: 'NEW' }));
const context = () => ({
  held: [{ id: 'held-7', title: 'Retry lane acquisition' }],
  openPrs: [{ number: 42, title: 'Bound gate waits' }],
  recentCards: [{ id: 'abc1234', title: 'Classify daemon refusals' }],
});

describe('rankFrictions', () => {
  it('purely ranks the default top five causes by minutes then count, putting unknown minutes last', () => {
    const input = metrics(); const before = structuredClone(input);
    const ranked = rankFrictions(input);
    expect(ranked.map((row) => row.examples[0].ref)).toEqual(['PR #101', 'PR #102', 'PR #103', 'PR #104', 'daemon-a']);
    expect(ranked.map((row) => row.count)).toEqual([2, 8, 3, 1, 100]);
    expect(ranked.slice(0, 4).map((row) => row.minutes)).toEqual([60, 20, 20, 0]);
    expect(ranked[4].minutes == null).toBe(true); // Unknown cost must not be presented as measured zero.
    expect(input).toEqual(before);
  });

  it('honors an explicit topN and bounds oversized input at five by default', () => {
    const input = { errorRates: { ci: { causes: Object.fromEntries(Array.from({ length: 200 }, (_, n) =>
      [`cause-${n}`, cause(`PR #${n}`, n + 1, n)])) } } };
    expect(rankFrictions(input)).toHaveLength(5);
    expect(rankFrictions(input, { topN: 2 }).map((r) => r.minutes)).toEqual([199, 198]);
  });

  it('breaks ties deterministically and keeps keys stable across input order and changed evidence', () => {
    const a = { errorRates: { ci: { causes: { infra: cause('old', 2, 10), flaky: cause('other', 2, 10) } },
      gateRuns: { causes: { infra: cause('gate', 2, 10) } } } };
    const b = { errorRates: { gateRuns: a.errorRates.gateRuns,
      ci: { causes: { flaky: a.errorRates.ci.causes.flaky, infra: cause('new', 3, 20) } } } };
    const first = rankFrictions(a);
    const reversed = { errorRates: Object.fromEntries(Object.entries(a.errorRates).reverse().map(([key, value]) =>
      [key, { causes: Object.fromEntries(Object.entries(value.causes).reverse()) }])) };
    expect(rankFrictions(reversed)).toEqual(first);
    expect(new Set(first.map((r) => r.key)).size).toBe(3); // Same cause in distinct metrics stays distinct.
    expect(first.every((r) => typeof r.key === 'string' && r.key.length > 0)).toBe(true);
    expect(rankFrictions(b).find((r) => r.examples[0].ref === 'new').key)
      .toBe(first.find((r) => r.examples[0].ref === 'old').key);
  });

  it('returns no candidates when error-rate evidence is absent', () => {
    expect(rankFrictions({})).toEqual([]);
    expect(rankFrictions({ errorRates: {} })).toEqual([]);
  });
});

describe('judgeFrictions', () => {
  it('passes ranked evidence and all coverage sources to a schema-constrained injected judge', async () => {
    const ranked = rankFrictions(metrics()); const coverage = context();
    const verdicts = [{ key: ranked[0].key, verdict: 'NEW' },
      { key: ranked[1].key, verdict: 'COVERED-BY', coveredBy: 'PR #42' }];
    const judge = vi.fn(async () => answer(verdicts));
    expect(await judgeFrictions({ ranked, ...coverage, judge })).toEqual(verdicts);
    expect(judge).toHaveBeenCalledOnce();
    const request = judge.mock.calls[0][0];
    expect(request.mandate).toEqual(expect.any(String));
    expect(request.shape).toMatchObject({ type: 'object', required: expect.arrayContaining(['verdicts']) });
    expect(JSON.stringify(request.shape)).toContain('COVERED-BY');
    expect(JSON.stringify(request.shape)).toContain('NEW');
    for (const evidence of [ranked[0].key, 'PR #101', 'held-7', 'Bound gate waits', 'abc1234']) {
      expect(request.input).toContain(evidence);
    }
  });

  it('does not infer NEW for candidates omitted by the judge', async () => {
    const ranked = rankFrictions(metrics());
    const verdicts = [{ key: ranked[0].key, verdict: 'COVERED-BY', coveredBy: 'held-7' }];
    expect(await judgeFrictions({ ranked, ...context(), judge: async () => answer(verdicts) })).toEqual(verdicts);
  });

  it.each([
    ['unparseable answer', () => 'not JSON'],
    ['missing verdicts', () => ({})],
    ['unknown verdict', (key) => ({ verdicts: [{ key, verdict: 'MAYBE' }] })],
    ['coverage without a reference', (key) => ({ verdicts: [{ key, verdict: 'COVERED-BY' }] })],
    ['unknown key', () => ({ verdicts: [{ key: 'invented', verdict: 'NEW' }] })],
    ['conflicting duplicate key', (key) => ({ verdicts: [{ key, verdict: 'NEW' }, { key, verdict: 'COVERED-BY', coveredBy: 'held-7' }] })],
    ['mixed valid and invalid entries', (key) => ({ verdicts: [{ key, verdict: 'NEW' }, { verdict: 'NEW' }] })],
  ])('fails closed with no verdicts and reports %s', async (_name, value) => {
    const ranked = rankFrictions(metrics()); const log = vi.fn();
    const verdicts = await judgeFrictions({ ranked, ...context(), judge: async () => ({ value: value(ranked[0].key) }), log });
    expect(verdicts).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it('reports a judge exception without manufacturing NEW verdicts', async () => {
    const log = vi.fn();
    expect(await judgeFrictions({ ranked: rankFrictions(metrics()), ...context(),
      judge: async () => { throw new Error('judge unavailable'); }, log })).toEqual([]);
    expect(log.mock.calls.flat().join(' ')).toContain('judge unavailable');
  });
});

describe('fileNewCards', () => {
  it('files only explicit NEW candidates, never covered, omitted, unknown or uncertain candidates', async () => {
    const ranked = rankFrictions(metrics()); const fileItem = vi.fn(async () => ({ id: 'card-1' }));
    await fileNewCards({ ranked, state: {}, fileItem, verdicts: [
      { key: ranked[0].key, verdict: 'NEW' },
      { key: ranked[1].key, verdict: 'COVERED-BY', coveredBy: 'PR #42' },
      { key: ranked[2].key, verdict: 'MAYBE' }, { key: 'unknown', verdict: 'NEW' },
    ] });
    expect(fileItem).toHaveBeenCalledOnce();
    expect(JSON.stringify(fileItem.mock.calls[0])).toContain('PR #101');
  });

  it.each([[undefined, 3], [1, 1]])('caps an all-NEW run with maxCards=%s at %s cards', async (maxCards, expected) => {
    const ranked = rankFrictions(metrics()); const fileItem = vi.fn(async () => ({ id: `card-${fileItem.mock.calls.length}` }));
    await fileNewCards({ ranked, verdicts: allNew(ranked), state: {}, fileItem, ...(maxCards === undefined ? {} : { maxCards }) });
    expect(fileItem).toHaveBeenCalledTimes(expected);
  });

  it('persists stable-key deduplication across serialized state and changed counts/evidence', async () => {
    const ranked = rankFrictions(metrics(), { topN: 1 }); const state = {};
    const fileItem = vi.fn(async () => ({ id: 'card-1' }));
    const verdicts = [...allNew(ranked), ...allNew(ranked)];
    await fileNewCards({ ranked, verdicts, state, fileItem });
    expect(fileItem).toHaveBeenCalledOnce();
    expect(JSON.stringify(state)).toContain(ranked[0].key);
    const changed = metrics(); changed.errorRates.gateRuns.causes.timeout = cause('PR #999', 50, 100);
    await fileNewCards({ ranked: rankFrictions(changed, { topN: 1 }), verdicts: allNew(ranked),
      state: JSON.parse(JSON.stringify(state)), fileItem });
    expect(fileItem).toHaveBeenCalledOnce();
  });
});

describe('runCoronerJudge', () => {
  it('composes ranking, judgment and bounded filing and replays without filing twice', async () => {
    const state = {}; const fileItem = vi.fn(async () => ({ id: `card-${fileItem.mock.calls.length}` }));
    const judge = vi.fn(async () => answer(allNew(rankFrictions(metrics()))));
    await runCoronerJudge({ metrics: metrics(), ...context(), state, judge, fileItem, maxCards: 2 });
    expect(judge).toHaveBeenCalledOnce();
    expect(fileItem).toHaveBeenCalledTimes(2);
    const one = rankFrictions(metrics(), { topN: 1 });
    await runCoronerJudge({ metrics: metrics(), ...context(), state: JSON.parse(JSON.stringify(state)),
      judge: async () => answer(allNew(one)), fileItem, maxCards: 2 });
    expect(fileItem).toHaveBeenCalledTimes(2);
  });

  it('files nothing and exposes an error when the judge answer cannot be trusted', async () => {
    const fileItem = vi.fn(); const log = vi.fn();
    await runCoronerJudge({ metrics: metrics(), ...context(), state: {},
      judge: async () => ({ value: 'not JSON' }), fileItem, log });
    expect(fileItem).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });
});

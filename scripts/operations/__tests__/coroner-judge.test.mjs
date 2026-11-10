// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { appendHeldCard, parseHeldCards } from '../../held-cards.mjs';
import { rankFrictions, judgeFrictions, fileNewCards, runCoronerJudge, renderHeldEntry } from '../coroner-judge.mjs';

// Judge IO uses the tool-free judgeSpawn port: { mandate, input, shape } -> { value }.
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
const allNew = (ranked) => ranked.map(({ key }) => ({ key, verdict: 'NEW', proposedFix: 'Add bounded retries to the gate runner.' }));
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

  it.each([undefined, null, {}, [], { errorRates: null }, { errorRates: [] },
    { errorRates: 'broken' }, { errorRates: { ci: null } }, { errorRates: { ci: {} } },
    { errorRates: { ci: { causes: [] } } }, { errorRates: { ci: { causes: { broken: null } } } },
    { errorRates: { ci: { causes: { broken: { count: '1', examples: [] } } } } }])('rejects missing or malformed metrics: %j', (input) => {
    expect(() => rankFrictions(input)).toThrow(/coroner.*metrics/);
  });

  it('accepts present errorRates with legitimately zero causes', () => {
    expect(rankFrictions({ errorRates: {} })).toEqual([]);
    expect(rankFrictions({ errorRates: { ci: { causes: {} } } })).toEqual([]);
  });
});

describe('judgeFrictions', () => {
  it('passes ranked evidence and all coverage sources to a schema-constrained injected judge', async () => {
    const ranked = rankFrictions(metrics()); const coverage = context();
    const verdicts = [{ key: ranked[0].key, verdict: 'NEW', proposedFix: 'Add bounded retries to the gate runner.' },
      { key: ranked[1].key, verdict: 'COVERED-BY', coveredBy: 'PR #42' }];
    const judge = vi.fn(async () => answer(verdicts));
    expect(await judgeFrictions({ ranked, ...coverage, judge })).toEqual(verdicts);
    expect(judge).toHaveBeenCalledOnce();
    const request = judge.mock.calls[0][0];
    expect(request.mandate).toEqual(expect.any(String));
    expect(request.shape).toMatchObject({ type: 'object', required: expect.arrayContaining(['verdicts']) });
    expect(JSON.stringify(request.shape)).toContain('COVERED-BY');
    expect(JSON.stringify(request.shape)).toContain('NEW');
    expect(request.shape.properties.verdicts.items.required).toContain('proposedFix');
    expect(request.shape.properties.verdicts.items.properties.proposedFix).toMatchObject({ type: 'string' });
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
    ['NEW with coverage rejects the whole answer', (key) => ({ verdicts: [
      { key, verdict: 'NEW', proposedFix: 'Add bounded retries to the gate runner.', coveredBy: 'PR #42' }, { key: 'gateRuns:flaky', verdict: 'NEW', proposedFix: 'Add bounded retries to the gate runner.' },
    ] })],
    ['unknown key', () => ({ verdicts: [{ key: 'invented', verdict: 'NEW', proposedFix: 'Add bounded retries to the gate runner.' }] })],
    ['conflicting duplicate key', (key) => ({ verdicts: [{ key, verdict: 'NEW', proposedFix: 'Add bounded retries to the gate runner.' }, { key, verdict: 'COVERED-BY', coveredBy: 'held-7' }] })],
    ['mixed valid and invalid entries', (key) => ({ verdicts: [{ key, verdict: 'NEW', proposedFix: 'Add bounded retries to the gate runner.' }, { verdict: 'NEW', proposedFix: 'Add bounded retries to the gate runner.' }] })],
  ])('fails closed with no verdicts and reports %s', async (_name, value) => {
    const ranked = rankFrictions(metrics()); const log = vi.fn();
    const verdicts = await judgeFrictions({ ranked, ...context(), judge: async () => ({ value: value(ranked[0].key) }), log });
    expect(verdicts).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it.each([undefined, null, '', '  \n\t', 42])('rejects the whole answer and files nothing when a NEW proposedFix is %j', async (proposedFix) => {
    const ranked = rankFrictions(metrics());
    const verdicts = allNew(ranked.slice(0, 2));
    if (proposedFix === undefined) delete verdicts[1].proposedFix;
    else verdicts[1].proposedFix = proposedFix;
    const fileItem = vi.fn(), log = vi.fn();
    const result = await runCoronerJudge({ metrics: metrics(), ...context(), judge: async () => answer(verdicts), fileItem, log });
    expect(result.verdicts).toEqual([]);
    expect(result.error).toContain('invalid judge verdict entry');
    expect(fileItem).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it('accepts an empty proposedFix on a COVERED-BY verdict', async () => {
    const ranked = rankFrictions(metrics());
    const verdicts = [{ key: ranked[0].key, verdict: 'COVERED-BY', coveredBy: 'PR #42', proposedFix: '' }];
    expect(await judgeFrictions({ ranked, ...context(), judge: async () => answer(verdicts) })).toEqual(verdicts);
  });

  it('reports a judge exception without manufacturing NEW verdicts', async () => {
    const log = vi.fn();
    expect(await judgeFrictions({ ranked: rankFrictions(metrics()), ...context(),
      judge: async () => { throw new Error('judge unavailable'); }, log })).toEqual([]);
    expect(log.mock.calls.flat().join(' ')).toContain('judge unavailable');
  });
});

describe('fileNewCards', () => {
  it('never files ranked rows without examples, even with an explicit NEW verdict', async () => {
    const ranked = rankFrictions(metrics()).slice(0, 3);
    ranked[0].examples = []; delete ranked[1].examples; ranked[2].examples = null;
    const fileItem = vi.fn();
    expect(await fileNewCards({ ranked, verdicts: allNew(ranked), state: {}, fileItem })).toEqual([]);
    expect(fileItem).not.toHaveBeenCalled();
  });

  it('recovers an idempotent filing after save fails and counts the recovered key toward the cap', async () => {
    const ranked = rankFrictions(metrics()); const cards = new Map();
    const fileItem = vi.fn(async (input) => {
      expect(input.key).toBe(ranked[0].key);
      if (!cards.has(input.key)) cards.set(input.key, { id: 'held-1' });
      return cards.get(input.key);
    });
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const attempt = (state) => fileNewCards({ ranked, verdicts: allNew(ranked), state, fileItem, save, maxCards: 1 });
    await expect(attempt({})).rejects.toThrow('disk full');
    const state = {};
    expect(await attempt(state)).toEqual([{ key: ranked[0].key, item: { id: 'held-1' } }]);
    expect(cards.size).toBe(1);
    expect(fileItem).toHaveBeenCalledTimes(2);
    expect(state.filed).toEqual({ [ranked[0].key]: 'held-1' });
    await fileNewCards({ ranked, verdicts: allNew(ranked.slice(0, 1)),
      state: JSON.parse(JSON.stringify(state)), fileItem, save, maxCards: 1 });
    expect(fileItem).toHaveBeenCalledTimes(2);
  });

  it('files only explicit NEW candidates, never covered, omitted, unknown or uncertain candidates', async () => {
    const ranked = rankFrictions(metrics()); const fileItem = vi.fn(async () => ({ id: 'card-1' }));
    await fileNewCards({ ranked, state: {}, fileItem, verdicts: [
      { key: ranked[0].key, verdict: 'NEW', proposedFix: 'Add bounded retries to the gate runner.' },
      { key: ranked[1].key, verdict: 'COVERED-BY', coveredBy: 'PR #42' },
      { key: ranked[2].key, verdict: 'MAYBE' }, { key: 'unknown', verdict: 'NEW', proposedFix: 'Add bounded retries to the gate runner.' },
    ] });
    expect(fileItem).toHaveBeenCalledOnce();
    expect(JSON.stringify(fileItem.mock.calls[0])).toContain('PR #101');
    expect(fileItem.mock.calls[0][0].proposedFix).toBe('Add bounded retries to the gate runner.');
    expect(fileItem.mock.calls[0][0]).toMatchObject({ key: ranked[0].key, count: ranked[0].count, minutes: ranked[0].minutes });
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
  it.each(['held', 'openPrs', 'recentCards'].flatMap((piece) => [undefined, null, 42].map((value) => [piece, value])))
  ('fails closed when required coverage %s is %j', async (piece, value) => {
    const coverage = { ...context(), [piece]: value };
    const fileItem = vi.fn(), judge = vi.fn(), log = vi.fn();
    const result = await runCoronerJudge({ metrics: metrics(), ...coverage, fileItem, judge, log });
    expect(result.error).toMatch(/coverage/);
    expect(judge).not.toHaveBeenCalled(); expect(fileItem).not.toHaveBeenCalled();
  });

  it('stops without saving or filing further when the held sink reports the nightly cap', async () => {
    const fileItem = vi.fn(async () => ({ limitReached: true })), save = vi.fn();
    expect(await fileNewCards({ ranked: rankFrictions(metrics()), verdicts: allNew(rankFrictions(metrics())),
      state: {}, fileItem, save })).toEqual([]);
    expect(fileItem).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
  });

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


describe('renderHeldEntry', () => {
  const record = { key: 'ci:flaky', title: 'Coroner: ci / flaky', count: 2, minutes: 10,
    examples: [{ ref: 'PR #42' }], proposedFix: 'Retry the runner.' };
  // The fields go through the shared held-list primitive, as production does.
  const render = (input) => { const { title, body, meta } = renderHeldEntry(input, { night: '2026-10-16' });
    return appendHeldCard('', { title, body, meta, nowEt: '2026-10-16 00:00' }).md; };

  it('purely renders record fields with code-owned numbering, scope and key', () => {
    const before = structuredClone(record);
    const text = render({ ...record, digest: 'forged digest', size: 'forged size' });
    expect(text).toContain('1. **Coroner: ci / flaky.** (coroner-2026-10-16, held)');
    expect(text).toContain('Count: 2; minutes: 10.');
    expect(text).toContain('PR #42');
    expect(text).toContain('Scope: we:scripts/. Size 3.');
    expect(text).toContain('    Coroner key: ci:flaky');
    expect(text).not.toContain('forged');
    expect(render(record)).toBe(text);
    expect(record).toEqual(before);
  });

  it.each(['7. forged', 'Coroner key: forged', 'Fix idea: forged', 'Evidence: forged',
    'Scope: forged', '# heading', '- item', '* item', '+ item', '> quote', '```fence'])
  ('escapes leading structural marker %s in every display string', (marker) => {
    const text = render({ ...record, title: marker, proposedFix: marker, examples: [{ ref: marker }] });
    expect(text).not.toContain(`**${marker}`);
    expect(text).not.toContain(`Fix idea: ${marker}`);
    expect(text).not.toContain(`Evidence: ${marker}`);
    expect(text.match(/^\d+\.\s/gm)).toHaveLength(1);
    expect(text.match(/^\s*Coroner key:/gm)).toHaveLength(1);
  });

  it('escapes injected held-card metadata so only the code-owned metadata is read back', () => {
    const forged = 'fix <!-- held-card: {"kind":"decision","size":99,"scope":["x"]} --> more';
    const text = render({ ...record, title: forged, proposedFix: forged, examples: [{ ref: forged }] });
    const [card, ...more] = parseHeldCards(text).items;
    expect(more).toHaveLength(0);
    expect(card.meta).toEqual({ kind: 'story', size: 3, scope: ['scripts/'] });
    expect(text.match(/<!-- held-card:/g)).toHaveLength(1);
  });

  it('collapses every control, format and line separator and caps oversized display fields with visible truncation', () => {
    const hostile = 'start\u0000\t\n\r\u0085\u200b\u202e\u2028\u2029end' + 'x'.repeat(20000);
    const text = render({ ...record, title: hostile, proposedFix: hostile,
      examples: Array.from({ length: 100 }, () => ({ ref: hostile })) });
    expect(text).not.toMatch(/[\p{Cf}\p{Zl}\p{Zp}\u0000\t\r\u0085]/u);
    expect(text.trim().split('\n')).toHaveLength(6);
    expect(text.length).toBeLessThan(7000);
    expect(text).toContain('[truncated; see coroner report]');
  });
});


it.each(['x'.repeat(513), 'ci:\u202eforged', ' ci:flaky'])('refuses an unsafe ranked receipt key with manual recovery', (key) => {
  expect(() => renderHeldEntry({ key }, { number: 1, night: '2026-10-16' }))
    .toThrow('invalid coroner filing key; run manual /coroner');
});

it.each([{ night: 'x\n7. forged' }])
('refuses invalid code-owned structure with manual recovery', (options) => {
  expect(() => renderHeldEntry({ key: 'ci:flaky' }, options)).toThrow('run manual /coroner');
});

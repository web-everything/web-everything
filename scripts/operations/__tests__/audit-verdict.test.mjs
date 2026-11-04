import { existsSync, readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { BUILT_IN_REVIEW_SETTINGS } from '../../lib/review-settings.mjs';

// R473 stage 1 deliberately supplies tests only. Stage 2 supplies the implementation;
// this suite must stay RED until then. Do not stub the verdict engine or skip cases
// to obtain a green run. Assert the missing export explicitly before attempting an
// import, so absence is a contract assertion, not a Vitest module-resolution error.
const verdictModule = '../audit-verdict.mjs';
async function loadComputeVerdict() {
  const implementation = existsSync(new NodeURL(verdictModule, import.meta.url))
    ? (await import(verdictModule)).computeVerdict : undefined;
  expect(implementation,
    'R473 stage 1 RED: stage 2 must export computeVerdict from scripts/operations/audit-verdict.mjs; implementation is outside this tests-only change')
    .toBeTypeOf('function');
  return implementation;
}
const compute = async (findings, options) => (await loadComputeVerdict())(findings, options);
const finding = (overrides = {}) => ({ id: 'f1', class: 'E1', file: 'scripts/output.mjs', line: 12,
  invariant: 'Output preserves the requested label', trigger: 'Input label is empty',
  consequence: 'Wrong reversible output', relation: 'introduced', ...overrides });
const interleaving = [{ actor: 'A', action: 'Reads the old lock' },
  { actor: 'B', action: 'Acquires replacement lock' }, { actor: 'A', action: 'Deletes the replacement' }];
const options = (releaseStage = 'prerelease', extra = {}) => ({ releaseStage, raceBlockPaths: [], rulings: [], ...extra });
const ids = entries => entries.map(entry => entry.id);
const scope = f => Object.fromEntries(['file', 'line', 'invariant', 'trigger', 'consequence', 'relation'].map(key => [key, f[key]]));
const cases = JSON.parse(readFileSync(new NodeURL('./fixtures/weakened-15-cases.json', import.meta.url), 'utf8'));

describe('R473 pure classified verdict', () => {
  it('requires the stage-2 computeVerdict export before behavioral contracts can run', async () => {
    await loadComputeVerdict();
  });

  it('returns the complete empty result and defaults to prerelease', async () => {
    expect(await compute([])).toEqual({ verdict: 'NOT WEAKENED', blocks: [], ships: [], cards: [], recheck: [] });
    expect((await compute([finding()])).verdict).toBe('NOT WEAKENED');
  });

  it.each(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'])('%s blocks at both stages even beside shipping findings and unrelated rulings', async cls => {
    for (const stage of ['prerelease', 'prod']) {
      const f = finding({ class: cls });
      const result = await compute([finding({ id: 'debt', class: 'D3' }), f], options(stage, { rulings: [{ id: 'R452', scope: {} }] }));
      expect(result.verdict).toBe('WEAKENED');
      expect(ids(result.blocks)).toContain('f1');
      expect(ids(result.ships)).not.toContain('f1');
    }
  });

  it.each(['E1', 'E2'])('%s ships with a card only in prerelease', async cls => {
    const pre = await compute([finding({ class: cls })], options());
    expect(pre.verdict).toBe('NOT WEAKENED');
    expect(ids(pre.ships)).toEqual(['f1']);
    expect(pre.cards).toEqual([expect.objectContaining({ id: 'f1', class: cls })]);
    const prod = await compute([finding({ class: cls })], options('prod'));
    expect(prod.verdict).toBe('WEAKENED');
    expect(ids(prod.blocks)).toEqual(['f1']);
    expect(prod.ships).toEqual([]);
  });

  it('D2 retains a card due before prod, while D3 is advisory with a card', async () => {
    for (const stage of ['prerelease', 'prod']) {
      const result = await compute([finding({ class: 'D2', relation: 'untouched', card: 'backlog/6400-debt.md' }), finding({ id: 'hardening', class: 'D3' })], options(stage, { readCard: () => 'status: open\n' }));
      expect(result.verdict).toBe('NOT WEAKENED');
      expect(ids(result.cards).sort()).toEqual(['f1', 'hardening']);
      expect(result.cards).toContainEqual(expect.objectContaining({ id: 'f1', mustPayBefore: 'prod' }));
    }
  });

  it.each(['introduced', 'newly relied on'])('D2 cannot conceal %s exposure', async relation => {
    expect((await compute([finding({ class: 'D2', relation })], options('prod'))).verdict).toBe('WEAKENED');
  });

  it.each([null, ''])('D1 without a concrete trigger %j requires recheck and cannot clear', async trigger => {
    const result = await compute([finding({ class: 'D1', trigger })], options());
    expect(result.verdict).toBe('WEAKENED');
    expect(ids(result.recheck)).toEqual(['f1']);
    expect(result.ships).toEqual([]);
  });

  it('unresolved X2 never clears an otherwise shipping audit', async () => {
    const result = await compute([finding({ class: 'X2' }), finding({ id: 'other' })], options());
    expect(result.verdict).toBe('WEAKENED');
    expect([...ids(result.blocks), ...ids(result.recheck)]).toContain('f1');
  });

  it.each([undefined, null, '', 'B8', 'b1', ' B1', 'B1 ', 'Ｂ１', 'B\u200b1', 'B1\n', ['B1'], {}, 1].map(value => [value]))(
    'unknown or nonexact class %j blocks rather than aliasing', async cls => {
      const result = await compute([finding({ class: cls })], options());
      expect(result.verdict).toBe('WEAKENED');
      expect(ids(result.blocks)).toEqual(['f1']);
    });

  it.each(['id', 'file', 'line', 'invariant', 'trigger', 'consequence', 'relation'])('missing %s evidence fails closed', async key => {
    const f = finding(); delete f[key];
    const result = await compute([f], options());
    expect(result.verdict).toBe('WEAKENED');
    expect(result.blocks).toHaveLength(1);
  });

  it.each([{ file: '' }, { line: 0 }, { line: '12' }, { line: 1.5 }, { invariant: {} },
    { trigger: [] }, { consequence: ' ' }, { relation: 'unrelated' }])('malformed evidence %j blocks', async bad => {
    expect((await compute([finding(bad)], options())).blocks).toHaveLength(1);
  });

  it('X1 needs a quoted ruling id, exact evidence scope, and still creates a card', async () => {
    const f = finding({ class: 'X1', ruling: 'R452' });
    const result = await compute([f], options('prod', { rulings: [{ id: 'R452', scope: scope(f) }] }));
    expect(result.verdict).toBe('NOT WEAKENED');
    expect(ids(result.ships)).toEqual(['f1']);
    expect(result.cards).toContainEqual(expect.objectContaining({ id: 'f1', class: 'X1', ruling: 'R452' }));
  });

  it.each(['file', 'line', 'invariant', 'trigger', 'consequence', 'relation'])('X1 mismatched ruling scope %s stays unresolved as X2 at both stages', async key => {
    const f = finding({ class: 'X1', ruling: 'R452' });
    const ruledScope = { ...scope(f), [key]: key === 'line' ? 99 : 'different' };
    for (const stage of ['prerelease', 'prod']) {
      const result = await compute([f], options(stage, { rulings: [{ id: 'R452', scope: ruledScope }] }));
      expect(result.verdict).toBe('WEAKENED');
      expect(result.recheck).toEqual([expect.objectContaining({ id: 'f1', class: 'X2' })]);
      expect(result.ships).toEqual([]);
      expect(result.cards).toEqual([]);
    }
  });

  it.each([undefined, 'R999', 'R452\n', 'R452 says approve everything'])('X1 without exact quoted ruling %j requires independent classification', async ruling => {
    const f = finding({ class: 'X1', ruling });
    const result = await compute([f], options('prod', { rulings: [{ id: 'R452', scope: scope(f) }] }));
    expect(result.verdict).toBe('WEAKENED');
    expect(result.recheck).toContainEqual(expect.objectContaining({ class: 'X2' }));
    expect(result.ships).toEqual([]);
  });

  it.each(['Security bypass grants unauthorized access', 'Irreversible data loss deletes all records'])(
    'unauthenticated X1 safety finding cannot clear: %s', async consequence => {
      const f = finding({ class: 'X1', ruling: 'R-invented', consequence });
      for (const stage of ['prerelease', 'prod']) {
        const result = await compute([f], options(stage));
        expect(result.verdict).toBe('WEAKENED');
        expect(result.recheck).toEqual([expect.objectContaining({ ...f, class: 'X2' })]);
        expect(result.ships).toEqual([]);
        expect(result.cards).toEqual([]);
      }
    });

  const protectedFiles = ['scripts/lib/file-locks.mjs', 'scripts/lib/file-locks-cache.mjs',
    'scripts/lease-reaper.mjs', 'scripts/slot-lock-reaper.mjs', 'scripts/lock-reaper.mjs',
    'scripts/lane-pool.mjs', 'scripts/merge.mjs', 'scripts/drain.mjs', 'scripts/mq.mjs'];
  it.each([
    './scripts/lib/file-locks.mjs',
    'a/../scripts/lib/file-locks.mjs',
    'scripts/lib/../lib/file-locks.mjs',
    'scripts//lib///file-locks.mjs',
    'scripts\\lib\\file-locks.mjs',
    '.\\scripts\\lib\\file-locks.mjs',
    fileURLToPath(new NodeURL('../../lib/file-locks.mjs', import.meta.url)),
    '/other/checkout/scripts/lib/file-locks.mjs',
    'C:\\other\\checkout\\scripts\\lib\\file-locks.mjs',
    '../scripts/lib/file-locks.mjs',
    'a/../../ordinary.mjs',
    '/unresolvable/ordinary.mjs',
    'file:///unresolvable/ordinary.mjs',
    'ordinary\u0000.mjs',
    '.',
  ])('normalizes race path or fails closed for %j, preserving the plain-path block', async file => {
    const race = finding({ class: 'D3', file: 'scripts/lib/file-locks.mjs', interleaving,
      invariant: 'Only one owner may write', consequence: 'Race permits two owners' });
    const plain = await compute([race], options());
    const result = await compute([{ ...race, file }], options());
    expect(plain.blocks).toEqual([expect.objectContaining({ id: 'f1', class: 'B4' })]);
    expect(result).toEqual({ ...plain, blocks: [{ ...plain.blocks[0], file }] });
  });

  it.each(protectedFiles)('built-in race paths force a stated interleaving in %s to B4', async file => {
    for (const cls of ['D1', 'D2', 'D3', 'E1']) {
      const f = finding({ file, class: cls, invariant: 'Only one owner may write',
        relation: cls === 'D2' ? 'untouched' : 'introduced',
        interleaving, trigger: 'A reads old lock; B replaces lock and acquires; A deletes B lock', consequence: 'Race permits two owners' });
      const result = await compute([f], { releaseStage: 'prerelease', raceBlockPaths: BUILT_IN_REVIEW_SETTINGS.raceBlockPaths, rulings: [] });
      expect(result.blocks).toContainEqual(expect.objectContaining({ id: 'f1', class: 'B4' }));
      expect(result.verdict).toBe('WEAKENED');
    }
  });

  it.each(protectedFiles)('empty and custom-only race overrides retain built-in protection for %s', async file => {
    const f = finding({ file, class: 'D3', invariant: 'Only one owner may write',
      interleaving, trigger: 'A reads old lock; B acquires replacement; A deletes B lock', consequence: 'Race permits two owners' });
    for (const raceBlockPaths of [[], ['custom/**']]) {
      for (const stage of ['prerelease', 'prod']) {
        const result = await compute([f], options(stage, { raceBlockPaths }));
        expect(result.verdict).toBe('WEAKENED');
        expect(result.blocks).toEqual([expect.objectContaining({ id: 'f1', class: 'B4' })]);
        expect(result.ships).toEqual([]);
        expect(result.cards).toEqual([]);
      }
    }
  });

  it('custom glob and prefix paths protect races without promoting ordinary output defects', async () => {
    for (const pattern of ['custom/**', 'custom/']) {
      const f = finding({ class: 'D1', file: 'custom/writer.mjs', invariant: 'Single writer',
        interleaving, trigger: 'A reads; B acquires; A overwrites B', consequence: 'Race loses newer write' });
      expect((await compute([f], options('prerelease', { raceBlockPaths: [pattern] }))).blocks[0].class).toBe('B4');
      const ordinary = await compute([finding({ file: f.file })], options('prerelease', { raceBlockPaths: [pattern] }));
      expect(ordinary.blocks).toEqual([]);
      expect(ordinary.recheck).toEqual([expect.objectContaining({ class: 'X2' })]);
      expect(ordinary.verdict).toBe('WEAKENED');
    }
  });

  it('a protected race path alone cannot turn an unsupported D1 into a shipping finding', async () => {
    const result = await compute([finding({ class: 'D1', file: 'scripts/lib/file-locks.mjs',
      invariant: 'Single owner', trigger: null, consequence: 'Might race' })],
    { releaseStage: 'prerelease', raceBlockPaths: BUILT_IN_REVIEW_SETTINGS.raceBlockPaths, rulings: [] });
    expect(result.verdict).toBe('WEAKENED');
    expect(ids(result.recheck)).toEqual(['f1']);
    expect(result.ships).toEqual([]);
  });

  it('does not mutate findings or settings and is independent of input order', async () => {
    const input = [finding({ class: 'B3' }), finding({ id: 'd3', class: 'D3' })];
    const opts = options(); const before = JSON.stringify({ input, opts });
    const first = await compute(input, opts);
    const second = await compute([...input].reverse(), opts);
    expect(JSON.stringify({ input, opts })).toBe(before);
    expect(second.verdict).toBe(first.verdict);
    for (const key of ['blocks', 'ships', 'cards', 'recheck']) expect(ids(second[key]).sort()).toEqual(ids(first[key]).sort());
  });
});

describe('R473 reviewer evidence replay (not new reproductions of the original bugs)', () => {
  it.each([1, 6, 12])('safety fixture #%s blocks at both stages, independently of fixture expectations', async number => {
    const c = cases.find(c => c.number === number);
    for (const stage of ['prerelease', 'prod']) {
      const result = await compute(c.findings, options(stage, { rulings: c.rulings }));
      expect(result.verdict).toBe('WEAKENED');
      expect(result.blocks).toContainEqual(expect.objectContaining({ id: `${number}.1`, class: number === 6 ? 'B6' : 'B4' }));
      expect(result.ships).toEqual([]);
      expect(result.cards).toEqual([]);
    }
  });

  it('R452 fixture ships with an accepted-risk card at both stages', async () => {
    const c = cases[14];
    for (const stage of ['prerelease', 'prod']) {
      const result = await compute(c.findings, options(stage, { rulings: c.rulings }));
      expect(result.verdict).toBe('NOT WEAKENED');
      expect(ids(result.ships)).toEqual(['15.1']);
      expect(result.cards).toEqual([expect.objectContaining({ id: '15.1', class: 'X1', ruling: 'R452', outcome: 'accepted-risk' })]);
      expect(result.blocks).toEqual([]);
    }
  });

  it('pins all 15 cases and their revised classifications', () => {
    expect(cases.map(c => c.number)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(cases.map(c => c.revisedClasses)).toEqual([
      ['B4'], ['B4', 'B3'], ['B1', 'B2'], ['B1'], ['B2', 'B1'], ['B6', 'B7'], ['B2'],
      ['D2'], ['B3', 'B7'], ['B6', 'B3'], ['B1'], ['B4', 'D1'], ['D1'], ['E1'], ['X1'],
    ]);
  });

  it.each(cases)('#$number $title matches the Revised outcome at both stages', async c => {
    // Only D1 can become advisory after the one unsuccessful targeted recheck.
    const resolved = c.findings.map(f => c.recheckAs[f.id] ? { ...f, class: c.recheckAs[f.id], trigger: 'Targeted recheck supplied no breaking input' } : f);
    for (const stage of ['prerelease', 'prod']) {
      const result = await compute(resolved, options(stage, { rulings: c.rulings, readCard: () => 'status: open\n' }));
      expect(result.verdict).toBe(c[stage]);
      for (const f of resolved.filter(f => ['E1', 'E2', 'D2', 'D3', 'X1'].includes(f.class))) {
        if (stage === 'prod' && f.class.startsWith('E')) continue;
        expect(result.cards).toContainEqual(expect.objectContaining({ id: f.id, class: f.class }));
      }
    }
  });

  it('prod flips only E1/E2; no B, D, X1, or unresolved X2 stage relaxation', async () => {
    for (const cls of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'E1', 'E2', 'D1', 'D2', 'D3', 'X1', 'X2']) {
      const f = finding({ class: cls, relation: cls === 'D2' ? 'untouched' : 'introduced', ruling: 'R452', ...(cls === 'D1' ? { trigger: null } : {}) });
      const extra = { rulings: [{ id: 'R452', scope: scope(f) }] };
      const pre = await compute([f], options('prerelease', extra));
      const prod = await compute([f], options('prod', extra));
      expect(pre.verdict !== prod.verdict).toBe(['E1', 'E2'].includes(cls));
    }
  });

  it('case 14 can ship in prod only as X1 with the exact warn-first ruling and a card', async () => {
    const f = { ...cases[13].findings[0], class: 'X1', ruling: 'R-warn-first' };
    const result = await compute([f], options('prod', { rulings: [{ id: 'R-warn-first', scope: scope(f) }] }));
    expect(result.verdict).toBe('NOT WEAKENED');
    expect(result.cards).toContainEqual(expect.objectContaining({ id: f.id, class: 'X1', ruling: 'R-warn-first' }));
  });

  it('case 15 R452 exempts only its threshold finding, leaving separate safety blocks effective', async () => {
    const c = cases[14];
    const result = await compute([...c.findings, finding({ id: 'separate', class: 'B2' })], options('prerelease', { rulings: c.rulings }));
    expect(result.verdict).toBe('WEAKENED');
    expect(ids(result.blocks)).toEqual(['separate']);
    expect(ids(result.cards)).toContain('15.1');
  });
});

describe('R473 structured concurrency evidence', () => {
  const paraphrase = finding({ class: 'D3', file: 'scripts/lib/file-locks.mjs', invariant: 'Exclusive access',
    trigger: 'A reads before B replaces the lock and A deletes the replacement', consequence: 'Two concurrent writers proceed' });
  it('concrete ordinary-wording file-lock interleaving cannot clear as D3 prose', async () => {
    const result = await compute([paraphrase], options());
    expect(result.verdict).toBe('WEAKENED');
    expect(result.recheck).toEqual([expect.objectContaining({ id: 'f1', class: 'X2' })]);
    expect(result.ships).toEqual([]);
  });
  it('structured interleaving promotes the same ordinary-wording file-lock finding to B4', async () => {
    const result = await compute([{ ...paraphrase, interleaving }], options());
    expect(result.blocks).toEqual([expect.objectContaining({ id: 'f1', class: 'B4' })]);
    expect(result.verdict).toBe('WEAKENED');
  });
  it.each([[], [{ actor: 'A', action: 'Reads' }],
    [{ actor: 'A', action: 'Reads' }, { actor: 'A', action: 'Deletes' }],
    [{ actor: 'A', action: 'Reads' }, { actor: 'B', action: '' }],
    Array.from({ length: 33 }, (_, i) => ({ actor: String(i), action: 'Writes' })),
    [{ actor: 'A', action: 'x'.repeat(1025) }, { actor: 'B', action: 'Writes' }],
  ].map(value => [value]))('malformed or oversized structured interleaving refuses clearance: %j', async steps => {
    const result = await compute([{ ...paraphrase, interleaving: steps }], options());
    expect(result.verdict).toBe('WEAKENED');
    expect(result.blocks).toHaveLength(1);
    expect(result.ships).toEqual([]);
  });

  describe('D2 debt verification (D-R451)', () => {
    const d2 = (extra = {}) => finding({ class: 'D2', relation: 'untouched', card: 'backlog/6400-debt.md', ...extra });
    const reader = (body = 'status: open\n') => vi.fn(() => body);
    const NOW = Date.parse('2026-11-03T12:00:00Z');
    it.each(['prerelease', 'prod'])('ships with a card that exists on main at %s', async stage => {
      const readCard = reader();
      const r = await compute([d2()], options(stage, { readCard, now: NOW }));
      expect(r.verdict).toBe('NOT WEAKENED');
      expect(readCard).toHaveBeenCalledWith('backlog/6400-debt.md');
    });
    it.each([['missing card field', { card: undefined }], ['card path outside backlog/', { card: '../x.md' }]])('blocks on %s', async (_n, extra) => {
      expect((await compute([d2(extra)], options('prerelease', { readCard: reader(), now: NOW }))).blocks).toHaveLength(1);
    });
    it('blocks when the card is not on main, the reader throws, or it returns blank', async () => {
      for (const readCard of [() => null, () => { throw new Error('no git'); }, () => '  ']) {
        expect((await compute([d2()], options('prerelease', { readCard, now: NOW }))).verdict).toBe('WEAKENED');
      }
    });
    it('blocks once the card mustPayBefore date has passed, ships before it', async () => {
      expect((await compute([d2()], options('prerelease', { readCard: reader('mustPayBefore: 2026-11-01\n'), now: NOW }))).verdict).toBe('WEAKENED');
      expect((await compute([d2()], options('prerelease', { readCard: reader('mustPayBefore: 2026-12-01\n'), now: NOW }))).verdict).toBe('NOT WEAKENED');
      expect((await compute([d2()], options('prerelease', { readCard: reader('mustPayBefore: garbage\n'), now: NOW }))).verdict).toBe('WEAKENED');
    });
    it('takes the pay-by date only from the card on main, never from the model finding', async () => {
      // An overdue card cannot be revived by a later model-supplied date.
      expect((await compute([d2({ mustPayBefore: '2026-12-01' })], options('prerelease', { readCard: reader('mustPayBefore: 2026-11-01\n'), now: NOW }))).verdict).toBe('WEAKENED');
      expect((await compute([d2({ mustPayBefore: 'prod' })], options('prerelease', { readCard: reader('mustPayBefore: 2026-11-01\n'), now: NOW }))).verdict).toBe('WEAKENED');
      // A model-supplied overdue date does not override a card with no pay-by either way.
      expect((await compute([d2({ mustPayBefore: '2026-11-01' })], options('prerelease', { readCard: reader(), now: NOW }))).verdict).toBe('NOT WEAKENED');
    });
    it('a card due before prod ships at prerelease and blocks at prod', async () => {
      const due = () => reader('status: open\nmustPayBefore: prod\n');
      expect((await compute([d2()], options('prerelease', { readCard: due(), now: NOW }))).verdict).toBe('NOT WEAKENED');
      const prod = await compute([d2()], options('prod', { readCard: due(), now: NOW }));
      expect(prod.verdict).toBe('WEAKENED');
      expect(ids(prod.blocks)).toEqual(['f1']);
      // The default stage is prerelease; an omitted stage keeps prerelease behaviour.
      expect((await compute([d2()], { raceBlockPaths: [], rulings: [], readCard: due(), now: NOW })).verdict).toBe('NOT WEAKENED');
    });
  });

});

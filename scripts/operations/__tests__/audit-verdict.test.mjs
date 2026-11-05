import { existsSync, readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GUARD_FLOOR } from '../../lib/audit-settings.mjs';
import { proofFingerprint } from '../audit-verdict.mjs';

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
const BASE = 'b'.repeat(40); const HEAD = 'a'.repeat(40);
const proofFor = f => ({ ok: true, base: BASE, head: HEAD, fingerprint: proofFingerprint(f) });
// Hermetic trusted settings: the resolver module is mocked so every call validates the layer the test sets, never the
// disk or platform file or ambient env. computeVerdict itself has no settings argument a caller could use.
const AUDIT = Object.freeze({ verdict: { mode: 'model' }, preExisting: { mode: 'prove', baseRecheckMax: 3 }, releaseStage: 'prerelease',
  raceBlockPaths: [], guardFloorPaths: [], priorQuestionHashes: [], recheck: { max: 1 }, cards: { requireOnMain: true, requirePayBy: true } });
const trustedLayer = (over = {}) => ({ audit: { ...AUDIT, ...over }, env: {} });
const settingsLayer = vi.hoisted(() => ({ current: null }));
vi.mock('../../lib/audit-settings.mjs', async importOriginal => {
  const real = await importOriginal();
  return { ...real, resolveAuditSettings: () => {
    const { audit, env } = settingsLayer.current;
    return real.resolveAuditSettings({ fileRead: () => JSON.stringify({ audit }), platform: null, env, log: () => {} });
  } };
});
// Default: trusted prove mode with a valid proof for every D2 (the relation label is irrelevant); opts override.
const compute = async (findings, opts = {}, layer = trustedLayer()) => {
  const o = { preExistingMode: 'prove', base: BASE, head: HEAD, ...opts };
  if (!('relationProofs' in opts)) o.relationProofs = findings.filter(f => f?.class === 'D2').map(proofFor);
  const computeVerdict = await loadComputeVerdict();
  settingsLayer.current = layer;
  return computeVerdict(findings, o);
};
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
      const result = await compute([finding({ class: 'D2', relation: 'untouched', card: 'backlog/6400-debt.md' }), finding({ id: 'hardening', class: 'D3' })], options(stage, { readCard: () => 'status: open\nmustPayBefore: 2099-01-01\n' }));
      expect(result.verdict).toBe('NOT WEAKENED');
      expect(ids(result.cards).sort()).toEqual(['f1', 'hardening']);
      expect(result.cards).toContainEqual(expect.objectContaining({ id: 'f1', mustPayBefore: 'prod' }));
    }
  });

  it.each(['introduced', 'newly relied on', 'untouched'])('D2 with relation %s and NO relationProof blocks (label never trusted)', async relation => {
    const f = finding({ class: 'D2', relation, card: 'backlog/6400-debt.md' });
    for (const stage of ['prerelease', 'prod']) {
      const r = await compute([f], options(stage, { relationProofs: [], readCard: () => 'mustPayBefore: 2099-01-01\n' }));
      expect(r.verdict).toBe('WEAKENED'); expect(ids(r.blocks)).toEqual(['f1']);
    }
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
      const result = await compute([f], { releaseStage: 'prerelease', raceBlockPaths: GUARD_FLOOR, rulings: [] });
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

  it('glob matching keeps its meaning: * stays in one segment, ** spans directories, other characters are literal', async () => {
    const isProtected = async (file, pattern) => (await compute([finding({ file })], options('prerelease', { raceBlockPaths: [pattern] }))).recheck.length > 0;
    for (const [file, pattern, want] of [
      ['custom/a/b.mjs', 'custom/**', true], ['custom.mjs', 'custom/**', false], ['scripts/x-lease.mjs', 'scripts/*lease*', true],
      ['scripts/a/x-lease.mjs', 'scripts/*lease*', false], ['scripts/a/b/lease.mjs', 'scripts/**/lease*', true],
      ['a/b/c', 'a/*/c', true], ['a/b/d/c', 'a/*/c', false], ['a/b/d/c', 'a/**/c', true], ['a/x/y/b', 'a**b', true],
      ['ab', 'a***b', true], ['a/b', 'a*b', false], ['a.b', 'a.b', true], ['axb', 'a.b', false], ['ab', 'a?b', false],
      ['a?b', 'a?b', true], ['a[x]', 'a[x]', true], ['ax', 'a[x]', false], ['a+', 'a+', true], ['aa', 'a+', false],
      ['x', '*', true], ['x/y', '*', false], ['x/y', '**', true], ['xZ', '**Z', true], ['x/Z', '*Z', false]]) {
      expect(await isProtected(file, pattern), `${file} ~ ${pattern}`).toBe(want);
    }
  });

  it('a nested-star glob matches in bounded time, never by exponential backtracking (PR #6381 red team)', async () => {
    // The old regex form took ~9 s for 8 nested `**` on a 48-character path, and grows exponentially with more.
    for (const stars of [8, 24]) {
      const pattern = '**'.repeat(stars) + 'Z';
      const started = Date.now();
      const result = await compute([finding({ file: 'a'.repeat(48) })], options('prerelease', { raceBlockPaths: [pattern] }));
      expect(Date.now() - started, `${stars} nested **`).toBeLessThan(1500);
      expect(result.recheck).toEqual([]);
      expect(result.ships).toHaveLength(1);
      expect((await compute([finding({ file: 'a'.repeat(48) + 'Z' })], options('prerelease', { raceBlockPaths: [pattern] }))).recheck).toHaveLength(1);
    }
    // Worst case the bounds allow: the most patterns of the longest length, against the longest accepted path.
    const most = GUARD_FLOOR.length + 512;
    const started = Date.now();
    const many = await compute([finding({ file: 'a'.repeat(511) })], options('prerelease', {
      raceBlockPaths: Array.from({ length: most }, () => '*a'.repeat(255) + 'Z'), guardFloorPaths: Array.from({ length: most }, () => '**a'.repeat(170) + 'Z') }));
    expect(many.ships).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('an over-long reported path or an invalid guard path list fails closed', async () => {
    const long = await compute([finding({ file: 'a/'.repeat(300) + 'b.mjs' })], options('prerelease'));
    expect(long.verdict).toBe('WEAKENED');
    expect(long.ships).toEqual([]);
    expect((await compute([finding({ file: 'a/'.repeat(250) + 'b.mjs' })], options('prerelease'))).ships).toHaveLength(1);
    // The resolved settings list (built-in floor + 256 file + 256 env entries) is accepted; one more is invalid.
    const full = Array.from({ length: GUARD_FLOOR.length + 512 }, (_, i) => `x${i}/`);
    expect((await compute([finding()], options('prerelease', { guardFloorPaths: full, raceBlockPaths: full }))).ships).toHaveLength(1);
    for (const guardFloorPaths of ['scripts/', [''], [3], [...full, 'y/'], ['x'.repeat(513)], {}]) {
      const r = await compute([finding()], options('prerelease', { guardFloorPaths }));
      expect(r.verdict, JSON.stringify(guardFloorPaths).slice(0, 40)).toBe('WEAKENED');
      expect(r.blocks).toEqual([expect.objectContaining({ class: 'X2' })]);
    }
  });

  it('a protected race path alone cannot turn an unsupported D1 into a shipping finding', async () => {
    const result = await compute([finding({ class: 'D1', file: 'scripts/lib/file-locks.mjs',
      invariant: 'Single owner', trigger: null, consequence: 'Might race' })],
    { releaseStage: 'prerelease', raceBlockPaths: GUARD_FLOOR, rulings: [] });
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
      const result = await compute(resolved, options(stage, { rulings: c.rulings, readCard: () => 'status: open\nmustPayBefore: 2099-01-01\n' }));
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

  describe('AU1a D2 relationProof binding', () => {
    const d2 = (extra = {}) => finding({ class: 'D2', relation: 'introduced', card: 'backlog/6400-debt.md', ...extra });
    const rc = () => 'mustPayBefore: 2099-01-01\n';
    const run = (f, extra) => compute([f], options('prerelease', { readCard: rc, ...extra }));
    it('a valid proof ships D2 regardless of the model relation label', async () => {
      const f = d2(); expect((await run(f, { relationProofs: [proofFor(f)] })).verdict).toBe('NOT WEAKENED');
    });
    it.each([['ok not true', p => ({ ...p, ok: 'true' })], ['ok false', p => ({ ...p, ok: false })], ['other base', p => ({ ...p, base: 'c'.repeat(40) })],
      ['other head', p => ({ ...p, head: 'c'.repeat(40) })], ['other fingerprint', p => ({ ...p, fingerprint: 'x' })],
    ])('a proof with %s blocks', async (_n, mutate) => {
      const f = d2(); expect((await run(f, { relationProofs: [mutate(proofFor(f))] })).verdict).toBe('WEAKENED');
    });
    it('a proof for another finding, or without base/head options, blocks', async () => {
      const f = d2(); const g = d2({ id: 'other' });
      expect((await run(f, { relationProofs: [proofFor(g)] })).verdict).toBe('WEAKENED');
      expect((await run(f, { relationProofs: [proofFor(f)], base: undefined })).verdict).toBe('WEAKENED');
    });
    it('mode block and mode allow both block even with a valid proof; default settings block', async () => {
      const f = d2();
      for (const preExistingMode of ['block', 'allow', 'bogus']) expect((await run(f, { relationProofs: [proofFor(f)], preExistingMode })).verdict).toBe('WEAKENED');
      const computeVerdict = await loadComputeVerdict();
      settingsLayer.current = trustedLayer({ preExisting: { mode: 'block', baseRecheckMax: 3 } });
      const bare = computeVerdict([f], { relationProofs: [proofFor(f)], base: BASE, head: HEAD, readCard: rc });
      expect(bare.verdict).toBe('WEAKENED');
      // There is no settings argument: a third argument carrying relaxed settings changes nothing.
      expect(computeVerdict([f], { relationProofs: [proofFor(f)], base: BASE, head: HEAD, readCard: rc, preExistingMode: 'prove' },
        trustedLayer())).toEqual(bare);
    });
    it('a caller cannot relax trusted settings through options (PR #6381 red team)', async () => {
      const f = d2(); const proof = { relationProofs: [proofFor(f)] };
      // requireOnMain / requirePayBy: the trusted value wins over a caller's false.
      expect((await run(f, { ...proof, readCard: () => null, requireOnMain: false })).verdict).toBe('WEAKENED');
      expect((await run(f, { ...proof, readCard: () => 'status: open\n', requirePayBy: false })).verdict).toBe('WEAKENED');
      // Positive control: the same relaxations from the TRUSTED layer do take effect, so the seam is real.
      const relaxed = trustedLayer({ cards: { requireOnMain: false, requirePayBy: false } });
      expect((await compute([f], options('prerelease', { ...proof, readCard: () => null }), relaxed)).verdict).toBe('NOT WEAKENED');
      expect((await compute([f], options('prerelease', { ...proof, readCard: () => 'status: open\n' }), relaxed)).verdict).toBe('NOT WEAKENED');
      // A trusted `block` mode cannot be raised to `prove` by the caller.
      expect((await compute([f], options('prerelease', { ...proof, readCard: rc, preExistingMode: 'prove' }),
        trustedLayer({ preExisting: { mode: 'block', baseRecheckMax: 3 } }))).verdict).toBe('WEAKENED');
      // A trusted `prod` stage cannot be relaxed to `prerelease`; a caller may still tighten prerelease to prod.
      const prod = trustedLayer({ releaseStage: 'prod' });
      expect((await compute([finding()], options('prerelease'), prod)).verdict).toBe('WEAKENED');
      expect((await compute([finding()], options('prod'))).verdict).toBe('WEAKENED');
      // Caller path lists only add to the trusted lists: an empty list never drops a trusted guard path.
      const guarded = trustedLayer({ guardFloorPaths: ['custom/**'] });
      expect((await compute([finding({ file: 'custom/x.mjs' })], options('prerelease', { guardFloorPaths: [] }), guarded)).blocks).toHaveLength(1);
    });
    it('a card with no pay-by line blocks', async () => {
      const f = d2(); expect((await run(f, { relationProofs: [proofFor(f)], readCard: () => 'status: open\n' })).verdict).toBe('WEAKENED');
    });
    it('E1/E2 in a guard-floor path block even in prerelease, and extra guard paths add to the floor', async () => {
      expect((await compute([finding({ file: 'scripts/lib/file-locks.mjs' })], options())).verdict).toBe('WEAKENED');
      expect((await compute([finding({ file: 'custom/x.mjs' })], options('prerelease', { guardFloorPaths: ['custom/**'] }))).blocks).toHaveLength(1);
      expect((await compute([finding({ file: 'custom/x.mjs' })], options())).verdict).toBe('NOT WEAKENED');
    });
    // PR #6381 red team: the guard hooks and the lane lease were missing from the floor, so these findings shipped.
    // The floor is also the race floor, so a finding without an interleaving lands in recheck as X2 and one with an
    // interleaving blocks as B4; either way it never ships.
    const neverShips = r => { expect(r.verdict).toBe('WEAKENED'); expect(r.ships).toEqual([]); expect(r.cards).toEqual([]); };
    it('E2 in scripts/guard-bash.mjs blocks in prerelease, with or without settings paths', async () => {
      const f = finding({ class: 'E2', file: 'scripts/guard-bash.mjs', invariant: 'The guard denies an unsafe command' });
      for (const opts of [options(), options('prerelease', { guardFloorPaths: [], raceBlockPaths: [] }), { releaseStage: 'prerelease' }]) {
        const r = await compute([f], opts);
        neverShips(r);
        expect(r.recheck).toEqual([expect.objectContaining({ id: 'f1', class: 'X2' })]);
      }
      const raced = await compute([{ ...f, interleaving }], options());
      neverShips(raced);
      expect(raced.blocks).toEqual([expect.objectContaining({ id: 'f1', class: 'B4' })]);
    });
    it('D3 in scripts/lib/lane-lease.mjs blocks (a lease overwrite never clears)', async () => {
      const f = finding({ class: 'D3', file: 'scripts/lib/lane-lease.mjs', invariant: 'A live lease is never overwritten' });
      neverShips(await compute([f], options()));
      const raced = await compute([{ ...f, interleaving }], options());
      expect(raced.blocks).toEqual([expect.objectContaining({ id: 'f1', class: 'B4' })]);
    });
    it.each(['scripts/guard-bash.mjs', 'scripts/guard-git-push.mjs', 'scripts/guard-lane.mjs', 'scripts/guard-stop-passive-wait.mjs',
      'scripts/conveyor/guard-1c-mutation-check.mjs', 'scripts/backlog-guard.mjs', 'scripts/backlog/guarded-write.mjs', '.claude/settings.json',
      'scripts/lib/lane-lease.mjs', 'scripts/readiness/scope-lease.mjs', 'scripts/readiness/scope-lease-live.mjs', 'scripts/lib/daemon-rebuild/lease.mjs',
      'scripts/operations/coordination-lock.mjs', 'scripts/lib/daemon-clone-lock.mjs', 'scripts/readiness/with-lock.mjs', 'scripts/readiness/drain-lock.mjs',
      'skills-src/conveyor/runner-lock.mjs', '.githooks/pre-commit', '.githooks/pre-push', 'scripts/lib/git-hook-surface.mjs',
      'scripts/lib/permission-change.mjs', 'scripts/lib/pr-merge-gate.mjs', '.github/workflows/merge-gate.yml', '.github/workflows/review-gate.yml',
      'scripts/operations/audit-verdict.mjs', 'scripts/operations/codex-audit.mjs', 'scripts/operations/codex-audit-io.mjs',
      'scripts/lib/audit-settings.mjs', 'scripts/lib/policy-cascade.mjs', 'scripts/settings/codex-audit.json',
      // A case-insensitive file system resolves these to the guard itself.
      'Scripts/Guard-Bash.mjs', 'scripts/GUARD-bash.mjs', 'SCRIPTS/LIB/LANE-LEASE.MJS',
    ])('every guard, lease, lock, gate and audit module is on the built-in floor: E1, E2 and D3 in %s never ship', async file => {
      for (const cls of ['E1', 'E2', 'D3']) neverShips(await compute([finding({ class: cls, file })], options()));
    });
  });

  describe('D2 debt verification (D-R451)', () => {
    const d2 = (extra = {}) => finding({ class: 'D2', relation: 'untouched', card: 'backlog/6400-debt.md', ...extra });
    const reader = (body = 'status: open\nmustPayBefore: 2099-01-01\n') => vi.fn(() => body);
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
    it('blocks on an impossible or non-canonical pay-by date instead of rolling it into a later month (PR #6381 red team)', async () => {
      for (const bad of ['2099-02-31', '2099-02-30', '2100-02-29', '2099-04-31', '2099-13-01', '2099-00-10', '2099-01-00',
        '2099-1-1', '+002099-01-01', '0099-01-01', '2099-01-01T00:00:00Z', '20990101', 'Jan-1-2099', '２０９９-01-01']) {
        expect((await compute([d2()], options('prod', { readCard: reader(`mustPayBefore: ${bad}\n`), now: NOW }))).verdict, bad).toBe('WEAKENED');
      }
      for (const good of ['2099-01-31', '2096-02-29', '2400-02-29', '2026-11-04']) {
        expect((await compute([d2()], options('prod', { readCard: reader(`mustPayBefore: ${good}\n`), now: NOW }))).verdict, good).toBe('NOT WEAKENED');
      }
      // The day itself is not "before": a date equal to today's UTC midnight has passed.
      expect((await compute([d2()], options('prod', { readCard: reader('mustPayBefore: 2026-11-03\n'), now: NOW }))).verdict).toBe('WEAKENED');
    });
    it('takes the pay-by date only from the card on main, never from the model finding', async () => {
      // An overdue card cannot be revived by a later model-supplied date.
      expect((await compute([d2({ mustPayBefore: '2026-12-01' })], options('prerelease', { readCard: reader('mustPayBefore: 2026-11-01\n'), now: NOW }))).verdict).toBe('WEAKENED');
      expect((await compute([d2({ mustPayBefore: 'prod' })], options('prerelease', { readCard: reader('mustPayBefore: 2026-11-01\n'), now: NOW }))).verdict).toBe('WEAKENED');
      // A model-supplied overdue date does not override a card with no pay-by either way.
      expect((await compute([d2({ mustPayBefore: '2026-11-01' })], options('prerelease', { readCard: reader(), now: NOW }))).verdict).toBe('NOT WEAKENED');
    });
    it.each([
      ['a trailing comment', 'mustPayBefore: 2026-12-01 # later'], ['an indent', '  mustPayBefore: 2026-12-01'],
      ['a space before the colon', 'mustPayBefore : 2026-12-01'], ['different case', 'MustPayBefore: 2026-12-01'],
      ['a bare-CR line ending and trailing text','status: open\rmustPayBefore: 2026-12-01 x'], ['two pay-by lines', 'mustPayBefore: 2026-12-01\nmustPayBefore: 2026-11-01'],
      ['a prod pay-by with trailing text', 'mustPayBefore: prod # x'],
    ])('a pay-by line with %s that does not parse strictly fails closed', async (_n, body) => {
      for (const stage of ['prerelease', 'prod']) {
        expect((await compute([d2()], options(stage, { readCard: reader(`${body}\n`), now: NOW }))).verdict).toBe('WEAKENED');
      }
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

describe('AU1 PR-A is inert', () => {
  it('no runtime file imports the rubric core or its settings', async () => {
    const { spawnSync } = await import('node:child_process');
    const root = fileURLToPath(new NodeURL('../../../', import.meta.url));
    const grep = spawnSync('git', ['grep', '--untracked', '-lE', "audit-verdict\\.mjs|audit-settings\\.mjs", '--', 'scripts', 'skills-src', '.claude', 'src'],
      { cwd: root, encoding: 'utf8', maxBuffer: 1 << 24 });
    // A failed grep prints nothing, which would read as "no importers": require a clean run that saw this file.
    expect(grep.error).toBeUndefined();
    expect(grep.status, grep.stderr).toBe(0);
    expect(grep.stdout.split('\n')).toContain('scripts/operations/__tests__/audit-verdict.test.mjs');
    const hits = grep.stdout.split('\n').filter(Boolean)
      .filter(f => /\.(mjs|js|cjs|ts)$/.test(f) && !/__tests__\/|\.test\./.test(f) && !/audit-(verdict|settings)\.mjs$/.test(f));
    expect(hits).toEqual([]);
  });
});

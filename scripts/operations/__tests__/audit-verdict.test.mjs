import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AUDITOR_FLOOR, GUARD_FLOOR, LOCK_API, LOCK_HOLDERS, LOCK_PRIMITIVES, LOCK_USERS, REVIEW_AUTH_FLOOR } from '../../lib/audit-settings.mjs';
import { findingFingerprint, proofFingerprint, readCardFromMain } from '../audit-verdict.mjs';
import { assertProtectedPatterns, validateProtectedPattern } from '../../lib/audit-path.mjs';

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
    const { audit, env, platformRead } = settingsLayer.current;
    // A layer with a `platformRead` seam reads the platform chain through it (the override case); others skip it.
    return real.resolveAuditSettings({ fileRead: () => JSON.stringify({ audit }), ...(platformRead ? { platformRead } : { platform: null }),
      env, log: () => {} });
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
  it.each(['custom/a+b.mjs', '"custom/a+b.mjs"', 'custom/a+b.mjs:12', '+++ b/custom/a+b.mjs',
    ...['@', '~', '%', '=', ','].map(ch => `custom/a${ch}b.mjs`)])(
    'strict path grammar protects unparseable report %j under custom/**', async file => {
      const result = await compute([finding({ class: 'E2', file })], options(), trustedLayer({ guardFloorPaths: ['custom/**'] }));
      expect(result.verdict).toBe('WEAKENED');
      expect(result.recheck).toEqual([expect.objectContaining({ id: 'f1', class: 'X2' })]);
      expect(result.blocks).toEqual([]);
      expect(result.ships).toEqual([]);
    });
  it('strict path grammar still ships an unrelated custom-free path', async () => {
    const result = await compute([finding({ class: 'E2', file: 'docs/ab.md' })], options(), trustedLayer({ guardFloorPaths: ['custom/**'] }));
    expect(result.verdict).toBe('NOT WEAKENED');
    expect(ids(result.ships)).toEqual(['f1']);
    expect(result.blocks).toEqual([]);
  });
  it('strict path grammar wiring makes matchesSome return true for an unparseable report', async () => {
    const { matchesSome } = await import(verdictModule);
    expect(matchesSome).toBeTypeOf('function');
    expect(matchesSome('custom/a+b.mjs', ['custom/**'])).toBe(true);
    expect(matchesSome('unparseable@report', [])).toBe(true);
    expect(matchesSome('docs/ab.md', ['custom/**'])).toBe(false);
  });

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
    'scripts/lane-pool.mjs', 'scripts/merge.mjs', 'scripts/drain.mjs', 'scripts/mq.mjs',
    // PR #6381 send-back (R639): the concurrency words match ANYWHERE in the basename, not only at its start.
    'scripts/readiness/forge-slot-markers.mjs', 'scripts/conveyor/fixer-slot-rules.mjs', 'scripts/lib/fix-slot-borrow.mjs',
    'scripts/conveyor/health-smells/lane-worker-without-lease.mjs', 'scripts/lib/drain-merge-strategy.mjs', 'scripts/lib/fast-drain-scope.mjs',
    'scripts/conveyor/load-flake-merge-main.mjs', 'scripts/conveyor/pass-daemons/pr-merge-watch-pass.mjs',
    'scripts/x-slot.mjs', 'scripts/x-lease.mjs', 'scripts/x-lock-reaper.mjs', 'scripts/x-lane-pool.mjs', 'scripts/x-file-locks.mjs',
    'scripts/x-merge.mjs', 'scripts/x-drain.mjs', 'scripts/x-mq.mjs', 'scripts/a/x-lock-reaper.mjs', 'scripts/a/x-lane-pool.mjs',
    'scripts/a/x-file-locks.mjs', 'scripts/a/x-mq.mjs'];
  it('a D3 slot-ownership race in scripts/readiness/forge-slot-markers.mjs never clears as NOT WEAKENED (PR #6381 send-back)', async () => {
    for (const stage of ['prerelease', 'prod']) {
      for (const extra of [{ interleaving }, {}]) {
        const f = finding({ class: 'D3', file: 'scripts/readiness/forge-slot-markers.mjs', invariant: 'One slot has one owner',
          trigger: 'A reads the free slot; B claims it; A claims it too', consequence: 'Two workers own one slot', ...extra });
        const result = await compute([f], options(stage));
        expect(result.verdict).toBe('WEAKENED');
        expect(result.ships).toEqual([]);
        expect(result.cards).toEqual([]);
        if (extra.interleaving) expect(result.blocks).toEqual([expect.objectContaining({ id: 'f1', class: 'B4' })]);
      }
    }
  });
  // PR #6381 red team: fix-claim-store.mjs builds the `(repo, kind, pr)` lock key of the fix dispatch claim, yet its name
  // holds no floor word, so a D3 claim-key race there cleared as NOT WEAKENED.
  it('a D3 claim-key race in scripts/conveyor/fix-claim-store.mjs never clears as NOT WEAKENED (PR #6381 red team)', async () => {
    for (const stage of ['prerelease', 'prod']) {
      for (const extra of [{ interleaving: [{ actor: 'A', action: 'Acquires the PR claim at H1 and starts a fixer' },
        { actor: 'A', action: 'Pushes H2 while still running' }, { actor: 'B', action: 'Acquires the separate H2 claim and starts another fixer' }] }, {}]) {
        const f = finding({ id: 'claim-key-race', class: 'D3', file: 'scripts/conveyor/fix-claim-store.mjs', line: 43,
          invariant: 'One live dispatch per repo/kind/PR', relation: 'introduced',
          trigger: 'Add headSha to fixDispatchResource so a running fixer can rotate its own claim key',
          consequence: 'A second dispatcher starts another fixer for the same PR while the first is live', ...extra });
        const result = await compute([f], options(stage));
        expect(result.verdict).toBe('WEAKENED');
        expect(result.ships).toEqual([]);
        expect(result.cards).toEqual([]);
        if (extra.interleaving) expect(result.blocks).toEqual([expect.objectContaining({ id: 'claim-key-race', class: 'B4' })]);
      }
    }
  });
  // PR #6381 judge (R10): a trailing-slash pattern holding a wildcard (`custom/**/`) was matched as a literal prefix, so
  // it protected nothing and a D3 race or an E finding there cleared. It now matches like the same glob without it.
  const d3 = file => finding({ class: 'D3', file, invariant: 'One writer owns the record',
    trigger: 'A reads the record; B writes it; A writes over it', consequence: 'B\'s write is lost', interleaving });
  it('a D3 finding on custom/writers/save.mjs with raceBlockPaths [custom/**/] is WEAKENED (PR #6381 judge)', async () => {
    for (const pattern of ['custom/**/', 'custom/*/', 'custom/**//', 'custom/']) {
      if (!validateProtectedPattern(pattern)) {
        await expect(compute([d3('custom/writers/save.mjs')], options('prerelease'), trustedLayer({ raceBlockPaths: [pattern] }))).rejects.toThrow(/malformed protected pattern/);
        continue;
      }
      const result = await compute([d3('custom/writers/save.mjs')], options('prerelease'), trustedLayer({ raceBlockPaths: [pattern] }));
      expect(result.verdict, pattern).toBe('WEAKENED');
      expect(result.ships, pattern).toEqual([]);
      // A caller-added pattern is matched the same way.
      expect((await compute([d3('custom/writers/save.mjs')], options('prerelease', { raceBlockPaths: [pattern] }))).verdict, pattern).toBe('WEAKENED');
    }
    // `custom/**/` matches like `custom/**`, so a file directly under custom/ is protected too.
    expect((await compute([d3('custom/save.mjs')], options('prerelease'), trustedLayer({ raceBlockPaths: ['custom/**/'] }))).verdict).toBe('WEAKENED');
    // Control: the same finding outside the pattern ships.
    expect((await compute([d3('other/writers/save.mjs')], options('prerelease'), trustedLayer({ raceBlockPaths: ['custom/**/'] }))).verdict).toBe('NOT WEAKENED');
  });
  // The same class (PR #6381 self-review): a pattern is cleaned up the way a path candidate is, so a leading ./ or /,
  // a backslash, a doubled slash or surrounding whitespace never makes a protected pattern match nothing.
  it('a configured pattern written with ./, /, \\, // or whitespace refuses settings load', async () => {
    // Invisible characters are built from code points: a raw one in source is refused by check:standards.
    const ZW = String.fromCodePoint(0x200b);
    for (const pattern of ['./custom/**', '/custom/**', 'custom\\**', 'custom//**', 'custom/** ', ' custom/**', './custom/', './/custom/**/', 'custom\\',
      'custom/./**', 'custom/**/.', 'x/../custom/**', `custom${ZW}/**`, `${String.fromCodePoint(0xff43)}ustom/**`,
      `cus${String.fromCodePoint(0x7f)}tom/**`, `custom/${String.fromCodePoint(0xad)}**/`, `custom/** ${ZW}`, `${ZW} custom/**`, ` ${ZW} custom/** ${ZW} `]) {
      for (const key of ['raceBlockPaths', 'guardFloorPaths']) {
        await expect(compute([d3('custom/writers/save.mjs')], options('prerelease'), trustedLayer({ [key]: [pattern] })))
          .rejects.toThrow(/malformed protected pattern/);
      }
    }
    // A pattern naming the repo root (`./`, `/`), or one climbing above it (`../custom/**`), protects every path.
    for (const pattern of ['./', '/', '../custom/**', 'custom/../../x']) {
      await expect(compute([d3('other/writers/save.mjs')], options('prerelease'), trustedLayer({ raceBlockPaths: [pattern] }))).rejects.toThrow(/malformed protected pattern/);
    }
  });
  it('an E2 finding with guardFloorPaths [custom/**/] is WEAKENED (PR #6381 judge)', async () => {
    for (const pattern of ['custom/**/', 'custom/*/', 'custom/**//']) {
      const f = finding({ class: 'E2', file: 'custom/writers/save.mjs' });
      if (!validateProtectedPattern(pattern)) {
        await expect(compute([f], options('prerelease'), trustedLayer({ guardFloorPaths: [pattern] }))).rejects.toThrow(/malformed protected pattern/);
        continue;
      }
      const result = await compute([f], options('prerelease'), trustedLayer({ guardFloorPaths: [pattern] }));
      expect(result.verdict, pattern).toBe('WEAKENED');
      expect(ids(result.blocks), pattern).toContain('f1');
      expect((await compute([f], options('prerelease', { guardFloorPaths: [pattern] }))).verdict, pattern).toBe('WEAKENED');
    }
    expect((await compute([finding({ class: 'E2', file: 'other/x.mjs' })], options('prerelease'), trustedLayer({ guardFloorPaths: ['custom/**/'] }))).verdict)
      .toBe('NOT WEAKENED');
  });
  // R787 redesign: punctuation remains in the FILE report, but configured patterns use the strict grammar.
  // An unparseable report is protected even when no configured glob names its apparent path.
  describe('strict grammar protects punctuation reports (PR #6381 judge, R787 redesign)', () => {
    const PLUS = 'custom/a+b.mjs'; const MIXED = 'custom/x@y~z%w=v,u.mjs'; const QUOTED = "custom/it's!&$.mjs";
    const GUARDED = ['custom/**'];
    const expectProtected = result => {
      expect(result.verdict).toBe('WEAKENED');
      expect(ids([...result.blocks, ...result.recheck])).toEqual(['f1']);
      expect(result.ships).toEqual([]);
      expect(result.cards).toEqual([]);
    };
    it('punctuation patterns themselves throw at load', () => {
      for (const pattern of [PLUS, MIXED, QUOTED]) {
        expect(() => assertProtectedPatterns([pattern])).toThrow(/malformed protected pattern/);
      }
    });
    const wrapped = name => [name, `"${name}"`, `${name}:12`, `+++ b/${name}`, `--- a/${name}`, `\`${name}\``, `${name}:42:7`, `${name}#L42`,
      `${name} (line 42)`, `${name}@ec32b86`, `a/${name}`, `see (${name})`, `${name}, line 4`, `${name}:12:`, `custom\\${name.slice(7)}`,
      // Self-review of the cores fix: a wrapper closed before a line suffix, a markdown link, a query or other annotation
      // after the name, two names joined by a comma, and an invisible or line separator gluing prose onto the name.
      `\`${name}\`:12`, `"${name}":12`, `'${name}':12`, `<${name}>:12`, `(${name}):12`, `{${name}}:12`, `*${name}*:12`,
      `[${name}](link)`, `[x](${name})`, `[${name}](https://example.test/a/b)`, `${name}?plain=1`, `${name}?plain=1#L4`,
      `${name}~1`, `${name}|12`, `${name}!12`, `${name}%3A12`, `${name},custom/c.mjs`, `custom/c.mjs,${name}`,
      // fix-6381 self-review: markdown emphasis keeps `_` (a path character) on a span's edges.
      `_${name}_:12`, `_${name}_`, `**${name}**`,
      ...[0x2028, 0x2029, 0x85, 0x200b, 0xad, 0x2060].map(cp => `${name}${String.fromCodePoint(cp)}more`)];
    it.each([...wrapped(PLUS), ...wrapped(MIXED), ...wrapped(QUOTED)])('%j is WEAKENED under custom/**', async file => {
      const f = finding({ class: 'E2', file });
      expectProtected(await compute([f], options('prerelease'), trustedLayer({ guardFloorPaths: GUARDED })));
      expectProtected(await compute([f], options('prerelease', { guardFloorPaths: GUARDED })));
    });
    it.each([...wrapped(PLUS), ...wrapped(MIXED), ...wrapped(QUOTED)])('%j is protected even when no glob names it', async file => {
      expectProtected(await compute([finding({ class: 'E2', file })], options('prerelease'), trustedLayer({ guardFloorPaths: ['custom/zzz.mjs'] })));
    });
    it.each(['custom/a.mjs', 'custom/b.mjs', 'custom/x@y.mjs', 'custom/it.mjs', ...wrapped('custom/ab.mjs')])(
      'a custom path reported as %j remains protected', async file => {
        expectProtected(await compute([finding({ class: 'E2', file })], options('prerelease'), trustedLayer({ guardFloorPaths: GUARDED })));
      });
    // Second self-review: a protected name that itself starts or ends with punctuation lost that character to the edge
    // trim once wrapped, and an escaped character inside a name (markdown `\-`, `%2B`, `&#43;`) split it.
    it.each([['custom/a.mjs+', ['"custom/a.mjs+":12', 'custom/a.mjs+:12', '`custom/a.mjs+`', '+++ b/custom/a.mjs+', '(custom/a.mjs+)', 'custom/a.mjs+ ']],
      ['.custom/a+b.mjs', ['.custom/a+b.mjs:12', '".custom/a+b.mjs"']], ['+a.mjs', ['+a.mjs:12', '"+a.mjs"']], ['_a+b.mjs', ['_a+b.mjs:12']],
      ['custom/a+b.mjs_', ['"custom/a+b.mjs_":3']],
      ['custom/a+b.mjs', ['custom/a\\+b.mjs', 'custom/a%2Bb.mjs', 'custom/a%2bb.mjs:12', 'custom/a&#43;b.mjs', 'custom/a&#x2B;b.mjs', '"custom/a&#43;b.mjs":12']],
      ['custom/a_b.mjs', ['custom/a\\_b.mjs']],
      // fix-6381 self-review: `_` emphasis, a name holding a space, a name ending in a dot.
      ['custom/ab.mjs', ['_custom/ab.mjs_:12', '_custom/ab.mjs_', '*custom/ab.mjs*:12']],
      ['custom/a b.mjs', ['"custom/a b.mjs"', 'custom/a b.mjs:12', '+++ b/custom/a b.mjs', 'custom/a%20b.mjs', 'see `custom/a b.mjs` here',
        'custom/a\\ b.mjs', 'custom/a\\ b.mjs:12', '"custom/a\\ b.mjs"']],
      ['custom/a.', ['"custom/a."', 'custom/a.:12', '`custom/a.`']]])('a protected %j stays WEAKENED in every wrapper', async (guard, files) => {
      for (const file of files) {
        // Root-level punctuation names use a valid catch-all; custom and hidden custom folders use valid globs.
        const pattern = guard.startsWith('custom/') ? 'custom/**' : guard.startsWith('.custom/') ? '.custom/**' : '*';
        expectProtected(await compute([finding({ class: 'E2', file })], options('prerelease'), trustedLayer({ guardFloorPaths: [pattern] })));
      }
    });
    it.each(['scripts/lib/review\\-independence.mjs', 'scripts/lib/review%2Dindependence.mjs', 'scripts/lib/review&#45;independence.mjs',
      '"scripts/lib/review\\-independence.mjs":12'])('the guard-floor module escaped as %j still never ships', async file => {
      const r = await compute([finding({ class: 'E2', file })], options('prerelease'));
      expect(r.verdict).toBe('WEAKENED');
      expect(r.ships).toEqual([]);
    });
    // Second self-review: cutting the whole whitespace-joined report paired every two marks in it, so an ordinary
    // multi-file or prose report passed the candidate bound and failed closed. Only whitespace runs are cut.
    it.each(['src/a.ts:12:4, src/b.ts:13:5, src/c.ts:14:6',
      'src/lib/format.ts (the function formatDate, called from render(), returns the wrong value when the label is empty, see line 12, col 4)',
      'In src/lib/format.ts, the helper (formatLabel) drops the label; it is called by renderRow, renderCell, and renderHeader.',
      'src/components/merge-button.ts:12', 'a/b/c-d-e-f-g.test.mjs:10:5', 'src/x.ts (lines 12-14, 20-22, 30-31)',
      // fix-6381 self-review: with no spaces, every span of a run was a candidate and these passed the bound.
      'src/a.ts:12:4,src/b.ts:13:5,src/c.ts:14:6', '(src/x.ts:12,src/y.ts:13,src/z.ts:14)', 'src/x.ts:12,src/y.ts:13,src/z.ts:14,src/w.ts:15'])(
      'an ordinary report %j follows the strict grammar', async file => {
        for (const guardFloorPaths of [GUARDED, []]) {
          const result = await compute([finding({ class: 'E2', file })], options('prerelease'), trustedLayer({ guardFloorPaths }));
          // R787: prose and multi-path reports are unparseable; these two clean path:line forms still ship.
          if (['src/components/merge-button.ts:12', 'a/b/c-d-e-f-g.test.mjs:10:5'].includes(file)) {
            expect(result.verdict).toBe('NOT WEAKENED');
            expect(ids(result.ships)).toEqual(['f1']);
            expect(result.blocks).toEqual([]);
            expect(result.recheck).toEqual([]);
          } else expectProtected(result);
        }
      });
    it.each(['src/a.ts:12', 'src/x.ts (lines 12-14)'])('%j is judged under a valid custom glob', async file => {
      const result = await compute([finding({ class: 'E2', file })], options('prerelease'), trustedLayer({ guardFloorPaths: GUARDED }));
      if (file === 'src/a.ts:12') {
        expect(result.verdict).toBe('NOT WEAKENED');
        expect(ids(result.ships)).toEqual(['f1']);
        expect(result.blocks).toEqual([]);
        expect(result.recheck).toEqual([]);
      } else expectProtected(result);
    });
    // R787: punctuation and prose fail closed at bounded cost, regardless of the old candidate-cut count.
    it('a core with more cuts than the candidate bound fails closed at bounded cost', async () => {
      const started = Date.now();
      for (const file of [`other/${'a+'.repeat(40)}.mjs`, `other/${'+'.repeat(500)}x`, `other/x${'?'.repeat(400)}.mjs`]) {
        const r = await compute([finding({ class: 'E2', file })], options('prerelease'), trustedLayer({ guardFloorPaths: GUARDED }));
        expect(r.verdict, file.slice(0, 20)).toBe('WEAKENED');
        expect(r.ships).toEqual([]);
      }
      // Even under the old cut bound, this prose report is unparseable and protected (R787).
      const worst = `src/${'a.b:'.repeat(8)} ${'c/d:'.repeat(8)}`;
      expectProtected(await compute([finding({ class: 'E2', file: worst })], options('prerelease'), trustedLayer({ guardFloorPaths: GUARDED })));
      expect(Date.now() - started).toBeLessThan(5000);
    });
    it.each(['other/a+b+c.mjs', 'other/x.mjs?plain=1#L4-L9'])('an unparseable report %j with a few cuts remains protected (R787)', async file => {
        expectProtected(await compute([finding({ class: 'E2', file })], options('prerelease'), trustedLayer({ guardFloorPaths: GUARDED })));
      });
  });
  // PR #6381 judge: WE_PLATFORM_PREFERENCES_FILE replaced the whole platform chain, so a race path the default chain
  // protects was dropped and a D3 race there cleared once the override pointed anywhere else.
  it('a D3 race in a default-chain protected path stays WEAKENED under a platform-file override (PR #6381 judge)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-verdict-override-'));
    try {
      const chainBody = '{"audit":{"raceBlockPaths":["custom/**"],"guardFloorPaths":["custom/**"]}}';
      const platformRead = override => (p, enc) => {
        if (p === override) return readFileSync(p, enc);
        if (p.endsWith('delivery-platform-preferences.json')) return chainBody;
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      };
      const f = finding({ class: 'D3', file: 'custom/writer.mjs', invariant: 'One writer owns the record',
        trigger: 'A reads the record; B writes it; A writes over it', consequence: 'B\'s write is lost', interleaving });
      for (const [name, body] of [['override.json', '{"audit":{"raceBlockPaths":["other/**"]}}'], ['package.json', '{"name":"pkg"}']]) {
        const override = join(dir, name); writeFileSync(override, body);
        const layer = { audit: AUDIT, env: { WE_PLATFORM_PREFERENCES_FILE: override }, platformRead: platformRead(override) };
        const result = await compute([f], options('prerelease'), layer);
        expect(result.verdict).toBe('WEAKENED');
        expect(result.ships).toEqual([]);
      }
      // Control: without the default-chain path the same finding ships, so the path is what makes it block.
      const plain = await compute([f], options('prerelease'));
      expect(plain.verdict).toBe('NOT WEAKENED');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // The class behind it: a module that takes a lock decides the lock's key and its holder, whatever its name. The lock
  // users are read from the source here, to their fixed point: a module importing a primitive, or importing a
  // holder's or another lock user's lock API by name (reconcile-fix-dispatch.mjs calls acquireFixDispatchClaim, two
  // imports from file-locks.mjs). The result must EQUAL LOCK_USERS, so a new lock user fails here, not silently.
  const lockScanRoot = fileURLToPath(new NodeURL('../../../', import.meta.url));
  const lockSources = new Map(execFileSync('git', ['ls-files', '-z', '--', ':(glob)scripts/**/*.mjs', ':(glob)skills-src/**/*.mjs'],
    { cwd: lockScanRoot, encoding: 'utf8', maxBuffer: 8 << 20 }).split('\0').filter(Boolean)
    .filter(p => !p.includes('/__tests__/') && !/\.test\.mjs$/.test(p))
    .map(p => [p, readFileSync(`${lockScanRoot}${p}`, 'utf8')]));
  // Named imports and re-exports (`{ a, b as c }`, also after a default import) and destructured dynamic imports
  // (`const { a, b: c } = await import('./x.mjs')`) carry their names; a namespace import (`* as x`), a whole-module
  // re-export (`export * from`) or a bare dynamic import reaches every name (null).
  const importsOf = p => [...lockSources.get(p).matchAll(/\b(?:import|export)\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"](\.\.?\/[^'"\r\n]+)['"]|\{([^{}]*)\}\s*=\s*await\s+import\s*\(\s*['"](\.\.?\/[^'"\r\n]+)['"]\s*\)|\b(?:import\s*\*\s*as\s+[\w$]+|export\s*\*(?:\s*as\s+[\w$]+)?)\s*from\s*['"](\.\.?\/[^'"\r\n]+)['"]|\bimport\s*\(\s*['"](\.\.?\/[^'"\r\n]+)['"]\s*\)/g)]
    .map(m => ({ to: fileURLToPath(new NodeURL(m[2] ?? m[4] ?? m[5] ?? m[6], new NodeURL(p, `file://${lockScanRoot}`))).slice(lockScanRoot.length),
      names: (m[1] ?? m[3]) === undefined ? null
        : (m[1] ?? m[3]).split(',').map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+|\s*:\s*/)[0]).filter(Boolean) }));
  const lockSeeds = new Set([...LOCK_PRIMITIVES, ...LOCK_HOLDERS]);
  const scannedLockUsers = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const p of lockSources.keys()) {
      if (lockSeeds.has(p) || scannedLockUsers.has(p)) continue;
      // Any import of a primitive counts. A holder counts through its lock API or a whole-module import; a lock user
      // only through its lock API by name: following whole-module imports of lock users reaches most of the daemon
      // graph (verify-lane.mjs and gh-throttle.mjs are imported everywhere), as REVIEW_AUTH_FLOOR notes for its family.
      if (importsOf(p).some(({ to, names }) => LOCK_PRIMITIVES.includes(to)
        || (LOCK_HOLDERS.includes(to) && (names === null || names.some(n => LOCK_API.test(n))))
        || (scannedLockUsers.has(to) && names !== null && names.some(n => LOCK_API.test(n))))) {
        scannedLockUsers.add(p); grew = true;
      }
    }
  }
  it('the lock-user scan is live and equals LOCK_USERS exactly (PR #6381 red team and self-review)', () => {
    expect([...lockSeeds].filter(p => !existsSync(`${lockScanRoot}${p}`))).toEqual([]);
    expect([...scannedLockUsers].sort()).toEqual([...LOCK_USERS].sort());
    expect(LOCK_USERS).toEqual(expect.arrayContaining(['scripts/conveyor/fix-claim-store.mjs', 'scripts/conveyor/fix-dispatch-claim.mjs',
      'scripts/conveyor/reconcile-fix-dispatch.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
      'scripts/operations/ci-heal-pr-dispatch.mjs', 'scripts/lib/resource-admission.mjs', 'scripts/operations/tick-mutex.mjs']));
  });
  it.each(['acquireFixDispatchClaim', 'releaseFixDispatchClaim', 'refreshLiveFixDispatchClaims', 'withFileLock', 'withAddGuardLock', 'tryLease', 'reserve',
    'heartbeatRunnerLease', 'tryAcquireTickMutex'])('the lock API matches %s', name => expect(LOCK_API.test(name)).toBe(true));
  it.each(['writeJsonAtomic', 'readLockEntry', 'releaseNotes', 'holdReason'])('the lock API does not match %s', name => expect(LOCK_API.test(name)).toBe(false));
  it.each(['scripts/conveyor/reconcile-fix-dispatch.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs', 'scripts/operations/ci-heal-pr-dispatch.mjs'])(
    'a D3 claim-key race in %s (a caller of the fix dispatch claim) never clears as NOT WEAKENED (PR #6381 self-review)', async file => {
      for (const stage of ['prerelease', 'prod']) {
        const f = finding({ class: 'D3', file, invariant: 'One live dispatch per repo/kind/PR', interleaving,
          trigger: 'Add headSha to fixDispatchResource so a running fixer can rotate its own claim key',
          consequence: 'A second dispatcher starts another fixer for the same PR while the first is live' });
        const result = await compute([f], options(stage));
        expect(result.verdict).toBe('WEAKENED');
        expect(result.ships).toEqual([]);
        expect(result.blocks).toEqual([expect.objectContaining({ id: 'f1', class: 'B4' })]);
      }
    });
  it.each([...LOCK_PRIMITIVES, ...LOCK_HOLDERS, ...LOCK_USERS])('every lock primitive, holder and lock user is on the floor: E2 and D3 in %s never ship', async file => {
    for (const cls of ['E2', 'D3']) {
      for (const stage of ['prerelease', 'prod']) {
        const result = await compute([finding({ class: cls, file })], options(stage, { guardFloorPaths: [], raceBlockPaths: [] }));
        expect(result.verdict).toBe('WEAKENED');
        expect(result.ships).toEqual([]);
      }
    }
  });
  // PR #6381 judge (R10): naming lock holders by hand never converged ("the floor omits module X", nine rounds). The
  // floor is held to a RULE instead: every tracked module whose source takes an exclusive hold must be protected, by a
  // name glob or by LOCK_HOLDERS. A hold is read from the source, comments removed, in three forms:
  //  - an exclusive create: the `'wx'` / `'wx+'` open flag, `O_EXCL`, or a `link` / `linkSync` (a hard link fails with
  //    EEXIST when the name exists, so it is a no-clobber create; `unlink` is not one);
  //  - a lock directory: a `mkdir` without `recursive: true` near an `EEXIST` check (the create fails if it exists);
  //  - a lock file name: a string naming a `.lock`, `.lease` or `.mutex` file (or a `-lock.json`-style name, or a
  //    `locks/` folder). `package-lock.json` and `x.endsWith('.lock')`-style name checks are not holds.
  // Protecting more only ever blocks more, so a module that only reads, checks or removes a lock file counts too.
  const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const HOLD_FORMS = Object.freeze({
    // A call has its paren right after the name: `link (` in a message string is prose, not a call.
    exclusiveCreate: /(['"`])wx\+?\1|\bO_EXCL\b|(?:^|[^\w$])link(?:Sync)?\(/m,
    lockDirectory: /\bmkdir(?:Sync)?\s*\((?![^)]*recursive\s*:\s*true)[^)]*\)[\s\S]{0,400}?EEXIST|EEXIST[\s\S]{0,400}?\bmkdir(?:Sync)?\s*\((?![^)]*recursive\s*:\s*true)/,
    lockFileName: /['"`][^'"`\s]*(?:\.(?:lock|lease|mutex)s?|[-_.](?:lock|lease|mutex)s?\.(?:json|d|pid|txt))['"`]|['"`/](?:lock|lease|mutex)s\//i,
  });
  const holdFormsOf = src => {
    const s = stripComments(src).replace(/package-lock\.json/g, '').replace(/\.(?:endsWith|startsWith|includes)\(\s*(['"`])[^'"`\n]*\1\s*\)/g, '');
    return Object.entries(HOLD_FORMS).filter(([, re]) => re.test(s)).map(([form]) => form);
  };
  // Every tracked script, not only .mjs: a .cjs, .js or .ts module can take a hold too (PR #6381 self-review).
  const holdSources = new Map(execFileSync('git', ['ls-files', '-z', '--', ...['scripts', 'skills-src'].flatMap(d =>
    ['mjs', 'cjs', 'js', 'mts', 'cts', 'ts'].map(ext => `:(glob)${d}/**/*.${ext}`))], { cwd: lockScanRoot, encoding: 'utf8', maxBuffer: 8 << 20 })
    .split('\0').filter(Boolean).filter(p => !p.includes('/__tests__/') && !/\.test\.[cm]?[jt]s$/.test(p))
    .map(p => [p, lockSources.get(p) ?? readFileSync(`${lockScanRoot}${p}`, 'utf8')]));
  const scannedHolders = [...holdSources.keys()].filter(p => holdFormsOf(holdSources.get(p)).length > 0);
  it('the hold scan is live: it finds the known holders and ignores non-holds (PR #6381 judge)', () => {
    expect(scannedHolders.length).toBeGreaterThan(50);
    expect(scannedHolders).toEqual(expect.arrayContaining(['scripts/lib/atomic-json-file.mjs', 'scripts/conveyor/ci-queue-watch.mjs',
      'scripts/readiness/file-locks.mjs', 'scripts/conveyor/health-responder-state.mjs']));
    expect(holdFormsOf("openSync(p, 'wx')")).toEqual(['exclusiveCreate']);
    expect(holdFormsOf('try { linkSync(tmp, path); } catch (e) { if (e.code !== "EEXIST") throw e; }')).toEqual(['exclusiveCreate']);
    expect(holdFormsOf('await fsp.link(tmp, path);')).toEqual(['exclusiveCreate']);
    expect(holdFormsOf('const fd = openSync(p, constants.O_CREAT | constants.O_EXCL);')).toEqual(['exclusiveCreate']);
    expect(holdFormsOf("writeFileSync(p, x, { flag: \"wx\" })")).toEqual(['exclusiveCreate']);
    expect(holdFormsOf('try { mkdirSync(dir); } catch (e) { if (e.code === "EEXIST") return false; }')).toEqual(['lockDirectory']);
    expect(holdFormsOf('const lockPath = `${journal}.lock`;')).toEqual(['lockFileName']);
    expect(holdFormsOf("join(root, 'locks/x.json')")).toEqual(['lockFileName']);
    for (const none of ["mkdirSync(dir, { recursive: true }); if (e.code === 'EEXIST') {}", "read('package-lock.json')",
      "name.endsWith('.lock')", "// openSync(p, 'wx')", "/* const p = 'x.lock' */", "writeFileSync(p, x, 'utf8')", 'unlinkSync(p); await unlink(q);',
      'makeLink(x); hyperlink(y);', 'v.push(`would add a leaf link (${f}) to the map`)']) {
      expect(holdFormsOf(none), none).toEqual([]);
    }
  });
  it.each(scannedHolders)('every module the hold scan finds is on the floor: a D3 race in %s never ships (PR #6381 judge)', async file => {
    for (const stage of ['prerelease', 'prod']) {
      const result = await compute([finding({ class: 'D3', file })], options(stage, { guardFloorPaths: [], raceBlockPaths: [] }));
      expect(result.verdict, `${file}: ${holdFormsOf(lockSources.get(file)).join(', ')}`).toBe('WEAKENED');
      expect(result.ships).toEqual([]);
    }
  });
  it.each([
    ['scripts/lib/atomic-json-file.mjs', 'A finds the lock stale and reclaims it; B reclaims it too and takes it; A, the stale owner, deletes the lock file B now holds'],
    ['scripts/conveyor/ci-queue-watch.mjs', 'withHistoryLock: A\'s hold goes stale and B takes it; A\'s finalizer removes the lock B now holds'],
  ])('a D3 stale-lock reclaim race in %s with an interleaving blocks as B4, never NOT WEAKENED with an advisory card (PR #6381 judge)', async (file, trigger) => {
    for (const stage of ['prerelease', 'prod']) {
      const f = finding({ class: 'D3', file, invariant: 'Only the lock owner removes the lock', trigger, interleaving,
        consequence: 'Two writers hold the lock at once and one write is lost' });
      const result = await compute([f], options(stage, { guardFloorPaths: [], raceBlockPaths: [] }));
      expect(result.verdict).toBe('WEAKENED');
      expect(result.ships).toEqual([]);
      expect(result.cards).toEqual([]);
      expect(result.blocks).toEqual([expect.objectContaining({ id: 'f1', class: 'B4' })]);
    }
  });
  // The anywhere-in-basename globs also capture files whose name holds the word inside another word (`release` holds
  // `lease`), tests and golden-corpus data. Protecting more only ever blocks more, so this over-capture is accepted.
  // Every tracked file the wide form captures and the old start-of-name form did not is derived from git and listed.
  const overCaptureRoot = fileURLToPath(new NodeURL('../../../', import.meta.url));
  const tracked = spec => execFileSync('git', ['ls-files', '-z', '--', spec], { cwd: overCaptureRoot, encoding: 'utf8', maxBuffer: 4 << 20 })
    .split('\0').filter(Boolean);
  const WORDS = ['file-locks', 'lease', 'slot', 'lock-reaper', 'lane-pool', 'merge', 'drain', 'mq', 'claim', 'mutex'];
  const OVER_CAPTURE = [...new Set(WORDS.flatMap(w => {
    const prefixOnly = new Set([...tracked(`:(glob)scripts/**/${w}*`), ...tracked(`:(glob)scripts/${w}*`)]);
    return tracked(`:(glob)scripts/**/*${w}*`).filter(p => !prefixOnly.has(p));
  }))].sort();
  it('the over-capture list is derived from git and holds every word-inside-word capture (PR #6381 send-back)', () => {
    expect(OVER_CAPTURE).toEqual(expect.arrayContaining(['scripts/readiness/forge-slot-markers.mjs',
      'scripts/conveyor/orphan-claim-release.mjs', 'scripts/conveyor/prepare-failure-releases.json',
      'scripts/conveyor/__tests__/orphan-claim-release.test.mjs', 'scripts/__tests__/lane-pool-release-salvage.test.mjs',
      'scripts/conveyor/soak/breaks/card-filer-releases-dirty-lane.mjs', 'scripts/conveyor/soak/breaks/detail-head-must-not-release-human-hold.mjs',
      'scripts/conveyor/soak/breaks/idle-status-fixer-claim-never-released.mjs', 'scripts/conveyor/soak/breaks/prepare-released-needs-you-park.mjs',
      'scripts/conveyor/soak/breaks/successive-released-fix-pids.mjs', 'scripts/golden-corpus/hook-guard-lane/own-leased-lane-edit.json']));
  });
  it.each(OVER_CAPTURE)('the accepted over-capture %s is on the floor', async file => {
    expect((await compute([finding({ class: 'E2', file })], options())).verdict).toBe('WEAKENED');
  });
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
      // A word the floor does not name (`lease` is now on it anywhere under scripts/, PR #6381 send-back).
      ['custom/a/b.mjs', 'custom/**', true], ['custom.mjs', 'custom/**', false], ['scripts/x-widget.mjs', 'scripts/*widget*', true],
      ['scripts/a/x-widget.mjs', 'scripts/*widget*', false], ['scripts/a/b/widget.mjs', 'scripts/**/widget*', true],
      ['a/b/c', 'a/*/c', true], ['a/b/d/c', 'a/*/c', false], ['a/b/d/c', 'a/**/c', true], ['a/x/y/b', 'a**b', true],
      ['ab', 'a***b', true], ['a/b', 'a*b', false], ['a.b', 'a.b', true], ['axb', 'a.b', false], ['ab', 'a?b', false],
      ['a?b', 'a?b', true], ['a[x]', 'a[x]', true], ['ax', 'a[x]', false], ['a+', 'a+', true], ['aa', 'a+', false],
      ['x', '*', true], ['x/y', '*', false], ['x/y', '**', true], ['xZ', '**Z', true], ['x/Z', '*Z', false]]) {
      if (!validateProtectedPattern(pattern)) {
        await expect(isProtected(file, pattern), `${file} ~ ${pattern}`).rejects.toThrow(/malformed protected pattern/);
      } else expect(await isProtected(file, pattern), `${file} ~ ${pattern}`).toBe(want);
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
    // PR #6381 judge: trusted settings are a floor, never a ceiling. For every setting a caller may pass, the effective
    // requirement is the stricter of trusted and caller, in BOTH directions: a caller cannot relax a strict trusted value,
    // and a caller's stricter value is honoured when the trusted value is loose. Only loose x loose relaxes.
    const SETTINGS_TABLE = {
      // requirePayBy is waived here so this row isolates requireOnMain: a missing card has no pay-by either, and a
      // required pay-by alone keeps it blocked (the independence test below covers that cell).
      requireOnMain: { strict: true, loose: false, findings: () => [d2()], layer: v => ({ cards: { requireOnMain: v, requirePayBy: false } }),
        opts: v => ({ requireOnMain: v, readCard: () => null }) },
      requirePayBy: { strict: true, loose: false, findings: () => [d2()], layer: v => ({ cards: { requireOnMain: true, requirePayBy: v } }),
        opts: v => ({ requirePayBy: v, readCard: () => 'status: open\n' }) },
      releaseStage: { strict: 'prod', loose: 'prerelease', findings: () => [finding()], layer: v => ({ releaseStage: v }), opts: v => ({ releaseStage: v }) },
      preExistingMode: { strict: 'block', loose: 'prove', findings: () => [d2()], layer: v => ({ preExisting: { mode: v, baseRecheckMax: 3 } }),
        opts: v => ({ preExistingMode: v }) },
      raceBlockPaths: { strict: ['custom/**'], loose: [], findings: () => [finding({ file: 'custom/x.mjs' })], layer: v => ({ raceBlockPaths: v }),
        opts: v => ({ raceBlockPaths: v }) },
      guardFloorPaths: { strict: ['custom/**'], loose: [], findings: () => [finding({ file: 'custom/x.mjs' })], layer: v => ({ guardFloorPaths: v }),
        opts: v => ({ guardFloorPaths: v }) },
    };
    it.each(Object.keys(SETTINGS_TABLE).flatMap(setting => [true, false].flatMap(trustedStrict => [true, false]
      .map(callerStrict => [setting, trustedStrict ? 'strict' : 'loose', callerStrict ? 'strict' : 'loose', trustedStrict || callerStrict]))))(
      'trusted settings are a floor: %s with trusted %s and caller %s takes the stricter value (PR #6381 judge)',
      async (setting, trusted, caller, strictWins) => {
        const row = SETTINGS_TABLE[setting]; const findings = row.findings();
        const opts = options('prerelease', { relationProofs: findings.filter(f => f.class === 'D2').map(proofFor), readCard: rc, ...row.opts(row[caller]) });
        const r = await compute(findings, opts, trustedLayer(row.layer(row[trusted])));
        expect(r.verdict).toBe(strictWins ? 'WEAKENED' : 'NOT WEAKENED');
        if (strictWins) expect(r.ships).toEqual([]);
      });
    it('a caller requirement that is not exactly false counts as a request to tighten, never to relax (PR #6381 judge)', async () => {
      const f = d2(); const loose = trustedLayer({ cards: { requireOnMain: false, requirePayBy: false } });
      const base = { relationProofs: [proofFor(f)] };
      for (const v of [true, 'true', 1, 'false', 0, null, {}]) {
        expect((await compute([f], options('prerelease', { ...base, readCard: () => null, requireOnMain: v }), loose)).verdict, String(v)).toBe('WEAKENED');
        expect((await compute([f], options('prerelease', { ...base, readCard: () => 'status: open\n', requirePayBy: v }), loose)).verdict, String(v)).toBe('WEAKENED');
      }
      // Omitted caller values defer to the trusted (loose) value.
      expect((await compute([f], options('prerelease', { ...base, readCard: () => null }), loose)).verdict).toBe('NOT WEAKENED');
      expect((await compute([f], options('prerelease', { ...base, readCard: () => null, requireOnMain: undefined }), loose)).verdict).toBe('NOT WEAKENED');
    });
    // PR #6381 red team: each card requirement is enforced on its own. A missing card has no pay-by either, so it
    // clears only when BOTH are waived; a card with no pay-by line clears only when the pay-by is waived.
    const CARD_BODIES = { missing: () => null, blank: () => '  \n', 'no pay-by': () => 'status: open\n', 'current pay-by': rc };
    it.each([true, false].flatMap(onMain => [true, false].flatMap(payBy => Object.keys(CARD_BODIES).map(card => [onMain, payBy, card,
      card === 'current pay-by' || (card === 'no pay-by' && !payBy) || (card !== 'no pay-by' && !onMain && !payBy)]))))(
      'card requirements are independent: requireOnMain %s, requirePayBy %s, card %s ships: %s (PR #6381 red team)',
      async (onMain, payBy, card, ships) => {
        const f = d2(); const layer = trustedLayer({ cards: { requireOnMain: onMain, requirePayBy: payBy } });
        const r = await compute([f], options('prerelease', { relationProofs: [proofFor(f)], readCard: CARD_BODIES[card] }), layer);
        expect(r.verdict).toBe(ships ? 'NOT WEAKENED' : 'WEAKENED');
        if (!ships) expect(r.ships).toEqual([]);
      });
    it('a caller pay-by requirement is honoured for a missing card when trusted settings waive both (PR #6381 red team)', async () => {
      const f = d2(); const loose = trustedLayer({ cards: { requireOnMain: false, requirePayBy: false } });
      const base = { relationProofs: [proofFor(f)], readCard: () => null };
      expect((await compute([f], options('prerelease', { ...base, requirePayBy: true }), loose)).verdict).toBe('WEAKENED');
      expect((await compute([f], options('prerelease', base), loose)).verdict).toBe('NOT WEAKENED');
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
    it('E2 in scripts/lib/review-ci-gate.mjs (the required-check authorization gate) refuses clearance (PR #6381 judge)', async () => {
      const f = finding({ class: 'E2', file: 'scripts/lib/review-ci-gate.mjs', invariant: 'A required check is authorized only by its own run' });
      for (const stage of ['prerelease', 'prod']) {
        const r = await compute([f], options(stage, { guardFloorPaths: [], raceBlockPaths: [] }));
        neverShips(r);
        expect([...r.blocks, ...r.recheck].map(x => x.id)).toEqual(['f1']);
      }
    });
    it('E2 in scripts/lib/review-independence.mjs (an author clearing its own review) refuses clearance (PR #6381 red team)', async () => {
      const f = finding({ id: 'self-clear', class: 'E2', file: 'scripts/lib/review-independence.mjs', line: 261,
        invariant: 'Only an independent actor may clear an automated review',
        trigger: 'Remove the author/clearer equality check without a regression test', consequence: 'The author can clear its own review' });
      for (const stage of ['prerelease', 'prod']) {
        const r = await compute([f], options(stage, { guardFloorPaths: [], raceBlockPaths: [] }));
        neverShips(r);
        expect([...r.blocks, ...r.recheck].map(x => x.id)).toEqual(['self-clear']);
      }
    });
    it('D3 in scripts/lib/lane-lease.mjs blocks (a lease overwrite never clears)', async () => {
      const f = finding({ class: 'D3', file: 'scripts/lib/lane-lease.mjs', invariant: 'A live lease is never overwritten' });
      neverShips(await compute([f], options()));
      const raced = await compute([{ ...f, interleaving }], options());
      expect(raced.blocks).toEqual([expect.objectContaining({ id: 'f1', class: 'B4' })]);
    });
    it.each(['scripts/guard-bash.mjs', 'scripts/guard-git-push.mjs', 'scripts/guard-lane.mjs', 'scripts/guard-stop-passive-wait.mjs',
      'scripts/conveyor/guard-1c-mutation-check.mjs', 'scripts/backlog-guard.mjs', 'scripts/backlog/guarded-write.mjs', '.claude/settings.json',
      'scripts/lib/review-ci-gate.mjs', 'scripts/lib/review-ci-gate-io.mjs', 'scripts/check-review-gate.mjs', 'scripts/lib/red-team-gate.mjs',
      'scripts/lib/verify-lane-gate.mjs', 'scripts/lib/codeql-gate.mjs', 'scripts/lib/gate-config.mjs', 'scripts/lib/required-check-implication.mjs',
      'scripts/lib/promotion-required-checks.mjs', 'scripts/rulesets/main-required-checks.merge-queue.json', 'scripts/settings/required-checks-cache.json',
      'scripts/conveyor/delegation-trial-gate.mjs', 'scripts/operations/land-advance-gate.mjs',
      'scripts/lib/required-status-checks.mjs', 'scripts/lib/rollup-collapse.mjs', 'scripts/lib/review-escalation.mjs', 'scripts/lib/review-timing.mjs',
      'scripts/lib/review-policy.mjs', 'scripts/lib/github-auth-policy.mjs', 'scripts/operations/gate-health.mjs',
      'scripts/lib/lane-lease.mjs', 'scripts/readiness/scope-lease.mjs', 'scripts/readiness/scope-lease-live.mjs', 'scripts/lib/daemon-rebuild/lease.mjs',
      'scripts/operations/coordination-lock.mjs', 'scripts/lib/daemon-clone-lock.mjs', 'scripts/readiness/with-lock.mjs', 'scripts/readiness/drain-lock.mjs',
      'skills-src/conveyor/runner-lock.mjs', '.githooks/pre-commit', '.githooks/pre-push', 'scripts/lib/git-hook-surface.mjs',
      'scripts/lib/permission-change.mjs', 'scripts/lib/pr-merge-gate.mjs', '.github/workflows/merge-gate.yml', '.github/workflows/review-gate.yml',
      'scripts/operations/audit-verdict.mjs', 'scripts/operations/codex-audit.mjs', 'scripts/operations/codex-audit-io.mjs',
      'scripts/lib/audit-settings.mjs', 'scripts/lib/policy-cascade.mjs', 'scripts/settings/codex-audit.json',
      // PR #6381 judge: the auditor's own imports. audit-path.mjs classifies every protected path for the verdict engine.
      'scripts/lib/audit-path.mjs', 'scripts/lib/net-diff-fingerprint.mjs', 'scripts/lib/under-test.mjs',
      // Review authorization (PR #6381 red team): who may clear, accept or carry a verdict, and which markers are trusted.
      'scripts/lib/review-independence.mjs', 'scripts/lib/marker-authorship.mjs', 'scripts/lib/ai-pr-authorship.mjs',
      'scripts/operations/build-pr-authorship.mjs', 'scripts/lib/human-clearance-carry.mjs', 'scripts/conveyor/human-clearance-carry-cli.mjs',
      'scripts/settings/human-clearance-carry.json', 'scripts/settings/numbering-human-clearance.json', 'scripts/lib/accept-carry-forward.mjs',
      'scripts/conveyor/accept-carry-sweep.mjs', 'scripts/settings/accept-carry-forward.json', 'scripts/lib/unattended-review-accept.mjs',
      'scripts/lib/trust-chain-tier.mjs', 'scripts/review-set-label.mjs', 'scripts/lib/rebase-verdict-carry.mjs',
      'scripts/conveyor/delegated-clear-human.mjs', 'scripts/lib/pr-state/admit-clear-human.mjs', 'scripts/lib/operator-identity.mjs',
      'scripts/lib/delegation-marker.mjs', 'scripts/lib/verdict-ledger.mjs', 'scripts/lib/verdict-ledger-store.mjs', 'scripts/lib/ruling-ledger.mjs',
      'scripts/lib/jury-core.mjs', 'scripts/operations/record-verdict.mjs', 'scripts/operations/record-referral-ruling.mjs',
      'scripts/operations/land-human-only.mjs', 'scripts/conveyor/hiccup-approve.mjs', 'scripts/settings/delivery-identity.json',
      'scripts/lib/github-app-identity.mjs', 'scripts/lib/carry-equivalence.mjs', 'scripts/lib/identical-net-patch.mjs', 'scripts/lib/numbering-carry.mjs',
      'scripts/lib/review-seat-settings.mjs', 'scripts/settings/review.json',
      // PR #6381 self-review: ruling, license and hold modules of the review authorization family, and settings files.
      'scripts/operations/record-red-team-ruling.mjs', 'scripts/operations/record-red-team-ruling-io.mjs',
      'scripts/operations/record-red-team-ruling-cli.mjs', 'scripts/conveyor/standing-ruling-mark.mjs',
      'scripts/conveyor/ruling-resolved-stand-down.mjs', 'scripts/operations/ledger-backfill-rulings.mjs',
      'scripts/lib/human-only-enqueue-license.mjs', 'scripts/settings/human-only-enqueue.json', 'scripts/lib/approved-human-surface-hold.mjs',
      'scripts/settings/approved-human-surface-hold.json', 'scripts/lib/pr-state/holds/verdict.mjs', 'scripts/settings/red-team.json',
      'scripts/settings/github-auth.json', 'scripts/settings/human-review-surfaces.json',
      // A case-insensitive file system resolves these to the guard itself.
      'Scripts/Guard-Bash.mjs', 'scripts/GUARD-bash.mjs', 'SCRIPTS/LIB/LANE-LEASE.MJS',
    ])('every guard, lease, lock, gate and audit module is on the built-in floor: E1, E2 and D3 in %s never ship', async file => {
      for (const cls of ['E1', 'E2', 'D3']) neverShips(await compute([finding({ class: cls, file })], options()));
    });
    // PR #6381 red team: the floor names modules one by one, so a module a protected decision imports can be missed
    // (marker-authorship.mjs decides which marker authors are trusted through github-app-identity.mjs). For the review
    // authorization family, every module it imports directly is read from the source and must be on the floor too, so
    // a new import cannot silently stay unprotected. The scanned roots are REVIEW_AUTH_FLOOR itself, expanded to the
    // tracked modules each entry matches, so the scan can never cover fewer modules than the floor names (PR #6381
    // self-review: a hand-copied root list left review-set-label.mjs and jury-core.mjs unscanned).
    const repoRoot = fileURLToPath(new NodeURL('../../../', import.meta.url));
    const AUTH_ROOTS = [...new Set(REVIEW_AUTH_FLOOR.flatMap(entry => execFileSync('git', ['ls-files', '-z', '--', `:(glob)${entry}`],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 << 20 }).split('\0')))]
      .filter(p => /\.m?js$/.test(p) && !/\.test\.m?js$/.test(p) && !p.includes('/__tests__/')).sort();
    it('the review authorization roots are derived from the floor and cover every authorization module', () => {
      expect(AUTH_ROOTS).toEqual(expect.arrayContaining(['scripts/review-set-label.mjs', 'scripts/lib/jury-core.mjs',
        'scripts/lib/review-independence.mjs', 'scripts/lib/ruling-ledger.mjs', 'scripts/operations/record-verdict.mjs',
        'scripts/operations/record-referral-ruling.mjs', 'scripts/operations/land-human-only.mjs', 'scripts/lib/verdict-ledger.mjs',
        'scripts/lib/delegation-marker.mjs', 'scripts/lib/review-escalation.mjs', 'scripts/lib/human-clearance-carry.mjs']));
    });
    // git's `scripts/**/x` also matches a file directly under scripts/, the floor's matcher does not: every scanned root
    // must itself be protected, so a root the scan reaches can never sit outside the floor (PR #6381 self-review).
    it.each(AUTH_ROOTS)('every review authorization root is on the floor: E2 in %s never ships', async file => {
      neverShips(await compute([finding({ class: 'E2', file })], options()));
    });
    // PR #6381 self-review: imports of review-set-label.mjs (review-seat-policy and referral-card-readable decide whether a
    // mandatory referral counts as cleared), review-escalation.mjs and the record-verdict I/O half.
    it.each(['scripts/operations/review-seat-policy.mjs', 'scripts/lib/referral-card-readable.mjs', 'scripts/lib/review-labels.mjs',
      'scripts/operations/record-verdict-io.mjs'])('E2 in %s (an import of a review authorization module) refuses clearance', async file => {
      for (const stage of ['prerelease', 'prod']) neverShips(await compute([finding({ class: 'E2', file })], options(stage, { guardFloorPaths: [] })));
    });
    // A specifier never spans a line: without `\n` in the exclusion a doc comment such as "from './lib/ai-pr-" with the
    // name continued on the next line read as an import of a path that does not exist (PR #6381 self-review).
    const directImports = AUTH_ROOTS.flatMap(root => [...readFileSync(`${repoRoot}${root}`, 'utf8')
      .matchAll(/\bfrom\s*['"](\.\.?\/[^'"\r\n]+)['"]|\bimport\(\s*['"](\.\.?\/[^'"\r\n]+)['"]\s*\)/g)]
      .map(m => fileURLToPath(new NodeURL(m[1] ?? m[2], new NodeURL(root, `file://${repoRoot}`))).slice(repoRoot.length)));
    it('the review authorization family has direct imports to check (the source scan is live)', () => {
      expect(directImports).toEqual(expect.arrayContaining(['scripts/lib/github-app-identity.mjs', 'scripts/lib/carry-equivalence.mjs',
        'scripts/operations/review-seat-policy.mjs']));
    });
    it('every scanned import is a real file (a misread specifier fails here, not as an unprotected made-up path)', () => {
      expect([...new Set(directImports)].filter(p => !existsSync(`${repoRoot}${p}`))).toEqual([]);
    });
    it.each([...new Set(directImports)].sort())(
      'every direct import of the review authorization family is on the floor: E2 in %s never ships (PR #6381 red team)', async file => {
        neverShips(await compute([finding({ class: 'E2', file })], options()));
      });
    // PR #6381 judge: the auditor delegates protected-path classification to audit-path.mjs, which the floor missed. The
    // auditor's roots are AUDITOR_FLOOR itself, expanded to the tracked modules each entry matches, and every module a
    // root imports directly must be on the floor (the same one-level scan as the review authorization family). A module
    // the auditor launches counts as an import (self-review: codex-audit-io.mjs spawns codex-direct-task.mjs through
    // `new URL('../codex-direct-task.mjs', import.meta.url)`), as does a bare side-effect `import './x.mjs'`.
    const AUDITOR_ROOTS = [...new Set(AUDITOR_FLOOR.flatMap(entry => execFileSync('git', ['ls-files', '-z', '--', `:(glob)${entry}`],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 << 20 }).split('\0')))]
      .filter(p => /\.m?js$/.test(p) && !/\.test\.m?js$/.test(p) && !p.includes('/__tests__/')).sort();
    const AUDITOR_REFERENCE = /\bfrom\s*['"](\.\.?\/[^'"\r\n]+)['"]|\bimport\(\s*['"](\.\.?\/[^'"\r\n]+)['"]\s*\)|\bimport\s*['"](\.\.?\/[^'"\r\n]+)['"]|\bnew\s+(?:Node)?URL\(\s*['"](\.\.?\/[^'"\r\n]+\.m?js)['"]\s*,\s*import\.meta\.url\s*\)/g;
    const auditorImports = [...new Set(AUDITOR_ROOTS.flatMap(root => [...readFileSync(`${repoRoot}${root}`, 'utf8').matchAll(AUDITOR_REFERENCE)]
      .map(m => fileURLToPath(new NodeURL(m[1] ?? m[2] ?? m[3] ?? m[4], new NodeURL(root, `file://${repoRoot}`))).slice(repoRoot.length))))].sort();
    it('the auditor reference scan reads every form: import, re-export, dynamic and side-effect imports, and a launched URL', () => {
      const forms = ["import { a } from './a.mjs';", "export { b } from '../b.mjs';", "await import('./c.mjs')", "import './d.mjs';",
        "spawn(fileURLToPath(new NodeURL('../e.mjs', import.meta.url)))", "new URL('./f.mjs', import.meta.url)"].join('\n');
      expect([...forms.matchAll(AUDITOR_REFERENCE)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]))
        .toEqual(['./a.mjs', '../b.mjs', './c.mjs', './d.mjs', '../e.mjs', './f.mjs']);
    });
    it('the auditor scan is live: its roots cover the verdict engine and its imports include the path classifier', () => {
      expect(AUDITOR_ROOTS).toEqual(expect.arrayContaining(['scripts/operations/audit-verdict.mjs', 'scripts/operations/codex-audit.mjs',
        'scripts/operations/codex-audit-io.mjs', 'scripts/lib/audit-settings.mjs', 'scripts/lib/audit-path.mjs', 'scripts/lib/policy-cascade.mjs',
        'scripts/codex-direct-task.mjs']));
      expect(auditorImports).toEqual(expect.arrayContaining(['scripts/lib/audit-path.mjs', 'scripts/lib/net-diff-fingerprint.mjs',
        'scripts/codex-direct-task.mjs', 'scripts/lib/build-self-review.mjs']));
      expect(auditorImports.filter(p => !existsSync(`${repoRoot}${p}`))).toEqual([]);
    });
    it.each([...new Set([...AUDITOR_ROOTS, ...auditorImports])].sort())(
      'every auditor module and its direct imports are on the floor: E2 in %s never ships (PR #6381 judge)', async file => {
        for (const stage of ['prerelease', 'prod']) neverShips(await compute([finding({ class: 'E2', file })], options(stage, { guardFloorPaths: [] })));
      });
    // PR #6381 self-review: a floor module decides with the JSON file it reads (red-team-gate.mjs reads red-team.json),
    // so weakening that file weakens the module. Every floor module is read from the source, and each tracked scripts/
    // JSON file whose NAME it quotes, in any form (`'settings/x.json'`, `join(dir, 'settings', 'x.json')`, a file next
    // to the module), must be on the floor too. Fixtures and corpora are data, not settings.
    const lsFiles = spec => execFileSync('git', ['ls-files', '-z', '--', spec], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 << 20 })
      .split('\0').filter(Boolean);
    const FLOOR_MODULES = [...new Set(GUARD_FLOOR.flatMap(entry => lsFiles(`:(glob)${entry}`)))]
      .filter(p => /\.m?js$/.test(p) && !/\.test\.m?js$/.test(p) && !p.includes('/__tests__/') && !p.includes('/soak/')).sort();
    const jsonByName = new Map();
    for (const p of lsFiles('scripts').filter(p => p.endsWith('.json') && !/__tests__|fixtures|golden-corpus|review-corpus|\/soak\//.test(p))) {
      const name = p.slice(p.lastIndexOf('/') + 1);
      jsonByName.set(name, [...(jsonByName.get(name) ?? []), p]);
    }
    const floorSettings = [...new Set(FLOOR_MODULES.flatMap(m => [...readFileSync(`${repoRoot}${m}`, 'utf8').matchAll(/['"`/]([A-Za-z0-9_.-]+\.json)['"`]/g)]
      .flatMap(x => jsonByName.get(x[1]) ?? [])))].sort();
    it('the floor-settings scan is live and reads every quoted form', () => {
      expect(FLOOR_MODULES.length).toBeGreaterThan(100);
      expect(floorSettings).toEqual(expect.arrayContaining(['scripts/settings/red-team.json', 'scripts/settings/github-auth.json',
        'scripts/settings/stand-down.json', 'scripts/settings/fix.json', 'scripts/review-settings.json', 'scripts/lib/delivery-platform-preferences.json']));
    });
    it.each(floorSettings)('every settings file a floor module names is on the floor: E2 in %s never ships (PR #6381 self-review)', async file => {
      neverShips(await compute([finding({ class: 'E2', file })], options()));
    });
    // PR #6381 self-review: a model reading a diff or a trace reports a protected file in shapes the globs never matched.
    it.each(['a/scripts/lib/review-independence.mjs', 'b/scripts/lib/review-independence.mjs', './a/scripts/lib/review-independence.mjs',
      'scripts/lib/review-independence.mjs:42', 'scripts/lib/review-independence.mjs:42:7', 'scripts/lib/review-independence.mjs#L42',
      'scripts/lib/review-independence.mjs#L42-L50', 'scripts/lib/review-independence.mjs ', ' scripts/lib/review-independence.mjs',
      `scripts/lib/review-${String.fromCharCode(0x200b)}independence.mjs`, `scripts/lib/${String.fromCharCode(0xff52)}eview-independence.mjs`, 'a/scripts/guard-bash.mjs:12', 'b/.claude/settings.json',
      '`scripts/lib/review-independence.mjs`', '"scripts/lib/review-independence.mjs"', '+++ b/scripts/lib/review-independence.mjs',
      '--- a/scripts/lib/review-independence.mjs', 'i/scripts/lib/review-independence.mjs', 'w/scripts/lib/review-independence.mjs',
      'web-everything/scripts/lib/review-independence.mjs', 'a/a/scripts/lib/review-independence.mjs', 'scripts/lib/review-independence.mjs,',
      'scripts/lib/review-independence.mjs.', 'scripts/lib/review-independence.mjs:42-50', 'scripts/lib/review-independence.mjs:L42',
      'scripts/lib/review-independence.mjs (line 42)', 'scripts/lib/review-independence.mjs#42', 'scripts/lib/review-independence.mjs@ec32b86',
      'scripts\\lib\\review-independence.mjs', 'see (scripts/lib/review-independence.mjs)',
      // PR #6381 referral (block): a format (Cf) or control (Cc) character that is NOT default-ignorable (U+FFF9, the
      // Arabic number signs, U+070F, U+110BD, C1 U+0085, DEL) split the folded token, so an explicitly named module matched
      // no glob. Built from code points: a raw one in source is refused by check:standards.
      // The same class: a line or paragraph separator, the blank Braille pattern and ordinary or wide spaces render as a
      // gap, not a character, and split the token too.
      ...[0xfff9, 0xfffb, 0x600, 0x6dd, 0x70f, 0x110bd, 0x85, 0x7f, 0x9f, 0x2028, 0x2029, 0x2800, 0x20, 0xa0, 0x3000].flatMap(cp => [`scripts/lib/review-${String.fromCodePoint(cp)}independence.mjs`,
        `scr${String.fromCodePoint(cp)}ipts/lib/review-independence.mjs`, `scripts/lib${String.fromCodePoint(cp)}/review-independence.mjs`,
        `scripts/lib/git-hook${String.fromCodePoint(cp)}-surface.mjs`]),
      // Self-review of that fix: NFKC keeps dash, slash and dot lookalikes (U+2011, U+2212, U+2215, U+3002, ...), and a
      // combining mark, a replacement character or a Cyrillic homoglyph splits or changes the name too.
      ...[0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212, 0x2043].map(cp => `scripts/lib/review${String.fromCodePoint(cp)}independence.mjs`),
      ...[0x2215, 0x2044, 0x29f8, 0x2216].map(cp => `scripts${String.fromCodePoint(cp)}lib${String.fromCodePoint(cp)}review-independence.mjs`),
      ...[0x3002, 0xff61, 0x2027, 0xb7, 0x589].map(cp => `scripts/lib/review-independence${String.fromCodePoint(cp)}mjs`),
      ...[0x301, 0x20dd, 0x488, 0xfffd, 0xfffc, 0x2423, 0x203f].map(cp => `scripts/lib/review-indep${String.fromCodePoint(cp)}endence.mjs`),
      `${String.fromCodePoint(0x455)}cripts/lib/review-independence.mjs`, `scripts/lib/r${String.fromCodePoint(0x435)}view-independence.mjs`,
      `scripts/lib/review-independence${String.fromCodePoint(0x2e)}m${String.fromCodePoint(0x458)}s`,
      // Second self-review: a quote or bracket INSIDE a name, and an unmapped lookalike in place of every separator.
      ...[0x300c, 0x201a, 0x2019, 0x169b, 0x2e1c, 0xab, 0x2e28, 0xfd3e].flatMap(cp => [`scripts/lib/review${String.fromCodePoint(cp)}-independence.mjs`,
        `scripts/lib/git-hook${String.fromCodePoint(cp)}surface.mjs`, `scripts/lib/git-hook-surface${String.fromCodePoint(cp)}.mjs`]),
      ['scripts', 'lib', 'review-independence'].join(String.fromCodePoint(0x2571)) + `${String.fromCodePoint(0xa4f8)}mjs`,
      ['scripts', 'lib', 'git-hook-surface'].join(String.fromCodePoint(0x2571)) + `${String.fromCodePoint(0xa60e)}mjs`,
      ['.github', 'workflows', 'ci.yml'].join(String.fromCodePoint(0x2571)),
      // Third self-review: a punctuation or symbol character beside an inserted space was stripped as a run edge but
      // still split the joined forms; ASCII splitters (`,`, `!`, `:`, `<`) split a name the same way.
      ...[0xa1, 0xa9, 0xb1, 0xa7, 0xbf].flatMap(cp => [`scripts/lib/review- ${String.fromCodePoint(cp)}independence.mjs`,
        `scripts/lib/review-${String.fromCodePoint(cp)} independence.mjs`, `scripts/lib/review- ${String.fromCodePoint(cp)} independence.mjs`,
        `.claude/settings${String.fromCodePoint(cp)} .json`, `.github ${String.fromCodePoint(cp)}/workflows/x.yml`]),
      'scripts/lib/review,-independence.mjs', 'scripts/lib/review!-independence.mjs', '.claude/settings:.json', '.github/work<flows/x.yml',
      'scripts/lib/review- !independence.mjs', 'scripts/lib/git-hook;-surface.mjs'])(
      'a protected file reported as %j still never ships', async file => {
        for (const stage of ['prerelease', 'prod']) neverShips(await compute([finding({ class: 'E2', file })], options(stage, { guardFloorPaths: [] })));
      });
    // Every tracked file name is ASCII, so a non-ASCII character left in a path after the fold cannot name a real file
    // and could hide a protected one: it fails closed, even where no protected name is in sight (PR #6381 self-review).
    it.each([`src/comp${String.fromCodePoint(0x43e)}nents/merge-button.ts`, `x/out${String.fromCodePoint(0x301)}put.mjs`, `docs/notes${String.fromCodePoint(0x3001)}md`])(
      'a reported path still holding a non-ASCII character after the fold, %j, fails closed', async file => {
        neverShips(await compute([finding({ class: 'E2', file })], options()));
      });
    it('a path with more candidate forms than can be matched at bounded cost fails closed', async () => {
      neverShips(await compute([finding({ class: 'E2', file: `${'scripts/'.repeat(40)}output.mjs` })], options()));
      // A long path with no protected folder in it yields one candidate and ships as before.
      expect((await compute([finding({ class: 'E2', file: `${'x/'.repeat(200)}output.mjs` })], options())).verdict).toBe('NOT WEAKENED');
    });
    it.each(['a/scripts/output.mjs', 'scripts/output.mjs:12', 'scripts/output.mjs#L12', 'scripts/output.mjs ', '`scripts/output.mjs`',
      '+++ b/scripts/output.mjs', 'src/components/merge-button.ts'])(
      'a clean unprotected path reported as %j still ships as debt', async file => {
        const result = await compute([finding({ class: 'E2', file })], options());
        expect(result.verdict).toBe('NOT WEAKENED');
        expect(ids(result.ships)).toEqual(['f1']);
        expect(result.blocks).toEqual([]);
        expect(result.recheck).toEqual([]);
      });
    // R787 redesign: non-ASCII wrappers, prose and arrows are unparseable => PROTECTED.
    it.each([
      `${String.fromCodePoint(0x2018)}scripts/output.mjs${String.fromCodePoint(0x2019)}`, `${String.fromCodePoint(0x201c)}scripts/output.mjs${String.fromCodePoint(0x201d)}`,
      `scripts/output.mjs ${String.fromCodePoint(0x2014)} line 12`, `scripts/output.mjs${String.fromCodePoint(0x2013)}12`, `${String.fromCodePoint(0x300c)}scripts/output.mjs${String.fromCodePoint(0x300d)}`,
      `scripts/output.mjs${String.fromCodePoint(0x3002)}`, `scripts/output.mjs ${String.fromCodePoint(0x7b2c)}42${String.fromCodePoint(0x884c)}`,
      `scripts/output.mjs ${String.fromCodePoint(0x2192)} scripts/other.mjs`])(
      'an unparseable report %j is WEAKENED and cannot ship', async file => {
        const result = await compute([finding({ class: 'E2', file })], options());
        neverShips(result);
        expect(result.recheck).toEqual([expect.objectContaining({ id: 'f1', class: 'X2' })]);
        expect(result.cards).toEqual([]);
      });
  });

  describe('D2 debt verification (D-R451)', () => {
    const d2 = (extra = {}) => finding({ class: 'D2', relation: 'untouched', card: 'backlog/6400-debt.md', ...extra });
    const reader = (body = 'status: open\nmustPayBefore: 2099-01-01\n') => vi.fn(() => body);
    const NOW = Date.parse('2026-11-03T12:00:00Z');
    it.each(['prerelease', 'prod'])('ships with a card that exists on main at %s', async stage => {
      const readCard = reader();
      const r = await compute([d2()], options(stage, { readCard, now: () => NOW }));
      expect(r.verdict).toBe('NOT WEAKENED');
      expect(readCard).toHaveBeenCalledWith('backlog/6400-debt.md');
    });
    it.each([['missing card field', { card: undefined }], ['card path outside backlog/', { card: '../x.md' }]])('blocks on %s', async (_n, extra) => {
      expect((await compute([d2(extra)], options('prerelease', { readCard: reader(), now: () => NOW }))).blocks).toHaveLength(1);
    });
    it('blocks when the card is not on main, the reader throws, or it returns blank', async () => {
      for (const readCard of [() => null, () => { throw new Error('no git'); }, () => '  ']) {
        expect((await compute([d2()], options('prerelease', { readCard, now: () => NOW }))).verdict).toBe('WEAKENED');
      }
    });
    it('blocks once the card mustPayBefore date has passed, ships before it', async () => {
      expect((await compute([d2()], options('prerelease', { readCard: reader('mustPayBefore: 2026-11-01\n'), now: () => NOW }))).verdict).toBe('WEAKENED');
      expect((await compute([d2()], options('prerelease', { readCard: reader('mustPayBefore: 2026-12-01\n'), now: () => NOW }))).verdict).toBe('NOT WEAKENED');
      expect((await compute([d2()], options('prerelease', { readCard: reader('mustPayBefore: garbage\n'), now: () => NOW }))).verdict).toBe('WEAKENED');
    });
    it('a plain-value clock (data, not code) never moves now into the past: an overdue pay-by still blocks (PR #6381 self-review)', async () => {
      const overdue = reader('mustPayBefore: 2020-01-01\n');
      for (const now of [0, -Infinity, '1970-01-01', NOW - 1e13, null]) {
        expect((await compute([d2()], options('prerelease', { readCard: overdue, now }))).verdict, String(now)).toBe('WEAKENED');
      }
      // Control: the code seam still works, so the refusal above is the plain value being ignored.
      expect((await compute([d2()], options('prerelease', { readCard: overdue, now: () => 0 }))).verdict).toBe('NOT WEAKENED');
      // A card reader that is not code (a plain value) cannot be called: no card, so it blocks.
      expect((await compute([d2()], options('prerelease', { readCard: 'mustPayBefore: 2099-01-01\n', now: () => NOW }))).verdict).toBe('WEAKENED');
    });
    it('a plain-number clock later than the real one is honoured: a pay-by before it blocks (PR #6381 self-review)', async () => {
      const later = Date.parse('2100-01-01T00:00:00Z');
      expect((await compute([d2()], options('prerelease', { readCard: reader('mustPayBefore: 2099-01-01\n'), now: later }))).verdict).toBe('WEAKENED');
      expect((await compute([d2()], options('prerelease', { readCard: reader('mustPayBefore: 2101-01-01\n'), now: later }))).verdict).toBe('NOT WEAKENED');
    });
    it('blocks on an impossible or non-canonical pay-by date instead of rolling it into a later month (PR #6381 red team)', async () => {
      for (const bad of ['2099-02-31', '2099-02-30', '2100-02-29', '2099-04-31', '2099-13-01', '2099-00-10', '2099-01-00',
        '2099-1-1', '+002099-01-01', '0099-01-01', '2099-01-01T00:00:00Z', '20990101', 'Jan-1-2099', '２０９９-01-01']) {
        expect((await compute([d2()], options('prod', { readCard: reader(`mustPayBefore: ${bad}\n`), now: () => NOW }))).verdict, bad).toBe('WEAKENED');
      }
      for (const good of ['2099-01-31', '2096-02-29', '2400-02-29', '2026-11-04']) {
        expect((await compute([d2()], options('prod', { readCard: reader(`mustPayBefore: ${good}\n`), now: () => NOW }))).verdict, good).toBe('NOT WEAKENED');
      }
      // The day itself is not "before": a date equal to today's UTC midnight has passed.
      expect((await compute([d2()], options('prod', { readCard: reader('mustPayBefore: 2026-11-03\n'), now: () => NOW }))).verdict).toBe('WEAKENED');
    });
    it('takes the pay-by date only from the card on main, never from the model finding', async () => {
      // An overdue card cannot be revived by a later model-supplied date.
      expect((await compute([d2({ mustPayBefore: '2026-12-01' })], options('prerelease', { readCard: reader('mustPayBefore: 2026-11-01\n'), now: () => NOW }))).verdict).toBe('WEAKENED');
      expect((await compute([d2({ mustPayBefore: 'prod' })], options('prerelease', { readCard: reader('mustPayBefore: 2026-11-01\n'), now: () => NOW }))).verdict).toBe('WEAKENED');
      // A model-supplied overdue date does not override a card with no pay-by either way.
      expect((await compute([d2({ mustPayBefore: '2026-11-01' })], options('prerelease', { readCard: reader(), now: () => NOW }))).verdict).toBe('NOT WEAKENED');
    });
    it.each([
      ['a trailing comment', 'mustPayBefore: 2026-12-01 # later'], ['an indent', '  mustPayBefore: 2026-12-01'],
      ['a space before the colon', 'mustPayBefore : 2026-12-01'], ['different case', 'MustPayBefore: 2026-12-01'],
      ['a bare-CR line ending and trailing text','status: open\rmustPayBefore: 2026-12-01 x'], ['two pay-by lines', 'mustPayBefore: 2026-12-01\nmustPayBefore: 2026-11-01'],
      ['a prod pay-by with trailing text', 'mustPayBefore: prod # x'],
    ])('a pay-by line with %s that does not parse strictly fails closed', async (_n, body) => {
      for (const stage of ['prerelease', 'prod']) {
        expect((await compute([d2()], options(stage, { readCard: reader(`${body}\n`), now: () => NOW }))).verdict).toBe('WEAKENED');
      }
    });
    it('a card due before prod ships at prerelease and blocks at prod', async () => {
      const due = () => reader('status: open\nmustPayBefore: prod\n');
      expect((await compute([d2()], options('prerelease', { readCard: due(), now: () => NOW }))).verdict).toBe('NOT WEAKENED');
      const prod = await compute([d2()], options('prod', { readCard: due(), now: () => NOW }));
      expect(prod.verdict).toBe('WEAKENED');
      expect(ids(prod.blocks)).toEqual(['f1']);
      // The default stage is prerelease; an omitted stage keeps prerelease behaviour.
      expect((await compute([d2()], { raceBlockPaths: [], rulings: [], readCard: due(), now: () => NOW })).verdict).toBe('NOT WEAKENED');
    });
  });

});

describe('card outcomes, proof binding and the default card reader (PR #6381 judge)', () => {
  it('a prerelease E1 ships with an expedite card due in 72 hours; E2 ships as debt with no deadline', async () => {
    const e1 = await compute([finding({ class: 'E1' })], options());
    expect(e1.cards).toEqual([expect.objectContaining({ id: 'f1', class: 'E1', outcome: 'expedite', deadlineHours: 72 })]);
    const e2 = await compute([finding({ class: 'E2' })], options());
    expect(e2.cards).toEqual([expect.objectContaining({ id: 'f1', class: 'E2', outcome: 'debt' })]);
    expect(e2.cards[0]).not.toHaveProperty('deadlineHours');
    expect((await compute([finding({ class: 'E1' })], options('prod'))).cards).toEqual([]);
  });

  const full = finding({ class: 'D2', card: 'backlog/6400-debt.md', ruling: 'R1', hunkHash: 'abc123' });
  it.each([['id', 'f2'], ['file', 'scripts/other.mjs'], ['line', 13], ['invariant', 'Another invariant'], ['class', 'D3'],
    ['trigger', 'Another trigger'], ['consequence', 'Another consequence'], ['card', 'backlog/6401-other.md'], ['ruling', 'R2'], ['hunkHash', 'def456']])(
    'the proof fingerprint binds the %s evidence field', (key, other) => {
      expect(proofFingerprint({ ...full, [key]: other })).not.toBe(proofFingerprint(full));
    });
  // The full re-check fingerprint guarantee (PR #6381 deferred advisory): a re-check may keep or downgrade the SAME
  // finding, never another one, so every evidence column — including the model relation label the proof fingerprint
  // omits — is bound. Only the interleaving stays unbound (adding one only escalates).
  it('the full re-check fingerprint binds every evidence column, relation included, and never the interleaving (PR #6381 deferred advisory)', () => {
    const columns = [['id', 'f2'], ['file', 'scripts/other.mjs'], ['line', 13], ['invariant', 'Another invariant'], ['class', 'D3'],
      ['relation', 'untouched'], ['trigger', 'Another trigger'], ['consequence', 'Another consequence'], ['card', 'backlog/6401-other.md'],
      ['ruling', 'R2'], ['hunkHash', 'def456']];
    for (const [key, other] of columns) {
      expect(findingFingerprint({ ...full, [key]: other }), key).not.toBe(findingFingerprint(full));
      // Dropping an optional column is a change too, never a wildcard.
      if (!['id', 'file', 'line', 'invariant', 'class', 'relation', 'consequence'].includes(key)) {
        const { [key]: _drop, ...rest } = full;
        expect(findingFingerprint(rest), `${key} dropped`).not.toBe(findingFingerprint(full));
      }
    }
    // The relation label is the one column the full fingerprint binds and the proof fingerprint does not.
    const relabelled = { ...full, relation: 'untouched' };
    expect(proofFingerprint(relabelled)).toBe(proofFingerprint(full));
    expect(findingFingerprint(relabelled)).not.toBe(findingFingerprint(full));
    // The interleaving is unbound, and the column list is not ambiguous: splitting text across two columns differs.
    expect(findingFingerprint({ ...full, interleaving })).toBe(findingFingerprint(full));
    expect(findingFingerprint({ ...full, file: 'a', invariant: 'b","c' })).not.toBe(findingFingerprint({ ...full, file: 'a","b', invariant: 'c' }));
    // An absent optional column and an explicit null are the same evidence, so a re-check that echoes null keeps it.
    const { trigger: _t, ...noTrigger } = full;
    expect(findingFingerprint(noTrigger)).toBe(findingFingerprint({ ...full, trigger: null }));
  });
  it('the proof fingerprint ignores the model relation label and the interleaving, and a stale proof blocks', async () => {
    expect(proofFingerprint({ ...full, relation: 'untouched' })).toBe(proofFingerprint(full));
    expect(proofFingerprint({ ...full, interleaving })).toBe(proofFingerprint(full));
    // A proof for the finding as first reported does not cover a restated consequence.
    const restated = { ...full, consequence: 'Restated consequence' };
    const card = { readCard: () => 'mustPayBefore: 2099-01-01\n' };
    const r = await compute([restated], options('prerelease', { relationProofs: [proofFor(full)], ...card }));
    expect(r.verdict).toBe('WEAKENED');
    // Positive control: the unchanged finding with the same proof ships.
    expect((await compute([full], options('prerelease', { relationProofs: [proofFor(full)], ...card }))).verdict).toBe('NOT WEAKENED');
  });

  const ok = stdout => ({ status: 0, stdout, stderr: '' });
  it('the default reader fetches origin/main, then reads the card from origin/main', () => {
    const run = vi.fn((_cmd, args) => (args[0] === 'fetch' ? ok('') : ok('mustPayBefore: 2099-01-01\n')));
    expect(readCardFromMain('backlog/6400-debt.md', { run })).toBe('mustPayBefore: 2099-01-01\n');
    expect(run.mock.calls.map(c => [c[0], ...c[1]])).toEqual([
      ['git', 'fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      // The full ref name, so a local branch called `origin/main` cannot shadow it.
      ['git', 'show', 'refs/remotes/origin/main:backlog/6400-debt.md']]);
    for (const call of run.mock.calls) {
      expect(call[2]).toMatchObject({ timeout: 30_000, maxBuffer: 1 << 20 });
      expect(call[2].env.GIT_TERMINAL_PROMPT).toBe('0');
    }
  });
  it.each([
    ['the fetch exits non-zero', args => (args[0] === 'fetch' ? { status: 128, stdout: '', stderr: 'offline' } : ok('x'))],
    ['the fetch errors', args => (args[0] === 'fetch' ? { error: new Error('ETIMEDOUT'), status: null } : ok('x'))],
    ['the fetch throws', args => { if (args[0] === 'fetch') throw new Error('spawn failed'); return ok('x'); }],
    ['the card is not on origin/main', args => (args[0] === 'fetch' ? ok('') : { status: 128, stdout: '', stderr: 'does not exist' })],
    ['the show errors', args => (args[0] === 'fetch' ? ok('') : { error: new Error('ENOBUFS'), status: null, stdout: 'partial' })],
    ['the runner returns nothing', () => undefined],
  ])('the default reader returns null when %s, never a stale card', (_n, impl) => {
    expect(readCardFromMain('backlog/6400-debt.md', { run: vi.fn((_c, args) => impl(args)) })).toBeNull();
  });
  it('the default reader refuses a non-card path without running git', () => {
    const run = vi.fn(() => ok('x'));
    // A line break after the name (end-of-input anchor, as HASH_64 has: PR #6381 judge) or a `.md` folder is not a card.
    for (const p of ['../x.md', 'backlog/a/b.md', 'backlog/x.txt', 'backlog/x.md\n', 'backlog/x.md\r', 'backlog/x.md\r\n',
      `backlog/x.md${String.fromCodePoint(0x2028)}`, 'backlog/x.md/', 7, undefined]) expect(readCardFromMain(p, { run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('AU1 PR-A is inert', () => {
  // One helper, shared by the scan and its own pin below, so the pin tests the rule the scan applies.
  const commentOnly = text => /^\s*(\/\/|\/\*|\*)/.test(text);
  it('no runtime file imports the rubric core or its settings', async () => {
    const { spawnSync } = await import('node:child_process');
    const root = fileURLToPath(new NodeURL('../../../', import.meta.url));
    const grep = spawnSync('git', ['grep', '--untracked', '-nE', "audit-verdict\\.mjs|audit-settings\\.mjs", '--', 'scripts', 'skills-src', '.claude', 'src'],
      { cwd: root, encoding: 'utf8', maxBuffer: 1 << 24 });
    // A failed grep prints nothing, which would read as "no importers": require a clean run that saw this file.
    expect(grep.error).toBeUndefined();
    expect(grep.status, grep.stderr).toBe(0);
    const matches = grep.stdout.split('\n').filter(Boolean).map(l => { const m = /^(.*?):(\d+):(.*)$/.exec(l); return m && { file: m[1], text: m[3] }; });
    expect(matches.map(m => m?.file)).toContain('scripts/operations/__tests__/audit-verdict.test.mjs');
    // Any CODE line naming either module counts (an import, a dynamic import, a CLI spawn). A line that is only a
    // comment does not: main's codex-audit.mjs notes its resolver "moves to scripts/lib/audit-settings.mjs once that
    // lands" (PR #6381 merge with AU1 PR-B). A comment marker after code on the same line still counts as code.
    const hits = [...new Set(matches.filter(m => !m || (/\.(mjs|js|cjs|ts)$/.test(m.file) && !/__tests__\/|\.test\./.test(m.file)
      && !/audit-(verdict|settings)\.mjs$/.test(m.file) && !commentOnly(m.text))).map(m => m?.file ?? 'unparsed grep line'))];
    expect(hits).toEqual([]);
  });
  it('the inertness check ignores a comment-only mention but catches code that names the module (PR #6381 merge)', () => {
    expect(commentOnly(' * scripts/lib/audit-settings.mjs once that lands. */')).toBe(true);
    expect(commentOnly('// see audit-verdict.mjs')).toBe(true);
    expect(commentOnly("import { computeVerdict } from './audit-verdict.mjs';")).toBe(false);
    expect(commentOnly("const v = await import('../lib/audit-settings.mjs'); // lazy")).toBe(false);
    expect(commentOnly("spawnSync('node', ['scripts/operations/audit-verdict.mjs'])")).toBe(false);
  });
});

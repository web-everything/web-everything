/**
 * @file output-mix.test.mjs — the weekly product-vs-machinery output ratio (#3012).
 *
 * Three surfaces, and the middle one is the reason this file exists:
 *   • the GLOB → the pattern dialect is deliberately tiny, so its edges (`*` stopping at `/`, both ends
 *     anchored) have to be pinned or `src/**` quietly starts matching `vendor/src/x`.
 *   • the REAL-PATH PIN — a table of paths that actually exist in this repository, asserted against the
 *     committed rule list. This is the regression net for the file that is MEANT to be edited: changing a
 *     rule in `output-mix-paths.json` is encouraged, changing it by accident is not, and this test makes the
 *     blast radius of any edit visible in the diff.
 *   • the NUMSTAT PARSE + BUCKETING → renames and binaries are the two shapes that silently corrupt a line
 *     count, and this repo renames a file every time a backlog card is JIT-numbered.
 *
 * Nothing here shells out to git except the one end-to-end case, which asserts SHAPE and invariants against
 * the live repository — never a specific number, which would re-break every week.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  CLASSES,
  WEEK_COUNT,
  ROOT,
  RULES_PATH,
  patternToRegExp,
  loadRules,
  classifyPath,
  isoWeekStart,
  weekStarts,
  parseNumstatZ,
  bucketWeeks,
  computeOutputMix,
  ratioLabel,
} from '../output-mix.mjs';

const RULES = loadRules();
const classOf = (p) => classifyPath(p, RULES).class;

describe('patternToRegExp — the tiny glob dialect', () => {
  it('`*` stops at a separator, `**` spans it', () => {
    expect(patternToRegExp('src/*').test('src/a.njk')).toBe(true);
    expect(patternToRegExp('src/*').test('src/a/b.njk')).toBe(false);
    expect(patternToRegExp('src/**').test('src/a/b/c.njk')).toBe(true);
  });

  it('is anchored at BOTH ends, so a prefix rule cannot match a nested lookalike', () => {
    expect(patternToRegExp('src/**').test('vendor/src/a.njk')).toBe(false);
    expect(patternToRegExp('package-lock.json').test('sub/package-lock.json')).toBe(false);
    expect(patternToRegExp('package-lock.json').test('package-lock.json')).toBe(true);
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    expect(patternToRegExp('custom-elements.json').test('custom-elements.json')).toBe(true);
    expect(patternToRegExp('custom-elements.json').test('custom-elementsXjson')).toBe(false);
  });
});

describe('the committed rule list', () => {
  it('every rule declares a known class and explains itself in one line', () => {
    for (const r of RULES.rules) {
      expect(CLASSES, `${r.match}`).toContain(r.class);
      expect(r.why.trim().length, `${r.match} has an empty why`).toBeGreaterThan(0);
    }
  });

  it('rejects a rule with an unknown class rather than silently counting it as other', () => {
    expect(() => loadRules(new URL('./fixtures/does-not-exist.json', import.meta.url).pathname)).toThrow();
  });

  it('is valid JSON with a self-describing header, so a reader can open it cold', () => {
    const raw = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
    expect(raw.description).toMatch(/#3012/);
    expect(Object.keys(raw.conventions)).toEqual(
      expect.arrayContaining(['matching', 'counting', 'tests', 'generated', 'productScope', 'default', 'knownGap']),
    );
  });

  /**
   * THE INERT RULES. `reports/**` and `plugs/**` both resolve to `other`, which is ALSO the default class,
   * so deleting either one moves no number and every path-table assertion above stays green. Their entire
   * stated value is being explicit rather than left to omission — "the choice is visible and arguable". A
   * classification that only a comment defends is one silent edit away from being unmade, so the presence
   * and class of these two are asserted directly against the rule list rather than through a classified path.
   */
  it.each([
    ['reports/**', 'other'],
    ['plugs/**', 'other'],
  ])('keeps %s as an EXPLICIT rule, not left to the default', (match, cls) => {
    const rule = RULES.rules.find((r) => r.match === match);
    expect(rule, `${match} was removed — it classifies the same as the default, so nothing else fails`).toBeDefined();
    expect(rule.class).toBe(cls);
    expect(rule.why.trim().length).toBeGreaterThan(0);
  });
});

/**
 * THE PIN. Every path below is a real one in this repository (or the exact shape of one), so an edit to the
 * rule list shows up here as a failing, readable assertion rather than as a number that moved on the board.
 */
describe('classifyPath — real repository paths', () => {
  const cases = [
    // product — the standard's data, the site that renders it, the blocks, the demos, their tests
    ['src/_data/blocks.json', 'product'],
    ['src/_includes/block-descriptions/simple-store.njk', 'product'],
    ['src/css/site.css', 'product'],
    ['src/index.njk', 'product'],
    ['blocks/renderers/module-service/index.ts', 'product'],
    ['demos/declarative-spa.html', 'product'],
    ['tests/a11y/routes.spec.ts', 'product'],

    // product — the standard's own DECLARATIONS, the half WE ships across the seam to FUI.
    // The four real `@webeverything/*` packages (each has a package.json with an `exports` map):
    ['contracts/intl.ts', 'product'],
    ['contracts/package.json', 'product'],
    ['capability-manifest/index.ts', 'product'],
    ['webcases/requirementValidator.ts', 'product'],
    ['validation-generation/adapters/zod.ts', 'product'],
    // the capability + conformance substrate:
    ['capabilities/resolver.ts', 'product'],
    ['conformance-vectors/schema.ts', 'product'],
    ['conformance-vectors/intl.vectors.ts', 'product'],
    ['conformance-evidence/provider.ts', 'product'],
    ['wrapper-conformance/runner.ts', 'product'],
    // the per-domain declaration trees — the contract half AND the dependency-free model beside it:
    ['intl/contract.ts', 'product'],
    ['notifications/push-contract.ts', 'product'],
    ['positioning/contract.ts', 'product'],
    ['guard/provider.ts', 'product'],
    ['guard/__tests__/registry.test.ts', 'product'],
    ['manifests/changelog-contract.ts', 'product'],
    ['repro-bundle/repro-bundle.vectors.ts', 'product'],
    ['webtraits/intentProfileResolver.ts', 'product'],

    // machinery + bookkeeping
    ['backlog/3012-put-the-weekly-product-vs-machinery-output-ratio-on-the-prog.md', 'machinery'],
    ['scripts/progress-board.mjs', 'machinery'],
    ['scripts/lib/output-mix.mjs', 'machinery'],
    ['scripts/__tests__/progress-board.test.mjs', 'machinery'],
    ['scripts/lib/__tests__/output-mix.test.mjs', 'machinery'],
    ['skills-src/progress-board/SKILL.md', 'machinery'],
    ['agent-memory-src/9-memory_management_policy.md', 'machinery'],
    ['.claude/settings.json', 'machinery'],
    ['docs/agent/testing.md', 'machinery'],
    // Not under docs/agent/ — it fell to `other` before the docs/** rule, against the stated intent.
    ['docs/design/mocks/console-ruling-surface.html', 'machinery'],
    // The lane transport's own bookkeeping: +1,170 lines in the measured window, previously unclassified.
    ['.lane-manifest.json', 'machinery'],
    ['.github/workflows/ci.yml', 'machinery'],
    ['.githooks/post-merge', 'machinery'],
    ['tools/whatever.mjs', 'machinery'],

    // other — generated, lockfiles, vendored, reports, and the unmatched remainder
    ['package-lock.json', 'other'],
    ['custom-elements.json', 'other'],
    ['src/_data/referenceIndex.json', 'other'],
    ['blocks/renderers/module-service/maas-servepath.openapi.json', 'other'],
    ['conformance-vectors/webdirectives-ssr.vectors.json', 'other'],
    ['plugs/custom-store/index.js', 'other'],
    ['reports/2026-08-08-agent-command-surface-sizing.md', 'other'],
    ['AGENTS.md', 'other'],
    ['package.json', 'other'],
    // …and the eight directories still deliberately left unruled (see `conventions.knownGap`). These rows
    // are the OPEN QUESTIONS, pinned so that ruling one of them is a visible edit here, not a silent drift.
    ['config/resolverContract.ts', 'other'],
    ['design-systems/shadcn.tokens.json', 'other'],
    ['audits/backlog-health-audit.md', 'other'],
    ['test-pages/webcontexts.html', 'other'],
    ['eleventy/filters.cjs', 'other'],
    ['functions/__tests__/gate.test.ts', 'other'],
  ];

  it.each(cases)('%s → %s', (path, expected) => {
    expect(classOf(path)).toBe(expected);
  });

  it('charges a test to the thing it tests, not to a class of its own', () => {
    // The stated treatment: machinery tests are machinery, product tests are product.
    expect(classOf('scripts/__tests__/pr-land.test.mjs')).toBe('machinery');
    expect(classOf('tests/integration/nav.spec.ts')).toBe('product');
  });

  it('lets a generated file inside a product tree beat the product rule — order is load-bearing', () => {
    expect(classOf('src/_data/referenceIndex.json')).toBe('other');
    expect(classOf('src/_data/blocks.json')).toBe('product');
    // conformance-vectors/ became a product tree in the same revision that made this ordering matter: the
    // GENERATED vectors file must still lose to its exclusion, or a generator's output starts scoring as
    // the standard's own declarations.
    expect(classOf('conformance-vectors/webdirectives-ssr.vectors.json')).toBe('other');
    expect(classOf('conformance-vectors/webdocs.vectors.ts')).toBe('product');
  });

  /**
   * THE DECLARATION-SHAPE RULES. `contracts/`, `guard/`, `intl/` … are named directories, which means a
   * NEW domain landing tomorrow would fall to `other` until someone edited the rule list. The three shape
   * rules (`**\/contract.ts`, `**\/*-contract.ts`, `**\/*.vectors.ts`) close that: this repo's convention is
   * that a file with one of those names IS the pure-contract half, wherever it sits. They are the reason
   * the classifier encodes the PRINCIPLE and not a snapshot of today's folder names.
   */
  it('classifies a declaration by SHAPE, so a brand-new domain is product on day one', () => {
    expect(classOf('brand-new-domain/contract.ts')).toBe('product');
    expect(classOf('brand-new-domain/some-thing-contract.ts')).toBe('product');
    expect(classOf('brand-new-domain/brand-new-domain.vectors.ts')).toBe('product');
    // …but only the declaration itself. The rest of an unruled tree still falls to the remainder, which is
    // what keeps the coverage ratchet below honest about the directory.
    expect(classOf('brand-new-domain/provider.ts')).toBe('other');
  });

  it('keeps the RULED delivery-side trees above the shape rules, so a write-up never scores as a contract', () => {
    // `reports/**` and every machinery rule sit ABOVE the product block on purpose. If the shape rules were
    // hoisted over them, a design note or a script fixture named contract.ts would be credited as product.
    for (const d of ['scripts', 'tools', 'backlog', '.claude', 'skills-src', 'agent-memory-src', '.github', '.githooks']) {
      expect(classOf(`${d}/fixtures/contract.ts`), `${d}/ no longer beats the shape rules`).toBe('machinery');
      expect(classOf(`${d}/fixtures/x.vectors.ts`), `${d}/ no longer beats the shape rules`).toBe('machinery');
    }
    expect(classOf('reports/2026-01-01-whatever/contract.ts')).toBe('other');
    expect(classOf('reports/2026-01-01-whatever/x.vectors.ts')).toBe('other');
    expect(classOf('docs/agent/examples/contract.ts')).toBe('machinery');
  });

  /**
   * …AND WHERE THAT PROTECTION STOPS. Ordering only defends a tree that HAS a rule. The eight directories
   * `conventions.knownGap` pins as uncovered have none, so a declaration-shaped file inside any of them is
   * credited as `product` today — `eleventy/x/contract.ts` is build config scoring as the standard's own
   * declaration. The exposure is currently EMPTY (no tracked file and no path in the five measured weeks is
   * classified by a shape rule, asserted below), so this is a latent hole rather than a live over-count. It
   * is pinned rather than quietly fixed because closing it means RULING those directories, which moves the
   * headline number and is the operator's call — but it must not be able to change without a visible diff.
   */
  it('pins where the shape rules still reach — an uncovered directory is NOT protected', () => {
    for (const d of ['audits', 'bun-trial', 'config', 'design-refs', 'design-systems', 'eleventy', 'functions', 'site', 'test-pages']) {
      expect(classOf(`${d}/probe.ts`), `${d}/ is no longer uncovered`).toBe('other');
      expect(classOf(`${d}/nested/contract.ts`), `${d}/ shape exposure changed`).toBe('product');
      expect(classOf(`${d}/nested/x.vectors.ts`), `${d}/ shape exposure changed`).toBe('product');
    }
  });

  it('keeps that exposure empty — nothing tracked today is classified by a shape rule', () => {
    const shapes = new Set(['**/contract.ts', '**/*-contract.ts', '**/*.vectors.ts']);
    const tracked = execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '--name-only', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 256,
    })
      .split('\n')
      .filter(Boolean);
    const viaShape = tracked.filter((f) => shapes.has(classifyPath(f, RULES).match));
    // A hit is not automatically wrong — it may be a genuine new domain's contract. But it must be SEEN:
    // every such file is product without any directory rule vouching for it.
    expect(viaShape, `these files score product only by SHAPE — rule their directory or accept them here`).toEqual([]);
  });

  it('answers "why is this file machinery?" in one line, from the file', () => {
    const { why, match } = classifyPath('skills-src/drain/SKILL.md', RULES);
    expect(match).toBe('skills-src/**');
    expect(why).toContain('symlink');
  });

  it('falls to the default class with a reason when nothing matches', () => {
    const r = classifyPath('some/unclassified/thing.txt', RULES);
    expect(r.class).toBe('other');
    expect(r.match).toBeNull();
    expect(r.why).toMatch(/no rule/);
  });
});

/**
 * THE COVERAGE RATCHET — the test the first cut of this file did not have.
 *
 * The rule list is an ALLOWLIST over a default of `other`, and the two headline classes were not covered
 * equally. Machinery lives in nine stable directories, all of them matched. Product started matched in
 * four (`src/`, `blocks/`, `demos/`, `tests/`) while the standard's own declarations — the
 * `@webeverything/*` contract packages, the capability/conformance substrate, and the per-domain
 * `<domain>/contract.ts` trees — lived in 44 more that no rule named, so 26,670 tracked lines of the thing
 * this repo exists to SHIP fell to `other`. Those 44 are ruled `product` now, on the operator's direction
 * that "for WE contracts and similar are the main product". EIGHT directories remain unmatched, two of
 * them live questions rather than settled `other` (`config/` holds a resolver contract; `design-systems/`
 * calls itself WE-owned data). So `product` is still a lower bound, by much less. See
 * `conventions.knownGap`.
 *
 * The path table above cannot see this: it asserts what the rules DO classify, and a directory nobody wrote
 * a rule for has no row. So the gap is pinned directly. Three things fail here, all deliberately:
 *   • a NEW top-level directory that no rule covers — it must be classified on the way in, not discovered
 *     later as a number that quietly moved;
 *   • one of these directories finally being ruled `product` or `machinery` — the list must shrink WITH the
 *     ruling, in the same diff, so the gap statement and the rules never drift apart. That is not a
 *     nuisance to route around: this test went red when the 44 declaration directories were ruled, and the
 *     correct response was to shrink the list here and rewrite `knownGap`, never to weaken the assertion;
 *   • the rule list's prose and this list disagreeing — `knownGap` must NAME every directory pinned here,
 *     so the paragraph a reader trusts and the list a test enforces can never drift.
 */
describe('rule-list coverage over the real tree', () => {
  const KNOWN_UNCOVERED = ['audits', 'bun-trial', 'config', 'design-refs', 'design-systems', 'eleventy', 'functions', 'site', 'test-pages'];

  /** The declaration homes ruled `product` by this revision — the machinery-coverage test's counterpart. */
  const PRODUCT_HOMES = [
    // the site half, unchanged
    'src', 'blocks', 'demos', 'tests',
    // the four real `@webeverything/*` packages
    'contracts', 'capability-manifest', 'webcases', 'validation-generation',
    // the capability + conformance substrate
    'capabilities', 'conformance-vectors', 'conformance-evidence', 'wrapper-conformance',
    // the per-domain declaration trees
    'analytics', 'charts', 'commitment-policy', 'error-summary', 'experiment', 'explorer', 'graphs', 'guard',
    'identity', 'interaction-state', 'intl', 'manifests', 'module-resolution', 'notifications', 'permissions',
    'plug-parity', 'positioning', 'process', 'range-anchor', 'realtime', 'reliability', 'repro-bundle',
    'reproduction-parity', 'resources', 'source-resolution', 'suggested-edit', 'trainable-judge',
    'validator-resolution', 'validity-merge', 'webcompliance', 'webcontexts', 'webdocs', 'webinjectors',
    'webpolicy', 'webtheme', 'webtraits',
  ];

  const trackedTopLevelDirs = () =>
    execFileSync('git', ['-C', ROOT, 'ls-tree', '--name-only', '-d', 'HEAD'], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

  it('pins exactly which top-level directories no rule covers', () => {
    const uncovered = trackedTopLevelDirs().filter((d) => classifyPath(`${d}/probe.ts`, RULES).match === null);
    expect(uncovered.sort()).toEqual([...KNOWN_UNCOVERED].sort());
  });

  it('keeps machinery coverage complete — every machinery home is matched by a rule', () => {
    for (const d of ['scripts', 'backlog', '.claude', 'skills-src', 'agent-memory-src', 'docs', '.github', '.githooks', 'tools', 'schemas']) {
      expect(classOf(`${d}/probe.ts`), `${d}/ is no longer machinery`).toBe('machinery');
    }
  });

  it('keeps product coverage over every declaration home — the seam WE ships across', () => {
    for (const d of PRODUCT_HOMES) {
      expect(trackedTopLevelDirs(), `${d}/ is in PRODUCT_HOMES but is not a tracked directory`).toContain(d);
      expect(classOf(`${d}/probe.ts`), `${d}/ is no longer product`).toBe('product');
    }
  });

  it('states the product-coverage gap in the rule list itself, not only in a test', () => {
    const raw = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
    expect(raw.conventions.knownGap).toMatch(/LOWER BOUND/);
    // The prose must name every directory the ratchet pins, or the paragraph a reader trusts drifts from
    // the list a test enforces.
    for (const d of KNOWN_UNCOVERED) expect(raw.conventions.knownGap, `knownGap does not name ${d}/`).toContain(`${d}/`);
    // The membership test the rules encode has to be written down too, not inferrable from 47 `why` lines.
    expect(raw.conventions.productScope).toMatch(/cross the seam/);
  });
});

describe('ISO weeks', () => {
  it('snaps any day to its Monday, in UTC', () => {
    expect(isoWeekStart('2026-08-09')).toBe('2026-08-03'); // a Sunday belongs to the week that started Monday
    expect(isoWeekStart('2026-08-03')).toBe('2026-08-03');
    expect(isoWeekStart('2026-08-04')).toBe('2026-08-03');
    expect(isoWeekStart('2026-08-10')).toBe('2026-08-10');
  });

  it('produces the current week last, four completed weeks before it', () => {
    const w = weekStarts('2026-08-09');
    expect(w).toHaveLength(WEEK_COUNT);
    expect(w).toEqual(['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03']);
  });

  it('gives the same completed weeks for any day inside the current week — the reproducibility property', () => {
    for (const day of ['2026-08-03', '2026-08-05', '2026-08-09']) {
      expect(weekStarts(day).slice(0, 4)).toEqual(['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']);
    }
  });

  it('refuses a malformed date rather than bucketing into NaN', () => {
    expect(() => isoWeekStart('not-a-date')).toThrow(/YYYY-MM-DD/);
  });
});

describe('parseNumstatZ', () => {
  const commit = (sha, day) => `OMC|${sha}|${day}\0`;

  it('reads plain records', () => {
    const out = `${commit('aaa', '2026-08-04')}\n10\t2\tscripts/a.mjs\0` + `3\t0\tsrc/b.njk\0`;
    expect(parseNumstatZ(out)).toEqual([
      { day: '2026-08-04', path: 'scripts/a.mjs', added: 10 },
      { day: '2026-08-04', path: 'src/b.njk', added: 3 },
    ]);
  });

  it('takes the NEW path of a rename, which is emitted as three NUL-separated tokens', () => {
    // This is the shape every JIT-numbered backlog card produces, so getting it wrong mis-files real lines.
    const out = `${commit('bbb', '2026-08-05')}\n5\t4\t\0backlog/xabc-old.md\0backlog/3039-new.md\0` + `1\t0\tscripts/c.mjs\0`;
    expect(parseNumstatZ(out)).toEqual([
      { day: '2026-08-05', path: 'backlog/3039-new.md', added: 5 },
      { day: '2026-08-05', path: 'scripts/c.mjs', added: 1 },
    ]);
  });

  it('counts a binary file as zero rather than NaN', () => {
    const out = `${commit('ccc', '2026-08-06')}\n-\t-\tsrc/assets/logo.png\0`;
    expect(parseNumstatZ(out)).toEqual([{ day: '2026-08-06', path: 'src/assets/logo.png', added: 0 }]);
  });

  it('keeps commits apart and ignores a trailing empty token', () => {
    const out = `${commit('ddd', '2026-08-04')}\n1\t0\tsrc/a.njk\0` + `${commit('eee', '2026-07-30')}\n2\t0\tsrc/b.njk\0`;
    expect(parseNumstatZ(out).map((r) => r.day)).toEqual(['2026-08-04', '2026-07-30']);
  });

  it('returns nothing for empty input', () => {
    expect(parseNumstatZ('')).toEqual([]);
  });
});

describe('bucketWeeks', () => {
  const starts = weekStarts('2026-08-09');

  it('sums ADDED lines per class per week and reports the remainder', () => {
    const rows = [
      { day: '2026-08-04', path: 'src/a.njk', added: 100 },
      { day: '2026-08-05', path: 'scripts/b.mjs', added: 400 },
      { day: '2026-08-05', path: 'backlog/9999-x.md', added: 50 },
      { day: '2026-08-06', path: 'reports/r.md', added: 7 },
      { day: '2026-07-28', path: 'demos/d.html', added: 20 },
    ];
    const weeks = bucketWeeks(rows, starts, RULES);
    const cur = weeks[weeks.length - 1];
    expect(cur).toMatchObject({ start: '2026-08-03', end: '2026-08-09', product: 100, machinery: 450, other: 7, total: 557 });
    expect(weeks[3]).toMatchObject({ start: '2026-07-27', product: 20, machinery: 0, other: 0 });
  });

  it('drops rows outside the window instead of folding them into the nearest week', () => {
    const weeks = bucketWeeks(
      [
        { day: '2026-01-01', path: 'src/old.njk', added: 999 },
        { day: '2026-12-31', path: 'src/future.njk', added: 999 },
      ],
      starts,
      RULES,
    );
    expect(weeks.reduce((n, w) => n + w.total, 0)).toBe(0);
  });

  it('always returns exactly the requested weeks, zero-filled', () => {
    const weeks = bucketWeeks([], starts, RULES);
    expect(weeks.map((w) => w.start)).toEqual(starts);
    expect(weeks.every((w) => w.total === 0)).toBe(true);
  });
});

describe('ratioLabel', () => {
  it('names the direction and escalates severity with the imbalance', () => {
    expect(ratioLabel({ product: 100, machinery: 50 })).toMatchObject({ sev: 'ok' });
    expect(ratioLabel({ product: 100, machinery: 300 })).toMatchObject({ sev: 'warn' });
    expect(ratioLabel({ product: 100, machinery: 5000 })).toMatchObject({ sev: 'crit' });
  });

  it('says "no product output at all" rather than dividing by zero', () => {
    expect(ratioLabel({ product: 0, machinery: 5000 })).toEqual({ text: 'no product output at all', sev: 'crit' });
    expect(ratioLabel({ product: 0, machinery: 0 })).toMatchObject({ sev: 'muted' });
  });
});

describe('computeOutputMix — against the live repository', () => {
  it('derives the current week plus four completed weeks, and never throws', () => {
    const mix = computeOutputMix({ today: '2026-08-09' });
    expect(mix.fresh).toBe(true);
    expect(mix.weeks).toHaveLength(WEEK_COUNT);
    expect(mix.trend).toHaveLength(WEEK_COUNT - 1);
    expect(mix.current.start).toBe('2026-08-03');
    // Deliberately NOT an exact number — that would re-break every week. The invariant is that the three
    // classes partition the week's additions exactly, which is what makes the two headline numbers honest.
    for (const w of mix.weeks) expect(w.product + w.machinery + w.other).toBe(w.total);
  });

  it('degrades to an honest empty result instead of throwing when the repository cannot be read', () => {
    const mix = computeOutputMix({ repoRoot: '/definitely/not/a/repo', today: '2026-08-09' });
    expect(mix.fresh).toBe(false);
    expect(mix.reason).toMatch(/git history could not be read/);
    expect(mix.weeks).toEqual([]);
    expect(mix.current).toBeNull();
  });

  it('degrades the same way when the classifier itself is unreadable', () => {
    const mix = computeOutputMix({ today: '2026-08-09', rulesPath: '/definitely/not/a/file.json' });
    expect(mix.fresh).toBe(false);
    expect(mix.reason).toMatch(/classifier could not be read/);
  });
});

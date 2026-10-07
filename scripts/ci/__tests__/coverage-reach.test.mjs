import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createReach, makeIsCovered, planeDirsFromInclude } from '../coverage-reach.mjs';

function withRepo(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'cov-reach-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const isCovered = makeIsCovered(['blocks'], ['scripts/lib/tier.mjs']);

describe('coverage-reach (card 12)', () => {
  it('derives plane directories from coverage.include globs', () => {
    expect(planeDirsFromInclude(['scripts/lib/x.mjs', 'blocks/**/*.ts', 'guard/**/*.ts'])).toEqual(['blocks', 'guard']);
  });

  it('a test importing a trust-chain tier file directly or transitively reaches coverage', () => {
    withRepo({
      'scripts/lib/tier.mjs': 'export const x = 1;',
      'scripts/lib/helper.mjs': "export * from './tier.mjs';",
      'scripts/__tests__/a.test.mjs': "import { x } from '../lib/tier.mjs';",
      'scripts/__tests__/b.test.mjs': "import { x } from '../lib/helper.mjs';",
    }, (root) => {
      const reach = createReach({ repoRoot: root, isCovered });
      expect(reach('scripts/__tests__/a.test.mjs').reaches).toBe(true);
      expect(reach('scripts/__tests__/b.test.mjs')).toEqual({ reaches: true, via: 'scripts/lib/tier.mjs' });
    });
  });

  it('a test that only loads uncovered modules does not reach coverage', () => {
    withRepo({
      'scripts/lib/plain.mjs': 'export const y = 2;',
      'scripts/__tests__/c.test.mjs': "import { y } from '../lib/plain.mjs';",
    }, (root) => {
      expect(createReach({ repoRoot: root, isCovered })('scripts/__tests__/c.test.mjs').reaches).toBe(false);
    });
  });

  it('a repo-relative path literal and a plane directory count as an edge', () => {
    withRepo({
      'blocks/b/b.ts': 'export const b = 1;',
      'scripts/__tests__/d.test.mjs': "const p = 'blocks/b/b.ts';",
    }, (root) => {
      expect(createReach({ repoRoot: root, isCovered })('scripts/__tests__/d.test.mjs').reaches).toBe(true);
    });
  });

  it('a runtime-computed load (even in a helper) is treated as possibly reaching coverage', () => {
    withRepo({
      'scripts/lib/loader.mjs': 'export const load = (p) => import(p);',
      'scripts/__tests__/e.test.mjs': "import { load } from '../lib/loader.mjs';",
    }, (root) => {
      expect(createReach({ repoRoot: root, isCovered })('scripts/__tests__/e.test.mjs').reaches).toBe(true);
    });
  });

  // PR #4285 review: `import (p)` / `require (p)` / `import /* c */ (p)` are valid JS, so the opaque-load rule must
  // not assume the `(` touches the keyword. Every spelling below is a computed load with no path literal.
  it.each([
    ['import(p)', 'export const load = (p) => import(p);'],
    ['import (p)', 'export const load = (p) => import (p);'],
    ['import\\n(p)', 'export const load = (p) => import\n(p);'],
    ['import /* c */ (p)', 'export const load = (p) => import /* c */ (p);'],
    ['import // c\\n(p)', 'export const load = (p) => import // c\n(p);'],
    ['require(p)', 'export const load = (p) => require(p);'],
    ['require (p)', 'export const load = (p) => require (p);'],
    ['require /* c */ (p)', 'export const load = (p) => require /* c */ (p);'],
    ['import with a concatenated literal', "export const load = (p) => import('./x' + p);"],
    ['import (concatenated literal)', "export const load = (p) => import ('./x' + p);"],
    ['require with a template literal', 'export const load = (p) => require(`./x/${p}`);'],
    ['require?.(p)', 'export const load = (p) => require?.(p);'],
    ['(0, require)(p)', 'export const load = (p) => (0, require)(p);'],
    ['const r = require; r(p)', 'const r = require;\nexport const load = (p) => r(p);'],
    ['vi.importActual(p)', 'export const load = (p) => vi.importActual(p);'],
    ['import.meta.glob', "export const mods = import.meta.glob('./*.ts');"],
    ['import . meta . glob', "export const mods = import .meta\n.glob('./*.ts');"],
    ['createRequire', "import { createRequire } from 'node:module';"],
    ['import // c<CR>(p)', 'export const load = (p) => import // c\r(p);'],
    ['import // c<U+2028>(p)', 'export const load = (p) => import // c (p);'],
    ['an unclosed comment after import', 'export const load = (p) => import /* never closed (p);'],
    ['an over-long comment between import and (', `export const load = (p) => import /*${' x'.repeat(300)} */ (p);`],
  ])('a computed load spelled `%s` in a helper is treated as possibly reaching coverage', (_label, helper) => {
    withRepo({
      'scripts/lib/loader.mjs': helper,
      'scripts/__tests__/e.test.mjs': "import { load } from '../lib/loader.mjs';",
    }, (root) => {
      expect(createReach({ repoRoot: root, isCovered })('scripts/__tests__/e.test.mjs').reaches).toBe(true);
    });
  });

  it.each([
    ["import ('./plain.mjs')", "export const load = () => import ('./plain.mjs');"],
    ["require ('./plain.mjs')", "export const load = () => require ('./plain.mjs');"],
    ["import( './plain.mjs' )", "export const load = () => import( './plain.mjs' );"],
    ["vi.importActual('./plain.mjs')", "export const load = () => vi.importActual('./plain.mjs');"],
    ['a prose mention of "require"', '// we require that callers pass a path (see docs)\nexport const y = 1;'],
  ])('a fully literal load spelled `%s` stays a plain edge, not an opaque load', (_label, helper) => {
    withRepo({
      'scripts/lib/plain.mjs': 'export const y = 2;',
      'scripts/lib/loader.mjs': helper,
      'scripts/__tests__/e.test.mjs': "import { load } from '../lib/loader.mjs';",
    }, (root) => {
      expect(createReach({ repoRoot: root, isCovered })('scripts/__tests__/e.test.mjs').reaches).toBe(false);
    });
  });

  // PR #4285 review: TS-ESM style `./x.js` specifiers name `x.ts` on disk; the edge must not be lost.
  it.each([
    ['./tier.js', 'tier.ts'],
    ['./tier.mjs', 'tier.mts'],
    ['./tier.js', 'tier.tsx'],
  ])('a `%s` specifier resolves to %s so its reach edge is kept', (spec, onDisk) => {
    withRepo({
      [`scripts/lib/${onDisk}`]: 'export const x = 1;',
      'scripts/lib/helper.mjs': `export * from '${spec}';`,
      'scripts/__tests__/a.test.mjs': "import { x } from '../lib/helper.mjs';",
    }, (root) => {
      const covered = makeIsCovered([], [`scripts/lib/${onDisk}`]);
      expect(createReach({ repoRoot: root, isCovered: covered })('scripts/__tests__/a.test.mjs'))
        .toEqual({ reaches: true, via: `scripts/lib/${onDisk}` });
    });
  });

  it('a specifier whose `.js` file really exists is still preferred over a same-named `.ts`', () => {
    withRepo({
      'scripts/lib/tier.js': 'export const x = 1;',
      'scripts/lib/tier.ts': 'export const x = 2;',
      'scripts/__tests__/a.test.mjs': "import { x } from '../lib/tier.js';",
    }, (root) => {
      const covered = makeIsCovered([], ['scripts/lib/tier.ts']);
      expect(createReach({ repoRoot: root, isCovered: covered })('scripts/__tests__/a.test.mjs').reaches).toBe(false);
    });
  });

  // PR #4285 review (self-review variants): directory and suffixed specifiers are edges too.
  it.each([
    ["'./dir'", "export * from './dir';"],
    ["'./dir/'", "export * from './dir/';"],
    ["'./dir/tier.mjs?raw'", "export * from './dir/tier.mjs?raw';"],
    ["'./dir/tier.mjs#frag'", "export * from './dir/tier.mjs#frag';"],
  ])('a %s specifier keeps its reach edge', (_label, helper) => {
    withRepo({
      'scripts/lib/dir/index.mjs': "export * from './tier.mjs';",
      'scripts/lib/dir/tier.mjs': 'export const x = 1;',
      'scripts/lib/helper.mjs': helper,
      'scripts/__tests__/a.test.mjs': "import { x } from '../lib/helper.mjs';",
    }, (root) => {
      const covered = makeIsCovered([], ['scripts/lib/dir/tier.mjs']);
      expect(createReach({ repoRoot: root, isCovered: covered })('scripts/__tests__/a.test.mjs').reaches).toBe(true);
    });
  });

  it('a file that cannot be read fails open (may reach coverage) rather than silently demoting its test', () => {
    withRepo({ 'scripts/__tests__/dir.test.mjs/keep': '' }, (root) => {
      // `dir.test.mjs` is a directory: readFileSync throws EISDIR.
      expect(createReach({ repoRoot: root, isCovered })('scripts/__tests__/dir.test.mjs').reaches).toBe(true);
    });
  });

  it('a file full of unclosed `import /*` openers is scanned in bounded time', () => {
    withRepo({
      'scripts/__tests__/p.test.mjs': 'import /* '.repeat(40000),
    }, (root) => {
      const t0 = Date.now();
      createReach({ repoRoot: root, isCovered })('scripts/__tests__/p.test.mjs');
      expect(Date.now() - t0).toBeLessThan(3000);
    });
  });

  // PR #4285 review: the `@`-prefixed skip is safe only while no vitest alias points into a coverage plane.
  // Pin it against the real config so adding such an alias reddens this test instead of silently dropping hits.
  it('no vitest resolve.alias target sits inside a coverage plane or the trust-chain tier', async () => {
    const { weAlias } = await import('../../../vitest.shared.ts');
    const { default: config } = await import('../../../vitest.config.ts');
    const { REPO_ROOT } = await import('../coverage-reach.mjs');
    const { relative } = await import('node:path');
    const include = config.test.coverage.include;
    const covered = makeIsCovered(planeDirsFromInclude(include));
    expect(planeDirsFromInclude(include).length).toBeGreaterThan(0);
    const planes = planeDirsFromInclude(include);
    const reach = createReach({ repoRoot: REPO_ROOT, isCovered: covered });
    for (const [name, target] of Object.entries(weAlias)) {
      // The skip only hides `@…` specifiers; an alias spelled any other way would be resolved from the repo root.
      expect(name.startsWith('@'), `alias ${name} must start with @`).toBe(true);
      const rel = relative(REPO_ROOT, String(target)).split('\\').join('/');
      expect(covered(rel), `alias ${name} -> ${rel}`).toBe(false);
      // a plane root itself (`plateau`) is not `startsWith('plateau/')`, so check equality too
      expect(planes.includes(rel), `alias ${name} -> plane root ${rel}`).toBe(false);
      // an alias into the repo must not lead (transitively) to a covered file either
      if (!rel.startsWith('..')) expect(reach(rel).reaches, `alias ${name} -> ${rel} reaches coverage`).toBe(false);
    }
  });
});

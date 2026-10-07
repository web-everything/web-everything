/**
 * @file coverage-reach.mjs — card 12 (perf sweep 2026-10-07): which unit-test files can possibly touch a file that
 * `vitest.config.ts` counts toward coverage?
 *
 * V8 coverage costs about 10-25% of a test's runtime but only matters for the files in `test.coverage.include`
 * (the planes' `.ts` sources plus the trust-chain tier). Most of the unit suite is `scripts/**` tests that never
 * load any of them. Those tests can run WITHOUT `--coverage` and the covered numbers cannot change, because a test
 * that never executes a covered file adds no hits to it.
 *
 * Reach is a static graph over path-like string literals: an edge for every `./x.mjs`, `../lib/y` or
 * `scripts/lib/z.mjs` literal that resolves to a real file, from the test and from every module it reaches (this
 * covers import / export-from / require / vi.mock / dynamic import with a literal). "Covered" is any file under a
 * coverage plane directory (derived from `coverage.include`; `coverage.exclude` is ignored, so over-including only
 * keeps a test under coverage) or in the trust-chain tier. A test is moved to the no-coverage group only when no
 * covered file is reachable. Subprocess-spawned code never contributes in-process coverage, so it is not an edge.
 *
 * A file with a runtime-computed load (`import(expr)`, `require(expr)`, `createRequire`) is treated as reaching a covered
 * file, since the static graph cannot see its target. The first draft without that rule let 8 trust-chain files take
 * hits from the no-coverage group; the rule removed them (see the PR for the empirical check: the no-coverage group
 * run WITH coverage shows zero hits on every covered file).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRUST_CHAIN_TIER_FILES } from '../lib/trust-chain-tier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

// A load whose target is computed at runtime (`import(expr)`, `require(expr)`, `createRequire`, `import.meta.glob`)
// is invisible to the literal graph, so any file that has one counts as "may reach a covered file".
const OPAQUE_LOAD = /\bimport\(\s*(?!['"`][^'"`$]*['"`]\s*\))|\brequire\(\s*(?!['"`][^'"`$]*['"`]\s*\))|import\.meta\.glob|\bcreateRequire\b/;
const EXTS = ['', '.mjs', '.js', '.ts', '.tsx', '.cjs', '.json'];
const PATH_LITERAL = /['"`]((?:\.{1,2}\/|[A-Za-z0-9_@-][\w@./-]*\/)[\w@./-]*[\w-])['"`]/g;

/** Plane directories named by `coverage.include` entries shaped `<dir>/**\/*.ts`. */
export function planeDirsFromInclude(include) {
  return [...new Set(include.map((g) => /^([^/*]+)\/\*\*\//.exec(g)?.[1]).filter(Boolean))];
}

export function makeIsCovered(planeDirs, tierFiles = TRUST_CHAIN_TIER_FILES) {
  const tier = new Set(tierFiles);
  return (rel) => tier.has(rel) || planeDirs.some((d) => rel.startsWith(`${d}/`));
}

function resolveFile(base) {
  for (const ext of EXTS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  for (const ext of EXTS.slice(1)) {
    const p = join(base, `index${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

const toRel = (repoRoot, abs) => relative(repoRoot, abs).split(sep).join('/');

/**
 * Does `testFile` (repo-relative) reach a covered file ? `cache` memoises per-module
 * edges so the whole suite is scanned once. Returns { reaches, via } with a short reason for the report.
 */
export function createReach({ repoRoot = REPO_ROOT, isCovered }) {
  const edges = new Map(); // rel -> { deps: string[], opaque: boolean }

  function scan(rel) {
    if (edges.has(rel)) return edges.get(rel);
    const info = { deps: [], opaque: false };
    edges.set(rel, info);
    if (!/\.(m?js|cjs|tsx?)$/.test(rel)) return info;
    let text;
    try { text = readFileSync(join(repoRoot, rel), 'utf8'); } catch { return info; }
    info.opaque = OPAQUE_LOAD.test(text);
    const dir = dirname(join(repoRoot, rel));
    const seen = new Set();
    for (const m of text.matchAll(PATH_LITERAL)) {
      const lit = m[1];
      if (lit.startsWith('@')) continue; // package / alias specifier, not a WE file
      const abs = lit.startsWith('.') ? resolveFile(resolve(dir, lit)) : resolveFile(resolve(repoRoot, lit));
      if (!abs) continue;
      const dep = toRel(repoRoot, abs);
      if (dep.startsWith('..') || dep.startsWith('node_modules/') || dep === rel || seen.has(dep)) continue;
      seen.add(dep);
      info.deps.push(dep);
    }
    return info;
  }

  return function reach(testRel) {
    const seen = new Set([testRel]);
    const queue = [testRel];
    while (queue.length) {
      const cur = queue.shift();
      if (cur !== testRel && isCovered(cur)) return { reaches: true, via: cur };
      const info = scan(cur);
      if (info.opaque) return { reaches: true, via: `${cur} (runtime-computed load)` };
      for (const d of info.deps) if (!seen.has(d)) { seen.add(d); queue.push(d); }
    }
    return { reaches: isCovered(testRel), via: isCovered(testRel) ? testRel : null };
  };
}

/** Split repo-relative unit test files into { covered, nocov } using vitest.config.ts's coverage.include. */
export async function classifyTests(files, { repoRoot = REPO_ROOT, include } = {}) {
  let inc = include;
  if (!inc) {
    const { createVitest } = await import('vitest/node');
    const ctx = await createVitest('test', { watch: false, run: true, root: repoRoot, config: join(repoRoot, 'vitest.config.ts') });
    try { inc = ctx.config.coverage.include; } finally { await ctx.close(); }
  }
  const reach = createReach({ repoRoot, isCovered: makeIsCovered(planeDirsFromInclude(inc)) });
  const covered = [];
  const nocov = [];
  for (const f of files) (reach(f).reaches ? covered : nocov).push(f);
  return { covered, nocov };
}

/**
 * @file scripts/lib/related-test-selection.mjs
 * @description #5128 — keep the local verify gate's related-test selection small when a diff touches a HUB module.
 *
 * WHY. The default local gate ran `vitest related <changed files>`, and vitest walks the reverse-import graph to any
 * depth. One changed hub (`reconcile-core.mjs`, `review-referral-hold.mjs`, `health-responder-state.mjs`) reached
 * 89-254 test files although only 3-33 tests import it directly. Measured 2026-10-06: a 2-file diff ran 840 s of
 * vitest on a loaded host.
 *
 * THE RULE. Build a reverse-import graph from the working tree (static `import`/`export … from`/`import()`/
 * `require()` with a relative string specifier). Count every test the changed files reach, at any depth.
 *   - At or under `maxTests`: nothing changes. The gate keeps `vitest related` and vitest's own exact graph.
 *   - Over `maxTests`: run an explicit list instead. It always holds the changed test files (which, under
 *     relatedMode 'all', include the tests that name a changed file) and every test within `maxDepth` import hops. If that is still over
 *     `maxTests`, the depth drops one hop at a time, but never below 1: a test that DIRECTLY imports a changed file
 *     always runs (a changed JSON/other tracked file counts as a target too), and every changed source file keeps at
 *     least its nearest ring of tests. The run is marked `selection-truncated` with the full and selected counts and the hub files.
 * Helper files under a `__tests__/` directory that are not tests themselves add no depth (a shared test helper is
 * part of the test, not a separate hop).
 *
 * SAFETY. This only shapes the LOCAL, pre-CI gate. CI's required `test` job still runs the full suite on every PR,
 * so a dropped far-away test can cost a CI round-trip, never a merged regression. `maxTests: 0` turns it off. Pure:
 * the caller injects the file list and a reader.
 */

// `from '<spec>'` is matched on its own, not anchored to its `import {`: a multi-line import list can hold a comment
// with a quote or `;` in it. A stray match in a comment or string only ADDS an edge (more tests), never drops one.
const SPECIFIER_RE = /\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)|\bimport\s+['"]([^'"\n]+)['"]|\b(?:require|mock|doMock|unmock|doUnmock|importActual|importMock)\s*\(\s*['"]([^'"\n]+)['"]/g;
const SOURCE_EXT_RE = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/;
const RESOLVE_SUFFIXES = ['', '.mjs', '.js', '.ts', '.tsx', '.cjs', '.mts', '.jsx', '/index.mjs', '/index.js', '/index.ts', '/index.tsx', '/index.cjs', '/index.mts', '/index.jsx'];

/** Is this path a vitest test file (`*.test.<js-ish>`)? */
export function isVitestTestFile(path) {
  return /\.test\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/.test(String(path));
}

/** Is this path a source file the graph should read? */
export function isGraphSourceFile(path) {
  const p = String(path);
  return SOURCE_EXT_RE.test(p) && !p.startsWith('node_modules/') && !p.includes('/node_modules/');
}

/** A shared test helper (under `__tests__/`, not itself a test): reaching it costs no depth. */
function isTestHelper(path) {
  return /(?:^|\/)__tests__\//.test(path) && !isVitestTestFile(path);
}

function normalizeJoin(fromFile, spec) {
  const parts = fromFile.split('/');
  parts.pop();
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/');
}

/** Resolve a relative specifier against the known file set, or null (bare/aliased/unknown specifiers). */
export function resolveSpecifier(fromFile, spec, fileSet) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const base = normalizeJoin(fromFile, spec.split('?')[0]);
  if (base == null) return null;
  for (const suffix of RESOLVE_SUFFIXES) if (fileSet.has(base + suffix)) return base + suffix;
  // TypeScript's `./x.js` import of `x.ts`/`x.tsx`, and `./x.mjs` / `./x.cjs` of `x.mts` / `x.cts`.
  const swap = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }[/\.(?:js|mjs|cjs)$/.exec(base)?.[0]];
  if (swap) { const stem = base.replace(/\.(?:js|mjs|cjs)$/, ''); for (const ext of swap) if (fileSet.has(stem + ext)) return stem + ext; }
  return null;
}

/**
 * The FORWARD edges of one file: the tracked files `text` (the content of `fromFile`) imports, resolved against
 * `fileSet`. The same parse the reverse graph uses, so both directions agree (the drain's `affected` re-test rule,
 * we:scripts/lib/merge-queue-affected.mjs, reads it). Pure.
 * @returns {string[]}
 */
export function resolvedImportsOf(fromFile, text, fileSet) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(SPECIFIER_RE)) {
    const target = resolveSpecifier(fromFile, m[1] ?? m[2] ?? m[3] ?? m[4], fileSet);
    if (target && target !== fromFile) out.add(target);
  }
  return [...out];
}

/**
 * The reverse-import graph: `Map<imported file, Set<importing file>>`. Unreadable files (a tracked file deleted in the
 * working tree, whose imports are gone with it) are skipped. Only source files are READ for imports, but any tracked
 * file can be an import TARGET, so a test that imports a changed JSON fixture still has its edge.
 * @param {{files: string[], readFile: (path: string) => string}} args
 */
export function buildReverseImportGraph({ files, readFile }) {
  const sources = files.filter(isGraphSourceFile);
  const fileSet = new Set(files.filter((f) => !f.startsWith('node_modules/') && !f.includes('/node_modules/')));
  const reverse = new Map();
  for (const file of sources) {
    let text;
    try { text = String(readFile(file)); } catch { continue; }
    for (const target of resolvedImportsOf(file, text, fileSet)) {
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target).add(file);
    }
  }
  return reverse;
}

/** Test files reachable from `starts`, each with its smallest import-hop depth (0-1 BFS; helpers cost 0). */
export function testDepths(starts, reverse) {
  const depth = new Map();
  const deque = [];
  for (const s of starts) { depth.set(s, 0); deque.push(s); }
  while (deque.length) {
    const file = deque.shift();
    const d = depth.get(file);
    for (const importer of reverse.get(file) ?? []) {
      const nd = isTestHelper(importer) ? d : d + 1;
      if (depth.has(importer) && depth.get(importer) <= nd) continue;
      depth.set(importer, nd);
      if (nd === d) deque.unshift(importer); else deque.push(importer);
    }
  }
  return new Map([...depth].filter(([f]) => isVitestTestFile(f)));
}

/**
 * Decide whether to keep `vitest related` or run a bounded explicit test list.
 * @param {{changedFiles: string[], reverse: Map<string, Set<string>>, maxTests: number, maxDepth: number}} args
 * @returns {{status: 'complete'|'selection-truncated', fullTestCount: number, selectedTestCount: number,
 *   depth: number|null, maxDepth: number, maxTests: number, tests: string[]|null, droppedCount: number,
 *   directTestCount: number, hubs: {file: string, direct: number, transitive: number}[], reason: string}}
 */
export function selectRelatedTests({ changedFiles, reverse, maxTests, maxDepth }) {
  const changed = [...new Set(changedFiles)];
  const depths = testDepths(changed, reverse);
  const fullCount = new Set([...depths.keys()]).size;
  const hubs = changed.filter((f) => !isVitestTestFile(f)).map((file) => {
    const reach = testDepths([file], reverse);
    return { file, direct: [...reach.values()].filter((d) => d <= 1).length, transitive: reach.size };
  }).filter((h) => h.transitive > 0).sort((a, b) => b.transitive - a.transitive).slice(0, 5);
  const base = { fullTestCount: fullCount, maxDepth, maxTests, hubs };
  if (!(maxTests > 0) || fullCount <= maxTests) {
    return { ...base, status: 'complete', selectedTestCount: fullCount, depth: null, tests: null, droppedCount: 0,
      directTestCount: [...depths.values()].filter((d) => d <= 1).length,
      reason: maxTests > 0 ? `${fullCount} related test(s) ≤ limit ${maxTests} — vitest related, full import depth` : 'limit off — vitest related, full import depth' };
  }
  // Changed test files always run; under relatedMode 'all' the caller's targets already include the tests that
  // name a changed file (literal references), so they are kept here too.
  const always = new Set(changed.filter(isVitestTestFile));
  let depth = Math.max(1, maxDepth);
  let selected;
  for (;;) {
    selected = new Set(always);
    for (const [test, d] of depths) if (d <= depth) selected.add(test);
    if (selected.size <= maxTests || depth === 1) break;
    depth -= 1;
  }
  // Never an empty list (an unfiltered `vitest run` is the whole suite), and every changed source file keeps at least
  // one test that reaches it: a changed file with no selected test in its reach (it has no test within the kept depth,
  // or its only reach was dropped while an unrelated changed test filled the list) gets its nearest ring instead.
  for (const file of changed.filter((f) => !isVitestTestFile(f))) {
    const reach = testDepths([file], reverse);
    if (!reach.size || [...reach.keys()].some((t) => selected.has(t))) continue;
    const ring = Math.min(...reach.values());
    for (const [test, d] of reach) if (d <= ring) selected.add(test);
    depth = Math.max(depth, ring);
  }
  if (selected.size === 0) {
    depth = Math.min(...depths.values());
    for (const [test, d] of depths) if (d <= depth) selected.add(test);
  }
  const tests = [...selected].sort();
  const droppedCount = [...depths.keys()].filter((t) => !selected.has(t)).length;
  return { ...base, status: 'selection-truncated', selectedTestCount: tests.length, depth, tests, droppedCount,
    directTestCount: [...depths.values()].filter((d) => d <= 1).length,
    reason: `${fullCount} related test(s) > limit ${maxTests} — ran ${tests.length} within ${depth} import hop(s); ${droppedCount} farther test(s) left to CI` };
}

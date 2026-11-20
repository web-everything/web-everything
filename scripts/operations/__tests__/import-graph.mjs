/**
 * @file scripts/operations/__tests__/import-graph.mjs
 * @description THE STATIC IMPORT-GRAPH SCANNER the operations suite asserts capability claims with (#3032/#3036).
 *
 * NOT A TEST FILE — vitest collects `*.test.mjs` only (`vitest.config.ts#test.include`), so this sits beside the
 * suites that share it, the same way `we:scripts/lib/__tests__/doc-prose.mjs` does.
 *
 * WHY A STATIC GRAPH RATHER THAN A BEHAVIOURAL TEST. A behavioural test shows a module did not act on THIS
 * input; the graph shows it has no way to act on any. `__tests__/engine.test.mjs` uses it for the engine's
 * *"reaches nothing that can act"*, and `__tests__/http-adapter.test.mjs` uses it for the narrower read-only
 * property (see that file — the guarantee is deliberately smaller than it sounds).
 *
 * WHAT IT IS NOT. It reads source text; it does not run a resolver. Three known blind spots, stated because a
 * capability claim built on it must not be read as wider than the scanner:
 *
 *   1. **A specifier that is not a literal** — `import(someVariable)` — is invisible. So is `createRequire()`,
 *      `process.binding`, `eval`, and anything reached through a global (`fetch`, `globalThis.process`), none
 *      of which is an import at all.
 *   2. **Injected values.** A module that imports nothing can still be HANDED a writer at call time. The graph
 *      says what a module can reach through its own scope, never what a caller puts into it.
 *   3. **Package specifiers are not followed** — they are reported as `external` and judged by name.
 *
 * Uses the repository's TypeScript parser without executing source. Comments, strings and regex literals
 * cannot introduce fake edges or hide real ones by desynchronising quote tracking. Parse errors refuse the
 * graph rather than allowing a capability assertion over an incomplete parse.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

function importSpecifiers(file) {
  const source = readFileSync(file, 'utf8');
  // Imported JSON is inert data, but must still be present and valid. Never scan
  // strings inside it as source or silently skip an unreadable dependency.
  if (file.endsWith('.json')) {
    JSON.parse(source);
    return [];
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) {
    const diagnostic = tree.parseDiagnostics[0];
    throw new SyntaxError(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
  }
  const specifiers = [];
  const visit = (node) => {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
      ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteralLike(specifier)) specifiers.push(specifier.text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return specifiers;
}

/**
 * Every module reachable from `entry` by static or dynamic import, plus every non-relative specifier the walk
 * met. Relative specifiers are followed; package and `node:` specifiers are collected and not followed.
 *
 * @param {string} entry - an absolute path to the entry module.
 * @returns {{files: string[], external: string[]}} both sorted.
 */
export function importGraph(entry) {
  const files = new Set();
  const external = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of importSpecifiers(file)) {
      if (!spec) continue;
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec));
      else external.add(spec);
    }
  }
  return { files: [...files].sort(), external: [...external].sort() };
}

/** The file names in a graph, for a legible assertion that does not hard-code an absolute path. */
export function graphBasenames(entry) {
  return importGraph(entry).files.map((f) => f.split('/').pop()).sort();
}

/**
 * The deps-install job runs from a code snapshot with no installed packages, so a top-level package import anywhere
 * in its static import chain kills it at start (markdown-it via the supersede rule blocked the drain, PR 7380).
 * Judged (TypeScript AST, so comments, strings, layout and multiline calls cannot hide a load): static imports and
 * re-exports, plus import()/require() calls that run at startup. Calls inside function bodies run later and are
 * allowed, except immediately invoked ones. Computed method/accessor names are evaluated at startup.
 * Known waived gaps (dlv:DEPS-SOAK-HARDEN): calls through named functions, aliased createRequire, and eval.
 * This is a syntax-based regression guard, not a complete JavaScript execution model.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const ENTRY = 'scripts/lib/daemon-rebuild/deps-job.mjs';
const FIX_SHA = '186ce82511';

const DYNAMIC = '<non-literal specifier>';
// A specifier is acceptable only when it is relative or a real built-in (`node:` names are validated too).
const isOk = name => name.startsWith('.') || isBuiltin(name);

function startupSpecifiers(source) {
  const specs = [];
  // `createRequire(...)` itself loads nothing; names bound to its result (and its direct call) act like `require`.
  const requireNames = new Set(['require']);
  const isCreateRequire = n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'createRequire';
  const collect = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isCreateRequire(node.initializer)) requireNames.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specs.push(ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : DYNAMIC);
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const iife = ts.isParenthesizedExpression(callee) || ts.isFunctionExpression(callee) || ts.isArrowFunction(callee);
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && requireNames.has(callee.text)) || isCreateRequire(callee)) {
        const arg = node.arguments[0];
        specs.push(arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : DYNAMIC);
      }
      if (iife) {
        let fn = callee;
        while (ts.isParenthesizedExpression(fn)) fn = fn.expression;
        if (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) {
          // Defaults (including destructuring defaults) can load modules when the IIFE is called.
          fn.parameters.forEach(visit);
          // Visit the body itself: a concise arrow can be a load or another, still-lazy function.
          visit(fn.body);
        }
      }
    }
    // A method/accessor's computed name runs when its class or object is evaluated.
    // Its uncalled body and defaults stay lazy; IIFEs are handled above.
    if (ts.isFunctionLike(node) && !ts.isSourceFile(node)) {
      if (node.name && ts.isComputedPropertyName(node.name)) visit(node.name.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specs;
}

// Walk the startup import closure from `entry`; list each chain that ends at a non-built-in, non-relative load.
export function packageChains(entry, read) {
  const seen = new Set();
  const found = [];
  const walk = (path, chain) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const name of startupSpecifiers(source)) {
      if (name.startsWith('.')) walk(posix.normalize(posix.join(posix.dirname(path), name)), [...chain, path]);
      else if (!isOk(name)) found.push([...chain, path, name].join(' -> '));
    }
  };
  walk(entry, []);
  return found;
}

export function probe(checkout) {
  return { violations: packageChains(ENTRY, path => readFileSync(join(checkout, path), 'utf8')) };
}

// Fix presence is decided by git ancestry of the fixing commit, never by the import walk the break judges.
function fixPresent(checkout) {
  return spawnSync('git', ['merge-base', '--is-ancestor', FIX_SHA, 'HEAD'], { cwd: checkout, maxBuffer: 1024 * 1024 }).status === 0;
}

export default {
  id: 'deps-job-builtins-only-import-chain',
  title: 'deps job startup import chain uses only node built-ins (uncalled function bodies stay lazy)',
  card: 'PR #7380 deps-install bootstrap',
  fixedBy: { sha: FIX_SHA, where: 'lane/deps-install-bootstrap', paths: [ENTRY] },
  fixPresent,
  run: () => probe(root),
  judge: report => report.violations,
};

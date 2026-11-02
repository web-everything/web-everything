import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

// Independently audit ESM edges even when unwalked CommonJS makes the runtime
// closure incomplete. A computed or missing ESM edge could hide a forbidden CLI.
export function esmBoundaryViolations({ root, files, readFile = path => readFileSync(path, 'utf8') }) {
  const violations = [];
  for (const file of files) {
    const tree = ts.createSourceFile(file, readFile(join(root, file)), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const add = (node, reason) => violations.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, reason });
    if (tree.parseDiagnostics.length) {
      violations.push({ file, reason: 'unparseable source' });
      continue;
    }
    const visit = node => {
      let spec;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) spec = node.arguments[0] ?? node;
      if (spec) {
        if (!ts.isStringLiteralLike(spec)) add(node, 'computed ESM import');
        else if (spec.text.startsWith('./') || spec.text.startsWith('../')) {
          const base = posix.normalize(posix.join(posix.dirname(file), spec.text));
          if (![base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}/index.mjs`, `${base}/index.js`]
            .some(path => files.has(path))) add(node, 'ESM dependency absent from graph');
        } else if (spec.text.startsWith('file:') || spec.text.startsWith('/')) add(node, 'non-relative local ESM import');
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return violations;
}

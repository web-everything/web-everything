import ts from 'typescript';
import { findAgentLaunches as scanAgentLaunches } from '../../lib/agent-launch-structure.mjs';

// Explicit bindings for the audit table’s shorthand source snippets.

const fixturePrimitives = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork',
  'run', 'runFn', 'spawnFn'];
export function findAgentLaunches(sources) {
  return scanAgentLaunches(Object.fromEntries(Object.entries(sources).map(([name, text]) => {
    const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declared = new Set();
    const names = node => {
      if (!node) return;
      if (ts.isIdentifier(node)) declared.add(node.text);
      else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
        for (const element of node.elements) names(element.name);
      }
    };
    for (const node of file.statements) {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) names(node.name);
      if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) names(d.name);
      if (ts.isImportDeclaration(node)) {
        names(node.importClause?.name);
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names(bindings.name);
        if (bindings && ts.isNamedImports(bindings)) for (const s of bindings.elements) names(s.name);
      }
    }
    const implicit = fixturePrimitives.filter(n => !declared.has(n));
    const imports = implicit.length ? `import {${implicit.map(n => /^(?:run|runFn|spawnFn)$/.test(n) ? `spawn as ${n}` : n).join(',')}} from 'node:child_process';\n` : '';
    const namespaces = ['cp', 'child_process', 'childProcess'].filter(n => !declared.has(n))
      .map(n => `import * as ${n} from 'node:child_process';\n`).join('');
    return [name, imports + namespaces + text];
  })));
}

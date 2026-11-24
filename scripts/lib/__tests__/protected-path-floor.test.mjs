import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { matchesSome } from '../audit-path.mjs';
import * as shared from '../protected-path-floor.mjs';
import * as audit from '../audit-settings.mjs';

// Runtime consumers may load this vocabulary while the settings engine remains inert.
// Accept only constants composed from literals, earlier constants, arrays, Set and Object.freeze.
function dataOnly(source) {
  const ast = ts.createSourceFile('floor.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) return false;
  const known = new Set();
  const value = node => {
    if (!node) return false;
    if (ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
    if (ts.isIdentifier(node)) return known.has(node.text);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(item => value(ts.isSpreadElement(item) ? item.expression : item));
    if (ts.isCallExpression(node)) return ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(ast) === 'Object' && node.expression.name.text === 'freeze'
      && node.arguments.length === 1 && value(node.arguments[0]);
    if (ts.isNewExpression(node)) return ts.isIdentifier(node.expression) && node.expression.text === 'Set'
      && node.arguments?.length === 1 && value(node.arguments[0]);
    return false;
  };
  return ast.statements.every(statement => ts.isVariableStatement(statement)
    && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    && statement.declarationList.declarations.every(declaration => {
      if (!ts.isIdentifier(declaration.name) || !value(declaration.initializer)) return false;
      known.add(declaration.name.text);
      return true;
    }));
}

describe('shared protected-path floor', () => {
  it('contains only data declarations, with no imports, settings resolution or runtime IO', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../protected-path-floor.mjs'), 'utf8');
    expect(dataOnly(source)).toBe(true);
  });
  it('the data-only rule accepts literal composition', () => {
    expect(dataOnly("export const A = Object.freeze(['path']); const B = Object.freeze([...new Set([...A, 'other'])]);")).toBe(true);
  });
  it.each([
    "import './audit-settings.mjs';", "export { GUARD_FLOOR } from './audit-settings.mjs';",
    "const A = import(\n './audit-settings.mjs',\n);", "const A = require('./audit-settings.mjs');",
    "const A = readFileSync('settings.json');", "const A = Object.freeze([load()]);",
    "const A = Object.freeze([...load()]);", "const A = new Set(load());",
    "const Object = attacker; const A = Object.freeze(['path']);", "const A = (() => load())();",
    "let A = ['path'];", "const A = Object.assign({}, load());",
  ])('refuses runtime code in the shared vocabulary: %s', source => {
    expect(dataOnly(source)).toBe(false);
  });
  it('keeps the existing audit exports identical and protects the shared module itself', () => {
    for (const [name, value] of Object.entries(shared)) expect(audit[name], name).toBe(value);
    expect(Object.isFrozen(shared.GUARD_FLOOR)).toBe(true);
    expect(shared.GUARD_FLOOR).toContain('scripts/lib/protected-path-floor.mjs');
  });
});

it.each(['scripts/lib/authorized-push.mjs', 'scripts/lib/review-hold-model.mjs',
  'scripts/lib/poc-branches.mjs', 'scripts/lib/prototype-tracker-data.mjs',
  'scripts/lib/local-date.mjs', 'scripts/lib/constellation-repos.mjs',
  'scripts/guard-git-push.mjs', 'scripts/lib/lane-lease.mjs',
  'scripts/guard-prototype-tracker.mjs', 'scripts/conveyor/fix-procedure.mjs'])(
  'classifies %s as protected even without configured guard paths', path => {
    expect(matchesSome(path, shared.GUARD_FLOOR)).toBe(true);
  });

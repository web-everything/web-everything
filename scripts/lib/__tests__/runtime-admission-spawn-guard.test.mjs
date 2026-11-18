/** @repo-scanning-test scope=files */
import { it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { scanRoot, scopedScanFiles } from '../repo-scan-tests.mjs';

const root = scanRoot(process.cwd());
const launches = /^(?:spawnDetached|defaultSpawnDetached|startDetachedLaunch|spawnResume|spawnLand|spawnPreventionLandingJob|dispatchCiHeal|provider|effects\.(?:dispatch|routeHeldItems)|io\.dispatch)$/;
const isAssert = n => ts.isCallExpression(n) && n.expression.getText() === 'assertRuntimeAdmitted';
const contains = (n, predicate) => predicate(n) || !!ts.forEachChild(n, c => contains(c, predicate) || undefined);
const exits = n => ts.isReturnStatement(n) || ts.isThrowStatement(n) || ts.isContinueStatement(n)
  || (ts.isBlock(n) && n.statements.length > 0 && exits(n.statements[n.statements.length - 1]));

// Follow enclosing blocks, never sibling branches/functions. A preceding refusal must exit.
function guarded(call) {
  let node = call;
  while (node.parent) {
    const parent = node.parent;
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const before = [...parent.statements].filter(s => s.end <= node.pos);
      for (const statement of before) {
        if (!ts.isIfStatement(statement) || !exits(statement.thenStatement)) continue;
        const expression = statement.expression;
        if (!ts.isPrefixUnaryExpression(expression) || expression.operator !== ts.SyntaxKind.ExclamationToken) continue;
        const check = expression.operand;
        if (!ts.isPropertyAccessExpression(check) || check.name.text !== 'admitted') continue;
        if (isAssert(check.expression)) return true;
        if (ts.isIdentifier(check.expression) && before.some(s => ts.isVariableStatement(s)
          && s.declarationList.declarations.some(d => d.name.getText() === check.expression.text && d.initializer && isAssert(d.initializer)))) return true;
      }
    }
    // A batch effect may take a list filtered by the gate right in its argument.
    if (node === call && call.expression.getText() === 'effects.routeHeldItems'
      && call.arguments.some(arg => contains(arg, isAssert))) return true;
    if (ts.isFunctionLike(parent)) break;
    node = parent;
  }
  return false;
}
function scan(source, { delegatedExecHelpers = [] } = {}) {
  const ast = ts.createSourceFile('spawn.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sites = [], bypasses = [];
  function visit(node) {
    let owner = node.parent;
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
    const delegatedExec = delegatedExecHelpers.includes(owner?.name?.getText());
    if (ts.isCallExpression(node) && (launches.test(node.expression.getText()) || /io\.dispatch\s*\?\?\s*dispatchCiHeal/.test(node.expression.getText()) || (!delegatedExec && node.expression.getText() === 'exec' && node.arguments[1]?.getText() === 'argv'))) {
      const site = { call: node.expression.getText(), line: ast.getLineAndCharacterOfPosition(node.getStart()).line + 1 };
      sites.push(site);
      if (!guarded(node)) bypasses.push(site);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { sites, bypasses };
}
it('inventories every conveyor launch and requires an exiting runtime refusal before the effect', () => {
  const files = ['skills-src/conveyor/build-dispatch-daemon.mjs', 'scripts/conveyor/tick-core.mjs',
    'scripts/operations/dispatch-lane-io.mjs', ...readdirSync(`${root}/scripts/conveyor`)
      .filter(f => /^build-dispatch-.*\.mjs$/.test(f)).map(f => `scripts/conveyor/${f}`)];
  let count = 0;
  for (const file of scopedScanFiles(files)) {
    // dispatch-lane IO admits at `provider(payload)`, before choosing a mechanical or agent
    // implementation. Its raw exec helpers also serve read-only planner calls and trust retries;
    // they are implementations of that port, not additional conveyor admission boundaries.
    const result = scan(readFileSync(`${root}/${file}`, 'utf8'), {
      delegatedExecHelpers: file === 'scripts/operations/dispatch-lane-io.mjs'
        ? ['defaultRunNode', 'defaultSpawnAgent'] : [],
    });
    count += result.sites.length;
    expect(result.bypasses, file).toEqual([]);
  }
  if (!process.env.VERIFY_SCAN_FILES) expect(count).toBeGreaterThan(10);
});
it('inventories the provider boundary rather than its generic exec helpers', () => {
  const source = `function defaultRunNode(argv) { return exec(process.execPath, argv); }
    function run(payload) { return provider(payload); }`;
  const options = { delegatedExecHelpers: ['defaultRunNode', 'defaultSpawnAgent'] };
  expect(scan(source, options).bypasses).toEqual([{ call: 'provider', line: 2 }]);
  expect(scan(`function run(card, argv) { return exec(process.execPath, argv); }`, options).bypasses).toHaveLength(1);
  expect(scan(`function run(card, argv) { return exec(process.execPath, argv); }`).bypasses).toHaveLength(1);
});
it('detects a bypass despite a gate in a sibling branch or comment', () => {
  expect(scan(`function run(card) {
    // assertRuntimeAdmitted(card, 'build');
    if (false) { if (!assertRuntimeAdmitted(card, 'build').admitted) return; }
    effects.dispatch(card);
  }`).bypasses).toHaveLength(1);
  expect(scan(`function run(card) {
    if (!assertRuntimeAdmitted(card, 'build').admitted) return;
    effects.dispatch(card);
  }`).bypasses).toEqual([]);
});

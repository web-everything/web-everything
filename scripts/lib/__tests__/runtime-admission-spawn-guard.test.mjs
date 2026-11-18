/** @repo-scanning-test scope=files */
import { it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
// Group forwarding needs a member predicate, independently of the lead's admission.
function groupsGuarded(call) {
  const groups = [];
  const priorStatements = [];
  let cursor = call;
  while (cursor.parent && !ts.isFunctionLike(cursor.parent)) {
    if (ts.isBlock(cursor.parent) || ts.isSourceFile(cursor.parent)) priorStatements.push(...[...cursor.parent.statements].filter(s => s.end <= cursor.pos));
    cursor = cursor.parent;
  }
  const initializerFor = name => priorStatements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
    .find(d => d.name.getText() === name)?.initializer;
  for (const arg of call.arguments) contains((ts.isIdentifier(arg) && initializerFor(arg.text)) || arg, node => {
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText() === 'groupMembers') {
      groups.push(ts.isPropertyAssignment(node) ? node.initializer : node.name);
    }
    return false;
  });
  // A detached process can receive the group through an argv variable instead of an object.
  for (const arg of call.arguments) {
    const value = ts.isIdentifier(arg) ? initializerFor(arg.text) : arg;
    if (value && ts.isArrayLiteralExpression(value)) contains(value, node => {
      if (ts.isIdentifier(node) && node.text === 'groupMembers') groups.push(node);
      return false;
    });
  }
  const memberCheck = (callback, refused = false) => {
    const name = callback.parameters?.[0]?.name.getText();
    if (!name || !callback.body) return false;
    const statements = ts.isBlock(callback.body) ? [...callback.body.statements] : [];
    let result = statements.length ? statements.at(-1)?.expression : callback.body;
    if (statements.length && !ts.isReturnStatement(statements.at(-1))) return false;
    if (refused) {
      if (!result || !ts.isPrefixUnaryExpression(result) || result.operator !== ts.SyntaxKind.ExclamationToken) return false;
      result = result.operand;
    }
    if (!result || !ts.isPropertyAccessExpression(result) || result.name.text !== 'admitted') return false;
    let check = result.expression;
    if (ts.isIdentifier(check)) check = statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
      .find(d => d.name.getText() === check.getText())?.initializer;
    return check && isAssert(check) && ts.isObjectLiteralExpression(check.arguments[0])
      && check.arguments[0].properties.some(p => (ts.isPropertyAssignment(p) && p.name.getText() === 'num' && p.initializer.getText() === name)
        || (ts.isShorthandPropertyAssignment(p) && p.name.text === 'num' && name === 'num'));
  };
  return groups.every(group => {
    const forwarded = ts.isArrayLiteralExpression(group) && group.elements.length === 1 && ts.isSpreadElement(group.elements[0])
      ? group.elements[0].expression : group;
    let node = call;
    while (node.parent && !ts.isFunctionLike(node.parent)) {
      const parent = node.parent;
      if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
        for (const statement of parent.statements) {
          if (statement.end > node.pos) continue;
          const condition = ts.isIfStatement(statement) ? statement.expression : null;
          if (condition && exits(statement.thenStatement) && ts.isPrefixUnaryExpression(condition)
            && condition.operator === ts.SyntaxKind.ExclamationToken && ts.isIdentifier(condition.operand)) {
            const every = initializerFor(condition.operand.text);
            const map = every && ts.isCallExpression(every) && ts.isPropertyAccessExpression(every.expression)
              && every.expression.name.text === 'every' && every.arguments.length === 1
              && every.arguments[0].getText() === 'Boolean' ? every.expression.expression : null;
            if (map && ts.isCallExpression(map) && ts.isPropertyAccessExpression(map.expression)
              && map.expression.name.text === 'map' && map.arguments.some(callback => memberCheck(callback))) {
              const source = map.expression.expression;
              const resolved = ts.isIdentifier(source) ? initializerFor(source.text) : source;
              if (source.getText() === forwarded.getText() || resolved?.getText() === forwarded.getText()
                || (resolved && ts.isBinaryExpression(resolved) && resolved.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
                  && resolved.left.getText() === forwarded.getText())) return true;
            }
          }
          if (condition && exits(statement.thenStatement) && ts.isCallExpression(condition)
            && ts.isPropertyAccessExpression(condition.expression) && condition.expression.name.text === 'some'
            && condition.expression.expression.getText() === forwarded.getText()
            && condition.arguments.some(callback => memberCheck(callback, true))) return true;
        }
      }
      node = parent;
    }
    return false;
  });
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
      if (!guarded(node) || !groupsGuarded(node)) bypasses.push(site);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { sites, bypasses };
}
it('inventories every conveyor launch and requires an exiting runtime refusal before the effect', () => {
  const files = ['skills-src/conveyor/build-dispatch-daemon.mjs', 'scripts/conveyor/tick-core.mjs',
    'scripts/operations/dispatch-lane-io.mjs', ...readdirSync(join(root, 'scripts/conveyor'))
      .filter(f => /^build-dispatch-.*\.mjs$/.test(f)).map(f => `scripts/conveyor/${f}`)];
  let count = 0;
  for (const file of scopedScanFiles(files)) {
    // defaultRunNode only reads the tick planner (readTick -> tickCli); it never launches a worker.
    // defaultSpawnAgent's exec must be guarded independently, including its trust retry.
    const result = scan(readFileSync(`${root}/${file}`, 'utf8'), {
      delegatedExecHelpers: file === 'scripts/operations/dispatch-lane-io.mjs' ? ['defaultRunNode'] : [],
    });
    count += result.sites.length;
    expect(result.bypasses, file).toEqual([]);
  }
  if (!process.env.VERIFY_SCAN_FILES) expect(count).toBeGreaterThan(10);
});
it('exempts only the read-only planner helper and scans the agent exec helper', () => {
  const source = `function defaultRunNode(argv) { return exec(process.execPath, argv); }
    function run(payload) { return provider(payload); }`;
  const options = { delegatedExecHelpers: ['defaultRunNode'] };
  expect(scan(`function defaultSpawnAgent(argv) { return exec('claude', argv); }`, options).bypasses).toHaveLength(1);
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
it('rejects forwarding unchecked group members despite an admitted lead', () => {
  expect(scan(`function run(payload) {
    if (!assertRuntimeAdmitted(payload, 'build').admitted) return;
    const request = { num: payload.num, groupMembers: payload.groupMembers };
    provider(request);
  }`).bypasses).toHaveLength(1);
  expect(scan(`function run(payload) {
    if (!assertRuntimeAdmitted(payload, 'build').admitted) return;
    provider({ num: payload.num, groupMembers: payload.groupMembers });
  }`).bypasses).toHaveLength(1);
  expect(scan(`function run(payload) {
    if (!assertRuntimeAdmitted(payload, 'build').admitted) return;
    const groupMembers = payload.groupMembers.filter(member => assertRuntimeAdmitted({ num: member }, 'build').admitted);
    provider({ num: payload.num, groupMembers });
  }`).bypasses).toHaveLength(1);
  for (const predicate of ["member => { assertRuntimeAdmitted({ num: member }, 'build'); return true; }",
    "member => assertRuntimeAdmitted({ num: payload.num }, 'build').admitted"]) {
    expect(scan(`function run(payload) {
      if (!assertRuntimeAdmitted(payload, 'build').admitted) return;
      const groupMembers = payload.groupMembers.filter(${predicate});
      provider({ groupMembers });
    }`).bypasses).toHaveLength(1);
  }
});
it('rejects unchecked groups encoded in detached spawn argv', () => {
  const source = `function run(num, groupMembers) {
    if (!assertRuntimeAdmitted({ num }, 'resume').admitted) return null;
    const argv = ['worker.mjs', '--group-members=' + groupMembers.join(',')];
    return spawnDetached(argv);
  }`;
  expect(scan(source).bypasses).toHaveLength(1);
  expect(scan(source.replace("const argv =", "groupMembers = groupMembers.filter(member => assertRuntimeAdmitted({ num: member }, 'resume').admitted); const argv =")).bypasses).toHaveLength(1);
  expect(scan(source.replace("const argv =", "if (groupMembers.some(member => !assertRuntimeAdmitted({ num: member }, 'resume').admitted)) return null; const argv =")).bypasses).toEqual([]);
});

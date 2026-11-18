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
// Names include injected ports as well as native primitives. Resolve import/variable aliases
// to a fixed point, independently of argv shape (including inline literals).
const primitives = /^(?:execFileSync|execFile|exec|execSync|spawn|spawnSync|fork|execFileSyncThrottled|execFileThrottledAsync|execFileFn|execAsync|runNode|defaultRunNode|spawnAgent|defaultSpawnAgent|spawnAgentToCompletion|spawnToCompletion|spawnResumeDelivery|routeDispatchProvider|defaultClaudeProvider|launchWrappedClaudeWorker|launchWrapped|probationWorkerDetachedProvider|agent|run|defaultExecAsync|probation|launchAgent)$/;
function ownerName(node) {
  if (node.name) return node.name.getText();
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isBindingElement(parent)) return parent.name.getText();
  if (ts.isParameter(parent)) return parent.name.getText();
  let outer = parent;
  while (outer && !ts.isFunctionLike(outer)) outer = outer.parent;
  return outer ? `${ownerName(outer)}/callback` : '<module>/callback';
}
function scan(source) {
  const ast = ts.createSourceFile('spawn.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const aliases = new Set(), regexes = new Set();
  const collectRegexes = node => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isRegularExpressionLiteral(node.initializer)) regexes.add(node.name.getText());
    ts.forEachChild(node, collectRegexes);
  };
  collectRegexes(ast);
  const launchName = expression => {
    if (ts.isParenthesizedExpression(expression)) return launchName(expression.expression);
    if (ts.isBinaryExpression(expression)) return launchName(expression.left) || launchName(expression.right);
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
      && expression.expression.name.text === 'bind') return launchName(expression.expression.expression);
    const name = ts.isPropertyAccessExpression(expression) ? expression.name.text : expression.getText();
    // RegExp/string .exec is not a child-process port.
    return (name !== 'exec' || !ts.isPropertyAccessExpression(expression) || (!ts.isRegularExpressionLiteral(expression.expression) && !regexes.has(expression.expression.getText()))) && (primitives.test(name) || launches.test(name)
      || launches.test(expression.getText()) || aliases.has(name));
  };
  let changed;
  do {
    changed = false;
    const alias = (name, value) => { if (value && launchName(value) && !aliases.has(name)) { aliases.add(name); changed = true; } };
    const visit = node => {
      if (ts.isImportSpecifier(node)) alias(node.name.text, node.propertyName || node.name);
      if (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node)) {
        alias(node.name.getText(), node.initializer);
        if (ts.isBindingElement(node) && node.propertyName) alias(node.name.getText(), node.propertyName);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) alias(node.left.getText(), node.right);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  } while (changed);
  const sites = [], bypasses = [];
  function visit(node) {
    if (ts.isCallExpression(node) && launchName(node.expression)) {
      let owner = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      const site = { call: node.expression.getText(), line: ast.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        owner: owner ? ownerName(owner) : '<module>' };
      sites.push(site);
      if (!guarded(node) || !groupsGuarded(node)) bypasses.push(site);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { sites, bypasses };
}
// Reviewed exceptions are keyed by file + function, never by argv or line number.
const reviewedReads = new Map([
  ['skills-src/conveyor/build-dispatch-daemon.mjs#cliPlanTick', 'Reads the tick plan; never executes its proposed work.'],
  ['skills-src/conveyor/build-dispatch-daemon.mjs#defaultReadLanePool/callback', 'Reads acquirable lane status.'],
  ['skills-src/conveyor/build-dispatch-daemon.mjs#launchBase', 'Reads the current Git commit.'],
  ['skills-src/conveyor/build-dispatch-daemon.mjs#git', 'Reads card paths and their latest commit.'],
  ['skills-src/conveyor/build-dispatch-daemon.mjs#defaultExecAsync/callback', 'Runs throttled GitHub discovery reads for prepare status.'],
  ['skills-src/conveyor/build-dispatch-daemon.mjs#run', 'Refreshes the local main snapshot for prepare discovery.'],
  ['skills-src/conveyor/build-dispatch-daemon.mjs#readTree', 'Reads backlog tree objects.'],
  ['skills-src/conveyor/build-dispatch-daemon.mjs#loadBlobs', 'Reads backlog blobs through cat-file.'],
  ['skills-src/conveyor/build-dispatch-daemon.mjs#ghPrList', 'Lists prepare PRs.'],
  ['skills-src/conveyor/build-dispatch-daemon.mjs#worker/callback', 'Lists prepare PRs asynchronously.'],
  ['skills-src/conveyor/build-dispatch-daemon.mjs#read', 'Reads prepare stamp contents from GitHub.'],
  ['skills-src/conveyor/build-dispatch-daemon.mjs#fileCard', 'Files a diagnostic backlog card only; no delivery agent.'],
  ['scripts/conveyor/tick-core.mjs#runJson/callback', 'Reads state, plan and acquirable lanes.'],
  ['scripts/conveyor/tick-core.mjs#main/callback/callback', 'Prefetches acquirable lane status.'],
  ['scripts/conveyor/tick-core.mjs#main/callback', 'Reads PR comments and heavy admission status/load/queue.'],
  ['scripts/conveyor/build-dispatch-orphan-adopt.mjs#defaultCurrentLaneSession', 'Reads the current lane lease.'],
  ['scripts/conveyor/build-dispatch-orphan-adopt.mjs#releaseReservedLaneLease', 'Releases a failed launch reservation; starts no delivery.'],
  ['scripts/operations/dispatch-lane-io.mjs#runNode', 'Forwards only the read-only tick planner.'],
  ['scripts/operations/dispatch-lane-io.mjs#readTick', 'Reads the tick plan.'],
  ['scripts/operations/dispatch-lane-io.mjs#defaultRunNode', 'Executes only the read-only tick planner.'],
  ['scripts/operations/dispatch-lane-io.mjs#releaseReservedLane', 'Releases a failed launch reservation.'],
  ['scripts/operations/dispatch-lane-io.mjs#defaultListPrs', 'Lists PRs.'],
  ['scripts/operations/dispatch-lane-io.mjs#defaultCheckAlreadyDone', 'Reads Git origin and merged PR evidence.'],
  ['scripts/operations/dispatch-lane-io.mjs#execFileThrottledAsync', 'Throttled executor for GitHub evidence reads.'],
  ['scripts/operations/dispatch-lane-io.mjs#defaultCheckAlreadyDoneAsync', 'Reads Git origin and merged PR evidence asynchronously.'],
  ['scripts/operations/dispatch-lane-io.mjs#defaultLaneRefForPr', 'Reads a PR head ref.'],
  ['scripts/operations/dispatch-lane-io.mjs#fetch', 'Lists existing Claude agents; starts no agent.'],
]);
it('inventories every conveyor process site and rejects unguarded or stale exceptions', () => {
  const files = ['skills-src/conveyor/build-dispatch-daemon.mjs', 'scripts/conveyor/tick-core.mjs',
    ...readdirSync(join(root, 'scripts/operations')).filter(f => /^dispatch-lane.*\.mjs$/.test(f)).map(f => `scripts/operations/${f}`),
    ...readdirSync(join(root, 'scripts/conveyor')).filter(f => /^build-dispatch-.*\.mjs$/.test(f)).map(f => `scripts/conveyor/${f}`)];
  let count = 0;
  const found = new Set();
  for (const file of scopedScanFiles(files)) {
    const result = scan(readFileSync(`${root}/${file}`, 'utf8'));
    for (const site of result.sites) found.add(`${file}#${site.owner}`);
    count += result.sites.length;
    expect(result.bypasses.filter(site => !reviewedReads.has(`${file}#${site.owner}`)), file).toEqual([]);
  }
  const scoped = new Set(scopedScanFiles(files));
  for (const [key, reason] of reviewedReads) {
    if (scoped.has(key.split('#')[0])) expect(found.has(key), `stale exception: ${key}`).toBe(true);
    expect(reason.trim().length).toBeGreaterThan(0);
  }
  if (!process.env.VERIFY_SCAN_FILES) expect(count).toBeGreaterThan(10);
});
it('flags aliased primitives, inline exec arguments, and wrapper ports', () => {
  for (const source of [
    `import { spawn as start } from 'node:child_process'; const launch = start; function run() { launch('node', []); }`,
    `function recover() { exec('node', ['infra-blocked.mjs', 'retry']); }`,
    `function deliver() { runNode(argv); }`,
    `const start = childProcess.spawn.bind(childProcess); function deliver() { start(command, args); }`,
    ...['execFileSync', 'execFile', 'exec', 'execSync', 'spawn', 'spawnSync', 'fork'].map(name => `function deliver() { cp.${name}(command, args); }`),
  ]) expect(scan(source).bypasses).toHaveLength(1);
});
it.each(['spawnDetached', 'spawnAgent', 'runNode', 'defaultRunNode', 'spawnLand', 'spawnResume', 'provider', 'launchWrapped'])('flags the %s wrapper independently of argument shape', name => {
  expect(scan(`function deliver() { ${name}('inline'); }`).bypasses).toHaveLength(1);
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

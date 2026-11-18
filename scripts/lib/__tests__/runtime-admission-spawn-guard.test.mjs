/** @repo-scanning-test scope=files */
import { it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ADMISSION_SPAWN_SCAN, scanRoot, scopedScanFiles } from '../repo-scan-tests.mjs';

const root = scanRoot(process.cwd());
const launches = /^(?:spawnDetached|defaultSpawnDetached|startDetachedLaunch|spawnResume|spawnLand|spawnPreventionLandingJob|dispatchCiHeal|sinks\[DISPATCH_EFFECT\]|provider|effects\.(?:dispatch|routeHeldItems|stampPrepare)|io\.dispatch)$/;

// A prior check is insufficient: only the effect callback of the shared fresh-read
// boundary may launch. Stop at the nearest function so nested/deferred callbacks
// cannot borrow a surrounding admission.
function launchBoundary(call) {
  let callback = call.parent;
  while (callback && !ts.isFunctionLike(callback)) callback = callback.parent;
  const wrapper = callback?.parent;
  return wrapper && ts.isCallExpression(wrapper) && wrapper.expression.getText() === 'withRuntimeAdmission'
    && wrapper.arguments[2] === callback ? wrapper : null;
}
function guarded(call) { return !!launchBoundary(call); }
function groupsGuarded(call) {
  const wrapper = launchBoundary(call);
  if (!wrapper) return false;
  const identity = wrapper.arguments[0];
  // Explicit lead projections must also project the group. Whole-card identifiers
  // and spreads preserve the persisted roster (behavior tests cover producers).
  if (!ts.isObjectLiteralExpression(identity)) return true;
  if (identity.properties.some(p => ts.isSpreadAssignment(p) || p.name?.getText() === 'groupMembers')) return true;
  return false;
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
  ['scripts/operations/detached-dispatch.mjs#defaultSpawnDiagnosticDetached', 'Files diagnostic cards only; never delivery work.'],
  ['scripts/conveyor/infra-blocked.mjs#originSlugOf', 'Reads the origin URL.'],
  ['scripts/conveyor/infra-blocked.mjs#readResumeGit', 'Fetches and reads the already-published ref; never publishes or starts delivery.'],
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
  const files = RUNTIME_ADMISSION_SPAWN_SCAN.flatMap(entry => typeof entry === 'string' ? [entry]
    : readdirSync(join(root, entry.directory)).filter(f => entry.files.test(f)).map(f => `${entry.directory}/${f}`));
  let count = 0;
  const found = new Set();
  for (const file of scopedScanFiles(files)) {
    let source = readFileSync(`${root}/${file}`, 'utf8');
    // This module also owns CI-rerun HTTP effects and diagnostic comments, which
    // are not delivery launches. Inventory the gated delivery entry point.
    if (file === 'scripts/operations/ci-heal-pr-dispatch.mjs') {
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const entry = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'dispatchCiHeal');
      expect(entry, 'missing CI-heal delivery entry point').toBeTruthy();
      source = entry.getText();
    }
    const result = scan(source);
    if (file === 'scripts/operations/ci-heal-pr-dispatch.mjs') expect(result.sites.length).toBeGreaterThan(0);
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
it.each(['spawnDetached', 'spawnAgent', 'runNode', 'defaultRunNode', 'spawnLand', 'spawnResume', 'provider', 'launchWrapped', 'sinks[DISPATCH_EFFECT]'])('flags the %s wrapper independently of argument shape', name => {
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
  }`).bypasses).toHaveLength(1);
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
  expect(scan(source.replace("const argv =", "if (groupMembers.some(member => !assertRuntimeAdmitted({ num: member }, 'resume').admitted)) return null; const argv =")).bypasses).toHaveLength(1);
});

it('accepts only launch effects under the shared wrapper and rejects lost groups', () => {
  expect(scan(`function deliver(payload) {
    return withRuntimeAdmission(payload, 'build', () => provider(payload));
  }`).bypasses).toEqual([]);
  expect(scan(`function deliver(num, groupMembers) {
    return withRuntimeAdmission({ num, groupMembers }, 'build', () => provider({ num, groupMembers }));
  }`).bypasses).toEqual([]);
  expect(scan(`function deliver(num, groupMembers) {
    return withRuntimeAdmission({ num }, 'build', () => provider({ num, groupMembers }));
  }`).bypasses).toHaveLength(1);
  expect(scan(`function deliver(payload) {
    withRuntimeAdmission(payload, 'build', () => {});
    return provider(payload);
  }`).bypasses).toHaveLength(1);
  expect(scan(`function deliver(payload) {
    return withRuntimeAdmission(payload, 'build', () => { return () => provider(payload); });
  }`).bypasses).toHaveLength(1);
});

it('rejects a lead projection even when the launch forwards the whole persisted card', () => {
  expect(scan(`function deliver(payload) {
    return withRuntimeAdmission({ num: payload.num }, 'build', () => provider(payload));
  }`).bypasses).toHaveLength(1);
});

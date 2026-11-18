/** @repo-scanning-test scope=full */
import { it, expect } from 'vitest';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { RUNTIME_ADMISSION_SPAWN_SCAN, scanRoot, scopedScanFiles } from '../repo-scan-tests.mjs';

const root = scanRoot(process.cwd());
const launches = /^(?:spawnDetached|defaultSpawnDetached|startDetachedLaunch|spawnResume|spawnLand|spawnPreventionLandingJob|dispatchCiHeal|sinks\[DISPATCH_EFFECT\]|provider|effects\.(?:dispatch|routeHeldItems|stampPrepare)|io\.dispatch)$/;

// A prior check is insufficient: only the effect callback of the shared fresh-read
// boundary may launch. Stop at the nearest function so nested/deferred callbacks
// cannot borrow a surrounding admission.
function launchBoundary(call) {
  let callback = call.parent;
  while (callback && !ts.isFunctionLike(callback)) callback = callback.parent;
  if (callback?.body && ts.isBlock(callback.body) && (callback.body.statements.length !== 1
    || !(ts.isReturnStatement(callback.body.statements[0]) || ts.isExpressionStatement(callback.body.statements[0])))) return null;
  const wrapper = callback?.parent;
  return wrapper && ts.isCallExpression(wrapper) && wrapper.expression.getText() === 'withRuntimeAdmission'
    && wrapper.arguments[2] === callback ? wrapper : null;
}
function processBoundary(call) {
  return call.expression.getText() === 'withRuntimeProcessAdmission' && call.arguments[1] && ts.isArrayLiteralExpression(call.arguments[1]);
}
function guarded(call) { return processBoundary(call) || !!launchBoundary(call); }
function groupsGuarded(call) {
  if (processBoundary(call)) return true;
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
function scan(source, nativeOnly = false) {
  const ast = ts.createSourceFile('spawn.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const aliases = new Set(), regexes = new Set();
  const namespaces = new Set();
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !['node:child_process', 'child_process'].includes(node.moduleSpecifier?.text)) continue;
    if (node.importClause?.name) namespaces.add(node.importClause.name.text);
    if (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) namespaces.add(node.importClause.namedBindings.name.text);
  }
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
    const member = ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : null;
    const name = ts.isPropertyAccessExpression(expression) ? expression.name.text : member ?? expression.getText();
    if (name === 'withRuntimeProcessAdmission') return true;
    if (nativeOnly && (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && namespaces.has(expression.expression.getText())) return true;
    if (nativeOnly && name === 'exec' && (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && !namespaces.has(expression.expression.getText())) return false;
    // RegExp/string .exec is not a child-process port.
    return (name !== 'exec' || !ts.isPropertyAccessExpression(expression) || (!ts.isRegularExpressionLiteral(expression.expression) && !regexes.has(expression.expression.getText()))) && ((nativeOnly ? /^(?:execFileSync|execFile|execSync|spawn|spawnSync|fork|spawnFn|spawnToCompletionFn|execFileSyncThrottled|execFileThrottledAsync)$/ : primitives).test(name) || (!nativeOnly && launches.test(name))
      || (!nativeOnly && launches.test(expression.getText())) || aliases.has(name));
  };
  let changed;
  do {
    changed = false;
    const alias = (name, value) => { if (value && launchName(value) && !aliases.has(name)) { aliases.add(name); changed = true; } };
    const visit = node => {
      if (ts.isImportSpecifier(node)) {
        const declaration = node.parent?.parent?.parent;
        if (nativeOnly && ['node:child_process', 'child_process'].includes(declaration?.moduleSpecifier?.text)) aliases.add(node.name.text);
        else alias(node.name.text, node.propertyName || node.name);
      }
      if (ts.isVariableDeclaration(node) && node.initializer && namespaces.has(node.initializer.getText()) && !namespaces.has(node.name.getText())) { namespaces.add(node.name.getText()); changed = true; }
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
        owner: owner ? ownerName(owner) : '<module>',
        signature: createHash('sha256').update((owner ?? node).getText()).digest('hex').slice(0, 16) };
      sites.push(site);
      if (!guarded(node) || !groupsGuarded(node)) bypasses.push(site);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { sites, bypasses };
}
export function staticImportClosure(tree, entries) {
  const modules = new Map();
  function visit(file) {
    if (modules.has(file)) return;
    const source = readFileSync(join(tree, file), 'utf8'); // missing/unreadable evidence fails closed
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    expect(ast.parseDiagnostics, `cannot parse ${file}`).toEqual([]);
    modules.set(file, { source, ast });
    for (const node of ast.statements) {
      if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) continue;
      const specifier = node.moduleSpecifier?.text;
      if (!specifier?.startsWith('.')) continue;
      const target = relative(resolve(tree), resolve(tree, dirname(file), specifier)).replaceAll('\\', '/');
      if (target === '..' || target.startsWith('../')) continue;
      visit(target);
    }
  }
  entries.forEach(visit);
  return modules;
}
const deliveryEntries = [
  'skills-src/conveyor/build-dispatch-daemon.mjs',
  'scripts/conveyor/tick-core.mjs',
  'scripts/operations/dispatch-lane.mjs',
  'scripts/operations/dispatch-lane-io.mjs',
  'scripts/operations/worker-wrapper.mjs',
  'scripts/operations/deliver-item-wrapper.mjs',
];
function processModules(tree, entries) {
  return [...staticImportClosure(tree, entries)].map(([file, { source, ast }]) => ({
    file, ...scan(source, true),
    importsProcess: ast.statements.some(n => ts.isImportDeclaration(n)
      && ['node:child_process', 'child_process'].includes(n.moduleSpecifier?.text)),
  })).filter(row => row.importsProcess || row.sites.length);
}

// Explicit review ledger. Every process-bearing module in the STATIC delivery closure
// must match its functions and call multiset; additions/removals require review here.
const processInventory = [
  {"file": "scripts/backlog-stranded-sweep.mjs","functions": ["main","readMainLog","run"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["main#execFileSync#9b1d0b8d84eb36f7","readMainLog#execFileSync#c6f8deb2c1c3453a","run#execFileSync#d6e8799302f6ac3e"]},
  {"file": "scripts/bootstrap-session.mjs","functions": ["runSkills"],"status": "readonly","reason": "Synchronizes agent skill tooling; does not dispatch delivery work.","calls": ["runSkills#execFileSync#b9b04f292ccc72e5"]},
  {"file": "scripts/ci-card-only.mjs","functions": ["exec"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["exec#execFileSync#8a88778fc2bee6ba"]},
  {"file": "scripts/codex-direct-task.mjs","functions": ["defaultExecFn","detachedGateExecFn/callback","execFn","finishScratchClone","git","gitHardened","readPidState","repoRootFromCwd","runCodexDirectExec/callback","runCodexDirectTask","runGate","setupScratchClone","startDetachedJob"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["defaultExecFn#withRuntimeProcessAdmission#ba3f43f299fc73e8","detachedGateExecFn/callback#withRuntimeProcessAdmission#f56564f11377f91f","execFn#withRuntimeProcessAdmission#bfdc5fa40a5db647","finishScratchClone#withRuntimeProcessAdmission#473f969859195a65","finishScratchClone#withRuntimeProcessAdmission#473f969859195a65","finishScratchClone#withRuntimeProcessAdmission#473f969859195a65","git#withRuntimeProcessAdmission#712f2cb2b53e0d20","gitHardened#withRuntimeProcessAdmission#f066618d093ec5c2","readPidState#withRuntimeProcessAdmission#8dd7647afb7edb29","repoRootFromCwd#withRuntimeProcessAdmission#00beaedb57b5cbea","runCodexDirectExec/callback#withRuntimeProcessAdmission#80e29f56676769c7","runCodexDirectTask#withRuntimeProcessAdmission#d17aa5cd70af4f58","runCodexDirectTask#withRuntimeProcessAdmission#d17aa5cd70af4f58","runGate#withRuntimeProcessAdmission#ff5cbfb57dba0f3e","setupScratchClone#withRuntimeProcessAdmission#80985d17ed3ecd31","startDetachedJob#withRuntimeProcessAdmission#4fc43e07fafb2092"]},
  {"file": "scripts/conveyor/advisory-fix-mark.mjs","functions": ["<module>"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["<module>#execFileSync#1cd32f993594fc93"]},
  {"file": "scripts/conveyor/await-verify.mjs","functions": ["git"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["git#exec#15f4e3ebbda19ccf"]},
  {"file": "scripts/conveyor/branch-sync.mjs","functions": ["gitRun","notifyDesktopChecked","runDriftSweepBestEffort","send"],"status": "readonly","reason": "Git synchronization, desktop notifications and diagnostic drift sweeps.","calls": ["gitRun#execFileSync#acebdea0ac80f2be","notifyDesktopChecked#spawnSyncFn#87b392ae26b6cfa9","runDriftSweepBestEffort#spawnSync#5ce7f322e051f85d","send#spawn#049edc8d32736813"]},
  {"file": "scripts/conveyor/build-delivery-evidence.mjs","functions": ["defaultListBuildPrs","run"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultListBuildPrs#exec#1cfba08b9d0b00cc","run#git#734bb9b3e7bf2cd5"]},
  {"file": "scripts/conveyor/build-dispatch-orphan-adopt.mjs","functions": ["releaseReservedLaneLease"],"status": "readonly","reason": "Reads/relinquishes lane leases; work launches have separate guarded ports.","calls": ["releaseReservedLaneLease#exec#343d1f7eea364aed"]},
  {"file": "scripts/conveyor/ci-heal-escalation-mark.mjs","functions": ["defaultReadBaseHead","ghRead"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultReadBaseHead#exec#fbc3507fcec8fcbb","ghRead#execFileSync#daaa8816f681577a"]},
  {"file": "scripts/conveyor/ci-heal-mark.mjs","functions": ["handBackCiHealReview","resolveHealHead","spawnCiHealRearm","spawnCiHealRestamp"],"status": "readonly","reason": "Reads head identity and rearms/restamps CI evidence and review handback metadata.","calls": ["handBackCiHealReview#exec#5cf59fb642855f93","resolveHealHead#exec#c1bef92e56c6f52a","spawnCiHealRearm#spawn#702cecb720678e19","spawnCiHealRestamp#spawn#85013803587a6855"]},
  {"file": "scripts/conveyor/ci-heal-owed.mjs","functions": ["postPrComment","readPrState","resolveOwedRepo"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["postPrComment#exec#46ff934fb223bbe4","readPrState#exec#f6ea49657243c7a0","resolveOwedRepo#exec#380ab17fd65b8656"]},
  {"file": "scripts/conveyor/driver-watchdog.mjs","functions": ["fetch","healDriver","scanPsOutput"],"status": "readonly","reason": "Reads driver/process state and repairs the driver UI; not per-card delivery work.","calls": ["fetch#exec#49d86bc1a901fcc2","healDriver#run#41d1c370c75dc540","scanPsOutput#exec#8ea9290dbb57f899"]},
  {"file": "scripts/conveyor/fix-dispatch-claim.mjs","functions": ["readPrHead"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["readPrHead#execFileSyncThrottled#65452063be287d9c"]},
  {"file": "scripts/conveyor/fix-procedure.mjs","functions": ["<module>","git","repoKeyForCheckout"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["<module>#withRuntimeProcessAdmission#879353a9a1c2bff3","git#withRuntimeProcessAdmission#b0ae6e3c1448518f","repoKeyForCheckout#withRuntimeProcessAdmission#ec9642f7cc7c6355"]},
  {"file": "scripts/conveyor/fix-push-ci.mjs","functions": ["defaultRun"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["defaultRun#withRuntimeProcessAdmission#b589e7d3935fd103"]},
  {"file": "scripts/conveyor/infra-blocked.mjs","functions": ["resumeOpen/callback"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["resumeOpen/callback#exec#5b0e74615ae266fc"]},
  {"file": "scripts/conveyor/infra-blocked.mjs","functions": ["originSlugOf","readResumeGit"],"status": "readonly","reason": "Reads published refs and origin identity for recovery evidence.","calls": ["originSlugOf#execFileSync#a358c101f8f2cc3e","readResumeGit#exec#d4931760fd00b8b7"]},
  {"file": "scripts/conveyor/land-overlap-yield.mjs","functions": ["configAt","isShallowRepository","readyToMergeLabelTimeMs"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["configAt#exec#59694d862ca903c8","configAt#exec#59694d862ca903c8","isShallowRepository#exec#ab1e5f1cf091258c","readyToMergeLabelTimeMs#exec#749be0d2edee581a"]},
  {"file": "scripts/conveyor/lease-reaper.mjs","functions": ["defaultGitIsAncestor","defaultPidCommand","gitRead","releaseLane","stablePatchId"],"status": "readonly","reason": "Reads Git/process evidence and releases terminal lane leases.","calls": ["defaultGitIsAncestor#exec#15517ac3d6d82f01","defaultGitIsAncestor#exec#15517ac3d6d82f01","defaultPidCommand#execFileSync#018f04c44750a174","gitRead#exec#8c385a35a9a2e2cc","releaseLane#exec#9f407680f939fafb","stablePatchId#exec#d73cdf456809196c"]},
  {"file": "scripts/conveyor/mechanical-round-cap.mjs","functions": ["git"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["git#exec#378f5cde678eb587","git#exec#378f5cde678eb587"]},
  {"file": "scripts/conveyor/pending-launches.mjs","functions": ["startDetachedLaunch/callback"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["startDetachedLaunch/callback#withRuntimeProcessAdmission#3220b3d7950b4618"]},
  {"file": "scripts/conveyor/pr-comments-list.mjs","functions": ["defaultListPrComments"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultListPrComments#exec#d9be63dc0cb80136"]},
  {"file": "scripts/conveyor/pr-stack.mjs","functions": ["gitDiffNames/callback","gitIsAncestor/callback","run"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["gitDiffNames/callback#execFileSync#f8ea445a88e5a7ce","gitIsAncestor/callback#execFileSync#34c4550efc34b9a0","run#execFileSync#163360f3b8bc324e","run#execFileSync#4b671d10ff63dbbf"]},
  {"file": "scripts/conveyor/pr-watch.mjs","functions": ["main/callback","releaseSessionAcrossPools","run"],"status": "readonly","reason": "Reads PR state and releases/settles already-landed backlog/lane metadata.","calls": ["main/callback#execFileSync#9a20cdc6d089e5e0","releaseSessionAcrossPools#execFileSync#2df2d559f6a9afa7","run#execFileSync#e6dbc540acdbd15c"]},
  {"file": "scripts/conveyor/prepare-failure-policy.mjs","functions": ["readPrepareReleases/callback"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["readPrepareReleases/callback#execFileSync#d705e449d8ee4359"]},
  {"file": "scripts/conveyor/queue-prune.mjs","functions": ["makeConfirmMissingOnMain/callback","run"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["makeConfirmMissingOnMain/callback#exec#2da0e5d9f1dc7f95","makeConfirmMissingOnMain/callback#exec#2da0e5d9f1dc7f95","run#exec#d30111b8629ffdc3"]},
  {"file": "scripts/conveyor/reconcile-note-comment.mjs","functions": ["postNoteComment"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["postNoteComment#exec#d15b4c4a1c7f0521"]},
  {"file": "scripts/conveyor/referral-reverify.mjs","functions": ["currentDiff","post","reverifyStaleReferrals"],"status": "readonly","reason": "Reads diffs and posts diagnostic referral verification results.","calls": ["currentDiff#execFileSyncThrottled#84488c361096f2ab","currentDiff#execFileSyncThrottled#84488c361096f2ab","post#execFileSyncThrottled#7775e73e5e5b63fa","reverifyStaleReferrals#(spawn ?? realSpawn)#3066fb3773b4b9e8"]},
  {"file": "scripts/conveyor/resolve-runner-checkout.mjs","functions": ["defaultLsof","defaultPs"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultLsof#execFileSync#97a7c1b36b9a914e","defaultPs#execFileSync#0a7a4585357a0621"]},
  {"file": "scripts/conveyor/review-churn.mjs","functions": ["defaultReadTree"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultReadTree#exec#1bd884f970e22466"]},
  {"file": "scripts/conveyor/review-referral-hold.mjs","functions": ["defaultReadComments","post"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultReadComments#execFileSyncThrottled#b6c4e6e55957a287","post#execFileSyncThrottled#87c741d83b081f50"]},
  {"file": "scripts/conveyor/review-stack-base.mjs","functions": ["exec","gitRun/callback","readBottom","readHead"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["exec#execFileSync#28cd06d515e6d7ff","gitRun/callback#execFileSync#b5b0bce1f1b7c5df","readBottom#execFileSync#0ceeec3792076c4b","readHead#execFileSync#03947b805b26f380"]},
  {"file": "scripts/conveyor/run-scorecard-store.mjs","functions": ["defaultGit/callback"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultGit/callback#execFileSync#760f2a75bb8a14c5"]},
  {"file": "scripts/conveyor/stand-down.mjs","functions": ["<module>/callback","gh"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["<module>/callback#execFileSync#72a7bbdb3e9efc11","gh#execFileSync#faf36fa471f23641"]},
  {"file": "scripts/conveyor/standing-ruling-io.mjs","functions": ["ghApp"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["ghApp#execFileSyncThrottled#ccfe74b60e27111e"]},
  {"file": "scripts/conveyor/tick-core.mjs","functions": ["main/callback","main/callback/callback","runJson/callback"],"status": "readonly","reason": "Reads planner/PR/host-queue/lane evidence only.","calls": ["main/callback#execFileSync#28b2a2a6db3cd97f","main/callback#execFileSync#9e13a8cd9405c62e","main/callback#execFileSync#b8d0c39d561b7e37","main/callback#execFileSync#ec6605bf1840a62d","main/callback/callback#execFile#b67a91b28c7791ef","runJson/callback#execFileSync#286aff450ff99801"]},
  {"file": "scripts/conveyor/verify-dispatch.mjs","functions": ["spawnGateBounded/callback"],"status": "readonly","reason": "Runs verification gates for diagnostics; never launches delivery/fix work.","calls": ["spawnGateBounded/callback#spawn#a1ed957d6d185d50"]},
  {"file": "scripts/guard-bash.mjs","functions": ["commitsBehindUpstream"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["commitsBehindUpstream#execFileSync#1836f9752f4459c2"]},
  {"file": "scripts/lane-drain.mjs","functions": ["drainOneCouple","numberPendingHashes","numberingGit","publishMain","readManifestOffRef","regenDerived","releaseItemLeases","reopenStrandedItem","resolveLandedItem","runDrainOne","unqueueViaBacklog","walk"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["drainOneCouple#withRuntimeProcessAdmission#f764217ed92c0724","numberPendingHashes#withRuntimeProcessAdmission#dd0790df85c98aa4","numberPendingHashes#withRuntimeProcessAdmission#dd0790df85c98aa4","numberPendingHashes#withRuntimeProcessAdmission#dd0790df85c98aa4","numberPendingHashes#withRuntimeProcessAdmission#dd0790df85c98aa4","numberingGit#withRuntimeProcessAdmission#070dbb3a5156f13e","publishMain#withRuntimeProcessAdmission#6cd1a9bf9decb1ca","readManifestOffRef#withRuntimeProcessAdmission#833da5898d6108eb","regenDerived#withRuntimeProcessAdmission#5a98608700ca9354","releaseItemLeases#withRuntimeProcessAdmission#1031a0a8fca8456f","reopenStrandedItem#withRuntimeProcessAdmission#e6163a450aee6ba1","resolveLandedItem#withRuntimeProcessAdmission#de95638a16d27618","runDrainOne#withRuntimeProcessAdmission#ff9de90842040995","unqueueViaBacklog#withRuntimeProcessAdmission#949950d7045ff5ea","walk#withRuntimeProcessAdmission#00ff2e10484da982"]},
  {"file": "scripts/lib/antigravity-judge-spawn.mjs","functions": ["antigravityJudgeSpawn/callback"],"status": "readonly","reason": "Runs a read-only Antigravity diagnostic judge.","calls": ["antigravityJudgeSpawn/callback#spawnFn#e8d66ba214cb1264"]},
  {"file": "scripts/lib/auto-land-seam.mjs","functions": ["defaultWriteAccept"],"status": "readonly","reason": "Writes an existing review acceptance marker; no new delivery dispatch.","calls": ["defaultWriteAccept#execFileSync#3bf304e9cbc13213"]},
  {"file": "scripts/lib/bounded-child.mjs","functions": ["listMarkedPids","listPeerHolderPids","listProcesses","ownProcessGroup","runBounded/callback"],"status": "readonly","reason": "Bounded process-table and host probes used for diagnostic evidence.","calls": ["listMarkedPids#execFileSync#540481c8d68509e5","listPeerHolderPids#execFileSync#b71b680007875e7c","listProcesses#execFileSync#eaefc1f6b362cf9a","ownProcessGroup#exec#afe1b92eca030c67","runBounded/callback#spawn#9a215c8dae138da9"]},
  {"file": "scripts/lib/card-group.mjs","functions": ["gh"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["gh#withRuntimeProcessAdmission#82f8dd52d8b405f5"]},
  {"file": "scripts/lib/card-number-allocator.mjs","functions": ["git"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["git#execFileSync#d4e73a1ef31c3434"]},
  {"file": "scripts/lib/card-number-ledger.mjs","functions": ["defaultRun"],"status": "readonly","reason": "Reads and appends card-number ledger entries.","calls": ["defaultRun#execFileSync#6f63c68373fe212a","defaultRun#spawnSync#6f63c68373fe212a"]},
  {"file": "scripts/lib/claude-account.mjs","functions": ["defaultReadKeychain"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultReadKeychain#execFileSync#bf64995179129e05"]},
  {"file": "scripts/lib/clone-maintenance.mjs","functions": ["cloneGitIsBusy","runMaintenanceGit/callback"],"status": "readonly","reason": "Git garbage-collection/maintenance and process diagnostics only.","calls": ["cloneGitIsBusy#exec#9bc78121eb9d8a5a","cloneGitIsBusy#exec#9bc78121eb9d8a5a","runMaintenanceGit/callback#spawn#8da6f104d78c49e1"]},
  {"file": "scripts/lib/codex-judge-spawn.mjs","functions": ["codexJudgeSpawn/callback/callback"],"status": "readonly","reason": "Runs a read-only Codex diagnostic judge.","calls": ["codexJudgeSpawn/callback/callback#spawnFn#e86b17bcc14b617e"]},
  {"file": "scripts/lib/conflict-finding.mjs","functions": ["defaultPostConflictFinding"],"status": "readonly","reason": "Posts diagnostic conflict findings.","calls": ["defaultPostConflictFinding#exec#d84283f9ae203811"]},
  {"file": "scripts/lib/container-exec.mjs","functions": ["containerCliAvailable","containerImageAvailable","execContainerized","execContainerized/callback","execFile","nodeModulesVolumeAvailable"],"status": "readonly","reason": "Container verification transport and image/volume availability probes; no delivery dispatch.","calls": ["containerCliAvailable#execFile#7545a5cd150731f9","containerImageAvailable#execFile#258e5799dbdd333d","execContainerized#execFile#3475e7f473788841","execContainerized/callback#execFileSync#9ced96e157798958","execFile#execFileSync#9ced96e157798958","execFile#execFileSync#9ced96e157798958","execFile#execFileSync#9ced96e157798958","nodeModulesVolumeAvailable#execFile#48d3cdd4c16c8a96"]},
  {"file": "scripts/lib/daemon-background-build.mjs","functions": ["spawnBuilder"],"status": "readonly","reason": "Rebuilds daemon infrastructure in the background; no delivery agent.","calls": ["spawnBuilder#spawnFn#ada901c5cd7d3ba9"]},
  {"file": "scripts/lib/daemon-clone-card-salvage.mjs","functions": ["git"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["git#execFileSync#c04f5091089a3a7a"]},
  {"file": "scripts/lib/daemon-clone-lock.mjs","functions": ["runCli/callback"],"status": "readonly","reason": "Runs clone-lock infrastructure CLI operations; no delivery agent.","calls": ["runCli/callback#spawnSync#5f272161324f3a20"]},
  {"file": "scripts/lib/daemon-job-snapshots.mjs","functions": ["gitArchiveMaterializer/callback","npmCiInstaller/callback"],"status": "readonly","reason": "Materializes infrastructure snapshots and installs their dependencies.","calls": ["gitArchiveMaterializer/callback#execFileSync#386b9cbc17b9baea","npmCiInstaller/callback#execFileSync#d30dbcc1c98db42d"]},
  {"file": "scripts/lib/daemon-jobs-runtime.mjs","functions": ["launchJob","localHostAliases","readBootTime","readGroupStarts","readProcStart","spawnDetached"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["launchJob#withRuntimeProcessAdmission#dda5cf1e9ce43dbf","localHostAliases#withRuntimeProcessAdmission#750d22eba3744d5c","readBootTime#withRuntimeProcessAdmission#e1430283e37cda1e","readGroupStarts#withRuntimeProcessAdmission#598efa6f4c7d844f","readProcStart#withRuntimeProcessAdmission#c3200a7eca43de0b","spawnDetached#withRuntimeProcessAdmission#5131893ebd88651d"]},
  {"file": "scripts/lib/daemon-overlays.mjs","functions": ["ghJson","ghSlug"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["ghJson#spawnSync#fe0984b63fbbb6f2","ghSlug#spawnSync#0993879102856853"]},
  {"file": "scripts/lib/daemon-rebuild/advisory-merge.mjs","functions": ["checkModuleSyntax"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["checkModuleSyntax#spawnSync#463421bce8559e03"]},
  {"file": "scripts/lib/daemon-rebuild/auto-rebase.mjs","functions": ["execute","executeAsync/callback","kickAutoRebase"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["execute#withRuntimeProcessAdmission#b349396a162fe6b7","executeAsync/callback#withRuntimeProcessAdmission#93b540c4b4c0ffac","kickAutoRebase#withRuntimeProcessAdmission#95d7da82c10ce84c"]},
  {"file": "scripts/lib/daemon-rebuild/candidate.mjs","functions": ["candidateSmokeEnv"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["candidateSmokeEnv#spawnSync#d72349165561c8ef"]},
  {"file": "scripts/lib/daemon-rebuild/edge-fetch.mjs","functions": ["defaultPrState"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultPrState#spawnSync#40e074e7a4daaa9c","defaultPrState#spawnSync#40e074e7a4daaa9c"]},
  {"file": "scripts/lib/daemon-rebuild/lease.mjs","functions": ["processStartMs"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["processStartMs#spawnSync#8260e781ed7352ad"]},
  {"file": "scripts/lib/daemon-rebuild/preview.mjs","functions": ["dryRunRebuild","previewOverlayConflict"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["dryRunRebuild#spawnSync#f1f407c6ddaf97ee","previewOverlayConflict#spawnSync#a9ee4eb82d463855"]},
  {"file": "scripts/lib/daemon-rebuild/rebuild-job.mjs","functions": ["cloneNodeModulesInstaller/callback","reportReaderWaitTimeout","runRebuildChild/callback"],"status": "readonly","reason": "Compiles/rebuilds infrastructure and reports reader-wait diagnostics.","calls": ["cloneNodeModulesInstaller/callback#exec#3f746519ba8be96b","cloneNodeModulesInstaller/callback#exec#3f746519ba8be96b","reportReaderWaitTimeout#exec#a2c6adb0eab45515","runRebuildChild/callback#spawnFn#f0448c904d794d08"]},
  {"file": "scripts/lib/daemon-rebuild/rebuild.mjs","functions": ["defaultForceWatchProbe/callback","defaultSpawnerOwners"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultForceWatchProbe/callback#execFileSync#0857aa03d6e76310","defaultSpawnerOwners#exec#23e156dad83d53fb"]},
  {"file": "scripts/lib/daemon-rebuild/skip-unrelated.mjs","functions": ["trackedScriptIndex/callback"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["trackedScriptIndex/callback#spawnSync#b8779bb6c30cbcf9"]},
  {"file": "scripts/lib/daemon-version-state.mjs","functions": ["gitAt"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["gitAt#execFileSync#092990943d88a5dd"]},
  {"file": "scripts/lib/daemon-version.mjs","functions": ["buildVersion/callback"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["buildVersion/callback#spawnSync#6e9dc21fd7552131"]},
  {"file": "scripts/lib/drain-api-reads.mjs","functions": ["git","pinnedExec"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["git#execFileSync#3b2b24f8f9a06a78","pinnedExec#exec#7ce3a89f3e2f5855"]},
  {"file": "scripts/lib/drain-followup-job.mjs","functions": ["fetchRemoteTip","git","gitAt","makeFollowupWorktreePreparer/callback","rev","run/callback"],"status": "readonly","reason": "Maintains post-landing Git/ledger bookkeeping; no delivery worker.","calls": ["fetchRemoteTip#exec#9163bcfc2077eaf9","git#exec#c7e320103a3a0809","gitAt#exec#824b28df29a93410","makeFollowupWorktreePreparer/callback#exec#939a9cb407765cb3","makeFollowupWorktreePreparer/callback#exec#939a9cb407765cb3","rev#exec#032540285e292a02","run/callback#exec#163c46bf3874cf8d"]},
  {"file": "scripts/lib/drain-gh-async.mjs","functions": [],"status": "readonly","reason": "Imports the asynchronous GitHub evidence port; no direct invocation.","calls": []},
  {"file": "scripts/lib/drain-merge-strategy.mjs","functions": ["checkGh","collectQueueMerged","comment","drainLogin","enqueue","exec","readLive","readThreadPages"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["checkGh#withRuntimeProcessAdmission#1b6d2b6a3a0ae00d","collectQueueMerged#withRuntimeProcessAdmission#eed08ad11251492a","comment#withRuntimeProcessAdmission#d0ea81f72ffd8fef","comment#withRuntimeProcessAdmission#d0ea81f72ffd8fef","drainLogin#withRuntimeProcessAdmission#2d3e8289cd4e21f2","enqueue#withRuntimeProcessAdmission#4edb913e306e7b14","exec#withRuntimeProcessAdmission#81aca821865c8791","exec#withRuntimeProcessAdmission#da02cf7d39b9347a","exec#withRuntimeProcessAdmission#da02cf7d39b9347a","readLive#withRuntimeProcessAdmission#6572a06a55dbce3b","readThreadPages#withRuntimeProcessAdmission#516ae43badb20e9b"]},
  {"file": "scripts/lib/drain-queue-safety.mjs","functions": ["createMqLiveReader/callback","dequeueSentBack","exactExec","mqSameHeadRefresh","passed","read","read1","readJson","readMqBaseRetryEvidence","readMqBaseRetryEvidence/callback","readMqMergeState","readPages","readReport","readRunPage","reportOf","requiredGreen","workflowId"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["createMqLiveReader/callback#exec#ea1a38e29b6ecdf4","createMqLiveReader/callback#exec#ea1a38e29b6ecdf4","dequeueSentBack#exec#a78994553da994d5","exactExec#exec#f670fd885932ea34","mqSameHeadRefresh#exec#10a0d2c1173a7690","mqSameHeadRefresh#exec#10a0d2c1173a7690","mqSameHeadRefresh#exec#10a0d2c1173a7690","passed#exec#9e27c3c276552065","passed#exec#9e27c3c276552065","read#exec#dd58dbae6d6b15e5","read1#exec#4a5d91b8f09f7c4b","readJson#exec#00def70221997b89","readJson#exec#dbd43354d046ddd4","readMqBaseRetryEvidence#exec#7d47f1ac156b842a","readMqBaseRetryEvidence#exec#7d47f1ac156b842a","readMqBaseRetryEvidence#exec#7d47f1ac156b842a","readMqBaseRetryEvidence#exec#7d47f1ac156b842a","readMqBaseRetryEvidence#exec#7d47f1ac156b842a","readMqBaseRetryEvidence/callback#exec#af94b057632bf0f3","readMqMergeState#exec#314cc8cc3eedb68b","readPages#exec#ea5a8d3c32723360","readReport#exec#94ec232573e175c0","readReport#exec#94ec232573e175c0","readReport#exec#94ec232573e175c0","readRunPage#exec#c39ed6b201e10f0a","reportOf#exec#dbde95550862ab62","requiredGreen#exec#df4c1fa765d82898","workflowId#exec#4f5d313dfdb2d72d"]},
  {"file": "scripts/lib/gate-config.mjs","functions": ["readPolicySpecRegistryAt"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["readPolicySpecRegistryAt#execFileSync#929ea82f48cf4b69","readPolicySpecRegistryAt#execFileSync#929ea82f48cf4b69","readPolicySpecRegistryAt#execFileSync#929ea82f48cf4b69"]},
  {"file": "scripts/lib/gh-rest-read.mjs","functions": ["run"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["run#exec#1d41a428af969d44"]},
  {"file": "scripts/lib/gh-throttle-holders.mjs","functions": ["ps"],"status": "readonly","reason": "Reads process listings for throttle-holder diagnostics.","calls": ["ps#execFileSync#36e9335f291ce8a1"]},
  {"file": "scripts/lib/gh-throttle.mjs","functions": ["execFileSyncThrottled","personalGhToken","runGhCliPassthroughUncached","runGhCliPassthroughUncached/callback","runGhSyncUnmemoized","runGhSyncUnmemoized/callback","spawnWithGhDebugCapture"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["execFileSyncThrottled#withRuntimeProcessAdmission#c358952aa03ff552","personalGhToken#withRuntimeProcessAdmission#b61ab4ebaac629f7","runGhCliPassthroughUncached#withRuntimeProcessAdmission#f4b4937cdc039665","runGhCliPassthroughUncached/callback#withRuntimeProcessAdmission#a78a4f56efe4e818","runGhSyncUnmemoized#withRuntimeProcessAdmission#9b7fe1fd923f0d38","runGhSyncUnmemoized#withRuntimeProcessAdmission#9b7fe1fd923f0d38","runGhSyncUnmemoized/callback#withRuntimeProcessAdmission#225bb4b2372c6519","runGhSyncUnmemoized/callback#withRuntimeProcessAdmission#d40ebd162410010d","spawnWithGhDebugCapture#withRuntimeProcessAdmission#f5724c1ef8d62a51"]},
  {"file": "scripts/lib/git-already-done.mjs","functions": ["run"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["run#git#c4328fa84b07f494"]},
  {"file": "scripts/lib/git-fetch-fresh.mjs","functions": ["defaultRun"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultRun#execFileSync#5c4a5f246dcdc01c"]},
  {"file": "scripts/lib/git-hook-surface.mjs","functions": ["restoreRepoHooksPath","withHooksDisabled"],"status": "readonly","reason": "Reads and restores local Git hook configuration.","calls": ["restoreRepoHooksPath#execFileSync#9d249643cad331e0","restoreRepoHooksPath#execFileSync#9d249643cad331e0","restoreRepoHooksPath#execFileSync#9d249643cad331e0","withHooksDisabled#execFileSync#8f6f651f934587a1"]},
  {"file": "scripts/lib/git-identity.mjs","functions": ["effective","ensureLaneHooksPath","read","run"],"status": "readonly","reason": "Reads identity/config and sets local hook/identity metadata.","calls": ["effective#run#168e1223e58d1347","ensureLaneHooksPath#run#5abd61e638ee460e","ensureLaneHooksPath#run#5abd61e638ee460e","ensureLaneHooksPath#run#5abd61e638ee460e","read#run#f1ed39f8a79f4232","run#execFileSync#e69142eafa7f8909"]},
  {"file": "scripts/lib/git-pr-commits.mjs","functions": ["run"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["run#git#54bc95c8929f3837"]},
  {"file": "scripts/lib/git-run.mjs","functions": ["gitRun"],"status": "readonly","reason": "Local Git evidence/object/history transport; no independent work dispatcher.","calls": ["gitRun#spawnSync#d06c68ba1f628be5"]},
  {"file": "scripts/lib/git-transport-branch.mjs","functions": ["defaultGit","publicSigningIdentity","verifySignedTransportCommit/callback"],"status": "readonly","reason": "Git transport for ledger/backlog filing, signing and local transport worktree maintenance.","calls": ["defaultGit#execFileSync#32f5bf6d023e03d6","defaultGit#spawnSync#32f5bf6d023e03d6","publicSigningIdentity#exec#e4afbe4c4428e8b3","publicSigningIdentity#exec#e4afbe4c4428e8b3","verifySignedTransportCommit/callback#spawnSync#643bb0267c8ec17d"]},
  {"file": "scripts/lib/github-app-token.mjs","functions": ["exec"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["exec#execFileSync#69c8d18dc9ea340d"]},
  {"file": "scripts/lib/host-load.mjs","functions": ["readMemoryReading","scheduledLaneGc/callback"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["readMemoryReading#exec#37931e1980d2da74","readMemoryReading#exec#37931e1980d2da74","readMemoryReading#exec#37931e1980d2da74","scheduledLaneGc/callback#exec#02b15561359015f5","scheduledLaneGc/callback#exec#02b15561359015f5"]},
  {"file": "scripts/lib/host-sample.mjs","functions": ["run"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["run#execFileSync#2a3d2f7fa0cbb2a2"]},
  {"file": "scripts/lib/isolation-provider.mjs","functions": [],"status": "readonly","reason": "Imports process defaults for isolation policy; no direct process invocation.","calls": []},
  {"file": "scripts/lib/judge-spawn.mjs","functions": ["judgeSpawn/callback"],"status": "readonly","reason": "Runs read-only diagnostic judges, not delivery/fix agents.","calls": ["judgeSpawn/callback#spawnFn#edf64930686ba2de"]},
  {"file": "scripts/lib/lane-acquire-origin.mjs","functions": ["readOriginDefault"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["readOriginDefault#execFileSync#daf6567f272451f9"]},
  {"file": "scripts/lib/lane-git-hardening.mjs","functions": ["run"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["run#execFileSync#233b4aaabb82dd46"]},
  {"file": "scripts/lib/lane-history.mjs","functions": ["snapshotGit"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["snapshotGit#execFileSync#580861669757b3b2"]},
  {"file": "scripts/lib/lane-hold-io.mjs","functions": ["laneOriginUrl","liveRemoteHasRevision"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["laneOriginUrl#execFileSync#99bd2d03e0788be8","liveRemoteHasRevision#execFileSync#311e5bdc92524e11"]},
  {"file": "scripts/lib/lane-repair.mjs","functions": ["runGit"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["runGit#spawnSync#27fa406fd3209e36"]},
  {"file": "scripts/lib/lane-salvage.mjs","functions": ["fetch","git","readLiveCwds"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["fetch#exec#97d79626df841fc5","git#execFileSync#c3b8dbb1615103d3","readLiveCwds#exec#3029037678feabe4"]},
  {"file": "scripts/lib/lane-verify.mjs","functions": ["runGh"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["runGh#execFileSync#c3386e3b81e96943","runGh#execFileSync#c3386e3b81e96943"]},
  {"file": "scripts/lib/main-staleness.mjs","functions": ["assertOperatorCliFresh","gitRun","reexecSelf","release"],"status": "readonly","reason": "Reads Git freshness and relocates the current CLI; delivery entry points still own work admission.","calls": ["assertOperatorCliFresh#laneSpawn#a709ee9b5095d49f","assertOperatorCliFresh#spawn#a709ee9b5095d49f","gitRun#spawnSync#a04b7f440b59a622","reexecSelf#spawn#1be7aa36064bcef1","release#laneSpawn#f92fdd2d09302d3c"]},
  {"file": "scripts/lib/memory-available.mjs","functions": ["memoryAvailableBytes"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["memoryAvailableBytes#exec#5c265ec38e23092e"]},
  {"file": "scripts/lib/merge-gate-refresh.mjs","functions": ["labelCall","readLabels","reconcile","refreshMergeGateAfterRestamp","toggleMergeGateRefresh"],"status": "readonly","reason": "Reads and refreshes existing CI/merge-gate evidence and labels.","calls": ["labelCall#gh#753f51e98f5964e5","readLabels#gh#27ca716d67bee4c0","reconcile#gh#bc5f000a0e6585aa","refreshMergeGateAfterRestamp#gh#ea0e8917de09e59d","refreshMergeGateAfterRestamp#gh#ea0e8917de09e59d","toggleMergeGateRefresh#gh#4e9f85d146c9c596","toggleMergeGateRefresh#gh#4e9f85d146c9c596"]},
  {"file": "scripts/lib/merge-queue-adaptive-batching.mjs","functions": ["graphql","observe","readGroupingStrategy"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["graphql#exec#4f8aa46fed0e54fb","observe#exec#a6a28cf8432a5e2b","observe#exec#a6a28cf8432a5e2b","observe#exec#a6a28cf8432a5e2b","readGroupingStrategy#exec#92641ed575b7cd64"]},
  {"file": "scripts/lib/merge-queue-affected.mjs","functions": ["gitRunner/callback"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["gitRunner/callback#execFileSync#e0e80fcbc70fddc7"]},
  {"file": "scripts/lib/merge-queue-enqueue.mjs","functions": ["enqueuePr","git","readBaseTip","readJson","readMergeGateRuns","requestOperatorQueueEntry"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["enqueuePr#withRuntimeProcessAdmission#4c8dd9f32ebc46a9","enqueuePr#withRuntimeProcessAdmission#4c8dd9f32ebc46a9","git#withRuntimeProcessAdmission#145db9f7f0affa9a","readBaseTip#withRuntimeProcessAdmission#b49ede98f0087c3e","readJson#withRuntimeProcessAdmission#1c927f9683c9333b","readMergeGateRuns#withRuntimeProcessAdmission#f1d09a89510703ff","requestOperatorQueueEntry#withRuntimeProcessAdmission#03a05c72dae325e7"]},
  {"file": "scripts/lib/merge-queue-hook.mjs","functions": ["refreshStalePr/callback"],"status": "readonly","reason": "Refreshes metadata for an existing queued PR.","calls": ["refreshStalePr/callback#execFileSyncThrottled#e414d792fff0b63d"]},
  {"file": "scripts/lib/merge-queue-obsolete-runs.mjs","functions": ["api"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["api#exec#311eae2bd7727b77"]},
  {"file": "scripts/lib/merge-queue-stuck-dequeue.mjs","functions": [],"status": "readonly","reason": "Imports a subprocess port for queue diagnostics; no direct invocation.","calls": []},
  {"file": "scripts/lib/model-probation.mjs","functions": ["lookupPrWithGh"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["lookupPrWithGh#execFileSync#a6c7ee8eda187c42","lookupPrWithGh#execFileSync#a6c7ee8eda187c42"]},
  {"file": "scripts/lib/net-diff-fingerprint.mjs","functions": ["raw"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["raw#exec#ec5a619260ee6201"]},
  {"file": "scripts/lib/numbering-carry.mjs","functions": ["read"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["read#run#57a3794ed425828c"]},
  {"file": "scripts/lib/open-pr-items.mjs","functions": ["ghRun"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["ghRun#spawnSync#3457612eb5b80523"]},
  {"file": "scripts/lib/operator-identity.mjs","functions": ["resolveOperatorIdentity"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["resolveOperatorIdentity#run#2d3a42112eda03ba"]},
  {"file": "scripts/lib/output-mix.mjs","functions": ["computeOutputMix"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["computeOutputMix#execFileSync#00aebb8353536b71"]},
  {"file": "scripts/lib/overlay-adoption.mjs","functions": ["defaultIsAncestor"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultIsAncestor#spawnSync#718a9872fe5809cb"]},
  {"file": "scripts/lib/pid-alive.mjs","functions": ["pidStartTime","readPidIdentity"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["pidStartTime#exec#19ea126dade0f6e8","readPidIdentity#exec#25d540669fc053ed"]},
  {"file": "scripts/lib/pr-merge-gate.mjs","functions": ["mergePr","retargetStackedPrs"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["mergePr#withRuntimeProcessAdmission#3ded0485cc8c1dc0","retargetStackedPrs#withRuntimeProcessAdmission#56d99d07b4456b11","retargetStackedPrs#withRuntimeProcessAdmission#56d99d07b4456b11"]},
  {"file": "scripts/lib/pr-size-admission.mjs","functions": ["createGitReader/callback","fileSplitItem"],"status": "readonly","reason": "Reads Git evidence and files split-work backlog cards.","calls": ["createGitReader/callback#exec#78fbcb481cb7ec6c","fileSplitItem#execFileSync#86fd1626281faacd"]},
  {"file": "scripts/lib/pr-snapshot.mjs","functions": ["detachedRefresh"],"status": "readonly","reason": "Refreshes the GitHub PR evidence cache; never dispatches a worker.","calls": ["detachedRefresh#spawn#eb3bd442a62002da"]},
  {"file": "scripts/lib/proc-read.mjs","functions": ["execRead"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["execRead#exec#173eb759537bde86"]},
  {"file": "scripts/lib/queue-branch-numbering.mjs","functions": ["drainNumberedPairs","mainAcceptsBranchNumbering","probeQueuedLand","run","safeGit/callback","trustedDrainAuthors"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["drainNumberedPairs#exec#da504b445b597cb2","mainAcceptsBranchNumbering#exec#4cab75a30ae24e3b","probeQueuedLand#exec#d6e6053f147ea91f","probeQueuedLand#exec#d6e6053f147ea91f","run#exec#ec3ec3e35bf89a42","safeGit/callback#exec#e3cdf3832b417003","trustedDrainAuthors#exec#b9b5cb275d0fd7f7"]},
  {"file": "scripts/lib/queue-file-overlap.mjs","functions": ["readQueueEntryFiles/callback"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["readQueueEntryFiles/callback#exec#05154ae0465f5ff5"]},
  {"file": "scripts/lib/red-main-freeze-shared.mjs","functions": ["graphql","timedGit/callback"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["graphql#exec#3f52e1d88fd59fda","timedGit/callback#exec#6aefc1e5cd83033d"]},
  {"file": "scripts/lib/red-main-quarantine-io.mjs","functions": ["git","readFailedJobs","readJobFailures","rerunRedMainFailedJobs"],"status": "readonly","reason": "Reads CI evidence and reruns existing failed diagnostic jobs.","calls": ["git#execFileSync#8f10d3b52b3eed2f","readFailedJobs#exec#57e9d4240203eee9","readJobFailures#exec#14442b52f0afb13e","rerunRedMainFailedJobs#exec#b46f9dbccad295da","rerunRedMainFailedJobs#exec#b46f9dbccad295da"]},
  {"file": "scripts/lib/referral-card-readable.mjs","functions": ["gh","git"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["gh#run#493f98f3dcba53c7","git#run#4ebc47d848a2acb3"]},
  {"file": "scripts/lib/renamed-pr-refresh.mjs","functions": ["git","readOwedMainRule"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["git#run#16df31067819f843","readOwedMainRule#exec#9ab579df8d1f6992","readOwedMainRule#exec#9ab579df8d1f6992"]},
  {"file": "scripts/lib/required-status-checks.mjs","functions": ["spawn"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["spawn#spawnSync#09638dce4c325052"]},
  {"file": "scripts/lib/restack-equivalence.mjs","functions": ["git"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["git#exec#e5451151c9117730"]},
  {"file": "scripts/lib/round-judge-verify.mjs","functions": ["makeGitRepo/callback"],"status": "readonly","reason": "Reads/tests a diagnostic judge fixture in a temporary Git repository.","calls": ["makeGitRepo/callback#execFileSync#3de4811f983c737a"]},
  {"file": "scripts/lib/salvage-index.mjs","functions": ["git"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["git#execFileSync#beeaea357cb1e4f9"]},
  {"file": "scripts/lib/spawn-to-completion.mjs","functions": ["spawnToCompletion/callback"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["spawnToCompletion/callback#withRuntimeProcessAdmission#07177b37ed4097e9"]},
  {"file": "scripts/lib/tools-root-guard.mjs","functions": ["appendEventSync","maybeReexecFromToolsRoot"],"status": "readonly","reason": "Files guard diagnostics and relocates the current CLI to the tools root.","calls": ["appendEventSync#nativeSpawnSync#85596eebaf43ea1c","maybeReexecFromToolsRoot#spawnSync#0a0ff7a9e20cac81"]},
  {"file": "scripts/lib/tools-root.mjs","functions": ["git"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["git#spawnSync#880cf9fab4a7bebe"]},
  {"file": "scripts/lib/verdict-ledger-io.mjs","functions": ["defaultExec"],"status": "readonly","reason": "Reads and appends the verdict ledger.","calls": ["defaultExec#execFileSync#b0865785fc22e616"]},
  {"file": "scripts/lib/verdict-ledger.mjs","functions": ["probeOrigin"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["probeOrigin#run#873e2f42ec2d5e09"]},
  {"file": "scripts/merge-ai-prs.mjs","functions": ["add","addOnce","ancestryNetDiff","applyCiLifecycleLabelPlan","at","computeNetDiffChangedFiles","computeNetDiffPaths","computeNetDiffText","enqueueAllowed","exec","fetchPrComments","gh","git","isStrictAncestor","memoRepo","postDrainReasonComment","pushNumberingOnLand","readDrainAcceptance","readFormalReviews/callback","readLiveDrainCarryEvidence","readLiveDrainCarryEvidence/callback","readOperatorOverride","readRemoteManifestViaApi","reconcileCiLifecycleLabels","reconcileDrainReviewPending","regenDerivedOnLand","removeDeescalatedHumanLabels","resolveNetDiffBasis","resolveRequiredCheck","restampAcceptance","resyncDetachedCwdForLand","run","spawnReviewSetLabel","stripReadyOnPark","sweepOnce","upsertHeldParkComment","write"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["add#withRuntimeProcessAdmission#7f89c8bd0b7a7157","addOnce#withRuntimeProcessAdmission#239c4381ee8da17d","ancestryNetDiff#withRuntimeProcessAdmission#cf6c9b45e8f48a69","applyCiLifecycleLabelPlan#withRuntimeProcessAdmission#6fa15e3e7a2f556f","at#withRuntimeProcessAdmission#2b0b2ded5469bc65","computeNetDiffChangedFiles#withRuntimeProcessAdmission#9edfea9d6e2c96ab","computeNetDiffPaths#withRuntimeProcessAdmission#49d95b82d10045a1","computeNetDiffText#withRuntimeProcessAdmission#3caab0d34f48294f","computeNetDiffText#withRuntimeProcessAdmission#3caab0d34f48294f","computeNetDiffText#withRuntimeProcessAdmission#3caab0d34f48294f","enqueueAllowed#withRuntimeProcessAdmission#93edc6a5d02fe4b0","exec#withRuntimeProcessAdmission#17fd56f83cc0be3e","exec#withRuntimeProcessAdmission#360f9d8560db4715","exec#withRuntimeProcessAdmission#360f9d8560db4715","exec#withRuntimeProcessAdmission#371721b61782de2f","exec#withRuntimeProcessAdmission#716110156174117f","exec#withRuntimeProcessAdmission#716110156174117f","fetchPrComments#withRuntimeProcessAdmission#79015abad405696d","gh#withRuntimeProcessAdmission#954d355941bb5462","git#withRuntimeProcessAdmission#19b111a2c735e2e0","isStrictAncestor#withRuntimeProcessAdmission#91ec8cf9db44ffb4","isStrictAncestor#withRuntimeProcessAdmission#91ec8cf9db44ffb4","isStrictAncestor#withRuntimeProcessAdmission#91ec8cf9db44ffb4","memoRepo#withRuntimeProcessAdmission#14d304e32cdd5b4d","postDrainReasonComment#withRuntimeProcessAdmission#09e7b5c2552d3a57","pushNumberingOnLand#withRuntimeProcessAdmission#60e03e8513a70e3a","readDrainAcceptance#withRuntimeProcessAdmission#2fec127688670cd7","readFormalReviews/callback#withRuntimeProcessAdmission#aefc857c01c7f4d6","readLiveDrainCarryEvidence#withRuntimeProcessAdmission#a623e52dac1c23dd","readLiveDrainCarryEvidence/callback#withRuntimeProcessAdmission#dd28c61ce00183ee","readOperatorOverride#withRuntimeProcessAdmission#f5f302d91aa19e09","readRemoteManifestViaApi#withRuntimeProcessAdmission#e157e517462a5f54","reconcileCiLifecycleLabels#withRuntimeProcessAdmission#16700ea7856b59e6","reconcileDrainReviewPending#withRuntimeProcessAdmission#a231ce4ee5a474e4","regenDerivedOnLand#withRuntimeProcessAdmission#7aecb3b5151774e2","regenDerivedOnLand#withRuntimeProcessAdmission#7aecb3b5151774e2","regenDerivedOnLand#withRuntimeProcessAdmission#7aecb3b5151774e2","regenDerivedOnLand#withRuntimeProcessAdmission#7aecb3b5151774e2","regenDerivedOnLand#withRuntimeProcessAdmission#7aecb3b5151774e2","removeDeescalatedHumanLabels#withRuntimeProcessAdmission#dcfcbfbe5e048911","resolveNetDiffBasis#withRuntimeProcessAdmission#048ff9f40131465e","resolveNetDiffBasis#withRuntimeProcessAdmission#048ff9f40131465e","resolveNetDiffBasis#withRuntimeProcessAdmission#048ff9f40131465e","resolveRequiredCheck#withRuntimeProcessAdmission#45c4f06ffce81648","restampAcceptance#withRuntimeProcessAdmission#fe766c81c2de6b57","resyncDetachedCwdForLand#withRuntimeProcessAdmission#8c746986f864f267","resyncDetachedCwdForLand#withRuntimeProcessAdmission#8c746986f864f267","resyncDetachedCwdForLand#withRuntimeProcessAdmission#8c746986f864f267","resyncDetachedCwdForLand#withRuntimeProcessAdmission#8c746986f864f267","resyncDetachedCwdForLand#withRuntimeProcessAdmission#8c746986f864f267","run#withRuntimeProcessAdmission#b09df5502e7b7c3f","spawnReviewSetLabel#withRuntimeProcessAdmission#1dc5df797971c328","stripReadyOnPark#withRuntimeProcessAdmission#9892ddec297f3bc5","sweepOnce#withRuntimeProcessAdmission#84147b7d6d294920","sweepOnce#withRuntimeProcessAdmission#84147b7d6d294920","sweepOnce#withRuntimeProcessAdmission#84147b7d6d294920","upsertHeldParkComment#withRuntimeProcessAdmission#c5dc3ef3cb559f65","upsertHeldParkComment#withRuntimeProcessAdmission#c5dc3ef3cb559f65","write#withRuntimeProcessAdmission#59fad5db5f449f2a"]},
  {"file": "scripts/operations/build-dispatch-hold-route-land.mjs","functions": ["runCmd"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["runCmd#withRuntimeProcessAdmission#4ce19fc482be9c15"]},
  {"file": "scripts/operations/card-batch-file.mjs","functions": ["git","launchSealJob"],"status": "readonly","reason": "Files/seals backlog batches; never starts a delivery agent.","calls": ["git#execFileSync#5be73ef3484d2309","launchSealJob#spawn#a710d03147c715bc"]},
  {"file": "scripts/operations/card-batch-io.mjs","functions": ["gitIn/callback"],"status": "readonly","reason": "Git transport for backlog batch filing.","calls": ["gitIn/callback#execFileSync#91436b73f998f779"]},
  {"file": "scripts/operations/deliver-item-wrapper.mjs","functions": ["fix/callback","resumeAgentWithGateFailure/callback","runAgentToCompletion/callback"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["fix/callback#withRuntimeProcessAdmission#71e122452e5f8aa9","resumeAgentWithGateFailure/callback#withRuntimeProcessAdmission#fb07dd92e8c0edbd","runAgentToCompletion/callback#withRuntimeProcessAdmission#5cfd1a6ac257c100"]},
  {"file": "scripts/operations/detached-dispatch.mjs","functions": ["defaultSpawnDetached/callback"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["defaultSpawnDetached/callback#spawn#3395e81e801c9c7d"]},
  {"file": "scripts/operations/detached-dispatch.mjs","functions": ["defaultSpawnDiagnosticDetached"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultSpawnDiagnosticDetached#spawn#0d83c71496e51e67"]},
  {"file": "scripts/operations/dispatch-lane-io.mjs","functions": ["defaultCheckAlreadyDone","defaultCheckAlreadyDoneAsync","defaultLaneRefForPr","defaultListPrs","defaultRunNode","execFileThrottledAsync","fetch","launchAttempt/callback","releaseReservedLane","reserveBuildLane/callback"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["defaultCheckAlreadyDone#withRuntimeProcessAdmission#879628c7bc2010cb","defaultCheckAlreadyDone#withRuntimeProcessAdmission#879628c7bc2010cb","defaultCheckAlreadyDoneAsync#withRuntimeProcessAdmission#668b8adb1dad4ecd","defaultCheckAlreadyDoneAsync#withRuntimeProcessAdmission#668b8adb1dad4ecd","defaultCheckAlreadyDoneAsync#withRuntimeProcessAdmission#668b8adb1dad4ecd","defaultLaneRefForPr#withRuntimeProcessAdmission#8463b9885978bbc9","defaultListPrs#withRuntimeProcessAdmission#d369c56e303fb5de","defaultRunNode#withRuntimeProcessAdmission#0839cab4fff88471","execFileThrottledAsync#withRuntimeProcessAdmission#bb16d1e5a7e74eab","fetch#withRuntimeProcessAdmission#f36c3240408d4305","launchAttempt/callback#exec#f4c5e781fe07ffc6","releaseReservedLane#withRuntimeProcessAdmission#d7f3fda9fbd57ecb","reserveBuildLane/callback#run#acd9eb5230ab44e1"]},
  {"file": "scripts/operations/free-scope-io.mjs","functions": ["ghExec/callback","gitExec/callback"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["ghExec/callback#execFileSync#f01a1f27178ba6e2","gitExec/callback#execFileSync#63ba7c5fe68acc0f"]},
  {"file": "scripts/operations/handoff-home.mjs","functions": ["defaultGit","ghVisibility"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["defaultGit#withRuntimeProcessAdmission#4c7fbeff52157a04","ghVisibility#withRuntimeProcessAdmission#19df34a8c12c649e"]},
  {"file": "scripts/operations/heavy-queue-io.mjs","functions": ["gitIsAncestor","readProcessCommand"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["gitIsAncestor#exec#b1827659fe0773ce","readProcessCommand#exec#f16eab36fe06bf18"]},
  {"file": "scripts/operations/land-prevention-card.mjs","functions": ["defaultExec","drainPendingPrevention","exec","foldOpenSingles","landPreventionCard","postLandingRetraction"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["defaultExec#withRuntimeProcessAdmission#81554a286894603c","drainPendingPrevention#withRuntimeProcessAdmission#47f5f8379058fa81","exec#withRuntimeProcessAdmission#c95fe72cff6661aa","foldOpenSingles#withRuntimeProcessAdmission#f1f234584ec78af7","foldOpenSingles#withRuntimeProcessAdmission#f1f234584ec78af7","foldOpenSingles#withRuntimeProcessAdmission#f1f234584ec78af7","foldOpenSingles#withRuntimeProcessAdmission#f1f234584ec78af7","landPreventionCard#withRuntimeProcessAdmission#ab8a469bc5303ff3","landPreventionCard#withRuntimeProcessAdmission#ab8a469bc5303ff3","landPreventionCard#withRuntimeProcessAdmission#ab8a469bc5303ff3","landPreventionCard#withRuntimeProcessAdmission#ab8a469bc5303ff3","landPreventionCard#withRuntimeProcessAdmission#ab8a469bc5303ff3","landPreventionCard#withRuntimeProcessAdmission#ab8a469bc5303ff3","landPreventionCard#withRuntimeProcessAdmission#ab8a469bc5303ff3","landPreventionCard#withRuntimeProcessAdmission#ab8a469bc5303ff3","landPreventionCard#withRuntimeProcessAdmission#ab8a469bc5303ff3","landPreventionCard#withRuntimeProcessAdmission#ab8a469bc5303ff3","postLandingRetraction#withRuntimeProcessAdmission#482dbe220f6c66c6"]},
  {"file": "scripts/operations/minimal-context-provider.mjs","functions": ["run","tryGitToplevel"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["run#withRuntimeProcessAdmission#6758adc66bfcaf0d","tryGitToplevel#withRuntimeProcessAdmission#7bc06d0c86ef22b0"]},
  {"file": "scripts/operations/needs-you-feed.mjs","functions": ["readLivePr","runOnce"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["readLivePr#gh#31f72e5c3e59a460","readLivePr#gh#31f72e5c3e59a460","runOnce#exec#10043ea606c2532e","runOnce#gh#10043ea606c2532e"]},
  {"file": "scripts/operations/probation-heal-run.mjs","functions": ["readComments","sh"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["readComments#withRuntimeProcessAdmission#408a9e990df29113","sh#withRuntimeProcessAdmission#b753e7c00f8a6cac"]},
  {"file": "scripts/operations/record-verdict-io.mjs","functions": ["defaultGit","defaultOriginRepo"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["defaultGit#execFileSync#b7e10895a7ad33ce","defaultOriginRepo#execFileSync#d16af1e777e91fa1"]},
  {"file": "scripts/operations/resolve-io.mjs","functions": ["git"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["git#exec#201d730f37104a8c"]},
  {"file": "scripts/operations/review-pr-io.mjs","functions": ["[REVIEW_EFFECTS.MANDATORY_REFERRALS]/callback","execFileIn/callback","ghPrView","runNode"],"status": "readonly","reason": "Reads review/PR evidence, publishes review diagnostics and files referrals.","calls": ["[REVIEW_EFFECTS.MANDATORY_REFERRALS]/callback#execFileSyncThrottled#27c0a3b2830ac1fb","execFileIn/callback#execFileSync#cb34b0a932496b91","ghPrView#execFileSync#70615c44784922c5","runNode#execFileSync#6c4e0716f7ca5871"]},
  {"file": "scripts/operations/telemetry-summary-io.mjs","functions": ["readHazardFacts"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["readHazardFacts#execFileSync#91042f217c9319f3"]},
  {"file": "scripts/operations/verify-io.mjs","functions": ["createChecksRunner/callback"],"status": "readonly","reason": "Runs verification checks and returns their diagnostics.","calls": ["createChecksRunner/callback#spawn#e4b9d9e020efe480"]},
  {"file": "scripts/operations/worker-wrapper.mjs","functions": ["launch","launchDetached/callback","spawnWithPid/callback"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["launch#withRuntimeProcessAdmission#2eb286ff7c4df544","launchDetached/callback#spawnFn#059faf0cff059bb6","spawnWithPid/callback#spawnFn#7f47ed81c1c94270"]},
  {"file": "scripts/progress-board.mjs","functions": ["ghPrList"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["ghPrList#execFileSync#91a545e428cdf05f"]},
  {"file": "scripts/readiness/drain-lock.mjs","functions": ["localRepoSlug"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["localRepoSlug#exec#95c30fa369a22b88"]},
  {"file": "scripts/readiness/forge-run-finish.mjs","functions": ["createRunFinisher/callback/callback"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["createRunFinisher/callback/callback#exec#64038fbfa5ac5b5e"]},
  {"file": "scripts/readiness/heavy-admission.mjs","functions": ["defaultExec","execWithRunCeiling/callback","readSha/callback"],"status": "readonly","reason": "Runs host/capacity probes and admitted verification commands; delivery agents use separate launch ports.","calls": ["defaultExec#execSync#f8286a0e1c4adba8","execWithRunCeiling/callback#spawn#ddf40d30e3ccf71f","execWithRunCeiling/callback#spawn#ddf40d30e3ccf71f","readSha/callback#execFile#c41aa8e626cf3d49"]},
  {"file": "scripts/readiness/host-capacity.mjs","functions": ["probe","readForge"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["probe#exec#d05bd8247dc7e795","readForge#exec#7a16f4e3e968d3be"]},
  {"file": "scripts/readiness/scope-lease-collect.mjs","functions": ["readPoolStatus/callback"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["readPoolStatus/callback#execFileSync#60c06bc50bd7d3af"]},
  {"file": "scripts/readiness/test-selection.mjs","functions": ["realGit","vitestRelatedSelectedFiles"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["realGit#execFileSync#8798a1e80bcfb0a6","vitestRelatedSelectedFiles#execFileSync#d0fcc5629fc0ec12"]},
  {"file": "scripts/review-detail.mjs","functions": ["runCli"],"status": "readonly","reason": "Invokes the review-detail diagnostic CLI.","calls": ["runCli#execFileSync#9962a443e391ec72"]},
  {"file": "scripts/review-set-label.mjs","functions": ["defaultAbstainResume"],"status": "readonly","reason": "Updates review metadata and resumes the review lifecycle; no delivery/fix worker.","calls": ["defaultAbstainResume#spawnSync#1d1b12823c7a7a25"]},
  {"file": "skills-src/conveyor/build-dispatch-daemon.mjs","functions": ["cliDispatch/callback","cliRetryInfraBlocked/callback"],"status": "gated","reason": "Final admission at the work port or eager native transport, inheriting the full delivery identity.","calls": ["cliDispatch/callback#exec#2690938bff873073","cliRetryInfraBlocked/callback#exec#8563f02e3a5b8769"]},
  {"file": "skills-src/conveyor/build-dispatch-daemon.mjs","functions": ["cliPlanTick","defaultExecAsync/callback","defaultReadLanePool/callback","ghPrList","git","launchBase","loadBlobs","read","readTree","run"],"status": "readonly","reason": "Reads Git/GitHub/lane state, refreshes discovery refs, or files diagnostic backlog cards.","calls": ["cliPlanTick#exec#f7a46d018d4ef733","defaultExecAsync/callback#run#c178277caec4a254","defaultReadLanePool/callback#execFile#1610ec3bc879ab6f","ghPrList#exec#a08fae3e4f5d9a7a","git#run#b9fec7486cc1ed60","launchBase#execFileSync#546526310c1e7994","loadBlobs#exec#e821042a532f58e7","read#exec#b9aa960fdb981bf3","readTree#exec#f3ce4f9cefc3222a","run#exec#d30111b8629ffdc3"]},
  {"file": "skills-src/conveyor/verify-daemon.mjs","functions": ["readCommand","readHead"],"status": "readonly","reason": "Reads Git/GitHub/process evidence or maintains diagnostic/ledger metadata; no delivery worker is dispatched.","calls": ["readCommand#execFileSync#2513a0bc59770e49","readHead#execFileSync#c10d30a36be5466a"]}
];

function inventoryProblems(modules, inventory) {
  const problems = [];
  const files = new Set(modules.map(row => row.file));
  for (const row of modules) {
    const entries = inventory.filter(entry => entry.file === row.file);
    if (!entries.length) { problems.push(`unlisted process module: ${row.file}`); continue; }
    const covered = new Set();
    for (const entry of entries) {
      if (!['gated', 'readonly'].includes(entry.status) || !entry.reason?.trim()) problems.push(`invalid classification: ${row.file}`);
      const sites = row.sites.filter(site => entry.functions.includes(site.owner)
        && (entry.status === 'readonly' ? row.bypasses.includes(site) : true));
      if (entry.status === 'gated' && sites.some(site => row.bypasses.includes(site))) problems.push(`unguarded process sites: ${row.file}`);
      for (const site of sites) {
        if (covered.has(site)) problems.push(`duplicate process classification: ${row.file}`);
        covered.add(site);
      }
      const functions = [...new Set(sites.map(site => site.owner))].sort();
      const calls = sites.map(site => `${site.owner}#${site.call}#${site.signature}`).sort();
      if (JSON.stringify(functions) !== JSON.stringify(entry.functions) || JSON.stringify(calls) !== JSON.stringify(entry.calls)) problems.push(`stale process sites: ${row.file}`);
    }
    if (covered.size !== row.sites.length) problems.push(`unlisted process functions: ${row.file}`);
  }
  for (const entry of inventory) if (!files.has(entry.file)) problems.push(`stale process module: ${entry.file}`);
  return problems;
}
it('exhaustively inventories the static delivery closure, with no missing, stale or ungated process sites', () => {
  expect(inventoryProblems(processModules(root, deliveryEntries), processInventory)).toEqual([]);
});
it('a synthetic new wrapper reached by a static re-export cannot escape the inventory', () => {
  const tree = mkdtempSync(join(tmpdir(), 'delivery-import-closure-'));
  try {
    mkdirSync(join(tree, 'wrappers'));
    writeFileSync(join(tree, 'entry.mjs'), "export { launch } from './wrappers/bridge.mjs';\nimport 'node:fs';\nimport 'npm-package';");
    writeFileSync(join(tree, 'wrappers/bridge.mjs'), "export { launch } from './new-wrapper.mjs';\nimport '../entry.mjs';");
    writeFileSync(join(tree, 'wrappers/new-wrapper.mjs'), "import { spawn as newName } from 'node:child_process'; export function launch() { newName('agent', []); }");
    const modules = processModules(tree, ['entry.mjs']);
    expect([...staticImportClosure(tree, ['entry.mjs']).keys()].sort()).toEqual(['entry.mjs', 'wrappers/bridge.mjs', 'wrappers/new-wrapper.mjs']);
    expect(inventoryProblems(modules, [])).toEqual(['unlisted process module: wrappers/new-wrapper.mjs']);
    expect(modules[0].bypasses).toHaveLength(1);
    const classified = [{ file: modules[0].file, functions: ['launch'], calls: ['launch#newName'], status: 'gated', reason: 'Delivery launcher.' }];
    expect(inventoryProblems(modules, classified)[0]).toMatch(/unguarded process sites/);
    expect(inventoryProblems([], classified)).toEqual(['stale process module: wrappers/new-wrapper.mjs']);
    writeFileSync(join(tree, 'wrappers/new-wrapper.mjs'), "import { execFileSync } from 'child_process'; export function launch() { execFileSync('git', ['rev-parse', 'HEAD']); }");
    const reads = processModules(tree, ['entry.mjs']);
    const readTable = reads.map(row => ({ file: row.file, functions: ['launch'], status: 'readonly', reason: 'Reads the Git head.',
      calls: row.sites.map(site => `${site.owner}#${site.call}#${site.signature}`).sort() }));
    expect(inventoryProblems(reads, readTable)).toEqual([]);
    writeFileSync(join(tree, 'wrappers/new-wrapper.mjs'), "import { execFileSync } from 'child_process'; export function launch() { execFileSync('delivery-worker', []); }");
    expect(inventoryProblems(processModules(tree, ['entry.mjs']), readTable)).toEqual(['stale process sites: wrappers/new-wrapper.mjs']);
    writeFileSync(join(tree, 'wrappers/new-wrapper.mjs'), "export { missing } from './missing.mjs';");
    expect(() => processModules(tree, ['entry.mjs'])).toThrow(/ENOENT/);
  } finally { rmSync(tree, { recursive: true, force: true }); }
});
it('rejects filesystem setup inside the admission callback before a process call', () => {
  expect(scan("withRuntimeAdmission(card, 'build', () => { writeSpec(); spawn('agent', []); });").bypasses).toHaveLength(1);
});

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

it.each([
  "import cp from 'child_process'; function launch() { cp.exec('agent'); }",
  "import * as cp from 'node:child_process'; const other = cp; function launch() { other['exec']('agent'); }",
  "import { spawn as start } from 'node:child_process'; const again = start; function launch() { again('agent'); }",
])('native closure scanner follows child-process aliases: %s', source => {
  expect(scan(source, true).bypasses).toHaveLength(1);
});

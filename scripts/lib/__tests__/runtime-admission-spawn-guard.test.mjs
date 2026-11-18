/** @repo-scanning-test scope=files */
import { it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
  const wrapper = callback?.parent;
  if (!wrapper || !ts.isCallExpression(wrapper) || wrapper.expression.getText() !== 'withRuntimeAdmission'
    || wrapper.arguments[2] !== callback) return null;
  // No file read, state write, or other effect may intervene inside the callback.
  let intervening = false;
  const visit = node => {
    const mutation = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    if (node !== call && node.getStart() < call.getStart()
      && (ts.isCallExpression(node) || ts.isAwaitExpression(node) || ts.isNewExpression(node) || mutation)) intervening = true;
    if (node !== call) ts.forEachChild(node, visit);
  };
  visit(callback.body);
  if (/^(?:spawn|spawnFn|nodeSpawn)$/.test(call.expression.getText())) {
    const argumentEffect = node => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node)) intervening = true;
      ts.forEachChild(node, argumentEffect);
    };
    call.arguments.forEach(argumentEffect);
  }
  return intervening ? null : wrapper;
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
const primitives = /^(?:execFileSync|execFile|exec|execSync|spawn|spawnFn|nodeSpawn|spawnSync|fork|execFileSyncThrottled|execFileThrottledAsync|execFileFn|execAsync|runNode|defaultRunNode|spawnAgent|defaultSpawnAgent|spawnAgentToCompletion|spawnToCompletion|spawnResumeDelivery|routeDispatchProvider|defaultClaudeProvider|launchWrappedClaudeWorker|launchWrapped|probationWorkerDetachedProvider|agent|run|defaultExecAsync|probation|launchAgent)$/;
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

// Explicitly audited process users in the delivery entry-point static import closure.
// readonly includes maintenance and shared transports: it does not mean zero writes.
const processInventory = [
  {"file": "scripts/conveyor/build-dispatch-hold-router.mjs", "status": "gated", "reason": "Routes held cards through admitted landing effects."},
  {"file": "scripts/lib/prevention-landing-job.mjs", "status": "readonly", "reason": "Files diagnostic prevention cards through defaultSpawnDiagnosticDetached; no delivery agent."},
  {"file": "scripts/operations/dispatch-providers/build.mjs", "status": "gated", "reason": "Launches admitted build delivery work through the detached spawner."},
  {"file": "scripts/operations/dispatch-providers/fix.mjs", "status": "gated", "reason": "Launches admitted fix delivery work through the detached spawner."},
  {"file": "scripts/operations/dispatch-providers/ci-heal.mjs", "status": "gated", "reason": "Launches admitted ci-heal delivery work through the detached spawner."},
  {"file": "scripts/operations/dispatch-providers/prepare.mjs", "status": "gated", "reason": "Launches admitted prepare delivery work through the detached spawner."},
  {"file": "scripts/operations/dispatch-providers/prepare-decision.mjs", "status": "gated", "reason": "Launches admitted prepare-decision delivery work through the detached spawner."},
  {"file": "scripts/operations/dispatch-providers/probation-worker.mjs", "status": "gated", "reason": "Launches admitted probation-worker delivery work through the detached spawner."},
  { file: 'scripts/lib/gh-app-shim.mjs', status: 'readonly', reason: 'Generates credential and throttle shims; no delivery launch owner.' },
  {"file": "scripts/backlog-stranded-sweep.mjs", "status": "readonly", "reason": "Reads backlog Git history and merged PR evidence."},
  {"file": "scripts/bootstrap-session.mjs", "status": "readonly", "reason": "Bootstraps checkout dependencies; no delivery dispatch."},
  {"file": "scripts/ci-card-only.mjs", "status": "readonly", "reason": "Reads CI diff evidence to classify card-only changes."},
  {"file": "scripts/codex-direct-task.mjs", "status": "readonly", "reason": "Shared direct-task transport, including review jobs; conveyor dispatch owns admission."},
  {"file": "scripts/conveyor/advisory-fix-mark.mjs", "status": "readonly", "reason": "Maintains advisory fix markers on existing PRs."},
  {"file": "scripts/conveyor/await-verify.mjs", "status": "readonly", "reason": "Reads verification evidence for existing sessions."},
  {"file": "scripts/conveyor/branch-sync.mjs", "status": "readonly", "reason": "Maintains branch state and sends desktop notifications."},
  {"file": "scripts/conveyor/build-delivery-evidence.mjs", "status": "readonly", "reason": "Reads commit and delivery evidence."},
  {"file": "scripts/conveyor/build-dispatch-orphan-adopt.mjs", "status": "gated", "reason": "Launches orphan recovery with persisted groups; reads lane leases and releases failed reservations."},
  {"file": "scripts/conveyor/ci-heal-escalation-mark.mjs", "status": "readonly", "reason": "Records escalation markers for existing CI-heal attempts."},
  {"file": "scripts/conveyor/ci-heal-mark.mjs", "status": "readonly", "reason": "Files CI-heal completion markers, not new healing work."},
  {"file": "scripts/conveyor/ci-heal-owed.mjs", "status": "readonly", "reason": "Reads persisted CI-heal obligations."},
  {"file": "scripts/conveyor/driver-watchdog.mjs", "status": "readonly", "reason": "Observes existing driver processes."},
  {"file": "scripts/conveyor/fix-dispatch-claim.mjs", "status": "readonly", "reason": "Reads PR heads when checking fix ownership."},
  {"file": "scripts/conveyor/fix-procedure.mjs", "status": "readonly", "reason": "Pushes the current fixer result; does not dispatch a new worker."},
  {"file": "scripts/conveyor/fix-push-ci.mjs", "status": "readonly", "reason": "Reads CI evidence for an existing fixer push."},
  {"file": "scripts/conveyor/infra-blocked.mjs", "status": "gated", "reason": "Gated recovery entry points; other subprocesses read Git evidence."},
  {"file": "scripts/conveyor/land-overlap-yield.mjs", "status": "readonly", "reason": "Reads overlapping landing claims."},
  {"file": "scripts/conveyor/lease-reaper.mjs", "status": "readonly", "reason": "Reads process identity and reaps existing leases."},
  {"file": "scripts/conveyor/mechanical-round-cap.mjs", "status": "readonly", "reason": "Reads PR state to enforce existing repair caps."},
  {"file": "scripts/conveyor/pending-launches.mjs", "status": "gated", "reason": "Launches detached delivery or prepare commands after log setup."},
  {"file": "scripts/conveyor/pr-stack.mjs", "status": "readonly", "reason": "Reads Git ancestry and open PR refs."},
  {"file": "scripts/conveyor/pr-watch.mjs", "status": "readonly", "reason": "Reconciles existing PRs and releases finished lane leases."},
  {"file": "scripts/conveyor/prepare-failure-policy.mjs", "status": "readonly", "reason": "Reads ancestry of failed prepare attempts."},
  {"file": "scripts/conveyor/queue-prune.mjs", "status": "readonly", "reason": "Reads queued PR state for pruning."},
  {"file": "scripts/conveyor/reconcile-note-comment.mjs", "status": "readonly", "reason": "Maintains reconciliation comments on existing PRs."},
  {"file": "scripts/conveyor/referral-reverify.mjs", "status": "readonly", "reason": "Reads referral head evidence and records reverify comments."},
  {"file": "scripts/conveyor/resolve-runner-checkout.mjs", "status": "readonly", "reason": "Reads runner process command and working directory."},
  {"file": "scripts/conveyor/review-churn.mjs", "status": "readonly", "reason": "Reads review churn evidence on existing PRs."},
  {"file": "scripts/conveyor/review-referral-hold.mjs", "status": "readonly", "reason": "Reads and records referral holds on existing PRs."},
  {"file": "scripts/conveyor/review-stack-base.mjs", "status": "readonly", "reason": "Reads review-base ancestry and PR evidence."},
  {"file": "scripts/conveyor/run-scorecard-store.mjs", "status": "readonly", "reason": "Reads Git history for scorecard persistence."},
  {"file": "scripts/conveyor/stand-down.mjs", "status": "readonly", "reason": "Reads PR diff and updates stand-down labels."},
  {"file": "scripts/conveyor/standing-ruling-io.mjs", "status": "readonly", "reason": "Reads and mirrors standing ruling evidence."},
  {"file": "scripts/conveyor/tick-core.mjs", "status": "gated", "reason": "Gates tick dispatch effects; also reads lane capacity, PR comments and admission queue status."},
  {"file": "scripts/conveyor/verify-dispatch.mjs", "status": "readonly", "reason": "Starts verification jobs for existing work, not delivery workers."},
  {"file": "scripts/guard-bash.mjs", "status": "readonly", "reason": "Reads local Git divergence for command policy."},
  {"file": "scripts/lane-drain.mjs", "status": "readonly", "reason": "Merge and lane maintenance CLI; not a delivery admission owner."},
  {"file": "scripts/lib/antigravity-judge-spawn.mjs", "status": "readonly", "reason": "Shared bounded judge transport; no conveyor delivery dispatch."},
  {"file": "scripts/lib/auto-land-seam.mjs", "status": "readonly", "reason": "Updates existing PR review labels."},
  {"file": "scripts/lib/bounded-child.mjs", "status": "readonly", "reason": "Shared bounded subprocess transport and process-tree reads."},
  {"file": "scripts/lib/card-group.mjs", "status": "readonly", "reason": "Reads existing grouped card evidence."},
  {"file": "scripts/lib/card-number-allocator.mjs", "status": "readonly", "reason": "Allocates ledger numbers; no delivery launch."},
  {"file": "scripts/lib/card-number-ledger.mjs", "status": "readonly", "reason": "Reads and maintains the card-number ledger."},
  {"file": "scripts/lib/claude-account.mjs", "status": "readonly", "reason": "Reads the account credential from the keychain."},
  {"file": "scripts/lib/clone-maintenance.mjs", "status": "readonly", "reason": "Runs Git maintenance on a clone."},
  {"file": "scripts/lib/codex-judge-spawn.mjs", "status": "readonly", "reason": "Shared bounded judge transport; no conveyor delivery dispatch."},
  {"file": "scripts/lib/conflict-finding.mjs", "status": "readonly", "reason": "Reads conflict evidence for existing work."},
  {"file": "scripts/lib/container-exec.mjs", "status": "readonly", "reason": "Shared container execution and availability probes."},
  {"file": "scripts/lib/daemon-background-build.mjs", "status": "readonly", "reason": "Builds daemon code, not backlog delivery work."},
  {"file": "scripts/lib/daemon-clone-card-salvage.mjs", "status": "readonly", "reason": "Salvages card files in a daemon checkout."},
  {"file": "scripts/lib/daemon-clone-lock.mjs", "status": "readonly", "reason": "Runs clone maintenance under the clone lock."},
  {"file": "scripts/lib/daemon-job-snapshots.mjs", "status": "readonly", "reason": "Archives job code and installs its dependencies."},
  {"file": "scripts/lib/daemon-jobs-runtime.mjs", "status": "readonly", "reason": "Runs registered daemon infrastructure jobs, not delivery admission."},
  {"file": "scripts/lib/daemon-overlays.mjs", "status": "readonly", "reason": "Reads overlay Git origin and GitHub evidence."},
  {"file": "scripts/lib/daemon-rebuild/advisory-merge.mjs", "status": "readonly", "reason": "Checks syntax of a daemon merge candidate."},
  {"file": "scripts/lib/daemon-rebuild/auto-rebase.mjs", "status": "readonly", "reason": "Rebases daemon overlays, not delivery cards."},
  {"file": "scripts/lib/daemon-rebuild/candidate.mjs", "status": "readonly", "reason": "Reads the daemon candidate Git origin."},
  {"file": "scripts/lib/daemon-rebuild/edge-fetch.mjs", "status": "readonly", "reason": "Reads and fetches daemon overlay refs."},
  {"file": "scripts/lib/daemon-rebuild/lease.mjs", "status": "readonly", "reason": "Reads process start time for daemon rebuild leases."},
  {"file": "scripts/lib/daemon-rebuild/preview.mjs", "status": "readonly", "reason": "Creates temporary bare repositories for daemon previews."},
  {"file": "scripts/lib/daemon-rebuild/rebuild-job.mjs", "status": "readonly", "reason": "Starts a daemon rebuild infrastructure child."},
  {"file": "scripts/lib/daemon-rebuild/rebuild.mjs", "status": "readonly", "reason": "Probes the rebuilt daemon import graph."},
  {"file": "scripts/lib/daemon-rebuild/skip-unrelated.mjs", "status": "readonly", "reason": "Reads tracked files for daemon rebuild selection."},
  {"file": "scripts/lib/daemon-version-state.mjs", "status": "readonly", "reason": "Reads Git state for daemon version tracking."},
  {"file": "scripts/lib/daemon-version.mjs", "status": "readonly", "reason": "Reads daemon version Git metadata."},
  {"file": "scripts/lib/drain-api-reads.mjs", "status": "readonly", "reason": "Reads repository origins for merge evidence."},
  {"file": "scripts/lib/drain-followup-job.mjs", "status": "readonly", "reason": "Runs merge follow-up bookkeeping, not delivery dispatch."},
  {"file": "scripts/lib/drain-gh-async.mjs", "status": "readonly", "reason": "Shared GitHub merge-evidence transport."},
  {"file": "scripts/lib/drain-merge-strategy.mjs", "status": "readonly", "reason": "Maintains merge strategy state for existing PRs."},
  {"file": "scripts/lib/drain-queue-safety.mjs", "status": "readonly", "reason": "Reads merge queue safety evidence."},
  {"file": "scripts/lib/gate-config.mjs", "status": "readonly", "reason": "Reads pinned Git configuration and probes its registry."},
  {"file": "scripts/lib/gh-throttle-holders.mjs", "status": "readonly", "reason": "Reads process identity for GitHub throttle holders."},
  {"file": "scripts/lib/gh-throttle.mjs", "status": "readonly", "reason": "Shared GitHub throttle transport; no delivery launch owner."},
  {"file": "scripts/lib/git-already-done.mjs", "status": "readonly", "reason": "Reads already-merged Git and PR evidence."},
  {"file": "scripts/lib/git-fetch-fresh.mjs", "status": "readonly", "reason": "Fetches Git evidence refs."},
  {"file": "scripts/lib/git-hook-surface.mjs", "status": "readonly", "reason": "Reads Git hooks and installs local hook configuration."},
  {"file": "scripts/lib/git-identity.mjs", "status": "readonly", "reason": "Maintains local Git author identity."},
  {"file": "scripts/lib/git-pr-commits.mjs", "status": "readonly", "reason": "Reads PR commit evidence."},
  {"file": "scripts/lib/git-run.mjs", "status": "readonly", "reason": "Shared bounded Git subprocess transport."},
  {"file": "scripts/lib/git-transport-branch.mjs", "status": "readonly", "reason": "Maintains Git transport branches."},
  {"file": "scripts/lib/github-app-token.mjs", "status": "readonly", "reason": "Reads the GitHub app private key from a credential helper."},
  {"file": "scripts/lib/host-load.mjs", "status": "readonly", "reason": "Reads host process and load samples."},
  {"file": "scripts/lib/host-sample.mjs", "status": "readonly", "reason": "Reads host CPU and memory samples."},
  {"file": "scripts/lib/isolation-provider.mjs", "status": "readonly", "reason": "Shared isolation subprocess transport."},
  {"file": "scripts/lib/judge-spawn.mjs", "status": "readonly", "reason": "Shared judge subprocess transport; no delivery dispatch."},
  {"file": "scripts/lib/lane-acquire-origin.mjs", "status": "readonly", "reason": "Reads the lane repository origin."},
  {"file": "scripts/lib/lane-git-hardening.mjs", "status": "readonly", "reason": "Runs hardened Git operations in an existing lane."},
  {"file": "scripts/lib/lane-history.mjs", "status": "readonly", "reason": "Reads lane Git history."},
  {"file": "scripts/lib/lane-hold-io.mjs", "status": "readonly", "reason": "Reads local origin configuration and remote refs."},
  {"file": "scripts/lib/lane-repair.mjs", "status": "readonly", "reason": "Repairs Git metadata in an existing lane."},
  {"file": "scripts/lib/lane-salvage.mjs", "status": "readonly", "reason": "Salvages an existing lane via Git."},
  {"file": "scripts/lib/lane-verify.mjs", "status": "readonly", "reason": "Reads CI runs for existing lane verification."},
  {"file": "scripts/lib/main-staleness.mjs", "status": "readonly", "reason": "Reads main staleness and reexecutes operator CLIs."},
  {"file": "scripts/lib/memory-available.mjs", "status": "readonly", "reason": "Reads host memory availability."},
  {"file": "scripts/lib/merge-queue-adaptive-batching.mjs", "status": "readonly", "reason": "Reads merge queue batch evidence."},
  {"file": "scripts/lib/merge-queue-affected.mjs", "status": "readonly", "reason": "Reads changed paths for merge selection."},
  {"file": "scripts/lib/merge-queue-enqueue.mjs", "status": "readonly", "reason": "Reads workflow runs for merge admission."},
  {"file": "scripts/lib/merge-queue-hook.mjs", "status": "readonly", "reason": "Reads and maintains merge queue hook state."},
  {"file": "scripts/lib/merge-queue-obsolete-runs.mjs", "status": "readonly", "reason": "Reads and retires obsolete workflow runs."},
  {"file": "scripts/lib/merge-queue-stuck-dequeue.mjs", "status": "readonly", "reason": "Reconciles stuck merge queue entries."},
  {"file": "scripts/lib/model-probation.mjs", "status": "readonly", "reason": "Reads probation PR state and issue history."},
  {"file": "scripts/lib/net-diff-fingerprint.mjs", "status": "readonly", "reason": "Reads Git diff evidence."},
  {"file": "scripts/lib/numbering-carry.mjs", "status": "readonly", "reason": "Reads numbering evidence from Git."},
  {"file": "scripts/lib/open-pr-items.mjs", "status": "readonly", "reason": "Reads open PR card references."},
  {"file": "scripts/lib/operator-identity.mjs", "status": "readonly", "reason": "Reads operator identity evidence."},
  {"file": "scripts/lib/output-mix.mjs", "status": "readonly", "reason": "Reads Git numstat history for output reports."},
  {"file": "scripts/lib/overlay-adoption.mjs", "status": "readonly", "reason": "Reads overlay ancestry."},
  {"file": "scripts/lib/pid-alive.mjs", "status": "readonly", "reason": "Reads process liveness."},
  {"file": "scripts/lib/pr-merge-gate.mjs", "status": "readonly", "reason": "Reads merge gate evidence; no delivery dispatch."},
  {"file": "scripts/lib/pr-size-admission.mjs", "status": "readonly", "reason": "Files backlog accounting items for an existing PR."},
  {"file": "scripts/lib/pr-snapshot.mjs", "status": "readonly", "reason": "Starts a read-only GitHub snapshot refresh child."},
  {"file": "scripts/lib/queue-branch-numbering.mjs", "status": "readonly", "reason": "Reads numbering evidence for queued branches."},
  {"file": "scripts/lib/queue-file-overlap.mjs", "status": "readonly", "reason": "Reads changed files for overlap evidence."},
  {"file": "scripts/lib/red-main-freeze-shared.mjs", "status": "readonly", "reason": "Reads red-main workflow evidence."},
  {"file": "scripts/lib/red-main-quarantine-io.mjs", "status": "readonly", "reason": "Maintains red-main quarantine Git state."},
  {"file": "scripts/lib/referral-card-readable.mjs", "status": "readonly", "reason": "Reads referral card evidence."},
  {"file": "scripts/lib/renamed-pr-refresh.mjs", "status": "readonly", "reason": "Reads renamed PR metadata."},
  {"file": "scripts/lib/required-status-checks.mjs", "status": "readonly", "reason": "Reads required check configuration."},
  {"file": "scripts/lib/restack-equivalence.mjs", "status": "readonly", "reason": "Reads restack equivalence evidence."},
  {"file": "scripts/lib/round-judge-verify.mjs", "status": "readonly", "reason": "Reads verification evidence for a judge round."},
  {"file": "scripts/lib/salvage-index.mjs", "status": "readonly", "reason": "Reads Git state for salvage indexing."},
  {"file": "scripts/lib/spawn-to-completion.mjs", "status": "readonly", "reason": "Generic bounded child transport; caller owns delivery admission."},
  {"file": "scripts/lib/tools-root-guard.mjs", "status": "readonly", "reason": "Reexecutes a CLI in the canonical tools checkout."},
  {"file": "scripts/lib/tools-root.mjs", "status": "readonly", "reason": "Reads the tools repository root via Git."},
  {"file": "scripts/lib/verdict-ledger-io.mjs", "status": "readonly", "reason": "Reads and maintains verdict ledger refs."},
  {"file": "scripts/lib/verdict-ledger.mjs", "status": "readonly", "reason": "Reads verdict ledger evidence."},
  {"file": "scripts/merge-ai-prs.mjs", "status": "readonly", "reason": "Merge daemon maintenance and review label reconciliation."},
  {"file": "scripts/operations/build-dispatch-hold-route-land.mjs", "status": "readonly", "reason": "Runs the already-selected held-card landing lifecycle."},
  {"file": "scripts/operations/card-batch-file.mjs", "status": "readonly", "reason": "Files card batches and seals ledger state."},
  {"file": "scripts/operations/card-batch-io.mjs", "status": "readonly", "reason": "Maintains card-batch Git ledger state."},
  {"file": "scripts/operations/codex-delivery-provider.mjs", "status": "readonly", "reason": "Shared Codex worker transport used by delivery and fix providers; dispatcher owns admission."},
  {"file": "scripts/operations/deliver-item-wrapper.mjs", "status": "readonly", "reason": "Runs an existing delivery lifecycle through provider ports; dispatcher owns admission."},
  {"file": "scripts/operations/detached-dispatch.mjs", "status": "gated", "reason": "Launches delivery children; diagnostic-card filing is a separate exception."},
  {"file": "scripts/operations/dispatch-lane-io.mjs", "status": "gated", "reason": "Delivery provider and agent launch boundaries; evidence reads are separately inventoried."},
  {"file": "scripts/operations/free-scope-io.mjs", "status": "readonly", "reason": "Reads free-scope evidence and maintains scope Git state."},
  {"file": "scripts/operations/handoff-home.mjs", "status": "readonly", "reason": "Reads repository visibility and maintains handoff refs."},
  {"file": "scripts/operations/heavy-queue-io.mjs", "status": "readonly", "reason": "Reads heavy-queue state for operational reporting."},
  {"file": "scripts/operations/land-prevention-card.mjs", "status": "readonly", "reason": "Files and lands diagnostic prevention cards, not agent delivery work."},
  {"file": "scripts/operations/minimal-context-provider.mjs", "status": "readonly", "reason": "Shared lifecycle command transport and lane setup, not delivery admission."},
  {"file": "scripts/operations/needs-you-feed.mjs", "status": "readonly", "reason": "Reads and maintains operator notification evidence."},
  {"file": "scripts/operations/probation-heal-run.mjs", "status": "readonly", "reason": "Runs an already-dispatched probation healing lifecycle."},
  {"file": "scripts/operations/record-verdict-io.mjs", "status": "readonly", "reason": "Reads Git and records review verdict evidence."},
  {"file": "scripts/operations/resolve-io.mjs", "status": "readonly", "reason": "Reads and records resolution evidence."},
  {"file": "scripts/operations/review-pr-io.mjs", "status": "readonly", "reason": "Runs review operations for existing PRs, not delivery workers."},
  {"file": "scripts/operations/telemetry-summary-io.mjs", "status": "readonly", "reason": "Reads launchd plist metadata for telemetry."},
  {"file": "scripts/operations/verify-io.mjs", "status": "readonly", "reason": "Runs verification commands, not delivery workers."},
  {"file": "scripts/operations/worker-wrapper.mjs", "status": "gated", "reason": "Detached worker launcher rechecks admission after spec and stderr setup."},
  {"file": "scripts/progress-board.mjs", "status": "readonly", "reason": "Reads PR metadata for progress reporting."},
  {"file": "scripts/readiness/drain-lock.mjs", "status": "readonly", "reason": "Reads process evidence for merge lock ownership."},
  {"file": "scripts/readiness/forge-run-finish.mjs", "status": "readonly", "reason": "Finalizes workflow run records."},
  {"file": "scripts/readiness/heavy-admission.mjs", "status": "readonly", "reason": "Shared host-capacity queue and bounded command transport."},
  {"file": "scripts/readiness/host-capacity.mjs", "status": "readonly", "reason": "Reads host capacity evidence."},
  {"file": "scripts/readiness/scope-lease-collect.mjs", "status": "readonly", "reason": "Reads lane status and scoped Git evidence."},
  {"file": "scripts/readiness/test-selection.mjs", "status": "readonly", "reason": "Reads tracked paths and runs selected test commands."},
  {"file": "scripts/review-detail.mjs", "status": "readonly", "reason": "Reads PR detail for review output."},
  {"file": "scripts/review-set-label.mjs", "status": "readonly", "reason": "Updates review labels and resumes existing review jobs."},
  {"file": "skills-src/conveyor/build-dispatch-daemon.mjs", "status": "gated", "reason": "Launches admitted delivery and prepare work; discovery reads are separately inventoried."},
  {"file": "skills-src/conveyor/verify-daemon.mjs", "status": "readonly", "reason": "Reads verifier process identity and Git HEAD."},
];

const deliveryEntries = [
  'skills-src/conveyor/build-dispatch-daemon.mjs', 'scripts/conveyor/tick-core.mjs',
  'scripts/operations/dispatch-lane.mjs', 'scripts/operations/dispatch-lane-io.mjs',
  'scripts/operations/worker-wrapper.mjs', 'scripts/operations/deliver-item-wrapper.mjs',
];
const nativePrimitive = /^(?:spawnDetached|defaultSpawnDetached|startDetachedLaunch|spawnResume|spawnLand|spawnPreventionLandingJob|dispatchCiHeal|spawnResumeDelivery|launchWrapped|launchWrappedClaudeWorker|execFileSync|execFile|execSync|spawn|spawnSync|spawnFn|nodeSpawn|fork|spawnToCompletion|execFileSyncThrottled|execFileThrottledAsync)$/;
function importClosure(tree, entries) {
  const modules = new Map();
  function visit(file) {
    if (modules.has(file)) return;
    const source = readFileSync(join(tree, file), 'utf8'); // unreadable imports fail closed
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    modules.set(file, { source, ast });
    for (const node of ast.statements) {
      if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) continue;
      const target = node.moduleSpecifier?.text;
      if (target?.startsWith('.')) visit(relative(tree, resolve(tree, dirname(file), target)));
    }
  }
  entries.forEach(visit);
  return modules;
}
function usesChildProcess({ source, ast }) {
  let found = false;
  function visit(node) {
    if (ts.isStringLiteral(node) && /^(?:node:)?child_process$/.test(node.text)) found = true;
    if (ts.isCallExpression(node) && nativePrimitive.test(node.expression.getText().split('.').at(-1))) found = true;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  // Include generated shim code too, without counting prose mentions of child_process.
  return found || /(?:require|import)\(['"](?:node:)?child_process['"]\)/.test(source);
}
function inventoryErrors(tree, entries, inventory) {
  const modules = importClosure(tree, entries);
  const users = new Map([...modules].filter(([, module]) => usesChildProcess(module)));
  const listed = new Map(inventory.map(row => [row.file, row]));
  const errors = [];
  if (listed.size !== inventory.length) errors.push('duplicate inventory row');
  for (const file of users.keys()) if (!listed.has(file)) errors.push(`unlisted process module: ${file}`);
  for (const row of inventory) {
    if (!users.has(row.file)) errors.push(`stale process module: ${row.file}`);
    if (!['gated', 'readonly'].includes(row.status) || !row.reason?.trim()) errors.push(`invalid process row: ${row.file}`);
    if (row.status !== 'gated' || !users.has(row.file)) continue;
    let { source, ast } = users.get(row.file);
    // runWorker is the shared execution/result transport for an already launched spec.
    // launchDetached is this module's delivery admission owner.
    if (row.file === 'scripts/operations/worker-wrapper.mjs') {
      source = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'launchDetached')?.getText();
      if (!source) { errors.push('missing launchDetached'); continue; }
    }
    const result = scan(source);
    if (!result.sites.length) errors.push(`missing gated launch: ${row.file}`);
    for (const site of result.bypasses) if (!reviewedReads.has(`${row.file}#${site.owner}`))
      errors.push(`unguarded launch: ${row.file}#${site.owner}:${site.line}`);
  }
  return errors;
}
it('derives process inventory from the complete static delivery import closure', () => {
  expect(inventoryErrors(root, deliveryEntries, processInventory)).toEqual([]);
});
it('rejects a newly imported unlisted child_process module in a temporary tree', () => {
  const tree = mkdtempSync(join(tmpdir(), 'runtime-import-closure-'));
  try {
    mkdirSync(join(tree, 'nested'));
    writeFileSync(join(tree, 'entry.mjs'), "export * from './nested/reexport.mjs';");
    writeFileSync(join(tree, 'nested/reexport.mjs'), "import './new-worker.mjs';");
    writeFileSync(join(tree, 'nested/new-worker.mjs'), "import { spawn as start } from 'node:child_process'; start('worker', []);");
    expect(inventoryErrors(tree, ['entry.mjs'], [])).toEqual(['unlisted process module: nested/new-worker.mjs']);
    const file = 'nested/new-worker.mjs';
    expect(inventoryErrors(tree, ['entry.mjs'], [{ file, status: 'gated', reason: 'Delivery launch.' }]))
      .toEqual([expect.stringContaining('unguarded launch:')]);
    writeFileSync(join(tree, file), 'export const noProcess = true;');
    expect(inventoryErrors(tree, ['entry.mjs'], [{ file, status: 'readonly', reason: 'Removed read.' }]))
      .toEqual([`stale process module: ${file}`]);
    writeFileSync(join(tree, 'entry.mjs'), "import './missing.mjs';");
    expect(() => inventoryErrors(tree, ['entry.mjs'], [])).toThrow(/ENOENT/);
  } finally { rmSync(tree, { recursive: true, force: true }); }
});
it('rejects setup IO between fresh admission and spawn', () => {
  for (const effect of ["readFileSync('spec')", "writeFileSync('spec', 'data')", "await setup()", 'state.started = true'])
    expect(scan(`function launch(payload) { return withRuntimeAdmission(payload, 'build', async () => { ${effect}; return spawn('node', []); }); }`).bypasses)
      .toHaveLength(1);
  expect(scan(`function launch(payload) { return withRuntimeAdmission(payload, 'build', () => spawn('node', [readFileSync('spec')])); }`).bypasses)
    .toHaveLength(1);
});

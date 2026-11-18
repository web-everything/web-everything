import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

// Inspect executable call arguments, including dynamic revision expressions; comments are not evidence.
export function findRefStringSites(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sites = [];
  const name = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : '';
  const pinned = node => /^(?:basis|pinnedBasis)\.(?:mergeBaseSha|baseSha|headSha)$/.test(node.getText(tree)) ||
    (file === 'scripts/lib/pinned-diff-basis.mjs' && ['headSha', 'resolvedHead', 'mergeBaseSha', 'baseSha'].includes(name(node)));
  const walk = (node, owner = '<module>') => {
    if (ts.isFunctionDeclaration(node) && node.name) owner = node.name.text;
    if (ts.isVariableDeclaration(node) && node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) owner = name(node.name) || owner;
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : name(node.expression);
      let bad = false;
      if (/^(?:computeNetDiff.*|resolveNetDiffBasis)$/.test(callee)) {
        const arg = node.arguments[0];
        bad = !arg || !ts.isObjectLiteralExpression(arg) ||
          !arg.properties.some(p => name(p.name) === 'basis') ||
          arg.properties.some(p => ['rev', 'base', 'pinRev', 'fetchExtraRefs'].includes(name(p.name)));
      }
      for (const arg of node.arguments) {
        if ((ts.isStringLiteral(arg) || ts.isTemplateExpression(arg)) &&
            /^(?:exec|execSync|spawn|spawnSync)$/.test(callee) &&
            /\bgit\s+(?:diff\b|log\b[^;]*\s(?:-p|--patch)\b)/.test(arg.getText(tree))) bad = true;
        if (!ts.isArrayLiteralExpression(arg)) continue;
        const command = name(arg.elements[0]);
        if (!['diff', 'log'].includes(command)) continue;
        if (command === 'log' && !arg.elements.some(e => ['-p', '--patch'].includes(name(e)))) continue;
        const stop = arg.elements.findIndex(e => name(e) === '--');
        const revisions = arg.elements.slice(1, stop < 0 ? undefined : stop).filter(e =>
          !ts.isSpreadElement(e) && !(ts.isStringLiteral(e) && e.text.startsWith('-')));
        if (revisions.some(e => !pinned(e))) bad = true;
      }
      if (bad) sites.push(`${file}:${owner}`);
    }
    ts.forEachChild(node, child => walk(child, owner));
  };
  walk(tree);
  return sites;
}

function sources(dir = 'scripts') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return ['__tests__', 'node_modules'].includes(entry.name) ? [] : sources(path);
    return entry.name.endsWith('.mjs') && !/\.(?:test|spec)\.mjs$/.test(entry.name) ? [path] : [];
  });
}
// ALLOWLIST: one file:function entry per existing legacy site (duplicates retain counts).
// Baseline: 127 existing ref-string sites; delete entries as callers migrate.
const ALLOWLIST = [
  "scripts/backlog.mjs:observedFilesForResolve",
  "scripts/check-standards.mjs:<module>",
  "scripts/ci-card-only.mjs:main",
  "scripts/ci/quarantine-skip.mjs:changedFilesOf",
  "scripts/codex-direct-task.mjs:captureDiff",
  "scripts/codex-direct-task.mjs:captureDiff",
  "scripts/converge-cli.mjs:laneChangedFiles",
  "scripts/conveyor/await-verify-pass.mjs:defaultAwaitVerifyIo",
  "scripts/conveyor/convert-advisory-dispatch.mjs:fetchTestGamingDiffEvidence",
  "scripts/conveyor/convert-advisory-dispatch.mjs:fetchTestGamingDiffEvidence",
  "scripts/conveyor/delegated-clear-human.mjs:liveReaders",
  "scripts/conveyor/fix-scope-policy.mjs:createRegionReader",
  "scripts/conveyor/lease-reaper.mjs:stablePatchId",
  "scripts/conveyor/mechanical-round-cap.mjs:readMechanicalRoundFacts",
  "scripts/conveyor/mechanical-round-cap.mjs:readMechanicalRoundFacts",
  "scripts/conveyor/mechanical-round-cap.mjs:readMechanicalRoundFacts",
  "scripts/conveyor/mechanical-round-cap.mjs:reproducesCleanMerge",
  "scripts/conveyor/reconcile-pass.mjs:defaultReadChanges",
  "scripts/conveyor/review-stack-base.mjs:mainNetDiffText",
  "scripts/conveyor/review-stack-base.mjs:readBottomLanded",
  "scripts/conveyor/review-stack-base.mjs:readBottomLanded",
  "scripts/conveyor/review-stack-base.mjs:readBottomLanded",
  "scripts/conveyor/review-stack-base.mjs:stackNetDiffText",
  "scripts/conveyor/review-stack-base.mjs:stackNetFiles",
  "scripts/conveyor/scope-bloat.mjs:readNetFiles",
  "scripts/conveyor/soak/red-green.mjs:revertInto",
  "scripts/fetch-parked.mjs:resolveNetDiff",
  "scripts/fetch-parked.mjs:resolveNetDiff",
  "scripts/guard-prototype-tracker.mjs:runPrePush",
  "scripts/lane-resume.mjs:collectPrMissingLanes",
  "scripts/lane-resume.mjs:openPrMissingLane",
  "scripts/lane-stack.mjs:actualFiles",
  "scripts/lib/approved-human-surface-hold.mjs:readApprovedHumanSurfaceHold",
  "scripts/lib/approved-human-surface-hold.mjs:readApprovedHumanSurfaceHold",
  "scripts/lib/card-conflict-resolve.mjs:applyRaisedByConflictsToIndex",
  "scripts/lib/card-group.mjs:createCardGrouping",
  "scripts/lib/card-group.mjs:sourceChange",
  "scripts/lib/card-group.mjs:sourceChange",
  "scripts/lib/card-group.mjs:sourceFiles",
  "scripts/lib/card-group.mjs:verifyUnion",
  "scripts/lib/carry-equivalence.mjs:proveReplayEquivalent",
  "scripts/lib/daemon-load-overlay.mjs:overlayDispatchFiles",
  "scripts/lib/daemon-rebuild/auto-rebase.mjs:runAutoRebase",
  "scripts/lib/daemon-rebuild/auto-rebase.mjs:runAutoRebase",
  "scripts/lib/daemon-rebuild/local-state.mjs:restoreStrayClaimStamps",
  "scripts/lib/daemon-rebuild/overlay-main-sync.mjs:kickOverlayMainSync",
  "scripts/lib/daemon-rebuild/overlay-main-sync.mjs:kickOverlayMainSync",
  "scripts/lib/daemon-rebuild/overlay-main-sync.mjs:runOverlayMainSync",
  "scripts/lib/daemon-rebuild/plan.mjs:changedFiles",
  "scripts/lib/daemon-rebuild/plan.mjs:pinnedConflictSkippable",
  "scripts/lib/daemon-rebuild/plan.mjs:pinnedStatus",
  "scripts/lib/daemon-rebuild/prepare.mjs:prepareRebuild",
  "scripts/lib/daemon-rebuild/preview.mjs:previewOverlayConflict",
  "scripts/lib/daemon-rebuild/smoke.mjs:attributeSmokeFailure",
  "scripts/lib/daemon-rebuild/smoke.mjs:changedSince",
  "scripts/lib/daemon-rebuild/smoke.mjs:dispatchSmokeSuspects",
  "scripts/lib/daemon-self-sync.mjs:changedFilesBetween",
  "scripts/lib/diff-branch-coverage.mjs:scanDiffBranchCoverage",
  "scripts/lib/diff-branch-coverage.mjs:scanDiffBranchCoverage",
  "scripts/lib/diff-hunks.mjs:computeProposedFileDiffText",
  "scripts/lib/drain-poison-guard.mjs:checkBornAsCollision",
  "scripts/lib/duplicate-bornas-added.mjs:checkDuplicateBornAs",
  "scripts/lib/enqueue-on-event.mjs:readPendingChangePaths",
  "scripts/lib/enqueue-on-event.mjs:readPendingChangePaths",
  "scripts/lib/git-already-done.mjs:readGitAlreadyDone",
  "scripts/lib/identical-net-patch.mjs:diffBetween",
  "scripts/lib/lane-pool-recover.mjs:verifyRecoveryBackup",
  "scripts/lib/lane-repair.mjs:provenCleanTree",
  "scripts/lib/lane-salvage.mjs:salvageLane",
  "scripts/lib/lane-salvage.mjs:salvageLane",
  "scripts/lib/main-staleness.mjs:behindFiles",
  "scripts/lib/main-staleness.mjs:changedFilesBetween",
  "scripts/lib/merge-queue-enqueue.mjs:readPinnedChangedFiles",
  "scripts/lib/net-diff-fingerprint.mjs:netDiffFingerprint",
  "scripts/lib/queue-branch-numbering.mjs:sweepQueuedHashCards",
  "scripts/lib/rebase-verdict-carry.mjs:contributionPatchId",
  "scripts/lib/red-main-quarantine-io.mjs:readTouchedFiles",
  "scripts/lib/red-main-quarantine-io.mjs:readTouchedFiles",
  "scripts/lib/red-team-backlog-only.mjs:readBacklogOnlyNetFiles",
  "scripts/lib/review-head-index.mjs:netPatchKey",
  "scripts/lib/salvage-index.mjs:isSalvageLanded",
  "scripts/lib/salvage-index.mjs:isSalvageLanded",
  "scripts/lib/soak-gate-merge-base-diff.mjs:computeSoakGateNameStatus",
  "scripts/lib/verify-lane-gate.mjs:computeWorkingTreeHash",
  "scripts/lib/verify-lane-gate.mjs:laneRelevantChangeSince",
  "scripts/lib/verify-lane-gate.mjs:localChangedSet",
  "scripts/lib/verify-lane-gate.mjs:localChangedSet",
  "scripts/lib/verify-lane-gate.mjs:localDiffIsCardOnly",
  "scripts/lib/verify-lane-gate.mjs:relevantAgainstBase",
  "scripts/lib/verify-revert-red.mjs:runRevertRedCheck",
  "scripts/lib/verify-revert-red.mjs:runRevertRedCheck",
  "scripts/lint-locus-prefix.mjs:rangeCorpusFiles",
  "scripts/merge-ai-prs.mjs:computeNetDiffChangedFiles",
  "scripts/merge-ai-prs.mjs:computeNetDiffChangedFiles",
  "scripts/merge-ai-prs.mjs:computeNetDiffPaths",
  "scripts/merge-ai-prs.mjs:computeNetDiffPaths",
  "scripts/merge-ai-prs.mjs:computeNetDiffSignals",
  "scripts/merge-ai-prs.mjs:computeNetDiffSignals",
  "scripts/merge-ai-prs.mjs:computeNetDiffSignals",
  "scripts/merge-ai-prs.mjs:computeNetDiffText",
  "scripts/merge-ai-prs.mjs:computeNetDiffText",
  "scripts/merge-ai-prs.mjs:resolveNetDiffBasis",
  "scripts/merge-gate-check.mjs:gatherPrFacts",
  "scripts/merge-gate-check.mjs:gatherPrFacts",
  "scripts/operations/deliver-item-wrapper.mjs:computeLaneDiffStats",
  "scripts/operations/free-scope-io.mjs:readNetFileSets",
  "scripts/operations/graduate-chain.mjs:runGraduateChain",
  "scripts/operations/graduate-chain.mjs:runGraduateChain",
  "scripts/operations/migrate-raised-by.mjs:inspect",
  "scripts/operations/migrate-raised-by.mjs:inspect",
  "scripts/operations/prepare-pr.mjs:verifyPrepareBatchPr",
  "scripts/operations/prepare-pr.mjs:verifyPreparePr",
  "scripts/operations/prepare-stamp-land.mjs:landPrepareStamp",
  "scripts/operations/resolve-io.mjs:observedFilesForResolve",
  "scripts/operations/review-pr-io.mjs:readFixRange",
  "scripts/operations/review-pr-io.mjs:readPr",
  "scripts/operations/review-pr-io.mjs:readPr",
  "scripts/operations/review-pr-io.mjs:readPr",
  "scripts/operations/review-pr-io.mjs:readPr",
  "scripts/operations/review-pr-io.mjs:sizeSince",
  "scripts/readiness/check-standards-scope-replay.mjs:selectLaneDiffs",
  "scripts/readiness/prep-staleness.mjs:checkPrepStaleness",
  "scripts/readiness/remote-exec.mjs:buildDeltaManifest",
  "scripts/readiness/scope-lease-collect.mjs:observedForLane",
  "scripts/readiness/test-selection.mjs:changedFilesSince",
  "scripts/review-corpus/mine-review-corpus.mjs:changedFiles",
  "scripts/review-corpus/mine-review-corpus.mjs:pathUnchangedBetween"
];

// TESTS
const current = () => sources().flatMap(file => findRefStringSites(readFileSync(file, 'utf8'), file)).sort();
describe('pinned diff basis structural ratchet', () => {
  it('drain human-clearance carry uses both-head pinned evidence, never the legacy reader', () => {
    const src = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    expect(src).toMatch(/readHeadDiff: \(sha\) => readPinnedCarryDiff\(\{ exec: diffExec, headSha: sha,\s*carriedHeadSha: humanClearedSha, expected: netDiffText \}\)/);
    expect(src).not.toMatch(/readHeadDiff:[^\n]*readNetDiffAtHead/);
  });
  it('has no new ref-string evidence sites and no stale allowlist entries', () => {
    expect(current()).toEqual([...ALLOWLIST].sort());
  });
  it('detects synthetic ref-string calls, dynamic ranges, and log patch evidence', () => {
    const source = "function offending() { computeNetDiffSignals({exec, rev: head}); git(['diff', `${remote}/main...${head}`]); git(['log', '-p', ref]); execSync('git diff origin/main...HEAD'); }";
    expect(findRefStringSites(source, 'scripts/synthetic.mjs')).toEqual(Array(4).fill('scripts/synthetic.mjs:offending'));
    expect(findRefStringSites("function safe() { computeNetDiffSignals({exec, basis}); git(['diff', basis.mergeBaseSha, basis.headSha]); }", 'scripts/synthetic.mjs')).toEqual([]);
  });
  it('ratchets extra sites even in an already allowlisted function', () => {
    const old = 'function legacy() { computeNetDiffText({rev}); }';
    const next = old.replace(' }', ' computeNetDiffPaths({rev}); }');
    expect(findRefStringSites(next, 'legacy.mjs')).toHaveLength(findRefStringSites(old, 'legacy.mjs').length + 1);
  });
});

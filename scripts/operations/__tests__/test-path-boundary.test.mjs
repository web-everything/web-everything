// @repo-scanning-test scope=full
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

// Exact existing literals only: these exceptions must never permit a new loader in an old file.
// Existing classifiers, test runners, fixture scanners and diagnostic citations name these paths.
// Pin literals rather than exempting whole files; comments are not executable references.
const allowedReferences = new Map([
  ["eleventy/passthroughs.cjs", ["__tests__"]],
  ["playwright.config.ts", ["blocks/**/__tests__/**/*.spec.ts"]],
  ["scripts/check-standards-rules.mjs", ["src/_data/__tests__/","__tests__/","scripts/__tests__/","scripts/conveyor/soak/breaks/index.mjs"]],
  ["scripts/check-standards.mjs", ["__tests__","/__tests__/","__tests__","__tests__","__tests__","/__tests__/","__tests__"]],
  ["scripts/conveyor/guard-1c-mutation-check.mjs", ["scripts/conveyor/__tests__/session-reaper.test.mjs"]],
  ["scripts/conveyor/hung-session-mutation-check.mjs", ["scripts/conveyor/__tests__/hung-session.test.mjs"]],
  ["scripts/conveyor/reconcile-pass.mjs", [":(exclude)**/__tests__/**"]],
  ["scripts/conveyor/soak/behaviours.mjs", ["../__tests__/sim/agent-actions.mjs"]],
  ["scripts/conveyor/soak/breaks-shape.mjs", ["soak/breaks/","soak/breaks/","soak/breaks/","soak/breaks/","soak/breaks/","soak/breaks/","soak/breaks/","soak/breaks/","soak/breaks/"]],
  ["scripts/conveyor/soak/rebuild-mechanism-source.mjs", ["__tests__"]],
  ["scripts/conveyor/soak/soak-scope.mjs", ["scripts/conveyor/soak/__tests__/"]],
  ["scripts/conveyor/soak/soak.mjs", ["../__tests__/sim/scenario.mjs"]],
  ["scripts/gen-dispatch-routing-table.mjs", ["`scripts/__tests__/dispatch-routing-table.test.mjs` fails when the two disagree."]],
  ["scripts/lane-drain.mjs", ["soak","breaks","scripts/conveyor/soak/breaks/*.mjs","scripts/conveyor/soak/breaks/"]],
  ["scripts/lib/approval-prevention-notice.mjs", ["/__tests__/"]],
  ["scripts/lib/critical-work.mjs", ["__tests__/$1.test.mjs","scripts/lib/__tests__/agy-confined-","scripts/lib/__tests__/agy-sandbox.test.mjs","scripts/lib/__tests__/agy-fix-admission.test.mjs","scripts/lib/__tests__/fixtures/"]],
  ["scripts/lib/daemon-rebuild/advisory-merge.mjs", ["scripts/conveyor/soak/breaks/index.mjs"]],
  ["scripts/lib/delivery-tier.mjs", ["**/__tests__/*safety*","scripts/lib/__tests__/delivery-tier*","**/__tests__/**"]],
  ["scripts/lib/gate-config.mjs", ["scripts/lib/__tests__/seat-assessment.test.mjs","scripts/lib/__tests__/seat-ac-rubric.test.mjs","scripts/lib/__tests__/review-policy.conformance.test.mjs","scripts/lib/__tests__/check-standards.conformance.test.mjs","scripts/lib/__tests__/gate-invariants.test.mjs"]],
  ["scripts/lib/gh-app-shim.mjs", ["sha256:aea66d400316fe54145206ddc730a13967caf35750415232f387ece0cb50d73f"]],
  ["scripts/lib/hermetic-test-scan.mjs", ["scripts/lib/__tests__/hermetic-test-scan.test.mjs","scripts/lib/__tests__/hermetic-tests.test.mjs"]],
  ["scripts/lib/merge-queue-affected.mjs", ["scripts/lib/__tests__/settings-files.test.mjs"]],
  ["scripts/lib/open-pr-preflight.mjs", ["needs a soak break under scripts/conveyor/soak/breaks/ (module + .soak.test.mjs) or a body waiver"]],
  ["scripts/lib/operation-io-fidelity.mjs", ["scripts/operations/__tests__/helpers/real-repo.mjs","No test under scripts/operations/__tests__/ both imports we:","__tests__","scripts/operations/__tests__"]],
  ["scripts/lib/privacy-terms.mjs", ["__tests__"]],
  ["scripts/lib/protected-path-floor.mjs", ["scripts/conveyor/soak/breaks/fresh-stamp-commit-graph-repair.mjs","scripts/conveyor/soak/breaks/clone-object-maintenance-borrowed-or-busy.mjs","scripts/conveyor/soak/breaks/infra-lock-waiter-busy-spins.mjs","scripts/conveyor/soak/breaks/postmortem-poison-merge.mjs","scripts/conveyor/soak/breaks/rebuild-coordination-noop-events.mjs","scripts/conveyor/soak/breaks/stale-ruling-report-and-rebuild-wait.mjs","scripts/conveyor/soak/breaks/lease-reaper-borrowed-fixer-pid-invisible.mjs","scripts/conveyor/soak/breaks/standdown-pr-holds-scope-slot.mjs","scripts/conveyor/soak/breaks/daemon-entry-boot-crash.mjs","scripts/conveyor/soak/breaks/exhausted-retry-recovery.mjs","scripts/conveyor/soak/breaks/clone-object-maintenance-borrowed-or-busy.mjs","scripts/conveyor/soak/breaks/lane-acquire-waiter-takes-partial.mjs"]],
  ["scripts/lib/push-gate-lint.mjs", ["__tests__"]],
  ["scripts/lib/queue-branch-numbering.mjs", ["scripts/conveyor/soak/breaks/"]],
  ["scripts/lib/red-main-quarantine.mjs", ["__tests__/"]],
  ["scripts/lib/repo-scan-tests.mjs", ["scripts/__tests__/push-gate-boundary.test.mjs","scripts/__tests__/push-gate-boundary.test.mjs","scripts/__tests__/testing-notes-advisory.test.mjs","scripts/__tests__/testing-notes-advisory.test.mjs","scripts/__tests__/fixtures/testing-notes-main-links.json","scripts/__tests__/capability-dispatch-only.test.mjs","scripts/__tests__/capability-dispatch-only.test.mjs","scripts/operations/__tests__/health-watch-lane-scan-boundary.test.mjs","scripts/operations/__tests__/health-watch-lane-scan-boundary.test.mjs","scripts/lib/__tests__/constellation-ownership.test.mjs","scripts/lib/__tests__/constellation-ownership.test.mjs","scripts/lib/__tests__/lane-git-diet.test.mjs","scripts/lib/__tests__/lane-git-diet.test.mjs","scripts/conveyor/__tests__/pr-label-mirror.test.mjs","__tests__","scripts/conveyor/__tests__/pr-label-mirror.test.mjs","scripts/lib/__tests__/exec-output-guard.test.mjs","scripts/lib/__tests__/exec-output-guard.test.mjs","scripts/lib/__tests__/pr-comment-read-guard.test.mjs","scripts/lib/__tests__/pr-comment-read-guard.test.mjs","scripts/__tests__/multi-repo-checks.test.mjs","scripts/__tests__/multi-repo-checks.test.mjs","scripts/lib/__tests__/no-search-backed-pr-list.test.mjs","scripts/lib/__tests__/no-search-backed-pr-list.test.mjs","scripts/lib/__tests__/review-policy.conformance.test.mjs","scripts/lib/__tests__/review-policy.conformance.test.mjs","scripts/lib/__tests__/permission-change.test.mjs","scripts/lib/__tests__/permission-change.test.mjs","scripts/operations/__tests__/worker-result.test.mjs","scripts/operations/__tests__/worker-result.test.mjs","scripts/lib/__tests__/file-class-policy.test.mjs","scripts/lib/__tests__/settings-registry.test.mjs","scripts/lib/__tests__/deps-job-no-packages.test.mjs","scripts/conveyor/soak/breaks/gh-log-escape-sequences-block-ci-heal.soak.test.mjs","scripts/lib/__tests__/gh-ci-log.test.mjs","scripts/lib/__tests__/daemon-host-guard.test.mjs","scripts/operations/__tests__/daemon-preflight.test.mjs","scripts/conveyor/__tests__/reconcile-pass-read-only.test.mjs","scripts/readiness/__tests__/forge-cache-prune-running-record.test.mjs","scripts/__tests__/daemon-heavy-spawn-lint.test.mjs","scripts/readiness/__tests__/forge-r352-sample-secret-files.test.mjs","scripts/readiness/__tests__/forge-exec-run.test.mjs","scripts/backlog/__tests__/number-at-birth-cli.test.mjs","scripts/__tests__/stdout-flush.test.mjs","scripts/__tests__/check-standards.test.mjs","bun-trial/scripts/lib/__tests__/standards-sections.test.mjs","scripts/lib/__tests__/standards-sections.test.mjs","scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs","scripts/__tests__/check-standards-rules-conformance-gates.test.mjs","scripts/__tests__/check-backlog-item.test.mjs","scripts/design-refs/__tests__/taxonomy.test.mjs","scripts/lib/__tests__/decision-docket-real-cards.test.mjs","scripts/review-corpus/__tests__/gates.test.mjs","scripts/conveyor/__tests__/fix-procedure.test.mjs","scripts/lib/__tests__/daemon-rebuild.test.mjs","scripts/lib/__tests__/raised-by.test.mjs","scripts/lib/__tests__/collect-run-closure.test.mjs","scripts/operations/__tests__/unsized-kind-callers.test.mjs","scripts/lib/__tests__/settings-files.test.mjs","scripts/lib/__tests__/merge-queue-enqueue.test.mjs","scripts/operations/__tests__/audit-verdict.test.mjs","scripts/operations/__tests__/run.test.mjs","scripts/operations/__tests__/review-loop-cli.test.mjs","scripts/__tests__/review-set-label.approval-prevention-filing.test.mjs","scripts/readiness/__tests__/forge-exec-run.test.mjs","scripts/operations/__tests__/test-path-boundary.test.mjs","scripts/operations/__tests__/test-path-boundary.test.mjs"]],
  ["scripts/lib/review-loop-policy.mjs", ["__tests__/"]],
  ["scripts/lib/soak-precheck-at-open.mjs", ["this PR touches daemon-soak scope and reads as a bug fix, but adds/changes no file under scripts/conveyor/soak/breaks/","Fix: add a soak break under scripts/conveyor/soak/breaks/ "]],
  ["scripts/lib/soak-replay-gate.mjs", ["scripts/conveyor/soak/breaks/"]],
  ["scripts/lib/stdout-flush-scan.mjs", ["__tests__"]],
  ["scripts/lib/trust-chain-tier.mjs", ["/__tests__/"]],
  ["scripts/lib/utc-day-slice-scan.mjs", ["__tests__"]],
  ["scripts/operations/canonical-audit-gate.mjs", ["scripts/conveyor/soak/breaks/","scripts/operations/__tests__/test-path-boundary.test.mjs"]],
  ["scripts/operations/daemon-jobs-proof/demo-daemon.mjs", ["__tests__"]],
  ["scripts/operations/fix-run.mjs", ["Write your fix evidence to .fix-evidence.md at the lane root (gitignored), including for each open operator send-back item a line: - send-back <id> item <n>: <file:line>. Cite tests by file:line too (e.g. scripts/x/__tests__/y.test.mjs:24)."]],
  ["scripts/operations/probation-build-run.mjs", ["__tests__","__tests__"]],
  ["scripts/readiness/proposer.mjs", ["scripts/__tests__/"]],
]);
// Long generated child-program literals are pinned by digest to keep exceptions reviewable.
const referenceKey = text => text.length > 500 ? `sha256:${createHash('sha256').update(text).digest('hex')}` : text;
const isSource = path => /\.[cm]?[jt]sx?$/.test(path);
const isTest = path => /(?:^|\/)__tests__\//.test(path)
  || path.startsWith('scripts/conveyor/soak/breaks/') || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  || /(?:^|\/)vitest[^/]*\.config\.[^/]+$/.test(path);

export function findBoundaryViolations(files) {
  const violations = [];
  for (const { path, content } of files) {
    if (!isSource(path) || isTest(path)) continue;
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    const references = [];
    const visit = node => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)
        || ts.isTemplateTail(node)) {
        references.push(node.text ?? node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    // Both separate segments also refuse concat/join/computed imports, regardless of variable names.
    const splitSoak = references.includes('soak') && references.includes('breaks');
    const allowed = [...(allowedReferences.get(path) ?? [])];
    for (const text of references) {
      if ((/__tests__|soak\/breaks/).test(text.replaceAll('\\/', '/'))
        || (splitSoak && (text === 'soak' || text === 'breaks'))) {
        const key = referenceKey(text), index = allowed.indexOf(key);
        if (index < 0) violations.push({ path, reference: key });
        else allowed.splice(index, 1);
      }
    }
  }
  return violations;
}

describe('test path production boundary', () => {
  it.each([
    "readFileSync('scripts/__tests__/fixture.json')",
    "readdirSync('scripts/__tests__')",
    "import.meta.glob('../__tests__/**/*.mjs')",
    "import('../' + '__tests__' + '/helper.mjs')",
    "import(['scripts', 'conveyor', 'soak', 'breaks', 'helper.mjs'].join('/'))",
    "import('scripts/conveyor/' + 'soak' + '/' + 'breaks' + '/helper.mjs')",
  ])('rejects a production fixture referencing test paths: %s', content => {
    expect(findBoundaryViolations([{ path: 'src/fixture.mjs', content }])).not.toEqual([]);
  });
  it('does not exempt new references in an existing allowlisted production file', () => {
    expect(findBoundaryViolations([{ path: 'scripts/operations/canonical-audit-gate.mjs',
      content: "readFileSync('scripts/__tests__/new-fixture.json')" }])).not.toEqual([]);
  });
  it('allows isolated test sources and vitest configs', () => {
    expect(findBoundaryViolations(['__tests__/helper.mjs', 'scripts/x/__tests__/x.ts',
      'scripts/conveyor/soak/breaks/example.mjs', 'vitest.soak.config.ts'].map(path =>
      ({ path, content: "import('../__tests__/helper.mjs')" })))).toEqual([]);
  });
  it('ignores comments documenting a test without referencing it in code', () => {
    expect(findBoundaryViolations([{ path: 'src/fixture.mjs', content: '// See __tests__/fixture.mjs' }])).toEqual([]);
  });
  it('tracked production sources do not reference isolated test paths', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024, timeout: 10000 }).split('\0').filter(Boolean);
    expect(findBoundaryViolations(paths.filter(path => isSource(path) && !isTest(path))
      .map(path => ({ path, content: readFileSync(resolve(root, path), 'utf8') })))).toEqual([]);
  });
});

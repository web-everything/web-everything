/** Live draft #5874: review-owned red gates must not deadlock draft promotion. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATHS = ['scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/draft-promotion-rule.mjs',
  'scripts/conveyor/draft-promotion-loop.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs',
  'scripts/lib/review-timing.mjs', 'scripts/lib/review-ci-gate-io.mjs',
  'scripts/operations/review-dispatch.mjs', 'scripts/operations/review-job.mjs'];
const HEAD = 'b'.repeat(40);

export default {
  id: 'review-hold-red-draft-deadlock',
  title: 'review-owned red gates strand a draft that must become ready before review can start',
  card: 'live draft #5874 review-hold-red deadlock',
  fixedBy: { sha: 'HEAD', where: 'lane/review-hold-red-draft-deadlock', paths: PATHS },
  fixPresent(root) {
    try {
      return /export\s+function\s+reviewHoldOnlyRed\s*\(/.test(readFileSync(join(root, PATHS[0]), 'utf8'))
        && PATHS.slice(4).every(path => /reviewUsesRequiredChecks/.test(readFileSync(join(root, path), 'utf8')));
    }
    catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, PATHS[0])).href);
    const { isDraftOwedPromotion } = await import(pathToFileURL(join(sourceRoot, PATHS[1])).href);
    const violations = [];
    const check = (ok, why) => { if (!ok) violations.push(why); };
    const row = (name, conclusion = 'success', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });
    const heldRollup = () => [
      row('test'),
      row('merge-gate', 'failure', { mergeGateReviewHold: { holds: ['review-gate'], jobId: 5874001 } }),
      row('review-gate', 'failure'),
    ];
    const pr = { number: 5874, state: 'OPEN', isDraft: true, isCrossRepository: false,
      headRefName: 'lane/review-hold-red-draft', headRefOid: HEAD, baseRefName: 'main',
      labels: ['review:pending'], comments: [], mergeStateStatus: 'CLEAN' };
    for (const [name, statusCheckRollup, expected] of [
      ['annotated merge-gate and review-gate red', heldRollup(), true],
      ['unannotated merge-gate red', [row('test'), row('merge-gate', 'failure'), row('review-gate', 'failure')], false],
      ['test red', heldRollup().map(checkRow => checkRow.name === 'test' ? row('test', 'failure') : checkRow), false],
    ]) {
      const plan = planReconcile({
        prs: [{ ...pr, statusCheckRollup }], agents: [], durableCounts: {},
        requiredChecks: ['test', 'merge-gate', 'review-gate'],
        reviewTiming: { startAfter: 'ci-green' }, now: Date.parse('2026-10-24T18:24:00Z'),
      });
      const promoted = plan.dispatch.some(d => d.kind === 'promote-draft' && d.prNumber === pr.number);
      check(promoted === expected, `${name}: planner promotion=${promoted}, expected=${expected}`);
      log?.(`${name}: planner promotion=${promoted}, expected=${expected}\n`);
    }
    for (const [name, checks, expected] of [
      ['proved review-only red', { state: 'red', sha: HEAD, reviewHoldOnly: true }, true],
      ['red without review-only proof', { state: 'red', sha: HEAD }, false],
    ]) {
      const result = isDraftOwedPromotion({ pr, checks });
      check(result.owed === expected, `${name}: draft promotion owed=${result.owed}, expected=${expected}`);
      log?.(`${name}: draft promotion owed=${result.owed}, expected=${expected}\n`);
    }
    // PR #5911 send-back: promotion must reach the fresh dispatch gate under fast-check fallback too.
    const repo = CONSTELLATION_REPOS.frontierui.slug; // No fast-check list for this repo.
    const requiredChecks = ['test', 'review-gate'];
    const statusCheckRollup = [row('test'), row('review-gate', 'failure')];
    const reviewTiming = { startAfter: 'fast-checks', fastChecks: { we: ['standards'] } };
    const plan = isDraft => planReconcile({ repo: 'frontierui', prs: [{ ...pr, isDraft, statusCheckRollup }],
      agents: [], durableCounts: {}, requiredChecks, reviewTiming, advisoryReviewOnHumanHandoff: 'on',
      now: Date.parse('2026-10-24T18:24:00Z') });
    check(plan(true).dispatch.some(d => d.kind === 'promote-draft'), 'fast-check fallback: draft promotion missing');
    const review = plan(false).dispatch.find(d => d.kind === 'review');
    check(review?.advisoryReview?.ciWaived === true, 'fast-check fallback: head-pinned advisory waiver missing');
    const { dispatchReviewByMode } = await import(pathToFileURL(join(sourceRoot, 'scripts/operations/review-job.mjs')).href);
    const { readReviewCiGate } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/review-ci-gate-io.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'soak-review-hold-advisory-'));
    try {
      for (const mode of ['session', 'job']) {
        let spawns = 0;
        const result = dispatchReviewByMode({ mode, pr: pr.number, repo, root: '/daemon', dir,
          env: { WE_REVIEW_START_AFTER: 'fast-checks' },
          advisoryCiWaiver: review?.advisoryReview?.ciWaived === true ? { head: review.advisoryReview.head, reason: review.advisoryReview.reason } : null,
          ciGate: args => readReviewCiGate({ ...args, readHead: () => HEAD,
            readRequired: () => ({ source: 'live', checks: requiredChecks }), readChecks: () => statusCheckRollup }),
          checkoutExists: () => true, checkStaleness: () => ({ fresh: true, behind: 0 }), stackCheck: () => ({ base: null }),
          readCompletion: () => null, resolveSettingsEnv: () => ({}),
          readBrief: () => 'review {{PR}}', mintSessionId: () => 'soak-review-hold-advisory',
          wrapReview: false, sessionCwdFor: () => dir, ensureSessionCwd: path => path,
          isolateSession: () => ({ worktreeSettings: {} }),
          spawnAgent: () => { spawns++; return ''; }, spawnJob: () => { spawns++; return null; },
        });
        check(spawns === 1 && !result.skipped, `fast-check fallback ${mode}: ${result.skipped ?? 'did not start'}`);
        log?.(`fast-check fallback ${mode}: spawns=${spawns}, skipped=${result.skipped ?? 'none'}\n`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return { violations };
  },
  judge: report => report.violations,
};

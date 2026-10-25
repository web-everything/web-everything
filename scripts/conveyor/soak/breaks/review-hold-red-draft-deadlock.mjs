/** Live draft #5874: review-owned red gates must not deadlock draft promotion. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATHS = ['scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/draft-promotion-rule.mjs',
  'scripts/conveyor/draft-promotion-loop.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs'];
const HEAD = 'b'.repeat(40);

export default {
  id: 'review-hold-red-draft-deadlock',
  title: 'review-owned red gates strand a draft that must become ready before review can start',
  card: 'live draft #5874 review-hold-red deadlock',
  fixedBy: { sha: 'HEAD', where: 'lane/review-hold-red-draft-deadlock', paths: PATHS },
  fixPresent(root) {
    try {
      return /export\s+function\s+reviewHoldOnlyRed\s*\(/.test(readFileSync(join(root, PATHS[0]), 'utf8'));
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
    return { violations };
  },
  judge: report => report.violations,
};

/** PR #5925 / #5972: a held review gate must retain one safe owner on every planner tick. */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'review-gate-only-red-ownership',
  title: 'review-gate-only red retains review, CI repair, or operator-ruling ownership',
  card: 'PR #5925 incident and PR #5972 review findings, 2026-10-26',
  fixedBy: { sha: 'HEAD', where: 'lane/review-gate-only-red', paths: [
    'scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/ci-heal-escalation-mark.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('reviewGateRulingOwed');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs')).href);
    const { notCiBreakRecordRefusal } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/ci-heal-escalation-mark.mjs')).href);
    const head = 'a'.repeat(40);
    const check = (name, conclusion = 'SUCCESS') => ({ name, status: 'COMPLETED', conclusion });
    const rollup = [check('standards'), check('test-shard (1)'), check('test'), check('smoke', 'CANCELLED'), check('review-gate', 'FAILURE')];
    const pull = { number: 5925, state: 'OPEN', isDraft: false, headRefName: 'lane/review-gate-only',
      headRefOid: head, mergeStateStatus: 'CLEAN', comments: [], labels: [{ name: 'review:human' }], statusCheckRollup: rollup };
    const blocked = [{ key: 'blocked', finding: { file: 'example.mjs' } }];
    const variants = [
      { name: 'cancelled smoke', expected: 'review' },
      ...['review:changes', 'advisory:changes'].map(label => ({ name: label, expected: 'ci-heal',
        over: { labels: [...pull.labels, { name: label }] } })),
      { name: 'block ruling', expected: 'fix', over: { blockRuledReferrals: blocked } },
      { name: 'ignored ruling', expected: 'fix', over: { ignoredRulings: { head, misses: 1,
        matches: [{ finding: { file: 'example.mjs' }, ruling: 'block: repair', priorHead: 'b'.repeat(40), misses: 1 }] } } },
      { name: 'cancelled test without retry evidence', expected: 'ci-heal',
        over: { statusCheckRollup: rollup.map(row => row.name === 'test' ? check('test', 'CANCELLED') : row) } },
      ...['review:human', 'review:pending'].flatMap(label => ['test', 'smoke'].flatMap(cancelled =>
        [false, true].map(strict => ({ name: `${label} cancelled ${cancelled} strict=${strict}`,
          expected: cancelled === 'smoke' && !strict ? 'review' : 'ci-timeout-rerun',
          ...(strict ? { reviewTiming: { startAfter: 'ci-green' } } : {}),
          over: { labels: [{ name: label }], statusCheckRollup: rollup.map(row =>
            ['test', 'smoke'].includes(row.name) ? check(row.name, row.name === cancelled ? 'CANCELLED' : 'SUCCESS') : row),
          timeoutRetry: { eligible: true, infraCancelled: true, repo: 'review-gate-fixture/example',
            pr: pull.number, head, signature: 'infra', jobs: [{ run: 10, job: 20, attempt: 1 }] },
          timeoutRetryBudget: { confirmed: 0, rejected: 0, pending: false } },
        })))),
      { name: 'required gate and optional red', refusal: 'review-ci', requiredChecks: ['test', 'smoke', 'review-gate'],
        over: { statusCheckRollup: rollup.map(row => row.name === 'smoke' ? check('smoke') : row).concat(check('optional-ci', 'FAILURE')) } },
    ];
    const violations = [];
    for (let tick = 0; tick < 3; tick++) {
      for (const variant of variants) {
        const pr = { ...pull, ...variant.over };
        const requiredChecks = variant.requiredChecks ?? ['test', 'smoke'];
        const plan = planReconcile({ prs: [pr], agents: [], requiredChecks,
          ...(variant.reviewTiming ? { reviewTiming: variant.reviewTiming } : {}),
          now: Date.parse('2026-10-26T12:00:00Z') + tick * 60000 });
        const kinds = plan.dispatch.map(row => row.kind);
        const safe = variant.expected ? kinds.length === 1 && kinds[0] === variant.expected
          : kinds.length === 0 && plan.refusals.some(row => row.kind === variant.refusal);
        log?.(`tick ${tick} ${variant.name}: ${kinds.join(',') || plan.refusals.map(row => row.kind).join(',')}`);
        if (!safe) violations.push(`tick ${tick} ${variant.name}: expected ${variant.expected ?? variant.refusal}, got ${kinds.join(',') || plan.refusals.map(row => row.kind).join(',')}`);
      }
    }
    const cancelledTest = { ...pull, statusCheckRollup: [check('test', 'CANCELLED'), check('smoke')] };
    if (!notCiBreakRecordRefusal({ headSha: head, pr: cancelledTest, requiredChecks: ['test', 'smoke'] })) {
      violations.push('cancelled required test accepted as not-a-ci-break');
    }
    return { violations };
  },
  judge: report => report.violations,
};

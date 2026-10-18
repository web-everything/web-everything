/** PR #5465: optional red CI stranded review; a refused review delayed its own CI heal. */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'review-timing-refused-review-strands-heal',
  title: 'review timing always leaves required CI repairable and optional CI reviewable',
  card: 'PR #5465 review findings, 2026-10-17',
  fixedBy: { sha: 'HEAD', where: 'lane/review-timing', paths: ['scripts/conveyor/reconcile-core.mjs', 'scripts/lib/review-timing.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('reviewPending: reviewCanFinish');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs')).href);
    const { REVIEW_TIMING_DEFAULTS } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/review-timing.mjs')).href);
    const now = Date.parse('2026-10-17T12:30:00Z');
    const head = 'a'.repeat(40);
    const check = (name, conclusion) => ({ name, conclusion, head_sha: head, status: 'COMPLETED', completedAt: new Date(now - 60000).toISOString() });
    const violations = [];
    for (const startAfter of ['fast-checks', 'push']) {
      for (const optional of [true, false]) {
        const pr = { number: 7, state: 'OPEN', headRefOid: head, headRefName: 'lane/xabc-test',
          labels: [{ name: 'review:pending' }], comments: [], files: [{ path: 'scripts/example.mjs' }],
          statusCheckRollup: [check('standards', 'SUCCESS'), check('test-shard (1)', 'SUCCESS'),
            check('test', optional ? 'SUCCESS' : 'FAILURE'), ...(optional ? [check('CodeQL', 'FAILURE')] : [])] };
        for (const elapsed of [0, 60000, 120000]) {
          const result = planReconcile({ prs: [pr], requiredChecks: ['test'], now: now + elapsed, reviewTiming: { ...REVIEW_TIMING_DEFAULTS, startAfter } });
          const expected = optional ? 'review' : 'ci-heal';
          const kinds = result.dispatch.map(d => d.kind);
          log?.(`${startAfter}, optional=${optional}, tick=${elapsed}: ${kinds.join(',')}`);
          if (!kinds.includes(expected)) violations.push(`${startAfter}: expected immediate ${expected}, got ${kinds.join(',') || 'none'}`);
        }
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};

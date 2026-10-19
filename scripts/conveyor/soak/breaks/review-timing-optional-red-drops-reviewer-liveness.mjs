/** PR #5465: an optional red check counted as healable CI, so the live reviewer lost liveness protection. */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'review-timing-optional-red-drops-reviewer-liveness',
  title: 'an optional red check never strips a live reviewer, so no duplicate review is dispatched',
  card: 'PR #5465 referral block (reconcile-core liveness), 2026-10-17',
  fixedBy: { sha: 'HEAD', where: 'lane/review-timing', paths: ['scripts/lib/review-timing.mjs', 'scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('timingFacts(pr, { agents, repo, requiredChecks');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs')).href);
    const now = Date.parse('2026-10-17T15:30:00Z');
    const head = 'c'.repeat(40);
    const check = (name, conclusion = 'SUCCESS') => ({ name, conclusion, head_sha: head, status: 'COMPLETED', completedAt: new Date(now - 60000).toISOString() });
    const reviewer = { name: 'review-7', pid: 123, pidAlive: true, state: 'working' };
    const violations = [];
    for (const optional of ['CodeQL', 'merge-gate-advisory']) {
      const pr = { number: 7, state: 'OPEN', headRefOid: head, headRefName: 'lane/xabc-test',
        labels: [{ name: 'review:pending' }], comments: [], files: [{ path: 'scripts/example.mjs' }],
        statusCheckRollup: [check('standards'), check('test-shard (1)'), check('test'), check(optional, 'FAILURE')] };
      // Ticks past fix.joinWaitMaxMin (15 min): the cap used to strip the live reviewer.
      for (const elapsed of [0, 15 * 60000, 60 * 60000]) {
        const result = planReconcile({ prs: [pr], requiredChecks: ['test'], now: now + elapsed, agents: [reviewer] });
        const kinds = result.dispatch.map(d => d.kind);
        log?.(`${optional} red, tick=${elapsed / 60000}min: ${kinds.join(',') || 'none'}`);
        if (kinds.length) violations.push(`${optional} red at +${elapsed / 60000}min with a live reviewer: dispatched ${kinds.join(',')}`);
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};

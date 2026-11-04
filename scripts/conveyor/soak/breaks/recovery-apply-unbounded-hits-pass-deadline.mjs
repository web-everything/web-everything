/** 2026-11-03: the first apply tick after main went green refreshed PRs until the 300 s pass deadline killed it mid-batch. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sweepCiRedRecovery } from '../../ci-red-recovery-watch.mjs';

const failing = { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-11-03T13:51:55Z' };
const mainRuns = [
  { databaseId: 1, status: 'completed', conclusion: 'failure', createdAt: '2026-11-03T13:00:00Z', updatedAt: '2026-11-03T13:30:00Z', headSha: 'a'.repeat(40) },
  { databaseId: 2, status: 'completed', conclusion: 'success', createdAt: '2026-11-03T14:40:00Z', updatedAt: '2026-11-03T14:53:47Z', headSha: 'b'.repeat(40) },
].map((r) => ({ ...r, name: 'CI', workflowName: 'CI' }));

export default {
  id: 'recovery-apply-unbounded-hits-pass-deadline',
  title: 'post-green recovery apply loop has no time budget or batch cap, so the pass deadline kills it mid-batch',
  card: 'backlog 4119 follow-up (2026-11-03 main red-to-green)',
  fixedBy: { sha: 'pending', where: 'lane/recovery-apply-budget', paths: ['scripts/conveyor/ci-red-recovery-watch.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs'), 'utf8').includes('budgetExhausted'); },
  run() {
    const violations = [];
    const prs = [1, 2, 3, 4].map((n) => ({ number: 7000 + n, headRefName: `lane/soak${n}`, headRefOid: String(n).repeat(40), statusCheckRollup: [failing] }));
    let t = 0;
    const comments = [];
    const result = sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => mainRuns, readAheadBy: () => 5, readComments: () => [],
      refresh: () => { t += 100; return { ok: true, action: 'rebased' }; },
      postComment: (n) => comments.push(n), checkClaim: () => null, readPriority: () => null,
      apply: true, now: () => t, applyBudgetMs: 150, maxApplyPerTick: 8,
    });
    const refreshed = result.applied.filter((a) => a.ok).length;
    if (refreshed > 2) violations.push({ detail: `${refreshed} refreshes started past a 150 ms budget` });
    const deferred = result.applied.filter((a) => a.deferred).map((a) => a.prNumber);
    if (comments.some((n) => deferred.includes(n))) violations.push({ detail: 'a deferred PR got a rebase comment (burns its cap)' });
    // Review of #6340: slow discovery (per-PR comment reads) spent the whole budget before the loop began, so every
    // tick deferred everything forever. At least one refresh must still start.
    let t2 = 0;
    const starved = sweepCiRedRecovery({
      readOpenPrs: () => { t2 += 200; return prs; }, readMainRuns: () => mainRuns, readAheadBy: () => 5, readComments: () => [],
      refresh: () => ({ ok: true, action: 'rebased' }), postComment: () => {}, checkClaim: () => null, readPriority: () => null,
      apply: true, now: () => t2, applyBudgetMs: 150, maxApplyPerTick: 8,
    });
    if (!starved.applied.some((a) => a.ok)) violations.push({ detail: 'discovery outlasted the budget and the tick refreshed nothing (starvation)' });
    return { violations };
  },
  judge(report) { return report.violations.map((v) => v.detail); },
};

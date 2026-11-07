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
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs'), 'utf8').includes('applyLedger'); },
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
    // Review round 2 of #6340: a refresh that comes back deferred (no work) must not spend the progress floor.
    let t3 = 0;
    const freeDefer = sweepCiRedRecovery({
      readOpenPrs: () => { t3 += 200; return prs; }, readMainRuns: () => mainRuns, readAheadBy: () => 5, readComments: () => [],
      refresh: (branch) => (branch === 'lane/soak1' ? { deferred: true, ok: false, error: 'not same-repo' } : { ok: true, action: 'rebased' }),
      postComment: () => {}, checkClaim: () => null, readPriority: () => null,
      apply: true, now: () => t3, applyBudgetMs: 150, maxApplyPerTick: 8,
    });
    if (!freeDefer.applied.some((a) => a.ok)) violations.push({ detail: 'a free deferral spent the progress floor and starved the later PRs' });
    // Review round 3 of #6340: deferrals do no writes but still cost time; slow ones must not run past the budget.
    let t4 = 0;
    let slowCalls = 0;
    sweepCiRedRecovery({
      readOpenPrs: () => Array.from({ length: 12 }, (_, i) => ({ number: 7100 + i, headRefName: `lane/slow${i}`, headRefOid: String(i % 9).repeat(40), statusCheckRollup: [failing] })),
      readMainRuns: () => mainRuns, readAheadBy: () => 5, readComments: () => [],
      refresh: () => { slowCalls += 1; t4 += 35_000; return { deferred: true, ok: false, error: 'verification failed' }; },
      postComment: () => {}, checkClaim: () => null, readPriority: () => null,
      apply: true, now: () => t4, applyBudgetMs: 170_000, maxApplyPerTick: 8,
    });
    if (t4 > 210_000) violations.push({ detail: `slow deferred refreshes ran ${t4} ms (${slowCalls} calls) past a 170000 ms budget` });
    // Review round 4 of #6340: ticks were stateless, so slow free deferrals at the head of a stable queue spent every
    // tick's budget and the refreshable PR behind them was never tried. The apply ledger rotates the queue.
    let stored = null;
    const ledger = { read: () => stored, write: (s) => { stored = JSON.parse(JSON.stringify(s)); } };
    const queue = Array.from({ length: 6 }, (_, i) => ({ number: 7300 + i, headRefName: `lane/fair${i}`, headRefOid: String(i + 1).repeat(40), statusCheckRollup: [failing] }));
    let refreshedLast = false;
    for (let tick = 0; tick < 3; tick += 1) {
      let t5 = 0;
      const r = sweepCiRedRecovery({
        readOpenPrs: () => queue, readMainRuns: () => mainRuns, readAheadBy: () => 5, readComments: () => [],
        refresh: (branch) => {
          if (branch === 'lane/fair5') return { ok: true, action: 'rebased' };
          t5 += 35_000; return { deferred: true, ok: false, error: 'verification unknown' };
        },
        postComment: () => {}, checkClaim: () => null, readPriority: () => null,
        apply: true, now: () => t5, applyBudgetMs: 170_000, maxApplyPerTick: 8, applyLedger: ledger,
      });
      if (r.applied.some((a) => a.prNumber === 7305 && a.ok)) refreshedLast = true;
    }
    if (!refreshedLast) violations.push({ detail: 'slow deferrals at the queue head starved the refreshable PR behind them for 3 ticks' });
    return { violations };
  },
  judge(report) { return report.violations.map((v) => v.detail); },
};

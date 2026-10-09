/**
 * Live #4361 (2026-10-08 11:01-11:02 ET): fix-4361's verify was red only on host-load timeouts, so it posted a
 * load-flake hold and released its fix claim at the OLD head. The reverify pass then pushed the held fix
 * (a5938d89), but nothing re-armed `review:changes`. The PR sat bounced on a head that already was the fix: the
 * review daemon logged "owed a fix, not a review" every tick, no fixer took it, and no review ran.
 * Replay through the real planner and the real reverify pass: the planner must not owe that head a fixer, and the
 * pass must re-arm it (even while host load defers verification).
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ALT = 'a5938d8938a20137e76d2145e49d40ee8fff4970';
const BOT = { login: 'web-everything' };

export default {
  id: 'load-flake-push-never-rearmed',
  title: 'a fix pushed by the load-flake reverify pass is re-armed for review, never left owed a fix (#4361)',
  card: 'PR #4361',
  fixedBy: { sha: 'uncommitted', where: 'lane/load-flake-push-rearm', paths: ['scripts/conveyor/load-flake-reverify.mjs', 'scripts/conveyor/load-flake-hold.mjs', 'scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/load-flake-hold.mjs'), 'utf8').includes('export function pushedLoadFlakeFixOwedRearm');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const imp = (p) => import(pathToFileURL(join(root, p)).href);
    const { planReconcile } = await imp('scripts/conveyor/reconcile-core.mjs');
    const { buildLoadFlakeHoldComment, buildLoadFlakeResolvedComment } = await imp('scripts/conveyor/stand-down.mjs');
    const { runLoadFlakeReverify, reverifyConfig } = await imp('scripts/conveyor/load-flake-reverify.mjs');
    const comments = [
      { body: 'A reviewer finding on build-delivery-evidence.mjs:113', createdAt: '2026-10-08T13:12:57Z', author: BOT },
      { body: '🔁 review — changes requested\n\nblocked referral findings', createdAt: '2026-10-08T13:46:33Z', author: BOT },
      { body: buildLoadFlakeHoldComment({ head: 'd7a3b14ac846bb34c6a69b22d6a9f01e85650c6b', alt: 'lane/build-outcomes-fix-4361-alt', altSha: ALT }), createdAt: '2026-10-08T15:01:01Z', author: BOT },
      { body: buildLoadFlakeResolvedComment({ altSha: ALT, result: 'pushed', detail: 'Pushed without a local re-verify' }), createdAt: '2026-10-08T15:02:43Z', author: { login: 'chalbert' } },
    ];
    const pr = {
      number: 4361, state: 'OPEN', headRefName: 'lane/build-outcomes', headRefOid: ALT, mergeStateStatus: 'CLEAN',
      labels: [{ name: 'review:changes' }, { name: 'review:human' }, { name: 'review-round:4' }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], comments,
    };
    const violations = [];
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: Date.parse('2026-10-08T16:00:00Z') });
    if (plan.dispatch.some((d) => d.prNumber === 4361 && d.kind === 'fix')) violations.push('planner owes the pushed-fix head another fixer');
    const rearm = [];
    const io = {
      now: () => Date.parse('2026-10-08T16:00:00Z'), loadavg: () => [40, 40, 40], cpuCount: () => 8,
      listPrs: async () => [pr], readPr: async () => pr, rearm: (slug, n) => { rearm.push(n); },
    };
    await runLoadFlakeReverify({ config: reverifyConfig({}) }, io);
    if (!rearm.includes(4361)) violations.push('reverify pass never re-armed the PR it pushed a fix to');
    return { violations };
  },
  judge(report) { return report.violations; },
};

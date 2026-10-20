/** PR #5769 red team: declined starts starved healthy repos and command parsing undercounted live rounds. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = 'skills-src/conveyor/review-daemon.mjs';

export default {
  id: 'review-live-round-cap-accounting',
  title: 'PR #5769: review cap refunds non-starts and counts independent rounds in spaced checkout paths',
  card: 'PR #5769 post-accept red team',
  fixedBy: { sha: 'HEAD', where: 'lane/review-live-round-count-argv', paths: [SOURCE] },
  fixPresent(root) {
    const source = readFileSync(join(root, SOURCE), 'utf8');
    return source.includes('remainingReviewCapacity') && source.includes('hasJobAncestor');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const { runReviewTickAllRepos, liveReviewRoundBudget } = await import(pathToFileURL(join(root, SOURCE)).href);
    const violations = [];
    const independent = [
      'node /a/review-job.mjs run --pr=1',
      'node /a/review-job.mjs run --pr=2',
      'node /a/review-loop-cli.mjs --pr=3',
    ];
    const spaced = [
      '101 1 node /Users/user/Review Work/scripts/operations/review-job.mjs run --pr=1',
      '102 101 node /Users/user/Review Work/scripts/operations/review-loop-cli.mjs --pr=1',
    ];
    for (const [name, commands, expected] of [['independent rounds', independent, 3], ['spaced parent/child paths', spaced, 1]]) {
      const budget = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '3' }, listCommands: () => commands.join('\n') });
      if (budget.live !== expected || budget.left !== 3 - expected) violations.push(`${name}: ${JSON.stringify(budget)}`);
    }
    for (let tick = 1; tick <= 2; tick++) {
      const budget = { left: 3 };
      const result = runReviewTickAllRepos({
        repos: ['web-everything/web-everything', 'frontier-ui/frontierui'], liveReviewBudget: budget,
        reconcile: ({ repo }) => ({ dispatch: Array.from({ length: repo === 'web-everything/web-everything' ? 3 : 1 },
          (_, i) => ({ kind: 'review', prNumber: 100 + i })), refusals: [] }),
        dispatch: ({ repo }) => repo === 'web-everything/web-everything'
          ? { skipped: 'review-ci: unreadable-ci' } : { agentId: 'healthy-review' },
        holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], acquirableLanes: () => 40,
      });
      if (result.dispatched.length !== 1 || result.dispatched[0]?.repo !== 'frontier-ui/frontierui'
        || result.deferredForCap !== 0 || budget.left !== 2) {
        violations.push(`tick ${tick}: healthy repo starved; dispatched=${result.dispatched.length}, deferred=${result.deferredForCap}, left=${budget.left}`);
      }
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};

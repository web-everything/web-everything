/** PR #5082: a classified old-rule failure must not strand disabled/ineligible/no-progress repairs. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enrichPrsWithOwedMainRule } from '../../../lib/renamed-pr-refresh.mjs';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { planReconcile } from '../../reconcile-core.mjs';

export default {
  id: 'owed-main-rule-strands-repair',
  title: 'old numbering-rule classification strands PRs outside automatic refresh ownership',
  card: 'PR #5082 review findings',
  fixedBy: { sha: 'pending', where: 'lane/refresh-renamed-prs', paths: ['scripts/lib/renamed-pr-refresh.mjs', 'scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('pr.owedMainRule.ownsRepair === true'); },
  run() {
    const violations = [];
    for (const variant of ['disabled', 'non-lane', 'fork', 'current', 'conflict']) {
      for (let tick = 0; tick < 3; tick++) {
        const pr = { number: 5050, state: 'OPEN', headRefName: variant === 'non-lane' ? 'feature/example' : 'lane/example',
          headRefOid: 'abc123', isCrossRepository: variant === 'fork', labels: [], comments: [],
          mergeStateStatus: variant === 'conflict' ? 'DIRTY' : 'CLEAN',
          statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] };
        enrichPrsWithOwedMainRule([pr], { repo: CONSTELLATION_REPOS.we.slug,
          settings: { refreshWhenMainAcceptsDrainNumbers: variant !== 'disabled' },
          mainAccepts: () => variant === 'current' || variant === 'conflict',
          read: () => ({ owed: true, nums: [5994] }) });
        const out = planReconcile({ prs: [pr], agents: [], durableCounts: {}, requiredChecks: ['test'], now: Date.parse('2026-10-12T23:00:00Z') });
        if (out.refusals.some(r => r.kind === 'owed-main-rule') || !out.dispatch.length)
          violations.push({ variant, tick, detail: JSON.stringify(out.refusals) });
      }
    }
    return { violations };
  },
  judge(report) { return report.violations.map(v => `${v.variant} tick ${v.tick}: no repair actor (${v.detail})`); },
};

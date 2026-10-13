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
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('if (pr?.codeqlFailure) { planCodeqlHeal(owedMainRuleFact); continue; }'); },
  run() {
    const violations = [];
    // `other-red`: red-team break on 0f5822e8c — a second failing required check must keep its ci-heal.
    // `codeql`: red-team break on 97f4877fd — a CodeQL failure the drain enforces (not required) keeps its ci-heal.
    for (const variant of ['disabled', 'non-lane', 'fork', 'current', 'conflict', 'other-red', 'codeql']) {
      for (let tick = 0; tick < 3; tick++) {
        const pr = { number: 5050, state: 'OPEN', headRefName: variant === 'non-lane' ? 'feature/example' : 'lane/example',
          headRefOid: 'abc123', isCrossRepository: variant === 'fork', labels: [], comments: [],
          mergeStateStatus: variant === 'conflict' ? 'DIRTY' : 'CLEAN',
          statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
            ...(variant === 'other-red' ? [{ name: 'soak-replay-gate', status: 'COMPLETED', conclusion: 'FAILURE' }] : []),
            ...(variant === 'codeql' ? [{ name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE' }] : [])],
          ...(variant === 'codeql' ? { codeqlFailure: { checkRunId: 7, headSha: 'abc123', alerts: [{ rule: 'js/sql-injection', path: 'x.mjs', line: 1, message: 'new' }] } } : {}) };
        enrichPrsWithOwedMainRule([pr], { repo: CONSTELLATION_REPOS.we.slug,
          settings: { refreshWhenMainAcceptsDrainNumbers: variant !== 'disabled' },
          mainAccepts: () => variant === 'current' || variant === 'conflict',
          read: () => ({ owed: true, nums: [5994] }) });
        const out = planReconcile({ prs: [pr], agents: [], durableCounts: {}, requiredChecks: ['test', 'soak-replay-gate'], now: Date.parse('2026-10-12T23:00:00Z') });
        if (out.refusals.some(r => r.kind === 'owed-main-rule') || !out.dispatch.length)
          violations.push({ variant, tick, detail: JSON.stringify(out.refusals) });
        // The kept heal must still be told the `test` failure is drain-assigned numbers to leave alone.
        else if ((variant === 'other-red' || variant === 'codeql') && !out.dispatch[0].owedMainRule?.nums?.includes(5994))
          violations.push({ variant, tick, detail: 'ci-heal dispatched without the drain-number hold' });
        else if (variant === 'codeql' && (out.dispatch[0].reason !== 'codeql' || !out.dispatch[0].codeql?.alerts?.length))
          violations.push({ variant, tick, detail: 'ci-heal dispatched without the CodeQL alert' });
      }
    }
    return { violations };
  },
  judge(report) { return report.violations.map(v => `${v.variant} tick ${v.tick}: no repair actor (${v.detail})`); },
};

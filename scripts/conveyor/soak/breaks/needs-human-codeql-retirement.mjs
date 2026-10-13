/** PR #5033: required-green must not retire a non-required CodeQL escalation. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'needs-human-codeql-retirement',
  title: 'PR #5033: preserve human attention while the drain holds CodeQL',
  card: 'PR #5033 (#4075)',
  fixedBy: { sha: '', where: 'lane/ciheal-needs-human-void', paths: ['scripts/conveyor/reconcile-core.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('&& !pr.codeqlFailure'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const load = path => import(pathToFileURL(join(root, path)).href);
    const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
    const { buildCiHealEscalationComment } = await load('scripts/conveyor/ci-heal-escalation-mark.mjs');
    const { planNeedsHumanVoid } = await load('skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
    const head = 'a'.repeat(40);
    const verdictSettings = { voidNeedsHumanWhenCiGreen: true };
    const pr = { number: 5033, state: 'OPEN', headRefOid: head, mergeStateStatus: 'BLOCKED',
      labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
      comments: [{ author: { login: 'web-everything' }, body: buildCiHealEscalationComment({ headSha: head, outcome: 'needs-human', reason: 'CodeQL security alert' }) }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      codeqlFailure: { reason: 'security alert' },
    };
    const result = planReconcile({ prs: [pr], requiredChecks: ['test'], verdictSettings });
    const violations = [];
    if (result.notes.some(n => n.kind === 'ci-heal-escalation-moot')) violations.push('CodeQL human escalation declared moot');
    const note = { kind: 'ci-heal-escalation-moot', outcome: 'needs-human', prNumber: pr.number, headSha: head };
    if (planNeedsHumanVoid({ note, pr, repo: 'we', verdictSettings, readRequiredChecks: () => ['test'] })) violations.push('daemon voids CodeQL human escalation');
    return { violations };
  },
  judge(report) { return report.violations; },
};

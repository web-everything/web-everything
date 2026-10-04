/** PR #3826 (2026-10-03/04): card-only PR, an untouched test timed out; the re-run path was off and ineligible. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'card-only-timeout-never-rerun-and-heal-budget-burned',
  title: 'PR #3826: a card-only PR whose untouched test hit the 5000 ms timeout is never eligible for the budget-free re-run (review-gate/aggregate noise, card paths "unknown", feature off by default)',
  card: 'unstick PRs #3850/#3830/#3826 (epic #3383/#4075)',
  fixedBy: { sha: '274c4400b2f756feb89f19430fb7c64c404d3c37', where: 'lane/unstick-3850-3830-3826', paths: ['scripts/conveyor/reconcile-pass.mjs', 'scripts/conveyor/timeout-retry-state.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8').includes('isDerivedTimeoutCheck'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const pass = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const { createRequire } = await import('node:module');
    const ts = createRequire(join(root, 'package.json'))('typescript');
    const violations = [];
    const sources = { 'vite.config.mts': 'export default {};', 'scripts/a.test.mjs': 'import {it} from "vitest"; process.env.X;' };
    const impact = pass.timeoutImpact({ head: 'h', sourceHead: 'h', sources, roots: ['vite.config.mts', 'scripts/a.test.mjs'],
      changed: [{ filename: 'backlog/xw4yqe9-prevention-card.md' }] }, ts);
    if (impact) violations.push(`card-only diff judged impactful: ${impact}`);
    const head = 'b02fe5a3dc2c936f2ba28cc23d41785cf0144015';
    const rollup = [{ name: 'test-shard (2)', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2' }];
    const pr = { number: 3826, state: 'OPEN', headRefOid: head, headRefName: 'lane/x4lad92-request', isDraft: false, labels: [{ name: 'review:pending' }],
      comments: [], statusCheckRollup: rollup };
    const prev = process.env.WE_CI_TIMEOUT_RERUN_ENABLED; delete process.env.WE_CI_TIMEOUT_RERUN_ENABLED;
    let enriched;
    try { enriched = pass.enrichPrsWithTimeoutEvidence([pr], { repo: 'o/r', readBudget: () => ({ confirmed: 0, pending: false }),
      read: () => ({ eligible: true, head, pr: 3826, signature: 's', failures: [], jobs: [] }) }); }
    finally { if (prev !== undefined) process.env.WE_CI_TIMEOUT_RERUN_ENABLED = prev; }
    if (!enriched[0].timeoutRetry) violations.push('timeout re-run evidence is not read by default (feature opt-in)');
    else {
      const plan = planReconcile({ prs: enriched, agents: [], durableCounts: {}, now: Date.parse('2026-10-04T11:50:00Z'), requiredChecks: ['test-shard (2)'] });
      if (!plan.dispatch.some((d) => d.prNumber === 3826 && d.kind === 'ci-timeout-rerun')) violations.push('no ci-timeout-rerun planned for the eligible PR');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};

/** 2026-10-05 GitHub Actions outage (15:11-17:55 ET): required jobs concluded cancelled / no runner, which have no log;
 *  the log read 404'd and the PR was refused `timeout-retry-ineligible` forever, and nothing re-triggered CI. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'infra-cancelled-ci-refused-forever',
  title: 'Outage-cancelled required checks (no runner, no log) are refused timeout-retry-ineligible forever instead of being mechanically re-run',
  card: 'unstick outage PRs 4023/4022/4020/4017/4015 (epic #3383/#4075)',
  fixedBy: { sha: '3257ba1d03bf03a74cf4e39ffcee9830b8c48f3e', where: 'lane/infra-cancelled-ci-rerun', paths: ['scripts/conveyor/infra-cancelled.mjs', 'scripts/conveyor/reconcile-pass.mjs', 'scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8').includes('infraCancelledOnly'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const pass = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const violations = [];
    const repo = 'o/r';
    const head = 'a'.repeat(40);
    const url = (run, job) => `https://github.com/${repo}/actions/runs/${run}/job/${job}`;
    const json = JSON.stringify;
    const exec = (_c, [, path]) => {
      if (/\/pulls\/5$/.test(path)) return json({ head: { sha: head }, base: { sha: 'b' }, state: 'open', changed_files: 1 });
      if (/pulls\/5\/files/.test(path)) return json([{ filename: 'a.ts' }]);
      if (/check-runs/.test(path)) return json({ total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'cancelled', details_url: url(100, 1) }] });
      if (/\/status$/.test(path)) return json({ total_count: 0 });
      if (/actions\/jobs\/1$/.test(path)) return json({ id: 1, run_id: 100, head_sha: head, run_attempt: 1, name: 'test', status: 'completed', conclusion: 'cancelled', runner_name: '', steps: [] });
      if (/actions\/runs\/100$/.test(path)) return json({ id: 100, head_sha: head, run_attempt: 1, path: '.github/workflows/ci.yml', repository: { full_name: repo } });
      if (/\/logs$/.test(path)) throw new Error('Command failed: gh api .../logs\ngh: HTTP 404');
      throw new Error(`unexpected ${path}`);
    };
    const pr = { number: 5, state: 'OPEN', headRefOid: head, headRefName: 'lane/x', isDraft: false, labels: [{ name: 'review:pending' }], comments: [],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: url(100, 1) }] };
    const enriched = pass.enrichPrsWithTimeoutEvidence([pr], { repo, enabled: true, readBudget: () => ({ confirmed: 0, pending: false }),
      read: (p, o) => pass.readTimeoutEvidence(p, { ...o, exec }) });
    const plan = planReconcile({ prs: enriched, agents: [], durableCounts: {}, now: Date.parse('2026-10-05T22:00:00Z'), requiredChecks: ['test'] });
    if (!plan.dispatch.some((d) => d.prNumber === 5 && d.kind === 'ci-timeout-rerun')) {
      violations.push(`no mechanical re-run planned; refusals: ${plan.refusals.map((r) => `${r.kind}:${r.why}`).join(' | ').slice(0, 200)}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};

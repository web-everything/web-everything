/**
 * Live #6873 (2026-11-16): a failed required CI check owed its one-time rerun, but the non-required, workflow-less
 * `red-team` app check stayed pending for hours and the rerun was deferred every tick. Replay through the real planner.
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'ci-rerun-ignores-external-red-team',
  title: 'a pending external red-team check does not defer the owed CI rerun (#6873)',
  card: 'PR #6873',
  fixedBy: { sha: 'uncommitted', where: 'working tree', paths: ['scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    // Detect the fix's presence by a part a regression of the guarded code does not remove: the configured poster in
    // settings plus its loader module. A tree that loses the guard still has both, so the break must pass (red if not).
    try {
      return readFileSync(join(root, 'scripts/conveyor/external-check-apps.mjs'), 'utf8').length > 0
        && (JSON.parse(readFileSync(join(root, 'scripts/settings/fix.json'), 'utf8'))?.fix?.externalCheckApps ?? []).some(e => e?.name === 'red-team');
    } catch { return false; }
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const repo = 'org/repo';
    const head = 'fdae89c7'.padEnd(40, '0');
    const now = Date.parse('2026-11-16T14:00:00Z');
    const failed = { name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-11-16T11:40:00Z',
      detailsUrl: `https://github.com/${repo}/actions/runs/123/job/456` };
    const redTeam = { __typename: 'CheckRun', name: 'red-team', workflowName: '', status: 'IN_PROGRESS', conclusion: '',
      startedAt: '2026-11-16T11:31:00Z', detailsUrl: 'https://example.invalid/app-check', appSlug: 'web-everything', appId: 5037855 };
    const plan = rollup => planReconcile({
      prs: [{ number: 6873, state: 'OPEN', isDraft: true, headRefName: 'lane/x', headRefOid: head, labels: [], mergeStateStatus: 'BLOCKED',
        comments: [], statusCheckRollup: rollup, requiredCheckCompletedAt: failed.completedAt, requiredCheckName: 'test', aheadByOnMain: 0,
        mainGreenNow: { red: false, sha: '123456789abcdef', at: '2026-11-16T07:00:00Z' },
        owedCiRerunRetry: { eligible: true, repo, pr: 6873, head, signature: 's', variant: 'owed-ci-rerun',
          jobs: [{ repo, head, run: 123, job: 456, attempt: 1 }], infraCancelled: true },
        timeoutRetry: { eligible: false, reason: 'timeout-evidence:incomplete-failure-inventory' }, timeoutRetryBudget: { confirmed: 0, rejected: 0 } }],
      agents: [], requiredChecks: ['test'], now, mainRedWindows: [], staleCiRerun: 'once-per-head' });
    const reran = out => out.dispatch.some(r => r.kind === 'ci-timeout-rerun');
    const violations = [];
    if (!reran(plan([failed, redTeam]))) violations.push('owed rerun deferred by pending red-team');
    if (reran(plan([failed, { ...redTeam, appSlug: 'other-app', appId: 42 }]))) violations.push('same-name check from another app did not defer');
    if (reran(plan([failed, { ...redTeam, name: 'test-shard (1)', workflowName: 'CI' }]))) violations.push('live same-workflow check did not defer');
    return { violations };
  },
  judge(report) { return report.violations; },
};

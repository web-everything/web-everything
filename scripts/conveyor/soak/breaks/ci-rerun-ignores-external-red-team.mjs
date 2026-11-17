/**
 * Live #6873 (2026-11-16): a failed required CI check owed its one-time rerun, but the non-required, workflow-less
 * `red-team` app check stayed pending for hours and the rerun was deferred every tick. Replay through the real planner.
 */
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'ci-rerun-ignores-external-red-team',
  title: 'a pending external red-team check does not defer the owed CI rerun (#6873)',
  card: 'PR #6873',
  fixedBy: { sha: 'uncommitted', where: 'working tree', paths: ['scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/open-pr-fetch.mjs'] },
  // fixPresent PROBES BEHAVIOUR: a child process runs the real planner on the #6873 shape and reports whether the live
  // red-team check from the configured app still lets the owed rerun dispatch. No config or loader presence check.
  fixPresent(root) {
    try {
      const self = pathToFileURL(fileURLToPath(import.meta.url)).href;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e',
        `const m = await import(${JSON.stringify(self)}); process.stdout.write(String((await m.scenario(${JSON.stringify(root)})).redTeamReruns));`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
      return out.trim() === 'true';
    } catch { return false; }
  },
  async run({ sourceRoot } = {}) {
    return { violations: (await scenario(sourceRoot)).violations };
  },
  judge(report) { return report.violations; },
};

export async function scenario(sourceRoot) {
  {
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
    // The runner's tick snapshot (open-pr-fetch.mjs → `gh pr list`) carries no app metadata: the REAL producer must
    // hydrate it, or the planner holds on red-team forever (live #6926).
    const { defaultFetchOpenPrs } = await import(pathToFileURL(join(root, 'scripts/conveyor/open-pr-fetch.mjs')).href);
    const { appSlug: _s, appId: _i, ...bare } = redTeam;
    const exec = args => JSON.stringify(args[0] === 'api'
      ? { total_count: 1, check_runs: [{ name: 'red-team', status: 'in_progress', app: { id: 5037855, slug: 'web-everything' } }] }
      : [{ number: 6873, headRefOid: head, statusCheckRollup: [failed, bare] }]);
    const snapshot = defaultFetchOpenPrs({ repo, exec, readComments: () => [] });
    const snapshotReruns = reran(plan(snapshot[0].statusCheckRollup));
    if (!snapshotReruns) violations.push('runner snapshot rows carry no check app: red-team still defers the rerun');
    return { violations, redTeamReruns: reran(plan([failed, redTeam])) && snapshotReruns };
  }
}

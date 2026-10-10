/** PR #4825 review (2026-10-10): the missing-run sweep sent a stacked PR straight to restack with no same-repo check. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = ['web-everything', 'web-everything'].join('/'); // built, not a literal — a stub slug, not a hardcoded target repo
const SHA = 'a'.repeat(40);

export default {
  id: 'stacked-fork-pr-never-restacked',
  title: 'missing-run recovery rebased and force-pushed origin/<head> for a stacked FORK PR, and counted fork refusals wrongly on a non-main default branch',
  card: 'PR #4825 review (epic #3383/#4075)',
  fixedBy: { sha: 'd5fab55709d6bca4c48c94655b08e87b183ae482', where: 'lane/recovery-caps-after-green', paths: ['scripts/conveyor/ci-red-recovery-watch.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs'), 'utf8').includes('defaultReadIsCrossRepository'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { sweepMissingRunRecovery, restackStackedPr, sweepCiRedRecovery, refreshOntoMain } = await import(pathToFileURL(join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs')).href);
    const violations = [];
    const mainRuns = [{ status: 'completed', conclusion: 'success', updatedAt: '2026-10-10T20:13:19Z', headSha: 'b'.repeat(40) }];
    const common = { repo: REPO, readRequiredContexts: () => ['test'], readHeadCommittedAt: () => '2026-10-10T12:00:00Z', now: Date.parse('2026-10-10T21:00:00Z'), mainRuns };

    // 1. A stacked fork PR (base = a same-repo lane head) must reach no refresh at all.
    const parent = { number: 4756, headRefName: 'lane/parent', baseRefName: 'main' };
    const fork = { number: 4759, headRefName: 'lane/child', baseRefName: 'lane/parent', headRefOid: SHA, statusCheckRollup: [] };
    const refreshed = [];
    const posted = [];
    sweepMissingRunRecovery({ ...common, apply: true, readOpenPrs: () => [{ ...parent, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }, fork],
      readComments: () => [], trigger: () => ({ ok: false, action: 'pull-request-push' }), clearLabel: () => false,
      postComment: (n, o) => posted.push([n, o]),
      restack: (d, o) => restackStackedPr(d, { ...o, checkClaim: () => null, readIsCrossRepository: (n) => n === 4759,
        fetchRef: () => ({ ok: true }), refresh: (ref) => { refreshed.push(ref); return { ok: true, action: 'rebased', newCommit: 'x' }; } }) });
    if (refreshed.length) violations.push(`stacked fork PR #4759 was rebased/pushed: ${refreshed.join(', ')}`);
    if (!posted.some(([n, o]) => n === 4759 && o.ok === false)) violations.push('stacked fork PR #4759 left no counted failure marker');

    // 2. A fork refusal on a repo whose default branch is not main must still count toward the cap.
    const refusal = { viewerDidAuthor: true, body: `🚦 conveyor missing-run-recovery\n\nsha: ${SHA}\nPR is stacked or from a fork (base master, head repo someone/else); missing-run push recovery only handles same-repo PRs on master` };
    const plan = sweepMissingRunRecovery({ ...common, defaultBranch: 'master', maxRetriesPerSha: 1, readComments: () => [refusal],
      readOpenPrs: () => [{ number: 7, headRefName: 'lane/f', baseRefName: 'master', headRefOid: SHA, statusCheckRollup: [] }] });
    if (!plan.refusals.some((r) => r.prNumber === 7 && r.kind === 'missing-run-cap-exhausted')) violations.push('non-main default-branch fork refusal was refunded, not counted');
    // 3. The main-red rebase sink: a fork PR (red required check) must never reach rebase+push either.
    const rebased = [];
    const mainRed = [{ status: 'completed', conclusion: 'failure', updatedAt: '2026-09-25T01:30:55Z', workflowName: 'CI' },
      { status: 'completed', conclusion: 'success', updatedAt: '2026-09-25T02:31:25Z', workflowName: 'CI' }];
    const red = sweepCiRedRecovery({ apply: true, readOpenPrs: () => [{ number: 2635, headRefName: 'lane/shadowed', headRefOid: SHA,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-09-25T01:57:47Z' }] }],
    readMainRuns: () => mainRed, readAheadBy: () => 33, readComments: () => [], checkClaim: () => null, postComment: () => {}, readIsCrossRepository: () => true,
    refresh: (ref, o) => refreshOntoMain(ref, { ...o, rebase: (r) => { rebased.push(r.laneRef); return { action: 'rebased', newCommit: 'x' }; } }) });
    if (!red.dispatch.length) violations.push('main-red fixture did not dispatch (scenario is vacuous)');
    if (rebased.length) violations.push(`main-red path rebased/pushed a fork PR's head ref: ${rebased.join(', ')}`);
    return { violations };
  },
  judge(report) { return report.violations; },
};

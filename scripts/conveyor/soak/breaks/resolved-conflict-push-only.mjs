/** #7329 / #7142: launch only a push-only task for an already-resolved repair. */
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'resolved-conflict-push-only',
  title: 'resolved conflict side branch dispatches a push-only brief, never a full re-resolve',
  card: 'PR #7329 / #7142',
  fixedBy: { sha: 'uncommitted', where: 'lane-3', paths: ['scripts/conveyor/resolved-side-branch-io.mjs', 'scripts/conveyor/reconcile-core.mjs'] },
  fixPresent: root => existsSync(join(root, 'scripts/conveyor/resolved-side-branch-io.mjs')),
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const imp = p => import(pathToFileURL(join(root, p)).href);
    const { runTickAllRepos, resolveFixPassBudgets } = await imp('skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
    const { buildConcurrentAuthorPauseComment, AUTOMATION_LOGINS } = await imp('scripts/conveyor/stand-down.mjs');
    const { planReconcile } = await imp('scripts/conveyor/reconcile-core.mjs');
    const { runReconcileFixDispatch, pushOnlyFixBrief } = await imp('scripts/conveyor/reconcile-fix-dispatch.mjs');
    const { workflowEditFact } = await imp('scripts/lib/merge-gate-ci.mjs');
    const H = 'a'.repeat(40), B = 'b'.repeat(40), S = 'c'.repeat(40), order = [], violations = [];
    const saved = { name: 'lane/topic-fix-7329-conflict-alt', sha: S, ancestors: [S, H, B] };
    let pr = { number: 7329, headRefName: 'lane/topic', headRefOid: H, baseRefName: 'main', baseRefOid: B,
      state: 'OPEN', isCrossRepository: false, mergeStateStatus: 'DIRTY',
      comments: [{ body: buildConcurrentAuthorPauseComment({ head: H, alt: saved.name, altSha: S }), author: { login: AUTOMATION_LOGINS[0] } }, { body: 'Reviewer: resolve scripts/x.mjs:1', author: { login: 'web-everything' } }], labels: ['review:human', 'review:changes'] };
    const empty = () => ({ dispatched: [], refusals: [] });
    const mechanical = () => ({ dispatch: [], refusals: [], applied: [] });
    const result = await runTickAllRepos({ repos: ['web-everything/web-everything'],
      fixTick: options => {
        order.push('dispatch-planning');
        return runReconcileFixDispatch({ ...options, root: '/repo',
          checkStaleness: () => ({ fresh: true, behind: 0 }),
          reconcile: () => planReconcile({ prs: [{ ...pr, resolvedSideBranches: [saved] }] }),
          findItemFn: () => null, loadItems: () => [], fetchItemlessDiffPaths: () => ['scripts/x.mjs'],
          pickFreeLanes: () => [1], listBuildClaims: () => [], listFixClaims: () => [],
          priorityShadow: null, tryResumeRound: () => { violations.push('full-round resume attempted'); return { resumed: false }; }, stepLog: () => {},
          dispatch: planned => {
            order.push('push-only-launch');
            if (planned.pushOnly?.sha !== S || planned.pushOnly?.branch !== saved.name || planned.isConflict)
              violations.push('saved repair dispatched as a full re-resolve');
            const brief = pushOnlyFixBrief(planned);
            if (!brief.includes('Do no new conflict work') || !brief.includes(`${saved.name}@${S}`))
              violations.push('push-only brief missing saved repair or no-new-work constraint');
            return { pr: planned.pr };
          },
        });
      },
      ciHealTick: empty, promoteDraftTick: empty, hungCiTick: mechanical,
      mainRedRebaseTick: mechanical, missingRunTick: mechanical,
      notesTick: () => { order.push('question-pass'); return { notes: [], prsByNumber: new Map() }; }, notesDryRun: true,
      awaitVerifyTick: () => ({ rows: [] }), stuckFixerTick: () => ({ rows: [] }),
      orphanGuardTick: null, authGateOverride: () => ({ paused: false }),
      now: () => 0, prCursors: {}, budgetRotation: {}, passBudgets: resolveFixPassBudgets({ env: {}, file: {} }),
    });
    if (result.dispatched?.length !== 1 || order.filter(x => x === 'push-only-launch').length !== 1)
      violations.push('daemon did not dispatch exactly one push-only fixer');
    if (pr.headRefOid !== H) violations.push('planner changed the PR head');
    // The normal launcher pushes later. Preserve the exact labels/comments and discard live ref
    // evidence, as after a restart/deleted saved ref: old findings must never launch a full fixer.
    const pushed = { ...pr, headRefOid: S, mergeStateStatus: 'CLEAN', rowsHead: S, rowsComplete: true,
      statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'success' }] };
    const afterPush = planReconcile({ prs: [pushed], requiredChecks: ['test'], reviewTiming: { startAfter: 'ci-green' } });
    if (afterPush.dispatch.some(row => row.kind === 'fix')
      || !afterPush.dispatch.some(row => row.kind === 'review' && row.resolvedRepairReview?.sha === S))
      violations.push('successful saved-repair push reopened old findings instead of exact-head review');
    const gate = workflowEditFact({ pinnedHead: { sha: S }, gatePaths: { files: ['.github/workflows/ci.yml'] }, acceptance: { humanClearedSha: H } });
    if (gate?.status !== 'hold') violations.push('old-head clearance bypassed the new-head workflow hold');
    return { violations, order };
  },
  judge: report => report.violations,
};

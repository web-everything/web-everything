/** #7329 / #7142: the saved repair must be pushed instead of launching fixer seven/six. */
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'resolved-conflict-push-before-question',
  title: 'resolved conflict side branch pushes before questions without another fixer or a gate bypass',
  card: 'PR #7329 / #7142',
  fixedBy: { sha: 'uncommitted', where: 'lane-37', paths: ['scripts/conveyor/resolved-side-branch-push.mjs', 'scripts/conveyor/reconcile-core.mjs'] },
  fixPresent: root => existsSync(join(root, 'scripts/conveyor/resolved-side-branch-push.mjs')),
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const imp = p => import(pathToFileURL(join(root, p)).href);
    const { runTickAllRepos, resolveFixPassBudgets } = await imp('skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
    const { runResolvedSideBranchPass } = await imp('scripts/conveyor/resolved-side-branch-push.mjs');
    const { buildConcurrentAuthorPauseComment, AUTOMATION_LOGINS } = await imp('scripts/conveyor/stand-down.mjs');
    const { planReconcile } = await imp('scripts/conveyor/reconcile-core.mjs');
    const { runReconcileFixDispatch } = await imp('scripts/conveyor/reconcile-fix-dispatch.mjs');
    const { workflowEditFact } = await imp('scripts/lib/merge-gate-ci.mjs');
    const H = 'a'.repeat(40), B = 'b'.repeat(40), S = 'c'.repeat(40), order = [], violations = [];
    const saved = { name: 'lane/topic-fix-7329-conflict-alt', sha: S, ancestors: [S, H, B] };
    let pr = { number: 7329, headRefName: 'lane/topic', headRefOid: H, baseRefName: 'main', baseRefOid: B,
      state: 'OPEN', isCrossRepository: false, mergeStateStatus: 'DIRTY',
      comments: [{ body: buildConcurrentAuthorPauseComment({ head: H, alt: saved.name, altSha: S }), author: { login: AUTOMATION_LOGINS[0] } }, { body: 'Reviewer: resolve scripts/x.mjs:1', author: { login: 'web-everything' } }], labels: ['review:human', 'review:changes'] };
    const empty = () => ({ dispatched: [], refusals: [] });
    const mechanical = () => ({ dispatch: [], refusals: [], applied: [] });
    const result = await runTickAllRepos({ repos: ['web-everything/web-everything'],
      resolvedSideBranchSetting: { value: true, source: 'standard' },
      resolvedSideBranchStaleGuard: () => {},
      resolvedSideBranchTick: ({ repo }) => runResolvedSideBranchPass({ repo }, {
        listPrs: () => [pr], readBranches: () => [saved], readPr: () => pr,
        acquireClaim: () => ({ ok: true }), checkClaim: () => true, releaseClaim: () => {},
        admitPush: () => true, protect: ({ bodies }) => { pr = { ...pr, comments: [...pr.comments, ...bodies.map(body => ({ body, author: { login: AUTOMATION_LOGINS[0] } }))] }; },
        appToken: () => 'ghs_soak',
        preparePush: () => ({ verification: { sha: S, status: 'green' },
          push: () => { order.push('push'); pr = { ...pr, headRefOid: S }; }, close: () => {} }),
        record: () => order.push('record'), log: () => {},
      }),
      fixTick: options => {
        order.push('dispatch-planning');
        return runReconcileFixDispatch({ ...options, root: '/repo',
          checkStaleness: () => ({ fresh: true, behind: 0 }),
          reconcile: () => planReconcile({ prs: [{ ...pr, resolvedSideBranches: [saved] }] }),
          findItemFn: () => null, loadItems: () => [], fetchItemlessDiffPaths: () => ['scripts/x.mjs'],
          pickFreeLanes: () => [1], listBuildClaims: () => [], listFixClaims: () => [],
          priorityShadow: null, tryResumeRound: null, stepLog: () => {},
          dispatch: () => { violations.push('fresh fixer launched for saved repair'); return {}; },
        });
      },
      ciHealTick: empty, promoteDraftTick: empty, hungCiTick: mechanical,
      mainRedRebaseTick: mechanical, missingRunTick: mechanical,
      notesTick: () => { order.push('question-pass'); return { notes: [], prsByNumber: new Map() }; }, notesDryRun: true,
      awaitVerifyTick: () => ({ rows: [] }), stuckFixerTick: () => ({ rows: [] }),
      orphanGuardTick: null, authGateOverride: () => ({ paused: false }),
      now: () => 0, prCursors: {}, budgetRotation: {}, passBudgets: resolveFixPassBudgets({ env: {}, file: {} }),
    });
    if (result.resolvedSideBranches?.[0]?.result !== 'pushed' || pr.headRefOid !== S) violations.push('daemon did not push the saved repair');
    if (order[0] !== 'push' || order[1] !== 'record' || order.indexOf('question-pass') < order.indexOf('push')) violations.push('question/state preceded push');
    const gate = workflowEditFact({ pinnedHead: { sha: S }, gatePaths: { files: ['.github/workflows/ci.yml'] }, acceptance: { humanClearedSha: H } });
    if (gate?.status !== 'hold') violations.push('old-head clearance bypassed the new-head workflow hold');
    return { violations, order };
  },
  judge: report => report.violations,
};

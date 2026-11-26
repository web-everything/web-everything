/** PR #7532: an answered unknown-cause stand-down left its durable park blocking repairs. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'unknown-cause-operator-answer',
  title: 'an operator answer releases only the unknown-cause episode it answers',
  card: 'PR #7532 / x1b8hlo',
  fixedBy: { sha: 'uncommitted', where: 'lane/fixer-l2-unproductive-count', paths: [
    'scripts/conveyor/reconcile-fix-dispatch.mjs', 'scripts/operations/ci-heal-pr-dispatch.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs'), 'utf8')
      .includes('export function releaseAnsweredUnknownCause');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const load = p => import(pathToFileURL(join(root, p)).href);
    const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
    const { runReconcileFixDispatch } = await load('scripts/conveyor/reconcile-fix-dispatch.mjs');
    const { runReconcileCiHealDispatch } = await load('scripts/operations/ci-heal-pr-dispatch.mjs');
    const { buildStandDownComment } = await load('scripts/conveyor/stand-down.mjs');
    const { buildOperatorAnswer } = await load('scripts/conveyor/stand-down-answer-core.mjs');
    const head = 'a'.repeat(40), now = Date.parse('2026-11-26T12:00:00Z');
    const comments = [
      { author: { login: 'web-everything' }, body: '🔁 human review — changes requested\n\nRepair the admitted finding.' },
      { id: 'SD1', author: { login: 'web-everything' }, createdAt: new Date(now - 2000).toISOString(),
        body: buildStandDownComment({ reason: 'fix-cause-unknown', head }) },
      { id: 'ANS1', author: { login: 'chalbert' }, createdAt: new Date(now - 1000).toISOString(),
        body: buildOperatorAnswer({ standDownId: 'SD1', actor: 'chalbert', channel: 'chat', reason: 'Retry the repair' }) },
    ];
    const pr = { number: 1764, headRefName: 'lane/unknown-cause', headRefOid: head,
      state: 'OPEN', isDraft: false, baseRefName: 'main', mergeStateStatus: 'CLEAN',
      labels: ['review:changes'], comments, commits: [], statusCheckRollup: [] };
    const park = { v: 1, kind: 'park', repo: 'we', pr: pr.number, head,
      reason: 'fix-cause-unknown', at: comments[1].createdAt };
    const violations = [], cases = [];
    const variants = ['persisted', 'interrupted', 'invalid-cause', 'new-failure', 'new-failure-with-park',
      'new-park', 'untrusted', 'unreadable', 'wrong-head', 'missing-time', 'same-time', 'future-answer', 'new-question'];
    const scenarios = ['fix', 'ci-heal'].flatMap(mode => variants.map(variant => ({ mode, variant })));
    for (const { mode, variant } of scenarios) {
      const thread = comments.map(c => ({ ...c }));
      if (variant === 'untrusted') thread[2].author = { login: 'outsider' };
      if (variant === 'wrong-head') thread[1].body = buildStandDownComment({ reason: 'fix-cause-unknown', head: 'b'.repeat(40) });
      if (variant === 'missing-time') delete thread[2].createdAt;
      if (variant === 'future-answer') thread[2].createdAt = new Date(now + 1000).toISOString();
      if (variant === 'new-question') thread.push({ ...thread[1], id: 'SD2', createdAt: new Date(now - 500).toISOString() });
      const execute = mode === 'fix' ? runReconcileFixDispatch : runReconcileCiHealDispatch;
      const result = await execute({ root, now, dryRun: false, priorityShadow: null,
        landingBlockedState: { read: () => new Map(), write: () => {} }, shadowDeps: { mode: 'off' },
        checkStaleness: () => ({ fresh: true }), netScope: null, prStack: null,
        reconcile: () => planReconcile({ prs: [{ ...pr, comments: thread,
          statusCheckRollup: mode === 'fix' ? [] : [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
          timeoutRetry: { eligible: false, reason: 'log-unreadable' },
        }], agents: [], durableCounts: {}, now, requiredChecks: ['test'], shadowDeps: { mode: 'off' } }),
        readPrComments: () => { if (variant === 'unreadable') throw Error('disk'); return thread; },
        fixConfig: { hold: true, maxSessions: 3, windowHours: 6 },
        fixLoop: { readRows: () => variant === 'interrupted' || variant === 'new-failure' ? []
          : [{ ...park, ...(variant === 'new-park' ? { at: new Date(now - 500).toISOString() }
            : variant === 'same-time' ? { at: thread[2].createdAt } : {}) }],
        append: () => {}, killed: () => false, currentBuild: () => 'b'.repeat(40),
        readRouted: () => ({ 'we#1764': [{ head,
          at: variant.startsWith('new-failure') ? now - 500 : variant === 'same-time' ? now - 1000 : now - 3000,
          outcome: 'failed', cause: variant === 'invalid-cause' ? 'invalid' : 'unknown' }] }) },
        findItemFn: () => null, loadItems: () => [],
        fetchItemlessDiffPaths: () => ['scripts/conveyor/reconcile-fix-dispatch.mjs'],
        flushOwed: () => ({}), pollAttempts: () => [], flushTimeouts: () => [], timeoutHold: () => null,
        salvage: () => null, resolveWorkUnit: () => ({ itemNum: null, scope: [] }),
        pickFreeLanes: () => [1], tryResume: () => ({ resumed: false }), tryResumeRound: null,
        readPushHold: () => null, listBuildClaims: () => [], listFixClaims: () => [],
        dispatch: () => ({ agentId: 'soak-stub' }),
      });
      const expected = ['persisted', 'interrupted', 'invalid-cause', 'same-time'].includes(variant) ? 1 : 0;
      cases.push({ mode, variant, dispatched: result.dispatched.length, expected,
        refusals: [...result.reconcileRefusalDetails, ...result.refusals].map(r => r.kind) });
      if (result.dispatched.length !== expected) violations.push(`${mode}/${variant}: expected ${expected} dispatch, got ${result.dispatched.length}`);
    }
    return { violations, cases };
  },
  judge(report) { return report.violations; },
};

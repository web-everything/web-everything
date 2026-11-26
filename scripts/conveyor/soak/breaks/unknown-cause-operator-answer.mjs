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
    'scripts/operations/fix-run.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/operations/fix-run.mjs'), 'utf8')
      .includes('export async function recordUnknownCausePark');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const load = p => import(pathToFileURL(join(root, p)).href);
    const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
    const { runReconcileFixDispatch } = await load('scripts/conveyor/reconcile-fix-dispatch.mjs');
    const { runReconcileCiHealDispatch } = await load('scripts/operations/ci-heal-pr-dispatch.mjs');
    const { buildStandDownComment } = await load('scripts/conveyor/stand-down.mjs');
    const { buildOperatorAnswer } = await load('scripts/conveyor/stand-down-answer-core.mjs');
    const { recordUnknownCausePark } = await load('scripts/operations/fix-run.mjs');
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
      'new-park', 'untrusted', 'unreadable', 'wrong-head', 'missing-time', 'same-time', 'future-answer', 'new-question',
      'lifecycle-routed', 'lifecycle-claude'];
    const scenarios = ['fix', 'ci-heal'].flatMap(mode => variants.map(variant => ({ mode, variant })));
    for (const { mode, variant } of scenarios) {
      const thread = comments.map(c => ({ ...c }));
      const lifecycle = variant.startsWith('lifecycle-'), episodeRows = [];
      if (lifecycle) {
        if (!recordUnknownCausePark) { violations.push(`${mode}/${variant}: missing renewed park publication`); continue; }
        thread.splice(1);
        const fail = at => recordUnknownCausePark({ repo: 'we', pr: pr.number, head, now: at,
          readLoopRows: () => episodeRows, readComments: () => thread,
          appendLoopRow: row => episodeRows.push({ ...row, v: 1, at: new Date(at).toISOString() }),
          postComment: body => thread.push({ id: `SD${thread.length}`, author: { login: 'web-everything' },
            createdAt: new Date(at).toISOString(), body }) });
        await fail(now - 3000);
        thread.push({ author: { login: 'chalbert' }, createdAt: new Date(now - 2000).toISOString(),
          body: buildOperatorAnswer({ standDownId: thread.at(-1).id, actor: 'chalbert', channel: 'chat', reason: 'Retry' }) });
        await fail(now - 500);
        if (episodeRows.length !== 2 || thread.filter(c => c.id?.startsWith('SD')).length !== 2)
          violations.push(`${mode}/${variant}: second failure did not publish a fresh stand-down`);
      }
      if (variant === 'untrusted') thread[2].author = { login: 'outsider' };
      if (variant === 'wrong-head') thread[1].body = buildStandDownComment({ reason: 'fix-cause-unknown', head: 'b'.repeat(40) });
      if (variant === 'missing-time') delete thread[2].createdAt;
      if (variant === 'future-answer') thread[2].createdAt = new Date(now + 1000).toISOString();
      if (variant === 'new-question') thread.push({ ...thread[1], id: 'SD2', createdAt: new Date(now - 500).toISOString() });
      const execute = mode === 'fix' ? runReconcileFixDispatch : runReconcileCiHealDispatch;
      const executePass = () => execute({ root, now, dryRun: false, priorityShadow: null,
        landingBlockedState: { read: () => new Map(), write: () => {} }, shadowDeps: { mode: 'off' },
        checkStaleness: () => ({ fresh: true }), netScope: null, prStack: null,
        reconcile: () => planReconcile({ prs: [{ ...pr, comments: thread,
          statusCheckRollup: mode === 'fix' ? [] : [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
          timeoutRetry: { eligible: false, reason: 'log-unreadable' },
        }], agents: [], durableCounts: {}, now, requiredChecks: ['test'], shadowDeps: { mode: 'off' } }),
        readPrComments: () => { if (variant === 'unreadable') throw Error('disk'); return thread; },
        fixConfig: { hold: true, maxSessions: 3, windowHours: 6 },
        fixLoop: { readRows: () => lifecycle ? episodeRows : variant === 'interrupted' || variant === 'new-failure' ? []
          : [{ ...park, ...(variant === 'new-park' ? { at: new Date(now - 500).toISOString() }
            : variant === 'same-time' ? { at: thread[2].createdAt } : {}) }],
        append: () => {}, killed: () => false, currentBuild: () => 'b'.repeat(40),
        readRouted: () => variant === 'lifecycle-claude' ? {} : ({ 'we#1764': [{ head,
          at: lifecycle || variant.startsWith('new-failure') ? now - 500 : variant === 'same-time' ? now - 1000 : now - 3000,
          outcome: 'failed', cause: variant === 'invalid-cause' ? 'invalid' : 'unknown' }] }) },
        findItemFn: () => null, loadItems: () => [],
        fetchItemlessDiffPaths: () => ['scripts/conveyor/reconcile-fix-dispatch.mjs'],
        flushOwed: () => ({}), pollAttempts: () => [], flushTimeouts: () => [], timeoutHold: () => null,
        salvage: () => null, resolveWorkUnit: () => ({ itemNum: null, scope: [] }),
        pickFreeLanes: () => [1], tryResume: () => ({ resumed: false }), tryResumeRound: null,
        readPushHold: () => null, listBuildClaims: () => [], listFixClaims: () => [],
        dispatch: () => ({ agentId: 'soak-stub' }),
      });
      const result = await executePass();
      const expected = ['persisted', 'interrupted', 'invalid-cause', 'same-time'].includes(variant) ? 1 : 0;
      cases.push({ mode, variant, dispatched: result.dispatched.length, expected,
        refusals: [...result.reconcileRefusalDetails, ...result.refusals].map(r => r.kind) });
      if (result.dispatched.length !== expected) violations.push(`${mode}/${variant}: expected ${expected} dispatch, got ${result.dispatched.length}`);
      if (lifecycle) {
        thread.push({ author: { login: 'chalbert' }, createdAt: new Date(now - 100).toISOString(),
          body: buildOperatorAnswer({ standDownId: thread.at(-1).id, actor: 'chalbert', channel: 'chat', reason: 'Retry the new failure' }) });
        const recovered = await executePass();
        if (recovered.dispatched.length !== 1) violations.push(`${mode}/${variant}: new answer did not recover dispatch`);
      }
    }
    for (const cause of ['input', 'launcher', 'infra', 'model']) {
      for (const path of ['build-change', 'window', 'raw-ceiling', 'persisted-build-change', 'persisted-window', 'persisted-raw-ceiling']) {
        const sessions = Array.from({ length: path === 'raw-ceiling' ? 4 : 3 }, (_, i) => ({ v: 1,
          repo: 'we', pr: pr.number, head, kind: 'ci-heal', session: `soak-${i}`,
          at: new Date(now - 4 * 3600000).toISOString(), build: path.endsWith('build-change') ? 'old' : 'current' }));
        const rows = [...sessions];
        if (path.startsWith('persisted-')) rows.push({ ...sessions[0], kind: 'rearm',
          at: new Date(now - 3 * 3600000).toISOString(), reason: path.endsWith('raw-ceiling')
            ? 'final attempt before raw per-head session ceiling' : `fixer ${path}` });
        let promoted = null;
        const result = await runReconcileCiHealDispatch({ root, now,
          reconcile: () => ({ dispatch: [{ kind: 'ci-heal', prNumber: pr.number, headRefName: pr.headRefName, headRefOid: head }], refusals: [] }),
          checkStaleness: () => ({ fresh: true }), flushOwed: () => ({}), pollAttempts: () => [],
          flushTimeouts: () => [], timeoutHold: () => null, salvage: () => null, queueAdmission: null,
          resolveWorkUnit: () => ({ itemNum: null, scope: [] }), pickFreeLanes: () => [1],
          fixConfig: { hold: true, maxSessions: 3, windowHours: 6 },
          fixLoop: { killed: () => false, readRows: () => rows, append: () => {}, currentBuild: () => 'current',
            readSessionLog: () => '', readRouted: () => ({ 'we#1764': sessions.map(row => ({ head,
              at: Date.parse(row.at), outcome: 'no-change', cause })) }) },
          dispatch: planned => { promoted = planned.strongerModel === true; return { agentId: 'soak-stub' }; },
        });
        cases.push({ cause, path, promoted, dispatched: result.dispatched.length });
        if (result.dispatched.length !== 1 || promoted !== (cause === 'model')) violations.push(`${cause}/${path}: unexpected model promotion or refusal`);
      }
    }
    return { violations, cases };
  },
  judge(report) { return report.violations; },
};

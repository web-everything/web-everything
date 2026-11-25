/** PR #7467 review reproduction: live holds blocked repairs owed by the real planner. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const DISPATCH = 'scripts/conveyor/reconcile-fix-dispatch.mjs';

// Exercise the real final launch gate through its other production caller. All effects are ports.
export async function probeHeldLandAdvanceBatch({ sourceRoot = ROOT, hold = 'red-team:pending' } = {}) {
  const { dispatchFix } = await import(pathToFileURL(join(sourceRoot, DISPATCH)).href);
  const { createLandAdvanceApplier } = await import(pathToFileURL(join(sourceRoot, 'scripts/operations/land-advance-io.mjs')).href);
  const calls = [], spawned = [], released = [], ledger = [], queued = [];
  const rows = [1, 2].map(pr => ({ subject: `we#${pr}`, repo: 'we', pr, owedAction: 'dispatch-fix',
    fixPlan: { itemNum: '3438', pr, laneRef: `topic-${pr}`, scope: [`we:src/pr-${pr}.mjs`],
      labels: ['review:changes', hold], isConflict: hold === 'review:held-mechanical' } }));
  const result = await createLandAdvanceApplier({
    now: () => Date.parse('2026-11-25T00:00:00Z'), pickFixLane: () => 4,
    readCapacity: () => ({ sessions: [], freeLanes: 1, load: 0 }),
    writeLedger: entry => ledger.push(entry.target), queueItem: num => queued.push(num),
    dispatchFix: (planned, options) => {
      calls.push(planned.pr);
      return dispatchFix(planned, { ...options, root: '/repo',
        readBrief: () => '{{PR_NUM}} {{LANE_REF}} {{LANE}} {{SESSION_SLUG}} {{SCOPE}}',
        readFixClaim: () => null, readHistoryInputs: () => null, acquireClaim: () => ({ ok: true }),
        releaseClaim: ({ pr }) => released.push(pr), stampExecutor: () => {},
        postNotice: () => {}, wrapFix: false, grantConflictHelper: () => {}, advisorFor: () => ({ enabled: false }),
        sessionCwdFor: () => '/scratch/fix', ensureSessionCwd: p => p,
        isolateSession: () => ({}), resolveSettingsEnv: () => null,
        readPushHoldOptions: { hermetic: false, run: () => {
          if (planned.pr === 1 && hold === 'unreadable') throw Error('gh timeout');
          return JSON.stringify({ state: 'OPEN', labels: planned.pr === 1 ? [{ name: hold }] : [] });
        } },
        spawnAgent: () => { spawned.push(planned.pr); return `backgrounded · agent-${planned.pr} · fix-${planned.pr}`; },
      });
    },
  })({ errors: [], rows, proposed: rows, capacity: { budget: 1 }, items: { proposed: [{ num: '7' }] } },
    { prs: true, items: true });
  return { result, calls, spawned, released, ledger, queued };
}

export default {
  id: 'fix-push-hold-repair-starvation',
  title: 'owed repairs survive their own holds and held work preserves dispatch capacity',
  card: 'PR #7467 live spawn hold review findings',
  fixedBy: { sha: 'pending', where: 'lane/push-gate-s4', paths: [DISPATCH] },
  fixPresent(root) {
    try {
      const source = readFileSync(join(root, DISPATCH), 'utf8');
      return source.includes('const humanRepair =') && source.includes('const admissionHold =')
        && source.includes('if (pushHoldRefused) return pushHoldRefused;');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs')).href);
    const { runReconcileFixDispatch } = await import(pathToFileURL(join(sourceRoot, DISPATCH)).href);
    const { ADVISORY_NOTE_MARKER } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/advisory-fix-mark.mjs')).href);
    const sendBack = JSON.parse(readFileSync(join(sourceRoot, 'scripts/conveyor/__tests__/fixtures/pr7312-red-team-send-back.json'), 'utf8'));
    const head = 'a'.repeat(40), now = Date.parse('2026-11-24T12:00:00Z');
    const violations = [];
    const pass = (entries, labelsFor, cap = Infinity) => {
      let admitted = 0, demand = 0;
      const launches = [];
      const result = runReconcileFixDispatch({ root: '/repo', repo: 'we', dryRun: false,
        reconcile: () => ({ dispatch: entries, refusals: [] }),
        checkStaleness: () => ({ fresh: true, behind: 0 }),
        readPushHoldOptions: { hermetic: false, run: argv => JSON.stringify({ state: 'OPEN',
          labels: labelsFor(Number(argv[2])).map(name => ({ name })) }) },
        dispatchThrottle: { tryAdmit: () => ({ admit: ++admitted <= cap, kind: 'fix-cap' }) },
        queueAdmission: { tryAdmit: () => ({ admit: ++demand <= cap }) },
        fetchItemlessDiffPaths: pr => [`src/pr-${pr}.mjs`], findItemFn: () => null, loadItems: () => [],
        listBuildClaims: () => [], listFixClaims: () => [], pickFreeLanes: () => [4], priorityShadow: null,
        tryResume: () => ({ resumed: false }), tryResumeRound: null, stepLog: () => {},
        dispatch: entry => { launches.push(entry.pr); return { pr: entry.pr }; },
      });
      return { result, launches, admitted, demand };
    };
    for (const [labels, comments, expectedMode] of [
      [['review:changes', 'review:human'], [{
        body: '🔁 human review — changes requested\n\nRepair the admitted finding.',
      }], undefined],
      [['review:human', 'advisory:changes'], [{ author: { login: 'web-everything' },
        body: `${ADVISORY_NOTE_MARKER}\n\nRepair the admitted finding.` }], 'advisory-fix'],
      [['review:changes', 'red-team:blocked'], [sendBack], undefined],
    ]) {
      const pr = { number: 1764, state: 'OPEN', isDraft: false, headRefName: 'topic', headRefOid: head,
        baseRefName: 'main', labels: labels.map(name => ({ name })), comments, mergeStateStatus: 'CLEAN',
        rowsComplete: true, rowsHead: head,
        statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
      const plan = planReconcile({ prs: [pr], agents: [], now });
      if (!plan.dispatch.some(entry => entry.kind === 'fix' && entry.mode === expectedMode)) {
        violations.push(`fixture did not reach planner repair ${expectedMode ?? 'red-team send-back'}`);
        continue;
      }
      const outcome = pass(plan.dispatch, () => labels);
      log?.(JSON.stringify({ labels, launches: outcome.launches, refusals: outcome.result.refusals }));
      if (outcome.launches.join(',') !== '1764') violations.push(`owed repair stalled on ${labels.join(',')}`);
    }
    const entries = [1764, 1765].map(prNumber => ({ kind: 'fix', prNumber, headRefName: `topic-${prNumber}` }));
    const outcome = pass(entries, pr => pr === 1764 ? ['review:human'] : [], 1);
    if (outcome.launches.join(',') !== '1765' || outcome.admitted !== 1 || outcome.demand !== 1
      || outcome.result.handled !== 1) violations.push('held first entry consumed dispatch capacity');
    const batch = await probeHeldLandAdvanceBatch({ sourceRoot });
    log?.(JSON.stringify(batch));
    if (batch.result.errors.length || batch.spawned.join(',') !== '2' || batch.released.join(',') !== '1'
      || batch.ledger.join(',') !== 'we#2' || batch.queued.join(',') !== '7'
      || batch.result.deferred[0]?.reason !== 'push-hold') violations.push('held land-advance row aborted later fixes or item queueing');
    return { violations };
  },
  judge: report => report.violations,
};

/** Replay slow serial passes and judge only emitted gate timestamps, independent of scheduler state. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export function completedSliceTimestamps(lines) {
  return lines.flatMap(line => {
    const match = /^ci-heal-pr-dispatch: gate slice (?:admitted|refused|done) at=(\S+)$/.exec(line);
    const at = match ? Date.parse(match[1]) : NaN;
    return Number.isFinite(at) ? [at] : [];
  });
}

export async function cadenceProbe({ root = process.env.SOAK_TREE_ROOT || ROOT, dropRecoveryHook = false } = {}) {
  const load = path => import(pathToFileURL(join(root, path)).href);
  const daemon = await load('skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
  const { runReconcileFixDispatch } = await load('scripts/conveyor/reconcile-fix-dispatch.mjs');
  const recovery = await load('scripts/conveyor/ci-red-recovery-watch.mjs');
  const { runReconcilePromoteDraftDispatch } = await load('scripts/operations/promote-draft-pr-dispatch.mjs');
  let time = 0;
  const lines = [], exercised = { fix: 0, recovery: 0, promote: 0, notes: 0 };
  const advance = phase => { time += 30000; exercised[phase]++; };
  const empty = () => ({ dispatched: [], applied: [], refusals: [], notes: [], prsByNumber: new Map() });
  const entries = count => Array.from({ length: count }, (_, i) => ({ prNumber: i + 1,
    headRefName: `fixture-${i}`, headRefOid: `head-${i}` }));
  const fresh = () => ({ fresh: true, behind: 0 });
  const options = { repos: ['we'], now: () => time, fenceOk: () => true, log: line => lines.push(line),
    authGateOverride: () => ({ paused: false }), notesDryRun: true,
    passBudgets: Object.fromEntries(['fixMs', 'notesMs', 'mainRedRebaseMs', 'promoteDraftMs'].map(key => [key, { value: 2400000 }])),
    fixTick: options => runReconcileFixDispatch({ ...options, repo: null, root,
      checkStaleness: fresh, reconcile: () => ({ dispatch: entries(16).map(e => ({ ...e, kind: 'fix' })), refusals: [] }),
      findItemFn: () => null, loadItems: () => [], fetchItemlessDiffPaths: pr => [`src/${pr}.ts`],
      pickFreeLanes: () => entries(16).map(e => e.prNumber), listBuildClaims: () => [], listFixClaims: () => [],
      priorityShadow: null, tryResume: () => ({ resumed: false }), tryResumeRound: null, stepLog: () => {},
      dispatch: () => { advance('fix'); return { agentId: 'fixture' }; },
    }),
    ciHealTick: empty,
    hungCiTick: options => recovery.sweepHungCiRecovery({ ...options, readOpenPrs: () => [] }),
    mainRedRebaseTick: options => recovery.sweepCiRedRecovery({ ...options,
      ...(dropRecoveryHook ? { maybeCiHealSlice: undefined } : {}),
      requiredCheck: 'test', readOpenPrs: () => entries(16).map(e => ({ ...e, number: e.prNumber,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-09-25T01:57:47Z' }] })),
      readMainRuns: () => [
        { status: 'completed', conclusion: 'failure', updatedAt: '2026-09-25T01:30:55Z', workflowName: 'CI' },
        { status: 'completed', conclusion: 'success', updatedAt: '2026-09-25T02:31:25Z', workflowName: 'CI' }],
      readMainLatestCheckRuns: () => [], readAheadBy: () => 33,
      readComments: () => { advance('recovery'); return []; }, readPriority: () => null,
      checkClaim: () => null, refresh: () => ({ ok: true, action: 'current' }), postComment: () => {},
    }),
    missingRunTick: options => recovery.sweepMissingRunRecovery({ ...options, readOpenPrs: () => [],
      readRequiredContexts: () => [], readDeclaredContexts: () => [], readAttributedRequiredChecks: () => [] }),
    promoteDraftTick: options => runReconcilePromoteDraftDispatch({ ...options, root,
      checkStaleness: fresh, provider: {},
      reconcile: () => ({ dispatch: entries(32).map(e => ({ ...e, kind: 'promote-draft' })), refusals: [] }),
      readHeadCheckState: () => { advance('promote'); return { state: 'red', why: 'fixture refuses write' }; },
    }),
    // Only the reader is injected: the daemon owns the real per-note loop and its boundaries.
    // The final zero-cost note exercises the boundary after the last slow note IO.
    notesTick: () => ({ notes: entries(17).map(e => ({ ...e, kind: 'ci-heal-escalation-moot' })),
      prsByNumber: { get: pr => { if (pr <= 16) advance('notes'); return undefined; } } }),
    awaitVerifyTick: () => ({ rows: [] }), stuckFixerTick: () => ({ rows: [] }),
    supersedeTick: () => ({ rows: [] }), orphanGuardTick: null,
    budgetRotation: {}, prCursors: {},
  };
  for (let pass = 0; pass < 3; pass++) await daemon.runTickAllRepos(options);
  const timestamps = completedSliceTimestamps(lines);
  const boundaries = [0, ...timestamps, time];
  const gaps = boundaries.slice(1).map((at, i) => at - boundaries[i]);
  return { lines, timestamps, exercised, elapsedMs: time, maxGapMs: Math.max(...gaps) };
}

const b = {
  id: 'ci-heal-own-loop-cadence',
  title: 'ci-heal gate slices continue during forty-minute serial fix-daemon passes',
  card: 'ci-heal-own-loop-cadence',
  required: true,
  fixedBy: { sha: 'working-tree', where: 'cooperative fix-daemon slices', paths: ['skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'] },
  // The registry expects a synchronous predicate. Run the actual daemon fixture in a bounded subprocess,
  // never inspect source markers or ask the slicer whether it considers itself healthy.
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e',
        `import { cadenceProbe } from ${JSON.stringify(import.meta.url)};` +
        " const report = await cadenceProbe({root: process.env.CADENCE_ROOT}); process.stdout.write(JSON.stringify(report));"],
      { env: { ...process.env, VITEST: '1', CADENCE_ROOT: root }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const report = JSON.parse(output);
      return report.elapsedMs === 7200000 && report.timestamps.length >= 48 && report.maxGapMs <= 150000;
    } catch { return false; }
  },
  run: cadenceProbe,
  judge(report) {
    const failures = [];
    if (report.elapsedMs !== 7200000) failures.push('fixture did not exercise two simulated hours');
    if (!report.exercised || Object.values(report.exercised).some(count => count < 48)) failures.push('real PR loops were not fully exercised');
    if (report.timestamps.length < 48) failures.push('too few logged gate slices');
    if (!(report.maxGapMs <= 150000)) failures.push(`logged gate gap ${report.maxGapMs}ms exceeds 150000ms`);
    return failures;
  },
};
export default b;

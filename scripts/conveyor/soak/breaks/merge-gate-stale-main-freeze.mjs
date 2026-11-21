import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'merge-gate-stale-main-freeze',
  title: 'automatic main freeze on merge-gate reruns once after main recovers while review proceeds',
  card: 'stale automatic main-CI freeze recovery',
  fixedBy: { sha: 'HEAD', where: 'merge-gate classification and existing rerun executor', paths: [
    'scripts/lib/merge-gate-hold-class.mjs', 'scripts/conveyor/reconcile-core.mjs', 'scripts/operations/ci-heal-pr-dispatch.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/merge-gate-hold-class.mjs'), 'utf8').includes('mergeGateStaleFreeze')
      && readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes("variant: 'stale-main-freeze'");
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const load = path => import(pathToFileURL(join(root, path)).href);
    const { excusePrMergeGateHolds, readMergeGateVerdict } = await load('scripts/lib/merge-gate-hold-class.mjs');
    const { GATE_IDS } = await load('scripts/lib/merge-gate-inventory.mjs');
    const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
    const { executeOwedCiReruns } = await load('scripts/conveyor/owed-ci-rerun-executor.mjs');
    const { dispatchTimeoutRetry } = await load('scripts/operations/ci-heal-pr-dispatch.mjs');
    const dir = mkdtempSync(join(process.env.TMPDIR, 'stale-freeze-soak-'));
    const violations = [], head = 'a'.repeat(40), repo = 'web-everything/web-everything';
    let writes = 0;
    const log = ['#7266: HOLD', ...GATE_IDS.map(id => id === 'red-main-freeze'
      ? `  hold  ${id}  main is RED (freeze: main CI red since ${head})` : `  pass  ${id}  ok`), 'merge-gate: HOLD — held'].join('\n');
    const pr = { number: 7266, state: 'OPEN', headRefOid: head, headRefName: 'lane/freeze-soak',
      mergeStateStatus: 'CLEAN', labels: [{ name: 'review:pending' }], comments: [],
      statusCheckRollup: [{ name: 'merge-gate', id: 123, status: 'completed', conclusion: 'failure' }] };
    const job = { head_sha: head, completed_at: '2026-11-18T10:00:00Z', run_id: 42, run_attempt: 1 };
    const readMainCi = () => ({ status: 'completed', conclusion: 'success', completed_at: '2026-11-18T11:00:00Z' });
    try {
      for (const tick of [0, 1, 2]) {
        const prs = excusePrMergeGateHolds([pr], { repo, mergeGateSetting: 'on', readMainCi,
          readMergeGateVerdict: args => readMergeGateVerdict({ ...args, cache: new Map(),
            runGh: argv => argv.at(-1).endsWith('/logs') ? log : JSON.stringify(job) }) });
        const plan = planReconcile({ prs, agents: [], requiredChecks: ['merge-gate'], reviewTiming: { startAfter: 'ci-green' } });
        if (!plan.dispatch.some(r => r.kind === 'review')) violations.push(`tick ${tick}: review blocked by stale freeze`);
        if (plan.dispatch.some(r => r.kind === 'ci-heal')) violations.push(`tick ${tick}: stale freeze owes a heal`);
        if (prs[0].statusCheckRollup[0].conclusion !== 'failure') violations.push('check was marked successful');
        const result = await executeOwedCiReruns({ rows: plan.dispatch, repo, checkStaleness: () => ({ fresh: true, behind: 0 }),
          dispatchRetry: evidence => dispatchTimeoutRetry(evidence, { repo, dir, readMainCi,
            effects: { observe: () => ({ repo, head, runHead: head, open: true, run: 42, job: 123, jobRun: 42,
              attempt: 1, jobAttempt: 1, jobName: 'merge-gate', status: 'completed', conclusion: 'failure' }),
            request: () => { writes++; return { status: 'confirmed' }; } } }) });
        if (tick === 0 && result.requested.length !== 1) violations.push('first tick did not rerun merge-gate');
        if (tick > 0 && !result.refused.some(r => r.reason.includes('stale-freeze-rerun-spent'))) violations.push('spent rerun lacked operator fallback');
      }
      if (writes !== 1) violations.push(`expected one request across ticks/reloads, got ${writes}`);
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};

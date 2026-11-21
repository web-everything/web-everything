import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'merge-gate-stale-main-freeze',
  title: 'automatic main freeze on merge-gate reruns once after main recovers while review proceeds',
  card: 'stale automatic main-CI freeze recovery',
  fixedBy: { sha: 'HEAD', where: 'merge-gate classification and existing rerun executor', paths: [
    'scripts/lib/merge-gate-hold-class.mjs', 'scripts/conveyor/reconcile-core.mjs', 'scripts/operations/ci-heal-pr-dispatch.mjs',
    'scripts/conveyor/owed-ci-rerun-executor.mjs',
  ] },
  fixPresent(root) {
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { classifyMergeGateHold } = await import(${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/merge-gate-hold-class.mjs')).href)});
      const result = classifyMergeGateHold({ prLabels: [],
        results: [{ id: 'red-main-freeze', status: 'hold', reason: 'main is RED (freeze: main CI red since aaaaaaaaa)' }],
        verdictCompletedAt: '2026-11-18T10:00:00Z',
        mainCiNow: { status: 'completed', conclusion: 'success', completed_at: '2026-11-18T11:00:00Z' } });
      process.exit(result.rerun === true ? 0 : 1);
    `], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    return probe.status === 0;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const load = path => import(pathToFileURL(join(root, path)).href);
    const { excusePrMergeGateHolds, readMergeGateVerdict } = await load('scripts/lib/merge-gate-hold-class.mjs');
    const { GATE_IDS } = await load('scripts/lib/merge-gate-inventory.mjs');
    const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
    const { executeOwedCiReruns } = await load('scripts/conveyor/owed-ci-rerun-executor.mjs');
    const { dispatchTimeoutRetry, timeoutGithubEffects } = await load('scripts/operations/ci-heal-pr-dispatch.mjs');
    const dir = mkdtempSync(join(process.env.TMPDIR, 'stale-freeze-soak-'));
    const violations = [], head = 'a'.repeat(40), repo = 'soak-owner/soak-repo';
    let writes = 0;
    const log = ['#7266: HOLD', ...GATE_IDS.map(id => id === 'red-main-freeze'
      ? `  hold  ${id}  main is RED (freeze: main CI red since ${head})` : `  pass  ${id}  ok`), 'merge-gate: HOLD — held'].join('\n');
    const pr = { number: 7266, state: 'OPEN', headRefOid: head, headRefName: 'lane/freeze-soak',
      rowsComplete: true, rowsHead: head,
      mergeStateStatus: 'CLEAN', labels: [{ name: 'review:pending' }], comments: [],
      statusCheckRollup: [{ name: 'merge-gate', id: 123, status: 'completed', conclusion: 'failure' }] };
    // Annotation is bound to verdict job.head_sha === PR head, never the PR number alone.
    // A pull_request_target job on a differing base head must remain red (covered below).
    const job = { name: 'merge-gate', status: 'completed', conclusion: 'failure',
      steps: [{ name: "Evaluate the drain's merge gates", status: 'completed', conclusion: 'failure' }], head_sha: head, completed_at: '2026-11-18T10:00:00Z', run_id: 42, run_attempt: 1 };
    const readMainCi = () => ({ status: 'completed', conclusion: 'success', completed_at: '2026-11-18T11:00:00Z' });
    try {
      mkdirSync(join(dir, 'backlog'));
      const baseHead = excusePrMergeGateHolds([pr], { repo, mergeGateSetting: 'on', readMainCi,
        readFreeze: () => ({ frozen: false }),
        readMergeGateVerdict: args => readMergeGateVerdict({ ...args, cache: new Map(),
          runGh: argv => argv.at(-1).endsWith('/logs') ? log : JSON.stringify({ ...job, head_sha: 'b'.repeat(40) }) }) });
      if (baseHead[0].statusCheckRollup[0].mergeGateStaleFreeze) violations.push('base-head target job was annotated for PR head');
      for (const tick of [0, 1, 2]) {
        // First observe the accepted request still pending, then the successful rerun.
        if (tick === 2) pr.statusCheckRollup = [{ ...pr.statusCheckRollup[0], conclusion: 'success' }];
        const prs = excusePrMergeGateHolds([pr], { repo, mergeGateSetting: 'on', readMainCi, readFreeze: () => ({ frozen: false }),
          readMergeGateVerdict: args => readMergeGateVerdict({ ...args, cache: new Map(),
            runGh: argv => argv.at(-1).endsWith('/logs') ? log : JSON.stringify(job) }) });
        const plan = planReconcile({ prs, agents: [], requiredChecks: ['merge-gate'], reviewTiming: { startAfter: 'ci-green' } });
        if (!plan.dispatch.some(r => r.kind === 'review')) violations.push(`tick ${tick}: review blocked by stale freeze`);
        if (plan.dispatch.some(r => r.kind === 'ci-heal')) violations.push(`tick ${tick}: stale freeze owes a heal`);
        if (tick < 2 && prs[0].statusCheckRollup[0].conclusion !== 'failure') violations.push('check was marked successful');
        if (tick === 2 && (prs[0].statusCheckRollup[0].conclusion !== 'success'
          || plan.dispatch.some(r => r.kind === 'ci-timeout-rerun'))) violations.push('next tick did not observe green merge-gate');
        const result = await executeOwedCiReruns({ rows: plan.dispatch, repo, checkStaleness: () => ({ fresh: true, behind: 0 }),
          dispatchRetry: evidence => dispatchTimeoutRetry(evidence, { repo, dir, readMainCi,
            effects: { observe: () => ({ repo, head, runHead: head, open: true, run: 42, job: 123, jobRun: 42,
              attempt: 1, jobAttempt: 1, jobName: 'merge-gate', status: 'completed', conclusion: 'failure' }),
            request: () => { writes++; return { status: 'confirmed' }; } } }) });
        if (tick === 0 && result.requested.length !== 1) violations.push('first tick did not rerun merge-gate');
        if (tick === 1 && !result.refused.some(r => r.reason.includes('stale-freeze-rerun-spent'))) violations.push('spent rerun lacked operator fallback');
      }
      if (writes !== 1) violations.push(`expected one request across ticks/reloads, got ${writes}`);
      // Eleven eligible PRs exceed the default cap. API rejections spend the first ten
      // reservations permanently; later ticks must still reach the eleventh PR.
      let apiRecovered = false;
      const attempted = [];
      for (const tick of [0, 1]) {
        const prs = Array.from({ length: 11 }, (_, i) => {
          const candidate = { ...pr, number: 7300 + i,
            statusCheckRollup: [{ ...pr.statusCheckRollup[0], conclusion: 'failure' }] };
          return excusePrMergeGateHolds([candidate], { repo, mergeGateSetting: 'on', readMainCi,
            readFreeze: () => ({ frozen: false }),
            readMergeGateVerdict: args => readMergeGateVerdict({ ...args, cache: new Map(),
              runGh: argv => argv.at(-1).endsWith('/logs') ? log.replace('#7266:', `#${candidate.number}:`) : JSON.stringify(job) }) })[0];
        });
        const plan = planReconcile({ prs, agents: [], requiredChecks: ['merge-gate'], reviewTiming: { startAfter: 'ci-green' } });
        const result = await executeOwedCiReruns({ rows: plan.dispatch, repo, checkStaleness: () => ({ fresh: true }),
          dispatchRetry: evidence => dispatchTimeoutRetry(evidence, { repo, dir, readMainCi,
            effects: { observe: () => ({ repo, head, runHead: head, open: true, run: 42, job: 123, jobRun: 42,
              attempt: 1, jobAttempt: 1, jobName: 'merge-gate', status: 'completed', conclusion: 'failure' }),
            request: evidence => { attempted.push(evidence.pr); return { status: apiRecovered ? 'confirmed' : 'rejected' }; } } }) });
        if (tick === 0 && (result.skippedOverCap !== 1 || attempted.length !== 10)) violations.push('rejected API requests did not respect ten-request cap');
        if (tick === 1 && (result.requested.join(',') !== '7310' || result.skippedOverCap !== 0)) violations.push('spent stale-freeze requests starved the eleventh PR');
        apiRecovered = true;
      }
      if (attempted.join(',') !== Array.from({ length: 11 }, (_, i) => 7300 + i).join(',')) violations.push('starvation recovery retried a spent reservation or missed an eligible PR');
      // The real observation adapter must carry job.name into dispatch. Two stale-freeze
      // reruns on a head must then leave the ordinary timeout budget and followup intact.
      let currentRun = 50, mixedWrites = 0;
      const cards = [];
      const effects = timeoutGithubEffects({ exec: (_command, args) => {
        if (args.includes('POST')) { mixedWrites++; return 'HTTP/2.0 201 Created'; }
        const path = args[1];
        if (path === `repos/${repo}/pulls/7400`) return JSON.stringify({ head: { sha: head }, state: 'open' });
        if (path === `repos/${repo}/actions/jobs/123`) return JSON.stringify({ ...job, id: 123, run_id: currentRun });
        if (path === `repos/${repo}/actions/runs/${currentRun}`) return JSON.stringify({ id: currentRun,
          head_sha: head, run_attempt: 1, repository: { full_name: repo } });
        throw new Error(`unexpected API path: ${path}`);
      } });
      for (const run of [50, 51, 52, 53]) {
        currentRun = run;
        const staleFreeze = run < 52;
        const evidence = { eligible: true, repo, pr: 7400, head, run, staleFreeze,
          completedAt: job.completed_at, signature: staleFreeze ? `stale-main-freeze:${run}` : 'ordinary-timeout',
          failures: [{ path: 'scripts/example.test.mjs', name: 'ordinary timeout', kind: 'test-timeout' }],
          jobs: [{ run, job: 123, attempt: 1 }] };
        const result = await dispatchTimeoutRetry(evidence, { repo, dir, root: dir, effects, readMainCi,
          fileFollowup: payload => { cards.push(payload); } });
        if (result.status !== 'requested') violations.push(`mixed retry run ${run} refused: ${result.reason}`);
        if (cards.length !== (run === 53 ? 1 : 0)) violations.push(`mixed retry run ${run}: incorrect followup count`);
      }
      if (mixedWrites !== 4) violations.push(`mixed retry requests: expected 4, got ${mixedWrites}`);
      if (cards.length === 1 && (!cards[0].content.includes('ordinary timeout')
          || cards[0].content.includes('run 50') || cards[0].content.includes('run 51'))) violations.push('mixed followup used stale-freeze evidence');
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};

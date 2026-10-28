/** PR #5981 send-back: replay the real dry-run, reconciliation and R123 write boundaries. */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

export default {
  id: 'recovered-ci-auto-answer-boundaries',
  title: 'daemon policy enables recovered CI answers while preserving mutation and identity boundaries',
  card: 'PR #5981 / R123',
  fixedBy: { sha: 'uncommitted', where: 'lane/r123-auto-proceed', paths: [
    'scripts/conveyor/reconcile-pass.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs',
    'scripts/conveyor/stand-down-auto-proceed-io.mjs', 'scripts/conveyor/stand-down-auto-proceed.mjs',
    'scripts/conveyor/fix-takeover.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8').includes('allowStandDownAutoProceed === true')
      && readFileSync(join(root, 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'), 'utf8')
        .includes('allowStandDownAutoProceed = fixSettings.standDownAutoProceed');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const load = p => import(pathToFileURL(join(root, p)).href);
    const { runReconcilePass } = await load('scripts/conveyor/reconcile-pass.mjs');
    const { planFixDispatchClaimStatus, runReconcileFixDispatch } = await load('scripts/conveyor/reconcile-fix-dispatch.mjs');
    const { runTickAllRepos } = await load('skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
    const { resolveFixSettings } = await load('scripts/conveyor/fix-takeover.mjs');
    const io = await load('scripts/conveyor/stand-down-auto-proceed-io.mjs');
    const { annotateLapsedStandDowns, buildStandDownComment } = await load('scripts/conveyor/stand-down.mjs');
    const { countUnresolvedStandDowns, planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
    const { ghRepoSlug } = await load('scripts/lib/constellation-repos.mjs');
    const weSlug = ghRepoSlug('we'), frontierSlug = ghRepoSlug('frontierui');
    const head = 'a'.repeat(40), author = { login: 'web-everything' };
    const comments = [{ id: 'SD1', author, createdAt: '2026-10-13T12:00:00Z',
      body: buildStandDownComment({ reason: 'gate-red', head }) }];
    const run = (id, conclusion, suite = 901) => ({ id, name: 'test', head_sha: head,
      app: { id: 15368, slug: 'github-actions' }, check_suite: { id: suite }, status: 'completed', conclusion,
      actions: { runId: 700, attempt: id === 101 ? 1 : 2 },
      completed_at: id === 101 ? '2026-10-13T11:59:00Z' : '2026-10-13T12:01:00Z' });
    const pr = { number: 5981, headRefOid: head, headRefName: 'lane/r123-auto-proceed', baseRefName: 'main',
      labels: [], files: [], body: '', comments,
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    const writes = [], violations = [];
    const writerOptions = {
      repo: weSlug, requiredChecks: ['test'],
      selectCandidates: candidates => { writes.push('cursor'); return candidates; },
      readComments: () => comments, readHead: () => head,
      readChecks: () => ({ head, complete: true, runs: [run(101, 'failure'), run(102, 'success')] }),
      readContext: () => null, readScopedChecks: () => [],
      reserve: () => { writes.push('reserve'); return true; },
      post: ({ body }) => { writes.push('post'); return { author, body }; }, log: () => {},
    };
    const same = p => p;
    const options = {
      readPrs: () => [pr], readAgents: () => [], enrich: same, env: {},
      readRequiredChecks: () => ({ checks: ['test'] }),
      enrichStandDownAutoProceed: (prs, opts) => io.enrichPrsWithStandDownAutoProceed(prs, { ...writerOptions, ...opts }),
      excuseMergeGateHolds: same, enrichMainRed: prs => ({ prs, mainRedWindows: [] }),
      enrichAlreadyLanded: same, enrichBaseRef: same, enrichSystemFix: same, enrichEscalationBase: same,
      enrichFixClaims: same, enrichTimeouts: same, enrichReferralHolds: same, enrichReferralAutoResolve: same,
      enrichLedgerHolds: same, enrichRulings: same, enrichScopeBloat: same, enrichCodeQL: same,
      enrichStandingRulingGrants: same, enrichMechanicalRound: same, enrichOwedMainRule: () => {},
      resolveMainSha: () => null, readPriority: () => null,
    };
    const reconcile = input => runReconcilePass({ ...options, ...input });
    planFixDispatchClaimStatus({ repo: 'we', reconcile, checkStaleness: () => ({ fresh: true }),
      resolveProfile: () => ({ capabilities: { fix: false } }) });
    const dryRunWrites = [...writes];
    if (writes.length) violations.push(`dry-run wrote ${writes.join(',')}`);
    writes.length = 0;
    const dispatchOptions = { repo: 'we', reconcile, checkStaleness: () => ({ fresh: true }),
      netScope: null, prStack: null, resolveProfile: () => ({ capabilities: { fix: false } }) };
    runReconcileFixDispatch(dispatchOptions);
    const defaultDispatchWrites = [...writes];
    if (writes.length) violations.push(`default dispatch wrote ${writes.join(',')}`);
    writes.length = 0;
    runReconcileFixDispatch({ ...dispatchOptions, allowStandDownAutoProceed: false });
    const optedOutDispatchWrites = [...writes];
    if (writes.length) violations.push(`opted-out dispatch wrote ${writes.join(',')}`);
    writes.length = 0;
    runReconcileFixDispatch({ repo: 'we', reconcile, checkStaleness: () => ({ fresh: true }),
      allowStandDownAutoProceed: true,
      netScope: null, prStack: null, resolveProfile: () => ({ capabilities: { fix: false } }) });
    if (writes.join(',') !== 'cursor,reserve,post') violations.push('mutating dispatch did not explicitly enable automatic answers');
    // Exercise the production daemon -> all-repo fan-out -> dispatch -> reconcile -> real writer.
    // Only external effects are replaced; the permission must arrive through the daemon itself.
    const daemonWrites = {};
    const emptyTick = () => ({ dispatched: [], refusals: [] });
    for (const [name, setting, override, expected] of [
      ['standard', undefined, undefined, true], ['disabled', false, undefined, false],
      ['enabled', true, undefined, true], ['explicit-off', true, false, false],
      ['explicit-on', false, true, true],
    ]) {
      writes.length = 0;
      const answerRepos = [];
      const fixSettings = resolveFixSettings({ env: {}, platform: {},
        read: () => JSON.stringify({ fix: { standDownAutoProceed: setting } }) });
      const result = await runTickAllRepos({ repos: [weSlug, frontierSlug], fixSettings,
        ...(override === undefined ? {} : { allowStandDownAutoProceed: override }),
        fixTick: input => runReconcileFixDispatch({ ...dispatchOptions, ...input,
          reconcile: input => runReconcilePass({ ...options, ...input,
            enrichStandDownAutoProceed: (prs, opts) => io.enrichPrsWithStandDownAutoProceed(prs, {
              ...writerOptions, ...opts, post: args => { answerRepos.push(args.repo); return writerOptions.post(args); },
            }),
          }),
        }),
        ciHealTick: emptyTick, hungCiTick: emptyTick, mainRedRebaseTick: emptyTick,
        missingRunTick: emptyTick, promoteDraftTick: emptyTick, notesTick: emptyTick,
      });
      daemonWrites[name] = [...writes];
      const want = expected ? 'cursor,reserve,post,cursor,reserve,post' : '';
      if (writes.join(',') !== want || result.repos.some(row => row.error)) {
        violations.push(`daemon ${name}: expected ${want || 'no writes'}, got ${writes.join(',') || 'no writes'}`);
      }
      if (answerRepos.join(',') !== (expected ? [weSlug, frontierSlug].join(',') : '')) {
        violations.push(`daemon ${name}: answers escaped their reconciled repositories`);
      }
    }
    writes.length = 0;
    io.enrichPrsWithStandDownAutoProceed([pr], { ...writerOptions,
      readChecks: () => ({ head, complete: true, runs: [run(101, 'failure'), run(102, 'success', 902)] }) });
    if (writes.includes('reserve') || writes.includes('post')) violations.push('independent same-name workflow success released a failed suite');

    // Cancellation/skip evidence must be newer than the hold it would release.
    for (const conclusion of ['cancelled', 'skipped']) {
      for (const completed_at of ['2026-10-13T11:59:00Z', comments[0].createdAt]) {
        writes.length = 0;
        const [held] = io.enrichPrsWithStandDownAutoProceed([pr], { ...writerOptions,
          readChecks: () => ({ head, complete: true, runs: [{ ...run(102, conclusion), completed_at }] }),
        });
        if (writes.includes('reserve') || writes.includes('post') || countUnresolvedStandDowns(held.comments) !== 1) {
          violations.push(`${conclusion} completed at ${completed_at} released a later or simultaneous stand-down`);
        }
      }
    }

    // Use the real REST reader, classifier and writer: same suite/name does not prove a rerun.
    const sameAttemptWrites = {};
    for (const conclusion of ['success', 'cancelled', 'skipped']) {
      writes.length = 0;
      const checks = [run(101, 'failure'), run(102, conclusion)].map(({ actions, ...r }) => ({ ...r,
        details_url: `https://github.com/${weSlug}/actions/runs/700/job/${r.id}` }));
      const [retained] = io.enrichPrsWithStandDownAutoProceed([pr], { ...writerOptions,
        readChecks: input => io.readAutoProceedChecks(input, { read: argv => {
          if (argv[1].includes('/statuses?')) return [];
          if (argv[1].includes('/commits/')) return { total_count: 2, check_runs: checks };
          const id = Number(argv[1].split('/').at(-1));
          return { id, run_id: 700, run_attempt: 1, name: 'test', head_sha: head,
            check_run_url: `https://api.github.com/repos/${weSlug}/check-runs/${id}` };
        } }),
      });
      sameAttemptWrites[conclusion] = [...writes];
      if (writes.includes('reserve') || writes.includes('post') || countUnresolvedStandDowns(retained.comments) !== 1) {
        violations.push(`independent same-name job ${conclusion} released a failed job in the same attempt`);
      }
    }

    // Legacy statuses and check-runs are independent sources for the same required name.
    writes.length = 0;
    const [statusHeld] = io.enrichPrsWithStandDownAutoProceed([pr], { ...writerOptions,
      readChecks: input => io.readAutoProceedChecks(input, { read: argv => {
        if (argv[1].includes('/statuses?')) return [{ id: 201, context: 'test', state: 'failure' }];
        return { total_count: 1, check_runs: [{ ...run(102, 'cancelled'), app: { id: 42, slug: 'unrelated-app' } }] };
      } }),
    });
    const legacyStatusWrites = [...writes];
    if (writes.includes('reserve') || writes.includes('post') || countUnresolvedStandDowns(statusHeld.comments) !== 1) {
      violations.push('cancelled unrelated app check masked a failing required legacy status');
    }

    // Attempt 2 recovers, then attempt 3 fails on the same SHA during the posting window.
    writes.length = 0;
    let checkReads = 0;
    const [rerunHeld] = io.enrichPrsWithStandDownAutoProceed([pr], { ...writerOptions,
      readChecks: input => {
        const checks = [run(101, 'failure'), run(102, 'success')];
        if (++checkReads > 1) checks.push({ ...run(103, 'failure'), actions: { runId: 700, attempt: 3 } });
        return io.readAutoProceedChecks(input, { read: argv => {
          if (argv[1].includes('/statuses?')) return [];
          if (argv[1].includes('/commits/')) return { total_count: checks.length, check_runs: checks.map(r => ({ ...r,
            details_url: `https://github.com/${weSlug}/actions/runs/700/job/${r.id}` })) };
          const id = Number(argv[1].split('/').at(-1));
          return { id, run_id: 700, run_attempt: id - 100, name: 'test', head_sha: head,
            check_run_url: `https://api.github.com/repos/${weSlug}/check-runs/${id}` };
        } });
      },
    });
    const failedRerunRace = { checkReads, writes: [...writes] };
    if (checkReads !== 2 || writes.includes('reserve') || writes.includes('post')
      || countUnresolvedStandDowns(rerunHeld.comments) !== 1) {
      violations.push('new failed attempt posted an answer using the earlier successful snapshot');
    }

    // A recovered main can lapse the original hold before the writer refreshes the thread.
    // A question arriving during check reads must still reach the downstream planner.
    const lapse = snapshot => annotateLapsedStandDowns(snapshot, {
      lapseOnNewHead: 'off', redMainLapse: () => true, onLapse: () => {},
    });
    const parked = [{ ...comments[0], body: buildStandDownComment({ reason: 'fix-loop-exhausted', head }) }];
    const question = { id: 'SD2', author, createdAt: '2026-10-13T12:02:00Z',
      body: buildStandDownComment({ reason: 'needs-judgment', head }) };
    const lapsed = lapse({ ...pr, labels: ['review:changes'], comments: parked });
    if (countUnresolvedStandDowns(lapsed.comments) !== 0) violations.push('race fixture did not lapse the original hold');
    let threadReads = 0;
    writes.length = 0;
    const [refreshed] = io.enrichPrsWithStandDownAutoProceed([lapsed], { ...writerOptions,
      readComments: () => ++threadReads === 1 ? parked : [...parked, question],
    });
    const plannedPr = refreshed;
    if (JSON.stringify(plannedPr.comments[0].standDownLapsed) !== JSON.stringify(lapsed.comments[0].standDownLapsed)) {
      violations.push('held candidate lost its snapshot lapse annotation after the thread refresh');
    }
    const racePlan = planReconcile({ prs: [plannedPr], agents: [], requiredChecks: ['test'] });
    const refreshedThreadRace = { threadReads, writes: [...writes],
      unresolved: countUnresolvedStandDowns(plannedPr.comments),
      dispatch: racePlan.dispatch, refusals: racePlan.refusals.map(row => row.kind) };
    if (threadReads !== 2 || writes.includes('reserve') || writes.includes('post')
      || refreshedThreadRace.unresolved !== 1 || racePlan.dispatch.length
      || !refreshedThreadRace.refusals.includes('stood-down')) {
      violations.push('refreshed judgment hold was discarded before downstream planning');
    }

    const mainReads = [], crossRepoWrites = [];
    if (typeof io.readAutoProceedContext !== 'function') violations.push('repository-bound main context reader is missing');
    else {
      const now = Date.now(), stamp = minutes => new Date(now - minutes * 60000).toISOString();
      const rows = [40, 35, 30, 25, 20].map((minutes, i) => ({ v: 1,
        repo: 'frontierui', pr: pr.number, head, kind: i === 4 ? 'park' : 'ci-heal',
        at: stamp(minutes), reason: 'budget' }));
      const context = io.readAutoProceedContext({ repo: 'frontierui', defaultBranch: 'trunk',
        env: { WE_FIX_LOOP_RED_MAIN_DISCOUNT: 'on' } }, {
        readRows: () => rows, readMainRuns: input => {
          mainReads.push(input);
          return input.repo === weSlug ? [
            { status: 'completed', conclusion: 'failure', updatedAt: stamp(50) },
            { status: 'completed', conclusion: 'success', updatedAt: stamp(15) },
          ] : [{ status: 'completed', conclusion: 'success', updatedAt: stamp(15) }];
        },
      });
      if (mainReads.length !== 1 || mainReads[0].repo !== frontierSlug
        || mainReads[0].branch !== 'trunk' || context.repo !== 'frontierui'
        || context.config.redMainWindows?.length !== 0) violations.push('main history escaped the reconciled repository/branch');
      const parkedComments = [{ ...comments[0], createdAt: stamp(20),
        body: buildStandDownComment({ reason: 'fix-loop-exhausted', head }) }];
      io.enrichPrsWithStandDownAutoProceed([{ ...pr, comments: parkedComments }], { ...writerOptions,
        repo: frontierSlug, readContext: () => context, readComments: () => parkedComments,
        readChecks: () => ({ head, complete: true, runs: [{ ...run(101, 'failure'), completed_at: stamp(25) }] }),
        reserve: () => { crossRepoWrites.push('reserve'); return true; },
        post: ({ body }) => { crossRepoWrites.push('post'); return { author, body }; },
      });
      if (crossRepoWrites.length) violations.push('a WE outage released a genuine FrontierUI failure');
    }
    return { violations, dryRunWrites, defaultDispatchWrites, optedOutDispatchWrites, mainReads, crossRepoWrites,
      refreshedThreadRace, sameAttemptWrites, legacyStatusWrites, failedRerunRace, daemonWrites };
  },
  judge(report) { return report.violations; },
};

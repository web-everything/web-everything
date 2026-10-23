/**
 * LIVE: #5762, #5530 and #5759 — an accepted head skipped as already-reviewed-head never
 * started its owed post-accept red team. No result appeared, so the PR sat indefinitely.
 *
 * Light replay of review-red-team-on-skip.test.mjs and review-daemon-red-team-on-skip.test.mjs:
 * production planReconcile -> runReviewTick -> runRedTeamOnSkip, with injected PR/evidence/status readers
 * and dispatch/tag IO. #5762/#5530 resume a finished pass whose comment failed; #5759 starts fresh.
 * Queued accepted heads (#5759 plus a synthetic resume) must reach the same evidence checks.
 * Five ticks cover cooldown, an in-flight pass, posted-but-not-visible, then a trusted result.
 * Controls never owe a start. No processes or network; all production imports use sourceRoot.
 * A pre-fix tree has no recovery hook or omits queued heads: the real tick leaves owed heads stranded.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const RECOVERY = 'scripts/lib/review-red-team-on-skip.mjs';
const DAEMON = 'skills-src/conveyor/review-daemon.mjs';

export default {
  id: 'red-team-never-started-on-reviewed-head',
  title: 'an already-reviewed accepted head never starts its owed post-accept red team',
  card: 'redteam-on-skip (lane/redteam-on-skip), live PRs #5762 #5530 #5759',
  fixedBy: {
    sha: '5a7dc105af', where: 'lane/redteam-on-skip',
    paths: [
      'scripts/conveyor/run-scorecard-store.mjs',
      'scripts/lib/drain-red-team-evidence.mjs',
      RECOVERY,
      'scripts/operations/review-extra-seats.mjs',
      'scripts/operations/review-job.mjs',
      'scripts/settings/review-red-team-on-skip.json',
      DAEMON,
    ],
  },
  fixPresent(root) {
    try {
      return existsSync(join(root, RECOVERY))
        && readFileSync(join(root, DAEMON), 'utf8').includes('runRedTeamOnSkip');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug;
      const { runReviewTick } = await load(DAEMON);
      const { planReconcile } = await load('scripts/conveyor/reconcile-core.mjs');
      const { buildReviewedShaMarker } = await load('scripts/lib/review-escalation.mjs');
      const { renderRedTeamComment, runRedTeam } = await load('scripts/operations/review-extra-seats.mjs');
      const recovery = existsSync(join(sourceRoot, RECOVERY)) ? await load(RECOVERY) : null;
      const head = 'a'.repeat(40);
      const payload = verdict => ({ verdict: { verdict }, findings: { read: { netBasis: { rev: head } } } });
      const evidence = (over = {}) => ({ loopPayload: payload('accept'), recorded: false, ...over });
      const comment = pr => ({ author: { login: 'web-everything' }, body: renderRedTeamComment({
        pr, rev: head, provider: 'codex', model: 'soak', findings: [], foldedVerdict: 'accept',
      }) });
      const cases = [
        { number: 5762, mode: 'resume', evidence: evidence({ recorded: true }),
          status: { status: 'finished', result: { status: 'ran', comment: 'error' } } },
        { number: 5530, mode: 'resume', evidence: evidence({ recorded: true }),
          status: { status: 'finished', result: 'ran' } },
        { number: 5759, queued: true, mode: 'fresh', evidence: evidence(), status: null },
        { number: 5760, queued: true, mode: 'resume', evidence: evidence({ recorded: true }),
          status: { status: 'finished', result: 'ran' } },
        // #5838: the original call ran with card-only probes enabled; policy changed before recovery.
        { number: 5838, queued: true, mode: 'resume', evidence: evidence({ recorded: true,
          loopPayload: { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head },
            netChangedFiles: ['backlog/123-card.md'], diffText: '+card update' } } } }),
          status: { status: 'finished', result: 'ran' } },
        // Synthetic controls reproduce the unit tests' no-start boundaries on already-reviewed heads.
        { number: 9001, queued: true, evidence: evidence({ loopPayload: payload('changes') }), status: null },
        { number: 9002, queued: true, evidence: evidence({ loopPayload: null }), status: null },
        { number: 9003, queued: true, evidence: evidence(), status: null, comments: [comment(9003)] },
        { number: 9004, queued: true, evidence: evidence({ queued: true }), status: null },
        { number: 9005, queued: true, evidence: evidence({ recorded: true }),
          status: { status: 'finished', result: { status: 'error' } } },
        { number: 9006, queued: true, evidence: evidence({ recorded: true }), status: null },
      ];
      const byPr = new Map(cases.map(c => [c.number, c]));
      const history = new Map(), starts = [];
      let at = 2_000_000;
      const setting = { enabled: true, retryCooldownMin: 30 };
      const tick = phase => {
        const rawPrs = cases.map(c => ({ number: c.number, headRefOid: head, state: 'OPEN',
          headRefName: 'lane/soak-accepted', baseRefName: 'main', mergeStateStatus: 'CLEAN',
          statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
          comments: [{ body: buildReviewedShaMarker(head), author: { login: 'web-everything' } }, ...(c.comments ?? [])],
          labels: (c.queued ? ['review:accepted', 'ready-to-merge', 'red-team:pending'] : ['review:pending']).map(name => ({ name })) }));
        const plan = planReconcile({ repo: 'we', prs: rawPrs, agents: [],
          reviewTiming: { startAfter: 'ci-green' }, requiredChecks: ['gate'] });
        const out = runReviewTick({ repo, reconcile: () => plan,
          readPrs: () => rawPrs, readAgents: () => [], holdReconcile: () => [],
          acquirableLanes: () => 5, liveReviewBudget: { left: 5 }, now: () => at,
          tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
          dispatch: args => { violations.push(`${phase}: unexpected full review for #${args.pr}`); return { skipped: 'soak' }; },
          redTeamOnSkip: recovery ? options => recovery.runRedTeamOnSkip({ ...options,
            setting, lastDispatch: history, now: () => at,
            readEvidence: ({ pr }) => byPr.get(pr).evidence,
            readStatus: ({ pr }) => byPr.get(pr).status,
            dispatch: args => {
              starts.push(args);
              check(args.repo === repo && args.redTeamOnly === true, `${phase}: start must use the red-team-only job for this repo`);
              check(args.redTeamMode === byPr.get(args.pr)?.mode, `${phase}: #${args.pr} started in the wrong recovery mode`);
              return { jobPid: 40 + starts.length };
            },
          }) : null,
        });
        check(out.reconcileError == null && out.failed.length === 0, `${phase}: daemon tick failed`);
        for (const c of cases) {
          const count = starts.filter(s => s.pr === c.number).length;
          if (c.mode) {
            check(count <= 1, `${phase}: #${c.number} red team started more than once for the same head`);
          } else check(count === 0, `${phase}: #${c.number} red team started for a head that owes none`);
        }
      };
      tick('accepted skip');
      const card = byPr.get(5838);
      const recoveryComments = [];
      const result = await runRedTeam({ pr: card.number, repo, loopPayload: card.evidence.loopPayload,
        resumeOnly: true, env: { WE_RED_TEAM_SKIP_CARD_ONLY: '1' } }, {
        now: () => at, log: () => {},
        readRecords: () => [{ dispatchKind: 'review-seat', seat: 'red-team', status: 'ok',
          pr: card.number, repo, rev: head, callId: 'stored-card-call', provider: 'codex', model: 'soak',
          findings: [], foldedVerdict: 'accept' }],
        listComments: () => recoveryComments,
        postComment: ({ body }) => recoveryComments.push({ body, author: { login: 'web-everything' } }),
        append: () => {},
        cliAvailable: () => { throw Error('recovery selected a provider'); },
        reserveCalls: () => { throw Error('recovery reserved a call'); },
        runSeat: () => { throw Error('recovery launched a model'); },
        runRecheck: () => { throw Error('recovery launched a re-check'); },
      });
      check(result.status === 'resumed' && result.comment?.status === 'posted' && recoveryComments.length === 1,
        '#5838: current card-only skip stranded a recorded result instead of publishing its recovery');
      card.comments = recoveryComments;
      at += 120_000;
      tick('next tick within cooldown');
      for (const c of cases.filter(c => c.mode)) c.evidence = evidence({ recorded: true, inFlight: true });
      at += 31 * 60_000;
      tick('in flight beyond cooldown');
      for (const c of cases.filter(c => c.mode)) {
        c.evidence = evidence({ recorded: true });
        c.status = { status: 'finished', result: { status: 'ran', comment: 'posted' } };
      }
      at += 120_000;
      tick('posted result awaiting visibility');
      for (const c of cases.filter(c => c.mode)) {
        c.comments = [comment(c.number)];
        // An independently decisive trusted comment must suppress even fresh-looking local evidence.
        c.evidence = evidence(); c.status = null;
      }
      at += 31 * 60_000;
      tick('trusted result visible');
      for (const c of cases.filter(c => c.mode)) {
        check(starts.some(s => s.pr === c.number), `#${c.number}: owed red team never started for the already-reviewed head`);
      }
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: report => report.violations,
};

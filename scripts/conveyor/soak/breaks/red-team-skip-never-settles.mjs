/**
 * LIVE #5872: an accepted card-only PR finished as skipped with no trusted result,
 * so red-team:clear never appeared and drain waited forever. #5762 likewise
 * finished a pass without a visible comment. Light replay of the production job,
 * skip settlement and label planner with injected IO: no processes or network.
 * All production imports follow sourceRoot; a missing pre-fix module is a violation.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SETTLEMENT = 'scripts/lib/red-team-skip-outcome.mjs';

export default {
  id: 'red-team-skip-never-settles',
  title: 'an accepted skipped red team never settles, leaving drain waiting forever',
  card: 'redteam-skip-clear (lane/redteam-skip-clear), live PRs #5872 #5762',
  fixedBy: {
    sha: '00cfa233a4', where: 'lane/redteam-skip-clear',
    paths: [SETTLEMENT, 'scripts/operations/review-job.mjs'],
  },
  fixPresent: root => existsSync(join(root, SETTLEMENT)),
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    if (!existsSync(join(sourceRoot, SETTLEMENT))) {
      return { violations: [`missing ${SETTLEMENT}: skipped/unpublished red teams cannot settle`] };
    }
    let scratch;
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { settleRedTeamSkip } = await load(SETTLEMENT);
      const { runReviewJob } = await load('scripts/operations/review-job.mjs');
      const { runRedTeam } = await load('scripts/operations/review-extra-seats.mjs');
      const { redTeamForHead } = await load('scripts/lib/red-team-gate.mjs');
      const { planRedTeamStatusLabels } = await load('scripts/lib/red-team-status-labels.mjs');
      const { redTeamSkipNeedsSettlement } = await load('scripts/lib/review-red-team-on-skip.mjs');
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug, head = 'a'.repeat(40), nextHead = 'b'.repeat(40);
      scratch = mkdtempSync(join(tmpdir(), 'soak-red-team-skip-'));
      const env = { WE_SHARED_RUNS_DIR: join(scratch, 'runs'), WE_RED_TEAM_SKIP_CARD_ONLY: '1',
        WE_REVIEW_RED_TEAM: '1', WE_REVIEW_EXTRA_SEATS: '1' };
      const payload = (path = 'backlog/5872.md') => ({ runId: 'soak-skip', stopped: 'complete',
        verdict: { verdict: 'accept', loop: { outcome: 'converged' }, findings: [], admittedFindings: [] },
        findings: { read: { title: 'Soak fixture', body: '', diffText: `diff --git a/${path} b/${path}\n+update\n`,
          netChangedFiles: [path], netRenameSources: [], netBasis: { rev: head } } },
      });
      // The real producer must select policy from the read, never from a reason string.
      let providerChecks = 0;
      const producerIo = { now: () => 1000, log: () => {}, readRecords: () => [],
        cliAvailable: () => { providerChecks++; return false; },
        reserveCalls: () => { throw Error('soak must not reserve calls'); },
        runSeat: () => { throw Error('soak must not launch a model'); },
      };
      const cardPayload = payload();
      const policy = await runRedTeam({ repo, pr: 5872, loopPayload: cardPayload, env }, producerIo);
      check(policy.status === 'skipped' && policy.policy === 'card-only' && providerChecks === 0,
        '#5872: card-only read did not produce a structured policy skip before provider selection');

      // Each replay gets a fresh IO facade, sharing only the durable settlement directory.
      // Run both the normal accepted job and the daemon's red-team-only recovery arc.
      const replay = ({ name, pr, redTeam, loopPayload = cardPayload, policyExpected = false }) => {
        const comments = [], notices = [], settlements = [];
        const evidence = { loopPayload, skipCardOnly: true, scheduled: true };
        const label = (at = head, thread = comments) => planRedTeamStatusLabels({ repo, pr, head: at,
          comments: thread, labels: ['red-team:pending'], evidence, env });
        for (const redTeamOnly of [false, true]) {
          const events = [];
          const out = runReviewJob({ repo, pr, redTeamOnly }, {
            root: sourceRoot, now: () => 1000, newActorId: () => 'soak-skip',
            readPrevCompletion: () => null, claim: () => ({ ok: true }), updateRecord: () => {}, unclaim: () => {},
            acquireLane: () => ({ lanePath: sourceRoot }), releaseLane: () => {}, prepareLane: () => ({ head }),
            report: () => {}, log: () => {},
            runLoop: () => ({ status: 0, stdout: JSON.stringify(loopPayload), stderr: '' }),
            readRedTeamOnlyPayload: () => ({ head, loopPayload }), fetchRedTeamHead: () => ({ head }),
            runRedTeam: () => redTeam,
            redTeamResultVisible: () => Boolean(redTeamForHead(comments, pr, head)),
            settleRedTeamSkip: input => {
              events.push('settle'); settlements.push(input);
              return settleRedTeamSkip({ ...input, comments, io: { env, log: () => {},
                postComment: ({ body }) => comments.push({ body, author: { login: 'web-everything' } }),
                publishNeedsYou: item => notices.push(item),
              } });
            },
            redTeamStatus: ({ status }) => events.push(status), clearRedTeamQueued: () => {},
            runRedTeamGate: () => { events.push('gate'); return { status: 'ok' }; },
          });
          check(out.redTeam?.outcome === (policyExpected ? (redTeamOnly ? 'already' : 'policy-clear') : 'non-policy'),
            `${name}: ${redTeamOnly ? 'recovery' : 'normal'} job did not settle its result`);
          const expectedEvents = redTeamOnly && redTeam?.status === 'disabled'
            ? 'queued,settle,gate' : 'queued,settle,finished,gate';
          check(events.join(',') === expectedEvents, `${name}: settlement must precede finished status and gate (disabled recovery remains retryable)`);
          check(policyExpected ? label().add === 'red-team:clear' : label().add !== 'red-team:clear',
            `${name}: label planner ${policyExpected ? 'did not clear policy result' : 'cleared without a trusted result'}`);
        }
        check(settlements.length === 2 && settlements.every(s => s.head === head && s.readHead === head),
          `${name}: both job arcs must settle the pinned reviewed head`);
        if (policyExpected) {
          check(comments.length === 1 && notices.length === 0, `${name}: policy must post exactly one result and no needs-you`);
          check(Boolean(redTeamForHead(comments, pr, head)), `${name}: result is not trusted and head-bound`);
          check(!redTeamForHead(comments, pr, nextHead) && label(nextHead).add !== 'red-team:clear',
            `${name}: stale-head result incorrectly clears a new head`);
          check(label(head, comments.map(c => ({ ...c, author: { login: 'untrusted-soak-author' } }))).add !== 'red-team:clear',
            `${name}: untrusted author incorrectly clears the head`);
        } else {
          check(comments.length === 0 && notices.length === 1, `${name}: must post no result and publish needs-you once across jobs`);
          check(notices[0]?.head === head && notices[0]?.repo === repo && notices[0]?.pr === pr,
            `${name}: needs-you lost its PR/head identity`);
          const input = settlements[0];
          const io = { env, log: () => {}, postComment: () => violations.push(`${name}: non-policy posted a result`),
            publishNeedsYou: item => notices.push(item) };
          settleRedTeamSkip({ ...input, head: nextHead, readHead: nextHead, comments, io });
          settleRedTeamSkip({ ...input, redTeam: { status: 'skipped', reason: 'different soak reason' }, comments, io });
          check(notices.length === 3, `${name}: needs-you must distinguish a changed head or reason`);
        }
      };
      replay({ name: '#5872 structured card-only policy', pr: 5872, redTeam: policy, policyExpected: true });
      for (const [index, [name, redTeam]] of [
        ['no diff', { status: 'skipped', reason: 'the review printed no diff' }],
        ['provider unavailable', { status: 'skipped', reason: 'provider unavailable' }],
        ['error', { status: 'error', reason: 'provider error' }],
        ['disabled', { status: 'disabled', reason: 'disabled' }],
        ['reason-only policy forgery', { status: 'skipped', reason: 'red team skipped: card-only' }],
        ['unknown outcome', null],
      ].entries()) replay({ name: `non-policy ${name}`, pr: 9100 + index, redTeam });
      for (const [index, status] of ['ran', 'resumed'].entries()) {
        for (const [offset, commentStatus] of ['error', 'posted', 'deduped'].entries()) {
          replay({ name: `#5762 ${status}/${commentStatus} without visible comment`, pr: 9200 + index * 10 + offset,
            redTeam: { status, findings: [], comment: { status: commentStatus } } });
        }
      }
      const codePayload = payload('scripts/soak-code.mjs');
      for (const [index, redTeam] of [
        { status: 'not-owed' },
        { status: 'not-owed', policy: 'card-only' },
        { status: 'not-owed', reason: 'review verdict is needs-human, not accept' },
      ].entries()) {
        replay({ name: '#5890 accepted code head with contradictory not-owed',
          pr: 9310 + index, redTeam, loopPayload: codePayload });
      }
      const codeResult = await runRedTeam({ repo, pr: 9300, loopPayload: codePayload, env }, producerIo);
      check(providerChecks > 0 && codeResult.status === 'skipped' && codeResult.policy !== 'card-only',
        'code PR: skipCardOnly=true must still check providers and never produce policy');
      for (const result of ['skipped', { status: 'skipped', policy: 'card-only' }]) {
        check(!redTeamSkipNeedsSettlement({ head, status: 'finished', result, skipCardOnly: true, loopPayload: codePayload }),
          'code PR: persisted skipCardOnly=true incorrectly admitted historical policy settlement');
      }
      replay({ name: 'code PR with skipCardOnly=true', pr: 9300, redTeam: codeResult, loopPayload: codePayload });
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
    return { violations };
  },
  judge: report => report.violations,
};

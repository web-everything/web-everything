/** PR #7080 / #7031: an admitted repair must survive refund accounting and CI-heal admission. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptedRedTeamRepair, failingRedTeamRepair, ordinaryAcceptedRedTeamRepair, roundCommitGitOutput } from '../../__tests__/fixtures/accepted-red-team-repair.mjs';
import { planReconcile } from '../../reconcile-core.mjs';
import { dispatchFix, planFixesFromReconcile, publishRedTeamFixDispatch } from '../../reconcile-fix-dispatch.mjs';
import { countRedTeamFixComments, RED_TEAM_FIX_COMMENT_MARKER } from '../../red-team-fix-round-count.mjs';
import { CONFLICT_FIX_COMMENT_MARKER } from '../../conflict-fix-round-count.mjs';
import { parseFixRunArgv, runFixCli } from '../../../operations/fix-run.mjs';
import { fixDetachedProvider } from '../../../operations/dispatch-providers/fix.mjs';

const plan = pr => planReconcile({ prs: [pr], agents: [], now: Date.parse('2026-11-18T12:00:00Z'),
  roundCap: 3, requiredChecks: ['test'] });

/** The same head/result and charged count recur after a failed launch and a mechanical refund. */
async function borrowedRefundReplay() {
  const pr = acceptedRedTeamRepair(7);
  pr.comments.splice(1, 2); // One refundable mechanical round.
  pr.comments.push({ author: { login: 'web-everything' }, body: CONFLICT_FIX_COMMENT_MARKER });
  let setting = true, launched = 0;
  const errors = [], launches = [];
  const freshPlan = () => planFixesFromReconcile(planReconcile({ prs: [pr], agents: [],
    now: Date.parse('2026-11-18T12:00:00Z'), roundCap: 3,
    mechanicalRoundsCountTowardCap: setting }).dispatch,
  () => ({ num: '7', scope: ['we:scripts/example.mjs'] }), () => []).planned[0];
  const io = {
    run: (cmd, args) => {
      if (cmd === 'gh' && args.includes('view')) return JSON.stringify(pr);
      if (cmd === 'gh' && args.includes('comment')) {
        pr.comments.push({ author: { login: 'web-everything' }, body: readFileSync(args.at(-1), 'utf8') });
        return '';
      }
      if (cmd !== 'node' && cmd !== 'git') throw Error(`unexpected IO: ${cmd}`);
      if (args.includes('acquire')) return JSON.stringify({ path: '/fixture/lane', holder: 'test-holder' });
      if (args.includes('--absolute-git-dir')) return tmpdir();
      if (args.includes('--verify') && args.includes('HEAD')) return pr.headRefOid;
      if (args[0] === 'rev-parse') return pr.headRefOid;
      return '';
    },
    readComments: async () => pr.comments, readCommits: () => pr.roundCommits,
    loadMechanicalRoundsSetting: () => ({ value: setting }),
    timingPolicy: { pushAfterCi: false },
    readPrompt: () => 'Repair the fixture', removePrompt: () => {},
    resolveProvider: () => ({ spawn: async () => {
      launched++;
      throw Error('executor failed after receipt');
    } }),
    readLease: () => ({ holder: 'test-holder' }), persistEvidence: () => {},
    pendingRearm: { read: () => null, clear: () => {}, write: () => {} },
    releaseClaim: async () => ({ released: [] }), recordOutcome: () => {}, recordRouted: () => ({}), appendLoopRow: () => {},
    weRoot: '/fixture', write: () => {}, writeErr: text => errors.push(text.trim()),
  };
  const dispatch = async planned => {
    let execution;
    dispatchFix({ ...planned, lane: 2 }, {
      root: '/fixture', repo: 'we', borrowed: { executor: 'codex', reason: 'borrowed-build-slot' },
      readFixClaim: () => null, acquireClaim: () => ({ ok: true }), releaseClaim: () => {}, stampRunner: () => {},
      readHistoryInputs: () => null,
      postNotice: () => {}, readBrief: () => 'brief {{PR_NUM}} {{LANE_REF}}',
      writeBorrowedPrompt: () => '/fixture/brief', checkoutExists: () => true, readPackageJson: () => ({ scripts: {} }),
      spawnBorrowed: request => fixDetachedProvider(request, {
        readDeliveryAgentMarker: () => null, logPathFor: () => '/fixture/log',
        spawnDetached: args => {
          launches.push(parseFixRunArgv(args.slice(1)).launchId);
          execution = runFixCli(args.slice(1), io);
          return { pid: 99 };
        },
      }),
    });
    const result = await execution;
    return { code: result.code, launched, receipts: countRedTeamFixComments(pr.comments) };
  };
  const before = freshPlan();
  const failed = await dispatch(before);
  setting = false;
  const after = freshPlan();
  const retried = await dispatch(after);
  const replayed = await dispatch(after);
  return { attempts: [before.attempts, after.attempts],
    plannedIds: [before.redTeamSentBack.attemptId, after.redTeamSentBack.attemptId],
    sameHeadAndResult: before.headRefOid === after.headRefOid && before.redTeamSentBack.resultId === after.redTeamSentBack.resultId,
    launches, failed, retried, replayed, errors };
}

function claudeReplay() {
  const pr = acceptedRedTeamRepair();
  const { planned: [planned] } = planFixesFromReconcile(plan(pr).dispatch,
    () => ({ num: '7031', scope: ['we:scripts/example.mjs'] }), () => []);
  const output = { fixture: 'three-mechanical-rounds-claude', plannerAttempts: planned.attempts, cap: planned.roundCap };
  try {
    publishRedTeamFixDispatch({ repo: 'we', planned }, {
      readComments: () => pr.comments,
      exec: (_cmd, args) => pr.comments.push({ author: { login: 'web-everything' }, body: args.at(-1) }),
    });
    output.receipt = 'published';
  } catch (e) { output.receipt = e.message; }
  return { ...output, receipts: countRedTeamFixComments(pr.comments) };
}

async function borrowedReplay(ci, readable = true, ordinaryKind = null, launcher = runFixCli) {
  const pr = ordinaryKind ? ordinaryAcceptedRedTeamRepair(ordinaryKind) : ci ? failingRedTeamRepair(7) : acceptedRedTeamRepair(7);
  if (ordinaryKind) pr.comments.push({ author: { login: 'web-everything' },
    body: `${RED_TEAM_FIX_COMMENT_MARKER}\n\nRed-team repair dispatched: head=old result=old attempt=old-launch` });
  const row = plan(pr).dispatch[0];
  const redTeamRepair = row.mode === 'red-team-sent-back';
  let launched = 0, ciReads = 0, commitReads = 0;
  const errors = [];
  const run = (cmd, args, opts) => {
    if (!ordinaryKind && cmd === 'git' && ['fetch', 'log', 'merge-tree'].includes(args[0])) {
      if (opts.cwd !== '/fixture') throw Error('wrong commit read target');
      if (args[0] === 'log') commitReads++;
      return roundCommitGitOutput(pr, args);
    }
    if (cmd === 'gh' && args.includes('view')) {
      const { roundCommits, ...livePr } = pr; // The API never returns local commit enrichment.
      return JSON.stringify(livePr);
    }
    if (cmd === 'gh' && args.includes('comment')) {
      if (launched) throw Error('receipt published after execution');
      pr.comments.push({ author: { login: 'web-everything' }, body: readFileSync(args.at(-1), 'utf8') });
      return '';
    }
    if (cmd !== 'node' && cmd !== 'git') throw Error(`unexpected IO: ${cmd}`);
    if (args.includes('acquire')) return JSON.stringify({ path: '/fixture/lane', holder: 'test-holder' });
    if (args.includes('--absolute-git-dir')) return tmpdir();
    if (args.includes('--verify') && args.includes('HEAD')) return pr.headRefOid;
    if (args[0] === 'rev-parse') return pr.headRefOid;
    return '';
  };
  const result = await launcher(['--pr=7', '--session=fix-7', '--ref=lane/7-repair', '--prompt-file=/fixture/brief',
    '--provider=codex', '--repo=o/r', '--lane-repo=/fixture',
    `--repair-kind=${row.kind}`,
    ...(ordinaryKind ? ['--launch-id=old-launch'] : []),
    ...(redTeamRepair ? [`--planned-repair-mode=${row.mode}`, `--red-team-round-cap=${row.roundCap}`] : [])], {
    run, readPrompt: () => 'Repair the fixture', removePrompt: () => {},
    timingPolicy: { pushAfterCi: false }, readRequired: () => ({ checks: ['test'] }), readChecks: async () => [],
    readComments: async () => pr.comments,
    ...(!readable ? { readCommits: (live, { cwd }) => {
      commitReads++;
      if (live.headRefOid !== pr.headRefOid || cwd !== '/fixture') throw Error('wrong commit read target');
      return { ok: false };
    } } : {}),
    readCiHeal: () => { ciReads++; return { title: 'CI red', checks: [{ name: 'test' }], jobs: [{ name: 'test', log: 'CI regression evidence' }] }; },
    resolveProvider: () => ({ spawn: async request => {
      if (ci && !request.prompt.includes('CI regression evidence')) throw Error('CI evidence missing');
      if (redTeamRepair && countRedTeamFixComments(pr.comments) !== 1) throw Error('missing receipt before execution');
      if (ordinaryKind === 'conflict' && !request.prompt.includes(pr.body)) throw Error('conflict context missing');
      if (ordinaryKind === 'ordinary' && !request.prompt.includes('Ordinary repair evidence')) throw Error('ordinary context missing');
      launched++;
    } }),
    readLease: () => ({ holder: 'test-holder' }), recordPush: () => {}, persistEvidence: () => {},
    pendingRearm: { read: () => null, clear: () => {}, write: () => {} },
    releaseClaim: async () => ({ released: [] }), recordOutcome: () => {}, recordRouted: () => ({}), appendLoopRow: () => {},
    weRoot: '/fixture', write: () => {}, writeErr: text => errors.push(text.trim()),
  });
  return { fixture: ordinaryKind ?? (ci ? 'accepted-blocked-required-ci-failure' : readable ? 'three-mechanical-rounds-borrowed' : 'unreadable-round-evidence'),
    plannerKind: row.kind, plannerMode: row.mode, plannerAttempts: row.attempts, code: result.code,
    receipts: countRedTeamFixComments(pr.comments), launched, ciReads, commitReads, errors };
}

export default {
  id: 'accepted-red-team-repair-accounting',
  title: 'accepted red-team repair preserves refunds and admits planner-selected ordinary repairs',
  card: 'PR #7080, live #7031',
  fixedBy: { sha: 'HEAD', where: 'lane/redteam-sent-back-accepted-owed', paths: [
    'scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs', 'scripts/operations/fix-run.mjs',
    'scripts/operations/dispatch-providers/fix.mjs',
  ] },
  // This break ships in the same tree as its fix, so the fix is present wherever the break exists.
  // fixPresent must NOT replay the behaviour under test: a regression would then read as "fix absent",
  // the harness would switch to it.fails, and the reproduced break would pass. A regression goes red.
  fixPresent() { return true; },
  async run({ ordinaryLauncher = runFixCli } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'repair-replay-'));
    const env = { WE_COORDINATION_ROOT: root, WE_RESOURCE_CUTOVER: 'shadow', WE_RESOURCE_SHADOW: 'off' };
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try { return { results: [claudeReplay(), await borrowedReplay(false), await borrowedReplay(true), await borrowedReplay(false, false)],
      ordinary: await Promise.all(['conflict', 'ci-heal', 'ordinary'].map(kind => borrowedReplay(kind === 'ci-heal', true, kind, ordinaryLauncher))),
      refund: await borrowedRefundReplay() }; }
    finally {
      Object.entries(saved).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
      rmSync(root, { recursive: true, force: true });
    }
  },
  judge({ results: [claude, borrowed, ci, unreadable], ordinary, refund }) {
    return [
      ...(refund.sameHeadAndResult && refund.attempts.every(n => n === 1)
        && refund.launches[0] !== refund.launches[1] && refund.launches[1] === refund.launches[2]
        && refund.failed.launched === 1 && refund.retried.launched === 2 && refund.replayed.launched === 2
        && refund.failed.receipts === 1 && refund.retried.receipts === 2 && refund.replayed.receipts === 2
        ? [] : [JSON.stringify(refund)]),
      ...(claude.plannerAttempts === 0 && claude.receipt === 'published' && claude.receipts === 1 ? [] : [JSON.stringify(claude)]),
      ...(borrowed.code === 0 && borrowed.launched === 1 && borrowed.receipts === 1 && borrowed.commitReads === 1 ? [] : [JSON.stringify(borrowed)]),
      ...(ci.plannerKind === 'ci-heal' && ci.code === 0 && ci.launched === 1 && ci.ciReads === 1 && ci.receipts === 0 ? [] : [JSON.stringify(ci)]),
      ...(unreadable.code === 1 && unreadable.launched === 0 && unreadable.receipts === 0
        && unreadable.errors.some(e => e.includes('round commit evidence unreadable')) ? [] : [JSON.stringify(unreadable)]),
      ...ordinary.filter(row => row.code !== 0 || row.launched !== 1 || row.receipts !== 1
        || row.plannerMode === 'red-team-sent-back' || row.plannerKind !== (row.fixture === 'ci-heal' ? 'ci-heal' : 'fix')
        || row.ciReads !== (row.fixture === 'ci-heal' ? 1 : 0)).map(row => JSON.stringify(row)),
    ];
  },
};

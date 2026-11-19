/** PR #7080 / #7031: an admitted repair must survive refund accounting and CI-heal admission. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptedRedTeamRepair, failingRedTeamRepair, roundCommitGitOutput } from '../../__tests__/fixtures/accepted-red-team-repair.mjs';
import { planReconcile } from '../../reconcile-core.mjs';
import { planFixesFromReconcile, publishRedTeamFixDispatch } from '../../reconcile-fix-dispatch.mjs';
import { countRedTeamFixComments } from '../../red-team-fix-round-count.mjs';
import { runFixCli } from '../../../operations/fix-run.mjs';

const plan = pr => planReconcile({ prs: [pr], agents: [], now: Date.parse('2026-11-18T12:00:00Z'),
  roundCap: 3, requiredChecks: ['test'] });

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

async function borrowedReplay(ci, readable = true) {
  const pr = ci ? failingRedTeamRepair(7) : acceptedRedTeamRepair(7);
  const row = plan(pr).dispatch[0];
  let launched = 0, ciReads = 0, commitReads = 0;
  const errors = [];
  const run = (cmd, args, opts) => {
    if (cmd === 'git' && ['fetch', 'log', 'merge-tree'].includes(args[0])) {
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
  const result = await runFixCli(['--pr=7', '--session=fix-7', '--ref=lane/7-repair', '--prompt-file=/fixture/brief',
    '--provider=codex', '--repo=o/r', '--lane-repo=/fixture',
    ...(ci ? [`--repair-kind=${row.kind}`] : [`--planned-repair-mode=${row.mode}`, `--red-team-round-cap=${row.roundCap}`])], {
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
      if (!ci && countRedTeamFixComments(pr.comments) !== 1) throw Error('missing receipt before execution');
      launched++;
    } }),
    readLease: () => ({ holder: 'test-holder' }), recordPush: () => {}, persistEvidence: () => {},
    pendingRearm: { read: () => null, clear: () => {}, write: () => {} },
    releaseClaim: async () => ({ released: [] }), recordOutcome: () => {}, recordRouted: () => ({}), appendLoopRow: () => {},
    weRoot: '/fixture', write: () => {}, writeErr: text => errors.push(text.trim()),
  });
  return { fixture: ci ? 'accepted-blocked-required-ci-failure' : readable ? 'three-mechanical-rounds-borrowed' : 'unreadable-round-evidence',
    plannerKind: row.kind, plannerAttempts: row.attempts, code: result.code,
    receipts: countRedTeamFixComments(pr.comments), launched, ciReads, commitReads, errors };
}

export default {
  id: 'accepted-red-team-repair-accounting',
  title: 'accepted red-team repair preserves mechanical refunds and admits ordinary CI-heal',
  card: 'PR #7080, live #7031',
  fixedBy: { sha: 'HEAD', where: 'lane/redteam-sent-back-accepted-owed', paths: [
    'scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs', 'scripts/operations/fix-run.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('requireRoundCommits = false')
      && readFileSync(join(root, 'scripts/operations/fix-run.mjs'), 'utf8').includes('hasRedTeamSentBackLabels(prHead, launch.repairKind)');
  },
  async run() {
    const root = mkdtempSync(join(tmpdir(), 'repair-replay-'));
    const env = { WE_COORDINATION_ROOT: root, WE_RESOURCE_CUTOVER: 'shadow', WE_RESOURCE_SHADOW: 'off' };
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try { return { results: [claudeReplay(), await borrowedReplay(false), await borrowedReplay(true), await borrowedReplay(false, false)] }; }
    finally {
      Object.entries(saved).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
      rmSync(root, { recursive: true, force: true });
    }
  },
  judge({ results: [claude, borrowed, ci, unreadable] }) {
    return [
      ...(claude.plannerAttempts === 0 && claude.receipt === 'published' && claude.receipts === 1 ? [] : [JSON.stringify(claude)]),
      ...(borrowed.code === 0 && borrowed.launched === 1 && borrowed.receipts === 1 && borrowed.commitReads === 1 ? [] : [JSON.stringify(borrowed)]),
      ...(ci.plannerKind === 'ci-heal' && ci.code === 0 && ci.launched === 1 && ci.ciReads === 1 && ci.receipts === 0 ? [] : [JSON.stringify(ci)]),
      ...(unreadable.code === 1 && unreadable.launched === 0 && unreadable.receipts === 0
        && unreadable.errors.some(e => e.includes('round commit evidence unreadable')) ? [] : [JSON.stringify(unreadable)]),
    ];
  },
};

/** PR #5486: explicit prepare windows and deterministic failures survive batch dispatch. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBuildDispatchTick, policyFrom } from '../../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { resolvePreparePolicy } from '../../prepare-policy-settings.mjs';
import { runPrepareBatch } from '../../../operations/prepare-batch.mjs';

const rows = ['7201', '7202', '7203', '7204', '7205'].map((num, i) => ({ num, scope: [`we:scripts/prepare/file${i}.mjs`] }));
function fixture() {
  const claims = new Map(), holds = new Map(), dispatched = [], configs = [];
  const effects = {
    preparePolicy: () => resolvePreparePolicy(),
    planTick: (_bk, { config }) => {
      configs.push(config);
      return { decisions: { spawnPrepareItems: [rows[0]], admission: { queue: rows,
        held: rows.map(r => ({ num: r.num, reason: 'needs-prepare' })) } }, nextState: {} };
    },
    fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
    killSwitch: () => ({ engaged: false }), listHolds: () => [...holds.values()],
    listPrepareClaims: () => [...claims.values()], listPreparePrs: () => [],
    readPrepareStatus: () => ({ preparedDate: null }), readPreparedStamp: () => ({ preparedDate: null }),
    acquirePrepareClaim: args => { claims.set(args.num, { meta: args }); return { ok: true }; },
    releasePrepareClaim: ({ num }) => claims.delete(num),
    placePrepareHold: hold => holds.set(hold.num, hold),
    dispatch: args => { dispatched.push(args); return { dispatching: true, lane: 14 }; },
  };
  return { effects, claims, holds, dispatched, configs };
}

export default {
  id: 'prepare-batch-window-and-failure-accounting',
  title: 'Prepare batches honor explicit windows and hold failed cards across ticks',
  card: 'PR #5486',
  fixedBy: { sha: 'lane/prepare-throughput', where: 'lane/prepare-throughput', paths: [
    'skills-src/conveyor/build-dispatch-daemon.mjs', 'scripts/operations/prepare-batch.mjs',
  ] },
  fixPresent(root) {
    const daemon = readFileSync(join(root, 'skills-src/conveyor/build-dispatch-daemon.mjs'), 'utf8');
    const batch = readFileSync(join(root, 'scripts/operations/prepare-batch.mjs'), 'utf8');
    return daemon.includes('effectivePrepareAheadWindow') && batch.includes('deferredToNextBatch: [...conflicts]');
  },
  async run({ log } = {}) {
    const problems = [];
    for (const value of ['2', 'off']) for (const source of ['flag', 'env']) {
      const f = fixture();
      const plan = f.effects.planTick;
      f.effects.planTick = (bk, opts) => {
        const out = plan(bk, opts);
        out.decisions.spawnPrepareItems = rows.slice(0, 2);
        return out;
      };
      f.effects.now = () => Date.parse('2026-10-15T12:00:00Z');
      f.effects.listPreparePrs = ({ num }) => num === '7202' ? [{ number: 94, state: 'MERGED',
        headRefName: 'lane/7202-prepare-design', mergedAt: '2026-10-15T11:00:00Z' }] : [];
      const policy = policyFrom(source === 'flag' ? { 'prepare-ahead-window': value } : {},
        source === 'env' ? { WE_BUILD_DAEMON_PREPARE_AHEAD_WINDOW: value } : {});
      await runBuildDispatchTick({ live: true, policy, effects: f.effects });
      if (f.configs.length < 2) problems.push(`${source} ${value}: replan not exercised`);
      if (f.configs.some(c => c.prepareAheadWindow !== (value === 'off' ? undefined : 2))) problems.push(`${source} ${value}: window overridden`);
      const expected = value === 'off' ? ['7203', '7204', '7205'] : ['7203'];
      if (JSON.stringify(f.dispatched[0]?.groupMembers) !== JSON.stringify(expected)) problems.push(`${source} ${value}: wrong batch members`);
    }
    for (const mode of ['member', 'lead', 'all', 'conflict', 'assembled-gate-red', 'publication-failed', 'assembly-threw']) {
      const assemblyFailed = ['assembled-gate-red', 'publication-failed', 'assembly-threw'].includes(mode);
      const failures = mode === 'all' || assemblyFailed ? ['7201', '7202'] : mode === 'lead' ? ['7201'] : ['7202'];
      const result = await runPrepareBatch({ num: '7201', groupMembers: ['7202'], session: 'soak' }, {
        log: () => {}, findItem: num => ({ path: `backlog/${num}-card.md` }), retainPrepareCommit: () => {},
        startPrepareAssembly: () => { if (mode === 'assembly-threw') throw new Error('assembly failed'); }, finishPrepareAssembly: () => {},
        cherryPickPrepare: (_lane, card) => mode === 'conflict' && card.num === '7202' ? { ok: false, conflict: true } : { ok: true },
        runGate: () => ({ pass: mode !== 'assembled-gate-red' }), writePrBody: () => '/tmp/soak-body', openPr: () => ({ ok: mode !== 'publication-failed', pr: 99 }),
      }, resolvePreparePolicy(), async ({ num }) => !assemblyFailed && mode !== 'conflict' && failures.includes(num)
        ? { outcome: 'gate-red' } : { outcome: 'prepared-commit', num, lanePath: '/tmp/soak-lane', sha: 'commit', baseSha: 'base' });
      const f = fixture();
      f.claims.set('7201', { meta: { num: '7201' } });
      f.claims.set('7202', { meta: { num: '7202', groupLead: '7201' } });
      f.effects.listSettledPrepares = () => [{ ...result, num: '7201', startedAt: '9999-01-01T00:00:00Z', source: `run ${mode}` }];
      f.effects.readPrepareStatus = ({ num }) => ({ preparedDate: failures.includes(num) ? null : '2026-10-17' });
      const tick = await runBuildDispatchTick({ live: true, effects: f.effects });
      await runBuildDispatchTick({ live: true, effects: f.effects, bookkeeping: tick.nextBookkeeping });
      for (const num of failures) {
        if (mode === 'conflict') {
          if (f.holds.has(num)) problems.push('conflicting card spent a failure hold');
          if (!f.dispatched.some(d => d.num === num || d.groupMembers?.includes(num))) problems.push('conflicting card was not retried');
        } else {
          if (!f.holds.has(num)) problems.push(`${mode}: failed card ${num} has no hold`);
          if (f.dispatched.some(d => d.num === num || d.groupMembers?.includes(num))) problems.push(`${mode}: failed card ${num} redispatched`);
        }
      }
    }
    log?.(JSON.stringify(problems));
    return { problems };
  },
  judge(report) { return report.problems; },
};

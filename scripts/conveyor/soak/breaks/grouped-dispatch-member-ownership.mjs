/** PR #5187: grouped routes, replacement stamps and member card leases. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBuildDispatchTick } from '../../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { BUILD_DISPATCH_POLICY } from '../../build-dispatch-policy.mjs';
import { shapeDispatchRead } from '../../../operations/dispatch-lane.mjs';

export default {
  id: 'grouped-dispatch-member-ownership',
  title: 'Grouped dispatch retains ownership until each member can be delivered',
  card: 'PR #5187',
  fixedBy: { sha: 'lane/grouped-builds', where: 'lane/grouped-builds', paths: [
    'skills-src/conveyor/build-dispatch-daemon.mjs', 'scripts/operations/dispatch-lane.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'skills-src/conveyor/build-dispatch-daemon.mjs'), 'utf8').includes('groupCapable');
  },
  async run({ log } = {}) {
    const violations = [];
    const rows = ['7101', '7102', '7103'].map((num, i) => ({ num, kind: 'task', estimatedLoc: 100,
      parent: '7100', locus: 'we', scope: [`we:scripts/group/file${i}.mjs`] }));
    const common = { fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
      killSwitch: () => ({ engaged: false }) };
    const claimed = [];
    await runBuildDispatchTick({ live: true, policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 1, maxOpenItems: 1 }, effects: {
      ...common,
      planTick: () => ({ decisions: { spawnBuilds: rows, admission: { queue: rows, cleared: rows } }, nextState: {} }),
      predictRoute: async () => ({ executor: 'codex', groupCapable: false }),
      acquireClaim: ({ num }) => { claimed.push(num); return { ok: true }; }, releaseClaim: () => {},
      dispatch: () => ({ dispatching: true }),
    } });
    if (claimed.length !== 1) violations.push({ invariant: 'unsupported-group-route', detail: `probation build claimed ${claimed.length} cards` });

    const prepareClaimed = [];
    await runBuildDispatchTick({ live: true, effects: { ...common,
      planTick: () => ({ decisions: { spawnPrepareItems: [rows[0]], admission: {
        queue: rows, held: rows.map(r => ({ num: r.num, reason: 'needs-prepare' })),
      } }, nextState: {} }),
      predictRoute: async () => ({ groupCapable: false }), readPrepareStatus: () => ({ preparedDate: null }),
      readPreparedStamp: () => ({ preparedDate: null }),
      acquirePrepareClaim: ({ num }) => { prepareClaimed.push(num); return { ok: true }; },
      releasePrepareClaim: () => {}, dispatch: () => ({ dispatching: true }),
    } });
    if (prepareClaimed.length !== 1) violations.push({ invariant: 'unsupported-group-prepare', detail: `agent prepare claimed ${prepareClaimed.length} cards` });

    let stamp = '2026-10-01';
    const claims = new Map([['7202', { meta: { num: '7202', groupLead: '7201',
      replacesStamp: { preparedDate: stamp, preparedAgainstSha: 'old-base' } } }]]);
    const effects = { ...common,
      planTick: () => ({ decisions: { spawnPrepareItems: [{ num: '7202' }] }, nextState: {} }),
      listPrepareClaims: () => [...claims.values()], listPrepareInFlight: () => [{ num: '7201' }],
      readPrepareStatus: ({ num }) => ({ preparedDate: num === '7202' ? stamp : null, preparedAgainstSha: 'old-base' }),
      releasePrepareClaim: ({ num }) => claims.delete(num),
      acquirePrepareClaim: () => ({ ok: true }), dispatch: () => { violations.push({ invariant: 'duplicate-prepare', detail: 'member redispatched during lead preparation' }); return { dispatching: true }; },
    };
    for (let i = 0; i < 2; i++) await runBuildDispatchTick({ live: true, effects });
    if (!claims.has('7202')) violations.push({ invariant: 'stale-member-released', detail: 'unchanged stale stamp retired a live member claim' });
    stamp = '2026-10-13';
    await runBuildDispatchTick({ live: true, effects });
    if (claims.has('7202')) violations.push({ invariant: 'replacement-member-retained', detail: 'replacement stamp did not retire the member claim' });

    const shaped = shapeDispatchRead({ resolvedNum: '7301', launchKind: 'prepare-item', launch: { num: '7301', lane: 1 },
      item: { num: '7301', slug: 'lead', specPath: 'backlog/7301-lead.md' },
      groupItems: [{ num: '7302', specPath: 'backlog/7302-member.md' }],
      briefTemplate: 'Prepare {{ITEM_NUM}}. {{GROUP_MEMBERS}}', nextState: {}, notes: [],
      inFlightDispatches: { runs: [], unreadable: 0 }, repoTokens: { WE_ROOT: '/tmp/we' },
    }, { num: '7301', groupMembers: ['7302'] });
    if (!shaped.scope.includes('we:backlog/7302-member.md')) violations.push({ invariant: 'member-outside-lease', detail: 'grouped prepare omitted the member card lease' });
    log?.(JSON.stringify(violations));
    return { violations };
  },
  judge(report) { return report.violations.map(v => `[${v.invariant}] ${v.detail}`); },
};

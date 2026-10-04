import { expect, it } from 'vitest';
import { runBuildDispatchTick } from '../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { readRoutingPolicy } from '../../lib/dispatch-routing-policy-io.mjs';
import { decideDispatchRoute } from '../../lib/dispatch-contracts.mjs';
import { routeDispatchProvider } from '../dispatch-lane-io.mjs';

it('replays the builder dry-run before/after with identical historical prepare failures and no launches', async () => {
  const current = readRoutingPolicy();
  const previous = structuredClone(current);
  previous.operations['prepare-item'] = { inherit: true };
  previous.criticalWorkGate.kinds.push('prepare-item');
  const effects = {
    planTick: () => ({ decisions: { itemPrepareSpawns: [{ num: '4501', lane: 1 }] }, nextState: { tick: 1 } }),
    fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
    killSwitch: () => ({ engaged: false }), listPrepareInFlight: () => [], listPrepareClaims: () => [],
    readPrepareStatus: () => ({ preparedDate: null }),
    listProbationPrepares: () => ['old-1', 'old-2'].map((handle, i) => ({ handle, item: `${4300 + i}`, scoredAt: `2026-09-29T0${i}:00:00Z`, dispatchKind: 'probation-launch', taskType: 'prepare', repo: 'web-everything/web-everything', launchOutcome: 'gate-red', pr: null })),
    dispatch: () => { throw new Error('a dry-run must not dispatch'); },
  };
  const snapshots = [];
  for (const [label, policy] of [['before', previous], ['after', current]]) {
    const tick = await runBuildDispatchTick({ live: false, effects, routingPolicy: policy });
    const route = decideDispatchRoute({ kind: 'prepare-item', cardPath: 'we:backlog/4501-card.md' }, { routingPolicy: policy });
    const fallback = tick.prepare.route === 'prepare-route-fallback';
    const selected = routeDispatchProvider({ launchKind: 'prepare-item', policyRoute: route.policyRoute, probationWorker: route.probationWorker, table: { model: 'sonnet' } }, {
      probationLaunch: fallback ? 'off' : 'on', scriptExists: () => true,
      probation: request => ({ provider: request.probationWorker.provider, model: request.probationWorker.model }),
      agent: request => ({ provider: 'claude', model: request.table.model }),
    });
    snapshots.push({ label, route: tick.prepare.route, planned: tick.prepare.planned, launched: tick.prepare.launched.length, ...selected });
  }
  expect(snapshots[0]).toMatchObject({ provider: 'claude', model: 'sonnet', launched: 0 });
  expect(snapshots[1]).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', launched: 0 });
  expect(snapshots[1].planned).toEqual(snapshots[0].planned);
  console.log(JSON.stringify({ builderDryRunReplay: snapshots }, null, 2));
});

it('routes a card-less prepare to Claude through the fail-closed gate', () => {
  const route = decideDispatchRoute({ kind: 'prepare-item' }, { routingPolicy: readRoutingPolicy() });
  expect(route.policyRoute).toMatchObject({ provider: 'claude' });
});

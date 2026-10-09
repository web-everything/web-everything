import { describe, it, expect } from 'vitest';
import { readTick } from '../dispatch-lane-io.mjs';
const PRIMARY = '/primary/webeverything';
const NOW = '2026-09-26T10:00:00.000Z';

/** Which of `tick-core`'s six launch lists a launch kind is selected from — mirrors `dispatch-lane-io.mjs`'s
 *  own `LAUNCH_LISTS`. */
const LIST_BY_KIND = {
  build: 'spawnBuilds',
  prepare: 'spawnPrepareScope',
  'prepare-decision': 'spawnPrepareDecision',
  investigate: 'spawnInvestigations',
  fix: 'spawnFixes',
  'ci-heal': 'spawnCiHeals',
};

/** A minimal tick, as `tick-core.mjs` would return one, clearing exactly ONE item for ONE launch kind. */
function tickFor(launchKind, num, lane = 1) {
  const repairs = launchKind === 'fix' || launchKind === 'ci-heal';
  const row = { num, lane, ...(repairs ? { pr: 555, reason: 'ci-red' } : {}) };
  return {
    decisions: {
      spawnBuilds: [], spawnPrepareScope: [], spawnPrepareDecision: [], spawnInvestigations: [],
      spawnFixes: [], spawnCiHeals: [], suppressedBuilds: [], statusLine: 'conveyor', notes: [],
      [LIST_BY_KIND[launchKind]]: [row],
    },
    nextState: { tick: 1, buildGuards: [], prepareGuards: [], fixGuards: [], ciHealGuards: [] },
  };
}

/** A scoped item — non-doc, non-machinery path — so `build`/`fix`/`ci-heal` derive `build-new-feature`/
 *  `bugfix` (not `doc-fix`) and the model-tier table lands on `sonnet`, not `opus` (`we:scripts/operations/
 *  dispatch-lane-io.mjs` itself is in `DISPATCH_MACHINERY_PATHS` — this path deliberately is not). */
const ITEM = { num: '9001', slug: 'route-check', scope: ['we:scripts/operations/example.mjs'], size: 3 };

/** Drive `readTick` directly (the io shell), fully hermetic: no `gh`, no `claude`, no real scorecard store, no
 *  real backlog file. Every process/fs boundary the shell reaches is stubbed. */
function runReadTick(launchKind, { item = ITEM, scorecards = [], deliveryAgentOverride = null, dispatchModes = () => ({}) } = {}) {
  return readTick({
    num: ITEM.num,
    root: PRIMARY,
    runNode: () => JSON.stringify(tickFor(launchKind, ITEM.num)),
    readText: () => '# brief\n',
    loadItems: () => [item],
    listInFlightDispatches: () => ({ runs: [], unreadable: 0 }),
    listAgents: () => [],
    recordLiveness: (s) => s,
    laneRefForPr: () => 'lane/9001',
    checkAlreadyDone: () => ({ done: false, pr: null, checked: false }),
    checkBuildDelivery: () => null,
    // #3906 — hermetic routing evidence: never the host's shared scorecard store.
    readScorecards: () => scorecards,
    readDeliveryAgentOverride: () => deliveryAgentOverride,
    dispatchModes,
    now: () => new Date(NOW),
  });
}

// PR #3311 round 3: exercise card loading, not just a hand-built router request.
describe('all policy-routed roles read the card critical-work signals', () => {
  it.each(['prepare', 'prepare-decision', 'investigate'])('%s keeps security and high-risk cards on Claude', kind => {
    for (const signals of [{ tags: ['security'] }, { risk: 'high' }]) {
      const read = runReadTick(kind, { item: { ...ITEM, ...signals } });
      expect(read.routing.policyRoute.provider).toBe('claude');
      expect(read.routing.probationWorker).toBeNull();
    }
    expect(runReadTick(kind, { item: { ...ITEM, risk: 'low' } }).routing.policyRoute.provider).toBe('codex');
  });
});

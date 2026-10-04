/**
 * @file dispatch-lane-routing-record.test.mjs — #3717/#3906: the provider is COMPUTED before the spawn (never
 *   guessed from a brief sentence), both halves of the decision (routed vs executed) land in the durable run
 *   record, and the model-tier table's answer reaches the actual spawn argv.
 *
 * Written against MAIN's actual API — guided by, but NOT a port of, the prototype branch's own
 * `dispatch-lane-routing-record.test.mjs` (`origin/lane/mechanical-dispatcher`), which asserts a materially
 * different world: supervision enforcement ON by default (main ships it OFF, #4180's own card),
 * `decideDispatchRoute` naming a land-seam `supervisor` (main's record never sets one), and a `--session-id`
 * flag in `buildAgentArgv` (main never passes one — see `dispatch-lane-io.mjs#parseBackgroundedId`'s header).
 *
 * WHAT NONE OF THESE EXPORTS/BEHAVIOURS COULD HAVE BEEN ASSERTED AGAINST BEFORE #3717/#3857/#3906 landed
 * (the real red→green check, since `git checkout origin/main` is not available here):
 *   - `dispatch-lane-io.mjs` had no `routing`/`deliveryAgentOverride`/`plannedWorkerModel` on `readTick`'s
 *     return, no `workerModelTable`/`resolveWorkerModel`/`routeDispatchProvider`/`defaultReadScorecards`
 *     exports, and `buildAgentArgv` took no `table`/`modelReason` and never emitted `--model`.
 *   - `dispatch-lane.mjs#shapeDispatchRead` had no `'task-type'`/`'route'`/`'supervision'` gates at all.
 *   - `dispatch-provider-registry.mjs` and `delivery-agent-marker.mjs` did not exist.
 * So every assertion below that reads one of these fields or gate names would have thrown
 * `TypeError: ... is not a function` / `undefined` on pre-#3906 main.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { advanceWhileRunning, startRun } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { createRegistry } from '../registry.mjs';
import {
  DISPATCH_LANE_OP, DISPATCH_EFFECT, LAUNCH_KINDS, dispatchLaneOperation, shapeDispatchRead,
  BRIEF_REQUIRED_BY_KIND,
} from '../dispatch-lane.mjs';
import {
  REPO_ROOT, readTick, createDispatchSinks, buildAgentArgv, workerModelTable, resolveWorkerModel,
  defaultReadScorecards, defaultClaudeProvider,
} from '../dispatch-lane-io.mjs';
import { decideDispatchRoute as currentRoute } from '../../lib/dispatch-contracts.mjs';
import { inheritedRoutingPolicy } from '../../lib/__tests__/inherited-routing-policy.mjs';
const decideDispatchRoute = (dispatch, options) => currentRoute(dispatch, { routingPolicy: inheritedRoutingPolicy, ...options });

/** A root that is not lane-shaped — `assertNotALaneCheckout` refuses those, and this suite is not about it. */
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
    // #3906 — hermetic routing evidence: never the host's shared scorecard store.
    readScorecards: () => scorecards,
    readDeliveryAgentOverride: () => deliveryAgentOverride,
    dispatchModes,
    now: () => new Date(NOW),
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (a) THE NO-OP PROOF — the critical-work gate keeps build/fix/ci-heal on Claude, with or without clean Codex
//     trial history; prepare/investigate land on the sonnet role rung, prepare-decision on the opus one.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Clean, independently-verified Codex trials across every taskType a `build`/`fix`/`ci-heal` dispatch of THIS
 *  item could derive — recent, `outcome: 'landed'`. If the critical-work gate did not exist, a router asked
 *  to route THESE task types with THIS history would have every reason to consider Codex fit. It never gets
 *  the chance for a gated kind (`build`/`fix`/`ci-heal`) — {@link ../../lib/provider-routing.mjs#CRITICAL_WORK_GATE}. */
const CODEX_TRIALS = ['bugfix', 'build-new-feature', 'doc-fix'].flatMap((taskType) => Array.from({ length: 6 }, (_, i) => ({
  provider: 'codex', model: 'gpt-6-astra', taskType, subjectClass: 'work-agent',
  scoredAt: `2026-09-2${i}T00:00:00Z`, outcome: 'landed', verifiedBy: 'independent-claude', findings: null,
})));

describe('(a) the no-op proof — critical-work gate keeps build/fix/ci-heal on Claude', () => {
  describe('with NO scorecards at all', () => {
    it.each(['build', 'fix'])('%s carries card risk through to the explicit spawn model', (kind) => {
      for (const [risk, model] of [['low', 'sonnet'], ['medium', 'sonnet'], ['high', 'opus']]) {
        const read = runReadTick(kind, { item: { ...ITEM, risk,
          scope: ['we:scripts/operations/dispatch-lane-io.mjs'] } });
        expect(read.routing.risk).toBe(risk);
        expect(read.plannedWorkerModel).toMatchObject({ model });
        const argv = buildAgentArgv({ payload: { prompt: 'build it', num: ITEM.num }, table: read.plannedWorkerModel });
        expect(argv[argv.indexOf('--model') + 1]).toBe(model);
      }
    });

    it('build → routed/executed claude, tier sonnet, plannedWorkerModel sonnet (alias)', () => {
      const read = runReadTick('build');
      expect(read.routing.outcome).toBe('routed');
      expect(read.routing.routed).toBe('claude');
      expect(read.routing.executed).toBe('claude');
      expect(read.routing.tier).toBe('sonnet');
      expect(read.plannedWorkerModel).toMatchObject({ tier: 'sonnet', model: 'sonnet' });
    });

    it('fix and ci-heal → routed/executed claude, tier sonnet', () => {
      for (const launchKind of ['fix', 'ci-heal']) {
        const read = runReadTick(launchKind);
        expect(read.routing.outcome, launchKind).toBe('routed');
        expect(read.routing.routed, launchKind).toBe('claude');
        expect(read.routing.executed, launchKind).toBe('claude');
        expect(read.plannedWorkerModel, launchKind).toMatchObject({ tier: 'sonnet', model: 'sonnet' });
      }
    });

    it('prepare and investigate → role outcome, plannedWorkerModel sonnet', () => {
      for (const launchKind of ['prepare', 'investigate']) {
        const read = runReadTick(launchKind);
        expect(read.routing.outcome, launchKind).toBe('role');
        expect(read.routing.routed, launchKind).toBeNull();
        expect(read.plannedWorkerModel, launchKind).toMatchObject({ tier: 'sonnet', model: 'sonnet' });
      }
    });

    it('prepare-decision → role outcome, plannedWorkerModel opus', () => {
      const read = runReadTick('prepare-decision');
      expect(read.routing.outcome).toBe('role');
      expect(read.routing.routed).toBeNull();
      expect(read.plannedWorkerModel).toMatchObject({ tier: 'opus', model: 'opus' });
    });
  });

  // THE IMPORTANT CASE — clean, verified, recent Codex trials on record for every taskType this item's
  // build/fix/ci-heal dispatch could derive. Claude remains the recommendation, with probation picks on opened rows.
  describe('with CLEAN VERIFIED Codex trials on record for bugfix/build-new-feature/doc-fix', () => {
    it('build, fix and ci-heal offer probation while all retain Claude routing', () => {
      for (const launchKind of ['build', 'fix']) {
        const read = runReadTick(launchKind, { scorecards: CODEX_TRIALS });
        expect(read.routing.outcome, launchKind).toBe('routed');
        expect(read.routing.routed, launchKind).toBe('claude');
        expect(read.routing.executed, launchKind).toBe('claude');
        expect(read.routing.tier, launchKind).toBe('sonnet');
        expect(read.plannedWorkerModel, launchKind).toMatchObject({ tier: 'sonnet', model: 'sonnet' });
        // the gate fired — it did not simply run out of matching trials.
        const gateEntry = read.routing.auditTrail.find((e) => e.criterion === 'critical-work-gate');
        expect(gateEntry, launchKind).toBeTruthy();
        expect(read.routing.taskType, launchKind).toBe(launchKind === 'fix' ? 'bugfix' : 'build-new-feature');
        expect(gateEntry.result, launchKind).toBe('open-non-critical');
        if (launchKind === 'fix') {
          expect(read.routing.probationWorker).toMatchObject({ id: 'antigravity-claude', supervision: 'full', review: 'full' });
        } else {
          expect(read.routing.probationWorker).toMatchObject({ id: 'codex', supervision: 'full', review: 'full' });
        }
      }
      // agy-launcher-probation — `ci-heal` is its own taskType now, opened on probation: the gate opens for this
      // non-critical scope, but the RECOMMENDATION stays Claude (the fallback, so the tier table still applies)
      // and the probation pick rides beside it. The Codex bugfix/doc-fix history above is not ci-heal history.
      const heal = runReadTick('ci-heal', { scorecards: CODEX_TRIALS });
      expect(heal.routing.taskType).toBe('ci-heal');
      expect(heal.routing.routed).toBe('claude');
      expect(heal.routing.executed).toBe('claude');
      expect(heal.plannedWorkerModel).toMatchObject({ tier: 'sonnet', model: 'sonnet' });
      expect(heal.routing.auditTrail.find((e) => e.criterion === 'critical-work-gate').result).toBe('open-non-critical');
      expect(heal.routing.probationWorker).toMatchObject({ id: 'antigravity-claude', executor: 'antigravity', supervision: 'full' });
    });

    it('role kinds are unaffected by scorecards either way — they never reach the provider cascade', () => {
      for (const launchKind of ['prepare', 'investigate']) {
        const read = runReadTick(launchKind, { scorecards: CODEX_TRIALS });
        expect(read.routing.outcome, launchKind).toBe('role');
        expect(read.plannedWorkerModel, launchKind).toMatchObject({ tier: 'sonnet' });
      }
      const decision = runReadTick('prepare-decision', { scorecards: CODEX_TRIALS });
      expect(decision.routing.outcome).toBe('role');
      expect(decision.plannedWorkerModel).toMatchObject({ tier: 'opus' });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (b) the deliveryAgent: marker only reaches the router in `mechanical` mode
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('(b) a `deliveryAgent:` marker with no reason — honoured only when the kind\'s mode is mechanical', () => {
  it('in the default (all-agent) mode: NOT handed to the router — not refused, executed stays claude, honoured: false', () => {
    const read = runReadTick('build', {
      deliveryAgentOverride: { deliveryAgent: 'codex', deliveryAgentReason: null },
      dispatchModes: () => ({}), // all-agent — nothing says `mechanical`
    });
    expect(read.routing.outcome).toBe('routed');
    expect(read.routing.executed).toBe('claude');
    expect(read.routing.refusal).toBeNull();
    expect(read.deliveryAgentOverride).toEqual({ deliveryAgent: 'codex', deliveryAgentReason: null, honoured: false });
  });

  it('with `dispatchModes: () => ({ build: \'mechanical\' })`: the SAME marker IS routed, refusing the route', () => {
    const read = runReadTick('build', {
      deliveryAgentOverride: { deliveryAgent: 'codex', deliveryAgentReason: null },
      dispatchModes: () => ({ build: 'mechanical' }),
    });
    expect(read.deliveryAgentOverride).toEqual({ deliveryAgent: 'codex', deliveryAgentReason: null, honoured: true });
    expect(read.routing.outcome).toBe('refused');
    expect(read.routing.refusal).toContain('deliveryAgentReason');
  });

  it('and dispatch-lane holds with gate \'route\', the refusal riding the hold reason', () => {
    const read = runReadTick('build', {
      deliveryAgentOverride: { deliveryAgent: 'codex', deliveryAgentReason: null },
      dispatchModes: () => ({ build: 'mechanical' }),
    });
    const shaped = shapeDispatchRead(read, { num: ITEM.num, expectedWithinMinutes: 45 });
    expect(shaped.dispatching).toBe(false);
    const routeGate = shaped.gates.find((g) => g.name === 'route');
    expect(routeGate).toBeTruthy();
    expect(routeGate.pass).toBe(false);
    expect(shaped.holdReason).toContain('deliveryAgentReason');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (c) the task-type / supervision gates in `shapeDispatchRead`
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A brief template naming EXACTLY the tokens `BRIEF_REQUIRED_BY_KIND[launchKind]` validates for that kind —
 *  any OTHER recognized placeholder name present but unrequired is `fillBrief`'s own "misspelled" refusal (a
 *  known name not authorized for this call), so each kind needs its own template rather than one shared one. */
function briefFor(launchKind) {
  return `# brief\n${BRIEF_REQUIRED_BY_KIND[launchKind].map((n) => `${n}: {{${n}}}`).join('\n')}\n`;
}

/** A raw `readTick`-shaped fixture for `shapeDispatchRead`, built by hand (as every other test of this pure
 *  function in `dispatch-lane.test.mjs` does) rather than through the io shell, so each case can hand-place
 *  exactly the `item`/`routing` combination its gate needs. */
function rawFor({ launchKind = 'build', item, routing = null, briefTemplate = briefFor(launchKind) } = {}) {
  const repairs = launchKind === 'fix' || launchKind === 'ci-heal';
  return {
    resolvedNum: '9001',
    launch: { num: '9001', lane: 3, ...(repairs ? { pr: 555, reason: 'ci-red' } : {}) },
    laneRef: repairs ? 'lane/9001' : null,
    suppressed: null,
    launchKind,
    item,
    briefTemplate,
    nextState: { tick: 1, buildGuards: [{ num: '9001', lane: 3, spawnedTick: 0 }] },
    dispatchedGuard: { num: '9001', lane: 3, spawnedTick: 0 },
    statusLine: 'conveyor',
    notes: [],
    droppedBookkeepingKeys: [],
    inFlightDispatches: { runs: [], unreadable: 0, livenessSource: 'not-needed' },
    bookkeepingSource: 'file',
    observedAt: NOW,
    // #3960/#4174 — the repo-aware quintet every kind's brief now needs at least `WE_ROOT` from; the two
    // repair kinds need all five (`BRIEF_REQUIRED_BY_KIND.fix`/`.ci-heal`).
    repoTokens: { WE_ROOT: REPO_ROOT, REPO: 'web-everything/web-everything', LANE_REPO: '.', GATE_COMMAND: 'npm test', ATTRIBUTION: 'WE #9001' },
    routing,
  };
}

describe('(c) shapeDispatchRead\'s task-type / supervision gates', () => {
  // CORRECTION, evidenced rather than assumed: a build whose item has NO scope at all does NOT reach the
  // `task-type` gate — it is refused EARLIER, and as a THROW rather than a hold, by the unconditional `scope`
  // gate (`(launchKind === 'build' || repairsExistingPr) && !itemScope.length` — `dispatch-lane.mjs` around
  // "no `scope:`"). That gate's own comment calls itself "unreachable through the core... refused anyway",
  // but it is very much reached by a hand-built fixture, and it fires BEFORE `taskTypeFor` is ever called.
  //
  // Reaching `taskTypeFor`'s OWN "a build with no declared scope" refusal without tripping that earlier throw
  // requires an itemScope that is non-empty (`itemScope.length > 0`, so the `scope` gate passes) but whose
  // every entry trims to nothing (so `taskTypeFor`'s `scopePaths.filter(p => p.trim())` yields zero paths).
  // That combination is impossible to express through a REAL dispatch: `fillBrief`'s own `BRIEF_VALUE_RE`
  // (`/^[A-Za-z0-9_.,:/@#-]+$/`) forbids every whitespace character in `{{SCOPE}}`'s filled value, and any
  // character `String.prototype.trim()` strips is, by definition, whitespace — so no scope entry can
  // simultaneously survive the brief's character-class check and be dropped by `taskTypeFor`'s trim filter.
  // This mirrors the prototype branch's OWN adaptation of this same test (`origin/lane/mechanical-dispatcher`):
  // it, too, asserts the two EARLIER throws (an unknown `launchKind`, an unscoped build) rather than a `build`
  // actually landing on the `task-type` HOLD, with the comment "unreachable today because every kind is on the
  // table" — true on main too, and for an additional, independently-confirmed reason (the brief's own charset).
  it('an unscoped build is refused EARLIER (a throw at the `scope` gate), never reaching the `task-type` gate', () => {
    const item = { num: '9001', slug: 'route-check', specPath: 'backlog/9001-route-check.md', scope: [] };
    expect(() => shapeDispatchRead(rawFor({ launchKind: 'build', item }), { num: '9001', expectedWithinMinutes: 45 }))
      .toThrow(/has no `scope:`/);
  });

  it('an unknown `launchKind` throws before any gate is evaluated at all', () => {
    const item = { num: '9001', slug: 'route-check', specPath: 'backlog/9001-route-check.md', scope: ['we:scripts/operations/example.mjs'] };
    expect(() => shapeDispatchRead(rawFor({ launchKind: 'transmogrify', item, briefTemplate: '# brief\n' }), { num: '9001', expectedWithinMinutes: 45 }))
      .toThrow(/unknown `launchKind`/);
  });

  it('every real launch kind clears the `task-type` gate (LAUNCH_KINDS maps to a taskType or a role, never a refusal)', () => {
    const scopedItem = { num: '9001', slug: 'route-check', specPath: 'backlog/9001-route-check.md', scope: ['we:scripts/operations/example.mjs'] };
    for (const launchKind of LAUNCH_KINDS) {
      const routing = decideDispatchRoute({ kind: launchKind, cause: null, scopePaths: scopedItem.scope }, { scorecards: [] });
      const read = shapeDispatchRead(rawFor({ launchKind, item: scopedItem, routing }), { num: '9001', expectedWithinMinutes: 45 });
      const gate = read.gates.find((g) => g.name === 'task-type');
      expect(gate, launchKind).toBeTruthy();
      expect(gate.pass, launchKind).toBe(true);
    }
  });

  it('holds (gate \'supervision\') when enforceSupervision is true and the route\'s supervision is full with no supervisor', () => {
    const item = { num: '9001', slug: 'route-check', specPath: 'backlog/9001-route-check.md', scope: ['we:scripts/operations/example.mjs'], size: 3 };
    const routing = decideDispatchRoute(
      { kind: 'build', cause: null, scopePaths: item.scope, size: item.size },
      { scorecards: [], enforceSupervision: true },
    );
    // Ground the assumption: main's `decideDispatchRoute` never names a `supervisor` on the record (unlike
    // the prototype's #3850 Fork-1 land-seam wiring), so a `full`-supervision routed record DOES hold once
    // enforcement is on — checked explicitly rather than assumed.
    expect(routing.supervision).toBe('full');
    expect(routing.supervisor).toBeUndefined();
    expect(routing.supervisionHold).toBeTruthy();

    const read = shapeDispatchRead(rawFor({ launchKind: 'build', item, routing }), { num: '9001', expectedWithinMinutes: 45 });
    expect(read.dispatching).toBe(false);
    const gate = read.gates.find((g) => g.name === 'supervision');
    expect(gate).toBeTruthy();
    expect(gate.pass).toBe(false);
    expect(read.holdReason).toContain(routing.supervisionHold);
  });

  it('with enforceSupervision off (the default), the same route never holds on supervision', () => {
    const item = { num: '9001', slug: 'route-check', specPath: 'backlog/9001-route-check.md', scope: ['we:scripts/operations/example.mjs'], size: 3 };
    const routing = decideDispatchRoute({ kind: 'build', cause: null, scopePaths: item.scope, size: item.size }, { scorecards: [] });
    expect(routing.supervisionHold).toBeNull();
    const read = shapeDispatchRead(rawFor({ launchKind: 'build', item, routing }), { num: '9001', expectedWithinMinutes: 45 });
    expect(read.dispatching).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (d) end to end through the sink — the model reaches the real spawn argv and the durable run record
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('(d) end to end: readTick → dispatch-lane → createDispatchSinks', () => {
  /** ONE WHOLE DISPATCH — the real `readTick`, the real declaration, the real sink, the real brief file on
   *  disk, and a STUB SPAWNER. Mirrors `dispatch-lane.test.mjs`'s own `dispatchThrough`, with the #3906 routing
   *  evidence stubbed hermetically (never the host's real scorecard store). */
  async function dispatchThrough({ num, tick, items }) {
    const spawned = [];
    const registry = createRegistry();
    registry.register(dispatchLaneOperation({
      readTick: (asked) => readTick({
        ...asked,
        // NO `root` override here — this reads the REAL brief templates off disk (`skills-src/conveyor/*.md`),
        // exactly like `dispatch-lane.test.mjs`'s own `dispatchThrough`. Only the SINK's `root` (below) is the
        // fake, non-lane path — `assertNotALaneCheckout` reads that one, and it is a separate parameter.
        runNode: () => JSON.stringify(tick),
        readText: (path) => readFileSync(path, 'utf8'),
        loadItems: () => items,
        listInFlightDispatches: () => ({ runs: [], unreadable: 0 }),
        listAgents: () => [],
        checkAlreadyDone: () => ({ done: false, pr: null, checked: false }),
        // #3906 — hermetic routing evidence, never the host's shared scorecard store.
        readScorecards: () => [],
        readDeliveryAgentOverride: () => null,
        dispatchModes: () => ({}),
      }),
    }));
    const run = advanceWhileRunning(startRun({ op: DISPATCH_LANE_OP, id: `run-${num}`, input: { num }, registry }), { registry });
    const outcome = await applyPendingEffects(run, {
      // `root` a fake, non-lane path (as every other test in this repo does): `ensureDispatchSessionCwd`'s
      // `mkdirSync` genuinely fails under a path this sandboxed test has no permission to create, so nothing
      // under it is ever actually written — see `dispatch-lane-io.mjs#ensureDispatchSessionCwd`'s own docblock.
      sinks: createDispatchSinks({
        root: PRIMARY,
        spawnAgent: (argv, opts) => { spawned.push({ argv, opts }); return 'backgrounded · 1ae0905c · x\n'; },
        mintSessionId: () => 'sess-9002',
        now: () => new Date(NOW),
      }),
      store: createMemoryRunStore(),
    });
    return { run: outcome.run, spawned };
  }

  it('a build spawn carries --model sonnet exactly once, and the run record carries the executor, the criteria recommendation and the workerModel', async () => {
    const tick = {
      decisions: {
        spawnBuilds: [{ num: '9002', lane: 4 }], spawnPrepareScope: [], spawnPrepareDecision: [],
        spawnInvestigations: [], spawnFixes: [], spawnCiHeals: [], suppressedBuilds: [], statusLine: '', notes: [],
      },
      nextState: { tick: 1, buildGuards: [{ num: '9002', lane: 4, spawnedTick: 0 }] },
    };
    const items = [{ num: '9002', slug: 'route-check-2', scope: ['we:scripts/operations/example.mjs'], size: 3 }];
    const { run, spawned } = await dispatchThrough({ num: '9002', tick, items });

    expect(spawned).toHaveLength(1);
    const argv = spawned[0].argv;
    const modelIdx = argv.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(argv[modelIdx + 1]).toBe('sonnet');
    // exactly once
    expect(argv.filter((a) => a === '--model')).toHaveLength(1);

    const effect = run.effects.find((e) => e.type === DISPATCH_EFFECT);
    expect(effect.dispatch.workerModel).toMatchObject({ name: 'sonnet', tier: 'sonnet', source: 'table' });
    expect(effect.dispatch.criteriaRecommendation).toBe('claude');
    expect(effect.dispatch.executor).toBe('claude');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (e) buildAgentArgv / resolveWorkerModel — the model-tier table reaches the real spawn argv (#3857)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('(e) buildAgentArgv with a table, and resolveWorkerModel\'s own shape', () => {
  const TABLE = { tier: 'sonnet', model: 'sonnet', reason: "the standard's default" };
  const payload = { prompt: '# build #9001', sessionSlug: 'conveyor-9001' };

  it.each([...LAUNCH_KINDS, 'review', 'inspect'])('%s always gets exactly one explicit model', (launchKind) => {
    const argv = buildAgentArgv({ payload: { ...payload, launchKind } });
    expect(argv.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(argv[argv.indexOf('--model') + 1]).toBe(launchKind === 'prepare-decision' ? 'opus' : 'sonnet');
  });

  it.each(LAUNCH_KINDS)('the Claude provider forwards the %s kind to model resolution', (launchKind) => {
    let argv;
    defaultClaudeProvider({ prompt: payload.prompt, launchKind }, {
      spawnAgent: (args) => { argv = args; return 'backgrounded · abc123 · worker'; },
    });
    expect(argv.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(argv[argv.indexOf('--model') + 1]).toBe(launchKind === 'prepare-decision' ? 'opus' : 'sonnet');
  });

  it.each([
    { payload: { ...payload, launchKind: 'unregistered-kind' } },
    { payload, table: { tier: 'unknown', model: null } },
    { payload, extraArgs: ['--model', '   '] },
    { payload, extraArgs: ['--model'] },
  ])('refuses a fresh spawn with no resolvable model: %j', (options) => {
    expect(() => buildAgentArgv(options)).toThrow(/resolvable --model/);
    try { buildAgentArgv(options); } catch (error) { expect(error.notApplied).toBe(true); }
  });

  it('refuses an unresolved model before the provider can spawn', () => {
    const spawnAgent = vi.fn();
    expect(() => defaultClaudeProvider({ prompt: payload.prompt, launchKind: 'unregistered-kind' }, { spawnAgent }))
      .toThrow(/resolvable --model/);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it('a resume retains its model even when no fresh model resolves', () => {
    expect(buildAgentArgv({ payload, table: { model: null }, resumeSessionId: 'existing' }))
      .toEqual(['--bg', '--resume', 'existing', payload.prompt]);
  });

  it('normalizes repeated explicit choices to one model without changing the last choice', () => {
    const argv = buildAgentArgv({ payload, extraArgs: ['--model', 'sonnet', '--model=opus'] });
    expect(argv.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
  });

  it('injects exactly ONE --model from the table', () => {
    const argv = buildAgentArgv({ sessionId: 's1', payload, table: TABLE });
    expect(argv.filter((a) => a === '--model')).toHaveLength(1);
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('refuses an UNREASONED hand-set --model / -m / --model= in extraArgs — .notApplied is truthy', () => {
    for (const flags of [['--model', 'opus'], ['-m', 'opus'], ['--model=opus']]) {
      let caught = null;
      try {
        buildAgentArgv({ sessionId: 's1', payload, extraArgs: flags, table: TABLE });
      } catch (e) {
        caught = e;
      }
      expect(caught, JSON.stringify(flags)).toBeTruthy();
      expect(caught.notApplied, JSON.stringify(flags)).toBeTruthy();
      expect(String(caught.message)).toMatch(/modelReason/);
    }
  });

  it('honours a REASONED hand-set --model — source \'override\'', () => {
    const argv = buildAgentArgv({
      sessionId: 's1', payload, extraArgs: ['--model', 'opus'], table: TABLE, modelReason: 'operator pin',
    });
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    const decision = resolveWorkerModel({ extraArgs: ['--model', 'opus'], table: TABLE, modelReason: 'operator pin' });
    expect(decision).toMatchObject({ model: 'opus', source: 'override', refusal: null });
  });

  it('refuses a reason with no --model set to explain', () => {
    const decision = resolveWorkerModel({ extraArgs: [], table: TABLE, modelReason: 'because' });
    expect(decision.refusal).toContain('no --model was set');
    expect(() => buildAgentArgv({ sessionId: 's1', payload, table: TABLE, modelReason: 'because' }))
      .toThrow(/no --model was set/);
  });

  it('refuses a Fable model even WITH a reason', () => {
    const decision = resolveWorkerModel({ extraArgs: ['--model', 'fable-1'], table: TABLE, modelReason: 'why not' });
    expect(decision.refusal).toContain('Fable');
    expect(() => buildAgentArgv({ sessionId: 's1', payload, extraArgs: ['--model', 'fable-1'], table: TABLE, modelReason: 'why not' }))
      .toThrow(/Fable/);
  });

  it('with `table: null`, an existing explicit model is preserved', () => {
    const argv = buildAgentArgv({ sessionId: 's1', payload, extraArgs: ['--model', 'opus'] });
    expect(argv).toEqual([
      '--bg', '-n', 'conveyor-9001',
      '--settings', JSON.stringify({ env: { WE_CONVEYOR_WORKER: '1' } }),
      '--effort', 'high', '--model', 'opus', '# build #9001',
    ]);
  });

  it('resolveWorkerModel returns the full documented shape for a plain table decision', () => {
    const decision = resolveWorkerModel({ extraArgs: [], table: TABLE });
    expect(decision).toEqual({
      model: 'sonnet', tier: 'sonnet', source: 'table', tableTier: 'sonnet',
      reason: "the standard's default", cleanArgs: [], refusal: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (f) workerModelTable
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('(f) workerModelTable', () => {
  it('a routed record whose model is a native Claude id → that id and its tier', () => {
    expect(workerModelTable({ outcome: 'routed', model: 'claude-sonnet-5-5', tier: 'sonnet' }))
      .toMatchObject({ tier: 'sonnet', model: 'sonnet' });
    expect(workerModelTable({ outcome: 'routed', model: 'claude-opus-5', tier: 'opus' }))
      .toMatchObject({ tier: 'opus', model: 'opus' });
    // #3906 — the spawn flag is the tier ALIAS, never the record's pinned id: a worker must never run an older
    // model than the current one of its tier (the pinned `claude-opus-5` predates Opus 5.5).
    expect(workerModelTable({ outcome: 'routed', model: 'claude-opus-5', tier: 'opus' }).model).not.toMatch(/claude-opus-5/);
  });

  it('a role record with a tier → that tier\'s spawn alias', () => {
    expect(workerModelTable({ outcome: 'role', role: 'prepare', tier: 'sonnet' }))
      .toMatchObject({ tier: 'sonnet', model: 'sonnet' });
    expect(workerModelTable({ outcome: 'role', role: 'prepare-decision', tier: 'opus' }))
      .toMatchObject({ tier: 'opus', model: 'opus' });
  });

  it('an external route (a non-Claude model id) → null', () => {
    expect(workerModelTable({ outcome: 'routed', model: 'gpt-6-astra', tier: null })).toBeNull();
  });

  it('null/undefined and a refused record → null', () => {
    expect(workerModelTable(null)).toBeNull();
    expect(workerModelTable(undefined)).toBeNull();
    expect(workerModelTable({ outcome: 'refused', model: null, tier: null })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (g) defaultReadScorecards — fail-closed on anything but a real records array
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('(g) defaultReadScorecards', () => {
  it('an injected readStore returning records passes them through, filtered to objects', () => {
    const records = [{ provider: 'codex' }, 'garbage', 42, null, { provider: 'claude' }];
    expect(defaultReadScorecards({ readStore: () => ({ records }) }))
      .toEqual([{ provider: 'codex' }, { provider: 'claude' }]);
  });

  it('a throwing readStore degrades to []', () => {
    expect(defaultReadScorecards({ readStore: () => { throw new Error('ENOENT'); } })).toEqual([]);
  });

  it('garbage (a non-array `records`, or no `records` at all) degrades to []', () => {
    expect(defaultReadScorecards({ readStore: () => ({ records: 'not-an-array' }) })).toEqual([]);
    expect(defaultReadScorecards({ readStore: () => ({}) })).toEqual([]);
    expect(defaultReadScorecards({ readStore: () => null })).toEqual([]);
    expect(defaultReadScorecards({ readStore: () => undefined })).toEqual([]);
  });
});

// These regressions prove the inherited tier/evidence router, not today's explicit operator defaults.
vi.mock('../../lib/dispatch-routing-policy-io.mjs', async importOriginal => {
  const actual = await importOriginal();
  const { inheritedRoutingPolicy: policy } = await import('../../lib/__tests__/inherited-routing-policy.mjs');
  return { ...actual, readRoutingPolicy: () => policy,
    resolveOperationRoute: options => actual.resolveOperationRoute({ ...options, policy }),
    resolveDispatchRoute: (dispatch, options) => actual.resolveDispatchRoute(dispatch, { ...options, routingPolicy: policy }) };
});

import { recordPrepareFailure, readFailureState } from '../../../scripts/conveyor/prepare-failure-policy.mjs';
import { planPrepareSpawns } from '../../../scripts/conveyor/tick-core.mjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// #4465 review — `cliRouteHeldItems`'s (a)/(b) routes ultimately call `cliSpawnHoldLand`, which spawns a REAL
// detached `node` process via `defaultSpawnDetached`. A wiring test that exercises the real reserve/spawn
// path (rather than just `typeof cliRouteHeldItems === 'function'`) must not actually spawn that process —
// mock ONLY this one module, so `cliSpawnHoldLand`'s own argv construction and the REAL `reserveHoldRoute`/
// `appendHoldFinding` primitives underneath it are still exercised for real. `vi.hoisted` is required here
// (not a plain top-level `const`) because `vi.mock` itself is hoisted above every other statement in this
// file, including ordinary `const` declarations — a factory that closes over an un-hoisted variable would
// see it as `undefined` at mock-registration time.
const { spawnCalls, fakeDetachedResult } = vi.hoisted(() => ({
  spawnCalls: [],
  fakeDetachedResult: { spawned: true, pid: 4242, logPath: '/tmp/fake-hold-route.log' },
}));
vi.mock('../../../scripts/operations/detached-dispatch.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    defaultSpawnDetached: (argv, opts) => { spawnCalls.push({ argv, opts }); return fakeDetachedResult; },
    deliveryDispatchLogPath: (slug) => `/tmp/fake-hold-route-${slug}.log`,
  };
});

import {
  prepareRouteFallback, cliDispatch, runBuildDispatchTick, settleBookkeeping, readKillSwitch, readDispatchOutcome, KILL_SWITCH_ENV,
  cliReadPrepareStatus, cliPredictRoute, cliListSettledBuilds, cliListRunStoreInFlight, cliListHolds, policyFrom,
  // #4348-open-pr-retry
  primaryInfraStoreEnv, cliRetryInfraBlocked,
  // #4464 builder-cap-machine-wide
  cliPlanTick, BUILD_DAEMON_LANE_CAP_EXEMPT_VALUE,
  // #4517 — infra-retry call bound
  INFRA_RETRY_TIMEOUT_MS, DEFAULT_INTERVAL_MS,
  // #4465 build-dispatch-hold-router
  cliRouteHeldItems, cliSpawnHoldLand, cliStampPrepare, cliReadStampFailure, STAMP_RECOVERY_LEASE_MINUTES, cliPrepareFailureEvidence,
  // xovjhwh — the shared attribution derivation `runBuildDispatchTick` and `dryRun` both call
  deriveDispatchedByBuilder,
} from '../build-dispatch-daemon.mjs';
import { listHoldFindings } from '../../../scripts/conveyor/build-dispatch-hold-router.mjs';
import { MAX_CONCURRENT_LANES_ENV } from '../../../scripts/lib/lane-concurrency.mjs';
import {
  acquireBuildDispatchClaim, releaseBuildDispatchClaim, listBuildDispatchClaims,
  placeBuildDispatchHold, listBuildDispatchHolds,
} from '../../../scripts/conveyor/build-dispatch-claim.mjs';
import { BUILD_DISPATCH_POLICY } from '../../../scripts/conveyor/build-dispatch-policy.mjs';
import { createFileRunStore, newRunRecord } from '../../../scripts/operations/run-store.mjs';
import { DISPATCH_EFFECT } from '../../../scripts/operations/dispatch-lane.mjs';

// xbrndtm — `fixedCadence: true` in `live()` is the one-line opt-in that turns the builder's loop from
// sleep-after-work (180s tick + 120s sleep = a 300s start interval) into a fixed start-to-start cadence. The loop
// is tested with the flag passed explicitly and the soak only runs `--dry-run` (never the loop), so without this a
// refactor that drops the opt-in leaves every other test green. Source-level on purpose: `live()` acquires a real
// lease and heartbeat, so it is not callable from a unit test.
describe('live() keeps the builder on a fixed cadence (xbrndtm)', () => {
  const source = readFileSync(resolve(fileURLToPath(import.meta.url), '..', '..', 'build-dispatch-daemon.mjs'), 'utf8');
  /** The text of the `{ … }` options object of the first `runDaemonLoop(` call inside `async function live(`. */
  function liveLoopOptions(src = source) {
    const start = src.indexOf('async function live(');
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    const call = body.indexOf('runDaemonLoop(');
    expect(call, 'live() must drive runDaemonLoop').toBeGreaterThan(-1);
    const open = body.indexOf('{', call);
    let depth = 0;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) return body.slice(open, i + 1);
    }
    throw new Error('unbalanced runDaemonLoop options');
  }

  it('passes fixedCadence: true to runDaemonLoop', () => {
    expect(liveLoopOptions()).toMatch(/\bfixedCadence\s*:\s*true\b/);
  });

  it('the extractor reads only the call options (a mention elsewhere in live() does not satisfy the guard)', () => {
    const decoy = source.replace('fixedCadence: true, ', '').replace('async function live(flags) {', 'async function live(flags) {\n  // fixedCadence: true (decoy)');
    expect(liveLoopOptions(decoy)).not.toMatch(/\bfixedCadence\s*:\s*true\b/);
  });
});

/** A tick-core answer: both items cleared + queued, both launchable, both on the SAME file. */
function sameFileTick(prev = {}) {
  const tick = prev.tick ?? 0;
  const scope = ['plateau-app:src/main.ts'];
  return {
    decisions: {
      statusLine: 'test',
      counts: { building: 0 },
      spawnBuilds: [{ num: '3827', lane: 13 }, { num: '2662', lane: 14 }],
      admission: {
        queue: [{ num: '3827', scope }, { num: '2662', scope: [...scope, 'plateau-app:src/x.ts'] }],
        cleared: [{ num: '3827', ready: true }, { num: '2662', ready: true }],
      },
    },
    nextState: {
      tick: tick + 1,
      buildGuards: [...(prev.buildGuards || []), { num: '3827', lane: 13, spawnedTick: tick }, { num: '2662', lane: 14, spawnedTick: tick }],
      launchedNums: [...(prev.launchedNums || []), '3827', '2662'],
    },
  };
}

/** Real claim module over a temp lock root; `pid` stands in for the daemon process (a restart = new pid).
 *  `runStoreInFlight`/`settledBuilds` (xovjhwh) are THIS builder's own durable dispatch-lane run records —
 *  `runBuildDispatchTick` derives `dispatchedByBuilder` from exactly these two reads. */
function effectsFor({ lockRoot, pid, dispatches, openPrs = [], runStoreInFlight = [], settledBuilds = [] }) {
  const owner = `testhost:${pid}`;
  return {
    planTick: (bk) => sameFileTick(bk),
    fetchOpenPrs: () => [{ repo: 'plateau-app', prs: openPrs }],
    listClaims: () => listBuildDispatchClaims({ lockRoot }),
    releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
    acquireClaim: ({ num, scope }) => acquireBuildDispatchClaim({ num, scope, owner, pid, lockRoot }),
    listRunStoreInFlight: () => runStoreInFlight,
    listSettledBuilds: () => settledBuilds,
    killSwitch: () => ({ engaged: false }),
    dispatch: ({ num }) => { dispatches.push({ num, pid }); return { dispatching: true, lane: 13 }; },
  };
}

describe('runBuildDispatchTick', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-claims-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('restart + two ready cards on the same file → only one is ever dispatched', async () => {
    const dispatches = [];
    // Process A: first tick dispatches #3827; #2662 is held on the hot file within the same tick.
    const a = await runBuildDispatchTick({ live: true, effects: effectsFor({ lockRoot, pid: 1001, dispatches }) });
    expect(a.dispatched.map((d) => d.num)).toEqual(['3827']);
    expect(a.plan.hold).toEqual([expect.objectContaining({ num: '2662', rule: 'hot-file' })]);
    // Restart: a NEW process with EMPTY bookkeeping (the tick core's guards are gone) ticks again.
    const b = await runBuildDispatchTick({ bookkeeping: {}, live: true, effects: effectsFor({ lockRoot, pid: 2002, dispatches }) });
    expect(b.dispatched).toEqual([]);
    expect(b.plan.hold.find((h) => h.num === '3827')).toMatchObject({ rule: 'in-flight' });
    expect(b.plan.hold.find((h) => h.num === '2662')).toMatchObject({ rule: 'hot-file' });
    // And a third tick in the restarted process stays at one.
    await runBuildDispatchTick({ bookkeeping: b.nextBookkeeping, live: true, effects: effectsFor({ lockRoot, pid: 2002, dispatches }) });
    expect(dispatches).toEqual([{ num: '3827', pid: 1001 }]);
  });

  it('control: WITHOUT the durable claim, the same restart dispatches #3827 twice', async () => {
    const dispatches = [];
    const noClaims = (pid) => ({
      ...effectsFor({ lockRoot, pid, dispatches }),
      listClaims: () => [], acquireClaim: () => ({ ok: true }), releaseClaim: () => {},
    });
    await runBuildDispatchTick({ live: true, effects: noClaims(1001) });
    await runBuildDispatchTick({ bookkeeping: {}, live: true, effects: noClaims(2002) });
    expect(dispatches.map((d) => d.num)).toEqual(['3827', '3827']);
  });

  it('retires the claim once a PR delivers the item, freeing the hot file for the next card', async () => {
    const dispatches = [];
    await runBuildDispatchTick({ live: true, effects: effectsFor({ lockRoot, pid: 1, dispatches }) });
    const openPrs = [{ number: 42, headRefName: 'lane/3827-return-to', labels: [], files: [{ path: 'src/return-to.ts' }] }];
    const r = await runBuildDispatchTick({ live: true, effects: effectsFor({ lockRoot, pid: 2, dispatches, openPrs }) });
    expect(r.retired).toEqual([expect.objectContaining({ num: '3827', released: true })]);
    expect(r.dispatched.map((d) => d.num)).toEqual(['2662']);
  });

  it('an empty queue read never retires claims', async () => {
    const dispatches = [];
    await runBuildDispatchTick({ live: true, effects: effectsFor({ lockRoot, pid: 1, dispatches }) });
    const empty = { ...effectsFor({ lockRoot, pid: 2, dispatches }), planTick: () => ({ decisions: { admission: { queue: [], cleared: [] } }, nextState: {} }) };
    const r = await runBuildDispatchTick({ live: true, effects: empty });
    expect(r.retired).toEqual([]);
    expect(listBuildDispatchClaims({ lockRoot }).map((c) => c.meta.num)).toEqual(['3827']);
  });

  it('dry run claims and dispatches nothing', async () => {
    const dispatches = [];
    const r = await runBuildDispatchTick({ live: false, effects: effectsFor({ lockRoot, pid: 1, dispatches }) });
    expect(r.plan.dispatch.map((d) => d.num)).toEqual(['3827']);
    expect(dispatches).toEqual([]);
    expect(listBuildDispatchClaims({ lockRoot })).toEqual([]);
  });

  it('releases the claim when dispatch-lane does not dispatch', async () => {
    const dispatches = [];
    const eff = { ...effectsFor({ lockRoot, pid: 1, dispatches }), dispatch: () => ({ dispatching: false, reason: 'suppressed' }) };
    const r = await runBuildDispatchTick({ live: true, effects: eff });
    expect(r.failures).toEqual([expect.objectContaining({ num: '3827', stage: 'dispatch' })]);
    expect(listBuildDispatchClaims({ lockRoot })).toEqual([]);
  });

  it('carries only the guards of builds it actually launched', async () => {
    const dispatches = [];
    const r = await runBuildDispatchTick({ live: true, effects: effectsFor({ lockRoot, pid: 1, dispatches }) });
    expect(r.nextBookkeeping.buildGuards.map((g) => g.num)).toEqual(['3827']);
    expect(r.nextBookkeeping.launchedNums).toEqual(['3827']);
  });

  // card xao7080/#4518 (converge round 1, panel + red-team, both independently) — the reader-level test on
  // `cliListRunStoreInFlight` alone proves the field is READ, never that it SURVIVES into `plan.inFlight`, the
  // object both the `--dry-run` report and the live tick JSON actually print from. This is the end-to-end proof:
  // an already in-flight run-store row's `executor` rides through `runBuildDispatchTick` → `planBuildDispatch`
  // unmangled, and that item is held (never re-dispatched) rather than launched a second time.
  it('card xao7080/#4518 — a run-store row\'s `executor` rides through into `plan.inFlight`, not just the '
    + 'reader that produced it', async () => {
    const dispatches = [];
    const r = await runBuildDispatchTick({
      live: true,
      effects: effectsFor({
        lockRoot, pid: 1, dispatches,
        runStoreInFlight: [{ num: '3827', scope: [], source: 'run dispatch-lane-9', executor: 'codex' }],
      }),
    });
    expect(r.plan.inFlight).toEqual(expect.arrayContaining([expect.objectContaining({ num: '3827', executor: 'codex' })]));
    // #3827 is already in-flight per the run store — held, never dispatched a second time (#2662 is a
    // separate, unrelated candidate this same tick's hot-file rule frees once #3827 stops competing for it).
    expect(r.plan.hold.find((h) => h.num === '3827')).toMatchObject({ rule: 'in-flight' });
    expect(r.dispatched.map((d) => d.num)).not.toContain('3827');
  });

  /** A fake tick-core answer with `n` freshly-proposed spawns and a caller-supplied `counts`. */
  function manySpawnsTick(n, counts) {
    const spawnBuilds = Array.from({ length: n }, (_, i) => ({ num: String(200 + i), lane: i + 1 }));
    // Each candidate needs its OWN, disjoint scope — an empty scope is held `scope-vs-open-prs` (unprovable
    // disjointness from open PRs) before the cap is ever reached, which would mask the count this test targets.
    const scopeFor = (num) => [`plateau-app:src/scratch-${num}.ts`];
    return {
      decisions: {
        statusLine: 'test',
        counts,
        spawnBuilds,
        admission: {
          queue: spawnBuilds.map((s) => ({ num: s.num, scope: scopeFor(s.num) })),
          cleared: spawnBuilds.map((s) => ({ num: s.num, ready: true })),
        },
      },
      nextState: {},
    };
  }
  const noInFlightEffects = (planTick) => ({
    planTick,
    fetchOpenPrs: () => [{ repo: 'plateau-app', prs: [] }],
    listClaims: () => [],
    releaseClaim: () => {},
    acquireClaim: () => ({ ok: true }),
    listRunStoreInFlight: () => [],
    killSwitch: () => ({ engaged: false }),
    dispatch: () => ({ dispatching: true, lane: 1 }),
  });

  it('card x0jgunh — reads counts.buildingInFlight (not counts.building) for the cap: 6 freshly-proposed spawns with buildingInFlight:0 still admit up to the cap', async () => {
    const policy = { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 3 };
    const r = await runBuildDispatchTick({
      live: false,
      policy,
      effects: noInFlightEffects(() => manySpawnsTick(6, { building: 6, buildingInFlight: 0 })),
    });
    // With `buildingInFlight` 0 (nothing ACTUALLY in flight before this tick's own proposals), the daemon
    // admits up to its own cap.
    expect(r.plan.dispatch.length).toBe(3);
  });

  // Card x3vs6tu, live 2026-09-29: `externalBuilding` (fed from `counts.buildingInFlight ?? counts.building`)
  // is now NEVER folded into the cap at all — only this builder's own durable in-flight builds are. So an
  // older `planTick` stub that only ever reports `counts.building` (no `buildingInFlight`) behaves exactly the
  // SAME as one that reports the honest `buildingInFlight` — both admit up to the plain cap. Before this card,
  // this exact case (a machine-wide count with none of it this builder's own work) was the live incident: 6
  // "building" read at cap 6 held every candidate for 30+ minutes while 116 items queued.
  it('a planTick stub reporting only counts.building (no buildingInFlight) still admits up to the cap — that count no longer gates this builder at all', async () => {
    const policy = { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 3 };
    const r = await runBuildDispatchTick({
      live: false,
      policy,
      effects: noInFlightEffects(() => manySpawnsTick(6, { building: 6 })),
    });
    expect(r.plan.dispatch.length).toBe(3);
  });

  // #4353 — open-item WIP cap wiring: the CLI flag → policy, and the tick's real pipeline surfacing `plan.openItems`.
  it('policyFrom threads --max-open-items into the policy the same mechanical way --max-concurrent/--max-open-prs already do', () => {
    const policy = policyFrom({ 'max-concurrent': '4', 'max-open-prs': '20', 'max-open-items': '9' });
    expect(policy.maxConcurrentBuilds).toBe(4);
    expect(policy.maxOpenPrs).toBe(20);
    expect(policy.maxOpenItems).toBe(9);
    // an omitted flag falls back to the declared policy default, same as the pre-existing two flags
    expect(policyFrom({}).maxOpenItems).toBe(BUILD_DISPATCH_POLICY.maxOpenItems);
  });

  it('runBuildDispatchTick surfaces plan.openItems from real openPrs, and holds a fresh candidate once it is full — naming which item fills it', async () => {
    const dispatches = [];
    const openPrs = [{ number: 50, headRefName: 'lane/500-x', labels: [], files: [] }];
    const policy = { ...BUILD_DISPATCH_POLICY, maxOpenItems: 1 };
    // xovjhwh — #500's open PR only fills the wip-cap because THIS builder's own settled dispatch-lane record
    // shows it dispatched #500 (its build finished with the PR still open, #4349's own `pr-opened` outcome).
    const settledBuilds = [{ num: '500', outcome: 'pr-opened', startedAt: '2026-01-01T00:00:00Z' }];
    const r = await runBuildDispatchTick({ live: false, policy, effects: effectsFor({ lockRoot, pid: 1, dispatches, openPrs, settledBuilds }) });
    expect(r.plan.openItems).toEqual({ count: 1, cap: 1, nums: ['500'] });
    expect(r.plan.hold.filter((h) => h.rule === 'wip-cap').map((h) => h.num)).toEqual(['3827', '2662']);
    expect(r.plan.hold.find((h) => h.rule === 'wip-cap').reason).toMatch(/500/);
    // this card must never touch the pre-existing display-only field — still the raw durable in-flight list.
    expect(r.plan.inFlight).toEqual([]);
  });

  // xovjhwh (operator decision 2026-09-29) — the real end-to-end wiring: `runBuildDispatchTick` must derive
  // `dispatchedByBuilder` from its OWN `listRunStoreInFlight`/`listSettledBuilds` reads and thread it into
  // `planBuildDispatch`, not just the pure planner in isolation. Live incident this closes: openItems read 7/7
  // filled by six hand-dispatched worker PRs, so wip-cap held the builder's own cleared items and it built
  // nothing. (The REAL reader's own fail-open behaviour on an actual read error is pinned separately, against
  // the real `cliListSettledBuilds`/`cliListRunStoreInFlight`, in the "real readers" describe block below —
  // converge round 2, correctness/security/claim-accuracy: this planner-level test alone does not exercise
  // that catch path and was previously miscited as if it did.)
  it('a hand-dispatched worker\'s open PR (no run-store/settled record from THIS builder) never fills the wip-cap — a builder-dispatched one still does', async () => {
    const dispatches = [];
    const openPrs = [
      { number: 50, headRefName: 'lane/500-x', labels: [], files: [] }, // a worker's PR — this builder has no run record for #500 at all
      { number: 51, headRefName: 'lane/600-x', labels: [], files: [] }, // this builder's own dispatch, already settled
    ];
    const settledBuilds = [{ num: '600', outcome: 'pr-opened', startedAt: '2026-01-01T00:00:00Z' }];
    const policy = { ...BUILD_DISPATCH_POLICY, maxOpenItems: 1 };
    const r = await runBuildDispatchTick({ live: false, policy, effects: effectsFor({ lockRoot, pid: 1, dispatches, openPrs, settledBuilds }) });
    // #500 (worker) is excluded; #600 (builder) alone fills the cap.
    expect(r.plan.openItems).toEqual({ count: 1, cap: 1, nums: ['600'] });
    expect(r.plan.hold.filter((h) => h.rule === 'wip-cap').map((h) => h.num)).toEqual(['3827', '2662']);
  });
});

// xovjhwh converge round 1 (simplicity/standards-conformance finding) — `runBuildDispatchTick` and `dryRun`
// both derived `dispatchedByBuilder` inline from the same two reads, which could silently drift if either copy
// were edited alone. Pulled into `deriveDispatchedByBuilder` and pinned directly here, once, so both call sites
// stay provably identical without a live-daemon test having to exercise `dryRun` itself.
describe('deriveDispatchedByBuilder (xovjhwh) — the single derivation runBuildDispatchTick and dryRun both call', () => {
  it('unions the in-flight run-store nums with the settled-build nums, deduped', () => {
    const runStoreRows = [{ num: '1' }, { num: '2' }];
    const settledRows = [{ num: '2', outcome: 'pr-opened' }, { num: '3', outcome: 'gate-red' }];
    expect(deriveDispatchedByBuilder(runStoreRows, settledRows)).toEqual(new Set(['1', '2', '3']));
  });

  it('is empty when both reads are empty — no builder-own attribution at all', () => {
    expect(deriveDispatchedByBuilder([], [])).toEqual(new Set());
  });

  it('defaults both args to empty arrays and normalizes nums the same way `normNum` does elsewhere', () => {
    expect(deriveDispatchedByBuilder()).toEqual(new Set());
    expect(deriveDispatchedByBuilder([{ num: '#042' }], [])).toEqual(new Set(['42']));
  });

  it('ignores a row with no num rather than adding a falsy/undefined entry', () => {
    expect(deriveDispatchedByBuilder([{ num: '' }, { num: '7' }], [{}])).toEqual(new Set(['7']));
  });
});

// #4348-open-pr-retry — the live incident this closes: build #4348 finished (gate green), its PR-open hit the
// GitHub rate limit, and the item sat under an indistinguishable `wrapper-threw` build-dispatch hold for 2+
// hours because NOTHING ever retried the open — the `infra-blocked.mjs retry` pass (#2659's own
// backoff/attempt-cap state machine) was registered but never ticked. This daemon's own LIVE tick — already
// confirmed alive — now runs that retry pass itself every cycle, so a resumable `blocked-on-infra` open-pr
// recovers on its own, with no rebuild.
describe('runBuildDispatchTick — #4348-open-pr-retry (infra-blocked resume folded into this daemon\'s own tick)', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-claims-infra-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('a LIVE tick calls effects.retryInfraBlocked() exactly once, and its result rides on the tick report', async () => {
    const dispatches = [];
    let calls = 0;
    const effects = { ...effectsFor({ lockRoot, pid: 1, dispatches }), retryInfraBlocked: async () => { calls += 1; return { retried: ['4348'], resumed: [{ num: '4348', pr: 9001 }], surfaced: [], waiting: [] }; } };
    const r = await runBuildDispatchTick({ live: true, effects });
    expect(calls).toBe(1);
    expect(r.infraRetry).toEqual({ retried: ['4348'], resumed: [{ num: '4348', pr: 9001 }], surfaced: [], waiting: [] });
  });

  it('a DRY-RUN tick (live:false) never calls it — a dry run must touch nothing', async () => {
    const dispatches = [];
    let calls = 0;
    const effects = { ...effectsFor({ lockRoot, pid: 1, dispatches }), retryInfraBlocked: async () => { calls += 1; return {}; } };
    const r = await runBuildDispatchTick({ live: false, effects });
    expect(calls).toBe(0);
    expect(r.infraRetry).toBeNull();
  });

  it('an OLDER effects stub with no `retryInfraBlocked` at all behaves exactly as before this card — no call, no throw', async () => {
    const dispatches = [];
    const r = await runBuildDispatchTick({ live: true, effects: effectsFor({ lockRoot, pid: 1, dispatches }) });
    expect(r.infraRetry).toBeNull();
  });

  it('a THROWING retry pass never fails this tick\'s own build-dispatch plan — best-effort, captured as `{error}`', async () => {
    const dispatches = [];
    const effects = { ...effectsFor({ lockRoot, pid: 1, dispatches }), retryInfraBlocked: async () => { throw new Error('infra-blocked: gh network error'); } };
    const r = await runBuildDispatchTick({ live: true, effects });
    expect(r.infraRetry).toEqual({ error: 'infra-blocked: gh network error' });
    // the REST of the tick still ran normally — this is a side effect, never a gate on the plan.
    expect(r.dispatched.length).toBeGreaterThan(0);
  });
});

// #4131/#4382 build-orphan-adopt — mirrors the #4348-open-pr-retry suite above: same optional-effect shape
// (`effects.adoptOrphans`), same LIVE-only/best-effort posture, so the two are asserted the same way.
describe('runBuildDispatchTick — #4131/#4382 build-orphan-adopt', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-claims-orphan-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('a LIVE tick calls effects.adoptOrphans() exactly once, BEFORE this same tick reads its own claims, and '
    + 'its result rides on the tick report', async () => {
    const dispatches = [];
    let calls = 0;
    const order = [];
    const effects = {
      ...effectsFor({ lockRoot, pid: 1, dispatches }),
      adoptOrphans: async () => { calls += 1; order.push('adopt'); return [{ num: '4131', action: 'resume', reason: 'x', pid: 55555 }]; },
    };
    const realListClaims = effects.listClaims;
    effects.listClaims = () => { order.push('listClaims'); return realListClaims(); };
    const r = await runBuildDispatchTick({ live: true, effects });
    expect(calls).toBe(1);
    expect(r.orphanAdoption).toEqual([{ num: '4131', action: 'resume', reason: 'x', pid: 55555 }]);
    expect(order[0]).toBe('adopt'); // adoption runs before the tick's own claim read.
  });

  it('PR #2921 review — resume is allowed only when neither the kill switch nor a landing freeze is on', async () => {
    const dispatches = [];
    const seen = [];
    const base = effectsFor({ lockRoot, pid: 1, dispatches });
    const adoptOrphans = async (o) => { seen.push(o); return []; };

    await runBuildDispatchTick({ live: true, effects: { ...base, adoptOrphans } });
    await runBuildDispatchTick({ live: true, effects: { ...base, adoptOrphans, killSwitch: () => ({ engaged: true, reason: 'operator' }) } });
    const tooManyPrs = Array.from({ length: BUILD_DISPATCH_POLICY.maxOpenPrs + 1 }, (_, i) => ({ number: 9000 + i, labels: [], files: [], headRefName: `x-${i}` }));
    await runBuildDispatchTick({ live: true, effects: { ...base, adoptOrphans, fetchOpenPrs: async () => [{ repo: 'we', prs: tooManyPrs }] } });

    expect(seen.map((o) => o?.allowResume)).toEqual([true, false, false]);
    expect(seen[1].frozenReason).toMatch(/kill switch/);
    expect(seen[2].frozenReason).toMatch(/maxOpenPrs/);
  });

  it('a DRY-RUN tick (live:false) never calls it — a dry run must touch nothing', async () => {
    const dispatches = [];
    let calls = 0;
    const effects = { ...effectsFor({ lockRoot, pid: 1, dispatches }), adoptOrphans: async () => { calls += 1; return []; } };
    const r = await runBuildDispatchTick({ live: false, effects });
    expect(calls).toBe(0);
    expect(r.orphanAdoption).toBeNull();
  });

  it('an OLDER effects stub with no `adoptOrphans` at all behaves exactly as before this card — no call, no throw', async () => {
    const dispatches = [];
    const r = await runBuildDispatchTick({ live: true, effects: effectsFor({ lockRoot, pid: 1, dispatches }) });
    expect(r.orphanAdoption).toBeNull();
  });

  it('a THROWING adoption pass never fails this tick\'s own build-dispatch plan — best-effort, captured as `{error}`', async () => {
    const dispatches = [];
    const effects = { ...effectsFor({ lockRoot, pid: 1, dispatches }), adoptOrphans: async () => { throw new Error('orphan-adopt: run-store unreadable'); } };
    const r = await runBuildDispatchTick({ live: true, effects });
    expect(r.orphanAdoption).toEqual({ error: 'orphan-adopt: run-store unreadable' });
    expect(r.dispatched.length).toBeGreaterThan(0);
  });
});

// #4465 — a held item's own route is classified EVERY tick (pure, cheap — visible on `--dry-run` too), and
// acted on only when `live` — same optional-effect / best-effort posture as #4131/#4382's `adoptOrphans` and
// #4348's `retryInfraBlocked` above, so asserted the same way.
describe('runBuildDispatchTick — #4465 build-dispatch-hold-router wiring', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-claims-holdroute-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('classifies every live hold into `holdRouting` on BOTH a dry-run and a live tick', async () => {
    const dispatches = [];
    const effects = {
      ...effectsFor({ lockRoot, pid: 1, dispatches }),
      listHolds: () => [
        { num: '4295', reason: 'spec not buildable as written within declared scope: re-shaping needed' },
        { num: '4380', reason: 'spec already done on main: commit b93d13e29 — card just needs resolving' },
        { num: '9001', reason: 'wrapper-threw' },
      ],
    };
    const dry = await runBuildDispatchTick({ live: false, effects });
    const live = await runBuildDispatchTick({ live: true, effects });
    for (const r of [dry, live]) {
      expect(r.holdRouting).toEqual([
        { num: '4295', route: 'out-of-scope', commit: null, reason: expect.stringContaining('not buildable') },
        { num: '4380', route: 'already-done', commit: 'b93d13e29', reason: expect.stringContaining('already done') },
        { num: '9001', route: 'other', commit: null, reason: 'wrapper-threw' },
      ]);
    }
  });

  it('a LIVE tick calls effects.routeHeldItems(holdRouting) exactly once; a DRY-RUN tick never calls it', async () => {
    const dispatches = [];
    let calls = 0;
    let seenPlan = null;
    const effects = {
      ...effectsFor({ lockRoot, pid: 1, dispatches }),
      listHolds: () => [{ num: '4380', reason: 'spec already done on main: commit b93d13e29' }],
      routeHeldItems: async (plan) => { calls += 1; seenPlan = plan; return [{ num: '4380', route: 'already-done', action: 'landing-spawned' }]; },
    };
    const dry = await runBuildDispatchTick({ live: false, effects });
    expect(calls).toBe(0);
    expect(dry.holdRoutingResult).toBeNull();

    const live = await runBuildDispatchTick({ live: true, effects });
    expect(calls).toBe(1);
    expect(seenPlan).toEqual([{ num: '4380', route: 'already-done', commit: 'b93d13e29', reason: 'spec already done on main: commit b93d13e29' }]);
    expect(live.holdRoutingResult).toEqual([{ num: '4380', route: 'already-done', action: 'landing-spawned' }]);
  });

  // PR #2967 review (correctness) — routes (a)/(b) open self-merging PRs, so they obey the kill switch and the
  // landing freeze exactly as `adoptOrphans` does; route (c) is a ledger append and still runs.
  it('withholds the landable routes (never passed on, so no lease is spent) while the kill switch or a landing '
    + 'freeze is on; route "other" still runs', async () => {
    const dispatches = [];
    const seen = [];
    const base = {
      ...effectsFor({ lockRoot, pid: 1, dispatches }),
      listHolds: () => [
        { num: '4295', reason: 'spec not buildable as written' },
        { num: '4380', reason: 'spec already done on main: commit b93d13e29' },
        { num: '9001', reason: 'wrapper-threw' },
      ],
      routeHeldItems: async (plan) => { seen.push(plan.map((p) => p.num)); return plan.map((p) => ({ num: p.num, route: p.route, action: 'x' })); },
    };
    const tooManyPrs = Array.from({ length: BUILD_DISPATCH_POLICY.maxOpenPrs + 1 }, (_, i) => ({ number: 9000 + i, labels: [], files: [], headRefName: `x-${i}` }));

    await runBuildDispatchTick({ live: true, effects: base });
    const killed = await runBuildDispatchTick({ live: true, effects: { ...base, killSwitch: () => ({ engaged: true, reason: 'operator' }) } });
    const frozen = await runBuildDispatchTick({ live: true, effects: { ...base, fetchOpenPrs: async () => [{ repo: 'we', prs: tooManyPrs }] } });

    expect(seen).toEqual([['4295', '4380', '9001'], ['9001'], ['9001']]);
    for (const [r, why] of [[killed, /kill switch/], [frozen, /maxOpenPrs/]]) {
      const withheld = r.holdRoutingResult.filter((o) => o.action === 'withheld-frozen');
      expect(withheld.map((o) => o.num)).toEqual(['4295', '4380']);
      expect(withheld[0].reason).toMatch(why);
    }
  });

  it('an OLDER effects stub with no `routeHeldItems` at all behaves exactly as before this card — no call, no throw', async () => {
    const dispatches = [];
    const effects = { ...effectsFor({ lockRoot, pid: 1, dispatches }), listHolds: () => [{ num: '4380', reason: 'x' }] };
    const r = await runBuildDispatchTick({ live: true, effects });
    expect(r.holdRoutingResult).toBeNull();
    expect(r.holdRouting).toEqual([{ num: '4380', route: 'other', commit: null, reason: 'x' }]);
  });

  it('a THROWING routing pass never fails this tick\'s own build-dispatch plan — best-effort, captured as `{error}`', async () => {
    const dispatches = [];
    const effects = {
      ...effectsFor({ lockRoot, pid: 1, dispatches }),
      listHolds: () => [{ num: '4380', reason: 'spec already done on main: commit b93d13e29' }],
      routeHeldItems: async () => { throw new Error('hold-router: coordination root unreadable'); },
    };
    const r = await runBuildDispatchTick({ live: true, effects });
    expect(r.holdRoutingResult).toEqual({ error: 'hold-router: coordination root unreadable' });
    expect(r.dispatched.length).toBeGreaterThan(0);
  });
});

// #4465 review — the ORIGINAL version of this describe block asserted only `typeof cliRouteHeldItems ===
// 'function'`: it would stay green even if the wiring passed the wrong effect, or `cliSpawnHoldLand` built a
// broken argv (wrong script path, missing `--commit`). These tests instead drive `cliRouteHeldItems` against
// the REAL `reserveHoldRoute`/`appendHoldFinding` primitives (over a real temp coordination root) and the
// REAL `cliSpawnHoldLand`, with only the one un-runnable-in-a-test step — the actual detached `node`
// spawn — faked (see the `vi.mock` of `detached-dispatch.mjs` above).
describe('cliRouteHeldItems (#4465 real IO wiring) — the real reserve/spawn/finding effects, not a stub', () => {
  let coordRoot;
  beforeEach(() => {
    coordRoot = mkdtempSync(join(tmpdir(), 'bdd-holdroute-coord-'));
    process.env.WE_COORDINATION_ROOT = coordRoot;
    spawnCalls.length = 0;
  });
  afterEach(() => {
    delete process.env.WE_COORDINATION_ROOT;
    rmSync(coordRoot, { recursive: true, force: true });
  });

  it('is exported as an async function', () => {
    expect(typeof cliRouteHeldItems).toBe('function');
    expect(cliRouteHeldItems.constructor.name).toBe('AsyncFunction');
  });

  it("route 'other': really appends to the REAL JSON ledger under the real coordination root (never a stub) "
    + 'and never touches spawnLand', async () => {
    const outcomes = await cliRouteHeldItems([{ num: 'x9001', route: 'other', commit: null, reason: 'wrapper-threw' }]);
    expect(outcomes).toEqual([{ num: 'x9001', route: 'other', action: 'finding-recorded' }]);
    expect(listHoldFindings()).toEqual([expect.objectContaining({ num: 'x9001', reason: 'wrapper-threw' })]);
    expect(spawnCalls).toHaveLength(0);
  });

  it("route 'already-done': really reserves the dedup lease through the REAL reserveHoldRoute (not a stub "
    + 'that no-ops) before spawning the REAL cliSpawnHoldLand — the lease is actually persisted, with the '
    + 'right resource key and route metadata, under the real coordination root', async () => {
    const outcomes = await cliRouteHeldItems([{ num: 'x9002', route: 'already-done', commit: 'b93d13e29', reason: 'x' }]);
    expect(outcomes).toEqual([{ num: 'x9002', route: 'already-done', action: 'landing-spawned' }]);
    expect(spawnCalls).toHaveLength(1);
    const { readLockEntry } = await import('../../../scripts/readiness/file-locks.mjs');
    const { holdRouteLockRoot } = await import('../../../scripts/conveyor/build-dispatch-hold-router.mjs');
    const entry = readLockEntry(holdRouteLockRoot(), 'we:x9002:already-done');
    expect(entry?.meta).toMatchObject({ num: 'x9002', route: 'already-done' });
    // A second reserve for the SAME item — even with an explicitly DIFFERENT owner string — finds this lease
    // already held and is refused, proving it is a genuine reservation, not a no-op stub. `reserveHoldRoute`'s
    // own DEFAULT owner is a fresh `randomUUID()` per call (#4465 review round 2 fix), so this daemon's own
    // real long-lived-process call above and this contender's call are already two distinct owners by
    // construction — no explicit override is even needed to prove dedup, but one is passed anyway for
    // clarity.
    const { reserveHoldRoute } = await import('../../../scripts/conveyor/build-dispatch-hold-router.mjs');
    const contender = reserveHoldRoute({ num: 'x9002', route: 'already-done', owner: 'some-other-host:99999' });
    expect(contender.ok).toBe(false);
  });

  it("route 'out-of-scope': also reserves + spawns through the real primitives", async () => {
    const outcomes = await cliRouteHeldItems([{ num: 'x9003', route: 'out-of-scope', commit: null, reason: 'spec not buildable' }]);
    expect(outcomes).toEqual([{ num: 'x9003', route: 'out-of-scope', action: 'landing-spawned' }]);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].argv).toEqual(expect.arrayContaining(['--num=x9003', '--route=out-of-scope', '--reason=spec not buildable']));
  });
});

// #4465 review — `cliSpawnHoldLand` itself had no test at all before this. These pin its argv construction —
// the exact thing a wiring mistake (wrong script path, a dropped `--commit`) would break silently, since
// nothing else reddens for it.
describe('cliSpawnHoldLand (#4465) — the detached-landing argv construction', () => {
  beforeEach(() => { spawnCalls.length = 0; });

  it('always includes the land script\'s own path, --num and --route, and omits --commit/--reason when absent', async () => {
    await cliSpawnHoldLand({ num: '4380', route: 'already-done', commit: null, reason: null });
    expect(spawnCalls).toHaveLength(1);
    const { argv } = spawnCalls[0];
    expect(argv[0]).toMatch(/build-dispatch-hold-route-land\.mjs$/);
    expect(argv).toEqual(expect.arrayContaining(['--num=4380', '--route=already-done']));
    expect(argv.some((a) => a.startsWith('--commit='))).toBe(false);
    expect(argv.some((a) => a.startsWith('--reason='))).toBe(false);
  });

  it('adds --commit=<sha> only when the routed entry carries one (route "already-done")', async () => {
    await cliSpawnHoldLand({ num: '4380', route: 'already-done', commit: 'b93d13e29', reason: null });
    expect(spawnCalls[0].argv).toEqual(expect.arrayContaining(['--commit=b93d13e29']));
  });

  it('adds --reason=<text> only when the routed entry carries one (route "out-of-scope")', async () => {
    await cliSpawnHoldLand({ num: '4295', route: 'out-of-scope', commit: null, reason: 'spec not buildable as written' });
    expect(spawnCalls[0].argv).toEqual(expect.arrayContaining(['--reason=spec not buildable as written']));
  });

  it('returns whatever defaultSpawnDetached reports, and passes a real cwd + logPath through', async () => {
    const result = await cliSpawnHoldLand({ num: '4380', route: 'already-done', commit: 'b93d13e29', reason: null });
    expect(result).toBe(fakeDetachedResult);
    expect(typeof spawnCalls[0].opts.cwd).toBe('string');
    expect(spawnCalls[0].opts.logPath).toBe('/tmp/fake-hold-route-hold-route-4380.log');
  });
});

describe('primaryInfraStoreEnv (#4348-open-pr-retry)', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bdd-home-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('no override when neither the env var nor the default `~/workspace/webeverything` layout resolves to a '
    + 'real store — a host where this daemon genuinely IS the primary sees no change', () => {
    expect(primaryInfraStoreEnv({ env: {}, home })).toEqual({});
  });

  it('overrides CONVEYOR_INFRA_FILE at the DEFAULT `<home>/workspace/webeverything/.conveyor/infra-blocked.json` '
    + 'once that file exists — the live #4348 shape (a daemon checkout with no relationship to the primary)', () => {
    const file = join(home, 'workspace', 'webeverything', '.conveyor', 'infra-blocked.json');
    mkdirSync(join(home, 'workspace', 'webeverything', '.conveyor'), { recursive: true });
    writeFileSync(file, '[]');
    expect(primaryInfraStoreEnv({ env: {}, home })).toEqual({ CONVEYOR_INFRA_FILE: file });
  });

  it('WE_PRIMARY_CHECKOUT overrides the default layout, same convention as WE_COORDINATION_ROOT', () => {
    const altRoot = mkdtempSync(join(tmpdir(), 'bdd-alt-primary-'));
    try {
      const file = join(altRoot, '.conveyor', 'infra-blocked.json');
      mkdirSync(join(altRoot, '.conveyor'), { recursive: true });
      writeFileSync(file, '[]');
      expect(primaryInfraStoreEnv({ env: { WE_PRIMARY_CHECKOUT: altRoot }, home })).toEqual({ CONVEYOR_INFRA_FILE: file });
    } finally {
      rmSync(altRoot, { recursive: true, force: true });
    }
  });

  it('an EXPLICIT CONVEYOR_INFRA_FILE is never overridden, even when the default layout exists', () => {
    mkdirSync(join(home, 'workspace', 'webeverything', '.conveyor'), { recursive: true });
    writeFileSync(join(home, 'workspace', 'webeverything', '.conveyor', 'infra-blocked.json'), '[]');
    expect(primaryInfraStoreEnv({ env: { CONVEYOR_INFRA_FILE: '/custom/path.json' }, home })).toEqual({});
  });
});

// Review finding (PR #2899): the env wiring in the CLI shell IS the live #4348 fix — drop it and every retry
// silently reads the daemon checkout's empty store. Drive the shell with a stubbed exec and assert the child env.
describe('cliRetryInfraBlocked — passes the primary store path to the child retry pass (#4348-open-pr-retry)', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bdd-home-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('the child env carries CONVEYOR_INFRA_FILE = the primary checkout\'s store, and the JSON result is returned', () => {
    const file = join(home, 'workspace', 'webeverything', '.conveyor', 'infra-blocked.json');
    mkdirSync(join(home, 'workspace', 'webeverything', '.conveyor'), { recursive: true });
    writeFileSync(file, '[]');
    const calls = [];
    const exec = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return '{"retried":["7"]}'; };
    const r = cliRetryInfraBlocked({ exec, env: { PATH: '/bin' }, home });
    expect(r).toEqual({ retried: ['7'] });
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(-1)).toEqual(['retry']);
    expect(calls[0].opts.env).toMatchObject({ PATH: '/bin', CONVEYOR_INFRA_FILE: file });
  });

  it('an explicit CONVEYOR_INFRA_FILE in the daemon env reaches the child unchanged', () => {
    mkdirSync(join(home, 'workspace', 'webeverything', '.conveyor'), { recursive: true });
    writeFileSync(join(home, 'workspace', 'webeverything', '.conveyor', 'infra-blocked.json'), '[]');
    const calls = [];
    cliRetryInfraBlocked({ exec: (c, a, o) => { calls.push(o); return '{}'; }, env: { CONVEYOR_INFRA_FILE: '/custom/path.json' }, home });
    expect(calls[0].env.CONVEYOR_INFRA_FILE).toBe('/custom/path.json');
  });

  it('a throwing exec is captured as `{error}`, never thrown', () => {
    const r = cliRetryInfraBlocked({ exec: () => { throw new Error('boom'); }, env: {}, home });
    expect(r.error).toMatch(/boom/);
  });
});

describe('cliRetryInfraBlocked — bounds the child so a slow retry can never stall a whole tick (#4517)', () => {
  it('the default bound leaves real headroom inside the daemon tick interval', () => {
    expect(INFRA_RETRY_TIMEOUT_MS).toBeLessThan(DEFAULT_INTERVAL_MS);
  });

  it('passes `timeout` (and a `killSignal`) through to exec, defaulting to INFRA_RETRY_TIMEOUT_MS', () => {
    let capturedOpts;
    cliRetryInfraBlocked({ exec: (c, a, o) => { capturedOpts = o; return '{}'; }, env: {}, home: '/x' });
    expect(capturedOpts.timeout).toBe(INFRA_RETRY_TIMEOUT_MS);
    expect(capturedOpts.killSignal).toBe('SIGTERM');
  });

  it('an explicit `timeoutMs` override reaches exec as its `timeout` option', () => {
    let capturedOpts;
    cliRetryInfraBlocked({ exec: (c, a, o) => { capturedOpts = o; return '{}'; }, env: {}, home: '/x', timeoutMs: 5000 });
    expect(capturedOpts.timeout).toBe(5000);
  });

  // Simulates real `execFileSync` timeout semantics without a real subprocess: if the caller's bound is
  // tighter than the work the child would otherwise take, the fake `exec` only "runs" for the bound, then
  // throws the same shape a real timed-out execFileSync throws (`err.signal === 'SIGTERM'`). If no bound
  // (or a looser one) is given, it runs the full duration and returns normally. Small ms values keep this
  // test fast and deterministic while still exercising real wall-clock timing.
  function fakeExecRespectingTimeout(slowMs) {
    return (cmd, args, opts) => {
      const bound = opts?.timeout;
      const boundBites = typeof bound === 'number' && bound < slowMs;
      const wait = boundBites ? bound : slowMs;
      const start = Date.now();
      while (Date.now() - start < wait) { /* busy-wait: models execFileSync's real blocking wait */ }
      if (boundBites) {
        const err = new Error(`command timed out after ${bound}ms`);
        err.signal = 'SIGTERM';
        throw err;
      }
      return JSON.stringify({ retried: [], resumed: [], surfaced: [], waiting: [] });
    };
  }

  it('a retry that would otherwise run 5x the bound is cut short near the bound, not left to run to completion', () => {
    const exec = fakeExecRespectingTimeout(250); // "would take" 250ms unbounded
    const start = Date.now();
    const result = cliRetryInfraBlocked({ exec, env: {}, home: '/x', timeoutMs: 50 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200); // well short of the full 250ms the slow retry would have taken
    expect(result.timedOut).toBe(true);
  });

  it('a retry well under the bound completes normally and is unaffected', () => {
    const exec = fakeExecRespectingTimeout(10);
    const result = cliRetryInfraBlocked({ exec, env: {}, home: '/x', timeoutMs: 50 });
    expect(result).toEqual({ retried: [], resumed: [], surfaced: [], waiting: [] });
    expect(result.timedOut).toBeUndefined();
  });

  // Review finding (converge round 1, correctness/security/standards-conformance/claim-accuracy lenses, all
  // independently): every test above models the bound with a hand-written fake `exec`, never a real
  // `execFileSync`, so nothing proves the SIGTERM timeout genuinely returns control — especially when the
  // direct child is itself synchronously blocked inside its OWN nested `execFileSync` call to a grandchild
  // (exactly `infra-blocked.mjs retry`'s own shape: it waits on `pr-land --label-on-green` via its own
  // independently-piped `execFileSync`, never inheriting this call's pipes — see `infra-blocked.mjs`'s own
  // `stdio: ['ignore', 'pipe', 'pipe']` call to `pr-land.mjs`). This test builds that exact two-level real
  // process tree (no fakes) and proves `execFileSync`'s own `timeout`/`killSignal` option bounds it near the
  // bound, not the grandchild's full (much longer) sleep — the actual OS-level property every fake-exec test
  // above only assumes.
  it('a REAL two-level process tree — a child synchronously blocked in its own execFileSync call to an '
    + 'independently-piped grandchild, mirroring infra-blocked.mjs\'s own call to pr-land — is still bounded by '
    + 'execFileSync\'s timeout, not left to run the grandchild\'s full sleep (#4517)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'infra-retry-real-tree-'));
    try {
      const grandchild = join(dir, 'grandchild.mjs');
      const child = join(dir, 'child.mjs');
      // The "CI wait" stand-in — deliberately far longer than the bound below.
      writeFileSync(grandchild, 'await new Promise((r) => setTimeout(r, 5000));\n');
      // Mirrors infra-blocked.mjs's OWN pattern exactly: a synchronous execFileSync call to a further child,
      // with its OWN independent stdio pipes (never inherited from whoever calls THIS script).
      writeFileSync(child,
        "import { execFileSync } from 'node:child_process';\n"
        + `execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(grandchild)}], `
        + "{ stdio: ['ignore', 'pipe', 'pipe'] });\n");
      const start = Date.now();
      let timedOut = false;
      try {
        execFileSync(process.execPath, [child], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300, killSignal: 'SIGTERM' });
      } catch (e) {
        timedOut = e.signal === 'SIGTERM';
      }
      const elapsed = Date.now() - start;
      expect(timedOut).toBe(true);
      // Well short of the grandchild's 5000ms sleep — the real, unfaked proof that the bound returns control
      // even through a nested, independently-piped child process, addressing the panel's "only a fake exec"
      // finding with an actual subprocess rather than another model of one.
      expect(elapsed).toBeLessThan(4000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// #4349 — a finished delivery wrapper now settles its own run-store effect and releases/holds the
// build-dispatch claim (see `deliver-item-wrapper.mjs`/`deliver-item-settle.mjs`); THIS daemon-side half is
// what actually stops the item from being re-dispatched: a settled, non-PR outcome retires a stale claim, and
// a held item is excluded from the next tick's candidates entirely.
describe('runBuildDispatchTick — #4349 settled-outcome claim retirement + holds', () => {
  let lockRoot;
  let holdRoot;
  beforeEach(() => {
    lockRoot = mkdtempSync(join(tmpdir(), 'bdd-claims-'));
    holdRoot = mkdtempSync(join(tmpdir(), 'bdd-holds-'));
  });
  afterEach(() => {
    rmSync(lockRoot, { recursive: true, force: true });
    rmSync(holdRoot, { recursive: true, force: true });
  });

  /** One item, cleared and queued, never freshly proposed for spawn (isolates the retirement logic from the
   *  dispatch-policy cap math the other describe block already covers). */
  const oneItemNoSpawnTick = () => ({
    decisions: {
      statusLine: 'test',
      counts: { building: 0, buildingInFlight: 0 },
      spawnBuilds: [],
      admission: {
        queue: [{ num: '9001', scope: ['we:scripts/x.mjs'] }],
        cleared: [{ num: '9001', ready: true }],
      },
    },
    nextState: {},
  });

  function baseEffects({ settledBuilds = [], runStoreInFlight = [], holds = [] } = {}) {
    return {
      planTick: () => oneItemNoSpawnTick(),
      fetchOpenPrs: () => [{ repo: 'we', prs: [] }],
      listClaims: () => listBuildDispatchClaims({ lockRoot }),
      releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
      acquireClaim: ({ num, scope }) => acquireBuildDispatchClaim({ num, scope, lockRoot }),
      listRunStoreInFlight: () => runStoreInFlight,
      listSettledBuilds: () => settledBuilds,
      listHolds: () => holds,
      killSwitch: () => ({ engaged: false }),
      dispatch: () => ({ dispatching: true, lane: 1 }),
    };
  }

  it('Done-when 3 — a stale claim whose run record settled with a non-PR outcome is retired, and the next '
    + 'tick does not count the item as building', async () => {
    acquireBuildDispatchClaim({ num: '9001', scope: [], lockRoot });
    expect(listBuildDispatchClaims({ lockRoot }).map((c) => c.meta.num)).toEqual(['9001']);
    const r = await runBuildDispatchTick({
      live: true,
      effects: baseEffects({ settledBuilds: [{ num: '9001', outcome: 'gate-red' }] }),
    });
    expect(r.retired).toEqual([expect.objectContaining({ num: '9001', released: true })]);
    expect(r.plan.inFlight).toEqual([]);
    expect(listBuildDispatchClaims({ lockRoot })).toEqual([]);
  });

  it('a settled `pr-opened` outcome is NOT retired here — the PR-observed path owns that', async () => {
    acquireBuildDispatchClaim({ num: '9001', scope: [], lockRoot });
    const r = await runBuildDispatchTick({
      live: true,
      effects: baseEffects({ settledBuilds: [{ num: '9001', outcome: 'pr-opened' }] }),
    });
    expect(r.retired).toEqual([]);
    expect(listBuildDispatchClaims({ lockRoot }).map((c) => c.meta.num)).toEqual(['9001']);
  });

  it('a stale SETTLED row from an older attempt never retires a NEWER attempt\'s claim while that newer '
    + 'attempt is still genuinely in-flight', async () => {
    acquireBuildDispatchClaim({ num: '9001', scope: [], lockRoot });
    const r = await runBuildDispatchTick({
      live: true,
      effects: baseEffects({
        settledBuilds: [{ num: '9001', outcome: 'gate-red' }], // an OLD attempt's stale settled row
        runStoreInFlight: [{ num: '9001', scope: [], source: 'run dispatch-lane-newer' }], // a NEWER, live one
      }),
    });
    expect(r.retired).toEqual([]);
    // the newer attempt's own in-flight row must still be reported, not hidden by the stale settled row.
    expect(r.plan.inFlight).toEqual([expect.objectContaining({ num: '9001' })]);
    expect(listBuildDispatchClaims({ lockRoot }).map((c) => c.meta.num)).toEqual(['9001']);
  });

  it('a stale SETTLED row from an OLDER attempt never retires a NEWER claim even before the new attempt\'s '
    + 'own run-store row exists at all — still `declared`, never reaching `listRunStoreInFlight`. The settled '
    + 'row\'s own `startedAt` predates the claim\'s `claimedAt`, so it is recognised as belonging to the OLD '
    + 'attempt this claim already superseded', async () => {
    const oldAttemptStartedAt = new Date(Date.now() - 5 * 60 * 60_000).toISOString(); // 5h ago
    acquireBuildDispatchClaim({ num: '9001', scope: [], lockRoot }); // the CURRENT, newer claim
    const r = await runBuildDispatchTick({
      live: true,
      effects: baseEffects({
        settledBuilds: [{ num: '9001', outcome: 'gate-red', startedAt: oldAttemptStartedAt }],
      }),
    });
    expect(r.retired).toEqual([]);
    expect(listBuildDispatchClaims({ lockRoot }).map((c) => c.meta.num)).toEqual(['9001']);
  });

  it('a settled row whose `startedAt` is AT OR AFTER the current claim\'s `claimedAt` DOES retire it — a '
    + 'genuinely fresh attempt that failed fast, before ever reaching `in-flight`', async () => {
    acquireBuildDispatchClaim({ num: '9001', scope: [], lockRoot });
    const { claimedAt } = listBuildDispatchClaims({ lockRoot })[0].meta;
    const r = await runBuildDispatchTick({
      live: true,
      effects: baseEffects({
        settledBuilds: [{ num: '9001', outcome: 'gate-red', startedAt: claimedAt }],
      }),
    });
    expect(r.retired).toEqual([expect.objectContaining({ num: '9001', released: true })]);
    expect(listBuildDispatchClaims({ lockRoot })).toEqual([]);
  });

  it('with two settled rows for the same item, the NEWEST by `startedAt` wins — never "whichever the source '
    + 'returned last": a stale `pr-opened` row listed AFTER a newer real failure must not hide it', async () => {
    acquireBuildDispatchClaim({ num: '9001', scope: [], lockRoot });
    const { claimedAt } = listBuildDispatchClaims({ lockRoot })[0].meta;
    const older = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    const r = await runBuildDispatchTick({
      live: true,
      effects: baseEffects({
        settledBuilds: [
          { num: '9001', outcome: 'gate-red', startedAt: claimedAt }, // the real, newer failure — listed FIRST
          { num: '9001', outcome: 'pr-opened', startedAt: older }, // a stale row — listed LAST
        ],
      }),
    });
    expect(r.retired).toEqual([expect.objectContaining({ num: '9001', released: true, why: 'run record settled: gate-red' })]);
  });

  it('a held item is excluded from this tick\'s candidates entirely (the re-dispatch-loop fix)', async () => {
    placeBuildDispatchHold({ num: '9001', reason: 'not-ready (blockedBy 1 re-opened)', lockRoot: holdRoot });
    const spawnableTick = () => ({
      decisions: {
        statusLine: 'test',
        counts: { building: 0, buildingInFlight: 0 },
        spawnBuilds: [{ num: '9001', lane: 1 }],
        admission: {
          queue: [{ num: '9001', scope: ['we:scripts/x.mjs'] }],
          cleared: [{ num: '9001', ready: true }],
        },
      },
      nextState: {},
    });
    const r = await runBuildDispatchTick({
      live: false,
      effects: {
        ...baseEffects({
          holds: listBuildDispatchHolds({ lockRoot: holdRoot }).map((h) => ({ num: h.meta.num, reason: h.meta.reason })),
        }),
        planTick: spawnableTick,
      },
    });
    expect(r.dispatchHolds).toEqual(['9001']);
    expect(r.plan.dispatch).toEqual([]);
    expect(r.plan.hold.find((h) => h.num === '9001')).toBeUndefined();
  });

  it('an effects stub with neither `listSettledBuilds` nor `listHolds` (predates #4349) behaves exactly as '
    + 'before — no retirement, no exclusion', async () => {
    const legacyEffects = {
      planTick: () => oneItemNoSpawnTick(),
      fetchOpenPrs: () => [{ repo: 'we', prs: [] }],
      listClaims: () => listBuildDispatchClaims({ lockRoot }),
      releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
      acquireClaim: ({ num, scope }) => acquireBuildDispatchClaim({ num, scope, lockRoot }),
      listRunStoreInFlight: () => [],
      killSwitch: () => ({ engaged: false }),
      dispatch: () => ({ dispatching: true, lane: 1 }),
    };
    acquireBuildDispatchClaim({ num: '9001', scope: [], lockRoot });
    const r = await runBuildDispatchTick({ live: true, effects: legacyEffects });
    expect(r.retired).toEqual([]);
    expect(r.dispatchHolds).toEqual([]);
    expect(listBuildDispatchClaims({ lockRoot }).map((c) => c.meta.num)).toEqual(['9001']);
  });
});

describe('settleBookkeeping', () => {
  it('keeps prior guards, drops new unexecuted ones across every guard list', () => {
    const prev = { buildGuards: [{ num: '1', lane: 3, spawnedTick: 0 }], prepareGuards: [], launchedNums: ['1'] };
    const next = {
      tick: 2,
      buildGuards: [{ num: '1', lane: 3, spawnedTick: 0 }, { num: '2', lane: 4, spawnedTick: 1 }, { num: '5', lane: 6, spawnedTick: 1 }],
      prepareGuards: [{ num: '9', kind: 'prepare', lane: 7, spawnedTick: 1 }],
      launchedNums: ['1', '2', '5', '9'],
    };
    const out = settleBookkeeping(prev, next, ['5']);
    expect(out.tick).toBe(2);
    expect(out.buildGuards.map((g) => g.num)).toEqual(['1', '5']);
    expect(out.prepareGuards).toEqual([]);
    expect(out.launchedNums).toEqual(['1', '5']);
  });
});

describe('kill switch + dispatch outcome', () => {
  it('reads the env flag and the kill file', () => {
    expect(readKillSwitch({ env: {} }).engaged).toBe(false);
    expect(readKillSwitch({ env: { [KILL_SWITCH_ENV]: '0' } }).engaged).toBe(false);
    expect(readKillSwitch({ env: { [KILL_SWITCH_ENV]: '1' } }).engaged).toBe(true);
    expect(readKillSwitch({ env: {}, killFileExists: true, killFilePath: '/k' })).toEqual({ engaged: true, reason: 'kill file /k' });
  });
  it('finds the nested dispatch verdict and fails closed on junk', () => {
    expect(readDispatchOutcome(JSON.stringify({ run: { verdict: { dispatching: true, lane: 3 }, effects: [{ type: 'conveyor.dispatch-delivery-agent', status: 'in-flight', handle: 'session-123' }] } }))).toMatchObject({ dispatching: true, lane: 3 });
    expect(readDispatchOutcome('not json').dispatching).toBe(false);
    expect(readDispatchOutcome('{}').dispatching).toBe(false);
    expect(readDispatchOutcome(JSON.stringify({ verdict: { dispatching: true } })).dispatching).toBe(false);
    expect(readDispatchOutcome(JSON.stringify({ verdict: { dispatching: true }, effects: [{ type: 'conveyor.dispatch-delivery-agent', status: 'in-flight', handle: null }] })).dispatching).toBe(false);
  });
});

// ================================================================================================
// `cliListSettledBuilds`/`cliListHolds` are the REAL readers `runBuildDispatchTick`'s own tests above only ever
// exercise through a hand-fed stub (`effectsFor`'s `listSettledBuilds`/`listHolds`). These drive the real
// functions against a real temp run-store / coordination root instead, so the applied/failed-only filter, the
// `outcome ?? 'wrapper-failed'` fallback, and the real hold reader are each proven against actual on-disk state.
// ================================================================================================
describe('cliListSettledBuilds / cliListHolds (the real readers, not a stub)', () => {
  let runsDir;
  let coordRoot;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'bdd-runs-'));
    coordRoot = mkdtempSync(join(tmpdir(), 'bdd-coord-'));
    process.env.OPERATION_RUNS_DIR = runsDir;
    process.env.WE_COORDINATION_ROOT = coordRoot;
  });

  afterEach(() => {
    delete process.env.OPERATION_RUNS_DIR;
    delete process.env.WE_COORDINATION_ROOT;
    rmSync(runsDir, { recursive: true, force: true });
    rmSync(coordRoot, { recursive: true, force: true });
  });

  function seedRun(id, effects) {
    const store = createFileRunStore(runsDir);
    store.write({ ...newRunRecord({ id, op: 'dispatch-lane' }), pending: null, effects });
    return store;
  }

  it.each([false, true])('observes old prepare sessions from the run store, including a failed listing (%s)', async (failed) => {
    seedRun('dispatch-lane-4329', [{
      key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'in-flight',
      payload: { num: '4329', launchKind: 'prepare-item' }, handle: '641f3cc9',
      startedAt: '2026-09-30T05:12:57Z', error: null,
    }]);
    const rows = await cliListRunStoreInFlight({ launchKind: 'prepare-item', now: new Date('2026-10-01'),
      listAgents: () => { if (failed) throw new Error('listing unavailable'); return []; },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].row.entry.live).toBe(failed ? null : false);
  });

  it.each([['past its deadline', '2026-10-01', 0], ['still inside its deadline', '2026-09-30T05:20:00Z', 1]])(
    'ages out a handle-less prepare row of unknown liveness (%s)', async (_label, now, expected) => {
      seedRun('dispatch-lane-4330', [{
        key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'in-flight',
        payload: { num: '4330', launchKind: 'prepare-item' }, handle: null,
        startedAt: '2026-09-30T05:12:57Z', error: null,
      }]);
      const rows = await cliListRunStoreInFlight({ launchKind: 'prepare-item', now: new Date(now), listAgents: () => [] });
      expect(rows).toHaveLength(expected);
    });

  it('lists an `applied` build effect under the OUTCOME the wrapper actually settled it with', async () => {
    seedRun('dispatch-lane-1001', [{
      key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'applied',
      payload: { num: '1001', launchKind: 'build' }, result: { outcome: 'not-ready', reason: 'blockedBy 1 re-opened' }, error: null,
    }]);
    const rows = await cliListSettledBuilds();
    expect(rows).toEqual([expect.objectContaining({ num: '1001', outcome: 'not-ready', source: 'run dispatch-lane-1001' })]);
  });

  it('carries the effect\'s own `startedAt` through — the ordering key `runBuildDispatchTick` uses to tell a '
    + 'fresh attempt\'s settle apart from an older, already-superseded one for the same item', async () => {
    seedRun('dispatch-lane-1005', [{
      key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'applied',
      startedAt: '2026-01-01T00:00:00.000Z',
      payload: { num: '1005', launchKind: 'build' }, result: { outcome: 'gate-red' }, error: null,
    }]);
    const rows = await cliListSettledBuilds();
    expect(rows).toEqual([{ num: '1005', outcome: 'gate-red', source: 'run dispatch-lane-1005', startedAt: '2026-01-01T00:00:00.000Z' }]);
  });

  it('falls back to the literal `wrapper-failed` for a `failed` entry with no `result` — an exception the '
    + 'wrapper caught but never got far enough to classify', async () => {
    seedRun('dispatch-lane-1002', [{
      key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'failed',
      payload: { num: '1002', launchKind: 'build' }, result: null, error: 'lane pool exhausted',
    }]);
    const rows = await cliListSettledBuilds();
    expect(rows).toEqual([expect.objectContaining({ num: '1002', outcome: 'wrapper-failed', source: 'run dispatch-lane-1002' })]);
  });

  it('excludes an `in-flight` build effect (not yet settled) and a non-build launchKind effect', async () => {
    seedRun('dispatch-lane-1003', [
      {
        key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'in-flight',
        payload: { num: '1003', launchKind: 'build' }, result: null, error: null,
      },
      {
        key: 'dispatch:0:1', type: DISPATCH_EFFECT, stepIndex: 0, index: 1, status: 'applied',
        payload: { num: '1004', launchKind: 'prepare' }, result: { outcome: 'done' }, error: null,
      },
    ]);
    expect(await cliListSettledBuilds()).toEqual([]);
  });

  it('cliListHolds reads a real, live hold placed via `placeBuildDispatchHold`, keyed by its own reason', () => {
    placeBuildDispatchHold({ num: '2001', reason: 'gate-red' });
    expect(cliListHolds()).toEqual([{ num: '2001', reason: 'gate-red' }]);
  });

  it('keeps prepare-unstamped holds past cooldown expiry while ordinary holds expire', () => {
    const nowMs = Date.now() - 300 * 60_000;
    placeBuildDispatchHold({ num: '2001', reason: 'prepare-unstamped', nowMs });
    placeBuildDispatchHold({ num: '2002', reason: 'gate-red', nowMs });
    expect(cliListHolds()).toEqual([{ num: '2001', reason: 'prepare-unstamped' }]);
  });

  it('reads completed prepare-item effects even when the agent supplied no outcome', async () => {
    seedRun('dispatch-lane-prepare-ended', [{
      key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'applied',
      payload: { num: '2001', launchKind: 'prepare-item' }, result: {}, error: null,
    }]);
    expect(await cliListSettledBuilds({ launchKind: 'prepare-item' })).toEqual([
      expect.objectContaining({ num: '2001', outcome: 'prepare-ended' }),
    ]);
    expect(await cliListSettledBuilds()).toEqual([]);
  });

  it('cliListHolds is empty with no holds placed', () => {
    expect(cliListHolds()).toEqual([]);
  });

  // xovjhwh converge round 2 (correctness/security/standards-conformance) — `deriveDispatchedByBuilder`'s own
  // docblock claims these two readers "degrade to `[]` on their own read error... never throw." The
  // pure-planner tests can only feed already-degraded empty arrays; this drives an ACTUAL read failure through
  // the REAL readers — `OPERATION_RUNS_DIR` pointed at a plain FILE, so the real store's `readdirSync` throws
  // ENOTDIR — and pins that both catch it rather than propagating.
  it('cliListSettledBuilds returns [] rather than throwing when the run-store read genuinely errors (dir is a file)', async () => {
    const filePath = join(runsDir, 'not-a-directory');
    writeFileSync(filePath, 'x');
    process.env.OPERATION_RUNS_DIR = filePath;
    await expect(cliListSettledBuilds()).resolves.toEqual([]);
  });

  it('card xao7080/#4518 — cliListRunStoreInFlight carries the durable `dispatch.executor` field through, '
    + 'so an in-flight build\'s provider is visible without re-deriving it', async () => {
    seedRun('dispatch-lane-2001', [{
      key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'in-flight',
      payload: { num: '2001', launchKind: 'build', scope: ['we:foo.md'] },
      dispatch: { launchKind: 'build', route: 'detached', executor: 'antigravity' },
      result: null, error: null,
    }]);
    const rows = await cliListRunStoreInFlight();
    expect(rows).toEqual([{ num: '2001', scope: ['we:foo.md'], source: 'run dispatch-lane-2001', executor: 'antigravity' }]);
  });

  it('card xao7080/#4518 — cliListRunStoreInFlight reports `executor: null` for a record written before the '
    + 'field existed, never a guessed provider', async () => {
    seedRun('dispatch-lane-2002', [{
      key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'in-flight',
      payload: { num: '2002', launchKind: 'build' }, result: null, error: null,
    }]);
    const rows = await cliListRunStoreInFlight();
    expect(rows).toEqual([expect.objectContaining({ num: '2002', executor: null })]);
  });

  it('reads prepare-item run records separately from build slots', async () => {
    seedRun('dispatch-lane-prepare-2003', [{
      key: 'dispatch:0:0', type: DISPATCH_EFFECT, stepIndex: 0, index: 0, status: 'in-flight',
      payload: { num: '2003', launchKind: 'prepare-item' }, result: null, error: null,
    }]);
    expect(await cliListRunStoreInFlight()).toEqual([]);
    expect((await cliListRunStoreInFlight({ launchKind: 'prepare-item' })).map((r) => r.num)).toEqual(['2003']);
  });

  it('cliListRunStoreInFlight returns [] rather than throwing when the run-store read genuinely errors (dir is a file)', async () => {
    const filePath = join(runsDir, 'not-a-directory');
    writeFileSync(filePath, 'x');
    process.env.OPERATION_RUNS_DIR = filePath;
    await expect(cliListRunStoreInFlight()).resolves.toEqual([]);
  });
});

// LIVE incident, 2026-09-29: this PR's own build-dispatch-orphan-adopt.mjs booted clean under every vitest
// suite in this repo (this file included) but crashed the real daemon at startup once overlaid on the
// builder clone — `ReferenceError: Cannot access 'DELIVER_ITEM_RUN_SCRIPT' before initialization` inside
// `dispatch-provider-registry.mjs`, a classic ESM circular-import TDZ. THE REASON EVERY OTHER TEST IN THIS
// FILE MISSED IT: vitest (and this file's own earlier imports) load the module graph in whatever order ITS
// OWN import statements happen to reach each file first — a different order than `node
// skills-src/conveyor/build-dispatch-daemon.mjs` reaches it as the FIRST thing Node evaluates, which is the
// one order that actually matters (it is exactly what launchd invokes — see
// `launchd/com.we.build-dispatch-daemon.plist.example`'s own `ProgramArguments`). An in-process
// `import(...)` of the same file from inside an already-running vitest worker is not a safe substitute for
// this reason either: by then several of this daemon's own dependencies are already warm in the SAME
// process's module cache from earlier tests, which can hide precisely this class of ordering bug. So this
// spawns a REAL, FRESH `node` subprocess with no flags at all — the daemon's own `main()` prints its usage
// and exits 2 before touching any state, network or filesystem, which happens strictly AFTER every static
// import in its whole module graph has already finished evaluating; a TDZ anywhere in that graph throws
// during the import phase, before `main()` is ever reached, and Node reports it as an uncaught
// `ReferenceError` on stderr with exit code 1 — never the clean usage text on exit 2.
// #4464 builder-cap-machine-wide (live incident 2026-09-29 ~11 ET) — `cliPlanTick`'s own env override, so this
// daemon's tick-core read is exempted from the shared, machine-wide lane-count ceiling. See `cliPlanTick`'s
// own docblock for the full incident and why exempting it is safe.
describe('cliPlanTick — exempts this daemon\'s own tick-core read from the shared lane-count ceiling (#4464)', () => {
  it('passes WE_MAX_CONCURRENT_LANES on the CHILD\'s own env, set to the exempt value', () => {
    const exec = (cmd, args, opts) => {
      expect(opts.env[MAX_CONCURRENT_LANES_ENV]).toBe(BUILD_DAEMON_LANE_CAP_EXEMPT_VALUE);
      return JSON.stringify({ decisions: {}, nextState: {} });
    };
    const out = cliPlanTick({}, { exec });
    expect(out).toEqual({ decisions: {}, nextState: {} });
  });

  it('never touches process.env itself — only the child\'s own env object', () => {
    const before = process.env[MAX_CONCURRENT_LANES_ENV];
    const exec = () => JSON.stringify({ decisions: {}, nextState: {} });
    cliPlanTick({}, { exec });
    expect(process.env[MAX_CONCURRENT_LANES_ENV]).toBe(before);
  });

  it('still forwards every OTHER inherited env var unchanged (a spread, never a replacement)', () => {
    const exec = (cmd, args, opts) => {
      expect(opts.env.PATH).toBe(process.env.PATH);
      return JSON.stringify({ decisions: {}, nextState: {} });
    };
    cliPlanTick({}, { exec });
  });

  it('the exempt value is a real, effectively-unbounded number — never accidentally tiny', () => {
    expect(Number(BUILD_DAEMON_LANE_CAP_EXEMPT_VALUE)).toBeGreaterThan(1000);
  });
});

describe('build-dispatch-daemon.mjs boots as a fresh `node` process — the class of bug a vitest import cannot catch', () => {
  const ENTRY = resolve(fileURLToPath(import.meta.url), '..', '..', 'build-dispatch-daemon.mjs');

  it('a fresh `node <entry>` process (no flags) evaluates its ENTIRE static import graph and reaches its own '
    + 'usage text (exit 2) — never a ReferenceError/TDZ from a circular import reached only at real process '
    + 'startup (exit 1, with the module graph never even fully loading)', () => {
    // `main()`'s own usage block is a KNOWN, EXPECTED non-zero exit (2) — `execFileSync` throws on it exactly
    // as it would on the crash this test exists to catch, so BOTH outcomes are read from the caught error;
    // what tells them apart is the exit code and stderr's own text, never "did it throw".
    let stderr = '';
    let status = 0;
    try {
      execFileSync('node', [ENTRY, '--bogus-flag'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      stderr = String(e.stderr ?? '');
      status = e.status;
    }
    expect(stderr).not.toMatch(/ReferenceError|before initialization/);
    expect(stderr).toMatch(/^usage: build-dispatch-daemon\.mjs/);
    expect(status).toBe(2);
  });
});

describe('prepare transcript evidence', () => {
  it('degrades to the base evidence when the transcript dir is unreadable or the handle is too short to attribute', () => {
    const projects = mkdtempSync(join(tmpdir(), 'prepare-transcript-'));
    try {
      mkdirSync(join(projects, 'scratch'));
      writeFileSync(join(projects, 'scratch', 'abcdef-session.jsonl'), '');
      expect(cliPrepareFailureEvidence({ handle: 'abc', error: 'boom' }, { projects })).toEqual({ error: 'boom' });
      chmodSync(join(projects, 'scratch'), 0o000);
      expect(() => cliPrepareFailureEvidence({ handle: 'abcdef', error: 'boom' }, { projects })).not.toThrow();
      expect(cliPrepareFailureEvidence({ handle: 'abcdef', error: 'boom' }, { projects })).toEqual({ error: 'boom' });
      expect(() => cliPrepareFailureEvidence({ handle: 'abcdef' }, { projects: join(projects, 'nope') })).not.toThrow();
    } finally { chmodSync(join(projects, 'scratch'), 0o755); rmSync(projects, { recursive: true, force: true }); }
  });
  it('uses assistant terminal output, never a prompt that describes hypothetical failures', () => {
    const projects = mkdtempSync(join(tmpdir(), 'prepare-transcript-'));
    try {
      mkdirSync(join(projects, 'scratch'));
      const file = join(projects, 'scratch', 'abcdef-session.jsonl');
      writeFileSync(file, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'HTTP 429. The runner owns stamping; no stamp.' }] } }) + '\n');
      expect(cliPrepareFailureEvidence({ handle: 'abcdef' }, { projects }).stoppedBeforeCompletion).toBe(false);
      writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Authored sections, no stamp or PR; the runner owns completion.' }] } }) + '\n');
      expect(cliPrepareFailureEvidence({ handle: 'abcdef' }, { projects })).toMatchObject({ stoppedBeforeCompletion: true, transcript: file });
    } finally { rmSync(projects, { recursive: true, force: true }); }
  });
});

describe('prepare stamp detached worker wiring', () => {
  it('does not retry a terminal recovery failure on lease expiry; a cited fix or transient budget is required', async () => {
    const reserve = vi.fn(() => ({ ok: true }));
    const release = vi.fn();
    const readFailure = () => ({ attempt: 'stamp:1:a', error: 'invalid card' });
    const options = { reserve, release, readFailure, markStarting: vi.fn(), releases: () => [], failures: () => [] };
    await expect(cliStampPrepare({ num: '1' }, options)).rejects.toMatchObject({ prepareAttempt: 'stamp:1:a' });
    expect(reserve).not.toHaveBeenCalled();
    const out = await cliStampPrepare({ num: '1' }, { ...options, releases: () => [{ target: '1', attempt: 'stamp:1:a' }] });
    expect(out.spawned).toBe(true);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ leaseMinutes: STAMP_RECOVERY_LEASE_MINUTES }));
    expect(options.markStarting).toHaveBeenCalledWith('1');
  });

  it('reserves with a finite lease that survives JSON, so a crashed worker with no terminal record is reclaimed', () => {
    expect(Number.isFinite(STAMP_RECOVERY_LEASE_MINUTES)).toBe(true);
    expect(JSON.parse(JSON.stringify({ leaseMinutes: STAMP_RECOVERY_LEASE_MINUTES })).leaseMinutes).toBe(STAMP_RECOVERY_LEASE_MINUTES);
  });

  it('cliReadStampFailure reads only the latest terminal line: a new starting marker masks an older failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'stamp-log-'));
    try {
      const num = '9991';
      const dir = join(root, '.operations', 'delivery-dispatch-logs');
      mkdirSync(dir, { recursive: true });
      const log = join(dir, `prepare-stamp-${num}.log`);
      const failed = JSON.stringify({ status: 'failed', attempt: 'stamp:9991:a', error: 'bad card' });
      const starting = JSON.stringify({ status: 'starting' });
      writeFileSync(log, [failed, starting, 'null', ''].join('\n'));
      expect(cliReadStampFailure(num, root)).toBeNull();
      writeFileSync(log, [starting, failed, 'null', ''].join('\n'));
      expect(cliReadStampFailure(num, root)).toMatchObject({ attempt: 'stamp:9991:a' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts the spawner ChildProcess pid and deduplicates subsequent ticks', async () => {
    const reserve = vi.fn().mockReturnValueOnce({ ok: true }).mockReturnValue({ ok: false });
    const release = vi.fn();
    delete fakeDetachedResult.spawned;
    try {
      expect(await cliStampPrepare({ num: '4544' }, { reserve, release, markStarting: vi.fn(), readFailure: () => null })).toEqual({ spawned: true, pid: 4242 });
      expect(spawnCalls.at(-1).argv).toEqual([expect.stringContaining('/operations/prepare-stamp-land.mjs'), '--num=4544']);
      expect(await cliStampPrepare({ num: '4544' }, { reserve, release, markStarting: vi.fn(), readFailure: () => null })).toEqual({ pending: true });
      expect(release).not.toHaveBeenCalled();
    } finally { fakeDetachedResult.spawned = true; }
  });
});

describe('automatic item preparation', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-prepare-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });
  function fixture({ inFlight = [], fail = false, pid = 10 } = {}) {
    const dispatch = vi.fn(() => ({ dispatching: !fail, reason: fail ? 'refused' : null }));
    const spawns = [{ num: '4501', lane: 1 }, { num: '4502', lane: 2 }];
    return {
      dispatch,
      placePrepareHold: vi.fn(),
      releasePrepareHold: vi.fn(),
      planTick: (bk) => ({ decisions: { itemPrepareSpawns: spawns }, nextState: {
        tick: (bk.tick ?? 0) + 1,
        prepareGuards: [...(bk.prepareGuards ?? []), ...spawns.map((s) => ({ ...s, kind: 'prepare-item', spawnedTick: bk.tick ?? 0 }))],
        launchedNums: spawns.map((s) => s.num),
      } }),
      fetchOpenPrs: () => [], listClaims: () => [], listRunStoreInFlight: () => [],
      killSwitch: () => ({ engaged: false }),
      listPrepareInFlight: () => inFlight,
      listPrepareClaims: () => listBuildDispatchClaims({ lockRoot }),
      acquirePrepareClaim: (o) => acquireBuildDispatchClaim({ ...o, lockRoot, owner: `host:${pid}`, pid }),
      releasePrepareClaim: (o) => releaseBuildDispatchClaim({ ...o, lockRoot }),
    };
  }
  function claimed(effects, num = '4501', { age = 40, alive = false } = {}) {
    acquireBuildDispatchClaim({ num, lockRoot, owner: 'host:10', pid: 10,
      nowMs: Date.now() - age * 60_000 });
    effects.hostname = () => 'host';
    effects.isPidAlive = () => alive;
    effects.readPrepareStatus = () => ({ preparedDate: null });
    effects.placePrepareHold = vi.fn();
  }
  it.each([false, true])('reconciles a stamped prepare before next-tick planning (live=%s)', async (workerLive) => {
    const row = { num: '4501', row: { runId: 'original', entry: {
      key: 'original#2#0', live: workerLive, status: 'in-flight' } } };
    const effects = fixture({ inFlight: [row] });
    const bk = { prepareGuards: [{ num: '4501', kind: 'prepare-item', lane: 1, spawnedTick: 1 }] };
    effects.readPrepareStatus = () => ({ preparedDate: '2026-09-30' });
    effects.settlePrepareRow = vi.fn();
    effects.acquireClaim = () => ({ ok: true });
    effects.releaseClaim = vi.fn();
    effects.planTick = vi.fn(b => ({ decisions: { admission: { queue: [{ num: '4501', scope: ['we:scripts/example.mjs'] }] }, spawnBuilds: b.prepareGuards.length ? [] : [{ num: '4501', lane: 1 }] }, nextState: b }));
    const tick = await runBuildDispatchTick({ live: true, bookkeeping: bk, effects });
    expect(tick.failures).toEqual([]);
    if (workerLive) {
      expect(effects.settlePrepareRow).not.toHaveBeenCalled();
      expect(effects.dispatch).not.toHaveBeenCalled();
    } else {
      expect(effects.settlePrepareRow).toHaveBeenCalledWith({ runId: 'original', key: 'original#2#0', outcome: 'prepare-completed' });
      expect(effects.planTick.mock.calls[0][0].prepareGuards).toEqual([]);
      expect(tick.dispatched.map(r => r.num)).toEqual(['4501']);
    }
  });
  it('does not clear a build hold when preparation completes', async () => {
    const effects = fixture({ inFlight: [{ num: '4501', row: { runId: 'original', entry: { key: 'key', live: false } } }] });
    effects.listHolds = () => [{ num: '4501', reason: 'gate-red' }];
    effects.readPrepareStatus = () => ({ preparedDate: '2026-09-30' });
    effects.settlePrepareRow = vi.fn();
    effects.releasePrepareHold = vi.fn();
    await runBuildDispatchTick({ live: true, effects });
    expect(effects.releasePrepareHold).not.toHaveBeenCalled();
    expect(effects.dispatch.mock.calls.some(([r]) => r.num === '4501')).toBe(false);
  });
  it('retains eligibility guards if durable completion cannot be written', async () => {
    const effects = fixture({ inFlight: [{ num: '4501', row: { runId: 'original', entry: { key: 'key', live: false } } }] });
    effects.readPrepareStatus = () => ({ preparedDate: '2026-09-30' });
    effects.settlePrepareRow = vi.fn(() => { throw new Error('store unavailable'); });
    const guard = { num: '4501', kind: 'prepare-item', spawnedTick: 1 };
    const tick = await runBuildDispatchTick({ live: true, bookkeeping: { prepareGuards: [guard] }, effects });
    expect(effects.settlePrepareRow).toHaveBeenCalledTimes(1);
    expect(tick.prepare.inFlight).toContain('4501');
    expect(tick.prepare.failures).toContainEqual(expect.objectContaining({ num: '4501', stage: 'retirement', reason: 'store unavailable' }));
    expect(effects.dispatch.mock.calls.some(([r]) => r.num === '4501')).toBe(false);
  });
  it('uses the explicit Codex policy despite historical probation failures', async () => {
    const effects = fixture();
    effects.listProbationPrepares = () => ['4322', '4325'].map(item => ({ item,
      scoredAt: item, dispatchKind: 'probation-launch', taskType: 'prepare',
      repo: 'web-everything/web-everything', launchOutcome: 'gate-red', pr: null }));
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.route).toBe('probation');
    expect(tick.prepare.policyRoute).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
    expect(effects.dispatch.mock.calls.length).toBeGreaterThan(0);
    expect(effects.dispatch.mock.calls.every(([r]) => r.prepareFallback === false)).toBe(true);
  });
  it('excludes two persistent holds before core planning, freeing both slots', async () => {
    const effects = fixture();
    effects.listHolds = () => ['4544', '4560'].map((num) => ({ num, reason: 'prepare-unstamped' }));
    effects.readPrepareStatus = () => ({ preparedDate: null, hasSections: false });
    effects.placePrepareHold = vi.fn();
    effects.planTick = (bk) => {
      const prep = planPrepareSpawns({ needsPrepare: ['4544', '4560', '4501', '4502'].map((num) => ({ num })),
        prepareHeldNums: bk.prepareHeldNums, availableLanes: [1, 2] });
      return { decisions: { spawnPrepareItems: prep.itemPrepareSpawns }, nextState: {} };
    };
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.launched.map((s) => s.num)).toEqual(['4501', '4502']);
    expect(tick.prepare.inFlight).toEqual([]);
  });
  it('mechanically stamps sectioned results instead of holding them unstamped', async () => {
    const effects = fixture();
    claimed(effects);
    effects.readPrepareStatus = () => ({ preparedDate: null, hasSections: true });
    effects.stampPrepare = vi.fn(() => ({ spawned: true }));
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(effects.stampPrepare).toHaveBeenCalledWith(expect.objectContaining({ num: '4501' }));
    expect(effects.placePrepareHold).toHaveBeenCalledWith({ num: '4501', reason: 'prepare-stamp-pending' });
    expect(tick.prepare.failures).toEqual([]);
    expect(tick.prepare.inFlight).not.toContain('4501');
  });
  it('holds incomplete results without attempting a mechanical stamp', async () => {
    const effects = fixture();
    claimed(effects);
    effects.readPrepareStatus = () => ({ preparedDate: null, hasSections: false });
    effects.stampPrepare = vi.fn();
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(effects.stampPrepare).not.toHaveBeenCalled();
    expect(tick.prepare.held).toEqual([{ num: '4501', reason: 'prepare-unstamped' }]);
  });
  it('does not spawn stamp recovery during dry run or a freeze', async () => {
    for (const live of [false, true]) {
      const effects = fixture();
      effects.listHolds = () => [{ num: '4544', reason: 'prepare-unstamped' }];
      effects.readPrepareStatus = () => ({ hasSections: true, preparedDate: null });
      effects.placePrepareHold = vi.fn();
      effects.killSwitch = () => ({ engaged: true });
      effects.stampPrepare = vi.fn();
      await runBuildDispatchTick({ live, effects });
      expect(effects.stampPrepare).not.toHaveBeenCalled();
    }
  });
  it('retires a dead owner past TTL and logs it; clears prior guards', async () => {
    const effects = fixture();
    claimed(effects);
    const guard = { num: '4501', kind: 'prepare-item', spawnedTick: 0 };
    const tick = await runBuildDispatchTick({ live: true, effects, bookkeeping: { prepareGuards: [guard] } });
    expect(tick.prepare.retired).toEqual([{ num: '4501', why: 'dead prepare owner past heartbeat TTL', released: true }]);
    expect(tick.prepare.inFlight).not.toContain('4501');
    expect(tick.nextBookkeeping.prepareGuards.map((g) => g.num)).not.toContain('4501');
    expect(effects.listPrepareClaims().map((c) => c.meta.num)).not.toContain('4501');
  });
  it.each([{ age: 40, alive: true }, { age: 1, alive: false }])('keeps a live or fresh claim: %j', async (state) => {
    const effects = fixture();
    claimed(effects, '4501', state);
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.retired).toEqual([]);
    expect(tick.prepare.inFlight).toContain('4501');
  });
  it('retires a prepared card even with a stale in-flight row and never prepares it again', async () => {
    const effects = fixture({ inFlight: [{ num: '4501' }] });
    claimed(effects, '4501', { alive: true });
    effects.readPrepareStatus = ({ num }) => ({ preparedDate: num === '4501' ? '2026-09-29' : null });
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.retired[0].why).toBe('prepared on main');
    expect(tick.prepare.inFlight).not.toContain('4501');
    expect(effects.dispatch.mock.calls.map(([r]) => r.num)).toEqual(['4502']);
  });
  it.each(['MERGED', 'CLOSED'])('retires a %s prepare PR and durably holds its unstamped card across restart', async (state) => {
    const effects = fixture();
    claimed(effects);
    const holdRoot = join(lockRoot, 'holds');
    effects.placePrepareHold = (o) => placeBuildDispatchHold({ ...o, lockRoot: holdRoot });
    effects.listHolds = () => listBuildDispatchHolds({ lockRoot: holdRoot }).map((c) => c.meta);
    effects.readPrepareStatus = ({ num }) => ({ preparedDate: null, pr: num === '4501' ? { state } : null });
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.retired[0].why).toBe(`prepare PR ${state.toLowerCase()}`);
    expect(tick.prepare.failures).toContainEqual(expect.objectContaining({ num: '4501', stage: 'result', reason: 'prepare-unstamped', cause: 'unknown', retry: false }));
    expect(effects.listHolds()[0].reason).toBe('prepare-unstamped');
    await runBuildDispatchTick({ live: true, effects });
    expect(effects.dispatch.mock.calls.map(([r]) => r.num)).toEqual(['4502']);
  });
  it('holds a settled unstamped run without a PR, but accepts a stamped open PR awaiting merge', async () => {
    const effects = fixture();
    effects.listSettledPrepares = () => ['4501', '4502'].map((num) => ({ num, startedAt: '2026-09-29', outcome: 'prepare-ended' }));
    effects.placePrepareHold = vi.fn();
    effects.readPrepareStatus = ({ num }) => ({ preparedDate: null, pr: num === '4502' ? { state: 'OPEN', preparedDate: '2026-09-29' } : null });
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(effects.placePrepareHold).toHaveBeenCalledTimes(1);
    expect(effects.placePrepareHold).toHaveBeenCalledWith({ num: '4501', reason: 'prepare-unstamped' });
    expect(tick.prepare.inFlight).toEqual(['4502']);
    expect(effects.dispatch).not.toHaveBeenCalled();
  });
  it.each([true, false])('checks the worker independently of its dead owner (alive=%s)', async (alive) => {
    const effects = fixture({ inFlight: [{ num: '4501', row: { runId: 'run', entry: {
      key: 'dispatch:0:0', status: 'in-flight', handle: 'pid:123',
    } } }] });
    claimed(effects);
    effects.isPidAlive = (pid) => pid === 123 && alive;
    effects.settlePrepareRow = vi.fn();
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.inFlight.includes('4501')).toBe(alive);
    expect(tick.prepare.retired).toHaveLength(alive ? 0 : 1);
    if (!alive) expect(effects.settlePrepareRow).toHaveBeenCalledWith({ runId: 'run', key: 'dispatch:0:0', outcome: 'prepare-unstamped' });
  });
  it('clears an unstamped hold only after main has the stamp', async () => {
    const effects = fixture();
    effects.listHolds = () => [{ num: '4501', reason: 'prepare-unstamped' }];
    effects.readPrepareStatus = ({ num }) => ({ preparedDate: num === '4501' ? '2026-09-29' : null });
    effects.releasePrepareHold = vi.fn();
    await runBuildDispatchTick({ live: true, effects });
    expect(effects.releasePrepareHold).toHaveBeenCalledWith({ num: '4501' });
    expect(effects.dispatch.mock.calls.map(([r]) => r.num)).toEqual(['4502']);
  });
  it('dry-run logs retirement without releasing or placing holds', async () => {
    const effects = fixture();
    claimed(effects);
    effects.readPrepareStatus = () => ({ preparedDate: null, pr: { state: 'MERGED' } });
    effects.placePrepareHold = vi.fn();
    const tick = await runBuildDispatchTick({ effects });
    expect(tick.prepare.retired[0].released).toBe(false);
    expect(effects.listPrepareClaims()).toHaveLength(1);
    expect(effects.placePrepareHold).not.toHaveBeenCalled();
  });
  it('keeps claims on failed observations and ignores an older settled attempt', async () => {
    const effects = fixture();
    claimed(effects, '4501', { alive: true });
    effects.listSettledPrepares = () => [{ num: '4501', startedAt: '2000-01-01', outcome: 'prepare-ended' }];
    effects.placePrepareHold = vi.fn();
    await runBuildDispatchTick({ live: true, effects });
    expect(effects.placePrepareHold).not.toHaveBeenCalled();
    effects.readPrepareStatus = () => { throw new Error('network unavailable'); };
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.retired).toEqual([]);
    expect(effects.listPrepareClaims().map(c => c.meta.num)).toContain('4501');
    expect(tick.prepare.inFlight).toContain('4501');
    expect(tick.prepare.failures).toContainEqual(expect.objectContaining({ cause: 'daemon-observation' }));
  });
  it('an unclassified observation error (502, ETIMEDOUT, hang up) never holds, files a card or writes the ledger', async () => {
    for (const message of ['gh: HTTP 502', 'ETIMEDOUT', 'socket hang up']) {
      const effects = fixture();
      claimed(effects, '4501', { alive: true });
      const recordPrepareFailure = vi.fn();
      effects.recordPrepareFailure = recordPrepareFailure;
      effects.placePrepareHold = vi.fn();
      effects.readPrepareStatus = () => { throw new Error(message); };
      const tick = await runBuildDispatchTick({ live: true, effects });
      expect(tick.prepare.failures).toContainEqual(expect.objectContaining({ num: '4501', stage: 'retirement', cause: 'daemon-observation' }));
      expect(recordPrepareFailure).not.toHaveBeenCalled();
      expect(effects.placePrepareHold).not.toHaveBeenCalled();
      expect(tick.prepare.held).toEqual([]);
    }
  });
  it('claim contention neither holds nor files a card, and only blocks the item this tick', async () => {
    const effects = fixture();
    effects.acquirePrepareClaim = () => ({ ok: false, reason: 'held' });
    effects.recordPrepareFailure = vi.fn();
    effects.placePrepareHold = vi.fn();
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.failures).toContainEqual(expect.objectContaining({ stage: 'claim', cause: 'daemon-observation' }));
    expect(effects.recordPrepareFailure).not.toHaveBeenCalled();
    expect(effects.placePrepareHold).not.toHaveBeenCalled();
  });
  it('a release of the latest attempt is not undone by an older unreleased failure', async () => {
    const effects = fixture();
    effects.listHolds = () => [{ num: '4501', reason: 'prepare-unstamped' }];
    effects.listSettledPrepares = () => [
      { num: '4501', source: 'run:old', startedAt: '2026-09-28', outcome: 'prepare-unstamped' },
      { num: '4501', source: 'run:new', startedAt: '2026-09-30', outcome: 'prepare-unstamped' },
    ];
    effects.listPrepareReleases = () => [{ target: '4501', attempt: 'run:new' }];
    effects.readPrepareStatus = () => ({ preparedDate: null });
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(effects.releasePrepareHold).toHaveBeenCalledWith({ num: '4501' });
    expect(effects.placePrepareHold).not.toHaveBeenCalled();
    expect(tick.prepare.failures).toEqual([]);
    expect(tick.prepare.launched.map(r => r.num)).toContain('4501');
  });
  it('never holds or probes a claim-less candidate that has no current-attempt evidence', async () => {
    const effects = fixture();
    effects.placePrepareHold = vi.fn();
    effects.readPrepareStatus = vi.fn(() => ({ preparedDate: null, pr: { state: 'CLOSED' } }));
    effects.listSettledPrepares = () => [];
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(effects.placePrepareHold).not.toHaveBeenCalled();
    expect(effects.readPrepareStatus).not.toHaveBeenCalled();
    expect(effects.dispatch.mock.calls.map(([r]) => r.num)).toEqual(['4501', '4502']);
    expect(tick.prepare.held).toEqual([]);
  });
  it('does not let a held card whose file left main consume a prepare slot', async () => {
    const effects = fixture();
    effects.listHolds = () => [{ num: '4501', reason: 'prepare-unstamped' }];
    effects.readPrepareStatus = ({ num }) => { if (num === '4501') throw new Error('prepare card #4501 not found on origin/main'); return { preparedDate: null }; };
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.inFlight).not.toContain('4501');
    expect(tick.prepare.failures).toContainEqual(expect.objectContaining({ num: '4501', stage: 'retirement' }));
    expect(effects.dispatch.mock.calls.map(([r]) => r.num)).toEqual(['4502']);
  });
  it('retires a dead worker whose open PR carries no stamp, holding it', async () => {
    const effects = fixture();
    claimed(effects);
    effects.readPrepareStatus = () => ({ preparedDate: null, pr: { state: 'OPEN', preparedDate: null } });
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.retired).toHaveLength(1);
    expect(effects.placePrepareHold).toHaveBeenCalledWith({ num: '4501', reason: 'prepare-unstamped' });
    expect(tick.prepare.inFlight).not.toContain('4501');
  });
  it('keeps a dead-owner claim whose open PR is stamped (valid run awaiting landing)', async () => {
    const effects = fixture();
    claimed(effects);
    effects.readPrepareStatus = () => ({ preparedDate: null, pr: { state: 'OPEN', preparedDate: '2026-09-29' } });
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.retired).toEqual([]);
    expect(tick.prepare.inFlight).toContain('4501');
  });
  it('ignores fork PRs when reading prepare status', () => {
    const exec = vi.fn((cmd, args) => {
      if (cmd === 'git') return 'backlog/4501-card.md\n';
      if (args[0] === 'pr') {
        expect(args.join(' ')).toContain('isCrossRepository');
        return JSON.stringify([{ state: 'CLOSED', headRefName: 'lane/4501-prepare-x', createdAt: '2026-09-29', isCrossRepository: true }]);
      }
      return JSON.stringify({ content: Buffer.from('---\nstatus: open\n---').toString('base64') });
    });
    expect(cliReadPrepareStatus({ num: '4501', claimedAt: '2026-09-28' }, { exec }).pr).toBeNull();
  });
  it('reads the stamp from remote main and an open PR head, ignoring older PRs', () => {
    const exec = vi.fn((cmd, args) => {
      if (cmd === 'git') return 'backlog/4501-card.md\n';
      if (args[0] === 'pr') return JSON.stringify([
        { state: 'MERGED', headRefName: 'lane/4501-prepare-old', createdAt: '2026-01-01' },
        { state: 'OPEN', headRefName: 'lane/4501-prepare-new', headRefOid: 'abcd', createdAt: '2026-09-29' },
      ]);
      return JSON.stringify({ content: Buffer.from(args[1].endsWith('ref=main') ? '---\nstatus: open\n---' : '---\npreparedDate: 2026-09-29\n---').toString('base64') });
    });
    const status = cliReadPrepareStatus({ num: '4501', claimedAt: '2026-09-28' }, { exec });
    expect(status.preparedDate).toBeNull();
    expect(status.pr).toMatchObject({ state: 'OPEN', preparedDate: '2026-09-29' });
  });
  it('launches two prepare-item dispatches, retaining only their guards; no repeat next tick or after restart', async () => {
    const effects = fixture();
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(effects.dispatch.mock.calls.map(([x]) => [x.num, x.launchKind])).toEqual([['4501', 'prepare-item'], ['4502', 'prepare-item']]);
    expect(tick.nextBookkeeping.prepareGuards).toHaveLength(2);
    expect(tick.nextBookkeeping.launchedNums).toEqual(['4501', '4502']);
    await runBuildDispatchTick({ live: true, effects, bookkeeping: tick.nextBookkeeping });
    expect(effects.dispatch).toHaveBeenCalledTimes(2);
    const restarted = fixture({ pid: 20 });
    await runBuildDispatchTick({ live: true, effects: restarted });
    expect(restarted.dispatch).not.toHaveBeenCalled();
  });
  it('two existing run-store prepares leave zero slots for new items', async () => {
    const effects = fixture({ inFlight: [{ num: '4401' }, { num: '4402' }] });
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(effects.dispatch).not.toHaveBeenCalled();
    expect(tick.prepare.planned).toEqual([]);
  });
  it('dry-run reports planned prepares without dispatches, claims, or new guards', async () => {
    const effects = fixture();
    const tick = await runBuildDispatchTick({ effects });
    expect(tick.prepare.planned.map((s) => s.num)).toEqual(['4501', '4502']);
    expect(tick.prepare.launched).toEqual([]);
    expect(effects.dispatch).not.toHaveBeenCalled();
    expect(effects.listPrepareClaims()).toEqual([]);
    expect(tick.nextBookkeeping.prepareGuards).toEqual([]);
  });
  it('fix-cited exact-attempt release removes the hold without reholding the historical result', async () => {
    const effects = fixture();
    effects.listHolds = () => [{ num: '4501', reason: 'prepare-unstamped' }];
    effects.listSettledPrepares = () => [{ num: '4501', source: 'run:old', startedAt: '2026-09-29', outcome: 'prepare-unstamped' }];
    effects.listPrepareReleases = () => [{ target: '4501', attempt: 'run:old' }];
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(effects.releasePrepareHold).toHaveBeenCalledWith({ num: '4501' });
    expect(tick.prepare.launched.map(r => r.num)).toContain('4501');
    expect(effects.placePrepareHold).not.toHaveBeenCalled();
  });
  it('an old release cannot clear a new failed attempt', async () => {
    const effects = fixture();
    effects.listHolds = () => [{ num: '4501', reason: 'prepare-unstamped' }];
    effects.listSettledPrepares = () => [
      { num: '4501', source: 'run:old', startedAt: '2026-09-29', outcome: 'prepare-unstamped' },
      { num: '4501', source: 'run:new', startedAt: '2026-09-30', outcome: 'wrapper-failed' },
    ];
    effects.listPrepareReleases = () => [{ target: '4501', attempt: 'run:old' }];
    effects.readPrepareStatus = () => ({ preparedDate: null });
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(effects.releasePrepareHold).not.toHaveBeenCalled();
    expect(tick.prepare.launched.map(r => r.num)).not.toContain('4501');
  });
  it('retires a transient settled failure then allows a bounded retry on the next tick', async () => {
    const effects = fixture();
    const path = join(lockRoot, 'failures.json');
    effects.recordPrepareFailure = input => recordPrepareFailure(input, { path, fileCard: vi.fn() });
    effects.listPrepareFailures = () => Object.values(readFailureState(path).failures);
    effects.listSettledPrepares = () => [{ num: '4501', source: 'run:network', startedAt: '2026-09-29', outcome: 'wrapper-failed', evidence: { error: 'ECONNRESET' } }];
    effects.readPrepareStatus = () => ({ preparedDate: null });
    const first = await runBuildDispatchTick({ live: true, effects });
    expect(first.prepare.failures[0]).toMatchObject({ cause: 'infra-transient', retry: true });
    const next = await runBuildDispatchTick({ live: true, effects, bookkeeping: first.nextBookkeeping });
    expect(next.prepare.launched.map(r => r.num)).toContain('4501');
    expect(effects.placePrepareHold).not.toHaveBeenCalled();
  });
  it('prepare kill switch and global freeze each prevent launches', async () => {
    const effects = fixture();
    expect((await runBuildDispatchTick({ live: true, prepareEnabled: false, effects })).prepare.planned).toEqual([]);
    effects.killSwitch = () => ({ engaged: true, reason: 'test' });
    expect((await runBuildDispatchTick({ live: true, effects })).prepare.planned).toEqual([]);
    expect(effects.dispatch).not.toHaveBeenCalled();
  });
  it('unknown dispatch failure releases its claim, holds across restart and files a prevention card', async () => {
    const effects = fixture({ fail: true });
    const path = join(lockRoot, 'failures.json');
    const fileCard = vi.fn(() => ({ ok: true }));
    effects.recordPrepareFailure = input => recordPrepareFailure(input, { path, fileCard });
    effects.listPrepareFailures = () => Object.values(readFailureState(path).failures);
    effects.listHolds = () => effects.listPrepareFailures().filter(f => f.held).map(f => ({ num: f.num, reason: 'prepare-unstamped' }));
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.failures).toHaveLength(2);
    const retry = await runBuildDispatchTick({ live: true, effects, bookkeeping: tick.nextBookkeeping });
    expect(retry.prepare.planned).toEqual([]);
    expect(effects.dispatch).toHaveBeenCalledTimes(2);
    expect(fileCard).toHaveBeenCalledTimes(1);
    expect(effects.listPrepareClaims()).toEqual([]);
    expect(tick.nextBookkeeping.prepareGuards).toEqual([]);
  });
  it.each(['lane cap reached', 'not planned this tick', 'frozen', 'kill switch engaged'])('a planner refusal (%s) neither holds nor files a card and retries next tick', async (reason) => {
    const effects = fixture();
    effects.dispatch = vi.fn(({ num }) => cliDispatch({ num, launchKind: 'prepare-item' }, {
      exec: () => JSON.stringify({ run: { verdict: { dispatching: false, reason } } }),
    }));
    effects.recordPrepareFailure = vi.fn();
    effects.placePrepareHold = vi.fn();
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.failures).toEqual(['4501', '4502'].map(num => expect.objectContaining({ num, stage: 'dispatch-refused', reason, retry: true })));
    expect(effects.recordPrepareFailure).not.toHaveBeenCalled();
    expect(effects.placePrepareHold).not.toHaveBeenCalled();
    expect(tick.prepare.held).toEqual([]);
    expect(effects.listPrepareClaims()).toEqual([]);
  });
  it('bounds repeated transient stamp-spawn failures across ticks', async () => {
    const effects = fixture();
    const path = join(lockRoot, 'failures.json');
    effects.recordPrepareFailure = input => recordPrepareFailure(input, { path, fileCard: vi.fn(() => ({ ok: true })) });
    const outcomes = [];
    for (let i = 0; i < 4; i++) {
      const before = Object.keys(readFailureState(path).failures).length;
      const failure = await (async () => {
        const rec = await effects.recordPrepareFailure({ num: '4501', stage: 'stamp', attempt: `t${i}`, evidence: { error: 'ECONNRESET' } });
        return rec;
      })();
      outcomes.push({ retry: failure.retry, grew: Object.keys(readFailureState(path).failures).length > before });
    }
    expect(outcomes.filter(o => o.retry).length).toBeLessThan(4);
    expect(outcomes.at(-1).retry).toBe(false);
  });
  it('a stamp-spawn error without a terminal attempt gets a fresh attempt id each tick', async () => {
    const effects = fixture();
    claimed(effects);
    effects.readPrepareStatus = () => ({ preparedDate: null, hasSections: true });
    effects.stampPrepare = vi.fn(() => { throw new Error('ECONNRESET'); });
    const recordFn = vi.fn(async input => ({ ...input, cause: 'infra-transient', retry: true, held: false }));
    effects.recordPrepareFailure = recordFn;
    await runBuildDispatchTick({ live: true, effects });
    const attempt = recordFn.mock.calls[0][0].attempt;
    expect(attempt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it.each(['failed', 'in-flight'])('does not mistake a positive plan for a launch after a %s effect error', async (status) => {
    const effects = fixture();
    const reason = 'dispatch-lane: refusing to start an agent without a resolvable --model';
    effects.dispatch = vi.fn(({ num }) => cliDispatch({ num, launchKind: 'prepare-item' }, {
      exec: () => JSON.stringify({ run: {
        findings: { read: { dispatching: true } }, verdict: { dispatching: true },
        effects: [{ type: 'conveyor.dispatch-delivery-agent', status, handle: null, error: reason }],
      } }),
    }));
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.failures).toEqual(['4501', '4502'].map(num => expect.objectContaining({ num, stage: 'dispatch', reason, cause: 'unknown', retry: false })));
    expect(tick.prepare.launched).toEqual([]);
    expect(tick.prepare.inFlight).toEqual([]);
    expect(effects.listPrepareClaims()).toEqual([]);
    expect(tick.nextBookkeeping.prepareGuards).toEqual([]);
  });
  it.each([true, false, null])('uses Claude worker liveness (%s), independently of the live daemon owner', async (live) => {
    const effects = fixture({ inFlight: [{ num: '4501', row: { runId: 'run', entry: {
      key: 'dispatch:0:0', status: 'in-flight', handle: '9f40139a', live, expectedBy: '2026-01-01T00:00:00Z',
    } } }] });
    claimed(effects, '4501', { alive: true });
    effects.settlePrepareRow = vi.fn();
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.inFlight.includes('4501')).toBe(live !== false);
    expect(tick.prepare.retired).toHaveLength(live === false ? 1 : 0);
  });
  it.each([
    { live: false, deadline: -1, lastSeen: 1, retired: true },
    { live: false, deadline: 60, lastSeen: 21, retired: true },
    { live: false, deadline: 60, lastSeen: 5, retired: false },
    { live: true, deadline: -1, lastSeen: 30, retired: false },
    { live: null, deadline: -1, lastSeen: 30, retired: false },
  ])('retires only confirmed dead sessions beyond a deadline or grace: %j', async ({ live, deadline, lastSeen, retired }) => {
    const now = Date.now();
    const entry = { key: 'dispatch:0:0', live, handle: 'worker-session',
      expectedBy: new Date(now + deadline * 60_000).toISOString(),
      lastSeenLiveAt: new Date(now - lastSeen * 60_000).toISOString() };
    const effects = fixture({ inFlight: [{ num: '4501', row: { runId: 'run', entry } }] });
    claimed(effects, '4501', { alive: true });
    effects.now = () => now;
    effects.settlePrepareRow = vi.fn();
    const bookkeeping = { itemPrepareAttempts: { '4501': 1 },
      prepareGuards: [{ num: '4501', kind: 'prepare-item', spawnedTick: 0 }] };
    const tick = await runBuildDispatchTick({ live: true, effects, bookkeeping });
    expect(tick.prepare.inFlight.includes('4501')).toBe(!retired);
    expect(effects.listPrepareClaims().some(c => c.meta.num === '4501')).toBe(!retired);
    expect(tick.nextBookkeeping.prepareGuards.some(g => g.num === '4501')).toBe(!retired);
    if (retired) {
      expect(tick.prepare.failures).toContainEqual({ num: '4501', stage: 'retirement', reason: 'prepare-session-dead' });
      expect(effects.settlePrepareRow).toHaveBeenCalledWith({ runId: 'run', key: entry.key, outcome: 'prepare-session-dead' });
      expect(tick.nextBookkeeping.itemPrepareAttempts['4501']).toBe(2);
      expect(effects.placePrepareHold).not.toHaveBeenCalled();
      expect(effects.dispatch.mock.calls.some(([r]) => r.num === '4501')).toBe(false);
      effects.listPrepareInFlight = () => [];
      effects.listSettledPrepares = () => [{ num: '4501', outcome: 'prepare-session-dead', startedAt: new Date(now).toISOString() }];
      const next = await runBuildDispatchTick({ live: true, effects, bookkeeping: tick.nextBookkeeping });
      expect(next.prepare.launched.some(r => r.num === '4501')).toBe(true);
      expect(effects.placePrepareHold).not.toHaveBeenCalled();
    } else expect(effects.settlePrepareRow).not.toHaveBeenCalled();
  });
  it.each([
    ['sections on disk', { preparedDate: null, hasSections: true }],
    ['an open unstamped PR with sections', { preparedDate: null, pr: { state: 'OPEN', preparedDate: null, hasSections: true } }],
  ])('a dead session with %s recovers the stamp instead of retiring as session-dead', async (_n, status) => {
    const now = Date.now();
    const effects = fixture({ inFlight: [{ num: '4501', row: { runId: 'run', entry: {
      key: 'dispatch:0:0', live: false, handle: 'worker-session',
      expectedBy: new Date(now - 60_000).toISOString(), lastSeenLiveAt: new Date(now - 30 * 60_000).toISOString() } } }] });
    claimed(effects, '4501', { alive: true });
    effects.now = () => now;
    effects.settlePrepareRow = vi.fn();
    effects.readPrepareStatus = () => status;
    effects.stampPrepare = vi.fn(() => ({ spawned: true }));
    const bookkeeping = { itemPrepareAttempts: { '4501': 1 } };
    const tick = await runBuildDispatchTick({ live: true, effects, bookkeeping });
    expect(effects.placePrepareHold).toHaveBeenCalledWith({ num: '4501', reason: 'prepare-stamp-pending' });
    expect(effects.stampPrepare).toHaveBeenCalledWith(expect.objectContaining({ num: '4501' }));
    expect(tick.prepare.failures.some((f) => f.reason === 'prepare-session-dead')).toBe(false);
    expect(tick.nextBookkeeping.itemPrepareAttempts?.['4501'] ?? 1).toBe(1);
  });
  it.each([
    ['explicitly dead session, no timing fields', { live: false }, true],
    ['explicitly dead session, invalid timing fields', { live: false, expectedBy: 'nope', lastSeenLiveAt: 'nope' }, true],
    ['crashed pid worker that last reported live', { live: true, handle: 'pid:999999' }, true],
    ['live session with no timing fields', { live: true }, false],
  ])('an expired claim with a %s is retired by the TTL fallback: %#', async (_n, extra, retired) => {
    const effects = fixture({ inFlight: [{ num: '4501', row: { runId: 'run', entry: {
      key: 'dispatch:0:0', handle: 'worker-session', ...extra } } }] });
    claimed(effects, '4501', { alive: true });
    effects.isPidAlive = () => false;
    effects.settlePrepareRow = vi.fn();
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.prepare.retired).toHaveLength(retired ? 1 : 0);
  });
  it('keeps probation-only instructions out of the actual standalone prepare brief', async () => {
    const root = resolve(fileURLToPath(import.meta.url), '../../../..');
    const agent = readFileSync(join(root, 'skills-src/conveyor/prepare-item-agent-brief.md'), 'utf8');
    const { realIo } = await import('../../../scripts/operations/probation-build-run.mjs');
    const worker = realIo({ session: 'brief-test', repoRoot: root }).readPrepareBrief(root);
    expect(agent).not.toMatch(/Probation worker mode|The runner owns|Do not claim, resolve, acquire another lane/);
    expect(agent).toContain('node scripts/backlog.mjs prepare-stamp');
    expect(agent).toContain('node scripts/operations/run.mjs open-pr');
    expect(worker).toContain('The runner owns stamping');
    expect(worker).not.toContain('## The arc');
  });
  it('consumes the current tick-core spawnPrepareItems field', async () => {
    const effects = fixture();
    const plan = effects.planTick;
    effects.planTick = (bk) => {
      const out = plan(bk);
      out.decisions.spawnPrepareItems = out.decisions.itemPrepareSpawns;
      delete out.decisions.itemPrepareSpawns;
      return out;
    };
    expect((await runBuildDispatchTick({ live: true, effects })).prepare.launched).toHaveLength(2);
  });
  it('dispatch re-read admits the planned prepare under the same lane cap, without spawning', async () => {
    const { cliDispatch } = await import('../build-dispatch-daemon.mjs');
    const { planTick } = await import('../../../scripts/conveyor/tick-core.mjs');
    const { readTick } = await import('../../../scripts/operations/dispatch-lane-io.mjs');
    const { shapeDispatchRead } = await import('../../../scripts/operations/dispatch-lane.mjs');
    const fixtureTick = (maxConcurrentLanes) => planTick({
      state: { queue: [], lanes: [{ lane: 1, scope: ['we:src/b/'] }], prs: [] },
      plan: { launch: [], held: [{ num: '4501', reason: 'needs-prepare' }] },
      freeLanes: [2], config: { maxConcurrentLanes },
    });
    const assess = (tick) => shapeDispatchRead(readTick({
      num: '4501', runNode: () => JSON.stringify(tick),
      loadItems: () => [{ num: '4501', slug: 'prepare-regression', kind: 'story', size: 3, scope: ['we:src/a/'] }],
      listInFlightDispatches: () => ({ runs: [], unreadable: 0 }), listAgents: () => [],
      checkAlreadyDone: () => ({ done: false, pr: null, checked: true }),
      readScorecards: () => [], readDeliveryAgentOverride: () => null,
    }), { num: '4501' });
    expect(assess(fixtureTick(1)).holdReason).toBe('the build planner held this item: needs-prepare');
    const result = cliDispatch({ num: '4501', launchKind: 'prepare-item', bookkeeping: {} }, {
      exec: (_cmd, _argv, opts) => {
        const tick = fixtureTick(Number(opts.env[MAX_CONCURRENT_LANES_ENV] ?? 1));
        const read = assess(tick);
        expect(read.launchKind).toBe('prepare-item');
        expect(read.dispatching).toBe(true);
        return JSON.stringify({ verdict: read, effects: [{ type: 'conveyor.dispatch-delivery-agent', status: 'in-flight', handle: 'session-4501' }] });
      },
    });
    expect(result.dispatching).toBe(true);
  });

  it('dispatch shell leaves model selection to the shared policy resolver', async () => {
    const { cliDispatch } = await import('../build-dispatch-daemon.mjs');
    const exec = vi.fn(() => JSON.stringify({ dispatching: true }));
    cliDispatch({ num: '4501', launchKind: 'prepare-item', bookkeeping: {} }, { exec });
    const [, argv, opts] = exec.mock.calls[0];
    expect(argv).toContain('dispatch-lane');
    expect(opts.env[MAX_CONCURRENT_LANES_ENV]).toBe(BUILD_DAEMON_LANE_CAP_EXEMPT_VALUE);
    expect(argv.some(arg => arg.startsWith('--modelReason='))).toBe(false);
    expect(opts.env.WE_DISPATCH_AGENT_ARGS).toBe(process.env.WE_DISPATCH_AGENT_ARGS);
  });
  it('boots with an unknown flag and exits 2 with usage', () => {
    try {
      execFileSync(process.execPath, [resolve('skills-src/conveyor/build-dispatch-daemon.mjs'), '--bogus-flag'], { encoding: 'utf8', stdio: 'pipe' });
      throw new Error('expected exit 2');
    } catch (e) {
      expect(e.status).toBe(2);
      expect(e.stderr).toContain('usage: build-dispatch-daemon.mjs');
    }
  });
});


describe('executor prediction and independent caps (#4531)', () => {
  it('sets caps independently by flags or env; the legacy flag stays Claude-only', () => {
    expect(policyFrom({}, {})).toMatchObject({ maxConcurrentBuilds: 1, maxConcurrentExternalBuilds: 4 });
    expect(policyFrom({ 'max-concurrent': '2' }, {})).toMatchObject({ maxConcurrentBuilds: 2, maxConcurrentExternalBuilds: 4 });
    expect(policyFrom({ 'max-concurrent': '2', 'max-concurrent-external': '6' }, {})).toMatchObject({ maxConcurrentBuilds: 2, maxConcurrentExternalBuilds: 6 });
    const env = { WE_BUILD_DAEMON_MAX_CONCURRENT: '3', WE_BUILD_DAEMON_MAX_CONCURRENT_EXTERNAL: '8' };
    expect(policyFrom({}, env)).toMatchObject({ maxConcurrentBuilds: 3, maxConcurrentExternalBuilds: 8 });
    expect(policyFrom({ 'max-concurrent': '0', 'max-concurrent-external': '0' }, env)).toMatchObject({ maxConcurrentBuilds: 0, maxConcurrentExternalBuilds: 0 });
  });
  it('predicts a real probation route and admits it while the Claude cap is full', async () => {
    const root = mkdtempSync(join(tmpdir(), '4531-routing-'));
    try {
      mkdirSync(join(root, 'backlog'));
      const item = { num: '3827', slug: 'docs', size: 1, scope: ['we:docs/guide.md'], tags: [] };
      const options = { root, env: { WE_PROBATION_LAUNCH: 'on' }, loadItems: () => [item], scorecards: [], sizePolicy: {}, promotions: {} };
      const predicted = await cliPredictRoute(item.num, item.scope, options);
      expect(predicted.error).toBeUndefined();
      expect(['codex', 'antigravity']).toContain(predicted.executor);
      const dispatches = [];
      const effects = effectsFor({ lockRoot: join(root, 'claims'), pid: 1234, dispatches, runStoreInFlight: [{ num: '9000', scope: ['we:unrelated'], executor: 'claude' }] });
      effects.predictRoute = (num, scope) => cliPredictRoute(num, scope, options);
      const result = await runBuildDispatchTick({ live: true, effects });
      expect(result.dispatched.map(d => d.num)).toEqual(['3827']);
      expect(result.plan.dispatch[0].executor).toBe(predicted.executor);
      expect(result.plan.hold.find(h => h.num === '2662')).toBeDefined();
      expect((await cliPredictRoute(item.num, item.scope, { ...options, env: { WE_PROBATION_LAUNCH: 'off' } })).executor).toBe('codex');
      expect((await cliPredictRoute(item.num, item.scope, { ...options, loadItems: () => [{ ...item, scope: ['we:scripts/lib/provider-routing.mjs'] }] })).executor).toBe('claude');
      writeFileSync(join(root, 'backlog', '3827-docs.md'), '---\ndeliveryAgent: codex\ndeliveryAgentReason: operator selection\n---\n');
      expect((await cliPredictRoute(item.num, item.scope, options)).executor).toBe('codex');
      expect((await cliPredictRoute(item.num, item.scope, { ...options, env: { WE_PROBATION_LAUNCH: 'off', WE_BUILD_DISPATCH_MODE: 'agent' } })).executor).toBe('codex');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('boots as a real Node CLI and rejects --bogus-flag with exit 2', () => {
    try {
      execFileSync(process.execPath, ['skills-src/conveyor/build-dispatch-daemon.mjs', '--bogus-flag'], { encoding: 'utf8', stdio: 'pipe' });
      throw new Error('CLI unexpectedly succeeded');
    } catch (error) {
      expect(error.status).toBe(2);
      expect(error.stderr).toContain('usage:');
    }
  });
});


describe('probation prepare route circuit breaker', () => {
  const row = (item, launchOutcome = 'gate-red', pr = null) => ({
    item, scoredAt: `2026-09-30T03:${item}:00Z`, dispatchKind: 'probation-launch',
    taskType: 'prepare', repo: 'web-everything/web-everything', launchOutcome, pr,
  });
  it('requires fix citations to reopen after two failures, even after a later success', () => {
    const failed = [row('22'), row('25', 'escalated-needs-human')];
    expect(prepareRouteFallback(failed.slice(0, 1))).toBe(false);
    expect(prepareRouteFallback(failed)).toBe(true);
    const releases = failed.map(r => ({ target: 'route:prepare', attempt: `${r.handle}:${r.scoredAt}` }));
    expect(prepareRouteFallback(failed, releases.slice(0, 1))).toBe(true);
    expect(prepareRouteFallback(failed, releases)).toBe(false);
    expect(prepareRouteFallback([...failed, { ...row('26'), taskType: 'doc-fix' }])).toBe(true);
    expect(prepareRouteFallback([failed[0], row('24', 'opened-pr', 99), failed[1]])).toBe(true);
    expect(prepareRouteFallback([...failed, row('26', 'opened-pr', 99)])).toBe(true);
  });
  it('disables probation only for fallback prepares without overriding the policy model', () => {
    for (const launchKind of ['prepare-item', 'build']) {
      const exec = vi.fn(() => '{}');
      cliDispatch({ num: '4327', launchKind, prepareFallback: true }, { exec });
      const env = exec.mock.calls[0][2].env;
      if (launchKind === 'prepare-item') {
        expect(env.WE_PROBATION_LAUNCH).toBe('off');
        expect(env.WE_DISPATCH_AGENT_ARGS).toBe(process.env.WE_DISPATCH_AGENT_ARGS);
      } else expect(env.WE_PROBATION_LAUNCH).toBe(process.env.WE_PROBATION_LAUNCH);
    }
  });
});


describe('gatePausedTicks', () => {
  const loadGate = () => import('../build-dispatch-daemon.mjs');

  it('checks the kill switch first and skips the tick with its reason', async () => {
    const { gatePausedTicks } = await loadGate();
    const tickOnce = vi.fn();
    const killSwitch = vi.fn(() => ({ engaged: true, reason: 'operator pause' }));
    const tick = gatePausedTicks({ tickOnce, killSwitch, env: {} });
    expect(await tick()).toEqual({ skipped: true, reason: 'paused (operator pause)' });
    expect(killSwitch).toHaveBeenCalledTimes(1);
    expect(tickOnce).not.toHaveBeenCalled();
  });

  it('preserves full paused preparation when opted in', async () => {
    const { gatePausedTicks, PAUSED_PREP_ENV } = await loadGate();
    const tickOnce = vi.fn(async () => ({ plan: {} }));
    const tick = gatePausedTicks({ tickOnce, killSwitch: () => ({ engaged: true }), env: { [PAUSED_PREP_ENV]: '1' } });
    expect(await tick()).toEqual({ plan: {} });
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });

  it('runs an unpaused tick through the sync wrapper after checking the switch', async () => {
    const { gatePausedTicks } = await loadGate();
    const calls = [];
    const tickOnce = vi.fn(async () => { calls.push('tick'); return { plan: {} }; });
    const tick = gatePausedTicks({ tickOnce, env: {},
      killSwitch: () => { calls.push('kill'); return { engaged: false }; },
      wrapSync: (inner) => async () => { calls.push('sync'); return inner(); },
    });
    expect(await tick()).toEqual({ plan: {} });
    expect(calls).toEqual(['kill', 'sync', 'tick']);
  });

  it.each([undefined, '120000', 'invalid', '0', '-1', 'Infinity'])('throttles sync-only ticks with cadence %s', async (cadence) => {
    const { gatePausedTicks, PAUSED_SYNC_MS_ENV, DEFAULT_PAUSED_SYNC_MS } = await loadGate();
    expect(DEFAULT_PAUSED_SYNC_MS).toBe(30 * 60 * 1000);
    let time = 0;
    const tickOnce = vi.fn();
    const sync = vi.fn((inner) => inner());
    const tick = gatePausedTicks({ tickOnce, killSwitch: () => ({ engaged: true, reason: 'file' }),
      wrapSync: (inner) => () => sync(inner), now: () => time, env: { [PAUSED_SYNC_MS_ENV]: cadence },
    });
    expect(await tick()).toEqual({ skipped: true, reason: 'paused (file); clone self-synced' });
    time = 60_000;
    expect(await tick()).toEqual({ skipped: true, reason: 'paused (file)' });
    expect(sync).toHaveBeenCalledTimes(1);
    time = cadence === '120000' ? 120_000 : 31 * 60_000;
    await tick();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(tickOnce).not.toHaveBeenCalled();
  });

  it.each(['', '0', 'FALSE', 'Off'])('keeps paused preparation off for %s', async (value) => {
    const { gatePausedTicks, PAUSED_PREP_ENV } = await loadGate();
    const tickOnce = vi.fn();
    await gatePausedTicks({ tickOnce, killSwitch: () => ({ engaged: true }), env: { [PAUSED_PREP_ENV]: value } })();
    expect(tickOnce).not.toHaveBeenCalled();
  });

  it.each(['success', 'skip', 'throw'])('resets the short circuit after sync %s', async (outcome) => {
    const { gatePausedTicks } = await loadGate();
    let engaged = true;
    const tickOnce = vi.fn(async () => ({ plan: {} }));
    const skipped = { skipped: true, reason: 'sync busy' };
    const tick = gatePausedTicks({ tickOnce, env: {}, killSwitch: () => ({ engaged, reason: 'file' }),
      wrapSync: (inner) => async () => {
        if (engaged && outcome === 'throw') throw new Error('sync failed');
        if (engaged && outcome === 'skip') return skipped;
        return inner();
      },
    });
    if (outcome === 'throw') await expect(tick()).rejects.toThrow('sync failed');
    else if (outcome === 'skip') expect(await tick()).toBe(skipped);
    else await tick();
    expect(tickOnce).not.toHaveBeenCalled();
    engaged = false;
    expect(await tick()).toEqual({ plan: {} });
    expect(tickOnce).toHaveBeenCalledTimes(1);
  });
});

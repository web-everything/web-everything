/**
 * @file scripts/conveyor/__tests__/tick-core.test.mjs
 * @description Unit proof of the MECHANIZED CONVEYOR TICK CORE (WE #2699, epic #2677(a)). Drives the pure
 *   {@link ../tick-core.mjs} functions directly with plain objects (NO git/network) and PINS every guard rule
 *   the /conveyor SKILL previously ran in prose, so a future refactor cannot silently change a guard's semantics:
 *
 *   • the IN-FLIGHT DISPATCH (build) guard — a launch is dropped when its `num` OR its `lane` matches a live
 *     entry; retirement on claim / Agent-return / TTL;
 *   • the DIFFERENT PREPARE guard — keyed by `num`, the union re-dispatch gate, retirement ONLY on
 *     scope-committed / PR-terminal / TTL-to-first-PR and NEVER on Agent-return;
 *   • the FIX guard — the in-flight entry vs. the surviving attempt counter, the in-flight test, the retry cap
 *     that binds across bounce cycles, entry retirement, and counter-clear-on-terminal;
 *   • WATCHER ARMING (one per conveyor-launched open PR), IDLE-STOP, the exit-code router, and the whole
 *     {@link planTick} composition — including the free-lane exclusion shared across builds and prepares.
 */
import { describe, it, expect } from 'vitest';
import {
  retireBuildGuards,
  filterLaunches,
  retirePrepareGuards,
  planPrepareSpawns,
  planFixSpawns,
  retireFixGuards,
  clearTerminalFixAttempts,
  planCiHealSpawns,
  retireCiHealGuards,
  clearTerminalCiHealAttempts,
  armWatchers,
  releaseSessionForNum,
  assessIdleStop,
  routeWatcherExit,
  buildStatusLine,
  computeTickCounts,
  planTick,
  HELD_NOTE_EXCLUDED_REASONS,
  durableBuildNums,
  DEFAULT_BUILD_TTL_TICKS,
  DEFAULT_PREPARE_TTL_TICKS,
  DEFAULT_PREPARE_ITEM_TTL_TICKS,
  DEFAULT_PREPARE_ITEM_RETRY_CAP,
  DEFAULT_FIX_RETRY_CAP,
  DEFAULT_CI_HEAL_RETRY_CAP,
  advanceHeldStall,
  DEFAULT_STALL_TICKS,
  buildDecisionTrace,
  lanePoolListArgsForRepo,
  reuseFailedLanePoolRead,
} from '../tick-core.mjs';
import { HELD_REASONS } from '../../readiness/dispatch-plan.mjs';
import { sessionSlugFor } from '../../operations/dispatch-lane.mjs';
import { repoProfile } from '../../lib/repo-profile.mjs';

// ── The in-flight dispatch (build) guard — filter by num OR lane ──────────────────────────────────────────────

describe('filterLaunches — the in-flight dispatch guard drops by num OR by lane', () => {
  it('passes a launch with neither num nor lane guarded', () => {
    const { spawn, suppressed } = filterLaunches([{ num: 10, lane: 4 }], []);
    expect(spawn).toEqual([{ num: 10, lane: 4 }]);
    expect(suppressed).toEqual([]);
  });

  it('drops a launch whose NUM matches a live guard (the item is already dispatching)', () => {
    const { spawn, suppressed } = filterLaunches([{ num: 10, lane: 5 }], [{ num: 10, lane: 4 }]);
    expect(spawn).toEqual([]);
    expect(suppressed).toEqual([{ num: 10, lane: 5, by: 'num' }]);
  });

  it('drops a launch whose LANE matches a live guard even when the num differs (the lane is the contended resource)', () => {
    // The core hazard the OR-guard closes: tick N launched {num:100,lane:4}; it is slow to acquire; tick N+1
    // re-assigns lane 4 to a different top-of-queue num — must NOT start a second agent on lane 4.
    const { spawn, suppressed } = filterLaunches([{ num: 200, lane: 4 }], [{ num: 100, lane: 4 }]);
    expect(spawn).toEqual([]);
    expect(suppressed).toEqual([{ num: 200, lane: 4, by: 'lane' }]);
  });

  it('normalizes ids so a padded/`#`-sigil num still matches its guard', () => {
    const { spawn } = filterLaunches([{ num: '#010', lane: 9 }], [{ num: 10, lane: 4 }]);
    expect(spawn).toEqual([]);
  });
});

describe('durableBuildNums — #3403 the restart-surviving build-guard floor', () => {
  it('extracts a num from a live BUILD session name', () => {
    expect(durableBuildNums([{ name: 'conveyor-77' }])).toEqual(['77']);
  });

  it('accepts plain name strings, not only session objects', () => {
    expect(durableBuildNums(['conveyor-77'])).toEqual(['77']);
  });

  it('normalizes a padded/`#`-sigil-free numeric id the same way the guard does', () => {
    expect(durableBuildNums([{ name: 'conveyor-077' }])).toEqual(['77']);
  });

  it('reads a retry-attempt tag (#3110, e.g. conveyor-77b) as the same num', () => {
    expect(durableBuildNums([{ name: 'conveyor-77b' }])).toEqual(['77']);
  });

  it('excludes fix / prepare / prepare-decision / ci-heal sessions — only BUILD counts', () => {
    expect(durableBuildNums([
      { name: 'fix-77' }, { name: 'prepare-77' }, { name: 'prepare-decision-77' }, { name: 'ci-heal-77' },
    ])).toEqual([]);
  });

  it('ignores unnamed / unrelated sessions and a non-array input', () => {
    expect(durableBuildNums([{ name: 'some-other-thing' }, {}, { name: null }])).toEqual([]);
    expect(durableBuildNums(undefined)).toEqual([]);
    expect(durableBuildNums(null)).toEqual([]);
  });

  it('agrees with sessionSlugFor(num, "build") — the two must never name a build session differently (#3403)', () => {
    expect(durableBuildNums([{ name: sessionSlugFor(77, 'build') }])).toEqual(['77']);
    expect(durableBuildNums([{ name: sessionSlugFor(77, 'build', 'b') }])).toEqual(['77']);
    // Every OTHER kind's slug must stay excluded, cross-checked against the real function, not a copy of it.
    for (const kind of ['prepare', 'prepare-decision', 'fix', 'ci-heal']) {
      expect(durableBuildNums([{ name: sessionSlugFor(77, kind) }])).toEqual([]);
    }
  });

  // #3383 FOLLOW-UP (found live 2026-09-14 — a `conveyor-*` row still listed 6-13.5 DAYS after its process died,
  // `pid: null`, `state: "working"`) — a CONFIRMED-dead row must not durable-guard forever.
  describe('the pidAlive === false exclusion (#3383)', () => {
    it('a row explicitly confirmed dead (pidAlive: false) is EXCLUDED from the durable floor', () => {
      expect(durableBuildNums([{ name: 'conveyor-77', pidAlive: false }])).toEqual([]);
    });
    it('a row confirmed ALIVE (pidAlive: true) is still counted — unchanged', () => {
      expect(durableBuildNums([{ name: 'conveyor-77', pidAlive: true }])).toEqual(['77']);
    });
    it('a row with no `pidAlive` field at all (every pre-#3383 caller/test) is still counted — byte-identical to before', () => {
      expect(durableBuildNums([{ name: 'conveyor-77' }])).toEqual(['77']);
    });
    it('a row with `pidAlive: null` (probed, unknown) is still counted — unknown never guesses at death', () => {
      expect(durableBuildNums([{ name: 'conveyor-77', pidAlive: null }])).toEqual(['77']);
    });
    it('a plain name STRING (no object, so no pidAlive is even possible) is still counted — unchanged', () => {
      expect(durableBuildNums(['conveyor-77'])).toEqual(['77']);
    });
    it('one dead row among several live ones excludes only the dead one', () => {
      expect(durableBuildNums([
        { name: 'conveyor-10', pidAlive: false },
        { name: 'conveyor-20', pidAlive: true },
        { name: 'conveyor-30' },
      ]).sort()).toEqual(['20', '30']);
    });
  });
});

describe('retireBuildGuards — claim / Agent-return / TTL (SKILL §2, three ways)', () => {
  it('retires on CLAIM when the guard lane shows leased in state.lanes', () => {
    const { live, retired } = retireBuildGuards([{ num: 10, lane: 4, spawnedTick: 0 }], {
      lanes: [{ lane: 4, num: 10 }], queue: [{ num: 10, buildQueued: true }], tick: 1,
    });
    expect(live).toEqual([]);
    expect(retired).toEqual([{ num: 10, lane: 4, reason: 'claimed' }]);
  });

  it('retires on CLAIM when the item has left the cleared build queue', () => {
    const { live, retired } = retireBuildGuards([{ num: 10, lane: 4, spawnedTick: 0 }], {
      lanes: [], queue: [], tick: 1, // 10 no longer a buildQueued row → claimed/active
    });
    expect(live).toEqual([]);
    expect(retired[0].reason).toBe('claimed');
  });

  it('retires on Agent-RETURN via signals.returnedBuildNums (still queued, lane not yet leased)', () => {
    const { live, retired } = retireBuildGuards([{ num: 10, lane: 4, spawnedTick: 0 }], {
      lanes: [], queue: [{ num: 10, buildQueued: true }], tick: 1, returnedBuildNums: [10],
    });
    expect(live).toEqual([]);
    expect(retired[0].reason).toBe('returned');
  });

  it('retires on TTL after the default (3) ticks with the item never claimed — surfaced as a note', () => {
    const guard = [{ num: 10, lane: 4, spawnedTick: 0 }];
    const ctx = { lanes: [], queue: [{ num: 10, buildQueued: true }], tick: DEFAULT_BUILD_TTL_TICKS - 1 };
    expect(retireBuildGuards(guard, ctx).live).toHaveLength(1); // not yet
    const at = retireBuildGuards(guard, { ...ctx, tick: DEFAULT_BUILD_TTL_TICKS });
    expect(at.live).toEqual([]);
    expect(at.retired[0]).toMatchObject({ num: 10, reason: 'ttl', note: true });
  });
});

// ── The DIFFERENT prepare guard ───────────────────────────────────────────────────────────────────────────────

describe('retirePrepareGuards — NEVER on Agent-return; scope-committed / PR-terminal / TTL-to-first-PR only', () => {
  it('retains a LIVE prepare-item guard while the item is still held needs-prepare, retires once cleared (#4504)', () => {
    const pg = [{ num: 50, kind: 'prepare-item', lane: 9 }];
    expect(retirePrepareGuards(pg, { needsPrepare: [{ num: 50 }], prs: [], tick: 1 }).live).toHaveLength(1);
    const done = retirePrepareGuards(pg, { needsPrepare: [], prs: [], tick: 1 });
    expect(done.retired[0]).toMatchObject({ num: 50, reason: 'scope-committed' });
  });

  const guard = () => [{ num: 20, kind: 'prepare', lane: 5, spawnedTick: 0, sawPr: false }];

  it('stays LIVE while the item is still unshaped and no PR has appeared (a slow but healthy prepare)', () => {
    const { live, retired } = retirePrepareGuards(guard(), { unshaped: [{ num: 20 }], prs: [], tick: 2 });
    expect(retired).toEqual([]);
    expect(live).toHaveLength(1);
  });

  it('does NOT retire on Agent-return — there is no return path in the prepare guard at all', () => {
    // The build guard would retire on return; the prepare guard has no such input. Even with the item still
    // unshaped and no PR, the entry must persist (returning at PR-open is several ticks before merge).
    const { live } = retirePrepareGuards(guard(), { unshaped: [{ num: 20 }], prs: [], tick: 1 });
    expect(live).toHaveLength(1);
  });

  it('retires SCOPE-COMMITTED once the item leaves state.unshaped (its scope landed)', () => {
    const { live, retired } = retirePrepareGuards(guard(), { unshaped: [], prs: [], tick: 1 });
    expect(live).toEqual([]);
    expect(retired[0]).toMatchObject({ num: 20, reason: 'scope-committed' });
  });

  it('TTL fires ONLY while no PR ever appeared — a slow-but-live prepare past the TTL with an OPEN PR is void, not re-dispatched', () => {
    const late = DEFAULT_PREPARE_TTL_TICKS + 2;
    // No PR ever → TTL fires (died pre-PR).
    const died = retirePrepareGuards(guard(), { unshaped: [{ num: 20 }], prs: [], tick: late });
    expect(died.retired[0]).toMatchObject({ reason: 'ttl', note: true });
    // Open PR exists → TTL is VOID; the entry stays live even well past the TTL.
    const alive = retirePrepareGuards(guard(), {
      unshaped: [{ num: 20 }], prs: [{ num: 20, prNumber: 99, state: 'OPEN', labels: [] }], tick: late,
    });
    expect(alive.retired).toEqual([]);
    expect(alive.live[0].sawPr).toBe(true); // sticky flip persisted
  });

  it('retires PR-TERMINAL once a seen PR leaves the open set (sawPr sticky → terminal, not a false TTL)', () => {
    const seen = [{ num: 20, kind: 'prepare', lane: 5, spawnedTick: 0, sawPr: true }];
    const { live, retired } = retirePrepareGuards(seen, { unshaped: [{ num: 20 }], prs: [], tick: 3 });
    expect(live).toEqual([]);
    expect(retired[0]).toMatchObject({ num: 20, reason: 'pr-terminal' });
  });

  it('a prepare-decision guard keys retirement on the UNPREPARED decision set, not unshaped', () => {
    const dg = [{ num: 30, kind: 'prepare-decision', lane: 6, spawnedTick: 0, sawPr: false }];
    // still unprepared → live
    expect(retirePrepareGuards(dg, { decisions: [{ num: 30, prepared: false }], prs: [], tick: 1 }).live).toHaveLength(1);
    // preparedDate landed (prepared:true) → scope-committed (left the pending set)
    const done = retirePrepareGuards(dg, { decisions: [{ num: 30, prepared: true }], prs: [], tick: 1 });
    expect(done.retired[0]).toMatchObject({ num: 30, reason: 'scope-committed' });
  });

  it('a prepare-item guard gets its OWN, longer TTL — a full prepare pass outlives the 5-tick scope-prepare TTL (#4504 advisory)', () => {
    expect(DEFAULT_PREPARE_ITEM_TTL_TICKS).toBeGreaterThan(DEFAULT_PREPARE_TTL_TICKS);
    const g = [
      { num: 50, kind: 'prepare-item', lane: 4, spawnedTick: 0, sawPr: false },
      { num: 51, kind: 'prepare', lane: 5, spawnedTick: 0, sawPr: false },
    ];
    const ctx = { unshaped: [{ num: 51 }], needsPrepare: [{ num: 50 }], prs: [] };
    // Past the scope TTL: the scope guard retires, the prepare-item guard is still inside its own budget.
    const mid = retirePrepareGuards(g, { ...ctx, tick: DEFAULT_PREPARE_TTL_TICKS });
    expect(mid.live.map((x) => x.num)).toEqual([50]);
    expect(mid.retired).toEqual([expect.objectContaining({ num: 51, reason: 'ttl' })]);
    // Past its own TTL, it retires too.
    const late = retirePrepareGuards(g, { ...ctx, tick: DEFAULT_PREPARE_ITEM_TTL_TICKS });
    expect(late.retired).toEqual(expect.arrayContaining([expect.objectContaining({ num: 50, kind: 'prepare-item', reason: 'ttl' })]));
  });

  it('an investigate guard keys retirement on the STILL-HELD-needs-investigation set (#3567) — no prepared flag to wait on', () => {
    const ig = [{ num: 40, kind: 'investigate', lane: 8, spawnedTick: 0, sawPr: false }];
    // still held needs-investigation this tick → live
    expect(retirePrepareGuards(ig, { investigations: [{ num: 40 }], prs: [], tick: 1 }).live).toHaveLength(1);
    // no longer held (the item resolved — either terminal shape) → scope-committed
    const done = retirePrepareGuards(ig, { investigations: [], prs: [], tick: 1 });
    expect(done.retired[0]).toMatchObject({ num: 40, reason: 'scope-committed' });
  });
});

it('full tick drops held guards before lane allocation and advances past held queue leaders', () => {
  const result = planTick({ state: { queue: [], lanes: [], prs: [] },
    plan: { launch: [], held: [1, 2, 3, 4].map((num) => ({ num, reason: 'needs-prepare' })) },
    freeLanes: [7, 8], bookkeeping: { tick: 1, prepareHeldNums: ['1', '2'],
      prepareGuards: [1, 2].map((num, i) => ({ num, kind: 'prepare-item', lane: 7 + i, spawnedTick: 0 })) },
    config: { maxConcurrentLanes: 10 },
  });
  expect(result.decisions.spawnPrepareItems.map((s) => s.num)).toEqual([3, 4]);
  expect(result.nextState.prepareGuards.map((s) => s.num)).toEqual([3, 4]);
});

it('held prepares consume neither guards, proposed slots nor lanes', () => {
  const result = planPrepareSpawns({
    needsPrepare: [1, 2, 3, 4].map((num) => ({ num })), prepareHeldNums: ['1', '2'],
    livePrepareGuards: [1, 2].map((num) => ({ num, kind: 'prepare-item' })),
    availableLanes: [7, 8],
  });
  expect(result.itemPrepareSpawns).toEqual([{ num: 3, lane: 7 }, { num: 4, lane: 8 }]);
});

describe('planPrepareSpawns — union re-dispatch gate + lane exclusion (SKILL §3b/§3e)', () => {
  it('spawns ONE prepare-item agent per held needs-prepare candidate (#4504)', () => {
    const r = planPrepareSpawns({ needsPrepare: [{ num: 99 }], availableLanes: [5], tick: 0 });
    expect(r.itemPrepareSpawns).toEqual([{ num: 99, lane: 5 }]);
    expect(r.newGuards[0]).toMatchObject({ num: 99, kind: 'prepare-item' });
  });

  it('SKIPS a needs-prepare candidate with a live prepare-item guard entry (in-flight) (#4504)', () => {
    const r = planPrepareSpawns({
      needsPrepare: [{ num: 99 }],
      livePrepareGuards: [{ num: 99, kind: 'prepare-item', lane: 5 }],
      availableLanes: [7],
      tick: 1,
    });
    expect(r.itemPrepareSpawns).toEqual([]);
  });

  it('CAPS concurrent prepare-item spawns at maxConcurrentItemPrepares, holding the rest with a note (#4504)', () => {
    const r = planPrepareSpawns({
      needsPrepare: [{ num: 99 }, { num: 100 }],
      availableLanes: [5, 6],
      maxConcurrentItemPrepares: 1,
      tick: 0,
    });
    expect(r.itemPrepareSpawns).toEqual([{ num: 99, lane: 5 }]);
    expect(r.notes.some((n) => n.kind === 'prepare-item-cap' && n.num === 100)).toBe(true);
  });

  it('the prepare-item cap counts already-LIVE guards too, not just this tick\'s new spawns (#4504)', () => {
    const r = planPrepareSpawns({
      needsPrepare: [{ num: 100 }],
      livePrepareGuards: [{ num: 99, kind: 'prepare-item', lane: 4 }],
      availableLanes: [5],
      maxConcurrentItemPrepares: 1,
      tick: 0,
    });
    expect(r.itemPrepareSpawns).toEqual([]);
    expect(r.notes.some((n) => n.kind === 'prepare-item-cap' && n.num === 100)).toBe(true);
  });

  it('an item ALREADY covered by a live prepare-item guard never hits the cap note, even at/over cap (#4504 review round 2)', () => {
    // #99 is already in flight (its own guard); the cap is already at its ceiling. #99 must stay a silent
    // in-flight no-op (via the union re-dispatch gate), never a spurious `prepare-item-cap` note — and a
    // genuinely NEW candidate later in the same tick must still get its fair shot at the cap, not be starved
    // because the loop mis-held the already-in-flight one first.
    const r = planPrepareSpawns({
      needsPrepare: [{ num: 99 }, { num: 100 }],
      livePrepareGuards: [{ num: 99, kind: 'prepare-item', lane: 4 }],
      availableLanes: [5],
      maxConcurrentItemPrepares: 1,
      tick: 1,
    });
    expect(r.itemPrepareSpawns).toEqual([]); // #100 IS capped (1 live + 0 new already at ceiling 1)
    expect(r.notes.some((n) => n.kind === 'prepare-item-cap' && n.num === 99)).toBe(false); // never #99
    expect(r.notes.some((n) => n.kind === 'prepare-item-cap' && n.num === 100)).toBe(true); // only the new one
  });

  it('defaults to TWO concurrent prepare-item spawns when maxConcurrentItemPrepares is omitted (#4504 advisory)', () => {
    const r = planPrepareSpawns({ needsPrepare: [{ num: 99 }, { num: 100 }, { num: 101 }], availableLanes: [5, 6, 7], tick: 0 });
    expect(r.itemPrepareSpawns).toEqual([{ num: 99, lane: 5 }, { num: 100, lane: 6 }]);
    expect(r.notes.filter((n) => n.kind === 'prepare-item-cap').map((n) => n.num)).toEqual([101]);
  });

  it('ROTATES the prepare-item cap to the least-attempted candidate, so a stuck item cannot hold a slot forever (#4504 advisory)', () => {
    // #99 already failed one attempt (TTL-retired, no PR); #100 never tried. With one slot, #100 goes first.
    const r = planPrepareSpawns({
      needsPrepare: [{ num: 99 }, { num: 100 }],
      itemPrepareAttempts: { 99: 1 },
      availableLanes: [5],
      maxConcurrentItemPrepares: 1,
      tick: 0,
    });
    expect(r.itemPrepareSpawns).toEqual([{ num: 100, lane: 5 }]);
  });

  it('stops re-dispatching a needs-prepare item once its prepare-item attempts reach the retry cap, with a note (#4504 advisory)', () => {
    const r = planPrepareSpawns({
      needsPrepare: [{ num: 99 }, { num: 100 }],
      itemPrepareAttempts: { 99: DEFAULT_PREPARE_ITEM_RETRY_CAP },
      availableLanes: [5, 6],
      tick: 0,
    });
    expect(r.itemPrepareSpawns).toEqual([{ num: 100, lane: 5 }]);
    expect(r.notes.some((n) => n.kind === 'prepare-item-retry-cap' && n.num === 99)).toBe(true);
  });

  it('spawns one prepare-scope agent per unshaped item, consuming free lanes', () => {
    const r = planPrepareSpawns({ unshaped: [{ num: 20 }, { num: 21 }], availableLanes: [5, 6], tick: 0 });
    expect(r.scopeSpawns).toEqual([{ num: 20, lane: 5 }, { num: 21, lane: 6 }]);
    expect(r.newGuards).toEqual([
      { num: 20, kind: 'prepare', lane: 5, spawnedTick: 0, sawPr: false },
      { num: 21, kind: 'prepare', lane: 6, spawnedTick: 0, sawPr: false },
    ]);
  });

  it('SKIPS an item with a live prepare-guard entry (in-flight)', () => {
    const r = planPrepareSpawns({ unshaped: [{ num: 20 }], livePrepareGuards: [{ num: 20, kind: 'prepare', lane: 5 }], availableLanes: [7], tick: 1 });
    expect(r.scopeSpawns).toEqual([]);
  });

  it('SKIPS an item that already has an OPEN PR — the union backstop when the guard is lost', () => {
    const r = planPrepareSpawns({ unshaped: [{ num: 20 }], prs: [{ num: 20, prNumber: 99, state: 'OPEN' }], availableLanes: [7], tick: 1 });
    expect(r.scopeSpawns).toEqual([]);
  });

  it('HOLDS (a note, no spawn) when no free lane remains', () => {
    const r = planPrepareSpawns({ unshaped: [{ num: 20 }], availableLanes: [], tick: 0 });
    expect(r.scopeSpawns).toEqual([]);
    expect(r.notes[0].kind).toBe('prepare-no-lane');
  });

  it('spawns a prepare-decision agent ONLY for an UNPREPARED decision', () => {
    const r = planPrepareSpawns({ decisions: [{ num: 30, prepared: false }, { num: 31, prepared: true }], availableLanes: [5, 6], tick: 0 });
    expect(r.decisionSpawns).toEqual([{ num: 30, lane: 5 }]);
    expect(r.newGuards[0].kind).toBe('prepare-decision');
  });

  it('spawns ONE investigate agent per held needs-investigation candidate, no prepared gate (#3567)', () => {
    const r = planPrepareSpawns({ investigations: [{ num: 40 }, { num: 41 }], availableLanes: [8, 9], tick: 0 });
    expect(r.investigationSpawns).toEqual([{ num: 40, lane: 8 }, { num: 41, lane: 9 }]);
    expect(r.newGuards.every((g) => g.kind === 'investigate')).toBe(true);
  });

  it('SKIPS an investigation with a live investigate-guard entry (in-flight)', () => {
    const r = planPrepareSpawns({
      investigations: [{ num: 40 }],
      livePrepareGuards: [{ num: 40, kind: 'investigate', lane: 8 }],
      availableLanes: [9],
      tick: 1,
    });
    expect(r.investigationSpawns).toEqual([]);
  });
});

// ── The fix guard — two pieces of state ───────────────────────────────────────────────────────────────────────

describe('planFixSpawns — in-flight test + retry cap across bounce cycles (SKILL §3c)', () => {
  const changesPr = (pr, num) => ({ num, prNumber: pr, state: 'OPEN', labels: ['review:changes'] });

  it('spawns a fix for a conveyor-launched review:changes PR — records an UNCLAIMED entry, does NOT bump the counter (#3454)', () => {
    // #3454: bumping here (before dispatch-lane.mjs ever runs) counted a PLANNED candidate as a real attempt,
    // even when dispatch-lane's own in-flight guard went on to refuse it pre-flight. The counter now only bumps
    // once retireFixGuards CONFIRMS the lane was actually leased (see the planTick-level tests below).
    const r = planFixSpawns({ prs: [changesPr(99, 40)], launchedNums: [40], availableLanes: [5], tick: 0 });
    expect(r.spawns).toEqual([{ pr: 99, num: 40, lane: 5 }]);
    expect(r.newGuards).toEqual([{ pr: 99, num: 40, lane: 5, spawnedTick: 0, claimed: false }]);
    expect(r.fixAttempts).toEqual({}); // unchanged — nothing bumped merely by being planned
  });

  it('does NOT fix a review:changes PR the conveyor did not launch', () => {
    const r = planFixSpawns({ prs: [changesPr(99, 40)], launchedNums: [], availableLanes: [5], tick: 0 });
    expect(r.spawns).toEqual([]);
  });

  it('SKIPS a PR with a live fix-guard ENTRY (the in-flight test stops the immediate re-arm double-dispatch)', () => {
    const r = planFixSpawns({ prs: [changesPr(99, 40)], launchedNums: [40], liveFixGuards: [{ pr: 99, num: 40 }], availableLanes: [5], tick: 1 });
    expect(r.spawns).toEqual([]);
  });

  it('the retry cap BINDS across fresh bounce cycles — a persisted counter at the cap surfaces, never re-fixes', () => {
    // A new human bounce is a fresh review:changes with NO live entry — the counter (persisted, not on the entry)
    // is what makes the cap bind. At cap (3) the PR is surfaced for /review, not auto-fixed.
    const r = planFixSpawns({ prs: [changesPr(99, 40)], launchedNums: [40], fixAttempts: { 99: DEFAULT_FIX_RETRY_CAP }, availableLanes: [5], tick: 5 });
    expect(r.spawns).toEqual([]);
    expect(r.notes[0]).toMatchObject({ kind: 'fix-exhausted', pr: 99, attempts: DEFAULT_FIX_RETRY_CAP });
    expect(r.fixAttempts[99]).toBe(DEFAULT_FIX_RETRY_CAP); // not bumped past the cap
  });

  // #2643 — the cap must SURVIVE a conveyor restart. On a fresh conveyor the in-session `fixAttempts` map is EMPTY,
  // so the cap binds only if it reads the DURABLE floor (`prRearmCounts`) derived from the PR's re-arm comments.
  it('binds the cap from the DURABLE floor alone when the in-session tally was wiped by a restart', () => {
    const r = planFixSpawns({
      prs: [changesPr(99, 40)], launchedNums: [40],
      fixAttempts: {},                         // restart wiped the session tally
      prRearmCounts: { 99: DEFAULT_FIX_RETRY_CAP }, // but the PR carries 3 durable re-arm comments
      availableLanes: [5], tick: 0,
    });
    expect(r.spawns).toEqual([]); // cap binds → no re-fix from zero
    expect(r.notes[0]).toMatchObject({ kind: 'fix-exhausted', pr: 99, attempts: DEFAULT_FIX_RETRY_CAP });
  });

  it('a spawn below the max(in-session, durable) cap still spawns, but still does not bump (bump moved to claim-time)', () => {
    // Post-restart: in-session 0, durable 2 → attempts=2 (< cap) → spawn. Re-seeding off the durable floor now
    // happens at CLAIM time in planTick (see "planTick — fix-attempt counter bumps only on a CONFIRMED claim"
    // below), not here — planFixSpawns only ever proposes a candidate.
    const r = planFixSpawns({
      prs: [changesPr(99, 40)], launchedNums: [40], fixAttempts: {}, prRearmCounts: { 99: 2 },
      availableLanes: [5], tick: 0,
    });
    expect(r.spawns).toEqual([{ pr: 99, num: 40, lane: 5 }]);
    expect(r.fixAttempts).toEqual({});
  });

  it('a died-before-rearm fix (no durable comment) still terminates via the in-session tally', () => {
    // The fix agent died before posting a re-arm comment, so the durable floor is 0; the in-session tally (which
    // bumps at spawn) is what carries it to the cap. max(3, 0) = 3 → surfaced, not re-fixed.
    const r = planFixSpawns({
      prs: [changesPr(99, 40)], launchedNums: [40], fixAttempts: { 99: DEFAULT_FIX_RETRY_CAP }, prRearmCounts: { 99: 0 },
      availableLanes: [5], tick: 9,
    });
    expect(r.spawns).toEqual([]);
    expect(r.notes[0]).toMatchObject({ kind: 'fix-exhausted', pr: 99 });
  });
});

describe('retireFixGuards + clearTerminalFixAttempts — entry vs. counter lifetimes (SKILL §3c)', () => {
  it('retires the ENTRY when the PR no longer carries review:changes (re-armed to pending) — counter untouched', () => {
    const { live, retired } = retireFixGuards([{ pr: 99, num: 40, spawnedTick: 0 }], {
      prs: [{ num: 40, prNumber: 99, state: 'OPEN', labels: ['review:pending'] }], tick: 1,
    });
    expect(live).toEqual([]);
    expect(retired[0]).toMatchObject({ pr: 99, reason: 'resolved' });
  });

  it('the attempt counter SURVIVES entry retirement and clears ONLY when the PR leaves the open set', () => {
    // Still open (re-armed) → counter kept.
    expect(clearTerminalFixAttempts({ 99: 2 }, [{ prNumber: 99, state: 'OPEN' }])).toEqual({ 99: 2 });
    // PR gone from the open list (merged/closed) → counter cleared.
    expect(clearTerminalFixAttempts({ 99: 2 }, [])).toEqual({});
  });

  // ── #3454 — claim detection: a guard only becomes a REAL attempt once its lane is observed leased ──────────

  it('a freshly-spawned (unclaimed) guard stays unclaimed while its lane is not yet leased — no newlyClaimed', () => {
    const { live, newlyClaimed } = retireFixGuards([{ pr: 99, num: 40, lane: 5, spawnedTick: 0, claimed: false }], {
      prs: [{ num: 40, prNumber: 99, state: 'OPEN', labels: ['review:changes'] }], lanes: [], tick: 1,
    });
    expect(live).toEqual([{ pr: 99, num: 40, lane: 5, spawnedTick: 0, claimed: false }]);
    expect(newlyClaimed).toEqual([]);
  });

  it('flips claimed true and reports newlyClaimed the tick state.lanes shows the guard\'s lane actually leased', () => {
    const { live, newlyClaimed } = retireFixGuards([{ pr: 99, num: 40, lane: 5, spawnedTick: 0, claimed: false }], {
      prs: [{ num: 40, prNumber: 99, state: 'OPEN', labels: ['review:changes'] }],
      lanes: [{ lane: 5, num: 40 }], // dispatch-lane.mjs got past its own guard and acquired lane 5
      tick: 1,
    });
    expect(live).toEqual([{ pr: 99, num: 40, lane: 5, spawnedTick: 0, claimed: true }]);
    expect(newlyClaimed).toEqual([{ pr: 99, num: 40 }]);
  });

  it('retires an UNCLAIMED guard on TTL as ttl-unclaimed — free re-dispatch, no attempt was ever counted (the #1861 shape)', () => {
    // This is the exact phantom-attempt shape: dispatch-lane.mjs's in-flight guard refused the dispatch
    // pre-flight (a stale `claude agents` liveness entry), so the lane it was assigned was never leased.
    const { retired, newlyClaimed } = retireFixGuards([{ pr: 1861, num: 3435, lane: 17, spawnedTick: 0, claimed: false }], {
      prs: [{ num: 3435, prNumber: 1861, state: 'OPEN', labels: ['review:changes'] }],
      lanes: [], // never leased — the guard refused before ever acquiring
      tick: 5, ttlTicks: 5,
    });
    expect(retired[0]).toMatchObject({ pr: 1861, reason: 'ttl-unclaimed', note: true, claimed: false });
    expect(newlyClaimed).toEqual([]); // never became real — nothing to bump
  });

  it('retires a CLAIMED guard on TTL as ttl (a real agent started, then went silent) — still cap-gated on re-dispatch', () => {
    // claimed:true simulates a guard whose lane was observed leased on an EARLIER tick (claimed is sticky, like
    // the prepare guard's sawPr) — the agent genuinely started, so this TTL is a real, failed attempt.
    const { retired } = retireFixGuards([{ pr: 99, num: 40, lane: 5, spawnedTick: 0, claimed: true }], {
      prs: [{ num: 40, prNumber: 99, state: 'OPEN', labels: ['review:changes'] }], lanes: [], tick: 5, ttlTicks: 5,
    });
    expect(retired[0]).toMatchObject({ pr: 99, reason: 'ttl', note: true, claimed: true });
  });
});

// ── planTick — the fix-attempt counter bumps ONLY on a CONFIRMED claim, never on a merely-planned spawn ───────
// (#3454 — the root cause of PR #1861's phantom "auto-fix exhausted": tick-core used to bump fixAttempts[pr]
// the instant a fix was PLANNED (inside planFixSpawns), before we:scripts/operations/dispatch-lane.mjs — a
// SEPARATE step outside this pure core — ever ran its OWN in-flight guard. A stale `claude agents` liveness
// entry made that guard refuse with `dispatching:false` before a lane was ever acquired, so #1861 hit the
// 3-attempt cap after exactly two PLANNED spawns and zero real dispatches, zero commits, zero second review
// round. The fix: the counter now bumps only once a lane is CONFIRMED leased (the same fact the build guard's
// CLAIMED retirement already uses), so a dispatch refused pre-flight costs nothing and is retried for free.
describe('planTick — fix-attempt counter bumps only on a CONFIRMED claim (#3454)', () => {
  const changesPr = (pr, num) => ({ num, prNumber: pr, state: 'OPEN', labels: ['review:changes'] });

  it('a fix spawn this tick does NOT bump fixAttempts — only a live, unclaimed guard is recorded', () => {
    const out = planTick({
      state: { queue: [], prs: [changesPr(99, 40)], lanes: [], needsSlice: [], decisions: [] },
      plan: { launch: [] },
      freeLanes: [5],
      bookkeeping: { tick: 0, launchedNums: [40] },
    });
    expect(out.decisions.spawnFixes).toEqual([{ pr: 99, num: 40, lane: 5 }]);
    expect(out.nextState.fixAttempts).toEqual({});
    expect(out.nextState.fixGuards).toEqual([{ pr: 99, num: 40, lane: 5, spawnedTick: 0, claimed: false }]);
  });

  it('bumps fixAttempts to 1 the tick state.lanes confirms the guard\'s lane was actually leased', () => {
    // Tick 1 continues from the guard the previous test recorded — its lane (5) now shows leased.
    const out = planTick({
      state: { queue: [], prs: [changesPr(99, 40)], lanes: [{ lane: 5, num: 40 }], needsSlice: [], decisions: [] },
      plan: { launch: [] },
      freeLanes: [],
      bookkeeping: { tick: 1, launchedNums: [40], fixGuards: [{ pr: 99, num: 40, lane: 5, spawnedTick: 0, claimed: false }], fixAttempts: {} },
    });
    expect(out.nextState.fixAttempts).toEqual({ 99: 1 });
    expect(out.nextState.fixGuards).toEqual([{ pr: 99, num: 40, lane: 5, spawnedTick: 0, claimed: true }]);
  });

  it('THE REGRESSION: 3 consecutive pre-flight-refused dispatches never trip fix-exhausted; a 4th, genuinely claimed, attempt does', () => {
    // Simulates dispatch-lane.mjs's in-flight guard refusing three times in a row (a stale `claude agents`
    // liveness entry — the exact PR #1861 shape): each cycle spawns a guard whose lane is NEVER observed
    // leased in state.lanes, so it TTLs out unclaimed and is free-re-dispatched — fixAttempts must stay 0 and
    // fix-exhausted must never fire, across all three cycles.
    const prs = [changesPr(1861, 3435)];
    let bookkeeping = { tick: 0, launchedNums: [3435] };
    for (let cycle = 0; cycle < 3; cycle += 1) {
      // Tick A: spawn (lane never leased downstream — the guard refusal).
      const spawnTick = planTick({
        state: { queue: [], prs, lanes: [], needsSlice: [], decisions: [] },
        plan: { launch: [] },
        freeLanes: [17],
        bookkeeping,
        config: { fixTtlTicks: 2 },
      });
      expect(spawnTick.decisions.notes.find((n) => n.kind === 'fix-exhausted')).toBeUndefined();
      expect(spawnTick.nextState.fixAttempts).toEqual({});
      // Tick B: TTL elapses with the lane STILL never leased (dispatch-lane.mjs never got past its guard) —
      // the entry retires ttl-unclaimed, is re-dispatchable next tick, and burns nothing.
      bookkeeping = { ...spawnTick.nextState, tick: spawnTick.nextState.tick + 2 };
      const ttlTick = planTick({
        state: { queue: [], prs, lanes: [], needsSlice: [], decisions: [] },
        plan: { launch: [] },
        freeLanes: [17],
        bookkeeping,
        config: { fixTtlTicks: 2 },
      });
      expect(ttlTick.decisions.notes.some((n) => n.kind === 'fix-ttl-unclaimed')).toBe(true);
      expect(ttlTick.decisions.notes.find((n) => n.kind === 'fix-exhausted')).toBeUndefined();
      expect(ttlTick.nextState.fixAttempts).toEqual({}); // still zero after 3 full refused cycles
      bookkeeping = ttlTick.nextState;
    }

    // A 4th cycle where the dispatch genuinely succeeds (the lane IS leased) — NOW it counts.
    const realSpawn = planTick({
      state: { queue: [], prs, lanes: [], needsSlice: [], decisions: [] },
      plan: { launch: [] },
      freeLanes: [17],
      bookkeeping,
    });
    const claimTick = planTick({
      state: { queue: [], prs, lanes: [{ lane: 17, num: 3435 }], needsSlice: [], decisions: [] },
      plan: { launch: [] },
      freeLanes: [],
      bookkeeping: { ...realSpawn.nextState, tick: realSpawn.nextState.tick + 1 },
    });
    expect(claimTick.nextState.fixAttempts).toEqual({ 1861: 1 }); // exactly one REAL attempt, not four
  });
});

// ── The CI-HEAL guard — green-at-open PR gone RED / BEHIND (SKILL §3c-ci, #2666) ──────────────────────────────────

describe('planCiHealSpawns — trigger, exclusions, in-flight test + restart-surviving retry cap (SKILL §3c-ci)', () => {
  // A conveyor PR that was GREEN AT OPEN (carries `ready-to-merge`) and has since gone RED on a required check.
  const redPr = (pr, num, labels = ['ready-to-merge']) => ({ num, prNumber: pr, state: 'OPEN', ci: 'fail', labels });

  it('spawns a CI-heal for a conveyor-launched was-green PR gone red-CI and bumps the counter', () => {
    const r = planCiHealSpawns({ prs: [redPr(99, 40)], launchedNums: [40], availableLanes: [5], tick: 0 });
    expect(r.spawns).toEqual([{ pr: 99, num: 40, lane: 5, reason: 'red-ci' }]);
    expect(r.newGuards).toEqual([{ pr: 99, num: 40, lane: 5, spawnedTick: 0 }]);
    expect(r.ciHealAttempts).toEqual({ 99: 1 });
  });

  it('does NOT heal a PR that was NEVER green at open (no ready-to-merge / review park) — the delivery agent escalated it', () => {
    const r = planCiHealSpawns({ prs: [redPr(99, 40, [])], launchedNums: [40], availableLanes: [5], tick: 0 });
    expect(r.spawns).toEqual([]);
  });

  it('does NOT heal a `review:changes` PR — the fix loop (§3c) owns it and already rebases', () => {
    const r = planCiHealSpawns({ prs: [redPr(99, 40, ['review:changes', 'ready-to-merge'])], launchedNums: [40], availableLanes: [5], tick: 0 });
    expect(r.spawns).toEqual([]);
  });

  it('does NOT heal a PR the conveyor did not launch', () => {
    const r = planCiHealSpawns({ prs: [redPr(99, 40)], launchedNums: [], availableLanes: [5], tick: 0 });
    expect(r.spawns).toEqual([]);
  });

  it('does NOT heal a green PR (ci !== fail and not BEHIND)', () => {
    const r = planCiHealSpawns({ prs: [{ num: 40, prNumber: 99, state: 'OPEN', ci: 'pass', labels: ['ready-to-merge'] }], launchedNums: [40], availableLanes: [5], tick: 0 });
    expect(r.spawns).toEqual([]);
  });

  it('heals a BEHIND + PARKED PR (the not-landable BEHIND case #2183 leaves), reason BEHIND', () => {
    const r = planCiHealSpawns({
      prs: [{ num: 40, prNumber: 99, state: 'OPEN', ci: 'pass', mergeStateStatus: 'BEHIND', labels: ['review:human'] }],
      launchedNums: [40], availableLanes: [5], tick: 0,
    });
    expect(r.spawns).toEqual([{ pr: 99, num: 40, lane: 5, reason: 'behind' }]);
  });

  it('does NOT heal a BEHIND but LANDABLE PR (ready-to-merge, green) — that is #2183\'s job, not this loop', () => {
    const r = planCiHealSpawns({
      prs: [{ num: 40, prNumber: 99, state: 'OPEN', ci: 'pass', mergeStateStatus: 'BEHIND', labels: ['ready-to-merge'] }],
      launchedNums: [40], availableLanes: [5], tick: 0,
    });
    expect(r.spawns).toEqual([]);
  });

  it('SKIPS a PR with a live CI-heal ENTRY (the in-flight test stops a duplicate heal on the same red episode)', () => {
    const r = planCiHealSpawns({ prs: [redPr(99, 40)], launchedNums: [40], liveCiHealGuards: [{ pr: 99, num: 40 }], availableLanes: [5], tick: 1 });
    expect(r.spawns).toEqual([]);
  });

  it('the retry cap BINDS from the persisted in-session counter — at cap it surfaces for /review, never re-heals', () => {
    const r = planCiHealSpawns({ prs: [redPr(99, 40)], launchedNums: [40], ciHealAttempts: { 99: DEFAULT_CI_HEAL_RETRY_CAP }, availableLanes: [5], tick: 5 });
    expect(r.spawns).toEqual([]);
    expect(r.notes[0]).toMatchObject({ kind: 'ci-heal-exhausted', pr: 99, attempts: DEFAULT_CI_HEAL_RETRY_CAP });
  });

  it('binds the cap from the DURABLE floor alone when a restart wiped the in-session tally (#2666 mirrors #2643)', () => {
    const r = planCiHealSpawns({
      prs: [redPr(99, 40)], launchedNums: [40],
      ciHealAttempts: {},                            // restart wiped the session tally
      prCiHealCounts: { 99: DEFAULT_CI_HEAL_RETRY_CAP }, // but the PR carries 3 durable CI-heal comments
      availableLanes: [5], tick: 0,
    });
    expect(r.spawns).toEqual([]);
    expect(r.notes[0]).toMatchObject({ kind: 'ci-heal-exhausted', pr: 99, attempts: DEFAULT_CI_HEAL_RETRY_CAP });
  });

  it('binds on max(in-session, durable) and re-seeds the in-session tally off the durable floor on the first spawn', () => {
    const r = planCiHealSpawns({
      prs: [redPr(99, 40)], launchedNums: [40], ciHealAttempts: {}, prCiHealCounts: { 99: 2 },
      availableLanes: [5], tick: 0,
    });
    expect(r.spawns).toEqual([{ pr: 99, num: 40, lane: 5, reason: 'red-ci' }]);
    expect(r.ciHealAttempts[99]).toBe(3); // re-primed from the durable floor, not 1
  });

  it('surfaces a no-lane hold rather than dropping the heal', () => {
    const r = planCiHealSpawns({ prs: [redPr(99, 40)], launchedNums: [40], availableLanes: [], tick: 0 });
    expect(r.spawns).toEqual([]);
    expect(r.notes[0]).toMatchObject({ kind: 'ci-heal-no-lane', pr: 99 });
  });
});

describe('retireCiHealGuards + clearTerminalCiHealAttempts — entry vs. counter lifetimes (SKILL §3c-ci)', () => {
  it('retires the ENTRY when CI recovered (ci no longer fail) — counter untouched', () => {
    const { live, retired } = retireCiHealGuards([{ pr: 99, num: 40, spawnedTick: 0 }], {
      prs: [{ num: 40, prNumber: 99, state: 'OPEN', ci: 'pass', labels: ['ready-to-merge'] }], tick: 1,
    });
    expect(live).toEqual([]);
    expect(retired[0]).toMatchObject({ pr: 99, reason: 'resolved' });
  });

  it('keeps the ENTRY live while the PR is still red (mid-heal), retiring it only on recovery or TTL', () => {
    const { live } = retireCiHealGuards([{ pr: 99, num: 40, spawnedTick: 0 }], {
      prs: [{ num: 40, prNumber: 99, state: 'OPEN', ci: 'fail', labels: ['ready-to-merge'] }], tick: 1, ttlTicks: 5,
    });
    expect(live).toHaveLength(1);
  });

  it('retires the entry on TTL if the PR is still red past the backstop (still cap-gated on re-dispatch)', () => {
    const { retired } = retireCiHealGuards([{ pr: 99, num: 40, spawnedTick: 0 }], {
      prs: [{ num: 40, prNumber: 99, state: 'OPEN', ci: 'fail', labels: ['ready-to-merge'] }], tick: 5, ttlTicks: 5,
    });
    expect(retired[0]).toMatchObject({ pr: 99, reason: 'ttl', note: true });
  });

  it('the attempt counter SURVIVES entry retirement and clears ONLY when the PR leaves the open set', () => {
    expect(clearTerminalCiHealAttempts({ 99: 2 }, [{ prNumber: 99, state: 'OPEN' }])).toEqual({ 99: 2 });
    expect(clearTerminalCiHealAttempts({ 99: 2 }, [])).toEqual({});
  });
});

// ── Watcher arming ────────────────────────────────────────────────────────────────────────────────────────────

describe('releaseSessionForNum — the merge-time auto-release slug per owning-agent kind (SKILL §4/§3, #2700)', () => {
  it('derives the build lease by default, and the prepare/decision lease when a live prepare guard holds the num', () => {
    const buildOnly = new Map();
    expect(releaseSessionForNum(40, buildOnly)).toBe('conveyor-40');
    expect(releaseSessionForNum(40, new Map([['40', 'prepare']]))).toBe('prepare-40');
    expect(releaseSessionForNum(40, new Map([['40', 'prepare-decision']]))).toBe('prepare-decision-40');
    // A missing / non-Map lookup degrades to the build session (never throws).
    expect(releaseSessionForNum(40, undefined)).toBe('conveyor-40');
  });
});

describe('armWatchers — one watcher per conveyor-launched OPEN PR (SKILL §4)', () => {
  const pr = (num, prNumber) => ({ num, prNumber, state: 'OPEN', labels: [] });

  it('arms a watcher (with its build release-session) only for a PR whose num this conveyor launched', () => {
    const r = armWatchers([pr(40, 99), pr(41, 100)], [40], []);
    expect(r.arm).toEqual([{ pr: 99, releaseSession: 'conveyor-40' }]);
    expect(r.nextWatched).toEqual([99]);
  });

  it('tags a prepare PR with its prepare release-session (from the live prepare guard), not the build one', () => {
    const r = armWatchers([pr(41, 100)], [41], [], [{ num: 41, kind: 'prepare' }]);
    expect(r.arm).toEqual([{ pr: 100, releaseSession: 'prepare-41' }]);
  });

  it('does not re-arm a PR already watched, and prunes a watched PR that has left the open set', () => {
    const r = armWatchers([pr(40, 99)], [40, 41], [99, 100]); // 100 (num 41) no longer open
    expect(r.arm).toEqual([]); // 99 already watched
    expect(r.nextWatched).toEqual([99]); // 100 pruned (its watcher already exited)
  });
});

// ── Idle-stop ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('assessIdleStop — queue-empty AND no operator feedback (SKILL §6)', () => {
  const MIN = 60 * 1000;

  it('stops only when BOTH the queue is empty AND the operator has been silent past the window', () => {
    const empty = { queue: [], lanes: [], prs: [], launchedNums: [] };
    expect(assessIdleStop({ ...empty, now: 20 * MIN, lastOperatorTurn: 0, idleWindowMs: 15 * MIN }).stop).toBe(true);
    // Silent long enough but queue not empty → no stop.
    expect(assessIdleStop({ queue: [{ num: 1, buildQueued: true }], now: 20 * MIN, lastOperatorTurn: 0, idleWindowMs: 15 * MIN }).stop).toBe(false);
    // Queue empty but recent operator feedback → no stop.
    expect(assessIdleStop({ ...empty, now: 5 * MIN, lastOperatorTurn: 0, idleWindowMs: 15 * MIN }).stop).toBe(false);
  });

  it('an in-flight lane or an open conveyor PR keeps the queue non-empty', () => {
    const base = { now: 99 * MIN, lastOperatorTurn: 0, idleWindowMs: 15 * MIN };
    expect(assessIdleStop({ ...base, queue: [], lanes: [{ lane: 4 }], prs: [], launchedNums: [] }).stop).toBe(false);
    expect(assessIdleStop({ ...base, queue: [], lanes: [], prs: [{ num: 40, prNumber: 99, state: 'OPEN' }], launchedNums: [40] }).stop).toBe(false);
  });

  it('never stops when the operator-feedback clock is unknown (conservative — a fresh session)', () => {
    expect(assessIdleStop({ queue: [], lanes: [], prs: [], launchedNums: [], now: null, lastOperatorTurn: null }).stop).toBe(false);
  });
});

// ── Watcher-exit router ───────────────────────────────────────────────────────────────────────────────────────

describe('routeWatcherExit — the exit-code → action table (SKILL §3)', () => {
  it('maps each exit code to its branch', () => {
    expect(routeWatcherExit(0).action).toBe('merged-freed');
    expect(routeWatcherExit(3).action).toBe('rearm-timeout');
    expect(routeWatcherExit(4).action).toBe('anomaly-closed');
    expect(routeWatcherExit(1).action).toBe('error');
    expect(routeWatcherExit(7).action).toBe('error'); // unknown code
  });

  it('splits a parked (2) PR by its label: review:changes → fix, any other review label → surface', () => {
    expect(routeWatcherExit(2, ['review:changes']).action).toBe('dispatch-fix');
    expect(routeWatcherExit(2, ['review:human']).action).toBe('surface-review');
    expect(routeWatcherExit(2, ['review:pending']).action).toBe('surface-review');
  });
});

// ── The whole composition ─────────────────────────────────────────────────────────────────────────────────────

describe('planTick — a cleared kind:investigation item is spawned via spawnInvestigations, NEVER spawnBuilds (#3567)', () => {
  it('a scoped item held needs-prepare spawns via spawnPrepareItems, never spawnBuilds (#4504)', () => {
    const result = planTick({
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 77, reason: 'needs-prepare' }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
    });
    expect(result.decisions.spawnPrepareItems.some((s) => String(s.num) === '77')).toBe(true);
    expect(result.decisions.spawnBuilds.some((s) => String(s.num) === '77')).toBe(false);
  });

  it('a held needs-investigation item spawns straight into spawnInvestigations, same tick it clears', () => {
    const out = planTick({
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 9001, reason: 'needs-investigation' }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.spawnInvestigations).toEqual([{ num: 9001, lane: 4 }]);
    expect(out.decisions.spawnBuilds).toEqual([]);
    // it never lands in spawnBuilds regardless of how many free lanes exist or what else is queued.
    expect(out.decisions.spawnBuilds.some((l) => l.num === 9001)).toBe(false);
    expect(out.nextState.launchedNums).toContain('9001');
  });

  it('a live investigate guard suppresses a re-spawn on the next tick', () => {
    const out = planTick({
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 9001, reason: 'needs-investigation' }] },
      freeLanes: [4],
      bookkeeping: { tick: 1, prepareGuards: [{ num: 9001, kind: 'investigate', lane: 4, spawnedTick: 0, sawPr: false }] },
    });
    expect(out.decisions.spawnInvestigations).toEqual([]);
  });

  it('a disjoint story launches normally on the SAME tick an investigation is held/spawned', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 5 }], held: [{ num: 9001, reason: 'needs-investigation' }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 5 }]);
    expect(out.decisions.spawnInvestigations).toEqual([{ num: 9001, lane: 4 }]);
  });

  it('a TRANSIENT reason-flip to blocked never drops the live investigate guard — no duplicate dispatch on unblock (red-team #3567)', () => {
    // Tick N: guard already live (spawned on an earlier tick).
    const liveGuard = { num: 9001, kind: 'investigate', lane: 4, spawnedTick: 0, sawPr: false };
    // Tick N+1: the item's hold reason flips to 'blocked' (dispatch-plan's blocked check outranks
    // needs-investigation) WHILE the dispatched investigate agent is still mid-run in its lane. A guard
    // pending-set narrowed to reason === 'needs-investigation' would misread this as "the investigation
    // finished" and retire the guard as scope-committed — this pins that it does NOT.
    const blockedTick = planTick({
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 9001, reason: 'blocked' }] },
      freeLanes: [4],
      bookkeeping: { tick: 1, prepareGuards: [liveGuard] },
    });
    expect(blockedTick.decisions.retireGuards.prepare).toEqual([]); // NOT retired
    expect(blockedTick.decisions.spawnInvestigations).toEqual([]); // NOT re-spawned
    expect(blockedTick.nextState.prepareGuards).toEqual(expect.arrayContaining([expect.objectContaining({ num: 9001, kind: 'investigate' })]));

    // Tick N+2: the blocker clears — item is needs-investigation again. The SAME still-live guard (carried in
    // bookkeeping from the blocked tick) must go on suppressing a second dispatch.
    const unblockedTick = planTick({
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 9001, reason: 'needs-investigation' }] },
      freeLanes: [4],
      bookkeeping: { tick: 2, prepareGuards: blockedTick.nextState.prepareGuards },
    });
    expect(unblockedTick.decisions.spawnInvestigations).toEqual([]); // still suppressed — no duplicate agent
  });

  it('a TRANSIENT reason-flip to blocked never drops the live prepare-item guard — no duplicate dispatch on unblock (#4504 review round 2)', () => {
    // Same shape as the investigate case just above, for the OTHER wide-held-set guard kind #4504 adds: a
    // still-running prepare-item agent must survive a transient `blocked` flip and go on suppressing a
    // second dispatch once the item clears back to `needs-prepare` — this is the exact planTick-level
    // coverage the #4504 review round 1 panel found missing (the only prior test called
    // `retirePrepareGuards` directly with a hand-built `needsPrepare` array).
    const liveGuard = { num: 7001, kind: 'prepare-item', lane: 4, spawnedTick: 0, sawPr: false };
    const blockedTick = planTick({
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 7001, reason: 'blocked' }] },
      freeLanes: [4],
      bookkeeping: { tick: 1, prepareGuards: [liveGuard] },
    });
    expect(blockedTick.decisions.retireGuards.prepare).toEqual([]); // NOT retired
    expect(blockedTick.decisions.spawnPrepareItems).toEqual([]); // NOT re-spawned
    expect(blockedTick.nextState.prepareGuards).toEqual(expect.arrayContaining([expect.objectContaining({ num: 7001, kind: 'prepare-item' })]));

    const unblockedTick = planTick({
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 7001, reason: 'needs-prepare' }] },
      freeLanes: [4],
      bookkeeping: { tick: 2, prepareGuards: blockedTick.nextState.prepareGuards },
    });
    expect(unblockedTick.decisions.spawnPrepareItems).toEqual([]); // still suppressed — no duplicate agent
  });

  it('with more needs-prepare candidates than the cap, a prepare-item that dies without a PR yields its slot — every candidate is eventually reached (#4504 advisory)', () => {
    // Cap 1, three candidates, and no agent ever opens a PR or stamps (the could-not-prepare / died shape).
    // Each TTL retirement counts one attempt against that num, so the slot rotates instead of re-spawning
    // the first candidate forever.
    const held = [{ num: 8001, reason: 'needs-prepare' }, { num: 8002, reason: 'needs-prepare' }, { num: 8003, reason: 'needs-prepare' }];
    let bookkeeping = { tick: 0 };
    const spawned = [];
    for (let i = 0; i < 3 * (DEFAULT_PREPARE_ITEM_TTL_TICKS + 1); i++) {
      const r = planTick({
        state: { queue: [], lanes: [{ lane: 4 }], prs: [] }, // the agent really acquired its lane (claimed)
        plan: { launch: [], held },
        freeLanes: [4],
        bookkeeping,
        config: { maxConcurrentItemPrepares: 1 },
      });
      spawned.push(...r.decisions.spawnPrepareItems.map((s) => s.num));
      bookkeeping = r.nextState;
    }
    expect(new Set(spawned)).toEqual(new Set([8001, 8002, 8003]));
    expect(bookkeeping.itemPrepareAttempts).toMatchObject({ 8001: 1, 8002: 1 });
  });

  it('an UNCLAIMED prepare-item TTL retirement (lane never leased — refused pre-flight) burns no attempt (#4504 advisory, #3454 shape)', () => {
    const guard = { num: 8101, kind: 'prepare-item', lane: 4, spawnedTick: 0, sawPr: false };
    const r = planTick({
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 8101, reason: 'needs-prepare' }] },
      freeLanes: [4],
      bookkeeping: { tick: DEFAULT_PREPARE_ITEM_TTL_TICKS, prepareGuards: [guard] },
    });
    expect(r.decisions.retireGuards.prepare).toEqual([expect.objectContaining({ num: 8101, reason: 'ttl', claimed: false })]);
    expect(r.nextState.itemPrepareAttempts).toEqual({});
    expect(r.decisions.spawnPrepareItems).toEqual([{ num: 8101, lane: 4 }]); // free re-dispatch
  });

  it('a needs-prepare item held BLOCKED by the prepare-item kind-scoped dispatch-pause spawns nothing, then spawns once unpaused (#4504 review round 2)', () => {
    // #4504 review round 1 (claim-accuracy) found the shared `everyKindReady` pause fixture carries no
    // needs-prepare candidate, so the "ALL SEVEN kinds" pause test never actually exercises prepare-item's
    // own pausability — it passes whether or not the kind is wired into TICK_SPAWN_KINDS/pausedKinds at all.
    // This is a standalone fixture (not sharing/perturbing `everyKindReady`, to avoid reshuffling every OTHER
    // test that fixture already covers) that pins the real behavior directly.
    const fixture = {
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 7002, reason: 'needs-prepare' }] },
      freeLanes: [4],
      bookkeeping: { tick: 0 },
    };
    const paused = planTick({ ...fixture, dispatchPaused: true, dispatchPausedKinds: ['prepare-item'] });
    expect(paused.decisions.spawnPrepareItems).toEqual([]);
    const unpaused = planTick(fixture);
    expect(unpaused.decisions.spawnPrepareItems).toEqual([{ num: 7002, lane: 4 }]);
  });
});

describe('planTick — a held "no-size" item is auto-prepared through the SAME prepare-scope spawn as unshaped-no-scope (#3801 Fork 4 (b), #3849 admission)', () => {
  it('a held no-size item spawns a prepare-scope agent, same tick it clears (#3842 authors size in the same turn)', () => {
    const out = planTick({
      state: { queue: [], unshaped: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 9002, reason: 'no-size' }] },
      freeLanes: [4],
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 9002, lane: 4 }]);
    expect(out.decisions.spawnBuilds).toEqual([]);
    expect(out.nextState.launchedNums).toContain('9002');
  });

  it('a live prepare guard for the num suppresses a re-spawn on the next tick', () => {
    const out = planTick({
      state: { queue: [], unshaped: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 9002, reason: 'no-size' }] },
      freeLanes: [4],
      bookkeeping: { tick: 1, prepareGuards: [{ num: 9002, kind: 'prepare', lane: 4, spawnedTick: 0, sawPr: false }] },
    });
    expect(out.decisions.spawnPrepareScope).toEqual([]);
  });

  it('an unshaped-no-scope item AND a no-size item in the same tick each get their own prepare-scope spawn', () => {
    const out = planTick({
      state: { queue: [], unshaped: [{ num: 70 }], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 70, reason: 'unshaped-no-scope' }, { num: 90, reason: 'no-size' }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.spawnPrepareScope).toEqual(expect.arrayContaining([{ num: 70, lane: 4 }, { num: 90, lane: 5 }]));
    expect(out.decisions.spawnPrepareScope).toHaveLength(2);
  });

  it('the SAME num held BOTH unshaped-no-scope (state) and no-size (plan.held) spawns exactly ONE prepare agent, never two', () => {
    // Cannot happen via dispatch-plan.mjs today (no-size is checked strictly after the scope gate), but the
    // merge is deduped defensively so a future caller can never double-spawn on one num.
    const out = planTick({
      state: { queue: [], unshaped: [{ num: 70 }], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 70, reason: 'no-size' }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 70, lane: 4 }]);
  });

  it('a KIND-SCOPED dispatch-pause on "prepare" holds the no-size auto-prepare too (epic #3383)', () => {
    const out = planTick({
      state: { queue: [], unshaped: [], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 9002, reason: 'no-size' }] },
      freeLanes: [4],
      bookkeeping: { tick: 0 },
      dispatchPaused: true,
      dispatchPausedKinds: ['prepare'],
    });
    expect(out.decisions.spawnPrepareScope).toEqual([]);
  });

  it('a disjoint story launches normally on the SAME tick a no-size item is held/spawned', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], unshaped: [], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 5 }], held: [{ num: 9002, reason: 'no-size' }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 5 }]);
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 9002, lane: 4 }]);
  });

  it('a `fix`/`ci-heal` spawn is NEVER held for size — planFixSpawns/planCiHealSpawns never consult plan.held at all', () => {
    // #3849 Done-when (d): fix and ci-heal take the fixSizeSource chain, never this admission gate. Proven
    // structurally: a fix spawn fires normally even while an UNRELATED item sits held `no-size` this same tick.
    const changesPr = { num: 10, prNumber: 30, state: 'OPEN', labels: ['review:changes'] };
    const out = planTick({
      state: { queue: [], unshaped: [], lanes: [], prs: [changesPr] },
      plan: { launch: [{ num: 10, lane: 5 }], held: [{ num: 9002, reason: 'no-size' }] },
      freeLanes: [4, 5, 6], // 5 → the build launch, 4 → the no-size prepare-scope spawn, 6 left for the fix
      bookkeeping: { tick: 0, launchedNums: ['10'] },
    });
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 9002, lane: 4 }]);
    expect(out.decisions.spawnFixes).toEqual([{ pr: 30, num: 10, lane: 6 }]);
  });
});

describe('planTick — composes the tick and threads nextState', () => {
  it('filters the plan through guards, records new build guards, and grows launchedNums', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }, { num: 11, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }, { num: 11, lane: 5 }] },
      freeLanes: [4, 5, 6],
      bookkeeping: { tick: 0, buildGuards: [{ num: 11, lane: 5, spawnedTick: 0 }] }, // 11 already guarded
    });
    // 11 is suppressed (live guard); only 10 spawns.
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
    expect(out.decisions.suppressedBuilds).toEqual([{ num: 11, lane: 5, by: 'num' }]);
    expect(out.nextState.tick).toBe(1);
    expect(out.nextState.buildGuards).toEqual(expect.arrayContaining([
      { num: 11, lane: 5, spawnedTick: 0 },
      { num: 10, lane: 4, spawnedTick: 0 },
    ]));
    expect(out.nextState.launchedNums).toContain('10');
  });

  it('#3403 — a supervisor crash-restart (bookkeeping wiped to `{}`) does NOT re-launch a build whose OS session is still alive', () => {
    // #77 was spawned on lane 4 last tick: it has not yet acquired its lane (state.lanes still empty) or left
    // the cleared queue (state.queue still shows it buildQueued), so from `state`'s own ground truth alone it
    // looks exactly like a never-dispatched item — the SAME shape a genuinely fresh #77 would have. Only the
    // durable floor (`liveAgentSessions`) tells the two apart.
    const out = planTick({
      state: { queue: [{ num: 77, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [{ num: 77, lane: 4 }] },
      freeLanes: [4],
      bookkeeping: { tick: 5, buildGuards: [] }, // wiped by the crash-restart — fails today without the fix
      liveAgentSessions: [{ name: 'conveyor-77', pid: 12345 }],
    });
    expect(out.decisions.spawnBuilds).toEqual([]);
    expect(out.decisions.suppressedBuilds).toEqual([{ num: 77, lane: 4, by: 'num' }]);
    // The durable guard is carried into nextState too, so the SAME check holds again next tick even if the
    // live-session read is momentarily unavailable.
    expect(out.nextState.buildGuards).toEqual(expect.arrayContaining([
      expect.objectContaining({ num: '77', lane: null }),
    ]));
  });

  it('#3403 — a genuinely fresh item with no live session and no guard launches normally (the fix does not over-suppress)', () => {
    const out = planTick({
      state: { queue: [{ num: 78, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [{ num: 78, lane: 4 }] },
      freeLanes: [4],
      bookkeeping: { tick: 5, buildGuards: [] },
      liveAgentSessions: [{ name: 'conveyor-77', pid: 12345 }], // unrelated live session — must not block #78
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 78, lane: 4 }]);
  });

  it('#3403 FOLLOW-UP — a durable guard entry keeps its ORIGINAL spawnedTick across ticks instead of being re-stamped with the current tick every time it is resynthesized', () => {
    // #99's durable entry was first seen at tick 2 (as if carried forward from a prior planTick call via
    // nextState.buildGuards, the same way a real runner threads bookkeeping tick to tick). This call is tick 5 —
    // three ticks later, exactly the default build-guard TTL. Before the fix, this block re-stamped
    // `spawnedTick: tick` (5) every time it (re)synthesized the entry, so its age could never be read as 3+ no
    // matter how many real ticks had actually passed.
    const out = planTick({
      state: { queue: [{ num: 99, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [] },
      freeLanes: [],
      bookkeeping: { tick: 5, buildGuards: [{ num: '99', lane: null, spawnedTick: 2 }] },
      liveAgentSessions: [{ name: 'conveyor-99', pid: 1 }],
    });
    expect(out.nextState.buildGuards).toEqual(expect.arrayContaining([
      expect.objectContaining({ num: '99', lane: null, spawnedTick: 2 }),
    ]));
  });

  it('#3403 FOLLOW-UP — a durable build-guard entry that never claims stops inflating "building"/decisions.counts once its age reaches the build guard TTL, even though liveAgentSessions keeps reporting the SAME stale session every tick (live bug, epic #3383: wev-scratch-dispatcher-4 showed "building" stuck at 11-15 for 270+ consecutive ticks against 2 genuinely leased lanes)', () => {
    // #99's session (`conveyor-99`) is durable-live every tick — a `claude agents --json` staleness the fix
    // guard's own #3454 fix already has to tolerate on dispatch-lane's pre-flight check — but #99 never actually
    // claims: it stays in the cleared build queue and never shows a leased lane, tick after tick. That is
    // indistinguishable, from tick-core's own read, from a session that exited without `claude agents --json`
    // ever noticing.
    const state = { queue: [{ num: 99, buildQueued: true }], lanes: [], prs: [] };
    const liveAgentSessions = [{ name: 'conveyor-99', pid: 1 }];
    let bookkeeping = { tick: 0 };
    let out;
    for (let i = 0; i < 5; i += 1) {
      out = planTick({ state, plan: { launch: [] }, freeLanes: [], bookkeeping, liveAgentSessions });
      bookkeeping = out.nextState;
    }
    // 5 ticks in (past the default 3-tick TTL), the durable floor no longer inflates the DISPLAYED tallies...
    expect(out.decisions.counts.building).toBe(0);
    expect(out.decisions.statusLine).toContain('0 building');
    // ...but the double-dispatch protection #3403 exists for is UNCHANGED: a launch attempt for #99 is still
    // suppressed — the durable guard is still carried in nextState.buildGuards, only excluded from the tally.
    const relaunch = planTick({
      state, plan: { launch: [{ num: 99, lane: 4 }] }, freeLanes: [4], bookkeeping, liveAgentSessions,
    });
    expect(relaunch.decisions.spawnBuilds).toEqual([]);
    expect(relaunch.decisions.suppressedBuilds).toEqual([{ num: 99, lane: 4, by: 'num' }]);
  });

  it('#3398 — decisions.counts carries the same structured tallies as decisions.statusLine, not re-derived by a caller', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }, { num: 11, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4, 5, 6],
      bookkeeping: { tick: 0 },
    });
    // 10 spawns this tick (now building, excluded from `queued`); 11 has no launch plan entry — still queued.
    expect(out.decisions.counts).toMatchObject({ queued: 1, building: 1 });
    expect(out.decisions.statusLine).toContain('1 queued');
    expect(out.decisions.statusLine).toContain('1 building');
  });

  it('card x0jgunh — counts.buildingInFlight excludes THIS tick\'s own proposed spawns, unlike counts.building', () => {
    // 2 lanes are leased for unrelated work (num:null — e.g. a soak-break/review session, not a build) and 6
    // items are launchable with empty bookkeeping (no prior-tick guards at all). Before the fix, a consumer
    // reading `counts.building` here would see 6 "already in flight" and cap out immediately, even though
    // NOTHING was in flight before this tick proposed these 6 spawns.
    const queue = Array.from({ length: 6 }, (_, i) => ({ num: 100 + i, buildQueued: true }));
    const out = planTick({
      state: { queue, lanes: [{ num: null }, { num: null }], prs: [] },
      plan: { launch: queue.map((q, i) => ({ num: q.num, lane: i + 1 })) },
      freeLanes: [1, 2, 3, 4, 5, 6],
      bookkeeping: {},
    });
    expect(out.decisions.spawnBuilds.length).toBe(6);
    expect(out.decisions.counts.buildingInFlight).toBe(0);
    // `counts.building` is unchanged — it DOES count this tick's own spawns (right for the conveyor, which
    // launches every spawn it is handed).
    expect(out.decisions.counts.building).toBe(6);
  });

  it('card x0jgunh — a prior-tick build already holding a leased lane counts 1 in buildingInFlight, not 0 and not double-counted', () => {
    const out = planTick({
      state: { queue: [{ num: 50, buildQueued: true }], lanes: [{ num: 50, lane: 7 }], prs: [] },
      plan: { launch: [] },
      freeLanes: [],
      bookkeeping: { tick: 5, buildGuards: [{ num: 50, lane: 7, spawnedTick: 3 }] },
    });
    expect(out.decisions.counts.buildingInFlight).toBe(1);
    expect(out.decisions.counts.building).toBe(1);
  });

  it('shares the free-lane pool across builds and prepares — a prepare never takes a build lane this tick', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], unshaped: [{ num: 20 }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
    // The prepare must land on lane 5 (4 is taken by the build), never a collision.
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 20, lane: 5 }]);
  });

  it('excludes lanes across builds, prepares AND fixes in one tick — no lane is used twice', () => {
    const out = planTick({
      state: {
        queue: [{ num: 10, buildQueued: true }],
        unshaped: [{ num: 20 }],
        prs: [{ num: 40, prNumber: 99, state: 'OPEN', labels: ['review:changes'] }],
        lanes: [], needsSlice: [], decisions: [],
      },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4, 5, 6],
      bookkeeping: { tick: 0, launchedNums: [40] }, // 40 is a conveyor-launched PR now bounced
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 20, lane: 5 }]);
    expect(out.decisions.spawnFixes).toEqual([{ pr: 99, num: 40, lane: 6 }]);
    // Every consumed lane is distinct — 4 (build), 5 (prepare), 6 (fix).
    const lanes = [4, 5, 6];
    expect(new Set(lanes).size).toBe(3);
    // #3454 — a same-tick spawn is only PLANNED, not yet CONFIRMED (state.lanes has no lease for lane 6 yet on
    // this same tick's read), so the counter does not bump here — see the dedicated "bumps only on a CONFIRMED
    // claim" describe block below for the claim-time bump.
    expect(out.nextState.fixAttempts).toEqual({});
  });

  it('composes a CI-heal spawn for a green-at-open PR gone red, on a lane no build/prepare/fix took (#2666)', () => {
    const out = planTick({
      state: {
        queue: [{ num: 10, buildQueued: true }],
        prs: [{ num: 40, prNumber: 99, state: 'OPEN', ci: 'fail', labels: ['ready-to-merge'] }],
        lanes: [], needsSlice: [], decisions: [],
      },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0, launchedNums: [40] }, // 40 is a conveyor-launched PR now gone red after open
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
    expect(out.decisions.spawnCiHeals).toEqual([{ pr: 99, num: 40, lane: 5, reason: 'red-ci' }]);
    expect(out.nextState.ciHealGuards).toEqual([{ pr: 99, num: 40, lane: 5, spawnedTick: 0 }]);
    expect(out.nextState.ciHealAttempts).toEqual({ 99: 1 });
  });

  it('retires a build guard via the lane-leased claim path — the guard drops out of nextState', () => {
    // Once the agent acquires its lane it shows leased in state.lanes; dispatch-plan then stops listing the
    // (now-claimed, off-queue) item, so plan.launch is empty. The guard must retire — not linger forever.
    const out = planTick({
      state: { queue: [], lanes: [{ lane: 4, num: 10 }], prs: [] },
      plan: { launch: [] },
      freeLanes: [],
      bookkeeping: { tick: 1, buildGuards: [{ num: 10, lane: 4, spawnedTick: 0 }] },
    });
    expect(out.decisions.retireGuards.build).toEqual([{ num: 10, lane: 4, reason: 'claimed' }]);
    expect(out.nextState.buildGuards).toEqual([]);
  });

  it('arms a watcher for a spawned build once its PR is open on a later tick, and stops when idle', () => {
    const idle = planTick({
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [] },
      bookkeeping: { tick: 3, launchedNums: [] },
      now: 100 * 60 * 1000, lastOperatorTurn: 0,
    });
    expect(idle.decisions.idleStop).toBe(true);
    expect(idle.decisions.statusLine).toContain('conveyor ·');
  });

  it('arms a watcher carrying the item build release-session for an open conveyor-launched PR (#2700)', () => {
    const out = planTick({
      state: { queue: [], lanes: [], prs: [{ num: 40, prNumber: 99, state: 'OPEN', labels: [] }] },
      plan: { launch: [] },
      bookkeeping: { tick: 2, launchedNums: [40], watched: [] },
    });
    expect(out.decisions.armWatchers).toEqual([{ pr: 99, releaseSession: 'conveyor-40' }]);
    expect(out.nextState.watched).toEqual([99]);
  });

  it('consumes state.health as a backstop — a stalled lane surfaces as an actionable note (#2616/#2700)', () => {
    const out = planTick({
      state: {
        queue: [], lanes: [{ lane: 4, num: 10 }], prs: [],
        health: { verdict: 'warn', stalled: [{ lane: 4, num: 10, idleS: 240 }] },
      },
      plan: { launch: [] },
      bookkeeping: { tick: 5 },
    });
    expect(out.decisions.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'lane-stalled', num: 10, lane: 4 }),
    ]));
    expect(out.decisions.statusLine).toContain('health warn');
  });

  it('emits ONE degraded-infra note PER cluster (cause + affected-lane count), distinct from a per-lane stall (#2741/#2661)', () => {
    const out = planTick({
      state: {
        queue: [], lanes: [], prs: [],
        health: {
          verdict: 'warn',
          stalled: [{ lane: 7, num: 70, idleS: 300 }],
          degradedInfra: [
            { cause: 'GitHub outage', count: 3, members: [{ lane: 1, num: 11 }, { lane: 2, num: 12 }, { lane: 3, num: 13 }] },
            { cause: 'npm registry outage', count: 1, members: [{ lane: 4, num: 14 }] },
          ],
        },
      },
      plan: { launch: [] },
      bookkeeping: { tick: 2 },
    });
    const infra = out.decisions.notes.filter((n) => n.kind === 'degraded-infra');
    // ONE note per CLUSTER — two causes → exactly two notes, NOT one per affected lane (would be 4).
    expect(infra).toHaveLength(2);
    expect(infra).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'degraded-infra', cause: 'GitHub outage', count: 3 }),
      expect.objectContaining({ kind: 'degraded-infra', cause: 'npm registry outage', count: 1 }),
    ]));
    // The multi-lane cluster pluralizes; the single-lane one does not.
    expect(infra.find((n) => n.cause === 'GitHub outage').text).toContain('3 lanes waiting on GitHub outage');
    expect(infra.find((n) => n.cause === 'npm registry outage').text).toContain('1 lane waiting on npm registry outage');
    // Distinct from the per-lane stall note — the genuine stall still surfaces on its own.
    expect(out.decisions.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'lane-stalled', num: 70, lane: 7 }),
    ]));
  });

  it('emits NO degraded-infra note when the cluster list is empty OR absent', () => {
    const empty = planTick({
      state: { queue: [], lanes: [], prs: [], health: { verdict: 'ok', stalled: [], degradedInfra: [] } },
      plan: { launch: [] },
      bookkeeping: { tick: 0 },
    });
    expect(empty.decisions.notes.filter((n) => n.kind === 'degraded-infra')).toHaveLength(0);
    // A health verdict with NO degradedInfra field at all (older reader / pre-#2661 shape) must not throw or fabricate.
    const absent = planTick({
      state: { queue: [], lanes: [], prs: [], health: { verdict: 'ok', stalled: [] } },
      plan: { launch: [] },
      bookkeeping: { tick: 0 },
    });
    expect(absent.decisions.notes.filter((n) => n.kind === 'degraded-infra')).toHaveLength(0);
  });

  it('falls back to members length when a cluster omits count (defensive — malformed input never renders "undefined lanes")', () => {
    const out = planTick({
      state: {
        queue: [], lanes: [], prs: [],
        health: { verdict: 'warn', stalled: [], degradedInfra: [{ cause: 'GitHub outage', members: [{ lane: 1, num: 11 }, { lane: 2, num: 12 }] }] },
      },
      plan: { launch: [] },
      bookkeeping: { tick: 0 },
    });
    const note = out.decisions.notes.find((n) => n.kind === 'degraded-infra');
    expect(note).toMatchObject({ kind: 'degraded-infra', cause: 'GitHub outage', count: 2 });
    expect(note.text).toContain('2 lanes waiting on GitHub outage');
    expect(note.text).not.toContain('undefined');
  });

  it('surfaces a needs-slice epic and a prepared decision as notes (no agent, no guard)', () => {
    const out = planTick({
      state: { queue: [], needsSlice: [{ num: 50, epicState: 'unsliced' }], decisions: [{ num: 60, prepared: true }], lanes: [], prs: [] },
      plan: { launch: [] },
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'needs-slice', num: 50 }),
      expect.objectContaining({ kind: 'decision-ready', num: 60 }),
    ]));
    // A prepared decision is PRESENTED, never spawned.
    expect(out.decisions.spawnPrepareDecision).toEqual([]);
  });

  // ── Held-reason telemetry (the live gap fixed here): a tick that dispatches nothing must be able to say WHY,
  //    from its OWN output — no separate manual `dispatch-plan.mjs --json` run required. ──────────────────────
  describe('held-reason notes — plan.held surfaces as its own note (telemetry gap fix)', () => {
    it('surfaces an "overlaps lane-<n>" held item as a note, verbatim reason + text', () => {
      const out = planTick({
        state: { queue: [{ num: 3460, buildQueued: true }], lanes: [], prs: [] },
        plan: { launch: [], held: [{ num: 3460, reason: 'overlaps lane-17' }] },
        bookkeeping: { tick: 0 },
      });
      expect(out.decisions.notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'held', num: 3460, reason: 'overlaps lane-17', text: '⏸ #3460 — overlaps lane-17' }),
      ]));
    });

    it('surfaces a "cleared-but-not-ready" held item as a note', () => {
      const out = planTick({
        state: { queue: [], lanes: [], prs: [] },
        plan: { launch: [], held: [{ num: 3443, reason: 'cleared-but-not-ready' }] },
        bookkeeping: { tick: 0 },
      });
      expect(out.decisions.notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'held', num: 3443, reason: 'cleared-but-not-ready', text: '⏸ #3443 — cleared-but-not-ready' }),
      ]));
    });

    it('surfaces BOTH shapes together — the live #3383 scenario: several overlaps + several cleared-but-not-ready', () => {
      const held = [
        { num: 3460, reason: 'overlaps lane-17' }, { num: 3461, reason: 'overlaps lane-17' },
        { num: 3443, reason: 'cleared-but-not-ready' }, { num: 3451, reason: 'cleared-but-not-ready' },
      ];
      const out = planTick({
        state: { queue: [], lanes: [], prs: [] },
        plan: { launch: [], held },
        bookkeeping: { tick: 0 },
      });
      const heldNotes = out.decisions.notes.filter((n) => n.kind === 'held');
      expect(heldNotes).toHaveLength(4);
      expect(heldNotes.map((n) => n.num)).toEqual([3460, 3461, 3443, 3451]);
    });

    it('surfaces a "no free lane" and a defense-in-depth "blocked" held item too', () => {
      const out = planTick({
        state: { queue: [], lanes: [], prs: [] },
        plan: { launch: [], held: [{ num: 10, reason: 'no free lane' }, { num: 11, reason: 'blocked' }] },
        bookkeeping: { tick: 0 },
      });
      expect(out.decisions.notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'held', num: 10, reason: 'no free lane' }),
        expect.objectContaining({ kind: 'held', num: 11, reason: 'blocked' }),
      ]));
    });

    it('does NOT double-report needs-slice / needs-decision / needs-investigation / unshaped-no-scope / no-size — each already has its own note', () => {
      const out = planTick({
        state: {
          queue: [], needsSlice: [{ num: 50, epicState: 'unsliced' }], decisions: [{ num: 60, prepared: true }],
          unshaped: [], lanes: [], prs: [],
        },
        plan: {
          launch: [],
          held: [
            { num: 50, reason: 'needs-slice' },
            { num: 61, reason: 'needs-decision' },
            { num: 70, reason: 'unshaped-no-scope' },
            { num: 80, reason: 'needs-investigation' },
            { num: 90, reason: 'no-size' },
          ],
        },
        freeLanes: [8, 9],
        bookkeeping: { tick: 0 },
      });
      // No 'held' note for any of the five excluded reasons — only their own dedicated note kind appears.
      expect(out.decisions.notes.filter((n) => n.kind === 'held')).toHaveLength(0);
      expect(out.decisions.notes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'needs-slice', num: 50 }),
        expect.objectContaining({ kind: 'decision-ready', num: 60 }),
        expect.objectContaining({ kind: 'auto-investigating', nums: [80] }),
        // #3849 — `no-size` is folded into the SAME 'auto-preparing-scope' note as `unshaped-no-scope`, since
        // #3842's prepare-scope agent authors either (or both) in one turn.
        expect.objectContaining({ kind: 'auto-preparing-scope', nums: [90] }),
      ]));
      // The exclusion set itself is exactly the seven reasons that have their own note elsewhere.
      expect(HELD_NOTE_EXCLUDED_REASONS).toEqual(['needs-slice', 'needs-decision', 'needs-investigation', 'needs-prepare', 'prepare-stale', 'unshaped-no-scope', 'no-size']);
    });

    it('emits NO held notes when the queue is empty (plan.held absent or [])', () => {
      const absent = planTick({
        state: { queue: [], lanes: [], prs: [] },
        plan: { launch: [] },
        bookkeeping: { tick: 0 },
      });
      expect(absent.decisions.notes.filter((n) => n.kind === 'held')).toHaveLength(0);

      const empty = planTick({
        state: { queue: [], lanes: [], prs: [] },
        plan: { launch: [], held: [] },
        bookkeeping: { tick: 0 },
      });
      expect(empty.decisions.notes.filter((n) => n.kind === 'held')).toHaveLength(0);
    });

    it('emits NO held notes when everything is actually dispatching normally (a launch, nothing held)', () => {
      const out = planTick({
        state: { queue: [{ num: 10, buildQueued: true }], lanes: [], prs: [] },
        plan: { launch: [{ num: 10, lane: 4 }], held: [] },
        freeLanes: [4],
        bookkeeping: { tick: 0 },
      });
      expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
      expect(out.decisions.notes.filter((n) => n.kind === 'held')).toHaveLength(0);
    });
  });
});

describe('buildDecisionTrace — plain-language per-tick "why" (2026-09-14, #3521 decision-trace v1)', () => {
  it('traces a dispatched build with its lane', () => {
    const trace = buildDecisionTrace({ spawnBuilds: [{ num: 10, lane: 4 }] });
    expect(trace).toEqual([{ kind: 'dispatch', num: 10, lane: 4, text: 'dispatched #10 to lane-4: build' }]);
  });
  it('traces a dispatched investigation (#3567) so no dispatch kind is missing from the trace', () => {
    const trace = buildDecisionTrace({ spawnInvestigations: [{ num: 12, lane: 6 }] });
    expect(trace).toEqual([{ kind: 'dispatch', num: 12, text: 'dispatched #12: auto-investigate (needs-investigation item)' }]);
  });
  it('traces a suppressed (already-dispatching) build as a skip', () => {
    const trace = buildDecisionTrace({ suppressedBuilds: [{ num: 11, lane: 5, by: 'num' }] });
    expect(trace).toEqual([{ kind: 'skip', num: 11, text: 'skipped #11: already dispatching (matched a live guard by num)' }]);
  });
  it('traces a `held` note as a skip carrying the exact same reason text', () => {
    const trace = buildDecisionTrace({ notes: [{ kind: 'held', num: 3521, reason: 'overlaps lane-2', text: '⏸ #3521 — overlaps lane-2' }] });
    expect(trace).toEqual([{ kind: 'skip', num: 3521, reason: 'overlaps lane-2', text: 'skipped #3521: overlaps lane-2' }]);
  });
  it('reuses a `stalled` note VERBATIM (never re-derives the self-diagnosed stall text)', () => {
    const stalledNote = { kind: 'stalled', num: 3521, reason: 'overlaps lane-2', ticks: 3, text: '🛑 #3521 stuck 3 consecutive ticks on: overlaps lane-2 — self-diagnosed stall, needs attention' };
    const trace = buildDecisionTrace({ notes: [stalledNote] });
    expect(trace).toEqual([{ kind: 'stall', num: 3521, reason: 'overlaps lane-2', ticks: 3, text: stalledNote.text }]);
  });
  it('traces prepare-scope, prepare-decision, fix, and ci-heal dispatches', () => {
    const trace = buildDecisionTrace({
      spawnPrepareScope: [{ num: 1 }],
      spawnPrepareDecision: [{ num: 2 }],
      spawnFixes: [{ num: 3, pr: 30 }],
      spawnCiHeals: [{ num: 4, pr: 40 }],
    });
    expect(trace).toEqual([
      { kind: 'dispatch', num: 1, text: 'dispatched #1: auto-prepare scope (unshaped item)' },
      { kind: 'dispatch', num: 2, text: 'dispatched #2: prepare decision forks' },
      { kind: 'dispatch', num: 3, pr: 30, text: 'dispatched fix for PR #30 (#3): review:changes bounce' },
      { kind: 'dispatch', num: 4, pr: 40, text: 'dispatched CI-heal for PR #40 (#4): red/BEHIND regression' },
    ]);
  });
  it('is empty for an empty/malformed decisions object — never throws', () => {
    expect(buildDecisionTrace({})).toEqual([]);
    expect(buildDecisionTrace(null)).toEqual([]);
  });
});

describe('buildDecisionTrace — verbose mode (2026-09-14, #3521 decision-trace v1 follow-up)', () => {
  it('non-verbose (default): a needs-slice/needs-decision/unshaped-no-scope held candidate is NOT traced', () => {
    const trace = buildDecisionTrace({ notes: [] }, { verbose: false, allHeld: [{ num: 5, reason: 'needs-slice' }] });
    expect(trace).toEqual([]);
  });
  it('verbose: the SAME excluded-reason candidate IS traced, tagged verbose:true', () => {
    const trace = buildDecisionTrace({ notes: [] }, { verbose: true, allHeld: [{ num: 5, reason: 'needs-slice' }] });
    expect(trace).toEqual([{ kind: 'skip', num: 5, reason: 'needs-slice', verbose: true, text: 'skipped #5: needs-slice' }]);
  });
  it('verbose: never double-reports a candidate already traced via its terse `held` note', () => {
    const trace = buildDecisionTrace(
      { notes: [{ kind: 'held', num: 3521, reason: 'overlaps lane-2', text: '⏸ #3521 — overlaps lane-2' }] },
      { verbose: true, allHeld: [{ num: 3521, reason: 'overlaps lane-2' }] },
    );
    expect(trace).toEqual([{ kind: 'skip', num: 3521, reason: 'overlaps lane-2', text: 'skipped #3521: overlaps lane-2' }]);
  });
  it('verbose: an `overlaps lane-N` stall gets the real lane row (session/lease/breach) attached', () => {
    const stalledNote = { kind: 'stalled', num: 3521, reason: 'overlaps lane-2', ticks: 3, text: '🛑 stuck' };
    const lanes = [{ lane: 2, num: null, session: 'fix-decision-docket-2193', lease: ['we:scripts/operations/run-record.mjs'], breach: [] }];
    const trace = buildDecisionTrace({ notes: [stalledNote] }, { verbose: true, lanes });
    expect(trace[0].lane).toEqual({
      lane: 2, heldBySession: 'fix-decision-docket-2193', leaseScope: ['we:scripts/operations/run-record.mjs'], breach: [],
    });
  });
  it('non-verbose: a stall entry carries NO lane detail, even when a matching lane row exists', () => {
    const stalledNote = { kind: 'stalled', num: 3521, reason: 'overlaps lane-2', ticks: 3, text: '🛑 stuck' };
    const lanes = [{ lane: 2, session: 'fix-decision-docket-2193', lease: [], breach: [] }];
    const trace = buildDecisionTrace({ notes: [stalledNote] }, { verbose: false, lanes });
    expect(trace[0]).not.toHaveProperty('lane');
  });
});

describe('planTick — config.verbose wiring (2026-09-14, #3521 decision-trace v1 follow-up)', () => {
  it('defaults to non-verbose when config.verbose is absent', () => {
    const out = planTick({
      state: { queue: [{ num: 5 }], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 5, reason: 'needs-slice' }] },
      freeLanes: [],
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.decisionTrace.some((t) => t.verbose)).toBe(false);
  });
  it('config.verbose: true surfaces the verbose-only entries', () => {
    const out = planTick({
      state: { queue: [{ num: 5 }], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 5, reason: 'needs-slice' }] },
      freeLanes: [],
      bookkeeping: { tick: 0 },
      config: { verbose: true },
    });
    expect(out.decisions.decisionTrace).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skip', num: 5, reason: 'needs-slice', verbose: true }),
    ]));
  });
});

describe('planTick — decisionTrace is wired onto every tick (2026-09-14, #3521 decision-trace v1)', () => {
  it('a real held #3521 produces BOTH the ordinary held note and a matching skip trace entry', () => {
    const out = planTick({
      state: { queue: [{ num: 3521 }], lanes: [], prs: [] },
      plan: { launch: [], held: [{ num: 3521, reason: 'overlaps lane-2' }] },
      freeLanes: [],
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.decisionTrace).toEqual(expect.arrayContaining([
      { kind: 'skip', num: 3521, reason: 'overlaps lane-2', text: 'skipped #3521: overlaps lane-2' },
    ]));
  });
});

describe('advanceHeldStall — the durable, tick-to-tick held-stall counter (2026-09-14, #3521/lane-2 incident)', () => {
  it('starts a fresh item at 1 tick, below threshold — not yet stalled', () => {
    const { nextHeldStall, stalled } = advanceHeldStall({}, [{ num: 3521, reason: 'overlaps lane-2' }], 3);
    expect(nextHeldStall).toEqual({ '3521': { reason: 'overlaps lane-2', ticks: 1 } });
    expect(stalled).toEqual([]);
  });

  it('increments while the SAME reason persists, and crosses the threshold on the Nth tick', () => {
    let held = {};
    let out;
    for (let i = 0; i < 3; i += 1) {
      out = advanceHeldStall(held, [{ num: 3521, reason: 'overlaps lane-2' }], 3);
      held = out.nextHeldStall;
    }
    expect(held['3521'].ticks).toBe(3);
    expect(out.stalled).toEqual([{ num: 3521, reason: 'overlaps lane-2', ticks: 3 }]);
  });

  it('resets to 1 when the reason CHANGES — a different rival is a different episode, not a continuation', () => {
    const prev = { '3521': { reason: 'overlaps lane-2', ticks: 5 } };
    const { nextHeldStall, stalled } = advanceHeldStall(prev, [{ num: 3521, reason: 'overlaps lane-5' }], 3);
    expect(nextHeldStall['3521']).toEqual({ reason: 'overlaps lane-5', ticks: 1 });
    expect(stalled).toEqual([]);
  });

  it('drops an item that cleared (no longer among heldEntries) — no lingering phantom stall', () => {
    const prev = { '3521': { reason: 'overlaps lane-2', ticks: 5 } };
    const { nextHeldStall, stalled } = advanceHeldStall(prev, [], 3);
    expect(nextHeldStall).toEqual({});
    expect(stalled).toEqual([]);
  });

  it('tolerates a missing/malformed prevHeldStall (fresh start, never throws)', () => {
    expect(() => advanceHeldStall(null, [{ num: 1, reason: 'no free lane' }], 3)).not.toThrow();
    expect(() => advanceHeldStall(undefined, [], 3)).not.toThrow();
  });

  it('defaults the threshold to DEFAULT_STALL_TICKS when not given', () => {
    let held = {};
    let out;
    for (let i = 0; i < DEFAULT_STALL_TICKS; i += 1) {
      out = advanceHeldStall(held, [{ num: 1, reason: 'no free lane' }]);
      held = out.nextHeldStall;
    }
    expect(out.stalled).toEqual([{ num: 1, reason: 'no free lane', ticks: DEFAULT_STALL_TICKS }]);
  });
});

describe('planTick — self-diagnosed stall (2026-09-14, #3521/lane-2 incident): a held item wedged on the same reason for N ticks running gets its own explicit `stalled` note + structured decisions.stalled, and the counter is threaded durably via nextState.heldStall', () => {
  it('reproduces the incident: #3521 held `overlaps lane-2` for 3 straight ticks fires a self-reported stall', () => {
    const state = { queue: [{ num: 3521 }], lanes: [], prs: [] };
    const plan = { launch: [], held: [{ num: 3521, reason: 'overlaps lane-2' }] };
    let bookkeeping = { tick: 0 };
    let out;
    for (let i = 0; i < 3; i += 1) {
      out = planTick({ state, plan, freeLanes: [], bookkeeping });
      bookkeeping = out.nextState;
    }
    expect(out.decisions.stalled).toEqual([{ num: 3521, reason: 'overlaps lane-2', ticks: 3 }]);
    expect(out.decisions.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'stalled', num: 3521, reason: 'overlaps lane-2', ticks: 3 }),
    ]));
    // The counter is a real, threaded bookkeeping field — not recomputed from scratch each call.
    expect(out.nextState.heldStall).toEqual({ '3521': { reason: 'overlaps lane-2', ticks: 3 } });
  });

  it('does NOT fire before the threshold — tick 1 and 2 show the ordinary `held` note only, no `stalled` note', () => {
    const state = { queue: [{ num: 3521 }], lanes: [], prs: [] };
    const plan = { launch: [], held: [{ num: 3521, reason: 'overlaps lane-2' }] };
    const out = planTick({ state, plan, freeLanes: [], bookkeeping: { tick: 0 } });
    expect(out.decisions.stalled).toEqual([]);
    expect(out.decisions.notes.some((n) => n.kind === 'stalled')).toBe(false);
    expect(out.decisions.notes.some((n) => n.kind === 'held' && n.num === 3521)).toBe(true);
  });

  it('a custom config.stallTicks lowers/raises the threshold', () => {
    const state = { queue: [{ num: 7 }], lanes: [], prs: [] };
    const plan = { launch: [], held: [{ num: 7, reason: 'no free lane' }] };
    const out = planTick({ state, plan, freeLanes: [], bookkeeping: { tick: 0 }, config: { stallTicks: 1 } });
    expect(out.decisions.stalled).toEqual([{ num: 7, reason: 'no free lane', ticks: 1 }]);
  });

  it('clearing the hold (the item now launches) resets the durable counter — no stale carry-over', () => {
    const state = { queue: [{ num: 3521, buildQueued: true }], lanes: [], prs: [] };
    let bookkeeping = { tick: 0 };
    let out;
    for (let i = 0; i < 3; i += 1) {
      out = planTick({ state, plan: { launch: [], held: [{ num: 3521, reason: 'overlaps lane-2' }] }, freeLanes: [], bookkeeping });
      bookkeeping = out.nextState;
    }
    expect(out.decisions.stalled).toHaveLength(1); // stalled at tick 3, as above
    // Now the overlap clears and #3521 launches — the stall state must not linger.
    out = planTick({ state, plan: { launch: [{ num: 3521, lane: 4 }], held: [] }, freeLanes: [4], bookkeeping });
    expect(out.decisions.stalled).toEqual([]);
    expect(out.nextState.heldStall).toEqual({});
  });

  it('excludes reasons that already have their own dedicated lifecycle note (needs-slice/needs-decision/unshaped-no-scope) — mirrors HELD_NOTE_EXCLUDED_REASONS', () => {
    const state = { queue: [{ num: 42 }], lanes: [], prs: [] };
    let bookkeeping = { tick: 0 };
    let out;
    for (const reason of HELD_NOTE_EXCLUDED_REASONS) {
      bookkeeping = { tick: 0 };
      for (let i = 0; i < 5; i += 1) {
        out = planTick({ state, plan: { launch: [], held: [{ num: 42, reason }] }, freeLanes: [], bookkeeping });
        bookkeeping = out.nextState;
      }
      expect(out.decisions.stalled).toEqual([]);
    }
  });
});

describe('planTick — waiting-for-capacity notes (#3461 admission queue)', () => {
  it('surfaces one note per waiting entry, resolving num off state.lanes by lane', () => {
    const out = planTick({
      state: { queue: [], lanes: [{ lane: 7, num: 55 }], prs: [] },
      plan: { launch: [] },
      freeLanes: [],
      bookkeeping: { tick: 0 },
      admission: { cap: 2, waiting: [{ owner: '/lanes/lane-7', lane: '7', requestedAt: '2026-09-03T00:00:00.000Z' }] },
    });
    const notes = out.decisions.notes.filter((n) => n.kind === 'waiting-for-capacity');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'waiting-for-capacity', num: 55, lane: '7' });
    expect(notes[0].text).toContain('#55');
    expect(notes[0].text).toContain('cap 2');
  });

  it('falls back to a caller-supplied num when no lane→num mapping exists, and to the owner when there is no lane', () => {
    const out = planTick({
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [] },
      freeLanes: [],
      bookkeeping: { tick: 0 },
      admission: { cap: 1, waiting: [{ owner: 'checkout-owner-x', num: 88 }] },
    });
    const notes = out.decisions.notes.filter((n) => n.kind === 'waiting-for-capacity');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ num: 88, lane: null });
    expect(notes[0].text).toContain('checkout-owner-x');
  });

  it('clears for free once the entry is gone — no bookkeeping persists a stale wait', () => {
    const withWait = planTick({
      state: { queue: [], lanes: [], prs: [] }, plan: { launch: [] }, freeLanes: [], bookkeeping: { tick: 0 },
      admission: { cap: 1, waiting: [{ owner: 'x', num: 1 }] },
    });
    expect(withWait.decisions.notes.some((n) => n.kind === 'waiting-for-capacity')).toBe(true);
    const cleared = planTick({
      state: { queue: [], lanes: [], prs: [] }, plan: { launch: [] }, freeLanes: [], bookkeeping: withWait.nextState,
      admission: { cap: 1, waiting: [] },
    });
    expect(cleared.decisions.notes.some((n) => n.kind === 'waiting-for-capacity')).toBe(false);
  });

  it('defaults to no notes when admission is omitted entirely (backward-compatible)', () => {
    const out = planTick({
      state: { queue: [], lanes: [], prs: [] }, plan: { launch: [] }, freeLanes: [], bookkeeping: { tick: 0 },
    });
    expect(out.decisions.notes.some((n) => n.kind === 'waiting-for-capacity')).toBe(false);
  });
});

describe('buildStatusLine — the terse per-tick line (SKILL §5)', () => {
  it('counts building / preparing / fixing / queued / parked and the health verdict', () => {
    const line = buildStatusLine({
      queue: [{ num: 10, buildQueued: true }, { num: 11, buildQueued: true }],
      lanes: [{ lane: 4, num: 12 }],
      prs: [{ num: 13, prNumber: 99, state: 'OPEN', labels: ['review:human'] }],
      health: { verdict: 'ok' },
      liveBuildGuards: [{ num: 10, lane: 5 }],
      livePrepareGuards: [{ num: 20, lane: 6 }],
      liveFixGuards: [{ pr: 99, num: 13 }],
      liveCiHealGuards: [{ pr: 98, num: 14 }],
      launchedNums: [10, 12, 13, 14, 20],
    });
    // building = {10 (guard), 12 (active lane)} = 2; preparing = 1; fixing = 1; healing = 1; parked = 1 (#13).
    expect(line).toContain('2 building');
    expect(line).toContain('1 preparing');
    expect(line).toContain('1 fixing');
    expect(line).toContain('1 healing');
    expect(line).toContain('1 parked');
    expect(line).toContain('health ok');
  });

  it('appends infra-blocked count and a warn flag with the stalled lanes', () => {
    const line = buildStatusLine({
      queue: [], lanes: [], prs: [],
      health: { verdict: 'warn', stalled: [{ lane: 7 }] },
      infraBlocked: [{ num: 80 }],
    });
    expect(line).toContain('1 infra-blocked');
    expect(line).toContain('health warn');
    expect(line).toContain('lane-7');
  });
});

describe('computeTickCounts — the structured tallies behind buildStatusLine (#3398)', () => {
  it('matches the same inputs buildStatusLine renders, as numbers rather than text', () => {
    const inputs = {
      queue: [{ num: 10, buildQueued: true }, { num: 11, buildQueued: true }],
      lanes: [{ lane: 4, num: 12 }],
      prs: [{ num: 13, prNumber: 99, state: 'OPEN', labels: ['review:human'] }],
      health: { verdict: 'ok' },
      liveBuildGuards: [{ num: 10, lane: 5 }],
      livePrepareGuards: [{ num: 20, lane: 6 }],
      liveFixGuards: [{ pr: 99, num: 13 }],
      liveCiHealGuards: [{ pr: 98, num: 14 }],
      launchedNums: [10, 12, 13, 14, 20],
    };
    expect(computeTickCounts(inputs)).toEqual({ building: 2, preparing: 1, fixing: 1, healing: 1, queued: 1, parked: 1, verdict: 'ok' });
    expect(buildStatusLine(inputs)).toContain('1 queued'); // the two never disagree — same computation, one call site each
  });

  it('is total on no inputs at all', () => {
    expect(computeTickCounts()).toEqual({ building: 0, preparing: 0, fixing: 0, healing: 0, queued: 0, parked: 0, verdict: 'ok' });
  });
});

describe('planTick — maxConcurrentLanes (#xupukxa, live incident 2026-09-07: 19 builds + 23 prepare-scope in one tick)', () => {
  it('omitted config — unlimited, byte-for-byte the pre-#xupukxa behavior', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], unshaped: [{ num: 20 }, { num: 21 }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4, 5, 6],
      bookkeeping: { tick: 0 },
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
    expect(out.decisions.spawnPrepareScope.map((s) => s.num).sort()).toEqual([20, 21]);
  });

  it('a tight cap trims prepare/decision spawns AFTER admitting builds, sharing one budget', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], unshaped: [{ num: 20 }, { num: 21 }, { num: 22 }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4, 5, 6, 7],
      bookkeeping: { tick: 0 },
      config: { maxConcurrentLanes: 2 }, // 1 build admitted; room left for prepares = 2 - 0 (prior active) - 1 (build) = 1
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
    expect(out.decisions.spawnPrepareScope).toHaveLength(1);
    expect(out.decisions.notes.filter((n) => n.kind === 'capacity-cap').length).toBeGreaterThan(0);
  });

  it('caps builds themselves when the plan alone would exceed the ceiling (defense-in-depth vs. a stale/race plan)', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }, { num: 11, buildQueued: true }, { num: 12, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }, { num: 11, lane: 5 }, { num: 12, lane: 6 }] },
      freeLanes: [4, 5, 6],
      bookkeeping: { tick: 0 },
      config: { maxConcurrentLanes: 2 },
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }, { num: 11, lane: 5 }]);
    expect(out.decisions.suppressedBuilds).toEqual(
      expect.arrayContaining([{ num: 12, lane: 6, by: 'capacity-cap' }]),
    );
    expect(out.decisions.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'capacity-cap', num: 12 })]),
    );
  });

  it('counts already-active lanes (state.lanes) against the cap, not just this tick’s new spawns', () => {
    const out = planTick({
      state: { queue: [], unshaped: [{ num: 20 }], lanes: [{ lane: 1, num: 1 }, { lane: 2, num: 2 }], prs: [] },
      plan: { launch: [] },
      freeLanes: [3],
      bookkeeping: { tick: 0 },
      config: { maxConcurrentLanes: 2 }, // already 2 active — no room left for the prepare
    });
    expect(out.decisions.spawnPrepareScope).toEqual([]);
    expect(out.decisions.notes.some((n) => n.kind === 'capacity-cap')).toBe(true);
  });

  it('a cap comfortably above demand changes nothing observable', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], unshaped: [{ num: 20 }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
      config: { maxConcurrentLanes: 50 },
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 20, lane: 5 }]);
    expect(out.decisions.notes.some((n) => n.kind === 'capacity-cap')).toBe(false);
  });

  it('#4347 — collapses every withheld free lane into ONE summary note naming the real active count and room, not one note per lane (live incident 2026-09-28: 68 per-lane notes read as "8 lanes active" when only 2 were)', () => {
    const out = planTick({
      state: {
        queue: [],
        unshaped: Array.from({ length: 6 }, (_, i) => ({ num: 20 + i })), // 6 launchable prepare-scope items
        lanes: [{ lane: 1, num: 1 }, { lane: 2, num: 2 }], // 2 leased lanes already active
        prs: [],
      },
      plan: { launch: [] },
      freeLanes: Array.from({ length: 20 }, (_, i) => 10 + i), // 20 free lanes, only 6 fit under room
      bookkeeping: { tick: 0 },
      config: { maxConcurrentLanes: 8 }, // room = 8 - 2 = 6
    });
    // all 6 launchable items got a lane — the fix must never shrink what actually gets assigned
    expect(out.decisions.spawnPrepareScope).toHaveLength(6);
    // Filter on `kind` ALONE (never also on `lanes`) — this is what actually defends the "ONE note, not one
    // per lane" guarantee. A regression back to a `lane`-per-entry shape must fail this assertion, not slip
    // past it because the filter only ever looked at the new shape (#4347 review round 1).
    const capNotes = out.decisions.notes.filter((n) => n.kind === 'capacity-cap');
    expect(capNotes).toHaveLength(1); // exactly ONE note, never one per withheld lane
    expect(Array.isArray(capNotes[0].lanes)).toBe(true);
    // Full boundaries, never a bare number — `toContain('2 active')` would also pass on "12 active" and
    // `toContain('room 6')` on "room 60" (#4347 review round 2 red-team, standards-conformance).
    expect(capNotes[0].text).toContain('(2 active)');
    expect(capNotes[0].text).toContain('room 6 of cap 8');
    expect(capNotes[0].lanes).toHaveLength(14); // 20 free - 6 assigned = 14 withheld, still named (nothing lost)
  });

  it('#4347 — the note\'s active count folds in THIS tick\'s own build launches, not only already-leased lanes (review round 2, standards-conformance: the prior case alone never exercised `launched.spawn.length` > 0)', () => {
    const out = planTick({
      state: {
        queue: [{ num: 10, buildQueued: true }], // 1 build launches THIS tick
        unshaped: Array.from({ length: 6 }, (_, i) => ({ num: 20 + i })),
        lanes: [{ lane: 1, num: 1 }], // only 1 lane already active BEFORE this tick
        prs: [],
      },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4, ...Array.from({ length: 20 }, (_, i) => 10 + i)], // lane 4 for the build + 20 for prepare
      bookkeeping: { tick: 0 },
      config: { maxConcurrentLanes: 8 }, // active = 1 leased + 1 build launch = 2 → room = 8 - 2 = 6
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
    const capNotes = out.decisions.notes.filter((n) => n.kind === 'capacity-cap');
    expect(capNotes).toHaveLength(1);
    // "2 active" here is 1 pre-existing lease + 1 build THIS tick — a note that dropped `launched.spawn.length`
    // would read "(1 active)" and "room 7" instead, and these full-boundary assertions would catch it.
    expect(capNotes[0].text).toContain('(2 active)');
    expect(capNotes[0].text).toContain('room 6 of cap 8');
  });
});

describe('planTick — loadAdmission (#4076): a SECOND, ORTHOGONAL gate beside the fixed lane ceiling', () => {
  it('omitted / held:false — changes nothing observable (the default, byte-for-byte pre-#4076 behavior)', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], unshaped: [{ num: 20 }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
      // no loadAdmission input at all
    });
    expect(out.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 20, lane: 5 }]);
    expect(out.decisions.notes.some((n) => n.kind === 'load-cap')).toBe(false);

    const outExplicitFalse = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], unshaped: [{ num: 20 }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
      loadAdmission: { held: false, idlePct: 45, minIdlePct: 15, pressureLevel: 1, load1: 3, cores: 12, perCore: 0.25, backstopPerCore: 4 },
    });
    expect(outExplicitFalse.decisions.spawnBuilds).toEqual([{ num: 10, lane: 4 }]);
    expect(outExplicitFalse.decisions.spawnPrepareScope).toEqual([{ num: 20, lane: 5 }]);
    expect(outExplicitFalse.decisions.notes.some((n) => n.kind === 'load-cap')).toBe(false);
  });

  it('held:true withholds a build the fixed lane ceiling alone would have admitted, tagged distinctly from capacity-cap', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4],
      bookkeeping: { tick: 0 },
      config: { maxConcurrentLanes: 50 }, // plenty of room under the fixed ceiling
      loadAdmission: { held: true, idlePct: 12, minIdlePct: 15, pressureLevel: 1, load1: 20, cores: 12, perCore: 1.6667, backstopPerCore: 4, reason: 'cpu idle 12% (<15%)' },
    });
    expect(out.decisions.spawnBuilds).toEqual([]);
    expect(out.decisions.suppressedBuilds).toEqual(expect.arrayContaining([{ num: 10, lane: 4, by: 'load-cap' }]));
    expect(out.decisions.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'load-cap', num: 10, text: expect.stringContaining('cpu idle 12% (<15%)') }),
    ]));
    // never mislabeled as the fixed-ceiling reason — the two gates are distinct, the fix differs
    expect(out.decisions.notes.some((n) => n.kind === 'capacity-cap')).toBe(false);
  });

  it('held:true ALSO withholds prepare/fix/ci-heal spawns — the free-lane pool they draw from goes to zero', () => {
    const out = planTick({
      state: { queue: [], unshaped: [{ num: 20 }, { num: 21 }], lanes: [], prs: [] },
      plan: { launch: [] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
      loadAdmission: { held: true, idlePct: 8, minIdlePct: 15, pressureLevel: 1, load1: 30, cores: 12, perCore: 2.5, backstopPerCore: 4, reason: 'cpu idle 8% (<15%)' },
    });
    expect(out.decisions.spawnPrepareScope).toEqual([]);
    expect(out.decisions.notes.some((n) => n.kind === 'load-cap' && n.lane != null)).toBe(true);
    // both withheld free lanes are named, each with the real reading embedded
    const laneNotes = out.decisions.notes.filter((n) => n.kind === 'load-cap' && n.lane != null);
    expect(laneNotes.map((n) => n.lane).sort()).toEqual([4, 5]);
    expect(laneNotes[0].text).toContain('cpu idle 8% (<15%)');
  });

  it('is ORTHOGONAL to the fixed lane ceiling: both gates can fire in the SAME tick, on DIFFERENT survivors', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }, { num: 11, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }, { num: 11, lane: 5 }] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0 },
      config: { maxConcurrentLanes: 1 }, // capacity-cap trims #11 first
      loadAdmission: { held: true, idlePct: 12, minIdlePct: 15, pressureLevel: 1, load1: 20, cores: 12, perCore: 1.6667, backstopPerCore: 4, reason: 'cpu idle 12% (<15%)' }, // load-cap then trims the survivor, #10
    });
    expect(out.decisions.spawnBuilds).toEqual([]);
    expect(out.decisions.suppressedBuilds).toEqual(expect.arrayContaining([
      { num: 11, lane: 5, by: 'capacity-cap' },
      { num: 10, lane: 4, by: 'load-cap' },
    ]));
    expect(out.decisions.notes.some((n) => n.kind === 'capacity-cap' && n.num === 11)).toBe(true);
    expect(out.decisions.notes.some((n) => n.kind === 'load-cap' && n.num === 10)).toBe(true);
  });

  it('holds nothing when there is nothing to hold — a quiet tick with load held produces no spurious notes', () => {
    const out = planTick({
      state: { queue: [], lanes: [], prs: [] },
      plan: { launch: [] },
      freeLanes: [],
      bookkeeping: { tick: 0 },
      loadAdmission: { held: true, idlePct: 12, minIdlePct: 15, pressureLevel: 1, load1: 20, cores: 12, perCore: 1.6667, backstopPerCore: 4, reason: 'cpu idle 12% (<15%)' },
    });
    expect(out.decisions.spawnBuilds).toEqual([]);
    expect(out.decisions.notes.some((n) => n.kind === 'load-cap')).toBe(false);
  });

  it('a missing numeric reading (e.g. a bypass) still holds correctly and falls back to a generic note', () => {
    const out = planTick({
      state: { queue: [{ num: 10, buildQueued: true }], lanes: [], prs: [] },
      plan: { launch: [{ num: 10, lane: 4 }] },
      freeLanes: [4],
      bookkeeping: { tick: 0 },
      loadAdmission: { held: true }, // no idlePct/pressureLevel/load1/cores/perCore/reason at all
    });
    expect(out.decisions.spawnBuilds).toEqual([]);
    expect(out.decisions.notes.some((n) => n.kind === 'load-cap' && n.num === 10)).toBe(true);
  });
});

describe('planTick — manual dispatch-pause (#3609): holds ALL new prepare/fix/ci-heal spawns, never touches in-flight work', () => {
  const changesPr = (pr, num) => ({ num, prNumber: pr, state: 'OPEN', labels: ['review:changes'] });
  const redPr = (pr, num) => ({ num, prNumber: pr, state: 'OPEN', ci: 'fail', labels: ['ready-to-merge'] });

  it('omitted / false — unchanged from today (spawns everything it normally would)', () => {
    const out = planTick({
      state: { queue: [], unshaped: [{ num: 20 }], decisions: [{ num: 30, prepared: false }], lanes: [], prs: [changesPr(99, 40), redPr(98, 41)] },
      plan: { launch: [] },
      freeLanes: [4, 5, 6, 7],
      bookkeeping: { tick: 0, launchedNums: [40, 41] },
    });
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 20, lane: 4 }]);
    expect(out.decisions.spawnPrepareDecision).toEqual([{ num: 30, lane: 5 }]);
    expect(out.decisions.spawnFixes).toEqual([{ pr: 99, num: 40, lane: 6 }]);
    expect(out.decisions.spawnCiHeals).toEqual([{ pr: 98, num: 41, lane: 7, reason: 'red-ci' }]);
  });

  it('paused — every new prepare/fix/ci-heal spawn is held; build launches are ALSO empty because dispatch-plan.mjs already emptied plan.launch', () => {
    const out = planTick({
      state: { queue: [], unshaped: [{ num: 20 }], decisions: [{ num: 30, prepared: false }], lanes: [], prs: [changesPr(99, 40), redPr(98, 41)] },
      // dispatch-plan.mjs's own IO shell already read the SAME pause marker and emptied `plan.launch`,
      // relabeling what would have launched `dispatch-paused` — mirrored here as the realistic composed input.
      plan: { launch: [], held: [{ num: 10, reason: 'dispatch-paused' }] },
      freeLanes: [4, 5, 6, 7],
      bookkeeping: { tick: 0, launchedNums: [40, 41] },
      dispatchPaused: true,
      dispatchPausedReason: 'operator emergency pause',
    });
    expect(out.decisions.spawnBuilds).toEqual([]);
    expect(out.decisions.spawnPrepareScope).toEqual([]);
    expect(out.decisions.spawnPrepareDecision).toEqual([]);
    expect(out.decisions.spawnFixes).toEqual([]);
    expect(out.decisions.spawnCiHeals).toEqual([]);
    // the aggregate note carries the operator's own reason.
    expect(out.decisions.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'dispatch-paused', text: expect.stringContaining('operator emergency pause') })]),
    );
    // the per-item `plan.held` row still surfaces too (mirrors dispatch-plan.mjs's own CLI text).
    expect(out.decisions.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'held', num: 10, reason: 'dispatch-paused' })]),
    );
  });

  it('paused with no reason given — the aggregate note still fires, without a parenthetical', () => {
    const out = planTick({
      state: { queue: [], unshaped: [{ num: 20 }], lanes: [], prs: [] },
      plan: { launch: [] },
      freeLanes: [4],
      bookkeeping: { tick: 0 },
      dispatchPaused: true,
    });
    const note = out.decisions.notes.find((n) => n.kind === 'dispatch-paused');
    expect(note).toBeTruthy();
    expect(note.text).toBe('⏸ dispatch paused — no new prepare/fix/ci-heal spawns this tick');
  });

  it('NEVER touches an already-running lane/guard — a live fix-guard entry retires normally (claim/TTL) while paused', () => {
    // A live fix-guard entry from a PRIOR tick (before the pause was set) whose PR no longer carries
    // review:changes (resolved) must still retire normally — guard RETIREMENT is a property of in-flight work,
    // not of new dispatch, so pausing must not freeze it.
    const out = planTick({
      state: { queue: [], unshaped: [], lanes: [], prs: [{ num: 40, prNumber: 99, state: 'OPEN', labels: [] }] },
      plan: { launch: [] },
      freeLanes: [],
      bookkeeping: { tick: 5, fixGuards: [{ pr: 99, num: 40, lane: 3, spawnedTick: 0, claimed: true }] },
      dispatchPaused: true,
    });
    expect(out.decisions.retireGuards.fix.some((r) => r.pr === 99)).toBe(true);
    expect(out.nextState.fixGuards).toEqual([]); // retired — the label cleared, not held hostage by the pause
  });

  it('fixAttempts / ciHealAttempts pass through UNCHANGED while paused (no new attempt is spawned to count)', () => {
    const out = planTick({
      state: { queue: [], unshaped: [], lanes: [], prs: [changesPr(99, 40), redPr(98, 41)] },
      plan: { launch: [] },
      freeLanes: [4, 5],
      bookkeeping: { tick: 0, launchedNums: [40, 41], fixAttempts: { 99: 1 }, ciHealAttempts: { 98: 1 } },
      dispatchPaused: true,
    });
    expect(out.nextState.fixAttempts).toEqual({ 99: 1 });
    expect(out.nextState.ciHealAttempts).toEqual({ 98: 1 });
  });
});

// #xr4ygg7 (multi-repo slice 9, we:reports/2026-09-23-conveyor-multi-repo-gap-map.md) — the free-lane read must
// reflect the TARGET repo's own pool, not always WE's (the gap-map's "tick capacity counts only the WE pool"
// row, `we:scripts/conveyor/tick-core.mjs:1472` at the time the item was filed).
describe('lanePoolListArgsForRepo — the free-lane read now honors --repo, exactly like every other subprocess call', () => {
  it('no --repo flag at all (today\'s every real invocation) → no change, byte-identical to before this item', () => {
    expect(lanePoolListArgsForRepo(undefined, repoProfile)).toEqual([]);
    expect(lanePoolListArgsForRepo(true, repoProfile)).toEqual([]); // a bare `--repo` (no `=value`) is not a string
  });
  it('--repo resolving to the WE profile itself → no change (lane-pool.mjs already defaults to the WE pool)', () => {
    expect(lanePoolListArgsForRepo('we', repoProfile)).toEqual([]);
    expect(lanePoolListArgsForRepo('web-everything/web-everything', repoProfile)).toEqual([]);
  });
  it('--repo naming a sibling repo → the matching --repo=<lanePoolRepo> argument, scoping capacity to ITS pool', () => {
    expect(lanePoolListArgsForRepo('plateau-app', repoProfile)).toEqual([`--repo=${repoProfile('plateau-app').lanePoolRepo}`]);
    expect(lanePoolListArgsForRepo('frontierui', repoProfile)).toEqual([`--repo=${repoProfile('frontierui').lanePoolRepo}`]);
    // Accepts every vocabulary repoProfile itself accepts (gh slug, slug tag, scope prefix) — not re-derived here.
    expect(lanePoolListArgsForRepo('plateauapp/plateau-app', repoProfile)).toEqual([`--repo=${repoProfile('plateau-app').lanePoolRepo}`]);
    expect(lanePoolListArgsForRepo('fui', repoProfile)).toEqual([`--repo=${repoProfile('frontierui').lanePoolRepo}`]);
  });
  it('an unresolvable --repo value → [] (falls back to lane-pool.mjs\'s own WE-cwd default, never throws)', () => {
    expect(lanePoolListArgsForRepo('not-a-real-repo', repoProfile)).toEqual([]);
  });
  it('a missing/non-function resolver → [] (never guesses)', () => {
    expect(lanePoolListArgsForRepo('plateau-app', undefined)).toEqual([]);
    expect(lanePoolListArgsForRepo('plateau-app', null)).toEqual([]);
  });
});

describe('planTick — KIND-SCOPED dispatch-pause (epic #3383): hold NEW-item kinds, let already-open-PR kinds run', () => {
  const changesPr = (pr, num) => ({ num, prNumber: pr, state: 'OPEN', labels: ['review:changes'] });
  const redPr = (pr, num) => ({ num, prNumber: pr, state: 'OPEN', ci: 'fail', labels: ['ready-to-merge'] });
  // One candidate per spawn kind this core plans, all simultaneously ready, with a lane each.
  const everyKindReady = {
    state: {
      queue: [], unshaped: [{ num: 20 }], decisions: [{ num: 30, prepared: false }], lanes: [],
      prs: [changesPr(99, 40), redPr(98, 41)],
    },
    plan: { launch: [], held: [{ num: 50, reason: 'needs-investigation' }] },
    freeLanes: [4, 5, 6, 7, 8],
    bookkeeping: { tick: 0, launchedNums: [40, 41] },
  };

  it('BACKWARD COMPAT: `dispatchPaused: true` with NO kinds holds every kind — old-format marker / boolean-only caller', () => {
    for (const kinds of [undefined, null, []]) {
      const out = planTick({ ...everyKindReady, dispatchPaused: true, dispatchPausedKinds: kinds });
      expect(out.decisions.spawnPrepareScope).toEqual([]);
      expect(out.decisions.spawnPrepareDecision).toEqual([]);
      expect(out.decisions.spawnInvestigations).toEqual([]);
      expect(out.decisions.spawnFixes).toEqual([]);
      expect(out.decisions.spawnCiHeals).toEqual([]);
      // …and the note keeps its pre-scope wording verbatim.
      expect(out.decisions.notes.find((n) => n.kind === 'dispatch-paused').text)
        .toBe('⏸ dispatch paused — no new prepare/fix/ci-heal spawns this tick');
    }
  });

  it('THE OPERATOR CASE — new-item kinds held, fix + ci-heal still spawn for already-open PRs', () => {
    const out = planTick({
      ...everyKindReady,
      dispatchPaused: true,
      dispatchPausedKinds: ['build', 'prepare', 'prepare-decision', 'investigate'],
      dispatchPausedReason: 'Conserve Claude usage-limit tokens',
    });
    expect(out.decisions.spawnBuilds).toEqual([]);
    expect(out.decisions.spawnPrepareScope).toEqual([]);
    expect(out.decisions.spawnPrepareDecision).toEqual([]);
    expect(out.decisions.spawnInvestigations).toEqual([]);
    // …while the two "act on an already-open PR" kinds proceed, taking the lanes the held kinds did not.
    expect(out.decisions.spawnFixes).toEqual([{ pr: 99, num: 40, lane: 4 }]);
    expect(out.decisions.spawnCiHeals).toEqual([{ pr: 98, num: 41, lane: 5, reason: 'red-ci' }]);
  });

  it('a held kind consumes NO lane — an unheld sibling gets the lane the held one would have taken', () => {
    const out = planTick({
      ...everyKindReady,
      freeLanes: [4], // exactly one lane for the whole tick
      dispatchPaused: true,
      dispatchPausedKinds: ['prepare', 'prepare-decision', 'investigate'],
    });
    expect(out.decisions.spawnPrepareScope).toEqual([]);
    expect(out.decisions.spawnFixes).toEqual([{ pr: 99, num: 40, lane: 4 }]);
  });

  it('the INVERSE scope — fix/ci-heal held while the prepare family keeps spawning', () => {
    const out = planTick({ ...everyKindReady, dispatchPaused: true, dispatchPausedKinds: ['fix', 'ci-heal'] });
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 20, lane: 4 }]);
    expect(out.decisions.spawnPrepareDecision).toEqual([{ num: 30, lane: 5 }]);
    expect(out.decisions.spawnInvestigations).toEqual([{ num: 50, lane: 6 }]);
    expect(out.decisions.spawnFixes).toEqual([]);
    expect(out.decisions.spawnCiHeals).toEqual([]);
  });

  it('each prepare-family kind is held INDEPENDENTLY of its two siblings', () => {
    const out = planTick({ ...everyKindReady, dispatchPaused: true, dispatchPausedKinds: ['prepare-decision'] });
    expect(out.decisions.spawnPrepareDecision).toEqual([]);
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 20, lane: 4 }]);
    expect(out.decisions.spawnInvestigations).toEqual([{ num: 50, lane: 5 }]);
    expect(out.decisions.spawnFixes).toEqual([{ pr: 99, num: 40, lane: 6 }]);
  });

  it('kinds WITHOUT `dispatchPaused` arm nothing, and no note fires', () => {
    const out = planTick({ ...everyKindReady, dispatchPaused: false, dispatchPausedKinds: ['fix', 'ci-heal'] });
    // lanes 4/5/6 go to prepare/prepare-decision/investigate, so an unarmed scope leaves fix on lane 7.
    expect(out.decisions.spawnFixes).toEqual([{ pr: 99, num: 40, lane: 7 }]);
    expect(out.decisions.notes.some((n) => n.kind === 'dispatch-paused')).toBe(false);
  });

  it('the NOTE names the kinds a SCOPED pause actually holds — never a flat "dispatch paused" while fix runs', () => {
    const out = planTick({
      ...everyKindReady,
      dispatchPaused: true,
      dispatchPausedKinds: ['build', 'prepare', 'prepare-decision', 'investigate'],
      dispatchPausedReason: 'conserve tokens',
    });
    const note = out.decisions.notes.find((n) => n.kind === 'dispatch-paused');
    expect(note.text).toContain('build, prepare, prepare-decision, investigate');
    expect(note.text).toContain('prepare/prepare-decision/investigate');
    expect(note.text).toContain('conserve tokens');
    expect(note.text).not.toContain('/fix/');
  });

  it('a BUILD-ONLY pause says builds are held upstream rather than claiming this tick withheld spawns', () => {
    const out = planTick({ ...everyKindReady, dispatchPaused: true, dispatchPausedKinds: ['build'] });
    const note = out.decisions.notes.find((n) => n.kind === 'dispatch-paused');
    expect(note.text).toContain('held upstream');
    expect(out.decisions.spawnPrepareScope).toEqual([{ num: 20, lane: 4 }]);
    expect(out.decisions.spawnFixes).toEqual([{ pr: 99, num: 40, lane: 7 }]);
  });

  it('a scope naming ALL SEVEN kinds is indistinguishable from a blanket pause', () => {
    const kinds = ['build', 'prepare', 'prepare-decision', 'prepare-item', 'investigate', 'fix', 'ci-heal'];
    const scoped = planTick({ ...everyKindReady, dispatchPaused: true, dispatchPausedKinds: kinds });
    const blanket = planTick({ ...everyKindReady, dispatchPaused: true });
    expect(scoped).toEqual(blanket);
  });

  it('a scoped pause still never touches in-flight work — a live fix guard retires normally while fix is held', () => {
    const out = planTick({
      state: { queue: [], unshaped: [], lanes: [], prs: [{ num: 40, prNumber: 99, state: 'OPEN', labels: [] }] },
      plan: { launch: [] },
      freeLanes: [],
      bookkeeping: { tick: 5, fixGuards: [{ pr: 99, num: 40, lane: 3, spawnedTick: 0, claimed: true }] },
      dispatchPaused: true,
      dispatchPausedKinds: ['fix'],
    });
    expect(out.decisions.retireGuards.fix.some((r) => r.pr === 99)).toBe(true);
    expect(out.nextState.fixGuards).toEqual([]);
  });
});

// #3794 live case, 2026-10-04.
it('refunds the durable and in-session heal floor without refunding again on the next tick', () => {
  const args = { prs: [{ num: 40, prNumber: 99, state: 'OPEN', ci: 'fail', labels: ['ready-to-merge'] }],
    launchedNums: [40], availableLanes: [5], prCiHealCounts: { 99: 0 }, prCiHealRefunds: { 99: 3 } };
  const first = planCiHealSpawns({ ...args, ciHealAttempts: { 99: 3 } });
  expect(first.spawns[0]).toMatchObject({ pr: 99, refunded: 3 });
  expect(first.ciHealAttempts[99]).toBe(4);
  const next = planCiHealSpawns({ ...args, ciHealAttempts: first.ciHealAttempts });
  expect(next.ciHealAttempts[99]).toBe(5);
  expect(planCiHealSpawns({ ...args, ciHealAttempts: { 99: 6 } }).notes[0])
    .toMatchObject({ kind: 'ci-heal-exhausted', attempts: 3, refunded: 3 });
});

describe('card 80 — prepare just in time', () => {
  const held = (num, reason) => ({ num, reason });
  const tick = (config, extraHeld = []) => planTick({
    state: { queue: [{ num: '1' }, { num: '2' }, { num: '3' }, { num: '4' }, { num: '5', tier: 'pinned' }], lanes: [], prs: [] },
    plan: { launch: [], held: [held('1', 'overlaps lane-19'), held('2', 'needs-prepare'), held('3', 'needs-prepare'), held('4', 'prepare-stale'), held('5', 'needs-prepare'), ...extraHeld] },
    freeLanes: [7, 8, 9, 10], bookkeeping: { tick: 1 },
    config: { maxConcurrentLanes: 10, maxConcurrentItemPrepares: 5, ...config },
  });

  it('only prepares cards within the next N to build, pinned first; the rest wait with a note', () => {
    const r = tick({ prepareAheadWindow: 3 });
    // build order: pinned #5, then #1 (overlap, already prepared), #2 → window {5, 1, 2}
    expect(r.decisions.spawnPrepareItems.map((s) => s.num)).toEqual(['2', '5']);
    const waits = r.decisions.notes.filter((n) => n.kind === 'prepare-ahead-window').map((n) => n.num);
    expect(waits).toEqual(['3', '4']);
  });

  it('builder-starved: a card the caller holds never takes a prepare-ahead window slot', () => {
    // Live 2026-10-07: two failure-held cards at the head of the pinned tier filled the window every tick, so the
    // cards behind them were never prepared. #5 (pinned) and #2 are held by the daemon → the window moves on.
    const r = planTick({
      state: { queue: [{ num: '1' }, { num: '2' }, { num: '3' }, { num: '4' }, { num: '5', tier: 'pinned' }], lanes: [], prs: [] },
      plan: { launch: [], held: [held('1', 'overlaps lane-19'), held('2', 'needs-prepare'), held('3', 'needs-prepare'), held('4', 'prepare-stale'), held('5', 'needs-prepare')] },
      freeLanes: [7, 8, 9, 10], bookkeeping: { tick: 1, prepareHeldNums: ['5', '2'] },
      config: { maxConcurrentLanes: 10, maxConcurrentItemPrepares: 5, prepareAheadWindow: 3 },
    });
    // window over the non-held cards in build order: #1, #3, #4
    expect(r.decisions.spawnPrepareItems.map((s) => s.num)).toEqual(['3', '4']);
  });

  it('builder-starved: kinds outside config.launchKinds are never planned — no guard, lane, or queue budget', () => {
    const base = {
      state: { queue: [{ num: '2' }, { num: '3' }], lanes: [], prs: [], unshaped: [{ num: '20' }, { num: '21' }, { num: '22' }] },
      plan: { launch: [], held: [held('2', 'needs-prepare'), held('3', 'needs-prepare')] },
      freeLanes: [7, 8, 9, 10, 11, 12], bookkeeping: { tick: 1, prepareGuards: [{ num: '30', kind: 'prepare', lane: 13, spawnedTick: 1, sawPr: false }] },
      config: { maxConcurrentLanes: 100, maxConcurrentItemPrepares: 2 },
      // A tight queue-time budget: two prepare spawns' worth. Before, the scope spawns spent it all first.
      queueAdmission: { maxWaitMinutes: 2.5, slots: 1, backlogMinutes: 0, dispatchMinutes: { prepare: 1 } },
    };
    const all = planTick(base);
    expect(all.decisions.spawnPrepareScope.length).toBeGreaterThan(0);
    expect(all.decisions.spawnPrepareItems).toEqual([]); // the starvation: scope spawns took the whole budget
    const r = planTick({ ...base, config: { ...base.config, launchKinds: ['prepare-item'] } });
    expect(r.decisions.spawnPrepareScope).toEqual([]);
    expect(r.decisions.spawnPrepareItems.map((s) => s.num)).toEqual(['2', '3']);
    // the phantom scope guard carried in bookkeeping self-heals, and nothing reads as "preparing" but the two items
    expect(r.nextState.prepareGuards.map((g) => `${g.kind}:${g.num}`)).toEqual(['prepare-item:2', 'prepare-item:3']);
    expect(r.decisions.counts.preparing).toBe(2);
    expect(r.decisions.notes.filter((n) => n.kind === 'dispatch-paused')).toEqual([]);
  });

  it('a prepare-stale card is a re-prepare candidate like needs-prepare', () => {
    const r = tick({});
    expect(r.decisions.spawnPrepareItems.map((s) => s.num)).toEqual(['2', '3', '4', '5']);
  });

  it('a prepare-stale card gets no generic `held` note on top of its own prepare note', () => {
    for (const config of [{}, { prepareAheadWindow: 1 }]) {
      const r = tick(config);
      expect(r.decisions.notes.filter((n) => n.kind === 'held' && n.reason === 'prepare-stale')).toEqual([]);
      expect(r.decisions.notes.filter((n) => n.kind === 'held' && n.reason === 'needs-prepare')).toEqual([]);
    }
    // …and never reads as a self-diagnosed stall, which is fed from the same held entries.
    expect(tick({}).decisions.stalled).toEqual([]);
  });

  it('every dispatch-plan held reason is either excluded from the generic note or deliberately generic', () => {
    // Adding a HELD_REASONS entry forces a choice here, instead of silently doubling its note (the prepare-stale miss).
    const GENERIC = ['already-done', 'blocked', 'branch-drift-blocked', 'no free lane', 'capacity-cap', 'overlaps lane-<n>',
      'cleared-but-not-ready', 'dispatch-paused', 'pr-limit'];
    const unclassified = HELD_REASONS.filter((r) => !HELD_NOTE_EXCLUDED_REASONS.includes(r) && !GENERIC.includes(r));
    expect(unclassified).toEqual([]);
    expect(GENERIC.filter((r) => HELD_NOTE_EXCLUDED_REASONS.includes(r))).toEqual([]);
  });

  it('without the window every candidate is offered (other callers unchanged)', () => {
    const r = tick({});
    expect(r.decisions.notes.some((n) => n.kind === 'prepare-ahead-window')).toBe(false);
  });
});

describe('reuseFailedLanePoolRead — never re-run a lane-pool read dispatch-plan just watched fail', () => {
  const failed = { lanePool: { freeLanes: 'unavailable', error: 'lane-pool list failed: scan budget' } };
  it('same pool (no --repo args) and the plan reports the read unavailable → reuse its error', () => {
    expect(reuseFailedLanePoolRead(failed, [])).toBe('lane-pool list failed: scan budget');
  });
  it('a different pool (--repo args) is a different read → do it', () => {
    expect(reuseFailedLanePoolRead(failed, ['--repo=frontierui'])).toBeNull();
  });
  it('a plan whose lane-pool read succeeded (or a fixture plan) → do the read', () => {
    expect(reuseFailedLanePoolRead({}, [])).toBeNull();
    expect(reuseFailedLanePoolRead({ lanePool: { freeLanes: 'explicit' } }, [])).toBeNull();
    expect(reuseFailedLanePoolRead(null, [])).toBeNull();
  });
});

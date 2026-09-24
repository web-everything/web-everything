/**
 * @file scripts/readiness/__tests__/dispatch-plan.test.mjs
 * @description Unit proof of the conveyor DISPATCHER's PURE core (WE #x53zzf9). Drives {@link dispatchPlan}
 *   directly with plain objects (NO git/network) and pins every branch of the dispatch rules:
 *   the disjoint happy path (free lanes fill in rank order), overlap-with-an-active-lease, the rival pair
 *   (higher rank wins), no-free-lane, blocked, and the UNSCOPED AUTO-PREPARE hold (#2613, ruled 2026-07-22 — an
 *   unscoped item is NEVER launched to build; it is ALWAYS held `unshaped-no-scope`, even in a fully-idle pool
 *   with free lanes, for the /conveyor skill to auto-prepare its scope) — plus the precedence between them.
 */
import { describe, it, expect } from 'vitest';
import {
  queueFileRows,
  dispatchPlan, selectClearedRows, clearedNotReady,
  // #3457/#3460 — the age-gated already-done ground-truth enrichment (Fork 2(b)).
  isStaleEnoughForGroundTruth, ALREADY_DONE_AGE_GATE_MS,
  // #x7xv2xt — the explicit free-lane list that keeps a fixture run off the real lane pool.
  parseFreeLanes,
  // epic #3383 — the kind-scoped dispatch-pause and its narrowed operator gloss.
  dispatchPausedHint, DISPATCH_PAUSED_HINT,
} from '../dispatch-plan.mjs';
import { PAUSABLE_KINDS } from '../dispatch-pause.mjs';
import { normNum } from '../../conveyor/queue-store.mjs';

describe('dispatchPlan — happy path: disjoint items fill free lanes in rank order', () => {
  it('assigns free lanes to disjoint queued items in queue (rank) order', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, scope: ['src/a/'] },
        { num: 2, scope: ['src/b/'] },
        { num: 3, scope: ['src/c/'] },
      ],
      leases: [],
      freeLanes: [4, 5, 7],
    });
    expect(plan.launch).toEqual([
      { num: 1, lane: 4 },
      { num: 2, lane: 5 },
      { num: 3, lane: 7 },
    ]);
    expect(plan.held).toEqual([]);
  });

  it('a sibling-name-prefix rival pair (src/x vs src/x-2) BOTH launch — segment-boundary non-overlap', () => {
    // Hardens the keystone's most dangerous property at the DISPATCHER layer: `src/x` must NOT be read as a
    // prefix of `src/x-2` (a path-SEGMENT boundary, not a raw string prefix), so the two are disjoint and both
    // launch. Pins segment-boundary non-overlap here directly, not only transitively via scope-lease.test.mjs,
    // so a future swap of the overlap primitive can't silently start double-booking sibling-named scopes.
    const plan = dispatchPlan({
      queue: [
        { num: 1, scope: ['src/x'] },
        { num: 2, scope: ['src/x-2'] },
      ],
      leases: [],
      freeLanes: [3, 4],
    });
    expect(plan.launch).toEqual([
      { num: 1, lane: 3 },
      { num: 2, lane: 4 },
    ]);
    expect(plan.held).toEqual([]);
  });
});

describe('dispatchPlan — overlap with an ACTIVE lease → held "overlaps lane-<n>"', () => {
  it('holds an item whose scope intersects a running lane, naming that lane', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['src/shared/util.ts'] }],
      leases: [{ lane: 9, scope: ['src/shared/'] }],
      freeLanes: [2, 3],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'overlaps lane-9' }]);
  });

  it('a disjoint item still launches while an overlapping sibling holds', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, scope: ['src/shared/'] }, // overlaps lease lane-9
        { num: 2, scope: ['src/other/'] }, // disjoint → launches
      ],
      leases: [{ lane: 9, scope: ['src/shared/x.ts'] }],
      freeLanes: [4],
    });
    expect(plan.launch).toEqual([{ num: 2, lane: 4 }]);
    expect(plan.held).toEqual([{ num: 1, reason: 'overlaps lane-9' }]);
  });
});

describe('dispatchPlan — branch-drift ceiling (#3464): a currently-blocked dispatched-work branch holds overlapping items', () => {
  it('holds an item whose scope overlaps the drifting branch\'s own blocked scope', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['we:scripts/conveyor/branch-drift.mjs'] }],
      leases: [],
      freeLanes: [2, 3],
      driftBlockedScope: ['we:scripts/conveyor/'],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'branch-drift-blocked' }]);
  });

  it('a disjoint item still launches while an overlapping sibling holds on the drift ceiling', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, scope: ['we:scripts/conveyor/'] }, // overlaps the drifting scope → held
        { num: 2, scope: ['we:scripts/other/'] }, // disjoint → launches
      ],
      leases: [],
      freeLanes: [4],
      driftBlockedScope: ['we:scripts/conveyor/'],
    });
    expect(plan.launch).toEqual([{ num: 2, lane: 4 }]);
    expect(plan.held).toEqual([{ num: 1, reason: 'branch-drift-blocked' }]);
  });

  it('no drift block (absent/null/empty) never holds anything on this axis', () => {
    for (const driftBlockedScope of [undefined, null, []]) {
      const plan = dispatchPlan({
        queue: [{ num: 1, scope: ['we:scripts/conveyor/'] }],
        leases: [],
        freeLanes: [2],
        driftBlockedScope,
      });
      expect(plan.launch).toEqual([{ num: 1, lane: 2 }]);
      expect(plan.held).toEqual([]);
    }
  });

  // #3836 (#3804 Fork 4, statute `#poc-branch-mechanical-sync` point 4) — a graduation slice (a child of the
  // drifting branch's registered `graduationItem`, which lands on `main`) is exempt from the drift hold.
  it('a queued graduation slice overlapping the drifted branch is NOT held branch-drift-blocked; a non-graduation card with the same scope still is', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, parent: '3443', scope: ['we:scripts/conveyor/tick-core.mjs'] }, // graduation slice → launches
        { num: 2, parent: '3383', scope: ['we:scripts/conveyor/tick-core.mjs'] }, // same scope, not a slice → held
      ],
      leases: [],
      freeLanes: [7, 8],
      driftBlockedScope: ['we:scripts/conveyor/'],
      driftGraduationItem: '3443',
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 7 }]);
    expect(plan.held).toEqual([{ num: 2, reason: 'branch-drift-blocked' }]);
  });

  it('no registered graduation item exempts nothing (a card parented under any epic still holds)', () => {
    for (const driftGraduationItem of [undefined, null, '']) {
      const plan = dispatchPlan({
        queue: [{ num: 1, parent: '3443', scope: ['we:scripts/conveyor/'] }],
        leases: [],
        freeLanes: [2],
        driftBlockedScope: ['we:scripts/conveyor/'],
        driftGraduationItem,
      });
      expect(plan.held).toEqual([{ num: 1, reason: 'branch-drift-blocked' }]);
    }
  });
});

describe('dispatchPlan — rival pair: two queued items overlap, neither running → higher rank launches', () => {
  it('launches the higher-ranked rival and holds the lower on the rival\'s lane', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, scope: ['src/backlog-view/'] }, // higher rank → launches
        { num: 2, scope: ['src/backlog-view/list.ts'] }, // overlaps #1 → holds
      ],
      leases: [],
      freeLanes: [5, 6],
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 5 }]);
    expect(plan.held).toEqual([{ num: 2, reason: 'overlaps lane-5' }]);
  });

  it('a higher rival that itself HELD does not block a lower item via the rival rule', () => {
    // #1 overlaps an active lease (held, not launched); #2 overlaps #1 but NOT the lease, so #2 is free to run.
    const plan = dispatchPlan({
      queue: [
        { num: 1, scope: ['src/x/', 'src/lease-owned/'] }, // held on the lease
        { num: 2, scope: ['src/x/'] }, // overlaps #1 (parked) only → launches
      ],
      leases: [{ lane: 8, scope: ['src/lease-owned/'] }],
      freeLanes: [3],
    });
    expect(plan.launch).toEqual([{ num: 2, lane: 3 }]);
    expect(plan.held).toEqual([{ num: 1, reason: 'overlaps lane-8' }]);
  });
});

describe('dispatchPlan — no free lane', () => {
  it('holds disjoint items once the free lanes run out, in rank order', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, scope: ['src/a/'] },
        { num: 2, scope: ['src/b/'] },
        { num: 3, scope: ['src/c/'] },
      ],
      leases: [],
      freeLanes: [7], // only one slot
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 7 }]);
    expect(plan.held).toEqual([
      { num: 2, reason: 'no free lane' },
      { num: 3, reason: 'no free lane' },
    ]);
  });

  it('with zero free lanes every disjoint item holds "no free lane"', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['src/a/'] }],
      leases: [],
      freeLanes: [],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'no free lane' }]);
  });
});

describe('dispatchPlan — blocked', () => {
  it('holds an item with open blockers as "blocked" (array shape)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['src/a/'], openBlockers: ['42'] }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'blocked' }]);
  });

  it('holds an item with open blockers as "blocked" (count shape)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['src/a/'], openBlockers: 2 }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'blocked' }]);
  });

  it('blocked takes precedence over a missing scope', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, openBlockers: ['9'] }], // no scope AND blocked → blocked wins
      leases: [],
      freeLanes: [2],
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'blocked' }]);
  });
});

describe('dispatchPlan — already-done ground truth (#3457/#3460) — HELD "already-done", ahead of every other branch', () => {
  it('holds an item the enrichment already found a merged PR for, instead of launching it', () => {
    const pr = { number: 1861, url: 'https://x/1861', title: 'WE #3435: mechanically reap/stop finished sessions', mergedAt: '2026-09-03T14:52:37Z' };
    const plan = dispatchPlan({
      queue: [{ num: 3435, scope: ['src/a/'], alreadyDonePr: pr }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 3435, reason: 'already-done' }]);
  });

  it('outranks "blocked" — a real merged PR is a stronger signal than a stale openBlockers read', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, openBlockers: ['9'], alreadyDonePr: { number: 1 } }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'already-done' }]);
  });

  it('outranks "needs-decision" — #3434\'s own motivating shape (kind: decision, wrongly still open)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 3434, kind: 'decision', alreadyDonePr: { number: 1768 } }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.held).toEqual([{ num: 3434, reason: 'already-done' }]);
  });

  it('outranks "unshaped-no-scope" and "overlaps lane-<n>" too', () => {
    const noScope = dispatchPlan({ queue: [{ num: 1, alreadyDonePr: { number: 1 } }], leases: [], freeLanes: [2] });
    expect(noScope.held).toEqual([{ num: 1, reason: 'already-done' }]);

    const overlap = dispatchPlan({
      queue: [{ num: 1, scope: ['src/shared/util.ts'], alreadyDonePr: { number: 1 } }],
      leases: [{ lane: 9, scope: ['src/shared/'] }],
      freeLanes: [2],
    });
    expect(overlap.held).toEqual([{ num: 1, reason: 'already-done' }]);
  });

  it('an item with no `alreadyDonePr` at all takes the normal path, unaffected', () => {
    const plan = dispatchPlan({ queue: [{ num: 1, scope: ['src/a/'] }], leases: [], freeLanes: [2] });
    expect(plan.launch).toEqual([{ num: 1, lane: 2 }]);
  });

  it('HELD_REASONS lists the new token', async () => {
    const { HELD_REASONS } = await import('../dispatch-plan.mjs');
    expect(HELD_REASONS).toContain('already-done');
  });
});

describe('isStaleEnoughForGroundTruth — PURE age gate for the #3457/#3460 enrichment call (Fork 2(b))', () => {
  const NOW = Date.parse('2026-09-03T16:00:00.000Z');

  it('a freshly-opened item (well under the threshold) is NOT stale enough — never spends the gh call', () => {
    const openedTenMinutesAgo = new Date(NOW - 10 * 60 * 1000).toISOString();
    expect(isStaleEnoughForGroundTruth({ dateOpened: openedTenMinutesAgo }, NOW)).toBe(false);
  });

  it('an item opened well past the threshold (default 2h) IS stale enough', () => {
    const openedThreeHoursAgo = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    expect(isStaleEnoughForGroundTruth({ dateOpened: openedThreeHoursAgo }, NOW)).toBe(true);
  });

  it('sits exactly on the boundary correctly (strictly greater-than, not greater-or-equal)', () => {
    const exactlyAtGate = new Date(NOW - ALREADY_DONE_AGE_GATE_MS).toISOString();
    expect(isStaleEnoughForGroundTruth({ dateOpened: exactlyAtGate }, NOW)).toBe(false);
    const oneMsPast = new Date(NOW - ALREADY_DONE_AGE_GATE_MS - 1).toISOString();
    expect(isStaleEnoughForGroundTruth({ dateOpened: oneMsPast }, NOW)).toBe(true);
  });

  it('prefers dateStarted over dateOpened when both are present (an active item\'s real clock)', () => {
    // Opened long ago but only just claimed — the more honest "how long has real work been outstanding" read
    // is dateStarted, so this should NOT yet be stale.
    const startedNow = new Date(NOW).toISOString();
    expect(isStaleEnoughForGroundTruth({ dateOpened: '2020-01-01', dateStarted: startedNow }, NOW)).toBe(false);
  });

  it('an unparseable/absent date FAILS TOWARD CHECKING — never silently skipped', () => {
    expect(isStaleEnoughForGroundTruth({}, NOW)).toBe(true);
    expect(isStaleEnoughForGroundTruth(null, NOW)).toBe(true);
    expect(isStaleEnoughForGroundTruth({ dateOpened: 'not a date' }, NOW)).toBe(true);
  });

  it('a custom age gate overrides the default', () => {
    const openedOneHourAgo = new Date(NOW - 60 * 60 * 1000).toISOString();
    expect(isStaleEnoughForGroundTruth({ dateOpened: openedOneHourAgo }, NOW, 30 * 60 * 1000)).toBe(true); // 30m gate
    expect(isStaleEnoughForGroundTruth({ dateOpened: openedOneHourAgo }, NOW, 2 * 60 * 60 * 1000)).toBe(false); // 2h gate
  });
});

describe('dispatchPlan — a cleared kind:epic is HELD "needs-slice", never built (#2645)', () => {
  // An epic is a CONTAINER; its work lives in child stories/tasks, so it is never directly buildable. A cleared
  // epic must not launch to build AND must not fall through to the scope gate (which would auto-prepare a container).
  it('holds a scope-less epic "needs-slice" even in a fully-idle pool with free lanes (never built, never auto-prepared)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'epic' }], // no scope, but epic → needs-slice, NOT unshaped-no-scope
      leases: [],
      freeLanes: [2, 3],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-slice' }]);
  });

  it('holds an epic "needs-slice" even when it carries a scope (an epic is never a direct build)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'epic', scope: ['src/a/'] }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-slice' }]);
  });

  it('blocked takes precedence over needs-slice (a blocked epic can\'t be sliced until its blockers clear)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'epic', openBlockers: ['9'] }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'blocked' }]);
  });

  it('needs-slice holds the epic while a disjoint story on the same tick still launches', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, kind: 'epic', scope: ['src/a/'] }, // epic → held needs-slice
        { num: 2, kind: 'story', scope: ['src/b/'] }, // buildable story → launches
      ],
      leases: [],
      freeLanes: [7],
    });
    expect(plan.launch).toEqual([{ num: 2, lane: 7 }]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-slice' }]);
  });

  it('a non-epic with no kind field still flows through the normal scope/launch path (no false needs-slice)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['src/a/'] }], // kind absent → not an epic → launches
      leases: [],
      freeLanes: [4],
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 4 }]);
    expect(plan.held).toEqual([]);
  });
});

describe('dispatchPlan — a cleared kind:feature is HELD "needs-slice", never built (#2998)', () => {
  // `feature` (#2691) is the grouping tier ABOVE epic — epic-parity BY DESIGN: it is a CONTAINER (its work
  // lives in child epics), never directly buildable. Regression coverage for the #1312 review finding: a
  // cleared (buildQueued) feature item previously fell through the epic-only check to the scope gate, which
  // would auto-prepare + eventually BUILD a container — "aim a build agent at a container", the exact hazard
  // the epic branch exists to prevent. Mirrors the kind:epic block above one-for-one.
  it('holds a scope-less feature "needs-slice" even in a fully-idle pool with free lanes (never built, never auto-prepared)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'feature' }], // no scope, but feature → needs-slice, NOT unshaped-no-scope
      leases: [],
      freeLanes: [2, 3],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-slice' }]);
  });

  it('holds a feature "needs-slice" even when it carries a scope (a feature is never a direct build)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'feature', scope: ['src/a/'] }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-slice' }]);
  });

  it('blocked takes precedence over needs-slice (a blocked feature can\'t be sliced until its blockers clear)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'feature', openBlockers: ['9'] }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'blocked' }]);
  });

  it('needs-slice holds the feature while a disjoint story on the same tick still launches', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, kind: 'feature', scope: ['src/a/'] }, // feature → held needs-slice
        { num: 2, kind: 'story', scope: ['src/b/'] }, // buildable story → launches
      ],
      leases: [],
      freeLanes: [7],
    });
    expect(plan.launch).toEqual([{ num: 2, lane: 7 }]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-slice' }]);
  });
});

describe('dispatchPlan — a cleared kind:decision is HELD "needs-decision", never built (#2647)', () => {
  // A decision is NOT build work; its lifecycle is prepare (research + author forks) then present (surface to
  // ratify). Like an epic, a cleared decision must not launch to build AND must not fall through to the scope gate
  // (which would aim a prepare-SCOPE agent at an item that has no build touch-set).
  it('holds a scope-less decision "needs-decision" even in a fully-idle pool with free lanes (never built, never scope-auto-prepared)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'decision' }], // no scope, but decision → needs-decision, NOT unshaped-no-scope
      leases: [],
      freeLanes: [2, 3],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-decision' }]);
  });

  it('holds a decision "needs-decision" even when it somehow carries a scope (a decision is never a direct build)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'decision', scope: ['src/a/'] }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-decision' }]);
  });

  it('blocked takes precedence over needs-decision (a blocked decision can\'t be prepared until its blockers clear)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'decision', openBlockers: ['9'] }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'blocked' }]);
  });

  it('needs-decision holds the decision while a disjoint story on the same tick still launches', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, kind: 'decision' }, // decision → held needs-decision
        { num: 2, kind: 'story', scope: ['src/b/'] }, // buildable story → launches
      ],
      leases: [],
      freeLanes: [7],
    });
    expect(plan.launch).toEqual([{ num: 2, lane: 7 }]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-decision' }]);
  });
});

describe('dispatchPlan — a cleared kind:investigation is HELD "needs-investigation", never built (#3567)', () => {
  // An investigation is NOT build work either — it is a single dispatched investigator (investigate ->
  // synthesize -> report), never a two-phase prepare/present lifecycle the way a decision is. Like a decision,
  // it must not fall through to the scope gate (it carries no build touch-set) and must never land in launch.
  it('holds a scope-less investigation "needs-investigation" even in a fully-idle pool with free lanes', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'investigation' }],
      leases: [],
      freeLanes: [2, 3],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-investigation' }]);
  });

  it('holds an investigation "needs-investigation" even when it somehow carries a scope', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'investigation', scope: ['src/a/'] }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-investigation' }]);
  });

  it('blocked takes precedence over needs-investigation', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'investigation', openBlockers: ['9'] }],
      leases: [],
      freeLanes: [2],
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'blocked' }]);
  });

  it('needs-investigation holds the investigation while a disjoint story on the same tick still launches — never into spawnBuilds\' backing list', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, kind: 'investigation' },
        { num: 2, kind: 'story', scope: ['src/b/'] },
      ],
      leases: [],
      freeLanes: [7],
    });
    expect(plan.launch).toEqual([{ num: 2, lane: 7 }]);
    expect(plan.held).toEqual([{ num: 1, reason: 'needs-investigation' }]);
    // #1 never appears anywhere in `launch` — the list `decisions.spawnBuilds` is built from — regardless of
    // how many free lanes were available.
    expect(plan.launch.some((l) => l.num === 1)).toBe(false);
  });
});

describe('dispatchPlan — the UNSCOPED AUTO-PREPARE hold (#2613, ruled 2026-07-22)', () => {
  // An unscoped item is "assume-overlaps-everything" and is NEVER launched to build — not even alone into an idle
  // pool. It is ALWAYS held `unshaped-no-scope` so the /conveyor skill auto-prepares its scope upstream; once that
  // lands the item is scoped and dispatches to BUILD on a later tick. The conveyor never builds without scope and
  // never dispatches blind. These cases pin: no serial "run-alone" launch exists anywhere.

  it('an unscoped item is HELD "unshaped-no-scope" even in a fully-idle pool with free lanes (never built blind)', () => {
    // THE point of auto-prepare: an idle pool + free lanes is NOT permission to build an unscoped item. It holds
    // so the skill authors its scope first. (The old serial floor launched it here — that branch is deleted.)
    const plan = dispatchPlan({ queue: [{ num: 1 }], leases: [], freeLanes: [2, 3] });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'unshaped-no-scope' }]);
  });

  it('an EMPTY scope array is treated identically to absent → held "unshaped-no-scope"', () => {
    // The #663 empty-scope contract: [] is NOT a "touches nothing" launch — it is undeclared, so it reads as
    // unscoped and holds for auto-prepare. Keeps the pure core aligned with the loader (normalizeScope [] →
    // undefined) and check:standards (errors on []).
    const plan = dispatchPlan({ queue: [{ num: 1, scope: [] }], leases: [], freeLanes: [2] });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'unshaped-no-scope' }]);
  });

  it('an unscoped item is HELD "unshaped-no-scope" when a lease is active too (uniform, pool-state-independent)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1 }], // unscoped
      leases: [{ lane: 9, scope: ['src/anything/'] }], // a lane is running
      freeLanes: [2, 3],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'unshaped-no-scope' }]);
  });

  it('multiple unscoped items → ALL hold "unshaped-no-scope" (none launches, even with free lanes to spare)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1 }, { num: 2 }, { num: 3 }],
      leases: [],
      freeLanes: [5, 6, 7], // plenty of free lanes — still nothing builds unscoped
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([
      { num: 1, reason: 'unshaped-no-scope' },
      { num: 2, reason: 'unshaped-no-scope' },
      { num: 3, reason: 'unshaped-no-scope' },
    ]);
  });

  it('a scoped + an unscoped item → the SCOPED launches, the unscoped holds for auto-prepare', () => {
    // Scoped items dispatch normally (pass unchanged); the unscoped item holds regardless of its rank or free
    // lanes — it is never launched to build, only auto-prepared. Held stays in queue order.
    const plan = dispatchPlan({
      queue: [
        { num: 1 }, // unscoped, higher rank → held for auto-prepare
        { num: 2, scope: ['src/b/'] }, // scoped → launches
      ],
      leases: [],
      freeLanes: [3, 4],
    });
    expect(plan.launch).toEqual([{ num: 2, lane: 3 }]);
    expect(plan.held).toEqual([{ num: 1, reason: 'unshaped-no-scope' }]);
  });

  it('an unscoped item with NO free lane also holds "unshaped-no-scope" (unscoped is checked before lanes)', () => {
    const plan = dispatchPlan({ queue: [{ num: 1 }], leases: [], freeLanes: [] });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'unshaped-no-scope' }]);
  });
});

describe('dispatchPlan — the NO-SIZE admission hold (#3801 Fork 4 (b), #3849 admission)', () => {
  const BLOCK = { unsizedCardPolicy: 'block', defaultSize: 13 };
  const DEFAULT_SIZE = { unsizedCardPolicy: 'default-size', defaultSize: 13 };

  it('`sizePolicy` omitted (the default) — an unsized scoped item launches exactly as before #3849', () => {
    const plan = dispatchPlan({ queue: [{ num: 1, scope: ['src/a/'] }], leases: [], freeLanes: [2] });
    expect(plan.launch).toEqual([{ num: 1, lane: 2 }]); // no `sized` key — untouched shape
    expect(plan.held).toEqual([]);
  });

  it('under `block`, a scoped story with no `size:` is HELD "no-size" and never launches', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'story', scope: ['src/a/'] }],
      leases: [], freeLanes: [2],
      sizePolicy: BLOCK,
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'no-size' }]);
  });

  it('under `block`, a scoped task with no `estimatedLoc:` is HELD "no-size" too (its own reason, distinct field)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'task', scope: ['src/a/'] }],
      leases: [], freeLanes: [2],
      sizePolicy: BLOCK,
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'no-size' }]);
  });

  it('under `block`, a task with a non-positive/non-integer `estimatedLoc:` is still HELD "no-size" (invalid reads as absent)', () => {
    const invalid = [0, -3, 1.5];
    for (const estimatedLoc of invalid) {
      const plan = dispatchPlan({
        queue: [{ num: 1, kind: 'task', scope: ['src/a/'], estimatedLoc }],
        leases: [], freeLanes: [2],
        sizePolicy: BLOCK,
      });
      expect(plan.held).toEqual([{ num: 1, reason: 'no-size' }]);
    }
  });

  it('under `block`, a story with a declared `size:` launches normally, `sized: true` on its launch entry', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'story', scope: ['src/a/'], size: 3 }],
      leases: [], freeLanes: [2],
      sizePolicy: BLOCK,
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 2, sized: true }]);
    expect(plan.held).toEqual([]);
  });

  it('under `block`, a task with a valid `estimatedLoc:` launches normally, `sized: true`', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'task', scope: ['src/a/'], estimatedLoc: 80 }],
      leases: [], freeLanes: [2],
      sizePolicy: BLOCK,
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 2, sized: true }]);
    expect(plan.held).toEqual([]);
  });

  it('a `deliveryAgent:` marker never bypasses the "no-size" hold (#3801 Fork 5 — admission is decided before routing)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'story', scope: ['src/a/'], deliveryAgent: 'codex', deliveryAgentReason: 'trial' }],
      leases: [], freeLanes: [2],
      sizePolicy: BLOCK,
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'no-size' }]);
  });

  it('under `default-size`, an unsized story is ADMITTED (launched), route records `sized: false`', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'story', scope: ['src/a/'] }],
      leases: [], freeLanes: [2],
      sizePolicy: DEFAULT_SIZE,
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 2, sized: false }]);
    expect(plan.held).toEqual([]);
  });

  it('under `default-size`, an unsized task is ADMITTED too, `sized: false`', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'task', scope: ['src/a/'] }],
      leases: [], freeLanes: [2],
      sizePolicy: DEFAULT_SIZE,
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 2, sized: false }]);
    expect(plan.held).toEqual([]);
  });

  it('a `fix` dispatch is NEVER held for size, even unsized, under `block` (fix/ci-heal take the fixSizeSource chain instead)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'fix', scope: ['src/a/'] }],
      leases: [], freeLanes: [2],
      sizePolicy: BLOCK,
    });
    // no `sized` key — exempt, its size comes from `fixSizeSource` in `decideDispatchRoute`, not this gate.
    expect(plan.launch).toEqual([{ num: 1, lane: 2 }]);
    expect(plan.held).toEqual([]);
  });

  it('a `ci-heal` dispatch is NEVER held for size, even unsized, under `block`', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'ci-heal', scope: ['src/a/'] }],
      leases: [], freeLanes: [2],
      sizePolicy: BLOCK,
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 2 }]);
    expect(plan.held).toEqual([]);
  });

  it('unscoped keeps "unshaped-no-scope" — the no-size gate never relabels a more specific hold', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'story' }], // no scope at all
      leases: [], freeLanes: [2],
      sizePolicy: BLOCK,
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'unshaped-no-scope' }]);
  });

  it('a scoped+sized story and a scoped+unsized story in the same tick: the sized one launches, the unsized one holds', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, kind: 'story', scope: ['src/a/'] }, // unsized, higher rank
        { num: 2, kind: 'story', scope: ['src/b/'], size: 5 },
      ],
      leases: [], freeLanes: [3, 4],
      sizePolicy: BLOCK,
    });
    expect(plan.launch).toEqual([{ num: 2, lane: 3, sized: true }]);
    expect(plan.held).toEqual([{ num: 1, reason: 'no-size' }]);
  });
});

describe('dispatchPlan — mixed tick pins the full precedence + ordering', () => {
  it('resolves blocked / unscoped / lease-overlap / rival / launch / no-free-lane together', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, scope: ['src/a/'], openBlockers: ['5'] }, // blocked
        { num: 2 }, // unscoped → held unshaped-no-scope (never launched; auto-prepared)
        { num: 3, scope: ['src/leased/'] }, // overlaps active lease lane-9
        { num: 4, scope: ['src/feature/'] }, // launches → lane-10
        { num: 5, scope: ['src/feature/sub/'] }, // rival of #4 → overlaps lane-10
        { num: 6, scope: ['src/lonely/'] }, // launches → lane-11
        { num: 7, scope: ['src/last/'] }, // disjoint but no lane left → no free lane
      ],
      leases: [{ lane: 9, scope: ['src/leased/'] }],
      freeLanes: [10, 11],
    });
    expect(plan.launch).toEqual([
      { num: 4, lane: 10 },
      { num: 6, lane: 11 },
    ]);
    // ONE pass now — holds come out in QUEUE order (no deferred second pass), so the unscoped #2 sorts in its
    // queue position (second), NOT last.
    expect(plan.held).toEqual([
      { num: 1, reason: 'blocked' },
      { num: 2, reason: 'unshaped-no-scope' },
      { num: 3, reason: 'overlaps lane-9' },
      { num: 5, reason: 'overlaps lane-10' },
      { num: 7, reason: 'no free lane' },
    ]);
  });
});

describe('dispatchPlan — defensive input handling', () => {
  it('returns an empty plan for empty / missing inputs', () => {
    expect(dispatchPlan({})).toEqual({ launch: [], held: [] });
    expect(dispatchPlan()).toEqual({ launch: [], held: [] });
  });
});

describe('selectClearedRows — cleared set comes from the SESSION-LOCAL sidecar, not committed buildQueued (#2613)', () => {
  // The shell's new membership rule: an item is in the conveyor queue IFF its num is in `.conveyor/queue.json`
  // (the sidecar), NOT because it carries committed `buildQueued:true` frontmatter. Rank order (the row order
  // the build-queue engine emits) is preserved; only membership moved to the sidecar.
  const rows = [
    { num: 100, buildQueued: true }, // committed-cleared but NOT in the sidecar → dropped
    { num: 200, buildQueued: false }, // in the sidecar → kept, despite no committed flag
    { num: 300, buildQueued: true }, // in the sidecar → kept
  ];

  it('keeps only sidecar members, in rank order — a committed buildQueued NOT in the sidecar is dropped', () => {
    const cleared = new Set(['200', '300'].map(normNum));
    expect(selectClearedRows(rows, cleared, normNum)).toEqual([
      { num: 200, buildQueued: false },
      { num: 300, buildQueued: true },
    ]);
  });

  it('a sidecar item with NO committed buildQueued flag is still dispatched (pins the inverted source)', () => {
    const cleared = new Set(['200'].map(normNum));
    expect(selectClearedRows(rows, cleared, normNum)).toEqual([{ num: 200, buildQueued: false }]);
  });

  it('an empty sidecar dispatches nothing even when rows carry committed buildQueued:true', () => {
    expect(selectClearedRows(rows, new Set(), normNum)).toEqual([]);
  });

  it('membership is padding-tolerant (sidecar "042" matches row num 42)', () => {
    const cleared = new Set(['042'].map(normNum));
    expect(selectClearedRows([{ num: 42 }], cleared, normNum)).toEqual([{ num: 42 }]);
  });

  it('defensive: non-array rows → []', () => {
    expect(selectClearedRows(null, new Set(['1']), normNum)).toEqual([]);
  });

  it('a `#`-spelled sidecar id matches a bare-numeric row (#2613 review req 1)', () => {
    const cleared = new Set(['#2613'].map(normNum)); // operator typed `#2613`
    expect(selectClearedRows([{ num: 2613 }, { num: 7 }], cleared, normNum)).toEqual([{ num: 2613 }]);
  });
});

describe('clearedNotReady — a cleared id with no ready row is surfaced, never silently dropped (#2613 review req 2b)', () => {
  const readyRows = [{ num: 200 }, { num: 300 }];

  it('returns the cleared ids that have NO ready build-queue row (blocked / resolved / typo / unknown)', () => {
    const sidecar = [{ num: '200' }, { num: '999' }, { num: 'ghost' }];
    expect(clearedNotReady(sidecar, readyRows, normNum)).toEqual(['999', 'ghost']);
  });

  it('preserves the stored spelling for display and is padding/`#`-tolerant', () => {
    // "042" IS ready (row 200? no — 042→42, not ready); "#300" IS ready (→300); "#42" is NOT ready.
    const sidecar = [{ num: '#300' }, { num: '#42' }];
    expect(clearedNotReady(sidecar, readyRows, normNum)).toEqual(['#42']);
  });

  it('everything ready → [] (nothing to flag)', () => {
    expect(clearedNotReady([{ num: '200' }, { num: 300 }], readyRows, normNum)).toEqual([]);
  });

  it('accepts bare-id entries and tolerates empty/missing input', () => {
    expect(clearedNotReady(['999', 200], readyRows, normNum)).toEqual(['999']);
    expect(clearedNotReady(null, readyRows, normNum)).toEqual([]);
    expect(clearedNotReady([{ num: '' }, { num: null }], readyRows, normNum)).toEqual([]);
  });
});

describe('dispatchPlan — maxConcurrentLanes (#xupukxa, live incident 2026-09-07: 42 concurrent lane dispatch)', () => {
  it('omitted — unlimited, byte-for-byte the pre-#xupukxa behavior (every existing caller keeps working)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['a/'] }, { num: 2, scope: ['b/'] }, { num: 3, scope: ['c/'] }],
      leases: [],
      freeLanes: [10, 11, 12],
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 10 }, { num: 2, lane: 11 }, { num: 3, lane: 12 }]);
    expect(plan.held).toEqual([]);
  });

  it('trims free lanes against the cap MINUS already-active leases, holding the rest `capacity-cap`', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['a/'] }, { num: 2, scope: ['b/'] }, { num: 3, scope: ['c/'] }],
      leases: [{ lane: 1, scope: ['z/'] }], // 1 already active
      freeLanes: [10, 11, 12],
      maxConcurrentLanes: 2, // room = 2 - 1 = 1
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 10 }]);
    expect(plan.held).toEqual([
      { num: 2, reason: 'capacity-cap' },
      { num: 3, reason: 'capacity-cap' },
    ]);
  });

  it('a cap already exhausted by active leases holds every disjoint item `capacity-cap`, not `no free lane`', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['a/'] }],
      leases: [{ lane: 1, scope: ['z/'] }, { lane: 2, scope: ['y/'] }],
      freeLanes: [10, 11, 12],
      maxConcurrentLanes: 2, // room = 2 - 2 = 0, but real free lanes exist
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'capacity-cap' }]);
  });

  it('a genuinely empty free-lane pool still holds `no free lane` (cap was never the limiting factor)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['a/'] }],
      leases: [],
      freeLanes: [],
      maxConcurrentLanes: 8,
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'no free lane' }]);
  });

  it('a cap large enough to cover leases + free lanes launches everything, same as unlimited', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['a/'] }, { num: 2, scope: ['b/'] }],
      leases: [{ lane: 1, scope: ['z/'] }],
      freeLanes: [10, 11],
      maxConcurrentLanes: 8,
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 10 }, { num: 2, lane: 11 }]);
    expect(plan.held).toEqual([]);
  });
});

describe('dispatchPlan — manual dispatch-pause (#3609): a deliberate operator kill-switch, distinct from every other hold', () => {
  it('omitted / false — unlimited, byte-for-byte the pre-#3609 behavior', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['a/'] }],
      leases: [],
      freeLanes: [10],
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 10 }]);
    const paused = dispatchPlan({
      queue: [{ num: 1, scope: ['a/'] }],
      leases: [],
      freeLanes: [10],
      dispatchPaused: false,
    });
    expect(paused).toEqual(plan);
  });

  it('an otherwise-launchable item holds `dispatch-paused` instead of getting a lane, and NO lane is consumed', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['a/'] }, { num: 2, scope: ['b/'] }],
      leases: [],
      freeLanes: [10, 11],
      dispatchPaused: true,
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([
      { num: 1, reason: 'dispatch-paused' },
      { num: 2, reason: 'dispatch-paused' },
    ]);
  });

  it('an ACTIVE lease is never touched — dispatchPaused only ever changes NEW launches, never in-flight lanes', () => {
    // dispatchPlan itself has no lease-release knowledge at all; this pins that leases pass through untouched
    // (the plan never references `leases` past the overlap check) even while paused.
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['a/'] }],
      leases: [{ lane: 99, scope: ['z/'] }],
      freeLanes: [10],
      dispatchPaused: true,
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'dispatch-paused' }]);
  });

  it('an item held for a MORE SPECIFIC reason keeps that reason — pause never relabels blocked/needs-slice/needs-decision/unshaped/overlap/already-done', () => {
    const plan = dispatchPlan({
      queue: [
        { num: 1, scope: ['a/'], openBlockers: ['0'] }, // blocked
        { num: 2, kind: 'epic' }, // needs-slice
        { num: 3, kind: 'decision' }, // needs-decision
        { num: 4, scope: [] }, // unshaped-no-scope
        { num: 5, scope: ['z/'] }, // overlaps the active lease below
        { num: 6, scope: ['q/'], alreadyDonePr: { url: 'https://x/1' } }, // already-done
        { num: 7, scope: ['w/'] }, // otherwise-launchable → dispatch-paused
      ],
      leases: [{ lane: 1, scope: ['z/'] }],
      freeLanes: [10, 11],
      dispatchPaused: true,
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([
      { num: 1, reason: 'blocked' },
      { num: 2, reason: 'needs-slice' },
      { num: 3, reason: 'needs-decision' },
      { num: 4, reason: 'unshaped-no-scope' },
      { num: 5, reason: 'overlaps lane-1' },
      { num: 6, reason: 'already-done' },
      { num: 7, reason: 'dispatch-paused' },
    ]);
  });

  it('composes with the concurrency cap: an item BOTH capacity-limited and paused reads `dispatch-paused` (checked before capacity-cap)', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['a/'] }],
      leases: [{ lane: 1, scope: ['z/'] }],
      freeLanes: [10],
      maxConcurrentLanes: 1, // room = 1 - 1 = 0 → would hold `capacity-cap` even unpaused
      dispatchPaused: true,
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'dispatch-paused' }]);
  });
  it('a genuinely empty free-lane pool while paused still reads `dispatch-paused`, not `no free lane`', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, scope: ['a/'] }],
      leases: [],
      freeLanes: [],
      dispatchPaused: true,
    });
    expect(plan.held).toEqual([{ num: 1, reason: 'dispatch-paused' }]);
  });
});

describe('parseFreeLanes — the explicit free-lane list (#x7xv2xt)', () => {
  it('returns null when no list was given, so the shell reads the real pool', () => {
    expect(parseFreeLanes(undefined)).toBeNull();
    expect(parseFreeLanes(null)).toBeNull();
  });
  it('an empty value is a real answer: no free lanes', () => {
    expect(parseFreeLanes('')).toEqual([]);
    expect(parseFreeLanes(true)).toEqual([]); // a bare `--free-lanes`
  });
  it('parses ids ascending and drops non-integer tokens', () => {
    expect(parseFreeLanes('7, 3,x,12,-1,')).toEqual([3, 7, 12]);
  });
});

describe('dispatchPlan — KIND-SCOPED dispatch-pause (epic #3383): `build` is the only kind this core decides', () => {
  const oneReadyItem = { queue: [{ num: 1, scope: ['a/'] }], leases: [], freeLanes: [10] };

  it('BACKWARD COMPAT: `dispatchPaused: true` with NO kinds still holds the build (old-format marker / boolean-only caller)', () => {
    for (const kinds of [undefined, null, []]) {
      const plan = dispatchPlan({ ...oneReadyItem, dispatchPaused: true, dispatchPausedKinds: kinds });
      expect(plan.launch).toEqual([]);
      expect(plan.held).toEqual([{ num: 1, reason: 'dispatch-paused' }]);
    }
  });

  it('a scope NAMING build holds it, exactly as a blanket pause would', () => {
    const plan = dispatchPlan({
      ...oneReadyItem,
      dispatchPaused: true,
      dispatchPausedKinds: ['build', 'prepare', 'prepare-decision', 'investigate'],
    });
    expect(plan.launch).toEqual([]);
    expect(plan.held).toEqual([{ num: 1, reason: 'dispatch-paused' }]);
  });

  it('a scope that does NOT name build lets the build launch — the whole point: fix/ci-heal held, new items flowing', () => {
    const plan = dispatchPlan({ ...oneReadyItem, dispatchPaused: true, dispatchPausedKinds: ['fix', 'ci-heal'] });
    expect(plan.launch).toEqual([{ num: 1, lane: 10 }]);
    expect(plan.held).toEqual([]);
  });

  it('a scope of ONLY the prepare-family kinds leaves builds launching (those are tick-core.mjs\'s spawns, not this core\'s)', () => {
    const plan = dispatchPlan({
      ...oneReadyItem,
      dispatchPaused: true,
      dispatchPausedKinds: ['prepare', 'prepare-decision', 'investigate'],
    });
    expect(plan.launch).toEqual([{ num: 1, lane: 10 }]);
  });

  it('kinds WITHOUT `dispatchPaused` hold nothing — the scope never arms the pause by itself', () => {
    const plan = dispatchPlan({ ...oneReadyItem, dispatchPaused: false, dispatchPausedKinds: ['build'] });
    expect(plan.launch).toEqual([{ num: 1, lane: 10 }]);
  });

  it('a typo\'d kind holds nothing — the marker fails OPEN (the CLI is where a typo is refused)', () => {
    const plan = dispatchPlan({ ...oneReadyItem, dispatchPaused: true, dispatchPausedKinds: ['buidl'] });
    expect(plan.launch).toEqual([{ num: 1, lane: 10 }]);
  });

  it('a build-scoped pause still never relabels an item held for a MORE SPECIFIC reason', () => {
    const plan = dispatchPlan({
      queue: [{ num: 1, kind: 'epic' }, { num: 2, scope: ['w/'] }],
      leases: [],
      freeLanes: [10],
      dispatchPaused: true,
      dispatchPausedKinds: ['build'],
    });
    expect(plan.held).toEqual([
      { num: 1, reason: 'needs-slice' },
      { num: 2, reason: 'dispatch-paused' },
    ]);
  });
});

describe('dispatchPausedHint — the operator gloss narrows to a scoped pause (epic #3383)', () => {
  it('a BLANKET pause keeps the exact wording it always had', () => {
    expect(dispatchPausedHint(null)).toBe(DISPATCH_PAUSED_HINT);
    expect(dispatchPausedHint()).toBe(DISPATCH_PAUSED_HINT);
    expect(dispatchPausedHint([])).toBe(DISPATCH_PAUSED_HINT);
  });
  it('a scope naming EVERY kind reads as blanket too', () => {
    expect(dispatchPausedHint([...PAUSABLE_KINDS])).toBe(DISPATCH_PAUSED_HINT);
  });
  it('a SCOPED pause names the held kinds instead of claiming dispatch is paused outright', () => {
    const hint = dispatchPausedHint(['build', 'prepare', 'prepare-decision', 'investigate']);
    expect(hint).toContain('build, prepare, prepare-decision, investigate');
    expect(hint).toContain('dispatch-pause.mjs clear');
    expect(hint).not.toBe(DISPATCH_PAUSED_HINT);
  });
});

// #3720 — `--queue-file` (land-advance's item-pull): the caller's list sets membership and order.
describe('queueFileRows (--queue-file)', () => {
  const norm = (n) => String(n).replace(/^#/, '');
  it('keeps the file order, accepts ids as strings, numbers or {num}, and drops repeats and blanks', () => {
    expect(queueFileRows(JSON.stringify(['3653', 3674, { num: '3486' }, '3653', '', null]), norm)).toEqual([{ num: '3653' }, { num: '3674' }, { num: '3486' }]);
  });
  it('refuses anything that is not a JSON array', () => {
    expect(() => queueFileRows('{"a":1}', norm)).toThrow(/JSON array/);
    expect(() => queueFileRows('nope', norm)).toThrow();
  });
});

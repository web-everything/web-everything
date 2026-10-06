/**
 * @file scripts/readiness/__tests__/scope-lease-collect.test.mjs
 * @description Unit proof of the LIVE scope-lease COLLECTOR's PURE core (WE epic #2560 — the IO boundary for the
 *   pure observer). Drives {@link qualifyPaths}, {@link parseObservedFiles}, {@link resolvePredictedScope} and
 *   {@link collectSnapshot} directly with raw strings + injected fakes (NO real git/fs), and an END-TO-END pure
 *   test that composes the real observer ({@link liveScopePicture}) over a collected snapshot. Pins:
 *   the predicted=observed default, the leased-only filter, session pass-through, the committed∪uncommitted
 *   observed union (rename-aware), and that a collected overlap surfaces through the observer.
 */
import { describe, it, expect } from 'vitest';
import {
  qualifyPaths,
  pickFreshestTip,
  parseObservedFiles,
  resolvePredictedScope,
  collectSnapshot,
  breachSig,
  advanceBreachCount,
  backlogItemsFromObserved,
  isDivergedHistory,
  GHOST_GRACE_MS,
} from '../scope-lease-collect.mjs';
import { liveScopePicture } from '../scope-lease-live.mjs';

describe('pickFreshestTip', () => {
  const isAncestor = (a, b) => a <= b;
  it('picks the descendant regardless of candidate order', () => {
    expect(pickFreshestTip(['a', 'c', 'b'], isAncestor)).toBe('c');
    expect(pickFreshestTip(['c', 'a', 'b'], isAncestor)).toBe('c');
  });
  it('keeps the first candidate when no tip contains all others', () => {
    expect(pickFreshestTip(['a', 'b', 'c'], (a, b) => a === b || (a === 'a' && b === 'b'))).toBe('a');
  });
  it('returns null for an empty list', () => {
    expect(pickFreshestTip([], isAncestor)).toBeNull();
  });
  it('ignores duplicates and falsy candidates', () => {
    const calls = [];
    expect(pickFreshestTip([null, 'a', '', 'a', undefined, 'b', 'b'], (a, b) => {
      calls.push([a, b]);
      return isAncestor(a, b);
    })).toBe('b');
    expect(calls).toEqual([['b', 'a'], ['a', 'b']]);
    expect(pickFreshestTip([null, '', undefined], isAncestor)).toBeNull();
  });
  it('keeps the first candidate when ancestry throws', () => {
    expect(pickFreshestTip(['a', 'b'], () => { throw new Error('unreadable'); })).toBe('a');
  });
});

describe('qualifyPaths — repo-qualify, skip empties, pass through when no key', () => {
  it('qualifies each path with the repo key', () => {
    expect(qualifyPaths('we', ['src/a.ts', 'src/b.ts'])).toEqual(['we:src/a.ts', 'we:src/b.ts']);
  });
  it('skips empty / whitespace entries', () => {
    expect(qualifyPaths('we', ['src/a.ts', '', '   ', null, undefined])).toEqual(['we:src/a.ts']);
  });
  it('passes paths through unqualified when repoKey is null / empty', () => {
    expect(qualifyPaths(null, ['src/a.ts'])).toEqual(['src/a.ts']);
    expect(qualifyPaths('', ['src/a.ts'])).toEqual(['src/a.ts']);
  });
  it('tolerates a non-array files input', () => {
    expect(qualifyPaths('we', null)).toEqual([]);
  });
});

describe('parseObservedFiles — union committed diff + porcelain, rename-aware, deduped, qualified', () => {
  it('unions the committed range and the uncommitted working tree', () => {
    const observed = parseObservedFiles({
      diffOut: 'src/a.ts\nsrc/b.ts\n',
      porcelainOut: ' M src/c.ts\n?? src/d.ts\n',
      repoKey: 'we',
    });
    expect(observed.sort()).toEqual(['we:src/a.ts', 'we:src/b.ts', 'we:src/c.ts', 'we:src/d.ts'].sort());
  });
  it('handles a porcelain rename `old -> new` (keeps the new path)', () => {
    const observed = parseObservedFiles({
      diffOut: '',
      porcelainOut: 'R  src/old.ts -> src/new.ts\n',
      repoKey: 'we',
    });
    expect(observed).toEqual(['we:src/new.ts']);
  });
  it('dedupes a path present in both the committed diff and the working tree', () => {
    const observed = parseObservedFiles({
      diffOut: 'src/a.ts\n',
      porcelainOut: ' M src/a.ts\n',
      repoKey: 'we',
    });
    expect(observed).toEqual(['we:src/a.ts']);
  });
  it('tolerates empty inputs → empty list', () => {
    expect(parseObservedFiles({})).toEqual([]);
    expect(parseObservedFiles({ diffOut: '', porcelainOut: '', repoKey: 'we' })).toEqual([]);
  });
  it('passes paths through unqualified when repoKey is null', () => {
    expect(parseObservedFiles({ diffOut: 'src/a.ts\n', repoKey: null })).toEqual(['src/a.ts']);
  });
});

describe('resolvePredictedScope — the #2560 predicted=observed default', () => {
  it('with a non-empty plan → the normalized plan (breach detection ON)', () => {
    expect(resolvePredictedScope({ observed: ['we:src/a.ts'], plan: ['we:src/a', 'we:src/a'] }))
      .toEqual(['we:src/a']); // normScope dedupes
  });
  it('with a null plan → observed values, but a FRESH array (predicted must not alias observed)', () => {
    const observed = ['we:src/a.ts', 'we:src/b.ts'];
    const predicted = resolvePredictedScope({ observed, plan: null });
    expect(predicted).toEqual(observed);
    expect(predicted).not.toBe(observed); // a distinct array — no shared-reference mutation footgun
  });
  it('with an empty-array plan → observed values, still a fresh (non-aliasing) array', () => {
    const observed = ['we:src/a.ts'];
    const predicted = resolvePredictedScope({ observed, plan: [] });
    expect(predicted).toEqual(observed);
    expect(predicted).not.toBe(observed);
  });
  it('a non-empty declared scope WINS over both plan and observed (#2560 marker-declared source)', () => {
    expect(resolvePredictedScope({
      observed: ['we:src/obs.ts'],
      plan: ['we:src/plan'],
      declared: ['we:src/dec', 'we:src/dec'], // normScope dedupes
    })).toEqual(['we:src/dec']);
  });
  it('an empty declared scope falls through to plan (then observed)', () => {
    expect(resolvePredictedScope({ observed: ['we:src/obs.ts'], plan: ['we:src/plan'], declared: [] }))
      .toEqual(['we:src/plan']);
  });
});

// A tiny lane-status factory matching lane-pool's `status --json` row shape.
// `predictedScope` (#2560) → the lease marker's advisory declared scope (from `acquire --scope=`), when set.
const laneRow = (lane, { leased = true, session = `sess-${lane}`, path = `/pool/lane-${lane}`, predictedScope } = {}) => ({
  lane,
  path,
  exists: true,
  head: 'abc1234',
  branch: 'main',
  clean: true,
  behind: 0,
  deps: 'ok',
  lease: leased ? { session, ...(predictedScope ? { predictedScope } : {}) } : null,
  leased,
});

describe('collectSnapshot — pool rows → the observer lease shape', () => {
  it('filters out non-leased lanes (leased:false)', () => {
    const poolStatus = { lanes: [laneRow(1), laneRow(2, { leased: false })] };
    const observedForLane = () => ['we:src/a.ts'];
    const leases = collectSnapshot({ poolStatus, observedForLane });
    expect(leases).toHaveLength(1);
    expect(leases[0].lane).toBe(1);
  });

  it('maps session from the lease and echoes lane', () => {
    const poolStatus = { lanes: [laneRow(7, { session: 'drain-7' })] };
    const leases = collectSnapshot({ poolStatus, observedForLane: () => [] });
    expect(leases[0].session).toBe('drain-7');
    expect(leases[0].lane).toBe(7);
  });

  it('session is null when the lease has none', () => {
    const poolStatus = { lanes: [{ ...laneRow(1), lease: {} }] };
    const leases = collectSnapshot({ poolStatus, observedForLane: () => [] });
    expect(leases[0].session).toBe(null);
  });

  it('predicted = observed when no plan (the default)', () => {
    const poolStatus = { lanes: [laneRow(1)] };
    const observed = ['we:src/a.ts', 'we:src/b.ts'];
    const leases = collectSnapshot({ poolStatus, observedForLane: () => observed });
    expect(leases[0].predictedScope).toEqual(observed);
    expect(leases[0].observedScope).toEqual(observed);
  });

  it('predicted = plan when planForLane supplies one', () => {
    const poolStatus = { lanes: [laneRow(1)] };
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => ['we:src/a/x.ts'],
      planForLane: () => ['we:src/a'],
    });
    expect(leases[0].predictedScope).toEqual(['we:src/a']);
    expect(leases[0].observedScope).toEqual(['we:src/a/x.ts']);
  });

  it('marker predictedScope (from acquire --scope=) WINS over both observed and any plan (#2560)', () => {
    const poolStatus = { lanes: [laneRow(1, { predictedScope: ['we:src/declared.ts'] })] };
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => ['we:src/observed.ts'],
      planForLane: () => ['we:src/planned'],
    });
    expect(leases[0].predictedScope).toEqual(['we:src/declared.ts']); // marker scope, not observed/plan
    expect(leases[0].observedScope).toEqual(['we:src/observed.ts']);
  });

  it('produces the exact observer lease shape (no breachAttempt)', () => {
    const poolStatus = { lanes: [laneRow(1)] };
    const leases = collectSnapshot({ poolStatus, observedForLane: () => ['we:src/a.ts'] });
    expect(Object.keys(leases[0]).sort()).toEqual(['lane', 'observedScope', 'predictedScope', 'session']);
    expect('breachAttempt' in leases[0]).toBe(false);
  });

  it('stamps breachAttempt when the injected counter returns ≥ 1 (WE #2598)', () => {
    const poolStatus = { lanes: [laneRow(1)] };
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => ['we:src/a.ts'],
      breachAttemptForLane: () => 2,
    });
    expect(leases[0].breachAttempt).toBe(2);
  });

  it('OMITS breachAttempt when the injected counter returns 0 (clean / no episode)', () => {
    const poolStatus = { lanes: [laneRow(1)] };
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => ['we:src/a.ts'],
      breachAttemptForLane: () => 0,
    });
    expect('breachAttempt' in leases[0]).toBe(false);
  });

  it('passes the built lease (with scopes/session) to the injected counter', () => {
    const poolStatus = { lanes: [laneRow(1, { session: 'sess-x' })] };
    let seen = null;
    collectSnapshot({
      poolStatus,
      observedForLane: () => ['we:src/a.ts'],
      breachAttemptForLane: (lease) => {
        seen = lease;
        return 1;
      },
    });
    expect(seen.lane).toBe(1);
    expect(seen.session).toBe('sess-x');
    expect(seen.observedScope).toEqual(['we:src/a.ts']);
  });

  it('back-compat: NO lease has breachAttempt when breachAttemptForLane is not passed', () => {
    const poolStatus = { lanes: [laneRow(1), laneRow(2)] };
    const leases = collectSnapshot({ poolStatus, observedForLane: () => ['we:src/a.ts'] });
    expect(leases.every((l) => !('breachAttempt' in l))).toBe(true);
  });

  it('tolerates a pool status with no lanes', () => {
    expect(collectSnapshot({ poolStatus: {}, observedForLane: () => [] })).toEqual([]);
  });
});

describe('isDivergedHistory — both-ahead-and-behind detector (2026-09-14, #3521/lane-2 incident)', () => {
  it('is diverged when both ahead and behind are positive', () => {
    expect(isDivergedHistory(138, 20)).toBe(true);
    expect(isDivergedHistory(1, 1)).toBe(true);
  });
  it('is NOT diverged when either side is zero — a clean ancestor relationship', () => {
    expect(isDivergedHistory(0, 20)).toBe(false); // straight-line behind only (never reset forward, no own work)
    expect(isDivergedHistory(5, 0)).toBe(false); // straight-line ahead only (the normal "fresh reset + edits" shape)
    expect(isDivergedHistory(0, 0)).toBe(false); // exactly on origin/main
  });
  it('never fabricates a flag from missing/unreadable counts (NaN ⇒ not diverged)', () => {
    expect(isDivergedHistory(NaN, 20)).toBe(false);
    expect(isDivergedHistory(138, NaN)).toBe(false);
    expect(isDivergedHistory(undefined, undefined)).toBe(false);
  });
});

describe('collectSnapshot — historyDiverged stamping (2026-09-14, #3521/lane-2 incident)', () => {
  const poolStatus = { lanes: [{ lane: 2, leased: true, lease: { session: 's' }, path: '/p' }] };

  it('stamps historyDiverged: true when the injected checker says the lane is diverged', () => {
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => ['we:scripts/operations/run-record.mjs'],
      divergedForLane: () => true,
    });
    expect(leases[0].historyDiverged).toBe(true);
  });
  it('omits historyDiverged (not `false`) when the checker says clean', () => {
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => ['we:src/a.ts'],
      divergedForLane: () => false,
    });
    expect(leases[0]).not.toHaveProperty('historyDiverged');
  });
  it('omits historyDiverged when no checker is injected — exact back-compat', () => {
    const leases = collectSnapshot({ poolStatus, observedForLane: () => ['we:src/a.ts'] });
    expect(leases[0]).not.toHaveProperty('historyDiverged');
  });
});

describe('backlogItemsFromObserved — claimed-item ids evidenced in the observed diff (WE #2623)', () => {
  it('extracts the backlog number from a repo-qualified backlog path', () => {
    expect(backlogItemsFromObserved(['we:backlog/2623-conveyor-lease.md'])).toEqual(['2623']);
  });
  it('extracts from an unqualified backlog path too', () => {
    expect(backlogItemsFromObserved(['backlog/2611-conveyor-state.md'])).toEqual(['2611']);
  });
  it('ignores non-backlog paths and dedupes, first-seen order', () => {
    expect(
      backlogItemsFromObserved(['we:src/a.ts', 'we:backlog/2623-x.md', 'we:scripts/y.mjs', 'we:backlog/2623-x.md']),
    ).toEqual(['2623']);
  });
  it('is empty for a lane with no backlog file in its observed scope', () => {
    expect(backlogItemsFromObserved(['we:src/a.ts', 'we:scripts/readiness/x.mjs'])).toEqual([]);
    expect(backlogItemsFromObserved([])).toEqual([]);
  });
  it('tolerates a non-array input', () => {
    expect(backlogItemsFromObserved(null)).toEqual([]);
  });
});

describe('collectSnapshot — empty/stale (ghost) lease drop (WE #2623)', () => {
  // A finished-agent lane: still leased, carries its STALE marker-declared predicted scope, but has EMPTY observed
  // scope and no claimed item. Its leftover predicted scope is exactly what falsely blocks a new dispatch.
  const ghostLane = (lane) => laneRow(lane, { predictedScope: ['we:scripts/readiness/'] });
  const OLD = GHOST_GRACE_MS + 1; // held past the grace → eligible to reap
  const FRESH = 1_000; // seconds old → still inside the acquire→claim window

  it('DROPS a ghost lease: item-aware, empty observed, no claimed item, held past the grace', () => {
    const poolStatus = { lanes: [ghostLane(1)] };
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => [], // no diff / no git status change
      itemsForLane: () => [], // no claimed backlog item
      leaseAgeMsForLane: () => OLD,
    });
    expect(leases).toEqual([]);
  });

  it('REGRESSION GUARD: KEEPS a FRESH empty lease (inside the acquire→claim window) — its reservation still holds', () => {
    const poolStatus = { lanes: [ghostLane(1)] };
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => [], // acquired, not yet claimed → no diff YET
      itemsForLane: () => [],
      leaseAgeMsForLane: () => FRESH, // seconds old — must NOT be reaped (a rival would else overlap it)
    });
    expect(leases).toHaveLength(1);
    expect(leases[0].predictedScope).toEqual(['we:scripts/readiness/']);
  });

  it('KEEPS an empty, unclaimed lease of UNKNOWN age (null) — never reap what we cannot age', () => {
    const poolStatus = { lanes: [ghostLane(1)] };
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => [],
      itemsForLane: () => [],
      leaseAgeMsForLane: () => null, // unparseable/missing acquiredAt
    });
    expect(leases).toHaveLength(1);
  });

  it('KEEPS a real lease with a claimed item even when observed is empty and it is old (pure contract)', () => {
    const poolStatus = { lanes: [ghostLane(1)] };
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => [],
      itemsForLane: () => ['2623'], // holds a claim → a real work stream, not a ghost
      leaseAgeMsForLane: () => OLD,
    });
    expect(leases).toHaveLength(1);
    expect(leases[0].lane).toBe(1);
  });

  it('KEEPS a real lease with observed diff even when old and holding no claimed item', () => {
    const poolStatus = { lanes: [ghostLane(1)] };
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => ['we:scripts/readiness/x.mjs'], // real live work
      itemsForLane: () => [],
      leaseAgeMsForLane: () => OLD,
    });
    expect(leases).toHaveLength(1);
    expect(leases[0].observedScope).toEqual(['we:scripts/readiness/x.mjs']);
  });

  it('PRODUCTION WIRING: item signal derived from the SAME observed source (shell shape) — old ghost dropped, claim-in-diff kept', () => {
    // Mirror the IO shell: one observed source feeds both observedForLane and itemsForLane (via backlogItemsFromObserved).
    const poolStatus = { lanes: [ghostLane(1), ghostLane(2)] };
    const observedByLane = { 1: [], 2: ['we:backlog/2624-x.md', 'we:scripts/conveyor/y.mjs'] };
    const observedForLane = (l) => observedByLane[l.lane];
    const leases = collectSnapshot({
      poolStatus,
      observedForLane,
      itemsForLane: (l) => backlogItemsFromObserved(observedForLane(l)),
      leaseAgeMsForLane: () => OLD, // both old; only lane-1 (empty, no claim) is a ghost
    });
    expect(leases.map((l) => l.lane)).toEqual([2]);
  });

  it('BACK-COMPAT: with NO itemsForLane, a zero-observed lease is KEPT (not dropped)', () => {
    const poolStatus = { lanes: [ghostLane(1)] };
    const leases = collectSnapshot({ poolStatus, observedForLane: () => [], leaseAgeMsForLane: () => OLD });
    expect(leases).toHaveLength(1);
    expect(leases[0].predictedScope).toEqual(['we:scripts/readiness/']);
  });

  it('a non-array itemsForLane result is treated as no claim (a ghost when empty + old)', () => {
    const poolStatus = { lanes: [ghostLane(1)] };
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => [],
      itemsForLane: () => null,
      leaseAgeMsForLane: () => OLD,
    });
    expect(leases).toEqual([]);
  });
});

describe('END-TO-END (pure) — collectSnapshot → liveScopePicture', () => {
  it('two leased lanes whose observed scopes OVERLAP ⇒ the observer reports the overlap, clean:false', () => {
    const poolStatus = { lanes: [laneRow(1), laneRow(2)] };
    const observedByLane = {
      1: ['we:src/shared.ts', 'we:src/a.ts'],
      2: ['we:src/shared.ts', 'we:src/b.ts'], // overlaps lane-1 on we:src/shared.ts
    };
    const leases = collectSnapshot({ poolStatus, observedForLane: (l) => observedByLane[l.lane] });
    const picture = liveScopePicture({ leases });
    expect(picture.overlaps).toHaveLength(1);
    expect([picture.overlaps[0].a, picture.overlaps[0].b].sort()).toEqual([1, 2]);
    expect(picture.overlaps[0].outcome).toBeTruthy(); // an outcome is present (wait, by default policy)
    expect(picture.clean).toBe(false);
    // predicted=observed ⇒ no false breach on either lane.
    expect(picture.breachedLanes).toEqual([]);
  });

  it('a dropped ghost lease (WE #2623) contributes NO stale predicted scope to the picture', () => {
    // Lane-1 finished: still leased, marker-declared predicted scope, but empty observed + no claim. Its leftover
    // predicted scope must NOT surface as a live lease — else the dispatcher would false-block an overlapping item.
    const poolStatus = { lanes: [laneRow(1, { predictedScope: ['we:scripts/readiness/'] })] };
    const leases = collectSnapshot({
      poolStatus,
      observedForLane: () => [],
      itemsForLane: () => [],
      leaseAgeMsForLane: () => GHOST_GRACE_MS + 1, // finished long ago → reaped
    });
    const picture = liveScopePicture({ leases });
    expect(picture.leases).toEqual([]); // the ghost is gone — no scope, no overlap contribution
    expect(picture.clean).toBe(true);
  });

  it('two leased lanes with DISJOINT observed scopes ⇒ clean:true, no overlaps', () => {
    const poolStatus = { lanes: [laneRow(1), laneRow(2)] };
    const observedByLane = {
      1: ['we:src/a.ts'],
      2: ['we:src/b.ts'],
    };
    const leases = collectSnapshot({ poolStatus, observedForLane: (l) => observedByLane[l.lane] });
    const picture = liveScopePicture({ leases });
    expect(picture.overlaps).toEqual([]);
    expect(picture.clean).toBe(true);
  });

  it('FILE-GRANULAR declared scopes sharing a directory do NOT false-serialize (WE #2679)', () => {
    // Two lanes declare NARROW file-level scopes (from `acquire --scope=`) that merely share `we:scripts/`.
    // Under file granularity they run in parallel — the #2673/console-board false positive is gone.
    const poolStatus = {
      lanes: [
        laneRow(1, { predictedScope: ['we:scripts/guard-backward-edge.mjs'] }),
        laneRow(2, { predictedScope: ['we:scripts/lib/pr-merge-gate.mjs'] }),
      ],
    };
    const observedByLane = { 1: ['we:scripts/guard-backward-edge.mjs'], 2: ['we:scripts/lib/pr-merge-gate.mjs'] };
    const leases = collectSnapshot({ poolStatus, observedForLane: (l) => observedByLane[l.lane] });
    const picture = liveScopePicture({ leases });
    expect(picture.overlaps).toEqual([]);
    expect(picture.clean).toBe(true);
    expect(picture.breachedLanes).toEqual([]); // observed ⊆ file-level predicted ⇒ no false breach
  });

  it('a genuine same-file dependency still contends through the collector (WE #2679) — #2440↔#2669', () => {
    const shared = 'we:scripts/lib/pr-merge-gate.mjs';
    const poolStatus = {
      lanes: [laneRow(1, { predictedScope: [shared] }), laneRow(2, { predictedScope: [shared] })],
    };
    const observedByLane = { 1: [shared], 2: [shared] };
    const leases = collectSnapshot({ poolStatus, observedForLane: (l) => observedByLane[l.lane] });
    const picture = liveScopePicture({ leases });
    expect(picture.overlaps).toHaveLength(1);
    expect(picture.clean).toBe(false);
  });

  it('a BROAD directory declaration still serializes work under it (correct overlap preserved, WE #2679)', () => {
    // Lane-1 genuinely spans the whole `we:scripts` subtree; lane-2 touches a file under it ⇒ they contend.
    const poolStatus = {
      lanes: [
        laneRow(1, { predictedScope: ['we:scripts/'] }),
        laneRow(2, { predictedScope: ['we:scripts/backlog.mjs'] }),
      ],
    };
    const observedByLane = { 1: ['we:scripts/a.mjs'], 2: ['we:scripts/backlog.mjs'] };
    const leases = collectSnapshot({ poolStatus, observedForLane: (l) => observedByLane[l.lane] });
    const picture = liveScopePicture({ leases });
    expect(picture.overlaps).toHaveLength(1);
    expect(picture.clean).toBe(false);
  });
});

describe('breachSig — order-independent breach-set signature (WE #2598)', () => {
  it('is order-independent (same sig regardless of input order)', () => {
    expect(breachSig(['we:b', 'we:a'])).toBe(breachSig(['we:a', 'we:b']));
  });
  it('signs an empty breach to the "" clean sentinel', () => {
    expect(breachSig([])).toBe('');
  });
  it('a different file-set signs differently', () => {
    expect(breachSig(['we:a', 'we:b'])).not.toBe(breachSig(['we:a', 'we:c']));
  });
});

describe('advanceBreachCount — episode = rising edge of a new/changed breach (WE #2598)', () => {
  it('FIRST breach (prev undefined) → attempts 1, sig set', () => {
    const next = advanceBreachCount(undefined, ['we:a'], 'sess-1');
    expect(next.attempts).toBe(1);
    expect(next.sig).toBe(breachSig(['we:a']));
    expect(next.session).toBe('sess-1');
  });

  it('the SAME breach again → attempts UNCHANGED (no new rising edge)', () => {
    const first = advanceBreachCount(undefined, ['we:a'], 'sess-1');
    const again = advanceBreachCount(first, ['we:a'], 'sess-1');
    expect(again.attempts).toBe(1);
    expect(again.sig).toBe(first.sig);
    expect(again.session).toBe('sess-1');
  });

  it('a CHANGED breach set → attempts 2 (a new episode)', () => {
    const first = advanceBreachCount(undefined, ['we:a'], 'sess-1');
    const changed = advanceBreachCount(first, ['we:a', 'we:b'], 'sess-1');
    expect(changed.attempts).toBe(2);
    expect(changed.sig).toBe(breachSig(['we:a', 'we:b']));
  });

  it('a CLEAN observation ([]) → attempts 0, sig ""', () => {
    const first = advanceBreachCount(undefined, ['we:a'], 'sess-1');
    const clean = advanceBreachCount(first, [], 'sess-1');
    expect(clean.attempts).toBe(0);
    expect(clean.sig).toBe('');
    expect(clean.session).toBe('sess-1');
  });

  it('a NEW occupant (session changed) RESETS → attempts 1 on breach', () => {
    const first = advanceBreachCount(undefined, ['we:a'], 'sess-1'); // attempts 1 under sess-1
    const bumped = advanceBreachCount(first, ['we:a', 'we:b'], 'sess-1'); // attempts 2 under sess-1
    expect(bumped.attempts).toBe(2);
    const newHolder = advanceBreachCount(bumped, ['we:a'], 'sess-2'); // different session → reset
    expect(newHolder.attempts).toBe(1);
    expect(newHolder.sig).toBe(breachSig(['we:a']));
    expect(newHolder.session).toBe('sess-2');
  });

  it('coerces a corrupt prev (non-object / bad attempts) to a fresh start', () => {
    expect(advanceBreachCount(null, ['we:a'], 'sess-1').attempts).toBe(1);
    expect(advanceBreachCount({ attempts: -5, sig: 42 }, ['we:a'], 'sess-1').attempts).toBe(1);
  });
});

describe('END-TO-END escalation through the REAL observer (WE #2598)', () => {
  // A lane whose predicted ≠ observed → a REAL breach the observer's breachOutcome acts on.
  const breachedPool = { lanes: [laneRow(1, { predictedScope: ['we:src/planned.ts'] })] };
  const observedForLane = () => ['we:src/OUT-of-scope.ts']; // outside the planned scope ⇒ breach
  const policy = { breachMidBuild: 'pause', overlapAtLaunch: 'wait', retryBound: 1 };

  it('attempt 2 > retryBound 1 ⇒ outcome.escalated === true', () => {
    const leases = collectSnapshot({ poolStatus: breachedPool, observedForLane, breachAttemptForLane: () => 2 });
    const picture = liveScopePicture({ leases, policy });
    const breachedLease = picture.leases.find((s) => !s.clean);
    expect(breachedLease.breach).toEqual(['we:src/OUT-of-scope.ts']); // a real breach was collected
    expect(breachedLease.outcome.escalated).toBe(true);
  });

  it('CONTROL: attempt 1 (≤ retryBound) ⇒ outcome.escalated === false', () => {
    const leases = collectSnapshot({ poolStatus: breachedPool, observedForLane, breachAttemptForLane: () => 1 });
    const picture = liveScopePicture({ leases, policy });
    const breachedLease = picture.leases.find((s) => !s.clean);
    expect(breachedLease.outcome.escalated).toBe(false);
    expect(breachedLease.outcome.action).toBe('retry-in-place');
  });
});

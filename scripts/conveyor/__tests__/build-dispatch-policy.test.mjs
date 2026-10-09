import { describe, it, expect } from 'vitest';
import {
  BUILD_DISPATCH_POLICY, parseScopeEntry, pathsOverlap, firstScopeOverlap, branchRefPolicy, plannedBuildRef,
  prDeliversNum, normalizeOpenPrs, planBuildDispatch, reportOpenItems,
  prepareAheadNums, daysBetween, stampCoversClaim, collectBuildHolds,
} from '../build-dispatch-policy.mjs';

const cand = (num, scope) => ({ num, lane: null, scope });
const pr = (repo, number, files = [], labels = [], headRefName = 'lane/other-x') => ({ repo, number, files: files.map((p) => ({ repo, path: p })), labels, headRefName });

describe('scope helpers', () => {
  it('parses repo-qualified entries, defaulting to we and folding plateau → plateau-app', () => {
    expect(parseScopeEntry('plateau-app:src/a.ts')).toEqual({ repo: 'plateau-app', path: 'src/a.ts' });
    expect(parseScopeEntry('plateau:src/a.ts')).toEqual({ repo: 'plateau-app', path: 'src/a.ts' });
    expect(parseScopeEntry('scripts/x.mjs')).toEqual({ repo: 'we', path: 'scripts/x.mjs' });
    expect(parseScopeEntry('  ')).toBeNull();
  });
  it('overlaps on equal paths and directory prefixes only at segment boundaries', () => {
    expect(pathsOverlap('src/a.ts', 'src/a.ts')).toBe(true);
    expect(pathsOverlap('src/', 'src/a.ts')).toBe(true);
    expect(pathsOverlap('src/a', 'src/ab.ts')).toBe(false);
  });
  it('never overlaps across repos', () => {
    expect(firstScopeOverlap(['we:src/a.ts'], ['plateau-app:src/a.ts'])).toBeNull();
    expect(firstScopeOverlap(['plateau-app:src/a.ts'], [{ repo: 'plateau-app', path: 'src/a.ts' }])).toBe('plateau-app:src/a.ts');
  });
});

describe('branch-name rule', () => {
  it('refuses a ref that starts with a bare number and accepts the lane/ delivery ref', () => {
    expect(branchRefPolicy('2385-foo').ok).toBe(false);
    expect(branchRefPolicy(plannedBuildRef('2385')).ok).toBe(true);
    expect(plannedBuildRef('#042')).toBe('lane/42-build');
  });
  it('matches a delivering PR by its leading num only', () => {
    expect(prDeliversNum({ headRefName: 'lane/2385-ssr' }, '2385')).toBe(true);
    expect(prDeliversNum({ headRefName: 'lane/2385b-ssr' }, '2385')).toBe(true);
    expect(prDeliversNum({ headRefName: 'lane/23850-ssr' }, '2385')).toBe(false);
    expect(prDeliversNum({ headRefName: 'lane/xcd92xh-x' }, 'xcd92xh')).toBe(true);
    expect(prDeliversNum({ headRefName: 'lane/draft-first-prs' }, '2385')).toBe(false);
  });
});

describe('planBuildDispatch', () => {
  it('caps concurrent builds, counting durable in-flight work', () => {
    const r = planBuildDispatch({
      candidates: [cand('1', ['we:a']), cand('2', ['we:b']), cand('3', ['we:c'])],
      inFlight: [{ num: '9', scope: ['we:z'], source: 'claim' }],
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 3 },
    });
    expect(r.dispatch.map((x) => x.num)).toEqual(['1', '2']);
    expect(r.hold).toEqual([expect.objectContaining({ num: '3', rule: 'cap' })]);
  });
  // Card x3vs6tu, live 2026-09-29: `externalBuilding` (the conveyor's machine-wide "building" count — hand
  // workers, fix/ci-heal workers, stranded claims) must NEVER gate this builder's own cap any more — only its
  // own durable in-flight builds do. Machine load is the separate load guard's (#4076) job. It still rides
  // through on the return value purely as a logged signal.
  it('never folds externalBuilding into the cap — it only bounds this builder\'s OWN in-flight builds', () => {
    const r = planBuildDispatch({ candidates: [cand('1', ['we:a']), cand('2', ['we:b'])], externalBuilding: 2, policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 3 } });
    expect(r.dispatch.map((x) => x.num)).toEqual(['1', '2']);
    expect(r.busy).toBe(0);
    expect(r.externalBuilding).toBe(2);
  });
  it('6 external building, 0 own in-flight, cap 3 → 3 free slots (the live-incident shape: a machine-wide '
    + 'count must never starve this builder of its own capacity)', () => {
    const r = planBuildDispatch({
      candidates: [],
      externalBuilding: 6,
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 3 },
    });
    expect(r.busy).toBe(0);
    expect(r.slots).toBe(3);
    expect(r.externalBuilding).toBe(6);
  });
  it('freezes on too many open PRs or the operator\'s manual daemon-bug flag', () => {
    const many = Array.from({ length: 13 }, (_, i) => pr('we', i + 1));
    expect(planBuildDispatch({ candidates: [cand('1', ['we:a'])], openPrs: many }).hold[0].rule).toBe('landing-freeze');
    const stuck = planBuildDispatch({ candidates: [cand('1', ['we:a'])], openPrs: [pr('we', 5, [], ['blocked:daemon-bug'])] });
    expect(stuck.freeze.frozen).toBe(true);
    expect(stuck.hold[0].reason).toMatch(/we#5 is labelled blocked:daemon-bug/);
  });

  // LIVE INCIDENT, we#2852, 2026-09-28: a single PR mislabelled `review-status:ci-heal-stalled` (root cause:
  // we:scripts/conveyor/review-status-tag.mjs read a genuinely FINISHED ci-heal session as stalled) froze EVERY
  // queued build via this exact `freezeSet`/`frozen` gate, unrelated scope or not — `build-dispatch-daemon.mjs
  // --dry-run` showed `dispatch: []` for candidates with disjoint scope from #2852. A per-PR `*-stalled` label
  // (fix/ci-heal/review) must never freeze the whole queue: it is informative/derived, not an operator decision
  // (`blocked:daemon-bug`, tested above, is the only label that still does). This pins the RED/GREEN shape of
  // that fix: a disjoint-scope candidate dispatches, an overlapping one still correctly waits — via the ordinary
  // `scope-vs-open-prs` rule, which already runs per-candidate against every open PR unconditionally.
  it('a per-PR *-stalled label never freezes the whole queue — only scope-vs-open-prs holds an overlapping candidate', () => {
    const stalledPr = pr('we', 2852, ['scripts/conveyor/build-dispatch-policy.mjs'], ['review-status:ci-heal-stalled']);
    const r = planBuildDispatch({
      candidates: [cand('4360', ['we:scripts/conveyor/review-status-tag.mjs']), cand('4361', ['we:scripts/conveyor/build-dispatch-policy.mjs'])],
      openPrs: [stalledPr],
    });
    expect(r.freeze.frozen).toBe(false);
    expect(r.dispatch.map((x) => x.num)).toEqual(['4360']);
    expect(r.hold.find((h) => h.num === '4361')).toMatchObject({ rule: 'scope-vs-open-prs' });
    expect(r.hold.find((h) => h.num === '4361').reason).toMatch(/we#2852/);
  });

  it('review-stalled and fix-stalled are the same non-freezing shape as ci-heal-stalled', () => {
    for (const label of ['review-status:review-stalled', 'review-status:fix-stalled']) {
      const r = planBuildDispatch({ candidates: [cand('1', ['we:unrelated.mjs'])], openPrs: [pr('we', 9, ['other/file.ts'], [label])] });
      expect(r.freeze.frozen).toBe(false);
      expect(r.dispatch.map((x) => x.num)).toEqual(['1']);
    }
  });

  it('globalFreezeLabels declares exactly blocked:daemon-bug — the three *-stalled labels stay in freezeLabels only for display', () => {
    expect(BUILD_DISPATCH_POLICY.globalFreezeLabels).toEqual(['blocked:daemon-bug']);
    expect(BUILD_DISPATCH_POLICY.freezeLabels).toEqual([
      'review-status:fix-stalled', 'review-status:ci-heal-stalled', 'review-status:review-stalled', 'blocked:daemon-bug',
    ]);
  });
  it('the kill switch freezes everything', () => {
    const r = planBuildDispatch({ candidates: [cand('1', ['we:a'])], killSwitch: { engaged: true, reason: 'test' } });
    expect(r.dispatch).toEqual([]);
    expect(r.hold[0].reason).toMatch(/kill switch/);
  });
  it('holds a build whose scope touches an open PR\'s files', () => {
    const r = planBuildDispatch({ candidates: [cand('1', ['we:scripts/conveyor/runner.mjs'])], openPrs: [pr('we', 2813, ['scripts/conveyor/runner.mjs'])] });
    expect(r.hold[0]).toMatchObject({ rule: 'scope-vs-open-prs' });
    expect(r.hold[0].reason).toMatch(/we#2813/);
  });
  it('#4295 holds a build whose scope overlaps a live FIX claim, naming the fix PR', () => {
    const r = planBuildDispatch({
      candidates: [cand('1', ['we:scripts/conveyor/x.mjs']), cand('2', ['we:docs/y.md'])],
      fixInFlight: [{ pr: 88, scope: ['we:scripts/conveyor/'] }],
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 3 },
    });
    expect(r.hold.find((h) => h.num === '1')).toMatchObject({ rule: 'hot-file' });
    expect(r.hold.find((h) => h.num === '1').reason).toMatch(/being fixed by PR #88/);
    expect(r.dispatch.map((x) => x.num)).toEqual(['2']);
  });
  it('#4295 without fixInFlight behaves as before', () => {
    const r = planBuildDispatch({ candidates: [cand('1', ['we:scripts/conveyor/x.mjs'])] });
    expect(r.dispatch.map((x) => x.num)).toEqual(['1']);
  });
  it('serialises hot files: against in-flight builds and within one tick', () => {
    const r = planBuildDispatch({
      candidates: [cand('1', ['plateau-app:src/main.ts']), cand('2', ['plateau-app:src/main.ts', 'plateau-app:src/x.ts']), cand('3', ['we:q'])],
      inFlight: [{ num: '7', scope: ['we:q'], source: 'claim' }],
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 3 },
    });
    expect(r.dispatch.map((x) => x.num)).toEqual(['1']);
    expect(r.hold.find((h) => h.num === '2')).toMatchObject({ rule: 'hot-file' });
    expect(r.hold.find((h) => h.num === '3').reason).toMatch(/#7/);
  });
  it('holds an item already in flight or already delivered by an open PR', () => {
    const r = planBuildDispatch({
      candidates: [cand('7', ['we:a']), cand('8', ['we:b'])],
      inFlight: [{ num: '7', scope: ['we:a'], source: 'claim' }],
      openPrs: [pr('we', 99, [], [], 'lane/8-thing')],
    });
    expect(r.dispatch).toEqual([]);
    expect(r.hold.map((h) => h.rule)).toEqual(['in-flight', 'in-flight']);
  });
  it('refuses to dispatch an unscoped item (cannot prove disjointness)', () => {
    expect(planBuildDispatch({ candidates: [cand('1', [])] }).hold[0].rule).toBe('scope-vs-open-prs');
  });
  it('normalizes open PRs from the gh shape', () => {
    expect(normalizeOpenPrs([{ repo: 'we', prs: [{ number: 1, headRefName: 'lane/1-x', labels: [{ name: 'l' }], files: [{ path: 'a' }] }] }]))
      .toEqual([{ repo: 'we', number: 1, headRefName: 'lane/1-x', labels: ['l'], files: [{ repo: 'we', path: 'a' }] }]);
  });
  it('declares every operator rule with who enforces it', () => {
    expect(BUILD_DISPATCH_POLICY.rules.map((r) => r.id)).toEqual(['cap', 'wip-cap', 'landing-freeze', 'main-red', 'scope-vs-open-prs', 'hot-file', 'branch-name', 'scratch-prefix', 'draft-first', 'needs-prepare', 'prepare-ahead-window', 'prepare-stale']);
    expect(BUILD_DISPATCH_POLICY.maxConcurrentBuilds).toBe(1);
    expect(BUILD_DISPATCH_POLICY.maxConcurrentExternalBuilds).toBe(4);
    expect(BUILD_DISPATCH_POLICY.maxOpenItems).toBe(7);
  });
});

// #4353 — open-item WIP cap: {inFlight} ∪ {delivered-by-open-PR}, separate from maxConcurrentBuilds.
describe('planBuildDispatch — wip-cap (#4353)', () => {
  it('holds a candidate once open items reach maxOpenItems, even with free build slots', () => {
    // 6 open items already (3 in-flight + 3 delivered by open PRs, all distinct nums), cap 7, plenty of build
    // slots free (maxConcurrentBuilds 10, only 3 busy) — the wip-cap, not the concurrency cap, is what bites.
    const inFlight = [{ num: '1', scope: ['we:a'] }, { num: '2', scope: ['we:b'] }, { num: '3', scope: ['we:c'] }];
    const openPrs = [pr('we', 91, [], [], 'lane/4-x'), pr('we', 92, [], [], 'lane/5-x'), pr('we', 93, [], [], 'lane/6-x')];
    const r = planBuildDispatch({
      candidates: [cand('7', ['we:g'])],
      inFlight, openPrs,
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 10, maxOpenItems: 7 },
    });
    expect(r.openItems).toEqual({ count: 6, cap: 7, nums: ['1', '2', '3', '4', '5', '6'] });
    expect(r.dispatch.map((x) => x.num)).toEqual(['7']); // the 7th fits exactly at the cap
    const r2 = planBuildDispatch({
      candidates: [cand('7', ['we:g']), cand('8', ['we:h'])],
      inFlight, openPrs,
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 10, maxOpenItems: 7 },
    });
    expect(r2.dispatch.map((x) => x.num)).toEqual(['7']);
    expect(r2.hold).toEqual([expect.objectContaining({ num: '8', rule: 'wip-cap' })]);
    expect(r2.hold[0].reason).toMatch(/7 open items \(cap 7\): 1, 2, 3, 4, 5, 6, 7/);
  });

  it('decrements the wip-cap WITHIN one tick, admitting only what still fits — not a static pre-tick gate', () => {
    // The boundary case: 6 open items, wip-cap 7 (room for exactly 1 more), maxConcurrentBuilds 5 with 3 busy
    // (room for 2 more under the plain concurrency cap ALONE) — offering 3 fresh candidates in one tick must
    // admit only 1 (the tighter of the two caps), proving the wip-cap decrements within the loop like the
    // existing `cap` rule's `slots` already does, rather than gating once against the pre-tick snapshot (which
    // would wrongly admit 2, reading "6 < 7" for both of the first two candidates).
    const inFlight = [{ num: '1', scope: ['we:a'] }, { num: '2', scope: ['we:b'] }, { num: '3', scope: ['we:c'] }];
    const openPrs = [pr('we', 91, [], [], 'lane/4-x'), pr('we', 92, [], [], 'lane/5-x'), pr('we', 93, [], [], 'lane/6-x')];
    const r = planBuildDispatch({
      candidates: [cand('7', ['we:g']), cand('8', ['we:h']), cand('9', ['we:i'])],
      inFlight, openPrs,
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 5, maxOpenItems: 7 },
    });
    expect(r.dispatch.map((x) => x.num)).toEqual(['7']);
    expect(r.hold.filter((h) => h.rule === 'wip-cap').map((h) => h.num)).toEqual(['8', '9']);
  });

  it('the union, not a sum: a build already in flight whose own PR is also open counts once', () => {
    const r = planBuildDispatch({
      candidates: [cand('99', ['we:z'])],
      inFlight: [{ num: '1', scope: ['we:a'] }],
      openPrs: [pr('we', 1, [], [], 'lane/1-x')], // same num #1 — already in-flight AND already has an open PR
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 10, maxOpenItems: 2 },
    });
    expect(r.openItems).toEqual({ count: 1, cap: 2, nums: ['1'] });
    expect(r.dispatch.map((x) => x.num)).toEqual(['99']); // #1 counts once, so there is still room for one more
  });

  it('a PR carrying review:human still counts toward the wip cap — no special-case exclusion', () => {
    const r = planBuildDispatch({
      candidates: [cand('2', ['we:b'])],
      openPrs: [pr('we', 1, [], ['review:human'], 'lane/1-x')],
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 10, maxOpenItems: 1 },
    });
    expect(r.openItems.nums).toEqual(['1']);
    expect(r.hold).toEqual([expect.objectContaining({ num: '2', rule: 'wip-cap' })]);
  });

  it('the count is stable across the claim→PR handoff, so a repair round never double-counts (it never opens a second PR)', () => {
    // `planBuildDispatch` has no notion of "a commit landed" — a fix/CI-heal/conflict-resolution pass is,
    // from its inputs, indistinguishable from doing nothing, because repair work is a commit onto the SAME
    // open PR (same `headRefName`, same num), never a second one (Risks, #4353: "the union already gets this
    // right for free"). What DOES change across a real build's lifetime is which of the two union SOURCES
    // carries the num: while the build runs, it is `inFlight`; once it settles (#4349) but before it merges,
    // only the still-open PR carries it. This test pins that the union counts the item exactly once either
    // way, so nothing double-counts across that handoff.
    const tickA = planBuildDispatch({
      candidates: [], inFlight: [{ num: '1', scope: ['we:a'] }], openPrs: [pr('we', 1, [], [], 'lane/1-x')],
      policy: { ...BUILD_DISPATCH_POLICY, maxOpenItems: 7 },
    });
    const tickB = planBuildDispatch({
      candidates: [], inFlight: [], openPrs: [pr('we', 1, [], [], 'lane/1-x')],
      policy: { ...BUILD_DISPATCH_POLICY, maxOpenItems: 7 },
    });
    expect(tickA.openItems).toEqual(tickB.openItems);
    expect(tickA.openItems).toEqual({ count: 1, cap: 7, nums: ['1'] });
  });

  it('a candidate already delivered by an open PR (but not itself in-flight) is excluded by the pre-existing '
    + '`in-flight` rule before the wip-cap check is ever reached — it never counts twice or slips past the cap', () => {
    // num '5' has an open PR but no claim/run-store row at all (e.g. the claim already retired on a settled
    // outcome, #4349) — it must still be held (by the EXISTING `deliveringPr` check, unchanged by this card),
    // never fall through to wip-cap and get admitted just because it is absent from `inFlightByNum`.
    const r = planBuildDispatch({
      candidates: [cand('5', ['we:e'])],
      openPrs: [pr('we', 1, [], [], 'lane/5-x')],
      policy: { ...BUILD_DISPATCH_POLICY, maxOpenItems: 7 },
    });
    expect(r.dispatch).toEqual([]);
    expect(r.hold).toEqual([expect.objectContaining({ num: '5', rule: 'in-flight' })]);
  });

  it('a policy object missing maxOpenItems (an older caller) falls back to the declared default rather than '
    + 'silently disabling the cap', () => {
    const staleShape = { maxConcurrentBuilds: 10, maxOpenPrs: 12 }; // no maxOpenItems field at all
    const openPrs = Array.from({ length: BUILD_DISPATCH_POLICY.maxOpenItems }, (_, i) => pr('we', 100 + i, [], [], `lane/${200 + i}-x`));
    const r = planBuildDispatch({ candidates: [cand('999', ['we:z'])], openPrs, policy: staleShape });
    expect(r.openItems.cap).toBe(BUILD_DISPATCH_POLICY.maxOpenItems);
    expect(r.hold).toEqual([expect.objectContaining({ num: '999', rule: 'wip-cap' })]);
  });

  it('reportOpenItems renames `nums` to `filling` for the report/status-line shape, unchanged otherwise', () => {
    expect(reportOpenItems({ count: 2, cap: 7, nums: ['1', '2'] })).toEqual({ count: 2, cap: 7, filling: ['1', '2'] });
  });

  it('an open PR with no delivery-ref shape (a hand-made / non-item PR) counts toward maxOpenPrs but not maxOpenItems', () => {
    const r = planBuildDispatch({
      candidates: [cand('2', ['we:b'])],
      openPrs: [pr('we', 1, [], [], 'lane/investigate-lane-reset')],
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 10, maxOpenItems: 1 },
    });
    expect(r.openItems).toEqual({ count: 0, cap: 1, nums: [] });
    expect(r.dispatch.map((x) => x.num)).toEqual(['2']); // not held — the non-delivering PR is invisible to the union
  });
});

// xovjhwh (operator decision 2026-09-29): `maxOpenItems` counts only the builder's OWN open-PR deliveries, not
// every open PR whose branch merely names a card. Live incident: openItems read 7/7 filled by six worker PRs
// (fix/ci-heal/hand-dispatched), so wip-cap held the builder's own cleared items and it built nothing.
describe('planBuildDispatch — wip-cap counts only the builder\'s own items (xovjhwh)', () => {
  it('a worker-dispatched item with an open PR (num absent from dispatchedByBuilder) is NOT counted toward maxOpenItems', () => {
    const r = planBuildDispatch({
      candidates: [cand('2', ['we:b'])],
      openPrs: [pr('we', 1, [], [], 'lane/1-x')], // a hand-dispatched worker's PR — the builder never dispatched #1
      dispatchedByBuilder: new Set(), // this builder has no run record for #1 at all
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 10, maxOpenItems: 1 },
    });
    expect(r.openItems).toEqual({ count: 0, cap: 1, nums: [] });
    expect(r.dispatch.map((x) => x.num)).toEqual(['2']); // not held — a worker PR never fills the cap
  });

  it('a builder-dispatched item with an open PR (num present in dispatchedByBuilder) IS counted, unchanged from today', () => {
    const r = planBuildDispatch({
      candidates: [cand('2', ['we:b'])],
      openPrs: [pr('we', 1, [], [], 'lane/1-x')],
      dispatchedByBuilder: new Set(['1']), // the builder's own run records show it dispatched #1
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 10, maxOpenItems: 1 },
    });
    expect(r.openItems).toEqual({ count: 1, cap: 1, nums: ['1'] });
    expect(r.hold).toEqual([expect.objectContaining({ num: '2', rule: 'wip-cap' })]);
  });

  it('dedupes against inFlight: a builder item that is both currently in-flight and has an open PR from the same '
    + 'dispatch counts once, not twice, once dispatchedByBuilder is supplied', () => {
    const r = planBuildDispatch({
      candidates: [cand('99', ['we:z'])],
      inFlight: [{ num: '1', scope: ['we:a'] }],
      openPrs: [pr('we', 1, [], [], 'lane/1-x')], // same num #1 — already in-flight AND already has an open PR
      dispatchedByBuilder: new Set(['1']),
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 10, maxOpenItems: 2 },
    });
    expect(r.openItems).toEqual({ count: 1, cap: 2, nums: ['1'] });
    expect(r.dispatch.map((x) => x.num)).toEqual(['99']); // #1 counts once, so there is still room for one more
  });

  it('maxOpenPrs and the hot-file scope-overlap hold are unaffected: a worker PR excluded from maxOpenItems still '
    + 'counts toward maxOpenPrs and still blocks a scope-overlapping builder dispatch', () => {
    const manyWorkerPrs = Array.from({ length: 13 }, (_, i) => pr('we', 500 + i, [], [], `lane/${900 + i}-x`));
    const frozen = planBuildDispatch({
      candidates: [cand('1', ['we:a'])],
      openPrs: manyWorkerPrs, // 13 open PRs, none the builder's own — still trips maxOpenPrs (12)
      dispatchedByBuilder: new Set(),
      policy: BUILD_DISPATCH_POLICY,
    });
    expect(frozen.hold[0]).toEqual(expect.objectContaining({ rule: 'landing-freeze' }));

    const hotFile = planBuildDispatch({
      candidates: [cand('2', ['we:scripts/conveyor/shared.mjs'])],
      openPrs: [pr('we', 1, ['scripts/conveyor/shared.mjs'], [], 'lane/9-x')], // a worker PR touching the same file
      dispatchedByBuilder: new Set(), // excluded from maxOpenItems, but its files still block scope-vs-open-prs
      policy: { ...BUILD_DISPATCH_POLICY, maxOpenItems: 7 },
    });
    expect(hotFile.openItems).toEqual({ count: 0, cap: 7, nums: [] }); // confirms #9 is excluded from the wip-cap
    expect(hotFile.hold).toEqual([expect.objectContaining({ num: '2', rule: 'scope-vs-open-prs' })]);
  });

  it('omitting dispatchedByBuilder entirely keeps the OLD unfiltered union — every pre-existing caller/test sees no change', () => {
    const r = planBuildDispatch({
      candidates: [cand('2', ['we:b'])],
      openPrs: [pr('we', 1, [], [], 'lane/1-x')],
      policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 10, maxOpenItems: 1 },
    });
    expect(r.openItems).toEqual({ count: 1, cap: 1, nums: ['1'] });
    expect(r.hold).toEqual([expect.objectContaining({ num: '2', rule: 'wip-cap' })]);
  });
});


describe('executor concurrency caps (#4531)', () => {
  const candidate = (num, executor) => ({ ...cand(num, [`we:${num}`]), executor });
  const running = [candidate('10', 'claude'), ...['codex', 'antigravity', 'codex', 'antigravity'].map((e, i) => candidate(String(20 + i), e))];
  it('holds both classes at the default 1 Claude + 4 external boundary', () => {
    const r = planBuildDispatch({ candidates: [candidate('1', 'claude'), candidate('2', 'codex')], inFlight: running });
    expect(r.dispatch).toEqual([]);
    expect(r.hold.map(h => [h.num, h.rule])).toEqual([['1', 'cap'], ['2', 'cap']]);
  });
  it('dispatches external work while Claude is full, decrementing the shared external cap within the tick', () => {
    const r = planBuildDispatch({ candidates: [candidate('1', 'claude'), candidate('2', 'codex'), candidate('3', 'antigravity')], inFlight: running.slice(0, 4) });
    expect(r.dispatch.map(c => c.num)).toEqual(['2']);
    expect(r.hold.map(h => [h.num, h.rule])).toEqual([['1', 'cap'], ['3', 'cap']]);
  });
  it('admits Claude when the external cap is full', () => {
    const r = planBuildDispatch({ candidates: [candidate('1', 'codex'), candidate('2', 'claude')], inFlight: running.slice(1) });
    expect(r.dispatch.map(c => c.num)).toEqual(['2']);
    expect(r.hold[0]).toMatchObject({ num: '1', rule: 'cap' });
  });
  it('holds a failed route prediction rather than dispatching on a guess', () => {
    const r = planBuildDispatch({ candidates: [{ ...candidate('1', null), route: { error: 'missing item' } }] });
    expect(r.dispatch).toEqual([]);
    expect(r.hold[0]).toMatchObject({ rule: 'routing', reason: 'missing item' });
  });
  it('preserves known executors when deduping claims and run records in either order', () => {
    for (const pair of [[{ num: '20' }, running[1]], [running[1], { num: '20' }]]) {
      const r = planBuildDispatch({ candidates: [candidate('1', 'claude')], inFlight: pair });
      expect(r.busy).toBe(1);
      expect(r.inFlight[0].executor).toBe('codex');
      expect(r.dispatch.map(c => c.num)).toEqual(['1']);
    }
  });
  it('charges unknown executors to Claude and still enforces total own-item WIP across classes', () => {
    const r = planBuildDispatch({ candidates: [candidate('1', 'claude'), candidate('2', 'codex')], inFlight: [{ num: '9' }] });
    expect(r.dispatch.map(c => c.num)).toEqual(['2']);
    const full = planBuildDispatch({ candidates: [candidate('2', 'codex')], inFlight: running.slice(0, 4), policy: { ...BUILD_DISPATCH_POLICY, maxOpenItems: 4 } });
    expect(full.hold[0].rule).toBe('wip-cap');
  });
});

describe('card 80 — prepare just in time', () => {
  it('declares the two settings with safe defaults', () => {
    expect(BUILD_DISPATCH_POLICY.prepareAheadWindow).toBe(4);
    expect(BUILD_DISPATCH_POLICY.preparedMaxAgeDays).toBe(3);
  });

  it('prepareAheadNums keeps only the next N build-bound cards, pinned first', () => {
    const queue = [{ num: '1' }, { num: '2' }, { num: '3' }, { num: '4' }, { num: '5' }, { num: '6' }, { num: '7', tier: 'pinned' }];
    const launch = [{ num: '1' }];
    const held = [
      { num: '2', reason: 'blocked' }, // not build-bound — never counts
      { num: '3', reason: 'overlaps lane-19' },
      { num: '4', reason: 'needs-prepare' },
      { num: '5', reason: 'needs-prepare' },
      { num: '6', reason: 'needs-prepare' },
      { num: '7', reason: 'needs-prepare' },
    ];
    expect([...prepareAheadNums({ queue, launch, held, window: 4 })]).toEqual(['7', '1', '3', '4']);
    expect(prepareAheadNums({ queue, launch, held, window: 4 }).has('6')).toBe(false);
  });

  it('prepareAheadNums is off (null) for a non-finite or negative window', () => {
    expect(prepareAheadNums({ queue: [{ num: '1' }], window: Infinity })).toBeNull();
    expect(prepareAheadNums({ queue: [{ num: '1' }], window: -1 })).toBeNull();
  });

  it('daysBetween counts whole days and rejects malformed dates', () => {
    expect(daysBetween('2026-10-01', '2026-10-06')).toBe(5);
    expect(daysBetween('2026-10-06', '2026-10-05')).toBe(-1);
    expect(daysBetween('nope', '2026-10-05')).toBeNull();
  });

  it('stampCoversClaim: an older stamp is the one a re-prepare replaces; a same/next-day stamp is its result', () => {
    expect(stampCoversClaim('2026-10-01', '2026-10-06T15:00:00Z')).toBe(false);
    expect(stampCoversClaim('2026-10-06', '2026-10-06T15:00:00Z')).toBe(true);
    // prepare-stamp writes the LOCAL date; a 21:00 ET claim is already the next UTC day.
    expect(stampCoversClaim('2026-10-05', '2026-10-06T01:00:00Z')).toBe(true);
    expect(stampCoversClaim('2026-10-01', undefined)).toBe(true);
    expect(stampCoversClaim(null, '2026-10-06T15:00:00Z')).toBe(false);
  });

  it('stampCoversClaim: a claim that recorded its replaced stamp judges by stamp identity, not date proximity', () => {
    const claimedAt = '2026-10-06T15:00:00Z';
    const replaces = { preparedDate: '2026-10-06', preparedAgainstSha: 'aaaa1111' };
    // the SAME stamp (same-day scope-drift re-prepare, or yesterday's) is the one being replaced
    expect(stampCoversClaim('2026-10-06', claimedAt, { replaces, preparedAgainstSha: 'aaaa1111' })).toBe(false);
    expect(stampCoversClaim('2026-10-05', claimedAt, { replaces: { preparedDate: '2026-10-05' } })).toBe(false);
    // a different sha or date is a new stamp — the re-prepare's result, even if the date is unchanged
    expect(stampCoversClaim('2026-10-06', claimedAt, { replaces, preparedAgainstSha: 'bbbb2222' })).toBe(true);
    expect(stampCoversClaim('2026-10-07', claimedAt, { replaces, preparedAgainstSha: 'aaaa1111' })).toBe(true);
    // the card was unstamped at claim: any stamp is the result
    expect(stampCoversClaim('2026-10-06', claimedAt, { replaces: null })).toBe(true);
    // no stamp at all is never a result
    expect(stampCoversClaim(null, claimedAt, { replaces })).toBe(false);
  });
});

describe('collectBuildHolds — every held card names its stage and reason', () => {
  it('reports queue-cap with the projection, policy, cooldown, prepare and plan holds, in queue order', () => {
    const rows = collectBuildHolds({
      queue: [{ num: '5187' }, { num: '10' }, { num: '11' }, { num: '12' }, { num: '13' }, { num: '14' }],
      suppressed: [{ num: '5187', by: 'queue-cap', projectedMinutes: 34.5, demandMinutes: 6.5 }],
      policyHold: [{ num: '10', rule: 'hot-file', reason: 'same file as #9' }],
      cooldown: ['11'],
      prepareBusy: ['12'],
      planHeld: [{ num: '13', reason: 'overlaps lane-19' }, { num: '14', reason: 'prepare-stale', detail: 'prepared 2026-10-01, 5d ago (max 3d)' }],
    });
    expect(rows).toEqual([
      { num: '5187', stage: 'tick-core', reason: 'queue-cap', detail: 'projected heavy-test wait 34.5m (this build +6.5m)' },
      { num: '10', stage: 'daemon', reason: 'hot-file', detail: 'same file as #9' },
      { num: '11', stage: 'cooldown', reason: 'recent non-PR outcome (hold)' },
      { num: '12', stage: 'prepare', reason: 'prepare in flight' },
      { num: '13', stage: 'plan', reason: 'overlaps lane-19' },
      { num: '14', stage: 'plan', reason: 'prepare-stale', detail: 'prepared 2026-10-01, 5d ago (max 3d)' },
    ]);
  });

  it('a prepare held on queue-cap beats the plan\'s bare needs-prepare / prepare-stale row', () => {
    const rows = collectBuildHolds({
      queue: [{ num: '20' }, { num: '21' }],
      prepareQueueHeld: [{ num: '20', kind: 'prepare-item', projectedMinutes: 41, demandMinutes: 3.5 }, { num: '21', projectedMinutes: 40 }],
      planHeld: [{ num: '20', reason: 'needs-prepare' }, { num: '21', reason: 'prepare-stale', detail: 'old' }],
    });
    expect(rows).toEqual([
      { num: '20', stage: 'tick-core', reason: 'queue-cap', detail: 'prepare (prepare-item) held: projected heavy-test wait 41m (this prepare +3.5m)' },
      { num: '21', stage: 'tick-core', reason: 'queue-cap', detail: 'prepare held: projected heavy-test wait 40m (this prepare +?m)' },
    ]);
  });

  it('never lists a card that was dispatched this tick', () => {
    expect(collectBuildHolds({ policyHold: [{ num: '1', rule: 'cap', reason: 'x' }], dispatched: [{ num: '1' }] })).toEqual([]);
  });
});

// Card xu1nixv — builder freeze kind `main-red` (incident 2026-10-08: merges and builds kept landing on a red main for 6 h).
describe('main-red freeze', () => {
  const cands = [{ num: '5600', scope: ['a.mjs'] }, { num: '5601', scope: ['b.mjs'] }];
  const red = { frozen: true, reason: 'main CI red since 2026-10-08T17:04:20.000Z', exemptNums: ['5601'] };
  it('holds every new build while main is red, except an exempt main-fix card', () => {
    const plan = planBuildDispatch({ candidates: cands, policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 4 }, mainRedFreeze: red });
    expect(plan.hold).toEqual([{ num: '5600', lane: null, rule: 'main-red', reason: red.reason }]);
    expect(plan.dispatch.map((d) => d.num)).toEqual(['5601']);
    expect(plan.mainRedFreeze).toEqual({ frozen: true, reason: red.reason });
    // Kept out of the global freeze: prepares (light) and orphan resumes read `freeze.frozen`, which stays false.
    expect(plan.freeze.frozen).toBe(false);
  });
  it('off / absent = before this card: nothing held for main red', () => {
    const plan = planBuildDispatch({ candidates: cands, policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 4 }, mainRedFreeze: null });
    expect(plan.hold).toEqual([]);
    expect(plan.mainRedFreeze).toEqual({ frozen: false });
  });
});

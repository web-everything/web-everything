import { describe, it, expect } from 'vitest';
import { planLabelDrain, isPassIdle, buildOverlapRows } from '../merge-ai-prs.mjs';
import { overlapRowKey, overlapYieldWaits } from '../conveyor/land-overlap-yield.mjs';
import { embedManifestInBody } from '../readiness/lane-manifest.mjs';

// #4308 — `planLabelDrain`'s `overlapContext` is a PRECOMPUTED `Map` (built by
// `we:scripts/conveyor/land-overlap-yield.mjs#computeOverlapContext`, exercised on its own in that module's own
// test file). This suite drives `planLabelDrain` directly with a hand-built Map, mirroring the existing
// `#2188 blockedBy ordering` suite's `cand()` convention (`merge-ai-prs-ai-detection-and-drain-ordering.test.mjs`).
const cand = (num, item = null, blockedBy = [], decision = 'merge', repo = null) => ({ num, item, blockedBy, decision, repo });
const overlapWait = (num, yieldTo, repo = null, extra = {}) => new Map([[
  overlapRowKey({ repo, number: num }),
  { yieldTo, repo, files: ['we:scripts/conveyor/review-status-tag.mjs'], untilMs: 1_000, windowMinutes: 45, ...extra },
]]);

describe('planLabelDrain — #4308 overlap-yield wiring', () => {
  it('a 2821/2826-shaped fixture defers the small PR with overlap-yield:#<large>', () => {
    // #2821 (20 files, in review) never enters the CANDIDATE set (it is not ready-to-merge) — only the yield
    // relationship to it, precomputed into the Map, does.
    const { ready, deferred } = planLabelDrain([cand(2826)], { overlapContext: overlapWait(2826, 2821) });
    expect(ready).toEqual([]);
    expect(deferred).toEqual([{
      num: 2826, item: null, waitOn: ['overlap-yield:#2821'],
      overlapYield: { pr: 2821, repo: null, files: ['we:scripts/conveyor/review-status-tag.mjs'], untilMs: 1_000, windowMinutes: 45 },
      headSha: null,
    }]);
  });

  it('a dependent freed by a merge in the same pass is still checked against its OWN overlap wait', () => {
    // #2200 blockedBy #2199; #2199 is present this call (still open) so #2200 defers on BOTH the blockedBy edge
    // and its own overlap-yield — the union of causes, exactly like couple/blindWait already do.
    const octx = overlapWait(2200, 9999);
    const { deferred } = planLabelDrain([cand(2200, 2200, [2199]), cand(1, 2199, [])], { overlapContext: octx });
    const row = deferred.find((d) => d.num === 2200);
    expect(row.waitOn.sort()).toEqual([2199, 'overlap-yield:#9999'].sort());
    // Next pass: #2199 landed (removed from the candidate list) and the overlap has ALSO cleared (Y merged,
    // so a fresh computeOverlapContext would no longer find the candidate in its trial) — #2200 is now ready.
    const { ready } = planLabelDrain([cand(2200, 2200, [2199])], { overlapContext: new Map() });
    expect(ready.map((c) => c.num)).toEqual([2200]);
  });

  it('a yield combines with a couple-carrier wait — the union holds the whole couple, and heldCoupleOnly reads false (a live, pollable cause is also present)', () => {
    const c = { ...cand(50), coupleDefer: true, coupleCarrier: { num: 51 }, coupleDeferReason: 'held' };
    const { deferred } = planLabelDrain([c], { overlapContext: overlapWait(50, 60) });
    const row = deferred[0];
    expect(row.waitOn.sort()).toEqual(['couple-carrier:51', 'overlap-yield:#60'].sort());
    // 2026-09-29 review finding — `heldCoupleOnly` means "held ONLY by the couple". A defer that ALSO carries a
    // live overlap-yield cause (Y may still land, or X's own budget may still run out) is NOT idle in the
    // `--max-idle`/`heldCoupleOnly`-won't-clear-by-polling sense, so it must read false here even though the
    // couple-hold itself is present — the pass must keep polling.
    expect(row.heldCoupleOnly).toBeFalsy(); // the field is OMITTED (not `false`) when heldCoupleOnly doesn't hold
    expect(isPassIdle({ merged: 0, pendingRebased: 0, deferred })).toBe(false);
  });

  it('when Y merges mid-pass, X is released on the NEXT replan (an empty overlapContext, not a stale one)', () => {
    const first = planLabelDrain([cand(2826)], { overlapContext: overlapWait(2826, 2821) });
    expect(first.deferred.map((d) => d.num)).toEqual([2826]);
    const second = planLabelDrain([cand(2826)], { overlapContext: new Map() }); // Y landed; recomputed fresh
    expect(second.ready.map((c) => c.num)).toEqual([2826]);
  });

  it('--max-idle=1 never exits on a pass deferred ONLY by a timed overlap-yield (Idle accounting, #4308)', () => {
    const { deferred } = planLabelDrain([cand(2826)], { overlapContext: overlapWait(2826, 2821) });
    expect(isPassIdle({ merged: 0, pendingRebased: 0, deferred })).toBe(false); // keeps polling
  });

  it('overlapContext: null (every pre-#4308 caller/test) changes NOTHING', () => {
    const withNull = planLabelDrain([cand(9), cand(3), cand(7)], { overlapContext: null });
    const omitted = planLabelDrain([cand(9), cand(3), cand(7)]);
    expect(withNull).toEqual(omitted);
    expect(withNull.ready.map((c) => c.num)).toEqual([3, 7, 9]);
    expect(withNull.deferred).toEqual([]);
  });

  it('an overlapContext Map with no entry for a candidate is a plain miss — no overlapYield field at all', () => {
    const { deferred } = planLabelDrain([cand(2, 2200, [2199]), cand(1, 2199, [], 'skip')], { overlapContext: new Map() });
    expect(deferred).toEqual([{ num: 2, item: 2200, waitOn: [2199], headSha: null }]); // byte-identical to the pre-#4308 shape
  });
});

describe('buildOverlapRows — #4308 row-shape wiring (2026-09-29 review finding)', () => {
  const rawPr = (num, { baseRefName = 'main', isDraft = false, labels = [], files = [], headRefOid = null } = {}) =>
    ({ number: num, baseRefName, isDraft, labels, files, headRefOid });

  it('normalizes a null (local-repo) Map key to `localSlug` — for BOTH the row\'s own `.repo` and the matching keys', () => {
    const openPrContext = { prsByRepo: new Map([[null, [rawPr(10, { files: [{ path: 'a', additions: 5, deletions: 0 }] })]]]) };
    const verdicts = [{ num: 10, repo: null, decision: 'merge', item: null, blockedBy: [], stackParents: [], headSha: 'deadbeef' }];
    const { candidateRows, openPrRows } = buildOverlapRows({ candidates: verdicts, verdicts, openPrContext, localSlug: 'web-everything/web-everything' });
    expect(openPrRows).toHaveLength(1);
    expect(openPrRows[0].repo).toBe('web-everything/web-everything'); // NOT null — a real slug `readyToMergeLabelTimeMs` can call `gh api` against
    expect(candidateRows).toHaveLength(1);
    expect(candidateRows[0].repo).toBe('web-everything/web-everything');
    expect(candidateRows[0].headSha).toBe('deadbeef');
  });

  it('excludes a PR already merged earlier this same cascade (mergedPrKeys), keyed the SAME normalized way', () => {
    const openPrContext = { prsByRepo: new Map([[null, [rawPr(10), rawPr(11)]]]) };
    const mergedPrKeys = new Set([overlapRowKey({ repo: 'web-everything/web-everything', number: 10 })]);
    const { openPrRows } = buildOverlapRows({ candidates: [], verdicts: [], openPrContext, mergedPrKeys, localSlug: 'web-everything/web-everything' });
    expect(openPrRows.map((r) => r.number)).toEqual([11]);
  });

  it('a files array at the page cap reads filesComplete:false (rule 2 — unknown never yields)', () => {
    const bigFiles = Array.from({ length: 100 }, (_, i) => ({ path: `f${i}`, additions: 1, deletions: 0 }));
    const openPrContext = { prsByRepo: new Map([['we', [rawPr(5, { files: bigFiles })]]]) };
    const { openPrRows } = buildOverlapRows({ candidates: [], verdicts: [], openPrContext });
    expect(openPrRows[0].filesComplete).toBe(false);
  });

  it('a non-"merge" decision candidate never becomes an X row (only an actually-ready PR can yield)', () => {
    const openPrContext = { prsByRepo: new Map([['we', [rawPr(5)]]]) };
    const verdicts = [{ num: 5, repo: 'we', decision: 'skip', item: null, blockedBy: [], stackParents: [] }];
    const { candidateRows } = buildOverlapRows({ candidates: verdicts, verdicts, openPrContext });
    expect(candidateRows).toEqual([]);
  });

  // Items 1/11 (#4417) — a non-candidate Y has NO verdict, so its deps must come from its own body's manifest.
  it('derives dependsOn from the body manifest of a PR present in openPrContext but absent from verdicts', () => {
    const body = embedManifestInBody('Y body', { item: 200, blockedBy: [100], stackParents: [150] });
    const openPrContext = { prsByRepo: new Map([['we', [{ ...rawPr(20), body }]]]) };
    const { openPrRows } = buildOverlapRows({ candidates: [], verdicts: [], openPrContext });
    expect([...openPrRows[0].dependsOn].sort((a, b) => a - b)).toEqual([100, 150]);
  });

  it('unions body deps with verdict deps (verdict never replaced) and tolerates a missing/invalid manifest', () => {
    const body = embedManifestInBody('', { item: 200, blockedBy: [100] });
    const openPrContext = { prsByRepo: new Map([['we', [{ ...rawPr(20), body }, { ...rawPr(21), body: 'no manifest here' }, rawPr(22)]]]) };
    const verdicts = [{ num: 20, repo: 'we', decision: 'skip', item: 200, blockedBy: [7], stackParents: [] }];
    const { openPrRows } = buildOverlapRows({ candidates: [], verdicts, openPrContext });
    const byNum = (n) => openPrRows.find((r) => r.number === n);
    expect([...byNum(20).dependsOn].sort((a, b) => a - b)).toEqual([7, 100]);
    expect([...byNum(21).dependsOn]).toEqual([]);
    expect([...byNum(22).dependsOn]).toEqual([]);
  });

  // Item 7 (#4417) — end to end: raw listing → buildOverlapRows → overlapYieldWaits → planLabelDrain.
  it('X does not yield to a larger overlapping non-candidate Y whose body declares blockedBy X', () => {
    const NOW = Date.parse('2026-09-28T12:00:00Z');
    const big = [{ path: 'shared.mjs', additions: 100, deletions: 0 }];
    const small = [{ path: 'shared.mjs', additions: 1, deletions: 0 }];
    const yBody = embedManifestInBody('', { item: 200, blockedBy: [100] });
    const openPrContext = { prsByRepo: new Map([['we', [
      { ...rawPr(1, { files: small }) },
      { ...rawPr(2, { files: big, labels: [{ name: 'review:pending' }] }), body: yBody },
    ]]]) };
    const x = { num: 1, repo: 'we', decision: 'merge', item: 100, blockedBy: [], stackParents: [], headSha: 'abc' };
    const { candidateRows, openPrRows } = buildOverlapRows({ candidates: [x], verdicts: [x], openPrContext });
    const rows = candidateRows.map((r) => ({ ...r, readyAtMs: NOW, windowMs: 45 * 60_000 }));
    const waits = overlapYieldWaits({ candidates: rows, openPrs: openPrRows, nowMs: NOW });
    expect(waits.size).toBe(0);
    const { ready, deferred } = planLabelDrain([x], { overlapContext: waits });
    expect(ready.map((c) => c.num)).toEqual([1]);
    expect(deferred).toEqual([]);

    // Control: without the declared dependency, the SAME fixture does yield — the dependency is what frees X.
    const noDep = { prsByRepo: new Map([['we', [openPrContext.prsByRepo.get('we')[0], { ...openPrContext.prsByRepo.get('we')[1], body: '' }]]]) };
    const ctl = buildOverlapRows({ candidates: [x], verdicts: [x], openPrContext: noDep });
    const ctlWaits = overlapYieldWaits({ candidates: ctl.candidateRows.map((r) => ({ ...r, readyAtMs: NOW, windowMs: 45 * 60_000 })), openPrs: ctl.openPrRows, nowMs: NOW });
    expect(ctlWaits.get(overlapRowKey({ repo: 'we', number: 1 }))?.yieldTo).toBe(2);
  });
});

describe('overlap-yield required CI wiring', () => {
  it.each([
    [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }, true],
    [{ context: 'test', state: 'PENDING' }, false],
    [{ name: 'test', status: 'IN_PROGRESS', conclusion: null }, false],
    [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, false],
  ])('classifies required checks: %j', (check, red) => {
    const { openPrRows } = buildOverlapRows({ openPrContext: { prsByRepo: new Map([['we', [{ number: 1, statusCheckRollup: [check] }]]]) } });
    expect(openPrRows[0].requiredCheckRed).toBe(red);
  });

  it('attaches skip tokens to ready and deferred entries without changing waits or idle accounting', () => {
    const overlapSkips = new Map([['we#10', [{ token: 'overlap-yield-skipped:#20(red-ci)' }]]]);
    const x = cand(10, 100, [], 'merge', 'we');
    const ready = planLabelDrain([x], { overlapSkips }).ready[0];
    expect(ready.overlapYieldSkipped).toEqual(['overlap-yield-skipped:#20(red-ci)']);
    expect(ready.waitOn).toBeUndefined();
    const held = { ...x, coupleDefer: true, coupleCarrier: { num: 11 }, coupleDeferReason: 'held' };
    const { deferred } = planLabelDrain([held], { overlapSkips });
    expect(deferred[0].overlapYieldSkipped).toEqual(ready.overlapYieldSkipped);
    expect(deferred[0].waitOn).toEqual(['couple-carrier:11']);
    expect(isPassIdle({ merged: 0, pendingRebased: 0, deferred })).toBe(true);
  });

  it('replays #3983 held behind red #3990 on stand-down.test.mjs', () => {
    const path = 'scripts/conveyor/__tests__/stand-down.test.mjs';
    const prs = [
      { number: 3983, baseRefName: 'main', files: [{ path, additions: 289 }] },
      { number: 3990, baseRefName: 'main', files: [{ path, additions: 1110 }], labels: ['review:pending'],
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] },
    ];
    const x = cand(3983, null, [], 'merge', 'we');
    const { candidateRows, openPrRows } = buildOverlapRows({ candidates: [x], verdicts: [x], openPrContext: { prsByRepo: new Map([['we', prs]]) } });
    const skips = new Map();
    const waits = overlapYieldWaits({ candidates: candidateRows, openPrs: openPrRows, nowMs: 0, skips });
    expect(waits.size).toBe(0);
    expect(skips.get('we#3983')).toEqual([{ pr: 3990, repo: 'we', reason: 'red-ci', token: 'overlap-yield-skipped:#3990(red-ci)' }]);
    expect(planLabelDrain([x], { overlapContext: waits, overlapSkips: skips }).ready[0].overlapYieldSkipped).toEqual(['overlap-yield-skipped:#3990(red-ci)']);
  });
});

/**
 * Card xu1nixv — INCIDENT DRILL (operator-approved 2026-10-08): the acceptance test for the whole main-fix path.
 *
 * An end-to-end replay of 2026-10-08: main's CI red from 17:04Z (real main runs, fixture main-ci-red-2026-10-08.json)
 * with TWO causes — the orphan-adopt soak scenario and review-pr-io's ledger row id — whose separate fix PRs (#4522,
 * #4532) each failed CI on the OTHER cause (fixture main-red-two-causes-2026-10-08.json). It drives the real pure
 * rules and the real IO pass (every seam injected — no gh, no spawn, no live coordination files) and asserts:
 *
 *   1. the alert opens within the threshold of the first red run;
 *   2. exactly ONE owner for the red window, whatever the number of causes or fix PRs;
 *   3. ONE combined fix PR, opened READY (two fix PRs that deadlock are folded into one by ONE combine session);
 *   4. P0 class for the fix work everywhere (first in the reconcile plan / review / drain order);
 *   5. the fix PR is not held by `owed-ci-rerun`, `main-still-red` or a lane hold;
 *   6. the builder is frozen for ordinary (P3/P4) builds while main is red, and released when green;
 *   7. in the simulated timeline the fix lands within `mainCiRedLandTargetMs` of the alert.
 *
 * It imports every part of the path, so a change to any of them selects this file (import-graph test selection).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAIN_CI_RED_DEFAULTS, runsAsOf, planCombinedFix, mainRedBuildFreeze, mainRedDeliveryClass, mainFixHeldFor,
  mainRedPriorityRank,
} from '../main-ci-red-core.mjs';
import { probeAndOwnMainCi, ledgerPathIn } from '../main-ci-red-io.mjs';
import smell from '../health-smells/main-ci-red.mjs';
import { emptyHealthState, runHealthTick } from '../health-watch-core.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../health-smells-notify-list.mjs';
import { planReconcile as planReconcileCore } from '../reconcile-core.mjs';
import { planMainRedRebases } from '../main-red-recovery.mjs';
import { planBuildDispatch, BUILD_DISPATCH_POLICY } from '../build-dispatch-policy.mjs';
import { resolveDraft } from '../../pr-land.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = JSON.parse(readFileSync(join(HERE, 'fixtures', 'main-ci-red-2026-10-08.json'), 'utf8')).runs;
const TWO = JSON.parse(readFileSync(join(HERE, 'fixtures', 'main-red-two-causes-2026-10-08.json'), 'utf8'));
const MIN = 60_000;
const T = (iso) => Date.parse(iso);
const iso = (t) => new Date(t).toISOString();
const S = MAIN_CI_RED_DEFAULTS;
const TICK = 5 * MIN;
// Simulated durations, measured on 2026-10-08 (incident review §1/§3): the fix agent took 9 min to a PR, a CI run
// about 10 min; review and drain each act on their next tick when nothing holds the PR.
const SIM = { agentToPrMs: 10 * MIN, ciMs: 10 * MIN, reviewMs: TICK, drainMs: TICK };

const planReconcile = (o) => planReconcileCore({ requiredChecks: ['gate'], ...o });
const lbl = (...n) => n.map((name) => ({ name }));
const rollup = (conclusion) => [{ name: 'gate', status: 'completed', conclusion }];
const prRow = (over) => ({ state: 'OPEN', headRefOid: 'f'.repeat(40), mergeStateStatus: 'CLEAN', labels: lbl('review:pending'),
  statusCheckRollup: rollup('success'), comments: [], ...over });

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'main-red-drill-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** One health tick at `t` (real IO pass, every seam injected). */
function tick(t, { prs = [], prCi = {}, dispatched, published, states }) {
  return probeAndOwnMainCi({
    dir, now: t, config: {}, weRoot: '/we',
    readRuns: () => ({ runs: runsAsOf(RUNS, t), failing: { jobs: TWO.mainFailingJobs, tests: [] } }),
    readPrs: () => prs.filter((p) => T(p.createdAt) <= t),
    readPrCi: (p) => prCi[p.number] ?? { status: 'pending', failedJobs: [] },
    listAgents: async () => [],
    gates: async () => ({ killed: false, fixGate: { admit: true } }),
    publishPriority: (r) => published.push(r),
    publishState: (r) => states.push(r),
    dispatch: async (req) => { dispatched.push({ at: iso(t), sessionSlug: req.sessionSlug, prompt: req.prompt }); return { handle: `h${dispatched.length}` }; },
  });
}

describe('INCIDENT DRILL — 2026-10-08, main red from two causes', () => {
  it('alert in threshold, ONE owner, builder frozen, ONE ready combined fix PR, P0 and unheld, lands within target', async () => {
    const dispatched = [];
    const published = [];
    const states = [];
    let health = emptyHealthState();
    let alertAt = null;
    let notified = false;

    // ── Phase A: 16:50 → 22:45 over the real main runs. Nobody opens a PR yet (as on the day). ──
    const stateByT = new Map();
    for (let t = T('2026-10-08T16:50:00Z'); t <= T('2026-10-08T22:45:00Z'); t += TICK) {
      const n = states.length;
      const probe = await tick(t, { dispatched, published, states });
      stateByT.set(t, states.length > n ? states.at(-1) : null);
      const res = runHealthTick(health, { mainCiRuns: probe }, [smell], t, { config: {} });
      health = res.state;
      if (!alertAt && res.transitions.some((x) => x.type === 'opened')) {
        alertAt = t;
        notified = res.plan.some((p) => p.kind === 'notify' && !p.suppressed);
      }
    }
    // (1) Alert within the threshold of the first red run (pushed 17:04:20Z), one tick of slack; it notifies even in
    // shadow mode and is on the quiet-hours break-through list.
    expect(iso(alertAt)).toBe('2026-10-08T17:20:00.000Z');
    expect(alertAt - T('2026-10-08T17:04:20Z')).toBeLessThanOrEqual(S.mainCiRedThresholdMs + TICK);
    expect(notified).toBe(true);
    expect(NOTIFY_EVEN_IN_SHADOW.has('main-ci-red')).toBe(true);
    // (2) Exactly ONE owner, sent on the alert tick, for the whole red window; its brief demands ONE PR for every cause.
    expect(dispatched.map((d) => [d.at, d.sessionSlug])).toEqual([['2026-10-08T17:20:00.000Z', 'main-fix-7c731a95e']]);
    expect(dispatched[0].prompt).toMatch(/You own them all, in ONE PR/);
    expect(dispatched[0].prompt).toMatch(/soak-shard \(3\), test-shard \(2\)/);
    // (6) Builder frozen for ordinary (P3) builds from the alert on; nothing frozen before.
    const stateAt = (t) => stateByT.get(t) ?? null;
    expect(mainRedBuildFreeze(stateAt(T('2026-10-08T17:15:00Z')), { now: T('2026-10-08T17:15:00Z') }).frozen).toBe(false);
    const freeze = mainRedBuildFreeze(stateAt(alertAt), { now: alertAt });
    expect(freeze.frozen).toBe(true);
    expect(mainRedDeliveryClass({ kind: 'build' }, null, { now: alertAt })).toBe('P3');
    const builds = planBuildDispatch({ candidates: [{ num: '5600', scope: ['a.mjs'] }], policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 4 }, mainRedFreeze: freeze });
    expect(builds.dispatch).toEqual([]);
    expect(builds.hold).toEqual([expect.objectContaining({ num: '5600', rule: 'main-red' })]);
    expect(builds.freeze.frozen).toBe(false); // prepares (light) are not held
    expect(mainRedDeliveryClass({ kind: 'owner' }, null, {})).toBe('P0');

    // ── Phase B: today's failure mode — two fix PRs, each red on the OTHER cause (the deadlock). ──
    const [p4522, p4532] = TWO.fixPrs;
    const prCi = { 4522: p4522.ci, 4532: p4532.ci };
    const tB = T('2026-10-09T00:15:00Z');
    const prsB = [...TWO.fixPrs, ...TWO.cardPrs];
    const probeB = await tick(tB, { prs: prsB, prCi, dispatched, published, states });
    // Still ONE owner; ONE combine session folds #4522 into the newest fix PR #4532.
    expect(dispatched.filter((d) => d.sessionSlug.startsWith('main-fix-7c'))).toHaveLength(1);
    expect(dispatched.filter((d) => d.sessionSlug.startsWith('main-fix-combine-')).map((d) => d.sessionSlug)).toEqual(['main-fix-combine-4532']);
    expect(probeB.priority.combine.deadlock).toMatchObject({ carrier: 4532, from: [{ pr: 4522, ref: 'lane/main-red-soak' }] });
    // The next tick (same deadlock still visible) never sends a second combine session.
    await tick(tB + TICK, { prs: prsB, prCi, dispatched, published, states });
    expect(dispatched.filter((d) => d.sessionSlug.startsWith('main-fix-combine-'))).toHaveLength(1);
    expect(Object.keys(JSON.parse(readFileSync(ledgerPathIn(dir), 'utf8'))).filter((k) => !k.startsWith('_'))).toHaveLength(1);
    // (5) While combining, neither fix PR is sent a ci-heal or told owed-ci-rerun; the card PRs are never fix PRs.
    const record = published.at(-1);
    expect(record.prs).toEqual([4522, 4532]);
    for (const n of [4522, 4532]) expect(mainFixHeldFor(n, record)?.kind).toBe('main-fix-combining');
    const nowR = record.setAt;
    const mainRedWindows = [{ start: '2026-10-08T17:04:20Z', end: null }];
    const red = planReconcile({ now: nowR, agents: [], mainRedWindows, mainRedPriority: record,
      prs: [prRow({ number: 4532, headRefName: p4532.headRefName, statusCheckRollup: rollup('failure'), requiredCheckCompletedAt: '2026-10-09T00:13:07Z', aheadByOnMain: 3 })] });
    expect(red.refusals.map((r) => r.kind)).toEqual(['main-fix-combining']);
    expect(red.dispatch.filter((d) => d.kind === 'ci-heal')).toEqual([]);

    // ── Phase C: the ONE combined PR (#4532 now carries both fixes) — ready, P0, unheld, lands within target. ──
    // (3) Opened READY, never a draft — whether from the owner branch prefix or a red-main fix branch.
    expect(resolveDraft({ mode: 'park', optOut: false, ref: 'lane/main-fix-7c731a95e', title: 'fix red main @ 7c731a95e: both causes' })).toBe(false);
    expect(resolveDraft({ mode: 'park', optOut: false, ref: p4532.headRefName, title: p4532.title })).toBe(false);
    expect(resolveDraft({ mode: 'park', optOut: false, ref: 'lane/some-feature', title: 'feat: x' })).toBe(true);
    // Combined CI: green on every job main fails → no owed-elsewhere, no deadlock; #4522 was folded in and closed.
    const combinedPlan = planCombinedFix({ mainFailingJobs: TWO.mainFailingJobs, fixPrs: [{ ...p4532, ci: { status: 'green', failedJobs: [] } }] });
    expect(combinedPlan).toEqual({ owedElsewhere: [], deadlock: null });
    const tC = tB + 2 * TICK;
    const probeC = await tick(tC, { prs: [p4532, ...TWO.cardPrs], prCi: { 4532: { status: 'green', failedJobs: [] } }, dispatched, published, states });
    const recC = probeC.priority;
    expect(recC.prs).toEqual([4532]);
    expect(recC.combine).toBeUndefined();
    // (4) P0 everywhere: first in the reconcile plan (review / drain order) ahead of an older ordinary PR.
    expect(mainRedDeliveryClass({ kind: 'pr', pr: 4532 }, recC, { now: tC })).toBe('P0');
    expect(mainRedDeliveryClass({ kind: 'pr', pr: 4512 }, recC, { now: tC })).toBe('P3');
    expect([4512, 4532].sort((a, b) => mainRedPriorityRank(a, recC, { now: tC }) - mainRedPriorityRank(b, recC, { now: tC }))).toEqual([4532, 4512]);
    const order = planReconcile({ now: tC, agents: [], mainRedPriority: recC,
      prs: [prRow({ number: 4512, headRefName: 'lane/cpu-cost-admission' }), prRow({ number: 4532, headRefName: p4532.headRefName })] });
    expect(order.dispatch.map((d) => d.prNumber)[0]).toBe(4532);
    // (5) Never main-still-red in the rebase pass (an ordinary PR still is); never owed-ci-rerun in reconcile.
    const rebases = planMainRedRebases({ mainRedWindows, mainFixPrs: recC.prs,
      candidates: [{ prNumber: 4532, aheadBy: 2, failureCompletedAt: '2026-10-09T00:13:07Z' }, { prNumber: 4512, aheadBy: 2, failureCompletedAt: '2026-10-09T00:13:07Z' }] });
    expect(rebases.dispatch.map((d) => d.prNumber)).toEqual([4532]);
    expect(rebases.refusals).toEqual([expect.objectContaining({ prNumber: 4512, kind: 'main-still-red' })]);
    const kinds = planReconcile({ now: tC, agents: [], mainRedWindows, mainRedPriority: recC,
      prs: [prRow({ number: 4532, headRefName: p4532.headRefName, statusCheckRollup: rollup('failure'), requiredCheckCompletedAt: '2026-10-09T00:13:07Z', aheadByOnMain: 3 })] });
    expect(kinds.refusals.map((r) => r.kind)).not.toContain('owed-ci-rerun');
    // Lane holds: the owner and the combine session are dispatched by the health watch itself (they take their own
    // lane through `lane-pool acquire`, which grows the pool), never by the ci-heal pass whose empty free-lane list
    // refuses `no-lane` — and the fix PR is planned no ci-heal while it waits, so `no-lane` cannot hold it.
    expect(dispatched.every((d) => d.sessionSlug.startsWith('main-fix-'))).toBe(true);

    // (7) Simulated timeline on the intended path (the owner's ONE PR): alert → PR open → CI → review → drain.
    const prOpenAt = alertAt + SIM.agentToPrMs;
    const ciDoneAt = prOpenAt + SIM.ciMs; // opened ready: CI starts at once, no draft wait
    const reviewedAt = ciDoneAt + SIM.reviewMs; // P0: first in the review queue, no owed-ci-rerun wait
    const landedAt = reviewedAt + SIM.drainMs; // P0: first in the drain
    expect(S.mainCiRedLandTargetMs).toBeGreaterThan(0);
    expect(landedAt - alertAt).toBeLessThanOrEqual(S.mainCiRedLandTargetMs);
    // On the day it was still red 6 h 41 min after the first red run.
    expect(T('2026-10-08T23:45:00Z') - T('2026-10-08T17:04:20Z')).toBeGreaterThan(S.mainCiRedLandTargetMs * 10);

    // ── Main green again: the builder freeze lifts. ──
    const greenRun = { databaseId: 99, status: 'completed', conclusion: 'success', headSha: 'e'.repeat(40), createdAt: iso(tC + TICK), updatedAt: iso(tC + 3 * TICK), event: 'push' };
    const statesBefore = states.length;
    await probeAndOwnMainCi({ dir, now: tC + 4 * TICK, config: {}, weRoot: '/we', readRuns: () => ({ runs: [...RUNS, greenRun], failing: {} }),
      readPrs: () => [], readPrCi: () => ({ status: 'unknown' }), listAgents: async () => [], gates: async () => ({ killed: false }),
      publishPriority: (r) => published.push(r), publishState: (r) => states.push(r), dispatch: async () => ({}) });
    expect(states.slice(statesBefore)).toEqual([null]);
    expect(published.at(-1)).toBeNull();
  });

  it('owed elsewhere, no deadlock: a fix PR red only on a cause another GREEN fix PR fixes waits for it', () => {
    const [p4522, p4532] = TWO.fixPrs;
    const plan = planCombinedFix({ mainFailingJobs: TWO.mainFailingJobs,
      fixPrs: [{ ...p4522, ci: { status: 'green', failedJobs: [] } }, { ...p4532 }] });
    expect(plan.deadlock).toBeNull();
    expect(plan.owedElsewhere).toEqual([{ pr: 4532, jobs: ['soak-shard (3)'], waitsOn: [4522] }]);
    expect(mainFixHeldFor(4532, { combine: plan })?.kind).toBe('main-fix-owed-elsewhere');
    expect(mainFixHeldFor(4522, { combine: plan })).toBeNull();
  });

  it('a fix PR failing on a job main does NOT fail is its own failure (never owed elsewhere); unknown CI is never acted on', () => {
    const [p4522, p4532] = TWO.fixPrs;
    // #4522 fails `lint` (its own failure → ordinary ci-heal); #4532 still waits on #4522's soak fix. No deadlock.
    const own = planCombinedFix({ mainFailingJobs: TWO.mainFailingJobs, fixPrs: [{ ...p4522, ci: { status: 'red', failedJobs: ['lint'] } }, p4532] });
    expect(own.owedElsewhere.map((o) => o.pr)).toEqual([4532]);
    expect(own.deadlock).toBeNull();
    expect(planCombinedFix({ mainFailingJobs: TWO.mainFailingJobs,
      fixPrs: [{ ...p4522, ci: { status: 'unknown' } }, p4532] })).toEqual({ owedElsewhere: [], deadlock: null });
  });

  it('off value: with combining off, two deadlocked fix PRs get no combine session (before this card)', async () => {
    const dispatched = [];
    const prCi = { 4522: TWO.fixPrs[0].ci, 4532: TWO.fixPrs[1].ci };
    const out = await probeAndOwnMainCi({ dir, now: T('2026-10-09T00:15:00Z'), config: { mainCiRedCombineFixPrs: false }, weRoot: '/we',
      readRuns: () => ({ runs: RUNS, failing: { jobs: TWO.mainFailingJobs, tests: [] } }), readPrs: () => TWO.fixPrs,
      readPrCi: (p) => prCi[p.number], listAgents: async () => [], gates: async () => ({ killed: false, fixGate: { admit: true } }),
      publishPriority: () => {}, publishState: () => {}, dispatch: async (r) => { dispatched.push(r.sessionSlug); return { handle: 'h' }; } });
    expect(out.priority.combine).toBeUndefined();
    expect(dispatched.filter((s) => s.startsWith('main-fix-combine-'))).toEqual([]);
  });
});

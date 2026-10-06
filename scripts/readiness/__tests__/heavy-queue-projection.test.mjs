/**
 * @file scripts/readiness/__tests__/heavy-queue-projection.test.mjs
 * @description Card xkyw1x4 — the PURE queue-time admission rules: command-kind classification, the rolling
 *   standard time per kind, expected demand per dispatch kind, the projected-wait formula, the per-pass admission
 *   budget (several quick dispatches — the one that would push past 30 min is the one held), and the fast-lane
 *   slot rules. No fs, no clock, no env beyond plain objects.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyCommandKind, queueLaneOf, typicalMinutes, DEFAULT_STANDARD_MINUTES, TYPICAL_MIN_SAMPLES,
  classifyDispatchKind, dispatchDemandMinutes, queueBacklog, projectedWaitMinutes, createQueueBudget,
  resolvePrepareAdmission, typicalDispatchMinutes, PREPARE_DISPATCH_KINDS, resolveFastSlots, slotOrderFor, DEFAULT_QUEUE_MAX_WAIT_MINUTES, laneProjection,
} from '../heavy-queue-projection.mjs';

describe('classifyCommandKind — the gate / wrapped command line → heavy kind', () => {
  it('the verify-lane diff-driven gate (vitest related && check:standards --local) is `selected`', () => {
    expect(classifyCommandKind("npx vitest related 'a.mjs' --run --passWithNoTests && npm run check:standards -- --local --files='a.mjs'")).toBe('selected');
  });
  it('the unconditional gate and every full vitest run are `FULL`', () => {
    expect(classifyCommandKind('npm run test:unit && npm run check:standards')).toBe('FULL');
    expect(classifyCommandKind('vitest run --reporter=dot')).toBe('FULL');
    expect(classifyCommandKind('npm run test:coverage')).toBe('FULL');
  });
  it('check:standards alone is `standards`; a bare vitest related is `files`; anything else `other`', () => {
    expect(classifyCommandKind('node scripts/check-standards.mjs')).toBe('standards');
    expect(classifyCommandKind('npx vitest related x.mjs --run')).toBe('files');
    expect(classifyCommandKind('npm ci')).toBe('other');
    expect(classifyCommandKind(null)).toBe('other');
  });
  it('short kinds ride the fast lane; full suites and unknown jobs the slow lane', () => {
    expect(['selected', 'files', 'standards'].map(queueLaneOf)).toEqual(['fast', 'fast', 'fast']);
    expect(['FULL', 'other'].map(queueLaneOf)).toEqual(['slow', 'slow']);
  });
});

describe('typicalMinutes — rolling median per kind, seeded until there are enough samples', () => {
  it('uses the seeds from 2026-09-25 when nothing is recorded (selected 3m, full 18m, standards 0.25m)', () => {
    const { minutes, source } = typicalMinutes([]);
    expect(minutes).toEqual(DEFAULT_STANDARD_MINUTES);
    expect(minutes).toMatchObject({ selected: 3, FULL: 18, standards: 0.25 });
    expect(source.FULL).toEqual({ from: 'seed', samples: 0 });
  });
  it('switches a kind to the median of its real holds once it has enough samples, per kind', () => {
    const recs = [
      { kind: 'FULL', ms: 20 * 60_000 }, { kind: 'FULL', ms: 24 * 60_000 }, { kind: 'FULL', ms: 22 * 60_000 },
      { kind: 'selected', ms: 60_000 }, // one sample only — the seed still applies
    ];
    const { minutes, source } = typicalMinutes(recs);
    expect(minutes.FULL).toBe(22);
    expect(source.FULL).toEqual({ from: 'rolling', samples: 3 });
    expect(minutes.selected).toBe(DEFAULT_STANDARD_MINUTES.selected);
    expect(source.selected.samples).toBeLessThan(TYPICAL_MIN_SAMPLES);
  });
  it('looks only at the most recent window, so the standard follows a changing machine', () => {
    const old = Array.from({ length: 20 }, () => ({ kind: 'standards', ms: 60_000 }));
    const recent = Array.from({ length: 20 }, () => ({ kind: 'standards', ms: 15_000 }));
    expect(typicalMinutes([...old, ...recent]).minutes.standards).toBe(0.25);
  });
});

describe('dispatch kind → expected demand', () => {
  it('classifies dispatched sessions from their lane lease', () => {
    expect(classifyDispatchKind({ purpose: 'conveyor-fix', session: 'fix-2672' })).toBe('fix');
    expect(classifyDispatchKind({ session: 'ci-heal-2636' })).toBe('ci-heal');
    expect(classifyDispatchKind({ purpose: 'conveyor-delivery', session: 'conveyor-4077' })).toBe('build');
    expect(classifyDispatchKind({ purpose: 'review-juror' })).toBe('review');
    expect(classifyDispatchKind({ purpose: 'hermetic-host-tests', session: 'Mac:1' })).toBeNull();
  });
  it('review is exempt (0); fix and ci-heal cost one selected run + one check:standards', () => {
    expect(dispatchDemandMinutes('review')).toBe(0);
    expect(dispatchDemandMinutes('fix')).toBe(3.25);
    expect(dispatchDemandMinutes('ci-heal')).toBe(3.25);
  });
  it('a build scales with the card size (and uses the rolling standard times when given)', () => {
    expect(dispatchDemandMinutes('build', { size: 1 })).toBe(3.25);
    expect(dispatchDemandMinutes('build', { size: 3 })).toBe(6.5);
    expect(dispatchDemandMinutes('build', { size: 8 })).toBe(13);
    expect(dispatchDemandMinutes('build', { size: 40 })).toBe(16.25); // capped at 5 runs
    expect(dispatchDemandMinutes('build', {})).toBe(6.5); // no size → default size 3
    expect(dispatchDemandMinutes('fix', { standardMinutes: { selected: 5, standards: 0.5 } })).toBe(5.5);
  });
});

describe('queueBacklog + projectedWaitMinutes — (held remaining + waiting + pending + new) ÷ slots', () => {
  it('sums remaining held time (floored at 0), waiter standard times and pending demand', () => {
    const b = queueBacklog({
      held: [{ kind: 'FULL', elapsedMinutes: 8 }, { kind: 'selected', elapsedMinutes: 10 }], // 10 left, 0 left
      waiting: [{ kind: 'FULL' }, { kind: 'standards' }], // 18 + 0.25
      pending: [{ demandMinutes: 3.25 }],
    });
    expect(b).toMatchObject({ heldRemainingMinutes: 10, waitingMinutes: 18.25, pendingMinutes: 3.25, backlogMinutes: 31.5 });
    expect(projectedWaitMinutes({ backlogMinutes: b.backlogMinutes, extraMinutes: 3.5, slots: 2 })).toBe(17.5);
  });
});

describe('createQueueBudget — several dispatches in quick succession', () => {
  // cap 2: two full suites just started (18m left each) and one full suite waiting (18m) → 54 slot-minutes → 27m.
  const baseline = { slots: 2, backlogMinutes: 54, maxWaitMinutes: DEFAULT_QUEUE_MAX_WAIT_MINUTES };

  it('4 quick fix dispatches: each sees the ones before it, and the one that would push past 30m is held', () => {
    const budget = createQueueBudget(baseline);
    const verdicts = [1, 2, 3, 4].map((pr) => budget.tryAdmit('fix', { id: pr }));
    expect(verdicts.map((v) => v.projectedMinutes)).toEqual([28.63, 30.25, 30.25, 30.25]);
    expect(verdicts.map((v) => v.admit)).toEqual([true, false, false, false]);
    expect(budget.addedMinutes()).toBe(3.25);
  });

  it('with a shorter queue, the first three fit and the FOURTH is the one held', () => {
    const budget = createQueueBudget({ slots: 2, backlogMinutes: 50 });
    const verdicts = [1, 2, 3, 4].map((pr) => budget.tryAdmit('fix', { id: pr }));
    // (50 + 3.25n) / 2 → 26.63, 28.25, 29.88, 31.5
    expect(verdicts.map((v) => v.admit)).toEqual([true, true, true, false]);
    expect(verdicts[3].projectedMinutes).toBe(31.5);
  });

  it('a big build is held while a small fix after it still fits (greedy, not stop-at-first)', () => {
    const budget = createQueueBudget({ slots: 2, backlogMinutes: 50 });
    expect(budget.tryAdmit('build', { size: 8 }).admit).toBe(false); // (50+13)/2 = 31.5
    expect(budget.tryAdmit('fix').admit).toBe(true); // (50+3.25)/2 = 26.63
  });

  it('review is exempt — admitted even when the queue is already past the max', () => {
    const budget = createQueueBudget({ slots: 1, backlogMinutes: 500 });
    expect(budget.tryAdmit('review')).toMatchObject({ admit: true, exempt: true, demandMinutes: 0 });
    expect(budget.tryAdmit('fix').admit).toBe(false);
  });

  it('fails open: no baseline, a bypassed one, or a malformed one admits everything', () => {
    for (const b of [null, { bypassed: 'off', slots: 2, backlogMinutes: 999 }, { slots: 'x' }]) {
      const budget = createQueueBudget(b);
      expect(budget.active).toBe(false);
      expect(budget.tryAdmit('build', { size: 13 }).admit).toBe(true);
    }
  });

  it('extra demand already on its way (the tick\'s own fresh spawns) counts from the start', () => {
    const budget = createQueueBudget({ slots: 2, backlogMinutes: 50 }, { extraMinutes: 8 });
    expect(budget.tryAdmit('fix').projectedMinutes).toBe(30.63);
  });
});

describe('fast lane — slots ADDED ON TOP of the heavy cap (operator decision on PR #2707)', () => {
  it('one fast slot by default, independent of the cap; configurable, never negative', () => {
    expect(resolveFastSlots({})).toBe(1);
    expect(resolveFastSlots({ WE_HEAVY_ADMISSION_FAST_SLOTS: '0' })).toBe(0);
    expect(resolveFastSlots({ WE_HEAVY_ADMISSION_FAST_SLOTS: '2' })).toBe(2);
    expect(resolveFastSlots({ WE_HEAVY_ADMISSION_FAST_SLOTS: '-3' })).toBe(0);
  });
  it('a full suite uses only the heavy slots 0…cap-1; a short job tries the fast slots (after them) first, then any heavy slot', () => {
    expect(slotOrderFor('FULL', 2, 1)).toEqual([0, 1]);
    expect(slotOrderFor('other', 3, 1)).toEqual([0, 1, 2]);
    expect(slotOrderFor('selected', 2, 1)).toEqual([2, 0, 1]);
    expect(slotOrderFor('standards', 3, 1)).toEqual([3, 0, 1, 2]);
    expect(slotOrderFor('files', 1, 0)).toEqual([0]);
  });
});

describe('laneProjection — full-suite demand ÷ heavy slots, short demand ÷ (fast + free heavy slots)', () => {
  it('2 full suites running on 2 heavy slots: a short job sees only the short backlog over the 1 fast slot', () => {
    const p = laneProjection({ heavySlots: 2, fastSlots: 1, heavyBacklogMinutes: 36, shortBacklogMinutes: 6, heldHeavyCount: 2, waitingHeavyCount: 0 });
    expect(p).toEqual({ heavyWaitMinutes: 18, shortWaitMinutes: 6, shortCapacity: 1, freeHeavySlots: 0 });
  });
  it('an idle heavy slot adds to the short capacity', () => {
    expect(laneProjection({ heavySlots: 3, fastSlots: 1, shortBacklogMinutes: 12, heldHeavyCount: 1 })).toMatchObject({ shortCapacity: 3, shortWaitMinutes: 4 });
  });
  it('with no fast slot and every heavy slot spoken for, a short job waits for the heavy lane first', () => {
    expect(laneProjection({ heavySlots: 2, fastSlots: 0, heavyBacklogMinutes: 40, shortBacklogMinutes: 4, heldHeavyCount: 2 }).shortWaitMinutes).toBe(22);
  });
  it('a split baseline is admitted on the SHORT-lane wait: a long full-suite queue alone does not hold a fix', () => {
    const baseline = { heavySlots: 2, fastSlots: 1, slots: 3, heavyBacklogMinutes: 90, shortBacklogMinutes: 20, heldHeavyCount: 2, waitingHeavyCount: 3 };
    const budget = createQueueBudget(baseline);
    // short: (20 + 3.25n) / 1 → 23.25, 26.5, 29.75, 33 — the 4th quick fix is held; the 90-min heavy queue is not counted.
    expect([1, 2, 3, 4].map(() => budget.tryAdmit('fix').admit)).toEqual([true, true, true, false]);
  });
});


describe('prepare admission — operator decision 2026-10-06', () => {
  it('charges every prepare kind its seed or measured session demand; exemption is explicit', () => {
    for (const kind of PREPARE_DISPATCH_KINDS) {
      expect(dispatchDemandMinutes(kind)).toBe(DEFAULT_STANDARD_MINUTES.selected + DEFAULT_STANDARD_MINUTES.standards);
      expect(dispatchDemandMinutes(kind, { dispatchMinutes: { prepare: 7.1 } })).toBe(7.1);
      expect(dispatchDemandMinutes(kind, { prepareAdmission: 'exempt', dispatchMinutes: { prepare: 7.1 } })).toBe(0);
      for (const prepare of [null, 0, -1, NaN, Infinity, '7.1']) {
        expect(dispatchDemandMinutes(kind, { dispatchMinutes: { prepare }, standardMinutes: { selected: 4, standards: 0.5 } })).toBe(4.5);
      }
    }
    expect(dispatchDemandMinutes('review', { dispatchMinutes: { prepare: 7.1 } })).toBe(0);
  });

  it('defaults to charge and accepts only the explicit case-insensitive exempt setting', () => {
    expect(resolvePrepareAdmission({})).toBe('charge');
    for (const value of ['exempt', 'EXEMPT']) expect(resolvePrepareAdmission({ WE_QUEUE_ADMISSION_PREPARE: value })).toBe('exempt');
    for (const value of ['charge', 'off', '', ' exempt ']) expect(resolvePrepareAdmission({ WE_QUEUE_ADMISSION_PREPARE: value })).toBe('charge');
  });

  it('holds prepare-item at the max wait, and admits it only with the escape hatch', () => {
    const baseline = { slots: 2, backlogMinutes: 60, maxWaitMinutes: 30, dispatchMinutes: { prepare: 7.1 } };
    // prepare-item must join the charged prepare family, even at the queue boundary.
    expect(createQueueBudget(baseline).tryAdmit('prepare-item')).toMatchObject({ admit: false, exempt: false, demandMinutes: 7.1, projectedMinutes: 33.55 });
    expect(createQueueBudget({ ...baseline, prepareAdmission: 'exempt' }).tryAdmit('prepare-item')).toMatchObject({ admit: true, exempt: true, demandMinutes: 0 });
    expect(createQueueBudget(baseline).tryAdmit('prepare')).toMatchObject({ admit: false, exempt: false });
  });
});

describe('typicalDispatchMinutes — total heavy time per prepare session', () => {
  const records = [
    { dispatchKind: 'prepare-item', session: 'a', ms: 3 * 60_000 },
    { dispatchKind: 'prepare-scope', session: 'b', ms: 9 * 60_000 },
    { dispatchKind: 'prepare-item', session: 'a', ms: 4.1 * 60_000 },
    { dispatchKind: 'investigate', session: 'c', ms: 5 * 60_000 },
    { kind: 'FULL', ms: 99 * 60_000 }, // historical rows without dispatch identity are ignored
    { dispatchKind: 'build', session: 'd', ms: 99 * 60_000 },
  ];
  it('sums both checks of one session before taking the median across three sessions', () => {
    expect(typicalDispatchMinutes(records)).toEqual({ minutes: { prepare: 7.1 }, source: { prepare: { from: 'rolling', samples: 3 } } });
    expect(typicalDispatchMinutes(records.slice(0, 3))).toEqual({ minutes: { prepare: null }, source: { prepare: { from: 'seed', samples: 2 } } });
    expect(typicalDispatchMinutes()).toEqual({ minutes: { prepare: null }, source: { prepare: { from: 'seed', samples: 0 } } });
  });
  it('windows sessions by first appearance, even when an earlier session finishes later', () => {
    expect(typicalDispatchMinutes(records, { window: 2, minSamples: 2 })).toEqual({ minutes: { prepare: 7 }, source: { prepare: { from: 'rolling', samples: 2 } } });
  });
  it('falls back to repo and lease acquisition, then record time, when session is absent', () => {
    const rows = [
      { repo: '/lane-1', leaseAcquiredAt: 'a', at: '1', session: '', ms: 60_000 },
      { repo: '/lane-1', leaseAcquiredAt: 'a', at: '2', ms: 2 * 60_000 },
      { repo: '/lane-2', leaseAcquiredAt: 'a', ms: 4 * 60_000 },
      { repo: '/lane-1', at: '3', ms: 5 * 60_000 },
    ].map((r) => ({ ...r, dispatchKind: 'prepare-decision' }));
    expect(typicalDispatchMinutes(rows)).toEqual({ minutes: { prepare: 4 }, source: { prepare: { from: 'rolling', samples: 3 } } });
  });
});

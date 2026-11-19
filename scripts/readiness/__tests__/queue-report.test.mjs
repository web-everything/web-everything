/**
 * @file scripts/readiness/__tests__/queue-report.test.mjs
 * @description Unit proof of queue-report.mjs's PURE core (WE #x85oow9). Drives {@link classifyHeld} and
 *   {@link buildQueueReport} directly with plain objects (NO git/network/child_process) and pins:
 *     - every token in dispatch-plan.mjs's HELD_REASONS classifies into exactly one bucket;
 *     - an unrecognized held reason THROWS rather than silently landing in a bucket (#x85oow9's whole point —
 *       a new held reason must be classified explicitly, never guessed);
 *     - the composer shapes active/queuedWaitingTurn/notReady/staleNoise correctly, including title lookup and
 *       the unprepared-decision-only filter on `active.preparing`.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyHeld, buildQueueReport, QUEUE_REPORT_BUCKETS, NOT_READY_REASONS, STALE_NOISE_REASONS,
} from '../queue-report.mjs';
import { HELD_REASONS } from '../dispatch-plan.mjs';

describe('classifyHeld — covers every dispatch-plan.mjs HELD_REASONS token', () => {
  it('classifies every concrete (non-templated) HELD_REASONS token into exactly one bucket', () => {
    for (const reason of HELD_REASONS) {
      if (reason === 'overlaps lane-<n>') continue; // templated — covered by the concrete-lane-id case below
      const bucket = classifyHeld(reason);
      expect(QUEUE_REPORT_BUCKETS).toContain(bucket);
    }
  });

  it('"overlaps lane-<n>" (a concrete lane id), "no free lane", and "capacity-cap" are queued-waiting-turn', () => {
    expect(classifyHeld('overlaps lane-7')).toBe('queued-waiting-turn');
    expect(classifyHeld('overlaps lane-42')).toBe('queued-waiting-turn');
    expect(classifyHeld('no free lane')).toBe('queued-waiting-turn');
    // #xupukxa — a free lane exists but the concurrent-lane cap withheld it; same "nothing to do but wait"
    // bucket as `no free lane`, not `not-ready` (regression pin: an earlier bug checked only index 0 of the
    // exact-match list, so a second entry silently fell through to the catch-all throw).
    expect(classifyHeld('capacity-cap')).toBe('queued-waiting-turn');
    // #3609 — the manual dispatch-pause lever: the item itself is fully ready, only a deliberate operator
    // kill-switch is withholding it, so it belongs in the same "nothing to do but wait" bucket.
    expect(classifyHeld('dispatch-paused')).toBe('queued-waiting-turn');
  });

  it('runtime-only is queued-waiting-turn while the operator list withholds the item', () => {
    expect(classifyHeld('runtime-only')).toBe('queued-waiting-turn');
  });

  it('every NOT_READY_REASONS token is not-ready', () => {
    for (const r of NOT_READY_REASONS) expect(classifyHeld(r)).toBe('not-ready');
  });

  it('every STALE_NOISE_REASONS token is stale-noise', () => {
    for (const r of STALE_NOISE_REASONS) expect(classifyHeld(r)).toBe('stale-noise');
  });

  it('throws on an unrecognized reason rather than silently defaulting a bucket', () => {
    expect(() => classifyHeld('some-future-hold-nobody-taught-me')).toThrow(/unrecognized held reason/);
  });

  it('throws on a null/undefined reason rather than silently defaulting a bucket', () => {
    expect(() => classifyHeld(undefined)).toThrow(/unrecognized held reason/);
    expect(() => classifyHeld(null)).toThrow(/unrecognized held reason/);
  });
});

describe('buildQueueReport — pure composer', () => {
  const byNum = new Map([
    ['1', { title: 'Alpha' }],
    ['2', { title: 'Beta' }],
    ['3', { title: 'Gamma' }],
  ]);

  it('sorts held entries into the right bucket, with title lookup', () => {
    const report = buildQueueReport({
      held: [
        { num: 1, reason: 'overlaps lane-4' },
        { num: 2, reason: 'blocked' },
        { num: 3, reason: 'already-done' },
      ],
      byNum,
    });
    expect(report.queuedWaitingTurn).toEqual([{ num: 1, title: 'Alpha', reason: 'overlaps lane-4' }]);
    expect(report.notReady).toEqual({ count: 1, items: [{ num: 2, title: 'Beta', reason: 'blocked' }] });
    expect(report.staleNoise).toEqual({ count: 1, items: [{ num: 3, title: 'Gamma', reason: 'already-done' }] });
  });

  it('a num with no title entry reports title:null rather than throwing', () => {
    const report = buildQueueReport({ held: [{ num: 99, reason: 'blocked' }], byNum });
    expect(report.notReady.items).toEqual([{ num: 99, title: null, reason: 'blocked' }]);
  });

  it('propagates an unrecognized held reason as a thrown error (never silently dropped)', () => {
    expect(() => buildQueueReport({ held: [{ num: 1, reason: 'mystery' }], byNum })).toThrow(/unrecognized held reason/);
  });

  it('active.building lists every leased lane with a num, carrying its title + lane', () => {
    const report = buildQueueReport({
      lanes: [{ lane: 7, num: 1 }, { lane: 9, num: null }, { lane: 12, num: 2 }],
      byNum,
    });
    expect(report.active.building).toEqual([
      { num: 1, title: 'Alpha', lane: 7 },
      { num: 2, title: 'Beta', lane: 12 },
    ]);
  });

  it('active.preparing folds unshaped + needsSlice + ONLY-unprepared decisions, each tagged with its reason', () => {
    const report = buildQueueReport({
      unshaped: [{ num: 1 }],
      needsSlice: [{ num: 2 }],
      decisions: [{ num: 3, prepared: false }, { num: 4, prepared: true }],
      byNum: new Map([...byNum, ['4', { title: 'Delta' }]]),
    });
    expect(report.active.preparing).toEqual([
      { num: 1, title: 'Alpha', reason: 'unshaped-no-scope' },
      { num: 2, title: 'Beta', reason: 'needs-slice' },
      { num: 3, title: 'Gamma', reason: 'needs-decision' },
    ]);
  });

  it('active.fixing and active.healing are always null — never a fabricated count', () => {
    const report = buildQueueReport({});
    expect(report.active.fixing).toBeNull();
    expect(report.active.healing).toBeNull();
  });

  it('an empty input reports empty buckets throughout, never throwing', () => {
    const report = buildQueueReport({});
    expect(report).toEqual({
      active: { building: [], preparing: [], fixing: null, healing: null },
      queuedWaitingTurn: [],
      notReady: { count: 0, items: [] },
      staleNoise: { count: 0, items: [] },
    });
  });
});

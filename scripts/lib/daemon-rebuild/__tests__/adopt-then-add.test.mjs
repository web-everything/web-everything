/** @file adopt-then-add.test.mjs — a smoke-passed candidate is adopted when the overlay set moved for a benign reason.
 * Fixtures from the review daemon's two discards on 2026-11-18 (17:28 and 18:06 ET). */
import { describe, expect, it } from 'vitest';
import { matchReadyCandidate, classifyOverlayRemoval } from '../adopt.mjs';

const SHA = (c) => c.repeat(40);
const seat = 'lane/review-seat-fairness-m1';
const ready = () => ({
  kind: 'candidate', prevHead: 'live', passedAt: '2026-11-18T22:28:00Z', tree: 'ready-tree',
  adopt: { finalSha: SHA('f'), inputsKey: 'k', applied: [{ ref: 'lane/a', sha: SHA('a') }] },
});
const args = (o = {}) => ({
  ready: ready(), plan: { finalSha: SHA('e'), inputsKey: 'k2', mainSha: SHA('1'), alerts: [] }, prevHead: 'live',
  treeOf: () => 'plan-tree', stillWanted: () => true, verifyBuilt: () => true, liveApplied: [],
  nowMs: Date.parse('2026-11-18T22:50:00Z'), maxAgeMs: 3_600_000, ...o,
});
const gone = { stillWanted: (r) => r !== 'lane/a', registered: (r) => r !== 'lane/a' };

describe('overlay-no-longer-wanted (17:28 ET discard)', () => {
  it('adopts when the applied overlay left for a benign reason, and queues the rebuild', () => {
    const m = matchReadyCandidate(args({ ...gone, removalSafety: () => 'benign' }));
    expect(m.adopt).toBeTruthy();
    expect(m.rebuildAfter).toEqual(['lane/a']);
  });
  it.each(['unsafe', 'unknown'])('still discards when the removal is %s', (kind) => {
    expect(matchReadyCandidate(args({ ...gone, removalSafety: () => kind })))
      .toMatchObject({ adopt: null, reason: 'overlay-no-longer-wanted' });
  });
  it('still discards when no removal evidence is supplied (fail closed)', () => {
    expect(matchReadyCandidate(args(gone))).toMatchObject({ adopt: null, reason: 'overlay-no-longer-wanted' });
  });
  it('does not adopt when a still-registered overlay moved to a different tip', () => {
    const m = matchReadyCandidate(args({ stillWanted: (r) => r !== 'lane/a', registered: () => true, removalSafety: () => 'benign' }));
    expect(m.adopt).toBeNull();
  });
});

describe(`superseded-omits-live-overlay: ${seat} (18:06 ET discard)`, () => {
  const omit = { liveApplied: [{ ref: seat, sha: SHA('b') }], carries: () => false };
  it('adopts then re-adds a still-registered omitted overlay', () => {
    const m = matchReadyCandidate(args({ ...omit, readdable: (r) => r === seat }));
    expect(m.adopt).toBeTruthy();
    expect(m.rebuildAfter).toEqual([seat]);
  });
  it('refuses when the overlay is not registered any more', () => {
    expect(matchReadyCandidate(args(omit))).toMatchObject({ adopt: null, reason: `superseded-omits-live-overlay: ${seat}` });
  });
  it('refuses when a carried overlay declares it a dependency', () => {
    const m = matchReadyCandidate(args({ ...omit, readdable: () => true, dependsOn: (r) => (r === 'lane/a' ? [seat] : []) }));
    expect(m).toMatchObject({ adopt: null, omitted: [seat] });
  });
});

describe('classifyOverlayRemoval', () => {
  const ev = (kind, reason) => [{ kind: 'added', ref: 'lane/a' }, { kind, ref: 'lane/a', reason }];
  it('same-tick decisions: merged is benign, closed or gone is unsafe', () => {
    expect(classifyOverlayRemoval({ ref: 'lane/a', decisions: [{ ref: 'lane/a', action: 'remove', reason: 'pr-merged' }] })).toBe('benign');
    expect(classifyOverlayRemoval({ ref: 'lane/a', decisions: [{ ref: 'lane/a', action: 'remove', reason: 'pr-closed' }] })).toBe('unsafe');
    expect(classifyOverlayRemoval({ ref: 'lane/a', decisions: [{ ref: 'lane/a', action: 'remove', reason: 'ref-gone' }] })).toBe('unsafe');
  });
  it('audit trail reasons', () => {
    expect(classifyOverlayRemoval({ ref: 'lane/a', events: ev('removed', 'PR merged; no longer wanted') })).toBe('benign');
    expect(classifyOverlayRemoval({ ref: 'lane/a', events: ev('auto-dropped', 'pr-merged') })).toBe('benign');
    expect(classifyOverlayRemoval({ ref: 'lane/a', events: ev('removed', 'smoke failed, rolled back') })).toBe('unsafe');
    expect(classifyOverlayRemoval({ ref: 'lane/a', events: ev('removed', 'security unload') })).toBe('unsafe');
    expect(classifyOverlayRemoval({ ref: 'lane/a', events: ev('removed', 'because') })).toBe('unknown');
    expect(classifyOverlayRemoval({ ref: 'lane/a', events: ev('removed', '') })).toBe('unknown');
  });
  it('missing or unreadable trail is unknown', () => {
    expect(classifyOverlayRemoval({ ref: 'lane/a' })).toBe('unknown');
    expect(classifyOverlayRemoval({ ref: 'lane/a', events: [] })).toBe('unknown');
  });
});

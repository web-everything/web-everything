/** @file adopt-then-add.test.mjs — a smoke-passed candidate is adopted when the overlay set moved for a benign reason.
 * Fixtures from the review daemon's two discards on 2026-11-18 (17:28 and 18:06 ET). */
import { describe, expect, it } from 'vitest';
import { matchReadyCandidate, classifyOverlayRemoval } from '../adopt.mjs';
import { OPERATOR_LOGINS } from '../../marker-authorship.mjs';

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
    const m = matchReadyCandidate(args({ ...omit, readdable: (r) => r === seat, dependsOn: () => [] }));
    expect(m.adopt).toBeTruthy();
    expect(m.rebuildAfter).toEqual([seat]);
  });
  it('refuses when a carried overlay has no recorded dependency declaration (unknown, not none)', () => {
    expect(matchReadyCandidate(args({ ...omit, readdable: () => true }))).toMatchObject({ adopt: null, omitted: [seat] });
    expect(matchReadyCandidate(args({ ...omit, readdable: () => true, dependsOn: () => null }))).toMatchObject({ adopt: null });
  });
  it('refuses when the overlay is not registered any more', () => {
    expect(matchReadyCandidate(args(omit))).toMatchObject({ adopt: null, reason: `superseded-omits-live-overlay: ${seat}` });
  });
  it('refuses when a carried overlay declares it a dependency', () => {
    const m = matchReadyCandidate(args({ ...omit, readdable: () => true, dependsOn: (r) => (r === 'lane/a' ? [seat] : []) }));
    expect(m).toMatchObject({ adopt: null, omitted: [seat] });
  });
});

describe('addOverlay dependsOn', () => {
  it('stores a declared list, defaults a new registration to [], and leaves a legacy entry undeclared', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { addOverlay, readOverlays } = await import('../../daemon-overlays.mjs');
    const root = mkdtempSync(join(tmpdir(), 'overlay-deps-'));
    const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    try {
      addOverlay(root, { ref: 'lane/x', dependsOn: ['lane/y', 'bad ref!', 'lane/y'] }, { env });
      addOverlay(root, { ref: 'lane/z' }, { env });
      const list = readOverlays(root, { env });
      expect(list.find((o) => o.ref === 'lane/x').dependsOn).toEqual(['lane/y']);
      expect(list.find((o) => o.ref === 'lane/z').dependsOn).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('classifyOverlayRemoval hardening', () => {
  const tip = SHA('a');
  const added = { kind: 'added', ref: 'lane/a', at: '2026-11-18T20:00:00Z' };
  const gone = (e) => ({ kind: 'removed', ref: 'lane/a', reason: 'no longer wanted', tip, at: '2026-11-18T21:00:00Z', ...e });
  const classify = (events, extra = {}) => classifyOverlayRemoval({ ref: 'lane/a', sha: tip, events, ...extra });
  it('a manual removed event is benign only with an authenticated actor and recorded source', () => {
    expect(classify([added, gone()])).toBe('unknown');
    expect(classify([added, gone({ actor: 'someone-else', source: 'removeRegistration' })])).toBe('unknown');
    expect(classify([added, gone({ actor: OPERATOR_LOGINS[0], source: 'removeRegistration' })])).toBe('benign');
    expect(classify([added, gone({ actor: OPERATOR_LOGINS[0] })])).toBe('unknown');
  });
  it('a merge drop needs evidence bound to the applied sha', () => {
    const drop = { kind: 'auto-dropped', ref: 'lane/a', reason: 'pr-merged', tip, at: '2026-11-18T21:00:00Z' };
    expect(classify([added, drop], { inMain: () => true })).toBe('benign');
    expect(classify([added, { ...drop, tip: undefined }], { inMain: () => true })).toBe('unknown');
    expect(classify([added, { ...drop, tip: SHA('9') }], { inMain: () => true })).toBe('unknown');
    expect(classify([added, drop], { inMain: () => false })).toBe('unknown');
    const merged = [{ ref: 'lane/a', action: 'remove', reason: 'pr-merged' }];
    expect(classify([], { decisions: merged, inMain: () => true })).toBe('benign');
    expect(classify([], { decisions: merged })).toBe('unknown');
  });
  it('needs a recorded add with a valid timestamp strictly earlier than the removal', () => {
    const op = { actor: OPERATOR_LOGINS[0], source: 'removeRegistration' };
    expect(classify([gone(op)])).toBe('unknown'); // no add recorded
    expect(classify([{ ...added, at: 'garbage' }, gone(op)])).toBe('unknown');
    expect(classify([{ ...added, at: '2026-11-18T21:00:00Z' }, gone(op)])).toBe('unknown'); // equal
    expect(classify([{ ...added, at: undefined }, gone(op)])).toBe('unknown');
  });
});

describe('classifyOverlayRemoval', () => {
  const tip = SHA('a');
  const ev = (kind, reason, extra = {}) => [
    { kind: 'added', ref: 'lane/a', at: '2026-11-18T20:00:00Z' },
    { kind, ref: 'lane/a', reason, tip, at: '2026-11-18T21:00:00Z', ...extra },
  ];
  const classify = (events) => classifyOverlayRemoval({ ref: 'lane/a', sha: tip, events });
  it('same-tick decisions: merged is benign, closed or gone is unsafe', () => {
    expect(classifyOverlayRemoval({ ref: 'lane/a', sha: tip, inMain: () => true, decisions: [{ ref: 'lane/a', action: 'remove', reason: 'pr-merged' }] })).toBe('benign');
    expect(classifyOverlayRemoval({ ref: 'lane/a', decisions: [{ ref: 'lane/a', action: 'remove', reason: 'pr-closed' }] })).toBe('unsafe');
    expect(classifyOverlayRemoval({ ref: 'lane/a', decisions: [{ ref: 'lane/a', action: 'remove', reason: 'ref-gone' }] })).toBe('unsafe');
  });
  it('audit trail reasons', () => {
    expect(classify(ev('removed', 'no longer wanted'))).toBe('unknown'); // unauthenticated manual removal
    expect(classify(ev('auto-retired', 'no longer wanted', { actor: OPERATOR_LOGINS[0] }))).toBe('benign');
    expect(classify(ev('auto-dropped', 'pr-merged', { tip: undefined }))).toBe('unknown');
    expect(classify(ev('removed', 'smoke failed, rolled back'))).toBe('unsafe');
    expect(classify(ev('removed', 'security unload'))).toBe('unsafe');
    expect(classify(ev('removed', 'not merged'))).toBe('unsafe');
    expect(classify(ev('removed', 'because'))).toBe('unknown');
    expect(classify(ev('removed', 'retired after the long review of everything'))).toBe('unknown');
    expect(classify(ev('removed', ''))).toBe('unknown');
  });
  it('requires evidence about this tip, in time order, and an authenticated retirement actor', () => {
    expect(classify(ev('removed', 'retired', { tip: SHA('9') }))).toBe('unknown');
    expect(classify(ev('removed', 'retired', { at: '2026-11-18T19:00:00Z' }))).toBe('unknown');
    expect(classify(ev('auto-retired', 'retired', { actor: 'someone-else' }))).toBe('unknown');
    expect(classifyOverlayRemoval({ ref: 'lane/a', events: ev('removed', 'retired') })).toBe('unknown'); // no tip supplied
  });
  it('missing or unreadable trail is unknown', () => {
    expect(classifyOverlayRemoval({ ref: 'lane/a', sha: tip })).toBe('unknown');
    expect(classify([])).toBe('unknown');
  });
});

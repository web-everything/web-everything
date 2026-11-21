/** @file adopt-then-add.test.mjs — a smoke-passed candidate is adopted when the overlay set moved for a benign reason.
 * Fixtures from the review daemon's benign-removal discard on 2026-11-18 (17:28 ET). */
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

it('never adopts a candidate that omits a still-registered live overlay', () => {
  const m = matchReadyCandidate(args({
    liveApplied: [{ ref: seat, sha: SHA('b') }], carries: () => false,
    auditedTip: null, readdable: () => true, dependsOn: () => [],
  }));
  expect(m).toMatchObject({ adopt: null, reason: `superseded-omits-live-overlay: ${seat}` });
});

const removalCases = ['fallback', 'exact', 'superseded'].flatMap((kind) =>
  ['benign', 'unsafe', 'unknown', 'sha-less'].map((removal) => ({ kind, removal })));
it.each(removalCases)('$kind adoption with $removal removal', ({ kind, removal }) => {
  const candidate = ready();
  const plan = { ...args().plan };
  if (kind === 'fallback') {
    candidate.kind = 'fallback';
    candidate.forInputsKey = plan.inputsKey;
  }
  if (kind === 'exact') plan.finalSha = candidate.adopt.finalSha;
  if (removal === 'sha-less') delete candidate.adopt.applied[0].sha;
  const m = matchReadyCandidate(args({ ready: candidate, plan, ...gone,
    removalSafety: () => removal === 'sha-less' ? 'benign' : removal }));
  if (removal === 'benign') {
    expect(m).toMatchObject({ adopt: candidate.adopt, match: kind, rebuildAfter: ['lane/a'] });
  } else expect(m).toMatchObject({ adopt: null, reason: 'overlay-no-longer-wanted' });
});

describe('classifyOverlayRemoval hardening', () => {
  const tip = SHA('a');
  const added = { kind: 'added', ref: 'lane/a', at: '2026-11-18T20:00:00Z' };
  const gone = (e) => ({ kind: 'removed', ref: 'lane/a', reason: 'no longer wanted', tip, at: '2026-11-18T21:00:00Z', ...e });
  const classify = (events, extra = {}) => classifyOverlayRemoval({ ref: 'lane/a', sha: tip, events, ...extra });
  it('authenticated manual removal rejects a different applied tip', () => {
    const op = { actor: OPERATOR_LOGINS[0], source: 'removeRegistration' };
    expect(classify([added, gone(op)])).toBe('benign');
    expect(classify([added, gone({ ...op, tip: SHA('9') })])).toBe('unknown');
  });
  it.each(['operator', 'outsider', 'unreadable'])('classifies the real removeRegistration writer with %s credentials', async (identity) => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { addOverlay, appendOverlayEvent } = await import('../../daemon-overlays.mjs');
    const { removeRegistration } = await import('../../../daemon-overlay.mjs');
    const { readOverlayEventLog } = await import('../prepare.mjs');
    const root = mkdtempSync(join(tmpdir(), 'removal-contract-'));
    const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    try {
      addOverlay(root, { ref: 'lane/a' }, { env });
      appendOverlayEvent(root, added, { env });
      expect(removeRegistration({ root, ref: 'lane/a', by: OPERATOR_LOGINS[0], actor: OPERATOR_LOGINS[0], reason: 'no longer wanted', env,
        deps: { tip: () => tip, viewerLogin: () => {
          if (identity === 'unreadable') throw new Error('unavailable');
          return identity === 'operator' ? OPERATOR_LOGINS[0].toUpperCase() : 'outsider';
        } } }).removed).toBe(true);
      expect(classify(readOverlayEventLog(root, env))).toBe(identity === 'operator' ? 'benign' : 'unknown');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('classifies the real authenticated auto-retire writer and rejects a different tip', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { addOverlay, appendOverlayEvent } = await import('../../daemon-overlays.mjs');
    const { retireRegistration } = await import('../../../daemon-overlay.mjs');
    const { readOverlayEventLog } = await import('../prepare.mjs');
    const root = mkdtempSync(join(tmpdir(), 'retire-contract-'));
    const env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    try {
      addOverlay(root, { ref: 'lane/a' }, { env });
      appendOverlayEvent(root, added, { env });
      expect(await retireRegistration({ root, ref: 'lane/a', expectedTip: tip, actor: OPERATOR_LOGINS[0], env,
        deps: { tip: () => tip, prove: () => ({ action: 'retire', tip, reason: 'retired' }) } })).toMatchObject({ retired: true });
      const events = readOverlayEventLog(root, env);
      expect(classify(events)).toBe('benign');
      expect(classifyOverlayRemoval({ ref: 'lane/a', sha: SHA('9'), events })).toBe('unknown');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
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

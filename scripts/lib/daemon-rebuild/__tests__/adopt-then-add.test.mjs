/** Ready-candidate refusal and registered-overlay identity controls. */
import { expect, it } from 'vitest';
import { matchReadyCandidate } from '../adopt.mjs';

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

it('refuses a ready candidate that carries an overlay removed from the registry (no benign-removal adoption)', () => {
  expect(matchReadyCandidate(args(gone)))
    .toMatchObject({ adopt: null, reason: 'overlay-no-longer-wanted' });
});

it.each(['fallback', 'exact', 'same-tree', 'superseded'])('refuses removed overlays on the %s path', (kind) => {
  const candidate = ready();
  const plan = { ...args().plan };
  if (kind === 'fallback') {
    candidate.kind = 'fallback';
    candidate.forInputsKey = plan.inputsKey;
  }
  if (kind === 'exact') plan.finalSha = candidate.adopt.finalSha;
  expect(matchReadyCandidate(args({ ...gone, ready: candidate, plan,
    treeOf: () => kind === 'same-tree' ? candidate.tree : 'plan-tree' })))
    .toMatchObject({ adopt: null, reason: 'overlay-no-longer-wanted' });
});

it('never adopts a candidate that omits a still-registered live overlay', () => {
  const m = matchReadyCandidate(args({
    liveApplied: [{ ref: seat, sha: SHA('b') }], carries: () => false,
    auditedTip: null, readdable: () => true, dependsOn: () => [],
  }));
  expect(m).toMatchObject({ adopt: null, reason: `superseded-omits-live-overlay: ${seat}` });
});

it('preserves a registered overlay audit identity even when ancestry contains its tip', () => {
  const options = args({ liveApplied: [{ ref: seat, sha: SHA('b') }],
    carries: () => true, registered: () => true, auditedTip: () => true });
  expect(matchReadyCandidate(options)).toMatchObject({ adopt: null,
    reason: `superseded-omits-live-overlay: ${seat}`, omitted: [seat] });
  expect(matchReadyCandidate({ ...options, auditedTip: null }).match).toBe('superseded');
  expect(matchReadyCandidate({ ...options, registered: () => false }).match).toBe('superseded');
});

// @vitest-environment node
/** Pure batch publication, membership bodies, and terminal failure plans. */
import { expect, it } from 'vitest';
import { planPublish, planSeal, renderBatchBody } from '../card-batch-seal.mjs';
import { planAdmit } from '../card-batch.mjs';
import { loadCardBatchPolicy } from '../../lib/card-batch-policy.mjs';
const policy = loadCardBatchPolicy({ prevention: { maxCards: 2, maxAgeMinutes: 1 } });
const state = { batchRef: 'lane/card-batch-prevention-1', seq: 1, openedAt: 0,
  members: [{ cardId: 'x123456', source: { repo: 'org/repo', pr: 42 } }] };
it('opens then refreshes; count wins and age expires at its boundary', () => {
  const plan = (s, now = 0) => planPublish({ state: s, kind: 'prevention', policy, now });
  expect(plan(state)).toEqual({ action: 'open-draft', reason: null });
  expect(plan({ ...state, pr: 1 })).toEqual({ action: 'refresh-body', reason: null });
  expect(plan(state, 60000).reason).toBe('age');
  expect(plan({ ...state, members: [...state.members, ...state.members] }, 60000).reason).toBe('count');
});
it('renders membership without resolving the implementation slice', () => {
  expect(renderBatchBody(state)).toContain('x123456 — org/repo#42');
  expect(renderBatchBody(state)).not.toContain('Resolves');
});
it('records before verifying and never promotes a red seal', () => {
  expect(planSeal({ state, reason: 'count' }).steps).toEqual(['record-sealed', 'verify', 'remove-hold', 'ready', 'label-on-green']);
  expect(planSeal({ state: { ...state, sealFailure: { reason: 'red' } } })).toEqual({ action: 'held', reason: 'red', steps: [] });
});
it('the successor admission uses the saved sequence after retiring the terminal slot', () => {
  expect(planAdmit({ state: { seq: state.seq }, input: { kind: 'prevention', cardPath: 'backlog/123-card.md' },
    policy, now: 0, owner: 'a' })).toMatchObject({ batchRef: 'lane/card-batch-prevention-2' });
});

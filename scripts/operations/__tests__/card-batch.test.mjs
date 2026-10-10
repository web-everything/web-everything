// @vitest-environment node
/** Pure planner contract: policy, leases, immutable membership and remote-history recovery. */
import { describe, expect, it } from 'vitest';
import { loadCardBatchPolicy } from '../../lib/card-batch-policy.mjs';
import { mergeMembers, planAdmit, planReconcile } from '../card-batch.mjs';

const policy = loadCardBatchPolicy();
const now = Date.parse('2026-10-06T12:00:00Z');
const input = { kind: 'prevention', cardPath: 'backlog/5192-card.md', idemKey: 'one' };
const member = { cardId: '5192', idemKey: 'one', commitSha: 'h1', source: { repo: 'org/repo' }, admittedAt: now };
const state = { batchRef: 'lane/card-batch-prevention-7', seq: 7, headSha: 'h1', openedAt: now,
  lease: { owner: 'alice', expiresAt: now + 1000 }, members: [member] };
const plan = (overrides = {}) => planAdmit({ state: null, input, policy, now, owner: 'alice', ...overrides });

describe('card batch planner', () => {
  it('allocates monotonically and retains an open ref', () => {
    expect(plan()).toEqual({ action: 'admit', seq: 1, batchRef: 'lane/card-batch-prevention-1' });
    expect(plan({ state: { seq: 7 } })).toMatchObject({ seq: 8, batchRef: 'lane/card-batch-prevention-8' });
    expect(plan({ state, input: { ...input, idemKey: 'two' } })).toMatchObject({ action: 'admit', seq: 7, batchRef: state.batchRef });
  });
  it.each([
    ['unknown-kind', { input: { ...input, kind: 'bogus' } }],
    ['invalid-policy', { policy: {} }],
    ['invalid-policy', { policy: { ...policy, mystery: {} } }],
    ['kind-disabled', { input: { ...input, kind: 'prepare' } }],
    ['ineligible-change', { input: { ...input, cardPath: 'src/code.mjs' } }],
    ['ineligible-change', { input: { ...input, cardPath: 'backlog/sub/5192-card.md' } }],
    ['lease-held', { state, owner: 'bob' }],
    ['head-mismatch', { state, input: { ...input, remoteHead: 'foreign' } }],
    ['head-mismatch', { state, input: { ...input, remoteHead: null } }],
    ['batch-sealed', { state: { ...state, sealedAt: now }, input: { ...input, idemKey: 'two' } }],
  ])('refuses %s without mutation', (reason, overrides) => {
    const before = JSON.stringify(overrides);
    expect(plan(overrides)).toEqual({ action: 'refuse', reason });
    expect(JSON.stringify(overrides)).toBe(before);
  });
  it('takes over an expired lease, including exact expiry', () => {
    expect(plan({ state, now: now + 1000, owner: 'bob' })).toMatchObject({ action: 'dedupe', member });
  });
  it('dedupes with the original object, including sealed batches', () => {
    expect(plan({ state }).member).toBe(member);
    expect(plan({ state: { ...state, sealedAt: now } }).member).toBe(member);
  });
  it('merges membership without overwriting history or mutating inputs', () => {
    const additions = [{ ...member, commitSha: 'replacement' }, { ...member, idemKey: 'two' }];
    expect(mergeMembers(state.members, additions)).toEqual([member, additions[1]]);
    expect(state.members).toEqual([member]);
  });
  const entry = { parentSha: 'h1', commitSha: 'h2', batchRef: state.batchRef,
    cardPath: 'backlog/5193-card.md', member: { ...member, idemKey: 'two', commitSha: 'h2' } };
  it('reconciles a continuous suffix and exposes the new head for a retry', () => {
    const result = planReconcile(state, [entry]);
    expect(result).toMatchObject({ action: 'reconcile', state: { headSha: 'h2', members: [member, entry.member] } });
    expect(plan({ state, input: { ...input, remoteHead: 'h2', remoteLogEntries: [entry] } })).toEqual(result);
    expect(state.headSha).toBe('h1');
  });
  it.each([
    { parentSha: 'wrong' }, { batchRef: 'sealed-old-ref' }, { cardPath: 'package.json' },
    { member }, { member: { ...entry.member, commitSha: 'wrong' } },
  ])('refuses inconsistent recovery evidence %j', change => {
    expect(planReconcile(state, [{ ...entry, ...change }])).toEqual({ action: 'refuse', reason: 'head-mismatch' });
  });
  it('requires recovery evidence to reach the observed remote head', () => {
    expect(plan({ state, input: { ...input, remoteHead: 'h3', remoteLogEntries: [entry] } })).toEqual({ action: 'refuse', reason: 'head-mismatch' });
  });
});

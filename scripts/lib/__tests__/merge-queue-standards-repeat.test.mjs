// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest';

let decideStuckDequeues, readQueueEntryStates;
beforeAll(async () => { ({ decideStuckDequeues, readQueueEntryStates } = await import('../merge-queue-stuck-dequeue.mjs')); });

const nowMs = Date.parse('2026-10-26T12:00:00Z');
const oid = (c) => c.repeat(40);
const entry = (g, over = {}) => ({ num: 5969, state: 'AWAITING_CHECKS', enqueuedAt: '2026-10-26T10:39:00Z', groupOid: oid(g), ci: 'FAILURE', failedChecks: ['standards'], ...over });

describe('repeated deterministic standards failure', () => {
  it('does not dequeue on the first failed group', () => {
    const r = decideStuckDequeues({ entries: [entry('a')], tracker: {}, max: 99, nowMs });
    expect(r.dequeue).toEqual([]);
  });
  it('dequeues when a second distinct group fails standards for the same entry', () => {
    const first = decideStuckDequeues({ entries: [entry('a')], tracker: {}, max: 99, nowMs });
    const second = decideStuckDequeues({ entries: [entry('b')], tracker: first.tracker, max: 99, nowMs });
    expect(second.dequeue).toEqual([expect.objectContaining({ num: 5969, kind: 'standards-failed-twice' })]);
    expect(second.dequeue[0].reason).toContain('standards');
  });
  it('re-seeing the same failed group does not count twice', () => {
    const first = decideStuckDequeues({ entries: [entry('a')], tracker: {}, max: 99, nowMs });
    const again = decideStuckDequeues({ entries: [entry('a')], tracker: first.tracker, max: 99, nowMs });
    expect(again.dequeue).toEqual([]);
  });
  it('resets failure and rebuild history when the same PR re-enters between sweeps', () => {
    const first = decideStuckDequeues({ entries: [entry('a')], tracker: {}, max: 99, nowMs });
    const nextEntry = entry('b', { enqueuedAt: '2026-10-26T11:00:00Z' });
    const second = decideStuckDequeues({ entries: [nextEntry], tracker: first.tracker, max: 99, nowMs });
    expect(second.dequeue).toEqual([]);
    expect(second.tracker[5969].count).toBe(0);
    expect(second.tracker[5969].fails).toEqual([oid('b')]);
  });
  it('a different failing check never counts', () => {
    const e = (g) => entry(g, { failedChecks: ['smoke'] });
    const first = decideStuckDequeues({ entries: [e('a')], tracker: {}, max: 99, nowMs });
    expect(decideStuckDequeues({ entries: [e('b')], tracker: first.tracker, max: 99, nowMs }).dequeue).toEqual([]);
  });
  it('a pending group between two failures keeps the history', () => {
    const first = decideStuckDequeues({ entries: [entry('a')], tracker: {}, max: 99, nowMs });
    const mid = decideStuckDequeues({ entries: [entry('c', { ci: 'PENDING', failedChecks: [] })], tracker: first.tracker, max: 99, nowMs });
    const last = decideStuckDequeues({ entries: [entry('b')], tracker: mid.tracker, max: 99, nowMs });
    expect(last.dequeue.map(d => d.kind)).toEqual(['standards-failed-twice']);
  });
  it.each([
    ['MERGEABLE/SUCCESS', { state: 'MERGEABLE', ci: 'SUCCESS', failedChecks: [] }],
    ['MERGEABLE with inconsistent failure evidence', { state: 'MERGEABLE' }],
    ['successful CI with stale check failures', { ci: 'SUCCESS' }],
    ['pending CI', { ci: 'PENDING' }],
    ['another failing check', { failedChecks: ['smoke'] }],
    ['unknown checks', { failedChecks: undefined }],
  ])('does not dequeue %s after two standards failures', (_name, current) => {
    const first = decideStuckDequeues({ entries: [entry('a')], tracker: {}, max: 99, nowMs });
    const second = decideStuckDequeues({ entries: [entry('b')], tracker: first.tracker, max: 99, nowMs });
    expect(second.tracker[5969].fails).toEqual([oid('a'), oid('b')]);
    const recovered = decideStuckDequeues({ entries: [entry('c', current)], tracker: second.tracker, max: 99, nowMs });
    expect(recovered.dequeue).toEqual([]);
  });
  it('an old tracker without the failure list still works', () => {
    const r = decideStuckDequeues({ entries: [entry('b')], tracker: { 5969: { oid: oid('a'), count: 0 } }, max: 99, nowMs });
    expect(r.dequeue).toEqual([]);
  });
  it('drops legacy history without an enqueue identity instead of attributing it to the current entry', () => {
    const legacy = { 5969: { oid: oid('a'), count: 98, fails: [oid('a')] } };
    const r = decideStuckDequeues({ entries: [entry('b')], tracker: legacy, max: 2, nowMs });
    expect(r.dequeue).toEqual([]);
    expect(r.tracker[5969]).toEqual({ enqueuedAt: entry('b').enqueuedAt, oid: oid('b'), count: 0, fails: [oid('b')] });
  });
  it('does not accumulate failures when the enqueue identity is unreadable', () => {
    const first = decideStuckDequeues({ entries: [entry('a', { enqueuedAt: undefined })], tracker: {}, max: 1, nowMs });
    const second = decideStuckDequeues({ entries: [entry('b', { enqueuedAt: undefined })], tracker: first.tracker, max: 1, nowMs });
    expect(second.dequeue).toEqual([]);
    // Same contract as the base sweep: no valid enqueue time → nothing is persisted, so nothing can accumulate.
    expect(first.tracker[5969]).toBeUndefined();
    expect(second.tracker[5969]).toBeUndefined();
  });
  it('keeps the same enqueue identity across equivalent timestamp spellings', () => {
    const first = decideStuckDequeues({ entries: [entry('a')], tracker: {}, max: 99, nowMs });
    const second = decideStuckDequeues({ entries: [entry('b', { enqueuedAt: '2026-10-26T10:39:00.000Z' })], tracker: first.tracker, max: 99, nowMs });
    expect(second.dequeue).toEqual([expect.objectContaining({ kind: 'standards-failed-twice' })]);
    expect(second.tracker[5969].count).toBe(1);
  });
});

describe('readQueueEntryStates failed checks', () => {
  it('reads the names of failing checks from a separate aliased field', () => {
    const nodes = [{ state: 'AWAITING_CHECKS', enqueuedAt: '2026-10-26T10:39:00Z',
      headCommit: { oid: oid('a'), statusCheckRollup: { state: 'FAILURE' } },
      checks: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
        { __typename: 'CheckRun', name: 'standards', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'legacy', state: 'ERROR' }] } } },
      pullRequest: { number: 5969 } }];
    const exec = vi.fn(() => JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes, pageInfo: { hasNextPage: false } } } } } }));
    expect(readQueueEntryStates({ repo: 'o/r', exec }).entries[0].failedChecks).toEqual(['standards', 'legacy']);
    const query = exec.mock.calls[0][1].find(a => a.startsWith('query=')).replace(/\s/g, '');
    expect(query).toContain('statusCheckRollup{state}');
    expect(query).toContain('contexts(first:100){pageInfo{hasNextPage}');
  });
});


describe('incomplete check contexts are unknown', () => {
  it.each([
    ['truncated page', { hasNextPage: true }, 100],
    ['missing pagination', undefined, 1],
    ['oversized page', { hasNextPage: false }, 101],
  ])('leaves failedChecks absent for a %s and cannot add a standards verdict', (_name, pageInfo, size) => {
    const nodes = [{ state: 'AWAITING_CHECKS', enqueuedAt: '2026-10-26T10:39:00Z',
      headCommit: { oid: oid('c'), statusCheckRollup: { state: 'FAILURE' } },
      checks: { statusCheckRollup: { contexts: { pageInfo,
        nodes: Array.from({ length: size }, () => ({ __typename: 'CheckRun', name: 'standards', conclusion: 'FAILURE' })) } } },
      pullRequest: { number: 5969 } }];
    const exec = vi.fn(() => JSON.stringify({ data: { repository: { mergeQueue: {
      entries: { nodes, pageInfo: { hasNextPage: false } } } } } }));
    const result = readQueueEntryStates({ repo: 'o/r', exec });
    expect(result.error).toBeUndefined();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).not.toHaveProperty('failedChecks');
    const tracker = { 5969: { enqueuedAt: nodes[0].enqueuedAt, oid: oid('b'), count: 1, fails: [oid('a'), oid('b')] } };
    const decision = decideStuckDequeues({ entries: result.entries, tracker, max: 99, nowMs });
    expect(decision.dequeue).toEqual([]);
    expect(decision.tracker[5969].fails).toEqual([oid('a'), oid('b')]);
  });
});

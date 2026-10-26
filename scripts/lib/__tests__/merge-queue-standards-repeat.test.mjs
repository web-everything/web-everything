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
  it('an old tracker without the failure list still works', () => {
    const r = decideStuckDequeues({ entries: [entry('b')], tracker: { 5969: { oid: oid('a'), count: 0 } }, max: 99, nowMs });
    expect(r.dequeue).toEqual([]);
  });
});

describe('readQueueEntryStates failed checks', () => {
  it('reads the names of failing checks from a separate aliased field', () => {
    const nodes = [{ state: 'AWAITING_CHECKS', enqueuedAt: '2026-10-26T10:39:00Z',
      headCommit: { oid: oid('a'), statusCheckRollup: { state: 'FAILURE' } },
      checks: { statusCheckRollup: { contexts: { nodes: [
        { __typename: 'CheckRun', name: 'standards', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'legacy', state: 'ERROR' }] } } },
      pullRequest: { number: 5969 } }];
    const exec = vi.fn(() => JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes, pageInfo: { hasNextPage: false } } } } } }));
    expect(readQueueEntryStates({ repo: 'o/r', exec }).entries[0].failedChecks).toEqual(['standards', 'legacy']);
    expect(exec.mock.calls[0][1].find(a => a.startsWith('query=')).replace(/\s/g, '')).toContain('statusCheckRollup{state}');
  });
});

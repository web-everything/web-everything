// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Register cases before loading the implementation, which is absent in this red phase.
let readQueueEntryStates, decideStuckDequeues, describeBlocker, sweepStuckEntries;
beforeAll(async () => {
  ({ readQueueEntryStates, decideStuckDequeues, describeBlocker, sweepStuckEntries } = await import('../merge-queue-stuck-dequeue.mjs'));
});

const repo = 'o/r';
const nowMs = Date.parse('2026-10-26T12:00:00Z');
const enqueuedAt = '2026-10-26T10:39:00Z';
const oid = 'a'.repeat(40);
const entry = (overrides = {}) => ({ num: 5977, state: 'AWAITING_CHECKS', enqueuedAt, groupOid: oid, ci: 'PENDING', ...overrides });
const node = (overrides = {}) => ({ state: 'AWAITING_CHECKS', enqueuedAt,
  headCommit: { oid, statusCheckRollup: { state: 'PENDING' } }, pullRequest: { number: 5977 }, ...overrides });
const response = (nodes = [node()], pageInfo = { hasNextPage: false }) => ({ data: { repository: { mergeQueue: { entries: { nodes, pageInfo } } } } });

describe('readQueueEntryStates', () => {
  it('reads main queue states and group CI in one bounded GraphQL call', () => {
    const exec = vi.fn(() => JSON.stringify(response()));
    expect(readQueueEntryStates({ repo, exec })).toEqual({ entries: [entry()] });
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args] = exec.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toEqual(expect.arrayContaining(['owner=o', 'name=r']));
    const query = args.find(a => a.startsWith('query=')).replace(/\s/g, '');
    for (const field of ['mergeQueue(branch:"main")', 'entries(first:100)', 'pageInfo{hasNextPage}', 'state', 'enqueuedAt', 'headCommit{oidstatusCheckRollup{state}}', 'pullRequest{number}']) expect(query).toContain(field);
  });

  it('accepts a complete empty queue', () => {
    expect(readQueueEntryStates({ repo, exec: () => JSON.stringify(response([])) })).toEqual({ entries: [] });
  });

  it.each([
    ['GraphQL errors alongside partial data', { ...response(), errors: [{ message: 'offline' }] }],
    ['missing data', {}],
    ['missing queue', { data: { repository: { mergeQueue: null } } }],
    ['missing nodes', response(null)],
    ['more than 100 entries', response([node()], { hasNextPage: true })],
    ['missing pagination evidence', response([node()], null)],
    ['malformed node after a valid one', response([node(), null])],
    ['missing PR', response([node({ pullRequest: null })])],
    ['non-integer PR', response([node({ pullRequest: { number: '5977' } })])],
    ['missing state', response([node({ state: null })])],
    ['missing group commit field', response([node({ headCommit: undefined })])],
    ['malformed group commit', response([node({ headCommit: { oid: 'invalid' } })])],
    ['oversized page despite no next page', response(Array.from({ length: 101 }, (_, i) => node({ pullRequest: { number: i + 1 } })))],
    ['null OID on a non-null group commit', response([node({ headCommit: { oid: null } })])],
    ['missing OID on a non-null group commit', response([node({ headCommit: {} })])],
  ])('fails closed on %s without returning partial entries', (_name, data) => {
    expect(readQueueEntryStates({ repo, exec: () => JSON.stringify(data) })).toEqual({ entries: [], error: expect.any(String) });
  });

  it.each(['throws', 'invalid JSON'])('fails closed when exec %s', mode => {
    const exec = () => { if (mode === 'throws') throw new Error('offline'); return '{'; };
    expect(readQueueEntryStates({ repo, exec })).toEqual({ entries: [], error: expect.any(String) });
  });

  it.each(['QUEUED', 'AWAITING_CHECKS', 'UNMERGEABLE'])('accepts a %s entry without a group commit alongside other entries', state => {
    expect(readQueueEntryStates({ repo, exec: () => JSON.stringify(response([
      node({ state, headCommit: null }), node({ state: 'UNMERGEABLE', pullRequest: { number: 5962 } }),
    ])) })).toEqual({ entries: [entry({ state, groupOid: null, ci: undefined }), entry({ num: 5962, state: 'UNMERGEABLE' })] });
  });
});

describe('decideStuckDequeues', () => {
  const decide = (entries, tracker = {}, max = 3) => decideStuckDequeues({ entries, tracker, max, nowMs });

  it.each(['same', 'changed'])('resets rebuild history for a new enqueue with a %s group OID', mode => {
    let tracker = {};
    for (const group of ['a', 'b', 'c']) tracker = decide([entry({ groupOid: group.repeat(40) })], tracker).tracker;
    expect(tracker[5977].count).toBe(2);
    const fresh = decide([entry({ enqueuedAt: '2026-10-26T11:59:00Z', groupOid: (mode === 'same' ? 'c' : 'd').repeat(40) })], tracker);
    expect(fresh.dequeue).toEqual([]);
    expect(fresh.tracker[5977]).toMatchObject({ count: 0, enqueuedAt: '2026-10-26T11:59:00Z' });
  });

  it('starts legacy persisted history without enqueue identity at zero', () => {
    expect(decide([entry()], { 5977: { oid: 'b'.repeat(40), count: 2 } })).toEqual({
      dequeue: [], tracker: { 5977: { oid, count: 0, enqueuedAt } },
    });
  });

  it('skips rebuild counting without a group commit while still selecting UNMERGEABLE entries', () => {
    const result = decide([entry({ groupOid: null }), entry({ num: 5962, state: 'UNMERGEABLE', groupOid: null })],
      { 5977: { oid, count: 2, enqueuedAt } });
    expect(result.dequeue.map(d => d.num)).toEqual([5962]);
    expect(result.tracker[5977]).toBeUndefined();
    const grouped = decide([entry({ groupOid: 'b'.repeat(40) })], result.tracker);
    expect(grouped.dequeue).toEqual([]);
    expect(grouped.tracker[5977].count).toBe(0);
  });

  it('records first sight at zero, ignores the same OID, increments on a changed group OID and prunes departed PRs', () => {
    const first = decide([entry()], { 42: { oid, count: 2 } });
    expect(first).toEqual({ dequeue: [], tracker: { 5977: { oid, count: 0, enqueuedAt } } });
    expect(decide([entry()], first.tracker)).toEqual(first);
    const changed = decide([entry({ groupOid: 'b'.repeat(40) })], first.tracker);
    expect(changed).toEqual({ dequeue: [], tracker: { 5977: { oid: 'b'.repeat(40), count: 1, enqueuedAt } } });
    expect(decide([], changed.tracker)).toEqual({ dequeue: [], tracker: {} });
  });

  it('dequeues UNMERGEABLE immediately and names the PR and state in its reason', () => {
    expect(decide([entry({ num: 5962, state: 'UNMERGEABLE' })]).dequeue).toEqual([
      { num: 5962, kind: 'unmergeable', reason: expect.stringMatching(/#5962.*UNMERGEABLE/) },
    ]);
  });

  it('regresses #5977 rebuilding three times while #5962 is UNMERGEABLE behind it', () => {
    let tracker = {};
    for (let pass = 0; pass <= 3; pass++) {
      const entries = [entry({ groupOid: String(pass).repeat(40) }), ...(pass === 0 ? [entry({ num: 5962, state: 'UNMERGEABLE' })] : [])];
      const result = decide(entries, tracker);
      tracker = result.tracker;
      expect(tracker[5977].count).toBe(pass);
      expect(result.dequeue.map(d => [d.num, d.kind])).toEqual(pass === 0 ? [[5962, 'unmergeable']] : pass === 3 ? [[5977, 'rebuilds']] : []);
      if (pass === 3) {
        const reason = result.dequeue[0].reason;
        expect(reason).toContain('#5977');
        expect(reason).toContain('AWAITING_CHECKS');
        expect(reason).toMatch(/3.*3/);
      }
    }
  });

  it('names distinct rebuild count and max at and beyond the configured threshold', () => {
    const result = decide([entry()], { 5977: { oid, count: 4, enqueuedAt } }, 3);
    expect(result.dequeue).toEqual([{ num: 5977, kind: 'rebuilds', reason: expect.any(String) }]);
    for (const text of ['#5977', 'AWAITING_CHECKS', '4', '3']) expect(result.dequeue[0].reason).toContain(text);
  });

  it('never dequeues a MERGEABLE entry even with a high rebuild count', () => {
    expect(decide([entry({ state: 'MERGEABLE' })], { 5977: { oid, count: 99, enqueuedAt } }).dequeue).toEqual([]);
  });

  it('honors a max of one at the first group rebuild', () => {
    const first = decide([entry()], {}, 1);
    expect(first.dequeue).toEqual([]);
    expect(decide([entry({ groupOid: 'b'.repeat(40) })], first.tracker, 1).dequeue)
      .toEqual([{ num: 5977, kind: 'rebuilds', reason: expect.any(String) }]);
  });

  it('reports an UNMERGEABLE entry as unmergeable even when it also exceeds the rebuild max', () => {
    expect(decide([entry({ state: 'UNMERGEABLE' })], { 5977: { oid, count: 99, enqueuedAt } }).dequeue)
      .toEqual([{ num: 5977, kind: 'unmergeable', reason: expect.any(String) }]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, '3', undefined])('dequeues nothing for invalid max %s, including UNMERGEABLE entries', max => {
    expect(decideStuckDequeues({ entries: [entry({ state: 'UNMERGEABLE' })], tracker: {}, max, nowMs }).dequeue).toEqual([]);
  });
  it.each([null, undefined, {}, 'entries'])('dequeues nothing for non-array entries %s', entries => {
    expect(decide(entries).dequeue).toEqual([]);
  });

  it.each([undefined, null, '', 'invalid'])('does not reuse or persist rebuild history without a valid enqueue time: %s', time => {
    const result = decide([entry({ enqueuedAt: time })], { 5977: { oid: 'b'.repeat(40), count: 2, enqueuedAt: time } });
    expect(result).toEqual({ dequeue: [], tracker: {} });
    expect(decide([entry({ state: 'UNMERGEABLE', enqueuedAt: time })]).dequeue.map(d => d.num)).toEqual([5977]);
  });
});

describe('describeBlocker', () => {
  it('describes queue age, state and CI', () => {
    expect(describeBlocker(entry(), nowMs)).toBe('#5977 in queue 81 min, state AWAITING_CHECKS, CI PENDING');
  });
  it.each([undefined, null, {}])('never throws on missing entry fields: %s', value => {
    expect(describeBlocker(value, nowMs)).toContain('unknown');
  });
  it('renders each absent or invalid field as unknown', () => {
    expect(describeBlocker({ num: 5977, enqueuedAt: 'bad date' }, nowMs)).toBe('#5977 in queue unknown min, state unknown, CI unknown');
  });
});

function sweepIo({ nodes = [node({ state: 'UNMERGEABLE' })], queueError, queueResponse, state = '{}', readError = false, fail = [], absent = [], unconfirmed = [], commentFail = [] } = {}) {
  const queued = new Set(nodes.map(n => n.pullRequest.number).filter(n => !absent.includes(n)));
  const timeline = [];
  const exec = vi.fn((cmd, args) => {
    expect(cmd).toBe('gh');
    const query = args.find(a => a.startsWith('query=')) ?? '';
    if (query.includes('mergeQueue(branch:')) {
      if (queueError) throw new Error(queueError);
      return JSON.stringify(queueResponse ?? response(nodes));
    }
    if (query.includes('isInMergeQueue')) {
      const pr = Number(args.find(a => a.startsWith('pr=')).slice('pr='.length));
      timeline.push(['membership', pr, queued.has(pr)]);
      return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: queued.has(pr) } } } });
    }
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: `PR_${args[2]}` });
    if (query.includes('dequeuePullRequest')) {
      const pr = Number(args.find(a => a.startsWith('id=PR_')).slice('id=PR_'.length));
      timeline.push(['mutation', pr]);
      if (fail.includes(pr)) throw new Error('mutation refused');
      if (!unconfirmed.includes(pr)) queued.delete(pr);
      return JSON.stringify({ data: { dequeuePullRequest: { clientMutationId: null } } });
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      timeline.push(['comment', Number(args[2]), args.at(-1)]);
      if (commentFail.includes(Number(args[2]))) throw new Error('comment unavailable');
      return '';
    }
    throw new Error(`unexpected args ${args}`);
  });
  const readFile = vi.fn(() => { if (readError) throw new Error('ENOENT'); return state; });
  const writeFile = vi.fn();
  const emit = vi.fn(event => timeline.push(['emit', event.pr]));
  const log = vi.fn();
  const options = { repo, exec, max: 3, nowMs, statePath: 'state/stuck.json', readFile, writeFile, emit, log };
  return { options, exec, readFile, writeFile, emit, log, timeline, run: extra => sweepStuckEntries({ ...options, ...extra }) };
}

describe('sweepStuckEntries', () => {
  it('records confirmed removals and clears history even when a PR comment fails', () => {
    const h = sweepIo({ commentFail: [5977], nodes: [node({ state: 'UNMERGEABLE' }), node({ state: 'UNMERGEABLE', pullRequest: { number: 5962 } })] });
    expect(h.run()).toEqual({ dequeued: [5977, 5962] });
    expect(h.emit.mock.calls.map(([event]) => event.pr)).toEqual([5977, 5962]);
    expect(JSON.parse(h.writeFile.mock.calls.at(-1)[1])).toEqual({});
    expect(h.log.mock.calls.flat().join(' ')).toMatch(/comment.*(?:failed|unavailable)/i);
  });

  it.each(['throwing', 'rejecting'])('isolates throwing and rejecting event sinks (%s)', async mode => {
    const h = sweepIo({ nodes: [node({ state: 'UNMERGEABLE' }), node({ state: 'UNMERGEABLE', pullRequest: { number: 5962 } })] });
    const emit = vi.fn(() => {
      if (mode === 'throwing') throw new Error('event sink unavailable');
      return Promise.reject(new Error('event sink unavailable'));
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(h.run({ emit })).toEqual({ dequeued: [5977, 5962] });
      await new Promise(resolve => setImmediate(resolve));
      expect(emit).toHaveBeenCalledTimes(2);
      expect(JSON.parse(h.writeFile.mock.calls.at(-1)[1])).toEqual({});
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });

  it('dequeues an UNMERGEABLE entry even when another queued entry has no group commit', () => {
    const h = sweepIo({ nodes: [node({ state: 'QUEUED', headCommit: null }), node({ state: 'UNMERGEABLE', pullRequest: { number: 5962 } })] });
    expect(h.run()).toEqual({ dequeued: [5962] });
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ pr: 5962 }));
  });

  it('resets persisted rebuild history when a PR is externally re-enqueued', () => {
    const h = sweepIo({ nodes: [node({ enqueuedAt: '2026-10-26T11:59:00Z', headCommit: { oid: 'd'.repeat(40) } })],
      state: JSON.stringify({ 5977: { oid: 'c'.repeat(40), count: 2, enqueuedAt } }) });
    expect(h.run()).toEqual({ dequeued: [] });
    expect(JSON.parse(h.writeFile.mock.calls.at(-1)[1])[5977]).toMatchObject({ count: 0, enqueuedAt: '2026-10-26T11:59:00Z' });
    expect(h.timeline).toEqual([]);
  });

  it('confirms removal and passes the same reason to the PR comment and event, emitting only after success', () => {
    const h = sweepIo();
    expect(h.run()).toEqual({ dequeued: [5977] });
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith({ kind: 'queue-entry-dequeued', repo, pr: 5977,
      detail: { reason: expect.stringMatching(/#5977.*UNMERGEABLE/), state: 'UNMERGEABLE', kind: 'unmergeable' } });
    const reason = h.emit.mock.calls[0][0].detail.reason;
    const comment = h.timeline.findIndex(e => e[0] === 'comment');
    expect(h.timeline[comment][2]).toContain(reason);
    expect(h.timeline[comment - 1]).toEqual(['membership', 5977, false]);
    expect(h.timeline.findIndex(e => e[0] === 'emit')).toBeGreaterThan(comment);
  });

  it('forgets the rebuild history of a dequeued PR so a re-enqueue starts at zero', () => {
    const h = sweepIo();
    h.run();
    const last = JSON.parse(h.writeFile.mock.calls.at(-1)[1]);
    expect(last[5977]).toBeUndefined();
  });

  it('a queue read error causes no dequeue, tracker mutation or event', () => {
    const h = sweepIo({ queueError: 'offline' });
    expect(h.run()).toEqual({ dequeued: [], error: expect.any(String) });
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it.each([
    ['GraphQL partial error', { ...response(), errors: [{ message: 'partial' }] }],
    ['pagination cap', response([node({ state: 'UNMERGEABLE' })], { hasNextPage: true })],
    ['malformed node', response([node({ state: 'UNMERGEABLE' }), null])],
  ])('does not mutate tracker or PRs or emit on incomplete queue evidence: %s', (_name, queueResponse) => {
    const h = sweepIo({ queueResponse });
    expect(h.run()).toEqual({ dequeued: [], error: expect.any(String) });
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.timeline).toEqual([]);
  });

  it.each([{ state: '{' }, { readError: true }])('treats corrupt or unreadable tracker state as empty: %j', options => {
    const h = sweepIo({ ...options, nodes: [node(), node({ state: 'UNMERGEABLE', pullRequest: { number: 5962 } })] });
    expect(h.run().dequeued).toEqual([5962]);
    expect(h.writeFile).toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it('loads tracker JSON and saves changed OIDs for the next pass', () => {
    const h = sweepIo({ nodes: [node()], state: JSON.stringify({ 5977: { oid: 'b'.repeat(40), count: 1, enqueuedAt }, 42: { oid, count: 8 } }) });
    expect(h.run()).toEqual({ dequeued: [] });
    expect(h.readFile.mock.calls[0][0]).toBe(h.options.statePath);
    const [path, json] = h.writeFile.mock.calls.at(-1);
    expect(path).toBe(h.options.statePath);
    expect(JSON.parse(json)).toEqual({ 5977: { oid, count: 2, enqueuedAt } });
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('uses the persisted rebuild count to dequeue the head on its third OID change', () => {
    const h = sweepIo({ nodes: [node()], state: JSON.stringify({ 5977: { oid: 'b'.repeat(40), count: 2, enqueuedAt } }) });
    expect(h.run().dequeued).toEqual([5977]);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ pr: 5977,
      detail: { kind: 'rebuilds', state: 'AWAITING_CHECKS', reason: expect.stringContaining('3') } }));
  });

  it('retains a fresh queue entry when persisted failures and rebuilds belong to its previous enqueue', () => {
    const newEnqueuedAt = '2026-10-26T11:00:00Z';
    const h = sweepIo({ nodes: [node({ enqueuedAt: newEnqueuedAt,
      headCommit: { oid, statusCheckRollup: { state: 'FAILURE' } },
      checks: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
        { __typename: 'CheckRun', name: 'standards', conclusion: 'FAILURE' },
      ] } } } })], state: JSON.stringify({ 5977: { enqueuedAt, oid: 'b'.repeat(40), count: 2, fails: ['b'.repeat(40)] } }) });
    expect(h.run()).toEqual({ dequeued: [] });
    expect(JSON.parse(h.writeFile.mock.calls.at(-1)[1])[5977]).toEqual({ enqueuedAt: newEnqueuedAt, oid, count: 0, fails: [oid] });
    expect(h.timeline).toEqual([]);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it.each(['failure', 'unconfirmed', 'already absent'])('isolates a dequeue %s, continues with other entries and emits only for successful removals', mode => {
    const h = sweepIo({ nodes: [node({ state: 'UNMERGEABLE' }), node({ state: 'UNMERGEABLE', pullRequest: { number: 5962 } })],
      fail: mode === 'failure' ? [5977] : [], absent: mode === 'already absent' ? [5977] : [], unconfirmed: mode === 'unconfirmed' ? [5977] : [] });
    expect(h.run().dequeued).toEqual([5962]);
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit.mock.calls[0][0].pr).toBe(5962);
    expect(h.timeline.filter(e => e[0] === 'comment').map(e => e[1])).toEqual([5962]);
  });

  it('dryRun logs the decision without filesystem writes, mutations, comments or events', () => {
    const h = sweepIo();
    expect(h.run({ dryRun: true }).dequeued).toEqual([]);
    expect(h.log).toHaveBeenCalled();
    expect(h.log.mock.calls.flat().join(' ')).toContain('5977');
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.timeline).toEqual([]);
  });
});

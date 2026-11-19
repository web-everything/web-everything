import { describe, it, expect, vi } from 'vitest';
import { createRedTeamDispatchQueue, runWithRedTeamQueue } from '../red-team-dispatch-queue.mjs';
import { runRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { drainRedTeamQueue } from '../red-team-queue-drain.mjs';

const repo = 'example/project', head = 'a'.repeat(40), at = 10_000_000;
function fixture(entries = [{ pr: 1, blocked: 'planner-skip' }]) {
  let clock = at, failWrite = false;
  let stored = JSON.stringify(entries.map(entry => ({ repo, head, enqueuedAt: at - 61 * 60_000,
    attempts: 2, ...entry, key: `${entry.repo ?? repo}#${entry.pr}` })));
  const open = () => createRedTeamDispatchQueue({ file: 'memory', readFile: () => stored, now: () => clock,
    writeFile: (_path, value) => { if (failWrite) throw Error('disk unavailable'); stored = value; },
    rename: () => {}, unlink: () => {} });
  const queue = open();
  const dispatch = vi.fn(({ pr }) => ({ jobPid: 1000 + pr }));
  const readLivePr = vi.fn(() => ({ state: 'OPEN', isDraft: false, headRefOid: head }));
  const readPrs = vi.fn(({ repo: slug }) => entries.filter(entry => (entry.repo ?? repo) === slug)
    .map(entry => ({ number: entry.pr, headRefOid: head, isDraft: false, labels: [], comments: [], reviews: [] })));
  const run = vi.fn(options => runRedTeamOnSkip({ ...options, dispatch, now: () => clock,
    setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(),
    readEvidence: ({ head: rev }) => ({ recorded: false,
      loopPayload: { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev } } } } }),
    readStatus: () => null, readWitness: null, readReviewRuns: () => [], syncLabels: () => {} }));
  const options = { queue, now: () => clock, readPrs, alert: vi.fn(), log: vi.fn(),
    capacity: { lanes: 10, remainingStarts: 10, startsCeiling: 10, budget: { live: 0, max: 10, left: 10 } } };
  options.runQueue = vi.fn(input => runWithRedTeamQueue({ ...input, queue: options.queue, run,
    floor: { minConcurrent: 3, idlePct: 10 }, readCpuIdlePct: () => 100, readLivePr,
    readNetFiles: () => ({ ok: false }), log: options.log }));
  return { queue, open, run, dispatch, readLivePr, options,
    setClock: value => { clock = value; }, failWrite: value => { failWrite = value; } };
}

describe('red-team queue drain through shared recovery', () => {
  it('retries a persisted planner-skip through runRedTeamOnSkip and settles its actual dispatch', async () => {
    const f = fixture();
    expect(await drainRedTeamQueue(f.options)).toMatchObject({ dispatched: 1, oldestAgeMin: 61 });
    expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({ repo, pr: 1, redTeamOnly: true }));
    expect(f.options.runQueue.mock.calls[0][0].plan.refusals).toEqual([
      { kind: 'already-reviewed-head', prNumber: 1, headSha: head },
    ]);
    expect(f.options.readPrs).toHaveBeenCalledWith({ repo, fresh: true });
    expect(f.open().entries()).toEqual([]);
  });
  it('starts oldest enqueuedAt first across repositories and rotated persisted positions', async () => {
    const f = fixture([{ pr: 1, enqueuedAt: at - 100 },
      { pr: 2, repo: 'example/other', enqueuedAt: at - 200 }, { pr: 3, enqueuedAt: at - 300 }]);
    await drainRedTeamQueue(f.options);
    expect(f.dispatch.mock.calls.map(([d]) => d.pr)).toEqual([3, 2, 1]);
    expect(f.options.readPrs).toHaveBeenCalledTimes(2);
  });
  it('shared reconcile replaces a stale head, preserves age, and dispatches the current head on the next pass', async () => {
    const f = fixture();
    const current = 'b'.repeat(40);
    f.readLivePr.mockReturnValue({ state: 'OPEN', isDraft: false, headRefOid: current });
    f.options.readPrs.mockReturnValue([{ number: 1, headRefOid: current, isDraft: false, labels: [], comments: [] }]);
    await drainRedTeamQueue(f.options);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.open().entries()).toEqual([expect.objectContaining({ head: current, attempts: 0,
      enqueuedAt: at - 61 * 60_000 })]);
    expect(f.open().entries()[0].blocked).toBeUndefined();
    await drainRedTeamQueue(f.options);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.open().entries()).toEqual([]);
  });
  it('caps starts at the shared floor minus live rounds across interleaved repositories', async () => {
    const f = fixture([{ pr: 1 }, { pr: 2, repo: 'example/other' }, { pr: 3 }]);
    Object.assign(f.options.capacity.budget, { live: 2, left: 8 });
    await drainRedTeamQueue(f.options);
    expect(f.dispatch.mock.calls.map(([d]) => d.pr)).toEqual([1]);
    expect(f.open().entries()).toHaveLength(2);
  });
  it.each(['host', 'lanes', 'budget', 'unknown-live', 'oversized-live'])('holds capacity for the next interval when %s refuses', async reason => {
    const f = fixture();
    if (reason === 'host') Object.assign(f.options.capacity, { remainingStarts: 0, startsCeiling: 0 });
    if (reason === 'lanes') f.options.capacity.lanes = 0;
    if (reason === 'budget') f.options.capacity.budget.left = 0;
    if (reason === 'unknown-live') delete f.options.capacity.budget.live;
    if (reason === 'oversized-live') f.options.capacity.budget.live = 100;
    await drainRedTeamQueue(f.options);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.open().entries()).toHaveLength(1);
  });
  it('honors persisted retryAt, then really retries when the cooldown expires', async () => {
    const f = fixture([{ pr: 1, blocked: 'planner-skip', retryAt: at + 100 }]);
    await drainRedTeamQueue(f.options);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.open().entries()[0]).toMatchObject({ blocked: 'planner-skip', retryAt: at + 100, attempts: 2 });
    f.options.queue = f.open();
    f.setClock(at + 100);
    await drainRedTeamQueue(f.options);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it.each([true, undefined])('keeps draft or unreadable draft state %s queued without spending a slot', async isDraft => {
    const f = fixture([{ pr: 1 }, { pr: 2 }]);
    f.readLivePr.mockImplementation(({ pr }) => ({ state: 'OPEN', headRefOid: head, isDraft: pr === 1 ? isDraft : false }));
    await drainRedTeamQueue(f.options);
    expect(f.dispatch.mock.calls.map(([d]) => d.pr)).toEqual([2]);
    expect(f.open().entries()).toEqual([expect.objectContaining({ pr: 1, attempts: 2 })]);
    f.readLivePr.mockReturnValue({ state: 'OPEN', headRefOid: head, isDraft: false });
    f.options.queue = f.open();
    await drainRedTeamQueue(f.options);
    expect(f.dispatch.mock.calls.map(([d]) => d.pr)).toEqual([2, 1]);
  });
  it('keeps a draft from the fresh PR list even if the head reader says ready', async () => {
    const f = fixture();
    f.options.readPrs.mockReturnValue([{ number: 1, headRefOid: head, isDraft: true }]);
    await drainRedTeamQueue(f.options);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.open().entries()).toHaveLength(1);
  });
  it('supplies every queued candidate so an absent live-list entry is retained by sync', async () => {
    const f = fixture([{ pr: 1 }, { pr: 2 }]);
    f.options.readPrs.mockReturnValue([{ number: 2, headRefOid: head, isDraft: false, labels: [], comments: [] }]);
    await drainRedTeamQueue(f.options);
    expect(f.options.runQueue.mock.calls[0][0].plan.refusals.map(row => row.prNumber)).toEqual([1, 2]);
    expect(f.dispatch.mock.calls.map(([d]) => d.pr)).toEqual([2]);
    expect(f.open().entries()).toEqual([expect.objectContaining({ pr: 1 })]);
  });
  it.each(['throw', 'incomplete', 'null'])('an unreadable open PR list (%s) holds all heads and reads once per repository', async failure => {
    const f = fixture([{ pr: 1 }, { pr: 2 }]);
    f.options.readPrs.mockImplementation(() => {
      if (failure === 'throw') throw Error('list unavailable');
      return failure === 'null' ? null : Object.assign([], { discoveryIncomplete: true });
    });
    await drainRedTeamQueue(f.options);
    expect(f.options.readPrs).toHaveBeenCalledTimes(1);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.open().entries()).toHaveLength(2);
    expect(f.options.log.mock.calls.flat().join(' ')).toContain('retry next interval');
  });
  it('shared reconciliation retains unknown evidence and removes closed or merged heads', async () => {
    const f = fixture([{ pr: 1 }, { pr: 2 }, { pr: 3 }]);
    f.readLivePr.mockImplementation(({ pr }) => pr === 1 ? null : { state: pr === 2 ? 'CLOSED' : 'MERGED' });
    await drainRedTeamQueue(f.options);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.open().entries().map(e => e.pr)).toEqual([1]);
  });
  it('repairs failed persistence after dispatch on the next empty drain without dispatching twice', async () => {
    const f = fixture();
    f.failWrite(true);
    expect((await drainRedTeamQueue(f.options)).dispatched).toBe(1);
    expect(f.queue.entries()).toEqual([]);
    expect(f.open().entries()).toHaveLength(1); // Disk still has the old head.
    f.failWrite(false);
    await drainRedTeamQueue(f.options);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.open().entries()).toEqual([]);
  });
  it('shared settlement retains an admitted entry after a null-prNumber skip and persists its retry cooldown', async () => {
    const f = fixture();
    f.run.mockReturnValue({ rows: [{ prNumber: null, action: 'skip', why: 'inputs unreadable' }] });
    await drainRedTeamQueue(f.options);
    expect(f.open().entries()[0]).toMatchObject({ pr: 1, attempts: 0, retryAt: at + 60_000 });
    f.options.queue = f.open();
    await drainRedTeamQueue(f.options);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.open().entries()[0].retryAt).toBe(at + 60_000);
  });
  it('aborts shared queue mutations when the recovery runner throws', async () => {
    const f = fixture([{ pr: 1, blocked: 'planner-skip', enqueuedAt: at }]);
    const before = f.queue.entries();
    f.run.mockImplementation(() => { throw Error('runner failed'); });
    await drainRedTeamQueue(f.options);
    expect(f.queue.entries()).toEqual(before);
    expect(f.open().entries()).toEqual(before);
  });
  it.each(['throw', 'reject', 'false'])('retries an age alert after delivery %s, then deduplicates across restart', async failure => {
    const f = fixture();
    f.options.capacity.lanes = 0;
    f.options.alert.mockImplementationOnce(() => {
      if (failure === 'throw') throw Error('delivery failed');
      return failure === 'false' ? Promise.resolve(false) : Promise.reject(Error('delivery failed'));
    });
    await drainRedTeamQueue(f.options);
    expect(f.open().entries()[0].alertedHead).toBeUndefined();
    f.options.queue = f.open();
    await drainRedTeamQueue(f.options);
    expect(f.open().entries()[0].alertedHead).toBe(head);
    f.options.queue = f.open();
    await drainRedTeamQueue(f.options);
    expect(f.options.alert).toHaveBeenCalledTimes(2);
  });
  it('does not mark an asynchronous age alert until delivery succeeds', async () => {
    const f = fixture();
    f.options.capacity.lanes = 0;
    let deliver;
    f.options.alert.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    const draining = drainRedTeamQueue(f.options);
    // Queue runner is synchronous, but the timer awaits each shared call before alerting.
    await vi.waitFor(() => expect(f.options.alert).toHaveBeenCalledTimes(1));
    expect(f.open().entries()[0].alertedHead).toBeUndefined();
    deliver();
    await draining;
    expect(f.open().entries()[0].alertedHead).toBe(head);
  });
  it('alerts only after 60 minutes and reports oldest age in its summary and log', async () => {
    const f = fixture([{ pr: 1, enqueuedAt: at - 60 * 60_000 }]);
    f.options.capacity.lanes = 0;
    await drainRedTeamQueue(f.options);
    expect(f.options.alert).not.toHaveBeenCalled();
    f.setClock(at + 1);
    expect((await drainRedTeamQueue(f.options)).oldestAgeMin).toBeGreaterThan(60);
    expect(f.options.log.mock.calls.flat().join(' ')).toContain('oldestAgeMin=60.0');
    await drainRedTeamQueue(f.options);
    expect(f.options.alert).toHaveBeenCalledTimes(1);
  });
});

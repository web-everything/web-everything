import { describe, it, expect, vi } from 'vitest';
import { createRedTeamDispatchQueue } from '../red-team-dispatch-queue.mjs';
import { drainRedTeamQueue } from '../red-team-queue-drain.mjs';

const repo = 'example/project', head = 'a'.repeat(40), at = 10_000_000;
function fixture(entries = [{ pr: 1, blocked: 'planner-skip' }]) {
  let stored = JSON.stringify(entries.map(entry => ({ repo, head, enqueuedAt: at - 61 * 60_000,
    attempts: 2, ...entry, key: `${entry.repo ?? repo}#${entry.pr}` })));
  const open = () => createRedTeamDispatchQueue({ file: 'memory', readFile: () => stored,
    writeFile: (_path, value) => { stored = value; }, rename: () => {}, unlink: () => {} });
  const queue = open();
  const runRecovery = vi.fn(({ plan }) => ({ dispatched: [{ prNumber: plan.refusals[0].prNumber }] }));
  const options = { queue, now: () => at, readLivePr: () => ({ state: 'OPEN', isDraft: false, headRefOid: head }),
    runRecovery, capacity: { minConcurrent: 3, inFlight: 0, lanes: 10, remainingStarts: 10 }, alert: vi.fn() };
  return { queue, open, runRecovery, options };
}

describe('independent red-team queue drain', () => {
  it('keeps a draft queued without admission and dispatches it once ready after restart', async () => {
    const f = fixture([{ pr: 1, blocked: 'planner-skip', enqueuedAt: at }]);
    let isDraft = true;
    f.options.readLivePr = () => ({ state: 'OPEN', headRefOid: head, isDraft });
    const before = f.open().entries();
    expect(await drainRedTeamQueue(f.options)).toMatchObject({ admitted: 0, dispatched: 0 });
    expect(f.runRecovery).not.toHaveBeenCalled();
    expect(f.open().entries()).toEqual(before);

    isDraft = false;
    expect(await drainRedTeamQueue({ ...f.options, queue: f.open() }))
      .toMatchObject({ admitted: 1, dispatched: 1 });
    expect(f.runRecovery).toHaveBeenCalledTimes(1);
    expect(f.open().entries()).toEqual([]);
  });
  it.each(['draft', 'missing', 'null', 'throw'])('retains an entry when dispatch-time draft evidence is %s', async evidence => {
    const f = fixture([{ pr: 1, blocked: 'planner-skip', enqueuedAt: at }]);
    const before = f.open().entries();
    f.options.readLivePr = vi.fn()
      .mockReturnValueOnce({ state: 'OPEN', headRefOid: head, isDraft: false })
      .mockImplementationOnce(() => {
        if (evidence === 'throw') throw new Error('unreadable');
        if (evidence === 'null') return null;
        return { state: 'OPEN', headRefOid: head, ...(evidence === 'draft' ? { isDraft: true } : {}) };
      });
    expect(await drainRedTeamQueue(f.options)).toMatchObject({ admitted: 0, dispatched: 0 });
    expect(f.options.readLivePr).toHaveBeenCalledTimes(2);
    expect(f.runRecovery).not.toHaveBeenCalled();
    expect(f.open().entries()).toEqual(before);
  });
  it('holds missing draft evidence at reconciliation without spending capacity ahead of a ready entry', async () => {
    const f = fixture([{ pr: 1, enqueuedAt: at - 200 }, { pr: 2, enqueuedAt: at - 100 }]);
    f.options.capacity.minConcurrent = 1;
    f.options.readLivePr = ({ pr }) => ({ state: 'OPEN', headRefOid: head, ...(pr === 2 ? { isDraft: false } : {}) });
    expect(await drainRedTeamQueue(f.options)).toMatchObject({ admitted: 1, dispatched: 1 });
    expect(f.runRecovery.mock.calls.map(([o]) => o.plan.refusals[0].prNumber)).toEqual([2]);
    expect(f.open().entries()).toEqual([expect.objectContaining({ pr: 1, attempts: 2 })]);
  });
  it('retries a planner-skipped entry through an already-reviewed-head recovery row and settles dispatch', async () => {
    const f = fixture();
    expect((await drainRedTeamQueue(f.options)).dispatched).toBe(1);
    expect(f.runRecovery.mock.calls[0][0].plan.refusals).toEqual([
      { kind: 'already-reviewed-head', prNumber: 1, headSha: head },
    ]);
    expect(f.open().entries()).toEqual([]);
  });
  it('admits oldest enqueuedAt first across repositories and requeue positions', async () => {
    const f = fixture([{ pr: 1, enqueuedAt: at - 100 }, { pr: 2, enqueuedAt: at - 200 },
      { pr: 3, repo: 'example/other', enqueuedAt: at - 300 }]);
    await drainRedTeamQueue(f.options);
    expect(f.runRecovery.mock.calls.map(([o]) => o.plan.refusals[0].prNumber)).toEqual([3, 2, 1]);
  });
  it('requeues a stale head with fresh attempts, age preserved and blocked cleared, including across restart', async () => {
    const f = fixture();
    f.options.readLivePr = () => ({ state: 'OPEN', isDraft: false, headRefOid: 'b'.repeat(40) });
    f.options.runRecovery = () => ({ notStarted: [{ prNumber: 1, reason: 'no review capacity left' }] });
    await drainRedTeamQueue(f.options);
    expect(f.open().entries()[0]).toMatchObject({ head: 'b'.repeat(40), attempts: 0,
      enqueuedAt: at - 61 * 60_000 });
    expect(f.open().entries()[0].blocked).toBeUndefined();
  });
  it('subtracts in-flight teams from the cap even when recovery does not mutate capacity', async () => {
    const f = fixture([{ pr: 1 }, { pr: 2 }, { pr: 3 }]);
    f.options.capacity.inFlight = 2;
    await drainRedTeamQueue(f.options);
    expect(f.runRecovery).toHaveBeenCalledTimes(1);
    expect(f.queue.entries()).toHaveLength(2);
  });
  it.each([undefined, { minConcurrent: 25, inFlight: 0, lanes: 100, remainingStarts: 100 },
    { minConcurrent: 3, lanes: 10, remainingStarts: 10 }])('holds unknown or oversized capacity for the next interval: %j', async capacity => {
    const f = fixture();
    await drainRedTeamQueue({ ...f.options, capacity });
    expect(f.runRecovery).not.toHaveBeenCalled();
    expect(f.queue.entries()).toHaveLength(1);
  });
  it('retains unreadable live PRs without attempting recovery and removes closed/merged PRs', async () => {
    const f = fixture([{ pr: 1 }, { pr: 2 }, { pr: 3 }]);
    f.options.readLivePr = ({ pr }) => pr === 1 ? null : { state: pr === 2 ? 'CLOSED' : 'MERGED' };
    await drainRedTeamQueue(f.options);
    expect(f.runRecovery).not.toHaveBeenCalled();
    expect(f.open().entries().map(e => e.pr)).toEqual([1]);
  });
  it.each(['null', 'throw', 'incomplete'])('an unknown oldest entry consumes no capacity ahead of a verified entry: %s', async evidence => {
    const f = fixture([{ pr: 1, enqueuedAt: at - 200 }, { pr: 2, enqueuedAt: at - 100 }]);
    f.options.capacity.minConcurrent = 1;
    f.options.readLivePr = ({ pr }) => {
      if (pr === 2) return { state: 'OPEN', isDraft: false, headRefOid: head };
      if (evidence === 'throw') throw new Error('live PR unreadable');
      return evidence === 'null' ? null : { state: 'OPEN' };
    };
    const summary = await drainRedTeamQueue(f.options);
    expect(summary.admitted).toBe(1);
    expect(f.runRecovery).toHaveBeenCalledTimes(1);
    expect(f.runRecovery.mock.calls[0][0].plan.refusals[0].prNumber).toBe(2);
    expect(f.open().entries()).toEqual([expect.objectContaining({ pr: 1, attempts: 2 })]);
  });
  it('reuses settlement attempt limit and persists a cooldown after failed recovery', async () => {
    const f = fixture();
    f.options.runRecovery = vi.fn(() => { throw new Error('unreadable'); });
    await drainRedTeamQueue(f.options);
    expect(f.open().entries()[0]).toMatchObject({ attempts: 0, retryAt: at + 60_000 });
    await drainRedTeamQueue({ ...f.options, queue: f.open() });
    expect(f.options.runRecovery).toHaveBeenCalledTimes(1);
    await drainRedTeamQueue({ ...f.options, queue: f.open(), now: () => at + 60_000 });
    expect(f.options.runRecovery).toHaveBeenCalledTimes(2);
  });
  it.each(['throw', 'reject', 'false'])('retries an alert after delivery %s across restart, then persists successful delivery', async failure => {
    const f = fixture();
    f.options.capacity.minConcurrent = 0;
    f.options.alert.mockImplementationOnce(() => {
      if (failure === 'throw') throw new Error('delivery failed');
      if (failure === 'false') return Promise.resolve(false);
      return Promise.reject(new Error('delivery failed'));
    });
    await drainRedTeamQueue(f.options);
    expect(f.open().entries()[0].alertedHead).toBeUndefined();
    await drainRedTeamQueue({ ...f.options, queue: f.open() });
    expect(f.open().entries()[0].alertedHead).toBe(head);
    await drainRedTeamQueue({ ...f.options, queue: f.open() });
    expect(f.options.alert).toHaveBeenCalledTimes(2);
  });
  it('does not persist the dedupe mark until asynchronous delivery succeeds', async () => {
    const f = fixture();
    f.options.capacity.minConcurrent = 0;
    let deliver;
    f.options.alert.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    const draining = drainRedTeamQueue(f.options);
    expect(f.open().entries()[0].alertedHead).toBeUndefined();
    deliver();
    await draining;
    expect(f.open().entries()[0].alertedHead).toBe(head);
  });
  it('alerts once per key/head only after 60 minutes, survives restart, and reports/logs oldest age', async () => {
    const f = fixture([{ pr: 1, enqueuedAt: at - 60 * 60_000 }]);
    f.options.capacity.minConcurrent = 0;
    const log = vi.fn();
    await drainRedTeamQueue({ ...f.options, log });
    expect(f.options.alert).not.toHaveBeenCalled();
    const result = await drainRedTeamQueue({ ...f.options, now: () => at + 1, log });
    await drainRedTeamQueue({ ...f.options, queue: f.open(), now: () => at + 2 });
    expect(f.options.alert).toHaveBeenCalledTimes(1);
    expect(result.oldestAgeMin).toBeGreaterThan(60);
    expect(log.mock.calls.flat().join(' ')).toContain('oldestAgeMin=60.0');
    await drainRedTeamQueue({ ...f.options, readLivePr: () => ({ state: 'OPEN', isDraft: false, headRefOid: 'b'.repeat(40) }), now: () => at + 3 });
    expect(f.options.alert).toHaveBeenCalledTimes(2);
  });
});

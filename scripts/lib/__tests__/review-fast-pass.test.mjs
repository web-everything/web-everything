import { describe, expect, it, vi } from 'vitest';
import { runFastPass } from '../review-fast-pass.mjs';

const head = 'a'.repeat(40);
const pr = { number: 12, state: 'OPEN', headRefOid: head, labels: ['review:pending'], statusCheckRollup: [], comments: [] };
const row = { kind: 'review', prNumber: 12, headRefOid: head };
function fixture() {
  return {
    repo: 'fixture/repo', readLastPlan: () => ({ plan: { dispatch: [row] }, rawPrs: [pr], mainSha: 'main', savedAt: 1 }),
    readPr: vi.fn(({ pending }) => pending ? [] : structuredClone(pr)),
    planOne: vi.fn(() => ({ dispatch: [row], refusals: [] })),
    readAgents: vi.fn(() => []), readJobs: vi.fn(() => []),
    dispatch: vi.fn(() => ({ mode: 'job', jobPid: 123 })),
    hostAdmission: () => ({ admitted: true, maxPerTick: 2 }), liveCap: () => 2,
    mainSha: () => 'main', log: vi.fn(), now: () => 10,
  };
}
describe('fast review admission negatives', () => {
  it.each(['operator', 'referral', 'ledger', 'review:human', 'fix-claim'])('refuses a fresh %s hold', async hold => {
    const o = fixture();
    o.planOne.mockReturnValue({ dispatch: [], refusals: [{ prNumber: 12, kind: hold }] });
    await runFastPass(o);
    expect(o.planOne).toHaveBeenCalled();
    expect(o.dispatch).not.toHaveBeenCalled();
  });
  it('refuses a head moved since the saved plan', async () => {
    const o = fixture(); o.readPr.mockImplementation(({ pending }) => pending ? [] : { ...pr, headRefOid: 'b'.repeat(40) });
    await runFastPass(o); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it('refuses a live job slot from fresh job records', async () => {
    const o = fixture(); o.readJobs.mockReturnValue([{ repo: o.repo, pr: 12, pid: 20 }]);
    await runFastPass(o); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it('refuses a live review process from the fresh re-plan', async () => {
    const o = fixture(); o.readAgents.mockReturnValue([{ pid: 20 }]);
    o.planOne.mockImplementation(({ agents }) => ({ dispatch: agents.length ? [] : [row] }));
    await runFastPass(o); expect(o.readAgents).toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it('passes through stale-clone refusal without retry or success log', async () => {
    const o = fixture(); o.dispatch.mockImplementation(() => { throw new Error('STALE code'); });
    const result = await runFastPass(o);
    expect(o.dispatch).toHaveBeenCalledTimes(1); expect(result.dispatched).toEqual([]);
    expect(result.failed[0].reason).toContain('STALE');
    expect(o.log.mock.calls.flat().some(s => s.includes('dispatched'))).toBe(false);
  });
  it('computes zero remaining capacity from live jobs, not saved plan capacity', async () => {
    const o = fixture(); o.readJobs.mockReturnValue([{ repo: 'other/repo', pr: 8 }, { repo: 'other/repo', pr: 9 }]);
    await runFastPass(o); expect(o.dispatch).not.toHaveBeenCalled();
  });
  it('skips changed main without reusing main-red facts', async () => {
    const o = fixture(); o.mainSha = () => 'changed';
    await runFastPass(o); expect(o.planOne).not.toHaveBeenCalled(); expect(o.dispatch).not.toHaveBeenCalled();
  });
});
it('dispatches with fresh expectedHead and logs repo#pr', async () => {
  const o = fixture(); const result = await runFastPass(o);
  expect(o.dispatch).toHaveBeenCalledWith(expect.objectContaining({ repo: o.repo, pr: 12, expectedHead: head }));
  expect(result.dispatched).toHaveLength(1);
  expect(o.log).toHaveBeenCalledWith(expect.stringContaining('review-fast-pass: fixture/repo#12 dispatched'));
});
it('refuses a configured cap of zero', async () => {
  const o = fixture(); o.liveCap = () => 0;
  await runFastPass(o); expect(o.dispatch).not.toHaveBeenCalled();
});
it('finds a newly pending PR outside the saved dispatch rows', async () => {
  const o = fixture(); o.readLastPlan = () => ({ plan: { dispatch: [] }, rawPrs: [], mainSha: 'main', savedAt: 1 });
  o.readPr.mockImplementation(({ pending }) => pending ? [pr] : pr);
  await runFastPass(o); expect(o.dispatch).toHaveBeenCalledTimes(1);
});
it.each(['labels', 'statusCheckRollup', 'comments'])('fails closed for unreadable %s', async field => {
  const o = fixture(); o.readPr.mockImplementation(({ pending }) => pending ? [] : { ...pr, [field]: null });
  await runFastPass(o); expect(o.dispatch).not.toHaveBeenCalled();
});
it('defers oversized inventory visibly to the normal tick', async () => {
  const o = fixture(); o.readPr.mockReturnValue(Array(101).fill(pr));
  await runFastPass(o); expect(o.dispatch).not.toHaveBeenCalled();
  expect(o.log).toHaveBeenCalledWith(expect.stringContaining('deferred to normal tick'));
});
it('does not report a refused dispatch as dispatched', async () => {
  const o = fixture(); o.dispatch.mockReturnValue({ refused: true, outcome: 'refused-head-moved' });
  expect((await runFastPass(o)).dispatched).toEqual([]);
  expect(o.dispatch).toHaveBeenCalledTimes(1);
});
it('refuses unreadable job evidence', async () => {
  const o = fixture(); o.readJobs.mockReturnValue(Object.assign([], { incomplete: ['unreadable'] }));
  await runFastPass(o); expect(o.dispatch).not.toHaveBeenCalled();
});
it('refuses host load admission', async () => {
  const o = fixture(); o.hostAdmission = () => ({ admitted: false, maxPerTick: 2 });
  await runFastPass(o); expect(o.dispatch).not.toHaveBeenCalled();
});
it('rechecks main after planning', async () => {
  const o = fixture(); o.mainSha = vi.fn().mockReturnValueOnce('main').mockReturnValue('changed');
  await runFastPass(o); expect(o.dispatch).not.toHaveBeenCalled();
});
it('does not replace a saved head with a newly labelled head', async () => {
  const o = fixture(); const moved = { ...pr, headRefOid: 'b'.repeat(40) };
  o.readLastPlan = () => ({ plan: { dispatch: [] }, rawPrs: [{ ...pr, labels: [] }], mainSha: 'main', savedAt: 1 });
  o.readPr.mockImplementation(({ pending }) => pending ? [moved] : moved);
  await runFastPass(o); expect(o.dispatch).not.toHaveBeenCalled();
});
it('rechecks a PR re-labelled pending since the snapshot', async () => {
  const o = fixture(); o.readLastPlan = () => ({ plan: { dispatch: [] }, rawPrs: [pr], mainSha: 'main', savedAt: 1 });
  o.readPr.mockImplementation(({ pending }) => pending ? [{ ...pr, updatedAt: new Date(2).toISOString() }] : pr);
  await runFastPass(o); expect(o.dispatch).toHaveBeenCalledOnce();
});
it('bounds single-PR reads to eight candidates with an operator-visible fallback', async () => {
  const o = fixture(); o.readLastPlan = () => ({ plan: { dispatch: [] }, rawPrs: [], mainSha: 'main', savedAt: 1 });
  o.readPr.mockImplementation(({ pending, pr: number }) => pending
    ? Array.from({ length: 9 }, (_, i) => ({ ...pr, number: i + 1 })) : { ...pr, number });
  await runFastPass(o);
  expect(o.readPr.mock.calls.filter(([args]) => !args.pending)).toHaveLength(8);
  expect(o.log).toHaveBeenCalledWith(expect.stringContaining('limited to 8 candidates'));
});
it('prioritizes a newly pending PR over the saved backlog within the probe bound', async () => {
  const o = fixture();
  o.readLastPlan = () => ({ plan: { dispatch: Array.from({ length: 9 }, (_, i) => ({ ...row, prNumber: i + 1 })) },
    rawPrs: [], mainSha: 'main', savedAt: 1 });
  o.readPr.mockImplementation(({ pending, pr: number }) => pending ? [{ ...pr, number: 20 }] : { ...pr, number });
  o.planOne.mockImplementation(({ pr }) => ({ dispatch: [{ ...row, prNumber: pr.number }] }));
  await runFastPass(o);
  expect(o.dispatch.mock.calls[0][0].pr).toBe(20);
});
it('rejects invalid PR numbers before a single-PR read', async () => {
  const o = fixture();
  o.readLastPlan = () => ({ plan: { dispatch: [{ ...row, prNumber: -1 }] }, rawPrs: [], mainSha: 'main', savedAt: 1 });
  await runFastPass(o);
  expect(o.readPr).toHaveBeenCalledTimes(1); expect(o.dispatch).not.toHaveBeenCalled();
});

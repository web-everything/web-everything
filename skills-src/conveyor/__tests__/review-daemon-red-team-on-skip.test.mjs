import { it, expect, vi } from 'vitest';
import { runRedTeamOnSkip } from '../../../scripts/lib/review-red-team-on-skip.mjs';
import { runReviewTick, sharedHostBudget } from '../review-daemon.mjs';

it('already-reviewed heads get one recovery hook with remaining capacity; null and paused preserve existing behavior', () => {
  const repo = 'web-everything/web-everything', head = 'a'.repeat(40);
  const rawPrs = [{ number: 5762, headRefOid: head, comments: [], labels: [] }];
  const plan = { dispatch: [], refusals: [{ kind: 'already-reviewed-head', prNumber: 5762, headSha: head }] };
  const liveReviewBudget = { left: 2 };
  const result = { rows: [], dispatched: [{ prNumber: 5762, jobPid: 42 }], notStarted: [] };
  const redTeamOnSkip = vi.fn(() => result);
  const tagStatus = vi.fn();
  const options = { repo, reconcile: () => plan, readPrs: () => rawPrs, readAgents: () => [],
    holdReconcile: () => [], acquirableLanes: () => 3, liveReviewBudget,
    tagRound: vi.fn(), tagStatus, statusCandidates: () => [{ prNumber: 5762 }], redTeamOnSkip };
  const out = runReviewTick(options);
  expect(redTeamOnSkip).toHaveBeenCalledTimes(1);
  expect(redTeamOnSkip).toHaveBeenCalledWith({ repo, plan, rawPrs,
    capacity: { lanes: 3, budget: liveReviewBudget, remainingStarts: Infinity, take: expect.any(Function) }, paused: false });
  expect(out.redTeamOnSkip).toBe(result);
  expect(tagStatus.mock.calls.at(-1)[0].agents).toBeUndefined();
  expect(runReviewTick({ ...options, redTeamOnSkip: null })).not.toHaveProperty('redTeamOnSkip');
  redTeamOnSkip.mockClear();
  expect(runReviewTick({ ...options, paused: true })).not.toHaveProperty('redTeamOnSkip');
  expect(redTeamOnSkip).not.toHaveBeenCalled();
});

function recoveryTickFixture({ ordinary = false } = {}) {
  const repo = 'web-everything/web-everything', head = 'a'.repeat(40);
  const recoveryDispatch = vi.fn(() => ({ jobPid: 42 }));
  return { recoveryDispatch, options: {
    repo, readPrs: () => [5762, 5763].map(number => ({ number, headRefOid: head, comments: [], labels: [] })),
    readAgents: () => [], holdReconcile: () => [], acquirableLanes: () => 5,
    reconcile: () => ({ dispatch: ordinary ? [{ kind: 'review', prNumber: 5764 }] : [],
      refusals: [5762, 5763].map(prNumber => ({ kind: 'already-reviewed-head', prNumber, headSha: head })) }),
    dispatch: vi.fn(() => ({ jobPid: 43 })), tagRound: vi.fn(), tagStatus: vi.fn(), statusCandidates: () => [],
    redTeamOnSkip: options => runRedTeamOnSkip({ ...options, dispatch: recoveryDispatch,
      readEvidence: () => ({ recorded: false, loopPayload: {
        verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } } }),
      readStatus: () => null, setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map() }),
  } };
}

it.each([false, true])('host denial blocks recovery starts (ordinary reviews: %s)', ordinary => {
  const { options, recoveryDispatch } = recoveryTickFixture({ ordinary });
  const take = vi.fn(), hostAdmission = vi.fn(() => ({ admitted: false, reason: 'host overloaded', take }));
  const out = runReviewTick({ ...options, hostAdmission });
  expect(hostAdmission).toHaveBeenCalledTimes(1);
  expect(options.dispatch).not.toHaveBeenCalled();
  expect(recoveryDispatch).not.toHaveBeenCalled();
  expect(out.redTeamOnSkip.dispatched).toEqual([]);
  expect(take).not.toHaveBeenCalled();
});

it('a throwing host check blocks recovery-only starts', () => {
  const { options, recoveryDispatch } = recoveryTickFixture();
  runReviewTick({ ...options, hostAdmission: () => { throw Error('host unreadable'); } });
  expect(recoveryDispatch).not.toHaveBeenCalled();
});

it('ordinary and recovery starts share maxPerTick=1', () => {
  const { options, recoveryDispatch } = recoveryTickFixture({ ordinary: true });
  const take = vi.fn();
  const out = runReviewTick({ ...options, hostAdmission: () => ({ admitted: true, maxPerTick: 1, take }) });
  expect(options.dispatch).toHaveBeenCalledTimes(1);
  expect(out.dispatched).toHaveLength(1);
  expect(recoveryDispatch).not.toHaveBeenCalled();
  expect(out.redTeamOnSkip.dispatched).toEqual([]);
  expect(take.mock.calls).toEqual([[1]]);
});

it('recovery-only starts consume the shared host budget across repos', () => {
  const { options, recoveryDispatch } = recoveryTickFixture();
  const check = vi.fn(() => ({ admitted: true, maxPerTick: 1 }));
  const hostAdmission = sharedHostBudget(check);
  const first = runReviewTick({ ...options, hostAdmission });
  const second = runReviewTick({ ...options, repo: 'web-everything/frontierui', hostAdmission });
  expect(first.redTeamOnSkip.dispatched).toHaveLength(1);
  expect(second.redTeamOnSkip.dispatched).toEqual([]);
  expect(recoveryDispatch).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledTimes(1);
  expect(hostAdmission().maxPerTick).toBe(0);
});

it('a confirmed ordinary non-start leaves the host allowance available to recovery', () => {
  const { options, recoveryDispatch } = recoveryTickFixture({ ordinary: true });
  options.dispatch.mockReturnValue({ skipped: 'lane-cooloff' });
  const take = vi.fn();
  const out = runReviewTick({ ...options, hostAdmission: () => ({ admitted: true, maxPerTick: 1, take }) });
  expect(options.dispatch).toHaveBeenCalledTimes(1);
  expect(out.dispatched).toEqual([]);
  expect(recoveryDispatch).toHaveBeenCalledTimes(1);
  expect(out.redTeamOnSkip.dispatched).toHaveLength(1);
  expect(take.mock.calls).toEqual([[1]]);
});

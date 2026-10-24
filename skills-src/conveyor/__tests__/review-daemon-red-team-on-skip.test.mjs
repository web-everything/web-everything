import { it, expect, vi } from 'vitest';
import { runReviewTick, sharedHostBudget } from '../review-daemon.mjs';
import { runRedTeamOnSkip } from '../../../scripts/lib/review-red-team-on-skip.mjs';

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
    capacity: { lanes: 3, budget: liveReviewBudget }, paused: false });
  expect(out.redTeamOnSkip).toBe(result);
  expect(tagStatus.mock.calls.at(-1)[0].agents).toBeUndefined();
  expect(runReviewTick({ ...options, redTeamOnSkip: null })).not.toHaveProperty('redTeamOnSkip');
  redTeamOnSkip.mockClear();
  expect(runReviewTick({ ...options, paused: true })).not.toHaveProperty('redTeamOnSkip');
  expect(redTeamOnSkip).not.toHaveBeenCalled();
});

const repo = 'web-everything/web-everything';
const base = (options = {}) => ({
  repo, reconcile: () => ({ dispatch: [], refusals: [] }),
  readPrs: () => [], readAgents: () => [], holdReconcile: () => [],
  acquirableLanes: () => 3, tagRound: vi.fn(), tagStatus: vi.fn(),
  statusCandidates: () => [], ...options,
});

it('host denial checks admission with no reviews and never calls recovery', () => {
  const hostAdmission = vi.fn(() => ({ admitted: false, reason: 'host memory low' }));
  const redTeamOnSkip = vi.fn();
  const out = runReviewTick(base({ hostAdmission, redTeamOnSkip }));
  expect(hostAdmission).toHaveBeenCalledTimes(1);
  expect(redTeamOnSkip).not.toHaveBeenCalled();
  expect(out).not.toHaveProperty('redTeamOnSkip');
});

it('a review spends the only host seat and leaves recovery capacity zero', () => {
  const hostAdmission = sharedHostBudget(() => ({ admitted: true, maxPerTick: 1 }));
  const dispatch = vi.fn(() => ({ jobPid: 41 }));
  const redTeamOnSkip = vi.fn(() => ({ dispatched: [] }));
  runReviewTick(base({ hostAdmission, redTeamOnSkip, dispatch,
    reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 1 }], refusals: [] }) }));
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(redTeamOnSkip.mock.calls[0][0].capacity.lanes).toBe(0);
  expect(hostAdmission().maxPerTick).toBe(0);
});

it('a recovery start spends a shared host seat while non-starts spend none', () => {
  const hostAdmission = sharedHostBudget(() => ({ admitted: true, maxPerTick: 2 }));
  const redTeamOnSkip = vi.fn(() => ({
    dispatched: [{ prNumber: 5762, jobPid: 42 }],
    notStarted: [{ prNumber: 5763, reason: 'live-job' }],
  }));
  runReviewTick(base({ hostAdmission, redTeamOnSkip }));
  expect(redTeamOnSkip.mock.calls[0][0].capacity.lanes).toBe(2);
  expect(hostAdmission().maxPerTick).toBe(1);
  const nextRecovery = vi.fn(() => ({ dispatched: [] }));
  runReviewTick(base({ repo: 'other/repo', hostAdmission, redTeamOnSkip: nextRecovery }));
  expect(nextRecovery.mock.calls[0][0].capacity.lanes).toBe(1);
  expect(hostAdmission().maxPerTick).toBe(1);
});

it('a throwing recovery dispatch spends the only shared host seat and leaves zero for a later repo', () => {
  const hostAdmission = sharedHostBudget(() => ({ admitted: true, maxPerTick: 1 }));
  const head = 'a'.repeat(40), pr = 5762;
  const dispatch = vi.fn(() => { throw Error('failed after possible spawn'); });
  const out = runReviewTick(base({ hostAdmission,
    reconcile: () => ({ dispatch: [], refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] }),
    readPrs: () => [{ number: pr, headRefOid: head, comments: [], labels: [] }],
    redTeamOnSkip: options => runRedTeamOnSkip({ ...options, dispatch,
      setting: { enabled: true, retryCooldownMin: 30, maxFreshPerHead: 2 },
      // Main's fresh-pass guard requires an explicit absence of recorded work, even in this spawn-failure fixture.
      readEvidence: () => ({ recorded: false, loopPayload: { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } } }),
      readStatus: () => null, readRecoveryRows: () => ({ verifiedRow: null, freshAttempts: 0 }),
      now: () => 2_000_000, lastDispatch: new Map(),
    }),
  }));
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(out.redTeamOnSkip.dispatched).toEqual([]);
  expect(out.redTeamOnSkip.uncertain).toEqual([{ prNumber: pr, reason: 'dispatch failed; start unknown' }]);
  expect(hostAdmission().maxPerTick).toBe(0);
  const nextRecovery = vi.fn(() => ({ dispatched: [] }));
  const nextDispatch = vi.fn();
  runReviewTick(base({ repo: 'other/repo', hostAdmission, dispatch: nextDispatch,
    reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 1 }], refusals: [] }),
    redTeamOnSkip: nextRecovery }));
  expect(nextDispatch).not.toHaveBeenCalled();
  expect(nextRecovery.mock.calls[0][0].capacity.lanes).toBe(0);
  expect(hostAdmission().maxPerTick).toBe(0);
});

it('reserves the red-team row inside the host-limited dispatch window', () => {
  const dispatch = vi.fn(() => ({ jobPid: 42 }));
  const request = { repo, pr: 9, head: 'a'.repeat(40) };
  const out = runReviewTick(base({ dispatch,
    reconcile: () => ({ dispatch: [1, 2, 3].map(prNumber => ({ kind: 'review', prNumber })), refusals: [] }),
    readPrs: () => [{ number: 9, headRefOid: request.head, isDraft: false,
      labels: ['review:accepted', 'ready-to-merge'] }],
    readRedTeamRequests: () => [request], finishRedTeamRequest: vi.fn(),
    liveReviewBudget: { left: 3 },
    hostAdmission: () => ({ admitted: true, maxPerTick: 1 }),
    redTeamSeatShare: { reserved: 1, source: 'standard' },
  }));
  expect(dispatch.mock.calls.map(([options]) => options.pr)).toEqual([9]);
  expect(dispatch.mock.calls[0][0].drainRedTeamRequest).toEqual(request);
  expect(out.dispatched).toHaveLength(1);
});

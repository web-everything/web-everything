import { it, expect, vi } from 'vitest';
import { runRedTeamOnSkip } from '../../../scripts/lib/review-red-team-on-skip.mjs';
import { cliReviewTickOpts, runReviewTick, sharedHostBudget } from '../review-daemon.mjs';
import * as reviewJob from '../../../scripts/operations/review-job.mjs';
import * as redTeamEvidence from '../../../scripts/lib/drain-red-team-evidence.mjs';
import { planReconcile } from '../../../scripts/conveyor/reconcile-core.mjs';
import { buildReviewedShaMarker } from '../../../scripts/lib/review-escalation.mjs';

it.each(['fresh', 'resume'])('CLI tick options recover an already-reviewed head in %s mode', mode => {
  const repo = 'web-everything/web-everything', head = (mode === 'fresh' ? 'c' : 'd').repeat(40), pr = 5762;
  const readEvidence = vi.spyOn(redTeamEvidence, 'readDrainRedTeamEvidence').mockReturnValue({
    recorded: mode === 'resume', loopPayload: {
      verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } },
    },
  });
  const readStatus = vi.spyOn(reviewJob, 'readRedTeamRecoveryStatus')
    .mockReturnValue(mode === 'resume' ? { status: 'finished', result: 'ran' } : null);
  const dispatch = vi.spyOn(reviewJob, 'dispatchReviewJob').mockReturnValue({ jobPid: 42 });
  vi.stubEnv('WE_REVIEW_RED_TEAM_ON_SKIP', '1');
  try {
    const production = cliReviewTickOpts({ log: { error: vi.fn() } });
    const take = vi.fn();
    const out = runReviewTick({ ...production, repo,
      readPrs: () => [{ number: pr, headRefOid: head, labels: [], comments: [] }],
      readAgents: () => [], holdReconcile: () => [], acquirableLanes: () => 1,
      liveReviewBudget: { left: 1 }, hostAdmission: () => ({ admitted: true, maxPerTick: 1, take }),
      reconcile: () => ({ dispatch: [], refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] }),
      tagRound: vi.fn(), tagStatus: vi.fn(), statusCandidates: () => [],
    });
    expect(out.redTeamOnSkip?.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode }]);
    expect(readEvidence).toHaveBeenCalledWith({ repo, pr, head });
    expect(readStatus).toHaveBeenCalledWith({ repo, pr, head });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ pr, repo, redTeamOnly: true, redTeamMode: mode });
    expect(take).toHaveBeenCalledOnce();
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it.each(['fresh', 'resume'])('real reconcile recovers a queued accepted head in %s mode', mode => {
  const repo = 'web-everything/web-everything', head = 'a'.repeat(40), pr = 5762;
  const rawPr = { number: pr, state: 'OPEN', headRefName: 'lane/accepted', headRefOid: head,
    baseRefName: 'main', mergeStateStatus: 'CLEAN',
    labels: ['review:accepted', 'ready-to-merge', 'red-team:pending'].map(name => ({ name })),
    comments: [{ body: buildReviewedShaMarker(head), author: { login: 'web-everything' } }],
    statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }] };
  const reconcile = options => planReconcile({ repo: 'we', prs: options.readPrs(), agents: [],
    reviewTiming: { startAfter: 'ci-green' }, requiredChecks: ['gate'] });
  expect(reconcile({ readPrs: () => [rawPr] }).refusals).toEqual([
    expect.objectContaining({ kind: 'nothing-owed', phase: 'queued', prNumber: pr }),
  ]);
  const dispatch = vi.fn(() => ({ jobPid: 42 }));
  const readEvidence = vi.fn(() => ({ recorded: mode === 'resume', loopPayload: {
    verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } } }));
  const out = runReviewTick({ repo, readPrs: () => [rawPr], readAgents: () => [], reconcile,
    holdReconcile: () => [], acquirableLanes: () => 1, tagRound: vi.fn(), tagStatus: vi.fn(), statusCandidates: () => [],
    redTeamOnSkip: options => runRedTeamOnSkip({ ...options, dispatch, readEvidence,
      readStatus: () => mode === 'resume' ? { status: 'finished', result: 'ran' } : null,
      setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map() }),
  });
  expect(readEvidence).toHaveBeenCalledWith({ repo, pr, head });
  expect(out.redTeamOnSkip.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode }]);
});

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

function recoveryTickFixture({ ordinary = false, queued = false } = {}) {
  const repo = 'web-everything/web-everything', head = 'a'.repeat(40);
  const recoveryDispatch = vi.fn(() => ({ jobPid: 42 }));
  return { recoveryDispatch, options: {
    repo, readPrs: () => [5762, 5763].map(number => ({ number, headRefOid: head, comments: [], labels: [] })),
    readAgents: () => [], holdReconcile: () => [], acquirableLanes: () => 5,
    reconcile: () => ({ dispatch: ordinary ? [{ kind: 'review', prNumber: 5764 }] : [],
      refusals: [5762, 5763].map(prNumber => queued
        ? { kind: 'nothing-owed', phase: 'queued', prNumber, headRefOid: head }
        : { kind: 'already-reviewed-head', prNumber, headSha: head }) }),
    dispatch: vi.fn(() => ({ jobPid: 43 })), tagRound: vi.fn(), tagStatus: vi.fn(), statusCandidates: () => [],
    redTeamOnSkip: options => runRedTeamOnSkip({ ...options, dispatch: recoveryDispatch,
      readEvidence: () => ({ recorded: false, loopPayload: {
        verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } } }),
      readStatus: () => null, setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map() }),
  } };
}

it.each([false, true].flatMap(ordinary => [false, true].map(queued => ({ ordinary, queued }))))(
  'host denial blocks recovery starts (ordinary: $ordinary, queued: $queued)', ({ ordinary, queued }) => {
  const { options, recoveryDispatch } = recoveryTickFixture({ ordinary, queued });
  const take = vi.fn(), hostAdmission = vi.fn(() => ({ admitted: false, reason: 'host overloaded', take }));
  const out = runReviewTick({ ...options, hostAdmission });
  expect(hostAdmission).toHaveBeenCalledTimes(1);
  expect(options.dispatch).not.toHaveBeenCalled();
  expect(recoveryDispatch).not.toHaveBeenCalled();
  expect(out.redTeamOnSkip.dispatched).toEqual([]);
  expect(take).not.toHaveBeenCalled();
});

it.each([
  { kind: 'nothing-owed', phase: 'open' },
  { kind: 'nothing-owed', phase: 'landed' },
  { kind: 'owed-elsewhere', phase: 'queued' },
  { kind: 'referral-hold', phase: 'queued' },
])('does not adapt $kind/$phase refusals into recovery candidates', refusal => {
  const { options, recoveryDispatch } = recoveryTickFixture();
  options.reconcile = () => ({ dispatch: [], refusals: [{ ...refusal, prNumber: 5762 }] });
  const out = runReviewTick(options);
  expect(out.redTeamOnSkip.rows).toEqual([]);
  expect(recoveryDispatch).not.toHaveBeenCalled();
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

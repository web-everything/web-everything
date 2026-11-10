import { it, expect, vi, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRedTeamOnSkip } from '../../../scripts/lib/review-red-team-on-skip.mjs';
import { cliReviewTickOpts, runReviewTick, sharedHostBudget } from '../review-daemon.mjs';
import * as reviewJob from '../../../scripts/operations/review-job.mjs';
import * as redTeamEvidence from '../../../scripts/lib/drain-red-team-evidence.mjs';
import * as resultLabelSync from '../../../scripts/lib/red-team-result-label-sync.mjs';
import * as redTeamRecovery from '../../../scripts/lib/review-red-team-on-skip.mjs';
import { planReconcile } from '../../../scripts/conveyor/reconcile-core.mjs';
import { buildReviewedShaMarker } from '../../../scripts/lib/review-escalation.mjs';

// cliReviewTickOpts keeps a module-level queue bound to the first file it sees, so every test in this
// file shares one temp queue file (never the operator's real one) and the directory is removed at the end.
const QUEUE_DIR = mkdtempSync(join(tmpdir(), 'we-rtq-test-'));
const QUEUE_FILE = join(QUEUE_DIR, 'queue.json');
afterAll(() => rmSync(QUEUE_DIR, { recursive: true, force: true }));
// A developer's exported WE_RED_TEAM_DISPATCH_QUEUE=off must not flip the tests that expect the queue.
beforeEach(() => { vi.stubEnv('WE_RED_TEAM_DISPATCH_QUEUE', 'on'); });
const readQueueFile = () => existsSync(QUEUE_FILE) ? readFileSync(QUEUE_FILE, 'utf8') : null;

/** Mocks evidence for N owed PRs (heads derived per PR) and returns the owed plan/rawPrs. */
function owedPrs(repo, prs) {
  const head = pr => String(pr).padStart(40, '0');
  vi.spyOn(resultLabelSync, 'syncResultOnHeadLabels').mockImplementation(({ rawPrs }) => ({ rawPrs }));
  vi.spyOn(redTeamEvidence, 'readDrainRedTeamEvidence').mockImplementation(({ head: rev }) => ({
    recorded: false, loopPayload: { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev } } } },
  }));
  vi.spyOn(redTeamEvidence, 'readRedTeamStatus').mockReturnValue(null);
  vi.spyOn(redTeamEvidence, 'readRecoveryWitness').mockReturnValue({ rawWriter: { parsed: null } });
  return {
    plan: { refusals: prs.map(prNumber => ({ kind: 'already-reviewed-head', prNumber, headSha: head(prNumber) })) },
    rawPrs: prs.map(number => ({ number, headRefOid: head(number), labels: [], comments: [] })),
  };
}

it('CLI routes red-team recovery through the FIFO queue: capacity 1 dispatches only the head of 3 owed PRs', () => {
  const repo = 'web-everything/web-everything';
  const { plan, rawPrs } = owedPrs(repo, [6001, 6002, 6003]);
  const dispatch = vi.spyOn(reviewJob, 'dispatchReviewJob').mockReturnValue({ jobPid: 42 });
  vi.stubEnv('WE_REVIEW_RED_TEAM_ON_SKIP', '1');
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', QUEUE_FILE);
  vi.stubEnv('WE_RED_TEAM_DISPATCH_QUEUE', 'on');
  const recovery = vi.spyOn(redTeamRecovery, 'runRedTeamOnSkip');
  try {
    const production = cliReviewTickOpts({ log: { error: vi.fn() } });
    const result = production.redTeamOnSkip({ repo, plan, rawPrs, lastDispatch: new Map(),
      capacity: { lanes: 1, budget: { left: 1 }, remainingStarts: 1, take: vi.fn() }, paused: false });
    expect(recovery.mock.calls[0][0].plan.refusals.map(row => row.prNumber)).toEqual([6001]);
    expect(recovery.mock.calls[0][0].rawPrs.map(pr => pr.number)).toEqual([6001]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ pr: 6001, repo, redTeamOnly: true, redTeamMode: 'fresh' });
    expect(result.dispatched).toEqual([{ prNumber: 6001, jobPid: 42, mode: 'fresh' }]);
    // The two held-out PRs stay queued, in FIFO order, in the persisted file.
    expect(JSON.parse(readQueueFile()).map(entry => entry.pr)).toEqual([6002, 6003]);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it.each(['off', 'OFF', ' off ', '0', 'false', 'no'])('CLI bypasses the dispatch queue when WE_RED_TEAM_DISPATCH_QUEUE=%j', value => {
  const repo = 'web-everything/web-everything';
  const { plan, rawPrs } = owedPrs(repo, [6011, 6012, 6013]);
  const dispatch = vi.spyOn(reviewJob, 'dispatchReviewJob').mockReturnValue({ jobPid: 42 });
  vi.stubEnv('WE_REVIEW_RED_TEAM_ON_SKIP', '1');
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', QUEUE_FILE);
  vi.stubEnv('WE_RED_TEAM_DISPATCH_QUEUE', value);
  const recovery = vi.spyOn(redTeamRecovery, 'runRedTeamOnSkip');
  const lines = [];
  const queueBefore = readQueueFile();
  try {
    const production = cliReviewTickOpts({ log: { error: line => lines.push(line) } });
    production.redTeamOnSkip({ repo, plan, rawPrs, lastDispatch: new Map(),
      capacity: { lanes: 3, budget: { left: 3 }, remainingStarts: 3, take: vi.fn() }, paused: false });
    // Direct runner: the full unfiltered plan and PRs, no queue filtering, no queue file IO.
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(recovery.mock.calls[0][0].plan).toBe(plan);
    expect(recovery.mock.calls[0][0].rawPrs.map(pr => pr.number)).toEqual([6011, 6012, 6013]);
    expect(dispatch.mock.calls.map(call => call[0].pr)).toEqual([6011, 6012, 6013]);
    expect(readQueueFile()).toBe(queueBefore);
    expect(lines.some(line => line.includes('red-team queue') && line.includes('off') && line.includes('WE_RED_TEAM_DISPATCH_QUEUE'))).toBe(true);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it('CLI keeps the queue on and logs when WE_RED_TEAM_DISPATCH_QUEUE is unrecognised', () => {
  const repo = 'web-everything/web-everything';
  const { plan, rawPrs } = owedPrs(repo, [6031, 6032]);
  const dispatch = vi.spyOn(reviewJob, 'dispatchReviewJob').mockReturnValue({ jobPid: 42 });
  vi.stubEnv('WE_REVIEW_RED_TEAM_ON_SKIP', '1');
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', QUEUE_FILE);
  vi.stubEnv('WE_RED_TEAM_DISPATCH_QUEUE', 'maybe');
  const lines = [];
  try {
    const production = cliReviewTickOpts({ log: { error: line => lines.push(line) } });
    production.redTeamOnSkip({ repo, plan, rawPrs, lastDispatch: new Map(),
      capacity: { lanes: 1, budget: { left: 1 }, remainingStarts: 1, take: vi.fn() }, paused: false });
    expect(dispatch.mock.calls.map(call => call[0].pr)).toEqual([6031]);
    expect(lines.some(line => line.includes('unrecognised WE_RED_TEAM_DISPATCH_QUEUE'))).toBe(true);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it('CLI exhausted capacity passes every owed PR to the real runner without spending retry state', () => {
  const repo = 'web-everything/web-everything';
  const { plan, rawPrs } = owedPrs(repo, [6021, 6022]);
  const dispatch = vi.spyOn(reviewJob, 'dispatchReviewJob').mockReturnValue({ jobPid: 42 });
  vi.stubEnv('WE_REVIEW_RED_TEAM_ON_SKIP', '1');
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', QUEUE_FILE);
  vi.stubEnv('WE_RED_TEAM_DISPATCH_QUEUE', 'on');
  const recovery = vi.spyOn(redTeamRecovery, 'runRedTeamOnSkip');
  const lastDispatch = new Map();
  try {
    const production = cliReviewTickOpts({ log: { error: vi.fn() } });
    const result = production.redTeamOnSkip({ repo, plan, rawPrs, lastDispatch,
      capacity: { lanes: 0, budget: { left: 0 }, remainingStarts: 0, take: vi.fn() }, paused: false });
    expect(recovery.mock.calls[0][0].plan.refusals.map(row => row.prNumber)).toEqual([6021, 6022]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(lastDispatch.size).toBe(0);
    expect(result.dispatched).toEqual([]);
    expect(result.rows.filter(row => row.why === 'no review capacity left').map(row => row.prNumber)).toEqual([6021, 6022]);
    // Queue attempts are untouched too: "no review capacity left" is not a failed attempt.
    expect(JSON.parse(readQueueFile()).map(entry => [entry.pr, entry.attempts])).toEqual([[6021, 0], [6022, 0]]);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it('CLI label repair exception preserves original PRs and still dispatches red-team recovery', () => {
  const repo = 'web-everything/web-everything', head = 'e'.repeat(40), pr = 5762;
  const rawPrs = [{ number: pr, headRefOid: head, labels: [], comments: [] }];
  const plan = { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] };
  const before = structuredClone(rawPrs);
  const sync = vi.spyOn(resultLabelSync, 'syncResultOnHeadLabels').mockImplementation(() => {
    throw new Error('injected label repair exception');
  });
  const recovery = vi.spyOn(redTeamRecovery, 'runRedTeamOnSkip');
  vi.spyOn(redTeamEvidence, 'readDrainRedTeamEvidence').mockReturnValue({
    recorded: false, loopPayload: {
      verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } },
    },
  });
  vi.spyOn(redTeamEvidence, 'readRedTeamStatus').mockReturnValue(null);
  vi.spyOn(redTeamEvidence, 'readRecoveryWitness').mockReturnValue({ rawWriter: { parsed: null } });
  const dispatch = vi.spyOn(reviewJob, 'dispatchReviewJob').mockReturnValue({ jobPid: 42 });
  vi.stubEnv('WE_REVIEW_RED_TEAM_ON_SKIP', '1');
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', QUEUE_FILE);
  try {
    const production = cliReviewTickOpts({ log: { error: vi.fn() } });
    const result = production.redTeamOnSkip({ repo, plan, rawPrs, lastDispatch: new Map(),
      capacity: { lanes: 1, budget: { left: 1 }, remainingStarts: 1, take: vi.fn() }, paused: false });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith({ repo, refusals: plan.refusals, rawPrs, log: expect.any(Function) });
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(recovery.mock.calls[0][0].rawPrs).toBe(rawPrs);
    expect(sync.mock.invocationCallOrder[0]).toBeLessThan(recovery.mock.invocationCallOrder[0]);
    expect(rawPrs).toEqual(before);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ pr, repo, redTeamOnly: true, redTeamMode: 'fresh' });
    expect(result.dispatched).toEqual([{ prNumber: pr, jobPid: 42, mode: 'fresh' }]);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it.each(['fresh', 'resume'])('CLI tick options recover an already-reviewed head in %s mode', mode => {
  const repo = 'web-everything/web-everything', head = (mode === 'fresh' ? 'c' : 'd').repeat(40), pr = 5762;
  const readEvidence = vi.spyOn(redTeamEvidence, 'readDrainRedTeamEvidence').mockReturnValue({
    recorded: mode === 'resume', seatRecorded: mode === 'resume', completedRecorded: mode === 'resume', loopPayload: {
      verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } },
    },
  });
  const readStatus = vi.spyOn(redTeamEvidence, 'readRedTeamStatus')
    .mockReturnValue(mode === 'resume' ? { status: 'finished', result: 'ran' } : null);
  const witness = vi.spyOn(redTeamEvidence, 'readRecoveryWitness').mockReturnValue({ rawWriter: { parsed: null } });
  const dispatch = vi.spyOn(reviewJob, 'dispatchReviewJob').mockReturnValue({ jobPid: 42 });
  vi.stubEnv('WE_REVIEW_RED_TEAM_ON_SKIP', '1');
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', QUEUE_FILE);
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
  const readEvidence = vi.fn(() => ({ recorded: mode === 'resume', seatRecorded: mode === 'resume', completedRecorded: mode === 'resume', loopPayload: {
    verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } } }));
  const out = runReviewTick({ repo, readPrs: () => [rawPr], readAgents: () => [], reconcile,
    holdReconcile: () => [], acquirableLanes: () => 1, tagRound: vi.fn(), tagStatus: vi.fn(), statusCandidates: () => [],
    redTeamOnSkip: options => runRedTeamOnSkip({ ...options, dispatch, readEvidence, readReviews: () => [],
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

it.each([
  { recorded: true },
  { recorded: true, seatRecorded: true, completedRecorded: false },
])('legacy completion strings cannot resume without a completed seat: %j', evidence => {
  const { options, recoveryDispatch } = recoveryTickFixture();
  for (const result of ['ran', 'resumed']) {
    const out = runReviewTick({ ...options,
      redTeamOnSkip: input => runRedTeamOnSkip({ ...input, dispatch: recoveryDispatch,
        readEvidence: () => ({ ...evidence, loopPayload: { verdict: { verdict: 'accept' },
          findings: { read: { netBasis: { rev: 'a'.repeat(40) } } } } }),
        readStatus: () => ({ status: 'finished', result }),
        setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map() }),
    });
    expect(out.redTeamOnSkip.rows).toHaveLength(2);
    expect(out.redTeamOnSkip.dispatched).toEqual([]);
  }
  expect(recoveryDispatch).not.toHaveBeenCalled();
});

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

import { applyRedTeamGate, createRedTeamGateIo } from '../../../scripts/operations/red-team-gate-apply.mjs';
import { repoProfile } from '../../../scripts/lib/repo-profile.mjs';
import * as preventionLanding from '../../../scripts/lib/prevention-landing-job.mjs';
import { it, expect, vi, afterAll, beforeEach } from 'vitest';
// The host operator store (~/.claude/operator-overrides.json) outranks env, so a developer's live
// redTeamQueue override would leak into these fixtures; read a missing store instead (= no overrides).
const operatorFixture = vi.hoisted(() => ({ file: `/nonexistent-operator-store-${process.pid}-${Date.now()}.json` }));
vi.mock('../../../scripts/lib/operator-override-reader.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readOperatorOverrides: options => actual.readOperatorOverrides({ ...options, file: options?.file ?? operatorFixture.file }) };
});
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRedTeamOnSkip } from '../../../scripts/lib/review-red-team-on-skip.mjs';
import { cliReviewTickOpts, defaultReviewHostAdmission, runReviewTick, sharedHostBudget } from '../review-daemon.mjs';
import * as reviewJob from '../../../scripts/operations/review-job.mjs';
import * as redTeamEvidence from '../../../scripts/lib/drain-red-team-evidence.mjs';
import * as resultLabelSync from '../../../scripts/lib/red-team-result-label-sync.mjs';
import * as gateCatchUp from '../../../scripts/lib/red-team-gate-catchup.mjs';
import * as redTeamRecovery from '../../../scripts/lib/review-red-team-on-skip.mjs';
import * as repoProfiles from '../../../scripts/lib/repo-profile.mjs';
import * as hostSample from '../../../scripts/lib/host-sample.mjs';
import * as operatorOverrideReader from '../../../scripts/lib/operator-override-reader.mjs';
import { planReconcile } from '../../../scripts/conveyor/reconcile-core.mjs';
import { buildReviewedShaMarker } from '../../../scripts/lib/review-escalation.mjs';

// cliReviewTickOpts keeps a module-level queue bound to the first file it sees, so every test in this
// file shares one temp queue file (never the operator's real one) and the directory is removed at the end.
const QUEUE_DIR = mkdtempSync(join(tmpdir(), 'we-rtq-test-'));
const QUEUE_FILE = join(QUEUE_DIR, 'queue.json');
afterAll(() => rmSync(QUEUE_DIR, { recursive: true, force: true }));
// A developer's exported WE_RED_TEAM_DISPATCH_QUEUE=off must not flip the tests that expect the queue.
beforeEach(() => {
  vi.stubEnv('WE_RED_TEAM_DISPATCH_QUEUE', 'on');
  vi.stubEnv('WE_RED_TEAM_QUEUE_MIN_CONCURRENT', '2');
  vi.stubEnv('WE_RED_TEAM_QUEUE_MIN_CONCURRENT_IDLE_PCT', '10');
  vi.spyOn(hostSample, 'sampleHost').mockReturnValue({ idlePct: 0 });
  // Hermetic: the host's real operator overrides (e.g. redTeamQueue.minConcurrent) must not raise the pinned floor.
  vi.spyOn(operatorOverrideReader, 'readOperatorOverrides').mockReturnValue({ readable: true, values: {} });
});
const readQueueFile = () => existsSync(QUEUE_FILE) ? readFileSync(QUEUE_FILE, 'utf8') : null;

function livePrReader(rawPrs) {
  const heads = new Map(rawPrs.map(({ number, headRefOid }) => [number, headRefOid]));
  // Retire entries left in the shared queue by earlier fixtures.
  return ({ pr }) => heads.has(pr) ? { state: 'OPEN', comments: [], headRefOid: heads.get(pr) } : { state: 'CLOSED' };
}

it('CLI catches up gates after label repair, before capacity recovery, and survives catch-up exceptions', () => {
  const repo = 'frontier-ui/frontierui', rawPrs = [], repaired = [], refusals = [];
  vi.spyOn(repoProfiles, 'repoProfile').mockReturnValue({ checkoutPath: 'subject-checkout' });
  const order = [];
  vi.spyOn(resultLabelSync, 'syncResultOnHeadLabels').mockImplementation(() => {
    order.push('labels'); return { rawPrs: repaired };
  });
  const catchUp = vi.spyOn(gateCatchUp, 'runGateCatchUp').mockImplementation(() => {
    order.push('gate'); throw Error('catch-up failure');
  });
  vi.spyOn(redTeamRecovery, 'runRedTeamOnSkip').mockImplementation(() => {
    order.push('capacity'); return { dispatched: [] };
  });
  vi.stubEnv('WE_RED_TEAM_DISPATCH_QUEUE', 'off');
  try {
    const production = cliReviewTickOpts({ readLivePr: livePrReader(rawPrs), log: { error: vi.fn() } });
    const input = { repo, rawPrs, plan: { refusals } };
    expect(() => production.redTeamOnSkip(input)).not.toThrow();
    expect(order).toEqual(['labels', 'gate', 'capacity']);
    expect(redTeamRecovery.runRedTeamOnSkip).toHaveBeenCalledWith(expect.objectContaining({ repo, cwd: 'subject-checkout' }));
    const history = catchUp.mock.calls[0][0].history;
    expect(catchUp).toHaveBeenCalledWith({ repo, refusals, rawPrs: repaired, history, resolveProfile: undefined, log: expect.any(Function) });
    production.redTeamOnSkip(input);
    expect(catchUp.mock.calls[1][0].history).toBe(history);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

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
    const production = cliReviewTickOpts({ readLivePr: livePrReader(rawPrs), log: { error: vi.fn() } });
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
    const production = cliReviewTickOpts({ readLivePr: livePrReader(rawPrs), log: { error: line => lines.push(line) } });
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
    const production = cliReviewTickOpts({ readLivePr: livePrReader(rawPrs), log: { error: line => lines.push(line) } });
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
    const production = cliReviewTickOpts({ readLivePr: livePrReader(rawPrs), log: { error: vi.fn() } });
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
    const production = cliReviewTickOpts({ readLivePr: livePrReader(rawPrs), log: { error: vi.fn() } });
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
    const production = cliReviewTickOpts({ readLivePr: livePrReader([{ number: pr, headRefOid: head }]), log: { error: vi.fn() } });
    const take = vi.fn();
    const out = runReviewTick({ ...production, repo,
      readPrs: () => [{ number: pr, headRefOid: head, labels: [], comments: [] }],
      // Production wires a separate (unhalved) recovery lane reader; pin both seams so the fixture never reads the real pool.
      readAgents: () => [], holdReconcile: () => [], acquirableLanes: () => 1, recoveryAcquirableLanes: () => 1,
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
    capacity: { lanes: 3, budget: liveReviewBudget, remainingStarts: Infinity, startsCeiling: Infinity, take: expect.any(Function) }, paused: false, resolveProfile: expect.any(Function) });
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

it.each([38, 5, 'throws'])('CLI queue uses the shared CPU sample (%s) and preserves lane/budget bounds', idle => {
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', QUEUE_FILE);
  vi.spyOn(hostSample, 'sampleHost').mockImplementation(() => {
    if (idle === 'throws') throw new Error('sample unavailable');
    return { idlePct: idle };
  });
  vi.spyOn(resultLabelSync, 'syncResultOnHeadLabels').mockImplementation(o => ({ rawPrs: o.rawPrs }));
  const recovery = vi.spyOn(redTeamRecovery, 'runRedTeamOnSkip')
    .mockReturnValue({ rows: [], dispatched: [], notStarted: [] });
  const capacity = { lanes: 4, startsCeiling: 3, remainingStarts: 1, budget: { left: 3 } };
  const budget = capacity.budget;
  try {
    cliReviewTickOpts({ readLivePr: livePrReader([]), log: { error: vi.fn() } }).redTeamOnSkip({
      repo: 'fixture/cpu-floor', plan: { refusals: [] }, rawPrs: [], capacity,
    });
    expect(hostSample.sampleHost).toHaveBeenCalledOnce();
    expect(recovery.mock.calls[0][0].capacity).toBe(capacity);
    expect(capacity).toEqual({ lanes: 4, startsCeiling: 3, remainingStarts: idle === 38 ? 2 : 1, budget: { left: 3 } });
    expect(capacity.budget).toBe(budget);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it.each([
  ['host denied', false, 2, 0, 0],
  ['maxPerTick 1 exhausted by ordinary review', true, 1, 1, 0],
  ['maxPerTick 2 always reserves ordinary start', true, 2, 1, 1],
  ['maxPerTick 3 with recovery reserve', true, 3, 1, 2],
])('production queue floor at idle 100 respects %s', (_name, admitted, maxPerTick, ordinaryStarts, recoveryStarts) => {
  const { options } = recoveryTickFixture({ ordinary: true });
  const { plan, rawPrs } = owedPrs(options.repo, [6101, 6102, 6103]);
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', QUEUE_FILE);
  vi.stubEnv('WE_REVIEW_RED_TEAM_ON_SKIP', '1');
  vi.spyOn(hostSample, 'sampleHost').mockReturnValue({ idlePct: 100 });
  const dispatch = vi.spyOn(reviewJob, 'dispatchReviewJob').mockReturnValue({ jobPid: 42 });
  const take = vi.fn();
  try {
    const production = cliReviewTickOpts({ readLivePr: livePrReader(rawPrs), log: { error: vi.fn() } });
    const out = runReviewTick({ ...options, redTeamOnSkip: production.redTeamOnSkip,
      readPrs: () => rawPrs,
      reconcile: () => ({ ...plan, dispatch: [{ kind: 'review', prNumber: 6104 }] }),
      liveReviewBudget: { left: 5 }, hostAdmission: () => ({ admitted, maxPerTick, take }),
    });
    expect(hostSample.sampleHost).toHaveBeenCalledOnce();
    expect(options.dispatch).toHaveBeenCalledTimes(ordinaryStarts);
    expect(out.dispatched).toHaveLength(ordinaryStarts);
    expect(dispatch).toHaveBeenCalledTimes(recoveryStarts);
    expect(out.redTeamOnSkip.dispatched).toHaveLength(recoveryStarts);
    expect(take.mock.calls).toEqual(Array.from({ length: ordinaryStarts + recoveryStarts }, () => [1]));
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it('production queue floor at idle 100 cannot replenish the shared host allowance across repos', () => {
  const { options } = recoveryTickFixture();
  const { plan, rawPrs } = owedPrs(options.repo, [6111, 6112, 6113]);
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', QUEUE_FILE);
  vi.stubEnv('WE_REVIEW_RED_TEAM_ON_SKIP', '1');
  vi.spyOn(hostSample, 'sampleHost').mockReturnValue({ idlePct: 100 });
  const dispatch = vi.spyOn(reviewJob, 'dispatchReviewJob').mockReturnValue({ jobPid: 42 });
  const check = vi.fn(() => ({ admitted: true, maxPerTick: 1 }));
  const hostAdmission = sharedHostBudget(check);
  try {
    const production = cliReviewTickOpts({ readLivePr: livePrReader(rawPrs), log: { error: vi.fn() } });
    const tickOptions = { ...options, redTeamOnSkip: production.redTeamOnSkip,
      readPrs: () => rawPrs, reconcile: () => ({ ...plan, dispatch: [] }),
      liveReviewBudget: { left: 5 }, hostAdmission,
    };
    const first = runReviewTick(tickOptions);
    const second = runReviewTick({ ...tickOptions, repo: 'frontier-ui/frontierui' });
    expect(first.redTeamOnSkip.dispatched).toHaveLength(1);
    expect(second.redTeamOnSkip.dispatched).toEqual([]);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledOnce();
    expect(hostAdmission().maxPerTick).toBe(0);
    expect(hostSample.sampleHost).toHaveBeenCalledTimes(2);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
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
  const second = runReviewTick({ ...options, repo: 'frontier-ui/frontierui', hostAdmission });
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


it.each([[10, 2], [9, 1]])('production admission at idle %s starts %s recovery reviews and one ordinary review', (idlePct, recoveryStarts) => {
  const { options } = recoveryTickFixture({ ordinary: true });
  const { plan, rawPrs } = owedPrs(options.repo, [6201, 6202, 6203]);
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', QUEUE_FILE);
  vi.stubEnv('WE_REVIEW_RED_TEAM_ON_SKIP', '1');
  vi.stubEnv('WE_RED_TEAM_QUEUE_REVIEW_STARTS_WHILE_IDLE', '3');
  vi.spyOn(hostSample, 'sampleHost').mockReturnValue({ idlePct });
  const dispatch = vi.spyOn(reviewJob, 'dispatchReviewJob').mockReturnValue({ jobPid: 42 });
  try {
    const production = cliReviewTickOpts({ readLivePr: livePrReader(rawPrs), log: { error: vi.fn() } });
    const out = runReviewTick({ ...options, redTeamOnSkip: production.redTeamOnSkip,
      readPrs: () => rawPrs, reconcile: () => ({ ...plan, dispatch: [{ kind: 'review', prNumber: 6204 }] }),
      liveReviewBudget: { left: 5 }, hostAdmission: () => defaultReviewHostAdmission({
        loadPolicy: () => ({ settings: { host: { maxReviewDispatchPerTick: 2 } } }),
        admission: () => ({ admitted: true }), log: vi.fn(),
      }),
    });
    expect(options.dispatch).toHaveBeenCalledOnce();
    expect(out.dispatched).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(recoveryStarts);
    expect(out.redTeamOnSkip.dispatched).toHaveLength(recoveryStarts);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});


it.each(['on', 'off'])('capability-disabled tick still enforces overdue send-backs and gates without starting reviews (queue %s)', queue => {
  const repo = 'fixture/capability';
  const { plan, rawPrs } = owedPrs(repo, [9601, 9602]);
  const head = rawPrs[0].headRefOid;
  rawPrs[0].comments = [{
    body: `<!-- we:red-team-advisory pr=9601 rev=${head} -->\n1. [**confirmed**] (edge-case, broken) \`scripts/x.mjs:1\` — confirmed break`,
    createdAt: '2026-11-14T16:00:00Z', author: { login: 'web-everything' },
  }];
  const realCatchUp = gateCatchUp.runGateCatchUp;
  const enforceSendBack = vi.fn(() => ({ status: 'applied' }));
  const catchUp = vi.spyOn(gateCatchUp, 'runGateCatchUp').mockImplementation(options => realCatchUp({
    ...options, now: Date.parse('2026-11-14T16:20:00Z'), history: new Map(),
    setting: { broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' },
    readGrantScope: () => null, runGate: enforceSendBack,
  }));
  const start = vi.spyOn(reviewJob, 'dispatchReviewJob').mockReturnValue({ jobPid: 42 });
  const ordinary = vi.fn();
  vi.stubEnv('WE_REVIEW_RED_TEAM_ON_SKIP', '1');
  vi.stubEnv('WE_RED_TEAM_DISPATCH_QUEUE', queue);
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', QUEUE_FILE);
  try {
    const production = cliReviewTickOpts({ readLivePr: livePrReader(rawPrs), log: { error: vi.fn() }, listCommands: () => '' });
    const out = runReviewTick({ repo,
      resolveProfile: () => ({ capabilities: { review: false } }),
      reconcile: () => ({ ...plan, dispatch: [] }),
      readPrs: () => rawPrs, readAgents: () => [],
      dispatch: ordinary, redTeamOnSkip: production.redTeamOnSkip,
      acquirableLanes: () => 2, hostAdmission: () => ({ admitted: true, maxPerTick: 2 }),
      tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], holdReconcile: () => [],
    });
    expect(catchUp).toHaveBeenCalledOnce();
    expect(enforceSendBack).toHaveBeenCalledOnce();
    expect(enforceSendBack).toHaveBeenCalledWith({ repo, pr: 9601 });
    expect(out.redTeamOnSkip.dispatched).toEqual([]);
    expect(out.redTeamOnSkip.notStarted).toContainEqual({ prNumber: 9602, reason: expect.stringContaining('capability unavailable') });
    expect(start).not.toHaveBeenCalled();
    expect(ordinary).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it.each(['on', 'off'].flatMap(queue => [repoProfile('longshore').slug, 'unknown/repo'].map(repo => [queue, repo])))(
  'mixed catch-up sends back before refusing card work (queue %s, repo %s)', async (queue, repo) => {
  const { plan, rawPrs } = owedPrs(repo, [9701]);
  const head = rawPrs[0].headRefOid;
  rawPrs[0].comments = [{
    body: `<!-- we:red-team-advisory pr=9701 rev=${head} -->\n1. [**confirmed**] (edge-case, broken) \`scripts/x.mjs:1\` — confirmed break\n2. [**confirmed**] (edge-case, degraded) \`scripts/y.mjs:1\` — degradation`,
    createdAt: '2026-11-14T16:00:00Z', author: { login: 'web-everything' },
  }];
  const realCatchUp = gateCatchUp.runGateCatchUp;
  const comments = rawPrs[0].comments, history = new Map();
  const sendBack = vi.fn(() => ({ ok: true }));
  const start = vi.spyOn(preventionLanding, 'spawnPreventionLandingJob');
  const fileCard = vi.fn(createRedTeamGateIo().fileCard);
  let applied;
  const runGate = vi.fn(input => {
    applied = applyRedTeamGate(input, {
      readPr: () => ({ headRefOid: head, comments, labels: [] }),
      readSetting: () => ({ value: { broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' } }),
      readRound: () => 1, readHead: () => head, sendBack, fileCard,
      appendSendBackEvent: () => {}, dequeueSentBack: () => {},
      postComment: ({ body }) => comments.push({ body, author: { login: 'web-everything' } }), log: () => {},
    });
    return { status: 'applied' };
  });
  vi.spyOn(gateCatchUp, 'runGateCatchUp').mockImplementation(options => realCatchUp({
    ...options, now: Date.parse('2026-11-14T16:20:00Z'), history,
    setting: { broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' },
    readGrantScope: () => null, runGate,
  }));
  vi.stubEnv('WE_RED_TEAM_DISPATCH_QUEUE', queue);
  const log = vi.fn();
  try {
    const production = cliReviewTickOpts({ log: { error: log }, listCommands: () => '' });
    const input = { repo, plan, rawPrs, resolveProfile: () => ({ capabilities: { review: false } }), paused: true };
    production.redTeamOnSkip(input);
    expect(runGate).toHaveBeenCalledOnce();
    expect(await applied).toMatchObject({ status: 'card-failed', outcome: 'sent-back', error: expect.stringContaining('capability unavailable') });
    expect(sendBack).toHaveBeenCalledOnce();
    expect(fileCard).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(comments.at(-1).body).toContain('outcome=sent-back');
    production.redTeamOnSkip(input);
    expect(runGate).toHaveBeenCalledOnce();
    expect(sendBack).toHaveBeenCalledOnce();
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

it('live gate refuses prevention work for an unsupported repo even if the tick snapshot missed its card findings', () => {
  const start = vi.spyOn(preventionLanding, 'spawnPreventionLandingJob');
  try {
    expect(createRedTeamGateIo().fileCard({ repo: 'fixture/capability' }))
      .toEqual({ ok: false, error: expect.stringContaining('capability unavailable') });
    expect(start).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});

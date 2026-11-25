import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dispatchReviewByMode, dispatchReviewJob, runReviewJob, runReviewJobCli } from '../review-job.mjs';
import { dispatchReview } from '../review-dispatch.mjs';
import { createLandAdvanceApplier } from '../land-advance-io.mjs';
import { planLandAdvance } from '../land-advance.mjs';

const head = 'a'.repeat(40), repo = 'web-everything/web-everything', pr = 10;
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'review-expected-head-'));
  roots.push(dir);
  const io = {
    root: '/daemon', now: () => 1000, liveHead: vi.fn(() => head), newActorId: () => 'actor',
    claim: vi.fn(() => ({ ok: true })), readPrevCompletion: () => null,
    acquireLane: vi.fn(() => ({ lanePath: '/lanes/lane-7' })), updateRecord: vi.fn(),
    prepareLane: () => ({ head }), releaseLane: vi.fn(), unclaim: vi.fn(), log: vi.fn(),
    readRedTeamOnlyPayload: () => ({ head, loopPayload: { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } } }),
    fetchRedTeamHead: () => ({ head }), redTeamStatus: vi.fn(), clearRedTeamQueued: vi.fn(),
    runRedTeam: vi.fn(() => ({ status: 'ran', findings: [], comment: { status: 'posted' } })),
    runRedTeamGate: () => ({ status: 'ok', outcome: 'advisory' }),
  };
  const options = { pr, repo, expectedHead: head, redTeamOnly: true, root: '/daemon', dir, io,
    checkStaleness: () => ({ fresh: true, behind: 0 }), readCompletion: () => null,
    resolveSettingsEnv: () => ({}), spawnJob: vi.fn(() => 4242) };
  return { io, options };
}
const refused = { refused: true, outcome: 'refused-head-moved' };
function sessionFixture(wrapReview) {
  const { io, options } = fixture();
  return { io, options: { ...options, mode: 'session', wrapReview,
    stackCheck: vi.fn(() => ({ base: null })),
    ciGate: vi.fn(() => ({ allowed: true })), readBrief: vi.fn(() => 'review'),
    ensureSessionCwd: vi.fn(() => '/session'), isolateSession: () => ({}),
    spawnAgent: vi.fn(() => 'backgrounded · session-id · review'),
    launchWrapped: vi.fn(() => ({ handle: 'session-id' })),
  } };
}
describe.each([
  ['mode router', dispatchReviewByMode], ['direct dispatcher', dispatchReview],
])('%s', (_entry, dispatch) => {
describe.each([false, true])('session review head admission (wrapped=%s)', wrapReview => {
  it.each([
    ['missing expected head', undefined, head, 'refused-no-expected-head'],
    ['null expected head', null, head, 'refused-head-moved'],
    ['malformed expected head', 'bad', head, 'refused-head-moved'],
    ['oversized expected head', 'a'.repeat(41), head, 'refused-head-moved'],
    ['matching newline suffixes', `${head}\n`, `${head}\n`, 'refused-head-moved'],
    ['matching carriage return suffixes', `${head}\r`, `${head}\r`, 'refused-head-moved'],
    ['matching Unicode line separator suffixes', `${head}\u2028`, `${head}\u2028`, 'refused-head-moved'],
    ['moved head', head, 'b'.repeat(40), 'refused-head-moved'],
    ['missing live head', head, null, 'refused-head-moved'],
    ['malformed live head', head, 'bad', 'refused-head-moved'],
    ['throwing live head', head, 'throws', 'refused-head-moved'],
  ])('%s refuses before stack, CI, session setup, or spawn', (_name, expectedHead, liveHead, outcome) => {
    const { io, options } = sessionFixture(wrapReview);
    io.liveHead.mockImplementation(() => { if (liveHead === 'throws') throw Error('unreadable'); return liveHead; });
    const result = dispatch({ ...options, expectedHead });
    expect(result).toMatchObject({ refused: true, outcome });
    expect(options.stackCheck).not.toHaveBeenCalled();
    expect(options.ciGate).not.toHaveBeenCalled();
    expect(options.readBrief).not.toHaveBeenCalled();
    expect(options.ensureSessionCwd).not.toHaveBeenCalled();
    expect(options.spawnAgent).not.toHaveBeenCalled();
    expect(options.launchWrapped).not.toHaveBeenCalled();
  });
  it('matching 40-hex head admits exactly one session (case insensitive)', () => {
    const { io, options } = sessionFixture(wrapReview);
    const result = dispatch({ ...options, expectedHead: head.toUpperCase() });
    expect(result).toMatchObject({ pr, repo, agentId: 'session-id' });
    if (dispatch === dispatchReviewByMode) expect(result.mode).toBe('session');
    expect(io.liveHead).toHaveBeenCalledWith({ pr, repo });
    expect(wrapReview ? options.launchWrapped : options.spawnAgent).toHaveBeenCalledTimes(1);
    expect(wrapReview ? options.spawnAgent : options.launchWrapped).not.toHaveBeenCalled();
  });
  it('absent live-head reader fails closed', () => {
    const { io, options } = sessionFixture(wrapReview);
    delete io.liveHead;
    expect(dispatch(options)).toMatchObject(refused);
    expect(options.spawnAgent).not.toHaveBeenCalled();
    expect(options.launchWrapped).not.toHaveBeenCalled();
  });
  it('environment-selected session mode uses the same admission', () => {
    const { io, options } = sessionFixture(wrapReview);
    const previous = process.env.WE_REVIEW_DISPATCH_MODE;
    try {
      process.env.WE_REVIEW_DISPATCH_MODE = 'session';
      delete options.mode;
      io.liveHead.mockReturnValue('b'.repeat(40));
      expect(dispatchReviewByMode(options)).toMatchObject(refused);
      expect(options.spawnAgent).not.toHaveBeenCalled();
      expect(options.launchWrapped).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.WE_REVIEW_DISPATCH_MODE;
      else process.env.WE_REVIEW_DISPATCH_MODE = previous;
    }
  });
});
});
it('session admission rechecks the head after stack inspection', () => {
  const { io, options } = sessionFixture(false);
  options.stackCheck.mockImplementation(() => { io.liveHead.mockReturnValue('b'.repeat(40)); return { base: null }; });
  expect(dispatchReviewByMode(options)).toMatchObject(refused);
  expect(options.ciGate).not.toHaveBeenCalled();
  expect(options.spawnAgent).not.toHaveBeenCalled();
});
it('land-advance default dispatcher refuses without head evidence', async () => {
  const writeLedger = vi.fn();
  const apply = createLandAdvanceApplier({ writeLedger,
    readCapacity: () => ({ sessions: [], freeLanes: 1, load: 0 }) });
  const result = await apply({ errors: [], rows: [], proposed: [
    { subject: 'pr:10', pr, repo, owedAction: 'dispatch-review' },
  ], capacity: { budget: 1, cap: 1, loadThreshold: 1 } });
  expect(result).toMatchObject({ dispatched: [], errors: [],
    deferred: [{ target: 'pr:10', reason: 'refused-no-expected-head' }] });
  expect(writeLedger).not.toHaveBeenCalled();
});
it('land-advance defers an unpinned review without a launch ledger entry or spending capacity', async () => {
  const { options } = sessionFixture(false);
  const writeLedger = vi.fn();
  const dispatchFix = vi.fn(() => ({ agentId: 'fix-session' }));
  const apply = createLandAdvanceApplier({
    dispatchReview: input => dispatchReview({ ...options, expectedHead: undefined, ...input }),
    dispatchFix, pickFixLane: () => 1, writeLedger,
    readCapacity: () => ({ sessions: [], freeLanes: 1, load: 0 }),
  });
  const review = { subject: 'pr:10', pr, repo, owedAction: 'dispatch-review' };
  const fix = { subject: 'pr:11', pr: 11, repo, owedAction: 'dispatch-fix', fixPlan: {} };
  const result = await apply({ errors: [], rows: [], proposed: [review, fix],
    capacity: { budget: 1, cap: 1, loadThreshold: 1 } });
  expect(result.deferred).toEqual([{ target: review.subject, reason: 'refused-no-expected-head' }]);
  expect(result.errors).toEqual([]);
  expect(options.spawnAgent).not.toHaveBeenCalled();
  expect(options.launchWrapped).not.toHaveBeenCalled();
  expect(dispatchFix).toHaveBeenCalledOnce();
  expect(writeLedger).toHaveBeenCalledOnce();
  expect(writeLedger.mock.calls[0][0]).toMatchObject({ target: fix.subject, session: 'fix-session' });
});
describe.each([false, true])('land-advance planned head (wrapped=%s)', wrapReview => {
  it.each(['planner', 'supplied row'])('%s preserves the observed head through admission and records the launch', async source => {
    const { options } = sessionFixture(wrapReview);
    const plan = planLandAdvance({ now: 1000, freeLanes: 1, prs: [{
      number: pr, repo: 'we', labels: ['review:pending'], headRefOid: head,
    }] });
    if (source === 'supplied row') plan.proposed[0].headRefOid = head;
    const writeLedger = vi.fn();
    const dispatch = vi.fn(input => dispatchReview({ ...options, expectedHead: undefined, ...input }));
    const result = await createLandAdvanceApplier({ dispatchReview: dispatch, writeLedger,
      readCapacity: () => ({ freeLanes: 1, sessions: [], load: 0 }),
    })(plan);
    expect(result.errors).toEqual([]);
    expect(result.deferred).toEqual([]);
    expect(result.dispatched).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ expectedHead: head }));
    expect(wrapReview ? options.launchWrapped : options.spawnAgent).toHaveBeenCalledOnce();
    expect(writeLedger).toHaveBeenCalledWith(expect.objectContaining({ target: 'we#10', session: 'session-id' }));
  });
  it('refuses a head moved after planning without recording a launch', async () => {
    const { io, options } = sessionFixture(wrapReview);
    const plan = planLandAdvance({ now: 1000, freeLanes: 1, prs: [{
      number: pr, repo: 'we', labels: ['review:pending'], headRefOid: head,
    }] });
    io.liveHead.mockReturnValue('b'.repeat(40));
    const writeLedger = vi.fn();
    const result = await createLandAdvanceApplier({
      dispatchReview: input => dispatchReview({ ...options, expectedHead: undefined, ...input }),
      writeLedger, readCapacity: () => ({ freeLanes: 1, sessions: [], load: 0 }),
    })(plan);
    expect(result).toMatchObject({ dispatched: [], errors: [],
      deferred: [{ target: 'we#10', reason: 'refused-head-moved' }] });
    expect(options.spawnAgent).not.toHaveBeenCalled();
    expect(options.launchWrapped).not.toHaveBeenCalled();
    expect(writeLedger).not.toHaveBeenCalled();
  });
});
describe('expected review head admission', () => {
  it.each(['flag', 'environment'])('session CLI selected by %s refuses a missing pin with exit 75', selector => {
    const child = spawnSync(process.execPath, ['scripts/operations/review-dispatch.mjs',
      `--pr=${pr}`, `--repo=${repo}`, ...(selector === 'flag' ? ['--mode=session'] : [])], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, WE_REVIEW_DISPATCH_MODE: selector === 'environment' ? 'session' : 'job' },
    });
    expect(child.status).toBe(75);
    expect(child.stderr).toContain('refused (refused-no-expected-head)');
    expect(child.stdout).not.toContain('started');
  });
  it('matching head dispatches and runs the pinned red-team job', () => {
    const { io, options } = fixture();
    expect(dispatchReviewJob(options).jobPid).toBe(4242);
    expect(options.spawnJob.mock.calls[0][0].argv).toContain(`--expected-head=${head}`);
    expect(runReviewJob(options, io).outcome).toBe('red-team-only');
    expect(io.runRedTeam).toHaveBeenCalledTimes(1);
  });
  it('different head at dispatch refuses before launching or claiming work', () => {
    const { io, options } = fixture();
    io.liveHead.mockReturnValue('b'.repeat(40));
    expect(dispatchReviewJob(options)).toMatchObject(refused);
    expect(options.spawnJob).not.toHaveBeenCalled();
    expect(io.claim).not.toHaveBeenCalled();
    expect(io.acquireLane).not.toHaveBeenCalled();
  });
  it('head moving during the queued lane wait refuses before the red-team seat starts', () => {
    const { io, options } = fixture();
    expect(dispatchReviewJob(options).jobPid).toBe(4242);
    io.acquireLane.mockImplementation(() => {
      io.liveHead.mockReturnValue('b'.repeat(40));
      return { lanePath: '/lanes/lane-7' };
    });
    expect(runReviewJob(options, io)).toMatchObject(refused);
    expect(io.runRedTeam).not.toHaveBeenCalled();
    expect(io.redTeamStatus).not.toHaveBeenCalled();
    expect(io.releaseLane).toHaveBeenCalled();
    expect(io.unclaim).toHaveBeenCalled();
  });
  it.each([null, 'bad', 'throws'])('unreadable head %s refuses dispatch and queued startup', value => {
    const { io, options } = fixture();
    io.liveHead.mockImplementation(() => { if (value === 'throws') throw Error('unreadable'); return value; });
    expect(dispatchReviewJob(options)).toMatchObject(refused);
    expect(options.spawnJob).not.toHaveBeenCalled();
    expect(runReviewJob(options, io)).toMatchObject(refused);
    expect(io.runRedTeam).not.toHaveBeenCalled();
  });
  it('dispatch only: missing expected head refuses before any claim or job start', () => {
    const { io, options } = fixture();
    delete options.expectedHead;
    expect(dispatchReviewJob(options)).toMatchObject({ refused: true, outcome: 'refused-no-expected-head' });
    expect(options.spawnJob).not.toHaveBeenCalled();
    expect(io.claim).not.toHaveBeenCalled();
    expect(io.runRedTeam).not.toHaveBeenCalled();
  });
  it('detached CLI without --expected-head refuses before running the job', () => {
    const runJob = vi.fn(() => ({}));
    const prior = process.exitCode;
    try {
      runReviewJobCli(['run', `--pr=${pr}`, `--repo=${repo}`], { runJob });
      expect(runJob).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(75);
    } finally { process.exitCode = prior; }
  });
  it('detached CLI forwards the expected head into the queued job', () => {
    const runJob = vi.fn(() => ({ refused: true }));
    const prior = process.exitCode;
    try {
      runReviewJobCli(['run', `--pr=${pr}`, `--repo=${repo}`, '--red-team-only', `--expected-head=${head}`], { runJob });
      expect(runJob).toHaveBeenCalledWith(expect.objectContaining({ expectedHead: head }));
    } finally { process.exitCode = prior; }
  });
});

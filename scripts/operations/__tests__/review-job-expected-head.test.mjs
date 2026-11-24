import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dispatchReviewByMode, dispatchReviewJob, runReviewJob, runReviewJobCli } from '../review-job.mjs';

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
describe.each([false, true])('session review head admission (wrapped=%s)', wrapReview => {
  it.each([
    ['missing expected head', undefined, head, 'refused-no-expected-head'],
    ['null expected head', null, head, 'refused-head-moved'],
    ['malformed expected head', 'bad', head, 'refused-head-moved'],
    ['oversized expected head', 'a'.repeat(41), head, 'refused-head-moved'],
    ['moved head', head, 'b'.repeat(40), 'refused-head-moved'],
    ['missing live head', head, null, 'refused-head-moved'],
    ['malformed live head', head, 'bad', 'refused-head-moved'],
    ['throwing live head', head, 'throws', 'refused-head-moved'],
  ])('%s refuses before stack, CI, session setup, or spawn', (_name, expectedHead, liveHead, outcome) => {
    const { io, options } = sessionFixture(wrapReview);
    io.liveHead.mockImplementation(() => { if (liveHead === 'throws') throw Error('unreadable'); return liveHead; });
    const result = dispatchReviewByMode({ ...options, expectedHead });
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
    expect(dispatchReviewByMode({ ...options, expectedHead: head.toUpperCase() })).toMatchObject({ mode: 'session' });
    expect(io.liveHead).toHaveBeenCalledWith({ pr, repo });
    expect(wrapReview ? options.launchWrapped : options.spawnAgent).toHaveBeenCalledTimes(1);
    expect(wrapReview ? options.spawnAgent : options.launchWrapped).not.toHaveBeenCalled();
  });
  it('absent live-head reader fails closed', () => {
    const { io, options } = sessionFixture(wrapReview);
    delete io.liveHead;
    expect(dispatchReviewByMode(options)).toMatchObject(refused);
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

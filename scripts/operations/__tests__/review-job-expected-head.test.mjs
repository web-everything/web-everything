import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchReviewJob, runReviewJob, runReviewJobCli } from '../review-job.mjs';

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
describe('expected review head admission', () => {
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
  it('detached CLI forwards the expected head into the queued job', () => {
    const runJob = vi.fn(() => ({ refused: true }));
    const prior = process.exitCode;
    try {
      runReviewJobCli(['run', `--pr=${pr}`, `--repo=${repo}`, '--red-team-only', `--expected-head=${head}`], { runJob });
      expect(runJob).toHaveBeenCalledWith(expect.objectContaining({ expectedHead: head }));
    } finally { process.exitCode = prior; }
  });
});

import { describe, it, expect, vi } from 'vitest';
import { createReviewJobIo, runReviewJob } from '../review-job.mjs';
import { planReviewDispatch } from '../review-dispatch.mjs';
import { laneGitHardeningEnv } from '../../lib/lane-git-hardening.mjs';

const fromSha = 'a'.repeat(40), toSha = 'b'.repeat(40), fingerprint = 'c'.repeat(64);
const job = { pr: 1, repo: 'web-everything/web-everything' };
const carried = { fromSha, toSha, fingerprint };
const trusted = body => ({ author: { login: 'chalbert' }, body });

describe('default review job human-clearance CLI hook', () => {
  it('runs the isolated CLI with argv, the review checkout and hardened environment', () => {
    const exec = vi.fn(() => JSON.stringify({ carried }));
    const io = createReviewJobIo({ env: { TASK_TEST: 'kept' }, exec });
    expect(exec).not.toHaveBeenCalled();
    expect(io.carryHumanClearance(job)).toEqual({ carried });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(process.execPath, [expect.stringMatching(/scripts\/conveyor\/human-clearance-carry-cli\.mjs$/),
      '--pr', '1', '--repo', job.repo], expect.objectContaining({
      cwd: planReviewDispatch({ pr: 1, repo: job.repo }).laneRepo,
      env: laneGitHardeningEnv({ TASK_TEST: 'kept' }), timeout: expect.any(Number), maxBuffer: expect.any(Number),
    }));
  });

  it('preserves the CLI no-carry result', () => {
    const result = { carried: null, reason: 'head moved' };
    const io = createReviewJobIo({ env: {}, exec: vi.fn(() => JSON.stringify(result)) });
    expect(io.carryHumanClearance(job)).toEqual(result);
  });

  it.each(['exec error', 'parse error'])('throws on %s so the arc falls back to normal review', mode => {
    const exec = vi.fn(() => { if (mode === 'exec error') throw Error('unreadable CLI input'); return '{'; });
    const io = createReviewJobIo({ env: {}, exec });
    expect(() => io.carryHumanClearance(job)).toThrow();
  });
});

function fixture() {
  return {
    root: '.', now: () => 0, claim: () => ({ ok: true }), unclaim: vi.fn(), report: vi.fn(), log: vi.fn(),
    redTeamStatus: () => {},
    readPrevCompletion: () => null, newActorId: () => 'actor',
    prepareLane: () => ({ head: toSha }), acquireLane: () => ({ lanePath: 'fake-lane' }),
    updateRecord: vi.fn(), releaseLane: vi.fn(),
    carryAcrossRebaseSetting: vi.fn(() => ({ value: 'off', source: 'test' })),
    readCarryEvidence: vi.fn(() => ({ headSha: toSha, comments: [
      trusted(`<!-- reviewed-sha: ${fromSha} -->`),
      trusted(`<!-- we:red-team-gate pr=1 rev=${fromSha} outcome=card-queued -->`),
    ] })),
    contributionPatchId: vi.fn(() => 'd'.repeat(40)),
    restampVerdict: vi.fn(() => ({ ok: true })), postCarryComment: vi.fn(),
    runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify({
      stopped: 'complete', verdict: { verdict: 'accept', loop: { outcome: 'converged' } },
    }) })),
    runExtraSeats: vi.fn(), runRedTeam: vi.fn(), startSpeculativeRedTeam: vi.fn(),
    speculativeRedTeamSetting: () => ({ enabled: true }),
    readRedTeamOnlyPayload: vi.fn(() => null),
  };
}

describe('review job human-clearance carry across mechanical head moves', () => {
  it('returns carried without starting any review arc or seats and logs both heads and the fingerprint', () => {
    const io = fixture();
    io.carryHumanClearance = vi.fn(() => ({ carried }));

    const out = runReviewJob(job, io);

    expect(out.outcome).toBe('carried');
    expect(io.carryHumanClearance).toHaveBeenCalledTimes(1);
    expect(io.carryHumanClearance).toHaveBeenCalledWith(job);
    for (const key of ['runLoop', 'runExtraSeats', 'runRedTeam', 'startSpeculativeRedTeam']) {
      expect(io[key]).not.toHaveBeenCalled();
    }
    expect(io.log.mock.calls.some(([line]) =>
      line.includes(fromSha) && line.includes(toSha) && line.includes(fingerprint))).toBe(true);
    expect(io.carryAcrossRebaseSetting).not.toHaveBeenCalled();
    expect(io.restampVerdict).not.toHaveBeenCalled();
  });

  it.each(['non-mechanical move', 'content change', 'conflict-resolution diff'])(
    'runs the normal arc when the human carry proof returns null: %s', () => {
      const io = fixture();
      io.carryHumanClearance = vi.fn(() => null);

      const out = runReviewJob(job, io);

      expect(io.carryHumanClearance).toHaveBeenCalledTimes(1);
      expect(io.carryHumanClearance).toHaveBeenCalledWith(job);
      expect(out.outcome).not.toBe('carried');
      expect(io.runLoop).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['unreadable marker', 'unreadable evidence'])(
    'fails closed to the normal arc and logs unavailable when the hook throws: %s', reason => {
      const io = fixture();
      io.carryHumanClearance = vi.fn(() => { throw Error(reason); });

      const out = runReviewJob(job, io);

      expect(out.outcome).not.toBe('carried');
      expect(io.runLoop).toHaveBeenCalledTimes(1);
      expect(io.log.mock.calls.some(([line]) => /unavailable/i.test(line) && line.includes(reason))).toBe(true);
      expect(io.carryHumanClearance).toHaveBeenCalledTimes(1);
    expect(io.carryHumanClearance).toHaveBeenCalledWith(job);
    },
  );

  it('keeps the normal arc unchanged when the optional human carry hook is absent', () => {
    const io = fixture();

    const out = runReviewJob(job, io);

    expect(out.outcome).not.toBe('carried');
    expect(io.runLoop).toHaveBeenCalledTimes(1);
    expect(io.postCarryComment).not.toHaveBeenCalled();
  });

  it('tries human carry before the agent-verdict carryAcrossRebase block', () => {
    const io = fixture();
    io.carryHumanClearance = vi.fn(() => null);
    io.carryAcrossRebaseSetting.mockReturnValue({ value: 'on', source: 'test' });

    const out = runReviewJob(job, io);

    expect(out.outcome).toBe('carried');
    expect(io.carryHumanClearance).toHaveBeenCalledTimes(1);
    expect(io.carryHumanClearance).toHaveBeenCalledWith(job);
    expect(io.carryHumanClearance.mock.invocationCallOrder[0])
      .toBeLessThan(io.carryAcrossRebaseSetting.mock.invocationCallOrder[0]);
    expect(io.readCarryEvidence).toHaveBeenCalledTimes(1);
    expect(io.readCarryEvidence).toHaveBeenCalledWith(job);
    expect(io.restampVerdict).toHaveBeenCalledTimes(1);
    expect(io.runLoop).not.toHaveBeenCalled();
  });

  it('skips human and agent carry for redTeamOnly jobs', () => {
    const io = fixture();
    io.carryHumanClearance = vi.fn(() => ({ carried }));
    io.carryAcrossRebaseSetting.mockReturnValue({ value: 'on', source: 'test' });

    const out = runReviewJob({ ...job, redTeamOnly: true }, io);

    expect(out.outcome).toBe('red-team-not-owed');
    expect(io.readRedTeamOnlyPayload).toHaveBeenCalledTimes(1);
    expect(io.readRedTeamOnlyPayload).toHaveBeenCalledWith({ ...job, head: toSha });
    expect(io.carryHumanClearance).not.toHaveBeenCalled();
    expect(io.carryAcrossRebaseSetting).not.toHaveBeenCalled();
    expect(io.runLoop).not.toHaveBeenCalled();
  });
});

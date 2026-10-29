import { describe, it, expect, vi } from 'vitest';
import { createReviewJobIo, runReviewJob } from '../review-job.mjs';
import { planReviewDispatch } from '../review-dispatch.mjs';
import { laneGitHardeningEnv } from '../../lib/lane-git-hardening.mjs';
import { run as runCarryCli } from '../../conveyor/human-clearance-carry-cli.mjs';

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
  it('runs the normal review arc when a workflow head only has general merge-of-main equivalence', () => {
    const io = fixture();
    const comments = [{ ...trusted(`<!-- reviewed-sha: ${fromSha} -->\n<!-- reviewed-diff: ${fingerprint} -->\n<!-- cleared-human: chalbert -->`),
      id: 'clearance', createdAt: '2026-10-01T00:00:00Z' }];
    const exec = vi.fn((file, args) => {
      if (file === 'git') {
        if (['fetch', 'cat-file', 'merge-base'].includes(args[0])) return '';
        if (args[0] === 'diff' && args.includes('--name-only')) return '.github/workflows/merge-gate.yml\0';
        if (args[0] === 'rev-parse') return args.at(-1).startsWith(fromSha) ? fromSha : toSha;
        if (args[0] === 'rev-list') return `${toSha} ${fromSha} ${'d'.repeat(40)}`;
      }
      if (file === 'gh' && args[1] === 'view') return JSON.stringify({ headRefOid: toSha, reviews: [], labels: [{ name: 'review:accepted' }] });
      if (file === 'gh' && args[0] === 'api') {
        if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: {
          comments: { totalCount: comments.length },
        } } } });
        return comments.map(c => [c.body.replaceAll('\n', '\\n'), c.createdAt, c.author.login, c.id, ''].join('\t')).join('\n');
      }
      if (file === 'gh' && args[1] === 'comment') return '';
      throw Error(`unexpected command: ${file} ${args.join(' ')}`);
    });
    io.carryHumanClearance = () => {
      let result;
      expect(runCarryCli({ ...job, exec, readEvidence: () => ({
        humanClearance: { sha: fromSha, diff: fingerprint, actor: 'chalbert' },
        headSha: toSha, headDiffSha: toSha, headDiff: fingerprint,
      }), carryOptions: { setting: { value: true, source: 'test' }, netPatchSetting: { value: false, source: 'test' },
        proveNumbering: () => ({ ok: false, reason: 'not numbering-only' }) },
      log: io.log, write: line => { result = JSON.parse(line); } })).toBe(0);
      return result;
    };

    expect(runReviewJob(job, io).outcome).not.toBe('carried');
    expect(io.runLoop).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls.filter(([file, args]) => file === 'gh' && args[1] === 'comment')).toHaveLength(0);
  });

  it.each(['existing', 'during proof'])('runs the advisory arc for a human hold applied %s despite identical head trees', timing => {
    const io = fixture();
    const labels = timing === 'existing' ? [{ name: 'review:human' }] : [];
    const comments = [{ ...trusted(`<!-- reviewed-sha: ${fromSha} -->\n<!-- reviewed-diff: ${fingerprint} -->\n<!-- cleared-human: chalbert -->`),
      id: 'clearance', createdAt: '2026-10-01T00:00:00Z' }];
    const exec = vi.fn((file, args) => {
      if (file === 'git' && ['fetch', 'cat-file'].includes(args[0])) return '';
      if (file === 'git' && args[0] === 'diff' && args.includes('--name-only')) return 'example.txt\0';
      if (file === 'git' && args[0] === 'rev-parse' && !args.at(-1).endsWith('^{tree}')) return toSha;
      if (file === 'git' && args[0] === 'rev-parse' && args.at(-1).endsWith('^{tree}')) {
        if (timing === 'during proof' && labels.length === 0) labels.push({ name: 'review:human' });
        return 'd'.repeat(40);
      }
      if (file === 'gh' && args[1] === 'view') return JSON.stringify({ headRefOid: toSha, reviews: [], labels });
      if (file === 'gh' && args[0] === 'api') {
        if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: {
          comments: { totalCount: comments.length },
        } } } });
        return comments.map(c => [c.body.replaceAll('\n', '\\n'), c.createdAt, c.author.login, c.id, ''].join('\t')).join('\n');
      }
      if (file === 'gh' && args[1] === 'comment') return '';
      throw Error(`unexpected command: ${file} ${args.join(' ')}`);
    });
    io.carryHumanClearance = () => {
      let result;
      runCarryCli({ ...job, exec, readEvidence: () => ({
        humanClearance: { sha: fromSha, diff: fingerprint, actor: 'chalbert' },
        headSha: toSha, headDiffSha: toSha, headDiff: fingerprint,
      }), carryOptions: { setting: { value: true, source: 'test' }, netPatchSetting: { value: false, source: 'test' } },
      log: io.log, write: line => { result = JSON.parse(line); } });
      return result;
    };

    expect(runReviewJob(job, io).outcome).not.toBe('carried');
    expect(exec.mock.calls.some(([file, args]) => file === 'git' && args.at(-1).endsWith('^{tree}'))).toBe(true);
    expect(exec.mock.calls.filter(([file, args]) => file === 'gh' && args[1] === 'comment')).toHaveLength(0);
    expect(io.runLoop).toHaveBeenCalledTimes(1);
    expect(io.log.mock.calls.some(([line]) => line.includes('review:human'))).toBe(true);
  });

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
    expect(io.log.mock.calls.filter(([line]) => line.includes('human clearance'))).toEqual([
      [`review-job: human clearance carried ${fromSha}->${toSha} fingerprint ${fingerprint.slice(0, 12)}`],
    ]);
    expect(io.carryAcrossRebaseSetting).not.toHaveBeenCalled();
    expect(io.restampVerdict).not.toHaveBeenCalled();
  });

  it('runs the normal arc and logs the reason when the CLI refuses human carry', () => {
    const io = fixture();
    const reason = 'carry not proven; normal review required';
    io.carryHumanClearance = vi.fn(() => ({ carried: null, reason }));

    const out = runReviewJob(job, io);

    expect(io.carryHumanClearance).toHaveBeenCalledTimes(1);
    expect(io.carryHumanClearance).toHaveBeenCalledWith(job);
    expect(out.outcome).not.toBe('carried');
    expect(io.runLoop).toHaveBeenCalledTimes(1);
    expect(io.log.mock.calls.some(([line]) => line.includes(reason))).toBe(true);
  });

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

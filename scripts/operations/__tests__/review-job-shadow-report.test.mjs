import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createReviewJobIo, runReviewJob } from '../review-job.mjs';
import { writeReviewJobDone } from '../review-job-envelope.mjs';

vi.mock('../review-job-envelope.mjs', () => ({
  writeReviewJobStarted: vi.fn(), writeReviewJobDone: vi.fn(),
}));

const laneHead = 'a'.repeat(40), readHead = 'b'.repeat(40);
const lanePath = '/lanes/review-fixture';
// Include non-UTF8 bytes and a trailing newline: hash the actual output without decoding or trimming.
const diff = Buffer.from([0x64, 0x69, 0x66, 0x66, 0xff, 0x0a]);
const netDiff = createHash('sha256').update(diff).digest('hex');
beforeEach(() => vi.clearAllMocks());

function fixture({ rev = readHead, head = laneHead, error } = {}) {
  const exec = vi.fn(() => { if (error) throw error; return diff; });
  const real = createReviewJobIo({ exec, env: { WE_WORKER_WRAPPER: 'on' } });
  const io = {
    root: '.', now: () => 1000, newActorId: () => 'actor', readPrevCompletion: () => null,
    claim: () => ({ ok: true }), acquireLane: () => ({ lanePath }), updateRecord: vi.fn(),
    prepareLane: () => ({ head }), releaseLane: vi.fn(), unclaim: vi.fn(), log: vi.fn(),
    report: real.report, reviewNetDiff: real.reviewNetDiff,
    runLoop: () => ({ status: 0, stdout: JSON.stringify({
      runId: 'run-fixture', stopped: 'complete', verdict: { verdict: 'changes', loop: { outcome: 'complete' } },
      findings: { read: { netBasis: { rev } } },
    }) }),
  };
  return { io, exec };
}

describe('review job real shadow report path', () => {
  it.each([readHead, readHead.toUpperCase()])('passes the reviewed head %s and raw net diff hash to writeReviewJobDone', rev => {
    const { io, exec } = fixture({ rev });
    runReviewJob({ pr: 10, repo: 'web-everything/web-everything' }, io);
    expect(writeReviewJobDone).toHaveBeenCalledWith(expect.objectContaining({
      classified: expect.objectContaining({ head: readHead, netDiff, runId: 'run-fixture' }),
    }));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('git',
      ['diff', '--no-ext-diff', '--no-textconv', `origin/main...${readHead}`],
      expect.objectContaining({ cwd: lanePath, encoding: null, timeout: 10_000, maxBuffer: expect.any(Number) }));
  });

  it('uses the lane head when the read has no real head', () => {
    const { io } = fixture({ rev: 'unknown' });
    runReviewJob({ pr: 10, repo: 'web-everything/web-everything' }, io);
    expect(writeReviewJobDone.mock.calls[0][0].classified).toMatchObject({ head: laneHead, netDiff });
  });

  it.each(['missing base', 'maxBuffer exceeded', 'timeout'])('omits identity on diff failure (%s), still reports and cleans up without throwing', message => {
    const { io } = fixture({ error: Error(message) });
    expect(() => runReviewJob({ pr: 10, repo: 'web-everything/web-everything' }, io)).not.toThrow();
    expect(writeReviewJobDone).toHaveBeenCalledTimes(1);
    const classified = writeReviewJobDone.mock.calls[0][0].classified;
    expect(classified).toMatchObject({ outcome: 'bounced', runId: 'run-fixture' });
    expect(classified).not.toHaveProperty('head');
    expect(classified).not.toHaveProperty('netDiff');
    expect(io.releaseLane).toHaveBeenCalled();
    expect(io.unclaim).toHaveBeenCalled();
  });

  it('omits identity without invoking git when neither head is real', () => {
    const { io, exec } = fixture({ rev: 'unknown', head: null });
    runReviewJob({ pr: 10, repo: 'web-everything/web-everything' }, io);
    expect(exec).not.toHaveBeenCalled();
    expect(writeReviewJobDone.mock.calls[0][0].classified).not.toHaveProperty('head');
    expect(writeReviewJobDone.mock.calls[0][0].classified).not.toHaveProperty('netDiff');
  });

  it('forwards a present round, including zero, through the real report adapter', () => {
    const { io } = fixture();
    io.report({ session: 'review-10', status: 'done', outcome: 'bounced', head: readHead, netDiff, round: 0 });
    expect(writeReviewJobDone.mock.calls[0][0].classified).toMatchObject({ head: readHead, netDiff, round: 0 });
  });
});

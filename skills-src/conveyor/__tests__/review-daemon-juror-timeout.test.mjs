import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReviewTick } from '../review-daemon.mjs';
import { diagnoseEndedJob, writeEndedJobDiagnosis } from '../../../scripts/operations/review-job-end-diagnosis.mjs';

it('logs a persisted juror-timeout without no-verdict wording and keeps retry priority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'juror-timeout-'));
  try {
    const head = 'a'.repeat(40);
    const job = { slug: 'review-10', pid: 42, dir };
    writeEndedJobDiagnosis(job, { reason: 'juror-timeout', lens: 'correctness', provider: 'claude', model: 'sonnet', head, wallMs: 6, timeoutMs: 5, runId: 'timeout-run' });
    const log = vi.fn();
    const dispatch = vi.fn(() => ({}));
    const dispatchState = { firstOwedAt: new Map(), lastDispatched: new Map([['web-everything/web-everything#10', { pid: 42, head, slug: job.slug }]]) };
    runReviewTick({ repo: 'web-everything/web-everything', dispatchState, isPidAlive: () => false, holdReconcile: () => [],
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 10, headRefOid: head }], refusals: [] }),
      readPrs: () => [{ number: 10, headRefOid: head, labels: ['review:pending'] }], readAgents: () => [],
      diagnoseJob: j => diagnoseEndedJob({ ...j, dir }), writeJobDiagnosis: (j, d) => writeEndedJobDiagnosis({ ...j, dir }, d),
      dispatch, tagRound() {}, tagStatus() {}, statusCandidates: () => [], acquirableLanes: () => 1, log });
    expect(log).toHaveBeenCalledWith('review-daemon: web-everything/web-everything#10 review-job-ended juror-timeout (correctness claude/sonnet 6ms; run timeout-run; head aaaaaaaaaaaa)');
    expect(log.mock.calls.flat().join(' ')).not.toContain('no-verdict');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(diagnoseEndedJob({ ...job, pid: 999 }).reason).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Reconcile's dead-job pruning must not erase job-mode retry exhaustion. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runReviewTick } from '../../../skills-src/conveyor/review-daemon.mjs';
import { dispatchReviewJob, listReviewJobAgents } from '../../operations/review-job.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('parks after the configured number of dead JOB reviews despite reconcile pruning every dead agent row', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'review-reconcile-retry-')); roots.push(dir);
  const repo = 'plateauapp/plateau-app', head = 'a'.repeat(40), pr = 229;
  const spawnJob = vi.fn(() => 4242), publishNeedsYou = vi.fn(), tagRound = vi.fn();
  let now = Date.now(), completion = null;
  const results = [];
  for (let tick = 0; tick < 7; tick++) {
    results.push(runReviewTick({ repo,
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: pr }], refusals: [] }),
      readPrs: () => [{ number: pr, headRefOid: head, labels: [{ name: 'review:pending' }] }],
      readAgents: () => listReviewJobAgents({ dir, isAlive: () => false }),
      tagRound, tagStatus: () => {}, statusCandidates: () => [], holdReconcile: () => [],
      dispatch: options => dispatchReviewJob({ ...options, dir, root: '/daemon', checkoutExists: () => true,
        env: { WE_REVIEW_JOB_FAILURE_CAP: '2' }, now: ++now, checkStaleness: () => ({ fresh: true, behind: 0 }),
        isAlive: () => false, resolveSettingsEnv: () => ({}), readCompletion: () => completion,
        ciGate: () => ({ allowed: true, headSha: head }), spawnJob, publishNeedsYou,
        retryTerminal: ({ classified, pid }) => { completion = { ...classified, status: 'done', pid, updatedAt: new Date(now).toISOString() }; },
      }),
    }));
  }
  expect(results.map(result => result.dispatched.length)).toEqual([1, 1, 0, 0, 0, 0, 0]);
  expect(results.slice(2).every(result => result.notStarted[0].reason === 'review-job-parked')).toBe(true);
  expect(spawnJob).toHaveBeenCalledTimes(2); expect(tagRound).toHaveBeenCalledTimes(2);
  expect(publishNeedsYou).toHaveBeenCalledTimes(1);
});

import { describe, it, expect, vi } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { REVIEW_TIMING_DEFAULTS, reviewStartGate } from '../../lib/review-timing.mjs';
import { reviewCiGate } from '../../lib/review-ci-gate.mjs';
import { classifyPr, shouldLabelOnGreen } from '../../merge-ai-prs.mjs';
import { pollVerdict } from '../../pr-land.mjs';
import { liveReviewRoundBudget, runReviewTick } from '../../../skills-src/conveyor/review-daemon.mjs';

const headSha = 'a'.repeat(40);
const row = (status, conclusion = null) => ({ name: 'test', head_sha: headSha, status, conclusion });
const pr = checks => ({ number: 12, state: 'OPEN', headRefOid: headSha, headRefName: 'lane/early-review',
  baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', body: 'Review early CI policy.',
  labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }], comments: [], statusCheckRollup: checks });

describe('early review never grants landing permission', () => {
  it.each([2, 3, 4])('enforces maxLiveReviewRounds=3 for pending-CI early review with %i live rounds', live => {
    const input = { ...pr([row('in_progress')]), labels: [{ name: 'review:pending' }] };
    const budget = liveReviewRoundBudget({ env: { WE_REVIEW_MAX_LIVE_ROUNDS: '3' },
      listCommands: () => Array.from({ length: live }, (_, i) => `node review-${i}/review-job.mjs run`).join('\n') });
    expect(budget).toMatchObject({ live, max: 3, left: Math.max(0, 3 - live) });
    const dispatch = vi.fn(() => ({ agentId: 'early-review' }));
    const reconcile = vi.fn(({ readPrs, readAgents }) => planReconcile({ prs: readPrs(), agents: readAgents(),
      requiredChecks: ['test'], reviewTiming: { ...REVIEW_TIMING_DEFAULTS, startAfter: 'ci-green', startEarly: 'on' } }));
    const result = runReviewTick({ reconcile, readPrs: () => [input], readAgents: () => [], dispatch,
      holdReconcile: () => [], notifyReferral: () => {}, tagRound: () => {}, tagStatus: () => {},
      statusCandidates: () => [], acquirableLanes: () => 40, liveReviewBudget: budget });
    // Prove CI eligibility reaches the real dispatch boundary even when the host-wide cap holds it.
    expect(reconcile.mock.results[0].value.dispatch).toContainEqual(expect.objectContaining({ kind: 'review', prNumber: 12 }));
    expect(result.reconcileError).toBeNull();
    if (live >= 3) {
      expect(dispatch).not.toHaveBeenCalled();
      expect(result.dispatched).toEqual([]);
      expect(result.deferredForCap).toBe(1);
      expect(result.pendingNotDispatched[0].reasons.join('\n')).toContain('held by the live-review cap');
    } else {
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.dispatched).toHaveLength(1);
      expect(result.deferredForCap).toBe(0);
    }
  });
  it('dispatches review with pending CI only when enabled', () => {
    const input = { ...pr([row('in_progress')]), labels: [{ name: 'review:pending' }] };
    for (const startEarly of ['off', 'shadow', 'on']) {
      const result = planReconcile({ prs: [input], requiredChecks: ['test'],
        reviewTiming: { ...REVIEW_TIMING_DEFAULTS, startAfter: 'ci-green', startEarly } });
      expect(result.dispatch.some(d => d.kind === 'review')).toBe(startEarly === 'on');
    }
  });
  it.each(['off', 'shadow', 'on'])('holds ready and merge with an accepted early verdict and pending or red CI (%s)', startEarly => {
    const policy = { ...REVIEW_TIMING_DEFAULTS, startAfter: 'ci-green', startEarly };
    for (const checks of [[row('in_progress')], [row('completed', 'failure')]]) {
      const start = reviewStartGate({ headSha, checks, requiredChecks: ['test'], policy });
      if (checks[0].conclusion === 'failure') expect(start).toMatchObject({ allowed: false,
        reason: startEarly === 'off' ? 'required-checks-not-successful' : 'ci-red' });
      else if (startEarly === 'on') expect(start).toMatchObject({ allowed: true, earlyStart: true });
      // Model a stored accepted verdict on precisely this head, including an accidentally present ready label.
      const accepted = { ...pr(checks), reviewedSha: headSha, earlyStart: true };
      expect(reviewCiGate({ headSha, checks, requiredChecks: ['test'] }).allowed).toBe(false);
      expect(pollVerdict({ state: 'CLEAN', checkStatus: checks[0].conclusion ? 'failed' : 'pending',
        requiredCount: 1, labelWhenGreen: true })).not.toBe('label');
      expect(classifyPr(accepted, { requiredCheck: 'test', queueRequiredChecks: ['test'] }).decision).toBe('skip');
      expect(shouldLabelOnGreen({ ...accepted, labels: [{ name: 'review:accepted' }] }, { requiredCheck: 'test' })).toBe(false);
    }
    expect(classifyPr(pr([row('completed', 'success')]), { requiredCheck: 'test' }).decision).toBe('merge');
    expect(shouldLabelOnGreen({ ...pr([row('completed', 'success')]), labels: [{ name: 'review:accepted' }] },
      { requiredCheck: 'test' })).toBe(true);
    expect(reviewCiGate({ headSha, checks: [{ ...row('completed', 'success'), head_sha: 'b'.repeat(40) }],
      requiredChecks: ['test'] }).allowed).toBe(false);
  });
});

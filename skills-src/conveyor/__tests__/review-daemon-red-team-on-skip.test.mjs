import { it, expect, vi } from 'vitest';
import { runReviewTick } from '../review-daemon.mjs';

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
    capacity: { lanes: 3, budget: liveReviewBudget }, paused: false });
  expect(out.redTeamOnSkip).toBe(result);
  expect(tagStatus.mock.calls.at(-1)[0].agents).toBeUndefined();
  expect(runReviewTick({ ...options, redTeamOnSkip: null })).not.toHaveProperty('redTeamOnSkip');
  redTeamOnSkip.mockClear();
  expect(runReviewTick({ ...options, paused: true })).not.toHaveProperty('redTeamOnSkip');
  expect(redTeamOnSkip).not.toHaveBeenCalled();
});

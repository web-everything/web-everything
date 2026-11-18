import { describe, it, expect, vi } from 'vitest';
import { runReviewTickAllRepos } from '../../../skills-src/conveyor/review-daemon.mjs';

const repos = ['web-everything/web-everything', 'plateauapp/plateau-app'];
const budget = () => ({ live: 7, max: 8, left: 1,
  reason: 'live review rounds 7 of maxLiveReviewRounds=8 (tool)' });
const options = () => ({
  repos,
  authGateOverride: () => ({ paused: false, reason: null }),
  reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 229, attempts: 0 }], refusals: [] }),
  readPrs: () => [{ number: 229, labels: ['review:pending'] }],
  readAgents: () => [],
  dispatch: vi.fn(() => ({ agentId: 'review-229' })),
  holdReconcile: () => [], notifyReferral: () => {},
  tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
  acquirableLanes: () => 4,
});

describe('shared review seats across repos', () => {
  it('gives both repos the single free seat over two explicitly rotated ticks', () => {
    const opts = options();
    const first = runReviewTickAllRepos({ ...opts, startIndex: 0, liveReviewBudget: budget() });
    const second = runReviewTickAllRepos({ ...opts, startIndex: 1, liveReviewBudget: budget() });
    expect(first.dispatched.map(d => d.repo)).toEqual([repos[0]]);
    expect(second.dispatched.map(d => d.repo)).toEqual([repos[1]]);
    expect(opts.dispatch).toHaveBeenCalledTimes(2);
    for (const result of [first, second]) {
      expect(result.repos.map(r => r.repo)).toEqual(repos);
      expect(Object.keys(result.perRepoMs)).toEqual(repos);
      expect(result.deferredForCap).toBe(1);
      expect(result.reviewsOwed).toBe(2);
    }
  });

  it('rotates the default starting repo on successive ticks without an injected index', () => {
    const opts = options();
    const first = runReviewTickAllRepos({ ...opts, liveReviewBudget: budget() });
    const second = runReviewTickAllRepos({ ...opts, liveReviewBudget: budget() });
    expect(first.dispatched).toHaveLength(1);
    expect(second.dispatched).toHaveLength(1);
    expect(new Set([...first.dispatched, ...second.dispatched].map(d => d.repo))).toEqual(new Set(repos));
  });

  it.each([0, 1])('reports all eight occupied seats and the earlier dispatch for startIndex=%i', startIndex => {
    const shared = budget();
    const result = runReviewTickAllRepos({ ...options(), startIndex, liveReviewBudget: shared });
    const held = result.repos.find(r => r.repo === repos[1 - startIndex]).result;
    expect(shared.left).toBe(0);
    expect(held.dispatched).toEqual([]);
    expect(held.deferredForCap).toBe(1);
    expect(held.deferredForCapReason).toBe('live review rounds 8 of maxLiveReviewRounds=8 (tool); 1 seat(s) taken by dispatches earlier in this tick');
    expect(held.pendingNotDispatched[0].reasons.join('\n')).toContain(held.deferredForCapReason);
    expect(result.deferredForCapReason).toBe(held.deferredForCapReason);
  });

  it('derives occupancy from max and left even when the initial live count is absent', () => {
    const result = runReviewTickAllRepos({ ...options(), startIndex: 0,
      liveReviewBudget: { max: 8, left: 0, reason: 'live review rounds 7 of maxLiveReviewRounds=8 (tool)' } });
    expect(result.dispatched).toEqual([]);
    expect(result.deferredForCapReason).toBe('live review rounds 8 of maxLiveReviewRounds=8 (tool)');
  });

  it.each([
    { left: 0, live: 7, reason: 'live review rounds 7 of maxLiveReviewRounds=8 (tool)' },
    { left: 0, reason: 'live review count unknown; no new reviews' },
    { left: 0 },
  ])('preserves legacy diagnostics for a budget without max: %j', liveReviewBudget => {
    const result = runReviewTickAllRepos({ ...options(), startIndex: 0, liveReviewBudget });
    expect(result.dispatched).toEqual([]);
    expect(result.deferredForCap).toBe(2);
    expect(result.deferredForCapReason).toBe(liveReviewBudget.reason ?? null);
  });
});

describe('liveReviewRoundBudget with unreadable cap settings', () => {
  it('falls back to the code default of 8 instead of unlimited', async () => {
    const { liveReviewRoundBudget } = await import('../../../skills-src/conveyor/review-daemon.mjs');
    const budget = liveReviewRoundBudget({ env: {}, toolPath: '/nonexistent/review-concurrency.json', listCommands: () => '' });
    expect(budget).toMatchObject({ max: 8, live: 0, left: 8 });
  });
});

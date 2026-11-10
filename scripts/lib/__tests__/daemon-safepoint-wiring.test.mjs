import { it, expect, vi, beforeEach } from 'vitest';
const points = vi.hoisted(() => vi.fn(async () => ({ adopted: false })));
vi.mock('../daemon-self-sync.mjs', async (original) => ({ ...await original(), safePoint: points }));
vi.mock('../review-facts.mjs', async (original) => ({ ...await original(), warmReviewFacts: async () => ({ skipped: 'test' }) }));
import { SafePointRestart, SafePointAbort } from '../daemon-self-sync.mjs';
import { runTickAllRepos, runReconcileFixDispatchAllRepos, runReconcileCiHealDispatchAllRepos, runPromoteDraftDispatchAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';
import { buildCliDaemonEffects, runReviewTickAllRepos, runConvertAdvisoryTickAllRepos } from '../../../skills-src/conveyor/review-daemon.mjs';
const empty = () => ({ dispatched: [], refusals: [], failed: [], reviewsOwed: 0 });
beforeEach(() => { points.mockReset().mockResolvedValue({ adopted: false }); });
it('fix-dispatch yields after complete phases and between repo dispatches', async () => {
  const steps = [];
  points.mockImplementation(async (label) => { steps.push(label); });
  await runTickAllRepos({ repos: ['one', 'two'], fixTick: ({ repo }) => { steps.push(`dispatch:${repo}`); return empty(); },
    ciHealTick: empty, hungCiTick: empty, mainRedRebaseTick: empty, missingRunTick: empty, promoteDraftTick: empty,
    rulingStandDownTick: () => ({ rows: [] }), notesTick: () => ({ notes: [] }), awaitVerifyTick: () => ({ rows: [] }),
    stuckFixerTick: () => ({ rows: [] }), supersedeTick: () => ({}), reuseReconcilePlan: false });
  expect(steps.indexOf('orphan-guard')).toBeLessThan(steps.indexOf('dispatch:one'));
  expect(steps.indexOf('repo:one')).toBeGreaterThan(steps.indexOf('dispatch:one'));
  expect(steps.indexOf('repo:one')).toBeLessThan(steps.indexOf('dispatch:two'));
  for (const phase of ['fix', 'ci-heal', 'promote-draft']) expect(steps).toContain(phase);
});
it('review yields between reap, facts, review, convert and prep', async () => {
  const effects = buildCliDaemonEffects({ owner: 'test', log: { error: vi.fn() }, reapSessions: () => ({}),
    runReview: async () => ({ repos: [], liveProcessPrs: [] }), runConvertAdvisories: async () => ({}),
    runPrepReview: async () => ({}), convertAdvisoryEnabled: true });
  await effects.tickOnce();
  expect(points.mock.calls.map(([label]) => label)).toEqual(['reap', 'facts', 'review', 'convert', 'prep']);
});
it.each([SafePointRestart, SafePointAbort])('%s escapes per-repo error isolation without dispatching the next repo', async (Control) => {
  for (const run of [runReconcileFixDispatchAllRepos, runReconcileCiHealDispatchAllRepos, runPromoteDraftDispatchAllRepos, runReviewTickAllRepos]) {
    const error = new Control('stop'); const tick = vi.fn(empty);
    points.mockRejectedValue(error);
    await expect(run({ repos: ['one', 'two'], tick, atSafePoints: true })).rejects.toBe(error);
    expect(tick).toHaveBeenCalledTimes(1);
  }
});
it('parallel conversion yields only after every worker has completed', async () => {
  let done = 0;
  points.mockImplementation(async () => expect(done).toBe(2));
  await runConvertAdvisoryTickAllRepos({ repos: ['one', 'two'], concurrency: 2, tick: async () => {
    await Promise.resolve(); done++; return {};
  } });
  expect(points).toHaveBeenCalledWith('convert-repos');
});

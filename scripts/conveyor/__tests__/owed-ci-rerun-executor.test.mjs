import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeOwedCiReruns, resolveOwedRerunMax } from '../owed-ci-rerun-executor.mjs';
import { runReviewTick, buildCliDaemonEffects } from '../../../skills-src/conveyor/review-daemon.mjs';
vi.mock('../../lib/review-facts.mjs', async original => ({ ...await original(), warmReviewFacts: async () => ({ skipped: 'test' }) }));
const repo = 'web-everything/web-everything';
const rows = Array.from({ length: 13 }, (_, i) => ({ kind: 'ci-timeout-rerun', prNumber: 20 - i, timeoutRetry: { pr: 20 - i } }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('owed rerun executor', () => {
  it('executes ten oldest PRs sequentially and leaves oversized input owed next tick', async () => {
    let active = 0;
    const calls = [];
    const dispatchRetry = async (e, opts) => {
      expect(opts).toEqual({ repo }); expect(active++).toBe(0);
      await Promise.resolve(); calls.push(e.pr); active--; return { status: 'requested' };
    };
    const out = await executeOwedCiReruns({ rows: [...rows, { kind: 'review' }], repo, dispatchRetry });
    expect(calls).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(out).toEqual({ requested: calls, refused: [], skippedOverCap: 3 });
  });
  it('continues after thrown and unknown executor results and a throwing logger', async () => {
    const dispatchRetry = vi.fn().mockRejectedValueOnce('lost').mockResolvedValueOnce(undefined).mockResolvedValue({ status: 'requested' });
    const out = await executeOwedCiReruns({ rows, repo, max: 3, dispatchRetry, log: () => { throw Error('log'); } });
    expect(out).toEqual({ requested: [10], refused: [{ pr: 8, reason: 'lost' }, { pr: 9, reason: 'unknown timeout retry result' }], skippedOverCap: 10 });
    await expect(executeOwedCiReruns({ rows: null, log: () => { throw Error('log'); } })).resolves.toEqual({ requested: [], refused: [], skippedOverCap: 0 });
  });
  it.each([['999', 25], ['0', 1], ['bad', 10], [undefined, 10], ['4', 4]])('bounds environment max %s to %s', (value, expected) => {
    expect(resolveOwedRerunMax({ WE_OWED_RERUN_MAX_PER_PASS: value, WE_POLICY_CASCADE_LOG: '0' })).toBe(expected);
  });
});
const tick = (extra = {}) => runReviewTick({ repo, reconcile: () => ({ dispatch: rows, refusals: [] }),
  holdReconcile: () => [], statusCandidates: () => [], paused: true, hostAdmission: () => ({ admitted: false }), ...extra });
describe('review tick owed rerun wiring', () => {
  it('executes the planned repo rows even when review starts are paused and logs each result', async () => {
    const log = vi.fn();
    const executeOwedReruns = vi.fn(async () => ({ requested: [8], refused: [{ pr: 9, reason: 'held' }], skippedOverCap: 11 }));
    const out = tick({ log, executeOwedReruns });
    await out.owedCiReruns;
    expect(executeOwedReruns).toHaveBeenCalledWith({ rows, repo, log: expect.any(Function) });
    expect(log).toHaveBeenCalledWith(`review-daemon: ${repo}#8 owed ci-timeout-rerun executed: requested`);
    expect(log).toHaveBeenCalledWith(`review-daemon: ${repo}#9 owed ci-timeout-rerun executed: refused (held)`);
    expect(out.dispatched).toEqual([]);
  });
  it('isolates synchronous executor and diagnostic failures', async () => {
    const out = tick({ executeOwedReruns: () => { throw Error('offline'); }, log: () => { throw Error('logger'); } });
    expect((await out.owedCiReruns).refused).toHaveLength(13);
  });
  it('daemon awaits mechanical completion before finishing its tick', async () => {
    let release; let finished = false;
    const owedCiReruns = new Promise(resolve => { release = resolve; });
    const effects = buildCliDaemonEffects({ owner: 'test', log: { error: () => {} }, reapSessions: () => null,
      runReview: () => ({ repos: [{ repo, result: { owedCiReruns } }] }),
      runConvertAdvisories: async () => null, runPrepReview: async () => null });
    const pending = effects.tickOnce().then(() => { finished = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    release(); await pending; expect(finished).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../../../scripts/lib/review-facts.mjs', async (original) => ({
  ...await original(), warmReviewFacts: async () => ({ skipped: 'test' }),
}));
import {
  runReviewTick, runReviewTickAllRepos, runConvertAdvisoryTick,
  runConvertAdvisoryTickAllRepos, buildCliDaemonEffects, resolveReviewTickSharing,
} from '../review-daemon.mjs';

const repo = 'web-everything/web-everything';
const empty = () => ({ dispatch: [], refusals: [] });
const reviewOpts = { holdReconcile: () => [], statusCandidates: () => [] };
const authGateOverride = () => ({ paused: false, reason: null });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('review tick plan sharing', () => {
  it('snapshots the final replacement plan and withholds it when promotion replanning fails, leaving onPlan unchanged', () => {
    const rawPrs = [{ number: 7, isDraft: true, labels: [] }];
    const first = { dispatch: [{ kind: 'promote-draft', prNumber: 7 }], refusals: [{ kind: 'stood-down', prNumber: 1 }] };
    const replacement = { dispatch: [], refusals: [{ kind: 'cap-exhausted', prNumber: 2 }] };
    const run = (second) => {
      const onPlan = vi.fn();
      const out = runReviewTick({ ...reviewOpts, repo, readPrs: () => rawPrs, readAgents: () => [], onPlan, now: () => 3,
        reconcile: vi.fn().mockReturnValueOnce(first).mockImplementationOnce(second),
        promoteDrafts: () => ({ rows: [{ pr: 7, action: 'promoted' }] }) });
      return { out, onPlan };
    };
    const ok = run(() => replacement);
    expect(ok.out.operatorHolds).toEqual({ observedAt: 3, holds: [{ prNumber: 2, kind: 'cap-exhausted' }] });
    expect(ok.onPlan).toHaveBeenCalledWith({ repo, plan: replacement, rawPrs: [{ ...rawPrs[0], isDraft: false }] });
    const failed = run(() => { throw Error('replan'); });
    expect(failed.out.operatorHolds).toBeNull();
    expect(failed.onPlan).toHaveBeenCalledWith({ repo, plan: first, rawPrs: [{ ...rawPrs[0], isDraft: false }] });
  });
  it('reports the acted-on plan and raw listing without changing the return shape; callback errors are isolated', () => {
    const plan = empty();
    const opts = { ...reviewOpts, repo, reconcile: () => plan, now: () => 5 };
    const baseline = runReviewTick(opts);
    const onPlan = vi.fn();
    expect(runReviewTick({ ...opts, onPlan })).toEqual(baseline);
    expect(onPlan).toHaveBeenCalledWith({ repo, plan, rawPrs: null });
    expect(runReviewTick({ ...opts, onPlan: () => { throw Error('observer'); } })).toEqual(baseline);
  });
  it('reports the replacement plan and promoted snapshot, reading PRs once before the hold sweep', () => {
    const rawPrs = [{ number: 7, isDraft: true, labels: [] }];
    const replacement = empty();
    const readPrs = vi.fn(() => rawPrs);
    const onPlan = vi.fn();
    const holdReconcile = vi.fn(({ listPrs }) => {
      expect(readPrs).toHaveBeenCalledTimes(1);
      expect(listPrs()).toBe(rawPrs);
      return [];
    });
    const reconcile = vi.fn().mockReturnValueOnce({ dispatch: [{ kind: 'promote-draft', prNumber: 7 }] }).mockReturnValueOnce(replacement);
    runReviewTick({ ...reviewOpts, repo, holdReconcile, readPrs, readAgents: () => [], reconcile, onPlan,
      promoteDrafts: () => ({ rows: [{ pr: 7, action: 'promoted' }] }),
    });
    expect(readPrs).toHaveBeenCalledTimes(1);
    expect(onPlan).toHaveBeenCalledWith({ repo, plan: replacement, rawPrs: [{ ...rawPrs[0], isDraft: false }] });
  });
  it('still sweeps independently when the shared PR read fails, and never reports a missing plan', () => {
    const holdReconcile = vi.fn(() => []);
    const onPlan = vi.fn();
    const out = runReviewTick({ ...reviewOpts, holdReconcile, onPlan,
      readPrs: () => { throw Error('listing'); }, readAgents: () => [], reconcile: vi.fn(),
    });
    expect(holdReconcile).toHaveBeenCalledOnce();
    expect(out.reconcileError).toBeTruthy();
    expect(onPlan).not.toHaveBeenCalled();
  });
  it('convert uses cached entries and comments/labels with no reads; a missing entry follows the original path', async () => {
    const plan = { dispatch: [{ kind: 'convert-advisory', prNumber: 7 }] };
    const rawPrs = [{ number: 7, comments: [{ body: 'evidence' }], labels: ['review:human'] }];
    const reconcile = vi.fn(() => plan);
    const readPrs = vi.fn(() => rawPrs);
    const readAgents = vi.fn(() => []);
    const convertAdvisory = vi.fn(async () => ({ targetedCheckAnswer: { verdict: 'accept' } }));
    const opts = { repo, reconcile, readPrs, readAgents, convertAdvisory };
    const cached = await runConvertAdvisoryTick({ ...opts, plans: new Map([[repo, { plan, rawPrs }]]) });
    expect(reconcile).not.toHaveBeenCalled();
    expect(readPrs).not.toHaveBeenCalled();
    expect(readAgents).not.toHaveBeenCalled();
    expect(convertAdvisory).toHaveBeenCalledWith(plan.dispatch[0], { repo, comments: rawPrs[0].comments, labels: rawPrs[0].labels, dryRun: false });
    expect(await runConvertAdvisoryTick({ ...opts, plans: new Map() })).toEqual(cached);
    expect(reconcile).toHaveBeenCalledOnce();
  });
  it.each([1, 3])('bounds overlapping convert work to %i and preserves order and failures', async (concurrency) => {
    const repos = ['a', 'b', 'c', 'd'];
    const plans = new Map();
    let active = 0, peak = 0;
    const tick = async ({ repo: r, plans: forwarded }) => {
      expect(forwarded).toBe(plans);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, r === 'a' ? 25 : 5));
      active--;
      if (r === 'b') throw Error('isolated');
      return { posted: [{ prNumber: 1 }], convertAdvisoriesOwed: 1 };
    };
    const out = await runConvertAdvisoryTickAllRepos({ repos, plans, concurrency, tick });
    expect(peak).toBe(concurrency);
    expect(out.repos.map((r) => r.repo)).toEqual(repos);
    expect(out.posted.map((r) => r.repo)).toEqual(['a', 'c', 'd']);
    expect(out.failed).toEqual([{ repo: 'b', prNumber: null, error: 'isolated' }]);
  });
  it('times every review repo, including failures, without changing repo entries', () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const out = runReviewTickAllRepos({ repos: ['a', 'b'], tick: ({ repo: r }) => {
      now += 12;
      if (r === 'b') throw Error('failed');
      return { reviewsOwed: 0, refusals: 0, dispatched: [], failed: [] };
    } });
    expect(out.perRepoMs).toEqual({ a: 12, b: 12 });
    expect(out.repos[1]).toEqual({ repo: 'b', error: 'failed' });
  });
  it.each(['1', '0'])('CLI tick shares only its own plans with reusePlan=%s and logs phase timings', async (reuse) => {
    vi.stubEnv('WE_REVIEW_REUSE_PLAN', reuse);
    vi.stubEnv('WE_REVIEW_PHASE_TIMINGS', '1');
    vi.stubEnv('WE_REVIEW_REPO_CONCURRENCY', '3');
    const repos = [repo, 'frontier-ui/frontierui', 'plateauapp/plateau-app'];
    const reconcile = vi.fn(empty);
    const opts = { ...reviewOpts, reconcile, readPrs: () => [], readAgents: () => [] };
    const lines = [];
    const maps = [];
    const effects = buildCliDaemonEffects({ owner: 'test', log: { error: (line) => lines.push(line) },
      reapSessions: () => null, runPrepReview: () => null, convertAdvisoryEnabled: true,
      runReview: (o) => { maps.push(o.plans); return runReviewTickAllRepos({ ...opts, repos, authGateOverride, ...o }); },
      runConvertAdvisories: (o) => runConvertAdvisoryTickAllRepos({ ...opts, repos, ...o }),
    });
    await effects.tickOnce();
    expect(reconcile).toHaveBeenCalledTimes(reuse === '1' ? 3 : 6);
    expect(lines.filter((l) => l.includes('pass timings'))).toEqual([expect.stringMatching(/total \d+\.\d+s — reap .*facts .*review .*web-everything .*frontierui .*plateau-app .*convert .*prep .*reusePlan=.*source env.*repoConcurrency=3 \(source env\)/)]);
    await effects.tickOnce();
    expect(maps[0]).toBeInstanceOf(Map);
    expect(maps[1]).not.toBe(maps[0]);
  });
  it.each(['1', '0'])('logs measured phases only when phaseTimings=%s, retaining default-arg overrides', async (enabled) => {
    vi.stubEnv('WE_REVIEW_PHASE_TIMINGS', enabled);
    vi.stubEnv('WE_REVIEW_REUSE_PLAN', '1');
    vi.stubEnv('WE_REVIEW_REPO_CONCURRENCY', '3');
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const lines = [];
    await buildCliDaemonEffects({ owner: 'test', log: { error: (line) => lines.push(line) },
      reapSessions: () => { now += 100; },
      runReview: (opts = {}) => { now += 200; return { perRepoMs: { [repo]: 200 } }; },
      runConvertAdvisories: (opts = {}) => { now += 300; },
      runPrepReview: () => { now += 400; }, convertAdvisoryEnabled: true,
    }).tickOnce();
    expect(lines.filter((line) => line.includes('pass timings'))).toEqual(enabled === '1' ? [
      'review-daemon: pass timings total 1.0s — reap 0.1s, facts 0.0s, review 0.2s (web-everything 0.2s), convert 0.3s, prep 0.4s · reusePlan=true (source env) repoConcurrency=3 (source env)',
    ] : []);
  });
  it('resolves valid env leaves over platform preferences; rejects invalid values and tolerates broken env access', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-sharing-'));
    try {
      const file = join(dir, 'preferences.json');
      writeFileSync(file, JSON.stringify({ reviewTickSharing: { reusePlan: false, repoConcurrency: 2, phaseTimings: false } }));
      const env = { WE_PLATFORM_PREFERENCES_FILE: file, WE_POLICY_CASCADE_LOG: '0' };
      expect(resolveReviewTickSharing(env)).toEqual({ reusePlan: false, repoConcurrency: 2, phaseTimings: false,
        source: { reusePlan: 'platform', repoConcurrency: 'platform', phaseTimings: 'platform' } });
      expect(resolveReviewTickSharing({ ...env, WE_REVIEW_REUSE_PLAN: '1', WE_REVIEW_REPO_CONCURRENCY: '8', WE_REVIEW_PHASE_TIMINGS: '0' })).toEqual({ reusePlan: true, repoConcurrency: 8, phaseTimings: false,
        source: { reusePlan: 'env', repoConcurrency: 'env', phaseTimings: 'env' } });
      for (const value of ['0', '9', '1.5', 'bad', '']) {
        expect(resolveReviewTickSharing({ ...env, WE_REVIEW_REPO_CONCURRENCY: value, WE_REVIEW_REUSE_PLAN: 'true', WE_REVIEW_PHASE_TIMINGS: '2' })).toEqual(resolveReviewTickSharing(env));
      }
      expect(resolveReviewTickSharing({ WE_PLATFORM_PREFERENCES_FILE: join(dir, 'missing') })).toEqual({ reusePlan: true, repoConcurrency: 3, phaseTimings: true,
        source: { reusePlan: 'standard', repoConcurrency: 'standard', phaseTimings: 'standard' } });
      expect(() => resolveReviewTickSharing(new Proxy({}, { get: () => { throw Error('env'); } }))).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

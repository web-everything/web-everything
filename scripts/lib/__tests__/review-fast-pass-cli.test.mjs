import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as reconcile from '../../conveyor/reconcile-pass.mjs';
import * as auth from '../../conveyor/claude-auth-health.mjs';
import * as profile from '../repo-profile.mjs';
import * as leases from '../../../skills-src/conveyor/runner-lock.mjs';
import * as githubAuth from '../github-app-auth-env.mjs';
import { REVIEW_FAST_PASS_LEASE_KEY, fastPassOptions, runFastPassCli, saveFastPlan } from '../review-fast-pass-cli.mjs';
afterEach(() => vi.restoreAllMocks());

function adapter() {
  return fastPassOptions({ repo: 'fixture/repo', options: { readAgents: vi.fn(), dispatch: vi.fn(), hostAdmission: vi.fn() },
    liveReviewRoundBudget: () => ({ max: 3, left: 2 }), log: vi.fn() });
}
it('auth pause prevents planning', () => {
  vi.spyOn(auth, 'planClaudeAuthDispatchGate').mockReturnValue({ paused: true, reason: 'login expired' });
  vi.spyOn(profile, 'assertCapability').mockReturnValue(null);
  const plan = vi.spyOn(reconcile, 'runReconcilePass').mockReturnValue({});
  expect(() => adapter().planOne({ pr: {}, agents: [] })).toThrow('login expired');
  expect(plan).not.toHaveBeenCalled();
});
it('capability refusal prevents planning', () => {
  vi.spyOn(auth, 'planClaudeAuthDispatchGate').mockReturnValue({ paused: false });
  vi.spyOn(profile, 'assertCapability').mockReturnValue({ why: 'review disabled' });
  const plan = vi.spyOn(reconcile, 'runReconcilePass').mockReturnValue({});
  expect(() => adapter().planOne({ pr: {}, agents: [] })).toThrow('review disabled');
  expect(plan).not.toHaveBeenCalled();
});
it('uses the full fresh single-PR planner with no cached main-red enrichment', () => {
  vi.spyOn(auth, 'planClaudeAuthDispatchGate').mockReturnValue({ paused: false });
  vi.spyOn(profile, 'assertCapability').mockReturnValue(null);
  const plan = vi.spyOn(reconcile, 'runReconcilePass').mockReturnValue({});
  const pr = { number: 3 }, agents = [{ pid: 4 }];
  adapter().planOne({ pr, agents });
  const o = plan.mock.calls[0][0];
  expect(o).toMatchObject({ repo: 'fixture/repo', readOnly: true });
  expect(o.readPrs()).toEqual([pr]); expect(o.readAgents()).toBe(agents);
  expect(o.enrichMainRed).toBeUndefined();
});
it('uses current job records and fresh process ceiling when computing total capacity', () => {
  const budget = vi.fn().mockReturnValueOnce({ max: 3, left: 0 }).mockReturnValueOnce({ max: 3, left: 2 });
  const o = fastPassOptions({ repo: 'fixture/repo', options: {}, liveReviewRoundBudget: budget, log: vi.fn() });
  expect(o.liveCap({ jobs: [] })).toBe(0);
  expect(o.liveCap({ jobs: [{ pid: 5 }] })).toBe(3);
  expect(budget).toHaveBeenCalledTimes(2);
});
it('atomically replaces the per-repo snapshot including raw PRs, main SHA and save time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-plan-'));
  try {
    const path = join(dir, 'plan.json'), snapshot = { repo: 'fixture/repo', plan: { dispatch: [] }, rawPrs: [], mainSha: 'main' };
    saveFastPlan(snapshot, { path, now: () => 1 });
    saveFastPlan({ ...snapshot, rawPrs: [{ number: 4 }] }, { path, now: () => 2 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ plan: snapshot.plan, rawPrs: [{ number: 4 }], mainSha: 'main', savedAt: 2 });
    expect(readdirSync(dir)).toEqual(['plan.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('a second fast pass refuses its own lease before any discovery', async () => {
  vi.spyOn(leases, 'acquireRunnerLease').mockReturnValue({ ok: false });
  const loop = vi.fn();
  await runFastPassCli({ repos: [], env: {}, runDaemonLoop: loop, log: vi.fn() });
  expect(leases.acquireRunnerLease).toHaveBeenCalledWith(expect.anything(), expect.anything(), { key: '<conveyor:review-fast-pass-lease>' });
  expect(REVIEW_FAST_PASS_LEASE_KEY).not.toBe('<conveyor:review-daemon-lease>');
  expect(loop).not.toHaveBeenCalled();
});
it('once configures one tick, heartbeats its lease and releases it on failure', async () => {
  vi.spyOn(leases, 'acquireRunnerLease').mockReturnValue({ ok: true });
  vi.spyOn(leases, 'heartbeatRunnerLease').mockReturnValue(true);
  vi.spyOn(leases, 'releaseRunnerLeaseIfOwned').mockReturnValue(true);
  vi.spyOn(githubAuth, 'withGithubAppAuth').mockImplementation(effects => effects);
  const loop = vi.fn(async effects => {
    expect(effects.maxTicks).toBe(1); expect(effects.intervalMs).toBe(90000);
    expect(effects.heartbeat()).toBe(true);
    await effects.tickOnce();
    throw Error('test loop stopped');
  });
  const log = vi.fn();
  await expect(runFastPassCli({ repos: [], once: true, env: { WE_REVIEW_FAST_PASS_INTERVAL_MS: '90000' }, runDaemonLoop: loop, log })).rejects.toThrow('test loop stopped');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('source: env'));
  expect(leases.heartbeatRunnerLease).toHaveBeenCalledWith(expect.anything(), expect.anything(), { key: REVIEW_FAST_PASS_LEASE_KEY });
  expect(leases.releaseRunnerLeaseIfOwned).toHaveBeenCalledTimes(1);
});

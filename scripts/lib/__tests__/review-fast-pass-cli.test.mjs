import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as reconcile from '../../conveyor/reconcile-pass.mjs';
import * as auth from '../../conveyor/claude-auth-health.mjs';
import * as profile from '../repo-profile.mjs';
import * as leases from '../../../skills-src/conveyor/runner-lock.mjs';
import * as selfSync from '../daemon-self-sync.mjs';
import * as githubAuth from '../github-app-auth-env.mjs';
import { REVIEW_FAST_PASS_LEASE_KEY, fastPassOptions, runFastPassCli, saveFastPlan } from '../review-fast-pass-cli.mjs';
afterEach(() => vi.restoreAllMocks());

function adapter() {
  return fastPassOptions({ repo: 'fixture/repo', options: { readAgents: vi.fn(), dispatch: vi.fn(), hostAdmission: vi.fn() },
    budget: { max: 3, left: 2, reserve: 0 }, log: vi.fn() });
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
it('uses the ordinary shared budget and retains its recovery reserve', () => {
  const budget = { max: 3, left: 2, reserve: 1 };
  const o = fastPassOptions({ repo: 'fixture/repo', options: { liveReviewBudget: budget }, log: vi.fn() });
  expect(o.liveCap({ jobs: [] })).toBe(1);
  budget.left = 1;
  expect(o.liveCap({ jobs: [{ pid: 5 }] })).toBe(1);
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
  vi.spyOn(selfSync, 'withSelfSync').mockImplementation(effects => effects);
  const loop = vi.fn(async effects => {
    expect(effects.maxTicks).toBe(1); expect(effects.intervalMs).toBe(90000);
    expect(effects.heartbeat()).toBe(true);
    await effects.tickOnce();
    throw Error('test loop stopped');
  });
  const log = vi.fn();
  await expect(runFastPassCli({ repos: [], cliReviewTickOpts: () => ({}), sharedHostBudget: () => () => ({}), once: true, env: { WE_REVIEW_FAST_PASS_INTERVAL_MS: '90000' }, runDaemonLoop: loop, log })).rejects.toThrow('test loop stopped');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('source: env'));
  expect(leases.heartbeatRunnerLease).toHaveBeenCalledWith(expect.anything(), expect.anything(), { key: REVIEW_FAST_PASS_LEASE_KEY });
  expect(leases.releaseRunnerLeaseIfOwned).toHaveBeenCalledTimes(2);
});

it('rejects a full 300-row listing before filtering pending labels', () => {
  const gh = vi.fn(() => JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ number: i + 1, labels: i === 0 ? ['review:pending'] : [] }))));
  const o = fastPassOptions({ repo: 'fixture/repo', options: {}, io: { gh } });
  expect(() => o.readPr({ pending: true })).toThrow('inventory truncated');
});
it('reads each repository remote main tip, and refuses unreadable main', () => {
  const gh = vi.fn(args => args[1].includes('first/repo') ? 'a'.repeat(40) : 'b'.repeat(40));
  const make = repo => fastPassOptions({ repo, options: {}, io: { gh } });
  expect(make('first/repo').mainSha()).toBe('a'.repeat(40));
  expect(make('second/repo').mainSha()).toBe('b'.repeat(40));
  gh.mockReturnValue(''); expect(() => make('second/repo').mainSha()).toThrow('remote main unknown');
});
it.each([undefined, { offline: true }, {}])('refuses unknown freshness evidence %s', evidence => {
  const spawn = vi.fn();
  const o = fastPassOptions({ repo: 'fixture/repo', options: { dispatch: args => { args.checkStaleness('/fixture'); spawn(); } },
    io: { readLivePr: () => ({ headRefOid: 'a'.repeat(40) }), staleness: () => evidence } });
  expect(() => o.dispatch({ pr: 1, expectedHead: 'a'.repeat(40) })).toThrow('freshness unknown');
  expect(spawn).not.toHaveBeenCalled();
});
it('refuses a head change immediately before dispatch, including session mode', () => {
  const dispatch = vi.fn();
  const o = fastPassOptions({ repo: 'fixture/repo', options: { dispatch }, io: { readLivePr: () => ({ headRefOid: 'b'.repeat(40) }) } });
  expect(() => o.dispatch({ pr: 1, expectedHead: 'a'.repeat(40) })).toThrow('head moved');
  expect(dispatch).not.toHaveBeenCalled();
});

it.each(['writer', 'unreadable', 'quarantine', 'ordinary', 'reserve', 'lanes', 'throw', 'ok'])('CLI integration admission: %s', async kind => {
  const { exerciseFastCli } = await import('./fixtures/review-fast-cli-integration.mjs');
  expect(await exerciseFastCli([kind])).toEqual({ violations: [] });
});

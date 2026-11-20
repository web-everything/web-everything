import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let directory, file, daemon, production, readLivePr, recovery, dispatch, entries, reconcile;
const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40);

beforeEach(async () => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), 'partial-red-team-'));
  file = join(directory, 'queue.json');
  entries = Array.from({ length: 7 }, (_, i) => ({ key: `${repo}#${i + 1}`, repo, pr: i + 1,
    head, enqueuedAt: 1, attempts: 0, ...(i === 6 ? {} : { blocked: 'planner-skip' }) }));
  writeFileSync(file, JSON.stringify(entries));
  vi.stubEnv('WE_RED_TEAM_QUEUE_FILE', file);
  vi.stubEnv('WE_RED_TEAM_DISPATCH_QUEUE', 'on');
  const store = await import('../../../scripts/lib/operator-override-reader.mjs');
  vi.spyOn(store, 'readOperatorOverrides').mockReturnValue({ readable: true, values: {} });
  const { buildReviewedShaMarker } = await import('../../../scripts/lib/review-escalation.mjs');
  readLivePr = vi.fn(({ pr }) => pr === 6 ? null : ({ number: pr, state: pr === 4 ? 'CLOSED' : 'OPEN',
    isDraft: pr === 3, headRefOid: pr === 5 ? 'b'.repeat(40) : head, headRefName: 'lane/accepted',
    baseRefName: 'main', mergeStateStatus: 'CLEAN',
    labels: ['review:accepted', 'ready-to-merge', 'red-team:pending'].map(name => ({ name })),
    comments: [{ body: buildReviewedShaMarker(head), author: { login: 'web-everything' } }],
    statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }] }));
  const labels = await import('../../../scripts/lib/red-team-result-label-sync.mjs');
  vi.spyOn(labels, 'syncResultOnHeadLabels').mockImplementation(({ rawPrs }) => ({ rawPrs }));
  const catchup = await import('../../../scripts/lib/red-team-gate-catchup.mjs');
  vi.spyOn(catchup, 'runGateCatchUp').mockReturnValue({});
  const module = await import('../../../scripts/lib/review-red-team-on-skip.mjs');
  const realRecovery = module.runRedTeamOnSkip;
  dispatch = vi.fn(() => ({ jobPid: 42 }));
  recovery = vi.spyOn(module, 'runRedTeamOnSkip').mockImplementation(options => realRecovery({ ...options,
    dispatch, readEvidence: ({ head: rev }) => ({ recorded: false, loopPayload: {
      verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev } } } } }),
    readReviews: () => [], readStatus: () => null, lastDispatch: new Map(),
    setting: { enabled: true, retryCooldownMin: 30 } }));
  const { planReconcile } = await import('../../../scripts/conveyor/reconcile-core.mjs');
  reconcile = vi.fn(options => {
    const plan = planReconcile({ repo: 'we', prs: options.readPrs(), agents: options.readAgents(),
      requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' } });
    // Even an unrelated row from a planner must never be admitted on incomplete discovery.
    plan.refusals.push({ kind: 'already-reviewed-head', prNumber: 99, headSha: head });
    return plan;
  });
  daemon = await import('../review-daemon.mjs');
  production = daemon.cliReviewTickOpts({ readLivePr, log: { error: vi.fn() }, listCommands: () => [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function tick({ hostAdmission = () => ({ admitted: true, maxPerTick: 2 }), paused = false,
  error } = {}) {
  const { assertInventoryComplete } = await import('../../../scripts/lib/pr-list-paged.mjs');
  const readPrs = () => {
    if (error) throw error;
    assertInventoryComplete({ repo, rows: [], totalCount: 9 });
  };
  return daemon.runReviewTick({ ...production, repo, readPrs, readAgents: () => [], reconcile,
    holdReconcile: () => [], paused, hostAdmission, recoveryAcquirableLanes: () => 2,
    liveReviewBudget: { left: 2 }, dispatch: vi.fn() });
}

it('partial inventory probes only live matching blocked heads while retaining entries and refusing unknown and draft PRs', async () => {
  const result = await tick();
  expect(result.reconcileError).toContain('partial inventory');
  expect(recovery).toHaveBeenCalledOnce();
  expect(recovery.mock.calls[0][0].plan.refusals.map(row => row.prNumber)).toEqual([1, 2]);
  expect(recovery.mock.calls[0][0].rawPrs.map(pr => pr.number)).toEqual([1, 2]);
  expect(dispatch.mock.calls.map(([options]) => options.pr)).toEqual([1, 2]);
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  expect(persisted.map(({ lastProbeTurn, ...entry }) => entry)).toEqual(entries);
  expect(persisted.slice(0, 2).every(entry => entry.lastProbeTurn > 0)).toBe(true);
  expect(readLivePr.mock.calls.map(([args]) => args.pr)).not.toContain(99);
});

it.each(['denied', 'null', 'throws'])('partial inventory host admission fails closed when %s', async state => {
  await tick({ hostAdmission: () => {
    if (state === 'throws') throw Error('host unknown');
    return state === 'null' ? null : { admitted: false, maxPerTick: 2 };
  } });
  expect(recovery).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
  expect(recovery.mock.calls[0][0].capacity.remainingStarts).toBe(0);
  expect(JSON.parse(readFileSync(file, 'utf8')).map(({ lastProbeTurn, ...entry }) => entry)).toEqual(entries);
});

it('partial inventory paused ticks retain all entries without probing', async () => {
  await tick({ paused: true });
  expect(recovery).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(entries);
});

it('truncated inventory probes only known heads without evicting entries', async () => {
  await tick({ error: Object.assign(Error('open-PR list hit its cap'), { code: 'pr-list-truncated' }) });
  expect(recovery).toHaveBeenCalledOnce();
  expect(recovery.mock.calls[0][0].plan.refusals.map(row => row.prNumber)).toEqual([1, 2]);
  expect(JSON.parse(readFileSync(file, 'utf8')).map(({ lastProbeTurn, ...entry }) => entry)).toEqual(entries);
});

it('other list failures do not enable partial inventory probing or enqueue unknown PRs', async () => {
  await tick({ error: Error('authentication failed') });
  expect(reconcile).not.toHaveBeenCalled();
  expect(recovery).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(entries);
});

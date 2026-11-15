// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => ({ active: false, writes: [], commands: [] }));
vi.mock('node:fs', async original => {
  const fs = await original();
  const out = { ...fs };
  for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'unlinkSync', 'writeFile', 'appendFile']) {
    out[name] = (...args) => { if (probe.active) { probe.writes.push(name); return; } return fs[name](...args); };
  }
  out.readdirSync = (path, ...args) => String(path) === 'fixture-jobs' ? ['review-1.json'] : fs.readdirSync(path, ...args);
  out.readFileSync = (path, ...args) => String(path) === 'fixture-jobs/review-1.json'
    ? JSON.stringify({ slug: 'review-1', pid: 99999999, pr: 1 }) : fs.readFileSync(path, ...args);
  return out;
});
vi.mock('node:child_process', async original => ({ ...await original(), execFileSync: vi.fn((file, args) => {
  probe.commands.push([file, args]);
  if (file === 'gh' && (args.some(a => ['edit', 'comment', 'rerun', 'merge'].includes(a)) || args.includes('--method'))) throw new Error('forbidden GitHub write');
  if (file === 'git' && (args.includes('fetch') || args.includes('--write-tree'))) throw new Error('forbidden Git write');
  return file === 'claude' ? '[]' : '';
}) }));
vi.mock('../../lib/gh-throttle.mjs', async original => ({ ...await original(), execFileSyncThrottled: vi.fn(() => '[]') }));
vi.mock('../../operations/dispatch-lane-io.mjs', () => ({ REPO_ROOT: process.cwd(), defaultListAgents: vi.fn(() => []) }));
vi.mock('../reconcile-core.mjs', async original => ({ ...await original(), planReconcile: vi.fn(() => ({ dispatch: [], refusals: [], notes: [] })) }));
import { defaultListAgents } from '../../operations/dispatch-lane-io.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { runReconcilePass, enrichAgents, defaultReadAgents, enrichPrsWithLedgerHolds, withRestAuthors } from '../reconcile-pass.mjs';
import { listReviewJobAgents, listAgentsWithReviewJobs } from '../../operations/review-job-store.mjs';
const identity = prs => prs;
const options = () => ({
  readPrs: () => [{ number: 1, headRefOid: 'a'.repeat(40), labels: [], comments: [], statusCheckRollup: [] }],
  readAgents: opts => defaultReadAgents({ ...opts, exec: () => '[]', listJobs: jobOpts => listReviewJobAgents({ ...jobOpts, dir: 'fixture-jobs', isAlive: () => false }) }),
  readRequiredChecks: () => ({ checks: ['fixture-check'] }), resolveMainSha: () => null,
  enrichMainRed: prs => ({ prs, mainRedWindows: [] }), enrichAlreadyLanded: identity,
  enrichBaseRef: identity, enrichSystemFix: identity, enrichEscalationBase: identity,
  enrichFixClaims: identity, enrichTimeouts: identity, enrichReferralHolds: identity,
  enrichRulings: identity, enrichScopeBloat: identity, enrichCodeQL: identity,
  enrichOwedMainRule: identity, enrichStandingRulingGrants: identity,
  loadMechanicalRoundsSetting: () => ({ value: true, source: 'fixture' }),
  env: {}, stepLog: () => {},
});
afterEach(() => { probe.active = false; vi.unstubAllEnvs(); });
beforeEach(() => { probe.writes = []; probe.commands = []; probe.active = true; vi.clearAllMocks(); });
describe('read-only live reconciliation', () => {
  it('performs zero filesystem writes, including dead-job cleanup, and returns exact planner inputs', () => {
    const result = runReconcilePass({ ...options(), readOnly: true, allowStandDownAutoProceed: true,
      enrichStandDownAutoProceed: () => { throw new Error('writer must be skipped'); } });
    expect(probe.writes).toEqual([]);
    const passed = planReconcile.mock.calls[0][0];
    expect(result.enrichedPrs).toBe(passed.prs); expect(result.agentList).toBe(passed.agents);
    const { prs, agents, repo, now, durableCounts, ...rest } = passed;
    expect(result.plannerOptions).toEqual(rest);
    expect(result.plannerOptions.shadowDeps.mode).toBe('off');
    expect(result.agentsIncomplete).toBe(false);
  });
  it('default mode still removes dead review-job records and keeps the old result shape', () => {
    const result = runReconcilePass(options());
    expect(probe.writes).toContain('rmSync');
    expect(result).not.toHaveProperty('enrichedPrs');
  });
  it('preserves the non-enumerable incomplete marker through merged listings and enrichment', () => {
    const incomplete = ['unreadable-worker'];
    const wrapped = Object.defineProperty([], 'incomplete', { value: incomplete });
    const listed = listAgentsWithReviewJobs({ listAgents: () => [], listJobs: () => [], listWrapped: () => wrapped });
    expect(enrichAgents(listed).incomplete).toBe(incomplete);
    const result = runReconcilePass({ ...options(), readOnly: true, readAgents: () => listed });
    expect(result.agentsIncomplete).toBe(true);
  });
  it('injects a no-op ledger journal even when journaling is configured', () => {
    let received;
    enrichPrsWithLedgerHolds([], { readOnly: true, env: {}, step: (prs, opts) => {
      received = opts; opts.journal([{ evidence: true }]); return { prs, summary: null };
    } });
    expect(received.journal).toBeTypeOf('function');
    expect(probe.writes).toEqual([]);
  });
  it('does not persist newly resolved PR authors', () => {
    vi.stubEnv('WE_PR_SNAPSHOT_DIR', 'fixture-author-cache');
    vi.stubEnv('WE_PR_SNAPSHOT', '1');
    withRestAuthors([{ number: 9285454 }], { repo: 'fixture/read-only', readOnly: true,
      readRest: () => ({ json: { user: { login: 'fixture' } } }) });
    expect(probe.writes).toEqual([]);
  });
});

it('disables the Claude listing disk cache in read-only mode', () => {
  defaultReadAgents({ readOnly: true, listJobs: () => [], env: {} });
  expect(defaultListAgents).toHaveBeenCalledWith(expect.objectContaining({ env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' } }));
});
it('disables the REST author disk cache in read-only mode', () => {
  const readRest = vi.fn(() => ({ json: { user: { login: 'fixture' } } }));
  withRestAuthors([{ number: 9285455 }], { repo: 'fixture/read-only', readOnly: true, readRest });
  expect(readRest).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ env: expect.objectContaining({ WE_GH_ETAG_CACHE: '0' }) }));
});
it('supplies mechanical enrichment with readers that skip Git fetch and object writes', () => {
  const mechanical = vi.fn((prs, opts) => {
    expect(opts.readFacts).toBeTypeOf('function');
    expect(opts.readRoundCommits).toBeTypeOf('function');
    return prs;
  });
  runReconcilePass({ ...options(), readOnly: true, enrichMechanicalRound: mechanical,
    loadMechanicalRoundsSetting: () => ({ value: false, source: 'fixture' }) });
  expect(mechanical).toHaveBeenCalledOnce();
});

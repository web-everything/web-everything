/**
 * @file scripts/operations/__tests__/ci-ghost-rerun.test.mjs
 * @description Hermetic ghost recovery, cancellation, audit, cap and settings guarantees.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStateStore, defaultGh, detectGhostJobs, parseArgs, runCiGhostRerun } from '../ci-ghost-rerun.mjs';
import { readCiGhostRerunSettings } from '../../lib/ci-ghost-rerun-settings.mjs';
import { readDeclaredSettings, SETTINGS_DIR } from '../../lib/settings-files.mjs';
import { readPlatformPreferences } from '../../lib/policy-cascade.mjs';
import { execFileSyncThrottled } from '../../lib/gh-throttle.mjs';
import { readTimeoutBudget, timeoutKey, readTimeoutStates } from '../../conveyor/timeout-retry-state.mjs';

vi.mock('../../lib/gh-throttle.mjs', async importOriginal => ({
  ...await importOriginal(), execFileSyncThrottled: vi.fn(),
}));
vi.mock('../../conveyor/timeout-retry-state.mjs', async importOriginal => ({
  ...await importOriginal(), readTimeoutStates: vi.fn(),
}));

const temporaryDirs = [];
afterEach(() => {
  temporaryDirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

const NOW = Date.parse('2026-11-16T12:00:00Z');
const HEAD = 'a'.repeat(40);
const settings = { thresholdMin: 15, maxPerWindow: 1, maxPerHead: 1, windowHours: 2, cancelWaitSec: 10 };
const options = { repo: 'web-everything/web-everything', pr: 42, actor: 'operator', channel: 'manual recovery' };
const ghost = () => ({ id: 7, run_id: 9, run_attempt: 2, status: 'in_progress', steps: [
  { status: 'completed', conclusion: 'success', completed_at: '2026-11-16T11:30:00Z' },
  { status: 'completed', conclusion: 'success', completed_at: '2026-11-16T11:40:00Z' },
] });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-ghost-shared-'));
  temporaryDirs.push(dir);
  const f = { dir, head: HEAD, pullState: 'open', job: ghost(), rows: [], posts: [], trace: [],
    statuses: ['in_progress', 'completed'], now: NOW, runHead: HEAD, total: 1 };
  let posted = false;
  f.gh = vi.fn(async args => {
    const path = args[1];
    const method = args[3];
    const repo = path.split('/').slice(1, 3).join('/');
    const checkUrl = `https://api.github.com/repos/${repo}/check-runs/70`;
    if (method === 'POST') {
      f.posts.push(path.split('/').at(-1));
      f.trace.push(f.posts.at(-1));
      posted = true;
      return null;
    }
    if (/\/pulls\/\d+$/.test(path)) return { state: f.pullState, head: { sha: f.head } };
    if (path.includes('/check-runs?')) return { total_count: f.total, check_runs: f.checks ?? [
      { id: 70, url: checkUrl, details_url: `https://github.com/${repo}/actions/runs/9/job/7`,
        status: 'in_progress', app: { slug: 'github-actions' } },
    ] };
    if (path.endsWith('/runs/9/attempts/2/jobs?per_page=100')) return {
      total_count: f.jobsTotal ?? 1,
      jobs: f.listedJobs ?? [{ id: 7, run_id: 9, run_attempt: 2, status: 'in_progress', check_run_url: checkUrl }],
    };
    if (path.endsWith('/jobs/7')) return { check_run_url: checkUrl, ...f.job };
    if (path.endsWith('/runs/9')) return { id: 9, head_sha: f.runHead, run_attempt: posted ? (f.pollAttempt ?? 2) : 2,
      status: posted ? (f.statuses.length > 1 ? f.statuses.shift() : f.statuses[0]) : 'in_progress',
      conclusion: f.conclusion === undefined ? 'cancelled' : f.conclusion };
    throw new Error(`Unexpected fake route: ${path}`);
  });
  f.state = { read: () => f.rows, append: row => f.rows.push(structuredClone(row)),
    withLock: fn => { posted = false; return fn(); } };
  f.deps = { gh: f.gh, state: f.state, clock: () => f.now, settings,
    readSharedRerunStates: vi.fn(() => []), sharedStateDir: dir,
    sleep: async ms => { f.trace.push('wait'); f.now += ms; } };
  f.sharedPath = join(dir, `${timeoutKey({ repo: 'web-everything/web-everything', pr: 42, head: HEAD })}.json`);
  f.shared = () => JSON.parse(readFileSync(f.sharedPath, 'utf8'));
  f.run = (overrides = {}) => runCiGhostRerun({ ...options, ...overrides }, f.deps);
  return f;
}

describe('default GitHub execution', () => {
  it('bypasses inherited read memo and finished-CI caches in throttle and child environments', () => {
    vi.stubEnv('WE_GH_READ_MEMO_DIR', 'inherited-memo');
    vi.stubEnv('WE_FINISHED_CI_CACHE', '1');
    vi.stubEnv('WE_FINISHED_CI_CACHE_DIR', 'inherited-ci-cache');
    const args = ['api', 'repos/web-everything/web-everything/pulls/42', '--method', 'GET'];
    execFileSyncThrottled.mockReturnValueOnce('{"version":1}').mockReturnValueOnce('{"version":2}');
    try {
      expect(defaultGh(args)).toEqual({ version: 1 });
      expect(defaultGh(args)).toEqual({ version: 2 });
      expect(execFileSyncThrottled).toHaveBeenCalledTimes(2);
      for (const [bin, argv, opts] of execFileSyncThrottled.mock.calls) {
        expect(bin).toBe('gh');
        expect(argv).toEqual(args);
        // gh-throttle reads throttle.env, independently of the child's env.
        for (const env of [opts.env, opts.throttle.env]) {
          expect(env).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
          expect(env.WE_FINISHED_CI_CACHE).toBe('0');
          expect(env.PATH).toBe(process.env.PATH);
        }
      }
      expect(process.env.WE_GH_READ_MEMO_DIR).toBe('inherited-memo');
      expect(process.env.WE_FINISHED_CI_CACHE).toBe('1');
    } finally {
      vi.unstubAllEnvs();
      execFileSyncThrottled.mockReset();
    }
  });
});

describe('ghost recovery', () => {
  it.each(['WE_GH_THROTTLE_LOCK_ROOT', 'LANE_POOL_ROOT', 'HOME'])(
    'refuses a redirected shared budget through %s without an injected directory', async key => {
      const f = fixture(); delete f.deps.sharedStateDir;
      vi.stubEnv(key, f.dir);
      try {
        expect(await f.run()).toMatchObject({ reason: 'shared-state-env-override', exitCode: 2 });
        expect(f.gh).not.toHaveBeenCalled();
        expect(f.deps.readSharedRerunStates).not.toHaveBeenCalled();
        expect(f.rows).toEqual([expect.objectContaining({ outcome: 'shared-state-env-override', counted: false })]);
      } finally { vi.unstubAllEnvs(); }
    });

  it.each(['', 'canonical'])(
    'allows a non-redirecting root override %j and restores environment inputs', async value => {
      const f = fixture(); delete f.deps.sharedStateDir;
      // Vitest 1 stringifies undefined in stubEnv; register restoration, then delete.
      vi.stubEnv('LANE_POOL_ROOT', process.env.LANE_POOL_ROOT);
      vi.stubEnv('HOME', process.env.HOME);
      delete process.env.LANE_POOL_ROOT;
      delete process.env.HOME;
      const home = homedir();
      const root = value === 'canonical' ? join(home, 'workspace', '.lanes', '.admission', 'gh') : value;
      vi.stubEnv('WE_GH_THROTTLE_LOCK_ROOT', root);
      try {
        expect(await f.run({ actor: null })).toMatchObject({ reason: 'invalid-attribution', exitCode: 2 });
        expect(process.env.WE_GH_THROTTLE_LOCK_ROOT).toBe(root);
        expect(f.gh).not.toHaveBeenCalled();
      } finally { vi.unstubAllEnvs(); }
    });

  it('allows an explicitly injected shared directory despite the inherited override', async () => {
    const f = fixture(); vi.stubEnv('WE_GH_THROTTLE_LOCK_ROOT', 'redirected-budget');
    try {
      expect(await f.run()).toMatchObject({ reason: 'rerun', exitCode: 0 });
      expect(f.shared().requests[0].status).toBe('confirmed');
    } finally { vi.unstubAllEnvs(); }
  });

  describe.each([
    ['before cancel', 2, []], ['before rerun', 3, ['cancel']],
  ])('%s workflow preflight', (_phase, pullRead, posts) => {
    it.each([
      ['changed attempt', { run_attempt: 3 }], ['missing attempt', { run_attempt: undefined }],
      ['invalid attempt type', { run_attempt: '2' }],
      ['changed status', { status: 'queued' }], ['missing status', { status: undefined }],
      ['changed head', { head_sha: 'b'.repeat(40) }], ['missing head', { head_sha: undefined }],
      ['changed identity', { id: 10 }], ['missing response', null], ['unreadable response', 'throw'],
    ])('rejects %s and releases the reservation', async (_name, changed) => {
      const f = fixture(); const gh = f.gh; let pulls = 0;
      f.deps.gh = async args => {
        const result = await gh(args);
        if (args[1].endsWith('/pulls/42')) pulls++;
        if (pulls === pullRead && args[1].endsWith('/runs/9')) {
          if (changed === 'throw') throw new Error('unreadable');
          return changed === null ? null : { ...result, ...changed };
        }
        return result;
      };
      expect(await f.run()).toMatchObject({ reason: 'run-changed', exitCode: 4 });
      expect(f.posts).toEqual(posts);
      expect(f.shared().requests[0]).toMatchObject({ status: 'rejected', released: true });
    });

    it('rejects a status from the other phase and releases the reservation', async () => {
      const f = fixture(); const gh = f.gh; let pulls = 0;
      f.deps.gh = async args => {
        const result = await gh(args);
        if (args[1].endsWith('/pulls/42')) pulls++;
        if (pulls === pullRead && args[1].endsWith('/runs/9')) {
          result.status = pullRead === 2 ? 'completed' : 'in_progress';
        }
        return result;
      };
      expect(await f.run()).toMatchObject({ reason: 'run-changed', exitCode: 4 });
      expect(f.posts).toEqual(posts);
      expect(f.shared().requests[0]).toMatchObject({ status: 'rejected', released: true });
    });
  });

  it.each([
    ['completed job', { status: 'completed' }], ['missing status', { status: undefined }],
    ['active step', { steps: [{ status: 'in_progress' }] }], ['missing steps', { steps: undefined }],
    ['empty steps', { steps: [] }],
    ['failed step', { steps: [{ ...ghost().steps[0], conclusion: 'failure' }] }],
    ['young steps', { steps: [{ ...ghost().steps[0], completed_at: new Date(NOW).toISOString() }] }],
    ['threshold boundary', { steps: [{ ...ghost().steps[0], completed_at: new Date(NOW - 15 * 60_000).toISOString() }] }],
    ['missing completion time', { steps: [{ status: 'completed', conclusion: 'success' }] }],
    ['changed attempt', { run_attempt: 3 }], ['changed run', { run_id: 10 }],
    ['changed job', { id: 8 }], ['changed check', { check_run_url: 'other-check' }],
    ['missing response', null], ['unreadable response', 'throw'],
  ])('rejects %s in the pre-cancel ghost re-read and releases the reservation', async (_name, changed) => {
    const f = fixture(); const gh = f.gh; let reads = 0;
    f.deps.gh = async args => {
      const result = await gh(args);
      if (args[1].endsWith('/jobs/7') && ++reads === 2) {
        if (changed === 'throw') throw new Error('unreadable');
        return changed === null ? null : { ...result, ...changed };
      }
      return result;
    };
    expect(await f.run()).toMatchObject({ reason: 'run-changed', exitCode: 4 });
    expect(reads).toBe(2);
    expect(f.posts).toEqual([]);
    expect(f.shared().requests[0]).toMatchObject({ status: 'rejected', released: true });
  });

  it.each(['closed', 'CLOSED', 'MERGED', undefined, null, 'unknown'])(
    'refuses PR state %s before inspection or reservation', async pullState => {
      const f = fixture(); f.pullState = pullState;
      expect(await f.run()).toMatchObject({ reason: 'pr-not-open', exitCode: 4 });
      expect(f.gh).toHaveBeenCalledTimes(1);
      expect(f.posts).toEqual([]);
      expect(f.deps.readSharedRerunStates).not.toHaveBeenCalled();
    });

  it.each(['open', 'OPEN'])('accepts %s draft PRs', async pullState => {
    const f = fixture(); f.pullState = pullState; const gh = f.gh;
    f.deps.gh = async args => {
      const result = await gh(args);
      if (args[1].endsWith('/pulls/42')) result.draft = true;
      return result;
    };
    expect(await f.run()).toMatchObject({ reason: 'rerun', exitCode: 0 });
  });

  it.each([
    ['before cancel', 2, 'closed', HEAD, 'pr-not-open', []],
    ['before cancel', 2, 'open', 'b'.repeat(40), 'head-moved', []],
    ['before rerun', 3, 'closed', HEAD, 'pr-not-open', ['cancel']],
    ['before rerun', 3, 'open', 'b'.repeat(40), 'head-moved', ['cancel']],
    ['before rerun', 3, 'open', undefined, 'head-moved', ['cancel']],
  ])('aborts %s on changed PR evidence (%s, %s, %s)', async (_phase, changedRead, state, head, reason, posts) => {
    const f = fixture(); const gh = f.gh; let reads = 0;
    f.deps.gh = async args => {
      const result = await gh(args);
      if (args[1].endsWith('/pulls/42') && ++reads === changedRead) {
        result.state = state;
        result.head.sha = head;
      }
      return result;
    };
    expect(await f.run()).toMatchObject({ reason, exitCode: 4 });
    expect(reads).toBe(changedRead);
    expect(f.posts).toEqual(posts);
    expect(f.shared().requests[0]).toMatchObject({ status: 'rejected', released: true });
  });

  it('reads the live PR, run, full job list and ghost before cancel and rerun', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ reason: 'rerun', exitCode: 0 });
    const calls = f.gh.mock.calls.map(([args]) => args);
    for (const endpoint of ['cancel', 'rerun']) {
      const index = calls.findIndex(args => args[1].endsWith(`/${endpoint}`));
      const paths = ['pulls/42', 'actions/runs/9',
        'actions/runs/9/attempts/2/jobs?per_page=100', 'actions/jobs/7'];
      expect(calls.slice(index - paths.length, index)).toEqual(paths.map(path =>
        ['api', `repos/web-everything/web-everything/${path}`, '--method', 'GET']));
    }
  });

  it('detects ghosts purely and acts in cancel, wait, rerun order with before and next attempt', async () => {
    expect(detectGhostJobs({ jobs: [ghost()], now: NOW, thresholdMin: 15 }).reason).toBe('ghost');
    const f = fixture();
    expect(await f.run()).toMatchObject({ exitCode: 0, reason: 'rerun', newRunAttempt: 3,
      before: { status: 'in_progress', jobStatus: 'in_progress', runAttempt: 2 } });
    expect(f.trace).toEqual(['cancel', 'wait', 'rerun']);
  });

  it.each(['failure', 'cancelled', 'timed_out', null, undefined, 'unknown'])(
    'refuses completed step conclusion %s before posting or reserving', async conclusion => {
      const f = fixture(); f.job.steps[0].conclusion = conclusion;
      expect(detectGhostJobs({ jobs: [f.job], now: NOW, thresholdMin: 15 }).reason).toBe('step-failed');
      expect(await f.run()).toMatchObject({ reason: 'step-failed', exitCode: 2 });
      expect(f.posts).toEqual([]);
      expect(f.rows.some(row => row.counted)).toBe(false);
    });

  it.each(['success', 'skipped', 'neutral'])('accepts completed step conclusion %s', async conclusion => {
    const f = fixture(); f.job.steps[0].conclusion = conclusion;
    expect(await f.run()).toMatchObject({ reason: 'rerun', exitCode: 0 });
  });

  it('recovers distinct check-run and Actions job IDs through check_run_url and reads the actual job endpoint', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ exitCode: 0, reason: 'rerun', jobId: 7, runId: 9 });
    const endpoints = f.gh.mock.calls.map(([args]) => args[1]);
    expect(endpoints).toContain('repos/web-everything/web-everything/actions/runs/9/attempts/2/jobs?per_page=100');
    expect(endpoints).toContain('repos/web-everything/web-everything/actions/jobs/7');
    expect(endpoints).not.toContain('repos/web-everything/web-everything/actions/jobs/70');
    expect(f.trace).toEqual(['cancel', 'wait', 'rerun']);
  });

  it.each([
    ['missing relationship', []],
    ['another check', [{ id: 7, run_id: 9, run_attempt: 2, check_run_url: 'https://api.github.com/repos/web-everything/web-everything/check-runs/71' }]],
    ['ambiguous relationship', [7, 8].map(id => ({ id, run_id: 9, run_attempt: 2,
      check_run_url: 'https://api.github.com/repos/web-everything/web-everything/check-runs/70' }))],
  ])('refuses %s without posting', async (_name, listedJobs) => {
    const f = fixture(); f.listedJobs = listedJobs; f.jobsTotal = listedJobs.length;
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'job-unreadable' });
    expect(f.posts).toEqual([]);
  });

  it.each(['queued', 'waiting', 'pending', 'in_progress', 'unknown', undefined])(
    'refuses an unvalidated %s sibling before any POST', async status => {
      const f = fixture();
      f.listedJobs = [{ id: 7, run_id: 9, run_attempt: 2, status: 'in_progress',
        check_run_url: 'https://api.github.com/repos/web-everything/web-everything/check-runs/70' },
      { id: 8, run_id: 9, run_attempt: 2, status }];
      f.jobsTotal = 2;
      expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'sibling-active' });
      expect(f.posts).toEqual([]);
      expect(f.rows.some(row => row.counted)).toBe(false);
    });

  it.each(['success', 'skipped', 'neutral'])('allows a %s completed sibling when every active job is validated', async conclusion => {
    const f = fixture();
    f.listedJobs = [{ id: 7, run_id: 9, run_attempt: 2, status: 'in_progress',
      check_run_url: 'https://api.github.com/repos/web-everything/web-everything/check-runs/70' },
    { id: 8, run_id: 9, run_attempt: 2, status: 'completed', conclusion }];
    f.jobsTotal = 2;
    expect(await f.run()).toMatchObject({ exitCode: 0, reason: 'rerun' });
    expect(f.posts).toEqual(['cancel', 'rerun']);
  });

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', null, undefined, 'unknown', 'stale'])(
    'refuses a completed sibling with conclusion %s without replacing failures', async conclusion => {
      const f = fixture();
      f.listedJobs = [{ ...f.job, check_run_url: 'https://api.github.com/repos/web-everything/web-everything/check-runs/70' },
        { id: 8, run_id: 9, run_attempt: 2, status: 'completed', conclusion }];
      f.jobsTotal = 2;
      expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'sibling-failed' });
      expect(f.posts).toEqual([]);
      expect(f.rows).toEqual([expect.objectContaining({ outcome: 'sibling-failed', counted: false })]);
    });

  it.each([
    ['confirmed allowance exhausted', [{ status: 'confirmed' }]],
    ['rejected allowance exhausted', [{ status: 'rejected', released: false }]],
    ['pending reservation', [{ status: 'pending' }]],
    ['empty request', [{}]],
    ['unknown status', [{ status: 'unknown' }]],
    ['null request', [null]],
    ['array request', [[]]],
    ['primitive request', ['confirmed']],
    ['nonboolean released', [{ status: 'rejected', released: 'true' }]],
  ])('refuses shared rerun evidence: %s; requires operator inspection before manual recovery', async (_name, requests) => {
    const f = fixture();
    f.deps.readSharedRerunStates.mockReturnValue([{ version: 1,
      evidence: { repo: 'web-everything/web-everything', pr: 42, head: HEAD }, requests }]);
    expect(await f.run()).toMatchObject({ exitCode: 3, reason: 'shared-rerun-budget' });
    expect(f.deps.readSharedRerunStates).toHaveBeenCalledWith({ repo: 'web-everything/web-everything', pr: 42, head: HEAD }, f.dir);
    expect(f.posts).toEqual([]);
    expect(f.rows).toEqual([expect.objectContaining({ outcome: 'shared-rerun-budget', counted: false })]);
  });

  it.each([undefined, {}, [null], [{}], [{ version: 2, requests: [] }],
    [{ version: 1, evidence: { repo: 'other/repo', pr: 42, head: HEAD }, requests: [] }],
    [{ version: 1, evidence: { repo: 'web-everything/web-everything', pr: 42, head: HEAD }, requests: {} }],
  ])('refuses unvalidated shared states %j without reserving or posting', async states => {
    const f = fixture(); f.deps.readSharedRerunStates.mockReturnValue(states);
    expect(await f.run()).toMatchObject({ exitCode: 3, reason: 'shared-rerun-budget' });
    expect(f.posts).toEqual([]);
    expect(f.rows.some(row => row.counted)).toBe(false);
  });

  it('refuses a throwing shared state reader before any POST or local reservation', async () => {
    const f = fixture(); f.deps.readSharedRerunStates.mockImplementation(() => { throw new Error('unreadable'); });
    expect(await f.run()).toMatchObject({ exitCode: 3, reason: 'shared-rerun-budget' });
    expect(f.posts).toEqual([]);
    expect(f.rows.some(row => row.counted)).toBe(false);
  });

  it('uses readTimeoutStates by default with the exact target identity', async () => {
    const f = fixture(); delete f.deps.readSharedRerunStates;
    readTimeoutStates.mockReturnValueOnce([]);
    expect(await f.run({ repo: 'other/repo', pr: 43 })).toMatchObject({ reason: 'rerun', exitCode: 0 });
    expect(readTimeoutStates).toHaveBeenCalledTimes(1);
    expect(readTimeoutStates).toHaveBeenCalledWith({ repo: 'other/repo', pr: 43, head: HEAD }, f.dir);
    expect(f.rows.filter(row => row.counted)).toHaveLength(1);
  });

  it('allows explicitly released rejected requests', async () => {
    const f = fixture();
    f.deps.readSharedRerunStates.mockReturnValue([{ version: 1,
      evidence: { repo: 'web-everything/web-everything', pr: 42, head: HEAD },
      requests: [{ status: 'rejected', released: true }] }]);
    expect(await f.run()).toMatchObject({ reason: 'rerun', exitCode: 0 });
  });

  it('checks shared evidence even for a dry run', async () => {
    const f = fixture(); f.deps.readSharedRerunStates.mockReturnValue([{}]);
    expect(await f.run({ dryRun: true })).toMatchObject({ reason: 'shared-rerun-budget', exitCode: 3 });
    expect(f.posts).toEqual([]);
  });

  it('reserves shared budget before any POST, confirms it, and blocks an independent local ledger', async () => {
    const f = fixture(); const gh = f.gh;
    f.deps.gh = async args => {
      if (args[3] === 'POST') expect(f.shared().requests).toEqual([expect.objectContaining({
        id: 0, signature: 'ci-ghost-rerun', target: { run: 9, job: 7, attempt: 2 },
        status: 'pending', reservedAt: new Date(NOW).toISOString(), outcome: 'reserved; API outcome unknown',
      })]);
      return gh(args);
    };
    expect(await f.run()).toMatchObject({ reason: 'rerun', exitCode: 0 });
    expect(readTimeoutBudget({ dir: f.dir, repo: 'web-everything/web-everything', pr: 42, head: HEAD }))
      .toMatchObject({ confirmed: 1, pending: false });
    f.rows.length = 0;
    expect(await f.run()).toMatchObject({ reason: 'shared-rerun-budget', exitCode: 3 });
    expect(f.posts).toEqual(['cancel', 'rerun']);
  });

  it('creates dispatcher-compatible evidence with a failures array when no legacy state exists', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ reason: 'rerun', exitCode: 0 });
    expect(f.shared().evidence).toEqual({ repo: 'web-everything/web-everything', pr: 42, head: HEAD, failures: [] });
    expect(Array.isArray(f.shared().evidence.failures)).toBe(true);
  });

  it('imports legacy requests with reassigned IDs and retains merged evidence and the followup card', async () => {
    const f = fixture();
    f.deps.readSharedRerunStates = (await vi.importActual('../../conveyor/timeout-retry-state.mjs')).readTimeoutStates;
    const evidence = { repo: 'web-everything/web-everything', pr: 42, head: HEAD,
      failures: [{ path: 'ci.yml', name: 'unit', kind: 'timeout' }], signature: 'legacy-signature',
      eligible: true, jobs: [{ run: 9, job: 7, attempt: 2 }] };
    writeFileSync(join(f.dir, 'legacy-signature.json'), JSON.stringify({ version: 1,
      evidence, card: { filed: true },
      requests: [{ id: 8, status: 'rejected', released: true }] }));
    writeFileSync(join(f.dir, 'legacy-extra.json'), JSON.stringify({ version: 1,
      evidence: { repo: evidence.repo, pr: 42, head: HEAD, infraCancelled: true }, requests: [] }));
    expect(await f.run()).toMatchObject({ reason: 'rerun', exitCode: 0 });
    expect(f.shared().evidence).toEqual({ ...evidence, infraCancelled: true });
    expect(f.shared()).toMatchObject({ card: { filed: true }, requests: [
      { id: 0, status: 'rejected', released: true }, { id: 1, status: 'confirmed' },
    ] });
  });

  it('rechecks canonical budget under the lock rather than trusting an empty legacy read', async () => {
    const f = fixture();
    writeFileSync(f.sharedPath, JSON.stringify({ version: 1,
      evidence: { repo: 'web-everything/web-everything', pr: 42, head: HEAD }, requests: [{ status: 'pending' }] }));
    expect(await f.run()).toMatchObject({ reason: 'shared-rerun-budget', exitCode: 3 });
    expect(f.posts).toEqual([]);
  });

  it('refuses corrupt canonical shared state before POSTs', async () => {
    const f = fixture(); writeFileSync(f.sharedPath, '{');
    expect(await f.run()).toMatchObject({ reason: 'shared-rerun-budget', exitCode: 3 });
    expect(f.posts).toEqual([]);
  });

  it.each(['failure', 'timed_out', 'action_required', 'neutral', null, 'unknown'])(
    'refuses completion with conclusion %s after cancellation and releases shared reservation', async conclusion => {
      const f = fixture(); f.conclusion = conclusion;
      expect(await f.run()).toMatchObject({ reason: 'run-failed-on-cancel', exitCode: 4 });
      expect(f.posts).toEqual(['cancel']);
      expect(f.shared().requests).toEqual([expect.objectContaining({ status: 'rejected', released: true })]);
    });

  it.each(['success', 'cancelled'])('reruns after cancellation completes with %s', async conclusion => {
    const f = fixture(); f.conclusion = conclusion;
    expect(await f.run()).toMatchObject({ reason: 'rerun', exitCode: 0 });
    expect(f.shared().requests[0].status).toBe('confirmed');
  });

  it('releases shared budget when cancellation cannot be confirmed', async () => {
    const f = fixture(); f.statuses = ['in_progress'];
    expect(await f.run()).toMatchObject({ reason: 'cancel-unconfirmed', exitCode: 4 });
    expect(f.posts).toEqual(['cancel', 'force-cancel']);
    expect(f.shared().requests[0]).toMatchObject({ status: 'rejected', released: true });
  });

  it('releases shared budget when local reservation fails before any POST', async () => {
    const f = fixture(); f.state.append = () => { throw new Error('disk full'); };
    expect(await f.run()).toMatchObject({ reason: 'audit-unwritable', exitCode: 4 });
    expect(f.posts).toEqual([]);
    expect(f.shared().requests[0]).toMatchObject({ status: 'rejected', released: true });
  });

  it('leaves ambiguous rerun POST pending and refuses a caller with an independent local ledger', async () => {
    const f = fixture(); const gh = f.gh;
    f.deps.gh = async args => {
      if (args[1].endsWith('/rerun')) throw new Error('connection lost');
      return gh(args);
    };
    expect(await f.run()).toMatchObject({ reason: 'evidence-or-state-unreadable', exitCode: 4 });
    expect(f.shared().requests[0]).toMatchObject({ status: 'pending' });
    expect(f.shared().requests[0]).not.toHaveProperty('released');
    f.rows.length = 0;
    expect(await f.run()).toMatchObject({ reason: 'shared-rerun-budget', exitCode: 3 });
    expect(f.posts).toEqual(['cancel']);
  });

  it('refuses a job detail that no longer links to the selected check', async () => {
    const f = fixture(); f.job.check_run_url = null;
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'job-unreadable' });
    expect(f.posts).toEqual([]);
  });

  it.each([1, 3, undefined, null, '2'])(
    'refuses ghost job attempt %s that does not equal the current workflow attempt', async attempt => {
      const f = fixture(); f.job.run_attempt = attempt;
      expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'run-attempt-mismatch' });
      expect(f.posts).toEqual([]);
      expect(f.rows).toEqual([expect.objectContaining({ outcome: 'run-attempt-mismatch', counted: false })]);
    });

  it.each([1, undefined])('refuses sibling evidence from attempt %s before any POST', async attempt => {
    const f = fixture();
    f.listedJobs = [{ ...f.job, check_run_url: 'https://api.github.com/repos/web-everything/web-everything/check-runs/70' },
      { id: 8, run_id: 9, run_attempt: attempt, status: 'completed' }];
    f.jobsTotal = 2;
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'run-attempt-mismatch' });
    expect(f.posts).toEqual([]);
    expect(f.rows.some(row => row.counted)).toBe(false);
  });

  it('refuses when the workflow attempt advances after the pinned job list read', async () => {
    const f = fixture(); const gh = f.gh;
    let reads = 0;
    f.deps.gh = async args => {
      const result = await gh(args);
      if (args[1].endsWith('/runs/9') && ++reads === 2) result.run_attempt = 3;
      return result;
    };
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'run-attempt-mismatch' });
    expect(f.posts).toEqual([]);
    expect(f.rows.some(row => row.counted)).toBe(false);
  });

  it('refuses an oversized workflow job list for manual inspection', async () => {
    const f = fixture(); f.jobsTotal = 101;
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'jobs-incomplete' });
    expect(f.posts).toEqual([]);
  });

  it.each([
    ['real step', job => { job.steps[1].status = 'in_progress'; }, 'not-ghost'],
    ['no steps', job => { job.steps = []; }, 'no-steps'],
    ['missing steps', job => { delete job.steps; }, 'no-steps'],
    ['young latest step', job => { job.steps[1].completed_at = '2026-11-16T11:50:00Z'; }, 'too-young'],
    ['threshold equality', job => { job.steps[1].completed_at = '2026-11-16T11:45:00Z'; }, 'too-young'],
    ['unknown completion', job => { job.steps[0].completed_at = null; }, 'not-ghost'],
    ['future completion', job => { job.steps[0].completed_at = '2026-11-17T12:00:00Z'; }, 'too-young'],
  ])('refuses %s and posts nothing', async (_name, change, reason) => {
    const f = fixture(); change(f.job);
    expect(await f.run()).toMatchObject({ exitCode: 2, reason });
    expect(f.posts).toEqual([]);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ outcome: reason, counted: false });
  });

  it('refuses a mixed set of real work and ghosts', () => {
    const real = ghost(); real.steps[0].status = 'in_progress';
    expect(detectGhostJobs({ jobs: [ghost(), real], now: NOW, thresholdMin: 15 }).reason).toBe('not-ghost');
  });

  it('refuses no in-progress Actions job, ignoring other check providers', async () => {
    const f = fixture(); f.checks = [{ status: 'in_progress', app: { slug: 'other' } }];
    expect(await f.run()).toMatchObject({ reason: 'no-in-progress-job', exitCode: 2 });
    expect(f.posts).toEqual([]);
  });

  it('caps attempts per repo/pr/head while allowing a new head, PR and repo', async () => {
    const f = fixture();
    expect((await f.run()).reason).toBe('rerun');
    expect(await f.run()).toMatchObject({ reason: 'rate-capped', exitCode: 3 });
    f.head = f.runHead = 'b'.repeat(40);
    expect((await f.run()).reason).toBe('rerun');
    expect((await f.run({ pr: 43 })).reason).toBe('rerun');
    expect((await f.run({ repo: 'other/repo' })).reason).toBe('rerun');
    f.now += 2 * 3_600_000;
    expect((await f.run()).reason).toBe('rate-capped');
  });

  it('refuses a second attempt on the same head after window expiry with default settings', async () => {
    const f = fixture();
    f.deps.settings = readCiGhostRerunSettings({ platform: {}, tool: {}, env: {} });
    expect((await f.run()).reason).toBe('rerun');
    f.now += 3 * 3_600_000;
    const posts = [...f.posts];
    expect(await f.run()).toMatchObject({ reason: 'rate-capped', exitCode: 3 });
    expect(f.posts).toEqual(posts);
    expect(f.rows.filter(row => row.counted)).toHaveLength(1);
  });

  it('counts historical ledger reservations toward the lifetime cap', async () => {
    const f = fixture();
    f.rows.push({ ts: '2026-11-01T12:00:00Z', outcome: 'attempt', counted: true,
      repo: 'web-everything/web-everything', pr: 42, head: HEAD });
    expect(await f.run()).toMatchObject({ reason: 'rate-capped', exitCode: 3 });
    expect(f.posts).toEqual([]);
  });

  it('retains the window cap with maxPerHead=2 and refuses a second shared attempt after expiry', async () => {
    const f = fixture(); f.deps.settings = { ...settings, maxPerHead: 2 };
    expect((await f.run()).reason).toBe('rerun');
    expect((await f.run()).reason).toBe('rate-capped');
    f.now += 3 * 3_600_000;
    expect((await f.run()).reason).toBe('shared-rerun-budget');
    expect(f.rows.filter(row => row.counted)).toHaveLength(1);
    expect(f.posts).toEqual(['cancel', 'rerun']);
  });

  it('force-cancels after a bounded wait, and confirms completion before rerun', async () => {
    const f = fixture(); f.statuses = ['in_progress', 'in_progress', 'in_progress', 'in_progress', 'completed'];
    expect((await f.run()).reason).toBe('rerun');
    expect(f.trace).toEqual(['cancel', 'wait', 'wait', 'force-cancel', 'rerun']);
  });

  describe.each([
    ['before cancel', 2, []],
    ['before force-cancel', 3, ['cancel']],
    ['before rerun', 3, ['cancel']],
  ])('%s full ghost preflight', (phase, pullRead, posts) => {
    it.each([
      ['cleanup job starting', { id: 8, run_id: 9, run_attempt: 2, status: 'in_progress',
        steps: [{ status: 'in_progress' }] }],
      ['queued downstream job', { id: 8, run_id: 9, run_attempt: 2, status: 'queued' }],
      ['failed sibling', { id: 8, run_id: 9, run_attempt: 2, status: 'completed', conclusion: 'failure' }],
    ])('rejects %s and releases the reservation', async (_name, sibling) => {
      const f = fixture(); const gh = f.gh; let pulls = 0;
      if (phase === 'before force-cancel') f.statuses = ['in_progress'];
      f.deps.gh = async args => {
        const result = await gh(args);
        if (args[1].endsWith('/pulls/42')) pulls++;
        if (pulls === pullRead && args[1].includes('/attempts/2/jobs?')) {
          return { total_count: result.total_count + 1, jobs: [...result.jobs, sibling] };
        }
        return result;
      };
      expect(await f.run()).toMatchObject({ reason: 'run-changed', exitCode: 4 });
      expect(f.posts).toEqual(posts);
      expect(f.shared().requests[0]).toMatchObject({ status: 'rejected', released: true });
    });

    it.each(['oversized', 'incomplete', 'unreadable'])(
      'rejects %s job evidence and releases the reservation', async kind => {
        const f = fixture(); const gh = f.gh; let pulls = 0;
        if (phase === 'before force-cancel') f.statuses = ['in_progress'];
        f.deps.gh = async args => {
          const result = await gh(args);
          if (args[1].endsWith('/pulls/42')) pulls++;
          if (pulls === pullRead && args[1].includes('/attempts/2/jobs?')) {
            if (kind === 'unreadable') throw new Error('unreadable jobs');
            return { ...result, total_count: kind === 'oversized' ? 101 : 2 };
          }
          return result;
        };
        expect(await f.run()).toMatchObject({ reason: 'run-changed', exitCode: 4 });
        expect(f.posts).toEqual(posts);
        expect(f.shared().requests[0]).toMatchObject({ status: 'rejected', released: true });
      });
  });

  it('uses force-cancel when ordinary cancellation fails', async () => {
    const f = fixture(); const gh = f.gh;
    f.deps.gh = async args => {
      if (args[1].endsWith('/cancel')) { f.statuses = ['in_progress']; throw new Error('cancel rejected'); }
      if (args[1].endsWith('/force-cancel')) f.statuses = ['completed'];
      return gh(args);
    };
    expect((await f.run()).reason).toBe('rerun');
    expect(f.posts).toEqual(['force-cancel', 'rerun']);
  });

  it.each(['in_progress', 'completed'])(
    'aborts when polling sees a changed attempt with status %s', async status => {
      const f = fixture(); f.pollAttempt = 3; f.statuses = [status];
      expect(await f.run()).toMatchObject({ exitCode: 4, reason: 'run-attempt-changed' });
      expect(f.posts).toEqual(['cancel']);
      expect(f.rows.at(-1)).toMatchObject({ outcome: 'run-attempt-changed', counted: false });
    });

  it('aborts when the attempt changes during force-cancel polling', async () => {
    const f = fixture(); f.statuses = ['in_progress']; const gh = f.gh;
    f.deps.gh = async args => {
      if (args[1].endsWith('/force-cancel')) { f.pollAttempt = 3; f.statuses = ['completed']; }
      return gh(args);
    };
    expect(await f.run()).toMatchObject({ exitCode: 4, reason: 'run-attempt-changed' });
    expect(f.posts).toEqual(['cancel', 'force-cancel']);
  });

  it('returns cancel-unconfirmed with no rerun after both bounded waits', async () => {
    const f = fixture(); f.statuses = ['in_progress'];
    expect(await f.run()).toMatchObject({ exitCode: 4, reason: 'cancel-unconfirmed' });
    expect(f.posts).toEqual(['cancel', 'force-cancel']);
    expect(f.trace.filter(item => item === 'wait')).toHaveLength(4);
    expect(f.now - NOW).toBe(20_000);
  });

  it('refuses head-sha mismatch before posting', async () => {
    const f = fixture(); f.runHead = 'b'.repeat(40);
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'head-sha-mismatch' });
    expect(f.posts).toEqual([]);
  });

  it('dry-run posts nothing and does not count against the next real attempt', async () => {
    const f = fixture();
    expect((await f.run({ dryRun: true })).reason).toBe('dry-run');
    expect(f.posts).toEqual([]);
    expect(f.rows.some(row => row.counted)).toBe(false);
    expect((await f.run()).reason).toBe('rerun');
  });

  it.each([{ actor: undefined }, { actor: '' }, { actor: 'op\nother' },
    { channel: undefined }, { channel: ' ' }, { channel: 'one\rtwo' }, { channel: 'one\u2028two' }])(
    'refuses invalid actor/channel %j and audits without contacting GitHub', async overrides => {
      const f = fixture();
      expect(await f.run(overrides)).toMatchObject({ exitCode: 2, reason: 'invalid-attribution' });
      expect(f.gh).not.toHaveBeenCalled();
      expect(f.rows[0].outcome).toBe('invalid-attribution');
    });

  it('writes an audit record with attribution and a durable counted reservation', async () => {
    const f = fixture(); await f.run();
    expect(f.rows).toHaveLength(2);
    expect(f.rows[0]).toMatchObject({ outcome: 'attempt', counted: true });
    expect(f.rows[1]).toMatchObject({ ts: new Date(f.now).toISOString(), actor: 'operator',
      channel: 'manual recovery', repo: 'web-everything/web-everything', pr: 42, head: HEAD,
      runId: 9, jobId: 7, outcome: 'rerun', counted: false });
  });

  it.each([101, undefined, 0])('refuses incomplete/oversized check evidence: total=%s', async total => {
    const f = fixture(); f.total = total;
    expect((await f.run()).reason).toBe('checks-incomplete');
    expect(f.posts).toEqual([]);
  });

  it('refuses unreadable state and writes a refusal audit without posting', async () => {
    const f = fixture(); f.state.read = () => { throw new Error('broken JSONL'); };
    expect((await f.run()).reason).toBe('state-unreadable');
    expect(f.posts).toEqual([]);
    expect(f.rows.at(-1).counted).toBe(false);
  });

  it('does not post when the durable reservation cannot be written', async () => {
    const f = fixture(); f.state.append = () => { throw new Error('disk full'); };
    expect((await f.run()).reason).toBe('audit-unwritable');
    expect(f.posts).toEqual([]);
  });

  it('audits busy-lock refusal and does not contact GitHub', async () => {
    const f = fixture(); f.state.withLock = () => ({ reason: 'state-busy', exitCode: 3 });
    expect((await f.run()).reason).toBe('state-busy');
    expect(f.gh).not.toHaveBeenCalled();
    expect(f.rows.at(-1).outcome).toBe('state-busy');
  });

  it('parses only sanctioned flags and rejects duplicates/unknown arguments', () => {
    expect(parseArgs(['--pr=42', '--actor=op', '--channel=one line', '--dry-run', '--json']))
      .toEqual({ pr: 42, actor: 'op', channel: 'one line', dryRun: true, json: true });
    expect(parseArgs(['--pr=42', '--pr=43']).invalid).toBe(true);
    expect(parseArgs(['--force']).invalid).toBe(true);
  });
});

describe('JSONL store with fake filesystem', () => {
  function store() {
    let text = ''; let locked = false;
    const io = {
      statSync: () => ({ size: text.length }), readFileSync: () => text,
      appendFileSync: (_path, line) => { text += line; },
      mkdirSync: (_path, opts) => {
        if (opts.recursive) return;
        if (locked) throw Object.assign(new Error('busy'), { code: 'EEXIST' });
        locked = true;
      },
      rmdirSync: () => { locked = false; },
    };
    return { state: createStateStore('fake-state', io), io, setText: value => { text = value; }, getText: () => text };
  }

  it('ignores the removed environment state directory override for both ledger and lock', async () => {
    const previous = process.env.WE_CI_GHOST_RERUN_STATE_DIR;
    process.env.WE_CI_GHOST_RERUN_STATE_DIR = 'bypass-state';
    try {
      const io = { mkdirSync: vi.fn(), appendFileSync: vi.fn(), rmdirSync: vi.fn(),
        statSync: vi.fn(() => ({ size: 0 })), readFileSync: vi.fn(() => '') };
      const state = createStateStore(undefined, io);
      await state.withLock(() => { state.read(); state.append({ outcome: 'test' }); });
      const dir = join(homedir(), '.claude', 'ci-ghost-rerun');
      expect(io.statSync).toHaveBeenCalledWith(join(dir, 'attempts.jsonl'));
      expect(io.appendFileSync).toHaveBeenCalledWith(join(dir, 'attempts.jsonl'), expect.any(String), expect.any(Object));
      expect(io.mkdirSync).toHaveBeenCalledWith(join(dir, 'operation.lock'), { mode: 0o700 });
      expect(io.rmdirSync).toHaveBeenCalledWith(join(dir, 'operation.lock'));
    } finally {
      if (previous === undefined) delete process.env.WE_CI_GHOST_RERUN_STATE_DIR;
      else process.env.WE_CI_GHOST_RERUN_STATE_DIR = previous;
    }
  });

  it('persists JSONL audit lines, reads them back and releases a failed operation lock', async () => {
    const f = store();
    const row = { ts: new Date(NOW).toISOString(), outcome: 'dry-run', counted: false };
    f.state.append(row);
    expect(f.getText()).toBe(`${JSON.stringify(row)}\n`);
    expect(f.state.read()).toEqual([row]);
    await expect(f.state.withLock(async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    expect(await f.state.withLock(() => 'released')).toBe('released');
  });

  it('serializes competing callers without bypassing the cap', async () => {
    const f = store(); let release;
    const first = f.state.withLock(() => new Promise(resolve => { release = resolve; }));
    expect(await f.state.withLock(() => 'must not enter')).toEqual({ reason: 'state-busy', exitCode: 3 });
    release(); await first;
  });

  it.each(['not json', '{}', '{"ts":"bad","outcome":"attempt","counted":true}'])('fails closed on corrupt persisted evidence %s', text => {
    const f = store(); f.setText(text);
    expect(() => f.state.read()).toThrow();
  });

  it.each([
    { head: { sha: HEAD } }, { head: 'bad' }, { head: HEAD + '\n' }, { head: 123 },
    { repo: {} }, { repo: '' }, { repo: ' ' }, { pr: 0 }, { pr: '42' }, { pr: 1.5 },
  ])('throws for malformed counted ledger identity %j and refuses the entire operation', async identity => {
    const persisted = store();
    persisted.setText(JSON.stringify({ ts: new Date(NOW).toISOString(), outcome: 'attempt', counted: true,
      repo: 'web-everything/web-everything', pr: 42, head: HEAD, ...identity }) + '\n');
    expect(() => persisted.state.read()).toThrow('state unreadable');
    const f = fixture(); f.deps.state = persisted.state;
    expect(await f.run()).toMatchObject({ reason: 'state-unreadable', exitCode: 4 });
    expect(f.posts).toEqual([]);
  });

  it('refuses oversized state with explicit archive-before-retry fallback', () => {
    const f = store(); f.io.statSync = () => ({ size: 8 * 1024 * 1024 + 1 });
    expect(() => f.state.read()).toThrow('archive ledger before retry');
  });
});

describe('settings cascade', () => {
  it.each(['missing', 'unreadable'])(
    'fails closed on an explicitly selected %s platform preferences file', async kind => {
      const f = fixture();
      const file = kind === 'missing' ? join(f.dir, 'missing.json') : f.dir;
      f.deps.settings = readCiGhostRerunSettings({
        env: { WE_PLATFORM_PREFERENCES_FILE: ` ${file} ` }, tool: {},
      });
      expect(f.deps.settings.invalid).toContain('platform.read');
      expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'invalid-settings' });
      expect(f.gh).not.toHaveBeenCalled();
      expect(f.rows.at(-1)).toMatchObject({ outcome: 'invalid-settings', counted: false });
    });

  it('loads a readable explicitly selected platform preferences file', () => {
    const f = fixture();
    const file = join(f.dir, 'preferences.json');
    writeFileSync(file, JSON.stringify({ ciGhostRerun: { thresholdMin: 25 } }));
    expect(readCiGhostRerunSettings({ env: { WE_PLATFORM_PREFERENCES_FILE: file }, tool: {} }))
      .toEqual({ thresholdMin: 25, maxPerWindow: 1, maxPerHead: 1, windowHours: 2, cancelWaitSec: 60 });
  });

  it.each(['EACCES', 'ENOENT', 'ENOTDIR', 'EIO'])(
    'fails closed on settings directory %s even when the shared reader would return valid defaults', async code => {
      const f = fixture();
      const readTool = vi.fn(() => ({ settings: {}, errors: [] }));
      const readDirectory = vi.fn(() => { throw Object.assign(new Error('unreadable directory'), { code }); });
      f.deps.settings = readCiGhostRerunSettings({ env: {}, platform: {}, readTool, readDirectory });
      expect(readDirectory).toHaveBeenCalledWith(SETTINGS_DIR);
      expect(readTool).not.toHaveBeenCalled();
      expect(f.deps.settings.invalid).toContain('tool.read');
      expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'invalid-settings' });
      expect(f.gh).not.toHaveBeenCalled();
      expect(f.rows.at(-1)).toMatchObject({ outcome: 'invalid-settings', counted: false });
    });

  it.each(['standard', 'platform', 'tool', 'env'])('resolves and logs maxPerHead from %s', layer => {
    const log = vi.fn();
    const input = { platform: {}, tool: {}, env: { WE_POLICY_CASCADE_LOG: '1' }, log };
    if (layer === 'env') input.env.WE_CI_GHOST_RERUN_MAX_PER_HEAD = '2';
    else if (layer !== 'standard') input[layer].maxPerHead = 2;
    expect(readCiGhostRerunSettings(input).maxPerHead).toBe(layer === 'standard' ? 1 : 2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`maxPerHead=${layer === 'standard' ? 1 : 2} (${layer})`));
  });

  it('loads tool settings after the settings directory is successfully listed', () => {
    const readDirectory = vi.fn(() => ['ci-ghost-rerun.json']);
    const readTool = vi.fn(() => ({ settings: { ciGhostRerun: { thresholdMin: 25 } }, errors: [] }));
    expect(readCiGhostRerunSettings({ env: {}, platform: {}, readDirectory, readTool }))
      .toEqual({ thresholdMin: 25, maxPerWindow: 1, maxPerHead: 1, windowHours: 2, cancelWaitSec: 60 });
    expect(readDirectory).toHaveBeenCalledWith(SETTINGS_DIR);
    expect(readDirectory.mock.invocationCallOrder[0]).toBeLessThan(readTool.mock.invocationCallOrder[0]);
  });

  it.each(['platform', 'tool'])('refuses malformed %s layers and blocks without contacting GitHub', async layer => {
    for (const value of [false, true, 'bad', 12, [], new Date(0)]) {
      for (const malformed of [value, { ciGhostRerun: value }]) {
        const f = fixture();
        f.deps.settings = readCiGhostRerunSettings({ env: {}, platform: {}, tool: {}, [layer]: malformed });
        expect(f.deps.settings.invalid).toContain(typeof malformed === 'object'
          && malformed !== null && Object.hasOwn(malformed, 'ciGhostRerun') ? `${layer}.ciGhostRerun` : layer);
        expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'invalid-settings' });
        expect(f.gh).not.toHaveBeenCalled();
        expect(f.rows.at(-1)).toMatchObject({ outcome: 'invalid-settings', counted: false });
      }
    }
  });

  it.each(['platform', 'tool'])('refuses a null ciGhostRerun block in the %s layer', async layer => {
    const f = fixture();
    f.deps.settings = readCiGhostRerunSettings({ env: {}, platform: {}, tool: {}, [layer]: { ciGhostRerun: null } });
    expect(f.deps.settings.invalid).toContain(`${layer}.ciGhostRerun`);
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'invalid-settings' });
    expect(f.gh).not.toHaveBeenCalled();
  });

  it.each([undefined, null])('accepts absent layers %s', value => {
    expect(readCiGhostRerunSettings({ env: {}, platform: value, tool: value,
      readPlatform: () => ({ prefs: {}, errors: [] }), readTool: () => ({ settings: {}, errors: [] }) }))
      .toEqual({ thresholdMin: 15, maxPerWindow: 1, maxPerHead: 1, windowHours: 2, cancelWaitSec: 60 });
  });

  it('accepts plain ciGhostRerun blocks and preserves their layer provenance', () => {
    const log = vi.fn();
    expect(readCiGhostRerunSettings({ env: { WE_POLICY_CASCADE_LOG: '1' }, log,
      platform: { ciGhostRerun: { thresholdMin: 20 } }, tool: { ciGhostRerun: { windowHours: 3 } } }))
      .toEqual({ thresholdMin: 20, maxPerWindow: 1, maxPerHead: 1, windowHours: 3, cancelWaitSec: 60 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('thresholdMin=20 (platform)'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('windowHours=3 (tool)'));
  });

  it.each(['parse', 'read', 'shape'])('refuses a platform settings file %s failure', async kind => {
    const f = fixture();
    f.deps.settings = readCiGhostRerunSettings({ env: {}, tool: {},
      readPlatform: () => readPlatformPreferences({ env: { WE_PLATFORM_PREFERENCES_FILE: 'fixture.json' },
        readFile: () => {
          if (kind === 'read') throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return kind === 'parse' ? '{' : 'false';
        } }),
    });
    expect(f.deps.settings.invalid).toContain('platform.read');
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'invalid-settings' });
    expect(f.gh).not.toHaveBeenCalled();
  });

  it.each(['parse', 'read', 'shape'])('refuses a tool settings file %s failure', async kind => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-ghost-settings-'));
    try {
      const file = join(dir, 'fixture.json');
      if (kind !== 'read') writeFileSync(file, kind === 'parse' ? '{' : '[]');
      const f = fixture();
      f.deps.settings = readCiGhostRerunSettings({ env: {}, platform: {},
        readTool: () => readDeclaredSettings({ dir, legacyPath: kind === 'read' ? dir : file }),
      });
      expect(f.deps.settings.invalid).toContain('tool.read');
      expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'invalid-settings' });
      expect(f.gh).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['platform', 'tool'])('returns an invalid marker when the %s reader throws', async layer => {
    const f = fixture();
    f.deps.settings = readCiGhostRerunSettings({ env: {},
      platform: layer === 'platform' ? undefined : {}, tool: layer === 'tool' ? undefined : {},
      [layer === 'platform' ? 'readPlatform' : 'readTool']: () => { throw new Error('unreadable'); },
    });
    expect(f.deps.settings.invalid).toContain(`${layer}.read`);
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'invalid-settings' });
    expect(f.gh).not.toHaveBeenCalled();
  });

  it('resolves standard -> platform -> tool -> env independently and logs provenance', () => {
    const log = vi.fn();
    expect(readCiGhostRerunSettings({ platform: { thresholdMin: 20, windowHours: 3 },
      tool: { thresholdMin: 25 }, env: { WE_CI_GHOST_RERUN_THRESHOLD_MIN: '30', WE_POLICY_CASCADE_LOG: '1' }, log }))
      .toEqual({ thresholdMin: 30, maxPerWindow: 1, maxPerHead: 1, windowHours: 3, cancelWaitSec: 60 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('thresholdMin=30 (env)'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('windowHours=3 (platform)'));
  });

  it('exposes invalid overrides even when the cascade retains valid lower layers', () => {
    expect(readCiGhostRerunSettings({ platform: { thresholdMin: 20 }, tool: { thresholdMin: -1 }, env: {
      WE_CI_GHOST_RERUN_THRESHOLD_MIN: 'NaN', WE_CI_GHOST_RERUN_MAX_PER_WINDOW: '1.5',
      WE_CI_GHOST_RERUN_WINDOW_HOURS: '0', WE_CI_GHOST_RERUN_CANCEL_WAIT_SEC: 'Infinity',
    } })).toEqual({ thresholdMin: 20, maxPerWindow: 1, maxPerHead: 1, windowHours: 2, cancelWaitSec: 60,
      invalid: expect.arrayContaining(['tool.thresholdMin', 'env.thresholdMin', 'env.maxPerWindow',
        'env.windowHours', 'env.cancelWaitSec']) });
  });
});

const invalidOverrides = [
  ['thresholdMin', 4.99], ['thresholdMin', -1], ['thresholdMin', NaN], ['thresholdMin', Infinity],
  ['maxPerHead', 0], ['maxPerHead', 3], ['maxPerHead', 1.5],
  ['maxPerWindow', 0], ['maxPerWindow', 4], ['maxPerWindow', 1.5],
  ['windowHours', 0.99], ['windowHours', 24.01],
  ['cancelWaitSec', 4.99], ['cancelWaitSec', 300.01],
  ['thresholdMin', null], ['thresholdMin', {}], ['thresholdMin', 'bad'],
];

describe.each(['platform', 'tool', 'env', 'injected'])('%s invalid settings', layer => {
  it.each(invalidOverrides)('refuses %s=%s without contacting GitHub', async (key, value) => {
    const f = fixture();
    if (layer === 'injected') f.deps.settings = { ...settings, [key]: value };
    else {
      const input = { platform: {}, tool: {}, env: {} };
      if (layer === 'env') {
        const name = `WE_CI_GHOST_RERUN_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`;
        input.env[name] = String(value);
      } else input[layer][key] = value;
      f.deps.settings = readCiGhostRerunSettings(input);
      expect(f.deps.settings.invalid).toContain(`${layer}.${key}`);
    }
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'invalid-settings' });
    expect(f.gh).not.toHaveBeenCalled();
    expect(f.posts).toEqual([]);
    expect(f.rows.at(-1).outcome).toBe('invalid-settings');
  });
});

it.each([
  { thresholdMin: 5, maxPerWindow: 1, maxPerHead: 1, windowHours: 1, cancelWaitSec: 5 },
  { thresholdMin: 5, maxPerWindow: 3, maxPerHead: 2, windowHours: 24, cancelWaitSec: 300 },
])('accepts inclusive settings bounds %j', async valid => {
  const f = fixture();
  f.deps.settings = readCiGhostRerunSettings({ platform: {}, tool: valid, env: {} });
  expect(f.deps.settings).toEqual(valid);
  expect(await f.run()).toMatchObject({ exitCode: 0, reason: 'rerun' });
});

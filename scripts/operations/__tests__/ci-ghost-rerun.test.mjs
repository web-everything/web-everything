/**
 * @file scripts/operations/__tests__/ci-ghost-rerun.test.mjs
 * @description Hermetic ghost recovery, cancellation, audit, cap and settings guarantees.
 */
import { describe, it, expect, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStateStore, detectGhostJobs, parseArgs, runCiGhostRerun } from '../ci-ghost-rerun.mjs';
import { readCiGhostRerunSettings } from '../../lib/ci-ghost-rerun-settings.mjs';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const HEAD = 'a'.repeat(40);
const settings = { thresholdMin: 15, maxPerWindow: 1, windowHours: 2, cancelWaitSec: 10 };
const options = { pr: 42, actor: 'operator', channel: 'manual recovery' };
const ghost = () => ({ id: 7, run_id: 9, status: 'in_progress', steps: [
  { status: 'completed', completed_at: '2026-11-16T11:30:00Z' },
  { status: 'completed', completed_at: '2026-11-16T11:40:00Z' },
] });

function fixture() {
  const f = { head: HEAD, job: ghost(), rows: [], posts: [], trace: [],
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
    if (/\/pulls\/\d+$/.test(path)) { posted = false; return { head: { sha: f.head } }; }
    if (path.includes('/check-runs?')) return { total_count: f.total, check_runs: f.checks ?? [
      { id: 70, url: checkUrl, details_url: `https://github.com/${repo}/actions/runs/9/job/7`,
        status: 'in_progress', app: { slug: 'github-actions' } },
    ] };
    if (path.endsWith('/runs/9/jobs?per_page=100&filter=latest')) return {
      total_count: f.jobsTotal ?? 1,
      jobs: f.listedJobs ?? [{ id: 7, run_id: 9, status: 'in_progress', check_run_url: checkUrl }],
    };
    if (path.endsWith('/jobs/7')) return { check_run_url: checkUrl, ...f.job };
    if (path.endsWith('/runs/9')) return { id: 9, head_sha: f.runHead, run_attempt: posted ? (f.pollAttempt ?? 2) : 2,
      status: posted ? (f.statuses.length > 1 ? f.statuses.shift() : f.statuses[0]) : 'in_progress' };
    throw new Error(`Unexpected fake route: ${path}`);
  });
  f.state = { read: () => f.rows, append: row => f.rows.push(structuredClone(row)), withLock: fn => fn() };
  f.deps = { gh: f.gh, state: f.state, clock: () => f.now, settings,
    sleep: async ms => { f.trace.push('wait'); f.now += ms; } };
  f.run = (overrides = {}) => runCiGhostRerun({ ...options, ...overrides }, f.deps);
  return f;
}

describe('ghost recovery', () => {
  it('detects ghosts purely and acts in cancel, wait, rerun order with before and next attempt', async () => {
    expect(detectGhostJobs({ jobs: [ghost()], now: NOW, thresholdMin: 15 }).reason).toBe('ghost');
    const f = fixture();
    expect(await f.run()).toMatchObject({ exitCode: 0, reason: 'rerun', newRunAttempt: 3,
      before: { status: 'in_progress', jobStatus: 'in_progress', runAttempt: 2 } });
    expect(f.trace).toEqual(['cancel', 'wait', 'rerun']);
  });

  it('recovers distinct check-run and Actions job IDs through check_run_url and reads the actual job endpoint', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ exitCode: 0, reason: 'rerun', jobId: 7, runId: 9 });
    const endpoints = f.gh.mock.calls.map(([args]) => args[1]);
    expect(endpoints).toContain('repos/web-everything/web-everything/actions/runs/9/jobs?per_page=100&filter=latest');
    expect(endpoints).toContain('repos/web-everything/web-everything/actions/jobs/7');
    expect(endpoints).not.toContain('repos/web-everything/web-everything/actions/jobs/70');
    expect(f.trace).toEqual(['cancel', 'wait', 'rerun']);
  });

  it.each([
    ['missing relationship', []],
    ['another check', [{ id: 7, run_id: 9, check_run_url: 'https://api.github.com/repos/web-everything/web-everything/check-runs/71' }]],
    ['ambiguous relationship', [7, 8].map(id => ({ id, run_id: 9,
      check_run_url: 'https://api.github.com/repos/web-everything/web-everything/check-runs/70' }))],
  ])('refuses %s without posting', async (_name, listedJobs) => {
    const f = fixture(); f.listedJobs = listedJobs; f.jobsTotal = listedJobs.length;
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'job-unreadable' });
    expect(f.posts).toEqual([]);
  });

  it.each(['queued', 'waiting', 'pending', 'in_progress', 'unknown', undefined])(
    'refuses an unvalidated %s sibling before any POST', async status => {
      const f = fixture();
      f.listedJobs = [{ id: 7, run_id: 9, status: 'in_progress',
        check_run_url: 'https://api.github.com/repos/web-everything/web-everything/check-runs/70' },
      { id: 8, run_id: 9, status }];
      f.jobsTotal = 2;
      expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'sibling-active' });
      expect(f.posts).toEqual([]);
      expect(f.rows.some(row => row.counted)).toBe(false);
    });

  it('allows a completed sibling when every active job is validated', async () => {
    const f = fixture();
    f.listedJobs = [{ id: 7, run_id: 9, status: 'in_progress',
      check_run_url: 'https://api.github.com/repos/web-everything/web-everything/check-runs/70' },
    { id: 8, run_id: 9, status: 'completed' }];
    f.jobsTotal = 2;
    expect(await f.run()).toMatchObject({ exitCode: 0, reason: 'rerun' });
    expect(f.posts).toEqual(['cancel', 'rerun']);
  });

  it('refuses a job detail that no longer links to the selected check', async () => {
    const f = fixture(); f.job.check_run_url = null;
    expect(await f.run()).toMatchObject({ exitCode: 2, reason: 'job-unreadable' });
    expect(f.posts).toEqual([]);
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

  it('caps attempts per repo/pr/head, while allowing a new head, PR, repo and expired window', async () => {
    const f = fixture();
    expect((await f.run()).reason).toBe('rerun');
    expect(await f.run()).toMatchObject({ reason: 'rate-capped', exitCode: 3 });
    f.head = f.runHead = 'b'.repeat(40);
    expect((await f.run()).reason).toBe('rerun');
    expect((await f.run({ pr: 43 })).reason).toBe('rerun');
    expect((await f.run({ repo: 'other/repo' })).reason).toBe('rerun');
    f.now += 2 * 3_600_000;
    expect((await f.run()).reason).toBe('rerun');
  });

  it('force-cancels after a bounded wait, and confirms completion before rerun', async () => {
    const f = fixture(); f.statuses = ['in_progress', 'in_progress', 'in_progress', 'completed'];
    expect((await f.run()).reason).toBe('rerun');
    expect(f.trace).toEqual(['cancel', 'wait', 'wait', 'force-cancel', 'rerun']);
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
    expect((await f.run()).reason).toBe('evidence-or-state-unreadable');
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

  it('refuses oversized state with explicit archive-before-retry fallback', () => {
    const f = store(); f.io.statSync = () => ({ size: 8 * 1024 * 1024 + 1 });
    expect(() => f.state.read()).toThrow('archive ledger before retry');
  });
});

describe('settings cascade', () => {
  it('resolves standard -> platform -> tool -> env independently and logs provenance', () => {
    const log = vi.fn();
    expect(readCiGhostRerunSettings({ platform: { thresholdMin: 20, windowHours: 3 },
      tool: { thresholdMin: 25 }, env: { WE_CI_GHOST_RERUN_THRESHOLD_MIN: '30', WE_POLICY_CASCADE_LOG: '1' }, log }))
      .toEqual({ thresholdMin: 30, maxPerWindow: 1, windowHours: 3, cancelWaitSec: 60 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('thresholdMin=30 (env)'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('windowHours=3 (platform)'));
  });

  it('exposes invalid overrides even when the cascade retains valid lower layers', () => {
    expect(readCiGhostRerunSettings({ platform: { thresholdMin: 20 }, tool: { thresholdMin: -1 }, env: {
      WE_CI_GHOST_RERUN_THRESHOLD_MIN: 'NaN', WE_CI_GHOST_RERUN_MAX_PER_WINDOW: '1.5',
      WE_CI_GHOST_RERUN_WINDOW_HOURS: '0', WE_CI_GHOST_RERUN_CANCEL_WAIT_SEC: 'Infinity',
    } })).toEqual({ thresholdMin: 20, maxPerWindow: 1, windowHours: 2, cancelWaitSec: 60,
      invalid: expect.arrayContaining(['tool.thresholdMin', 'env.thresholdMin', 'env.maxPerWindow',
        'env.windowHours', 'env.cancelWaitSec']) });
  });
});

const invalidOverrides = [
  ['thresholdMin', 4.99], ['thresholdMin', -1], ['thresholdMin', NaN], ['thresholdMin', Infinity],
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
  { thresholdMin: 5, maxPerWindow: 1, windowHours: 1, cancelWaitSec: 5 },
  { thresholdMin: 5, maxPerWindow: 3, windowHours: 24, cancelWaitSec: 300 },
])('accepts inclusive settings bounds %j', async valid => {
  const f = fixture();
  f.deps.settings = readCiGhostRerunSettings({ platform: {}, tool: valid, env: {} });
  expect(f.deps.settings).toEqual(valid);
  expect(await f.run()).toMatchObject({ exitCode: 0, reason: 'rerun' });
});

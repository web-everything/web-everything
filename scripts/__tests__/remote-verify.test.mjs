/**
 * @file scripts/__tests__/remote-verify.test.mjs
 * @description Red-first contract for remote verification. All runtime IO is injected;
 *   workflow checks read committed source without invoking GitHub or a real timer.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  selectRemoteVerifyRun,
  remoteVerdict,
  buildRemoteMarker,
  recordRemoteVerification,
  waitForRemoteVerify,
} from '../lib/remote-verify.mjs';
import { verifyStartBody, verifyFinishBody } from '../lib/lane-verify.mjs';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const T0 = Date.parse('2026-10-24T00:00:00.000Z');
const run = (overrides = {}) => ({
  id: 123,
  head_sha: SHA,
  status: 'completed',
  conclusion: 'success',
  event: 'push',
  created_at: new Date(T0).toISOString(),
  ...overrides,
});

function fakeClock() {
  let time = T0;
  return {
    now: () => time,
    sleep: vi.fn(async (ms) => {
      // A broken polling interval must fail promptly rather than hang the test.
      expect(Number.isFinite(ms) && ms > 0).toBe(true);
      time += ms;
    }),
  };
}

describe('selectRemoteVerifyRun — newest run for the exact full SHA', () => {
  it('returns null for an empty list or only unrelated heads', () => {
    expect(selectRemoteVerifyRun([], SHA)).toBeNull();
    expect(selectRemoteVerifyRun([run({ head_sha: OTHER })], SHA)).toBeNull();
  });

  it('sorts by created_at, independent of array order, run id, event or conclusion', () => {
    const old = run({ id: 999, created_at: new Date(T0 - 1000).toISOString() });
    const newest = run({ id: 1, event: 'workflow_dispatch', status: 'queued', conclusion: null });
    const unrelated = run({ head_sha: OTHER, created_at: new Date(T0 + 1000).toISOString() });
    for (const runs of [[old, unrelated, newest], [newest, old, unrelated]]) {
      expect(selectRemoteVerifyRun(runs, SHA)).toEqual(newest);
    }
  });

  it('matches full 40-character hexadecimal SHAs case-insensitively in either argument', () => {
    expect(selectRemoteVerifyRun([run({ head_sha: SHA.toUpperCase() })], SHA)?.id).toBe(123);
    expect(selectRemoteVerifyRun([run()], SHA.toUpperCase())?.id).toBe(123);
  });

  it.each([SHA.slice(0, 7), SHA.slice(0, 39), `${SHA}0`, `${SHA.slice(0, 39)}2`, 'g'.repeat(40), '', null, undefined])(
    'never accepts a prefix, different or malformed SHA (%s)', (badSha) => {
      expect(selectRemoteVerifyRun([run({ head_sha: badSha })], SHA)).toBeNull();
      expect(selectRemoteVerifyRun([run()], badSha)).toBeNull();
    },
  );
});

describe('remoteVerdict — only completed success is green', () => {
  it('null means absent', () => {
    expect(remoteVerdict(null)).toEqual({ state: 'absent' });
  });

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])('%s means pending even with a success conclusion', (status) => {
    expect(remoteVerdict(run({ status, conclusion: null }))).toEqual({ state: 'pending' });
    expect(remoteVerdict(run({ status }))).toEqual({ state: 'pending' });
  });

  it('completed success is green', () => {
    expect(remoteVerdict(run())).toEqual({ state: 'green' });
  });

  it.each(['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', 'stale', null])(
    'completed %s is red and preserves the conclusion', (conclusion) => {
      expect(remoteVerdict(run({ conclusion }))).toEqual({ state: 'red', conclusion });
    },
  );

  it('fails closed on malformed evidence instead of manufacturing green', () => {
    for (const malformed of [undefined, false, 42, 'success', [], {}, { conclusion: 'success' },
      { status: 'completed' }, run({ conclusion: 'SUCCESS' }), run({ conclusion: true })]) {
      expect(remoteVerdict(malformed).state).not.toBe('green');
    }
  });
});

describe('buildRemoteMarker — shared lane marker bodies with remote provenance', () => {
  it('matches the shared start/finish schema, stamps the injected time and records the run URL', () => {
    const successful = run({ html_url: 'https://github.com/example/repo/actions/runs/123' });
    const instant = new Date(T0).toISOString();
    const expected = verifyFinishBody(
      verifyStartBody({ sha: SHA, treeHash: TREE, suites: 'remote-verify:123', startedAt: instant }),
      { finishedAt: instant, exitCode: 0, sha: SHA, treeHash: TREE },
    );
    const marker = buildRemoteMarker({ sha: SHA, treeHash: TREE, run: successful, now: () => T0 });
    expect(marker).toEqual({
      ...expected,
      remote: { runId: 123, url: successful.html_url },
    });
    expect(marker).toMatchObject({ status: 'green', exitCode: 0, sha: SHA, treeHash: TREE, suites: 'remote-verify:123' });
  });

  it('records the run id when the optional URL is absent', () => {
    const marker = buildRemoteMarker({ sha: SHA, treeHash: TREE, run: run(), now: () => T0 });
    expect(marker.remote.runId).toBe(123);
    expect(marker.remote.url).toBeUndefined();
  });

  it('accepts the SHA-256 working-tree hash produced by treeHashNow', () => {
    const treeHash = 'c'.repeat(64);
    expect(buildRemoteMarker({ sha: SHA, treeHash, run: run(), now: () => T0 }).treeHash).toBe(treeHash);
  });

  it.each([null, run({ status: 'in_progress' }), run({ conclusion: 'failure' }),
    run({ conclusion: 'cancelled' }), run({ conclusion: null }), {}])('refuses non-green evidence (%j)', (evidence) => {
    expect(() => buildRemoteMarker({ sha: SHA, treeHash: TREE, run: evidence, now: () => T0 })).toThrow();
  });

  it.each([OTHER, SHA.slice(0, 7), null])('refuses a green run for a different or incomplete head (%s)', (head_sha) => {
    expect(() => buildRemoteMarker({ sha: SHA, treeHash: TREE, run: run({ head_sha }), now: () => T0 })).toThrow();
  });

  it.each([undefined, null, ''])('refuses a missing tree hash (%s)', (treeHash) => {
    expect(() => buildRemoteMarker({ sha: SHA, treeHash, run: run(), now: () => T0 })).toThrow();
  });
});

describe('waitForRemoteVerify — hermetic bounded polling', () => {
  function options(fetchRuns, overrides = {}) {
    return { fetchRuns, sha: SHA, waitMs: 1000, pollMs: 100, ...fakeClock(), ...overrides };
  }

  it('returns an already green run without sleeping or fetching again', async () => {
    const successful = run();
    const fetchRuns = vi.fn(async () => [successful]);
    const opts = options(fetchRuns);
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: true, state: 'green', run: successful });
    expect(fetchRuns).toHaveBeenCalledTimes(1);
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it.each(['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', null])('returns red immediately for completed %s', async (conclusion) => {
    const failed = run({ conclusion });
    const opts = options(vi.fn(async () => [failed]));
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: false, state: 'red', run: failed });
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it('polls through absent and pending evidence until the run turns green', async () => {
    const successful = run();
    const fetchRuns = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([run({ status: 'in_progress', conclusion: null })])
      .mockResolvedValue([successful]);
    const opts = options(fetchRuns);
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: true, state: 'green', run: successful });
    expect(fetchRuns).toHaveBeenCalledTimes(3);
    expect(opts.sleep.mock.calls).toEqual([[100], [100]]);
  });

  it('returns red when a pending run settles unsuccessfully', async () => {
    const failed = run({ conclusion: 'failure' });
    const fetchRuns = vi.fn().mockResolvedValueOnce([run({ status: 'queued', conclusion: null })]).mockResolvedValue([failed]);
    expect(await waitForRemoteVerify(options(fetchRuns))).toEqual({ ok: false, state: 'red', run: failed });
    expect(fetchRuns).toHaveBeenCalledTimes(2);
  });

  it('waits for the newest matching run rather than trusting an older green or another head', async () => {
    const pending = run({ id: 456, status: 'queued', conclusion: null });
    const runs = [run({ created_at: new Date(T0 - 1000).toISOString() }), pending,
      run({ head_sha: OTHER, created_at: new Date(T0 + 1000).toISOString() })];
    expect(await waitForRemoteVerify(options(async () => runs))).toEqual({ ok: false, state: 'timeout', run: pending });
  });

  it.each(['absent', 'pending', 'other-head'])('%s evidence at the deadline times out and never authorizes a marker', async (kind) => {
    const pending = run({ status: 'in_progress', conclusion: null });
    const runs = kind === 'absent' ? [] : kind === 'pending' ? [pending] : [run({ head_sha: OTHER })];
    const opts = options(vi.fn(async () => runs), { waitMs: 250 });
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: false, state: 'timeout', run: kind === 'pending' ? pending : null });
    expect(opts.now() - T0).toBe(250);
    expect(opts.sleep.mock.calls).toEqual([[100], [100], [50]]);
  });

  it('zero wait still probes once, then times out without sleeping', async () => {
    const fetchRuns = vi.fn(async () => []);
    const opts = options(fetchRuns, { waitMs: 0 });
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: false, state: 'timeout', run: null });
    expect(fetchRuns).toHaveBeenCalledTimes(1);
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it.each([540001, 5_400_000])('caps oversized waitMs=%s at 540000 and returns the explicit timeout fallback', async (waitMs) => {
    const opts = options(vi.fn(async () => []), { waitMs, pollMs: 200000 });
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: false, state: 'timeout', run: null });
    expect(opts.now() - T0).toBe(540000);
    expect(opts.sleep.mock.calls).toEqual([[200000], [200000], [140000]]);
  });

  it('fails closed as error when the initial fetch throws', async () => {
    const opts = options(vi.fn(async () => { throw new Error('unreadable workflow runs'); }));
    expect(await waitForRemoteVerify(opts)).toEqual({ ok: false, state: 'error', run: null });
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it.each([null, {}, [run({ created_at: 'unreadable' })], [run({ id: null })]])(
    'refuses malformed workflow listings (%j)', async (runs) => {
      expect(await waitForRemoteVerify(options(async () => runs))).toEqual({ ok: false, state: 'error', run: null });
    },
  );

  it.each([0, -1, NaN, Infinity])('refuses an invalid polling interval (%s) without fetching', async (pollMs) => {
    const fetchRuns = vi.fn();
    expect(await waitForRemoteVerify(options(fetchRuns, { pollMs }))).toEqual({ ok: false, state: 'error', run: null });
    expect(fetchRuns).not.toHaveBeenCalled();
  });

  it('fails closed as error when a later fetch throws instead of trusting the pending result', async () => {
    const pending = run({ status: 'queued', conclusion: null });
    const fetchRuns = vi.fn().mockResolvedValueOnce([pending]).mockRejectedValue(new Error('API unavailable'));
    const result = await waitForRemoteVerify(options(fetchRuns));
    expect(result).toMatchObject({ ok: false, state: 'error' });
    expect(result).toHaveProperty('run');
    expect(fetchRuns).toHaveBeenCalledTimes(2);
  });
});

describe('remote CLI — local preconditions', () => {
  function fixture(exercise) {
    const root = mkdtempSync(join(tmpdir(), 'remote-verify-cli-'));
    try {
      const origin = join(root, 'origin');
      const lane = join(root, 'lane');
      mkdirSync(origin);
      const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
      const git = (cwd, args, input) => execFileSync('git', args, {
        cwd, env, input, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      git(origin, ['init', '--initial-branch=main']);
      writeFileSync(join(origin, 'seed.txt'), 'initial\n');
      git(origin, ['add', 'seed.txt']);
      const tree = git(origin, ['write-tree']);
      const initial = git(origin, ['commit-tree', tree], 'initial fixture\n');
      git(origin, ['update-ref', 'refs/heads/main', initial]);
      git(root, ['clone', '--quiet', origin, lane]);
      const marker = join(lane, '.git', '.lane-verify');
      expect(existsSync(marker)).toBe(false);
      const invoke = (extraEnv = {}) => spawnSync(process.execPath, [
        join(process.cwd(), 'scripts/verify-lane.mjs'), 'remote', '--json',
      ], { cwd: lane, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
      exercise({ root, lane, marker, invoke, git, initial, tree });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function mockRemote({ root, initial }, url) {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const calls = join(root, 'gh-calls.jsonl');
    const gitCalls = join(root, 'git-calls.jsonl');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
      const { execFileSync } = require('node:child_process');
      const { appendFileSync } = require('node:fs');
      const args = process.argv.slice(2);
      appendFileSync(${JSON.stringify(gitCalls)}, JSON.stringify(args) + '\\n');
      if (args.includes('ls-remote')) {
        process.stdout.write(${JSON.stringify(initial)} + '\trefs/heads/main\\n');
      } else if (args.slice(-3).join(' ') === 'remote get-url origin') {
        process.stdout.write(${JSON.stringify(url)} + '\\n');
      } else process.stdout.write(execFileSync(${JSON.stringify(realGit)}, args));
    `);
    const successful = run({ head_sha: initial, run_attempt: 2 });
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
      const { appendFileSync, readFileSync } = require('node:fs');
      const args = process.argv.slice(2);
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, repo: process.env.GH_REPO, host: process.env.GH_HOST, memo: process.env.WE_GH_READ_MEMO_DIR }) + '\\n');
      let data = args.includes('view') ? 'ambient/wrong' : args.some(a => a.includes('/jobs?'))
        ? { total_count: 1, jobs: [{ name: 'verify', run_id: 123, head_sha: ${JSON.stringify(initial)},
          status: 'completed', conclusion: 'success', steps: [{ name: 'Required lane gate', status: 'completed', conclusion: 'success' }] }] }
        : { total_count: 1, workflow_runs: ${JSON.stringify([successful])} };
      if (process.env.FIXTURE_RERUN && data.workflow_runs
        && readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').length > 1) {
        data.workflow_runs[0].run_attempt += 1;
      }
      process.stdout.write(JSON.stringify(data));
    `);
    for (const file of ['git', 'gh']) chmodSync(join(bin, file), 0o755);
    return { calls, gitCalls, env: { PATH: `${bin}:${process.env.PATH}`, GH_REPO: 'ambient/wrong',
      WE_GH_THROTTLE_LOCK_ROOT: join(root, 'throttle'), WE_GH_THROTTLE_COST_HEADERS: '0' } };
  }

  it.each(['https://github.com/example/repo.git', 'git@github.com:example/repo.git',
    'https://github.com/example/repo', 'git@github.com:example/repo'])('binds every GitHub call to origin %s despite ambient GH_REPO', (url) => {
    fixture((ctx) => {
      const mock = mockRemote(ctx, url);
      const result = ctx.invoke(mock.env);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).ok).toBe(true);
      const calls = readFileSync(mock.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call.repo).toBe('example/repo');
        expect(call.args[0]).toBe('api');
        expect(call.args.some(arg => arg.startsWith('repos/example/repo/actions/'))).toBe(true);
      }
      expect(existsSync(ctx.marker)).toBe(true);
    });
  }, 20000);

  it.each(['https://example.test/example/repo.git', 'git@github.com.evil:example/repo.git',
    'https://github.com/example/repo/extra', '/local/repo', '', 'ssh://git@github.com/example/repo.git',
    'ext::touch remote-verify-unsafe'])('refuses unsupported origin %s before remote git or GitHub IO', (url) => {
    fixture((ctx) => {
      const mock = mockRemote(ctx, url);
      const result = ctx.invoke(mock.env);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, reason: 'remote-unavailable' });
      expect(existsSync(mock.calls)).toBe(false);
      const gitCalls = readFileSync(mock.gitCalls, 'utf8').trim().split('\n').map(JSON.parse);
      expect(gitCalls.some(args => args.includes('ls-remote'))).toBe(false);
      expect(existsSync(ctx.marker)).toBe(false);
    });
  }, 20000);

  it('pins the GitHub host for every API read despite ambient GH_HOST', () => {
    fixture((ctx) => {
      const mock = mockRemote(ctx, 'https://github.com/example/repo.git');
      const result = ctx.invoke({ ...mock.env, GH_HOST: 'enterprise.example.test' });
      expect(result.status).toBe(0);
      const calls = readFileSync(mock.calls, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call.host).toBe('github.com');
        expect(call.args).toEqual(expect.arrayContaining(['--hostname', 'github.com']));
      }
    });
  }, 20000);

  it.each([false, true])('bypasses inherited read memo for listing, jobs and final re-check (rerun=%s)', (rerun) => {
    fixture((ctx) => {
      const mock = mockRemote(ctx, 'https://github.com/example/repo.git');
      const memo = join(ctx.root, 'memo');
      mkdirSync(memo);
      const result = ctx.invoke({ ...mock.env, WE_GH_READ_MEMO_DIR: memo,
        WE_GH_THROTTLE_PERSONAL_ROUTE: '0', ...(rerun ? { FIXTURE_RERUN: '1' } : {}) });
      expect(result.status).toBe(rerun ? 2 : 0);
      expect(JSON.parse(result.stdout).ok).toBe(!rerun);
      const calls = readFileSync(mock.calls, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls).toHaveLength(3);
      expect(calls.filter(call => call.args.some(arg => arg.includes('/runs?')))).toHaveLength(2);
      expect(calls.filter(call => call.args.some(arg => arg.includes('/jobs?')))).toHaveLength(1);
      for (const call of calls) expect(call).not.toHaveProperty('memo');
      expect(readdirSync(memo)).toEqual([]);
      expect(existsSync(ctx.marker)).toBe(!rerun);
    });
  }, 20000);

  it('validates origin before ls-remote and restricts its allowed protocols', () => {
    fixture((ctx) => {
      const mock = mockRemote(ctx, 'git@github.com:example/repo.git');
      expect(ctx.invoke(mock.env).status).toBe(0);
      const calls = readFileSync(mock.gitCalls, 'utf8').trim().split('\n').map(JSON.parse);
      const contact = calls.findIndex(args => args.includes('ls-remote'));
      expect(contact).toBeGreaterThan(calls.findIndex(args => args.includes('get-url')));
      expect(calls[contact]).toEqual(['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
        '-c', 'protocol.ssh.allow=always', '-c', 'protocol.ext.allow=never', 'ls-remote', '--heads', 'origin']);
    });
  }, 20000);

  it('refuses a real ext origin without executing its helper even when repo config permits ext', () => {
    fixture(({ root, lane, marker, invoke, git }) => {
      const sentinel = join(root, 'ext-executed');
      git(lane, ['config', 'protocol.ext.allow', 'always']);
      git(lane, ['remote', 'set-url', 'origin', `ext::touch ${sentinel}`]);
      const result = invoke();
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, reason: 'remote-unavailable' });
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    });
  }, 20000);

  it('rejects a dirty tree at the CLI without writing a marker', () => {
    fixture(({ lane, marker, invoke, git, initial }) => {
      expect(git(lane, ['ls-remote', '--heads', 'origin'])).toContain(initial);
      writeFileSync(join(lane, 'seed.txt'), 'local untested edit\n');
      const result = invoke();
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, reason: 'dirty-tree' });
      expect(existsSync(marker)).toBe(false);
    });
  }, 20000);

  it('rejects an unpushed HEAD at the CLI without writing a marker', () => {
    fixture((ctx) => {
      const { lane, marker, invoke, git, initial, tree } = ctx;
      const unpushed = git(lane, ['commit-tree', tree, '-p', initial], 'local-only fixture\n');
      git(lane, ['update-ref', 'refs/heads/main', unpushed]);
      expect(git(lane, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
      expect(git(lane, ['ls-remote', '--heads', 'origin'])).not.toContain(unpushed);
      const mock = mockRemote(ctx, 'https://github.com/example/repo.git');
      const result = invoke(mock.env);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, reason: 'head-not-pushed' });
      expect(existsSync(marker)).toBe(false);
    });
  }, 20000);
});

describe('remote lane marker import — required gate evidence', () => {
  const successful = run({ run_attempt: 2 });
  const gateStep = { name: 'Required lane gate', status: 'completed', conclusion: 'success' };
  const job = (overrides = {}) => ({
    name: 'verify', run_id: successful.id, head_sha: SHA,
    status: 'completed', conclusion: 'success', steps: [gateStep], ...overrides,
  });
  async function importRun(jobs, overrides = {}) {
    const result = await waitForRemoteVerify({
      sha: SHA, fetchRuns: async () => [successful], waitMs: 0, ...fakeClock(),
    });
    expect(result.ok).toBe(true);
    return recordRemoteVerification({
      sha: SHA, treeHash: TREE, run: result.run, now: () => T0,
      fetchRuns: async () => [successful], fetchJobs: async () => jobs, treeUnchanged: () => true, ...overrides,
    });
  }

  it('rejects successful targeted runs as lane verification evidence', async () => {
    const writeMarker = vi.fn();
    const targeted = job({ steps: [{ ...gateStep, name: 'Targeted tests' }] });
    await expect(importRun([targeted], { writeMarker })).rejects.toThrow(/required lane gate/);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('writes the shared green marker after successful required-gate evidence', async () => {
    const writeMarker = vi.fn();
    const marker = await importRun([job()], { writeMarker });
    expect(writeMarker).toHaveBeenCalledTimes(1);
    expect(writeMarker).toHaveBeenCalledWith(marker);
    expect(marker).toEqual(buildRemoteMarker({ sha: SHA, treeHash: TREE, run: successful, now: () => T0 }));
  });

  it.each([
    null, [], [job({ steps: [] })], [job({ head_sha: OTHER })], [job({ run_id: 456 })],
    [job({ steps: [{ ...gateStep, conclusion: 'skipped' }] })],
    [job({ steps: [{ ...gateStep, status: 'in_progress' }] })],
    [job({ conclusion: 'failure' })], [job(), job()],
  ])('writes nothing for incomplete or unsuccessful gate evidence (%j)', async (jobs) => {
    const writeMarker = vi.fn();
    await expect(importRun(jobs, { writeMarker })).rejects.toThrow();
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('writes nothing when the job read fails or the tree changes during the read', async () => {
    const writeMarker = vi.fn();
    await expect(importRun([job()], { writeMarker, fetchJobs: async () => { throw new Error('unreadable'); } })).rejects.toThrow();
    await expect(importRun([job()], { writeMarker, treeUnchanged: () => false })).rejects.toThrow(/tree changed/);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('rechecks the run list after the attempt jobs and before writing', async () => {
    const order = [];
    await importRun([job()], {
      fetchJobs: async (selected) => { expect(selected).toEqual(successful); order.push('jobs'); return [job()]; },
      fetchRuns: async () => { order.push('runs'); return [successful]; },
      writeMarker: () => order.push('write'),
    });
    expect(order).toEqual(['jobs', 'runs', 'write']);
  });

  it.each([
    ['newer queued run', [successful, run({ id: 456, created_at: new Date(T0 + 1000).toISOString(), status: 'queued', conclusion: null })]],
    ['newer successful run', [successful, run({ id: 456, created_at: new Date(T0 + 1000).toISOString() })]],
    ['rerun attempt', [{ ...successful, run_attempt: 3 }]],
    ['missing attempt', [{ ...successful, run_attempt: undefined }]],
    ['pending', [{ ...successful, status: 'in_progress' }]],
    ['failed', [{ ...successful, conclusion: 'failure' }]],
    ['missing run', []], ['unrelated head', [{ ...successful, head_sha: OTHER }]],
    ['unreadable listing', null], ['malformed listing', [{ ...successful, created_at: 'bad' }]],
  ])('writes no marker when the final run list shows %s', async (_label, runs) => {
    const writeMarker = vi.fn();
    await expect(importRun([job()], { fetchRuns: async () => runs, writeMarker })).rejects.toThrow(/local verify/);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('writes no marker when the final run list read throws', async () => {
    const writeMarker = vi.fn();
    await expect(importRun([job()], { fetchRuns: async () => { throw new Error('unreadable'); }, writeMarker })).rejects.toThrow();
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('refuses old runs without attempt evidence before reading jobs', async () => {
    const fetchJobs = vi.fn();
    const writeMarker = vi.fn();
    await expect(importRun([], { run: run(), fetchJobs, writeMarker })).rejects.toThrow(/attempt evidence/);
    expect(fetchJobs).not.toHaveBeenCalled();
    expect(writeMarker).not.toHaveBeenCalled();
  });
});

describe('remote-verify workflow — source contract', () => {
  const source = () => readFileSync(join(process.cwd(), '.github/workflows/remote-verify.yml'), 'utf8');

  it('publishes evaluated dispatch inputs in run metadata for concurrent request correlation', () => {
    const workflow = yaml.safeLoad(source());
    expect(workflow['run-name']).toBe('remote-verify ${{ toJSON(inputs) }}');
  });

  it('gives targeted tests a distinct step name from the required lane gate', () => {
    const workflow = yaml.safeLoad(source());
    const step = workflow.jobs.verify.steps.find((step) => step.env?.VERIFY_MODE);
    expect(step.name).toBe("${{ inputs.mode == 'targeted' && 'Targeted tests' || 'Required lane gate' }}");
    expect(step.run).toContain("case 'lane-check':");
    expect(step.run).toContain("run('node', ['scripts/verify-lane.mjs', 'run'])");
    expect(step.run).toContain("run('npm', ['run', 'check:standards'])");
    expect(step.run).toContain("run('npm', ['run', 'test:unit'])");
  });

  it('pins lane-check/full and push checkout to github.sha; only targeted may choose ref', () => {
    const workflow = yaml.safeLoad(source());
    const checkout = workflow.jobs.verify.steps.find(step => step.name === 'Checkout WE');
    expect(checkout.with.ref).toBe("${{ inputs.mode == 'targeted' && (inputs.ref || github.sha) || github.sha }}");
  });

  it('checks the actual checkout head for lane-check/full and fails on mismatches', () => {
    const workflow = yaml.safeLoad(source());
    const steps = workflow.jobs.verify.steps;
    const guard = steps.find(step => step.name === 'Verify checkout SHA');
    expect(guard).toBeDefined();
    expect(guard.if).toBe("${{ inputs.mode != 'targeted' }}");
    expect(guard.env.EXPECTED_SHA).toBe('${{ github.sha }}');
    expect(steps.indexOf(guard)).toBeGreaterThan(steps.findIndex(step => step.name === 'Checkout WE'));
    expect(steps.indexOf(guard)).toBeLessThan(steps.findIndex(step => step.env?.VERIFY_MODE));
    const root = mkdtempSync(join(tmpdir(), 'remote-sha-guard-'));
    try {
      writeFileSync(join(root, 'git'), '#!/bin/sh\nprintf "%s\\n" "$TEST_HEAD"\n');
      chmodSync(join(root, 'git'), 0o755);
      for (const head of [SHA, OTHER, '']) {
        const result = spawnSync('bash', ['-e', '-c', guard.run], { cwd: root,
          env: { ...process.env, PATH: `${root}:${process.env.PATH}`, EXPECTED_SHA: SHA, TEST_HEAD: head } });
        expect(result.status === 0).toBe(head === SHA);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('triggers workflow_dispatch and pushes to lane/**', () => {
    const text = source();
    expect(text).toMatch(/\bworkflow_dispatch\s*:/);
    const workflow = yaml.safeLoad(text);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on.push.branches).toContain('lane/**');
  });

  it('grants contents read only and permits no job-level escalation', () => {
    const text = source();
    expect(text).toMatch(/\bcontents:\s*read\b/);
    const workflow = yaml.safeLoad(text);
    const checkPermissions = (permissions) => {
      expect(permissions).toBeTruthy();
      expect(typeof permissions).toBe('object');
      expect(permissions.contents).toBe('read');
      for (const [name, level] of Object.entries(permissions)) {
        if (name !== 'contents') {
          expect(['checks', 'statuses']).toContain(name);
          expect(level).toBe('none');
        }
      }
    };
    checkPermissions(workflow.permissions);
    for (const job of Object.values(workflow.jobs)) {
      if (job.permissions !== undefined) checkPermissions(job.permissions);
    }
  });

  it('uses the configured shard runner with ubuntu-latest as fallback', () => {
    const workflow = yaml.safeLoad(source());
    const jobs = Object.values(workflow.jobs);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job['runs-on']).toMatch(/^\$\{\{\s*vars\.WE_SHARD_RUNNER\s*\|\|\s*['"]ubuntu-latest['"]\s*\}\}$/);
    }
  });

  it('references no secrets except secrets.GITHUB_TOKEN', () => {
    expect(source().replace(/\bsecrets\.GITHUB_TOKEN\b/g, '')).not.toMatch(/secrets\./i);
  });

  it('contains no model-provider or agent references, case-insensitively', () => {
    expect(source()).not.toMatch(/claude|codex|anthropic|openai/i);
  });
});

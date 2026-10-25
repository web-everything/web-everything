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

  it('newer targeted dispatch cannot hide a push lane gate or become lane evidence', () => {
    const push = run();
    const targeted = run({ id: 456, event: 'workflow_dispatch', display_title: 'remote-verify (targeted)',
      created_at: new Date(T0 + 1000).toISOString() });
    expect(selectRemoteVerifyRun([targeted, push], SHA)).toEqual(push);
    expect(selectRemoteVerifyRun([targeted], SHA)).toBeNull();
    // A push's title is not a reliable mode indicator on legacy runs.
    expect(selectRemoteVerifyRun([{ ...targeted, event: 'push' }], SHA)?.id).toBe(456);
    for (const mode of ['lane-check', 'full']) {
      const gate = { ...targeted, display_title: `remote-verify (${mode})` };
      expect(selectRemoteVerifyRun([push, gate], SHA)).toEqual(gate);
    }
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

  it('omitted waitMs probes once without sleeping', async () => {
    const fetchRuns = vi.fn(async () => []);
    const clock = fakeClock();
    expect(await waitForRemoteVerify({ sha: SHA, fetchRuns, ...clock }))
      .toEqual({ ok: false, state: 'timeout', run: null });
    expect(fetchRuns).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(clock.now()).toBe(T0);
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

  function mockRemote({ root, initial, tree }, url) {
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
      const commit = args.find(a => a.includes('/commits/'));
      let data = commit ? { sha: commit.endsWith('/main') ? ${JSON.stringify(OTHER)} : ${JSON.stringify(initial)},
        commit: { tree: { sha: process.env.FIXTURE_CHANGED_DEFINITION && !commit.endsWith('/main')
          ? 'd'.repeat(40) : ${JSON.stringify(tree)} } } }
        : args.includes('view') ? 'ambient/wrong' : args.some(a => a.includes('/jobs?'))
        ? { total_count: 1, jobs: [{ name: 'verify', run_id: 123, head_sha: ${JSON.stringify(initial)},
          status: 'completed', conclusion: 'success', steps: [{ name: 'Required lane gate', status: 'completed', conclusion: 'success' }] }] }
        : process.env.FIXTURE_ABSENT ? { total_count: 0, workflow_runs: [] }
        : { total_count: 1, workflow_runs: ${JSON.stringify([successful])} };
      if (process.env.FIXTURE_RERUN && data.workflow_runs
        && readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').length > 1) {
        data.workflow_runs[0].run_attempt += 1;
      }
      if (commit && process.env.FIXTURE_UNREADABLE_DEFINITION) data = {};
      if (commit && process.env.FIXTURE_OVERSIZED_DEFINITION) data.padding = 'x'.repeat(2 * 1024 * 1024);
      if (commit && commit.endsWith('/main') && process.env.FIXTURE_MOVED_DEFINITION
        && readFileSync(${JSON.stringify(calls)}, 'utf8').split('/commits/main').length > 2) {
        data.sha = 'e'.repeat(40);
      }
      process.stdout.write(JSON.stringify(data));
    `);
    for (const file of ['git', 'gh']) chmodSync(join(bin, file), 0o755);
    return { calls, gitCalls, env: { PATH: `${bin}:${process.env.PATH}`, GH_REPO: 'ambient/wrong',
      WE_GH_THROTTLE_LOCK_ROOT: join(root, 'throttle'), WE_GH_THROTTLE_COST_HEADERS: '0' } };
  }

  it.each(['https://github.com/web-everything/web-everything.git', 'git@github.com:web-everything/web-everything.git',
    'https://github.com/web-everything/web-everything', 'git@github.com:web-everything/web-everything'])('binds every GitHub call to canonical origin %s despite ambient GH_REPO', (url) => {
    fixture((ctx) => {
      const mock = mockRemote(ctx, url);
      const result = ctx.invoke(mock.env);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).ok).toBe(true);
      const calls = readFileSync(mock.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls).toHaveLength(7);
      const runPath = `repos/web-everything/web-everything/actions/workflows/remote-verify.yml/runs?head_sha=${ctx.initial}&per_page=100`;
      const headPath = `repos/web-everything/web-everything/commits/${ctx.initial}`;
      const basePath = 'repos/web-everything/web-everything/commits/main';
      expect(calls.map(call => call.args.at(-1))).toEqual([runPath,
        'repos/web-everything/web-everything/actions/runs/123/attempts/2/jobs?per_page=100',
        headPath, basePath, runPath, headPath, basePath]);
      for (const call of calls) {
        expect(call.repo).toBe('web-everything/web-everything');
        expect(call.args[0]).toBe('api');
      }
      expect(calls.filter(call => call.args.includes(`repos/web-everything/web-everything/commits/${ctx.initial}`))).toHaveLength(2);
      expect(calls.filter(call => call.args.includes('repos/web-everything/web-everything/commits/main'))).toHaveLength(2);
      expect(JSON.parse(readFileSync(ctx.marker, 'utf8')).remote).toMatchObject({
        repository: 'web-everything/web-everything', protectedSha: OTHER, definitionTree: ctx.tree, runAttempt: 2,
      });
      expect(existsSync(ctx.marker)).toBe(true);
    });
  }, 20000);

  it.each(['FIXTURE_CHANGED_DEFINITION', 'FIXTURE_UNREADABLE_DEFINITION', 'FIXTURE_MOVED_DEFINITION',
    'FIXTURE_OVERSIZED_DEFINITION'])
  ('refuses forged green labels when the protected definition fails at the CLI (%s)', (failure) => {
    fixture((ctx) => {
      const mock = mockRemote(ctx, 'https://github.com/web-everything/web-everything.git');
      const result = ctx.invoke({ ...mock.env, [failure]: '1' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, reason: 'untrusted-definition',
        detail: expect.stringMatching(/canonical main.*local verify/) });
      expect(existsSync(ctx.marker)).toBe(false);
    });
  }, 20000);

  it.each(['https://github.com/hostile/fork.git', 'git@github.com:hostile/fork.git',
    'https://github.com/web-everything/fork', 'https://github.com/hostile/web-everything',
    'https://github.com/web-everything/web-everything.evil'])('refuses non-canonical GitHub origin %s before remote IO', (url) => {
    fixture((ctx) => {
      const mock = mockRemote(ctx, url);
      expect(ctx.invoke(mock.env).status).toBe(2);
      expect(existsSync(mock.calls)).toBe(false);
      const calls = readFileSync(mock.gitCalls, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls.some(args => args.includes('ls-remote'))).toBe(false);
      expect(existsSync(ctx.marker)).toBe(false);
    });
  }, 20000);

  it('omitted --wait probes once for absent evidence without polling or a marker', () => {
    fixture((ctx) => {
      const mock = mockRemote(ctx, 'https://github.com/web-everything/web-everything.git');
      const noSleep = join(ctx.root, 'no-sleep.cjs');
      writeFileSync(noSleep, "globalThis.setTimeout = () => { throw new Error('unexpected polling sleep'); };\n");
      const result = ctx.invoke({ ...mock.env, FIXTURE_ABSENT: '1', NODE_OPTIONS: `--require=${noSleep}` });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, state: 'timeout' });
      const calls = readFileSync(mock.calls, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls).toHaveLength(1);
      expect(calls[0].args.some(arg => arg.includes('/runs?'))).toBe(true);
      expect(existsSync(ctx.marker)).toBe(false);
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
      const mock = mockRemote(ctx, 'https://github.com/web-everything/web-everything.git');
      const result = ctx.invoke({ ...mock.env, GH_HOST: 'enterprise.example.test' });
      expect(result.status).toBe(0);
      const calls = readFileSync(mock.calls, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls).toHaveLength(7);
      for (const call of calls) {
        expect(call.host).toBe('github.com');
        expect(call.args).toEqual(expect.arrayContaining(['--hostname', 'github.com']));
      }
    });
  }, 20000);

  it.each([false, true])('bypasses inherited read memo for listing, jobs and final re-check (rerun=%s)', (rerun) => {
    fixture((ctx) => {
      const mock = mockRemote(ctx, 'https://github.com/web-everything/web-everything.git');
      const memo = join(ctx.root, 'memo');
      mkdirSync(memo);
      const result = ctx.invoke({ ...mock.env, WE_GH_READ_MEMO_DIR: memo,
        WE_GH_THROTTLE_PERSONAL_ROUTE: '0', ...(rerun ? { FIXTURE_RERUN: '1' } : {}) });
      expect(result.status).toBe(rerun ? 2 : 0);
      expect(JSON.parse(result.stdout).ok).toBe(!rerun);
      const calls = readFileSync(mock.calls, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls).toHaveLength(rerun ? 5 : 7);
      expect(calls.filter(call => call.args.some(arg => arg.includes('/runs?')))).toHaveLength(2);
      expect(calls.filter(call => call.args.some(arg => arg.includes('/jobs?')))).toHaveLength(1);
      for (const call of calls) expect(call).not.toHaveProperty('memo');
      expect(readdirSync(memo)).toEqual([]);
      expect(existsSync(ctx.marker)).toBe(!rerun);
    });
  }, 20000);

  it('validates origin before ls-remote and restricts its allowed protocols', () => {
    fixture((ctx) => {
      const mock = mockRemote(ctx, 'git@github.com:web-everything/web-everything.git');
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
      const mock = mockRemote(ctx, 'https://github.com/web-everything/web-everything.git');
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
  const definition = () => ({
    head: { sha: SHA, commit: { tree: { sha: TREE } } },
    base: { sha: OTHER, commit: { tree: { sha: TREE } } },
  });
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
      fetchDefinition: async () => definition(),
      fetchRuns: async () => [successful], fetchJobs: async () => jobs, treeUnchanged: () => true, ...overrides,
    });
  }

  it.each(['workflow no-op', 'gate script', 'transitive helper', 'package lifecycle', 'test configuration'])
  ('refuses lane-edited %s despite successful job and step names', async () => {
    const writeMarker = vi.fn();
    const changed = definition();
    changed.head.commit.tree.sha = 'd'.repeat(40);
    await expect(importRun([job()], { writeMarker, fetchDefinition: async () => changed }))
      .rejects.toThrow(/protected definition.*local verify/i);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { head: null, base: null }])
  ('refuses missing or unreadable protected definitions (%j)', async (evidence) => {
    const writeMarker = vi.fn();
    await expect(importRun([job()], { writeMarker, fetchDefinition: async () => evidence }))
      .rejects.toThrow(/protected definition.*local verify/i);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('refuses callers without a protected-definition reader', async () => {
    const writeMarker = vi.fn();
    await expect(importRun([job()], { writeMarker, fetchDefinition: undefined }))
      .rejects.toThrow(/protected definition.*local verify/i);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it.each(['head SHA', 'protected SHA', 'head tree', 'protected tree'])
  ('refuses incomplete or malformed protected-definition identifiers (%s)', async (field) => {
    const evidence = definition();
    if (field === 'head SHA') evidence.head.sha = SHA.slice(0, 7);
    if (field === 'protected SHA') evidence.base.sha = '../main';
    if (field === 'head tree') evidence.head.commit.tree.sha = '';
    if (field === 'protected tree') evidence.base.commit.tree.sha = TREE + '\n';
    const writeMarker = vi.fn();
    await expect(importRun([job()], { writeMarker, fetchDefinition: async () => evidence }))
      .rejects.toThrow(/protected definition.*local verify/i);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it.each([1, 2])('refuses an unavailable protected-definition read at probe %s', async (probe) => {
    const fetchDefinition = vi.fn();
    if (probe === 2) fetchDefinition.mockResolvedValueOnce(definition());
    fetchDefinition.mockRejectedValue(new Error('API unavailable'));
    const writeMarker = vi.fn();
    await expect(importRun([job()], { writeMarker, fetchDefinition }))
      .rejects.toThrow(/protected definition.*local verify/i);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('normalizes Git object IDs consistently across definition reads', async () => {
    const evidence = definition();
    evidence.head.sha = SHA.toUpperCase();
    evidence.head.commit.tree.sha = TREE.toUpperCase();
    evidence.base.sha = OTHER.toUpperCase();
    const writeMarker = vi.fn();
    const fetchDefinition = vi.fn().mockResolvedValueOnce(evidence).mockResolvedValue(definition());
    const marker = await importRun([job()], { writeMarker, fetchDefinition });
    expect(marker.remote.protectedSha).toBe(OTHER);
    expect(marker.remote.definitionTree).toBe(TREE);
    expect(writeMarker).toHaveBeenCalledTimes(1);
  });

  it('refuses an exact-head definition substituted with another commit', async () => {
    const writeMarker = vi.fn();
    const evidence = definition();
    evidence.head.sha = OTHER;
    await expect(importRun([job()], { writeMarker, fetchDefinition: async () => evidence }))
      .rejects.toThrow(/protected definition.*local verify/i);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('rechecks the protected revision before writing even when its tree is unchanged', async () => {
    const writeMarker = vi.fn();
    const moved = definition();
    moved.base.sha = 'd'.repeat(40);
    const fetchDefinition = vi.fn().mockResolvedValueOnce(definition()).mockResolvedValue(moved);
    await expect(importRun([job()], { writeMarker, fetchDefinition }))
      .rejects.toThrow(/protected definition.*local verify/i);
    expect(fetchDefinition).toHaveBeenCalledTimes(2);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('refuses a changed dependency tree on the final definition read', async () => {
    const changed = definition();
    changed.base.commit.tree.sha = 'd'.repeat(40);
    const fetchDefinition = vi.fn().mockResolvedValueOnce(definition()).mockResolvedValue(changed);
    const writeMarker = vi.fn();
    await expect(importRun([job()], { writeMarker, fetchDefinition }))
      .rejects.toThrow(/protected definition.*local verify/i);
    expect(writeMarker).not.toHaveBeenCalled();
  });

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
    const expected = buildRemoteMarker({ sha: SHA, treeHash: TREE, run: successful, now: () => T0 });
    expect(marker).toEqual({ ...expected, remote: { ...expected.remote,
      repository: 'web-everything/web-everything', protectedSha: OTHER, definitionTree: TREE, runAttempt: 2 } });
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

  it('a targeted dispatch during job verification does not invalidate the required lane run', async () => {
    const targeted = run({ id: 456, event: 'workflow_dispatch', display_title: 'remote-verify (targeted)',
      created_at: new Date(T0 + 1000).toISOString() });
    const writeMarker = vi.fn();
    await importRun([job()], { fetchRuns: async () => [successful, targeted], writeMarker });
    expect(writeMarker).toHaveBeenCalledTimes(1);
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

describe('remote verification dispatcher — validated argv', () => {
  async function commands(input, files = []) {
    const { remoteVerifyCommands } = await import('../lib/remote-verify-dispatch.mjs');
    return remoteVerifyCommands(input, (file) => files.includes(file));
  }

  it('lane-check and full invoke the required gates in order', async () => {
    expect(await commands({ mode: 'lane-check' })).toEqual([['node', ['scripts/verify-lane.mjs', 'run']]]);
    expect(await commands({ mode: 'full' })).toEqual([
      ['npm', ['run', 'check:standards']], ['npm', ['run', 'test:unit']],
    ]);
  });

  it('targeted tests remain separate literal argv and take precedence over operation', async () => {
    const files = ['scripts/a.test.mjs', 'scripts/`echo`.test.mjs', "scripts/a'b.test.mjs"];
    expect(await commands({ mode: 'targeted', tests: ` ${files.join('\n')} `, operation: '../evil' }, files))
      .toEqual([['npm', ['run', 'test:unit', '--', ...files]]]);
  });

  it.each(['--config=evil', '-t', 'missing.test.mjs', 'scripts/good.test.mjs --config=evil'])(
    'targeted mode rejects option-like or nonexistent test paths: %s', async (tests) => {
      await expect(commands({ mode: 'targeted', tests }, ['--config=evil', '-t', 'scripts/good.test.mjs']))
        .rejects.toThrow(/existing test file paths/);
    });

  it.each(['', '--config=evil', '../evil', 'name/io', 'foo;bar', 'foo`bar`', 'foo\nbar',
    'foo\rbar', 'foo\u2028bar', 'ｆoo', 'foo\u200b', 'FOO', 'a_b', 'a.b', "a'b"])(
    'targeted mode rejects malformed operation %j', async (operation) => {
      await expect(commands({ mode: 'targeted', operation })).rejects.toThrow(/operation name/);
    });

  it('targeted mode rejects an unknown operation even when its IO companion exists', async () => {
    await expect(commands({ mode: 'targeted', operation: 'missing' }, ['scripts/operations/missing-io.mjs']))
      .rejects.toThrow(/Unknown operation/);
  });

  it.each([false, true])('targets operation declaration and optional IO companion (companion=%s)', async (companion) => {
    const files = ['scripts/operations/review-pr.mjs', ...(companion ? ['scripts/operations/review-pr-io.mjs'] : [])];
    expect(await commands({ mode: 'targeted', operation: ' review-pr ' }, files)).toEqual([
      ['node', ['scripts/readiness/heavy-admission.mjs', 'run', '--', 'npx', 'vitest', 'related', '--run', ...files]],
    ]);
  });

  it.each(['unknown', '', 'targeted;full'])('rejects unknown mode %j', async (mode) => {
    await expect(commands({ mode })).rejects.toThrow(/Unknown verification mode/);
  });
});

describe('remote-verify workflow — source contract', () => {
  const source = () => readFileSync(join(process.cwd(), '.github/workflows/remote-verify.yml'), 'utf8');

  it('gives targeted tests a distinct step name from the required lane gate', () => {
    const workflow = yaml.safeLoad(source());
    const step = workflow.jobs.verify.steps.find((step) => step.env?.VERIFY_MODE);
    expect(step.name).toBe("${{ inputs.mode == 'targeted' && 'Targeted tests' || 'Required lane gate' }}");
    expect(step.run).toContain("from '../remote-verify-source/scripts/lib/remote-verify-dispatch.mjs'");
    expect(step.run).toContain('remoteVerifyCommands(');
    expect(step.run).toContain('execFileSync(file, args,');
    expect(step.env).toEqual({ VERIFY_MODE: "${{ inputs.mode || 'lane-check' }}",
      VERIFY_TESTS: '${{ inputs.tests }}', VERIFY_OPERATION: '${{ inputs.operation }}' });
  });

  it('targeted, full and lane-check dispatch groups can never cancel a push group', () => {
    const workflow = yaml.safeLoad(source());
    expect(workflow['run-name']).toBe("remote-verify (${{ inputs.mode || 'lane-check' }})");
    const group = (inputs, event = 'workflow_dispatch', ref = 'refs/heads/lane/x') =>
      workflow.concurrency.group.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) =>
        Function('inputs', 'github', `return (${expression});`)(inputs, { event_name: event, ref }));
    const pushGroup = group({}, 'push');
    for (const mode of ['targeted', 'lane-check', 'full']) {
      for (const ref of ['', 'refs/heads/lane/x', SHA]) {
        expect(group({ mode, ref })).not.toBe(pushGroup);
      }
    }
    expect(group({ mode: 'targeted' })).not.toBe(group({ mode: 'lane-check' }));
    expect(group({ mode: 'targeted', ref: SHA })).not.toBe(group({ mode: 'full', ref: SHA }));
    expect(workflow.concurrency['cancel-in-progress']).toBe(true);
  });

  it('caches npm downloads rather than node_modules that npm ci deletes', () => {
    const steps = yaml.safeLoad(source()).jobs.verify.steps;
    expect(steps.some(step => step.uses?.startsWith('actions/cache@'))).toBe(false);
    const setup = steps.find(step => step.uses?.startsWith('actions/setup-node@'));
    expect(setup.with.cache).toBe('npm');
    expect(setup.with['cache-dependency-path']).toContain('frontierui/package-lock.json');
  });

  it('executes the workflow dispatcher against a historical target without its own dispatcher and rejects hostile values before spawning', () => {
    const step = yaml.safeLoad(source()).jobs.verify.steps.find(step => step.env?.VERIFY_MODE);
    const root = mkdtempSync(join(tmpdir(), 'remote-dispatch-wiring-'));
    const calls = join(root, 'calls.jsonl');
    try {
      const target = join(root, 'web-everything');
      const dispatcherDir = join(root, 'remote-verify-source/scripts/lib');
      mkdirSync(dispatcherDir, { recursive: true });
      writeFileSync(join(dispatcherDir, 'remote-verify-dispatch.mjs'),
        readFileSync(join(process.cwd(), 'scripts/lib/remote-verify-dispatch.mjs'), 'utf8'));
      for (const file of ['scripts/__tests__/remote-verify.test.mjs',
        'scripts/operations/review-pr.mjs', 'scripts/operations/review-pr-io.mjs']) {
        mkdirSync(join(target, file, '..'), { recursive: true });
        writeFileSync(join(target, file), '');
      }
      expect(existsSync(join(target, 'scripts/lib/remote-verify-dispatch.mjs'))).toBe(false);
      for (const command of ['npm', 'node']) {
        writeFileSync(join(root, command), `#!${process.execPath}\n` +
          `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(command)}, process.argv.slice(2)]) + '\\n');\n`);
        chmodSync(join(root, command), 0o755);
      }
      const script = /^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\s*$/.exec(step.run)?.[1];
      expect(script).toBeTruthy();
      const declaration = 'scripts/operations/review-pr.mjs';
      const io = 'scripts/operations/review-pr-io.mjs';
      const cases = [
        { mode: 'lane-check', expected: [['node', ['scripts/verify-lane.mjs', 'run']]] },
        { mode: 'full', expected: [['npm', ['run', 'check:standards']], ['npm', ['run', 'test:unit']]] },
        { mode: 'targeted', tests: 'scripts/__tests__/remote-verify.test.mjs',
          expected: [['npm', ['run', 'test:unit', '--', 'scripts/__tests__/remote-verify.test.mjs']]] },
        { mode: 'targeted', operation: 'review-pr', expected: [['node',
          ['scripts/readiness/heavy-admission.mjs', 'run', '--', 'npx', 'vitest', 'related', '--run',
            declaration, io]]] },
        { mode: 'targeted', tests: '--config=evil' },
        { mode: 'targeted', tests: 'missing.test.mjs' },
        { mode: 'targeted', operation: '../evil' },
        { mode: 'targeted', operation: 'no-such-operation-for-remote-verify' },
        { mode: 'unknown' },
      ];
      for (const { mode, tests = '', operation = '', expected } of cases) {
        writeFileSync(calls, '');
        const result = spawnSync(process.execPath, ['--input-type=module'], {
          cwd: target, input: script, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
          env: { ...process.env, PATH: `${root}:${process.env.PATH}`,
            VERIFY_MODE: mode, VERIFY_TESTS: tests, VERIFY_OPERATION: operation },
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(expected ? 0 : 1);
        const text = readFileSync(calls, 'utf8').trim();
        expect(text ? text.split('\n').map(JSON.parse) : []).toEqual(expected ?? []);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('pins lane-check/full and push checkout to github.sha; only targeted may choose ref', () => {
    const workflow = yaml.safeLoad(source());
    const checkout = workflow.jobs.verify.steps.find(step => step.name === 'Checkout WE');
    expect(checkout.with.ref).toBe("${{ inputs.mode == 'targeted' && (inputs.ref || github.sha) || github.sha }}");
  });

  it('checks out the dispatcher from the triggering SHA independently of the targeted ref', () => {
    const steps = yaml.safeLoad(source()).jobs.verify.steps;
    const dispatcher = steps.find(step => step.name === 'Checkout verification dispatcher');
    expect(dispatcher?.uses).toBe('actions/checkout@v4');
    expect(dispatcher?.if).toBeUndefined();
    expect(dispatcher?.with).toEqual({ path: 'remote-verify-source', ref: '${{ github.sha }}',
      'sparse-checkout': 'scripts/lib/remote-verify-dispatch.mjs', 'sparse-checkout-cone-mode': false,
      'persist-credentials': false });
    expect(steps.indexOf(dispatcher)).toBeLessThan(steps.findIndex(step => step.env?.VERIFY_MODE));
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

  it('uses CI App-token authentication and fallback for every external checkout', () => {
    const ci = yaml.safeLoad(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
    const canonical = Object.values(ci.jobs).flatMap(job => job.steps ?? [])
      .find(step => step.with?.repository === 'frontier-ui/frontierui');
    const steps = yaml.safeLoad(source()).jobs.verify.steps;
    const mint = steps.find(step => step.id === 'fui-app-token');
    expect(mint?.uses).toBe('actions/create-github-app-token@v2');
    expect(mint?.if).toBe("vars.WE_APP_ID != ''");
    expect(mint?.with).toEqual({ 'app-id': '${{ vars.WE_APP_ID }}', 'private-key': '${{ secrets.WE_APP_PRIVATE_KEY }}',
      owner: 'frontier-ui', repositories: 'frontierui', 'permission-contents': 'read' });
    const external = steps.filter(step => step.uses?.startsWith('actions/checkout@') && step.with?.repository);
    expect(external).toHaveLength(1);
    for (const checkout of external) {
      expect(checkout.with.token).toBe(canonical.with.token);
      expect(steps.indexOf(mint)).toBeLessThan(steps.indexOf(checkout));
    }
    expect(source().replace(/\bsecrets\.(GITHUB_TOKEN|WE_APP_PRIVATE_KEY|FUI_READ_TOKEN)\b/g, ''))
      .not.toMatch(/secrets\./i);
  });

  it('contains no model-provider or agent references, case-insensitively', () => {
    expect(source()).not.toMatch(/claude|codex|anthropic|openai/i);
  });
});

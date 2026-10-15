import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { classifyFinishedCiRead, finishedCiAuthScope, finishedCiStorable, resolveFinishedCiCacheSettings,
  lookupFinishedCi, storeFinishedCi, invalidateForWrite, finishedCiCacheDir } from '../finished-ci-cache.mjs';
import { runGhSync, runGhCliPassthrough } from '../gh-throttle.mjs';

const dirs = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const jobs = ['api', 'repos/o/r/actions/runs/123/jobs?per_page=100'];
const checks = ['api', `repos/o/r/commits/${'a'.repeat(40)}/check-runs?per_page=100`];
const log = ['api', 'repos/o/r/actions/jobs/456/logs'];
function fixture(output = '{"total_count":1,"jobs":[{"status":"completed"}]}') {
  const dir = mkdtempSync(join(tmpdir(), 'finished-ci-')); dirs.push(dir);
  let time = Date.now();
  const binDir = join(dir, 'bin'); mkdirSync(binDir);
  writeFileSync(join(binDir, 'gh'), '#!/bin/sh\n', { mode: 0o700 });
  vi.stubEnv('GH_TOKEN', 'ghs_ci_cache_fixture');
  vi.stubEnv('GH_HOST', 'github.com');
  vi.stubEnv('PATH', binDir);
  const env = { ...process.env, WE_UNDER_TEST: '1', WE_FINISHED_CI_CACHE_DIR: join(dir, 'cache'),
    GH_TOKEN: 'ghs_ci_cache_fixture', PATH: binDir,
    WE_FINISHED_CI_CACHE: '1', WE_GH_PERSONAL_READS: '0', WE_GH_THROTTLE_COST_HEADERS: '1' };
  delete env.WE_GH_READ_MEMO_DIR;
  const spawn = vi.fn((_bin, args, opts) => {
    const text = /\/(456|123)$/.test(args[1]) ? '{"status":"completed"}' : output;
    return { status: 0, stdout: opts.encoding ? text : Buffer.from(text), stderr: Buffer.alloc(0) };
  });
  const throttle = { env, spawn, personalRoute: false, lockRoot: join(dir, 'locks'), logPath: join(dir, 'calls.jsonl'),
    caller: 'ci-cache-test', now: () => time, maxAttempts: 1, cap: 2, budgetPerMin: 10000, writeBudgetPerMin: 10000 };
  return { dir, env, spawn, throttle, opts: { encoding: 'utf8', env, throttle },
    advance: ms => { time += ms; }, now: () => time,
    cacheOpts: () => ({ env, nowMs: time, settings: resolveFinishedCiCacheSettings(env) }),
    files: () => { try { return readdirSync(env.WE_FINISHED_CI_CACHE_DIR).filter(n => n.endsWith('.gz')); } catch { return []; } },
    reads: () => spawn.mock.calls.filter(([, args]) => args[1] !== 'repos/o/r/actions/runs/123'),
    rows: () => readFileSync(throttle.logPath, 'utf8').trim().split('\n').map(JSON.parse) };
}

describe('finished CI cache (card 309)', () => {
  it('classifies only exact supported reads and jq projections', () => {
    for (const [args, kind, jq] of [[jobs, 'run-jobs', '.jobs'], [checks, 'check-runs', '.check_runs'], [log, 'job-log', null]]) {
      expect(classifyFinishedCiRead(args)).toMatchObject({ kind, repo: 'o/r', key: JSON.stringify(args) });
      expect(classifyFinishedCiRead(['api', '/' + args[1]])?.kind).toBe(kind);
      if (jq) for (const flags of [['--jq', jq], [`--jq=${jq}`]]) expect(classifyFinishedCiRead([...args, ...flags])?.kind).toBe(kind);
      for (const flags of [['--paginate'], ['-i'], ['-H', 'x'], ['--method', 'GET'], ['-f', 'x=y'], ['--jq', '.other']])
        expect(classifyFinishedCiRead([...args, ...flags])).toBeNull();
    }
    expect(classifyFinishedCiRead(['api', 'repos/{owner}/{repo}/actions/runs/1/jobs'])).toBeNull();
    expect(classifyFinishedCiRead(['api', 'repos/o/r/commits/abc/check-runs'])).toBeNull();
    expect(classifyFinishedCiRead([...log, '--jq', '.jobs'])).toBeNull();
  });
  it('requires proof of a closed, untruncated collection', () => {
    for (const [args, field] of [[jobs, 'jobs'], [checks, 'check_runs']]) {
      const cls = classifyFinishedCiRead(args);
      for (const text of ['oops', '{}', '[]', JSON.stringify({ [field]: [] }), JSON.stringify({ [field]: [{ status: 'in_progress' }] })])
        expect(finishedCiStorable(cls, text)).toBe(false);
      const complete = JSON.stringify({ total_count: 1, [field]: [{ status: 'completed' }] });
      expect(finishedCiStorable(cls, complete)).toBe(false);
      expect(finishedCiStorable(cls, complete, { runCompleted: true })).toBe(field === 'jobs');
      expect(finishedCiStorable(cls, JSON.stringify({ total_count: 2, [field]: [{ status: 'completed' }] }), { runCompleted: true })).toBe(false);
      expect(finishedCiStorable(classifyFinishedCiRead([...args, '--jq', '.' + field]), '[{"status":"completed"}]', { runCompleted: true })).toBe(false);
    }
    expect(finishedCiStorable(classifyFinishedCiRead(log), 'completed')).toBe(false);
  });
  it.each([[jobs, 'jobs']])('shares closed collections across both runners: %j', (args, field) => {
    const f = fixture(JSON.stringify({ total_count: 1, [field]: [{ status: 'completed' }] }));
    const first = runGhSync(args, f.opts);
    expect(runGhSync(args, f.opts)).toBe(first);
    expect(runGhCliPassthrough(args, { throttle: f.throttle, spawn: f.spawn }).stdout).toEqual(Buffer.from(first));
    expect(f.reads()).toHaveLength(1);
    expect(f.rows().filter(r => r.outcome === 'ci_cache_hit')).toHaveLength(2);
    expect(f.rows().at(-1)).toMatchObject({ points: 0, kind: classifyFinishedCiRead(args).kind, op: args.join(' '), caller: 'ci-cache-test' });
  });
  it.each([[jobs, 'jobs']])('CLI stores closed reads: %j', (args, field) => {
    const f = fixture(JSON.stringify({ total_count: 1, [field]: [{ status: 'completed' }] }));
    const call = () => runGhCliPassthrough(args, { throttle: f.throttle, spawn: f.spawn });
    expect(call().stdout).toEqual(call().stdout); expect(f.reads()).toHaveLength(1);
  });
  it.each([false, true])('does not store in-progress reads (CLI=%s)', cli => {
    for (const [args, field] of [[jobs, 'jobs'], [checks, 'check_runs']]) {
      const f = fixture(JSON.stringify({ [field]: [{ status: 'completed' }, { status: 'in_progress' }] }));
      const call = () => cli ? runGhCliPassthrough(args, { throttle: f.throttle, spawn: f.spawn }) : runGhSync(args, f.opts);
      call(); call(); expect(f.reads()).toHaveLength(2); expect(f.files()).toHaveLength(0);
    }
  });
  it('revalidates by fetch age even when hits refresh LRU; zero never expires', () => {
    const f = fixture(); runGhSync(jobs, f.opts); f.advance(500000); runGhSync(jobs, f.opts);
    f.advance(100001); runGhSync(jobs, f.opts); expect(f.reads()).toHaveLength(2);
    f.env.WE_FINISHED_CI_CACHE_RUN_JOBS_REVALIDATE_MS = '0'; f.advance(999999999);
    runGhSync(jobs, f.opts); expect(f.reads()).toHaveLength(2);
  });
  it.each([false, true])('job logs require completed proof and never expire (CLI=%s)', cli => {
    const f = fixture('log bytes\n');
    const call = () => cli ? runGhCliPassthrough(log, { throttle: f.throttle, spawn: f.spawn }).stdout.toString() : runGhSync(log, f.opts);
    expect(call()).toBe('log bytes\n'); f.advance(999999999); expect(call()).toBe('log bytes\n');
    expect(f.spawn).toHaveBeenCalledTimes(2); expect(f.spawn.mock.calls[0][1]).toEqual(['api', 'repos/o/r/actions/jobs/456']);
  });
  it.each([false, true])('never serves another credential its cached CI data (CLI=%s)', cli => {
    for (const args of [log, jobs]) {
      const f = fixture(); const original = f.spawn.getMockImplementation();
      f.spawn.mockImplementation((bin, argv, opts) => argv[1] === args[1]
        ? { status: 0, stdout: Buffer.from(argv[1] === log[1] ? opts.env.GH_TOKEN
          : JSON.stringify({ total_count: 1, jobs: [{ status: 'completed', name: opts.env.GH_TOKEN }] })), stderr: Buffer.alloc(0) }
        : original(bin, argv, opts));
      const call = () => String(cli ? runGhCliPassthrough(args, { throttle: f.throttle, spawn: f.spawn }).stdout : runGhSync(args, f.opts));
      const first = call(); expect(call()).toBe(first);
      f.env.GH_TOKEN = 'ghs_other_installation';
      if (cli) vi.stubEnv('GH_TOKEN', f.env.GH_TOKEN);
      const second = call(); expect(second).toContain('ghs_other_installation');
      expect(second).not.toBe(first); expect(call()).toBe(second);
      expect(f.files()).toHaveLength(2);
      f.env.GH_TOKEN = 'ghs_ci_cache_fixture';
      if (cli) vi.stubEnv('GH_TOKEN', f.env.GH_TOKEN);
      expect(call()).toBe(first);
      expect(f.files().join(' ')).not.toContain('ghs_');
    }
  });
  it('scopes synchronous cache entries to the child environment, not throttle configuration', () => {
    const f = fixture('first identity'); runGhSync(log, f.opts);
    const opts = { ...f.opts, env: { ...f.env, GH_TOKEN: 'ghs_different_child' } };
    f.spawn.mockImplementation((_bin, args) => ({ status: 0,
      stdout: Buffer.from(args[1].endsWith('/456') ? '{"status":"completed"}' : 'second identity'), stderr: Buffer.alloc(0) }));
    expect(runGhSync(log, opts)).toBe('second identity');
  });
  it.each([false, true])('tracks inherited process credentials despite unchanged throttle env (CLI=%s)', cli => {
    const f = fixture();
    f.spawn.mockImplementation((_bin, args, opts) => ({ status: 0,
      stdout: Buffer.from(args[1].endsWith('/456') ? '{"status":"completed"}' : opts.env.GH_TOKEN), stderr: Buffer.alloc(0) }));
    const call = () => String(cli ? runGhCliPassthrough(log, { throttle: f.throttle, spawn: f.spawn }).stdout
      : runGhSync(log, { encoding: 'utf8', throttle: f.throttle }));
    expect(call()).toBe('ghs_ci_cache_fixture');
    vi.stubEnv('GH_TOKEN', 'ghs_inherited_other');
    expect(call()).toBe('ghs_inherited_other');
    expect(call()).toBe('ghs_inherited_other');
  });
  it.each([false, true])('keeps stored-login and dynamically routed auth live (CLI=%s)', cli => {
    for (const dynamic of [false, true]) {
      const f = fixture('fresh log');
      if (dynamic) { f.throttle.personalRoute = true; f.throttle.personalToken = 'personal_fixture'; }
      else for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
        delete f.env[key]; vi.stubEnv(key, undefined);
      }
      const call = () => cli ? runGhCliPassthrough(log, { throttle: f.throttle, spawn: f.spawn }).stdout : runGhSync(log, f.opts);
      call(); call(); expect(f.files()).toHaveLength(0);
    }
  });
  it('uses the applicable explicit token and its precedence as the auth scope', () => {
    const primary = finishedCiAuthScope({ GH_TOKEN: 'first' });
    expect(finishedCiAuthScope({ GITHUB_TOKEN: 'first' })).toBe(primary);
    expect(finishedCiAuthScope({ GH_TOKEN: 'first', GITHUB_TOKEN: 'second' })).toBe(primary);
    expect(finishedCiAuthScope({ GH_TOKEN: 'second' })).not.toBe(primary);
    expect(finishedCiAuthScope({ GH_ENTERPRISE_TOKEN: 'first' })).toBeNull();
    expect(finishedCiAuthScope({ GH_HOST: 'enterprise.example', GH_TOKEN: 'first' })).toBeNull();
    expect(finishedCiAuthScope({ GH_HOST: 'enterprise.example', GH_ENTERPRISE_TOKEN: 'first' })).toBe(primary);
    expect(finishedCiAuthScope({ GH_HOST: 'tenant.ghe.com', GH_TOKEN: 'first' })).toBe(primary);
  });
  it('rejects payloads whose credential scope does not match their filename', () => {
    const f = fixture(); const cls = classifyFinishedCiRead(log);
    storeFinishedCi(cls, Buffer.from('old identity'), f.cacheOpts());
    const path = join(f.env.WE_FINISHED_CI_CACHE_DIR, f.files()[0]);
    const entry = JSON.parse(gunzipSync(readFileSync(path)));
    entry.authScope = finishedCiAuthScope({ GH_TOKEN: 'other' });
    writeFileSync(path, gzipSync(JSON.stringify(entry)));
    expect(lookupFinishedCi(cls, f.cacheOpts())).toBeNull();
    expect(JSON.stringify(entry)).not.toContain('ghs_ci_cache_fixture');
  });
  it('bypasses a cwd-relative App shim that can select another credential', () => {
    const f = fixture();
    writeFileSync(join(f.dir, 'gh'), '# AUTO-GENERATED by we:scripts/lib/gh-app-shim.mjs\n');
    const opts = { ...f.opts, cwd: f.dir, throttle: { ...f.throttle, bin: './gh' } };
    runGhSync(log, opts); runGhSync(log, opts); expect(f.files()).toHaveLength(0);
  });
  it.each(['1', '0'])('preserves file URL cwd support with cache enabled=%s', enabled => {
    const f = fixture('log bytes'); f.env.WE_FINISHED_CI_CACHE = enabled;
    expect(runGhSync(log, { ...f.opts, cwd: pathToFileURL(f.dir + '/') })).toBe('log bytes');
  });
  it.each([false, true])('checks the executable PATH candidate and newly installed shims (CLI=%s)', cli => {
    const f = fixture('original log');
    const call = () => String(cli ? runGhCliPassthrough(log, { throttle: f.throttle, spawn: f.spawn }).stdout : runGhSync(log, f.opts));
    expect(call()).toBe('original log'); expect(f.files()).toHaveLength(1);
    // Replacing a previously plain executable must not reuse a cached negative shim probe.
    writeFileSync(join(f.env.PATH, 'gh'), '# AUTO-GENERATED by we:scripts/lib/gh-app-shim.mjs\n');
    f.spawn.mockImplementation((_bin, args) => ({ status: 0,
      stdout: Buffer.from(args[1].endsWith('/456') ? '{"status":"completed"}' : 'new identity log'), stderr: Buffer.alloc(0) }));
    expect(call()).toBe('new identity log');
    // execvp skips a non-executable namesake ahead of the real shim.
    const shadow = join(f.dir, 'shadow'); mkdirSync(shadow);
    writeFileSync(join(shadow, 'gh'), 'not executable', { mode: 0o600 });
    f.env.PATH = shadow + ':' + f.env.PATH; vi.stubEnv('PATH', f.env.PATH);
    expect(call()).toBe('new identity log');
  });
  it.each([false, true])('failed/incomplete proof preserves output without storage (CLI=%s)', cli => {
    for (const failure of ['in_progress', 'failure']) {
      const f = fixture('logs');
      f.spawn.mockImplementation((_bin, args) => ({ status: args[1].endsWith('/456') && failure === 'failure' ? 1 : 0,
        stdout: Buffer.from(args[1].endsWith('/456') ? JSON.stringify({ status: failure }) : 'logs'), stderr: Buffer.alloc(0) }));
      const call = () => cli ? runGhCliPassthrough(log, { throttle: f.throttle, spawn: f.spawn }).stdout.toString() : String(runGhSync(log, f.opts));
      expect(call()).toBe('logs'); expect(call()).toBe('logs'); expect(f.files()).toHaveLength(0);
    }
  });
  it.each([false, true])('does not freeze a partial log when completion follows its fetch (CLI=%s)', cli => {
    for (const initial of ['queued', 'in_progress']) {
      const f = fixture(); let status = initial;
      f.spawn.mockImplementation((_bin, args) => {
        const proof = args[1].endsWith('/456');
        const stdout = proof ? JSON.stringify({ status }) : status === 'completed' ? 'final log' : 'partial log';
        if (!proof) status = 'completed';
        return { status: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
      });
      const call = () => String(cli ? runGhCliPassthrough(log, { throttle: f.throttle, spawn: f.spawn }).stdout : runGhSync(log, f.opts));
      expect(call()).toBe('partial log');
      expect(f.files()).toHaveLength(0);
      expect(call()).toBe('final log');
      expect(call()).toBe('final log');
    }
  });
  it.each([false, true])('sees later jobs/checks after an all-completed prefix (CLI=%s)', cli => {
    for (const [args, field] of [[jobs, 'jobs'], [checks, 'check_runs']]) {
      const f = fixture(); let reads = 0;
      f.spawn.mockImplementation((_bin, argv) => {
        const proof = argv[1] === 'repos/o/r/actions/runs/123';
        if (!proof) reads++;
        const rows = reads > 1 ? [{ status: 'completed' }, { status: 'queued' }] : [{ status: 'completed' }];
        const text = proof ? '{"status":"in_progress"}' : JSON.stringify({ total_count: rows.length, [field]: rows });
        return { status: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0) };
      });
      const call = () => String(cli ? runGhCliPassthrough(args, { throttle: f.throttle, spawn: f.spawn }).stdout : runGhSync(args, f.opts));
      expect(JSON.parse(call())[field]).toHaveLength(1); expect(f.files()).toHaveLength(0);
      expect(JSON.parse(call())[field]).toHaveLength(2);
    }
  });
  it.each([
    ['run', 'rerun', '--failed', '123'],
    ['-R', 'o/r', 'run', 'rerun', '123'],
    ['--repo=o/r', 'run', 'rerun', '--job', '456', '123'],
    ['run', 'rerun', '-dj', '456', '123'],
    ['api', '--method=POST', 'repos/o/r/actions/runs/123/rerun'],
    ['api', 'repos/o/r/actions/runs/123/rerun-failed-jobs', '-XPOST'],
    ['api', '-iXPOST', 'repos/o/r/actions/runs/123/rerun'],
    ['api', '-iX', 'POST', 'repos/o/r/actions/runs/123/rerun'],
    ['api', '-if', 'enable_debug_logging=true', 'repos/o/r/actions/runs/123/rerun'],
    ['api', '--cache', '1h', '-XPOST', 'repos/o/r/actions/runs/123/rerun'],
    ['api', 'repos/o/r/actions/runs/123/rerun', '-F', 'enable_debug_logging=true'],
    ['api', '--field=enable_debug_logging=true', 'repos/o/r/actions/runs/123/rerun'],
    ['api', '-fenable_debug_logging=true', 'repos/o/r/actions/runs/123/rerun'],
    ['run', 'rerun'],
  ].map(args => ({ args })))('invalidates run jobs and check-runs for successful rerun $args', ({ args }) => {
    for (const cli of [false, true]) {
      const f = fixture();
      storeFinishedCi(classifyFinishedCiRead(jobs), Buffer.from('jobs'), f.cacheOpts());
      storeFinishedCi(classifyFinishedCiRead(checks), Buffer.from('checks'), f.cacheOpts());
      storeFinishedCi(classifyFinishedCiRead(log), Buffer.from('logs'), f.cacheOpts());
      if (cli) runGhCliPassthrough(args, { throttle: f.throttle, spawn: f.spawn }); else runGhSync(args, f.opts);
      expect(f.files()).toHaveLength(1);
      expect(f.files()[0]).toMatch(/^job-log-/);
    }
  });
  it.each([false, true])('does not let a reader repopulate run jobs after a rerun (CLI=%s)', cli => {
    const f = fixture(); const original = f.spawn.getMockImplementation(); let reran = false;
    f.spawn.mockImplementation((bin, args, opts) => {
      const result = original(bin, args, opts);
      if (args[1] === jobs[1] && !reran) {
        reran = true;
        invalidateForWrite(['run', 'rerun', '123'], f.cacheOpts());
      }
      return result;
    });
    if (cli) runGhCliPassthrough(jobs, { throttle: f.throttle, spawn: f.spawn }); else runGhSync(jobs, f.opts);
    expect(lookupFinishedCi(classifyFinishedCiRead(jobs), f.cacheOpts())).toBeNull();
    f.spawn.mockReturnValue({ status: 0, stdout: Buffer.from('{"total_count":1,"jobs":[{"status":"queued"}]}'), stderr: Buffer.alloc(0) });
    const next = cli ? runGhCliPassthrough(jobs, { throttle: f.throttle, spawn: f.spawn }).stdout : runGhSync(jobs, f.opts);
    expect(JSON.parse(String(next)).jobs[0].status).toBe('queued');
  });
  it('restricts existing directories, payloads, and eviction markers', () => {
    const f = fixture(); const dir = f.env.WE_FINISHED_CI_CACHE_DIR;
    mkdirSync(dir, { mode: 0o755 }); chmodSync(dir, 0o755);
    runGhSync(log, f.opts);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
  });
  it('ignores legacy entries that may contain a permanently partial log', () => {
    const f = fixture('fresh log'); const cls = classifyFinishedCiRead(log);
    storeFinishedCi(cls, Buffer.from('partial log'), f.cacheOpts());
    const path = join(f.env.WE_FINISHED_CI_CACHE_DIR, f.files()[0]);
    // Legacy entries lack the proof-order version, even if their key and gzip are valid.
    const entry = JSON.parse(gunzipSync(readFileSync(path)));
    delete entry.version;
    writeFileSync(path, gzipSync(JSON.stringify(entry)));
    expect(runGhSync(log, f.opts)).toBe('fresh log');
  });
  it.each([false, true])('successful rerun invalidates run entries (CLI=%s)', cli => {
    const f = fixture(); runGhSync(jobs, f.opts);
    const args = ['run', 'rerun', '123'];
    if (cli) runGhCliPassthrough(args, { throttle: f.throttle, spawn: f.spawn }); else runGhSync(args, f.opts);
    expect(f.files()).toHaveLength(0);
    runGhSync(jobs, f.opts); expect(f.reads()).toHaveLength(3);
    invalidateForWrite(['api', 'repos/o/r/actions/runs/123/rerun-failed-jobs', '-X', 'POST'], f.cacheOpts());
    expect(f.files()).toHaveLength(0);
  });
  it('evicts oldest files to below 80 percent when over budget', () => {
    const f = fixture(); const settings = { ...resolveFinishedCiCacheSettings(f.env), maxBytes: 1200 };
    for (let id = 1; id <= 3; id++) {
      storeFinishedCi(classifyFinishedCiRead(['api', `repos/o/r/actions/jobs/${id}/logs`]), randomBytes(700), { ...f.cacheOpts(), settings });
      f.advance(600001);
    }
    const size = f.files().reduce((n, name) => n + statSync(join(f.env.WE_FINISHED_CI_CACHE_DIR, name)).size, 0);
    expect(size).toBeLessThanOrEqual(960); expect(f.files().some(n => n.startsWith('job-log-1-'))).toBe(false);
  });
  it('resolves settings, expands dir and disables all IO under the off switch', () => {
    expect(resolveFinishedCiCacheSettings({})).toMatchObject({ enabled: true, maxBytes: 2 * 1024 ** 3, runJobsRevalidateMs: 600000, checkRunsRevalidateMs: 300000 });
    expect(resolveFinishedCiCacheSettings({ WE_UNDER_TEST: '1' }).enabled).toBe(false);
    const f = fixture(); f.env.WE_FINISHED_CI_CACHE = '0';
    runGhSync(jobs, f.opts); runGhSync(jobs, f.opts);
    runGhCliPassthrough(jobs, { throttle: f.throttle, spawn: f.spawn });
    expect(f.files()).toHaveLength(0); expect(f.spawn).toHaveBeenCalledTimes(3);
    const io = vi.fn(() => { throw new Error('must not access fs'); });
    const fs = new Proxy({}, { get: () => io });
    expect(lookupFinishedCi(classifyFinishedCiRead(jobs), { ...f.cacheOpts(), fs })).toBeNull();
    expect(() => storeFinishedCi(classifyFinishedCiRead(jobs), Buffer.from('x'), { ...f.cacheOpts(), fs })).not.toThrow();
    expect(io).not.toHaveBeenCalled();
    expect(finishedCiCacheDir({ HOME: '/test-home', WE_FINISHED_CI_CACHE_DIR: '~/cache' })).toBe('/test-home/cache');
  });
  it('preserves binary output, misses corrupt gzip, and refreshes LRU mtime', () => {
    const f = fixture(); const cls = classifyFinishedCiRead(log); const bytes = Buffer.from([0, 255, 128, 10]);
    storeFinishedCi(cls, bytes, f.cacheOpts()); f.advance(1000);
    expect(runGhSync(log, { env: f.env, throttle: f.throttle })).toEqual(bytes);
    const path = join(f.env.WE_FINISHED_CI_CACHE_DIR, f.files()[0]);
    expect(statSync(path).mtimeMs).toBeCloseTo(f.now(), 0);
    writeFileSync(path, 'bad gzip'); expect(lookupFinishedCi(cls, f.cacheOpts())).toBeNull();
  });
  it('check-runs stays live even with zero TTL because new workflows can appear', () => {
    const f = fixture('{"check_runs":[{"status":"completed"}]}');
    f.env.WE_FINISHED_CI_CACHE_CHECK_RUNS_REVALIDATE_MS = '100';
    runGhSync(checks, f.opts); f.advance(101); runGhSync(checks, f.opts);
    expect(f.spawn).toHaveBeenCalledTimes(2);
    f.env.WE_FINISHED_CI_CACHE_CHECK_RUNS_REVALIDATE_MS = '0'; f.advance(999999999);
    runGhSync(checks, f.opts); expect(f.spawn).toHaveBeenCalledTimes(3);
  });
  it('injected exec and input calls bypass finished cache', () => {
    const f = fixture(); runGhSync(jobs, f.opts);
    const exec = vi.fn(() => 'injected');
    expect(runGhSync(jobs, { ...f.opts, throttle: { ...f.throttle, exec } })).toBe('injected');
    runGhSync(jobs, { ...f.opts, input: 'body' }); expect(f.reads()).toHaveLength(2);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('failed rerun and job rerun preserve run entries', () => {
    const f = fixture(); runGhSync(jobs, f.opts);
    f.spawn.mockReturnValueOnce({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    runGhCliPassthrough(['run', 'rerun', '123'], { throttle: f.throttle, spawn: f.spawn });
    expect(f.files()).toHaveLength(1);
    invalidateForWrite(['api', 'repos/o/r/actions/jobs/456/rerun', '--method', 'POST'], f.cacheOpts());
    expect(f.files()).toHaveLength(1);
  });
  it('corrupt/unreadable cache and injected fs failures are misses', () => {
    const f = fixture(); const fs = { readFileSync: () => { throw new Error('IO'); }, mkdirSync: () => { throw new Error('IO'); } };
    expect(lookupFinishedCi(classifyFinishedCiRead(jobs), { ...f.cacheOpts(), fs })).toBeNull();
    expect(() => storeFinishedCi(classifyFinishedCiRead(jobs), Buffer.from('x'), { ...f.cacheOpts(), fs })).not.toThrow();
  });
});

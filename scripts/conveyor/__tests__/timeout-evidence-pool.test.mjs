import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { URL as NodeURL } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';
import { probeTimeoutEvidenceThrottle, runTimeoutEvidencePool } from '../timeout-evidence-pool.mjs';
import { enrichPrsWithTimeoutEvidence, readTimeoutEvidence } from '../reconcile-pass.mjs';

const repo = 'fixture/repo';
const pr = { number: 7100, headRefOid: 'a'.repeat(40), statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE',
  detailsUrl: `https://github.com/${repo}/actions/runs/410`, id: 'check-411', completedAt: '2026-01-01' }] };
const options = { repo, enabled: true, readBudget: () => ({ confirmed: 0 }), log: () => {} };
function scratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'timeout-production-test-'));
  try { return fn(dir); } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
}

function realFixture(dir) {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const linger = keepAliveScript({ maxLifetimeMs: 30_000 });
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
if (process.env.GH_CALL_RECORD) fs.appendFileSync(process.env.GH_CALL_RECORD, 'call\\n');
if (process.env.HANG_WORKER) {
  const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(linger)}], { stdio: 'ignore' });
  fs.writeFileSync(process.env.HANG_WORKER, JSON.stringify([process.pid, child.pid]));
  ${linger}
} else {
  const path = process.argv[3];
  let value;
  if (/\\/pulls\\/\\d+$/.test(path)) value = ${JSON.stringify({ head: { sha: pr.headRefOid }, base: { sha: 'b'.repeat(40) }, state: 'open', changed_files: 0 })};
  else if (path.includes('/files?')) value = [];
  else if (path.includes('/check-runs?')) value = { total_count: 0, check_runs: [] };
  else if (path.endsWith('/status')) value = { total_count: 0 };
  else throw Error('unexpected path: ' + path);
  process.stdout.write(JSON.stringify(value));
}
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, WE_FIX_FACTS: '0',
    WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'throttle'), WE_GH_THROTTLE_COST_HEADERS: '0' };
  for (const [key, value] of Object.entries(env)) if (process.env[key] !== value) vi.stubEnv(key, value);
  return env;
}

it('removes the pool temp directory before propagating a worker cleanup error', () => {
  let folder, now = 0;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    expect(() => runTimeoutEvidencePool([pr], {
      repo, probe: () => true, now: () => now, deadlineMs: 1, pause: () => { now = 2; },
      launch: (_file, args) => { folder = join(args.at(-1), '..'); return { pid: 2000000000, on() {} }; },
      groupAlive: () => { throw Error('liveness probe failed'); },
    })).toThrow(expect.objectContaining({ code: 'TIMEOUT_EVIDENCE_CLEANUP_FAILED' }));
    expect(folder).toBeDefined();
    expect(existsSync(folder)).toBe(false);
  } finally { kill.mockRestore(); }
});

it.each([false, true])('logs failed temp removal without replacing the result or group cleanup error (group error: %s)', groupError => {
  let folder, now = 0;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const remove = vi.fn(path => { folder = path; throw Error('fixture rm failure'); });
  try {
    const run = () => runTimeoutEvidencePool([pr], {
      repo, probe: () => true, remove, now: () => now, deadlineMs: 1, pause: () => { now = 2; },
      launch: () => ({ pid: 2000000000, on() {} }),
      groupAlive: () => { if (groupError) throw Error('liveness probe failed'); return false; },
    });
    if (groupError) expect(run).toThrow(expect.objectContaining({ code: 'TIMEOUT_EVIDENCE_CLEANUP_FAILED' }));
    else expect(run()[0]).toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('timeout-evidence: temp dir cleanup failed: fixture rm failure');
  } finally {
    kill.mockRestore(); log.mockRestore();
    if (folder) rmSync(folder, { recursive: true, force: true });
  }
});

it.each(['throws', 'unusable'])('planner throttle probe %s selects serial before launching any worker', mode => scratch(dir => {
  const env = realFixture(dir), launch = vi.fn(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const badRoot = join(dir, 'not-a-directory');
  writeFileSync(badRoot, 'fixture');
  const probe = mode === 'throws' ? probeTimeoutEvidenceThrottle : () => false;
  try {
    const poolRunner = (rows, opts) => runTimeoutEvidencePool(rows, { ...opts, launch, probe,
      env: { ...env, WE_GH_THROTTLE_LOCK_ROOT: badRoot } });
    const expected = readTimeoutEvidence(pr, { repo });
    expect(enrichPrsWithTimeoutEvidence([pr, pr], { ...options, concurrency: 2, poolRunner })
      .map(row => row.timeoutRetry)).toEqual([expected, expected]);
    expect(launch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('timeout-evidence: throttle probe failed, serial');
  } finally { log.mockRestore(); }
}));

it('probe round trip releases its real slot', () => scratch(dir => {
  const env = realFixture(dir);
  expect(probeTimeoutEvidenceThrottle(env)).toBe(true);
  expect(probeTimeoutEvidenceThrottle({ ...env, WE_GH_THROTTLE_CAP: '1' })).toBe(true);
}));

it.each(['result', 'stderr'])('degraded %s stops launches and kills active groups before returning serial slots', source => {
  const groups = new Set(); let launched = 0;
  const kill = vi.spyOn(process, 'kill').mockImplementation(pid => { groups.delete(-pid); return true; });
  try {
    const results = runTimeoutEvidencePool(Array(6).fill(pr), {
      concurrency: 2, probe: () => true, groupAlive: pid => groups.has(pid),
      launch: (_file, args, opts) => {
        const pid = 2000000000 + launched++; groups.add(pid);
        if (launched === 2) {
          if (source === 'result') writeFileSync(args.at(-1), JSON.stringify({ workerError: true, reason: 'throttle-degraded' }));
          else writeFileSync(opts.stdio[2], 'gh-throttle: lock-root setup failed (fail-open)');
        }
        return { pid, on() {} };
      },
    });
    expect(launched).toBe(2);
    expect(groups.size).toBe(0);
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual([-2000000000, -2000000001]);
    expect(Array.from(results)).toEqual(Array(6).fill(undefined));
  } finally { kill.mockRestore(); }
});

it.each(['1', '2', '6'])('caps configured concurrency eight at live throttle cap %s', cap => scratch(dir => {
  const env = { ...realFixture(dir), WE_GH_THROTTLE_CAP: cap };
  let peak = 0, launched = 0, clock = 0;
  const groups = new Set(), kill = vi.spyOn(process, 'kill').mockImplementation(pid => { groups.delete(-pid); return true; });
  try {
    runTimeoutEvidencePool(Array(9).fill(pr), { concurrency: 8, env, probe: () => true,
      now: () => clock, deadlineMs: 1, pause: () => { clock = 2; }, groupAlive: pid => groups.has(pid),
      launch: () => { const pid = 2000000000 + launched++; groups.add(pid); peak = Math.max(peak, groups.size); return { pid, on() {} }; },
    });
    expect(peak).toBe(Number(cap) === 1 ? 0 : Number(cap));
    expect(groups.size).toBe(0);
  } finally { kill.mockRestore(); }
}));

describe('production worker with local gh stub', () => {
  it('exits inside a post-probe fail-open warning before invoking gh (with mutation control)', () => scratch(dir => {
    const env = realFixture(dir), preload = join(dir, 'fail-after-probe.cjs');
    const reached = join(dir, 'collector-reached'), calls = join(dir, 'worker-gh-calls');
    writeFileSync(preload, `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const mkdir = fs.mkdirSync;
fs.mkdirSync = function (path, ...args) {
  // Leave the real acquire/release probe intact; fail only the collector's gate.
  if (String(path) === process.env.WE_GH_THROTTLE_LOCK_ROOT && new Error().stack.includes('runGhSync')) {
    fs.writeFileSync(${JSON.stringify(reached)}, 'collector reached after successful probe');
    throw Error('fixture post-probe lock-root failure');
  }
  return mkdir.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
    let workerSource;
    const launch = vi.fn((_file, args) => { workerSource = args[4]; return { on() {} }; });
    runTimeoutEvidencePool([pr], { repo, env, launch });
    expect(launch).toHaveBeenCalledOnce();
    const input = join(dir, 'input.json'), output = join(dir, 'result.json');
    writeFileSync(input, JSON.stringify({ pr, repo }));
    // Run the shipped worker to completion without planner cancellation masking a bypass.
    const runWorker = source => spawnSync(process.execPath, ['--require', preload, '--input-type=module', '-e', source, input, output], {
      env: { ...env, GH_CALL_RECORD: calls }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    const child = runWorker(workerSource);
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('fixture post-probe lock-root failure');
    expect(child.stderr).toContain('(fail-open)');
    expect(existsSync(reached)).toBe(true);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ workerError: true, reason: 'throttle-degraded' });
    expect(existsSync(calls)).toBe(false);

    // Prove the zero-call assertion detects removing this exact interception branch.
    const mutant = workerSource.replace('reportFailure(); // Stop inside the warning', '// Stop inside the warning');
    expect(mutant).not.toBe(workerSource);
    rmSync(reached);
    const mutation = runWorker(mutant);
    expect(mutation.error).toBeUndefined();
    expect(mutation.signal).toBeNull();
    expect(mutation.stderr).toContain('(fail-open)');
    expect(existsSync(reached)).toBe(true);
    expect(readFileSync(calls, 'utf8')).toContain('call');
  }), 30_000);

  it('falls back serially for degraded throttle workers and all remaining PRs without launching more workers', () => scratch(dir => {
    const env = realFixture(dir), unusableRoot = join(dir, 'not-a-directory');
    writeFileSync(unusableRoot, 'fixture');
    const expected = readTimeoutEvidence(pr, { repo });
    const prs = Array.from({ length: 5 }, (_, i) => ({ ...pr, number: pr.number + i }));
    const launch = vi.fn((file, args, opts) => spawn(file, args, opts));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let pooled, workerRows, forwardedBeforeCleanup;
    try {
      const poolRunner = (rows, opts) => {
        pooled = runTimeoutEvidencePool(rows, { ...opts, launch, deadlineMs: 20_000,
          env,
          launch: (file, args, opts) => launch(file, args, { ...opts, env: { ...opts.env,
            WE_GH_THROTTLE_LOCK_ROOT: unusableRoot, GH_CALL_RECORD: join(dir, 'worker-gh-calls') } }),
          remove: (folder, options) => {
            workerRows = [0, 1].filter(index => existsSync(join(folder, `${index}.result.json`)))
              .map(index => JSON.parse(readFileSync(join(folder, `${index}.result.json`), 'utf8')));
            forwardedBeforeCleanup = log.mock.calls.filter(([prefix]) => prefix === 'timeout-evidence worker stderr:').length;
            rmSync(folder, options);
          },
        });
        return pooled;
      };
      const results = enrichPrsWithTimeoutEvidence(prs, { ...options, concurrency: 2, poolRunner });
      expect(launch).toHaveBeenCalledTimes(2);
      expect(workerRows.length).toBeGreaterThan(0);
      expect(workerRows.every(row => row.workerError && row.reason === 'throttle-degraded')).toBe(true);
      expect(existsSync(join(dir, 'worker-gh-calls'))).toBe(false);
      // Degraded workers' stderr (the throttle warning) is forwarded to the planner log before cleanup, never hidden.
      expect(forwardedBeforeCleanup).toBe(workerRows.length);
      expect(Array.from(pooled)).toEqual(Array(5).fill(undefined));
      expect(results.map(row => row.timeoutRetry)).toEqual(prs.map(() => expected));
      const calls = readFileSync(join(dir, 'throttle', 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      // One baseline read plus one serial fallback per PR, through the parent's healthy throttle.
      expect(calls.filter(c => c.outcome === 'call')).toHaveLength(4 * 6);
    } finally { log.mockRestore(); }
  }), 30_000);

  it('forwards only the last 4 KB of non-empty worker stderr before cleanup', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tail = 'x'.repeat(4092) + 'tail';
    let folder;
    try {
      runTimeoutEvidencePool([pr, pr], {
        probe: () => true,
        launch: (_file, args, opts) => {
          folder = join(args.at(-1), '..');
          if (args.at(-1).endsWith('0.result.json')) writeFileSync(opts.stdio[2], 'omitted' + tail);
          return { on() {} };
        },
        remove: (path, options) => {
          expect(existsSync(path)).toBe(true);
          expect(log.mock.calls).toEqual([['timeout-evidence worker stderr:', tail]]);
          rmSync(path, options);
        },
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('timeout-evidence worker stderr:', tail);
      expect(existsSync(folder)).toBe(false);
    } finally { log.mockRestore(); if (folder) rmSync(folder, { recursive: true, force: true }); }
  });

  it.each(['SIGKILL', 'SIGTERM', 'SIGSTOP'])('supervises worker groups and removes their directory after planner %s (SIGSTOP exercises hard lifetime)', async signal => {
    const dir = mkdtempSync(join(tmpdir(), 'timeout-orphan-test-'));
    let planner, groups = [], folder;
    try {
      const env = realFixture(dir), metadata = join(dir, 'pool.json');
      const script = `
        import { readFileSync, writeFileSync, renameSync } from 'node:fs';
        import { spawn } from 'node:child_process';
        import { dirname } from 'node:path';
        import { probeTimeoutEvidenceThrottle, runTimeoutEvidencePool } from ${JSON.stringify(new NodeURL('../timeout-evidence-pool.mjs', import.meta.url).href)};
        const groups = [];
        let startupError;
        runTimeoutEvidencePool(${JSON.stringify([pr, pr])}, {
          repo: ${JSON.stringify(repo)}, concurrency: 2, deadlineMs: ${signal === 'SIGSTOP' ? 5000 : 20_000},
          launch: (file, args, opts) => {
            const child = spawn(file, args, { ...opts, env: { ...opts.env, HANG_WORKER: args.at(-1) + '.pids' } });
            groups.push(child.pid);
            if (groups.length === 2) {
              const folder = dirname(args.at(-1)), until = Date.now() + 3000;
              while (true) {
                try {
                  for (const index of [0, 1]) {
                    const pids = JSON.parse(readFileSync(folder + '/' + index + '.result.json.pids', 'utf8'));
                    if (pids.length !== 2 || !pids.every(pid => Number.isInteger(pid) && pid > 0)) throw Error('invalid worker pids');
                    for (const pid of pids) process.kill(pid, 0);
                  }
                  break;
                } catch (error) {
                  if (Date.now() >= until) {
                    startupError = Error('pool did not start within 3000ms', { cause: error });
                    throw startupError;
                  }
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
                }
              }
              writeFileSync(${JSON.stringify(metadata + '.tmp')}, JSON.stringify({ groups, folder }));
              renameSync(${JSON.stringify(metadata + '.tmp')}, ${JSON.stringify(metadata)});
            }
            return child;
          },
        });
        if (startupError) throw startupError; // The pool treats launch failures as serial-fallback slots.
        if (groups.length !== 2) throw Error('pool did not launch both workers');
      `;
      let stderr = '', exit;
      planner = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      planner.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16 * 1024); });
      planner.on('exit', (code, signal) => { exit = { code, signal }; });
      planner.on('error', error => { exit = { error: error.message }; });
      await vi.waitFor(() => {
        if (exit) throw Error('planner exited before pool readiness: ' + JSON.stringify(exit) + '\n' + stderr);
        expect(existsSync(metadata), 'waiting for atomic pool readiness; planner stderr: ' + stderr).toBe(true);
        ({ groups, folder } = JSON.parse(readFileSync(metadata, 'utf8')));
        expect(groups).toHaveLength(2);
        for (const index of [0, 1]) expect(JSON.parse(readFileSync(join(folder, index + '.result.json.pids'), 'utf8'))).toHaveLength(2);
      }, { timeout: 8000, interval: 25 });
      const descendants = [0, 1].flatMap(index => JSON.parse(readFileSync(join(folder, index + '.result.json.pids'), 'utf8')));
      planner.kill(signal);
      // Reap the planner so the watchdog's kill(0) also observes its death.
      if (signal !== 'SIGSTOP') await vi.waitFor(() => expect(exit).toBeDefined(), { timeout: 5000 });
      await vi.waitFor(() => {
        const live = execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 })
          .trim().split('\n').filter(line => {
            const [pid, pgid, state] = line.trim().split(/\s+/);
            return (groups.includes(Number(pgid)) || descendants.includes(Number(pid))) && !state.startsWith('Z');
          });
        expect(live).toEqual([]);
        if (signal !== 'SIGSTOP') expect(existsSync(folder)).toBe(false);
      }, { timeout: 15_000, interval: 50 });
      if (signal === 'SIGSTOP') {
        planner.kill('SIGCONT');
        await vi.waitFor(() => expect(exit).toEqual({ code: 0, signal: null }), { timeout: 5000 });
        expect(existsSync(folder)).toBe(false);
      }
    } finally {
      planner?.kill('SIGKILL');
      for (const group of groups) { try { process.kill(-group, 'SIGKILL'); } catch {} }
      if (folder) rmSync(folder, { recursive: true, force: true });
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
  it('matches the in-process throttled verdict and bounds actual unfinished children', () => scratch(dir => {
    const env = realFixture(dir), expected = readTimeoutEvidence(pr, { repo });
    expect(expected).toEqual({ eligible: false, reason: 'timeout-evidence:no-primary-failed-checks' });
    const outputs = []; let peak = 0;
    const launch = (file, args, opts) => {
      outputs.push(args.at(-1));
      peak = Math.max(peak, outputs.filter(p => !existsSync(p) && !existsSync(p + '.done')).length);
      return spawn(file, args, opts);
    };
    const results = runTimeoutEvidencePool([pr, pr, pr], { repo, env, launch, concurrency: 2, deadlineMs: 20_000 });
    expect(results).toEqual([expected, expected, expected]); expect(peak).toBe(2);
    const calls = readFileSync(join(dir, 'throttle', 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls.filter(c => c.outcome === 'call').length).toBe(4 * 4);
  }), 30_000);
  it('refuses serial fallback when worker group cleanup cannot be verified', () => scratch(dir => {
    realFixture(dir);
    const poolRunner = () => { throw Object.assign(Error('operator cleanup required'), { code: 'TIMEOUT_EVIDENCE_CLEANUP_FAILED' }); };
    expect(() => enrichPrsWithTimeoutEvidence([pr], { ...options, concurrency: 2, poolRunner }))
      .toThrow('operator cleanup required');
    expect(existsSync(join(dir, 'throttle', 'calls.jsonl'))).toBe(false);
  }));
  it('falls back promptly when the production worker crashes before output', () => scratch(dir => {
    const env = realFixture(dir), preload = join(dir, 'crash.cjs');
    writeFileSync(preload, 'process.exit(23);');
    let pooled, elapsed;
    const poolRunner = (prs, opts) => {
      const start = Date.now();
      pooled = runTimeoutEvidencePool(prs, { ...opts, env: { ...env, NODE_OPTIONS: '--require=' + preload }, deadlineMs: 20_000 });
      elapsed = Date.now() - start; return pooled;
    };
    const expected = readTimeoutEvidence(pr, { repo });
    expect(enrichPrsWithTimeoutEvidence([pr], { ...options, concurrency: 2, poolRunner })[0].timeoutRetry).toEqual(expected);
    expect(pooled[0]).toBeUndefined(); expect(elapsed).toBeLessThan(3000);
  }), 30_000);
  it('kills a hung production worker and its gh descendant group before serial fallback', () => scratch(dir => {
    const env = realFixture(dir), pids = join(dir, 'hung-pids.json');
    let group;
    const poolRunner = (prs, opts) => runTimeoutEvidencePool(prs, { ...opts,
      env: { ...env, HANG_WORKER: pids }, deadlineMs: 4000,
      launch: (file, args, childOpts) => { const child = spawn(file, args, childOpts); group = child.pid; return child; },
    });
    const expected = readTimeoutEvidence(pr, { repo });
    expect(enrichPrsWithTimeoutEvidence([pr], { ...options, concurrency: 2, poolRunner })[0].timeoutRetry).toEqual(expected);
    expect(JSON.parse(readFileSync(pids, 'utf8'))).toHaveLength(2);
    const descendants = JSON.parse(readFileSync(pids, 'utf8'));
    const deadline = Date.now() + 2000;
    let live;
    do {
      live = execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 })
        .trim().split('\n').filter(line => {
          const [pid, pgid, state] = line.trim().split(/\s+/);
          return (Number(pgid) === group || descendants.includes(Number(pid))) && !state.startsWith('Z');
        });
      if (!live.length) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    } while (Date.now() < deadline);
    expect(live).toEqual([]);
  }), 30_000);
});


describe('worker throttle caller identity', () => {
  it('gives every worker the planner caller so the per-caller throttle allowance is shared', () => {
    const seen = [];
    const launch = vi.fn((file, args, opts) => { seen.push(opts.env.GH_CALLER); return {}; });
    runTimeoutEvidencePool([{ number: 1 }, { number: 2 }], { launch, concurrency: 2, deadlineMs: 200, env: { GH_CALLER: 'planner-under-test' } });
    expect(seen).toEqual(['planner-under-test', 'planner-under-test']);
    seen.length = 0;
    runTimeoutEvidencePool([{ number: 1 }], { launch, concurrency: 2, deadlineMs: 200, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GH_CALLER')) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/\.input\.json$/);
    expect(seen[0]).not.toBe('unknown');
  });
});

describe('real collector API fixture parity', () => {
  const fixture = JSON.parse(readFileSync('scripts/conveyor/__tests__/fixtures/timeout-evidence-api.json', 'utf8'));
  it.each(fixture.cases)('$case: real collector serial and injected worker path deep-equal', row => scratch(dir => {
    const api = { ...fixture.api, ...row.overrides };
    const readLive = path => {
      if (!Object.hasOwn(api, path)) throw Error('unexpected fixture path: ' + path);
      return structuredClone(api[path]);
    };
    const exec = vi.fn((cmd, args) => {
      expect(cmd).toBe('gh'); expect(args[0]).toBe('api');
      const value = readLive(args[1]);
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
    const collect = p => readTimeoutEvidence(p, { repo, exec });
    const expected = collect(pr);
    expect(expected).toMatchObject(row.expected);
    const read = vi.fn(collect);
    const run = () => enrichPrsWithTimeoutEvidence([pr], { ...options, concurrency: 1, read });
    const serial = run();
    expect(serial[0].timeoutRetry).toEqual(expected.infraCancelled ? { ...expected, cap: 6 } : expected);
    expect(run()).toEqual(serial);
    expect(read).toHaveBeenCalledTimes(2);
    const poolRunner = vi.fn(prs => prs.map(collect));
    expect(enrichPrsWithTimeoutEvidence([pr], { ...options, concurrency: 2, poolRunner })).toEqual(serial);
    expect(poolRunner).toHaveBeenCalledTimes(1);
    expect(poolRunner.mock.results[0].value).toEqual([expected]);
  }), 30_000);
});

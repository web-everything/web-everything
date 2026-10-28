/** @file Acceptance contract for resumable detached operations and runner liveness. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keepAliveScript } from '../test-keepalive.mjs';
import {
  resolveDetachedOpsDir, parseDetachFlags, startDetachedOp, waitForOp, handleDetachCli,
  readProcess, probeRunner, collectOwnedProcesses, sweepOwnedProcesses, reapRecord, cancelOp,
} from '../detached-op.mjs';

// Resolve Node child paths without Vite's browser-asset URL transform.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

describe('resolveDetachedOpsDir', () => {
  it('uses the explicit DETACHED_OPS_DIR override', () => {
    expect(resolveDetachedOpsDir({ DETACHED_OPS_DIR: 'custom-operations' })).toBe('custom-operations');
  });

  it('defaults to the coordination detached-ops directory under the home directory', () => {
    expect(resolveDetachedOpsDir({})).toBe(join(homedir(), 'workspace', '.operations', 'coordination', 'detached-ops'));
  });
});

describe('parseDetachFlags', () => {
  it('defaults to foreground operation and a nine-minute wait budget', () => {
    expect(parseDetachFlags([])).toEqual({ detach: false, waitFor: null, maxWaitMs: 540000, rest: [] });
  });

  it('extracts detached-operation flags and preserves remaining argv in order', () => {
    const argv = ['node', 'task.mjs', '--task=a=b', '--wait-for=job-1', '--max-wait-ms=1000', 'input'];
    const original = [...argv];
    expect(parseDetachFlags(argv)).toEqual({
      detach: false, waitFor: 'job-1', maxWaitMs: 1000,
      rest: ['node', 'task.mjs', '--task=a=b', 'input'],
    });
    expect(argv).toEqual(original);
  });

  it('T10: parses cancellation only before the command separator and rejects mixed verbs', () => {
    expect(parseDetachFlags(['--cancel', 'job-1', '--max-wait-ms=250'])).toMatchObject({ cancel: 'job-1', rest: [] });
    expect(parseDetachFlags(['--cancel=job-1'])).toMatchObject({ cancel: 'job-1' });
    expect(parseDetachFlags(['--detach', '--', '--cancel=inner', '--wait-for=inner'])).toMatchObject({
      detach: true, waitFor: null, rest: ['--', '--cancel=inner', '--wait-for=inner'],
    });
    expect(() => parseDetachFlags(['--detach', '--wait-for=job-1'])).toThrow('mutually exclusive');
    expect(() => parseDetachFlags(['--detach', '--cancel=job-1'])).toThrow('mutually exclusive');
    expect(() => parseDetachFlags(['--wait-for=job-1', '--cancel=job-1'])).toThrow('mutually exclusive');
  });

  it.each([[0, 250], [-1, 250], [249, 250], [250, 250], [1000, 1000], [540000, 540000], [540001, 540000], [999999999, 540000]])(
    'clamps max-wait-ms=%s to %s', (value, expected) => {
      expect(parseDetachFlags([`--max-wait-ms=${value}`]).maxWaitMs).toBe(expected);
    },
  );

  it.each(['nope', 'NaN', '250ms'])('rejects non-numeric max-wait-ms=%s with RangeError', value => {
    expect(() => parseDetachFlags([`--max-wait-ms=${value}`])).toThrow(RangeError);
  });
});

describe('detached operation lifecycle', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'detached-op-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function writeRecord(overrides = {}) {
    const record = {
      id: 'resume-job', kind: 'acceptance', status: 'running', pid: 12345,
      startedAt: '2026-01-01T00:00:00.000Z', exitCode: null,
      stdoutPath: join(dir, 'resume-job.stdout.log'),
      stderrPath: join(dir, 'resume-job.stderr.log'),
      recordPath: join(dir, 'resume-job.json'),
      ...overrides,
    };
    writeFileSync(record.stdoutPath, 'stdout from the operation\n');
    writeFileSync(record.stderrPath, 'stderr from the operation\n');
    writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record));
    return record;
  }

  function fakeClock() {
    let elapsed = 0;
    const now = () => elapsed;
    const sleep = vi.fn(async ms => {
      // Reject an unbounded or over-budget sleep instead of hanging this acceptance test.
      expect(ms).toBeGreaterThan(0);
      expect(elapsed + ms).toBeLessThanOrEqual(250);
      elapsed += ms;
    });
    return { now, sleep };
  }

  it('writes and returns the same running record, with a detached unrefed runner and file stdio', async () => {
    const unref = vi.fn();
    const spawnFn = vi.fn((command, args, options) => {
      expect(typeof command).toBe('string');
      expect(Array.isArray(args)).toBe(true);
      expect(options.detached).toBe(true);
      if (args[1].startsWith('--run-record=')) {
        expect(options.stdio[0]).toBe('ignore');
        expect(fstatSync(options.stdio[1]).isFile()).toBe(true);
        expect(fstatSync(options.stdio[2]).isFile()).toBe(true);
      } else {
        expect(args[1]).toContain('--reap-record=');
        expect(options.stdio).toBe('ignore');
        expect(options.env).not.toHaveProperty('WE_DETACHED_OP');
      }
      return { pid: 43210, unref };
    });
    const record = await startDetachedOp({
      argv: [process.execPath, '-e', 'process.exit(0)'], kind: 'acceptance', dir,
      env: {}, spawnFn, now: () => 1767225600000, random: () => 0.125,
    });
    expect(record.id).toEqual(expect.any(String));
    expect(record.id.length).toBeGreaterThan(0);
    expect(record).toMatchObject({
      kind: 'acceptance', status: 'running', pid: 43210, exitCode: null,
      startedAt: expect.anything(), stdoutPath: expect.any(String), stderrPath: expect.any(String),
    });
    expect(record.stdoutPath).not.toBe(record.stderrPath);
    expect(readFileSync(record.stdoutPath, 'utf8')).toBe('');
    expect(readFileSync(record.stderrPath, 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8'))).toEqual(record);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(unref).toHaveBeenCalledTimes(2);
  });

  it.each([['done', 0, 0], ['failed', 23, 1]])(
    'returns %s and preserves operation exit code %s', async (status, exitCode, code) => {
      const record = writeRecord({ status, exitCode });
      const clock = fakeClock();
      const isAlive = vi.fn(() => true);
      expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock, isAlive })).toMatchObject({
        id: record.id, status, code, exitCode,
        stdoutTail: 'stdout from the operation\n', stderrTail: 'stderr from the operation\n',
      });
      expect(clock.sleep).not.toHaveBeenCalled();
    },
  );

  it('drops inherited admission ownership without mutating the caller environment', async () => {
    const env = { WE_HEAVY_ADMISSION_HELD: '1', DETACHED_OPS_DIR: dir, KEEP_ME: 'preserved' };
    const spawnFn = vi.fn(() => ({ pid: 43210, unref: vi.fn() }));
    const record = await startDetachedOp({ argv: [process.execPath, '-e', ''], kind: 'acceptance', dir, env, spawnFn });
    expect(spawnFn.mock.calls[0][2].env).toEqual({ DETACHED_OPS_DIR: dir, KEEP_ME: 'preserved', WE_DETACHED_OP: record.id });
    expect(spawnFn.mock.calls[1][2].env).toEqual({ DETACHED_OPS_DIR: dir, KEEP_ME: 'preserved' });
    expect(env.WE_HEAVY_ADMISSION_HELD).toBe('1');
  });

  it('returns code 75 at the foreground deadline while leaving a live job running', async () => {
    const record = writeRecord();
    const clock = fakeClock();
    const isAlive = vi.fn(() => true);
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock, isAlive })).toMatchObject({
      id: record.id, status: 'running', code: 75, exitCode: null,
      stdoutTail: 'stdout from the operation\n', stderrTail: 'stderr from the operation\n',
    });
    expect(clock.now()).toBe(250);
    expect(clock.sleep).toHaveBeenCalled();
    expect(isAlive).toHaveBeenCalledWith(record.pid, expect.objectContaining({ id: record.id }), expect.objectContaining({ deadline: expect.any(Number) }));
    expect(JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8'))).toEqual(record);
  });

  it('T3: an asynchronous unknown probe is never presented as confirmed alive', async () => {
    const record = writeRecord();
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...fakeClock(),
      isAlive: async () => null })).toMatchObject({ code: 75, liveness: 'unknown' });
  });

  it('T4: a stalled asynchronous probe consumes only the foreground wait budget', async () => {
    const record = writeRecord();
    const started = performance.now();
    let probeSignal;
    const result = await waitForOp({ id: record.id, maxWaitMs: 250, dir,
      isAlive: (_pid, _record, { signal }) => { probeSignal = signal; return new Promise(() => {}); } });
    expect(result).toMatchObject({ code: 75, liveness: 'unknown' });
    expect(probeSignal.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each([['done', 0, 0], ['failed', 23, 1]])(
    're-reads a runner that completed as %s between the record read and liveness check', async (status, exitCode, code) => {
      const record = writeRecord();
      const clock = fakeClock();
      const isAlive = vi.fn(() => {
        writeRecord({ status, exitCode });
        return false;
      });
      expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock, isAlive }))
        .toMatchObject({ id: record.id, status, exitCode, code,
          stdoutTail: 'stdout from the operation\n', stderrTail: 'stderr from the operation\n' });
      expect(isAlive).toHaveBeenCalledOnce();
      expect(clock.sleep).not.toHaveBeenCalled();
    },
  );

  it('fails closed with runner-died when a running record has a dead runner', async () => {
    const record = writeRecord();
    const clock = fakeClock();
    const isAlive = vi.fn(() => false);
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock, isAlive }))
      .toMatchObject({ id: record.id, status: 'failed', code: 1, reason: 'runner-died' });
    expect(isAlive).toHaveBeenCalledWith(record.pid, expect.objectContaining({ id: record.id }), expect.objectContaining({ deadline: expect.any(Number) }));
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['zombie', false, 1], ['gone', false, 1], ['match', true, 75], ['unreadable', null, 75],
  ])('T2: asynchronous identity classifies %s', async (_reason, alive, code) => {
    const stamp = { pid: 12345, platform: 'linux', start: '123', bootId: 'boot', scope: join(dir, 'resume-job.json') };
    const record = writeRecord({ runnerIdentity: stamp });
    const read = vi.fn(async () => ({ alive, identity: stamp }));
    const clock = fakeClock();
    const result = await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock,
      isAlive: (pid, rec, options) => probeRunner(pid, rec, { ...options, read }) });
    expect(result).toMatchObject(code === 1
      ? { status: 'failed', code: 1, reason: 'runner-died' }
      : { status: 'running', code: 75, liveness: alive === true ? 'alive' : 'unknown' });
    expect(read).toHaveBeenCalledWith(record.pid, expect.objectContaining({ scope: record.recordPath }));
    if (code === 1) expect(clock.sleep).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'EINVAL'])('T3: unreadable identity (%s) is unknown', async code => {
    const record = writeRecord();
    const exec = vi.fn(async () => { throw Object.assign(new Error('probe failed'), { code }); });
    const result = await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...fakeClock(),
      isAlive: (pid, rec, options) => probeRunner(pid, rec, { ...options,
        read: (p, opts) => readProcess(p, { ...opts, platform: 'darwin', exec }) }) });
    expect(result).toMatchObject({ code: 75, liveness: 'unknown' });
    expect(exec).toHaveBeenCalled();
  });

  it('reports runner-died when the recorded pid was reused by an unrelated live process', async () => {
    // A deterministic live ps row with a different birth stamp reproduces PID reuse.
    const record = writeRecord({ pid: process.pid, runnerStart: 'Sat Jan  1 00:00:00 2000', runnerArgv: 'detached-op.mjs --run-record' });
    const clock = fakeClock();
    const exec = async () => `501 ${record.pid} 1 ${record.pid} S Mon Oct 26 21:00:00 2026 node unrelated.mjs`;
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock,
      isAlive: (pid, rec, options) => probeRunner(pid, rec, { ...options,
        read: (p, opts) => readProcess(p, { ...opts, platform: 'darwin', exec }) }) }))
      .toMatchObject({ status: 'failed', code: 1, reason: 'runner-died' });
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('keeps a live runner whose recorded birth stamp still matches', async () => {
    const scope = join(dir, 'resume-job.json');
    const exec = async () => `501 12345 1 12345 S Mon Oct 26 21:00:00 2026 node detached-op.mjs --run-record=${scope}`;
    const read = (pid, opts) => readProcess(pid, { ...opts, platform: 'darwin', exec });
    const stamp = await read(12345, { scope });
    expect(stamp.identity.start).toEqual(expect.any(String));
    const record = writeRecord({ runnerIdentity: stamp.identity });
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...fakeClock(),
      isAlive: (pid, rec, options) => probeRunner(pid, rec, { ...options, read }) }))
      .toMatchObject({ status: 'running', code: 75, liveness: 'alive' });
  });

  it('rejects a record whose birth stamp is not a string or null', async () => {
    const record = writeRecord({ pid: process.pid, runnerStart: 7 });
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...fakeClock() }))
      .toMatchObject({ status: 'failed', code: 1, reason: 'invalid-record' });
  });

  it('stamps the launched runner birth identity into the running record', async () => {
    const read = vi.fn((pid, options) => readProcess(pid, { ...options, platform: 'darwin',
      exec: async () => `501 ${pid} 1 ${pid} S Mon Oct 26 21:00:00 2026 node detached-op.mjs --run-record=${options.scope} -- node task.mjs --token=SECRET` }));
    const record = await startDetachedOp({
      argv: [process.execPath, '-e', ''], kind: 'acceptance', dir, env: {},
      spawnFn: () => ({ pid: 43210, unref: vi.fn() }), read,
    });
    expect(read).toHaveBeenCalledWith(43210, { scope: record.recordPath });
    // The wrapped command line (which may hold secrets) never reaches the record.
    expect(record).toMatchObject({
      runnerIdentity: { start: 'Mon Oct 26 21:00:00 2026', scope: record.recordPath },
    });
    const stored = readFileSync(join(dir, `${record.id}.json`), 'utf8');
    expect(stored).not.toContain('SECRET');
    expect(JSON.parse(stored)).toEqual(record);
  });

  it('stores no argv even when ps carries no wrapped-command separator', async () => {
    const record = await startDetachedOp({
      argv: [process.execPath, '-e', ''], kind: 'acceptance', dir, env: {},
      spawnFn: () => ({ pid: 43210, unref: vi.fn() }),
      read: (pid, opts) => readProcess(pid, { ...opts, platform: 'darwin',
        exec: async () => `501 ${pid} 1 ${pid} S Mon Oct 26 21:00:00 2026 node detached-op.mjs` }),
    });
    expect(record.runnerIdentity.start).toBe('Mon Oct 26 21:00:00 2026');
    expect(record).not.toHaveProperty('runnerArgv');
    expect(record.runnerIdentity).not.toHaveProperty('argv');
  });

  it('has the real runner stamp itself when the launcher could not read its identity', async () => {
    const record = await startDetachedOp({
      argv: [process.execPath, '-e', keepAliveScript({ maxLifetimeMs: 1500 })], kind: 'acceptance', dir, env: {},
      read: async () => ({ alive: null }),
    });
    expect(record.runnerIdentity).toBeNull();
    let stored = record;
    for (let i = 0; i < 100 && !stored.runnerIdentity; i++) {
      await new Promise(done => setTimeout(done, 50));
      stored = JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8'));
    }
    expect(stored).toMatchObject({ status: 'running', runnerIdentity: { start: expect.any(String), scope: record.recordPath } });
    expect(stored.runnerIdentity).not.toHaveProperty('argv');
    expect(await waitForOp({ id: record.id, maxWaitMs: 15000, dir })).toMatchObject({ status: 'done', code: 0 });
  }, 20000);

  it('keeps an unstamped legacy runner unknown with the default liveness probe', async () => {
    const record = writeRecord({ pid: process.pid });
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...fakeClock() }))
      .toMatchObject({ status: 'running', code: 75, liveness: 'unknown' });
  });

  it.each(['ESRCH', 'EINVAL', 'ENOENT'])('a failed ps invocation (%s) is unknown, without signal zero', async code => {
    const record = writeRecord();
    const error = Object.assign(new Error(code), { code });
    const kill = vi.spyOn(process, 'kill');
    try {
      const waiting = waitForOp({ id: record.id, maxWaitMs: 250, dir, ...fakeClock(),
        isAlive: (pid, rec, options) => probeRunner(pid, rec, { ...options,
          read: (p, opts) => readProcess(p, { ...opts, platform: 'darwin', exec: async () => { throw error; } }) }) });
      expect(await waiting).toMatchObject({ code: 75, liveness: 'unknown' });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('validates the replacement record read after a dead-runner probe', async () => {
    const record = writeRecord();
    const clock = fakeClock();
    const isAlive = vi.fn(() => {
      writeRecord({ status: 'done', exitCode: null });
      return false;
    });
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock, isAlive }))
      .toMatchObject({ id: record.id, status: 'failed', code: 1, reason: 'invalid-record' });
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('re-reads only once even if a replacement running record has a different pid', async () => {
    const record = writeRecord();
    const clock = fakeClock();
    const isAlive = vi.fn(() => {
      writeRecord({ pid: record.pid + 1 });
      return false;
    });
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock, isAlive }))
      .toMatchObject({ status: 'failed', code: 1, reason: 'runner-died' });
    expect(isAlive).toHaveBeenCalledOnce();
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('fails closed with unknown-job for an unknown id', async () => {
    const clock = fakeClock();
    const isAlive = vi.fn();
    expect(await waitForOp({ id: 'unknown', maxWaitMs: 250, dir, ...clock, isAlive }))
      .toMatchObject({ id: 'unknown', status: 'failed', code: 1, reason: 'unknown-job' });
    expect(isAlive).not.toHaveBeenCalled();
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('resumes the SAME job on repeated waits: first code 75, then code 0 after completion', async () => {
    const record = writeRecord();
    const firstClock = fakeClock();
    const first = await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...firstClock, isAlive: () => true });
    expect(first).toMatchObject({ id: record.id, status: 'running', code: 75 });
    writeRecord({ status: 'done', exitCode: 0 });
    const secondClock = fakeClock();
    const second = await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...secondClock, isAlive: () => false });
    expect(second).toMatchObject({ id: first.id, status: 'done', code: 0, exitCode: 0 });
    expect(JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8')).pid).toBe(record.pid);
    expect(secondClock.sleep).not.toHaveBeenCalled();
  });

  it('handleDetachCli returns null without --detach or --wait-for and emits nothing', async () => {
    const out = vi.fn();
    expect(await handleDetachCli(['--task=ordinary'], {
      scriptPath: 'scripts/example.mjs', kind: 'acceptance', dir, env: {}, out,
    })).toBeNull();
    expect(out).not.toHaveBeenCalled();
  });

  it('T7: O_EXCL admits one reaper and it writes failure only after ownership cleanup', async () => {
    const record = writeRecord({ version: 2 });
    let release;
    const pending = new Promise(done => { release = done; });
    const sweep = vi.fn(async () => ({ complete: true, members: [] }));
    const first = reapRecord(record.recordPath, { probe: async () => { await pending; return false; }, sweep });
    await reapRecord(record.recordPath, { probe: vi.fn(), sweep });
    expect(sweep).not.toHaveBeenCalled();
    expect(readFileSync(record.recordPath, 'utf8')).toContain('"running"');
    release();
    await first;
    expect(sweep).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(record.recordPath, 'utf8'))).toMatchObject({
      status: 'failed', exitCode: 137, reason: 'runner-died', cleanup: 'observed-owners-stopped',
    });
  });

  it('T9: a reaper never presents escaped or unreadable owners as successful cleanup', async () => {
    const record = writeRecord({ version: 2 });
    await reapRecord(record.recordPath, { probe: async () => false,
      sweep: async () => ({ complete: false, members: [{ pid: 43210 }] }) });
    expect(await waitForOp({ dir, id: record.id })).toMatchObject({
      code: 1, status: 'failed', reason: 'escaped-descendants', cleanup: 'incomplete', containment: 'best-effort',
    });
  });

  it('T11: terminal publication wins a concurrent reaper death probe', async () => {
    const record = writeRecord({ version: 2 });
    const sweep = vi.fn();
    await reapRecord(record.recordPath, { probe: async () => {
      writeRecord({ version: 2, status: 'done', exitCode: 0 });
      return false;
    }, sweep });
    expect(sweep).not.toHaveBeenCalled();
    expect(await waitForOp({ dir, id: record.id })).toMatchObject({ status: 'done', code: 0 });
  });

  it('T11: a dead v2 runner remains cleanup-pending until its reaper publishes', async () => {
    const record = writeRecord({ version: 2 });
    expect(await waitForOp({ dir, id: record.id, maxWaitMs: 250, ...fakeClock(), isAlive: async () => false }))
      .toMatchObject({ code: 75, status: 'running', liveness: 'dead', reason: 'cleanup-pending' });
  });

  it('T10: repeated cancellation requests are durable, bounded and never signal a saved pid', async () => {
    const record = writeRecord({ version: 2 });
    const kill = vi.spyOn(process, 'kill');
    try {
      for (let i = 0; i < 2; i++) {
        expect(await cancelOp({ dir, id: record.id, maxWaitMs: 250, ...fakeClock(), isAlive: async () => null }))
          .toMatchObject({ code: 75, liveness: 'unknown' });
      }
      expect(readFileSync(`${record.recordPath}.cancel`, 'utf8')).toBe('SIGTERM\n');
      expect(kill).not.toHaveBeenCalled();
      expect(await cancelOp({ dir, id: '../escape' })).toMatchObject({ code: 1, reason: 'invalid-record' });
      expect(await cancelOp({ dir, id: 'missing' })).toMatchObject({ code: 1, reason: 'unknown-job' });
      writeFileSync(`${record.recordPath}.cancel`, 'corrupt');
      expect(await cancelOp({ dir, id: record.id })).toMatchObject({ code: 1, reason: 'invalid-record' });
      writeRecord();
      expect(await cancelOp({ dir, id: record.id })).toMatchObject({ code: 1, reason: 'unsupported-cancellation-record' });
    } finally { kill.mockRestore(); }
  });

  it('T11: a nested detached Codex worker survives outer admission cleanup until its own cancellation sweep', async () => {
    const jobPath = join(dir, 'inner-job.json');
    const ready = join(dir, 'inner-ready');
    const pulse = join(dir, 'inner-pulse');
    const workerPath = join(dir, 'worker.cjs');
    const launcherPath = join(dir, 'launcher.mjs');
    const pool = join(dir, '.lanes');
    mkdirSync(join(pool, '.admission', 'heavy'), { recursive: true });
    // Replace only the expensive Codex workload. The real launch function, OS
    // detachment, file descriptors, admission CLI and ownership sweeps all run.
    writeFileSync(workerPath, keepAliveScript({ maxLifetimeMs: 60000, postlude: `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setInterval(() => fs.writeFileSync(${JSON.stringify(pulse)}, 'alive'), 25);
    ` }));
    writeFileSync(launcherPath, `
      import { writeFileSync, existsSync } from 'node:fs';
      import { setTimeout as sleep } from 'node:timers/promises';
      import { startDetachedJob } from ${JSON.stringify(pathToFileURL(join(TEST_DIR, '../../codex-direct-task.mjs')).href)};
      const job = await startDetachedJob({ args: ['--detach'],
        jobsDir: ${JSON.stringify(join(dir, 'jobs'))}, scriptPath: ${JSON.stringify(workerPath)} });
      writeFileSync(${JSON.stringify(jobPath)}, JSON.stringify(job));
      const deadline = Date.now() + 10000;
      while (!existsSync(${JSON.stringify(ready)})) {
        if (Date.now() >= deadline) throw new Error('inner worker did not start');
        await sleep(25);
      }
    `);
    const env = { ...process.env, LANE_POOL_ROOT: pool, DETACHED_OPS_DIR: dir,
      WE_PLATFORM_PREFERENCES: join(dir, 'no-preferences.json'),
      WE_HEAVY_ADMISSION_CAP: '1', WE_HEAVY_ADMISSION_FAST_SLOTS: '0',
      WE_HEAVY_ADMISSION_RUN_WAIT_MS: '0', WE_HEAVY_ADMISSION_CONTAINER: '0',
      WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES: '0', VITEST: 'true',
      WE_TEST_HOST_LOAD1: '0', WE_TEST_HOST_MEMORY_MB: '16384',
      WE_RESOURCE_SHADOW: 'off', WE_RESOURCE_CUTOVER: 'shadow' };
    delete env.CI;
    delete env.WE_HEAVY_ADMISSION;
    delete env.WE_HEAVY_ADMISSION_HELD;
    let outer, inner;
    try {
      const launched = spawnSync(process.execPath, [
        join(TEST_DIR, '../../readiness/heavy-admission.mjs'),
        'run', '--detach', '--', process.execPath, launcherPath,
      ], { cwd: dir, env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
      expect(launched.error, launched.stderr).toBeUndefined();
      expect(launched.status, launched.stderr).toBe(0);
      outer = JSON.parse(launched.stdout);
      const finished = await waitForOp({ id: outer.id, dir, maxWaitMs: 20000 });
      expect(finished).toMatchObject({ status: 'done', code: 0, cleanup: 'observed-owners-stopped' });
      inner = JSON.parse(readFileSync(jobPath, 'utf8'));
      const ownScope = inner.recordPath;
      const living = await readProcess(inner.pid, { scope: ownScope });
      expect(living.alive, 'outer completion killed the independently detached Codex worker').toBe(true);
      rmSync(pulse, { force: true });
      await vi.waitFor(() => expect(existsSync(pulse)).toBe(true), { timeout: 2000, interval: 25 });

      // Codex jobs use signal cancellation. Sweep with this job's own identity
      // and logs, proving isolation did not make the worker unkillable.
      const cancelled = await sweepOwnedProcesses({ ...inner,
        commandIdentity: living.identity, stdoutPath: inner.resultPath,
        stderrPath: join(dir, 'jobs', `${inner.id}.stderr.log`),
      }, { signal: 'SIGTERM' });
      expect(cancelled).toEqual({ complete: true, members: [] });
      expect((await readProcess(inner.pid, { scope: ownScope })).alive).toBe(false);
      rmSync(pulse, { force: true });
      await new Promise(done => setTimeout(done, 150));
      expect(existsSync(pulse)).toBe(false);
    } finally {
      if (!inner && existsSync(jobPath)) inner = JSON.parse(readFileSync(jobPath, 'utf8'));
      if (outer) await cancelOp({ id: outer.id, dir, maxWaitMs: 10000 });
      if (inner) { try { process.kill(inner.pid, 'SIGKILL'); } catch {} }
    }
  }, 45000);

  it.each([['SIGTERM', 'marker'], ['SIGTERM', 'logs'], ['SIGKILL', 'marker'], ['SIGKILL', 'logs']])(
    'T5/T6/T7: runner %s stops a double-forked orphan owned only by %s', async (signal, ownership) => {
      const ready = join(dir, 'orphan-ready');
      const pulse = join(dir, 'orphan-pulse');
      const reparented = join(dir, 'middle-exited');
      const forwarded = join(dir, 'signal-forwarded');
      const orphan = `
        const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        setInterval(() => fs.writeFileSync(${JSON.stringify(pulse)}, 'still working'), 25);
        setTimeout(() => process.exit(0), 20000);
      `;
      const middle = `
        const env = { ...process.env };
        if (${JSON.stringify(ownership)} === 'logs') delete env.WE_DETACHED_OP;
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(orphan)}],
          { detached: true, stdio: ${JSON.stringify(ownership === 'logs' ? 'inherit' : 'ignore')}, env });
        child.unref();
      `;
      const source = `
        const fs = require('node:fs');
        process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(forwarded)}, 'received'));
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(middle)}], { stdio: 'inherit' })
          .once('exit', () => fs.writeFileSync(${JSON.stringify(reparented)}, 'reparented'));
        setTimeout(() => process.exit(0), 20000);
      `;
      const record = await startDetachedOp({ argv: [process.execPath, '-e', source], kind: 'ownership-test', dir });
      let orphanPid;
      try {
        await vi.waitFor(() => {
          expect(existsSync(ready)).toBe(true);
          expect(existsSync(reparented)).toBe(true);
        }, { timeout: 10000, interval: 25 });
        orphanPid = Number(readFileSync(ready, 'utf8'));
        process.kill(record.pid, signal);
        const result = await waitForOp({ id: record.id, dir, maxWaitMs: 15000 });
        expect(result).toMatchObject({ code: 1, status: 'failed', exitCode: signal === 'SIGTERM' ? 143 : 137,
          reason: signal === 'SIGTERM' ? 'cancelled' : 'runner-died', cleanup: 'observed-owners-stopped' });
        if (signal === 'SIGTERM') expect(readFileSync(forwarded, 'utf8')).toBe('received');
        rmSync(pulse, { force: true });
        await new Promise(done => setTimeout(done, 250));
        expect(existsSync(pulse), 'orphan executed after terminal cleanup').toBe(false);
      } finally {
        for (const pid of [orphanPid, record.pid]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    }, 30000,
  );

  it('T7: SIGKILL immediately after launch is covered by the independent reaper', async () => {
    const pulse = join(dir, 'startup-pulse');
    const source = `
      const fs = require('node:fs');
      setInterval(() => fs.writeFileSync(${JSON.stringify(pulse)}, 'alive'), 25);
      setTimeout(() => process.exit(0), 20000);
    `;
    const record = await startDetachedOp({ argv: [process.execPath, '-e', source], dir, kind: 'startup-race' });
    try {
      process.kill(record.pid, 'SIGKILL');
      expect(await waitForOp({ id: record.id, dir, maxWaitMs: 15000 }))
        .toMatchObject({ code: 1, reason: 'runner-died', exitCode: 137, cleanup: 'observed-owners-stopped' });
      rmSync(pulse, { force: true });
      await new Promise(done => setTimeout(done, 250));
      expect(existsSync(pulse)).toBe(false);
    } finally { try { process.kill(record.pid, 'SIGKILL'); } catch {} }
  }, 20000);
});

describe('process ownership model (T1–T11)', () => {
  const scope = '/fixture/job.json';
  const start = 'Tue Oct 27 12:00:00 2026';
  const owner = pid => ({ pid, platform: 'darwin', start, scope });
  const row = (pid, ppid = 1, pgid = pid, birth = start, state = 'S') => `501 ${pid} ${ppid} ${pgid} ${state} ${birth}`;
  const record = { id: 'job', pid: 900, recordPath: scope, stdoutPath: '/fixture/out', stderrPath: '/fixture/err',
    commandIdentity: owner(101), members: [owner(105)] };
  function snapshot(rows, { marker = '', logs = '', failLogs = false } = {}) {
    return { platform: 'darwin', uid: 501, exec: async (file, args) => {
      if (file.endsWith('/lsof')) {
        if (failLogs) throw new Error('log probe unavailable');
        return logs;
      }
      return args[0] === 'eww' ? marker : rows.join('\n');
    } };
  }
  function linuxExitSnapshot({ at = 'fdinfo', code = 'EACCES', after = 'Z', oversized = false,
    excluded = false } = {}) {
    let failed = false;
    const error = value => Object.assign(new Error(value), { code: value });
    const fail = () => { failed = true; throw error(code); };
    const io = {
      readFile: vi.fn(async path => {
        if (path.endsWith('/boot_id')) return 'boot';
        if (path.endsWith('/stat')) {
          if (failed && ['ENOENT', 'ESRCH', 'EACCES'].includes(after)) throw error(after);
          const fields = [failed && after === 'Z' ? 'Z' : 'S', '1', '101', ...Array(16).fill('0'),
            failed && after === 'reused' ? '456' : '123'];
          return `101 (fixture) ${fields.join(' ')}`;
        }
        if (path.endsWith('/environ')) {
          if (at === 'environ') fail();
          return 'WE_DETACHED_OP=job\0';
        }
        if (path.includes('/fdinfo/')) return fail();
        throw new Error(`unexpected read ${path}`);
      }),
      readdir: vi.fn(async path => {
        if (path === '/proc') return excluded ? [String(record.pid), String(process.pid), '101'] : ['101'];
        if (oversized) { failed = true; return Array.from({ length: 4097 }, (_, i) => String(i)); }
        return ['1'];
      }),
      stat: vi.fn(async path => {
        if (path === record.stdoutPath) return { dev: 1, ino: 1 };
        if (path === record.stderrPath) return { dev: 1, ino: 2 };
        if (path.includes('/fd/')) {
          if (at === 'fd') fail();
          return { dev: 1, ino: 1 };
        }
        if (excluded && path !== '/proc/101') throw error('EACCES');
        return { uid: 501 };
      }),
    };
    return { platform: 'linux', uid: 501, io };
  }

  it('T1: Linux identity uses start ticks and boot id, including names containing parentheses', async () => {
    const fields = ['S', '1', '101', ...Array(16).fill('0'), '45678'];
    const io = { readFile: async path => path.endsWith('/boot_id') ? 'boot-a\n' : `101 (task (name)) ${fields.join(' ')}` };
    const current = await readProcess(101, { platform: 'linux', scope, io });
    expect(current.identity).toEqual({ pid: 101, platform: 'linux', start: '45678', bootId: 'boot-a', scope });
    for (const changed of [{ start: '45679' }, { bootId: 'boot-b' }, { scope: '/other/job.json' }]) {
      expect(await probeRunner(101, { recordPath: scope, runnerIdentity: { ...current.identity, ...changed } },
        { read: async () => current })).toBe(false);
    }
    const zombie = { readFile: async path => path.endsWith('/boot_id') ? 'boot-a' : `101 (zombie) ${['Z', ...fields.slice(1)].join(' ')}` };
    expect(await readProcess(101, { platform: 'linux', scope, io: zombie })).toEqual({ alive: false });
  });

  it('T1: macOS requires both lstart and this run-record path, with no argv stored', async () => {
    const read = (argv, birth = start) => readProcess(101, { platform: 'darwin', scope,
      exec: async () => `${row(101, 1, 101, birth)} node detached-op.mjs ${argv}` });
    const expected = { recordPath: scope, runnerIdentity: owner(101) };
    expect(await probeRunner(101, expected, { read: () => read(`--run-record=${scope} -- secret`) })).toBe(true);
    expect(await probeRunner(101, expected, { read: () => read('--run-record=/other/job.json') })).toBe(false);
    expect(await probeRunner(101, expected, { read: () => read(`--run-record=${scope}`, 'Mon Oct 26 12:00:00 2026') })).toBe(false);
    expect((await read(`--run-record=${scope} -- secret`)).identity).not.toHaveProperty('argv');
  });

  it('T2: missing, zombie, malformed and denied probes remain distinct', async () => {
    for (const [output, alive] of [['', false], [row(101, 1, 101, start, 'Z'), false], ['truncated', null]]) {
      expect(await readProcess(101, { scope, platform: 'darwin', exec: async () => output })).toMatchObject({ alive });
    }
    const io = { readFile: async () => { throw Object.assign(new Error('no proc'), { code: 'ENOENT' }); } };
    expect(await readProcess(101, { scope, platform: 'linux', io })).toEqual({ alive: null });
  });

  it('T6: discovers the group, reparented marker/log holders and remembered escapees', async () => {
    const rows = [row(101), row(102, 1, 101), row(103), row(104), row(105), row(106, 103), row(107)];
    const result = await collectOwnedProcesses(record, snapshot(rows, {
      marker: '103 node worker WE_DETACHED_OP=job\n106 node worker WE_DETACHED_OP=job\n107 node unrelated WE_DETACHED_OP=job-suffix',
      logs: 'p104\nf1\naw\np107\nf3\nar\n',
    }));
    expect(result.complete).toBe(true);
    expect(result.members.map(p => p.pid)).toEqual([101, 102, 103, 104, 105, 106]);
  });

  it('T11: a nested detached operation owns its own runner and reaper', async () => {
    const result = await collectOwnedProcesses(record, snapshot([row(101), row(108, 101), row(109, 101)], {
      marker: '101 node command WE_DETACHED_OP=job\n108 node runner WE_DETACHED_OP=nested-job',
    }));
    expect(result.members).toEqual([owner(101)]);
  });

  it('T6: Linux discovers marker and writable inode holders without owning log readers', async () => {
    const pids = [101, 102, 103, 104, 105, 106, 107];
    const linuxOwner = pid => ({ pid, platform: 'linux', scope, start: String(pid * 100), bootId: 'boot' });
    const io = {
      readFile: async path => {
        if (path.endsWith('/boot_id')) return 'boot';
        const pid = Number(path.split('/')[2]);
        if (path.endsWith('/stat')) {
          const fields = ['S', '1', pid === 102 ? '101' : String(pid), ...Array(16).fill('0'), String(pid * 100)];
          return `${pid} (fixture) ${fields.join(' ')}`;
        }
        if (path.endsWith('/environ')) return pid === 103 ? 'X=1\0WE_DETACHED_OP=job\0' : 'WE_DETACHED_OP=job-other\0';
        if (path.includes('/fdinfo/')) return pid === 104 ? 'flags:\t0100001\n' : 'flags:\t0100000\n';
        throw new Error(`unexpected read ${path}`);
      },
      readdir: async path => path === '/proc' ? pids.map(String)
        : [104, 106].includes(Number(path.split('/')[2])) ? ['1'] : [],
      stat: async path => path === record.stdoutPath ? { dev: 1, ino: 1 }
        : path === record.stderrPath ? { dev: 1, ino: 2 }
          : path.includes('/fd/') ? { dev: 1, ino: 1 } : { uid: 501 },
    };
    const result = await collectOwnedProcesses({ ...record, commandIdentity: linuxOwner(101), members: [linuxOwner(105)] },
      { platform: 'linux', io, uid: 501 });
    expect(result.complete).toBe(true);
    expect(result.members.map(p => p.pid).sort()).toEqual([101, 102, 103, 104, 105]);
  });

  it.each(['fd', 'fdinfo'])('T9: a disappearing Linux descriptor (%s ESRCH) does not poison cleanup', async at => {
    const result = await collectOwnedProcesses({ ...record, commandIdentity: null, members: [] },
      linuxExitSnapshot({ at, code: 'ESRCH', after: 'S' }));
    expect(result).toEqual({ complete: true,
      members: [{ pid: 101, platform: 'linux', start: '123', bootId: 'boot', scope }] });
  });

  it.each(['environ', 'fd', 'fdinfo'])('T9: Linux %s permission loss is cleared only after confirmed exit', async at => {
    for (const code of ['EACCES', 'EPERM']) {
      for (const after of ['Z', 'ENOENT', 'ESRCH', 'reused']) {
        expect(await collectOwnedProcesses(record, linuxExitSnapshot({ at, code, after })))
          .toEqual({ complete: true, members: [] });
      }
    }
  });

  it.each(['environ', 'fd', 'fdinfo'])('T9: Linux %s denial for a live or unreadable process stays incomplete', async at => {
    for (const after of ['S', 'EACCES']) {
      const result = await collectOwnedProcesses(record, linuxExitSnapshot({ at, after }));
      expect(result.complete).toBe(false);
      expect(result.members).toEqual(at === 'environ' ? []
        : [{ pid: 101, platform: 'linux', start: '123', bootId: 'boot', scope }]);
    }
  });

  it('T9: Linux runner and observer permissions cannot poison discovery of eligible owners', async () => {
    const options = linuxExitSnapshot({ at: 'fdinfo', code: 'ENOENT', excluded: true });
    expect((await collectOwnedProcesses(record, options)).complete).toBe(true);
    for (const method of ['stat', 'readFile', 'readdir']) {
      expect(options.io[method].mock.calls.flat().some(path => typeof path === 'string'
        && [record.pid, process.pid].some(pid => path === `/proc/${pid}` || path.startsWith(`/proc/${pid}/`))))
        .toBe(false);
    }
  });

  it('T9: oversized Linux descriptor scans stay bounded and require confirmed death to clear', async () => {
    for (const after of ['S', 'Z']) {
      const options = linuxExitSnapshot({ oversized: true, after });
      expect((await collectOwnedProcesses(record, options)).complete).toBe(after === 'Z');
      expect(options.io.stat.mock.calls.some(([path]) => path.includes('/fd/'))).toBe(false);
    }
  });

  it('T4: stalled platform probes and ownership scans respect their deadline', async () => {
    const signals = [];
    const exec = (_file, _args, { signal }) => { signals.push(signal); return new Promise(() => {}); };
    const began = performance.now();
    expect(await readProcess(101, { platform: 'darwin', scope, exec, deadline: Date.now() + 25 })).toEqual({ alive: null });
    expect(await collectOwnedProcesses(record, { platform: 'darwin', exec, deadline: Date.now() + 25 }))
      .toEqual({ complete: false, members: [] });
    expect(performance.now() - began).toBeLessThan(1000);
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('T8: a reused pgid never transfers ownership to unrelated processes', async () => {
    const result = await collectOwnedProcesses(record, snapshot([
      row(101, 1, 101, 'Mon Oct 26 12:00:00 2026'), row(102, 1, 101), row(105),
    ]));
    expect(result).toEqual({ complete: true, members: [owner(105)] });
  });

  it('T8: a live remembered group member anchors orphaned group members after the leader exits', async () => {
    const result = await collectOwnedProcesses({ ...record, members: [owner(102)] },
      snapshot([row(102, 1, 101), row(103, 1, 101), row(104)]));
    expect(result.members.map(p => p.pid)).toEqual([102, 103]);
  });

  it('T9: failed and oversized snapshots expose incomplete ownership', async () => {
    expect(await collectOwnedProcesses(record, snapshot([row(101)], { failLogs: true })))
      .toMatchObject({ complete: false, members: [owner(101)] });
    expect(await collectOwnedProcesses(record, snapshot(Array(32769).fill(row(101)))))
      .toEqual({ complete: false, members: [] });
  });

  it('T5: cleanup forwards the signal, escalates ignoring owners, and discovers later detachments', async () => {
    vi.useFakeTimers();
    try {
      const living = new Set([101]);
      let scans = 0;
      const collect = async () => {
        if (++scans === 2) living.add(103);
        return { complete: true, members: [...living].map(owner) };
      };
      const read = async pid => ({ alive: living.has(pid), identity: owner(pid) });
      const kill = vi.fn((pid, signal) => { if (signal === 'SIGKILL') living.delete(pid); });
      const result = await sweepOwnedProcesses({ ...record, members: [] }, { signal: 'SIGINT', collect, read, kill,
        deadline: Date.now() + 1000, pause: async ms => { vi.advanceTimersByTime(ms); } });
      expect(result).toEqual({ complete: true, members: [] });
      expect(kill).toHaveBeenCalledWith(101, 'SIGINT');
      expect(kill).toHaveBeenCalledWith(101, 'SIGKILL');
      expect(kill).toHaveBeenCalledWith(103, 'SIGKILL');
      expect(kill.mock.calls.every(([pid]) => pid > 0)).toBe(true);
      expect(living.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('T8: identity reuse between discovery and signalling never kills the replacement', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const kill = vi.fn();
      const result = await sweepOwnedProcesses({ ...record, members: [owner(101)] }, {
        collect: async () => ({ complete: true, members: [] }), kill,
        read: async () => ({ alive: true, identity: reads++ === 0 ? owner(101) : { ...owner(101), start: 'new-birth' } }),
        deadline: Date.now() + 1000, pause: async ms => { vi.advanceTimersByTime(ms); },
      });
      expect(kill).not.toHaveBeenCalled();
      expect(result.complete).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('T9: unknown identity and EPERM exhaust cleanup as escaped-descendants', async () => {
    vi.useFakeTimers();
    try {
      for (const alive of [null, true]) {
        const kill = vi.fn(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
        const result = await sweepOwnedProcesses({ ...record, members: [owner(101)] }, {
          collect: async () => ({ complete: true, members: [owner(101)] }),
          read: async () => ({ alive, identity: owner(101) }), kill,
          deadline: Date.now() + 500, pause: async ms => { vi.advanceTimersByTime(ms); },
        });
        expect(result).toMatchObject({ complete: false, reason: 'escaped-descendants', members: [owner(101)] });
        if (alive === null) expect(kill).not.toHaveBeenCalled();
      }
    } finally { vi.useRealTimers(); }
  });

  it('T9: failed discovery still stops the stamped command without claiming full containment', async () => {
    vi.useFakeTimers();
    try {
      let alive = true;
      const kill = vi.fn((_pid, signal) => { if (signal === 'SIGKILL') alive = false; });
      const result = await sweepOwnedProcesses({ ...record, members: [] }, {
        collect: async () => ({ complete: false, members: [] }),
        read: async () => ({ alive, identity: owner(101) }), kill,
        deadline: Date.now() + 500, pause: async ms => { vi.advanceTimersByTime(ms); },
      });
      expect(kill).toHaveBeenCalledWith(101, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(101, 'SIGKILL');
      expect(result).toEqual({ complete: false, members: [], reason: 'escaped-descendants' });
    } finally { vi.useRealTimers(); }
  });
});

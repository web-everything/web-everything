/** @file Acceptance contract for resumable detached operations and runner liveness. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pidProbes from '../pid-alive.mjs';
import {
  resolveDetachedOpsDir, parseDetachFlags, startDetachedOp, waitForOp, handleDetachCli,
} from '../detached-op.mjs';

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

  it('extracts only the three detached-operation flags and preserves remaining argv in order', () => {
    const argv = ['node', 'task.mjs', '--detach', '--task=a=b', '--wait-for=job-1', '--max-wait-ms=1000', 'input'];
    const original = [...argv];
    expect(parseDetachFlags(argv)).toEqual({
      detach: true, waitFor: 'job-1', maxWaitMs: 1000,
      rest: ['node', 'task.mjs', '--task=a=b', 'input'],
    });
    expect(argv).toEqual(original);
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
      expect(options.stdio[0]).toBe('ignore');
      expect(fstatSync(options.stdio[1]).isFile()).toBe(true);
      expect(fstatSync(options.stdio[2]).isFile()).toBe(true);
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
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
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
    await startDetachedOp({ argv: [process.execPath, '-e', ''], kind: 'acceptance', dir, env, spawnFn });
    expect(spawnFn.mock.calls[0][2].env).toEqual({ DETACHED_OPS_DIR: dir, KEEP_ME: 'preserved' });
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
    expect(isAlive).toHaveBeenCalledWith(record.pid);
    expect(JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8'))).toEqual(record);
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
    expect(isAlive).toHaveBeenCalledWith(record.pid);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['zombie', false, 1], ['gone', false, 1], ['match', true, 75], ['unreadable', null, 75],
  ])('consults identity after signal zero succeeds: %s', async (reason, alive, code) => {
    const record = writeRecord({ pid: process.pid });
    const identity = vi.spyOn(pidProbes, 'pidIdentity').mockReturnValue({ alive, reason });
    try {
      const clock = fakeClock();
      const result = await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock });
      expect(result).toMatchObject(code === 1
        ? { status: 'failed', code: 1, reason: 'runner-died' }
        : { status: 'running', code: 75 });
      expect(identity).toHaveBeenCalledWith(record.pid);
      if (code === 1) expect(clock.sleep).not.toHaveBeenCalled();
    } finally {
      identity.mockRestore();
    }
  });

  it.each([false, true, null])('consults identity after EPERM (alive=%s)', async alive => {
    const record = writeRecord();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    const identity = vi.spyOn(pidProbes, 'pidIdentity').mockReturnValue({ alive });
    try {
      const result = await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...fakeClock() });
      expect(result.code).toBe(alive === false ? 1 : 75);
      expect(identity).toHaveBeenCalledWith(record.pid);
    } finally {
      kill.mockRestore();
      identity.mockRestore();
    }
  });

  it('keeps an actual live runner running with the default liveness probe', async () => {
    const record = writeRecord({ pid: process.pid });
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...fakeClock() }))
      .toMatchObject({ status: 'running', code: 75 });
  });

  it.each(['ESRCH', 'EINVAL'])('handles signal-zero %s before inspecting identity', async code => {
    const record = writeRecord();
    const error = Object.assign(new Error(code), { code });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw error; });
    const identity = vi.spyOn(pidProbes, 'pidIdentity');
    try {
      const waiting = waitForOp({ id: record.id, maxWaitMs: 250, dir, ...fakeClock() });
      if (code === 'ESRCH') {
        expect(await waiting).toMatchObject({ status: 'failed', code: 1, reason: 'runner-died' });
      } else {
        await expect(waiting).rejects.toBe(error);
      }
      expect(identity).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      identity.mockRestore();
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
});

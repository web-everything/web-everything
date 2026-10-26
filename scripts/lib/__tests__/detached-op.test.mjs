/** @file Acceptance contract for resumable detached operations, including runner termination. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, fstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDetachedOpsDir, processStart, parseDetachFlags, startDetachedOp, waitForOp, handleDetachCli,
} from '../detached-op.mjs';

describe('resolveDetachedOpsDir', () => {
  it('uses the explicit DETACHED_OPS_DIR override', () => {
    expect(resolveDetachedOpsDir({ DETACHED_OPS_DIR: 'custom-operations' })).toBe('custom-operations');
  });

  it('defaults to the coordination detached-ops directory under the home directory', () => {
    expect(resolveDetachedOpsDir({})).toBe(join(homedir(), 'workspace', '.operations', 'coordination', 'detached-ops'));
  });
});

describe.skipIf(process.platform === 'win32')('runner termination integration', () => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  for (const [signal, stubborn, detachedDescendant] of [
    ['SIGTERM', true, false], ['SIGTERM', false, false],
    ['SIGINT', true, false], ['SIGHUP', true, false], ['SIGTERM', true, true],
  ]) {
    it(`stops command and descendants before reporting failure on ${signal} (stubborn command: ${stubborn}, detached descendant: ${detachedDescendant})`, async context => {
      if (detachedDescendant) {
        // Cross-group tree cleanup needs process-list access; a restricted sandbox
        // can still exercise all four process-group cancellation regressions.
        try { execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { stdio: 'ignore', timeout: 1000 }); }
        catch (error) {
          if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
          context.skip(); return;
        }
      }
      const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'detached-op-signal-'));
      const commandReady = join(dir, 'command.pid');
      const descendantReady = join(dir, 'descendant.pid');
      const heartbeat = join(dir, 'heartbeat');
      let record;
      const alive = pid => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      };
      try {
        const descendant = `
          const fs = require('node:fs');
          for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});
          fs.writeFileSync(${JSON.stringify(descendantReady)}, String(process.pid));
          setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'descendant\\n'), 10);
        `;
        const command = `
          const fs = require('node:fs');
          const { spawn } = require('node:child_process');
          if (${stubborn}) for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});
          spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore', detached: ${detachedDescendant} });
          fs.writeFileSync(${JSON.stringify(commandReady)}, String(process.pid));
          setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'command\\n'), 10);
        `;
        record = await startDetachedOp({ argv: [process.execPath, '-e', command], kind: 'signal-test', dir });
        const readyDeadline = Date.now() + 5000;
        while (!(existsSync(commandReady) && existsSync(descendantReady) && existsSync(heartbeat))) {
          if (Date.now() >= readyDeadline) throw new Error('command tree did not become ready');
          await delay(20);
        }
        expect(alive(Number(readFileSync(commandReady, 'utf8')))).toBe(true);
        expect(alive(Number(readFileSync(descendantReady, 'utf8')))).toBe(true);
        process.kill(record.pid, signal);
        let result;
        const terminalDeadline = Date.now() + 6000;
        do {
          result = await waitForOp({ id: record.id, dir, maxWaitMs: 250 });
          if (Date.now() >= terminalDeadline) throw new Error('runner cleanup did not finish');
        } while (result.status === 'running');
        expect(result).toMatchObject({ status: 'failed', code: 1,
          exitCode: { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 }[signal] });
        const stoppedAt = readFileSync(heartbeat, 'utf8');
        await delay(150);
        expect(readFileSync(heartbeat, 'utf8')).toBe(stoppedAt);
      } finally {
        // Also clean up the unfixed implementation after the red run.
        for (const path of [descendantReady, commandReady]) {
          if (!existsSync(path)) continue;
          const pid = Number(readFileSync(path, 'utf8'));
          try { process.kill(-pid, 'SIGKILL'); } catch {}
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        if (record) { try { process.kill(record.pid, 'SIGKILL'); } catch {} }
        await delay(30);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);
  }
});

describe.skipIf(process.platform === 'win32')('re-parented descendants (runner stop sweep)', () => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const psWorks = () => {
    try { execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], { stdio: 'ignore', timeout: 1000 }); return true; }
    catch { return false; }
  };

  // command (stays alive) -> mid -> detached grandchild; mid exits `midLingerMs` after spawning it,
  // so the grandchild is re-parented to PID 1 while the command keeps running.
  async function runScenario({ midLingerMs, snapshotMs }) {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'detached-op-reparent-'));
    const grandchildReady = join(dir, 'grandchild.pid');
    const midGone = join(dir, 'mid.gone');
    let record;
    let grandchildPid;
    try {
      const grandchild = `
        require('node:fs').writeFileSync(${JSON.stringify(grandchildReady)}, String(process.pid));
        for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});
        setInterval(() => {}, 1000);
      `;
      const mid = `
        const { spawn } = require('node:child_process');
        spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: true }).unref();
        setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(midGone)}, '1'); process.exit(0); }, ${midLingerMs});
      `;
      const command = `
        const { spawn } = require('node:child_process');
        spawn(process.execPath, ['-e', ${JSON.stringify(mid)}], { stdio: 'ignore' });
        setInterval(() => {}, 1000);
      `;
      record = await startDetachedOp({ argv: [process.execPath, '-e', command], kind: 'reparent-test', dir,
        env: { ...process.env, DETACHED_OP_SNAPSHOT_MS: String(snapshotMs) } });
      const readyDeadline = Date.now() + 8000;
      while (!(existsSync(grandchildReady) && existsSync(midGone))) {
        if (Date.now() >= readyDeadline) throw new Error('scenario did not become ready');
        await delay(20);
      }
      grandchildPid = Number(readFileSync(grandchildReady, 'utf8'));
      expect(alive(grandchildPid)).toBe(true);
      process.kill(record.pid, 'SIGTERM');
      const terminalDeadline = Date.now() + 8000;
      let result;
      do {
        result = await waitForOp({ id: record.id, dir, maxWaitMs: 250 });
        if (Date.now() >= terminalDeadline) throw new Error('runner cleanup did not finish');
      } while (result.status === 'running');
      await delay(100);
      return alive(grandchildPid);
    } finally {
      if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch {} }
      if (record) { try { process.kill(record.pid, 'SIGKILL'); } catch {} }
      await delay(30);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('leaves no survivor when a detached grandchild was re-parented to PID 1 before SIGTERM', async context => {
    if (!psWorks()) { context.skip(); return; }
    // mid lingers well past one snapshot interval, so the periodic snapshot saw the grandchild.
    expect(await runScenario({ midLingerMs: 900, snapshotMs: 100 })).toBe(false);
  }, 20000);

  it('documented bound: a descendant orphaned before any snapshot ran escapes the sweep', async context => {
    if (!psWorks()) { context.skip(); return; }
    // The module header states this race is not closed: nothing observed the grandchild while it was
    // still in the command tree. A huge interval makes "orphaned between snapshots" deterministic.
    expect(await runScenario({ midLingerMs: 0, snapshotMs: 3_600_000 })).toBe(true);
  }, 20000);
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

  it('fails closed with runner-died when a running record has a dead runner', async () => {
    const record = writeRecord();
    const clock = fakeClock();
    const isAlive = vi.fn(() => false);
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock, isAlive }))
      .toMatchObject({ id: record.id, status: 'failed', code: 1, reason: 'runner-died' });
    expect(isAlive).toHaveBeenCalledWith(record.pid);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it.each([['done', 0, 0], ['failed', 23, 1]])(
    'uses the %s record published between the first read and runner death', async (status, exitCode, code) => {
      const record = writeRecord();
      const clock = fakeClock();
      const isAlive = vi.fn(() => {
        writeRecord({ status, exitCode });
        writeFileSync(record.stdoutPath, 'final output\n');
        return false;
      });
      const result = await waitForOp({ id: record.id, dir, maxWaitMs: 250, ...clock, isAlive });
      expect(result).toMatchObject({ status, exitCode, code, stdoutTail: 'final output\n' });
      expect(result).not.toHaveProperty('reason');
      expect(isAlive).toHaveBeenCalledOnce();
      expect(clock.sleep).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'malformed', 'invalid'])('fails closed when the final record is %s', async variant => {
    const record = writeRecord();
    const clock = fakeClock();
    const isAlive = vi.fn(() => {
      const path = join(dir, `${record.id}.json`);
      if (variant === 'missing') rmSync(path);
      else if (variant === 'malformed') writeFileSync(path, '{');
      else writeRecord({ status: 'done', exitCode: null });
      return false;
    });
    expect(await waitForOp({ id: record.id, dir, maxWaitMs: 250, ...clock, isAlive }))
      .toMatchObject({ status: 'failed', code: 1, reason: variant === 'missing' ? 'unknown-job' : 'invalid-record' });
    expect(isAlive).toHaveBeenCalledOnce();
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('treats a live pid whose start time differs from the recorded pidStart as a dead runner (PID reuse)', async () => {
    const record = writeRecord({ pid: process.pid, pidStart: 'Mon Jan  1 00:00:00 2001' });
    const clock = fakeClock();
    const result = await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock });
    expect(result).toMatchObject({ id: record.id, status: 'failed', code: 1, reason: 'runner-died' });
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('keeps waiting while the live pid still has the recorded start time, and when none was recorded', async () => {
    const withStart = writeRecord({ pidStart: 'Mon Jan  1 00:00:00 2001' });
    const startOf = vi.fn(() => 'Mon Jan  1 00:00:00 2001');
    expect(await waitForOp({ id: withStart.id, maxWaitMs: 250, dir, ...fakeClock(), isAlive: () => true, startOf }))
      .toMatchObject({ status: 'running', code: 75 });
    expect(startOf).toHaveBeenCalledWith(withStart.pid);
    const legacy = writeRecord({ id: 'legacy-job' });
    const neverCalled = vi.fn();
    expect(await waitForOp({ id: legacy.id, maxWaitMs: 250, dir, ...fakeClock(), isAlive: () => true, startOf: neverCalled }))
      .toMatchObject({ status: 'running', code: 75 });
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('reads the same runner start time whatever TZ the reader runs under', () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utc = processStart(process.pid);
      process.env.TZ = 'America/New_York';
      expect(utc).toBeTruthy();
      expect(processStart(process.pid)).toBe(utc);
    } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
  });

  it('rejects a non-string pidStart as an invalid record', async () => {
    const record = writeRecord({ pidStart: 42 });
    expect(await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...fakeClock(), isAlive: () => true }))
      .toMatchObject({ status: 'failed', code: 1, reason: 'invalid-record' });
  });

  it('checks a replacement runner instead of applying the previous PID death to it', async () => {
    const record = writeRecord();
    const clock = fakeClock();
    const isAlive = vi.fn(pid => {
      if (pid === record.pid) {
        writeRecord({ pid: 54321 });
        return false;
      }
      return true;
    });
    expect(await waitForOp({ id: record.id, dir, maxWaitMs: 250, ...clock, isAlive }))
      .toMatchObject({ status: 'running', pid: 54321, code: 75 });
    expect(isAlive).toHaveBeenCalledWith(54321);
    expect(clock.now()).toBe(250);
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

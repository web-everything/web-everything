/** @file Acceptance contract for resumable detached operations, including runner termination. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, fstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { keepAliveScript } from '../test-keepalive.mjs';
import {
  resolveDetachedOpsDir, processStart, parseDetachFlags, startDetachedOp, waitForOp, handleDetachCli,
} from '../detached-op.mjs';

// Patch built-in boundaries only inside a disposable Node process. The real module,
// private runner entry point and filesystem run unchanged; no host process is signalled.
function boundaryProbe(dir, body) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { join } from 'node:path';
    const [dir, modulePath] = process.argv.slice(1);
    const tick = () => new Promise(resolve => setImmediate(resolve));
    ${body}
  `, dir, resolve('scripts/lib/detached-op.mjs')], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  }));
}

const controlledRunner = `
  const path = join(dir, 'controlled.json');
  const record = { id: 'controlled', status: 'running', pid: process.pid, exitCode: null,
    stdoutPath: join(dir, 'stdout'), stderrPath: join(dir, 'stderr') };
  fs.writeFileSync(path, JSON.stringify(record));
  fs.writeFileSync(record.stdoutPath, '');
  fs.writeFileSync(record.stderrPath, '');
  const readRecord = () => JSON.parse(fs.readFileSync(path, 'utf8'));
  const child = new EventEmitter();
  child.pid = 4100001;
  cp.spawn = () => child;
  const signals = [];
  process.kill = (pid, signal) => { signals.push([pid, signal]); return true; };
  let listing = child.pid + ' 1 ' + child.pid + ' command-start';
  cp.execFileSync = (command, args) => args[0] === '-o' ? 'runner-start' : listing;
  let snapshot;
  globalThis.setInterval = callback => { snapshot = callback; return { unref() {} }; };
  globalThis.clearInterval = () => {};
  syncBuiltinESMExports();
  process.argv = [process.execPath, modulePath, '--run-record=' + path, '--', 'fake-command'];
  await import(pathToFileURL(modulePath).href);
  assert.equal(child.listenerCount('close'), 1, 'runner must reach command spawn');
`;

describe('runner lifecycle boundaries', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'detached-op-boundary-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('does not publish terminal failure until the command closes', () => {
    expect(boundaryProbe(dir, `${controlledRunner}
      process.emit('SIGTERM');
      assert.ok(signals.some(([pid]) => pid === child.pid), 'command must be signalled');
      // Give a premature promise resolution/publication a chance to run.
      await tick();
      const beforeClose = readRecord();
      child.emit('exit', null, 'SIGKILL');
      await tick();
      const afterExit = readRecord();
      child.emit('close', null, 'SIGKILL');
      await tick();
      console.log(JSON.stringify({ beforeClose, afterExit, afterClose: readRecord() }));
      process.exitCode = 0;
    `)).toMatchObject({
      beforeClose: { status: 'running', exitCode: null },
      afterExit: { status: 'running', exitCode: null },
      afterClose: { status: 'failed', exitCode: 143 },
    });
  });

  it.each([false, true])('does not signal a watched descendant whose start time changed (reused: %s)', reused => {
    const result = boundaryProbe(dir, `${controlledRunner}
      const descendant = 4100002;
      listing += '\\n' + descendant + ' ' + child.pid + ' ' + descendant + ' descendant-start';
      snapshot();
      // At stop, the descendant is orphaned. Its identity changes only at the
      // final sweep, after stopCommand's last snapshot, to exercise that guard.
      let listings = 0;
      cp.execFileSync = (command, args) => {
        if (args[0] === '-o') return 'runner-start';
        if (args.includes('pid=,ppid=,pgid=,lstart=')) listings++;
        return child.pid + ' 1 ' + child.pid + ' command-start\\n'
          + descendant + ' 1 ' + descendant + ' '
          + (${reused} && listings >= 2 ? 'replacement-start' : 'descendant-start');
      };
      syncBuiltinESMExports();
      process.emit('SIGTERM');
      child.emit('close', null, 'SIGKILL');
      await tick();
      console.log(JSON.stringify({ signals, listings, record: readRecord() }));
      process.exitCode = 0;
    `);
    expect(result.listings).toBeGreaterThanOrEqual(2);
    expect(result.signals).toContainEqual([4100001, 'SIGKILL']);
    expect(result.signals.some(([pid]) => Math.abs(pid) === 4100002)).toBe(!reused);
    expect(result.record).toMatchObject({ status: 'failed', exitCode: 143 });
  });

  it('publishes lifecycle records by atomic replacement', () => {
    expect(boundaryProbe(dir, `
      const write = fs.writeFileSync;
      const rename = fs.renameSync;
      const publications = [];
      fs.writeFileSync = (path, data, options) => {
        assert.ok(!String(path).endsWith('.json'), 'never write the destination in place');
        return write(path, data, options);
      };
      fs.renameSync = (tmp, destination) => {
        const next = JSON.parse(fs.readFileSync(tmp, 'utf8'));
        const previous = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, 'utf8')) : null;
        assert.equal(String(tmp).startsWith(destination + '.'), true);
        assert.equal(fs.statSync(tmp).mode & 0o777, 0o600);
        assert.equal(next.status, 'running');
        publications.push({ previous, next });
        rename(tmp, destination);
        assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), next);
      };
      syncBuiltinESMExports();
      const { startDetachedOp } = await import(pathToFileURL(modulePath).href);
      const record = await startDetachedOp({ dir, argv: ['fake-command'],
        now: () => 1767225600000, random: () => 'atomic',
        spawnFn: () => ({ pid: 43210, unref() {} }) });
      console.log(JSON.stringify({ publications, record }));
    `)).toMatchObject({ publications: [
      { previous: null, next: { status: 'running', pid: expect.any(Number) } },
      { previous: { status: 'running', pid: expect.any(Number) }, next: { status: 'running', pid: 43210 } },
    ], record: { pid: 43210 } });
  });

  it.each([0, 23])('publishes runner terminal exit %s by atomic replacement', exitCode => {
    const result = boundaryProbe(dir, `${controlledRunner}
      const write = fs.writeFileSync;
      const rename = fs.renameSync;
      const previous = readRecord();
      let replacements = 0;
      fs.writeFileSync = (destination, data, options) => {
        assert.notEqual(destination, path, 'never overwrite the live lifecycle record');
        const result = write(destination, data, options);
        assert.deepEqual(readRecord(), previous, 'old JSON stays intact after temporary write');
        return result;
      };
      fs.renameSync = (tmp, destination) => {
        assert.equal(destination, path);
        assert.deepEqual(readRecord(), previous);
        const next = JSON.parse(fs.readFileSync(tmp, 'utf8'));
        assert.equal(next.exitCode, ${exitCode});
        assert.equal(next.status, ${JSON.stringify(exitCode === 0 ? 'done' : 'failed')});
        replacements++;
        return rename(tmp, destination);
      };
      syncBuiltinESMExports();
      child.emit('close', ${exitCode});
      await tick();
      console.log(JSON.stringify({ replacements, record: readRecord() }));
      process.exitCode = 0;
    `);
    expect(result).toMatchObject({ replacements: 1,
      record: { status: exitCode === 0 ? 'done' : 'failed', exitCode } });
  });
});

describe('real runner ordinary completion', () => {
  it.each([0, 7, 23])('publishes terminal state and captured output for command exit %s', async exitCode => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'detached-op-completion-'));
    let record;
    try {
      record = await startDetachedOp({ dir, kind: 'completion-test', argv: [process.execPath, '-e',
        `console.log('ordinary stdout'); console.error('ordinary stderr'); process.exit(${exitCode});`] });
      const result = await waitForOp({ id: record.id, dir, maxWaitMs: 5000 });
      const status = exitCode === 0 ? 'done' : 'failed';
      expect(result).toMatchObject({ id: record.id, status, code: exitCode === 0 ? 0 : 1, exitCode,
        stdoutTail: 'ordinary stdout\n', stderrTail: 'ordinary stderr\n' });
      expect(JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8')))
        .toMatchObject({ id: record.id, status, exitCode });
    } finally {
      // Never signal a completed runner's PID, which could already have been reused.
      if (record && JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8')).status === 'running') {
        try { process.kill(record.pid, 'SIGTERM'); } catch {}
        await waitForOp({ id: record.id, dir, maxWaitMs: 1000 });
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
});

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
    const heartbeat = join(dir, 'grandchild.heartbeat');
    const midGone = join(dir, 'mid.gone');
    let record;
    let grandchildPid;
    try {
      const grandchild = keepAliveScript({
        prelude: `
          for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});
          setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(heartbeat)}, '.'), 10);
        `,
        postlude: `require('node:fs').writeFileSync(${JSON.stringify(grandchildReady)}, String(process.pid));`,
      });
      const mid = `
        const { spawn } = require('node:child_process');
        spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: true }).unref();
        setTimeout(() => process.exit(0), ${midLingerMs});
      `;
      const command = keepAliveScript({
        postlude: `
          require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(mid)}], { stdio: 'ignore' })
            .once('exit', () => require('node:fs').writeFileSync(${JSON.stringify(midGone)}, 'reaped'));
        `,
      });
      record = await startDetachedOp({ argv: [process.execPath, '-e', command], kind: 'reparent-test', dir,
        env: { ...process.env, DETACHED_OP_SNAPSHOT_MS: snapshotMs === undefined ? '' : String(snapshotMs) } });
      const readyDeadline = Date.now() + 8000;
      while (!(existsSync(grandchildReady) && existsSync(heartbeat)
        && existsSync(midGone) && readFileSync(midGone, 'utf8') === 'reaped')) {
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
      expect(result).toMatchObject({ status: 'failed', code: 1, exitCode: 143 });
      // kill(pid, 0) also sees unreaped zombies on Linux. Check execution state AND continued work.
      const stoppedAt = readFileSync(heartbeat, 'utf8');
      await delay(150);
      let state = '';
      try {
        state = execFileSync('ps', ['-o', 'stat=', '-p', String(grandchildPid)],
          { encoding: 'utf8', timeout: 1000 }).trim();
      } catch (error) { if (error.status !== 1) throw error; } // ps exits 1 for an absent PID.
      const survivor = Boolean(state && !state.startsWith('Z'));
      expect(readFileSync(heartbeat, 'utf8') !== stoppedAt).toBe(survivor);
      return survivor;
    } finally {
      if (!grandchildPid && existsSync(grandchildReady)) grandchildPid = Number(readFileSync(grandchildReady, 'utf8'));
      if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch {} }
      if (record) { try { process.kill(record.pid, 'SIGKILL'); } catch {} }
      await delay(30);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('leaves no survivor when a detached grandchild was re-parented to PID 1 before SIGTERM', async context => {
    if (!psWorks()) { context.skip(); return; }
    // mid lingers well past one snapshot interval, so the periodic snapshot saw the grandchild.
    expect(await runScenario({ midLingerMs: 1500 })).toBe(false);
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
    const record = writeRecord({ pidStart: 'original-start' });
    const clock = fakeClock();
    const result = await waitForOp({ id: record.id, maxWaitMs: 250, dir, ...clock,
      isAlive: () => true, startOf: () => 'replacement-start' });
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

  it.each([null, undefined])('keeps a live runner running when its recorded start time cannot be re-read (%s)', async unreadable => {
    const record = writeRecord({ pidStart: 'recorded-start' });
    const startOf = vi.fn(() => unreadable);
    const clock = fakeClock();
    expect(await waitForOp({ id: record.id, dir, maxWaitMs: 250, ...clock,
      isAlive: () => true, startOf })).toMatchObject({ status: 'running', code: 75, exitCode: null });
    expect(startOf).toHaveBeenCalledWith(record.pid);
    expect(clock.now()).toBe(250);
    expect(JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8'))).toEqual(record);
  });

  it('rechecks a refreshed runner identity even when the PID is unchanged', async () => {
    const record = writeRecord({ pidStart: 'old-start' });
    const clock = fakeClock();
    const startOf = vi.fn(() => {
      writeRecord({ pidStart: 'new-start' });
      return 'new-start';
    });
    expect(await waitForOp({ id: record.id, dir, maxWaitMs: 250, ...clock,
      isAlive: () => true, startOf }))
      .toMatchObject({ status: 'running', pid: record.pid, pidStart: 'new-start', code: 75 });
    expect(startOf.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(process.platform === 'win32')('processStart reads the same runner start time whatever TZ the reader runs under', context => {
    try { execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { stdio: 'ignore', timeout: 1000 }); }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      context.skip(); return;
    }
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

  it.each([['running', null, 75], ['done', 0, 0], ['failed', 23, 1]])(
    'handleDetachCli --wait-for emits JSON for %s exit %s and returns code %s', async (status, exitCode, code) => {
      const record = writeRecord({ status, exitCode });
      const out = vi.fn();
      const spawnFn = vi.fn();
      const clock = fakeClock();
      expect(await handleDetachCli([`--wait-for=${record.id}`, '--max-wait-ms=250', '--detach'], {
        dir, out, spawnFn, ...clock, isAlive: () => true,
      })).toBe(code);
      expect(out).toHaveBeenCalledOnce();
      expect(JSON.parse(out.mock.calls[0][0])).toMatchObject({ id: record.id, status, exitCode, code,
        stdoutTail: 'stdout from the operation\n', stderrTail: 'stderr from the operation\n' });
      expect(spawnFn).not.toHaveBeenCalled();
      expect(clock.now()).toBe(status === 'running' ? 250 : 0);
    },
  );

  it('handleDetachCli --detach launches scriptPath without --detach and prints the record', async () => {
    const scriptPath = join(dir, 'script with spaces.mjs');
    const rest = ['--task=a=b', 'two words', '`literal`', '--flag'];
    const args = ['--detach', rest[0], '--max-wait-ms=250', ...rest.slice(1), '--detach'];
    const original = [...args];
    const out = vi.fn();
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({ pid: 43210, unref }));
    expect(await handleDetachCli(args, { scriptPath, dir, out, spawnFn, kind: 'cli-test',
      now: () => 1767225600000, random: () => 'cli', env: {} })).toBe(0);
    expect(spawnFn).toHaveBeenCalledOnce();
    const [command, runnerArgs, options] = spawnFn.mock.calls[0];
    const record = JSON.parse(out.mock.calls[0][0]);
    expect(command).toBe(process.execPath);
    expect(runnerArgs).toEqual([resolve('scripts/lib/detached-op.mjs'),
      `--run-record=${join(dir, `${record.id}.json`)}`, '--', process.execPath, scriptPath, ...rest]);
    expect(options).toMatchObject({ detached: true, env: {} });
    expect(out).toHaveBeenCalledOnce();
    expect(record).toMatchObject({ kind: 'cli-test', pid: 43210, status: 'running', exitCode: null });
    expect(JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8'))).toEqual(record);
    expect(args).toEqual(original);
    expect(unref).toHaveBeenCalledOnce();
  });

  it.each(['../x', '../../x', '/abs', '-flag', '', '.', '..', 'a/b', 'a\\b', 'a b', 'a`b', 'a"b',
    'a\nb', 'a\rb', 'a\u2028b', 'ａ', 'a\u200bb'])(
    'rejects hostile job id %j before waitForOp reads any file or startDetachedOp spawns', async id => {
      const spawnFn = vi.fn();
      const isAlive = vi.fn();
      expect(await waitForOp({ id, dir, maxWaitMs: 250, ...fakeClock(), isAlive }))
        .toMatchObject({ id, status: 'failed', code: 1, reason: 'invalid-record' });
      // The starter generates its own id. A hostile clock prefix exercises its
      // recordPath guard; hostile random suffixes are separately sanitized below.
      await expect(startDetachedOp({ dir, argv: ['fake-command'], now: () => id, random: () => 'safe', spawnFn }))
        .rejects.toThrow('invalid job id');
      expect(spawnFn).not.toHaveBeenCalled();
      expect(isAlive).not.toHaveBeenCalled();
      expect(boundaryProbe(dir, `
        const { waitForOp } = await import(pathToFileURL(modulePath).href);
        const reads = [];
        const read = fs.readFileSync;
        fs.readFileSync = (...args) => { reads.push(String(args[0])); return read(...args); };
        syncBuiltinESMExports();
        const result = await waitForOp({ id: ${JSON.stringify(id)}, dir, maxWaitMs: 250 });
        console.log(JSON.stringify({ result, reads }));
      `)).toMatchObject({ result: { reason: 'invalid-record' }, reads: [] });
    },
  );

  it('startDetachedOp sanitizes hostile random suffixes into an allowlisted record id', async () => {
    const record = await startDetachedOp({ dir, argv: ['fake-command'], now: () => 1767225600000,
      random: () => '../a/b\\c\n--flag', spawnFn: () => ({ pid: 43210, unref() {} }) });
    expect(record.id).toBe('1767225600000-abc--flag');
    expect(JSON.parse(readFileSync(join(dir, `${record.id}.json`), 'utf8'))).toEqual(record);
  });
});

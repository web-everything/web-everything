// @vitest-environment node
/**
 * @file scripts/__tests__/run-fresh.test.mjs
 * @description `run-fresh.mjs` — runs an operation from a freshly leased lane at origin/main, refuses when the lane
 *   is not exactly at origin/main, and always releases the lane by its holder slug.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn as spawnChild } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepAliveScript } from '../lib/test-keepalive.mjs';
import { parseAcquire, runFresh, withSignalsDeferred } from '../run-fresh.mjs';

const SHA = 'a'.repeat(40);
const lease = { lane: 7, path: '/lanes/lane-7', holder: 'run-fresh-x-lane-7-abcd' };

function fakeSpawn({ head = SHA, main = SHA, acquireStatus = 0, opStatus = 0, fetchStatus = 0 } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'git') {
      if (args.includes('fetch')) return { status: fetchStatus, stdout: '' };
      if (args.includes('HEAD')) return { status: 0, stdout: `${head}\n` };
      return { status: 0, stdout: `${main}\n` };
    }
    if (args[1] === 'acquire') return { status: acquireStatus, stdout: JSON.stringify(lease) };
    if (args[1] === 'release') return { status: 0 };
    return { status: opStatus };
  };
  return { spawn, calls };
}
const opts = (spawn) => ({
  spawn, root: '/repo', log: () => {},
  spawnOperation: (cmd, args, options) => {
    const result = spawn(cmd, args, options);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', result.status, result.signal));
    return child;
  },
});

describe('run-fresh', () => {
  it.each([
    ['restart-runner'],
    ['restart-runner', '--checkout=/stable', '--supervisor=/stable/supervisor.mjs'],
    ['restart-runner', '--dry-run=true'],
    ['dispatch-lane'],
    ['review-pr'],
    ['future-detached-operation'],
    ['../operations/restart-runner'],
  ])('refuses unaudited operation %s before leasing or starting workers', async (...argv) => {
    const { spawn, calls } = fakeSpawn();
    const messages = [];
    expect(await runFresh(argv, { ...opts(spawn), log: (message) => messages.push(message) })).toBe(1);
    expect(calls).toEqual([]);
    expect(messages.join('\n')).toMatch(/only supports land-human-only.*detached/i);
  });
  it('parses only a complete acquire payload', () => {
    expect(parseAcquire(JSON.stringify(lease))).toEqual(lease);
    expect(parseAcquire('{"lane":7,"path":"/x"}')).toBeNull();
    expect(parseAcquire('/lanes/lane-7')).toBeNull();
  });
  it('runs the operation inside the lane with the terminal passed through, then releases by holder slug', async () => {
    const { spawn, calls } = fakeSpawn({ opStatus: 3 });
    expect(await runFresh(['land-human-only', '--pr=5', '--dry-run=true'], opts(spawn))).toBe(3);
    const op = calls.find((c) => String(c.args[0]).endsWith('run.mjs'));
    expect(op.args).toEqual(['/lanes/lane-7/scripts/operations/run.mjs', 'land-human-only', '--pr=5', '--dry-run=true']);
    expect(op.opts).toMatchObject({ cwd: '/lanes/lane-7', stdio: 'inherit' });
    expect(calls.at(-1).args).toEqual(['/repo/scripts/lane-pool.mjs', 'release', '--lane=7', `--session=${lease.holder}`, '--repo=/repo']);
  });
  it.each([
    ['a lane behind origin/main', { head: 'b'.repeat(40) }],
    ['a failed fetch', { fetchStatus: 1 }],
  ])('refuses %s without running the operation, and still releases', async (_name, over) => {
    const { spawn, calls } = fakeSpawn(over);
    expect(await runFresh(['land-human-only'], opts(spawn))).toBe(1);
    expect(calls.some((c) => String(c.args[0]).endsWith('run.mjs'))).toBe(false);
    expect(calls.at(-1).args[1]).toBe('release');
  });
  it('refuses when no lane can be leased, and when no operation is named', async () => {
    const { spawn, calls } = fakeSpawn({ acquireStatus: 1 });
    expect(await runFresh(['land-human-only'], opts(spawn))).toBe(1);
    expect(calls).toHaveLength(1);
    expect(await runFresh(['--pr=5'], opts(fakeSpawn().spawn))).toBe(1);
  });
  it('holds SIGINT/SIGTERM/SIGHUP listeners only while the run is in flight, so release still happens', async () => {
    const proc = new EventEmitter();
    let during;
    expect(await withSignalsDeferred(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      during = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => proc.listenerCount(s));
      return 4;
    }, { proc })).toBe(4);
    expect(during).toEqual([1, 1, 1]);
    expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => proc.listenerCount(s))).toEqual([0, 0, 0]);
  });
  it('reports a signal-killed operation as 130 and still releases', async () => {
    const { spawn, calls } = fakeSpawn();
    const wrapped = (cmd, args, o) => (String(args?.[0]).endsWith('run.mjs') ? { status: null, signal: 'SIGINT' } : spawn(cmd, args, o));
    expect(await runFresh(['land-human-only'], opts(wrapped))).toBe(130);
    expect(calls.at(-1).args[1]).toBe('release');
  });
  it('releases without starting the operation if cancellation arrives during acquisition', async () => {
    const proc = new EventEmitter();
    const { spawn, calls } = fakeSpawn();
    const wrapped = (cmd, args, options) => {
      const result = spawn(cmd, args, options);
      if (args[1] === 'acquire') proc.emit('SIGTERM');
      return result;
    };
    expect(await runFresh(['land-human-only'], { ...opts(wrapped), proc })).toBe(143);
    expect(calls.some((c) => String(c.args[0]).endsWith('run.mjs'))).toBe(false);
    expect(calls.at(-1).args[1]).toBe('release');
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });
  it('releases and removes signal listeners after an operation spawn error', async () => {
    const proc = new EventEmitter();
    const { spawn, calls } = fakeSpawn();
    const spawnOperation = () => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        child.emit('error', new Error('spawn failed'));
        child.emit('close', -2, null);
      });
      return child;
    };
    expect(await runFresh(['land-human-only'], { ...opts(spawn), spawnOperation, proc })).toBe(1);
    expect(calls.at(-1).args[1]).toBe('release');
    expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => proc.listenerCount(s))).toEqual([0, 0, 0]);
  });
  it.skipIf(process.platform === 'win32').each([
    ['SIGTERM', 143], ['SIGKILL', 137], ['exit', 0],
  ])('retains the lane for surviving descendants when the leader ends independently (%s)', async (ending, expectedCode) => {
    const dir = await mkdtemp(join(tmpdir(), 'run-fresh-leader-'));
    let wrapper;
    let operationPid;
    let watchdog;
    let output = '';
    const stopFixture = () => {
      if (operationPid) {
        try { process.kill(-operationPid, 'SIGKILL'); } catch { /* already stopped */ }
      }
      wrapper?.kill('SIGKILL');
    };
    try {
      await mkdir(join(dir, 'scripts', 'operations'), { recursive: true });
      await writeFile(join(dir, 'scripts', 'operations', 'run.mjs'), `
        import { spawn } from 'node:child_process';
        process.on('SIGUSR1', () => process.exit(0));
        console.log('OPERATION GROUP ' + process.pid);
        spawn(process.execPath, ['-e', ${JSON.stringify(`
          console.log('DESCENDANT READY');
          setTimeout(() => { console.log('DESCENDANT STOPPED'); process.exit(0); }, 500);
        `)}], { stdio: 'inherit' });
      `);
      const runner = join(dir, 'wrapper.mjs');
      await writeFile(runner, `
        import { runFresh } from ${JSON.stringify(new URL('../run-fresh.mjs', import.meta.url).href)};
        const spawn = (cmd, args) => {
          if (cmd === 'git') return { status: 0, stdout: '${SHA}' };
          if (args[1] === 'acquire') return { status: 0, stdout: JSON.stringify({ lane: 7, path: ${JSON.stringify(dir)}, holder: 'probe-holder' }) };
          if (args[1] === 'release') { console.log('LANE RELEASED'); return { status: 0 }; }
          throw new Error('unexpected fixture command');
        };
        process.exitCode = await runFresh(['land-human-only'], { spawn, root: ${JSON.stringify(dir)}, log: () => {} });
      `);
      wrapper = spawnChild(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
      watchdog = setTimeout(stopFixture, 3000);
      const closed = new Promise((resolve, reject) => {
        wrapper.once('error', reject);
        wrapper.once('close', (code, signal) => resolve({ code, signal }));
      });
      let sent = false;
      wrapper.stdout.on('data', (chunk) => {
        output += chunk;
        const group = /OPERATION GROUP (\d+)/.exec(output);
        if (group) operationPid = Number(group[1]);
        if (!sent && operationPid && output.includes('DESCENDANT READY')) {
          sent = true;
          // Target only the leader: the wrapper receives no cancellation signal.
          process.kill(operationPid, ending === 'exit' ? 'SIGUSR1' : ending);
        }
      });
      wrapper.stderr.on('data', (chunk) => { output += chunk; });
      const result = await closed;
      expect(sent).toBe(true);
      expect(result).toEqual({ code: expectedCode, signal: null });
      expect(output).toContain('DESCENDANT STOPPED');
      expect(output).toContain('LANE RELEASED');
      expect(output.indexOf('LANE RELEASED'), output).toBeGreaterThan(output.indexOf('DESCENDANT STOPPED'));
    } finally {
      clearTimeout(watchdog);
      stopFixture();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each([
    ['SIGINT', false, false], ['SIGTERM', false, false], ['SIGHUP', false, false],
    ['SIGTERM', true, false], ['SIGINT', false, true],
  ])('forwards wrapper-only %s (descendant=%s, second signal=%s) and waits before releasing', async (signal, descendant, secondSignal) => {
    const dir = await mkdtemp(join(tmpdir(), 'run-fresh-signal-'));
    let child;
    let operationPid;
    let watchdog;
    let output = '';
    const stopFixture = () => {
      if (operationPid) {
        try { process.kill(process.platform === 'win32' ? operationPid : -operationPid, 'SIGKILL'); } catch { /* already stopped */ }
      }
      child?.kill('SIGKILL');
    };
    try {
      await mkdir(join(dir, 'scripts', 'operations'), { recursive: true });
      const operation = `${keepAliveScript()}
        const continued = setTimeout(() => {
          console.log('OPERATION CONTINUED AFTER SIGNAL');
          process.exit(0);
        }, 500);
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
          clearTimeout(continued);
          console.log('OPERATION RECEIVED ' + signal);
          if (${secondSignal} && signal === 'SIGINT') return;
          setTimeout(() => { console.log('OPERATION STOPPED'); process.exit(0); }, 100);
        });
        console.log('OPERATION READY');
      `;
      const groupMarker = "console.log('OPERATION GROUP ' + process.pid);\n";
      await writeFile(join(dir, 'scripts', 'operations', 'run.mjs'), groupMarker + (descendant ? `
        import { spawn } from 'node:child_process';
        // Like a synchronous write tool, the descendant outlives a signal-killed operation leader.
        spawn(process.execPath, ['-e', ${JSON.stringify(operation)}], { stdio: 'inherit' });
      ` : operation));
      const runner = join(dir, 'wrapper.mjs');
      await writeFile(runner, `
        import { spawnSync } from 'node:child_process';
        import { runFresh } from ${JSON.stringify(new URL('../run-fresh.mjs', import.meta.url).href)};
        const spawn = (cmd, args, opts) => {
          if (cmd === 'git') return { status: 0, stdout: '${SHA}' };
          if (args[1] === 'acquire') return { status: 0, stdout: JSON.stringify({ lane: 7, path: ${JSON.stringify(dir)}, holder: 'probe-holder' }) };
          if (args[1] === 'release') { console.log('LANE RELEASED'); return { status: 0 }; }
          return spawnSync(cmd, args, { ...opts, detached: process.platform !== 'win32' });
        };
        process.exitCode = await runFresh(['land-human-only'], { spawn, root: ${JSON.stringify(dir)}, log: () => {} });
      `);
      child = spawnChild(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
      watchdog = setTimeout(stopFixture, 3000);
      const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { clearTimeout(watchdog); resolve({ code, signal }); });
      });
      let sent = false;
      let sentSecond = false;
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const group = /OPERATION GROUP (\d+)/.exec(output);
        if (group) operationPid = Number(group[1]);
        if (!sent && output.includes('OPERATION READY')) { sent = true; child.kill(signal); }
        if (secondSignal && !sentSecond && output.includes('OPERATION RECEIVED SIGINT')) {
          sentSecond = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const result = await closed;
      expect(sent).toBe(true);
      expect(output).toContain(`OPERATION RECEIVED ${signal}`);
      if (secondSignal) expect(output).toContain('OPERATION RECEIVED SIGTERM');
      expect(output).not.toContain('OPERATION CONTINUED AFTER SIGNAL');
      expect(output).toContain('OPERATION STOPPED');
      expect(output).toContain('LANE RELEASED');
      expect(output.indexOf('LANE RELEASED')).toBeGreaterThan(output.indexOf('OPERATION STOPPED'));
      expect(result).toEqual({ code: { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal], signal: null });
    } finally {
      clearTimeout(watchdog);
      stopFixture();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

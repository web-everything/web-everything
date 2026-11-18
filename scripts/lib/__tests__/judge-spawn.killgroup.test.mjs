import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runInNewContext } from 'node:vm';
import { judgeSpawn, JudgeTimeoutError } from '../judge-spawn.mjs';
import { keepAliveScript } from '../test-keepalive.mjs';

const request = { mandate: 'review', input: 'diff', shape: { type: 'object' }, retries: 0 };

describe('supervisor group-signal fallback', () => {
  const source = readFileSync(resolve('scripts/lib/judge-spawn-supervisor.mjs'), 'utf8')
    .replace("import { spawn } from 'node:child_process';", '');

  it.each(['EPERM', 'EINVAL', undefined, 'ESRCH'])(
    'kills the juror directly before exiting on group failure %s, except ESRCH', (code) => {
      const child = new EventEmitter();
      child.pid = 1234;
      child.stdout = child.stderr = { pipe: vi.fn() };
      const calls = [];
      let deadline;
      const kill = vi.fn((pid, signal) => {
        calls.push(['kill', pid, signal]);
        if (pid < 0) throw Object.assign(new Error('group signal failed'), { code });
      });
      runInNewContext(source, {
        spawn: () => child,
        process: {
          argv: ['node', 'supervisor', '100', String(Date.now() + 1000), 'juror'],
          pid: 5678, kill,
          exit: (status) => calls.push(['exit', status]),
        },
        setTimeout: (callback) => { deadline = callback; },
        setInterval: vi.fn(),
      });
      deadline();
      expect(calls).toEqual(code === 'ESRCH'
        ? [['kill', -5678, 'SIGKILL'], ['exit', 0]]
        : [['kill', -5678, 'SIGKILL'], ['kill', child.pid, 'SIGKILL'], ['exit', 1]]);
    });

  it('exits even when the direct juror kill also fails', () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.stdout = child.stderr = { pipe: vi.fn() };
    const kill = vi.fn(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    const exit = vi.fn();
    let deadline;
    runInNewContext(source, {
      spawn: () => child,
      process: {
        argv: ['node', 'supervisor', '100', String(Date.now() + 1000), 'juror'],
        pid: 5678, kill, exit,
      },
      setTimeout: (callback) => { deadline = callback; },
      setInterval: vi.fn(),
    });
    deadline();
    expect(kill.mock.calls).toEqual([[-5678, 'SIGKILL'], [child.pid, 'SIGKILL']]);
    expect(exit.mock.calls).toEqual([[1]]);
  });
});

it('parent kills the child directly when group signalling fails', async () => {
  const child = new EventEmitter();
  child.pid = 987654321;
  child.kill = vi.fn();
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('group signal denied'), { code: 'EPERM' });
  });
  try {
    await judgeSpawn({ ...request, spawnFn: () => {
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    } }).catch(() => {});
    expect(kill.mock.calls).toEqual([[-child.pid, 'SIGKILL']]);
    expect(child.kill.mock.calls).toEqual([['SIGKILL']]);
  } finally { kill.mockRestore(); }
});

it.each(['close', 'error'])('removes per-spawn process listeners after %s, including repeated spawns', async (event) => {
  const events = ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit'];
  const before = events.map(name => process.listenerCount(name));
  for (let i = 0; i < 3; i++) {
    await judgeSpawn({ ...request, spawnFn: () => {
      const child = new EventEmitter();
      queueMicrotask(() => event === 'error'
        ? child.emit('error', new Error('failed spawn')) : child.emit('close', 0, null));
      return child;
    } }).catch(() => {});
    expect(events.map(name => process.listenerCount(name))).toEqual(before);
  }
});

it.each(['close', 'error'])('kills the group before removing caller hooks on %s settlement', async (event) => {
  const events = ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit'];
  const before = events.map(name => process.listenerCount(name));
  const child = new EventEmitter();
  child.pid = 987654321;
  const observed = [];
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    observed.push(events.map(name => process.listenerCount(name)));
    throw Object.assign(new Error('group already gone'), { code: 'ESRCH' });
  });
  child.kill = vi.fn();
  try {
    await judgeSpawn({ ...request, spawnFn: () => {
      queueMicrotask(() => event === 'error'
        ? child.emit('error', new Error('failed spawn')) : child.emit('close', 0, null));
      return child;
    } }).catch(() => {});
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    expect(observed).toEqual([before.map(n => n + 1)]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(events.map(name => process.listenerCount(name))).toEqual(before);
  } finally { kill.mockRestore(); }
});

// A socket inherited by both descendants proves termination without confusing zombies with live work.
async function withCallerTree(run) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'judge-caller-'));
  const cli = join(dir, 'fake-cli');
  const pidFile = join(dir, 'tree.json');
  let caller;
  let deadline;
  let connection;
  let descendantsClosed;
  const server = createServer();
  try {
    const ready = new Promise(resolve => {
      server.once('connection', socket => {
        connection = socket;
        descendantsClosed = once(socket, 'close');
        socket.on('data', () => resolve());
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const grandchild = keepAliveScript({ anchorPid: process.pid, maxLifetimeMs: 30000 });
    const prelude = `const {spawn}=require('node:child_process');
      const socket=require('node:net').connect(${server.address().port},'127.0.0.1',()=>{
        const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','ignore','ignore',socket]});
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.ppid,process.pid,child.pid]));
        socket.write('tree-ready');
      });`;
    writeFileSync(cli, `#!${process.execPath}\n` + keepAliveScript({
      anchorPid: process.pid, maxLifetimeMs: 30000, prelude,
    }), { mode: 0o755 });
    const source = `import {judgeSpawn} from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/judge-spawn.mjs')).href)};
      process.on('SIGUSR2',()=>process.exit(0));
      await judgeSpawn(${JSON.stringify({ ...request, cli, timeoutMs: 20000 })}).catch(()=>{});`;
    caller = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    caller.stderr.on('data', data => { stderr += data; });
    const exited = once(caller, 'exit');
    const bound = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`caller tree did not terminate within test bound: ${stderr}`)), 8000);
    });
    await Promise.race([ready, bound]);
    await Promise.race([run({ caller, exited, closed: descendantsClosed }), bound]);
  } finally {
    clearTimeout(deadline);
    caller?.kill('SIGKILL');
    try {
      const [group, ...pids] = JSON.parse(readFileSync(pidFile, 'utf8'));
      try { process.kill(-group, 'SIGKILL'); } catch {}
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    } catch {}
    connection?.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

it('falls back to child.kill when the process group cannot be signalled', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
  const child = new EventEmitter();
  child.pid = 987654321;
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); });
  try {
    await expect(judgeSpawn({ ...request, timeoutMs: 5, spawnFn: () => child }))
      .rejects.toBeInstanceOf(JudgeTimeoutError);
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  } finally { kill.mockRestore(); }
});

describe.skipIf(process.platform === 'win32')('real juror process group cleanup', () => {
  it('preserves exact large stdout and stderr with slow readers before killing the supervisor group', async () => {
    const source = `const stdout=JSON.stringify({structured_output:{value:'result-'.repeat(600000)}});
      const stderr='diagnostic-'.repeat(400000)+'diagnostic-end';
      Promise.all([[process.stdout,stdout],[process.stderr,stderr]].map(([stream,text])=>
        new Promise(resolve=>stream.write(text,resolve)))).then(()=>process.exit(0));`;
    const supervisor = spawn(process.execPath, [
      resolve('scripts/lib/judge-spawn-supervisor.mjs'),
      String(process.pid), String(Date.now() + 15000), process.execPath, '-e', source,
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const buffers = { stdout: [], stderr: [] };
    const pending = new Set();
    let timer;
    try {
      const exited = once(supervisor, 'close');
      const reads = ['stdout', 'stderr'].map(name => pipeline(supervisor[name], new Writable({
        highWaterMark: 1,
        write(chunk, encoding, callback) {
          buffers[name].push(chunk);
          // Force sustained backpressure rather than simply delaying the first read.
          const delay = setTimeout(() => { pending.delete(delay); callback(); }, 5);
          pending.add(delay);
        },
      })));
      const [status] = await Promise.race([
        Promise.all([exited, ...reads]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('supervisor output failed to drain within test bound')), 12000);
        }),
      ]);
      expect(status).toEqual([null, 'SIGKILL']);
      expect(Buffer.concat(buffers.stdout).toString()).toBe(JSON.stringify({
        structured_output: { value: 'result-'.repeat(600000) },
      }));
      expect(Buffer.concat(buffers.stderr).toString()).toBe('diagnostic-'.repeat(400000) + 'diagnostic-end');
    } finally {
      clearTimeout(timer);
      for (const delay of pending) clearTimeout(delay);
      try { process.kill(-supervisor.pid, 'SIGKILL'); } catch {}
      supervisor.stdout.destroy();
      supervisor.stderr.destroy();
    }
  }, 20000);

  it.each(['production supervisor', 'direct spawn'])('reaps a successful juror\'s grandchild with ignored stdio within 5 seconds (%s)', async (mode) => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'judge-success-'));
    const cli = join(dir, 'fake-cli');
    const pidFile = join(dir, 'grandchild.pid');
    const server = createServer();
    let connection;
    let closed;
    let timer;
    let group;
    try {
      server.on('connection', socket => {
        connection = socket;
        closed = once(socket, 'close');
        socket.on('data', () => {});
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const grandchild = keepAliveScript({
        anchorPid: process.pid, maxLifetimeMs: 30000,
        postlude: `require('node:net').connect(${server.address().port},'127.0.0.1',function(){
          this.write('ready'); process.send('ready'); process.disconnect();
        });`,
      });
      const result = JSON.stringify({ is_error: false, stop_reason: 'tool_use',
        session_id: 'successful-juror', structured_output: { verdict: 'accept' } });
      writeFileSync(cli, `#!${process.execPath}\n` +
        `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','ignore','ignore','ipc']});\n` +
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));\n` +
        `child.once('message',()=>process.stdout.write(${JSON.stringify(result)},()=>process.exit(0)));\n`,
      { mode: 0o755 });
      const outcome = await judgeSpawn({ ...request, cli, timeoutMs: 15000,
        spawnFn: (command, argv, options) => {
          // Match the production supervisor launch without Vitest's import.meta.url rewrite.
          const child = mode === 'direct spawn' ? spawn(command, argv, options)
            : spawn(process.execPath, [resolve('scripts/lib/judge-spawn-supervisor.mjs'),
              String(process.pid), String(Date.now() + 15000), command, ...argv], options);
          group = child.pid;
          return child;
        },
      }).catch(error => error);
      if (mode === 'production supervisor') {
        expect(outcome).toBeInstanceOf(JudgeTimeoutError);
        expect(JSON.parse(outcome.partialStdout).structured_output).toEqual({ verdict: 'accept' });
      } else {
        expect(outcome.value).toEqual({ verdict: 'accept' });
        expect(outcome.timedOut).toBe(false);
      }
      expect(connection).toBeDefined();
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('grandchild survived successful settlement for 5 seconds')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (group) { try { process.kill(-group, 'SIGKILL'); } catch {} }
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
      connection?.destroy();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25000);

  it('rejects a supervisor deadline kill after a valid verdict with the caller timer disabled', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'judge-deadline-'));
    const cli = join(dir, 'fake-cli');
    const verdict = JSON.stringify({ is_error: false, stop_reason: 'tool_use',
      structured_output: { verdict: 'accept' } });
    let supervisor;
    try {
      writeFileSync(cli, `#!${process.execPath}\n` + keepAliveScript({
        anchorPid: process.pid, maxLifetimeMs: 30000,
        prelude: `process.stdout.write(${JSON.stringify(verdict)});`,
      }), { mode: 0o755 });
      const error = await judgeSpawn({ ...request, cli, timeoutMs: 0,
        spawnFn: (command, argv, options) => {
          supervisor = spawn(process.execPath, [resolve('scripts/lib/judge-spawn-supervisor.mjs'),
            String(process.pid), String(Date.now() + 1200), command, ...argv], options);
          return supervisor;
        },
      }).catch(error => error);
      expect(supervisor.exitCode).toBe(null);
      expect(supervisor.signalCode).toBe('SIGKILL');
      expect(error).toBeInstanceOf(JudgeTimeoutError);
      expect(error.timedOut).toBe(true);
      expect(error.partialStdout).toBe(verdict);
    } finally {
      if (supervisor?.pid) { try { process.kill(-supervisor.pid, 'SIGKILL'); } catch {} }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 5000);

  it.each(['stdout', 'stderr'])('enforces the supervisor deadline after juror exit with inherited %s and caller timeout disabled', async (stream) => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'judge-exited-'));
    const cli = join(dir, 'fake-cli');
    const pidFile = join(dir, 'grandchild.pid');
    let supervisor;
    let exited;
    let closed;
    let timer;
    let output = '';
    const hardDeadline = Date.now() + 1200;
    try {
      const grandchild = keepAliveScript({
        anchorPid: process.pid, maxLifetimeMs: 30000,
        postlude: `process.${stream}.write('grandchild-ready');`,
      });
      writeFileSync(cli, `#!${process.execPath}\n` +
        `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore',${stream === 'stdout' ? "'inherit','ignore'" : "'ignore','inherit'"}]});\n` +
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));\n` +
        'process.exit(7);\n', { mode: 0o755 });
      // Exercise judgeSpawn with no caller timer; shorten only the supervisor's
      // production hard deadline so the real-process regression remains fast.
      const outcome = judgeSpawn({ ...request, cli, timeoutMs: 0, spawnFn: (command, argv, options) => {
        supervisor = spawn(process.execPath, [resolve('scripts/lib/judge-spawn-supervisor.mjs'),
          String(process.pid), String(hardDeadline), command, ...argv], options);
        exited = once(supervisor, 'exit');
        closed = once(supervisor[stream], 'close');
        supervisor[stream].on('data', data => { output += data; });
        return supervisor;
      } }).catch(error => error);
      const bound = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('inherited pipe survived the supervisor deadline')), 3000);
      });
      await Promise.race([Promise.all([outcome, closed, exited]).then(([error, , status]) => {
        expect(error).toBeInstanceOf(JudgeTimeoutError);
        expect(status).toEqual([null, 'SIGKILL']);
        expect(output).toContain('grandchild-ready');
        expect(Date.now()).toBeLessThan(hardDeadline + 1500);
      }), bound]);
    } finally {
      clearTimeout(timer);
      if (supervisor?.pid) { try { process.kill(-supervisor.pid, 'SIGKILL'); } catch {} }
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }, 5000);

  it.each(['deadline', 'normal close'])('supervisor exits on %s without leaving a keepalive behind', async (mode) => {
    const script = mode === 'deadline'
      ? keepAliveScript({ anchorPid: process.pid, maxLifetimeMs: 30000 }) : 'process.exit(7)';
    const supervisor = spawn(process.execPath, [
      resolve('scripts/lib/judge-spawn-supervisor.mjs'),
      String(process.pid), String(Date.now() + 700), process.execPath, '-e', script,
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timer;
    try {
      const result = await Promise.race([
        once(supervisor, 'close'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('supervisor survived')), 3000); }),
      ]);
      expect(result).toEqual([null, 'SIGKILL']);
    } finally {
      clearTimeout(timer);
      try { process.kill(-supervisor.pid, 'SIGKILL'); } catch {}
    }
  }, 5000);

  it.each(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL'])('%s to the caller reaps its juror tree within 5 seconds', async (signal) => {
    await withCallerTree(async ({ caller, exited, closed }) => {
      const started = Date.now();
      caller.kill(signal);
      expect(await exited).toEqual([null, signal]);
      await closed;
      expect(Date.now() - started).toBeLessThan(5000);
    });
  }, 10000);

  it('caller exit reaps the juror tree', async () => {
    // SIGUSR2 is only a test trigger for a normal process.exit, exercising the exit hook.
    await withCallerTree(async ({ caller, exited, closed }) => {
      caller.kill('SIGUSR2');
      expect(await exited).toEqual([0, null]);
      await closed;
    });
  }, 10000);

  it('kills the juror and its running grandchild on timeout', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'judge-group-'));
    const cli = join(dir, 'fake-cli');
    const pidFile = join(dir, 'grandchild.pid');
    let pid;
    let child;
    let descendantsClosed;
    let exited;
    let deadline;
    const spawnFn = (command, argv, options) => {
      expect(options.detached).toBe(true);
      child = spawn(command, argv, { ...options, stdio: [...options.stdio, 'pipe'] });
      descendantsClosed = once(child.stdio[3], 'close');
      exited = once(child, 'exit');
      return child;
    };
    try {
      writeFileSync(cli, `#!${process.execPath}\n` +
        `const {spawn} = require('node:child_process');\n` +
        `const {writeFileSync} = require('node:fs');\n` +
        `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(), 30000)'], {stdio: ['ignore', 'ignore', 'ignore', 3]});\n` + // keepalive-helper-ok: grandchild killed by timeout and finally, with a hard lifetime bound
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
        `setInterval(() => {}, 1000); setTimeout(() => process.exit(), 30000);\n`, // keepalive-helper-ok: fake juror killed by timeout and finally, with a hard lifetime bound
        { mode: 0o755 });
      const outcome = await judgeSpawn({ ...request, cli, spawnFn, timeoutMs: 1500, log: () => {} }).catch(e => e);
      pid = Number(readFileSync(pidFile, 'utf8'));
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(outcome).toBeInstanceOf(JudgeTimeoutError);
      expect(await exited).toEqual([null, 'SIGKILL']);
      // Both processes inherit fd 3. Its closure proves the grandchild died too,
      // without mistaking an unreaped zombie for a still-running process.
      await Promise.race([
        descendantsClosed,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('grandchild survived the timeout')), 2000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      if (!pid) { try { pid = Number(readFileSync(pidFile, 'utf8')); } catch {} }
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
});

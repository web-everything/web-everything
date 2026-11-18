import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { judgeSpawn, JudgeTimeoutError } from '../judge-spawn.mjs';
import { keepAliveScript } from '../test-keepalive.mjs';

const request = { mandate: 'review', input: 'diff', shape: { type: 'object' }, retries: 0 };

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
      expect(result).toEqual(mode === 'deadline' ? [null, 'SIGKILL'] : [7, null]);
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

import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { execRead } from '../proc-read.mjs';
import { spawnKeepAlive } from '../test-keepalive.mjs';
import { laneLeaseLockPath } from '../lane-lease-lock.mjs';
import { startLaneLeaseHeartbeat, renewLaneLeaseOnce } from '../lane-lease-heartbeat.mjs';
const fixture = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'heartbeat-security-'));
  const dir = join(cwd, '.git'); mkdirSync(dir);
  const lease = { session: 'me', acquiredAt: new Date().toISOString(), ttlMinutes: 1 };
  const file = join(dir, '.lane-lease');
  writeFileSync(file, JSON.stringify(lease));
  return { cwd, dir, file, lease, owner: `me||${lease.acquiredAt}` };
};
it('requires both an explicit owner and caller before any renewal', () => {
  const f = fixture();
  try {
    for (const identity of [{}, { owner: f.owner }, { caller: { session: 'me' } }, { owner: f.owner, caller: {} }]) {
      expect(renewLaneLeaseOnce({ cwd: f.cwd, ...identity })).toBe(false);
      expect(JSON.parse(readFileSync(f.file)).renewedAt).toBeUndefined();
    }
  } finally { rmSync(f.cwd, { recursive: true, force: true }); }
});
it('conflicting workerSession overrides even a matching holder token', () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ ...f.lease, workerSession: 'other' }));
    expect(() => startLaneLeaseHeartbeat({ cwds: [f.cwd], callerSession: 'me', callerHolder: 'me' })).toThrow(/ownership/i);
  } finally { rmSync(f.cwd, { recursive: true, force: true }); }
});
it('refuses an ambiguous ownerSession shared by sibling leases', () => {
  const root = mkdtempSync(join(tmpdir(), 'heartbeat-siblings-'));
  try {
    const cwds = [1, 2].map(n => join(root, `lane-${n}`));
    for (const cwd of cwds) {
      mkdirSync(join(cwd, '.git'), { recursive: true });
      writeFileSync(join(cwd, '.git', '.lane-lease'), JSON.stringify({ session: cwd, ownerSession: 'me', acquiredAt: new Date().toISOString(), ttlMinutes: 1 }));
    }
    expect(() => startLaneLeaseHeartbeat({ cwds: [cwds[0]], callerSession: 'me' })).toThrow(/ownership/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it.each(['gone', 'unreadable', 'expired', 'replaced', 'busy'])('calls onLost promptly when renewal is %s', kind => {
  const f = fixture(); let tick; const onLost = vi.fn();
  const stop = startLaneLeaseHeartbeat({ cwds: [f.cwd], callerSession: 'me', onLost,
    setIntervalFn: fn => { tick = fn; return {}; }, clearIntervalFn: () => {} });
  try {
    if (kind === 'gone') rmSync(f.file);
    if (kind === 'unreadable') writeFileSync(f.file, '{');
    if (kind === 'expired') writeFileSync(f.file, JSON.stringify({ ...f.lease, acquiredAt: new Date(0).toISOString() }));
    if (kind === 'replaced') writeFileSync(f.file, JSON.stringify({ ...f.lease, workerSession: 'other' }));
    if (kind === 'busy') mkdirSync(laneLeaseLockPath(f.file));
    tick(); tick(); tick(); tick();
    expect(onLost).toHaveBeenCalledTimes(1);
  } finally { stop(); rmSync(laneLeaseLockPath(f.file), { recursive: true, force: true }); rmSync(f.cwd, { recursive: true, force: true }); }
});
it('renews a short lease while the parent event loop is synchronously blocked', () => {
  const f = fixture();
  const module = pathToFileURL(resolve('scripts/lib/lane-lease-heartbeat.mjs')).href;
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { startLaneLeaseHeartbeat } from ${JSON.stringify(module)};
      import { readFileSync, writeFileSync } from 'node:fs';
      const file = process.argv[2];
      const lease = JSON.parse(readFileSync(file)); lease.acquiredAt = new Date().toISOString(); lease.ttlMinutes = 0.05;
      writeFileSync(file, JSON.stringify(lease));
      const stop = startLaneLeaseHeartbeat({ cwds: [process.argv[1]], callerSession: 'me', everyMs: 200 });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4500);
      stop();
      const renewed = JSON.parse(readFileSync(file));
      if (Date.now() - Date.parse(renewed.renewedAt) > 1500) process.exitCode = 1;
    `, f.cwd, f.file], { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 });
    expect(r.status, r.stderr).toBe(0);
  } finally { rmSync(f.cwd, { recursive: true, force: true }); }
}, 15000);

it('loss during a synchronous gate terminates the parent and escalates a resistant worker group', async () => {
  const f = fixture();
  const module = pathToFileURL(resolve('scripts/codex-direct-task.mjs')).href;
  const termFile = join(f.cwd, 'worker-term');
  // The test owns/reaps the worker: kill(pid, 0) alone cannot distinguish an orphan zombie.
  const worker = spawnKeepAlive({ detached: true, stdio: ['ignore', 'pipe', 'ignore'], maxLifetimeMs: 20000,
    prelude: `process.on('SIGTERM', () => require('node:fs').writeFileSync(${JSON.stringify(termFile)}, 'term'));`,
    postlude: "process.stdout.write('ready');" });
  const exited = new Promise(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })));
  let timer;
  try {
    await new Promise(resolve => worker.stdout.once('data', resolve));
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { withLaneLeaseHeartbeat } from ${JSON.stringify(module)};
      import { rmSync } from 'node:fs';
      await withLaneLeaseHeartbeat([process.argv[1]], async () => {
        process.emit('lane-lease-worker-started', Number(process.argv[3]));
        rmSync(process.argv[2]);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
      });
    `, f.cwd, f.file, String(worker.pid)], { encoding: 'utf8', timeout: 12000, maxBuffer: 4096,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'me', LANE_SESSION: '' } });
    expect(r.error).toBeUndefined();
    expect(r.status).not.toBe(0);
    expect(['SIGTERM', 'SIGKILL']).toContain(r.signal);
    expect(readFileSync(termFile, 'utf8')).toBe('term');
    const result = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('worker survived lease loss')), 2000);
    })]);
    expect(result.signal).toBe('SIGKILL');
  } finally {
    clearTimeout(timer);
    try { process.kill(-worker.pid, 'SIGKILL'); } catch {}
    rmSync(f.cwd, { recursive: true, force: true });
  }
}, 15000);

it('refuses unreadable startup evidence even when existsSync reports false', () => {
  const f = fixture();
  try {
    const fs = { existsSync: () => false, readFileSync: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } };
    expect(() => startLaneLeaseHeartbeat({ cwds: [f.cwd], callerSession: 'me', fs })).toThrow(/ownership/);
  } finally { rmSync(f.cwd, { recursive: true, force: true }); }
});

it('parent exit on loss notification cannot cancel resistant worker SIGKILL escalation', async () => {
  const f = fixture();
  const fifo = join(f.cwd, 'parent-exited');
  const termFile = join(f.cwd, 'worker-term');
  const signalErrorFile = join(f.cwd, 'parent-signal-error');
  execRead('mkfifo', [fifo], { timeout: 5000, maxBuffer: 1024 * 1024 });
  const worker = spawnKeepAlive({ detached: true, stdio: ['ignore', 'pipe', 'ignore'], maxLifetimeMs: 20000,
    prelude: `process.on('SIGTERM', () => require('node:fs').writeFileSync(${JSON.stringify(termFile)}, 'term'));`,
    postlude: "process.stdout.write('ready');" });
  const workerExited = new Promise(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })));
  let parent, guardianPid, timer;
  try {
    await new Promise(resolve => worker.stdout.once('data', resolve));
    // Hold the guardian immediately after sending loss until the test has reaped its parent.
    // This forces the real parent signal to throw ESRCH, without relying on scheduling luck.
    const preload = `import { readFileSync, writeFileSync } from 'node:fs';
      const send = process.send.bind(process), kill = process.kill.bind(process);
      const { parentPid } = JSON.parse(process.argv[2]);
      process.send = (message, ...args) => {
        const result = send(message, ...args);
        if (message === 'lost') readFileSync(${JSON.stringify(fifo)});
        return result;
      };
      process.kill = (pid, signal) => {
        try { return kill(pid, signal); } catch (error) {
          if (pid === parentPid && signal === 'SIGTERM') writeFileSync(${JSON.stringify(signalErrorFile)}, error.code);
          throw error;
        }
      };`;
    const config = { targets: [{ cwd: f.cwd, owner: f.owner }], caller: { session: 'me' }, period: 50 };
    parent = spawn(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      import { rmSync } from 'node:fs';
      const guardian = spawn(process.execPath, ['--import', ${JSON.stringify('data:text/javascript,' + encodeURIComponent(preload))},
        ${JSON.stringify(resolve('scripts/lib/lane-lease-heartbeat-child.mjs'))},
        JSON.stringify({ ...${JSON.stringify(config)}, parentPid: process.pid })], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      process.send({ guardianPid: guardian.pid });
      guardian.on('message', message => {
        if (message === 'ready') { guardian.send({ workers: [${worker.pid}] }); rmSync(${JSON.stringify(f.file)}); }
        if (message === 'lost') process.exit(23);
      });
      setTimeout(() => process.exit(99), 8000);
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    parent.on('message', message => { guardianPid = message.guardianPid; });
    const parentResult = await new Promise((resolve, reject) => {
      parent.once('error', reject);
      parent.once('exit', (code, signal) => resolve({ code, signal }));
    });
    expect(parentResult).toEqual({ code: 23, signal: null });
    writeFileSync(fifo, 'parent reaped');
    const result = await Promise.race([workerExited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('worker survived parent exit during lease loss')), 4000);
    })]);
    expect(readFileSync(signalErrorFile, 'utf8')).toBe('ESRCH');
    expect(readFileSync(termFile, 'utf8')).toBe('term');
    expect(result.signal).toBe('SIGKILL');
  } finally {
    clearTimeout(timer);
    parent?.kill('SIGKILL');
    if (guardianPid) { try { process.kill(guardianPid, 'SIGKILL'); } catch {} }
    try { process.kill(-worker.pid, 'SIGKILL'); } catch {}
    rmSync(f.cwd, { recursive: true, force: true });
  }
}, 15000);

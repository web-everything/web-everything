// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getThisHost } from '../../lib/daemon-host-guard.mjs';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';
import { pidIdentity } from '../../lib/pid-alive.mjs';
import {
  parseGateArgs, daemonIdentity, runGate, isEntrypoint, POLL_MS,
} from '../daemon-host-gate.mjs';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';

function fakeChild() {
  const child = new EventEmitter();
  child.kills = [];
  child.kill = (sig) => { child.kills.push(sig); return true; };
  return child;
}

function harness({ owners, self = HOST_A }) {
  const logs = [];
  const sleeps = [];
  const spawns = [];
  const children = [];
  const procSignals = new EventEmitter();
  let i = 0;
  const files = new Map();
  const directories = new Set();
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const deps = {
    markerPath: 'state/daemon-cleanup.json',
    markerFs: {
      mkdirSync(path, options) {
        if (!options?.recursive && directories.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        directories.add(path);
      },
      rmdirSync(path) { if (!directories.delete(path)) throw missing(); },
      readFileSync(path) { if (!files.has(path)) throw missing(); return files.get(path); },
      writeFileSync(path, value, options) {
        if (options?.flag === 'wx' && files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        files.set(path, value);
      },
      unlinkSync(path) { if (!files.delete(path)) throw missing(); },
    },
    thisHost: self,
    log: (line) => logs.push(line),
    sleep: async (ms) => { sleeps.push(ms); },
    source: { readOwner: async () => {
      const value = owners[Math.min(i, owners.length - 1)];
      i += 1;
      if (value instanceof Error) throw value;
      return value;
    } },
    spawn: (cmd, args, opts) => {
      const child = fakeChild();
      child.pid = 1000 + children.length;
      spawns.push({ cmd, args, opts });
      children.push(child);
      return child;
    },
    killGroup: (pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return children.find((child) => child.pid === pid).kill(signal);
    },
    processSignals: procSignals,
    watchSleep: () => new Promise(() => {}),
    maxPolls: 50,
  };
  return { deps, logs, sleeps, spawns, children, procSignals, files, polls: () => i };
}

describe('parseGateArgs', () => {
  it('takes argv after --', () => {
    expect(parseGateArgs(['--', '/bin/sh', '-c', 'echo hi'])).toEqual({ cmd: '/bin/sh', args: ['-c', 'echo hi'] });
  });
  it('refuses a missing command (fail closed)', () => {
    expect(parseGateArgs([])).toBeNull();
    expect(parseGateArgs(['--'])).toBeNull();
    expect(parseGateArgs(['/bin/sh'])).toBeNull();
  });
});

describe('runGate', () => {
  it('owner=self execs the command with argv passthrough and inherited stdio', async () => {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    const run = runGate({ cmd: '/bin/sh', args: ['-c', 'x y'] }, h.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].cmd).toBe('/bin/sh');
    expect(h.spawns[0].args).toEqual(['-c', 'x y']);
    expect(h.spawns[0].opts.stdio).toBe('inherit');
    expect(h.spawns[0].opts.detached).toBe(true);
    h.children[0].emit('exit', 0, null);
    expect(await run).toBe(0);
  });

  it('owner=other stays in standby: never spawns across many polls, polls no faster than 60 s', async () => {
    const h = harness({ owners: [{ host: HOST_B, version: 'file' }] });
    h.deps.maxPolls = 20;
    const code = await runGate({ cmd: 'x', args: [] }, h.deps);
    expect(h.spawns).toHaveLength(0);
    expect(code).toBe(75);
    expect(h.sleeps.length).toBeGreaterThan(5);
    expect(h.sleeps.every((ms) => ms >= 60_000)).toBe(true);
    expect(POLL_MS).toBeGreaterThanOrEqual(60_000);
    expect(h.logs[0]).toBe(`host-gate: standby owner=other self=${HOST_A}`);
  });

  it('owner unset stays in standby', async () => {
    const h = harness({ owners: [{ host: '', version: 'unset' }] });
    h.deps.maxPolls = 5;
    await runGate({ cmd: 'x', args: [] }, h.deps);
    expect(h.spawns).toHaveLength(0);
    expect(h.logs[0]).toContain(`standby owner=unset self=${HOST_A}`);
  });

  it('read error, thrown read and garbage results stay in standby (fail closed)', async () => {
    const h = harness({ owners: [
      new Error('rate limited'), new Error('boom'), null, { host: 'bad host!', version: 'file' }, {},
    ] });
    h.deps.maxPolls = 5;
    await runGate({ cmd: 'x', args: [] }, h.deps);
    expect(h.spawns).toHaveLength(0);
    expect(h.logs[0]).toContain(`standby owner=unreadable self=${HOST_A}`);
  });

  it('fails closed when getThisHost returns an empty identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-gate-no-id-'));
    try {
      const self = getThisHost({ home: dir, create: false });
      expect(self).toBe('');
      const h = harness({ owners: [{ host: HOST_A, version: 'file' }], self });
      h.deps.maxPolls = 3;
      expect(await runGate({ cmd: 'x', args: [] }, h.deps)).toBe(75);
      expect(h.spawns).toHaveLength(0);
      expect(h.polls()).toBe(0);
      expect(h.logs).toEqual(Array(3).fill('host-gate: standby owner=unreadable self='));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails closed when the source throws on every fresh read', async () => {
    const h = harness({ owners: [new Error('unavailable')] });
    h.deps.maxPolls = 3;
    expect(await runGate({ cmd: 'x', args: [] }, h.deps)).toBe(75);
    expect(h.spawns).toHaveLength(0);
    expect(h.polls()).toBe(3);
    expect(h.logs.every((line) => line.includes('owner=unreadable'))).toBe(true);
  });

  it('fails closed when the source times out', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ owners: [] });
      let reads = 0;
      h.deps.source.readOwner = () => { reads += 1; return new Promise(() => {}); };
      h.deps.maxPolls = 1;
      const run = runGate({ cmd: 'x', args: [] }, h.deps);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await run).toBe(75);
      expect(reads).toBe(1);
      expect(h.spawns).toHaveLength(0);
      expect(h.logs[0]).toContain('owner=unreadable');
    } finally { vi.useRealTimers(); }
  });

  it('flips to self then execs', async () => {
    const h = harness({ owners: [
      { host: HOST_B, version: 'file' }, { host: HOST_B, version: 'file' }, { host: HOST_A, version: 'file' },
    ] });
    const run = runGate({ cmd: 'd', args: ['--flag'] }, h.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.logs.filter((l) => l.includes('standby'))).toHaveLength(2);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].args).toEqual(['--flag']);
    h.children[0].emit('exit', 0, null);
    await run;
  });

  it('forwards the exit code', async () => {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await new Promise((r) => setTimeout(r, 5));
    h.children[0].emit('exit', 7, null);
    expect(await run).toBe(7);
  });

  it('maps a child killed by signal to 128+n', async () => {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await new Promise((r) => setTimeout(r, 5));
    h.children[0].emit('exit', null, 'SIGTERM');
    expect(await run).toBe(143);
  });

  it('forwards SIGTERM/SIGINT/SIGHUP to the child and removes listeners afterwards', async () => {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await new Promise((r) => setTimeout(r, 5));
    h.procSignals.emit('SIGTERM');
    h.procSignals.emit('SIGINT');
    h.procSignals.emit('SIGHUP');
    expect(h.children[0].kills).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP']);
    h.children[0].emit('exit', 0, null);
    await run;
    expect(h.procSignals.listenerCount('SIGTERM')).toBe(0);
    expect(h.procSignals.listenerCount('SIGINT')).toBe(0);
    expect(h.procSignals.listenerCount('SIGHUP')).toBe(0);
    expect(h.procSignals.listenerCount('exit')).toBe(0);
  });

  it('spawn failure exits 127 without looping', async () => {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    h.deps.spawn = () => {
      const c = fakeChild();
      setImmediate(() => c.emit('error', new Error('ENOENT')));
      return c;
    };
    expect(await runGate({ cmd: 'nope', args: [] }, h.deps)).toBe(127);
  });
});

describe('wrapper shutdown', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  it.each([HOST_A, HOST_B])('does not spawn or sleep after shutdown during an owner read (%s)', async (owner) => {
    const h = harness({ owners: [] });
    h.deps.source.readOwner = async () => {
      h.procSignals.emit('SIGTERM');
      return { host: owner, version: 'file' };
    };
    expect(await runGate({ cmd: 'd', args: [] }, h.deps)).toBe(143);
    expect(h.spawns).toHaveLength(0);
    expect(h.sleeps).toHaveLength(0);
    expect(h.procSignals.eventNames()).toEqual([]);
  });

  it('interrupts standby sleep on shutdown and removes signal listeners', async () => {
    const h = harness({ owners: [{ host: '', version: 'unset' }] });
    h.deps.sleep = (ms, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await tick();
    h.procSignals.emit('SIGINT');
    expect(await run).toBe(130);
    expect(h.spawns).toHaveLength(0);
    expect(h.polls()).toBe(1);
    expect(h.procSignals.eventNames()).toEqual([]);
  });

  async function running() {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    const waits = [];
    h.deps.killGraceMs = 123;
    h.deps.sleep = (ms, { signal }) => new Promise((resolve, reject) => {
      waits.push({ ms, signal, resolve });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    let settled = false;
    const run = runGate({ cmd: 'd', args: [] }, h.deps).then((code) => {
      settled = true;
      return code;
    });
    await tick();
    return { h, waits, run, settled: () => settled };
  }

  it('SIGKILLs a child ignoring SIGTERM after one grace wait and awaits its exit', async () => {
    const { h, waits, run, settled } = await running();
    h.procSignals.emit('SIGTERM');
    expect(h.children[0].kills).toEqual(['SIGTERM']);
    expect(waits).toHaveLength(1);
    expect(waits[0].ms).toBe(123);
    h.procSignals.emit('SIGTERM');
    h.procSignals.emit('SIGHUP');
    expect(waits).toHaveLength(1);
    expect(settled()).toBe(false);
    waits[0].resolve();
    await tick();
    expect(h.children[0].kills).toEqual(['SIGTERM', 'SIGTERM', 'SIGHUP', 'SIGKILL']);
    expect(settled()).toBe(false);
    h.children[0].emit('exit', null, 'SIGKILL');
    expect(await run).toBe(137);
  });

  it('kills remaining group members and cancels the grace timer when the leader exits during grace', async () => {
    const { h, waits, run } = await running();
    h.procSignals.emit('SIGINT');
    expect(waits[0].signal.aborted).toBe(false);
    h.children[0].emit('exit', null, 'SIGINT');
    expect(await run).toBe(130);
    expect(waits[0].signal.aborted).toBe(true);
    expect(h.children[0].kills).toEqual(['SIGINT', 'SIGKILL']);
    h.procSignals.emit('exit', 130);
    expect(h.children[0].kills).toEqual(['SIGINT', 'SIGKILL']);
  });

  it('synchronously SIGKILLs a live child on wrapper exit and still awaits child exit', async () => {
    const { h, waits, run, settled } = await running();
    h.procSignals.emit('exit', 1);
    expect(h.children[0].kills).toEqual(['SIGKILL']);
    expect(waits).toHaveLength(0);
    expect(settled()).toBe(false);
    h.children[0].emit('exit', null, 'SIGKILL');
    expect(await run).toBe(137);
    expect(h.procSignals.listenerCount('exit')).toBe(0);
  });

  it('does not resolve on an error from a live child before its exit', async () => {
    const { h, waits, run, settled } = await running();
    h.children[0].pid = 1234;
    h.procSignals.emit('SIGTERM');
    h.children[0].emit('error', new Error('signal failed'));
    await tick();
    expect(settled()).toBe(false);
    expect(waits[0].signal.aborted).toBe(false);
    waits[0].resolve();
    await tick();
    expect(h.children[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
    h.children[0].emit('exit', null, 'SIGKILL');
    expect(await run).toBe(137);
  });

  it('accepts an already absent process group on leader exit', async () => {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    h.deps.killGroup = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await tick();
    h.children[0].emit('exit', 0, null);
    expect(await run).toBe(0);
    expect(h.procSignals.eventNames()).toEqual([]);
  });

  it('does not report completion when process-group cleanup is denied', async () => {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    const signal = h.deps.killGroup;
    let deny = true;
    h.deps.killGroup = (...args) => {
      if (deny) throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      signal(...args);
    };
    let settled = false;
    const run = runGate({ cmd: 'd', args: [] }, h.deps).then((code) => { settled = true; return code; });
    await tick();
    expect(() => h.children[0].emit('exit', 0, null)).toThrow('not permitted');
    await tick();
    expect(settled).toBe(false);
    deny = false;
    h.children[0].emit('exit', 0, null);
    expect(await run).toBe(0);
  });
});

describe('completed command is never re-run after a failed ownership read', () => {
  it.each([0, 3])('reports recorded exit code %i when the command ends while the post-run read fails', async (exitCode) => {
    const h = harness({ owners: [{ host: HOST_A, version: 'v' }] });
    const ticks = [];
    h.deps.watchSleep = () => new Promise((r) => ticks.push(r));
    let reads = 0;
    h.deps.source = { readOwner: async () => {
      reads += 1;
      if (reads === 1) return { host: HOST_A, version: 'v' };
      // The command completes while this ownership read is in flight, then the read fails.
      h.children[0].emit('exit', exitCode, null);
      throw new Error('offline');
    } };
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await new Promise(setImmediate);
    expect(h.spawns).toHaveLength(1);
    ticks[0]();
    expect(await run).toBe(exitCode);
    expect(h.spawns).toHaveLength(1);
  });
});

describe('cleanup state is keyed by daemon identity', () => {
  it('distinct pass roles both read ownership while their standby locks coexist', async () => {
    const first = harness({ owners: [{ host: HOST_B, version: 'file' }] });
    const second = harness({ owners: [{ host: HOST_B, version: 'file' }] });
    delete first.deps.markerPath;
    delete second.deps.markerPath;
    second.deps.markerFs = first.deps.markerFs;
    first.deps.maxPolls = second.deps.maxPolls = 1;
    let release;
    first.deps.sleep = () => new Promise((resolve) => { release = resolve; });
    const run = runGate(parseGateArgs(['--', 'node', 'pass-daemon.mjs', '--pass=a']), first.deps);
    await new Promise(setImmediate);
    let code;
    try {
      code = await runGate(parseGateArgs(['--', 'node', 'pass-daemon.mjs', '--pass=b']), second.deps);
    } finally { release(); await run; }
    expect(code).toBe(75);
    expect([first.polls(), second.polls()]).toEqual([1, 1]);
    expect(second.logs.join('\n')).not.toContain('cleanup lock');
  });

  it.each([
    ['--import', '/checkout/setup.mjs'], ['-r', '/checkout/setup.cjs'],
    ['--require=/checkout/setup.cjs'], ['--loader', '/checkout/setup.mjs'],
    ['--experimental-loader', '/checkout/setup.mjs'],
  ])('preload %j preserves an unconfirmed-live marker across restart', async (...options) => {
    const owners = [{ host: HOST_A, version: 'file' }];
    const first = harness({ owners });
    delete first.deps.markerPath;
    first.deps.killGroup = () => true;
    const run = runGate({ cmd: 'node', args: ['/checkout/scripts/d.mjs'] }, first.deps);
    await new Promise(setImmediate);
    first.children[0].emit('exit', 0, null);
    expect(await run).toBe(1);
    const saved = [...first.files.entries()];
    const second = harness({ owners });
    delete second.deps.markerPath;
    second.deps.markerFs = first.deps.markerFs;
    second.deps.killGroup = vi.fn(() => true);
    const spawn = second.deps.spawn;
    second.deps.spawn = (...args) => {
      const child = spawn(...args);
      setImmediate(() => child.emit('exit', 0, null));
      return child;
    };
    expect(await runGate({ cmd: 'node', args: [...options, '/checkout/scripts/d.mjs'] }, second.deps)).toBe(1);
    expect(second.spawns).toHaveLength(0);
    expect(second.polls()).toBe(0);
    expect(second.deps.killGroup).toHaveBeenCalledWith(1000, 0);
    expect([...first.files.entries()]).toEqual(saved);
  });

  it('a preload without old evidence starts with the script identity d.mjs', async () => {
    const parsed = parseGateArgs(['--', 'node', '--import', 'setup.mjs', 'd.mjs']);
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    delete h.deps.markerPath;
    const run = runGate(parsed, h.deps);
    await new Promise(setImmediate);
    h.children[0].emit('exit', 0, null);
    expect(await run).toBe(0);
    expect(h.spawns[0].args).toEqual(parsed.args);
    expect(daemonIdentity(parsed)).toBe('d.mjs');
  });

  it.each([
    [], ['--import'], ['--import', 'setup.mjs'], ['--require', '--no-warnings', 'd.mjs'],
    ['--unknown-option', 'setup.mjs', 'd.mjs'], ['--eval', 'setup.mjs', 'd.mjs'],
    ['--print=setup.mjs', 'd.mjs'], ['--'], ['-'],
  ])('unparseable Node argv %j refuses with exit 1 before ownership or spawn', async (...args) => {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    delete h.deps.markerPath;
    const spawn = h.deps.spawn;
    h.deps.spawn = (...values) => {
      const child = spawn(...values);
      setImmediate(() => child.emit('exit', 0, null));
      return child;
    };
    expect(await runGate({ cmd: 'node', args }, h.deps)).toBe(1);
    expect(h.polls()).toBe(0);
    expect(h.spawns).toHaveLength(0);
    expect(h.files.size).toBe(0);
  });

  it('parses Node operands and role arguments without treating later script arguments as Node options', () => {
    expect(daemonIdentity({ cmd: '/usr/bin/node', args: [
      '--no-warnings', '--experimental-default-type', 'module', '--import=setup.mjs',
      '--require', 'setup.cjs', '--stack-trace-limit', '50', '--', 'pass-daemon.mjs', '--pass=a',
    ] })).toBe('pass-daemon.mjs#a');
    expect(daemonIdentity({ cmd: 'node', args: ['d.mjs', '--daemon=worker'] })).toBe('d.mjs#worker');
    expect(daemonIdentity({ cmd: 'node', args: ['d.mjs', '--import', 'app.mjs'] })).toBe('d.mjs');
    expect(daemonIdentity({ cmd: 'node', args: ['worker', 'data.mjs'] })).toBe('worker');
    expect(daemonIdentity({ cmd: 'node', args: ['d.mjs', '--pass=a#b'] }))
      .not.toBe(daemonIdentity({ cmd: 'node', args: ['d.mjs', '--pass=a', '--daemon=b'] }));
    expect(daemonIdentity({ cmd: 'node', args: ['d.mjs', '--pass=a'], daemon: 'explicit' })).toBe('explicit');
  });

  it('derives one identity from the daemon script, not its checkout path or flags', () => {
    expect(daemonIdentity({ cmd: 'node', args: ['/a/checkout/scripts/d.mjs', '--x'] }))
      .toBe(daemonIdentity({ cmd: 'node', args: ['/b/other/scripts/d.mjs', '--y', '1'] }));
    expect(daemonIdentity({ cmd: 'node', args: ['d.mjs'] })).not.toBe(daemonIdentity({ cmd: 'node', args: ['e.mjs'] }));
    expect(daemonIdentity({ cmd: 'node', args: ['d.mjs'], daemon: 'role-x' })).toBe('role-x');
    expect(parseGateArgs(['--daemon=role-x', '--', 'node', 'd.mjs']).daemon).toBe('role-x');
  });

  it('same daemon from a different checkout or flag is blocked by the previous group before any new spawn', async () => {
    const owners = [{ host: HOST_A, version: 'file' }];
    const first = harness({ owners });
    const second = harness({ owners });
    delete first.deps.markerPath;
    delete second.deps.markerPath;
    second.deps.markerFs = first.deps.markerFs;
    const run = runGate({ cmd: 'node', args: ['/a/checkout/scripts/d.mjs', '--x'] }, first.deps);
    await new Promise(setImmediate);
    expect(first.spawns).toHaveLength(1);
    const blocked = await runGate({ cmd: 'node', args: ['/b/other/scripts/d.mjs', '--y'] }, second.deps);
    expect(blocked).toBe(1);
    expect(second.spawns).toHaveLength(0);
    expect(second.logs.join('\n')).toContain('refusing to spawn');
    first.children[0].emit('exit', 0, null);
    expect(await run).toBe(0);
  });
});

describe('persistent cleanup marker', () => {
  it('permits exactly one spawn when wrappers overlap between stale-group probe and marker unlink', async () => {
    const owners = [{ host: HOST_A, version: 'file' }];
    const first = harness({ owners });
    const second = harness({ owners });
    second.deps.markerFs = first.deps.markerFs;
    first.files.set(first.deps.markerPath, '{"pgid":999,"time":1}');
    const parsed = { cmd: 'd', args: [] };
    let competing;
    const killGroup = first.deps.killGroup;
    first.deps.killGroup = (pid, signal) => {
      if (pid === 999 && signal === 0) {
        // Both wrappers would consume the same stale evidence without the lock.
        competing = runGate(parsed, second.deps);
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      return killGroup(pid, signal);
    };
    const run = runGate(parsed, first.deps);
    await new Promise(setImmediate);
    expect(await competing).toBe(1);
    expect(second.logs[0]).toContain('cleanup lock');
    expect(second.logs[0]).toContain('refusing to spawn, operator cleanup required');
    expect(first.spawns.length + second.spawns.length).toBe(1);
    expect(JSON.parse(first.files.get(first.deps.markerPath)).pgid).toBe(first.children[0].pid);
    first.children[0].emit('exit', 0, null);
    expect(await run).toBe(0);
    // Normal completion releases the lock for a subsequent wrapper.
    const next = runGate(parsed, second.deps);
    await new Promise(setImmediate);
    expect(second.spawns).toHaveLength(1);
    second.children[0].emit('exit', 0, null);
    expect(await next).toBe(0);
  });

  it.each(['EEXIST', 'EACCES'])('refuses spawning and preserves evidence when cleanup lock acquisition fails with %s', async (code) => {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    const saved = '{"pgid":999,"time":1}';
    h.files.set(h.deps.markerPath, saved);
    const mkdir = h.deps.markerFs.mkdirSync;
    h.deps.markerFs.mkdirSync = (path, options) => {
      if (!options?.recursive) throw Object.assign(new Error('lock unavailable'), { code });
      mkdir(path, options);
    };
    const unlink = vi.spyOn(h.deps.markerFs, 'unlinkSync');
    const unlock = vi.spyOn(h.deps.markerFs, 'rmdirSync');
    expect(await runGate({ cmd: 'd', args: [] }, h.deps)).toBe(1);
    expect(h.spawns).toHaveLength(0);
    expect(h.files.get(h.deps.markerPath)).toBe(saved);
    expect(unlink).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
    expect(h.logs[0]).toContain(`cleanup lock ${h.deps.markerPath}.lock`);
    expect(h.logs[0]).toContain('refusing to spawn, operator cleanup required');
  });

  it.each(['alive', 'EPERM'])('blocks a fresh wrapper after unconfirmed %s death, then clears only on ESRCH', async (state) => {
    const dir = mkdtempSync(join(tmpdir(), 'host-gate-marker-'));
    const markerPath = join(dir, 'cleanup.json');
    const parsed = { cmd: 'd', args: [] };
    const fresh = () => {
      const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
      Object.assign(h.deps, { markerPath, markerFs: nodeFs });
      return h;
    };
    const probe = (pid, signal) => {
      expect(pid).toBe(1000);
      expect(signal).toBe(0);
      if (state === 'EPERM') throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return true;
    };
    try {
      const first = fresh();
      const killGroup = first.deps.killGroup;
      first.deps.killGroup = (pid, signal) => signal === 0 ? probe(pid, signal) : killGroup(pid, signal);
      const run = runGate(parsed, first.deps);
      await new Promise(setImmediate);
      first.children[0].emit('exit', 0, null);
      expect(await run).toBe(1);
      const saved = readFileSync(markerPath, 'utf8');
      expect(JSON.parse(saved)).toEqual({ pgid: 1000, time: expect.any(Number) });

      const second = fresh();
      second.deps.killGroup = vi.fn(probe);
      expect(await runGate(parsed, second.deps)).toBe(1);
      expect(second.deps.killGroup).toHaveBeenCalledTimes(1);
      expect(second.deps.killGroup).toHaveBeenCalledWith(1000, 0);
      expect(second.spawns).toHaveLength(0);
      expect(second.polls()).toBe(0);
      expect(second.logs[0]).toContain('refusing to spawn, operator cleanup required');
      expect(readFileSync(markerPath, 'utf8')).toBe(saved);

      const third = fresh(); // Default harness probe reports ESRCH.
      const recovered = runGate(parsed, third.deps);
      await new Promise(setImmediate);
      expect(third.spawns).toHaveLength(1);
      third.children[0].emit('exit', 0, null);
      expect(await recovered).toBe(0);
      expect(existsSync(markerPath)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['{', '{}', '{"pgid":null,"time":1}', '{"pgid":-1,"time":1}', '{"pgid":1000}', '{"pgid":1000,"time":"yesterday"}'])(
    'refuses malformed or incomplete persisted evidence: %s', async (raw) => {
      const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
      h.files.set(h.deps.markerPath, raw);
      expect(await runGate({ cmd: 'd', args: [] }, h.deps)).toBe(1);
      expect(h.spawns).toHaveLength(0);
      expect(h.files.get(h.deps.markerPath)).toBe(raw);
      expect(h.logs[0]).toContain('operator cleanup required');
    },
  );

  it.each(['readFileSync', 'writeFileSync', 'unlinkSync'])('refuses spawning when marker %s fails', async (operation) => {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    if (operation === 'unlinkSync') h.files.set(h.deps.markerPath, '{"pgid":1000,"time":1}');
    h.deps.markerFs[operation] = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    expect(await runGate({ cmd: 'd', args: [] }, h.deps)).toBe(1);
    expect(h.spawns).toHaveLength(0);
    expect(h.logs.at(-1)).toContain('refusing to spawn, operator cleanup required');
  });

  it('retains blocking incomplete evidence if recording the spawned pgid fails and death is unconfirmed', async () => {
    const h = harness({ owners: [{ host: HOST_A, version: 'file' }] });
    const write = h.deps.markerFs.writeFileSync;
    h.deps.markerFs.writeFileSync = (path, value, options) => {
      if (!options) throw new Error('write failed');
      write(path, value, options);
    };
    h.deps.killGroup = () => true;
    expect(await runGate({ cmd: 'd', args: [] }, h.deps)).toBe(1);
    expect(JSON.parse(h.files.get(h.deps.markerPath)).pgid).toBeNull();
    expect(await runGate({ cmd: 'd', args: [] }, h.deps)).toBe(1);
    expect(h.spawns).toHaveLength(1);
  });
});

describe('runGate while the daemon runs', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  function watched(owners) {
    const h = harness({ owners });
    const ticks = [];
    h.deps.watchSleep = () => new Promise((r) => ticks.push(r));
    h.deps.killGraceMs = 10;
    return { h, ticks };
  }
  it.each(['leader-exit', 'revoke', 'shutdown'])('%s waits for ESRCH after SIGKILL before releasing the gate', async (reason) => {
    const { h, ticks } = watched([
      { host: HOST_A, version: 'file' }, { host: HOST_B, version: 'file' },
    ]);
    h.deps.maxPolls = 2;
    let alive = true;
    const probes = [];
    const waits = [];
    const killGroup = h.deps.killGroup;
    h.deps.killGroup = (pid, signal) => {
      if (signal === 0) {
        probes.push(pid);
        if (alive) return true;
      }
      return killGroup(pid, signal);
    };
    h.deps.sleep = (ms) => {
      h.sleeps.push(ms);
      if (ms === 100) return new Promise((resolve) => waits.push(resolve));
      return Promise.resolve();
    };
    let settled = false;
    const run = runGate({ cmd: 'd', args: [] }, h.deps).then((code) => { settled = true; return code; });
    await tick();
    if (reason === 'revoke') { ticks[0](); await tick(); }
    if (reason === 'shutdown') h.procSignals.emit('SIGTERM');
    h.children[0].emit('exit', 0, null);
    await tick();
    expect(h.children[0].kills).toContain('SIGKILL');
    expect(probes).toEqual([h.children[0].pid]);
    expect(settled).toBe(false);
    expect(h.spawns).toHaveLength(1);
    expect(h.polls()).toBe(reason === 'revoke' ? 2 : 1);
    waits[0]();
    await tick();
    expect(probes).toHaveLength(2);
    expect(settled).toBe(false);
    alive = false;
    waits[1]();
    expect(await run).toBe(reason === 'revoke' ? 75 : 0);
    expect(probes).toHaveLength(3);
    expect(h.procSignals.eventNames()).toEqual([]);
  });

  it.each(['alive', 'unreadable'])('exits nonzero without a second spawn when group death is %s after revocation', async (state) => {
    const { h, ticks } = watched([
      { host: HOST_A, version: 'file' }, { host: HOST_B, version: 'file' },
      { host: HOST_A, version: 'file' },
    ]);
    let probes = 0;
    const killGroup = h.deps.killGroup;
    h.deps.killGroup = (pid, signal) => {
      if (signal !== 0) return killGroup(pid, signal);
      probes += 1;
      if (state === 'unreadable') throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return true;
    };
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await tick();
    ticks[0]();
    await tick();
    h.children[0].emit('exit', 0, null);
    expect(await run).toBe(1);
    expect(probes).toBe(state === 'alive' ? 301 : 1);
    expect(h.sleeps.filter((ms) => ms === 100)).toHaveLength(state === 'alive' ? 300 : 0);
    expect(h.spawns).toHaveLength(1);
    expect(h.polls()).toBe(2);
    expect(h.logs.at(-1)).toContain(state === 'alive' ? 'still alive after 30000 ms' : 'death probe failed (EPERM)');
    expect(h.logs.at(-1)).toContain('exiting 1, operator cleanup required');
    expect(h.procSignals.eventNames()).toEqual([]);
  });

  it.each([['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]])(
    '%s during revocation returns the child exit code without a second spawn or standby sleep',
    async (signal, code) => {
      const { h, ticks } = watched([
        { host: HOST_A, version: 'file' },
        { host: HOST_B, version: 'file' },
        { host: HOST_A, version: 'file' },
      ]);
      h.deps.sleep = (ms) => {
        h.sleeps.push(ms);
        return new Promise(() => {});
      };
      const spawn = h.deps.spawn;
      h.deps.spawn = (...args) => {
        const child = spawn(...args);
        // Let a faulty respawn finish so the regression fails without timing out.
        if (h.spawns.length > 1) setImmediate(() => child.emit('exit', 0, null));
        return child;
      };
      const run = runGate({ cmd: 'd', args: [] }, h.deps);
      await tick();
      ticks[0]();
      await tick();
      expect(h.children[0].kills).toEqual(['SIGTERM']);
      h.procSignals.emit(signal);
      expect(h.children[0].kills).toEqual(['SIGTERM', signal]);
      h.children[0].emit('exit', null, signal);
      expect(await run).toBe(code);
      expect(h.spawns).toHaveLength(1);
      expect(h.polls()).toBe(2);
      expect(h.sleeps).toEqual([h.deps.killGraceMs, h.deps.killGraceMs]);
      expect(h.procSignals.eventNames()).toEqual([]);
    },
  );

  it.each([
    ['other', { host: HOST_B, version: 'file' }],
    ['unset', { host: '', version: 'unset' }],
    ['unreadable', new Error('rate limited')],
    ['unreadable', null],
    ['unreadable', {}],
    ['unreadable', { host: 'bad host!', version: 'file' }],
  ])('revokes on the first non-active poll and returns to standby: owner=%s (%j)', async (description, owner) => {
    const { h, ticks } = watched([{ host: HOST_A, version: 'file' }, owner]);
    h.deps.maxPolls = 2;
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await tick();
    expect(h.spawns).toHaveLength(1);
    ticks[0]();
    await tick();
    expect(h.children[0].kills).toContain('SIGTERM');
    h.children[0].emit('exit', null, 'SIGTERM');
    expect(await run).toBe(75);
    expect(h.logs).toContain(`host-gate: owner=${description} self=${HOST_A}; stopping daemon, back to standby`);
    expect(h.logs.at(-1)).toBe(`host-gate: standby owner=${description} self=${HOST_A}`);
    expect(h.polls()).toBe(3);
    expect(h.spawns).toHaveLength(1);
  });
  it('keeps running on fresh active reads, then revokes on the first unreadable read', async () => {
    const { h, ticks } = watched([
      { host: HOST_A, version: 'file' }, { host: HOST_A, version: 'file' }, new Error('unavailable'),
    ]);
    h.deps.maxPolls = 1;
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await tick();
    ticks[0](); await tick();
    expect(h.children[0].kills).toEqual([]);
    ticks[1](); await tick();
    expect(h.polls()).toBe(3);
    expect(h.children[0].kills).toContain('SIGTERM');
    h.children[0].emit('exit', null, 'SIGTERM');
    expect(await run).toBe(75);
  });

  it('SIGKILLs a daemon that ignores SIGTERM after an unreadable read', async () => {
    const { h, ticks } = watched([{ host: HOST_A, version: 'file' }, new Error('unavailable')]);
    h.deps.maxPolls = 2;
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await tick();
    ticks[0]();
    await new Promise((r) => setTimeout(r, 40));
    expect(h.children[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
    h.children[0].emit('exit', null, 'SIGKILL');
    await run;
  });
});

describe('A3 ownership is read remotely on every poll; no cache is trusted or written', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const STALE_ACTIVE = { host: HOST_A, version: 'stale-cache', readAt: 0 };

  /** A harness whose source also offers a stale ACTIVE cache; every property the gate touches on it is recorded. */
  function withCache(owners) {
    const h = harness({ owners });
    const cache = {
      entry: STALE_ACTIVE, reads: 0, writes: 0,
      read() { this.reads += 1; return this.entry; },
      write(value) { this.writes += 1; this.entry = value; },
    };
    const touched = new Set();
    const inner = h.deps.source;
    inner.cache = cache;
    inner.readCache = () => cache.read();
    inner.writeCache = (value) => cache.write(value);
    h.deps.source = new Proxy(inner, {
      get(target, prop, receiver) { touched.add(String(prop)); return Reflect.get(target, prop, receiver); },
      set(target, prop, value, receiver) { touched.add(`set:${String(prop)}`); return Reflect.set(target, prop, value, receiver); },
      defineProperty(target, prop, descriptor) { touched.add(`define:${String(prop)}`); return Reflect.defineProperty(target, prop, descriptor); },
    });
    h.deps.killGraceMs = 10;
    return { h, cache, touched };
  }
  const expectNoCacheUse = ({ cache, touched }) => {
    expect(cache.reads).toBe(0);
    expect(cache.writes).toBe(0);
    expect(cache.entry).toBe(STALE_ACTIVE);
    expect([...touched]).toEqual(['readOwner']);
  };

  it.each([
    ['other', { host: HOST_B, version: 'file' }, 'other'],
    ['unset', { host: '', version: 'unset' }, 'unset'],
    ['thrown read', new Error('rate limited'), 'unreadable'],
    ['malformed read', { host: 'bad host!', version: 'file' }, 'unreadable'],
  ])('A3 a stale active cache is ignored and never written: remote %s keeps standby', async (_label, remote, owner) => {
    const rig = withCache([remote]);
    rig.h.deps.maxPolls = 4;
    expect(await runGate({ cmd: 'd', args: [] }, rig.h.deps)).toBe(75);
    expect(rig.h.spawns).toHaveLength(0);
    expect(rig.h.polls()).toBe(4);
    expect(rig.h.logs).toEqual(Array(4).fill(`host-gate: standby owner=${owner} self=${HOST_A}`));
    expectNoCacheUse(rig);
  });

  it('A3 makes a remote read on each standby poll, even while a cache says active', async () => {
    const rig = withCache([{ host: HOST_B, version: 'file' }]);
    rig.h.deps.maxPolls = 7;
    await runGate({ cmd: 'd', args: [] }, rig.h.deps);
    expect(rig.h.polls()).toBe(7);
    expectNoCacheUse(rig);
  });

  it('A3 makes a remote read on each poll while the daemon runs and revokes on a remote standby, ignoring a stale active cache', async () => {
    const rig = withCache([
      { host: HOST_A, version: 'file' }, { host: HOST_A, version: 'file' },
      { host: HOST_A, version: 'file' }, { host: HOST_B, version: 'file' },
    ]);
    const ticks = [];
    rig.h.deps.watchSleep = () => new Promise((r) => ticks.push(r));
    rig.h.deps.maxPolls = 1;
    const run = runGate({ cmd: 'd', args: [] }, rig.h.deps);
    await tick();
    expect(rig.h.polls()).toBe(1);
    for (let n = 1; n <= 2; n += 1) {
      ticks[n - 1]();
      await tick();
      expect(rig.h.polls()).toBe(1 + n);
      expect(rig.h.children[0].kills).toEqual([]);
    }
    ticks[2]();
    await tick();
    expect(rig.h.polls()).toBe(4);
    expect(rig.h.children[0].kills).toContain('SIGTERM');
    rig.h.children[0].emit('exit', null, 'SIGTERM');
    expect(await run).toBe(75);
    expect(rig.h.spawns).toHaveLength(1);
    expectNoCacheUse(rig);
  });

  it('A3 a remote read error while the daemon runs revokes it despite a stale active cache', async () => {
    const rig = withCache([{ host: HOST_A, version: 'file' }, new Error('unavailable')]);
    const ticks = [];
    rig.h.deps.watchSleep = () => new Promise((r) => ticks.push(r));
    rig.h.deps.maxPolls = 1;
    const run = runGate({ cmd: 'd', args: [] }, rig.h.deps);
    await tick();
    ticks[0]();
    await tick();
    expect(rig.h.children[0].kills).toContain('SIGTERM');
    rig.h.children[0].emit('exit', null, 'SIGTERM');
    expect(await run).toBe(75);
    expect(rig.h.logs).toContain(`host-gate: owner=unreadable self=${HOST_A}; stopping daemon, back to standby`);
    expectNoCacheUse(rig);
  });

  it('A3 the cache spies are live: a source that does consult the cache is observed', async () => {
    const rig = withCache([]);
    rig.h.deps.source.readOwner = async () => rig.cache.read();
    rig.h.deps.maxPolls = 1;
    expect(await runGate({ cmd: 'd', args: [] }, rig.h.deps)).toBe(75);
    expect(rig.cache.reads).toBe(1);
    expect(rig.h.spawns).toHaveLength(0); // the raw cache entry is not a valid owner result either
  });

  it('A3 the ownership poll has no cache or file IO; persistent state is only for cleanup', () => {
    const cli = readFileSync(fileURLToPath(new URL('../daemon-host-gate.mjs', import.meta.url)), 'utf8');
    expect(cli).not.toMatch(/cache/i);
    const poll = cli.slice(cli.indexOf('async function pollRole'), cli.indexOf('/** Watch a running child'));
    expect(poll).not.toMatch(/writeFile|appendFile|createWriteStream|renameSync|mkdirSync|readFileSync|openSync|copyFile/i);
    expect(poll).toContain('await resolveHostRole({ thisHost, source })');
  });
});

describe('isEntrypoint', () => {
  it('matches through a symlinked argv path', () => {
    expect(isEntrypoint('file:///private/tmp/a/g.mjs', '/tmp/a/g.mjs', () => '/private/tmp/a/g.mjs')).toBe(true);
  });
  it('matches a symlinked module URL (--preserve-symlinks-main) against a resolved argv path, and the reverse', () => {
    const real = { '/tmp/a/link.mjs': '/private/tmp/a/g.mjs', '/private/tmp/a/g.mjs': '/private/tmp/a/g.mjs' };
    const realpath = (path) => real[path] ?? path;
    // Module URL keeps the symlink path; argv[1] is already resolved.
    expect(isEntrypoint('file:///tmp/a/link.mjs', '/private/tmp/a/g.mjs', realpath)).toBe(true);
    // Module URL keeps the symlink path; argv[1] is the same symlink.
    expect(isEntrypoint('file:///tmp/a/link.mjs', '/tmp/a/link.mjs', realpath)).toBe(true);
    // Module URL is resolved; argv[1] is the symlink.
    expect(isEntrypoint('file:///private/tmp/a/g.mjs', '/tmp/a/link.mjs', realpath)).toBe(true);
  });
  it('is false for another module or no argv', () => {
    const other = (path) => ({ '/y/h.mjs': '/y/h.mjs', '/x/g.mjs': '/x/g.mjs' })[path] ?? path;
    expect(isEntrypoint('file:///x/g.mjs', '/y/h.mjs', other)).toBe(false);
    expect(isEntrypoint('file:///x/g.mjs', undefined)).toBe(false);
  });
});

describe('production CLI boundary', () => {
  const script = fileURLToPath(new URL('../daemon-host-gate.mjs', import.meta.url));
  it('always uses the default ownership source and contains no local owner bypass', () => {
    const cli = readFileSync(script, 'utf8');
    expect(cli).toContain('process.exit(await runGate(parsed));');
    expect(cli).not.toMatch(/WE_DAEMON_HOST_(?:OWNER_FILE|GATE_TEST_ONLY)|makeFileOwnerReader/);
  });

  it('exits 2 with usage when the command is missing', () => {
    const result = spawnSync(process.execPath, [script, '--'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: daemon-host-gate.mjs');
  });
});

describe('real daemon process group', () => {
  function descendantAlive(pid) {
    const identity = pidIdentity(pid);
    if (identity.alive !== null) return identity.alive;
    // Sandboxed macOS may deny ps. A kernel probe still supplies positive
    // existence/death evidence; errors other than ESRCH remain unknown.
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === 'ESRCH' ? false : null; }
  }
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await delay(10);
    expect(predicate()).toBe(true);
  }

  it.each(['revoke', 'SIGTERM', 'SIGINT', 'SIGHUP', 'exit', 'leader-exit', 'shell-revoke', 'resistant-leader'])(
    '%s leaves no live descendant, including a worker that ignores SIGTERM', async (reason) => {
      const dir = mkdtempSync(join(tmpdir(), 'host-gate-group-'));
      const ready = join(dir, 'ready');
      const procSignals = new EventEmitter();
      let child;
      let descendant;
      let releaseWatch;
      let owner = HOST_A;
      let run;
      const logs = [];
      try {
        // The leader does not forward signals. The grandchild advertises readiness
        // only after installing its SIGTERM handler.
        const worker = keepAliveScript({
          anchorPid: process.pid, maxLifetimeMs: 15000,
          prelude: 'process.on("SIGTERM", () => {});',
          postlude: 'require("node:fs").writeFileSync(process.argv[1], String(process.pid));',
        });
        const leader = keepAliveScript({
          anchorPid: process.pid, maxLifetimeMs: 15000,
          prelude: (reason === 'resistant-leader' ? 'process.on("SIGTERM", () => {});' : '')
            + 'require("node:child_process").spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], {stdio:"inherit"});',
        });
        const parsed = reason === 'shell-revoke'
          ? { cmd: '/bin/sh', args: ['-c', '"$1" -e "$2" "$3" & wait', 'host-gate-test', process.execPath, worker, ready] }
          : { cmd: process.execPath, args: ['-e', leader, worker, ready] };
        run = runGate(parsed, {
          markerPath: join(dir, 'cleanup.json'),
          thisHost: HOST_A, source: { readOwner: async () => ({ host: owner, version: 'file' }) },
          processSignals: procSignals, log: (line) => logs.push(line), maxPolls: 1, killGraceMs: 30,
          // Exercise the full probe budget without a 30-second fixture wait.
          // Linux can retain a dead orphan's group until its subreaper reaps it;
          // that must produce a closed failure, never an unconfirmed release.
          sleep: (ms) => delay(ms === 100 ? 1 : ms),
          watchSleep: () => new Promise((resolve) => { releaseWatch = resolve; }),
          spawn: (...args) => { child = spawn(...args); return child; },
        });
        await waitFor(() => existsSync(ready));
        descendant = Number(readFileSync(ready, 'utf8'));
        expect(descendantAlive(descendant)).toBe(true);
        if (['revoke', 'shell-revoke', 'resistant-leader'].includes(reason)) { owner = HOST_B; releaseWatch(); }
        else if (reason === 'leader-exit') child.kill('SIGTERM');
        else procSignals.emit(reason);
        const code = await Promise.race([run, delay(3000).then(() => { throw new Error('gate did not settle'); })]);
        if (logs.some((line) => line.includes('still alive after 30000 ms'))) expect(code).toBe(1);
        // A killed orphan can remain a zombie until Linux's subreaper reaps it.
        // Require positive death evidence; an unreadable probe is not success.
        await waitFor(() => descendantAlive(descendant) === false);
        expect(procSignals.eventNames()).toEqual([]);
      } finally {
        if (child?.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group absent before fix */ }
          try { process.kill(child.pid, 'SIGKILL'); } catch { /* already exited */ }
        }
        if (!descendant && existsSync(ready)) descendant = Number(readFileSync(ready, 'utf8'));
        if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already exited */ } }
        rmSync(dir, { recursive: true, force: true });
      }
    }, 10000,
  );
});

// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getThisHost } from '../../lib/daemon-host-guard.mjs';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';
import { pidIdentity } from '../../lib/pid-alive.mjs';
import {
  parseGateArgs, runGate, isEntrypoint, makeFileOwnerReader, POLL_MS,
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
  const deps = {
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
    killGroup: (pid, signal) => children.find((child) => child.pid === pid).kill(signal),
    processSignals: procSignals,
    watchSleep: () => new Promise(() => {}),
    maxPolls: 50,
  };
  return { deps, logs, sleeps, spawns, children, procSignals, polls: () => i };
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

describe('runGate while the daemon runs', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  function watched(owners) {
    const h = harness({ owners });
    const ticks = [];
    h.deps.watchSleep = () => new Promise((r) => ticks.push(r));
    h.deps.killGraceMs = 10;
    return { h, ticks };
  }
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

  it.each([['other', HOST_B], ['unset', '']])('stops the daemon and returns to standby when owner=%s', async (description, host) => {
    const { h, ticks } = watched([{ host: HOST_A, version: 'file' }, { host, version: host ? 'file' : 'unset' }]);
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
  it('tolerates unreadable reads for under 600 s of wall clock, stops at 600 s', async () => {
    const bad = new Error('rate limited');
    const { h, ticks } = watched([{ host: HOST_A, version: 'file' }, bad]);
    let t = 1_000_000;
    h.deps.now = () => t;
    h.deps.maxPolls = 2;
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await tick();
    t += 599_000; ticks[0](); await tick();
    expect(h.children[0].kills).not.toContain('SIGTERM');
    t += 1_000; ticks[1](); await tick();
    expect(h.children[0].kills).toContain('SIGTERM');
    h.children[0].emit('exit', null, 'SIGTERM');
    await run;
  });
  it('re-reads while active and resets the unreadable deadline after a good read', async () => {
    const { h, ticks } = watched([
      { host: HOST_A, version: 'file' }, new Error('unavailable'),
      { host: HOST_A, version: 'file' }, new Error('unavailable'),
    ]);
    let time = 0;
    h.deps.now = () => time;
    h.deps.maxPolls = 1;
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await tick();
    time = 599_000; ticks[0](); await tick();
    expect(h.children[0].kills).toEqual([]);
    ticks[1](); await tick();
    time = 1_198_000; ticks[2](); await tick();
    expect(h.children[0].kills).toEqual([]);
    time = 1_199_000; ticks[3](); await tick();
    expect(h.polls()).toBe(5);
    expect(h.children[0].kills).toContain('SIGTERM');
    h.children[0].emit('exit', null, 'SIGTERM');
    expect(await run).toBe(75);
  });

  it('SIGKILLs a daemon that ignores SIGTERM', async () => {
    const { h, ticks } = watched([{ host: HOST_A, version: 'file' }, { host: '', version: 'unset' }]);
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

describe('makeFileOwnerReader (test-only override)', () => {
  const reader = (content, fail) => makeFileOwnerReader('/x/owner', {
    readFile: () => { if (fail) throw new Error('ENOENT'); return content; },
  });
  it('reads a UUID', async () => {
    expect(await reader(HOST_A + '\n').readOwner()).toEqual({ host: HOST_A, version: 'file' });
  });
  it('empty is unset', async () => {
    expect(await reader('').readOwner()).toEqual({ host: '', version: 'unset' });
  });
  it('unreadable throws', async () => { await expect(reader('', true).readOwner()).rejects.toThrow('ENOENT'); });
  it.each(['a b;rm', 'host-a', '  \n', HOST_A + '\n\n'])('invalid owner throws (%s)', async (value) => {
    await expect(reader(value).readOwner()).rejects.toThrow('invalid owner ID');
  });
  it('accepts an explicitly allowed migration alias', async () => {
    const source = makeFileOwnerReader('/x/owner', { readFile: () => 'host-a', legacyOwnerValues: ['host-a'] });
    expect(await source.readOwner()).toEqual({ host: 'host-a', version: 'file' });
  });
});

describe('isEntrypoint', () => {
  it('matches through a symlinked argv path', () => {
    expect(isEntrypoint('file:///private/tmp/a/g.mjs', '/tmp/a/g.mjs', () => '/private/tmp/a/g.mjs')).toBe(true);
  });
  it('is false for another module or no argv', () => {
    expect(isEntrypoint('file:///x/g.mjs', '/y/h.mjs', () => '/y/h.mjs')).toBe(false);
    expect(isEntrypoint('file:///x/g.mjs', undefined)).toBe(false);
  });
});

describe('owner-file override CLI boundary', () => {
  const script = fileURLToPath(new URL('../daemon-host-gate.mjs', import.meta.url));
  it.each([undefined, '', '0', 'true'])('refuses WE_DAEMON_HOST_OWNER_FILE without TEST_ONLY=1 (%s)', (flag) => {
    const dir = mkdtempSync(join(tmpdir(), 'host-gate-cli-'));
    try {
      const owner = join(dir, 'owner');
      const marker = join(dir, 'executed');
      writeFileSync(owner, getThisHost({ home: dir }));
      const env = { ...process.env, HOME: dir, WE_DAEMON_HOST_OWNER_FILE: owner };
      delete env.WE_DAEMON_HOST_GATE_TEST_ONLY;
      if (flag !== undefined) env.WE_DAEMON_HOST_GATE_TEST_ONLY = flag;
      const result = spawnSync(process.execPath, [script, '--', process.execPath, '-e',
        'require("node:fs").writeFileSync(process.argv[1], "ran")', marker],
      { env, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('refusing to start');
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('allows the explicit test-only override and propagates the command exit code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-gate-cli-'));
    try {
      const owner = join(dir, 'owner');
      writeFileSync(owner, getThisHost({ home: dir }));
      const result = spawnSync(process.execPath, [script, '--', process.execPath, '-e', 'process.exit(7)'], {
        env: { ...process.env, HOME: dir, WE_DAEMON_HOST_OWNER_FILE: owner, WE_DAEMON_HOST_GATE_TEST_ONLY: '1' },
        encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
          thisHost: HOST_A, source: { readOwner: async () => ({ host: owner, version: 'file' }) },
          processSignals: procSignals, log: () => {}, maxPolls: 1, killGraceMs: 30,
          watchSleep: () => new Promise((resolve) => { releaseWatch = resolve; }),
          spawn: (...args) => { child = spawn(...args); return child; },
        });
        await waitFor(() => existsSync(ready));
        descendant = Number(readFileSync(ready, 'utf8'));
        expect(descendantAlive(descendant)).toBe(true);
        if (['revoke', 'shell-revoke', 'resistant-leader'].includes(reason)) { owner = HOST_B; releaseWatch(); }
        else if (reason === 'leader-exit') child.kill('SIGTERM');
        else procSignals.emit(reason);
        await Promise.race([run, delay(3000).then(() => { throw new Error('gate did not settle'); })]);
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

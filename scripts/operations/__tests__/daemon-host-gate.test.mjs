// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  parseGateArgs, runGate, isEntrypoint, makeFileOwnerReader, POLL_MS,
} from '../daemon-host-gate.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.kills = [];
  child.kill = (sig) => { child.kills.push(sig); return true; };
  return child;
}

function harness({ owners, self = 'studio' }) {
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
    readRemote: async () => {
      const value = owners[Math.min(i, owners.length - 1)];
      i += 1;
      if (value instanceof Error) throw value;
      return value;
    },
    spawn: (cmd, args, opts) => {
      const child = fakeChild();
      spawns.push({ cmd, args, opts });
      children.push(child);
      return child;
    },
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
    const h = harness({ owners: [{ status: 'ok', owner: 'studio' }] });
    const run = runGate({ cmd: '/bin/sh', args: ['-c', 'x y'] }, h.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].cmd).toBe('/bin/sh');
    expect(h.spawns[0].args).toEqual(['-c', 'x y']);
    expect(h.spawns[0].opts.stdio).toBe('inherit');
    h.children[0].emit('exit', 0, null);
    expect(await run).toBe(0);
  });

  it('owner=other stays in standby: never spawns across many polls, polls no faster than 60 s', async () => {
    const h = harness({ owners: [{ status: 'ok', owner: 'macbook' }] });
    h.deps.maxPolls = 20;
    const code = await runGate({ cmd: 'x', args: [] }, h.deps);
    expect(h.spawns).toHaveLength(0);
    expect(code).toBe(75);
    expect(h.sleeps.length).toBeGreaterThan(5);
    expect(h.sleeps.every((ms) => ms >= 60_000)).toBe(true);
    expect(POLL_MS).toBeGreaterThanOrEqual(60_000);
    expect(h.logs[0]).toBe('host-gate: standby owner=macbook self=studio');
  });

  it('owner unset stays in standby', async () => {
    const h = harness({ owners: [{ status: 'unset' }] });
    h.deps.maxPolls = 5;
    await runGate({ cmd: 'x', args: [] }, h.deps);
    expect(h.spawns).toHaveLength(0);
    expect(h.logs[0]).toContain('standby owner=unset self=studio');
  });

  it('read error, thrown read and garbage results stay in standby (fail closed)', async () => {
    const h = harness({ owners: [
      { status: 'error', error: 'rate limited' }, new Error('boom'), null, { status: 'ok', owner: 'bad host!' }, {},
    ] });
    h.deps.maxPolls = 5;
    await runGate({ cmd: 'x', args: [] }, h.deps);
    expect(h.spawns).toHaveLength(0);
    expect(h.logs[0]).toContain('standby owner=unreadable self=studio');
  });

  it('empty self host never execs', async () => {
    const h = harness({ owners: [{ status: 'ok', owner: 'studio' }], self: '' });
    h.deps.maxPolls = 3;
    await runGate({ cmd: 'x', args: [] }, h.deps);
    expect(h.spawns).toHaveLength(0);
  });

  it('flips to self then execs', async () => {
    const h = harness({ owners: [
      { status: 'ok', owner: 'macbook' }, { status: 'ok', owner: 'macbook' }, { status: 'ok', owner: 'studio' },
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
    const h = harness({ owners: [{ status: 'ok', owner: 'studio' }] });
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await new Promise((r) => setTimeout(r, 5));
    h.children[0].emit('exit', 7, null);
    expect(await run).toBe(7);
  });

  it('maps a child killed by signal to 128+n', async () => {
    const h = harness({ owners: [{ status: 'ok', owner: 'studio' }] });
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await new Promise((r) => setTimeout(r, 5));
    h.children[0].emit('exit', null, 'SIGTERM');
    expect(await run).toBe(143);
  });

  it('forwards SIGTERM/SIGINT/SIGHUP to the child and removes listeners afterwards', async () => {
    const h = harness({ owners: [{ status: 'ok', owner: 'studio' }] });
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
    const h = harness({ owners: [{ status: 'ok', owner: 'studio' }] });
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
  it.each(['studio', 'macbook'])('does not spawn or sleep after shutdown during an owner read (%s)', async (owner) => {
    const h = harness({ owners: [] });
    h.deps.readRemote = async () => {
      h.procSignals.emit('SIGTERM');
      return { status: 'ok', owner };
    };
    expect(await runGate({ cmd: 'd', args: [] }, h.deps)).toBe(143);
    expect(h.spawns).toHaveLength(0);
    expect(h.sleeps).toHaveLength(0);
    expect(h.procSignals.eventNames()).toEqual([]);
  });

  it('interrupts standby sleep on shutdown and removes signal listeners', async () => {
    const h = harness({ owners: [{ status: 'unset' }] });
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
    const h = harness({ owners: [{ status: 'ok', owner: 'studio' }] });
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

  it('cancels the grace timer without SIGKILL when the child exits during grace', async () => {
    const { h, waits, run } = await running();
    h.procSignals.emit('SIGINT');
    expect(waits[0].signal.aborted).toBe(false);
    h.children[0].emit('exit', null, 'SIGINT');
    expect(await run).toBe(130);
    expect(waits[0].signal.aborted).toBe(true);
    expect(h.children[0].kills).toEqual(['SIGINT']);
    h.procSignals.emit('exit', 130);
    expect(h.children[0].kills).toEqual(['SIGINT']);
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
        { status: 'ok', owner: 'studio' },
        { status: 'ok', owner: 'macbook' },
        { status: 'ok', owner: 'studio' },
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

  it('stops the daemon and returns to standby when the owner moves to another host', async () => {
    const { h, ticks } = watched([{ status: 'ok', owner: 'studio' }, { status: 'ok', owner: 'macbook' }]);
    h.deps.maxPolls = 2;
    const run = runGate({ cmd: 'd', args: [] }, h.deps);
    await tick();
    expect(h.spawns).toHaveLength(1);
    ticks[0]();
    await tick();
    expect(h.children[0].kills).toContain('SIGTERM');
    h.children[0].emit('exit', null, 'SIGTERM');
    expect(await run).toBe(75);
    expect(h.logs.some((l) => l.includes('stopping daemon'))).toBe(true);
    expect(h.spawns).toHaveLength(1);
  });
  it('tolerates unreadable reads for under 600 s of wall clock, stops at 600 s', async () => {
    const bad = { status: 'error', error: 'rate limited' };
    const { h, ticks } = watched([{ status: 'ok', owner: 'studio' }, bad]);
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
  it('SIGKILLs a daemon that ignores SIGTERM', async () => {
    const { h, ticks } = watched([{ status: 'ok', owner: 'studio' }, { status: 'unset' }]);
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
  it('reads a host', async () => { expect(await reader('studio\n')()).toEqual({ status: 'ok', owner: 'studio' }); });
  it('empty is unset', async () => { expect(await reader('  \n')()).toEqual({ status: 'unset' }); });
  it('unreadable is error', async () => { expect((await reader('', true)()).status).toBe('error'); });
  it('invalid host is error', async () => { expect((await reader('a b;rm')()).status).toBe('error'); });
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

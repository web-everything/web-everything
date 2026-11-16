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

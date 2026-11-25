// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { runGate } from '../daemon-host-gate.mjs';

const HOST_A = '11111111-1111-4111-8111-111111111111';
const parsed = { cmd: 'daemon', args: [], daemon: 'drain' };

function setup({ swap }) {
  const logs = [];
  const spawns = [];
  const children = [];
  const files = new Map();
  const dirs = new Set();
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  let reads = 0;
  let wake = null; // resolves one watchSleep tick
  const deps = {
    markerPath: 'state/m.json',
    markerFs: {
      mkdirSync(p, o) { if (!o?.recursive && dirs.has(p)) throw Object.assign(new Error('x'), { code: 'EEXIST' }); dirs.add(p); },
      rmdirSync(p) { dirs.delete(p); },
      readFileSync(p) { if (!files.has(p)) throw missing(); return files.get(p); },
      writeFileSync(p, v, o) { if (o?.flag === 'wx' && files.has(p)) throw Object.assign(new Error('x'), { code: 'EEXIST' }); files.set(p, v); },
      unlinkSync(p) { files.delete(p); },
    },
    thisHost: HOST_A,
    log: (l) => logs.push(l),
    sleep: async () => {},
    source: { readOwner: async () => { reads += 1; return { host: HOST_A, version: 'file' }; } },
    swapEnabled: () => swap,
    spawn: (cmd, args, opts) => {
      const c = new EventEmitter();
      c.pid = 2000 + children.length;
      c.kills = [];
      spawns.push({ opts });
      children.push(c);
      return c;
    },
    killGroup: (pid, sig) => {
      if (sig === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      children.find((c) => c.pid === pid).kills.push(sig);
    },
    processSignals: new EventEmitter(),
    watchSleep: () => new Promise((r) => { wake = r; }),
    maxPolls: 5,
  };
  return { deps, logs, spawns, children, reads: () => reads };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('host gate swap', () => {
  it('exit 76 spawns a candidate while active keeps running; exit 77 promotes without a standby poll', async () => {
    const h = setup({ swap: true });
    const run = runGate(parsed, h.deps);
    await tick();
    expect(h.children).toHaveLength(1);
    const readsBefore = h.reads();
    h.children[0].emit('message', { type: 'reload' }); // blue asks for a successor and keeps running
    await tick();
    expect(h.children).toHaveLength(2);
    expect(h.children[0].kills).toEqual([]); // blue untouched
    expect(h.spawns[1].opts.env.WE_DAEMON_ROLE).toBe('green');
    expect(h.spawns[1].opts.env.WE_DAEMON_GEN).toBe('2');
    h.children[0].emit('exit', 77, null);
    await tick();
    expect(h.children).toHaveLength(2); // no third spawn, gate did not exit
    expect(h.reads()).toBe(readsBefore); // no cold owner re-read
    h.children[1].emit('exit', 0, null);
    expect(await run).toBe(0);
  });

  it('a green that exits during shadow is dropped and blue keeps running', async () => {
    const h = setup({ swap: true });
    const run = runGate(parsed, h.deps);
    await tick();
    h.children[0].emit('message', { type: 'reload' });
    await tick();
    h.children[1].emit('exit', 1, null);
    await tick();
    expect(h.logs.some((l) => l.includes('dropped'))).toBe(true);
    h.children[0].emit('exit', 5, null);
    expect(await run).toBe(5);
  });

  it('blue exiting 76 promotes a fresh green with no owner re-read', async () => {
    const h = setup({ swap: true });
    const run = runGate(parsed, h.deps);
    await tick();
    const readsBefore = h.reads();
    h.children[0].emit('exit', 76, null);
    await tick();
    expect(h.children).toHaveLength(2);
    expect(h.reads()).toBe(readsBefore);
    h.children[1].emit('exit', 0, null);
    expect(await run).toBe(0);
  });

  it('setting off: exit 76 ends the gate like today', async () => {
    const h = setup({ swap: false });
    const run = runGate(parsed, h.deps);
    await tick();
    h.children[0].emit('exit', 76, null);
    expect(await run).toBe(76);
    expect(h.children).toHaveLength(1);
    expect(h.spawns[0].opts.env).toBeUndefined();
  });
});

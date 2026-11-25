// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runGate } from '../daemon-host-gate.mjs';

vi.mock('../../lib/policy-cascade.mjs', () => ({ platformPreference: vi.fn() }));
import { platformPreference } from '../../lib/policy-cascade.mjs';

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
    greenCapable: true,
    candidateReady: () => true,
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
  return { deps, logs, spawns, children, files, wake: () => wake(), reads: () => reads };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('host gate swap', () => {
  it('IPC reload starts a shadow while blue runs; exit 77 promotes without a standby poll', async () => {
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

  it('blue exiting 76 rechecks ownership before starting a fresh ready green', async () => {
    const h = setup({ swap: true });
    const run = runGate(parsed, h.deps);
    await tick();
    const readsBefore = h.reads();
    h.children[0].emit('exit', 76, null);
    await tick();
    expect(h.children).toHaveLength(2);
    expect(h.reads()).toBe(readsBefore + 1);
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

async function shadow(h) {
  const run = runGate(parsed, h.deps);
  await tick();
  h.children[0].emit('message', { type: 'reload' });
  await tick();
  return { run };
}
function autoExit(h, failedPid) {
  const kill = h.deps.killGroup;
  h.deps.killGroup = (pid, sig) => {
    if (sig === 0 && pid === failedPid) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    kill(pid, sig);
    if (sig === 'SIGKILL') queueMicrotask(() => h.children.find((c) => c.pid === pid).emit('exit', 0, null));
  };
}

describe('swap audit regressions', () => {
  it.each([76, 77])('exit %i refuses an unready candidate and stops it with escalation', async (code) => {
    const h = setup({ swap: true });
    const checked = [];
    h.deps.candidateReady = (gen) => { checked.push(gen); return false; };
    autoExit(h);
    const { run } = await shadow(h);
    h.children[0].emit('exit', code, null);
    await tick();
    h.children[1].emit('exit', 0, null);
    expect(await run).toBe(code);
    expect(checked).toEqual([2]);
    expect(h.children[1].kills).toContain('SIGTERM');
    expect(h.children[1].kills).toContain('SIGKILL');
    expect(h.logs.join(' ')).not.toContain('promoted');
  });

  it('never promotes a candidate whose leader has exited while cleanup is pending', async () => {
    const h = setup({ swap: true });
    let release;
    h.deps.sleep = (ms) => ms === 100 ? new Promise((r) => { release = r; }) : Promise.resolve();
    const kill = h.deps.killGroup;
    let alive = true;
    h.deps.killGroup = (pid, sig) => { if (pid === 2001 && sig === 0 && alive) return; return kill(pid, sig); };
    const { run } = await shadow(h);
    h.children[1].emit('exit', 0, null);
    h.children[0].emit('exit', 77, null);
    await tick();
    alive = false;
    release();
    expect(await run).toBe(77);
    expect(h.logs.join(' ')).not.toContain('promoted');
  });

  it('candidate cleanup failure retains its marker and blocks a wrapper restart', async () => {
    const h = setup({ swap: true });
    autoExit(h, 2001);
    const { run } = await shadow(h);
    expect(JSON.parse(h.files.get('state/m.json.green')).pgid).toBe(2001);
    h.children[0].emit('exit', 0, null);
    await tick();
    h.children[1].emit('exit', 0, null);
    expect(await run).toBe(1);
    expect(h.logs.join(' ')).toContain('operator cleanup required');
    expect(h.files.has('state/m.json.green')).toBe(true);
    expect(await runGate(parsed, h.deps)).toBe(1);
    expect(h.children).toHaveLength(2);
  });

  it.each(['revoke', 'ordinary', 'signal'])('%s stops both slots with a deadline and reports any cleanup failure', async (mode) => {
    const h = setup({ swap: true });
    autoExit(h, 2001);
    const { run } = await shadow(h);
    if (mode === 'revoke') {
      h.deps.source.readOwner = async () => { h.children[0].emit('exit', 0, null); return null; };
      h.wake();
    } else if (mode === 'ordinary') h.children[0].emit('exit', 0, null);
    else h.deps.processSignals.emit('SIGINT');
    await tick();
    h.children.forEach((c) => c.emit('exit', 0, null));
    expect(await run).toBe(1);
    expect(h.children[1].kills).toContain('SIGTERM');
    expect(h.children[1].kills).toContain('SIGKILL');
    expect(h.logs.join(' ')).toContain('operator cleanup required');
  });

  it('re-arms reload requests after each drop and ignores requests beyond the drop bound', async () => {
    const h = setup({ swap: true });
    const { run } = await shadow(h);
    for (let i = 1; i <= 3; i += 1) {
      h.children.at(-1).emit('exit', 1, null);
      await tick();
      h.children[0].emit('message', { type: 'reload' });
      await tick();
      expect(h.children).toHaveLength(Math.min(i + 2, 4));
    }
    expect(h.logs.join(' ')).toContain('needs-you');
    h.children[0].emit('exit', 5, null);
    expect(await run).toBe(5);
  });

  it.each([76, 77])('shutdown before processing exit %i neither spawns nor promotes', async (code) => {
    const h = setup({ swap: true });
    autoExit(h);
    const run = runGate(parsed, h.deps);
    await tick();
    h.children[0].emit('exit', code, null);
    h.deps.processSignals.emit('SIGTERM');
    await tick();
    h.children.slice(1).forEach((c) => c.emit('exit', 0, null));
    await run;
    expect(h.children).toHaveLength(1);
    expect(h.logs.join(' ')).not.toContain('promoted');
  });

  it('promotion marker failure stops green and returns 1', async () => {
    const h = setup({ swap: true });
    autoExit(h);
    const { run } = await shadow(h);
    const write = h.deps.markerFs.writeFileSync;
    h.deps.markerFs.writeFileSync = (p, ...args) => { if (p === 'state/m.json') throw new Error('denied'); write(p, ...args); };
    // Observe a rejected baseline promise without an unhandled rejection.
    const result = run.catch(() => 'escaped');
    h.children[0].emit('exit', 77, null);
    await tick();
    h.children[1].emit('exit', 0, null);
    expect(await result).toBe(1);
    expect(h.children[1].kills).toContain('SIGTERM');
  });

  it('promotion transfers marker ownership and shutdown returns the promoted result', async () => {
    const h = setup({ swap: true });
    const { run } = await shadow(h);
    h.children[0].emit('exit', 77, null);
    await tick();
    expect(JSON.parse(h.files.get('state/m.json')).pgid).toBe(2001);
    h.deps.processSignals.emit('SIGTERM');
    h.children[1].emit('exit', null, 'SIGTERM');
    expect(await run).toBe(143);
    expect(h.files.size).toBe(0);
  });

  it.each(['reload', 'exit'])('refuses green without capability on %s', async (request) => {
    const h = setup({ swap: true });
    h.deps.greenCapable = false;
    const run = runGate(parsed, h.deps);
    await tick();
    if (request === 'reload') { h.children[0].emit('message', { type: 'reload' }); await tick(); }
    h.children[0].emit('exit', 76, null);
    await tick();
    h.children.slice(1).forEach((c) => c.emit('exit', 0, null));
    expect(await run).toBe(76);
    expect(h.children).toHaveLength(1);
  });
});

describe('swap request races', () => {
  it('queues a reload arriving while a candidate is still in shadow', async () => {
    const h = setup({ swap: true });
    const { run } = await shadow(h);
    h.children[0].emit('message', { type: 'reload' });
    h.children[1].emit('exit', 1, null);
    await tick();
    expect(h.children).toHaveLength(3);
    h.children[2].emit('exit', 1, null);
    await tick();
    h.children[0].emit('exit', 5, null);
    expect(await run).toBe(5);
  });

  it('shutdown during readiness validation stops green without promotion', async () => {
    const h = setup({ swap: true });
    autoExit(h);
    h.deps.candidateReady = () => { h.deps.processSignals.emit('SIGTERM'); return true; };
    const { run } = await shadow(h);
    h.children[0].emit('exit', 77, null);
    await run;
    expect(h.logs.join(' ')).not.toContain('promoted');
    expect(h.children[1].kills).toContain('SIGTERM');
  });
});


describe('closed swap wiring and bounded handover', () => {
  it.each(['candidateReady', 'greenCapable'])('missing %s falls back once to ordinary non-swap execution', async (key) => {
    const h = setup({ swap: true });
    delete h.deps[key];
    const run = runGate(parsed, h.deps);
    await tick();
    h.children[0].emit('message', { type: 'reload' });
    await tick();
    h.children[0].emit('exit', 76, null);
    expect(await run).toBe(76);
    expect(h.children).toHaveLength(1);
    expect(h.spawns[0].opts.env).toBeUndefined();
    expect(h.logs.filter((l) => l.includes('swap is not wired'))).toHaveLength(1);
  });

  it.each([undefined, {}, { blueGreenSwap: { drain: 'off' } }, { blueGreenSwap: { drain: 'true' } },
    { blueGreenSwap: { drain: true } }, { blueGreenSwap: { drain: 'on' } }])('default platform setting %j', async (prefs) => {
    platformPreference.mockReturnValue(prefs);
    const h = setup({ swap: false });
    delete h.deps.swapEnabled;
    const run = runGate(parsed, h.deps);
    await tick();
    const enabled = [true, 'on'].includes(prefs?.blueGreenSwap?.drain);
    expect(platformPreference).toHaveBeenLastCalledWith('daemons');
    expect(h.spawns[0].opts.env?.WE_DAEMON_ROLE).toBe(enabled ? 'blue' : undefined);
    h.children[0].emit('exit', 0, null);
    expect(await run).toBe(0);
  });

  it('checks a retained green marker even with swap off', async () => {
    const h = setup({ swap: false });
    h.files.set('state/m.json.green', JSON.stringify({ pgid: 999, time: 1 }));
    const kill = h.deps.killGroup;
    h.deps.killGroup = (pid, sig) => { if (pid === 999) return; return kill(pid, sig); };
    const run = runGate(parsed, h.deps);
    await tick();
    h.children.forEach((c) => c.emit('exit', 0, null));
    expect(await run).toBe(1);
    expect(h.children).toHaveLength(0);
    expect(h.logs.join(' ')).toContain('green cleanup marker');
  });

  it.each(['SIGINT', 'SIGHUP'])('candidate starts shutdown with TERM on wrapper %s', async (sig) => {
    const h = setup({ swap: true });
    autoExit(h);
    const { run } = await shadow(h);
    h.deps.processSignals.emit(sig);
    await run;
    expect(h.children[1].kills[0]).toBe('SIGTERM');
    expect(h.children[1].kills).not.toContain(sig);
  });

  it('exit 76 refuses a successor after ownership changes', async () => {
    const h = setup({ swap: true });
    const run = runGate(parsed, h.deps);
    await tick();
    h.deps.source.readOwner = async () => null;
    h.children[0].emit('exit', 76, null);
    await tick();
    h.children.slice(1).forEach((c) => c.emit('exit', 0, null));
    expect(await run).toBe(76);
    expect(h.children).toHaveLength(1);
  });

  it.each(['deadline', 'ownership'])('pending readiness yields to %s', async (mode) => {
    const h = setup({ swap: true });
    autoExit(h);
    h.deps.candidateReady = () => new Promise(() => {});
    let deadline;
    h.deps.sleep = (ms, opts) => ms === 123 ? new Promise((r) => { deadline = r; }) : Promise.resolve();
    h.deps.readinessTimeoutMs = 123;
    const { run } = await shadow(h);
    h.children[0].emit('exit', 77, null);
    await tick();
    if (mode === 'deadline') deadline?.();
    else { h.deps.source.readOwner = async () => null; h.wake(); }
    await tick();
    expect(h.children[1].kills).toContain('SIGTERM');
    expect(await run).toBe(77);
    expect(h.logs.join(' ')).not.toContain('promoted');
  });

  it('tries every slot when the first TERM throws', async () => {
    const h = setup({ swap: true });
    autoExit(h);
    const kill = h.deps.killGroup;
    h.deps.killGroup = (pid, sig) => { if (pid === 2000 && sig === 'SIGTERM') throw Object.assign(new Error('denied'), { code: 'EPERM' }); return kill(pid, sig); };
    const { run } = await shadow(h);
    h.deps.source.readOwner = async () => null;
    const result = run.catch(() => 'escaped');
    h.wake();
    await tick();
    expect(h.children[1].kills).toContain('SIGTERM');
    expect(await result).toBe(1);
  });

  it('cancels the multi-slot grace timer when all slots exit early', async () => {
    const h = setup({ swap: true });
    const signals = [];
    h.deps.sleep = (ms, { signal } = {}) => { signals.push(signal); return new Promise(() => {}); };
    const { run } = await shadow(h);
    h.children[0].emit('exit', 0, null);
    await tick();
    h.children[1].emit('exit', 0, null);
    await run;
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s?.aborted)).toBe(true);
  });

  it('resets drops on promotion and logs lease-based activation (S1.4)', async () => {
    const h = setup({ swap: true });
    const { run } = await shadow(h);
    h.children[1].emit('exit', 1, null);
    await tick();
    h.children[0].emit('message', { type: 'reload' });
    await tick();
    h.children[0].emit('exit', 77, null);
    await tick();
    const active = h.children[2];
    for (let i = 0; i < 3; i += 1) {
      active.emit('message', { type: 'reload' });
      await tick();
      expect(h.children).toHaveLength(4 + i);
      h.children.at(-1).emit('exit', 1, null);
      await tick();
    }
    expect(h.logs.join(' ')).toContain('no activation signal');
    expect(h.logs.join(' ')).toContain('lease');
    active.emit('exit', 0, null);
    expect(await run).toBe(0);
  });
});

/** R258: macOS IO/lock waiters inflate load; all capacity evidence here is injected, never sampled. */
import { describe, it, expect, vi } from 'vitest';
import { parseTop, parseMemoryPressure, parseSwap, parseCompressor, parseForge, capacityBand,
  collectHostCapacity, readForge, renderHostCapacity } from '../host-capacity.mjs';
import { resolveHostOverloadSettings } from '../../lib/host-overload-settings.mjs';
const policy = resolveHostOverloadSettings({ env: {}, log: () => {} });
const top = 'CPU usage: 90% user, 9% sys, 1% idle\nCPU usage: 40% user, 22% sys, 38% idle';
const outputs = { top, memory_pressure: 'System-wide memory free percentage: 51%', sysctl: 'vm.swapusage: total = 2G used = 1.5G free = 0.5G', vm_stat: 'Pages occupied by compressor: 12345.' };
const remote = { loadPerCore: 0.2, freeRamPct: 70, activeRuns: 0, maxConcurrent: 1 };
const fixture = (overrides = {}) => ({ policy, exec: vi.fn(file => outputs[file]),
  os: { cpus: () => Array(12), platform: () => 'darwin', loadavg: () => [50, 49, 48] }, clock: () => 1000,
  queue: vi.fn(() => ({ heldCount: 2, cap: 3, waiting: [{}, {}] })), forge: vi.fn(() => ({ reachable: true, ...remote })), ...overrides });
describe('honest host capacity', () => {
  it.each([
    ['top', ['-l', '2', '-n', '0', '-s', '1']],
    ['memory_pressure', []],
    ['sysctl', ['vm.swapusage']],
    ['vm_stat', []],
  ])('bounds the %s local probe to 5000ms and 262144 bytes', (file, args) => {
    const f = fixture();
    collectHostCapacity(f);
    expect(f.exec).toHaveBeenCalledWith(file, args, {
      encoding: 'utf8', timeout: 5000, maxBuffer: 262144,
    });
  });
  it('bounds the Forge SSH probe to 8000ms and 65536 bytes', () => {
    const exec = vi.fn(() => JSON.stringify(remote));
    readForge({ exec, clock: () => 1000, stateRoot: 'fixture-cache',
      readCache: () => undefined, writeCache: () => {} });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith('ssh', expect.any(Array), {
      encoding: 'utf8', timeout: 8000, maxBuffer: 65536,
    });
  });
  it('uses the second top sample and parses memory, swap units and compressor pages', () => {
    expect(parseTop(top)).toBe(38); expect(parseTop(top.split('\n')[0])).toBeNull();
    expect(parseMemoryPressure(outputs.memory_pressure)).toBe(51);
    expect(parseSwap(outputs.sysctl)).toBe(1536); expect(parseCompressor(outputs.vm_stat)).toBe(12345);
    expect(parseTop(top.replace('38%', '138%'))).toBeNull();
    expect(parseMemoryPressure('percentage: 101%')).toBeNull();
    expect(parseSwap('bad')).toBeNull(); expect(parseCompressor('bad')).toBeNull();
  });
  it('admits the high-load idle host and reports queue, reference load and forge', () => {
    const f = fixture(); const r = collectHostCapacity(f);
    expect(r.admitNewWorkers).toBe(true); expect(r.mac.busyCores).toBeCloseTo(7.44);
    expect(r.headroom).toEqual({ mac: 'high', forge: 'high' });
    expect(r.heavyQueue).toEqual({ held: 2, cap: 3, waiting: 2 });
    expect(renderHostCapacity(r)).toContain('reference only');
    expect(f.exec.mock.calls[0][1]).toEqual(['-l', '2', '-n', '0', '-s', '1']);
  });
  it('rounds text percentages, busy cores and loads while preserving numeric telemetry', () => {
    const f = fixture();
    const r = collectHostCapacity({ ...f,
      exec: file => file === 'top' ? top.replace('38%', '38.26%')
        : file === 'memory_pressure' ? 'System-wide memory free percentage: 51.04%' : outputs[file],
      os: { ...f.os, loadavg: () => [50.126, 49, 48.234] },
      forge: () => ({ reachable: true, ...remote, loadPerCore: 0.2367, freeRamPct: 70.26 }),
    });
    expect(renderHostCapacity(r)).toBe([
      'Mac: CPU idle 38.3%; memory free 51%; mac headroom high; busy cores 7.4/12',
      'Load average 50.13, 49.00, 48.23 (reference only); swap used 1536 MB; compressor 12345 pages',
      'Heavy queue: 2/3 held; 2 waiting',
      'Forge: load/core 0.24; RAM free 70.3%; runs 0/1; headroom high',
      'Admit new workers: true',
    ].join('\n'));
    expect(r.mac.idlePct).toBe(38.26); expect(r.mac.freePct).toBe(51.04);
    expect(r.mac.busyCores).toBeCloseTo(7.4088);
    expect(r.mac.loadAverage).toEqual([50.126, 49, 48.234]);
    expect(r.forge.loadPerCore).toBe(0.2367); expect(r.forge.freeRamPct).toBe(70.26);
  });
  it('keeps unknown readings and the operator fallback visible in text', () => {
    const r = collectHostCapacity(fixture({ exec: () => '', forge: () => ({ reachable: false }) }));
    const text = renderHostCapacity(r);
    expect(text).toContain('CPU idle unknown%; memory free unknown%');
    expect(text).toContain('busy cores unknown/12');
    expect(text).toContain('restore host.capacitySignal=load');
    expect(text).toContain('Forge: unreachable; headroom unknown');
    expect(text).toContain('Admit new workers: false');
  });
  it.each([[14, 50, 'low'], [50, 14, 'low'], [15, 50, 'medium'], [50, 29, 'medium'], [30, 30, 'high']])('bands idle=%s free=%s', (idle, free, result) => {
    expect(capacityBand(idle, free, policy.settings.host.capacity)).toBe(result);
  });
  it.each(Object.keys(outputs))('fails closed when %s is unreadable; names an operator fallback', key => {
    const r = collectHostCapacity(fixture({ exec: file => file === key ? 'garbage' : outputs[file] }));
    expect(r.admitNewWorkers).toBe(false); expect(r.headroom.mac).toBe('low');
    expect(r.reason).toContain('unknown'); expect(r.reason).toContain('restore host.capacitySignal=load');
  });
  it('uses custom cascade bands and records provenance', () => {
    const logs = [];
    const p = resolveHostOverloadSettings({ platform: { host: { capacity: { cpuIdleLowPct: 40 } } }, env: { WE_HOST_CAPACITY_CPU_IDLE_MEDIUM_PCT: '50', WE_HOST_CAPACITY_SIGNAL: 'cpu-mem' }, log: s => logs.push(s) });
    expect(collectHostCapacity(fixture({ policy: p })).admitNewWorkers).toBe(false);
    expect(p.sources['host.capacity.cpuIdleLowPct']).toBe('platform');
    expect(logs.join()).toContain('cpu-mem (env)');
    expect(() => resolveHostOverloadSettings({ env: { WE_HOST_CAPACITY_SIGNAL: 'typo' }, log: () => {} })).toThrow();
    expect(() => resolveHostOverloadSettings({ env: { WE_HOST_CAPACITY_CPU_IDLE_LOW_PCT: '40' }, log: () => {} })).toThrow();
  });
  it('marks occupied forge low and unreachable forge unknown without blocking a healthy mac', () => {
    expect(collectHostCapacity(fixture({ forge: () => ({ reachable: true, ...remote, activeRuns: 1 }) })).headroom.forge).toBe('low');
    const r = collectHostCapacity(fixture({ forge: () => { throw Error('offline'); } }));
    expect(r.forge).toEqual({ reachable: false }); expect(r.headroom.forge).toBe('unknown'); expect(r.admitNewWorkers).toBe(true);
  });
  it('uses one bounded SSH call, caches for 60 seconds, and expires it', () => {
    let cache; let now = 1000;
    const exec = vi.fn(() => JSON.stringify(remote));
    const f = { exec, clock: () => now, stateRoot: 'fixture-cache', readCache: () => cache, writeCache: (_, v) => { cache = v; } };
    expect(readForge(f)).toEqual({ reachable: true, ...remote }); readForge(f);
    expect(exec).toHaveBeenCalledOnce(); expect(exec.mock.calls[0][0]).toBe('ssh'); expect(exec.mock.calls[0][2].maxBuffer).toBe(65536);
    now += 60000; readForge(f); expect(exec).toHaveBeenCalledTimes(2);
    now = 0; readForge(f); expect(exec).toHaveBeenCalledTimes(3);
  });
  it('caches unreachable forge and rejects incomplete or oversized evidence', () => {
    let cache; const exec = vi.fn(() => { throw Error('maxBuffer exceeded'); });
    const f = { exec, clock: () => 1000, stateRoot: 'fixture-cache', readCache: () => cache, writeCache: (_, v) => { cache = v; } };
    expect(readForge(f)).toEqual({ reachable: false }); expect(readForge(f)).toEqual({ reachable: false }); expect(exec).toHaveBeenCalledOnce();
    expect(() => parseForge('{}')).toThrow();
  });
});

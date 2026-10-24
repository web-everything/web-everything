import { beforeEach, describe, it, expect, vi } from 'vitest';
import * as hostLoad from '../host-load.mjs';

const policy = { settings: { host: { maxLoadPerCore: 2, minMemoryHeadroomMb: 1000 } }, sources: {} };
const vm = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free: 131072.
Pages active: 262144.
Pages inactive: 65536.
Pages speculative: 32768.
Pages purgeable: 16384.
Pages wired down: 32768.`;
const swap = 'vm.swapusage: total = 2048.00M  used = 1024.00M  free = 1024.00M';
const pressure = 'The system has 68719476736 (4194304 pages with a page size of 16384).\nSystem-wide memory free percentage: 77%';
const denied = () => { throw Object.assign(Error('denied'), { code: 'EPERM' }); };
const opts = { encoding: 'utf8', timeout: 5000 };
const calls = [
  ['vm_stat', [], opts], ['sysctl', ['vm.swapusage'], opts], ['vm_stat', [], opts],
  ['memory_pressure', ['-Q'], opts], ['sysctl', ['hw.memsize'], opts], ['vm_stat', [], opts],
];
const read = (exec, log) => hostLoad.readHostMemoryHeadroom({ env: {}, platform: 'darwin', exec, free: denied, log });
const sequence = (...steps) => steps.reduce((exec, step) => exec.mockImplementationOnce(
  typeof step === 'function' ? step : () => step,
), vi.fn(denied));
const admission = (memory) => hostLoad.hostLoadAdmission({ policy, memory, load: () => [1], cores: () => 4, interactive: false });
beforeEach(() => hostLoad.resetProbeLogForTests());

describe('Darwin memory probe fallback chain', () => {
  it('uses vm_stat+swapusage first and preserves the MB-only wrapper', () => {
    const exec = vi.fn((cmd) => cmd === 'vm_stat' ? vm : swap);
    expect(read(exec)).toEqual({ mb: 1728, probe: 'vm_stat+swapusage' });
    expect(exec.mock.calls).toEqual(calls.slice(0, 2));
    expect(hostLoad.readHostMemoryHeadroomMb({ env: {}, platform: 'darwin', exec })).toBe(1728);
  });
  it('uses vm_stat without swap credit when sandbox sysctl throws EPERM, in order', () => {
    const exec = sequence(vm, denied, vm);
    expect(read(exec)).toEqual({ mb: 704, probe: 'vm_stat' });
    expect(exec.mock.calls).toEqual(calls.slice(0, 3));
  });
  it('uses memory_pressure when vm_stat and sysctl fail', () => {
    const exec = vi.fn((cmd) => cmd === 'memory_pressure' ? pressure : denied());
    expect(read(exec)).toEqual({ mb: 50462.72, probe: 'memory_pressure' });
    expect(exec.mock.calls).toEqual([calls[0], calls[2], calls[3]]);
  });
  it('uses hw.memsize times the vm_stat page ratio after earlier probes fail', () => {
    const exec = sequence(vm, denied, 'bad vm_stat', 'bad pressure', 'hw.memsize: 68719476736', vm);
    expect(read(exec)).toEqual({ mb: 16384, probe: 'hw.memsize+vm_stat' });
    expect(exec.mock.calls).toEqual(calls);
  });
  it.each([
    ['EPERM', denied],
    ['ETIMEDOUT', () => { throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }); }],
    ['malformed outputs', () => 'unparseable'],
    ['non-finite output', () => 'Infinity'],
    ['negative output', () => '-1'],
  ])('throws when all probes fail (%s) and refuses admission with host memory unknown', (_name, fail) => {
    const exec = vi.fn(fail);
    expect(() => read(exec)).toThrow();
    expect(exec).toHaveBeenCalled();
    const result = admission(() => hostLoad.readHostMemoryHeadroomMb({ env: {}, platform: 'darwin', exec, free: denied }));
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('host memory unknown');
  });
  it('rejects malformed swapusage and accepts zero headroom as a valid fallback', () => {
    const exec = sequence(vm, 'bad swapusage', vm.replace(/\d+\./g, '0.'));
    expect(read(exec)).toEqual({ mb: 0, probe: 'vm_stat' });
    expect(exec.mock.calls).toEqual(calls.slice(0, 3));
  });
  it('logs the selected probe once per process across callers and resets for tests', () => {
    const log = vi.fn(); const laterLog = vi.fn();
    read(sequence(vm, denied, vm), log);
    read(sequence(vm, swap), laterLog);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual([expect.stringContaining('vm_stat')]);
    expect(laterLog).not.toHaveBeenCalled();
    hostLoad.resetProbeLogForTests();
    read(sequence(vm, swap), laterLog);
    expect(laterLog).toHaveBeenCalledTimes(1);
    expect(laterLog.mock.calls[0]).toEqual([expect.stringContaining('vm_stat+swapusage')]);
  });
});

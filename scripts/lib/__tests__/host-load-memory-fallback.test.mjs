import { describe, it, expect, vi } from 'vitest';
import * as hostLoad from '../host-load.mjs';

const MB = 1048576;
const vmStat = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free: 65536.',
  'Pages speculative: 16384.',
  'Pages purgeable: 8192.',
  'Pages inactive: 999999.',
].join('\n');
// (65536 + 16384 + 8192) * 16384 / MB = 1408; inactive pages are excluded.
const swapUsage = 'vm.swapusage: total = 1024.00M  used = 768.00M  free = 256.00M';
const denied = () => Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });

function probes({ denySwap = false, denyVm = false, vm = vmStat, swap = swapUsage, free = () => 3072 * MB } = {}) {
  const exec = vi.fn((command) => {
    if (command === 'vm_stat') {
      if (denyVm) throw denied();
      return vm;
    }
    if (command === 'sysctl') {
      if (denySwap) throw denied();
      return swap;
    }
    throw new Error(`Unexpected probe: ${command}`);
  });
  return { env: {}, platform: 'darwin', exec, free: vi.fn(free) };
}

const policy = {
  settings: { host: { maxLoadPerCore: 2, minMemoryHeadroomMb: 1024 } },
  sources: {},
};

function admissionOptions(probe) {
  return {
    policy,
    interactive: false,
    env: {},
    load: () => [1],
    cores: () => 8,
    memory: ({ env }) => hostLoad.readHostMemoryHeadroomMb({ ...probe, env }),
    memoryReading: ({ env }) => hostLoad.readHostMemoryReading({ ...probe, env }),
  };
}

describe('readHostMemoryReading fallback sources', () => {
  it('exports the structured memory reader', () => {
    expect(hostLoad.readHostMemoryReading).toBeTypeOf('function');
  });

  it('preserves vm_stat plus free swap headroom when both probes work', () => {
    const probe = probes();
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: 1664, source: 'vm_stat+swap' });
    expect(probe.free).not.toHaveBeenCalled();
  });

  it('uses vm_stat pages alone without throwing when sysctl is denied with EPERM', () => {
    const probe = probes({ denySwap: true });
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: 1408, source: 'vm_stat' });
    expect(probe.exec.mock.calls.some(([command]) => command === 'sysctl')).toBe(true);
    expect(probe.free).not.toHaveBeenCalled();
  });

  it('uses os.freemem in MB when vm_stat and sysctl are denied', () => {
    const probe = probes({ denyVm: true, denySwap: true });
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: 3072, source: 'os.freemem' });
    expect(probe.free).toHaveBeenCalled();
  });

  describe.each(['vm_stat', 'sysctl'])('%s exec failures', (command) => {
    it.each([
      ['EPERM', 'probe unavailable'],
      ['EACCES', 'probe unavailable'],
      ['ENOENT', 'probe unavailable'],
      [undefined, 'Operation not permitted'],
      [undefined, 'Permission denied'],
      [undefined, 'probe NOT PERMITTED here'],
    ])('falls back on denial/unavailability: code=%s message=%s', (code, message) => {
      const probe = probes();
      const workingExec = probe.exec;
      probe.exec = vi.fn((name, ...args) => {
        if (name === command) throw Object.assign(new Error(message), { code });
        return workingExec(name, ...args);
      });
      expect(hostLoad.readHostMemoryReading(probe)).toEqual(command === 'vm_stat'
        ? { mb: 3072, source: 'os.freemem' }
        : { mb: 1408, source: 'vm_stat' });
    });

    it.each([
      ['ETIMEDOUT', 'probe timed out'],
      [undefined, 'ETIMEDOUT'],
      ['EIO', 'probe failed'],
    ])('refuses non-denial exec errors: code=%s message=%s', (code, message) => {
      const probe = probes();
      const workingExec = probe.exec;
      probe.exec = vi.fn((name, ...args) => {
        if (name === command) throw Object.assign(new Error(message), { code });
        return workingExec(name, ...args);
      });
      expect(() => hostLoad.readHostMemoryHeadroomMb(probe)).toThrow(message);
      const result = hostLoad.hostLoadAdmission(admissionOptions(probe));
      expect(result.admitted).toBe(false);
      expect(result.reason).toContain('host memory unknown');
      expect(probe.free).not.toHaveBeenCalled();
    });
  });

  it.each([NaN, Infinity, -Infinity])('returns unknown without throwing when probes are denied and free() is %s', (value) => {
    const probe = probes({ denyVm: true, denySwap: true, free: () => value });
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: null, source: 'unknown' });
  });

  it('returns unknown without throwing when free() also throws EPERM', () => {
    const probe = probes({ denyVm: true, denySwap: true, free: () => { throw denied(); } });
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: null, source: 'unknown' });
  });

  it('preserves the Vitest override and identifies its source without probing', () => {
    const probe = probes({ denyVm: true, denySwap: true, free: () => { throw denied(); } });
    const env = { VITEST: 'true', WE_TEST_HOST_MEMORY_MB: '512.5' };
    expect(hostLoad.readHostMemoryReading({ ...probe, env })).toEqual({ mb: 512.5, source: 'test-env' });
    expect(hostLoad.readHostMemoryHeadroomMb({ ...probe, env })).toBe(512.5);
    expect(probe.exec).not.toHaveBeenCalled();
    expect(probe.free).not.toHaveBeenCalled();
  });
});

describe('readHostMemoryHeadroomMb numeric compatibility', () => {
  it.each([
    ['working probes', {}, 1664],
    ['denied sysctl', { denySwap: true }, 1408],
    ['denied native probes', { denyVm: true, denySwap: true }, 3072],
  ])('returns the numeric mb for %s', (_name, settings, expected) => {
    expect(hostLoad.readHostMemoryHeadroomMb(probes(settings))).toBe(expected);
  });

  it.each([
    ['non-finite free()', () => NaN],
    ['throwing free()', () => { throw denied(); }],
  ])('returns NaN rather than throwing for unknown memory from %s', (_name, free) => {
    expect(hostLoad.readHostMemoryHeadroomMb(probes({ denyVm: true, denySwap: true, free }))).toBeNaN();
  });
});

describe('hostLoadAdmission memory fallback policy', () => {
  it.each([
    ['malformed vm_stat output', { vm: 'garbage' }],
    ['malformed swap output', { swap: 'garbage' }],
    ['unparseable swap value', { swap: 'free = ..M' }],
  ])('refuses %s instead of falling back', (_name, settings) => {
    const probe = probes(settings);
    expect(() => hostLoad.readHostMemoryHeadroomMb(probe)).toThrow();
    const result = hostLoad.hostLoadAdmission(admissionOptions(probe));
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('host memory unknown');
    expect(probe.free).not.toHaveBeenCalled();
  });

  it('refuses finite negative free() when native probes are denied', () => {
    const probe = probes({ denyVm: true, denySwap: true, free: () => -MB });
    expect(() => hostLoad.readHostMemoryHeadroomMb(probe)).toThrow();
    const result = hostLoad.hostLoadAdmission(admissionOptions(probe));
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('host memory unknown');
  });

  it('admits acceptable load when sysctl is denied and reports source=vm_stat', () => {
    const result = hostLoad.hostLoadAdmission(admissionOptions(probes({ denySwap: true })));
    expect(result.admitted).toBe(true);
    expect(result.reason).toMatch(/source=vm_stat(?:\s|[;,)\]]|$)/);
  });

  it('admits acceptable load using os.freemem when both native probes are denied', () => {
    const result = hostLoad.hostLoadAdmission(admissionOptions(probes({ denyVm: true, denySwap: true })));
    expect(result.admitted).toBe(true);
    expect(result.reason).toContain('source=os.freemem');
  });

  it.each([
    ['NaN free()', () => NaN],
    ['infinite free()', () => Infinity],
    ['negative infinite free()', () => -Infinity],
    ['denied free()', () => { throw denied(); }],
    ['throwing free()', () => { throw new Error('unavailable'); }],
  ])('admits acceptable load with memory unknown after %s', (_name, free) => {
    const result = hostLoad.hostLoadAdmission(admissionOptions(probes({ denyVm: true, denySwap: true, free })));
    expect(result.admitted).toBe(true);
    expect(result.reason).toContain('memory unknown');
  });

  it('still refuses high load per core when all memory sources are unknown', () => {
    const options = admissionOptions(probes({ denyVm: true, denySwap: true, free: () => NaN }));
    const result = hostLoad.hostLoadAdmission({ ...options, load: () => [17] });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('host load 17.00/8=2.13');
    expect(result.reason).toContain('host.maxLoadPerCore=2');
  });

  it('still refuses low measured headroom and preserves the reason with source=vm_stat+swap', () => {
    const vm = vmStat
      .replace('Pages free: 65536.', 'Pages free: 8192.')
      .replace('Pages speculative: 16384.', 'Pages speculative: 4096.')
      .replace('Pages purgeable: 8192.', 'Pages purgeable: 2048.');
    // Free + speculative + purgeable = 224MB, plus 256MB free swap = 480MB.
    const result = hostLoad.hostLoadAdmission(admissionOptions(probes({ vm })));
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('host memory headroom 480MB');
    expect(result.reason).toContain('host.minMemoryHeadroomMb=1024');
    expect(result.reason).toContain('source=vm_stat+swap');
  });
});

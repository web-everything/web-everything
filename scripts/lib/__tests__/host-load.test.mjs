import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as hostLoad from '../host-load.mjs';

const native = vi.hoisted(() => ({ exec: vi.fn(), free: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal(), execFileSync: native.exec,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal(), freemem: native.free,
}));

const MB = 1048576;
const pressureArgs = ['-n', 'kern.memorystatus_vm_pressure_level'];
const opts = { encoding: 'utf8', timeout: 5000 };
const vmStat = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free: 65536.',
  'Pages speculative: 8192.',
  'Pages purgeable: 3584.',
  'Pages inactive: 999999.',
].join('\n');
// (65536 + 8192 + 3584) * 16384 / MB = 1208; no free swap.
const swapUsage = 'vm.swapusage: total = 1024.00M  used = 1024.00M  free = 0.00M';
const reclaimableMb = 16832.984375; // 1208MB + 999999 inactive pages at 16KB/page.
const lowVmStat = vmStat.replace('Pages inactive: 999999.', 'Pages inactive: 0.');
const denied = () => Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });

function probes({ pressure = '1\n', pressureError, denySwap = false, denyVm = false,
  vm = vmStat, swap = swapUsage, vmError, swapError } = {}) {
  const exec = vi.fn((command, args) => {
    if (command === 'sysctl' && args.length === 2
      && args[0] === '-n' && args[1] === pressureArgs[1]) {
      if (pressureError) throw pressureError;
      return pressure;
    }
    if (command === 'vm_stat' && args.length === 0) {
      if (denyVm) throw denied();
      if (vmError) throw vmError;
      return vm;
    }
    if (command === 'sysctl' && args.length === 1 && args[0] === 'vm.swapusage') {
      if (denySwap) throw denied();
      if (swapError) throw swapError;
      return swap;
    }
    throw new Error(`Unexpected probe: ${command} ${JSON.stringify(args)}`);
  });
  return { env: {}, platform: 'darwin', exec, free: vi.fn(() => 3072 * MB) };
}

const policy = {
  settings: { host: { maxLoadPerCore: 2, minMemoryHeadroomMb: 2048 } },
  sources: {},
};

describe('parseDarwinReclaimableMemoryMb', () => {
  it('counts inactive pages and free swap in measured reclaimable memory', () => {
    expect(hostLoad.parseDarwinReclaimableMemoryMb).toBeTypeOf('function');
    const swap = 'vm.swapusage: total = 1024.00M  used = 767.50M  free = 256.50M';
    expect(hostLoad.parseDarwinReclaimableMemoryMb(vmStat, swap)).toBe(17089.484375);
    // Existing callers retain their pages-only definition, excluding inactive pages.
    expect(hostLoad.parseDarwinMemoryHeadroomMb(vmStat, swap)).toBe(1464.5);
  });

  it('throws when Pages inactive is missing', () => {
    expect(hostLoad.parseDarwinReclaimableMemoryMb).toBeTypeOf('function');
    const missingInactive = vmStat.replace('Pages inactive: 999999.', '');
    expect(() => hostLoad.parseDarwinReclaimableMemoryMb(missingInactive, swapUsage)).toThrow();
    expect(hostLoad.parseDarwinMemoryHeadroomMb(missingInactive, swapUsage)).toBe(1208);
  });
});

describe('parseDarwinMemoryPressureLevel', () => {
  it.each([
    ['1', 'normal'], ['2', 'warn'], ['4', 'critical'],
    [' \t1\n', 'normal'], ['\n2 \t', 'warn'], [' 4\r\n', 'critical'],
  ])('parses %j as %s', (text, level) => {
    expect(hostLoad.parseDarwinMemoryPressureLevel).toBeTypeOf('function');
    expect(hostLoad.parseDarwinMemoryPressureLevel(text)).toBe(level);
  });

  it.each(['garbage', '', ' \t\n', '3', '0', '1x', '2x', '4x', '1\n2', '01', '1.0']) (
    'fails closed on unsupported pressure text %j', (text) => {
      expect(hostLoad.parseDarwinMemoryPressureLevel).toBeTypeOf('function');
      expect(() => hostLoad.parseDarwinMemoryPressureLevel(text)).toThrow();
    },
  );
});

describe('readHostMemoryReading Darwin pressure probe', () => {
  it.each([
    ['1\n', 'normal', reclaimableMb],
    ['2\n', 'warn', 0],
    ['4\n', 'critical', 0],
  ])('uses pressure %j first and returns finite headroom for %s', (pressure, level, mb) => {
    const probe = probes({ pressure });
    const reading = hostLoad.readHostMemoryReading(probe);
    expect(reading).toEqual({ mb, source: 'memory-pressure', level });
    expect(Number.isFinite(reading.mb)).toBe(true);
    expect(probe.exec.mock.calls).toEqual(level === 'normal' ? [
      ['sysctl', pressureArgs, opts], ['vm_stat', [], opts], ['sysctl', ['vm.swapusage'], opts],
    ] : [['sysctl', pressureArgs, opts]]);
    expect(probe.free).not.toHaveBeenCalled();
  });

  it.each(['garbage', '', '3', '0', '1x'])('falls back to vm_stat+swap on pressure output %j', (pressure) => {
    const probe = probes({ pressure });
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: 1208, source: 'vm_stat+swap' });
    expect(probe.exec.mock.calls).toEqual([
      ['sysctl', pressureArgs, opts], ['vm_stat', [], opts], ['sysctl', ['vm.swapusage'], opts],
    ]);
    expect(probe.free).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'ENOENT', 'ETIMEDOUT', 'EIO'])('falls back when the pressure sysctl throws %s', (code) => {
    const probe = probes({ pressureError: Object.assign(new Error('pressure unavailable'), { code }) });
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: 1208, source: 'vm_stat+swap' });
    expect(probe.exec).toHaveBeenNthCalledWith(1, 'sysctl', pressureArgs, opts);
    expect(probe.free).not.toHaveBeenCalled();
  });

  it('preserves the vm_stat-only fallback when pressure is invalid and swap is denied', () => {
    const probe = probes({ pressure: 'garbage', denySwap: true });
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: 1208, source: 'vm_stat' });
    expect(probe.free).not.toHaveBeenCalled();
  });

  it('preserves os.freemem fallback when pressure is invalid and vm_stat is denied', () => {
    const probe = probes({ pressure: 'garbage', denyVm: true });
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: 3072, source: 'os.freemem' });
    expect(probe.free).toHaveBeenCalledOnce();
  });

  it('falls back to pages only when swap is denied after normal pressure', () => {
    const probe = probes({ denySwap: true });
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: 1208, source: 'vm_stat' });
    expect(probe.free).not.toHaveBeenCalled();
  });

  it('falls back to os.freemem when vm_stat is denied after normal pressure', () => {
    const probe = probes({ denyVm: true });
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: 3072, source: 'os.freemem' });
    expect(probe.free).toHaveBeenCalledOnce();
  });

  it.each(['vmError', 'swapError'])('throws on a non-denial %s after normal pressure', (key) => {
    const error = Object.assign(new Error('memory probe failed'), { code: 'EIO' });
    const probe = probes({ [key]: error });
    expect(() => hostLoad.readHostMemoryReading(probe)).toThrow(error);
    expect(probe.free).not.toHaveBeenCalled();
  });

  it.each([
    { vm: 'garbage' },
    { vm: vmStat.replace('Pages inactive: 999999.', '') },
    { swap: 'garbage' },
  ])('throws on incomplete memory evidence after normal pressure: %j', (options) => {
    const probe = probes(options);
    expect(() => hostLoad.readHostMemoryReading(probe)).toThrow();
    expect(probe.free).not.toHaveBeenCalled();
  });

  it.each(['linux', 'win32'])('uses only os.freemem off Darwin (%s)', (platform) => {
    const probe = { ...probes(), platform };
    expect(hostLoad.readHostMemoryReading(probe)).toEqual({ mb: 3072, source: 'os.freemem' });
    expect(probe.exec).not.toHaveBeenCalled();
    expect(probe.free).toHaveBeenCalledOnce();
  });

  it('lets the Vitest memory override win over normal pressure without probing', () => {
    const probe = probes();
    const env = { VITEST: 'true', WE_TEST_HOST_MEMORY_MB: '512' };
    expect(hostLoad.readHostMemoryReading({ ...probe, env })).toEqual({ mb: 512, source: 'test-env' });
    expect(probe.exec).not.toHaveBeenCalled();
    expect(probe.free).not.toHaveBeenCalled();
  });
});

describe('hostLoadAdmission with the default memoryReading', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    native.exec.mockReset();
    native.free.mockReset().mockImplementation(() => { throw new Error('Unexpected freemem fallback'); });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
  });

  function admission({ pressure = '1', env = {}, load = () => [1], ...probeOptions } = {}) {
    const probe = probes({ pressure, ...probeOptions });
    native.exec.mockImplementation(probe.exec);
    // Deliberately omit memory and memoryReading to exercise the default reader.
    return hostLoad.hostLoadAdmission({ policy, interactive: false, env, load, cores: () => 8 });
  }

  it('normal above floor admits', () => {
    const result = admission();
    expect(result.admitted).toBe(true);
    expect(result.reason).toContain('source=memory-pressure');
    expect(native.exec).toHaveBeenNthCalledWith(1, 'sysctl', pressureArgs, opts);
    expect(native.free).not.toHaveBeenCalled();
  });

  it('normal below floor holds', () => {
    const result = admission({ vm: lowVmStat });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('source=memory-pressure');
    expect(result.reason).toContain('host.minMemoryHeadroomMb=2048');
    expect(native.exec).toHaveBeenCalledWith('vm_stat', [], opts);
    expect(native.exec).toHaveBeenCalledWith('sysctl', ['vm.swapusage'], opts);
    expect(native.free).not.toHaveBeenCalled();
  });

  it('normal exactly at floor admits', () => {
    const vm = vmStat.replace('Pages inactive: 999999.', 'Pages inactive: 53760.');
    const result = admission({ vm });
    expect(result.admitted).toBe(true);
    expect(result.reason).toContain('source=memory-pressure');
    expect(native.exec).toHaveBeenCalledWith('vm_stat', [], opts);
  });

  it('warn holds', () => {
    const result = admission({ pressure: '2' });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('source=memory-pressure');
    expect(native.exec.mock.calls).toEqual([['sysctl', pressureArgs, opts]]);
    expect(native.free).not.toHaveBeenCalled();
  });

  it('holds on pages-only fallback when swap is denied after normal pressure', () => {
    const result = admission({ denySwap: true });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('headroom 1208MB');
    expect(result.reason).toContain('source=vm_stat');
    expect(native.free).not.toHaveBeenCalled();
  });

  it.each(['vmError', 'swapError'])('holds on non-denial %s after normal pressure', (key) => {
    const result = admission({ [key]: Object.assign(new Error('memory probe failed'), { code: 'EIO' }) });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('host memory unknown: memory probe failed');
    expect(native.free).not.toHaveBeenCalled();
  });

  it.each([
    { vm: 'garbage' },
    { vm: vmStat.replace('Pages inactive: 999999.', '') },
    { swap: 'garbage' },
  ])('holds on incomplete memory evidence after normal pressure: %j', (options) => {
    const result = admission(options);
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('host memory unknown:');
    expect(native.free).not.toHaveBeenCalled();
  });

  it.each(['2', '4'])('holds at pressure level %s and reports memory-pressure provenance', (pressure) => {
    const result = admission({ pressure });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('source=memory-pressure');
    expect(native.free).not.toHaveBeenCalled();
  });

  it('holds on garbage pressure output using the 1208MB vm_stat+swap fallback', () => {
    const result = admission({ pressure: 'garbage' });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('headroom 1208MB');
    expect(result.reason).toContain('host.minMemoryHeadroomMb=2048');
    expect(result.reason).toContain('source=vm_stat+swap');
    expect(native.exec).toHaveBeenNthCalledWith(1, 'sysctl', pressureArgs, opts);
    expect(native.free).not.toHaveBeenCalled();
  });

  it('still holds on a low Vitest memory override even with normal pressure available', () => {
    const result = admission({ env: { VITEST: 'true', WE_TEST_HOST_MEMORY_MB: '512' } });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('source=test-env');
    expect(native.exec).not.toHaveBeenCalled();
    expect(native.free).not.toHaveBeenCalled();
  });

  it('still holds on high load even with normal pressure available', () => {
    const result = admission({ load: () => [17] });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('host load 17.00/8=2.13');
    expect(native.exec).not.toHaveBeenCalled();
    expect(native.free).not.toHaveBeenCalled();
  });
});

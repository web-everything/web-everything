import { beforeEach, describe, it, expect, vi } from 'vitest';
import * as hostLoad from '../host-load.mjs';

const policy = { settings: { host: { maxLoadPerCore: 2, minMemoryHeadroomMb: 1000 } }, sources: {} };
const vm = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free: 131072.
Pages speculative: 0.
Pages purgeable: 0.`;
const swap = 'vm.swapusage: total = 2048.00M  used = 1024.00M  free = 1024.00M';
const probeFailures = [
  ['sysctl vm.swapusage denied (EPERM)', (command) => {
    if (command === 'sysctl') throw Object.assign(Error('sysctl vm.swapusage denied'), { code: 'EPERM' });
    return vm;
  }],
  ['malformed vm_stat', (command) => command === 'vm_stat' ? 'unparseable vm_stat' : swap],
  ['malformed swapusage', (command) => command === 'vm_stat' ? vm : 'unparseable swapusage'],
  ['exec timeout (ETIMEDOUT)', () => { throw Object.assign(Error('probe timed out'), { code: 'ETIMEDOUT' }); }],
];
const admission = (options = {}) => hostLoad.hostLoadAdmission({
  policy, interactive: false, load: () => [1], cores: () => 4, ...options,
});
const memoryProbe = (exec) => () => hostLoad.readHostMemoryHeadroomMb({ env: {}, platform: 'darwin', exec });

beforeEach(() => {
  // Keep behavioral regressions runnable before the required helper is implemented.
  if (typeof hostLoad.resetProbeFailureLogForTests === 'function') hostLoad.resetProbeFailureLogForTests();
});

describe('host admission tolerates unavailable memory probes', () => {
  it('exports a test reset helper for the process-wide probe failure log', () => {
    expect(hostLoad.resetProbeFailureLogForTests).toBeTypeOf('function');
  });

  it.each(probeFailures)('admits under CPU rules without throwing and logs once across repeated admissions: %s', (_name, implementation) => {
    const exec = vi.fn(implementation); const log = vi.fn();
    const memory = memoryProbe(exec);
    for (let i = 0; i < 3; i++) {
      let result;
      expect(() => { result = admission({ memory, log }); }).not.toThrow();
      expect(result.admitted).toBe(true);
      expect(result.reason).toContain('host memory unknown');
      expect(result.reason).toContain('no memory headroom credit');
    }
    expect(exec).toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(' ')).toContain('host memory unknown');
  });

  it('logs only once across different failure types and admission callers in the same process', () => {
    const firstLog = vi.fn(); const laterLog = vi.fn();
    for (const [index, [, exec]] of probeFailures.entries()) {
      expect(admission({ memory: memoryProbe(exec), log: index === 0 ? firstLog : laterLog }).admitted).toBe(true);
    }
    expect(firstLog).toHaveBeenCalledTimes(1);
    expect(laterLog).not.toHaveBeenCalled();
  });

  it('reset helper permits logging a subsequent probe failure again', () => {
    expect(hostLoad.resetProbeFailureLogForTests).toBeTypeOf('function');
    const log = vi.fn(); const memory = memoryProbe(probeFailures[0][1]);
    admission({ memory, log });
    expect(log).toHaveBeenCalledTimes(1);
    hostLoad.resetProbeFailureLogForTests();
    admission({ memory, log });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it.each(probeFailures)('still refuses over-limit CPU load with a failing memory probe: %s', (_name, exec) => {
    const result = admission({ memory: memoryProbe(exec), load: () => [9], log: vi.fn() });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('host load');
    expect(result.reason).toContain('host.maxLoadPerCore=2');
  });

  it.each([
    ['non-finite load', () => [NaN]],
    ['unreadable load', () => { throw Error('load unavailable'); }],
  ])('still refuses unknown CPU load with a failing memory probe: %s', (_name, load) => {
    const result = admission({ memory: memoryProbe(probeFailures[0][1]), load, log: vi.fn() });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('host load unknown');
  });

  it('still refuses known memory headroom below the minimum', () => {
    const log = vi.fn();
    const result = admission({ memory: () => 999, log });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('host memory headroom 999MB');
    expect(result.reason).toContain('host.minMemoryHeadroomMb=1000');
    expect(log).not.toHaveBeenCalled();
  });

  it('still admits a healthy macOS memory probe without logging a failure', () => {
    const exec = vi.fn((command) => command === 'vm_stat' ? vm : swap); const log = vi.fn();
    const result = admission({ memory: memoryProbe(exec), log });
    expect(result.admitted).toBe(true);
    expect(result.reason).toContain('host memory headroom 1536MB');
    expect(result.reason).not.toContain('host memory unknown');
    expect(exec.mock.calls).toEqual([
      ['vm_stat', [], { encoding: 'utf8', timeout: 5000 }],
      ['sysctl', ['vm.swapusage'], { encoding: 'utf8', timeout: 5000 }],
    ]);
    expect(log).not.toHaveBeenCalled();
  });
});

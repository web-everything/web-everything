import { describe, expect, it, vi } from 'vitest';
import { memoryFreePct, parseVmStatAvailableBytes } from '../memory-available.mjs';
import { resolveHostOverloadSettings } from '../host-overload-settings.mjs';
import * as hostOverloadSettings from '../host-overload-settings.mjs';
import { createSampler } from '../resource-sampler.mjs';

// Live 2026-11-04 00:2x ET fixture: free 215784, inactive 1392455, speculative 41509, purgeable 1289, 16 KiB pages.
const VM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   215784.
Pages active:                                1409867.
Pages inactive:                              1392455.
Pages speculative:                             41509.
Pages throttled:                                   0.
Pages wired down:                             779873.
Pages purgeable:                                1289.
`;
const TOTAL = 3_839_000 * 16384;
describe('memory-available', () => {
  it('sums free+inactive+speculative+purgeable pages', () => {
    expect(parseVmStatAvailableBytes(VM)).toBe((215784 + 1392455 + 41509 + 1289) * 16384);
    expect(parseVmStatAvailableBytes('junk')).toBeNull();
  });
  it('available reads far above the os.freemem figure; free keeps the old reading', () => {
    const o = { platform: 'darwin', exec: () => VM, totalmem: () => TOTAL, freemem: () => TOTAL * 0.069 };
    expect(memoryFreePct({ ...o, metric: 'free' })).toBe(6.9);
    expect(memoryFreePct({ ...o, metric: 'available' })).toBeGreaterThan(40);
    expect(memoryFreePct(o)).toBeGreaterThan(40); // default is available
  });
  it('falls back to freemem when vm_stat is unreadable; real pressure still reads low', () => {
    expect(memoryFreePct({ platform: 'darwin', exec: () => 'x', totalmem: () => 100, freemem: () => 5 })).toBe(5);
    const low = VM.replace(/inactive:\s+\d+/, 'inactive: 100').replace(/free:\s+\d+/, 'free: 100');
    expect(memoryFreePct({ platform: 'darwin', exec: () => low, totalmem: () => TOTAL })).toBeLessThan(3);
  });
  it('falls back to freemem when vm_stat execution times out', () => {
    const exec = () => { throw Object.assign(new Error('vm_stat timed out'), { code: 'ETIMEDOUT' }); };
    expect(memoryFreePct({ platform: 'darwin', exec, totalmem: () => 100, freemem: () => 5 })).toBe(5);
  });
  it('rejects unreadable freemem after vm_stat execution fails', () => {
    const exec = () => { throw new Error('vm_stat failed'); };
    expect(() => memoryFreePct({ platform: 'darwin', exec, totalmem: () => 100, freemem: () => NaN }))
      .toThrow('invalid memory totals');
  });
  it('a throwing vm_stat degrades to the stricter freemem reading', () => {
    expect(memoryFreePct({ platform: 'darwin', exec: () => { throw Error('denied'); }, totalmem: () => 100, freemem: () => 5 })).toBe(5);
  });
  it('metric is a setting with env override and validation', () => {
    const base = { platform: {}, tool: {}, log: () => {} };
    expect(resolveHostOverloadSettings({ ...base, env: {} }).settings.host.capacity.memoryMetric).toBe('available');
    expect(resolveHostOverloadSettings({ ...base, env: { WE_HOST_CAPACITY_MEMORY_METRIC: 'free' } }).settings.host.capacity.memoryMetric).toBe('free');
    expect(() => resolveHostOverloadSettings({ ...base, env: { WE_HOST_CAPACITY_MEMORY_METRIC: 'x' } })).toThrow();
  });
  it.each([
    ['available', 43],
    ['free', 6.9],
  ])('the sampler honors host.capacity.memoryMetric=%s on macOS', (metric, expectedPct) => {
    const policy = resolveHostOverloadSettings({ platform: {}, tool: {},
      env: { WE_HOST_CAPACITY_MEMORY_METRIC: metric }, log: () => {} });
    const settingsLookup = vi.spyOn(hostOverloadSettings, 'loadHostOverloadSettings').mockReturnValue(policy);
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
      const exec = (cmd) => (cmd === 'vm_stat' ? VM : cmd === 'sysctl' ? '1' : '');
      const s = createSampler({ checkoutRoot: process.cwd(), exec, now: () => 0, cpus: () => [], freemem: () => TOTAL * 0.069, totalmem: () => TOTAL,
        readHeavySlots: () => ({ held: 0, cap: 1 }), countLanes: () => 0 });
      expect(s.sample().memory.freePct).toBe(expectedPct);
      expect(settingsLookup).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      settingsLookup.mockRestore();
    }
  });
});

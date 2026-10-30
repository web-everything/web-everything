import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnTimeoutMs } from './spawn-timeout.mjs';

describe('spawnTimeoutMs', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.SPAWN_TIMEOUT_MS_OVERRIDE;
    vi.spyOn(os, 'cpus').mockReturnValue(Array(12).fill({}));
    vi.spyOn(os, 'loadavg').mockReturnValue([0, 0, 0]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([0, 3, 6])('keeps the base timeout at load %s', load => {
    os.loadavg.mockReturnValue([load, 0, 0]);
    expect(spawnTimeoutMs()).toBe(30_000);
  });

  it('scales by twice the one-minute load per CPU, including a custom base', () => {
    os.loadavg.mockReturnValue([15, 100, 100]);
    expect(spawnTimeoutMs()).toBe(75_000);
    expect(spawnTimeoutMs(10_000)).toBe(25_000);
  });

  it.each([36, 1000])('caps scaling at 6x at load %s', load => {
    os.loadavg.mockReturnValue([load, 0, 0]);
    expect(spawnTimeoutMs()).toBe(180_000);
  });

  it.each(['1234', '240000'])('uses explicit override %s without scaling or capping', value => {
    os.loadavg.mockReturnValue([1000, 0, 0]);
    vi.stubEnv('SPAWN_TIMEOUT_MS_OVERRIDE', value);
    expect(spawnTimeoutMs()).toBe(Number(value));
    expect(spawnTimeoutMs(10_000)).toBe(Number(value));
  });

  it.each(['', 'invalid', '0', '-1', 'Infinity', '1.5'])('rejects invalid override %j', value => {
    vi.stubEnv('SPAWN_TIMEOUT_MS_OVERRIDE', value);
    expect(() => spawnTimeoutMs()).toThrow('SPAWN_TIMEOUT_MS_OVERRIDE must be a positive integer');
  });
});

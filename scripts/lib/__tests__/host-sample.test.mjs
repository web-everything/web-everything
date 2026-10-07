import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTopIdle, parseMemoryFree, readHostSample, sampleHost } from '../host-sample.mjs';

describe('host sample', () => {
  it('parses the last top CPU line and memory_pressure', () => {
    expect(parseTopIdle('CPU usage: 1% user, 1% sys, 98.0% idle\nCPU usage: 41.2% user, 42.0% sys, 16.8% idle \n')).toBe(16.8);
    expect(parseTopIdle('garbage')).toBeNull();
    expect(parseMemoryFree('System-wide memory free percentage: 86%')).toBe(86);
  });
  it('a failing command yields ok:false, never throws', () => {
    const r = readHostSample({ platform: 'darwin', exec: () => { throw new Error('x'); } });
    expect(r).toMatchObject({ ok: false, idlePct: null });
  });
  it('caches across callers within the ttl', () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), 'hs-')), 'c.json');
    let n = 0; let t = 1000;
    const read = () => ({ ok: true, idlePct: 10 + (n += 1), memFreePct: 50 });
    expect(sampleHost({ read, now: () => t, cachePath }).idlePct).toBe(11);
    t += 3000; expect(sampleHost({ read, now: () => t, cachePath }).idlePct).toBe(11);
    t += 3000; expect(sampleHost({ read, now: () => t, cachePath }).idlePct).toBe(12);
  });
});

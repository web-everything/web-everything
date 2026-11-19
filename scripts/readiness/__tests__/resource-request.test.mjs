import { describe, expect, it } from 'vitest';
import { KIND_DEFAULTS, validateRequest, makeRequest, validateGrant, validateUsageRow,
  legacyRequestFromSlotUnits, estimateRequest } from '../resource-request.mjs';

const G = 1024 ** 3;
const now = Date.parse('2026-11-18T12:00:00Z');
const day = 86400000;
const row = (overrides = {}) => ({ ts: now, kind: 'full', key: 'vitest run',
  threadsGranted: 4, memGranted: 4 * G, cpuUsec: 1000000, runMs: 1000,
  memoryPeakBytes: G, throttledUsec: 0, nrThrottled: 0, oomKills: 0,
  code: 0, backend: 'systemd-scope', ...overrides });
const rows = (count = 5, overrides = {}) => Array.from({ length: count }, (_, i) =>
  row({ ts: now - (count - i) * 1000, ...overrides }));
const estimate = (options = {}) => estimateRequest({ kind: 'full', key: 'vitest run',
  rows: rows(), now, ...options });

describe('thread-budget estimator acceptance', () => {
  it('settles at one thread for a 1.0 mean over five runs', () => {
    expect(estimate()).toMatchObject({ threads: 1, source: 'history' });
  });
  it('requests six threads after five throttled runs granted four', () => {
    expect(estimate({ rows: rows(5, { throttledUsec: 300000 }) }).threads).toBe(6);
  });
  it('keeps the p90 demand as a floor when growth would request fewer threads', () => {
    const throttled = rows(5, { cpuUsec: 10000000, throttledUsec: 300000, threadsGranted: 1 });
    expect(estimate({ rows: throttled }).threads).toBe(12);
  });
  it('doubles the rounded memory estimate after an OOM', () => {
    const normal = estimate();
    expect(normal.memBytes).toBe(1.5 * G);
    expect(estimate({ rows: rows(5, { oomKills: 1 }) }).memBytes).toBe(normal.memBytes * 2);
  });
  it('caps files at the two selected files for history, defaults and overrides', () => {
    const options = { kind: 'files', selectedFileCount: 2 };
    expect(estimate({ ...options, rows: rows(5, { kind: 'files', cpuUsec: 8000000 }) }).threads).toBe(2);
    expect(estimate({ ...options, rows: [] }).threads).toBeLessThanOrEqual(2);
    expect(estimate({ ...options, overrides: { threads: 16 } }).threads).toBe(2);
  });
  it('uses the kind default with fewer than three rows', () => {
    for (const count of [0, 1, 2]) {
      expect(estimate({ rows: rows(count) })).toMatchObject({
        threads: KIND_DEFAULTS.full.threads, memBytes: KIND_DEFAULTS.full.memBytes, source: 'kind-default',
      });
    }
    expect(estimate({ rows: rows(3) }).source).toBe('history');
  });
  it('defaults other and unknown kinds to one thread and 2G', () => {
    for (const kind of ['other', 'custom', '__proto__', 'constructor']) {
      expect(estimate({ kind, rows: [] })).toMatchObject({ threads: 1, memBytes: 2 * G, source: 'kind-default' });
    }
  });
  it('preserves legacy slotUnits=3 as 24 threads (2400%) and 36G', () => {
    expect(legacyRequestFromSlotUnits(3)).toEqual({
      v: 1, kind: 'other', key: 'legacy', threads: 24, memBytes: 36 * G, source: 'legacy',
    });
    expect(estimate({ kind: 'custom', rows: [], slotUnits: 3 })).toMatchObject({
      threads: 16, memBytes: 24 * G, source: 'legacy',
    });
  });
  it('rejects slotUnits above the 256-slot ceiling', () => {
    expect(legacyRequestFromSlotUnits(256).threads).toBe(2048);
    expect(() => legacyRequestFromSlotUnits(257)).toThrow();
    expect(() => estimate({ kind: 'custom', rows: [], slotUnits: 257 })).toThrow();
  });
  it('clamps explicit overrides and records declared provenance', () => {
    expect(estimate({ overrides: { threads: '99', mem: '100G' } })).toMatchObject({
      threads: 16, memBytes: 24 * G, source: 'declared',
    });
    expect(estimate({ rows: [], overrides: { mem: '512M' } })).toMatchObject({
      threads: 8, memBytes: G / 2, source: 'declared',
    });
  });
  it('ignores rows older than fourteen days, future rows and different identities', () => {
    const ignored = [
      ...rows(5, { ts: now - 14 * day - 1 }), ...rows(5, { ts: now + 1 }),
      ...rows(5, { kind: 'soak' }), ...rows(5, { key: 'other command' }),
    ];
    expect(estimate({ rows: ignored }).source).toBe('kind-default');
    expect(estimate({ rows: [...ignored, ...rows(3, { ts: now - 14 * day })] }).source).toBe('history');
  });
});

describe('estimator windows, quantiles and bounds', () => {
  it('uses only the newest twenty rows, sorting by timestamp without mutating input', () => {
    const input = [...rows(3, { ts: now - day, cpuUsec: 12000000 }), ...rows(20)].reverse();
    const before = structuredClone(input);
    expect(estimate({ rows: input }).threads).toBe(1);
    expect(input).toEqual(before);
  });
  it('uses nearest-rank p90 CPU with 20% headroom and p95 memory rounded to 512M', () => {
    const input = rows(20).map((r, i) => ({ ...r,
      cpuUsec: i < 18 ? 2000000 : 10000000, memoryPeakBytes: i < 19 ? 2 * G : 10 * G }));
    expect(estimate({ rows: input })).toMatchObject({ threads: 3, memBytes: 3 * G });
  });
  it('uses a strict throttle ratio and requires three of the latest five', () => {
    expect(estimate({ rows: rows(5, { throttledUsec: 200000 }) }).threads).toBe(1);
    const input = rows(7, { throttledUsec: 300000 });
    input.slice(-3).forEach(r => { r.throttledUsec = 0; });
    expect(estimate({ rows: input }).threads).toBe(1);
    input.at(-1).throttledUsec = 200001;
    input.at(-1).threadsGranted = 5;
    expect(estimate({ rows: input }).threads).toBe(8);
  });
  it('does not double memory for an OOM outside the last five', () => {
    const input = rows(6);
    input[0].oomKills = 1;
    expect(estimate({ rows: input }).memBytes).toBe(1.5 * G);
  });
  it('floors estimated memory at 1G and caps excessive history and OOM growth', () => {
    expect(estimate({ rows: rows(5, { memoryPeakBytes: 0 }) }).memBytes).toBe(G);
    expect(estimate({ rows: rows(5, { memoryPeakBytes: 30 * G, cpuUsec: 50000000,
      threadsGranted: 16, throttledUsec: 300000, oomKills: 1 }) })).toMatchObject({ threads: 16, memBytes: 24 * G });
  });
  it('honors smaller injected limits on defaults, history, expansion and overrides', () => {
    const limits = { maxThreadsPerOp: 2, maxMemPerOp: G };
    for (const options of [{ rows: [] }, {}, { overrides: { threads: 100, mem: '20G' } }]) {
      const result = estimate({ ...options, limits });
      expect(result.threads).toBeLessThanOrEqual(2);
      expect(result.memBytes).toBe(G);
      expect(result.maxThreads).toBe(2);
    }
  });
  it('accepts ISO usage timestamps and requires an injected clock value', () => {
    expect(estimate({ rows: rows(5, { ts: new Date(now).toISOString() }) }).source).toBe('history');
    expect(() => estimate({ now: undefined })).toThrow(TypeError);
  });
  it('rejects incomplete evidence rather than estimating from corrupt rows', () => {
    expect(() => estimate({ rows: [row({ cpuUsec: null })] })).toThrow(TypeError);
    expect(() => estimate({ rows: null })).toThrow(TypeError);
  });
});

describe('resource shape validation', () => {
  const request = () => ({ v: 1, kind: 'files', key: 'vitest run', threads: 2, memBytes: 2 * G, source: 'declared' });
  it('returns fresh validated shapes and clamps request resources to caps', () => {
    const req = request();
    expect(validateRequest(req)).toEqual(req);
    expect(validateRequest(req)).not.toBe(req);
    expect(validateRequest({ ...req, threads: 99, memBytes: 99 * G })).toMatchObject({ threads: 16, memBytes: 24 * G });
    expect(validateUsageRow(row())).toEqual(row());
  });
  it('permits expansion only for full, FULL, soak and standards', () => {
    for (const kind of ['full', 'FULL', 'soak', 'standards']) {
      expect(makeRequest({ kind, key: 'command' }).maxThreads).toBe(16);
    }
    for (const kind of ['files', 'other', 'custom']) {
      expect(makeRequest({ kind, key: 'command' })).not.toHaveProperty('maxThreads');
      expect(() => validateRequest({ ...request(), kind, maxThreads: 8 })).toThrow(TypeError);
    }
    expect(Object.isFrozen(KIND_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(KIND_DEFAULTS.files)).toBe(true);
    expect(KIND_DEFAULTS.files.maxThreads).toBe(KIND_DEFAULTS.files.threads);
  });
  it.each([null, {}, [], { ...request(), extra: true }, { ...request(), v: 2 },
    { ...request(), key: '' }, { ...request(), kind: 'bad\nkind' }, { ...request(), source: 'unknown' },
    ...[0, -1, 1.5, NaN, Infinity, '2', null].map(threads => ({ ...request(), threads })),
    ...[0, -1, 1.5, Infinity].map(memBytes => ({ ...request(), memBytes })),
    { ...request(), kind: 'full', maxThreads: 1 }, { ...request(), kind: 'full', maxThreads: undefined },
  ])('rejects invalid request shape %#', req => expect(() => validateRequest(req)).toThrow(TypeError));
  it('validates grants and the unenforced soft backend', () => {
    for (const backend of ['soft', 'systemd-scope', 'container']) {
      const grant = { threads: 2, memBytes: G, backend, enforced: backend !== 'soft' };
      expect(validateGrant(grant)).toEqual(grant);
      for (const bad of [{}, { ...grant, backend: 'unknown' }, { ...grant, enforced: 1 },
        { ...grant, threads: 0 }, { ...grant, memBytes: null }, { ...grant, extra: true }]) {
        expect(() => validateGrant(bad)).toThrow(TypeError);
      }
    }
    expect(() => validateGrant({ threads: 1, memBytes: G, backend: 'soft', enforced: true })).toThrow(TypeError);
  });
  it.each(['ts', 'kind', 'key', 'threadsGranted', 'memGranted', 'cpuUsec', 'runMs',
    'memoryPeakBytes', 'throttledUsec', 'nrThrottled', 'oomKills', 'code', 'backend'])(
    'rejects a usage row missing %s', field => {
      const incomplete = row(); delete incomplete[field];
      expect(() => validateUsageRow(incomplete)).toThrow(TypeError);
    });
  it.each([{ ts: 'yesterday' }, { ts: NaN }, { ts: -1 }, { cpuUsec: null }, { cpuUsec: -1 },
    { runMs: 0 }, { memoryPeakBytes: Infinity }, { throttledUsec: -1 }, { nrThrottled: 1.5 },
    { oomKills: -1 }, { code: '0' }, { backend: 'unknown' }, { extra: true }])(
    'rejects invalid usage evidence %#', bad => expect(() => validateUsageRow(row(bad))).toThrow(TypeError));
  it('rejects invalid overrides, limits, file counts and legacy units', () => {
    for (const overrides of [{ threads: 0 }, { threads: '1.5' }, { mem: 'bad' }, { mem: 0 }, { extra: 1 }, null]) {
      expect(() => estimate({ overrides })).toThrow(TypeError);
    }
    for (const limits of [{}, { maxThreadsPerOp: 0, maxMemPerOp: G }, { maxThreadsPerOp: 2, maxMemPerOp: NaN }]) {
      expect(() => estimate({ limits })).toThrow(TypeError);
    }
    for (const selectedFileCount of [0, -1, 1.5]) expect(() => estimate({ selectedFileCount })).toThrow(TypeError);
    for (const units of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER]) {
      expect(() => legacyRequestFromSlotUnits(units)).toThrow(TypeError);
    }
    expect(() => makeRequest({ kind: 'full', key: 'command', extra: 1 })).toThrow(TypeError);
  });
});

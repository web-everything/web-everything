/**
 * @file scripts/conveyor/__tests__/health-watch-operation-runs-bounded.test.mjs
 * @description The health watch tick was OOM-killed (4 GB heap) because `probeOperationRuns` parsed EVERY run
 *   record in every clone's `.operations/runs` (live: ~80,000 records, several GB). The probe must read a bounded,
 *   newest-first, in-window slice, however large the directories grow. These cases fail on the unbounded reader.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeOperationRuns, OPERATION_RUNS_MAX_AGE_MS } from '../health-watch.mjs';

const NOW = Date.parse('2026-10-07T12:00:00Z');
let root;
let runs;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hw-runs-'));
  runs = join(root, '.operations', 'runs');
  mkdirSync(runs, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(name, body, ageMs) {
  const p = join(runs, name);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  const t = (NOW - ageMs) / 1000;
  utimesSync(p, t, t);
}

describe('probeOperationRuns is bounded', () => {
  it('never parses records older than the look-back window', () => {
    put('fresh.json', { id: 'fresh' }, 60_000);
    for (let i = 0; i < 200; i += 1) put(`old-${i}.json`, { id: `old-${i}` }, OPERATION_RUNS_MAX_AGE_MS + 3_600_000);
    const got = probeOperationRuns({ roots: [root], jobsRoot: null, nowMs: NOW });
    expect(got.map((r) => r.id)).toEqual(['fresh']);
  });

  it('skips a record over the per-file size cap (a multi-MB one never enters memory)', () => {
    put('huge.json', { id: 'huge', pad: 'x'.repeat(2048) }, 1000);
    put('ok.json', { id: 'ok' }, 2000);
    const got = probeOperationRuns({ roots: [root], jobsRoot: null, nowMs: NOW, maxFileBytes: 1024 });
    expect(got.map((r) => r.id)).toEqual(['ok']);
  });

  it('keeps only the newest maxRecords of a very large directory', () => {
    for (let i = 0; i < 400; i += 1) put(`r-${i}.json`, { id: `r-${i}` }, 1000 + i * 1000);
    const got = probeOperationRuns({ roots: [root], jobsRoot: null, nowMs: NOW, maxRecords: 25 });
    expect(got).toHaveLength(25);
    expect(got[0].id).toBe('r-0');
    expect(got.at(-1).id).toBe('r-24');
  });

  it('caps the total bytes parsed per tick', () => {
    for (let i = 0; i < 50; i += 1) put(`b-${i}.json`, { id: `b-${i}`, pad: 'y'.repeat(900) }, 1000 + i * 1000);
    const got = probeOperationRuns({ roots: [root], jobsRoot: null, nowMs: NOW, maxTotalBytes: 5 * 1000 });
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThanOrEqual(6);
  });

  it('counts a symlinked checkout once', () => {
    put('a.json', { id: 'a' }, 1000);
    const alias = mkdtempSync(join(tmpdir(), 'hw-alias-'));
    try {
      mkdirSync(join(alias, '.operations'), { recursive: true });
      symlinkSync(runs, join(alias, '.operations', 'runs'));
      const got = probeOperationRuns({ roots: [root, alias], jobsRoot: null, nowMs: NOW });
      expect(got).toHaveLength(1);
    } finally { rmSync(alias, { recursive: true, force: true }); }
  });
});

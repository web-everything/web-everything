import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createAsyncShadow, summarize } from '../lib/drain-async-shadow.mjs';

const roots = [];
const temp = () => { const dir = mkdtempSync(join(process.env.TMPDIR, 'async-shadow-')); roots.push(dir); return dir; };
const lines = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
const candidate = { repo: 'owner/repo', num: 7, headSha: 'head-a', readyAtMs: 10 };
const key = c => `${c.repo}#${c.num}@${c.headSha}`;
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('async drain shadow measurement', () => {
  it('retires superseded and absent heads so two empty passes freeze head A after head B enqueues', () => {
    const dir = temp();
    const shadow = createAsyncShadow({ mode: 'shadow', dir, now: () => 100 });
    shadow.observePass({ candidates: [candidate] });
    shadow.observePass({ candidates: [candidate] });
    const next = { ...candidate, headSha: 'head-b' };
    shadow.observePass({ candidates: [next] });
    shadow.recordActual(next);
    shadow.observePass({ candidates: [] });
    createAsyncShadow({ mode: 'shadow', dir, now: () => 200 }).observePass({ candidates: [] });
    const rows = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).records;
    expect(rows.find(row => row.headSha === 'head-a')).toMatchObject({ retired: true, readyNotReached: 1 });
    expect(rows.find(row => row.headSha === 'head-b').readyNotReached).toBe(0);
  });

  it('retires pending rows past the retention bound even while still a candidate', () => {
    const dir = temp(); let clock = 100;
    const shadow = createAsyncShadow({ mode: 'shadow', dir, now: () => clock, retentionMs: 50 });
    shadow.observePass({ candidates: [candidate] });
    clock = 151;
    shadow.observePass({ candidates: [candidate] });
    shadow.observePass({ candidates: [candidate] });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).records[0])
      .toMatchObject({ retired: true, readyNotReached: 0 });
  });

  it('freezes absent pending rows across invocations and prunes them after retirement retention', () => {
    const dir = temp(); let clock = 100;
    const shadow = createAsyncShadow({ mode: 'shadow', dir, now: () => clock, retentionMs: 50 });
    shadow.observePass({ candidates: [candidate] });
    shadow.observePass({ candidates: [candidate] });
    shadow.observePass({ candidates: [] });
    const resumed = createAsyncShadow({ mode: 'shadow', dir, now: () => clock, retentionMs: 50 });
    resumed.observePass({ candidates: [] });
    resumed.noteSkipReason(key(candidate), 'stale');
    resumed.recordActual(candidate);
    expect(resumed.emitSummary()).toEqual({ n: 0, medianDeltaMs: null, p90DeltaMs: null, readyNotReached: 1, reasons: {} });
    clock = 151;
    resumed.observePass({ candidates: [] });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).records).toEqual([]);
  });

  it('a prestage fallback observation in the same pass does not count a later missed pass', () => {
    const shadow = createAsyncShadow({ mode: 'shadow', dir: temp(), now: () => 100 });
    shadow.observePass({ candidates: [candidate] });
    shadow.observePass({ candidates: [candidate], countMissed: false });
    expect(shadow.emitSummary().readyNotReached).toBe(0);
    shadow.observePass({ candidates: [candidate] });
    expect(shadow.emitSummary().readyNotReached).toBe(1);
  });

  it.each([undefined, 'live', 'typo'])('is off by default and for unknown modes (%s)', mode => {
    const dir = join(temp(), 'disabled');
    const shadow = createAsyncShadow({ env: {}, mode, dir });
    shadow.observePass({ candidates: [candidate] });
    shadow.recordActual(candidate);
    expect(existsSync(dir)).toBe(false);
  });

  it('shadow and off preserve the caller enqueue list and all inputs; off writes nothing', () => {
    const run = mode => {
      const dir = join(temp(), 'measurements');
      const shadow = createAsyncShadow({ mode, dir, now: () => 100 });
      const candidates = [structuredClone(candidate)];
      const before = structuredClone(candidates);
      const enqueuedKeys = new Set();
      shadow.observePass({ candidates, enqueuedKeys });
      const enqueued = candidates.map(c => { shadow.recordActual(c); return key(c); });
      shadow.noteSkipReason(key(candidate), 'budget');
      shadow.emitSummary();
      expect(candidates).toEqual(before);
      expect(enqueuedKeys).toEqual(new Set());
      if (mode === 'off') expect(existsSync(dir)).toBe(false);
      return enqueued;
    };
    expect(run('shadow')).toEqual(run('off'));
  });

  it('records once per head, preserves first eligibility, and deduplicates a fresh instance', () => {
    const dir = temp(); let clock = 100;
    const shadow = createAsyncShadow({ mode: 'shadow', dir, now: () => clock });
    shadow.observePass({ candidates: [candidate] });
    clock = 200;
    shadow.observePass({ candidates: [{ ...candidate, readyAtMs: 99 }] });
    shadow.recordActual(candidate);
    shadow.recordActual(candidate);
    const next = { ...candidate, headSha: 'head-b', readyAtMs: 400 };
    shadow.observePass({ candidates: [next] });
    clock = 500;
    shadow.recordActual(next);
    createAsyncShadow({ mode: 'shadow', dir, now: () => 900 }).recordActual(candidate);
    expect(lines(join(dir, 'shadow.jsonl'))).toEqual([
      { repo: candidate.repo, num: 7, headSha: 'head-a', readyAt: 10, wouldEnqueueAt: 100, actualEnqueueAt: 200, deltaMs: 100 },
      { repo: candidate.repo, num: 7, headSha: 'head-b', readyAt: 400, wouldEnqueueAt: 400, actualEnqueueAt: 500, deltaMs: 100 },
    ]);
  });

  it('summarizes exact median, nearest-rank p90, later missed passes and reasons without mutation', () => {
    const fixture = [10, 20, 30, 40].map(deltaMs => ({ deltaMs, actualEnqueueAt: 100, readyNotReached: 1, reasons: { budget: 2 } }));
    fixture.push({ actualEnqueueAt: null, readyNotReached: 3, reasons: { lock: 1 } });
    const before = structuredClone(fixture);
    expect(summarize(fixture)).toEqual({ n: 4, medianDeltaMs: 25, p90DeltaMs: 40, readyNotReached: 7, reasons: { budget: 8, lock: 1 } });
    expect(fixture).toEqual(before);
    expect(summarize([])).toEqual({ n: 0, medianDeltaMs: null, p90DeltaMs: null, readyNotReached: 0, reasons: {} });
  });

  it('counts only later unenqueued passes, honors enqueuedKeys, and emits aggregated reasons', () => {
    const dir = temp();
    const shadow = createAsyncShadow({ mode: 'shadow', dir, now: () => 100 });
    shadow.observePass({ candidates: [candidate] });
    expect(shadow.emitSummary().readyNotReached).toBe(0);
    shadow.observePass({ candidates: [candidate] });
    shadow.noteSkipReason(key(candidate), 'budget');
    shadow.noteSkipReason(key(candidate), 'budget');
    shadow.observePass({ candidates: [candidate], enqueuedKeys: new Set([key(candidate)]) });
    shadow.recordActual(candidate);
    shadow.observePass({ candidates: [] });
    expect(shadow.emitSummary()).toEqual({ n: 1, medianDeltaMs: 0, p90DeltaMs: 0, readyNotReached: 1, reasons: { budget: 2 } });
  });

  it('integration: separate drain invocations retain pending eligibility and count later ready-not-reached passes', () => {
    const dir = temp();
    const program = `
      import { createAsyncShadow } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/lib/drain-async-shadow.mjs')).href)};
      const shadow = createAsyncShadow({ mode: 'shadow', dir: process.argv[1], now: () => Number(process.argv[2]) });
      const candidate = ${JSON.stringify(candidate)};
      shadow.observePass({ candidates: [candidate] });
      if (process.argv[3] === 'record') shadow.recordActual(candidate);
      else shadow.noteSkipReason(${JSON.stringify(key(candidate))}, 'budget');
      console.log(JSON.stringify(shadow.emitSummary()));
    `;
    const invoke = (at, action = 'observe') => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, dir, String(at), action], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    expect(invoke(100)).toEqual({ n: 0, medianDeltaMs: null, p90DeltaMs: null, readyNotReached: 0, reasons: { budget: 1 } });
    expect(invoke(200)).toEqual({ n: 0, medianDeltaMs: null, p90DeltaMs: null, readyNotReached: 1, reasons: { budget: 2 } });
    const completed = { n: 1, medianDeltaMs: 200, p90DeltaMs: 200, readyNotReached: 2, reasons: { budget: 2 } };
    expect(invoke(300, 'record')).toEqual(completed);
    expect(invoke(400, 'record')).toEqual(completed);
    expect(lines(join(dir, 'shadow.jsonl'))).toHaveLength(1);
  });

  it('rotates both logs at the exact byte bound and replaces the old backup', () => {
    const dir = temp();
    for (const name of ['shadow.jsonl', 'summary.jsonl']) {
      writeFileSync(join(dir, name), '12345');
      writeFileSync(join(dir, `${name}.1`), 'old');
    }
    const shadow = createAsyncShadow({ mode: 'shadow', dir, maxBytes: 5, now: () => 100 });
    shadow.observePass({ candidates: [candidate] });
    shadow.recordActual(candidate);
    shadow.emitSummary();
    for (const name of ['shadow.jsonl', 'summary.jsonl']) {
      expect(readFileSync(join(dir, `${name}.1`), 'utf8')).toBe('12345');
      expect(lines(join(dir, name))).toHaveLength(1);
    }
    createAsyncShadow({ mode: 'shadow', dir, maxBytes: 5 }).recordActual(candidate);
    expect(lines(join(dir, 'shadow.jsonl'))).toHaveLength(1);
  });

  it('swallows filesystem failures when the directory is a file', () => {
    const dir = join(temp(), 'file'); writeFileSync(dir, 'occupied');
    expect(() => {
      const shadow = createAsyncShadow({ mode: 'shadow', dir });
      shadow.observePass({ candidates: [candidate] });
      shadow.recordActual(candidate);
      shadow.emitSummary();
    }).not.toThrow();
  });

  it('explicit shadow resolves the coordination root from env', () => {
    const root = temp();
    const shadow = createAsyncShadow({ env: { WE_ASYNC_DRAIN: 'shadow', WE_COORDINATION_ROOT: root }, now: () => 100 });
    shadow.observePass({ candidates: [candidate] }); shadow.recordActual(candidate);
    expect(lines(join(root, 'drain-async-shadow', 'shadow.jsonl'))).toHaveLength(1);
  });

  it('uses now for absent ready time and optionally summarizes every N observed passes', () => {
    const dir = temp();
    const shadow = createAsyncShadow({ mode: 'shadow', dir, now: () => 100, summaryEvery: 2 });
    shadow.observePass({ candidates: [{ ...candidate, readyAtMs: undefined }] });
    expect(existsSync(join(dir, 'summary.jsonl'))).toBe(false);
    shadow.recordActual(candidate);
    shadow.observePass({ candidates: [] });
    expect(lines(join(dir, 'shadow.jsonl'))[0].readyAt).toBe(100);
    expect(lines(join(dir, 'summary.jsonl'))).toHaveLength(1);
  });
});

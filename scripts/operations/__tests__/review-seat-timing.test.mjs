import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatTiming, seatTimingReport, withSeatTiming } from '../review-seat-timing-core.mjs';
import { readSeatTimingReport } from '../review-seat-timing.mjs';
import { speculativeSeatTimings } from '../../lib/review-speculative-red-team.mjs';
import { createFileRunStore } from '../run-store.mjs';
import { createRegistry, op } from '../registry.mjs';
import { compute } from '../step-kinds.mjs';
import { startRun } from '../engine.mjs';

const at = seconds => new Date(Date.parse('2026-10-16T12:00:00Z') + seconds * 1000).toISOString();
const row = (seat, finish, verdict = 'accept') => seatTiming({ seat, lens: seat, provider: 'codex', model: 'test', startedAt: at(0), finishedAt: finish === null ? null : at(finish), verdict, findingsCount: verdict === 'changes' ? 1 : 0 });
const run = (id, seats) => ({ id, op: 'review-pr', input: { pr: 1, repo: 'example/repo' }, seatTimings: seats });

describe('review seat timing', () => {
  it('computes actual finish spread, median, nearest-rank p90 and a strict >5 minute share', () => {
    const records = [run('a', [row('security', 701), row('correctness', 100, 'changes')]),
      run('b', [row('correctness', 100, 'changes'), row('red-team', 400)]),
      run('c', [row('correctness', 20), row('codex', 20)]),
      run('partial', [row('correctness', 1), row('red-team', null)]), { op: 'review-pr', id: 'legacy' }];
    const report = seatTimingReport(records);
    expect(report.runs.map(r => r.spreadMs)).toEqual([601000, 300000, 0, null]);
    expect(report.summary).toEqual({ runs: 4, completeRuns: 3, incompleteRuns: 1, medianSpreadMs: 300000, p90SpreadMs: 601000, earlyChangeRequestRuns: 1, earlyChangeRequestShare: 1 / 3 });
    expect(seatTimingReport(records, { since: at(1) }).runs).toEqual([]);
    expect(() => seatTimingReport(records, { since: 'garbage' })).toThrow('--since');
    expect(seatTimingReport([]).summary.earlyChangeRequestShare).toBeNull();
  });

  it('updates one attempt, retains retries, and round-trips the exact shape through the existing store read-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seat-timing-'));
    try {
      const registry = createRegistry();
      registry.register(op('review-pr', { input: {}, read: compute({ reads: [], fn: () => ({}) }) }));
      let record = startRun({ op: 'review-pr', id: 'review-pr-1', input: {}, registry });
      record = withSeatTiming(record, row('correctness', null));
      record = withSeatTiming(record, row('correctness', 100, 'changes'));
      record = withSeatTiming(record, { ...row('correctness', 200), startedAt: at(101) });
      expect(record.seatTimings).toHaveLength(2);
      const grouped = withSeatTiming(withSeatTiming({ seatTimings: [] }, row('advisory', 100)), { ...row('advisory', 100), lens: 'security' });
      expect(grouped.seatTimings).toHaveLength(2);
      const store = createFileRunStore(dir);
      store.write(record);
      const before = readFileSync(join(dir, 'review-pr-1.json'), 'utf8');
      const report = readSeatTimingReport({ env: { OPERATION_RUNS_DIR: dir } });
      expect(report.runs[0].seats).toEqual(record.seatTimings);
      const cli = JSON.parse(execFileSync(process.execPath, ['scripts/operations/review-seat-timing.mjs', '--json', '--since=2026-10-16T00:00:00Z'], { env: { ...process.env, OPERATION_RUNS_DIR: dir }, encoding: 'utf8' }));
      expect(cli.summary.completeRuns).toBe(1);
      expect(cli.runs[0].spreadMs).toBe(100000);
      expect(readFileSync(join(dir, 'review-pr-1.json'), 'utf8')).toBe(before);
      expect(readdirSync(dir)).toEqual(['review-pr-1.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps speculative model-call times on discarded passes, and leaves killed finishes unknown', () => {
    const pass = { startedAt: at(1), finishedAt: at(100), provider: 'codex', model: 'test', parsed: { 'red-team': { verdict: 'changes' } }, findings: [{}], timings: { startedAt: 0, finishedAt: 999999 } };
    expect(speculativeSeatTimings(pass)[0]).toEqual({ ...row('red-team', 100, 'changes'), startedAt: at(1) });
    expect(speculativeSeatTimings(null, { startedAt: at(2), provider: 'codex' })[0].finishedAt).toBeNull();
  });
});

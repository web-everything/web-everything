// @vitest-environment node
/** Hermetic duration evidence and bounded argv-only GitHub wiring. */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { collectDurations, formatTable, main, parseArgs, percentiles, summarizeDurations } from '../ci-durations.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/ci-durations.json', import.meta.url), 'utf8'));
const transport = JSON.parse(readFileSync(new URL('./fixtures/ci-durations-transport.json', import.meta.url), 'utf8'));
const list = transport.list;
const fake = (data = transport) => vi.fn((_file, args) => {
  if (args[1] === 'list') return JSON.stringify(data.list);
  if (args[1] === 'view') return JSON.stringify(data.views[args[2]]);
  const id = /runs\/(\d+)\/jobs/.exec(args[1])[1];
  return JSON.stringify(data.apiJobs[id]);
});

describe('ci-durations', () => {
  it('computes interpolated per-job and run p50/p90, with job-specific runner wait', () => {
    const report = summarizeDurations(fixture);
    expect(report.jobs.integration).toEqual({ duration: { count: 2, p50: 90, p90: 114 }, wait: { count: 2, p50: 20, p90: 28 } });
    expect(report.runs).toEqual({ duration: { count: 2, p50: 180, p90: 228 }, wait: { count: 2, p50: 20, p90: 28 } });
    expect(percentiles([7])).toEqual({ count: 1, p50: 7, p90: 7 });
    expect(percentiles([9, 1, 5])).toEqual({ count: 3, p50: 5, p90: 8.2 });
  });

  it('ignores skipped, incomplete, invalid and reversed job timestamps, never fabricating zero wait', () => {
    const job = fixture[0].jobs[0];
    const jobs = [
      { ...job, name: 'no-created', createdAt: undefined },
      { ...job, name: 'skipped', conclusion: 'skipped' },
      { ...job, name: 'running', status: 'in_progress' },
      { ...job, name: 'missing', completedAt: undefined },
      { ...job, name: 'invalid', startedAt: 'bad' },
      { ...job, name: 'reversed', startedAt: job.completedAt, completedAt: job.startedAt },
    ];
    const report = summarizeDurations([{ ...fixture[0], jobs }, { ...fixture[1], status: 'in_progress' }]);
    expect(Object.keys(report.jobs)).toEqual(['no-created']);
    expect(report.jobs['no-created'].wait).toEqual({ count: 0, p50: null, p90: null });
    expect(report.runs.duration.count).toBe(1);
    expect(formatTable(report)).toContain('n/a');
    expect(summarizeDurations([]).runs.duration.count).toBe(0);
  });

  it('caps oversized limits at ten and refuses unknown, empty and invalid options', () => {
    expect(parseArgs([])).toEqual({ workflow: 'ci.yml', branch: 'main', limit: 10, json: false });
    expect(parseArgs(['--limit=999', '--workflow=other.yml', '--branch=topic', '--json'])).toEqual({ workflow: 'other.yml', branch: 'topic', limit: 10, json: true });
    for (const arg of ['--limit=0', '--limit=-1', '--limit=1.5', '--limit=NaN', '--workflow=', '--unknown=x']) {
      expect(() => parseArgs([arg])).toThrow();
    }
  });

  it('uses one bounded list and exactly one jobs-only view per run through injected argv IO', () => {
    const exec = fake();
    const report = collectDurations(parseArgs(['--branch=$(touch inert)']), exec);
    expect(report.runs).toEqual(summarizeDurations(fixture).runs);
    expect(report.jobs).toEqual(summarizeDurations(fixture).jobs);
    expect(exec.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['gh', ['run', 'list', '--workflow', 'ci.yml', '--branch', '$(touch inert)', '--limit', '10', '--status', 'completed', '--json', 'databaseId,status,conclusion,createdAt,startedAt,updatedAt']],
      ['gh', ['run', 'view', '1', '--json', 'jobs']],
      ['gh', ['api', 'repos/{owner}/{repo}/actions/runs/1/jobs?per_page=100&filter=latest']],
      ['gh', ['run', 'view', '2', '--json', 'jobs']],
      ['gh', ['api', 'repos/{owner}/{repo}/actions/runs/2/jobs?per_page=100&filter=latest']],
    ]);
    for (const [, , options] of exec.mock.calls) expect(options).toEqual({ encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...list[0], databaseId: i + 1 }));
    const bounded = vi.fn((_file, args) => JSON.stringify(args[1] === 'list' ? ten : args[1] === 'view' ? { jobs: [] } : { total_count: 0, jobs: [] }));
    collectDurations(parseArgs(['--limit=1000']), bounded);
    expect(bounded).toHaveBeenCalledTimes(21);
    expect(bounded.mock.calls[0][1]).toContain('10');
  });


  it('collects nonzero job wait from actual CLI jobs without createdAt and REST snake_case timestamps', () => {
    for (const view of Object.values(transport.views)) {
      expect(view.jobs[0]).not.toHaveProperty('createdAt');
    }
    expect(transport.apiJobs['1'].jobs[0]).toHaveProperty('created_at');
    const report = collectDurations(parseArgs([]), fake());
    expect(report.jobs.integration.wait).toEqual({ count: 2, p50: 20, p90: 28 });
    // Join by ID, even when API order differs from CLI order.
    const data = structuredClone(transport);
    data.apiJobs['1'].jobs.unshift({ ...data.apiJobs['1'].jobs[0], id: 999, created_at: '2026-11-01T00:00:00Z' });
    data.apiJobs['1'].total_count = 2;
    expect(collectDurations(parseArgs([]), fake(data)).jobs.integration.wait).toEqual(report.jobs.integration.wait);
  });

  it('rejects incomplete, oversized or unmatched REST creation evidence without a partial report', () => {
    const invalid = [
      {}, { total_count: 101, jobs: [] }, { total_count: 2, jobs: [] },
      { total_count: 1, jobs: [{ ...transport.apiJobs['1'].jobs[0], created_at: undefined }] },
      { total_count: 1, jobs: [{ ...transport.apiJobs['1'].jobs[0], created_at: 'invalid' }] },
      { total_count: 1, jobs: [{ ...transport.apiJobs['1'].jobs[0], created_at: '2026-11-02T00:00:00Z' }] },
      { total_count: 1, jobs: [{ ...transport.apiJobs['1'].jobs[0], id: 999 }] },
      { total_count: 2, jobs: Array(2).fill(transport.apiJobs['1'].jobs[0]) },
    ];
    for (const api of invalid) {
      const data = structuredClone(transport);
      data.apiJobs['1'] = api;
      const exec = fake(data), output = vi.fn();
      expect(() => main([], exec, output)).toThrow(/inspect/);
      expect(output).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledTimes(3);
    }
  });

  it('ignores skipped and incomplete CLI jobs without requiring REST creation timestamps', () => {
    const data = structuredClone(transport);
    data.views['1'].jobs.push(
      { ...data.views['1'].jobs[0], databaseId: 999, conclusion: 'skipped' },
      { ...data.views['1'].jobs[0], databaseId: 998, status: 'in_progress', completedAt: undefined },
    );
    expect(collectDurations(parseArgs([]), fake(data)).jobs.integration.wait.count).toBe(2);
  });

  it('fails closed on unreadable or oversized evidence and missing jobs; prints no partial report', () => {
    for (const response of ['bad json', '{}', JSON.stringify([...list, ...list]), JSON.stringify([{ ...list[0], databaseId: 'bad' }])]) {
      const output = vi.fn();
      expect(() => main(['--limit=2'], () => response, output)).toThrow();
      expect(output).not.toHaveBeenCalled();
    }
    expect(() => collectDurations(parseArgs([]), (_file, args) => JSON.stringify(args[1] === 'list' ? list : {}))).toThrow(/jobs array/);
    const output = vi.fn();
    expect(() => main([], () => { throw new Error('gh failed'); }, output)).toThrow('gh failed');
    expect(output).not.toHaveBeenCalled();
  });

  it('prints JSON or a compact table and strips terminal controls from job names', () => {
    const output = vi.fn();
    main(['--json'], fake(), output);
    expect(JSON.parse(output.mock.calls[0][0])).toEqual(summarizeDurations(fixture));
    main([], fake(), output);
    expect(output.mock.calls[1][0]).toContain('Run (end=updatedAt)');
    expect(output.mock.calls[1][0]).toContain('integration\t2\t90.0\t114.0\t2\t20.0\t28.0');
    const report = summarizeDurations([{ ...fixture[0], jobs: [{ ...fixture[0].jobs[0], name: '\u001b[31mjob\n' }] }]);
    expect(formatTable(report)).not.toContain('\u001b');
  });
});

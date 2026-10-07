// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyRunner, compareRunners, fetchShardJobs, formatTable, main, normalizeJob, percentile,
} from '../shard-runner-compare.mjs';

const X86 = ['ubuntu-latest'];
const ARM = ['ubuntu-24.04-arm'];
const T0 = Date.parse('2026-10-06T12:00:00Z');
const iso = (offsetSec) => new Date(T0 + offsetSec * 1000).toISOString();

/** REST-shaped job: queued 30s, then `runSec` of run time. */
function job({ run, sha = `sha${run}`, shard = 1, labels = X86, runSec = 120, conclusion = 'success', at = run * 1000 }) {
  return {
    run_id: run, head_sha: sha, name: `test-shard (${shard})`, conclusion, labels,
    created_at: iso(at), started_at: iso(at + 30), completed_at: iso(at + 30 + runSec),
  };
}

describe('classifyRunner', () => {
  it('buckets by labels and never guesses without runner info', () => {
    expect(classifyRunner({ labels: ARM })).toBe('arm');
    expect(classifyRunner({ labels: ['ubuntu-24.04-arm64'] })).toBe('arm');
    expect(classifyRunner({ labels: X86 })).toBe('x86');
    expect(classifyRunner({ labels: ['self-hosted', 'linux', 'ARM64'] })).toBe('arm');
    expect(classifyRunner({ labels: [], runnerName: 'GitHub Actions 7' })).toBe('x86');
    expect(classifyRunner({ labels: [], runnerName: 'arm-runner-3' })).toBe('arm');
    expect(classifyRunner({})).toBe('unknown');
  });

  it('does not treat words that merely contain "arm" as Arm', () => {
    expect(classifyRunner({ labels: ['warm-pool'] })).toBe('x86');
  });
});

describe('percentile', () => {
  it('uses nearest-rank (always an observed value)', () => {
    const v = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(15);
    expect(percentile(v, 90)).toBe(27);
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('normalizeJob', () => {
  it('accepts the gh --json camelCase shape and fills run-level context', () => {
    const n = normalizeJob(
      { name: 'test-shard (2)', conclusion: 'success', startedAt: iso(0), completedAt: iso(60), labels: [{ name: 'ubuntu-24.04-arm' }] },
      { runId: 9, headSha: 'abc' },
    );
    expect(n).toMatchObject({ runId: 9, headSha: 'abc', startedAt: iso(0), labels: ARM });
  });
});

describe('compareRunners', () => {
  it('groups shard durations by runner and reports median, p90, failures', () => {
    const jobs = [];
    [60, 120, 180, 240, 300].forEach((s, i) => jobs.push(job({ run: i + 1, runSec: s })));
    [30, 60, 90].forEach((s, i) => jobs.push(job({ run: 10 + i, labels: ARM, runSec: s })));
    const r = compareRunners(jobs);
    expect(r.x86).toMatchObject({ runs: 5, shardJobs: 5, medianMin: 3, p90Min: 5, failures: 0, flakes: 0, medianQueueMin: 0.5 });
    expect(r.arm).toMatchObject({ runs: 3, medianMin: 1, p90Min: 1.5 });
  });

  it('ignores non-shard jobs and cancelled/skipped shards', () => {
    const r = compareRunners([
      job({ run: 1 }),
      { ...job({ run: 1 }), name: 'test' },
      job({ run: 2, conclusion: 'cancelled' }),
      job({ run: 3, conclusion: 'skipped' }),
      job({ run: 4, conclusion: null }),
    ]);
    expect(r.x86.shardJobs).toBe(1);
    expect(r.x86.failures).toBe(0);
  });

  it('counts a failure that passes on re-run of the same commit as a flake, attributed to the failed runner', () => {
    const r = compareRunners([
      job({ run: 1, sha: 'same', shard: 2, labels: ARM, conclusion: 'failure' }),
      job({ run: 2, sha: 'same', shard: 2, labels: X86, conclusion: 'success' }),
    ]);
    expect(r.arm).toMatchObject({ failures: 1, flakes: 1 });
    expect(r.x86).toMatchObject({ failures: 0, flakes: 0 });
  });

  it('counts a failure that never passed as a failure, not a flake; timed_out is a failure', () => {
    const r = compareRunners([
      job({ run: 1, sha: 'a', shard: 1, conclusion: 'failure' }),
      job({ run: 2, sha: 'b', shard: 1, conclusion: 'timed_out' }),
      // same commit passing a DIFFERENT shard must not mask shard 1's failure
      job({ run: 1, sha: 'a', shard: 3, conclusion: 'success' }),
    ]);
    expect(r.x86).toMatchObject({ failures: 2, flakes: 0 });
  });

  it('keeps only the newest N runs per runner type', () => {
    const jobs = Array.from({ length: 6 }, (_, i) => job({ run: i + 1, runSec: (i + 1) * 60 }));
    const r = compareRunners(jobs, { perRunner: 3 });
    expect(r.x86.runs).toBe(3);
    expect(r.x86.medianMin).toBe(5); // newest three: 4, 5, 6 min
  });

  it('buckets jobs with no runner info as unknown instead of folding them into x86', () => {
    const r = compareRunners([{ ...job({ run: 1 }), labels: undefined }]);
    expect(r.unknown.runs).toBe(1);
    expect(r.x86).toBeUndefined();
  });

  it('survives missing timestamps (no NaN, no throw)', () => {
    const r = compareRunners([{ run_id: 1, head_sha: 'a', name: 'test-shard (1)', conclusion: 'success', labels: X86 }]);
    expect(r.x86).toMatchObject({ shardJobs: 0, medianMin: null, p90Min: null });
  });
});

describe('formatTable', () => {
  it('renders x86 before arm and n/a for missing numbers', () => {
    const t = formatTable(compareRunners([job({ run: 1 }), job({ run: 2, labels: ARM })]));
    const lines = t.split('\n');
    expect(lines[0]).toMatch(/median shard min.*p90 shard min.*failures.*flakes/);
    expect(lines[2]).toMatch(/^\| x86 \|/);
    expect(lines[3]).toMatch(/^\| arm \|/);
  });

  it('says so when there is nothing to tabulate', () => {
    expect(formatTable({})).toMatch(/no completed test-shard jobs/);
  });
});

describe('fetchShardJobs + main wiring (fake gh)', () => {
  const dirs = [];
  afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const fakeGh = (cmd, args) => {
    if (args[0] === 'run') return JSON.stringify([{ databaseId: 11, headSha: 'sha11' }, { databaseId: 12, headSha: 'sha12' }]);
    const id = Number(/runs\/(\d+)\/jobs/.exec(args[1])[1]);
    return JSON.stringify({
      jobs: [
        { id: 1, name: 'test', conclusion: 'success', labels: X86 },
        { id: 2, name: 'test-shard (1)', conclusion: 'success', labels: id === 11 ? X86 : ARM, created_at: iso(0), started_at: iso(30), completed_at: iso(150) },
      ],
    });
  };

  it('pulls only shard jobs and stamps run-level fields from the run list', () => {
    const jobs = fetchShardJobs({ exec: fakeGh });
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => [j.runId, j.headSha])).toEqual([[11, 'sha11'], [12, 'sha12']]);
  });

  it('main() prints the table end to end from gh output', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = main([], { exec: fakeGh });
    expect(result.x86.runs).toBe(1);
    expect(result.arm.runs).toBe(1);
    expect(out.mock.calls.join('')).toMatch(/\| x86 \| 1 \| 1 \| 2 \|/);
  });

  it('main() --input re-analyses a saved jobs file without calling gh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shard-compare-'));
    dirs.push(dir);
    const file = join(dir, 'jobs.json');
    writeFileSync(file, JSON.stringify([job({ run: 1 })]));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exec = vi.fn();
    main([`--input=${file}`, '--json'], { exec });
    expect(exec).not.toHaveBeenCalled();
    expect(JSON.parse(out.mock.calls.join('')).x86.runs).toBe(1);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, EXPECTED_MATRIX_JOBS, REQUIRED_JOBS } from '../mq-result-reuse.mjs';

const SHA = 'a'.repeat(40);
const ok = (name) => ({ name, conclusion: 'success' });
const fullJobs = () => [...EXPECTED_MATRIX_JOBS, ...REQUIRED_JOBS].map(ok);
const run = (over = {}) => ({ id: 7, head_sha: SHA, event: 'merge_group', status: 'completed', conclusion: 'success', ...over });

const apiFor = (runs, jobs, total = jobs.length) => async (path) => (path.includes('/jobs') ? { jobs, total_count: total } : { workflow_runs: runs });
const go = (runs, jobs, extra = {}) => decide({ api: apiFor(runs, jobs), repo: 'o/r', sha: SHA, event: 'push', quarantineClear: async () => true, ...extra });
const without = (name) => fullJobs().filter((j) => j.name !== name);

describe('mq-result-reuse (forge.merge-queue: reuse only for the exact same sha, full run)', () => {
  it('reuses an identical full successful merge-queue run', async () => {
    const v = await go([run()], fullJobs());
    expect(v.reuse).toBe(true);
    expect(v.runId).toBe(7);
  });
  it('runs fully for a different sha', async () => {
    expect((await go([run({ head_sha: 'b'.repeat(40) })], fullJobs())).reuse).toBe(false);
  });
  it('runs fully for a partial MQ run: any missing or skipped shard or aggregate job', async () => {
    for (const name of ['test-shard (10)', 'integration-part (parallel)', 'soak-shard (8)', 'coverage-merge', 'smoke', 'daemon-soak']) {
      expect((await go([run()], without(name))).reuse, name).toBe(false);
      const skipped = fullJobs().map((j) => (j.name === name ? { ...j, conclusion: 'skipped' } : j));
      expect((await go([run()], skipped)).reuse, `${name} skipped`).toBe(false);
    }
  });
  it('runs fully for a failed or unfinished MQ run', async () => {
    expect((await go([run({ conclusion: 'failure' })], fullJobs())).reuse).toBe(false);
    expect((await go([run({ status: 'in_progress', conclusion: null })], fullJobs())).reuse).toBe(false);
  });
  it('a newer failed run for the same sha beats an older success', async () => {
    expect((await go([run({ id: 7 }), run({ id: 9, conclusion: 'failure' })], fullJobs())).reuse).toBe(false);
  });
  it('runs fully with an incomplete jobs listing', async () => {
    expect((await go([run()], fullJobs(), { api: apiFor([run()], fullJobs(), 999) })).reuse).toBe(false);
    expect((await go([run()], fullJobs(), { api: async (p) => (p.includes('/jobs') ? {} : { workflow_runs: [run()] }) })).reuse).toBe(false);
  });
  it('runs fully when a red-main quarantine is active or unreadable', async () => {
    expect((await go([run()], fullJobs(), { quarantineClear: async () => false })).reuse).toBe(false);
  });
  it('runs fully with no MQ run, a non-merge_group run, a non-push event, or an API error', async () => {
    expect((await go([], fullJobs())).reuse).toBe(false);
    expect((await go([run({ event: 'push' })], fullJobs())).reuse).toBe(false);
    expect((await go([run()], fullJobs(), { event: 'pull_request' })).reuse).toBe(false);
    const boom = async () => {
      throw new Error('GitHub API 500');
    };
    expect((await decide({ api: boom, repo: 'o/r', sha: SHA, event: 'push' })).reuse).toBe(false);
  });
  it('expected job names match the ci.yml matrices', () => {
    const yml = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    expect(yml).toContain('shard: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]');
    expect(yml).toContain('shard: [1, 2, 3, 4, 5, 6, 7, 8]');
    expect(yml).toContain('group: [scan-chain, sim-scenarios, lane-pool-a, lane-pool-b, parallel]');
    expect(EXPECTED_MATRIX_JOBS).toHaveLength(23);
  });
});

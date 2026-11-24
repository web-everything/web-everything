import { describe, expect, it } from 'vitest';
import { decide } from '../mq-result-reuse.mjs';

const SHA = 'a'.repeat(40);
const ok = (name) => ({ name, conclusion: 'success' });
const fullJobs = [ok('test-shard (1)'), ok('integration-part (scan-chain)'), ok('soak-shard (1)'), ok('test'), ok('smoke')];
const run = (over = {}) => ({ id: 7, head_sha: SHA, event: 'merge_group', status: 'completed', conclusion: 'success', ...over });

const apiFor = (runs, jobs) => async (path) => (path.includes('/jobs') ? { jobs } : { workflow_runs: runs });
const go = (runs, jobs, extra = {}) => decide({ api: apiFor(runs, jobs), repo: 'o/r', sha: SHA, event: 'push', ...extra });

describe('mq-result-reuse', () => {
  it('reuses an identical full successful merge-queue run', async () => {
    const v = await go([run()], fullJobs);
    expect(v.reuse).toBe(true);
    expect(v.runId).toBe(7);
  });
  it('runs fully for a different sha', async () => {
    expect((await go([run({ head_sha: 'b'.repeat(40) })], fullJobs)).reuse).toBe(false);
  });
  it('runs fully for a partial MQ run (soak or unit skipped)', async () => {
    expect((await go([run()], fullJobs.filter((j) => !j.name.startsWith('soak-shard')))).reuse).toBe(false);
    expect((await go([run()], [...fullJobs, { name: 'test', conclusion: 'skipped' }])).reuse).toBe(false);
    expect((await go([run()], [...fullJobs, { name: 'test-shard (2)', conclusion: 'skipped' }])).reuse).toBe(false);
  });
  it('runs fully for a failed or unfinished MQ run', async () => {
    expect((await go([run({ conclusion: 'failure' })], fullJobs)).reuse).toBe(false);
    expect((await go([run({ status: 'in_progress', conclusion: null })], fullJobs)).reuse).toBe(false);
  });
  it('runs fully with no MQ run, a non-merge_group run, a non-push event, or an API error', async () => {
    expect((await go([], fullJobs)).reuse).toBe(false);
    expect((await go([run({ event: 'push' })], fullJobs)).reuse).toBe(false);
    expect((await go([run()], fullJobs, { event: 'pull_request' })).reuse).toBe(false);
    const boom = async () => {
      throw new Error('GitHub API 500');
    };
    expect((await decide({ api: boom, repo: 'o/r', sha: SHA, event: 'push' })).reuse).toBe(false);
  });
});

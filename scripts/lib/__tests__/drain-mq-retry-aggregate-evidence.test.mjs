import { describe, expect, it, vi } from 'vitest';
import { mqSameHeadGuard } from '../drain-queue-safety.mjs';

const repo = 'fixture/drain', head = 'a'.repeat(40), commit = 'b'.repeat(40);
const infraLog = 'fatal: could not fetch deadbeef from promisor remote\n';
const jobs = [['test', 'Gate on shard results'], ['coverage-merge', 'Require successful shards']];

function probe(name, steps, aggregateLog = 'Process completed with exit code 1.\n',
  { aggregateOnly = false, priorMain = 'success' } = {}) {
  const logReads = [];
  const candidates = aggregateOnly ? [[22, `CI / ${name}`]]
    : [[21, 'CI / test-shard (5)'], [22, `CI / ${name}`]];
  const checks = candidates.map(([id, name]) => ({
    id, name, status: 'completed', conclusion: 'failure', output: {},
    details_url: `https://github.com/${repo}/actions/runs/201/job/${id + 9000}`,
  }));
  const run = { id: 102, status: 'completed', conclusion: 'success',
    path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push',
    created_at: '2026-11-01T13:20:00Z', updated_at: '2026-11-01T13:20:00Z' };
  const exec = vi.fn((command, args) => {
    if (command !== 'gh') throw new Error('unexpected IO');
    const response = pullRequest => JSON.stringify({ data: { repository: { pullRequest } } });
    if (args.some(arg => arg.includes('isInMergeQueue')))
      return response({ isInMergeQueue: false, headRefOid: head });
    if (args.some(arg => arg.includes('timelineItems'))) return response({ timelineItems: {
      nodes: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks',
        createdAt: '2026-11-01T13:45:00Z', beforeCommit: { oid: commit,
          parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } } }],
      pageInfo: { hasPreviousPage: false },
    } });
    if (args.includes('mergeStateStatus,headRefOid'))
      return JSON.stringify({ mergeStateStatus: 'CLEAN', headRefOid: head });
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
    if (endpoint?.includes('/check-runs?'))
      return JSON.stringify({ total_count: checks.length, check_runs: checks });
    if (endpoint === `repos/${repo}/actions/jobs/9022`)
      return JSON.stringify({ id: 9022, name: `CI / ${name}`, head_sha: commit,
        status: 'completed', conclusion: 'failure', steps });
    if (endpoint?.endsWith('/logs')) {
      logReads.push(endpoint);
      return endpoint.endsWith('/9021/logs') ? infraLog : aggregateLog;
    }
    if (endpoint?.includes('/actions/workflows/ci.yml/runs?')) {
      const beforeRemoval = { ...run, id: 101, conclusion: priorMain,
        created_at: '2026-11-01T13:00:00Z', updated_at: '2026-11-01T13:00:00Z' };
      const runs = endpoint.includes('created=<') ? [beforeRemoval] : [run, beforeRemoval];
      return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
    }
    throw new Error('unexpected GitHub read');
  });
  const decision = mqSameHeadGuard({ repo, pr: 6215, head, exec,
    now: Date.parse('2026-11-01T14:00:00Z'), quarantine: { readList: null } });
  return { decision, logReads };
}

describe.each(jobs)('affirmative dependency-failure evidence for %s', (name, dependencyStep) => {
  it('holds aggregate-only failures even when main is red', () => {
    // Main was red at removal and is green now: the historical main-red retry
    // exemption must not authorize a retry with no intrinsic failure evidence.
    const { decision, logReads } = probe(name, [{ name: dependencyStep, conclusion: 'failure' }],
      undefined, { aggregateOnly: true, priorMain: 'failure' });
    expect(decision.hold).toBe(true);
    expect(decision.reason).toContain('only derived aggregate failures');
    expect(decision.reason).toContain('operator must inspect failed jobs and enqueue manually');
    expect(decision.reason).toContain(`derived aggregates skipped: CI / ${name}`);
    expect(decision.mainRunId).toBe(102);
    expect(logReads).toEqual([]);
  });

  it('holds a failed aggregate with empty steps beside an infrastructure failure', () => {
    const { decision, logReads } = probe(name, []);
    expect(decision.hold).toBe(true);
    expect(decision.reason).toContain('non-infrastructure');
    expect(decision.mainRunId).toBe(102);
    expect(logReads).toContain(`repos/${repo}/actions/jobs/9022/logs`);
  });

  it('holds a failed aggregate with exclusively passing steps beside an infrastructure failure', () => {
    const { decision, logReads } = probe(name, [
      { name: 'Set up job', conclusion: 'success' },
      { name: dependencyStep, conclusion: 'success' },
      { name: 'Complete job', conclusion: 'success' },
    ]);
    expect(decision.hold).toBe(true);
    expect(decision.reason).toContain('non-infrastructure');
    expect(logReads).toContain(`repos/${repo}/actions/jobs/9022/logs`);
  });

  it('skips aggregate logs with an affirmative dependency-only failed step', () => {
    const { decision, logReads } = probe(name, [{ name: dependencyStep, conclusion: 'failure' }]);
    expect(decision.hold).toBe(false);
    expect(decision.mainRunId).toBe(102);
    expect(logReads).toEqual([`repos/${repo}/actions/jobs/9021/logs`]);
  });

  it('allows ordinary infrastructure log evidence when aggregate steps are empty', () => {
    const { decision, logReads } = probe(name, [], infraLog);
    expect(decision.hold).toBe(false);
    expect(logReads).toContain(`repos/${repo}/actions/jobs/9022/logs`);
  });
});

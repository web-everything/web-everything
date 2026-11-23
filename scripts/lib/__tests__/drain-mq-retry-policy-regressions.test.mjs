import { afterEach, describe, expect, it, vi } from 'vitest';
import { mqSameHeadGuard, readDrainQueueSafety } from '../drain-queue-safety.mjs';

const signature = 'fatal: could not fetch deadbeef from promisor remote\n';
const repo = 'fixture/drain', head = 'a'.repeat(40), commit = 'b'.repeat(40);
const now = Date.parse('2026-11-01T14:00:00Z'), bytes = 4 * 1024 * 1024;

function probe({ count = 1, text = signature, clean = 'CLEAN', main = 'success', prior = 'success', spent = false, jobIdBase = 21 } = {}) {
  const reads = [];
  const removal = { __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks',
    createdAt: '2026-11-01T13:00:00Z', beforeCommit: { oid: commit,
      parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } } };
  const runs = [[102, main, '2026-11-01T13:30:00Z'], [101, prior, '2026-11-01T12:00:00Z']]
    .map(([id, conclusion, date]) => ({ id, conclusion, created_at: date, updated_at: date,
      status: 'completed', path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push' }));
  const checks = Array.from({ length: count }, (_, i) => ({ id: i + 21, name: `test-shard-${i}`,
    status: 'completed', conclusion: 'failure', output: {},
    details_url: `https://github.com/${repo}/actions/runs/201/job/${i + jobIdBase}` }));
  const exec = vi.fn((command, args, options) => {
    if (command !== 'gh') throw new Error('unexpected IO');
    const response = pullRequest => JSON.stringify({ data: { repository: { pullRequest } } });
    if (args.some(arg => arg.includes('isInMergeQueue'))) return response({ isInMergeQueue: false, headRefOid: head });
    if (args.some(arg => arg.includes('timelineItems'))) return response({ timelineItems: {
      nodes: spent ? [removal, { __typename: 'AddedToMergeQueueEvent' }, removal, { __typename: 'AddedToMergeQueueEvent' }] : [removal],
      pageInfo: { hasPreviousPage: false },
    } });
    if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify({ headRefOid: head, mergeStateStatus: clean });
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
    if (endpoint?.includes('/check-runs?')) return JSON.stringify({ total_count: count, check_runs: checks });
    if (endpoint?.includes('/actions/workflows/ci.yml/runs?')) {
      const selected = endpoint.includes('created=<') ? runs.slice(1) : runs;
      return JSON.stringify({ total_count: selected.length, workflow_runs: selected });
    }
    if (/\/actions\/jobs\/\d+\/logs$/.test(endpoint ?? '')) {
      reads.push({ endpoint, options });
      if (text instanceof Error) throw text;
      return text;
    }
    throw new Error(`unexpected read ${args.join(' ')}`);
  });
  const decision = mqSameHeadGuard({ repo, pr: 6215, head, exec, now, quarantine: { readList: null } });
  return { decision, reads };
}

afterEach(() => vi.unstubAllEnvs());

describe('retired MQ signature setting', () => {
  it('has no declared setting or environment override', () => {
    const log = vi.fn();
    const result = readDrainQueueSafety({ env: { WE_DRAIN_MQ_INFRA_SIGNATURES: '["environment outage"]' },
      tool: {}, platform: {}, log });
    expect(result.value).not.toHaveProperty('mqInfraSignatures');
    expect(result.sources).not.toHaveProperty('mqInfraSignatures');
    expect(log.mock.calls.flat().join('\n')).not.toContain('mqInfraSignatures');
    vi.stubEnv('WE_DRAIN_MQ_INFRA_SIGNATURES', '["environment outage"]');
    expect(probe({ text: 'environment outage' }).decision.hold).toBe(true);
    expect(probe().decision.hold).toBe(true);
  });
});

describe('MQ log authorization guard regressions', () => {
  it('reads the Actions job ID from details_url when it differs from the check-run ID and holds matching logs', () => {
    // Check-run IDs are 21/22; the corresponding Actions job IDs are 9021/9022.
    const { decision, reads } = probe({ count: 2, jobIdBase: 9021 });
    expect(reads.map(read => read.endpoint)).toEqual([
      `repos/${repo}/actions/jobs/9021/logs`, `repos/${repo}/actions/jobs/9022/logs`,
    ]);
    expect(decision.hold).toBe(true);
    expect(decision.reason).toContain('non-infrastructure');
    expect(decision.mainRunId).toBe(102);
  });

  it('holds ten matching failed jobs, with one bounded throttled read per job', () => {
    const { decision, reads } = probe({ count: 10 });
    expect(decision.hold).toBe(true);
    expect(reads).toHaveLength(10);
    expect(new Set(reads.map(read => read.endpoint)).size).toBe(10);
    for (const { options } of reads) {
      expect(options).toMatchObject({ maxBuffer: bytes, encoding: 'utf8', timeout: 60_000, throttle: { maxAttempts: 1 } });
    }
  });

  it('holds eleven failed jobs without fetching logs, even when main was red at removal', () => {
    const { decision, reads } = probe({ count: 11, prior: 'failure' });
    expect(decision.hold).toBe(true);
    expect(reads).toHaveLength(0);
    expect(decision.reason).toMatch(/10-job limit.*operator must inspect/);
  });

  it.each([new Error('unreadable'), '', null, { text: signature }])('unreadable log %j vetoes even the historical main-red retry exemption', text => {
    const { decision, reads } = probe({ text, prior: 'failure' });
    expect(decision.hold).toBe(true);
    expect(reads).toHaveLength(1);
    expect(decision.reason).toMatch(/log evidence unreadable.*operator must inspect/);
  });

  it('holds signatures before and after oversized multibyte text', () => {
    // More than 4 MiB in fewer than 4 Mi JS characters: a character-only bound
    // would incorrectly preserve the signature before the multibyte suffix.
    const suffix = 'é'.repeat(bytes / 2);
    const held = probe({ text: signature + suffix });
    expect(held.reads).toHaveLength(1);
    expect(held.decision.hold).toBe(true);
    const accepted = probe({ text: suffix + '\n' + signature });
    expect(accepted.decision.hold).toBe(true);
    expect(accepted.reads[0].options.maxBuffer).toBe(bytes);
  });

  it.each(['BEHIND', 'DIRTY', 'UNKNOWN', null])('matching infra logs cannot retry a PR whose merge state is %j', clean => {
    const { decision, reads } = probe({ clean });
    expect(reads).toHaveLength(1);
    expect(decision.hold).toBe(true);
    expect(decision.reason).toContain('non-infrastructure');
    expect(decision.mainRunId).toBe(102);
  });

  it('matching infra logs cannot retry while the newest completed main run is failing', () => {
    const { decision, reads } = probe({ main: 'failure' });
    expect(reads).toHaveLength(1);
    expect(decision.hold).toBe(true);
    expect(decision.reason).toMatch(/main CI is not green.*102.*failure/);
  });

  it('two spent retries cannot be authorized again by matching infra logs', () => {
    const { decision } = probe({ spent: true });
    expect(decision.hold).toBe(true);
    expect(decision.reason).toContain('already spent');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mqSameHeadGuard, readDrainQueueSafety } from '../drain-queue-safety.mjs';

const standard = ['could not fetch \\S+ from promisor remote'];
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
      nodes: spent ? [removal, { __typename: 'AddedToMergeQueueEvent' }] : [removal],
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

describe('MQ retry policy override regressions', () => {
  it('uses an explicit environment allowlist ahead of distinct tool and platform values and logs its source', () => {
    const log = vi.fn();
    const r = readDrainQueueSafety({ env: { WE_DRAIN_MQ_INFRA_SIGNATURES: '["environment outage"]' },
      tool: { mqInfraSignatures: ['tool outage'] }, platform: { mqInfraSignatures: ['platform outage'] }, log });
    expect(r.value.mqInfraSignatures).toEqual(['environment outage']);
    expect(r.sources.mqInfraSignatures).toBe('env');
    expect(log.mock.calls.flat().join('\n')).toContain('environment outage');
    expect(log.mock.calls.flat().join('\n')).toContain('(env)');
    vi.stubEnv('WE_DRAIN_MQ_INFRA_SIGNATURES', '["environment outage"]');
    expect(probe({ text: 'environment outage' }).decision.hold).toBe(false);
    expect(probe().decision.hold).toBe(true);
  });

  it('rejects malformed environment JSON and uses the valid tool override, rather than the default', () => {
    const r = readDrainQueueSafety({ env: { WE_DRAIN_MQ_INFRA_SIGNATURES: '[' },
      tool: { mqInfraSignatures: ['tool outage'] }, platform: { mqInfraSignatures: ['platform outage'] } });
    expect(r.value.mqInfraSignatures).toEqual(['tool outage']);
    expect(r.sources.mqInfraSignatures).toBe('tool');
    expect(r.invalid.join('\n')).toContain('mqInfraSignatures');
  });

  it.each(['', '.*', '^', '.+', '[', 42])('rejects invalid tool entry %j and falls back to a distinct valid platform override', entry => {
    const r = readDrainQueueSafety({ env: {}, tool: { mqInfraSignatures: [entry] },
      platform: { mqInfraSignatures: ['platform outage'] } });
    expect(r.value.mqInfraSignatures).toEqual(['platform outage']);
    expect(r.sources.mqInfraSignatures).toBe('platform');
    expect(r.invalid.join('\n')).toContain('mqInfraSignatures');
  });

  it('falls back to the standard when both tool and platform contain invalid allowlists', () => {
    const r = readDrainQueueSafety({ env: {}, tool: { mqInfraSignatures: ['.*'] }, platform: { mqInfraSignatures: ['['] } });
    expect(r.value.mqInfraSignatures).toEqual(standard);
    expect(r.sources.mqInfraSignatures).toBe('standard');
    expect(r.invalid).toHaveLength(2);
  });
});

describe('MQ log authorization guard regressions', () => {
  it('reads the Actions job ID from details_url when it differs from the check-run ID and authorizes matching logs', () => {
    // Check-run IDs are 21/22; the corresponding Actions job IDs are 9021/9022.
    const { decision, reads } = probe({ count: 2, jobIdBase: 9021 });
    expect(reads.map(read => read.endpoint)).toEqual([
      `repos/${repo}/actions/jobs/9021/logs`, `repos/${repo}/actions/jobs/9022/logs`,
    ]);
    expect(decision.hold).toBe(false);
    expect(decision.reason).toContain('infra retry 1/1');
    expect(decision.mainRunId).toBe(102);
  });

  it('accepts ten matching failed jobs, with one bounded throttled read per job', () => {
    const { decision, reads } = probe({ count: 10 });
    expect(decision.hold).toBe(false);
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

  it('bounds the tail scan by UTF-8 bytes rather than JS character count', () => {
    // More than 4 MiB in fewer than 4 Mi JS characters: a character-only bound
    // would incorrectly preserve the signature before the multibyte suffix.
    const suffix = 'é'.repeat(bytes / 2);
    const held = probe({ text: signature + suffix });
    expect(held.reads).toHaveLength(1);
    expect(held.decision.hold).toBe(true);
    const accepted = probe({ text: suffix + '\n' + signature });
    expect(accepted.decision.hold).toBe(false);
    expect(accepted.reads[0].options.maxBuffer).toBe(bytes);
  });

  it.each(['BEHIND', 'DIRTY', 'UNKNOWN', null])('matching infra logs cannot retry a PR whose merge state is %j', clean => {
    const { decision, reads } = probe({ clean });
    expect(reads).toHaveLength(1);
    expect(decision.hold).toBe(true);
    expect(decision.reason).toContain('PR is not CLEAN');
    expect(decision.mainRunId).toBe(102);
  });

  it('matching infra logs cannot retry while the newest completed main run is failing', () => {
    const { decision, reads } = probe({ main: 'failure' });
    expect(reads).toHaveLength(1);
    expect(decision.hold).toBe(true);
    expect(decision.reason).toMatch(/main CI is not green.*102.*failure/);
  });

  it('a spent single retry cannot be authorized again by matching infra logs', () => {
    const { decision } = probe({ spent: true });
    expect(decision.hold).toBe(true);
    expect(decision.reason).toContain('already spent');
  });
});

describe('MQ signature cost and specificity bounds', () => {
  it.each(['[\\s\\S]{2,}', '(a+)+$', '(.*)*', '(?:outage(a{2,}))+', '(outage*){2,}',
    '.+', '.*', '^', '\\S+', 'test failed', 'Error: assertion failed', 'ok', '1 passed', 'a'.repeat(201)])(
    'rejects unsafe pattern %j and reports the platform fallback', source => {
      const result = readDrainQueueSafety({ env: {}, tool: { mqInfraSignatures: [source] },
        platform: { mqInfraSignatures: ['platform outage'] } });
      expect(result.value.mqInfraSignatures).toEqual(['platform outage']);
      expect(result.sources.mqInfraSignatures).toBe('platform');
      expect(result.invalid.join('\n')).toContain('mqInfraSignatures');
    });

  it.each([...standard, 'a'.repeat(200), 'outage[+*]+', 'outage\\(+\\)+'])('accepts specific bounded pattern %j', source => {
    const result = readDrainQueueSafety({ env: {}, tool: { mqInfraSignatures: [source] }, platform: {} });
    expect(result.value.mqInfraSignatures).toEqual([source]);
    expect(result.sources.mqInfraSignatures).toBe('tool');
    expect(result.invalid).toEqual([]);
  });

  it.each(['x'.repeat(256 * 1024), 'é'.repeat(128 * 1024)])(
    'limits pattern scans to the last 256 KiB (suffix case %#)', suffix => {
      const held = probe({ text: signature + suffix });
      expect(held.reads).toHaveLength(1);
      expect(held.decision.hold).toBe(true);
      expect(held.decision.reason).toContain('non-infrastructure');
      const accepted = probe({ text: suffix + '\n' + signature });
      expect(accepted.decision.hold).toBe(false);
      expect(accepted.reads[0].options.maxBuffer).toBe(bytes);
    });
});

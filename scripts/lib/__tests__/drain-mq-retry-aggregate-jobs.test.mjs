import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mqSameHeadGuard, readDrainQueueSafety } from '../drain-queue-safety.mjs';

const settings = vi.hoisted(() => ({ drain: {} }));
vi.mock('../settings-files.mjs', async importOriginal => ({
  ...await importOriginal(), readSettings: vi.fn(() => ({ drain: settings.drain })),
}));

const repo = 'fixture/drain', head = 'a'.repeat(40), commit = 'b'.repeat(40);
const now = Date.parse('2026-11-01T14:00:00Z');
const standard = ['test', 'coverage-merge'];
const infraLog = 'fatal: could not fetch deadbeef from promisor remote\n';
const aggregateLog = '##[error]Unit shards did not succeed.\n##[error]Process completed with exit code 1.\n';
// Exact dependency-only step names from .github/workflows/ci.yml; other failures are intrinsic.
const summarySteps = new Map([['test', 'Gate on shard results'], ['coverage-merge', 'Require successful shards']]);
const check = (id, name) => ({
  id, name, status: 'completed', conclusion: 'failure', output: {},
  // Deliberately different namespaces: job reads must use the Actions ID.
  details_url: `https://github.com/${repo}/actions/runs/201/job/${id + 9000}`,
});
const shard = check(21, 'CI / test-shard (5)');
const aggregates = [check(22, 'CI / test'), check(23, 'CI / coverage-merge')];
const step = (name, conclusion) => ({ name, conclusion });
const localName = name => name.split(' / ').at(-1);

function fixture({ checks = [shard, ...aggregates], jobData = new Map(), logs = new Map() } = {}) {
  const jobReads = [], logReads = [];
  const exec = vi.fn((command, args, options) => {
    if (command !== 'gh') throw new Error('unexpected non-GitHub IO');
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
      return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN' });
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
    if (endpoint?.startsWith(`repos/${repo}/commits/${commit}/check-runs?`))
      return JSON.stringify({ total_count: checks.length, check_runs: checks });
    const match = endpoint?.match(/\/actions\/jobs\/(\d+)(\/logs)?$/);
    if (match) {
      const id = Number(match[1]), isLog = !!match[2];
      (isLog ? logReads : jobReads).push({ id, options });
      const item = checks.find(c => c.id + 9000 === id);
      if (!item) throw new Error(`unknown Actions job ${id}`);
      if (isLog) {
        const value = logs.has(id) ? logs.get(id) : id === 9021 ? infraLog : aggregateLog;
        if (value instanceof Error) throw value;
        return value;
      }
      const value = jobData.has(id) ? jobData.get(id) : {
        id, name: item.name, head_sha: commit, status: 'completed', conclusion: 'failure',
        steps: [step('Set up job', 'success'),
          step(summarySteps.get(localName(item.name)) ?? 'Run unit tests', 'failure'),
          step('Complete job', 'success')],
      };
      if (value instanceof Error) throw value;
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
    if (endpoint?.startsWith(`repos/${repo}/actions/workflows/ci.yml/runs?`)) {
      const runs = [{ id: 102, status: 'completed', conclusion: 'success',
        created_at: '2026-11-01T13:20:00Z', updated_at: '2026-11-01T13:20:00Z',
        path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push' }];
      return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
    }
    throw new Error(`unexpected GitHub read: ${args.join(' ')}`);
  });
  return { exec, jobReads, logReads, guard: () => mqSameHeadGuard({
    repo, pr: 6215, head, now, exec, quarantine: { readList: null },
  }) };
}

function expectRetry(decision) {
  expect(decision.hold).toBe(false);
  expect(decision.line).toContain('failed_checks infra retry 1/2 (main green, PR CLEAN, infra)');
  expect(decision.line).toContain('main run 102');
  expect(decision.mainRunId).toBe(102);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv('VITEST', '');
  vi.stubEnv('WE_UNDER_TEST', '');
  vi.stubEnv('WE_DRAIN_MQ_AGGREGATE_JOBS', undefined);
  vi.stubEnv('WE_DRAIN_MQ_INFRA_SIGNATURES', undefined);
  settings.drain = {};
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('MQ infrastructure retry with derived aggregate jobs', () => {
  it('accepts a promisor shard plus derived test and coverage-merge, carrying the deciding main run in the accept line', () => {
    expectRetry(fixture().guard());
  });

  it.each(aggregates)('holds when $name has an intrinsic failed step alongside its dependency summary', aggregate => {
    const f = fixture({ jobData: new Map([[aggregate.id + 9000, {
      name: aggregate.name, head_sha: commit,
      steps: [step(summarySteps.get(localName(aggregate.name)), 'failure'), step('Install', 'failure')],
    }]]) });
    expect(f.guard().hold).toBe(true);
    expect(f.logReads.map(read => read.id)).toContain(aggregate.id + 9000);
  });

  it.each(aggregates)('holds when $name is absent from the custom aggregate setting', aggregate => {
    settings.drain = { mqAggregateJobs: standard.filter(name => name !== localName(aggregate.name)) };
    const f = fixture();
    expect(f.guard().hold).toBe(true);
    expect(f.logReads.map(read => read.id)).toContain(aggregate.id + 9000);
  });

  it('holds when only derived aggregates failed, even if their logs happen to contain the infra signature', () => {
    const f = fixture({ checks: aggregates, logs: new Map([[9022, infraLog], [9023, infraLog]]) });
    expect(f.guard().hold).toBe(true);
    expect(f.logReads).toHaveLength(0);
  });

  it('requires every non-derived failure to match a signature', () => {
    const other = check(24, 'CI / test-shard (6)');
    const f = fixture({ checks: [shard, other, ...aggregates],
      logs: new Map([[9024, 'AssertionError: expected 2 to be 3\n']]) });
    expect(f.guard().hold).toBe(true);
    expect(f.logReads.map(read => read.id)).toContain(9024);
  });

  it.each([
    ['API error', new Error('job unavailable')], ['invalid JSON', '{'], ['null job', null],
    ['missing steps', {}], ['null steps', { steps: null }], ['object steps', { steps: {} }],
    ['string steps', { steps: 'Gate on shard results' }],
  ])('fails closed on %s: the aggregate still needs matching log evidence', (_label, data) => {
    const f = fixture({ jobData: new Map([[9022, data]]) });
    expect(f.guard().hold).toBe(true);
    expect(f.logReads.map(read => read.id)).toContain(9022);
  });

  it('accepts an aggregate with a readable steps array with only its dependency summary step failed', () => {
    const f = fixture({ jobData: new Map(aggregates.map(c => [c.id + 9000, {
      id: c.id + 9000, name: c.name, head_sha: commit, status: 'completed', conclusion: 'failure',
      steps: [step('Set up job', 'success'), step(summarySteps.get(localName(c.name)), 'failure'),
        step('Complete job', 'success')],
    }])) });
    expectRetry(f.guard());
  });

  it('does not treat an arbitrary failed step containing dependency words as the known summary step', () => {
    const f = fixture({ jobData: new Map([[9022, { name: aggregates[0].name, head_sha: commit,
      steps: [step('Gate on shard results and run integration tests', 'failure')] }]]) });
    expect(f.guard().hold).toBe(true);
    expect(f.logReads.map(read => read.id)).toContain(9022);
  });

  it('fetches no derived logs and bounds all job reads, output, timeouts and GitHub calls', () => {
    const f = fixture();
    const decision = f.guard();
    expect(f.logReads.map(read => read.id)).toEqual([9021]);
    expect(f.jobReads.map(read => read.id)).toEqual(expect.arrayContaining([9022, 9023]));
    expect(f.jobReads.length).toBeLessThanOrEqual(3);
    expect(new Set(f.jobReads.map(read => read.id)).size).toBe(f.jobReads.length);
    expect(f.jobReads.length + f.logReads.length).toBeLessThanOrEqual(4);
    // Queue + timeline + checks + two main pages + CLEAN + at most four job reads.
    expect(f.exec.mock.calls.length).toBeLessThanOrEqual(10);
    for (const { options } of [...f.jobReads, ...f.logReads]) {
      expect(options).toMatchObject({ encoding: 'utf8', throttle: { maxAttempts: 1 } });
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(60_000);
      expect(options.maxBuffer).toBeGreaterThan(0);
      expect(options.maxBuffer).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
    expectRetry(decision);
  });

  it('holds above the existing ten-failed-job bound with an operator inspection fallback and no job reads', () => {
    const checks = [shard, ...Array.from({ length: 10 }, (_, i) => check(30 + i, 'CI / test'))];
    const f = fixture({ checks });
    const decision = f.guard();
    expect(decision.hold).toBe(true);
    expect(decision.reason).toMatch(/10-job limit.*operator must inspect/);
    expect(f.jobReads).toHaveLength(0);
    expect(f.logReads).toHaveLength(0);
  });
});

describe('drain.mqAggregateJobs settings contract', () => {
  it('defaults to the two standard aggregate jobs and logs effective value and provenance', () => {
    const log = vi.fn();
    const r = readDrainQueueSafety({ env: {}, tool: {}, platform: {}, log });
    expect(r.value.mqAggregateJobs).toEqual(standard);
    expect(r.sources.mqAggregateJobs).toBe('standard');
    expect(log.mock.calls.flat().join('\n')).toMatch(/mqAggregateJobs=.*test.*coverage-merge.*\(standard\)/);
  });

  it.each([
    ['platform', {}, {}, { mqAggregateJobs: ['platform-gate'] }, ['platform-gate']],
    ['tool', {}, { mqAggregateJobs: ['tool-gate'] }, { mqAggregateJobs: ['platform-gate'] }, ['tool-gate']],
    ['env', { WE_DRAIN_MQ_AGGREGATE_JOBS: '["env-gate"]' }, { mqAggregateJobs: ['tool-gate'] },
      { mqAggregateJobs: ['platform-gate'] }, ['env-gate']],
  ])('resolves the %s layer and logs its effective value and source', (source, env, tool, platform, expected) => {
    const log = vi.fn();
    const r = readDrainQueueSafety({ env, tool, platform, log });
    expect(r.value.mqAggregateJobs).toEqual(expected);
    expect(r.sources.mqAggregateJobs).toBe(source);
    const text = log.mock.calls.flat().join('\n');
    expect(text).toContain(`mqAggregateJobs=`);
    expect(text).toContain(expected[0]);
    expect(text).toContain(`(${source})`);
  });

  it('uses the JSON environment override in the live guard instead of the tool default', () => {
    settings.drain = { mqAggregateJobs: ['other-gate'] };
    vi.stubEnv('WE_DRAIN_MQ_AGGREGATE_JOBS', JSON.stringify(standard));
    expectRetry(fixture().guard());
  });

  it.each([
    ['not an array', 'test'], ['null', null], ['empty array', []], ['empty name', ['']],
    ['blank name', ['   ']], ['non-string', [42]], ['mixed invalid', ['test', false]],
    ['object entry', [{ name: 'test' }]], ['regex name', ['.*']], ['control character', ['test\n']],
    ['overlong name', ['x'.repeat(81)]], ['too many names', Array.from({ length: 17 }, (_, i) => `gate-${i}`)],
  ])('rejects %s, reports invalid input, and falls back to the standard', (_label, value) => {
    const r = readDrainQueueSafety({ env: {}, tool: { mqAggregateJobs: value }, platform: {} });
    expect(r.value.mqAggregateJobs).toEqual(standard);
    expect(r.sources.mqAggregateJobs).toBe('standard');
    expect(r.invalid.join('\n')).toContain('mqAggregateJobs');
  });

  it.each(['[', 'null', '[]', '[""]', '[42]', JSON.stringify(['x'.repeat(81)]),
    JSON.stringify(Array.from({ length: 17 }, (_, i) => `gate-${i}`))])(
    'rejects invalid environment JSON/value %s and falls back to the valid tool layer', value => {
      const r = readDrainQueueSafety({ env: { WE_DRAIN_MQ_AGGREGATE_JOBS: value },
        tool: { mqAggregateJobs: ['tool-gate'] }, platform: { mqAggregateJobs: ['platform-gate'] } });
      expect(r.value.mqAggregateJobs).toEqual(['tool-gate']);
      expect(r.sources.mqAggregateJobs).toBe('tool');
      expect(r.invalid.join('\n')).toContain('mqAggregateJobs');
    });

  it('falls back from an invalid tool layer to a valid platform layer', () => {
    const r = readDrainQueueSafety({ env: {}, tool: { mqAggregateJobs: [] },
      platform: { mqAggregateJobs: ['platform-gate'] } });
    expect(r.value.mqAggregateJobs).toEqual(['platform-gate']);
    expect(r.sources.mqAggregateJobs).toBe('platform');
    expect(r.invalid.join('\n')).toContain('mqAggregateJobs');
  });

  it('accepts the inclusive bounds of sixteen plain job names and eighty characters per name', () => {
    const names = ['x'.repeat(80), ...Array.from({ length: 15 }, (_, i) => `gate-${i}`)];
    const r = readDrainQueueSafety({ env: {}, tool: { mqAggregateJobs: names }, platform: {} });
    expect(r.value.mqAggregateJobs).toEqual(names);
    expect(r.sources.mqAggregateJobs).toBe('tool');
    expect(r.invalid).toEqual([]);
  });
});

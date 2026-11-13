// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mqSameHeadGuard } from '../drain-queue-safety.mjs';

// A merge-queue failed_checks removal whose ONLY failing tests are in the active red-main quarantine
// earns exactly one retry per head. Everything else (and anything unreadable) stays declined.
const head = '6499b61098f2' + '0'.repeat(28);
const prior = 'a'.repeat(40);
const mergeCommit = 'b'.repeat(40);
const pr = 6499, repo = 'fixture/drain';
const NOW = 1_800_000_000_000;
const FILE = 'scripts/lib/__tests__/flaky.test.mjs';
const NAME = 'suite > case';
const AGG = '##[error]Unit shards did not succeed.\n##[error]Process completed with exit code 1.\n';

const removed = () => ({
  __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt: '2026-11-07T22:21:51Z',
  beforeCommit: { oid: mergeCommit, parents: { nodes: [{ oid: prior }, { oid: head }] } },
});
const added = { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-07T23:00:00Z' };
const entry = (test, extra = {}) => ({ test, brokenSha: prior, owner: 'o', reason: 'r', addedAt: NOW - 1000, expiresAt: NOW + 3_600_000, ...extra });
const logOf = (...failures) => `${failures.map(([file, name]) => ` FAIL  ${file} > ${name}`).join('\n')}\n Test Files  ${new Set(failures.map(([file]) => file)).size} failed | 160 passed (161)\n      Tests  ${failures.length} failed | 7000 passed (7001)\n##[error]Process completed with exit code 1.\n`;

function fixture(test) {
  const f = {
    events: [removed()], live: { headRefOid: head, mergeStateStatus: 'CLEAN' },
    list: { ok: true, list: { version: 1, entries: [entry(`${FILE}::${NAME}`)], mode: 'quarantine' } },
    checks: [
      { id: 31, name: 'test-shard (5)', status: 'completed', conclusion: 'failure', output: { title: '', summary: '' } },
      { id: 32, name: 'test', status: 'completed', conclusion: 'failure', output: { title: '', summary: '' } },
      { id: 33, name: 'coverage-merge', status: 'completed', conclusion: 'failure', output: { title: '', summary: '' } },
      { id: 34, name: 'test-shard (1)', status: 'completed', conclusion: 'success', output: { title: '', summary: '' } },
    ],
    logs: { 31: logOf([FILE, NAME]), 32: AGG, 33: AGG }, log: vi.fn(),
  };
  f.exec = vi.fn((command, args) => {
    if (command !== 'gh') throw new Error('unexpected non-GitHub IO');
    if (args.some(arg => arg.includes('isInMergeQueue')))
      return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
    if (args.some(arg => arg.includes('timelineItems')))
      return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { nodes: f.events, pageInfo: { hasPreviousPage: false } } } } } });
    if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify(f.live);
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`)) ?? '';
    if (endpoint.includes('/check-runs')) return JSON.stringify({ total_count: f.checks.length, check_runs: f.checks });
    const meta = /\/actions\/jobs\/(\d+)$/.exec(endpoint);
    if (meta) {
      const check = f.checks.find(c => String(c.id) === meta[1]);
      return JSON.stringify({ name: f.jobName?.[meta[1]] ?? check?.name, head_sha: f.jobSha ?? mergeCommit });
    }
    const job = /\/actions\/jobs\/(\d+)\/logs/.exec(endpoint);
    if (job) {
      if (f.logs[job[1]] === undefined) throw new Error('log unavailable');
      return f.logs[job[1]];
    }
    // The main-CI history must not be needed for quarantine-covered failures.
    throw new Error(`unexpected GitHub read: ${args.join(' ')}`);
  });
  f.guard = () => mqSameHeadGuard({ repo, pr, head, exec: f.exec, log: f.log,
    quarantine: { readList: () => f.list, now: () => NOW } });
  test(f);
}

const declined = f => f.log.mock.calls.map(([line]) => line).filter(line => /^mq-same-head-retry-declined:/.test(line));

describe('merge-queue same-head retry for quarantined failures', () => {
  it('allows one retry when every failing test is in the active quarantine', () => fixture(f => {
    const result = f.guard();
    expect(result.hold).toBe(false);
    expect(f.log.mock.calls).toHaveLength(1);
    expect(f.log.mock.calls[0][0]).toMatch(/^mq-same-head-retry: #6499 head \w+ — failed_checks quarantine retry 1\/1/);
  }));

  it('accepts a whole-file quarantine entry for the failing file', () => fixture(f => {
    f.list.list.entries = [entry(FILE)];
    expect(f.guard().hold).toBe(false);
  }));

  it('declines when a failing test is NOT quarantined', () => fixture(f => {
    f.logs[31] = logOf([FILE, 'a different case']);
    expect(f.guard().hold).toBe(true);
    expect(declined(f)).toHaveLength(1);
  }));

  it('declines when only some of several failing shards are covered', () => fixture(f => {
    f.checks.push({ id: 35, name: 'test-shard (2)', status: 'completed', conclusion: 'failure', output: { title: '', summary: '' } });
    f.logs[35] = logOf(['scripts/lib/__tests__/other.test.mjs', 'x']);
    expect(f.guard().hold).toBe(true);
  }));

  it('declines when the only failures are aggregators (nothing proves what failed)', () => fixture(f => {
    f.checks[0].conclusion = 'success';
    expect(f.guard().hold).toBe(true);
  }));

  it.each(['quarantine list unreadable', 'quarantine list throws', 'job log unavailable', 'job log incomplete',
    'quarantine entry expired', 'entry for another job', 'PR not CLEAN', 'list not in quarantine mode',
    'job bound to another commit', 'job name mismatch', 'summary counts an unlisted failing test',
    'aggregator shows an uncovered failure', 'truncated test name', 'aggregator log has no dependency failure',
    'aggregator has an independent error', 'unhandled error alongside the listed failure',
    'unit job has a later independent error', 'aggregator log is truncated'])('fails closed: %s', kind => fixture(f => {
    if (kind === 'quarantine list unreadable') f.list = { ok: false, error: 'offline' };
    if (kind === 'quarantine list throws') f.guard = () => mqSameHeadGuard({ repo, pr, head, exec: f.exec, log: f.log,
      quarantine: { readList: () => { throw new Error('boom'); }, now: () => NOW } });
    if (kind === 'job log unavailable') delete f.logs[31];
    if (kind === 'job log incomplete') f.logs[31] = ` FAIL  ${FILE} > ${NAME}\n`;
    if (kind === 'quarantine entry expired') f.list.list.entries = [entry(`${FILE}::${NAME}`, { expiresAt: NOW - 1 })];
    if (kind === 'entry for another job') f.list.list.entries = [entry(`${FILE}::${NAME}`, { job: 'integration' })];
    if (kind === 'list not in quarantine mode') f.list.list.mode = 'stop';
    if (kind === 'job bound to another commit') f.jobSha = prior;
    if (kind === 'job name mismatch') f.jobName = { 31: 'test-shard (1)' };
    if (kind === 'summary counts an unlisted failing test') f.logs[31] = f.logs[31].replace('Tests  1 failed', 'Tests  2 failed');
    if (kind === 'aggregator shows an uncovered failure') f.logs[32] = logOf(['scripts/lib/__tests__/other.test.mjs', 'x']);
    if (kind === 'aggregator log has no dependency failure') f.logs[32] = '';
    if (kind === 'aggregator has an independent error') f.logs[32] = `${AGG}##[error]ReferenceError: x is not defined\n`;
    if (kind === 'unhandled error alongside the listed failure') f.logs[31] += ' Errors  1 error\n Unhandled Rejection\n';
    if (kind === 'unit job has a later independent error') f.logs[31] = f.logs[31].replace('##[error]Process', '##[error]Artifact upload failed: permission denied\n##[error]Process');
    if (kind === 'aggregator log is truncated') f.logs[32] = '##[error]Unit shards did not succeed.\n';
    if (kind === 'truncated test name') {
      const long = 'n'.repeat(200);
      f.list.list.entries = [entry(`${FILE}::${long.slice(0, 200)}`)];
      f.logs[31] = logOf([FILE, long]);
    }
    if (kind === 'PR not CLEAN') f.live.mergeStateStatus = 'BEHIND';
    expect(f.guard().hold).toBe(true);
    expect(f.log.mock.calls[0][0]).toMatch(/^mq-same-head-failed: #6499 head \w+ — failed_checks/);
  }));

  it('allows no third retry on the same head', () => fixture(f => {
    f.events = [removed(), added, removed(), added, removed()];
    const result = f.guard();
    expect(result.hold).toBe(true);
    expect(f.log.mock.calls[0][0]).toMatch(/failed_checks/);
  }));

  it('allows no retry again once the retried head was re-enqueued and left the queue', () => fixture(f => {
    f.events = [removed(), added, removed(), added];
    expect(f.guard().hold).toBe(true);
    expect(f.log.mock.calls[0][0]).toMatch(/already spent/);
  }));
});

// Evidence-backed flake: no quarantine entry, but the failing test passed on the PR head's own CI and on a
// main run created after the ejection. One retry per head; everything else stays declined.
describe('merge-queue same-head retry for evidence-backed flakes', () => {
  const REMOVED_AT = Date.parse('2026-11-07T22:21:51Z');
  const mainSha = 'c'.repeat(40);
  const run = (id, conclusion, createdMs) => ({ id, head_sha: mainSha, path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push',
    status: 'completed', conclusion, created_at: new Date(createdMs).toISOString(), updated_at: new Date(createdMs + 60_000).toISOString() });
  const green = (id, name) => ({ id, name, status: 'completed', conclusion: 'success', output: { title: '', summary: '' },
    details_url: `https://github.com/${repo}/actions/runs/7/job/${id}` });
  const setup = (test, tweak = () => {}) => fixture(f => {
    f.list = { ok: false, error: 'no quarantine' };
    f.headChecks = [green(41, 'test-shard (5)'), green(42, 'test'), green(43, 'coverage-merge')];
    f.mainRuns = [run(900, 'success', REMOVED_AT + 600_000)];
    // Vitest JSON reporter output (CI uploads it as the timing-unit-<shard> artifact), one per run.
    const result = (status = 'passed', file = FILE, title = 'case') => ({ testResults: [{ name: `/work/web-everything/${file}`,
      assertionResults: [{ ancestorTitles: ['suite'], title, fullName: `suite ${title}`, status }] }] });
    f.headJson = result(); f.mainJson = result();
    const base = f.exec;
    f.exec = vi.fn((command, args, opts) => {
      const endpoint = args.find(arg => typeof arg === 'string' && arg.startsWith(`repos/${repo}/`)) ?? '';
      if (endpoint.includes(`/commits/${head}/check-runs`)) return JSON.stringify({ total_count: f.headChecks.length, check_runs: f.headChecks });
      if (command === 'funzip') return opts.input ?? '';
      const art = /\/actions\/runs\/(7|900)\/artifacts/.exec(endpoint);
      if (art) return JSON.stringify({ total_count: 1, artifacts: [{ id: art[1] === '7' ? 701 : 9001, name: 'timing-unit-5', expired: false,
        workflow_run: { id: Number(art[1]), head_sha: art[1] === '7' ? (f.artifactHeadSha ?? head) : mainSha } }] });
      if (endpoint.endsWith('/actions/artifacts/701/zip')) return JSON.stringify(f.headJson);
      if (endpoint.endsWith('/actions/artifacts/9001/zip')) return JSON.stringify(f.mainJson);
      if (endpoint.includes('/actions/workflows/ci.yml/runs')) {
        const runs = endpoint.includes('created=<') ? [] : f.mainRuns;
        return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
      }
      return base(command, args, opts);
    });
    f.guard = () => mqSameHeadGuard({ repo, pr, head, exec: f.exec, log: f.log, now: REMOVED_AT + 3_600_000,
      quarantine: { readList: () => f.list, now: () => NOW } });
    tweak(f);
    test(f);
  });

  it('re-enqueues once when the failing test passed on the PR head CI and on a later main run', () => setup(f => {
    const result = f.guard();
    expect(result.hold).toBe(false);
    expect(f.log.mock.calls[0][0]).toMatch(/^mq-same-head-retry: #6499 head \w+ — failed_checks flake retry 1\/1/);
  }));

  it.each(['PR head CI had a failure', 'PR head CI has no unit shard', 'main run predates the ejection', 'main run failed',
    'PR not CLEAN', 'uncovered second failing job', 'test file not listed as passed on PR head CI',
    'test file not listed as passed on main', 'test failed again on main shard', 'file name only a prefix match', 'file has skipped tests', 'file ran zero tests', 'a different test in the same file passed', 'artifact JSON unparsable', 'artifact built from another commit', 'check run points at another repository'])('stays refused: %s', kind => setup(f => {
    expect(f.guard().hold).toBe(true);
    expect(f.log.mock.calls[0][0]).toMatch(/^mq-same-head-failed: #6499/);
  }, f => {
    if (kind === 'PR head CI had a failure') f.headChecks[0].conclusion = 'failure';
    if (kind === 'PR head CI has no unit shard') f.headChecks = [green(42, 'test')];
    if (kind === 'main run predates the ejection') f.mainRuns = [run(900, 'success', REMOVED_AT - 600_000)];
    if (kind === 'main run failed') f.mainRuns = [run(900, 'failure', REMOVED_AT + 600_000)];
    if (kind === 'PR not CLEAN') f.live.mergeStateStatus = 'BEHIND';
    if (kind === 'test file not listed as passed on PR head CI') f.headJson = { testResults: [] };
    if (kind === 'test file not listed as passed on main') f.mainJson = { testResults: [] };
    if (kind === 'test failed again on main shard') f.mainJson.testResults[0].assertionResults[0].status = 'failed';
    if (kind === 'file name only a prefix match') { f.headJson.testResults[0].name += '.other.test.mjs'; f.mainJson = f.headJson; }
    if (kind === 'file has skipped tests') { f.headJson.testResults[0].assertionResults[0].status = 'skipped'; f.mainJson = f.headJson; }
    if (kind === 'file ran zero tests') { f.headJson.testResults[0].assertionResults = []; f.mainJson = f.headJson; }
    if (kind === 'a different test in the same file passed') { f.headJson.testResults[0].assertionResults[0].title = 'other'; f.headJson.testResults[0].assertionResults[0].fullName = 'suite other'; }
    if (kind === 'artifact JSON unparsable') f.mainJson = 'not json{';
    if (kind === 'artifact built from another commit') f.artifactHeadSha = prior;
    if (kind === 'check run points at another repository') f.headChecks[0].details_url = 'https://github.com/evil/other/actions/runs/7/job/41';
    if (kind === 'uncovered second failing job') {
      f.checks.push({ id: 36, name: 'test-shard (2)', status: 'completed', conclusion: 'failure', output: { title: '', summary: '' } });
      f.logs[36] = logOf(['scripts/lib/__tests__/other.test.mjs', 'x']);
    }
  }));

  it('does not grant a second flake retry after the head was re-enqueued and failed again', () => setup(f => {
    expect(f.guard().hold).toBe(true);
  }, f => { f.events = [removed(), added, removed()]; }));
});

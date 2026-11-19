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
    for (const c of f.checks) c.details_url = `https://github.com/${repo}/actions/runs/800/job/${c.id}`;
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
      if (/\/actions\/runs\/7$/.test(endpoint)) return JSON.stringify({ id: 7, path: f.headRunPath ?? '.github/workflows/ci.yml', head_sha: head });
      if (/\/actions\/jobs\/44$/.test(endpoint)) return JSON.stringify({ id: 44, run_id: 7, name: 'test-shard (2)', head_sha: f.job44Sha ?? head });
      if (/\/actions\/jobs\/41$/.test(endpoint)) return JSON.stringify({ id: 41, run_id: f.headJobRunId ?? 7, name: 'test-shard (5)', head_sha: head });
      if (command === 'funzip') return opts.input ?? '';
      const art = /\/actions\/runs\/(7|900)\/artifacts/.exec(endpoint);
      if (art) return JSON.stringify({ total_count: 1, artifacts: [{ id: art[1] === '7' ? 701 : 9001, name: /name=(timing-unit-\d)/.exec(endpoint)[1], expired: false,
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

  it('still retries when an unrelated workflow (review-gate) failed on the PR head', () => setup(f => {
    expect(f.guard().hold).toBe(false);
  }, f => {
    f.headChecks.push({ ...green(60, 'review-gate'), conclusion: 'failure' }, { ...green(61, 'review-gate'), conclusion: 'cancelled' });
  }));

  it('declines with a reason when a same-named head check failed after its success', () => setup(f => {
    expect(f.guard().hold).toBe(true);
    expect(f.log.mock.calls.map(([l]) => l).join('\n')).toMatch(/flake evidence: .*PR head/);
  }, f => {
    f.headChecks.push({ ...green(62, 'test'), conclusion: 'failure', completed_at: '2999-01-01T00:00:00Z' });
    f.headChecks[1].completed_at = '2026-11-01T00:00:00Z';
  }));

  it('matches the real report shape: an empty first ancestor title and a leading space in fullName', () => setup(f => {
    expect(f.guard().hold).toBe(false);
  }, f => {
    for (const json of [f.headJson, f.mainJson]) Object.assign(json.testResults[0].assertionResults[0],
      { ancestorTitles: ['', ' suite  '], title: ' case ', fullName: '  suite   case' });
  }));

  it.each(['a longer test name that only starts with the failing name', 'a shorter prefix of the failing name'])('does not match by prefix or substring: %s', kind => setup(f => {
    expect(f.guard().hold).toBe(true);
  }, f => {
    const a = f.headJson.testResults[0].assertionResults[0];
    if (kind.startsWith('a longer')) a.title = 'case and more'; else a.title = 'cas';
    f.mainJson = f.headJson;
  }));

  it.each(['PR head CI had a failure', 'PR head CI has no unit shard', 'main run predates the ejection', 'main run failed',
    'PR not CLEAN', 'uncovered second failing job', 'test file not listed as passed on PR head CI',
    'test file not listed as passed on main', 'test failed again on main shard', 'file name only a prefix match', 'file has skipped tests', 'file ran zero tests', 'a different test in the same file passed', 'artifact JSON unparsable', 'artifact built from another commit', 'check run points at another repository', 'failed check details URL names another job',
    'PR head run is another workflow', 'PR head job belongs to another run', 'second failing shard job belongs to another run'])('stays refused: %s', kind => setup(f => {
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
    if (kind === 'second failing shard job belongs to another run') {
      f.checks.push({ id: 36, name: 'test-shard (2)', status: 'completed', conclusion: 'failure', output: { title: '', summary: '' },
        details_url: `https://github.com/${repo}/actions/runs/800/job/36` });
      f.logs[36] = logOf(['scripts/lib/__tests__/other.test.mjs', 'x']);
      f.headChecks.push(green(44, 'test-shard (2)'));
      const two = { testResults: [{ name: '/w/scripts/lib/__tests__/other.test.mjs', assertionResults: [{ ancestorTitles: [], title: 'x', fullName: 'x', status: 'passed' }] }] };
      f.headJson.testResults.push(...two.testResults); f.mainJson.testResults.push(...two.testResults);
      f.job44Sha = prior;
    }
    if (kind === 'PR head run is another workflow') f.headRunPath = '.github/workflows/other.yml';
    if (kind === 'PR head job belongs to another run') f.headJobRunId = 8;
    if (kind === 'failed check details URL names another job') f.checks[0].details_url = `https://github.com/${repo}/actions/runs/7/job/999`;
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

// Exact-test extra retry: unlike the first-removal flake route, the second-removal proof comes
// from structured reports, job steps, annotations and a bounded log summary. Zip/funzip are injected.
describe('merge-queue exact-test extra retry after two failed_checks removals', () => {
  const exactPr = 6903;
  const file = 'scripts/conveyor/__tests__/hung-session.test.mjs';
  const title = 'the session reaper call site (makeIdleFinishedResolver) never opts in: idle row + dangling call stays unfinished';
  const removedAt = Date.parse('2026-11-07T23:21:51Z');
  const iso = ms => new Date(ms).toISOString();
  const firstMq = 'd'.repeat(40), mainSha = 'c'.repeat(40);
  const check = (id, name, runId, conclusion = 'success') => ({
    id, name, status: 'completed', conclusion, completed_at: iso(removedAt - 60_000),
    output: { title: '', summary: '' },
    details_url: `https://github.com/${repo}/actions/runs/${runId}/job/${id}`,
  });
  const report = (status, testTitle = title) => ({
    numFailedTests: status === 'failed' ? 1 : 0, numFailedTestSuites: status === 'failed' ? 1 : 0,
    numRuntimeErrorTestSuites: 0, numTotalTests: 1, numPassedTests: status === 'passed' ? 1 : 0,
    success: status === 'passed', testResults: [{ name: `/work/web-everything/${file}`,
      status, message: '', assertionResults: [{ ancestorTitles: [], title: testTitle, fullName: testTitle, status,
        failureMessages: status === 'failed' ? ['AssertionError: expected unfinished to be finished'] : [] }] }],
  });
  const artifact = (id, shard, runId, sha) => ({ id, name: `timing-unit-${shard}`, expired: false,
    workflow_run: { id: runId, head_sha: sha } });
  const assertion = json => json.testResults[0].assertionResults[0];

  const ts = line => `2026-11-16T07:54:50.5192657Z ${line}`;
  const shardLog = (summary = ['Test Files  1 failed | 172 passed (173)', '     Tests  1 failed | 8911 passed (8912)',
    '   Start at  07:42:56', '   Duration  714.36s (transform 20.49s, setup 4.01s)']) =>
    `${'x'.repeat(600)}\n${ts(' FAIL  scripts/x.test.mjs > a test')}\n${summary.map(line => ts(` ${line}`)).join('\n')}\n`
    + `${ts('##[error]Process completed with exit code 1.')}\n${ts('Post job cleanup.')}\n`;
  const shardAnnotations = (...extra) => [
    { annotation_level: 'warning', message: 'Node.js 20 is deprecated. The following actions target Node.js 20' },
    { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
    { annotation_level: 'notice', message: 'The ubuntu-latest label will migrate to Ubuntu 26' }, ...extra];
  function exactFixture(test) {
    const f = {
      events: [
        { ...added, createdAt: iso(removedAt - 3_600_000) },
        { ...removed(), createdAt: iso(removedAt - 3_000_000), beforeCommit: { oid: firstMq,
          parents: { nodes: [{ oid: prior }, { oid: head }] } } },
        { ...added, createdAt: iso(removedAt - 600_000) },
        { ...removed(), createdAt: iso(removedAt) },
      ],
      live: { headRefOid: head, mergeStateStatus: 'CLEAN' },
      mqChecks: [check(31, 'test-shard (1)', 800, 'failure'), check(32, 'test', 800, 'failure'),
        check(33, 'coverage-merge', 800, 'failure')],
      headChecks: [check(41, 'test-shard (1)', 7), check(42, 'test', 7), check(43, 'coverage-merge', 7),
        check(44, 'test-shard (2)', 7)],
      runs: {
        800: { id: 800, path: '.github/workflows/ci.yml', event: 'merge_group', head_sha: mergeCommit },
        7: { id: 7, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: head },
        900: { id: 900, path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', head_sha: mainSha,
          status: 'completed', conclusion: 'success', created_at: iso(removedAt + 600_000), updated_at: iso(removedAt + 660_000) },
      },
      artifacts: { 800: [artifact(8001, 1, 800, mergeCommit)],
        7: [artifact(701, 1, 7, head), artifact(702, 2, 7, head)] },
      reports: { 8001: report('failed'), 701: report('passed'), 702: report('passed', 'an unrelated test') },
      // Deliberately beyond the old log parser's 512-character bound; structured proof must ignore it.
      logs: { 31: shardLog(), 32: AGG, 33: AGG },
      annotations: { 31: shardAnnotations() },
      log: vi.fn(), jobs: {},
    };
    for (const c of [...f.mqChecks, ...f.headChecks]) {
      const mq = c.id < 40;
      f.jobs[c.id] = { id: c.id, run_id: mq ? 800 : 7, name: c.name, head_sha: mq ? mergeCommit : head,
        status: 'completed', conclusion: c.conclusion, steps: [
          { name: 'Set up job', status: 'completed', conclusion: 'success' },
          { name: c.name === 'test' ? 'Gate on shard results' : c.name === 'coverage-merge'
            ? 'Require successful shards' : 'Unit suite shard 1/9 (coverage, no per-shard bar)',
          status: 'completed', conclusion: c.conclusion },
        ] };
    }
    f.mainRuns = [f.runs[900]];
    f.now = removedAt + 3_600_000;
    f.mainHead = mainSha;
    f.artifacts[900] = [artifact(901, 1, 900, mainSha), artifact(902, 2, 900, mainSha)];
    f.reports[901] = report('passed');
    f.reports[902] = report('passed', 'an unrelated test');
    f.runJobs = { 7: f.headChecks.filter(c => c.name.startsWith('test-shard')).map(c => f.jobs[c.id]),
      900: [1, 2].map(n => ({ id: 950 + n, run_id: 900, name: `test-shard (${n})`, head_sha: mainSha,
        status: 'completed', conclusion: 'success' })) };
    const page = (endpoint, key, rows) => {
      const query = new URLSearchParams(endpoint.split('?')[1]);
      const start = (Number(query.get('page') ?? 1) - 1) * 100;
      return JSON.stringify({ total_count: rows.length, [key]: rows.slice(start, start + 100) });
    };
    f.exec = vi.fn((command, args, opts) => {
      if (command === 'funzip') return String(opts.input);
      if (command !== 'gh') throw new Error(`unexpected command: ${command}`);
      if (args.some(arg => arg.includes('isInMergeQueue')))
        return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
      if (args.some(arg => arg.includes('timelineItems')))
        return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: {
          nodes: f.events, pageInfo: { hasPreviousPage: false },
        } } } } });
      if (args.includes('mergeStateStatus,headRefOid')) return JSON.stringify(f.liveReads?.length ? f.liveReads.shift() : f.live);
      const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`)) ?? '';
      const path = endpoint.split('?')[0];
      if (path.endsWith('/git/ref/heads/main')) return JSON.stringify({ object: { sha: f.mainHead } });
      if (path === `repos/${repo}/commits/${mergeCommit}/check-runs`)
        return page(endpoint, 'check_runs', f.mqChecks);
      if (path === `repos/${repo}/commits/${head}/check-runs`)
        return page(endpoint, 'check_runs', f.headChecks);
      if (path.endsWith('/actions/workflows/ci.yml/runs')) {
        const query = new URLSearchParams(endpoint.split('?')[1]);
        const runs = f.mainRuns.filter(r => (!query.has('status') || r.status === query.get('status'))
          && (!query.has('created') || Date.parse(r.created_at) < Date.parse(query.get('created').slice(1))));
        return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
      }
      const runId = /\/actions\/runs\/(\d+)$/.exec(path)?.[1];
      if (runId && f.runs[runId]) return JSON.stringify(f.runs[runId]);
      const jobsRun = /\/actions\/runs\/(\d+)\/jobs$/.exec(path)?.[1];
      if (jobsRun && f.runJobs[jobsRun]) return page(endpoint, 'jobs', f.runJobs[jobsRun]);
      if (/\/actions\/jobs\/\d+\/rerun$/.test(path) && args.includes('POST')) return '';
      const jobId = /\/actions\/jobs\/(\d+)$/.exec(path)?.[1];
      if (jobId && f.jobs[jobId]) return JSON.stringify(f.jobs[jobId]);
      const annId = /\/check-runs\/(\d+)\/annotations$/.exec(path)?.[1];
      if (annId) {
        if (f.annotations[annId] === undefined) throw new Error('annotations unavailable');
        return JSON.stringify(f.annotations[annId]);
      }
      const crId = /\/check-runs\/(\d+)$/.exec(path)?.[1];
      if (crId && f.annotations[crId] !== undefined)
        return JSON.stringify({ id: Number(crId), output: { annotations_count: f.annotationCount?.[crId] ?? f.annotations[crId].length } });
      const logId = /\/actions\/jobs\/(\d+)\/logs$/.exec(path)?.[1];
      if (logId && f.logs[logId] !== undefined) return f.logs[logId];
      const artifactRun = /\/actions\/runs\/(\d+)\/artifacts$/.exec(path)?.[1];
      if (artifactRun) {
        const name = new URLSearchParams(endpoint.split('?')[1]).get('name');
        const artifacts = (f.artifacts[artifactRun] ?? []).filter(a => !name || a.name === name);
        return page(endpoint, 'artifacts', artifacts);
      }
      const zipId = /\/actions\/artifacts\/(\d+)\/zip$/.exec(path)?.[1];
      if (zipId && f.reports[zipId] !== undefined) {
        const json = f.reports[zipId];
        return Buffer.from(typeof json === 'string' ? json : JSON.stringify(json));
      }
      throw new Error(`unexpected or unavailable fixture read: ${command} ${args.join(' ')}`);
    });
    f.guard = () => mqSameHeadGuard({ repo, pr: exactPr, head, exec: f.exec, log: f.log,
      now: f.now, readFreeze: () => null,
      quarantine: { readList: () => ({ ok: false, error: 'no quarantine' }), now: () => NOW } });
    test(f);
  }

  const expectExtraRetry = f => {
    const result = f.guard();
    // Readable aggregate steps need no aggregate logs; the staged readers reuse the shard log.
    const logReads = f.exec.mock.calls.flatMap(([, args]) => args.filter(arg => /\/logs(?:\?|$)/.test(arg)));
    expect(logReads).toEqual([`repos/${repo}/actions/jobs/31/logs`]);
    expect(result.hold).toBe(false);
    expect(f.log.mock.calls.map(([line]) => line)).toContainEqual(
      expect.stringMatching(/^mq-same-head-retry: #6903 head \w+ — .*exact-test retry 2\/2/));
  };
  const expectExactHold = (f, reason = /failed_checks/) => {
    const result = f.guard();
    expect(result.hold).toBe(true);
    // Legacy infra classification may read aggregate/gate logs before exact-test evidence is attempted.
    // All such reads must still belong to this removal's failed jobs.
    const failedIds = f.mqChecks.filter(c => c.conclusion === 'failure').map(c => c.id);
    for (const [, args] of f.exec.mock.calls) {
      for (const arg of args) {
        const id = /\/actions\/jobs\/(\d+)\/logs$/.exec(arg)?.[1];
        if (id) expect(failedIds).toContain(Number(id));
      }
    }
    expect(result.line).toMatch(/^mq-same-head-failed: #6903 head \w+ — failed_checks/);
    expect(result.line).toMatch(reason);
    expect(f.log.mock.calls[0]).toEqual([result.line]);
    expect(f.log.mock.calls.some(([line]) => /^mq-same-head-retry:/.test(line))).toBe(false);
  };

  it('#6903 allows exact-test retry 2/2 from structured reports without classifying over-long log lines', () => exactFixture(f => {
    expect(f.logs[31].split('\n')[0].length).toBeGreaterThan(512);
    expectExtraRetry(f);
  }));

  const closedCases = [
    ...['failure', 'timed_out'].map(conclusion => [`newest main run is ${conclusion} after an older success`, f => {
      f.mainRuns.push({ ...f.runs[900], id: 901, conclusion, created_at: iso(removedAt + 700_000) });
    }]),
    ['day-old main success is not for the current main head', f => { f.now += 86_400_000; f.mainHead = prior; }],
    ['day-old main success has unreadable current main head', f => { f.now += 86_400_000; f.mainHead = null; }],
    ['day-old main success has a newer unfinished run for the current head', f => {
      f.now += 86_400_000;
      f.mainRuns.push({ ...f.runs[900], id: 901, status: 'in_progress', conclusion: null,
        created_at: iso(removedAt + 700_000) });
    }],
    ...['numFailedTestSuites'].flatMap(counter => [
      [`MQ report is missing ${counter}`, f => { delete f.reports[8001][counter]; }],
      [`MQ report has unreadable ${counter}`, f => { f.reports[8001][counter] = 'NaN'; }],
      [`MQ report has excessive ${counter}`, f => { f.reports[8001][counter] = 2; }],
    ]),
    ['MQ report runtime counter alone records an error', f => { f.reports[8001].numRuntimeErrorTestSuites = 1; }],
    ['MQ failed file has a runtime error message alongside the assertion', f => {
      f.reports[8001].testResults[0].message = 'Error: teardown crashed';
    }],
    ...['run_id', 'head_sha', 'name', 'id'].map(key => [`failed shard job has wrong ${key}`, f => {
      f.jobs[31][key] = key === 'head_sha' ? prior : key === 'name' ? 'other job' : 99;
    }]),
    ['failed shard job steps are unreadable', f => { delete f.jobs[31].steps; }],
    ['failed shard job fails outside the unit suite step', f => { f.jobs[31].steps[1].name = 'Upload artifacts'; }],
    ['failed shard job has no failed step', f => { f.jobs[31].steps[1].conclusion = 'success'; }],
    ...['failure', 'cancelled', 'timed_out', 'neutral'].map(conclusion => [`failed shard has another ${conclusion} step`, f => {
      f.jobs[31].steps[0].conclusion = conclusion;
    }]),
    ['main run lacks the exact test', f => { f.reports[901] = report('passed', 'different test'); }],
    ['exact test failed on main', f => { f.reports[901] = report('failed'); }],
    ['exact test is duplicated across main shards', f => { f.reports[902] = report('passed'); }],
    ['main report artifact is unreadable', f => { delete f.reports[902]; }],
    ['main artifact has another run identity', f => { f.artifacts[900][0].workflow_run.id = 899; }],
    ['main artifact has another head identity', f => { f.artifacts[900][0].workflow_run.head_sha = prior; }],
    ['main run detail has another head identity', f => {
      f.mainRuns = [{ ...f.runs[900] }]; f.runs[900].head_sha = prior;
    }],
    ['main timing artifacts exceed the bounded scan; operator must inspect manually', f => {
      f.artifacts[900] = Array.from({ length: 17 }, (_, i) => artifact(910 + i, i + 1, 900, mainSha));
    }],
    ['MQ report has two failed tests', f => {
      f.reports[8001].testResults[0].assertionResults.push({ ...assertion(f.reports[8001]), title: 'another failure' });
      Object.assign(f.reports[8001], { numFailedTests: 2, numTotalTests: 2 });
    }],
    ['MQ report has zero failed assertions despite numFailedTests 1', f => { assertion(f.reports[8001]).status = 'passed'; }],
    ['MQ report numFailedTests is not 1 despite one failed assertion', f => { f.reports[8001].numFailedTests = 2; }],
    ['MQ report has a suite-level runtime failure', f => {
      f.reports[8001].numRuntimeErrorTestSuites = 1;
      f.reports[8001].numFailedTestSuites = 2;
      f.reports[8001].testResults.push({ name: '/work/scripts/other.test.mjs', status: 'failed',
        message: 'Error: suite failed to load', assertionResults: [] });
    }],
    ['MQ artifact is missing', f => { f.artifacts[800] = []; }],
    ['MQ artifact is expired', f => { f.artifacts[800][0].expired = true; }],
    ['MQ artifact belongs to another run', f => { f.artifacts[800][0].workflow_run.id = 799; }],
    ['MQ artifact belongs to another head_sha', f => { f.artifacts[800][0].workflow_run.head_sha = firstMq; }],
    ['MQ artifact is ambiguous', f => {
      f.artifacts[800].push({ ...f.artifacts[800][0], id: 8002 });
      f.reports[8002] = report('failed');
    }],
    ['MQ artifact is unreadable', f => { delete f.reports[8001]; }],
    ['MQ report is unparsable', f => { f.reports[8001] = '{not json'; }],
    ['two MQ shards failed', f => {
      f.mqChecks.push(check(35, 'test-shard (2)', 800, 'failure'));
      f.jobs[35] = { ...f.jobs[31], id: 35, name: 'test-shard (2)' };
      f.artifacts[800].push(artifact(8002, 2, 800, mergeCommit));
      f.reports[8002] = report('failed', 'an unrelated test');
      f.logs[35] = logOf([file, 'an unrelated test']);
    }],
    ['an extra non-aggregator merge-gate check failed', f => {
      f.mqChecks.push(check(36, 'merge-gate', 800, 'failure'));
      f.jobs[36] = { ...f.jobs[31], id: 36, name: 'merge-gate' };
      f.logs[36] = 'merge-gate: HOLD — unrelated policy failure\n';
    }],
    ['test aggregator failed a step other than its gate', f => { f.jobs[32].steps[0].conclusion = 'failure'; }],
    ['coverage-merge aggregator failed a step other than its gate', f => { f.jobs[33].steps[0].conclusion = 'failure'; }],
    ['aggregator gate steps are unreadable', f => { delete f.jobs[32].steps; }],
    ['head run lacks the exact test', f => { f.reports[701] = report('passed', 'a different test'); }],
    ['exact test failed on head', f => { f.reports[701] = report('failed'); }],
    ['exact test is duplicated across two head shards', f => { f.reports[702] = report('passed'); }],
    ['exact test passes on one head shard but fails on another', f => { f.reports[702] = report('failed'); }],
    ['head artifact is unreadable', f => { delete f.reports[701]; }],
    ['another head shard artifact is unreadable', f => { delete f.reports[702]; }],
    ['head job identity mismatches the run', f => { f.jobs[41].run_id = 8; }],
    ['head job identity mismatches the name', f => { f.jobs[41].name = 'test-shard (9)'; }],
    ['head job identity mismatches the head SHA', f => { f.jobs[41].head_sha = prior; }],
    ['head run is not ci.yml', f => { f.runs[7].path = '.github/workflows/other.yml'; }],
    ['head run is not a pull_request run', f => { f.runs[7].event = 'push'; }],
    ['head run is for another head SHA', f => { f.runs[7].head_sha = prior; }],
    ['main success predates the second removal (but follows the first)', f => {
      Object.assign(f.runs[900], { created_at: iso(removedAt - 300_000), updated_at: iso(removedAt - 240_000) });
    }],
    ['main has only a failed run', f => { f.runs[900].conclusion = 'failure'; }],
    ['main has only an in-progress run', f => { Object.assign(f.runs[900], { status: 'in_progress', conclusion: null }); }],
    ...['BLOCKED', 'UNSTABLE', null].map(state => [`mergeStateStatus is ${state}`, f => { f.live.mergeStateStatus = state; }]),
    ['same-named head shard has an unfinished row', f => {
      f.headChecks.push({ ...check(45, 'test-shard (1)', 7), status: 'in_progress', conclusion: null, completed_at: null });
    }],
    ['same-named head shard failed newer than the newest success', f => {
      f.headChecks.push({ ...check(45, 'test-shard (1)', 7, 'failure'), completed_at: iso(removedAt) });
    }],
    ['same-named head shard failure ties the newest success', f => {
      f.headChecks.push(check(45, 'test-shard (1)', 7, 'failure'));
    }],
    ['head shard success has missing completed_at even with started_at', f => {
      delete f.headChecks[0].completed_at; f.headChecks[0].started_at = iso(removedAt - 120_000);
    }],
    ['another same-named head row has missing completed_at', f => {
      const row = check(45, 'test-shard (1)', 7, 'failure'); delete row.completed_at; f.headChecks.push(row);
    }],
    ['head shard has unparsable completed_at', f => { f.headChecks[0].completed_at = 'not a timestamp'; }],
    ['head shard has no successful row', f => { f.headChecks[0].conclusion = 'failure'; }],
    ['head test differs only by case', f => { assertion(f.reports[701]).title = title.toUpperCase(); }],
    ['head test differs by an extra word', f => { assertion(f.reports[701]).title = `${title} again`; }],
    ['head test is in a different report file', f => { f.reports[701].testResults[0].name += '.other'; }],
  ];
  it.each(closedCases)('holds exact-test retry 2/2 when %s', (_name, mutate) => exactFixture(f => {
    mutate(f);
    expectExactHold(f);
  }));

  it('allows the exact test to pass in a different head shard (shard reassignment)', () => exactFixture(f => {
    [f.reports[701], f.reports[702]] = [f.reports[702], f.reports[701]];
    expectExtraRetry(f);
  }));

  it('allows whitespace-padded titles and empty root ancestors to normalise to the same test id', () => exactFixture(f => {
    assertion(f.reports[8001]).ancestorTitles = ['session lifecycle'];
    assertion(f.reports[901]).ancestorTitles = ['session lifecycle'];
    Object.assign(assertion(f.reports[701]), { ancestorTitles: ['', '  session   lifecycle  ', ''],
      title: `  ${title.replaceAll(' ', '  ')}  `, fullName: '  session lifecycle ' + title });
    expectExtraRetry(f);
  }));

  it('allows the real vitest report shape where numRuntimeErrorTestSuites is absent', () => exactFixture(f => {
    delete f.reports[8001].numRuntimeErrorTestSuites;
    expectExtraRetry(f);
  }));

  describe('the final CLEAN/head check is its own uncached live read', () => {
    it.each([
      ['the PR becomes BLOCKED during evidence collection', { headRefOid: head, mergeStateStatus: 'BLOCKED' }],
      ['the head changes during evidence collection', { headRefOid: 'f'.repeat(40), mergeStateStatus: 'CLEAN' }],
    ])('holds when %s', (_name, later) => exactFixture(f => {
      // Early reads see CLEAN on the tested head; every later live read sees the changed state.
      // Evidence readers share one memoized call (the first read); the final authorizing read is a separate one.
      f.liveReads = [{ headRefOid: head, mergeStateStatus: 'CLEAN' }];
      f.live = later;
      expectExactHold(f);
    }));

    it('still allows when the final live read is CLEAN on the same head', () => exactFixture(f => {
      f.liveReads = [{ headRefOid: head, mergeStateStatus: 'CLEAN' }];
      expectExtraRetry(f);
    }));

    it('takes the final PR-state read last, after every evidence read', () => exactFixture(f => {
      f.guard();
      const calls = f.exec.mock.calls.map(([, args]) => args);
      const lastLive = calls.map(args => args.includes('mergeStateStatus,headRefOid')).lastIndexOf(true);
      const lastEvidence = calls.map(args => args.some(arg => /\/(?:artifacts|actions\/runs|check-runs|git\/ref)/.test(arg))).lastIndexOf(true);
      expect(lastLive).toBeGreaterThan(lastEvidence);
    }));
  });

  it('reads only the failed shard log summary tail, never an aggregator log', () => exactFixture(f => {
    f.guard();
    const reads = f.exec.mock.calls.flatMap(([, args]) => args.filter(arg => /\/logs(?:\?|$)/.test(arg)));
    expect(reads).toEqual([`repos/${repo}/actions/jobs/31/logs`]);
  }));

  describe('annotations and final summary (R953 residual: unhandled errors beside the sole failed test)', () => {
    const holdCases = [
      ['an extra unhandled-error failure annotation', f => { f.annotations[31] = shardAnnotations(
        { annotation_level: 'failure', message: 'Unhandled Rejection: boom' }); }],
      ['a failure annotation that is not the exit-code line', f => { f.annotations[31][1].message = 'Unhandled Error: boom'; }],
      ['no failure annotation at all', f => { f.annotations[31] = shardAnnotations().filter(a => a.annotation_level !== 'failure'); }],
      ['two exit-code failure annotations', f => { f.annotations[31] = shardAnnotations(
        { annotation_level: 'failure', message: 'Process completed with exit code 1.' }); }],
      ['an unreadable annotations list', f => { delete f.annotations[31]; }],
      ['an incomplete annotations list (count exceeds list)', f => { f.annotationCount = { 31: 4 }; }],
      ['a paginated annotations count above one page', f => { f.annotationCount = { 31: 101 }; }],
      ['an Errors line in the final summary', f => { f.logs[31] = shardLog(['Test Files  1 failed | 172 passed (173)',
        '     Tests  1 failed | 8911 passed (8912)', '     Errors  1 error', '   Start at  07:42:56', '   Duration  714.36s (x)']); }],
      ['a missing summary', f => { f.logs[31] = `${'x'.repeat(600)}\n##[error]Process completed with exit code 1.\n`; }],
      ['a truncated summary (no Duration line)', f => { f.logs[31] = shardLog(['Test Files  1 failed | 172 passed (173)',
        '     Tests  1 failed | 8911 passed (8912)']); }],
      ['two failed test files in the summary', f => { f.logs[31] = shardLog(['Test Files  2 failed | 171 passed (173)',
        '     Tests  1 failed | 8911 passed (8912)', '   Start at  07:42:56', '   Duration  1s (x)']); }],
      ['two failed tests in the summary', f => { f.logs[31] = shardLog(['Test Files  1 failed | 172 passed (173)',
        '     Tests  2 failed | 8910 passed (8912)', '   Start at  07:42:56', '   Duration  1s (x)']); }],
      ['two summary blocks (ambiguous)', f => { f.logs[31] = `${shardLog()}${shardLog()}`; }],
      ['an unreadable job log', f => { delete f.logs[31]; }],
      ['no failed test file in the JSON report', f => { f.reports[8001].testResults[0].status = 'passed'; }],
    ];
    it.each(holdCases)('holds on %s', (_name, mutate) => exactFixture(f => { mutate(f); expectExactHold(f); }));

    it('allows the real #6903 shape: warning + exit-code failure + notice, over-long lines, plain summary', () => exactFixture(f => {
      expectExtraRetry(f);
    }));
  });

  it('holds when a fresh main success has a newer unfinished main run', () => exactFixture(f => {
    f.mainRuns.push({ ...f.runs[900], id: 902, status: 'in_progress', conclusion: null,
      created_at: iso(removedAt + 700_000) });
    expect(f.guard().hold).toBe(true);
  }));

  it('holds when a higher-ID unfinished main run shares the deciding success timestamp', () => exactFixture(f => {
    f.mainRuns.push({ ...f.runs[900], id: 902, status: 'in_progress', conclusion: null });
    expect(f.guard().hold).toBe(true);
  }));

  it('allows an older lower-ID unfinished main run at the same timestamp', () => exactFixture(f => {
    f.mainRuns.push({ ...f.runs[900], id: 899, status: 'in_progress', conclusion: null });
    expectExtraRetry(f);
  }));

  it.each([['head', 7, 1], ['main', 900, 1], ['head', 7, 0], ['main', 900, 0]])(
    'holds when a %s shard timing artifact is missing (run %s, index %s)', (_name, runId, index) => exactFixture(f => {
    // Cover both the target's artifact and an unrelated shard that could hide a second occurrence.
    f.artifacts[runId].splice(index, 1);
    expect(f.guard().hold).toBe(true);
  }));

  it.each([['head', 7], ['main', 900]])('holds when %s shard job evidence is incomplete', (_name, runId) => exactFixture(f => {
    delete f.runJobs[runId];
    expect(f.guard().hold).toBe(true);
  }));

  it.each([['head', 7], ['main', 900]])('holds when %s has duplicate timing artifacts hiding a missing shard', (_name, runId) => exactFixture(f => {
    f.artifacts[runId][1].name = 'timing-unit-1';
    expect(f.guard().hold).toBe(true);
  }));

  it('holds when both a head shard job and its artifact are missing but the head check remains', () => exactFixture(f => {
    f.runJobs[7].pop();
    f.artifacts[7].pop();
    expect(f.guard().hold).toBe(true);
  }));

  it.each([['head', 7], ['main', 900]].flatMap(([name, runId]) =>
    ['run_id', 'head_sha', 'conclusion', 'status'].map(key => [name, runId, key])))(
    'holds when a %s shard job has invalid identity or completion (%s, %s)', (_name, runId, key) => exactFixture(f => {
      f.runJobs[runId][1][key] = { run_id: 999, head_sha: prior, conclusion: 'failure', status: 'in_progress' }[key];
      expect(f.guard().hold).toBe(true);
    }));

  it('holds when the shared retry-evidence budget is exhausted', () => exactFixture(f => {
    for (let n = 3; n <= 16; n++) {
      for (const [runId, sha, offset] of [[7, head, 7000], [900, mainSha, 9000]]) {
        const id = offset + n;
        f.artifacts[runId].push(artifact(id, n, runId, sha));
        f.reports[id] = report('passed', `unrelated test ${n}`);
        f.runJobs[runId].push({ id, name: `test-shard (${n})`, run_id: runId, head_sha: sha,
          status: 'completed', conclusion: 'success' });
      }
    }
    for (const rows of [f.mqChecks, f.headChecks]) {
      while (rows.length < 500) rows.push(check(10000 + rows.length, 'unrelated', 800));
    }
    for (const runId of [7, 900]) {
      while (f.artifacts[runId].length < 500) f.artifacts[runId].push({ id: 20000 + f.artifacts[runId].length,
        name: 'unrelated-artifact' });
      while (f.runJobs[runId].length < 500) f.runJobs[runId].push({ id: 30000 + f.runJobs[runId].length,
        name: 'unrelated-job' });
    }
    const result = f.guard();
    expect(result.hold).toBe(true);
    const ghCalls = f.exec.mock.calls.filter(([command]) => command === 'gh');
    // Two guard reads (queue state and timeline) precede the shared evidence allowance.
    expect(ghCalls).toHaveLength(68 + 2);
    expect(f.exec.mock.calls.some(([, args]) => args.some(a => a.includes('status=completed&created=')))).toBe(true);
    expect(f.exec.mock.calls.some(([, args]) => args.includes(`repos/${repo}/actions/artifacts/901/zip`))).toBe(true);
    expect(result.reason).toMatch(/operator must inspect|enqueue manually/);
  }));

  it.each([false, true])('staged evidence readers issue each rerun request only once (refused=%s)', refused => exactFixture(f => {
    f.mqChecks = [check(31, 'test-shard (1)', 800, 'failure')];
    Object.assign(f.mqChecks[0], { head_sha: mergeCommit, started_at: iso(removedAt - 120_000) });
    f.logs[31] = shardLog().slice(601); // An ordinary test failure, eligible for a job rerun.
    const underlying = f.exec.getMockImplementation();
    f.exec.mockImplementation((command, args, opts) => {
      if (refused && args.includes('POST')) throw new Error('ambiguous rerun response');
      return underlying(command, args, opts);
    });
    expect(f.guard().hold).toBe(false);
    // The base requests a rerun and the exact reader revisits the same merge-group checks.
    expect(f.exec.mock.calls.filter(([, args]) => args.includes(`repos/${repo}/actions/artifacts/8001/zip`))).toHaveLength(1);
    expect(f.exec.mock.calls.filter(([, args]) => args.some(a => a.includes(`commits/${mergeCommit}/check-runs`)))).toHaveLength(1);
    expect(f.guard().hold).toBe(false);
    expect(f.exec.mock.calls.filter(([, args]) => args.includes('POST') && args.includes(`repos/${repo}/actions/jobs/31/rerun`))).toHaveLength(1);
  }));

  it.each(['merge-gate freeze', 'runner-loss pattern', 'aggregator log fallback'])('preserves the two-removal log-based infrastructure retry: %s', route => exactFixture(f => {
    const infraLog = 'fatal: could not fetch abc123 from promisor remote\n';
    if (route === 'merge-gate freeze') {
      f.mqChecks = [check(36, 'merge-gate', 800, 'failure')];
      f.logs[36] = '2026-11-07T23:00:00Z hold  red-main-freeze  main is RED (freeze: fixture)\n';
    } else if (route === 'runner-loss pattern') {
      f.mqChecks = [check(31, 'test-shard (1)', 800, 'failure')];
      f.logs[31] = infraLog;
    } else {
      f.logs[31] = f.logs[32] = f.logs[33] = infraLog;
      delete f.jobs[32].steps;
      delete f.jobs[33].steps;
    }
    f.artifacts = {}; f.reports = {};
    expect(f.guard().hold).toBe(false);
    expect(f.exec.mock.calls.some(([, args]) => args.some(a => /\/logs$/.test(a)))).toBe(true);
    if (route === 'aggregator log fallback') {
      expect(f.exec.mock.calls.some(([, args]) => args.includes(`repos/${repo}/actions/jobs/32/logs`))).toBe(true);
      expect(f.exec.mock.calls.some(([, args]) => args.includes(`repos/${repo}/actions/jobs/33/logs`))).toBe(true);
    }
    expect(f.log.mock.calls[0][0]).toMatch(/infra retry 2\/2/);
  }));

  it('holds when numRuntimeErrorTestSuites is present but unreadable', () => exactFixture(f => {
    f.reports[8001].numRuntimeErrorTestSuites = 'NaN';
    expect(f.guard().hold).toBe(true);
  }));

  it('allows an older same-named head failure when a strictly newer success exists', () => exactFixture(f => {
    f.headChecks.push({ ...check(45, 'test-shard (1)', 7, 'failure'), completed_at: iso(removedAt - 120_000) });
    expectExtraRetry(f);
  }));

  it('allows an old success when it is the newest run for current main HEAD', () => exactFixture(f => {
    f.now += 86_400_000;
    expectExtraRetry(f);
  }));

  it.each(['cancelled', 'startup_failure', 'stale', 'action_required'])('ignores newer main %s runs', conclusion => exactFixture(f => {
    f.mainRuns.push({ ...f.runs[900], id: 901, conclusion, created_at: iso(removedAt + 700_000) });
    expectExtraRetry(f);
  }));

  it('allows reassignment to another main shard within a bounded gh budget', () => exactFixture(f => {
    [f.reports[901], f.reports[902]] = [f.reports[902], f.reports[901]];
    expectExtraRetry(f);
    // Evidence readers share 68 calls; the guard itself reads queue state and timeline separately.
    expect(f.exec.mock.calls.filter(([command]) => command === 'gh').length).toBeLessThanOrEqual(68 + 2);
  }));

  it('holds with the existing cap line after a third failed removal on the same head', () => exactFixture(f => {
    f.events.push({ ...added, createdAt: iso(removedAt + 60_000) }, { ...removed(), createdAt: iso(removedAt + 120_000) });
    expectExactHold(f, /failed_checks \(3 removals on this head\); operator must inspect history and enqueue manually/);
  }));

  it('holds with the existing spent-retries line after a third Added event (already queued twice after failure)', () => exactFixture(f => {
    f.events.push({ ...added, createdAt: iso(removedAt + 60_000) });
    expectExactHold(f, /failed_checks \(the two infrastructure retries were already spent\); operator must inspect history and enqueue manually/);
  }));

  it('preserves the two-removal infrastructure retry route without exact-test report evidence', () => exactFixture(f => {
    // startup_failure retains the legacy main-green route; complete cancellation evidence has a single retry.
    f.mqChecks = [check(31, 'test-shard (1)', 800, 'startup_failure')];
    f.artifacts = {}; f.reports = {};
    expect(f.guard().hold).toBe(false);
    expect(f.log.mock.calls[0][0]).toMatch(/^mq-same-head-retry: #6903 head \w+ — failed_checks infra retry 2\/2/);
  }));
});

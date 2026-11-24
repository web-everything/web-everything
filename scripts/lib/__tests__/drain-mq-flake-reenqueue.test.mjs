import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideMqSameHead, mqSameHeadGuard } from '../drain-queue-safety.mjs';

vi.mock('../settings-files.mjs', async importOriginal => ({
  ...await importOriginal(), readSettings: vi.fn(() => ({ drain: {} })),
}));

const repo = 'fixture/drain', pr = 6215;
const head = 'a'.repeat(40), mergeCommit = 'b'.repeat(40);
const now = Date.parse('2026-11-01T14:00:00Z');
const MAX_JOBS = 10;
const testLog = 'FAIL test/shard.test.ts > adds numbers\nAssertionError: expected 2 to be 3\n';
const ceilingLog = 'heavy-admission-run-ceiling: command exceeded run ceiling\n';
const removal = (createdAt = '2026-11-01T13:45:00Z') => ({
  __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt,
  beforeCommit: { oid: mergeCommit, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } },
});
const added = createdAt => ({ __typename: 'AddedToMergeQueueEvent', createdAt });
const history = count => [
  removal(),
  ...(count >= 2 ? [added('2026-11-01T13:46:00Z'), removal('2026-11-01T13:50:00Z')] : []),
  ...(count >= 3 ? [added('2026-11-01T13:51:00Z'), removal('2026-11-01T13:55:00Z')] : []),
];

// Check-run IDs deliberately differ from Actions job IDs. Reruns retain the name
// and commit, but get a new identity and a later completion time.
const job = (id, name = `test-shard-${id}`, conclusion = 'failure', overrides = {}) => ({
  id: 1000 + id, name, head_sha: mergeCommit, status: 'completed', conclusion,
  started_at: '2026-11-01T13:30:00Z', completed_at: '2026-11-01T13:40:00Z',
  details_url: `https://github.com/${repo}/actions/runs/201/job/${id}`,
  output: { title: '', summary: '', text: '' }, ...overrides,
});
const rerun = (original, id, conclusion = 'success') => job(id, original.name, conclusion, {
  started_at: '2026-11-01T13:46:00Z',
  completed_at: conclusion === null ? null : '2026-11-01T13:49:00Z',
  status: conclusion === null ? 'in_progress' : 'completed',
});

// Same injected GitHub boundary as drain-mq-retry-infra-allowlist.test.mjs.
// setChecks models later API sightings without inventing a persisted retry ledger.
function fixture({ checks = [job(21)], events = history(1), mergeState = 'CLEAN',
  logText = testLog } = {}) {
  let currentChecks = checks;
  const posts = [], checkReads = [], unexpected = [];
  const exec = vi.fn((command, args) => {
    if (command !== 'gh') throw new Error('unexpected non-GitHub IO');
    if (args.some(arg => arg.includes('isInMergeQueue'))) {
      return JSON.stringify({ data: { repository: { pullRequest: {
        isInMergeQueue: false, headRefOid: head,
      } } } });
    }
    if (args.some(arg => arg.includes('timelineItems'))) {
      return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: {
        nodes: events, pageInfo: { hasPreviousPage: false },
      } } } } });
    }
    if (args.includes('mergeStateStatus,headRefOid')) {
      return JSON.stringify({ headRefOid: head, mergeStateStatus: mergeState });
    }
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
    if (args.includes('POST')) {
      posts.push([...args]);
      if (args[0] === 'api' && args[1] === '-X' && args[2] === 'POST'
        && new RegExp(`^repos/${repo}/actions/jobs/[1-9][0-9]*/rerun$`).test(endpoint)) return '';
      unexpected.push(args);
      throw new Error('unexpected GitHub mutation');
    }
    if (endpoint?.startsWith(`repos/${repo}/commits/${mergeCommit}/check-runs?`)) {
      checkReads.push(endpoint);
      const query = new URLSearchParams(endpoint.split('?')[1]);
      if (query.get('filter') !== 'all') throw new Error('attempt history must use filter=all');
      const page = Number(query.get('page') ?? 1), limit = Number(query.get('per_page') ?? 100);
      return JSON.stringify({ total_count: currentChecks.length,
        check_runs: currentChecks.slice((page - 1) * limit, page * limit) });
    }
    if (/\/actions\/jobs\/\d+\/logs$/.test(endpoint ?? '')) return logText;
    if (endpoint?.startsWith(`repos/${repo}/actions/workflows/ci.yml/runs?`)) {
      const run = { id: 102, conclusion: 'success', status: 'completed',
        created_at: '2026-11-01T13:20:00Z', updated_at: '2026-11-01T13:20:00Z',
        path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push' };
      return JSON.stringify({ total_count: 1, workflow_runs: [run] });
    }
    unexpected.push(args);
    throw new Error(`unexpected GitHub IO: ${args.join(' ')}`);
  });
  return { posts, checkReads, setChecks: value => { currentChecks = value; },
    guard: (extra = {}) => {
      const result = mqSameHeadGuard({ repo, pr, head, exec, now, quarantine: { readList: null }, ...extra });
      expect(unexpected).toEqual([]);
      return result;
    } };
}

function expectPosts(f, ids) {
  expect(f.posts).toEqual(ids.map(id => ['api', '-X', 'POST', `repos/${repo}/actions/jobs/${id}/rerun`]));
}
function expectRerunRetry(decision) {
  // The private reader's classification is observable through the public retry line.
  expect(decision.hold).toBe(false);
  expect(decision.line).toContain('rerun-green');
  expect(decision.line).toMatch(/rerun-confirmed flake/i);
}

describe('same-head MQ infrastructure retry cap of two', () => {
  const decide = (count, infra = 'infra') => decideMqSameHead({ pr, head,
    timeline: { nodes: history(count), hasPreviousPage: false }, mergeState: 'CLEAN',
    retryEvidence: { infra, mainGreen: true, mergeState: 'CLEAN' },
  });

  it('allows infrastructure retry 1/2 after the first failed_checks removal', () => {
    const decision = decide(1);
    expect(decision.hold).toBe(false);
    expect(decision.line).toContain('infra retry 1/2');
  });

  it('allows infrastructure retry 2/2 after re-addition and a second failure on the same head', () => {
    const decision = decide(2);
    expect(decision.hold).toBe(false);
    expect(decision.line).toContain('infra retry 2/2');
  });

  it('holds a third failed_checks removal with an operator inspection fallback', () => {
    const decision = decide(3);
    expect(decision.hold).toBe(true);
    expect(decision.line).toMatch(/3 removals on this head.*operator must inspect history and enqueue manually/);
  });

  it('holds non-infrastructure evidence at the first removal even with green main and CLEAN PR', () => {
    expect(decide(1, null).hold).toBe(true);
  });
});

describe('rerun-confirmed MQ flakes through mqSameHeadGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv('VITEST', '');
    vi.stubEnv('WE_UNDER_TEST', '');
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('never POSTs a rerun during a dry run and still holds with a visible dry-run reason', () => {
    const f = fixture({ checks: [job(21), job(22)], logText: testLog });
    const decision = f.guard({ dryRun: true });
    expect(decision.hold).toBe(true);
    expect(f.posts).toEqual([]);
    expect(decision.reason ?? decision.line).toMatch(/dry.?run/i);
  });

  it.each([['assertion failure', testLog], ['heavy-admission run ceiling', ceilingLog]])(
    'requests one rerun per failed Actions job on first sight of %s and holds visibly', (_name, logText) => {
      const f = fixture({ checks: [job(21), job(22)], logText });
      const decision = f.guard();
      expect(decision.hold).toBe(true);
      expectPosts(f, [21, 22]);
      expect(decision.reason ?? decision.line).toMatch(/rerun requested/i);
      expect(f.checkReads).toHaveLength(1);
      expect(f.checkReads[0]).toContain('filter=all');
    });

  it('re-enqueues only after every failed job name has a later successful rerun on the merge commit', () => {
    const a = job(21), b = job(22), f = fixture({ checks: [a, b] });
    expect(f.guard().hold).toBe(true);
    // Deliberately unordered: later means completion time, not API array position.
    f.setChecks([rerun(b, 42), a, rerun(a, 41), b]);
    expectRerunRetry(f.guard());
    expectPosts(f, [21, 22]);
  });

  it.each([['failed', 'failure'], ['still in progress', null]])(
    'holds when the same job rerun is %s and never POSTs a second rerun', (_name, conclusion) => {
      const a = job(21), f = fixture({ checks: [a] });
      expect(f.guard().hold).toBe(true);
      const initialPosts = [...f.posts];
      f.setChecks([a, rerun(a, 41, conclusion)]);
      expect(f.guard().hold).toBe(true);
      expect(f.posts).toEqual(initialPosts);
      expectPosts(f, [21]);
    });

  it('holds mixed evidence when one job reran green and another failed twice', () => {
    const a = job(21), b = job(22);
    const f = fixture({ checks: [a, b, rerun(a, 41), rerun(b, 42, 'failure')] });
    expect(f.guard().hold).toBe(true);
    expectPosts(f, []);
  });

  it('never re-enqueues a real failure whose job failed twice, including repeated later sightings', () => {
    const a = job(21), f = fixture({ checks: [a, rerun(a, 41, 'failure')] });
    expect(f.guard().hold).toBe(true);
    expect(f.guard().hold).toBe(true);
    expectPosts(f, []);
  });

  it('holds rerun-green evidence when the PR merge state is not CLEAN', () => {
    const a = job(21), f = fixture({ checks: [a, rerun(a, 41)], mergeState: 'BLOCKED' });
    const decision = f.guard();
    expect(decision.hold).toBe(true);
    expect(decision.reason ?? decision.line).toMatch(/not CLEAN.*BLOCKED/);
    expectPosts(f, []);
  });

  it('holds a third same-head removal even when the last merge commit has rerun-green evidence', () => {
    const a = job(21), f = fixture({ checks: [a, rerun(a, 41)], events: history(3) });
    const decision = f.guard();
    expect(decision.hold).toBe(true);
    expect(decision.line).toMatch(/3 removals on this head/);
    expectPosts(f, []);
  });

  it('requests at most ten reruns at the failed-job bound, once per Actions job', () => {
    const checks = Array.from({ length: MAX_JOBS }, (_, i) => job(21 + i));
    const f = fixture({ checks });
    expect(f.guard().hold).toBe(true);
    expectPosts(f, checks.map((_, i) => 21 + i));
  });

  it('fails closed above the ten-job bound with an operator fallback and bounded rerun cost', () => {
    const f = fixture({ checks: Array.from({ length: MAX_JOBS + 1 }, (_, i) => job(21 + i)) });
    const decision = f.guard();
    expect(decision.hold).toBe(true);
    expect(decision.reason ?? decision.line).toMatch(/10-job limit.*operator must inspect/);
    expect(f.posts.length).toBeLessThanOrEqual(MAX_JOBS);
  });

  it('fails closed when a successful same-name check belongs to a different commit', () => {
    const a = job(21), f = fixture({ checks: [a, { ...rerun(a, 41), head_sha: 'd'.repeat(40) }] });
    expect(f.guard().hold).toBe(true);
  });

  it('fails closed when the only successful same-name check predates the failed attempt', () => {
    const a = job(21), f = fixture({ checks: [a, { ...rerun(a, 41),
      started_at: '2026-11-01T13:25:00Z', completed_at: '2026-11-01T13:29:00Z' }] });
    expect(f.guard().hold).toBe(true);
  });
});

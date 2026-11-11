import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mqSameHeadGuard } from '../drain-queue-safety.mjs';

const repo = 'fixture/drain', pr = 6215;
const head = 'a'.repeat(40), mergeCommit = 'b'.repeat(40);
const now = Date.parse('2026-11-01T14:00:00Z');
const failedName = 'build-linux';
const removal = (createdAt = '2026-11-01T13:45:00Z') => ({
  __typename: 'RemovedFromMergeQueueEvent', reason: 'failed_checks', createdAt,
  beforeCommit: { oid: mergeCommit, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } },
});
const run = (id, conclusion = 'success', created_at = '2026-11-01T13:20:00Z',
  updated_at = '2026-11-01T13:30:00Z') => ({
  id, conclusion, created_at, updated_at, status: 'completed',
  path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push',
});
const pending = () => ({ ...run(103, null, '2026-11-01T13:50:00Z'), status: 'in_progress' });

// Model the API's filters/limits, including the historical query used to judge main at removal.
// All reads are injected; quarantine is disabled so no developer state is consulted.
function fixture(runs, events = [removal()]) {
  const log = vi.fn();
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
      return JSON.stringify({ headRefOid: head, mergeStateStatus: 'CLEAN' });
    }
    const endpoint = args.find(arg => arg.startsWith(`repos/${repo}/`));
    if (endpoint?.startsWith(`repos/${repo}/commits/${mergeCommit}/check-runs?`)) {
      return JSON.stringify({ total_count: 1, check_runs: [{
        id: 21, name: failedName, status: 'completed', conclusion: 'failure',
        output: { title: 'Runner disconnected', summary: '' },
      }] });
    }
    if (endpoint?.startsWith(`repos/${repo}/actions/workflows/ci.yml/runs?`)) {
      const query = new URLSearchParams(endpoint.split('?')[1]);
      let selected = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
      if (query.get('status')) selected = selected.filter(item => item.status === query.get('status'));
      const before = query.get('created');
      if (before?.startsWith('<')) selected = selected.filter(item => Date.parse(item.created_at) < Date.parse(before.slice(1)));
      const total_count = selected.length;
      const limit = Number(query.get('per_page') ?? 100);
      const page = Number(query.get('page') ?? 1);
      return JSON.stringify({ total_count, workflow_runs: selected.slice((page - 1) * limit, page * limit) });
    }
    throw new Error(`unexpected GitHub read: ${args.join(' ')}`);
  });
  return {
    log,
    guard: () => mqSameHeadGuard({ repo, pr, head, exec, log, quarantine: { readList: null } }),
    retryLog: () => log.mock.calls.map(([line]) => line).find(line => line.startsWith('mq-same-head-retry:')),
    declineLog: () => log.mock.calls.map(([line]) => line).find(line => line.startsWith('mq-same-head-retry-declined:')),
  };
}

describe('same-head retry uses fresh completed main CI evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('accepts a recent completed green run while the newest main push is in progress', () => {
    const f = fixture([pending(), run(102)]);
    expect(f.guard().hold).toBe(false);
    expect(f.retryLog()).toContain('failed_checks infra retry 1/2 (main green, PR CLEAN');
    expect(f.retryLog()).toContain('102');
    expect(f.retryLog()).toContain(failedName);
  });

  it('declines a newest completed failure even when an older completed run is green, naming the run and failed check', () => {
    const f = fixture([run(102, 'failure'), run(101, 'success', '2026-11-01T13:00:00Z', '2026-11-01T13:10:00Z')]);
    expect(f.guard().hold).toBe(true);
    expect(f.declineLog()).toContain('main CI is not green');
    expect(f.declineLog()).toContain('102');
    expect(f.declineLog()).toContain('failure');
    expect(f.declineLog()).toContain(failedName);
  });

  it.each(['cancelled', 'startup_failure', 'stale', 'action_required'])(
    'skips a completed %s run and accepts the next completed green run, logging its deciding id', conclusion => {
      const f = fixture([run(102, conclusion), run(101, 'success', '2026-11-01T13:00:00Z', '2026-11-01T13:10:00Z')]);
      expect(f.guard().hold).toBe(false);
      expect(f.retryLog()).toContain('mq-same-head-retry:');
      expect(f.retryLog()).toContain('101');
      expect(f.retryLog()).not.toContain('102');
      expect(f.retryLog()).toContain(failedName);
    },
  );

  it('counts a newest completed timed_out run as red (R780), declining with a reason naming it even when an older run is green', () => {
    const f = fixture([run(102, 'timed_out'), run(101, 'success', '2026-11-01T13:00:00Z', '2026-11-01T13:10:00Z')]);
    expect(f.guard().hold).toBe(true);
    expect(f.retryLog()).toBeUndefined();
    expect(f.declineLog()).toContain('main CI is not green');
    expect(f.declineLog()).toContain('102');
    expect(f.declineLog()).toContain('timed_out');
  });

  it('declines green evidence updated more than two hours ago, naming the stale run and failed check', () => {
    const f = fixture([run(102, 'success', '2026-11-01T11:00:00Z', '2026-11-01T11:59:59.999Z')]);
    expect(f.guard().hold).toBe(true);
    expect(f.declineLog()).toContain('102');
    expect(f.declineLog()).toMatch(/stale/i);
    expect(f.declineLog()).toContain(failedName);
  });

  it('accepts green evidence updated exactly two hours ago even if created earlier', () => {
    const f = fixture([run(102, 'success', '2026-11-01T11:00:00Z', '2026-11-01T12:00:00Z')]);
    expect(f.guard().hold).toBe(false);
  });

  it('fails closed with no completed main run and logs the missing evidence and failed check', () => {
    const f = fixture([pending()]);
    expect(f.guard().hold).toBe(true);
    expect(f.declineLog()).toContain('no completed run');
    expect(f.declineLog()).toContain(failedName);
  });

  it('still holds a third removal on the same head despite fresh green main CI', () => {
    const f = fixture([pending(), run(102)], [removal(), {
      __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-01T13:46:00Z',
    }, removal('2026-11-01T13:50:00Z'), {
      __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-01T13:51:00Z',
    }, removal('2026-11-01T13:55:00Z')]);
    const result = f.guard();
    expect(result.hold).toBe(true);
    expect(result.line).toContain('3 removals on this head');
    expect(result.line).toContain('operator must inspect history and enqueue manually');
    expect(f.declineLog()).toContain('retry bound reached');
    expect(f.retryLog()).toBeUndefined();
  });
});

// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mqSameHeadGuard } from '../drain-queue-safety.mjs';

const repo = 'fixture/drain', pr = 6215, head = 'a'.repeat(40), commit = 'b'.repeat(40);
const removedAt = '2026-11-01T12:00:00.000Z';
const endpoint = `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push`;
const latestQuery = `${endpoint}&per_page=1`;
const beforeQuery = `${endpoint}&status=completed&created=<${removedAt}&per_page=100`;
const unreadable = 'retry evidence unreadable or incomplete';
const run = (id, conclusion, created_at) => ({ id, conclusion, created_at, updated_at: created_at,
  status: 'completed', path: '.github/workflows/ci.yml', head_branch: 'main', event: 'push' });

function fixture({ failQuery, latest, before, mergeState = 'BEHIND', checks } = {}) {
  const replies = {
    [latestQuery]: latest ?? { total_count: 2500, workflow_runs: [run(2500, 'success', '2026-11-01T13:00:00Z')] },
    [beforeQuery]: before ?? { total_count: 2499, workflow_runs: Array.from({ length: 100 }, (_, index) =>
      run(2499 - index, 'failure', '2026-11-01T11:00:00Z')) },
  };
  const log = vi.fn();
  const exec = vi.fn((command, args) => {
    if (command !== 'gh') throw new Error('unexpected non-GitHub IO');
    if (args.some(arg => arg.includes('isInMergeQueue')))
      return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
    if (args.some(arg => arg.includes('timelineItems')))
      return JSON.stringify({ data: { repository: { pullRequest: { timelineItems: {
        pageInfo: { hasPreviousPage: false }, nodes: [{ __typename: 'RemovedFromMergeQueueEvent',
          reason: 'failed_checks', createdAt: removedAt,
          beforeCommit: { oid: commit, parents: { nodes: [{ oid: 'c'.repeat(40) }, { oid: head }] } } }],
      } } } } });
    if (args.includes('mergeStateStatus,headRefOid'))
      return JSON.stringify({ headRefOid: head, mergeStateStatus: mergeState });
    if (args[1] === `repos/${repo}/commits/${commit}/check-runs?filter=all&per_page=100&page=1`)
      return JSON.stringify({ total_count: 1, check_runs: checks ?? [{ id: 21, name: 'unit',
        status: 'completed', conclusion: 'failure', output: { title: 'Assertion failed' } }] });
    if (args[1] === failQuery) throw new Error('targeted query unavailable');
    if (Object.hasOwn(replies, args[1])) return JSON.stringify(replies[args[1]]);
    throw new Error(`unexpected or paged request: ${args.join(' ')}`);
  });
  const decision = mqSameHeadGuard({ repo, pr, head, exec, log, quarantine: { readList: null } });
  const decline = log.mock.calls.map(([line]) => line).find(line => line.startsWith('mq-same-head-retry-declined:'));
  return { decision, decline, exec };
}

describe('targeted main CI retry evidence lookup', () => {
  it('finds evidence in 2500 runs using only the two targeted reads and preserves the CLEAN requirement', () => {
    const f = fixture();
    expect(f.decision.hold).toBe(true);
    expect(f.decline).toContain('PR is not CLEAN (BEHIND)');
    expect(f.decline).not.toContain(unreadable);
    const reads = f.exec.mock.calls.filter(([, args]) => args[1]?.startsWith(endpoint));
    expect(reads.map(([, args]) => args[1])).toEqual([latestQuery, beforeQuery]);
    for (const [, , options] of reads) expect(options.throttle.maxAttempts).toBe(1);
    expect(f.exec.mock.calls.filter(([, args]) => args[0] === 'api' && args[1].startsWith('repos/')).length).toBe(3);
  });

  it('permits the existing main-red retry when main is green and the PR is CLEAN', () => {
    const f = fixture({ mergeState: 'CLEAN' });
    expect(f.decision.hold).toBe(false);
    expect(f.decline).toBeUndefined();
  });

  it.each([latestQuery, beforeQuery])('fails closed when targeted query %s throws', failQuery => {
    const f = fixture({ failQuery });
    expect(f.decision.hold).toBe(true);
    expect(f.decline).toContain(unreadable);
  });

  it('keeps the non-infrastructure decline when no completed run predates removal', () => {
    const f = fixture({ before: { total_count: 0, workflow_runs: [] }, mergeState: 'CLEAN' });
    expect(f.decision.hold).toBe(true);
    expect(f.decline).toContain('non-infrastructure failed check(s): unit; main was not red at removal');
  });

  it('fails closed when the completed-before page reports two runs but contains only one older red run', () => {
    const f = fixture({ before: { total_count: 2, workflow_runs: [
      run(2499, 'failure', '2026-11-01T11:00:00Z'),
    ] }, mergeState: 'CLEAN' });
    expect(f.decision.hold).toBe(true);
    expect(f.decline).toContain(unreadable);
  });

  it.each(['latest', 'before'])('fails closed on malformed %s response shape or identity', query => {
    for (const response of [null, {}, { total_count: 1, workflow_runs: [] },
      { total_count: -1, workflow_runs: [] },
      { total_count: 2500, workflow_runs: [run(0, 'success', removedAt)] },
      { total_count: 2500, workflow_runs: [{ ...run(1, 'success', removedAt), path: 'other.yml' }] },
      { total_count: 2500, workflow_runs: [{ ...run(1, 'success', removedAt), updated_at: null }] }]) {
      // Null must reach the reader rather than select the fixture default.
      const f = fixture({ [query]: response === null ? 'invalid' : response });
      expect(f.decision.hold).toBe(true);
      expect(f.decline).toContain(unreadable);
    }
  });

  it('does not treat a red run completed after removal as main-red evidence', () => {
    const f = fixture({ before: { total_count: 1, workflow_runs: [
      { ...run(2499, 'failure', '2026-11-01T11:00:00Z'), updated_at: '2026-11-01T13:00:00Z' },
    ] }, mergeState: 'CLEAN' });
    expect(f.decision.hold).toBe(true);
    expect(f.decline).toContain('main was not red at removal');
  });
});

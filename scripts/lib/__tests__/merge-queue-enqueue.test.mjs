// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ENQUEUE_MUTATION, mergeActionFor, buildEnqueueArgs, enqueuePr, planQueueFollowUps, rulesetSuggestion } from '../merge-queue-enqueue.mjs';

const HEAD = 'a'.repeat(40);

describe('merge queue enqueue', () => {
  it.each([
    [{ strategy: 'github-merge-queue' }, 'enqueue'],
    [{ strategy: 'drain-direct' }, 'merge'],
    [null, 'merge'],
  ])('chooses the action for %j', (policy, action) => {
    expect(mergeActionFor(policy)).toBe(action);
  });

  it('builds a mutation pinned to the PR node and judged head', () => {
    const args = buildEnqueueArgs({ nodeId: 'PR_1', headSha: HEAD });
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toEqual(expect.arrayContaining([`query=${ENQUEUE_MUTATION}`, 'id=PR_1', `sha=${HEAD}`]));
    expect(() => buildEnqueueArgs({ headSha: HEAD })).toThrow(/node id required/);
    expect(() => buildEnqueueArgs({ nodeId: 'PR_1' })).toThrow(/head SHA required/);
  });

  it('reads the node id and enqueues exactly the judged head', () => {
    const calls = [];
    const entry = { id: 'E', position: 1, state: 'QUEUED' };
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, exec: (...args) => {
      calls.push(args);
      return calls.length === 1 ? '{"id":"PR_1"}' : JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: entry } } });
    } });
    expect(result).toEqual({ ok: true, entry });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['gh', ['pr', 'view', '7', '--repo', 'o/r', '--json', 'id'], expect.objectContaining({ encoding: 'utf8' })]);
    expect(calls[1][0]).toBe('gh');
    expect(calls[1][1]).toEqual(buildEnqueueArgs({ nodeId: 'PR_1', headSha: HEAD }));
    expect(calls[1][1]).toContain(`sha=${HEAD}`);
  });

  it.each([
    ['already in the merge queue', { ok: true, already: true }],
    ['permission denied', { ok: false, error: 'permission denied' }],
  ])('handles GraphQL errors: %s', (message, expected) => {
    let calls = 0;
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, exec: () => {
      calls += 1;
      return calls === 1 ? '{"id":"PR_1"}' : JSON.stringify({ errors: [{ message }] });
    } });
    expect(result).toEqual(expected);
    expect(calls).toBe(2);
  });

  it('fails without enqueueing when the PR read throws', () => {
    let calls = 0;
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, exec: () => {
      calls += 1;
      throw new Error('offline');
    } });
    expect(result).toEqual({ ok: false, error: 'node id read failed: offline' });
    expect(calls).toBe(1);
  });

  it('filters completed follow-ups and orders the remainder by merge time', () => {
    expect(planQueueFollowUps({ merged: [
      { number: 3, mergedAt: '2026-01-03T00:00:00Z', mergeCommit: { oid: 'c' } },
      { number: 1, mergedAt: '2026-01-01T00:00:00Z', mergeCommit: { oid: 'a' } },
      { number: 2, mergedAt: '2026-01-02T00:00:00Z', mergeCommit: { oid: 'b' } },
    ], followedUp: new Set([2]) })).toEqual([
      { num: 1, mergeSha: 'a', mergedAt: '2026-01-01T00:00:00Z' },
      { num: 3, mergeSha: 'c', mergedAt: '2026-01-03T00:00:00Z' },
    ]);
  });

  it('suggests the configured queue and required safety checks', () => {
    const result = rulesetSuggestion({ mergeMethod: 'merge', batchSize: 3, maxGroupWaitMinutes: 5 });
    expect(result.mergeQueue).toMatchObject({ mergeMethod: 'MERGE', maxEntriesToBuild: 3, minEntriesToMergeWaitMinutes: 5 });
    expect(result.requiredStatusChecks).toEqual(expect.arrayContaining(['merge-gate', 'test']));
  });
});

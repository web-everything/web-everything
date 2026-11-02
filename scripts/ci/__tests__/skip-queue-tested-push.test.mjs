// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { decideQueueTestedSkip, MAX_RUNS_CHECKED } from '../skip-queue-tested-push.mjs';

const sha = 'a'.repeat(40);
const pushTree = 'b'.repeat(40);
const otherSha = 'c'.repeat(40);
const otherTree = 'd'.repeat(40);
const run = (head_sha = otherSha, overrides = {}) => ({
  head_sha, conclusion: 'success', created_at: '2026-10-31T12:00:00Z', ...overrides,
});
const input = (overrides = {}) => ({
  event: 'push', ref: 'refs/heads/main', sha, pushTree,
  listMergeGroupRuns: vi.fn().mockResolvedValue([run()]),
  getCommitTree: vi.fn().mockResolvedValue(otherTree),
  ...overrides,
});
const expectClosed = (result) => {
  expect(result.skip).toBe(false);
  expect(result.reason).toEqual(expect.any(String));
  expect(result.reason.trim()).not.toBe('');
  expect(result.matchedSha).toBeUndefined();
};

describe('decideQueueTestedSkip (pure function, no CLI or main export required)', () => {
  it('exports the decision function and fixes the lookup bound at 20', () => {
    expect(decideQueueTestedSkip).toBeTypeOf('function');
    expect(MAX_RUNS_CHECKED).toBe(20);
  });

  it.each([40, 64])('accepts full %i-character hex SHAs and short-circuits an exact successful head without tree IO', async (length) => {
    const head = 'a1'.repeat(length / 2);
    const args = input({ sha: head, pushTree: 'b2'.repeat(length / 2),
      listMergeGroupRuns: vi.fn().mockResolvedValue([run(head)]) });
    const result = await decideQueueTestedSkip(args);
    expect(result).toMatchObject({ skip: true, matchedSha: head, reason: expect.any(String) });
    expect(result.reason.trim()).not.toBe('');
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each([40, 64])('skips for an equal tree on a different successful %i-character head', async (length) => {
    const head = 'c3'.repeat(length / 2);
    const tree = 'b2'.repeat(length / 2);
    const args = input({ sha: 'a1'.repeat(length / 2), pushTree: tree,
      listMergeGroupRuns: vi.fn().mockResolvedValue([run(head)]),
      getCommitTree: vi.fn().mockResolvedValue(tree) });
    expect(await decideQueueTestedSkip(args)).toMatchObject({ skip: true, matchedSha: head, reason: expect.any(String) });
    expect(args.getCommitTree).toHaveBeenCalledTimes(1);
    expect(args.getCommitTree).toHaveBeenCalledWith(head);
  });

  it.each(['pull_request', 'merge_group', 'schedule', 'workflow_dispatch'])('fails closed for event %s even with an exact successful head', async (event) => {
    const args = input({ event, listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha)]) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.listMergeGroupRuns).not.toHaveBeenCalled();
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each(['refs/heads/feature', 'refs/tags/main', 'main', ''])('fails closed for non-main ref %j', async (ref) => {
    const args = input({ ref, listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha)]) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.listMergeGroupRuns).not.toHaveBeenCalled();
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  describe.each(['sha', 'pushTree'])('validates %s before using queue evidence', (field) => {
    it.each([undefined, null, 123, '', 'abc123', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(40), ` ${sha}`, `${sha}\n`])('fails closed for malformed value %j', async (value) => {
      const args = input({ [field]: value, listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha)]) });
      expectClosed(await decideQueueTestedSkip(args));
      expect(args.listMergeGroupRuns).not.toHaveBeenCalled();
      expect(args.getCommitTree).not.toHaveBeenCalled();
    });
  });

  it('fails closed when listing merge-group runs throws', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockRejectedValue(new Error('unavailable')) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { workflow_runs: [] }, 'success'])('fails closed for a non-array run listing %j', async (listing) => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue(listing) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it('fails closed for an empty listing', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([]) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each(['failure', 'cancelled', null])('ignores %j conclusions even when their head matches', async (conclusion) => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha, { conclusion })]),
      getCommitTree: vi.fn().mockResolvedValue(pushTree) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 'not-a-date'])('ignores a successful exact head with invalid created_at %j', async (created_at) => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha, { created_at })]) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'abc123', 'g'.repeat(40), 'a'.repeat(41)])('ignores invalid run head_sha %j even if a tree lookup would match', async (head) => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([run(head, { head_sha: head })]),
      getCommitTree: vi.fn().mockResolvedValue(pushTree) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).not.toHaveBeenCalled();
  });

  it('continues past ignored records to a valid successful match', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([
      run(sha, { conclusion: 'failure' }), run(sha, { created_at: 'invalid' }), run('invalid'), run(),
    ]), getCommitTree: vi.fn().mockResolvedValue(pushTree) });
    expect(await decideQueueTestedSkip(args)).toMatchObject({ skip: true, matchedSha: otherSha });
    expect(args.getCommitTree).toHaveBeenCalledTimes(1);
    expect(args.getCommitTree).toHaveBeenCalledWith(otherSha);
  });

  it('fails closed on tree lookup failure without trying a later candidate that would match', async () => {
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([
      run(otherSha, { created_at: '2026-10-31T13:00:00Z' }), run('e'.repeat(40)),
    ]), getCommitTree: vi.fn().mockRejectedValueOnce(new Error('unreadable tree')).mockResolvedValue(pushTree) });
    expectClosed(await decideQueueTestedSkip(args));
    expect(args.getCommitTree).toHaveBeenCalledTimes(1);
    expect(args.getCommitTree).toHaveBeenCalledWith(otherSha);
  });

  it('reports tree differs when all successful trees differ', async () => {
    const args = input();
    const result = await decideQueueTestedSkip(args);
    expectClosed(result);
    expect(result.reason).toMatch(/tree differs/i);
    expect(args.getCommitTree).toHaveBeenCalledTimes(1);
    expect(args.getCommitTree).toHaveBeenCalledWith(otherSha);
  });

  it('gives distinct diagnostic reasons for distinct fail-closed paths', async () => {
    const cases = [
      { event: 'schedule' }, { ref: 'refs/heads/feature' }, { sha: 'bad' }, { pushTree: 'bad' },
      { listMergeGroupRuns: vi.fn().mockRejectedValue(new Error('listing failed')) },
      { listMergeGroupRuns: vi.fn().mockResolvedValue({}) },
      { listMergeGroupRuns: vi.fn().mockResolvedValue([run(sha, { conclusion: 'failure' })]) },
      { getCommitTree: vi.fn().mockRejectedValue(new Error('tree failed')) }, {},
    ];
    const reasons = [];
    for (const overrides of cases) {
      const result = await decideQueueTestedSkip(input(overrides));
      expectClosed(result);
      reasons.push(result.reason);
    }
    expect(new Set(reasons).size).toBe(cases.length);
  });

  it.each(['head', 'tree'])('does not use a %s match ranked 21st; newest-first lookup is capped at 20 and falls back to a full run', async (match) => {
    const newest = Array.from({ length: 20 }, (_, index) => run((index + 1).toString(16).padStart(40, '0'), {
      created_at: new Date(Date.UTC(2026, 9, 31, 12, 0, 20 - index)).toISOString(),
    }));
    const oldest = run(match === 'head' ? sha : 'e'.repeat(40), { created_at: '2026-10-30T12:00:00Z' });
    // Deliberately oldest-first: slicing the API response before sorting must fail this test.
    const args = input({ listMergeGroupRuns: vi.fn().mockResolvedValue([oldest, ...newest.toReversed()]),
      getCommitTree: vi.fn(async (head) => head === oldest.head_sha ? pushTree : otherTree) });
    const result = await decideQueueTestedSkip(args);
    expectClosed(result);
    expect(result.reason).toMatch(/tree differs/i);
    expect(args.getCommitTree).toHaveBeenCalledTimes(20);
    expect(args.getCommitTree.mock.calls.map(([head]) => head)).toEqual(newest.map(({ head_sha }) => head_sha));
    expect(args.getCommitTree).not.toHaveBeenCalledWith(oldest.head_sha);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { defaultReadPrLive, defaultDrainRebaseEvidence, defaultRevertBounce, loadDrainGraceSetting,
  defaultPostConflictFinding } from '../parked-pr-conflict-watch.mjs';
import { invalidateConflictFinding } from '../../lib/conflict-finding.mjs';
import { resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';
import { runReviewLabelCli } from '../../review-set-label.mjs';

const head = 'a'.repeat(40), moved = 'b'.repeat(40);
const pr = { number: 7183, headRefOid: head };
const repo = 'o/n';

describe('default conflict-watch GitHub readers', () => {
  it('reads the live PR using bounded, throttled App-only argv', () => {
    const exec = vi.fn(() => JSON.stringify({ headRefOid: moved, mergeable: 'UNKNOWN' }));
    expect(defaultReadPrLive({ pr, repo, exec })).toEqual({ headRefOid: moved, mergeable: 'UNKNOWN' });
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', '7183', '--repo', repo,
      '--json', 'headRefOid,mergeable'], expect.objectContaining({ timeout: expect.any(Number),
      maxBuffer: 1024 * 1024, throttle: { personalRoute: false },
      env: expect.objectContaining({ WE_GH_THROTTLE_PERSONAL_ROUTE: '0' }) }));
  });
  it('propagates unreadable/oversized GitHub output for the caller to hold', () => {
    const exec = () => { throw new Error('maxBuffer exceeded'); };
    expect(() => defaultReadPrLive({ pr, repo, exec })).toThrow('maxBuffer');
    expect(() => defaultDrainRebaseEvidence({ pr, repo, exec, identity: {} })).toThrow('maxBuffer');
  });
  it.each(['not-json', '{"message":"API error"}', 'null', '[]'])('rejects unreadable commit evidence %s', output => {
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify({ headRefOid: head }))
      .mockReturnValueOnce(output);
    expect(() => defaultDrainRebaseEvidence({ pr, repo, exec, identity: {} })).toThrow();
  });
  it.each(['{}', 'null', '{"headRefOid":"short"}'])('rejects unreadable live evidence %s', output => {
    expect(() => defaultDrainRebaseEvidence({ pr, repo, exec: () => output, identity: {} })).toThrow();
  });
  const identity = { roles: { merger: { botLogin: 'drain-app[bot]' }, worker: { botLogin: 'worker-app[bot]' } } };
  function evidence({ author = 'drain-app[bot]', committer = 'drain-app[bot]', date = '2026-09-27T22:22:19Z', message = 'ordinary update' } = {}) {
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify({ headRefOid: moved, mergeable: 'CONFLICTING' }))
      .mockReturnValueOnce(JSON.stringify({ sha: moved, author: { login: author }, committer: { login: committer },
        commit: { message, committer: { date } } }));
    return { value: defaultDrainRebaseEvidence({ pr, repo, exec, identity }), exec };
  }
  it('uses the live commit identity and API timestamp, even after the list head moved', () => {
    const result = evidence();
    expect(result.value).toEqual({ by: 'drain', atMs: Date.parse('2026-09-27T22:22:19Z') });
    expect(result.exec.mock.calls[1][1]).toEqual(['api', `repos/o/n/commits/${moved}`]);
  });
  it('rejects a drain committer with a non-drain author', () => {
    expect(evidence({ author: 'someone', committer: 'drain-app[bot]' }).value).toBeNull();
  });
  it('rejects an old drain-authored commit cherry-picked by someone else with a fresh committer date', () => {
    expect(evidence({ committer: 'someone' }).value).toBeNull();
  });
  it.each(['someone', 'worker-app[bot]', 'web-everything[bot]'])('ignores message claims from %s', author => {
    expect(evidence({ author, message: 'merge drain rebased this PR' }).value).toBeNull();
  });
  it.each([null, '', 'not a date'])('holds for a missing/invalid API timestamp (%s)', date => {
    expect(() => evidence({ date })).toThrow('unreadable committer date');
  });
  it.each([
    ['concurrent rejection', ['review:changes', 'advisory:changes'], head],
    ['concurrent rearm', ['review:pending'], head],
    ['concurrent acceptance', ['review:accepted'], head],
    ['another head move', ['review:changes'], moved],
    ['missing receipt', ['review:changes'], head],
  ])('skips rollback after %s without editing live labels', (_, labels, liveHead) => {
    const provider = { setLabels: vi.fn(), readPrState: vi.fn(() => ({ headRefOid: liveHead, labels, comments: [] })) };
    expect(defaultRevertBounce({ repo, pr: { ...pr, labels: ['review:accepted'] },
      headRefOid: head, provider })).toBe('bounce-revert-skipped-state-changed');
    expect(provider.readPrState).toHaveBeenCalledWith(repo, pr.number);
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('skips a concurrent same-label rejection after our finding token', () => {
    const findingToken = '12345678-1234-1234-1234-123456789abc';
    const provider = { setLabels: vi.fn(), readPrState: vi.fn(() => ({ headRefOid: head,
      labels: ['review:changes'], comments: [
        { author: { login: 'web-everything' }, body: `<!-- conflict-watch-bounce:${findingToken} -->` },
        { author: { login: 'web-everything' }, body: 'Independent rejection' },
      ] })) };
    expect(defaultRevertBounce({ pr, repo, headRefOid: head, findingToken, provider }))
      .toBe('bounce-revert-skipped-state-changed');
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('holds when rollback state is unreadable or oversized', () => {
    const provider = { setLabels: vi.fn(), readPrState: () => { throw new Error('maxBuffer exceeded'); } };
    expect(() => defaultRevertBounce({ pr, repo, headRefOid: head, provider })).toThrow('maxBuffer');
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('retains our bounce when snapshot acceptance has no guarded clearing proof', () => {
    const findingToken = '12345678-1234-1234-1234-123456789abc';
    const provider = { setLabels: vi.fn(), readPrState: vi.fn(() => ({ headRefOid: head,
      labels: ['review:changes'], comments: [{ author: { login: 'web-everything' },
        body: `<!-- conflict-watch-bounce:${findingToken} -->` }] })) };
    expect(() => defaultRevertBounce({ repo, pr: { ...pr, labels: ['review:accepted', 'ready-to-merge'] },
      headRefOid: head, findingToken, provider })).toThrow('human review/rearm');
    expect(provider.setLabels).not.toHaveBeenCalled();
  });
  it('passes the judged head through the real finding transport', () => {
    const exec = vi.fn();
    defaultPostConflictFinding({ pr, repo, headRefOid: head, exec });
    expect(exec.mock.calls[0][1]).toContain(`--expect-head=${head}`);
  });
});

describe('drain grace setting', () => {
  it('defaults to 15 minutes', () => {
    expect(loadDrainGraceSetting({ env: {}, read: () => ({}), platform: {}, log: () => {} }).drainGraceMinutes).toBe(15);
  });
  it('resolves platform, tool and environment and logs provenance', () => {
    resetCascadeLogForTest();
    const log = vi.fn();
    expect(loadDrainGraceSetting({ env: { WE_CONFLICT_WATCH_DRAIN_GRACE_MINUTES: '3', WE_POLICY_CASCADE_LOG: '1' },
      platform: { drainGraceMinutes: 12 }, read: () => ({ conflictWatch: { drainGraceMinutes: 9 } }), log }).drainGraceMinutes).toBe(3);
    expect(log.mock.calls.flat().join(' ')).toContain('drainGraceMinutes');
  });
  it('rejects invalid and unbounded values', () => {
    expect(loadDrainGraceSetting({ env: { WE_CONFLICT_WATCH_DRAIN_GRACE_MINUTES: 'Infinity' },
      platform: {}, read: () => ({}), log: () => {} }).drainGraceMinutes).toBe(15);
  });
});

describe('changes writer head pin', () => {
  it.each([head, moved, 'short'])('refuses a missing or moved head before any write (pin %s)', pin => {
    const provider = { readPrState: vi.fn(() => ({ headRefOid: moved, labels: [{ name: 'review:accepted' }],
      comments: [], state: 'OPEN', headRefName: 'lane/7183', body: '' })), postComment: vi.fn(), setLabels: vi.fn() };
    // For the matching pin, move the head only at the pre-write read.
    if (pin === moved) provider.readPrState.mockReturnValueOnce({ headRefOid: moved, labels: [{ name: 'review:accepted' }],
      comments: [], state: 'OPEN', headRefName: 'lane/7183', body: '' }).mockReturnValue({ headRefOid: head });
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
    try {
      expect(() => runReviewLabelCli({ argv: ['7183', '--repo=o/n', '--to=changes', `--expect-head=${pin}`],
        provider, emit: () => {}, verdictBody: 'Resolve the conflict.', defaultActor: 'test',
        buildComment: () => 'finding', successResult: o => o, refusalResult: o => o })).toThrow();
      expect(provider.setLabels).not.toHaveBeenCalled();
      expect(provider.postComment).not.toHaveBeenCalled();
    } finally { exit.mockRestore(); }
  });
});

describe('conflict finding rollback receipt', () => {
  const findingToken = '12345678-1234-1234-1234-123456789abc';
  const marker = `<!-- conflict-watch-bounce:${findingToken} -->`;
  const comment = { id: 'IC_bounce', body: `finding\n${marker}`, author: { login: 'web-everything' } };
  it('edits exactly the trusted finding identified by the transport receipt', () => {
    const provider = { editComment: vi.fn() };
    invalidateConflictFinding({ findingToken, pr, repo, headRefOid: head, provider,
      listPrComments: () => [{ ...comment, id: 'IC_other', body: 'unrelated finding' }, comment] });
    expect(provider.editComment).toHaveBeenCalledTimes(1);
    expect(provider.editComment).toHaveBeenCalledWith(repo, comment.id,
      expect.stringContaining(`bounce reverted for head ${head}`), { pr: pr.number });
    expect(provider.editComment.mock.calls[0][2]).not.toContain('Auto-detected by');
  });
  it.each([
    ['missing finding', []],
    ['unreadable thread', null],
    ['untrusted matching comment', [{ ...comment, author: { login: 'stranger' } }]],
    ['ambiguous receipt', [comment, { ...comment, id: 'IC_duplicate' }]],
    ['missing comment id', [{ ...comment, id: undefined }]],
  ])('retains the bounce rather than editing a %s', (_, comments) => {
    const provider = { editComment: vi.fn() };
    expect(() => invalidateConflictFinding({ findingToken, pr, repo, headRefOid: head, provider,
      listPrComments: () => comments })).toThrow('bounce retained');
    expect(provider.editComment).not.toHaveBeenCalled();
  });
  it('propagates failed comment edits so approval labels cannot be restored', () => {
    expect(() => invalidateConflictFinding({ findingToken, pr, repo, headRefOid: head,
      listPrComments: () => [comment], provider: { editComment: () => { throw new Error('edit unavailable'); } } }))
      .toThrow('edit unavailable');
  });
});

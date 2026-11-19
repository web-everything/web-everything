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
  const identity = { roles: { merger: { botLogin: 'drain-app[bot]' }, worker: { botLogin: 'worker-app[bot]' } } };
  function evidence({ author = 'drain-app[bot]', committer = 'someone', date = '2026-09-27T22:22:19Z', message = 'ordinary update' } = {}) {
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
  it('accepts the drain committer identity', () => {
    expect(evidence({ author: 'someone', committer: 'drain-app[bot]' }).value?.by).toBe('drain');
  });
  it.each(['someone', 'worker-app[bot]', 'web-everything[bot]'])('ignores message claims from %s', author => {
    expect(evidence({ author, message: 'merge drain rebased this PR' }).value).toBeNull();
  });
  it.each([null, '', 'not a date'])('does not manufacture a missing/invalid API timestamp (%s)', date => {
    expect(evidence({ date }).value).toBeNull();
  });
  it('restores only removed labels and removes only our bounce label', () => {
    const provider = { setLabels: vi.fn() };
    defaultRevertBounce({ repo, pr: { ...pr, labels: ['review:accepted', 'ready-to-merge', 'review:human', 'other'] }, provider });
    expect(provider.setLabels).toHaveBeenCalledWith(repo, 7183, {
      remove: ['review:changes'], add: ['review:accepted', 'ready-to-merge'],
    });
  });
  it('retains a pre-existing changes label on revert', () => {
    const provider = { setLabels: vi.fn() };
    defaultRevertBounce({ repo, pr: { ...pr, labels: ['review:changes'] }, provider });
    expect(provider.setLabels.mock.calls[0][2]).toEqual({ add: [], remove: [] });
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

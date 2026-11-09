import { describe, expect, it, vi } from 'vitest';
import { buildMissingRunComment, countMissingRunComments, MISSING_RUN_COMMENT_MARKER } from '../main-red-recovery.mjs';
import { defaultPostMissingRunComment, sweepMissingRunRecovery } from '../ci-red-recovery-watch.mjs';

// Any missed reader injection fails locally instead of contacting GitHub.
vi.mock('../../lib/gh-throttle.mjs', async (original) => ({
  ...await original(), execFileSyncThrottled: vi.fn(() => { throw new Error('unexpected live read'); }),
}));

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const CLASSIC_CONTEXTS = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];

function fixture() {
  const claimed = new Set();
  const retriggerLedger = { claim: vi.fn((...key) => {
    const serialized = JSON.stringify(key);
    if (claimed.has(serialized)) return false;
    claimed.add(serialized);
    return true;
  }) };
  const labelPair = vi.fn();
  // Model the injected writer's once-only contract, retaining its ledger across sweeps.
  const labelRetrigger = vi.fn(({ repo, pr, head, context, ledger }) => {
    if (!ledger.claim({ repo, pr, head, context })) return {
      ok: false, deferred: true, action: 'label-retrigger', error: 'retrigger already spent or claim unavailable',
    };
    labelPair({ repo, pr, head, context });
    return { ok: true, action: 'label-retrigger' };
  });
  const trigger = vi.fn(() => ({ ok: true, action: 'pull-request-push' }));
  const restack = vi.fn(() => ({ ok: true, action: 'restacked' }));
  const postComment = vi.fn();
  const clearLabel = vi.fn(() => true);
  const readWorkflowRuns = vi.fn(() => [{
    name: 'Merge gate', event: 'pull_request_target', conclusion: 'startup_failure',
    status: 'completed', created_at: '2026-10-13T11:00:00Z', id: 101,
  }]);
  const options = {
    recoveryToken: 'ghp_fixture',
    readRecoveryPr: () => ({ state: 'OPEN', headRefName: 'lane/5060', baseRefName: 'main',
      headRefOid: HEAD, isCrossRepository: false, mergeable: 'MERGEABLE' }),
    repo: REPO, mainRuns: [], now: Date.parse('2026-10-13T12:00:00Z'),
    readOpenPrs: () => [{
      number: 5060, headRefName: 'lane/5060', baseRefName: 'main', headRefOid: HEAD,
      mergeable: 'MERGEABLE', labels: [], statusCheckRollup: CLASSIC_CONTEXTS.map(name => ({
        __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS',
      })),
    }],
    readRequiredContexts: () => CLASSIC_CONTEXTS,
    readAttributedRequiredChecks: () => [...CLASSIC_CONTEXTS, 'merge-gate'],
    readHeadCommittedAt: () => '2026-10-12T00:00:00Z', readPush: () => null,
    readComments: () => [], readWorkflowRuns, retriggerLedger, labelRetrigger,
    trigger, restack, postComment, clearLabel,
  };
  return { options, trigger, restack, postComment, clearLabel, labelRetrigger, labelPair, retriggerLedger, readWorkflowRuns };
}

describe('missing-run sweep merge-gate label recovery', () => {
  it.each(['success', 'failure', 'throw'])('label attempt posts the durable missing-run attempt marker for its head: %s', outcome => {
    const f = fixture();
    const exec = vi.fn();
    f.postComment.mockImplementation((pr, options) => defaultPostMissingRunComment(pr, { ...options, exec }));
    if (outcome !== 'success') f.labelRetrigger.mockImplementation(() => {
      if (outcome === 'throw') throw new Error('label rejected');
      return { ok: false, error: 'label rejected' };
    });
    sweepMissingRunRecovery({ ...f.options, apply: true });
    expect(f.postComment).toHaveBeenNthCalledWith(1, 5060, expect.objectContaining({
      repo: REPO, headSha: HEAD, headRefName: 'lane/5060', action: 'label-event', ok: outcome === 'success',
    }));
    const body = exec.mock.calls[0][1][4];
    expect(body).toBe(buildMissingRunComment({
      headSha: HEAD, headRefName: 'lane/5060', action: 'label-event', ok: outcome === 'success',
      error: outcome === 'success' ? null : 'label rejected',
    }));
    expect(body).toContain(MISSING_RUN_COMMENT_MARKER);
    expect(body).toContain(`sha: ${HEAD}`);
    const comments = [{ body, author: { login: 'web-everything' } }];
    expect(countMissingRunComments(comments, HEAD)).toBe(1);
    expect(countMissingRunComments(comments)).toBe(1);
    expect(countMissingRunComments(comments, 'b'.repeat(40))).toBe(0);
  });

  it.each(['per-SHA', 'PR-wide'])('persisted label attempt enforces the %s retry cap on the next sweep', cap => {
    const f = fixture();
    const comments = [];
    f.postComment.mockImplementation((_pr, options) => comments.push({
      body: buildMissingRunComment(options), author: { login: 'web-everything' },
    }));
    const options = { ...f.options, apply: true, readComments: () => comments,
      maxRetriesPerSha: cap === 'per-SHA' ? 1 : 10, maxRetriesPerPr: 1 };
    sweepMissingRunRecovery(options);
    expect(comments).toHaveLength(1);
    if (cap === 'PR-wide') {
      const oldRead = options.readOpenPrs;
      options.readOpenPrs = () => oldRead().map(pr => ({ ...pr, headRefOid: 'b'.repeat(40) }));
    }
    const next = sweepMissingRunRecovery(options);
    expect(next.dispatch).toEqual([]);
    expect(next.refusals).toContainEqual(expect.objectContaining({
      kind: cap === 'per-SHA' ? 'missing-run-cap-exhausted' : 'missing-run-pr-cap-exhausted', attempts: 1,
    }));
    expect(f.labelRetrigger).toHaveBeenCalledTimes(1);
    expect(f.postComment).toHaveBeenCalledTimes(1);
    expect(f.trigger).not.toHaveBeenCalled();
  });

  it('sweep with apply=false fires nothing', () => {
    const f = fixture();
    const result = sweepMissingRunRecovery({ ...f.options, apply: false });
    expect(result.applied).toEqual([]);
    expect(f.labelRetrigger).not.toHaveBeenCalled();
    expect(f.retriggerLedger.claim).not.toHaveBeenCalled();
    expect(f.labelPair).not.toHaveBeenCalled();
    expect(f.trigger).not.toHaveBeenCalled();
    expect(f.restack).not.toHaveBeenCalled();
    expect(f.postComment).not.toHaveBeenCalled();
    expect(f.clearLabel).not.toHaveBeenCalled();
  });

  it('sweep with apply=true on missing merge-gate plus startup_failure calls labelRetrigger once and not the empty-commit trigger', () => {
    const f = fixture();
    sweepMissingRunRecovery({ ...f.options, apply: true });
    expect(f.readWorkflowRuns).toHaveBeenCalledTimes(1);
    expect(f.labelRetrigger).toHaveBeenCalledTimes(1);
    expect(f.labelRetrigger.mock.calls[0][0]).toEqual(expect.objectContaining({
      repo: REPO, pr: 5060, head: HEAD, context: 'merge-gate', ledger: f.retriggerLedger,
    }));
    expect(f.labelPair).toHaveBeenCalledTimes(1);
    expect(f.trigger).not.toHaveBeenCalled();
    expect(f.restack).not.toHaveBeenCalled();
  });

  it('second sweep same head is a no-op', () => {
    const f = fixture();
    sweepMissingRunRecovery({ ...f.options, apply: true });
    expect(f.labelPair).toHaveBeenCalledTimes(1);
    const second = sweepMissingRunRecovery({ ...f.options, apply: true });
    expect(second.applied).toEqual([expect.objectContaining({
      ok: false, deferred: true, action: 'label-retrigger', error: 'retrigger already spent or claim unavailable',
    })]);
    expect(f.labelPair).toHaveBeenCalledTimes(1);
    expect(f.trigger).not.toHaveBeenCalled();
    expect(f.restack).not.toHaveBeenCalled();
  });

  it.each(['failure', 'throw'])('failed label attempt does not fall through to push recovery: %s', outcome => {
    const f = fixture();
    f.labelRetrigger.mockImplementation(() => {
      if (outcome === 'throw') throw new Error('label rejected');
      return { ok: false, action: 'label-retrigger', error: 'label rejected' };
    });
    const result = sweepMissingRunRecovery({ ...f.options, apply: true });
    expect(result.applied).toEqual([expect.objectContaining({
      ok: false, action: 'label-retrigger', error: 'label rejected', labelCleared: false,
    })]);
    expect(f.postComment).toHaveBeenCalledTimes(1);
    expect(f.trigger).not.toHaveBeenCalled();
    expect(f.restack).not.toHaveBeenCalled();
    expect(f.clearLabel).not.toHaveBeenCalled();
  });

  it('already-claimed head does not fall through to push recovery', () => {
    const f = fixture();
    f.retriggerLedger.claim({ repo: REPO, pr: 5060, head: HEAD, context: 'merge-gate' });
    const result = sweepMissingRunRecovery({ ...f.options, apply: true });
    expect(result.applied).toEqual([expect.objectContaining({
      ok: false, deferred: true, action: 'label-retrigger', error: 'retrigger already spent or claim unavailable',
    })]);
    expect(f.labelPair).not.toHaveBeenCalled();
    expect(f.trigger).not.toHaveBeenCalled();
    expect(f.restack).not.toHaveBeenCalled();
    expect(f.clearLabel).not.toHaveBeenCalled();
  });

  it.each(['per-SHA', 'PR-wide'])('caps of 1 refuse a second label attempt: %s', cap => {
    const f = fixture();
    const comments = [];
    f.postComment.mockImplementation((_pr, options) => comments.push({
      body: buildMissingRunComment(options), author: { login: 'web-everything' },
    }));
    // Missing a classic check too: the general planner exempts these from the PR-wide cap.
    const readOpenPrs = f.options.readOpenPrs;
    let head = HEAD;
    const options = { ...f.options, apply: true, readComments: () => comments,
      readOpenPrs: () => readOpenPrs().map(pr => ({ ...pr, headRefOid: head,
        statusCheckRollup: pr.statusCheckRollup.filter(row => row.name !== 'test'),
      })), maxRetriesPerSha: cap === 'per-SHA' ? 1 : 10, maxRetriesPerPr: 1 };
    sweepMissingRunRecovery(options);
    if (cap === 'PR-wide') head = 'b'.repeat(40);
    const second = sweepMissingRunRecovery(options);
    expect(second.refusals).toContainEqual(expect.objectContaining({
      kind: cap === 'per-SHA' ? 'missing-run-cap-exhausted' : 'missing-run-pr-cap-exhausted', attempts: 1,
      why: expect.stringMatching(/human\/ci-heal/),
    }));
    expect(second.applied).toEqual([]);
    expect(f.labelRetrigger).toHaveBeenCalledTimes(1);
    expect(f.labelPair).toHaveBeenCalledTimes(1);
    expect(f.postComment).toHaveBeenCalledTimes(1);
    expect(f.trigger).not.toHaveBeenCalled();
    expect(f.restack).not.toHaveBeenCalled();
  });
});

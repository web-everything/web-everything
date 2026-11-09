import { describe, expect, it, vi } from 'vitest';
import { sweepMissingRunRecovery } from '../ci-red-recovery-watch.mjs';

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
    if (!ledger.claim({ repo, pr, head, context })) return { ok: true, deferred: true };
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
    sweepMissingRunRecovery({ ...f.options, apply: true });
    expect(f.labelPair).toHaveBeenCalledTimes(1);
    expect(f.trigger).not.toHaveBeenCalled();
    expect(f.restack).not.toHaveBeenCalled();
  });
});

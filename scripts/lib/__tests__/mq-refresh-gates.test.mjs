import { describe, expect, it, vi } from 'vitest';
import { runReconcileFixDispatch } from '../../conveyor/reconcile-fix-dispatch.mjs';
import { refreshMqFailureHead, refreshMqFailureHeadSync } from '../mq-failure-refresh.mjs';
import { createMqRefreshAuthorization } from '../mq-refresh-authorization.mjs';
import { buildMqFailureRoute } from '../../lib/mq-failure-route.mjs';
import { planReconcile } from '../../conveyor/reconcile-core.mjs';
const id = { repo: 'web-everything/web-everything', pr: 42, head: 'a'.repeat(40) };
describe('MQ recovery only hands off to the fixer', () => {
  it.each([false, true])('persisted refresh hint makes no refresh, push or claim call (dryRun=%s)', dryRun => {
    const refresh = vi.fn(), git = vi.fn(), claim = vi.fn(), dispatch = vi.fn(e => ({ pr: e.pr }));
    runReconcileFixDispatch({ root: 'fixture', repo: 'we', dryRun,
      reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 42, headRefOid: id.head, files: ['src/a.mjs'],
        mqFailureRecovery: { ...id, recoveryAction: 'refresh', evidence: { complete: true } } }], refusals: [] }),
      refreshMqFailure: refresh, mqFailureIo: { git }, mqRefreshStore: { claim },
      acquireClaim: claim, releaseClaim: claim, readFixClaim: () => { throw Error('unreadable claim'); },
      mqFailureLedger: { claim }, findItemFn: () => null, loadItems: () => [],
      listFixClaims: () => [], listBuildClaims: () => [], pickFreeLanes: () => [5], priorityShadow: null,
      tryResumeRound: null, dispatch });
    expect(refresh).not.toHaveBeenCalled(); expect(git).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].mqFailureRecovery.recoveryAction).toBe('fix');
  });
  it.each(['review:human', 'red-team:blocked', 'red-team:pending'])('blocking label %s refuses recovery before any push', label => {
    const body = buildMqFailureRoute({ ...id, failedJobs: ['unit'], testFiles: ['tests/a.mjs'], assertions: ['FAIL'], complete: true });
    const refresh = vi.fn(), git = vi.fn(), dispatch = vi.fn();
    runReconcileFixDispatch({ root: 'fixture', repo: 'we', dryRun: false,
      reconcile: () => planReconcile({ repo: 'we', agents: [], durableCounts: {}, prs: [{ number: 42, state: 'OPEN',
        headRefOid: id.head, labels: [{ name: label }], comments: [{ body, author: { login: 'chalbert' } }] }] }),
      refreshMqFailure: refresh, mqFailureIo: { git }, listFixClaims: () => [], listBuildClaims: () => [],
      loadItems: () => [], priorityShadow: null, pickFreeLanes: () => [5], dispatch });
    expect(refresh).not.toHaveBeenCalled(); expect(git).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });
});

describe.each([refreshMqFailureHead, refreshMqFailureHeadSync])('exported refresh guards: %s', execute => {
  it.each(['authorization', 'missing authorization', 'shared attempt', 'retired authorization', 'review:human', 'red-team:blocked', 'red-team:pending', 'unreadable', 'oversized'])(
    'refuses %s without a push', async mode => {
      const claim = vi.fn(() => ({ claimed: true })), sharedClaim = vi.fn(() => mode !== 'shared attempt');
      const git = vi.fn(() => ({ ok: true, head: 'b'.repeat(40) }));
      const checkout = vi.fn(() => ({ cwd: 'fixture', branch: 'topic' }));
      const labels = vi.fn(() => {
        if (mode === 'unreadable') throw Error('unreadable labels');
        return { headRefOid: id.head, labels: mode === 'oversized' ? Array(101).fill('ready-to-merge') : ['ready-to-merge', mode] };
      });
      const result = await execute({ ...id, store: { claim: sharedClaim },
        ...(mode === 'missing authorization' ? {} : { allow: () => mode !== 'authorization' }),
        ...(mode === 'retired authorization' ? { allow: undefined, ...createMqRefreshAuthorization() } : {}),
        ledger: { claim, recordRefresh: vi.fn(), recordFixFallback: vi.fn() },
        io: { readHead: () => id.head, createCheckout: checkout, git, removeCheckout: vi.fn(), readLabels: labels } });
      expect(result.action).toBe('stop');
      expect(git.mock.calls.filter(([c]) => c.args[0] === 'push')).toHaveLength(0);
      if (mode.includes('authorization') || mode === 'shared attempt') {
        expect(checkout).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
      } else { expect(labels).toHaveBeenCalledTimes(1); expect(git).toHaveBeenCalledTimes(1); }
    });
});

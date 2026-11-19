import { describe, it, expect, vi } from 'vitest';
import { fixDetachedProvider } from '../fix.mjs';
import { parseFixRunArgv } from '../../fix-run.mjs';
import { planReconcile } from '../../../conveyor/reconcile-core.mjs';
import { planFixesFromReconcile } from '../../../conveyor/reconcile-fix-dispatch.mjs';
import { renderRedTeamComment } from '../../review-extra-seats.mjs';
import { redTeamGateMarker, liveResultGateState } from '../../../lib/red-team-gate.mjs';
import repairBreak from '../../../conveyor/soak/breaks/accepted-red-team-repair-accounting.mjs';

describe('fix provider planned accounting mode', () => {
  it('a failed borrowed launch gets a fresh identity after mechanical refunds and its replay stays spent', async () => {
    const { refund } = await repairBreak.run();
    expect(refund.sameHeadAndResult).toBe(true);
    expect(refund.attempts).toEqual([1, 1]);
    expect(refund.failed).toEqual({ code: 1, launched: 1, receipts: 1 });
    expect(refund.errors[0]).toContain('executor failed after receipt');
    expect(refund.launches[1]).not.toBe(refund.launches[0]);
    expect(refund.plannedIds).toEqual([2, 3]);
    expect(refund.launches).toEqual(['2', '3', '3']);
    expect(refund.retried).toEqual({ code: 1, launched: 2, receipts: 2 });
    expect(refund.errors[1]).toContain('executor failed after receipt');
    expect(refund.replayed).toEqual(refund.retried);
    expect(refund.errors[2]).toContain('launch already spent');
  });

  it('projects a production PR with no mode through reconciliation into validated launcher argv despite label drift', () => {
    const head = 'a'.repeat(40), author = { login: 'web-everything' };
    const comments = [{ author, body: renderRedTeamComment({ pr: 7, rev: head, provider: 'codex', model: 'm',
      recheckStatus: 'ok', foldedVerdict: 'changes', findings: [{ summary: 'Gate break', category: 'edge-case',
        impactIfUnfixed: 'broken', file: 'scripts/example.mjs', line: 1, confirmedByRecheck: true }] }) }];
    const resultId = liveResultGateState(comments, 7, head).resultId;
    comments.push({ author, body: redTeamGateMarker(7, head, 'sent-back', resultId) });
    const pr = { number: 7, state: 'OPEN', headRefName: 'lane/7-repair', headRefOid: head, isDraft: false,
      labels: [{ name: 'review:accepted' }, { name: 'red-team:blocked' }], comments, commentsComplete: true,
      mergeStateStatus: 'CLEAN', statusCheckRollup: [], files: ['scripts/example.mjs'] };
    expect(pr).not.toHaveProperty('mode');
    const { planned, refusals } = planFixesFromReconcile(
      planReconcile({ prs: [pr], agents: [], now: Date.now() }).dispatch,
      () => ({ num: '7', scope: ['we:scripts/example.mjs'] }), () => []);
    expect(refusals).toEqual([]);
    expect(planned).toHaveLength(1);
    pr.labels = [{ name: 'review:changes' }];
    const spawnDetached = vi.fn(() => ({ pid: 99 }));
    fixDetachedProvider({ ...planned[0], pr: 7, repo: 'o/r', head, resultId, sessionSlug: 'fix-7',
      ref: pr.headRefName, promptFile: '/brief.md', policyRoute: { provider: 'codex' } },
    { spawnDetached, logPathFor: () => '/logs/fix-7', readDeliveryAgentMarker: () => null });
    expect(parseFixRunArgv(spawnDetached.mock.calls[0][0].slice(1)))
      .toMatchObject({ plannedRepairMode: 'red-team-sent-back', pr: '7' });
  });

  it('passes an explicit ordinary mode when no planned red-team repair exists', () => {
    const spawnDetached = vi.fn(() => ({ pid: 99 }));
    fixDetachedProvider({ pr: 7, sessionSlug: 'fix-7', ref: 'lane/7-repair', promptFile: '/brief.md' },
      { spawnDetached, logPathFor: () => '/logs/fix-7', readDeliveryAgentMarker: () => null });
    expect(parseFixRunArgv(spawnDetached.mock.calls[0][0].slice(1)).plannedRepairMode).toBe('ordinary');
  });
});

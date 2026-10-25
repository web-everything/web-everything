import { describe, expect, it, vi } from 'vitest';
import { planReconcile } from '../../conveyor/reconcile-core.mjs';
import { runReconcilePromoteDraftDispatch } from '../promote-draft-pr-dispatch.mjs';

const HEAD = 'b'.repeat(40);
const draft = labels => ({
  number: 5839, state: 'OPEN', isDraft: true, isCrossRepository: false,
  headRefName: 'lane/blocked-draft', headRefOid: HEAD, baseRefName: 'main',
  mergeStateStatus: 'CLEAN', labels, comments: [],
  statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
});
const plan = labels => planReconcile({
  prs: [draft(labels)], agents: [], durableCounts: {}, requiredChecks: ['gate'],
  reviewTiming: { startAfter: 'ci-green' }, now: Date.parse('2026-10-24T18:24:00Z'),
});
const dispatch = (reconcile, readPrLabels, ready) => runReconcilePromoteDraftDispatch({
  root: '/repo', reconcile, provider: { ready },
  checkStaleness: () => ({ fresh: true, behind: 0 }),
  readHeadCheckState: () => ({ state: 'green', why: 'required checks succeeded' }),
  readPrLabels, clearAwaitingCi: () => {},
});

describe.each(['red-team:blocked', 'red-team:pending'])('%s draft promotion across daemon planning and dispatch', hold => {
  it.each([
    [hold], [{ name: hold }],
  ])('the planner holds a green draft with labels %j', label => {
    const result = plan([label]);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual([expect.objectContaining({
      kind: 'draft', why: expect.stringContaining(hold),
    })]);
  });

  it.each([
    [hold], [{ name: hold }],
  ])('the fresh label read refuses a hold added after planning: %j', label => {
    const ready = vi.fn();
    const planned = plan(['red-team:clear']);
    expect(planned.dispatch).toEqual([expect.objectContaining({ kind: 'promote-draft' })]);
    const result = dispatch(() => planned, () => [label], ready);
    expect(ready).not.toHaveBeenCalled();
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toEqual([expect.objectContaining({
      kind: hold === 'red-team:blocked' ? 'red-team-blocked' : 'red-team-pending', why: expect.stringContaining(hold),
    })]);
  });

  it('the real planner and dispatch preserve the draft until the hold is cleared on a later tick', () => {
    const ready = vi.fn();
    let labels = [hold];
    const reconcile = () => plan(labels);
    const readPrLabels = () => labels;
    expect(dispatch(reconcile, readPrLabels, ready).dispatched).toEqual([]);
    expect(ready).not.toHaveBeenCalled();
    labels = ['red-team:clear'];
    expect(dispatch(reconcile, readPrLabels, ready).dispatched).toEqual([{ pr: 5839, kind: 'promote-draft' }]);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(5839);
  });
});

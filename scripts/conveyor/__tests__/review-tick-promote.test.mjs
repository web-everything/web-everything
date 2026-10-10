/**
 * @file scripts/conveyor/__tests__/review-tick-promote.test.mjs — card xemxk3h: one review-daemon pass promotes a
 * green draft AND dispatches its review; a not-green draft is never promoted; a PR already promoted elsewhere is
 * not promoted twice.
 */
import { describe, it, expect, vi } from 'vitest';
import { runReviewTick } from '../../../skills-src/conveyor/review-daemon.mjs';
import { promoteDraftsGuarded, promoteDraftsThenReplan } from '../review-tick-promote.mjs';

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const draftRow = (n, extra = {}) => ({
  number: n, state: 'OPEN', isDraft: true, headRefName: `lane/x-${n}`, headRefOid: HEAD, labels: [], isCrossRepository: false, ...extra,
});
/** A fake planner: a draft is owed `promote-draft`, a ready PR is owed `review` — the shape `planReconcile` emits. */
const planFrom = (prs) => ({
  dispatch: prs.map((p) => ({ kind: p.isDraft ? 'promote-draft' : 'review', prNumber: p.number, attempts: 0 })),
  refusals: [],
});

function tick({ promoteDrafts, prs = [draftRow(42)] }) {
  const reconcile = vi.fn(({ readPrs }) => planFrom(readPrs()));
  const dispatch = vi.fn(({ pr }) => ({ mode: 'job', agentId: null, jobPid: 1000 + pr }));
  const out = runReviewTick({
    repo: REPO, readPrs: () => prs, readAgents: () => [], reconcile, dispatch,
    tagRound: vi.fn(), tagStatus: vi.fn(), statusCandidates: () => [], holdReconcile: () => [],
    ...(promoteDrafts ? { promoteDrafts } : {}),
  });
  return { out, dispatch, reconcile };
}

describe('review daemon: same-pass promote + review (card xemxk3h)', () => {
  it('[A1] before: a green draft is owed promote-draft and the pass dispatches nothing', () => {
    const { out, dispatch } = tick({});
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.dispatched).toEqual([]);
  });

  it('[A1] after: the same pass promotes the draft and dispatches its review', () => {
    const promote = vi.fn(({ prNumbers }) => ({ rows: prNumbers.map((pr) => ({ repo: REPO, pr, action: 'promoted', why: 'green' })) }));
    const { out, dispatch, reconcile } = tick({ promoteDrafts: promote });
    expect(promote).toHaveBeenCalledWith({ repo: REPO, prNumbers: [42] });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].pr).toBe(42);
    expect(out.dispatched).toEqual([{ prNumber: 42, agentId: null, mode: 'job', jobPid: 1042 }]);
  });

  it('fail closed: a refused or failed promote dispatches no review and does not re-plan', () => {
    for (const promote of [
      () => ({ rows: [{ repo: REPO, pr: 42, action: 'skip', why: 'required checks read pending, not green' }] }),
      () => { throw new Error('gh down'); },
    ]) {
      const { out, dispatch, reconcile } = tick({ promoteDrafts: promote });
      expect(dispatch).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(out.dispatched).toEqual([]);
    }
  });

  it('a re-plan that throws keeps the original plan (no review this pass) and reports why', () => {
    let calls = 0;
    const res = promoteDraftsThenReplan({
      plan: planFrom([draftRow(42)]), rawPrs: [draftRow(42)], repo: REPO,
      promote: () => ({ rows: [{ pr: 42, action: 'promoted', why: 'green' }] }),
      replan: () => { calls += 1; throw new Error('reconcile hiccup'); },
    });
    expect(calls).toBe(1);
    expect(res.plan.dispatch).toEqual([{ kind: 'promote-draft', prNumber: 42, attempts: 0 }]);
    expect(res.replanError).toBe('reconcile hiccup');
  });

  it('no promote-draft rows: the promote effect is never called', () => {
    const promote = vi.fn();
    tick({ promoteDrafts: promote, prs: [draftRow(7, { isDraft: false })] });
    expect(promote).not.toHaveBeenCalled();
  });
});

describe('promoteDraftsGuarded — the fast promoter\'s own guards decide (card xemxk3h)', () => {
  const on = () => ({ loop: true, intervalSeconds: 60 });
  const deps = (over = {}) => ({
    readHeadCheckState: () => ({ state: 'green' }),
    readPrView: () => ({ ...draftRow(42), baseRefName: 'main', comments: [], body: '', statusCheckRollup: [], mergeStateStatus: 'CLEAN' }),
    readAgents: () => [], readClaim: () => null, readRequiredChecks: () => ({ checks: [] }),
    ready: vi.fn(), clearAwaiting: vi.fn(),
    ...over,
  });

  it('[A2] a draft whose required checks are pending or red is never promoted', () => {
    for (const state of ['pending', 'red', 'unchecked']) {
      const d = deps({ readHeadCheckState: () => ({ state }) });
      const { rows } = promoteDraftsGuarded({ repo: REPO, prNumbers: [42], resolveSettings: on, listDrafts: () => [draftRow(42)], stepDeps: d });
      expect(rows).toEqual([expect.objectContaining({ pr: 42, action: 'skip' })]);
      expect(d.ready).not.toHaveBeenCalled();
    }
  });

  it('[A2] a failed check read refuses (no promotion)', () => {
    const d = deps({ readHeadCheckState: () => { throw new Error('truncated'); } });
    const { rows } = promoteDraftsGuarded({ repo: REPO, prNumbers: [42], resolveSettings: on, listDrafts: () => [draftRow(42)], stepDeps: d });
    expect(rows[0].action).toBe('error');
    expect(d.ready).not.toHaveBeenCalled();
  });

  it('[A3] a PR the fix daemon already promoted (live view not a draft) is not promoted twice', () => {
    const d = deps({ readPrView: () => ({ ...draftRow(42, { isDraft: false }), comments: [], statusCheckRollup: [] }) });
    const { rows } = promoteDraftsGuarded({ repo: REPO, prNumbers: [42], resolveSettings: on, listDrafts: () => [draftRow(42)], stepDeps: d });
    expect(rows).toEqual([expect.objectContaining({ pr: 42, action: 'skip' })]);
    expect(d.ready).not.toHaveBeenCalled();
  });

  it('[A3] already ready when listed: the draft list does not carry it, nothing is written', () => {
    const d = deps();
    const { rows } = promoteDraftsGuarded({ repo: REPO, prNumbers: [42], resolveSettings: on, listDrafts: () => [], stepDeps: d });
    expect(rows).toEqual([]);
    expect(d.ready).not.toHaveBeenCalled();
  });

  it('only the plan\'s own PRs are considered; other drafts in the repo are left alone', () => {
    const step = vi.fn(({ listDrafts }) => ({ rows: listDrafts({ repoSlug: REPO }).map((p) => ({ pr: p.number, action: 'skip', why: 'x' })) }));
    const { rows } = promoteDraftsGuarded({ repo: REPO, prNumbers: [42], resolveSettings: on, step, listDrafts: () => [draftRow(41), draftRow(42)] });
    expect(rows.map((r) => r.pr)).toEqual([42]);
  });

  it('the draftPromotion.loop kill switch off: nothing is promoted', () => {
    const step = vi.fn();
    const { rows } = promoteDraftsGuarded({ repo: REPO, prNumbers: [42], resolveSettings: () => ({ loop: false }), step });
    expect(step).not.toHaveBeenCalled();
    expect(rows[0].action).toBe('skip');
  });
});

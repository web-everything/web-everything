/**
 * @file scripts/conveyor/__tests__/review-tick-promote.test.mjs — card xemxk3h: one review-daemon pass promotes a
 * green draft AND dispatches its review; a not-green draft is never promoted; a PR already promoted elsewhere is
 * not promoted twice.
 */
import { describe, it, expect, vi } from 'vitest';
import { runReviewTick } from '../../../skills-src/conveyor/review-daemon.mjs';
import { defaultRearmStaleAcceptance } from '../../operations/promote-draft-pr-dispatch.mjs';
import { normalizeDiffFingerprint } from '../../lib/review-escalation.mjs';
import { promoteDraftsGuarded, promoteDraftsThenReplan, rearmStaleAcceptsThenReplan } from '../review-tick-promote.mjs';

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

// LIVE 2026-10-21, PR #5771: an accepted PR whose head moved was planned a stale-accept `restore-review-label` row each
// tick, but only a daemon whose plan never produced it executed rows, so review of the new head never went out.
describe('review daemon: same-pass stale-accept re-arm + review (#5771)', () => {
  const accepted = (n, extra = {}) => ({
    number: n, state: 'OPEN', isDraft: false, headRefName: `lane/x-${n}`, headRefOid: HEAD, labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }],
    isCrossRepository: false, ...extra,
  });
  /** Planner stand-in: an accepted PR is owed the stale-accept row; once it carries review:pending it is owed a review. */
  const plan = (prs) => ({
    dispatch: prs.map((p) => {
      const names = (p.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
      return names.includes('review:accepted')
        ? { kind: 'restore-review-label', variant: 'stale-accept', prNumber: p.number, headRefOid: p.headRefOid, label: 'review:pending' }
        : { kind: 'review', prNumber: p.number, attempts: 0 };
    }),
    refusals: [],
  });
  const run = ({ rearmStaleAccepts, prs = [accepted(5771)] } = {}) => {
    // The live store: a done re-arm swaps the label there; the post-re-arm re-plan is a FRESH read (no `readPrs`).
    let live = prs;
    const reconcile = vi.fn(({ readPrs } = {}) => plan(readPrs ? readPrs() : live));
    const dispatch = vi.fn(({ pr }) => ({ mode: 'job', agentId: null, jobPid: 1000 + pr }));
    const noteRearms = vi.fn();
    const out = runReviewTick({
      repo: REPO, readPrs: () => prs, readAgents: () => [], reconcile, dispatch,
      tagRound: vi.fn(), tagStatus: vi.fn(), statusCandidates: () => [], holdReconcile: () => [],
      ...(rearmStaleAccepts ? { rearmStaleAccepts: (o) => {
        const r = rearmStaleAccepts(o);
        if (r?.ok) live = live.map((p) => ({ ...p, labels: [{ name: 'review:pending' }] }));
        return r;
      }, noteRearms } : {}),
    });
    return { out, dispatch, noteRearms };
  };

  it('before: with no executor the stale-accept row dispatches nothing', () => {
    const { dispatch } = run();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('after: the pass re-arms the stale accept and dispatches the review of the new head', () => {
    const rearm = vi.fn(() => ({ ok: true }));
    const { out, dispatch, noteRearms } = run({ rearmStaleAccepts: rearm });
    expect(rearm).toHaveBeenCalledWith({ repo: REPO, pr: 5771, headSha: HEAD });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(out.dispatched.map((d) => d.pr ?? d.prNumber)).toContain(5771);
    expect(noteRearms).toHaveBeenCalledWith(expect.objectContaining({ rearms: [expect.objectContaining({ pr: 5771, ok: true })] }));
  });

  it('a refused re-arm leaves the original plan in force and dispatches nothing', () => {
    const { dispatch, noteRearms } = run({ rearmStaleAccepts: () => ({ ok: false, reason: 'acceptance still covers the head' }) });
    expect(dispatch).not.toHaveBeenCalled();
    expect(noteRearms).toHaveBeenCalledWith(expect.objectContaining({ rearms: [expect.objectContaining({ ok: false, why: 'acceptance still covers the head' })] }));
  });

  it('a throwing re-arm is a refusal, not a tick failure', () => {
    const r = rearmStaleAcceptsThenReplan({
      plan: plan([accepted(7)]), rawPrs: [accepted(7)], repo: REPO, rearm: () => { throw new Error('boom\nmore'); }, replan: () => { throw new Error('unreached'); },
    });
    expect(r.rearms).toEqual([{ pr: 7, ok: false, why: 'boom' }]);
    expect(r.plan.dispatch[0].kind).toBe('restore-review-label');
  });

  it('ignores plans with no stale-accept row, and rows of other variants', () => {
    const rearm = vi.fn();
    const none = { dispatch: [{ kind: 'review', prNumber: 1 }, { kind: 'restore-review-label', variant: 'stuck', prNumber: 2 }] };
    expect(rearmStaleAcceptsThenReplan({ plan: none, rawPrs: null, repo: REPO, rearm, replan: rearm }).rearms).toEqual([]);
    expect(rearm).not.toHaveBeenCalled();
  });

  it('a re-plan failure after a done re-arm keeps the plan and reports the error', () => {
    const r = rearmStaleAcceptsThenReplan({
      plan: plan([accepted(7)]), rawPrs: [accepted(7)], repo: REPO, rearm: () => ({ ok: true }), replan: (prs) => { expect(prs).toBeNull(); throw new Error('replan down'); },
    });
    expect(r.replanError).toBe('replan down');
    expect(r.rawPrs[0].labels.map((l) => l.name)).toEqual(['ready-to-merge', 'review:pending']);
    expect(r.plan.dispatch[0].kind).toBe('restore-review-label');
  });
});

// LIVE 2026-10-21, PR #5771: the planner nominated a stale accept (cheap check, no diff), the guarded re-arm then PROVED the
// accept still covers the moved head and refused, and the plan went on holding the red-team request forever. One coverage
// check: a proven-covered refusal releases the hold; every other refusal keeps it.
describe('stale-accept hold vs guarded re-arm share one coverage verdict (#5771 deadlock)', () => {
  const REPO_SLUG = REPO, A = 'c'.repeat(40), B = HEAD;
  const DIFF = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n';
  const fp = normalizeDiffFingerprint(DIFF);
  const pr = {
    number: 5771, state: 'OPEN', isDraft: false, headRefOid: B, labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }],
    comments: [{ viewerDidAuthor: true, body: `<!-- reviewed-sha: ${A} -->\n<!-- reviewed-diff: ${fp} -->\n<!-- reviewed-contribution: ${fp} -->` }],
  };
  const row = { kind: 'restore-review-label', variant: 'stale-accept', prNumber: 5771, headRefOid: B, label: 'review:pending' };
  const other = { kind: 'review', prNumber: 9, attempts: 0 };
  const provider = (text, rearm = vi.fn(() => ({ ok: true })), { prOverride = {}, reviews = [] } = {}) => ({ rearm, fn: () => defaultRearmStaleAcceptance({
    repoSlug: REPO_SLUG, prNumber: 5771, headSha: B, readPr: () => ({ ...pr, ...prOverride }), rearm, readReviews: () => reviews,
    readNetDiff: () => ({ scored: true, rev: B, text }) }) });

  it('provider: a live-proven cover refusal carries covers:true and never re-arms', () => {
    const p = provider(DIFF);
    expect(p.fn()).toEqual(expect.objectContaining({ ok: false, covers: true }));
    expect(p.rearm).not.toHaveBeenCalled();
  });
  it('provider: a changed live diff re-arms (coverage does NOT hold)', () => {
    const p = provider(`${DIFF}+smuggled\n`);
    expect(p.fn()).toEqual({ ok: true });
    expect(p.rearm).toHaveBeenCalledTimes(1);
  });
  it('provider: an unreadable live diff is a plain refusal, never a cover', () => {
    const r = defaultRearmStaleAcceptance({ repoSlug: REPO_SLUG, prNumber: 5771, headSha: B, readPr: () => pr, rearm: vi.fn(), readReviews: () => [], readNetDiff: () => ({ scored: false }) });
    expect(r.ok).toBe(false); expect(r.covers).toBeUndefined();
  });
  it('tick: the #5771 shape (planner holds, re-arm proves cover) releases the row, keeps other rows, and says why', () => {
    const r = rearmStaleAcceptsThenReplan({ plan: { dispatch: [row, other], refusals: [] }, rawPrs: [pr], repo: REPO, rearm: provider(DIFF).fn, replan: () => { throw new Error('unreached'); } });
    expect(r.plan.dispatch).toEqual([other]);
    expect(r.rearms).toEqual([expect.objectContaining({ pr: 5771, ok: false, released: true, why: expect.stringContaining('hold released') })]);
  });
  it('tick: a refusal WITHOUT a proven cover (state moved, unreadable) keeps the hold', () => {
    const r = rearmStaleAcceptsThenReplan({ plan: { dispatch: [row], refusals: [] }, rawPrs: [pr], repo: REPO, rearm: () => ({ ok: false, reason: 'live acceptance coverage unreadable' }), replan: () => { throw new Error('unreached'); } });
    expect(r.plan.dispatch).toEqual([row]);
    expect(r.rearms[0].released).toBeUndefined();
  });
  it('tick: coverage that does not hold re-arms and the fresh re-plan proceeds to review', () => {
    const r = rearmStaleAcceptsThenReplan({ plan: { dispatch: [row], refusals: [] }, rawPrs: [pr], repo: REPO, rearm: provider(`${DIFF}+x\n`).fn, replan: () => ({ dispatch: [{ kind: 'review', prNumber: 5771 }], refusals: [] }) });
    expect(r.rearms[0].ok).toBe(true);
    expect(r.plan.dispatch[0].kind).toBe('review');
  });
  it('tick: a released PR is no longer blocked, so its red-team request is not held by the plan', () => {
    const rearm = provider(DIFF).fn;
    const r = rearmStaleAcceptsThenReplan({ plan: { dispatch: [row], refusals: [] }, rawPrs: [pr], repo: REPO, rearm, replan: () => null });
    expect([...r.plan.dispatch, ...r.plan.refusals].some((d) => d.prNumber === 5771)).toBe(false);
  });
  it('provider (audit): a later hold comment, a pending review label, unreadable reviews, a standing changes-requested review, or a full comment page never prove a cover', () => {
    const hold = { viewerDidAuthor: true, body: 'review paused: independent review required' };
    const cases = [
      { prOverride: { comments: [...pr.comments, hold] } },
      { prOverride: { labels: [...pr.labels, { name: 'review:pending' }] } },
      { reviews: null },
      { reviews: [{ state: 'CHANGES_REQUESTED', user: { login: 'someone' }, submitted_at: '2999-01-01T00:00:00Z' }] },
      { prOverride: { comments: [...pr.comments, ...Array.from({ length: 100 }, () => ({ viewerDidAuthor: true, body: '<!-- conveyor-note -->' }))] } },
    ];
    for (const c of cases) {
      const r = provider(DIFF, undefined, c).fn();
      expect(r.covers, JSON.stringify(Object.keys(c))).toBeUndefined();
    }
  });
  it('tick (audit): a row for a NEWER head than the one proved covered is a fresh obligation and is kept', () => {
    const C = 'd'.repeat(40);
    const r = rearmStaleAcceptsThenReplan({ plan: { dispatch: [row], refusals: [] }, rawPrs: [pr], repo: REPO,
      rearm: () => ({ ok: false, covers: true, coveredHead: C, reason: 'x' }), replan: () => null });
    expect(r.plan.dispatch).toEqual([row]);
    expect(r.rearms[0].released).toBeUndefined();
  });
  it('tick (audit): a fresh re-plan is never unheld from an earlier proof (same-head new obligation survives)', () => {
    const other2 = { ...accepted(8) };
    const rows2 = (n) => ({ ...row, prNumber: n });
    const rearm = ({ pr: n }) => (n === 5771 ? { ok: false, covers: true, coveredHead: B, reason: 'x' } : { ok: true });
    const r = rearmStaleAcceptsThenReplan({ plan: { dispatch: [row, rows2(8)], refusals: [] }, rawPrs: [pr, other2], repo: REPO, rearm,
      replan: () => ({ dispatch: [row], refusals: [] }) });
    expect(r.plan.dispatch).toEqual([row]);
  });
});

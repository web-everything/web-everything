// xo7mr6l — LIVE 2026-10-08, #4368/#4369: ci-heal escalated "main's own defect", main was then repaired, and
// nothing re-ran the PRs. Their red fell OUTSIDE every red-main window (main's run was cancelled) and the merge
// base was green, so every older recovery path said "own failure". Pins the new, bounded path.
import { describe, it, expect, vi } from 'vitest';
import { buildCiHealEscalationComment, mainDefectEscalationForHead, latestCiHealEscalationForHead } from '../ci-heal-escalation-mark.mjs';
import { isMainGreenFixOwed, resolveMainDefectRebaseCap } from '../main-red-recovery.mjs';
import { sweepCiRedRecovery } from '../ci-red-recovery-watch.mjs';

const headSha = '9ae391c37b80d02f5f2361425f527a8711da7e87';
const failedAt = '2026-10-08T01:06:55Z';
const mk = (reason, extra = {}) => ({ author: { login: 'web-everything' }, createdAt: '2026-10-08T01:56:28Z',
  body: buildCiHealEscalationComment({ headSha, outcome: 'needs-human', reason, ...extra }) });
const legacy = mk("red is main's own defect, not this PR's diff: backlog hash xsjn0uf is the bornAs of both cards");
const wide = mk('main-wide health-gate red, not this PR\'s diff: backlog hash xsjn0uf is bornAs of both');
const structured = mk('duplicate bornAs on main', { cause: 'main-defect' });
const own = mk('the diff itself looks wrong: a real conflict in the card');
const green = { name: 'test', conclusion: 'success', status: 'completed', head_sha: 'newmain', completed_at: '2026-10-08T01:49:10Z' };
const greenAtBase = { name: 'test', conclusion: 'success', status: 'completed', head_sha: 'base', completed_at: '2026-10-08T00:52:35Z' };
const facts = (comments, o = {}) => ({ failingCheckName: 'test', headSha, comments, failureCompletedAt: failedAt,
  mainLatestCheckRuns: [green], prContainsMainGreenSha: false, mergeBaseCheckRuns: [greenAtBase],
  mergeBaseRunConclusion: 'success', ...o });

describe('main-defect escalation recovery', () => {
  it('recognises the structured cause and both live prose shapes, never an own-diff escalation', () => {
    for (const c of [legacy, wide, structured]) expect(mainDefectEscalationForHead([c], headSha)).not.toBeNull();
    expect(mainDefectEscalationForHead([own], headSha)).toBeNull();
    expect(mainDefectEscalationForHead([legacy], 'otherhead')).toBeNull();
  });

  it('owes one refresh once main is green on a run after the failure, even with a green merge base', () => {
    for (const c of [legacy, wide, structured]) expect(isMainGreenFixOwed(facts([c]))).toBe(true);
  });

  it('never refreshes a PR whose red is its own diff, or before main recovered, or when it already has the fix', () => {
    expect(isMainGreenFixOwed(facts([own]))).toBe(false);
    expect(isMainGreenFixOwed(facts([]))).toBe(false);
    expect(isMainGreenFixOwed(facts([legacy], { mainLatestCheckRuns: [{ ...green, completed_at: '2026-10-08T01:00:00Z' }] }))).toBe(false);
    expect(isMainGreenFixOwed(facts([legacy], { prContainsMainGreenSha: true }))).toBe(false);
  });

  const pr = { number: 4368, state: 'OPEN', headRefName: 'lane/item-110', headRefOid: headSha,
    labels: [{ name: 'ci:failed' }, { name: 'review-status:needs-human' }], mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: failedAt }] };
  const run = (comments, env = {}) => {
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased', newCommit: 'fresh' }));
    const old = process.env.WE_MAIN_DEFECT_REBASES_PER_SHA;
    if (env.cap !== undefined) process.env.WE_MAIN_DEFECT_REBASES_PER_SHA = env.cap;
    try {
      const result = sweepCiRedRecovery({ apply: true, readOpenPrs: () => [pr], readRequiredContexts: () => ['test'],
        readMainRuns: () => [], readAheadBy: () => 3, readMainLatestCheckRuns: () => [green],
        readMainGreenFixFacts: () => ({ prContainsMainGreenSha: false, mergeBaseCheckRuns: [greenAtBase], mergeBaseRunConclusion: 'success' }),
        readComments: () => comments, refresh, postComment: vi.fn(), reconcileAcceptance: vi.fn() });
      return { result, refresh };
    } finally { if (old === undefined) delete process.env.WE_MAIN_DEFECT_REBASES_PER_SHA; else process.env.WE_MAIN_DEFECT_REBASES_PER_SHA = old; }
  };

  it('sweep refreshes a main-defect-escalated PR once; an own-diff escalation is left alone', () => {
    const a = run([legacy]);
    expect(a.result.dispatch).toEqual([expect.objectContaining({ prNumber: 4368, kind: 'rebase-onto-main' })]);
    expect(a.refresh).toHaveBeenCalledOnce();
    // the new head matches no escalation, so the derived review-status:needs-human label drops on the next tag.
    expect(latestCiHealEscalationForHead([legacy], a.result.applied[0].newCommit)).toBeNull();
    const b = run([own]);
    expect(b.refresh).not.toHaveBeenCalled();
    expect(b.result.refusals[0].kind).toBe('own-failure');
  });

  it('is bounded by the knob: after the allowed refreshes on this head, no more', () => {
    const attempt = { author: { login: 'web-everything' }, body: `🔀 conveyor rebase-onto-main\n\nsha: ${headSha}\nrebased` };
    expect(resolveMainDefectRebaseCap({})).toBe(1);
    expect(resolveMainDefectRebaseCap({ WE_MAIN_DEFECT_REBASES_PER_SHA: '0' })).toBe(0);
    const r = run([legacy, attempt]);
    expect(r.refresh).not.toHaveBeenCalled();
    expect(r.result.refusals[0].kind).toBe('rebase-cap-exhausted');
    // knob 0 = off: refused with no prior attempt; knob 2 allows a second refresh on the same head.
    expect(run([legacy], { cap: '0' }).refresh).not.toHaveBeenCalled();
    expect(run([legacy, attempt], { cap: '2' }).refresh).toHaveBeenCalledOnce();
  });
});

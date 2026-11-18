import { describe, expect, it, vi } from 'vitest';
import { buildSameHeadWakeComment, countRearmComments, REARM_COMMENT_MARKER, SAME_HEAD_WAKE_TRAILER } from '../rearm-review.mjs';
import { enrichPrsWithMechanicalRound, hasPendingMechanicalRound } from '../mechanical-round-cap.mjs';
import { countRealFixRounds, planReconcile } from '../reconcile-core.mjs';
import { CONFLICT_FIX_COMMENT_MARKER } from '../conflict-fix-round-count.mjs';

const head = 'a'.repeat(40);
const at = hour => `2026-11-15T${String(hour).padStart(2, '0')}:00:00Z`;
const comment = (hour, body) => ({ body, createdAt: at(hour), author: { login: 'web-everything' } });
const wake = hour => comment(hour, buildSameHeadWakeComment({ actor: 'chalbert', key: `wake-${hour}` }));
const rearm = hour => comment(hour, `${REARM_COMMENT_MARKER}\n\nRepaired the finding.`);
const oldCommit = { sha: head, parents: ['b'.repeat(40)], authoredAt: at(0), subject: 'original PR work' };
const facts = { head, commits: [oldCommit] };
const candidate = comments => ({ number: 6877, headRefOid: head, headRefName: 'lane/wake', baseRefName: 'main',
  rowsHead: head, rowsComplete: true,
  isDraft: false, createdAt: at(0), labels: [{ name: 'review:pending' }], comments,
  files: [{ path: 'src/a.mjs' }],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: head }] });

describe('same-head wakes never spend the negotiation budget (PR #6877)', () => {
  it('five generated trusted wakes neither trigger enrichment nor consume real fix rounds', () => {
    const pr = candidate([1, 2, 3, 4, 5].map(wake));
    const reader = vi.fn(() => facts);
    expect(countRearmComments(pr.comments)).toBe(0);
    expect(enrichPrsWithMechanicalRound([pr], { roundCap: 5, readRoundCommits: reader })[0]).toBe(pr);
    expect(reader).not.toHaveBeenCalled();
    expect(countRealFixRounds({ ...pr, roundCommits: facts })).toMatchObject({ ok: true, real: 0, total: 0 });
  });

  it('the production planner still dispatches the owed review with preloaded commit facts', () => {
    const pr = { ...candidate([1, 2, 3, 4, 5].map(wake)), roundCommits: facts };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, roundCap: 5,
      reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false },
      requiredChecks: ['test'], now: Date.parse(at(10)) });
    expect(plan.refusals.some(r => r.kind === 'cap-exhausted')).toBe(false);
    expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'review', attempts: 0 }));
  });

  it.each([4, 5])('uses only the %i ordinary re-arms for the enrichment threshold and windows', count => {
    const pr = candidate([...Array.from({ length: count }, (_, i) => rearm(i + 1)), ...[6, 7, 8, 9, 10].map(wake)]);
    const reader = vi.fn(() => facts);
    enrichPrsWithMechanicalRound([pr], { roundCap: 5, readRoundCommits: reader });
    expect(reader).toHaveBeenCalledTimes(count >= 5 ? 1 : 0);
    expect(countRearmComments(pr.comments)).toBe(count);
    expect(countRealFixRounds({ ...pr, roundCommits: facts })).toMatchObject({ ok: true, real: count, total: count });
  });

  it.each([false, true])('a wake inside a real or mechanical fix window never splits it (mechanical=%s)', mechanical => {
    const begin = comment(1, '🔒 conveyor fix-begin — fix claim held\n\n**Who:** `fix-6877`');
    const commit = { ...oldCommit, authoredAt: at(2), ...(mechanical ? {
      parents: ['b'.repeat(40), 'c'.repeat(40)], subject: 'Merge origin/main', mergesPrWork: false,
    } : {}) };
    const result = countRealFixRounds({ ...candidate([begin, wake(3), rearm(4)]), roundCommits: { head, commits: [commit] } });
    expect(result).toMatchObject({ ok: true, real: mechanical ? 0 : 1, total: 1 });
    expect(result.rounds[0].shas).toEqual(mechanical ? [] : [head]);
  });

  it('a wake is not a newer fix round that supersedes a pending mechanical round', () => {
    const comments = [comment(1, CONFLICT_FIX_COMMENT_MARKER), wake(2)];
    expect(hasPendingMechanicalRound(candidate(comments))).toBe(true);
    expect(hasPendingMechanicalRound(candidate([...comments, rearm(3)]))).toBe(false);
  });

  it('shares trust, whitespace and quoted-trailer semantics across all counters', () => {
    const padded = { ...wake(1), body: `\r\n  ${wake(1).body}\r\n  `, createdAt: 'invalid wake timestamp' };
    const quoted = comment(2, `${REARM_COMMENT_MARKER}\n\nquoted ${SAME_HEAD_WAKE_TRAILER} mid-body`);
    const foreign = { ...rearm(3), author: { login: 'outsider' } };
    const pr = candidate([padded, quoted, foreign, comment(4, `> ${REARM_COMMENT_MARKER}`)]);
    const reader = vi.fn(() => facts);
    expect(countRearmComments(pr.comments)).toBe(1);
    enrichPrsWithMechanicalRound([pr], { roundCap: 2, readRoundCommits: reader });
    expect(reader).not.toHaveBeenCalled();
    expect(countRealFixRounds({ ...pr, roundCommits: facts })).toMatchObject({ ok: true, real: 1, total: 1 });
  });
});

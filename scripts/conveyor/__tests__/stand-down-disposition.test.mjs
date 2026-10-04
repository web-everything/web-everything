/**
 * @file stand-down-disposition.test.mjs — #3850: the operator answered a stand-down "Close as superseded".
 *   The fixer got that as free text, read it as "delete the card's files", was denied, and ended blocked-on-infra
 *   with the PR open. A disposition is now STRUCTURED (`--disposition=close-superseded`, or inferred from an
 *   answer that opens with "close … as superseded"), planned as `close-superseded` (never a fix), and executed
 *   mechanically by the promote-draft pass. The fixture is #3850's own two live comments.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  answerDisposition, buildOperatorAnswer, parseOperatorAnswer, withOperatorAnswer, DISPOSITIONS,
} from '../stand-down-answer-core.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { runReconcilePromoteDraftDispatch, closeSupersededComment, CLOSE_SUPERSEDED_MARKER } from '../../operations/promote-draft-pr-dispatch.mjs';

const comments3850 = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', '3850-stand-down-answer.json'), 'utf8'));
const pr3850 = {
  number: 3850, state: 'OPEN', isDraft: false, headRefName: 'lane/prepare-org-move-xvgqv8h', headRefOid: '1e9fa9be3',
  labels: [{ name: 'review:changes' }, { name: 'review-round:1' }], comments: comments3850, commits: [],
  statusCheckRollup: [], mergeStateStatus: 'CLEAN',
};

describe('#3850 — structured dispositions', () => {
  it('the live answer infers close-superseded; ordinary rulings infer nothing', () => {
    expect(answerDisposition({ reason: 'Close as superseded: the org move already happened (repos now under …)' })).toBe('close-superseded');
    expect(answerDisposition({ reason: 'Scope correction is fine but must be careful' })).toBeNull();
    expect(answerDisposition({ reason: 'Fix the test; the old card was superseded by #12' })).toBeNull();
    expect(answerDisposition(null)).toBeNull();
  });

  it('an explicit disposition round-trips through the record, and an unknown one is refused', () => {
    const body = buildOperatorAnswer({ standDownId: 'IC_x', reason: 'drop it', actor: 'chalbert', channel: 'chat', disposition: 'close-superseded' });
    expect(body).toContain('**Disposition:** `close-superseded`');
    const parsed = parseOperatorAnswer({ author: { login: 'chalbert' }, body });
    expect(parsed.disposition).toBe('close-superseded');
    expect(answerDisposition(parsed)).toBe('close-superseded');
    expect(() => buildOperatorAnswer({ standDownId: 'IC_x', reason: 'r', actor: 'a', channel: 'c', disposition: 'delete-files' })).toThrow(/disposition/);
    expect(DISPOSITIONS).toEqual(['close-superseded']);
  });

  it('a legacy answer without the field still parses byte-for-byte (no disposition line added)', () => {
    const answer = comments3850.find((c) => c.body.startsWith('<!-- conveyor-stand-down-answer:v1 -->'));
    expect(parseOperatorAnswer(answer)).toMatchObject({ actor: 'chalbert' });
  });

  it('PR #3850 (live comments) is planned close-superseded, never fix', () => {
    const plan = planReconcile({ prs: [pr3850], agents: [], durableCounts: {}, now: Date.parse('2026-10-04T17:40:00Z') });
    const mine = plan.dispatch.filter((d) => d.prNumber === 3850);
    expect(mine.map((d) => d.kind)).toEqual(['close-superseded']);
  });

  it('a live fix claim still wins: nothing is closed under a running fixer', () => {
    const plan = planReconcile({ prs: [{ ...pr3850, fixClaim: { who: 'fix-3850' } }], agents: [], durableCounts: {}, now: 0 });
    expect(plan.dispatch.filter((d) => d.prNumber === 3850)).toEqual([]);
  });

  it('a fixer prompt that still carries the disposition forbids file deletion', () => {
    const p = withOperatorAnswer('BRIEF', { reason: 'Close as superseded: done', actor: 'chalbert', channel: 'chat' });
    expect(p).toMatch(/DISPOSITION `close-superseded`/);
    expect(p).toMatch(/Do NOT delete/);
  });
});

describe('#3850 — the promote-draft pass executes the disposition', () => {
  const base = {
    root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }), clearAwaitingCi: () => {},
    readHeadCheckState: () => ({ state: 'green', why: '', counts: {} }), provider: { ready: () => { throw new Error('no'); } },
  };
  const answer = { reason: 'Close as superseded: the org move already happened', actor: 'chalbert', channel: 'claude-code-chat' };
  const plan = { dispatch: [{ kind: 'close-superseded', prNumber: 3850, operatorAnswer: answer }], refusals: [] };

  it('closes the PR with the superseded comment when no card is on main', () => {
    const closed = [];
    const r = runReconcilePromoteDraftDispatch({ ...base, reconcile: () => plan, readCardsOnMain: () => [], closePr: (a) => closed.push(a) });
    expect(closed).toHaveLength(1);
    expect(closed[0].prNumber).toBe(3850);
    expect(closed[0].comment.startsWith(CLOSE_SUPERSEDED_MARKER)).toBe(true);
    expect(closed[0].comment).toContain('> Close as superseded: the org move already happened');
    expect(r.dispatched).toEqual([{ pr: 3850, kind: 'close-superseded' }]);
  });

  it('refuses (no close) when the card already exists on main, or the read fails', () => {
    const never = () => { throw new Error('must not close'); };
    const onMain = runReconcilePromoteDraftDispatch({ ...base, reconcile: () => plan, readCardsOnMain: () => ['backlog/x.md'], closePr: never });
    expect(onMain.refusals).toEqual([expect.objectContaining({ pr: 3850, kind: 'close-card-on-main' })]);
    const unreadable = runReconcilePromoteDraftDispatch({ ...base, reconcile: () => plan, readCardsOnMain: () => { throw new Error('gh down'); }, closePr: never });
    expect(unreadable.refusals).toEqual([expect.objectContaining({ pr: 3850, kind: 'close-unreadable' })]);
  });

  it('the comment escapes HTML-comment openers in the quoted ruling', () => {
    expect(closeSupersededComment({ reason: 'x <!-- y', actor: 'a', channel: 'c' })).toContain('&lt;!-- y');
  });
});

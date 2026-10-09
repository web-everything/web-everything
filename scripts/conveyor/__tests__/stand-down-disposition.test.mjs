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
  answerDisposition, buildOperatorAnswer, parseOperatorAnswer, withOperatorAnswer, DISPOSITIONS, isCloseSupersededExecuted,
} from '../stand-down-answer-core.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import {
  runReconcilePromoteDraftDispatch, closeSupersededComment, CLOSE_SUPERSEDED_MARKER, defaultReadCardsOnMain, PR_FILES_JSON_CAP,
} from '../../operations/promote-draft-pr-dispatch.mjs';

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

  it('a DESTRUCTIVE disposition is never inferred from prose naming another object or asking for more work', () => {
    for (const reason of [
      'Supersedes the earlier ruling — keep the PR, just fix the failing test',
      'Supersede the old implementation with the reviewed replacement',
      'Superseded by #12, carry on',
      'Close issue #123 as superseded; continue this repair',
      'Close the old card as superseded and fix this PR',
      'Close as superseded but keep the card',
    ]) expect(answerDisposition({ reason }), reason).toBeNull();
    expect(answerDisposition({ reason: 'Close this PR as superseded.' })).toBe('close-superseded');
    expect(answerDisposition({ reason: 'close as superseded' })).toBe('close-superseded');
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

  it('the open-only listing carries no `state` field — absent state is open (live edge regression)', () => {
    const { state, ...listed } = pr3850;
    const plan = planReconcile({ prs: [listed], agents: [], durableCounts: {}, now: Date.parse('2026-10-04T17:40:00Z') });
    expect(plan.dispatch.filter((d) => d.prNumber === 3850).map((d) => d.kind)).toEqual(['close-superseded']);
    expect(planReconcile({ prs: [{ ...pr3850, state: 'CLOSED' }], agents: [], durableCounts: {}, now: 0 }).dispatch
      .filter((d) => d.kind === 'close-superseded')).toEqual([]);
  });

  it('idempotent: once the conveyor\'s close comment postdates the answer, a REOPENED PR is not re-closed', () => {
    const closed = { author: { login: 'web-everything' }, body: closeSupersededComment({ reason: 'Close as superseded: x', actor: 'chalbert', channel: 'chat' }) };
    const reopened = { ...pr3850, comments: [...comments3850, closed] };
    const plan = planReconcile({ prs: [reopened], agents: [], durableCounts: {}, now: Date.parse('2026-10-04T17:40:00Z') });
    expect(plan.dispatch.filter((d) => d.prNumber === 3850)).toEqual([]);
    expect(isCloseSupersededExecuted(reopened.comments)).toBe(true);
    // a marker an UNTRUSTED account posted counts for nothing; a fresh answer AFTER the marker plans again
    const forged = { ...pr3850, comments: [...comments3850, { author: { login: 'random-user' }, body: closed.body }] };
    expect(isCloseSupersededExecuted(forged.comments)).toBe(false);
    const reanswered = [...comments3850, closed, comments3850.find((c) => c.body.startsWith('<!-- conveyor-stand-down-answer:v1 -->'))];
    expect(isCloseSupersededExecuted(reanswered)).toBe(false);
    // a stray well-formed answer naming NO stand-down after the marker does not move the boundary
    const stray = { author: { login: 'chalbert' }, body: buildOperatorAnswer({ standDownId: 'IC_nothing', reason: 'x', actor: 'chalbert', channel: 'chat' }) };
    expect(isCloseSupersededExecuted([...reopened.comments, stray])).toBe(true);
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

  it('defaultReadCardsOnMain fails closed when gh truncated the files list at its 100-entry cap', () => {
    const files = (n) => JSON.stringify({ files: Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.js` })) });
    const runGh = (n) => (args) => { if (args[0] === 'pr') return files(n); throw new Error('no contents call expected'); };
    expect(() => defaultReadCardsOnMain({ repoSlug: 'o/r', prNumber: 1, runGh: runGh(PR_FILES_JSON_CAP) })).toThrow(/cap/);
    expect(defaultReadCardsOnMain({ repoSlug: 'o/r', prNumber: 1, runGh: runGh(PR_FILES_JSON_CAP - 1) })).toEqual([]);
  });

  it('the comment escapes HTML-comment openers in the quoted ruling', () => {
    expect(closeSupersededComment({ reason: 'x <!-- y', actor: 'a', channel: 'c' })).toContain('&lt;!-- y');
  });
});

describe('#4522 — a close-superseded ruling resolves EVERY earlier stand-down, not only the one it names', () => {
  // Live 2026-10-09: #4522 carried TWO stand-downs (a fix agent's at 04:36Z, supersede-watch's at 05:38Z). The
  // operator's `--disposition=close-superseded` answer named the LATEST one, so the earlier stand-down still
  // counted as unresolved, REFUSAL 1 (`stood-down`) fired before the disposition branch, and the PR stayed open.
  const comments4522 = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', '4522-two-stand-downs-close-superseded.json'), 'utf8'));
  const pr4522 = {
    number: 4522, isDraft: false, headRefName: 'lane/main-red-soak', headRefOid: '22052c0d1',
    labels: [{ name: 'review:changes' }, { name: 'merge-status:conflicting' }, { name: 'review-status:stood-down' }, { name: 'superseded' }],
    comments: comments4522, commits: [], statusCheckRollup: [], mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING',
  };
  const now = Date.parse('2026-10-09T11:30:00Z');

  it('the live #4522 thread is planned close-superseded (not refused stood-down)', () => {
    const plan = planReconcile({ prs: [pr4522], agents: [], durableCounts: {}, now });
    expect(plan.refusals.filter((r) => r.prNumber === 4522).map((r) => r.kind)).not.toContain('stood-down');
    expect(plan.dispatch.filter((d) => d.prNumber === 4522).map((d) => d.kind)).toEqual(['close-superseded']);
  });

  it('only a DISPOSITION widens: an ordinary answer to the later stand-down leaves the earlier one terminal', () => {
    const answerAt = comments4522.findIndex((c) => String(c.body).startsWith('<!-- conveyor-stand-down-answer:v1 -->'));
    const rec = parseOperatorAnswer(comments4522[answerAt]);
    const plain = { ...comments4522[answerAt], body: buildOperatorAnswer({ standDownId: rec.standDownId, reason: 'Fix the test instead', actor: 'chalbert', channel: 'chat' }) };
    const thread = [...comments4522.slice(0, answerAt), plain];
    const plan = planReconcile({ prs: [{ ...pr4522, comments: thread }], agents: [], durableCounts: {}, now });
    expect(plan.refusals.filter((r) => r.prNumber === 4522).map((r) => r.kind)).toContain('stood-down');
  });

  it('a stand-down posted AFTER the disposition is still terminal, and a live fix claim still wins', () => {
    const firstStandDown = comments4522.find((c) => /stood down, human judgment needed/.test(String(c.body)));
    const later = [...comments4522, { ...firstStandDown, id: 'IC_after', createdAt: '2026-10-09T12:00:00Z' }];
    const plan = planReconcile({ prs: [{ ...pr4522, comments: later }], agents: [], durableCounts: {}, now });
    expect(plan.dispatch.filter((d) => d.kind === 'close-superseded')).toEqual([]);
    expect(plan.refusals.filter((r) => r.prNumber === 4522).map((r) => r.kind)).toContain('stood-down');
    const claimed = planReconcile({ prs: [{ ...pr4522, fixClaim: { who: 'fix-4522' } }], agents: [], durableCounts: {}, now });
    expect(claimed.dispatch.filter((d) => d.prNumber === 4522)).toEqual([]);
  });
});

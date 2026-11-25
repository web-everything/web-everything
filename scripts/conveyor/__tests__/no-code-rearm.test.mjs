/**
 * @file no-code-rearm.test.mjs — STANDDOWN-EMPTY-ROUND (D2). The orchestrator's `rearm-review --no-code-owed` ruling
 *   is executed ONCE by the conveyor and never handed to a fixer (live #7448, #7451: the answered stand-down fell
 *   through to fix dispatch, the new fixer posted a fix-begin on the same head, and rearm-review refused again).
 *   Negative tests first: every case below must plan zero fixers, and at most one `rearm-no-code`.
 */
import { describe, it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { buildOperatorAnswer, isNoCodeRearmAnswer, isNoCodeRearmExecuted, latestOperatorAnswerCommentId } from '../stand-down-answer-core.mjs';
import { buildStandDownComment } from '../stand-down.mjs';
import { buildNoChangeComment, buildRearmComment, decideRearm } from '../rearm-review.mjs';
import { runReconcilePromoteDraftDispatch, defaultRearmNoCode } from '../../operations/promote-draft-pr-dispatch.mjs';

const BOT = { login: 'web-everything' };
const HEAD = '93ff74ce966785fe5844fa63f2be9b8ed091aa52';
const begin = (id, sha = HEAD) => ({ id, author: BOT, body: `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${sha.slice(0, 9)}\`\n<!-- fix-claim who=fix-7448 -->` });
const verdict = { id: 'IC_99', author: BOT, body: `🔁 review — changes requested\n\nrequired check "merge-gate" FAILURE\n<!-- reviewed-sha: ${HEAD} -->` };
const stop = { id: 'IC_106', author: BOT, body: buildStandDownComment({ reason: 'needs-judgment', detail: 'Is code owed?' }) };
const answer = (extra = {}, id = 'IC_200') => ({ id, author: { login: 'chalbert' },
  body: buildOperatorAnswer({ standDownId: 'IC_106', reason: 'No code is owed', actor: 'chalbert', channel: 'chat', disposition: 'rearm-review', noCodeOwed: true, ...extra }) });
const base = [verdict, begin('IC_105'), stop, answer()];
const pr = (over = {}) => ({ number: 7448, state: 'OPEN', isDraft: false, headRefName: 'lane/x', headRefOid: HEAD,
  labels: [{ name: 'review:changes' }, { name: 'review-round:1' }, { name: 'status:answered-waiting-fixer' }],
  comments: base, commits: [], statusCheckRollup: [], mergeStateStatus: 'CLEAN', ...over });
const plan = (over = {}) => planReconcile({ prs: [pr(over)], agents: [], durableCounts: {}, now: Date.parse('2026-11-24T22:00:00Z') });
const kinds = (p, kind) => p.dispatch.filter((d) => d.kind === kind);
const noFixers = (p) => expect(p.dispatch.filter((d) => ['fix', 'ci-heal', 'review'].includes(d.kind))).toEqual([]);
const refusalKinds = (p) => p.refusals.map((r) => r.kind);

describe('predicates', () => {
  it('only an explicit rearm-review + noCodeOwed answer is a no-code rearm answer', () => {
    expect(isNoCodeRearmAnswer({ disposition: 'rearm-review', noCodeOwed: true })).toBe(true);
    expect(isNoCodeRearmAnswer({ disposition: 'rearm-review' })).toBe(false);
    expect(isNoCodeRearmAnswer({ disposition: 'close-superseded', noCodeOwed: true })).toBe(false);
    expect(isNoCodeRearmAnswer(null)).toBe(false);
  });
  it('executed = a trusted rearm marker or empty-round note AFTER the latest answer; a forged or earlier one is not', () => {
    const rearm = { id: 'IC_300', author: BOT, body: buildRearmComment({ actor: 'x', decision: decideRearm({ currentLabels: ['review:changes'] }) }) };
    const nochange = { id: 'IC_301', author: BOT, body: buildNoChangeComment({ actor: 'x', since: 'abc' }) };
    expect(isNoCodeRearmExecuted(base)).toBe(false);
    expect(isNoCodeRearmExecuted([...base, rearm])).toBe(true);
    expect(isNoCodeRearmExecuted([...base, nochange])).toBe(true);
    expect(isNoCodeRearmExecuted([rearm, ...base])).toBe(false);
    expect(isNoCodeRearmExecuted([...base, { ...rearm, author: { login: 'outsider' } }])).toBe(false);
    expect(latestOperatorAnswerCommentId(base)).toBe('IC_200');
  });
});

describe('planner: exactly one rearm-no-code and zero fixers (findings 1-5)', () => {
  it('plans one rearm-no-code and no fixer/review row, identically on two ticks', () => {
    for (let tick = 0; tick < 2; tick += 1) {
      const p = plan();
      expect(kinds(p, 'rearm-no-code')).toHaveLength(1);
      expect(kinds(p, 'rearm-no-code')[0]).toMatchObject({ prNumber: 7448, expectHead: HEAD, answerId: 'IC_200' });
      noFixers(p);
    }
  });
  it('2: once a success marker or the empty-round note postdates the answer, nothing is planned; review:changes standing notes spent', () => {
    for (const body of [buildRearmComment({ actor: 'x', decision: decideRearm({ currentLabels: ['review:changes'] }) }), buildNoChangeComment({ actor: 'x', since: 'abc' })]) {
      const spent = plan({ comments: [...base, { id: 'IC_300', author: BOT, body }] });
      expect(kinds(spent, 'rearm-no-code')).toEqual([]);
      noFixers(spent);
      expect(refusalKinds(spent)).toContain('no-code-rearm-spent');
      expect(spent.notes.some((n) => n.kind === 'no-code-rearm-spent')).toBe(true);
    }
    const swapped = plan({ labels: [{ name: 'review:pending' }], comments: [...base, { id: 'IC_300', author: BOT, body: buildNoChangeComment({ actor: 'x', since: 'abc' }) }] });
    expect(kinds(swapped, 'rearm-no-code')).toEqual([]);
    expect(refusalKinds(swapped)).not.toContain('no-code-rearm-spent');
  });
  it('1,3: a live fix claim plans no rearm-no-code, no review, no fixer', () => {
    const p = plan({ fixClaim: { who: 'fix-1', claimedAt: '2026-11-24T21:59:00Z' } });
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
    noFixers(p);
    expect(refusalKinds(p)).toContain('fix-claimed');
  });
  it('1,3: round cap at max plans no review and no fixer (the ruling is the cap override, not a new round)', () => {
    const rounds = Array.from({ length: 6 }, (_, i) => ({ id: `IC_r${i}`, author: BOT, body: buildRearmComment({ actor: 'x', decision: decideRearm({ currentLabels: ['review:changes'] }) }) }));
    const p = plan({ comments: [...rounds, ...base] });
    expect(kinds(p, 'review')).toEqual([]);
    expect(kinds(p, 'fix')).toEqual([]);
  });
  it.each(['red-team:blocked', 'red-team:pending'])('4: %s added after the answer refuses held, no fixer', (label) => {
    const p = plan({ labels: [{ name: 'review:changes' }, { name: label }] });
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
    noFixers(p);
    expect(refusalKinds(p)).toContain('no-code-rearm-held');
  });
  it('4: a head that is not a full sha, an incomplete label list, or a missing review:changes is held', () => {
    for (const over of [{ headRefOid: 'abc1234' }, { labels: [{ name: 'review:changes' }, { id: 1 }] }, { labels: [{ name: 'review:pending' }] }]) {
      const p = plan(over);
      expect(kinds(p, 'rearm-no-code'), JSON.stringify(over)).toEqual([]);
      noFixers(p);
      expect(refusalKinds(p)).toContain('no-code-rearm-held');
    }
  });
  it('5: a fix-begin posted after the ruling refuses held, zero fixers', () => {
    const p = plan({ comments: [...base, begin('IC_210')] });
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
    noFixers(p);
    expect(refusalKinds(p)).toContain('no-code-rearm-held');
    expect(p.notes.some((n) => n.kind === 'no-code-rearm-held')).toBe(true);
  });
  it('an answer without noCodeOwed (plain rearm-review) never plans rearm-no-code', () => {
    const p = plan({ comments: [verdict, begin('IC_105'), stop, answer({ noCodeOwed: undefined })] });
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
  });
  it('a closed PR plans nothing', () => {
    expect(kinds(plan({ state: 'CLOSED' }), 'rearm-no-code')).toEqual([]);
  });
});

describe('executor: one attempt per tick, rearm-review is the only writer', () => {
  const run = (rearm, entry = { kind: 'rearm-no-code', prNumber: 7448, expectHead: HEAD, answerId: 'IC_200' }) => runReconcilePromoteDraftDispatch({
    root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }), clearAwaitingCi: () => {},
    readHeadCheckState: () => ({ state: 'green', why: '', counts: {} }), provider: { ready: () => { throw new Error('no'); } },
    reconcile: () => ({ dispatch: [entry], refusals: [] }), rearm });
  it('runs the rearm once with the pinned head and records the dispatch', () => {
    const calls = [];
    const r = run((a) => calls.push(a));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ prNumber: 7448, expectHead: HEAD, answerId: 'IC_200' });
    expect(r.dispatched).toEqual([{ pr: 7448, kind: 'rearm-no-code' }]);
  });
  it('4: a non-zero rearm (moved head, empty-round guard, red-team) is rearm-no-code-failed and is not retried within the tick', () => {
    let calls = 0;
    const r = run(() => { calls += 1; throw new Error('PR head moved'); });
    expect(calls).toBe(1);
    expect(r.refusals).toEqual([expect.objectContaining({ pr: 7448, kind: 'rearm-no-code-failed', why: 'PR head moved' })]);
    expect(r.dispatched).toEqual([]);
  });
  it('the default writer shells rearm-review.mjs with --expect-head and a conveyor actor, and throws on non-zero', () => {
    const seen = [];
    defaultRearmNoCode({ repoSlug: 'o/r', prNumber: 7448, expectHead: HEAD, answerId: 'IC_200', run: (cmd, args) => { seen.push([cmd, args]); return { status: 0, stdout: 'ok' }; } });
    expect(seen[0][1].some((a) => a.endsWith('rearm-review.mjs'))).toBe(true);
    expect(seen[0][1]).toEqual(expect.arrayContaining(['7448', '--repo=o/r', `--expect-head=${HEAD}`, '--actor=conveyor (operator no-code ruling IC_200)']));
    expect(() => defaultRearmNoCode({ repoSlug: 'o/r', prNumber: 1, expectHead: HEAD, run: () => ({ status: 1, stderr: 'refused' }) })).toThrow('refused');
  });
});

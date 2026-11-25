import { describe, expect, it, vi } from 'vitest';
import { buildStandDownComment } from '../stand-down.mjs';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';
import { parseOperatorAnswer, buildOperatorAnswer } from '../stand-down-answer-core.mjs';
import { buildNoChangeComment, decideEmptyFixRound, rearmWindow } from '../rearm-review.mjs';
import { classifyNoCodeOwedRearm, enrichPrsWithNoCodeOwedRearm, mergeGateOnlyReviewHold } from '../stand-down-no-code-owed.mjs';

const head = 'a'.repeat(40);
const author = { login: AUTOMATION_LOGINS[0] };
const verdict = { id: 'V1', author, body: '🔁 review — changes requested\n\nfindings' };
const begin = (sha = head) => ({ id: 'B1', author,
  body: `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${sha.slice(0, 9)}\`\n<!-- fix-claim who=fix-1 -->` });
const note = (sha = head, actor = 'conveyor fix agent', a = author) => ({ id: 'N1', author: a, body: buildNoChangeComment({ actor, since: sha.slice(0, 9) }) });
const stand = (id = 'SD1', reason = 'needs-judgment', a = author) =>
  ({ id, author: a, body: buildStandDownComment({ reason, detail: 'whatever the fixer wrote' }) });
const thread = (...extra) => [verdict, begin(), note(), stand(), ...extra];
const labels = (...n) => n.map(name => ({ name }));
const mkPr = (o = {}) => ({ number: 7448, headRefOid: head, labels: labels('review:changes'), comments: thread(), ...o });
const run = (name, conclusion = 'SUCCESS', id = 1, o = {}) => ({ id, name, app: { id: 15368 }, check_suite: { id: 900 }, head_sha: head,
  status: 'completed', conclusion, completed_at: '2026-11-24T21:00:00Z', ...o });
const names = ['test', 'smoke', 'merge-gate'];
const bindings = names.map(context => ({ context, integration_id: 15368 }));
const green = () => [run('test', 'SUCCESS', 1), run('smoke', 'SUCCESS', 2), run('merge-gate', 'FAILURE', 3)];
const args = (o = {}) => ({ pr: mkPr(), requiredChecks: names, requiredCheckBindings: bindings,
  checks: { head, complete: true, runs: green() }, mergeGateReviewOnly: true, ...o });
const hold = d => d.action === 'hold';

describe('auto-rearm: one daemon request for a fresh review of an unchanged head', () => {
  it('plans a distinct recover-class record, not an operator ruling, that the rearm guard honours', () => {
    const d = classifyNoCodeOwedRearm(args());
    expect(d.action).toBe('auto-rearm');
    const rec = { id: 'A1', author, body: d.body };
    const parsed = parseOperatorAnswer(rec);
    expect(parsed).toMatchObject({ disposition: 'auto-rearm', actor: 'auto-rearm', standDownId: 'SD1' });
    expect(parsed.noCodeOwed).toBeUndefined();
    expect(d.body).not.toContain('ruling to implement');
    expect(d.body).toContain('NOT an operator ruling');
    const pr = mkPr();
    expect(decideEmptyFixRound({ comments: pr.comments, liveHead: head }).empty).toBe(true);
    expect(decideEmptyFixRound({ comments: [...pr.comments, rec], liveHead: head }).empty).toBe(false);
  });

  it('a second request on the same head is refused, by the classifier and by the rearm window cap', () => {
    const d = classifyNoCodeOwedRearm(args());
    const rec = { id: 'A1', author, body: d.body };
    const again = thread(rec, stand('SD2'));
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: again }) })))).toBe(true);
    const win = rearmWindow(again);
    expect(win.wouldHonour({ standDownId: 'SD2', disposition: 'auto-rearm', actor: 'auto-rearm' })).toBe(false);
    // the cap resets only with a NEW reviewer verdict
    const fresh = rearmWindow([...again, verdict, begin(), stand('SD3')]);
    expect(fresh.wouldHonour({ standDownId: 'SD3', disposition: 'auto-rearm', actor: 'auto-rearm' })).toBe(true);
  });

  it('a forged request never lifts the empty-round guard (non-automation poster, wrong actor, wrong target)', () => {
    const body = classifyNoCodeOwedRearm(args()).body;
    for (const forged of [{ id: 'F', author: { login: 'mallory' }, viewerDidAuthor: true, body },
      { id: 'F', author: { login: 'chalbert' }, body }]) {
      expect(decideEmptyFixRound({ comments: [...mkPr().comments, forged], liveHead: head }).empty).toBe(true);
    }
    expect(() => buildOperatorAnswer({ standDownId: 'SD1', reason: 'x', actor: 'chalbert', channel: 'chat', disposition: 'auto-rearm' })).toThrow();
    const wrongTarget = { id: 'W', author, body: buildOperatorAnswer({ standDownId: 'OTHER', reason: 'x', actor: 'auto-rearm', channel: 'c', disposition: 'auto-rearm' }) };
    expect(decideEmptyFixRound({ comments: [...mkPr().comments, wrongTarget], liveHead: head }).empty).toBe(true);
  });

  it('never fires when code is owed (head moved since the fix began)', () => {
    const comments = [verdict, begin('b'.repeat(40)), note('b'.repeat(40)), stand()];
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments }) })))).toBe(true);
  });

  it('needs the fixer\'s structured no-change record, never prose', () => {
    const prose = [verdict, begin(), { ...stand(), body: buildStandDownComment({ reason: 'needs-judgment', detail: 'no code defect to repair' }) }];
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: prose }) })))).toBe(true);
    // a relayed operator re-arm attempt that the guard refused is the same structured record (#7451's shape)
    const operatorNote = [verdict, begin(), stand(), note(head, 'chalbert')];
    expect(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: operatorNote }) })).action).toBe('auto-rearm');
    const beforeBegin = [verdict, note(), begin(), stand()];
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: beforeBegin }) })))).toBe(true);
    const forgedNote = [verdict, begin(), note(head, 'conveyor fix agent', { login: 'mallory' }), stand()];
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: forgedNote }) })))).toBe(true);
    const otherHead = [verdict, begin(), note('c'.repeat(40)), stand()];
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: otherHead }) })))).toBe(true);
  });

  it('holds on a stand-down that is not a trusted needs-judgment', () => {
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: [verdict, begin(), note(), stand('SD1', 'gate-red')] }) })))).toBe(true);
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: [verdict, begin(), note(), stand('SD1', 'needs-judgment', { login: 'mallory' })] }) })))).toBe(true);
  });

  it.each(['red-team:blocked', 'red-team:pending'])('holds on %s', (l) => {
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ labels: labels('review:changes', l) }) })))).toBe(true);
  });

  it('holds without review:changes or with a malformed/incomplete label list', () => {
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ labels: labels('review:accepted') }) })))).toBe(true);
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ labels: [{ name: 'review:changes' }, {}] }) })))).toBe(true);
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ labels: undefined }) })))).toBe(true);
  });

  it('holds on failing, missing, wrong-app, unbound-identity or wrong-head check evidence (shared R123 validation)', () => {
    const swap = (fn) => args({ checks: { head, complete: true, runs: green().map(fn) } });
    expect(hold(classifyNoCodeOwedRearm(swap(r => r.name === 'test' ? { ...r, conclusion: 'FAILURE' } : r)))).toBe(true);
    expect(hold(classifyNoCodeOwedRearm(args({ checks: { head, complete: true, runs: green().slice(0, 1) } })))).toBe(true);
    expect(hold(classifyNoCodeOwedRearm(swap(r => ({ ...r, app: { id: 1 } }))))).toBe(true);
    expect(hold(classifyNoCodeOwedRearm(swap(r => ({ ...r, check_suite: undefined }))))).toBe(true);
    expect(hold(classifyNoCodeOwedRearm(swap(r => ({ ...r, completed_at: undefined }))))).toBe(true);
    expect(hold(classifyNoCodeOwedRearm(swap(r => ({ ...r, status: 'in_progress' }))))).toBe(true);
    expect(hold(classifyNoCodeOwedRearm(args({ checks: { head: 'c'.repeat(40), complete: true, runs: green() } })))).toBe(true);
    expect(hold(classifyNoCodeOwedRearm(args({ checks: { head, complete: false, runs: green() } })))).toBe(true);
  });

  it('does not exempt merge-gate without proof that its only red is the review hold', () => {
    expect(hold(classifyNoCodeOwedRearm(args({ mergeGateReviewOnly: false })))).toBe(true);
    expect(hold(classifyNoCodeOwedRearm(args({ mergeGateReviewOnly: undefined })))).toBe(true);
  });

  it('refuses an oversized thread', () => {
    const filler = Array.from({ length: 2001 }, (_, i) => ({ id: `X${i}`, author, body: 'x' }));
    expect(hold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: [...filler, ...thread()] }) })))).toBe(true);
  });
});

describe('mergeGateOnlyReviewHold re-derives the proof from merge-gate\'s own head-bound verdict', () => {
  const row = { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/55' };
  const pr = (o = {}) => ({ number: 7, headRefOid: head, labels: labels('review:changes'), statusCheckRollup: [row], ...o });
  const read = (results, o = {}) => () => ({ num: 7, ok: false, head_sha: head, completed_at: '2026-11-24T21:00:00Z', results, ...o });
  it('accepts only review-class holds', () => {
    expect(mergeGateOnlyReviewHold(pr(), { repo: 'o/r', readVerdict: read([{ status: 'hold', id: 'review-hold-labels', reason: 'labels: review:changes' }]) })).not.toBeNull();
  });
  it.each([
    ['an independent failing gate', read([{ status: 'hold', id: 'review-hold-labels', reason: 'x' }, { status: 'fail-closed', id: 'codeql', reason: 'x' }])],
    ['a verdict for another head', read([{ status: 'hold', id: 'review-hold-labels', reason: 'x' }], { head_sha: 'd'.repeat(40) })],
    ['an unreadable verdict', () => ({ error: 'no log' })],
    ['a thrown read', () => { throw new Error('boom'); }],
  ])('refuses %s', (_n, readVerdict) => {
    expect(mergeGateOnlyReviewHold(pr(), { repo: 'o/r', readVerdict })).toBeNull();
  });
  it('refuses when merge-gate did not fail', () => {
    expect(mergeGateOnlyReviewHold(pr({ statusCheckRollup: [{ ...row, conclusion: 'SUCCESS' }] }), { repo: 'o/r', readVerdict: read([]) })).toBeNull();
  });
});

describe('enrichPrsWithNoCodeOwedRearm (the writer)', () => {
  const okVerdict = () => ({ num: 7448, ok: false, head_sha: head, completed_at: '2026-11-24T21:00:00Z',
    results: [{ status: 'hold', id: 'review-hold-labels', reason: 'labels: review:changes' }] });
  const state = (o = {}) => ({ headRefOid: head, labels: labels('review:changes'),
    statusCheckRollup: [{ name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/55' }], ...o });
  const deps = (o = {}) => ({ repo: 'o/r', requiredChecks: names, readBindings: () => bindings,
    readComments: () => mkPr().comments, readState: () => state(), readVerdict: okVerdict,
    readChecks: () => ({ head, complete: true, runs: green() }), reserve: vi.fn(() => true),
    post: vi.fn(({ body }) => ({ id: 'A1', author, body })), log: () => {}, ...o });

  it('posts exactly once and keys the reservation by head', () => {
    const d = deps();
    const out = enrichPrsWithNoCodeOwedRearm([mkPr()], d);
    expect(d.post).toHaveBeenCalledTimes(1);
    expect(d.reserve).toHaveBeenCalledWith(expect.objectContaining({ standDownId: `auto-rearm-head-${head}` }));
    expect(out[0].comments.at(-1).id).toBe('A1');
  });

  it('a second stand-down on the same head cannot earn a second post (reservation is per head)', () => {
    const d = deps({ reserve: vi.fn(() => false) });
    enrichPrsWithNoCodeOwedRearm([mkPr({ comments: thread(stand('SD2')) })], d);
    expect(d.post).not.toHaveBeenCalled();
  });

  it('a red-team label applied during the check reads vetoes the post', () => {
    let n = 0;
    const d = deps({ readState: () => state(++n > 1 ? { labels: labels('review:changes', 'red-team:blocked') } : {}) });
    enrichPrsWithNoCodeOwedRearm([mkPr()], d);
    expect(d.post).not.toHaveBeenCalled();
  });

  it('a required check that fails on a reread, or a head that moved, vetoes the post', () => {
    let n = 0;
    const d = deps({ readChecks: () => ({ head, complete: true, runs: green().map(r => r.name === 'test' && ++n > 1 ? { ...r, conclusion: 'FAILURE' } : r) }) });
    enrichPrsWithNoCodeOwedRearm([mkPr()], d);
    expect(d.post).not.toHaveBeenCalled();
    const e = deps({ readState: () => state({ headRefOid: 'd'.repeat(40) }) });
    enrichPrsWithNoCodeOwedRearm([mkPr()], e);
    expect(e.post).not.toHaveBeenCalled();
  });

  it('a newer stand-down or answer arriving mid-evaluation vetoes the post and the refreshed thread is kept', () => {
    let n = 0;
    const d = deps({ readComments: () => (++n > 1 ? thread(stand('SD2')) : mkPr().comments) });
    const out = enrichPrsWithNoCodeOwedRearm([mkPr()], d);
    expect(d.post).not.toHaveBeenCalled();
    expect(out[0].comments.some(c => c.id === 'SD2')).toBe(true);
  });

  it('a failed write keeps the freshly read thread for downstream planning', () => {
    const d = deps({ readComments: () => thread(stand('SD2')), post: vi.fn(() => { throw new Error('boom'); }) });
    const out = enrichPrsWithNoCodeOwedRearm([mkPr()], d);
    expect(out[0].comments.some(c => c.id === 'SD2')).toBe(true);
  });

  it('does nothing without proof that merge-gate\'s only red is the review hold', () => {
    const d = deps({ readVerdict: () => ({ ...okVerdict(), results: [{ status: 'fail-closed', id: 'codeql', reason: 'x' }] }) });
    enrichPrsWithNoCodeOwedRearm([mkPr()], d);
    expect(d.post).not.toHaveBeenCalled();
  });
});

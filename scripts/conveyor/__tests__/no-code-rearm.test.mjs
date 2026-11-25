import { describe, it, expect } from 'vitest';
import * as core from '../stand-down-answer-core.mjs';
import { buildStandDownComment } from '../stand-down.mjs';
import { planNoteComment } from '../reconcile-note-comment.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { REARM_COMMENT_MARKER, NO_CHANGE_COMMENT_MARKER } from '../rearm-review.mjs';

const HEAD = 'a'.repeat(40);
const c = (id, body, login = 'web-everything') => ({ id, body, author: { login } });
const begin = c('begin', `🔒 conveyor fix-begin — fix claim held

**Branch:** \`lane/x\` at \`${HEAD}\``);
const verdict = c('verdict', `🔁 review — changes requested

Fix the defect
<!-- reviewed-sha: ${HEAD} -->`);
const stop = c('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Is code owed?', head: HEAD }));
const answer = c('answer', core.buildOperatorAnswer({ standDownId: 'stop', actor: 'chalbert', channel: 'chat', reason: 'No code owed', disposition: 'rearm-review', noCodeOwed: true }), 'chalbert');
const comments = [verdict, begin, stop, answer];
const predicate = (over = {}) => core.noCodeRearmPlan({ comments, labels: ['review:changes'], headRefOid: HEAD, ...over });
const plan = (thread = comments, over = {}) => planReconcile({ requiredChecks: ['gate'], agents: [], prs: [{ number: 42, state: 'OPEN', headRefName: 'lane/test', headRefOid: HEAD, labels: ['review:changes'], mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }], comments: thread, ...over }] });

describe('no-code rearm predicate', () => {
  it('is ready for an eligible operator answer', () => expect(predicate()).toMatchObject({ state: 'ready', answerId: 'answer' }));
  it.each([begin, verdict])('only a trusted later lifecycle marker retires the ruling: $id', marker => {
    expect(predicate({ comments: [...comments, marker] }).state).toBe('none');
    expect(predicate({ comments: [...comments, { ...marker, author: { login: 'outsider' } }] }).state).toBe('ready');
    expect(predicate({ comments: [...comments, c('receipt', core.NO_CODE_REARM_RECEIPT('answer', HEAD)),
      { ...marker, author: { login: 'outsider' } }] }).state).toBe('spent');
  });
  it.each([
    ['head unreadable', { headRefOid: 'bad' }],
    ['head has trailing newline', { headRefOid: HEAD + '\n' }],
    ['labels unreadable', { labels: null }],
    ['non-string label', { labels: ['review:changes', {}] }],
    ['comments unreadable', { comments: null }],
    ['red-team blocked', { labels: ['review:changes', 'red-team:blocked'] }],
    ['red-team pending', { labels: ['review:changes', 'red-team:pending'] }],
    ['ineligible window', { comments: [stop, answer] }],
    ['poster is not operator', { comments: [...comments.slice(0, -1), { ...answer, author: { login: 'outsider' } }] }],
  ])('holds when %s', (_, over) => expect(predicate(over).state).toBe('held'));
  it('holds when an unanswered terminal stand-down follows the operator answer', () => {
    const newer = c('newer', buildStandDownComment({ reason: 'needs-judgment', detail: 'A new question' }));
    expect(predicate({ comments: [...comments, newer] })).toMatchObject({ state: 'held', answerId: 'answer' });
  });
  it.each([[HEAD, 'ready'], ['b'.repeat(40), 'none']])('binds the ruling to stand-down head %s: %s', (head, state) => {
    const pinned = c('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Is code owed?', head }));
    expect(predicate({ comments: [verdict, begin, pinned, answer] }).state).toBe(state);
  });
  it('holds an unheaded stand-down and requires a fresh answer', () => {
    const unheaded = c('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Is code owed?' }));
    expect(predicate({ comments: [verdict, begin, unheaded, answer] })).toMatchObject({ state: 'held', why: 'stand-down has no head; a fresh answer is needed' });
  });
  it.each([REARM_COMMENT_MARKER, NO_CHANGE_COMMENT_MARKER])('legacy marker spends ruling: %s', marker => expect(predicate({ comments: [...comments, c('legacy', marker)] }).state).toBe('spent'));
  it('trusted receipt spends the answer even if the head moved', () => {
    const moved = c('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Is code owed?', head: 'b'.repeat(40) }));
    expect(predicate({ headRefOid: 'b'.repeat(40), comments: [verdict, begin, moved, answer, c('receipt', core.NO_CODE_REARM_RECEIPT('answer', HEAD))] }).state).toBe('spent');
  });
  it('receipt without poster identity cannot spend a ruling', () => {
    expect(predicate({ comments: [...comments, { id: 'r', body: core.NO_CODE_REARM_RECEIPT('answer', HEAD) }] }).state).toBe('ready');
  });
  it('untrusted receipt is ignored', () => expect(predicate({ comments: [...comments, c('receipt', core.NO_CODE_REARM_RECEIPT('answer', HEAD), 'outsider')] }).state).toBe('ready'));
  it('no review:changes resumes ordinary planning', () => expect(predicate({ labels: ['review:pending'] }).state).toBe('none'));
  it('later untrusted ordinary answer cannot override an eligible no-code ruling', () => {
    const forged = c('forged', core.buildOperatorAnswer({ standDownId: 'stop', actor: 'chalbert', channel: 'chat', reason: 'fix it' }), 'outsider');
    expect(predicate({ comments: [...comments, forged] }).state).toBe('ready');
  });
  it('latest ordinary operator answer supersedes a no-code ruling', () => {
    const ordinary = c('ordinary', core.buildOperatorAnswer({ standDownId: 'stop', actor: 'chalbert', channel: 'chat', reason: 'fix it' }), 'chalbert');
    expect(predicate({ comments: [...comments, ordinary] }).state).toBe('none');
  });
  it('no changes label resumes planning even after a later changes verdict', () => {
    expect(predicate({ comments: [...comments, verdict], labels: ['review:pending'] }).state).toBe('none');
  });
  it('receipt builder and parser preserve the answer and exact head', () => {
    const body = core.NO_CODE_REARM_RECEIPT('answer', HEAD);
    expect(core.parseNoCodeRearmReceipt(c('r', body))).toEqual({ answerId: 'answer', head: HEAD });
    expect(() => core.NO_CODE_REARM_RECEIPT('answer\n', HEAD)).toThrow();
    expect(() => core.NO_CODE_REARM_RECEIPT('answer', HEAD + '\n')).toThrow();
    expect(core.parseNoCodeRearmReceipt(c('r', body, 'outsider'))).toBe(null);
  });
  it.each([null, {}, { disposition: 'rearm-review', noCodeOwed: false }, { disposition: 'close-superseded', noCodeOwed: true }])('requires the exact no-code disposition: %j', value => expect(core.isNoCodeRearmAnswer(value)).toBe(false));
  it('ordinary answer is none', () => expect(predicate({ comments: comments.slice(0, -1) }).state).toBe('none'));
  it('newline answer id is refused and never planned', () => {
    expect(() => core.buildOperatorAnswer({ standDownId: 'stop\n', actor: 'chalbert', channel: 'chat', reason: 'x' })).toThrow(/invalid/);
    expect(plan([...comments.slice(0, -1), { ...answer, id: 'answer\n' }]).dispatch).toEqual([]);
  });
});

describe('no-code rearm planning', () => {
  it('after a spent rearm, a later changes verdict resumes ordinary fix planning', () => {
    const thread = [...comments, c('receipt', core.NO_CODE_REARM_RECEIPT('answer', HEAD))];
    expect(plan(thread, { labels: ['review:pending'] }).dispatch.filter(d => d.kind === 'fix')).toEqual([]);
    thread.push(c('rearmed', REARM_COMMENT_MARKER), { ...verdict, id: 'new-verdict' });
    const result = plan(thread);
    expect(result.dispatch.map(d => d.kind)).toEqual(['fix']);
    expect(result.refusals.filter(r => r.kind.startsWith('no-code-rearm'))).toEqual([]);
  });
  it('a new push retires the old no-code ruling and resumes ordinary fix planning', () => {
    expect(plan(comments, { headRefOid: 'b'.repeat(40) }).dispatch.map(d => d.kind)).toEqual(['fix']);
  });
  it('a no-code answer dispatches rearm-no-code and zero fix rows', () => {
    const result = plan();
    expect(result.dispatch.map(d => d.kind)).toEqual(['rearm-no-code']);
    expect(result.dispatch[0]).toMatchObject({ answerId: 'answer', expectHead: HEAD });
  });
  it('already-landed content refuses a ready no-code answer without rearm-no-code', () => {
    expect(predicate()).toMatchObject({ state: 'ready', answerId: 'answer' });
    const result = plan(comments, { alreadyLandedInMain: { carrierPr: 43 } });
    expect(result.dispatch.filter(d => d.kind === 'rearm-no-code')).toEqual([]);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'already-landed', carrierPr: 43 }));
  });
  it('unresolved operator send-back wins over a ready no-code answer without rearm-no-code', () => {
    const sendBack = c('send-back', `🔁 review — changes requested\n\nRecorded by chalbert via chat.\n\nFix the outstanding defect at head \`${'b'.repeat(40)}\`.`, 'chalbert');
    const thread = [sendBack, ...comments];
    expect(predicate({ comments: thread })).toMatchObject({ state: 'ready', answerId: 'answer' });
    const result = plan(thread);
    expect(result.dispatch.filter(d => d.kind === 'rearm-no-code')).toEqual([]);
    expect(result.dispatch).toHaveLength(1);
    expect(result.dispatch[0]).toMatchObject({ kind: 'fix', mode: 'ruling-not-addressed',
      rulingNotAddressed: { items: [expect.objectContaining({ id: 'send-back' })] } });
  });
  it('fix-begin after answer retires the ruling and resumes ordinary fix planning', () => {
    const result = plan([...comments, begin]);
    expect(result.dispatch.map(d => d.kind)).toEqual(['fix']);
    expect(result.refusals.filter(r => r.kind.startsWith('no-code-rearm'))).toEqual([]);
  });
  it('ticks 2 and 3 plan nothing, spent plus one note while changes stands', () => {
    const thread = [...comments, c('receipt', core.NO_CODE_REARM_RECEIPT('answer', HEAD))];
    let posted = 0;
    for (const tick of [2, 3]) {
      const result = plan(thread);
      expect(result.dispatch, `tick ${tick}`).toEqual([]);
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'no-code-rearm-spent' }));
      expect(result.notes).toHaveLength(1);
      expect(result.notes[0].text).toContain('a fresh answer is needed');
      const note = planNoteComment(result.notes[0], thread);
      if (!note.alreadyPosted) { thread.push(c('note', note.body)); posted++; }
    }
    expect(posted).toBe(1);
  });
  it.each([100, 101])('a %i-row incomplete snapshot cannot miss the 101st-comment answer', count => {
    const thread = Array.from({ length: count }, (_, i) => c(`f${i}`, 'filler'));
    const result = plan(thread);
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'thread-truncated' }));
  });
});

import { describe, expect, it, vi } from 'vitest';
import { buildStandDownComment } from '../stand-down.mjs';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';
import { parseOperatorAnswer } from '../stand-down-answer-core.mjs';
import { decideEmptyFixRound } from '../rearm-review.mjs';
import { classifyNoCodeOwedRearm, enrichPrsWithNoCodeOwedRearm } from '../stand-down-no-code-owed.mjs';

const head = 'a'.repeat(40);
const author = { login: AUTOMATION_LOGINS[0] };
const verdict = { id: 'V1', author, createdAt: '2026-11-24T20:49:00Z', body: '🔁 review — changes requested\n\nfindings' };
const begin = (sha = head) => ({ id: 'B1', author, createdAt: '2026-11-24T21:37:00Z',
  body: `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${sha.slice(0, 9)}\`\n<!-- fix-claim who=fix-1 -->` });
const stand = (detail = 'no code defect to repair; a human must re-verdict', reason = 'needs-judgment', a = author) =>
  ({ id: 'SD1', author: a, createdAt: '2026-11-24T21:39:00Z', body: buildStandDownComment({ reason, detail }) });
const labels = (...n) => n.map(name => ({ name }));
const mkPr = (o = {}) => ({ number: 7448, headRefOid: head, labels: labels('review:changes'),
  comments: [verdict, begin(), stand()], ...o });
const run = (name, conclusion = 'SUCCESS', id = 1) => ({ id, name, app: { id: 15368 }, head_sha: head, status: 'completed', conclusion,
  completed_at: '2026-11-24T21:00:00Z' });
const names = ['test', 'smoke', 'merge-gate'];
const bindings = names.map(context => ({ context, integration_id: 15368 }));
const green = () => [run('test', 'SUCCESS', 1), run('smoke', 'SUCCESS', 2), run('merge-gate', 'FAILURE', 3)];
const args = (o = {}) => ({ pr: mkPr(), requiredChecks: names, requiredCheckBindings: bindings,
  checks: { head, complete: true, runs: green() }, ...o });

describe('no-code-owed stand-down: one mechanical re-review of the same head', () => {
  it('plans exactly one rearm-review answer that the rearm guard honours', () => {
    const d = classifyNoCodeOwedRearm(args());
    expect(d.action).toBe('rearm-answer');
    const answer = { id: 'A1', author, createdAt: '2026-11-24T21:41:00Z', body: d.body };
    expect(parseOperatorAnswer(answer)).toMatchObject({ disposition: 'rearm-review', noCodeOwed: true, standDownId: 'SD1' });
    const pr = mkPr();
    expect(decideEmptyFixRound({ comments: pr.comments, liveHead: head }).empty).toBe(true);
    expect(decideEmptyFixRound({ comments: [...pr.comments, answer], liveHead: head }).empty).toBe(false);
  });

  it('a second attempt on the same head is refused', () => {
    const d = classifyNoCodeOwedRearm(args());
    const prior = { id: 'A1', author, createdAt: '2026-11-24T21:41:00Z', body: d.body };
    const again = [verdict, begin(), stand(), prior, { ...stand(), id: 'SD2', createdAt: '2026-11-24T22:00:00Z' }];
    expect(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: again }) })).action).toBe('hold');
  });

  it('never fires when code is owed (head moved since the fix began)', () => {
    const pr = mkPr({ comments: [verdict, begin('b'.repeat(40)), stand()] });
    expect(classifyNoCodeOwedRearm(args({ pr })).action).toBe('hold');
  });

  it.each(['red-team:blocked', 'red-team:pending'])('holds on %s', (l) => {
    expect(classifyNoCodeOwedRearm(args({ pr: mkPr({ labels: labels('review:changes', l) }) })).action).toBe('hold');
  });

  it('holds without a review:changes hold', () => {
    expect(classifyNoCodeOwedRearm(args({ pr: mkPr({ labels: labels('review:accepted') }) })).action).toBe('hold');
  });

  it('holds on a genuine required-check failure, a missing check, or wrong-app evidence', () => {
    const fail = green().map(r => r.name === 'test' ? { ...r, conclusion: 'FAILURE' } : r);
    expect(classifyNoCodeOwedRearm(args({ checks: { head, complete: true, runs: fail } })).action).toBe('hold');
    expect(classifyNoCodeOwedRearm(args({ checks: { head, complete: true, runs: green().slice(0, 1) } })).action).toBe('hold');
    const wrong = green().map(r => ({ ...r, app: { id: 1 } }));
    expect(classifyNoCodeOwedRearm(args({ checks: { head, complete: true, runs: wrong } })).action).toBe('hold');
    expect(classifyNoCodeOwedRearm(args({ checks: { head: 'c'.repeat(40), complete: true, runs: green() } })).action).toBe('hold');
  });

  it('holds when the stand-down is not a no-code-defect judgment, or is untrusted', () => {
    expect(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: [verdict, begin(), stand('which design?')] }) })).action).toBe('hold');
    expect(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: [verdict, begin(), stand(undefined, 'gate-red')] }) })).action).toBe('hold');
    expect(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: [verdict, begin(), stand(undefined, 'needs-judgment', { login: 'mallory' })] }) })).action).toBe('hold');
  });
});

describe('enrichPrsWithNoCodeOwedRearm', () => {
  const deps = (o = {}) => ({ repo: 'o/r', requiredChecks: names, readBindings: () => bindings,
    readComments: () => mkPr().comments, readHead: () => head,
    readChecks: () => ({ head, complete: true, runs: green() }), reserve: vi.fn(() => true),
    post: vi.fn(({ body }) => ({ id: 'A1', author, body })), log: () => {}, ...o });

  it('posts once, then the answer is in the thread', () => {
    const d = deps();
    const out = enrichPrsWithNoCodeOwedRearm([mkPr()], d);
    expect(d.post).toHaveBeenCalledTimes(1);
    expect(out[0].comments.at(-1).id).toBe('A1');
  });

  it('does not post when the reservation exists or the head moved', () => {
    const d = deps({ reserve: vi.fn(() => false) });
    enrichPrsWithNoCodeOwedRearm([mkPr()], d);
    expect(d.post).not.toHaveBeenCalled();
    const e = deps({ readHead: () => 'd'.repeat(40) });
    enrichPrsWithNoCodeOwedRearm([mkPr()], e);
    expect(e.post).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { buildStandDownComment, standDownComments } from '../stand-down.mjs';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';
import { parseOperatorAnswer, latestOperatorAnswer, latestOperatorAnswerAt } from '../stand-down-answer-core.mjs';
import { buildNoChangeComment, decideEmptyFixRound, rearmWindow } from '../rearm-review.mjs';
import { countUnresolvedStandDowns } from '../reconcile-core.mjs';
import { classifyNoCodeOwedRearm, enrichPrsWithNoCodeOwedRearm } from '../stand-down-no-code-owed.mjs';
import { buildAutoRearmRequest, parseAutoRearmRequest, pendingAutoRearmRequest, isGateOnlyChangesVerdict } from '../auto-rearm-request.mjs';

const head = 'a'.repeat(40);
const author = { login: AUTOMATION_LOGINS[0] };
const human = { login: 'someone-else' };
const gateVerdictBody = '🔁 review — changes requested\n\nRecorded by loop-console operator.\n\nrequired check "merge-gate" FAILURE';
const verdict = { id: 'V1', author, body: gateVerdictBody };
const begin = (sha = head) => ({ id: 'B1', author,
  body: `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${sha.slice(0, 9)}\`\n<!-- fix-claim who=fix-1 -->` });
const note = (sha = head) => ({ id: 'N1', author, body: buildNoChangeComment({ actor: 'conveyor fix agent', since: sha.slice(0, 9) }) });
const stand = (id = 'SD1') => ({ id, author, body: buildStandDownComment({ reason: 'needs-judgment', detail: 'whatever the fixer wrote' }) });
const thread = (...extra) => [verdict, begin(), note(), stand(), ...extra];
const labels = (...n) => n.map(name => ({ name }));
const JOB = 55;
const rollup = [{ name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: `https://github.com/o/r/actions/runs/1/job/${JOB}` }];
const mkPr = (o = {}) => ({ number: 7448, headRefOid: head, labels: labels('review:changes'), comments: thread(), statusCheckRollup: rollup, ...o });
const run = (name, conclusion = 'SUCCESS', id = 1, o = {}) => ({ id, name, app: { id: 15368 }, check_suite: { id: 900 }, head_sha: head,
  status: 'completed', conclusion, completed_at: '2026-11-24T21:00:00Z', details_url: `https://github.com/o/r/actions/runs/1/job/${JOB + id}`, ...o });
const names = ['test', 'merge-gate'];
const bindings = names.map(context => ({ context, integration_id: 15368 }));
const gateRun = (o = {}) => run('merge-gate', 'FAILURE', 3, { details_url: `https://github.com/o/r/actions/runs/1/job/${JOB}`, ...o });
const checks = (runs = [run('test', 'SUCCESS', 1), gateRun()]) => ({ head, complete: true, runs });
const okVerdict = (o = {}) => ({ num: 7448, ok: false, head_sha: head, results: [{ status: 'hold', id: 'review-hold-labels', reason: 'labels: review:changes' }], ...o });
const args = (o = {}) => ({ pr: mkPr(), requiredChecks: names, requiredCheckBindings: bindings, checks: checks(), rosterSource: 'live',
  gate: { jobId: JOB, verdict: okVerdict() }, ...o });
const isHold = d => d.action === 'hold';

describe('auto-rearm request: a separate recover-class record', () => {
  const body = buildAutoRearmRequest({ standDownId: 'SD1', head, reason: 'why' });
  const req = { id: 'R1', author, body };

  it('is ignored by parseOperatorAnswer and every operator-answer reader', () => {
    expect(parseOperatorAnswer(req)).toBeNull();
    const base = thread();
    const withReq = [...base, req];
    expect(latestOperatorAnswer(withReq)).toEqual(latestOperatorAnswer(base));
    // fixers see no ruling and the load-flake accounting timestamp never moves
    expect(latestOperatorAnswer(withReq)).toBeNull();
    expect(latestOperatorAnswerAt(withReq)).toEqual(latestOperatorAnswerAt(base));
  });

  it('never resolves the stand-down: the unresolved count is unchanged', () => {
    const o = { headRefOid: head };
    expect(countUnresolvedStandDowns(thread(req), o)).toBe(countUnresolvedStandDowns(thread(), o));
    expect(countUnresolvedStandDowns(thread(req), o)).toBe(1);
  });

  it('never changes the rearm guard (no fixer path, no unchanged-head refusal change, no load-flake accounting)', () => {
    expect(decideEmptyFixRound({ comments: thread(req), liveHead: head })).toEqual(decideEmptyFixRound({ comments: thread(), liveHead: head }));
    expect(decideEmptyFixRound({ comments: thread(req), liveHead: head }).empty).toBe(true);
    const w1 = rearmWindow(thread(req)); const w0 = rearmWindow(thread());
    expect({ ...w1, wouldHonour: 0 }).toEqual({ ...w0, wouldHonour: 0 });
  });

  it('is accepted only from the automation identity', () => {
    expect(parseAutoRearmRequest(req)).toEqual({ standDownId: 'SD1', head });
    expect(parseAutoRearmRequest({ ...req, author: human })).toBeNull();
    expect(parseAutoRearmRequest({ ...req, author: undefined, viewerDidAuthor: true })).toBeNull();
    expect(pendingAutoRearmRequest(thread({ ...req, author: human }), head)).toBeNull();
    expect(pendingAutoRearmRequest(thread(req), head)?.standDownId).toBe('SD1');
  });

  it('is pending once per head and consumed by a later verdict', () => {
    expect(pendingAutoRearmRequest(thread(req, { ...req, id: 'R2' }), head)?.commentId).toBe('R1');
    expect(pendingAutoRearmRequest(thread(req, { id: 'V2', author, body: '✅ review — accepted\n\nok' }), head)).toBeNull();
    expect(pendingAutoRearmRequest(thread(req), 'b'.repeat(40))).toBeNull();
    const other = { id: 'R9', author, body: buildAutoRearmRequest({ standDownId: 'OLD', head, reason: 'x' }) };
    expect(pendingAutoRearmRequest(thread(other), head)).toBeNull();
  });
});

describe('qualification: structured no-code signal only', () => {
  it('requests one review for the live shape', () => {
    const d = classifyNoCodeOwedRearm(args());
    expect(d.action).toBe('request-review');
    expect(parseOperatorAnswer({ author, body: d.body })).toBeNull();
    expect(parseAutoRearmRequest({ author, body: d.body })).toMatchObject({ standDownId: 'SD1', head });
  });

  it('a reviewer finding in the verdict disqualifies, even with a fix-still-owed note', () => {
    const real = { id: 'V1', author, body: '🔁 review — changes requested\n\n- src/x.mjs: the null case is unhandled' };
    expect(isGateOnlyChangesVerdict([real])).toBe(false);
    expect(isHold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: [real, begin(), note(), stand()] }) })))).toBe(true);
    const mixed = { ...verdict, body: `${gateVerdictBody}\n- src/x.mjs: a bug` };
    expect(isHold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: [mixed, begin(), note(), stand()] }) })))).toBe(true);
  });

  it('code owed (head moved) never qualifies', () => {
    expect(isHold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: [verdict, begin('b'.repeat(40)), note('b'.repeat(40)), stand()] }) })))).toBe(true);
  });

  it('a second request on the same head is refused', () => {
    const r = { id: 'R1', author, body: buildAutoRearmRequest({ standDownId: 'SD1', head, reason: 'x' }) };
    expect(isHold(classifyNoCodeOwedRearm(args({ pr: mkPr({ comments: thread(r) }) })))).toBe(true);
  });

  it('merge-gate is bound to the CURRENT check run', () => {
    expect(isHold(classifyNoCodeOwedRearm(args({ checks: checks([run('test', 'SUCCESS', 1)]) })))).toBe(true); // missing
    expect(isHold(classifyNoCodeOwedRearm(args({ checks: checks([run('test', 'SUCCESS', 1), gateRun({ status: 'in_progress', conclusion: null, completed_at: null })]) })))).toBe(true); // pending
    expect(isHold(classifyNoCodeOwedRearm(args({ gate: { jobId: 999, verdict: okVerdict() } })))).toBe(true); // another job's verdict
    expect(isHold(classifyNoCodeOwedRearm(args({ checks: checks([run('test', 'SUCCESS', 1), gateRun({ details_url: 'https://github.com/o/r/actions/runs/1/job/77' })]) })))).toBe(true);
    expect(isHold(classifyNoCodeOwedRearm(args({ gate: null })))).toBe(true);
  });

  it('a human-review hold or any other blocking hold disqualifies', () => {
    const extra = id => okVerdict({ results: [{ status: 'hold', id: 'review-hold-labels', reason: 'labels: review:changes' }, { status: 'hold', id, reason: 'x' }] });
    for (const id of ['test-gaming', 'review-acceptance', 'red-main-freeze']) {
      expect(isHold(classifyNoCodeOwedRearm(args({ gate: { jobId: JOB, verdict: extra(id) } })))).toBe(true);
    }
    expect(isHold(classifyNoCodeOwedRearm(args({ pr: mkPr({ labels: labels('review:changes', 'review:human') }) })))).toBe(true);
    expect(isHold(classifyNoCodeOwedRearm(args({ pr: mkPr({ labels: labels('review:changes', 'red-team:blocked') }) })))).toBe(true);
  });

  it('a human-only workflow-touch hold alone qualifies; with a test finding it does not', () => {
    const wf = { status: 'hold', id: 'review-acceptance', reason: 'human-only: the diff at aaaaaaaaa touches .github/workflows/x.yml — only a clear-human ceremony' };
    expect(classifyNoCodeOwedRearm(args({ gate: { jobId: JOB, verdict: okVerdict({ results: [wf] }) } })).action).toBe('request-review');
    const both = okVerdict({ results: [wf, { status: 'hold', id: 'test-gaming', reason: 'tests weakened' }] });
    expect(isHold(classifyNoCodeOwedRearm(args({ gate: { jobId: JOB, verdict: both } })))).toBe(true);
  });

  it('a stale or fallback roster disqualifies; a red code check disqualifies', () => {
    for (const rosterSource of ['stale-cache', 'fallback', 'declared', 'unavailable', undefined]) {
      expect(isHold(classifyNoCodeOwedRearm(args({ rosterSource })))).toBe(true);
    }
    expect(isHold(classifyNoCodeOwedRearm(args({ checks: checks([run('test', 'FAILURE', 1), gateRun()]) })))).toBe(true);
  });
});

describe('writer: re-reads after the final check read, immediately before the post', () => {
  const mk = (over = {}) => {
    const calls = []; let posted = 0; const reads = { n: 0 };
    const state = () => ({ headRefOid: head, labels: labels('review:changes'), statusCheckRollup: rollup });
    const deps = {
      repo: 'o/r', readBindings: () => bindings, readComments: () => thread(), readState: () => { reads.n += 1; return state(); },
      readRoster: () => ({ checks: names, source: 'live' }), readChecks: () => { calls.push('checks'); return checks(); },
      readVerdict: () => okVerdict(), reserve: () => true, log: () => {},
      post: ({ body }) => { posted += 1; calls.push('post'); return { id: 'R1', author, body }; }, ...over };
    return { deps, calls, posted: () => posted, reads };
  };
  it('posts exactly once and appends the request to the returned thread', () => {
    const { deps, calls, posted } = mk();
    const [out] = enrichPrsWithNoCodeOwedRearm([mkPr()], deps);
    expect(posted()).toBe(1);
    expect(calls).toEqual(['checks', 'post']);
    expect(pendingAutoRearmRequest(out.comments, head)).toBeTruthy();
  });
  it('a head change, new label, new comment or roster change during/after the check read vetoes the post', () => {
    for (const mutate of ['head', 'label', 'comment', 'roster']) {
      let phase = 0;
      const m = mk({
        readChecks: () => { phase = 1; return checks(); },
        readState: () => (phase && mutate === 'head' ? { headRefOid: 'c'.repeat(40), labels: labels('review:changes'), statusCheckRollup: rollup }
          : phase && mutate === 'label' ? { headRefOid: head, labels: labels('review:changes', 'red-team:blocked'), statusCheckRollup: rollup }
          : { headRefOid: head, labels: labels('review:changes'), statusCheckRollup: rollup }),
        readComments: () => (phase && mutate === 'comment' ? thread({ id: 'X', author: human, body: 'hi' }) : thread()),
        readRoster: () => (phase && mutate === 'roster' ? { checks: ['test'], source: 'live' } : { checks: names, source: 'live' }),
      });
      enrichPrsWithNoCodeOwedRearm([mkPr()], m.deps);
      expect(m.posted(), mutate).toBe(0);
    }
  });
  it('a stale roster or a refused reservation posts nothing', () => {
    const a = mk({ readRoster: () => ({ checks: names, source: 'stale-cache' }) });
    enrichPrsWithNoCodeOwedRearm([mkPr()], a.deps);
    expect(a.posted()).toBe(0);
    const b = mk({ reserve: () => false });
    enrichPrsWithNoCodeOwedRearm([mkPr()], b.deps);
    expect(b.posted()).toBe(0);
  });
});

it('standDownComments still sees the stand-down (sanity)', () => {
  expect(standDownComments(thread()).length).toBe(1);
});

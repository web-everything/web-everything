/**
 * @file no-code-rearm.test.mjs — STANDDOWN-EMPTY-ROUND (D2). The orchestrator's `rearm-review --no-code-owed` ruling
 *   is executed ONCE by the conveyor and never handed to a fixer (live #7448, #7451: the answered stand-down fell
 *   through to fix dispatch, the new fixer posted a fix-begin on the same head, and rearm-review refused again).
 *   Active rulings must plan zero fixers and at most one `rearm-no-code`; stale rulings resume ordinary work.
 */
import { describe, it, expect } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { reconcileHolds } from '../../operations/land-advance-items-io.mjs';
import { buildOperatorAnswer, isNoCodeRearmAnswer, isNoCodeRearmExecuted, latestOperatorAnswerCommentId, parseOperatorAnswer, noCodeRearmState, noCodeRearmGuard } from '../stand-down-answer-core.mjs';
import { runStandDownAnswer } from '../stand-down-answer.mjs';
import { decideSetLabel, runReviewLabelCli } from '../../review-set-label.mjs';
import { buildStandDownComment } from '../stand-down.mjs';
import { buildNoChangeComment, buildRearmComment, decideRearm, hasInvalidArgs } from '../rearm-review.mjs';
import { runReconcilePromoteDraftDispatch, defaultRearmNoCode } from '../../operations/promote-draft-pr-dispatch.mjs';
import { replayNoCodeHandoff, replayOrphanRearm } from '../soak/breaks/no-code-rearm-handoff.mjs';
import { NOTE_COMMENT_MARKER, planNoteComment } from '../reconcile-note-comment.mjs';
import { NO_CODE_REARM_TRAILER, REARM_COMMENT_MARKER, isFixRoundRearmComment } from '../rearm-round-count.mjs';

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
const workRows = p => p.dispatch.map(({ operatorAnswer: _ruling, ...row }) => row);
const noRulingPayload = p => p.dispatch.filter(row => row.kind !== 'rearm-no-code').forEach(row => {
  expect(row).not.toHaveProperty('operatorAnswer');
});
const receipt = (state, head = HEAD, answerId = 'IC_200') => ({ id: `IC_${state}`, author: BOT,
  body: `<!-- no-code-rearm ${state === 'failed' ? 'attempt' : 'state'}=${state} answer=${answerId} head=${head} -->` });

describe('review recovery regressions', () => {
  it.each([
    { flags: ['--no-code-rearm=false'] }, { flags: ['--no-code-rearm-typo'] },
    { flags: ['--no-code-rearm', '--no-code-rearm'] },
  ])('rejects malformed no-code opt-in $flags in both CLI layers before IO', ({ flags }) => {
    expect(hasInvalidArgs(['7448', `--expect-head=${HEAD}`, ...flags])).toBe(true);
    const exit = process.exit;
    const output = [];
    process.exit = code => { throw new Error(`exit ${code}`); };
    try {
      expect(() => runReviewLabelCli({ fixedTo: 'rearm',
        argv: ['7448', '--repo=o/r', `--expect-head=${HEAD}`, ...flags],
        emit: line => output.push(line), provider: new Proxy({}, { get() { throw new Error('unexpected IO'); } }),
      })).toThrow('exit 2');
    } finally { process.exit = exit; }
    expect(output.join('')).toContain('--no-code-rearm requires a pinned re-arm');
  });
  it('requires a head pin for the no-code opt-in before IO', () => {
    const exit = process.exit;
    const output = [];
    process.exit = code => { throw new Error(`exit ${code}`); };
    try {
      expect(() => runReviewLabelCli({ fixedTo: 'rearm', argv: ['7448', '--repo=o/r', '--no-code-rearm'],
        emit: line => output.push(line), provider: new Proxy({}, { get() { throw new Error('unexpected IO'); } }),
      })).toThrow('exit 2');
    } finally { process.exit = exit; }
    expect(output.join('')).toContain('--no-code-rearm requires a pinned re-arm');
  });
  it.each(['red-team:pending', 'red-team:blocked'])('orphan guard argv still rearms a repaired PR carrying %s', label => {
    const result = replayOrphanRearm(label);
    expect(result.labels).toEqual(['review:pending']);
    expect(result.writes).toHaveLength(1);
  });
  it.each([false, true])('successful handoff publishes no new decision ask (human=%s)', human => {
    const { second, snapshot } = replayNoCodeHandoff({ human });
    expect(second.notes.filter(note => note.kind.startsWith('no-code-rearm-'))).toEqual([]);
    const asks = second.notes.map(note => planNoteComment(note, snapshot.comments))
      .filter(note => !note.alreadyPosted && !note.suppressed && note.body.startsWith(NOTE_COMMENT_MARKER));
    expect(asks).toEqual([]);
    noRulingPayload(second);
  });
  it.each([false, true])('retires waived structured findings after the real label writer handoff (human=%s)', human => {
    const { first, second, snapshot } = replayNoCodeHandoff({ human });
    expect(first.dispatch.map(d => d.kind)).toEqual(['rearm-no-code']);
    expect(first.refusals).toEqual([]);
    expect(second.dispatch.map(d => d.kind)).toEqual(['ci-heal']);
    noRulingPayload(second);
    expect(second.dispatch[0].joinedInputs?.reviewFindings ?? []).toEqual([]);
    expect(snapshot.labels.some(l => l.name === 'review:human')).toBe(human);
    expect(snapshot.labels.some(l => l.name === 'review:pending')).toBe(!human);
  });
  it.each([4, 5, 6])('no-code handoff preserves %s spent rounds and review eligibility at the cap', rounds => {
    const { first, second, attempts } = replayNoCodeHandoff({ rounds, red: false });
    expect(first.dispatch.map(d => d.kind)).toEqual(['rearm-no-code']);
    expect(first.refusals).toEqual([]);
    expect(attempts).toBe(rounds);
    expect(second.dispatch.map(d => d.kind)).toEqual(rounds <= 5 ? ['review'] : []);
    expect(second.refusals.some(r => r.kind === 'cap-exhausted')).toBe(rounds > 5);
  });
  it('the shared writer retains the no-code exemption when the initial empty-round read fails', () => {
    const { attempts, second } = replayNoCodeHandoff({ rounds: 5, red: false, guardUnreadable: true });
    expect(attempts).toBe(5);
    expect(second.dispatch.map(d => d.kind)).toEqual(['review']);
  });
  it.each([
    ['later fix claim', s => s.comments.push(begin('IC_later'))],
    ['later verdict', s => s.comments.push({ ...s.comments[0], id: 'IC_later' })],
    ['wrong-head receipts', s => { s.comments = s.comments.filter(c => !c.body.startsWith(REARM_COMMENT_MARKER))
      .map(c => c.body.startsWith('<!-- no-code-rearm ') ? { ...c, body: c.body.replace(HEAD, 'b'.repeat(40)) } : c); }],
    ...['review:changes', 'red-team:blocked', 'red-team:pending'].map(name => [name, s => s.labels.push({ name })]),
  ])('human hold still joins review findings after %s invalidates the handoff', (_why, mutate) => {
    const { snapshot, planNext } = replayNoCodeHandoff({ human: true });
    mutate(snapshot);
    const next = planNext();
    noRulingPayload(next);
    // review:changes with a spent ruling is an operator hold; a later verdict/claim or security label
    // invalidates the waiver and resumes the ordinary fixer policy.
    if (_why === 'review:changes') expect(next.dispatch).toEqual([]);
    else expect(next.dispatch).toContainEqual(expect.objectContaining({ kind: 'fix',
      joinedInputs: expect.objectContaining({ reviewFindings: [expect.stringContaining('Repair required.')] }) }));
  });
  it.each([
    ['missing thread', null, HEAD],
    ['missing head', base, undefined],
    ['moved head', base, 'b'.repeat(40)],
    ['plain rearm answer', [...base.slice(0, -1), answer({ noCodeOwed: false })], HEAD],
    ['later claim', [...base, begin('IC_later')], HEAD],
    ['unparseable claim', [...base, { ...begin('IC_bad'), body: '🔒 conveyor fix-begin — fix claim held' }], HEAD],
    ['later verdict', [...base, verdict], HEAD],
    ['untrusted answer', [...base.slice(0, -1), { ...answer(), author: { login: 'outsider' } }], HEAD],
    ['ignored answer', [...base, answer({}, 'IC_ignored')], HEAD],
  ])('no-code round exemption refuses %s evidence', (_why, comments, headSha) => {
    const body = buildRearmComment({ actor: 'conveyor (operator no-code ruling IC_200)', decision: {}, comments, headSha });
    expect(isFixRoundRearmComment({ author: BOT, body })).toBe(true);
  });
  it('normalizes REST comment identities for the head-bound no-code round exemption', () => {
    const comments = base.map(({ author, id, ...c }) => ({ ...c, user: author, node_id: id, id: 123 }));
    const body = buildRearmComment({ actor: 'conveyor', decision: {}, comments, headSha: HEAD });
    expect(isFixRoundRearmComment({ author: BOT, body })).toBe(false);
  });
  it.each([`> ${NO_CODE_REARM_TRAILER}`, `quoted ${NO_CODE_REARM_TRAILER}`, ` ${NO_CODE_REARM_TRAILER}`])('quoted exemption %s still counts a repair round', marker => {
    expect(isFixRoundRearmComment({ author: BOT, body: `${REARM_COMMENT_MARKER}\n\n${marker}` })).toBe(true);
  });
  it.each([
    [{ headRefOid: 'abc1234' }, 'held', 'the live head is not a full sha'],
    [{ labels: [{ id: 1 }] }, 'held', 'the label list is incomplete'],
    [{ comments: null }, 'held', 'the comment thread is unreadable'],
    [{ labels: [{ name: 'review:pending' }] }, 'stale', 'the PR no longer carries review:changes'],
    ...['red-team:blocked', 'red-team:pending'].map(name => [
      { labels: [{ name: 'review:changes' }, { name }] }, 'stale', 'a red-team label stands, a fix or security verdict is owed']),
    [{ comments: [...base, { ...begin('IC_bad'), body: '🔒 conveyor fix-begin — fix claim held\nno sha' }] }, 'stale', 'a fix claim in the thread is unparseable'],
    [{ comments: [...base, begin('IC_210')] }, 'stale', 'a fix-begin was posted after the ruling'],
    [{ comments: [...base, { ...verdict, id: 'IC_211' }] }, 'stale', 'the rearm window does not honour this answer (a newer verdict or stand-down stands)'],
  ])('names the exact guard reason for %j (%s)', (over, disposition, why) => {
    expect(noCodeRearmGuard(pr(over))[disposition]).toBe(why);
    if (disposition === 'held') expect(noCodeRearmGuard(pr())).toEqual({ held: null, stale: null });
  });
  it.each([7448, 7451])('incident #%s ruling rearms once with no refusals, then resumes required-check CI healing', number => {
    // Incident IDs and ruling shape come from the review context. The red required-check row is a
    // deterministic reconstruction: the launcher's offline pack contains no captured incident rollups.
    const snapshot = pr({ number, rowsComplete: true, rowsHead: HEAD,
      statusCheckRollup: [{ name: 'merge-gate', status: 'completed', conclusion: 'failure' }] });
    const tick = () => planReconcile({ prs: [snapshot], agents: [], durableCounts: {}, requiredChecks: ['merge-gate'] });
    const first = tick();
    expect(first.dispatch).toEqual([expect.objectContaining({ kind: 'rearm-no-code', prNumber: number })]);
    expect(first.refusals).toEqual([]);
    defaultRearmNoCode({ ...first.dispatch[0], repoSlug: 'o/r', postComment: ({ comment }) => {
      snapshot.comments = [...snapshot.comments, { author: BOT, body: comment }];
    }, run: () => { snapshot.labels = [{ name: 'review:pending' }]; return { status: 0 }; } });
    const second = tick();
    expect(second.dispatch).toEqual([expect.objectContaining({ kind: 'ci-heal', prNumber: number })]);
    noRulingPayload(second);
    expect(second.refusals).toEqual([]);
  });
  it.each([
    ['intent', receipt('intent')], ['confirm', receipt('confirm')], ['failed', receipt('failed')],
    ['legacy rearm', { author: BOT, body: buildRearmComment({ actor: 'x', decision: decideRearm({ currentLabels: ['review:changes'] }) }) }],
    ['legacy empty round', { author: BOT, body: buildNoChangeComment({ actor: 'x', since: HEAD }) }],
  ])('%s on review:changes waits without fix or CI healing and accepts a fresh CLI answer', (_state, spent) => {
    const snapshot = pr({ comments: [...base, spent], rowsComplete: true, rowsHead: HEAD,
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'failure' }] });
    const held = planReconcile({ prs: [snapshot], agents: [], requiredChecks: ['gate'], durableCounts: {} });
    expect(held.dispatch).toEqual([]);
    const args = ['7448', '--repo=web-everything/web-everything', '--actor=chalbert', '--channel=chat',
      '--reason=Retry after checking the live labels', '--disposition=rearm-review', '--no-code-owed'];
    runStandDownAnswer(args, { gh: a => {
      if (a[1] === 'view') return JSON.stringify(snapshot);
      snapshot.comments.push({ id: 'IC_201', author: BOT, body: a[a.indexOf('--body') + 1] });
      return 'posted';
    } });
    expect(parseOperatorAnswer(snapshot.comments.at(-1))).toMatchObject({ supersedes: 'IC_200', head: HEAD });
    expect(kinds(plan({ comments: snapshot.comments }), 'rearm-no-code')).toHaveLength(1);
  });
  it.each([
    ['later fix claim', { comments: [...base, receipt('failed'), begin('IC_210')] }],
    ['newer verdict', { comments: [...base, receipt('failed'), { ...verdict, id: 'IC_211' }] }],
    ['moved head', { headRefOid: 'b'.repeat(40) }],
    ['red-team block', { labels: [{ name: 'review:changes' }, { name: 'red-team:blocked' }] }],
    ['red-team pending', { labels: [{ name: 'review:changes' }, { name: 'red-team:pending' }] }],
    ['label handoff', { labels: [{ name: 'review:pending' }] }],
    ['incomplete labels', { labels: null }],
  ])('retry CLI refuses %s without posting', (_why, over) => {
    const snapshot = pr({ comments: [...base, receipt('failed')], ...over });
    let posts = 0;
    expect(() => runStandDownAnswer(['7448', '--repo=web-everything/web-everything', '--actor=chalbert', '--channel=chat',
      '--reason=Retry', '--disposition=rearm-review', '--no-code-owed'], { gh: a => {
      if (a[1] === 'view') return JSON.stringify(snapshot);
      posts++;
    } })).toThrow();
    expect(posts).toBe(0);
  });
  it('a later ignored answer cannot borrow an earlier honoured answer to authorize rearm', () => {
    const p = plan({ comments: [...base, answer({}, 'IC_201')] });
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
    expect(p.notes).toContainEqual(expect.objectContaining({ kind: 'no-code-rearm-stale' }));
  });
  it('records the live ruling head after a push between fix-begin and the answer', () => {
    const moved = 'b'.repeat(40);
    const snapshot = pr({ headRefOid: moved, comments: base.slice(0, -1) });
    runStandDownAnswer(['7448', '--repo=web-everything/web-everything', '--actor=chalbert', '--channel=chat',
      '--reason=No code owed on the pushed head', '--disposition=rearm-review', '--no-code-owed'], { gh: a => {
      if (a[1] === 'view') return JSON.stringify(snapshot);
      snapshot.comments.push({ id: 'IC_200', author: BOT, body: a[a.indexOf('--body') + 1] });
      return 'posted';
    } });
    expect(parseOperatorAnswer(snapshot.comments.at(-1))).toMatchObject({ head: moved });
    expect(kinds(plan(snapshot), 'rearm-no-code')).toHaveLength(1);
    expect(noCodeRearmState(snapshot.comments, HEAD).applicable).toBe(false);
    expect(noCodeRearmState([...snapshot.comments, receipt('confirm', HEAD)], moved).executed).toBe(false);
  });
  it.each(['red-team:blocked', 'red-team:pending'])('an explicit no-code rearm refuses live %s without removing labels', label => {
    expect(decideSetLabel({ to: 'rearm', currentLabels: ['review:changes', label], noCodeRearm: true }))
      .toMatchObject({ allowed: false, removeLabels: [], reason: expect.stringContaining(label) });
  });
  it.each(['red-team:blocked', 'red-team:pending'])('the shared writer preserves %s arriving between the first read and label write', label => {
    let reads = 0;
    const writes = [];
    const output = [];
    const exit = process.exit;
    process.exit = code => { throw Object.assign(new Error('exit'), { exitCode: code }); };
    try {
      expect(() => runReviewLabelCli({ fixedTo: 'rearm',
        argv: ['7448', '--repo=o/r', `--expect-head=${HEAD}`, '--no-code-rearm', '--actor=conveyor'],
        defaultActor: 'conveyor', usage: 'test', buildComment: () => 'rearm',
        successResult: o => ({ ok: true, ...o }), refusalResult: ({ decision }) => ({ reason: decision.reason }),
        emit: line => output.push(line), appendLedgerVerdict: () => ({ ok: true }),
        provider: {
          readPostingIdentity: () => ({ login: 'web-everything', type: 'User' }),
          readPrState: () => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, comments: [],
            labels: [{ name: 'review:changes' }, ...(reads++ ? [{ name: label }] : [])] }),
          readComments: () => [], readPrReviews: () => [],
          setLabels: () => writes.push('labels'), postComment: () => writes.push('comment'),
        },
      })).toThrow('exit');
    } finally { process.exit = exit; }
    expect(reads).toBeGreaterThan(1);
    expect(output.join('')).toContain(`no-code re-arm refused: ${label} stands`);
    expect(writes).toEqual([]);
  });
  it.each([
    JSON.stringify({ ok: false, reason: 'live head differs from --expect-head' }),
    JSON.stringify({ error: 'live head differs from --expect-head' }),
    `child log\n${JSON.stringify({ error: { message: 'live head differs from --expect-head' } })}\n`,
  ])('reports child stdout refusal JSON ahead of Node warning noise on stderr (%s)', stdout => {
    expect(() => defaultRearmNoCode({ repoSlug: 'o/r', prNumber: 7448, expectHead: HEAD, answerId: 'IC_200',
      postComment: () => {}, run: () => ({ status: 1, stdout,
        stderr: '(node:42) [DEP0040] DeprecationWarning: The punycode module is deprecated.\n' }) }))
      .toThrow('live head differs from --expect-head');
  });
  it.each([{ answerId: '' }, { answerId: 'IC_200\nforged' }, { expectHead: 'abc1234' }, { expectHead: 'g'.repeat(40) }])('bad executor input %j writes nothing', bad => {
    let effects = 0;
    expect(() => defaultRearmNoCode({ repoSlug: 'o/r', prNumber: 7448, expectHead: HEAD, answerId: 'IC_200', ...bad,
      postComment: () => { effects++; }, run: () => { effects++; } })).toThrow('answer id and full head sha');
    expect(effects).toBe(0);
  });
});

describe('round-1 negative regressions', () => {
  it.each(['no-code-rearm-held', 'no-code-rearm-spent', 'no-code-rearm-failed'])('reconcileHolds reports %s', kind => {
    expect(reconcileHolds([{ prNumber: 7448, kind, why: 'check manually' }])['we#7448']).toMatchObject({ kind, holds: ['review', 'fix'] });
  });
  it('already-landed refuses before planning a no-code rearm', () => {
    const p = plan({ alreadyLandedInMain: { carrierPr: 7451 } });
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
    expect(refusalKinds(p)).toContain('already-landed');
  });
  it.each([[[]], [[receipt('confirm')]]])('a newer head ignores the old ruling and receipts (%j)', receipts => {
    const p = plan({ headRefOid: 'a'.repeat(40), comments: [...base, ...receipts] });
    noRulingPayload(p);
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
    expect(refusalKinds(p)).not.toContain('no-code-rearm-spent');
    expect(refusalKinds(p)).not.toContain('no-code-rearm-held');
  });
  it.each(['intent', 'confirm', 'failed'])('%s spends only its answer/head and never blocks ordinary pending-review planning', state => {
    const p = plan({ labels: [{ name: 'review:pending' }], comments: [...base, receipt(state)] });
    const ordinary = plan({ labels: [{ name: 'review:pending' }], comments: [...base, answer({ noCodeOwed: false }, 'IC_201')] });
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
    expect(refusalKinds(p)).not.toContain('no-code-rearm-held');
    expect(workRows(p)).toEqual(workRows(ordinary));
    noRulingPayload(p);
    expect(refusalKinds(p)).toEqual(refusalKinds(ordinary));
    expect(refusalKinds(p)).toContain('already-reviewed-head');
    if (state === 'intent') expect(p.notes).toContainEqual(expect.objectContaining({ kind: 'no-code-rearm-crashed', text: expect.stringMatching(/check.*labels/i) }));
    if (state === 'confirm') expect(p.notes.some(note => note.kind.startsWith('no-code-rearm-'))).toBe(false);
  });
  it('pending labels after an intent still dispatch a review with complete green CI evidence', () => {
    const comments = [ { ...verdict, body: '🔁 review — changes requested' }, ...base.slice(1), receipt('intent') ];
    const p = planReconcile({ prs: [pr({ labels: [{ name: 'review:pending' }], comments,
      rowsComplete: true, rowsHead: HEAD, statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }] })],
      agents: [], requiredChecks: ['gate'], reviewTiming: { startEarly: 'off', startBeforeCi: false, startAfter: 'ci-green' }, durableCounts: {}, now: Date.parse('2026-11-24T22:00:00Z') });
    expect(kinds(p, 'review')).toHaveLength(1);
    expect(refusalKinds(p)).not.toContain('no-code-rearm-held');
    expect(refusalKinds(p)).not.toContain('no-code-rearm-spent');
  });
  it('failed and crash receipts are trusted, answer-bound, and a new answer permits a new attempt', () => {
    expect(isNoCodeRearmExecuted([...base, receipt('failed')], HEAD)).toBe(true);
    expect(isNoCodeRearmExecuted([...base, { ...receipt('intent'), author: { login: 'outsider' } }], HEAD)).toBe(false);
    expect(isNoCodeRearmExecuted([...base, receipt('failed', HEAD, 'IC_other')], HEAD)).toBe(false);
    expect(kinds(plan({ comments: [...base, receipt('failed'), answer({ supersedes: 'IC_200', head: HEAD }, 'IC_201')] }), 'rearm-no-code')).toHaveLength(1);
  });
  it('spent on review:changes waits for an operator rather than dispatching a fixer', () => {
    const p = plan({ comments: [...base, receipt('confirm')] });
    expect(refusalKinds(p)).toContain('no-code-rearm-spent');
    expect(p.dispatch).toEqual([]);
  });
  it.each(['head mismatch', 'read failure', 'timeout', 'failed note post'])('%s persists failure even when the child posts nothing, across two ticks', why => {
    const comments = [...base];
    let calls = 0;
    for (let tick = 0; tick < 2; tick++) {
      for (const entry of kinds(plan({ comments }), 'rearm-no-code')) {
        expect(() => defaultRearmNoCode({ ...entry, repoSlug: 'o/r',
          postComment: ({ comment }) => comments.push({ id: `IC_post${comments.length}`, author: BOT, body: comment }),
          run: () => { calls++; throw new Error(why); },
        })).toThrow(why);
      }
    }
    expect(calls).toBe(1);
    expect(comments.some(c => c.body.includes('attempt=failed'))).toBe(true);
    expect(refusalKinds(plan({ comments }))).toContain('no-code-rearm-failed');
  });
  it('intent precedes child launch, confirm follows it; failed confirm remains spent', () => {
    const comments = [...base];
    const events = [];
    expect(() => defaultRearmNoCode({ repoSlug: 'o/r', prNumber: 7448, expectHead: HEAD, answerId: 'IC_200',
      postComment: ({ comment }) => {
        events.push(comment);
        if (comment.includes('state=confirm')) throw new Error('confirm failed');
        comments.push({ author: BOT, body: comment });
      }, run: () => { events.push('child'); return { status: 0 }; },
    })).toThrow('confirm failed');
    expect(events[0]).toContain('state=intent');
    expect(events[1]).toBe('child');
    expect(events[2]).toContain('state=confirm');
    expect(isNoCodeRearmExecuted(comments, HEAD)).toBe(true);
  });
  it('failed intent post never launches the child and attempts a durable failed receipt', () => {
    const events = [];
    expect(() => defaultRearmNoCode({ repoSlug: 'o/r', prNumber: 7448, expectHead: HEAD, answerId: 'IC_200',
      postComment: ({ comment }) => { events.push(comment); if (comment.includes('state=intent')) throw new Error('intent post failed'); },
      run: () => { throw new Error('must not launch'); },
    })).toThrow('intent post failed');
    expect(events).toHaveLength(2);
    expect(events[1]).toContain('attempt=failed');
  });
  it('a failed failure-note post still leaves the intent spent and asks for a label check', () => {
    const comments = [...base];
    expect(() => defaultRearmNoCode({ repoSlug: 'o/r', prNumber: 7448, expectHead: HEAD, answerId: 'IC_200',
      postComment: ({ comment }) => {
        if (comment.includes('attempt=failed')) throw new Error('comment unavailable');
        comments.push({ author: BOT, body: comment });
      }, run: () => ({ status: null, error: new Error('timeout') }),
    })).toThrow(/person must check labels/);
    const p = plan({ comments });
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
    expect(p.notes.some(n => n.kind === 'no-code-rearm-crashed')).toBe(true);
  });
  it.each(['deadline', 'yield'])('defers remaining rearms after %s changes between children', mode => {
    let calls = 0;
    const r = runReconcilePromoteDraftDispatch({ root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
      reconcile: () => ({ dispatch: [7448, 7449].map(prNumber => ({ kind: 'rearm-no-code', prNumber, expectHead: HEAD, answerId: 'IC_200' })) }),
      rearm: () => { calls++; }, deadlineAt: 10, now: () => mode === 'deadline' && calls ? 11 : 0,
      shouldYield: () => mode === 'yield' && calls > 0,
    });
    expect(calls).toBe(1);
    expect(r.deferred).toContain(7449);
    expect(r.dispatched).toEqual([{ pr: 7448, kind: 'rearm-no-code' }]);
  });
  it('an adoption yield already detected by the promotion loop also defers rearms', () => {
    let probes = 0;
    const r = runReconcilePromoteDraftDispatch({ root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
      provider: { ready: () => {} }, readPrLabels: () => ['review:pending'], readComments: () => [],
      readHeadCheckState: () => ({ state: 'green', counts: {} }), clearAwaitingCi: () => {},
      shouldYield: () => ++probes === 2,
      reconcile: () => ({ dispatch: [
        { kind: 'promote-draft', prNumber: 1, headRefOid: HEAD },
        { kind: 'promote-draft', prNumber: 2, headRefOid: HEAD },
        { kind: 'rearm-no-code', prNumber: 7448, expectHead: HEAD, answerId: 'IC_200' },
      ] }), rearm: () => { throw new Error('must not launch'); },
    });
    expect(r.yieldedForAdoption).toBe(true);
    expect(r.deferred).toEqual([2, 7448]);
    expect(r.refusals.some(r => r.kind === 'rearm-no-code-failed')).toBe(false);
  });
  it('planning that exceeds the deadline still handles the first rearm to prevent starvation', () => {
    let planned = false;
    const r = runReconcilePromoteDraftDispatch({ root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
      deadlineAt: 10, now: () => planned ? 11 : 0,
      reconcile: () => { planned = true; return { dispatch: [{ kind: 'rearm-no-code', prNumber: 7448 }] }; },
      rearm: () => {},
    });
    expect(r.deferred).toEqual([]);
    expect(r.dispatched).toEqual([{ pr: 7448, kind: 'rearm-no-code' }]);
    expect(r.refusals).toEqual([]);
  });
});

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
      expect(p.refusals).toEqual([]);
    }
  });
  it('2: legacy success and empty-round notes suppress rearm and wait for an operator on review:changes', () => {
    for (const body of [buildRearmComment({ actor: 'x', decision: decideRearm({ currentLabels: ['review:changes'] }) }), buildNoChangeComment({ actor: 'x', since: 'abc' })]) {
      const spent = plan({ comments: [...base, { id: 'IC_300', author: BOT, body }] });
      expect(kinds(spent, 'rearm-no-code')).toEqual([]);
      expect(spent.dispatch).toEqual([]);
      expect(refusalKinds(spent)).toContain('no-code-rearm-spent');
      expect(spent.notes.some((n) => n.kind === 'no-code-rearm-spent')).toBe(true);
    }
    const swapped = plan({ labels: [{ name: 'review:pending' }], comments: [...base, { id: 'IC_300', author: BOT, body: buildNoChangeComment({ actor: 'x', since: 'abc' }) }] });
    expect(kinds(swapped, 'rearm-no-code')).toEqual([]);
    expect(refusalKinds(swapped)).not.toContain('no-code-rearm-spent');
    expect(swapped.notes.some(note => note.kind.startsWith('no-code-rearm-'))).toBe(false);
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
  it.each(['red-team:blocked', 'red-team:pending'])('4: %s added after the answer makes the ruling stale and resumes ordinary planning', (label) => {
    const p = plan({ labels: [{ name: 'review:changes' }, { name: label }] });
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
    expect(kinds(p, 'fix')).toHaveLength(1);
    noRulingPayload(p);
    expect(refusalKinds(p)).not.toContain('no-code-rearm-held');
  });
  it('4: a head that is not a full sha or an incomplete label list is held until evidence recovers', () => {
    for (const over of [{ headRefOid: 'abc1234' }, { labels: [{ name: 'review:changes' }, { id: 1 }] }]) {
      const p = plan(over);
      expect(kinds(p, 'rearm-no-code'), JSON.stringify(over)).toEqual([]);
      noFixers(p);
      expect(refusalKinds(p)).toContain('no-code-rearm-held');
      expect(kinds(plan(), 'rearm-no-code')).toHaveLength(1);
    }
  });
  it.each([
    ['a later fix-begin', { comments: [...base, begin('IC_210')] }],
    ['a newer changes verdict', { comments: [...base, { ...verdict, id: 'IC_211' }] }],
    ['a label handoff', { labels: [{ name: 'review:pending' }] }],
    ['a hand acceptance', { labels: [{ name: 'review:accepted' }] }],
  ])('%s makes the ruling stale and resumes the ordinary plan', (_why, over) => {
    const p = plan(over);
    noRulingPayload(p);
    const ordinary = plan({ ...over, comments: [...(over.comments ?? base), answer({ noCodeOwed: false }, 'IC_299')] });
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
    expect(workRows(p)).toEqual(workRows(ordinary));
    expect(refusalKinds(p)).toEqual(refusalKinds(ordinary));
  });
  it('an unparseable fix claim cannot rearm and resumes the ordinary plan', () => {
    const comments = [...base, { ...begin('IC_210'), body: '🔒 conveyor fix-begin — fix claim held\nclaim without a starting sha' }];
    const p = plan({ comments });
    expect(kinds(p, 'rearm-no-code')).toEqual([]);
    noRulingPayload(p);
    expect(workRows(p)).toEqual(workRows(plan({ comments: [...comments, answer({ noCodeOwed: false }, 'IC_299')] })));
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
    defaultRearmNoCode({ repoSlug: 'o/r', prNumber: 7448, expectHead: HEAD, answerId: 'IC_200', postComment: () => {}, run: (cmd, args) => { seen.push([cmd, args]); return { status: 0, stdout: 'ok' }; } });
    expect(seen[0][1].some((a) => a.endsWith('rearm-review.mjs'))).toBe(true);
    expect(seen[0][1]).toEqual(expect.arrayContaining(['7448', '--repo=o/r', `--expect-head=${HEAD}`, '--no-code-rearm', '--actor=conveyor (operator no-code ruling IC_200)']));
    expect(() => defaultRearmNoCode({ repoSlug: 'o/r', prNumber: 1, expectHead: HEAD, answerId: 'IC_200', postComment: () => {}, run: () => ({ status: 1, stderr: 'refused' }) })).toThrow('refused');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestAcceptRecord, isKnownMachineBody } from '../accept-carry-forward.mjs';
import { NO_ASK_NOTE_KINDS } from '../pr-comment-policy.mjs';
import { A, B, C, D, REFERRAL_HEAD, OTHER_REFERRAL_HEAD, accepted, trusted, note as fixtureNote, producedNote,
  recovered, envelope, chain } from './fixtures/accepted-never-started.mjs';
import { buildNoteComment } from '../../conveyor/reconcile-note-comment.mjs';
import { readConfirmedBreaks } from '../red-team-gate.mjs';
import { sweepExhaustedRetry } from '../../conveyor/ci-red-recovery-watch.mjs';
import { buildExhaustedRetrySpentComment } from '../../conveyor/exhausted-retry.mjs';

// Pin policy at the IO boundary, never consult the checkout or operator preferences.
vi.mock('../red-team-gate.mjs', async original => ({ ...await original(), readConfirmedBreaks: vi.fn(() => ({
  value: { broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' },
})) }));
afterEach(() => vi.clearAllMocks());
const later = body => latestAcceptRecord([accepted(REFERRAL_HEAD), trusted(body)], []).laterVerdict;
const note = (kind = 'referral-hold-auto-resolved', text, prNumber = 9) => fixtureNote(kind, text, prNumber);
const render = output => buildNoteComment(output, { informational: true });

describe('accepted never started: exact no-ask notes', () => {
  it.each(NO_ASK_NOTE_KINDS)('%s note is not a later verdict', kind => expect(later(note(kind))).toBe(false));
  it.each(['<!--', '-->', '--!>'])('a no-ask note whose detail carries comment delimiter %s still sets laterVerdict', delimiter => {
    expect(later(note(undefined, `${producedNote('referral-hold-auto-resolved').text} ${delimiter}`))).toBe(true);
  });
  it.each([
    ['duplicated trailer still sets laterVerdict', b => `${b}\n${b.split('\n').at(-1)}`],
    ['a note with extra prose lines still sets laterVerdict', b => b.replace('\n\nnote:', '\nDo not merge\n\nnote:')],
    ['a note whose trailer key does not match kind/pr/text still sets laterVerdict', b => b.replace(':9:', ':10:').replace('note-key: referral', 'note-key: timeout')],
    ['visible text mismatch still sets laterVerdict', b => b.replace('referral hold auto-resolved —', 'Do not merge —')],
  ])('%s', (_, alter) => expect(later(alter(note()))).toBe(true));
  it.each(['\r', '\u0085', '\u2028', '\u2029', '\v', '\f'])('alternate line separator %j holds', separator => {
    expect(later(note(undefined, `first${separator}second`))).toBe(true);
  });
  it('a note kind outside NO_ASK_NOTE_KINDS still sets laterVerdict', () => expect(later(note('other-kind'))).toBe(true));
  it('a trailer naming another allowed kind still sets laterVerdict', () => {
    expect(later(note().replace('conveyor-note-key: referral-hold-auto-resolved', 'conveyor-note-key: timeout-retry-fallback-heal'))).toBe(true);
  });
  it.each([
    ['an untrusted look-alike note still sets laterVerdict', { author: { login: 'attacker' } }],
    ['missing author metadata still sets laterVerdict', {}],
  ])('%s', (_, metadata) => expect(latestAcceptRecord([accepted(), { ...metadata, body: note() }], []).laterVerdict).toBe(true));

  it.each(NO_ASK_NOTE_KINDS)('trusted no-ask note with free-text detail "Do not merge" still sets laterVerdict (%s)', kind => {
    expect(later(note(kind, 'Do not merge'))).toBe(true);
  });
  it('referral note naming a head other than the accepted reviewed-sha still holds', () => {
    expect(latestAcceptRecord([accepted(A), trusted(note())], []).laterVerdict).toBe(true);
  });
  it('referral note without accept context still holds', () => {
    const comment = trusted(note());
    expect(isKnownMachineBody(comment.body, comment)).toBe(false);
  });
  it('timeout-retry note without accept context still holds', () => {
    const comment = trusted(note('timeout-retry-fallback-heal'));
    expect(isKnownMachineBody(comment.body, comment)).toBe(false);
  });
  it('referral tally containing block still holds', () => {
    const output = producedNote('referral-hold-auto-resolved', { counts: { card: 1 } });
    expect(later(render({ ...output, text: output.text.replace('1 card', '1 block') }))).toBe(true);
  });
  it('timeout-retry note with timeout-evidence free-text reason still holds', () => {
    expect(later(render(producedNote('timeout-retry-fallback-heal', { reason: 'timeout-evidence:incomplete-diff' })))).toBe(true);
  });
  it('timeout-retry note whose PR #N differs from the key still holds', () => {
    const output = producedNote('timeout-retry-fallback-heal');
    expect(later(render({ ...output, text: output.text.replace('PR #9:', 'PR #10:') }))).toBe(true);
  });
  it('referral TALLY with a repeated category (1 card, 2 card) still sets laterVerdict', () => {
    const output = producedNote('referral-hold-auto-resolved', { counts: { card: 1 } });
    expect(later(render({ ...output, text: output.text.replace('1 card', '1 card, 2 card') }))).toBe(true);
  });
  it.each(['0 card', '01 card', '-1 card', '1 unknown', '1 card, 0 cleared', '1 card, 2 not-real, 3 not-real', '1 card; 2 cleared'])(
    'referral TALLY outside the closed grammar (%s) still holds', tally => {
      const output = producedNote('referral-hold-auto-resolved', { counts: { card: 1 } });
      expect(later(render({ ...output, text: output.text.replace('1 card', tally) }))).toBe(true);
    });
  it.each(NO_ASK_NOTE_KINDS)('extra detail after the %s template still holds', kind => {
    const output = producedNote(kind);
    expect(later(render({ ...output, text: `${output.text}; Do not merge` }))).toBe(true);
  });
  it.each([REFERRAL_HEAD, OTHER_REFERRAL_HEAD])('producer referral note on incident prefix %s is not a later verdict', head => {
    const comments = [accepted(head), trusted(render(producedNote('referral-hold-auto-resolved', { head })))];
    expect(latestAcceptRecord(comments, []).laterVerdict).toBe(false);
  });
  it.each([false, true])('producer referral variants (advisory only=%s) are not later verdicts', human => {
    for (const counts of [null, { card: 1 }, { 'not-real': 2 }, { cleared: 3 }, { card: 1, 'not-real': 2, cleared: 3 }]) {
      expect(later(render(producedNote('referral-hold-auto-resolved', { counts, human })))).toBe(false);
    }
  });
  it.each(['mixed-infra-cancelled-and-real-failure', 'log-unreadable', 'infra-cancelled-heal-mode', 'missing-check-origin'])(
    'producer timeout-retry reason %s is not a later verdict', reason => {
      expect(later(render(producedNote('timeout-retry-fallback-heal', { reason })))).toBe(false);
    });
  it('referral note head resolves against the latest accept preceding the note', () => {
    const comment = trusted(note());
    const comments = [accepted(REFERRAL_HEAD), comment, accepted(OTHER_REFERRAL_HEAD)];
    expect(isKnownMachineBody(comment.body, comment, { comments, acceptIndex: 2 })).toBe(true);
    const wrong = trusted(render(producedNote('referral-hold-auto-resolved', { head: OTHER_REFERRAL_HEAD })));
    expect(isKnownMachineBody(wrong.body, wrong, { comments: [comments[0], wrong, comments[2]], acceptIndex: 2 })).toBe(false);
  });
  it('referral head uses the last reviewed-sha marker of the preceding trusted accept', () => {
    const preceding = trusted(`${accepted(A).body}\n<!-- reviewed-sha: ${REFERRAL_HEAD} -->`);
    expect(latestAcceptRecord([preceding, trusted(note())], []).laterVerdict).toBe(false);
  });
  it.each([
    ['missing comment list', () => ({ acceptIndex: 0 })],
    ['missing accept index', comments => ({ comments })],
    ['invalid accept index', comments => ({ comments, acceptIndex: -1 })],
    ['untrusted accept', (_, comment) => ({ comments: [{ ...accepted(REFERRAL_HEAD), viewerDidAuthor: false, author: { login: 'attacker' } }, comment], acceptIndex: 0 })],
    ['unreadable accept', (_, comment) => ({ comments: [trusted(null), comment], acceptIndex: 0 })],
    ['note absent from context', comments => ({ comments: [comments[0]], acceptIndex: 0 })],
    ['oversized context', comments => ({ comments: [...comments, ...Array(10000).fill(trusted(''))], acceptIndex: 0 })],
  ])('referral note with %s holds', (_, context) => {
    const comment = trusted(note()), comments = [accepted(REFERRAL_HEAD), comment];
    expect(isKnownMachineBody(comment.body, comment, context(comments, comment))).toBe(false);
  });
});

describe('accepted never started: recovered retry', () => {
  it('shape-c-fallback-exhaustion-kind-from-wrongspent-path-is-not-a-later-verdict', () => {
    const postComment = vi.fn(), checks = ['fixture'];
    const comments = [trusted(buildExhaustedRetrySpentComment({ headSha: C }))];
    const unexpected = () => { throw Error('unexpected external IO'); };
    sweepExhaustedRetry({ repo: 'fixture/repo', apply: true, now: Date.parse('2026-11-27T12:00:00Z'),
      settings: { enabled: true, maxRetries: 1 }, ciHealBudget: { cap: 3, resetOnFixHead: false }, ciHealCap: 3,
      mainRuns: [], candidates: [{ prNumber: 9, headSha: C, comments, exhaustion: { exhausted: false }, requiredChecks: checks,
        pr: { headRefOid: C, statusCheckRollup: [{ name: 'fixture', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-27T11:00:00Z' }] } }],
      postComment, editComment: vi.fn(), readOpenPrs: unexpected, readComments: unexpected, readAheadBy: unexpected,
      readMainRuns: unexpected, readMainTip: unexpected, readMainFailureSignature: unexpected,
      readAttributedRequiredChecks: unexpected, refresh: unexpected, trigger: unexpected, checkClaim: unexpected,
      readIsCrossRepository: unexpected, reconcileAcceptance: unexpected });
    expect(postComment).toHaveBeenCalledOnce();
    const body = postComment.mock.calls[0][1].body;
    expect(body).toBe(recovered('exhaustion'));
    expect(later(body)).toBe(false);
  });
  it.each(['ci-heal-exhausted', 'fix-loop-exhausted', 'exhaustion'])('exhausted-retry-recovered %s note is not a later verdict', kind => {
    expect(later(recovered(kind))).toBe(false);
  });
  it.each([
    ['extra prose', () => trusted(`${recovered()}\nDo not merge`)],
    ['non-40-hex head', () => trusted(recovered(undefined, 'abc'))],
    ['unknown kind', () => trusted(recovered('other-kind'))],
    ['untrusted author', () => ({ body: recovered(), author: { login: 'attacker' } })],
    ['missing author', () => ({ body: recovered() })],
  ])('recovered retry holds for %s', (_, make) => expect(latestAcceptRecord([accepted(), make()], []).laterVerdict).toBe(true));
});

describe('accepted never started: chained carry provenance', () => {
  it('second-hop carried envelope showing the chain-origin head is not a later verdict', () => {
    expect(latestAcceptRecord(chain(), []).laterVerdict).toBe(false);
  });
  it('a chain anchored at a superseded acceptance retains the latest acceptance hold', () => {
    const comments = [accepted(D), accepted(A), trusted(envelope(D, B, D)), trusted(envelope(B, C, D))];
    const record = latestAcceptRecord(comments, []);
    expect(record.sha).toBe(A);
    expect(record.index).toBe(1);
    expect(record.laterVerdict).toBe(true);
  });
  it('a first-hop carry stays recognised without context', () => expect(isKnownMachineBody(envelope(A, B), trusted(''))).toBe(true));
  it('a second-hop carry without readable chain context holds', () => expect(isKnownMachineBody(envelope(), trusted(''))).toBe(false));
  it('oversized chain context holds for operator inspection', () => {
    const comments = chain(); comments.push(...Array.from({ length: 10000 }, () => trusted('')));
    expect(latestAcceptRecord(comments, []).laterVerdict).toBe(true);
  });
  it('a bare second-hop envelope uses the same chain', () => {
    expect(latestAcceptRecord(chain({ gate: false }), []).laterVerdict).toBe(false);
  });
  it('a third-hop verifies the whole chain', () => {
    expect(latestAcceptRecord([...chain(), trusted(envelope(C, D))], []).laterVerdict).toBe(false);
  });
  it('a displayed intermediate head requires the complete chain back to acceptance', () => {
    expect(latestAcceptRecord([...chain(), trusted(envelope(C, D, B))], []).laterVerdict).toBe(false);
  });
  const invalid = [
    ['a displayed head not on the chain still holds', () => [accepted(), trusted(envelope(A, B)), trusted(envelope(B, C, D))]],
    ['an unrelated third head still holds', () => [accepted(), trusted(envelope(B, C, D))]],
    ['future edge', () => [accepted(), trusted(envelope()), trusted(envelope(A, B))]],
    ['chain-reversed-order-holds', () => [accepted(), trusted(envelope(B, C)), trusted(envelope(A, B)), trusted(envelope(C, D))]],
    ['cycle', () => [accepted(D), trusted(envelope(B, A, B)), trusted(envelope(A, B)), trusted(envelope())]],
    ['conflicting predecessors', () => [accepted(), trusted(envelope(A, B)), trusted(envelope(D, B, D)), trusted(envelope())]],
    ['untrusted intermediate marker', () => [accepted(), { body: envelope(A, B), author: { login: 'attacker' } }, trusted(envelope())]],
    ['marker embedded in unrelated prose', () => [accepted(), trusted(`unrelated\n${envelope(A, B)}`), trusted(envelope())]],
    ['chain-acceptance-after-first-carry-holds', () => [trusted(envelope(A, B)), accepted(), trusted(envelope())]],
  ];
  it.each(invalid)('%s', (_, make) => expect(latestAcceptRecord(make(), []).laterVerdict).toBe(true));
  const finding = (impactIfUnfixed = 'degraded', confirmedByRecheck = true) => ({ category: 'edge-case', impactIfUnfixed,
    confirmedByRecheck, summary: 'fixture finding', file: 'src/fixture.mjs', line: 1, filesRead: ['src/fixture.mjs'] });
  it.each([['degraded', true], ['broken', false]])('retains non-blocking findings %s confirmed=%s', (impact, confirmed) => {
    expect(latestAcceptRecord(chain({ findings: [finding(impact, confirmed)] }), []).laterVerdict).toBe(false);
  });
  it('a confirmed broken finding (send-back) still holds', () => {
    expect(latestAcceptRecord(chain({ findings: [finding('broken')] }), []).laterVerdict).toBe(true);
  });
  it('malformed finding sequence still holds', () => {
    const comments = chain({ findings: [finding()] }); comments[2].body = comments[2].body.replace('1. [', '2. [');
    expect(latestAcceptRecord(comments, []).laterVerdict).toBe(true);
  });
  it('unreadable policy still holds for findings-bearing envelopes', () => {
    readConfirmedBreaks.mockImplementationOnce(() => { throw Error('unreadable policy'); });
    expect(latestAcceptRecord(chain({ findings: [finding()] }), []).laterVerdict).toBe(true);
  });
  it('zero-finding envelopes do not read policy', () => {
    expect(latestAcceptRecord(chain(), []).laterVerdict).toBe(false);
    expect(readConfirmedBreaks).not.toHaveBeenCalled();
  });
});

describe('accepted never started: holds and compatibility', () => {
  it('an unknown/hold comment before the accept does not count and after it does', () => {
    const hold = { body: '🔁 review — changes requested', author: { login: 'human' } };
    expect(latestAcceptRecord([hold, accepted()], []).laterVerdict).toBe(false);
    expect(latestAcceptRecord([accepted(), hold], []).laterVerdict).toBe(true);
  });
  it('a no-ask note stays non-blocking in both positions', () => {
    expect(latestAcceptRecord([trusted(note()), accepted()], []).laterVerdict).toBe(false);
    expect(later(note())).toBe(false);
  });
  it('a forged marker from a non-trusted author does not clear', () => {
    expect(latestAcceptRecord([accepted(), { body: envelope(A, B), author: { login: 'attacker' } }], []).laterVerdict).toBe(true);
  });
  it('a send-back gate still sets laterVerdict', () => expect(later(envelope().replace('card-queued', 'send-back'))).toBe(true));
  it.each([
    ['fix-begin', '🔒 conveyor fix-begin — fixture'], ['fix-end', '🔓 conveyor fix-end — fixture'],
    ['CI-heal', '🩹 conveyor CI-heal — fixture'], ['fix', '🔧 conveyor fix — fixture'],
    ['restack', '✅ conveyor restack — fixture'], ['operator-note', '🔔 conveyor — fixture'],
    ['restamp', '📌 review — acceptance re-stamped fixture'], ['drain-reason', '<!-- drain-skip-reason --> fixture'],
    ['rebase', '🔀 conveyor rebase-onto-main fixture'], ['CI-hung', '⏱️ conveyor CI-hung-recovery fixture'],
    ['missing-run', '🚦 conveyor missing-run-recovery fixture'], ['queue-note', '⏳ conveyor — fixture'],
    ['inspection', '🔎 stuck-PR inspection fixture'],
    ['mechanical-park', '<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\nheld — a review hold'],
    ['advisory', '**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.**'],
  ])('legacy recognised %s remains non-blocking', (_, body) => expect(later(body)).toBe(false));
});

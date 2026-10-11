/**
 * @file scripts/conveyor/__tests__/advisory-round-count.test.mjs
 * @description Pins {@link countAdvisoryComments} (#3383) — the durable, restart-surviving count of how many
 *   advisory-panel rounds have already run against a `review:human` PR. Mirrors `rearm-review.test.mjs`'s own
 *   `countRearmComments` cases, for the sibling counter this item adds. Also pins (#3383, the marker-authorship
 *   fix) that only a TRUSTED author (automation or the repo operator) counts at all.
 */
import { describe, it, expect } from 'vitest';
import { countAdvisoryComments, advisoryRoundLedger, ADVISORY_NOTE_MARKER, OPERATOR_RULING_MARKER_TAG } from '../advisory-round-count.mjs';

import { AUTOMATION_LOGINS, OPERATOR_LOGINS } from '../../lib/marker-authorship.mjs';
import { OPERATOR_RULING_MARKER } from '../../lib/jury-core.mjs';

const AUTOMATION = { login: 'web-everything' };

describe('countAdvisoryComments — the DURABLE advisory-round count (#3383)', () => {
  const advisory = (extra = '', author = AUTOMATION) => ({ body: `${ADVISORY_NOTE_MARKER} This PR carries \`review:human\`${extra}`, author });

  it('counts one advisory comment per completed round', () => {
    expect(countAdvisoryComments([advisory()])).toBe(1);
    expect(countAdvisoryComments([advisory(' a'), advisory(' b'), advisory(' c')])).toBe(3);
  });

  it('ignores non-advisory comments (only the marker line counts)', () => {
    const comments = [advisory(), { body: 'LGTM, one nit below' }, { body: 'please fix the typo' }, advisory(' 2')];
    expect(countAdvisoryComments(comments)).toBe(2);
  });

  it('is 0 for a PR with no advisory comments at all', () => {
    expect(countAdvisoryComments([])).toBe(0);
    expect(countAdvisoryComments([{ body: 'a human review comment' }])).toBe(0);
    expect(countAdvisoryComments(null)).toBe(0);
    expect(countAdvisoryComments(undefined)).toBe(0);
  });

  it('does NOT inflate the count when a human QUOTES the advisory comment mid-body', () => {
    expect(countAdvisoryComments([{ body: `> ${ADVISORY_NOTE_MARKER}\n\nreplying to this`, author: AUTOMATION }])).toBe(0);
  });

  it('tolerates leading whitespace on the marker line (gh renders can pad)', () => {
    expect(countAdvisoryComments([{ body: `\n  ${ADVISORY_NOTE_MARKER}\n\nbody`, author: AUTOMATION }])).toBe(1);
  });

  it('tolerates the bare-string comment shape too — but it carries no author, so it never counts (#3383)', () => {
    expect(countAdvisoryComments([`${ADVISORY_NOTE_MARKER} plain string comment`])).toBe(0);
  });

  // #3383 — adversarial coverage review, 2026-09-24: the advisory-note count feeds `reconcile-core.mjs`'s
  // union with `countRearmComments` toward the shared negotiation-round cap; a forged marker here inflates that
  // cap exactly like a forged rearm marker would.
  it('a forged advisory-note marker from a random commenter ("mallory") does not count', () => {
    expect(countAdvisoryComments([advisory('', { login: 'mallory' })])).toBe(0);
  });

  it('an advisory-note marker posted by the repo operator (a manual advisory run) still counts', () => {
    expect(countAdvisoryComments([advisory('', { login: 'chalbert' })])).toBe(1);
  });
});


describe('operator-ruling same-head re-reviews (#4715, 2026-10-11)', () => {
  const bot = AUTOMATION_LOGINS.find((login) => !OPERATOR_LOGINS.includes(login));
  const operator = OPERATOR_LOGINS[0];
  const H1 = '96f420b3f' + 'a'.repeat(31);
  const H2 = 'b'.repeat(40);
  const note = (head = H1, footer = `---\n\nNet basis: \`123abcd..${head}\` — review`) => ({
    author: { login: bot }, body: `${ADVISORY_NOTE_MARKER}\n\nFindings\n\n${footer}`,
  });
  const ruling = (head = H1, actor = operator, login = operator) => ({
    author: { login },
    body: `Operator ruling\n\n<!-- mandatory-referral-operator-ruling-v1: ${Buffer.from(JSON.stringify({ actor, head })).toString('base64')} -->`,
  });

  it('pins the producer marker without importing jury-core in the leaf', () => {
    expect(OPERATOR_RULING_MARKER_TAG).toBe(OPERATOR_RULING_MARKER);
    expect(bot).toBeTruthy();
    expect(operator).toBeTruthy();
  });

  it('does not spend a round for the #4715 operator-requested re-review', () => {
    expect(countAdvisoryComments([note(), ruling(), note()])).toBe(1);
  });

  it.each([
    ['automatic policy', () => ruling(H1, 'auto-policy', bot)],
    ['automation posting an operator actor', () => ruling(H1, operator, bot)],
    ['automatic actor posted by operator', () => ruling(H1, 'auto-policy')],
    ['different ruling head', () => ruling(H2)],
    ['missing GitHub author', () => ({ ...ruling(), author: undefined, viewerDidAuthor: true })],
    ['missing actor', () => ruling(H1, null)],
    ['short ruling head', () => ruling(H1.slice(0, 9))],
    ['uppercase ruling head', () => ruling(H1.toUpperCase())],
    ['marker followed by prose', () => ({ ...ruling(), body: ruling().body + '\nMore prose' })],
    ['bad base64', () => ({ ...ruling(), body: '<!-- mandatory-referral-operator-ruling-v1: !!! -->' })],
    ['bad JSON', () => ({ ...ruling(), body: '<!-- mandatory-referral-operator-ruling-v1: bm90LWpzb24= -->' })],
  ])('counts both notes for %s', (_label, makeRuling) => {
    expect(countAdvisoryComments([note(), makeRuling(), note()])).toBe(2);
  });

  it('counts a real new push even with an operator ruling', () => {
    expect(countAdvisoryComments([note(), ruling(H2), note(H2)])).toBe(2);
  });

  it('requires a fresh ruling between every pair of notes', () => {
    expect(countAdvisoryComments([note(), note()])).toBe(2);
    expect(countAdvisoryComments([note(), ruling(), note(), ruling(), note()])).toBe(1);
    expect(countAdvisoryComments([note(), ruling(), note(), note()])).toBe(2);
    expect(countAdvisoryComments([ruling(), note(), note()])).toBe(2);
    expect(countAdvisoryComments([note(), ruling(), ruling(), note(), note()])).toBe(2);
    expect(countAdvisoryComments([note(), ruling(), note(H1, 'Unreadable'), note()])).toBe(3);
  });

  it.each([
    `---\n\nnet basis: \`123abcd..${H1}\``,
    `---\n\n> Net basis: \`123abcd..${H1}\``,
    `Net basis: \`123abcd..${H1}\`\n\n---\n\nOther footer`,
    `---\n \nNet basis: \`123abcd..${H1}\``,
    `---\n\nExtra line\nNet basis: \`123abcd..${H1}\``,
    `\`\`\`text\n---\n\nNet basis: \`123abcd..${H1}\`\n\`\`\``,
    `~~~text\n---\n\nNet basis: \`123abcd..${H1}\`\n~~~`,
    `---\n\nNet basis: \`123abcd..${H1}\`\n---\n\nUnknown`,
  ])('fails closed when the head is outside the fixed footer slot: %s', (footer) => {
    expect(countAdvisoryComments([note(), ruling(), note(H1, footer)])).toBe(2);
    expect(countAdvisoryComments([note(H1, footer), ruling(), note()])).toBe(2);
  });

  it('accepts abbreviations in either direction, case, CRLF and alternate basis text', () => {
    const short = H1.slice(0, 9);
    const alternate = note(H1, `--- \t\r\n\r\nNet basis: \`${short}..${short.toUpperCase()}\` (this head; no fresh diff computed)\r\n`);
    expect(countAdvisoryComments([note(), ruling(), alternate])).toBe(1);
    expect(countAdvisoryComments([alternate, ruling(H1, operator.toUpperCase()), note()])).toBe(1);
    expect(countAdvisoryComments([note(H1.slice(0, 6)), ruling(), note()])).toBe(2);
  });

  it('ignores closed fenced separators after the real footer', () => {
    const footer = `---\n\nNet basis: \`123abcd..${H1}\`\n\n\`\`\`text\n---\n\nExample\n\`\`\``;
    expect(countAdvisoryComments([note(), ruling(), note(H1, footer)])).toBe(1);
  });

  it('uses array order and exposes the excluded index and normalized head', () => {
    const comments = [note(), { body: 'Discussion' }, { ...ruling(), createdAt: '2099-01-01' }, note(H1.toUpperCase())];
    expect(advisoryRoundLedger(comments)).toEqual({
      counted: 1, excluded: [{ index: 3, head: H1, reason: 'operator-ruling-rereview' }],
    });
    expect(advisoryRoundLedger(null)).toEqual({ counted: 0, excluded: [] });
  });

  it('untrusted notes do not reset the previous trusted note or consume its ruling', () => {
    expect(countAdvisoryComments([note(), ruling(), { ...note(H2), author: { login: 'mallory' } }, note()])).toBe(1);
  });
});

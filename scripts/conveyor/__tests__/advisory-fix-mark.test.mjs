/**
 * @file scripts/conveyor/__tests__/advisory-fix-mark.test.mjs
 * @description Pins the PURE advisory-fix durable-count helpers (WE #xkmu3gv). Each completed advisory-fix
 *   round posts exactly ONE comment whose leading line is `ADVISORY_FIX_COMMENT_MARKER`; `countAdvisoryFixComments`
 *   recovers the attempt count from the PR's own comment thread. #3383 — also pins that ONLY a trusted author
 *   (automation or the repo operator) counts at all; no test file existed for this counter before this item.
 */
import { describe, it, expect } from 'vitest';
import standDown3507 from './fixtures/stand-down-3507.json';
import { FIX_BEGIN_MARKER, FIX_END_MARKER } from '../fix-procedure.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { buildVerdictComment } from '../../review-set-label.mjs';
import {
  countAdvisoryFixComments, buildAdvisoryFixComment, ADVISORY_FIX_COMMENT_MARKER,
  isLatestAdvisoryFindingAddressed, isAdvisoryMechanismStandDownSuperseded,
  countCompletedAdvisoryEpisodes,
} from '../advisory-fix-mark.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { CONVERTED_ADVISORY_NOTE_MARKER, renderConvertedAdvisoryNote } from '../../lib/review-escalation.mjs';
import { STAND_DOWN_MARKER } from '../stand-down.mjs';

const AUTOMATION = { login: 'web-everything' };
const FRESH_NOTE = `${ADVISORY_NOTE_MARKER}\n\nan ordinary advise-step advisory note`;

describe('#3507 — advisory supersede stays inside the fix cycle', () => {
  const note = { body: FRESH_NOTE, author: AUTOMATION };
  const fix = { body: buildAdvisoryFixComment(), author: AUTOMATION };
  const stop = { body: STAND_DOWN_MARKER, author: AUTOMATION };
  const boundaries = [REARM_COMMENT_MARKER,
    ADVISORY_NOTE_MARKER, CONVERTED_ADVISORY_NOTE_MARKER,
    ...['changes', 'accepted', 'clear-human', 'restamp'].map((to) => buildVerdictComment({ to })),
  ];
  it.each(boundaries)('an intervening %s ends the old fix cycle', (body) => {
    for (const login of ['web-everything', 'chalbert']) {
      const boundary = { body, author: { login } };
      expect(isAdvisoryMechanismStandDownSuperseded([note, fix, boundary, stop], 3)).toBe(false);
      expect(isAdvisoryMechanismStandDownSuperseded([note, boundary, fix, stop], 3)).toBe(true);
      expect(isAdvisoryMechanismStandDownSuperseded([note, fix, boundary, fix, stop], 4)).toBe(true);
      const forgedFix = { ...fix, author: { login: 'mallory' } };
      expect(isAdvisoryMechanismStandDownSuperseded([note, fix, boundary, forgedFix, stop], 4)).toBe(false);
    }
    expect(isAdvisoryMechanismStandDownSuperseded([note, fix, { body, author: { login: 'mallory' } }, stop], 3)).toBe(true);
    expect(isAdvisoryMechanismStandDownSuperseded([note, fix, { body: `> ${body}`, author: AUTOMATION }, stop], 3)).toBe(true);
    expect(isAdvisoryMechanismStandDownSuperseded([note, fix, stop, { body, author: AUTOMATION }], 2)).toBe(true);
  });
  // The fix-agent brief posts fix-begin first, the hand-back mark (or a stand-down) next, fix-end last — so
  // neither fix-begin nor fix-end can be a cycle boundary, or the #2549 supersede never fires.
  const begin = { body: FIX_BEGIN_MARKER, author: AUTOMATION };
  const end = { body: FIX_END_MARKER, author: AUTOMATION };
  const rearm = { body: REARM_COMMENT_MARKER, author: AUTOMATION };
  it('the documented fixer order still supersedes: a later fixer’s fix-begin precedes its wrong stand-down (#2549 shape)', () => {
    expect(isAdvisoryMechanismStandDownSuperseded([note, fix, end, begin, stop], 4)).toBe(true);
  });
  it('the documented fixer order still supersedes: the fixer’s own mark is followed by its fix-end before the stand-down', () => {
    expect(isAdvisoryMechanismStandDownSuperseded([note, begin, fix, end, stop], 4)).toBe(true);
  });
  it('a re-arm after the fix bracket still ends the cycle', () => {
    expect(isAdvisoryMechanismStandDownSuperseded([note, begin, fix, end, rearm, begin, stop], 6)).toBe(false);
  });
  it('replays #3507’s observed comment order without superseding the 23:09 stand-down', () => {
    const { comments } = standDown3507;
    expect(comments.at(-1).createdAt).toBe('2026-10-02T23:09:03Z');
    expect(isAdvisoryMechanismStandDownSuperseded(comments, comments.length - 1)).toBe(false);
  });
  it('ordinary discussion and elapsed time alone do not end a cycle', () => {
    expect(isAdvisoryMechanismStandDownSuperseded([
      note, { ...fix, createdAt: '2026-10-02T18:34:49Z' },
      { body: 'Thanks for the fix.', author: AUTOMATION },
      { ...stop, createdAt: '2026-10-02T23:09:03Z' },
    ], 3)).toBe(true);
  });
});

describe('countAdvisoryFixComments — the durable, restart-surviving advisory-fix attempt count (#xkmu3gv)', () => {
  it('counts one per comment whose LEADING line is the marker', () => {
    expect(countAdvisoryFixComments([
      { body: `${ADVISORY_FIX_COMMENT_MARKER}\n\naddressed once`, author: AUTOMATION },
      { body: 'an unrelated human comment', author: AUTOMATION },
      { body: `${ADVISORY_FIX_COMMENT_MARKER}\n\nand again`, author: AUTOMATION },
    ])).toBe(2);
  });

  it('does NOT count a comment that merely QUOTES the marker mid-body', () => {
    expect(countAdvisoryFixComments([{ body: `> ${ADVISORY_FIX_COMMENT_MARKER}\nquoting`, author: AUTOMATION }])).toBe(0);
  });

  it('returns 0 for a non-array / empty input', () => {
    expect(countAdvisoryFixComments(null)).toBe(0);
    expect(countAdvisoryFixComments(undefined)).toBe(0);
    expect(countAdvisoryFixComments([])).toBe(0);
  });

  it('tolerates a bare-string comment as a SHAPE — but it carries no author, so it never counts (#3383)', () => {
    expect(countAdvisoryFixComments([`${ADVISORY_FIX_COMMENT_MARKER}\nx`])).toBe(0);
  });

  // #3383 — adversarial coverage review, 2026-09-24.
  it('a forged advisory-fix marker from a random commenter ("mallory") does not count', () => {
    expect(countAdvisoryFixComments([{ body: `${ADVISORY_FIX_COMMENT_MARKER}\naddressed`, author: { login: 'mallory' } }])).toBe(0);
  });

  it('an advisory-fix marker posted by the repo operator still counts', () => {
    expect(countAdvisoryFixComments([{ body: `${ADVISORY_FIX_COMMENT_MARKER}\naddressed`, author: { login: 'chalbert' } }])).toBe(1);
  });
});

describe('buildAdvisoryFixComment — the durable comment body (#xkmu3gv)', () => {
  it('leads with the marker so posting and counting share ONE source of truth', () => {
    const body = buildAdvisoryFixComment({});
    expect(body.split('\n')[0]).toBe(ADVISORY_FIX_COMMENT_MARKER);
    expect(countAdvisoryFixComments([{ body, author: AUTOMATION }])).toBe(1);
  });

  it('states that no label was touched and a fresh review is owed', () => {
    const body = buildAdvisoryFixComment({});
    expect(body).toMatch(/review:human/);
    expect(body).toMatch(/fresh independent review is owed/i);
  });
});

describe('#xconv1-evidence (web-everything/web-everything#2766/#2767 misfire) — isLatestAdvisoryFindingAddressed recognizes a CONVERTED note too', () => {
  const convertedNote = renderConvertedAdvisoryNote({
    repo: 'web-everything/web-everything', pr: 2766, headSha: 'deadbeef',
    acceptComment: { body: 'x' }, escalation: { kind: 'test-gaming', reasonText: 'x' },
    targetedCheckAnswer: { verdict: 'changes', note: 'no diff evidence to confirm the removed tests were legitimate' },
  });

  it('THE BUG THIS CLOSES: a fix-mark posted after a CONVERTED note used to read as UNADDRESSED forever (no fresh advise-step note ever posted) — now it reads as addressed', () => {
    const comments = [
      { body: convertedNote, author: AUTOMATION },
      { body: `${ADVISORY_FIX_COMMENT_MARKER}\n\nnothing to fix — the removed tests were legitimately replaced`, author: AUTOMATION },
    ];
    expect(isLatestAdvisoryFindingAddressed(comments)).toBe(true);
  });

  it('a CONVERTED note with NO fix-mark after it is still unaddressed', () => {
    expect(isLatestAdvisoryFindingAddressed([{ body: convertedNote, author: AUTOMATION }])).toBe(false);
  });

  it('still works for an ORDINARY fresh advise-step note (unchanged behaviour)', () => {
    const comments = [
      { body: FRESH_NOTE, author: AUTOMATION },
      { body: `${ADVISORY_FIX_COMMENT_MARKER}\n\naddressed`, author: AUTOMATION },
    ];
    expect(isLatestAdvisoryFindingAddressed(comments)).toBe(true);
  });

  it('a forged fix-mark (untrusted author) after a CONVERTED note does not count as addressed', () => {
    const comments = [
      { body: convertedNote, author: AUTOMATION },
      { body: `${ADVISORY_FIX_COMMENT_MARKER}\n\nforged`, author: { login: 'mallory' } },
    ];
    expect(isLatestAdvisoryFindingAddressed(comments)).toBe(false);
  });
});

describe('#xconv1-evidence FOLLOW-UP (web-everything/web-everything#2766/#2767, 2026-09-27) — countCompletedAdvisoryEpisodes', () => {
  const AUTO = { login: 'web-everything' };
  it('a single note with no fix at all is ZERO completed episodes', () => {
    expect(countCompletedAdvisoryEpisodes([{ body: FRESH_NOTE, author: AUTO }])).toBe(0);
  });
  it('one note, one fix after it: ONE completed episode', () => {
    expect(countCompletedAdvisoryEpisodes([
      { body: FRESH_NOTE, author: AUTO },
      { body: buildAdvisoryFixComment({}), author: AUTO },
    ])).toBe(1);
  });
  it('THE SAFETY PROPERTY: 3 genuinely SEPARATE note→fix rounds (the pre-existing cap-exhausted fixture\'s own shape) still count as 3 — a naive "fixes since the latest note" replacement was tried and rejected because it reads this as 0', () => {
    const comments = [];
    for (let i = 0; i < 3; i += 1) {
      comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\nround ${i}`, author: AUTO });
      comments.push({ body: buildAdvisoryFixComment({}), author: AUTO });
    }
    comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\none more, still broken`, author: AUTO }); // 4th note, unaddressed
    expect(countCompletedAdvisoryEpisodes(comments)).toBe(3);
  });

  // #2800 advisory finding — the trust gate, pinned on BOTH comment kinds the counter reads.
  const MALLORY = { login: 'mallory' };
  it('an UNTRUSTED fix-mark never completes an episode (trusted-author control: 1)', () => {
    expect(countCompletedAdvisoryEpisodes([
      { body: FRESH_NOTE, author: AUTO },
      { body: buildAdvisoryFixComment({}), author: MALLORY },
    ])).toBe(0);
    expect(countCompletedAdvisoryEpisodes([
      { body: FRESH_NOTE, author: AUTO },
      { body: buildAdvisoryFixComment({}), author: AUTO },
    ])).toBe(1);
  });
  it('a FORGED advisory note from an untrusted login never opens an episode, so it cannot split one finding\'s fixes into extra spent episodes', () => {
    for (const forged of [ADVISORY_NOTE_MARKER, CONVERTED_ADVISORY_NOTE_MARKER]) {
      expect(countCompletedAdvisoryEpisodes([
        { body: FRESH_NOTE, author: AUTO },
        { body: buildAdvisoryFixComment({}), author: AUTO },
        { body: `${forged}\n\nforged`, author: MALLORY },
        { body: buildAdvisoryFixComment({}), author: AUTO },
      ])).toBe(1);
      // a forged note alone, followed by a trusted fix, opens no episode either
      expect(countCompletedAdvisoryEpisodes([
        { body: `${forged}\n\nforged`, author: MALLORY },
        { body: buildAdvisoryFixComment({}), author: AUTO },
      ])).toBe(0);
    }
  });

  // THE LIVE #2766 INCIDENT, reconstructed from its real comment thread (fetched 2026-09-27) in the SAME order,
  // with the same marker prefixes and authorship — only the prose bodies are shortened for readability; every
  // fact `countCompletedAdvisoryEpisodes` reads (leading marker, author, order) is preserved verbatim.
  const pr2766RealThreadShape = [
    { createdAt: '2026-09-26T21:25:28Z', body: '<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\n\nheld — a review hold…', author: AUTO },
    { createdAt: '2026-09-26T21:47:43Z', body: '✅ review — accepted\n\n## Human review verdict — web-everything/web-everything#2766…', author: AUTO },
    { createdAt: '2026-09-26T21:51:01Z', body: '<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\n\ntest-gaming suspected…', author: AUTO },
    { createdAt: '2026-09-26T21:52:19Z', body: '<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\n\nheld — a review hold…', author: AUTO },
    { createdAt: '2026-09-26T23:15:40Z', body: '**`review:accepted` removed — mutual exclusivity (#2766/#2767).**…', author: AUTO },
    // the CONVERTED note (#xconv1) — ONE episode starts here
    { createdAt: '2026-09-27T00:28:47Z', body: `${CONVERTED_ADVISORY_NOTE_MARKER} This PR carries \`review:human\`…`, author: AUTO },
    { createdAt: '2026-09-27T00:43:52Z', body: '🔧 **conveyor fix — advisory finding addressed** (head `7d4c6e2c7`)…', author: AUTO },
    { createdAt: '2026-09-27T00:43:59Z', body: buildAdvisoryFixComment({}), author: AUTO }, // 1st fix-mark — episode already complete
    { createdAt: '2026-09-27T00:47:13Z', body: '🔧 **conveyor fix (`fix-2766`) — advisory finding already addressed on this head**…', author: AUTO },
    { createdAt: '2026-09-27T00:47:14Z', body: buildAdvisoryFixComment({}), author: AUTO }, // 2nd fix-mark, SAME episode (bug: no review ever advanced it)
    { createdAt: '2026-09-27T00:58:23Z', body: '🔧 **conveyor fix (`fix-2766`, 3rd dispatch) — advisory finding already addressed**…', author: AUTO },
    { createdAt: '2026-09-27T00:58:24Z', body: buildAdvisoryFixComment({}), author: AUTO }, // 3rd fix-mark, STILL the same episode
    // an independent, later review's own fresh note — a SECOND episode starts here, with NO fix yet
    { createdAt: '2026-09-27T02:29:10Z', body: `${ADVISORY_NOTE_MARKER} This PR carries \`review:human\`… **Advisory outcome:** \`accept\``, author: AUTO },
    { createdAt: '2026-09-27T02:49:10Z', body: `${ADVISORY_NOTE_MARKER} This PR carries \`review:human\`… **Advisory outcome:** \`changes\``, author: AUTO },
    { createdAt: '2026-09-27T05:03:23Z', body: '🔀 conveyor rebase-onto-main\n\nbranch: lane/2749-prevention-outstanding-verdict…', author: AUTO },
  ];

  it('THE BUG THIS CLOSES: 3 fix-mark COMMENTS on the real #2766 thread collapse to ONE completed episode (they all landed inside the SAME still-broken converted-note episode) — the lifetime comment count (3) wrongly read this as cap-exhausted with zero attempts against the later, genuinely new finding', () => {
    expect(countCompletedAdvisoryEpisodes(pr2766RealThreadShape)).toBe(1);
    // the OLD (still-exported, still-correct-for-its-own-purpose) lifetime counter is what actually misfired live:
    expect(countAdvisoryFixComments(pr2766RealThreadShape)).toBe(3);
    // and the LATEST finding (the 02:49Z note) has never had a fix attempt — not `addressed` — so a fresh
    // advisory-fix dispatch is exactly what's owed, with 1 of 3 lifetime episodes spent, not 3.
    expect(isLatestAdvisoryFindingAddressed(pr2766RealThreadShape)).toBe(false);
  });
});

describe('#xconv1-evidence — isAdvisoryMechanismStandDownSuperseded recognizes a CONVERTED note too', () => {
  const convertedNote = renderConvertedAdvisoryNote({
    repo: 'web-everything/web-everything', pr: 2766, headSha: 'deadbeef',
    acceptComment: { body: 'x' }, escalation: { kind: 'test-gaming', reasonText: 'x' },
    targetedCheckAnswer: { verdict: 'changes', note: 'no diff evidence available' },
  });

  it('a stand-down posted after a fix-mark that itself postdates a CONVERTED note is superseded', () => {
    const comments = [
      { body: convertedNote, author: AUTOMATION },
      { body: `${ADVISORY_FIX_COMMENT_MARKER}\n\nnothing to fix`, author: AUTOMATION },
      { body: `${STAND_DOWN_MARKER}\n\nstood down anyway`, author: AUTOMATION },
    ];
    expect(isAdvisoryMechanismStandDownSuperseded(comments, 2)).toBe(true);
  });

  it('a stand-down with NO fix-mark after the CONVERTED note is a genuine, still-current judgment call — never superseded', () => {
    const comments = [
      { body: convertedNote, author: AUTOMATION },
      { body: `${STAND_DOWN_MARKER}\n\ngenuinely ambiguous`, author: AUTOMATION },
    ];
    expect(isAdvisoryMechanismStandDownSuperseded(comments, 1)).toBe(false);
  });
});

// PR #2800 advisory finding — the note trust gate is single-sourced, so the "addressed" check and the stand-down
// supersede check ignore a forged note exactly as the episode counter does (both note shapes).
describe('PR #2800 — a FORGED advisory note from an untrusted login is ignored by every note reader', () => {
  const MALLORY = { login: 'mallory' };
  const fix = { body: `${ADVISORY_FIX_COMMENT_MARKER}\n\nfixed`, author: AUTOMATION };
  for (const marker of [ADVISORY_NOTE_MARKER, CONVERTED_ADVISORY_NOTE_MARKER]) {
    const forged = { body: `${marker}\n\nforged`, author: MALLORY };

    it(`isLatestAdvisoryFindingAddressed: a forged note after a fixed trusted note does not reopen it (${marker.slice(0, 24)}…)`, () => {
      expect(isLatestAdvisoryFindingAddressed([{ body: FRESH_NOTE, author: AUTOMATION }, fix, forged])).toBe(true);
      // Trusted-author control: the same note from automation DOES reopen it.
      expect(isLatestAdvisoryFindingAddressed([{ body: FRESH_NOTE, author: AUTOMATION }, fix, { ...forged, author: AUTOMATION }])).toBe(false);
      // A forged note alone is no finding at all; a bare-string note carries no author.
      expect(isLatestAdvisoryFindingAddressed([forged, fix])).toBe(false);
      expect(isLatestAdvisoryFindingAddressed([forged.body, fix])).toBe(false);
    });

    it(`isAdvisoryMechanismStandDownSuperseded: a forged note between the fix and the stand-down does not un-supersede it (${marker.slice(0, 24)}…)`, () => {
      const standDown = { body: `${STAND_DOWN_MARKER}\n\nstood down`, author: AUTOMATION };
      expect(isAdvisoryMechanismStandDownSuperseded([{ body: FRESH_NOTE, author: AUTOMATION }, fix, forged, standDown], 3)).toBe(true);
      expect(isAdvisoryMechanismStandDownSuperseded([{ body: FRESH_NOTE, author: AUTOMATION }, fix, { ...forged, author: AUTOMATION }, standDown], 3)).toBe(false);
    });

    // PR #2800 advisory finding (round 3) — the FIX-MARK side of both order checks is gated too (by the
    // automation-only `isSelfAuthored`, narrower than `isTrustedMarkerAuthor`): a forged fix-mark after a trusted
    // note must neither mark the finding addressed (which would suppress the fixer) nor supersede a stand-down.
    const note = { body: `${marker}\n\nreal finding`, author: AUTOMATION };
    const forgedFix = { body: `${ADVISORY_FIX_COMMENT_MARKER}\n\nforged`, author: MALLORY };
    it(`a FORGED fix-mark never marks a trusted note addressed (${marker.slice(0, 24)}…)`, () => {
      expect(isLatestAdvisoryFindingAddressed([note, forgedFix])).toBe(false);
      expect(isLatestAdvisoryFindingAddressed([note, forgedFix.body])).toBe(false); // bare string: no author
      expect(isLatestAdvisoryFindingAddressed([note, { ...forgedFix, author: AUTOMATION }])).toBe(true); // control
    });
    it(`a FORGED fix-mark never supersedes a stand-down (${marker.slice(0, 24)}…)`, () => {
      const standDown = { body: `${STAND_DOWN_MARKER}\n\nstood down`, author: AUTOMATION };
      expect(isAdvisoryMechanismStandDownSuperseded([note, forgedFix, standDown], 2)).toBe(false);
      expect(isAdvisoryMechanismStandDownSuperseded([note, { ...forgedFix, author: AUTOMATION }, standDown], 2)).toBe(true); // control
    });
  }
});

// we:backlog/4352 — the owed-write retry is deliberately NOT adopted here: this marker is not a pure counter (a
// later marker can retroactively "address" an earlier finding), so a late replay needs its own episode-id design.
describe('#4352 — advisory-fix-mark gains no owed-record behaviour', () => {
  it('is not an owed kind, and its source never reaches the owed-write module', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { OWED_KINDS } = await import('../ci-heal-owed.mjs');
    expect(OWED_KINDS).toEqual(['ci-heal', 'ci-heal-escalation']);
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'advisory-fix-mark.mjs'), 'utf8');
    expect(src).not.toMatch(/ci-heal-owed|recordOwedWrite/);
  });
});

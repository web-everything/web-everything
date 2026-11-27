/**
 * @file scripts/conveyor/__tests__/conflict-fix-round-count.test.mjs
 * @description Pins the PURE mechanical conflict-resolution round count (WE #xkmu3gv). Each completed round
 *   posts exactly ONE comment whose leading line is `CONFLICT_FIX_COMMENT_MARKER`; `countConflictFixComments`
 *   recovers the attempt count from the PR's own comment thread, keyed to its OWN round cap (never the shared
 *   negotiation cap). #3383 — also pins that ONLY a trusted author (automation or the repo operator) counts at
 *   all; no test file existed for this counter before this item.
 */
import { describe, it, expect } from 'vitest';
import {
  countConflictFixComments, countStaleConflictFixRounds, parseConflictFixTarget, CONFLICT_FIX_COMMENT_MARKER,
  conflictFixBudget,
} from '../conflict-fix-round-count.mjs';

const AUTOMATION = { login: 'web-everything' };

describe('countConflictFixComments — the durable mechanical conflict-resolution round count (#xkmu3gv)', () => {
  it('counts one per comment whose LEADING line is the marker', () => {
    expect(countConflictFixComments([
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved once`, author: AUTOMATION },
      { body: 'an unrelated human comment', author: AUTOMATION },
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nand again`, author: AUTOMATION },
    ])).toBe(2);
  });

  it('does NOT count a comment that merely QUOTES the marker mid-body', () => {
    expect(countConflictFixComments([{ body: `> ${CONFLICT_FIX_COMMENT_MARKER}\nquoting`, author: AUTOMATION }])).toBe(0);
  });

  it('returns 0 for a non-array / empty input', () => {
    expect(countConflictFixComments(null)).toBe(0);
    expect(countConflictFixComments(undefined)).toBe(0);
    expect(countConflictFixComments([])).toBe(0);
  });

  it('tolerates a bare-string comment as a SHAPE — but it carries no author, so it never counts (#3383)', () => {
    expect(countConflictFixComments([`${CONFLICT_FIX_COMMENT_MARKER}\nx`])).toBe(0);
  });

  // #3383 — adversarial coverage review, 2026-09-24: a forged marker here burns a PR's conflict-fix round cap
  // toward `cap-exhausted` with no mechanical round having actually run.
  it('a forged conflict-fix marker from a random commenter ("mallory") does not count', () => {
    expect(countConflictFixComments([{ body: `${CONFLICT_FIX_COMMENT_MARKER}\nresolved`, author: { login: 'mallory' } }])).toBe(0);
  });

  it('a conflict-fix marker posted by the repo operator still counts', () => {
    expect(countConflictFixComments([{ body: `${CONFLICT_FIX_COMMENT_MARKER}\nresolved`, author: { login: 'chalbert' } }])).toBe(1);
  });
});

describe('BLD-8110 shared conflict-fix budget', () => {
  const round = (target = 'main@aaaaaaa') => ({
    body: `${CONFLICT_FIX_COMMENT_MARKER}\n<!-- conveyor-conflict-fix-target: ${target} -->`,
    author: { login: 'chalbert' },
  });
  const budget = (comments, target = {}) => conflictFixBudget(comments, {
    currentRef: 'main', currentSha: 'ddddddd', ...target,
  });

  it('discounts three old-target successes but preserves their lifetime cost', () => {
    expect(budget(['aaaaaaa', 'bbbbbbb', 'ccccccc'].map(sha => round(`main@${sha}`))))
      .toMatchObject({ stale: 0, total: 3, exhausted: false, hold: null });
  });

  it('missing target or incomplete comments holds', () => {
    for (const comments of [null, undefined, {}, [null], [{ body: null }]]) {
      expect(budget(comments).hold).toMatch(/history.*retry|comments.*retry/);
    }
    for (const target of [{ currentRef: null }, { currentSha: null }, { currentSha: 'invalid' }]) {
      expect(budget([round()], target).hold).toMatch(/target.*retry/);
    }
  });

  it.each([
    'main@invalid', 'main@aaaaaaa -->\n<!-- conveyor-conflict-fix-target: main@bbbbbbb',
  ])('ambiguous or malformed trusted target history holds: %s', target => {
    expect(budget([round(target)]).hold).toMatch(/target history.*person/);
  });

  it('forged marker spends no trusted budget', () => {
    const forged = { ...round('main@invalid'), author: { login: 'mallory' } };
    expect(budget([forged])).toMatchObject({ stale: 0, total: 0, exhausted: false, hold: null });
  });

  it('old unbound markers conservatively spend the current-target budget', () => {
    expect(budget(Array.from({ length: 3 }, () => ({
      body: CONFLICT_FIX_COMMENT_MARKER, author: { login: 'chalbert' },
    })))).toMatchObject({ stale: 3, total: 3, exhausted: true });
  });

  it('an abbreviated target matching the live full SHA remains same-target', () => {
    expect(budget([round('main@ddddddd')], { currentSha: 'd'.repeat(40) }))
      .toMatchObject({ stale: 1, total: 1 });
  });

  it('oversized history holds with a person-visible fallback', () => {
    expect(budget(Array.from({ length: 10_001 }, () => round())).hold).toMatch(/history.*bound.*person/);
    expect(budget([{ ...round(), body: 'x'.repeat(1_048_577) }]).hold).toMatch(/history.*bound.*person/);
  });
});

describe('parseConflictFixTarget — what did one completed round resolve against?', () => {
  it('reads the trailer when present, ref + sha', () => {
    const body = `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved\n\n<!-- conveyor-conflict-fix-target: main@abc1234 -->`;
    expect(parseConflictFixTarget(body, 'main')).toEqual({ ref: 'main', sha: 'abc1234' });
  });

  it('falls back to the stacked-base free text ("against `<ref>`") when no trailer is present', () => {
    const body = `${CONFLICT_FIX_COMMENT_MARKER}\n\nconveyor fix agent resolved this PR's conflict against \`lane/soak-gate-false-red\` (a STACKED-BASE mechanical rebase...)`;
    expect(parseConflictFixTarget(body, 'main')).toEqual({ ref: 'lane/soak-gate-false-red', sha: null });
  });

  it('falls back to the given default ref when the body names nothing (the ordinary main-base round, pre-trailer)', () => {
    const body = `${CONFLICT_FIX_COMMENT_MARKER}\n\nA mechanical conflict-resolution round (no other edits) was applied by conveyor fix agent`;
    expect(parseConflictFixTarget(body, 'main')).toEqual({ ref: 'main', sha: null });
  });

  it('prefers the trailer over the free text when both are present', () => {
    const body = `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved against \`old-ref\`\n\n<!-- conveyor-conflict-fix-target: main@deadbee -->`;
    expect(parseConflictFixTarget(body, 'main')).toEqual({ ref: 'main', sha: 'deadbee' });
  });
});

describe('countStaleConflictFixRounds — PR #2787 live incident (2026-09-27): count only rounds against the CURRENT target', () => {
  const AUTOMATION_A = { login: 'chalbert' };

  it('#2787 reproduction: 3 rounds against a stacked base that kept moving, now conflicting against `main` for the FIRST time — none of the 3 count, the 4th round is dispatchable', () => {
    const comments = [
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved this PR's conflict against \`lane/soak-gate-false-red\` (round 1)`, author: AUTOMATION_A },
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved this PR's conflict against \`lane/soak-gate-false-red\` (round 2)`, author: AUTOMATION_A },
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved this PR's conflict against \`lane/soak-gate-false-red\` (round 3)`, author: AUTOMATION_A },
    ];
    // The base has since landed and this PR retargeted to `main` — its FIRST-EVER main-base conflict.
    expect(countStaleConflictFixRounds(comments, { currentRef: 'main', currentSha: null })).toEqual({ stale: 0, total: 3 });
  });

  it('a round against the SAME ref, at the SAME recorded sha, counts as stale (the mechanism is genuinely stuck)', () => {
    const comments = [
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved\n\n<!-- conveyor-conflict-fix-target: main@aaa1111 -->`, author: AUTOMATION_A },
    ];
    expect(countStaleConflictFixRounds(comments, { currentRef: 'main', currentSha: 'aaa1111' })).toEqual({ stale: 1, total: 1 });
  });

  it('a round against the SAME ref, at a DIFFERENT (newer) sha, is NOT stale — main moved, fresh conflict', () => {
    const comments = [
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved\n\n<!-- conveyor-conflict-fix-target: main@aaa1111 -->`, author: AUTOMATION_A },
    ];
    expect(countStaleConflictFixRounds(comments, { currentRef: 'main', currentSha: 'bbb2222' })).toEqual({ stale: 0, total: 1 });
  });

  it('a round with NO recorded sha on either side (pre-trailer history) conservatively counts as stale, same ref', () => {
    const comments = [
      { body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nA mechanical conflict-resolution round (no other edits) was applied`, author: AUTOMATION_A },
    ];
    expect(countStaleConflictFixRounds(comments, { currentRef: 'main', currentSha: 'aaa1111' })).toEqual({ stale: 1, total: 1 });
  });

  it('the hard ceiling input (`total`) counts every completed round regardless of staleness', () => {
    const comments = Array.from({ length: 5 }, (_, i) => ({
      body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved\n\n<!-- conveyor-conflict-fix-target: main@aaa000${i} -->`,
      author: AUTOMATION_A,
    }));
    const { stale, total } = countStaleConflictFixRounds(comments, { currentRef: 'main', currentSha: 'aaa0004' });
    expect(total).toBe(5);
    expect(stale).toBe(1); // only the round whose recorded sha matches the CURRENT one.
  });

  it('a forged marker from an untrusted login counts toward neither total nor stale (#3383)', () => {
    const comments = [{ body: `${CONFLICT_FIX_COMMENT_MARKER}\n\nresolved`, author: { login: 'mallory' } }];
    expect(countStaleConflictFixRounds(comments, { currentRef: 'main', currentSha: null })).toEqual({ stale: 0, total: 0 });
  });

  it('returns {stale:0,total:0} for a non-array / empty input', () => {
    expect(countStaleConflictFixRounds(null, { currentRef: 'main' })).toEqual({ stale: 0, total: 0 });
    expect(countStaleConflictFixRounds([], { currentRef: 'main' })).toEqual({ stale: 0, total: 0 });
  });
});

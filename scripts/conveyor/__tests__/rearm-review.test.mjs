/**
 * @file scripts/conveyor/__tests__/rearm-review.test.mjs
 * @description Pins the PURE re-arm decision for the conveyor fix agent (WE #2630). `decideRearm` swaps a
 *   repaired `review:changes` bounce back to `review:pending` for re-review — and enforces the #2630 invariant
 *   in the pure core (unbypassable): it NEVER emits `review:accepted` and NEVER removes `review:human`. So the
 *   strongest thing an auto-fix can do is re-arm the review, never clear it. Also pins idempotency (a PR with
 *   no `review:changes` refuses) and the `presentRemoveLabels` narrowing.
 */
import { describe, it, expect } from 'vitest';
import { decideRearm, buildRearmComment, presentRemoveLabels, countRearmComments, REARM_COMMENT_MARKER, decideEmptyFixRound, hasUnexpectedPositionals, hasInvalidArgs, buildNoChangeComment, NO_CHANGE_COMMENT_MARKER } from '../rearm-review.mjs';
import { REVIEW_LABELS, READY_TO_MERGE_LABEL } from '../../lib/review-escalation.mjs';
import { RED_TEAM_STATUS_LABELS } from '../../lib/red-team-status-label-meta.mjs';

const lbl = (...names) => names.map((name) => ({ name }));

describe('decideRearm — the pure re-arm swap (#2630)', () => {
  it('re-arms a plain review:changes bounce → review:pending, dropping review:changes', () => {
    const d = decideRearm({ currentLabels: lbl(REVIEW_LABELS.changes) });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.pending);
    // #2832 — re-arm applies review:pending (a hold), so the swap also strips ready-to-merge (narrowed to
    // actually-present labels at the CLI via presentRemoveLabels). #2811 — `accepted` is now unconditionally in
    // this list too (widened so the SAME target also re-arms a stale acceptance, see the describe block below);
    // `presentRemoveLabels` narrows it away here since this PR carries no `review:accepted`.
    expect(d.removeLabels).toEqual([REVIEW_LABELS.changes, REVIEW_LABELS.accepted, REVIEW_LABELS.redteamAccepted, READY_TO_MERGE_LABEL, ...RED_TEAM_STATUS_LABELS]);
    expect(d.keepsHuman).toBe(false);
  });

  it('NEVER emits review:accepted — the fix agent cannot clear the review', () => {
    const d = decideRearm({ currentLabels: lbl(REVIEW_LABELS.changes) });
    expect(d.addLabel).not.toBe(REVIEW_LABELS.accepted);
  });

  // #x01u7az — LIVE BUG, PR #2549 (2026-09-24): this used to assert `addLabel === REVIEW_LABELS.pending` here,
  // which is exactly the bug — a gate-self rearm added `review:pending` ON TOP of the still-live `review:human`,
  // leaving BOTH review:* hold labels live at once. `review:human` already IS the hold; a rearm on a gate-self
  // PR now adds NOTHING (see `we:scripts/review-set-label.mjs#decideSetLabel`'s `rearm` branch for the full
  // reasoning).
  it('KEEPS review:human on a gate-self bounce, and adds NOTHING — never self-clears, never double-holds', () => {
    const d = decideRearm({ currentLabels: lbl(REVIEW_LABELS.human, REVIEW_LABELS.changes) });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe('');
    expect(d.addLabel).not.toBe(REVIEW_LABELS.pending);
    expect(d.removeLabels).toEqual([REVIEW_LABELS.changes, REVIEW_LABELS.accepted, REVIEW_LABELS.redteamAccepted, READY_TO_MERGE_LABEL, ...RED_TEAM_STATUS_LABELS]); // review:human is NOT in the removals; #2832 strips ready-to-merge
    expect(d.removeLabels).not.toContain(REVIEW_LABELS.human);
    expect(d.keepsHuman).toBe(true);
  });

  it('refuses (idempotent no-op) when there is no review:changes to re-arm', () => {
    // e.g. already re-armed (review:pending), or a plain human-parked PR — nothing to hand back.
    expect(decideRearm({ currentLabels: lbl(REVIEW_LABELS.pending) }).allowed).toBe(false);
    expect(decideRearm({ currentLabels: lbl(REVIEW_LABELS.human) }).allowed).toBe(false);
    expect(decideRearm({ currentLabels: [] }).allowed).toBe(false);
    expect(decideRearm({}).allowed).toBe(false);
  });

  it('tolerates the bare-string label shape too (not just {name})', () => {
    const d = decideRearm({ currentLabels: [REVIEW_LABELS.changes] });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.pending);
  });

  // #2811 — a STALE `review:accepted` (the head moved since acceptance — a ci-heal push, a non-content-
  // preserving mechanical rebase) is re-armable too, through this SAME target: see
  // `we:scripts/review-set-label.mjs#decideSetLabel`'s `rearm` branch for the full incident this closes.
  it('also re-arms a stale review:accepted (no review:changes present) → review:pending', () => {
    const d = decideRearm({ currentLabels: lbl(REVIEW_LABELS.accepted) });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.pending);
    expect(d.removeLabels).toContain(REVIEW_LABELS.accepted);
  });
});

describe('countRearmComments — the DURABLE, restart-surviving auto-fix attempt count (#2643)', () => {
  const AUTHOR = { login: 'web-everything' }; // the real automation login (confirmed live, #3383)
  const rearm = (extra = '', author = AUTHOR) => ({ body: `${REARM_COMMENT_MARKER}\n\nThe \`review:changes\` bounce was repaired${extra}`, author });

  it('counts one re-arm comment per completed auto-fix cycle', () => {
    expect(countRearmComments([rearm()])).toBe(1);
    expect(countRearmComments([rearm(' a'), rearm(' b'), rearm(' c')])).toBe(3);
  });

  it('ignores non-re-arm comments (only the marker line counts)', () => {
    const comments = [rearm(), { body: 'LGTM, one nit below' }, { body: 'please fix the typo' }, rearm(' 2')];
    expect(countRearmComments(comments)).toBe(2);
  });

  it('is 0 for a PR with no re-arm comments — the fresh-PR / never-bounced case', () => {
    expect(countRearmComments([])).toBe(0);
    expect(countRearmComments([{ body: 'a human review comment' }])).toBe(0);
  });

  it('does NOT inflate the count when a human QUOTES the re-arm comment mid-body', () => {
    // A reply that embeds the marker deeper in the text must not read as a fresh auto-fix.
    expect(countRearmComments([{ body: `> ${REARM_COMMENT_MARKER}\n\nreplying to this`, author: AUTHOR }])).toBe(0);
  });

  it('tolerates leading whitespace on the marker line (gh renders can pad)', () => {
    expect(countRearmComments([{ body: `\n  ${REARM_COMMENT_MARKER}\n\nbody`, author: AUTHOR }])).toBe(1);
  });

  it('tolerates the bare-string comment shape too (viewerDidAuthor fallback), and non-array input → 0', () => {
    // A bare string has no author field at all, so it can only ever count via the OTHER trust path this repo
    // still accepts test fixtures through: `viewerDidAuthor`. Bare strings never carry that either, so a bare
    // marker string is (correctly, post-#3383) untrusted — this pins that a bare string is a SHAPE this file
    // tolerates without throwing, not that it counts.
    expect(countRearmComments([REARM_COMMENT_MARKER])).toBe(0);
    expect(countRearmComments(null)).toBe(0);
    expect(countRearmComments(undefined)).toBe(0);
    expect(countRearmComments('not an array')).toBe(0);
  });

  // #3383 — adversarial coverage review, 2026-09-24: before the fix in this item, ANY GitHub account could post
  // a comment starting with REARM_COMMENT_MARKER and inflate this PR's negotiation-round count toward
  // NEGOTIATION_ROUND_CAP, silently burning a real fixer's remaining rounds.
  it('a forged re-arm marker from a random commenter ("mallory") does not count', () => {
    expect(countRearmComments([rearm('', { login: 'mallory' })])).toBe(0);
  });

  it('a re-arm marker posted by the repo operator (a manual re-arm, or a daemon on its fallback credential) still counts', () => {
    expect(countRearmComments([rearm('', { login: 'chalbert' })])).toBe(1);
  });
});

describe('presentRemoveLabels — narrow removals to labels the PR actually carries', () => {
  it('keeps only requested removals present on the PR (never hands gh an absent label)', () => {
    expect(presentRemoveLabels([REVIEW_LABELS.changes], lbl(REVIEW_LABELS.changes))).toEqual([REVIEW_LABELS.changes]);
    expect(presentRemoveLabels([REVIEW_LABELS.changes], lbl(REVIEW_LABELS.pending))).toEqual([]);
    expect(presentRemoveLabels([], lbl(REVIEW_LABELS.changes))).toEqual([]);
  });
});


describe('re-arm comments name the observed verdict (#3253)', () => {
  it.each([
    [['review:accepted'], 'previously accepted PR', false],
    [['review:changes'], '`review:changes` bounce was repaired', false],
    [['review:human', 'review:changes'], '`review:changes` bounce was repaired', true],
  ])('renders %j accurately', (currentLabels, expected, human) => {
    const decision = decideRearm({ currentLabels });
    const body = buildRearmComment({ actor: 'conveyor CI-heal agent', decision });
    expect(body).toContain(expected);
    expect(body).toContain(human ? 'KEPT as the sole hold' : 're-armed `review:pending`');
    expect(body.split('\n')[0]).toBe(REARM_COMMENT_MARKER);
    if (currentLabels.includes('review:accepted')) expect(body).not.toContain('bounce was repaired');
  });
});

it('xe8y12n missing-family comment records intent without claiming an unverified write', async () => {
  const { buildRearmComment } = await import('../rearm-review.mjs');
  const body = buildRearmComment({ actor: 'CI healer', decision: { rearmFrom: 'missing', keepsHuman: false } });
  expect(body).toContain('no review label');
  expect(body).toContain('completion result reports whether the label write was verified');
  expect(body).not.toContain('bounce was repaired');
  expect(body).not.toContain('the PR is re-armed `review:pending`');
});

describe('decideEmptyFixRound — a fix round that left the head where the fix began must not re-arm (#6713)', () => {
  const BOT = { login: 'web-everything' };
  const begin = (sha, author = BOT) => ({ body: `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${sha.slice(0, 9)}\`\n<!-- fix-claim who=fix-1 -->`, author });
  const HEAD = '4288acd6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('unchanged head since fix-begin → empty round (no re-arm, no round bump)', () => {
    const d = decideEmptyFixRound({ comments: [begin(HEAD)], liveHead: HEAD });
    expect(d.empty).toBe(true);
    expect(d.since).toBe(HEAD.slice(0, 9));
  });

  it('moved head (even a rebase-only sha change) → NOT empty, re-arm proceeds as today', () => {
    expect(decideEmptyFixRound({ comments: [begin(HEAD)], liveHead: 'b'.repeat(40) }).empty).toBe(false);
  });

  it('compares against the LATEST fix-begin only', () => {
    const d = decideEmptyFixRound({ comments: [begin(HEAD), begin('c'.repeat(40))], liveHead: HEAD });
    expect(d.empty).toBe(false);
  });

  it('fails open: no fix-begin, a forged fix-begin, or an unreadable head never blocks a re-arm', () => {
    expect(decideEmptyFixRound({ comments: [], liveHead: HEAD }).empty).toBe(false);
    expect(decideEmptyFixRound({ comments: [begin(HEAD, { login: 'mallory' })], liveHead: HEAD }).empty).toBe(false);
    expect(decideEmptyFixRound({ comments: [begin(HEAD)], liveHead: '' }).empty).toBe(false);
    expect(decideEmptyFixRound({ comments: null, liveHead: HEAD }).empty).toBe(false);
  });

  it('the no-change comment says the fix is still owed and is NOT counted as a re-arm round', () => {
    const body = buildNoChangeComment({ actor: 'fixer', since: '4288acd6a' });
    expect(body).toContain('no change made — fix still owed');
    expect(body.startsWith(NO_CHANGE_COMMENT_MARKER)).toBe(true);
    expect(countRearmComments([{ body, author: BOT }])).toBe(0);
  });
});

describe('hasUnexpectedPositionals — a stray positional must not skip the empty-round guard (#6713)', () => {
  it('exactly one positive-integer PR is fine', () => {
    expect(hasUnexpectedPositionals(['6713', '--repo=a/b'])).toBe(false);
  });
  it('an extra, a missing, or a non-numeric positional is refused', () => {
    expect(hasUnexpectedPositionals(['6713', '6714'])).toBe(true);
    expect(hasUnexpectedPositionals(['6713', 'oops'])).toBe(true);
    expect(hasUnexpectedPositionals(['--repo=a/b'])).toBe(true);
    expect(hasUnexpectedPositionals(['0'])).toBe(true);
  });
});

describe('hasInvalidArgs — a malformed or typo flag must refuse, never skip the guard (#6713)', () => {
  it('well-formed flags are fine', () => {
    expect(hasInvalidArgs(['6713', '--repo=o/r', '--actor=x', `--expect-head=${'a'.repeat(40)}`])).toBe(false);
  });
  it('an unknown flag that merely starts with a known name is refused', () => {
    expect(hasInvalidArgs(['6713', '--expect-head-typo=x'])).toBe(true);
    expect(hasInvalidArgs(['6713', '--repository=o/r'])).toBe(true);
    expect(hasInvalidArgs(['6713', '--repo'])).toBe(true);
  });
  it('a malformed value for a validated flag is refused', () => {
    expect(hasInvalidArgs(['6713', '--expect-head=abc'])).toBe(true);
    expect(hasInvalidArgs(['6713', '--repo=not a repo'])).toBe(true);
  });
});

describe('decideEmptyFixRound — red-team breaks on #6798', () => {
  const BOT = { login: 'web-everything' };
  const verdict = { body: '🔁 review — changes requested\n\nRecorded by reviewer.', author: BOT };
  const claim = (sha, why = 'conveyor fix: address review', branchLine) => ({
    body: ['🔒 conveyor fix-begin — fix claim held', '', '**Who:** `fix-1`', `**Why:** ${why}`,
      branchLine === undefined ? `**Branch:** \`lane/x\` at \`${sha.slice(0, 9)}\`` : branchLine,
      '', 'The PR stays **ready for review** — a normal repair loop never drafts it.', '<!-- fix-claim who=fix-1 -->']
      .filter((l) => l !== null).join('\n'),
    author: BOT,
  });
  const H0 = 'a'.repeat(40), H1 = 'b'.repeat(40);

  it('orphan recovery of an already-pushed fix is NOT stranded (replayed: claim@H0, push H1, claim@H1)', () => {
    const d = decideEmptyFixRound({ comments: [verdict, claim(H0), claim(H1)], liveHead: H1 });
    expect(d.empty).toBe(false);
  });

  it('a fix pushed after the verdict with no claim in the window: the verdict-named head proves the push (live #6798)', () => {
    const named = { body: `🔁 review — changes requested\n\nconfirmed these on head \`${H0.slice(0, 12)}\` (#1), fix each.`, author: BOT };
    expect(decideEmptyFixRound({ comments: [named, claim(H1)], liveHead: H1 }).empty).toBe(false);
  });

  it('verdict-named head equal to the live head with the claim at it stays empty', () => {
    const named = { body: `🔁 review — changes requested\n\nconfirmed these on head \`${H1.slice(0, 12)}\` (#1)`, author: BOT };
    expect(decideEmptyFixRound({ comments: [named, claim(H1)], liveHead: H1 }).empty).toBe(true);
  });

  it('a send-back resets the window: claims before the latest verdict do not count', () => {
    expect(decideEmptyFixRound({ comments: [claim(H0), verdict, claim(H1)], liveHead: H1 }).empty).toBe(true);
  });

  it('every claim since the send-back at the live head → still empty', () => {
    expect(decideEmptyFixRound({ comments: [verdict, claim(H1), claim(H1)], liveHead: H1 }).empty).toBe(true);
  });

  it('a quoted Branch line inside the free-text Why is NOT the starting sha', () => {
    const why = `quoting\n**Branch:** \`lane/x\` at \`${H1.slice(0, 9)}\``;
    expect(decideEmptyFixRound({ comments: [verdict, claim(H0, why)], liveHead: H1 }).empty).toBe(false);
  });

  it('a real Branch line without a sha plus a spoofed one in Why fails open', () => {
    const why = `x\n**Branch:** \`lane/x\` at \`${H1.slice(0, 9)}\``;
    expect(decideEmptyFixRound({ comments: [verdict, claim(H0, why, '**Branch:** `lane/x`')], liveHead: H1 }).empty).toBe(false);
  });
});

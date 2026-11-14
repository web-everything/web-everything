/**
 * @file scripts/conveyor/__tests__/rearm-review.test.mjs
 * @description Pins the PURE re-arm decision for the conveyor fix agent (WE #2630). `decideRearm` swaps a
 *   repaired `review:changes` bounce back to `review:pending` for re-review — and enforces the #2630 invariant
 *   in the pure core (unbypassable): it NEVER emits `review:accepted` and NEVER removes `review:human`. So the
 *   strongest thing an auto-fix can do is re-arm the review, never clear it. Also pins idempotency (a PR with
 *   no `review:changes` refuses) and the `presentRemoveLabels` narrowing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('orphan replay: verdict names A, claim@A, push B, replacement claim@B, no further push → rearm of the pushed repair (not refused)', () => {
    const named = { body: `🔁 review — changes requested\n\nconfirmed these on head \`${H0.slice(0, 12)}\` (#1), fix each.`, author: BOT };
    expect(decideEmptyFixRound({ comments: [named, claim(H0), claim(H1)], liveHead: H1 }).empty).toBe(false);
    // the replacement's claim repeated (a second replacement at B) must not flip it back to empty
    expect(decideEmptyFixRound({ comments: [named, claim(H0), claim(H1), claim(H1)], liveHead: H1 }).empty).toBe(false);
  });

  // Round 2 breaks on #6798: the window reset and the reviewed-head read must follow EVERY verdict shape the repo writes.
  const REVIEW_PR_VIA = 'Recorded by agent (unattended review-loop) via the declared `review-pr` operation (#3035).';
  const canonicalVerdict = (reviewedHead, heading = '🔁 review — changes requested') => ({
    body: `${heading}\n\n${REVIEW_PR_VIA}\n\n### Findings\n- bad\n\n---\n\nNet basis: \`${'0'.repeat(40)}..${reviewedHead}\` — 3 net changed file(s) vs current main (#2450), not \`gh pr diff\`'s three-dot list.\n\n_Recorded through ${'the declared `review-pr` operation (#3035)'}._`,
    author: BOT,
  });
  const humanVerdict = { body: '🔁 human review — changes requested\n\nFix the guard.', author: BOT };
  const rearmed = { body: '🔧 conveyor fix — re-armed for re-review\n\nrepaired', author: BOT };

  it('a HUMAN changes verdict resets the window: old claim@A must not hide an unchanged round (round-2 break 1)', () => {
    const comments = [verdict, claim(H0), rearmed, humanVerdict, claim(H1)];
    expect(decideEmptyFixRound({ comments, liveHead: H1 }).empty).toBe(true);
  });

  it('every heading spelling of a changes verdict resets the window (— and -, any case, CRLF, leading space)', () => {
    for (const heading of ['🔁 human review — changes requested', '🔁 human review - changes requested', '🔁  Review — Changes Requested', ' 🔁 review — changes requested\r']) {
      const v = { body: `${heading}\n\nx`, author: BOT };
      expect(decideEmptyFixRound({ comments: [claim(H0), v, claim(H1)], liveHead: H1 }).empty, heading).toBe(true);
    }
  });

  it('an untrusted author posting a human heading does not reset the window', () => {
    const forged = { body: '🔁 human review — changes requested\n\nx', author: { login: 'mallory' } };
    expect(decideEmptyFixRound({ comments: [verdict, claim(H0), forged, claim(H1)], liveHead: H1 }).empty).toBe(false);
  });

  it('canonical `Net basis` footer names the reviewed head: pushed repair B is handed back, not stranded (round-2 break 2)', () => {
    // the finding's order: fix-begin at A, THEN the verdict on A (so the claim is wiped from the window), push B, claim at B
    const comments = [claim(H0), canonicalVerdict(H0), claim(H1)];
    expect(decideEmptyFixRound({ comments, liveHead: H1 }).empty).toBe(false);
    // a hand-written human verdict (no structured footer) still names its head through the prose `on head` form
    const human = { body: `🔁 human review — changes requested\n\nreviewed on head \`${H0.slice(0, 12)}\`: fix the guard.`, author: BOT };
    expect(decideEmptyFixRound({ comments: [claim(H0), human, claim(H1)], liveHead: H1 }).empty).toBe(false);
    // the same shape with the claim at A only is still empty at A (nothing pushed)
    expect(decideEmptyFixRound({ comments: [canonicalVerdict(H0), claim(H0)], liveHead: H0 }).empty).toBe(true);
  });

  it('a `reviewed-sha` marker line names the reviewed head too, and a structured head wins over a prose mention', () => {
    const marked = { body: `🔁 review — changes requested\n\non head \`${H1.slice(0, 12)}\` (prose, quoted)\n\n<!-- reviewed-sha: ${H0} -->`, author: BOT };
    expect(decideEmptyFixRound({ comments: [marked, claim(H1)], liveHead: H1 }).empty).toBe(false);
  });

  it('prose fallback: a quoted `on head` line is ignored and the last mention wins (self-review nit)', () => {
    const old = H0.slice(0, 12), cur = H1.slice(0, 12);
    const quotedOnly = { body: `🔁 human review — changes requested\n\n> wrong on head \`${old}\`\n\nfix it`, author: BOT };
    // no usable head → window alone decides: claim at live head stays empty
    expect(decideEmptyFixRound({ comments: [quotedOnly, claim(H1)], liveHead: H1 }).empty).toBe(true);
    const twice = { body: `🔁 human review — changes requested\n\nearlier note on head \`${old}\`\n\nverdict on head \`${cur}\``, author: BOT };
    expect(decideEmptyFixRound({ comments: [twice, claim(H1)], liveHead: H1 }).empty).toBe(true);
  });

  it('a quoted Net basis line inside juror text does not name the reviewed head', () => {
    const quoted = { body: `🔁 review — changes requested\n\n> Net basis: \`${'0'.repeat(40)}..${H0}\` — 3 net changed file(s) vs current main (#2450), not \`gh pr diff\`'s three-dot list.\n\nfix it`, author: BOT };
    expect(decideEmptyFixRound({ comments: [quoted, claim(H1)], liveHead: H1 }).empty).toBe(true);
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

describe('hasInvalidArgs — a repeated flag is ambiguous and refuses (#6798 round 3)', () => {
  it('a duplicated repo/actor/round/main-ref/only-if/expect-head flag is refused', () => {
    for (const f of ['--repo=a/b', '--actor=x', '--round=conflict', '--main-ref=main', '--only-if=accepted', `--expect-head=${'a'.repeat(40)}`]) {
      expect(hasInvalidArgs(['6713', f, f]), f).toBe(true);
    }
    expect(hasInvalidArgs(['6713', '--repo=a/b', '--repo=c/d'])).toBe(true);
  });
  it('one of each distinct flag is still fine', () => {
    expect(hasInvalidArgs(['6713', '--repo=a/b', '--actor=x', '--round=conflict', '--main-ref=main'])).toBe(false);
  });
});

// The CLI wiring (#6798 round 3): run the REAL script with a fake `gh` first on PATH. The fake logs every call and answers
// only the guard's own reads and `pr comment`; anything else (the shared label CLI's reads/writes) fails, so a recorded
// `pr comment` / `pr edit` is exactly "a write happened".
describe('rearm-review.mjs CLI — the empty-round guard wiring', () => {
  // Built from the path: under the happy-dom test environment the global `URL` rejects `new URL(rel, import.meta.url)`.
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../rearm-review.mjs');
  const BOT = { login: 'web-everything' };
  const H0 = 'a'.repeat(40);
  const verdict = { body: '🔁 review — changes requested\n\nRecorded by reviewer.', user: BOT };
  const claim = (sha) => ({
    body: ['🔒 conveyor fix-begin — fix claim held', '', '**Who:** `fix-1`', '**Why:** x', `**Branch:** \`lane/x\` at \`${sha.slice(0, 9)}\``,
      '', '<!-- fix-claim who=fix-1 -->'].join('\n'),
    user: BOT,
  });
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rearm-cli-'));
    writeFileSync(join(dir, 'gh'), [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const a = process.argv.slice(2);",
      "fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');",
      "const sc = JSON.parse(process.env.FAKE_GH_SCENARIO);",
      "const fail = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };",
      "if (a[0] === 'pr' && a[1] === 'view' && a.includes('headRefOid')) { if (sc.failView) fail('view failed'); console.log(JSON.stringify({ headRefOid: sc.head })); }",
      "else if (a[0] === 'api' && String(a[1]).includes('/comments')) { if (sc.failApi) fail('api failed'); console.log(JSON.stringify([sc.comments])); }",
      "else if (a[0] === 'pr' && a[1] === 'comment') { if (sc.failComment) fail('comment failed'); }",
      "else fail('fake gh: unsupported ' + a.join(' '));",
    ].join('\n'));
    chmodSync(join(dir, 'gh'), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args, scenario) => {
    const log = join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`);
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, FAKE_GH_LOG: log, FAKE_GH_SCENARIO: JSON.stringify(scenario || {}) },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const wrote = calls.some((c) => (c[0] === 'pr' && (c[1] === 'comment' || c[1] === 'edit')) || (c[0] === 'api' && c.includes('--method')));
    return { ...r, calls, wrote, out: r.stdout.trim().split('\n').filter(Boolean).pop() ?? '' };
  };
  const EMPTY = { head: H0, comments: [verdict, claim(H0)] };

  it.each([
    ['no positional', ['--repo=o/r']],
    ['two positionals', ['6798', '6799', '--repo=o/r']],
    ['a non-numeric positional', ['oops', '--repo=o/r']],
    ['a bare --repo', ['6798', '--repo']],
    ['a typo flag', ['6798', '--repo=o/r', '--expect-head-typo=x']],
    ['a malformed --expect-head', ['6798', '--repo=o/r', '--expect-head=abc']],
    ['a duplicated --repo', ['6798', '--repo=o/r', '--repo=o/other']],
    ['a duplicated --actor', ['6798', '--repo=o/r', '--actor=a', '--actor=b']],
  ])('refuses %s before ANY gh call', (_n, args) => {
    const r = run(args, EMPTY);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
    expect(r.out).toContain('refused');
    expect(r.calls).toEqual([]);
  });

  it('an empty round is refused with the no-change note posted, and no label write', () => {
    const r = run(['6798', '--repo=o/r', '--actor=fixer'], EMPTY);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, pr: 6798, head: H0.slice(0, 9) }); // the claim's own (9-char) recorded head
    expect(r.out).toContain('no change made');
    const comments = r.calls.filter((c) => c[0] === 'pr' && c[1] === 'comment');
    expect(comments).toHaveLength(1);
    expect(r.calls.some((c) => c[0] === 'pr' && c[1] === 'edit')).toBe(false);
  });

  it('a FAILING `gh pr comment` still refuses the empty round — the note is best-effort, the refusal is not', () => {
    const r = run(['6798', '--repo=o/r'], { ...EMPTY, failComment: true });
    expect(r.status).toBe(1);
    expect(r.out).toContain('no change made');
    expect(r.calls.some((c) => c[0] === 'pr' && c[1] === 'comment')).toBe(true); // the note was attempted
    expect(r.calls.some((c) => c[0] === 'pr' && c[1] === 'edit')).toBe(false);   // …and nothing proceeded to the swap
  });

  it.each([
    ['the head read fails', { ...EMPTY, failView: true }],
    ['the comments read fails', { ...EMPTY, failApi: true }],
  ])('FAILS OPEN when %s: no refusal, no note, control passes to the shared label CLI', (_n, scenario) => {
    const r = run(['6798', '--repo=o/r'], scenario);
    expect(r.out).not.toContain('no change made');
    expect(r.calls.some((c) => c[0] === 'pr' && c[1] === 'comment')).toBe(false);
    // the shared CLI ran after the guard gave up: it issued a gh call that is not one of the guard's two reads
    expect(r.calls.some((c) => !(c[0] === 'pr' && c.includes('headRefOid')) && !(c[0] === 'api' && String(c[1]).includes('/comments')))).toBe(true);
  });

  it('a head that moved since the claim is NOT refused (the pushed fix proceeds to the shared CLI)', () => {
    const r = run(['6798', '--repo=o/r'], { ...EMPTY, head: 'b'.repeat(40) });
    expect(r.out).not.toContain('no change made');
    expect(r.calls.some((c) => c[0] === 'pr' && c[1] === 'comment')).toBe(false);
  });

  it.each([
    ['--round=conflict', ['6798', '--repo=o/r', '--round=conflict']],
    ['--only-if=accepted', ['6798', '--repo=o/r', '--only-if=accepted']],
  ])('%s skips the guard entirely: no head/comments read, no refusal even on an empty round', (_n, args) => {
    const r = run(args, EMPTY);
    expect(r.out).not.toContain('no change made');
    expect(r.calls.some((c) => c[0] === 'api' && String(c[1]).includes('/comments'))).toBe(false);
    expect(r.calls.some((c) => c[0] === 'pr' && c[1] === 'comment')).toBe(false);
  });
});

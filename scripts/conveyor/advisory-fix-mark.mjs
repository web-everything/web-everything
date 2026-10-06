/**
 * advisory-fix-mark.mjs — post the durable ADVISORY-FIX comment on a `review:human` conveyor PR whose fixer
 * addressed an admitted `advisory:changes` finding (#xkmu3gv). The advisory-half sibling of
 * `we:scripts/conveyor/ci-heal-mark.mjs`, with the SAME deliberate shape: a durable marker comment, NO label
 * swap of any kind.
 *
 * WHY NO LABEL SWAP. The advisory finding lives entirely OUTSIDE the human review ceremony —
 * `we:scripts/operations/review-pr.mjs`'s `advise` step never calls `decideSetLabel`, and there is no
 * `review:changes` on this population to "re-arm" in the sense `we:scripts/conveyor/rearm-review.mjs` means
 * it (this population is `needs-human` + `advisory:changes`, never `bounced`). So the strongest thing a fixer
 * that repairs the finding can do — exactly the same non-negotiable `rearm-review.mjs`'s own header states for
 * the ordinary case — is post evidence that it acted. This file NEVER touches `review:human`, NEVER adds
 * `review:accepted`, and NEVER touches any `advisory:*` label itself: only the NEXT `advise` run (a fresh
 * `review` dispatch, already owed by `we:scripts/conveyor/reconcile-core.mjs`'s `needs-human` phase once this
 * marker outnumbers the advisory-note count) may change those, by judging the repaired head fresh.
 *
 * WHY A DURABLE COMMENT (mirrors #2643/#2666). `reconcile-core.mjs` bounds this population's auto-fix at its
 * OWN, smaller cap (`ADVISORY_FIX_ROUND_CAP`, #xkmu3gv — see that constant's own docblock) so a genuinely
 * unfixable advisory finding cannot flap forever; that cap must survive a conveyor RESTART, which wipes any
 * in-session tally. Each completed advisory-fix round posts exactly ONE comment whose leading line is
 * {@link ADVISORY_FIX_COMMENT_MARKER}, and the count IS PR state, read back off the PR's own thread — no
 * parallel state store (#2612 invariant).
 *
 * Scripted per [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment] (#2607): "was this
 * advisory finding already fixed" is a pure, script-decidable count over the PR's comments — it lives here as
 * a pure function the reconcile pass shells, never a rule the fix-agent brief re-derives in prose.
 */
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { ADVISORY_NOTE_MARKER } from './advisory-round-count.mjs';
// #xconv1-evidence (web-everything/web-everything#2766/#2767 misfire) — a CONVERTED advisory note
// (`we:scripts/lib/review-escalation.mjs#renderConvertedAdvisoryNote`, posted by
// `we:scripts/conveyor/convert-advisory-dispatch.mjs`) carries its OWN leading marker, never
// `ADVISORY_NOTE_MARKER` (that one is `renderAdvisoryNote`'s, in `we:scripts/operations/review-pr.mjs`). Both
// functions below used to recognize ONLY `ADVISORY_NOTE_MARKER` as "an advisory note is here" — so a PR whose
// only advisory note was a CONVERTED one (#2766/#2767's exact shape) never had a `lastNoteIndex` at all:
// {@link isLatestAdvisoryFindingAddressed} returned `false` UNCONDITIONALLY, no matter what a fixer posted
// afterward, and `we:scripts/conveyor/reconcile-core.mjs`'s advisory-fix branch kept re-dispatching a fixer that
// could never mechanically prove "addressed" — CONFIRMED as the reason 3 advisory-fix rounds each correctly
// found nothing to fix and still burned the cap to `cap-exhausted (3/3)`. `isTrustedAdvisoryNote` below is the one
// place both leading-line checks are widened to accept EITHER marker, so the two counters can never drift apart
// on which notes exist again.
import { CONVERTED_ADVISORY_NOTE_MARKER } from '../lib/review-escalation.mjs';
import { STAND_DOWN_MARKER, isSelfAuthored } from './stand-down.mjs';
import { REARM_COMMENT_MARKER } from './rearm-review.mjs';

/** #xconv1-evidence — pure: is comment `c` a TRUSTED advisory note — its leading line EITHER shape of note (a
 *  fresh `advise`-step one, or a converted #xconv1 one) AND its author passes `isTrustedMarkerAuthor`?
 *  Single-sourced so {@link countCompletedAdvisoryEpisodes}, {@link isLatestAdvisoryFindingAddressed} and
 *  {@link isAdvisoryMechanismStandDownSuperseded} can never disagree on what counts as "a note happened here".
 *  The trust gate lives HERE, not at each call site (PR #2800 advisory finding): when only the episode counter
 *  gated it, a forged note from any login kept the "addressed" check false forever while every genuine fix
 *  landed inside an already-completed episode — the cap never fired. A bare string carries no author, so fails.
 * @param {{body?:string, author?:{login?:string}, viewerDidAuthor?:boolean}|string} c
 * @returns {boolean}
 */
function isTrustedAdvisoryNote(c) {
  const body = typeof c === 'string' ? c : c?.body;
  if (typeof body !== 'string') return false;
  const head = body.trimStart();
  return (head.startsWith(ADVISORY_NOTE_MARKER) || head.startsWith(CONVERTED_ADVISORY_NOTE_MARKER))
    && isTrustedMarkerAuthor(c);
}
// #3383 — the shared trusted-author gate every marker COUNTER runs a comment through (broader than
// `isSelfAuthored` above: automation OR the repo operator). `isSelfAuthored` stays in use, unchanged, for the
// two narrower ORDER-based supersede checks below — that is a distinct, already-reviewed discipline
// (xaer296/#2607), not something this item's fix widens or narrows.
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

/**
 * we:scripts/conveyor/advisory-fix-mark.mjs#ADVISORY_FIX_COMMENT_MARKER — the stable FIRST LINE of the durable
 * advisory-fix comment. Single-sourced and used two ways: the CLI POSTS a comment starting with it on every
 * completed advisory-fix round, and {@link countAdvisoryFixComments} MATCHES it to recover the attempt count.
 * Distinct from every other marker in this repo (`REARM_COMMENT_MARKER`, `CI_HEAL_COMMENT_MARKER`,
 * `STAND_DOWN_MARKER`, `CONFLICT_FIX_COMMENT_MARKER`, `ADVISORY_NOTE_MARKER`) so no two durable floors can ever
 * cross-count. Treat this line as fixed — changing it orphans the count on every open advisory-fixed PR's
 * existing history.
 */
export const ADVISORY_FIX_COMMENT_MARKER = '🔧 conveyor fix — advisory finding addressed (#xkmu3gv)';

/**
 * we:scripts/conveyor/advisory-fix-mark.mjs#countAdvisoryFixComments — the DURABLE, restart-surviving
 * advisory-fix attempt count for a PR (#xkmu3gv). Pure — the caller passes the PR's `comments` exactly as
 * `gh pr view <pr> --json comments` returns them (`[{ body }]`); a bare-string array is tolerated too. A
 * comment is counted only when the marker is its LEADING line (`trimStart().startsWith`, the same narrowing
 * every sibling counter in this repo uses), so a human quoting the comment in a reply never inflates the count.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @returns {number} the number of conveyor advisory-fix comments on the PR (0 for a non-array / empty input)
 */
export function countAdvisoryFixComments(comments) {
  if (!Array.isArray(comments)) return 0;
  let n = 0;
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    // #3383 — a forged advisory-fix marker from an untrusted login must not inflate this population's round cap.
    if (typeof body === 'string' && body.trimStart().startsWith(ADVISORY_FIX_COMMENT_MARKER) && isTrustedMarkerAuthor(c)) n += 1;
  }
  return n;
}

/**
 * we:scripts/conveyor/advisory-fix-mark.mjs#buildAdvisoryFixComment — the durable comment body a completed
 * advisory-fix round posts. Its FIRST line MUST be {@link ADVISORY_FIX_COMMENT_MARKER} (single-sourced) so
 * posting and counting can never drift. Pure.
 * @param {{ actor?:string }} o
 * @returns {string}
 */
export function buildAdvisoryFixComment({ actor = 'conveyor fix agent' } = {}) {
  return [
    ADVISORY_FIX_COMMENT_MARKER,
    '',
    `${actor} addressed the admitted advisory finding above and re-pushed HEAD.`,
    'This did NOT touch `review:human`, `review:pending`, `review:changes`, or any `advisory:*` label, and did ' +
      'NOT record a verdict. A fresh independent review is owed next (the reconcile pass dispatches it once ' +
      'this comment outnumbers the prior advisory note) — it re-runs the advisory pass on this new head and ' +
      'posts the next real verdict; only that step, or the operator\'s own `/review`, may change any label.',
  ].join('\n');
}

/**
 * we:scripts/conveyor/advisory-fix-mark.mjs#countCompletedAdvisoryEpisodes — xconv1-evidence follow-up
 * (web-everything/web-everything#2766/#2767, 2026-09-27): the advisory-fix CAP must count COMPLETED EPISODES (one
 * advisory note through to the fix that unlocked the NEXT one), never raw fix-mark COMMENTS — a distinction
 * the lifetime `countAdvisoryFixComments` collapses, exactly the kind of count-vs-something-truer gap
 * {@link isLatestAdvisoryFindingAddressed} already closed once for the "addressed" question (xaer296/#2549).
 *
 * THE BUG THIS CLOSES, CONFIRMED LIVE 2026-09-27. Once the #xconv1-evidence fix landed,
 * `isLatestAdvisoryFindingAddressed` correctly recognized #2766/#2767's CONVERTED note as "a note" — but by
 * then the PR's history already held 3 advisory-fix-mark comments, ALL posted back-to-back UNDER the OLD
 * (broken) code, in response to that SAME ONE converted note, because the old bug meant no review ever
 * dispatched between them to advance the episode. A later, INDEPENDENT review then posted a brand-new, GENUINE
 * advisory note — a completely different finding the three prior fixes never touched — and `reconcile-core.mjs`
 * compared the LIFETIME fix-mark count (3, unchanged forever) against `advisoryFixCap` (3) and refused
 * `cap-exhausted`, with ZERO attempts ever made against the actual current finding.
 *
 * A NAIVE FIX (scope the count to "fix-marks since the latest note", tried and REJECTED here) is UNSAFE: in
 * the mechanism's own normal, healthy operation, `isLatestAdvisoryFindingAddressed` flips `addressed` true the
 * MOMENT one fix-mark follows a note, which immediately dispatches the cap-EXEMPT review that posts the NEXT
 * note — so a "since latest note" count would reset to 0 on every single healthy cycle, making the cap
 * unenforceable: a PR whose finding is NEVER actually fixed (jury keeps finding it broken, forever) would cycle
 * fix→review→fix→review with NO limit, exactly the unbounded-flap failure (#2117/#2298) this whole mechanism
 * exists to prevent. Proven by the pre-existing test this file's own suite already carried ("AT the cap …
 * still behind the note count) the PR is refused `cap-exhausted`" — that fixture is 3 GENUINE completed
 * episodes (note→fix→note→fix→note→fix→note), and a "since latest note" count reads it as 0 attempts against
 * the final note, wrongly allowing a 4th round.
 *
 * THE ACTUAL FIX. Count COMPLETED EPISODES, not fix-mark comments: an episode is "one advisory note", and it
 * is COMPLETE once a (trusted) fix-mark exists anywhere between it and the NEXT note (or, for the latest note,
 * anywhere after it). This correctly reads the pre-existing test's 3-note/3-fix fixture as 3 completed episodes
 * (unchanged, cap-exhausted — SAFE, still bounded) — and correctly reads #2766/#2767's history as exactly ONE
 * completed episode (the 3 fix-marks all landed inside the SAME episode, before the mechanism bug let it ever
 * advance to a second note), leaving 2 of 3 lifetime episodes still available for the brand-new finding a
 * later, independent review actually raised. Multiple fixes clustered inside one still-broken episode (the
 * live shape) can never buy EXTRA tries — they still count as exactly one completed episode toward the SAME
 * lifetime cap — so this is strictly no less safe than the count it replaces, only fairer to a finding that
 * has never had a real attempt of its own.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @returns {number}
 */
export function countCompletedAdvisoryEpisodes(comments) {
  if (!Array.isArray(comments)) return 0;
  const noteIndices = [];
  for (let i = 0; i < comments.length; i += 1) {
    // #2800 advisory finding — a note's position is an episode BOUNDARY feeding the cap, so it takes the same
    // trusted-author gate as `advisory-round-count.mjs#countAdvisoryComments`: a forged note from any other
    // login must not split one finding's fix attempts into extra spent episodes.
    if (isTrustedAdvisoryNote(comments[i])) noteIndices.push(i);
  }
  // #2800 advisory finding, Codex advisory follow-up — BOUNDED FALLBACK. GitHub lets a comment be edited or
  // deleted, so the SOLE advisory note a finding depends on can vanish from the thread entirely while
  // `advisory:changes` (a separate, sticky LABEL) survives. With `noteIndices` empty, the per-note-episode loop
  // below never runs and this used to return 0 FOREVER no matter how many trusted advisory-fix marks
  // accumulated — `isLatestAdvisoryFindingAddressed` independently stays `false` too (no note to postdate), so
  // `reconcile-core.mjs`'s advisory-fix branch's own `advisoryFixes >= advisoryFixCap` check never tripped and
  // nothing ever bounded repeated fixer dispatch.
  //
  // THE FALLBACK, AND WHY IT SUBTRACTS ONE. Falling back to the raw TRUSTED fix-mark count
  // (`countAdvisoryFixComments`, the same trust gate every other counter here uses) ties this rare, note-less
  // case directly back to the real cap — but this file's own PRE-EXISTING pinned coverage (the "forged note
  // alone" fixture just above this function's own test file) already established, deliberately, that a single
  // trusted fix-mark with NO trusted note anywhere — the shape a lone forged/untrusted note plus one genuine fix
  // produces — reads as ZERO completed episodes: one lone, unanchored mark is not on its own proof of a spent
  // episode (a fixer can legitimately post one mark before the very first review ever runs, e.g. mid-restart
  // bookkeeping). So this fallback gives that SAME one-mark benefit of the doubt here too (`- 1`, floored at 0)
  // rather than counting the very first unanchored mark — and then counts every mark AFTER it 1-for-1, so
  // accumulation still converges on `advisoryFixCap` in a small, FINITE number of further dispatches. This can
  // only ever OVER-count relative to the normal note-anchored semantics once marks pile up (never under-count
  // past the first), so it can never let a genuinely-broken finding evade the #2117/#2298 flap-protection cap,
  // and it never fires at all once even one trusted note is still on the thread (the ordinary, healthy case
  // below is completely unchanged).
  if (noteIndices.length === 0) return Math.max(0, countAdvisoryFixComments(comments) - 1);
  let completed = 0;
  for (let k = 0; k < noteIndices.length; k += 1) {
    const start = noteIndices[k] + 1;
    const end = k + 1 < noteIndices.length ? noteIndices[k + 1] : comments.length;
    for (let j = start; j < end; j += 1) {
      const c = comments[j];
      const body = typeof c === 'string' ? c : c?.body;
      if (typeof body === 'string' && body.trimStart().startsWith(ADVISORY_FIX_COMMENT_MARKER) && isTrustedMarkerAuthor(c)) {
        completed += 1;
        break; // one completed episode per note, however many fix-marks piled up inside it
      }
    }
  }
  return completed;
}

/**
 * we:scripts/conveyor/advisory-fix-mark.mjs#isLatestAdvisoryFindingAddressed — xaer296 (epic #3383): has the
 * MOST RECENT advisory note already been addressed by a fix round, ORDER-wise rather than COUNT-wise? Pure.
 *
 * THE BUG THIS REPLACES. `reconcile-core.mjs`'s advisory-fix branch used to compare
 * `countAdvisoryFixComments(comments) < countAdvisoryComments(comments)` — a raw COUNT comparison that only
 * holds when the two histories start at parity (0/0) and move in lockstep, one-for-one. That assumption breaks
 * the moment a `review:human` PR already has advisory-note HISTORY from before this marker mechanism existed
 * (any PR with `review-round` > 1 the day #xkmu3gv shipped): CONFIRMED LIVE on `web-everything/web-everything#2549`
 * — 5 advisory-panel comments already on the thread (review rounds 1-5, all pre-dating #xkmu3gv) and exactly
 * ONE advisory-fix mark ever posted (the round that genuinely fixed the CURRENT, latest finding). `1 < 5` stays
 * true FOREVER under the old test — no number of further genuine fixes ever catches up to a backlog of
 * historical notes that were never going to get their own dedicated fix round — so the reconcile pass kept
 * re-dispatching a fixer at an already-fixed PR, twice (14:29Z, 14:35Z), until the second one (finding nothing
 * to reproduce) wrongly stood down.
 *
 * THE FIX. The real question was never "how many fixes vs. how many notes, ever" — it is "was THE FINDING THE
 * PR CURRENTLY CARRIES already fixed", which is an ORDER question: does a fix-mark comment appear AFTER the
 * LATEST advisory note? `comments` arrives in GitHub's own chronological order (array order = posting order,
 * the same assumption `we:scripts/conveyor/stand-down.mjs#isStandDownSuperseded` already relies on), so this is
 * a plain index scan, no timestamp parsing needed.
 *
 * A PR with NO advisory note at all (should not reach this function via `reconcile-core.mjs`'s own
 * `ADVISORY_LABELS.CHANGES`-gated call site, but a caller passing a bare/malformed thread is not unreasonable)
 * returns `false` — nothing to address is not "addressed".
 *
 * The fix-mark must be SELF-AUTHORED (`stand-down.mjs#isSelfAuthored`, the same check its sibling
 * {@link isAdvisoryMechanismStandDownSuperseded} applies). A `true` here routes the PR to a review dispatch that
 * is EXEMPT from `NEGOTIATION_ROUND_CAP`, so a forged mark (anyone who can comment) re-posted every tick would
 * otherwise keep the PR cycling through cap-exempt reviews forever, never reaching `cap-exhausted` and never
 * escalating to a human (PR #2607 review). A bare string or a non-automation author fails closed.
 * @param {Array<{body?:string, viewerDidAuthor?:boolean, author?:{login?:string}}|string>|null|undefined} comments
 * @returns {boolean}
 */
export function isLatestAdvisoryFindingAddressed(comments) {
  if (!Array.isArray(comments)) return false;
  let lastNoteIndex = -1;
  for (let i = 0; i < comments.length; i += 1) {
    // #2800 — only a TRUSTED note can be "the latest finding"; a forged one must not pin `addressed` false.
    if (isTrustedAdvisoryNote(comments[i])) lastNoteIndex = i;
  }
  if (lastNoteIndex === -1) return false;
  for (let j = lastNoteIndex + 1; j < comments.length; j += 1) {
    const body = typeof comments[j] === 'string' ? comments[j] : comments[j]?.body;
    if (typeof body === 'string' && body.trimStart().startsWith(ADVISORY_FIX_COMMENT_MARKER)
      && isSelfAuthored(comments[j])) return true;
  }
  return false;
}

/**
 * we:scripts/conveyor/advisory-fix-mark.mjs#isAdvisoryMechanismStandDownSuperseded — xaer296 (epic #3383): is
 * the stand-down at `index` a fix agent's OWN escalation that the thread itself already PROVES was a mechanism
 * failure, not a genuine judgment call? PURE. The sibling of
 * `we:scripts/conveyor/stand-down.mjs#isStandDownSuperseded` (which covers only the parked-PR conflict watch's
 * OWN prior stand-down, re-classified by a LATER watch sweep) for a DIFFERENT population: a fixer dispatched
 * into ADVISORY-FIX MODE that could not reproduce the finding — because {@link isLatestAdvisoryFindingAddressed}
 * was ALREADY true when it ran — and (per the pre-fix brief) wrongly stood down instead of posting the hand-back
 * marker (CONFIRMED LIVE, `web-everything/web-everything#2549`, 2026-09-24T14:35:41Z).
 *
 * UNLIKE the watcher's own supersede, this needs NO new comment posted to become non-terminal: the proof that
 * the finding was already addressed BEFORE the stand-down already lives on the thread (the fix-mark's own
 * position relative to the latest advisory note), so this is a pure re-read, not a write waiting to happen —
 * the daemon's very next tick self-heals a PR in this exact shape with no operator action at all, which is the
 * whole point (per this repo's own "failure is an opportunity to improve the product, never a manual fix" rule).
 *
 * SAFE, NARROWLY: ALL of these must hold —
 *   1. the comment at `index` is a stand-down (leading-line {@link STAND_DOWN_MARKER}) and self-authored
 *      (`stand-down.mjs#isSelfAuthored` — `author.login` against `AUTOMATION_LOGINS`, or GitHub's
 *      `viewerDidAuthor` as an additional accepted path; a forged body can never satisfy either, the same
 *      fail-closed direction `isStandDownSuperseded` uses);
 *   2. among every comment BEFORE it, the latest advisory note already has a SELF-AUTHORED advisory-fix mark
 *      after it — i.e. {@link isLatestAdvisoryFindingAddressed} was already true at the moment this fixer ran;
 *   3. no trusted re-arm or review verdict separates that mark from the stand-down. These boundaries end its
 *      cycle; an old fix must never answer a later cycle's escalation (#3507). fix-begin/fix-end are not
 *      boundaries — every fixer brackets its own mark or stand-down with them.
 * A stand-down with no advisory-note history before it (unrelated to this population), or one posted before
 * any fix-mark existed (a genuine, still-current judgment call), is NEVER superseded by this check.
 * @param {Array<{body?:string, viewerDidAuthor?:boolean}|string>|null|undefined} comments
 * @param {number} index
 * @returns {boolean}
 */
export function isAdvisoryMechanismStandDownSuperseded(comments, index) {
  if (!Array.isArray(comments)) return false;
  const c = comments[index];
  const body = typeof c === 'string' ? c : c?.body;
  if (typeof body !== 'string' || !body.trimStart().startsWith(STAND_DOWN_MARKER)) return false;
  if (!isSelfAuthored(c)) return false;
  const before = comments.slice(0, index);
  let lastNoteIndex = -1;
  for (let i = 0; i < before.length; i += 1) {
    if (isTrustedAdvisoryNote(before[i])) lastNoteIndex = i;
  }
  if (lastNoteIndex === -1) return false;
  let fixedInCycle = false;
  for (let j = lastNoteIndex + 1; j < before.length; j += 1) {
    const b = before[j];
    const bBody = typeof b === 'string' ? b : b?.body;
    if (typeof bBody !== 'string') continue;
    const head = bBody.trimStart();
    // Verdict headings come from we:scripts/review-set-label.mjs#buildVerdictComment.
    // Leading markers and trusted authors keep quoted/forged bookkeeping from changing the cycle.
    // fix-begin / fix-end are NOT boundaries: a fixer posts fix-begin before any stand-down and fix-end after
    // its hand-back mark, so treating either as one would un-supersede the exact #2549 shape.
    if (isTrustedMarkerAuthor(b) && (
      head.startsWith(REARM_COMMENT_MARKER) || /^(?:✅|🔁|📌) review — /.test(head)
    )) fixedInCycle = false;
    if (head.startsWith(ADVISORY_FIX_COMMENT_MARKER) && isSelfAuthored(b)) {
      fixedInCycle = true;
    }
  }
  return fixedInCycle;
}

// ── IO SHELL (runs only as a CLI — the pure exports above stay side-effect-free on import) ────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flags = {};
  const positionals = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else positionals.push(a);
  }
  const fail = (m) => {
    process.stderr.write(`✗ ${m}\n`);
    process.exit(1);
  };
  const pr = Number(positionals[0]);
  if (!Number.isInteger(pr) || pr <= 0) {
    fail('usage: advisory-fix-mark.mjs <pr> [--repo=<owner/name>] [--actor=<name>]  (pr must be a positive integer)');
  }
  const body = buildAdvisoryFixComment({
    actor: typeof flags.actor === 'string' ? flags.actor : undefined,
  });
  const args = ['pr', 'comment', String(pr), '--body', body];
  if (typeof flags.repo === 'string') args.push(`--repo=${flags.repo}`); // the fix agent runs in its WE lane clone; a missing --repo derives from cwd.
  try {
    execFileSync('gh', args, { /* #74c write-only call: stdout is never read, so it is not captured (nothing to overflow or truncate) */ stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  } catch (e) {
    fail(`could not post advisory-fix comment on PR #${pr}: ${String(e.message || e).split('\n')[0]}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, pr, commented: true }) + '\n');
}

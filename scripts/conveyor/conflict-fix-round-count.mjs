/**
 * @file scripts/conveyor/conflict-fix-round-count.mjs
 * @description THE DURABLE, RESTART-SURVIVING ATTEMPT COUNT FOR A MECHANICAL CONFLICT-RESOLUTION ROUND (#xkmu3gv).
 *   Mirrors `we:scripts/conveyor/advisory-round-count.mjs`'s own shape and reason for existing, for a population
 *   that neither the ordinary rearm marker nor the advisory marker can see.
 *
 * WHY ITS OWN MARKER AND CAP, NOT `REARM_COMMENT_MARKER` / `NEGOTIATION_ROUND_CAP`. `we:scripts/conveyor/
 * reconcile-core.mjs`'s shared round cap (5) exists to stop ordinary review<->fix PING-PONG — a human/AI
 * reviewer raises a substantive finding, a fixer addresses it, a human re-verdicts, repeat. A mechanical
 * conflict-resolution round is a DIFFERENT kind of work — rebase-and-resolve against `main`, never judgment over
 * a reviewer's finding — introduced by `origin/lane/xdhidso-review-human-statute-fixer` (PR #2577): a
 * `review:human`, statute-tier merge conflict that does not overlap `main`'s own edits since the merge base is
 * routed to the fixer via `we:scripts/conveyor/reconcile-finding.mjs`, which bounces the PR `review:changes`
 * exactly like an ordinary reviewer finding would. CONFIRMED LIVE, 2026-09-24: `web-everything/web-everything#2549`
 * had already spent 5 of 5 ordinary rounds (`review-round:5`) by the time #2577's routing rule newly offered it
 * a mechanical conflict fix — `runReconcilePass` refused it `cap-exhausted` before the fixer ever ran, even
 * though ZERO conflict-resolution rounds had ever actually run on this PR (real `runReconcilePass({repo:
 * 'web-everything/web-everything'})`, no writes). Mirrors `we:scripts/conveyor/reconcile-core.mjs#CI_HEAL_ROUND_CAP`'s
 * own reasoning exactly: a different KIND of round needs its own floor, never a shared one that lets a PR burn
 * through one cap doing the other kind's work.
 *
 * BUILD AND COUNT SHARE ONE MARKER SO THEY CAN NEVER DRIFT. `we:scripts/conveyor/rearm-review.mjs`'s CLI posts a
 * comment starting with {@link CONFLICT_FIX_COMMENT_MARKER} when invoked `--round=conflict` — the SAME
 * `review:changes → review:pending` swap an ordinary rearm makes (a mechanical conflict fix still hands back to
 * the SAME human-ceremony-only gate; `review:human` is never touched either way) — only the comment's marker
 * differs, so this population's rounds can never silently inflate `countRearmComments`, and vice versa.
 *
 * WHY A NEW LEAF FILE AND NOT A CONSTANT INSIDE `reconcile-fix-dispatch.mjs` or `parked-pr-conflict-watch.mjs`.
 * Both of those carry a wide, impure import graph; this file stays a leaf so `we:scripts/conveyor/reconcile-core.mjs`
 * — deliberately PURE and leaf-light — can depend on it with no new edge to anything heavy. Same reasoning
 * `advisory-round-count.mjs`'s own header states for itself. #3383 adds ONE import,
 * `we:scripts/lib/marker-authorship.mjs` — itself a true leaf (no imports of its own, reads only `process.env`)
 * — so this file's own leaf-lightness is unchanged.
 *
 * PURE. No fs, no clock, no network. Reads `process.env` (via the one leaf import) for the trusted-login
 * overrides.
 *
 * #2787 LIVE INCIDENT (2026-09-27) ADDS {@link countStaleConflictFixRounds}. `countConflictFixComments` counts
 * every completed round, full stop — it cannot tell "the same conflict, still stuck" apart from "a fresh
 * conflict, because the target moved on and the mechanism keeps working just fine". `web-everything/web-everything`
 * PR #2787 spent all 3 of its rounds on a stacked base that got rebased twice then landed entirely (three
 * genuine SUCCESSES against three different targets), then was refused `cap-exhausted` on the first-ever
 * main-base conflict it hit afterward. See that function's own docblock for the fix. `countConflictFixComments`
 * itself is UNCHANGED and still exported (its only remaining caller is this file's own test suite, kept for
 * the raw-count assertions the new function's `total` now duplicates via a different path — a regression here
 * would show up in both).
 */
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

/**
 * we:scripts/conveyor/conflict-fix-round-count.mjs#CONFLICT_FIX_COMMENT_MARKER — the stable FIRST LINE of the
 * durable comment a completed mechanical conflict-resolution round posts. Single-sourced HERE:
 * `we:scripts/conveyor/rearm-review.mjs` (`--round=conflict`) POSTS a comment starting with it, and
 * {@link countConflictFixComments} MATCHES it. Treat this line as fixed — changing it orphans the count on
 * every open conflict-routed PR's existing history.
 */
export const CONFLICT_FIX_COMMENT_MARKER = '🔧 conveyor fix — conflict resolved and re-armed (mechanical round, #xkmu3gv)';

/**
 * we:scripts/conveyor/conflict-fix-round-count.mjs#countConflictFixComments — how many mechanical
 * conflict-resolution rounds have already run against this PR, read back off its OWN comment thread (#xkmu3gv).
 * Pure — the caller passes the PR's `comments` exactly as `gh pr view <pr> --json comments` returns them
 * (`[{ body }]`); a bare-string array is tolerated too. A comment is counted only when the marker is its
 * LEADING line (`trimStart().startsWith`, the same narrowing every sibling counter in this repo uses), so a
 * human quoting the comment in a reply never inflates the count.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @returns {number} the number of conveyor conflict-fix comments on the PR (0 for a non-array / empty input)
 */
export function countConflictFixComments(comments) {
  if (!Array.isArray(comments)) return 0;
  let n = 0;
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    // #3383 — a forged conflict-fix marker from an untrusted login must not inflate this population's round cap.
    if (typeof body === 'string' && body.trimStart().startsWith(CONFLICT_FIX_COMMENT_MARKER) && isTrustedMarkerAuthor(c)) n += 1;
  }
  return n;
}

/**
 * we:scripts/conveyor/conflict-fix-round-count.mjs#CONFLICT_FIX_TARGET_TRAILER — a completed round's OPTIONAL,
 * machine-parseable trailer line, `<!-- conveyor-conflict-fix-target: <ref>@<sha> -->` — the ref this round
 * resolved against, and its tip's sha AT THE TIME (both read locally, off the fix agent's own lane checkout —
 * never a fresh `gh` call). Single-sourced HERE: `we:scripts/conveyor/rearm-review.mjs` (ordinary main-base
 * rounds) and `we:scripts/conveyor/conflict-fix-mark.mjs` (stacked-base rounds) both POST it when they can
 * resolve the sha; {@link parseConflictFixTarget} reads it back. See {@link countStaleConflictFixRounds}'s own
 * docblock for why a round's TARGET, not merely its existence, is what the cap must key on (PR #2787 live
 * incident, 2026-09-27).
 */
export const CONFLICT_FIX_TARGET_TRAILER_RE = /<!--\s*conveyor-conflict-fix-target:\s*(\S+)@([0-9a-f]{7,40})\s*-->/i;

/** A stacked-base round's own free-text body already names its ref (`we:scripts/conveyor/conflict-fix-mark.mjs
 *  #buildConflictFixMarkComment`: "resolved this PR's conflict against `<ref>`") — this recovers just the REF
 *  (never a sha) from that older, pre-trailer phrasing, so a comment posted before the trailer existed still
 *  narrows correctly by ref. */
const CONFLICT_FIX_FREE_TEXT_REF_RE = /conflict (?:resolved )?against `([^`]+)`/i;

/**
 * we:scripts/conveyor/conflict-fix-round-count.mjs#parseConflictFixTarget — what target (ref, and sha where
 * known) did ONE completed conflict-fix round resolve against? Pure string parsing, no IO.
 * @param {string} body - a comment body whose leading line is {@link CONFLICT_FIX_COMMENT_MARKER}.
 * @param {string} defaultRef - the ref to report when nothing in the body names one (an ordinary main-base
 *   round's own marker text never has — it is only ever `main`, so it never needed to say so).
 * @returns {{ref:string, sha:string|null}}
 */
export function parseConflictFixTarget(body, defaultRef) {
  const text = typeof body === 'string' ? body : '';
  const trailer = CONFLICT_FIX_TARGET_TRAILER_RE.exec(text);
  if (trailer) return { ref: trailer[1], sha: trailer[2].toLowerCase() };
  const freeText = CONFLICT_FIX_FREE_TEXT_REF_RE.exec(text);
  if (freeText) return { ref: freeText[1], sha: null };
  return { ref: defaultRef, sha: null };
}

/**
 * we:scripts/conveyor/conflict-fix-round-count.mjs#countStaleConflictFixRounds — PR #2787 LIVE INCIDENT
 * (2026-09-27): `countConflictFixComments` counts every completed mechanical conflict-resolution round, full
 * stop — but a round that genuinely SUCCEEDED still posts the SAME marker as one that is stuck, so a PR whose
 * conflict target keeps moving (a stacked base rebased twice, then landed and the PR retargeted to `main`; or,
 * just as easily, an ordinary main-base PR that keeps colliding with fresh work because `main` is simply moving
 * fast tonight) burns through {@link CONFLICT_FIX_ROUND_CAP} on repairs that each fully worked, and is then
 * refused `cap-exhausted` on the FIRST genuinely-stuck round — exactly backwards from what the cap is for.
 *
 * THE FIX: count a historical round against the cap ONLY when it resolved the SAME target this PR is STILL
 * conflicting against RIGHT NOW — same ref, and (when both sides know a sha) the same sha. A round against a
 * DIFFERENT ref (a stacked base that later became `main`, or vice versa), or the SAME ref at an EARLIER sha
 * (main/base moved since), is evidence the mechanism is working — new work keeps arriving, not that resolving
 * it is failing — so it does not count toward the per-target cap.
 *
 * THAT ALONE COULD RETRY FOREVER for a target that truly never stops moving (every round would look "fresh" by
 * construction, no matter how many actually ran) — `total` is the hard ceiling's own input
 * ({@link CONFLICT_FIX_ABSOLUTE_CEILING} in `reconcile-core.mjs`): the RAW count of every completed round ever,
 * regardless of staleness, so a PR that needed an unreasonable number of rounds of ANY kind still escalates to
 * a person.
 *
 * BACKWARD COMPATIBLE WITH EVERY EXISTING COMMENT: a round posted before this trailer existed still narrows
 * correctly by REF (either the stacked-base marker's own pre-existing free text, or the implicit `currentRef`
 * default for an ordinary main-base round, which never named one because it was always `main`) — only the
 * FINER same-ref-different-sha distinction needs the new trailer, and degrades safely (sha unknown → treated as
 * matching, the pre-existing conservative behaviour) when it is absent.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @param {{currentRef:string, currentSha?:string|null}} o - what this PR is conflicting against RIGHT NOW.
 *   `currentSha` is `null` when the caller has none to offer (every existing caller, until `reconcile-pass.mjs`
 *   is threaded — see `reconcile-core.mjs#planReconcile`'s own `mainSha` param) — the sha comparison then never
 *   distinguishes (ref-only), the same safe default as before this function existed.
 * @returns {{stale:number, total:number}} `stale` is what the per-target cap binds on; `total` is what the hard
 *   ceiling binds on. `stale <= total` always.
 */
export function countStaleConflictFixRounds(comments, { currentRef, currentSha = null } = {}) {
  if (!Array.isArray(comments)) return { stale: 0, total: 0 };
  let stale = 0;
  let total = 0;
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body !== 'string' || !body.trimStart().startsWith(CONFLICT_FIX_COMMENT_MARKER)) continue;
    if (!isTrustedMarkerAuthor(c)) continue; // #3383 — a forged marker must not inflate either count.
    total += 1;
    const { ref, sha } = parseConflictFixTarget(body, currentRef);
    if (ref !== currentRef) continue; // resolved a DIFFERENT target — fresh work, never a repeat failure.
    if (sha != null && currentSha != null && sha !== currentSha) continue; // same ref, but it has since moved.
    stale += 1;
  }
  return { stale, total };
}

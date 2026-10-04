/**
 * @file scripts/conveyor/advisory-round-count.mjs
 * @description THE DURABLE, RESTART-SURVIVING ATTEMPT COUNT FOR A `review:human` PR'S ADVISORY ROUNDS (#3383).
 *   Mirrors `we:scripts/conveyor/rearm-review.mjs#countRearmComments`'s own shape and reason for existing, for
 *   a population that marker cannot see.
 *
 * THE GAP THIS CLOSES — confirmed LIVE on `web-everything/web-everything#2117`: 33 separate advisory-panel comments
 * posted against the SAME "Findings (7)" content between 2026-09-15T00:24Z and 2026-09-15T19:13Z (roughly every
 * 20-90 minutes, no end condition), and a further burst on `#2298` on 2026-09-18/19. Both PRs carry
 * `review:changes` + `review:human`, so `classifyPr` (`we:scripts/progress-board.mjs`) reads them as `bounced`
 * and `we:scripts/conveyor/reconcile-core.mjs#planReconcile` dispatches a `fix` round for each, capped by
 * `NEGOTIATION_ROUND_CAP` (5) — BUT the cap is fed by `attempts = countRearmComments(pr.comments)`, and
 * `countRearmComments` counts the marker `we:scripts/conveyor/rearm-review.mjs` posts ONLY when a bounced PR is
 * successfully repaired and re-armed `review:changes → review:pending`. A PR whose fix round never actually
 * completes a rearm (the repair keeps failing, stalling, or getting reassigned) never posts that marker — so
 * `attempts` stays 0 forever, no matter how many rounds actually ran, and `attempts >= roundCap` never fires.
 * What DOES post once per completed round for exactly this population is the automatic advisory-panel comment
 * `we:scripts/operations/review-pr.mjs`'s `advise` step posts on every run against a `review:human` PR
 * (#xlw02hw) — it runs unconditionally, independent of whether the round goes on to repair/rearm anything.
 * Counting THOSE recovers "how many times this PR has actually been run against" from the PR's own durable
 * thread — no parallel state store (#2612 invariant), same discipline `countRearmComments` already uses.
 *
 * BUILD AND COUNT SHARE ONE MARKER SO THEY CAN NEVER DRIFT (the same rule `REARM_COMMENT_MARKER` states for
 * itself). `renderAdvisoryNote` (`we:scripts/operations/review-pr.mjs`) imports {@link ADVISORY_NOTE_MARKER}
 * from HERE and opens its comment with it; changing the wording changes it in the one place both sides read.
 *
 * WHY A NEW LEAF FILE AND NOT A CONSTANT INSIDE `review-pr.mjs`. `review-pr.mjs` is the operation declaration —
 * heavy, with a wide import graph (codex/antigravity judge-spawn, model-probation, the whole jury core). Pulling
 * that into `we:scripts/conveyor/reconcile-core.mjs`, which is deliberately PURE and leaf-light (no fs, no
 * clock, no process, no network — see that file's own header), would be exactly the kind of drift risk this
 * repo's "widen the shared thing, don't grow a private copy" rule exists to prevent. This file stays a leaf —
 * either side can depend on it with no new edge to anything heavy. #3383 adds ONE import,
 * `we:scripts/lib/marker-authorship.mjs`, itself a true leaf (no imports of its own, reads only `process.env`).
 *
 * PURE. No fs, no clock, no network. Reads `process.env` (via the one leaf import) for the trusted-login
 * overrides.
 */
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

/**
 * we:scripts/conveyor/advisory-round-count.mjs#ADVISORY_NOTE_MARKER — the stable FIRST LINE of the automatic
 * advisory-panel comment `we:scripts/operations/review-pr.mjs#renderAdvisoryNote` renders. Single-sourced HERE,
 * exactly as `REARM_COMMENT_MARKER` is single-sourced in `rearm-review.mjs`: the renderer opens its comment with
 * this literal, and {@link countAdvisoryComments} matches it, so the two can never say two different things.
 * Treat this as fixed — changing it orphans the count on every open `review:human` PR's existing thread (an
 * already-run PR would read as zero advisory rounds again, reopening the exact unbounded-redispatch bug this
 * file exists to close).
 */
export const ADVISORY_NOTE_MARKER = '**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.**';

/**
 * we:scripts/conveyor/advisory-round-count.mjs#countAdvisoryComments — how many times the automatic advisory
 * panel has already run against this PR, read back off its OWN comment thread (#3383). Pure — the caller passes
 * the PR's `comments` exactly as `gh pr view <pr> --json comments` returns them (`[{ body }]`); a bare-string
 * array is tolerated too. A comment counts only when the marker is its LEADING line (`trimStart().startsWith`,
 * the same narrowing `countRearmComments` uses), so a human quoting the advisory comment in a reply — or citing
 * it from a different PR — never inflates the count.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @returns {number} the number of advisory-panel comments on the PR (0 for a non-array / empty input)
 */
export function countAdvisoryComments(comments) {
  if (!Array.isArray(comments)) return 0;
  let n = 0;
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    // #3383 — a forged advisory-note marker from an untrusted login must not inflate this durable count.
    if (typeof body === 'string' && body.trimStart().startsWith(ADVISORY_NOTE_MARKER) && isTrustedMarkerAuthor(c)) n += 1;
  }
  return n;
}

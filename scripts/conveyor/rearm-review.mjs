/**
 * rearm-review.mjs — re-arm a repaired conveyor fix PR for re-review after a `review:changes` bounce (#2630).
 *
 * THE ONE LABEL SWAP THE FIX AGENT IS ALLOWED TO MAKE. When a conveyor-launched PR is bounced `review:changes`
 * (a human ran `/review` and requested changes), the conveyor auto-spawns a FIX AGENT into that PR's lane (see
 * `we:skills-src/conveyor/fix-agent-brief.md`). The fix agent repairs the reviewer's finding, gets the gate
 * green, re-pushes HEAD to the `lane/*` ref — then hands the PR BACK for re-review by calling this script. It
 * swaps `review:changes → review:pending` so the drain's AI-review convergence pass (or a human) re-verdicts.
 *
 * THE INVARIANT THIS ENFORCES (the whole point — #2630): the fix agent NEVER self-clears the human review gate.
 * The `rearm` decision NEVER emits `review:accepted` and NEVER removes `review:human`. A repaired bounce goes
 * back to `review:pending` (an independent re-review is owed); if the PR also carried `review:human` (a gate-self
 * edit), that label STAYS — only a human's `/review` ceremony may clear it. So the strongest thing an auto-fix
 * can do is re-arm the review, never pass it.
 *
 * #2644 — this file is now a THIN SHIM over `we:scripts/review-set-label.mjs`. It USED to clone that file
 * byte-for-byte (`presentRemoveLabels` / `ghErr` copied verbatim, the whole gh view→decide→edit→comment→re-read
 * CLI harness duplicated); the jury (PR #702, simplicity lens) flagged the duplicated label-swap I/O boundary as
 * drift-prone. The re-arm swap is now the third target of the shared PURE `decideSetLabel` (`to: 'rearm'`), and
 * the CLI is the shared `runReviewLabelCli`. Only the three real deltas live here: the comment body, the default
 * `--actor`, and the optional-`--repo` fallback. The refusal STILL lives in the pure core, so the CLI cannot
 * route around it. Scripted per [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment] (#2607).
 */
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decideSetLabel, runReviewLabelCli, presentRemoveLabels } from '../review-set-label.mjs';
import { CONFLICT_FIX_COMMENT_MARKER } from './conflict-fix-round-count.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

// we:scripts/conveyor/rearm-review.mjs — re-export the shared narrowing helper on this module's surface so the
// fix-agent brief's entrypoint and the pinned tests keep importing it from here (it is single-sourced next door).
export { presentRemoveLabels };

/**
 * we:scripts/conveyor/rearm-review.mjs#REARM_COMMENT_MARKER — the stable FIRST LINE of the durable re-arm comment.
 * It is single-sourced HERE and used two ways: the CLI POSTS a comment starting with it on every re-arm, and
 * {@link countRearmComments} MATCHES it to recover the attempt count from the PR (#2643). Build and count share
 * ONE marker so they can never drift. Treat this line as fixed: changing it orphans the count on every open fix
 * PR's existing history (an already-burned PR would read as zero attempts again — the very reset #2643 fixes).
 */
export const REARM_COMMENT_MARKER = '🔧 conveyor fix — re-armed for re-review';

/**
 * we:scripts/conveyor/rearm-review.mjs#countRearmComments — the DURABLE, restart-surviving auto-fix attempt count
 * for a PR (#2643). Every completed auto-fix cycle posts exactly ONE re-arm comment (first line
 * {@link REARM_COMMENT_MARKER}), so counting those comments recovers "how many times this PR was auto-fixed and
 * re-armed" from the PR ITSELF — the retry cap then binds even after a conveyor restart wipes the in-session
 * `fixAttempts` map (the exact unbounded fix↔bounce loop #2643 exists to prevent). This keeps NO parallel state
 * store (#2612 invariant): the count IS PR state, read back off the durable comment thread the re-arm swap already
 * writes through the board's normal verbs. Pure — the caller passes the PR's `comments` exactly as
 * `gh pr view <pr> --json comments` returns them (`[{ body }]`); a bare-string array is tolerated too. A comment
 * is counted only when the marker is its leading line (`trimStart().startsWith`), so a human QUOTING the re-arm
 * comment in a reply never inflates the count.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @returns {number} the number of conveyor re-arm comments on the PR (0 for a non-array / empty input)
 */
export function countRearmComments(comments) {
  if (!Array.isArray(comments)) return 0;
  let n = 0;
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    // #3383 — a forged re-arm marker from an untrusted login must not inflate the negotiation-round cap.
    if (typeof body === 'string' && body.trimStart().startsWith(REARM_COMMENT_MARKER) && isTrustedMarkerAuthor(c)) n += 1;
  }
  return n;
}

/**
 * we:scripts/conveyor/rearm-review.mjs#decideRearm — the PURE re-arm decision. Now a THIN alias over the shared
 * `decideSetLabel({ to: 'rearm' })` (#2644): given the PR's OBSERVED labels, return the label swap that hands a
 * repaired `review:changes` bounce back for re-review. Kept as a named export so callers/tests read the intent
 * (`decideRearm`) rather than the generic verdict target. Every rule below is enforced in the shared pure core
 * (unbypassable):
 *   • ONLY a PR that currently carries `review:changes` can be re-armed. Anything else → `allowed:false` (an
 *     idempotent no-op: a second call after the swap refuses cleanly rather than double-applying).
 *   • The swap is ALWAYS `review:changes → review:pending`: drop the bounce, add "an independent review is
 *     owed". NEVER `review:accepted` — an auto-fix may never clear the review.
 *   • `review:human` is NEVER removed. If the bounce also carried the human gate (a gate-self edit), it stays;
 *     the re-armed PR is `review:human` + `review:pending`, still human-ceremony-only.
 * @param {{currentLabels?:Array}} o - `currentLabels` is the observed label array (string or `{name}` shape).
 * @returns {{allowed:boolean, addLabel:string, removeLabels:string[], keepsHuman:boolean, reason:string}}
 */
export function decideRearm({ currentLabels = [] } = {}) {
  return decideSetLabel({ to: 'rearm', currentLabels });
}

/**
 * we:scripts/conveyor/rearm-review.mjs#resolveLocalRefSha — #2787 live incident (2026-09-27): what did an
 * ORDINARY (main-base) conflict-fix round just resolve against? Reads `origin/<ref>`'s own tip, LOCALLY, off
 * the CALLER's cwd — this CLI runs inside the fix agent's own lane checkout, which just fetched and merged/
 * rebased that exact ref to resolve the conflict, so the read costs nothing (no `gh` call, no GraphQL/REST
 * budget exposure) and is trivially fresh. Best-effort: `execFileSync` throwing (no such ref locally, a
 * checkout `rearm-review.mjs` is not run from, no git on PATH) degrades to `null` — the comment is then posted
 * WITHOUT the trailer, exactly as it always was before this existed, never a hard failure of the hand-back
 * itself (a lost sha is a strictly smaller loss than a lost re-arm).
 * @param {string} ref
 * @returns {string|null}
 */
export function resolveLocalRefSha(ref) {
  try {
    const out = execFileSync('git', ['rev-parse', `origin/${ref}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    const sha = String(out || '').trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * we:scripts/conveyor/rearm-review.mjs#conflictFixTargetTrailer — the OPTIONAL trailer line
 * {@link CONFLICT_FIX_TARGET_TRAILER_RE} parses back, or `''` when `sha` is unresolvable (no trailer at all —
 * see {@link resolveLocalRefSha}'s own docblock for why this degrades silently rather than failing the hand-back).
 * @param {string} ref
 * @param {string|null} sha
 * @returns {string}
 */
export function conflictFixTargetTrailer(ref, sha) {
  return sha ? `\n\n<!-- conveyor-conflict-fix-target: ${ref}@${sha} -->` : '';
}

/** Render the observed verdict transition; a CI heal is not necessarily a bounced review. */
export function buildRearmComment({ actor, decision }) {
  return [
    REARM_COMMENT_MARKER,
    '',
    `${decision.rearmFrom === 'missing'
      ? 'The healed PR had no review label; independent review is being requested'
      : decision.rearmFrom === 'review:accepted'
      ? 'The previously accepted PR was re-pushed and its acceptance is being re-armed for review'
      : 'The `review:changes` bounce was repaired and re-pushed'} by ${actor}; ${decision.keepsHuman
      ? '`review:human` is KEPT as the sole hold — `review:pending` was not added (an independent review is already owed while the human hold stands; only a human `/review` ceremony clears it).'
      : decision.rearmFrom === 'missing'
        ? '`review:pending` is requested. This comment records the request; the completion result reports whether the label write was verified.'
        : 'the PR is re-armed `review:pending` (an independent re-review is owed).'}`,
    '',
    'The fix agent did NOT clear the review — a human `/review` (or the drain AI-review convergence pass) re-verdicts.',
  ].join('\n');
}

// we:scripts/conveyor/rearm-review.mjs — allow importing the pure decider without running the CLI (the test file
// imports this module). The standard main check used across the conveyor scripts.
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  // #xkmu3gv — `--round=conflict` selects the MECHANICAL conflict-resolution comment/marker
  // (`CONFLICT_FIX_COMMENT_MARKER`, its own smaller `we:scripts/conveyor/reconcile-core.mjs#CONFLICT_FIX_ROUND_CAP`,
  // #xkmu3gv) instead of the ordinary rearm marker. THE LABEL SWAP ITSELF IS IDENTICAL EITHER WAY — the SAME
  // `review:changes → review:pending` (never `review:accepted`, never removes `review:human`) the shared pure
  // `decideSetLabel({ to: 'rearm' })` decides; only which durable floor this completed round counts against, and
  // the comment text explaining why, differs. See `conflict-fix-round-count.mjs`'s own header for why a
  // mechanical conflict-resolution round needs its own cap rather than sharing `countRearmComments`'s.
  const roundArg = (process.argv.find((a) => a.startsWith('--round=')) || '').slice('--round='.length);
  const isConflictRound = roundArg === 'conflict';
  // #2787-live-incident — the ordinary conflict-fix round is, by construction, always against the repo's
  // default branch; `--main-ref=` lets a non-`main`-default repo say so, defaulting to `'main'` (every
  // constellation repo today) so no existing caller needs to change.
  const mainRefArg = (process.argv.find((a) => a.startsWith('--main-ref=')) || '').slice('--main-ref='.length) || 'main';
  // we:scripts/conveyor/rearm-review.mjs — the fix-agent re-arm CLI: the shared harness with the three deltas
  // this caller supplies (the comment body, the default --actor, the optional --repo fallback). The re-arm
  // swap + its refusal are the shared pure `decideSetLabel({ to: 'rearm' })` — this file adds no invariant.
  runReviewLabelCli({
    fixedTo: 'rearm',
    defaultActor: 'conveyor fix agent',
    repoOptional: true, // the fix agent runs inside its WE lane clone, so a missing --repo derives from cwd.
    usage: 'usage: rearm-review.mjs <pr> [--repo=<owner/name>] [--actor=<name>] [--round=conflict] [--main-ref=<name>] [--only-if=accepted|missing] [--expect-head=<sha>]  (pr must be a positive integer)',
    // The DURABLE re-arm comment — a readable record that the bounce was repaired and re-armed (not a silent
    // flip), AND the durable tally the matching counter reads back to survive a restart (#2643). Its first line
    // MUST be the matching marker (single-sourced) so posting and counting can never drift.
    // #x01u7az — the rearmed-state sentence must say what the label swap ACTUALLY did, not assume `review:pending`
    // always lands: on a `review:human` PR `decideSetLabel` now adds NOTHING (the human hold is already the
    // pending-review signal; see that function's own comment for the live bug — PR #2549, 2026-09-24 — this
    // closure's old unconditional "re-armed `review:pending`" text used to describe verbatim). Both branches read
    // `decision.keepsHuman` once and render one of two true sentences instead of one sentence plus a footnote.
    buildComment: isConflictRound
      ? ({ actor, decision }) => [
          CONFLICT_FIX_COMMENT_MARKER,
          '',
          `A mechanical conflict-resolution round (no other edits) was applied by ${actor}; ${decision.keepsHuman
            ? '`review:human` is KEPT as the sole hold — `review:pending` was not added (an independent review is already owed while the human hold stands; only a human `/review` ceremony clears it).'
            : 'the PR is re-armed `review:pending` (an independent re-review is owed).'}`,
          '',
          'The fix agent did NOT clear the review — a human `/review` (or the drain AI-review convergence pass) re-verdicts. ' +
            'This round is counted against its OWN, smaller conflict-fix cap (#xkmu3gv), never the ordinary negotiation cap.',
          // #2787-live-incident — the trailer below records what this round actually resolved against, so a
          // LATER round against a NEWER `main` (main moved and created a fresh conflict, the mechanism working
          // exactly as intended) is not misread as this same round recurring — see
          // `conflict-fix-round-count.mjs#countStaleConflictFixRounds`'s own docblock. Omitted (no trailer at
          // all) when the local sha is unresolvable — see `resolveLocalRefSha`'s own docblock.
        ].join('\n') + conflictFixTargetTrailer(mainRefArg, resolveLocalRefSha(mainRefArg))
      : buildRearmComment,
    successResult: ({ pr, labels }) => ({ ok: true, pr, rearmed: true, labels, round: isConflictRound ? 'conflict' : 'ordinary' }),
    refusalResult: ({ pr, decision }) => ({ ok: false, pr, reason: decision.reason }),
  });
}

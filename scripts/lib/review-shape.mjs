/** Pure shape derivation shared by the CLI and in-process review operation.
 * Keep CLI evidence loading out of daemon and promotion import closures. */
import { CARE_LEVELS, scoreEscalation } from './review-escalation.mjs';
import { routeReviewShape } from './decision-routing.mjs';
import { reviewNeedFor } from './review-need.mjs';
import { PANEL_LENSES } from './review-core.mjs';

/**
 * #3335 — THE SHAPE A TOUCH-SET EARNS. PURE. The derivation a review CALLER runs BEFORE it composes the run
 * command, because the caller is the only actor that holds the touch-set at that moment: `review-pr`'s `read` is
 * step 1 and is what computes `netChangedFiles`, and `--resume` refuses input flags on purpose, so the shape
 * cannot be revised once the run has started.
 *
 * IT COMPOSES; IT DOES NOT RE-TAXONOMIZE. Two calls, no third opinion:
 *   • `scoreEscalation({changedFiles})` (`we:scripts/lib/review-escalation.mjs`) → `reasons` / `humanRequired`;
 *   • `routeReviewShape({changedFiles, escalation})` (`we:scripts/lib/decision-routing.mjs`) → the care level,
 *     `panelRigorForCareLevel`'s `rounds` / `jurorsPerLens`, the lens set and the mandatory floor.
 * The care level this returns is `scoreEscalation`'s own, so it agrees with `rigor --reasons=<these reasons>` by
 * construction rather than by coincidence — `careLevelFromReasons` is the reasons→care bridge for a consumer
 * that holds only the decorated strings, and both roads end at `deriveCareLevel`. A named test drives both.
 *
 * WHAT IS #3309's AND NOT THIS ITEM'S. `routeReviewShape` / `classifyReviewSubject` decide WHICH SUBJECT is under
 * review (code vs prose) and therefore which lens VOCABULARY the seats draw from; they deliberately do not dial
 * rigor. That axis is REUSED here, not re-derived — `subject`, `earnedLenses` and `mandatoryFloor` are its output
 * passed through. This item owns the caller-side half: reaching that derivation from a file list, declaring the
 * result to the operation, and letting `read` refuse a declaration the PR contradicts.
 *
 * `--lens` SUBSTITUTES, IT DOES NOT ADD, which is why `seatLens` is reported separately from `earnedLenses`.
 * `review-pr` has exactly ONE caller-chosen seat (`judge`); `--lens` replaces what that seat judges under, and
 * pointing it at an advisory lens DISPLACES the mandatory `correctness` seat rather than adding a check. So the
 * honest reading for a one-seat operation is TWO BANDS, not four:
 *   • `careLevel === 'none'` — the dial asks for no panel at all, so the floor lens is proportionate.
 *   • anything escalated — one seat cannot deliver what the dial asks, so the seat goes to a MANDATORY lens
 *     (`seatLens`) and the SHORTFALL (`earnedLenses` minus what actually sat) is recorded rather than implied away.
 *
 * @param {{changedFiles?: string[], careLevel?: string}} o - `changedFiles` is the PR's touch-set, from
 *   `gh pr view <pr> --json files --jq '[.files[].path]'`; `careLevel` overrides the derived band and is ignored
 *   unless it names a real one (`routeReviewShape`'s own rule).
 * @returns {{careLevel: string, reasons: string[], humanRequired: boolean, earnedLenses: string[],
 *   mandatoryFloor: string[], subject: string, rounds: number, jurorsPerLens: number, seatLens: string,
 *   escalated: boolean, changedFiles: string[], trail: string[]}}
 */
export function buildShapePlan({ changedFiles = [], careLevel, commits = null, diffHunks, readOnlyOps } = {}) {
  const files = (Array.isArray(changedFiles) ? changedFiles : [])
    .filter((f) => typeof f === 'string' && f.trim().length > 0)
    .map((f) => f.trim());
  // Hunks are shadow evidence only; keep every current shape field on the historical file-only score.
  const escalation = scoreEscalation({ changedFiles: files, readOnlyOps, proposalDiffHunks: diffHunks });
  // The score is handed ACROSS so the router does not pay for a second `scoreEscalation` over the same list —
  // and, more importantly, so the reasons printed below and the subject routed here are provably one score.
  const plan = routeReviewShape({ changedFiles: files, escalation, careLevel });
  return {
    careLevel: plan.careLevel,
    reasons: [...escalation.reasons],
    humanRequired: escalation.humanRequired === true,
    humanRequiredProposed: escalation.humanRequiredProposed,
    humanRequiredProposedReason: escalation.humanRequiredProposedReason,
    earnedLenses: [...plan.lenses],
    mandatoryFloor: [...plan.mandatoryLenses],
    subject: plan.subject,
    rounds: plan.rounds,
    jurorsPerLens: plan.jurorsPerLens,
    seatLens: plan.seatLens,
    // STATED, NOT ASSUMED: `review-pr`'s `input.lens` enum is `[...PANEL_LENSES]`, and #3309's decision-prose
    // lens set (`root-cause` / `completeness`) is not in it. So on the prose route the seat lens this reports is
    // the RIGHT one and is not reachable from the command line today — wiring that vocabulary into the operation
    // is #3309's follow-on, not this item, and a caller must be told rather than handed a flag that is refused.
    seatLensReachable: PANEL_LENSES.includes(plan.seatLens),
    escalated: plan.careLevel !== CARE_LEVELS.NONE,
    changedFiles: files,
    trail: [...plan.trail],
    need: reviewNeedFor({ changedFiles, careLevel, commits }),
  };
}


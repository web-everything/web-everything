/**
 * decision-prose-adapter.mjs — the DECISION-PROSE subject adapter (#2657, S5 of epic #2649).
 *
 * WHY: the jury METHOD lives once in the subject-agnostic core (`jury-core.mjs`, the #2656 F2 seam); each SUBJECT
 * plugs in through a THIN adapter that satisfies `SUBJECT_ADAPTER_CONTRACT`. This module adds the DECISION-PROSE
 * subject: judging a proposed DECISION APPROACH in PROSE, before any code exists — exactly what the PLAN-HANDSHAKE
 * already does. So this adapter is deliberately THIN: it reuses the shipped plan-handshake primitives
 * (`buildPlanMandate` / `buildPlanCritiqueMandate` / `derivePlanOutcome` in `review-core.mjs`) as the subject's
 * grounding method and mandate framing, and adds only the small amount of contract wiring the F2 seam needs. It
 * does NOT re-implement a prose-review loop — the plan handshake IS that loop.
 *
 * THE LENS-SET. The plan-handshake critic judges whether an approach "targets the right root cause and is complete
 * enough to implement" (`buildPlanCritiqueMandate`). Those are exactly the two perspectives a decision earns:
 * `root-cause` (does it fix the real cause, not a symptom?) and `completeness` (is it complete enough to build
 * from?). Both are MANDATORY — an approach that misses the root cause or is too incomplete to implement is not
 * "agreed", the same bar `derivePlanOutcome` already enforces.
 *
 * THE GROUNDING METHOD. `plan-critique` — an independent peer critiques the prose approach (the existing
 * plan-handshake critic). It is CALLABLE today (nothing new to build): the adapter's `resolveMethods` names it, and
 * the adapter's `buildMandate` delegates to `buildPlanCritiqueMandate`. The full proposer↔critic loop
 * (`buildPlanMandate` + `derivePlanOutcome`, with its own tighter `PLAN_ROUND_CAP`) is re-exported so a
 * decision-prose consumer gets the whole handshake through this one module.
 *
 * Pure — no I/O, no model calls. Unit-tested in `scripts/lib/__tests__/decision-prose-adapter.test.mjs`.
 */
import { buildSubjectMandate } from './jury-core.mjs';
import {
  buildPlanMandate,
  buildPlanCritiqueMandate,
  derivePlanOutcome,
  PLAN_ROUND_CAP,
  PLAN_OUTCOMES,
} from './review-core.mjs';

// Re-export the plan-handshake primitives so a decision-prose consumer gets the whole proposer↔critic loop through
// this adapter module — the "thin over the existing plan-handshake" wiring, single-sourced (no re-implementation).
export { buildPlanMandate, buildPlanCritiqueMandate, derivePlanOutcome, PLAN_ROUND_CAP, PLAN_OUTCOMES };

/** The two decision-prose lenses (#2657) — the perspectives the plan-handshake critic already judges an approach
 *  under. A frozen enum so every consumer names them once. */
export const DECISION_PROSE_LENSES = Object.freeze({
  ROOT_CAUSE: 'root-cause',   // does the approach target the real root cause, not a symptom?
  COMPLETENESS: 'completeness', // is the approach complete enough to implement from?
});

/** The full decision-prose lens-set, in root-cause / completeness order. */
export const DECISION_PROSE_LENS_SET = Object.freeze([
  DECISION_PROSE_LENSES.ROOT_CAUSE,
  DECISION_PROSE_LENSES.COMPLETENESS,
]);

/** Both decision lenses are MANDATORY — an approach that misses the root cause OR is too incomplete to build from
 *  is not "agreed" (the same bar `derivePlanOutcome` enforces). A tuning knob (exported, not hardcoded per caller).
 *
 *  INVARIANT (same as the design-pixels subject): these mandatory lenses ride the TOUCH-SET, not the static care
 *  band that `resolveRoster` prepends — so they are present exactly when there IS a decision under review (a
 *  non-empty `hasDecisionInput`). A downstream `derivePanelVerdict({ mandatoryLenses })` is valid only over a roster
 *  resolved for a real decision; for empty input it throws "missing verdict for mandatory lens" (loud, never a
 *  silent pass). Note this subject's PRIMARY loop is the plan handshake (`derivePlanOutcome`), which never touches
 *  `mandatoryLenses` at all — the invariant only matters if a caller also runs the generic panel reducer over it. */
export const DECISION_PROSE_MANDATORY_LENSES = DECISION_PROSE_LENS_SET;

/** The methods that can GROUND a decision-prose lens (#2657). One method: `plan-critique`, the existing
 *  plan-handshake critic. A frozen enum so every consumer names it once. */
export const DECISION_PROSE_METHODS = Object.freeze({
  PLAN_CRITIQUE: 'plan-critique', // an independent peer critiques the prose approach (the plan-handshake critic)
});

/** The decision-prose method registry (#2657) — `plan-critique` grounds both decision lenses. Pure data. No method
 *  is deferred: the plan-handshake is callable today (unlike the design-pixels subject's screenshot grounding). */
export const DECISION_PROSE_METHOD_REGISTRY = Object.freeze([
  Object.freeze({
    id: DECISION_PROSE_METHODS.PLAN_CRITIQUE,
    label: 'plan-handshake critic (critiques the prose approach)',
    grounds: Object.freeze([...DECISION_PROSE_LENS_SET]),
    deferred: false,
  }),
]);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Does this decision-prose input carry a decision to judge (#2657)? Pure. The input is the approach / task prose —
 * a non-empty string, or an object with a non-empty `approach` or `task` field. Empty input → no decision under
 * review, so `extractTouchSet` earns no lenses (the same empty-input → empty-lenses posture the other subjects
 * take).
 * @param {string|{approach?: string, task?: string}} [input]
 * @returns {boolean}
 */
export function hasDecisionInput(input) {
  if (isNonEmptyString(input)) return true;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return isNonEmptyString(input.approach) || isNonEmptyString(input.task);
  }
  return false;
}

/**
 * The grounding method(s) for one decision-prose lens (#2657) — the subject's `resolveMethods`. Pure. Returns a
 * FRESH single-element array naming `plan-critique` for a known decision lens, or an EMPTY array for a lens the
 * decision registry does not know (e.g. a subject-neutral care-band lens `resolveRoster` prepends). The decision
 * subject grounds only its OWN lenses, through the plan handshake.
 * @param {string} lens
 * @returns {string[]}
 */
export function decisionMethodsForLens(lens) {
  return DECISION_PROSE_LENS_SET.includes(lens) ? [DECISION_PROSE_METHODS.PLAN_CRITIQUE] : [];
}

/**
 * Build the decision-prose review mandate (#2657) — the subject's `buildMandate`. THIN: it delegates to the shipped
 * `buildPlanCritiqueMandate` (the plan-handshake critic that judges a prose approach, with its untrusted-input data
 * fence and root-cause/completeness framing already built in), so the decision-prose review mandate IS the plan
 * critique mandate — no second copy of that prose. The `mandate`/`lens` params are accepted for adapter-shape
 * parity with the other subjects' `buildMandate`, but the plan critic already judges both decision lenses at once,
 * so they do not change the delegated text.
 * @param {{approach?: string, round?: number, roundCap?: number}} [o]
 * @returns {string}
 */
export function buildDecisionMandate({ approach = '', round = 1, roundCap = PLAN_ROUND_CAP } = {}) {
  return buildPlanCritiqueMandate({ approach, round, roundCap });
}

/**
 * A subject-neutral framing preface for a decision-prose review (#2657), built on the shared `buildSubjectMandate`
 * skeleton — the same skeleton the PR-diff and design-pixels subjects frame on. Pure. Proves the decision subject
 * uses the shared framing too; a caller that wants the generic "you are reviewing a <subject> …" opening (rather
 * than the full plan-critic mandate `buildDecisionMandate` returns) can use this. Anchors findings to a `passage`
 * of the prose.
 * @param {{mandate?: string|string[]}} [o]
 * @returns {string}
 */
export function buildDecisionFraming({ mandate } = {}) {
  return buildSubjectMandate({
    subjectNoun: 'decision approach',
    mandate: mandate ?? [...DECISION_PROSE_LENS_SET],
    defaultMandate: DECISION_PROSE_LENSES.ROOT_CAUSE,
    isolationLine: 'You see the proposed approach in PROSE — before any code exists; judge the approach, not an implementation.',
    findingAnchor: 'passage',
    bodyLines: ['Do NOT write code or a diff at this phase; judging the approach is the whole task.'],
  });
}

/**
 * THE DECISION-PROSE SUBJECT ADAPTER (#2657) — the plug that snaps the decision-prose subject into the #2656 F2
 * seam. Conforms to `SUBJECT_ADAPTER_CONTRACT` (validated by `validateSubjectAdapter`), so `resolveAdapterRoster`
 * builds a decision-review roster from it exactly as it does from `PR_DIFF_ADAPTER` — the core knows nothing about
 * prose. Deliberately THIN — its method and mandate are the existing plan handshake:
 *   • `extractTouchSet` — a decision under review earns both decision lenses (`hasDecisionInput` gates it).
 *   • `resolveMethods`  — the decision lens → `plan-critique` (`decisionMethodsForLens`).
 *   • `mandatoryLenses` — root-cause + completeness (both must hold for the approach to be "agreed").
 *   • `charterForLens`  — the decision-specific juror charter text (passed to `materializeRoster`).
 *   • `buildMandate`    — delegates to `buildPlanCritiqueMandate` (the shipped plan critic).
 * Frozen so the adapter is a stable value other modules can import and compare against.
 */
export const DECISION_PROSE_ADAPTER = Object.freeze({
  subject: 'decision-prose',
  subjectNoun: 'decision approach',
  mandatoryLenses: DECISION_PROSE_MANDATORY_LENSES,
  extractTouchSet: (input) => (hasDecisionInput(input) ? [...DECISION_PROSE_LENS_SET] : []),
  resolveMethods: (lens) => decisionMethodsForLens(lens),
  charterForLens: (lens) => `judge whether the decision approach is sound under the "${lens}" lens`,
  buildMandate: buildDecisionMandate,
});

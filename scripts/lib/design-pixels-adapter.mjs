/**
 * design-pixels-adapter.mjs — the DESIGN-PIXELS subject adapter (#2657, S5 of epic #2649).
 *
 * WHY: the jury METHOD lives once in the subject-agnostic core (`jury-core.mjs`, the #2656 F2 seam); each SUBJECT
 * plugs in through a THIN adapter that satisfies `SUBJECT_ADAPTER_CONTRACT`. The reference adapter is
 * `PR_DIFF_ADAPTER` (`review-core.mjs`) — the PR-diff subject. THIS module adds the DESIGN-PIXELS subject: judging
 * a RENDERED design (screenshots / DOM), not a code diff. It declares the #2576 design-review lens-set
 * (usability / visual / a11y / design-systems) and the grounding methods that ground each lens in evidence, then
 * wraps them in a contract-conforming `DESIGN_PIXELS_ADAPTER` that snaps into `resolveAdapterRoster` exactly like
 * the reference adapter does — the core needs to know nothing about pixels.
 *
 * THE #2576 LENS-SET. The jury-refinement method proven on the icon grammar (#2576) judges a UI/design decision
 * under four perspectives: `usability` (is it usable / low-friction?), `visual` (does it match the target design?),
 * `a11y` (is it accessible?), and `design-systems` (does it conform to the system's tokens / patterns?). These are
 * the extra PERSPECTIVE lenses this subject earns (returned by `extractTouchSet`) — the abstract `touchLenses`
 * signal `resolveRoster` merges onto the care band, the same mechanism the PR-diff subject uses for its a11y /
 * visual-vs-target / perf lenses.
 *
 * THE GROUNDING METHODS. Each lens is grounded by a tool:
 *   • `usability` + `design-systems` → `design-heuristic-review` — a reviewer subagent judges the rendered design
 *     against usability / design-system heuristics (the callable, ships-now grounding).
 *   • `a11y` → `axe-scan` — an automated accessibility scan over the rendered UI (callable; the same tool id the
 *     PR-diff subject's a11y lens uses, so a runner keys on ONE consistent method-id string across subjects).
 *   • `visual` → `screenshot-vs-target` — a screenshot of the rendered design compared against a target/baseline
 *     image. This was registered DEFERRED in #2657 (no primitive yet); #2671 WIRES IN the shared comparator
 *     (`visual-comparator.mjs`, from #2670), so the method now has a CALLABLE FORM: `groundVisualLens(...)` runs the
 *     real automated screenshot-vs-baseline diff and returns a grounded `{ grounded, match, delta, findings }`
 *     verdict. A runner resolves it via `runnerForDesignMethod('screenshot-vs-target')`. The by-eye fallback is
 *     PRESERVED for the one case the comparator itself documents as a skip — a surface with NO committed baseline:
 *     the comparator returns `skipped`, `groundVisualLens` reports `{ grounded: false, byEye: true }`, and the juror
 *     judges the visual match by eye and marks the lens ungrounded (a skip is never a fail).
 *
 * THE I/O SEAM. The lens classification + mandate framing (`classifyDesignTouchSet`, `designMethodsForLens`,
 * `buildDesignMandate`) stay PURE — no I/O, no model calls. The only I/O is the visual grounding runner
 * (`groundVisualLens` → `compareToBaseline`), which reads the shot + baseline PNGs off disk; all its judgement is
 * delegated to the pure comparator. Unit-tested in `scripts/lib/__tests__/design-pixels-adapter.test.mjs`.
 */
import { buildSubjectMandate } from './jury-core.mjs';
import { compareToBaseline } from './visual-comparator.mjs';

/** The #2576 design-review lenses this subject judges under. A frozen enum so every consumer names them once. */
export const DESIGN_PIXEL_LENSES = Object.freeze({
  USABILITY: 'usability',
  VISUAL: 'visual',
  A11Y: 'a11y',
  DESIGN_SYSTEMS: 'design-systems',
});

/** The full #2576 design lens-set, in the canonical usability / visual / a11y / design-systems order. */
export const DESIGN_PIXEL_LENS_SET = Object.freeze([
  DESIGN_PIXEL_LENSES.USABILITY,
  DESIGN_PIXEL_LENSES.VISUAL,
  DESIGN_PIXEL_LENSES.A11Y,
  DESIGN_PIXEL_LENSES.DESIGN_SYSTEMS,
]);

/**
 * The lenses that must UNANIMOUSLY accept for a design to be judged "ships" (the design analogue of the PR-diff
 * subject's correctness + security). `usability` and `a11y` are the two design invariants that (a) have a CALLABLE
 * grounding today and (b) a design must not fail: an unusable or inaccessible design does not ship regardless of
 * how well it matches the target or the system. `visual` is deliberately NOT mandatory — even though its
 * `screenshot-vs-target` grounding is now CALLABLE (#2671), a surface with no committed baseline is a documented
 * SKIP (the comparator's own contract), so gating a land on a lens that legitimately skips would false-block every
 * brand-new surface before anyone has drawn its target; `design-systems` is advisory (conformance is a judgment
 * call a reasonable reviewer can weigh). A tuning knob.
 *
 * INVARIANT (mandatory lenses ride the TOUCH-SET, not the static care band). Unlike the reference `PR_DIFF_ADAPTER`
 * — whose mandatory lenses (correctness / security) are members of the subject-neutral `PANEL_LENSES` that
 * `resolveRoster` ALWAYS prepends, so they are present in every non-`none` roster — this subject's mandatory lenses
 * are its OWN perspective lenses, earned via `extractTouchSet`. They are therefore present exactly when there is a
 * design under review (a non-empty `surfaces` input). A downstream `derivePanelVerdict({ mandatoryLenses })` is only
 * valid over a roster resolved for a REAL review (non-empty touch-set); deriving a panel verdict for an empty input
 * (no surfaces → no design → no jury) is a caller error and `derivePanelVerdict` will surface it as a loud
 * "missing verdict for mandatory lens" throw, never a silent pass — a runner (S6+) must resolve the roster from an
 * actual design before asking for a verdict.
 */
export const DESIGN_PIXEL_MANDATORY_LENSES = Object.freeze([
  DESIGN_PIXEL_LENSES.USABILITY,
  DESIGN_PIXEL_LENSES.A11Y,
]);

/** The methods that can GROUND a design-pixels lens (#2657). A frozen enum so every consumer names a method once. */
export const DESIGN_PIXEL_METHODS = Object.freeze({
  HEURISTIC_REVIEW: 'design-heuristic-review', // a reviewer subagent judges the rendered design against heuristics
  AXE_SCAN: 'axe-scan',                         // an automated accessibility scan over the rendered UI
  SCREENSHOT_VS_TARGET: 'screenshot-vs-target', // a screenshot diffed against a target/baseline — callable (#2671)
});

/**
 * The design-pixels method registry (#2657) — each method declares WHICH lenses it grounds, a human label, and
 * whether it is DEFERRED. Pure data. `design-heuristic-review` grounds usability + design-systems; `axe-scan`
 * grounds a11y; `screenshot-vs-target` grounds visual — CALLABLE as of #2671 (`deferred: false`), wired to the
 * shared comparator via `groundVisualLens` / `runnerForDesignMethod` (below). No method is deferred today; the
 * `deferred` field + `isDesignPixelMethodDeferred` guard stay as general infrastructure for any future
 * not-yet-built method. `DESIGN_PIXEL_LENS_DEFAULT_METHOD` (below) is the inverted lens→method index derived from
 * this, so the two never drift.
 */
export const DESIGN_PIXEL_METHOD_REGISTRY = Object.freeze([
  Object.freeze({
    id: DESIGN_PIXEL_METHODS.HEURISTIC_REVIEW,
    label: 'design heuristic reviewer (judges the rendered design)',
    grounds: Object.freeze([DESIGN_PIXEL_LENSES.USABILITY, DESIGN_PIXEL_LENSES.DESIGN_SYSTEMS]),
    deferred: false,
  }),
  Object.freeze({
    id: DESIGN_PIXEL_METHODS.AXE_SCAN,
    label: 'axe accessibility scan',
    grounds: Object.freeze([DESIGN_PIXEL_LENSES.A11Y]),
    deferred: false,
  }),
  Object.freeze({
    id: DESIGN_PIXEL_METHODS.SCREENSHOT_VS_TARGET,
    label: 'screenshot diffed against a target/baseline (shared visual comparator)',
    grounds: Object.freeze([DESIGN_PIXEL_LENSES.VISUAL]),
    // CALLABLE (#2671): the shared comparator (`visual-comparator.mjs`, #2670) is now wired in. A runner resolves
    // the in-process runner via `runnerForDesignMethod` and invokes `groundVisualLens`, which runs the real
    // automated screenshot-vs-baseline diff. A surface with no baseline is a documented skip (by-eye fallback).
    deferred: false,
  }),
]);

/** The DEFERRED method ids — methods registered for provenance but with no callable primitive yet. Derived from
 *  the registry so it never drifts. As of #2671 this is EMPTY (screenshot-vs-target became callable); the
 *  machinery stays for any future not-yet-built method. A runner checks it before attempting to invoke a method. */
export const DESIGN_PIXEL_DEFERRED_METHODS = Object.freeze(
  new Set(DESIGN_PIXEL_METHOD_REGISTRY.filter((m) => m.deferred).map((m) => m.id)),
);

/** Is this design-pixels method DEFERRED — registered for provenance but not yet callable? Pure. A general guard a
 *  runner uses so it never invokes a method whose primitive is not built. Returns `false` for every method today
 *  (all are callable as of #2671); retained for future deferred methods. */
export function isDesignPixelMethodDeferred(methodId) {
  return DESIGN_PIXEL_DEFERRED_METHODS.has(methodId);
}

/** lens → its DEFAULT grounding method id, inverted from `DESIGN_PIXEL_METHOD_REGISTRY` so the two are
 *  single-sourced. Every design lens the adapter attaches has a default here. */
export const DESIGN_PIXEL_LENS_DEFAULT_METHOD = Object.freeze(
  DESIGN_PIXEL_METHOD_REGISTRY.reduce((acc, m) => {
    for (const lens of m.grounds) acc[lens] = m.id;
    return acc;
  }, {}),
);

/**
 * Classify a design-pixels review INPUT into the perspective lenses it earns (#2657) — the touch-set analogue of
 * the PR-diff subject's `classifyTouchSet`. Pure. The input DESCRIBES the design under review:
 *   • `surfaces` — the rendered regions / screens being judged (an array; also accepted as the bare array input).
 *   • `hasTarget` — whether a target / baseline design is supplied to compare against.
 * A design with at least one surface earns `usability` + `a11y` + `design-systems` — the three perspectives you can
 * judge from the rendered pixels alone. `visual` (matches-the-target) is earned ONLY when a target is supplied,
 * because the visual lens is a comparison AGAINST that target — mirroring the PR-diff subject's "a page diff
 * additionally earns perf" conditional shape. No surface → no design under review → no lenses (empty), the same
 * empty-input → empty-lenses posture the PR-diff classifier takes.
 * @param {{surfaces?: string[], hasTarget?: boolean}|string[]} [input]
 * @returns {{surfaces: string[], hasTarget: boolean, lenses: string[]}}
 */
export function classifyDesignTouchSet(input = {}) {
  const desc = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rawSurfaces = Array.isArray(input) ? input : Array.isArray(desc.surfaces) ? desc.surfaces : [];
  const surfaces = rawSurfaces.filter(Boolean).map(String);
  const hasTarget = desc.hasTarget === true;
  const lenses = [];
  if (surfaces.length) {
    lenses.push(DESIGN_PIXEL_LENSES.USABILITY, DESIGN_PIXEL_LENSES.A11Y, DESIGN_PIXEL_LENSES.DESIGN_SYSTEMS);
    if (hasTarget) lenses.push(DESIGN_PIXEL_LENSES.VISUAL);
  }
  return { surfaces, hasTarget, lenses };
}

/**
 * The grounding method(s) for one design-pixels lens (#2657) — the subject's `resolveMethods`. Pure. Returns a
 * FRESH single-element array with the lens's default grounding method, or an EMPTY array for a lens the design
 * registry does not know (e.g. one of the subject-neutral care-band lenses `resolveRoster` prepends — the design
 * subject grounds only its OWN perspective lenses, never the generic panel's). The `visual` lens's method id
 * (`screenshot-vs-target`) is now CALLABLE (#2671): a runner resolves it via `runnerForDesignMethod` and invokes
 * `groundVisualLens` — the real automated diff — with a documented by-eye skip when no baseline exists.
 * @param {string} lens
 * @returns {string[]}
 */
export function designMethodsForLens(lens) {
  const method = DESIGN_PIXEL_LENS_DEFAULT_METHOD[lens];
  return method ? [method] : [];
}

/**
 * @typedef {{ method: string, grounded: boolean, byEye: boolean, match: boolean|null, delta: number,
 *             skipped: boolean, findings: import('./visual-comparator.mjs').ComparisonResult['findings'],
 *             dimensions?: import('./visual-comparator.mjs').ComparisonResult['dimensions'] }} VisualGrounding
 */

/**
 * THE CALLABLE FORM of the `visual → screenshot-vs-target` lens (#2671) — the wire-in of the shared comparator
 * (`visual-comparator.mjs`, #2670). Runs the REAL automated screenshot-vs-baseline diff and returns a grounded
 * verdict, replacing the by-eye-only judgment the lens was DEFERRED to in #2657. Thin over `compareToBaseline`: it
 * owns NO diff logic (that stays single-sourced in the comparator, per #96), only the mapping of the comparator's
 * result into a lens-grounding shape a juror/runner consumes.
 *
 * TWO OUTCOMES, mirroring the comparator's contract:
 *   • Baseline present → the diff RAN → `{ grounded: true, byEye: false, match, delta, findings, dimensions }`.
 *     `match`/`delta`/the `region-shift` findings are the automated grounding — the juror weighs them, it does not
 *     re-eyeball what the diff already measured.
 *   • Baseline MISSING → the comparator returns a documented SKIP → `{ grounded: false, byEye: true, match: null }`.
 *     This PRESERVES the by-eye fallback: the juror judges the visual match by eye and reports the lens as
 *     ungrounded (a skip is never a fail — a brand-new surface must not red a gate before its target is drawn).
 *
 * The ONLY I/O in this module (reads the shot + baseline PNGs, via the comparator's file-facing wrapper). All
 * threshold options (`pixelTolerance` / `pixelDeltaThreshold` / `grid` / `cellThreshold`) pass straight through.
 * @param {{ shotPath: string, baselinePath: string, pixelTolerance?: number, pixelDeltaThreshold?: number,
 *           grid?: number, cellThreshold?: number }} [args]
 * @returns {VisualGrounding}
 */
export function groundVisualLens({ shotPath, baselinePath, ...opts } = {}) {
  const result = compareToBaseline({ shotPath, baselinePath, ...opts });
  const skipped = result.skipped === true;
  return {
    method: DESIGN_PIXEL_METHODS.SCREENSHOT_VS_TARGET,
    grounded: !skipped,     // the automated diff RAN (a baseline existed) — false on a documented skip
    byEye: skipped,         // no baseline → the juror falls back to a by-eye visual judgment
    match: result.match,    // true/false when grounded; null on a skip (the comparator makes no claim)
    delta: result.delta,
    skipped,
    findings: result.findings,
    ...(result.dimensions ? { dimensions: result.dimensions } : {}),
  };
}

/**
 * The in-process runner index (#2671): design method id → its callable grounding function. Only
 * `screenshot-vs-target` has an IN-PROCESS runner here (`groundVisualLens`, the automated diff); the other two
 * methods are grounded OUT of process — `design-heuristic-review` by a reviewer subagent, `axe-scan` by the axe
 * tool — so they are absent from this map (a runner orchestrates them itself). Frozen so it is a stable value.
 */
export const DESIGN_PIXEL_METHOD_RUNNERS = Object.freeze({
  [DESIGN_PIXEL_METHODS.SCREENSHOT_VS_TARGET]: groundVisualLens,
});

/** The in-process runner for a design method id, or `null` if the method has no in-process callable form (it is
 *  grounded out of process by a subagent / external tool). Pure lookup. The seam a runner uses to invoke the
 *  screenshot-vs-target diff by its method id without hard-wiring the function. */
export function runnerForDesignMethod(methodId) {
  return DESIGN_PIXEL_METHOD_RUNNERS[methodId] ?? null;
}

/**
 * Build the design-pixels review mandate (#2657) — the subject's `buildMandate`, framed on the subject-neutral
 * `buildSubjectMandate` skeleton (the same skeleton the PR-diff `buildMandate` uses). Pure. Supplies the
 * design-specific parts: the `rendered design` subject noun, the isolation line (the reviewer sees the rendered
 * pixels / DOM, not the source), the `region` finding anchor (a design finding is anchored to a region of the
 * rendered surface, not a source file), and — for the `visual` lens — a body note that an automated
 * screenshot-vs-target diff GROUNDS the lens (its verdict is provided as evidence to weigh), falling back to a
 * by-eye judgment only when no baseline exists (a documented skip → an ungrounded lens).
 *
 * The lens can be named EITHER as `lens` OR (matching the reference `buildMandate({ mandate: <lens> })` /
 * `buildPanelMandate` convention) as `mandate` — the `visual` note fires when EITHER names `visual`, so a caller
 * using the reference shape does not silently lose it.
 * @param {{lens?: string, mandate?: string|string[]}} [o]
 * @returns {string}
 */
export function buildDesignMandate({ lens, mandate } = {}) {
  const effectiveMandate = mandate ?? lens ?? DESIGN_PIXEL_LENSES.USABILITY;
  const namesVisual = lens === DESIGN_PIXEL_LENSES.VISUAL
    || mandate === DESIGN_PIXEL_LENSES.VISUAL
    || (Array.isArray(mandate) && mandate.includes(DESIGN_PIXEL_LENSES.VISUAL));
  const bodyLines = [];
  if (namesVisual) {
    bodyLines.push(
      'An automated screenshot-vs-target diff grounds this lens: when a baseline exists, its verdict (match / pixel',
      'delta / region-shift findings) is provided as evidence — weigh it, do not re-eyeball what it already measured.',
      'When no baseline exists the diff is a documented SKIP: judge the visual match by eye and report the lens as',
      'ungrounded (a skip is never a fail).',
    );
  }
  return buildSubjectMandate({
    subjectNoun: 'rendered design',
    mandate: effectiveMandate,
    defaultMandate: DESIGN_PIXEL_LENSES.USABILITY,
    isolationLine: 'You see the RENDERED design (screenshots / DOM) — not the source that produced it, no author framing.',
    findingAnchor: 'region',
    bodyLines,
  });
}

/**
 * THE DESIGN-PIXELS SUBJECT ADAPTER (#2657) — the plug that snaps the #2576 design lens-set into the #2656 F2 seam.
 * Conforms to `SUBJECT_ADAPTER_CONTRACT` (validated by `validateSubjectAdapter`), so `resolveAdapterRoster` builds a
 * design-review roster from it exactly as it does from `PR_DIFF_ADAPTER` — the core knows nothing about pixels.
 *   • `extractTouchSet` — the design input → the perspective lenses it earns (`classifyDesignTouchSet`).
 *   • `resolveMethods`  — the design lens → its grounding method (`designMethodsForLens`); `visual`'s method
 *     (`screenshot-vs-target`) is CALLABLE (#2671) — run it via `runnerForDesignMethod` → `groundVisualLens`.
 *   • `mandatoryLenses` — usability + a11y (the two grounded design invariants that gate a land).
 *   • `charterForLens`  — the design-specific juror charter text (passed to `materializeRoster`).
 *   • `buildMandate`    — the design-specific mandate framing (built on `buildSubjectMandate`).
 * Frozen so the adapter is a stable value other modules can import and compare against.
 */
export const DESIGN_PIXELS_ADAPTER = Object.freeze({
  subject: 'design-pixels',
  subjectNoun: 'rendered design',
  mandatoryLenses: DESIGN_PIXEL_MANDATORY_LENSES,
  extractTouchSet: (input) => classifyDesignTouchSet(input).lenses,
  resolveMethods: (lens) => designMethodsForLens(lens),
  charterForLens: (lens) => `judge the rendered design under the "${lens}" lens`,
  buildMandate: buildDesignMandate,
});

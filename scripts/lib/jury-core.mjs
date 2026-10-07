/**
 * jury-core.mjs — the subject-agnostic JURY ENGINE core (#2653, foundational slice of epic #2649).
 *
 * WHY: this is the subject-NEUTRAL method core lifted out of `we:scripts/lib/review-core.mjs` — the pure
 * derivations that judge "a set of findings / verdicts" WITHOUT knowing what is being judged (a PR diff, a
 * plan, any future subject). `review-core.mjs` re-exports every symbol defined here so its existing callers
 * (review-core-cli, review-parked-prs, review-render, the drain) stay byte-stable: this extraction is a pure
 * MOVE + re-export, never a behaviour change. New subject-agnostic consumers import from HERE directly.
 *
 * What lives here (the four method pieces epic #2649 names):
 *   • the FINDING CONTRACT — `normalizeFinding` / `normalizeFindings` / `deriveVerdict` + the `VERDICTS` enum.
 *   • the two ADMISSION gates over that contract, orthogonal and composable in either order:
 *     `scopeFindingsToCitedFiles` (#3351) withholds on DISPROOF — a citation the run checked and found false, and
 *     it enforces by default; `admitFindingsByEvidence` (#3312) withholds on ABSENCE — nothing machine-checkable
 *     to check at all — and it demotes NOTHING until a caller raises `EVIDENCE_FLOOR`. See that constant for why.
 *   • the ROUND LOOP — `NEGOTIATION_ROUND_CAP` + `deriveNegotiationOutcome` (+ `NEGOTIATION_OUTCOMES`).
 *   • the DIVERSITY-SELECTION reduction — `derivePanelVerdict` + `buildPanelFindings` +
 *     `AGGREGATION.DIVERSITY_SELECTION`, over the lens vocabulary (`MANDATE_LENSES` / `MANDATORY_LENSES` /
 *     `ADVISORY_LENSES` / `PANEL_LENSES`).
 *   • the CARE→RIGOR dial — `panelRigorForCareLevel` over the advisory `CARE_LEVELS` enum. SHARED by `/jury`,
 *     `/review` and `/converge`, which is why the #2908 editor gate below is a SEPARATE knob and not a re-dial
 *     of this one.
 *   • the EDITOR knob (#2908) — `editorPolicyForCareLevel` + `EDITOR_ENABLED_CARE_LEVELS` / `EDITOR_MIN_ROUNDS`:
 *     may the convergence loop's editor PUSH at this band, and what round budget does that buy. Fails closed.
 *   • the JURY-LEDGER EVENT VOCABULARY (#2654, S2 of epic #2649) — `JURY_EVENT_TYPES` + `JUROR_STATUSES` and
 *     the pure `validateJuryEvent` / `normalizeJuryEvent` schema-validator. The append-only shape #2641's durable
 *     on-disk log appends and the #2642 console serializes; this slice is the SHAPE ONLY — the on-disk log and
 *     the fold that replays it into a live ledger are #2641, not here.
 *
 * What STAYS in `review-core.mjs`: everything that knows it is judging a PR DIFF — the mandate builders, the
 * plan-phase handshake, the escalation REASON→disposition policy, and the operator-facing renderers.
 *
 * The advisory CARE-LEVEL enum is single-sourced in `review-escalation.mjs` (a leaf that imports only
 * gate-config + review-policy), so `jury-core → review-escalation` is acyclic. jury-core stays label-free /
 * leash-free — a care-level is advisory review-RIGOR information (how hard to look), never a route/land policy
 * (that stays with review-escalation's `decideReviewGate`).
 *
 * Pure, unit-tested through `review-core.mjs`'s re-exports in `we:scripts/lib/__tests__/review-core.test.mjs`.
 */
import { createHash } from 'node:crypto';
import { deriveSessionId, sessionSeed } from './judge-spawn.mjs';
import { decideClearerIndependence, INDEPENDENCE, parseAuthorActorId } from './review-independence.mjs';
import { CARE_LEVELS } from './review-escalation.mjs';
import { AUTOMATION_LOGINS, OPERATOR_LOGINS, isTrustedMarkerAuthor } from './marker-authorship.mjs';
// #2438's labelled data fence (#2967 moved it to a leaf so this module can reach it — `review-core.mjs`,
// where it used to live, imports THIS module, so importing back would be a cycle).
import { FENCED_DATA_RULE, fenceUntrusted } from './mandate-fence.mjs';

/**
 * @typedef {Object} Finding
 * @property {string} [file] - repo-relative path the finding is anchored to.
 * @property {string} summary - one-sentence statement of the defect.
 * @property {string} [failure_scenario] - concrete inputs/state → wrong output/crash.
 * @property {string} [category] - short kebab-case slug, e.g. "correctness", "simplification".
 * @property {number} [line] - 1-indexed line the finding anchors to.
 * @property {'CONFIRMED'|'PLAUSIBLE'} [verdict] - set when a verify pass ran; absent on inline-only reviews.
 * @property {'fixed'|'skipped'|'no_change_needed'} [outcome] - set only when RE-reporting after fixes were applied.
 * @property {string} [rootCause] - #2823 blameless "why the CREATOR erred" chain (the authoring failure mode), not just what is wrong.
 * @property {string} [prevention] - #2823 the cheapest durable guard that would have caught this CLASS (a deterministic gate preferred over a lens over a doc note).
 * @property {boolean} [preventionCaptured] - #2823 true when the prevention already EXISTS as a gate or is filed; false ⇒ neither built nor filed ⇒ blocks a clean accept at or above `PREVENTION_IMPACT_BAR`.
 * @property {'cosmetic'|'degraded'|'broken'|'unrecoverable'} [impactIfUnfixed] - #xdompzx what it COSTS to ship this finding (an `IMPACT_LEVELS` member; see `IMPACT_GLOSS` for each level's definition). An unrecognised or absent value adds no key and reads as UNDECLARED, which `blocksAcceptance` treats as fail-closed.
 * @property {'blocker'|'carve-out'|'nit'} [disposition] - #2950 whether this finding earns a negotiation ROUND (a `DISPOSITIONS` member). Normally ROUTED by `deriveFindingDisposition` from the three answers below rather than self-declared; an unrecognised or absent value adds no key and reads as UNDECLARED, which `earnsRound` treats as fail-closed (blocking).
 * @property {boolean} [introduced] - #2950 direction test (a): did THIS change introduce the problem (vs. pre-existing on untouched material)?
 * @property {boolean} [worseThanBase] - #2950 direction test (b): is the result NET WORSE than the base — not merely less than ideal?
 * @property {boolean} [parallelizable] - #2950 direction test (c): can it be fixed independently, in a parallel lane, without holding this change?
 * @property {string} [quote] - #3312 verbatim text the finding claims is in the cited file. CONFIRMED against supplied source text by `classifyFindingEvidence`; never taken on trust.
 * @property {string} [reproCommand] - #3312 a single re-runnable command that exercises the defect. Shape-checked by `isReproCommand`; NOT executed anywhere in this module.
 * @property {'assertion'|'resolved-citation'|'repro'|'quoted-citation'} [evidenceKind] - #3312 what a machine could actually check about this finding (an `EVIDENCE_KINDS` member). DISPLAY/AUDIT data here; `admitFindingsByEvidence` recomputes it from ground truth and is the only thing that acts on it.
 */

/** The review verdicts (#2325). `needs-human` is the #2285 conflict-of-interest escalation: humanRequired
 *  ALWAYS wins over any finding-derived disposition (see `deriveVerdict`). `prevention-outstanding` (#2823) is
 *  the accept-gated-on-capture surface: every finding is resolved, but at least one names a PREVENTION guard
 *  that is neither already captured (an existing gate) nor filed as a future item — so a CLEAN accept is
 *  withheld ("file the guard before accept", closing the unfiled-intention gap). It is NOT a negotiable
 *  `changes` state: every finding is already fixed, so no editor round has anything to revise and no round-loop
 *  actor files the guard. `deriveNegotiationOutcome` therefore ESCALATES it straight to the operator (who files
 *  the named guard(s)), carrying the guard list in the notice — it never re-enters the round loop to burn the
 *  budget re-deriving the identical verdict. It never silently lands (`deriveNegotiationOutcome` lands ONLY
 *  `accept`). */
export const VERDICTS = Object.freeze({
  ACCEPT: 'accept',
  CHANGES: 'changes',
  NEEDS_HUMAN: 'needs-human',
  PREVENTION_OUTSTANDING: 'prevention-outstanding',
});

/**
 * Freeze a rank/gloss LOOKUP TABLE with a NULL PROTOTYPE (#xdompzx review, blocker 2). `Object.freeze` seals a
 * table's OWN properties; it does NOT detach `Object.prototype`. So on a normal object literal a bare bracket read
 * of a key that arrives as free-form model JSON — `TABLE['toString']`, `TABLE['constructor']`, `TABLE['valueOf']`,
 * `TABLE['hasOwnProperty']`, `TABLE['__proto__']` — returns an INHERITED member instead of `undefined`. A
 * `!== undefined` membership test then passes on a word that is not in the enum at all, and the inherited value
 * compares as `NaN` in every `>=` / `>` bar comparison, which is false in BOTH directions: the guard fails OPEN.
 * A null-prototype table has nothing to inherit, so an invented word is genuinely absent.
 *
 * Belt and braces on the RANK tables specifically: their membership test goes through `rankIn`, which uses
 * `Object.hasOwn`, so neither the prototype nor a future own-property addition can be mistaken for an enum member.
 * (The render tables below are read with a `??` / `||` default rather than a membership test — for those, the null
 * prototype IS the fix, because it is what makes the default fire at all.)
 *
 * EXPORTED (#xdompzx round-2, finding 5) because the same hole was present in the sibling LOOKUP tables on this
 * path: `VERDICT_LABELS` (`review-render.mjs`), and `VERDICT_MARKERS` + `STATUS_MARKERS` (`conveyor/jury-tree.mjs`)
 * are read with `??` / `||` defaults, which never fire on an inherited truthy value, so `'toString'` rendered the
 * native function into a posted PR comment and into the live conveyor tree.
 *
 * SCOPE OF THAT CLAIM, precisely (#xdompzx round-4, finding 5 — the round-2 wording said "every sibling lookup
 * table" and the round-4 panel found one it had missed in the same file): the six tables converted here are the
 * ones on the review/jury VERDICT path — `VERDICT_STRICTNESS`, `IMPACT_STRICTNESS`, `IMPACT_GLOSS`,
 * `VERDICT_LABELS`, `VERDICT_MARKERS`, `STATUS_MARKERS`. This is NOT a repo-wide guarantee: other defaulted
 * bare-bracket reads exist (e.g. `REVIEW_LENS_CHARTER` in `jury-ledger.mjs`, `LENS_DEFAULT_METHOD` and
 * `LENS_EXPECTATIONS` in `review-core.mjs`, `STATE_LABEL` in `conveyor/status-artifact.mjs`) and are untouched.
 * Sweeping them, and gating against new ones, is filed as its own `check:standards` rule (`xg9gboa`) — do not read
 * this doc as saying it already happened.
 * @param {Object<string, *>} entries
 * @returns {Object<string, *>}
 */
export const frozenLookup = (entries) => Object.freeze(Object.assign(Object.create(null), entries));

/**
 * Read a rank out of a `frozenLookup` rank table, or THROW (#xdompzx round-2, finding 6 — `verdictStrictness` and
 * `impactStrictness` were a hand-copied twin pair, edited in lockstep by the very diff that created the second).
 * Membership is `Object.hasOwn`, never a bare bracket read: these tables take keys that arrive as free-form model
 * JSON, and yielding `undefined` (or an inherited member) would lose every `>` / `>=` comparison in BOTH
 * directions — a guard that fails OPEN.
 * @param {Object<string, number>} table - a `frozenLookup` rank table.
 * @param {string} key
 * @param {string} label - the error-message lead naming the caller and what the key should be.
 * @returns {number}
 */
const rankIn = (table, key, label) => {
  const k = String(key);
  if (!Object.hasOwn(table, k)) {
    throw new Error(`${label} "${key}" — not a member of the enum this table ranks (known: ${Object.keys(table).join(', ')}).`);
  }
  return table[k];
};

/**
 * VERDICT STRICTNESS — the diversity-selection order (#2567): the STRICTEST verdict carries a lens/panel, never a
 * vote. `needs-human` (3) beats `changes` (2) beats `prevention-outstanding` (1) beats `accept` (0).
 * `prevention-outstanding` (#2823) ranks ABOVE `accept` (a co-juror's "file the guard" must never lose to another's
 * `accept`) and BELOW `changes` (an unfixed defect is a harder block than a missing guard — mirrors `deriveVerdict`,
 * which returns `changes` before it ever consults prevention).
 *
 * THE SINGLE SOURCE (#2823 round-2 finding 1): this is the ONE strictness table in the codebase. `disposition-judge`
 * (`reduceLedger`, `proposeDisposition`) and `jury-ledger` (`strictestVerdict`, the fold's per-lens roll-up) BOTH
 * IMPORT it — so "mirrors disposition-judge" is enforced BY CONSTRUCTION and can never drift again (the round-1 fix
 * missed jury-ledger's hand-copied twin; a copy cannot be missed if there is no copy). MUST stay TOTAL over
 * `VERDICTS` — the assertion below crashes at import if a new enum member has no rank, so a partial table is a
 * build-time failure, never a silent `undefined` mis-reduction at review time.
 *
 * NULL-PROTOTYPE (#xdompzx review, blocker 2) — see `frozenLookup`: a normal object literal would answer
 * `VERDICT_STRICTNESS['toString']` with an inherited function, so `'toString'` would pass a `!== undefined`
 * membership test and then compare as `NaN`, losing every `>` comparison. Membership is tested with `Object.hasOwn`.
 *
 * @verdicts-total — every `VERDICTS` member must be a key (the `check:standards` verdict-totality gate enforces the
 *   same totality the module-load assertion below does, as a static-scan backstop that also covers every other table).
 */
export const VERDICT_STRICTNESS = frozenLookup({
  [VERDICTS.ACCEPT]: 0,
  [VERDICTS.PREVENTION_OUTSTANDING]: 1,
  [VERDICTS.CHANGES]: 2,
  [VERDICTS.NEEDS_HUMAN]: 3,
});

// #2823 — ENFORCE TOTALITY over `VERDICTS` at module load. A verdict added to the enum without a rank here would
// otherwise compare as `undefined` in every strictest-wins reduction — silently ranking BELOW `accept` and dropping
// a blocking verdict (the exact defect this feature was bounced for). Fail LOUDLY at import instead.
for (const verdict of Object.values(VERDICTS)) {
  if (!Object.hasOwn(VERDICT_STRICTNESS, verdict)) {
    throw new Error(`VERDICT_STRICTNESS is not total over VERDICTS: verdict "${verdict}" has no strictness rank — add it (the table must rank every VERDICTS member).`);
  }
}

/** The strictness rank of a verdict. THROWS on an unranked verdict rather than yielding `undefined` (which every
 *  `>` comparison would silently lose). Ledger/panel verdicts are enum-constrained upstream (`validateJuryEvent`
 *  admits only `VERDICTS` values), so this never throws on real data — it is the fail-loud backstop the totality
 *  assertion above guarantees, applied at each comparison site (disposition-judge + jury-ledger both call it).
 *  Membership + the throw live once in `rankIn`, so this and `impactStrictness` cannot drift apart.
 *  @param {string} verdict
 *  @returns {number} */
export function verdictStrictness(verdict) {
  return rankIn(VERDICT_STRICTNESS, verdict, 'verdictStrictness: no strictness rank for verdict');
}

/**
 * IMPACT IF UNFIXED (#xdompzx) — what it COSTS to ship this finding, as distinct from `severity` (how bad the defect
 * looks to the lens that found it). The two come apart constantly, and before this existed only the second one was
 * expressible: a cosmetic nit and an unrecoverable data-loss race both reduced to "a finding", so the panel could
 * only COUNT objections, never RANK them by consequence. Observed on PR #1042 — a dead struct field and a stale
 * comment each arrived carrying a proposed new `check:standards` rule, and the mechanical verdict came back
 * `changes` on a diff whose only mandatory-lens objection was a race needing a branch deleted without landing
 * inside a ~30s window.
 *
 * Ordered LEAST to MOST costly. Deliberately subject-agnostic — this spine judges diffs, designs, and decisions.
 * WHAT EACH LEVEL MEANS IS NOT WRITTEN HERE: the glosses live once, as data, in `IMPACT_GLOSS` below, and the
 * mandate reviewers actually read is RENDERED from that same map. A prose copy here drifted from the prompt within
 * the commit that created it (#xdompzx review, finding 6) — so this doc deliberately points instead of restating.
 */
export const IMPACT_LEVELS = Object.freeze({
  COSMETIC: 'cosmetic',
  DEGRADED: 'degraded',
  BROKEN: 'broken',
  UNRECOVERABLE: 'unrecoverable',
});

/** WHAT EACH IMPACT LEVEL MEANS — the ONE definition, as DATA (#xdompzx review, finding 6). Both the reviewer-facing
 *  mandate (`buildSubjectMandate`) and every doc reference render from this map, so the prompt a reviewer grades
 *  against and the definition a maintainer reads cannot drift apart. Total over `IMPACT_LEVELS`, asserted at module
 *  load alongside `IMPACT_STRICTNESS`, so a level added without a gloss crashes the import rather than shipping
 *  listed-but-undefined. Null-prototype for the same reason `IMPACT_STRICTNESS` is (see `frozenLookup`).
 *  @impact-total — every `IMPACT_LEVELS` member must be a key (the `check:standards` impact-totality gate). */
export const IMPACT_GLOSS = frozenLookup({
  [IMPACT_LEVELS.COSMETIC]: 'nothing breaks; a later reader might be mildly misled',
  [IMPACT_LEVELS.DEGRADED]: 'someone hits friction or a worse result, and recovers unaided',
  [IMPACT_LEVELS.BROKEN]: 'real work is lost, duplicated, or silently skipped — recoverable, but only by someone noticing',
  [IMPACT_LEVELS.UNRECOVERABLE]: 'data or work is destroyed with no way back',
});

/** The impact ordering. Same fail-loud contract as `VERDICT_STRICTNESS`: total over `IMPACT_LEVELS`, asserted at
 *  module load, so a level added without a rank crashes the import instead of comparing as `undefined` (which every
 *  `>=` bar comparison would silently lose — reading as BELOW the bar and quietly un-blocking a real finding).
 *  NULL-PROTOTYPE, and every membership test against it is `Object.hasOwn` (#xdompzx review, blocker 2): this table
 *  is read with a key that arrives as FREE-FORM MODEL JSON, so on a normal object literal `'toString'` /
 *  `'constructor'` / `'valueOf'` / `'hasOwnProperty'` / `'__proto__'` would all validate as real impact levels and
 *  then compare as `NaN` — failing OPEN, the exact inverse of the fail-closed invariant this feature rests on.
 *  @impact-total — every `IMPACT_LEVELS` member must be a key (the `check:standards` impact-totality gate). */
export const IMPACT_STRICTNESS = frozenLookup({
  [IMPACT_LEVELS.COSMETIC]: 0,
  [IMPACT_LEVELS.DEGRADED]: 1,
  [IMPACT_LEVELS.BROKEN]: 2,
  [IMPACT_LEVELS.UNRECOVERABLE]: 3,
});

// ENFORCE TOTALITY over `IMPACT_LEVELS` at module load, for BOTH structures total over it — the rank table and the
// gloss map. A level added to the enum without a rank would compare as `undefined` at every bar; one added without a
// gloss would ship listed-in-the-prompt but undefined-to-the-reviewer. Fail LOUDLY at import instead.
for (const level of Object.values(IMPACT_LEVELS)) {
  if (!Object.hasOwn(IMPACT_STRICTNESS, level)) {
    throw new Error(`IMPACT_STRICTNESS is not total over IMPACT_LEVELS: level "${level}" has no rank — add it (the table must rank every IMPACT_LEVELS member).`);
  }
  if (!Object.hasOwn(IMPACT_GLOSS, level)) {
    throw new Error(`IMPACT_GLOSS is not total over IMPACT_LEVELS: level "${level}" has no gloss — add it (the mandate renders its definition from this map, so an ungloss'd level ships listed-but-undefined).`);
  }
}

/** Rank an impact level. THROWS on an unranked level rather than yielding `undefined` — the fail-loud backstop for
 *  every bar comparison. Shares `rankIn` with `verdictStrictness` (#xdompzx round-2, finding 6): one accessor, so
 *  the two can no longer be edited in lockstep and drift.
 *  @param {string} level
 *  @returns {number} */
export function impactStrictness(level) {
  return rankIn(IMPACT_STRICTNESS, level, 'impactStrictness: no rank for impact level');
}

/**
 * THE STRICTNESS DIAL (#xdompzx). The minimum `impactIfUnfixed` at which an uncaptured prevention guard WITHHOLDS a
 * clean accept. Findings below the bar are still reported, still ranked, and still owed a filing — they simply do
 * not block the land.
 *
 * Set to `broken` for the CURRENT context: a solo constellation whose review surface is mostly internal tooling,
 * where the cost of a blocked land (a stalled conveyor, a hand-held re-review) genuinely exceeds the cost of a
 * cosmetic defect shipping. This is the knob to TURN, not the code to rewrite, as the constellation grows —
 * lowering it to `degraded` (then `cosmetic`, the pre-#xdompzx behaviour) tightens the gate with a one-line change
 * and no consumer edits, because every consumer reads the bar from here.
 */
export const PREVENTION_IMPACT_BAR = IMPACT_LEVELS.BROKEN;

/**
 * FINDING DISPOSITION (#2950) — does this finding earn a negotiation ROUND, or is it merely filed?
 *
 * The loop's cost problem is that a finding is binary today: raise it and the whole subject bounces into an
 * editor↔reviewer round, or stay quiet. That prices every true observation as a blocker, which is what makes the
 * panel argue and what lets a subject grow under review. A juror instead answers three DIRECTION tests per finding
 * (asked in `buildSubjectMandate`), and the answers route it:
 *
 *   • `blocker`   — ALL THREE hold: this change INTRODUCED it, it leaves things WORSE than the base, and it CANNOT
 *                   be fixed in an independent parallel lane. Only a blocker earns a round.
 *   • `carve-out` — real, but not this change's problem to fix here (pre-existing, or better-than-base-but-not-ideal,
 *                   or independently fixable). Reported and filed; never blocks.
 *   • `nit`       — worth saying, never worth a round. Rides a round a blocker already opened, never opens one.
 *
 * VERDICT-NARROW, exactly like `blocksAcceptance` (#xdompzx): the disposition narrows what BLOCKS, never what is
 * REPORTED. Every finding — carve-outs and nits included — still reaches the notice, the ledger and the posted
 * comment. Do not filter a reporting surface on `earnsRound`.
 */
export const DISPOSITIONS = Object.freeze({
  BLOCKER: 'blocker',
  CARVE_OUT: 'carve-out',
  NIT: 'nit',
});

/**
 * Which dispositions earn a round. A `frozenLookup` (null-prototype) because the key arrives as free-form model
 * JSON: on a normal literal `TABLE['constructor']` would answer with an inherited truthy member and a
 * non-blocking word would silently read as blocking (or worse, the reverse). Read via `earnsRound` only.
 */
const DISPOSITION_EARNS_ROUND = frozenLookup({
  [DISPOSITIONS.BLOCKER]: true,
  [DISPOSITIONS.CARVE_OUT]: false,
  [DISPOSITIONS.NIT]: false,
});

/**
 * #2950 — ROUTE the three direction tests to a disposition. Pure, and the reason the disposition is not something a
 * juror talks itself into: the juror answers three FACTUAL questions about the finding, and this function — not the
 * model — decides whether that earns a round. Same discipline as the hookable-vs-judgment rule applied to review
 * itself: keep the judgment (is this true?) with the model, and put the routing in code where it cannot drift.
 *
 * Exactly ONE of the eight combinations is a blocker: the change INTRODUCED it, it is WORSE than the base, and it
 * CANNOT be fixed in parallel. Every other combination is a `carve-out` — real, reported, filed, but not this
 * change's problem to fix here.
 *
 * FAIL-CLOSED on an incomplete answer set: if any of the three is not a strict boolean the routing is UNDECIDED
 * (returns `undefined`), which leaves the finding's disposition undeclared, which `earnsRound` reads as blocking.
 * A juror cannot un-block a finding by omitting an answer.
 *
 * @param {{introduced?: boolean, worseThanBase?: boolean, parallelizable?: boolean}} [o]
 * @returns {'blocker'|'carve-out'|undefined}
 */
export function deriveFindingDisposition({ introduced, worseThanBase, parallelizable } = {}) {
  const answered = [introduced, worseThanBase, parallelizable].every((a) => typeof a === 'boolean');
  if (!answered) return undefined;
  return (introduced && worseThanBase && !parallelizable) ? DISPOSITIONS.BLOCKER : DISPOSITIONS.CARVE_OUT;
}

/**
 * #2950 — does this finding EARN a negotiation round? Pure, and FAIL-CLOSED on an undeclared disposition.
 *
 * A finding with no `disposition` (every pre-#2950 finding shape, and any juror that ignores the new field) blocks
 * exactly as it did before, so this is a STRICT RELAXATION: it can only ever un-block a finding whose juror
 * explicitly declared it non-blocking. Same discipline as `blocksAcceptance`'s undeclared-impact branch — the
 * new field is the caller's dial to turn on, never something that changes a verdict nobody opted into.
 *
 * @param {Finding|null|undefined} finding
 * @returns {boolean}
 */
export function earnsRound(finding) {
  const declared = finding && finding.disposition;
  if (declared === undefined || declared === null) return true; // undeclared ⇒ fail closed, pre-#2950 behaviour
  const k = String(declared);
  if (!Object.hasOwn(DISPOSITION_EARNS_ROUND, k)) return true; // an invented word is UNDECLARED, not "non-blocking"
  return DISPOSITION_EARNS_ROUND[k];
}

/** A finding is OUTSTANDING unless a fix pass explicitly resolved it (`outcome: 'fixed'|'no_change_needed'`). The
 *  SINGLE definition every consumer shares — `deriveVerdict` (the accept gate), `renderPreventionSummary` (the
 *  operator notice), `derivePanelVerdict` (the panel prevention scan), and `disposition-judge.reduceLedger`. Sharing
 *  it is what makes the notice and the verdict UNABLE to disagree on "is this finding still open" (#2823 round-2
 *  finding 3): they count the same set by construction, not by matching comments.
 *  @param {{outcome?: string}} finding
 *  @returns {boolean} */
export function isFindingOutstanding(finding) {
  return finding.outcome !== 'fixed' && finding.outcome !== 'no_change_needed';
}

const VALID_VERDICT_TAGS = new Set(['CONFIRMED', 'PLAUSIBLE']);
const VALID_OUTCOMES = new Set(['fixed', 'skipped', 'no_change_needed']);

/**
 * Coerce a raw finding-like object into the canonical `Finding` shape. Pure. Never throws — an unusable raw
 * value (not an object, no summary) normalizes to `null` so callers can `.filter(Boolean)` a mixed list.
 * @param {*} raw
 * @returns {Finding|null}
 */
export function normalizeFinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const summary = raw.summary ?? raw.finding ?? '';
  if (!String(summary).trim()) return null;
  /** @type {Finding} */
  const out = { summary: String(summary).trim() };
  if (raw.file) out.file = String(raw.file);
  if (raw.failure_scenario) out.failure_scenario = String(raw.failure_scenario);
  if (raw.category) out.category = String(raw.category);
  // #x6t2z6h — A LINE NUMBER IS A POSITIVE INTEGER. `Number.isFinite` alone accepted `0`, `-3` and `12.5`, all of
  // which render straight into the PR comment as `file:0` / `file:-3` and address nothing a reader can open. An
  // invalid line adds NO key — the FINDING SURVIVES, only its unusable coordinate is dropped, because a juror that
  // miscounted a line may still be right about the defect. (End-of-file bounds are NOT checked here and cannot be:
  // this is pure, and the run carries the diff, not the files. See the card.)
  const lineNumber = raw.line != null ? Number(raw.line) : Number.NaN;
  if (Number.isInteger(lineNumber) && lineNumber >= 1) out.line = lineNumber;
  if (raw.verdict && VALID_VERDICT_TAGS.has(String(raw.verdict))) out.verdict = String(raw.verdict);
  if (raw.outcome && VALID_OUTCOMES.has(String(raw.outcome))) out.outcome = String(raw.outcome);
  // #2823 — the PREVENTION-INTROSPECTION fields, carried through the canonical shape so they survive into the
  // verdict/notice (not just prose). `rootCause` = a blameless "why the CREATOR erred" chain; `prevention` = the
  // cheapest durable guard that would have caught this CLASS (a `check:standards` gate preferred over a review
  // lens over a doc note); `preventionCaptured` = whether that guard already EXISTS as a gate, or is filed —
  // vs. neither (which blocks a clean accept, see `deriveVerdict`). Absent fields add NO key (old-shape findings
  // unaffected). `preventionCaptured` is coerced to a strict boolean; it is only meaningful with a `prevention`.
  if (raw.rootCause != null && String(raw.rootCause).trim()) out.rootCause = String(raw.rootCause).trim();
  if (raw.prevention != null && String(raw.prevention).trim()) out.prevention = String(raw.prevention).trim();
  if (raw.preventionCaptured != null) out.preventionCaptured = Boolean(raw.preventionCaptured);
  // #xdompzx — IMPACT IF UNFIXED, the ranking key. Validated against the enum: an unrecognised value adds NO key,
  // so a reviewer that invents its own word ("high") is treated as UNDECLARED, which `blocksAcceptance` reads as
  // fail-closed (blocking) rather than silently ranking it below the bar. Absent field adds no key, so every
  // pre-#xdompzx finding shape is carried through untouched.
  // Membership is `Object.hasOwn`, NOT a bare bracket read: this key arrives as free-form model JSON, and a bare
  // read on a normal-prototype table would accept 'toString'/'constructor'/'valueOf'/'hasOwnProperty'/'__proto__'
  // as real levels, which then compare as `NaN` and fail OPEN (#xdompzx review, blocker 2).
  if (raw.impactIfUnfixed != null && Object.hasOwn(IMPACT_STRICTNESS, String(raw.impactIfUnfixed))) {
    out.impactIfUnfixed = String(raw.impactIfUnfixed);
  }
  // #2950 — THE THREE DIRECTION TESTS, carried so the routing is auditable after the fact (a reader can see WHY a
  // finding was carved out, not just that it was). Strict booleans only; anything else adds no key, which leaves
  // the routing undecided and the finding blocking.
  for (const k of ['introduced', 'worseThanBase', 'parallelizable']) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  // #2950 — DISPOSITION, the round key. Validated against the enum by `Object.hasOwn` on the null-prototype table
  // (same reason as `impactIfUnfixed` above: this arrives as free-form model JSON, and a bare read would accept
  // 'constructor' as a real disposition). An unrecognised or absent value adds NO key and reads as UNDECLARED,
  // which `earnsRound` treats as fail-closed (blocking) — never as a silent free pass.
  const declared = raw.disposition != null && Object.hasOwn(DISPOSITION_EARNS_ROUND, String(raw.disposition))
    ? String(raw.disposition)
    : undefined;
  // #x6t2z6h — CITATION SCOPE, carried so the marker survives a re-normalization (`renderPanelComment` normalizes
  // the list again before rendering, so a key this function drops never reaches the posted comment). Validated
  // against the enum; anything else adds no key.
  //
  // IT IS DISPLAY/AUDIT DATA, AND NOTHING READS IT TO DECIDE A VERDICT. Carrying it here would otherwise be a
  // self-certification seam — a juror that wrote `citationScope: 'unverifiable'` on its own finding would be
  // un-blocking itself, the exact hole the `disposition` block above exists to refuse. It cannot be: the ONLY
  // un-blocking is `scopeFindingsToCitedFiles` withholding a finding from the set the caller reduces, and that
  // function RECOMPUTES this field from ground truth on every finding it touches, discarding whatever arrived.
  if (raw.citationScope != null && Object.hasOwn(CITATION_SCOPE_ADMITS, String(raw.citationScope))) {
    out.citationScope = String(raw.citationScope);
  }
  // #3312 — THE EVIDENCE FIELDS. `quote` and `reproCommand` are the juror's raw INPUT to the classifier and are
  // carried verbatim (trimmed, string-coerced); `evidenceKind` is carried for the same narrow reason
  // `citationScope` is — `renderPanelComment` re-normalizes before rendering, so a key dropped here never reaches
  // the posted comment. It is DISPLAY/AUDIT data: `admitFindingsByEvidence` RECOMPUTES it from ground truth and
  // discards whatever arrived, so a juror writing the field cannot pin its own finding above a floor.
  if (raw.quote != null && String(raw.quote).trim()) out.quote = String(raw.quote);
  if (raw.reproCommand != null && String(raw.reproCommand).trim()) out.reproCommand = String(raw.reproCommand).trim();
  if (raw.evidenceKind != null && Object.hasOwn(EVIDENCE_STRENGTH, String(raw.evidenceKind))) {
    out.evidenceKind = String(raw.evidenceKind);
  }
  // THE ROUTING DECIDES; A SELF-DECLARED WORD MAY ONLY EVER MAKE A FINDING *MORE* BLOCKING (PR #1082 review,
  // blocker 1). A juror that answered the three questions has already said everything that decides this, so its
  // own `disposition` word cannot override them — that is self-certification, the anchoring problem the
  // `dismissed-findings` signal exists to catch.
  //
  // THE HOLE THIS CLOSES, precisely: an earlier draft honoured ANY declared disposition when the three answers
  // were absent, so `{summary: 'this diff drops the auth check', disposition: 'carve-out'}` — no facts at all —
  // normalized to a non-blocking finding and accepted. A juror taking the obvious LLM shortcut (answer the label,
  // skip the booleans) could therefore silently un-block a finding that blocks on `main` today, on EVERY review,
  // since the disposition instructions are unconditional. Un-blocking must be EARNED by the three facts; nothing
  // else buys it. So the only self-declared word honoured without facts is `blocker`, which is the safe direction.
  const derived = deriveFindingDisposition(out);
  if (derived === DISPOSITIONS.BLOCKER || declared === DISPOSITIONS.BLOCKER) out.disposition = DISPOSITIONS.BLOCKER;
  // `nit` is a FINER LABEL on something the routing ALREADY carved out — never a route to non-blocking on its own.
  else if (derived === DISPOSITIONS.CARVE_OUT) out.disposition = declared === DISPOSITIONS.NIT ? DISPOSITIONS.NIT : derived;
  // derived === undefined and no declared `blocker`: the finding stays UNDECLARED, which `earnsRound` reads as
  // blocking. A bare `carve-out`/`nit` with no answers is dropped on the floor, exactly like an invented word.
  return out;
}

/**
 * Normalize a raw findings list. Pure. Drops anything that doesn't survive `normalizeFinding` (never throws
 * on a malformed entry — a broken record must not crash the review).
 * @param {*} rawList
 * @returns {Finding[]}
 */
export function normalizeFindings(rawList) {
  const arr = Array.isArray(rawList) ? rawList : [];
  return arr.map(normalizeFinding).filter(Boolean);
}

/** #4194 — how close two cited lines in the same file must be to count as the same spot. */
export const CORROBORATION_LINE_WINDOW = 8;

const corroborationPath = (file) => String(file ?? '').trim().replace(/^(?:\.\/|[ab]\/)/, '').replace(/:\d+(?::\d+)?$/, '');
const corroborationWords = (text) => new Set(
  String(text ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 4),
);
function wordOverlap(a, b) {
  const A = corroborationWords(a);
  const B = corroborationWords(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

/** Symmetric word overlap (|A∩B| / |A∪B|); unlike {@link wordOverlap} a subset of a longer text does not score 1. */
function wordJaccard(a, b) {
  const A = corroborationWords(a);
  const B = corroborationWords(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit += 1;
  return hit / (A.size + B.size - hit);
}
export const CARRY_SUMMARY_JACCARD_FLOOR = 0.6;

/**
 * The cited path AS WRITTEN, for every lookup against a real repository: only a `./` prefix and a `:line` suffix are
 * dropped. A leading `a/` or `b/` is a real top-level directory as often as it is a diff prefix, so it is NEVER
 * stripped here — an alias that names a different (root) file would be compared against the wrong file. The
 * prefix-stripping `corroborationPath` stays for fuzzy label matching only.
 */
export const exactCitedPath = (file) => String(file ?? '').trim().replace(/^\.\//, '').replace(/:\d+(?::\d+)?$/, '');

/**
 * ONE definition of "the same finding" for CLEARING a standing obligation (carrying an operator ruling onto a new
 * head, `findCarriedOperatorRuling`; overruling an earlier block, `ruling-ledger.mjs#ignoredRulings`): the same exact
 * path, the same spot (both lines absent, or both within {@link CORROBORATION_LINE_WINDOW}), the same claim
 * (identical, or symmetric word overlap of at least {@link CARRY_SUMMARY_JACCARD_FLOOR}), and the same severity
 * ({@link CARRY_SEVERITY_FIELDS}). A ruling is scoped to the instance the operator saw. `a` and `b` are findings
 * (`{ file, line, summary, verdict, impactIfUnfixed }`).
 */
export function sameFindingForClearing(a, b) {
  const path = exactCitedPath(a?.file);
  if (!path || path !== exactCitedPath(b?.file)) return false;
  if (!(a.line == null && b.line == null)
    && !(Number.isInteger(a.line) && Number.isInteger(b.line) && Math.abs(a.line - b.line) <= CORROBORATION_LINE_WINDOW)) return false;
  const summary = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (summary(a.summary) !== summary(b.summary) && wordJaccard(a.summary, b.summary) < CARRY_SUMMARY_JACCARD_FLOOR) return false;
  return CARRY_SEVERITY_FIELDS.every((k) => a[k] === b[k]);
}

// ── #76a FINDING IDENTITY ──────────────────────────────────────────────────────────────────────────────────────
// ONE identity for "the same finding" across records, re-wordings and heads. Measured on #4017: five wordings of one
// finding scored 0.05–0.73 word Jaccard, and an unrelated finding scored 0.50 against one of them, so TEXT SIMILARITY
// IS NEVER AN IDENTITY here. The deterministic binding is exact: same path, same lens, and the same normalized claim
// or the same quoted anchor. A re-wording with no shared anchor is a NEW id until a declared `sameAs` (#76b) binds
// it. This is the finding key the ratified #3007 plan's slice B stores (`referral{finding keys}`, `ruling{finding
// key}`), so B adds `findingId` to its event schema and never mints a second scheme.

/** A minted finding id: `f-` + the first 12 hex of a sha256. */
export const FINDING_ID_PATTERN = /^f-[0-9a-f]{12}$/;
/** A declared binding's literal "this is a new finding" answer (#76b). */
export const FINDING_SAME_AS_NEW = 'new';
/** The shortest quote, in non-whitespace characters, that may anchor an identity — the same floor that lets a quote
 *  confirm a citation (`MIN_CONFIRMABLE_QUOTE_CHARS`): a 3-character quote matches almost anything. */
export const FINDING_ANCHOR_MIN_CHARS = 12;

/**
 * The normalized identity fields of one finding. PURE. `path` keeps a leading `a/`/`b/` (it can be a real
 * directory, see {@link exactCitedPath}); `lens` is the category up to its first `/`; `normSummary` folds case,
 * width, whitespace, quoting and `:line` references so a moved line or a re-quoted name is still one claim;
 * `anchor` is the juror's quote (first non-empty line), kept only at or above {@link FINDING_ANCHOR_MIN_CHARS}.
 * @returns {{path: string, lens: string, normSummary: string, anchor: string}|null}
 */
export function normalizeFindingIdentity(raw) {
  const f = normalizeFinding(raw);
  if (!f) return null;
  const path = f.file ? exactCitedPath(f.file) : '';
  const lens = String(f.category ?? '').split('/')[0].trim().toLowerCase() || 'unknown';
  const normSummary = f.summary.normalize('NFKC').toLowerCase()
    .replace(/[`'"‘’“”]/g, '')
    .replace(/:\d+(?::\d+)?\b/g, ':N')
    .replace(/\s+/g, ' ').trim()
    .replace(/[\s.,;:!?]+$/, '');
  const firstLine = String(f.quote ?? '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  const anchor = firstLine.replace(/\s/g, '').length >= FINDING_ANCHOR_MIN_CHARS ? firstLine : '';
  return { path, lens, normSummary, anchor };
}

/** Mint a finding id ONCE, at first sighting; it is stored and never recomputed. PURE. */
export function mintFindingId({ repo, pr, path, lens, firstSeenHead, normSummary }) {
  return `f-${createHash('sha256').update([repo, pr, path, lens, firstSeenHead, normSummary].join('|')).digest('hex').slice(0, 12)}`;
}

/**
 * THE deterministic identity test (binding rule 1), shared by every cross-record matcher that binds an id. Same
 * non-empty path, same lens, and the same normalized claim or the same anchor. A finding with no path has no
 * cross-head identity: it binds only on the same head (`sameHead`), and only by its exact normalized claim.
 * `ignoreLens` drops the lens test for a match WITHIN ONE RUN, where path plus claim already name one finding and the
 * two sides' lenses are not comparable (a referral carries the juror's raw category, its deferred copy the seat's).
 */
export function sameFindingIdentity(a, b, { sameHead = false, ignoreLens = false } = {}) {
  if (!a || !b || (!ignoreLens && a.lens !== b.lens)) return false;
  if (!a.path || !b.path) return sameHead && !a.path && !b.path && a.normSummary === b.normSummary;
  if (a.path !== b.path) return false;
  return a.normSummary === b.normSummary || (Boolean(a.anchor) && a.anchor === b.anchor);
}

/** One identity-table entry for a finding already known by `findingId`. PURE. */
export function findingIdentityEntry(finding, findingId, { heads = [] } = {}) {
  const identity = normalizeFindingIdentity(finding);
  return identity ? { findingId, ...identity, summary: normalizeFinding(finding).summary, heads: [...heads], keys: [], rulings: [] } : null;
}

// ── #76b DECLARED LINKS (`sameAs`) ─────────────────────────────────────────────────────────────────────────────
// A re-wording that shares no normalized claim and no quote with its earlier self (#4017's "concurrent filing"
// finding, worded four ways across six heads) is bound only by a DECLARED link: the mandatory referral reviewer, shown
// the PR's identity table, answers `sameAs: <findingId>` per referral, recorded on its append-only ruling. A link is
// honored only when the structure does not contradict it — same non-empty path, same lens, and (when both sides cite
// lines) a cited line within CORROBORATION_LINE_WINDOW of one the id already holds. Anything else stays a separate id:
// when unsure, keep separate. A link is never a clearance: it can make a wording inherit a BLOCK on its id (a
// tightening), never a not-real or a card (see `linkedBlockedFindingIds`).

/** The literal instruction the referral reviewer gets for `sameAs` (shared by the sink and the #76b replay). */
export const FINDING_SAME_AS_MANDATE = 'Each referral carries its own findingId. Known findings on this PR are listed '
  + 'with their findingId, path, lens, cited lines, summary and latest ruling. For each ruling also return sameAs: the '
  + 'findingId of a known finding that this referral reports as the SAME defect (same file, same root cause, merely '
  + 'worded differently), or "new". Answer "new" when unsure or when the defects merely look alike. sameAs never '
  + 'changes your ruling: rule every referral on its own evidence.';

/**
 * May a declared `sameAs` bind `finding` to `entry`? The structural guard every declared link passes — at record time
 * (the sink) and at read time ({@link findingIdentityTable}). PURE.
 */
export function sameAsLinkAllowed(entry, finding) {
  const identity = normalizeFindingIdentity(finding);
  if (!entry || !identity || !entry.path || entry.path !== identity.path || entry.lens !== identity.lens) return false;
  const line = normalizeFinding(finding)?.line;
  const lines = (entry.lines ?? []).filter(Number.isInteger);
  return !Number.isInteger(line) || !lines.length || lines.some((l) => Math.abs(l - line) <= CORROBORATION_LINE_WINDOW);
}

/** The table rows the referral reviewer sees: one per id, never the raw finding bodies. PURE. */
export function findingIdentityPromptRows(table = []) {
  return (Array.isArray(table) ? table : []).map((e) => ({ findingId: e.findingId, path: e.path || null, lens: e.lens,
    lines: [...new Set(e.lines ?? [])], summary: e.summary, latestRuling: e.rulings.at(-1)?.result ?? null }));
}

/** The `sameAs` a referral declares: on the referral entry (#76a), else on the latest ruling of its key (#76b). */
const declaredSameAs = (record, f) => f.sameAs
  ?? (record.rulings ?? []).filter((r) => r.key === f.key && FINDING_ID_PATTERN.test(r.sameAs ?? '')).at(-1)?.sameAs;

/**
 * The PR's finding-identity table, folded over referral records in their append order. Each referral binds, in
 * order, to: its stored `findingId`; a declared `sameAs` (on the referral entry, or on its key's ruling, #76b) naming
 * an existing id that passes {@link sameAsLinkAllowed} (else refused, i.e. treated as new); the deterministic test
 * ({@link sameFindingIdentity}); else a freshly minted id.
 * Binding is a lookup, never a clearance: the table says which records talk about one finding, and every gate rule
 * that could CLEAR on it adds its own unchanged-code test (#76b). PURE.
 * @returns {Array<{findingId: string, path: string, lens: string, normSummary: string, anchor: string,
 *   summary: string, firstSeenHead: string, heads: string[], lines: number[],
 *   keys: Array<{head: string, runId: string, key: string}>,
 *   rulings: Array<{head: string, runId: string, key: string, result: string}>}>}
 */
export function findingIdentityTable(records = []) {
  const table = [];
  const byId = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    for (const f of Array.isArray(record?.referrals) ? record.referrals : []) {
      const identity = normalizeFindingIdentity(f.original ?? f.finding);
      if (!identity) continue;
      let entry = FINDING_ID_PATTERN.test(f.findingId ?? '') ? byId.get(f.findingId) : undefined;
      const sameAs = declaredSameAs(record, f);
      if (!entry && FINDING_ID_PATTERN.test(sameAs ?? '')) {
        const declared = byId.get(sameAs);
        // #76b — the structural guard: same path, same lens, no contradicting cited line.
        if (sameAsLinkAllowed(declared, f.original ?? f.finding)) entry = declared;
      }
      // A declared `sameAs: 'new'` is the record's own answer that this is a distinct finding: the deterministic
      // test must not override it.
      if (!entry && !FINDING_ID_PATTERN.test(f.findingId ?? '') && f.sameAs !== FINDING_SAME_AS_NEW) {
        // Every wording already bound to an entry (deterministically or by a declared link) is one of its forms, so a
        // later copy of ANY of them binds deterministically too (#76b).
        entry = table.find((e) => (e.forms ?? [e]).some((form) => sameFindingIdentity({ ...e, ...form }, identity,
          { sameHead: e.heads.includes(record.head) })));
      }
      if (!entry) {
        let findingId = FINDING_ID_PATTERN.test(f.findingId ?? '') ? f.findingId
          : mintFindingId({ repo: record.repo, pr: record.pr, firstSeenHead: record.head, ...identity });
        // Only a declared-new copy can mint a taken id (anything else that matched would have bound above): salt it.
        for (let n = 1; !FINDING_ID_PATTERN.test(f.findingId ?? '') && byId.has(findingId); n++) {
          findingId = mintFindingId({ repo: record.repo, pr: record.pr, firstSeenHead: record.head, ...identity,
            normSummary: `${identity.normSummary}#${n}` });
        }
        entry = { findingId, ...identity, summary: normalizeFinding(f.original ?? f.finding).summary,
          firstSeenHead: record.head, heads: [], lines: [], keys: [], rulings: [] };
        table.push(entry);
        byId.set(findingId, entry);
      }
      const line = normalizeFinding(f.original ?? f.finding)?.line;
      if (Number.isInteger(line)) (entry.lines ??= []).push(line);
      entry.forms ??= [];
      if (!entry.forms.some((x) => x.normSummary === identity.normSummary && x.anchor === identity.anchor)) {
        entry.forms.push({ normSummary: identity.normSummary, anchor: identity.anchor });
      }
      if (!entry.heads.includes(record.head)) entry.heads.push(record.head);
      entry.keys.push({ head: record.head, runId: record.runId, key: f.key });
      for (const r of (record.rulings ?? []).filter((x) => x.key === f.key)) {
        entry.rulings.push({ head: record.head, runId: record.runId, key: f.key, result: r.result });
      }
    }
  }
  return table;
}

/** The id a referral `key` holds in `table` for one (head, run), or null. PURE. */
export function findingIdOf(table, { head, runId, key }) {
  return (table ?? []).find((e) => e.keys.some((k) => k.head === head && k.runId === runId && k.key === key))?.findingId ?? null;
}

/**
 * Bind each finding to an existing id in `table` by the DETERMINISTIC rule only (no declared `sameAs`, no text
 * similarity). Returns one id or null per finding, aligned with `findings`. `sameHead` asserts that the findings and
 * the table come from one head, which is the only case a pathless finding may bind. `ignoreLens` is for a match within
 * one run (see {@link sameFindingIdentity}). PURE.
 * @returns {Array<string|null>}
 */
export function bindFindingIds(findings, table, { sameHead = false, ignoreLens = false } = {}) {
  return (Array.isArray(findings) ? findings : []).map((finding) => {
    const identity = normalizeFindingIdentity(finding);
    if (!identity) return null;
    return (table ?? []).find((e) => (e.forms ?? [e]).some((form) => sameFindingIdentity({ ...e, ...form }, identity,
      { sameHead, ignoreLens })))?.findingId ?? null;
  });
}

/**
 * #4194 — DID ANOTHER SEAT RAISE THE SAME PROBLEM? PURE, deterministic. Used to stamp an ADDED (non-Claude)
 * review seat's finding with whether one of Claude's own seats confirmed it. Two findings corroborate when they
 * cite the same file (the same path once a `./`/`a/`/`b/` prefix and a `:line` suffix are stripped — never a mere
 * shared tail: `apps/api/lib/config.mjs` and `lib/config.mjs` are different files) AND either sit within {@link CORROBORATION_LINE_WINDOW} lines of each
 * other or share at least a quarter of their significant summary words; with no file on one side, the words alone
 * must overlap by at least half. A heuristic on purpose — it only LABELS an advisory finding, it never admits or
 * blocks anything — and it errs toward "not confirmed" (a missed match costs nothing but a weaker label).
 * @param {object} finding
 * @param {Array<object>} others
 * @returns {object|null} the first corroborating finding in `others`, or null.
 */
export function findingCorroboratedBy(finding, others = []) {
  const f = normalizeFinding(finding);
  if (!f) return null;
  for (const raw of Array.isArray(others) ? others : []) {
    const o = normalizeFinding(raw);
    if (!o) continue;
    const fp = corroborationPath(f.file);
    const op = corroborationPath(o.file);
    const words = wordOverlap(`${f.summary} ${f.failure_scenario ?? ''}`, `${o.summary} ${o.failure_scenario ?? ''}`);
    if (fp && op) {
      if (fp !== op) continue;
      const near = Number.isInteger(f.line) && Number.isInteger(o.line) && Math.abs(f.line - o.line) <= CORROBORATION_LINE_WINDOW;
      if (near || words >= 0.25) return raw;
    } else if (words >= 0.5) {
      return raw;
    }
  }
  return null;
}

/**
 * #x6t2z6h — WHERE A FINDING'S CITATION STANDS AGAINST THE SUBJECT'S GROUND-TRUTH FILE LIST.
 *
 *   • `in-scope`     — the cited path resolves to a file the subject actually changed.
 *   • `uncited`      — the finding names no file at all. A perfectly good finding (a claim about the PR
 *                      description, a whole-diff observation); NEVER flagged, and it carries no key.
 *   • `unverifiable` — the finding cites a path that is NOT in the subject's changed-file set, under any
 *                      canonicalisation. The claim's one machine-checkable fact is false.
 */
export const CITATION_SCOPES = Object.freeze({
  IN_SCOPE: 'in-scope',
  UNCITED: 'uncited',
  UNVERIFIABLE: 'unverifiable',
});

/**
 * Which citation scopes are ADMITTED to the set a verdict reduces. A `frozenLookup` (null-prototype) for the same
 * reason `DISPOSITION_EARNS_ROUND` is one: the key can arrive as free-form model JSON, and a bare bracket read on a
 * normal literal would answer for `'constructor'`. Read through `admitsCitation` only.
 */
const CITATION_SCOPE_ADMITS = frozenLookup({
  [CITATION_SCOPES.IN_SCOPE]: true,
  [CITATION_SCOPES.UNCITED]: true,
  [CITATION_SCOPES.UNVERIFIABLE]: false,
});

/** Does a finding at this citation scope reach the set a verdict is reduced from? FAIL-OPEN on an unknown scope —
 *  an unrecognised word must never silently withhold a finding from the verdict, which is the DROP direction and
 *  the one that costs an escaped defect.
 *  @param {string|undefined|null} scope
 *  @returns {boolean} */
export function admitsCitation(scope) {
  if (scope === undefined || scope === null) return true;
  const k = String(scope);
  return Object.hasOwn(CITATION_SCOPE_ADMITS, k) ? CITATION_SCOPE_ADMITS[k] : true;
}

/**
 * #x6t2z6h — every form a cited path might reasonably have been written in, widest first. Pure.
 *
 * THE DIRECTION IS DELIBERATE AND IT IS THE WHOLE SAFETY ARGUMENT: this returns CANDIDATES to match, never a single
 * canonical form to compare by. Adding a candidate can only ever make a citation MATCH — i.e. can only ever admit a
 * finding — so a canonicalisation this function gets wrong costs a missed hallucination, never a dropped real
 * finding. Rewriting it as "normalise both sides, compare once" inverts that: a wrong rewrite then REJECTS.
 *
 * Handles: surrounding backticks; a `we:`-style repo prefix (#883 markdown locus form); a trailing `:120` or
 * `#L12-L20` line pin; a leading `./`, `/`, or a diff-side `a/` / `b/`.
 * @param {*} file
 * @returns {string[]} de-duplicated, blanks removed.
 */
export function citedPathCandidates(file) {
  if (file == null) return [];
  const seen = [];
  const add = (v) => {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t && !seen.includes(t)) seen.push(t);
  };
  let p = String(file).trim();
  add(p);
  p = p.replace(/^`+/, '').replace(/`+$/, '').trim();
  add(p);
  // A repo prefix (`we:`, `fui:`) — only when what follows is not a slash, so a Windows drive letter is untouched.
  add(p.replace(/^[A-Za-z][A-Za-z0-9_-]*:(?=[^/])/, ''));
  for (const base of [...seen]) {
    // A trailing line pin, in either form the corpus writes it.
    add(base.replace(/(?::L?\d+(?:[-:]L?\d+)?|#L\d+(?:-L?\d+)?)$/, ''));
  }
  for (const base of [...seen]) {
    add(base.replace(/^\.\//, '').replace(/^\/+/, ''));
  }
  for (const base of [...seen]) {
    add(base.replace(/^[ab]\//, ''));
  }
  return seen;
}

/**
 * #x6t2z6h — WHICH ground-truth path a cited path matches, or `''` for none. Pure, and the ONE matcher both the
 * citation gate and the #3312 evidence classifier read through, so "does this citation resolve" cannot answer one
 * way for the scope marker and another for the source lookup.
 *
 * A candidate matches a scope path when it EQUALS it, or when either ends with `/` + the other — so a juror that
 * wrote only the basename (`review-pr.mjs`), or an absolute path with a checkout prefix, is IMPRECISE and matched,
 * not fabricated.
 *
 * @param {string} cited - the path as the juror wrote it.
 * @param {string[]} paths - already-trimmed ground-truth paths.
 * @returns {string} the matched ground-truth path, or `''`.
 */
function matchCitedPath(cited, paths) {
  for (const candidate of citedPathCandidates(cited)) {
    for (const path of paths) {
      if (path === candidate) return path;
      if (path.endsWith(`/${candidate}`) || candidate.endsWith(`/${path}`)) return path;
    }
  }
  return '';
}

/**
 * #x6t2z6h — classify ONE finding's citation against a ground-truth changed-file list. Pure.
 *
 * Matching goes through `matchCitedPath`: an imprecise citation (a bare basename, an absolute path with a checkout
 * prefix) is admitted, not fabricated. Only a path that matches nothing in the set under any candidate form is
 * `unverifiable`.
 *
 * @param {{file?: string}|null|undefined} finding
 * @param {{scope?: string[]}} [o] - the ground-truth changed-file list. An EMPTY list is not ground truth; every
 *   finding classifies `uncited` rather than `unverifiable`, so a caller that forgets to guard cannot flag the world.
 * @returns {'in-scope'|'uncited'|'unverifiable'}
 */
export function findingCitationScope(finding, { scope = [] } = {}) {
  const cited = finding && finding.file != null ? String(finding.file).trim() : '';
  if (!cited) return CITATION_SCOPES.UNCITED;
  const paths = (Array.isArray(scope) ? scope : []).filter(Boolean).map((p) => String(p).trim()).filter(Boolean);
  if (!paths.length) return CITATION_SCOPES.UNCITED;
  return matchCitedPath(cited, paths) ? CITATION_SCOPES.IN_SCOPE : CITATION_SCOPES.UNVERIFIABLE;
}

/**
 * #x6t2z6h — THE OFF-SCOPE-CITATION GATE. Split a findings list into what is PUBLISHED and what the verdict is
 * REDUCED FROM. Pure.
 *
 * THE RULING (see the card): a finding citing a file outside the subject's changed-file set is **downgraded to
 * non-blocking and kept fully visible** — never dropped, never a refusal of the whole run.
 *   - NOT REFUSE. The review happened; one bad citation from one seat must not discard the other seat's real
 *     findings. Refusal is reserved for a juror that said NOTHING (`unrun`), which is a different claim.
 *   - NOT DROP. A validator that deletes findings is worse than the hole it closes: a real defect whose path is
 *     merely stale (a rename, a sibling-lane file) would vanish silently, and an escaped defect costs more than a
 *     wasted round. So `findings` — the PUBLISHED list — keeps every one of them.
 *   - DOWNGRADE + DISCLOSE. `admitted` is what a verdict reduces, and it withholds the unverifiable ones, so a
 *     claim whose only checkable fact is false loses its AUTOMATED consequence and keeps its human-readable one.
 *
 * NOT FORGEABLE. `citationScope` is RECOMPUTED on every finding here and whatever arrived on the input is
 * discarded, so a juror writing the field cannot withhold its own finding from the verdict (nor pin one in).
 *
 * NOT ENFORCED WITHOUT GROUND TRUTH. An empty `scope` returns everything admitted and unmarked, with
 * `enforced: false`. On a degraded basis the changed-file list is empty or inflated, and enforcing there would
 * flag every legitimate finding at once — the drop direction, arrived at by omission.
 *
 * @param {Array<object>} findings - raw or normalized; normalized here either way.
 * @param {{scope?: string[]}} [o] - the ground-truth changed-file list, or empty/omitted to not enforce.
 * @returns {{findings: Finding[], admitted: Finding[], unverifiable: Finding[], enforced: boolean}}
 */
export function scopeFindingsToCitedFiles(findings, { scope = [] } = {}) {
  const paths = (Array.isArray(scope) ? scope : []).filter(Boolean).map((p) => String(p).trim()).filter(Boolean);
  // Strip any inbound `citationScope` UNCONDITIONALLY, enforced or not — a field only this function may write.
  const list = normalizeFindings(findings).map(({ citationScope: _inbound, ...rest }) => rest);
  if (!paths.length) return { findings: list, admitted: list, unverifiable: [], enforced: false };
  const marked = list.map((f) => {
    const scoped = findingCitationScope(f, { scope: paths });
    return scoped === CITATION_SCOPES.UNCITED ? f : { ...f, citationScope: scoped };
  });
  return {
    findings: marked,
    admitted: marked.filter((f) => admitsCitation(f.citationScope)),
    unverifiable: marked.filter((f) => !admitsCitation(f.citationScope)),
    enforced: true,
  };
}

/**
 * EVIDENCE KIND (#3312) — WHAT A MACHINE COULD ACTUALLY CHECK ABOUT THIS FINDING, ranked least to most.
 *
 * The ladder is defined by how much of the claim THIS PURE FUNCTION confirmed, not by how convincing the finding
 * reads. That distinction is the whole point: a juror's prose confidence is self-rated and the epic (#3318) records
 * it as a poor predictor, so nothing here reads `verdict`, `severity` or `impactIfUnfixed` to place a rung.
 *
 *   • `assertion`          — nothing checkable. Prose, possibly entirely correct. This is the DEFAULT and the
 *                            majority rung; see `EVIDENCE_FLOOR` for why it is not treated as worthless.
 *   • `resolved-citation`  — the finding names a file and that file IS in the subject's changed set. ONE fact is
 *                            confirmed: the location exists. It says NOTHING about whether the claim is true, and
 *                            calling this "evidence" at all is generous — it is the weakest rung above prose.
 *   • `repro`              — the finding carries a single-line, command-shaped `reproCommand`. NOT EXECUTED HERE
 *                            (this module is pure and holds no runner), so this rung means "falsifiable on demand
 *                            by anyone", never "observed to fail". A well-formed command that does not reproduce
 *                            anything sits on this rung.
 *   • `quoted-citation`    — a resolved citation PLUS a `quote` that literally occurs in the supplied source text
 *                            for the matched file. The strongest thing a pure function can confirm — and it
 *                            confirms only that THE SOURCE SAYS THE QUOTED WORDS, never that those words imply the
 *                            defect. A juror can quote a real line and draw a false conclusion from it, and this
 *                            rung will not notice.
 *
 * WHAT THIS IS DELIBERATELY NOT: a red-before/green-after test run. That is the card's strongest evidence kind and
 * it is out of reach here for the reason epic #3318 records against this element — `test:unit` is ~693s against a
 * 20-minute juror kill, so a juror cannot run the suite inside its own budget. Do not read `repro` as covering it.
 */
export const EVIDENCE_KINDS = Object.freeze({
  ASSERTION: 'assertion',
  RESOLVED_CITATION: 'resolved-citation',
  REPRO: 'repro',
  QUOTED_CITATION: 'quoted-citation',
});

/** The evidence ordering, weakest first. Same fail-loud contract as `IMPACT_STRICTNESS`: total over
 *  `EVIDENCE_KINDS`, asserted at module load, and NULL-PROTOTYPE (`frozenLookup`) because the key can arrive as
 *  free-form model JSON — on a normal literal `TABLE['constructor']` would validate as a real rung and then compare
 *  as `NaN`, losing every `>=` comparison in both directions.
 *  @evidence-total — every `EVIDENCE_KINDS` member must be a key. */
export const EVIDENCE_STRENGTH = frozenLookup({
  [EVIDENCE_KINDS.ASSERTION]: 0,
  [EVIDENCE_KINDS.RESOLVED_CITATION]: 1,
  [EVIDENCE_KINDS.REPRO]: 2,
  [EVIDENCE_KINDS.QUOTED_CITATION]: 3,
});

/** WHAT EACH RUNG MEANS, as DATA — same single-sourcing discipline as `IMPACT_GLOSS` (#xdompzx finding 6): a prose
 *  copy elsewhere drifts, so every doc and any future mandate text renders from here.
 *  @evidence-total — every `EVIDENCE_KINDS` member must be a key. */
export const EVIDENCE_GLOSS = frozenLookup({
  [EVIDENCE_KINDS.ASSERTION]: 'prose only — nothing here is machine-checkable',
  [EVIDENCE_KINDS.RESOLVED_CITATION]: 'names a file that is really in the subject; the claim itself is unchecked',
  [EVIDENCE_KINDS.REPRO]: 'carries a single-line, command-shaped repro — falsifiable on demand, NOT run here',
  [EVIDENCE_KINDS.QUOTED_CITATION]: 'quotes text that really appears in the cited source; the inference from it is still unchecked',
});

// ENFORCE TOTALITY at module load over both structures total over `EVIDENCE_KINDS`, exactly as `IMPACT_LEVELS`
// does above. A rung added without a rank would compare as `undefined` at every floor test.
for (const kind of Object.values(EVIDENCE_KINDS)) {
  if (!Object.hasOwn(EVIDENCE_STRENGTH, kind)) {
    throw new Error(`EVIDENCE_STRENGTH is not total over EVIDENCE_KINDS: kind "${kind}" has no rank — add it (the table must rank every EVIDENCE_KINDS member).`);
  }
  if (!Object.hasOwn(EVIDENCE_GLOSS, kind)) {
    throw new Error(`EVIDENCE_GLOSS is not total over EVIDENCE_KINDS: kind "${kind}" has no gloss — add it (every doc surface renders the definition from this map).`);
  }
}

/** Rank an evidence kind. THROWS on an unranked kind rather than yielding `undefined` — the fail-loud backstop for
 *  every floor comparison, shared with `impactStrictness`/`verdictStrictness` through `rankIn`.
 *  @param {string} kind
 *  @returns {number} */
export function evidenceStrength(kind) {
  return rankIn(EVIDENCE_STRENGTH, kind, 'evidenceStrength: no rank for evidence kind');
}

/**
 * THE DEFAULT FLOOR IS THE BOTTOM RUNG, AND THAT IS THE RULING — NOT AN OVERSIGHT (#3312).
 *
 * The card asks that "assertion-only findings advise and never block". Shipped as the DEFAULT, that is the DROP
 * direction, and this repo has already ruled against the drop direction twice on the same seam:
 *
 *   1. #3351 (`scopeFindingsToCitedFiles`, above) chose DOWNGRADE-AND-DISCLOSE over dropping a finding whose cited
 *      path is *demonstrably false*, on the reasoning that an escaped defect costs more than a wasted round.
 *   2. `admitsCitation` fails OPEN on an unrecognised scope word for the same stated reason.
 *
 * Those two withhold on DISPROOF — a fact the run checked and found false. An evidence floor withholds on ABSENCE —
 * the run had nothing to check. Absence is a far weaker basis, and the parent programme's own record says so: on
 * PR #1569 the `claim-accuracy` juror found a real test defect TWO ROUNDS before anyone else and rated it
 * `PLAUSIBLE`/`cosmetic`, saying "I did not execute this in a live clone". Under a default-on assertion floor that
 * real, early, correct finding would have been demoted to advisory. Epic #3318 draws the opposite lesson from it in
 * as many words: what belongs in the brief is the mutation probe, "not a ranking of lenses".
 *
 * So the floor SHIPS AT `assertion`, where it demotes nothing and every finding blocks exactly as it does on
 * `main`. This is a strict relaxation, in the same sense `earnsRound`'s `disposition` is: a dial the caller turns
 * on deliberately, never a verdict change nobody opted into. Raising it is a one-line change here — but it should
 * be made on MEASURED per-category precision (front A of #3318), not on the intuition that prose is weak.
 */
export const EVIDENCE_FLOOR = EVIDENCE_KINDS.ASSERTION;

/**
 * The impact level at which a finding is EXEMPT from the evidence floor however high the caller raises it (#3312).
 *
 * Set to `unrecoverable`: "data or work is destroyed with no way back". Yes, `impactIfUnfixed` is self-rated, and
 * the card is right that self-rating is a poor gate — but this uses it in the ONE direction `normalizeFinding`
 * already honours a self-declared word (see the `disposition` block: a self-declaration may only ever make a finding
 * MORE blocking, never less). A juror over-claiming `unrecoverable` costs a round. Under-claiming it costs the
 * defect, and this floor is the only thing in the file that could silence it.
 */
export const EVIDENCE_EXEMPT_IMPACT_BAR = IMPACT_LEVELS.UNRECOVERABLE;

/** The shortest `quote` that can confirm a rung, in non-whitespace characters. A 3-character quote occurs in almost
 *  any source file by accident, which would make `quoted-citation` free to claim. 12 is a judgement call, not a
 *  measured threshold — say so rather than implying it was tuned. */
const MIN_CONFIRMABLE_QUOTE_CHARS = 12;

/** Collapse every whitespace run to one space and trim, so a quote that survived a re-wrap or an indent change still
 *  matches the source. Applied to BOTH sides. */
const flattenWhitespace = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Does this string LOOK like a single re-runnable command? Pure, and deliberately shallow.
 *
 * WHAT IT SCANS, exactly — do not describe it as more (#3362): the value must be a string; non-empty after trim;
 * hold no newline; be at most 500 characters; NOT end in a sentence terminator (`.`, `!`, `?`, `:`, `;`); and its
 * FIRST whitespace-delimited token must match `/^[A-Za-z_./][\w.\-/]*$/` — a bare command word or a path to one.
 *
 * WHAT IT DOES NOT DO, and the gap is real: it does not run the command, resolve the binary, check the flags, or
 * verify that it reproduces anything. `npx vitest run nothing-at-all` passes. Nor is it a PROSE DETECTOR — the
 * terminator rule catches an English sentence written as one, and nothing catches an unpunctuated fragment like
 * `Run the suite and watch it fail`, whose first token is command-shaped. It separates "something command-shaped
 * was attached" from "a paragraph was attached", and that is the whole claim.
 * @param {*} value
 * @returns {boolean}
 */
export function isReproCommand(value) {
  if (typeof value !== 'string') return false;
  const t = value.trim();
  if (!t || t.length > 500 || t.includes('\n')) return false;
  if (/[.!?:;]$/.test(t) && /\s/.test(t)) return false; // a sentence, not a command (a single dotted token is fine)
  const [first] = t.split(/\s+/);
  return /^[A-Za-z_./][\w.\-/]*$/.test(first);
}

/**
 * #3312 — classify ONE finding's evidence against whatever ground truth the caller supplied. Pure.
 *
 * MONOTONE IN THE GROUND TRUTH, deliberately, and it is the safety argument here exactly as
 * `citedPathCandidates`'s "candidates, never a canonical form" is there: supplying MORE ground truth can only ever
 * raise a finding's rung, never lower it. So a caller that forgets to pass `sources` understates evidence — and
 * because a lower rung is the one a floor demotes, `admitFindingsByEvidence` refuses to enforce a floor whose
 * ground truth is missing rather than quietly demoting the world.
 *
 * @param {{file?: string, quote?: string, reproCommand?: string}|null|undefined} finding
 * @param {{scope?: string[], sources?: Object<string, string>}} [o] - `scope` is the subject's changed-file list;
 *   `sources` maps a path in that list to its text. Both optional; each one absent simply caps the rung reachable.
 * @returns {'assertion'|'resolved-citation'|'repro'|'quoted-citation'}
 */
export function classifyFindingEvidence(finding, { scope = [], sources = {} } = {}) {
  if (!finding || typeof finding !== 'object') return EVIDENCE_KINDS.ASSERTION;
  const paths = (Array.isArray(scope) ? scope : []).filter(Boolean).map((p) => String(p).trim()).filter(Boolean);
  const cited = finding.file != null ? String(finding.file).trim() : '';
  const matched = cited && paths.length ? matchCitedPath(cited, paths) : '';
  // TOP RUNG FIRST. A resolved citation whose quote is really in that file's text.
  const quote = finding.quote != null ? String(finding.quote) : '';
  if (matched && flattenWhitespace(quote).replace(/\s/g, '').length >= MIN_CONFIRMABLE_QUOTE_CHARS) {
    // The source is looked up by the MATCHED ground-truth path first, then by any candidate form of what the juror
    // wrote — so a `sources` map keyed the way the juror cited still resolves.
    const source = Object.hasOwn(sources ?? {}, matched)
      ? sources[matched]
      : citedPathCandidates(cited).map((c) => (Object.hasOwn(sources ?? {}, c) ? sources[c] : undefined)).find((v) => v != null);
    if (typeof source === 'string' && flattenWhitespace(source).includes(flattenWhitespace(quote))) {
      return EVIDENCE_KINDS.QUOTED_CITATION;
    }
  }
  if (isReproCommand(finding.reproCommand)) return EVIDENCE_KINDS.REPRO;
  if (matched) return EVIDENCE_KINDS.RESOLVED_CITATION;
  return EVIDENCE_KINDS.ASSERTION;
}

/**
 * #3312 — THE EVIDENCE FLOOR. Classify every finding, mark it, and split off the round-earning ones whose evidence
 * sits BELOW the caller's floor. Pure.
 *
 * SAME RULING AS #3351, APPLIED TO A WEAKER BASIS: publish everything, demote some. `findings` — the PUBLISHED
 * list — keeps every finding, each carrying its `evidenceKind` so the demotion is disclosed rather than silent.
 * `admitted` is what a verdict reduces. `advisory` is what was withheld, kept so a caller can name the count in the
 * confirm question the way `unverifiableCitations` already is.
 *
 * IT DEMOTES NOTHING UNLESS ASKED. `floor` defaults to `EVIDENCE_FLOOR` (`assertion`, the bottom rung) — read that
 * constant's doc for why the card's "assertion-only never blocks" is NOT the shipped default. Every other
 * not-enforced case is the same fail-open instinct as `admitsCitation`'s:
 *
 *   - an unrecognised or unrankable `floor` → not enforced (never "demote everything on a typo");
 *   - a floor above `assertion` with an EMPTY `scope` → not enforced. Without the changed-file list every citation
 *     classifies `assertion`, so enforcing there demotes every legitimate finding at once — the drop direction
 *     arrived at by omission, which is precisely the trap `scopeFindingsToCitedFiles` guards with `enforced: false`;
 *   - a floor of `quoted-citation` with no `sources` → not enforced, for the same reason one rung up.
 *
 * TWO MORE THINGS ARE NEVER DEMOTED, whatever the floor: a finding at or above `EVIDENCE_EXEMPT_IMPACT_BAR`, and a
 * finding that does not earn a round anyway (a `carve-out`/`nit` is already non-blocking, so listing it as demoted
 * would inflate the withheld count with findings the floor did not touch).
 *
 * ORTHOGONAL TO THE CITATION GATE, and the two compose in either order: that gate withholds on DISPROOF (a checked
 * fact came back false), this one on ABSENCE (there was nothing to check). Do not fold them together — their
 * defaults differ for that exact reason.
 *
 * NOT FORGEABLE. `evidenceKind` is RECOMPUTED here and any inbound value discarded, so a juror cannot pin its own
 * finding above the floor.
 *
 * @param {Array<object>} findings - raw or normalized; normalized here either way.
 * @param {{scope?: string[], sources?: Object<string, string>, floor?: string}} [o]
 * @returns {{findings: Finding[], admitted: Finding[], advisory: Finding[], enforced: boolean, floor: string, reason: string}}
 */
export function admitFindingsByEvidence(findings, { scope = [], sources = {}, floor = EVIDENCE_FLOOR } = {}) {
  const paths = (Array.isArray(scope) ? scope : []).filter(Boolean).map((p) => String(p).trim()).filter(Boolean);
  const sourceMap = sources && typeof sources === 'object' ? sources : {};
  // Strip any inbound `evidenceKind` UNCONDITIONALLY, enforced or not — a field only this function may write.
  const list = normalizeFindings(findings).map(({ evidenceKind: _inbound, ...rest }) => rest);
  const marked = list.map((f) => ({ ...f, evidenceKind: classifyFindingEvidence(f, { scope: paths, sources: sourceMap }) }));
  const floorKey = floor == null ? '' : String(floor);
  const notEnforced = (reason) => ({ findings: marked, admitted: marked, advisory: [], enforced: false, floor: floorKey, reason });

  if (!Object.hasOwn(EVIDENCE_STRENGTH, floorKey)) return notEnforced(`unrecognised evidence floor "${floorKey}" — nothing demoted`);
  const bar = evidenceStrength(floorKey);
  if (bar <= 0) return notEnforced('the floor is the bottom rung — every finding clears it');
  if (!paths.length) return notEnforced('no changed-file list, so no citation can resolve — enforcing would demote every finding');
  if (bar >= evidenceStrength(EVIDENCE_KINDS.QUOTED_CITATION) && !Object.keys(sourceMap).length) {
    return notEnforced('the floor requires quoted source text but no `sources` were supplied — enforcing would demote every finding');
  }

  const exemptBar = impactStrictness(EVIDENCE_EXEMPT_IMPACT_BAR);
  const demoted = (f) => {
    if (!earnsRound(f)) return false; // already non-blocking; the floor is not what stops it
    if (f.impactIfUnfixed && impactStrictness(f.impactIfUnfixed) >= exemptBar) return false;
    return evidenceStrength(f.evidenceKind) < bar;
  };
  return {
    findings: marked,
    admitted: marked.filter((f) => !demoted(f)),
    advisory: marked.filter(demoted),
    enforced: true,
    floor: floorKey,
    reason: '',
  };
}

/**
 * Derive the overall verdict from a normalized findings list + the #2285 conflict-of-interest flag. Pure —
 * the SAME derivation every caller (a `/code-review`-shaped renderer, the drain auto-review, `/review`) uses
 * so "what does this set of findings mean" is decided once:
 *
 *   - `humanRequired` → `needs-human`, ALWAYS (checked first — a gate-self edit is never agent-cleared no
 *     matter how clean the findings look; mirrors `we:scripts/lib/review-escalation.mjs`'s `decideReviewGate`).
 *   - otherwise: any finding still OUTSTANDING (no `outcome`, or `outcome: 'skipped'`) *that EARNS a round*
 *     (#2950 — `disposition: 'blocker'`, or undeclared, which fails closed) → `changes`.
 *     A first-pass review has no `outcome` yet, so any BLOCKING finding present outstands it; a RE-report after
 *     fixes (`outcome: 'fixed'|'no_change_needed'`) resolves that finding, leaving only genuinely unaddressed ones.
 *     A `carve-out`/`nit` finding is reported everywhere but never bounces the subject into another round.
 *   - all findings resolved BUT one still names an uncaptured, filable PREVENTION guard → `prevention-outstanding`
 *     (#2823, the accept-gated-on-capture negotiation): a clean accept is withheld until the guard is captured or
 *     filed. See `hasUncapturedPrevention`. This is the ONE place the acceptance gate is enforced, so every
 *     surface that reduces to `deriveVerdict` inherits it — no reviewer can accept a finding whose guard evaporated.
 *   - no outstanding findings AND no uncaptured prevention → `accept`.
 *
 * @verdicts-total — every `VERDICTS` member is a distinct return (needs-human, changes, prevention-outstanding,
 *   accept); the `check:standards` verdict-totality gate enforces it so a new member can't be dropped from the ladder.
 * @param {{findings?: Finding[]|Array<object>, humanRequired?: boolean}} [o]
 * @returns {'accept'|'changes'|'needs-human'|'prevention-outstanding'}
 */
export function deriveVerdict({ findings = [], humanRequired = false, bar = PREVENTION_IMPACT_BAR } = {}) {
  if (humanRequired) return VERDICTS.NEEDS_HUMAN;
  const list = normalizeFindings(findings);
  // #2950 — only a BLOCKER earns a round. A finding the juror dispositioned `carve-out` or `nit` is still
  // reported, still ledgered, still in the notice; it simply does not bounce the subject into another
  // editor↔reviewer pass. Undeclared ⇒ blocking (`earnsRound` fails closed), so this is byte-stable for every
  // pre-#2950 finding shape.
  const outstanding = list.filter((f) => isFindingOutstanding(f) && earnsRound(f));
  if (outstanding.length > 0) return VERDICTS.CHANGES;
  // #2823 — accept is GATED ON PREVENTION CAPTURE. Even with every finding resolved, a finding whose named
  // prevention is neither already captured (an existing gate) nor filed as a future item withholds a clean
  // accept — the reviewer accepts only once every reasonable prevention is captured or filed.
  // #xdompzx — gated on IMPACT too, via `blocksAcceptance` (see its doc for the notice-wide / verdict-narrow split).
  if (list.some((f) => blocksAcceptance(f, { bar }))) return VERDICTS.PREVENTION_OUTSTANDING;
  return VERDICTS.ACCEPT;
}

/**
 * #2823 — does this finding carry a named PREVENTION guard that is NOT yet captured (neither an existing gate
 * nor filed as a future item)? Pure. A finding with no `prevention` names no guard, so it is never reported here —
 * an old-shape finding (pre-#2823) is unaffected.
 *
 * THE WIDE HALF of the notice-wide / verdict-narrow split (#xdompzx): where a reporting surface filters at all it
 * filters on THIS predicate (today: `renderPreventionSummary` in `we:scripts/lib/review-core.mjs`, and the drain's
 * auto-land emission test) — never on the narrower `blocksAcceptance`, which only the VERDICT reducers read.
 * `renderFindingLine` filters on neither: it prints whatever `prevention` a finding carries, which is wider still.
 * The rule to keep is the direction — no reporting surface may narrow by the BAR. The rationale for the split — and the
 * compensating control that makes it safe — is stated ONCE at `blocksAcceptance` below. Read it there.
 * @param {Finding|null|undefined} finding
 * @returns {boolean}
 */
export function hasUncapturedPrevention(finding) {
  return Boolean(finding && finding.prevention && finding.preventionCaptured !== true);
}

/**
 * #xdompzx — does this finding's uncaptured guard actually WITHHOLD the accept, at the given bar? Pure.
 *
 * THE SPLIT, STATED ONCE (this is its owning symbol; `hasUncapturedPrevention`, `renderPreventionSummary` and
 * `renderFindingLine` point back here rather than restating it):
 *   - NOTICE-WIDE — `hasUncapturedPrevention` is the pure "names a guard nobody has captured" predicate. It is the
 *     WIDEST filter any reporting surface is allowed to apply, so no uncaptured guard is filtered OUT of what a
 *     rendered review shows, whatever it would cost to ship — the bar narrows the verdict, never the report.
 *   - VERDICT-NARROW — this predicate adds "…and shipping it costs `PREVENTION_IMPACT_BAR` or more". Only the
 *     VERDICT reducers (`deriveVerdict`, `derivePanelVerdict`) read it.
 * So a reporting surface can legitimately name a guard the verdict did NOT stop for. That is the intended shape,
 * not a disagreement to "re-align" away — keeping the reporting half wide is exactly what makes the narrowed gate a
 * SCALING of the gate rather than a loss of information. Do not collapse the two back into one predicate. What is
 * still decided ONCE is each half: one definition of "owes a guard", one of "blocks".
 *
 * THE COMPENSATING CONTROL IS LOAD-BEARING, AND IT IS TWO-SIDED (review blocker 3). A relaxation that un-blocks a
 * finding is "no loss of information" only if the finding, its declared impact and its owed guard REACH a human on
 * the path the relaxation opens — the AUTO-LAND merge path, not just the escalation path. So:
 *   - INPUT: `buildSubjectMandate` demands `rootCause`/`prevention`/`preventionCaptured` on EVERY finding, at every
 *     impact, unconditionally. The bar is the CALLER's dial, never something a reviewer pre-applies by omitting a
 *     field — a demand conditioned on the bar starves this predicate of the very guards it exists to report.
 *   - OUTPUT: `renderFindingLine` (`review-render.mjs`) prints `impactIfUnfixed` and the owed `prevention` on every
 *     finding in the posted PR comment THAT CARRIES THEM — the fields are printed when present, never suppressed by
 *     the bar (an old-shape finding that declares neither simply has nothing to print), and the drain's auto-land
 *     branch (`skills-src/drain/SKILL.md`, step 3
 *     `land` → `autoLand: true`) MUST post that comment BEFORE it applies the accept labels whenever any finding
 *     satisfies `hasUncapturedPrevention(f) && !blocksAcceptance(f)` — i.e. whenever the bar is what un-blocked it.
 *     That emission is CONDITIONAL, deliberately: a clean accept with no bar-un-blocked guard posts nothing, so an
 *     ordinary land stays quiet. The guarantee is therefore narrower and exact — no land that the BAR un-blocked
 *     happens without the declared impact and the owed guard being posted first, where someone can dispute them.
 * Neither half works alone. Removing either turns this from a scaling of the gate into a silent loosening.
 *
 * FAIL-CLOSED on an undeclared impact. A finding with no valid `impactIfUnfixed` blocks exactly as it did before
 * #xdompzx, so this is a STRICT RELAXATION — it can only ever un-block a finding that explicitly declared itself
 * cheap. Every pre-#xdompzx caller and every old-shape finding is byte-stable, which is what makes the dial safe to
 * land: turning it cannot silently change the verdict on findings that never opted into the new field.
 *
 * @param {Finding|null|undefined} finding
 * @param {{bar?: string}} [o] - the dial; defaults to `PREVENTION_IMPACT_BAR`.
 * @returns {boolean}
 */
export function blocksAcceptance(finding, { bar = PREVENTION_IMPACT_BAR } = {}) {
  if (!hasUncapturedPrevention(finding)) return false;
  const declared = finding.impactIfUnfixed;
  if (declared === undefined) return true; // undeclared ⇒ fail closed, pre-#xdompzx behaviour
  return impactStrictness(declared) >= impactStrictness(bar);
}

/**
 * The negotiation round cap (#2311, v2 under epic #2285) — raised to 5 (operator call, 2026-07-13) from the
 * original spec of 3. Bounded so a non-converging editor↔reviewer cycle costs at most this many review passes
 * before it escalates to `review:human`, not an unbounded loop — but the operator's aim is fewer hand-offs to a
 * human, so the panel gets more room to converge on its own before a deadlock is declared. A tuning knob
 * (exported, not hardcoded per caller) — any caller that needs a DIFFERENT cap should say so explicitly, not
 * silently drift.
 */
export const NEGOTIATION_ROUND_CAP = 5;

/** The three negotiation-loop outcomes deriveNegotiationOutcome() can return (#2311). */
export const NEGOTIATION_OUTCOMES = Object.freeze({
  CONTINUE: 'continue',
  LAND: 'land',
  ESCALATE: 'escalate',
});

/**
 * Derive what the v2 negotiation loop (#2311) does next after a reviewer round. Pure — the ONE deterministic
 * round-cap decision every caller shares (mirrors `deriveVerdict`'s single-sourcing of the verdict itself):
 *
 *   - the round's verdict is `needs-human` → `escalate`, ALWAYS (a revision that itself touches the
 *     auto-review trust chain is the v1 conflict-of-interest case — no round budget saves it).
 *   - `prevention-outstanding` (#2823) → `escalate`, immediately. Every finding is already resolved, so another
 *     editor round has nothing to fix, and NO round-loop actor files a guard or flips `preventionCaptured` —
 *     `continue`-ing would only re-derive the identical verdict every round until the cap, then escalate anyway
 *     (burning the whole budget). So it hands STRAIGHT to the operator, who files the named guard(s); the loop
 *     cannot close this state itself. The guard list rides the escalation notice (`renderPreventionSummary`).
 *   - `accept` AND the required `test` check is green → `land` (the FULL bar holds: the final diff was
 *     accepted by a non-author reviewer AND CI is green).
 *   - `accept` but the required `test` is NOT green → NOT landable. The CI-green land clause (#2410 slice D,
 *     capstone of epic #2410) folds required-`test`-green into the land condition as a DETERMINISTIC clause of
 *     the unified bar — retiring the separate red-CI strand (`we:scripts/lane-resume.mjs`'s hand-rolled
 *     required-`test` FAIL list) so CI-green is ONE clause, not a parallel path. An `accept` over a red/pending
 *     required test is a reviewed-but-broken diff (the panel missed a defect CI caught); it re-enters the round
 *     loop like a `changes` — `continue` under the cap, `escalate` at it — and never silently lands.
 *   - `changes` and `round < roundCap` → `continue` (another editor↔reviewer round).
 *   - `changes` and `round >= roundCap` → `escalate` (non-convergence; surfaced to `review:human` same as v1's
 *     conflict-of-interest path, so the operator sees ONE escalation shape regardless of why it escalated).
 *
 * `requiredTestGreen` DEFAULTS to `true`, so every pre-#2410 caller (which passes no CI signal) is byte-stable:
 * an `accept` still lands. The clause only ever BLOCKS a land when a caller EXPLICITLY reports the required test
 * as not-green (`requiredTestGreen !== true` — so a red, pending, or unknown/`null` state all fail closed). The
 * caller owns mapping its CI state to this boolean (green ⇒ `true`; red OR pending/unknown ⇒ not green), keeping
 * this reducer subject-agnostic (it never parses a GitHub conclusion string itself).
 *
 * @verdicts-total fallthrough=changes — `changes` is the intentional final fall-through (the round-cap path); every
 *   OTHER `VERDICTS` member is handled explicitly. The `check:standards` verdict-totality gate enforces this, so a new
 *   member can never again silently ride the `changes` fall-through.
 * @param {{verdict: 'accept'|'changes'|'needs-human'|'prevention-outstanding', round: number, roundCap?: number, requiredTestGreen?: boolean}} o
 * @returns {'continue'|'land'|'escalate'}
 */
export function deriveNegotiationOutcome({ verdict, round, roundCap = NEGOTIATION_ROUND_CAP, requiredTestGreen = true }) {
  if (verdict === VERDICTS.NEEDS_HUMAN) return NEGOTIATION_OUTCOMES.ESCALATE;
  // #2823 — prevention-outstanding is NOT a negotiable `changes`: every finding is resolved, so no editor round
  // can close it and no loop actor files the guard. Escalate immediately to the operator (who files the guard),
  // rather than looping to re-derive the identical verdict until the cap. See the VERDICTS doc above.
  if (verdict === VERDICTS.PREVENTION_OUTSTANDING) return NEGOTIATION_OUTCOMES.ESCALATE;
  if (verdict === VERDICTS.ACCEPT && requiredTestGreen === true) return NEGOTIATION_OUTCOMES.LAND;
  return round < roundCap ? NEGOTIATION_OUTCOMES.CONTINUE : NEGOTIATION_OUTCOMES.ESCALATE;
}

/**
 * ============================================================================
 * THE MANDATORY POST-JURY RED-TEAM GATE (#2707).
 * ============================================================================
 *
 * A positive panel verdict is a PROPOSAL, not a ratification. Before the convergence loop LANDS an `accept`, an
 * adversarial RED-TEAM must actively try to BREAK it — and only a red-team that ran and could NOT break it
 * ratifies the accept. This closes the exact gap the feature-tracking-screen design session hit: a "foreman"
 * synthesizing a positive verdict over a jury that produced NO real signal, fabricating ratings out of nothing.
 * The rule is FAIL-CLOSED on missing signal, the same posture the rest of the engine already takes (a dead
 * mandatory lens degrades to needs-human): NO signal from the red-team is treated as a FAILING signal, never as a
 * silent accept.
 *
 * Two pure rules — the SINGLE SOURCE the subject-jury harness's red-team stage enacts (it reaches them the same
 * way the panel reduce reaches `deriveVerdict`/`deriveNegotiationOutcome`: mechanically, never re-deciding the
 * semantics per caller — #51 / F1):
 */

/**
 * Is a post-jury red-team OWED for this panel verdict? Pure. A red-team is required EXACTLY when the panel
 * verdict is `accept` — a positive verdict is the only one that could be RATIFIED, so it is the only one that
 * must first survive the adversary. A non-accept verdict is already bouncing (`changes`) or escalating
 * (`needs-human`); there is nothing to ratify, so no red-team runs (running one would only add cost, never change
 * the disposition). Mirrors `deriveNegotiationOutcome`'s "only accept lands" line — the red-team guards precisely
 * that land path.
 * @param {'accept'|'changes'|'needs-human'} verdict
 * @returns {boolean}
 */
export function redTeamRequired(verdict) {
  return verdict === VERDICTS.ACCEPT;
}

/**
 * Fold a red-team's result into the FINAL (post-red-team) verdict. Pure, FAIL-CLOSED. Delegates to `deriveVerdict`
 * with `humanRequired = !ran`, so the "no signal is a FAILING signal" invariant is the SAME one `deriveVerdict`
 * already single-sources — a red-team is not a second verdict machine:
 *   - the red-team did NOT run (`ran: false`) → `needs-human`, ALWAYS (an unrun red-team NEVER ratifies — this is
 *     the fabricated-ratings guard; `humanRequired` wins over any finding count, exactly as in `deriveVerdict`).
 *   - it ran and left OUTSTANDING findings → `changes` (the accept is broken; its findings feed the same round
 *     loop, so a red-team break is negotiated like any other `changes`, bounded by the round cap).
 *   - it ran CLEAN (no outstanding findings) → `accept` (RATIFIED — the positive verdict survived the adversary).
 * The harness only ever calls this for a verdict `redTeamRequired` returned true on; a non-accept verdict never
 * reaches the red-team.
 * @param {{ran?: boolean, findings?: Finding[]|Array<object>}} [o]
 * @returns {'accept'|'changes'|'needs-human'|'prevention-outstanding'}
 */
export function foldRedTeamVerdict({ ran = false, findings = [] } = {}) {
  return deriveVerdict({ findings, humanRequired: !ran });
}

/**
 * #2310 (v3, under epic #2285) — the MULTI-MANDATE REVIEWER PANEL. v2's single reviewer fans out into distinct
 * mandated lenses (the `/code-review` dimensions), each judging the SAME diff independently via `buildMandate`
 * (one subagent per lens, seeded with `buildPanelMandate`). The panel's combined verdict then drives the SAME
 * `deriveNegotiationOutcome` round loop v2 already established — v3 only adds the "many lens verdicts → one
 * panel verdict" reduction; the negotiate/land/escalate machinery is unchanged and single-sourced.
 *
 * Settled at spec (#2310): which lenses are MANDATORY (must unanimously accept to land) vs. ADVISORY
 * (surfaced, never blocking) is a judgment call about what already has a deterministic backstop (#51 — hookable
 * vs. judgment). `correctness` and `security` are genuine invariants with no other gate: a landed diff must not
 * be broken or exploitable, so they are MANDATORY. `standards-conformance` already has a deterministic backstop
 * (`npm run check:standards`, run as its own lane gate before every PR — #2199) — the panel's lens is a semantic
 * second opinion on top of that mechanical gate, not the only line of defense, so it is ADVISORY. `simplicity`
 * is a genuine stylistic judgment call (reasonable reviewers can disagree without the diff being unsafe to
 * land), so it is ADVISORY too. Advisory findings are ALWAYS surfaced (never silently dropped) but never block
 * the unanimous-accept land path on their own.
 */
export const MANDATE_LENSES = Object.freeze({
  CORRECTNESS: 'correctness',
  SECURITY: 'security',
  // #3035 — DOES THE WRITING MATCH WHAT IT POINTS AT. Added on measured evidence, not taste. Counted over the
  // replay corpus (`we:scripts/review-corpus/cases` — ON `main` since PR #1571, the sibling slice of this
  // same work, merged 2026-08-26; 92 cases across PRs #1456–#1567; re-counted 2026-08-26. RETRACTED: this
  // parenthetical used to read "NOT ON `main` YET: it lands with PR #1571" — true when written, stale once
  // #1571 merged):
  // 86 cases carry a `correctness` row and the juror ACCEPTED 79 of them, while the operator recorded `changes`
  // on 37 of the 92. The number that matters is the cross-tab, which needs no subtraction: in 27 cases the
  // correctness juror accepted and the operator bounced anyway — an operator raising something no lens was
  // looking for. Nearly all of it was one class — a citation, count, grep literal or claimed change that does
  // not hold against the thing it names. `correctness` does not cover it (the code is fine; the PROSE about the
  // code is wrong), and the deterministic-gate attempt at the class caught 5 of 39 confirmed labels (12.8%,
  // `node we:scripts/review-corpus/replay-gates.mjs`, runnable on `main` since #1571 merged) — of which only
  // 3 survived hand-inspection — which is the evidence it needs judgment rather than a lint.
  //
  // RETRACTED — this comment used to read *"across PRs #1428–#1567 the correctness juror accepted 80 of 86 lens
  // rows, yet 30 of 84 verdicts recorded `changes`, so roughly 24 bounces were an operator raising something no
  // lens was looking for … caught 3 of 13."* Four wrong numbers. `80` was already corrected to 79 in r3; the
  // other three stood: 37 not 30, 92 not 84 (there is no population of 84 anywhere in the corpus), and the gate
  // replay reports 5 of 39, not 3 of 13. The corpus also starts at #1456, not #1428. The ~24 was a subtraction
  // of two of those wrong numbers; the measured cross-tab is 27, and needs no subtraction.
  CLAIM_ACCURACY: 'claim-accuracy',
  SIMPLICITY: 'simplicity',
  STANDARDS: 'standards-conformance',
});

/** Lenses that must UNANIMOUSLY accept for the panel to land the PR (#2310). A tuning knob (exported, not
 *  hardcoded per caller) — see the module doc above for why correctness/security are the mandatory pair. */
export const MANDATORY_LENSES = Object.freeze([MANDATE_LENSES.CORRECTNESS, MANDATE_LENSES.SECURITY]);

export const LATER_ROUND_ADVISORY_SCOPES = Object.freeze({ CHANGED_ONLY: 'changed-only', ALL: 'all' });
export const LATER_ROUND_ADVISORY_SCOPE_ENV = 'WE_REVIEW_LATER_ROUND_ADVISORY_SCOPE';
export const LATER_ROUND_CHANGE_WINDOW = 3;
export const DEFERRED_ADVISORY_REASON = 'later-round-advisory-untouched';

export function laterRoundAdvisoryScopeFromEnv(env = process.env) {
  const value = env?.[LATER_ROUND_ADVISORY_SCOPE_ENV];
  if (value == null || value === '') return { scope: 'changed-only', fellBack: null };
  if (value === 'changed-only' || value === 'all') return { scope: value, fellBack: null };
  return { scope: 'all', fellBack: 'unknown-scope-value' };
}

const SOURCE_EXTENSIONS = new Set('js mjs cjs ts mts cts tsx jsx css scss html py sh rb go rs java kt swift c h cc cpp vue svelte'.split(' '));

export function isSourcePath(file) {
  if (typeof file !== 'string') return false;
  const name = file.split('/').at(-1);
  if (!name || name.startsWith('.')) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function classifyLaterRoundAdvisory(findings, options = {}) {
  const { lens, mandatoryLenses = MANDATORY_LENSES, scope, latestFix } = options ?? {};
  const list = Array.isArray(findings) ? findings : [];
  const keepAll = (fellBack = null) => ({ kept: list, deferred: [], scope: fellBack ? 'all' : scope, fellBack });
  if (latestFix == null || latestFix.priorHead === null) return keepAll();
  // `all` was asked for: nothing is scoped, so an unreadable range is not a fallback and must not be reported as one.
  if (scope !== 'changed-only') return keepAll();
  if (latestFix.error) return keepAll(`changed-range-unreadable: ${latestFix.error}`);
  const files = latestFix.files;
  if (typeof latestFix.priorHead !== 'string' || !latestFix.priorHead
    || typeof latestFix.head !== 'string' || !latestFix.head
    || !files || typeof files !== 'object' || Array.isArray(files)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(files))
    || Object.values(files).some(lines => lines !== null && (!Array.isArray(lines)
      || lines.some(n => !Number.isSafeInteger(n) || n < 0)))) {
    return keepAll('changed-range-unreadable: malformed-latest-fix');
  }
  if ((Array.isArray(mandatoryLenses) ? mandatoryLenses : MANDATORY_LENSES).includes(lens) || scope !== 'changed-only') return keepAll();
  const kept = [];
  const deferred = [];
  for (const finding of list) {
    const cited = typeof finding?.file === 'string' ? exactCitedPath(finding.file) : '';
    // Resolve through the SAME lenient matcher the admission step used (basename, absolute path, repo prefix), so a
    // touched file cited in an alias form is never mistaken for an untouched one and deferred.
    const path = cited && (Object.hasOwn(files, cited) ? cited : matchCitedPath(finding.file, Object.keys(files))) || cited;
    const line = Number.isInteger(finding?.line) && finding.line > 0 ? finding.line : null;
    const touched = Object.hasOwn(files, path);
    if (!path || (touched && (files[path] === null || !isSourcePath(path) || line === null
      || files[path].some(n => Math.abs(n - line) <= LATER_ROUND_CHANGE_WINDOW)))) {
      kept.push(finding);
    } else {
      deferred.push({ ...finding, deferred: DEFERRED_ADVISORY_REASON });
    }
  }
  return { kept, deferred, scope, fellBack: null };
}

/**
 * Juror text is untrusted (a PR author can plant it in the diff). Fold every line terminator JS's multiline `^`
 * recognises (and the other vertical-space characters) and drop backticks, so an interpolated value can never open
 * a new line — e.g. a forged `**Advisory outcome:**` that `parseAdvisories` would read ahead of the real one — or
 * break out of a code span. ONE helper for every renderer that interpolates juror text. PURE.
 */
export function foldUntrusted(text) {
  return String(text ?? '').replace(/[\r\n\u{2028}\u{2029}\u{85}\v\f]+/gu, ' ').replace(/`/g, "'");
}

const outcomeCitation = f => foldUntrusted(f?.file
  ? `${f.file}${Number.isInteger(f.line) && f.line > 0 ? `:${f.line}` : ''}`
  : String(f?.summary ?? '').slice(0, 60));

export function explainPanelOutcome({ outcome, lensVerdicts = {}, findings = [], mandatoryLenses = MANDATORY_LENSES,
  blockedReferrals, pendingReferrals, deferredCount = 0, scopeFellBack = null } = {}) {
  const cited = f => outcomeCitation(f) ? ` (finding \`${outcomeCitation(f)}\`)` : '';
  const prevention = (lens, f) => `Changes: ${lens}${mandatoryLenses.includes(lens) ? '' : ' advisory'} owes a prevention card${cited(f)}`;
  let reason;
  if (blockedReferrals?.length) {
    // #76a — NAME EVERY BLOCK. The fixer reads this line; a block it does not name is a block it skips (#4017
    // rounds 3-5). A bare key string (an older caller) still names its file from the key's own fields.
    const blockedFinding = (b) => typeof b === 'string' ? referralKeyFinding(b) : b?.finding;
    const citations = [...new Set(blockedReferrals.map((b) => outcomeCitation(blockedFinding(b))).filter(Boolean))];
    reason = blockedReferrals.length === 1
      ? `Changes: a mandatory referral was ruled block${citations.length ? ` (finding \`${citations[0]}\`)` : ''}`
      : `Changes: ${blockedReferrals.length} mandatory referrals were ruled block`
        + (citations.length ? ` (${citations.length === 1 ? 'finding' : 'findings'} ${citations.map((c) => `\`${c}\``).join(', ')})` : '');
  }
  else if (pendingReferrals?.length) reason = `Pending: ${pendingReferrals.length} mandatory referral(s) await a ruling`;
  else if (outcome === 'accept') reason = 'Accept: no blocking findings on this head';
  else if (outcome == null) reason = 'No outcome: the reviewed head is not pinned, so no advisory label is applied';
  else {
    const blockingLens = mandatoryLenses.find(lens => ['needs-human', 'changes'].includes(lensVerdicts[lens]));
    const owed = normalizeFindings(findings).find(f => !isFindingOutstanding(f) && blocksAcceptance(f));
    const owedLens = Object.keys(lensVerdicts).find(lens => lensVerdicts[lens] === 'prevention-outstanding');
    if (blockingLens) {
      const finding = findings.find(f => f && isFindingOutstanding(f)
        && (f.category === blockingLens || f.category?.startsWith(`${blockingLens}/`)));
      reason = `Changes: ${blockingLens} found a blocking defect${cited(finding)}`;
    } else if (owed) reason = prevention((owed.category ?? '').split('/')[0], owed);
    else if (owedLens) reason = prevention(owedLens);
    else reason = 'Changes: the panel did not accept this head';
  }
  if (deferredCount > 0) reason += ` · ${deferredCount} later-round advisory finding(s) moved to card suggestions`;
  if (scopeFellBack) reason += ` · advisory scope fell back to \`all\` (${foldUntrusted(scopeFellBack)})`;
  return reason.replace(/[\r\n\u{2028}\u{2029}\u{85}\v\f]+/gu, ' ');
}

/** Lenses that are ALWAYS surfaced but never block the unanimous-accept land path (#2310) — see the module doc
 *  above for why standards-conformance/simplicity are advisory. */
export const ADVISORY_LENSES = Object.freeze([
  MANDATE_LENSES.SIMPLICITY,
  MANDATE_LENSES.STANDARDS,
  // ADVISORY **ON MERIT, RULED** — #3314, operator, 2026-08-26, codified
  // `we:docs/agent/platform-decisions.md#claim-accuracy-advisory-blocks-on-impact`. It is NOT here because
  // #2310's criterion ("a genuine invariant with no other backstop") failed: the deterministic backstop for
  // this class was measured at 5 of 39 confirmed labels — 12.8%, of which 3 survived hand-inspection (`node
  // we:scripts/review-corpus/replay-gates.mjs`, RUNNABLE ON `main` since PR #1571 merged 2026-08-26;
  // re-run 2026-08-26 and it still prints `recall over all confirmed labels: 5/39 = 12.8%` over 92 cases.
  // RETRACTED: this line used to say "caught 3 of 13", a population the replay does not report) — so on
  // that criterion alone it would qualify. It is advisory for a STRUCTURAL reason: this lens judges the
  // writing ABOUT the repo, so its finding population is dominated by low-impact prose BY CONSTRUCTION, and
  // mandatory means unanimity — a wrong figure in a paragraph nobody depends on would stop a land. That is
  // review PERMISSION scaling with a signal — the same principle #2563 clause 1 applies to SCORED signals
  // (blast-radius, size, dismissed-findings, cross-repo, sampling), EXTENDED here to a lens's mandate, which
  // is not a scored signal (RETRACTED: this line used to say "(#2563 clause 1)" as a bare cite and the
  // statute said clause 1 "already forbids" it — it does not reach a lens's mandate; the argument stands on
  // its own). The argument does not improve if the lens does; do not re-open it on hit-rate evidence.
  //
  // WHAT BLOCKS INSTEAD IS `impactIfUnfixed`, NOT THE LENS: a claim-accuracy finding at
  // `PREVENTION_IMPACT_BAR` (`broken`) or above blocks; below it advises. A wrong acceptance criterion or a
  // wrong `file:line` a card directs work to is `broken`; a wrong figure no criterion depends on is
  // `cosmetic`. Deliberately the EXISTING typed field — a sometimes-blocking advisory lens is "mandatory
  // with extra steps" unless the sub-class is typed rather than reviewer discretion. (RETRACTED: this
  // paragraph used to name the field `impact`. There is no `impact` field on a finding — it is
  // `impactIfUnfixed`, the `@property` at the top of this file and the key `blocksAcceptance` reads.)
  //
  // NOT YET WIRED: `derivePanelVerdict` blocks on an advisory lens's findings only for RESOLVED ones owing an
  // uncaptured guard, so an OUTSTANDING above-bar finding still rides the accept — this lens therefore
  // behaves as plain advisory until `#x38ergj` adds that scan behind an explicit one-member
  // `BLOCKING_ADVISORY_LENSES`. That scan must test IMPACT ALONE (outstanding + `impactIfUnfixed` at or above
  // the bar, fail-closed on undeclared) — NOT `blocksAcceptance`, which short-circuits on
  // `hasUncapturedPrevention` and so would let an above-bar finding whose guard is already captured, or which
  // names none, ride the accept. Generalizing the bar to every advisory lens is a separate call (`#x2iwy8f`).
  // Nothing binds meanwhile regardless: `review-pr` runs ONE lens chosen by the caller, so the split only
  // starts binding when the panel (`we:scripts/lib/judge-panel.mjs`, #3050) is wired.
  MANDATE_LENSES.CLAIM_ACCURACY,
]);

/** Every panel lens, mandatory first — the full fan-out set a v3 panel round spawns one reviewer per. */
export const PANEL_LENSES = Object.freeze([...MANDATORY_LENSES, ...ADVISORY_LENSES]);

/**
 * How the panel's per-lens/per-juror verdicts are AGGREGATED (#2567 / #2563 Fork 2). The panel is aggregated by
 * diversity-SELECTION, **never** by naive majority vote: the most critical (strictest) verdict wins — one lens or
 * juror wanting `changes`/`needs-human` carries the whole panel there. Majority voting hits the "popularity trap"
 * — LLMs share failure modes, so a vote amplifies the shared-WRONG output that most models happen to agree on
 * (`we:reports/2026-07-18-human-vs-ai-review-cognitive-science.md`). `derivePanelVerdict` ALREADY implements this
 * (strictest-reason-wins, not a count), so this constant only NAMES the contract the care-level rigor dial scales
 * up; it does not introduce a second reducer. A single label so every consumer says "diversity-selection" the
 * same way and no caller quietly re-derives a majority vote.
 */
export const AGGREGATION = Object.freeze({ DIVERSITY_SELECTION: 'diversity-selection' });

/**
 * The panel RIGOR each advisory care-level dials (#2567, codified `#blast-radius-advisory-care-not-a-gate`). Pure,
 * total over `CARE_LEVELS`. Care-level scales HOW HARD the AI panel looks — `rounds` (editor↔reviewer negotiation
 * passes), `lenses` (which `PANEL_LENSES` fan out), and `jurorsPerLens` (independent reviewers per lens; >1 is the
 * diverse JURY that a high-care change earns) — never the ROUTE (a high-care change still gets an agent review, it
 * is not handed to a human) and never a cap on the WORK. Aggregation is ALWAYS diversity-selection, never a vote.
 *   • `none`     → no panel (the PR did not escalate; nothing to review).
 *   • `low`      → 1 round, full lens set, 1 juror per lens — the baseline panel a routine spot-check earns.
 *   • `elevated` → 2 rounds — a system-machinery / dismissed-finding change gets a second negotiation pass.
 *   • `high`     → 3 rounds + 2 jurors per lens — the maximum scrutiny (a gate-self/statute change, or several
 *                  stacked scored signals); the extra jurors are the diverse jury against shared blind spots.
 * `rounds` never exceeds `NEGOTIATION_ROUND_CAP` (the loop's own hard budget). Tuning knobs — loose to start,
 * tighten from data; kept here so a re-dial is one edit + a test.
 * @param {'none'|'low'|'elevated'|'high'} careLevel
 * @returns {{careLevel: string, rounds: number, lenses: string[], jurorsPerLens: number, aggregation: string}}
 */
export function panelRigorForCareLevel(careLevel) {
  const rigorByLevel = {
    [CARE_LEVELS.NONE]:     { rounds: 0, lenses: [],           jurorsPerLens: 0 },
    [CARE_LEVELS.LOW]:      { rounds: 1, lenses: PANEL_LENSES, jurorsPerLens: 1 },
    [CARE_LEVELS.ELEVATED]: { rounds: 2, lenses: PANEL_LENSES, jurorsPerLens: 1 },
    [CARE_LEVELS.HIGH]:     { rounds: 3, lenses: PANEL_LENSES, jurorsPerLens: 2 },
  };
  const r = rigorByLevel[careLevel];
  if (!r) {
    throw new Error(`panelRigorForCareLevel: unknown care-level "${careLevel}" — must be one of ${Object.values(CARE_LEVELS).join(', ')}`);
  }
  return {
    careLevel,
    rounds: Math.min(r.rounds, NEGOTIATION_ROUND_CAP),
    lenses: [...r.lenses],
    jurorsPerLens: r.jurorsPerLens,
    aggregation: AGGREGATION.DIVERSITY_SELECTION,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE EDITOR KNOB (#2908) — a SEPARATE dial from `panelRigorForCareLevel`, deliberately.
//
// `panelRigorForCareLevel` is SHARED: `/jury` (via `resolveRoster`), `/review` and `/converge` all read its
// `rounds`. The #2908 rider is explicit that the editor's round minimum must NOT be bought by raising that
// entry — doing so would double the negotiation budget of every consumer to pay for something only the
// parked-PR convergence loop needs. So the editor's enablement AND its round floor live here, on their own
// knob, and `panelRigorForCareLevel` above is left byte-stable.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The care bands at which the convergence loop's EDITOR may push a fix to the author's branch (#2908, codified
 * `#converge-editor-enabled-at-low-only`). **`low` ONLY.**
 *
 * Ratified 2026-08-08: mechanical fixes at the lowest observed risk get repaired and re-judged; anything
 * carrying a blast-radius or trust-chain signal gets a REPORT and the operator. `elevated` is excluded on
 * evidence, not on caution — it is the exact band where the loop's one observed editor failure happened (PR
 * #1018: the editor pushed a 15-file "fix" and the next round faulted that repair three ways, including a
 * fail-open in the very gate the fix had just written). Re-admitting `elevated` would re-enable the editor
 * precisely where it is known to misfire.
 *
 * An ALLOW-LIST, never a deny-list: a care band nobody has ruled on is review-only by construction.
 */
export const EDITOR_ENABLED_CARE_LEVELS = Object.freeze([CARE_LEVELS.LOW]);

/**
 * The minimum negotiation rounds an EDITOR-ENABLED band must carry (#2908 rider). Two is the floor that makes
 * the editor mean anything: one round to push the fix, one for a FRESH panel to judge the push. At one round
 * the loop forces `escalate` at the cap before the editor step is ever reached
 * (`we:scripts/workflows/review-parked-prs.mjs`), so an editor-enabled 1-round band is a contradiction — and a
 * push no panel re-read would break the loop's own invariant that a `land` means a non-author panel signed off
 * the FINAL diff.
 */
export const EDITOR_MIN_ROUNDS = 2;

/**
 * The EDITOR POLICY for a care band (#2908) — may the editor push, and what round budget does that buy?
 *
 * FAILS CLOSED, BY CONTRACT. Unlike `panelRigorForCareLevel` (which THROWS on an unknown band), this never
 * throws: it is consulted on a path where the band arrives from an agent echo or a possibly-degraded escalation
 * fetch, and a thrown error at a gate is a coin-flip on whatever the caller's `catch` does. An absent, null,
 * malformed or unrecognized care level therefore resolves to `{ resolved: false, editorEnabled: false }` —
 * review-only. Mutating someone else's branch is not reversible from their side, so "we could not work out how
 * risky this is" must mean "report it", never "edit it".
 *
 * `rounds` is the loop's round cap for the band: the shared panel dial's `rounds` for a review-only band
 * (unchanged), floored at `EDITOR_MIN_ROUNDS` for an editor-enabled one, and hard-capped at
 * `NEGOTIATION_ROUND_CAP`. Reading the SAME band the panel resolved — never re-deriving it — is the point: a
 * second derivation is a second thing to drift.
 *
 * @param {'none'|'low'|'elevated'|'high'|null|undefined} careLevel - the RESOLVED band, as the panel dialed it.
 * @returns {{careLevel: string|null, resolved: boolean, editorEnabled: boolean, rounds: number, reason: string}}
 */
export function editorPolicyForCareLevel(careLevel) {
  const known = typeof careLevel === 'string' && Object.values(CARE_LEVELS).includes(careLevel);
  if (!known) {
    // FAIL CLOSED — an unresolvable band is review-only, and carries the smallest budget (a budget's safe
    // default is its smallest value, same reasoning as `initConvergeState`'s round-cap clamp).
    return { careLevel: null, resolved: false, editorEnabled: false, rounds: 1, reason: 'unresolved-care-level' };
  }
  const editorEnabled = EDITOR_ENABLED_CARE_LEVELS.includes(careLevel);
  const panelRounds = panelRigorForCareLevel(careLevel).rounds;
  const rounds = editorEnabled
    ? Math.min(Math.max(panelRounds, EDITOR_MIN_ROUNDS), NEGOTIATION_ROUND_CAP)
    : panelRounds;
  return {
    careLevel,
    resolved: true,
    editorEnabled,
    rounds,
    reason: editorEnabled ? 'editor-enabled-band' : 'review-only-band',
  };
}

/**
 * Tag each lens's findings with their originating lens (so a merged findings list — the editor mandate, the
 * operator-facing summary — never loses provenance) and flatten into one list. Pure.
 * @param {Object<string, Array<object>>} lensFindings - `{ [lens]: rawFindings[] }`.
 * @returns {Finding[]}
 */
export function buildPanelFindings(lensFindings = {}) {
  return Object.entries(lensFindings).flatMap(([lens, findings]) =>
    normalizeFindings(findings).map((f) => ({ ...f, category: f.category ? `${lens}/${f.category}` : lens })),
  );
}

/**
 * Reduce the panel's per-lens verdicts to ONE combined verdict the existing `deriveNegotiationOutcome` round
 * loop consumes unchanged (#2310). Pure — mirrors `deriveVerdict`'s single-sourcing:
 *
 *   - `humanRequired` (the #2285 v1 conflict-of-interest flag) → `needs-human`, ALWAYS, same as `deriveVerdict`.
 *   - `conflict` → `needs-human`. Whether the mandatory lenses' findings are a genuine MUTUALLY-EXCLUSIVE
 *     tradeoff (not just "both want changes") is a semantic read of the findings text — judgment, not a thing
 *     this pure function can detect from verdict labels alone (#51: the derivation stays mechanical, the
 *     judgment stays with the caller/subagents reading the actual findings) — so the caller passes it in
 *     explicitly, the same pattern `deriveVerdict`'s `humanRequired` already establishes.
 *   - a MANDATORY lens wants `changes` → `changes` (feeds the SAME round-cap loop v2 uses).
 *   - #2823 — the panel owes a PREVENTION guard when its FINDINGS name one that is neither captured nor filed.
 *     DESIGN CALL (round-2 finding 4, STRUCTURAL): prevention is derived from the panel's `findings`, NOT from the
 *     per-lens verdicts. A single verdict per lens cannot carry both "still has a defect" AND "owes a guard": an
 *     advisory lens holding one unresolved finding PLUS a resolved one naming an uncaptured guard reduces (via its
 *     own `deriveVerdict`) to `changes` — advisory `changes` rides the accept, so the guard leaked unfiled. Scanning
 *     the FINDINGS instead is immune to that one-verdict-per-lens flattening: a resolved finding with an uncaptured
 *     guard is seen regardless of what its lens's single verdict flattened to. Checked AFTER needs-human/changes (a
 *     real mandatory defect still outranks a missing guard — the fix comes first). The per-lens `prevention-outstanding`
 *     scan is KEPT as a belt-and-suspenders fallback for callers that pass a verdict but no findings (a mandatory
 *     lens whose whole verdict IS prevention-outstanding still surfaces). Either path → `prevention-outstanding`.
 *   - #xu2pp2m — `degradedBasis` → `needs-human` FOR EVERY NON-BLOCKING OUTCOME. Checked AFTER needs-human and
 *     changes (a real blocking finding is still the more actionable answer, and a bounce costs nothing), and
 *     BEFORE `prevention-outstanding`/`accept` — the two the UNATTENDED loop CLEARS mechanically
 *     (`we:scripts/lib/review-loop-policy.mjs` auto-answers `accept` for both on the agent-addressed
 *     `review:pending` tier). The input means "the material this panel judged could not be resolved"; a panel
 *     that found nothing wrong with material it could not see has told us nothing, and reducing that to
 *     `accept` is exactly what let PR #2122 merge on a review of a ZERO-BYTE diff (2026-09-12).
 *     MEASURED ON THAT SAME RUN, and it is why this keys on the INPUT rather than on the ANSWERS: the
 *     tool-free Codex seat reported honestly that "the missing net diff prevents a substantive review of the
 *     changes" — an ABSTENTION — and because an abstention carries no findings, `deriveVerdict` turned it into
 *     an accept vote. That is the tool-free-panel risk #3158 reasoned about, now measured. Recognising
 *     abstention PROSE is not something a pure reducer can do; recognising that the material was unreadable is
 *     deterministic, so the guard lives on that fact instead.
 *   - every MANDATORY lens verdict is `accept` AND nothing owes a guard → `accept` (the "unanimous accept lands"
 *     spec line — an advisory lens's ordinary outstanding findings are surfaced, never blocking).
 *
 * `findings` is REQUIRED (#2823 round-3 finding 1), not defaulted: the drain's live path built `buildPanelFindings`
 * then dropped it, so the findings-derived prevention scan saw an empty list and the advisory-prevention leak was
 * silently reinstated on the ONE path that matters. A required parameter makes an omitting caller fail LOUDLY
 * instead — pass the whole panel's list, or an explicit `[]` to assert there are none (never let it default).
 *
 * @verdicts-total — every `VERDICTS` member is handled explicitly (needs-human, changes, prevention-outstanding,
 *   accept); the `check:standards` verdict-totality gate enforces it, so a new enum member can't be dropped here.
 * @param {{lensVerdicts: Object<string, 'accept'|'changes'|'needs-human'|'prevention-outstanding'>, humanRequired?: boolean,
 *   conflict?: boolean, degradedBasis?: boolean, mandatoryLenses?: string[], findings: Array<object>}} o -
 *   `findings` (REQUIRED) is the WHOLE panel's list (`buildPanelFindings(lensFindings)`); the prevention scan
 *   reads it, immune to per-lens verdict flattening. `degradedBasis` (#xu2pp2m) defaults to `false`, so every
 *   pre-existing caller is byte-stable.
 * @returns {'accept'|'changes'|'needs-human'|'prevention-outstanding'}
 */
export function derivePanelVerdict({ lensVerdicts = {}, humanRequired = false, conflict = false, degradedBasis = false, mandatoryLenses = MANDATORY_LENSES, findings, bar = PREVENTION_IMPACT_BAR } = {}) {
  if (findings === undefined) {
    throw new Error('derivePanelVerdict: `findings` is required — pass buildPanelFindings(lensFindings) (or an explicit [] to assert none). A defaulted [] silently reinstates the #2823 advisory-prevention leak on the drain path.');
  }
  if (humanRequired || conflict) return VERDICTS.NEEDS_HUMAN;
  if (!mandatoryLenses.length) {
    // Guard the `Array.prototype.every` vacuous-truth trap: an empty mandatory set must never silently read as
    // "everyone accepted" — a caller that misconfigures `mandatoryLenses` to `[]` gets a loud error, not a
    // free `accept` with zero verdicts actually checked.
    throw new Error('derivePanelVerdict: mandatoryLenses must be non-empty — an empty set would vacuously "accept"');
  }
  const mandatoryVerdicts = mandatoryLenses.map((lens) => lensVerdicts[lens]);
  const missing = mandatoryLenses.filter((lens) => !lensVerdicts[lens]);
  if (missing.length) {
    throw new Error(`derivePanelVerdict: missing verdict for mandatory lens(es): ${missing.join(', ')}`);
  }
  if (mandatoryVerdicts.some((v) => v === VERDICTS.NEEDS_HUMAN)) return VERDICTS.NEEDS_HUMAN;
  if (mandatoryVerdicts.some((v) => v === VERDICTS.CHANGES)) return VERDICTS.CHANGES;
  // #xu2pp2m — THE MATERIAL ITSELF WAS UNREADABLE. Nothing blocking was found, but nothing blocking COULD have
  // been found, so the only honest non-blocking answer left is "a human has to look". Positioned here and not
  // beside `humanRequired` above on purpose: a mandatory lens that DID find a blocker still gets to say so (a
  // bounce is more actionable than a park, and it costs nothing), while both of the outcomes that mechanically
  // CLEAR a PR are taken off the table. See this function's own docblock for the PR #2122 measurement.
  if (degradedBasis) return VERDICTS.NEEDS_HUMAN;
  // #2823 round-2 finding 4 — derive "the panel owes a guard" from the FINDINGS, not the per-lens verdicts (the
  // structural fix). A RESOLVED finding whose named prevention is neither captured nor filed owes a guard, whatever
  // its lens's single verdict flattened to (an advisory lens with a co-resident unresolved finding would flatten to
  // `changes` and hide it). Only resolved findings count — an unresolved one is `changes` territory (fix first).
  // #xdompzx — same impact gate as `deriveVerdict`: a resolved finding whose guard is uncaptured blocks only if
  // shipping it would cost `bar` or more. Below-bar guards stay in the notice, out of the verdict.
  const preventionFromFindings = normalizeFindings(findings)
    .some((f) => !isFindingOutstanding(f) && blocksAcceptance(f, { bar }));
  // Belt-and-suspenders: a caller that passes a mandatory/advisory lens verdict of `prevention-outstanding` but no
  // findings still surfaces it (byte-stable for the pre-round-2 verdict-only callers).
  const preventionFromLens = Object.values(lensVerdicts).some((v) => v === VERDICTS.PREVENTION_OUTSTANDING);
  if (preventionFromFindings || preventionFromLens) return VERDICTS.PREVENTION_OUTSTANDING;
  if (mandatoryVerdicts.every((v) => v === VERDICTS.ACCEPT)) return VERDICTS.ACCEPT;
  return VERDICTS.CHANGES;
}

/**
 * ============================================================================
 * THE JURY-LEDGER EVENT VOCABULARY (#2654, S2 of epic #2649) — SCHEMA ONLY.
 * ============================================================================
 *
 * The jury is made observable (#2641, F4 = logbook ruling) by writing an APPEND-ONLY event log to disk; a single
 * shared fold replays that log into the live ledger the conveyor's `/workflows`-style tree and the #2642 console
 * both render. This slice defines ONLY the durable event SHAPE those two consumers serialize + a pure validator —
 * it does NOT build the on-disk log or the fold (both are #2641). Keeping the vocabulary here, next to the verdict
 * / round / panel contracts it references (a `finding` event carries a `Finding`; a `verdict` event carries a
 * `VERDICTS` value), single-sources "what a jury event is" so the writer and every reader agree by construction.
 *
 * The F4 logbook events plus the mandatory-referral protocol (#4315):
 *   • `roster-picked`   — the jury roster was chosen: the jurors (id / lens / charter, optional method).
 *   • `juror-running`   — a rostered juror started its pass (its lifecycle moved pending → running).
 *   • `finding`         — a juror reported one finding (the canonical `Finding` shape).
 *   • `verdict`         — a juror reported its current verdict (a `VERDICTS` value).
 *   • `round-advanced`  — the editor↔reviewer negotiation loop advanced to a new round.
 *   • `mandatory-referrals` — versioned finding-specific referrals, attempt and ruling history (#4315).
 *
 * Every event carries `type` and an integer `round` (the round it belongs to; `round-advanced` names the NEW,
 * ≥1 round). `at` (an ISO-8601 timestamp) is OPTIONAL in the schema — the durable-log writer (#2641) stamps it;
 * the validator only checks it parses when present, so the pure schema never depends on a clock. The validator is
 * NORMALIZING: it returns a clean event built from KNOWN fields only, so no caller-junk is persisted to the log.
 */

/** The append-only jury-ledger event types (#2654, #4315). A frozen enum so every writer/reader names them once. */
export const JURY_EVENT_TYPES = Object.freeze({
  ROSTER_PICKED: 'roster-picked',
  JUROR_RUNNING: 'juror-running',
  FINDING: 'finding',
  VERDICT: 'verdict',
  ROUND_ADVANCED: 'round-advanced',
  MANDATORY_REFERRALS: 'mandatory-referrals',
});

/** Every jury-ledger event type, in lifecycle order — the membership set `validateJuryEvent` dispatches on. */
export const JURY_EVENT_TYPE_LIST = Object.freeze(Object.values(JURY_EVENT_TYPES));

/**
 * The juror lifecycle statuses the #2641 fold DERIVES from the event stream (#2641 lists "pending / running /
 * found"). These are ledger-STATE the fold reconstructs, NOT events themselves: a juror is `pending` once
 * `roster-picked` names it, `running` after its `juror-running` event, and `found` once it has emitted a
 * `finding` or `verdict`. Named here so the fold and the console label the derived status the same way.
 */
export const JUROR_STATUSES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  FOUND: 'found',
});

const VERDICT_VALUES = new Set(Object.values(VERDICTS));

/**
 * @typedef {Object} JurorSpec
 * @property {string} id - stable juror id, unique within the roster (the key later events reference via `jurorId`).
 * @property {string} lens - the review lens/dimension this juror judges under (e.g. a `MANDATE_LENSES` value, or a
 *   domain adapter's own lens — not constrained to the PR-diff set, since the jury is subject-agnostic).
 * @property {string} charter - the juror's charter / expectation (what it was asked to look for).
 * @property {string} [method] - optional method/model label (how this juror reviews).
 */

/**
 * @typedef {Object} JuryEvent
 * @property {'roster-picked'|'juror-running'|'finding'|'verdict'|'round-advanced'} type
 * @property {number} round - the negotiation round the event belongs to (0-based; `round-advanced` is ≥1).
 * @property {string} [at] - ISO-8601 timestamp; stamped by the #2641 log writer, absent in the pure schema.
 * @property {JurorSpec[]} [jurors] - `roster-picked` only: the chosen roster.
 * @property {string} [jurorId] - `juror-running`/`finding`/`verdict`: which rostered juror this is about.
 * @property {Finding} [finding] - `finding` only: the reported finding (canonical `Finding` shape).
 * @property {'accept'|'changes'|'needs-human'} [verdict] - `verdict` only: the juror's current verdict.
 */

/**
 * @typedef {Object} JuryEventValidation
 * @property {boolean} valid - true when `raw` is a well-formed jury event.
 * @property {string[]} errors - one message per schema violation (empty when valid).
 * @property {JuryEvent|null} event - the NORMALIZED event (known fields only) when valid, else null.
 */

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function requireRound(raw, event, errors, min) {
  if (!Number.isInteger(raw.round) || raw.round < min) {
    errors.push(`${raw.type} requires an integer round >= ${min}`);
  } else {
    event.round = raw.round;
  }
}

function requireJurorId(raw, event, errors) {
  if (!isNonEmptyString(raw.jurorId)) {
    errors.push(`${raw.type} requires a non-empty jurorId`);
  } else {
    event.jurorId = raw.jurorId.trim();
  }
}

/** Normalize one roster juror spec; pushes an error (and returns null) for each malformed field. */
function normalizeJurorSpec(raw, index, errors, seen) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`jurors[${index}] must be an object`);
    return null;
  }
  const spec = {};
  let ok = true;
  if (!isNonEmptyString(raw.id)) {
    errors.push(`jurors[${index}].id must be a non-empty string`);
    ok = false;
  } else {
    spec.id = raw.id.trim();
    if (seen.has(spec.id)) {
      errors.push(`jurors[${index}].id "${spec.id}" is duplicated in the roster`);
      ok = false;
    }
    seen.add(spec.id);
  }
  if (!isNonEmptyString(raw.lens)) {
    errors.push(`jurors[${index}].lens must be a non-empty string`);
    ok = false;
  } else {
    spec.lens = raw.lens.trim();
  }
  if (!isNonEmptyString(raw.charter)) {
    errors.push(`jurors[${index}].charter must be a non-empty string`);
    ok = false;
  } else {
    spec.charter = raw.charter.trim();
  }
  if (raw.method != null) {
    if (!isNonEmptyString(raw.method)) errors.push(`jurors[${index}].method must be a non-empty string when present`);
    else spec.method = raw.method.trim();
  }
  return ok ? spec : null;
}

/**
 * Validate + normalize one append-only jury-ledger event (#2654). Pure — never throws (a malformed record must
 * not crash the log writer or the fold). Returns a structured result: `{ valid, errors, event }`. When valid,
 * `event` is a CLEAN copy carrying only the fields the schema knows (so caller-junk is never persisted); when
 * invalid, `event` is null and `errors` lists every violation. The one validator BOTH #2641's writer (reject
 * before append) and the #2642 console (reject on read) share, so a bad event is caught the same way everywhere.
 *
 * @param {*} raw
 * @returns {JuryEventValidation}
 */
export function validateJuryEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['event must be a non-null object'], event: null };
  }
  const { type } = raw;
  if (!JURY_EVENT_TYPE_LIST.includes(type)) {
    return {
      valid: false,
      // String(), not JSON.stringify(): the latter THROWS on a bigint type, breaking the never-throw contract.
      errors: [`unknown event type "${String(type)}" — must be one of ${JURY_EVENT_TYPE_LIST.join(', ')}`],
      event: null,
    };
  }

  const errors = [];
  /** @type {JuryEvent} */
  const event = { type };

  // Common envelope: `at` is optional; validate it parses as a date only when present (keeps the schema clock-free).
  if (raw.at != null) {
    if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) {
      errors.push('at must be a parseable date string when present');
    } else {
      event.at = raw.at;
    }
  }

  switch (type) {
    case JURY_EVENT_TYPES.ROSTER_PICKED: {
      requireRound(raw, event, errors, 0);
      if (!Array.isArray(raw.jurors) || raw.jurors.length === 0) {
        errors.push('roster-picked requires a non-empty jurors array');
      } else {
        const seen = new Set();
        event.jurors = raw.jurors.map((j, i) => normalizeJurorSpec(j, i, errors, seen)).filter(Boolean);
      }
      // #2864 — the REVIEWED head sha: which tree these jurors were actually seated over. The ledger carried no
      // commit identity at all, so a clean fold written at head A read as `clear` at head B — enforced, that
      // clears a diff no juror saw. `reviewed-sha` (#2409) cannot catch it either: that marker is stamped at
      // WRITE time, so it certifies the unreviewed tree. OPTIONAL in the schema on purpose — every event already
      // on disk predates this field, and rejecting them would erase the log rather than age it. The freshness
      // GATE is a separate decision at the consumer (the #2864 decider slice); this slice only makes the fact
      // recordable, so a ledger written from here on can be checked at all.
      // CASE-INSENSITIVE, normalized to lowercase on the way in — the shape every other sha check in this repo
      // accepts (`sameCommit` in fetch-parked.mjs, `readiness/lane-manifest.mjs`, `merge-ai-prs.mjs`) and the shape
      // the #2409 `reviewed-sha` marker this field pairs with writes (`review-escalation.mjs` lowercases too). A
      // case-SENSITIVE test would make an uppercase sha throw out of `rosterPickedEvent`, i.e. an optional
      // decorative field taking down the mandatory roster event it rides on. (PR #1034 review, finding 3. The one
      // shared `isCommitSha`/`normalizeCommitSha` primitive is filed separately as #2913; until it lands, this
      // matches the repo's existing shape rather than inventing a stricter one.)
      if (raw.reviewedSha != null) {
        const sha = typeof raw.reviewedSha === 'string' ? raw.reviewedSha.toLowerCase() : '';
        if (!/^[0-9a-f]{7,64}$/.test(sha)) {
          errors.push('reviewedSha must be a hex commit sha (7-64 chars) when present');
        } else {
          event.reviewedSha = sha;
        }
      }
      break;
    }
    case JURY_EVENT_TYPES.MANDATORY_REFERRALS: {
      requireRound(raw, event, errors, 0);
      if (!validateReferralRecord(raw.record)) errors.push('invalid mandatory referral record');
      else event.record = JSON.parse(JSON.stringify(raw.record));
      break;
    }
    case JURY_EVENT_TYPES.JUROR_RUNNING: {
      requireRound(raw, event, errors, 0);
      requireJurorId(raw, event, errors);
      break;
    }
    case JURY_EVENT_TYPES.FINDING: {
      requireRound(raw, event, errors, 0);
      requireJurorId(raw, event, errors);
      const finding = normalizeFinding(raw.finding);
      if (!finding) errors.push('finding event requires a finding with a non-empty summary');
      else event.finding = finding;
      break;
    }
    case JURY_EVENT_TYPES.VERDICT: {
      requireRound(raw, event, errors, 0);
      requireJurorId(raw, event, errors);
      if (!VERDICT_VALUES.has(raw.verdict)) {
        errors.push(`verdict event requires a verdict of ${[...VERDICT_VALUES].join(', ')}`);
      } else {
        event.verdict = raw.verdict;
      }
      break;
    }
    case JURY_EVENT_TYPES.ROUND_ADVANCED: {
      // The NEW round the loop advanced to — ≥1 (advancing to round 0 is meaningless; round 0 is the initial roster).
      requireRound(raw, event, errors, 1);
      break;
    }
    // No default: JURY_EVENT_TYPE_LIST membership was already checked above.
  }

  return errors.length ? { valid: false, errors, event: null } : { valid: true, errors: [], event };
}

/**
 * Normalize one raw jury event to its clean `JuryEvent` shape, or `null` if it fails the schema. Pure. The
 * `.filter(Boolean)`-friendly form the #2641 fold maps a raw log over (mirrors `normalizeFinding`). Callers that
 * need the WHY of a rejection use `validateJuryEvent` for the `errors` list; this thin wrapper drops it.
 * @param {*} raw
 * @returns {JuryEvent|null}
 */
export function normalizeJuryEvent(raw) {
  return validateJuryEvent(raw).event;
}

/**
 * ============================================================================
 * THE STATELESS ROSTER-RECOMPUTE SPINE + MINIMAL LEDGER-TRAILED OVERRIDE (#2655, F3 of epic #2649).
 * ============================================================================
 *
 * The ratified F3 shape (jury-of-#2576, decision record 273a2dbd): the jury ROSTER is a STATELESS recompute from
 * `care-level + a touch-set signal` — deterministic and re-derivable, never persisted — and any deviation from
 * that recompute is a MINIMAL override layer ON TOP, trailed as an append-only ledger event (the #2654 S2 schema)
 * so the effective roster is always reconstructable as `recompute(care, touch) THEN overrides`. Keeping the base
 * a pure recompute is the whole point: nothing to migrate, nothing to drift — re-run it and you get the same
 * roster, and the persisted state is only the small override delta.
 *
 * This is the SUBJECT-AGNOSTIC spine the PR-diff resolver (`resolveJuryPlan` in review-core.mjs) and the future
 * per-domain adapters (#2656) build ON. It generalizes the PR-path-pattern touch-set (`classifyTouchSet`, which
 * reads UI file globs — a review-DIFF concern that STAYS in review-core) to an abstract `touchLenses` SIGNAL the
 * SUBJECT supplies: the spine merges the care band's static lenses with the subject's extra touch-set lenses,
 * de-duplicates (the care band wins any overlap), attaches each lens's grounding method(s) through a
 * caller-INJECTED resolver (so the UI method registry stays subject-specific), and carries provenance
 * (`attachedBy`) — knowing nothing about what is being judged. The care→RIGOR half (jurors-per-lens, rounds) is
 * reused from `panelRigorForCareLevel`, never re-derived; aggregation stays `DIVERSITY_SELECTION`.
 */

/**
 * @typedef {Object} RosterSeat
 * @property {string} lens - the review lens/perspective this seat judges under.
 * @property {string[]} methods - the grounding method id(s) for this lens (empty when no resolver was injected).
 * @property {'care'|'touch-set'|'override'} attachedBy - provenance: the care band's static set, the subject's
 *   touch-set signal, or a minimal override applied on top of the recompute.
 */

/**
 * @typedef {Object} RosterPlan
 * @property {string} careLevel - the `CARE_LEVELS` value the plan was recomputed for.
 * @property {number} jurorsPerLens - independent jurors per lens (the care band's rigor dial).
 * @property {number} rounds - editor↔reviewer negotiation rounds (the care band's rigor dial).
 * @property {string} aggregation - always `DIVERSITY_SELECTION`.
 * @property {RosterSeat[]} lenses - the resolved seats, static (care) lenses first, then touch-set lenses.
 */

/**
 * THE STATELESS ROSTER-RECOMPUTE SPINE (#2655) — `roster = f(care-level, touch-set)`. Pure, deterministic,
 * re-derivable: the same inputs always produce the same plan, so nothing about it is persisted. Subject-agnostic —
 * the SUBJECT supplies its extra lenses as the abstract `touchLenses` signal (the PR-diff subject derives that
 * signal from a file touch-set via `classifyTouchSet`; another subject derives it however it likes). The spine:
 *   • gets the care band's STATIC lens set + rigor dial from `panelRigorForCareLevel(careLevel)` — reused, never
 *     re-derived (throws on an unknown care-level, which is where that throw is single-sourced).
 *   • when the care band is `none` (no panel — nothing escalated) returns an EMPTY roster regardless of the
 *     touch-set: the touch-set only ADDS perspective lenses to an existing panel, it never conjures one.
 *   • otherwise merges the static lenses (first, in their care-band order) with the subject's `touchLenses`
 *     (after), de-duplicating so the care band wins any overlap, and attaches each lens's grounding method(s)
 *     via the injected `resolveMethods(lens)` (default: none — a subject-agnostic plan carries no methods until a
 *     caller grounds it). Each seat records `attachedBy` provenance.
 * @param {{careLevel: string, touchLenses?: string[], resolveMethods?: (lens: string) => string[]}} [o]
 * @returns {RosterPlan}
 */
export function resolveRoster({ careLevel, touchLenses = [], resolveMethods } = {}) {
  const rigor = panelRigorForCareLevel(careLevel); // throws on an unknown care-level; supplies base lenses + dial
  const methodsFor = typeof resolveMethods === 'function' ? resolveMethods : () => [];
  const attach = (lens, attachedBy) => {
    const m = methodsFor(lens);
    return { lens, methods: Array.isArray(m) ? [...m] : [], attachedBy };
  };
  const dial = { careLevel, jurorsPerLens: rigor.jurorsPerLens, rounds: rigor.rounds, aggregation: rigor.aggregation };
  if (!rigor.lenses.length) return { ...dial, lenses: [] };
  const seen = new Set();
  const entries = [];
  for (const lens of rigor.lenses) {                        // static care-band lenses first, in PANEL_LENSES order
    if (seen.has(lens)) continue;
    seen.add(lens);
    entries.push(attach(lens, 'care'));
  }
  for (const raw of (Array.isArray(touchLenses) ? touchLenses : [])) { // the subject's touch-set lenses, after
    if (!isNonEmptyString(raw)) continue;                   // reject falsy/whitespace lenses (same bar as the override path)
    const lens = raw.trim();
    if (seen.has(lens)) continue;                           // the care band wins any overlap
    seen.add(lens);
    entries.push(attach(lens, 'touch-set'));
  }
  return { ...dial, lenses: entries };
}

/** The two MINIMAL override operations on a recomputed roster (#2655, F3). Add or remove ONE lens — the smallest
 *  override surface that still lets an operator deviate from the stateless recompute. A frozen enum so every
 *  caller names them once. The overrides themselves are the ONLY persisted state (kept minimal by construction);
 *  the recompute is re-derivable, so the durable trail is `recompute(care, touch)` + this small delta. */
export const ROSTER_OVERRIDE_OPS = Object.freeze({ ADD: 'add', REMOVE: 'remove' });

/**
 * Apply a MINIMAL override list to a recomputed roster plan (#2655, F3) — the ledger-trailed override layer that
 * sits ON TOP of the stateless recompute. Pure — returns a NEW plan, never mutates its input (the recompute stays
 * canonical). Each override is `{ op: 'add'|'remove', lens }`:
 *   • `add`    — append `lens` (grounded via the injected `resolveMethods`, `attachedBy: 'override'`) if the plan
 *                does not already carry it; adding an already-present lens is a no-op (idempotent).
 *   • `remove` — drop the seat for `lens` if present; removing an absent lens is a no-op (idempotent).
 * A malformed override (not an object, empty `lens`, or an unknown `op`) throws loudly — an override is operator
 * config, and a silent mis-apply here is exactly the drift the stateless spine exists to avoid. The applied
 * effective roster is what `rosterPickedEvent` then records to the ledger, so the override is trailed there.
 * @param {RosterPlan} plan - a `resolveRoster` output.
 * @param {Array<{op: string, lens: string}>} [overrides]
 * @param {{resolveMethods?: (lens: string) => string[]}} [o]
 * @returns {RosterPlan}
 */
export function applyRosterOverrides(plan, overrides = [], { resolveMethods } = {}) {
  const methodsFor = typeof resolveMethods === 'function' ? resolveMethods : () => [];
  const entries = (Array.isArray(plan?.lenses) ? plan.lenses : []).map((e) => ({ ...e }));
  const indexOfLens = (lens) => entries.findIndex((e) => e.lens === lens);
  for (const ov of (Array.isArray(overrides) ? overrides : [])) {
    if (!ov || typeof ov !== 'object' || Array.isArray(ov)) {
      throw new Error('applyRosterOverrides: each override must be an object { op, lens }');
    }
    const { op, lens } = ov;
    if (!isNonEmptyString(lens)) {
      throw new Error(`applyRosterOverrides: override.lens must be a non-empty string (op "${String(op)}")`);
    }
    const cleanLens = lens.trim();
    if (op === ROSTER_OVERRIDE_OPS.ADD) {
      if (indexOfLens(cleanLens) === -1) {
        const m = methodsFor(cleanLens);
        entries.push({ lens: cleanLens, methods: Array.isArray(m) ? [...m] : [], attachedBy: 'override' });
      }
    } else if (op === ROSTER_OVERRIDE_OPS.REMOVE) {
      const i = indexOfLens(cleanLens);
      if (i !== -1) entries.splice(i, 1);
    } else {
      throw new Error(`applyRosterOverrides: unknown override op "${String(op)}" — must be one of ${Object.values(ROSTER_OVERRIDE_OPS).join(', ')}`);
    }
  }
  return { ...plan, lenses: entries };
}

/**
 * Materialize a roster plan into the concrete `JurorSpec[]` a `roster-picked` ledger event carries (#2655) —
 * expand each lens seat into `plan.jurorsPerLens` independent jurors (the diverse jury a high-care band earns).
 * Pure. Each juror gets a stable `id` (`lens#slot`, unique within the roster because the plan's lenses are
 * de-duplicated), the seat's `lens`, a `charter`, and — when the seat is grounded — the seat's first grounding
 * method as its `method`. The `charter` is subject-specific text, so it comes from the injected
 * `charterForLens(lens)` (an adapter supplies real charters); the default is a neutral placeholder so the spine
 * itself hardcodes no subject knowledge. A plan with `jurorsPerLens: 0` (care `none`) materializes to an empty
 * roster.
 * @param {RosterPlan} plan
 * @param {{charterForLens?: (lens: string) => string}} [o]
 * @returns {JurorSpec[]}
 */
export function materializeRoster(plan, { charterForLens } = {}) {
  const entries = Array.isArray(plan?.lenses) ? plan.lenses : [];
  const perLens = Number.isInteger(plan?.jurorsPerLens) && plan.jurorsPerLens > 0 ? plan.jurorsPerLens : 0;
  const charterOf = typeof charterForLens === 'function' ? charterForLens : (lens) => `judge the subject under the "${lens}" lens`;
  const jurors = [];
  for (const entry of entries) {
    const method = Array.isArray(entry.methods) && entry.methods.length ? entry.methods[0] : undefined;
    const charter = String(charterOf(entry.lens) || `judge the "${entry.lens}" lens`);
    for (let slot = 1; slot <= perLens; slot += 1) {
      const juror = { id: `${entry.lens}#${slot}`, lens: entry.lens, charter };
      if (method) juror.method = method;
      jurors.push(juror);
    }
  }
  return jurors;
}

/**
 * Build the `roster-picked` ledger event (the #2654 S2 schema) that RECORDS an effective roster plan (#2655) —
 * the append-only trail the F3 override layer leaves. Pure. Materializes the plan (`materializeRoster`) and wraps
 * the jurors in a schema-VALID `roster-picked` event, so what lands in the ledger is exactly the effective
 * (post-override) roster and nothing else. Returns `null` when the plan has no jurors (care `none`) — there is no
 * roster to record. The optional `at` (stamped by the #2641 log writer) and `charterForLens` pass straight
 * through. Throws only if the materialized roster somehow fails the S2 schema (a defensive self-check — the
 * materializer builds a valid roster by construction).
 * @param {RosterPlan} plan
 * @param {{round?: number, at?: string, charterForLens?: (lens: string) => string}} [o]
 * @returns {JuryEvent|null}
 */
export function rosterPickedEvent(plan, { round = 0, at, charterForLens, reviewedSha } = {}) {
  const jurors = materializeRoster(plan, { charterForLens });
  if (!jurors.length) return null; // care `none` / no seats → no roster picked, nothing to record
  const raw = { type: JURY_EVENT_TYPES.ROSTER_PICKED, round, jurors };
  if (at != null) raw.at = at;
  // #2864 — record WHICH TREE these jurors are being seated over, so a later reader can tell whether the verdict
  // it is folding still describes the PR's current head. Optional: a caller with no sha to hand (a design or
  // decision subject, where there is no commit) simply omits it and the ledger is unchanged.
  if (reviewedSha != null) raw.reviewedSha = reviewedSha;
  const { valid, errors, event } = validateJuryEvent(raw);
  if (!valid) {
    throw new Error(`rosterPickedEvent: materialized roster failed the S2 schema: ${errors.join('; ')}`);
  }
  return event;
}

/**
 * ============================================================================
 * THE SUBJECT-ADAPTER CONTRACT + THE SUBJECT-NEUTRAL MANDATE FRAMING (#2656, F2 heart of epic #2649).
 * ============================================================================
 *
 * The ratified F2 shape (jury-of-#2576, decision record 273a2dbd): the jury METHOD lives ONCE here in the
 * subject-agnostic core, and each SUBJECT (PR-diff review, design-pixel review, decision-prose review) plugs in
 * through a THIN per-domain ADAPTER. This section defines the SEAM that plug snaps into — the four interface
 * pieces every adapter supplies, plus the two core primitives that consume an adapter without knowing what is
 * being judged:
 *
 *   1. THE LENS-SET — the lenses this subject judges under. The static care-band set is subject-neutral
 *      (`PANEL_LENSES`, reused by `resolveRoster` via `panelRigorForCareLevel`); the adapter declares its extra
 *      perspective lenses (through `extractTouchSet`) and, optionally, which lenses are mandatory.
 *   2. THE GROUNDING / VALIDATION METHOD — `resolveMethods(lens, ctx)`: the tool id(s) that ground each lens in
 *      evidence (a diff-reading reviewer, an axe scan, a screenshot-diff …). The registry that maps a lens to a
 *      method stays subject-specific — the core only asks the adapter for the answer.
 *   3. THE TOUCH-SET EXTRACTOR — `extractTouchSet(input)`: the subject's raw input → the extra perspective lenses
 *      it earns. The PR-diff subject derives this from a changed-file glob; another subject derives it however it
 *      likes. The core feeds the result to `resolveRoster` as the abstract `touchLenses` signal.
 *   4. THE SUBJECT-NEUTRAL MANDATE FRAMING — `buildSubjectMandate(...)` (below): the shared "you are reviewing a
 *      <subject> against <mandate>; judge only, report concrete findings, empty list if nothing" skeleton every
 *      adapter frames its subject into. Knowing nothing about diffs, pixels, or prose, it assembles the mandate
 *      line + the neutral judge-only closing; the adapter supplies the subject noun, its isolation line, and any
 *      subject-specific body lines (for PR-diff: the #2336 no-checkout constraint).
 *
 * The reference adapter that PROVES this contract is `PR_DIFF_ADAPTER` in review-core.mjs — it re-homes the
 * existing PR-diff behaviour (the touch-set classifier, the method registry, the PR mandate framing, the
 * correctness/security mandatory lenses) behind this seam, and `resolveJuryPlan` now routes through
 * `resolveAdapterRoster` byte-for-byte. Future subjects (design-pixels, decision-prose = S5) add ONLY an adapter.
 */

/**
 * @typedef {Object} SubjectAdapter
 * @property {string} subject - stable subject id ('pr-diff' | 'design-pixels' | 'decision-prose'). REQUIRED.
 * @property {(input: *) => string[]} extractTouchSet - the subject's raw input → the extra perspective lenses it
 *   earns (the abstract `touchLenses` signal `resolveRoster` merges onto the care band). REQUIRED.
 * @property {(lens: string, ctx?: *) => string[]} resolveMethods - the grounding/validation method id(s) for a
 *   lens; the optional `ctx` carries whatever the subject needs (the PR-diff adapter reads the care band from it).
 *   REQUIRED.
 * @property {string} [subjectNoun] - the noun the mandate frames the work as ('diff', 'rendered design', …).
 * @property {string[]} [mandatoryLenses] - the lenses that must unanimously accept to land (defaults, per subject,
 *   to the core `MANDATORY_LENSES`).
 * @property {(lens: string) => string} [charterForLens] - the juror charter text for a lens (passed to
 *   `materializeRoster`); defaults to a neutral placeholder there when absent.
 * @property {(o: *) => string} [buildMandate] - the subject's mandate builder (built on `buildSubjectMandate`).
 */

/** The subject-adapter contract descriptor (#2656) — the REQUIRED and OPTIONAL interface keys, single-sourced so
 *  `validateSubjectAdapter` and adapter authors name them once. Frozen.
 *  @test-only-export-ok: this is a PUBLISHED interface descriptor — its consumers are adapter authors (in this
 *  repo the docblocks of design-pixels-adapter.mjs / decision-prose-adapter.mjs cite it, and out of it a sibling
 *  repo's adapter would) plus the jury-core conformance assertions that pin the key sets. validateSubjectAdapter
 *  deliberately keeps its own literals, so "no live importer" is the shape of a contract, not dead code (#2967a). */
export const SUBJECT_ADAPTER_CONTRACT = Object.freeze({
  required: Object.freeze(['subject', 'extractTouchSet', 'resolveMethods']),
  optional: Object.freeze(['subjectNoun', 'mandatoryLenses', 'charterForLens', 'buildMandate']),
});

/**
 * Validate that a value implements the `SubjectAdapter` contract (#2656). Pure — never throws (a malformed
 * adapter must surface as a structured result, not crash the caller). Returns `{ valid, errors }`: the three
 * REQUIRED members must be present and the right type; each OPTIONAL member, when present, must be well-typed.
 * The seam `resolveAdapterRoster` gate-checks every adapter through this before building a roster, and a
 * per-domain adapter's conformance test asserts it here — so a new subject that half-implements the contract
 * fails loudly at its own boundary, not deep inside the recompute.
 * @param {*} adapter
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateSubjectAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    return { valid: false, errors: ['adapter must be a non-null object'] };
  }
  const errors = [];
  if (!isNonEmptyString(adapter.subject)) errors.push('adapter.subject must be a non-empty string');
  if (typeof adapter.extractTouchSet !== 'function') errors.push('adapter.extractTouchSet must be a function (input) => string[]');
  if (typeof adapter.resolveMethods !== 'function') errors.push('adapter.resolveMethods must be a function (lens, ctx?) => string[]');
  if (adapter.subjectNoun != null && !isNonEmptyString(adapter.subjectNoun)) errors.push('adapter.subjectNoun, when present, must be a non-empty string');
  if (adapter.mandatoryLenses != null && !(Array.isArray(adapter.mandatoryLenses) && adapter.mandatoryLenses.length)) {
    errors.push('adapter.mandatoryLenses, when present, must be a non-empty array');
  }
  if (adapter.charterForLens != null && typeof adapter.charterForLens !== 'function') errors.push('adapter.charterForLens, when present, must be a function');
  if (adapter.buildMandate != null && typeof adapter.buildMandate !== 'function') errors.push('adapter.buildMandate, when present, must be a function');
  return { valid: errors.length === 0, errors };
}

/**
 * THE SUBJECT-NEUTRAL MANDATE SKELETON (#2656) — the shared framing every adapter builds its subject's mandate
 * on. Pure. Assembles the parts that are the SAME across subjects — the "you are reviewing a <subject> against
 * this mandate: <mandate>" opening line, and the neutral judge-only closing ("report concrete findings … nothing
 * about labels/merge policy … empty list if nothing survives") — while the adapter supplies the parts that VARY:
 * its `subjectNoun`, the `isolationLine` (what context the reviewer sees), the `findingAnchor` (what a finding is
 * anchored to — a `file` for a diff, a region for pixels), and any subject-specific `bodyLines` (the PR-diff
 * adapter's #2336 no-checkout constraint). The reference PR-diff `buildMandate` (review-core.mjs) calls this with
 * the diff-specific values, reproducing its prior text byte-for-byte — that is what "re-home the mandate framing,
 * factoring shared logic into the core rather than duplicating" means.
 *
 * #2950 — THE GOAL AND THE THREE DIRECTION TESTS. Two additive, opt-in parameters close the "open-ended mandate"
 * hole that made this the most expensive brief a model can be handed:
 *   • `goal` — what the change is TRYING to do. Without it a juror judges against an implicit ideal, which is what
 *     generates findings that are true, unhelpful and expensive. Omitting it leaves the text byte-stable.
 *   • `round` — at round 2+ the ANTI-SPIRAL clause fires: the juror may judge only the fix that the previous
 *     round's findings asked for. Anything else it notices is a carve-out BY CONSTRUCTION, not an argument. This is
 *     what makes the loop terminate on agreement rather than on the round cap: without it every round re-reads the
 *     whole subject and mints brand-new blockers, so convergence is structurally unreachable.
 * Both default to the pre-#2950 behaviour (no goal block; round 1 = no anti-spiral clause).
 *
 * #2967 — `fenced` routes the GOAL through the #2438 labelled data fence (`fenceUntrusted` + `FENCED_DATA_RULE`).
 * The goal is caller-supplied text: the drain's PR-review path passes the PR TITLE, which comes straight off
 * `gh pr view` and is written by whoever opened the PR. Unfenced, it lands in the juror's instruction text. That
 * is the whole established fact — whether a crafted title could actually move a juror's verdict is UNMEASURED,
 * and this parameter is hygiene, not a patched exploit. Opt-in (default `false`) so shipped callers' mandate text
 * is byte-stable; the caller that feeds it untrusted text passes `true` (`we:scripts/operations/review-pr.mjs`).
 *
 * @param {{subjectNoun?: string, mandate?: string|string[], defaultMandate?: string, isolationLine?: string,
 *   findingAnchor?: string, bodyLines?: string[], goal?: string, round?: number, fenced?: boolean}} [o]
 * @returns {string}
 */
export function buildSubjectMandate({
  subjectNoun = 'subject',
  mandate,
  defaultMandate = 'correctness',
  isolationLine = '',
  findingAnchor = 'file',
  bodyLines = [],
  goal = '',
  round = 1,
  fenced = false,
} = {}) {
  const mandates = (Array.isArray(mandate) ? mandate : [mandate]).filter(Boolean);
  const mandateLine = mandates.length ? mandates.join(', ') : defaultMandate;
  const body = Array.isArray(bodyLines) ? bodyLines.filter((l) => typeof l === 'string' && l.length) : [];
  const roundNo = Number.isFinite(Number(round)) ? Math.floor(Number(round)) : 1;
  return [
    `You are reviewing a ${subjectNoun} against this mandate: ${mandateLine}.`,
    ...(isNonEmptyString(isolationLine) ? [isolationLine] : []),
    ...body,
    // #2950 — WHAT THE CHANGE IS FOR. The scope test downstream ("does this finding trace to the goal?") is
    // unanswerable without it, so the goal is stated before anything is asked of the juror.
    ...(isNonEmptyString(goal)
      ? [
        // #2967 — fenced, the goal travels as labelled DATA (and the rule sentence that says so comes with it);
        // unfenced, the text is exactly what it was before #2967 for every caller that has not opted in.
        ...(fenced ? [FENCED_DATA_RULE] : []),
        fenced
          ? `WHAT THIS ${String(subjectNoun).toUpperCase()} IS TRYING TO DO, quoted in the goal block below:\n${fenceUntrusted('goal', String(goal).trim())}`
          : `WHAT THIS ${String(subjectNoun).toUpperCase()} IS TRYING TO DO: ${String(goal).trim()}`,
        'Judge it against THAT goal and against the base it started from — never against an ideal implementation you',
        'would have written. A change can be imperfect and still be the right thing to accept.',
      ]
      : []),
    `Judge only: report concrete findings (${findingAnchor}, one-sentence summary, the failure scenario it causes) and`,
    'nothing about labels, merge policy, or who may clear this change — that is the caller\'s decision, not yours.',
    'Report an empty findings list if nothing survives scrutiny; do not pad with stylistic nitpicks.',
    // #2950 — DISPOSITION, the round key. Single-sourced here for the same reason as the prevention block below:
    // every surface that frames a mandate through this skeleton must ask the three direction tests, or the whole
    // "only a blocker earns a round" reduction is starved of the field it reduces on and silently fails closed
    // (every finding blocking, i.e. exactly today's cost).
    'DISPOSITION (required, for EVERY finding) — answer THREE booleans and let the routing decide; do NOT decide',
    'yourself whether this blocks. (a) `introduced`: did THIS change introduce the problem, or was it already there',
    'on material the change did not touch? (b) `worseThanBase`: are we NET WORSE than the base — not "less than',
    'ideal", actually worse than what was there before? (c) `parallelizable`: could this be fixed independently, in',
    'a parallel lane, without holding this change?',
    `Exactly one combination earns a round (\`${DISPOSITIONS.BLOCKER}\`): introduced AND worse-than-base AND NOT`,
    `parallelizable. Everything else routes to \`${DISPOSITIONS.CARVE_OUT}\` — real, reported, filed, but not this`,
    'change\'s problem to fix here.',
    'Answer (b) honestly: judging against an ideal instead of against the base is the single most expensive mistake',
    'a reviewer makes here. Better-but-imperfect is a carve-out, not a blocker.',
    'THE THREE ANSWERS ARE THE ONLY WAY TO UN-BLOCK A FINDING. Omitting any of them leaves it BLOCKING, and writing',
    `a \`disposition\` word yourself does NOT substitute for them: a bare \`${DISPOSITIONS.CARVE_OUT}\` or`,
    `\`${DISPOSITIONS.NIT}\` with no answers is DISCARDED and the finding blocks. The one word that is honoured on`,
    `its own is \`${DISPOSITIONS.BLOCKER}\` — you may always declare something blocking. So silence costs a round`,
    `rather than saving one. \`${DISPOSITIONS.NIT}\` is a finer label you may add ALONGSIDE three answers that`,
    'already route to a carve-out, for something worth saying and never worth a round.',
    'SCOPE IS THE GOAL, NOT THE FILE COUNT: a fix that serves the stated goal is in scope however many files it',
    'takes; a fix that introduces a NEW goal is a carve-out.',
    // #2950 — THE ANTI-SPIRAL GUARD. Round 2+ exists to check the round-1 fix, nothing else. Without this the panel
    // re-reads the whole subject each round and mints new blockers, so the loop can only ever end at the round cap.
    ...(roundNo >= 2
      ? [
        `ROUND ${roundNo} — YOU ARE CHECKING A FIX, NOT RE-REVIEWING THE SUBJECT. Judge ONLY whether the findings`,
        'from the previous round were actually addressed. Anything else you notice — however real — is a `carve-out`',
        'by construction: report it with that disposition and do NOT open another round for it. A finding you raise',
        'now that does not trace to a previous-round finding may never be a `blocker`.',
      ]
      : []),
    // #2823 — MANDATORY PREVENTION INTROSPECTION, single-sourced here so EVERY review surface that frames a
    // mandate through this skeleton (the diff reviewer, the panel lenses, any future subject) inherits it — it
    // cannot be skipped. Tuned per finding-class: a citation miscite earns a deterministic gate; a design-fidelity
    // miss earns a render assertion; etc.
    // #xdompzx — IMPACT FIRST. Ranking by consequence-if-shipped is what stops a review reading as a flat list of
    // objections. The level DEFINITIONS are rendered from `IMPACT_GLOSS`, never re-typed here: a pasted copy drifted
    // from the JSDoc inside the commit that introduced it (#xdompzx review, finding 6).
    `IMPACT (required, for EVERY finding): answer \`impactIfUnfixed\` — what it COSTS to ship this, using exactly`,
    `one of: ${Object.values(IMPACT_LEVELS).map((l) => `\`${l}\` = ${IMPACT_GLOSS[l]}`).join('; ')}.`,
    'Judge the CONSEQUENCE, not how bad the code looks: a defect can be ugly and cosmetic, or a two-line omission',
    'and unrecoverable. State the likelihood in your failure scenario — a rare path with a catastrophic end and a',
    'certain path with a trivial end are different findings, and the reader needs both halves to rank them. If you',
    'genuinely cannot tell, omit the field: it is then treated as blocking.',
    // #2823 — MANDATORY, UNCONDITIONAL. The demand is NOT scaled to the impact bar (#xdompzx review, blocker 3A):
    // a demand a reviewer can opt out of by declaring a finding cheap starves both the operator notice and the
    // posted PR comment of the very guards they exist to surface, on exactly the path the bar newly un-blocks.
    'PREVENTION INTROSPECTION (required, for EVERY finding you report — at every severity, nits included):',
    'alongside the finding you MUST also answer three fields — (a) ROOT CAUSE (`rootCause`): a blameless "why"',
    'chain for why the CREATOR got this wrong (the authoring failure mode), not merely what is wrong;',
    '(b) PREVENTION (`prevention`): the cheapest DURABLE guard that would have caught this whole CLASS of defect,',
    'tuned to the finding\'s class — preferring a DETERMINISTIC GATE (a `check:standards` rule / write-gate / lint)',
    'over a review lens over a doc note; and (c) CAPTURE (`preventionCaptured`): whether that guard is already',
    'CAPTURED as an existing gate (true) or must be FILED as a future backlog item (false).',
    'A script-decidable defect for which you propose no gate is an INCOMPLETE review, not a clean one.',
    // The claim below must match what the drain's auto-land branch actually emits (round-2 blocker 1B): the posted
    // review is guaranteed only when the bar is what un-blocked a guard, so the wording says exactly that.
    'WHAT THE GUARD GATES: reporting is unconditional, BLOCKING is not. A finding at',
    `\`${PREVENTION_IMPACT_BAR}\` impact or above whose prevention is neither captured nor filed BLOCKS acceptance.`,
    'A below-bar guard is still reported here and still owed a filing — it simply does not stop the land, and when',
    'the bar is what un-blocked it the reviewing agent must post your findings on the PR before it lands. Answer all',
    'three fields either way: the bar is the caller\'s dial, not yours to pre-apply by leaving a field out.',
  ].join(' ');
}

/**
 * THE ADAPTER-DRIVEN ROSTER SEAM (#2656) — resolve a jury roster for ANY subject through its adapter. Pure. This
 * is the one place a subject's adapter meets the subject-agnostic spine: it validates the adapter, asks it for the
 * touch-set signal (`extractTouchSet(input)`) and a method resolver bound to the caller's `ctx`, runs the
 * stateless `resolveRoster` recompute, and applies any minimal ledger-trailed overrides on top — all without
 * knowing what `input` is. `resolveJuryPlan` (review-core.mjs, the PR-diff resolver) delegates to this with
 * `PR_DIFF_ADAPTER`, so the shipped PR-diff path IS the reference proof that the contract holds; a future subject
 * reuses this verbatim with its own adapter.
 * @param {{adapter: SubjectAdapter, careLevel: string, input?: *, overrides?: Array<{op: string, lens: string}>,
 *   ctx?: *}} o
 * @returns {RosterPlan}
 */
export function resolveAdapterRoster({ adapter, careLevel, input, overrides = [], ctx } = {}) {
  const { valid, errors } = validateSubjectAdapter(adapter);
  if (!valid) throw new Error(`resolveAdapterRoster: invalid subject adapter: ${errors.join('; ')}`);
  const resolveMethods = (lens) => adapter.resolveMethods(lens, ctx);
  const plan = resolveRoster({ careLevel, touchLenses: adapter.extractTouchSet(input), resolveMethods });
  const ovs = Array.isArray(overrides) ? overrides : [];
  return ovs.length ? applyRosterOverrides(plan, ovs, { resolveMethods }) : plan;
}

/**
 * THE LOOP OUTCOME (#3072) — where the editor↔reviewer loop stands after this round, as distinct from what
 * this round's verdict was. A verdict judges one review; an outcome says whether the loop should continue.
 *
 * WHY THEY MUST BE DISTINGUISHABLE. A loop that reports success on exhaustion is worse than one that never
 * terminates, because the second is at least visible. `converged` and `exhausted` both end the loop and mean
 * opposite things.
 *
 * THREE OUTCOMES, NOT FOUR — and the missing one is the interesting part. A `stuck` detector was designed and
 * then REFUSED on evidence: the obvious rule (finding count stops shrinking) was tested against the only real
 * multi-round case in the repo, PR #1164, whose four rounds ran 3 → 1 → 1 → 1 findings. A count rule flags
 * that as stuck at round three, and every one of those rounds found a NEW, real bypass that was then fixed.
 * The detector would have killed the most productive review of the week.
 *
 * Telling *thrashing* from *converging slowly* needs finding IDENTITY — is this the SAME finding recurring? —
 * and the ledger records only counts. That is a genuine input to the observability spike (#3077), not
 * something to approximate here. Approximating it would have been worse than the gap.
 *
 * @verdicts-partial `changes` and `prevention-outstanding` deliberately share one branch: both mean another
 *   pass is owed, and the loop treats them identically. Naming them separately would imply a distinction this
 *   function does not make. `accept` and `needs-human` are the two that genuinely differ, so those are the two
 *   it references — and the fall-through covers the rest, so it is total in BEHAVIOUR while partial in
 *   reference. A new verdict added to the enum lands in the fall-through as "another pass owed", which is the
 *   safe default for a loop.
 * @param {{verdict: string, round: number, cap: number}} o
 * @returns {{outcome: 'converged'|'in-progress'|'exhausted'|'escalated', round: number, cap: number, why: string}}
 */
export function deriveLoopOutcome({ verdict, round = 1, cap = DEFAULT_ROUND_CAP } = {}) {
  const r = Math.max(1, Math.floor(Number(round) || 1));
  // A NON-POSITIVE cap takes the DEFAULT, not 1. `Math.max(1, …)` turned a negative into instant exhaustion —
  // the direction the test comment already called wrong, caught by review. `0` and `NaN` already fell back via
  // `||`; a negative slipped past it.
  const capN = Math.floor(Number(cap));
  const c = Number.isFinite(capN) && capN > 0 ? capN : DEFAULT_ROUND_CAP;
  if (verdict === VERDICTS.NEEDS_HUMAN) {
    return { outcome: 'escalated', round: r, cap: c, why: 'a human gate applies — the loop does not decide this' };
  }
  if (verdict === VERDICTS.ACCEPT) {
    return { outcome: 'converged', round: r, cap: c, why: `accepted at round ${r}` };
  }
  // `changes` and `prevention-outstanding` both mean another pass is owed.
  if (r >= c) {
    return {
      outcome: 'exhausted',
      round: r,
      cap: c,
      why: `round ${r} of ${c} still returned \`${verdict}\` — the cap is reached, so this ends UNRESOLVED and a human owes it a look`,
    };
  }
  return { outcome: 'in-progress', round: r, cap: c, why: `round ${r} of ${c} returned \`${verdict}\`` };
}

/**
 * How many editor↔reviewer rounds before the loop stops and asks a person. Five, because the longest genuinely
 * productive run observed in this repo (PR #1164) was four — a cap at or below that would have truncated real
 * work, and the point of the cap is to catch a loop that is not progressing, not to ration one that is.
 */
export const DEFAULT_ROUND_CAP = 5;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// #3887 — RULE 7 OF #3690 AT `spot-check`: the independent pass keeps full COVERAGE at every supervision
// level and moves only in DEPTH (`#delegation-trial-record-graduation`, rule 7). `full` keeps the existing
// mandatory panel (`MANDATORY_LENSES`/`PANEL_LENSES` above) unchanged — #3850 already ratified that panel AS
// the full-depth independent pass, and nothing here touches it. `spot-check` owns the
// `#every-pr-gets-a-look-advisory-floor` shape instead (#3313): ONE tool-free juror, ONE round, the diff and
// the item card, a CAPPED finding count, and — the structural half of "advisory, never a park" — STRUCTURALLY
// NON-BLOCKING: this module records the floor's verdict and cost; it never emits a `review:*` label and is
// never a `REVIEW_HOLD_LABELS` member (`we:scripts/lib/review-escalation.mjs`) — a review that cannot park
// cannot cost latency (#3313's own words).
//
// TWO OBLIGATIONS COME WITH THE FLOOR, AND NEITHER IS OPTIONAL (#3313): a finding files a follow-up item
// (`we:scripts/operations/review-dispatch.mjs#runFloorPass`, which drives the declared `file-item` operation),
// and the floor's own cost and yield are measured and reported — `recordFloorRun` below is that record, kept
// in a shape a report can fold later, the same way `panelRigorForCareLevel` above already carries the
// mandate's OTHER standing dial (rounds/lenses/jurors) as a pure, auditable table rather than an inline
// decision.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The floor's own finding cap (#3313 — "a capped finding count"). A small number by design: the floor's bar
 *  is "catch the obvious", not "converge" — see the anchor's own text in `we:docs/agent/platform-decisions.md`.
 *  Extra findings are never silently dropped: {@link recordFloorRun} reports how many it truncated. */
export const FLOOR_MAX_FINDINGS = 3;

/**
 * RECORD one floor-depth (`spot-check`) independent-pass run — its verdict AND its cost, in one field a
 * report can read later (Done-when #3, #3887). Pure: no fs, no clock, no process — every number arrives as
 * data, read at whichever io edge actually ran the pass (mirrors this module's own pure contract).
 *
 * DELIBERATELY NOT A `VERDICTS` MEMBER. `VERDICTS` (`accept`/`changes`/`needs-human`/`prevention-outstanding`)
 * is the BLOCKING panel's vocabulary — a floor run is structurally non-blocking (#3313) and must never be
 * mistaken for a value `derivePanelVerdict`/`deriveLoopOutcome` would act on. `outcome` here is its own,
 * narrower, two-value vocabulary instead.
 *
 * @param {object} [o]
 * @param {Array<Finding|string>} [o.findings] - the floor juror's raw findings; capped at
 *   {@link FLOOR_MAX_FINDINGS} — any beyond that are counted in `truncatedCount`, never silently dropped.
 * @param {number} [o.jurorCount] - the floor's own juror count (#3313: "one tool-free juror" — default 1).
 * @param {number} [o.rounds] - the floor's own round count (#3313: "one round" — default 1).
 * @param {number|null} [o.tokens] - measured token cost of the pass, when the caller has it.
 * @param {number|null} [o.wallTimeMs] - measured wall-clock cost of the pass, when the caller has it.
 * @returns {{runKind:'floor', outcome:('clean'|'findings'), findings:ReadonlyArray, truncatedCount:number, cost:{jurorCount:number, rounds:number, tokens:(number|null), wallTimeMs:(number|null)}}}
 */
export function recordFloorRun({ findings = [], jurorCount = 1, rounds = 1, tokens = null, wallTimeMs = null } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const kept = Object.freeze(
    list.slice(0, FLOOR_MAX_FINDINGS).map((f) => (typeof f === 'string' ? f : Object.freeze({ ...f }))),
  );
  return Object.freeze({
    runKind: 'floor',
    outcome: kept.length ? 'findings' : 'clean',
    findings: kept,
    truncatedCount: Math.max(0, list.length - kept.length),
    cost: Object.freeze({ jurorCount, rounds, tokens, wallTimeMs }),
  });
}


/** #4315: a verification request, independent of disposition, outcome or prevention. */
export function requiresMandatoryReferral(raw) {
  const f = normalizeFinding(raw);
  return f?.verdict === 'CONFIRMED' && ['broken', 'unrecoverable'].includes(f.impactIfUnfixed);
}

/** Stable source identity; the outer record supplies repository, PR, head and run. */
export function referralFindingKey(seat, raw) {
  const f = normalizeFinding(raw);
  if (!f) throw new TypeError('referral requires a normalized finding');
  return JSON.stringify([seat, f.file ?? '', f.line ?? '', f.summary.trim().replace(/\s+/g, ' ')]);
}

/** The `{ file, line, summary }` a {@link referralFindingKey} encodes, or null for a non-key. PURE. */
export function referralKeyFinding(key) {
  try {
    const [, file, line, summary] = JSON.parse(key);
    if (typeof summary !== 'string' || !summary.trim()) return null;
    return { summary, ...(file ? { file: String(file) } : {}), ...(Number.isInteger(line) && line > 0 ? { line } : {}) };
  } catch { return null; }
}

/** The actual independent follow-up seat, never a reviewer role asserted by finding prose. */
export function mandatoryReferralReviewer(runId) {
  return { id: deriveSessionId(sessionSeed([runId, 'mandatory-referral-correctness'])), lens: 'correctness' };
}

const supersededRulings = (ruling) => ruling.supersedes == null ? []
  : Array.isArray(ruling.supersedes) ? ruling.supersedes : [ruling.supersedes];

// Only these optional sources may be retired by operator configuration. Unknown and mandatory seats hold.
export const REFERRAL_SEAT_PROVIDERS = Object.freeze({
  judgeAntigravityReview: 'agy-gemini', 'agy-gemini': 'agy-gemini', 'agy-claude': 'agy-claude',
});
export const ADVISORY_REFERRAL_SEATS = Object.freeze(['judgeAdvisory', 'judgeCorrectnessAdvisory', 'judgeAntigravityReview']);
export const REFERRAL_SUPERSEDE_REASON = 'superseded: the mandatory owner already ruled this finding not-real on this head';
export const REFERRAL_CARRY_REASON = 'carried: the operator ruled this finding on an earlier head; its cited lines are unchanged';
export const REFERRAL_DROP_REASON = 'dropped: seat disabled by operator config';
// A drop only retires a finding nobody has ruled on: a finding with a ruling (a `block` above all) keeps counting.
export const activeReferrals = (record) => record.referrals.filter(f => !(record.dropped ?? []).some(d => d.key === f.key)
  || record.rulings.some(r => r.key === f.key));

export const liveReferrals = (record) => activeReferrals(record).filter(f => ![...(record.superseded ?? []), ...(record.carried ?? [])].some(s => s.key === f.key)
  || record.rulings.some(r => r.key === f.key));

/** Same-head owner decisions may retire advisory duplicates; never infer clearance from prose alone. */
export function findSupersedingNotReal(referral, { records = [], operatorRulings = [], head, repo, pr }) {
  if (!ADVISORY_REFERRAL_SEATS.includes(referral.seat)) return null;
  const matches = (record, key) => {
    if (key === referral.key) return false;
    const finding = record.referrals.find(f => f.key === key)?.finding;
    const target = referral.finding;
    const file = corroborationPath(finding?.file);
    if (!file || file !== corroborationPath(target.file)) return false;
    if (!(finding.line == null && target.line == null)
      && !(finding.line != null && target.line != null
        && Math.abs(finding.line - target.line) <= CORROBORATION_LINE_WINDOW)) return false;
    const summary = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    return summary(finding.summary) === summary(target.summary) || wordOverlap(finding.summary, target.summary) >= 0.5;
  };
  for (const record of records) {
    if (record.head !== head || record.repo !== repo || record.pr !== pr) continue;
    for (const ruling of record.rulings) {
      if (ruling.result === 'not-real' && !record.rulings.some(next => supersededRulings(next).includes(ruling.id))
        && matches(record, ruling.key)) return { runId: record.runId, key: ruling.key, rulingId: ruling.id };
    }
  }
  for (const ruling of operatorRulings) {
    if (ruling.result !== 'not-real' || ruling.head !== head || ruling.repo !== repo || ruling.pr !== pr) continue;
    const record = records.find(r => r.runId === ruling.runId && r.head === head && r.repo === repo && r.pr === pr);
    if (record && matches(record, ruling.key)) return { runId: ruling.runId, key: ruling.key, operator: true };
  }
  return null;
}

/** The finding fields an operator ruling is scoped to: a carry requires every one to be equal. */
export const CARRY_SEVERITY_FIELDS = Object.freeze(['verdict', 'impactIfUnfixed']);

/**
 * The operator ruling that still backs a `carried` entry, or null. The LATEST ruling on the carried-from
 * (head, run, finding) decides, and it must still say what was carried (same result, same card): an operator who
 * later re-rules that finding withdraws the backing. ONE definition for the gate (`referralRecordState`) and the
 * ignored-ruling ledger (`ruling-ledger.mjs#ignoredRulings`), so they cannot disagree on whether a carry stands.
 */
export function carriedBackingHolds(carried, { repo, pr, operatorRulings = [] }) {
  const backing = operatorRulings.filter(o => o.repo === repo && o.pr === pr
    && o.head === carried.from.head && o.runId === carried.from.runId && o.key === carried.from.key).at(-1);
  return backing && backing.result === carried.result && backing.card === carried.card ? backing : null;
}

/**
 * The gate's read-time check of an operator `carried` entry: the backing ruling still holds ({@link carriedBackingHolds})
 * AND, when the source record is readable, the destination is the same finding the sink matched on
 * ({@link sameFindingForClearing}) — a carry entry cannot name an unrelated finding. Without the source record there
 * is nothing to compare, so only the backing is checked (the sink proved the match when it wrote the entry).
 */
function operatorCarryBacking(carried, target, { repo, pr, operatorRulings, records }) {
  const backing = carriedBackingHolds(carried, { repo, pr, operatorRulings });
  if (!backing) return null;
  const source = (Array.isArray(records) ? records : []).find(r => r.head === carried.from.head
    && r.runId === carried.from.runId && r.repo === repo && r.pr === pr);
  const from = source?.referrals.find(x => x.key === carried.from.key);
  return source && (!from || !sameFindingForClearing(from.finding, target.finding)) ? null : backing;
}

/** Latest matching operator decision on an earlier head; the IO caller must prove unchanged cited lines. */
export function findCarriedOperatorRuling(referral, { records = [], operatorRulings = [], head, repo, pr }) {
  const target = referral.finding;
  for (const o of [...operatorRulings].reverse()) {
    if (o.head === head || o.repo !== repo || o.pr !== pr) continue;
    const record = records.find(r => r.runId === o.runId && r.head === o.head && r.repo === repo && r.pr === pr);
    const finding = record?.referrals.find(f => f.key === o.key)?.finding;
    // Clearing a mandatory referral is stricter than merging duplicates (exact path, line window, symmetric word
    // overlap, same severity): see `sameFindingForClearing`, the one definition the ledger's overrule shares.
    if (!finding || !sameFindingForClearing(finding, target)) continue;
    return { from: { head: o.head, runId: o.runId, key: o.key }, result: o.result, card: o.card, finding };
  }
  return null;
}

// ── #76c — THE REVIEWER'S OWN not-real / card RULING STANDS ACROSS HEADS ────────────────────────────────────────
// #4017 was re-ruled ~60 times: every push re-raised the same finding (new line, new wording) and a fresh reviewer
// pass ruled it again, sometimes the other way a minute later. Operator rulings already carried (above); the
// mandatory reviewer's own did not. This carries a COUNTED reviewer `not-real` or `card` onto the same finding on a
// later head — same finding means the DETERMINISTIC identity of #76a (same path, lens, and claim or quote anchor),
// never a declared `sameAs` (a link only ever tightens) and never text similarity — and the sink still proves the
// cited lines unchanged before it writes the carry. A BLOCK is never carried: it is only ever held (`linkedBlocked`)
// and any block on the finding's id, on any later record or by the operator, withdraws a carried clearance.

/**
 * The earlier reviewer ruling that still backs a reviewer-backed `carried` entry (`from.rulingId`), or null. It
 * stands only while: the source record carries that ruling on that key with the carried result (and card); the gate
 * COUNTS it on its own head (independent clearer, readable card — the test every ruling passes); nothing supersedes
 * it; and no `block` has been ruled on the finding's id since — in a later record or by the operator. ONE definition
 * for the gate (`referralRecordState`) and the sink (`findCarriedReviewerRuling`), so they cannot disagree. PURE.
 */
export function reviewerCarryBacking(carried, { records = [], operatorRulings = [], repo, pr, identityTable = null, target, ...options } = {}) {
  const from = carried?.from;
  if (!from || typeof from.rulingId !== 'string' || !['not-real', 'card'].includes(carried.result)) return null;
  const list = Array.isArray(records) ? records : [];
  const index = list.findIndex(r => r.head === from.head && r.runId === from.runId && r.repo === repo && r.pr === pr);
  const source = list[index];
  const ruling = source?.rulings.find(x => x.id === from.rulingId && x.key === from.key);
  if (!ruling || ruling.result !== carried.result || (ruling.result === 'card' && ruling.card !== carried.card)) return null;
  // The carry must be for the SAME finding it stands on: the destination (`target`, the referral the carry is on —
  // required, so a caller that forgets it fails closed) shares the source finding's deterministic identity and
  // severity. The sink only ever writes such a carry; this holds a hand-built or buggy one to the same rule.
  const sourceFinding = source.referrals.find(f => f.key === from.key);
  const destIdentity = target ? normalizeFindingIdentity(target.original ?? target.finding) : null;
  const sourceIdentity = sourceFinding ? normalizeFindingIdentity(sourceFinding.original ?? sourceFinding.finding) : null;
  if (!destIdentity || !sourceIdentity || (carried.key !== undefined && target.key !== carried.key)
    || !sameFindingIdentity(sourceIdentity, destIdentity)
    || !CARRY_SEVERITY_FIELDS.every(k => sourceFinding.finding[k] === target.finding[k])) return null;
  if (source.rulings.some(x => supersededRulings(x).includes(ruling.id))) return null;
  // Counted on ITS OWN head, without recursing into the source's own carries or links.
  const own = referralRecordState({ ...source, carried: undefined }, { ...options, head: source.head, records: [],
    operatorRulings, linkedBlocked: null, identityTable: null });
  if (!own.rulings.includes(ruling)) return null;
  const table = identityTable ?? findingIdentityTable(list);
  const id = findingIdOf(table, { head: source.head, runId: source.runId, key: from.key });
  if (!id) return null;
  const sameId = (head, runId, key) => findingIdOf(table, { head, runId, key }) === id;
  // A block anywhere on the SOURCE head (an earlier record, the source record itself, another key sharing the id) or
  // in any later record holds the finding: two counted rulings that disagree on one head resolve to the block, so
  // the clearance never stood on that head and cannot be carried off it.
  for (const [at, other] of list.entries()) {
    if (other.repo !== repo || other.pr !== pr || (at < index && other.head !== source.head)) continue;
    if (other.referrals.some(f => sameId(other.head, other.runId, f.key)
      && other.rulings.some(x => x.key === f.key && x.result === 'block'))) return null;
  }
  if ((Array.isArray(operatorRulings) ? operatorRulings : []).some(o => o.repo === repo && o.pr === pr
    && o.result === 'block' && sameId(o.head, o.runId, o.key))) return null;
  return ruling;
}

/**
 * The earlier counted reviewer `not-real`/`card` ruling a referral on a new head inherits, or null. The LATEST
 * ruling on the same deterministic identity decides: if it is not a clearance (a `block`), nothing carries. The
 * caller must still prove the cited lines unchanged ({@link findCarriedOperatorRuling}'s same obligation). PURE.
 */
export function findCarriedReviewerRuling(referral, { records = [], operatorRulings = [], head, repo, pr, ...options } = {}) {
  const target = normalizeFindingIdentity(referral.original ?? referral.finding);
  if (!target) return null;
  const list = Array.isArray(records) ? records : [];
  const identityTable = findingIdentityTable(list);
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.head === head || r.repo !== repo || r.pr !== pr) continue;
    for (const ruling of [...r.rulings].reverse()) {
      const g = r.referrals.find(f => f.key === ruling.key);
      if (!g || !sameFindingIdentity(normalizeFindingIdentity(g.original ?? g.finding), target)) continue;
      // The latest ruling on this finding decides, whatever it said: a block (or an unlike severity) ends the search.
      if (!['not-real', 'card'].includes(ruling.result)
        || !CARRY_SEVERITY_FIELDS.every(k => g.finding[k] === referral.finding[k])) return null;
      const entry = { result: ruling.result, ...(ruling.card ? { card: ruling.card } : {}),
        from: { head: r.head, runId: r.runId, key: ruling.key, rulingId: ruling.id } };
      return reviewerCarryBacking(entry, { ...options, records: list, operatorRulings, repo, pr, identityTable, target: referral })
        ? { ...entry, finding: g.finding } : null;
    }
  }
  return null;
}

/** Versioned snapshot of the append-only referral history, mirrored into the jury ledger. */
export function validateReferralRecord(r) {
  try {
    if (!r || r.version !== 1 || !/^[^/\s]+\/[^/\s]+$/.test(r.repo)
      || !Number.isInteger(r.pr) || r.pr < 1 || !/^[a-f0-9]{40}$/.test(r.head)
      || typeof r.authorBody !== 'string' || typeof r.runId !== 'string' || !r.runId.trim() || typeof r.attempted !== 'boolean'
      || !Array.isArray(r.referrals) || !r.referrals.length || !Array.isArray(r.rulings)) return false;
    const reviewer = mandatoryReferralReviewer(r.runId);
    if (r.reviewer?.id !== reviewer.id || r.reviewer?.lens !== reviewer.lens) return false;
    const keys = new Set();
    for (const f of r.referrals) {
      if (!f || typeof f.seat !== 'string' || !f.seat || !requiresMandatoryReferral(f.original)
        || JSON.stringify(normalizeFinding(f.original)) !== JSON.stringify(f.finding)
        || f.key !== referralFindingKey(f.seat, f.original) || keys.has(f.key)
        // #76a — optional identity fields; a record without them (every record before #76) stays valid.
        || (f.findingId !== undefined && !FINDING_ID_PATTERN.test(f.findingId))
        || (f.sameAs !== undefined && f.sameAs !== FINDING_SAME_AS_NEW && !FINDING_ID_PATTERN.test(f.sameAs))) return false;
      keys.add(f.key);
    }
    if (r.dropped !== undefined && (!Array.isArray(r.dropped)
      || new Set(r.dropped.map(d => d.key)).size !== r.dropped.length
      || r.dropped.some(d => d.reason !== REFERRAL_DROP_REASON
        || !Object.hasOwn(REFERRAL_SEAT_PROVIDERS, r.referrals.find(f => f.key === d.key)?.seat)))) return false;
    if (r.superseded !== undefined && (!Array.isArray(r.superseded)
      || new Set(r.superseded.map(s => s.key)).size !== r.superseded.length
      || r.superseded.some(s => s.reason !== REFERRAL_SUPERSEDE_REASON
        || !ADVISORY_REFERRAL_SEATS.includes(r.referrals.find(f => f.key === s.key)?.seat)
        || !s.by || typeof s.by.runId !== 'string' || !s.by.runId.trim()
        || typeof s.by.key !== 'string' || !s.by.key.trim() || s.by.key === s.key
        || !(s.by.operator === true && s.by.rulingId === undefined
          || s.by.operator === undefined && typeof s.by.rulingId === 'string' && s.by.rulingId.trim())))) return false;
    if (r.carried !== undefined && (!Array.isArray(r.carried)
      || new Set(r.carried.map(c => c.key)).size !== r.carried.length
      || r.carried.some(c => !keys.has(c.key) || c.reason !== REFERRAL_CARRY_REASON
        || !c.from || !/^[a-f0-9]{40}$/.test(c.from.head) || c.from.head === r.head
        || typeof c.from.runId !== 'string' || !c.from.runId.trim()
        || typeof c.from.key !== 'string' || !c.from.key.trim()
        // #76c — a reviewer-backed carry names the ruling it stands on, and is never a block.
        || (c.from.rulingId !== undefined && (typeof c.from.rulingId !== 'string' || !c.from.rulingId.trim() || c.result === 'block'))
        || !['block', 'card', 'not-real'].includes(c.result)
        || (c.result === 'card' ? !/^we:backlog\/[^/]+\.md$/.test(c.card ?? '') : c.card !== undefined)))) return false;
    const ids = new Set();
    for (const rli of r.rulings) {
      if (!rli || typeof rli.id !== 'string' || !rli.id || ids.has(rli.id)
        || !keys.has(rli.key) || rli.reviewerId !== reviewer.id || rli.lens !== reviewer.lens
        || !['block', 'card', 'not-real'].includes(rli.result)
        // #76b — an optional declared link, recorded on the reviewer's own ruling; the table re-checks its structure.
        || (rli.sameAs !== undefined && !FINDING_ID_PATTERN.test(rli.sameAs))
        || typeof rli.rationale !== 'string' || !rli.rationale.trim()
        || !Array.isArray(rli.evidence) || !rli.evidence.length
        || rli.evidence.some(e => typeof e !== 'string' || !e.trim())
        || (rli.result === 'card' && !/^we:backlog\/[^/]+\.md$/.test(rli.card ?? ''))
        || supersededRulings(rli).some(id => !ids.has(id)
          || r.rulings.find(x => x.id === id)?.key !== rli.key)) return false;
      ids.add(rli.id);
    }
    return true;
  } catch { return false; }
}

/** Missing-author-stamp policy env: `refuse` (default, fail-closed) keeps the hold and names
 * `author-stamp-missing` in pending reasons; exactly `run-identity` is the explicit operator opt-in that
 * trusts the run-derived referral reviewer when the stamp is missing. Relaxing a security control must be
 * a positive act — a stripped stamp (`stamp-lost`) is indistinguishable from a raw-created PR by date alone.
 */
export const REFERRAL_STAMP_POLICY_ENV = 'WE_REFERRAL_MISSING_STAMP';

/** Resolve `refuse` by default; only the exact env value `run-identity` relaxes it (any other value, a
 * mis-cased or unknown one included, stays strict). */
export function resolveReferralStampPolicy(env = process.env) {
  return env[REFERRAL_STAMP_POLICY_ENV] === 'run-identity' ? 'run-identity' : 'refuse';
}

/** Resolve own rulings from the assigned reviewer or operator. An unruled advisory duplicate
 * may also clear through its explicit same-subject, same-head not-real supersession reference.
 * Run-derived identities on other records confer no authority over this obligation.
 */
export function referralRecordState(record, options = {}) {
  const { head = record?.head, body = record?.authorBody ?? '', createdAt = '',
    cardReadable = () => false, seatDisabled = () => false, operatorRulings = [], records = [],
    stampPolicy = resolveReferralStampPolicy(), identityTable = null, linkedBlocked } = options;
  if (!validateReferralRecord(record)) return { pending: ['malformed-referral-record'], blocked: [], blockedFindings: [], rulings: [] };
  const pending = [], blocked = [], rulings = [];
  const decision = decideClearerIndependence({ authorId: parseAuthorActorId(body),
    clearerId: record.reviewer.id, prCreatedAt: createdAt });
  // `validateReferralRecord` already pinned reviewer.id to the run-derived seat, so no separate id check here.
  const missingStamp = decision.independent !== true
    && [INDEPENDENCE.STAMP_LOST, INDEPENDENCE.UNKNOWN_AUTHOR].includes(decision.status);
  // Only on the explicit `run-identity` opt-in: this seat is derived from the review run, not any author's
  // real session identity, so it proves nothing about independence on its own.
  const fallback = missingStamp && stampPolicy === 'run-identity';
  const independent = decision.independent === true || fallback;
  for (const f of activeReferrals(record)) {
    const recorded = record.rulings.filter(r => r.key === f.key);
    // #4979 — the operator's ruling on THIS exact (repo, PR, head, run, finding) is the explicit, authorized
    // supersession: the latest one decides, over the reviewer's. It is pinned to the record's head, so a new
    // head (or an unreadable card) leaves the finding pending exactly like a reviewer ruling would.
    const operator = (Array.isArray(operatorRulings) ? operatorRulings : []).filter(o => o.repo === record.repo
      && o.pr === record.pr && o.head === record.head && o.runId === record.runId && o.key === f.key).at(-1);
    if (operator) {
      if (head !== record.head || (operator.result === 'card' && !cardReadable(operator.card))) pending.push(f.key);
      else { rulings.push(operator); if (operator.result === 'block') blocked.push(f.key); }
      continue;
    }
    // The reviewer's own COUNTED ruling on this head (independent clearer, one outcome, readable card) — the same
    // test the carry sink applies before it carries, so the two cannot disagree about what a carry may replace.
    const history = independent ? recorded : [];
    const active = history.filter(r => !history.some(next => supersededRulings(next).includes(r.id)));
    const outcomes = new Set(active.map(r => JSON.stringify([r.result, r.result === 'card' ? r.card : null])));
    const cardUnreadable = active.some(r => r.result === 'card' && !cardReadable(r.card));
    // A carry only stands in for a ruling nobody has counted on THIS head: a counted reviewer ruling for the same
    // finding (appended after the carry) wins over it, so a current-head `block` can never be masked by an earlier
    // head's operator not-real. A reviewer `block` that contradicts another ruling on the finding still yields: the
    // ordinary path below holds it pending. Any other uncounted ruling (non-independent clearer, unreadable card)
    // settles nothing, so the carry still applies.
    const counted = active.length > 0 && ((outcomes.size === 1 && !cardUnreadable) || active.some(r => r.result === 'block'));
    const carried = counted ? undefined : (record.carried ?? []).find(c => c.key === f.key);
    if (carried) {
      const backing = carried.from.rulingId !== undefined
        ? reviewerCarryBacking(carried, { repo: record.repo, pr: record.pr, operatorRulings, records, identityTable,
          target: f, body, createdAt, cardReadable, stampPolicy, seatDisabled })
        : operatorCarryBacking(carried, f, { repo: record.repo, pr: record.pr, operatorRulings, records });
      if (head !== record.head || !backing
        || (carried.result === 'card' && !cardReadable(carried.card))) pending.push(f.key);
      else { rulings.push(backing); if (carried.result === 'block') blocked.push(f.key); }
      continue;
    }
    const superseded = (record.superseded ?? []).find(s => s.key === f.key);
    if (!recorded.length && superseded) {
      const { by } = superseded;
      const sameSubject = r => r.runId === by.runId && r.repo === record.repo && r.pr === record.pr && r.head === record.head;
      const backed = by.operator
        ? operatorRulings.some(r => sameSubject(r) && r.key === by.key && r.result === 'not-real')
        : records.some(r => sameSubject(r) && r.rulings.some(x => x.id === by.rulingId && x.key === by.key && x.result === 'not-real'));
      if (head !== record.head || !backed) pending.push(f.key);
      continue;
    }
    // Match audited drops: disabling an optional seat cannot erase an existing ruling (especially a block),
    // even one not yet counted because its clearer is not independent.
    if (!recorded.length && seatDisabled(f.seat)) continue;
    if (head !== record.head || outcomes.size !== 1 || cardUnreadable) pending.push(f.key);
    else { rulings.push(...active); if (active[0].result === 'block') blocked.push(f.key); }
  }
  // #76b — ONE RULING COVERS EVERY WORDING OF A FINDING, BUT ONLY TO HOLD. A finding whose id (deterministic or a
  // declared `sameAs`) holds a counted block on this head is blocked too: pending or cleared alike, since two counted
  // rulings on one id that disagree resolve to block. A link never clears anything, and an operator's own ruling on
  // this exact finding (#4979) still decides it. `linkedBlocked: null` turns this off (the computation itself).
  const allRecords = Array.isArray(records) && records.includes(record) ? records : [...(Array.isArray(records) ? records : []), record];
  let table = identityTable;
  if (head === record.head && linkedBlocked !== null) {
    table ??= findingIdentityTable(allRecords);
    const linked = linkedBlocked ?? linkedBlockedFindingIds(allRecords, { ...options, head, identityTable: table });
    for (const f of linked.size ? activeReferrals(record) : []) {
      if (blocked.includes(f.key) || (Array.isArray(operatorRulings) ? operatorRulings : []).some(o => o.repo === record.repo
        && o.pr === record.pr && o.head === record.head && o.runId === record.runId && o.key === f.key)) continue;
      const findingId = findingIdOf(table, { head: record.head, runId: record.runId, key: f.key });
      const from = findingId ? linked.get(findingId) : undefined;
      if (!from) continue;
      for (let i = pending.indexOf(f.key); i !== -1; i = pending.indexOf(f.key)) pending.splice(i, 1);
      blocked.push(f.key);
      rulings.push({ key: f.key, result: 'block', linked: { findingId, ...from },
        rationale: `linked: the same finding (${findingId}) is ruled block on this head` });
    }
  }
  // Named only when a finding actually stays held, so a fully operator-ruled record never shows it.
  if (missingStamp && stampPolicy === 'refuse' && pending.length) pending.push('author-stamp-missing');
  // #76a — `blocked` stays the gate's key list (every acceptance boundary matches on it); `blockedFindings` is the
  // same set, each with its finding identity and finding, so the fixer's note can NAME every block.
  if (blocked.length) table ??= findingIdentityTable(allRecords);
  else table = [];
  const blockedFindings = blocked.map((key) => ({ key,
    findingId: findingIdOf(table, { head: record.head, runId: record.runId, key }),
    finding: record.referrals.find((f) => f.key === key).finding }));
  return { pending, blocked, blockedFindings, rulings, independence: { status: decision.status, fallback } };
}

/**
 * #76b — every finding id a COUNTED block holds on `head`, each mapped to the `{ runId, key }` that holds it. A block
 * counts exactly when {@link referralRecordState} reports its key blocked (independent reviewer or operator), so the
 * link can never make a block out of a ruling the gate itself would not count. PURE.
 * @returns {Map<string, {runId: string, key: string}>}
 */
export function linkedBlockedFindingIds(records = [], options = {}) {
  const { head, repo, pr } = options;
  const out = new Map();
  if (!/^[a-f0-9]{40}$/.test(head ?? '')) return out;
  const list = Array.isArray(records) ? records : [];
  const table = options.identityTable ?? findingIdentityTable(list);
  for (const r of list) {
    if (r?.head !== head || (repo && (r.repo !== repo || r.pr !== Number(pr)))) continue;
    const state = referralRecordState(r, { ...options, head, records: list, identityTable: table, linkedBlocked: null });
    for (const key of state.blocked) {
      const findingId = findingIdOf(table, { head: r.head, runId: r.runId, key });
      if (findingId && !out.has(findingId)) out.set(findingId, { runId: r.runId, key });
    }
  }
  return out;
}

export const REFERRAL_RECORD_MARKER = 'mandatory-referrals-v1';

/** Encode data so a finding cannot close the structured comment delimiter. */
export function renderReferralRecord(record) {
  if (!validateReferralRecord(record)) throw new TypeError('invalid mandatory referral record');
  return `Mandatory review owner: ${record.reviewer.id} (${record.reviewer.lens}).\n`
    + `CONFIRMED broken/unrecoverable findings require a finding-specific block/card/not-real ruling.\n`
    + record.referrals.map(f => `- ${f.key}: ${f.finding.summary}`).join('\n')
    + (record.superseded ?? []).map(s => `\n- ${s.key}: ${s.reason} (by run ${s.by.runId})`).join('')
    + (record.carried ?? []).map(c => `\n- ${c.key}: ${c.reason} (${c.from.rulingId !== undefined ? 'reviewer' : 'operator'} ${c.result}, from ${c.from.head}, run ${c.from.runId})`).join('')
    + (record.dropped ?? []).map(d => `\n- ${d.key}: ${d.reason}`).join('')
    + `\nAttempt recorded: ${record.attempted}. Reason: ${record.failure ?? (referralRecordState(record).pending.length ? 'mandatory finding-specific review required' : 'finding-specific rulings recorded')}. Rulings: ${JSON.stringify(record.rulings)}\n`
    + `Record any missing finding-specific rulings with the mandatory reviewer identified above, retaining prior rulings and explicit supersedes IDs. Then start a fresh review-pr --pr=${record.pr} --repo=${record.repo}; it reuses this PR record without another automated attempt. card requires a readable backlog reference.\n`
    + `<!-- ${REFERRAL_RECORD_MARKER}: ${encodeURIComponent(JSON.stringify(record))} -->`;
}

/**
 * Fold snapshots monotonically: omission, conflicts and malformed/partial records never clear a hold.
 *
 * Only a comment from a trusted author ({@link isTrustedMarkerAuthor}: the automation or the operator) is read.
 * Records are scoped to their own reviewer; comment authors must also be trusted. An untrusted comment that opens a record (the marker opener at the
 * start of a line) is therefore never read as a record, but it IS flagged `malformed` (a hold), not skipped —
 * operator decision on PR #3507: anything that looks like a referral record and cannot be read cleanly is a flagged
 * hold. A bare string has no author, so it is untrusted too. A comment that only DISCUSSES the marker in prose
 * (no line-start opener) is ignored (#3643).
 */
export function readReferralRecords(comments, { head } = {}) {
  const records = new Map();
  const seen = new Set();
  let malformed = !Array.isArray(comments);
  // Only a decoded, full SHA can prove corruption belongs to a different head.
  // Without a current head, retain the historical fail-closed reader behavior. The typeof check matters:
  // RegExp.test coerces its argument, so a decoded `head: [sha]` would pass the regex yet fail `===`.
  const holdsHead = (r) => !/^[a-f0-9]{40}$/.test(head ?? '')
    || typeof r?.head !== 'string' || !/^[a-f0-9]{40}$/.test(r.head) || r.head === head;
  for (const comment of Array.isArray(comments) ? comments : []) {
    const body = typeof comment === 'string' ? comment : comment?.body ?? '';
    // Only a literal opener at the start of a line attempts a record; prose may discuss the marker (#3643). Indentation
    // is `[ \t]*`, never `\s*`: `\s` also matches newlines, so under `m` a whitespace-heavy untrusted body is O(n²).
    if (!/^[ \t]*<!-- mandatory-referrals-v1:/m.test(body)) continue;
    // Fail closed: a record-shaped comment from an author outside the trusted principals is never read as a record
    // (it cannot clear another record's hold), but it is flagged malformed so it stays a visible hold a person
    // clears — it must not vanish. Cost: any commenter can park a PR; the failure mode is "needs a human", never "clear".
    if (!isTrustedMarkerAuthor(comment)) { malformed = true; continue; }
    // Only the comment's own final line is structured data. Summaries and rationales
    // may quote arbitrary marker-shaped text; they cannot inject a second record.
    const trailer = body.trimEnd().split('\n').at(-1);
    // The closing ` -->` is optional here (#3643): a trailer cut off before it, or part-way through it (` --`, ` -`),
    // still decodes, and the read below holds it only when it belongs to the current head (or cannot be attributed
    // to another one). Only the whole ` -->` is captured, so a part-way cut still counts as unclosed.
    const match = /^[ \t]*<!-- mandatory-referrals-v1: ([^\s]+)(?:( -->)| -{0,2}>?)?$/.exec(trailer);
    const matches = match ? [match] : [];
    // Fail closed: a trusted comment that opens a record but does not end in a valid trailer (an operator note
    // appended by editing it, a truncated write) is flagged malformed so its hold cannot vanish silently.
    if (!match) malformed = true;
    for (const match of matches) {
      try {
        const r = JSON.parse(decodeURIComponent(match[1]));
        if (!match[2] || !validateReferralRecord(r)) { malformed ||= holdsHead(r); continue; }
        const snapshot = JSON.stringify(r);
        if (seen.has(snapshot)) continue;
        seen.add(snapshot);
        const id = JSON.stringify([r.repo, r.pr, r.head, r.runId]);
        const previous = records.get(id);
        if (previous && (previous.authorBody !== r.authorBody || JSON.stringify(previous.referrals) !== JSON.stringify(r.referrals)
          || (previous.attempted && !r.attempted)
          || JSON.stringify((r.dropped ?? []).slice(0, (previous.dropped ?? []).length)) !== JSON.stringify(previous.dropped ?? [])
          || JSON.stringify((r.carried ?? []).slice(0, (previous.carried ?? []).length)) !== JSON.stringify(previous.carried ?? [])
          || JSON.stringify((r.superseded ?? []).slice(0, (previous.superseded ?? []).length)) !== JSON.stringify(previous.superseded ?? [])
          || JSON.stringify(r.rulings.slice(0, previous.rulings.length)) !== JSON.stringify(previous.rulings))) {
          malformed ||= holdsHead(r); continue;
        }
        records.set(id, r);
      } catch { malformed = true; }
    }
  }
  return { records: [...records.values()], malformed };
}

/**
 * #4979 — THE OPERATOR RULING PATH. The operator rules block / card / not-real on a mandatory referral; the
 * sanctioned writer (`we:scripts/operations/record-referral-ruling.mjs`) posts it as ONE machine-marked PR
 * comment. It never edits a referral record (those stay append-only and reviewer-scoped): the gate reads both.
 *
 * What makes a ruling count (every other shape is a hold, never a clearance):
 *  - posted by a trusted principal: `author.login` is an automation or operator login. `viewerDidAuthor` alone
 *    is not enough (same rule as the stand-down answer, we:scripts/conveyor/stand-down-answer-core.mjs);
 *  - the body is EXACTLY what {@link buildOperatorRulingComment} renders from its own trailer, so prose,
 *    quotes or a hand-edit cannot inject or alter a ruling;
 *  - `actor` is a registered operator login (OPERATOR_LOGINS), with a one-line channel, the operator's words
 *    verbatim, a timestamp and the recording session's id (audit; like `clear-human`, the actor is a recorded
 *    assertion — #2895's honesty tax — not a signature);
 *  - each ruling names the repo, PR, head SHA, referral run and finding key it rules on. The gate applies it only
 *    to that exact record, only while that head is the PR's head; `card` needs a readable we:backlog card.
 */
export const OPERATOR_RULING_MARKER = 'mandatory-referral-operator-ruling-v1';
export const OPERATOR_RULING_RESULTS = Object.freeze(['block', 'card', 'not-real']);
const OPERATOR_RULING_OPENER = /^[ \t]*<!-- mandatory-referral-operator-ruling-v1:/m;
const inertProse = s => String(s).replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');

/** Strict shape of one operator ruling record. Pure; never throws. */
export function validateOperatorRuling(r) {
  try {
    if (!r || r.version !== 1 || !/^[^/\s]+\/[^/\s]+$/.test(r.repo) || !Number.isInteger(r.pr) || r.pr < 1
      || !/^[a-f0-9]{40}$/.test(r.head)) return false;
    if (typeof r.actor !== 'string' || !/^[\w-]+$/.test(r.actor) || !OPERATOR_LOGINS.includes(r.actor.toLowerCase())) return false;
    if (typeof r.channel !== 'string' || !r.channel.trim() || /[\r\n]/.test(r.channel) || r.channel.length > 200) return false;
    if (typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 4000) return false;
    if (typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return false;
    if (typeof r.clearerId !== 'string') return false;
    if (!Array.isArray(r.rulings) || !r.rulings.length) return false;
    const seen = new Set();
    for (const x of r.rulings) {
      if (!x || typeof x.runId !== 'string' || !x.runId.trim() || typeof x.key !== 'string' || !x.key.trim()
        || !OPERATOR_RULING_RESULTS.includes(x.result)) return false;
      if (x.result === 'card' ? !/^we:backlog\/[^/]+\.md$/.test(x.card ?? '') : x.card !== undefined) return false;
      const id = JSON.stringify([x.runId, x.key]);
      if (seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  } catch { return false; }
}

/** Render the one sanctioned comment. The trailer is the only structured data; the visible text is inert. */
export function buildOperatorRulingComment(r) {
  if (!validateOperatorRuling(r)) throw new TypeError('invalid operator referral ruling');
  const quote = inertProse(r.reason).split('\n').map(line => `> ${line}`).join('\n');
  const lines = r.rulings.map((x, i) => {
    let summary = '';
    try { summary = String(JSON.parse(x.key).at(-1) ?? ''); } catch { /* opaque key */ }
    return `${i + 1}. **${x.result}**${x.card ? ` → \`${inertProse(x.card)}\`` : ''} — ${inertProse(summary.replace(/\s+/g, ' ').slice(0, 300))} (run \`${inertProse(x.runId)}\`)`;
  });
  return `## Operator ruling on mandatory referrals\n\n`
    + `Recorded on the operator's explicit instruction: @${r.actor}, via ${inertProse(r.channel)}, at ${r.at}, for head \`${r.head}\`.\n`
    + `This rules only on the findings listed; it applies to this head only and does not change review labels.\n\n`
    + `${quote}\n\n${lines.join('\n')}\n\n`
    + `<!-- ${OPERATOR_RULING_MARKER}: ${Buffer.from(JSON.stringify(r)).toString('base64')} -->`;
}

/**
 * Read one comment: `null` when it is not an operator-ruling comment, `{record}` when it is a valid one from a
 * trusted principal, `{malformed: true, head?}` otherwise (an outsider's copy, a hand-edit, a truncated write).
 */
export function parseOperatorRulingComment(comment) {
  const body = typeof comment === 'string' ? comment : comment?.body ?? '';
  if (typeof body !== 'string' || !OPERATOR_RULING_OPENER.test(body)) return null;
  const login = typeof comment === 'object' && comment ? String(comment.author?.login ?? '').toLowerCase() : '';
  const trusted = login && [...AUTOMATION_LOGINS, ...OPERATOR_LOGINS].includes(login);
  const normalized = body.replace(/\r\n/g, '\n').trimEnd();
  const match = new RegExp(`\\n<!-- ${OPERATOR_RULING_MARKER}: ([A-Za-z0-9+/=]+) -->$`).exec(normalized);
  let record = null;
  try { record = match ? JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) : null; } catch { record = null; }
  const head = typeof record?.head === 'string' && /^[a-f0-9]{40}$/.test(record.head) ? record.head : undefined;
  if (!trusted || !record || !validateOperatorRuling(record)) return { malformed: true, head };
  try { if (buildOperatorRulingComment(record) !== normalized) return { malformed: true, head }; }
  catch { return { malformed: true, head }; }
  return { record };
}

/** Every valid operator ruling in thread order, flattened to one entry per (run, finding). */
export function readOperatorRulings(comments, { head } = {}) {
  const rulings = [];
  let malformed = false;
  const current = /^[a-f0-9]{40}$/.test(head ?? '') ? head : null;
  for (const comment of Array.isArray(comments) ? comments : []) {
    const parsed = parseOperatorRulingComment(comment);
    if (!parsed) continue;
    // A broken ruling that provably belongs to another head cannot hold this one; anything else holds.
    if (parsed.malformed) { malformed ||= !(current && parsed.head && parsed.head !== current); continue; }
    const r = parsed.record;
    for (const x of r.rulings) {
      rulings.push(Object.freeze({ operator: true, repo: r.repo, pr: r.pr, head: r.head, runId: x.runId, key: x.key,
        result: x.result, ...(x.card ? { card: x.card } : {}), actor: r.actor, channel: r.channel, reason: r.reason,
        at: r.at, clearerId: r.clearerId }));
    }
  }
  return { rulings, malformed };
}

/** Shared fresh-read acceptance boundary and replay state. */
export function mandatoryReferralState(comments, context = {}) {
  const { records, malformed } = readReferralRecords(comments, context);
  const operator = readOperatorRulings(comments, context);
  context = { ...context, operatorRulings: operator.rulings };
  const pending = malformed ? ['malformed-referral-record'] : [];
  if (operator.malformed) pending.push('malformed-operator-ruling');
  if (records.length && Object.hasOwn(context, 'head') && !/^[a-f0-9]{40}$/.test(context.head ?? '')) {
    pending.push('unavailable-reviewed-head');
  }
  const blocked = [];
  const blockedFindings = [];
  const identityTable = findingIdentityTable(records);
  // #76b — computed once per head here, not once per record.
  const linkedByHead = new Map();
  const linkedFor = (h) => {
    if (!linkedByHead.has(h)) linkedByHead.set(h, linkedBlockedFindingIds(records, { ...context, head: h, identityTable }));
    return linkedByHead.get(h);
  };
  // The review carries source findings into the new head's own records. Neither old holds nor old
  // clearance carry forward implicitly; explicit carried entries require operator backing.
  for (const r of records) {
    if (/^[a-f0-9]{40}$/.test(context.head ?? '') && r.head !== context.head) continue;
    if (context.repo && (r.repo !== context.repo || r.pr !== Number(context.pr))) { pending.push('wrong-subject'); continue; }
    const recordHead = context.head ?? r.head;
    const state = referralRecordState(r, { ...context, records, identityTable,
      ...(recordHead === r.head ? { linkedBlocked: linkedFor(r.head) } : {}) });
    pending.push(...state.pending);
    blocked.push(...state.blocked);
    for (const b of state.blockedFindings) if (!blockedFindings.some((x) => x.key === b.key)) blockedFindings.push(b);
  }
  return { records, operatorRulings: operator.rulings, pending: [...new Set(pending)], blocked: [...new Set(blocked)],
    blockedFindings, malformed };
}

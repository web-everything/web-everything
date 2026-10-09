/**
 * review-core.mjs — the shared "read a diff, judge it" contract (#2325, under epic #2285).
 *
 * WHY: the same judge-a-diff logic used to exist as duplicated PROSE in two places — the `/code-review`
 * model (Claude Code's built-in review skill; a human/agent asks it to review a diff and it renders
 * findings) and the drain's inline auto-review subagent (described in `we:skills-src/drain/SKILL.md`,
 * spawned as a raw `Agent` call that sees only the diff + PR body and returns accept/changes). A future
 * `/review` human-verdict skill (`#2326`) is a third. This module is the ONE canonical shape + derivation
 * every caller renders into, so the contract is defined once, tested once, and never re-invented per caller.
 *
 * SCOPE (important): `/code-review` is a Claude Code product surface with no source living in this repo —
 * this module cannot "call into" it. What it DOES do is define the canonical `Finding`/`verdict` contract
 * whose CORE fields `/code-review`'s own output already matches (see the `ReportFindings` tool shape it renders
 * through: file, summary, failure_scenario, category, line, verdict, outcome) and that this repo's own docs
 * (`we:docs/agent/platform-decisions.md`, the pre-PR review rider) and skills point reviewers at.
 *
 * #2823 SHAPE PARITY — the introspection fields (`rootCause` / `prevention` / `preventionCaptured`, plus #xdompzx's
 * `impactIfUnfixed`)
 * are a SUPERSET the canonical `Finding` carries but `/code-review`'s `ReportFindings` tool CANNOT: its schema is
 * `additionalProperties: false`, so it hard-rejects the extra keys. They are therefore scoped to the surfaces
 * whose return schemas are `additionalProperties: true` — the drain panel reviewer (`scripts/workflows/review-parked-prs.mjs`)
 * and the subject-jury jurors/red-team (`skills-src/jury/subject-jury.workflow.js`), whose prompts AND return
 * schemas DO ask for the fields so `normalizeFinding` picks them up and `deriveVerdict` can reach
 * `prevention-outstanding`. ADDING A FIELD TO THE FINDING SHAPE MEANS EDITING BOTH OF THOSE FILES BY HAND, in two
 * places each — the return schema AND the prompt sentence that asks for it (`subject-jury.workflow.js` has two such
 * prompts, juror and red-team). There is no import edge from them to this contract (both are Workflow-harness
 * bodies that cannot `import`), and
 * `additionalProperties: true` means an omitted field raises no error, so the omission is silent. #xdompzx's
 * `impactIfUnfixed` shipped inert for exactly that reason (review blocker 1); the deterministic guard that would
 * make the parity mechanical is filed as its own backlog item. On the
 * `/code-review` surface the prevention introspection still happens (the shared mandate demands it) but is carried
 * in the finding's PROSE (its `summary`/`failure_scenario`), not as structured fields the tool would reject. So
 * "matches `/code-review`" holds for the CORE shape; the #2823 fields are a deliberate, surface-scoped extension. The
 * JUDGEMENT itself (spawning a subagent, reading a diff, deciding what's wrong) is never done here — like
 * `we:scripts/lane-review.mjs`, this module is the mechanical/derivation half; judging stays the caller's
 * action. `#2326` wires the drain auto-review + the new `/review` skill to this contract; this item (`#2325`)
 * lands the contract itself.
 *
 * The core JUDGES ONLY. It never knows about labels, `review:human`, or who is
 * allowed to clear what — that policy stays with each caller (the drain owns its leash; see
 * `we:scripts/lib/review-escalation.mjs`'s `decideReviewGate`, which is unaffected by this module).
 *
 * #2311 (v2, under epic #2285) adds the editor↔reviewer NEGOTIATION LOOP that replaces v1's author-bounce:
 * `buildEditorMandate()` seeds a fresh-context editor subagent with the reviewer's findings + the diff-only,
 * no-checkout isolation `buildMandate()` already established, and `deriveNegotiationOutcome()` is the ONE
 * deterministic round-cap decision (`continue` / `land` / `escalate`) every caller derives from — the
 * hookable half of the loop (#51: script-decidable stays a pure function; the judgment — proposing a fix,
 * critiquing it — stays with the subagents). The round cap itself (`NEGOTIATION_ROUND_CAP`) is a tuning knob,
 * not a magic number scattered per caller.
 *
 * #2310 (v3, under epic #2285) fans v2's single reviewer out into a MULTI-MANDATE PANEL — distinct mandated
 * reviewers (correctness / security / simplicity / standards-conformance, the `/code-review` lenses) each judge
 * the diff independently (`buildPanelMandate()`, `MANDATE_LENSES`/`MANDATORY_LENSES`/`ADVISORY_LENSES`), and
 * `derivePanelVerdict()` reduces their per-lens verdicts to the ONE combined verdict `deriveNegotiationOutcome`
 * already consumes — the round loop itself is unchanged, v3 only adds the many-verdicts-to-one reduction.
 *
 * Pure, unit-tested in `we:scripts/lib/__tests__/review-core.test.mjs`.
 */
import {
  POLICY_IMPLEMENTED_REASON_TOKENS,
  POLICY_REASONS_BY_FAMILY,
  POLICY_HUMAN_SENSITIVITY_REASONS,
  POLICY_CARE_JURY,
} from './review-policy.mjs';

// #2567 — the advisory CARE-LEVEL derivation is single-sourced in review-escalation.mjs (where it is derived
// from the escalation signals). This is a ONE-WAY import from a leaf (review-escalation imports only
// gate-config + review-policy), so review-core → review-escalation is acyclic. review-core stays label-free /
// leash-free — a care-level is advisory review-RIGOR information (how hard to look), not a route/land policy
// (that stays with review-escalation's decideReviewGate). `careLevelFromReasons` (below) is the one consumer.
import { deriveCareLevel, CARE_LEVELS, CARE_LEVEL_ORDER } from './review-escalation.mjs';

// #2653 — the subject-agnostic JURY ENGINE core was extracted to jury-core.mjs (foundational slice of epic
// #2649): the finding contract, the round loop + NEGOTIATION_ROUND_CAP, the diversity-selection reduction, and
// the care→rigor dial. review-core RE-EXPORTS every moved symbol below so all current callers
// (review-core-cli, review-parked-prs, review-render, the drain, the tests) stay byte-stable — a pure move +
// re-export, never a behaviour change. review-core's own body still USES several of them (the mandate builders,
// the plan handshake, the panel renderers, panelRigorFromReasons), so they are IMPORTED here (local bindings)
// AND re-exported.
//
// #xdompzx round-4, finding 2 — A CONTROL THE DOCUMENTED DOOR CANNOT REACH IS NOT A CONTROL. The drain skill's
// auto-land branch is told to test `hasUncapturedPrevention(f) === true && blocksAcceptance(f) === false`, and
// this module is the facade that skill's callers import from. `hasUncapturedPrevention` was re-exported and
// `blocksAcceptance` was not, so the instruction named a symbol that threw on import — the round-2 blocker shape
// (a control wired to a path nobody walks) one layer out. `blocksAcceptance`, its dial `PREVENTION_IMPACT_BAR`,
// and the `IMPACT_LEVELS` enum an author needs to read a finding's declared impact are therefore re-exported too.
// The guard lives in `we:scripts/lib/__tests__/jury-core.test.mjs`, in the describe block `the below-bar
// prevention control is wired on the auto-land branch`:
// every function named in a code span inside the skill's INDENTED branch blockquotes must be exported by this
// facade or by `we:scripts/lib/review-render.mjs` — the two modules the skill points its reader at — and the two
// predicates the bar-un-blocked check is DEFINED by must resolve from this facade specifically.
import {
  VERDICTS,
  IMPACT_LEVELS,
  PREVENTION_IMPACT_BAR,
  normalizeFinding,
  normalizeFindings,
  deriveVerdict,
  deriveLoopOutcome,
  hasUncapturedPrevention,
  blocksAcceptance,
  isFindingOutstanding,
  NEGOTIATION_ROUND_CAP,
  NEGOTIATION_OUTCOMES,
  deriveNegotiationOutcome,
  MANDATE_LENSES,
  MANDATORY_LENSES,
  ADVISORY_LENSES,
  PANEL_LENSES,
  AGGREGATION,
  panelRigorForCareLevel,
  EDITOR_ENABLED_CARE_LEVELS,
  EDITOR_MIN_ROUNDS,
  editorPolicyForCareLevel,
  buildPanelFindings,
  derivePanelVerdict,
} from './jury-core.mjs';

// #2655 — the STATELESS roster-recompute SPINE (F3). `resolveJuryPlan` below (the PR-diff resolver) delegates the
// subject-NEUTRAL merge / de-dup / provenance / method-attach to this shared spine.
// #2656 — the SUBJECT-ADAPTER CONTRACT (F2 heart). `buildSubjectMandate` is the subject-neutral mandate skeleton
// this module's `buildMandate` frames the diff into; `resolveAdapterRoster` is the seam `resolveJuryPlan` now
// routes through with `PR_DIFF_ADAPTER` (the reference adapter defined below). Imported for use, NOT re-exported —
// subject-agnostic consumers import these from jury-core.mjs directly.
import { buildSubjectMandate, resolveAdapterRoster } from './jury-core.mjs';

// #2637 — the ROSTER COMPLETENESS CRITIC folds the lenses it surfaces back onto the resolved roster through the
// SAME minimal ledger-trailed override path the F3 spine (#2655) already defines (`applyRosterOverrides` +
// `ROSTER_OVERRIDE_OPS.ADD`) — a critique-surfaced lens IS a minimal deviation from the stateless recompute, so
// it rides the existing override machinery rather than a parallel one. Imported for use, NOT re-exported.
import { applyRosterOverrides, ROSTER_OVERRIDE_OPS } from './jury-core.mjs';

// #2638 — the prepare-time jury charter derives its PROVISIONAL roster from the SAME `resolveJuryPlan` →
// `materializeRoster` the open-time jury uses (below), so the pre-registered jury is the real jury, not a parallel
// guess. Imported for use, NOT re-exported. `materializeRoster` is the subject-neutral plan → JurorSpec[] expander.
import { materializeRoster } from './jury-core.mjs';

// #2438's labelled data fence, now a leaf so jury-core can reach it too (#2967). Imported for use AND
// re-exported below: `fenceUntrusted` / `FENCED_DATA_RULE` have shipped from this module's surface since
// #2438, and every existing importer keeps working.
import { FENCED_DATA_RULE, fenceUntrusted } from './mandate-fence.mjs';

export { FENCED_DATA_RULE, fenceUntrusted };

export {
  VERDICTS,
  IMPACT_LEVELS,
  PREVENTION_IMPACT_BAR,
  normalizeFinding,
  normalizeFindings,
  deriveVerdict,
  deriveLoopOutcome,
  hasUncapturedPrevention,
  blocksAcceptance,
  isFindingOutstanding,
  NEGOTIATION_ROUND_CAP,
  NEGOTIATION_OUTCOMES,
  deriveNegotiationOutcome,
  MANDATE_LENSES,
  MANDATORY_LENSES,
  ADVISORY_LENSES,
  PANEL_LENSES,
  AGGREGATION,
  panelRigorForCareLevel,
  EDITOR_ENABLED_CARE_LEVELS,
  EDITOR_MIN_ROUNDS,
  editorPolicyForCareLevel,
  buildPanelFindings,
  derivePanelVerdict,
};

/** The canonical finding shape lives in jury-core.mjs; re-export the type so callers that reference
 *  `import('./review-core.mjs').Finding` keep resolving.
 *  @typedef {import('./jury-core.mjs').Finding} Finding */

/** Default review mandate — correctness bugs are the floor every caller shares. Pure data (a tuning knob). */
export const DEFAULT_MANDATE = 'correctness';

/**
 * WHAT IS WORTH A BOUNCE AND WHAT IS ONLY WORTH A NOTE. Declared once, here, rather than typed at each call —
 * an instruction that has to be remembered per-invocation is one that gets forgotten, and this rule was
 * originally written into `buildPanelMandate` alone, so the #2439 FINAL VALIDATOR (an equally adversarial
 * reader of the same diff, and the one whose accept the panel's accept is gated on) never received it.
 *
 * IT REACHES THREE TRANSPORTS, not two (PR #1182 review, finding C). `buildPanelMandate` and
 * `buildValidatorMandate` are the two the item named, and `PR_DIFF_ADAPTER.buildMandate` is the third — the
 * `/jury` roster shim (`we:skills-src/jury/resolve-roster.mjs`) calls the adapter member directly, so `/jury`
 * jurors judging a PR diff now receive it too. Same subject, same adversarial role, so this is a wanted gain;
 * it is written down because a gate-derivation file should not surprise its next reader.
 *
 * DELIBERATELY ABSENT from `buildEditorMandate` (it hand-rolls its own array and does not wrap this) and from
 * `DECISION_PROSE_ADAPTER`, where the rule would be actively wrong: for a decision, framing IS the substance.
 *
 * Exported so a test can prove it reaches EVERY mandate built from `buildMandate`, and so a caller building a
 * different transport can assert its presence rather than re-typing a paraphrase that drifts.
 */
/**
 * WHAT TO DO WITH A COMMENT THAT PROMISES SOMETHING. Sits beside {@link PROSE_IMPRECISION_RULE} and is
 * deliberately its opposite number: that one says wording is never worth a bounce, this one says a PROMISE is
 * not wording.
 *
 * It exists because it is what the good reviewers were already doing by instinct. Over one week, ten separate
 * properties in one file were found undefended by a reviewer deleting the behaviour and watching the suite
 * stay green — among them all three "hand this back to a human" cases in the waker, which is the safety
 * property that machinery's whole ruling rests on. Every one had a comment describing it. None had a test.
 *
 * FRAMED AS COVERAGE, NOT AS PROSE, and that is load-bearing: a missing test is a real gap in the diff, so it
 * routes through the ordinary disposition machinery. Reading it as a prose finding would put it straight back
 * under the rule above and it would never be raised.
 *
 * #3158 — SELF-SCOPED ON TRANSPORT TOO, THE SAME WAY {@link MUTATION_PROBE_RULE} IS. This rule carries the
 * IDENTICAL "BREAK the guarded line and confirm a NAMED test reddens" demand as the mutation probe, just
 * narrowed to prose guarantees — so a tool-free `judgePanel` seat was being told to do the impossible here as
 * well, and conditioning only the probe would have left half the bug in place. The fix is the same one the
 * #3094 ruling above mandates and the one `judge-panel.mjs`'s RULING records: the text carries BOTH branches
 * unconditionally and the juror — the only party that actually knows whether it has tools — picks. No caller
 * flag, so no call site can forget it and no default can be stale in either direction.
 */
export const GUARANTEE_NEEDS_A_TEST_RULE = [
  'A COMMENT THAT PROMISES SOMETHING IS A TEST WITH THE WRONG SYNTAX. For each guarantee the diff states in',
  'prose — "X can never happen", "this refuses Y", "the caller cannot Z" — find the test that defends it. When',
  'you have tools and can act on the diff, BREAK the guarded line and confirm a NAMED test reddens. When you',
  'have NO tools (a tool-free juror), you cannot break anything — name the test you believe SHOULD defend it,',
  'say plainly that you could not verify by mutation, and never claim a mutation result you did not produce. A',
  'guarantee no test defends is a COVERAGE finding, not a prose one, and it is worth raising even unverified:',
  'prose is the only thing in a diff that nothing checks. Watch',
  'DEFAULTS in particular — a default value quietly satisfying a check written for the explicit value is the',
  'single most common shape here.',
  // #4418 — RISKS-TO-TEST-PLAN TRACEABILITY. The same coverage question, asked of a backlog card's own prose.
  'When the material you were given contains a backlog card with a Risks section and a Test plan section (each',
  'under a heading or a bold label), enumerate each explicit behavioral constraint in its Risks and find the',
  'matching Test plan entry: the repository-qualified test file, the named test case, and the observable assertion',
  'that pins the constraint. A generic "unit-test the reader" does not satisfy it. For a bounded read the',
  'assertion must be on the bytes read or the read range, not merely a successful parse; for isolated degradation',
  'it must show unrelated fields stay available after a failure. An absent mapping is a COVERAGE finding. In a',
  'preparation review accept a concrete PLANNED test (name it as planned), not one already implemented; in an',
  'implementation review inspect the actual test when you can. If the Risks or Test plan section is absent from',
  'the material you were given, report that limitation and do not invent missing coverage. With no tools, label',
  'the mapping unverified, as above.',
].join(' ');

/**
 * #3094 — THE MUTATION PROBE. What separates a finding that is real from one that merely reads well: break the
 * line and watch whether a NAMED test goes red. Every review in the session that motivated this card found its
 * defects that way ("I broke this line and nothing reddened"), and none of them were asked to — which is the
 * argument for it being UNCONDITIONAL in {@link buildPanelMandate} rather than a flag a caller sets. An
 * instruction that must be remembered per-call is one that gets forgotten, and this is the one that has paid.
 *
 * IT IS SCOPED BY ITS OWN WORDING, NOT BY A LENS BRANCH. The ruling's whole point: a `simplicity` or style
 * finding changes no behaviour, so there is nothing to break and the sentence is inapplicable on its face. That
 * is cheaper and safer than branching on the lens — a branch has to guess which lens produces which class of
 * finding, and a `simplicity` juror can perfectly well report a behaviour defect it happened to see.
 *
 * DISTINCT FROM {@link GUARANTEE_NEEDS_A_TEST_RULE}, which mutates to check ONE narrow class: a guarantee the
 * diff states in PROSE. This asks the same question of any behaviour finding, whatever prompted it.
 *
 * #3158 (x27e4xs) — ALSO SCOPED BY ITS OWN WORDING, NOW ON TRANSPORT. A `judgePanel` seat is always
 * `--tools ''` (`we:scripts/lib/judge-panel.mjs` forwards no `allowedTools` — see that module's RULING),
 * so the old unconditional "BREAK the line" instruction told a tool-free juror to do something it
 * structurally cannot. The ruling there is panel seats STAY tool-free (the N-seats-need-N-lanes cost of a
 * tool-bearing panel is not paid); the fix here is the SAME pattern as the UNCONDITIONAL ruling above — the
 * text branches on whether the juror has tools rather than a caller passing a flag, because
 * `skills-src/jury/panel-fanout.mjs` already tells a tool-free juror that fact about itself. A tool-bearing
 * juror (a future transport, or a caller reading its own `allowedTools`) still gets the literal instruction;
 * a tool-free one is told to name the test it BELIEVES would redden and say plainly it could not run anything
 * — never to fabricate a result it did not produce. `we:skills-src/drain/SKILL.md`'s panel-review section
 * documents which finding classes a tool-free panel can and cannot reach.
 *
 * Exported so a caller building another transport can assert its presence rather than paraphrasing it, and so a
 * test can pin that it is the only thing #3094 added to the mandate when no `aim` is passed.
 */
export const MUTATION_PROBE_RULE = [
  'MUTATION PROBE — FOR BEHAVIOUR FINDINGS. If you report a defect that affects correctness or changes',
  'behaviour: when you have tools and can act on the diff, BREAK the line you say is wrong or unguarded and',
  'state, in the finding, whether a NAMED test reddens — name the test if one does, and say plainly that NO',
  'named test reddens if none does. When you have NO tools (a tool-free juror), you cannot run this probe —',
  'say so explicitly, name the test you believe WOULD need to redden if the defect is real, and never claim',
  'to have broken or run anything you did not. "No test catches this" — or "I have no tools to check" — is',
  'itself a finding worth reporting; an assertion of a defect with no mutation result behind it is weaker than',
  'one with it. This does NOT apply to a finding that changes no behaviour — pure style, naming, wording,',
  'simplicity — where there is nothing to break: say nothing about mutation for those.',
].join(' ');

export const PROSE_IMPRECISION_RULE = [
  'PROSE IMPRECISION IS NON-BLOCKING. Wording, framing, and claims about history or significance are worth a',
  'NOTE, never a change-request, unless the imprecision would cause a wrong ACTION — a maintainer editing the',
  'wrong thing, trusting a guarantee that does not hold, or building against a premise that is false. Bounce',
  'on behaviour. Measured cost of the alternative: PRs in this repo have taken three and four review rounds on',
  'significance framing while the code was correct throughout.',
].join(' ');

/**
 * Build the canonical judge-only mandate text handed to a review subagent (the "read a diff, judge it"
 * instructions) — single-sourced so `/code-review`-shaped callers and the drain auto-review (`#2326`) stop
 * hand-rolling their own prose copy of the same mandate. Pure — returns the instruction string; SPAWNING the
 * subagent and reading its answer remains the caller's action (this module never calls a model, same split
 * `we:scripts/lane-review.mjs` documents for the pre-PR review seam).
 * @param {{contextIsolation?: string, mandate?: string|string[], goal?: string, round?: number,
 *   fenced?: boolean}} [o] - #2950: `goal` is what the diff is trying to do (judged against that and the base,
 *   never an ideal); `round` ≥ 2 fires the anti-spiral clause. Both additive — omitted, the text is what it was
 *   before #2950. #2967: `fenced` puts the goal inside the #2438 labelled data fence; pass it whenever the goal
 *   is caller-supplied text (a PR title). It is NOT the only untrusted path in: `contextIsolation` is
 *   interpolated straight into instruction position below and is fence-exempt on the grounds that it names an
 *   isolation MODE — a closedness no code enforces (PR #1235 review, finding 7). No caller passes a non-default
 *   today, so that is a stated gap in the allow-list's rationale, not a live hole.
 * @returns {string}
 */
export function buildMandate({ contextIsolation = 'diff-only', mandate = DEFAULT_MANDATE, goal = '', round = 1, fenced = false } = {}) {
  const isolationLine = contextIsolation === 'diff-only'
    ? 'You see ONLY the diff (and, if supplied, the PR description) — no author framing, no prior session context.'
    : `Context isolation: ${contextIsolation}.`;
  // #2656 — the subject-neutral mandate SKELETON (mandate line + judge-only closing) lives once in jury-core's
  // `buildSubjectMandate`; this PR-diff adapter supplies the diff-specific parts — the `diff` subject noun, the
  // isolation line, the `file` finding anchor, and the #2336 no-checkout body. The output is byte-identical to the
  // prior inline form. #2336: a review subagent runs inside the drain's shared primary checkout, so it must NEVER
  // `git checkout` the PR branch there (that moves the shared HEAD and violates the never-branch-a-shared-checkout guard).
  return buildSubjectMandate({
    subjectNoun: 'diff',
    mandate,
    defaultMandate: DEFAULT_MANDATE,
    isolationLine,
    findingAnchor: 'file',
    // #2950 — the goal the diff serves and which negotiation round this is. Both pass straight through: the
    // skeleton owns the wording (the goal block, the three direction tests, the round-2+ anti-spiral clause) so
    // every subject asks the same questions. Omitted `goal` + round 1 leaves the text as it was before #2950.
    goal,
    round,
    fenced,
    bodyLines: [
      'Work from the diff text alone — do NOT `git checkout`, `git switch`, `git fetch`+checkout, or otherwise',
      'move HEAD onto the PR branch: you are running inside a shared checkout and that would derail the drain. If',
      'you have tools and genuinely must run the code (tests, a repro), do it in a throwaway `git clone` under a',
      'temp dir, never here. If you have no tools at all, you cannot run or clone anything — say so plainly',
      'rather than describing verification you did not perform.',
      PROSE_IMPRECISION_RULE,
      GUARANTEE_NEEDS_A_TEST_RULE,
    ],
  });
}

/**
 * The DEFAULT write-target clause for `buildEditorMandate` — the PR-branch transport's isolation rule (#2336:
 * never move HEAD in the drain's shared tree). Exported so a transport can assert it is ABSENT from a mandate
 * built for a different write target: a `toContain` assertion can never tell a prohibition from a command, so
 * the only way to prove "this editor was NOT told to clone-and-push" is to check for this text's absence.
 */
export const EDITOR_WRITE_TARGET_PR_CLONE = [
  'Do your writing in an ISOLATED THROWAWAY CLONE of the PR branch, never in the drain\'s shared checkout',
  '(the #2336 never-move-shared-HEAD constraint applies to you too) — commit there and push back to the SAME',
  'PR branch so this PR updates in place rather than a new one being opened.',
].join(' ');

/**
 * Build the canonical mandate handed to the EDITOR subagent in the v2 negotiation loop (#2311) — the
 * counterpart to `buildMandate()` (which seeds the reviewer). Same diff-only, no-checkout isolation and the
 * same #2336 constraint (never move HEAD in the shared tree — the editor does its writing in an isolated
 * throwaway clone of the PR branch, then pushes back to that SAME branch so the existing PR is what updates,
 * not a new one). The editor sees the reviewer's findings from the round that just ran and must either fix
 * each one or explicitly dismiss it with a stated reason (the same dismissedFindings audit-trail shape used
 * elsewhere in this repo) — it may not silently drop a finding.
 *
 * `writeTarget` PARAMETERIZES the isolation clause (PR #1064 review, blocker 3). The transport that owns WHERE
 * a revision is written must supply exactly ONE write-target instruction; a caller that appended its own on top
 * of the hardcoded PR-clone clause handed the editor two contradictory orders (clone-and-push vs. edit-in-place,
 * never-push) on the normal path. Defaults to `EDITOR_WRITE_TARGET_PR_CLONE`, so every existing caller is
 * byte-for-byte unchanged.
 *
 * `fenced` routes the FINDING LIST through the #2438 labeled data fence (`fenceUntrusted` + `FENCED_DATA_RULE`).
 * Finding text is juror prose about untrusted material, interpolated verbatim into a prompt handed to an agent
 * with write tools — exactly the splice the fence exists for. Opt-in (default `false`) so shipped callers keep
 * their current text; a new transport passes `true`.
 *
 * @param {{findings?: Array<object>, round?: number, roundCap?: number, writeTarget?: string, fenced?: boolean}} [o]
 * @returns {string}
 */
export function buildEditorMandate({
  findings = [],
  round = 1,
  roundCap = NEGOTIATION_ROUND_CAP,
  writeTarget = EDITOR_WRITE_TARGET_PR_CLONE,
  fenced = false,
} = {}) {
  const list = normalizeFindings(findings);
  const findingLines = list.length
    ? list.map((f, i) => `  ${i + 1}. ${f.file ? `${f.file}: ` : ''}${f.summary}${f.failure_scenario ? ` — ${f.failure_scenario}` : ''}`).join('\n')
    : '  (none — the reviewer reported no findings; this mandate should not be built in that case)';
  return [
    `You are the EDITOR in round ${round}/${roundCap} of a bounded editor↔reviewer negotiation over a PR diff.`,
    ...(fenced ? [FENCED_DATA_RULE] : []),
    'A reviewer subagent (independent of you and of the PR\'s original author) reported these findings:',
    fenced ? fenceUntrusted('findings', findingLines) : findingLines,
    'Revise the diff to address each finding: either fix it, or if you judge it not a real problem, state your',
    'dismissal reason explicitly in your reply (never drop a finding silently — it becomes the audit trail).',
    ...(writeTarget ? [writeTarget] : []),
    'A fresh-context reviewer will re-review your revised diff next round; you will not see their internal',
    'reasoning, only their next findings list (or acceptance).',
  ].join(' ');
}

/**
 * #2438 (slice A of epic #2410) — the PLAN-PHASE handshake that runs BEFORE any diff exists. Epic #2410
 * extends the shipped editor↔reviewer diff loop (#2311/#2310, above) with a co-negotiation step ahead of it:
 * two peer agents agree on the FIX APPROACH first, so negotiation rounds aren't burned revising a diff aimed
 * at the wrong target. This is the plan-phase counterpart to `buildEditorMandate`/`deriveNegotiationOutcome`
 * — same diff-only-round-cap shape, but judging a PROSE APPROACH instead of a diff, and with its own (tighter)
 * round cap: agreeing on an approach is cheaper than converging a diff, so non-convergence should surface to a
 * human sooner rather than burning the full `NEGOTIATION_ROUND_CAP` budget the diff loop gets.
 */
export const PLAN_ROUND_CAP = 2;

/** The three plan-handshake outcomes `derivePlanOutcome()` can return (#2438) — the plan-phase analogue of
 *  `NEGOTIATION_OUTCOMES`: `agreed` replaces `land` (there is no diff yet to land, only an approach to proceed
 *  from into the code-writing phase). */
export const PLAN_OUTCOMES = Object.freeze({
  CONTINUE: 'continue',
  AGREED: 'agreed',
  ESCALATE: 'escalate',
});

// #2438's labelled data fence — `FENCED_DATA_RULE` + `fenceUntrusted` — moved to the leaf
// `mandate-fence.mjs` (#2967) so `jury-core.mjs`'s subject-neutral skeleton can reach it without a cycle
// (review-core imports jury-core). RE-EXPORTED here, so every existing importer is unchanged.

/**
 * Build the mandate handed to the PROPOSING peer in round `round` of the plan handshake (#2438) — state a fix
 * approach in PROSE ONLY, no code, no diff. Round 1 states the task fresh; round > 1 also carries the
 * critiquing peer's concerns from the prior round so the proposer revises the approach rather than repeating
 * it verbatim. Same diff-only spirit as `buildMandate`, but the isolation constraint here is stronger: the
 * proposer must not write or paste code at all in this phase — code only starts once `derivePlanOutcome`
 * returns `agreed`. The task text and prior-round concern summaries are UNTRUSTED — they travel inside
 * labeled data fences (`fenceUntrusted` + `FENCED_DATA_RULE`), never inline in instruction position.
 * @param {{task?: string, concerns?: Array<object>, round?: number, roundCap?: number}} [o]
 * @returns {string}
 */
export function buildPlanMandate({ task = '', concerns = [], round = 1, roundCap = PLAN_ROUND_CAP } = {}) {
  const concernList = normalizeFindings(concerns);
  const concernLines = concernList.length
    ? concernList.map((c, i) => `  ${i + 1}. ${c.file ? `${c.file}: ` : ''}${c.summary}${c.failure_scenario ? ` — ${c.failure_scenario}` : ''}`).join('\n')
    : null;
  const lines = [
    `You are the PROPOSER in round ${round}/${roundCap} of a plan handshake: state a fix APPROACH, in prose and`,
    'BEFORE any code is written, for the task quoted in the <task> block below.',
    FENCED_DATA_RULE,
    fenceUntrusted('task', task || '(task not supplied)'),
    'Describe WHAT you will change and WHY, and the root cause it targets — no diff, no code, no file edits yet.',
  ];
  if (concernLines) {
    lines.push(
      'A peer reviewer raised the concerns quoted in the <concerns> block below about your PRIOR proposed',
      'approach — revise your approach to address each one (or state your reasoned disagreement) rather than',
      'repeating the same approach verbatim:',
      fenceUntrusted('concerns', concernLines),
    );
  }
  lines.push(
    'A fresh-context peer will judge this approach next (accept it, or push back with concerns) — you will not',
    'see their internal reasoning, only their verdict and any concerns they raise.',
  );
  return lines.join('\n');
}

/**
 * Build the mandate handed to the CRITIQUING peer in the plan handshake (#2438) — an INDEPENDENT peer (never
 * the proposer) judges whether the proposed approach targets the right root cause and is complete enough to
 * implement, WITHOUT writing any code itself. Mirrors `buildEditorMandate`'s reviewer-facing half, but for a
 * prose approach instead of a diff. The proposer's approach is UNTRUSTED (it is exactly the text an injection
 * would ride in on to steer this trust-gating verdict) — it travels inside a labeled data fence
 * (`fenceUntrusted` + `FENCED_DATA_RULE`), never inline in instruction position.
 * @param {{approach?: string, round?: number, roundCap?: number}} [o]
 * @returns {string}
 */
export function buildPlanCritiqueMandate({ approach = '', round = 1, roundCap = PLAN_ROUND_CAP } = {}) {
  return [
    `You are the CRITIC in round ${round}/${roundCap} of a plan handshake, independent of the peer who proposed`,
    'the fix approach quoted in the <approach> block below.',
    FENCED_DATA_RULE,
    fenceUntrusted('approach', approach || '(approach not supplied)'),
    'Judge ONLY whether the approach targets the right root cause and is complete enough to implement —',
    'do NOT write code or a diff yourself at this phase; that starts only once an approach is agreed.',
    'Report concrete concerns (what\'s wrong with the approach, what it would miss) in the same finding shape',
    '(summary, failure_scenario) used elsewhere in this module, or report none if the approach is sound — do',
    'not pad acceptance with stylistic nitpicks about an approach you\'d have written differently.',
  ].join('\n');
}

/**
 * Derive what the #2438 plan handshake does next after a critique round. Pure — the plan-phase analogue of
 * `deriveNegotiationOutcome`, same shape, reused verdict vocabulary (`VERDICTS`: the critic's verdict over the
 * proposed approach, derived via the same `deriveVerdict` every reviewer uses):
 *
 *   - `needs-human` → `escalate`, ALWAYS (peers fundamentally can't agree on direction — no round budget
 *     resolves that; escalating from the plan phase is cheaper than burning code-writing rounds on it).
 *   - `prevention-outstanding` (#2823) → `escalate`, immediately — the SAME call `deriveNegotiationOutcome` makes,
 *     for the same reason: every finding is already resolved, so no plan-loop actor files the guard or flips
 *     `preventionCaptured`. `continue`-ing would re-derive the identical verdict every round until `PLAN_ROUND_CAP`
 *     and then escalate as approach non-convergence — burning the budget on a state the loop cannot close — instead
 *     of handing STRAIGHT to the operator who files the named guard(s). (This was the round-3 enum-totality miss:
 *     the member fell through to the `changes` round-cap path below and looped.)
 *   - `accept` → `agreed` (the approach is settled; the code-writing phase — the existing editor↔reviewer
 *     diff loop — starts from here).
 *   - `changes` and `round < roundCap` → `continue` (the critic's concerns feed `buildPlanMandate`'s next round).
 *   - `changes` and `round >= roundCap` → `escalate` (non-convergence on the APPROACH itself).
 *
 * @verdicts-total fallthrough=changes — `changes` is the intentional final fall-through (the round-cap path); every
 *   OTHER `VERDICTS` member is handled explicitly. The `check:standards` verdict-totality gate enforces this, so a
 *   new enum member can never again silently ride the `changes` fall-through (the round-3 defect this fixed).
 * @param {{verdict: 'accept'|'changes'|'needs-human'|'prevention-outstanding', round: number, roundCap?: number}} o
 * @returns {'continue'|'agreed'|'escalate'}
 */
export function derivePlanOutcome({ verdict, round, roundCap = PLAN_ROUND_CAP }) {
  if (verdict === VERDICTS.NEEDS_HUMAN) return PLAN_OUTCOMES.ESCALATE;
  // #2823 — prevention-outstanding is NOT a negotiable `changes`: every finding is resolved, so no plan round can
  // close it and no loop actor files the guard. Escalate immediately to the operator (mirrors deriveNegotiationOutcome).
  if (verdict === VERDICTS.PREVENTION_OUTSTANDING) return PLAN_OUTCOMES.ESCALATE;
  if (verdict === VERDICTS.ACCEPT) return PLAN_OUTCOMES.AGREED;
  return round < roundCap ? PLAN_OUTCOMES.CONTINUE : PLAN_OUTCOMES.ESCALATE;
}

/** The two things a review surface can DO about an escalated PR (#2285, sibling #2326). This is the ONE place
 *  the "run the fix/review convergence" vs "hand straight to a human" branch lives — lifted out of the drain's
 *  prose so every review consumer (drain, /review, /merge) shares it, keyed on WHY the PR needs attention. */
export const REVIEW_DISPOSITIONS = Object.freeze({
  CONVERGE: 'converge', // run the panel↔editor negotiation loop to fix the diff
  HUMAN: 'human',       // hand straight to a human — no (further) convergence
});

/**
 * The escalation-reason vocabulary the disposition is keyed on (#2285). Two families:
 *   • SENSITIVITY reasons — a rule fired at classification time, BEFORE any review deadlock. An agent
 *     reviewer/editor is still independent and useful, so these CONVERGE. `gate-self` (the DECLARATIVE LEASH of
 *     the trust chain, #2285 narrowed by #2771/#2785) and `statute` (a governance rule, #2412) converge too,
 *     but as an ADVISORY fix that never auto-lands — a human gates the merge. Every other sensitivity reason
 *     auto-lands on a converged verdict: the engine-tier lander via `blast-radius` (the #2445 two-tier flip) and
 *     policy-tier derivation CODE via `gate-derivation` (#2771 Fork A).
 *   • DEADLOCK reasons — the panel↔editor loop ALREADY ran and could not agree. Re-converging just repeats the
 *     deadlock, so these go straight to a HUMAN.
 * These are the BARE (canonical) tokens; they are the un-decorated form of `scoreEscalation`'s fired signals
 * (`we:scripts/lib/review-escalation.mjs`, e.g. `blast-radius (…)`, `size (1080 ≥ 400 changed lines)`) — which
 * `deriveReviewDisposition` canonicalizes back to these via `canonicalizeReason` — plus the two escalating
 * negotiation outcomes (round-cap non-convergence, mandate conflict).
 */
export const REVIEW_REASONS = Object.freeze({
  // sensitivity (pre-review) — converge
  GATE_SELF: 'gate-self',              // the DECLARATIVE LEASH (contract / roster / suites) — human (#2771/#2785)
  GATE_DERIVATION: 'gate-derivation',  // policy-tier derivation CODE — independent committee (#2771 Fork A)
  STATUTE: 'statute',
  PERMISSION_CHANGE: 'permission-change', // workflow permissions / sandbox grant / branch-protection config - human (2026-10-08)
  BLAST_RADIUS: 'blast-radius',
  SIZE: 'size',
  DISMISSED_FINDINGS: 'dismissed-findings',
  CROSS_REPO: 'cross-repo',
  // deadlock (post-review) — human
  NON_CONVERGENCE: 'non-convergence',
  MANDATE_CONFLICT: 'mandate-conflict',
});

// The reason FAMILIES + which sensitivity reasons need a human are DATA — they live in the machine-diffable
// contract (`./review-policy.contract.json`, #2566) and are imported here so the classification exists exactly
// once. `REVIEW_REASONS` above stays the code-level token VOCABULARY (the identifiers other files import by
// name); the conformance suite (`__tests__/review-policy.conformance.test.mjs`) proves the two never drift.
const DEADLOCK_REASONS = POLICY_REASONS_BY_FAMILY.deadlock;
/** The sensitivity reasons that STILL require a human to clear (the panel may advise/fix, but never auto-lands):
 *  `gate-self` (an agent policing its own leash — #2285) and `statute` (a governance rule a human must ratify —
 *  #2412). The #2445 two-tier flip keeps these two human while the lander (engine tier) becomes agent-clearable.
 *  Derived from the contract (clearance:human ∧ family:sensitivity). */
const HUMAN_SENSITIVITY_REASONS = POLICY_HUMAN_SENSITIVITY_REASONS;

/**
 * Every IMPLEMENTED reason token (both families) — the canonical vocabulary a decorated reason string is matched
 * against. This MUST be the implemented set, never `POLICY_DECLARED_REASON_TOKENS`: a `todo` (declared-but-unbuilt)
 * token is absent from `POLICY_REASONS_BY_FAMILY` and `HUMAN_SENSITIVITY_REASONS`, so canonicalizing one would drop
 * it through both precedence branches below to the permissive `{ converge, autoLand: true }` default — an unbuilt,
 * human-review-shaped reason silently auto-landing. Matching against the implemented set instead leaves it
 * unrecognized, and `deriveReviewDisposition` throws (#xonzpym). The conformance suite pins this binding at source
 * level ("the canonicalization vocabulary binding") precisely because the swap is otherwise invisible to it.
 */
const ALL_REASON_TOKENS = POLICY_IMPLEMENTED_REASON_TOKENS;

/**
 * Canonicalize ONE raw reason string to its bare `REVIEW_REASONS` token, or `null` if unrecognized. Pure.
 * The drain carries DECORATED reasons (from `scoreEscalation`, `we:scripts/lib/review-escalation.mjs`) —
 * `blast-radius (a.mjs, b.mjs)`, `gate-self (…) — human review required`, `size (1080 ≥ 400 changed lines)`,
 * `dismissed-findings (…)`, `cross-repo impl+WE couple` — each of which BEGINS with
 * its bare token followed by a boundary (a space or `(`). A bare token (e.g. `'gate-self'`) matches exactly too.
 * Matches the LONGEST token prefix so that, should two tokens ever both prefix a string (none do today), the more
 * specific one wins rather than an arbitrary order. The boundary check keeps a token from matching a longer word
 * that merely starts with it (e.g. a hypothetical `sizeable` never reads as `size`).
 *
 * EXPORTED with the vocabulary INJECTABLE (#xonzpym) — production always uses the default (`ALL_REASON_TOKENS`,
 * the implemented set). The parameter exists so the conformance suite can run the REAL matcher over BOTH
 * vocabularies against a contract that really carries a `todo` entry, and prove the declared set resolves an
 * unbuilt token that the implemented set correctly refuses. Mirroring this matcher in the test instead would let
 * the mirror drift; injecting it cannot.
 * @param {string} raw
 * @param {readonly string[]} [vocabulary] the token set to match against; defaults to the IMPLEMENTED set.
 * @returns {string|null} the bare token, or null if no known token prefixes it at a boundary.
 */
export function canonicalizeReason(raw, vocabulary = ALL_REASON_TOKENS) {
  const s = String(raw).trim();
  const matches = [...vocabulary]
    .filter((tok) => s === tok || (s.startsWith(tok) && /^[\s(]/.test(s.slice(tok.length))))
    .sort((a, b) => b.length - a.length);
  return matches[0] ?? null;
}

/**
 * The ONE error `deriveReviewDisposition` throws for a genuinely unrecognized reason token (#3495). A dedicated
 * type — not a message match — so a caller that must tell "this reason is not in the vocabulary" apart from any
 * OTHER failure (a future precondition check, an internal bug) can `instanceof` it instead of collapsing every
 * throw into the same reading. The message is unchanged (`deriveReviewDisposition: unknown reason(s): …`), so a
 * caller that only matches the text keeps working. `unknownReasons` carries the offending raw strings.
 */
export class UnknownReasonError extends Error {
  /** @param {string[]} unknownReasons the raw reason strings that canonicalized to no known token. */
  constructor(unknownReasons) {
    super(`deriveReviewDisposition: unknown reason(s): ${unknownReasons.join(', ')}`);
    this.name = 'UnknownReasonError';
    this.unknownReasons = unknownReasons;
  }
}

/**
 * Derive what a review surface DOES about an escalated PR, from the reason(s) it escalated for (#2285). Pure,
 * exhaustive over REVIEW_REASONS, strictest-reason-wins when several apply. Returns `{ mode, autoLand }`:
 *   • mode: `converge` → run the panel↔editor negotiation loop; `human` → hand to a human, do not converge.
 *   • autoLand: may an AGENT land the PR on an accept verdict? `false` = a human gates the merge regardless — the
 *     single enforcement point for the #2285 conflict-of-interest invariant (a trust-chain edit is human-cleared
 *     only; the panel may FIX it but never CLEAR it).
 *
 * Precedence (most restrictive first):
 *   1. any DEADLOCK reason → `{ human, autoLand:false }` — the loop already failed to converge; a human decides.
 *   2. `gate-self` or `statute` → `{ converge, autoLand:false }` — converge to fix (advisory), but a human gates
 *      merge (an agent policing its own leash, or a governance rule a human must ratify — the #2445 two-tier flip
 *      keeps ONLY these two sensitivity classes human; the lander, engine tier, falls to case 3).
 *   3. any other sensitivity reason → `{ converge, autoLand:true }` — agent-reviewable: a converged verdict lands.
 *
 * Accepts EITHER bare `REVIEW_REASONS` tokens (`'gate-self'`, `'blast-radius'`, …) OR the DECORATED reason
 * strings `scoreEscalation` (`we:scripts/lib/review-escalation.mjs`) actually emits and the drain carries in its
 * `parked` JSON verbatim (`blast-radius (a.mjs, …)`, `gate-self (…) — human review required`,
 * `size (1080 ≥ 400 changed lines)`, `dismissed-findings (…)`, `cross-repo impl+WE couple`) — each is
 * canonicalized to its bare token via `canonicalizeReason` before the
 * precedence check, so `deriveReviewDisposition({ reasons })` works when handed the parked array as-is. Still
 * throws `UnknownReasonError` (`unknown reason(s)`) on a genuinely unrecognized reason and a plain `Error`
 * (`at least one reason`) on empty input.
 *
 * @param {{reason?: string, reasons?: string[]}} o - one reason, or several (several ⇒ strictest wins); each may
 *   be a bare token OR a decorated `scoreEscalation` reason string.
 * @returns {{mode: 'converge'|'human', autoLand: boolean}}
 */
export function deriveReviewDisposition({ reason, reasons } = {}) {
  const raw = (Array.isArray(reasons) ? reasons : reason ? [reason] : []).filter(Boolean);
  if (!raw.length) throw new Error('deriveReviewDisposition: at least one reason is required');
  const canon = raw.map((r) => ({ raw: r, token: canonicalizeReason(r) }));
  const unknown = canon.filter((c) => c.token == null).map((c) => c.raw);
  if (unknown.length) throw new UnknownReasonError(unknown);
  const list = canon.map((c) => c.token);
  if (list.some((r) => DEADLOCK_REASONS.includes(r))) return { mode: REVIEW_DISPOSITIONS.HUMAN, autoLand: false };
  if (list.some((r) => HUMAN_SENSITIVITY_REASONS.includes(r))) return { mode: REVIEW_DISPOSITIONS.CONVERGE, autoLand: false };
  return { mode: REVIEW_DISPOSITIONS.CONVERGE, autoLand: true };
}

/**
 * #2567 — the BRIDGE from the drain's escalation REASONS to the advisory care-level. A parked PR carries only its
 * DECORATED reason strings (the `## Escalation reason` body block, `scoreEscalation`'s reasons) — not the raw
 * `signals` object `deriveCareLevel` reads — so a consumer that has reasons (the review-parked-prs workflow, the
 * future scheduled runner) needs this to recover the care-level deterministically. Pure. Canonicalizes each
 * reason (same `canonicalizeReason` the disposition uses), maps the recognized tokens back to a signals-presence
 * object (magnitude parsed where the decorated string carries it — the dismissed-findings count), and runs the
 * single-sourced `deriveCareLevel`. LENIENT by design: an unrecognized reason contributes nothing rather than
 * throwing (the care-level is an advisory dial — it must never crash the panel). A deadlock or a human-sensitivity
 * reason (gate-self / statute) maps to `humanRequired` → maximum care.
 * @param {string[]} reasons - the decorated escalation reason strings (or bare tokens).
 * @returns {'none'|'low'|'elevated'|'high'}
 */
export function careLevelFromReasons(reasons) {
  const raw = (Array.isArray(reasons) ? reasons : reasons ? [reasons] : []).filter(Boolean);
  const signals = {};
  let humanRequired = false;
  for (const r of raw) {
    const token = canonicalizeReason(r);
    switch (token) {
      case REVIEW_REASONS.BLAST_RADIUS: signals.blastRadius = true; break;
      case REVIEW_REASONS.SIZE: signals.size = 1; break;
      case REVIEW_REASONS.DISMISSED_FINDINGS: {
        const m = /\((\d+)/.exec(String(r));           // "dismissed-findings (3 …)" → 3; unparseable → 1
        signals.dismissedFindings = m ? Number(m[1]) : 1;
        break;
      }
      case REVIEW_REASONS.CROSS_REPO: signals.crossRepo = true; break;
      // #2771/#2785 — the narrowed class is agent-clearable, so it must NOT set humanRequired; but it is a
      // system-machinery change, so it must still earn a real panel. Mapping it onto the blast-radius weight
      // lands it at `elevated` on its own, never at `none` — a reasons-only consumer that saw just
      // `gate-derivation` would otherwise derive a ZERO-juror, ZERO-round rigor and the "independent committee"
      // the ruling routes it to would not exist.
      case REVIEW_REASONS.GATE_DERIVATION:
        signals.blastRadius = true; break;
      case REVIEW_REASONS.GATE_SELF:
      case REVIEW_REASONS.STATUTE:
      case REVIEW_REASONS.PERMISSION_CHANGE:
      case REVIEW_REASONS.NON_CONVERGENCE:
      case REVIEW_REASONS.MANDATE_CONFLICT:
        humanRequired = true; break;                    // human-gated or deadlocked → maximum care
      default: break;                                   // unrecognized → contributes nothing (lenient)
    }
  }
  return deriveCareLevel({ signals, humanRequired });
}

/**
 * #2567 — the panel RIGOR for a set of escalation reasons: `careLevelFromReasons` → `panelRigorForCareLevel`, in
 * one call for the reasons-holding consumer. Pure. (`panelRigorForCareLevel` is imported from jury-core.mjs
 * — the subject-agnostic care→rigor dial — and re-exported above; `careLevelFromReasons` stays here as the
 * drain-reasons→care-level bridge.)
 * @param {string[]} reasons
 * @returns {{careLevel: string, rounds: number, lenses: string[], jurorsPerLens: number, aggregation: string}}
 */
export function panelRigorFromReasons(reasons) {
  return panelRigorForCareLevel(careLevelFromReasons(reasons));
}

/**
 * #2908 — the EDITOR POLICY for a set of escalation reasons: `careLevelFromReasons` → `editorPolicyForCareLevel`,
 * in one call for the reasons-holding consumer (the parked-PR convergence loop, via `review-core-cli rigor`).
 * Pure. The band is resolved ONCE, here, and both the panel dial and the editor gate read that same value — a
 * second derivation would be a second thing to drift.
 *
 * AN EMPTY REASON LIST IS `unresolved`, NOT `none`. This is the fail-closed clause, and it is the whole point of
 * having a bridge rather than calling `editorPolicyForCareLevel(careLevelFromReasons(r))` inline.
 *
 * WHY `[]` CANNOT BE READ AS "no signals fired". `[]` has TWO producers and they are indistinguishable from here:
 *   1. a DEGRADED read — the reason list reaches the loop through a fetch agent, and a bad read yields `[]`; and
 *   2. a genuinely REASON-LESS parked PR — `pr-land.mjs --park=review:pending` (#2622) applies the review label
 *      AT OPEN and writes no `## Escalation reason` block at all (the block is appended only on the separate
 *      `scoreEscalation` verdict path, and `buildEscalationReasonBlock([])` returns `''`).
 * So "a parked PR always has a reason" is FALSE, and no version of this function can tell the two apart. Reading
 * `[]` as `none` (score 0) would look tidy and would be exactly the fail-open: a statute PR whose reason read
 * flaked would present as the weakest band. Before #2908 that was harmless by accident, because the weakest
 * band's 1-round cap made the editor unreachable anyway; giving an editor-enabled band its 2-round floor removes
 * that accidental protection, so the clause has to be explicit.
 *
 * THE CONSEQUENCE, STATED PLAINLY: a `--park=review:pending` PR opened with no reason block is now permanently
 * REVIEW-ONLY. Its panel still runs and its findings still reach the operator — it simply escalates to
 * `review:human` instead of ever being machine-edited. That cost is accepted deliberately: the alternative reads
 * a broken fetch as a safe diff.
 *
 * @param {string[]} reasons - the drain's escalation reasons for this PR.
 * @returns {{careLevel: string|null, resolved: boolean, editorEnabled: boolean, rounds: number, reason: string}}
 */
export function editorPolicyFromReasons(reasons) {
  const raw = (Array.isArray(reasons) ? reasons : reasons ? [reasons] : []).filter(Boolean);
  if (!raw.length) return editorPolicyForCareLevel(null); // fail closed — see above
  return editorPolicyForCareLevel(careLevelFromReasons(raw));
}

/**
 * ============================================================================
 * THE EDITOR-GATE LOOP GUARDS (#2908, PR #1106 review) — the SPEC the sandbox loop enforces from its OWN state.
 * ============================================================================
 *
 * Same shape, and same reason, as the juror-invite guards further down: the parked-PR loop
 * (`we:scripts/workflows/review-parked-prs.mjs`) runs every derivation inside an AGENT and cannot `import` this
 * module, so what it holds is an ECHO. `editorPolicyFromReasons` above is the derivation; these two are the
 * guards that make the echo incapable of GRANTING. They live here (tested) and are MIRRORED inline in the loop.
 *
 * The rule both encode: the editor gate is an AND of things the loop can check itself. An agent may always turn
 * the editor OFF; nothing an agent says can turn it ON.
 */

/**
 * The canonical escalation-reason tokens that can reach an editor-enabled band — and they only reach it ALONE
 * (#2908, PR #1106 review F1). Exhaustive, and verified against `careLevelFromReasons`: `size` → `low` and
 * `cross-repo` → `low`; every other token bands at `elevated` or above on its own, and `size` + `cross-repo`
 * together score 2 + 2 = 4, which is `elevated`. So "the editor may push" is expressible as a property of the
 * reason list alone, with no care band in it.
 */
export const EDITOR_ENABLED_REASON_TOKENS = Object.freeze([REVIEW_REASONS.SIZE, REVIEW_REASONS.CROSS_REPO]);

/**
 * #2908 (PR #1106 review, F1) — may the editor push, judged from the ESCALATION REASONS ALONE? Pure.
 *
 * WHY THIS EXISTS ON TOP OF `editorPolicyFromReasons`. In the loop the care BAND arrives as an agent echo: the
 * rigor agent shells `review-core-cli rigor` and reports back a `careLevel` string. The loop re-derives
 * `editorEnabled` from the allow-list, but it re-derives it against THAT echoed band — so a rigor agent that
 * reports `{careLevel:'low'}` on a PR parked for `blast-radius` opens the editor at what is really `elevated`.
 * "An agent's `editorEnabled` can only veto" was true; "an agent echo can never enable" was not. The loop DOES
 * hold the reason list locally, so this is the half of the derivation it can check for itself.
 *
 * STRICTER THAN THE SHARED DIAL, DELIBERATELY. `careLevelFromReasons` is LENIENT with an unrecognized reason (it
 * contributes nothing) because it is advisory — it sizes a panel. This authorizes a WRITE to someone else's
 * branch, so a reason token we cannot weigh is a signal we cannot rule out: it returns `false`. The gate can
 * therefore only ever be narrower than the band, never wider.
 *
 * @param {string[]} reasons - the drain's escalation reasons for this PR, as parsed from the PR body.
 * @returns {boolean} true iff EVERY reason canonicalizes, they name exactly ONE distinct token, and that token
 *   is in `EDITOR_ENABLED_REASON_TOKENS`.
 */
export function editorAllowedByReasons(reasons) {
  const raw = (Array.isArray(reasons) ? reasons : reasons ? [reasons] : []).filter(Boolean);
  if (!raw.length) return false; // fail closed — see `editorPolicyFromReasons` on why `[]` is not `none`
  const tokens = new Set();
  for (const r of raw) {
    const token = canonicalizeReason(r);
    if (!token) return false; // an unweighable reason is a signal we cannot rule out
    tokens.add(token);
  }
  return tokens.size === 1 && EDITOR_ENABLED_REASON_TOKENS.includes([...tokens][0]);
}

/**
 * #2908 (PR #1106 review, F3 — the blocker) — may the editor push on THIS round? Pure.
 *
 * The loop pins `editorEnabled` as a `const` at loop start, and `careLevel` is MUTABLE: an accepted juror invite
 * (#2640) reassigns it. Pinning alone gives one property — no later mutation can turn the editor ON — and the
 * loop's header comment argued that recomputing would only ever turn it OFF, so pinning was the safe half of a
 * choice. That was a false dichotomy. Both properties are available at once, and this is them: the PINNED value
 * still means nothing can turn the editor on, and the CURRENT band is honoured, so a mid-run raise turns it off.
 *
 * Without the second conjunct the loop pushes to the author's branch while its own state reads
 * `care=elevated` — the band the ruling excludes on evidence — and the "EDITOR OFF" log line never fires, so it
 * is not even visible.
 *
 * @param {boolean} pinnedEditorEnabled - the gate as resolved ONCE at loop start (an agent may only veto it).
 * @param {string|null} careLevel - the band as it stands on THIS round (an invite may have raised it).
 * @returns {boolean}
 */
export function editorMayPush(pinnedEditorEnabled, careLevel) {
  return pinnedEditorEnabled === true && EDITOR_ENABLED_CARE_LEVELS.includes(careLevel);
}

/**
 * ============================================================================
 * LENS vs METHOD — the perspective / grounding split + the resolver (#2634).
 * ============================================================================
 *
 * A juror is `lens + method + model` (epic #2636). Until now the two were CONFLATED: every `PANEL_LENSES` entry
 * (correctness / security / simplicity / standards-conformance) was implicitly grounded by the ONE method a
 * static reviewer subagent uses — reading the diff text. That is fine for those four, but it hides the real
 * shape: a LENS is a PERSPECTIVE to judge from (is this accessible? does it match the target design? is it fast
 * enough?), and a METHOD is the TOOL that grounds that perspective in evidence (an axe scan, a screenshot-diff
 * against a target, a Lighthouse run, a reviewer reading the diff). Splitting them makes the config composable:
 * the same lens can be grounded by a different method, and a new method can serve an existing lens, without
 * re-deriving either. This section stands up (1) the METHOD REGISTRY, (2) the extra PERSPECTIVE LENSES a UI diff
 * earns, and (3) the RESOLVER that maps `care-level + the diff's touch-set → the lens set → the method(s) each
 * lens attaches`. Aggregation is UNCHANGED — the resolved lenses still reduce by `DIVERSITY_SELECTION` (strictest
 * juror wins, never a vote); this slice only decides WHO is on the jury and WHAT grounds each seat, not how their
 * verdicts combine.
 *
 * This is the review-DIFF layer: the four static lenses live subject-agnostically in jury-core.mjs (`PANEL_LENSES`),
 * but the perspective lenses here (a11y / visual-vs-target / perf) and the touch-set classification are specific to
 * judging a UI code diff, so they live in review-core.mjs alongside the mandate builders. The care→METHOD mapping
 * is DATA in the #2633 contract (`POLICY_CARE_JURY.bands[band].validationMethods`) — the resolver reads it as the
 * per-band override, falling back to each lens's default grounding method when a band declares none (all bands
 * declare none today; the room is reserved). The care→RIGOR half (how many jurors, how many rounds, which static
 * lenses) is reused from jury-core's `panelRigorForCareLevel`, never re-derived here.
 */

/** The METHODS that can GROUND a lens (#2634) — the tool that produces the evidence a juror judges on. A frozen
 *  enum so every consumer names a method once. `static-review` is the existing grounding (a fresh-context
 *  reviewer subagent reads the diff); the other three are the automated UI-evidence tools a perspective lens pulls in. */
export const REVIEW_METHODS = Object.freeze({
  STATIC_REVIEW: 'static-review',     // a reviewer subagent reads the diff text and reports findings (the #2311 reviewer)
  AXE_SCAN: 'axe-scan',               // an automated accessibility scan (axe-core) over the rendered UI
  SCREENSHOT_DIFF: 'screenshot-diff', // a screenshot of the rendered UI compared against a target / baseline image
  LIGHTHOUSE: 'lighthouse',           // a Lighthouse performance audit of the rendered page
});

/** The PERSPECTIVE lenses a UI diff earns on top of the four static `PANEL_LENSES` (#2634). These are review-DIFF
 *  specific (they only make sense for a rendered UI), so they live here, not in jury-core's subject-agnostic set.
 *  Each is grounded by a distinct automated method (see `LENS_DEFAULT_METHOD`), never by the static reviewer. */
export const PERSPECTIVE_LENSES = Object.freeze({
  A11Y: 'a11y',
  VISUAL: 'visual-vs-target',
  PERF: 'perf',
});

/**
 * The method registry (#2634) — each method declares WHICH lenses it can ground, plus a human label. Pure data.
 * The one static reviewer grounds all four `PANEL_LENSES`; each automated tool grounds exactly one perspective
 * lens. `LENS_DEFAULT_METHOD` (below) is the inverted lens→method index derived from this, so the two never drift.
 */
export const METHOD_REGISTRY = Object.freeze([
  Object.freeze({
    id: REVIEW_METHODS.STATIC_REVIEW,
    label: 'static reviewer (reads the diff)',
    grounds: Object.freeze([...PANEL_LENSES]),
  }),
  Object.freeze({
    id: REVIEW_METHODS.AXE_SCAN,
    label: 'axe accessibility scan',
    grounds: Object.freeze([PERSPECTIVE_LENSES.A11Y]),
  }),
  Object.freeze({
    id: REVIEW_METHODS.SCREENSHOT_DIFF,
    label: 'screenshot-diff against a target',
    grounds: Object.freeze([PERSPECTIVE_LENSES.VISUAL]),
  }),
  Object.freeze({
    id: REVIEW_METHODS.LIGHTHOUSE,
    label: 'Lighthouse performance audit',
    grounds: Object.freeze([PERSPECTIVE_LENSES.PERF]),
  }),
]);

/** lens → its DEFAULT grounding method id, inverted from `METHOD_REGISTRY` so the two are single-sourced. A lens
 *  the resolver attaches always has a default here; the contract's per-band `validationMethods` can OVERRIDE it. */
export const LENS_DEFAULT_METHOD = Object.freeze(
  METHOD_REGISTRY.reduce((acc, m) => {
    for (const lens of m.grounds) acc[lens] = m.id;
    return acc;
  }, {}),
);

// The touch-set classifier's file patterns (#2634). A UI diff (markup / styles / component / element files) earns
// the a11y + visual perspective lenses; a PAGE-level diff (a whole renderable page) additionally earns the perf
// lens (a lone component or stylesheet is judged visually, but only a full page has a Lighthouse-measurable load);
// a script-only diff earns NEITHER — grounded by the static lenses alone. That is exactly the "a UI-file diff
// auto-pulls a11y + visual; a script diff does not" spec line.
//
// A file is UI by its EXTENSION (a renderable markup/style file) OR by living in a UI DIRECTORY. The directory
// signal is what catches a custom element authored as a plain `.ts` (a Lit-style element, e.g.
// `src/patterns/**/elements.ts`): it earns the same lenses its `.tsx` sibling would, where extension-alone would
// MISS it — an UNSAFE false negative on a real UI change. Over-attaching a lens is the safe direction (a lens is
// only a review perspective, and this slice merely PLANS the jury — no method runs here), the same "over-escalate
// rather than under" posture `isBlastRadiusPath` takes. But files that NEVER render — docs, data, and test
// scaffolding — are excluded (`NON_UI`) so a README or a fixtures table sitting in a UI tree does not pull an
// a11y/perf lens onto something with nothing to render (the absurd over-attachment a bare directory rule causes).
// KNOWN GAP: a UI component authored as a `.ts` OUTSIDE any UI-named directory is not detectable from its path
// alone, so it is treated as a script — best-effort by design; a later slice may inspect content to close it.
const UI_EXTENSIONS = /\.(css|scss|sass|less|html?|njk|tsx|jsx|svelte|vue)$/i;
const UI_DIR_SEGMENTS = /(^|\/)(components?|elements?|patterns?|demos?|pages?|styles?|stories|ui)(\/|$)/i;
const PAGE_EXTENSIONS = /\.(html?|njk)$/i;
const PAGE_DIR_SEGMENTS = /(^|\/)(demos?|pages?)(\/|$)/i;
// Files that never render even when they sit in a UI tree — docs, config/data, and test scaffolding. Matched FIRST
// so they are excluded from BOTH the UI and page classification regardless of directory.
const NON_UI = /\.(md|markdown|json|ya?ml|txt|lock|snap)$|(^|\/)__(fixtures|snapshots|tests)__(\/|$)|\.(test|spec)\.[a-z0-9]+$/i;

/** Is this repo-relative path a UI surface (markup / styles / component / element)? Pure. A renderable extension,
 *  OR a file under a UI directory (so a `.ts` custom element counts) — minus the never-rendered `NON_UI` files. */
export function isUiPath(path) {
  const p = String(path || '');
  if (NON_UI.test(p)) return false;
  return UI_EXTENSIONS.test(p) || UI_DIR_SEGMENTS.test(p);
}

/** Is this repo-relative path a whole renderable PAGE (a demo / page — html/njk, or code under a page dir)? Pure.
 *  A page is always UI too. Same `NON_UI` exclusion as `isUiPath`. */
export function isPagePath(path) {
  const p = String(path || '');
  if (NON_UI.test(p)) return false;
  return PAGE_EXTENSIONS.test(p) || PAGE_DIR_SEGMENTS.test(p);
}

/**
 * Classify a diff's TOUCH-SET (#2634) — the changed-file list — into the perspective lenses it earns. Pure. A UI
 * file pulls a11y + visual-vs-target; a page file additionally pulls perf; a script-only diff pulls none. Returns
 * both the boolean touch flags (for callers that want the raw signal) and the ordered `lenses` those flags imply.
 * @param {string[]} changedFiles - repo-relative paths of the diff's net changed files.
 * @returns {{touchedUi: boolean, touchedPage: boolean, touchedScript: boolean, lenses: string[]}}
 */
export function classifyTouchSet(changedFiles = []) {
  const files = (Array.isArray(changedFiles) ? changedFiles : []).filter(Boolean).map(String);
  const touchedUi = files.some(isUiPath);
  const touchedPage = files.some(isPagePath);
  // A file that is neither UI nor page is a plain script/data/doc — the "script diff" case.
  const touchedScript = files.some((f) => !isUiPath(f) && !isPagePath(f));
  const lenses = [];
  if (touchedUi) lenses.push(PERSPECTIVE_LENSES.A11Y, PERSPECTIVE_LENSES.VISUAL);
  if (touchedPage) lenses.push(PERSPECTIVE_LENSES.PERF);
  return { touchedUi, touchedPage, touchedScript, lenses };
}

/** The known method id space — every value of `REVIEW_METHODS`, as a Set for O(1) membership. Derived from
 *  `REVIEW_METHODS` so the two never drift. `methodsForLens` validates each band override against this so the
 *  `methods` it returns is always ONE consistent id space a `METHOD_REGISTRY`-by-id lookup can resolve. */
const KNOWN_METHOD_IDS = new Set(Object.values(REVIEW_METHODS));

/** The method(s) that ground one lens under one care band (#2634): the band's contract-declared `validationMethods`
 *  override if present (the care→method mapping this slice depends on), else the lens's default grounding method.
 *  Pure. Returns a fresh array so a caller can never mutate the frozen contract or the default index. Exported for
 *  direct unit testing / composition (its sibling touch-set helpers `isUiPath`/`isPagePath`/`classifyTouchSet` are
 *  exported too).
 *
 *  Every override entry MUST be a known `REVIEW_METHODS` id — validated here, throwing on an unknown id. Without
 *  this, a band could carry an arbitrary override string on one lens (e.g. `'pair-review'`) while every other lens
 *  carries a real method id like `'static-review'`, and a downstream consumer resolving `methods` against
 *  `METHOD_REGISTRY` by id would SILENTLY miss the overridden lens. Throwing keeps `methods` a single consistent id
 *  space. All shipped bands declare `validationMethods: {}`, so this path is dormant today; it hardens the reserved
 *  override for when a band populates it.
 *  @param {string} lens
 *  @param {{validationMethods?: Object<string, string[]>}} [band]
 *  @returns {string[]} */
export function methodsForLens(lens, band) {
  const override = band && band.validationMethods && band.validationMethods[lens];
  if (Array.isArray(override) && override.length) {
    const unknown = override.filter((m) => !KNOWN_METHOD_IDS.has(m));
    if (unknown.length) {
      throw new Error(
        `methodsForLens: lens "${lens}" declares unknown override method id(s): ${unknown.join(', ')} — every `
        + `validationMethods entry must be a known REVIEW_METHODS value (${Object.values(REVIEW_METHODS).join(', ')})`,
      );
    }
    return [...override];
  }
  const fallback = LENS_DEFAULT_METHOD[lens];
  return fallback ? [fallback] : [];
}

/**
 * THE RESOLVER (#2634) — `care-level + the diff's touch-set → the lens set → the method(s) each lens attaches`.
 * Pure. This is the prerequisite the jury-core resolver spine (#2655) and the adapter contract (S4) build on: it
 * decides WHO sits on the jury (which lenses) and WHAT grounds each seat (which methods), leaving the rigor knobs
 * (jurors-per-lens, rounds) to jury-core's `panelRigorForCareLevel` and the many-verdicts-to-one reduction to
 * `derivePanelVerdict` (aggregation is UNCHANGED — always `DIVERSITY_SELECTION`).
 *
 * Two inputs, composed:
 *   • the CARE band (`panelRigorForCareLevel(careLevel)`, jury-core) supplies the base STATIC lens set
 *     (`PANEL_LENSES` for low/elevated/high, empty for `none`) plus the rigor dial — reused, never re-derived.
 *   • the TOUCH-SET (`classifyTouchSet(changedFiles)`) supplies the extra PERSPECTIVE lenses the diff earns (a UI
 *     diff → a11y + visual; a page diff → + perf; a script-only diff → none).
 * When the care band is `none` (the PR did not escalate) there is no panel at all, so the resolver returns an
 * empty lens set REGARDLESS of the touch-set — nothing to review means no jury, even for a UI change.
 *
 * Each resolved lens carries `attachedBy` (`care` = from the care band's static set; `touch-set` = earned by what
 * the diff touches) so a downstream consumer (#2655, the console) keeps the provenance. Lenses are de-duplicated
 * with the care band winning; static lenses are ordered first (in `PANEL_LENSES` order), then perspective lenses.
 *
 * @param {{careLevel: string, changedFiles?: string[]}} o - `careLevel` is a `CARE_LEVELS` value; `changedFiles`
 *   is the diff's net changed-file set (repo-relative paths). Delegates the unknown-care-level throw to
 *   `panelRigorForCareLevel`.
 * @returns {{careLevel: string, jurorsPerLens: number, rounds: number, aggregation: string,
 *   lenses: Array<{lens: string, methods: string[], attachedBy: 'care'|'touch-set'}>}}
 */
export function resolveJuryPlan({ careLevel, changedFiles = [] } = {}) {
  // #2656 — route through the subject-agnostic adapter seam (`resolveAdapterRoster`) with the reference
  // `PR_DIFF_ADAPTER`, in place of a direct `resolveRoster` call. The adapter supplies the two subject-specific
  // halves the spine takes as inputs — the touch-set SIGNAL (`classifyTouchSet`'s UI-glob-derived perspective
  // lenses) and the method resolver bound to the care band (`ctx.careLevel` → the band's `validationMethods`). The
  // seam still delegates the subject-NEUTRAL merge / de-dup / provenance / method-attach (and the care `none` →
  // empty jury, unknown-care-level throw) to `resolveRoster` (#2655) — so the behaviour is byte-identical to the
  // prior inline form; only the wiring now goes through the F2 adapter contract.
  return resolveAdapterRoster({ adapter: PR_DIFF_ADAPTER, careLevel, input: changedFiles, ctx: { careLevel } });
}

/**
 * THE REFERENCE SUBJECT ADAPTER (#2656, F2 heart of epic #2649) — the PR-diff subject, re-homed behind the
 * subject-adapter contract (`SubjectAdapter` in jury-core.mjs). This is the plug that PROVES the seam: every
 * PR-diff-SPECIFIC piece the jury needs is declared here as one contract member, and the shipped PR-diff jury path
 * (`resolveJuryPlan` above, and the mandate builders) now runs entirely through those members — a future subject
 * (design-pixels, decision-prose = S5) adds only its own adapter, nothing in the core.
 *   • `extractTouchSet` — the changed-file → perspective-lens classifier (`classifyTouchSet`, UI/page globs).
 *   • `resolveMethods`  — the lens → grounding method registry, per care band (`methodsForLens`; the band comes
 *     from `ctx.careLevel` via the #2633 care→jury table).
 *   • `mandatoryLenses` — correctness + security (the two lenses that must unanimously accept to land a diff).
 *   • `charterForLens`  — the diff-specific juror charter text (passed to `materializeRoster`).
 *   • `buildMandate` / `buildPanelMandate` — the diff-specific mandate framing (built on `buildSubjectMandate`).
 * Frozen so the reference adapter is a stable value other modules can import and compare against.
 */
export const PR_DIFF_ADAPTER = Object.freeze({
  subject: 'pr-diff',
  subjectNoun: 'diff',
  mandatoryLenses: MANDATORY_LENSES,
  extractTouchSet: (changedFiles) => classifyTouchSet(changedFiles).lenses,
  resolveMethods: (lens, ctx) => methodsForLens(lens, POLICY_CARE_JURY.bands[ctx?.careLevel]),
  // #2950 — the seat's charter names the BASELINE, not just the lens. "Judge the diff under the X lens" is an
  // open-ended brief that invites judging against an ideal; the comparison target is what makes a finding
  // dispositionable at all (better-than-base-but-imperfect is a carve-out, not a blocker).
  charterForLens: (lens) => `judge the diff under the "${lens}" lens — against the goal it serves and the base it started from, not against an ideal`,
  buildMandate,
  buildPanelMandate,
});

/**
 * Build the mandate handed to ONE lens reviewer in the v3 panel (#2310) — wraps `buildMandate({ mandate: lens
 * })` (same diff-only, no-checkout #2336 isolation every reviewer shares) with the panel framing: this
 * reviewer judges its OWN lens only and must not soften its verdict to pre-empt another lens's concern — a
 * genuine cross-mandate tradeoff is for a human to resolve, never for one reviewer to compromise away.
 *
 * #2950 — the OPTIONAL `goal` and `round` params pass through to `buildSubjectMandate`, which owns their wording:
 * `goal` states what the diff is TRYING to do (so a juror judges against that and the base, not against an ideal),
 * and `round` ≥ 2 fires the anti-spiral clause (judge only the previous round's fix; anything else is a carve-out
 * by construction). Both are additive — omitting them leaves the mandate as it was before #2950.
 *
 * #2450 — the OPTIONAL `netChangedFiles` param appends a GROUND TRUTH block naming the PR's NET changed-file set
 * vs current main (the drain already computes it via `computeNetDiffChangedFiles`, `we:scripts/merge-ai-prs.mjs`)
 * and tells the reviewer NOT to report a diff-side file OUTSIDE that set as scope creep — such a file already
 * landed on main via a sibling lane and only shows in the three-dot diff, so a phantom scope-creep finding on it
 * burns a negotiation round for nothing. OMITTING the param (or passing an empty list) leaves the mandate
 * BYTE-FOR-BYTE unchanged, so every existing caller/test is unaffected — the block is purely additive.
 * #2967 — `fenced` passes straight through to `buildMandate`: it fences the GOAL, which on the drain's review
 * path is the PR TITLE (author-controlled text off `gh pr view`). Every caller that supplies a `goal` it did not
 * itself author should pass it.
 *
 * #3094 — the OPTIONAL `aim` param, the caller's HYPOTHESIS about what to hunt. It sits BESIDE the goal, never
 * instead of it: the goal is what the diff is trying to do (context), the aim is where the caller thinks the
 * defect lives (instruction). It renders under a heading that says the hypothesis is UNVERIFIED and tells the
 * juror to report the named defect ABSENT when it is absent — an aim that asserts the defect exists produces a
 * reviewer who finds it either way, which is the failure the aim would otherwise buy. It is FENCED (#2438) for
 * the same reason the goal is: it is caller-supplied prose, so it travels as labelled data and cannot become the
 * juror's conclusion. Omitting it (or passing blank) leaves the mandate BYTE-FOR-BYTE what it is without it.
 * #2914 — the OPTIONAL `diffBasis` param. When it is present AND degraded (anything other than the literal
 * string `'net'` — see `isDiffBasisDegraded`), the mandate gains a disclosure telling the juror it is holding
 * the three-dot diff, not the net two-tree diff, so a sibling lane's already-landed file must not be reported
 * as this PR's scope creep. Omitting it (or passing `'net'`) leaves the mandate BYTE-FOR-BYTE what it is
 * without it — the golden fixture with no `diffBasis` passed is unaffected.
 * @param {{lens: string, contextIsolation?: string, netChangedFiles?: string[]|null, goal?: string,
 *   round?: number, fenced?: boolean, aim?: string, diffBasis?: string|null}} o
 * @returns {string}
 */
export function buildPanelMandate({
  lens, contextIsolation = 'diff-only', netChangedFiles = null, goal = '', round = 1, fenced = false,
  aim = '', diffBasis = null,
} = {}) {
  if (!PANEL_LENSES.includes(lens)) {
    throw new Error(`buildPanelMandate: unknown lens "${lens}" — must be one of ${PANEL_LENSES.join(', ')}`);
  }
  const base = buildMandate({ contextIsolation, mandate: lens, goal, round, fenced });
  const parts = [
    base,
    `You are ONE of several independent mandate reviewers on this diff, each judging a single lens`,
    `(the full panel: ${PANEL_LENSES.join(', ')}).`,
    'Judge ONLY your own lens — do not comment on concerns outside it, and do not soften or withhold your',
    'verdict to accommodate what you guess another lens\'s reviewer might want. A genuine tradeoff BETWEEN',
    'mandates (e.g. security wants X, simplicity wants not-X) is human judgment by definition — surface your',
    'honest verdict for your own lens and let the panel reduction detect the conflict; do not resolve it yourself.',
    // The PROSE IMPRECISION clause used to be typed out here, which meant only the PANEL got it — the #2439
    // FINAL VALIDATOR, an equally adversarial reader of the same diff, did not. It now lives in `buildMandate`
    // so both do; see PROSE_IMPRECISION_RULE.
  ];
  // THE LENS'S OWN METHOD (#3035). `buildMandate` passes the lens as a bare NAME, which is enough for a lens
  // whose job is self-evident from the word and not enough for one that is mostly knowing where to look and
  // what settles it. Appended only for lenses that register a brief, so every existing mandate is byte-identical.
  const brief = huntBriefForLens(lens);
  if (brief) parts.push(brief);
  const netFiles = (Array.isArray(netChangedFiles) ? netChangedFiles : []).filter(Boolean).map(String);
  if (netFiles.length) {
    parts.push(
      `GROUND TRUTH — the NET changed-file set of this PR vs CURRENT main is exactly: ${netFiles.join(', ')}.`,
      'A file that appears in the diff but is NOT in that set is content that ALREADY landed on main via a',
      'sibling lane (the three-dot diff still shows it), NOT something this PR adds — do NOT report such a file',
      'as scope creep, an undeclared payload, or an extra change. Judge only changes to the files in this net set.',
    );
  }
  // #3094 — THE CALLER'S AIM, as a hypothesis. Placed last-but-one so it is the freshest instruction the juror
  // reads before the mutation probe, and fenced so the prose inside it is subject matter, never orders. The
  // FENCED_DATA_RULE sentence travels with it ONLY when the base has not already carried it in (a fenced goal
  // brings it), so the mandate never states the same rule twice.
  const aimText = typeof aim === 'string' ? aim.trim() : '';
  if (aimText) {
    if (!base.includes(FENCED_DATA_RULE)) parts.push(FENCED_DATA_RULE);
    parts.push(
      'WHERE THE CALLER THINKS THE DEFECT IS — A HYPOTHESIS, STATED BY THE CALLER, NOT ESTABLISHED. Search there',
      'FIRST and report what you actually find. It is NOT a finding, NOT evidence, and NOT a conclusion you are',
      'being asked to reach: if the named defect is NOT there, say so explicitly and in those words — "the aim',
      'names X; X is not present here, and this is why" — and that is a COMPLETE answer to the aim, not a failed',
      'one. Never manufacture an instance of it to satisfy the hypothesis, and never let it narrow you: anything',
      'else your lens finds is still yours to report. The hypothesis, quoted verbatim:',
      fenceUntrusted('aim', aimText),
    );
  }
  // #2914 — DIFF BASIS DISCLOSURE. Guarded on truthy-AND-degraded, never a bare `isDiffBasisDegraded(diffBasis)`
  // (which is also true for null/undefined, since null !== 'net') — an omitted diffBasis must leave the mandate
  // byte-identical to today's output, per the golden fixture.
  if (diffBasis && isDiffBasisDegraded(diffBasis)) {
    parts.push(
      'DIFF BASIS: DEGRADED (three-dot). You are holding the three-dot output, not the net',
      'two-tree diff -- it may list files a SIBLING lane already landed on main as though this PR added them.',
      'Before reporting a file as scope creep, an undeclared payload, or an unrelated change, consider that it',
      'may already be on main via another lane. This round will be escalated to a human regardless of your',
      'verdict, so your findings are read as a report, not an acceptance signal.',
    );
  }
  // #3094 — THE MUTATION PROBE, UNCONDITIONAL (the fork ruled on the card, 2026-08-14). Every mandate that has
  // found a real defect in this loop carried this instruction, so it is not left to a caller to remember: an
  // opt-in flag is a way to omit the single highest-yield line by forgetting it. It is not gated on the lens
  // either — the PHRASING makes it a natural no-op for a finding that changes no behaviour, which is what a
  // `simplicity` juror is looking at, so no branch has to guess which lens is judging what.
  parts.push(MUTATION_PROBE_RULE);
  return parts.join(' ');
}

/**
 * Render the per-lens verdict table the drain posts on escalation (#2310's "how a split verdict is surfaced to
 * the operator" spec line) — one row per lens, tagged mandatory/advisory, so a human reading the escalation
 * comment sees at a glance WHICH lens(es) disagreed and whether the disagreement was ever blocking. Pure.
 *
 * #xqa9ttq — `lensProviders` (optional, `{ [lens]: providerName }`) NAMES a non-Claude juror inline in the
 * lens cell (`simplicity (codex)`) rather than leaving it indistinguishable from a Claude seat. Omitted or
 * `'claude'` renders the lens bare, byte-identical to before this param existed — a caller that never seats a
 * second provider (every run before #xqa9ttq's Codex advisory seat) sees no change at all.
 * @param {{lensVerdicts?: Object<string, string>, mandatoryLenses?: string[], lenses?: string[], lensProviders?: Object<string, string>}} [o]
 * @returns {string} a markdown table.
 */
export function renderPanelVerdictTable({ lensVerdicts = {}, mandatoryLenses = MANDATORY_LENSES, lenses = PANEL_LENSES, lensProviders = {} } = {}) {
  const rows = lenses.map((lens) => {
    const verdict = lensVerdicts[lens] ?? '(no verdict)';
    const weight = mandatoryLenses.includes(lens) ? 'mandatory' : 'advisory';
    const provider = lensProviders?.[lens];
    const lensLabel = provider && provider !== 'claude' ? `${lens} (${provider})` : lens;
    return `| ${lensLabel} | ${weight} | ${verdict} |`;
  });
  return ['| lens | weight | verdict |', '| --- | --- | --- |', ...rows].join('\n');
}

/**
 * #2439 (slice B of epic #2410) — the INDEPENDENT HARDENED VALIDATOR. After the editor↔reviewer panel loop
 * (#2311/#2310) CONVERGES on an accept, a distinct fresh-context adversary re-judges the FINAL diff before it
 * lands — the "non-author accepts" invariant made independent. It is a diverse JURY (one validator per lens,
 * the same `PANEL_LENSES`, reduced by the same `derivePanelVerdict` — that is what "extends the panel reducers
 * into a jury" means), but with two hard differences from a panel reviewer: it took NO part in the negotiation,
 * and it is NEVER shown the peers' self-assessment, dismissals, or reasoning — only the final diff, the tests it
 * touches, and the mandate. A converged negotiation can still land a plausible-but-wrong result; the validator's
 * value is that it never saw why the peers thought it was right. `combineValidatedVerdict` then gates the panel's
 * accept on this independent verdict, and only a JOINT accept earns `redteam:accepted` (the label lives in
 * `review-escalation.mjs`; this module stays label-free — it JUDGES ONLY).
 * @param {{lens: string, contextIsolation?: string}} o
 * @returns {string}
 */
export function buildValidatorMandate({ lens, contextIsolation = 'diff-only' } = {}) {
  if (!PANEL_LENSES.includes(lens)) {
    throw new Error(`buildValidatorMandate: unknown lens "${lens}" — must be one of ${PANEL_LENSES.join(', ')}`);
  }
  const base = buildMandate({ contextIsolation, mandate: lens });
  return [
    base,
    `You are the INDEPENDENT FINAL VALIDATOR for the ${lens} lens (#2439) — a fresh adversary who took NO part`,
    'in the editor↔reviewer negotiation that produced this diff. Judge the FINAL diff and the tests it adds or',
    'changes on their own merits ONLY. You are NOT shown, and must not ask for, the editor\'s or the reviewers\'',
    'self-assessment, dismissals, or reasoning — a converged negotiation can still land a plausible-but-wrong',
    'result, and your value is that you never saw why they thought it was right. Assume nothing has been',
    'validated. Report any concrete reason this should NOT land (a real bug, an unhandled case, a missing or',
    'gamed test that would pass while the behaviour is wrong), or accept ONLY if you independently would — never',
    'defer to the fact that a panel already accepted it.',
    // #2440 (slice C of epic #2410) — the ANTI-TEST-GAMING mandate. A deterministic gate
    // (`scanTestTampering` in `pr-merge-gate.mjs`) already refuses the auto-land on the diff-VISIBLE tamper
    // forms (a deleted / `.skip`-ed / `.only`-ed / removed test). Your job is the JUDGMENT half a script cannot
    // do: inspect the test changes for SUBTLER gaming a green check would hide.
    'ANTI-TEST-GAMING — the CI-green land clause is only as trustworthy as the tests behind it, so scrutinise',
    'EVERY test change as an adversary: (1) for a logic/behaviour fix, confirm it carries a test that would FAIL',
    'on the PRE-CHANGE behaviour — a test that passes both before and after proves nothing and is a red flag;',
    '(2) reject a change that WEAKENS coverage — an assertion loosened or deleted, a case narrowed, an edge',
    'stripped — even when the suite still goes green; (3) treat any author-peer edit to a test as suspect by',
    'default and satisfy yourself it strengthens rather than launders the check. A gamed green is a NOT-land.',
  ].join(' ');
}

/**
 * #2439 — gate the panel's accept on the INDEPENDENT validator's verdict, returning the single verdict the
 * existing `deriveNegotiationOutcome` round loop consumes unchanged (so the validator adds a final gate without
 * a new loop). Pure. The validator can only ever TIGHTEN an accept — it is a final adversarial check, never a
 * way to overturn a panel that already wants changes:
 *   - the panel did NOT accept → its own verdict stands (there is nothing to gate yet; the validator only runs
 *     on a panel accept).
 *   - panel accept + validator `needs-human` → `needs-human` (the validator flags a call it will not make alone).
 *   - panel accept + validator `accept` → `accept` — BOTH independently agree; this is the joint accept that
 *     earns `redteam:accepted`.
 *   - panel accept + validator `changes` → `changes` (the validator found something the panel missed → another
 *     editor↔reviewer round, not a land).
 *   - #2823 round-2 finding 2 — panel accept + validator `prevention-outstanding` → `prevention-outstanding`. On the
 *     #2439 independent-validator path a validator can re-report the panel's findings as resolved (`no_change_needed`)
 *     while naming an uncaptured guard — that is `prevention-outstanding`, a distinct terminal state. It must NOT
 *     flatten to `changes`: flattening reintroduces exactly the non-progressing round loop `deriveNegotiationOutcome`
 *     escalates it to avoid (every finding already resolved, so an editor round has nothing to fix — it would burn
 *     the budget to the cap, then escalate as `non-convergence` instead of "file the guard"). Preserved here so it
 *     rides `deriveNegotiationOutcome`'s immediate escalate straight to the operator who files the guard.
 * @verdicts-total — every `VERDICTS` member is handled explicitly on both the panelVerdict pass-through and the
 *   validatorVerdict branch; the `check:standards` verdict-totality gate enforces it so a new member can't flatten.
 * @param {{panelVerdict: 'accept'|'changes'|'needs-human'|'prevention-outstanding', validatorVerdict: 'accept'|'changes'|'needs-human'|'prevention-outstanding'}} o
 * @returns {'accept'|'changes'|'needs-human'|'prevention-outstanding'}
 */
export function combineValidatedVerdict({ panelVerdict, validatorVerdict } = {}) {
  const known = new Set(Object.values(VERDICTS));
  if (!known.has(panelVerdict)) throw new Error(`combineValidatedVerdict: unknown panelVerdict "${panelVerdict}"`);
  if (panelVerdict !== VERDICTS.ACCEPT) return panelVerdict;
  if (!known.has(validatorVerdict)) throw new Error(`combineValidatedVerdict: unknown validatorVerdict "${validatorVerdict}"`);
  if (validatorVerdict === VERDICTS.NEEDS_HUMAN) return VERDICTS.NEEDS_HUMAN;
  if (validatorVerdict === VERDICTS.ACCEPT) return VERDICTS.ACCEPT;
  // #2823 — a validator prevention-outstanding is carried through, NOT flattened to changes (which would loop).
  if (validatorVerdict === VERDICTS.PREVENTION_OUTSTANDING) return VERDICTS.PREVENTION_OUTSTANDING;
  return VERDICTS.CHANGES;
}

/**
 * #2433 — SESSION/NOTICE RENDERERS. Three recurrent OPERATOR-facing artifacts (chat/report text, not PR
 * comments — `renderPanelVerdictTable` above and #2432's `renderPanelComment` cover the PR-comment body) that
 * used to be hand-typed prose per caller each time (the #2418 epic's "template the renders, not the prose"
 * lever): the drain's end-of-run pass summary, the escalation/clearance notice a session reports about ONE
 * PR's outcome, and the `closing-session` "Flow improvements" recap line. Single-sourced here so a wording
 * tweak lands once and `/drain`/`/review`/`closing-session` can't drift apart on how they say the same thing.
 */

/**
 * Render the drain's end-of-run pass summary (#2433) — what `/drain` reports to the operator after a
 * `merge-ai-prs.mjs` pass, instead of hand-composing it fresh from the raw `--json` result each time. Pure —
 * consumes the (sub)shape of that JSON result the drain already computes (`merged`/`failed`/`deferred`/
 * `parked`/`skipped`, each an array of `{num, repo?, ...}`-shaped entries); never re-derives any of it.
 * @param {{merged?: Array<object>, failed?: Array<object>, deferred?: Array<object>, parked?: Array<object>,
 *   skipped?: Array<object>, dryRun?: boolean}} [o]
 * @returns {string}
 */
export function renderDrainRunSummary({ merged = [], failed = [], deferred = [], parked = [], skipped = [], dryRun = false } = {}) {
  const idTag = (x) => `#${x.num ?? x.item ?? '?'}`;
  if (dryRun) {
    return `Dry run — plan only, nothing landed: ${merged.length} would merge, ${deferred.length} deferred (blockedBy), ${parked.length} parked for review, ${skipped.length} skipped.`;
  }
  const counts = [`merged ${merged.length}`];
  if (failed.length) counts.push(`${failed.length} FAILED`);
  if (parked.length) counts.push(`${parked.length} parked for review`);
  if (deferred.length) counts.push(`${deferred.length} deferred (blockedBy)`);
  if (skipped.length) counts.push(`${skipped.length} skipped`);
  const lines = [`Drain pass: ${counts.join(', ')}.`];
  if (merged.length) lines.push(`  merged: ${merged.map(idTag).join(', ')}`);
  if (failed.length) lines.push(`  FAILED: ${failed.map(idTag).join(', ')}`);
  if (parked.length) {
    lines.push(`  parked: ${parked.map((p) => `${idTag(p)}${p.reasons?.length ? ` (${p.reasons.join('; ')})` : ''}`).join(', ')}`);
  }
  if (deferred.length) lines.push(`  deferred: ${deferred.map(idTag).join(', ')}`);
  if (skipped.length) {
    lines.push(`  skipped: ${skipped.map((s) => `${idTag(s)}${s.reason ? ` (${s.reason})` : ''}`).join(', ')}`);
  }
  return lines.join('\n');
}

/** The two review-outcome moments `renderReviewNotice()` covers (#2433) — a PR PARKING/escalating (the
 *  drain's advisory-fix-or-human-handoff moment) and a human CLEARING it (`/review`'s recorded verdict). One
 *  renderer keyed on `event`, so both callers report the same outcome in the same words. */
export const REVIEW_NOTICE_EVENTS = Object.freeze({
  ESCALATED: 'escalated',
  CLEARED: 'cleared',
});

/**
 * #2823 — render the prevention-summary TAIL appended to an escalated notice. Pure. Returns `''` (byte-stable
 * for every pre-#2823 caller) when there is no guard owed. Otherwise names the count and the guards OWED, so the
 * repo's outstanding prevention debt rides the same line the operator already reads.
 *
 * THE REDUCED VERDICT IS AUTHORITATIVE (#2823 round-3 finding 2). When the caller's `verdict` is
 * `prevention-outstanding`, this summary NAMES the guards owed — checked FIRST, BEFORE any outstanding-finding
 * short-circuit. That is the reconciliation with `derivePanelVerdict`: that reducer raises `prevention-outstanding`
 * from a MIXED list — a RESOLVED finding owes a guard while an ADVISORY finding is still open (an advisory
 * `changes` never blocks the mandatory-accept path) — and on exactly that list the operator is told the blocker is
 * an unfiled guard, so the guard MUST be named, not muted. The prior cut suppressed on ANY outstanding finding and
 * so returned `''` precisely when the verdict demanded the guard's name — the two contradicted (round-3 finding 2).
 *
 * With NO explicit `prevention-outstanding` verdict, it falls back to `deriveVerdict`'s shape: ANY outstanding
 * finding ⇒ the verdict is `changes`, prevention is never consulted, so the summary stays silent (the blocker is
 * the unfixed defect — #2823 round-2 finding 3); only once every finding is resolved does a resolved finding with
 * an uncaptured guard fire it. Either way it gates on the SAME single-sourced predicates every reducer shares
 * (`isFindingOutstanding` for "still open", `hasUncapturedPrevention` for "owes a guard").
 *
 * NOTICE-WIDE, VERDICT-NARROW (#xdompzx) — this is the WIDE half: it reads `hasUncapturedPrevention`, so it can
 * name a guard the verdict did not stop for. Rationale stated once at `blocksAcceptance` (`jury-core.mjs`). Two
 * consequences for the COPY below: it claims guards are OWED, never that they blocked the accept; and its lead
 * word is not a verdict name, because on an `accept` run this summary still fires and a notice must never print a
 * verdict it did not reduce to (#xdompzx round-2, finding 4).
 * @param {{findings?: Array<object>, verdict?: string}} [o]
 * @returns {string}
 */
export function renderPreventionSummary({ findings = [], verdict } = {}) {
  const all = normalizeFindings(findings);
  // The guards owed = every RESOLVED finding whose named guard is neither captured nor filed — a SUPERSET of the set
  // the reducers raise the verdict on (they additionally require the impact bar, #xdompzx). An OUTSTANDING finding is
  // `changes` territory and never owes here.
  const owed = all.filter((f) => !isFindingOutstanding(f) && hasUncapturedPrevention(f));
  // "Prevention OWED", not "Prevention outstanding" (#xdompzx round-2, finding 4): the old lead was the literal
  // `VERDICTS.PREVENTION_OUTSTANDING` token used as copy, and this summary also fires on a run that reduced to
  // `accept` (a below-bar guard) — so the operator read a verdict name the reduction never produced. And "owed",
  // not "must be filed before accept": below the bar a guard is owed without withholding the accept.
  const name = () => {
    if (!owed.length) return ' Prevention owed — file the named guard(s).';
    const guards = owed.map((f) => f.prevention).join('; ');
    const n = owed.length;
    return ` Prevention owed — ${n} guard${n === 1 ? '' : 's'} to file: ${guards}.`;
  };
  // The reduced verdict is AUTHORITATIVE and checked FIRST — when it is prevention-outstanding, name the guards even
  // on a mixed list (this is the round-3 finding 2 reconciliation with derivePanelVerdict).
  if (verdict === VERDICTS.PREVENTION_OUTSTANDING) return name();
  // No explicit prevention verdict: match deriveVerdict's short-circuit — any outstanding finding ⇒ `changes`, stay
  // silent; else surface a guard owed by the (verdict-less) resolved findings themselves.
  if (all.some(isFindingOutstanding) || !owed.length) return '';
  return name();
}

/**
 * Render the operator-facing escalation/clearance notice (#2433) — the short line `/drain` reports when a PR
 * parks/escalates, and `/review` reports after recording a human verdict. Distinct from the PR-COMMENT body
 * (`renderPanelVerdictTable` / #2432's `renderPanelComment`, posted to GitHub via `gh pr comment`) — this is
 * what the SESSION itself tells the operator in-chat. Pure; never posts anything.
 * #2823 — the ESCALATED notice also carries a PREVENTION SUMMARY: when the verdict is `prevention-outstanding`
 * or the supplied `findings` name guards that are neither captured nor filed, it appends "Prevention owed
 * — N guard(s) to file: …" so the operator sees the outstanding prevention debt in the same line, not only in the
 * verdict token. Passing no `findings` (every existing caller) leaves the line byte-for-byte unchanged. Note this
 * is the ESCALATED event only — a below-bar guard on a clean accept never reaches here, which is why the posted PR
 * comment (`renderFindingLine`, review-render.mjs) carries the impact + guard on the merge path (#xdompzx).
 * #2953 — `outcome` ALSO accepts `'accepted'` (normalized to `'accept'`), not just `'accept'`. The `/review`
 * skill's own step 4 uses `--to=accepted` (the `review-set-label.mjs` CLI's target vocabulary) and step 6 carries
 * that same word into this call — so the documented sequence threw on its own first use. `'accepted'` is the
 * ONLY extra spelling accepted; an omitted or otherwise-misspelled outcome (e.g. `'change'`) still throws rather
 * than failing open to "accepted" (unchanged from before).
 * @param {{event: 'escalated'|'cleared', pr: number|string, repo?: string, verdict?: string,
 *   disposition?: {mode: 'converge'|'human', autoLand: boolean}, reasons?: string[],
 *   outcome?: 'accept'|'accepted'|'changes', actor?: string, findings?: Array<object>}} o — `outcome` is
 *   required (and strictly validated) for the `cleared` event; anything else throws rather than failing open to
 *   "accepted".
 * @returns {string}
 */
export function renderReviewNotice({ event, pr, repo, verdict, disposition, reasons = [], outcome, actor, findings = [] } = {}) {
  const tag = repo ? `${repo}#${pr}` : `#${pr}`;
  if (event === REVIEW_NOTICE_EVENTS.ESCALATED) {
    const reasonText = reasons.length ? ` (${reasons.join('; ')})` : '';
    const modeText = disposition?.mode === REVIEW_DISPOSITIONS.HUMAN
      ? 'deadlocked — handed to a human, no further convergence'
      : disposition?.autoLand === false
        ? 'converged with an advisory fix — a human must still clear it (gate-self)'
        : 'escalated for review';
    return `PR ${tag} ${modeText}${reasonText}. Verdict: ${verdict ?? '(pending)'}.${renderPreventionSummary({ findings, verdict })}`;
  }
  if (event === REVIEW_NOTICE_EVENTS.CLEARED) {
    // #2953 — accept both the renderer's own `accept` and the CLI's `accepted` (never a silent fail-open: an
    // omitted or misspelled outcome still throws below).
    const normalizedOutcome = outcome === 'accepted' ? 'accept' : outcome;
    if (normalizedOutcome !== 'accept' && normalizedOutcome !== 'changes') {
      throw new Error(`renderReviewNotice: unknown outcome "${outcome}" — must be one of accept, changes, accepted`);
    }
    const verb = normalizedOutcome === 'changes' ? 'requested changes' : 'accepted';
    const by = actor ? ` by ${actor}` : '';
    return `PR ${tag} — human review ${verb}${by}.`;
  }
  throw new Error(`renderReviewNotice: unknown event "${event}" — must be one of ${Object.values(REVIEW_NOTICE_EVENTS).join(', ')}`);
}

/**
 * Render the `closing-session` "Flow improvements" line (#2433) — step 3d of
 * `we:skills-src/closing-session/SKILL.md`: 1-3 concrete, named candidates for making the review/PR flow
 * stronger or cheaper next time, or the fixed `"nothing to flag"` fallback. Pure — the session still does the
 * JUDGMENT of which candidates qualify and where each routes (#51: judgment stays in context); this only
 * renders the already-decided list into the one fixed line the close-audit template requires, so the wording
 * (and the fallback) is never hand-retyped per close.
 * @param {{candidates?: Array<{summary: string, route?: 'backlog'|'memory', target?: string}>}} [o]
 * @returns {string}
 */
export function renderCloseSessionFlowLine({ candidates = [] } = {}) {
  if (!candidates.length) return 'nothing to flag';
  return candidates
    .map((c) => `${c.summary}${c.target ? ` → ${c.route ?? 'backlog'} (${c.target})` : c.route ? ` → ${c.route}` : ''}`)
    .join('; ');
}

/**
 * ============================================================================
 * THE ROSTER COMPLETENESS CRITIC — red-team the jury SELECTION (#2637, under jury cluster #2636).
 * ============================================================================
 *
 * Distinct from the red-JUDGE (#2652, which red-teams the DISPOSITION — the verdict a jury reaches) and from the
 * INDEPENDENT FINAL VALIDATOR (#2439, which re-judges the final DIFF): this red-teams the ROSTER ITSELF — "is the
 * jury complete? are the right lenses present for what this subject is?" — BEFORE the fan-out. The resolver
 * (`resolveJuryPlan`) picks a roster from `care-level + touch-set`, and the F3 override layer (#2655) can add or
 * REMOVE seats on top; either can leave a failure axis unguarded (an override strips the a11y seat off a UI
 * change; a hot-path edit that isn't a whole-page file never earns the perf lens). This section adds one cheap
 * completeness pass that runs wherever a roster is resolved — at prepare AND again at open — and whatever it
 * surfaces is folded back onto the roster (via the same minimal-override path, #2655) before the jury runs.
 *
 * Two teeth, same as the jury's other red-team pairs (#2438's plan handshake, #2439's validator):
 *   1. `critiqueRosterCompleteness` — the PURE, always-on, deterministic backstop. It compares the roster's
 *      seated lenses against the lenses the subject EARNS (the mandatory axes + the touch-set's perspective
 *      lenses) and reports every earned-but-absent lens as a gap. This catches the mechanically-detectable
 *      misses — an override that removed a needed lens, a resolver that never attached one — with no model call.
 *   2. `buildRosterCritiqueMandate` — the ADVERSARIAL subagent pass (the "what failure axis is unguarded here?"
 *      red-team). It catches what path-globs CANNOT: a `.ts` custom element outside a UI-named directory that the
 *      touch-set classifier reads as a script (its own KNOWN GAP), a hot-path edit that earns perf on semantic
 *      grounds no page-glob sees. The pure core builds the mandate; SPAWNING the subagent and reading its
 *      surfaced gaps stays the caller's action (the same judgment/derivation split every mandate builder here keeps).
 *
 * `applyRosterCritique` folds either set of gaps back onto the plan. Aggregation, rigor, and the verdict reducers
 * are all UNCHANGED — this only makes the roster more complete; it never changes how the seated jurors combine.
 */

/** The lens vocabulary the completeness critic draws from (#2637) — every lens a PR-diff roster can carry: the
 *  four static `PANEL_LENSES` plus the three UI `PERSPECTIVE_LENSES`. The adversarial subagent must name a missed
 *  lens by an id from THIS set so what it surfaces is foldable back onto the roster (an out-of-vocabulary "lens"
 *  has no grounding method and no seat). Frozen; derived from the two source sets so it never drifts from them. */
export const ROSTER_CRITIQUE_LENSES = Object.freeze([...PANEL_LENSES, ...Object.values(PERSPECTIVE_LENSES)]);

/** Normalize a roster input to its ordered, de-duplicated list of seated lens ids (#2637). Accepts a `RosterPlan`
 *  (`{ lenses: [{ lens }] }`, what `resolveJuryPlan` returns), a bare `RosterSeat[]`, or a plain `string[]` of lens
 *  ids — so a caller can critique a full plan or just a lens list. Pure; never throws on a malformed entry. */
function rosterLensList(roster) {
  const seats = Array.isArray(roster) ? roster : Array.isArray(roster?.lenses) ? roster.lenses : [];
  const out = [];
  const seen = new Set();
  for (const seat of seats) {
    const lens = typeof seat === 'string' ? seat : seat && typeof seat === 'object' ? seat.lens : null;
    if (typeof lens !== 'string' || !lens.trim()) continue;
    const clean = lens.trim();
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/**
 * @typedef {Object} RosterGap
 * @property {string} lens - a lens the subject EARNS but the roster is missing a seat for.
 * @property {string|null} method - the lens's default grounding method id (`LENS_DEFAULT_METHOD`), or null if none.
 * @property {'mandatory'|'touch-set'} earnedBy - WHY the lens is expected: a mandatory axis every jury guards, or
 *   one the subject's touch-set earned.
 * @property {string} reason - a one-sentence human explanation of the gap.
 */

/**
 * THE PURE COMPLETENESS BACKSTOP (#2637) — red-team a resolved roster for a MISSED lens, deterministically. Pure,
 * no model call. Compares the roster's seated lenses against the lenses the subject EARNS and returns every
 * earned-but-absent lens as a `RosterGap`. The earned set is:
 *   • the MANDATORY lenses (correctness + security) — a non-empty jury must always guard these; and
 *   • the subject's PERSPECTIVE lenses — supplied explicitly as `expectedLenses` (the subject-agnostic seam), or,
 *     for the PR-diff subject, derived from `changedFiles` via `classifyTouchSet` (a11y/visual for a UI file, perf
 *     for a whole page).
 *
 * An EMPTY roster returns NO gaps — an empty roster means care `none` ("nothing escalated, no jury"), and the
 * critic completes an EXISTING roster; it never conjures a jury the care-level deliberately withheld (the same
 * contract `resolveRoster` states: the touch-set only ADDS to an existing panel, never creates one). Each gap
 * carries the lens's default grounding method so `applyRosterCritique` can seat it, plus provenance + a reason.
 *
 * @param {{roster: *, changedFiles?: string[], expectedLenses?: string[], mandatoryLenses?: string[]}} o -
 *   `roster` is a `RosterPlan` / `RosterSeat[]` / lens `string[]`; `expectedLenses`, when given, is the subject's
 *   earned perspective lenses (used verbatim, skipping `classifyTouchSet`); else they are derived from `changedFiles`.
 * @returns {{gaps: RosterGap[], expectedLenses: string[], presentLenses: string[]}}
 */
export function critiqueRosterCompleteness({ roster, changedFiles = [], expectedLenses, mandatoryLenses = MANDATORY_LENSES } = {}) {
  const presentLenses = rosterLensList(roster);
  // An empty roster is care `none` — there is no jury to complete. Report no gaps (never conjure one).
  if (!presentLenses.length) return { gaps: [], expectedLenses: [], presentLenses };

  const mandatory = (Array.isArray(mandatoryLenses) ? mandatoryLenses : []).filter((l) => typeof l === 'string' && l.trim());
  const perspective = Array.isArray(expectedLenses)
    ? expectedLenses.filter((l) => typeof l === 'string' && l.trim())
    : classifyTouchSet(changedFiles).lenses;

  const earnedBy = new Map();                          // lens → 'mandatory' | 'touch-set', mandatory wins ties
  for (const lens of perspective) if (!earnedBy.has(lens)) earnedBy.set(lens, 'touch-set');
  for (const lens of mandatory) earnedBy.set(lens, 'mandatory'); // mandatory first in the ordered expected set below

  // Ordered, unique expected set: mandatory axes first, then the touch-set perspective lenses.
  const expected = [...mandatory, ...perspective.filter((l) => !mandatory.includes(l))]
    .filter((l, i, a) => a.indexOf(l) === i);

  const present = new Set(presentLenses);
  const gaps = expected
    .filter((lens) => !present.has(lens))
    .map((lens) => {
      const why = earnedBy.get(lens);
      const reason = why === 'mandatory'
        ? `"${lens}" is a mandatory lens but the roster has no seat for it — that failure axis is unguarded`
        : `the subject earns the "${lens}" perspective but the roster has no seat for it — that failure axis is unguarded`;
      return { lens, method: LENS_DEFAULT_METHOD[lens] ?? null, earnedBy: why, reason };
    });

  return { gaps, expectedLenses: expected, presentLenses };
}

/**
 * Build the mandate handed to the ADVERSARIAL roster-completeness critic subagent (#2637) — the "what failure
 * axis is unguarded here?" red-team the pure backstop cannot do (it catches the semantic misses no path-glob
 * sees: a custom element authored as a plain script, a hot-path edit that earns perf on grounds no page-glob
 * detects). Pure — returns the instruction string; SPAWNING the subagent and reading the gaps it names stays the
 * caller's action (the same split every mandate builder in this module keeps). The subagent must name each missed
 * lens by an exact id from `ROSTER_CRITIQUE_LENSES`, so what it surfaces is foldable via `applyRosterCritique`.
 * @param {{subjectNoun?: string, roster?: *, availableLenses?: string[]}} [o]
 * @returns {string}
 */
export function buildRosterCritiqueMandate({ subjectNoun = 'change', roster = [], availableLenses = ROSTER_CRITIQUE_LENSES } = {}) {
  const seated = rosterLensList(roster);
  const seatedText = seated.length ? seated.join(', ') : '(none)';
  const availText = (Array.isArray(availableLenses) ? availableLenses : ROSTER_CRITIQUE_LENSES).join(', ');
  return [
    'You are the ROSTER COMPLETENESS CRITIC (#2637) — one cheap adversarial pass that runs BEFORE the jury fans out.',
    `A jury roster has been picked to review this ${subjectNoun}. The lenses currently seated on the roster are: ${seatedText}.`,
    `The full lens vocabulary a roster can draw from is: ${availText}.`,
    `Judge ONE question only: what failure axis is UNGUARDED here — is there a lens the roster SHOULD carry for this`,
    `${subjectNoun} but does NOT (e.g. it forgot accessibility on a UI change, or performance on a hot-path edit)?`,
    'Report each missed lens by its EXACT id from the vocabulary above, with a one-sentence reason it is needed for',
    `this ${subjectNoun}. Do NOT propose a lens already seated, do NOT invent a lens outside the vocabulary, and`,
    'report an EMPTY list if the roster is already complete — do not pad it to look thorough.',
    'You judge only: you NAME the gaps; adding the surfaced lenses to the roster is the caller\'s action, not yours.',
  ].join(' ');
}

/**
 * Fold the gaps a completeness critic surfaced (from `critiqueRosterCompleteness`, the adversarial subagent, or
 * both) back onto a resolved roster plan (#2637) — so the jury runs against the COMPLETED roster. Pure — returns a
 * NEW plan, never mutates its input. Each gap's `lens` becomes a minimal `ADD` override applied through the F3
 * override machinery (`applyRosterOverrides`, #2655): a critique-surfaced lens is exactly a minimal deviation from
 * the stateless recompute, so it rides the same trailed-override path (seat provenance `attachedBy: 'override'`)
 * rather than a parallel one — and adding an already-seated lens is a no-op there (idempotent), so folding the
 * same gaps twice is safe. Accepts gap objects (`{ lens, method }`) or bare lens id strings.
 *
 * GROUNDING: an explicit `resolveMethods` (when given) always wins. When it is OMITTED, the fold self-grounds from
 * each gap's own `method` (which `critiqueRosterCompleteness` already computed via `LENS_DEFAULT_METHOD`), so
 * `applyRosterCritique(plan, gaps)` seats the surfaced lens WITH its default grounding, not a bare ungrounded seat,
 * without the caller re-injecting the same registry. A bare-string gap carries no method, so it seats ungrounded.
 * @param {import('./jury-core.mjs').RosterPlan} plan - a `resolveJuryPlan` / `resolveRoster` output.
 * @param {Array<{lens: string, method?: string|null}>|string[]} [gaps] - the surfaced gaps (or bare lens ids) to seat.
 * @param {{resolveMethods?: (lens: string) => string[]}} [o] - grounds each added lens; overrides the self-grounding.
 * @returns {import('./jury-core.mjs').RosterPlan}
 */
export function applyRosterCritique(plan, gaps = [], { resolveMethods } = {}) {
  const list = Array.isArray(gaps) ? gaps : [];
  // Self-grounding fallback: map each gap lens to its own computed method, used only when no resolver is injected.
  const methodByLens = new Map();
  for (const g of list) {
    if (g && typeof g === 'object' && typeof g.lens === 'string' && typeof g.method === 'string' && g.method.trim()) {
      methodByLens.set(g.lens.trim(), g.method.trim());
    }
  }
  const ground = typeof resolveMethods === 'function'
    ? resolveMethods
    : (lens) => (methodByLens.has(lens) ? [methodByLens.get(lens)] : []);
  const overrides = list
    .map((g) => (typeof g === 'string' ? g : g && typeof g === 'object' ? g.lens : null))
    .filter((lens) => typeof lens === 'string' && lens.trim())
    .map((lens) => ({ op: ROSTER_OVERRIDE_OPS.ADD, lens: lens.trim() }));
  return applyRosterOverrides(plan, overrides, { resolveMethods: ground });
}

/**
 * ============================================================================
 * JUROR-INVITE-ON-DISCOVERY — grow the jury mid-review, only with reason (#2640, under jury cluster #2636).
 * ============================================================================
 *
 * A juror mid-review can DISCOVER a failure axis no seated lens fully guards — the classic case is a correctness
 * reviewer noticing a security hole, but it generalizes: any juror that finds concrete evidence of an UNGUARDED
 * (or under-staffed) axis can INVITE another lens/method onto the panel. This is the run-TIME counterpart to the
 * prepare-time roster critic (#2637, which red-teams completeness BEFORE the fan-out): #2637 asks "is the roster
 * complete for what this subject IS?"; this asks "did a juror find something mid-review that PROVES the roster is
 * missing a seat?". The model is the three-step the spec names — the discovery RAISES the care level → RECOMPUTE
 * the rigor at the raised band → spawn only the DELTA (the seats the raised band earns that are not already
 * sitting) — so a jury that grows does so through the SAME care→rigor dial (`raiseCareForDiscovery` →
 * `panelRigorForCareLevel`) everything else uses, never an ad-hoc "add a reviewer" path.
 *
 * Three guardrails keep it growing ONLY WITH REASON (the spec's own list):
 *   1. CITE THE FINDING — an invite must carry the finding that justifies it (`citedFinding`); an ungrounded
 *      invite is rejected (`reason: 'ungrounded'`). Growth is always anchored to concrete evidence, never a hunch.
 *   2. SPENDS A ROUND-TRIP, NEVER RESETS THE COUNTER — an accepted invite costs one negotiation round and the
 *      caller advances the round counter FORWARD (it is never reset). `spendsRound` is always `true` to say so.
 *      A chain of invites therefore cannot dodge the round cap by restarting the budget — N invites cost N rounds
 *      against the SAME `roundCap`, and the caller escalates once the cap is hit (the loop enforces the advance;
 *      this pure fn only states the contract).
 *   3. THE PER-CARE-BAND CEILING BOUNDS TOTAL JURORS — `raiseCareForDiscovery` caps the raise at
 *      `INVITE_CARE_CEILING` (the top band), so `jurorsPerLens` can never exceed the high band's dial, and the
 *      lens set is drawn from a FINITE vocabulary. Total jurors is therefore bounded no matter how many invites
 *      fire — once at the ceiling an invite that adds no new lens is a no-op (`atCeiling: true`, not accepted).
 *
 * PURE (the care recompute + the delta). SPAWNING the invited juror is the CALLER's action — the review-parked-prs
 * convergence loop (#2639) does that; this module only decides WHETHER the invite is grounded and, if so, WHAT
 * delta to spawn (the same judgment/derivation split every builder in this module keeps).
 */

/** The care band an invite can never raise past (#2640) — the top of `CARE_LEVEL_ORDER`. This IS the per-care-band
 *  juror ceiling (guardrail 3): since `panelRigorForCareLevel` dials `jurorsPerLens` off the band and
 *  `raiseCareForDiscovery` caps every raise here, no chain of invites can grow the per-lens jury past this band's
 *  dial. A tuning knob (exported, not a scattered literal). */
export const INVITE_CARE_CEILING = CARE_LEVELS.HIGH;

/**
 * Raise the care level one band for a discovery (#2640), capped at `INVITE_CARE_CEILING`. Pure. A juror's
 * discovery of an unguarded/under-staffed failure axis bumps care up exactly one band (`none → low → elevated →
 * high`) and NEVER past `high` — that cap is guardrail 3 (the per-care-band juror ceiling). Throws on an unknown
 * care level (same discipline as `panelRigorForCareLevel`) so a typo surfaces loudly rather than silently
 * skipping the raise.
 * @param {'none'|'low'|'elevated'|'high'} careLevel
 * @returns {'low'|'elevated'|'high'}
 */
export function raiseCareForDiscovery(careLevel) {
  const idx = CARE_LEVEL_ORDER.indexOf(careLevel);
  if (idx === -1) {
    throw new Error(`raiseCareForDiscovery: unknown care-level "${careLevel}" — must be one of ${CARE_LEVEL_ORDER.join(', ')}`);
  }
  const ceilingIdx = CARE_LEVEL_ORDER.indexOf(INVITE_CARE_CEILING);
  return CARE_LEVEL_ORDER[Math.min(idx + 1, ceilingIdx)];
}

/**
 * @typedef {Object} InviteDelta
 * @property {string} lens - the lens the added seat(s) judge under.
 * @property {string|null} method - the lens's default grounding method id (`LENS_DEFAULT_METHOD`), or null if none.
 * @property {number} addedJurors - how many NEW jurors this seat spawns (a whole new lens seats the full per-lens
 *   count; an already-seated lens gains only the raised band's per-lens increase).
 * @property {'new-lens'|'more-jurors'} kind - whether the delta seats a lens the roster lacked, or extra jurors on
 *   an already-seated lens.
 */

/**
 * @typedef {Object} JurorInvite
 * @property {boolean} accepted - true iff the invite is grounded, names a known lens, AND yields a non-empty delta.
 * @property {string|null} reason - why an invite was rejected (`ungrounded` | `unknown-lens` | `at-ceiling`), else null.
 * @property {string|null} citedFinding - the finding the invite cited (guardrail 1), echoed for the audit trail.
 * @property {string} fromCareLevel - the care band before the raise.
 * @property {string} toCareLevel - the care band after the raise (capped at `INVITE_CARE_CEILING`).
 * @property {number} jurorsPerLens - the per-lens juror count the raised band dials (the per-lens ceiling).
 * @property {InviteDelta[]} addedLenses - the DELTA to spawn; empty when the invite adds nothing (already at the ceiling).
 * @property {string[]} seatedLenses - the resulting roster lens set (current ∪ invited), de-duplicated.
 * @property {boolean} atCeiling - true when no delta could be added (the ceiling is already fully seated).
 * @property {true} spendsRound - always true (guardrail 2): the caller MUST advance the round counter and never reset it.
 */

/**
 * Derive the jury-growth DELTA for a mid-review juror invite (#2640) — the pure "care recompute + delta" half of
 * juror-invite-on-discovery. Pure. Applies the three guardrails above and returns a `JurorInvite`:
 *   • Guardrail 1 (CITE THE FINDING): a missing/blank `citedFinding` → `{ accepted:false, reason:'ungrounded' }`.
 *   • The invited lens must be a known lens in the vocabulary (`availableLenses`, default `ROSTER_CRITIQUE_LENSES`)
 *     — an out-of-vocabulary "lens" has no grounding method and no seat → `{ accepted:false, reason:'unknown-lens' }`.
 *   • Guardrail 3 (CEILING): the raised band is `raiseCareForDiscovery(careLevel)` (capped at `INVITE_CARE_CEILING`);
 *     `jurorsPerLens` is that band's dial. The DELTA is a newly-invited lens (seating the full per-lens count) plus,
 *     when the raised band's per-lens dial ROSE, the increase on each already-seated lens. When the delta is empty
 *     (an at-ceiling invite for a lens already fully seated) → `{ accepted:false, reason:'at-ceiling', atCeiling:true }`.
 *   • Guardrail 2 (ROUND): `spendsRound` is always true — the caller advances the round and never resets it (a
 *     contract this pure fn states; the loop enforces it).
 * The recompute (`fromCareLevel`/`toCareLevel`/`jurorsPerLens`) rides EVERY return path — even a rejection — so a
 * caller can see where the ceiling sat regardless of the outcome.
 * @param {{careLevel: string, seatedLenses?: string[], jurorsPerLens?: number, invitedLens?: string,
 *   citedFinding?: string, availableLenses?: string[]}} o - `careLevel` is a `CARE_LEVELS` value (an unknown one
 *   throws — via `panelRigorForCareLevel` when `jurorsPerLens` is omitted, else via `raiseCareForDiscovery`);
 *   `seatedLenses` is the roster's current lens set; `jurorsPerLens` is the
 *   current per-lens juror count (defaults to the current band's dial if omitted); `invitedLens` is the axis the
 *   discovery earns; `citedFinding` is the grounding.
 * @returns {JurorInvite}
 */
export function deriveJurorInvite({ careLevel, seatedLenses = [], jurorsPerLens, invitedLens, citedFinding, availableLenses = ROSTER_CRITIQUE_LENSES } = {}) {
  const cited = typeof citedFinding === 'string' ? citedFinding.trim() : '';
  const seated = rosterLensList(seatedLenses);
  const currentPerLens = Number.isInteger(jurorsPerLens) && jurorsPerLens > 0
    ? jurorsPerLens
    : panelRigorForCareLevel(careLevel).jurorsPerLens;

  // The raised band + its dial — computed up front so every return path (even a rejection) carries the recompute.
  // `raiseCareForDiscovery` throws on an unknown care level (loud, not silent).
  const toCareLevel = raiseCareForDiscovery(careLevel);
  const raisedPerLens = panelRigorForCareLevel(toCareLevel).jurorsPerLens;

  const base = {
    citedFinding: cited || null,
    fromCareLevel: careLevel,
    toCareLevel,
    jurorsPerLens: raisedPerLens,
    seatedLenses: seated,
    spendsRound: true,
  };

  // Guardrail 1 — CITE THE FINDING. An ungrounded invite never grows the jury.
  if (!cited) return { ...base, accepted: false, reason: 'ungrounded', addedLenses: [], atCeiling: false };

  // The invited lens must be a known lens (else no grounding method, no seat).
  const vocab = (Array.isArray(availableLenses) && availableLenses.length) ? availableLenses : ROSTER_CRITIQUE_LENSES;
  const lens = typeof invitedLens === 'string' ? invitedLens.trim() : '';
  if (!lens || !vocab.includes(lens)) {
    return { ...base, accepted: false, reason: 'unknown-lens', addedLenses: [], atCeiling: false };
  }

  // The DELTA (guardrail 3 bounds it): a newly-invited lens seats the full per-lens count; each already-seated
  // lens gains ONLY the increase if the raised band's dial rose (never a re-seat of jurors it already has).
  const seatedSet = new Set(seated);
  const addedLenses = [];
  if (!seatedSet.has(lens)) {
    addedLenses.push({ lens, method: LENS_DEFAULT_METHOD[lens] ?? null, addedJurors: raisedPerLens, kind: 'new-lens' });
  }
  const bump = raisedPerLens - currentPerLens;
  if (bump > 0) {
    for (const l of seated) {
      addedLenses.push({ lens: l, method: LENS_DEFAULT_METHOD[l] ?? null, addedJurors: bump, kind: 'more-jurors' });
    }
  }
  const resultSeated = seatedSet.has(lens) ? seated : [...seated, lens];

  // Guardrail 3 — nothing to add means the ceiling is already fully seated (an at-`high` invite for a lens that is
  // already sitting at the band's full juror count): a no-op, not a growth.
  if (!addedLenses.length) {
    return { ...base, accepted: false, reason: 'at-ceiling', addedLenses: [], atCeiling: true, seatedLenses: resultSeated };
  }
  return { ...base, accepted: true, reason: null, addedLenses, atCeiling: false, seatedLenses: resultSeated };
}

/**
 * ============================================================================
 * THE JUROR-INVITE LOOP GUARDS — grow-only, gate-self hardening (#2640).
 * ============================================================================
 *
 * `deriveJurorInvite` above is grow-only BY CONSTRUCTION (its `seatedLenses` is `current ∪ invited` and its
 * `jurorsPerLens` is the raised band's dial ≥ current). But the parked-PR review loop
 * (`we:scripts/workflows/review-parked-prs.mjs`) runs the CLI inside an AGENT — a harness sandbox that cannot
 * `import` this module — and an agent's ECHO of the growth cannot be trusted (a prompt-injected/misbehaving invite
 * agent could echo a SHRUNK roster/count and drop the mandatory correctness/security lenses, letting a diff land
 * with no security review). These three pure guards are the SPEC the loop enforces from its OWN state to neutralize
 * a bad echo. They live here (tested) and are MIRRORED inline in the sandbox loop (which cannot import them) — the
 * same "mirror a tested literal/shape, no import in the sandbox" pattern the loop already uses for the ceiling.
 */

/**
 * Grow-only ROSTER union (#2640) — the next active roster is ALWAYS a SUPERSET of the current one: current lenses ∪
 * the invited lens ∪ any echoed added lenses, de-duplicated. So no seated lens (least of all a mandatory one) can be
 * dropped mid-loop, whatever a shrunk/echoed roster claims. Pure.
 * @param {string[]} currentLenses - the roster the loop currently seats.
 * @param {string} invitedLens - the lens the accepted invite earns.
 * @param {string[]} [addedLenses] - lens names the invite agent echoed as added (advisory — only ever grows).
 * @returns {string[]} the grow-only union.
 */
export function growOnlyRoster(currentLenses = [], invitedLens = '', addedLenses = []) {
  const cur = Array.isArray(currentLenses) ? currentLenses.filter((l) => typeof l === 'string' && l) : [];
  const added = Array.isArray(addedLenses) ? addedLenses.filter((l) => typeof l === 'string' && l) : [];
  const inv = typeof invitedLens === 'string' && invitedLens ? [invitedLens] : [];
  return [...new Set([...cur, ...inv, ...added])];
}

/**
 * Grow-only CARE BAND after an accepted invite (#2640, hardened by the PR #1106 review). Pure.
 *
 * The loop takes the raised band from the invite agent's `toCareLevel` — an UNVALIDATED agent string that no
 * `CARE_LEVEL_ORDER` filter ever saw. Since #2908 that band is write-authorizing (it feeds the editor gate), so
 * the loop must not depend on the echo being honest about it. It does not have to: an accepted invite raises
 * care by EXACTLY ONE BAND, capped at `INVITE_CARE_CEILING` (`raiseCareForDiscovery`), so the loop can compute
 * the raise ITSELF and use the echo only where it is safe — to raise FURTHER.
 *
 *   • `current` is not a known band → `null` (UNRESOLVED). An echo may never RESOLVE an unresolved band; that
 *     direction is the fail-open (`null` can satisfy no gate, a resolved band might).
 *   • otherwise the result is at least `raiseCareForDiscovery(current)`, and the echoed band only if it is a
 *     known band ABOVE that. So the echo can raise care, never lower it, and never hold it flat.
 *
 * @param {string|null} current - the band the loop currently holds.
 * @param {string|null} echoed - the invite agent's `toCareLevel` (untrusted).
 * @returns {string|null} the band the loop adopts, or `null` when it cannot be resolved.
 */
export function growOnlyCareLevel(current, echoed) {
  if (!CARE_LEVEL_ORDER.includes(current)) return null;
  const raised = raiseCareForDiscovery(current);
  const rank = (l) => CARE_LEVEL_ORDER.indexOf(l);
  return (CARE_LEVEL_ORDER.includes(echoed) && rank(echoed) > rank(raised)) ? echoed : raised;
}

/**
 * Grow-only per-lens JUROR count (#2640) — floor an accepted invite's per-lens count at the CURRENT count (an invite
 * may only GROW the panel, never shrink it) and cap it at the ceiling. So an echoed `1` cannot shrink a 2-juror
 * panel. Pure.
 * @param {number} current - the current per-lens juror count.
 * @param {number} proposed - the count the invite agent echoed.
 * @param {number} ceiling - the per-care-band ceiling (top band's dial). In the loop `ceiling >= current` always (the
 *   current count is dialed off a care band at or below the top), so the floor is never overridden by the cap.
 * @returns {number} `min(ceiling, max(current, proposed))` — floored at `current` (never below it while
 *   `ceiling >= current`) and capped at `ceiling`.
 */
export function floorGrowOnlyJurors(current, proposed, ceiling) {
  const cur = Number.isFinite(Number(current)) && Number(current) >= 1 ? Math.floor(Number(current)) : 1;
  const prop = Number.isFinite(Number(proposed)) && Number(proposed) >= 1 ? Math.floor(Number(proposed)) : cur;
  const cap = Number.isFinite(Number(ceiling)) && Number(ceiling) >= 1 ? Math.floor(Number(ceiling)) : cur;
  return Math.min(cap, Math.max(cur, prop));
}

/**
 * The MANDATORY lenses ABSENT from a round's results (#2640) — a mandatory lens degrades the round to needs-human if
 * it is not PRESENT-and-OK, whether it ran-and-errored OR was never scheduled at all. Keying the safety net on
 * failed-lenses alone missed the never-scheduled case (a shrunk roster that never ran a mandatory lens saw zero
 * failures and could reduce to accept → land). Deriving from the OK set closes that. Pure.
 * @param {string[]} ranOkLenses - the lenses that RAN and produced a verdict this round.
 * @param {string[]} [mandatory] - the mandatory lens set (default the core `MANDATORY_LENSES`).
 * @returns {string[]} the mandatory lenses absent from `ranOkLenses`.
 */
export function absentMandatoryLenses(ranOkLenses = [], mandatory = MANDATORY_LENSES) {
  const ranSet = new Set(Array.isArray(ranOkLenses) ? ranOkLenses.filter((l) => typeof l === 'string' && l) : []);
  return (Array.isArray(mandatory) ? mandatory : []).filter((l) => !ranSet.has(l));
}

/** Fail-closed diffBasis degrade check (#2914). Mirrors the field's own producer
 *  (we:scripts/fetch-parked.mjs assembleParked) and the fetch prompt's own instruction: anything other than
 *  the literal string 'net' -- undefined, '', 'three-dot', or an invented value -- reads as degraded. An
 *  unstated basis must never read as the good one. */
export function isDiffBasisDegraded(diffBasis) {
  return diffBasis !== 'net';
}

/**
 * ============================================================================
 * THE PREPARE-TIME JURY CHARTER — pre-register the jury + expectations (#2638, under jury cluster #2636).
 * ============================================================================
 *
 * The EARLY-HUMAN-ALIGNMENT gate (a settled #2636 design call). Everything above resolves and red-teams the jury
 * at PR-OPEN — AFTER the code is written. This section moves a PROVISIONAL copy of that same jury EARLIER, to
 * prepare/claim time, so the human aligns on the review bar BEFORE any code exists. Two things the pre-registration
 * buys, both from #2636's body: (1) the human sees WHO will judge the eventual PR and to WHAT bar, and can push
 * back on the bar while it is still cheap to change; (2) the up-front expectations are a COMMITMENT that kills
 * post-hoc goalpost-moving — a juror cannot invent a new bar at review time that was never pre-registered.
 *
 * CARE-GATED. Aligning every juror up front is real human cost, so the charter is authored ONLY for an
 * elevated/high-care item and SKIPPED for low/none — the SAME care dial that sizes rigor (`panelRigorForCareLevel`)
 * decides whether the charter is worth writing at all. `shouldRegisterJury` is that gate; `buildJuryCharter`
 * returns an un-registered charter (carrying the skip reason) below the floor rather than throwing, so a caller can
 * always call it and render whatever comes back.
 *
 * The provisional roster is derived from the SAME resolver the open-time jury uses (`resolveJuryPlan` →
 * `materializeRoster`), so the pre-registered jury IS the real jury, not a parallel guess — only PROVISIONAL
 * because it binds against the item's PREDICTED touch-set (its `scope:`), not a real diff, and #2636 re-checks it
 * against the actual diff at open (drift past registration re-triggers alignment). Each juror's charter here IS its
 * pre-registered EXPECTATION — the concrete bar that lens will hold, single-sourced in `LENS_EXPECTATIONS` so the
 * same wording is what the human aligns on now and what the juror is later held to.
 */

/** The care level at/above which a jury charter is worth pre-registering (#2638). Below it (low/none) the up-front
 *  alignment cost isn't earned — the item ships to the open-time jury without a pre-registered charter. A tuning
 *  knob (exported, not a scattered literal): re-floor in one edit + a test. */
export const JURY_CHARTER_CARE_FLOOR = CARE_LEVELS.ELEVATED;

/**
 * Each lens's UP-FRONT EXPECTATION (#2638) — the concrete bar that lens commits to hold, pre-registered so the
 * human aligns on it before code and the juror is later held to exactly this (no post-hoc goalpost-moving). One
 * generalized sentence per lens, covering every lens a PR-diff roster can seat (`PANEL_LENSES` + `PERSPECTIVE_LENSES`).
 * Pure data — the wording IS the commitment, single-sourced so the charter the human sees and the mandate the juror
 * later runs never drift. Frozen.
 */
export const LENS_EXPECTATIONS = Object.freeze({
  [MANDATE_LENSES.CORRECTNESS]: 'The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong.',
  [MANDATE_LENSES.SECURITY]: 'No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check.',
  [MANDATE_LENSES.CLAIM_ACCURACY]: 'Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff.',
  [MANDATE_LENSES.SIMPLICITY]: 'The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction.',
  [MANDATE_LENSES.STANDARDS]: "The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule.",
  [PERSPECTIVE_LENSES.A11Y]: 'The rendered UI passes an accessibility scan and stays keyboard-reachable with correct roles and labels — no new accessibility regression.',
  [PERSPECTIVE_LENSES.VISUAL]: 'The rendered UI matches its target/baseline design in both light and dark themes — no unintended visual drift.',
  [PERSPECTIVE_LENSES.PERF]: 'The page stays within its load budget — the change adds no new render-blocking cost or hot-path regression.',
});

/**
 * WHAT A LENS ACTUALLY HUNTS, and how it must ground a finding (#3035). `LENS_EXPECTATIONS` states the BAR;
 * this states the METHOD — the concrete shapes to go looking for and the check that settles each one. A lens
 * whose value is knowing where to look is close to useless without it: the mandate otherwise carries only the
 * lens NAME, and a juror handed the bare word "claim-accuracy" invents its own reading of the job.
 *
 * Only lenses whose method is non-obvious carry an entry; the rest fall through to no extra text.
 */
export const LENS_HUNT_BRIEF = Object.freeze({
  [MANDATE_LENSES.CLAIM_ACCURACY]: [
    'YOUR LENS IS: does the WRITING match what it points at. The code may be perfectly correct and this lens',
    'can still return findings — you are judging the claims made ABOUT the repo, wherever they appear: backlog',
    'card bodies, "Done when" criteria, docs, agent-memory notes, code comments, and the PR description itself.',
    'GO LOOKING FOR THESE SHAPES, in roughly this order of past frequency:',
    '  1. A `path:line` citation that does not name what is at that line — the file and line resolve, but the',
    '     function, constant or behaviour described is somewhere else. Off-by-one is common; so is a citation',
    '     that was right when written and drifted when the file moved.',
    '  2. An acceptance criterion written as a grep whose literal does not actually match — markup the author',
    '     forgot (`**bold**`, backticks), a capitalisation difference, or a stated occurrence count that is wrong.',
    '  3. A criterion that ALREADY passes before the work is done, so it proves nothing.',
    '  4. A claim that the change records/updates/prepares something, where the diff never touches that file.',
    '  5. An absolute gate count ("the 1435-warning baseline") hardcoded as a target, already stale.',
    '  6. A reference that resolves to nothing — a `[[wikilink]]`, a `#id`, "clause 3 above", "option (d)".',
    'HOW TO GROUND A FINDING — this is the lens\'s equivalent of the mutation probe, and it is REQUIRED. Do not',
    'report a claim as wrong because it reads wrong. RESOLVE IT: run the grep, open the file at the cited line,',
    'list the diff. Then state in the finding what you ran and what came back. A claim-accuracy finding with no',
    'resolution behind it is exactly the error it is reporting, and will be treated as such.',
    'SAY SO WHEN A CLAIM CHECKS OUT. If you resolved a citation and it held, that is worth one line — it tells',
    'the reader which claims were actually verified rather than skimmed.',
    'DO NOT report prose you merely find unclear, verbose, or badly worded. Wrong-against-the-source is the bar;',
    'style is another lens\'s job.',
  ].join('\n'),
});

/** The hunt brief for one lens, or `''` for a lens with none. Pure. */
export function huntBriefForLens(lens) {
  return LENS_HUNT_BRIEF[lens] || '';
}

/** The pre-registered expectation for one lens (#2638) — its `LENS_EXPECTATIONS` entry, or a neutral fallback for a
 *  lens with no registered bar (so `materializeRoster`'s `charterForLens` never yields an empty string). Pure. */
export function expectationForLens(lens) {
  return LENS_EXPECTATIONS[lens] || `hold the "${lens}" bar for this change`;
}

/**
 * Is an item's care level high enough to pre-register a jury charter (#2638)? Pure. True for elevated/high (at or
 * above `JURY_CHARTER_CARE_FLOOR`), false for low/none. Throws on an unknown care level (same discipline as
 * `panelRigorForCareLevel`) so a typo'd band surfaces loudly rather than silently skipping the charter.
 * @param {'none'|'low'|'elevated'|'high'} careLevel
 * @returns {boolean}
 */
export function shouldRegisterJury(careLevel) {
  const idx = CARE_LEVEL_ORDER.indexOf(careLevel);
  if (idx === -1) {
    throw new Error(`shouldRegisterJury: unknown care-level "${careLevel}" — must be one of ${CARE_LEVEL_ORDER.join(', ')}`);
  }
  return idx >= CARE_LEVEL_ORDER.indexOf(JURY_CHARTER_CARE_FLOOR);
}

/**
 * @typedef {Object} JuryCharter
 * @property {string} careLevel - the item's care band the charter was built for.
 * @property {boolean} registered - true when the jury was pre-registered (care ≥ floor); false when skipped below it.
 * @property {string} [reason] - why the charter was skipped (present only when `registered` is false).
 * @property {Array<{id: string, lens: string, method?: string, expectation: string}>} jurors - the provisional
 *   jury; each juror's `expectation` is its pre-registered bar. Empty when the charter was skipped.
 */

/**
 * Build the PROVISIONAL jury charter for an item at prepare/claim time (#2638) — the pre-registered jury + each
 * juror's up-front expectation the human aligns on BEFORE any code is written. Pure. Care-gated: below the
 * `JURY_CHARTER_CARE_FLOOR` (low/none) it returns an un-registered charter carrying the skip reason (it does NOT
 * throw on a below-floor band — the caller renders the skip note); at/above it, the provisional roster is derived
 * from the SAME `resolveJuryPlan` → `materializeRoster` the open-time jury uses, with each juror's charter set to
 * its `expectationForLens` bar. PROVISIONAL because it binds against the item's PREDICTED touch-set (`changedFiles`,
 * from the item's `scope:`), not a real diff — #2636 re-binds and re-aligns against the actual diff at open.
 * @param {{careLevel: string, changedFiles?: string[]}} o - `careLevel` is a `CARE_LEVELS` value; `changedFiles` is
 *   the item's predicted touch-set (repo-relative paths from its `scope:`). An unknown care-level throws (via
 *   `shouldRegisterJury`).
 * @returns {JuryCharter}
 */
export function buildJuryCharter({ careLevel, changedFiles = [] } = {}) {
  if (!shouldRegisterJury(careLevel)) {
    return {
      careLevel,
      registered: false,
      reason: `care "${careLevel}" is below the "${JURY_CHARTER_CARE_FLOOR}" floor — no jury pre-registered (the up-front alignment cost isn't earned)`,
      jurors: [],
    };
  }
  const plan = resolveJuryPlan({ careLevel, changedFiles });
  // Reuse the open-time materializer with the expectation as the juror charter, then surface it under the
  // item's own vocabulary (`expectation`) — the field the human aligns on and the juror is later held to.
  const jurors = materializeRoster(plan, { charterForLens: expectationForLens })
    .map(({ charter, ...rest }) => ({ ...rest, expectation: charter }));
  return { careLevel, registered: true, jurors };
}

/**
 * Render a jury charter (#2638) as the markdown ARTIFACT embedded on the item body at prepare time — what the human
 * reads to align on the review bar. Pure. A skipped (below-floor) charter renders one italic note naming the care
 * level; a registered charter renders a heading, the care band, and a table of
 * juror | lens | grounding method | pre-registered expectation. The `#2638` marker in the heading lets a later pass
 * (open-time re-alignment) find and refresh the block.
 * @param {JuryCharter} charter
 * @returns {string} markdown.
 */
export function renderJuryCharter(charter) {
  const c = charter || {};
  if (!c.registered) {
    return `_No review jury pre-registered — care level \`${c.careLevel ?? '(unknown)'}\` is below the \`${JURY_CHARTER_CARE_FLOOR}\` floor (#2638)._`;
  }
  const rows = (Array.isArray(c.jurors) ? c.jurors : []).map(
    (j) => `| ${j.id} | ${j.lens} | ${j.method ?? '—'} | ${j.expectation} |`,
  );
  return [
    '### Review jury (provisional — pre-registered #2638)',
    '',
    `Care level: \`${c.careLevel}\`. This jury binds against the item's predicted scope and is re-checked against the real diff at PR open.`,
    '',
    '| juror | lens | grounding method | pre-registered expectation |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

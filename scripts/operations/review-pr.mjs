import { requiresMandatoryReferral, laterRoundAdvisoryScopeFromEnv, classifyLaterRoundAdvisory, explainPanelOutcome, foldUntrusted,
  referralKeyFinding, findingIdentityEntry, bindFindingIds } from '../lib/jury-core.mjs';
/**
 * @file scripts/operations/review-pr.mjs
 * @description THE `review-pr` DECLARATION — the first real operation on the engine (#3035, under epic #3029).
 *
 * ONE DECLARATION, DERIVED CALLERS. Per the statute
 * [#operations-declared-once-callers-generated](../../docs/agent/platform-decisions.md#operations-declared-once-callers-generated)
 * (#3031), the review operation is declared HERE, once, and every caller is generated from it:
 * {@link ./cli-adapter.mjs} is the command-line one (#3035), the HTTP one is #3036 (**open**, not built here).
 *
 * IT RE-DECLARES; IT DOES NOT RE-IMPLEMENT. Every step below delegates to a script that already owns its logic:
 *
 *   | step             | kind      | the implementation behind it                                                |
 *   |------------------|-----------|-----------------------------------------------------------------------------|
 *   | `read`           | `compute` | `we:scripts/review-detail.mjs#assembleReviewDetail` (park context) + the      |
 *   |                  |           | NET-basis `computeNetDiffText`/`computeNetDiffPaths` (`merge-ai-prs.mjs`,     |
 *   |                  |           | #2450)                                                                       |
 *   | `judge`          | `judge`   | `buildPanelMandate` (`we:scripts/lib/review-core.mjs`) shaping a `judgeSpawn` |
 *   |                  |           | request (`we:scripts/lib/judge-spawn.mjs`, #3028) — DECLARED, never spawned   |
 *   | `judgeSecurity`  | `judge`   | THE SAME recipe at the `security` lens (#3319) — a SECOND, structurally       |
 *   |                  |           | distinct juror, blind to the first                                           |
 *   | `reduce`         | `compute` | `derivePanelVerdict` + `buildPanelFindings` (`we:scripts/lib/jury-core.mjs`); |
 *   |                  |           | `humanRequired` off the LABELS                                               |
 *   | `advise`         | `effect`  | (#xlw02hw) `renderAdvisoryNote` — an AUTOMATIC, non-recording PR comment on   |
 *   |                  |           | a `review:human` PR only; `[]` (no-op) on every other PR — DECLARED only      |
 *   | `confirm`        | `confirm` | the engine SUSPENDS — the human stop, as machinery instead of prose           |
 *   | `stageVerdict`   | `effect`  | (#3540) `planRecordDecision` — stages the write-up LOCALLY, no `gh` needed    |
 *   | `record`         | `effect`  | `decideSetLabel` (`we:scripts/review-set-label.mjs`) + `renderPanelComment`   |
 *   |                  |           | (`we:scripts/lib/review-render.mjs`) + `renderReviewNotice` — DECLARED only   |
 *
 * If a reader finds review LOGIC in this file rather than a call into one of those, that is the bug.
 *
 * ── `advise`: THE PRE-HUMAN-CEREMONY ADVISORY NOTE (#xlw02hw) ──────────────────────────────────────────────────
 *
 * THE GAP THIS STEP CLOSES. Before this step existed, the ONLY thing that ever posted anything to a PR was
 * `record`, which runs only once `confirm` has a real answer. For a `review:human` PR reviewed by a session
 * running independently of the `/review` human ceremony — no operator to answer `confirm` at all — there was NO
 * answer that could ever reach `record` and produce a comment: `accept` is refused by `decideSetLabel`
 * (INVARIANT 2, correct and untouched by this item), `changes` would apply the real human-ceremony bounce with
 * no human behind it, and `abstain` — the only answer an advisory-only pass could honestly give — makes
 * `record`'s `effects` fn return `[]`. Observed live twice (PRs #1814/#1815, 2026-09-01/02): a juror ran, found
 * real findings, and NOTHING was ever written anywhere, because every reachable path through `confirm`/`record`
 * for this PR type was either refused or vacuous.
 *
 * WHY A NEW STEP, PLACED BEFORE `confirm`, RATHER THAN WIDENING `record`'s `abstain` CASE. `confirm` is a real
 * suspend — the engine stops the run and prints a question — and the whole failure mode this item exists to fix
 * is a session that never reaches an operator to answer it. Widening `abstain` fixes nothing for a run that
 * never gets that far. `advise` is an `effect` step (never a `confirm`), so it runs UNCONDITIONALLY as part of
 * ordinary `advance`/`driveRun` progress the moment `reduce` has a verdict — no operator, no `--resume`, no
 * answer of any kind required. On a non-`review:human` PR it declares `[]`, which `advance` resolves inline
 * (see `step-kinds.mjs`'s "effect" case) with no suspend at all — so the `review:pending` path is BYTE-IDENTICAL
 * to before this item: same steps run, same nothing happens until `confirm` is answered.
 *
 * WHY IT MUST NEVER LOOK LIKE `record`'s COMMENT. `renderAdvisoryNote` shares no heading, no `**Decision:**`
 * line and no label-swap payload with `renderVerdictWriteUp` — see its own docblock. It posts through a bare
 * `gh pr comment` (via `we:scripts/lib/review-label-provider.mjs#createGhProvider`'s `postComment`, the same
 * primitive `review-set-label.mjs` itself uses), never through `we:scripts/review-set-label.mjs`, because that
 * single home ALWAYS couples a comment with a label swap (#2644) and this step swaps no `review:*` label, ever.
 *
 * THE `advisory:*` LABEL (the operator's "tag to tell me the advisory accepted"). The note alone left a clean
 * advisory indistinguishable, by label, from a PR never reviewed. So `advise` declares a SECOND effect after the
 * note, `ADVISORY_LABEL`, whose sink (`we:scripts/operations/review-pr-io.mjs`) applies `advisory:accepted` or
 * `advisory:changes` (`we:scripts/lib/advisory-labels.mjs`) and drops `review:pending`. It is deliberately NOT a
 * `decideSetLabel` swap: it never touches `review:human`, never adds `review:accepted`. The outcome it records
 * is the panel's verdict on the admitted findings with the human gate factored OUT ({@link deriveAdvisoryOutcome}),
 * because `verdict.verdict` is `needs-human` for EVERY gate-self PR and so says nothing about the findings.
 *
 * THE RESIDUAL THIS INHERITS, STATED RATHER THAN HIDDEN. `resolvePending` addresses a suspended run's step by
 * the NUMERIC index frozen on `run.pending` at suspend time, and `declarationFor` only refuses a stale run whose
 * cursor now runs PAST the end of a shortened step list — it does not detect a step INSERTED earlier, which
 * shifts every later index. A run that suspended at `confirm` under the six-step declaration and is resumed
 * after this deploy, against the new seven-step one, would resolve against the wrong step. This is not a new
 * class of risk: #3319 inserted `judgeSecurity` the same way, at index 2, with no migration guard either — this
 * item does not introduce the residual, it exercises an already-accepted one. Fixing it for good would be a
 * versioned-declaration or step-name-keyed `pending` record, which is a real, separate item, not this one's bill.
 * #3540 inserts `stageVerdict` between `confirm` and `record` for the same reason and carries the same residual —
 * a run that suspended at `record` before this deploy resolves against `stageVerdict` after it. Not migrated
 * here either, for the reason already given above.
 *
 * ── `stageVerdict`: THE WRITE-UP, STAGED WITH NO `gh` (#3540) ─────────────────────────────────────────────────
 *
 * THE DEADLOCK THIS CLOSES. `record-verdict` (`we:scripts/operations/record-verdict.mjs`) carries a verdict from
 * a host with no GitHub credential to the CI job that has one — but it needs the write-up ALREADY STAGED on
 * disk, and until this step existed the ONLY thing that staged one was `record`'s own effect 0, bundled in the
 * SAME step as effect 1 (the label swap, which shells `gh` and fails on a credential-less host). So reaching the
 * write-up meant answering `confirm` and running `record` in full — which then halted on the label swap it could
 * never complete, leaving a clean accept recorded as an indistinguishable `effect-halted` run (#3540's own
 * reproduction: PR #1961, an agent-reviewable zero-finding accept with no operator to hand the halt to).
 *
 * WHY A NEW STEP AND NOT `advise`. `advise` runs BEFORE `confirm` — it has no `answer` to render a real
 * "Decision: `x`" write-up with, only a provisional advisory note for `review:human` PRs. The write-up
 * `record-verdict` carries has to be the SAME bytes `record`'s label swap posts, and that requires `confirm`'s
 * answer — so the earliest a write-up can honestly exist is right after `confirm`, which is exactly where
 * `stageVerdict` sits.
 *
 * PURE CORE, SHARED, NOT DUPLICATED. `stageVerdict` and `record` both call {@link planRecordDecision} — the
 * SAME pure function, so the write-up `stageVerdict` stages locally and the `bodyFile` `record`'s label swap
 * later posts from disk are guaranteed byte-identical and path-identical, never two independent renders that
 * could drift. INVARIANT 2 (`decideSetLabel`) and the reasonless-bounce guard both live in `planRecordDecision`,
 * so they now refuse at `stageVerdict` — BEFORE the write-up is even staged — rather than at `record`, which is
 * strictly earlier than before, never later.
 *
 * WHAT THIS DOES NOT FIX ON ITS OWN. The review-pr run STILL ends up `awaiting-effect` at `record` on a
 * credential-less host — `record`'s label/ledger/notice effects still need `gh`. The improvement is that the
 * write-up is now a CLEAN, fully-applied, terminal finding on `stageVerdict` before that happens, rather than
 * conflated with the label swap's failure in one step's status. `record-verdict-cli.mjs` (#3540) is what makes
 * calling `record-verdict` alone, with no separate `--resume` of this run, actually reach that clean state.
 *
 * THE EVIDENCE. Across the replayed corpus (`we:scripts/review-corpus/cases`, 92 cases, 87 carrying a lens row)
 * **86 of 87 rows are `correctness`**. `security` ran exactly ONCE — #1457 r2 — and declared exactly ONE
 * finding: the run-store / agent-listing seat-forgery hole at `we:scripts/operations/explore-io.mjs:165`. That
 * single finding is the WHOLE of the evidence that a second lens sees something the incumbent misses, and
 * #3319's own card retracts the inflated version of this count. One finding is a thin case — it is why this
 * ships as the CHEAPEST wiring that keeps the juror as strong as it is today, and not as a panel.
 *
 * THE THREE OPTIONS, AND WHY THIS ONE.
 *
 *   (a) TWO SEQUENTIAL `review-pr` RUNS, orchestrated by the caller. REJECTED. Each run owns a whole `record`
 *       step: two durable PR comments, two label swaps, two `verdict-ledger` rows (ordinal 2 is
 *       `idempotent: false` precisely because a second comment is not the same comment), and
 *       `deriveLoopOutcome` counting `read.priorRounds + 1` TWICE for one review. The verdict story is not
 *       merely unclear — it is two verdicts on one PR with no declared reduction between them, which is the
 *       thing `derivePanelVerdict` exists to be.
 *   (b) WIRE `judgePanel` (`we:scripts/lib/judge-panel.mjs`, #3050). REJECTED, and #3158 is why: its per-seat
 *       call object omits `allowedTools`, so EVERY panel seat is `--tools ''`. Today's single juror is
 *       tool-bearing (see `REVIEW_JUROR_TOOLS`), and `we:scripts/lib/judge-spawn.mjs`'s own header records the
 *       trade — *"The tools ARE the finding mechanism."* Wiring it as-is would swap one juror that can run a
 *       gate, reproduce a hole and mutate a line for several that can only read. #3158 is OPEN; this item does
 *       not pay its bill, and it does not need to.
 *   (c) A SECOND DECLARED `judge` STEP — THIS. The engine's vocabulary never said one `judge` step per
 *       operation: `advance` suspends per step and `driveRun` loops on `awaiting-judge`, so N judge steps is
 *       N spawns with no engine change at all. Both jurors are tool-bearing. `judgeSpawn` derives each session
 *       id from `runId` + `lens` (#3028), and the two steps carry DIFFERENT lenses, so the two actors are
 *       pairwise distinct by construction — the same property #3050 was built to buy, obtained here without
 *       #3158's cost.
 *
 * WHAT THIS COSTS, HONESTLY. The two spawns are SEQUENTIAL, not parallel — `driveRun` awaits each judge before
 * it advances — so wall time roughly doubles (measured single-juror runs were 167-312s). A panel would have
 * been concurrent; that is the one thing option (b) buys that this does not, and it is a wall-clock cost, not a
 * verdict-quality one. The bill is the card's ~$0.29 per PR.
 *
 * WHAT THIS DOES NOT DO — the card's "on code PRs only" half. It is NOT implementable inside this declaration,
 * and the reason is structural rather than an omission: the step list is fixed at REGISTRATION, before any PR
 * is read, and the engine runs every declared step at its cursor. There is no conditional step and no "skip"
 * return — `advance`'s `judge` case REFUSES a request that is not `{mandate, input, shape}`-shaped, so a step
 * cannot decline to judge. An INPUT cannot gate it either, for the same reason: an input changes what a step
 * asks, never whether it runs. Gating therefore belongs to a CALLER that knows the touch-set before it starts
 * the run, or to a fifth thing the statute (#3031) forbids. So a docs-only PR pays for a security juror here.
 * That is stated rather than hidden, and it is the residual this slice leaves behind.
 *
 * `MANDATORY_LENSES` IS NOT TOUCHED. It is #2310's ratified pair (`correctness`, `security`) and re-opening it
 * is #3314's decision, not this slice's. This file only ARRANGES to seat both of them; it re-declares nothing.
 *
 * ── THE TWO PROPERTIES THIS SLICE EXISTS FOR ────────────────────────────────────────────────────────────────
 *
 * 1. **THE DIFF ARRIVES ON THE NET BASIS.** `read` names its net changed-file list `netChangedFiles` and marks
 *    `gh`'s own file list `ghDiffStat` — *not* ground truth, display only. Only `netChangedFiles` reaches
 *    `buildPanelMandate({ netChangedFiles })`, which states it to the juror AS ground truth (#2450). The
 *    console showing a diff stat where the agent sees real files (#2901) is therefore not a discipline the
 *    caller must keep: the two lists have different names in the finding, and the one a caller could mistake
 *    for authority is the one this step marks non-authoritative. The skill's `reason: 'exec-contract'` rule —
 *    *"a bug in YOUR wrapper to fix, not license to fall back"* — is enforced here as a REFUSAL, so a
 *    mis-shaped `exec` can no longer degrade quietly into `gh pr diff`'s inflated three-dot list.
 *
 * 2. **THE LABEL GUARD STAYS IN THE PURE CORE.** `record` asks `decideSetLabel` (#2470/#2644) what the swap is
 *    and REFUSES to declare any effect when it says `allowed: false`. INVARIANT 2 — a `review:human` (gate-self)
 *    PR is never machine-cleared — therefore binds this generated caller exactly as it binds the hand-written
 *    one, because it is the same pure function and this file does not reimplement it. `decideSetLabel` is
 *    IMPORTED, never injected: a caller that could substitute the decider is the hole the invariant exists to
 *    close. And the check here is the EARLY refusal only — `we:scripts/review-set-label.mjs` re-observes the
 *    live labels and re-runs the same decider at write time, so a label that changed between `read` and
 *    `record` is caught by the authoritative copy.
 *
 * ── WHAT THIS REPLACES IN `we:skills-src/review/SKILL.md` ───────────────────────────────────────────────────
 *
 *   - *"This is a stop point … Do not auto-proceed."* → the `confirm` step. The engine suspends; there is no
 *     way for the caller to answer a question that has not been asked (see the adapter's `--resume`).
 *   - *"A non-zero exit means re-run the same command"* → keyed effect replay. Each effect below is classified
 *     for idempotency INDIVIDUALLY at its declaration site, with the reason, because the executor's
 *     indeterminate-attempt refusal is only as good as those flags.
 *
 * ── IO IS INJECTED, AND THAT IS DELIBERATE ──────────────────────────────────────────────────────────────────
 *
 * `read` is a `compute` step and reading a PR is io. The vocabulary is closed at four kinds and *"an operation
 * that appears to need a fifth kind is a signal to change the model"* (#3031), so the answer is NOT a `read`
 * kind: the io is INJECTED into the declaration as `readPr` and the real binding lives in
 * {@link ./review-pr-io.mjs}. The engine still performs no io of its own, the step's SHAPE-CHECKING half stays
 * pure and unit-testable with a stub reader, and the declaration composes the same way #3036's HTTP caller will
 * need it to. What is honestly true and worth saying: the fn the engine calls is not pure — it is a pure
 * validator wrapped around one injected read.
 *
 * PURE apart from that injected reader: no fs, no clock, no process, no network in this file.
 */

import { op } from './registry.mjs';
// Aliased on import so the STEP NAMES below can be the card's own words (`judge`, `confirm`) without shadowing
// the builders.
import { compute, confirm as confirmStep, effect as effectStep, judge as judgeStep } from './step-kinds.mjs';
import { LEDGER_EFFECT_TYPE } from './effect-executor.mjs';
import {
  ADVISORY_LENSES,
  IMPACT_LEVELS,
  MANDATORY_LENSES,
  PANEL_LENSES,
  buildMandate,
  buildPanelFindings,
  buildPanelMandate,
  derivePanelVerdict,
  deriveVerdict,
  deriveLoopOutcome,
  normalizeFindings,
  renderReviewNotice,
  // #x8n4crp — the FOURTH seat (correctness-advisory) composes its own mandate through the UNGATED
  // `buildMandate`, never `buildPanelMandate` — see `CORRECTNESS_ADVISORY_LENS`'s own docblock for why. These
  // three are the exact pieces `buildPanelMandate` itself uses to build the aim-hypothesis block and the
  // mutation-probe instruction; imported here rather than re-implemented so the seat's mandate carries the
  // identical wording those blocks already have everywhere else.
  FENCED_DATA_RULE,
  fenceUntrusted,
  MUTATION_PROBE_RULE,
} from '../lib/review-core.mjs';
import { CITATION_SCOPES, DISPOSITIONS, VERDICTS, scopeFindingsToCitedFiles } from '../lib/jury-core.mjs';
import { renderPanelComment } from '../lib/review-render.mjs';
// #xwp8ioh — the SAME predicate `we:scripts/review-set-label.mjs` enforces at the write side (#2953), imported
// rather than restated, so the read side and the write side cannot drift into two answers (#2644).
import { classifyPrLiveness, inertPrMessage } from '../lib/pr-liveness.mjs';
// #xwk0tzu — the SAME decider `we:scripts/review-set-label.mjs` runs at the write side (#2844/#3067),
// imported rather than restated, for the same #2644 reason as the line above. The two PURE readers of the PR
// body come with it, so the declaration derives the author half itself instead of trusting an io-shell field.
import {
  INDEPENDENCE, decideClearerIndependence, hasStampLostMarker, parseAuthorActorId,
} from '../lib/review-independence.mjs';
// THE GUARD, IMPORTED NOT INJECTED — see property 2 in the header.
import { decideSetLabel, presentRemoveLabels } from '../review-set-label.mjs';
// #3335 — THE CALLER'S OWN DERIVATION, IMPORTED. `buildShapePlan` is the pure function behind
// `review-core-cli.mjs shape`, i.e. the exact thing the caller ran to produce the `careLevel` it declares. The
// check below re-runs THAT function over the NET file list, so a disagreement can only ever mean the two file
// lists differ — never that the caller and the operation hold two different derivations. `CARE_LEVEL_ORDER` is
// the band ordering the comparison is made on; both are pure, and neither is restated here.
import { buildShapePlan } from '../review-core-cli.mjs';
import {
  CARE_LEVELS, CARE_LEVEL_ORDER, REVIEW_PR_CHANNEL, REVIEW_LABELS, hasReviewLabel,
} from '../lib/review-escalation.mjs';
import { liveStatusFor as liveProbationStatusFor } from '../lib/model-probation.mjs';
import { CODEX_MODEL } from '../codex-direct-task.mjs';
// #3383 — THE FIFTH SEAT'S IDENTITY. `ANTIGRAVITY_MODEL` is the pinned `{provider, model}` half
// `defaultAntigravityReviewProbationCheck` reads the probation registry with, mirroring `CODEX_MODEL`'s import
// immediately above exactly. A leaf import with no jury/markdown-it edge — see that module's own header.
import { ANTIGRAVITY_MODEL } from '../lib/antigravity-judge-spawn.mjs';
// #3383 mechanical-dispatcher round-cap fix — `renderAdvisoryNote`'s comment opens with this SAME literal
// `we:scripts/conveyor/reconcile-core.mjs`'s round-cap check counts back off the PR's own comment thread
// (`countAdvisoryComments`, `we:scripts/conveyor/advisory-round-count.mjs`). Build and count share ONE marker
// so they can never drift — see that file's own header for why a `review:human` PR's advisory rounds could
// never be capped before this (PR #2117: six full panel runs against one identical commit range).
import { ADVISORY_NOTE_MARKER } from '../conveyor/advisory-round-count.mjs';
// The `advisory:*` label pair's outcome vocabulary — a leaf, shared with the sink, the staleness sweep and
// `operator-queue.mjs` so nobody restates it.
import { ADVISORY_OUTCOMES } from '../lib/advisory-labels.mjs';

/** The operation's stable id. Adapters resolve it by this name. */
export const REVIEW_PR_OP = 'review-pr';

/**
 * THE SURFACE this operation's verdicts come through, as `review-set-label.mjs --channel` renders it (#2898).
 *
 * Re-exported HERE from the shared review constants to avoid a cycle through `review-set-label.mjs`.
 * Kept beside the footer that says the same thing, because the two sentences appear in ONE comment
 * and drifting apart is the defect: the first live run (PR #1146) posted a comment whose attribution credited
 * the Plateau Loop review console — the CLI's old hardcoded constant — three lines above its own footer saying
 * it came through this operation. Same comment, two provenances.
 */
export { REVIEW_PR_CHANNEL };

/** The default lens the FIRST juror judges under. `correctness` is `MANDATORY_LENSES[0]` — the floor, not a pick. */
export const DEFAULT_LENS = MANDATORY_LENSES[0];

/**
 * The lens the SECOND juror judges under (#3319). READ OFF `MANDATORY_LENSES`, never retyped as `'security'`:
 * the pair is #2310's ratified set and #3314 is the open decision about widening it, so if that set ever
 * changes this seat follows it instead of pinning a string the statute no longer names.
 *
 * A LITERAL, not an input field, for the same reason `JUDGE_MODEL` is: it reaches `buildPanelMandate` and then
 * `judgeSpawn`'s `lens`, and a run's input must have no path to either.
 */
export const SECURITY_LENS = MANDATORY_LENSES[1];

/**
 * THE MARKER FOR A SEAT WHOSE LENS THE CALLER CHOOSES. A `Symbol`, not a sentinel string, because every
 * string in this position is a legal lens name and a sentinel would be one `PANEL_LENSES` entry away from
 * colliding with a real one.
 */
export const CALLER_CHOSEN_LENS = Symbol('review-pr: this seat judges under `input.lens`');

/**
 * THE JUDGE SEATS, AS DATA (#3344) — every `judge` step this operation declares, in declared order, each
 * beside the lens it will actually judge under. `{@link JUDGE_STEPS}` and `{@link decideLensFloor}` are both
 * derived from this one list, and `reviewPrOperation` REFUSES AT REGISTRATION if it ever stops matching the
 * declared `judge`-kind steps (see the assertion at the bottom of that function). That is what makes the
 * floor check below a statement about the RUN SHAPE rather than a second copy of it: a third seat, a removed
 * seat, or a seat whose lens is decided some other way all pass through here, or fail loudly.
 *
 * `judge`'s lens is {@link CALLER_CHOSEN_LENS} — it is `input.lens`, which the caller supplies.
 * `judgeSecurity`'s is the literal `SECURITY_LENS`, deliberately not CLI-reachable (#3319).
 */
export const JUDGE_SEATS = Object.freeze([
  Object.freeze({ step: 'judge', lens: CALLER_CHOSEN_LENS }),
  Object.freeze({ step: 'judgeSecurity', lens: SECURITY_LENS }),
]);

/**
 * The names of the two `judge` steps, in declared order. Exported so an adapter (or a test) can name the
 * telemetry rows a run produces without hard-coding step names a rename would silently strand. DERIVED from
 * {@link JUDGE_SEATS} since #3344 — the roster is the one place the seats are listed.
 */
export const JUDGE_STEPS = Object.freeze(JUDGE_SEATS.map((seat) => seat.step));

/**
 * #xqa9ttq — THE THIRD SEAT'S LENS, for the OPT-IN Codex panelist (see `reviewPrOperation`'s `codexAdvisory`
 * param). READ OFF `ADVISORY_LENSES[0]`, never retyped, for the same reason `SECURITY_LENS` is read off
 * `MANDATORY_LENSES[1]`: if the advisory set is ever reordered this seat follows it rather than pinning a
 * string the statute no longer names first.
 *
 * `simplicity` (today's `ADVISORY_LENSES[0]`) is the right FIRST pick among the three advisory lenses for a
 * TOOL-FREE, diff-only juror specifically:
 *   - `standards-conformance` needs this repo's own convention docs (`we:docs/agent/conventions.md`,
 *     `platform-decisions.md`) to judge against — material a tool-free juror shown only the diff text cannot
 *     fetch.
 *   - `claim-accuracy` benefits from tool access to verify a PR's claim against the actual repo (grep a cited
 *     file, run a cited command) — exactly what this seat structurally cannot have (#3581).
 *   - `simplicity` — "does this diff introduce avoidable complexity/redundancy" — is answerable from the
 *     mandate's diff text and description ALONE, which is the whole of what a tool-free juror is ever shown.
 *     It is also the one closest in spirit to a genuinely SECOND opinion: a structurally different model
 *     reading the same diff for the same kind of thing a human `/simplify` pass looks for.
 */
export const ADVISORY_JUDGE_LENS = ADVISORY_LENSES[0];

/**
 * #xqa9ttq — THE THIRD SEAT, AS DATA, kept OUT of {@link JUDGE_SEATS} (unlike `judgeSecurity`, this one is
 * opt-in — see `reviewPrOperation`'s `codexAdvisory` param and its own docblock for why). `reviewPrOperation`
 * appends this to a LOCAL copy of `JUDGE_SEATS` only when `codexAdvisory` is true, so every existing consumer
 * of the exported `JUDGE_SEATS`/`JUDGE_STEPS` (tests included) keeps seeing exactly today's mandatory pair.
 */
export const ADVISORY_JUDGE_SEAT = Object.freeze({ step: 'judgeAdvisory', lens: ADVISORY_JUDGE_LENS });

/**
 * #xqa9ttq — THE ENV VAR NAME both `run.mjs` and `record-verdict-io.mjs` read to decide `codexAdvisory`
 * (`reviewPrOperation`'s opt-in param). ONE constant, not a string re-typed at each call site, because the two
 * are INDEPENDENT registrations of the SAME operation name (`run.mjs` starts a run; `record-verdict-io.mjs`
 * resumes/records one, #3540, possibly on a different host/process) — a run STARTED with the third seat must
 * be RESUMED against a declaration seating the same roster, or the resume would be reasoning about a run shape
 * that no longer exists (the same class of hazard `JUDGE_SEATS`'s registration-time roster check exists to
 * catch, one level up: THAT check catches drift within one registration; this is what keeps two INDEPENDENT
 * registrations honestly agreeing). NOT a CLI `--flag`: the step list is fixed at REGISTRATION, before any
 * run's argv is parsed, so a per-invocation flag cannot reach this — the same reason `--provider` has an env
 * fallback (`JUDGE_PROVIDER`).
 */
export const CODEX_ADVISORY_ENV_VAR = 'REVIEW_PR_CODEX_ADVISORY';

/**
 * #xqa9ttq — READS {@link CODEX_ADVISORY_ENV_VAR}. `env` is a parameter, not `process.env` read directly
 * inline at each call site, so this stays unit-testable without mutating real process state.
 *
 * #3383 PROBATION DEFAULT, added on top of the original opt-in without changing its shape: an EXPLICIT env
 * value still wins either way (`'1'` forces the seat on, `'0'` forces it off) — this is what keeps the
 * existing opt-in behavior byte-identical for every caller that already sets the var. Only when the env is
 * UNSET does the default now come from the generic `{provider, model}` probation registry
 * (`we:scripts/lib/model-probation.mjs`) rather than a hardcoded `false`: the seat runs by default, on real
 * PRs, exactly when the identity actually seated (`codex` / {@link CODEX_MODEL}) is declared `'probation'`
 * (or `'trusted'`) for the `'advisory-review'` role. This is deliberately data-driven and NEVER a Codex-
 * specific boolean — a future model's registry entry (or this one's eventual graduation/demotion) flips the
 * default with a registry edit, never a code change here.
 *
 * THIS DOES NOT, AND STRUCTURALLY CANNOT, MAKE THE SEAT MANDATORY. Flipping this default only changes
 * whether `reviewPrOperation`'s opt-in `codexAdvisory` param is asked for at all; the seat it seats
 * (`judgeAdvisory` / {@link ADVISORY_JUDGE_LENS}) is READ off `ADVISORY_LENSES`, never `MANDATORY_LENSES`,
 * and `decideLensFloor`/`seatedLenses` (below) compute `seatsFloor` from `MANDATORY_LENSES` alone — so this
 * seat contributes NOTHING to whether a run has a blocking floor, on by default or not. See
 * `__tests__/review-pr.probation-advisory.test.mjs` for the standing proof.
 * @param {object} [env]
 * @param {{isOnProbation?: Function}} [deps] - injectable for tests, so a unit test never touches the real
 *   on-disk probation registry.
 * @returns {boolean}
 */
export function codexAdvisoryFromEnv(env = process.env, { isOnProbation = defaultCodexAdvisoryProbationCheck } = {}) {
  // UNSET (never assigned at all) is the ONLY case that falls through to the probation default — an env var
  // set to anything else, including the empty string or a typo like `'true'`, is still an EXPLICIT "not on"
  // exactly as it was before this default existed (never a literal `'1'` ⇒ never true), so a caller who
  // already pins `REVIEW_PR_CODEX_ADVISORY=0` (or any other non-`'1'` value) on purpose keeps that behavior
  // byte-identical.
  if (env && Object.hasOwn(env, CODEX_ADVISORY_ENV_VAR)) return env[CODEX_ADVISORY_ENV_VAR] === '1';
  return isOnProbation();
}

/**
 * The real (non-injected) probation check `codexAdvisoryFromEnv` defaults to: is the seated Codex identity
 * declared `'probation'` or `'trusted'` for the `'advisory-review'` role? Named and exported separately so a
 * test can assert ON it directly without stubbing the whole default parameter chain.
 * @returns {boolean}
 */
export function defaultCodexAdvisoryProbationCheck() {
  const status = liveProbationStatusFor({ provider: 'codex', model: CODEX_MODEL, role: 'advisory-review' });
  return status === 'probation' || status === 'trusted';
}

/**
 * #x8n4crp — THE FOURTH SEAT'S LENS: a genuinely NEW, distinct Codex seat judging under a CORRECTNESS-flavoured
 * mandate, seated ALONGSIDE (never in place of) the existing `judgeAdvisory` (`simplicity`) seat above. Built
 * under epic #3383 after real-pipeline validation showed the existing seat catches real bugs when handed a
 * `correctness` lens instead of `simplicity` — but RE-LENSING that existing seat directly would have been
 * wrong: the panel treats any `correctness`-lensed seat as MANDATORY/blocking (confirmed mechanism — see
 * `MANDATORY_LENSES` and `assertMandatoryLensSeated`/`decideLensFloor`, which read the seated lens strings, not
 * a seat's provider), so a `judgeAdvisory` run re-lensed to the literal string `'correctness'` would have
 * quietly become a BLOCKING seat the caller never chose to make mandatory.
 *
 * WHY THE LITERAL STRING IS NOT `'correctness'` AND IS NOT ADDED TO `ADVISORY_LENSES`/`PANEL_LENSES` EITHER —
 * both would recreate the same hazard from a different angle:
 *   - `'correctness'` verbatim IS `MANDATORY_LENSES[0]` (`DEFAULT_LENS`) — using it here would make
 *     `MANDATORY_LENSES.filter((l) => lenses.includes(l))` (this file's `reduce` step) treat THIS seat's
 *     per-lens verdict as one of the mandatory ones a `changes` vote from ANY of must flip the panel to
 *     `changes`. That is the exact collision this seat exists to avoid — see the test proving a blocking
 *     finding from this seat never reaches `MANDATORY_LENSES`'s bucket.
 *   - Adding a new member to `ADVISORY_LENSES` (`we:scripts/lib/jury-core.mjs`) would NOT collide with the
 *     mandatory bucket, but it would reach far past this one seat: `PANEL_LENSES` (`= [...MANDATORY_LENSES,
 *     ...ADVISORY_LENSES]`) is the fan-out set `panelRigorForCareLevel` and the wider jury-core panel machinery
 *     use EVERYWHERE ELSE this repo runs a panel — `converge`, the drain's own auto-review, every other
 *     operation that calls `buildPanelMandate`/`buildValidatorMandate`. Registering a Codex-only, review-pr-only
 *     seat there would silently grow every OTHER caller's rigor band by one juror it never asked to seat. That
 *     is not this card's bill.
 *
 * So `CORRECTNESS_ADVISORY_LENS` is a PLAIN, HARD-CODED string that is a member of neither array — it exists
 * ONLY inside this file's own bookkeeping (`JUDGE_STEPS`-shaped seat lists, `lensVerdicts`, `lensProviders`,
 * `findings.category`), which is lens-agnostic (`derivePanelVerdict`/`buildPanelFindings` accept any string key
 * — see their own JSDoc; nothing there gates on `PANEL_LENSES`). The ONE place that DOES gate on `PANEL_LENSES`
 * is `buildPanelMandate` itself, which is exactly why this seat's mandate is built through the UNGATED
 * `buildMandate` instead (see {@link buildReviewCorrectnessAdvisoryMandate}) — the correctness-flavoured
 * INSTRUCTION TEXT still reads `DEFAULT_LENS` (`'correctness'`) as its topic word, only the BOOKKEEPING key
 * differs, and registration-time (`reviewPrOperation`) refuses outright if that ever stops being disjoint from
 * `MANDATORY_LENSES` — see the check there.
 *
 * Rendered in the panel table as `${CORRECTNESS_ADVISORY_LENS} (codex, advisory)` — see this seat's `provider`
 * entry in `reduce`'s local `seats` list, which carries the `', advisory'` suffix `renderPanelVerdictTable`
 * appends verbatim so the row can never be mistaken for the mandatory `correctness` seat's own row.
 */
export const CORRECTNESS_ADVISORY_LENS = 'codex-correctness';

/**
 * #x8n4crp — THE FOURTH SEAT, AS DATA, kept OUT of {@link JUDGE_SEATS} — exactly like {@link ADVISORY_JUDGE_SEAT},
 * this one is opt-in (see `reviewPrOperation`'s `correctnessAdvisory` param). It is INDEPENDENT of the existing
 * `codexAdvisory` opt-in: a caller may seat neither, either, or both third-party seats, and the two never share
 * a gate — see `CORRECTNESS_ADVISORY_ENV_VAR`.
 */
export const CORRECTNESS_ADVISORY_SEAT = Object.freeze({ step: 'judgeCorrectnessAdvisory', lens: CORRECTNESS_ADVISORY_LENS });

/**
 * #x8n4crp — THE ENV VAR NAME both `run.mjs` and `record-verdict-io.mjs` read to decide `correctnessAdvisory`,
 * mirroring {@link CODEX_ADVISORY_ENV_VAR}'s own reasoning exactly (independent registrations of the same
 * operation must seat the same roster; no CLI `--flag` can reach a step list fixed at registration). A SEPARATE
 * env var from the existing seat's, deliberately: the two Codex seats are independently opt-in, so flipping one
 * on must never silently seat the other.
 */
export const CORRECTNESS_ADVISORY_ENV_VAR = 'REVIEW_PR_CODEX_CORRECTNESS_ADVISORY';

/**
 * #x8n4crp — READS {@link CORRECTNESS_ADVISORY_ENV_VAR}. Mirrors `codexAdvisoryFromEnv` exactly, INCLUDING
 * its #3383 probation default: an explicit `'1'` seats it, an explicit non-`'1'` value (including `'true'`)
 * never seats it, and — new here — an UNSET env var now falls through to the LIVE `{provider:'codex',
 * model:CODEX_MODEL}` probation status for the `'advisory-review'` role, exactly like the third seat. This
 * is in fact the seat the operator's probation ruling is MOST about: it is the correctness-lensed seat this
 * session's real validation showed catches genuine bugs, and probation exists specifically to accumulate
 * real performance data on it without ever letting it gate. Structurally non-blocking regardless of this
 * default, for the same reason as the third seat: `CORRECTNESS_ADVISORY_LENS` is deliberately never added to
 * `MANDATORY_LENSES`/`PANEL_LENSES`, and `reviewPrOperation`'s own registration-time check refuses outright
 * if it ever collided with `MANDATORY_LENSES` — see this constant's own docblock.
 * @param {object} [env]
 * @param {{isOnProbation?: Function}} [deps] - injectable, mirroring `codexAdvisoryFromEnv`'s own seam.
 * @returns {boolean}
 */
export function correctnessAdvisoryFromEnv(env = process.env, { isOnProbation = defaultCodexAdvisoryProbationCheck } = {}) {
  if (env && Object.hasOwn(env, CORRECTNESS_ADVISORY_ENV_VAR)) return env[CORRECTNESS_ADVISORY_ENV_VAR] === '1';
  return isOnProbation();
}

/**
 * #x8n4crp — VALIDATED DEFAULT EFFORT for the fourth seat's Codex spawn, independent of {@link JUDGE_EFFORT}
 * (which stays `'high'` for the two Claude-backed mandatory seats and the existing `judgeAdvisory` seat — see
 * `buildReviewAdvisoryJudgeRequest`, unchanged by this card). Measured live against real PRs during this
 * session: `medium` returned 2 findings in 34s for 281 tokens, against `max`'s 6 findings in 508s for ~14k
 * tokens — `medium` is the best value/cost tradeoff for an ADVISORY seat whose findings never block, and is
 * the ratified default here. A caller wanting more thoroughness still gets it by turning the seat on with a
 * richer request built by hand; this constant only fixes what `reviewPrOperation`'s own wiring asks for.
 */
export const CORRECTNESS_ADVISORY_EFFORT = 'medium';

/**
 * #3383 — THE FIFTH SEAT'S LENS: Google's Antigravity CLI (`agy`, `we:scripts/lib/antigravity-judge-spawn.mjs`)
 * wired in as a genuinely NEW, tool-free judge seat, seated ALONGSIDE every existing seat, never in place of
 * one. This is the FIRST real review-panel exercise for this provider — unlike the two Codex advisory seats
 * above, which had real trials in OTHER roles before their own review seat went live (see
 * `model-probation.json`'s own `since`/`note` fields for both identities) — so it is registered on `probation`
 * with a correspondingly more cautious posture, not a graduated one.
 *
 * SAME DISJOINT-LENS REASONING AS `CORRECTNESS_ADVISORY_LENS`, restated for this seat rather than re-argued:
 * a PLAIN, HARD-CODED string, a member of NEITHER `MANDATORY_LENSES` (a `changes` verdict from this seat must
 * never flip the whole panel) NOR `ADVISORY_LENSES`/`PANEL_LENSES` (adding it there would silently grow every
 * OTHER caller of `buildPanelMandate`'s fan-out — `converge`, the drain's own auto-review, everywhere else a
 * panel runs — by one juror they never asked to seat). See `CORRECTNESS_ADVISORY_LENS`'s own docblock for the
 * full argument; it applies here unchanged. Because this lens is outside `PANEL_LENSES`, this seat's mandate is
 * built through the UNGATED `buildMandate`, exactly like the fourth seat's (see
 * {@link buildReviewAntigravityMandate}) — `buildPanelMandate` would throw on it.
 *
 * NAMED `antigravity-review`, not `antigravity-correctness`: the name says WHAT PROVIDER backs this opinion,
 * the same naming shape `CORRECTNESS_ADVISORY_LENS` uses (a provider-flavoured bookkeeping key, never the bare
 * topic word), so a panel with several non-Claude seats reads unambiguously by provider in `lensProviders`
 * without a reader having to cross-reference which topic each one judges.
 *
 * Rendered in the panel table as `${ANTIGRAVITY_REVIEW_LENS} (antigravity, advisory)` — see this seat's
 * `provider` entry in `reduce`'s local `seats` list below, mirroring `CORRECTNESS_ADVISORY_LENS`'s own
 * `', advisory'` suffix so the row can never be mistaken for a mandatory seat's own row.
 */
export const ANTIGRAVITY_REVIEW_LENS = 'antigravity-review';

/**
 * #3383 — THE FIFTH SEAT, AS DATA, kept OUT of {@link JUDGE_SEATS} — exactly like {@link CORRECTNESS_ADVISORY_SEAT},
 * this one is opt-in (see `reviewPrOperation`'s `antigravityReview` param). It is INDEPENDENT of both existing
 * Codex opt-in seats: a caller may seat any subset of the three optional seats, and none of them share a gate.
 */
export const ANTIGRAVITY_REVIEW_SEAT = Object.freeze({ step: 'judgeAntigravityReview', lens: ANTIGRAVITY_REVIEW_LENS });

/**
 * #3907 — EVERY opt-in advisory seat (3, 4 and 5), by step. An advisory seat never blocks: its findings are left
 * out of `verdictAdmitted` (the basis `derivePanelVerdict` reduces over), because that reduction's prevention scan
 * reads `findings` without regard to `mandatoryLenses`, so an advisory lens left in it could still block.
 */
export const ADVISORY_SEAT_STEPS = Object.freeze([ADVISORY_JUDGE_SEAT, CORRECTNESS_ADVISORY_SEAT, ANTIGRAVITY_REVIEW_SEAT].map((s) => s.step));

/**
 * #3383 — THE ENV VAR NAME both `run.mjs` and `record-verdict-io.mjs` read to decide `antigravityReview`,
 * mirroring {@link CORRECTNESS_ADVISORY_ENV_VAR}'s own reasoning exactly (independent registrations of the same
 * operation must seat the same roster; no CLI `--flag` can reach a step list fixed at registration). A SEPARATE
 * env var from both Codex seats' own — the three optional seats are independently opt-in, so flipping one on
 * must never silently seat another.
 */
export const ANTIGRAVITY_REVIEW_ENV_VAR = 'REVIEW_PR_ANTIGRAVITY_REVIEW';

/**
 * #3383 — READS {@link ANTIGRAVITY_REVIEW_ENV_VAR}. Mirrors `correctnessAdvisoryFromEnv` exactly, INCLUDING the
 * probation default: an explicit `'1'` seats it, an explicit non-`'1'` value (including `'true'`) never seats
 * it, and an UNSET env var falls through to the LIVE `{provider:'antigravity', model:ANTIGRAVITY_MODEL}`
 * probation status for the `'advisory-review'` role — same wiring shape as both Codex seats, a DIFFERENT
 * identity in the registry. Structurally non-blocking regardless of this default, for the same reason as the
 * fourth seat: `ANTIGRAVITY_REVIEW_LENS` is deliberately never added to `MANDATORY_LENSES`/`PANEL_LENSES`, and
 * `reviewPrOperation`'s own registration-time check refuses outright if it ever collided with
 * `MANDATORY_LENSES` — see that constant's own docblock.
 * @param {object} [env]
 * @param {{isOnProbation?: Function}} [deps] - injectable, mirroring `correctnessAdvisoryFromEnv`'s own seam.
 * @returns {boolean}
 */
export function antigravityReviewFromEnv(env = process.env, { isOnProbation = defaultAntigravityReviewProbationCheck } = {}) {
  if (env && Object.hasOwn(env, ANTIGRAVITY_REVIEW_ENV_VAR)) return env[ANTIGRAVITY_REVIEW_ENV_VAR] === '1';
  return isOnProbation();
}

/**
 * #xqa9ttq (PR #2117 review) - THE ROSTER A SAVED RUN WAS STARTED WITH, read off the RUN, not the ambient environment.
 * Resuming a saved run must register the declaration the run was started with.
 * The env var names only how a NEW run should be started.
 * A run that reached `awaiting-confirm` has answered every judge step, so `findings.judgeAdvisory`
 * present means the third seat was seated.
 * @param {object|null|undefined} record - a run record.
 * @returns {boolean}
 */
export function codexAdvisoryFromRun(record) {
  return Boolean(record && typeof record === 'object' && record.findings && typeof record.findings === 'object'
    && Object.prototype.hasOwnProperty.call(record.findings, ADVISORY_JUDGE_SEAT.step));
}

/**
 * The real (non-injected) probation check `antigravityReviewFromEnv` defaults to: is the seated Antigravity
 * identity declared `'probation'` or `'trusted'` for the `'advisory-review'` role? Named and exported
 * separately, mirroring `defaultCodexAdvisoryProbationCheck`, so a test can assert ON it directly without
 * stubbing the whole default parameter chain.
 * @returns {boolean}
 */
export function defaultAntigravityReviewProbationCheck() {
  const status = liveProbationStatusFor({ provider: 'antigravity', model: ANTIGRAVITY_MODEL, role: 'advisory-review' });
  return status === 'probation' || status === 'trusted';
}

/**
 * #3383 — THIS SEAT'S EFFORT, independent of {@link JUDGE_EFFORT} and {@link CORRECTNESS_ADVISORY_EFFORT}. NO
 * live cost/quality comparison has been run for this role yet (unlike the fourth seat's measured medium-vs-max
 * comparison) — `'low'` is a deliberately modest, defensible starting choice for a seat with ZERO real review
 * trials (see `ANTIGRAVITY_MODEL`'s own docblock in `antigravity-judge-spawn.mjs` for why a bare model id
 * paired with an explicit `low` effort was chosen over an effort-suffixed model id), not a benchmarked one.
 */
export const ANTIGRAVITY_REVIEW_EFFORT = 'low';

/**
 * WHICH LENSES A RUN WOULD ACTUALLY SEAT, given the caller's `--lens`. Resolves {@link CALLER_CHOSEN_LENS}
 * against `lens` and takes every other seat's literal. PURE.
 *
 * @param {object} o
 * @param {string} [o.lens] - the caller's `input.lens`.
 * @param {ReadonlyArray<{step: string, lens: string|symbol}>} [o.seats] - the roster; defaults to the live one.
 *   Parameterised so the FUTURE run shape this guard exists for — a conditional or absent pinned seat — is
 *   testable without pretending the current declaration is something it is not.
 * @returns {readonly string[]} the seated lens names, in seat order, with unresolvable seats dropped.
 */
export function seatedLenses({ lens, seats = JUDGE_SEATS } = {}) {
  return Object.freeze(
    seats
      .map((seat) => (seat.lens === CALLER_CHOSEN_LENS ? lens : seat.lens))
      .filter((l) => typeof l === 'string' && l.length > 0),
  );
}

/**
 * DOES THIS RUN HAVE A BLOCKING FLOOR? PURE, and the whole of #3344's condition.
 *
 * THE PROPERTY IS "NO MANDATORY LENS SEATED ACROSS ALL JUDGE STEPS" — deliberately NOT "the `--lens` input
 * names an advisory lens". Those two were the same question before #3319 and are not the same question now,
 * and the difference is the point:
 *
 *   - `--lens`-is-advisory would fire TODAY on `--lens=simplicity`, and it would be WRONG to: the pinned
 *     `judgeSecurity` seat is judging under `security`, the floor is intact, and the run should proceed.
 *     A guard that blocks a legitimate run is worse than the hole it closes — the card says so in as many
 *     words, and it is why the negative half of the test matters as much as the positive.
 *   - "no mandatory lens across all seats" is the invariant the operator actually believes when they read a
 *     verdict: SOMETHING that ran could have blocked. It stays correct if `judgeSecurity` is later made
 *     conditional, is removed, or is joined by a third seat — the roster changes, this reads the roster, and
 *     the answer follows.
 *
 * WHAT THAT COSTS, STATED PLAINLY: under the CURRENT step list this can never fire. `judgeSecurity` is
 * unconditional and pinned to `MANDATORY_LENSES[1]`, and `reviewPrOperation` already refuses at REGISTRATION
 * if that resolves to something outside `PANEL_LENSES` — so `security` is seated on every run that exists at
 * all, whatever `--lens` says. This guard is therefore DORMANT today. That is the honest state of it, not a
 * reason to weaken the condition into the `--lens`-is-advisory one that would fire: a guard that is correct
 * and currently unreachable keeps its meaning when the shape changes; a guard that fires on the wrong
 * property is a false refusal waiting for its first legitimate run.
 *
 * @param {object} o
 * @param {string} [o.lens]
 * @param {ReadonlyArray<{step: string, lens: string|symbol}>} [o.seats]
 * @returns {{seated: readonly string[], mandatorySeated: readonly string[], advisorySeated: readonly string[], seatsFloor: boolean}}
 */
export function decideLensFloor({ lens, seats = JUDGE_SEATS } = {}) {
  const seated = seatedLenses({ lens, seats });
  const mandatorySeated = Object.freeze(MANDATORY_LENSES.filter((l) => seated.includes(l)));
  return Object.freeze({
    seated,
    mandatorySeated,
    advisorySeated: Object.freeze(ADVISORY_LENSES.filter((l) => seated.includes(l))),
    seatsFloor: mandatorySeated.length > 0,
  });
}

/**
 * REFUSE a lens selection that seats no mandatory lens (#3344). THROWS; it does not warn.
 *
 * WHY A REFUSAL AND NOT A WARNING. This operation is driven headless — the juror is spawned by the caller
 * between two `advance` calls and its answer is consumed by `reduce`. Nobody is watching stderr at the moment
 * a run is dispatched, which is exactly how the second of the two 2026-08-26 cases got through: the run was
 * dispatched, not watched. A warning here would be a line in a log that already scrolled.
 *
 * WHY IT NAMES WHAT IS MISSING rather than restating the flag: the two sessions that hit this arrived from
 * OPPOSITE directions — one narrowed to an advisory lens believing it ADDED a check, the other omitted the
 * flag believing it WIDENED to a panel — so the sentence has to say what the run would lack, not what the
 * caller typed.
 *
 * @param {object} o
 * @param {string} [o.lens]
 * @param {ReadonlyArray<{step: string, lens: string|symbol}>} [o.seats]
 * @returns {ReturnType<typeof decideLensFloor>} the floor decision, when it holds.
 */
export function assertMandatoryLensSeated({ lens, seats = JUDGE_SEATS } = {}) {
  const floor = decideLensFloor({ lens, seats });
  if (floor.seatsFloor) return floor;
  throw new Error(
    `review-pr.read: \`--lens=${lens}\` seats no mandatory lens — this run would have no blocking floor. `
    + `The ${seats.length} judge seat(s) (${seats.map((s) => `\`${s.step}\``).join(', ')}) would judge under `
    + `${floor.seated.length ? floor.seated.map((l) => `\`${l}\``).join(' + ') : '(no lens at all)'}, and `
    + `\`MANDATORY_LENSES\` is [${MANDATORY_LENSES.join(', ')}]. An advisory lens INFORMS; only a mandatory `
    + 'one can block, so the verdict this run rendered could never have been anything but a pass. `--lens` '
    + 'SUBSTITUTES the first seat\'s lens, it does not add one: pass a mandatory lens (or omit `--lens`, '
    + `which takes \`${DEFAULT_LENS}\`) and re-run. Refusing BEFORE the PR is read and before any juror is `
    + 'spawned, so nothing is billed for a review that could not have blocked.',
  );
}

/**
 * #3335 — REFUSE AN ADVISORY SEAT ON A PR THAT ESCALATES. THROWS. PURE, and decidable from the INPUT alone, so
 * it sits beside {@link assertMandatoryLensSeated} at the top of `read` — before the `gh` round trip, before any
 * juror.
 *
 * IT IS A DIFFERENT QUESTION FROM #3344's, AND DOES NOT WEAKEN IT. `decideLensFloor` asks whether ANY mandatory
 * lens sits across ALL judge seats; with `judgeSecurity` pinned that is satisfied by `security` no matter what
 * `--lens` says, which is why its own docblock calls it dormant. This asks the narrower question the dormancy
 * leaves open: on a PR whose touch-set the CALLER ITSELF scored as escalated, is the ONE seat the caller gets to
 * choose being spent on a lens that can block? PR #1569 round 2 is the case — `--lens=claim-accuracy` on a
 * declarative-leash change. The floor held (`security` sat), and the caller-chosen seat still went to an advisory
 * lens on a PR the dial wanted five lenses and two jurors on. Both guards run; this one runs second.
 *
 * IT BINDS ONLY ON A DECLARED SHAPE. No `--careLevel`, or a declared `none`, and this passes: the operation
 * cannot score a touch-set it has not read yet (that is the whole reason the derivation belongs to the caller),
 * and inventing a band here would be the re-taxonomizing this item exists to avoid. A caller that declares
 * nothing is unchanged, byte for byte — see `assertDeclaredShapeHolds` for the half that catches the declaration
 * being WRONG once `read` can see the net files.
 *
 * @param {{lens?: string, careLevel?: string}} o
 * @returns {{declared: string|null, escalated: boolean, lens: string|undefined, advisory: boolean}}
 */
export function assertSeatSpentOnMandatoryLens({ lens, careLevel } = {}) {
  const declared = CARE_LEVEL_ORDER.includes(careLevel) ? careLevel : null;
  const escalated = declared !== null && declared !== CARE_LEVELS.NONE;
  const advisory = typeof lens === 'string' && ADVISORY_LENSES.includes(lens);
  const decision = Object.freeze({ declared, escalated, lens, advisory });
  if (!escalated || !advisory) return decision;
  throw new Error(
    `review-pr.read: \`--lens=${lens}\` spends the one caller-chosen seat on an ADVISORY lens while `
    + `\`--careLevel=${declared}\` declares this PR's touch-set as escalated. \`ADVISORY_LENSES\` is `
    + `[${ADVISORY_LENSES.join(', ')}] — an advisory lens INFORMS and cannot block, so on an escalated PR the `
    + `seat must go to \`MANDATORY_LENSES\` [${MANDATORY_LENSES.join(', ')}]. \`--lens\` SUBSTITUTES this seat's `
    + `lens, it does NOT add one: passing \`${lens}\` DISPLACES \`${DEFAULT_LENS}\`, it does not check `
    + `\`${lens}\` in addition to it. Re-run with a mandatory lens (or omit \`--lens\`, which takes `
    + `\`${DEFAULT_LENS}\`) and ask for \`${lens}\` as a separate review. Refusing BEFORE the PR is read and `
    + 'before any juror is spawned, so nothing is billed.',
  );
}

/**
 * #3335 — REFUSE A DECLARED SHAPE THE PR CONTRADICTS. THROWS. PURE. Called from {@link shapeReadFinding}, at the
 * one moment both halves exist: the caller's declared `careLevel` and the NET changed-file list `read` has just
 * computed. `shapeReadFinding` already refuses this way for a mis-shaped net basis (`exec-contract`), so the
 * mechanism is established rather than invented here.
 *
 * IT RE-RUNS THE CALLER'S OWN DERIVATION, not a second one: `buildShapePlan` is the pure function behind
 * `review-core-cli.mjs shape`. So the only thing this can catch is the two FILE LISTS disagreeing — the caller
 * scored `gh pr view --json files`, this scores the net `origin/main…head` list — which is exactly the drift
 * worth catching, because the net list is the one the juror is shown as ground truth (#2450).
 *
 * IT REFUSES UNDER-DECLARATION ONLY, AND THAT NARROWING IS DELIBERATE. The two directions are not symmetric:
 *   • derived HIGHER than declared → REFUSE. The run was dialled for less care than the diff that will land
 *     earns. This is #1580's case and the one that ships a defect.
 *   • derived LOWER than declared → PROCEED. The caller asked for MORE care than the net diff earns, which costs
 *     tokens and never a defect — and it is the ordinary outcome whenever `gh`'s three-dot list is inflated by
 *     sibling-lane content this PR does not touch (#2450/#2901). Refusing it would turn a routine inflation into
 *     a blocked review, which is the false-refusal failure #3344's docblock argues against at length.
 * The derived band is recorded on the finding either way (`earnedShape`), so the over-declaring case is visible
 * in the record rather than silently swallowed.
 *
 * @param {{careLevel?: string, netChangedFiles?: string[], pr?: number|string, repo?: string}} o
 * @returns {object|null} the derived shape plan, or `null` when there is nothing to check against.
 */
export function assertDeclaredShapeHolds({ careLevel, netChangedFiles = [], pr, repo } = {}) {
  const files = Array.isArray(netChangedFiles) ? netChangedFiles : [];
  if (!files.length) return null; // nothing to score — the degraded-basis note on the finding already says so
  const derived = buildShapePlan({ changedFiles: files });
  const declared = CARE_LEVEL_ORDER.includes(careLevel) ? careLevel : null;
  if (declared === null) return derived; // no declaration to contradict
  if (CARE_LEVEL_ORDER.indexOf(derived.careLevel) <= CARE_LEVEL_ORDER.indexOf(declared)) return derived;
  throw new Error(
    `review-pr.read: the declared shape \`--careLevel=${declared}\` is contradicted by what ${repo}#${pr} actually `
    + `touches — scoring its ${files.length} NET changed file(s) gives care \`${derived.careLevel}\``
    + `${derived.reasons.length ? ` (${derived.reasons.join('; ')})` : ''}. At \`${derived.careLevel}\` the dial asks `
    + `for ${derived.earnedLenses.length} lens(es) × ${derived.jurorsPerLens} juror(s)/lens × ${derived.rounds} `
    + `round(s); \`${declared}\` was declared, so this run was dialled for less care than the diff that will land `
    + 'earns. The declaration is the CALLER\'s: re-derive it from the touch-set with `node '
    + 'scripts/review-core-cli.mjs shape` and re-run. Refusing BEFORE the `judge` step, so no juror is paid for a '
    + 'review shaped by a touch-set nobody read. (Only UNDER-declaration refuses: declaring MORE care than the '
    + 'net diff earns proceeds, because `gh`\'s three-dot file list is routinely inflated by sibling-lane content '
    + 'this PR does not touch, and that costs tokens rather than a defect.)',
  );
}

/**
 * The juror's model / effort / budget. LITERALS, deliberately — never sourced from an input field.
 *
 * THE FOOTGUN THIS CLOSES (#3028, just fixed there): an option *value* shaped like a flag (`model: '--bare'`)
 * reaches `buildJudgeArgv`'s argv guard. Nothing in the run's INPUT can reach these three: the one input field
 * that DOES reach the judge request is `lens`, and `buildPanelMandate` refuses anything outside `PANEL_LENSES`
 * before it can become argv (it lands in the mandate TEXT, never in a flag position, either way).
 *
 * WHAT CHANGED, AND WHAT DID NOT (#3151). This comment used to add that a fat-fingered `--model=--bare` on the
 * command line "has no path to the juror's argv at all". That is no longer true as written: `--model` is now a
 * real CONTROL flag of the derived command line, so the value has a path — it is refused ON it, twice, rather
 * than having none. The parse rejects a `-`-leading value before a run record exists, and
 * `assertSafeJudgeRequest` rejects it again on the merged request the spawn will actually use. The property
 * that survives untouched is the one this file is responsible for: a run's INPUT still cannot reach argv, and
 * these three stay LITERALS for exactly that reason.
 */
/** What a reviewing juror may do. Read and search, plus Bash for gates, reproduction and mutation probes. */
export const REVIEW_JUROR_TOOLS = Object.freeze(['Bash', 'Read', 'Grep', 'Glob']);

export const JUDGE_MODEL = 'sonnet';
export const JUDGE_EFFORT = 'high';
/**
 * NO SPEND CEILING (operator ruling, 2026-08-18 — `#xvkjndx`). `null` omits `--max-budget-usd` entirely.
 *
 * The ceiling was never a cost control here; it was a silent TRUNCATION of the review. A tool-bearing juror
 * that hits it is killed mid-run and reports `stop_reason: "tool_use"`, which reads like a crash — so the
 * failure costs a misdiagnosis on top of the lost review. Four measured runs on 2026-08-18 spent $0.6152,
 * $0.6597, $0.6997 and $0.9042; the old inherited default of 0.5 would have killed all four, and between them
 * they found ten defects a green suite and check:standards both missed. A truncated review is worth less than
 * its own price.
 *
 * The bound that remains is `judgeSpawn`'s 10-minute `timeoutMs` kill, which is a bound on RUNAWAY rather than
 * on thoroughness — the right shape for this. Measured wall times were 167-312s, so it is real headroom, not a
 * fig leaf.
 */
export const JUDGE_BUDGET_USD = null;

/** What the `confirm` step records as the actor. `human` on a gate-self PR, `agent` otherwise. */
export const CONFIRM_ACTORS = Object.freeze({ HUMAN: 'human', AGENT: 'agent' });

/** The closed answer set for the `confirm` step. `abstain` is the non-mutating exit: it declares NO effects. */
export const CONFIRM_OPTIONS = Object.freeze(['accept', 'changes', 'abstain']);

/**
 * #3540 — MAP `record-verdict`'s `to` VOCABULARY (`accepted`/`changes`/`clear-human`) TO THIS `confirm` STEP'S
 * OWN ANSWER (`accept`/`changes`/`abstain`), where one exists. PURE.
 *
 * `clear-human` maps to `null`, DELIBERATELY: it is the human ceremony's OWN clearance of a gate-self PR
 * (`review-set-label.mjs --to=clear-human`, #2895), never an answer this operation's `confirm` step could ever
 * be given — `planRecordDecision`'s INVARIANT 2 guard refuses `accept` on a `review:human` PR unconditionally,
 * so there is no `confirm` answer this vocabulary could translate a `clear-human` request into. A caller (see
 * `we:scripts/operations/record-verdict-io.mjs#advanceReviewPrToWriteUp`) reads `null` as "nothing to auto-
 * answer here", never as a refusal of its own.
 *
 * @param {string} to
 * @returns {'accept'|'changes'|null}
 */
export function confirmAnswerFor(to) {
  if (to === 'accepted') return 'accept';
  if (to === 'changes') return 'changes';
  return null;
}

/**
 * The effect types this operation declares. `WRITE_UP` belongs to `stageVerdict`; `LABEL`/`LEDGER`/`NOTICE`
 * belong to `record` (#3540 split the write-up out of `record`, ahead of the label swap); `verdict-ledger.append`
 * is #3032's reserved seam for #3007. `ADVISORY_NOTE` (#xlw02hw) belongs to `advise` and is deliberately its OWN
 * type, never `WRITE_UP`/`LABEL` — those two are the real ceremony's write and a caller (or a sink lookup keyed
 * by type) must never be able to confuse the two kinds of comment this operation can post.
 *
 * `AWAITING_ADVISORY_CLEAR` (mechanical-dispatcher lane) also belongs to `advise` — it is the mechanical flip of
 * `review:awaiting-advisory` → cleared, declared as a SECOND effect right after `ADVISORY_NOTE` so the two are
 * applied by the SAME executor, strictly in order: the note posts first, and only once it has genuinely landed
 * does the executor move on to clear the label. It is its own type (never `LABEL`, `record`'s own effect) for
 * the same reason `ADVISORY_NOTE` is not `WRITE_UP` — this is a plain label removal, not a verdict swap, and the
 * two must never be confusable by a sink lookup keyed on type.
 */
export const REVIEW_EFFECTS = Object.freeze({
  WRITE_UP: 'review.write-up',
  LABEL: 'review.label-swap',
  LEDGER: LEDGER_EFFECT_TYPE,
  NOTICE: 'review.notice',
  MANDATORY_REFERRALS: 'review.mandatory-referrals',
  ADVISORY_NOTE: 'review.advisory-note',
  // `advise`'s SECOND effect: the `advisory:accepted` / `advisory:changes` label. Its own type for the same reason
  // as `ADVISORY_NOTE` — never `LABEL`, which is the real ceremony's `review:*` swap.
  ADVISORY_LABEL: 'review.advisory-label',
  AWAITING_ADVISORY_CLEAR: 'review.awaiting-advisory-clear',
});

/**
 * The JSON Schema the juror's answer is FORCED to satisfy (`--json-schema`, #3028). Its finding fields are the
 * canonical `Finding` shape `normalizeFinding` (`we:scripts/lib/jury-core.mjs`) reads, so the juror's structured
 * output flows into `deriveVerdict` with no adapter layer in between — and the enums are taken FROM the enums
 * (`IMPACT_LEVELS`, `DISPOSITIONS`) rather than retyped, so a fifth impact level cannot silently be unaskable.
 */
export const REVIEW_JUDGE_SHAPE = Object.freeze({
  type: 'object',
  additionalProperties: false,
  // `summary` IS REQUIRED, and #x0p5k2q is why. It was optional, so a juror could answer exactly
  // `{findings: []}` — having said nothing about what it looked at — and `deriveVerdict` reduced that to
  // `accept`. Observed twice on PR #1513: two independent jurors, 13 turns and ~$0.79 each over a 48.5k-char
  // diff, both returning an empty array and no summary. PR #1510's juror returned the same empty array
  // alongside a 548-character account of what it had verified, so the field's absence is NOT a property of a
  // clean review.
  //
  // `record-verdict` already refuses such a run ("staged no write-up to carry"), which is what caught this and
  // means nothing false was ever recorded. But refusing THERE only deadlocks the pipeline: the operator has
  // been told the PR was accepted and the verdict can never be carried. Requiring it here refuses at the step
  // that produced the emptiness, which is the only place it can still be re-asked.
  //
  // A JUROR THAT JUDGED MUST SAY WHAT IT JUDGED. Zero findings stays a perfectly good answer — this asks only
  // that it be an answer rather than a silence, the same line drawn between `unrun` and `pass` everywhere else.
  required: ['findings', 'summary'],
  properties: {
    summary: {
      type: 'string',
      description: 'REQUIRED. One sentence on the diff as a whole — what you examined and what you concluded. '
        + 'Zero findings is a fine verdict; saying nothing is not one, and an empty summary is refused.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['summary'],
        properties: {
          summary: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          category: { type: 'string' },
          failure_scenario: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE'] },
          impactIfUnfixed: { type: 'string', enum: Object.values(IMPACT_LEVELS) },
          disposition: { type: 'string', enum: Object.values(DISPOSITIONS) },
          introduced: { type: 'boolean' },
          worseThanBase: { type: 'boolean' },
          parallelizable: { type: 'boolean' },
          rootCause: { type: 'string' },
          prevention: { type: 'string' },
          preventionCaptured: { type: 'boolean' },
        },
      },
    },
  },
});

/** A full 40-hex object name, or `null`. Nothing shorter counts: an abbreviation is not a pin. */
function pinnedSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

/**
 * SHAPE-CHECK one `readPr` result and turn it into the `read` finding. PURE — separated from the injected read
 * so the refusal below is testable without touching `gh` or `git`.
 *
 * THE REFUSAL: an `exec-contract` net-diff miss THROWS. `we:skills-src/review/SKILL.md` used to carry this as a
 * paragraph the model had to remember (*"This is a bug in YOUR wrapper to fix, not license to fall back"*, #2952).
 * Falling back there ships `gh pr diff`'s inflated three-dot list as if it were the PR's content — the exact
 * false positive #2450/#2901 exist to prevent. The other two misses (`ref-unresolved`, `diff-failed`) are
 * genuinely unfixable from here, so they DEGRADE: the finding carries `degraded` + the reason and every surface
 * that renders it says the basis is degraded, which is what the skill asked a human to remember to write down.
 *
 * @param {object} raw - what {@link ./review-pr-io.mjs}'s `readPr` returns.
 * @param {{pr: number, repo: string, careLevel?: string}} asked - what the run asked for, so a mismatched read is
 *   caught here. `careLevel` (#3335) is the shape the CALLER declared from the touch-set; see
 *   {@link assertDeclaredShapeHolds} for what it is checked against and which direction refuses.
 * @returns {object} the `read` finding.
 */
export function shapeReadFinding(raw, { pr, repo, careLevel } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`review-pr.read: the injected reader returned ${typeof raw}, not a PR context object`);
  }
  const detail = raw.detail && typeof raw.detail === 'object' ? raw.detail : {};
  const net = raw.net && typeof raw.net === 'object' ? raw.net : {};
  const diff = raw.diff && typeof raw.diff === 'object' ? raw.diff : {};

  // #xwp8ioh — THE LIVENESS REFUSAL, FIRST on purpose: before the net-diff contract check, before any
  // shaping, and — because this is the `read` step — before `judge` spends a juror. `we:scripts/review-set-
  // label.mjs` has refused an inert PR since #2953, but only at the WRITE side, so the cost was already sunk
  // by the time it fired. On 2026-08-20 that meant three correctness rounds (~$4) against PR #1503, which had
  // merged two hours before round 1 began; every refusal was right and every one of them was too late.
  //
  // `unknown` refuses too. A read that could not report the state has not told us the PR is live, and
  // reviewing on "we couldn't tell" is the absence-of-evidence-as-evidence move this engine refuses
  // everywhere else (`verify`'s `unrun`, #3203's killed-vs-crashed juror).
  const liveness = classifyPrLiveness({ state: raw.state });
  if (liveness.outcome !== 'reviewable') {
    throw new Error(
      `review-pr.read: ${inertPrMessage({ pr: `${repo}#${pr}`, state: liveness.state, phase: 'read' })}`,
    );
  }

  // #xwk0tzu (#3322) — THE SELF-CLEAR REFUSAL, MOVED TO `read` FOR THE SAME REASON THE LIVENESS ONE WAS.
  // Exactly the shape of the block above, and deliberately so: #2844's refusal was never wrong, it was LAST.
  // `we:scripts/review-set-label.mjs` fires it at `record`, which is after `judge` has spawned a juror and
  // been billed for it, and the operation cannot reach the one target that is exempt from it
  // (`--to=clear-human` is not a declarable step — see `record` below), so a run that trips it has NO
  // outcome: `accept` is terminally refused and the money is already gone. Two rounds on PR #1569 cost
  // roughly two dollars before that terminal refusal was even reachable.
  //
  // BOTH HALVES ARE KNOWABLE HERE, which is the whole reason the position can move. The author's id is a pure
  // read of the PR BODY the io shell already fetched (the `authored-by-actor` stamp `we:scripts/pr-land.mjs`
  // writes once, at open); the clearer's id is this process's harness session, read by the io shell because
  // it is the one input this pure function may not read for itself. Nothing new is asked of the network.
  //
  // ONLY A PROVEN `self-clear` REFUSES — the SAME narrowing the write side applies, imported not restated:
  //   • `unknown-author` / `unknown-clearer` PROCEED. Refusing "we could not establish it" would strand every
  //     PR opened before the stamp existed and every review run without a harness session (CI, a bare shell);
  //     `we:scripts/lib/review-independence.mjs`'s header argues that trade in full.
  //   • `stamp-lost` PROCEEDS TOO, and that is NOT this item turning a missing stamp into a pass. #3067
  //     DETECTS it — `prCreatedAt` and `stampLostMarked` are supplied below precisely so a stripped stamp
  //     resolves to `STAMP_LOST` here and not to `UNKNOWN_AUTHOR` — and its card records the refusal as
  //     deliberately NOT landed yet: "adding STAMP_LOST would block every PR opened outside pr-land … The
  //     refusal should land together with a route that stamps a PR opened without pr-land, not before it."
  //     Refusing it HERE, unilaterally, would both pre-empt that call and put the read side and the write
  //     side on two different answers — the drift #2644 forbids. So the status is COMPUTED, carried onto the
  //     finding as `independence` where a reader can see it, and gates nothing. When #3067's pairing lands,
  //     both sites widen together and this comment is the note that says where.
  //
  // A LEGITIMATE REVIEW IS UNTOUCHED: a session that did not open the PR compares two DIFFERENT ids, gets
  // `independent`, and proceeds exactly as before. That direction is tested as explicitly as the refusal —
  // getting it backwards would block every review, which is a far worse failure than the one being fixed.
  const independence = decideClearerIndependence({
    authorId: parseAuthorActorId(raw.body),
    clearerId: raw.clearerId,
    prCreatedAt: raw.createdAt,
    stampLostMarked: hasStampLostMarker(raw.body),
  });
  if (independence.status === INDEPENDENCE.SELF_CLEAR) {
    throw new Error(
      `review-pr.read: ${independence.reason}. Refusing BEFORE the \`judge\` step, so no juror is paid for a `
      + 'verdict this operation could never record: `--to=accepted` is refused at `record` by '
      + '`we:scripts/review-set-label.mjs` (#2844) and `--to=clear-human`, the one exempt target, is not '
      + 'reachable from this operation at all. THE ROUTE THAT WORKS is a DIFFERENT SESSION: run `review-pr` '
      + 'from a session that did not open this PR, so its own session id is the clearing actor and the '
      + `independence bar is genuinely met. There is no flag on this operation that lifts this — ${repo}#${pr} `
      + 'can also be cleared by the human ceremony `review-set-label.mjs --to=clear-human --actor=… '
      + '--reason="<the operator instruction>"`, which is run by hand and quotes an instruction (#2895).',
    );
  }

  if (net.scored !== true && net.reason === 'exec-contract') {
    throw new Error(
      `review-pr.read: the net-diff basis reported \`exec-contract\` for ${repo}#${pr} — the injected \`exec\` is `
      + 'not `(cmd, args, opts) => execFileSync(cmd, args, opts)`-shaped. That is a bug in the CALLER to fix, not '
      + 'license to fall back to `gh pr diff`, whose three-dot output lists sibling-lane files this PR does not '
      + 'touch (#2952/#2450). Refusing to review on an inflated basis.',
    );
  }

  const netChangedFiles = Array.isArray(net.paths) ? net.paths.map(String) : [];
  const degradedReason = net.scored === true ? '' : String(net.reason || 'unscored');

  // #xu2pp2m — A DEGRADED BASIS THAT ALSO PRODUCED NO DIFF AT ALL IS `unrun`, NOT A REVIEW. THROWS.
  //
  // MEASURED, NOT HYPOTHESISED (2026-09-12, PR #2122 — and it MERGED on this). A mechanical review ran in a
  // single-branch lane clone with no remote-tracking ref for the PR's head branch. `resolveNetDiffBasis` came
  // back `ref-unresolved`, `computeNetDiffText` returned ZERO bytes, and nothing in this pipeline refused:
  // `renderJudgeInput` handed all three seats `_(the net diff could not be resolved — see the degraded note)_`
  // and the panel reduced their answers to a clean `accept` over 560 lines of script + test nobody read. Two
  // of the three jurors only produced anything real because they independently went and FOUND the diff
  // themselves with their own tools — and, starting from two different self-recovered bases, disagreed.
  //
  // WHY THIS DOES NOT REOPEN THE `exec-contract` / degrade SPLIT ABOVE. The other two misses
  // (`ref-unresolved`, `diff-failed`) still DEGRADE whenever there is genuinely material to judge — that
  // remains right, and this refusal is strictly narrower than "refuse every degrade": it fires only when the
  // degrade produced NOTHING, where the alternative is not "a review on an imperfect basis" but "a verdict on
  // an empty page". An EMPTY diff on a SCORED basis is untouched (a PR that is genuinely a no-op vs main is a
  // real, honest read) — the conjunction is what makes this precise.
  if (degradedReason !== '' && !String(diff.text || '').trim()) {
    throw new Error(
      `review-pr.read: the net-diff basis for ${repo}#${pr} is DEGRADED (\`${degradedReason}\`) AND the diff `
      + 'came back EMPTY — there is nothing for a juror to review, so any verdict over it would be `unrun` '
      + 'dressed as a finding (#xu2pp2m; PR #2122 merged on exactly this false accept). Refusing BEFORE the '
      + '`judge` step, so no juror is paid to read an empty page. THE FIX IS ALMOST ALWAYS THE CHECKOUT: this '
      + 'read takes its diff from LOCAL git rooted at the `--cwd` checkout, and a single-branch clone has no '
      + `remote-tracking ref for this PR's head branch. Run review-pr from a checkout that can resolve it `
      + `(\`git fetch origin <head-ref>\` in the lane, or pass a \`--cwd=\` that already has it).`,
    );
  }

  // #3335 — THE DECLARED SHAPE MEETS THE TOUCH-SET, at the first moment both exist. Refuses an UNDER-declaration
  // (see `assertDeclaredShapeHolds` for why only that direction), and returns the derived shape either way so
  // the write-up can state what the touch-set EARNED beside what actually SAT.
  const earnedShape = assertDeclaredShapeHolds({ careLevel, netChangedFiles, pr, repo });

  return {
    hasReferralRecord: JSON.stringify(raw.comments ?? []).includes('mandatory-referrals-v1'),
    priorRounds: Number(raw?.priorRounds) || 0,
    latestFix: raw?.latestFix && typeof raw.latestFix === 'object' ? raw.latestFix : undefined,
    pr: Number(detail.pr) || Number(pr) || 0,
    repo: String(detail.repo || repo || ''),
    title: String(detail.title || ''),
    url: String(detail.url || ''),
    headRefName: String(raw.headRefName || ''),
    body: String(raw.body || ''),
    // #xwk0tzu — WHAT THE INDEPENDENCE CHECK ANSWERED, recorded even when it did not refuse. A status that
    // only ever appears in a thrown message is invisible on every run that proceeds, and the two statuses
    // that proceed WITHOUT proving independence (`unknown-author`, `stamp-lost`) are exactly the ones a
    // reader of the run record should be able to see. Silence would read as "independence held" — the
    // failure mode `we:scripts/review-set-label.mjs`'s own durable comment note exists to prevent.
    independence: String(independence.status || ''),
    labels: Array.isArray(detail.labels) ? detail.labels.map(String) : [],
    // FROM THE LABELS, per the card — never inferred from the diff or from what the PR touches.
    humanRequired: detail.humanRequired === true,
    reviewClass: String(detail.reviewClass || 'none'),
    disposition: detail.disposition ?? null,
    escalationReason: Array.isArray(detail.escalationReason) ? detail.escalationReason.map(String) : [],
    advisoryComment: detail.advisoryComment ?? null,
    humanComment: detail.humanComment ?? null,
    // ── GROUND TRUTH ──────────────────────────────────────────────────────────────────────────────────────
    netChangedFiles,
    // THE BASIS IS PINNED TO COMMITS, NOT REFS. `base` is already a merge-base SHA. `rev` used to be
    // `computeNetDiffPaths`'s `candidate`, i.e. `origin/<headRefName>` — a ref that moves the moment the lane
    // pushes again, so the recorded basis stopped describing the diff that was actually judged. The io shell
    // resolves that candidate to a commit (`revSha`) and the REF is kept separately for the reader.
    // `pinnedSha` refuses anything that is not a full 40-hex object name rather than pinning a shorter thing
    // that only looks like one — `rev: null` is a legible "unpinned", a half-pinned ref is not.
    netBasis: {
      base: net.base ?? null,
      rev: pinnedSha(net.revSha) ?? pinnedSha(net.rev),
      revRef: net.rev ? String(net.rev) : null,
      scored: net.scored === true,
    },
    diffText: String(diff.text || ''),
    diffScored: diff.scored === true,
    // ── NOT GROUND TRUTH: `gh`'s own file list, three-dot and inflated. Carried for DISPLAY only; nothing
    //    downstream of here may hand it to a juror. (#2901 — the console diff stat that disagreed with what the
    //    agent saw is this list, and naming it differently is what stops the two being confused.)
    ghDiffStat: Array.isArray(detail.diffStat) ? detail.diffStat : [],
    // #3335 — WHAT THE TOUCH-SET EARNED, recorded on the finding whether or not a shape was declared. `null`
    // only when there is no net file list to score (a degraded basis, which `degraded`/`degradedReason` already
    // report). The write-up reads it to state the shortfall; a reader of a verdict must be able to tell
    // "4 lenses did not run" apart from "this was a `high`-care statute change that got one of the thirty
    // juror-runs its dial asks for".
    earnedShape: earnedShape && {
      careLevel: earnedShape.careLevel,
      reasons: earnedShape.reasons,
      humanRequired: earnedShape.humanRequired,
      earnedLenses: earnedShape.earnedLenses,
      mandatoryFloor: earnedShape.mandatoryFloor,
      rounds: earnedShape.rounds,
      jurorsPerLens: earnedShape.jurorsPerLens,
      subject: earnedShape.subject,
      // What the CALLER declared, beside what the files score — so the record shows both, including the
      // over-declaring case that proceeds and the absent-declaration case that this item cannot force.
      declaredCareLevel: CARE_LEVEL_ORDER.includes(careLevel) ? careLevel : null,
    },
    degraded: degradedReason !== '',
    degradedReason,
  };
}

/** The material a juror sees: the PR's description and the NET diff, and nothing else (#2336 context isolation). */
export function renderJudgeInput(read) {
  const lines = [
    `PR ${read.repo}#${read.pr} — ${read.title}`,
    '',
    '## PR description',
    '',
    read.body?.trim() || '_(no description)_',
    '',
    `## Net changed files (${read.netChangedFiles.length})`,
    '',
    read.netChangedFiles.length ? read.netChangedFiles.map((p) => `- ${p}`).join('\n') : '_(none resolved)_',
    '',
    '## Net diff vs current main',
    '',
    read.diffText?.trim() || '_(the net diff could not be resolved — see the degraded note)_',
  ];
  return lines.join('\n');
}

/**
 * DOES THE RECORDED DECISION ACTUALLY DISAGREE WITH THE JUROR? PURE.
 *
 * WHY IT EXISTS. `renderVerdictWriteUp` used to render its "Why this was overridden … the decision above
 * differs from them" section on `reason` being non-empty ALONE. `--reason` is accepted on every answer, so
 * `--answer=accept --reason="fyi"` — or a `changes` answer the juror itself asked for — posted a durable
 * claim of disagreement where there was none. The reason is the operator's, but the *disagreement* is a fact
 * about two verdicts, and only this predicate may assert it.
 *
 * WHAT IT IS *NOT*: co-extensive with the reasonless-bounce refusal in `record`. RETRACTED — this docblock used
 * to claim *"zero findings is exactly `deriveVerdict`'s `accept`, so every case it refuses is a case this returns
 * true for."* That is false, and the two predicates ask genuinely different questions:
 *   - `record`'s guard binds on the JUROR'S FINDING COUNT being zero;
 *   - this binds on the JUROR'S VERDICT.
 * `deriveVerdict` returns `needs-human` on `humanRequired` BEFORE it looks at findings at all, and
 * `prevention-outstanding` on a finding that blocks acceptance without earning a round. Either can come back
 * with zero outstanding findings, so a `changes` there is refused without a reason (the author lane still has
 * nothing to read) and is still NOT captioned an override — the juror did not say accept, so there is no
 * disagreement to claim. That asymmetry is deliberate: the guard protects the AUTHOR, this predicate protects
 * the RECORD. `abstain` writes nothing at all, so it can never be an override.
 *
 * @param {{verdict?: {verdict?: string}, answer?: string}} o the juror's verdict and the operator's answer.
 * @returns {boolean} true iff the operator's answer departs from what the juror's verdict called for.
 */
export function overridesJuror({ verdict, answer } = {}) {
  const juror = verdict?.verdict;
  if (answer === 'accept') return juror !== VERDICTS.ACCEPT;
  if (answer === 'changes') return juror === VERDICTS.ACCEPT;
  // `abstain` declares no effects, so there is no recorded decision to disagree with anything.
  return false;
}

/**
 * ONE JUROR CALL RECIPE, TWO LENSES (#3319). Both `judge` steps call THIS — a second copy of the request
 * literal is how the two seats would drift into different jurors, and the whole claim of the second seat is
 * that it differs from the first in EXACTLY ONE respect: its lens.
 *
 * PURE. Returns `judgeSpawn`'s option shape (#3028); it spawns nothing, exactly like the step that calls it.
 *
 * WHAT IS DELIBERATELY NOT A PARAMETER: `input`. Both jurors are shown `renderJudgeInput(read)` — the SAME PR
 * description and the SAME net diff, and nothing else (#2336 context isolation). A second seat that saw
 * different material would not be a second opinion on this diff, it would be an opinion on another one.
 *
 * @param {object} o
 * @param {object} o.read - the `read` step's finding.
 * @param {string} o.lens - the lens this seat judges under. A `PANEL_LENSES` member; `buildPanelMandate`
 *   refuses anything else before it can become argv.
 * @param {string} [o.aim] - the caller's #3094 hypothesis, or `''`.
 * @returns {object} the judge request.
 */
export function buildReviewJudgeRequest({ read, lens, aim = '' }) {
  return {
    // GROUND TRUTH goes in as the NET list, never `ghDiffStat` (#2450).
    // `fenced: true` (#2967) — `read.title` is the PR title straight off `gh pr view`, written by whoever
    // opened the PR, so it goes to the juror inside the #2438 labelled data fence rather than in
    // instruction position. What that fixes is caller-supplied text reaching the mandate unfenced; whether
    // a crafted title could actually move a verdict is UNMEASURED, so this is hygiene, not a patched hole.
    mandate: buildPanelMandate({
      lens, netChangedFiles: read.netChangedFiles, goal: read.title, fenced: true, aim,
    }),
    input: renderJudgeInput(read),
    shape: REVIEW_JUDGE_SHAPE,
    lens,
    model: JUDGE_MODEL,
    effort: JUDGE_EFFORT,
    budget: JUDGE_BUDGET_USD,
    // TOOL-BEARING. A juror that can only read a diff finds none of the defects the hand-run reviews found
    // this week — a gh flag bypass proven by firing the command, a guard hole reproduced on the parent
    // commit, four decorative tests found by mutating source. The tools ARE the finding mechanism.
    // Isolation is structural instead: `assertLaneCwd` refuses the spawn unless the cwd is a lane of the
    // juror's OWN — not the primary checkout, and not the driver's lane. It cannot lean on
    // `guard-lane`, because `--safe-mode` disables hooks inside the juror; see
    // `we:scripts/lib/judge-spawn.mjs`
    // and its sessionId is derived, so the self-clear refusal holds against the author.
    //
    // #3319 — BOTH seats carry it. This is the single line that option (b) could not have: `judgePanel`
    // (`we:scripts/lib/judge-panel.mjs`) never forwards `allowedTools`, so wiring the panel would have made
    // the security seat — and the correctness one with it — `--tools ''`. That is #3158, and it is open.
    allowedTools: REVIEW_JUROR_TOOLS,
  };
}

/**
 * #xqa9ttq — CORRECTS `buildMandate`'s "if you have no tools at all, you cannot run or clone anything" branch
 * (`we:scripts/lib/review-core.mjs`) FOR THIS SEAT SPECIFICALLY. That branch is accurate for a genuinely
 * zero-tool Claude juror (`--tools ''`), but this seat runs on Codex, which ALWAYS gets `-s read-only` —
 * a real, if read-only, shell (confirmed live: `git --version`/`git status` exit 0; only a write, e.g.
 * `mktemp -d`, gets `Operation not permitted` — see `we:scripts/lib/codex-judge-spawn.mjs`). Left uncorrected,
 * the shared mandate text would tell this juror it has "no tools at all", which is false and could lead it to
 * either under-report what it actually checked or misdescribe why it could not run something.
 *
 * APPENDED RATHER THAN EDITING `buildMandate`/`buildPanelMandate` THEMSELVES: those functions are shared by
 * every OTHER panel seat, including genuinely tool-free Claude jurors (`we:scripts/lib/judge-panel.mjs`) for
 * whom "no tools at all" remains true — rewriting the shared text would fix this seat by breaking theirs.
 */
export const CODEX_ADVISORY_SANDBOX_CORRECTION = [
  'CORRECTION TO THE ABOVE FOR YOUR SEAT SPECIFICALLY: you are not a tool-free juror. You run with a real,',
  'read-only shell (you can run non-mutating commands and read files), but you CANNOT write, create a temp',
  'directory, clone anything, or mutate anything — any such attempt will fail. So: ignore any instruction above',
  'that assumes you have "no tools at all" — you do have a read-only shell — but the practical conclusion is',
  'the same one that text reaches for a write/clone/repro step: you cannot perform it, so say so plainly rather',
  'than describing verification you did not perform.',
].join(' ');

/**
 * #xqa9ttq — THE THIRD SEAT'S RECIPE. Same mandate/input shaping as {@link buildReviewJudgeRequest} — same
 * diff, same description, same #2336 context isolation — but structurally different in the two fields that
 * make this seat what it is:
 *
 *   - NO `allowedTools`. This seat is deliberately advisory-only and diff-only, not merely "the same juror
 *     with a different lens" — see the file header's account of why `--provider=codex` cannot simply be
 *     applied to the existing two seats (BOTH set `allowedTools` unconditionally, and `createDefaultJudge`
 *     structurally refuses `codex` + `allowedTools` together, #3581).
 *   - `providerName: 'codex'`, carried ON THE REQUEST rather than relying on the run's `--provider` flag, so
 *     this seat runs Codex regardless of what provider the OTHER two seats use in the SAME run — see
 *     `createDefaultJudge`'s per-request `providerName` override in `cli-adapter.mjs`.
 *
 * NO `model` EITHER, and that omission is deliberate rather than an oversight: `JUDGE_MODEL` ('sonnet') is a
 * Claude model name that would reach Codex's `-m` flag VERBATIM (`codex-judge-spawn.mjs#buildCodexJudgeArgv`)
 * — passing it would ask `codex exec` to run a model it does not have. No live probe (#3371) established a
 * correct Codex model name, so this seat omits `model` and takes whatever `codex exec` defaults to, rather
 * than shipping an unverified guess.
 *
 * @param {object} o
 * @param {object} o.read - the `read` step's finding.
 * @param {string} [o.aim] - the caller's #3094 hypothesis, or `''`.
 * @returns {object} the judge request.
 */
export function buildReviewAdvisoryJudgeRequest({ read, aim = '' }) {
  return {
    // #xqa9ttq — `CODEX_ADVISORY_SANDBOX_CORRECTION` is appended, not spliced in: it corrects the shared
    // mandate's "no tools at all" framing for THIS seat only, without touching `buildPanelMandate`'s text
    // (shared by every other, genuinely tool-free-or-tool-bearing, panel seat).
    mandate: `${buildPanelMandate({
      lens: ADVISORY_JUDGE_LENS, netChangedFiles: read.netChangedFiles, goal: read.title, fenced: true, aim,
    })} ${CODEX_ADVISORY_SANDBOX_CORRECTION}`,
    input: renderJudgeInput(read),
    shape: REVIEW_JUDGE_SHAPE,
    lens: ADVISORY_JUDGE_LENS,
    effort: JUDGE_EFFORT,
    budget: JUDGE_BUDGET_USD,
    // #xqa9ttq — PINS THIS SEAT TO CODEX, independent of the run's `--provider` flag. See `createDefaultJudge`.
    providerName: 'codex',
    // #x5s8b47 — THIS SEAT MAY BE SKIPPED, NEVER LET TO CRASH THE RUN. Measured live (card x5s8b47, PRs
    // #2865/#2867/#2873/#2874/#2875): Codex's own quota gauge going exhausted made this seat's spawn fail with
    // no graceful path at all, and the failure was never contained — it crashed the whole `review-loop-cli`
    // process, leaving the run permanently suspended at THIS step (a fresh dispatch always starts a new run
    // from `read`, so it never resumes the orphaned one — it just re-hits the identical wall). `judgeAdvisory`
    // is ALREADY structurally non-blocking (`ADVISORY_JUDGE_LENS` is drawn from `ADVISORY_LENSES`, never
    // `MANDATORY_LENSES` — see this file's own `ADVISORY_JUDGE_SEAT` docblock), so "the provider was
    // unavailable" is honestly a SKIP, not a run failure: the two mandatory seats (`judge`/`judgeSecurity`)
    // still judge and the panel still reduces to a real verdict. `createDefaultJudge` (`cli-adapter.mjs`) reads
    // this flag to: (a) check Codex's quota-hold state (`review-extra-seats.mjs#quotaHold`, the SAME reader its
    // own bonus-seat path already applies — REUSED, not restated) before spawning at all, falling back to the
    // `antigravity` provider when Codex is held and antigravity is not; and (b) wrap the actual spawn so ANY
    // thrown error becomes a recorded, logged skip instead of an uncaught crash. Either way the seat's answer
    // still carries a non-empty `summary` (`reduce`'s own silent-juror refusal, just above in this file,
    // requires one), so a skip reads as an ordinary — if uninformative — juror answer to every downstream
    // consumer, never as `unrun`.
    gracefulOnUnavailable: true,
  };
}

/**
 * #x8n4crp — THE FOURTH SEAT'S FRAMING TEXT, appended after the ungated correctness-flavoured base mandate (see
 * {@link buildReviewCorrectnessAdvisoryMandate}). Tells the juror plainly what its seat IS and is NOT, so it
 * never assumes it is the run's one mandatory correctness juror (it cannot see that one's findings, and must
 * not soften or hedge on the assumption something else already caught the real bugs).
 */
export const CORRECTNESS_ADVISORY_FRAMING = [
  'You are an INDEPENDENT correctness reviewer running ALONGSIDE this PR\'s panel — a second, structurally',
  'different opinion on the SAME diff a separate, mandatory `correctness`-lensed juror ALSO judges. You cannot',
  'see that juror\'s findings, and it cannot see yours: each of you starts from the diff alone. Judge for the',
  'same thing that mandatory juror judges for — genuine correctness bugs: logic errors, broken invariants,',
  'behaviour this diff introduces that is actually wrong — using your own judgement, not a guess at what the',
  'other juror already covered. Your OWN verdict here is ADVISORY: it is reported to the operator, and it never',
  'blocks this PR from landing on its own, however severe your findings are. Do NOT soften a finding because of',
  'that — report exactly what you would report if your verdict could block, and let the operator weigh it.',
].join(' ');

/**
 * #x8n4crp — THE FOURTH SEAT'S MANDATE. Built through the UNGATED `buildMandate` — never `buildPanelMandate`,
 * which throws on any lens outside `PANEL_LENSES` (see {@link CORRECTNESS_ADVISORY_LENS}'s own docblock for why
 * this seat's bookkeeping lens is deliberately NOT a `PANEL_LENSES` member). The base mandate's TOPIC WORD is
 * still the real `DEFAULT_LENS` (`'correctness'`) — so the juror is instructed to judge for correctness exactly
 * the way the mandatory seat is — only the SEAT'S OWN bookkeeping key differs.
 *
 * Composed to match what `buildPanelMandate` would have added, piece for piece, since this seat cannot go
 * through it: the aim-hypothesis block (#3094, only when `aim` is non-empty — identical wording, built from the
 * same `FENCED_DATA_RULE`/`fenceUntrusted` pieces `buildPanelMandate` itself uses) and the unconditional
 * mutation-probe instruction (#3094's own ruling: it is not gated on the lens, since the wording is a natural
 * no-op for a finding that changes no behaviour). `CODEX_ADVISORY_SANDBOX_CORRECTION` is appended last, exactly
 * as it is for the existing `judgeAdvisory` seat, since this seat runs on the identical read-only Codex shell.
 *
 * @param {object} o
 * @param {object} o.read - the `read` step's finding.
 * @param {string} [o.aim] - the caller's #3094 hypothesis, or `''`.
 * @returns {string}
 */
export function buildReviewCorrectnessAdvisoryMandate({ read, aim = '' }) {
  const base = buildMandate({ mandate: DEFAULT_LENS, goal: read.title, fenced: true });
  const parts = [base, CORRECTNESS_ADVISORY_FRAMING];
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
  parts.push(MUTATION_PROBE_RULE);
  return `${parts.join(' ')} ${CODEX_ADVISORY_SANDBOX_CORRECTION}`;
}

/**
 * #x8n4crp — THE FOURTH SEAT'S RECIPE. Same shape as {@link buildReviewAdvisoryJudgeRequest} — no `allowedTools`,
 * no `model`, `providerName: 'codex'` — but its own mandate builder ({@link buildReviewCorrectnessAdvisoryMandate})
 * and its own effort ({@link CORRECTNESS_ADVISORY_EFFORT}, `'medium'` — NOT the shared `JUDGE_EFFORT` the other
 * three seats use).
 *
 * @param {object} o
 * @param {object} o.read - the `read` step's finding.
 * @param {string} [o.aim] - the caller's #3094 hypothesis, or `''`.
 * @returns {object} the judge request.
 */
export function buildReviewCorrectnessAdvisoryJudgeRequest({ read, aim = '' }) {
  return {
    mandate: buildReviewCorrectnessAdvisoryMandate({ read, aim }),
    input: renderJudgeInput(read),
    shape: REVIEW_JUDGE_SHAPE,
    lens: CORRECTNESS_ADVISORY_LENS,
    effort: CORRECTNESS_ADVISORY_EFFORT,
    budget: JUDGE_BUDGET_USD,
    // #x8n4crp — PINS THIS SEAT TO CODEX, independent of the run's `--provider` flag, exactly like the existing
    // third seat. See `createDefaultJudge`.
    providerName: 'codex',
    // #2883 follow-up (card x5s8b47) — LIVE INCIDENT, 2026-09-28: this seat is the SECOND Codex advisory seat,
    // and it was left out of the `gracefulOnUnavailable` fix `buildReviewAdvisoryJudgeRequest` (the THIRD seat,
    // just above) got for the identical reason — see that seat's own docblock for the full account. Runs
    // #2865/#2867/#2871/#2873/#2875 were all measured suspended at `pending.step: 'judgeCorrectnessAdvisory'`
    // with Codex quota-held, because THIS seat still spawned unconditionally and crashed the whole
    // `review-loop-cli` process exactly the way the third seat used to. This seat is advisory too
    // (`CORRECTNESS_ADVISORY_LENS` is not a `MANDATORY_LENSES` member — see this seat's own docblock above), so
    // "the provider was unavailable" is honestly a SKIP here as well, never a run failure. Same
    // `createDefaultJudge` (`cli-adapter.mjs`) graceful path the third seat already exercises — reused, not
    // reimplemented.
    gracefulOnUnavailable: true,
  };
}

/**
 * #3383 — THE FIFTH SEAT'S FRAMING TEXT, appended after the ungated correctness-flavoured base mandate (see
 * {@link buildReviewAntigravityMandate}) — mirrors {@link CORRECTNESS_ADVISORY_FRAMING} almost verbatim,
 * generalized to "an independent reviewer" rather than naming a fixed sibling count, since this seat may run
 * alone, alongside either (or both) Codex opt-in seats. Also states this seat's own, STRONGER isolation
 * (genuinely zero tools, never a read-only shell) up front — `antigravity-judge-spawn.mjs`'s own header
 * documents the seat's single most dangerous failure mode (#3633 probe 7): a prompt that leads the model to
 * reach for a tool it structurally cannot use ends in a SILENT empty answer (`status: "SUCCESS"`, no
 * `structured_output` at all) rather than a visible refusal. Telling the juror plainly, up front, that it has
 * no tools and must not try is the mandate-side half of guarding against that; `parseAntigravityJudgeOutcome`'s
 * own throw is the other half.
 */
export const ANTIGRAVITY_REVIEW_FRAMING = [
  'You are an INDEPENDENT correctness reviewer running ALONGSIDE this PR\'s panel — a structurally different',
  'opinion on the SAME diff a separate, mandatory `correctness`-lensed juror ALSO judges (and, on some runs, one',
  'or two further OPTIONAL Codex-backed seats judge too). You cannot see any of their findings, and none of',
  'them can see yours: each of you starts from the diff alone. Judge for the same thing that mandatory juror',
  'judges for — genuine correctness bugs: logic errors, broken invariants, behaviour this diff introduces that',
  'is actually wrong — using your own judgement, not a guess at what another juror already covered. Your OWN',
  'verdict here is ADVISORY: it is reported to the operator, and it never blocks this PR from landing on its',
  'own, however severe your findings are. Do NOT soften a finding because of that — report exactly what you',
  'would report if your verdict could block, and let the operator weigh it. YOU HAVE NO TOOLS AT ALL FOR THIS',
  'SEAT — not even a read-only shell: do not attempt to read any file beyond the material below, run any',
  'command, or verify anything live. Judge from the diff and description alone, and say so plainly rather than',
  'describing verification you did not perform.',
].join(' ');

/**
 * #3383 — THE FIFTH SEAT'S MANDATE. Built through the UNGATED `buildMandate` — never `buildPanelMandate` — for
 * the identical reason {@link buildReviewCorrectnessAdvisoryMandate} is: `ANTIGRAVITY_REVIEW_LENS` is
 * deliberately not a `PANEL_LENSES` member, and `buildPanelMandate` throws on any lens outside it. The base
 * mandate's TOPIC WORD is still the real `DEFAULT_LENS` (`'correctness'`) — this seat judges for the same
 * thing the mandatory seat and the fourth (Codex) seat do — only the BOOKKEEPING key differs.
 *
 * Composed piece for piece like {@link buildReviewCorrectnessAdvisoryMandate}: the aim-hypothesis block (#3094,
 * only when `aim` is non-empty, built from the same `FENCED_DATA_RULE`/`fenceUntrusted` pieces every other
 * mandate in this file uses) and the unconditional {@link MUTATION_PROBE_RULE} — which already carries its own
 * "when you have NO tools" branch, so it needs no seat-specific correction the way the THIRD (Codex) seat's
 * mandate does (that seat actually has a partial, read-only shell; this one has none at all).
 *
 * @param {object} o
 * @param {object} o.read - the `read` step's finding.
 * @param {string} [o.aim] - the caller's #3094 hypothesis, or `''`.
 * @returns {string}
 */
export function buildReviewAntigravityMandate({ read, aim = '' }) {
  const base = buildMandate({ mandate: DEFAULT_LENS, goal: read.title, fenced: true });
  const parts = [base, ANTIGRAVITY_REVIEW_FRAMING];
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
  parts.push(MUTATION_PROBE_RULE);
  return parts.join(' ');
}

/**
 * #3383 — THE FIFTH SEAT'S RECIPE. Same shape as {@link buildReviewCorrectnessAdvisoryJudgeRequest} — no
 * `allowedTools`, no `model` (the provider boundary in `cli-adapter.mjs#resolveJudgeProvider` pins
 * `ANTIGRAVITY_MODEL` by default; an explicit `request.model` still wins there) — but its own mandate builder
 * ({@link buildReviewAntigravityMandate}), its own lens, its own effort ({@link ANTIGRAVITY_REVIEW_EFFORT},
 * `'low'` — NOT `JUDGE_EFFORT` and NOT `CORRECTNESS_ADVISORY_EFFORT`), and `providerName: 'antigravity'`.
 *
 * @param {object} o
 * @param {object} o.read - the `read` step's finding.
 * @param {string} [o.aim] - the caller's #3094 hypothesis, or `''`.
 * @returns {object} the judge request.
 */
export function buildReviewAntigravityJudgeRequest({ read, aim = '' }) {
  return {
    mandate: buildReviewAntigravityMandate({ read, aim }),
    input: renderJudgeInput(read),
    shape: REVIEW_JUDGE_SHAPE,
    lens: ANTIGRAVITY_REVIEW_LENS,
    effort: ANTIGRAVITY_REVIEW_EFFORT,
    budget: JUDGE_BUDGET_USD,
    // #3383 — PINS THIS SEAT TO ANTIGRAVITY, independent of the run's `--provider` flag, exactly like both
    // existing Codex seats pin themselves to `codex`. See `createDefaultJudge`.
    providerName: 'antigravity',
  };
}

// `foldUntrusted` lives in jury-core so `explainPanelOutcome` (the note's first line) shares it; re-exported here.
export { foldUntrusted };

/**
 * The "Card suggestions (filed later)" section for later-round advisory findings that were diverted out of
 * `verdict.findings` (#5135). ONE renderer shared by `renderAdvisoryNote` and `renderVerdictWriteUp`, so a
 * verdict that diverts findings can never be shown by one comment and silently dropped by the other. PURE.
 *
 * @param {{read: object, verdict: object}} o
 * @returns {string[]} lines (empty when nothing was deferred).
 */
export function renderDeferredAdvisorySection({ read, verdict } = {}) {
  const deferred = Array.isArray(verdict?.deferredAdvisory) ? verdict.deferredAdvisory : [];
  if (!deferred.length) return [];
  const fix = read?.latestFix;
  return [
    '',
    `### Card suggestions (filed later) (${deferred.length})`,
    `Later-round advisory findings on code the latest fix (\`${foldUntrusted(fix?.priorHead?.slice(0, 8))}..${foldUntrusted(fix?.head?.slice(0, 8))}\`) did not touch. They do not count toward \`changes\`; file them as cards instead of fixing them in this PR (#5135).`,
    ...deferred.map(f => {
      const lens = foldUntrusted(String(f.category ?? '').split('/')[0]);
      const cite = foldUntrusted(f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : String(f.summary ?? '').slice(0, 60));
      return `- \`${lens}\` \`${cite}\` — ${foldUntrusted(f.summary)}`;
    }),
  ];
}

/**
 * The durable verdict write-up posted as the PR comment. EXTENDS `renderPanelComment`
 * (`we:scripts/lib/review-render.mjs`, #2432) rather than hand-rolling markdown — the operation adds only the
 * three lines that are ITS business: who decided, on what basis, and whether that basis was degraded.
 * PURE.
 */
export function renderVerdictWriteUp({ read, verdict, answer, actor, reason = '' }) {
  const overrode = overridesJuror({ verdict, answer });
  // #3319 — THE ROSTER TRAVELS ON THE VERDICT. `lens` used to be a separate parameter, which was the seam
  // through which the write-up could describe a different set of seats than the reduction was computed over.
  const lensVerdicts = verdict.lensVerdicts && typeof verdict.lensVerdicts === 'object' ? verdict.lensVerdicts : {};
  const lensProviders = verdict.lensProviders && typeof verdict.lensProviders === 'object' ? verdict.lensProviders : {};
  const lenses = Array.isArray(verdict.lenses) && verdict.lenses.length ? verdict.lenses : Object.keys(lensVerdicts);
  const absent = PANEL_LENSES.filter((l) => !lenses.includes(l));
  const body = renderPanelComment({
    findings: verdict.findings,
    verdict: verdict.verdict,
    disposition: read.disposition,
    lensVerdicts,
    // #xqa9ttq — names a non-Claude seat (the Codex advisory juror) inline in its row instead of an anonymous
    // `simplicity | advisory | accept` indistinguishable from a Claude seat.
    lensProviders,
    // THE TABLE LISTS WHAT RAN, NOT WHAT EXISTS. `renderPanelComment` defaults `lenses` to the whole
    // `PANEL_LENSES` set, so the first live run (PR #1146) rendered `security | mandatory | (no verdict)`
    // directly under "✅ pass — no blocking findings": three mandatory lenses shown as unjudged beside a pass,
    // which reads as a hole in the review. It was not a hole then (one `judge` step, one juror) and it is not
    // one now — but WHAT ran has changed, so this passes the seats the run ACTUALLY seated (#3319) rather than
    // a hard-coded singleton. Two rows today; still never a row for a lens nobody judged.
    lenses,
    // #3319 — the MANDATORY column is scoped to what this run seated, for exactly the same reason the row set
    // is. `renderPanelVerdictTable` defaults `mandatoryLenses` to the whole ratified pair, which is right when
    // both are present and would print `mandatory` beside a lens with no row if a caller ever seats only one.
    mandatoryLenses: MANDATORY_LENSES.filter((l) => lenses.includes(l)),
    heading: `Human review verdict — ${read.repo}#${read.pr}`,
  });
  const basis = read.degraded
    ? `⚠️ DEGRADED BASIS (\`${read.degradedReason}\`) — the net diff vs current main could not be resolved, so the `
      + 'file list below may be inflated by sibling-lane content this PR does not touch (#2450).'
    : `Net basis: \`${read.netBasis.base ?? '?'}..${read.netBasis.rev ?? '?'}\`${renderRevProvenance(read.netBasis)} — `
      + `${read.netChangedFiles.length} net changed file(s) vs current main (#2450), not \`gh pr diff\`'s three-dot list.`;
  return [
    body,
    ...renderDeferredAdvisorySection({ read, verdict }),
    '',
    '---',
    '',
    `**Decision:** \`${answer}\` — recorded by ${actor}.`,
    // THE OPERATOR'S OWN WORDS, rendered where the author lane reads the bounce. The panel body above is the
    // JUROR's output; when the operator disagrees with it, that disagreement is the actionable half and it
    // belongs beside the decision, not in a separate comment somebody has to go find.
    //
    // RETRACTED — this comment used to end *"Omitted entirely when there is no override, so an ordinary accept
    // is unchanged."* That was WRONG on both halves: the section rendered on `reason` being non-empty alone, so
    // `--answer=accept --reason="fyi"` rendered it, and rendered it claiming a disagreement that did not exist.
    // Which heading is used is now decided by `overridesJuror` — the fact — and never by reason-present.
    ...(reason
      ? ['', overrode
        ? `**Why this was overridden.** The ${lenses.length} juror(s) (${lenses.join(', ')}) reported above; the `
          + 'decision above differs from what they reduced to. The operator gave this reason:'
        // NOT AN OVERRIDE, SO IT MUST NOT SAY ONE. `--reason` is accepted on every answer; when the decision
        // agrees with the juror the operator's words are still worth carrying, but calling them an override
        // would be a false claim about the record (see `overridesJuror`).
        : `**Operator note.** The decision above agrees with the panel reduction over ${lenses.join(', ')}; this `
          + 'is not an override. The operator added:', '', `> ${reason.split('\n').join('\n> ')}`, '']
      : []),
    // THE LENS LINE SAYS WHAT RAN AND WHAT DID NOT, in words, beside a table that could otherwise be read as
    // the whole panel. It is deliberately still a NOT-A-PANEL disclosure: `${lenses.length}` separate
    // `judge` steps is not the same thing as `judgePanel` (#3050), and a reader who believes it was gets a
    // false picture of the concurrency, the budget and the roster this verdict came from.
    ...(Array.isArray(verdict.skippedSeats) && verdict.skippedSeats.length
      ? [`**Skipped seats (did not judge — their rows above are not a verdict):** ${verdict.skippedSeats.map((k) => `\`${k.lens}\` — ${k.reason}`).join('; ')}`, '']
      : []),
    `**Lenses:** ${lenses.map((l) => `\`${l}\``).join(' + ')} — ${lenses.length} juror(s), one per lens, each a `
      + 'separate `judge` step spawned with its own derived session id (#3028) and its own tools (#3319). They '
      + 'ran SEQUENTIALLY and neither saw the other\'s findings; this is not a `judgePanel` fan-out (#3050). '
      + (absent.length
        ? `The other ${absent.length} panel lens(es) (${absent.join(', ')}) did NOT run and are not reported as unjudged.`
        : 'Every panel lens judged.'),
    // #3335 — WHAT THE TOUCH-SET EARNED, BESIDE WHAT SAT. The line above says which lenses did not run; it has
    // never said whether the PR EARNED them. A reader of #1580 saw "4 lenses did not run" and could not tell a
    // proportionate review from a `high`-care statute change that got one of the thirty juror-runs its dial
    // asks for. Both halves are now stated, and both are defended by named tests — the "did NOT run" sentence
    // above is exactly the kind of true sentence a later edit deletes by accident.
    renderEarnedShortfall({ read, lenses }),
    basis,
    '',
    `_Recorded through the declared \`${REVIEW_PR_OP}\` operation (#3035)._`,
  ].join('\n');
}

/**
 * #3540 — THE record DECISION, DERIVED ONCE. PURE. Both `stageVerdict` and `record` call this so the write-up
 * `stageVerdict` stages LOCALLY and the label swap `record` posts from disk can never compute two different
 * bytes, two different `bodyFile` names, or two different answers to "is this allowed" for one run.
 *
 * THROWS THE SAME TWO REFUSALS `record` HAS ALWAYS HAD — INVARIANT 2 (`decideSetLabel`) and the reasonless-
 * bounce guard — moved here so BOTH steps refuse identically. Calling this from `stageVerdict` (which runs
 * first) means a disallowed target — `accept` on a `review:human` PR, a reasonless `changes` — is refused
 * BEFORE the write-up is ever staged, not only later at `record`: strictly EARLIER than before, never later.
 *
 * `abstain` is the one non-effect answer: `{ abstain: true }` tells both callers to declare nothing, exactly as
 * `record`'s own `effects` fn always has.
 *
 * @param {{input: {pr: number, repo: string, actor: string, reason?: string}, verdict: object,
 *   findings: {read: object, confirm: string}}} view
 * @returns {{abstain: true} | {to: string, decision: object, bodyFile: string, body: string, pr: number,
 *   repo: string, actor: string, read: object, verdict: object}}
 */
export function planRecordDecision(view) {
  const answer = view.findings.confirm;
  // THE NON-MUTATING EXIT. The operator looked and chose not to record: zero effects, which the engine resolves
  // in the same `advance` rather than suspending. This is how a run is exercised end to end against a real PR
  // without touching it.
  if (answer === 'abstain') return { abstain: true };

  const read = view.findings.read;
  const verdict = view.verdict || {};
  const pr = view.input.pr;
  const repo = view.input.repo;
  const actor = view.input.actor;
  const to = answer === 'accept' ? 'accepted' : 'changes';
  if (verdict.pendingReferrals?.length || (to === 'accepted' && verdict.blockedReferrals?.length)) {
    throw new Error('Mandatory finding-specific ruling required before recording acceptance; resume the referral review.');
  }

  // ── THE PURE-CORE GUARD (property 2 in the file header) ──────────────────────────────────────────────────
  // INVARIANT 2 lives in `decideSetLabel`, imported, unbypassable. On a `review:human` PR `to:'accepted'` comes
  // back `allowed:false` and this step THROWS — no effect entry is created, so there is nothing to apply,
  // nothing to replay and nothing half-done. The generated caller therefore cannot clear a gate-self PR any
  // more than the hand-written one could, and for the same reason: the decision is not its to make. The
  // sanctioned clearance (`--to=clear-human`, #2895) is DELIBERATELY not reachable from here — it demands an
  // operator instruction quoted verbatim, which is judgment, not a declared step.
  // ── THE REASONLESS-BOUNCE REFUSAL (#3035) ─────────────────────────────────────────────────────────────────
  // A `changes` recorded over a juror that raised NOTHING is an override, and an override with no stated reason
  // ships a comment that reads "✅ pass — no blocking findings" beside "Decision: `changes`". The author lane
  // is then bounced with nothing to act on and comes back for another round having changed whatever it
  // guessed at. Refuse it here, in the pure core, so no caller can post one: either the juror named findings,
  // or the operator names a reason.
  //
  // The check is deliberately narrow. A bounce that CARRIES juror findings needs no `--reason` — the findings
  // are the reason, and they are already rendered. This only binds the empty case.
  const overrideReason = typeof view.input.reason === 'string' ? view.input.reason.trim() : '';
  const jurorFindings = Array.isArray(verdict.findings) ? verdict.findings.length : 0;
  if (answer === 'changes' && jurorFindings === 0 && overrideReason === '') {
    throw new Error(
      `review-pr.record: refusing to record \`changes\` on ${repo}#${pr} with no stated reason — the `
      // #3319 — ALL of them, named. "the `correctness` juror returned 0 findings" would now be a claim about
      // one of two seats, and the operator's next question is exactly "which one was silent?".
      + `${(verdict.lenses ?? []).length} juror(s) (${(verdict.lenses ?? []).join(', ')}) returned 0 `
      + 'findings between them, so this is an OPERATOR OVERRIDE and the write-up '
      + 'would post "no blocking findings" above "Decision: `changes`". The author lane cannot act on '
      + 'that, so it buys another round. Pass `--reason="<what must change>"` on this same --resume, or '
      + 'record `abstain` to write nothing. (18 bounces across 8 PRs, #1556–#1567, were reasonless in '
      + 'exactly this way — see the counted sweep and its retractions at the `reason` input above.)',
    );
  }

  const decision = decideSetLabel({ to, currentLabels: read.labels });
  if (!decision.allowed) {
    throw new Error(
      `review-pr.record: refusing to record \`${to}\` on ${repo}#${pr} — ${decision.reason}. `
      + 'The refusal is `decideSetLabel` in `we:scripts/review-set-label.mjs` (INVARIANT 2, #2470/#2644); '
      + 'this operation does not carry a route around it. A gate-self PR is cleared only by the human '
      + 'ceremony `review-set-label.mjs --to=clear-human --actor=… --reason="<the operator instruction>"` '
      + '(#2895), which quotes an instruction and is therefore not a declarable step.',
    );
  }

  // DETERMINISTIC, from `repo`+`pr` alone — never from `runId` or anything else that could differ between the
  // two callers. This is the property that makes `stageVerdict`'s staged file and `record`'s label-swap payload
  // name the SAME path without either reading the other's finding (#3540).
  const bodyFile = `${repo.replace(/[^\w.-]+/g, '-')}-${pr}-verdict.md`;
  // #3319 — the roster travels ON the verdict (`lenses` / `lensVerdicts`), so the renderer is no longer handed
  // a lens separately: that was the seam through which the write-up could describe a different set of seats
  // than the reduction was computed over.
  const body = renderVerdictWriteUp({ read, verdict, answer, actor, reason: overrideReason });

  return {
    to, decision, bodyFile, body, pr, repo, actor, read, verdict,
  };
}

/**
 * #3335 — THE EARNED-VS-SEATED LINE. PURE.
 *
 * The write-up already names the lenses that did not run. This names what the PR's own touch-set EARNED, so the
 * two can be compared: the derived care level, the fan-out its dial asks for, what this run actually seated, and
 * the SHORTFALL between them. Without it, "the other 3 panel lenses did NOT run" is a true sentence a reader
 * cannot act on — it is identical text on a card-only PR that earned no panel at all and on a statute change
 * that earned five lenses, two jurors and three rounds.
 *
 * IT NEVER ASSERTS A SHAPE IT DOES NOT HAVE. `read.earnedShape` is `null` when the net file list could not be
 * scored (a degraded basis), and this then says exactly that rather than printing a `none` it did not derive.
 *
 * WHAT IT DOES *NOT* CLAIM: that the shortfall was avoidable. It is structural — the step list is fixed at
 * REGISTRATION (#3319's residual), so this operation seats the seats it declares whatever the dial asks. The
 * line records the gap; closing it is #3050/#3158's panel, not this.
 *
 * @param {{read: object, lenses: string[]}} o
 * @returns {string} one markdown line.
 */
export function renderEarnedShortfall({ read, lenses = [] } = {}) {
  const shape = read && read.earnedShape;
  if (!shape) {
    return '**Earned vs seated:** the touch-set could not be scored (no net changed-file list — see the basis '
      + 'note below), so what this PR EARNED is UNKNOWN and the seats above must not be read as proportionate.';
  }
  const seated = Array.isArray(lenses) ? lenses : [];
  const shortfall = (shape.earnedLenses || []).filter((l) => !seated.includes(l));
  const declared = shape.declaredCareLevel
    ? `The caller declared \`--careLevel=${shape.declaredCareLevel}\`.`
    : 'The caller declared no `--careLevel`, so nothing checked the shape this run was dialled for against the '
      + 'files it actually judged (#3335).';
  return `**Earned vs seated:** this PR's ${shape.subject} touch-set scores care \`${shape.careLevel}\``
    + `${shape.reasons.length ? ` (${shape.reasons.join('; ')})` : ''}, for which the care dial asks for `
    + `${(shape.earnedLenses || []).length} lens(es) × ${shape.jurorsPerLens} juror(s)/lens × ${shape.rounds} `
    + `round(s). This run seated ${seated.length} lens(es) (${seated.join(', ') || 'none'}), 1 juror each, in `
    + `1 round. ${shortfall.length
      ? `SHORTFALL: ${shortfall.length} earned lens(es) (${shortfall.join(', ')}) did not sit.`
      : 'No lens shortfall: every lens the touch-set earned sat.'} `
    + `${declared} The shortfall is structural — the step list is fixed at registration (#3319) — so it is `
    + 'RECORDED here rather than implied away: do not read the seats above as the whole review this PR earned.';
}

/**
 * The parenthetical after the net basis: which ref that pinned SHA came from, or a warning that nothing was
 * pinned. PURE.
 *
 * WHY IT EXISTS. The first live run recorded `netBasis.rev` as `origin/lane/3058-seed-encoding` — a MUTABLE
 * ref. The `reviewed-sha` marker compensates for the merge gate, but the "Net basis" line is the durable
 * statement of what the juror was shown, and a branch name does not state it: the branch moves, and the line
 * then describes a diff nobody can reproduce. The reader now gets the commit, plus the ref it resolved from.
 */
function renderRevProvenance(netBasis) {
  if (netBasis?.rev) return netBasis.revRef ? ` (rev \`${netBasis.revRef}\` at review time)` : '';
  return netBasis?.revRef
    ? ` (⚠️ UNPINNED — \`${netBasis.revRef}\` is a mutable ref that could not be resolved to a commit)`
    : '';
}

/** The stated outcome of a note posted while mandatory referrals are unruled: neither `accept` nor `changes`. */
const ADVISORY_PENDING_REFERRAL_OUTCOME = 'pending-referral';

/**
 * THE ADVISORY'S OWN OUTCOME — `accept` or `changes` — with the human gate FACTORED OUT. PURE.
 *
 * `verdict.verdict` cannot be used: `derivePanelVerdict` returns `needs-human` for EVERY gate-self PR before it
 * looks at a single finding, so it is identical for a clean advisory and a blocked one. This re-runs the SAME
 * reducer over the SAME admitted findings and lens verdicts with `humanRequired` off, i.e. "what would the panel
 * have said if this PR were not human-gated" — the honest answer to "did the advisory find anything blocking".
 * `accept` only when every mandatory lens accepts and no guard is owed; anything else is `changes`.
 *
 * `null` when no outcome can be honestly derived (no mandatory lens seated, a mandatory lens with no verdict) —
 * the caller then posts the note with no outcome line and applies no label, exactly like before this existed.
 *
 * @param {object} verdict the `reduce` step's output.
 * @returns {'accept'|'changes'|null}
 */
export function deriveAdvisoryOutcome(verdict) {
  const v = verdict && typeof verdict === 'object' ? verdict : {};
  if (v.blockedReferrals?.length) return ADVISORY_OUTCOMES.CHANGES;
  // Unruled mandatory referrals mean the panel is not done: no outcome (so no `advisory:*` label) rather than a
  // clean `accept`. Not `changes` either: nothing is broken, a ruling is owed, and `changes` would dispatch a fixer.
  if (v.pendingReferrals?.length) return null;
  const lensVerdicts = v.lensVerdicts && typeof v.lensVerdicts === 'object' ? v.lensVerdicts : {};
  const lenses = Array.isArray(v.lenses) && v.lenses.length ? v.lenses : Object.keys(lensVerdicts);
  try {
    const reduced = derivePanelVerdict({
      lensVerdicts,
      humanRequired: false,
      mandatoryLenses: MANDATORY_LENSES.filter((l) => lenses.includes(l)),
      // The ADMITTED set, exactly as `reduce` reduced it — an off-scope (unverifiable) citation must not block
      // here any more than it did there (#x6t2z6h). Falls back to the published list for a record that predates it.
      findings: v.admittedFindings ?? v.findings ?? [],
    });
    return reduced === VERDICTS.ACCEPT ? ADVISORY_OUTCOMES.ACCEPT : ADVISORY_OUTCOMES.CHANGES;
  } catch {
    return null;
  }
}

/**
 * THE OUTCOME THE NOTE STATES AND THE LABEL APPLIES — {@link deriveAdvisoryOutcome}, but only when the panel judged
 * a PINNED commit. An unpinned or degraded basis (`netBasis.rev` null) names no head, so there is no head for a
 * label to describe and no `Net basis: <base>..<head>` line a reader could compare against — the note then carries
 * no outcome line and no label is applied, rather than a label nothing can ever verify. PURE.
 * @returns {'accept'|'changes'|null}
 */
export function advisoryLabelOutcome({ read, verdict } = {}) {
  if (!read || read.degraded || !read.netBasis?.rev) return null;
  return deriveAdvisoryOutcome(verdict);
}

/**
 * THE PRE-HUMAN-CEREMONY ADVISORY NOTE (#xlw02hw) — the `advise` step's comment body. PURE.
 *
 * DELIBERATELY SHARES NO SHAPE WITH `renderVerdictWriteUp`'s output beyond the findings table itself
 * (`renderPanelComment`, which both reuse rather than re-render). Everything ABOVE and BELOW that shared table
 * differs on purpose, because a reader — a human about to clear this PR, or a script grepping past comments for
 * the real ceremony's shape — must never mistake this for a recorded verdict:
 *   - no `**Decision:** \`x\` — recorded by …` line. That exact string is `renderVerdictWriteUp`'s fingerprint —
 *     the shape `we:skills-src/review/SKILL.md`'s own live comment sweep matches — and this function never emits
 *     it;
 *   - no `addLabel`/`removeLabels` payload anywhere near it, because this step never calls `decideSetLabel` and
 *     declares no `review:*` label-swap effect, ever (its `advisory:*` label is a separate, later effect —
 *     {@link deriveAdvisoryOutcome});
 *   - an explicit "NOT a recorded verdict" statement at BOTH the top and the bottom, so it reads that way
 *     whichever end a human sees first.
 *
 * @param {{read: object, verdict: object}} o
 * @returns {string} the comment body.
 */
export function renderAdvisoryNote({ read, verdict } = {}) {
  const v = verdict && typeof verdict === 'object' ? verdict : {};
  const outcome = advisoryLabelOutcome({ read, verdict });
  const lensVerdicts = v.lensVerdicts && typeof v.lensVerdicts === 'object' ? v.lensVerdicts : {};
  const lensProviders = v.lensProviders && typeof v.lensProviders === 'object' ? v.lensProviders : {};
  const lenses = Array.isArray(v.lenses) && v.lenses.length ? v.lenses : Object.keys(lensVerdicts);
  const reasonLine = explainPanelOutcome({
    outcome, lensVerdicts, findings: v.admittedFindings ?? v.findings ?? [],
    mandatoryLenses: MANDATORY_LENSES.filter(l => lenses.includes(l)),
    blockedReferrals: v.blockedReferrals, pendingReferrals: v.pendingReferrals,
    deferredCount: v.deferredAdvisory?.length ?? 0, scopeFellBack: v.advisoryScope?.fellBack ?? null,
  });
  const body = renderPanelComment({
    findings: v.findings,
    verdict: v.verdict,
    disposition: read.disposition,
    lensVerdicts,
    lensProviders,
    lenses,
    mandatoryLenses: MANDATORY_LENSES.filter((l) => lenses.includes(l)),
    heading: `⚠️ Advisory review (informational only) — ${read.repo}#${read.pr}`,
  });
  const basis = read.degraded
    ? `⚠️ DEGRADED BASIS (\`${read.degradedReason}\`) — the net diff vs current main could not be resolved, so `
      + 'the file list above may be inflated by sibling-lane content this PR does not touch (#2450).'
    : `Net basis: \`${read.netBasis.base ?? '?'}..${read.netBasis.rev ?? '?'}\`${renderRevProvenance(read.netBasis)} — `
      + `${read.netChangedFiles.length} net changed file(s) vs current main (#2450), not \`gh pr diff\`'s three-dot list.`;
  return [
    `${ADVISORY_NOTE_MARKER} ${reasonLine}`,
    'This PR carries `review:human`. The independent',
    'AI review below ran automatically, before the required human review ceremony — it has neither accepted nor',
    'bounced this PR. No `review:*` label was changed and no decision was recorded.',
    '',
    body,
    ...renderDeferredAdvisorySection({ read, verdict: v }),
    // THE MACHINE-READABLE OUTCOME, the line `we:scripts/lib/advisory-labels.mjs#parseAdvisories` reads back.
    // The `**Verdict:**` line above cannot carry it: on a `review:human` PR it is always "human review required".
    ...(outcome
      ? ['', `**Advisory outcome:** \`${outcome}\` — ${outcome === ADVISORY_OUTCOMES.ACCEPT
        ? 'no blocking findings on this head; `advisory:accepted` is applied'
        : 'blocking findings on this head; `advisory:changes` is applied'}.`]
      // No outcome line parses back as `accept` (`parseAdvisories`), so unruled referrals state a non-accept word.
      : v.pendingReferrals?.length
        ? ['', `**Advisory outcome:** \`${ADVISORY_PENDING_REFERRAL_OUTCOME}\` — mandatory referrals still need a ruling; no \`advisory:*\` label is applied`]
        : []),
    '',
    '---',
    '',
    basis,
    '',
    '**This PR still needs the human ceremony.** Clearing `review:human` requires the operator to run '
      + `\`/review ${read.pr}\` or \`we:scripts/review-set-label.mjs --to=clear-human --actor=… `
      + '--reason="<the operator instruction>"` — nothing above this line performs, substitutes for, or '
      + 'shortcuts that ceremony.',
    '',
    `_Posted automatically by the declared \`${REVIEW_PR_OP}\` operation's \`advise\` step (#xlw02hw) as soon as `
      + 'this PR reached `reduce` — this is advisory only, never a `record`._',
  ].join('\n');
}

/**
 * BUILD THE DECLARATION. `readPr` is the injected reader (see the header); {@link ./review-pr-io.mjs} supplies
 * the real one and tests supply a stub. Built per call so nothing leaks between registries.
 *
 * @param {{readPr: (o: {pr: number, repo: string}) => object, codexAdvisory?: boolean, correctnessAdvisory?: boolean, antigravityReview?: boolean}} deps
 * @param {boolean} [deps.codexAdvisory] - #xqa9ttq — OPT-IN THIRD SEAT. `false` by default: the declaration is
 *   BYTE-IDENTICAL to before this card when omitted, which is deliberate (see the rationale below the roster
 *   check at the bottom of this function, and the file header's "THE THIRD SEAT" section). `true` appends
 *   {@link ADVISORY_JUDGE_SEAT} — a tool-free Codex juror on `ADVISORY_JUDGE_LENS` — as a THIRD `judge` step.
 *   The real binding (`we:scripts/operations/run.mjs`) reads this off `REVIEW_PR_CODEX_ADVISORY=1` in the
 *   environment (mirroring `JUDGE_PROVIDER`'s existing env-fallback shape, since a CLI `--flag` cannot reach
 *   here — the step list is fixed at REGISTRATION, before any run's argv is parsed).
 * @param {boolean} [deps.correctnessAdvisory] - #x8n4crp — OPT-IN FOURTH SEAT, INDEPENDENT of `codexAdvisory`.
 *   `false` by default, for the identical reason. `true` appends {@link CORRECTNESS_ADVISORY_SEAT} — a
 *   read-only-shell Codex juror judging under a correctness-flavoured mandate on {@link CORRECTNESS_ADVISORY_LENS}
 *   (never the literal `'correctness'` — see that constant's own docblock for why) — as a further `judge` step,
 *   after `judgeAdvisory` when both are seated. The real binding reads this off
 *   `REVIEW_PR_CODEX_CORRECTNESS_ADVISORY=1` (`correctnessAdvisoryFromEnv`), a SEPARATE env var from the third
 *   seat's own, so the two Codex seats are toggled independently.
 * @param {boolean} [deps.antigravityReview] - #3383 — OPT-IN FIFTH SEAT, INDEPENDENT of both Codex seats above.
 *   `false` by default, for the identical reason. `true` appends {@link ANTIGRAVITY_REVIEW_SEAT} — a genuinely
 *   tool-free Antigravity (`agy`) juror judging under a correctness-flavoured mandate on
 *   {@link ANTIGRAVITY_REVIEW_LENS} (never the literal `'correctness'` — see that constant's own docblock for
 *   why) — as a further `judge` step, after `judgeCorrectnessAdvisory` when all three are seated. The real
 *   binding reads this off `REVIEW_PR_ANTIGRAVITY_REVIEW=1` (`antigravityReviewFromEnv`), a SEPARATE env var
 *   from both Codex seats' own, so all three optional seats are toggled independently.
 * @returns {object} the frozen declaration from `op()`.
 */
export function reviewPrOperation({
  readPr, codexAdvisory = false, correctnessAdvisory = false, antigravityReview = false,
} = {}) {
  if (typeof readPr !== 'function') {
    throw new TypeError(
      'review-pr: needs a `readPr({pr, repo})` reader — the io is INJECTED so the declaration stays testable '
      + 'without `gh`; the real binding is `we:scripts/operations/review-pr-io.mjs`.',
    );
  }
  // REFUSED AT REGISTRATION, NEVER AT RUN TIME (#3319) — the registry's own posture. `SECURITY_LENS` is read
  // off `MANDATORY_LENSES` rather than typed, which is right, and the failure mode of that is a set with fewer
  // than two members: `SECURITY_LENS` would be `undefined`, `buildPanelMandate` would throw INSIDE a live
  // `judge` step, and the operator would meet the ratified-set change as a mid-review crash on a real PR. If
  // #3314 ever narrows the pair, this fails here — before any run record exists — and names the reason.
  if (!SECURITY_LENS || !PANEL_LENSES.includes(SECURITY_LENS)) {
    throw new Error(
      `review-pr: the second juror's lens comes from \`MANDATORY_LENSES[1]\` and resolved to ${JSON.stringify(SECURITY_LENS)}, `
      + `which is not one of ${PANEL_LENSES.join(', ')}. The ratified mandatory pair (#2310) no longer seats a second `
      + 'lens; #3319 declared this step on it, so re-decide that seat (#3314) rather than judging on nothing.',
    );
  }
  // #xqa9ttq — SAME POSTURE, FOR THE THIRD SEAT, ONLY WHEN OPTED IN. `ADVISORY_JUDGE_LENS` is read off
  // `ADVISORY_LENSES[0]` rather than typed; if that set is ever narrowed to empty this fails here, before any
  // run record exists, rather than mid-review.
  if (codexAdvisory && (!ADVISORY_JUDGE_LENS || !PANEL_LENSES.includes(ADVISORY_JUDGE_LENS))) {
    throw new Error(
      `review-pr: the third juror's lens comes from \`ADVISORY_LENSES[0]\` and resolved to ${JSON.stringify(ADVISORY_JUDGE_LENS)}, `
      + `which is not one of ${PANEL_LENSES.join(', ')}. Re-decide that seat rather than judging on nothing.`,
    );
  }
  // #x8n4crp — THE CORE SAFETY PROPERTY THIS FOURTH SEAT EXISTS FOR, ENFORCED AT REGISTRATION: its bookkeeping
  // lens must NEVER collide with a `MANDATORY_LENSES` entry. Re-lensing the THIRD seat's own lens directly to
  // the literal `'correctness'` would have made a `changes` finding from it flip the whole panel — this seat's
  // very reason to exist is to get a correctness-flavoured Codex opinion WITHOUT that collision, so a future
  // edit that ever set `CORRECTNESS_ADVISORY_LENS` to a mandatory string must fail here, loudly, before any run
  // record exists — never surface as a silently-blocking advisory seat on a live PR.
  if (correctnessAdvisory && MANDATORY_LENSES.includes(CORRECTNESS_ADVISORY_LENS)) {
    throw new Error(
      `review-pr: \`CORRECTNESS_ADVISORY_LENS\` resolved to ${JSON.stringify(CORRECTNESS_ADVISORY_LENS)}, which IS `
      + `a member of \`MANDATORY_LENSES\` ([${MANDATORY_LENSES.join(', ')}]). That is exactly the collision this `
      + 'seat exists to avoid: a `changes` verdict from an advisory seat lensed as a mandatory string would flip '
      + 'the whole panel to `changes`, silently promoting an advisory opinion to a blocking one. Give '
      + '`CORRECTNESS_ADVISORY_LENS` a string disjoint from `MANDATORY_LENSES` and re-register.',
    );
  }
  // #3383 — THE SAME SAFETY PROPERTY, FOR THE FIFTH SEAT: its bookkeeping lens must never collide with a
  // `MANDATORY_LENSES` entry either. See `ANTIGRAVITY_REVIEW_LENS`'s own docblock for why this seat's lens is
  // disjoint from `MANDATORY_LENSES`/`ADVISORY_LENSES`/`PANEL_LENSES` by construction, not by convention.
  if (antigravityReview && MANDATORY_LENSES.includes(ANTIGRAVITY_REVIEW_LENS)) {
    throw new Error(
      `review-pr: \`ANTIGRAVITY_REVIEW_LENS\` resolved to ${JSON.stringify(ANTIGRAVITY_REVIEW_LENS)}, which IS `
      + `a member of \`MANDATORY_LENSES\` ([${MANDATORY_LENSES.join(', ')}]). That is exactly the collision this `
      + 'seat exists to avoid: a `changes` verdict from an advisory seat lensed as a mandatory string would flip '
      + 'the whole panel to `changes`, silently promoting an advisory opinion to a blocking one. Give '
      + '`ANTIGRAVITY_REVIEW_LENS` a string disjoint from `MANDATORY_LENSES` and re-register.',
    );
  }
  // #xqa9ttq / #x8n4crp / #3383 — THE ACTUAL ROSTER FOR THIS BUILD. A LOCAL copy, never a mutation of the
  // exported `JUDGE_SEATS`: every seat-shape check below (the floor refusal in `read`, the roster-consistency
  // check at the bottom of this function) reads THIS, so an opted-in build validates against the roster it
  // actually declares, and a build with ALL THREE flags off reads exactly the same `JUDGE_SEATS` reference it
  // always has. The three opt-in seats are INDEPENDENT — any subset may be appended — and always in this fixed
  // order (third, then fourth, then fifth) so the declared `judge` steps below stay in the same order as this
  // array.
  let seats = JUDGE_SEATS;
  if (codexAdvisory) seats = [...seats, ADVISORY_JUDGE_SEAT];
  if (correctnessAdvisory) seats = [...seats, CORRECTNESS_ADVISORY_SEAT];
  if (antigravityReview) seats = [...seats, ANTIGRAVITY_REVIEW_SEAT];
  seats = Object.freeze(seats);

  const declaration = op(REVIEW_PR_OP, {
    input: {
      pr: 'number',
      repo: 'string',
      // WHICH LENS THE FIRST SEAT JUDGES — not "which single lens judges" any more (#3319). The `judgeSecurity`
      // seat is a declared literal and this field cannot reach it, so `security` runs whatever a caller passes
      // here. The value set is DECLARED (`enum`), so `validateInput` refuses an unknown lens before a run
      // record exists and the derived `--help` lists all five by name instead of `<string>`.
      // (This comment said "the four" until #3035 added `claim-accuracy`; the enum is `[...PANEL_LENSES]`, so
      // the count follows the set and the sentence has to follow the count.)
      // `buildPanelMandate` still refuses anything outside `PANEL_LENSES` in each `judge` step — belt and
      // braces, and it is the one that binds a caller who builds a run record by hand.
      // PASSING `--lens=security` IS LEGAL AND SEATS TWO SECURITY JURORS. That is the `jurorsPerLens: 2` shape
      // `panelRigorForCareLevel('high')` produces and it is not refused here, but it is not free either: the
      // run bills two jurors for one lens and `derivePanelVerdict` is then owed `correctness` by nobody, so
      // `reduce` scopes its mandatory set to the lenses actually seated. See that step for why that is the
      // honest reduction rather than a crash.
      // IT SUBSTITUTES, IT DOES NOT ADD (#3344). `--lens=claim-accuracy` does not mean "also check claim
      // accuracy" — it means "the FIRST seat judges under claim accuracy instead of correctness", and two
      // sessions on 2026-08-26 read it the other way, from opposite directions (one narrowed believing it
      // added a check, one omitted the flag believing it widened to a panel). `read` refuses a selection that
      // leaves NO mandatory lens seated across all judge steps — see `assertMandatoryLensSeated`, and see
      // `decideLensFloor` for why that condition, and for why it is dormant while `judgeSecurity` is pinned.
      // THIS IS STILL NOT A PANEL. `judgePanel` (`we:scripts/lib/judge-panel.mjs`, #3050) is BUILT and remains
      // UNWIRED here, because its per-seat call omits `allowedTools` and every seat would go tool-free (#3158,
      // OPEN). Two declared `judge` steps buy the second lens without paying that; see the file header.
      lens: { type: 'string', required: false, default: DEFAULT_LENS, enum: [...PANEL_LENSES] },
      // WHAT TO HUNT (#3094) — the caller's hypothesis about where the defect is, surfaced as `--aim=<string>`.
      // THE REASON THIS INPUT EXISTS: over one session driving four PRs to merge, every review that found a real
      // defect was a HAND-ROLLED mandate naming the shape to look for, and none went through this operation —
      // because there was no way to tell it what to hunt. `goal` could not carry it: `goal` is the PR TITLE, i.e.
      // what the diff is TRYING to do, and a juror needs both (context AND instruction), so `aim` is passed
      // ALONGSIDE it, never in its place.
      // IT IS A HYPOTHESIS, NOT A VERDICT. `buildPanelMandate` renders it under a heading saying the caller
      // stated it and nothing has established it, and instructs the juror to report the named defect ABSENT when
      // it is absent — an aim that tells a juror its conclusion buys a reviewer who confirms it either way.
      // Free text with no `enum`, unlike `lens`: naming a search cannot be a closed vocabulary. It reaches the
      // juror only inside the mandate TEXT and inside a #2438 data fence — never a flag position in argv (the
      // `JUDGE_MODEL` note above is the general form of that property).
      aim: { type: 'string', required: false },
      // THE SHAPE THE CALLER DERIVED FROM THE TOUCH-SET (#3335). The caller runs
      // `node scripts/review-core-cli.mjs shape` over `gh pr view <pr> --json files --jq '[.files[].path]'`
      // BEFORE it composes this command line, and passes the care level it got back here.
      //
      // WHY THE CALLER AND NOT THIS OPERATION. `read` is step 1 and is what computes `netChangedFiles`, so the
      // touch-set does not exist when the command line is typed; and `--resume` refuses input flags on purpose
      // (`we:scripts/operations/cli-adapter.mjs`), so a shape cannot be revised once the run has started.
      // Whoever types the command has therefore already decided how hard the review looks — the only question
      // is whether they decided it from the file list or from habit. #1580 changed the statute and was reviewed
      // under `correctness` alone; the same file list scores care `high` (five lenses, two jurors, three rounds).
      //
      // WHAT IT ACTUALLY DOES, STATED NARROWLY — it is a DECLARATION that is CHECKED, not a dial:
      //   • it cannot add a seat. The step list is fixed at REGISTRATION (#3319's residual, and the whole
      //     reason this is caller-side), so declaring `high` does not seat five lenses. It records what was
      //     earned so the verdict can state the shortfall.
      //   • an escalated declaration REFUSES an advisory `--lens` (`assertSeatSpentOnMandatoryLens`) — the
      //     #1569 hole, where the one caller-chosen seat went to `claim-accuracy` on a leash change.
      //   • `read` re-derives it over the NET file list and REFUSES an under-declaration
      //     (`assertDeclaredShapeHolds`) — the #1580 hole.
      // OMITTING IT IS STILL LEGAL and behaves exactly as before this item: nothing here can force a caller to
      // declare, because a default would be the operation inventing a band from a touch-set it has not read.
      // What the SKILL does is make deriving it the first step of the documented flow.
      careLevel: { type: 'string', required: false, enum: [...CARE_LEVEL_ORDER] },
      // A CONFIRM-TIME INPUT (`atConfirm`, #3035) — a declared field of this operation, but one that rides the
      // `--resume` that answers the confirm rather than the call that starts the run. Every other field here
      // describes the SUBJECT and is known before a step has run; this one qualifies the operator's DECISION,
      // which does not exist until `judge` has returned and `confirm` has asked. See `atConfirm` in
      // `we:scripts/operations/registry.mjs` for the marker, and `record`'s `reads` below for the half that
      // makes it visible to the step that needs it.
      //
      // RETRACTED, TWICE, because each attempt shipped and each was unreachable:
      //   1. PR #1569 declared it `{ type: 'string', required: false }` — an ORDINARY input. `--resume` refuses
      //      input flags (correctly: the run record already holds them), so the flag could only ride the
      //      opening call, before the override it describes was knowable. The SKILL documented a command that
      //      errored.
      //   2. PR #1572's first attempt removed it from the schema entirely and made `--reason` an adapter
      //      CONTROL flag, merged onto `run.input` at resume. That parsed — and `record` still never saw it,
      //      because `projectReads` builds `view.input` from the leaves a step NAMES in `reads`, and a step may
      //      only name a declared field. The comment that stood here read *"The `reason` field … is NOT an
      //      input … It is a CONFIRM-TIME control flag"*; the second half was the bug and the first half was
      //      the reason the bug could not be fixed without putting the field back.
      //
      // THE REASON THIS INPUT EXISTS. `confirm` records one of a closed answer set and nothing else, so an
      // operator who bounces a PR the juror ACCEPTED had no channel to say why. The write-up is composed from
      // `verdict.findings` — the JUROR's — while `Decision:` comes from `findings.confirm`, so the PR received
      // a comment reading "✅ pass — no blocking findings" directly above "Decision: `changes`", and the author
      // lane was bounced with no stated reason. A bounce the author cannot act on buys another round by
      // construction, which is why this is the cheapest round to delete.
      //
      // HOW OFTEN, COUNTED. Swept 2026-08-26 over PRs #1428–#1567 (140 PRs, 479 issue comments), matching the
      // shape `renderVerdictWriteUp` emits and nothing else — the line `**Decision:** `x` — recorded by`:
      //   - 106 structured verdict comments, across 59 PRs. None below #1456: the operation did not exist
      //     yet, so the swept window is wider than the window that can contain a hit.
      //   - 44 of the 106 recorded `changes`, across 15 PRs;
      //   - 18 of those 44, across 8 PRs (#1556–#1567), recorded `changes` over `### Findings (0)` — ZERO
      //     juror findings, the exact case the guard below refuses;
      //   - 34, across 11 PRs (#1556–#1567), recorded `changes` under the juror's own verdict line
      //     "✅ pass — no blocking findings" — the wider reading, since a `pass` can carry cosmetic findings.
      //
      // RETRACTED — every number in this block has been wrong at least once, so here is what it said and why
      // each was wrong. All three corrections come from re-running the sweep, not from re-reading a card.
      //   - *"Across PRs #1428–#1567 that happened ELEVEN times."* Eleven was the count of PRs in the WIDER
      //     set, not of occurrences; and neither set reaches below #1556, so quoting the whole range implied
      //     128 PRs of history that contain none of them.
      //   - *"(108 of them, across 62 PRs) … 45 recorded `changes` … 17 of those … 33, across 11 PRs."* The
      //     true figures are 106 / 59 / 44 / 18 / 34. The 108 came from a looser match that also swept up 7
      //     HAND-WRITTEN operator comments carrying a `**Decision:**` line with no `— recorded by` — those are
      //     an operator's prose, not this operation's output, and counting them inflated the denominator.
      //   - *"The corpus replay it cited does not support 11 either: it holds 13 such cases"*, and the guard
      //     below pointed a reader at `we:scripts/review-corpus/` for corroboration. THAT PATH DOES NOT EXIST
      //     in this repo — `ls` finds no such directory and nothing under `we:scripts/` imports one — so the
      //     figure was uncheckable and the citation sent the reader nowhere. Both are dropped rather than
      //     re-derived: the live sweep above is the whole basis, and it is reproducible from `gh` alone.
      //
      // It is free text with no `enum` for the same reason `aim` is: stating a reason cannot be a closed
      // vocabulary. `record` REFUSES a reasonless override — see the guard there — so this is not advisory.
      reason: { type: 'string', required: false, atConfirm: true },
      // Who the durable comment is attributed to. Free text, exactly like `review-set-label.mjs --actor`.
      actor: { type: 'string', required: false, default: 'operator' },
    },
    // The reduction IS the run's verdict — declared, not inferred by a caller reading findings.
    verdictFrom: 'referralVerdict',

    // #3316 — THE SKILL THAT OWNS THE REST OF THIS RUN. This operation is the one the defect was measured on:
    // a session invoked it bare, reached `confirm`, did not know how to proceed, and escalated to a human while
    // this file documented both routes forward the whole time. Five steps invoked bare are a findings
    // generator; the review is the skill. The pointer rides every suspend and every refusal from here on, so
    // the skill is reachable FROM the run instead of only by someone who already knew to look for it.
    ownedBy: 'we:skills-src/review/SKILL.md',

    // ── 1. read ─────────────────────────────────────────────────────────────────────────────────────────────
    // The park context (`assembleReviewDetail`) plus the NET-basis diff and file list. See `shapeReadFinding`
    // for the `exec-contract` refusal and for why `ghDiffStat` is named apart from `netChangedFiles`.
    read: compute({
      // `input.lens` is DECLARED here even though the `read` finding does not carry it: the floor refusal
      // below consumes it, and a step that reads an input without declaring it is reading state the run
      // record does not record it as depending on.
      reads: ['input.pr', 'input.repo', 'input.lens', 'input.careLevel'],
      fn: (view) => {
        // #3344 — THE LENS-FLOOR REFUSAL, FIRST IN THE STEP AND THEREFORE FIRST IN THE RUN. Ahead of the
        // injected read, not merely ahead of `judge`: whether the seated lenses include a mandatory one is
        // decidable from the INPUT alone, so there is no reason to spend a `gh` round trip — let alone a
        // juror — establishing it. Same instinct as #3322's self-clear refusal one function down and
        // #xwp8ioh's liveness one beside it: refuse early, and refuse rather than warn, when the caller is
        // a machine. See `decideLensFloor` for why the condition reads across ALL judge seats, and for the
        // honest note that today's step list makes it dormant.
        assertMandatoryLensSeated({ lens: view.input.lens, seats });
        // #3335 — THE SECOND INPUT-ONLY REFUSAL, right behind it and for the same reason it is here rather
        // than at `judge`: whether the ONE caller-chosen seat is being spent on a lens that can block, given
        // a touch-set the CALLER says escalates, is decidable before a single `gh` call. It is a strictly
        // narrower question than the floor above (see `assertSeatSpentOnMandatoryLens`) and does not weaken
        // it: both run, in this order, and #3344's is still the one that can never be satisfied by an input.
        assertSeatSpentOnMandatoryLens({ lens: view.input.lens, careLevel: view.input.careLevel });
        return shapeReadFinding(
          readPr({ pr: view.input.pr, repo: view.input.repo }),
          { pr: view.input.pr, repo: view.input.repo, careLevel: view.input.careLevel },
        );
      },
    }),

    // ── 2. judge ────────────────────────────────────────────────────────────────────────────────────────────
    // DECLARES the juror call in `judgeSpawn`'s option shape (#3028) and spawns NOTHING: the engine suspends
    // and the caller does the spawn between two `advance` calls. The recipe itself is
    // `buildReviewJudgeRequest`, shared with the `judgeSecurity` seat below so the two differ in one field.
    judge: judgeStep({
      reads: ['input.lens', 'input.aim', 'findings.read'],
      request: (view) => buildReviewJudgeRequest({
        read: view.findings.read,
        lens: view.input.lens,
        // #3094 — the caller's aim rides in the MANDATE, beside the goal. `input.aim` is DECLARED in `reads`
        // above: a step that consumes an input without declaring it is reading state the run record does not
        // record it as depending on.
        aim: typeof view.input.aim === 'string' ? view.input.aim : '',
      }),
    }),

    // ── 3. judgeSecurity ────────────────────────────────────────────────────────────────────────────────────
    // THE SECOND SEAT (#3319). Same recipe, same material, `SECURITY_LENS` instead of `input.lens`.
    //
    // IT DOES NOT READ `findings.judge`, AND THAT IS THE POINT. The engine hands a step ONLY its declared
    // reads, so leaving `findings.judge` out of the list below does not merely discourage this juror from
    // seeing the correctness juror's answer — it makes it ABSENT. Two seats that ran sequentially but where
    // the second was shown the first's findings would be one review in two rounds, anchored on the first, and
    // the whole reason to seat a second lens is that it starts somewhere else (#3050's recorded PR #1128
    // result: the corrections came from a different starting point, not from greater skill).
    //
    // ITS LENS IS A LITERAL, NOT `input.lens`. `input.lens` names the FIRST seat and is caller-chosen; if it
    // could also name this one, a caller could seat `security` twice and this operation would bill two jurors
    // for one lens while `derivePanelVerdict` was still owed the other. The security seat is not negotiable
    // from the command line, which is exactly what "run the security lens once per PR" means.
    //
    // `input.aim` RIDES ALONG. The #3094 hypothesis is about WHERE the caller thinks the defect is, not about
    // which lens should hunt it; withholding it from this seat would make the security juror the only reviewer
    // in the run told less than the operator knows. `buildPanelMandate` already renders it as an UNVERIFIED
    // claim and instructs a juror to report the named defect absent when it is absent, so it cannot become
    // this seat's conclusion any more than it can the first's.
    judgeSecurity: judgeStep({
      reads: ['input.aim', 'findings.read'],
      request: (view) => buildReviewJudgeRequest({
        read: view.findings.read,
        lens: SECURITY_LENS,
        aim: typeof view.input.aim === 'string' ? view.input.aim : '',
      }),
    }),

    // ── (opt-in) judgeAdvisory ─────────────────────────────────────────────────────────────────────────────
    // #xqa9ttq — THE THIRD SEAT, DECLARED ONLY WHEN `codexAdvisory` IS TRUE (see `reviewPrOperation`'s param
    // docs). A TOOL-FREE Codex panelist on `ADVISORY_JUDGE_LENS` ('simplicity' today) — see
    // `buildReviewAdvisoryJudgeRequest` for the two fields that make it structurally different from the two
    // seats above (no `allowedTools`, `providerName: 'codex'`).
    //
    // SAME ISOLATION PROPERTY AS `judgeSecurity`: it reads neither `findings.judge` nor `findings.judgeSecurity`,
    // so it starts from the diff alone — a structurally different MODEL on a structurally different starting
    // point, not a third vote anchored on what either Claude juror already said.
    //
    // ADVISORY, NOT MANDATORY, AND THAT IS ENFORCED STRUCTURALLY, NOT BY CONVENTION: `ADVISORY_JUDGE_LENS` is
    // not a member of `MANDATORY_LENSES`, so `reduce`'s `mandatoryLenses: MANDATORY_LENSES.filter(l =>
    // lenses.includes(l))` below can NEVER include it — this seat's per-lens verdict cannot, by construction,
    // flip the panel verdict to `changes` on its own (see the test coverage for this exact property).
    ...(codexAdvisory ? {
      judgeAdvisory: judgeStep({
        reads: ['input.aim', 'findings.read'],
        request: (view) => buildReviewAdvisoryJudgeRequest({
          read: view.findings.read,
          aim: typeof view.input.aim === 'string' ? view.input.aim : '',
        }),
      }),
    } : {}),

    // ── (opt-in) judgeCorrectnessAdvisory ──────────────────────────────────────────────────────────────────
    // #x8n4crp — THE FOURTH SEAT, DECLARED ONLY WHEN `correctnessAdvisory` IS TRUE, INDEPENDENT of the third
    // seat's own `codexAdvisory` flag (a run may seat neither, either, or both). A read-only-shell Codex
    // panelist judging under a CORRECTNESS-flavoured mandate on `CORRECTNESS_ADVISORY_LENS` — see
    // `buildReviewCorrectnessAdvisoryJudgeRequest` for its own recipe (no `allowedTools`, `providerName:
    // 'codex'`, its own `CORRECTNESS_ADVISORY_EFFORT`).
    //
    // SAME ISOLATION PROPERTY AS EVERY OTHER SEAT HERE: it reads none of the sibling jurors' findings, so it
    // starts from the diff alone.
    //
    // ADVISORY, NOT MANDATORY, AND THAT IS ENFORCED STRUCTURALLY, NOT BY CONVENTION — the exact property this
    // seat exists to prove: `CORRECTNESS_ADVISORY_LENS` is not a member of `MANDATORY_LENSES` (refused at
    // registration above if it ever became one), so `reduce`'s `mandatoryLenses: MANDATORY_LENSES.filter(l =>
    // lenses.includes(l))` below can NEVER include it — a blocking finding from this seat cannot flip the panel
    // verdict on its own (see the test coverage for this exact property, mirroring the third seat's own).
    ...(correctnessAdvisory ? {
      judgeCorrectnessAdvisory: judgeStep({
        reads: ['input.aim', 'findings.read'],
        request: (view) => buildReviewCorrectnessAdvisoryJudgeRequest({
          read: view.findings.read,
          aim: typeof view.input.aim === 'string' ? view.input.aim : '',
        }),
      }),
    } : {}),

    // ── (opt-in) judgeAntigravityReview ────────────────────────────────────────────────────────────────────
    // #3383 — THE FIFTH SEAT, DECLARED ONLY WHEN `antigravityReview` IS TRUE, INDEPENDENT of both Codex seats'
    // own flags (a run may seat any subset of the three optional seats). A genuinely tool-free `agy` panelist
    // judging under a CORRECTNESS-flavoured mandate on `ANTIGRAVITY_REVIEW_LENS` — see
    // `buildReviewAntigravityJudgeRequest` for its own recipe (no `allowedTools`, `providerName: 'antigravity'`,
    // its own `ANTIGRAVITY_REVIEW_EFFORT`).
    //
    // SAME ISOLATION PROPERTY AS EVERY OTHER SEAT HERE: it reads none of the sibling jurors' findings, so it
    // starts from the diff alone.
    //
    // ADVISORY, NOT MANDATORY, AND THAT IS ENFORCED STRUCTURALLY, NOT BY CONVENTION — the exact property this
    // seat exists to prove: `ANTIGRAVITY_REVIEW_LENS` is not a member of `MANDATORY_LENSES` (refused at
    // registration above if it ever became one), so `reduce`'s `mandatoryLenses: MANDATORY_LENSES.filter(l =>
    // lenses.includes(l))` below can NEVER include it — a blocking finding from this seat cannot flip the panel
    // verdict on its own (see the test coverage for this exact property, mirroring the fourth seat's own).
    ...(antigravityReview ? {
      judgeAntigravityReview: judgeStep({
        reads: ['input.aim', 'findings.read'],
        request: (view) => buildReviewAntigravityJudgeRequest({
          read: view.findings.read,
          aim: typeof view.input.aim === 'string' ? view.input.aim : '',
        }),
      }),
    } : {}),

    // ── 4. reduce ───────────────────────────────────────────────────────────────────────────────────────────
    // THE PANEL REDUCER DECIDES; this step only feeds it. `derivePanelVerdict` (`we:scripts/lib/jury-core.mjs`)
    // is #2310's ratified reduction and is IMPORTED, never restated — adding a second answer to "what does this
    // set of per-lens verdicts mean" is the drift `AGGREGATION` exists to prevent.
    //
    // WHY THE PANEL REDUCER AND NOT `deriveVerdict` OVER THE MERGED LIST (#3319). They are NOT the same
    // function. `derivePanelVerdict` reads the MANDATORY lenses' verdicts and lets an ADVISORY lens's ordinary
    // findings ride the accept — the "unanimous accept lands" line #2310 ratified. Flattening two lenses into
    // one `deriveVerdict` call would make a `simplicity` seat blocking the moment a caller passed
    // `--lens=simplicity`, silently promoting an advisory lens to a gate. The per-lens `deriveVerdict` calls
    // below are still `deriveVerdict` — one per seat, exactly as a single-seat run has always been — and the
    // panel reducer composes them.
    //
    // `mandatoryLenses` IS SCOPED TO WHAT THIS RUN SEATED, and that is load-bearing rather than defensive:
    // `derivePanelVerdict` THROWS on a mandatory lens with no verdict, and `input.lens` may name an advisory
    // one, in which case `correctness` genuinely did not run and there is no verdict to give it. Scoping to
    // the seated lenses turns that into the honest statement "this run seated `security` as its only mandatory
    // lens" instead of a crash. The reducer's own empty-set refusal still stands behind it — and cannot fire,
    // because the `judgeSecurity` seat is not caller-negotiable, so a mandatory lens is always seated.
    //
    // `humanRequired` comes off the LABELS the `read` step observed, which is what makes a gate-self PR's
    // verdict `needs-human` no matter how clean the findings are. It is passed ONCE, to the panel reducer —
    // not to the per-lens calls, where it would flatten every seat to `needs-human` and destroy the per-lens
    // table the write-up renders.
    reduce: compute({
      reads: [
        'findings.read', 'findings.judge', 'findings.judgeSecurity', 'input.lens',
        // #xqa9ttq — ONLY declared as a read when the seat itself is declared (`codexAdvisory`): a step may
        // only name a leaf that EXISTS at that point in the run (`op()`'s own registration-time check, above),
        // and `findings.judgeAdvisory` does not exist at all in the opted-out (default) declaration.
        ...(codexAdvisory ? ['findings.judgeAdvisory'] : []),
        // #x8n4crp — SAME RULE, for the fourth seat, independent of the third's own flag.
        ...(correctnessAdvisory ? ['findings.judgeCorrectnessAdvisory'] : []),
        // #3383 — SAME RULE, for the fifth seat, independent of both Codex seats' own flags.
        ...(antigravityReview ? ['findings.judgeAntigravityReview'] : []),
      ],
      fn: (view) => {
        const read = view.findings.read;
        const advisoryScope = laterRoundAdvisoryScopeFromEnv(process.env);
        let advisoryScopeFellBack = advisoryScope.fellBack;
        const deferredAdvisory = [];
        // The seats, in declared order. `step` is carried so the refusal below can NAME which juror was
        // silent: with two (or, opted in, three) of them, "the juror returned no summary" is not enough to
        // act on.
        const seats = [
          { step: JUDGE_STEPS[0], lens: view.input.lens, answer: view.findings.judge },
          { step: JUDGE_STEPS[1], lens: SECURITY_LENS, answer: view.findings.judgeSecurity },
          // #xqa9ttq — THE THIRD SEAT, ONLY WHEN SEATED. `ADVISORY_JUDGE_LENS` is a LITERAL here, exactly
          // like `SECURITY_LENS` above, for the same reason: it is not caller-negotiable. `provider: 'codex'`
          // is the SAME literal `buildReviewAdvisoryJudgeRequest` pins on this seat's actual judge request
          // (`providerName: 'codex'`) — carried here too so the posted comment can name this row as Codex
          // instead of rendering it indistinguishable from a Claude seat (the gap this fixes).
          ...(codexAdvisory
            ? [{ step: ADVISORY_JUDGE_SEAT.step, lens: ADVISORY_JUDGE_LENS, answer: view.findings.judgeAdvisory, provider: 'codex' }]
            : []),
          // #x8n4crp — THE FOURTH SEAT, ONLY WHEN SEATED, INDEPENDENT of the third's own flag.
          // `CORRECTNESS_ADVISORY_LENS` is a LITERAL here for the same reason `ADVISORY_JUDGE_LENS` is above: it
          // is not caller-negotiable. `provider: 'codex, advisory'` (not the bare `'codex'` the third seat
          // uses) so `renderPanelVerdictTable`'s `${lens} (${provider})` label reads
          // `codex-correctness (codex, advisory)` — self-documenting as both non-Claude AND non-blocking, so
          // this row can never be mistaken for the mandatory `correctness` seat's own row.
          ...(correctnessAdvisory
            ? [{
              step: CORRECTNESS_ADVISORY_SEAT.step,
              lens: CORRECTNESS_ADVISORY_LENS,
              answer: view.findings.judgeCorrectnessAdvisory,
              provider: 'codex, advisory',
            }]
            : []),
          // #3383 — THE FIFTH SEAT, ONLY WHEN SEATED, INDEPENDENT of both Codex seats' own flags.
          // `ANTIGRAVITY_REVIEW_LENS` is a LITERAL here for the same reason `CORRECTNESS_ADVISORY_LENS` is
          // above: it is not caller-negotiable. `provider: 'antigravity, advisory'` so
          // `renderPanelVerdictTable`'s `${lens} (${provider})` label reads
          // `antigravity-review (antigravity, advisory)` — self-documenting as both non-Claude AND
          // non-blocking, so this row can never be mistaken for a mandatory seat's own row.
          ...(antigravityReview
            ? [{
              step: ANTIGRAVITY_REVIEW_SEAT.step,
              lens: ANTIGRAVITY_REVIEW_LENS,
              answer: view.findings.judgeAntigravityReview,
              provider: 'antigravity, advisory',
            }]
            : []),
        ];

        // #x6t2z6h — THE CITATION SCOPE THIS RUN CAN ENFORCE AGAINST. `read.netChangedFiles` is the SAME ground
        // truth `buildPanelMandate` stated to the juror verbatim, so a finding failing this check contradicts the
        // one fact the juror was handed as settled. Empty on a DEGRADED basis (`ref-unresolved`), and enforcing
        // there would classify every legitimate finding as off-scope at once — so it is not enforced there, and
        // `scopeFindingsToCitedFiles` reports which way it went rather than leaving the caller to infer it.
        const citationScope = read.degraded === true || !Array.isArray(read.netChangedFiles)
          ? []
          : read.netChangedFiles;

        /** @type {Object<string, Array<object>>} raw findings per lens, accumulated so two seats on ONE lens
         *  merge rather than the second silently replacing the first (the `--lens=security` case). */
        const lensFindings = {};
        /** @type {Object<string, Array<object>>} #x6t2z6h — the same per lens, MINUS the findings whose cited file
         *  is not in the net set. This is what the VERDICT reduces; `lensFindings` is what is PUBLISHED. */
        const lensAdmitted = {};
        // #xqa9ttq (PR #2117 review, CONFIRMED) - what the PANEL REDUCER is handed. Excludes the opt-in advisory Codex seat: derivePanelVerdict's prevention scan is NOT scoped to mandatoryLenses, so an advisory-only prevention-shaped finding would flip the verdict off `accept`, contradicting the seat's advisory-only design. The seat is still PUBLISHED via lensAdmitted/lensVerdicts/findings. CONFIRMED broken/unrecoverable findings separately request a mandatory ruling before this filter (#4315).
        const verdictAdmitted = {};
        const referrals = [];
        /** @type {Array<object>} #x6t2z6h — the downgraded ones, kept so `confirm` can name the count. */
        const unverifiableCitations = [];
        let citationScopeEnforced = false;
        const lenses = [];
        const summaries = [];
        const skippedSeats = [];
        for (const seat of seats) {
          const answer = seat.answer && typeof seat.answer === 'object' ? seat.answer : {};
          // #x6t2z6h — REFUSE A WRONGLY-TYPED `findings`, for exactly the reason #x0p5k2q refuses a silent
          // juror. `normalizeFindings` coerces a non-array to `[]`, so a juror that NARRATED its blockers
          // instead of filling the schema — the commonest way a forced-tool-call seat fails — arrived here as
          // zero findings and reduced to `accept`, with its own prose ("I would not merge this") sitting
          // unread in the summary. That is a review whose output was thrown away, which is `unrun`.
          //
          // NARROW ON PURPOSE: `null`/`undefined` is a juror that returned no list, which this pipeline has
          // always read as none and which every existing answer shape relies on. Only a value that IS there and
          // is the wrong TYPE is new information that something went wrong, so only that refuses.
          if (answer.findings != null && !Array.isArray(answer.findings)) {
            throw new Error(
              `review-pr.reduce: the \`${seat.lens}\` juror (\`${seat.step}\` step) returned \`findings\` as `
              + `${typeof answer.findings === 'string' ? 'a string' : `an ${typeof answer.findings}`}, not an `
              + 'array — its structured output did not survive, so whatever it found is not readable here. '
              + 'That is `unrun`, not an accept: coercing it to zero findings would record a clean bill from a '
              + 'juror that may have reported blockers. Re-run the review; do not record a verdict on this run.',
            );
          }
          for (const original of answer.findings ?? []) {
            if (requiresMandatoryReferral(original)) referrals.push({ seat: seat.step, original });
          }
          const scoped = scopeFindingsToCitedFiles(answer.findings, { scope: citationScope });
          const raw = scoped.findings;
          const classified = classifyLaterRoundAdvisory(scoped.admitted, {
            lens: seat.lens, scope: advisoryScope.scope, latestFix: read.latestFix,
          });
          advisoryScopeFellBack ??= classified.fellBack;
          const kept = new Set(classified.kept);
          const deferredOriginals = new Set(scoped.admitted.filter(f => !kept.has(f)));
          const published = raw.filter(f => !deferredOriginals.has(f));
          deferredAdvisory.push(...classified.deferred.map(f => ({
            ...f, category: f.category ? `${seat.lens}/${f.category}` : seat.lens,
          })));
          citationScopeEnforced = citationScopeEnforced || scoped.enforced;
          unverifiableCitations.push(...scoped.unverifiable);
          // #x0p5k2q — REFUSE A SILENT JUROR, here as well as in the shape. `required` in JSON Schema only
          // asserts the KEY is present, so `{findings: [], summary: ""}` satisfies it and arrives as the same
          // nothing. Checked at the reduce step because this is where an empty answer would otherwise become
          // `accept`: `deriveVerdict` reads only the findings array, so silence and a clean bill are the same
          // input to it. Zero findings remains a fine verdict — this asks only that it be an ANSWER.
          // #3319 — CHECKED PER SEAT. One silent juror out of two is still a review that did not happen on
          // that lens, and letting it pass because its sibling spoke would record a two-lens verdict on one
          // lens's evidence.
          const seatSummary = String(answer.summary ?? '').trim();
          if (!seatSummary) {
            throw new Error(
              `review-pr.reduce: the \`${seat.lens}\` juror (\`${seat.step}\` step) returned no summary — it reported `
              + `nothing about what it examined, which is \`unrun\`, not an accept (${raw.length} finding(s) `
              + 'returned). A juror that judged must say what it judged. Re-run the review; do not record a '
              + 'verdict on this run.',
            );
          }
          if (!lenses.includes(seat.lens)) lenses.push(seat.lens);
          lensFindings[seat.lens] = [...(lensFindings[seat.lens] ?? []), ...published];
          lensAdmitted[seat.lens] = [...(lensAdmitted[seat.lens] ?? []), ...classified.kept];
          if (!ADVISORY_SEAT_STEPS.includes(seat.step)) verdictAdmitted[seat.lens] = [...(verdictAdmitted[seat.lens] ?? []), ...classified.kept];
          summaries.push(`${seat.lens}: ${seatSummary}`);
          // #4446 — a gracefully skipped advisory seat is surfaced, never silently an `accept` row.
          if (answer.skipped) skippedSeats.push({ lens: seat.lens, reason: String(answer.skipped.reason ?? seatSummary) });
        }

        // TAGGED WITH THEIR LENS, by `buildPanelFindings` — so a merged list never loses which juror said it.
        // That provenance is what makes the operator-facing comment readable with two seats: without it, a
        // security finding and a correctness finding are indistinguishable rows.
        const findings = buildPanelFindings(lensFindings);
        // #x6t2z6h — THE VERDICT BASIS IS THE ADMITTED SET; THE PUBLISHED LIST IS THE WHOLE ONE. Two lists on
        // purpose, and the asymmetry is the ruling: an off-scope citation loses its automated consequence (it
        // cannot bounce the PR into a round by itself) and keeps its human-readable one (it is still rendered,
        // still ledgered, marked `unverifiable`). Do not "align" these by filtering the published list — that is
        // the DROP outcome the card refuses, and it costs an escaped defect whenever the path was merely stale.
        const admitted = buildPanelFindings(lensAdmitted);
        const lensVerdicts = Object.fromEntries(
          lenses.map((lens) => [lens, deriveVerdict({ findings: lensAdmitted[lens] })]),
        );
        const panelLensVerdicts = Object.fromEntries(
          lenses.filter((lens) => verdictAdmitted[lens] !== undefined).map((lens) => [lens, deriveVerdict({ findings: verdictAdmitted[lens] })]),
        );
        // #xqa9ttq — WHICH LENS RAN ON A NON-CLAUDE PROVIDER, keyed the same way as `lensVerdicts` so the
        // renderer can zip the two together. Built straight off `seats` (never re-derived from the lens name),
        // so a future non-codex provider seat carries its own label for free.
        const lensProviders = Object.fromEntries(
          seats.filter((s) => s.provider).map((s) => [s.lens, s.provider]),
        );
        const humanRequired = read.humanRequired === true;
        const verdict = derivePanelVerdict({
          lensVerdicts: panelLensVerdicts,
          humanRequired,
          // #xu2pp2m — THE BASIS THIS PANEL ACTUALLY JUDGED ON. `read.degraded` is already the fact every
          // rendering surface prints as "⚠️ DEGRADED BASIS"; until now it changed nothing about the VERDICT,
          // so a panel that reviewed material it could not resolve still reduced to a clean, mechanically
          // clearable `accept`. `shapeReadFinding` now refuses outright when the degrade produced NO diff at
          // all; this covers the remaining shape — a degrade that yielded SOMETHING, but not the net basis the
          // mandate told the jurors was ground truth. See `derivePanelVerdict`'s own docblock.
          degradedBasis: read.degraded === true,
          mandatoryLenses: MANDATORY_LENSES.filter((l) => lenses.includes(l)),
          // REQUIRED by the reducer, never defaulted (#2823 round-3 finding 1): the findings-derived prevention
          // scan is what catches an uncaptured guard that per-lens verdict flattening would hide.
          // #x6t2z6h — the ADMITTED set, matching `lensVerdicts` above: a finding whose cited file does not exist
          // in this PR must not withhold the accept through its `prevention` field either, or the downgrade would
          // be undone one gate later.
          // It is the verdict basis WITHOUT the advisory Codex seat.
          findings: buildPanelFindings(verdictAdmitted),
        });
        return {
          verdict,
          referrals,
          deferredAdvisory,
          advisoryScope: { scope: advisoryScopeFellBack ? 'all' : advisoryScope.scope, fellBack: advisoryScopeFellBack },
          // WHERE THE LOOP STANDS, distinct from what this round decided. "converged" and "exhausted" both end
          // the loop and mean opposite things, so a caller must never have to infer one from the other. The
          // round comes from the durable ledger, so it needs no new state and survives a dead session.
          loop: deriveLoopOutcome({ verdict, round: read.priorRounds + 1 }),
          humanRequired,
          // THE SEATS THIS RUN ACTUALLY FILLED, and what each of them said. `lenses` is the roster; the render
          // and the ledger both read it rather than re-deriving one from `input.lens` (which now names only the
          // FIRST seat and would under-report the run by half).
          lenses,
          lensVerdicts,
          // A DISPLAY LABEL, kept because `lens` was a string on this object before #3319 and a reader that
          // still expects one gets an honest "both of them" rather than half the truth. Nothing DECIDES on it —
          // every consumer that needs the roster reads `lenses`.
          lens: lenses.join(', '),
          // #xqa9ttq — carried beside `lensVerdicts` so both render call sites (`renderVerdictWriteUp`,
          // `renderAdvisoryNote`) can pass it straight to `renderPanelComment`/`renderPanelVerdictTable`.
          lensProviders,
          findings,
          // #x6t2z6h — WHAT THE VERDICT WAS ACTUALLY REDUCED FROM, declared rather than left to be inferred by
          // subtracting two lists. A reader that wants "why is this an accept when the comment shows a blocker"
          // gets the answer from the record, not from re-deriving it.
          admittedFindings: admitted,
          citationScopeEnforced,
          unverifiableCitations: unverifiableCitations.length,
          summary: summaries.join(' | '),
          skippedSeats,
        };
      },
    }),

    // Publish and read back before any acceptance or awaiting-advisory mutation. The effect
    // owns one bounded evidence review and reuses the PR record on restart/another checkout.
    mandatoryReferrals: effectStep({
      reads: ['findings.reduce', 'findings.read'],
      effects: (view) => view.findings.reduce.referrals.length || view.findings.read.hasReferralRecord
        ? [{ type: REVIEW_EFFECTS.MANDATORY_REFERRALS, idempotent: true,
          payload: { read: view.findings.read, referrals: view.findings.reduce.referrals } }] : [],
    }),
    referralVerdict: compute({
      reads: ['findings.reduce', 'findings.mandatoryReferrals'],
      fn: (view) => {
        const basis = view.findings.reduce;
        const state = view.findings.mandatoryReferrals.effects[0]?.result;
        if (!state) return basis;
        const pendingReferrals = state.pending ?? ['unreadable-referral-result'];
        // #76a — one entry per gate key, each `{ key, findingId, finding }`, so the note names every block. A state
        // without `blockedFindings` (an older result) still yields the finding its key encodes.
        const blockedReferrals = (state.blocked ?? []).map((key) => state.blockedFindings?.find((b) => b?.key === key)
          ?? { key, findingId: null, finding: referralKeyFinding(key) });
        // A block-ruled referral is mandatory work for the fixer: never a "card suggestion". Move any deferred
        // finding that IS a blocked finding out of the deferred list and into the admitted/published findings. "Is"
        // means the one finding identity (#76a `bindFindingIds`: same path, and the same normalized claim or the same
        // quoted anchor), never a sixth matcher. Lens is ignored HERE: within one run path plus claim already name one
        // finding, and the two sides' lenses differ by construction (a referral carries the juror's raw category, or
        // none, or none for a legacy blocked key; its deferred copy carries the seat lens). Promotion only TIGHTENS,
        // so a binding can never clear.
        const blockedTable = blockedReferrals.map((b, i) => findingIdentityEntry(b.finding, b.findingId ?? `key:${i}`)).filter(Boolean);
        const boundIds = blockedTable.length
          ? bindFindingIds(basis.deferredAdvisory ?? [], blockedTable, { sameHead: true, ignoreLens: true }) : [];
        const promoted = (basis.deferredAdvisory ?? []).filter((_f, i) => boundIds[i] != null);
        const deferredAdvisory = promoted.length ? basis.deferredAdvisory.filter((f) => !promoted.includes(f)) : basis.deferredAdvisory;
        const lifted = promoted.map(({ deferred: _d, ...f }) => f);
        const liftedFields = lifted.length ? {
          findings: [...(basis.findings ?? []), ...lifted],
          admittedFindings: [...(basis.admittedFindings ?? []), ...lifted],
        } : {};
        return { ...basis, ...liftedFields, deferredAdvisory, pendingReferrals, blockedReferrals,
          verdict: pendingReferrals.length ? 'needs-human'
            : blockedReferrals.length && basis.verdict !== 'needs-human' ? 'changes' : basis.verdict,
          humanRequired: basis.humanRequired || pendingReferrals.length > 0 };
      },
    }),

    // ── 5. advise ───────────────────────────────────────────────────────────────────────────────────────────
    // #xlw02hw — THE AUTOMATIC PRE-HUMAN-CEREMONY NOTE. An `effect` step, NOT a `confirm` — it runs the moment
    // `reduce` has a verdict, unconditionally, with no operator and no `--resume` of any kind required (see the
    // file header for why `confirm`'s suspend is exactly the thing a session with no legitimate answer never
    // gets past). On a PR that is NOT `humanRequired` this declares `[]`, which `advance` resolves INLINE with
    // no suspend at all (`step-kinds.mjs`'s effect case) — so the `review:pending` path is byte-identical to
    // before this step existed: nothing happens here, exactly as nothing happened here before.
    // Live #202 loop: pending referrals still need a visible advisory and label when the panel parks.
    // Only an explicit WE_REVIEW_ADVISE_ON_PENDING_REFERRALS=0 restores the old silent skip.
    advise: effectStep({
      reads: ['input.pr', 'input.repo', 'findings.read', 'verdict'],
      effects: (view) => {
        const read = view.findings.read;
        if (read.humanRequired !== true) return [];
        if (view.verdict.pendingReferrals?.length && process.env.WE_REVIEW_ADVISE_ON_PENDING_REFERRALS === '0') return [];
        const effects = [{
          type: REVIEW_EFFECTS.ADVISORY_NOTE,
          payload: {
            pr: view.input.pr,
            repo: view.input.repo,
            body: renderAdvisoryNote({ read, verdict: view.verdict }),
          },
          // IDEMPOTENT: FALSE. It posts a real, durable `gh pr comment` — replaying it on an unknown outcome
          // would risk a second one, exactly the reason `record`'s own LABEL effect is `false` (see there).
          idempotent: false,
        }];
        // mechanical-dispatcher — THE MECHANICAL FLIP OF `review:awaiting-advisory`, ATOMIC WITH THE COMMENT
        // ABOVE, NEVER A SEPARATE POLL/CRON. Declared as a SECOND effect, so the executor (which applies effects
        // strictly ascending and HALTS at the first that does not land) can only ever reach this one AFTER the
        // advisory note has genuinely posted. If the note fails or errors, this effect never runs and the PR
        // stays labeled `review:awaiting-advisory` — it cannot be gamed into reading "advised" with no comment
        // behind it. Declared ONLY when the PR still actually carries the label (mirrors
        // `we:scripts/review-set-label.mjs#presentRemoveLabels`), so a PR opened before this label existed, or
        // one some other path already cleared, gets no spurious remove-label call.
        if (hasReviewLabel(read.labels, REVIEW_LABELS.awaitingAdvisory)) {
          effects.push({
            type: REVIEW_EFFECTS.AWAITING_ADVISORY_CLEAR,
            payload: { pr: view.input.pr, repo: view.input.repo },
            // IDEMPOTENT: TRUE — a plain label removal carries none of the durable-comment ambiguity
            // `ADVISORY_NOTE`/`record`'s LABEL effect carry. Either it lands, or the sink finds the label
            // already gone (a prior attempt landed after all) and no-ops — both reach the SAME end state
            // (the label absent), so replaying it on an unknown outcome is safe.
            idempotent: true,
          });
        }
        // THE `advisory:*` LABEL, AFTER THE NOTE — so a label can never exist without the comment that backs it
        // (`operator-queue.mjs` reads the comment as the source of truth and reports a label with no matching
        // comment as a disagreement). `reviewedHead` is the commit the panel judged; the sink applies the label
        // only if that is STILL the PR's head, so the label never describes a head that has since moved.
        const outcome = advisoryLabelOutcome({ read, verdict: view.verdict });
        if (outcome) {
          effects.push({
            type: REVIEW_EFFECTS.ADVISORY_LABEL,
            payload: {
              pr: view.input.pr,
              repo: view.input.repo,
              outcome,
              reviewedHead: read.netBasis.rev,
            },
            // NOT idempotent: it reads live labels then writes, and an unknown outcome is safest left for a
            // person rather than replayed against labels another actor may have changed meanwhile.
            idempotent: false,
          });
        }
        return effects;
      },
    }),

    // ── 6. confirm ──────────────────────────────────────────────────────────────────────────────────────────
    // THE STOP POINT, AS MACHINERY. The engine suspends here and records what is asked and OF WHOM; the run is
    // resumable from any surface. `of` is `human` on a gate-self PR and `agent` otherwise, so the record itself
    // says which tier of actor was owed — the skill no longer has to.
    confirm: confirmStep({
      reads: ['verdict', 'findings.read'],
      asks: (view) => {
        const read = view.findings.read;
        const v = view.verdict || {};
        const n = Array.isArray(v.findings) ? v.findings.length : 0;
        // #3319 — THE QUESTION NAMES EACH JUROR AND WHAT IT SAID. The operator is being asked to record a
        // verdict reduced from more than one seat, and "2 finding(s) → changes" does not say WHICH lens
        // objected. It is the per-lens breakdown or nothing: a two-juror reduction reported as one number is
        // the flattening `lensVerdicts` exists to undo.
        const perLens = Object.entries(v.lensVerdicts ?? {}).map(([l, x]) => `${l}=${x}`).join(', ');
        // #x6t2z6h — A WITHHELD FINDING IS NAMED IN THE QUESTION, never only in the comment body. The operator is
        // being asked to record a verdict that was reduced from FEWER findings than the count above, and a
        // difference the question does not mention is a difference the operator cannot weigh.
        const withheld = Number(v.unverifiableCitations ?? 0);
        const citationNote = withheld > 0
          ? `${withheld} of them cite a file NOT in this PR's net changed-file set and were reported but WITHHELD `
            + `from the reduction (#x6t2z6h) — the verdict is over ${n - withheld}. `
          : '';
        return `${read.repo}#${read.pr} — ${(v.lenses ?? []).length} juror(s) returned ${n} finding(s) `
          + `(${perLens || 'no lens verdicts recorded'}); ${citationNote}`
          + `\`derivePanelVerdict\` reduced them to \`${v.verdict}\``
          + `${v.humanRequired ? ' (gate-self: review:human)' : ''}. `
          + `Record which verdict? (${CONFIRM_OPTIONS.join(' | ')}; \`abstain\` writes nothing)`;
      },
      of: (view) => (view.verdict.humanRequired ? CONFIRM_ACTORS.HUMAN : CONFIRM_ACTORS.AGENT),
      options: [...CONFIRM_OPTIONS],
    }),

    // ── 7. stageVerdict ─────────────────────────────────────────────────────────────────────────────────────
    // #3540 — THE WRITE-UP, ALONE, NO `gh` NEEDED. Declares exactly ONE effect (the local file write) via
    // {@link planRecordDecision} — the SAME pure decision `record` below re-derives, so the two can never stage
    // and later post two different bodies. See the file header's `stageVerdict` section for why this exists as
    // its own step rather than folded into `advise` or left inside `record`.
    stageVerdict: effectStep({
      reads: ['input.pr', 'input.repo', 'input.actor', 'input.reason', 'verdict', 'findings.read', 'findings.confirm'],
      effects: (view) => {
        const plan = planRecordDecision(view);
        if (plan.abstain) return [];
        return [
          // IDEMPOTENT: TRUE — see `planRecordDecision`'s own note on `bodyFile`/`body` determinism.
          { type: REVIEW_EFFECTS.WRITE_UP, payload: { pr: plan.pr, repo: plan.repo, bodyFile: plan.bodyFile, body: plan.body }, idempotent: true },
        ];
      },
    }),

    // ── 8. record ───────────────────────────────────────────────────────────────────────────────────────────
    // DECLARES three effects and applies NONE (#3540 moved the write-up to `stageVerdict`, ahead of this step).
    // See the per-effect idempotency notes below — each is decided on its own, because the executor's refusal
    // to replay an indeterminate attempt is only as strong as the flag.
    //
    // ORDER IS THE SAFETY PROPERTY (the #2964 rule, now declared instead of hand-maintained). Effects apply
    // strictly ascending and the executor HALTS at the first that does not land, so:
    //   0 makes the one REMOTE write (the single home posts the write-up `stageVerdict` already staged AND swaps
    //     the label, itself #2964-ordered),
    //   1 appends the durable ledger row only AFTER the swap actually landed — an orphan row in the merge
    //     authority is NOT inert, so it must never precede the label it vouches for,
    //   2 reports to the operator last, when there is something true to report.
    record: effectStep({
      // `input.reason` IS NAMED HERE OR THE GUARD BELOW CANNOT FIRE (PR #1572 round 5, the blocking finding).
      // `projectReads` builds `view.input` from exactly these leaves — "an undeclared path is absent, so the
      // declaration is the actual boundary" — so a `reason` sitting on the run record under a name this array
      // omits is stripped before `effects` runs, and the guard refuses a correctly-supplied reason as though
      // none had been given. RETRACTED: this array used to end `…, 'findings.confirm'],` with no
      // `input.reason`, which made the entire feature unreachable through the documented CLI.
      reads: ['input.pr', 'input.repo', 'input.actor', 'input.reason', 'verdict', 'findings.read', 'findings.confirm'],
      effects: (view) => {
        // #3540 — RE-DERIVED, NOT CARRIED. `planRecordDecision` is pure and deterministic over this same `view`,
        // so calling it again here (rather than reading `findings.stageVerdict`, which only exposes applied/type/
        // result — see `effectFinding` in `engine.mjs` — never the payload) reproduces the identical `bodyFile`
        // and `body` `stageVerdict` already wrote to disk, with no second source of truth.
        const plan = planRecordDecision(view);
        if (plan.abstain) return [];
        const {
          to, decision, bodyFile, pr, repo, actor, read, verdict,
        } = plan;

        return [
          // 0 — THE LABEL SWAP, via `decideSetLabel` and through the SINGLE HOME (`review-set-label.mjs`), which
          //     posts the write-up `stageVerdict` staged with the `reviewed-sha` / `reviewed-diff` /
          //     `reviewed-contribution` markers and applies the label in the #2964-correct order. Splitting the
          //     comment and the label into two effects with two sinks would re-implement that script and lose
          //     those markers, which is precisely the re-implementation this slice forbids.
          //     IDEMPOTENT: FALSE — and this is THE one that matters. Adding a label twice is the same label,
          //     but the comment is not: a second run posts a SECOND durable comment. So an attempt whose outcome
          //     is unknown must stop the run for a person rather than guess, which is exactly the acceptance
          //     clause "a replayed `record` step produces no duplicate comment": an entry already `applied` is
          //     skipped, and an entry left `pending` is refused.
          {
            type: REVIEW_EFFECTS.LABEL,
            payload: {
              pr,
              repo,
              to,
              actor,
              // #2898 — the single home renders WHAT IT IS GIVEN. Told, not guessed: this operation is the
              // only thing that knows a run came through it, and the comment's own footer already says so.
              channel: REVIEW_PR_CHANNEL,
              bodyFile,
              addLabel: decision.addLabel,
              removeLabels: presentRemoveLabels(decision.removeLabels, read.labels),
              reason: decision.reason,
            },
            idempotent: false,
          },
          // 1 — THE LEDGER ROW (#3007's reserved seam, `verdict-ledger.append`).
          //     #3007 PHASE 1 has now registered a writer behind this type, and the declaration did not have to
          //     move — which is what the reserved seam was for. The sink is a RECONCILER, not a second writer:
          //     effect 0 shells `we:scripts/review-set-label.mjs`, the single home, which appends the row, so
          //     the sink reads it back and only writes when that fail-soft append missed
          //     (`we:scripts/operations/review-pr-io.mjs`).
          //     IDEMPOTENT: STILL FALSE, deliberately. Reconciliation makes a replay harmless in practice, but
          //     the flag asserts a property of the SINK CONTRACT, and the honest answer while #3007 is still
          //     shadow-only (Phase 2 — the drain reading the ledger — is unbuilt) is to keep the executor's
          //     fail-closed refusal: a stalled run asks a person, a duplicate row in a merge authority silently
          //     vouches twice. Flip this when Phase 2 lands and the dedupe is load-bearing rather than incidental.
          {
            type: REVIEW_EFFECTS.LEDGER,
            payload: {
              pr,
              repo,
              to,
              actor,
              verdict: verdict.verdict,
              // #3319 — `lens` stays a STRING because the sink interpolates it into the fallback reason, and
              // `lenses` is added beside it for a reader that wants the roster. The explicit `reason` below
              // means the sink's `${payload.lens} lens` fallback is no longer the sentence anyone reads: with
              // two seats it would have rendered "(correctness, security lens)", singular, about two jurors.
              lens: verdict.lens,
              lenses: verdict.lenses,
              lensVerdicts: verdict.lensVerdicts,
              reason: `recorded by the review-pr operation (${(verdict.lenses ?? []).length} juror(s): `
                + `${Object.entries(verdict.lensVerdicts ?? {}).map(([l, v]) => `${l}=${v}`).join(', ')})`,
              humanRequired: verdict.humanRequired === true,
              findings: verdict.findings,
              netChangedFiles: read.netChangedFiles,
              netBasis: read.netBasis,
              degraded: read.degraded === true,
            },
            idempotent: false,
          },
          // 2 — THE EVENT: the operator-facing notice, rendered by the SAME `renderReviewNotice` the drain uses
          //     for its `escalated` event, so both directions of a PR's review outcome are reported in one
          //     wording (#2433).
          //     IDEMPOTENT: TRUE. It reports; it records nothing and nothing reads it back. The whole cost of a
          //     replay is a line printed twice, which is strictly cheaper than stalling the run to ask.
          {
            type: REVIEW_EFFECTS.NOTICE,
            payload: {
              pr,
              repo,
              notice: renderReviewNotice({
                event: 'cleared', pr, repo, outcome: to, actor, findings: verdict.findings,
              }),
            },
            idempotent: true,
          },
        ];
      },
    }),
  });

  // #3344 — THE ROSTER MUST BE THE STEP LIST. `JUDGE_SEATS` is the only place the seats are enumerated, and
  // `read`'s floor refusal answers "does any seat judge under a mandatory lens?" by reading it. That answer is
  // only as true as the roster, so a `judge` step added, removed or renamed WITHOUT the roster following it
  // must not reach a run: the refusal would then be reasoning about a run shape that no longer exists, which
  // is the exact failure mode #3344 exists to rule out. REFUSED AT REGISTRATION, before any run record, for
  // the same reason the `SECURITY_LENS` check above is.
  const declaredJudgeSteps = declaration.steps.filter((s) => s.step.kind === 'judge').map((s) => s.name);
  // #xqa9ttq / #x8n4crp / #3383 — `seats`, NOT the module-level `JUDGE_SEATS`: this build's actual roster,
  // which is 2 seats when `codexAdvisory`, `correctnessAdvisory` and `antigravityReview` are all false
  // (identical to `JUDGE_SEATS`), 3 when exactly one opt-in flag is true, 4 when exactly two are, and 5 when
  // all three are.
  const roster = seats.map((seat) => seat.step);
  if (declaredJudgeSteps.length !== roster.length || declaredJudgeSteps.some((n, i) => n !== roster[i])) {
    throw new Error(
      `review-pr: \`JUDGE_SEATS\` lists [${roster.join(', ')}] but the declaration's \`judge\` steps are `
      + `[${declaredJudgeSteps.join(', ')}]. The mandatory-lens floor check (#3344) decides whether a run has a `
      + 'blocking lens by reading that roster, so the two must not drift: add the new seat to `JUDGE_SEATS` '
      + 'beside the lens it judges under (`CALLER_CHOSEN_LENS` if it takes `input.lens`).',
    );
  }

  return declaration;
}

/** The lens set a caller may pass. Re-exported so an adapter can list it in `--help` without a second copy. */
export { PANEL_LENSES };

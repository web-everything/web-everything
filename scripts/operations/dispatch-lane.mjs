/**
 * @file scripts/operations/dispatch-lane.mjs
 * @description THE `dispatch-lane` DECLARATION — the effect that STARTS rather than completes (#3037, epic #3029).
 *
 * WHAT THE CARD WAS AFRAID OF, AND WHY IT IS NOT HERE. Every other declared operation's effects are applied and
 * done; this one hands off — it launches a delivery agent that outlives the run by an hour. The card asked
 * whether `compute` / `judge` / `confirm` / `effect` can describe that. The #3030 spike answered that they can
 * (`we:reports/2026-08-11-dispatch-lifecycle-spike.md`), and the two mechanisms it named have since shipped:
 * `dispatch: true` + `inFlight({ handle })` on the executor (#3073) and the observer contract + the waker
 * (#3084). So there is NO fifth step kind here, and this declaration adds no mechanism of its own — it is three
 * ordinary steps over machinery that already existed.
 *
 * IT DECLARES OVER THE TICK CORE; IT DOES NOT RE-DERIVE IT. The conveyor's dispatch policy — the in-flight
 * build guard, the lane exclusion, the scope-lease arbitration, the TTLs, the union re-dispatch gate — is
 * `we:scripts/conveyor/tick-core.mjs#planTick`, which is pure and tested. This operation CONSUMES that core's
 * six launch lists — `decisions.spawnBuilds`, `decisions.spawnPrepareScope`, `decisions.spawnPrepareDecision`
 * (#3165), `decisions.spawnInvestigations` (#3567), and `decisions.spawnFixes`, `decisions.spawnCiHeals`
 * (#3332) — and refuses to invent a launch of its own:
 *
 *   - ONE DISPATCH PER CALL, never a batch. `--num=<N>` resolves THAT item's kind and starts THAT item's
 *     agent. The tick already decides multiplicity; a loop here would be a second scheduler in front of it.
 *   - the KIND is never an input either. It is whichever of the six lists the core put this num in, and
 *     it selects the brief, the session slug and the lane scope together — see `shapeDispatchRead`.
 *
 *   - the LANE is never an input. A caller cannot ask for a lane; it dispatches the lane the core assigned, or
 *     it dispatches nothing. That is what makes "the same holds and the same lease arbitration as the current
 *     tick" a structural property rather than a promise.
 *   - a `num` the core SUPPRESSED (a live guard holds its num or its lane) comes back as a non-dispatch with the
 *     suppression reason, not as a launch.
 *   - the guard entry the core recorded for THIS launch rides the run record (`dispatchedGuard`), beside the
 *     whole tick's bookkeeping under its honest name (`tickNextState` — see `shapeDispatchRead`, which explains
 *     why a caller that runs only this operation must carry the first and not the second).
 *
 * If a reader finds a guard rule, a TTL or a lane assignment in this file, that is the bug.
 *
 * ── IO IS INJECTED, AND THIS FILE REACHES NOTHING ───────────────────────────────────────────────────────────
 *
 * Same split as {@link ./review-pr.mjs} / {@link ./review-pr-io.mjs}: the declaration is the WHAT, and
 * {@link ./dispatch-lane-io.mjs} is the only place it touches the world. Its static import graph is
 * `./registry.mjs` + `./step-kinds.mjs` + the pure session-slug helper — no `node:` specifier at all, so the step fns hold no spawner in
 * lexical scope and the fill below is unit-testable with a two-line stub.
 *
 * That is also why {@link planTickCoreSelection the selection} happens in the io shell rather than here: item
 * identity is normalized by `normNum` (`we:scripts/conveyor/queue-store.mjs`) — the SAME normalizer the state
 * read, the dispatch plan and the tick core key on — and a second copy of it in this file is precisely how two
 * halves of the system come to disagree about which item `#042` is. The shell selects; the declaration shapes,
 * decides and declares.
 *
 * ── THE THREE STEPS ─────────────────────────────────────────────────────────────────────────────────────────
 *
 *   | step       | kind      | what it does                                                                   |
 *   |------------|-----------|--------------------------------------------------------------------------------|
 *   | `read`     | `compute` | shape one tick read (already selected for this `num`) + FILL the delivery brief |
 *   | `plan`     | `compute` | the verdict: dispatching or not, and why not                                    |
 *   | `dispatch` | `effect`  | declares ONE `dispatch: true` effect — or NONE, when the core said no           |
 *
 * NO `confirm`, DELIBERATELY. A human stop in the per-lane dispatch loop is the thing
 * [#conveyor-orchestration-mechanics-not-per-lane-agent](../../docs/agent/platform-decisions.md#conveyor-orchestration-mechanics-not-per-lane-agent)
 * forbids, and the tick has never had one. NO `judge` either: nothing here is a judgement — the core already
 * decided, and re-asking a model would put a model back in the loop the ruling took it out of.
 *
 * PURE. No fs, no clock, no process, no network in this file.
 */

import { mintSessionSlug, PR_KINDS } from '../conveyor/session-slug.mjs';
import { op } from './registry.mjs';
// #3717 — the `taskType` derivation. PURE and import-free, which is why the DECLARATION may hold it.
import { taskTypeFor } from '../lib/dispatch-task-type.mjs';
// #3224 — the raw invocation this operation declares over. Declared in ONE place and read by two
// consumers: `op()` validates its shape here, and the skill-wiring scan reads the same map.
import { DECLARED_HOMES } from './declared-homes.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';

/** The operation's stable id. Adapters resolve it by this name. */
export const DISPATCH_LANE_OP = 'dispatch-lane';

/**
 * The effect type a dispatch declares. ONE type, and both halves of the #3084 contract hang off it: the SINK
 * that starts the agent and the OBSERVER that later asks how it is going are registered under this same string
 * (`we:scripts/operations/dispatch-lane-io.mjs`), exactly as the executor's and the observer's tables expect.
 */
export const DISPATCH_EFFECT = 'conveyor.dispatch-delivery-agent';

/**
 * How long a delivery agent is expected to take, in minutes, before "still running" becomes "go look at it".
 *
 * It becomes the entry's `expectedBy`, which is the ONLY thing that separates `inFlightEntries().running` from
 * `.overdue` — a waker without one can tell finished from not-finished but never RUNNING from STALLED. 90
 * minutes is the conveyor's own observation of a build (claim → gate → converge → PR), and it is an ESTIMATE,
 * never a deadline: nothing kills or re-dispatches an overdue entry (`effect-observer.mjs` is explicit that
 * failing work on a clock alone kills slow-but-healthy builds).
 */
export const DEFAULT_EXPECTED_WITHIN_MINUTES = 90;

/**
 * EVERY PLACEHOLDER NAME this operation knows how to fill, across every kind it dispatches (#3165 named the
 * first five, #3332 three more: `PR_NUM`, `LANE_REF`, `REASON`, and #3110 the last: `ATTEMPT_TAG`).
 *
 * KIND-AGNOSTIC ON PURPOSE. This is the set {@link canonicalPlaceholder} scans against to catch a MISSPELLING
 * of any known name, regardless of which kind is being filled right now — a `{{ pr_num }}` typo in the fix
 * brief has to be caught the same way a `{{ item_num }}` typo in the delivery brief is, by the same function,
 * without a kind argument threaded all the way down into detection. WHICH of these a given fill call actually
 * REQUIRES (and is therefore allowed to substitute) is the separate, PER-KIND set below
 * ({@link BRIEF_REQUIRED_BY_KIND}) — a `build` fill has no `PR_NUM` to give, and a `fix` fill has no
 * `ITEM_SPEC_PATH` to give, so a single flat list would either refuse every build for a token it never needed
 * or silently substitute the literal string `"undefined"` into a fix brief that happens to carry
 * `{{ITEM_SPEC_PATH}}`. See {@link fillBrief}'s `requiredNames` parameter for how the two sets are used
 * together.
 */
export const BRIEF_PLACEHOLDERS = Object.freeze([
  'ITEM_NUM', 'ITEM_SPEC_PATH', 'LANE', 'SESSION_SLUG', 'SCOPE', 'PR_NUM', 'LANE_REF', 'REASON', 'ATTEMPT_TAG',
  // #3637 — WHICH BRANCH this dispatch forks from and lands on. `main` for every ordinary item (so the filled
  // brief is byte-identical to the pre-#3637 literal it replaced); a registered POC branch when the item's
  // `deliveryTarget:` names one. It had to be REGISTERED here, not just typed into the brief: `fillBrief`
  // strictly refuses an unknown placeholder, which is exactly the blocker #3637's survey named (#2 of five).
  'DELIVERY_BASE',
  // #3960 (multi-repo slice 4) — the FIX/CI-HEAL-ONLY quintet that makes a repair brief repo-aware instead of
  // hardcoding WE. `REPO` is the gh slug (`--repo=` for `rearm-review.mjs`/`stand-down.mjs`/`ci-heal-mark.mjs`/
  // `completion-cli.mjs`); `LANE_REPO` is what `lane-pool.mjs --repo=` itself expects (`.` for WE, an absolute
  // checkout path for a sibling repo — `repoProfile(...).lanePoolRepo`, unchanged from slice 1); `GATE_COMMAND`
  // is the target repo's own gate (`gateFor(...)`, reused rather than re-derived); `WE_ROOT` is the absolute WE
  // checkout that owns every one of these tools, so a `node "..."` call resolves regardless of the agent's cwd
  // (a lane clone of a SIBLING repo has no `scripts/` directory at all); `ATTRIBUTION` is the commit-title
  // reference (`<REPO-TAG> #<item>` today; `PR #<pr>` once an item-less fix ships, #3960's gap-map "Proposed
  // design C"). See {@link briefTokensForRepo} (`we:scripts/lib/repo-profile.mjs`) for how the four
  // repo-derived ones are computed together from ONE profile.
  'REPO', 'LANE_REPO', 'GATE_COMMAND', 'WE_ROOT', 'ATTRIBUTION',
  // #4078 — the HEALTH-INVESTIGATE-ONLY pair (see {@link HEALTH_INVESTIGATE_KIND}): which health episode the
  // diagnose-only agent investigates, and which smell opened it. Registered here, not in a private list, so a
  // `{{ episode id }}` typo in ANY brief is caught by the same {@link canonicalPlaceholder} scan as every other name.
  'EPISODE_ID', 'SMELL',
]);

/**
 * {@link fillBrief}'s `optionalNames` argument for {@link BRIEF_PLACEHOLDERS} — names allowed to resolve to
 * `''` without tripping the "no value" refusal (#3110). `ATTEMPT_TAG` is legitimately blank on a fresh build's
 * first attempt — see {@link attemptTagFor}.
 */
export const OPTIONAL_BRIEF_PLACEHOLDERS = Object.freeze(['ATTEMPT_TAG']);

/**
 * WHICH OF {@link BRIEF_PLACEHOLDERS} A GIVEN KIND'S FILL CALL ACTUALLY REQUIRES — and therefore the only
 * names THAT CALL is allowed to substitute (#3332).
 *
 * WHY PER-KIND REQUIREDNESS EXISTS AT ALL, stated once here because {@link fillBrief} leans on it without
 * re-explaining it: a `build`/`prepare`/`prepare-decision` fill call is never handed a `PR_NUM` or a
 * `LANE_REF` — those dispatches target an ITEM, not an existing PR, so the caller has no value to give even if
 * it wanted to. Symmetrically, a `fix`/`ci-heal` fill call is never handed an `ITEM_SPEC_PATH` — a repair
 * dispatch does not carry the item's spec path through `shapeDispatchRead` at all, because the fix briefs
 * never reference it. A single shared required-set (the pre-#3332 shape) would force one of two wrong
 * outcomes: refuse every build for a `PR_NUM` it can never supply, or (see `fillBrief`'s docblock) silently
 * fill a token nobody validated with the JavaScript string `"undefined"` the moment a brief happened to carry
 * it. Splitting the required set by kind is what lets each fill call validate — and therefore substitute —
 * exactly the tokens its own brief actually uses.
 */
export const BRIEF_REQUIRED_BY_KIND = Object.freeze({
  // ATTEMPT_TAG (#3110) is BUILD-ONLY — only `delivery-agent-brief.md` folds it into the retry branch name;
  // neither prepare brief nor either fix/ci-heal brief references it, so neither kind validates or substitutes
  // it (an unlisted name is merely reported as unknown if a brief happens to carry it — see `fillBrief`).
  // DELIVERY_BASE (#3637) is BUILD-ONLY, for the same reason ATTEMPT_TAG is: only `delivery-agent-brief.md`
  // forks a lane and lands a result, so only that brief references the target branch. A `fix`/`ci-heal`
  // dispatch reconstitutes onto an EXISTING PR/ref whose base is already fixed, and neither prepare brief
  // lands anything at all.
  // WE_ROOT (#4174) is required on ALL SIX kinds now — every brief's one pre-lane command
  // (`node "{{WE_ROOT}}/scripts/lane-pool.mjs" acquire …`) needs an absolute path to find it, because the
  // dispatched session's cwd is no longer this checkout (`we:scripts/operations/dispatch-lane-io.mjs
  // #dispatchSessionCwd`) — it is a scratch directory outside it, so a bare relative `scripts/lane-pool.mjs`
  // would resolve nowhere. The four non-repair kinds need ONLY `WE_ROOT` out of the repo-aware quintet; they
  // never reference `{{REPO}}`/`{{LANE_REPO}}`/`{{GATE_COMMAND}}`/`{{ATTRIBUTION}}`, so those are not required
  // here even though `raw.repoTokens` (below) carries them too.
  build: ['ITEM_NUM', 'ITEM_SPEC_PATH', 'LANE', 'SESSION_SLUG', 'SCOPE', 'ATTEMPT_TAG', 'DELIVERY_BASE', 'WE_ROOT'],
  prepare: ['ITEM_NUM', 'ITEM_SPEC_PATH', 'LANE', 'SESSION_SLUG', 'SCOPE', 'WE_ROOT'],
  'prepare-decision': ['ITEM_NUM', 'ITEM_SPEC_PATH', 'LANE', 'SESSION_SLUG', 'SCOPE', 'WE_ROOT'],
  'prepare-item': ['ITEM_NUM', 'ITEM_SPEC_PATH', 'LANE', 'SESSION_SLUG', 'SCOPE', 'WE_ROOT'],
  // `investigate` (#3567) fills the SAME names as the two prepare kinds — it targets an ITEM (not an
  // existing PR), same as `prepare`/`prepare-decision`, so it has no `PR_NUM`/`LANE_REF` to give either.
  investigate: ['ITEM_NUM', 'ITEM_SPEC_PATH', 'LANE', 'SESSION_SLUG', 'SCOPE', 'WE_ROOT'],
  // #3960 — the five repo-aware tokens (see {@link BRIEF_PLACEHOLDERS}) are required on BOTH repair kinds:
  // every fix/ci-heal reconstitutes onto an EXISTING PR's ref, which under multi-repo dispatch (slice 5, not
  // yet turned on) can belong to any constellation repo, so the brief must never hardcode WE for either kind.
  fix: ['ITEM_NUM', 'PR_NUM', 'LANE_REF', 'LANE', 'SESSION_SLUG', 'SCOPE', 'REPO', 'LANE_REPO', 'GATE_COMMAND', 'WE_ROOT', 'ATTRIBUTION'],
  'ci-heal': ['ITEM_NUM', 'PR_NUM', 'LANE_REF', 'LANE', 'SESSION_SLUG', 'SCOPE', 'REASON', 'REPO', 'LANE_REPO', 'GATE_COMMAND', 'WE_ROOT', 'ATTRIBUTION'],
  // #4078 — a health investigation targets an EPISODE, not an item or a PR, and holds no lane: it needs only the
  // episode, its smell, its own session slug and the absolute WE root its declared reads run from.
  'health-investigate': ['EPISODE_ID', 'SMELL', 'SESSION_SLUG', 'WE_ROOT'],
});

/**
 * #4078 — THE HEALTH DAEMON'S DIAGNOSE-ONLY INVESTIGATION, a kind on this operation that the TICK never launches.
 *
 * Ruling #4065 clause 2 says the health agent "is launched as a kind on the declared `dispatch-lane` operation"
 * ([#conveyor-dispatch-calls-the-declared-operation](../../docs/agent/platform-decisions.md#conveyor-dispatch-calls-the-declared-operation)
 * clause 1: widening dispatch to a new kind of work extends the declared operation, it does not fork a spawner).
 * So its brief is filled by {@link fillBrief} against {@link BRIEF_REQUIRED_BY_KIND}'s row for it, its session
 * name comes from {@link sessionSlugFor}, and it is started by this operation's one sink
 * (`dispatch-lane-io.mjs#createDispatchSinks`) — exactly the shape `ci-heal-pr-dispatch.mjs` already uses for a
 * ci-heal the tick did not plan.
 *
 * DELIBERATELY NOT A MEMBER OF {@link LAUNCH_KINDS}. That list is "which of the tick core's launch lists a `--num`
 * came out of", and every member targets a backlog item in a leased lane. A health episode is neither: its caller
 * is the health watch (`we:scripts/conveyor/health-investigate-dispatch.mjs`), which owns its own budget, and the
 * agent acquires no lane. Adding it there would make `shapeDispatchRead` accept a kind with no item, no lane and
 * no tick list behind it.
 */
export const HEALTH_INVESTIGATE_KIND = 'health-investigate';

/**
 * #3168 — WHICH KIND'S BRIEF SELF-ADOPTS (`lane-pool.mjs acquire --adopt`) BEFORE it ever edits, versus which
 * one leaves the freshly-leased lane's `Edit`/`Write` occupancy guard (`guard-lane.mjs` / `isForeignOccupancy`)
 * FAIL-OPEN for its entire run. This is a STATIC fact about each brief file (`we:scripts/operations/
 * dispatch-lane-io.mjs`'s `BRIEF_FILE_BY_KIND`), checked here once rather than re-derived per call, and it is
 * NOT a residual this operation can close by itself — see the #3168 investigation, below.
 *
 * `build` (`delivery-agent-brief.md`) and `investigate` (`investigation-agent-brief.md`) pass `--adopt` in
 * their own step-1 `acquire`, because in both topologies the SAME session that runs `acquire` is the one that
 * then edits — so occupancy can be claimed immediately with no ambiguity.
 *
 * `prepare` / `prepare-decision` / `fix` / `ci-heal` do NOT — not an oversight, but the exact dispatcher→worker
 * split `--adopt`'s own doc comment exists for (`lane-lease.mjs`'s `workerSession` docblock): nothing here runs
 * `acquire` at all — a DISPATCHED AGENT does, later, under a session id THIS operation cannot predict (the
 * agent's own CLI session, minted at spawn). Defaulting those briefs to self-adopt at dispatch time would need
 * this operation to stamp occupancy under ITS OWN session before the agent exists, which is the exact defect
 * `docs/agent/delivery-loop.md`'s review-dispatch flow already documents and works around (#3107 bounce: a
 * driver that adopts on its own id arms the guard against the very agent it is about to spawn, and that
 * agent's own first edit is then refused as foreign). So this table does not "fix" the four unmarked kinds by
 * flipping them to self-adopt — it names the fail-open window loud, on every dispatch it applies to, per the
 * #3168 card's alternative Done-when (`dispatch-lane.mjs` surfaces it, not just `acquire`'s own stdout).
 */
export const KIND_DECLARES_OCCUPANCY_ON_DISPATCH = Object.freeze({
  build: true,
  prepare: false,
  'prepare-decision': false,
  'prepare-item': false,
  investigate: true,
  fix: false,
  'ci-heal': false,
});

// #3168 — a DISPLAY-ONLY copy of the kind→brief-filename mapping the io shell owns (`dispatch-lane-io.mjs`'s
// `BRIEF_FILE_BY_KIND`). Duplicated rather than imported: this module is asserted to reach nothing that can
// act (see the "DECLARATION module reaches nothing" test), so it cannot import the io shell to read the real
// map. Only used to name the brief in the warning string below; if a filename ever drifts the message is
// stale-but-harmless prose, not a wrong VERDICT — `KIND_DECLARES_OCCUPANCY_ON_DISPATCH` above is the one fact
// that actually gates the warning firing at all.
const BRIEF_FILE_BY_LAUNCH_KIND_DISPLAY = Object.freeze({
  build: 'delivery-agent-brief.md',
  prepare: 'prepare-scope-agent-brief.md',
  'prepare-decision': 'prepare-decision-agent-brief.md',
  'prepare-item': 'prepare-item-agent-brief.md',
  investigate: 'investigation-agent-brief.md',
  fix: 'fix-agent-brief.md',
  'ci-heal': 'fix-agent-ci-brief.md',
});

/** #3168 — the human-readable warning `shapeDispatchRead` attaches to a dispatch whose kind is NOT in
 *  {@link KIND_DECLARES_OCCUPANCY_ON_DISPATCH}'s true set, so it rides both the run record (`read` finding +
 *  `plan` verdict) and the dispatch sink's own printed output — never only `acquire`'s stdout. Pure string
 *  build so the exact wording is asserted once, here, rather than duplicated at each of its three call sites. */
export function occupancyFailOpenWarning(launchKind, lane) {
  return (
    `lane-${lane}'s Edit/Write occupancy guard stays FAIL-OPEN for this whole ${launchKind} dispatch (#3168): `
    + `${BRIEF_FILE_BY_LAUNCH_KIND_DISPLAY[launchKind] || `the ${launchKind} brief`} never runs `
    + '`lane-pool.mjs acquire --adopt` (or `adopt --lane=`), so `guard-lane.mjs` has no declared occupant to '
    + `protect and allows Edit/Write from ANY other session into lane-${lane} for the life of this dispatch — `
    + 'this is by design (the dispatcher here cannot claim occupancy on the dispatched agent\'s not-yet-minted '
    + 'session id without reintroducing the #3107 bounce), not a bug this operation can silently close.'
  );
}

/** #3637 — the delivery target this dispatch forks from and lands on, as the brief's `{{DELIVERY_BASE}}`.
 *  `main` unless the item declares a REGISTERED POC branch. PURE, and deliberately trusting: the REGISTRY
 *  LOOKUP (and the refusal for an undeclared branch) happens in the io shell's `findItem`
 *  (`we:scripts/operations/dispatch-lane-io.mjs`), which is the only side allowed to read a file — this
 *  declaration module is asserted to reach NOTHING that can act, `node:` specifiers included. */
const deliveryBaseFor = (item) => {
  const v = typeof item?.deliveryBase === 'string' ? item.deliveryBase.trim() : '';
  return v || 'main';
};

/**
 * THE SIX AGENT KINDS THIS OPERATION CAN START (#3165 named three, #3332 two more, #3567 the sixth), in the order the
 * shell resolves them.
 *
 * `planTick` returns SIX launch lists — `spawnBuilds`, `spawnPrepareScope`, `spawnPrepareDecision`,
 * `spawnInvestigations`, `spawnFixes`, `spawnCiHeals` — and until #3165 the operation launched only the first,
 * until #3332 two more reached a route, and until #3567 `spawnInvestigations` did too; before each of those, a
 * launch of that kind was planned every tick and reached NO route at all: `briefPath` threw for any kind it
 * did not know, so it could not even be attempted, let alone dispatched. This list is the whole connection,
 * for all six.
 *
 * ONE ITEM IS IN AT MOST ONE LIST for the first four — an unscoped held item never reaches `spawnBuilds`, a
 * decision is never an unshaped build, and an investigation is never either — so the order below is a
 * tie-break that no real tick exercises for those, not a precedence rule. `fix` and `ci-heal` are keyed on a PR rather than an item (#3332's own
 * `sessionSlugFor` docblock explains why), so in principle a bounced item mid-build could show up in a fix or
 * CI-heal list for an OLDER PR while a new one is elsewhere — the shell's `LAUNCH_LISTS` order still applies
 * first-match-wins, and is stated as data for the same reason: two files agreeing on the order by coincidence
 * is how they stop agreeing.
 */
export const LAUNCH_KINDS = Object.freeze(['build', 'prepare', 'prepare-decision', 'prepare-item', 'investigate', 'fix', 'ci-heal']);

/**
 * How long an in-flight dispatch record whose agent's LIVENESS CANNOT BE ESTABLISHED keeps holding its item
 * past the deadline it was given. See {@link dispatchStillHolds} — this is the backstop for an entry nothing
 * can be observed about, and it never overrules a listing that says the agent is alive.
 *
 * THE VALUE IS PINNED BY A TEST WRITTEN WITH THE LITERAL (PR #1211 round 2, G5). The boundary tests were
 * written relative to this constant, so `30 → 0` left the whole suite green — a margin asserted only against
 * itself is a margin the next refactor deletes for free. It absorbs clock difference between the process that
 * wrote `expectedBy` and the process that reads `observedAt`; at 0 it is a knife edge.
 */
export const DISPATCH_HOLD_GRACE_MINUTES = 30;

/**
 * How long after a dispatch STARTED its session may still be missing from `claude agents --json` without that
 * absence meaning the agent is gone.
 *
 * `claude --bg` returns before its session is necessarily visible, so a listing taken inside this window
 * cannot tell *not yet listed* from *already finished*. The OBSERVER treats "absent and young" as still
 * `running` — the fail-closed direction for a reader whose wrong answer writes nothing.
 *
 * THIS IS THE OBSERVER'S WINDOW ONLY. It used to be the guard's too; it is not any more. The double-dispatch
 * guard reads {@link DISPATCH_GUARD_LISTING_GRACE_MINUTES} instead, because the two readers pay very different
 * prices for the same wrong answer — see that constant.
 *
 * ONE SOURCE OF TRUTH with the observer's own grace: `we:scripts/operations/dispatch-lane-io.mjs` derives its
 * `LISTING_GRACE_MS` from this constant rather than carrying a second number that could drift from it. That
 * derivation is still correct and still wanted; the guard is the one deliberate EXCEPTION to it, and it states
 * its own reason rather than silently carrying a second copy of this number.
 */
export const DISPATCH_LISTING_GRACE_MINUTES = 2;

/**
 * The same window as {@link DISPATCH_LISTING_GRACE_MINUTES}, for the DOUBLE-DISPATCH GUARD, and deliberately
 * larger.
 *
 * WHY TWO NUMBERS, when the comment above says two numbers that must agree eventually will not: these two must
 * NOT agree. They answer the same question — "how long is a session's absence from the listing still just *not
 * yet listed*?" — for two readers whose cost of being wrong differs by roughly 100x:
 *
 *   - THE OBSERVER is wrong → it reports `unresolved`. Nothing is written, nothing is started, and an operator
 *     looks at an entry that needed looking at anyway.
 *   - THE GUARD is wrong → it releases the item, and the next dispatch starts a SECOND agent in the same lane
 *     clone, racing one working tree, both opening a PR. That is the entire failure this guard exists for.
 *
 * An asymmetric cost gets an asymmetric window. Waiting longer costs the guard only latency on a dispatch that
 * was going to be re-attempted anyway; waiting too little costs a double-dispatch. Ten minutes is still far
 * below any real build and five times the slowest spawn→listed gap the observer needs to cover.
 *
 * IT MUST STAY GREATER THAN THE OBSERVER'S. Equal or smaller and the guard is back to trusting a single bad
 * read as fast as the reader whose wrong answer is free — the exact state this constant exists to end.
 * Asserted, not merely written down: `we:scripts/operations/__tests__/dispatch-lane-defaults.test.mjs`.
 */
export const DISPATCH_GUARD_LISTING_GRACE_MINUTES = 10;

/**
 * DETECTION is wider than SUBSTITUTION, and the gap is the whole point (PR #1211 review, F3 → round 2, G4).
 *
 * Substitution is keyed to the five names spelled EXACTLY `{{NAME}}`. If detection used the same shape, every
 * near-miss spelling — `{{ ITEM_NUM }}`, `{{item_num}}`, `{{ITEM-NUM}}` — would match nothing at all: not
 * substituted, and not reported either, since `unknownTokens` is fed by the same scan. A one-character typo in
 * the brief would then reach a dispatched agent verbatim and silently, which is the failure this fill exists to
 * prevent.
 *
 * ROUND 1'S FIX WAS STILL TOO NARROW, and the claim above {@link fillBrief} was stated more strongly than the
 * code delivered: the character class was `[A-Za-z0-9_-]`, so `{{ITEM NUM}}` and `{{ITEM.NUM}}` — an underscore
 * typed as a space, or as a dot — matched NOTHING and reached the agent verbatim AND unreported. The class is
 * now "anything that is not a brace and not a newline", which covers every spelling a placeholder can actually
 * be typed as. Newlines are excluded deliberately: a placeholder never spans lines, and admitting them would
 * let one unclosed `{{` swallow a paragraph of the brief's prose into a single bogus token.
 */
export const BRIEF_TOKEN_RE = /\{\{\s*([^{}\n]*?)\s*\}\}/g;

/**
 * The canonical placeholder a detected token name is a MISSPELLING OF, or null when it names nothing this
 * operation fills.
 *
 * NORMALIZES EVERY NON-ALPHANUMERIC RUN TO ONE `_`, then upper-cases — so `item-num`, `ITEM NUM`, `Item.Num`
 * and `item_num` all canonicalize to `ITEM_NUM`. Dashes alone were not enough (PR #1211 round 2, G4): the
 * separators typos actually produce are the space and the dot as much as the dash.
 *
 * @param {string} name - the token name, without braces.
 * @returns {string|null}
 */
export function canonicalPlaceholder(name) {
  const norm = String(name ?? '').trim().replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return BRIEF_PLACEHOLDERS.includes(norm) ? norm : null;
}

/**
 * What a placeholder VALUE may contain. An allowlist, and narrow on purpose.
 *
 * WHY IT IS NOT COSMETIC. The brief tells the agent to run `lane-pool.mjs acquire … --scope={{SCOPE}}
 * --item={{ITEM_NUM}}` — UNQUOTED, inside a `$( … )`. `SCOPE` is backlog frontmatter, so a scope entry
 * carrying a backtick, a `;` or a newline would land inside a shell command an agent is instructed to run.
 * That was survivable while a human filled the brief in a live session and read what they were pasting; this
 * operation mechanizes the fill, and a mechanized fill has to do its own checking.
 *
 * Every legitimate value is an id, a repo-relative path, a lane number or a comma-joined list of
 * repo-qualified paths, so letters, digits, `_ . , : / @ # -` covers all five with nothing left over.
 */
export const BRIEF_VALUE_RE = /^[A-Za-z0-9_.,:/@#-]+$/;

/**
 * What `{{GATE_COMMAND}}`/`{{ATTRIBUTION}}` (#3960) may contain — WIDER than {@link BRIEF_VALUE_RE} on
 * purpose, and for a different reason than that regex's own id/path/lane-number shape.
 *
 * `GATE_COMMAND` (`gateFor(...)`, `we:scripts/lib/repo-profile.mjs`) is a real shell command — `npm run
 * test:unit && npm run check:standards` — so it legitimately carries a space and `&&`; `ATTRIBUTION` is a short
 * commit-title reference — `WE #3960` or `PR #743` — so it legitimately carries a space too. Neither is
 * attacker- or frontmatter-controlled the way `SCOPE`/`ITEM_SPEC_PATH` are: both are COMPUTED, from a fixed,
 * small set of shapes (`composeGate`'s two command halves; a repo tag + a number), never read off a PR body, a
 * backlog file or any other text a human or a bounced review could shape. The risk `BRIEF_VALUE_RE` guards
 * against — a value quietly carrying a control character that escapes its intended use — still applies, so this
 * is an allow-LIST too, just a wider one: anything except a backtick, a `$`, a double quote, a backslash or a
 * newline (command substitution, string-quote-breaking, and escape characters — the shapes that turn a pasted
 * value into something OTHER than itself, wherever it lands: a bare shell line for `GATE_COMMAND`, inside a
 * double-quoted `printf` argument for `ATTRIBUTION`).
 */
export const BRIEF_FREE_TEXT_VALUE_RE = /^[^`$"\\\n]+$/;

/**
 * The two names {@link fillBrief} must check against {@link BRIEF_FREE_TEXT_VALUE_RE} rather than the default
 * {@link BRIEF_VALUE_RE} — see that regex's own docblock for why. Both `dispatchFix`
 * (`we:scripts/conveyor/reconcile-fix-dispatch.mjs`) and `dispatchCiHeal`
 * (`we:scripts/operations/ci-heal-pr-dispatch.mjs`) pass this as `fillBrief`'s `valuePatterns` argument so
 * neither reimplements the exception.
 */
export const REPO_AWARE_VALUE_PATTERNS = Object.freeze({
  GATE_COMMAND: BRIEF_FREE_TEXT_VALUE_RE,
  ATTRIBUTION: BRIEF_FREE_TEXT_VALUE_RE,
});

/**
 * The lane-lease session slug a dispatched agent carries. It MUST agree with `releaseSessionForNum`
 * (`we:scripts/conveyor/tick-core.mjs`), which derives the slug a merged PR's watcher hands to
 * `pr-watch --release-session` so the lease is auto-released at merge. A slug that disagreed here would strand
 * the lease: the watcher would release a session nobody acquired.
 *
 * PER KIND, because the core's side already is (#3165). `releaseSessionForNum` reads the PR's owning
 * PREPARE GUARD to pick `prepare-<num>` / `prepare-decision-<num>` and falls back to `conveyor-<num>`, so
 * dispatching a prepare under the build slug arms a watcher that would release a session which was never
 * created — and the failure is silent on both sides.
 *
 * FIX/CI-HEAL ARE KEYED ON THE PR, NOT THE ITEM (#3332) — the one design decision this function had to settle
 * that #3165's three kinds never raised. The backlog card that named this gap (#3332) asked the question
 * directly: "a fix is per-PR… the slug likely has to key on the PR rather than the item to stay unique when
 * one item bounces twice." Two fix rounds for the SAME item are already serialized one level up, by
 * `planFixSpawns`'s own per-PR live-guard (`guardedPrs`, `we:scripts/conveyor/tick-core.mjs`) — so an item-keyed
 * slug (`fix-<num>`) would not in practice collide TODAY. It is still the wrong key to choose: a PR-keyed slug
 * can never collide across two DIFFERENT PRs for the same item — e.g. a resolved-then-reopened item whose
 * second build opens a new PR number — the way a purely item-keyed slug could once that guard's assumptions
 * change. `pr` is passed as a THIRD parameter rather than folded into `num` so a caller with no PR in hand
 * (impossible for `fix`/`ci-heal` in practice, since both are always dispatched against an existing PR, but the
 * function stays honest about its own fallback) still gets a slug rather than a thrown error — see the `?? num`
 * below.
 *
 * KNOWN GAP, OUT OF THIS ITEM'S SCOPE (#3332 filed it as follow-up `#xm33exe`, `blockedBy: ["3332"]`):
 * `releaseSessionForNum`'s own docblock says this function's slug "MUST agree with" it, but that function does
 * NOT yet have `fix`/`ci-heal` branches — it only branches on `prepareKindByNum`, built solely from the LIVE
 * PREPARE guards, and falls through to `conveyor-<num>` for anything else. In practice this does NOT strand a
 * fix/ci-heal agent's OWN freshly-acquired repair lane at merge time today, because that lane is never
 * watcher-auto-released to begin with: both fix briefs (`we:skills-src/conveyor/fix-agent-brief.md`,
 * `we:skills-src/conveyor/fix-agent-ci-brief.md`) explicitly say "Do NOT release the lane" and rely on the
 * periodic lease-reaper stall backstop instead, same as a build's lane. But it is a real gap worth a follow-up
 * once fix/ci-heal dispatch is reachable at all — which is what THIS item (#3332) does — so `#xm33exe` is
 * filed rather than silently left for the next reader to rediscover.
 *
 * Minting is shared with the core through the pure session-slug module.
 *
 * ATTEMPT-TAGGED BUILD SLUGS (#3110): `attempt` rides the SAME trailing slot this file's own reap-side sibling
 * already tolerated (`we:scripts/conveyor/lease-reaper.mjs`'s `conveyor-2500b` example) — `''` for a first
 * attempt (so every pre-#3110 caller, which never passes it, is still byte-identical), `'b'`/`'c'`/… for a
 * retry. It is folded into `id` only, never into a `fix`/`ci-heal` slug: those two are keyed on the PR (below),
 * and a fresh `build` is the only kind that ever mints a new retry-attempt branch to begin with — see
 * {@link attemptTagFor}.
 *
 * @param {string|number} num
 * @param {'build'|'prepare'|'prepare-decision'|'fix'|'ci-heal'} [kind] - defaults to `build`, so every
 *   pre-#3165 caller is byte-identical.
 * @param {string|number|null} [pr] - the PR number, required in practice for `fix`/`ci-heal` (#3332). Falls
 *   back to `num` when absent.
 * @param {string} [attempt] - this dispatch's attempt tag (#3110; see {@link attemptTagFor}), `''` for a first
 *   attempt. Only ever non-empty for `kind === 'build'`.
 * @param {string} [repo] - constellation repo key; item kinds require WE.
 * @returns {string}
 */
export function sessionSlugFor(num, kind = 'build', pr = null, attempt = '', repo = 'we') {
  const id = `${String(num).trim()}${attempt}`;
  if (kind === 'investigate') return `investigate-${id}`;
  // #4078 — keyed on the health EPISODE id (`<date>-<smell>-<subject>-<HHMM>`, already slug-safe), never an item.
  if (kind === HEALTH_INVESTIGATE_KIND) return `health-${id}`;
  return mintSessionSlug({ kind: kind === 'build' ? 'conveyor' : kind,
    id: PR_KINDS.includes(kind) ? pr ?? num : num, attempt, repo });
}

/**
 * #3110 — the retry letter for a fresh `build` dispatch's session slug AND branch name, from data
 * {@link shapeDispatchRead} already has in hand at ZERO extra IO: `agedOutRuns` (this item's own not-yet-
 * holding, still-in-flight-status run records — the ONLY prior-attempt signal available here). `''` for a
 * first attempt keeps the branch/slug BYTE-IDENTICAL to every dispatch before this item, so the common,
 * by-far-most-frequent single-attempt path never changes shape at all.
 *
 * SAFE FROM THE RACE THE COUNT MIGHT SUGGEST: this function only ever runs after the in-flight-dispatch guard
 * above has ALREADY refused to proceed while any `holdingRuns` entry exists for this item, so no two dispatches
 * for the same item are ever mid-flight when this count is taken — it is a count of already-settled history,
 * not a number two concurrent callers could race to read differently.
 *
 * CAPPED at 'z' (25 prior attempts) rather than overflowing past a single lowercase letter. A 26th real retry
 * of the same item is itself the actionable anomaly; collapsing it onto 'z' rather than crashing is the
 * fail-safe direction (worst case, two very-late retries share a tag and fall back to the timing guard between
 * them — still no worse than pre-#3110).
 *
 * @param {number} priorAttempts - `agedOutRuns.length` for this item.
 * @returns {string}
 */
export function attemptTagFor(priorAttempts) {
  const n = Number(priorAttempts);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String.fromCharCode(97 + Math.min(Math.trunc(n), 25));
}

/**
 * FILL an agent brief. PURE.
 *
 * The brief is a TEMPLATE, not a prompt — `we:skills-src/conveyor/delivery-agent-brief.md` says so in its first
 * line, and the skill's §3 says its tokens "are the whole fill — do not rewrite its prose". So this substitutes
 * exactly `requiredNames` and nothing else — five tokens for a build/prepare/prepare-decision brief, six or
 * seven for a fix/ci-heal one (#3332; see {@link BRIEF_REQUIRED_BY_KIND}).
 *
 * ONE PASS, NOT ONE PER PLACEHOLDER. A sequential substitute-per-placeholder expands a token that appeared
 * inside an EARLIER value on a later iteration, which is both a wrong fill and one no leftover check can see
 * afterwards. A single regex pass reads each token exactly once, so a value is inert by construction.
 *
 * WHAT IT REFUSES — a value that is missing, blank, or outside {@link BRIEF_VALUE_RE} — UNLESS its name is in
 * `optional` (#3110: `ATTEMPT_TAG`, legitimately `''` on a first attempt), which skips BOTH checks for that one
 * name — an intentionally blank value is not a hole, so neither refusal applies to it. Every other placeholder
 * is a hole an agent cannot recover from when missing/blank/unsafe: it acquires no lane, or it runs a brief
 * carrying shell metacharacters.
 *
 * WHAT IT DOES **NOT** REFUSE — an UNKNOWN `{{TOKEN}}`, one that names none of the declared set. This is a correction of
 * the first cut, which threw on any leftover. The real brief's own prose carries two (`{{PLACEHOLDERS}}` and
 * `{{LIKE_THIS}}`, both inside code spans, both explaining the fill convention to a reader), so that check
 * refused EVERY dispatch of EVERY item — and no test caught it, because every test used a synthetic five-token
 * template. The check was also mis-weighted: a token in prose that names nothing costs an agent one confusing
 * line, while a false refusal costs the whole dispatch. So unknown tokens are REPORTED (`unknownTokens`, which
 * rides the run record) and never fatal.
 *
 * WHAT IT REFUSES AGAIN, and this is the correction of THAT correction (PR #1211 review, F3): a MISSPELLED
 * placeholder — a token that names one of the five in any other spelling (`{{ ITEM_NUM }}`, `{{item_num}}`,
 * `{{ITEM-NUM}}`, `{{ITEM NUM}}`, `{{ITEM.NUM}}`). The over-broad first fix made those neither substituted NOR
 * reported, because the scan regex matched only the exact shape; a one-character typo in the brief would reach
 * the agent verbatim and invisible.
 *
 * THE PROPERTY, and it is now exactly as wide as {@link BRIEF_TOKEN_RE}: **no placeholder of this operation's
 * own may reach a dispatched agent unsubstituted, spelled with any run of separators (spaces, dots, dashes,
 * underscores) and in any case — and the refusal names which one.** Round 1 claimed "in any spelling" while
 * the scan covered only `[A-Za-z0-9_-]`, which left `{{ITEM NUM}}` and `{{ITEM.NUM}}` invisible (round 2, G4);
 * the claim and the class are stated together here so the next reader can check one against the other. The one
 * spelling still outside it is a token carrying a BRACE or a NEWLINE, which no placeholder ever is.
 *
 * A token that names nothing we fill is still merely reported, so the real brief's prose still dispatches.
 *
 * @param {string} template - the brief's markdown.
 * @param {Record<string, string|number>} values - keyed by placeholder NAME (`ITEM_NUM`, not `{{ITEM_NUM}}`).
 * @param {string[]} [requiredNames] - which of {@link BRIEF_PLACEHOLDERS} THIS call must validate a value for
 *   (#3332). Defaults to `BRIEF_REQUIRED_BY_KIND.build` — NOT the full {@link BRIEF_PLACEHOLDERS} — and this
 *   is deliberate, not an oversight worth flagging twice: {@link BRIEF_PLACEHOLDERS} itself grew from five
 *   names to eight the moment `fix`/`ci-heal` were wired, so defaulting to it here would make every pre-#3332
 *   TWO-ARGUMENT caller start demanding `PR_NUM`/`LANE_REF`/`REASON` values it never had and never will —
 *   `BRIEF_REQUIRED_BY_KIND.build` IS the original five (`ITEM_NUM`, `ITEM_SPEC_PATH`, `LANE`, `SESSION_SLUG`,
 *   `SCOPE`, in the same order), so this default is what actually keeps every existing caller byte-identical.
 *   A real `fix`/`ci-heal` caller passes `BRIEF_REQUIRED_BY_KIND[launchKind]` explicitly.
 * @param {readonly string[]} [optionalNames] - names in `requiredNames` allowed to resolve to `''` (#3110).
 *   Defaults to {@link OPTIONAL_BRIEF_PLACEHOLDERS} so every pre-#3110 caller — anything that never passes a
 *   value for `ATTEMPT_TAG` — is unaffected; only a `build` fill's `ATTEMPT_TAG` entry ever exercises this.
 * @param {Readonly<Record<string, RegExp>>} [valuePatterns] - per-name override of {@link BRIEF_VALUE_RE}
 *   (#3960). Defaults to `{}`, so every pre-#3960 caller is unaffected. A `fix`/`ci-heal` caller passes
 *   {@link REPO_AWARE_VALUE_PATTERNS} so `GATE_COMMAND`/`ATTRIBUTION` are checked against the wider
 *   {@link BRIEF_FREE_TEXT_VALUE_RE} instead — see that regex's docblock for why those two names need it.
 * @returns {{prompt: string, unknownTokens: string[]}}
 */
export function fillBrief(
  template,
  values = {},
  requiredNames = BRIEF_REQUIRED_BY_KIND.build,
  optionalNames = OPTIONAL_BRIEF_PLACEHOLDERS,
  valuePatterns = {},
) {
  const text = String(template ?? '');
  if (!text.trim()) {
    throw new Error('dispatch-lane: the delivery-agent brief template is empty — refusing to dispatch an agent with no instructions');
  }
  for (const name of requiredNames) {
    const value = values[name];
    const blank = value === undefined || value === null || String(value).trim() === '';
    if (blank && optionalNames.includes(name)) continue; // #3110 — an intentional blank, not a hole
    if (blank) {
      throw new Error(`dispatch-lane: no value for the brief placeholder {{${name}}} — refusing to fill it with nothing`);
    }
    const pattern = valuePatterns[name] ?? BRIEF_VALUE_RE;
    if (!pattern.test(String(value))) {
      throw new Error(
        `dispatch-lane: the value for {{${name}}} (${JSON.stringify(String(value))}) has characters the brief cannot carry `
        + 'safely — it is pasted UNQUOTED into a shell command the agent is told to run. Refusing.',
      );
    }
  }
  const unknown = new Set();
  const misspelled = new Set();
  const prompt = text.replace(BRIEF_TOKEN_RE, (whole, name) => {
    // The EXACT shape is the only one that substitutes. `whole` is compared rather than `name` alone because
    // the scan strips the surrounding whitespace into the match but not into the capture, so `{{ ITEM_NUM }}`
    // and `{{ITEM_NUM}}` arrive with the same `name` and must NOT be treated the same.
    // ONLY A NAME THIS CALL ACTUALLY VALIDATED substitutes — `requiredNames`, not the full
    // `BRIEF_PLACEHOLDERS`. This is the fix for the exact hole #3332 named: a `fix` fill is never handed an
    // `ITEM_SPEC_PATH`, so `values.ITEM_SPEC_PATH` is `undefined` — checking membership in the wider
    // `BRIEF_PLACEHOLDERS` set instead of `requiredNames` would still pass (`ITEM_SPEC_PATH` IS one of the
    // five/eight known names) and substitute the JavaScript string `"undefined"` into the brief the moment it
    // happened to contain `{{ITEM_SPEC_PATH}}` — silently, because nothing above validated it as missing.
    // `?? ''` (#3110) covers the one required-but-OPTIONAL name (`ATTEMPT_TAG`): a validated intentional blank
    // must still substitute as `''`, not the literal string `"undefined"`.
    if (whole === `{{${name}}}` && requiredNames.includes(name)) return String(values[name] ?? '');
    const canonical = canonicalPlaceholder(name);
    if (canonical) { misspelled.add(`${whole} (meaning {{${canonical}}})`); return whole; }
    unknown.add(whole);
    return whole;
  });
  if (misspelled.size) {
    throw new Error(
      `dispatch-lane: the brief carries a MISSPELLED placeholder — ${[...misspelled].sort().join(', ')}. No `
      + 'substitution reaches it, so the dispatched agent would run the token verbatim (a lane leased under a '
      + 'literal `{{ SESSION_SLUG }}` is a lease nothing ever releases). Refusing to dispatch. Spell it exactly '
      + `as one of ${BRIEF_PLACEHOLDERS.map((n) => `{{${n}}}`).join(', ')}.`,
    );
  }
  return { prompt, unknownTokens: [...unknown].sort() };
}

/**
 * Does an in-flight dispatch record still HOLD its item against a fresh dispatch?
 *
 * ── TWO OPPOSITE FAILURES, AND THIS FUNCTION HAS TO AVOID BOTH ───────────────────────────────────────────────
 *
 * **The wedge (PR #1211 round 1, F1).** Three shipped decisions composed into a permanent, per-item lockout:
 * the observer never answers `succeeded` (`claude agents` reports liveness, not outcome — #x9ylkp7),
 * `unresolved` writes nothing, so the entry stays `in-flight` forever; and the guard refused any item with ANY
 * in-flight record. Run records are never pruned, so ONE dispatch per item was the ceiling and the conveyor's
 * own loop (dispatch → PR → review bounces → re-dispatch) could never run.
 *
 * **The hole (PR #1211 round 2, G1).** The first fix aged the hold out on WALL CLOCK alone, and its docblock
 * claimed an entry past `expectedBy + grace` was "by construction" finished or dead. That is false, and the
 * same module proves it: the observer's other answer is `running`, and nothing bounds it. A background session
 * stalled on a permission prompt is ALIVE, holds no lane lease and has claimed no item — so at t+2h the tick
 * core hands out the same cleared row and the same lane, and a SECOND agent starts under the same session slug.
 * The clock removed the cover in precisely the case where the cover was doing work.
 *
 * ── THE AXIS IS LIVENESS; THE CLOCK IS ONLY THE BACKSTOP ────────────────────────────────────────────────────
 *
 * `entry.live` is the answer `claude agents --json` gave about THIS record's handle, stamped onto the row by
 * the io shell (`we:scripts/operations/dispatch-lane-io.mjs#stampLiveness`) so this stays pure. Three values,
 * three rules:
 *
 *   | `live`  | meaning                                   | verdict                                            |
 *   |---------|-------------------------------------------|----------------------------------------------------|
 *   | `true`  | the session is LISTED — the agent is alive | HOLDS, and no clock may overrule it                |
 *   | `false` | listed-and-absent — the agent is gone      | ages out as soon as it is older than the listing grace |
 *   | nullish | no handle, or the listing could not be read | the CLOCK backstop below                          |
 *
 * That satisfies both constraints at once, which is the whole point: a record whose session is gone forever
 * still ages out (in MINUTES now, not hours), and a record whose session is alive is never released on a clock.
 *
 * WHY `false` STILL WAITS OUT A GRACE. `claude --bg` returns before its session is necessarily listed, so
 * "absent" inside {@link DISPATCH_GUARD_LISTING_GRACE_MINUTES} of the anchor below is *not yet visible*, not
 * *gone* — and those seconds are exactly the spawn→claim window this guard exists for. Absent with no usable
 * anchor at all cannot be told apart from either, so it holds. The guard's window is its OWN and is larger
 * than the observer's {@link DISPATCH_LISTING_GRACE_MINUTES}; that constant's docblock says why.
 *
 * AND WHY IT AGES FROM `lastSeenLiveAt`, NOT `startedAt`. `startedAt` answers "how long ago did this begin?",
 * which is the wrong question for an agent that has been confirmed alive since. Anchored on `startedAt`, ONE
 * bad listing read against a long-running build is instantly past the grace and releases the lane — the age
 * that matters is the age of the last CONFIRMATION, not of the dispatch. `lastSeenLiveAt` is stamped every
 * time a listing read answers `live: true` (`dispatch-lane-io.mjs#persistLastSeenLive`), so a bad read
 * arriving straight after a real "seen alive" cannot release the item, while two bad reads spaced by the
 * window still can. It falls back to `startedAt` only when it was never set — a dispatch never yet seen alive,
 * which is the case the original window was written for and where the two anchors agree.
 *
 * WHY THE CLOCK IS SOUND FOR THE NULLISH CASE AND ONLY THERE. A handle-less INDETERMINATE entry can never be
 * observed at all, and an unreadable listing means the system has NO liveness signal — so the `running` answer
 * that made the clock wrong cannot be the one being contradicted. G1's property holds: this never releases an
 * item while the system's own liveness signal says the agent is running.
 *
 * FAIL-CLOSED ON A DATE IT CANNOT READ. No usable instant, or a record carrying neither `expectedBy` nor
 * `startedAt`, means the age is unknown — and an unknown age holds, because the cost of a wrong "aged out" is
 * two agents in one clone and the cost of a wrong "still holding" is a refusal an operator can see and act on
 * (`wake.mjs --resolve`, which now refuses to close out a LIVE handle without `--force`).
 *
 * @param {{expectedBy?: string|null, startedAt?: string|null, lastSeenLiveAt?: string|null, live?: boolean|null}} entry -
 *   an in-flight dispatch record summary, with the liveness answer the io shell stamped onto it and the
 *   instant a listing read last confirmed it alive.
 * @param {string} at - the instant the read was taken, ISO. The io shell supplies it; this stays pure.
 * @param {{expectedWithinMinutes?: number, graceMinutes?: number, listingGraceMinutes?: number}} [o]
 * @returns {boolean}
 */
export function dispatchStillHolds(entry, at, {
  expectedWithinMinutes = DEFAULT_EXPECTED_WITHIN_MINUTES,
  graceMinutes = DISPATCH_HOLD_GRACE_MINUTES,
  listingGraceMinutes = DISPATCH_GUARD_LISTING_GRACE_MINUTES,
} = {}) {
  const now = Date.parse(String(at ?? ''));
  if (Number.isNaN(now)) return true;
  const startedAt = Date.parse(String(entry?.startedAt ?? ''));

  // THE AGENT IS ALIVE. No clock, at any age. This is the branch the round-2 fix did not have.
  if (entry?.live === true) return true;

  // THE AGENT IS GONE from a listing that WAS read. Nothing can collide with a session that does not exist, so
  // the hold ends as soon as the record is too old for "absent" to mean "not listed yet".
  if (entry?.live === false) {
    // THE ANCHOR IS THE LAST CONFIRMATION, falling back to the start only for a dispatch never seen alive.
    const lastSeenLive = Date.parse(String(entry?.lastSeenLiveAt ?? ''));
    const anchor = Number.isNaN(lastSeenLive) ? startedAt : lastSeenLive;
    if (Number.isNaN(anchor)) return true;
    // THE FALLBACK IS THE GUARD'S WINDOW TOO. Reading the observer's constant here would hand a caller that
    // passed a malformed or negative `listingGraceMinutes` the smaller number back — the guard's default
    // quietly downgraded to the observer's by a bad argument, which is the hole the default alone leaves open.
    const listingGrace = Number(listingGraceMinutes) >= 0 ? Number(listingGraceMinutes) : DISPATCH_GUARD_LISTING_GRACE_MINUTES;
    return now < anchor + listingGrace * 60_000;
  }

  // LIVENESS IS UNKNOWN — the clock backstop, and the only case it is sound for.
  const expectedBy = Date.parse(String(entry?.expectedBy ?? ''));
  // `expectedBy` is the deadline the sink recorded. A handle-less INDETERMINATE entry never got one, so its
  // deadline is reconstructed from `startedAt` and the same estimate the dispatch would have used.
  const deadline = Number.isNaN(expectedBy)
    ? (Number.isNaN(startedAt) ? NaN : startedAt + (Number(expectedWithinMinutes) > 0 ? Number(expectedWithinMinutes) : DEFAULT_EXPECTED_WITHIN_MINUTES) * 60_000)
    : expectedBy;
  if (Number.isNaN(deadline)) return true;
  return now < deadline + (Number(graceMinutes) >= 0 ? Number(graceMinutes) : DISPATCH_HOLD_GRACE_MINUTES) * 60_000;
}

/**
 * The answers `stampLiveness` may give about where an in-flight record's liveness came from. Anything else
 * (including an absent field) reads as `unknown`, which is the honest word for a reader that did not say.
 *
 * `wrapper-pid` (#3645/#4212) — every row in flight was a detached delivery-wrapper handle (`pid:<n>`) and the
 * answer came straight from the kernel, with no `claude agents` listing shelled at all. It is the STRONGEST
 * source, not a weaker cousin of `claude-agents`: a listing can be unreadable or stale, but a kernel pid probe
 * cannot degrade the same way, so it must be named rather than collapsing into `unknown` (which would make the
 * guard look weaker than it is) or `claude-agents` (which would claim a listing that was never read).
 */
export const LIVENESS_SOURCES = Object.freeze(['claude-agents', 'unreadable', 'not-needed', 'wrapper-pid']);

/** A launch/suppression row from the tick core, or null. Shape-checked, never trusted blind. */
function shapeRow(row, what) {
  if (row == null) return null;
  if (typeof row !== 'object' || row.num == null) {
    throw new Error(`dispatch-lane.read: the injected reader returned a malformed \`${what}\` row`);
  }
  return row;
}

/**
 * SHAPE one tick read into the `read` finding, and FILL the brief while everything needed is in hand. PURE —
 * separated from the injected reader so every refusal below is testable without `gh`, `git` or a lane pool.
 *
 * WHAT THE READER OWES, and why each piece is refused when missing:
 *   - `launch` — the `decisions.spawnBuilds` row for THIS num, already selected by the shell's `normNum`. Its
 *     `lane` is the core's assignment and the only lane this operation will ever dispatch.
 *   - `suppressed` — the `decisions.suppressedBuilds` row, when the core dropped this num instead. Carried so
 *     the non-dispatch says WHY (`by: 'num'` — an agent is already in flight for it; `by: 'lane'` — its lane is).
 *   - `item` — the spec path and the repo-qualified `scope:`, both of which go into the brief.
 *   - `briefTemplate` — the delivery brief's markdown.
 *   - `bookkeepingSource` — where the in-flight guards came from. `'none'` is a REAL degradation and is
 *     reported, not hidden: with no bookkeeping the core sees no in-flight guards, so its only protection
 *     against a double-dispatch is the durable state (a leased lane, a claimed item), which leaves the
 *     spawn→claim window uncovered. Legible, never silent.
 *
 * @param {object} raw - what `we:scripts/operations/dispatch-lane-io.mjs`'s `readTick` returns.
 * @param {{num: string, expectedWithinMinutes: number}} asked
 * @returns {object} the `read` finding.
 */
export function shapeDispatchRead(raw, { num, expectedWithinMinutes } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`dispatch-lane.read: the injected reader returned ${typeof raw}, not a tick read`);
  }
  const launch = shapeRow(raw.launch, 'launch');
  const suppressed = shapeRow(raw.suppressed, 'suppressed');
  // WHICH OF THE CORE'S THREE LAUNCH LISTS this row came out of (#3165). The shell resolved it; this half
  // REFUSES an unknown one rather than defaulting, for the same reason `briefPath` throws: the fallback would
  // hand a scope-prep agent the 39 KB delivery mandate — an agent told to build an item whose scope is exactly
  // what nobody has written yet. An ABSENT kind is the pre-#3165 shape and reads as `build`; a PRESENT but
  // unrecognized one is a shell that changed under us, and is fatal.
  const launchKind = raw.launchKind === undefined || raw.launchKind === null ? 'build' : String(raw.launchKind);
  if (!LAUNCH_KINDS.includes(launchKind)) {
    throw new Error(
      `dispatch-lane.read: the injected reader returned an unknown \`launchKind\` ${JSON.stringify(raw.launchKind)} `
      + `— it must be one of ${LAUNCH_KINDS.join(', ')}. Refusing to guess which agent to start.`,
    );
  }
  const resolvedNum = String(raw.resolvedNum ?? '').trim();
  if (!resolvedNum) {
    throw new Error(`dispatch-lane.read: the reader could not resolve ${JSON.stringify(num)} to an item id`);
  }

  // THIS OPERATION'S OWN IN-FLIGHT DISPATCHES, read from the run store by the io shell. Split below, but read
  // here so the PARTIAL-GUARD count can ride `base` — every exit from this function reports it.
  const inFlight = raw.inFlightDispatches && typeof raw.inFlightDispatches === 'object' ? raw.inFlightDispatches : { runs: [], unreadable: 0 };
  const allRuns = Array.isArray(inFlight.runs) ? inFlight.runs : [];

  // Record the very conditions used below, preserving short-circuit order. A trace never
  // evaluates a later gate on a path that returned early.
  const gates = [];
  const blocked = (name, condition, observed) => {
    gates.push({ name, pass: !condition, observed });
    return condition;
  };
  const base = {
    gates,
    asked: String(num ?? ''),
    num: resolvedNum,
    // WHICH AGENT this call is about, on every exit — a non-dispatch that says "not cleared" is a different
    // fact depending on whether a build or a prepare was asked for, and the run record has to say which.
    launchKind,
    // The tick's own one-line status and notes, carried verbatim so an operator reading a run record sees the
    // same sentence the conveyor's status line shows. Display only — nothing downstream decides on them.
    statusLine: String(raw.statusLine || ''),
    notes: Array.isArray(raw.notes) ? raw.notes.map((n) => String(n?.text ?? n)) : [],
    bookkeepingSource: raw.bookkeepingSource === 'file' ? 'file' : 'none',
    // WHICH OF THE CALLER'S OWN SETTINGS THIS RUN DID NOT HONOUR. The io shell forwards only `bookkeeping` to
    // the tick core (`config` carries the TTLs and the retry caps, `signals` retires guards outright), and
    // dropping `config` is not purely conservative — a caller running a LONGER `buildTtlTicks` gets the shipped
    // default instead. So the drops are carried onto the verdict rather than being a comment's promise.
    droppedBookkeeping: Array.isArray(raw.droppedBookkeepingKeys) ? raw.droppedBookkeepingKeys.map(String) : [],
    // THE WHOLE TICK'S NEXT BOOKKEEPING — and it describes a tick that did NOT fully happen, which is why it is
    // named for what it is rather than offered as `nextState`.
    //
    // `planTick` plans the ENTIRE tick: a build guard for every row in `spawnBuilds`, plus prepare, fix and
    // CI-heal guards and their `launchedNums`. This operation executes exactly ONE of those decisions. So a
    // caller that carried this map forward would hold guards for agents nobody started — the next call for a
    // sibling item would come back "an agent is already in flight for this item" for the whole TTL, for a
    // dispatch that never occurred.
    //
    // A CALLER RUNNING ONLY THIS OPERATION CARRIES `dispatchedGuard`, NOT THIS. `tickNextState` is here for
    // the caller that DOES drive the whole tick (the runner), and for a reader who wants to see what the core
    // decided; #xaibmeu is where the bridge chooses which of the two it is.
    tickNextState: raw.nextState && typeof raw.nextState === 'object' ? raw.nextState : null,
    // THIS DISPATCH'S OWN GUARD ENTRY — `{ num, lane, spawnedTick }`, exactly the shape `filterLaunches` reads,
    // and the only bookkeeping this operation actually earns. Null on a non-dispatch.
    dispatchedGuard: raw.dispatchedGuard && typeof raw.dispatchedGuard === 'object' ? raw.dispatchedGuard : null,
    expectedWithinMinutes: Number(expectedWithinMinutes) > 0 ? Number(expectedWithinMinutes) : DEFAULT_EXPECTED_WITHIN_MINUTES,
    // HOW PARTIAL THE DOUBLE-DISPATCH GUARD WAS. `inFlightDispatchesFor` skips a run record it cannot read
    // rather than wedging every dispatch behind one corrupt file — a real trade, and its docblock promised the
    // count "rides the result so a caller can see the guard was partial". It did not: the number was read and
    // dropped (PR #1211 review, F4). It rides `base` now, so it reaches the verdict on EVERY exit, dispatch or
    // not. The guard's failure mode is two agents in one lane clone; a silently-partial one is the last thing
    // that should be invisible.
    unreadableRunRecords: Number(inFlight.unreadable) > 0 ? Number(inFlight.unreadable) : 0,
    // WHERE THE HOLD'S LIVENESS ANSWER CAME FROM (PR #1211 round 2, G1). `claude-agents` means each in-flight
    // record was checked against the real session listing; `unreadable` means the listing could not be read at
    // all and every hold fell back to the CLOCK backstop, which is a materially weaker guard and must not look
    // like the strong one; `not-needed` means there was nothing in flight to ask about.
    dispatchLiveness: LIVENESS_SOURCES.includes(inFlight.livenessSource) ? inFlight.livenessSource : 'unknown',
    // THE PR THIS DISPATCH REPAIRS, and (for CI-heal) WHY it fired — `null` for build/prepare/prepare-decision
    // and for every non-dispatching exit (#3332). Carried on `base` rather than threaded individually through
    // each early return, matching how `itemSpecPath`/`scope` are already threaded through the "holding" and
    // "no launch" branches below (`null` / `[]` there): one place says what a non-dispatch's `read` finding
    // looks like, instead of five returns that could each say something different. Overwritten below with a
    // real value only on the one branch that actually dispatches a `fix`/`ci-heal`.
    pr: null,
    reason: null,
    // #3457/#3460 — the merged PR (if any) the ground-truth check found closing this item out already. `null`
    // on every exit except the one new branch below that actually refuses on it.
    alreadyDonePr: null,
    // #3462 — the item's still-open `blockedBy` targets, or `[]` on every exit except the one branch below
    // that actually refuses on them.
    openBlockers: [],
    // #3168 — does THIS dispatch leave the lane's Edit/Write occupancy guard fail-open (see
    // `KIND_DECLARES_OCCUPANCY_ON_DISPATCH`)? `false`/`null` on every non-dispatching exit — there is no lane
    // live yet to warn about — overwritten on the one branch below that actually dispatches.
    occupancyFailOpen: false,
    occupancyWarning: null,
  };

  // THIS OPERATION'S OWN IN-FLIGHT DISPATCHES, checked BEFORE the launch — because the case it covers is
  // exactly the one where the tick core sees nothing wrong. The core's build guard lives in the CALLER'S
  // session bookkeeping, which defaults to empty here, and the LANE is leased by the agent seconds after it
  // starts. So two back-to-back invocations get the same cleared row, the same lane, and two agents in one
  // clone. The run store is the only thing that remembers the first one, and it remembers it across a restart.
  //
  // BUT ONLY WHILE IT COULD STILL BE THAT WINDOW — see `dispatchStillHolds`. Holding on EVERY in-flight record
  // made one completed dispatch lock its item out forever, because nothing ever resolves the entry
  // (`unresolved` writes nothing) and run records are never pruned; releasing on the CLOCK ALONE handed the
  // same lane to a second agent while the first was still listed as running.
  const holdingRuns = allRuns.filter((r) => dispatchStillHolds(r, raw.observedAt, { expectedWithinMinutes: base.expectedWithinMinutes }));
  const agedOutRuns = allRuns.filter((r) => !holdingRuns.includes(r));
  if (blocked('in-flight-dispatch', holdingRuns.length > 0, { runs: allRuns, holdingRuns, observedAt: raw.observedAt ?? null })) {
    // WHICH KIND OF HOLD IT IS, in the operator's own line: a session `claude agents` still lists is a
    // materially different fact from one whose liveness nothing could establish, and the remedies differ.
    const liveHolds = holdingRuns.filter((r) => r.live === true);
    return {
      ...base,
      dispatching: false,
      lane: null,
      sessionSlug: null,
      prompt: null,
      briefUnknownTokens: [],
      itemSpecPath: null,
      scope: [],
      dispatchedGuard: null,
      inFlightRuns: holdingRuns,
      agedOutRuns,
      holdReason:
        `this operation already has a dispatch in flight for #${resolvedNum} (run ${holdingRuns.map((r) => r.runId).join(', ')}) — `
        + (liveHolds.length
          ? `its session is STILL LISTED by \`claude agents\` (${liveHolds.map((r) => r.handle).join(', ')}), so the agent is alive. `
          : 'nothing could establish whether its agent is alive, and it is still inside the clock backstop. ')
        + 'Resolve or close out that run '
        + '(`node scripts/operations/wake.mjs --resolve=<runId> --key=<effectKey> --status=failed`) before dispatching '
        + 'again; starting a second agent would put two of them in one lane clone.',
    };
  }

  // #3457/#3460 — THE ALREADY-DONE GROUND-TRUTH REFUSAL. Checked BEFORE `!launch` (though by construction it
  // can only ever be set when `launch` was truthy — see `readTick`'s own lazy call) so this reads as its own
  // priority tier rather than falling out of "not cleared" by accident. `raw.alreadyDone` was computed by the
  // io shell (this file stays pure — no network here); a real merged PR closing this item out is a STRONGER
  // and more authoritative signal than anything the tick core itself decided, because the core's whole
  // `open`/`active` view of this item comes from the SAME stale `status:` frontmatter this check exists to
  // stop trusting blind (#3434's own motivating incident: `status: open`, `kind: decision`, PR already merged
  // hours earlier). HOLDS, never auto-resolves — see `filterAlreadyDoneCandidates`'s own docblock in
  // `dispatch-lane-io.mjs` for why a false positive here must stay recoverable rather than silently correcting
  // the backlog's own frontmatter.
  const alreadyDone = raw.alreadyDone && typeof raw.alreadyDone === 'object' ? raw.alreadyDone : null;
  if (blocked('already-done', !!(alreadyDone && alreadyDone.done && alreadyDone.pr && typeof alreadyDone.pr === 'object'), alreadyDone)) {
    const { pr } = alreadyDone;
    return {
      ...base,
      inFlightRuns: [],
      agedOutRuns,
      dispatching: false,
      lane: null,
      sessionSlug: null,
      prompt: null,
      briefUnknownTokens: [],
      itemSpecPath: null,
      scope: [],
      dispatchedGuard: null,
      alreadyDonePr: pr,
      holdReason:
        `#${resolvedNum} already appears CLOSED by a merged PR — ${pr.url ?? `PR #${pr.number}`} `
        + `(${JSON.stringify(String(pr.title ?? ''))}, merged ${pr.mergedAt ?? 'unknown time'}) — refusing to `
        + `dispatch a ${launchKind} agent for work a real PR history already shows done. If #${resolvedNum}'s `
        + 'real status is genuinely still open, verify by hand (the ground-truth check can false-positive on a '
        + 'PR that only touched this item\'s own card, not its implementation) before re-dispatching.',
    };
  }

  // #3462 — THE BLOCKED-ITEM REFUSAL. Checked BEFORE `!launch`, same priority tier as the already-done check
  // just above and for the same reason: `we:scripts/readiness/dispatch-plan.mjs`'s `hasOpenBlockers` hold is
  // only reachable through the automatic sweep, whose queue (`backlog.mjs build-queue`) already excludes any
  // item with an unresolved `blockedBy` edge — so a blocked item never reaches `planTick`'s `spawnBuilds` via
  // that path and `hasOpenBlockers` never actually fires there. This CLI's `--num=<N>` path does not go
  // through that queue at all; it resolves the item directly and can hand `planTick` a `num` the automatic
  // sweep would never have offered it. `openBlockers` (read here off `raw.item`, threaded through by
  // `findItem` in `dispatch-lane-io.mjs`) is the SAME field the automatic path's hold is named for, read here
  // for the first time on this path — mirroring the "already-done" ground-truth check's own shape, not the
  // core's launch decision, which is why it is checked independent of `launch` (a live #3398-shaped bug: the
  // core cleared it for `spawnBuilds` anyway, three times, with an open `blockedBy` the whole time).
  const openBlockers = Array.isArray(raw.item?.openBlockers) ? raw.item.openBlockers.map(String).filter(Boolean) : [];
  if (blocked('blockedBy', openBlockers.length > 0, openBlockers)) {
    return {
      ...base,
      inFlightRuns: [],
      agedOutRuns,
      dispatching: false,
      lane: null,
      sessionSlug: null,
      prompt: null,
      briefUnknownTokens: [],
      itemSpecPath: null,
      scope: [],
      dispatchedGuard: null,
      openBlockers,
      holdReason:
        `#${resolvedNum} is blocked — open blocker(s) ${openBlockers.join(', ')} — refusing to dispatch a `
        + `${launchKind} agent until every \`blockedBy\` edge resolves. This is a hard, unconditional refusal `
        + '(#3462): there is no override flag for a manual dispatch to force a blocked item through — see '
        + '`backlog/3462-manual-dispatch-lane-never-checks-blockedby-a-structurally-b.md` for the recorded '
        + 'decision. Re-check the blocker(s), or dispatch a different item.',
    };
  }

  if (blocked('tick-launch', !launch, { launch, suppressed, admission: raw.admission ?? null })) {
    return {
      ...base,
      inFlightRuns: [],
      agedOutRuns,
      dispatching: false,
      lane: null,
      sessionSlug: null,
      prompt: null,
      briefUnknownTokens: [],
      itemSpecPath: null,
      scope: [],
      dispatchedGuard: null,
      // The core's own word for why, or the honest "it was not in this tick's launch set at all" — which is
      // what an unscoped, lease-overlapped or not-cleared item looks like from here (a blocked item is caught
      // above, before this branch, with its own more specific reason).
      holdReason: suppressed?.by === 'capacity-cap'
        ? 'suppressed by the tick concurrency capacity cap'
        : suppressed
        ? `suppressed by the in-flight build guard (${suppressed.by === 'lane' ? `lane ${suppressed.lane} is held` : 'an agent is already in flight for this item'})`
        : raw.admission?.held
          ? `the build planner held this item: ${raw.admission.held.reason}`
          : 'the tick core did not clear this item for dispatch — it is not in `decisions.spawnBuilds`, '
          + '`decisions.spawnPrepareScope`, `decisions.spawnPrepareDecision`, `decisions.spawnInvestigations`, '
          + '`decisions.spawnFixes` or `decisions.spawnCiHeals`',
    };
  }

  if (blocked('assigned-lane', launch.lane == null || String(launch.lane).trim() === '', launch.lane ?? null)) {
    throw new Error(`dispatch-lane.read: the tick core cleared #${resolvedNum} but assigned it no lane — refusing to dispatch without one`);
  }
  const item = raw.item && typeof raw.item === 'object' ? raw.item : null;
  const specPath = String(item?.specPath || '').trim();
  const itemScope = Array.isArray(item?.scope) ? item.scope.map(String).filter(Boolean) : [];
  if (blocked('item-spec', !specPath, specPath)) {
    throw new Error(`dispatch-lane.read: no backlog file resolved for #${resolvedNum} — the brief needs the item's spec path`);
  }
  // THE LANE-LEASE SCOPE, and the word `scope` doing two jobs is what made this look like a blocker (#3165).
  // THREE CASES now, not two (#3332 added the third):
  //
  //   - a BUILD's lane scope is the item's own `scope:` FRONTMATTER — the paths it will edit;
  //   - a PREPARE's lane scope is `we:<specPath>`, the item's own backlog file. It is not a choice made here:
  //     `we:skills-src/conveyor/SKILL.md:272` says a prepare's `--scope` is "a single, distinct backlog file
  //     … disjoint by construction", and both prepare briefs already run exactly that `acquire`.
  //   - a FIX/CI-HEAL's lane scope is ALSO the item's own `scope:` frontmatter, same as a build (#3332). This
  //     answers the open question #3332's own card body raised and required be settled here, before the
  //     refusal below was written: a fix/ci-heal dispatch repairs code an earlier BUILD already wrote inside
  //     the item's own declared scope — unlike a `prepare`, it is never dispatched BECAUSE the item lacks a
  //     scope, so there is no "unscoped item being repaired" case to accommodate, and the refusal is exactly
  //     as sound here as it is for `build`.
  //
  // A prepare agent is dispatched PRECISELY BECAUSE the item has no `scope:` — that is the thing it is being
  // sent to write. So the refusal below is BUILD-and-FIX/CI-HEAL-only and stays where it is, and the prepare
  // branch routes past it rather than around it being weakened.
  //
  // PINNED RESIDUAL: `prepare-decision-agent-brief.md:68-69`'s own `acquire` declares a WIDER scope than this
  // one file — it appends `we:src/_data/researchTopics.json` and `we:src/_includes/research-descriptions/`,
  // the `/research/` files a decision prepare authors. The brief is the thing that actually takes the lease,
  // so that is the scope the lane ends up holding; this value is what the run record says was declared. The
  // card (#3165) sets one rule for both prepare kinds, so this is recorded rather than silently widened.
  const repairsExistingPr = launchKind === 'fix' || launchKind === 'ci-heal';
  const scope = launchKind === 'build' || repairsExistingPr ? itemScope : [`we:${specPath}`];
  if (blocked('scope', (launchKind === 'build' || repairsExistingPr) && !itemScope.length, { launchKind, scope })) {
    // Unreachable through the core (`dispatch-plan` holds an unscoped item `unshaped-no-scope` and auto-prepares
    // it, so it never reaches `spawnBuilds`, `spawnFixes` or `spawnCiHeals`) — refused anyway, because an empty
    // `--scope` declares a lane that owns no paths and the scope-lease collector would let an overlapping
    // sibling launch beside it.
    throw new Error(
      `dispatch-lane.read: #${resolvedNum} has no \`scope:\` — the dispatcher never launches an item with no `
      + '`scope:` for build, fix or CI-heal work',
    );
  }

  // #3110 — only a fresh `build` dispatch mints a retry-attempt letter; `fix`/`ci-heal` reconstitute onto the
  // SAME existing PR/ref, never a new branch, so they have no retry-attribution problem `attemptTagFor` exists
  // to solve. See `attemptTagFor`'s own docblock for why `agedOutRuns.length` is a safe, race-free count here.
  const attempt = launchKind === 'build' ? attemptTagFor(agedOutRuns.length) : '';
  const sessionSlug = sessionSlugFor(resolvedNum, launchKind, launch.pr, attempt);
  // THE VALUES THIS FILL ACTUALLY HAS, built per kind rather than as one flat object (#3332). A `fix`/`ci-heal`
  // dispatch has no `ITEM_SPEC_PATH` to give — it never reads the item's spec, it repairs an existing PR — and
  // passing `PR_NUM`/`LANE_REF` (and, for CI-heal, `REASON`) unconditionally to every kind would hand a build
  // fill a key `BRIEF_REQUIRED_BY_KIND.build` never asks for and `fillBrief` would never validate, which is
  // exactly the unvalidated-token hole `requiredNames` exists to close. So each kind gets only the keys its own
  // brief actually references. `ATTEMPT_TAG` (#3110) is harmless to include for prepare/prepare-decision too —
  // it is always `''` for those (see above), and `BRIEF_REQUIRED_BY_KIND` for those two kinds never lists it,
  // so `fillBrief` neither requires nor substitutes it there even though it rides `values`.
  const values = repairsExistingPr
    ? {
      ITEM_NUM: resolvedNum,
      PR_NUM: launch.pr,
      LANE_REF: raw.laneRef,
      LANE: launch.lane,
      SESSION_SLUG: sessionSlug,
      SCOPE: scope.join(','),
      ...(launchKind === 'ci-heal' ? { REASON: launch.reason } : {}),
      // #3960 — REPO/LANE_REPO/GATE_COMMAND/WE_ROOT/ATTRIBUTION, computed by the io shell (`raw.repoTokens`,
      // `we:scripts/operations/dispatch-lane-io.mjs#readTick`) since resolving them needs real IO (a
      // checkout's `package.json`) this file is asserted never to reach. `null`/missing here is not papered
      // over: `fillBrief`'s own required-value refusal is what actually stops the dispatch (see `raw.repoTokens`'s
      // own docblock at the io shell).
      ...(raw.repoTokens && typeof raw.repoTokens === 'object' ? raw.repoTokens : {}),
    }
    : {
      ITEM_NUM: resolvedNum,
      ITEM_SPEC_PATH: specPath,
      LANE: launch.lane,
      SESSION_SLUG: sessionSlug,
      SCOPE: scope.join(','),
      ATTEMPT_TAG: attempt,
      // #3637 — `main` unless the item declares a registered POC branch. Resolved here (the pure side) so the
      // run record freezes the branch this dispatch was actually aimed at, exactly as it freezes the brief.
      DELIVERY_BASE: deliveryBaseFor(item),
      // #4174 — ONLY `WE_ROOT` out of `raw.repoTokens`, unlike the repair branch above: none of these four
      // kinds' briefs reference `{{REPO}}`/`{{LANE_REPO}}`/`{{GATE_COMMAND}}`/`{{ATTRIBUTION}}`, and
      // `BRIEF_REQUIRED_BY_KIND` above validates/substitutes only the name each kind actually lists. Same
      // "`null`/missing is not papered over here" note as the repair branch: a missing `WE_ROOT` is caught by
      // `fillBrief`'s own required-value refusal, not by this file.
      WE_ROOT: raw.repoTokens && typeof raw.repoTokens === 'object' ? raw.repoTokens.WE_ROOT : undefined,
    };
  // FILLED HERE, not in the sink. The prompt is a pure function of the item and the core's assignment, so it
  // belongs on the pure side — and freezing it into the effect payload means the run record says exactly what
  // was dispatched, which is what a restart needs and a sink-side fill would not give.
  const brief = fillBrief(
    String(raw.briefTemplate ?? ''),
    values,
    BRIEF_REQUIRED_BY_KIND[launchKind],
    undefined,
    repairsExistingPr ? REPO_AWARE_VALUE_PATTERNS : undefined,
  );

  // #3717 — THE ROUTE THIS DISPATCH TAKES, in two halves on opposite sides of this file's purity line.
  //
  //   THE DERIVATION is HERE: `we:scripts/lib/dispatch-task-type.mjs#taskTypeFor` imports nothing, so the
  //   declaration keeps its "reaches nothing that can act" property. A dispatch whose `taskType` cannot be
  //   DERIVED is REFUSED with the derivation's own named reason — never routed on a default.
  //
  //   THE PROVIDER CHOICE is computed by the io shell (`dispatch-lane-io.mjs#readTick`) and arrives as DATA on
  //   `raw.routing`, because `decideDispatchRoute` reaches `node:fs` transitively. A read that carries no
  //   routing record (every hand-built fixture) dispatches with `routing: null`: the decision is absent, and the
  //   record says so rather than inventing one.
  const notRouted = (routing, holdReason) => ({
    ...base,
    inFlightRuns: [], agedOutRuns, dispatching: false, lane: null, sessionSlug: null, prompt: null,
    briefUnknownTokens: [], itemSpecPath: null, scope: [], dispatchedGuard: null, routing, holdReason,
  });
  const unsupportedLocus = launchKind === 'build' && raw.locus?.multiRepo
    ? { kind: 'unsupported-locus', keys: raw.locus.keys } : null;
  // Preserve the supported/legacy admission trace; this capability adds a refusal only.
  if (unsupportedLocus && blocked('locus', true, unsupportedLocus)) {
    return notRouted(null, `#${resolvedNum} has unsupported-locus: scope spans more than one repo `
      + `(${unsupportedLocus.keys.join(', ')}). Multi-repo delivery is unsupported; see #4289.`);
  }
  const derivedTaskType = taskTypeFor({ kind: launchKind, cause: null, scopePaths: scope });
  if (blocked('task-type', derivedTaskType.outcome === 'refused', derivedTaskType)) {
    return notRouted(null,
      `#${resolvedNum} has no mechanically derivable dispatch \`taskType\` — ${derivedTaskType.reason}. `
      + 'Refusing to spawn: #3717 requires the provider to be computed from declared criteria before launch, '
      + 'and a dispatch with no derivable `taskType` is refused rather than routed on a default.');
  }
  const routing = raw.routing && typeof raw.routing === 'object' ? raw.routing : null;
  if (blocked('route', routing?.outcome === 'refused', routing ? { outcome: routing.outcome, refusal: routing.refusal ?? null } : null)) {
    return notRouted(routing,
      `#${resolvedNum} has no mechanically computed dispatch route — ${routing.refusal}. Refusing to spawn: `
      + 'the provider is computed from declared criteria before launch, never chosen after it.');
  }
  // #3717 step 3 — the SUPERVISION GATE. `routing.supervisionHold` is non-null only when
  // `WE_DISPATCH_SUPERVISION_ENFORCE` is on, which it is NOT by default on main (#4180 owns that switch). With it
  // off this never holds and the dispatch is unchanged; the level is RECORDED either way.
  if (blocked('supervision', Boolean(routing?.supervisionHold), routing?.supervisionHold ?? null)) {
    return notRouted(routing, `#${resolvedNum} is held by the supervision gate — ${routing.supervisionHold}`);
  }
  return {
    ...base,
    dispatching: true,
    // THE COMPUTED ROUTE, frozen onto the read exactly as the filled brief is: the run record must say which
    // provider was CHOSEN and which one actually RAN (#3717 step 4). `taskType` is carried separately because
    // the DERIVATION runs here even when no provider decision arrived.
    routing,
    taskType: derivedTaskType.taskType,
    taskTypeOutcome: derivedTaskType.outcome,
    taskTypeReason: derivedTaskType.reason,
    lane: launch.lane,
    sessionSlug,
    itemSpecPath: specPath,
    scope,
    holdReason: null,
    inFlightRuns: [],
    // The records this dispatch went PAST. They are still `in-flight` on disk and still need closing out; the
    // verdict says so rather than letting an aged-out guard disappear silently.
    agedOutRuns,
    prompt: brief.prompt,
    // REPORTED, never fatal — see `fillBrief`. Two of these are the brief's own prose today.
    briefUnknownTokens: brief.unknownTokens,
    // THE PR THIS DISPATCH REPAIRS, and (CI-heal only) WHY — riding the `read` finding so the effect payload
    // (`dispatchLaneOperation`'s `dispatch` step) can carry them without re-deriving them from `launch` a
    // second time. `null` for build/prepare/prepare-decision, which never have a `launch.pr` to report.
    pr: launch.pr != null ? Number(launch.pr) : null,
    reason: launch.reason != null ? String(launch.reason) : null,
    // #3168 — see `KIND_DECLARES_OCCUPANCY_ON_DISPATCH`'s docblock for why this is a STATIC per-kind fact, not
    // something re-derived from the tick. Carried onto the finding on the one branch that actually dispatches,
    // so `plan`'s verdict and the effect payload below both see it without re-deriving it from `launchKind`.
    occupancyFailOpen: !KIND_DECLARES_OCCUPANCY_ON_DISPATCH[launchKind],
    occupancyWarning: KIND_DECLARES_OCCUPANCY_ON_DISPATCH[launchKind]
      ? null
      : occupancyFailOpenWarning(launchKind, launch.lane),
  };
}

/**
 * BUILD THE DECLARATION. `readTick` is the injected reader; {@link ./dispatch-lane-io.mjs} supplies the real
 * one and tests supply a stub. Built per call so nothing leaks between registries.
 *
 * @param {{readTick: (o: {num: string, bookkeepingFile: string, tickFile: string}) => object}} deps
 * @returns {object} the frozen declaration from `op()`.
 */
export function dispatchLaneOperation({ readTick } = {}) {
  if (typeof readTick !== 'function') {
    throw new TypeError(
      'dispatch-lane: needs a `readTick({num, bookkeepingFile})` reader — the io is INJECTED so the declaration '
      + 'stays testable without a lane pool or a live queue; the real binding is `we:scripts/operations/dispatch-lane-io.mjs`.',
    );
  }

  return op(DISPATCH_LANE_OP, {
    declaresOver: DECLARED_HOMES['dispatch-lane'],
    input: {
      // A STRING, not a number: an item id may be a `xNNNNNN` JIT hash, and the shell's `normNum` is what turns
      // either spelling into one identity.
      num: 'string',
      // The conveyor's live guard bookkeeping — the SESSION-EPHEMERAL `{ buildGuards, watched, … }` the tick
      // threads from tick to tick (`we:skills-src/conveyor/SKILL.md` §5). Passed as a FILE because it is the
      // runner's process state, not repo state: no parallel on-disk store is created by this operation, it only
      // reads whatever the caller already has. Omitted → the read runs with no in-flight guards, which the
      // finding reports as `bookkeepingSource: 'none'`.
      bookkeepingFile: { type: 'string', required: false, default: '' },
      // Optional recent tick from the caller, bound to the forwarded bookkeeping by its hash.
      tickFile: { type: 'string', required: false, default: '' },
      expectedWithinMinutes: { type: 'number', required: false, default: DEFAULT_EXPECTED_WITHIN_MINUTES },
      // #3857 — the ONE way a hand-set `--model` in `WE_DISPATCH_AGENT_ARGS` is honoured: the spawn point
      // (`dispatch-lane-io.mjs#resolveWorkerModel`) refuses it unless this reason rides the SAME call. Not
      // named `model`: that is a control flag of the command-line adapter.
      modelReason: { type: 'string', required: false, default: '' },
    },
    verdictFrom: 'plan',

    // ── 1. read ─────────────────────────────────────────────────────────────────────────────────────────────
    // ONE tick read, already selected for this num by the shell, shaped and turned into a filled brief.
    read: compute({
      reads: ['input.num', 'input.bookkeepingFile', 'input.tickFile', 'input.expectedWithinMinutes'],
      fn: (view) => shapeDispatchRead(
        readTick({ num: view.input.num, bookkeepingFile: view.input.bookkeepingFile, tickFile: view.input.tickFile }),
        { num: view.input.num, expectedWithinMinutes: view.input.expectedWithinMinutes },
      ),
    }),

    // ── 2. plan ─────────────────────────────────────────────────────────────────────────────────────────────
    // THE VERDICT, and it decides nothing: it restates what the tick core already decided, in the one shape the
    // effect step and every derived caller read. A non-dispatch is a first-class outcome here, not an error —
    // "the guard says an agent is already in flight" is the normal answer on most ticks.
    plan: compute({
      reads: ['findings.read'],
      fn: (view) => {
        const read = view.findings.read;
        const agedOut = Array.isArray(read.agedOutRuns) ? read.agedOutRuns : [];
        return {
          dispatching: read.dispatching === true,
          num: read.num,
          // WHICH AGENT WAS STARTED, beside the fact that one was (#3165). Without it a run record of a
          // prepare dispatch and one of a build are indistinguishable, and they are not the same event: they
          // run different briefs, take different lane scopes and are retired by different session slugs.
          launchKind: read.launchKind,
          lane: read.lane,
          sessionSlug: read.sessionSlug,
          reason: read.dispatching
            ? `cleared for ${read.launchKind} on lane ${read.lane}`
              + (agedOut.length
                ? ` (past ${agedOut.length} aged-out in-flight dispatch record(s): ${agedOut.map((r) => r.runId).join(', ')} — `
                  + 'each is still open on disk and still needs closing out)'
                : '')
            : read.holdReason,
          // THE GUARD'S OWN HONESTY, all three parts on the verdict where the decision is read:
          //   - `unreadableRunRecords` — how many run records the double-dispatch guard could not read at all;
          //   - `agedOutDispatches` — which in-flight records it deliberately dispatched past;
          //   - `dispatchLiveness` — whether those releases were decided on a real session listing or on the
          //     clock backstop, which is the difference between the strong guard and the weak one (G1).
          // Any one of them silently zeroed would make a partial guard look like a complete one.
          unreadableRunRecords: Number(read.unreadableRunRecords) || 0,
          agedOutDispatches: agedOut.map((r) => String(r.runId)),
          dispatchLiveness: read.dispatchLiveness,
          // SURFACED ON THE VERDICT, not buried in the read finding: a dispatch decided without the caller's
          // in-flight guards is weaker than one decided with them, and whoever reads the verdict is exactly who
          // needs to know that. `droppedBookkeeping` is here for the same reason — a setting the caller passed
          // and this run did not honour belongs where the decision is read, not in a comment.
          guardsFrom: read.bookkeepingSource,
          droppedBookkeeping: read.droppedBookkeeping,
          statusLine: read.statusLine,
          // #3168 — carried from `read` onto the VERDICT (not just the finding), because the verdict is what a
          // caller reading `run.verdict` sees and what the CLI's own non-JSON printer dumps in full (see
          // `cli-adapter.mjs`'s `verdict:` line) — the fail-open window must be visible there, not only in
          // `acquire`'s own stdout the dispatched agent will print later.
          occupancyFailOpen: read.occupancyFailOpen,
          occupancyWarning: read.occupancyWarning,
          // #3717 — THE ROUTE ON THE VERDICT, where the decision is read: `routed` is what the declared
          // criteria chose, `executed` the provider that can actually run it today.
          routing: read.routing ?? null,
          taskType: read.taskType ?? null,
        };
      },
    }),

    // ── 3. dispatch ─────────────────────────────────────────────────────────────────────────────────────────
    // DECLARES the start and performs none of it. One effect or zero — never two, because a lane holds one
    // agent and the whole guard apparatus exists to keep it that way.
    dispatch: effectStep({
      reads: ['verdict', 'findings.read', 'input.modelReason'],
      effects: (view) => {
        const verdict = view.verdict || {};
        // THE NON-DISPATCH EXIT. Zero effects, which the engine resolves in the same `advance` rather than
        // suspending — so a tick where the guard holds every item completes the run instead of parking it.
        if (!verdict.dispatching) return [];

        const read = view.findings.read;
        return [{
          type: DISPATCH_EFFECT,
          // DISPATCH: TRUE — the declaration says so BEFORE the sink runs (#3073). The executor writes
          // `in-flight` first, so a process killed between starting the agent and hearing its handle back lands
          // in `inFlightEntries().unknown` (visible, closable through `resolveInFlight`) rather than in
          // `pending`, where it would look like an ordinary unknown outcome and be invisible to both.
          dispatch: true,
          // IDEMPOTENT: FALSE, and this is the flag that matters most in this file. Re-applying it starts a
          // SECOND delivery agent on the same lane — two agents in one clone, racing on one working tree, both
          // opening a PR for one item. So an attempt whose outcome is unknown must stop and ask a person. The
          // cost of the fail-closed answer is a stalled run; the cost of the other is a corrupted lane.
          idempotent: false,
          payload: {
            num: read.num,
            launchKind: read.launchKind,
            lane: read.lane,
            sessionSlug: read.sessionSlug,
            itemSpecPath: read.itemSpecPath,
            scope: read.scope,
            // The filled brief, verbatim. It is what the agent is told, so a run record read after a restart
            // says exactly what was dispatched rather than "a brief was filled from a template that has since
            // been edited".
            prompt: read.prompt,
            expectedWithinMinutes: read.expectedWithinMinutes,
            // NOT BUILD/PREPARE-SHAPED ONLY (#3332): a `fix`/`ci-heal` payload also needs the PR it repairs —
            // and, for CI-heal, the reason it fired — so a run record read after a restart (or the durable
            // comment the fix briefs post) can say which PR this dispatch was FOR without re-deriving it from
            // the tick. `null` for build/prepare/prepare-decision, same as on `read`.
            pr: read.pr,
            reason: read.reason,
            // #3168 — carried onto the EFFECT PAYLOAD too, not just `read`/`verdict`: the payload is what the
            // sink (`we:scripts/operations/dispatch-lane-io.mjs#createDispatchSinks`) actually receives at the
            // moment it spawns the agent, and is where the sink prints the warning to its own stderr — the most
            // visible point in the whole path, live, at the exact moment the fail-open lane goes live.
            occupancyFailOpen: read.occupancyFailOpen,
            occupancyWarning: read.occupancyWarning,
            // #3717 — the computed route rides the payload so the RUN RECORD is where the routing decision, its
            // audit trail and the routed/executed pair are read back from; the sink reads its tier from here.
            routing: read.routing ?? null,
            taskType: read.taskType ?? null,
            // #3857 — carried to the spawn point so a hand-set `--model` is honoured only with a reason.
            modelReason: view.input?.modelReason || null,
          },
        }];
      },
    }),
  });
}

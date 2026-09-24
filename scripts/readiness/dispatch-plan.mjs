#!/usr/bin/env node
/**
 * @file scripts/readiness/dispatch-plan.mjs
 * @description The DETERMINISTIC DISPATCHER core of the conveyor (WE #x53zzf9, epic #xkggoo0). Given the build
 *   queue, the active scope leases, and the free lane slots, it decides — as JSON — what LAUNCHES where and what
 *   HOLDS (and why). This is the keystone the future product conveyor inherits: plateau's server will shell it
 *   exactly like its `/api/scope-lease` endpoint shells {@link ./scope-lease-collect.mjs} today (one
 *   implementation, two shells), per the statute
 *   [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment].
 *
 * PURE-CORE / IO-SHELL SPLIT (the hard design constraint, mirrored from the sibling scope-lease modules):
 *   • The PURE core ({@link dispatchPlan}) has NO fs / git / clock / child_process — the queue, the leases, and
 *     the free-lane list are all passed IN. It is unit-tested directly (scripts/readiness/__tests__/
 *     dispatch-plan.test.mjs) with plain objects, no git/network. It NEVER re-implements scope-overlap
 *     detection: it composes {@link ./scope-lease.mjs scopesOverlap} — the same prefix-aware intersection the
 *     scope-lease board and collector use.
 *   • The IO SHELL (the `main()` CLI, gated on the main-module check) gathers the three inputs by shelling the
 *     existing readiness scripts — {@link ../backlog.mjs backlog.mjs build-queue --json} for the ranked build
 *     queue, {@link ./scope-lease-collect.mjs scope-lease-collect --json} for the live leases, and
 *     {@link ../lane-pool.mjs lane-pool list --acquirable --json} for the free lanes — then calls the pure
 *     core and emits its plan. REUSE, never reinvent: the ordering engine, the scope collector, and the pool
 *     picker are each single-sourced; this shell only glues them.
 *
 * THE DISPATCH RULES (§ conveyor dispatcher). ONE pass over the queue in rank order (highest-priority first).
 * Each queued item resolves to exactly ONE outcome:
 *
 *   • openBlockers > 0                              → held "blocked"           (an unready item can't launch).
 *   • kind:epic / kind:feature (grouping kinds)      → held "needs-slice"       (a container — /slice it, never build; see below).
 *   • kind:decision                                 → held "needs-decision"    (not a build — prepare/present it; see below).
 *   • no usable scope (absent / non-array / [])     → held "unshaped-no-scope" (NEVER launched to build — see below).
 *   • scope intersects an ACTIVE lease's scope      → held "overlaps lane-<n>" (a running lane owns those paths).
 *   • scope intersects a HIGHER-RANKED item WE JUST  → held "overlaps lane-<n>" (the rival pair: the higher-ranked
 *     LAUNCHED this same tick (a rival pair)           of two mutually-overlapping queued items launches; the
 *                                                       lower-ranked one holds on the lane it was assigned).
 *   • otherwise (disjoint) — assign the next free   → launch { num, lane }     (rank order fills free lanes until
 *     lane; once the free lanes run out              the slots run out).
 *                                                    → held "no free lane"      (disjoint but nowhere to run).
 *                                                    → held "capacity-cap"      (disjoint, a free lane physically
 *                                                       exists, but launching it would exceed `maxConcurrentLanes`
 *                                                       — see below; a DIFFERENT reason from "no free lane" on
 *                                                       purpose, since the fix differs: raise the cap or wait, vs.
 *                                                       free a lane).
 *
 * CONCURRENCY CEILING (#xupukxa, live incident 2026-09-07 — freeing one lane cascaded into 42 concurrent lane
 * dispatches, 1-min load average 34.95 on a 12-core host). `maxConcurrentLanes` (default from
 * {@link ../lib/lane-concurrency.mjs resolveMaxConcurrentLanes}, `WE_MAX_CONCURRENT_LANES` env-overridable) caps
 * `freeLanes` against the ALREADY-ACTIVE lease count via {@link ../lib/lane-concurrency.mjs capToConcurrency}
 * BEFORE any assignment: `room = maxConcurrentLanes - leases.length`, so this dispatcher's OWN build launches
 * never alone exceed the ceiling. A SEPARATE, new admission point from
 * {@link ./heavy-admission.mjs} (#3461/#3456) — that caps concurrent HEAVY COMMANDS running INSIDE an
 * already-dispatched lane, never whether a lane is dispatched at all; this caps lane dispatch itself, upstream
 * of heavy-admission entirely. `tick-core.mjs#planTick` applies the SAME shared cap to its OWN
 * prepare/fix/ci-heal spawns (against `leases.length` PLUS this tick's admitted build launches), so the two
 * independent lane-consuming decisions share one budget rather than each maxing out the free-lane pool alone —
 * see its own header for that half. Defaults to unlimited (`Infinity`) when omitted, so every existing direct
 * caller of the pure core (tests included) keeps its prior unrestricted behavior unless it opts in.
 *
 * AUTO-PREPARE, NOT A SERIAL FLOOR (the corrected design, ruled 2026-07-22 — Nicolas). An UNSCOPED item (scope
 * ABSENT or EMPTY `[]`) is NEVER dispatched to build — not even alone into an idle pool. Building blind is exactly
 * the hazard the old "serial floor" reintroduced: the conveyor would build an item at the same moment it needed
 * scope authored for it, and an unscoped build is "assume-overlaps-everything" (it might touch ANY file). So the
 * dispatcher HOLDS every unscoped item `unshaped-no-scope` — always, even when the pool is fully idle and lanes
 * are free. That is the point: the /conveyor SKILL sees the held item (here and in `state.unshaped`) and dispatches
 * a lightweight PREPARE-SCOPE task that authors the item's `scope:` frontmatter; once that lands the item is scoped
 * and dispatches to BUILD on a later tick. Net effect: unscoped cleared item → auto-prepare (add scope) → then
 * build. The conveyor never builds without scope and never dispatches blind. An EMPTY scope reads identically to
 * absent — it is NOT a meaningful "touches nothing" build (every built item produces a lane diff), and this keeps
 * the pure core aligned with the loader (normalizeScope collapses [] → undefined) and check:standards (which ERRORS
 * on an empty scope). The operator gloss is UNSHAPED_HINT — "no predicted scope — author it to parallelize".
 * Precedence is exactly the listed order: a blocked item is blocked even with no scope; an unscoped item holds even
 * when a free lane exists; a lease/rival overlap holds a scoped item even when a free lane exists.
 *
 * Predicted `scope:` is authored UPSTREAM at readiness (prepare/shape time or the auto-prepare task above); the
 * dispatcher only READS it — it never probes for scope at dispatch and never launches an unscoped item to build
 * (scope authored at readiness; we:docs/agent/platform-decisions.md#state-lives-where-its-nature-dictates — being
 * codified in a sibling statute PR).
 */

import { scopesOverlap, normScope } from './scope-lease.mjs';
import { isGroupingKind } from '../check-standards-rules.mjs';
import { writeLineSync } from '../lib/write-all-sync.mjs';
import { capToConcurrency, resolveMaxConcurrentLanes } from '../lib/lane-concurrency.mjs';
// The kind-scoped pause's PURE half (epic #3383). `dispatch-pause.mjs`'s fs helpers stay out of this pure core
// — only the pure predicate/normalizer come in, so "is THIS kind held" is decided in ONE place rather than
// re-derived here and again in `tick-core.mjs`.
import { PAUSABLE_KINDS, normalizePausedKinds, resolvePausedKinds } from './dispatch-pause.mjs';
import { driftDefaults, findPocBranch, readRegistry } from '../lib/poc-branches.mjs';

// ── PURE CORE (no fs / git / clock / child_process — every input is injected) ─────────────────────────────────

/** The held-reason vocabulary the plan emits (the exact `reason` set #x53zzf9 specifies). `cleared-but-not-ready`
 *  is SHELL-emitted (#2613 review, required 2b): a sidecar id with no ready build-queue row — surfaced as a held
 *  entry so a clear never silently vanishes. The pure {@link dispatchPlan} itself never emits it (those items are
 *  not in its `queue` input); the IO shell appends them via {@link clearedNotReady}.
 *
 *  `unshaped-no-scope` (#2613 auto-prepare, ruled 2026-07-22): an item with no predicted `scope` is treated as
 *  "assume-overlaps-everything" and is NEVER launched to build — it is ALWAYS HELD `unshaped-no-scope` (even in a
 *  fully-idle pool with free lanes) and surfaced so the /conveyor skill auto-prepares its `scope:` upstream; once
 *  that lands the item is scoped and dispatches to BUILD. The operator gloss is fixed — "no predicted scope —
 *  author it to parallelize" ({@link UNSHAPED_HINT}); the reason TOKEN stays short for stable matching.
 *
 *  `needs-slice` (#2645): a cleared `kind:epic`. An epic is a CONTAINER — its work lives in child stories/tasks,
 *  so it is NEVER directly buildable and must never be launched to build (nor auto-prepared for scope, which would
 *  aim a build agent at a container). The dispatcher HOLDS every cleared epic `needs-slice` — a FIRST-CLASS
 *  outcome, not a silent skip — so the /conveyor skill surfaces it for `/slice` (decompose into buildable child
 *  stories, which dispatch on later ticks). A cleared epic is a slice TRIGGER, not a dead end; the operator gloss
 *  is {@link NEEDS_SLICE_HINT}.
 *
 *  `needs-decision` (#2647): a cleared `kind:decision`. A decision is NOT build work — its lifecycle is
 *  prepare (research + author its forks to "ready to ratify", the /prepare skill's autonomous half) then present
 *  (surface the prepared forks for a human to ratify). A decision has no `scope:`, so — exactly like the epic
 *  case — it is held BEFORE the scope gate so it is not mislabeled `unshaped-no-scope` and aimed at a scope-
 *  prediction agent (which authors a build touch-set, meaningless for a decision). The dispatcher HOLDS every
 *  cleared decision `needs-decision` — a FIRST-CLASS outcome — so the /conveyor skill drives it per its prepared
 *  state (`state.decisions[].prepared`): UNPREPARED → spawn a prepare-decision agent; PREPARED → present its forks
 *  (artefact + the ruling surface) for ratification. The operator gloss is {@link NEEDS_DECISION_HINT}.
 *
 *  `needs-investigation` (#3567): a cleared `kind:investigation`. An investigation is NOT build work either —
 *  it is a single dispatched investigator (investigate -> synthesize -> report, optionally filing children),
 *  never a two-phase prepare/present lifecycle the way a decision is. It has no `scope:`, so — same reason as
 *  the decision case just above — it is held BEFORE the scope gate rather than mislabeled `unshaped-no-scope`.
 *  UNLIKE a decision, there is no `prepared` flag to wait on: `we:scripts/conveyor/tick-core.mjs`'s `planTick`
 *  spawns every `needs-investigation` hold directly (`spawnInvestigations`) the same tick it clears. The
 *  operator gloss is {@link NEEDS_INVESTIGATION_HINT}.
 *
 *  `already-done` (#3457/#3460): a queued item the IO shell's AGE-GATED ground-truth enrichment found a real
 *  merged PR already closing out (Fork 2(b) of #3457's ratified ruling). Checked FIRST, ahead of every other
 *  branch — see {@link dispatchPlan}'s own step 0 for why a real PR-history signal outranks a stale `blocked` /
 *  `needs-slice` / `needs-decision` / scope read, all of which are themselves derived from the same possibly-
 *  stale `status:`/frontmatter this check exists to stop trusting blind. HOLDS, never auto-resolves — the shell
 *  never mutates the item's frontmatter on this item's own say-so (see `filterAlreadyDoneCandidates`'s docblock
 *  in `we:scripts/operations/dispatch-lane-io.mjs` for the false-positive residual this leaves recoverable). The
 *  operator gloss is {@link ALREADY_DONE_HINT}.
 *
 *  `branch-drift-blocked` (#3464): a queued item whose scope overlaps a long-lived dispatched-work branch's
 *  (e.g. `lane/mechanical-dispatcher`) own unreconciled, blocked drift — `we:scripts/conveyor/branch-drift.mjs`'s
 *  latest `check` verdict is `blocked` (a dry-run merge conflicts, or the branch sits past its reconciliation
 *  ceiling) AND this item's scope overlaps the drifting branch's own live scope. This is the concrete guard
 *  #3464's incident named: two independently-scoped, individually-correct dispatch streams (this pool's `main`
 *  dispatch, and the branch's own out-of-band one) piling MORE changes onto the same hot files while nothing
 *  reconciles them, until the eventual merge becomes unresolvable. HOLDS — it never auto-reconciles the branch;
 *  it only pauses NEW same-scope dispatch until a fresh sweep clears it. The operator gloss is
 *  {@link BRANCH_DRIFT_BLOCKED_HINT}. A GRADUATION SLICE is exempt (#3836, statute
 *  `we:docs/agent/platform-decisions.md#poc-branch-mechanical-sync` point 4): an item whose `parent` is the
 *  drifting branch's registered `graduationItem` (`we:scripts/lib/poc-branches.json`) lands on `main` in its own
 *  PR, porting files as diffs onto `main`'s current tree, so it never piles onto the unreconciled branch.
 *
 *  `dispatch-paused` (#3609): a MANUAL/EMERGENCY kill-switch, distinct from every reason above — those are all
 *  properties of the ITEM (its own readiness, scope, or a scope conflict); this is a deliberate OPERATOR
 *  override that holds every item that would otherwise have launched, regardless of what it is or what scope it
 *  touches. Set/cleared via `we:scripts/readiness/dispatch-pause.mjs` (`set|clear|status`); checked last, only
 *  at the point an item would actually be assigned a lane — an item held for any OTHER reason (blocked,
 *  needs-slice, needs-decision, unshaped-no-scope, an overlap, already-done, branch-drift-blocked) keeps that
 *  more specific reason, since the pause changes nothing about why THAT item wasn't launching anyway. Never
 *  touches an already-running lane — this pure core has no lease/lane-release knowledge at all. The operator
 *  gloss is {@link DISPATCH_PAUSED_HINT}. */
export const HELD_REASONS = Object.freeze([
  'already-done', 'blocked', 'unshaped-no-scope', 'no-size', 'needs-slice', 'needs-decision', 'needs-investigation', 'branch-drift-blocked', 'no free lane', 'capacity-cap', 'overlaps lane-<n>', 'cleared-but-not-ready', 'dispatch-paused',
]);

/** The operator-facing gloss for an `unshaped-no-scope` hold — surfaced beside the token in the CLI and the
 *  conveyor skill so a held unshaped item always tells the operator WHAT to do: author the item's predicted
 *  `scope:` (the /conveyor skill auto-prepares it) so the dispatcher can BUILD and parallelize it. */
export const UNSHAPED_HINT = 'no predicted scope — author it to parallelize';

/** The operator-facing gloss for a `no-size` hold (#3801 Fork 4 (b), #3849 admission) — surfaced beside the
 *  token so a held item always tells the operator WHAT to do: author the item's size (a story's Fibonacci
 *  `size:`) or estimate (a task's `estimatedLoc:`); the /conveyor skill auto-prepares it, the SAME prepare-scope
 *  agent that authors `scope:` (`we:scripts/operations/prepare-scope-wrapper.mjs`, #3842). Only surfaced under
 *  `unsizedCardPolicy: 'block'` — see {@link HELD_REASONS} and `dispatchPlan`'s own `sizePolicy` input. */
export const NO_SIZE_HINT = 'no declared size/estimate — prepare will author one';

/** The operator-facing gloss for a `needs-slice` hold — surfaced beside the token so a held epic always tells the
 *  operator WHAT to do: decompose it (`/slice <num>`) into buildable child stories, which the conveyor then
 *  dispatches. An epic is a container, never a direct build. */
export const NEEDS_SLICE_HINT = 'epic — /slice into buildable child stories';

/** The operator-facing gloss for a `needs-decision` hold (#2647) — surfaced beside the token so a held decision
 *  always tells the operator WHAT the conveyor does with it: an UNPREPARED decision gets its forks prepared
 *  (research + author to "ready to ratify"); a PREPARED one has its forks PRESENTED for a human to ratify. A
 *  decision is never a build. The reason TOKEN stays short (`needs-decision`) for stable matching; the
 *  prepared/unprepared split that routes prepare-vs-present is carried in `state.decisions[].prepared`. */
export const NEEDS_DECISION_HINT = 'decision — prepare its forks, then present for ratify';

/** The operator-facing gloss for a `needs-investigation` hold (#3567) — surfaced beside the token so a held
 *  investigation always tells the operator WHAT the conveyor does with it: it is spawned directly
 *  (`spawnInvestigations`), one dispatched agent, no separate prepare/present phase the way a decision has.
 *  An investigation is never a build. */
export const NEEDS_INVESTIGATION_HINT = 'investigation — dispatched to investigate, synthesize, and report';

/** The operator-facing gloss for an `already-done` hold (#3457/#3460) — surfaced beside the token so a held
 *  item always tells the operator WHAT to do: check the named merged PR, and if it really does close the item
 *  out, `resolve` it (rather than re-dispatching); if the check false-positived (see
 *  `we:scripts/operations/dispatch-lane-io.mjs#filterAlreadyDoneCandidates`), clear it back into the queue by
 *  hand. Never auto-actioned — a human/agent call, not a mechanical one. */
export const ALREADY_DONE_HINT = 'a merged PR already appears to close this out — verify, then resolve or re-clear';

/** The operator-facing gloss for a `branch-drift-blocked` hold (#3464) — surfaced beside the token so a held
 *  item always tells the operator WHAT to do: a long-lived dispatched-work branch's own reconciliation sweep
 *  found a conflict/ceiling breach against the SAME scope this item wants to touch; reconcile the branch (or
 *  wait for the next sweep to clear it), then re-dispatch. */
export const BRANCH_DRIFT_BLOCKED_HINT = 'a dispatched-work branch is unreconciled over this scope — reconcile it, then re-dispatch';

/** The operator-facing gloss for a `dispatch-paused` hold (#3609) — surfaced beside the token so a held item
 *  always tells the operator WHAT to do: clear the manual pause (`node scripts/readiness/dispatch-pause.mjs
 *  clear`) once the emergency has passed; already-running lanes were never touched. */
export const DISPATCH_PAUSED_HINT = 'manual dispatch-pause is set — clear it (dispatch-pause.mjs clear) to resume new launches';

/**
 * The gloss for a `dispatch-paused` hold, NARROWED to the kinds a SCOPED pause actually holds (epic #3383).
 * A blanket pause keeps {@link DISPATCH_PAUSED_HINT} verbatim — the wording an operator already knows, and the
 * only wording an old-format marker can produce. A scoped pause names the held kinds instead, so the hint never
 * claims "dispatch is paused" flatly while `fix`/`ci-heal` are demonstrably still spawning.
 * @param {string[]|null} [pausedKinds] the marker's declared scope (`null`/absent = blanket)
 * @returns {string}
 */
export function dispatchPausedHint(pausedKinds = null) {
  const kinds = normalizePausedKinds(pausedKinds);
  if (kinds == null || kinds.length === PAUSABLE_KINDS.length) return DISPATCH_PAUSED_HINT;
  return `manual dispatch-pause is set for ${kinds.join(', ')} — clear it (dispatch-pause.mjs clear) to resume new launches`;
}

/** The operator-facing gloss for a `capacity-cap` hold (#xupukxa) — surfaced beside the token so a held item
 *  always tells the operator WHY it differs from `no free lane`: a lane physically exists, but launching it
 *  would exceed `maxConcurrentLanes`. Nothing to reconcile or clear — either raise `WE_MAX_CONCURRENT_LANES`
 *  (a deliberate, per-machine judgment call) or wait for an active lane to free up. */
export const CAPACITY_CAP_HINT = 'a free lane exists but launching it would exceed the concurrent-lane cap — raise WE_MAX_CONCURRENT_LANES or wait for a lane to free up';

/**
 * How old (ms) an item's `open`/`active` age must be before the IO shell spends a `gh pr list --search` call
 * checking whether a real merged PR already closes it out (#3457/#3460, Fork 2(b)'s age-gated enrichment).
 *
 * WHY A GATE AT ALL, restated from the ruling: an unconditional per-tick, per-item `gh pr list` call does not
 * scale (Fork 2's rejected option (a)) and duplicates the rate-limit risk `we:scripts/operations/
 * dispatch-lane-io.mjs`'s own `PR_LIST_TIMEOUT_MS`/`PR_LIST_LIMIT` already designed around. A freshly-opened
 * or freshly-claimed item cannot yet have a merged PR from BEFORE it existed, so checking it costs a real `gh`
 * call for zero possible signal.
 *
 * 2 HOURS, chosen over the conveyor's own build estimate (`DEFAULT_EXPECTED_WITHIN_MINUTES = 90` in
 * `we:scripts/operations/dispatch-lane.mjs`) plus a margin: an item younger than one full build cycle is
 * vanishingly unlikely to already have independent completing work landed and unnoticed, while 2 hours still
 * keeps the "bounded delay" Fork 2(b) promises well inside a single operator session. Env-overridable, same
 * pattern as `PR_LIST_TIMEOUT_ENV` — a policy knob, not a magic number nothing can retune.
 */
export const ALREADY_DONE_AGE_GATE_MS = 2 * 60 * 60 * 1000;

/** The env var that overrides {@link ALREADY_DONE_AGE_GATE_MS}. Unset or non-numeric → the default applies. */
export const ALREADY_DONE_AGE_GATE_ENV = 'WE_DISPATCH_PLAN_ALREADY_DONE_AGE_MS';

/**
 * Is `item` OLD ENOUGH to be worth an already-done ground-truth `gh` call? PURE — the clock and the threshold
 * both arrive as parameters, so this is directly unit-testable and the IO shell supplies the real ones.
 *
 * FAILS TOWARD CHECKING on an unparseable/absent date, not away from it: a `dateOpened`/`dateStarted` this
 * function cannot read is a malformed or unusual item, not evidence the item is fresh, and the cost of one
 * extra `gh` call for a rare malformed row is far smaller than the cost of a stale item that never gets
 * checked because its own date was unreadable. Prefers `dateStarted` (when the item is `active`, that is the
 * more honest "how long has real work been outstanding" clock) and falls back to `dateOpened`.
 *
 * @param {{dateOpened?: string|null, dateStarted?: string|null}} item
 * @param {number} nowMs - `Date.now()`-shaped instant, injected so this stays clock-free.
 * @param {number} [ageGateMs] - defaults to {@link ALREADY_DONE_AGE_GATE_MS}.
 * @returns {boolean}
 */
/** The default drift-watched branch + its own live scope (#3464) — the SAME repo-qualified form `scope:`
 *  frontmatter and lease scopes already use, so it compares directly via `scopesOverlap`. Matches
 *  `we:scripts/conveyor/branch-drift.mjs`'s own `DEFAULT_DRIFT_BRANCH`/`DEFAULT_DRIFT_TARGET` — and since #3637
 *  both are DERIVED from the same registry rather than separately declared here, so the two can no longer
 *  drift apart (they had, silently, which is what made this a latent bug). Overridable via
 *  `--drift-scope=<repo:path,...>` for a future second long-lived branch, or `--no-drift-check` to skip the
 *  check entirely (mirrors `--no-ground-truth`). */
// #3637 — all three now DERIVE from `we:scripts/lib/poc-branches.json`, the single place a POC branch is
// declared, instead of being a second independent copy of `branch-drift.mjs`'s own constants. That duplication
// was a latent bug (a change to one never reached the other) that #3637's survey found and named. `--drift-*`
// still overrides every one of them, and the "future second long-lived branch" the comment above anticipated
// is now simply a second registry entry.
const DRIFT_DEFAULTS = driftDefaults();
export const DEFAULT_DRIFT_BRANCH = DRIFT_DEFAULTS.branch;
export const DEFAULT_DRIFT_TARGET = DRIFT_DEFAULTS.target;
export const DEFAULT_DRIFT_SCOPE = DRIFT_DEFAULTS.scope;

export function isStaleEnoughForGroundTruth(item, nowMs, ageGateMs = ALREADY_DONE_AGE_GATE_MS) {
  const at = Date.parse(String(item?.dateStarted || item?.dateOpened || ''));
  if (Number.isNaN(at)) return true; // no usable date — cannot prove it is fresh, so do not skip it blind
  const gate = Number(ageGateMs) >= 0 ? Number(ageGateMs) : ALREADY_DONE_AGE_GATE_MS;
  return (Number(nowMs) || Date.now()) - at > gate;
}

/** True when an item's `openBlockers` signals it is not ready to build. Tolerant of either the loader's array
 *  shape (`item.openBlockers` = the still-open blocker nums) or a bare count. */
function hasOpenBlockers(item) {
  const ob = item?.openBlockers;
  if (Array.isArray(ob)) return ob.length > 0;
  if (typeof ob === 'number') return ob > 0;
  return false;
}

/**
 * The DETERMINISTIC dispatch plan — the pure keystone. Same (queue, leases, freeLanes) → same plan, always.
 *
 * @param {{
 *   queue: Array<{num:(string|number), kind?:string, parent?:(string|number), scope?:string[], openBlockers?:(string[]|number), alreadyDonePr?:(object|null)}>,
 *   leases: Array<{lane:(string|number), scope:string[]}>,
 *   freeLanes: Array<string|number>,
 *   driftBlockedScope?: string[]|null,
 *   driftGraduationItem?: string|null,
 *   maxConcurrentLanes?: number,
 *   dispatchPaused?: boolean,
 *   dispatchPausedKinds?: string[]|null,
 * }} input
 *   • `queue`     — the build queue ALREADY IN RANK ORDER (highest-priority first): the `buildQueued` items.
 *                   Each carries its `kind` (so a `kind:epic` container is held `needs-slice` and a `kind:decision`
 *                   is held `needs-decision` — neither is ever built), its
 *                   predicted `scope` (repo-relative path prefixes, comparable to the leases' scopes), its
 *                   `openBlockers`, and its `alreadyDonePr` (#3457/#3460 — the AGE-GATED ground-truth
 *                   enrichment's evidence, or `null`/absent when not checked or nothing found; see
 *                   `we:scripts/operations/dispatch-lane-io.mjs#filterAlreadyDoneCandidates` for the query and
 *                   `isStaleEnoughForGroundTruth` for the age gate). The pure core does NOT re-order — the
 *                   ordering engine ({@link ../lib/build-queue.mjs orderQueueDetailed}) owns rank; this
 *                   consumes that order.
 *   • `leases`    — the ACTIVE scope leases (running lanes): `{ lane, scope }`. `scope` is the lane's held
 *                   file-scope (predicted ∪ observed, from {@link ./scope-lease-collect.mjs}).
 *   • `freeLanes` — the free lane slots, as an array of lane IDS to assign (from `lane-pool list --acquirable`).
 *                   The "free lane-slot COUNT" the spec names is exactly `freeLanes.length`; the ids let a
 *                   launch carry the concrete `lane` it lands on. (Ids, not a bare count, because the plan's
 *                   `launch` must name a real lane — the same lane ids the "overlaps lane-<n>" holds reference.)
 *   • `driftBlockedScope` — (#3464) the drifting scope of a long-lived dispatched-work branch currently
 *                   `blocked` (a dry-run merge conflict, or past its reconciliation ceiling), or `null`/absent
 *                   when no branch is currently blocked (the common case, and the fail-open default when the
 *                   IO shell's drift check itself fails). A scoped item overlapping this holds
 *                   `branch-drift-blocked`, checked ahead of the lease/rival overlap gates — see
 *                   {@link BRANCH_DRIFT_BLOCKED_HINT}.
 *   • `driftGraduationItem` — (#3836) the drifting branch's registered `graduationItem` (e.g. `"3443"`), or
 *                   `null`/absent when none is registered. A queued item whose `parent` equals it is a
 *                   GRADUATION SLICE and is exempt from the `branch-drift-blocked` hold (statute
 *                   `#poc-branch-mechanical-sync` point 4); absent, nothing is exempt.
 *   • `maxConcurrentLanes` — (#xupukxa) the global lane-dispatch concurrency ceiling; `freeLanes` is trimmed
 *                   against `leases.length` via {@link ../lib/lane-concurrency.mjs capToConcurrency} before any
 *                   assignment. Defaults to `Infinity` (unlimited — today's pre-#xupukxa behavior) when
 *                   omitted; the IO shell resolves a real default via
 *                   {@link ../lib/lane-concurrency.mjs resolveMaxConcurrentLanes}. An item that would otherwise
 *                   launch but is trimmed away by this holds `capacity-cap`, distinct from `no free lane`.
 *   • `dispatchPaused` — (#3609) the MANUAL/EMERGENCY dispatch-pause lever's current state
 *                   (`we:scripts/readiness/dispatch-pause.mjs#isDispatchPaused`). When true, every item that
 *                   would otherwise be assigned a lane holds `dispatch-paused` instead — checked at the very
 *                   last step, so it never relabels an item already held for a MORE specific reason. Defaults
 *                   to `false` (unpaused — today's pre-#3609 behavior) when omitted.
 *   • `dispatchPausedKinds` — (epic #3383) the pause's optional KIND SCOPE
 *                   (`we:scripts/readiness/dispatch-pause.mjs`'s `pausedKinds` field, read by the IO shell).
 *                   `null`/absent = BLANKET, so a caller passing only `dispatchPaused: true` — every caller
 *                   written before the scope existed, and every old-format marker — still holds builds exactly
 *                   as before. A NON-EMPTY scope holds builds only when it names `build`: a pause scoped to
 *                   `fix`/`ci-heal` alone leaves this core's launches untouched, since `build` is the ONLY
 *                   kind it plans (the other five are `tick-core.mjs#planTick`'s spawns).
 *   • `sizePolicy` — (#3801 Fork 4 (b), #3849 admission) the checked-in `we:scripts/lib/dispatch-size-policy.json`
 *                   setting, ALREADY VALIDATED by the IO shell (`validateSizePolicy` in
 *                   `we:scripts/lib/dispatch-contracts.mjs` — kept OUT of this pure core's own imports, since it
 *                   transitively reaches `node:fs` via `provider-routing.mjs`). `null`/absent (the default) skips
 *                   the size gate ENTIRELY — today's pre-#3849 behavior, unlimited/unrestricted, so every existing
 *                   direct caller of the pure core (tests included) keeps dispatching an unsized item exactly as
 *                   before unless it opts in — same "off unless supplied" default as `maxConcurrentLanes`/
 *                   `dispatchPaused`. When supplied with `unsizedCardPolicy: 'block'`, a scoped `build` item (any
 *                   `kind` other than `fix`/`ci-heal`, which take the separate `fixSizeSource` chain and are never
 *                   held here) with no declared size — a story's `size:` absent, or a task's `estimatedLoc:`
 *                   absent/invalid — holds `no-size` instead of launching, checked right after the scope gate (a
 *                   READINESS gate, not a lane-scheduling concern, same precedence class as `unshaped-no-scope`).
 *                   Any OTHER `unsizedCardPolicy` (`default-size`) never holds on this axis — the item is admitted
 *                   normally and its `launch` entry carries `sized: <boolean>` (only ever added when `sizePolicy`
 *                   is supplied) so an assumed-size launch is never indistinguishable from a declared one. A
 *                   `deliveryAgent:` marker never bypasses this hold (#3801 Fork 5) — this core reads no such
 *                   field, so there is nothing to bypass.
 * @returns {{ launch: Array<{num, lane, sized?:boolean}>, held: Array<{num, reason:string}> }}
 *   `launch` — the SCOPED items to start now, each on the free lane it was assigned, in rank order. An UNSCOPED
 *              item is NEVER launched (it is held `unshaped-no-scope` for the skill to auto-prepare). `sized` is
 *              present only when `sizePolicy` was supplied — `true` when the item declared its own size/estimate,
 *              `false` when it launched on the `default-size` fallback.
 *   `held`   — every other queued item with its single reason ∈ {@link HELD_REASONS}.
 */
export function dispatchPlan({ queue, leases, freeLanes, driftBlockedScope, driftGraduationItem, maxConcurrentLanes = Infinity, dispatchPaused = false, dispatchPausedKinds = null, sizePolicy = null, trace = false } = {}) {
  // The pause is per-KIND now, and this core only ever decides ONE kind: `build`. Resolving the marker's
  // declared scope through the shared predicate (rather than reading the raw boolean) is what makes an
  // old-format `{paused:true}` — and every caller that still passes only the boolean — keep holding builds,
  // while `--kinds=fix` alone leaves builds launching.
  const buildPaused = resolvePausedKinds({ paused: dispatchPaused === true, pausedKinds: dispatchPausedKinds }).includes('build');
  const items = Array.isArray(queue) ? queue.filter((it) => it && typeof it === 'object') : [];
  const activeLeases = (Array.isArray(leases) ? leases : [])
    .filter((l) => l && typeof l === 'object')
    .map((l) => ({ lane: l.lane ?? null, scope: normScope(l.scope) }));
  // #xupukxa — trim the free-lane list against the concurrency ceiling BEFORE any assignment, using the
  // ALREADY-ACTIVE lease count this function already computed above. `overflow` is non-empty exactly when a
  // physical free lane exists but the ceiling withheld it — the signal that distinguishes `capacity-cap` from
  // a genuine `no free lane` below.
  const { admitted, overflow } = capToConcurrency(freeLanes, { activeCount: activeLeases.length, cap: maxConcurrentLanes });
  const free = [...admitted]; // consumed front-to-back, rank order
  const capacityLimited = overflow.length > 0;
  const driftScope = normScope(driftBlockedScope); // [] when absent/null — scopesOverlap against [] is always false
  const graduationItem = String(driftGraduationItem ?? '').trim(); // '' → no item is a graduation slice

  const launch = [];
  const held = [];
  const admission = [];
  const launched = []; // { num, lane, scope } — SCOPED items launched THIS tick, for the rival-pair check

  // ── ONE pass over the queue in rank order. An unscoped item is NEVER launched (auto-prepare, not a serial
  //    floor): it is held `unshaped-no-scope` for the /conveyor skill to prepare its scope upstream. ──
  for (const item of items) {
    const num = item.num;
    const gates = [];
    if (trace) admission.push({ num, gates });
    const blocked = (name, condition, observed) => {
      if (trace) gates.push({ name, pass: !condition, observed });
      return condition;
    };

    // 0. GROUND TRUTH (#3457/#3460) — a real merged PR already closes this item out. Checked FIRST, ahead of
    //    every other branch: `blocked`, `needs-slice`, `needs-decision` and the scope/overlap reads below are
    //    ALL themselves derived from the same possibly-stale `status:`/frontmatter this check exists to stop
    //    trusting blind (#3434's own motivating incident carried `kind: decision`, i.e. it would otherwise have
    //    been held `needs-decision` — a real merged PR outranks that read too). `item.alreadyDonePr` is set by
    //    the IO shell's AGE-GATED enrichment (Fork 2(b)); the pure core performs no `gh` call of its own and
    //    simply trusts what it was handed, same as every other enrichment field on `item`. HOLDS, never
    //    auto-resolves — see `ALREADY_DONE_HINT` and `we:scripts/operations/dispatch-lane-io.mjs`'s
    //    `filterAlreadyDoneCandidates` docblock for why a false positive here must stay recoverable.
    if (blocked('already-done', !!item.alreadyDonePr, item.alreadyDonePr ?? null)) {
      held.push({ num, reason: 'already-done' });
      continue;
    }

    // 1. Structurally not ready — an open prerequisite gates the build regardless of scope / slots.
    //    NOTE: via the production build-queue shell this branch is UNREACHABLE — `backlog.mjs build-queue`
    //    emits only READY items (isReady requires every blockedBy resolved), so their openBlockers is always
    //    []. It is kept as defense-in-depth for DIRECT core use (a future shell that feeds an unfiltered queue)
    //    and is pinned by the unit tests below. Checked FIRST for every item, scoped or not.
    if (blocked('blockedBy', hasOpenBlockers(item), { openBlockers: item.openBlockers ?? [], blockedBy: item.blockedBy ?? [] })) {
      held.push({ num, reason: 'blocked' });
      continue;
    }
    // 2. A cleared GROUPING kind (`epic`, or `feature` — #2998 epic-parity) — HOLD `needs-slice`, ALWAYS
    //    (#2645). A grouping kind is a CONTAINER; its work lives in children (an epic's stories/tasks, a
    //    feature's epics), so it is NEVER directly buildable. Checked BEFORE the scope gate so an (almost
    //    always scope-less) container is not mislabeled `unshaped-no-scope` and auto-prepared — that would
    //    aim a build agent at a container, the exact hazard this branch exists to prevent. A cleared
    //    grouping item is a slice TRIGGER: the /conveyor skill sees this hold and surfaces it for `/slice`
    //    (decompose into buildable children, which dispatch on later ticks), rather than silently stalling
    //    it. A BLOCKED grouping item is still `blocked` (checked first): it can't be sliced until its
    //    blockers clear. `isGroupingKind` (scripts/check-standards-rules.mjs) is the single source of truth
    //    for the grouping-kind set, shared with conveyor-state.mjs, so a future grouping kind needs one
    //    update, not several scattered `kind === 'epic'` checks.
    if (blocked('grouping-kind', isGroupingKind(item.kind), item.kind ?? null)) {
      held.push({ num, reason: 'needs-slice' });
      continue;
    }
    // 3. A cleared `kind:decision` — HOLD `needs-decision`, ALWAYS (#2647). A decision is NOT build work; its
    //    lifecycle is prepare (research + author its forks) then present (surface the prepared forks to ratify).
    //    Checked BEFORE the scope gate for the SAME reason the epic branch is: a decision carries no `scope:`, so
    //    without this it would fall through to the scope gate and be mislabeled `unshaped-no-scope` — aiming a
    //    scope-prediction (build touch-set) agent at an item that has no build. A cleared decision is a
    //    prepare/present TRIGGER: the /conveyor skill reads this hold (and `state.decisions`) and routes by the
    //    decision's prepared state — UNPREPARED → spawn a prepare-decision agent; PREPARED → present its forks.
    //    A BLOCKED decision is still `blocked` (checked first): it can't be prepared until its blockers clear.
    if (blocked('decision-kind', item.kind === 'decision', item.kind ?? null)) {
      held.push({ num, reason: 'needs-decision' });
      continue;
    }
    // 3.5. A cleared `kind:investigation` (#3567) — HOLD `needs-investigation`, ALWAYS. Analogous to the
    //    decision branch just above: an investigation is never build work, so it is held BEFORE the scope
    //    gate for the same reason a decision is — it carries no `scope:` at all, and without this branch it
    //    would fall through to the scope gate and be mislabeled `unshaped-no-scope`. UNLIKE a decision, an
    //    investigation has no separate prepare/present phase: `we:scripts/conveyor/tick-core.mjs`'s `planTick`
    //    reads every `needs-investigation` hold straight off THIS `held` list and spawns it directly
    //    (`spawnInvestigations`) the same tick it clears — a single dispatched investigator, not a two-phase
    //    prepare-then-ratify lifecycle. A BLOCKED investigation is still `blocked` (checked first).
    if (item.kind === 'investigation') {
      held.push({ num, reason: 'needs-investigation' });
      continue;
    }
    // 4. No predicted scope — HOLD `unshaped-no-scope`, ALWAYS. An unscoped item is NEVER launched to build, not
    //    even alone into an idle pool (auto-prepare, ruled 2026-07-22): building blind is the hazard, and an
    //    unscoped build is "assume-overlaps-everything". The skill sees this hold (and `state.unshaped`) and
    //    dispatches a prepare-scope task that authors the item's `scope:`; once that lands the item is scoped and
    //    dispatches to BUILD on a later tick. An ABSENT, non-array, OR EMPTY scope all read as undeclared (see the
    //    file header): [] is not a meaningful "touches nothing" build, so it is treated identically to absent.
    //    Keying on the NORMALIZED scope's emptiness catches all four (undefined / non-array / [] / all-blank).
    const scope = normScope(item.scope);
    if (blocked('scope', scope.length === 0, scope)) {
      held.push({ num, reason: 'unshaped-no-scope' });
      continue;
    }

    // 4.4. NO DECLARED SIZE, under `unsizedCardPolicy: 'block'` (#3801 Fork 4 (b), #3849 admission) — HOLD
    //    `no-size`. Checked right after the scope gate (a scope-held item keeps that more specific reason) and
    //    BEFORE the drift/lease/rival/pause scheduling gates below: like `unshaped-no-scope`, this is a
    //    READINESS gate (is the item buildable at all), not a lane-scheduling concern — it holds regardless of
    //    what lane/overlap state exists. `sizePolicy` is `null` by default (this axis is OFF unless the IO shell
    //    supplies a validated policy — see this function's own docblock), so every direct caller that does not
    //    opt in dispatches an unsized item exactly as before #3849. `fix`/`ci-heal` are EXEMPT (defense-in-depth
    //    — neither `kind` can actually reach this queue via the production build-queue shell, which only ever
    //    carries backlog `kind`s; they take the separate `fixSizeSource` chain in `decideDispatchRoute`, never
    //    this admission gate). A `task` is sized by its own `estimatedLoc:` (points would double-count the
    //    burndown, #3839); every other kind (a story, or an unrecognized/missing `kind`) is sized by `size:`.
    //    A `deliveryAgent:` marker never bypasses this — nothing here reads it (#3801 Fork 5).
    const sizeExempt = item.kind === 'fix' || item.kind === 'ci-heal';
    const hasDeclaredSize = item.kind === 'task'
      ? Number.isInteger(item.estimatedLoc) && item.estimatedLoc > 0
      : item.size !== undefined && item.size !== null;
    if (sizePolicy && !sizeExempt && !hasDeclaredSize && sizePolicy.unsizedCardPolicy === 'block') {
      held.push({ num, reason: 'no-size' });
      continue;
    }

    // 4.5. Overlaps a currently-BLOCKED long-lived dispatched-work branch's own drifting scope (#3464) — that
    //    branch is carrying unreconciled changes over these paths; piling MORE independently-scoped work onto
    //    them is exactly what turned #3464's own incident into an unresolvable conflict. Hold until a fresh
    //    `branch-drift.mjs sweep` clears it. Checked before the lease/rival gates — same "blanket hold, not a
    //    lane-scheduling concern" precedence as the checks above. A GRADUATION SLICE (a child of the branch's
    //    registered `graduationItem`) is exempt (#3836): it lands on `main` in its own PR, not on the branch.
    const graduationSlice = graduationItem !== '' && String(item.parent ?? '').trim() === graduationItem;
    if (blocked('branch-drift', driftScope.length > 0 && !graduationSlice && scopesOverlap(scope, driftScope), { scope, driftScope, graduationSlice })) {
      held.push({ num, reason: 'branch-drift-blocked' });
      continue;
    }

    // 5. Overlaps a RUNNING lane's held scope — that lane owns those paths; hold behind it.
    const leaseHit = activeLeases.find((l) => scopesOverlap(scope, l.scope));
    if (blocked('scope-overlap-lease', !!leaseHit, { scope, lease: leaseHit ?? null })) {
      held.push({ num, reason: `overlaps lane-${leaseHit.lane}` });
      continue;
    }
    // 6. Rival pair — overlaps a HIGHER-RANKED item already launched this tick. Rank order guarantees the
    //    higher-ranked rival was processed first and (if it launched) sits in `launched`, so the lower-ranked
    //    one holds on the lane its rival took. A higher rival that did NOT launch is absent here, so it never
    //    spuriously blocks a lower item — the hold is only against work that is actually starting.
    const rival = launched.find((r) => scopesOverlap(scope, r.scope));
    if (blocked('scope-overlap-rival', !!rival, { scope, rival: rival ?? null })) {
      held.push({ num, reason: `overlaps lane-${rival.lane}` });
      continue;
    }
    // 6.5. MANUAL DISPATCH-PAUSE (#3609) — the item is otherwise launchable (every gate above passed); a
    //    deliberate operator kill-switch holds it here instead of assigning a lane. Checked LAST, only at the
    //    point a lane would actually be handed out, so it never relabels an item already held for a more
    //    specific reason above (blocked / needs-slice / needs-decision / unshaped-no-scope / branch-drift-blocked
    //    / an overlap) — pausing changes nothing about why those items weren't launching anyway.
    //    A KIND-SCOPED pause (epic #3383) that does not name `build` never reaches here at all: this core's
    //    only launch kind is `build`, so a `fix`/`ci-heal`-only pause leaves this gate open and the item
    //    launches normally (the scoped kinds are held in `tick-core.mjs`, which owns those spawns).
    if (blocked('dispatch-paused', buildPaused, buildPaused)) {
      held.push({ num, reason: 'dispatch-paused' });
      continue;
    }
    // 7. Disjoint — launch it on the next free lane, or hold for want of one. `capacity-cap` (#xupukxa) fires
    //    instead of `no free lane` when a physical free lane exists but the concurrency ceiling withheld it —
    //    a DIFFERENT reason on purpose, since the remedy differs (raise the cap / wait vs. free a lane).
    if (blocked('lane-capacity', free.length === 0, { freeLanes: [...free], capacityLimited })) {
      held.push({ num, reason: capacityLimited ? 'capacity-cap' : 'no free lane' });
      continue;
    }
    const lane = free.shift();
    // `sized` is added only when `sizePolicy` was supplied AND the item is subject to this admission gate at
    // all (see the gate above and this function's own docblock) — an untouched `{num, lane}` shape for every
    // direct caller that never opted in, and for an exempt `fix`/`ci-heal` (its size comes from the separate
    // `fixSizeSource` chain in `decideDispatchRoute`, never this gate's `hasDeclaredSize` read).
    launch.push(sizePolicy && !sizeExempt ? { num, lane, sized: hasDeclaredSize } : { num, lane });
    launched.push({ num, lane, scope });
  }

  return { launch, held, ...(trace ? { admission } : {}) };
}

/**
 * Select the CLEARED build-queue rows, in the engine's rank order, by SESSION-LOCAL sidecar MEMBERSHIP (#2613).
 * The conveyor's cleared set is `.conveyor/queue.json` (session-local operator intent), NOT committed
 * `buildQueued` frontmatter — so a row is kept IFF its num is in `clearedKeys` (a set of NORMALIZED ids). The
 * ranked ORDER still comes from the build-queue engine (the rows are already ranked); only membership moved to
 * the sidecar. A committed `buildQueued:true` row that is NOT in the sidecar is dropped; a sidecar item that is
 * ranked is kept. `norm` is injected (queue-store's `normNum`) so this stays import-clean (no node built-ins in
 * the pure core) and directly unit-testable. Pure.
 * @param {Array<{num:*}>} rows  the ranked build-queue rows (`backlog.mjs build-queue --json` `.queue`)
 * @param {Set<string>|Iterable<string>} clearedKeys  the sidecar's ids, normalized via `norm`
 * @param {(n:*)=>string} norm  the id normalizer (queue-store `normNum`)
 * @returns {Array<{num:*}>} the cleared rows, rank order preserved
 */
export function selectClearedRows(rows, clearedKeys, norm, observe = null) {
  const cleared = clearedKeys instanceof Set ? clearedKeys : new Set(clearedKeys);
  const key = typeof norm === 'function' ? norm : (x) => String(x);
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r) return false;
    const pass = cleared.has(key(r.num));
    observe?.(r.num, { name: 'queue-membership', pass, observed: { cleared: pass } });
    return pass;
  });
}

/**
 * `--queue-file` contents → build-queue-shaped rows, in the file's order (#3720). PURE. The file is a JSON array of
 * item ids (string, number, or `{num}`); a repeat keeps its first position. Anything else throws.
 * @param {string} text
 * @param {(n:*)=>string} norm
 * @returns {Array<{num:string}>}
 */
export function queueFileRows(text, norm) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new TypeError('queue file must be a JSON array of item ids');
  const seen = new Set();
  const rows = [];
  for (const entry of list) {
    const num = String(entry && typeof entry === 'object' ? entry.num : entry ?? '').trim();
    if (!num || seen.has(norm(num))) continue;
    seen.add(norm(num));
    rows.push({ num });
  }
  return rows;
}

/**
 * The CLEARED-BUT-NOT-READY set (#2613 review, required 2b): the sidecar entries whose id has NO ready
 * build-queue row. `build-queue --json .queue` is hard-filtered to READY items, so a cleared id that is
 * blocked / resolved / a typo / nonexistent lands in the sidecar but never in `rows` — without this it would
 * appear in NEITHER `launch` NOR `held`, a silent vanish (the exact "I cleared it, nothing happened" failure
 * #2613 kills). This returns each such id (in its stored spelling, for display) so the shell can surface it as
 * `held: {num, reason:'cleared-but-not-ready'}`. Pure — `norm` injected to stay import-clean.
 * @param {Array<{num:*}|string|number>} clearedEntries  the sidecar entries (`{num, addedAt}`) or bare ids
 * @param {Array<{num:*}>} readyRows  the ready build-queue rows
 * @param {(n:*)=>string} norm  the id normalizer (queue-store `normNum`)
 * @returns {Array<*>} the cleared ids with no ready row, original spelling preserved
 */
export function clearedNotReady(clearedEntries, readyRows, norm, observe = null) {
  const key = typeof norm === 'function' ? norm : (x) => String(x);
  const ready = new Set((Array.isArray(readyRows) ? readyRows : []).map((r) => key(r?.num)));
  return (Array.isArray(clearedEntries) ? clearedEntries : [])
    .map((e) => (e && typeof e === 'object' ? e.num : e))
    .filter((n) => {
      if (n == null || String(n) === '') return false;
      const pass = ready.has(key(n));
      observe?.(n, { name: 'readiness', pass, observed: { inReadyBuildQueue: pass } });
      return !pass;
    });
}

/** Env twin of `--free-lanes=` (#x7xv2xt). The flag wins when both are set. */
export const FREE_LANES_ENV = 'WE_DISPATCH_FREE_LANES';

/**
 * Parse an explicit free-lane list (`--free-lanes=3,1,7` / `WE_DISPATCH_FREE_LANES`) — #x7xv2xt. Returns `null`
 * when no list was given (the shell then reads the real pool), or the lane ids ascending. An empty string is a
 * real answer: "no free lanes". Non-integer tokens are dropped.
 *
 * @param {string|boolean|undefined|null} raw
 * @returns {number[]|null}
 */
export function parseFreeLanes(raw) {
  if (raw == null || raw === false) return null;
  if (raw === true) return [];
  return String(raw).split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number)
    .sort((a, b) => a - b);
}

// ── IO SHELL (runs only as a CLI — owns all child_process; keeps the pure core import-clean) ──────────────────

// Lazily required so importing the pure core pulls in NO node built-ins beyond scope-lease.mjs.
async function main(argv) {
  const { runBounded, installChildReaper, resolveChildTimeoutMs } = await import('../lib/bounded-child.mjs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const HERE = dirname(fileURLToPath(import.meta.url));
  const BACKLOG_CLI = join(HERE, '..', 'backlog.mjs');
  const SCOPE_COLLECT_CLI = join(HERE, 'scope-lease-collect.mjs');
  const LANE_POOL_CLI = join(HERE, '..', 'lane-pool.mjs');

  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const log = (m) => process.stderr.write(m + '\n');
  const fail = (m) => { process.stderr.write(`✗ ${m}\n`); process.exit(1); };

  // #x7xv2xt — every child call is bounded by a timeout, runs in its own process group, and dies with this
  // process (exit, signal, or this process being orphaned). It used to be a bare `execFileSync` with no timeout,
  // which left test-spawned runs scanning the real lane pool for an hour after vitest had died.
  installChildReaper({ log });
  const childTimeoutMs = resolveChildTimeoutMs(process.env);
  const runJson = async (cmd, args, what) => {
    let out;
    try {
      out = await runBounded(cmd, args, { timeoutMs: childTimeoutMs });
    } catch (e) {
      fail(`${what} failed: ${String(e.message || e).split('\n')[0]}`);
    }
    try { return JSON.parse(out); }
    catch (e) { fail(`could not parse ${what} JSON: ${String(e.message || e).split('\n')[0]}`); }
  };

  // #x7xv2xt — FIXTURE MODE never touches the real lane pool. `--backlog-dir` means "a synthetic corpus", so the
  // shared pool (`lane-pool.mjs list --acquirable`, `scope-lease-collect.mjs`) is off-limits: free lanes come
  // from `--free-lanes=` / `WE_DISPATCH_FREE_LANES` (none given → no free lanes) and the lease set is empty. An
  // explicit free-lane list without `--backlog-dir` replaces only the pool's free-lane read. With neither, the
  // behavior is exactly what it was.
  const fixtureMode = typeof flags['backlog-dir'] === 'string';
  const freeLanesFlag = flags['free-lanes'] !== undefined ? flags['free-lanes'] : process.env[FREE_LANES_ENV];
  const freeLanesOverride = parseFreeLanes(freeLanesFlag);

  // Compare scopes on a repo-RELATIVE basis: strip a leading `<key>:` repo qualifier (a token with no slash
  // before the colon) from every entry so a lease's `we:scripts/x` / `web-everything.git:scripts/x` and an
  // item's plain `scripts/x` compare equal. Cross-repo same-path collisions are negligible for the WE
  // machinery paths this dispatcher orders; the pure core stays string-agnostic (this normalization is a
  // shell concern only).
  const toRepoRelative = (list) =>
    (Array.isArray(list) ? list : []).map((p) => String(p).replace(/^[^/:]+:/, ''));

  // 1. THE BUILD QUEUE — reuse the ranking engine wholesale (backlog.mjs build-queue --json) for the exact
  //    next-to-build ORDER + tier/score enrichment, but MEMBERSHIP of the cleared set now comes from the
  //    SESSION-LOCAL conveyor sidecar (`.conveyor/queue.json`, #2613), NOT committed `buildQueued` frontmatter.
  //    Clearing an item for build is session-local operator INTENT, so it rides a gitignored sidecar the lane
  //    guard does not police (the operator clears work from the MAIN session, which the frontmatter path
  //    blocks). An item is in the conveyor queue IFF its num is in the sidecar; committed `buildQueued` no
  //    longer arms a conveyor build. Enrich each with its predicted `scope` + `openBlockers` from the backlog
  //    loader (build-queue doesn't emit them). Dynamic-import keeps the pure core import-clean.
  const { readQueueFile, resolveQueuePath, normNum } = await import('../conveyor/queue-store.mjs');
  // `--queue-file=<json>` (#3720, land-advance's item-pull): membership AND order come from the caller's list (epic
  // #3383's Priority order), not the sidecar + build-queue ranking. Every hold below still applies unchanged; the
  // `blocked` branch is what gates an unready item here, since this path skips build-queue's ready filter.
  const queueFile = typeof flags['queue-file'] === 'string' ? flags['queue-file'] : null;
  const sidecar = queueFile ? [] : readQueueFile(resolveQueuePath()); // script-location + env override — matches conveyor-state
  const cleared = new Set(sidecar.map((e) => normNum(e.num)));
  // `--backlog-dir` (#3445) points this read (and, via `WE_BACKLOG_DIR` below, the byNum enrichment require
  // just past it) at a fixture corpus instead of the live `backlog/` directory — the dispatcher-fixture-root
  // thread (#3402).
  const bqArgs = ['build-queue', '--json'];
  if (typeof flags['backlog-dir'] === 'string') {
    bqArgs.push(`--backlog-dir=${flags['backlog-dir']}`);
    process.env.WE_BACKLOG_DIR = flags['backlog-dir'];
  }
  let rows;
  let bqRows = [];
  let observeSelection;
  const selection = new Map(); // stays empty in --queue-file mode: that path never runs the sidecar/cleared-set selection this observes
  if (queueFile) {
    const { readFileSync } = await import('node:fs');
    try { rows = queueFileRows(readFileSync(queueFile, 'utf8'), normNum); }
    catch (e) { fail(`could not read --queue-file ${queueFile}: ${String(e.message || e).split('\n')[0]}`); }
  } else {
    const bq = await runJson('node', [BACKLOG_CLI, ...bqArgs], 'backlog build-queue');
    bqRows = Array.isArray(bq?.queue) ? bq.queue : [];
    observeSelection = (num, gate) => {
      const key = normNum(num);
      if (!selection.has(key)) selection.set(key, { num: key, gates: [] });
      selection.get(key).gates.push(gate);
    };
    rows = selectClearedRows(bqRows, cleared, normNum, observeSelection);
  }
  // Cleared-but-not-ready: sidecar ids with no ready build-queue row — surfaced as held entries below, never
  // silently dropped (#2613 review, required 2b).
  const notReady = clearedNotReady(sidecar, bqRows, normNum, observeSelection);
  let byNum = new Map();
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const loadBacklog = require(join(HERE, '..', '..', 'src', '_data', 'backlog.js'));
    const items = typeof loadBacklog === 'function' ? loadBacklog() : [];
    byNum = new Map(items.map((it) => [String(it.num), it]));
  } catch (e) {
    log(`  ⚠ could not load backlog for scope/openBlockers enrichment (${String(e.message || e).split('\n')[0]}) — items read as unshaped (no scope → held unshaped-no-scope, auto-prepared)`);
  }
  const queue = rows.map((r) => {
    const it = byNum.get(String(r.num));
    return {
      num: r.num,
      // `kind` drives the epic → `needs-slice` hold (#2645): a container is never built. Absent when the loader
      // failed to load (the catch above) — then it reads as non-epic and falls through to the scope gate, a SAFE
      // degradation (an unscoped epic still holds `unshaped-no-scope` rather than launching to build).
      kind: it?.kind,
      // `parent` marks a graduation slice (#3836): a child of the drifting branch's `graduationItem` is exempt
      // from the `branch-drift-blocked` hold.
      parent: it?.parent,
      scope: Array.isArray(it?.scope) ? toRepoRelative(it.scope) : undefined,
      openBlockers: Array.isArray(it?.openBlockers) ? it.openBlockers : [],
      // #3849 — the size-gate's own inputs: a story's Fibonacci `size:`, a task's `estimatedLoc:` (#3839).
      // Absent when the loader failed to load (safe degradation — reads as unsized under `block`, held
      // `no-size` rather than launching blind on an unmeasured number).
      size: it?.size,
      estimatedLoc: it?.estimatedLoc,
    };
  });

  // 1.5 ALREADY-DONE GROUND TRUTH (#3457/#3460, Fork 2(b)) — AGE-GATED enrichment: only items that have sat
  //     `open`/`active` past `ALREADY_DONE_AGE_GATE_MS` spend a `gh pr list --search` call, so the common case
  //     (a freshly-cleared or freshly-claimed item) never pays for a check that could not possibly find
  //     anything yet. Reuses the SAME checker + query shape `we:scripts/operations/dispatch-lane.mjs`'s
  //     pre-spawn guard uses (`defaultCheckAlreadyDone` in `we:scripts/operations/dispatch-lane-io.mjs`), so
  //     the two #3457/#3460 chokepoints can never disagree about what "done" means. Covers BOTH populations
  //     the sidecar can put an item in: a normal ready `queue` row, AND a `cleared-but-not-ready` id (#2613) —
  //     the exact shape a RESOLVED item stuck in `.conveyor/queue.json` takes (`build-queue --json` hard-
  //     filters to not-yet-resolved rows, so a resolved-but-still-cleared item never reaches `queue` at all;
  //     see this file's own header and #3460's live acceptance case). Skipped entirely when `--no-ground-truth`
  //     is passed (mirrors the sibling session-reaper fix's own rollback escape hatch) or `gh` cannot run.
  // `notReady` id (normalized, string-keyed) → the merged PR the ground-truth pass found for it, when it did.
  // Kept separate from `queue` rows because a `cleared-but-not-ready` id has no row of its own to carry a
  // field on — it is appended to `plan.held` as a bare id further down, past `dispatchPlan` itself.
  const alreadyDoneNotReady = new Map();
  if (!flags['no-ground-truth']) {
    const { defaultCheckAlreadyDoneAsync } = await import('../operations/dispatch-lane-io.mjs');
    const nowMs = Date.now();
    const staleQueueRows = queue.filter((row) => isStaleEnoughForGroundTruth(byNum.get(String(row.num)), nowMs));
    const staleNotReadyIds = notReady.filter((id) => isStaleEnoughForGroundTruth(byNum.get(String(id)), nowMs));
    // CONCURRENT, not sequential (epic #3383, live incident 2026-09-04) — a plain `for` loop paid one `gh pr
    // list` round-trip PER stale id, one at a time; with the queue at 69 entries (most past the 2h age gate)
    // that pushed a single dispatch-plan tick past 60-140s, starving the conveyor runner's own ~120s tick
    // budget. `defaultCheckAlreadyDoneAsync` uses `execFile` (non-blocking) instead of `execFileSync`, so
    // every stale id's round-trip now runs in parallel. Same fail-soft contract, same query shape, same
    // matcher — only the concurrency changed.
    const [queueVerdicts, notReadyVerdicts] = await Promise.all([
      Promise.all(staleQueueRows.map((row) => defaultCheckAlreadyDoneAsync(row.num))),
      Promise.all(staleNotReadyIds.map((id) => defaultCheckAlreadyDoneAsync(id))),
    ]);
    staleQueueRows.forEach((row, i) => {
      const verdict = queueVerdicts[i];
      if (verdict.done && verdict.pr) row.alreadyDonePr = verdict.pr;
    });
    staleNotReadyIds.forEach((id, i) => {
      const verdict = notReadyVerdicts[i];
      if (verdict.done && verdict.pr) alreadyDoneNotReady.set(String(id), verdict.pr);
    });
  }

  // 2. THE ACTIVE LEASES — reuse the live scope-lease collector. Each lease's held scope = predicted ∪ observed.
  //    Fixture mode (#x7xv2xt) skips it: a synthetic corpus has no real leases.
  const picture = fixtureMode ? { leases: [] } : await runJson('node', [SCOPE_COLLECT_CLI, '--json'], 'scope-lease-collect');
  const leases = (Array.isArray(picture?.leases) ? picture.leases : []).map((l) => ({
    lane: l.lane,
    scope: toRepoRelative([...(l.predicted || []), ...(l.observed || [])]),
  }));

  // 3. THE FREE LANES — reuse the pool's own acquirable picker. `list --acquirable --json` = the free lane
  //    dirs; the lane id is the trailing `lane-<n>`. Their COUNT is the free-slot count. An explicit list, or
  //    fixture mode, replaces the pool read entirely (#x7xv2xt).
  let freeLanes;
  if (freeLanesOverride !== null) freeLanes = freeLanesOverride;
  else if (fixtureMode) freeLanes = [];
  else {
    const paths = await runJson('node', [LANE_POOL_CLI, 'list', '--acquirable', '--json'], 'lane-pool list');
    freeLanes = (Array.isArray(paths) ? paths : [])
      .map((p) => { const m = /lane-(\d+)\/?$/.exec(String(p)); return m ? Number(m[1]) : null; })
      .filter((n) => n != null)
      // Ascending lane order is a SHELL contract: the pure core assigns launches to freeLanes in the order
      // given, so sorting here makes the plan's lane assignment deterministic regardless of how `lane-pool
      // list --acquirable` happens to order its output (removes the dependency on the pool's listing stability).
      .sort((a, b) => a - b);
  }

  // 3.5 BRANCH-DRIFT CEILING (#3464) — read the latest `branch-drift.mjs check` verdict for the watched
  //     long-lived dispatched-work branch. FAIL-OPEN on any error (module missing, no report yet, git failure)
  //     — an absent/unreadable drift signal must never itself hold dispatch; only an explicit `blocked` verdict
  //     does. Skippable via `--no-drift-check` (mirrors `--no-ground-truth`).
  let driftBlockedScope = null;
  let driftGraduationItem = null;
  if (!flags['no-drift-check']) {
    try {
      const DRIFT_CLI = join(HERE, '..', 'conveyor', 'branch-drift.mjs');
      const branch = typeof flags['drift-branch'] === 'string' ? flags['drift-branch'] : DEFAULT_DRIFT_BRANCH;
      const target = typeof flags['drift-target'] === 'string' ? flags['drift-target'] : DEFAULT_DRIFT_TARGET;
      const scope = typeof flags['drift-scope'] === 'string' ? flags['drift-scope'].split(',').filter(Boolean) : [...DEFAULT_DRIFT_SCOPE];
      // #3637 — no branch to check (an EMPTY POC-branch registry and no `--drift-branch=`) means there is
      // nothing carrying unreconciled drift, so there is nothing to hold on. Skip rather than shelling out
      // with a `null` branch name and relying on the fail-open catch to clean it up.
      if (!branch) throw new Error('no POC branch registered and no --drift-branch given — nothing to check');
      const out = await runBounded('node', [DRIFT_CLI, 'check', `--branch=${branch}`, `--target=${target}`, '--json'], { timeoutMs: childTimeoutMs });
      const verdict = JSON.parse(out);
      if (verdict?.status === 'blocked') {
        driftBlockedScope = scope;
        // #3836 — the blocked branch's registered graduation item; its children are graduation slices, exempt
        // from the hold. An unregistered `--drift-branch=` has none, so nothing is exempt.
        driftGraduationItem = findPocBranch(readRegistry(), branch)?.graduationItem ?? null;
      }
    } catch (e) {
      log(`  ⚠ branch-drift check skipped (${String(e.message || e).split('\n')[0]}) — dispatch proceeds unheld on this axis`);
    }
  }

  // 3.6 MANUAL DISPATCH-PAUSE (#3609) — read the operator's advisory pause marker. FAIL-OPEN on any error
  //     (module missing, unreadable/corrupt file) — an absent/unreadable pause signal must never itself hold
  //     dispatch; only an explicit `paused:true` marker does. Skippable via `--no-pause-check` (mirrors
  //     `--no-ground-truth` / `--no-drift-check`).
  //     Reads the FULL state rather than the bare `isDispatchPaused` boolean, so a kind-scoped marker's
  //     `pausedKinds` reaches the pure core (and the operator hint) instead of being flattened to "paused".
  let dispatchPaused = false;
  let dispatchPausedKinds = null;
  if (!flags['no-pause-check']) {
    try {
      const { readPauseState } = await import('./dispatch-pause.mjs');
      const pauseState = readPauseState();
      dispatchPaused = pauseState.paused === true;
      dispatchPausedKinds = pauseState.pausedKinds ?? null;
    } catch (e) {
      log(`  ⚠ dispatch-pause check skipped (${String(e.message || e).split('\n')[0]}) — dispatch proceeds unheld on this axis`);
    }
  }

  // 3.7 THE SIZE POLICY (#3801 Fork 4 (b), #3849 admission) — read + VALIDATE the checked-in
  //     `we:scripts/lib/dispatch-size-policy.json` setting via the SAME reader/validator #3843 wired into
  //     `decideDispatchRoute` (`defaultReadSizePolicy` / `validateSizePolicy`), dynamically imported here (never
  //     at module scope — that would pull `node:fs` transitively into this pure core's import graph via
  //     `dispatch-contracts.mjs` → `dispatch-thresholds.mjs` → `provider-routing.mjs`). FAIL-OPEN on any read/
  //     validate error, mirroring `--no-drift-check` / `--no-pause-check` above: an absent/unreadable/invalid
  //     policy must never itself hold dispatch, so `sizePolicy` stays `null` (the pure core's own "gate off"
  //     default) rather than risk stalling every build on a malformed setting file. Skippable via
  //     `--no-size-check`.
  let sizePolicy = null;
  if (!flags['no-size-check']) {
    try {
      const { defaultReadSizePolicy } = await import('../operations/dispatch-lane-io.mjs');
      const { validateSizePolicy } = await import('../lib/dispatch-contracts.mjs');
      const result = validateSizePolicy(defaultReadSizePolicy());
      if (result.ok) sizePolicy = result.policy;
      else log(`  ⚠ size-policy check skipped (${result.errors.join('; ')}) — dispatch proceeds unheld on this axis`);
    } catch (e) {
      log(`  ⚠ size-policy check skipped (${String(e.message || e).split('\n')[0]}) — dispatch proceeds unheld on this axis`);
    }
  }

  // #xupukxa — the concurrency ceiling, env-overridable exactly like heavy-admission.mjs's own cap knob.
  const maxConcurrentLanes = resolveMaxConcurrentLanes(process.env);
  const plan = dispatchPlan({ queue, leases, freeLanes, driftBlockedScope, driftGraduationItem, maxConcurrentLanes, dispatchPaused, dispatchPausedKinds, sizePolicy, trace: true });
  // Surface cleared-but-not-ready ids as held entries so a clear never silently vanishes (#2613 review, 2b).
  // #3457/#3460: a `notReady` id the ground-truth pass above CONFIRMED already done (the exact `#3435` live
  // shape — a RESOLVED item whose sidecar clear was never removed) is surfaced as `already-done`, naming the
  // merged PR, instead of the generic `cleared-but-not-ready` — turning "silently listed with no reason" into
  // "here is the PR that already closed this out; remove the stale clear or verify by hand".
  for (const num of notReady) {
    const pr = alreadyDoneNotReady.get(String(num));
    plan.held.push(pr ? { num, reason: 'already-done', alreadyDonePr: pr } : { num, reason: 'cleared-but-not-ready' });
  }

  // Membership/readiness evidence comes from the selection above, including cleared
  // entries which never reached the pure build planner.
  plan.selection = [...selection.values()];
  const notReadyKeys = new Set(notReady.map(normNum));
  plan.cleared = sidecar.map((entry) => ({
    num: normNum(entry.num),
    ready: !notReadyKeys.has(normNum(entry.num)),
  }));
  // #x7xv2xt — say where the pool inputs came from whenever they did NOT come from the real pool, so a caller
  // (and the fixture harness test) can see it. Absent on a normal run, which keeps that output unchanged.
  if (fixtureMode || freeLanesOverride !== null) {
    plan.lanePool = {
      freeLanes: freeLanesOverride !== null ? 'explicit' : 'fixture-empty',
      leases: fixtureMode ? 'fixture-empty' : 'lane-pool',
    };
  }
  if (flags.json) {
    // Drain synchronously before exit — `process.stdout.write` is async to a pipe and the `process.exit(0)`
    // below would drop the unflushed tail, truncating this JSON for an `execFileSync`/pipe consumer (exactly
    // `tick-core.mjs`'s own `runJson`, which crossed this size for the first time in #3460's enrichment).
    // `writeLineSync` is remedy (b) from `scripts/lib/write-all-sync.mjs` — keeps the exit, since it's shared
    // with the non-JSON branch below.
    writeLineSync(1, JSON.stringify(plan, null, 2));
  } else {
    log(
      `dispatch plan: ${plan.launch.length} launch · ${plan.held.length} held ` +
        `(${queue.length} queued · ${leases.length} lease(s) · ${freeLanes.length} free lane(s) · ` +
        `cap ${maxConcurrentLanes} concurrent lane(s))`,
    );
    for (const l of plan.launch) log(`  ▶ #${l.num} → lane-${l.lane}`);
    for (const h of plan.held) {
      // Surface the operator gloss beside the short token so a held item always says WHAT to do — author scope
      // for `unshaped-no-scope` (#2613), `/slice` for a held `needs-slice` epic (#2645), prepare/present a
      // held `needs-decision` (#2647), or check + resolve/re-clear an `already-done` hold (#3457/#3460).
      const hint = h.reason === 'unshaped-no-scope' ? ` (${UNSHAPED_HINT})`
        : h.reason === 'no-size' ? ` (${NO_SIZE_HINT})`
        : h.reason === 'needs-slice' ? ` (${NEEDS_SLICE_HINT})`
          : h.reason === 'needs-decision' ? ` (${NEEDS_DECISION_HINT})`
            : h.reason === 'already-done' ? ` (${ALREADY_DONE_HINT}${h.alreadyDonePr?.url ? ` — ${h.alreadyDonePr.url}` : ''})`
              : h.reason === 'branch-drift-blocked' ? ` (${BRANCH_DRIFT_BLOCKED_HINT})`
              : h.reason === 'capacity-cap' ? ` (${CAPACITY_CAP_HINT})`
                : h.reason === 'dispatch-paused' ? ` (${dispatchPausedHint(dispatchPausedKinds)})`
                  : '';
      log(`  ⏸ #${h.num} — ${h.reason}${hint}`);
    }
  }
  process.exit(0);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2));
}

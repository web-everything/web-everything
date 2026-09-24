#!/usr/bin/env node
/**
 * @file scripts/conveyor/tick-core.mjs
 * @description The MECHANIZED CONVEYOR TICK CORE (WE #2699, epic #2677(a)). ONE pure function
 *   ({@link planTick}) that turns a tick's read-only inputs — the {@link ../readiness/conveyor-state.mjs
 *   conveyor-state} read, the {@link ../readiness/dispatch-plan.mjs dispatch plan}, the free-lane ids, and the
 *   conveyor's in-session guard/watcher bookkeeping — into the tick's MECHANICAL decisions (which agents to
 *   spawn, which watchers to arm, which guards to retire, whether to idle-stop, and the status line) PLUS the
 *   next bookkeeping state. It mechanizes the deterministic per-tick orchestration the /conveyor SKILL
 *   (we:skills-src/conveyor/SKILL.md §2–3) previously re-derived in prose: chain state-read → dispatch-plan,
 *   filter launches through the in-flight / prepare / fix guards, arm watchers, retire guards on
 *   claim / return / TTL / PR-terminal / re-dispatch-gate, and idle-stop. The SKILL now only EXECUTES the
 *   returned decisions (spawn the agents, arm the watchers, post the line) and carries `nextState` into the next
 *   tick — it never re-derives a guard rule in prose.
 *
 *   Scripted per [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment] (#2607): every
 *   script-decidable rule of the tick — the three guards and their retirement, watcher arming, idle-stop — is a
 *   deterministic, tested core; the JUDGMENT the SKILL keeps (the readiness discussion, supervising a build,
 *   reviewing an escalation, ratifying a decision) stays out of here. Same inputs → same plan, always.
 *
 * PURE-CORE / IO-SHELL SPLIT (the hard design constraint, mirrored from dispatch-plan.mjs + conveyor-state.mjs):
 *   • The PURE core ({@link planTick} and every helper above the shell banner) has NO fs / git / `Date` /
 *     child_process / gh — the state read, the plan, the free lanes, the bookkeeping, and the clock (`now`) are
 *     all passed IN. It is unit-tested directly (scripts/conveyor/__tests__/tick-core.test.mjs) with plain
 *     objects, no git/network. Two imports, both pure: `normNum` from {@link ./queue-store.mjs} — the SAME id
 *     normalizer the state read and dispatcher key on, so this core can never disagree with them on item
 *     identity — and {@link ../lib/lane-concurrency.mjs} — the SAME concurrency-ceiling helper
 *     `dispatch-plan.mjs` uses for its own build launches (#xupukxa), so the two lane-consuming decisions this
 *     core makes (prepare/fix/ci-heal spawns) share one budget with dispatch-plan's builds rather than each
 *     independently maxing out the free-lane pool.
 *   • The IO SHELL (the `main()` CLI, gated on the main-module check) gathers the read-only inputs by shelling
 *     the existing readiness scripts — `conveyor-state.mjs --json`, `dispatch-plan.mjs --json`, and
 *     `lane-pool.mjs list --acquirable --json` for the free lanes — reads the conveyor's bookkeeping from STDIN
 *     (it is SESSION-EPHEMERAL process state, never a committed repo store — memory rule 105 / SKILL §5), calls
 *     the pure core, and emits `{ decisions, nextState }`. The SKILL pipes its current bookkeeping in and carries
 *     the emitted `nextState` to the next tick IN-SESSION — no parallel on-disk state store is ever created.
 *
 * THE THREE GUARDS — mechanized here EXACTLY as the SKILL documents them (their semantics are UNCHANGED; this
 * only moves the derivation from prose to a tested core):
 *
 *   1. IN-FLIGHT DISPATCH GUARD (build). One `{ num, lane, spawnedTick }` entry per spawned delivery agent.
 *      {@link filterLaunches} drops a `plan.launch` entry whose `num` OR whose assigned `lane` matches a LIVE
 *      guard entry — the contended resource is the LANE, not just the item, so BOTH must exclude (else tick N
 *      launches {num,lane}, the agent is slow to acquire, and tick N+1 re-assigns that lane to a different
 *      top-of-queue num while agent A is still starting — two agents on one lane). {@link retireBuildGuards}
 *      retires an entry three ways: CLAIMED (its lane shows leased in `state.lanes` OR the item left
 *      `state.queue`), AGENT-RETURNED (an injected `signals.returnedBuildNums` — the Agent completed/errored),
 *      or TTL (still pending after `buildTtlTicks`, default 3 — the required backstop for an agent that died
 *      after spawn but before claiming; surfaced as a note the first time).
 *
 *   2. PREPARE GUARD (scope + decision) — DIFFERENT bookkeeping, do NOT copy the build guard's retirement. One
 *      `{ num, kind, lane, spawnedTick, sawPr }` entry per prepare-scope / prepare-decision agent, keyed by
 *      `num` (the contended resource is the item's SCOPE/FORK authorship, not the incidental lane). A prepare
 *      NEVER claims and leaves the queue only at MERGE (several ticks), and its Agent RETURNS at PR-open, well
 *      before merge — so the build guard's "retire on Agent-return" rule would be a double-dispatch bug here.
 *      {@link retirePrepareGuards} therefore retires ONLY on: SCOPE-COMMITTED (the item left the pending set —
 *      `state.unshaped` for a scope prepare, or the un-prepared `state.decisions` rows for a decision prepare),
 *      PR-TERMINAL (a prepare PR was seen open and has now left the open set), or TTL-TO-FIRST-PR
 *      (`prepareTtlTicks`, default 5 — fires ONLY while NO open PR for the num has ever appeared, to catch an
 *      agent that died pre-PR; once an open prepare PR exists the TTL is VOID). NEVER on mere Agent-return.
 *      The re-dispatch gate ({@link planPrepareSpawns}) is the UNION: skip spawning a prepare for `num` when
 *      EITHER a live prepare-guard entry exists for it OR `state.prs` has an OPEN PR for that `num` (which,
 *      while the item is still unscoped/un-prepared, can only be its prepare — the backstop if the guard is lost).
 *
 *   3. FIX GUARD (§3c) — TWO separate pieces of state. An in-flight ENTRY `{ pr, num, lane, spawnedTick }` keyed
 *      by PR number ("a fix agent for this PR is live now"), and a per-PR attempt counter `fixAttempts[pr]`
 *      ("how many auto-fixes this PR has cost in total") that SURVIVES entry retirement and clears ONLY when the
 *      PR is terminal. Keeping the counter off the entry is the whole point: a bounce → fix → re-arm → bounce
 *      AGAIN is a NEW `review:changes` with no live entry, so a counter on the entry would reset each cycle and
 *      the cap would never bind. {@link planFixSpawns} skips a PR with a live entry (in-flight test), stops at
 *      the retry cap (`fixRetryCap`, default 3 — surfaced for `/review`), else spawns and records a new,
 *      UNCLAIMED entry — it does NOT bump the counter (#3454). The entry additionally tracks a sticky `claimed`
 *      flag: {@link retireFixGuards} flips it true the tick its assigned lane is observed LEASED in `state.lanes`
 *      (the same fact {@link retireBuildGuards} uses for the build guard's CLAIMED path) — that is the moment a
 *      PLANNED candidate becomes a CONFIRMED real attempt (dispatch-lane.mjs got past its own in-flight guard and
 *      actually started the agent), and only THEN does {@link planTick} bump `fixAttempts[pr]`, once, off
 *      `retireFixGuards`'s `newlyClaimed` list. A dispatch `dispatch-lane.mjs` refuses pre-flight (a stale
 *      `claude agents` liveness entry, say) never leases its lane, so it is never counted — its entry TTLs out
 *      UNCLAIMED (`reason: 'ttl-unclaimed'`) and is retried for free, mirroring the build guard's own "never
 *      claimed after N ticks" backstop. {@link retireFixGuards} retires the ENTRY when the PR no longer carries
 *      `review:changes` (re-armed / terminal) or on TTL (`fixTtlTicks`, default 5, split `ttl` claimed vs.
 *      `ttl-unclaimed`) — NOT the counter, which {@link clearTerminalFixAttempts} drops only when the PR leaves
 *      the open set. Because `fixAttempts` is in-session process state, it does NOT survive a conveyor restart;
 *      the cap therefore also reads a DURABLE floor `prRearmCounts[pr]` derived from the PR's own re-arm comments
 *      (`countRearmComments` — one comment per completed auto-fix, #2643), and binds on `max(in-session,
 *      durable)`. The durable floor is the restart-surviving source of truth (no parallel state store, #2612 —
 *      the count IS PR state); the in-session tally is the overlay that additionally counts a CLAIMED fix agent
 *      that died before re-arming (which leaves no comment for the floor to see).
 *
 *   3b. CI-HEAL GUARD (§3c-ci, #2666) — the SIBLING of the fix guard, SAME entry+counter+cap+TTL shape, but its
 *      trigger is a CI REGRESSION not a `review:changes` label: a conveyor PR that was GREEN AT OPEN
 *      (`ready-to-merge` / a review park) but has since gone RED on a required check ({@link isRedCi}) or BEHIND +
 *      parked ({@link isBehind} — the not-landable BEHIND case #2183 leaves unhealed). The delivery agent has long
 *      exited and the drain skips a red-CI PR, so nothing heals it. {@link planCiHealSpawns} dispatches a CI-heal
 *      agent that rebases + repairs ONLY the CI half and NEVER touches the review label. Its cap binds on
 *      `max(in-session ciHealAttempts, durable prCiHealCounts)` — the durable floor from the PR's own CI-heal
 *      comments (`countCiHealComments`, #2666 mirrors #2643), so a restart never resets a burned PR.
 *      {@link retireCiHealGuards} retires the ENTRY on CI recovery / PR-terminal (`resolved`) or TTL; the counter
 *      clears ONLY on PR-terminal ({@link clearTerminalCiHealAttempts}). `review:changes` PRs are EXCLUDED — the
 *      fix loop (guard 3) already rebases them.
 *
 * WATCHER ARMING (§4): {@link armWatchers} arms one watcher per OPEN PR whose `num` this conveyor DISPATCHED
 *   this session (`launchedNums` — builds AND prepares) that is not already watched, and prunes the watched set
 *   to the currently-open conveyor PRs (a merged/closed PR's watcher already exited). Scoping to conveyor-launched
 *   nums keeps an unrelated PR's stray `review:*` label from waking the loop. Each armed entry carries the
 *   `releaseSession` slug ({@link releaseSessionForNum}) the watcher passes as `--release-session`, so on MERGE
 *   pr-watch auto-releases that item's lane lease(s) across pools — the ghost-lease reclamation #2667 built and
 *   #2700 wires in (the periodic lease-reaper, SKILL §4c, is the catch-all backstop for what auto-release misses).
 *
 * HEALTH / STALL BACKSTOP (§2): `state.health` is now LIVE — #2616 populates the lane→num map on
 *   `acquire --item`, so `conveyor-state`'s stall scan flags a genuinely silent lane rather than always reading
 *   `ok`. {@link planTick} CONSUMES that verdict as a real backstop: `buildStatusLine` shows the `⚠ lane-N` warn
 *   and each stalled lane becomes an actionable `lane-stalled` note, so the per-tick lease-reaper reclaims the
 *   stalled lease and the operator sees it. It never auto-re-dispatches a guard on a stall (the 3-min threshold is
 *   far below a guard's spawn-to-death TTL — the guard TTLs remain the re-dispatch backstop, un-regressed).
 *
 * IDLE-STOP (§6): {@link assessIdleStop} stops ONLY when the queue is empty (no cleared `buildQueued` rows, no
 *   in-flight lanes, no open conveyor PRs) AND there has been no operator feedback for `idleWindowMs` (default
 *   15 min). It reads the operator-feedback clock (`now`, `lastOperatorTurn`) as injected inputs and deliberately
 *   IGNORES `state.idle.lastQueueAdd` (that field is the drain's queue, not the conveyor queue — SKILL §6).
 *
 * HELD-REASON NOTES (§7, telemetry-gap fix): the IO shell already shells `dispatch-plan.mjs` for `plan` (it needs
 *   `plan.launch`) — its `plan.held` (every queued-and-cleared item's `{ num, reason }`, the SAME reasoning a
 *   human previously had to run `dispatch-plan.mjs --json` BY HAND to see) was computed every tick but silently
 *   dropped: `planTick` only ever read `plan.launch`. A tick could show real spare capacity and
 *   `spawnBuilds: []` for many consecutive ticks — correct behavior (every held item really was scope-blocked or
 *   not-ready) — with NOTHING in the tick's own output explaining why. This loop surfaces each held item as its
 *   OWN note (mirroring the `needs-slice` / `decision-ready` / `lane-stalled` notes above: a continuous,
 *   re-derived-every-tick fact about backlog state, not a one-shot event — the codebase's existing discipline for
 *   "this is still true" signals, as opposed to the build/prepare/fix guards' one-shot TTL-retirement notes). It
 *   SKIPS `needs-slice` / `needs-decision` / `unshaped-no-scope` — each of those held reasons already has its OWN
 *   dedicated note above (from `state.needsSlice` / `state.decisions` / the prepare-spawn notes respectively) — so
 *   no item is ever double-reported under two note kinds. What is left — `overlaps lane-<n>`, `no free lane`,
 *   `cleared-but-not-ready`, and (defense-in-depth; unreachable via the production shell per dispatch-plan.mjs)
 *   `blocked` — had NO other surface at all before this.
 */

import { mintSessionSlug } from './session-slug.mjs';
import { normNum } from './queue-store.mjs';
import { capToConcurrency, resolveMaxConcurrentLanes } from '../lib/lane-concurrency.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
// The kind-scoped pause's PURE half (epic #3383) — the same predicate `dispatch-plan.mjs` uses for its own
// `build` gate, so the two cores can never disagree about what a given marker holds. No fs comes in with it.
import { resolvePausedKinds, isScopedPause } from '../readiness/dispatch-pause.mjs';

/** Held reasons (from {@link ../readiness/dispatch-plan.mjs HELD_REASONS}) that already have their OWN dedicated
 *  note elsewhere in {@link planTick} — `needs-slice` from `state.needsSlice`, `needs-decision` from
 *  `state.decisions`, `unshaped-no-scope` AND `no-size` (#3849) from the SAME prepare-spawn notes
 *  (`auto-preparing-scope` / `prepare-no-lane` — one prepare-scope agent authors both `scope:` and a missing
 *  size/estimate, #3842). The held-reason note loop below skips these so an item is never double-reported under
 *  two note kinds. */
export const HELD_NOTE_EXCLUDED_REASONS = Object.freeze(['needs-slice', 'needs-decision', 'needs-investigation', 'unshaped-no-scope', 'no-size']);

/**
 * SELF-DIAGNOSED STALL DETECTION (2026-09-14, live incident: #3521 held `overlaps lane-2` for 85+ minutes across
 * many ticks with no progress and NOTHING in the tick's own output naming how long or flagging it as abnormal —
 * a human had to manually re-derive the held reason's age by hand to tell "real contention" apart from "a stuck
 * signal nobody would otherwise notice"). The existing `held` note (just above) already answers "why not, THIS
 * tick" — it does NOT answer "for how long has this been true, and should that itself be alarming". This is
 * that second, durable axis: the SAME num held on the SAME reason for `stallTicks` consecutive ticks is the
 * driver diagnosing ITS OWN lack of progress, not an external inspector interpreting raw history after the
 * fact (see {@link advanceHeldStall}).
 */
export const DEFAULT_STALL_TICKS = 3;

/**
 * Advance the durable per-item held-stall counter by ONE tick's observation. PURE — the caller (`planTick`)
 * reads `prevHeldStall` from `bookkeeping` (threaded tick-to-tick exactly like `buildGuards`/`fixAttempts`
 * above) and this returns the next state to persist, plus the list of entries that have now crossed the
 * threshold. An item is "stalled" when it has been held on the EXACT SAME reason for `stallTicks` consecutive
 * ticks running — a CHANGED reason (e.g. `overlaps lane-2` → `overlaps lane-5`) or the item clearing (no
 * longer in `heldEntries`) resets its counter, mirroring {@link advanceBreachCount}'s rising-edge discipline
 * in `../readiness/scope-lease-collect.mjs` (a different held item is a different episode, not a continuation).
 * @param {Object<string,{reason:string, ticks:number}>|null|undefined} prevHeldStall  prior tick's durable state.
 * @param {Array<{num:*, reason:string}>} heldEntries  THIS tick's held items (already reason-filtered by the caller).
 * @param {number} [stallTicks]  consecutive-tick threshold to call it stalled.
 * @returns {{nextHeldStall:Object<string,{reason:string,ticks:number}>, stalled:Array<{num:*,reason:string,ticks:number}>}}
 */
/** Parse the lane number out of an `overlaps lane-<n>` held reason, or null for any other reason shape. */
function laneNumFromOverlapReason(reason) {
  const m = /^overlaps lane-(\d+)$/.exec(String(reason || ''));
  return m ? Number(m[1]) : null;
}

/**
 * The tick's PLAIN-LANGUAGE DECISION TRACE (2026-09-14, #3521/lane-2 incident, v1 scope: this driver's OWN
 * dispatch/skip/stall decisions only — not every subsystem). Answers "why did the conveyor do that" as a flat,
 * human-readable list a person (or another agent) can read straight through, instead of re-deriving it from
 * scattered logs the way root-causing #3521 required. PURE — a projection over this SAME tick's already-computed
 * decision arrays; it invents no new inputs and reuses the self-diagnosed stall notes verbatim as one of its
 * "why" reasons.
 *
 * VERBOSE (opt-in, `opts.verbose`, live-toggleable via `driver-verbose.mjs` — never a firehose of unrelated
 * internals, bounded to the SAME dispatch/skip/stall surface as the terse trace): adds (1) every CANDIDATE that
 * was held this tick, including the reasons the terse trace deliberately omits because they already have their
 * own lifecycle note elsewhere (`needs-slice`/`needs-decision`/`needs-investigation`/`unshaped-no-scope`, passed in as `opts.allHeld`
 * — the UNFILTERED `plan.held`) — "why was THIS one passed over" for every candidate, not only the ones that
 * already got a terse entry; and (2) for a `overlaps lane-<n>` stall, the actual lane row from `opts.lanes`
 * (`state.lanes`, already an input every `planTick` call has) — who really holds it (`session`), its effective
 * lease scope, and any breach — instead of just repeating the one-line reason string.
 * @param {object} d  the tick's (about-to-be-returned) `decisions` object.
 * @param {{verbose?:boolean, allHeld?:Array<{num:*,reason:string}>, lanes?:Array<object>}} [opts]
 * @returns {Array<{kind:'dispatch'|'skip'|'stall', num:*, text:string}>}
 */
export function buildDecisionTrace(d, { verbose = false, allHeld = [], lanes = [] } = {}) {
  const dec = d && typeof d === 'object' ? d : {};
  const trace = [];
  for (const s of Array.isArray(dec.spawnBuilds) ? dec.spawnBuilds : []) {
    trace.push({ kind: 'dispatch', num: s.num, lane: s.lane ?? null, text: `dispatched #${s.num} to lane-${s.lane ?? '?'}: build` });
  }
  for (const s of Array.isArray(dec.spawnPrepareScope) ? dec.spawnPrepareScope : []) {
    trace.push({ kind: 'dispatch', num: s.num, text: `dispatched #${s.num}: auto-prepare scope (unshaped item)` });
  }
  for (const s of Array.isArray(dec.spawnPrepareDecision) ? dec.spawnPrepareDecision : []) {
    trace.push({ kind: 'dispatch', num: s.num, text: `dispatched #${s.num}: prepare decision forks` });
  }
  for (const s of Array.isArray(dec.spawnInvestigations) ? dec.spawnInvestigations : []) {
    trace.push({ kind: 'dispatch', num: s.num, text: `dispatched #${s.num}: auto-investigate (needs-investigation item)` });
  }
  for (const s of Array.isArray(dec.spawnFixes) ? dec.spawnFixes : []) {
    trace.push({ kind: 'dispatch', num: s.num, pr: s.pr ?? null, text: `dispatched fix for PR #${s.pr ?? '?'} (#${s.num}): review:changes bounce` });
  }
  for (const s of Array.isArray(dec.spawnCiHeals) ? dec.spawnCiHeals : []) {
    trace.push({ kind: 'dispatch', num: s.num, pr: s.pr ?? null, text: `dispatched CI-heal for PR #${s.pr ?? '?'} (#${s.num}): red/BEHIND regression` });
  }
  for (const s of Array.isArray(dec.suppressedBuilds) ? dec.suppressedBuilds : []) {
    trace.push({ kind: 'skip', num: s.num, text: `skipped #${s.num}: already dispatching (matched a live guard by ${s.by})` });
  }
  // The terse `held` reasons already surfaced as notes this tick (never double-counted against the verbose
  // pass below — that pass only adds reasons NOT already covered here).
  const terseHeldReasons = new Set();
  for (const n of Array.isArray(dec.notes) ? dec.notes : []) {
    if (n.kind === 'held') {
      terseHeldReasons.add(`${n.num}::${n.reason}`);
      trace.push({ kind: 'skip', num: n.num, reason: n.reason, text: `skipped #${n.num}: ${n.reason}` });
    } else if (n.kind === 'stalled') {
      // The `stalled` note's text is reused VERBATIM (never re-derived), so the trace and the tick's own notes
      // can never say something different about the same fact.
      const entry = { kind: 'stall', num: n.num, reason: n.reason, ticks: n.ticks, text: n.text };
      if (verbose) {
        const laneNum = laneNumFromOverlapReason(n.reason);
        const laneRow = laneNum != null ? (Array.isArray(lanes) ? lanes : []).find((l) => Number(l?.lane) === laneNum) : null;
        if (laneRow) {
          entry.lane = {
            lane: laneRow.lane, heldBySession: laneRow.session ?? null,
            leaseScope: Array.isArray(laneRow.lease) ? laneRow.lease : [],
            breach: Array.isArray(laneRow.breach) ? laneRow.breach : [],
          };
        }
      }
      trace.push(entry);
    }
  }
  if (verbose) {
    for (const h of Array.isArray(allHeld) ? allHeld : []) {
      if (!h || h.num == null || !h.reason) continue;
      if (terseHeldReasons.has(`${h.num}::${h.reason}`)) continue; // already traced above — never double-report
      trace.push({ kind: 'skip', num: h.num, reason: h.reason, verbose: true, text: `skipped #${h.num}: ${h.reason}` });
    }
  }
  return trace;
}

export function advanceHeldStall(prevHeldStall, heldEntries, stallTicks = DEFAULT_STALL_TICKS) {
  const prev = prevHeldStall && typeof prevHeldStall === 'object' ? prevHeldStall : {};
  const nextHeldStall = {};
  const stalled = [];
  for (const h of Array.isArray(heldEntries) ? heldEntries : []) {
    if (!h || h.num == null || !h.reason) continue;
    const key = String(h.num);
    const prior = prev[key];
    const ticks = prior && prior.reason === h.reason ? (Number(prior.ticks) || 0) + 1 : 1;
    nextHeldStall[key] = { reason: h.reason, ticks };
    if (ticks >= stallTicks) stalled.push({ num: h.num, reason: h.reason, ticks });
  }
  return { nextHeldStall, stalled };
}

// ── PURE CORE (no fs / git / Date / child_process / gh — every input is passed IN) ───────────────────────────

/** Default TTL (in ticks) for the BUILD guard's died-before-claim backstop (SKILL §2 rule 3). */
export const DEFAULT_BUILD_TTL_TICKS = 3;
/** Default TTL (in ticks) for the PREPARE guard's died-before-first-PR backstop (SKILL §2 prepare guard). */
export const DEFAULT_PREPARE_TTL_TICKS = 5;
/** Default TTL (in ticks) for the FIX guard's died-before-rearm backstop (SKILL §3c). */
export const DEFAULT_FIX_TTL_TICKS = 5;
/** Default per-PR auto-fix attempt cap before a bounce is surfaced for `/review` (SKILL §3c). */
export const DEFAULT_FIX_RETRY_CAP = 3;
/** Default TTL (in ticks) for the CI-HEAL guard's died-before-repush backstop (SKILL §3c-ci, #2666). */
export const DEFAULT_CI_HEAL_TTL_TICKS = 5;
/**
 * #3383 — What ONE TTL "tick" is worth in wall-clock time: the resident runner's default interval
 * (`DEFAULT_TICK_INTERVAL_MS` in `skills-src/conveyor/runner.mjs`, 120 s), which is what the tick-count TTLs
 * above were calibrated against. Hook-driven `tick-once` ticks arrive at a VARIABLE rate (throttled to >= 60 s,
 * but seconds apart in a burst of prompts and hours apart when idle), so a bare tick count is no longer a
 * stable clock: in a burst a guard could expire in half the intended time, and after the last prompt of the day
 * it would never expire at all.
 */
export const TTL_MS_PER_TICK = 120_000;
/** A guard's spawn is stamped with both the tick counter (legacy) and the wall clock (when the caller has one). */
const spawnStamp = (tick, now) => (Number.isFinite(now) ? { spawnedTick: tick, spawnedAt: now } : { spawnedTick: tick });
/**
 * Has a guard's TTL run out? WALL-CLOCK when the guard carries `spawnedAt` and the caller supplied `now` (and the
 * clock has not gone backwards past the stamp): `ttlTicks * TTL_MS_PER_TICK` ms. Otherwise the original tick
 * count — a guard persisted before this change, or a caller with no clock, behaves exactly as it always did.
 * With the resident runner at its 120 s interval the two are the same TTL.
 */
export function guardTtlElapsed(g, { tick = 0, now = null, ttlTicks }) {
  if (Number.isFinite(g?.spawnedAt) && Number.isFinite(now) && now >= g.spawnedAt) return now - g.spawnedAt >= ttlTicks * TTL_MS_PER_TICK;
  return tick - (g?.spawnedTick ?? tick) >= ttlTicks;
}
/** Default per-PR CI-heal attempt cap before a red/BEHIND PR is surfaced for `/review` (SKILL §3c-ci, #2666). */
export const DEFAULT_CI_HEAL_RETRY_CAP = 3;
/** Default idle-stop window: queue-empty + no operator feedback for this long → stop (SKILL §6). */
export const DEFAULT_IDLE_WINDOW_MS = 15 * 60 * 1000;
/**
 * The dispatch kinds THIS core spawns, in tick order — the five of `dispatch-pause.mjs#PAUSABLE_KINDS` that
 * are planned here. `build` is the sixth and is deliberately absent: builds are gated one step upstream, where
 * `we:scripts/readiness/dispatch-plan.mjs` empties `plan.launch` to `dispatch-paused` holds, so this core never
 * decides a build's fate. Used to word the kind-scoped pause note with the kinds THIS tick actually withheld.
 */
export const TICK_SPAWN_KINDS = Object.freeze(['prepare', 'prepare-decision', 'investigate', 'fix', 'ci-heal']);

/** The review label that routes a bounced PR to a fix agent (vs. a human-owned review park). */
export const REVIEW_CHANGES_LABEL = 'review:changes';

/** The labels that mark a conveyor PR as HAVING BEEN GREEN / CLEARED at open — `ready-to-merge` (pr-land applied
 *  it only once `test` went green) or a human review park. A PR that carries one of these was healthy at open, so
 *  a later red check / BEHIND is a REGRESSION to heal (#2666); a PR carrying NONE of them was never green (a
 *  born-red build the delivery agent already escalated gate-red) and must NOT trip the CI-heal loop. */
export const GREEN_AT_OPEN_LABELS = Object.freeze(['ready-to-merge', 'review:human', 'review:pending']);
/** The human-owned review-park labels. A PR carrying one is NOT landable, so #2183's BEHIND-rebuild never fires
 *  for it — the parked-and-BEHIND case this CI-heal loop covers (#2666). CI is repaired; the park label is NOT. */
export const REVIEW_PARK_LABELS = Object.freeze(['review:human', 'review:pending']);

/** True when a `state.prs` row is OPEN. `state.prs` is built from `gh pr list --state open`, so every row is
 *  open by construction; this tolerates a missing/blank `state` (→ open) and only rejects an explicit terminal
 *  state, so a caller that hands in a wider list never mis-reads a closed PR as open. */
function isOpenPr(p) {
  const s = String(p?.state || '').toUpperCase();
  return s === '' || s === 'OPEN';
}

/** The OPEN `state.prs` row for item `num` (normalized), or null. While an item is still unscoped / un-prepared
 *  it has NO build PR, so its only open PR can be its in-flight prepare — the union re-dispatch gate's backstop. */
function openPrForNum(prs, num) {
  const key = normNum(num);
  return (Array.isArray(prs) ? prs : []).find((p) => p && isOpenPr(p) && normNum(p.num) === key) || null;
}

/** True when a `state.prs` row carries the `review:changes` label (a human bounce → route to a fix agent). */
function hasReviewChanges(prRow) {
  return Array.isArray(prRow?.labels) && prRow.labels.includes(REVIEW_CHANGES_LABEL);
}

/** Lowercased label-name set for a `state.prs` row (labels are plain strings out of `shapePrs`; tolerate `{name}`). */
function labelSet(labels) {
  return new Set(
    (Array.isArray(labels) ? labels : [])
      .map((l) => (typeof l === 'string' ? l : l?.name))
      .filter(Boolean)
      .map((n) => String(n).toLowerCase()),
  );
}

/** True when the PR's required-check rollup is DEFINITIVELY red (`ci === 'fail'` — `ciRollup` in conveyor-state.mjs
 *  distills the whole rollup to `pass|fail|pending|none`; only `fail` is a settled red check the drain would skip). */
function isRedCi(prRow) {
  return String(prRow?.ci || '').toLowerCase() === 'fail';
}

/** True when the PR is BEHIND its base (`main` advanced under it). Read from `mergeStateStatus` — the gh field name
 *  — so once conveyor-state.mjs shapes it onto the PR row this branch goes live; until then it is dormant (the field
 *  is absent → always false), and the red-CI branch alone drives the loop. See the follow-up that populates it. */
function isBehind(prRow) {
  return String(prRow?.mergeStateStatus ?? prRow?.behind ?? '').toUpperCase() === 'BEHIND';
}

/** True when the PR carries a marker that it was GREEN / CLEARED at open (see {@link GREEN_AT_OPEN_LABELS}). */
function wasGreenAtOpen(labels) {
  const ls = labelSet(labels);
  return GREEN_AT_OPEN_LABELS.some((l) => ls.has(l));
}

/** True when the PR is human-review-PARKED (`review:human` / `review:pending`) — not landable, so #2183's rebuild
 *  never fires and its BEHIND stays unhealed (the case this loop covers, #2666). */
function isReviewParked(labels) {
  const ls = labelSet(labels);
  return REVIEW_PARK_LABELS.some((l) => ls.has(l));
}

/**
 * True when a `state.prs` row is a CI-HEAL TARGET (#2666) — a conveyor PR that was GREEN AT OPEN but has since
 * regressed on the CI axis, and is NOT already owned by the `review:changes` fix loop. Two disjoint triggers:
 *   • RED CI — a definitively-failed required check (`ci === 'fail'`) on a was-green PR. The drain skips a red check
 *     regardless of landability, so nothing heals it; this is the dominant, observed case (a BEHIND branch whose
 *     `test` job broke against the new main surfaces here as `ci: 'fail'`).
 *   • BEHIND + PARKED — the base advanced (`mergeStateStatus === 'BEHIND'`) AND the PR is human-review-parked, so it
 *     is NOT landable and #2183's BEHIND-rebuild never fires. (A LANDABLE BEHIND PR is #2183's job — deliberately
 *     excluded here so the two loops never fight over the same rebuild.)
 * A `review:changes` PR is EXCLUDED — the review-changes fix loop (§3c) already reconstitutes + rebases it.
 */
function isCiHealTarget(prRow) {
  if (!prRow || !isOpenPr(prRow)) return false;
  const labels = prRow.labels;
  if (hasReviewChanges(prRow)) return false; // owned by the review:changes fix loop (§3c) — it already rebases
  if (isRedCi(prRow) && wasGreenAtOpen(labels)) return true; // red required check on a PR that was green at open
  if (isBehind(prRow) && isReviewParked(labels)) return true; // not-landable BEHIND — the case #2183 leaves unhealed
  return false;
}

/** The set of item nums (normalized) that are cleared-for-build (`buildQueued`) in the tick's `state.queue`. */
function clearedQueueNums(queue) {
  return new Set((Array.isArray(queue) ? queue : []).filter((r) => r?.buildQueued).map((r) => normNum(r.num)));
}

/** The grammar a BUILD dispatch's session slug follows ({@link sessionSlugFor} in `../operations/dispatch-lane.mjs`
 *  with `kind: 'build'`: `conveyor-<num><attemptTag?>`). MIRRORED, not imported — same reasoning
 *  `../operations/dispatch-lane.mjs`'s own header gives for mirroring rather than importing across the
 *  conveyor/operations boundary: importing here would pull the operations module into the pure tick core's graph.
 *  The agreement is asserted by a test instead (`__tests__/tick-core.test.mjs`, cross-checked against
 *  `sessionSlugFor`'s own output). Only the BUILD kind matches — `fix-`, `prepare-`, `prepare-decision-`, and
 *  `ci-heal-` sessions are deliberately excluded, since conflating them would durably-guard the wrong loop's num. */
// Build sessions identify WE items only.
const BUILD_SESSION_RE = /^conveyor-(\d+)[a-z]?$/i;

/**
 * #3403 — THE DURABLE FLOOR for the in-flight BUILD guard. `bookkeeping.buildGuards` is SESSION-EPHEMERAL
 * (SKILL §5, this file's own header): a supervisor crash-restart (`../../skills-src/conveyor/supervisor.mjs`)
 * wipes it, and the very next tick would otherwise see a spawned-but-not-yet-claimed build as never-dispatched
 * and re-launch it — reopening the double-dispatch `#3177` already reproduced live, via the new automatic-
 * restart path. This mirrors the fix/ci-heal retry-cap's OWN restart-surviving floor (`prRearmCounts`/
 * `prCiHealCounts`, #2643/#2666): read a fact from the GROUND TRUTH each tick — here, whether the OS session
 * the dispatch spawned is still alive — rather than trusting only the in-process TTL countdown. Pure: given the
 * live-session ROWS (the IO shell's one `claude agents --json` read, {@link defaultListAgents} in
 * `../operations/dispatch-lane-io.mjs`), extract every num with a live BUILD session. A session merely being
 * LISTED counts as durable-live regardless of `state` ambiguity (unlike `reconcile-core.mjs`'s liveness
 * refusal, which must tell "alive" apart from "unknown" to avoid a WRONG dispatch): here the failure mode this
 * guards against is a double-dispatch, so erring toward "still guarded" a little longer than strictly necessary
 * is the safe direction.
 *
 * #3383 FOLLOW-UP (2026-09-14) — `pidAlive === false` IS THE ONE EXCEPTION, and it is load-bearing, not merely
 * an optimization. This function's ORIGINAL reasoning ("once the OS session actually exits, `claude agents
 * --json` stops listing it and this floor clears on its own") was found FALSE the same night a live audit
 * turned up 26 registry rows — `conveyor-*` among them — still listed 6-13.5 DAYS after their process died,
 * `state` never advancing. Before this exception, ANY listed `conveyor-<num>` name durable-guarded that num
 * forever, however long the listing itself was stale — permanently suppressing a REAL re-dispatch of an item
 * whose only "in-flight" evidence was a phantom registry row, silently (the status line's own display already
 * ages a never-claimed durable entry out of its COUNT after `buildTtlTicks` — see `countableBuildGuards` at
 * this function's call site — but that never touched the guard itself, which kept blocking dispatch under the
 * cover of a status line that had stopped mentioning it at all). A row carrying an explicit `pidAlive === false`
 * — the SAME two-signal probe `driver-watchdog.mjs#resolvePidAlive`/`scanPsOutput` established and
 * `lease-reaper.mjs`/`session-reaper.mjs` already reuse (a row's own `pid` when present, else a `ps aux` scan
 * for its full `sessionId`) — is a CONFIRMED death, not an absence of evidence: nothing double-dispatches
 * against a session that provably no longer exists, so excluding it here costs none of the protection this
 * floor exists for. `true` (genuinely alive) and `undefined`/`null` (unknown — no `pidAlive` resolved at all,
 * the exact shape every pre-#3383 caller/test still passes) both keep the ORIGINAL "list alone is enough"
 * behavior, byte-identical — this is strictly narrower than before, never wider.
 * @param {Array<{name?:string, pidAlive?:boolean|null}>|Array<string>} sessions - `claude agents --json` rows
 *   (optionally carrying a `pidAlive` fact the IO shell already resolved), or plain name strings.
 * @returns {string[]} normalized nums with a live (not confirmed-dead) BUILD session.
 */
export function durableBuildNums(sessions) {
  const out = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const name = typeof s === 'string' ? s : s?.name;
    if (typeof s === 'object' && s !== null && s.pidAlive === false) continue; // confirmed dead — never a floor
    const m = BUILD_SESSION_RE.exec(String(name ?? ''));
    if (m) out.push(normNum(m[1]));
  }
  return out;
}

/**
 * RETIRE the in-flight BUILD guard entries (SKILL §2 — three ways). Given the live build guards and the tick's
 * read, split them into the entries that stay LIVE and the entries that RETIRE (each with its reason). Pure.
 *
 *   • CLAIMED  — the agent got going: its `lane` shows leased in `state.lanes`, OR its `num` has left the cleared
 *                build queue (a claimed item leaves `build-queue`'s ready set). The normal path.
 *   • RETURNED — the delivery `Agent` completed/errored: its `num` is in the injected `signals.returnedBuildNums`.
 *   • TTL      — still pending after `ttlTicks` without ever claiming (the required backstop for an agent that
 *                died after spawn but before claim). Surfaced (`note:true`) so the skill can warn once.
 *
 * @param {Array<{num:*, lane:*, spawnedTick:number}>} buildGuards
 * @param {{ lanes?:object[], queue?:object[], tick:number, ttlTicks?:number, returnedBuildNums?:Array<*> }} ctx
 * @returns {{ live:Array<object>, retired:Array<{num:*, lane:*, reason:string, note?:boolean}> }}
 */
export function retireBuildGuards(buildGuards, { lanes = [], queue = [], tick = 0, now = null, ttlTicks = DEFAULT_BUILD_TTL_TICKS, returnedBuildNums = [] } = {}) {
  const leasedLanes = new Set((Array.isArray(lanes) ? lanes : []).map((l) => String(l?.lane)));
  const clearedNums = clearedQueueNums(queue);
  const returned = new Set((Array.isArray(returnedBuildNums) ? returnedBuildNums : []).map(normNum));
  const live = [];
  const retired = [];
  for (const g of Array.isArray(buildGuards) ? buildGuards : []) {
    if (!g || g.num == null) continue;
    const key = normNum(g.num);
    const claimed = leasedLanes.has(String(g.lane)) || !clearedNums.has(key);
    if (claimed) { retired.push({ num: g.num, lane: g.lane, reason: 'claimed' }); continue; }
    if (returned.has(key)) { retired.push({ num: g.num, lane: g.lane, reason: 'returned' }); continue; }
    if (guardTtlElapsed(g, { tick, now, ttlTicks })) {
      retired.push({ num: g.num, lane: g.lane, reason: 'ttl', note: true });
      continue;
    }
    live.push(g);
  }
  return { live, retired };
}

/**
 * FILTER `plan.launch` through the live in-flight dispatch guard (SKILL §2). Drop a launch entry whose `num` OR
 * whose assigned `lane` matches a live guard entry — BOTH are excluded because the contended resource is the
 * lane, not only the item. Pure.
 * @param {Array<{num:*, lane:*}>} launches  `plan.launch` from the dispatch plan
 * @param {Array<{num:*, lane:*}>} liveBuildGuards  the guards that survived retirement THIS tick
 * @returns {{ spawn:Array<{num:*, lane:*}>, suppressed:Array<{num:*, lane:*, by:string}> }}
 */
export function filterLaunches(launches, liveBuildGuards) {
  const guardNums = new Set((Array.isArray(liveBuildGuards) ? liveBuildGuards : []).map((g) => normNum(g.num)));
  const guardLanes = new Set((Array.isArray(liveBuildGuards) ? liveBuildGuards : []).map((g) => String(g.lane)));
  const spawn = [];
  const suppressed = [];
  for (const l of Array.isArray(launches) ? launches : []) {
    if (!l || l.num == null) continue;
    if (guardNums.has(normNum(l.num))) { suppressed.push({ num: l.num, lane: l.lane, by: 'num' }); continue; }
    if (guardLanes.has(String(l.lane))) { suppressed.push({ num: l.num, lane: l.lane, by: 'lane' }); continue; }
    spawn.push({ num: l.num, lane: l.lane });
  }
  return { spawn, suppressed };
}

/**
 * RETIRE the PREPARE guard entries (SKILL §2 prepare guard + §3e) — its OWN rules, never the build guard's.
 * Keyed by `num`; retires ONLY on scope-committed / PR-terminal / TTL-to-first-PR, NEVER on Agent-return.
 *
 *   • SCOPE-COMMITTED — the item left the pending set: `state.unshaped` for a `kind:'prepare'` (scope) guard, or
 *                       the un-prepared `state.decisions` rows for a `kind:'prepare-decision'` guard. Success.
 *   • PR-TERMINAL     — a prepare PR for the num was seen OPEN (`sawPr`) and has now left the open set.
 *   • TTL-TO-FIRST-PR — fires ONLY while NO open PR for the num has EVER appeared (`!sawPr`) and the entry is
 *                       older than `ttlTicks` — catches an agent that died before opening its PR. Once an open
 *                       prepare PR exists the TTL is void; retirement is then PR-terminal. Surfaced (`note:true`).
 *
 * A live entry's `sawPr` is STICKY: once an open PR is observed for the num it stays true, so a later `gh` read
 * that momentarily drops the (still-open) PR retires the guard as PR-TERMINAL rather than firing a false TTL.
 * (It cannot fully prevent a duplicate prepare on such a flaky read — the union re-dispatch gate reads the SAME
 * `state.prs`, so an absent PR opens the gate too — but that is a pre-existing property of one PR read serving
 * both the guard and the gate, and `gh pr list --state open` rarely drops a genuinely-open PR.)
 *
 * @param {Array<{num:*, kind?:string, lane:*, spawnedTick:number, sawPr?:boolean}>} prepareGuards
 * @param {{ unshaped?:object[], decisions?:object[], investigations?:object[], prs?:object[], tick:number, ttlTicks?:number }} ctx
 * @returns {{ live:Array<object>, retired:Array<{num:*, kind:string, reason:string, note?:boolean}> }}
 */
export function retirePrepareGuards(prepareGuards, { unshaped = [], decisions = [], investigations = [], prs = [], tick = 0, now = null, ttlTicks = DEFAULT_PREPARE_TTL_TICKS } = {}) {
  const unshapedNums = new Set((Array.isArray(unshaped) ? unshaped : []).map((u) => normNum(u.num)));
  const unpreparedNums = new Set(
    (Array.isArray(decisions) ? decisions : []).filter((d) => d?.prepared !== true).map((d) => normNum(d.num)),
  );
  // INVESTIGATION PENDING SET (#3567) — mirrors `unshapedNums`, not `unpreparedNums`: an investigation has no
  // `prepared` flag to wait on, so "still pending" is simply "still held `needs-investigation` this tick"
  // (the caller derives this straight off `plan.held`, same shape as `state.unshaped`).
  const investigationNums = new Set((Array.isArray(investigations) ? investigations : []).map((i) => normNum(i.num)));
  const live = [];
  const retired = [];
  for (const g of Array.isArray(prepareGuards) ? prepareGuards : []) {
    if (!g || g.num == null) continue;
    const key = normNum(g.num);
    const kind = g.kind || 'prepare';
    const pendingNums = kind === 'prepare-decision' ? unpreparedNums : kind === 'investigate' ? investigationNums : unshapedNums;
    const openPr = !!openPrForNum(prs, g.num);
    const sawPr = g.sawPr === true || openPr;
    if (!pendingNums.has(key)) { retired.push({ num: g.num, kind, reason: 'scope-committed' }); continue; }
    if (sawPr && !openPr) { retired.push({ num: g.num, kind, reason: 'pr-terminal' }); continue; }
    if (!sawPr && guardTtlElapsed(g, { tick, now, ttlTicks })) {
      retired.push({ num: g.num, kind, reason: 'ttl', note: true });
      continue;
    }
    live.push(sawPr === g.sawPr ? g : { ...g, sawPr }); // persist the sticky sawPr flip
  }
  return { live, retired };
}

/**
 * PLAN the prepare-scope + prepare-decision spawns (SKILL §3b / §3e). For every unscoped held item
 * (`state.unshaped`) and every UNPREPARED decision (`state.decisions[].prepared === false`), spawn ONE prepare
 * agent UNLESS the UNION re-dispatch gate suppresses it: skip when EITHER a live prepare-guard entry exists for
 * the num OR `state.prs` has an OPEN PR for the num. A spawn consumes one `availableLanes` id (the free lanes
 * MINUS this tick's build launches MINUS every live guard's lane, computed by the caller); with no lane left the
 * item HOLDS (a note, no spawn — atomic `acquire` would fail one race anyway). Pure — mutates nothing; returns
 * the spawns, the new guard entries, the lanes it consumed, and any hold notes.
 *
 * @param {{ unshaped?:object[], decisions?:object[], investigations?:object[], prs?:object[], livePrepareGuards?:object[], availableLanes?:Array<*>, tick:number, now?:number|null, trace?:boolean, dispatchPaused?:boolean, pausedKinds?:string[]|null }} ctx
 * @returns {{ scopeSpawns:Array<{num:*, lane:*}>, decisionSpawns:Array<{num:*, lane:*}>, investigationSpawns:Array<{num:*, lane:*}>, newGuards:Array<object>, consumedLanes:Array<*>, notes:Array<{kind:string, num:*, text:string}> }}
 */
export function planPrepareSpawns({ unshaped = [], decisions = [], investigations = [], prs = [], livePrepareGuards = [], availableLanes = [], tick = 0, now = null, trace = false, dispatchPaused = false, pausedKinds = null } = {}) {
  const guardNums = new Set((Array.isArray(livePrepareGuards) ? livePrepareGuards : []).map((g) => normNum(g.num)));
  const lanes = [...(Array.isArray(availableLanes) ? availableLanes : [])];
  const scopeSpawns = [];
  const decisionSpawns = [];
  const investigationSpawns = [];
  const newGuards = [];
  const consumedLanes = [];
  const notes = [];

  const admission = [];
  const plan = (num, kind, sink) => {
    const key = normNum(num);
    const gates = [];
    if (trace) admission.push({ num, kind, gates });
    const blocked = (name, condition, observed) => {
      if (trace) gates.push({ name, pass: !condition, observed });
      return condition;
    };
    const paused = dispatchPaused === true || (Array.isArray(pausedKinds) && pausedKinds.includes(kind));
    if (blocked('dispatch-paused', paused, paused)) return;
    if (blocked('prepare-guard', guardNums.has(key), { num: key, guards: [...guardNums] })) return; // live prepare-guard entry → already in flight
    const existingPr = openPrForNum(prs, num);
    if (blocked('existing-PR', !!existingPr, existingPr ?? null)) return; // open PR for an unscoped/un-prepared item → its in-flight prepare
    if (blocked('prepare-lane-capacity', lanes.length === 0, [...lanes])) { notes.push({ kind: 'prepare-no-lane', num, text: `no free lane to auto-prepare #${num}` }); return; }
    const lane = lanes.shift();
    consumedLanes.push(lane);
    guardNums.add(key); // a decision and a scope item never share a num, but stay safe against a duplicate row
    sink.push({ num, lane });
    newGuards.push({ num, kind, lane, ...spawnStamp(tick, now), sawPr: false });
  };

  for (const u of Array.isArray(unshaped) ? unshaped : []) if (u?.num != null) plan(u.num, 'prepare', scopeSpawns);
  for (const d of Array.isArray(decisions) ? decisions : []) {
    if (d?.num != null && d.prepared !== true) plan(d.num, 'prepare-decision', decisionSpawns);
  }
  // #3567 — every held `needs-investigation` candidate spawns ONE investigate agent, no `prepared` gate: an
  // investigation is a single dispatched investigator, not a two-phase prepare-then-ratify lifecycle.
  for (const i of Array.isArray(investigations) ? investigations : []) if (i?.num != null) plan(i.num, 'investigate', investigationSpawns);
  return { scopeSpawns, decisionSpawns, investigationSpawns, newGuards, consumedLanes, notes, ...(trace ? { admission } : {}) };
}

/**
 * PLAN the fix-agent spawns for `review:changes` bounces (SKILL §3c). For every OPEN `state.prs` row that this
 * conveyor launched (`num` ∈ `launchedNums`) and carries `review:changes`: skip if a live fix-guard ENTRY
 * already exists for the PR (the in-flight test); else if the PR has reached the retry cap surface it for
 * `/review` (no spawn); else spawn a fix agent on a free lane and record a new, UNCLAIMED entry.
 *
 * DOES NOT BUMP THE ATTEMPT COUNTER (fixed #3454 — was the phantom-attempt bug: PR #1861 hit "auto-fix
 * exhausted" after exactly TWO real spawns and zero commits, because the old code bumped `fixAttempts[pr]` the
 * instant a spawn was PLANNED here, before `we:scripts/operations/dispatch-lane.mjs` ever ran. That downstream
 * call is a SEPARATE step outside this pure core (this runner only surfaces `decisions.spawnFixes` — it "spawns
 * no LLM agents itself", `we:skills-src/conveyor/runner.mjs`), and it owns its OWN in-flight guard (a stale
 * `claude agents` liveness entry can make it refuse with `dispatching:false` before a lane is ever acquired).
 * Refused-pre-flight ≠ a real attempt, but the old code could not tell the difference — it counted every
 * SURFACED candidate, whether or not dispatch-lane ever got past its own guard. The counter now only bumps once
 * a REAL attempt is CONFIRMED — {@link retireFixGuards}'s claim detection, the SAME `state.lanes`-leased fact
 * {@link retireBuildGuards} already uses for the build guard's CLAIMED retirement. A dispatch refused pre-flight
 * never leases its assigned lane, so its guard entry TTLs out UNCLAIMED (`reason: 'ttl-unclaimed'`) and is
 * retried for free next tick — mirroring the build guard's own "never claimed after N ticks — re-dispatching"
 * TTL backstop, which never burns anything either.
 *
 * The cap is checked against `max(in-session fixAttempts[pr], durable prRearmCounts[pr])` (#2643). The in-session
 * `fixAttempts` map does NOT survive a conveyor restart, so on a fresh conveyor it starts empty and the cap would
 * never bind — the very unbounded fix↔bounce loop the cap exists to prevent. `prRearmCounts` is the DURABLE floor
 * derived from the PR's own re-arm comments (`countRearmComments`, one per completed auto-fix): it restores the
 * count after a restart, and the in-session map stays as the within-session overlay that also counts a fix agent
 * that DIED AFTER CLAIMING but before re-arming (which posts no comment, so the durable floor can't see it — that
 * TTL-backstop case still terminates at the human via the in-session tally, bumped at claim time by the caller —
 * see {@link retireFixGuards}'s `newlyClaimed`). Pure — returns the spawns, new (unclaimed) entries, the
 * (unchanged, pass-through) counter map, consumed lanes, and the surface notes; mutates no input.
 *
 * @param {{ prs?:object[], launchedNums?:Array<*>, liveFixGuards?:object[], fixAttempts?:object, prRearmCounts?:object, retryCap?:number, availableLanes?:Array<*>, tick:number }} ctx
 * @returns {{ spawns:Array<{pr:number, num:*, lane:*}>, newGuards:Array<object>, fixAttempts:object, consumedLanes:Array<*>, notes:Array<object> }}
 */
export function planFixSpawns({ prs = [], launchedNums = [], liveFixGuards = [], fixAttempts = {}, prRearmCounts = {}, retryCap = DEFAULT_FIX_RETRY_CAP, availableLanes = [], tick = 0, now = null } = {}) {
  const launched = new Set((Array.isArray(launchedNums) ? launchedNums : []).map(normNum));
  const guardedPrs = new Set((Array.isArray(liveFixGuards) ? liveFixGuards : []).map((g) => Number(g.pr)));
  const nextAttempts = { ...(fixAttempts && typeof fixAttempts === 'object' ? fixAttempts : {}) };
  const durable = prRearmCounts && typeof prRearmCounts === 'object' ? prRearmCounts : {};
  const lanes = [...(Array.isArray(availableLanes) ? availableLanes : [])];
  const spawns = [];
  const newGuards = [];
  const consumedLanes = [];
  const notes = [];

  for (const p of Array.isArray(prs) ? prs : []) {
    if (!p || !isOpenPr(p) || !hasReviewChanges(p)) continue;
    if (!launched.has(normNum(p.num))) continue; // only PRs THIS conveyor launched
    const pr = Number(p.prNumber);
    if (!pr) continue;
    if (guardedPrs.has(pr)) continue; // a fix agent for this PR is already live
    // The DURABLE re-arm-comment count is the restart-surviving floor; the in-session tally the within-session
    // overlay (it alone catches a claimed fix that died before posting a re-arm comment). The cap binds on
    // whichever is higher, so a restart can never reset a PR that already burned its attempts (#2643).
    const attempts = Math.max(Number(nextAttempts[pr]) || 0, Number(durable[pr]) || 0);
    if (attempts >= retryCap) {
      notes.push({ kind: 'fix-exhausted', num: p.num, pr, attempts, text: `PR #${pr} (#${p.num}) bounced ${attempts}× — auto-fix exhausted, run /review ${pr}` });
      continue;
    }
    if (lanes.length === 0) { notes.push({ kind: 'fix-no-lane', num: p.num, pr, text: `no free lane to fix PR #${pr}` }); continue; }
    const lane = lanes.shift();
    consumedLanes.push(lane);
    guardedPrs.add(pr);
    // NO counter bump here (#3454) — this is only a PLANNED candidate; whether it becomes a real attempt is
    // decided downstream by dispatch-lane.mjs, and confirmed back into fixAttempts via retireFixGuards' claim
    // detection next tick. Bumping here counted phantom, guard-refused dispatches as real bounces.
    spawns.push({ pr, num: p.num, lane });
    newGuards.push({ pr, num: p.num, lane, ...spawnStamp(tick, now), claimed: false });
  }
  return { spawns, newGuards, fixAttempts: nextAttempts, consumedLanes, notes };
}

/**
 * RETIRE the in-flight fix-guard ENTRIES (SKILL §3c — the ENTRY, plus — #3454 — report which entries just became
 * a CONFIRMED real attempt). An entry tracks its own `claimed` flag (sticky, like the prepare guard's `sawPr`):
 * UNCLAIMED until its assigned lane is observed LEASED in `state.lanes` — the SAME fact {@link retireBuildGuards}
 * already uses for the build guard's CLAIMED retirement, i.e. dispatch-lane.mjs actually got past its own
 * in-flight guard and started the agent. The moment a guard flips unclaimed → claimed, its `{pr, num}` is
 * surfaced in `newlyClaimed` — the caller ({@link planTick}) bumps `fixAttempts[pr]` THERE, exactly once, only
 * for a now-confirmed-real attempt (#3454 — was bumped speculatively at plan time in `planFixSpawns`, counting
 * dispatches `dispatch-lane.mjs` refused pre-flight as real bounces).
 *
 * Entry retirement itself is UNCHANGED in shape, refined only on the TTL axis:
 *   • RESOLVED — the PR no longer carries `review:changes` (re-armed to `review:pending`, or merged/closed).
 *   • TTL, CLAIMED   — the fix agent genuinely started (lane was leased at some point) then went silent past
 *     `ttlTicks` without re-arming. A REAL, if failed, attempt — already bumped at claim time, so it still
 *     counts toward the retry cap on the next spawn (a repeatedly-dying fix still terminates at the human).
 *   • TTL, UNCLAIMED — the lane was NEVER observed leased (dispatch-lane.mjs's own in-flight guard refused it,
 *     or it died before ever acquiring) — no real attempt ever happened. Free re-dispatch next tick, same as
 *     the build guard's own "never claimed after N ticks — re-dispatching" TTL backstop; nothing was bumped, so
 *     nothing needs to be un-bumped.
 * Pure.
 * @param {Array<{pr:number, num:*, lane:*, spawnedTick:number, claimed?:boolean}>} fixGuards
 * @param {{ prs?:object[], lanes?:object[], tick:number, ttlTicks?:number }} ctx
 * @returns {{ live:Array<object>, retired:Array<{pr:number, num:*, reason:string, claimed:boolean, note?:boolean}>, newlyClaimed:Array<{pr:number, num:*}> }}
 */
export function retireFixGuards(fixGuards, { prs = [], lanes = [], tick = 0, now = null, ttlTicks = DEFAULT_FIX_TTL_TICKS } = {}) {
  const byPr = new Map();
  for (const p of Array.isArray(prs) ? prs : []) if (p?.prNumber != null) byPr.set(Number(p.prNumber), p);
  const leasedLanes = new Set((Array.isArray(lanes) ? lanes : []).map((l) => String(l?.lane)));
  const live = [];
  const retired = [];
  const newlyClaimed = [];
  for (const g of Array.isArray(fixGuards) ? fixGuards : []) {
    if (!g || g.pr == null) continue;
    const wasClaimed = g.claimed === true;
    const claimed = wasClaimed || leasedLanes.has(String(g.lane));
    if (claimed && !wasClaimed) newlyClaimed.push({ pr: Number(g.pr), num: g.num });
    const prRow = byPr.get(Number(g.pr));
    const stillChanges = prRow && isOpenPr(prRow) && hasReviewChanges(prRow);
    if (!stillChanges) { retired.push({ pr: Number(g.pr), num: g.num, reason: 'resolved', claimed }); continue; }
    if (guardTtlElapsed(g, { tick, now, ttlTicks })) {
      retired.push({ pr: Number(g.pr), num: g.num, reason: claimed ? 'ttl' : 'ttl-unclaimed', note: true, claimed });
      continue;
    }
    live.push(claimed === wasClaimed ? g : { ...g, claimed });
  }
  return { live, retired, newlyClaimed };
}

/**
 * CLEAR the per-PR fix-attempt counter for PRs that have reached a TERMINAL state (SKILL §3c — the counter
 * clears ONLY on merge/close, NEVER on entry retirement). A PR is terminal when it has left the OPEN
 * `state.prs` set. Returns a NEW map with only the still-open PRs' counters. Pure.
 * @param {object} fixAttempts  `{ [pr]: count }`
 * @param {object[]} prs  the tick's `state.prs` (open PRs)
 * @returns {object} the pruned counter map
 */
export function clearTerminalFixAttempts(fixAttempts, prs) {
  const openPrs = new Set((Array.isArray(prs) ? prs : []).filter(isOpenPr).map((p) => Number(p.prNumber)));
  const next = {};
  for (const [pr, count] of Object.entries(fixAttempts && typeof fixAttempts === 'object' ? fixAttempts : {})) {
    if (openPrs.has(Number(pr))) next[pr] = count;
  }
  return next;
}

/**
 * PLAN the CI-HEAL fix-agent spawns for conveyor PRs gone RED / BEHIND after a green open (SKILL §3c-ci, #2666).
 * This is the SIBLING of {@link planFixSpawns}: same in-flight-entry + attempt-counter + retry-cap shape, but the
 * trigger is a CI regression ({@link isCiHealTarget}) in place of a `review:changes` label, and the spawned agent
 * repairs ONLY the CI half — it NEVER touches `review:human` / `review:pending` (the human gate stays). For every
 * OPEN conveyor-launched PR (`num` ∈ `launchedNums`) that is a CI-heal target: skip if a live CI-heal entry already
 * exists for the PR (in-flight test); else if it has reached the retry cap surface it for `/review` (no spawn); else
 * spawn a CI-heal agent on a free lane, record an entry, and BUMP the attempt counter.
 *
 * The cap binds on `max(in-session ciHealAttempts[pr], durable prCiHealCounts[pr])` — the SAME restart-surviving
 * design as the fix loop (#2643): the in-session map is wiped by a conveyor restart, so a DURABLE floor derived from
 * the PR's own CI-heal comments (`countCiHealComments`, one per completed heal) restores the count and the cap can
 * never reset a PR that already burned its attempts. Pure — returns the spawns, new entries, the bumped counter map,
 * consumed lanes, and surface notes; mutates no input.
 *
 * @param {{ prs?:object[], launchedNums?:Array<*>, liveCiHealGuards?:object[], ciHealAttempts?:object, prCiHealCounts?:object, retryCap?:number, availableLanes?:Array<*>, tick:number }} ctx
 * @returns {{ spawns:Array<{pr:number, num:*, lane:*, reason:string}>, newGuards:Array<object>, ciHealAttempts:object, consumedLanes:Array<*>, notes:Array<object> }}
 */
export function planCiHealSpawns({ prs = [], launchedNums = [], liveCiHealGuards = [], ciHealAttempts = {}, prCiHealCounts = {}, retryCap = DEFAULT_CI_HEAL_RETRY_CAP, availableLanes = [], tick = 0, now = null } = {}) {
  const launched = new Set((Array.isArray(launchedNums) ? launchedNums : []).map(normNum));
  const guardedPrs = new Set((Array.isArray(liveCiHealGuards) ? liveCiHealGuards : []).map((g) => Number(g.pr)));
  const nextAttempts = { ...(ciHealAttempts && typeof ciHealAttempts === 'object' ? ciHealAttempts : {}) };
  const durable = prCiHealCounts && typeof prCiHealCounts === 'object' ? prCiHealCounts : {};
  const lanes = [...(Array.isArray(availableLanes) ? availableLanes : [])];
  const spawns = [];
  const newGuards = [];
  const consumedLanes = [];
  const notes = [];

  for (const p of Array.isArray(prs) ? prs : []) {
    if (!isCiHealTarget(p)) continue;
    if (!launched.has(normNum(p.num))) continue; // only PRs THIS conveyor launched
    const pr = Number(p.prNumber);
    if (!pr) continue;
    if (guardedPrs.has(pr)) continue; // a CI-heal agent for this PR is already live
    // DURABLE re-heal-comment count is the restart-surviving floor; the in-session tally the within-session overlay
    // (it alone catches a heal that died before posting its comment). The cap binds on whichever is higher (#2643).
    const attempts = Math.max(Number(nextAttempts[pr]) || 0, Number(durable[pr]) || 0);
    if (attempts >= retryCap) {
      notes.push({ kind: 'ci-heal-exhausted', num: p.num, pr, attempts, text: `PR #${pr} (#${p.num}) went red/BEHIND ${attempts}× — auto CI-heal exhausted, run /review ${pr}` });
      continue;
    }
    if (lanes.length === 0) { notes.push({ kind: 'ci-heal-no-lane', num: p.num, pr, text: `no free lane to CI-heal PR #${pr}` }); continue; }
    const lane = lanes.shift();
    consumedLanes.push(lane);
    guardedPrs.add(pr);
    nextAttempts[pr] = attempts + 1;
    const reason = isRedCi(p) ? 'red-ci' : 'behind';
    spawns.push({ pr, num: p.num, lane, reason });
    newGuards.push({ pr, num: p.num, lane, ...spawnStamp(tick, now) });
  }
  return { spawns, newGuards, ciHealAttempts: nextAttempts, consumedLanes, notes };
}

/**
 * RETIRE the in-flight CI-HEAL guard ENTRIES (SKILL §3c-ci — the ENTRY only, never the attempt counter). Mirrors
 * {@link retireFixGuards}: an entry retires when its PR is no longer a CI-heal target ({@link isCiHealTarget} false —
 * CI recovered to non-red / no-longer-BEHIND, or the PR went terminal — reason `resolved`) or on TTL (`ttlTicks`,
 * the heal agent died before re-pushing — reason `ttl`, still gated by the retry cap on the next spawn so a
 * repeatedly-dying heal still terminates at the human). The per-PR attempt counter is NOT cleared here (it clears
 * only on PR-terminal, via {@link clearTerminalCiHealAttempts}). Pure.
 * @param {Array<{pr:number, num:*, spawnedTick:number}>} ciHealGuards
 * @param {{ prs?:object[], tick:number, ttlTicks?:number }} ctx
 * @returns {{ live:Array<object>, retired:Array<{pr:number, num:*, reason:string, note?:boolean}> }}
 */
export function retireCiHealGuards(ciHealGuards, { prs = [], tick = 0, now = null, ttlTicks = DEFAULT_CI_HEAL_TTL_TICKS } = {}) {
  const byPr = new Map();
  for (const p of Array.isArray(prs) ? prs : []) if (p?.prNumber != null) byPr.set(Number(p.prNumber), p);
  const live = [];
  const retired = [];
  for (const g of Array.isArray(ciHealGuards) ? ciHealGuards : []) {
    if (!g || g.pr == null) continue;
    const prRow = byPr.get(Number(g.pr));
    const stillTarget = prRow && isCiHealTarget(prRow);
    if (!stillTarget) { retired.push({ pr: Number(g.pr), num: g.num, reason: 'resolved' }); continue; }
    if (guardTtlElapsed(g, { tick, now, ttlTicks })) {
      retired.push({ pr: Number(g.pr), num: g.num, reason: 'ttl', note: true });
      continue;
    }
    live.push(g);
  }
  return { live, retired };
}

/**
 * CLEAR the per-PR CI-heal attempt counter for PRs that have reached a TERMINAL state (mirrors
 * {@link clearTerminalFixAttempts} — the counter clears ONLY on merge/close, NEVER on entry retirement). Pure.
 * @param {object} ciHealAttempts  `{ [pr]: count }`
 * @param {object[]} prs  the tick's `state.prs` (open PRs)
 * @returns {object} the pruned counter map
 */
export function clearTerminalCiHealAttempts(ciHealAttempts, prs) {
  const openPrs = new Set((Array.isArray(prs) ? prs : []).filter(isOpenPr).map((p) => Number(p.prNumber)));
  const next = {};
  for (const [pr, count] of Object.entries(ciHealAttempts && typeof ciHealAttempts === 'object' ? ciHealAttempts : {})) {
    if (openPrs.has(Number(pr))) next[pr] = count;
  }
  return next;
}

/**
 * The lane-lease session slug that OWNS item `num`'s open PR — the `--release-session` a merge watcher passes to
 * `pr-watch.mjs` so that, the instant the PR MERGES, pr-watch auto-releases that session's lease(s) in EVERY pool
 * it acquired (`lane-pool release --all-pools --session=<slug>`, which also resets the freed clone to origin/main)
 * — the ghost-lease reclamation #2667 delivered but #2700 wires into the tick. Pure — derived from the num and
 * whether a LIVE prepare guard still holds it:
 *   • a `prepare-decision` guard → `prepare-decision-<num>` (the decision-prepare agent's session, SKILL §3e);
 *   • a `prepare` (scope) guard  → `prepare-<num>` (the scope-prepare agent's session, SKILL §3b);
 *   • otherwise                  → `conveyor-<num>` (the build/delivery agent's session, SKILL §3).
 * A prepare guard stays LIVE from spawn until its scope PR merges, so an OPEN prepare PR always still carries its
 * guard — the kind lookup is reliable for exactly the window a watcher is armed. A fix lease (`fix-<num>`) and any
 * lease this single slug misses (e.g. a build lease still held under a since-merged sibling) ride the periodic
 * lease-reaper backstop (`lease-reaper.mjs`, run each tick, SKILL §4c) — auto-release is the fast path, the reaper
 * the catch-all, exactly as #2667 designed them.
 * @param {*} num  the item number the PR belongs to (raw — a hashed `xNNNNNN` id keeps its form in the slug).
 * @param {Map<string,string>} prepareKindByNum  normNum → prepare-guard `kind` for the live prepare guards.
 * @returns {string}
 */
export function releaseSessionForNum(num, prepareKindByNum) {
  const kind = prepareKindByNum instanceof Map ? prepareKindByNum.get(normNum(num)) : undefined;
  return mintSessionSlug({ kind: ['prepare', 'prepare-decision'].includes(kind) ? kind : 'conveyor', id: num });
}

/**
 * ARM a merge watcher per newly-opened conveyor-launched PR (SKILL §4) and prune the watched set. A watcher is
 * armed for an OPEN `state.prs` row whose `num` this conveyor DISPATCHED this session (`launchedNums` — builds
 * AND prepares) that is not already in `watched`. Each armed entry carries the `releaseSession` slug pr-watch
 * passes as `--release-session` (#2700 — merge-time ghost-lease auto-release; see {@link releaseSessionForNum}).
 * The next watched set is exactly the currently-open conveyor-launched PRs (a merged/closed PR's watcher has
 * already exited, so it drops out). Pure.
 * @param {object[]} prs  the tick's `state.prs`
 * @param {Array<*>} launchedNums  the item nums this conveyor dispatched this session
 * @param {Array<number>} watched  the PR numbers with a live watcher
 * @param {Array<{num:*, kind?:string}>} livePrepareGuards  live prepare guards — supply each armed PR's owning session kind
 * @returns {{ arm:Array<{pr:number, releaseSession:string}>, nextWatched:Array<number> }}
 */
export function armWatchers(prs, launchedNums, watched, livePrepareGuards = []) {
  const launched = new Set((Array.isArray(launchedNums) ? launchedNums : []).map(normNum));
  const already = new Set((Array.isArray(watched) ? watched : []).map(Number));
  const prepareKindByNum = new Map(
    (Array.isArray(livePrepareGuards) ? livePrepareGuards : [])
      .filter((g) => g && g.num != null)
      .map((g) => [normNum(g.num), g.kind || 'prepare']),
  );
  const openConveyorPrs = (Array.isArray(prs) ? prs : [])
    .filter((p) => p && isOpenPr(p) && launched.has(normNum(p.num)) && Number(p.prNumber));
  const seen = new Set();
  const nextWatched = [];
  const arm = [];
  for (const p of openConveyorPrs) {
    const pr = Number(p.prNumber);
    if (seen.has(pr)) continue; // a num with two open PRs → watch each once
    seen.add(pr);
    nextWatched.push(pr);
    if (!already.has(pr)) arm.push({ pr, releaseSession: releaseSessionForNum(p.num, prepareKindByNum) });
  }
  return { arm, nextWatched };
}

/**
 * ASSESS idle-stop (SKILL §6). Stop ONLY when BOTH hold: the queue is EMPTY (no cleared `buildQueued` rows in
 * `state.queue`, no in-flight lanes in `state.lanes`, and no OPEN conveyor-launched PR) AND there has been no
 * operator feedback for `idleWindowMs` (measured `now - lastOperatorTurn`). Deliberately ignores
 * `state.idle.lastQueueAdd` (the drain's queue, not the conveyor queue). When `lastOperatorTurn`/`now` are absent
 * the feedback clock cannot be evaluated → never stops (conservative — a fresh session never idle-stops blind).
 * Pure — the clock is injected.
 * @param {{ queue?:object[], lanes?:object[], prs?:object[], launchedNums?:Array<*>, now?:number|null, lastOperatorTurn?:number|null, idleWindowMs?:number }} ctx
 * @returns {{ stop:boolean, queueEmpty:boolean, idleElapsedMs:(number|null) }}
 */
export function assessIdleStop({ queue = [], lanes = [], prs = [], launchedNums = [], now = null, lastOperatorTurn = null, idleWindowMs = DEFAULT_IDLE_WINDOW_MS } = {}) {
  const launched = new Set((Array.isArray(launchedNums) ? launchedNums : []).map(normNum));
  const clearedCount = (Array.isArray(queue) ? queue : []).filter((r) => r?.buildQueued).length;
  const laneCount = (Array.isArray(lanes) ? lanes : []).length;
  const openConveyorPrCount = (Array.isArray(prs) ? prs : []).filter((p) => p && isOpenPr(p) && launched.has(normNum(p.num))).length;
  const queueEmpty = clearedCount === 0 && laneCount === 0 && openConveyorPrCount === 0;
  const idleElapsedMs = now != null && lastOperatorTurn != null ? Number(now) - Number(lastOperatorTurn) : null;
  const noFeedback = idleElapsedMs != null && idleElapsedMs >= idleWindowMs;
  return { stop: queueEmpty && noFeedback, queueEmpty, idleElapsedMs };
}

/**
 * ROUTE a `pr-watch.mjs` process exit to its mechanical action (SKILL §3 — the watcher already CLASSIFIED the
 * PR; this maps its exit code + the PR's current labels to the branch, so the skill does not re-derive the
 * verdict). Exit codes: 0 merged · 1 error · 2 parked · 3 timeout · 4 closed. A parked PR (2) splits on its
 * label: `review:changes` → dispatch a fix agent; any other review label → surface for `/review`. Pure.
 * @param {number} code  the watcher's process exit code
 * @param {Array<string>} labels  the PR's current labels (from a fresh `state.prs` row / `gh pr view`)
 * @returns {{ action:'merged-freed'|'dispatch-fix'|'surface-review'|'anomaly-closed'|'rearm-timeout'|'error' }}
 */
export function routeWatcherExit(code, labels = []) {
  const ls = Array.isArray(labels) ? labels : [];
  switch (Number(code)) {
    case 0: return { action: 'merged-freed' };
    case 2: return { action: ls.includes(REVIEW_CHANGES_LABEL) ? 'dispatch-fix' : 'surface-review' };
    case 3: return { action: 'rearm-timeout' };
    case 4: return { action: 'anomaly-closed' };
    default: return { action: 'error' }; // 1, or any unknown code
  }
}

/**
 * Build the terse one-line tick status (SKILL §5). Counts are derived from the tick's read + the LIVE
 * bookkeeping so the line is deterministic:
 *   • building — distinct nums that are an in-flight build guard OR an active (non-prepare) leased lane. The
 *     guard half covers only the brief spawn→claim window (the build guard retires at claim), so the leased-lane
 *     half carries the count through the actual build — which needs `state.lanes[].num` populated from the
 *     lane-ports registry (#2616 populates it on `acquire --item`). Where that map is empty the count reflects
 *     only the spawn→claim window (a known undercount, not a miscount — no tick decision reads this line).
 *   • preparing — distinct live prepare-guard nums (scope + decision).
 *   • fixing — live fix-guard entries.
 *   • healing — live CI-heal-guard entries (conveyor PRs gone red/BEHIND after open, #2666).
 *   • queued — cleared `buildQueued` rows NOT already in flight (building/preparing).
 *   • parked — distinct conveyor-launched OPEN PRs carrying any `review:*` label.
 *   • health — `state.health.verdict`; a `warn` appends the flagged lanes.
 *   • infra — `state.infraBlocked` count (only when non-empty).
 *
 * `building` HERE IS NOT `dispatch.builds.length` IN `.conveyor/driver-status.json` — an intentional, DIFFERENT
 * number, not a bug (a live report on 2026-09-14 read the two together as inconsistent — worth naming here so
 * the next reader doesn't re-diagnose the same non-bug). `building` is this tick's TOTAL currently-in-flight
 * build count (guards + leased lanes, carried forward across ticks); `surface.dispatch.builds` (`decisionsOut.
 * spawnBuilds`, `runner.mjs#tickSurface`) is only the builds THIS tick freshly spawned — routinely 0 while
 * `building` stays > 0, whenever nothing new needed dispatching but earlier builds are still running. What WAS
 * a real bug, fixed alongside this comment (#3383 follow-up, see `durableBuildNums`): a phantom `claude agents`
 * registry row (listed, `pid: null`, its real process long dead) used to inflate `building` right along with a
 * genuinely live one, since the durable-floor read below had no way to tell them apart. It now excludes any row
 * a real `ps aux`-backed liveness probe confirms dead, so `building` (and this line) reflect only sessions
 * nothing has disproven — never a stale registry artifact.
 * @returns {string}
 */
/**
 * The status line's own per-tick tallies, factored out of {@link buildStatusLine} so a caller that needs the
 * NUMBERS (not the rendered string) — {@link planTick} attaches this to `decisions.counts` for #3398's
 * supervisor-alerting "idle with a non-empty queue" detector — never has to parse the line's text back apart.
 * Same inputs, same tallies `buildStatusLine` renders; this is the one place that counts them. Pure.
 * @returns {{ building: number, preparing: number, fixing: number, healing: number, queued: number, parked: number, verdict: 'ok'|'warn' }}
 */
export function computeTickCounts({ queue = [], lanes = [], prs = [], health = {}, liveBuildGuards = [], livePrepareGuards = [], liveFixGuards = [], liveCiHealGuards = [], launchedNums = [] } = {}) {
  const prepareNums = new Set((Array.isArray(livePrepareGuards) ? livePrepareGuards : []).map((g) => normNum(g.num)));
  const buildGuardNums = new Set((Array.isArray(liveBuildGuards) ? liveBuildGuards : []).map((g) => normNum(g.num)));
  // Active build lanes = leased lanes whose item is NOT a live prepare (a prepare also leases a lane).
  const buildLaneNums = new Set(
    (Array.isArray(lanes) ? lanes : [])
      .map((l) => (l?.num != null ? normNum(l.num) : null))
      .filter((n) => n && !prepareNums.has(n)),
  );
  const building = new Set([...buildGuardNums, ...buildLaneNums]);
  const inFlight = new Set([...building, ...prepareNums]);
  const queued = (Array.isArray(queue) ? queue : []).filter((r) => r?.buildQueued && !inFlight.has(normNum(r.num))).length;
  const launched = new Set((Array.isArray(launchedNums) ? launchedNums : []).map(normNum));
  const parked = new Set(
    (Array.isArray(prs) ? prs : [])
      .filter((p) => p && isOpenPr(p) && launched.has(normNum(p.num)) && (p.labels || []).some((x) => String(x).startsWith('review:')))
      .map((p) => normNum(p.num)),
  );
  const fixing = (Array.isArray(liveFixGuards) ? liveFixGuards : []).length;
  const healing = (Array.isArray(liveCiHealGuards) ? liveCiHealGuards : []).length;
  const verdict = health?.verdict === 'warn' ? 'warn' : 'ok';
  return { building: building.size, preparing: prepareNums.size, fixing, healing, queued, parked: parked.size, verdict };
}

export function buildStatusLine({ queue = [], lanes = [], prs = [], health = {}, infraBlocked = [], liveBuildGuards = [], livePrepareGuards = [], liveFixGuards = [], liveCiHealGuards = [], launchedNums = [] } = {}) {
  const { building, preparing, fixing, healing, queued, parked, verdict } = computeTickCounts({
    queue, lanes, prs, health, liveBuildGuards, livePrepareGuards, liveFixGuards, liveCiHealGuards, launchedNums,
  });
  let line = `conveyor · ${building} building · ${preparing} preparing · ${fixing} fixing · ${healing} healing · ${queued} queued · ${parked} parked · health ${verdict}`;
  const infra = (Array.isArray(infraBlocked) ? infraBlocked : []).length;
  if (infra) line += ` · ${infra} infra-blocked`;
  if (verdict === 'warn') {
    const stalledLanes = (Array.isArray(health?.stalled) ? health.stalled : []).map((s) => `lane-${s.lane}`).join(' ');
    line += stalledLanes ? ` ⚠ ${stalledLanes}` : ' ⚠';
  }
  return line;
}

/**
 * The top-level PURE composer: a tick's read-only inputs + the conveyor's prior bookkeeping → the tick's
 * mechanical DECISIONS + the NEXT bookkeeping. Same inputs → same output, always. The order is the tick's order:
 * RETIRE stale guards first (so a launch is filtered against only still-live guards), FILTER the launches, then
 * plan the prepare + fix spawns against the free lanes the builds did not take, arm watchers, and assess
 * idle-stop. Every new spawn extends the LIVE guard set and `launchedNums`, so `nextState` is ready to feed the
 * next tick verbatim.
 *
 * @param {{
 *   state: object,                       // the conveyor-state.mjs read: { queue, unshaped, needsSlice, decisions, lanes, prs, health, infraBlocked, ... }
 *   plan?: { launch?:object[], held?:object[] },  // the dispatch-plan.mjs read
 *   freeLanes?: Array<*>,                // free lane ids (lane-pool list --acquirable) — for prepare/fix assignment
 *   bookkeeping?: {                      // the conveyor's prior in-session process state (SKILL §5)
 *     tick?:number, buildGuards?:object[], prepareGuards?:object[], fixGuards?:object[],
 *     fixAttempts?:object, watched?:Array<number>, launchedNums?:Array<*>,
 *   },
 *   signals?: { returnedBuildNums?:Array<*> },  // async events the shell folds in (Agent returns)
 *   prRearmCounts?: object,              // DURABLE per-PR re-arm-comment counts { [pr]: n } — the restart-surviving retry-cap floor (#2643); the IO shell derives it via `countRearmComments`
 *   admission?: { cap?:number, waiting?:Array<{owner:string, lane?:*, num?:*, requestedAt?:string}> },  // #3461 — the heavy-command admission-queue `status` read; each `waiting` entry surfaces as a `waiting-for-capacity` note
 *   liveAgentSessions?: Array<{name?:string}>|Array<string>,  // #3403 — the restart-surviving BUILD-guard floor: `claude agents --json` rows (or plain names), fed through {@link durableBuildNums}
 *   config?: { buildTtlTicks?:number, prepareTtlTicks?:number, fixTtlTicks?:number, fixRetryCap?:number, idleWindowMs?:number, maxConcurrentLanes?:number },
 *   now?: number|null, lastOperatorTurn?: number|null,
 *   dispatchPaused?: boolean,          // #3609 — the manual/emergency dispatch-pause lever's current state
 *   dispatchPausedReason?: string|null,// (dispatch-pause.mjs#isDispatchPaused / readPauseState), read by the IO
 *                                      // shell. When true, NEW spawns are held this tick (build launches
 *                                      // are held upstream instead — dispatch-plan.mjs empties `plan.launch`
 *                                      // to `dispatch-paused` holds, so it arrives empty here too);
 *                                      // already-running lanes/guards/watchers are entirely untouched.
 *   dispatchPausedKinds?: string[]|null,// (epic #3383) the pause's optional KIND SCOPE — `dispatch-pause.mjs`'s
 *                                      // `pausedKinds`. `null`/absent = BLANKET: all six kinds held, which is
 *                                      // what an old-format marker and every boolean-only caller produce, so
 *                                      // their behavior is unchanged. A NON-EMPTY scope holds ONLY the kinds it
 *                                      // names, checked one by one against `TICK_SPAWN_KINDS` — e.g.
 *                                      // `['build','prepare','prepare-decision','investigate']` stops all NEW
 *                                      // item dispatch while `fix`/`ci-heal` keep working already-open PRs.
 * }} input
 * @returns {{ decisions:object, nextState:object }}
 */
export function planTick({ state = {}, plan = {}, freeLanes = [], bookkeeping = {}, signals = {}, prRearmCounts = {}, prCiHealCounts = {}, admission = {}, liveAgentSessions = [], config = {}, now = null, lastOperatorTurn = null, dispatchPaused = false, dispatchPausedKinds = null, dispatchPausedReason = null } = {}) {
  // THE PAUSE, RESOLVED PER KIND (epic #3383). `pausedKinds` is the concrete list this tick holds: `[]` when
  // nothing is paused, all six when the marker declares no scope (an old-format `{paused:true}` file, or any
  // caller that still passes only the boolean — both keep holding everything, unchanged), or exactly the
  // declared subset. Every spawn gate below asks `kindPaused('<kind>')` instead of the old blanket boolean.
  const pausedKinds = resolvePausedKinds({ paused: dispatchPaused === true, pausedKinds: dispatchPausedKinds });
  const kindPaused = (kind) => pausedKinds.includes(kind);
  const cfg = {
    buildTtlTicks: config.buildTtlTicks ?? DEFAULT_BUILD_TTL_TICKS,
    prepareTtlTicks: config.prepareTtlTicks ?? DEFAULT_PREPARE_TTL_TICKS,
    fixTtlTicks: config.fixTtlTicks ?? DEFAULT_FIX_TTL_TICKS,
    fixRetryCap: config.fixRetryCap ?? DEFAULT_FIX_RETRY_CAP,
    ciHealTtlTicks: config.ciHealTtlTicks ?? DEFAULT_CI_HEAL_TTL_TICKS,
    ciHealRetryCap: config.ciHealRetryCap ?? DEFAULT_CI_HEAL_RETRY_CAP,
    idleWindowMs: config.idleWindowMs ?? DEFAULT_IDLE_WINDOW_MS,
    // #xupukxa — the SAME concurrency ceiling dispatch-plan.mjs applies to its own build launches, applied
    // here to prepare/fix/ci-heal spawns (step 3 below) so all four spawn kinds share one budget. Defaults to
    // `Infinity` (unlimited — today's pre-#xupukxa behavior), mirroring dispatch-plan.mjs's own pure-core
    // default: every existing direct caller of this core (unit tests included) keeps its prior unrestricted
    // behavior unless it opts in. The IO shell resolves and passes a real default via
    // `resolveMaxConcurrentLanes` for every live tick.
    maxConcurrentLanes: config.maxConcurrentLanes ?? Infinity,
    stallTicks: config.stallTicks ?? DEFAULT_STALL_TICKS,
    // Live-toggleable, tick-granularity verbose mode (`driver-verbose.mjs`) — resolved by the IO shell each
    // tick (it owns the marker read + countdown) and passed in as a plain boolean, same as every other config
    // knob here; the pure core has no fs of its own.
    verbose: config.verbose === true,
  };
  const tick = Number(bookkeeping.tick) || 0;
  const { queue = [], unshaped = [], needsSlice = [], decisions = [], lanes = [], prs = [], health = {}, infraBlocked = [] } = state;
  // #3567 — the `needs-investigation` holds, read straight off THIS TICK's dispatch plan (not off `state`, the
  // way `unshaped`/`decisions` are): an investigation has no separate state-derivation step (no `prepared`
  // flag to persist), so a freshly-clearable SPAWN candidate is simply "held `needs-investigation` this tick"
  // — see `we:scripts/readiness/dispatch-plan.mjs`'s `item.kind === 'investigation'` branch for the hold.
  const investigations = (Array.isArray(plan.held) ? plan.held : [])
    .filter((h) => h && h.reason === 'needs-investigation' && h.num != null)
    .map((h) => ({ num: h.num }));
  // GUARD RETENTION uses a WIDER set than the spawn candidates above, on purpose (red-team-caught correctness
  // gap): `plan.held`'s reason for a given num can legitimately flip tick to tick — e.g. `blocked`, if a
  // `blockedBy` edge appears on the item WHILE its dispatched investigate agent is still mid-run in its lane
  // (dispatch-plan.mjs's blocked check outranks the investigation branch). Narrowing the GUARD's pending set
  // to `reason === 'needs-investigation'` the same way the SPAWN candidates are narrowed would read that
  // transient reason-flip as "the investigation finished" (retire `scope-committed`), leaving no guard to
  // suppress a SECOND investigate dispatch once the item clears `needs-investigation` again. A num still
  // present ANYWHERE in `plan.held`, under ANY reason, is still an open/active item dispatch-plan is tracking
  // this tick — it drops out of `held` entirely ONLY once resolved (or already-done), which is the real
  // "the investigation is over" signal. Spawn candidates stay narrow (never dispatch a SECOND agent onto a
  // `blocked` item); guard retention stays wide (never lose the guard that is suppressing that second dispatch).
  const investigationsGuardPending = (Array.isArray(plan.held) ? plan.held : [])
    .filter((h) => h && h.num != null)
    .map((h) => ({ num: h.num }));

  // #3849 — the `no-size` holds, read straight off THIS TICK's dispatch plan, same pattern as
  // `needs-investigation` just above (#3567): a no-size item has no separate `state` derivation step either.
  // UNLIKE investigation, it is NOT a distinct spawn kind — it is folded into the SAME `prepare` candidate set
  // as `unshaped` (not a new sink, no new guard `kind`), because #3842's prepare-scope agent already authors a
  // missing size/estimate in the same turn it authors a missing `scope:` — one prepare agent serves both holds.
  // A num held BOTH `unshaped-no-scope` and `no-size` is deduped (dispatch-plan.mjs never emits both for the
  // same item today — `no-size` is checked strictly after the scope gate — but a single spawn per num either way).
  const noSizeHeld = (Array.isArray(plan.held) ? plan.held : [])
    .filter((h) => h && h.reason === 'no-size' && h.num != null)
    .map((h) => ({ num: h.num }));
  const scopeOrSizeNeeded = noSizeHeld.length === 0 ? unshaped : [
    ...(Array.isArray(unshaped) ? unshaped : []),
    ...noSizeHeld.filter((n) => !(Array.isArray(unshaped) ? unshaped : []).some((u) => normNum(u.num) === normNum(n.num))),
  ];

  // 1. RETIRE stale guards FIRST — a launch is then filtered against only still-live guards.
  const build = retireBuildGuards(bookkeeping.buildGuards, {
    lanes, queue, tick, now, ttlTicks: cfg.buildTtlTicks, returnedBuildNums: signals.returnedBuildNums,
  });
  const prepare = retirePrepareGuards(bookkeeping.prepareGuards, {
    unshaped: scopeOrSizeNeeded, decisions, investigations: investigationsGuardPending, prs, tick, now, ttlTicks: cfg.prepareTtlTicks,
  });
  const fix = retireFixGuards(bookkeeping.fixGuards, { prs, lanes, tick, now, ttlTicks: cfg.fixTtlTicks });
  // #3454 — bump fixAttempts HERE, once per guard, exactly when retireFixGuards confirms a REAL attempt (its
  // assigned lane was observed leased) — never speculatively at plan time (that was the phantom-attempt bug).
  // Re-primes off the durable re-arm-comment floor on the first post-restart claim, same as the old plan-time
  // bump used to (#2643) — just moved to the moment the attempt is actually confirmed, not merely proposed.
  let fixAttempts = clearTerminalFixAttempts(bookkeeping.fixAttempts, prs);
  for (const c of fix.newlyClaimed) {
    const pr = Number(c.pr);
    const durableFloor = Number(prRearmCounts?.[pr]) || 0;
    const current = Number(fixAttempts[pr]) || 0;
    fixAttempts = { ...fixAttempts, [pr]: Math.max(current, durableFloor) + 1 };
  }
  const ciHeal = retireCiHealGuards(bookkeeping.ciHealGuards, { prs, tick, now, ttlTicks: cfg.ciHealTtlTicks });
  const ciHealAttempts = clearTerminalCiHealAttempts(bookkeeping.ciHealAttempts, prs);

  // 1b. #3403 — the DURABLE build-guard floor. `build.live` alone is only the in-session bookkeeping, wiped by
  //     a supervisor crash-restart; union in a synthetic guard for every num a live BUILD session (`conveyor-<num>`)
  //     is still reporting, so a restart can never re-launch an already-spawned build just because its in-memory
  //     guard entry is gone. `lane: null` — the durable floor only knows the NUM is live, never re-derives which
  //     lane it landed on — so it suppresses by num only (filterLaunches' lane exclusion never fires on `null`).
  //
  //     STICKY `spawnedTick` (found live-firing the prototype, epic #3383). This block used to re-stamp
  //     `spawnedTick: tick` — the CURRENT tick — every time a num was (re)synthesized here, so its age never
  //     advanced: the moment `retireBuildGuards`' own TTL dropped a stale entry from `build.live`, this block
  //     re-added the SAME num on the SAME tick with a freshly-reset spawnedTick, forever. `claude agents --json`
  //     can keep listing a session well after it actually exited (the same staleness #3454's fix-guard already
  //     has to tolerate on dispatch-lane's pre-flight check) — with no way for its age to ever reach `ttlTicks`,
  //     that alone pinned a phantom entry in `buildGuardNums` permanently, for as long as the stale listing
  //     persisted. Live evidence: a 09-03 restart of `wev-scratch-dispatcher-4` showed `building` stuck at
  //     11-15 for 270+ consecutive ticks against 2 genuinely leased lanes. Reusing the PRIOR tick's own durable
  //     entry for the same num (found in `bookkeeping.buildGuards`, marked by `lane == null`) keeps `spawnedTick`
  //     pinned to when the num was FIRST seen durable-live, so its age finally grows tick over tick.
  const priorDurableSpawnedTick = new Map(
    (Array.isArray(bookkeeping.buildGuards) ? bookkeeping.buildGuards : [])
      .filter((g) => g && g.lane == null && g.num != null)
      .map((g) => [normNum(g.num), { spawnedTick: g.spawnedTick, spawnedAt: g.spawnedAt }]),
  );
  const durableOnly = durableBuildNums(liveAgentSessions)
    .filter((num) => !build.live.some((g) => normNum(g.num) === num));
  const durableBuildGuards = durableOnly.map((num) => ({
    num,
    lane: null,
    // Sticky: keep BOTH the prior tick stamp and (#3383) the prior wall-clock stamp; never re-stamp on re-synthesis.
    ...(priorDurableSpawnedTick.has(num)
      ? { spawnedTick: priorDurableSpawnedTick.get(num).spawnedTick, ...(Number.isFinite(priorDurableSpawnedTick.get(num).spawnedAt) ? { spawnedAt: priorDurableSpawnedTick.get(num).spawnedAt } : {}) }
      : spawnStamp(tick, now)),
  }));
  const buildLive = [...build.live, ...durableBuildGuards];

  // 2. FILTER plan.launch through the live build guard (num OR lane), then record a guard per new build.
  const guardFiltered = filterLaunches(plan.launch, buildLive);
  // #xupukxa — DEFENSE IN DEPTH: dispatch-plan.mjs already caps `plan.launch` against the concurrency ceiling
  // using its OWN, separately-read active-lease count; re-cap here against `lanes.length` (THIS tick's own
  // active-lane read) so a stale plan or a lease-count race between the two subprocess reads can never let
  // builds alone exceed the ceiling — the same ceiling step 3 below also holds prepare/fix/ci-heal spawns to.
  // A build trimmed here is NOT suppressed by the guard (it never got a chance to race a lane); tagged
  // `by: 'capacity-cap'` in `suppressed` so it reads distinctly from a real guard suppression, and surfaced as
  // its own note below rather than silently dropped.
  const buildBudget = capToConcurrency(guardFiltered.spawn, { activeCount: lanes.length, cap: cfg.maxConcurrentLanes });
  const launched = {
    spawn: buildBudget.admitted,
    suppressed: [...guardFiltered.suppressed, ...buildBudget.overflow.map((l) => ({ num: l.num, lane: l.lane, by: 'capacity-cap' }))],
  };
  const newBuildGuards = launched.spawn.map((l) => ({ num: l.num, lane: l.lane, ...spawnStamp(tick, now) }));
  const liveBuildGuards = [...buildLive, ...newBuildGuards];

  // #3403 FOLLOW-UP — the STATUS LINE's "building" tally must not count a durable-floor entry (`lane: null`)
  // that has sat unclaimed past the build guard's own TTL (`cfg.buildTtlTicks`, same constant `retireBuildGuards`
  // already uses for a REAL in-session guard). `liveBuildGuards` itself, `nextState.buildGuards`, and the
  // double-dispatch suppression in `filterLaunches` above are all left carrying the FULL, un-filtered set — the
  // durable floor's actual protective job (never re-dispatch a genuinely still-running session, even one
  // `claude agents --json` never stops listing) stays intact, erring safe exactly as #3403 intended. Only the
  // DISPLAYED count changes: an aged-out synthetic entry that never converted to a real claim stops being
  // reported as "building" — the same "only count once genuinely claimed, let the TTL backstop cover a guard
  // that never gets claimed" shape #3454 already established for the fix guard, applied here to the ONE guard
  // kind (the durable floor) whose synthesis previously had no TTL of its own to inherit.
  const countableBuildGuards = liveBuildGuards.filter(
    (g) => g.lane != null || !guardTtlElapsed({ ...g, spawnedTick: Number.isFinite(g.spawnedTick) ? g.spawnedTick : tick }, { tick, now, ttlTicks: cfg.buildTtlTicks }),
  );

  // 3. The free lanes a prepare/fix may take = free lanes MINUS this tick's build launches MINUS every live
  //    guard's lane (build + prepare + fix) — mirror the build guard's lane exclusion so nothing races a lane.
  const takenLanes = new Set([
    ...launched.spawn.map((l) => String(l.lane)),
    ...liveBuildGuards.map((g) => String(g.lane)),
    ...prepare.live.map((g) => String(g.lane)),
    ...fix.live.map((g) => String(g.lane)),
    ...ciHeal.live.map((g) => String(g.lane)),
  ]);
  let availableLanes = (Array.isArray(freeLanes) ? freeLanes : []).filter((l) => !takenLanes.has(String(l)));

  // 3.5 #xupukxa — trim `availableLanes` to whatever room is left under the SAME concurrency ceiling, counting
  //     both lanes already active BEFORE this tick (`lanes.length`) and this tick's own admitted build launches
  //     (`launched.spawn.length`, capped in step 2 above). Prepare/fix/ci-heal spawns below draw from this
  //     ONE trimmed pool in priority order, so the four spawn kinds combined can never push the tick's total
  //     lane consumption past `cfg.maxConcurrentLanes` — the exact gap the live incident exposed (19 builds +
  //     23 prepare-scope agents, each independently maxing out whatever free lanes the OTHER had not yet taken).
  const capacityBudget = capToConcurrency(availableLanes, {
    activeCount: lanes.length + launched.spawn.length,
    cap: cfg.maxConcurrentLanes,
  });
  availableLanes = capacityBudget.admitted;
  // `notes` is declared further down (step 9) — stash these here and splice them in there, rather than reorder
  // the whole function around one early-arriving note kind.
  const capacityCapNotes = capacityBudget.overflow.map((l) =>
    ({ kind: 'capacity-cap', lane: l, text: `⏸ lane-${l} available but withheld — concurrent-lane cap (${cfg.maxConcurrentLanes}) reached` }));

  // 4. PREPARE spawns (scope + decision + investigation) — union re-dispatch gate, lane exclusion; consume
  //    lanes. #3609 — a manual dispatch-pause holds these too, not just `plan.launch` (which dispatch-plan.mjs
  //    already empties to `dispatch-paused` holds when paused): these spawns are computed straight off
  //    `state.unshaped` (unioned with this tick's own `no-size` holds, #3849) / `state.decisions` /
  //    `state.investigations` / `state.prs`, never off `plan.launch`, so
  //    this tick's OWN `dispatchPaused` input — not a re-read of `plan.held` — is what gates them. Already-live
  //    guards are untouched either way.
  //    KIND-SCOPED (epic #3383): the three prepare-family kinds are held INDEPENDENTLY. `pausedKinds` is handed
  //    straight to `planPrepareSpawns`, so a held kind short-circuits at its OWN `dispatch-paused` admission gate
  //    (traced, #xupukxa) and consumes no lane — an UNHELD sibling kind still gets the lanes it would have had.
  const prep = planPrepareSpawns({
    unshaped: scopeOrSizeNeeded,
    decisions,
    investigations,
    prs,
    livePrepareGuards: prepare.live,
    availableLanes,
    tick,
    now,
    trace: true,
    pausedKinds,
  });
  const consumed = new Set(prep.consumedLanes.map(String));
  availableLanes = availableLanes.filter((l) => !consumed.has(String(l)));
  const livePrepareGuards = [...prepare.live, ...prep.newGuards];

  // 5. `launchedNums` grows with every dispatch (build + prepare) — the set watcher-arming scopes to.
  const launchedNums = Array.from(new Set([
    ...(Array.isArray(bookkeeping.launchedNums) ? bookkeeping.launchedNums.map(normNum) : []),
    ...launched.spawn.map((l) => normNum(l.num)),
    ...prep.scopeSpawns.map((s) => normNum(s.num)),
    ...prep.decisionSpawns.map((s) => normNum(s.num)),
    ...prep.investigationSpawns.map((s) => normNum(s.num)),
  ]));

  // 6. FIX spawns — conveyor-launched `review:changes` PRs, gated by in-flight test + retry cap; consume lanes.
  //    #3609 — held by the same manual dispatch-pause as step 4; `fixAttempts` passes through UNCHANGED (no new
  //    attempt is spawned to count) rather than being recomputed by `planFixSpawns`.
  const fixPlan = kindPaused('fix')
    ? { spawns: [], newGuards: [], fixAttempts, consumedLanes: [], notes: [] }
    : planFixSpawns({ prs, launchedNums, liveFixGuards: fix.live, fixAttempts, prRearmCounts, retryCap: cfg.fixRetryCap, availableLanes, tick, now });
  const liveFixGuards = [...fix.live, ...fixPlan.newGuards];
  const fixConsumed = new Set(fixPlan.consumedLanes.map(String));
  availableLanes = availableLanes.filter((l) => !fixConsumed.has(String(l)));

  // 6b. CI-HEAL spawns — conveyor-launched PRs gone RED / BEHIND after a green open (#2666). The SIBLING of the
  //     fix loop: same entry + counter + cap shape, CI-regression trigger, and the heal repairs ONLY CI — never the
  //     review label. Uses the lanes the builds/prepares/fixes did not take, gated by in-flight test + retry cap.
  //    #3609 — held by the same manual dispatch-pause as steps 4/6; `ciHealAttempts` passes through UNCHANGED.
  const ciHealPlan = kindPaused('ci-heal')
    ? { spawns: [], newGuards: [], ciHealAttempts, consumedLanes: [], notes: [] }
    : planCiHealSpawns({ prs, launchedNums, liveCiHealGuards: ciHeal.live, ciHealAttempts, prCiHealCounts, retryCap: cfg.ciHealRetryCap, availableLanes, tick, now });
  const liveCiHealGuards = [...ciHeal.live, ...ciHealPlan.newGuards];

  // 7. WATCHERS — one per open conveyor-launched PR; prune to currently-open conveyor PRs. Each armed entry
  //    carries the `releaseSession` slug pr-watch passes as `--release-session` (#2700 merge-time auto-release),
  //    derived from the live prepare guards (a prepare PR's session differs from a build PR's).
  const watch = armWatchers(prs, launchedNums, bookkeeping.watched, livePrepareGuards);

  // 8. IDLE-STOP — queue-empty AND no operator feedback for the window.
  const idle = assessIdleStop({ queue, lanes, prs, launchedNums, now, lastOperatorTurn, idleWindowMs: cfg.idleWindowMs });

  // 9. Surface notes — the deterministic, no-agent surfaces (§3d epics, §3e prepared decisions) + guard TTL
  //    re-dispatch warnings, gathered so the skill posts them without re-deriving.
  const notes = [...capacityCapNotes];
  // #3609 — ONE aggregate note for the manual dispatch-pause (rather than per-spawn-kind notes each spawn
  // planner would otherwise emit): the individual `plan.held` items already carry their own per-num
  // `dispatch-paused` note below, so this note covers only what those DON'T — the tick's own prepare/fix/
  // ci-heal spawns, which never had a `plan.held` row to begin with (see steps 4/6/6b above).
  // KIND-SCOPED (epic #3383): a BLANKET pause keeps the exact wording it has always had; a SCOPED one names
  // what it actually holds, so the note can never say "no new fix spawns" while fix is demonstrably running.
  if (pausedKinds.length > 0) {
    const why = dispatchPausedReason ? ` (${dispatchPausedReason})` : '';
    const heldHere = TICK_SPAWN_KINDS.filter(kindPaused);
    let text;
    if (!isScopedPause({ paused: true, pausedKinds: dispatchPausedKinds })) {
      text = `⏸ dispatch paused — no new prepare/fix/ci-heal spawns this tick${why}`;
    } else if (heldHere.length > 0) {
      text = `⏸ dispatch paused for ${pausedKinds.join(', ')} — no new ${heldHere.join('/')} spawns this tick${why}`;
    } else {
      // Only `build` is held, and builds are gated UPSTREAM (dispatch-plan.mjs empties `plan.launch`) — say so
      // rather than claim this tick withheld spawns it never had a reason to withhold.
      text = `⏸ dispatch paused for ${pausedKinds.join(', ')} — build launches held upstream; every prepare/fix/ci-heal spawn kind still runs${why}`;
    }
    notes.push({ kind: 'dispatch-paused', text });
  }
  // #xupukxa — a build trimmed by the SAME concurrency ceiling (step 2) is surfaced too, not just the
  // available-lane withholding above: an operator watching the status line otherwise sees a ready build
  // silently vanish rather than being told why.
  for (const s of launched.suppressed) {
    if (s.by === 'capacity-cap') notes.push({ kind: 'capacity-cap', num: s.num, text: `⏸ #${s.num} — capacity-cap (concurrent-lane cap ${cfg.maxConcurrentLanes} reached)` });
  }
  for (const r of build.retired) if (r.note) notes.push({ kind: 'build-ttl', num: r.num, text: `⚠ #${r.num} never claimed after ${cfg.buildTtlTicks} ticks — re-dispatching` });
  for (const r of prepare.retired) if (r.note) notes.push({ kind: 'prepare-ttl', num: r.num, text: `⚠ prepare #${r.num} produced no PR in ${cfg.prepareTtlTicks} ticks — re-dispatching` });
  // #3454 — an UNCLAIMED TTL (dispatch-lane.mjs's own in-flight guard refused it pre-flight, or it died before
  // ever acquiring a lane) reads distinctly from a CLAIMED one (a real agent started, then went silent) — the
  // former burned no retry budget and says so; the latter already counted toward the cap (see `newlyClaimed`).
  for (const r of fix.retired) {
    if (!r.note) continue;
    if (r.reason === 'ttl-unclaimed') {
      notes.push({ kind: 'fix-ttl-unclaimed', num: r.num, pr: r.pr, text: `⚠ fix dispatch for PR #${r.pr} (#${r.num}) never claimed a lane after ${cfg.fixTtlTicks} ticks — re-dispatching (no attempt counted)` });
    } else {
      notes.push({ kind: 'fix-ttl', num: r.num, text: `⚠ fix for PR carrying #${r.num} stalled ${cfg.fixTtlTicks} ticks — re-dispatch allowed` });
    }
  }
  for (const r of ciHeal.retired) if (r.note) notes.push({ kind: 'ci-heal-ttl', num: r.num, text: `⚠ CI-heal for PR carrying #${r.num} stalled ${cfg.ciHealTtlTicks} ticks — re-dispatch allowed` });
  if (prep.scopeSpawns.length) notes.push({ kind: 'auto-preparing-scope', nums: prep.scopeSpawns.map((s) => s.num), text: `⚠ ${prep.scopeSpawns.length} auto-preparing scope: ${prep.scopeSpawns.map((s) => `#${s.num}`).join(' ')}` });
  if (prep.investigationSpawns.length) notes.push({ kind: 'auto-investigating', nums: prep.investigationSpawns.map((s) => s.num), text: `⚠ ${prep.investigationSpawns.length} auto-investigating: ${prep.investigationSpawns.map((s) => `#${s.num}`).join(' ')}` });
  notes.push(...prep.notes.map((n) => ({ kind: n.kind, num: n.num, text: n.text })));
  notes.push(...fixPlan.notes.map((n) => ({ kind: n.kind, num: n.num, pr: n.pr, text: n.text })));
  notes.push(...ciHealPlan.notes.map((n) => ({ kind: n.kind, num: n.num, pr: n.pr, text: n.text })));
  for (const e of Array.isArray(needsSlice) ? needsSlice : []) notes.push({ kind: 'needs-slice', num: e.num, epicState: e.epicState, text: `⚠ epic #${e.num} needs slicing (/slice ${e.num})` });
  for (const d of Array.isArray(decisions) ? decisions : []) if (d?.prepared === true) notes.push({ kind: 'decision-ready', num: d.num, text: `⚖ decision #${d.num} ready to ratify (/next decision)` });
  // HELD — surface every OTHER held-plan reason (the telemetry-gap fix, see the file header): `overlaps lane-<n>`,
  // `no free lane`, `cleared-but-not-ready`, and (defense-in-depth) `blocked`. `needs-slice` / `needs-decision` /
  // `unshaped-no-scope` are skipped — they already have their own dedicated note above/below (see
  // HELD_NOTE_EXCLUDED_REASONS) — so a held item is never reported under two note kinds. Mirrors dispatch-plan.mjs's
  // own CLI text (`⏸ #<num> — <reason>`) so the tick's own output answers "why not" without a human separately
  // running `dispatch-plan.mjs --json` by hand.
  const heldEntries = [];
  for (const h of Array.isArray(plan.held) ? plan.held : []) {
    if (!h || h.num == null || HELD_NOTE_EXCLUDED_REASONS.includes(h.reason)) continue;
    notes.push({ kind: 'held', num: h.num, reason: h.reason, text: `⏸ #${h.num} — ${h.reason}` });
    heldEntries.push({ num: h.num, reason: h.reason });
  }
  // SELF-DIAGNOSED STALL (2026-09-14, #3521/lane-2 incident — see {@link advanceHeldStall}'s header). The tick
  // diagnoses ITS OWN lack of progress here: the same item held on the same reason `cfg.stallTicks` ticks
  // running gets an explicit `stalled` note (and a structured `decisions.stalled` entry below) — a fact the
  // driver reports about itself, not something an external inspector has to reconstruct from raw tick history.
  const heldStall = advanceHeldStall(bookkeeping.heldStall, heldEntries, cfg.stallTicks);
  for (const s of heldStall.stalled) {
    notes.push({
      kind: 'stalled', num: s.num, reason: s.reason, ticks: s.ticks,
      text: `🛑 #${s.num} stuck ${s.ticks} consecutive ticks on: ${s.reason} — self-diagnosed stall, needs attention`,
    });
  }
  // HEALTH — the stall scan is LIVE now (#2616 populates the lane→num map on `acquire --item`), so `state.health`
  // flags a genuinely stalled lane instead of always reading `ok`. Surface each stalled lane as an actionable note
  // (the status line already shows the aggregate `⚠ lane-N` warn): the per-tick lease-reaper (SKILL §4c) reclaims
  // the stalled lane's lease on its TTL-stale axis, so the health verdict is now a real backstop, not the inert
  // signal the SKILL used to forbid relying on. This SURFACES + RECLAIMS; it never auto-re-dispatches a guard —
  // the stall threshold (3 min) is far shorter than a guard's spawn-to-death TTL, so acting on it as a re-dispatch
  // trigger would false-positive on a legitimately-quiet live agent (the guard TTLs stay the re-dispatch backstop).
  for (const s of Array.isArray(health?.stalled) ? health.stalled : []) {
    notes.push({ kind: 'lane-stalled', num: s.num, lane: s.lane, idleS: s.idleS, text: `⚠ lane-${s.lane} (#${s.num}) stalled ${s.idleS}s — the lease-reaper reclaims its lease once it passes the reaper TTL; investigate if it recurs` });
  }
  // DEGRADED-INFRA — the clustered outage signal #2661 collapsed onto `state.health.degradedInfra`: ONE entry per
  // shared external cause ({ cause, count, members }), so several lanes down on the SAME outage read as ONE event,
  // not N alarms. Surface ONE note PER CLUSTER (cause + affected-lane count) — distinct from the per-lane
  // `lane-stalled` note above: an infra-blocked lane is NOT a stall (its work is pushed + auto-retrying, #2659),
  // and the whole point of the cluster is that the operator sees the outage once, not once per waiting lane. This
  // is the tick-note half of the same signal the status board already renders as its #2660 OUTAGE banner. Purely
  // ADDITIVE — degradedInfra does not flip `verdict`, so this never changes idle-stop or the health warn.
  for (const c of Array.isArray(health?.degradedInfra) ? health.degradedInfra : []) {
    if (!c || !c.cause) continue;
    // #2661 guarantees a numeric `count`; fall back to the members length (then 0) so a malformed cluster never
    // renders "undefined lanes" — defensive only, the input contract makes the fallback unreachable today.
    const count = Number.isFinite(c.count) ? c.count : (Array.isArray(c.members) ? c.members.length : 0);
    notes.push({ kind: 'degraded-infra', cause: c.cause, count, text: `⚠ outside dependency degraded — ${count} lane${count === 1 ? '' : 's'} waiting on ${c.cause} (auto-retrying)` });
  }
  // WAITING-FOR-CAPACITY (#3461) — the heavy-command admission queue's live queue, ONE note per blocked owner.
  // Distinct from #3451's after-the-fact call-visibility telemetry: this is a LIVE, pollable "still waiting"
  // fact re-derived every tick from `admission.waiting` (never a bookkeeping entry), so it clears itself for
  // free the moment the blocked caller wins a slot and removes its marker — the very next tick's read simply
  // no longer includes it. `num` is resolved off `state.lanes` (the SAME lane→item map `lane-stalled` above
  // reads) when the waiting entry only carries a `lane`; a caller-supplied `num` (e.g. a non-lane owner) wins
  // when present.
  for (const w of Array.isArray(admission.waiting) ? admission.waiting : []) {
    if (!w) continue;
    const laneEntry = w.lane != null ? (Array.isArray(lanes) ? lanes : []).find((l) => String(l?.lane) === String(w.lane)) : null;
    const num = w.num ?? laneEntry?.num ?? null;
    const where = w.lane != null ? `lane-${w.lane}` : String(w.owner || 'unknown');
    notes.push({
      kind: 'waiting-for-capacity', num, lane: w.lane ?? null,
      text: `⏳ ${where}${num != null ? ` (#${num})` : ''} waiting for heavy-command capacity (cap ${admission.cap ?? '?'})`,
    });
  }

  // Both status computations read `countableBuildGuards` (see its own comment above), NOT the raw
  // `liveBuildGuards` — the DISPLAYED "building" tally excludes an aged-out, never-claimed durable-floor entry;
  // `nextState.buildGuards` below still carries the full `liveBuildGuards`, so the double-dispatch suppression
  // itself is unaffected.
  const statusLine = buildStatusLine({
    queue, lanes, prs, health, infraBlocked, liveBuildGuards: countableBuildGuards, livePrepareGuards, liveFixGuards, liveCiHealGuards, launchedNums,
  });
  // #3398 — the numeric tallies behind the line above, structured (not re-parsed from `statusLine`'s text) so
  // the supervisor's out-of-band alerting can tell "queued > 0 yet nothing dispatched, tick after tick" apart
  // from a genuinely empty queue, over its own JSONL history.
  const counts = computeTickCounts({
    queue, lanes, prs, health, liveBuildGuards: countableBuildGuards, livePrepareGuards, liveFixGuards, liveCiHealGuards, launchedNums,
  });

  const decisionsOut = {
    // Carry the planner's evidence verbatim; a reporter must never reconstruct its gates.
    admission: {
      queue,
      cleared: Array.isArray(plan.cleared) ? plan.cleared : null,
      selection: Array.isArray(plan.selection) ? plan.selection : [],
      held: Array.isArray(plan.held) ? plan.held : [],
      planned: Array.isArray(plan.launch) ? plan.launch : [],
      traces: Array.isArray(plan.admission) ? plan.admission : [],
      prepare: prep.admission ?? [],
    },
    counts,
    spawnBuilds: launched.spawn,
    suppressedBuilds: launched.suppressed,
    spawnPrepareScope: prep.scopeSpawns,
    spawnPrepareDecision: prep.decisionSpawns,
    spawnInvestigations: prep.investigationSpawns,
    spawnFixes: fixPlan.spawns,
    spawnCiHeals: ciHealPlan.spawns,
    armWatchers: watch.arm,
    retireGuards: { build: build.retired, prepare: prepare.retired, fix: fix.retired, ciHeal: ciHeal.retired },
    idleStop: idle.stop,
    idle,
    statusLine,
    notes,
    // Structured (not re-parsed from a `stalled`-kind note's text) — the SAME "give the supervisor a real
    // field, not text to grep" discipline `counts` already applies (#3398's own comment, just above).
    stalled: heldStall.stalled,
    // #3567 — investigation spawns get their own dispatch route (`decisions.spawnInvestigations`), read by
    // `we:scripts/operations/dispatch-lane-io.mjs`'s `['investigate', decisions.spawnInvestigations]` route.
    // Must stay on `decisionsOut` (not just the pre-refactor inline return object) or investigation dispatch
    // silently sees `undefined` and launches nothing.
    spawnInvestigations: prep.investigationSpawns,
  };
  // #3521 decision-trace (v1) — a plain-language "why", built from what's already computed above; never a
  // second source of truth for any of it (see {@link buildDecisionTrace}). `allHeld` is the UNFILTERED
  // `plan.held` (before the terse loop's HELD_NOTE_EXCLUDED_REASONS drop) — only verbose mode reads it.
  decisionsOut.decisionTrace = buildDecisionTrace(decisionsOut, {
    verbose: cfg.verbose,
    allHeld: Array.isArray(plan.held) ? plan.held : [],
    lanes,
  });

  return {
    decisions: decisionsOut,
    nextState: {
      tick: tick + 1,
      buildGuards: liveBuildGuards,
      prepareGuards: livePrepareGuards,
      fixGuards: liveFixGuards,
      fixAttempts: fixPlan.fixAttempts,
      ciHealGuards: liveCiHealGuards,
      ciHealAttempts: ciHealPlan.ciHealAttempts,
      watched: watch.nextWatched,
      launchedNums,
      heldStall: heldStall.nextHeldStall,
    },
  };
}

/**
 * The extra `--repo=` argument (if any) the free-lane list read needs so a tick's capacity accounting reflects
 * the TARGET repo's own lane pool — never always WE's. #xr4ygg7 (multi-repo slice 9, we:reports/2026-09-23-
 * conveyor-multi-repo-gap-map.md) — `main()`'s free-lane read (`lane-pool.mjs list --acquirable --json`) never
 * threaded this shell's own `--repo` flag through, unlike every other subprocess call it makes (conveyor-state,
 * the gh PR-comment reads, heavy-admission) — so a tick invoked with `--repo=frontierui` (or `plateau-app`)
 * still counted only the WE pool's free lanes, silently mis-sizing capacity for a repo whose fix/ci-heal spawns
 * draw from an entirely different pool (the gap-map's "tick capacity counts only the WE pool" row).
 *
 * PURE given the injected profile resolver, mirroring this file's own "no node: import in the pure core"
 * convention: `main()` resolves `repoProfile` via a dynamic `import()` (same as every other IO-adjacent helper
 * it pulls in — `rearm-review.mjs`, `dispatch-pause.mjs`, `driver-verbose.mjs`, …) and hands it in here, rather
 * than this file importing `repo-profile.mjs` at the top.
 *
 * Returns `[]` (no change to the call) whenever `repoFlag` is absent/not a string, resolves to no known
 * profile, or resolves to the WE profile itself — i.e. every invocation in production TODAY (nothing currently
 * calls this shell with `--repo=`), so this is a zero-behavior-change addition until a caller actually opts in.
 * @param {unknown} repoFlag - the raw `--repo` CLI value, or undefined/not-a-string.
 * @param {(v:unknown) => ({key:string, lanePoolRepo:string}|null)} resolveProfile - `repo-profile.mjs#repoProfile`.
 * @returns {string[]} `[]`, or a single `--repo=<lanePoolRepo>` element.
 */
export function lanePoolListArgsForRepo(repoFlag, resolveProfile) {
  if (typeof repoFlag !== 'string' || !repoFlag || typeof resolveProfile !== 'function') return [];
  const profile = resolveProfile(repoFlag);
  if (!profile || profile.key === 'we') return [];
  return [`--repo=${profile.lanePoolRepo}`];
}

// ── IO SHELL (runs only as a CLI — owns all child_process; keeps the pure core import-clean) ──────────────────

/** Read all of STDIN as a string (the SESSION-EPHEMERAL bookkeeping is piped in — never a committed repo store). */
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const HERE = dirname(fileURLToPath(import.meta.url));
  const STATE_CLI = join(HERE, '..', 'readiness', 'conveyor-state.mjs');
  const PLAN_CLI = join(HERE, '..', 'readiness', 'dispatch-plan.mjs');
  const LANE_POOL_CLI = join(HERE, '..', 'lane-pool.mjs');
  const ADMISSION_CLI = join(HERE, '..', 'readiness', 'heavy-admission.mjs');

  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const fail = (m) => { process.stderr.write(`✗ ${m}\n`); process.exit(1); };

  // Verbose-mode "timing breakdown per sub-step" (#3521 decision-trace v1, follow-up) — an HONEST measurement
  // of the IO shell's OWN sub-steps (never a synthetic/invented internal), so verbose mode can show where a
  // tick's wall-clock actually went. `time()` wraps a step; `timings` collects `{label: ms}` for the tick's own
  // `main()` reads (state, plan, lane-pool list, admission status, the PR-comment-reads loop as one aggregate).
  const timings = {};
  const time = (label, fn) => {
    const t0 = Date.now();
    try { return fn(); } finally { timings[label] = (timings[label] || 0) + (Date.now() - t0); }
  };

  const runJson = (cmd, args, what) => {
    let out;
    try {
      // #x5n4zn3 — was bare (no timeout): this is the tick's read of `conveyor-state.mjs`/`dispatch-plan.mjs`/
      // `lane-pool.mjs list --acquirable` — literally the class of hang #3383 filed this whole rollout for
      // (a hung `list --acquirable` burning the drain's whole 45-min pass cap).
      out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: resolveChildTimeoutMs() * 2, killSignal: 'SIGKILL' });
    } catch (e) {
      fail(`${what} failed: ${String(e.message || e).split('\n')[0]}`);
    }
    try { return JSON.parse(out); }
    catch (e) { fail(`could not parse ${what} JSON: ${String(e.message || e).split('\n')[0]}`); }
  };

  // The SESSION-EPHEMERAL bookkeeping is piped in on STDIN (SKILL §5: no on-disk parallel state store). A first
  // tick with no prior bookkeeping pipes nothing / `{}` — every field then defaults to empty in the pure core.
  let bookkeeping = {};
  let signals = {};
  let config = {};
  let lastOperatorTurn = null;
  if (!process.stdin.isTTY) {
    const raw = (await readStdin()).trim();
    if (raw) {
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { fail(`could not parse STDIN bookkeeping JSON: ${String(e.message || e).split('\n')[0]}`); }
      bookkeeping = parsed.bookkeeping || parsed || {};
      signals = parsed.signals || {};
      config = parsed.config || {};
      lastOperatorTurn = parsed.lastOperatorTurn ?? null;
    }
  }
  // #xupukxa — resolve the concurrency ceiling from env exactly like dispatch-plan.mjs's own IO shell, unless
  // the caller's piped-in bookkeeping already named one explicitly (an operator override rides through
  // `config.maxConcurrentLanes` on STDIN same as any other config knob).
  if (config.maxConcurrentLanes == null) config.maxConcurrentLanes = resolveMaxConcurrentLanes(process.env);

  const stateArgs = ['--json'];
  const planArgs = ['--json'];
  if (typeof flags.repo === 'string') { stateArgs.push(`--repo=${flags.repo}`); }
  // `--backlog-dir` (#3445) points BOTH children at a fixture corpus instead of the live `backlog/` directory
  // — the dispatcher-fixture-root thread (#3402) that lets a harness test validate this whole
  // state → plan → tick chain against a synthetic corpus rather than production.
  if (typeof flags['backlog-dir'] === 'string') {
    stateArgs.push(`--backlog-dir=${flags['backlog-dir']}`);
    planArgs.push(`--backlog-dir=${flags['backlog-dir']}`);
  }
  const state = time('stateReadMs', () => runJson('node', [STATE_CLI, ...stateArgs], 'conveyor-state'));
  const plan = time('planReadMs', () => runJson('node', [PLAN_CLI, ...planArgs], 'dispatch-plan'));

  // Free lane ids — the same acquirable picker dispatch-plan's shell uses (ascending, deterministic assignment).
  // #xr4ygg7 — the free-lane read must reflect flags.repo's OWN pool, exactly like every other subprocess call
  // in this shell already threads `--repo=${flags.repo}` through (see `lanePoolListArgsForRepo`'s own docblock).
  const { repoProfile } = await import('../lib/repo-profile.mjs');
  const lanePoolListArgs = ['list', '--acquirable', '--json', ...lanePoolListArgsForRepo(flags.repo, repoProfile)];
  const paths = time('lanePoolListMs', () => runJson('node', [LANE_POOL_CLI, ...lanePoolListArgs], 'lane-pool list'));
  const freeLanes = (Array.isArray(paths) ? paths : [])
    .map((p) => { const m = /lane-(\d+)\/?$/.exec(String(p)); return m ? Number(m[1]) : null; })
    .filter((n) => n != null)
    .sort((a, b) => a - b);

  // #3403 — DURABLE build-guard floor: the live `claude agents --json` listing, fed to `durableBuildNums` inside
  // `planTick`. Best-effort like the `gh` comment reads below — a failure (no `claude` on PATH, a timeout) leaves
  // the floor unset (`[]`); the in-session guard + its TTL still cover the common case, exactly as an unset
  // `prRearmCounts` floor leaves the in-session `fixAttempts` tally as the sole guard.
  let liveAgentSessions = [];
  try {
    const { defaultListAgents } = await import('../operations/dispatch-lane-io.mjs');
    liveAgentSessions = defaultListAgents({});
    // #3383 FOLLOW-UP — resolve REAL pid liveness for this same listing, feeding `durableBuildNums`'s new
    // `pidAlive === false` exclusion (see its own doc): a live audit found `conveyor-*` rows still listed 6-13.5
    // DAYS after their process died, which the durable floor's original "the listing clears itself" assumption
    // never accounted for. ONE `ps aux` scan for the whole batch (never one subprocess per row) — the SAME
    // reused probe `driver-watchdog.mjs`/`lease-reaper.mjs`/`session-reaper.mjs` already share. Best-effort: a
    // scan failure leaves every row's `pidAlive` at `null` (unknown), which `durableBuildNums` already treats
    // exactly like today's un-annotated row — no behavior change on a probe failure.
    if (Array.isArray(liveAgentSessions) && liveAgentSessions.length) {
      const { resolvePidAlive, scanPsOutput, defaultIsPidAlive } = await import('./driver-watchdog.mjs');
      const psOutput = scanPsOutput({});
      liveAgentSessions = liveAgentSessions.map((s) => (
        s && typeof s === 'object' ? { ...s, pidAlive: resolvePidAlive(s, { psOutput, isPidAlive: defaultIsPidAlive }) } : s
      ));
    }
  } catch { /* leave the floor unset — the in-session TTL still guards */ }

  // DURABLE retry-cap floor (#2643): for each OPEN `review:changes` PR, read its re-arm comments off the PR and
  // count them (`countRearmComments`). This is the restart-surviving source of truth for "how many times this PR
  // was auto-fixed" — the in-session `fixAttempts` map is gone after a restart, so without this the cap could
  // never bind on a fresh conveyor. Only `review:changes` PRs are read (rare), so it adds no per-tick gh cost in
  // the common case; a comment read that fails is best-effort (floor 0 — the in-session tally still guards).
  const { countRearmComments } = await import('./rearm-review.mjs');
  const { countCiHealComments } = await import('./ci-heal-mark.mjs');
  const prRearmCounts = {};
  const prCiHealCounts = {};
  // ONE `gh pr view … --json comments` per PR that is EITHER a `review:changes` bounce (fix-loop floor, #2643) OR a
  // CI-heal target (CI-heal floor, #2666). Both durable floors read the SAME comment thread, so a single read serves
  // both counters — a red/BEHIND PR that is also `review:changes` is owned by the fix loop, but reading its comments
  // once and counting both markers costs nothing extra. Both are RARE (a red / bounced PR), so this adds no per-tick
  // gh cost in the common all-green case.
  for (const p of Array.isArray(state?.prs) ? state.prs : []) {
    const labels = Array.isArray(p?.labels) ? p.labels : [];
    const wantsRearm = p?.prNumber && labels.includes('review:changes');
    const wantsCiHeal = p?.prNumber && isCiHealTarget(p);
    if (!wantsRearm && !wantsCiHeal) continue;
    // Best-effort, NON-fatal (unlike `runJson`, which exits the tick on error): a single PR's comment read must
    // never kill the whole tick — on failure the floor stays unset (0) and the in-session tally still binds.
    // Thread `--repo` exactly as the state read does (line above): without it, `gh pr view` resolves the repo from
    // cwd, so in explicit-`--repo` mode every read would 404 → floor 0 → the durable cap silently drops (the very
    // restart bug this fixes, re-exposed for that invocation).
    const prViewArgs = ['pr', 'view', String(p.prNumber), '--json', 'comments'];
    if (typeof flags.repo === 'string') { prViewArgs.push(`--repo=${flags.repo}`); }
    try {
      // #x5n4zn3 — was bare (no timeout); best-effort per-PR read, so a bound here just means one PR's
      // floor stays unset instead of the whole tick stalling on it.
      const raw = time('prCommentReadsMs', () => execFileSync('gh', prViewArgs,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' }));
      const comments = JSON.parse(raw)?.comments;
      if (wantsRearm) prRearmCounts[p.prNumber] = countRearmComments(comments);
      if (wantsCiHeal) prCiHealCounts[p.prNumber] = countCiHealComments(comments);
    } catch { /* leave the floor unset — the in-session tally still guards the cap */ }
  }

  // #3461 — the admission queue's live `status` read. Best-effort (`runJson` exits the whole tick on failure,
  // which a still-forming `.admission` dir before the first heavy command ever ran must NOT trigger) — a read
  // failure degrades to `{}` (no waiting entries surfaced), never kills the tick.
  const admissionArgs = ['status', '--json'];
  if (typeof flags.repo === 'string') { admissionArgs.push(`--repo=${flags.repo}`); }
  let admission = {};
  try {
    // #x5n4zn3 — was bare (no timeout).
    const raw = time('admissionStatusMs', () => execFileSync('node', [ADMISSION_CLI, ...admissionArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' }));
    admission = JSON.parse(raw);
  } catch { /* best-effort — see comment above */ }

  // #3609 — the manual/emergency dispatch-pause marker (best-effort direct import, matching the durable-floor
  // reads above). FAILS OPEN: a missing module or unreadable/corrupt marker leaves `dispatchPaused` false —
  // dispatch-plan.mjs's own IO shell already reads the SAME marker independently for `plan.launch`, so a
  // failure here only affects THIS tick's own prepare/fix/ci-heal spawns, never silently re-arms builds.
  let dispatchPaused = false;
  let dispatchPausedKinds = null;
  let dispatchPausedReason = null;
  if (!flags['no-pause-check']) {
    try {
      const { readPauseState } = await import('../readiness/dispatch-pause.mjs');
      const pauseState = readPauseState();
      dispatchPaused = pauseState.paused === true;
      // epic #3383 — carry the marker's KIND SCOPE through verbatim (`null` = blanket); the pure core resolves
      // it. Flattening it to the boolean here would silently re-widen a scoped pause back to holding all six.
      dispatchPausedKinds = pauseState.pausedKinds ?? null;
      dispatchPausedReason = pauseState.reason || null;
    } catch { /* leave unpaused — fail open, same contract as readPauseState's own try/catch */ }
  }

  // #3521 decision-trace v1 follow-up (2026-09-14) — the LIVE-TOGGLEABLE verbose marker (`driver-verbose.mjs`).
  // Re-read (and its own bounded `--ticks=N` window advanced) every tick, exactly like the dispatch-pause marker
  // just above — a human or another agent can flip a currently-running driver loud without restarting it.
  // FAILS OPEN: a missing module or unreadable/corrupt marker leaves verbose OFF (the terse default never
  // silently becomes noisy from a read failure).
  if (config.verbose == null) {
    try {
      const { readAndAdvanceVerboseState } = await import('../readiness/driver-verbose.mjs');
      config.verbose = readAndAdvanceVerboseState() === true;
    } catch { config.verbose = false; }
  }

  // epic #3383 — dispatchPausedKinds carries the manual-pause marker's KIND SCOPE through verbatim (`null` =
  // blanket pause); dropping it here would silently re-widen a scoped pause back to holding all six kinds.
  const out = planTick({ state, plan, freeLanes, bookkeeping, signals, prRearmCounts, prCiHealCounts, admission, liveAgentSessions, config, now: Date.now(), lastOperatorTurn, dispatchPaused, dispatchPausedKinds, dispatchPausedReason });
  // Verbose-mode timing breakdown (#3521 decision-trace v1 follow-up) — an IO-shell-observed fact, not something
  // the pure core computes; attached only here, after the tick already ran, so a timing read can never affect
  // the decision itself.
  if (config.verbose) out.decisions.timings = timings;
  writeAllSync(1, JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
import { pathToFileURL } from 'node:url';
import { writeAllSync } from '../lib/write-all-sync.mjs';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2));
}

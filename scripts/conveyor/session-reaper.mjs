#!/usr/bin/env node
/**
 * @file scripts/conveyor/session-reaper.mjs
 * @description THE CONVEYOR SESSION REAPER (WE #3435, epic #3383). Walks `claude agents --json` and calls
 *   `claude stop <id>` on every BACKGROUND session that is done producing more work — nothing did this before:
 *   `lease-reaper.mjs` (#2667) reclaims LANE leases, a wholly separate resource from a `claude agents` session
 *   registration. Left undone, every review/fix/build dispatch this epic's own mechanism runs adds one more
 *   entry that stays listed until a human runs `claude stop <id>` by hand — 12 finished `review-*` sessions
 *   plus 4 stale `conveyor-*` ones in one live-fire night alone.
 *
 * MIRRORS `lease-reaper.mjs`'S PURE-CORE / IO-SHELL SPLIT:
 *   • The PURE core ({@link classifySessionReap}, {@link classifySessionReapWithGroundTruth},
 *     {@link sessionReapPlan}, {@link sessionTarget}) has NO fs / exec / clock — every session row (and, for
 *     the ground-truth upgrade, every resolver answer) is passed in exactly as shaped by its caller. Unit-tested
 *     directly on fixtures.
 *   • The IO SHELL (the `main()` CLI) owns the one `claude agents --json` read, the ground-truth resolver's
 *     backlog-file reads and `gh pr view` calls, and the stop delegation to `dispatch-abort.mjs`'s
 *     `stopSession` — the ONE existing `claude stop <id>` wrapper in this repo (built for #3383's own "don't
 *     `kill`, `claude stop`" lesson) — rather than re-shelling `claude` a second way.
 *
 * WHY `done`/`failed` STATE ALONE WAS NOT ENOUGH (found live 2026-09-03, `conveyor-3451`). The original cut of
 * this reaper (above) reasoned that a state-only reap axis was safe by construction because no `done`/`failed`
 * FALSE POSITIVE had ever been observed (a session `claude` itself reports finished that was still actually
 * running) — that reasoning still holds and is UNCHANGED below. What it did not address, because nothing had
 * yet evidenced it, is the opposite failure: a session whose real-world work is genuinely finished — its own
 * backlog item `status: resolved`, a real PR merged — while `claude agents` itself never advances that
 * session's `state` past `working`/`blocked` at all. Confirmed live: `conveyor-3451`'s target,
 * `we:backlog/3451-*.md`, carries `status: resolved` with a merged PR (`chalbert/web-everything#1862`, "WE
 * #3451: resolve — active → resolved"), yet the SAME live `claude agents --json --all` listing that landed
 * that PR still reported `conveyor-3451` as `state: "blocked"` — a session the original state-only axis would
 * never touch. A same-night survey of the other 22 non-`done`/`failed` background rows found 17 in the
 * identical shape (target confirmed `status: resolved`, session state stuck at `working`) against 6 genuinely
 * still-open ones (`conveyor-2786`, `conveyor-3447c`, `prepare-3436`, `prepare-3438`, `prepare-3441`, and
 * `review-1871` — an OPEN, unmerged PR) — real, sizable, not a one-off.
 *
 * THE FIX IS AN ADDITIONAL AXIS, NOT A REPLACEMENT. {@link classifySessionReapWithGroundTruth} upgrades a
 * `not-terminal` verdict to `reap:true` ONLY when an injected ground-truth resolver independently confirms the
 * session's OWN target item/PR (derived from its `name` by {@link sessionTarget}, the same
 * `conveyor-<NUM>`/`prepare-<NUM>`/`prepare-decision-<NUM>`/`review-<PR>`/`fix-<PR>`/`ci-heal-<PR>` grammar
 * `we:scripts/conveyor/lease-reaper.mjs`'s `itemNumFromSession` and `we:scripts/operations/dispatch-lane.mjs`'s
 * `sessionSlugFor` already mint) is done — never on a guess, never widening the original `done`/`failed` axis
 * itself. A session whose name matches no known grammar, or whose target cannot be confirmed one way or the
 * other (an unreadable backlog file, a `gh` failure/timeout), is left exactly as before: `not-terminal`, kept.
 * This mirrors the ground-truth-check pattern `we:backlog/3457-*.md` ratified for the DISPATCH side (never
 * guess, always verify against real backlog/GitHub state before acting) — reused here for REAP, its inverse.
 *
 * COST DISCIPLINE, mirroring `we:scripts/operations/dispatch-lane-io.mjs`'s own `PR_LIST_TIMEOUT_MS`/
 * `PR_LIST_LIMIT` bounds. A backlog-item ground-truth check is one local file read — no rate-limit concern, so
 * it is unbounded. A PR-target check is one real `gh pr view <pr>` network call, bounded two ways: (1) it
 * reuses `dispatch-lane-io.mjs`'s own `prListTimeoutMs` per-call timeout rather than inventing a second knob
 * for the same class of cost (`defaultLaneRefForPr`'s own docblock names this exact reuse), and (2)
 * {@link makeGroundTruthResolver} caps the number of `gh pr view` calls ONE reaper pass will make
 * ({@link MAX_GH_PR_VIEW_CALLS_PER_TICK}) — a candidate past the cap is left `not-terminal` this tick and
 * re-tried the next one, never an unbounded `gh` burst. Every resolver answer is cached per pass too, so two
 * sessions naming the same target (a retried `conveyor-3441b` alongside `conveyor-3441`) cost one lookup.
 *
 * THE THREE TERMINAL STATES, measured live against a real `claude agents --json --all` listing (192 rows,
 * 2026-09-03) rather than assumed: `done` (134), `stopped` (31), `failed` (1) — `working` (21) is the only
 * non-terminal state this environment's own dispatches produced that day; `blocked` is the fixture's own
 * shape (`__fixtures__/claude-agents-payload.json`), also confirmed live the same night on `conveyor-3451`
 * itself. `stopped` needs NO action (the session is already stopped — re-stopping it is a wasted subprocess
 * call, not a correctness issue, since {@link stopSession} treats an already-gone handle as benign; still
 * worth naming so `keep`'s reason distinguishes it from a live one). `done` and `failed` are the two
 * ({@link TERMINAL_REAP_STATES}) the base axis acts on; `working`/`blocked`/undefined are the ones the new
 * ground-truth axis can now ALSO act on, but only when independently confirmed.
 *
 * `kind !== 'background'` IS AN ABSOLUTE GUARD, CHECKED BEFORE STATE OR GROUND TRUTH. The SAME listing that
 * carries every dispatched agent also carries the operator's own INTERACTIVE terminal sessions (`kind:
 * 'interactive'`, `pid` set, no `state` field at all — measured live, 5 of 192 rows). An interactive row never
 * has a `state` of `done`/`failed` today, and its `name` is never one of this reaper's dispatcher-minted
 * grammars either, but the guard is structural, checked first, and never depends on either of those staying
 * true — the blast radius of `claude stop`-ing a human's own open terminal session is categorically worse than
 * leaving a finished background dispatch listed one tick longer.
 *
 * `claude stop`'S REPORTED SUCCESS IS A HINT, NOT A CERTAINTY (found live 2026-09-02, confirmed against
 * upstream `anthropics/claude-code` issues #65925/#45250/#41461): a stop can report success while the local
 * listing keeps reporting the session unchanged. This reaper does not re-poll to confirm — that would add a
 * second `claude agents --json` read (and a race) for a confirmation this repo already knows is unreliable —
 * it logs {@link stopSession}'s own `alreadyGone` distinction and moves on, exactly as best-effort as
 * `lease-reaper.mjs`'s own per-candidate try/catch.
 *
 * WHY `id`, NOT `sessionId` — the near-universal `claude stop` FAILURE `we:backlog/3435-*.md`'s "Found live"
 * finding 3 recorded (all five sessions, including `conveyor-3421b`, came back "No job matching" on `claude
 * stop <sessionId>`) was read at the time as a CLI/registry-staleness limitation, the same family as the
 * success-side note just above. It is not that. It is a wrong-FIELD bug: this loop passed `session.sessionId`
 * (the full listing-internal UUID `claude stop`/`claude rm` do not match on) where it should have passed
 * `session.id` (the short form the CLI actually accepts). Verified live 2026-09-03: a fresh `claude agents
 * --json --all` (208 rows) shows `id` present on all 204 `kind: 'background'` rows and absent on exactly the 4
 * `kind: 'interactive'` ones (a human's own terminal/Remote-Control session — never a row this reaper's `kind
 * !== 'background'` guard, above, would let reach the stop call in the first place). So within this reaper's
 * own domain `id` is always present — never the "absent from half the listing" shape `dispatch-lane-io.mjs
 * #listedSessionIds`'s own docblock measured (correctly, for the FULL mixed listing that function reads; that
 * finding stands, it just does not extend to `kind: 'background'` rows, the only ones this file ever acts on).
 * Direct proof the swap fixes the failure, same session: `claude stop <full sessionId>` on a real `done`
 * session (`conveyor-2972`) exited 1 with "No job matching"; `claude stop <short id>` on the SAME session
 * immediately after exited 0, "stopped". THIS DOES NOT MAKE `claude stop` UNIVERSALLY RELIABLE — a genuinely-
 * already-exited background session can still legitimately answer "No job matching" even given the correct
 * `id` (that is {@link stopSession}'s own documented `alreadyGone` case, expected and benign); today's failure
 * was near-100% and traced to the wrong field, not to occasional legitimate staleness. `main()`'s stop loop
 * below therefore reads `session.id` (never `session.sessionId`) for the actual handle, and treats a missing
 * `id` on a reap candidate as a logged anomaly rather than a silent skip — it should never happen given the
 * `kind !== 'background'` guard above, but "should never happen" is not the same as "cannot happen".
 */

import { parseSessionSlug } from './session-slug.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readField } from '../backlog/frontmatter.mjs';
import { stopSession } from '../operations/dispatch-abort.mjs';
import { defaultListAgents, normalizeHandle, prListTimeoutMs } from '../operations/dispatch-lane-io.mjs';
import { sleepSyncMs } from '../readiness/drain-lock.mjs';
import { applyCompletionUpdate, newCompletionRecord, tryReadCompletion, writeCompletion } from '../operations/completion-store.mjs';
import { readHungInfo, resolveHungThresholdMs } from './hung-session.mjs';
// xf44mm3 (#4075/#3383) — the SAME blocked-on-infra cool-off `reconcile-core.mjs#markSelfReportedDone` binds
// on, reused here (never re-declared) so the reaper's own completion-record axis cannot honor a shorter,
// silently-drifted cool-off of its own. See {@link classifySessionReapWithGroundTruth}'s Axis 1 below for why.
import { INFRA_RETRY_COOLOFF_MS } from './reconcile-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** This file's own checkout root, resolved by SCRIPT LOCATION (never `process.cwd()`) — same convention
 *  `dispatch-lane-io.mjs#REPO_ROOT` / `completion-store.mjs#COMPLETIONS_ROOT` already use, and load-bearing
 *  here for a NEW reason (epic #3383, the daemon split): once a daemon calls this reaper from ITS OWN
 *  dedicated clone (e.g. `we:skills-src/conveyor/review-daemon.mjs` running out of a `wev-review-daemon`
 *  checkout), every `review-*`/`fix-*` session it dispatches inherits that SAME clone as its own `cwd`
 *  (`review-dispatch.mjs`'s `root = REPO_ROOT`, resolved the identical way). So a caller that passes
 *  `allowedCwd: REPO_ROOT` (this constant, computed fresh in whichever checkout is actually running) scopes
 *  reaping to "sessions THIS checkout's own dispatchers spawned" with no hardcoded path and no new
 *  configuration — see {@link classifySessionReap}'s cwd guard below. */
export const REPO_ROOT = join(HERE, '..', '..');

// ── PURE CORE (no fs / exec / clock — every signal is injected) ────────────────────────────────────────────

/** States `claude agents` reports for a session's OWN process that mean "stop it — it is done producing more
 *  work" (see the file header for the live count that grounds this pair). */
export const TERMINAL_REAP_STATES = new Set(['done', 'failed']);

/** States that mean the session is already stopped — nothing to do, kept apart from `not-terminal` so a
 *  caller can tell "already handled" from "still live, leave it alone". */
export const ALREADY_STOPPED_STATES = new Set(['stopped']);

/**
 * The DETERMINISTIC reap verdict for ONE `claude agents --json` row — pure, same row → same verdict. This is
 * the STATE-ONLY axis; see {@link classifySessionReapWithGroundTruth} for the axis that can ALSO reap a
 * `not-terminal` row once its target is independently confirmed done.
 *
 * `allowedCwd` IS A SECOND STRUCTURAL GUARD, CHECKED RIGHT AFTER `kind` (epic #3383 daemon split). A caller
 * that only spawns sessions into ONE dedicated checkout (every daemon in this repo does — see {@link REPO_ROOT}'s
 * own doc) can pass that checkout's root here to scope reaping to "sessions THIS process's own dispatchers
 * spawned", never a session that merely happens to share a name pattern from some other checkout (a lane, the
 * primary tree, a different daemon's clone). Omitting it (the default) makes this byte-identical to the
 * pre-#3383 behavior — additive, never a behavior change for an existing caller that doesn't opt in.
 *
 * @param {object|null} session - one element of a `claude agents --json` listing.
 * @param {{allowedCwd?:string}} [opts]
 * @returns {{reap:boolean, reason:('done'|'failed'|'already-stopped'|'not-background'|'wrong-cwd'|'not-terminal')}}
 */
export function classifySessionReap(session, { allowedCwd } = {}) {
  if (!session || typeof session !== 'object') return { reap: false, reason: 'not-terminal' };
  // Structural guards FIRST, in order — see the file header (`kind`) and this function's own doc (`cwd`) on
  // why neither can ever be state-dependent.
  if (session.kind !== 'background') return { reap: false, reason: 'not-background' };
  if (typeof allowedCwd === 'string' && allowedCwd && session.cwd !== allowedCwd) {
    return { reap: false, reason: 'wrong-cwd' };
  }
  const state = session.state;
  if (TERMINAL_REAP_STATES.has(state)) return { reap: true, reason: state };
  if (ALREADY_STOPPED_STATES.has(state)) return { reap: false, reason: 'already-stopped' };
  return { reap: false, reason: 'not-terminal' }; // working / blocked / undefined — never touched by THIS axis
}

/**
 * The dispatcher-minted TARGET a session's own `name` encodes, or `null` when it matches no known grammar —
 * never a guess. Mirrors `we:scripts/conveyor/lease-reaper.mjs`'s `itemNumFromSession` for the item-kind names
 * (`conveyor-<NUM>` / `prepare-<NUM>` / `prepare-decision-<NUM>`, an optional trailing retry-attempt letter
 * collapsed to the base number, same as `conveyor-3441b` → item `3441`), and `we:scripts/operations/
 * dispatch-lane.mjs`'s `sessionSlugFor` for the PR-kind names (`fix-<PR>` / `ci-heal-<PR>` are minted from the
 * PR number, not the item number — `sessionSlugFor(num, 'fix', pr)` → `` `fix-${pr}` ``); `review-<PR>` (the
 * independent-review dispatch, a separate mechanism from `dispatch-lane.mjs`) follows the identical PR-number
 * grammar. `fix`/`ci-heal` deliberately are NOT folded into `lease-reaper.mjs`'s item-kind bucket here even
 * though that module's own `itemNumFromSession` does — this function answers "what does the NUMBER in this
 * name identify", and for `fix`/`ci-heal` the number is a PR, not an item; conflating the two would ask the
 * wrong ground-truth question (a PR number happening to also be a valid item number, or vice versa).
 * @param {string|null|undefined} name
 * @returns {{kind:'item', id:string}|{kind:'pr', id:string, repo:string}|null}
 */
export function sessionTarget(name) {
  const parsed = parseSessionSlug(name);
  if (!parsed) return null;
  return parsed.itemKind ? { kind: 'item', id: parsed.id }
    : { kind: 'pr', id: parsed.id, repo: parsed.repo };
}

/** The `outcome` a backstop-written completion record carries — deliberately distinct from every REAL
 *  self-reported outcome (`blocked-on-infra`, a review verdict, …) so a reader can always tell "the dispatched
 *  agent said this itself" apart from "the reaper concluded this on the agent's behalf, after the fact". */
export const UNREPORTED_EXIT_OUTCOME = 'unreported-exit';

/** The completion-record KINDS {@link planBackstopCompletion} will ever mint — the subset of
 *  `PR_KINDS` (`session-slug.mjs`) that {@link ../operations/completion-record.mjs}'s `COMPLETION_KINDS` schema
 *  actually accepts. `ci-heal` is a real PR-kind session name but has NO completion-record kind at all (its own
 *  round-count/marker-comment mechanism is entirely separate, see `ci-heal-mark.mjs`) — minting one for it would
 *  invent a fact this repo's schema was never meant to hold, so it is deliberately excluded, not defaulted. */
const BACKSTOP_COMPLETION_KINDS = new Set(['review', 'fix', 'inspect']);

/**
 * we:scripts/conveyor/session-reaper.mjs#planBackstopCompletion — THE ROOT-CAUSE FIX (epic #3383, xbv32pg
 * follow-up), not merely a detection axis. {@link classifySessionReapWithGroundTruth}'s hung/ground-truth/idle
 * axes let the reaper independently CONCLUDE a session is done without ever needing its own self-report — but
 * until now, concluding that left no trace: a session whose own review/fix brief crashed before running
 * `completion-cli.mjs report --status=done` stayed `status: 'started'` in its completion record FOREVER, even
 * after this reaper correctly stopped it. `reconcile-core.mjs#markSelfReportedDone` (and any other future
 * reader of a completion record) then has no way to tell "still genuinely in flight" apart from "finished,
 * just never wrote it down" — the exact gap that froze `chalbert/web-everything#2599` and its five siblings for
 * this incident, and the exact one that would freeze the NEXT crash-before-self-report the same way.
 *
 * This function decides whether a session the reaper is ABOUT TO REAP needs a completion record written on its
 * behalf, and if so, returns it (never writes anything itself — pure). Called only for a session already in
 * the `reap` set — i.e. only once one of {@link classifySessionReap}'s/{@link classifySessionReapWithGroundTruth}'s
 * own axes has ALREADY independently concluded the session is done; this function adds no new judgment about
 * WHETHER a session is finished, only about whether that conclusion has been durably recorded yet.
 *
 * NEVER overwrites a real record. `existingRecord.status === 'done'` — however it got there, a genuine
 * self-report or an earlier backstop write — is left exactly alone; a backstop write only ever fills a GAP, it
 * never clobbers a fact. A session whose name matches no known PR-kind grammar, or whose kind has no
 * completion-record schema at all ({@link BACKSTOP_COMPLETION_KINDS}), is left alone too — never a guess.
 * @param {{name?:string}|null|undefined} session
 * @param {{status?:string}|null} existingRecord - {@link ../operations/completion-store.mjs#tryReadCompletion}'s
 *   own return shape, or `null` when nothing is on disk yet.
 * @param {() => string} [now] - injectable ISO-8601 clock (mirrors every other pure-ish constructor in this
 *   codebase's completion-record family).
 * @returns {object|null} the completion record to write, or `null` when nothing is owed.
 */
export function planBackstopCompletion(session, existingRecord, now = () => new Date().toISOString()) {
  if (existingRecord && existingRecord.status === 'done') return null; // a real terminal record — never touch it
  const parsed = parseSessionSlug(session?.name);
  if (!parsed || parsed.itemKind) return null; // no grammar match, or an item-kind session (conveyor-*/prepare-*
  //                                               / prepare-decision-*) — those never carry a completion record.
  if (!BACKSTOP_COMPLETION_KINDS.has(parsed.kind)) return null; // e.g. `ci-heal` — no completion-record kind exists
  const base = existingRecord ?? newCompletionRecord({ session: session.name, kind: parsed.kind, pr: parsed.id, now });
  return applyCompletionUpdate(base, { status: 'done', outcome: UNREPORTED_EXIT_OUTCOME }, now);
}

/**
 * {@link classifySessionReap}'s verdict, UPGRADED to `reap:true` when the base verdict is `not-terminal` AND
 * one of THREE independent axes confirms the session is actually done, tried in this order:
 *
 *   1. **The session's own self-reported completion record** ({@link ../operations/completion-store.mjs},
 *      #3436) — the most direct signal there is, since `review-*`/`fix-*` agent briefs write `status: 'done'`
 *      to it at their own exit, keyed by their own exact session name. Injected as `completionFor(name)`;
 *      never called for a name `completionPath` would refuse (an interactive session's free-text name, say) —
 *      the caller (`makeCompletionResolver`, below) already wraps that in a try/catch, so this axis simply
 *      never fires rather than throwing.
 *   2. **The pre-existing backlog-item / PR-merged ground truth** ({@link groundTruthForItem} /
 *      {@link groundTruthForPr}, unchanged from before #3383) — same as before this file's daemon-split work.
 *   3. **A generous idle timeout**, LAST RESORT ONLY: a `blocked` session (never `working` — see
 *      `neverReapWorking` below — and never a bare `undefined` state, which is too ambiguous a shape to time
 *      out on) that axes 1–2 could not confirm EITHER WAY (no completion record, no derivable target, or a
 *      resolver answer of `null`/unknown) is reaped once it has sat past `idleThresholdMs` since its own
 *      `startedAt`. Deliberately gated OFF a `resolved: false` answer — if axis 2 explicitly said "still
 *      genuinely open" (`we:backlog/2786-*.md`'s own shape), age never overrides that. `idleThresholdMs`
 *      defaults to `0` (disabled) — this is an approximation (session START time, not last-activity time; no
 *      such field exists in a `claude agents --json` row), so a caller opts in deliberately rather than this
 *      function silently starting to time sessions out.
 *
 * `neverReapWorking` (default `false`, preserving every existing caller's behavior byte for byte) is a
 * caller-scoped STRICTER MODE: when `true`, a `state: 'working'` row is never upgraded by ANY of the three
 * axes above, full stop — even a completion record or a merged PR leaves it `not-terminal`/kept. This exists
 * because a daemon calling this reaper against LIVE production sessions for the first time (epic #3383) wants
 * a stronger guarantee than the original 2026-09-03 ground-truth axis shipped with: "the listing says this
 * session is still actively doing something" is treated as authoritative over any secondary signal, never
 * second-guessed. The ORIGINAL axis (this flag `false`, still the function's own default) is unchanged and
 * still exercised by every pre-existing test in this file — see `session-reaper.test.mjs`'s own
 * `review-1862`-while-`working` case, which predates this flag and still passes exactly as before.
 *
 * Never downgrades a verdict, never touches `not-background`/`wrong-cwd`/`already-stopped`/already-terminal
 * rows. Omitting every new option (or passing a non-function `groundTruthFor`) makes this byte-identical to
 * the pre-#3383 function — every addition here is strictly additive.
 *
 * AXIS 0 — HUNG-TRANSCRIPT DETECTION (epic #3383 continuation), checked FIRST, BEFORE even the
 * `neverReapWorking`/`state:'working'` guard below, and it is the ONLY axis in this function allowed to run
 * ahead of that guard. Every axis below it treats `neverReapWorking` as authoritative because the signal it
 * is weighing (a completion record, ground truth, an idle timer) says nothing about whether the LISTING's own
 * `state: 'working'` is honest — so a daemon that wants "trust the listing over everything else" gets exactly
 * that. Hung-detection exists for the OPPOSITE reason: its entire premise is that `state: 'working'` CAN BE
 * WRONG — a session can crash or hang without ever telling the CLI to update its own state — and the way it
 * proves that is by reading the session's OWN transcript file directly (see
 * `we:scripts/conveyor/hung-session.mjs`), independent of anything the listing or the agent chooses to report.
 * Letting `neverReapWorking` veto THIS axis would mean the one daemon mode built to distrust a stale listing
 * is precisely the mode where a session the listing is WRONG about can never be reaped — the exact live
 * failure (chalbert/web-everything `review-2582`, state `working`, dead) this axis exists to close. Injected
 * as `hungFor(session)`, mirroring `completionFor`/`groundTruthFor`'s own try/catch-to-null discipline in the
 * caller — never called for a session missing `cwd`/`sessionId`, and any read failure answers "not hung",
 * never a guess.
 *
 * @param {object|null} session
 * @param {((target:{kind:'item'|'pr', id:string}) => ({resolved:boolean, evidence?:string}|null))|null} [groundTruthFor]
 * @param {{
 *   allowedCwd?: string,
 *   neverReapWorking?: boolean,
 *   completionFor?: ((name:string) => ({done:boolean}|null))|null,
 *   idleThresholdMs?: number,
 *   now?: number,
 *   hungFor?: ((session:object) => ({hung:boolean, reason?:string}|null))|null,
 * }} [opts]
 * @returns {{reap:boolean, reason:string}}
 */
export function classifySessionReapWithGroundTruth(session, groundTruthFor, opts = {}) {
  const { allowedCwd, neverReapWorking = false, completionFor = null, idleThresholdMs = 0, now = Date.now(), hungFor = null } = opts || {};
  const base = classifySessionReap(session, { allowedCwd });
  if (base.reap || base.reason !== 'not-terminal') return base;

  // Axis 0 — hung-transcript detection. See doc above for why this runs BEFORE `neverReapWorking` below, and
  // why that override is safe: it is independently confirming the listing's `state` is wrong, not ignoring it.
  if (typeof hungFor === 'function') {
    let info = null;
    try { info = hungFor(session); } catch { info = null; }
    if (info && info.hung === true) return { reap: true, reason: `hung-transcript:${info.reason || 'stale'}` };
  }

  if (neverReapWorking && session?.state === 'working') return base; // strictly-stricter mode — see doc above

  // Axis 1 — the session's own completion record (see doc above for why this is tried first).
  //
  // xf44mm3 (#4075/#3383) — BUG (a), fixed here: this axis used to reap ANY `status: 'done'` record
  // immediately, with no regard for `outcome: 'blocked-on-infra'` or the 15-minute cool-off
  // `reconcile-core.mjs#INFRA_RETRY_COOLOFF_MS` / `markSelfReportedDone` deliberately enforce before treating a
  // blocked-on-infra session as safe to stop retrying (see that function's own doc: long enough that a
  // persistent outage is not hammered every tick, short enough that a recovered one is retried within a
  // coffee). Left unenforced HERE, this reaper `claude stop`s the session almost immediately after it reports
  // done — which then makes `assessLiveness` read the PR as unbound on the very next reconcile tick, so the PR
  // gets re-dispatched ~2 minutes later instead of after the intended cool-off. Mirrors `markSelfReportedDone`'s
  // own "unparseable `updatedAt` never counts as elapsed" caution: never a guess in the reaper's favor either.
  if (typeof completionFor === 'function') {
    const record = completionFor(session?.name);
    if (record && record.done === true) {
      if (record.outcome === 'blocked-on-infra') {
        const updatedMs = Date.parse(record.updatedAt ?? '');
        const coolOffElapsed = Number.isFinite(updatedMs) && (now - updatedMs) >= INFRA_RETRY_COOLOFF_MS;
        if (coolOffElapsed) return { reap: true, reason: 'completion-record-done' };
        // still cooling off (or `updatedAt` could not be read) — fall through to the other axes below, exactly
        // as if this axis had found nothing, rather than reaping early.
      } else {
        return { reap: true, reason: 'completion-record-done' };
      }
    }
  }

  // Axis 2 — the pre-existing backlog-item / PR-merged ground truth, unchanged.
  let confirmedStillOpen = false; // a definite `resolved:false` — axis 3 must never override this
  if (typeof groundTruthFor === 'function') {
    const target = sessionTarget(session?.name);
    if (target) {
      const truth = groundTruthFor(target);
      if (truth && truth.resolved === true) {
        return { reap: true, reason: `ground-truth-${target.kind}:${truth.evidence || target.id}` };
      }
      if (truth && truth.resolved === false) confirmedStillOpen = true;
    }
  }

  // Axis 3 — the idle-timeout backstop, LAST resort only (see doc above for every gating condition).
  if (
    !confirmedStillOpen && idleThresholdMs > 0 && session?.state === 'blocked'
    && typeof session?.startedAt === 'number' && Number.isFinite(session.startedAt)
  ) {
    const age = now - session.startedAt;
    if (age >= idleThresholdMs) return { reap: true, reason: `idle-threshold:${age}ms` };
  }

  return base; // unresolved / unknown / not yet done / still too young — leave it exactly as the state-only axis would
}

/**
 * Map {@link classifySessionReapWithGroundTruth} over a full `claude agents --json` listing. Passing no
 * `groundTruthFor` and no other option (the default) makes this byte-identical to mapping
 * {@link classifySessionReap} alone — every existing caller/test is unaffected. Every option is a straight
 * pass-through to {@link classifySessionReapWithGroundTruth} — see that function's own doc for what each one
 * does.
 * @param {unknown[]} sessions
 * @param {{
 *   groundTruthFor?: ((target:{kind:'item'|'pr', id:string}) => ({resolved:boolean, evidence?:string}|null))|null,
 *   allowedCwd?: string,
 *   neverReapWorking?: boolean,
 *   completionFor?: ((name:string) => ({done:boolean}|null))|null,
 *   idleThresholdMs?: number,
 *   now?: number,
 *   hungFor?: ((session:object) => ({hung:boolean, reason?:string}|null))|null,
 * }} [opts]
 * @returns {{reap:Array, keep:Array}} each entry carries the original row plus its `reason`.
 */
export function sessionReapPlan(sessions, { groundTruthFor = null, ...rest } = {}) {
  const reap = [];
  const keep = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const verdict = classifySessionReapWithGroundTruth(session, groundTruthFor, rest);
    const row = { session, reason: verdict.reason };
    (verdict.reap ? reap : keep).push(row);
  }
  return { reap, keep };
}

// ── IO SHELL (runs only as a CLI — owns the one `claude agents --json` read, the ground-truth lookups, and the
//    stop delegation) ──────────────────────────────────────────────────────────────────────────────────────

/** Default backlog directory, matching `src/_data/backlog.js`'s own `WE_BACKLOG_DIR` override convention
 *  (#3445) so a test can point the ground-truth resolver at a throwaway corpus without touching the real one. */
const DEFAULT_BACKLOG_DIR = process.env.WE_BACKLOG_DIR || join(HERE, '..', '..', 'backlog');

/** How many real `gh pr view` calls ONE reaper pass will make for PR-kind ground-truth checks — see the file
 *  header's "COST DISCIPLINE" section. Generous relative to the live-measured 2026-09-03 count (at most a
 *  handful of `review-*`/`fix-*`/`ci-heal-*` rows in `working`/`blocked` at once) while still bounding a
 *  pathological listing from firing an unbounded `gh` burst in one tick. */
export const MAX_GH_PR_VIEW_CALLS_PER_TICK = 25;

/**
 * The item-kind ground-truth answer for backlog item `id` — `resolved: true` iff its own card's `status:`
 * frontmatter reads exactly `resolved`. A missing card, or one whose `status:` can't be read, answers
 * `resolved: false`/`null` respectively — NEVER `true` on absence, so a mis-derived or since-renumbered id
 * never falsely reads as done. One local file read, no rate-limit concern.
 * @param {string} id
 * @param {{backlogDir?:string, readdirSyncFn?:Function, readFileSyncFn?:Function}} [io]
 * @returns {{resolved:boolean, evidence?:string}|null} `null` only when the backlog directory itself is unreadable.
 */
export function groundTruthForItem(id, { backlogDir = DEFAULT_BACKLOG_DIR, readdirSyncFn = readdirSync, readFileSyncFn = readFileSync } = {}) {
  let entries;
  try {
    entries = readdirSyncFn(backlogDir);
  } catch {
    return null; // backlog dir itself unreadable — unknown, never reap on an unreadable signal
  }
  const fname = entries.find((f) => f.endsWith('.md') && (f === `${id}.md` || f.startsWith(`${id}-`)));
  if (!fname) return { resolved: false }; // no card at all — nothing to confirm, not an error
  try {
    const text = readFileSyncFn(join(backlogDir, fname), 'utf8');
    const status = readField(text, 'status');
    return status === 'resolved' ? { resolved: true, evidence: `backlog#${id}:resolved` } : { resolved: false };
  } catch {
    return null; // the one found file itself unreadable — unknown, never reap on an unreadable signal
  }
}

/**
 * The PR-kind ground-truth answer for PR `pr` — `resolved: true` iff `gh pr view` reports it merged. Any
 * failure (no `gh`, PR not found, timeout) answers `null` (unknown) rather than throwing — a best-effort
 * check, matching every other `gh`-shelling function in this codebase's own fail-soft convention.
 * @param {string|number} pr
 * @param {{exec?:Function, env?:object, repo?:string}} [io]
 * @returns {{resolved:boolean, evidence?:string}|null}
 */
export function groundTruthForPr(pr, { exec = execFileSync, env = process.env, repo = 'we' } = {}) {
  const slug = Object.hasOwn(CONSTELLATION_REPOS, repo) ? CONSTELLATION_REPOS[repo].slug : null;
  if (!slug) return null;
  try {
    // Reuses `dispatch-lane-io.mjs`'s own `prListTimeoutMs` bound rather than inventing a second knob for the
    // same class of cost (one bounded `gh pr view` network call) — see the file header's "COST DISCIPLINE".
    const out = exec('gh', ['pr', 'view', String(pr), '--repo', slug, '--json', 'state,mergedAt'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
      timeout: prListTimeoutMs(env),
      killSignal: 'SIGKILL',
    });
    const parsed = JSON.parse(String(out || '{}'));
    const merged = Boolean(parsed?.mergedAt) || String(parsed?.state || '').toUpperCase() === 'MERGED';
    return merged ? { resolved: true, evidence: `pr#${pr}:merged` } : { resolved: false };
  } catch {
    return null; // `gh` unavailable / PR not found / timeout — unknown, never reap on an unreadable signal
  }
}

/**
 * Build a `groundTruthFor` resolver for {@link sessionReapPlan}: routes an item-kind target to
 * {@link groundTruthForItem} (unbounded, local) and a PR-kind target to {@link groundTruthForPr} (bounded by
 * {@link MAX_GH_PR_VIEW_CALLS_PER_TICK}, network) — each answer cached per target for the life of the returned
 * resolver, so two sessions naming the same target cost one lookup.
 * @param {{exec?:Function, env?:object, backlogDir?:string, readdirSyncFn?:Function, readFileSyncFn?:Function, maxPrViewCalls?:number}} [io]
 * @returns {(target:{kind:'item'|'pr', id:string}) => ({resolved:boolean, evidence?:string}|null)}
 */
export function makeGroundTruthResolver({
  exec = execFileSync,
  env = process.env,
  backlogDir = DEFAULT_BACKLOG_DIR,
  readdirSyncFn = readdirSync,
  readFileSyncFn = readFileSync,
  maxPrViewCalls = MAX_GH_PR_VIEW_CALLS_PER_TICK,
} = {}) {
  const cache = new Map();
  let prViewCalls = 0;
  return function groundTruthFor(target) {
    const repo = target.repo === undefined ? 'we' : target.repo;
    const key = target.kind === 'pr' ? `pr:${repo}:${target.id}` : `${target.kind}:${target.id}`;
    if (cache.has(key)) return cache.get(key);
    let result;
    if (target.kind === 'item') {
      result = groundTruthForItem(target.id, { backlogDir, readdirSyncFn, readFileSyncFn });
    } else if (target.kind === 'pr') {
      if (prViewCalls >= maxPrViewCalls) {
        result = null; // bounded — left unresolved this tick rather than an unbounded `gh` burst; retried next tick
      } else {
        prViewCalls++;
        result = groundTruthForPr(target.id, { exec, env, repo: target.repo });
      }
    } else {
      result = null;
    }
    cache.set(key, result);
    return result;
  };
}

/**
 * Build a `completionFor` resolver for {@link sessionReapPlan} / {@link classifySessionReapWithGroundTruth}:
 * reads the session's OWN self-reported completion record ({@link ../operations/completion-store.mjs}, #3436)
 * by its exact `name` (the same slug `review-dispatch.mjs`/`reconcile-fix-dispatch.mjs` mint and the agent
 * brief reports against — no attempt-letter suffix exists for PR-kind names, see `session-slug.mjs`, so this
 * is an exact match, never a prefix guess). `done: true` iff the record's `status` is `'done'`; a missing
 * record, an invalid slug (`completionPath` refuses one — e.g. an interactive session's free-text name), or
 * any read failure all answer `null` (unknown) — NEVER a guess, matching every other resolver in this file.
 *
 * ALSO carries `outcome`/`updatedAt` (xf44mm3, #4075/#3383) — previously dropped, which is exactly what let
 * {@link classifySessionReapWithGroundTruth}'s Axis 1 reap a `blocked-on-infra` session with no regard for its
 * own cool-off (bug (a); see that axis's own doc for the full incident this closes).
 * @param {{dir?:string}} [io]
 * @returns {(name:string) => ({done:boolean, outcome:string|null, updatedAt:string|null}|null)}
 */
export function makeCompletionResolver({ dir } = {}) {
  return function completionFor(name) {
    if (typeof name !== 'string' || !name) return null;
    try {
      const record = tryReadCompletion(name, dir);
      return record ? { done: record.status === 'done', outcome: record.outcome ?? null, updatedAt: record.updatedAt ?? null } : null;
    } catch {
      return null; // invalid slug / unreadable record — unknown, never reap on an unreadable signal
    }
  };
}

/**
 * Build a `hungFor` resolver for {@link sessionReapPlan} / {@link classifySessionReapWithGroundTruth} (epic
 * #3383 continuation): reads the session's OWN transcript-staleness verdict via
 * `we:scripts/conveyor/hung-session.mjs#readHungInfo` — the SAME shared detector `reconcile-core.mjs`'s
 * `markHungSessions` uses, so this daemon and the reconciler can never disagree about what "hung" means.
 * `thresholdMs` defaults to `resolveHungThresholdMs()` (`WE_HUNG_TRANSCRIPT_MINUTES`, default 30 min), read
 * ONCE here in the IO shell, never inside the pure classifier.
 * @param {{thresholdMs?:number, now?:()=>number}} [io]
 * @returns {(session:object) => ({hung:boolean, reason?:string}|null)}
 */
export function makeHungResolver({ thresholdMs = resolveHungThresholdMs(), now = Date.now } = {}) {
  return function hungFor(session) {
    try {
      return readHungInfo(session, now(), thresholdMs);
    } catch {
      return null; // unreadable transcript / bad row shape — unknown, never reap on an unreadable signal
    }
  };
}

/**
 * The idle-timeout backstop's default threshold (6 hours) — see {@link classifySessionReapWithGroundTruth}'s
 * "Axis 3" doc for exactly when this applies (a `blocked` session, name+cwd already confirmed spawned by THIS
 * checkout, that neither the completion-record nor the backlog/PR axis could confirm either way). Generous on
 * purpose: this is measured from `startedAt` (session START, not last-activity — no such field exists in a
 * `claude agents --json` row), so it is a deliberately loose approximation, not a tight SLA. A caller that
 * wants it OFF passes `idleThresholdMs: 0` (also this function's own default when omitted).
 */
export const DEFAULT_IDLE_REAP_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * How many total attempts (1 initial + retries) the stop loop below makes for ONE candidate before counting it
 * a real failure — found live 2026-09-04 (WE #3435/#3383 epic): a live tick's `runQuiet` (`we:skills-src/
 * conveyor/runner.mjs`) logged exactly one mechanical-pass failure for this file over 190+ ticks of a live
 * overnight run, and it turned out to be undiagnosable — see {@link STOP_RETRY_BACKOFF_MS} and the file header
 * comment above {@link stopSession}'s import for why: `claude stop`'s own upstream flakiness ("claude stop's
 * reported success is a hint, not a certainty", issues #65925/#45250/#41461) is a KNOWN, generally-transient
 * class of failure this file already treats as benign for the "reported success but listing lags" direction —
 * a genuine non-`No job matching` `claude stop` error (a momentary CLI-internal lock/timeout under this
 * environment's own live concurrency — dozens of `claude` invocations across dispatch, review and mechanical
 * passes racing the same session registry at once) is the SAME class, just the inverse direction (a real
 * failure that is likely to clear on its own). Retrying beats leaving it to the next tick two ways: it usually
 * recovers the stop immediately, and — because ONE candidate failure marks the WHOLE pass's own exit code
 * failed below (`process.exit(failures > 0 || anomalies > 0 ? 1 : 0)`, kept intentional — see that comment) —
 * it stops a single transient blip from making an otherwise-clean sweep read as a mystery crash to the runner.
 * Concurrency was stress-tested live (25 concurrent `claude stop` + 10 concurrent `claude agents --json --all`
 * calls at once, repeatedly) without reproducing a hard failure — so a short, bounded retry is expected to
 * clear a real one; it is not chasing a reproduced deterministic bug because there isn't one to chase.
 */
export const STOP_RETRY_ATTEMPTS = 3;

/** Backoff (ms) before retry attempt 2 and attempt 3 respectively (index 0 = wait before the 2nd attempt) —
 *  short, since the live stress test above found no contention surviving even a fraction of a second; long
 *  enough to clear a momentary CLI-internal lock without meaningfully delaying the tick. */
export const STOP_RETRY_BACKOFF_MS = [300, 900];

/**
 * {@link stopSession}, retried up to {@link STOP_RETRY_ATTEMPTS} times with {@link STOP_RETRY_BACKOFF_MS}
 * backoff between attempts, for a transient `claude stop` failure — see {@link STOP_RETRY_ATTEMPTS}'s own doc
 * for why this exists and why it lives HERE (the IO shell's own retry policy) rather than inside
 * {@link stopSession} itself (`dispatch-abort.mjs`'s other callers, e.g. `wake.mjs`'s interactive abort, want
 * the FIRST failure surfaced immediately, not silently retried behind the operator's back). Never retries an
 * `alreadyGone` answer — that is not a failure, `stopSession` already resolves it. Injectable `sleep` so a test
 * proves the retry without a real wall-clock wait.
 * @param {{handle:string, exec?:Function, sleep?:(ms:number)=>void, attempts?:number, backoffMs?:number[]}} o
 * @returns {{stopped:true, alreadyGone:boolean, output:string}}
 */
export function stopSessionWithRetry({ handle, exec = execFileSync, sleep = sleepSyncMs, attempts = STOP_RETRY_ATTEMPTS, backoffMs = STOP_RETRY_BACKOFF_MS } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return stopSession({ handle, exec });
    } catch (e) {
      lastErr = e;
      if (attempt < attempts) sleep(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1]);
    }
  }
  throw lastErr;
}

const log = (m) => process.stderr.write(m + '\n');

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

/**
 * THE REUSABLE IO-SHELL PASS (epic #3383 daemon split) — everything `main()` used to do BETWEEN reading argv
 * and printing/exiting, pulled out so a resident daemon (e.g. `we:skills-src/conveyor/review-daemon.mjs`) can
 * call this directly, once per tick, exactly like it already calls `runReconcilePass`/`dispatchReview` — no
 * `node <this file>` subprocess needed. Never calls `process.exit`; the CLI `main()` below is now a thin argv
 * → options mapper plus printing, calling this and translating the result into stdout/exit code.
 *
 * Every IO dependency is injectable, defaulting to the real one, so this is unit-tested with fakes exactly like
 * every other function in this file. `listAgents` defaults to the real `defaultListAgents({ all: true })` —
 * see the inline comment at that call site (moved here verbatim) for why `all: true` is load-bearing.
 *
 * @param {{
 *   listAgents?: () => unknown[],
 *   groundTruthFor?: ((target:object) => object|null)|null,
 *   completionFor?: ((name:string) => object|null)|null,
 *   allowedCwd?: string,
 *   neverReapWorking?: boolean,
 *   idleThresholdMs?: number,
 *   now?: number,
 *   dryRun?: boolean,
 *   stop?: Function,
 *   log?: (msg:string) => void,
 *   hungFor?: ((session:object) => object|null)|null,
 *   backstopCompletion?: boolean,
 *   readCompletionRecord?: (session:string) => object|null,
 *   writeCompletionRecord?: (record:object) => unknown,
 * }} [o]
 * @returns {{
 *   scanned: number, stopped: number, alreadyGone: number, failures: number, anomalies: number,
 *   backstopWritten: number, wouldStop: Array|undefined, collected: Array|undefined, kept: number,
 * }}
 */
export function runSessionReaperPass({
  listAgents = () => defaultListAgents({ exec: execFileSync, all: true }),
  groundTruthFor = makeGroundTruthResolver({ exec: execFileSync }),
  completionFor = makeCompletionResolver(),
  allowedCwd,
  neverReapWorking = false,
  idleThresholdMs = 0,
  now = Date.now(),
  dryRun = false,
  stop = stopSessionWithRetry,
  log: logFn = log,
  hungFor = makeHungResolver(),
  // xbv32pg follow-up (epic #3383) — THE ROOT-CAUSE FIX, not just a detection axis: see
  // {@link planBackstopCompletion}'s own docblock. Default ON, like every other axis this epic ships — a
  // caller that wants the pre-#3383 behavior byte-for-byte passes `backstopCompletion: false`.
  backstopCompletion = true,
  readCompletionRecord = tryReadCompletion,
  writeCompletionRecord = writeCompletion,
} = {}) {
  let sessions;
  try {
    // `all: true` IS LOAD-BEARING (#3435 review finding): every OTHER caller of `defaultListAgents` (the
    // dispatch observer, the dispatch guard's liveness check) deliberately omits `--all`, because for THEIR
    // job a completed session must read as gone. This reaper's job is the opposite — it exists to find and
    // `claude stop` exactly the `done`/`failed` sessions the plain listing excludes — so passing no `all` here
    // made `sessionReapPlan` compute `reap: []` on every real invocation; `claude stop` was never called, and
    // the clutter #3435 was filed to fix never actually got touched. See `defaultListAgents`'s own docblock
    // (`we:scripts/operations/dispatch-lane-io.mjs`) for why the OTHER callers must not also flip this.
    sessions = listAgents();
  } catch (e) {
    // Best-effort like every other mechanical pass (Done-when #3): an unreadable listing means there is
    // nothing safe to act on this tick, not a hard failure — the next tick tries again.
    logFn(`  ⚠ \`claude agents --json\` unreadable — session-reaper skipping this tick: ${String(e?.message || e).split('\n')[0]}`);
    // `unreadable: true` lets a caller (the CLI `main()` below) reproduce the pre-#3383 behavior exactly — an
    // unreadable listing exits clean with NO stdout report at all, not a "0 of everything" summary that could
    // be misread as a real, empty, successfully-scanned tick.
    return {
      scanned: 0, stopped: 0, alreadyGone: 0, failures: 0, anomalies: 0, backstopWritten: 0,
      wouldWriteBackstop: dryRun ? [] : undefined, wouldStop: dryRun ? [] : undefined,
      collected: dryRun ? undefined : [], kept: 0, unreadable: true,
    };
  }
  if (!Array.isArray(sessions)) sessions = [];

  const { reap, keep } = sessionReapPlan(sessions, { groundTruthFor, completionFor, allowedCwd, neverReapWorking, idleThresholdMs, now, hungFor });

  let stopped = 0;
  let alreadyGone = 0;
  let failures = 0;
  let anomalies = 0;
  let backstopWritten = 0;
  const done = [];
  const wouldBackstop = [];
  for (const { session, reason } of reap) {
    // xbv32pg follow-up (epic #3383) — computed for EVERY reap candidate, before the `id`/`dryRun` branches
    // below: a session already independently confirmed done by one of the axes above deserves a durable
    // completion record whether or not `claude stop` itself later succeeds (this is about the SESSION's own
    // work being finished, not about the OS-process stop). Never overwrites a real record — see
    // {@link planBackstopCompletion}'s own doc. A read/parse failure (corrupt record, invalid slug) is treated
    // exactly like every other resolver in this file: unknown, so skip the backstop this tick rather than guess.
    let backstopRecord = null;
    if (backstopCompletion) {
      try {
        backstopRecord = planBackstopCompletion(session, readCompletionRecord(session?.name));
      } catch { backstopRecord = null; }
    }
    // `id` (the SHORT form), never `sessionId` (the full UUID `claude stop` does not match on) — see the file
    // header's "WHY `id`, NOT `sessionId`" section. Every row here already passed `classifySessionReap`'s
    // `kind !== 'background'` guard, and every `kind: 'background'` row measured (live and in the checked-in
    // fixture) carries a real `id` — so a missing one here is a genuine anomaly, not an expected shape, and is
    // logged + counted rather than silently skipped (a `continue` with no trace would hide exactly the case
    // this guard exists to catch).
    const handle = normalizeHandle(session.id);
    if (!handle) {
      logFn(`  ⚠ ${session.sessionId ?? session.name ?? 'unknown'}: reap candidate is missing \`id\` — should never happen for a \`kind: background\` row, skipping and flagging as an anomaly`);
      anomalies++;
      continue;
    }
    if (dryRun) {
      logFn(`  would stop ${handle} (${reason}; ${session.name ?? 'unnamed'})`);
      if (backstopRecord) {
        logFn(`  would write backstop completion record for ${session.name} (outcome: ${UNREPORTED_EXIT_OUTCOME}) — no self-report was ever recorded`);
        wouldBackstop.push({ name: session.name ?? null, outcome: UNREPORTED_EXIT_OUTCOME });
      }
      continue;
    }
    if (backstopRecord) {
      try {
        writeCompletionRecord(backstopRecord);
        backstopWritten++;
        logFn(`  ⚑ wrote backstop completion record for ${session.name} (outcome: ${UNREPORTED_EXIT_OUTCOME}) — no self-report was ever recorded before this reaper concluded it was done (${reason})`);
      } catch (e) {
        logFn(`  ⚠ ${session.name}: failed to write backstop completion record: ${String(e?.message || e).split('\n')[0]}`);
      }
    }
    try {
      // Retried — see {@link stopSessionWithRetry}'s own doc for why: a `claude stop` failure found live
      // 2026-09-04 was a transient CLI-internal hiccup, not a hard bug, and usually clears within a beat.
      const res = stop({ handle, exec: execFileSync });
      if (res.alreadyGone) alreadyGone++;
      else stopped++;
      logFn(`  ${res.alreadyGone ? 'already gone' : 'stopped'} ${handle} (${reason}; ${session.name ?? 'unnamed'})`);
      done.push({ id: handle, sessionId: normalizeHandle(session.sessionId) || null, name: session.name ?? null, reason, alreadyGone: res.alreadyGone });
    } catch (e) {
      // ONE session's stop failing never blocks the rest of the pass (Done-when #3) — the same
      // "couldn't confirm, background service may be restarting" flakiness lease-reaper.mjs already treats
      // as per-candidate, not pass-fatal. Reaches here only after `STOP_RETRY_ATTEMPTS` all failed, so this IS
      // a real (not merely transient) failure — worth saying so, since the retry count is otherwise invisible.
      logFn(`  ⚠ ${handle}: stop failed after ${STOP_RETRY_ATTEMPTS} attempts (${String(e?.message || e).split('\n')[0]}) — left for the next tick`);
      failures++;
    }
  }

  return {
    scanned: sessions.length,
    stopped: dryRun ? 0 : stopped,
    alreadyGone: dryRun ? 0 : alreadyGone,
    failures: dryRun ? 0 : failures,
    anomalies,
    backstopWritten: dryRun ? 0 : backstopWritten,
    wouldWriteBackstop: dryRun ? wouldBackstop : undefined,
    wouldStop: dryRun
      ? reap.map((r) => ({ id: normalizeHandle(r.session.id) || null, sessionId: normalizeHandle(r.session.sessionId) || null, name: r.session.name ?? null, reason: r.reason }))
      : undefined,
    collected: dryRun ? undefined : done,
    kept: keep.length,
  };
}

function main(argv) {
  const flags = parseFlags(argv);
  const dryRun = !!flags['dry-run'];
  // `--no-ground-truth` is an escape hatch back to the original state-only axis, for a rollback or an
  // A/B live comparison — the default is ON, matching the operator's own instruction that this axis should
  // actually run, not merely exist.
  const groundTruthFor = flags['no-ground-truth'] ? null : makeGroundTruthResolver({ exec: execFileSync });
  // `--no-completion-record` is the same kind of rollback escape hatch, for the newer (epic #3383) axis.
  const completionFor = flags['no-completion-record'] ? null : makeCompletionResolver();
  // `--allowed-cwd=<path>` scopes reaping to sessions spawned from that checkout (see `classifySessionReap`'s
  // own doc) — opt-in, so every pre-existing invocation of this CLI (fixtures with no `cwd` field at all)
  // keeps working unchanged. A daemon wires this to its OWN `REPO_ROOT` (this file's own, when it imports
  // {@link runSessionReaperPass} directly instead of shelling this CLI).
  const allowedCwd = typeof flags['allowed-cwd'] === 'string' ? flags['allowed-cwd'] : undefined;
  // `--never-reap-working` is the caller-scoped stricter mode described on `classifySessionReapWithGroundTruth`
  // — opt-in for the identical backward-compatibility reason.
  const neverReapWorking = !!flags['never-reap-working'];
  // `--idle-hours=<n>` enables the idle-timeout backstop (axis 3) — `0`/omitted keeps it off, matching the
  // pure core's own default.
  const idleThresholdMs = flags['idle-hours'] !== undefined ? Number(flags['idle-hours']) * 60 * 60 * 1000 : 0;
  // `--no-hung-detection` is the same kind of rollback escape hatch, for the newer (epic #3383 continuation)
  // hung-transcript axis — default ON, since (unlike the idle backstop) this axis is meant to actually run.
  // `--hung-minutes=<n>` overrides `WE_HUNG_TRANSCRIPT_MINUTES` for this one invocation.
  const hungFor = flags['no-hung-detection']
    ? null
    : makeHungResolver(flags['hung-minutes'] !== undefined ? { thresholdMs: Number(flags['hung-minutes']) * 60 * 1000 } : {});
  // `--no-backstop-completion` is the same kind of rollback escape hatch, for the xbv32pg follow-up (epic
  // #3383) root-cause fix — default ON, same as every other axis this epic ships.
  const backstopCompletion = !flags['no-backstop-completion'];

  const result = runSessionReaperPass({ groundTruthFor, completionFor, allowedCwd, neverReapWorking, idleThresholdMs, dryRun, hungFor, backstopCompletion });

  if (result.unreadable) {
    // Matches the pre-#3383 CLI exactly: an unreadable listing means nothing safe to act on — exit clean, no
    // stdout report (the warning already went to stderr inside `runSessionReaperPass`).
    process.exit(0);
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const { scanned, stopped, alreadyGone, failures, anomalies, backstopWritten, wouldStop, wouldWriteBackstop, kept } = result;
    log(
      `session-reaper: ${scanned} session(s) listed · ` +
        `${dryRun ? `${(wouldStop ?? []).length} would stop${(wouldWriteBackstop ?? []).length ? `, ${(wouldWriteBackstop ?? []).length} would get a backstop completion record` : ''}` : `${stopped} stopped${alreadyGone ? `, ${alreadyGone} already gone` : ''}${failures ? `, ${failures} failed` : ''}${anomalies ? `, ${anomalies} anomal${anomalies === 1 ? 'y' : 'ies'}` : ''}${backstopWritten ? `, ${backstopWritten} backstop completion record(s) written` : ''}`} · ${kept} kept`,
    );
  }
  // Non-zero exit when a stop we ATTEMPTED actually failed, OR a reap candidate turned out to be missing its
  // `id` (the anomaly case — see the loop above) — mirrors lease-reaper.mjs's own convention, so a cron/loop
  // wrapper can tell a clean sweep from a partial one. `runQuiet` (the runner's own caller) swallows this
  // either way — it is surfaced for anyone invoking the CLI directly.
  process.exit(result.failures > 0 || result.anomalies > 0 ? 1 : 0);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2));
}

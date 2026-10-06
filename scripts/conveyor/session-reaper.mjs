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
 * `we:backlog/3451-*.md`, carries `status: resolved` with a merged PR (`web-everything/web-everything#1862`, "WE
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

import { makeAwaitingVerifyResolver } from './await-verify.mjs';
import { parseSessionSlug } from './session-slug.mjs';
import { rateAndRecordSession } from './run-rating.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readField } from '../backlog/frontmatter.mjs';
import { stopSession } from '../operations/dispatch-abort.mjs';
import { defaultListAgents, normalizeHandle, prListTimeoutMs, dispatchScratchRoot, revokeDispatchTrust } from '../operations/dispatch-lane-io.mjs';
// #ghost-sessions-inflate-cap — the SAME shared two-signal pid-liveness probe `lease-reaper.mjs`/`tick-core.mjs`
// already trust; see `makePidDeadResolver`'s own docblock for why this reaper cites it rather than re-deriving
// a fourth copy of `process.kill(pid, 0)`.
import { resolvePidAlive, scanPsOutput, defaultIsPidAlive } from './driver-watchdog.mjs';
import { sleepSyncMs } from '../readiness/drain-lock.mjs';
import {
  applyCompletionUpdate, completionPath, deleteCompletion, isForeignCompletionSessionId, listCompletionSessions, newCompletionRecord,
  resolveCompletionsDir, tryReadCompletion, writeCompletion,
} from '../operations/completion-store.mjs';
import {
  deleteDeliveryReport, deliveryReportPath, listDeliveryReportSessions, resolveDeliveryReportsDir,
} from '../operations/delivery-report-store.mjs';
import { pruneTerminalRuns } from '../operations/run-store.mjs';
import {
  readHungInfo, resolveHungThresholdMs, readClaudeAuthExpiredInfo, readIdleFinishedInfo, resolveIdleFinishedThresholdMs,
  readTranscriptTailActivity,
} from './hung-session.mjs';
import {
  NO_OUTCOME_KINDS, resolveNoOutcomeWindowMs, resolveNoOutcomeCeilingMs, classifyNoOutcomeStall, OUTCOME_UNREADABLE,
} from './hung-session.mjs';
import { resolveSessionTranscript } from '../operations/agent-usage-report.mjs';
import { tailLines, summarizeEntry } from '../../skills-src/inspect-agent-health/agent-health.mjs';
// #4306 — the SAME `startedAt` parser `reconcile-core.mjs#markSelfReportedDone` uses, reused (never re-derived)
// so "which generation started later" means the same thing in both files. No cycle: `reconcile-core.mjs` does
// not import this file.
import { startedAtMs } from './reconcile-core.mjs';
// #4149 (epic #3383/#4075) — this file no longer reads `INFRA_RETRY_COOLOFF_MS` itself: `makeCompletionResolver`
// now stops a `blocked-on-infra` session's process as soon as its record says `done`, regardless of the cool-off
// (see that function's own doc). `reconcile-core.mjs#markSelfReportedDone`/`#assessLiveness` still enforce the
// SAME window — off the record, never off whether this reaper happened to leave a process alive — so no import
// of that constant is needed here any more; the two files can no longer disagree, because only one of them
// reads it at all.

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
 * `chatSpawnGuardFor` IS A THIRD STRUCTURAL GUARD (#4091, epic #3383/#4075, statute clause 4), checked LAST of
 * the three, still before any state check: "cleanup touches daemon-dispatched background sessions, and a
 * chat-spawned session only when linked to a spawning chat that was explicitly ended… an unknown or ambiguous
 * link is never reaped." A session with NO recorded link at all (every session today, and every
 * daemon-dispatched one going forward — daemons never run the `SessionStart` hook that records one) is
 * UNCHANGED — this guard is additive, never a behavior change for an existing caller ("until it lands, the
 * behavior equals today's", per the ratified statute's own supporting text). Only once a link is ON RECORD
 * does this guard ever say no, and even then only until that chat is marked ended. See
 * {@link classifyChatSpawnGuard} for the pure decision this wraps.
 *
 * @param {object|null} session - one element of a `claude agents --json` listing.
 * @param {{allowedCwd?:string, chatSpawnGuardFor?:((session:object) => ({blocked:boolean, reason?:string})|null)|null}} [opts]
 * @returns {{reap:boolean, reason:('done'|'failed'|'already-stopped'|'not-background'|'wrong-cwd'|'chat-not-ended'|'ambiguous-chat-link'|'not-terminal')}}
 */
export function classifySessionReap(session, { allowedCwd, chatSpawnGuardFor = null } = {}) {
  if (!session || typeof session !== 'object') return { reap: false, reason: 'not-terminal' };
  // Structural guards FIRST, in order — see the file header (`kind`) and this function's own doc (`cwd`/
  // `chatSpawnGuardFor`) on why none of the three can ever be state-dependent.
  if (session.kind !== 'background') return { reap: false, reason: 'not-background' };
  if (typeof allowedCwd === 'string' && allowedCwd && session.cwd !== allowedCwd) {
    return { reap: false, reason: 'wrong-cwd' };
  }
  if (typeof chatSpawnGuardFor === 'function') {
    let guard = null;
    try { guard = chatSpawnGuardFor(session); } catch { guard = null; }
    if (guard && guard.blocked === true) return { reap: false, reason: guard.reason || 'chat-not-ended' };
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
 *  agent said this itself" apart from "the reaper concluded this on the agent's behalf, after the fact".
 *  {@link BLOCKED_ON_INFRA_OUTCOME} is the ONE exception — see {@link transcriptShowsIntendedBlockedOnInfra}'s
 *  own doc for why a backstop write is sometimes minted with that outcome instead of this one. */
export const UNREPORTED_EXIT_OUTCOME = 'unreported-exit';

/** The SAME literal `reconcile-core.mjs#markSelfReportedDone` and `makeCompletionResolver` (this file, above)
 *  already match on — re-declared here (never imported; no shared constants module exists for this one string
 *  today) so {@link planBackstopCompletion}'s own backstop write can mint the SAME value a genuine self-report
 *  would have, when the transcript shows that is what actually happened. See {@link transcriptShowsIntendedBlockedOnInfra}. */
export const BLOCKED_ON_INFRA_OUTCOME = 'blocked-on-infra';

/** #4090 (epic #3383/#4075, statute clause 2) — "a no-outcome stop counts as a loop and is relaunched, never
 *  resumed." Distinct from BOTH outcomes above: this is not "we don't know what happened" ({@link
 *  UNREPORTED_EXIT_OUTCOME}) or "a transient outage" ({@link BLOCKED_ON_INFRA_OUTCOME}) — it is a definite
 *  verdict THIS reaper reached on its own evidence (no real outcome within the kind's window/ceiling), for
 *  whichever future reader (#3366's resume-vs-relaunch logic, not yet built) needs to tell a genuine crash
 *  apart from a bot correctly stopped for looping. */
export const STALLED_OUTCOME = 'stalled';

/** The completion-record `label` a Claude-CLI-auth-expired backstop write carries (live incident, night of
 *  2026-09-25/26 ET) — the outcome itself is the SAME {@link BLOCKED_ON_INFRA_OUTCOME} a genuine transcript-
 *  stated infra block already mints (so `reconcile-core.mjs#markSelfReportedDone`'s existing 15-minute
 *  infra-retry cool-off applies unchanged, no new downstream reader needed), with this label distinguishing
 *  WHICH kind of infra outage it was for anyone who cares (an operator glancing at the record, a future sign). */
export const CLAUDE_AUTH_OUTCOME_LABEL = 'claude-auth';

/** The completion-record KINDS {@link planBackstopCompletion} will ever mint — the subset of
 *  `PR_KINDS` (`session-slug.mjs`) that {@link ../operations/completion-record.mjs}'s `COMPLETION_KINDS` schema
 *  actually accepts. `ci-heal` GAINED a completion-record kind #4075/xg7m2wq (live incident, PR #2724,
 *  2026-09-26: a ci-heal session that had genuinely finished — "rebased onto main and pushed; no code change
 *  was needed" — kept counting as a live holder of its PR forever, because neither this schema nor
 *  `fix-agent-ci-brief.md` itself ever reported completion) — its own round-count/marker-comment mechanism
 *  (`ci-heal-mark.mjs`) still exists separately and is unchanged, but a ci-heal session now ALSO gets a backstop
 *  `status:'done'` record here the same way `review`/`fix`/`inspect` already do, so a ci-heal session that
 *  crashes/exits before its own brief-mandated report still leaves a durable trace. */
const BACKSTOP_COMPLETION_KINDS = new Set(['review', 'fix', 'inspect', 'ci-heal']);

/**
 * we:scripts/conveyor/session-reaper.mjs#planBackstopCompletion — THE ROOT-CAUSE FIX (epic #3383, xbv32pg
 * follow-up), not merely a detection axis. {@link classifySessionReapWithGroundTruth}'s hung/ground-truth/idle
 * axes let the reaper independently CONCLUDE a session is done without ever needing its own self-report — but
 * until now, concluding that left no trace: a session whose own review/fix brief crashed before running
 * `completion-cli.mjs report --status=done` stayed `status: 'started'` in its completion record FOREVER, even
 * after this reaper correctly stopped it. `reconcile-core.mjs#markSelfReportedDone` (and any other future
 * reader of a completion record) then has no way to tell "still genuinely in flight" apart from "finished,
 * just never wrote it down" — the exact gap that froze `web-everything/web-everything#2599` and its five siblings for
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
 *
 * #4306 (epic #3383/#4075, BLOCKER fix-2821, live 2026-09-27) — GUARD 1: "a completion record only ever speaks
 * for the session that wrote it." A session name (`fix-<pr>`/`review-<pr>`/…) is SHARED across every dispatch
 * generation for that PR — a fixer re-dispatched after a bounce writes to the SAME file the previous fixer did.
 * Two live generations under one name (a finished-but-not-yet-reaped OLD fixer A, and a freshly dispatched NEW
 * fixer B) means a backstop write planned FOR A can land on B's own `started` record instead — this reaper does
 * not itself know which generation `existingRecord` belongs to unless told. Returns `null` (writes nothing, the
 * reap itself still proceeds — see this function's own callers) when ANY of these holds:
 *   (a) `existingRecord.sessionId` is set and differs from the reaped `session`'s own `sessionId` — a foreign
 *       record; whoever wrote it is not this session, so this session never gets to overwrite it as `done`.
 *   (b) `newerSameNameListed` — the reaper's OWN listing (it already reads `claude agents --json --all`) shows
 *       ANOTHER same-name session that started after this one: a newer generation already owns the name, even
 *       before its own `started` report has necessarily landed (closes the ~26s listing-lag window).
 *   (c) `existingRecord.status === 'started'` and its `startedAt` is LATER than `lastActivityMs` — the reaped
 *       session's own last confirmed transcript activity (the SAME fact the idle-finished axis already reads,
 *       injected here rather than re-derived). A session cannot have written a record after it went quiet, so a
 *       `started` record timestamped after that is provably not its own. A PLAIN comparison against the
 *       session's LISTING `startedAt` is deliberately NOT used instead: a session's own genuine `started` report
 *       always lands a few seconds after its process starts, which would wrongly skip ITS OWN legitimate
 *       backstop (independent Codex review finding 1, `we:backlog/4306-*.md`) — `lastActivityMs` (which trails
 *       the session's actual work, not merely its process start) does not have that false-positive.
 * (a) and (c) can never fire when `existingRecord` is `null` (nothing on disk to be foreign, or stale relative
 * to) — those two only ever narrow an EXISTING-record backstop. (b) is the one exception: it is checked
 * UNCONDITIONALLY, independent of `existingRecord`, precisely because "a newer generation already owns the
 * name" is true whether or not anything has been written under it yet — a fresh mint can be blocked too
 * (independent panel review finding, `we:backlog/4306-*.md`; this line previously claimed otherwise).
 *
 * @param {{name?:string, sessionId?:string|null}|null|undefined} session
 * @param {{status?:string, sessionId?:string|null, startedAt?:string}|null} existingRecord - {@link
 *   ../operations/completion-store.mjs#tryReadCompletion}'s own return shape, or `null` when nothing is on disk
 *   yet.
 * @param {() => string} [now] - injectable ISO-8601 clock (mirrors every other pure-ish constructor in this
 *   codebase's completion-record family).
 * @param {boolean} [blockedOnInfra] - live incident (PR #2647/#2625, 2026-09-25): a session can crash AFTER
 *   deciding it is blocked on infra but BEFORE the `completion-cli.mjs report --outcome=blocked-on-infra` call
 *   itself ever runs — its own transcript says one thing, its completion record (or lack of one) says another.
 *   Writing the generic {@link UNREPORTED_EXIT_OUTCOME} in that case throws away a real, recoverable signal:
 *   `reconcile-core.mjs#markSelfReportedDone`'s 15-minute infra-retry cool-off only ever keys on the LITERAL
 *   `blocked-on-infra` outcome, so a session's own stated cause is lost the moment this reaper backstops it
 *   with the wrong label. `false` (the default) is byte-identical to this function's pre-existing behavior —
 *   the CALLER ({@link runSessionReaperPass}, via {@link transcriptShowsIntendedBlockedOnInfra}) decides this;
 *   this function stays pure and takes the verdict as a plain boolean, never touching a transcript itself.
 * @param {boolean} [stalled] - #4090: the reap reason was this file's own no-net-outcome axis (a looping bot,
 *   never a crash) — mints {@link STALLED_OUTCOME} instead. Takes precedence over `blockedOnInfra`/`authExpired`
 *   when more than one is somehow true (a no-outcome verdict is this reaper's OWN definite conclusion; a
 *   transcript's stray mention of infra trouble, or an auth failure, is comparatively weaker evidence and never
 *   overrides it). Only `review`/`fix` sessions can carry any of the three — item-kind sessions
 *   (`conveyor`/`prepare`/`prepare-decision`) still have no completion-record schema at all, unchanged from
 *   before this card.
 * @param {boolean} [authExpired] - live incident, night of 2026-09-25/26 ET (see `hung-session.mjs`'s own file
 *   header for the full transcript shape): the reap reason was this file's own Claude-auth-expired axis. Mints
 *   the SAME {@link BLOCKED_ON_INFRA_OUTCOME} `blockedOnInfra` already does (an expired login is exactly the
 *   transient-infra-outage shape `markSelfReportedDone`'s 15-minute cool-off exists for — the operator logs back
 *   in and retries make sense again), plus {@link CLAUDE_AUTH_OUTCOME_LABEL} so a reader can tell WHICH kind of
 *   infra outage this was. Never overrides `stalled` (see above); outranks a bare `blockedOnInfra` when both are
 *   somehow true, since this axis is a literal transcript-content match, not a heuristic phrase scan.
 * @param {{newerSameNameListed?:boolean, lastActivityMs?:number|null}} [o] - #4306 Guard-1 inputs, see (b)/(c)
 *   above. Both default to the pre-#4306 behavior (neither condition ever fires) so every existing caller that
 *   does not pass this option is unaffected.
 * @returns {object|null} the completion record to write, or `null` when nothing is owed.
 */
export function planBackstopCompletion(session, existingRecord, now = () => new Date().toISOString(), blockedOnInfra = false, stalled = false, authExpired = false, { newerSameNameListed = false, lastActivityMs = null } = {}) {
  if (existingRecord && existingRecord.status === 'done') return null; // a real terminal record — never touch it
  const parsed = parseSessionSlug(session?.name);
  if (!parsed || parsed.itemKind) return null; // no grammar match, or an item-kind session (conveyor-*/prepare-*
  //                                               / prepare-decision-*) — those never carry a completion record.
  if (!BACKSTOP_COMPLETION_KINDS.has(parsed.kind)) return null; // e.g. `ci-heal` — no completion-record kind exists
  // #4306 Guard 1 — see this function's own doc above for (a)/(b)/(c).
  if (newerSameNameListed) return null; // (b) — independent of whether a record exists yet
  if (existingRecord) {
    // #4306 review finding (correctness) — sourced from the ONE shared predicate every reader/writer of a
    // completion record's `sessionId` binds through now (`we:scripts/operations/completion-record.mjs
    // #isForeignCompletionSessionId`), so this guard can never silently diverge from `makeCompletionResolver`'s
    // own (below) or `reconcile-core.mjs#markSelfReportedDone`'s.
    if (isForeignCompletionSessionId(session?.sessionId, existingRecord.sessionId)) return null; // (a)
    if (existingRecord.status === 'started') {
      const recStartedMs = Date.parse(existingRecord.startedAt ?? '');
      if (Number.isFinite(recStartedMs) && Number.isFinite(lastActivityMs) && recStartedMs > lastActivityMs) return null; // (c)
    }
  }
  const base = existingRecord ?? newCompletionRecord({ session: session.name, kind: parsed.kind, pr: parsed.id, now });
  const outcome = stalled ? STALLED_OUTCOME : ((authExpired || blockedOnInfra) ? BLOCKED_ON_INFRA_OUTCOME : UNREPORTED_EXIT_OUTCOME);
  // #4306 Guard 2 — the backstop stamps the REAPED session's own sessionId, so downstream readers
  // (`reconcile-core.mjs#markSelfReportedDone`, this file's own `makeCompletionResolver`, `session-verdicts.mjs`)
  // can tell this record apart from a future generation's, the same way a genuine self-report already would.
  const patch = { status: 'done', outcome, sessionId: session?.sessionId ?? existingRecord?.sessionId ?? null };
  if (!stalled && authExpired) patch.label = CLAUDE_AUTH_OUTCOME_LABEL;
  return applyCompletionUpdate(base, patch, now);
}

/** How many transcript tail lines / bytes / chars-per-field {@link transcriptShowsIntendedBlockedOnInfra} reads
 *  — generous relative to `hung-session.mjs`'s own `READ_TAIL_LINES`/`READ_MAX_BYTES` (a crash can leave a
 *  longer trailing thought than a routine liveness check needs), still a BOUNDED read, never the whole file. */
const BLOCKED_ON_INFRA_TAIL_LINES = 60;
const BLOCKED_ON_INFRA_MAX_BYTES = 600_000;
const BLOCKED_ON_INFRA_FIELD_MAX = 4000;

/** Matches the phrase a review/fix agent brief instructs an agent to self-report verbatim
 *  (`skills-src/review/review-agent-brief.md`: "report done on infra failure … outcome=blocked-on-infra") —
 *  case-insensitive, tolerant of a hyphen or a space (`blocked on infra`), since a crashing agent's own final
 *  words are prose, not guaranteed to be the exact CLI flag spelling. */
const BLOCKED_ON_INFRA_TEXT_RE = /blocked[- ]on[- ]infra/i;

/**
 * we:scripts/conveyor/session-reaper.mjs#transcriptShowsIntendedBlockedOnInfra — live incident (PR #2647/#2625,
 * 2026-09-25): a review/fix session can decide it is blocked on infra (state that in its own transcript, or
 * even attempt the `completion-cli.mjs report --outcome=blocked-on-infra` call) and then crash/exit before that
 * write durably lands — the SAME crash-before-self-report gap {@link planBackstopCompletion}'s own header
 * documents for `status: done` generally, specialized here for the ONE outcome that changes downstream
 * behavior: `reconcile-core.mjs#markSelfReportedDone` holds a `blocked-on-infra` outcome to its 15-minute
 * cool-off before treating the session as finished, so the PR is retried once the (transient) infra recovers —
 * a `blocked-on-infra` intent silently downgraded to the generic {@link UNREPORTED_EXIT_OUTCOME} loses that
 * cool-off/retry behavior entirely, exactly the loss this function exists to prevent.
 *
 * READS THE SESSION'S OWN TRANSCRIPT, bounded tail only ({@link BLOCKED_ON_INFRA_TAIL_LINES}/
 * {@link BLOCKED_ON_INFRA_MAX_BYTES}), reusing `we:skills-src/inspect-agent-health/agent-health.mjs`'s already-
 * tested `tailLines`/`summarizeEntry` (the SAME pair `hung-session.mjs#readHungInfo` uses — WIDEN, never grow a
 * private second reader) and `we:scripts/operations/agent-usage-report.mjs#resolveSessionTranscript` for the
 * path. Scans, NEWEST first, every `text`/`thinking` block for the phrase (a crashing agent's own stated
 * conclusion) and every `tool_use` block's raw input for the phrase (an attempted-but-never-completed
 * `completion-cli.mjs report --outcome=blocked-on-infra` call — the input string carries the flag literally).
 * The FIRST match wins; there is no need to scan past the newest evidence.
 *
 * Any failure — no `cwd`/`sessionId` on the row, no transcript found, an unreadable file — answers `false`,
 * never a guess: this function only ever UPGRADES a backstop write from the generic outcome to the specific
 * one, so "unknown" must default to the SAME behavior as before this function existed, not to a fabricated
 * `blocked-on-infra` a reader would then wrongly hold to a cool-off that never actually applied.
 * @param {{cwd?:string, sessionId?:string}|null|undefined} session
 * @param {{resolveTranscript?:Function, tailLinesFn?:Function, summarizeEntryFn?:Function}} [io]
 * @returns {boolean}
 */
export function transcriptShowsIntendedBlockedOnInfra(session, {
  resolveTranscript = resolveSessionTranscript,
  tailLinesFn = tailLines,
  summarizeEntryFn = summarizeEntry,
} = {}) {
  const cwd = session?.cwd, sessionId = session?.sessionId;
  if (!cwd || !sessionId) return false;
  let file;
  try {
    file = resolveTranscript({ session: String(sessionId), cwd: String(cwd) });
  } catch {
    return false; // no transcript found — never guess
  }
  let lines;
  try {
    ({ lines } = tailLinesFn(file, BLOCKED_ON_INFRA_TAIL_LINES, BLOCKED_ON_INFRA_MAX_BYTES));
  } catch {
    return false; // unreadable transcript — never guess
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = summarizeEntryFn(lines[i], BLOCKED_ON_INFRA_FIELD_MAX);
    } catch {
      continue; // one unparseable line never aborts the scan
    }
    // `entry.kind === 'assistant'` guards the text/thinking match — checked live against a real transcript
    // (PR #2647's own review-2647 sessions): the injected review-agent BRIEF (a `user`-role entry, the very
    // first line of every dispatch) quotes this exact phrase as an INSTRUCTION ("report … outcome=blocked-on-
    // infra"), which would otherwise false-positive on any short-lived crash whose tail still includes it. A
    // `tool_use` block needs no such guard — only an assistant ever emits one.
    for (const block of entry?.blocks ?? []) {
      if (entry.kind === 'assistant' && (block.kind === 'text' || block.kind === 'thinking') && BLOCKED_ON_INFRA_TEXT_RE.test(block.text ?? '')) return true;
      if (block.kind === 'tool_use' && BLOCKED_ON_INFRA_TEXT_RE.test(block.input ?? '')) return true;
    }
  }
  return false;
}

/**
 * we:scripts/conveyor/session-reaper.mjs#resolveLastActivityMs — #4306 Guard-1(c)'s own IO: the reaped
 * session's own last CONFIRMED transcript activity, in epoch ms, or `null` when it cannot be determined
 * (no `cwd`/`sessionId`, no transcript found, an unreadable file, or a failed `mtime` fallback — never a
 * guess). Delegates to `we:scripts/conveyor/hung-session.mjs#readTranscriptTailActivity` (#4312) — the ONE
 * shared tail-read + newest-entry-timestamp + mtime-fallback primitive `readIdleFinishedInfo`/`readHungInfo`
 * also call, so this is no longer a third near-identical copy of the same dozen lines. Kept as its own
 * exported function (rather than callers reaching into the primitive directly) since `planBackstopCompletion`
 * needs the raw milliseconds, not a threshold-relative verdict — the primitive's other two callers only ever
 * need the latter. Every injectable IO option here is forwarded straight through, unchanged in name or
 * default, and this function ignores the primitive's `hadUnparseableLine` flag entirely — unlike
 * `readHungInfo`/`readIdleFinishedInfo` (#4312 converge review), this caller never reads `entries` for
 * anything, so a skipped bad line changes nothing it cares about. The same tolerant behavior this function
 * had before #4312's extraction, with one strictly-safer addition inherited from the shared primitive: a
 * malformed `tailLinesFn` result (a non-array `lines`) now answers `null` instead of throwing a `TypeError`
 * out of this function — the primitive's own doc covers that case.
 * @param {{cwd?:string, sessionId?:string}|null|undefined} session
 * @returns {number|null}
 */
export function resolveLastActivityMs(session, {
  resolveTranscript = resolveSessionTranscript,
  tailLinesFn = tailLines,
  summarizeEntryFn = summarizeEntry,
  statFn = statSync,
} = {}) {
  const tail = readTranscriptTailActivity(session, {
    tailLines: BLOCKED_ON_INFRA_TAIL_LINES,
    maxBytes: BLOCKED_ON_INFRA_MAX_BYTES,
    fieldMax: BLOCKED_ON_INFRA_FIELD_MAX,
    resolveTranscript,
    tailLinesFn,
    summarizeEntryFn,
    statFn,
  });
  return tail ? tail.lastActivityMs : null;
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
 * failure (web-everything/web-everything `review-2582`, state `working`, dead) this axis exists to close. Injected
 * as `hungFor(session)`, mirroring `completionFor`/`groundTruthFor`'s own try/catch-to-null discipline in the
 * caller — never called for a session missing `cwd`/`sessionId`, and any read failure answers "not hung",
 * never a guess.
 *
 * AXIS -1 — NO-NET-OUTCOME STALL (#4090, epic #3383/#4075 continuation, statute clause 2), checked FIRST OF
 * ALL, ahead of even axis 0. Same reasoning as axis 0's own doc for why it must outrank `neverReapWorking`: its
 * entire premise is that `state: 'working'` can be HONEST about the process while still being the WRONG
 * ANSWER to "is this bot doing anything useful" — a looping bot is genuinely, busily `working`, producing
 * transcript activity axis 0 would never flag, while never advancing the actual job it was dispatched for. A
 * daemon mode that trusts the listing's `state` above every other signal (`neverReapWorking: true`) still needs
 * this axis, because the listing's `state` was never wrong about liveness here — only about progress. Injected
 * as `noOutcomeFor(session)`, mirroring every other resolver's try/catch-to-null discipline.
 *
 * @param {object|null} session
 * @param {((target:{kind:'item'|'pr', id:string}) => ({resolved:boolean, evidence?:string}|null))|null} [groundTruthFor]
 * @param {{
 *   allowedCwd?: string,
 *   neverReapWorking?: boolean,
 *   completionFor?: ((nameOrRow:string|{name:string, sessionId?:string|null}) => ({done:boolean}|null))|null,
 *   idleThresholdMs?: number,
 *   now?: number,
 *   hungFor?: ((session:object) => ({hung:boolean, reason?:string}|null))|null,
 *   noOutcomeFor?: ((session:object) => ({stall:boolean, reason?:string}|null))|null,
 *   chatSpawnGuardFor?: ((session:object) => ({blocked:boolean, reason?:string})|null)|null,
 *   authExpiredFor?: ((session:object) => ({authExpired:boolean, reason?:string}|null))|null,
 *   awaitingVerifyFor?: ((session:object) => ({awaiting:boolean}|null))|null,
 *   idleFinishedFor?: ((session:object) => ({finished:boolean, reason?:string}|null))|null,
 *   pidDeadFor?: ((session:object) => ({dead:boolean, reason?:string}|null))|null,
 * }} [opts]
 * @returns {{reap:boolean, reason:string}}
 */
export function classifySessionReapWithGroundTruth(session, groundTruthFor, opts = {}) {
  const {
    allowedCwd, neverReapWorking = false, completionFor = null, idleThresholdMs = 0, now = Date.now(),
    hungFor = null, noOutcomeFor = null, chatSpawnGuardFor = null, authExpiredFor = null, idleFinishedFor = null, awaitingVerifyFor = null,
    pidDeadFor = null,
  } = opts || {};
  // An awaiting session reads state:'done' because it ended its turn on purpose. The harness owns it
  // until the verdict; DEFAULT_AWAIT_VERIFY_TTL_MS in we:scripts/conveyor/await-verify.mjs bounds the
  // exemption so a crashed harness cannot pin it forever.
  if (typeof awaitingVerifyFor === 'function') {
    let info = null;
    try { info = awaitingVerifyFor(session); } catch { info = null; }
    if (info?.awaiting === true) return { reap: false, reason: 'awaiting-verify' };
  }
  const base = classifySessionReap(session, { allowedCwd, chatSpawnGuardFor });
  if (base.reap) return base;
  // Live-caught 2026-09-26 (review-daemon log): `classifySessionReap` checks `cwd` BEFORE `state`, so a session
  // already `stopped` in a per-session scratch cwd came back `wrong-cwd`, and the #4149 upgrade axes below then
  // re-reaped it — `claude stop` on the same ~240 stopped sessions, every tick, forever. A stopped session has
  // nothing left to stop, whichever cwd it ran in.
  if (ALREADY_STOPPED_STATES.has(session?.state)) return { reap: false, reason: 'already-stopped' };
  if (base.reason !== 'not-terminal' && base.reason !== 'wrong-cwd') return base;
  // #4149 (epic #3383/#4075) — `wrong-cwd` and `not-terminal` are the only two base reasons axes -1/0 below may
  // still upgrade. LIVE, live-caught 2026-09-25: `fix-2003`/`fix-2115`/`fix-2267` were dispatched with `cwd`
  // values (the primary `webeverything` checkout, a scratch-dispatcher clone) other than the review-daemon's own
  // `allowedCwd`, and sat `state:'working'` for TEN DAYS — past the `fix` kind's own 120-minute no-outcome
  // ceiling (`hung-session.mjs#NO_OUTCOME_DEFAULT_MINUTES`) — because `wrong-cwd` short-circuited every axis
  // below it, including this one: "ghosts older than any window never swept" (#4075 audit). `review-2669`/
  // `review-2678` were the identical shape one axis over (dispatched into a per-review scratch clone, not this
  // checkout, idle 41/46 minutes — past the 30-minute hung-transcript default).
  const cwdMismatch = base.reason === 'wrong-cwd';

  // Axis -1 — no-net-outcome stall. See doc above for why this runs BEFORE axis 0 and BEFORE `neverReapWorking`.
  // #4149 — ALSO runs ahead of a `wrong-cwd` verdict, for the identical reason: a per-kind ceiling this far
  // exceeded is independently-corroborated evidence that does not depend on which checkout dispatched the
  // session (unlike axis 3's blind clock below, which has no such corroboration and stays cwd-gated).
  if (typeof noOutcomeFor === 'function') {
    let info = null;
    try { info = noOutcomeFor(session); } catch { info = null; }
    if (info && info.stall === true) return { reap: true, reason: `no-outcome:${info.reason || 'stalled'}` };
  }

  // Axis AUTH — Claude CLI auth-expired detection (live incident, night of 2026-09-25/26 ET; see
  // `hung-session.mjs`'s own file header for the full transcript shape). SAME TIER as axis -1/0 above/below,
  // for the identical reason: a session whose OWN transcript shows the CLI's auth failure is independently
  // confirmed done — its entire transcript IS that one failed turn, nothing ever appends after it — regardless
  // of what the listing's own `state` says (these sessions sat `blocked`/`idle`, never advancing) and regardless
  // of `cwd` (a dispatched fix/ci-heal session's `cwd` is its own per-session scratch dir, never the daemon's
  // `allowedCwd`, so `wrong-cwd` would otherwise short-circuit this exactly the way #4149's own audit found for
  // the hung/no-outcome axes). Checked ahead of axis 0's generic 30-minute hung-transcript timeout because this
  // is a MORE SPECIFIC, INSTANT signal — no reason to wait out a staleness window when the transcript already
  // names the exact cause.
  if (typeof authExpiredFor === 'function') {
    let info = null;
    try { info = authExpiredFor(session); } catch { info = null; }
    if (info && info.authExpired === true) return { reap: true, reason: `claude-auth-expired:${info.reason || 'claude-auth'}` };
  }

  // Axis 0 — hung-transcript detection. See doc above for why this runs BEFORE `neverReapWorking` below, and
  // why that override is safe: it is independently confirming the listing's `state` is wrong, not ignoring it.
  // #4149 — same `wrong-cwd` override as axis -1, same reasoning.
  if (typeof hungFor === 'function') {
    let info = null;
    try { info = hungFor(session); } catch { info = null; }
    if (info && info.hung === true) return { reap: true, reason: `hung-transcript:${info.reason || 'stale'}` };
  }

  // Axis IDLE — general idle-turn-ended backstop (#4075/xg7m2wq, live incident PR #2724, 2026-09-26): a session
  // whose own last assistant turn fully ended (no pending tool call) and has sat idle past a short threshold is
  // independently confirmed finished, the SAME tier as axis AUTH/0 above and for the identical reason — this
  // does not depend on the listing's `state`, on `cwd` (a dispatched session's `cwd` is its own scratch dir), or
  // on the session's `kind` carrying any completion-record/no-outcome schema at all. It exists specifically as
  // the catch-all for a brief that forgot its own completion-report step (`fix-agent-ci-brief.md` did, for
  // every ci-heal session, until this same card fixed the root cause) — so it is checked here regardless.
  if (typeof idleFinishedFor === 'function') {
    let info = null;
    try { info = idleFinishedFor(session); } catch { info = null; }
    if (info && info.finished === true) return { reap: true, reason: `idle-finished:${info.reason || 'turn-ended-idle'}` };
  }

  // Axis PID-DEAD (#ghost-sessions-inflate-cap) — LAST of the cwd-bypassing axes, deliberately: a session whose
  // OWN process is CONFIRMED gone (the same two-signal `resolvePidAlive`/`scanPsOutput` probe
  // `lease-reaper.mjs`/`tick-core.mjs`'s durable-build floor already use: the row's own `pid` when present, else
  // a `ps aux` scan for its full `sessionId`) is independently corroborated evidence, exactly like axes
  // -1/AUTH/HUNG/IDLE above — it does not depend on `cwd` (a session dispatched from a scratch-dispatcher clone
  // is legitimately `wrong-cwd` for every daemon's own `allowedCwd`, which is precisely why the axes above
  // already bypass it) OR on the listing's own `state` (a live incident found 18 `conveyor-NNNN` sessions stuck
  // `state:'working'` 20-26 DAYS, every one with a confirmed-dead pid, none ever reaped because `wrong-cwd`
  // short-circuited every other axis too, and this was the one axis missing). Ordered LAST because it is the
  // COARSEST signal (a dead process proves the session is over, but says nothing about WHY — a hung/hidden-auth-
  // failure/idle-finished axis above names a more specific, more useful reason for the same underlying session,
  // when one applies) — the exact same "more specific signal wins" reasoning axis AUTH's own doc gives for
  // running ahead of axis HUNG. `pidDeadFor` returns `null` (never a guess) when neither signal can answer — a
  // session with no discoverable pid AND no `ps` snapshot to fall back on is left to the axes below, not
  // assumed dead.
  if (typeof pidDeadFor === 'function') {
    let info = null;
    try { info = pidDeadFor(session); } catch { info = null; }
    if (info && info.dead === true) return { reap: true, reason: `pid-dead:${info.reason || 'process-gone'}` };
  }

  // #4149 — neither corroborated axis fired: a `wrong-cwd` session falls through to `classifySessionReap`'s own
  // verdict here, unchanged. `allowedCwd`'s whole purpose (never touch a session that merely shares a name
  // pattern from an unrelated checkout) still holds for every axis below, which has no independent staleness
  // evidence of its own to fall back on.
  if (cwdMismatch) return base;

  if (neverReapWorking && session?.state === 'working') return base; // strictly-stricter mode — see doc above

  // Axis 1 — the session's own completion record (see doc above for why this is tried first).
  // #4306 — passes the ROW (never just the bare name) so a real `completionFor` (`makeCompletionResolver`) can
  // bind a `sessionId`-carrying record to THIS session and refuse to speak for a same-name foreign one; a mock
  // `completionFor` in an existing test that ignores its argument is unaffected either way.
  if (typeof completionFor === 'function') {
    const record = completionFor(session);
    if (record && record.done === true) return { reap: true, reason: 'completion-record-done' };
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
 *   completionFor?: ((nameOrRow:string|{name:string, sessionId?:string|null}) => ({done:boolean}|null))|null,
 *   idleThresholdMs?: number,
 *   now?: number,
 *   hungFor?: ((session:object) => ({hung:boolean, reason?:string}|null))|null,
 *   noOutcomeFor?: ((session:object) => ({stall:boolean, reason?:string}|null))|null,
 *   chatSpawnGuardFor?: ((session:object) => ({blocked:boolean, reason?:string})|null)|null,
 *   authExpiredFor?: ((session:object) => ({authExpired:boolean, reason?:string}|null))|null,
 *   awaitingVerifyFor?: ((session:object) => ({awaiting:boolean}|null))|null,
 *   idleFinishedFor?: ((session:object) => ({finished:boolean, reason?:string}|null))|null,
 *   pidDeadFor?: ((session:object) => ({dead:boolean, reason?:string}|null))|null,
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
    const state = String(parsed?.state || '').toUpperCase();
    const merged = Boolean(parsed?.mergedAt) || state === 'MERGED';
    // #4149 (epic #3383/#4075) — RATIFIED WIDENING: this axis used to answer `resolved` for a MERGED PR only,
    // "on purpose", so a still-`working` session was never stopped prematurely by a rebase-only close. Live audit
    // 2026-09-25 found the opposite failure costing more: a ghost session bound to a PR that was CLOSED WITHOUT
    // merging (abandoned, superseded, duplicate) had no path to ever being confirmed done by this axis — nothing
    // to fix, nothing to merge, and yet it sat forever. A closed PR is exactly as terminal as a merged one for
    // "is there still real work coming out of this session" — see `retentionGroundTruthForPr` below, which
    // already used this wider "merged or closed" test for the RETENTION sweep; this axis now matches it.
    const closed = state === 'CLOSED';
    return (merged || closed)
      ? { resolved: true, evidence: `pr#${pr}:${merged ? 'merged' : 'closed'}` }
      : { resolved: false };
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
 * #4149 (epic #3383/#4075) — ROOT-CAUSE CORRECTION, reversing #2588/review-loops' own prior fix. That change
 * (see git history, PR #2647-era) held `outcome: 'blocked-on-infra'` to the SAME {@link INFRA_RETRY_COOLOFF_MS}
 * cool-off `reconcile-core.mjs#markSelfReportedDone` applies, reasoning that reaping (stopping) the session mid
 * cool-off would erase its row from `claude agents --json` before the reconciler's own liveness read ever saw
 * it, defeating the cool-off one layer up. LIVE, 2026-09-25: that fix traded one bug for another. `review-2669`
 * sat `state: 'blocked'`, idle 41+ minutes, its OWN completion record already `status: 'done'`, `outcome:
 * 'blocked-on-infra'` — genuinely finished, no more work coming from that OS process — yet this resolver kept
 * answering `done: false` for the ENTIRE cool-off window (15 minutes) and beyond (nothing here ever re-checks
 * once the window is understood to have passed; the session-reaper's own next tick does, but the point is nothing
 * FORCED it to), so `claude stop` was never called and the process kept counting as a live holder against every
 * `claude agents` reader — exactly backwards from "never a live holder". The record — not whether the OS process
 * is still around — is what the retry pacing needs; keeping the PROCESS alive was never necessary to keep the
 * record's own cool-off honoured.
 *
 * THE FIX: this resolver now answers `done: true` as soon as `status: 'done'`, REGARDLESS of `outcome` — the
 * reaper stops the process immediately, every time, once the session says it is finished. The record itself is
 * untouched by stopping the process (`claude stop` never deletes a completion record), so
 * `reconcile-core.mjs#markSelfReportedDone` still reads the SAME record, still applies the SAME
 * {@link INFRA_RETRY_COOLOFF_MS} window, and still refuses to treat the PR as available for redispatch until
 * that window elapses — via `assessLiveness`'s own `awaitingInfraCooloff` flag (see that file), which now keys
 * the cool-off off the RECORD, never off whether a process happens to still be listed. Cool-offs and retries key
 * off the record; a live process is never required to enforce one.
 * #4306 (epic #3383/#4075) — GUARD 2, the reader half of "a completion record only ever speaks for the
 * session that wrote it." `completionFor` now also accepts a ROW `{name, sessionId, startedAt}` in place of a
 * bare `name` string — a STRING keeps this resolver's ENTIRE pre-#4306 behavior byte-identical (every caller
 * that only ever passes a name, e.g. a hand-authored test, is unaffected); a ROW additionally BINDS the answer
 * to that row's own `sessionId`: a record whose `sessionId` is set and does not match the row's never answers
 * `done: true`, however its `status` reads — a foreign record never speaks for this session, and is NEVER
 * silently treated as a legacy (`sessionId: null`) one just because the mismatch check didn't fire. A record
 * with no `sessionId` (a genuinely legacy record, predating this card, or written by a caller with no session
 * identity — `we:scripts/operations/review-job.mjs`) keeps today's plain `status === 'done'` rule unchanged.
 * @param {{dir?:string}} [io]
 * @returns {(nameOrRow:string|{name:string, sessionId?:string|null}) => ({done:boolean}|null)}
 */
export function makeCompletionResolver({ dir } = {}) {
  return function completionFor(nameOrRow) {
    const isRow = nameOrRow !== null && typeof nameOrRow === 'object';
    const name = isRow ? nameOrRow.name : nameOrRow;
    if (typeof name !== 'string' || !name) return null;
    try {
      const record = tryReadCompletion(name, dir);
      if (!record) return null;
      // #4306 review finding (correctness) — the row having no `sessionId` of its own is NOT an excuse to
      // accept a record that names someone else; sourced from the same shared predicate `planBackstopCompletion`
      // (above) and `reconcile-core.mjs#markSelfReportedDone` bind through, so all three can never diverge.
      if (isRow && isForeignCompletionSessionId(nameOrRow.sessionId, record.sessionId)) {
        return { done: false }; // foreign record — never speaks for this row's session, never downgraded to legacy
      }
      return { done: record.status === 'done' };
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
 * Build an `authExpiredFor` resolver for {@link sessionReapPlan} / {@link classifySessionReapWithGroundTruth}
 * (live incident, night of 2026-09-25/26 ET — see `hung-session.mjs`'s own file header for the full transcript
 * shape): reads the session's OWN transcript for the Claude CLI auth-failure signature via
 * `we:scripts/conveyor/hung-session.mjs#readClaudeAuthExpiredInfo` — the SAME shared detector
 * `reconcile-core.mjs`'s `markAuthExpiredSessions` uses, so this reaper and the reconciler can never disagree
 * about what "auth-expired" means (mirrors {@link makeHungResolver}'s own reasoning for the identical property).
 * @returns {(session:object) => ({authExpired:boolean, reason?:string}|null)}
 */
export function makeAuthExpiredResolver() {
  return function authExpiredFor(session) {
    try {
      return readClaudeAuthExpiredInfo(session);
    } catch {
      return null; // unreadable transcript / bad row shape — unknown, never reap on an unreadable signal
    }
  };
}

/**
 * Build an `idleFinishedFor` resolver for {@link sessionReapPlan} / {@link classifySessionReapWithGroundTruth}
 * (#4075/xg7m2wq, live incident PR #2724, 2026-09-26): reads the session's OWN "last turn fully ended, then sat
 * idle" verdict via `we:scripts/conveyor/hung-session.mjs#readIdleFinishedInfo` — the SAME shared detector
 * `reconcile-core.mjs`'s `markIdleFinishedSessions` uses, so this reaper and the reconciler can never disagree
 * about what "idle-finished" means (mirrors {@link makeHungResolver}/{@link makeAuthExpiredResolver}'s own
 * reasoning for the identical property). `thresholdMs` defaults to `resolveIdleFinishedThresholdMs()`
 * (`WE_IDLE_FINISHED_MINUTES`, default 10 min), read ONCE here in the IO shell, never inside the pure classifier.
 * Unlike `hungFor`/`authExpiredFor`, this backstop applies to EVERY session kind, including ones no other axis
 * in this file names at all (`conveyor`/`prepare`/`prepare-decision`/`investigate`/a future kind).
 * @param {{thresholdMs?:number, now?:()=>number}} [io]
 * @returns {(session:object) => ({finished:boolean, reason?:string}|null)}
 */
export function makeIdleFinishedResolver({ thresholdMs = resolveIdleFinishedThresholdMs(), now = Date.now } = {}) {
  return function idleFinishedFor(session) {
    try {
      return readIdleFinishedInfo(session, now(), thresholdMs);
    } catch {
      return null; // unreadable transcript / bad row shape — unknown, never reap on an unreadable signal
    }
  };
}

/**
 * Build a `pidDeadFor` resolver for {@link sessionReapPlan} / {@link classifySessionReapWithGroundTruth}
 * (#ghost-sessions-inflate-cap, live incident: 18 `conveyor-NNNN` sessions, `state:'working'`, 20-26 days old,
 * every one confirmed dead, none reaped because every one was ALSO `wrong-cwd` for whichever daemon happened to
 * scan the listing). Reuses `driver-watchdog.mjs#resolvePidAlive` — the SAME two-signal probe (the row's own
 * `pid` when present, else a `ps aux` scan for its full `sessionId`) `lease-reaper.mjs` and `tick-core.mjs`'s
 * durable-build floor already trust — never a THIRD, re-derived pid check (this file's own convention of citing
 * rather than re-deriving a shared primitive, same as {@link makeHungResolver} citing `hung-session.mjs`).
 *
 * `psSnapshot` is read ONCE per reaper pass (fresh `ps aux` output), not once per session — resolved lazily on
 * first use via `scanPsOutput` and memoized for the lifetime of the returned resolver, mirroring
 * `defaultListAgents`'s own single-listing-per-pass convention elsewhere in this file's IO shell.
 * @param {{isPidAlive?:(pid:number)=>boolean, scanPs?:()=>string}} [io]
 * @returns {(session:object) => ({dead:boolean, reason?:string}|null)}
 */
export function makePidDeadResolver({ isPidAlive = defaultIsPidAlive, scanPs = scanPsOutput } = {}) {
  let psSnapshot;
  let psRead = false;
  return function pidDeadFor(session) {
    try {
      if (!psRead) {
        try { psSnapshot = scanPs(); } catch { psSnapshot = null; }
        psRead = true;
      }
      const alive = resolvePidAlive(session, { psOutput: psSnapshot, isPidAlive });
      if (alive === false) {
        const via = Number.isInteger(Number(session?.pid)) && Number(session?.pid) > 0 ? `pid:${session.pid}` : 'ps-scan';
        return { dead: true, reason: via };
      }
      return null; // alive, or genuinely unknown (no pid, no ps snapshot) — never a guess
    } catch {
      return null; // unreadable — unknown, never reap on an unreadable signal
    }
  };
}

// ── NO-NET-OUTCOME STALL — THE IO SHELL (#4090, epic #3383/#4075, statute clause 2) ────────────────────────────
// Resolves "when did this session last produce a real outcome" per {@link NO_OUTCOME_KINDS}'s own table (see
// `hung-session.mjs`'s file header for the full per-kind mapping). Every resolver below answers `null` ONLY for a
// successful read that found no outcome yet, and `OUTCOME_UNREADABLE` on any read failure — unreadable git
// state, no `gh`, a missing file. The two must never collapse (PR #2676 review): "no outcome yet" lets the
// window run from `startedAt`, but "we could not look" may never authorize a window stop — only the ceiling.

/** How long ONE `git log` call here may run before it counts as unreadable — mirrors this file's own
 *  `prListTimeoutMs`-scale bounds (a local git op, but a lane clone on a network mount can still hang). */
const NO_OUTCOME_GIT_TIMEOUT_MS = 10_000;

/**
 * `conveyor` (build) / `fix` outcome: the timestamp of the newest commit ahead of `base` in the session's own
 * lane (`session.cwd`) — a real diff change, per the statute's own wording for both kinds ("the lane's net diff
 * against its base changed" / "commit or push that changes the net diff": a push is only possible once a
 * commit exists, so the commit itself is the earlier, sufficient signal). `null` when there is no commit ahead
 * of base yet (nothing to report — the classifier's own start-time fallback applies); `OUTCOME_UNREADABLE` when
 * the read fails.
 * @param {string} cwd
 * @param {{exec?:Function, base?:string}} [io]
 * @returns {number|null|typeof OUTCOME_UNREADABLE}
 */
export function lastCommitAheadOfBaseMs(cwd, { exec = execFileSync, base = 'main' } = {}) {
  if (!cwd) return OUTCOME_UNREADABLE;
  try {
    const out = String(exec('git', ['log', '-1', '--format=%ct', `${base}..HEAD`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: NO_OUTCOME_GIT_TIMEOUT_MS, killSignal: 'SIGKILL',
    })).trim();
    if (!out) return null; // no commit ahead of base yet — not an error, just nothing to report
    const epochSeconds = Number(out);
    return Number.isFinite(epochSeconds) ? epochSeconds * 1000 : OUTCOME_UNREADABLE;
  } catch {
    return OUTCOME_UNREADABLE; // unreadable lane / not a git repo / `base` unknown there — unknown, never a guess
  }
}

/**
 * `review` outcome: the newest comment's `createdAt` on the target PR — the statute's own "a review comment or
 * label" signal, scoped to comments (the dominant, always-present half of that pair in this codebase's own
 * review-core convention: every label change this repo's tooling makes is accompanied by a comment, so a
 * comment-only read misses no real case in practice — a documented scope, not silently assumed complete).
 * Reuses `dispatch-lane-io.mjs`'s own `prListTimeoutMs` bound, same convention as {@link groundTruthForPr}.
 * @param {string|number} pr
 * @param {{exec?:Function, env?:object, repo?:string}} [io]
 * @returns {number|null|typeof OUTCOME_UNREADABLE}
 */
export function lastReviewCommentMs(pr, { exec = execFileSync, env = process.env, repo = 'we' } = {}) {
  const slug = Object.hasOwn(CONSTELLATION_REPOS, repo) ? CONSTELLATION_REPOS[repo].slug : null;
  if (!slug) return OUTCOME_UNREADABLE;
  try {
    const out = exec('gh', ['pr', 'view', String(pr), '--repo', slug, '--json', 'comments'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
      timeout: prListTimeoutMs(env), killSignal: 'SIGKILL',
    });
    const comments = JSON.parse(String(out || '{}'))?.comments;
    if (!Array.isArray(comments)) return OUTCOME_UNREADABLE; // a malformed/empty response is not "no comments"
    if (comments.length === 0) return null;
    let newest = null;
    for (const c of comments) {
      const t = Date.parse(c?.createdAt ?? '');
      if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
    }
    return newest ?? OUTCOME_UNREADABLE; // comments exist but none carried a parseable time — malformed, not empty
  } catch {
    return OUTCOME_UNREADABLE;
  }
}

/**
 * `prepare` / `prepare-decision` outcome: the target item's own backlog file's mtime, INSIDE the session's own
 * lane (`session.cwd` + `backlog/`) — the statute's "the target item's own backlog file changing" signal. Same
 * id-prefix match `groundTruthForItem` already uses (`<id>.md` or `<id>-*.md`), scoped to the lane's own
 * checkout rather than this process's own `DEFAULT_BACKLOG_DIR` (a prepare session edits ITS lane's copy, not
 * this one's).
 * @param {string} cwd
 * @param {string} id
 * @param {{readdirSyncFn?:Function, statFn?:Function}} [io]
 * @returns {number|null|typeof OUTCOME_UNREADABLE}
 */
export function lastItemFileChangeMs(cwd, id, { readdirSyncFn = readdirSync, statFn = statSync } = {}) {
  if (!cwd || !id) return OUTCOME_UNREADABLE;
  const dir = join(cwd, 'backlog');
  let entries;
  try {
    entries = readdirSyncFn(dir);
  } catch {
    return OUTCOME_UNREADABLE;
  }
  const fname = entries.find((f) => f.endsWith('.md') && (f === `${id}.md` || f.startsWith(`${id}-`)));
  if (!fname) return null; // no card at all in this lane yet — not an error, nothing to report
  try {
    return statFn(join(dir, fname)).mtimeMs;
  } catch {
    return OUTCOME_UNREADABLE;
  }
}

/**
 * Build a `noOutcomeFor` resolver for {@link sessionReapPlan} / {@link classifySessionReapWithGroundTruth}
 * (#4090). Routes by `parseSessionSlug`'s own `kind` (never `sessionTarget`'s collapsed `'item'`/`'pr'` shape,
 * which loses exactly the distinction — `conveyor` vs `prepare` — this resolver needs) to the matching
 * outcome-timestamp function above, resolves that kind's window/ceiling settings once per call, and hands both
 * to {@link classifyNoOutcomeStall}. A kind {@link NO_OUTCOME_KINDS} does not cover (`ci-heal`/`inspect`, or an
 * unparseable name) answers `null` — this axis simply does not apply, never a guess.
 * @param {{exec?:Function, env?:object, readdirSyncFn?:Function, statFn?:Function, now?:()=>number}} [io]
 * @returns {(session:object) => ({stall:boolean, reason?:string}|null)}
 */
export function makeNoOutcomeResolver({
  exec = execFileSync,
  env = process.env,
  readdirSyncFn = readdirSync,
  statFn = statSync,
  now = Date.now,
} = {}) {
  return function noOutcomeFor(session) {
    const parsed = parseSessionSlug(session?.name);
    if (!parsed) return null;
    const kind = parsed.kind;
    if (!NO_OUTCOME_KINDS.includes(kind)) return null; // ci-heal/inspect — the statute never named these
    const windowMs = resolveNoOutcomeWindowMs(kind, env);
    const ceilingMs = resolveNoOutcomeCeilingMs(kind, env);
    const startedAtMs = typeof session?.startedAt === 'number' ? session.startedAt : null;
    if (!Number.isFinite(startedAtMs)) return null; // no known start — never a guessed baseline

    let lastOutcomeAtMs = null;
    if (kind === 'conveyor' || kind === 'fix') {
      lastOutcomeAtMs = lastCommitAheadOfBaseMs(session?.cwd, { exec });
    } else if (kind === 'review') {
      lastOutcomeAtMs = lastReviewCommentMs(parsed.id, { exec, env, repo: parsed.repo });
    } else if (kind === 'prepare' || kind === 'prepare-decision') {
      lastOutcomeAtMs = lastItemFileChangeMs(session?.cwd, parsed.id, { readdirSyncFn, statFn });
    }

    return classifyNoOutcomeStall({ startedAtMs, lastOutcomeAtMs, nowMs: now(), windowMs, ceilingMs });
  };
}

// ── CHAT-SPAWN LINK (#4091, epic #3383/#4075, statute `#conveyor-session-lifecycle-policy` clause 4) ──────────
// Records which CHAT (an interactive top-level session, never a daemon) spawned a background session, so
// cleanup can scope to it. The link is written at spawn time by a `SessionStart` hook (every NEW session,
// background or not, runs this hook — see `.claude/settings.json`); "was the spawning chat explicitly ended"
// is recorded separately by a `SessionEnd` hook, keyed by THAT chat's own session id.
//
// WHY THIS WORKS WITH NO NEW PLUMBING FOR THE LINK ITSELF. A background session started via `claude --bg` from
// inside an interactive session's own Bash tool call is a real OS child process, and `sanitizeSpawnEnv`
// (`dispatch-lane-io.mjs`) never strips `CLAUDE_CODE_SESSION_ID` — so a genuinely chat-spawned child's own
// process environment still carries the PARENT chat's session id (this repo's own `delivery-loop.md` already
// documents the identical fact for the opposite reason: "a subagent inherits its parent's
// CLAUDE_CODE_SESSION_ID"). A DAEMON-dispatched session has no such value to inherit — a resident daemon is a
// plain `node` process, never itself a `claude` session, so `CLAUDE_CODE_SESSION_ID` is simply unset in its own
// environment and in everything it spawns. The env var's mere PRESENCE at `SessionStart` is therefore already
// the "chat-spawned or not" signal; this axis only adds the missing piece — durably RECORDING it, since
// `claude agents --json` exposes no environment fields at all.
//
// `SessionEnd`'s exact `reason` enum is not independently verified against a live payload in this environment
// (no existing caller in this codebase reads it yet to ground it against) — documented honestly, not asserted.
// This axis treats the hook FIRING AT ALL as "ended": `SessionEnd` is a lifecycle-teardown hook, distinct from
// mere idle/disconnect (which invokes no hook — the process just stops sending activity, exactly the ambiguous
// shape the statute's own "never on idle or disconnect" line warns against relying on). If a future Claude Code
// version's `SessionEnd` payload carries a `reason` this repo later confirms includes a genuinely non-terminal
// case, narrowing the allowlist here is a one-line follow-up, not a redesign.
//
// INDEPENDENT REVIEW FINDING (PR #2678, 2026-09-25), FIXED — two real defects, both closed below:
//   1. CORRECTNESS: the store was originally keyed under `REPO_ROOT` (THIS process's own checkout) — for the
//      daemon-split deployment this whole epic targets, the `SessionStart` hook that WRITES the link runs
//      wherever the CHAT itself is (the primary checkout, a lane, a scratch clone), never the daemon's own
//      dedicated clone the reaper actually runs from. Keying it there made the guard read "no link" for every
//      real chat-spawned session in production — a silent no-op. FIXED: both stores now default to a
//      MACHINE-WIDE location under `~/.claude/`, the one place every checkout on the same host already agrees
//      on (mirrors how `~/.claude.json`/`~/.claude/projects/` are already the shared, cross-checkout home for
//      this CLI's own session state — never per-repo).
//   2. SECURITY: neither store validated WHO wrote a link/marker. Confirmed live (in a throwaway clone): a
//      forged `stamp-chat-spawn` call naming a victim session id, paired with a `CLAUDE_CODE_SESSION_ID` that
//      is never marked ended, granted that victim session PERMANENT reap immunity — worse than having no guard
//      at all, since no other axis (hung-detection, #4090's no-outcome-stall) could override it either. FIXED:
//      {@link classifyChatSpawnGuard} now takes a CEILING (mirrors {@link resolveNoOutcomeCeilingMs}'s own
//      clamp) — a link blocks reaping for AT MOST {@link resolveChatSpawnGuardCeilingMs}, regardless of what a
//      link/marker file claims, so a forged grant expires rather than lasting forever. This does not require
//      real authentication (a local, single-tenant CLI has no user boundary to authenticate across) — it
//      bounds the BLAST RADIUS of a bad write to a finite window instead, the same trade this file's other
//      ceilings already make.

/** `~/.claude/we-chat-spawns/<sessionId>.json` — the link store, machine-wide (see the FIXED note above for
 *  why this is NOT `REPO_ROOT`-relative). `OPERATION_CHAT_SPAWNS_DIR` overrides it. */
function resolveChatSpawnsDir(env = process.env) {
  const override = env.OPERATION_CHAT_SPAWNS_DIR;
  return override && override.trim() ? override.trim() : join(homedir(), '.claude', 'we-chat-spawns');
}

/** `~/.claude/we-chat-ended/<chatSessionId>.json` — the "this chat explicitly ended" marker store, machine-wide
 *  for the identical reason. `OPERATION_CHAT_ENDED_DIR` overrides it. */
function resolveChatEndedDir(env = process.env) {
  const override = env.OPERATION_CHAT_ENDED_DIR;
  return override && override.trim() ? override.trim() : join(homedir(), '.claude', 'we-chat-ended');
}

/** The chat-spawn guard's own ceiling (default 24h, generous for a legitimately long operator session) — see
 *  the FIXED security note above. `WE_CHAT_SPAWN_GUARD_CEILING_HOURS` overrides it; an unparsable/non-positive
 *  override falls back to the default rather than silently disabling the ceiling (same convention as
 *  {@link resolveNoOutcomeCeilingMs}). This ceiling has NO 'never' escape hatch, unlike the retention-sweep
 *  settings — a block that can never expire is exactly the defect being fixed, so unbounded is not offered. */
export function resolveChatSpawnGuardCeilingMs(env = process.env) {
  const raw = env?.WE_CHAT_SPAWN_GUARD_CEILING_HOURS;
  const n = raw !== undefined ? Number(raw) : 24;
  return (Number.isFinite(n) && n > 0 ? n : 24) * 60 * 60 * 1000;
}

/** Same-host clock-skew allowance; later timestamps cannot grant reap immunity (#4184). */
export const CHAT_SPAWN_LINK_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Filename-safe session ids only — both stores are keyed by a CLI-minted UUID, never free text. */
function isSafeSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

/**
 * we:scripts/conveyor/session-reaper.mjs#writeChatSpawnLink — the `SessionStart` hook's own write. Records
 * `spawnedSessionId` was started with `spawnedByChatSessionId` already live in its environment. A no-op
 * (never throws) when either id is unsafe as a filename — the CLI hook's own JSON malformed, or absent.
 */
export function writeChatSpawnLink({ spawnedSessionId, spawnedByChatSessionId, now = () => new Date().toISOString() } = {}, dir = resolveChatSpawnsDir()) {
  if (!isSafeSessionId(spawnedSessionId) || !isSafeSessionId(spawnedByChatSessionId)) return false;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${spawnedSessionId}.json`);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, spawnedSessionId, spawnedByChatSessionId, recordedAt: now() }, null, 2) + '\n');
    renameSync(tmp, path);
    return true;
  } catch {
    return false; // best-effort, mirrors every other sidecar writer in this codebase
  }
}

/**
 * we:scripts/conveyor/session-reaper.mjs#tryReadChatSpawnLink — `null` when no link is on record at all (the
 * "unchanged from today" default — see this section's own header). `{ok:false}` for a link that exists but is
 * corrupt/malformed — AMBIGUOUS, per the statute, never treated the same as "no link". `{ok:true,
 * spawnedByChatSessionId, recordedAtMs}` for a genuine, readable link — `recordedAtMs` (`null` if unparseable)
 * feeds {@link classifyChatSpawnGuard}'s own ceiling clamp, the security-finding fix (see file header).
 * @returns {null|{ok:false}|{ok:true, spawnedByChatSessionId:string, recordedAtMs:number|null}}
 */
export function tryReadChatSpawnLink(spawnedSessionId, dir = resolveChatSpawnsDir(), { readFileSyncFn = readFileSync, statFn = statSync } = {}) {
  if (!isSafeSessionId(spawnedSessionId)) return null;
  const path = join(dir, `${spawnedSessionId}.json`);
  let text;
  try {
    text = readFileSyncFn(path, 'utf8');
  } catch {
    return null; // no file — no link on record, never an error
  }
  // Independent-review finding, PR #2678 round 2 (2026-09-25), FIXED: an `{ok:false}` (ambiguous) answer must
  // still carry SOME age signal for {@link classifyChatSpawnGuard}'s own ceiling clamp to apply to it — the
  // file's own mtime, obtainable even when its CONTENT fails to parse (corrupt JSON, a bad `spawnedByChatSessionId`,
  // or a real link whose own `recordedAt` field itself failed to parse). Without this, the exact vulnerability
  // this PR fixes for an HONEST link (permanent reap immunity) came back for a MALFORMED one — the ceiling
  // check only ever ran on `recordedAtMs`, which was `null` for every one of these three cases.
  const mtimeFallbackMs = () => { try { return statFn(path).mtimeMs; } catch { return null; } };
  try {
    const parsed = JSON.parse(text);
    if (!isSafeSessionId(parsed?.spawnedByChatSessionId)) return { ok: false, recordedAtMs: mtimeFallbackMs() };
    const recordedAtMs = Date.parse(parsed?.recordedAt ?? '');
    return {
      ok: true,
      spawnedByChatSessionId: parsed.spawnedByChatSessionId,
      recordedAtMs: Number.isFinite(recordedAtMs) ? recordedAtMs : mtimeFallbackMs(),
    };
  } catch {
    return { ok: false, recordedAtMs: mtimeFallbackMs() }; // a file exists but is unreadable — ambiguous, never "no link"
  }
}

/** we:scripts/conveyor/session-reaper.mjs#markChatEnded — the `SessionEnd` hook's own write. A no-op (never
 *  throws) when `chatSessionId` is unsafe as a filename. */
export function markChatEnded(chatSessionId, dir = resolveChatEndedDir(), { now = () => new Date().toISOString() } = {}) {
  if (!isSafeSessionId(chatSessionId)) return false;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${chatSessionId}.json`);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, chatSessionId, endedAt: now() }, null, 2) + '\n');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** we:scripts/conveyor/session-reaper.mjs#isChatEnded — has `chatSessionId` (a spawning chat) been marked
 *  ended? Existence-only check (the record's own content is never consulted beyond "does it parse") — an
 *  unreadable/corrupt marker file answers `false` (NOT ended), the same safe direction as an ambiguous link. */
export function isChatEnded(chatSessionId, dir = resolveChatEndedDir(), { readFileSyncFn = readFileSync } = {}) {
  if (!isSafeSessionId(chatSessionId)) return false;
  try {
    const parsed = JSON.parse(readFileSyncFn(join(dir, `${chatSessionId}.json`), 'utf8'));
    return isSafeSessionId(parsed?.chatSessionId);
  } catch {
    return false;
  }
}

/**
 * we:scripts/conveyor/session-reaper.mjs#classifyChatSpawnGuard — PURE. The statute's own three-way rule, PLUS
 * the security-finding ceiling fix (see file header) — NOW APPLIED UNIFORMLY (round 2 fix, PR #2678):
 *   - `link === null` (no stamp at all — daemon-dispatched, or this feature simply hasn't stamped it, e.g. a
 *     session started before this axis shipped) → NOT blocked. This is the "unchanged from today" default.
 *   - `link.ok === true` and `ended === true` → NOT blocked, `chat-ended`.
 *   - With the clamp enabled, a timestamp beyond the clock-skew allowance is invalid: NOT blocked, `chat-spawn-link-future-dated`.
 *   - Otherwise (an `{ok:false}` ambiguous/corrupt link, OR a real link that is not yet ended) → BLOCKED, UNLESS
 *     `nowMs - link.recordedAtMs >= ceilingMs`, in which case → NOT blocked, `chat-spawn-guard-ceiling` — a
 *     forged, corrupted, or simply never-ended link cannot grant reap immunity FOREVER, mirroring
 *     {@link classifyNoOutcomeStall}'s own ceiling-always-wins precedent. Applying this check to BOTH blocked
 *     branches (not only the honest-link one) is the round-2 fix itself: the first cut let the ceiling apply
 *     only to a real link, so a MALFORMED one reintroduced the identical permanent-immunity bug through the
 *     `ambiguous-chat-link` path instead — {@link tryReadChatSpawnLink}'s own mtime fallback is what makes
 *     `link.recordedAtMs` available for that case too. `ceilingMs`/`recordedAtMs` of `null` (a caller that
 *     omits the clock, or a link whose age is somehow still unknowable even via mtime) disables the clamp for
 *     THAT check only — the surrounding block still applies — never silently widening it into a permanent one.
 *     When blocked and NOT saved by the ceiling: `chat-not-ended` for a real link, `ambiguous-chat-link` for a
 *     corrupt one — the reason always reflects which case it actually was.
 * @param {{link:null|{ok:false, recordedAtMs?:number|null}|{ok:true, spawnedByChatSessionId:string, recordedAtMs?:number|null}, ended?:boolean, nowMs?:number, ceilingMs?:number|null}} o
 * @returns {{blocked:boolean, reason:('no-link'|'ambiguous-chat-link'|'chat-ended'|'chat-not-ended'|'chat-spawn-guard-ceiling'|'chat-spawn-link-future-dated')}}
 */
export function classifyChatSpawnGuard({ link, ended = false, nowMs = Date.now(), ceilingMs = null } = {}) {
  if (link === null || link === undefined) return { blocked: false, reason: 'no-link' };
  if (link.ok === true && ended) return { blocked: false, reason: 'chat-ended' };
  // Independent-review finding, PR #2678 round 2 (2026-09-25), FIXED: the ceiling clamp used to sit ONLY on
  // this branch (a real, honest, not-yet-ended link) — the `link.ok !== true` (ambiguous/corrupt) case
  // returned BLOCKED immediately above, before ever reaching it, so a malformed link file granted the exact
  // PERMANENT reap immunity this whole ceiling exists to rule out, via a different code path. The clamp now
  // applies uniformly to BOTH "ambiguous" and "real but not ended" — `link.recordedAtMs` carries an age for
  // either case now (a real link's own `recordedAt`, or — for a corrupt one — the file's own mtime; see
  // {@link tryReadChatSpawnLink}'s own fix). `ceilingMs`/`recordedAtMs` of `null` (a caller that omits the
  // clock, or a link whose age is somehow still unknowable even via mtime) disables the clamp for THAT check
  // only — the surrounding block still applies — never silently widening a block into a permanent one.
  if (typeof ceilingMs === 'number' && ceilingMs > 0 && typeof link.recordedAtMs === 'number' && Number.isFinite(link.recordedAtMs)) {
    if (link.recordedAtMs - nowMs > CHAT_SPAWN_LINK_FUTURE_SKEW_MS) return { blocked: false, reason: 'chat-spawn-link-future-dated' };
    if (nowMs - link.recordedAtMs >= ceilingMs) return { blocked: false, reason: 'chat-spawn-guard-ceiling' };
  }
  return link.ok === true ? { blocked: true, reason: 'chat-not-ended' } : { blocked: true, reason: 'ambiguous-chat-link' };
}

/**
 * Build a `chatSpawnGuardFor` resolver for {@link classifySessionReap} (#4091). Reads the session's own link
 * (keyed by ITS `sessionId`, the full UUID `claude agents --json` reports — never the short `id`, which is not
 * what {@link writeChatSpawnLink}'s `SessionStart` hook receives) and, when linked, the spawning chat's own
 * ended-marker, then hands both to {@link classifyChatSpawnGuard}.
 * @param {{spawnsDir?:string, endedDir?:string, readFileSyncFn?:Function}} [io]
 * @returns {(session:object) => ({blocked:boolean, reason?:string})}
 */
export function makeChatSpawnGuardResolver({
  spawnsDir = resolveChatSpawnsDir(),
  endedDir = resolveChatEndedDir(),
  readFileSyncFn = readFileSync,
  ceilingMs = resolveChatSpawnGuardCeilingMs(),
  now = Date.now,
} = {}) {
  return function chatSpawnGuardFor(session) {
    const link = tryReadChatSpawnLink(session?.sessionId, spawnsDir, { readFileSyncFn });
    const ended = link?.ok === true ? isChatEnded(link.spawnedByChatSessionId, endedDir, { readFileSyncFn }) : false;
    return classifyChatSpawnGuard({ link, ended, nowMs: now(), ceilingMs });
  };
}

// ── RETENTION SWEEP (#4089, epic #3383/#4075, statute `#conveyor-session-lifecycle-policy` clause 1) ─────────
// Deletes a FINISHED session's own RECORDS (its completion record, its delivery report, its now-stale
// `claude agents` entry, plus terminal run records generally — see below) — a wholly separate axis from the
// STOP pass above. Stopping decides "is this process still doing anything"; retention decides "has the WORK
// this session served been over long enough that even the paper trail can go". A session can sit fully
// stopped for weeks with every record above still on disk today — `#4082`'s own card measured 1581 job
// entries and 92 `.operations/runs/` records live, with the delete helpers that already existed
// (`run-store.mjs#deleteRun`) never once called.
//
// THE TWO INDEPENDENT PATHS, straight from the ratified statute:
//   PATH A — confirmed-done + grace. The session's own target (its card, or its PR) is confirmed finished
//     (resolved, or merged/closed), its introspection has run, and — once #4071 ships — its cost is rolled
//     up; then a grace period (default 1 day) must elapse before deletion.
//   PATH B — the ceiling safety valve. Regardless of path A, a record older than the ceiling (default 30
//     days, mirroring Claude Code's own `cleanupPeriodDays`) is deleted anyway — the statute's own "the
//     ceiling also covers a card that never finishes" clause, so a parked card's session records do not sit
//     forever just because the card itself never resolves.
// Both settings independently accept `'never'` (parsed to `null`, disabling that path outright — never a `0`
// silently inferred from an unset value).

/** 1 day — statute's own shipped grace default (path A). `WE_RETENTION_GRACE_HOURS` overrides it (in HOURS,
 *  matching `hung-session.mjs`'s own `WE_HUNG_TRANSCRIPT_MINUTES` convention of naming the unit in the env var
 *  itself); the literal string `'never'` disables path A. */
export const RETENTION_GRACE_MS_DEFAULT = 24 * 60 * 60 * 1000;

/** 30 days — statute's own shipped ceiling default (path B), described as mirroring the host's own Claude Code
 *  `cleanupPeriodDays` setting (30 days as of this writing). This module has no IO surface onto that host
 *  setting's live value (it lives outside this repo, in the CLI's own config) — the constant below is a
 *  documented, deliberate approximation of it, not a claim of reading it live; a caller (an operator, or a
 *  future health-daemon slice) that wants the two to actually track raises both independently, per the
 *  statute's own wording. `WE_RETENTION_CEILING_DAYS` overrides it; `'never'` disables path B. */
export const RETENTION_CEILING_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000;

function parseRetentionDurationSetting(raw, unitMs, defaultMs) {
  if (raw === undefined) return defaultMs;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'never') return null; // explicitly disabled
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * unitMs : defaultMs; // an unparseable override never silently disables a path
}

/** `WE_RETENTION_GRACE_HOURS` → path A's grace, in ms. See {@link RETENTION_GRACE_MS_DEFAULT}. */
export function resolveRetentionGraceMs(env = process.env) {
  return parseRetentionDurationSetting(env.WE_RETENTION_GRACE_HOURS, 60 * 60 * 1000, RETENTION_GRACE_MS_DEFAULT);
}

/** `WE_RETENTION_CEILING_DAYS` → path B's ceiling, in ms. See {@link RETENTION_CEILING_MS_DEFAULT}. */
export function resolveRetentionCeilingMs(env = process.env) {
  return parseRetentionDurationSetting(env.WE_RETENTION_CEILING_DAYS, 24 * 60 * 60 * 1000, RETENTION_CEILING_MS_DEFAULT);
}

/**
 * THE PURE RETENTION VERDICT for one session's records. No fs/exec/clock — every signal is injected, same
 * discipline as {@link classifySessionReap}.
 *
 * `graceMs`/`ceilingMs` of `null` disables that path outright (the `'never'` setting) — checked explicitly
 * against `null`, never a falsy check, so `0` (an operator who wants IMMEDIATE deletion once confirmed done)
 * stays a real, distinct value from "disabled".
 *
 * @param {{workDone:boolean, terminalAt:number|null, introspectionDone:boolean, costRolledUp:boolean, recordAgeMs:number|null}} candidate
 * @param {{graceMs:number|null, ceilingMs:number|null, now:number}} opts
 * @returns {{deletable:boolean, reason:('ceiling'|'grace-after-done'|'not-yet')}}
 */
export function classifyRetention(candidate, { graceMs, ceilingMs, now }) {
  const { workDone, terminalAt, introspectionDone, costRolledUp, recordAgeMs } = candidate || {};
  // PATH B first — a safety valve independent of confirmation, so it still fires for a card that never
  // resolves (the statute's own explicit case for this ordering).
  if (ceilingMs !== null && typeof recordAgeMs === 'number' && Number.isFinite(recordAgeMs) && recordAgeMs >= ceilingMs) {
    return { deletable: true, reason: 'ceiling' };
  }
  if (
    workDone === true && introspectionDone === true && costRolledUp === true
    && graceMs !== null && typeof terminalAt === 'number' && Number.isFinite(terminalAt)
    && (now - terminalAt) >= graceMs
  ) {
    return { deletable: true, reason: 'grace-after-done' };
  }
  return { deletable: false, reason: 'not-yet' };
}

/**
 * Item-kind retention ground truth: `workDone` iff `status: resolved` (this repo's lifecycle has no distinct
 * `withdrawn` status today — see `we:backlog/4082-*.md`'s own Fork 1 wording versus `we:scripts/backlog.mjs`'s
 * real status vocabulary, `open`/`active`/`preparing`/`resolved`/`parked` — so a `parked` item, which may still
 * resume, is deliberately NOT treated as done here; conservatively under-deleting is the safe direction for a
 * destructive sweep). `terminalAt` is the item's own `dateResolved` field, parsed. A missing card, an unreadable
 * one, or a resolved card with no parseable `dateResolved`, all answer `workDone:false`/`terminalAt:null` —
 * never a guess that could delete records for work that is not actually confirmed over.
 * @param {string} id
 * @param {{backlogDir?:string, readdirSyncFn?:Function, readFileSyncFn?:Function}} [io]
 * @returns {{workDone:boolean, terminalAt:number|null}}
 */
export function retentionGroundTruthForItem(id, { backlogDir = DEFAULT_BACKLOG_DIR, readdirSyncFn = readdirSync, readFileSyncFn = readFileSync } = {}) {
  let entries;
  try {
    entries = readdirSyncFn(backlogDir);
  } catch {
    return { workDone: false, terminalAt: null };
  }
  const fname = entries.find((f) => f.endsWith('.md') && (f === `${id}.md` || f.startsWith(`${id}-`)));
  if (!fname) return { workDone: false, terminalAt: null };
  try {
    const text = readFileSyncFn(join(backlogDir, fname), 'utf8');
    if (readField(text, 'status') !== 'resolved') return { workDone: false, terminalAt: null };
    const resolvedAt = Date.parse(readField(text, 'dateResolved') ?? '');
    return { workDone: true, terminalAt: Number.isFinite(resolvedAt) ? resolvedAt : null };
  } catch {
    return { workDone: false, terminalAt: null };
  }
}

/**
 * PR-kind retention ground truth: `workDone` iff the PR is MERGED or CLOSED (the statute's own "merged or
 * closed" wording — {@link groundTruthForPr}, the STOP/reap axis, was widened to the identical "merged or
 * closed" test at #4149; both now agree a closed-without-merge PR is terminal). `terminalAt` is `mergedAt`
 * (when merged) or `closedAt` (when closed unmerged), parsed. Any failure (no `gh`, not found, timeout) answers
 * unknown, never a guess.
 * @param {string|number} pr
 * @param {{exec?:Function, env?:object, repo?:string}} [io]
 * @returns {{workDone:boolean, terminalAt:number|null}|null}
 */
export function retentionGroundTruthForPr(pr, { exec = execFileSync, env = process.env, repo = 'we' } = {}) {
  const slug = Object.hasOwn(CONSTELLATION_REPOS, repo) ? CONSTELLATION_REPOS[repo].slug : null;
  if (!slug) return null;
  try {
    const out = exec('gh', ['pr', 'view', String(pr), '--repo', slug, '--json', 'state,mergedAt,closedAt'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
      timeout: prListTimeoutMs(env),
      killSignal: 'SIGKILL',
    });
    const parsed = JSON.parse(String(out || '{}'));
    const state = String(parsed?.state || '').toUpperCase();
    const workDone = state === 'MERGED' || state === 'CLOSED' || Boolean(parsed?.mergedAt);
    const at = Date.parse(parsed?.mergedAt || parsed?.closedAt || '');
    return { workDone, terminalAt: workDone && Number.isFinite(at) ? at : null };
  } catch {
    return null;
  }
}

/**
 * Build a `retentionGroundTruthFor` resolver for {@link runRetentionSweepPass}, mirroring
 * {@link makeGroundTruthResolver}'s routing/caching/bound-`gh`-calls shape exactly (a SEPARATE cache and
 * counter — this pass and the stop pass never share a tick, but keeping the two independent means a change to
 * one's cost bound can never silently affect the other's).
 * @param {{exec?:Function, env?:object, backlogDir?:string, readdirSyncFn?:Function, readFileSyncFn?:Function, maxPrViewCalls?:number}} [io]
 */
export function makeRetentionGroundTruthResolver({
  exec = execFileSync,
  env = process.env,
  backlogDir = DEFAULT_BACKLOG_DIR,
  readdirSyncFn = readdirSync,
  readFileSyncFn = readFileSync,
  maxPrViewCalls = MAX_GH_PR_VIEW_CALLS_PER_TICK,
} = {}) {
  const cache = new Map();
  let prViewCalls = 0;
  return function retentionGroundTruthFor(target) {
    const repo = target.repo === undefined ? 'we' : target.repo;
    const key = target.kind === 'pr' ? `pr:${repo}:${target.id}` : `${target.kind}:${target.id}`;
    if (cache.has(key)) return cache.get(key);
    let result;
    if (target.kind === 'item') {
      result = retentionGroundTruthForItem(target.id, { backlogDir, readdirSyncFn, readFileSyncFn });
    } else if (target.kind === 'pr') {
      if (prViewCalls >= maxPrViewCalls) {
        result = null;
      } else {
        prViewCalls++;
        result = retentionGroundTruthForPr(target.id, { exec, env, repo: target.repo });
      }
    } else {
      result = null;
    }
    cache.set(key, result);
    return result;
  };
}

/**
 * Statute clause 1's introspection gate ([#automated-session-introspection], built by `#3477`, still `status:
 * open` as of this file's own writing — NOT yet on `main`). Mirrors this file's own `(once #4071 exists)`
 * precedent for the cost gate below: while the feature the gate depends on does not exist, the gate cannot
 * block on a signal that cannot be produced, so it defaults PERMISSIVE (`true`) — introspection is also off by
 * default (`WE_INTROSPECTION_ENABLED`, unset), so "has run" is vacuously true when it was never asked to run
 * at all. The moment an operator turns introspection ON ahead of `#3477` landing, this flips to FAIL-CLOSED
 * (`false`) rather than silently keep permitting deletion for a signal now expected to exist but that this
 * file still has no way to actually read — never guess in the direction that enables a destructive sweep.
 * @param {{env?:object}} [io]
 * @returns {(session:string) => boolean}
 */
export function makeIntrospectionDoneResolver({ env = process.env } = {}) {
  const enabled = Boolean(env.WE_INTROSPECTION_ENABLED) && env.WE_INTROSPECTION_ENABLED !== '0';
  return function introspectionDoneFor() {
    return !enabled; // see doc above: off (the default) ⇒ vacuously true; on ⇒ fail-closed until #3477 lands a real signal
  };
}

/**
 * Statute clause 1's cost-rollup gate — explicit deferral, verbatim from the ratified text: "This condition
 * applies only once #4071 exists. Until then, conditions 1 and 2 are enough." `#4071` (telemetry) is not yet
 * built, so this always answers `true` today; a `#4071` follow-on card wires this to a real rollup check, not
 * a new ruling. Kept as its own named resolver (rather than inlined `true`) so that follow-on card has exactly
 * one call site to change.
 * @returns {(session:string) => boolean}
 */
export function makeCostRolledUpResolver() {
  return function costRolledUpFor() {
    return true; // #4071 does not exist yet — statute's own explicit deferral, not a guess
  };
}

/**
 * `claude rm <id>` — deregisters an already-stopped background session entirely (distinct from `claude stop`,
 * which only ends it — see `we:scripts/operations/dispatch-abort.mjs#stopSession`'s own doc for that
 * distinction, mirrored here rather than re-imported since this file's scope for `#4089` does not touch
 * `dispatch-abort.mjs`). An already-gone handle is benign (`claude rm` reports the same "No job matching" shape
 * `claude stop` does), matching every other best-effort stop/rm call in this file.
 * @param {{handle:string, exec?:Function}} o
 * @returns {{removed:true, alreadyGone:boolean, output:string}}
 */
export function rmSessionRecord({ handle, exec = execFileSync } = {}) {
  const id = normalizeHandle(handle);
  if (!id) throw new Error('session-reaper: rmSessionRecord needs a handle');
  try {
    const output = String(exec('claude', ['rm', id], { encoding: 'utf8', timeout: 30_000 }));
    return { removed: true, alreadyGone: false, output };
  } catch (e) {
    const full = String(e?.stderr ?? e?.message ?? e);
    if (/No job matching/i.test(full)) return { removed: true, alreadyGone: true, output: full.split('\n')[0] };
    throw new Error(`session-reaper: \`claude rm ${id}\` failed: ${full.split('\n')[0]}`);
  }
}

/**
 * THE RETENTION-SWEEP IO SHELL (#4089) — everything the CLI's retention pass does between the two session-slug
 * record stores and the actual deletes, reusable by a resident daemon exactly like {@link runSessionReaperPass}.
 * Candidate slugs are the UNION of every slug carrying a completion record OR a delivery report (the two
 * session-keyed stores this file's scope covers) — a slug with only one of the two is still a real candidate
 * (e.g. a `review-*`/`fix-*` session that only ever wrote a completion record). A slug whose `sessionTarget`
 * cannot be derived (unknown grammar) is skipped, never guessed.
 *
 * The run-record axis is handled separately, by {@link pruneTerminalRuns} — see that function's own doc for
 * why it operates on record age/terminal-state generically rather than per-session (no session back-reference
 * exists on a generic run record).
 *
 * @param {{
 *   retentionGroundTruthFor?: (target:object) => ({workDone:boolean, terminalAt:number|null}|null),
 *   introspectionDoneFor?: (session:string) => boolean,
 *   costRolledUpFor?: (session:string) => boolean,
 *   graceMs?: number|null,
 *   ceilingMs?: number|null,
 *   now?: number,
 *   dryRun?: boolean,
 *   listAgents?: () => unknown[],
 *   rm?: Function,
 *   statFn?: Function,
 *   deleteCompletionFn?: Function,
 *   deleteDeliveryReportFn?: Function,
 *   pruneRuns?: Function,
 *   log?: (msg:string) => void,
 * }} [o]
 * @returns {{scanned:number, deleted:number, kept:number, runsPruned:number, wouldDelete:Array|undefined}}
 */
export function runRetentionSweepPass({
  retentionGroundTruthFor = makeRetentionGroundTruthResolver({ exec: execFileSync }),
  introspectionDoneFor = makeIntrospectionDoneResolver(),
  costRolledUpFor = makeCostRolledUpResolver(),
  graceMs = resolveRetentionGraceMs(),
  ceilingMs = resolveRetentionCeilingMs(),
  now = Date.now(),
  dryRun = false,
  listAgents = () => defaultListAgents({ exec: execFileSync, all: true }),
  rm = rmSessionRecord,
  statFn = statSync,
  deleteCompletionFn = deleteCompletion,
  deleteDeliveryReportFn = deleteDeliveryReport,
  pruneRuns = pruneTerminalRuns,
  log: logFn = log,
} = {}) {
  const completionDir = resolveCompletionsDir();
  const deliveryDir = resolveDeliveryReportsDir();
  const slugs = new Set([...listCompletionSessions(completionDir), ...listDeliveryReportSessions(deliveryDir)]);

  let sessionsByName = null;
  const findSession = (name) => {
    if (sessionsByName === null) {
      sessionsByName = new Map();
      try {
        for (const s of listAgents() ?? []) if (s && s.name) sessionsByName.set(s.name, s);
      } catch { /* best-effort — a stale/unreadable listing just means no `claude rm` this pass */ }
    }
    return sessionsByName.get(name) ?? null;
  };

  let deleted = 0;
  let kept = 0;
  const wouldDelete = dryRun ? [] : undefined;

  for (const slug of [...slugs].sort()) {
    const target = sessionTarget(slug);
    if (!target) { kept++; continue; } // unknown grammar — never guess

    const truth = retentionGroundTruthFor(target);
    const workDone = truth?.workDone === true;
    const terminalAt = truth?.terminalAt ?? null;

    let recordAgeMs = null;
    for (const p of [completionPath(slug, completionDir), deliveryReportPath(slug, deliveryDir)]) {
      try {
        const ageMs = now - statFn(p).mtimeMs;
        if (recordAgeMs === null || ageMs < recordAgeMs) recordAgeMs = ageMs; // youngest record wins — never
        //   delete on the ceiling while ANY of this session's records is still fresh
      } catch { /* that particular record doesn't exist for this slug — fine, try the other */ }
    }

    const verdict = classifyRetention(
      { workDone, terminalAt, introspectionDone: introspectionDoneFor(slug), costRolledUp: costRolledUpFor(slug), recordAgeMs },
      { graceMs, ceilingMs, now },
    );

    if (!verdict.deletable) { kept++; continue; }

    if (dryRun) {
      logFn(`  would delete records for ${slug} (${verdict.reason})`);
      wouldDelete.push({ session: slug, reason: verdict.reason });
      continue;
    }

    try { deleteCompletionFn(slug, completionDir); } catch { /* best-effort, mirrors the rest of this file */ }
    try { deleteDeliveryReportFn(slug, deliveryDir); } catch { /* best-effort */ }
    const stillListed = findSession(slug);
    if (stillListed?.id) {
      try { rm({ handle: stillListed.id, exec: execFileSync }); } catch (e) {
        logFn(`  ⚠ ${slug}: \`claude rm\` failed: ${String(e?.message || e).split('\n')[0]}`);
      }
    }
    // #2616 lane-ports registry — best-effort, item-kind targets only (a PR-kind session never owns one).
    // Shelled rather than imported: this file's scope for `#4089` does not touch `lane-pool.mjs`.
    if (target.kind === 'item') {
      try { execFileSync('node', ['scripts/lane-pool.mjs', 'unmap', `--item=${target.id}`], { cwd: REPO_ROOT, stdio: 'ignore', timeout: 15_000 }); } catch { /* best-effort */ }
    }
    logFn(`  deleted records for ${slug} (${verdict.reason})`);
    deleted++;
  }

  const pruneResult = pruneRuns({ maxAgeMs: ceilingMs, now, dryRun });

  return {
    scanned: slugs.size,
    deleted: dryRun ? 0 : deleted,
    kept,
    runsPruned: dryRun ? 0 : pruneResult.pruned.length,
    wouldPruneRuns: dryRun ? pruneResult.pruned : undefined,
    wouldDelete,
  };
}

// ── DISPATCH-SCRATCH SWEEP (#4188, bornAs `x5qketq`, epic #4075) ───────────────────────────────────────────
// PR #2701 (card #4174) gave every dispatched session its own scratch cwd, a fresh directory under
// `<workspace>/.operations/dispatch/<sessionId>` (`dispatch-lane-io.mjs#dispatchSessionCwd`, keyed by the SAME
// uuid `createDispatchSinks` mints and hands the CLI as the session's own `sessionId`), and grants it CLI
// workspace trust in the operator's `~/.claude.json` (`#grantDispatchTrust`) so `claude --bg` does not refuse
// it as untrusted. Nothing removed either once the owning session finished, so both grow forever — this
// section is that removal, a THIRD independent axis from the STOP pass (is the process still doing anything)
// and the #4089 RETENTION SWEEP above (has the session's semantic RECORD — a completion/delivery report keyed
// by its `review-<PR>`/`fix-<PR>`/… NAME — aged out). This axis is keyed by the session's raw UUID instead,
// because that is the only identity a dispatch-scratch folder carries; it never touches a completion record,
// a delivery report, or `claude rm`.
//
// THE SAME TWO-PATH SHAPE AS THE RETENTION SWEEP, deliberately reused rather than invented fresh:
//   PATH A — matched + finished + grace. The folder's own uuid names a row in `claude agents --json --all`
//     (matched by `sessionId`, never `id` — see this file's own header on why the two fields are not
//     interchangeable) whose `state` is terminal ({@link TERMINAL_REAP_STATES}/{@link ALREADY_STOPPED_STATES}),
//     OR the uuid names NO row at all (the CLI has already forgotten it — "reaped", the card's own third
//     qualifying word, alongside "stopped"/"done"). Either way, once the folder has sat at least `graceMs`
//     (default 24h) past its own last-modified time, it is safe to remove.
//   PATH B — the ceiling safety valve, for a folder whose match could not be resolved at all this tick (an
//     unreadable/empty `claude agents` listing) rather than one confirmed finished: once a folder is older than
//     `ceilingMs` (default 7 days) it is removed anyway, UNLESS some OTHER still-live row in the SAME listing
//     reports this exact directory as its own `cwd` — the closest proxy this file has for "a live process is
//     still using it" without shelling a platform-specific `lsof`/`/proc` scan (macOS has no `/proc`).
// A folder younger than both thresholds is always kept — the same "never guess" discipline as the STOP axes.

/** `WE_DISPATCH_SCRATCH_GRACE_HOURS` → path A's grace, in ms. Default 24h, matching the card's own wording. */
export const DISPATCH_SCRATCH_GRACE_MS_DEFAULT = 24 * 60 * 60 * 1000;

/** `WE_DISPATCH_SCRATCH_CEILING_DAYS` → path B's ceiling, in ms. Default 7 days — generous relative to path A's
 *  24h grace (this is the safety valve for when path A's own listing read failed, not the common case). */
export const DISPATCH_SCRATCH_CEILING_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;

/** `WE_DISPATCH_SCRATCH_GRACE_HOURS` → path A's grace, in ms. See {@link DISPATCH_SCRATCH_GRACE_MS_DEFAULT}. */
export function resolveDispatchScratchGraceMs(env = process.env) {
  return parseRetentionDurationSetting(env.WE_DISPATCH_SCRATCH_GRACE_HOURS, 60 * 60 * 1000, DISPATCH_SCRATCH_GRACE_MS_DEFAULT);
}

/** `WE_DISPATCH_SCRATCH_CEILING_DAYS` → path B's ceiling, in ms. See {@link DISPATCH_SCRATCH_CEILING_MS_DEFAULT}. */
export function resolveDispatchScratchCeilingMs(env = process.env) {
  return parseRetentionDurationSetting(env.WE_DISPATCH_SCRATCH_CEILING_DAYS, 24 * 60 * 60 * 1000, DISPATCH_SCRATCH_CEILING_MS_DEFAULT);
}

/**
 * THE PURE VERDICT for one dispatch-scratch folder. No fs/exec/clock — every signal is injected, same
 * discipline as {@link classifyRetention}.
 * @param {{ageMs: number|null, sessionRow: {state?:string}|null, liveCwdInUse: boolean}} candidate
 * @param {{graceMs: number|null, ceilingMs: number|null}} opts
 * @returns {{reap:boolean, reason:string}}
 */
export function classifyDispatchScratchEntry({ ageMs, sessionRow, liveCwdInUse } = {}, { graceMs, ceilingMs }) {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return { reap: false, reason: 'unknown-age' };
  const state = sessionRow?.state;
  const matchedTerminal = sessionRow
    ? (TERMINAL_REAP_STATES.has(state) || ALREADY_STOPPED_STATES.has(state))
    : true; // no row at all for this uuid — the CLI has already forgotten it ("reaped"), the card's own 3rd case
  if (sessionRow && !matchedTerminal) return { reap: false, reason: 'still-live' }; // working/blocked — never touch
  // Path A — matched (or reaped) + finished, once its own grace period has elapsed. GATED ON `!liveCwdInUse`
  // TOO (PR #2735 red-team finding 1, MOST SERIOUS): "no row for this uuid" ("unregistered") is weaker evidence
  // than a real terminal state — the listing can be incomplete/wrong for a genuinely-live long-running session
  // (its row can drift out of sync with the uuid its own scratch folder was minted under) — so path A must
  // independently confirm no OTHER live row in the same listing claims this exact directory as its own cwd
  // before deleting it, exactly like path B already does below. Every deletion path requires "no live process
  // has this as its cwd".
  if (matchedTerminal && graceMs !== null && ageMs >= graceMs) {
    if (liveCwdInUse) return { reap: false, reason: 'live-cwd-in-use' };
    return { reap: true, reason: sessionRow ? `finished:${state}` : 'unregistered' };
  }
  // Path B — the ceiling safety valve, gated on no OTHER live row claiming this directory as its cwd.
  if (ceilingMs !== null && ageMs >= ceilingMs && !liveCwdInUse) {
    return { reap: true, reason: 'ceiling' };
  }
  return { reap: false, reason: 'not-yet' };
}

/**
 * THE DISPATCH-SCRATCH SWEEP IO SHELL (#4188). Enumerates every folder directly under
 * {@link dispatchScratchRoot}, matches each one's name (a session uuid) against a fresh `claude agents --json
 * --all` listing by `sessionId` (never `id` — see the file header), and removes the ones
 * {@link classifyDispatchScratchEntry} calls reapable: the directory tree itself, then (batched, ONE write) the
 * `~/.claude.json` trust entries {@link revokeDispatchTrust} owns for every directory this pass actually
 * deleted. A folder is NEVER removed and left un-revoked, or vice versa, within one pass — the folder delete
 * happens first (the higher-value removal: a stale scratch dir is unbounded disk, the trust entry is a few
 * bytes), and only directories that delete cleanly are ever handed to the trust revoke.
 * @param {{
 *   dispatchRoot?: string,
 *   listAgents?: () => unknown[],
 *   graceMs?: number|null,
 *   ceilingMs?: number|null,
 *   now?: number,
 *   dryRun?: boolean,
 *   readdirSyncFn?: Function,
 *   statFn?: Function,
 *   rmDirFn?: (dir:string) => void,
 *   revokeTrust?: (dirs:string[]) => {revoked:string[]},
 *   log?: (msg:string) => void,
 * }} [o]
 * @returns {{scanned:number, deleted:number, kept:number, trustRevoked:number, wouldDelete:Array|undefined}}
 */
export function runDispatchScratchSweepPass({
  dispatchRoot = dispatchScratchRoot(),
  listAgents = () => defaultListAgents({ exec: execFileSync, all: true }),
  graceMs = resolveDispatchScratchGraceMs(),
  ceilingMs = resolveDispatchScratchCeilingMs(),
  now = Date.now(),
  dryRun = false,
  readdirSyncFn = readdirSync,
  statFn = statSync,
  rmDirFn = (dir) => rmSync(dir, { recursive: true, force: true }),
  revokeTrust = (dirs) => revokeDispatchTrust(dirs),
  log: logFn = log,
} = {}) {
  let names;
  try {
    names = readdirSyncFn(dispatchRoot, { withFileTypes: true })
      .filter((e) => (typeof e.isDirectory === 'function' ? e.isDirectory() : true))
      .map((e) => e.name)
      // LIVE-CAUGHT (#4188, 2026-09-26): `dispatchScratchRoot()` is NOT exclusively this sweep's own namespace —
      // a real machine was found with a `.lanes/.admission/gh` subtree living INSIDE `.operations/dispatch/`,
      // an entirely different subsystem's state that merely shares the same parent directory. `isSafeSessionId`
      // (this file's own filename-safety gate, reused rather than a second regex invented) rejects any name that
      // doesn't start with an alnum — which a dotdir like `.lanes` never does — so this is never touched. A
      // future non-uuid, non-dotfile collision is still theoretically possible; the STATE + trust match below
      // (a real session row, or a confirmed-gone one) is the actual safety net for that, not this filter alone.
      .filter((name) => isSafeSessionId(name));
  } catch {
    names = []; // no dispatch-scratch root at all yet (a fresh machine, or one that never dispatched) — nothing to do
  }

  let sessions;
  try { sessions = listAgents() ?? []; } catch { sessions = []; } // an unreadable listing degrades to "no match for anyone" — Path A never fires, only Path B (ceiling) can act, and only once confirmed no live row claims the folder
  const byId = new Map();
  const liveCwds = new Set();
  for (const s of sessions) {
    if (s && s.sessionId != null) byId.set(String(s.sessionId), s);
    const terminal = TERMINAL_REAP_STATES.has(s?.state) || ALREADY_STOPPED_STATES.has(s?.state);
    if (!terminal && s?.cwd) liveCwds.add(String(s.cwd));
  }

  let deleted = 0;
  let kept = 0;
  const toRevoke = [];
  const wouldDelete = dryRun ? [] : undefined;

  for (const name of [...names].sort()) {
    const dir = join(dispatchRoot, name);
    let ageMs = null;
    try { ageMs = now - statFn(dir).mtimeMs; } catch { /* stays null — `unknown-age` keeps it, never a guess */ }
    const verdict = classifyDispatchScratchEntry(
      { ageMs, sessionRow: byId.get(name) ?? null, liveCwdInUse: liveCwds.has(dir) },
      { graceMs, ceilingMs },
    );
    if (!verdict.reap) { kept++; continue; }
    if (dryRun) {
      logFn(`  would remove dispatch-scratch ${name} (${verdict.reason})`);
      wouldDelete.push({ dir: name, reason: verdict.reason });
      continue;
    }
    try {
      rmDirFn(dir);
    } catch (e) {
      logFn(`  ⚠ ${name}: dispatch-scratch rm failed: ${String(e?.message || e).split('\n')[0]}`);
      kept++;
      continue;
    }
    toRevoke.push(dir);
    logFn(`  removed dispatch-scratch ${name} (${verdict.reason})`);
    deleted++;
  }

  let trustRevoked = 0;
  if (!dryRun && toRevoke.length) {
    try { trustRevoked = (revokeTrust(toRevoke)?.revoked ?? []).length; } catch { /* best-effort — folders are already gone either way */ }
  }

  return {
    scanned: names.length,
    deleted: dryRun ? 0 : deleted,
    kept,
    trustRevoked: dryRun ? 0 : trustRevoked,
    wouldDelete,
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
 * PER-TICK REAP BUDGET (#3383 follow-up, live-caught 2026-09-26 — review-daemon restart at 18:02 ET: the
 * first tick's session-reap swept ~1,500 accumulated finished sessions one `claude stop` at a time (~95/min,
 * a real observed rate), taking 15+ minutes with NOTHING else in this single-threaded daemon able to run —
 * no review dispatched, no status tag refreshed, for the whole stall. `runSessionReaperPass` had no notion of
 * "enough for this tick" at all: a resident daemon calling it on every 120s tick must never let a backlog of
 * reap candidates turn one tick into a 15-minute outage of its OWN real job (dispatch + tagging).
 *
 * Both bounds are checked in the stop loop below (whichever is hit first ends the tick's reaping); either can
 * be raised for a one-off catch-up sweep (a CLI invocation, or a deliberately generous daemon override) via
 * the matching env var. `count` is the primary, predictable bound (95/min real-world rate × 45s ≈ 70, so 150
 * gives headroom while still comfortably finishing well inside one 120s tick); `durationMs` is the backstop
 * for a slower host or a run of retried failures. NEITHER bound loses work: any candidate this tick's budget
 * doesn't reach stays a reap candidate on the NEXT tick's fresh listing (recomputed from scratch every time,
 * never a saved-and-resumed cursor) — see {@link runSessionReaperPass}'s own `deferred` return field.
 */
export const DEFAULT_REAP_MAX_STOPS_PER_PASS = 150;
export const DEFAULT_REAP_MAX_DURATION_MS = 45_000;

/** `WE_SESSION_REAP_MAX_STOPS` — env override for {@link DEFAULT_REAP_MAX_STOPS_PER_PASS}. Any non-finite or
 *  non-positive value (unset, blank, `0`, garbage) falls back to the default rather than disabling the cap —
 *  this budget exists specifically so a caller CANNOT accidentally run unbounded again by a bad env value. */
export function resolveReapMaxStops(env = process.env) {
  const n = Number(env?.WE_SESSION_REAP_MAX_STOPS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_REAP_MAX_STOPS_PER_PASS;
}

/** `WE_SESSION_REAP_MAX_DURATION_MS` — env override for {@link DEFAULT_REAP_MAX_DURATION_MS}. Same
 *  fail-to-default discipline as {@link resolveReapMaxStops} above. */
export function resolveReapMaxDurationMs(env = process.env) {
  const n = Number(env?.WE_SESSION_REAP_MAX_DURATION_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_REAP_MAX_DURATION_MS;
}

/**
 * PURE: stably partitions `reap` so every candidate whose session `name` is in `priorityNames` sorts first,
 * preserving `reap`'s own relative order within each partition. Used to make a BUDGET-BOUNDED pass (see
 * {@link DEFAULT_REAP_MAX_STOPS_PER_PASS} above) spend its limited stops on the sessions most worth reaping
 * first: a PR this SAME tick found owed work for, but refused to dispatch because a bound session reads as
 * still live/blocked (`we:scripts/conveyor/reconcile-core.mjs#assessLiveness`'s `live-process`/`liveness-
 * unknown` verdicts) — reaping THAT specific session promptly is what actually frees the PR for the very next
 * tick's dispatch, rather than leaving it starved behind 1,500 unrelated, lower-stakes stale rows.
 * @param {Array<{session:object, reason:string}>} reap
 * @param {Set<string>|null|undefined} priorityNames
 * @returns {Array<{session:object, reason:string}>}
 */
export function prioritizeReapCandidates(reap, priorityNames) {
  const list = Array.isArray(reap) ? reap : [];
  if (!(priorityNames instanceof Set) || priorityNames.size === 0) return list;
  const prio = [];
  const rest = [];
  for (const r of list) (priorityNames.has(r?.session?.name) ? prio : rest).push(r);
  return [...prio, ...rest];
}

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

/** `~/.claude/we-session-reaper/reaped.json` — machine-wide like the chat-spawn stores above (every daemon
 *  clone reaps the same `claude agents` listing). `OPERATION_REAPED_LEDGER_FILE` overrides it. */
export function resolveReapedLedgerFile(env = process.env) {
  const override = env.OPERATION_REAPED_LEDGER_FILE;
  return override && override.trim() ? override.trim() : join(homedir(), '.claude', 'we-session-reaper', 'reaped.json');
}

/**
 * The reaper's memory of which session ids it already `claude stop`-ed (live-caught 2026-09-26: see the
 * `reapedLedger` filter in {@link runSessionReaperPass}). A plain id set on disk, pruned each pass to the ids the
 * listing still shows, so it stays the size of the listing. An unreadable/corrupt file reads as empty — the
 * worst case is one pass of redundant stops, exactly the pre-ledger behavior. `readFile`/`writeFile` are
 * injectable for tests.
 * @returns {{has:(id:string)=>boolean, add:(id:string)=>void, retainOnly:(ids:string[])=>void, save:()=>void, ids:()=>string[]}}
 */
export function makeReapedLedger({
  file = resolveReapedLedgerFile(),
  readFile = (f) => readFileSync(f, 'utf8'),
  writeFile = (f, text) => {
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, f);
  },
} = {}) {
  let set = new Set();
  try {
    const parsed = JSON.parse(readFile(file));
    if (Array.isArray(parsed?.ids)) set = new Set(parsed.ids.filter((x) => typeof x === 'string'));
  } catch { /* missing or corrupt — start empty */ }
  return {
    has: (id) => set.has(id),
    add: (id) => { if (typeof id === 'string' && id) set.add(id); },
    retainOnly: (ids) => { const keep = new Set(ids); set = new Set([...set].filter((id) => keep.has(id))); },
    save: () => writeFile(file, JSON.stringify({ v: 1, ids: [...set] }) + '\n'),
    ids: () => [...set],
  };
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
 *   completionFor?: ((nameOrRow:string|{name:string, sessionId?:string|null}) => object|null)|null,
 *   allowedCwd?: string,
 *   neverReapWorking?: boolean,
 *   idleThresholdMs?: number,
 *   now?: number,
 *   dryRun?: boolean,
 *   stop?: Function,
 *   log?: (msg:string) => void,
 *   hungFor?: ((session:object) => object|null)|null,
 *   noOutcomeFor?: ((session:object) => ({stall:boolean, reason?:string}|null))|null,
 *   chatSpawnGuardFor?: ((session:object) => ({blocked:boolean, reason?:string})|null)|null,
 *   authExpiredFor?: ((session:object) => ({authExpired:boolean, reason?:string}|null))|null,
 *   awaitingVerifyFor?: ((session:object) => ({awaiting:boolean}|null))|null,
 *   idleFinishedFor?: ((session:object) => ({finished:boolean, reason?:string}|null))|null,
 *   backstopCompletion?: boolean,
 *   readCompletionRecord?: (session:string) => object|null,
 *   writeCompletionRecord?: (record:object) => unknown,
 *   blockedOnInfraFor?: ((session:object) => boolean)|null,
 *   maxStops?: number,
 *   maxDurationMs?: number,
 *   clockNow?: () => number,
 *   priorityNames?: Set<string>|null,
 *   rateSession?: ((session:object, extra:{reason:string}) => unknown)|null,
 * }} [o]
 * @returns {{
 *   scanned: number, stopped: number, alreadyGone: number, failures: number, anomalies: number,
 *   backstopWritten: number, wouldStop: Array|undefined, collected: Array|undefined, kept: number,
 *   deferred: number, reapBudget: {maxStops:number, maxDurationMs:number, exhausted:boolean},
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
  // #4090 (epic #3383/#4075, statute clause 2) — the no-net-outcome axis. Default ON, same convention as
  // hung-detection: this is meant to actually run, not merely exist. `null` is the rollback escape hatch.
  noOutcomeFor = makeNoOutcomeResolver(),
  // #4091 (epic #3383/#4075, statute clause 4) — default ON: a session with no recorded link is unaffected
  // (see this axis's own header for why), so this is safe to run unconditionally, same as every other axis.
  chatSpawnGuardFor = makeChatSpawnGuardResolver(),
  // Live incident fix, night of 2026-09-25/26 ET (epic #3383/#4075) — default ON, same convention as every
  // other axis this epic ships: see `hung-session.mjs#readClaudeAuthExpiredInfo`'s own file header for why.
  authExpiredFor = makeAuthExpiredResolver(),
  // #4075/xg7m2wq (live incident PR #2724, 2026-09-26) — the general idle-turn-ended backstop, default ON like
  // every other axis this epic ships: see `hung-session.mjs#classifyIdleFinished`'s own file header for why.
  idleFinishedFor = makeIdleFinishedResolver(),
  awaitingVerifyFor = makeAwaitingVerifyResolver(),
  // #ghost-sessions-inflate-cap — UNLIKE this epic's other axes, `null` (OFF) is this FUNCTION's own default —
  // deliberately, not an oversight. `makePidDeadResolver()`'s real behavior answers "dead" for ANY session whose
  // `sessionId` does not appear in a real `ps aux` snapshot, which is true of EVERY synthetic test fixture this
  // file's own test suite constructs (they never correspond to a real process) — unlike `hungFor`/
  // `authExpiredFor`/`idleFinishedFor`'s real resolvers, which read a TRANSCRIPT FILE keyed by `cwd`/`id` and
  // degrade to `null` (unknown) when that file does not exist, this axis has no file to fail to find; it always
  // gets a definite answer. Defaulting it ON here would make every existing hung/auth/idle-finished test that
  // does not ALSO override `pidDeadFor` observe `pid-dead:ps-scan` instead of the axis it actually means to
  // exercise (confirmed live: 3 real test failures the first time this was tried default-ON here). See
  // {@link defaultReapSessions} (`skills-src/conveyor/review-daemon.mjs`) and this file's own `main()` CLI shell
  // for the two real production call sites that explicitly pass `pidDeadFor: makePidDeadResolver()` — the
  // capability ships fully wired for both real entry points; only this pure function's own bare default stays
  // opt-in, mirroring `backstopCompletion`'s sibling axes' own "riskier blast radius stays explicit" convention
  // (`runRetention`/`dispatch-scratch-sweep`, both opt-in for the identical reason: a real behavior change a
  // caller must ask for, not one a bare function call silently acquires).
  pidDeadFor = null,
  // xbv32pg follow-up (epic #3383) — THE ROOT-CAUSE FIX, not just a detection axis: see
  // {@link planBackstopCompletion}'s own docblock. Default ON, like every other axis this epic ships — a
  // caller that wants the pre-#3383 behavior byte-for-byte passes `backstopCompletion: false`.
  backstopCompletion = true,
  readCompletionRecord = tryReadCompletion,
  writeCompletionRecord = writeCompletion,
  // Live incident fix (PR #2647/#2625, 2026-09-25) — see {@link transcriptShowsIntendedBlockedOnInfra}'s own
  // doc. Default ON, same convention as every other axis this epic ships; `null` is the rollback escape hatch
  // (byte-identical to this file's pre-existing backstop behavior — always `UNREPORTED_EXIT_OUTCOME`).
  blockedOnInfraFor = transcriptShowsIntendedBlockedOnInfra,
  // See {@link makeReapedLedger}. `null` (the default) is byte-identical to the pre-ledger behavior.
  reapedLedger = null,
  // #3383 follow-up (live-caught 2026-09-26) — see {@link DEFAULT_REAP_MAX_STOPS_PER_PASS}'s own doc for the
  // incident. Defaults ON (env-resolved), unlike most axes' `null` rollback hatches, because an UNBOUNDED pass
  // is the bug this exists to close — a caller that genuinely wants one back (a deliberate one-off catch-up
  // sweep) passes `Infinity` explicitly for either.
  maxStops = resolveReapMaxStops(),
  maxDurationMs = resolveReapMaxDurationMs(),
  // Wall-clock budget clock — separate from `now` above (which freezes IDLE-axis age comparisons and is often
  // fixed in tests), so a test can fake elapsed time without also faking every age computation in this file.
  clockNow = Date.now,
  // See {@link prioritizeReapCandidates}. `null` (the default) processes `reap` in its own existing order —
  // byte-identical to before this option existed for every caller that doesn't supply one.
  priorityNames = null,
  // #4075/run-rating slice 1 — mechanical per-run grading (`we:scripts/conveyor/run-rating.mjs
  // #rateAndRecordSession`) hooked in HERE, the moment a session is confirmed stopped/already-gone below, so
  // every daemon session gets rated automatically with no separate sweep. `null` (the default) is the rollback
  // hatch, same convention as every other axis in this file — a caller that doesn't pass one gets byte-identical
  // pre-existing behavior. Never allowed to affect the reap outcome itself: called best-effort, inside its own
  // try/catch, strictly AFTER `stop()` has already succeeded.
  rateSession = null,
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

  const plan = sessionReapPlan(sessions, { groundTruthFor, completionFor, allowedCwd, neverReapWorking, idleThresholdMs, now, hungFor, noOutcomeFor, chatSpawnGuardFor, authExpiredFor, idleFinishedFor, awaitingVerifyFor, pidDeadFor });
  const { keep } = plan;
  let reap = plan.reap;
  let previouslyReaped = 0;
  if (reapedLedger) {
    // A `done`/`failed` session never changes state after `claude stop` — the listing keeps it `done` forever —
    // so without a memory of what was already stopped, every tick re-stopped every finished session (1,228 of
    // the 1,501 "stopped" per tick, live 2026-09-26, ~0.7s each: a 2-minute tick took ~20). Terminal-state rows
    // only: a `working`/`blocked` row that is still listed after a stop is worth another try.
    reapedLedger.retainOnly(sessions.map((s) => normalizeHandle(s?.id)).filter(Boolean));
    reap = reap.filter(({ session }) => {
      const id = normalizeHandle(session?.id);
      const skip = Boolean(id) && TERMINAL_REAP_STATES.has(session?.state) && reapedLedger.has(id);
      if (skip) previouslyReaped++;
      return !skip;
    });
  }

  // #3383 follow-up — priority FIRST, so a bounded budget (below) spends its limited stops on the sessions
  // most worth reaping (see {@link prioritizeReapCandidates}'s own doc), then the budget itself: whichever of
  // `maxStops`/`maxDurationMs` is hit first ends this PASS's reaping — never a hard failure, just "the rest
  // waits for the next tick's fresh listing" (see {@link DEFAULT_REAP_MAX_STOPS_PER_PASS}'s own doc for why
  // that costs nothing: the plan is recomputed from scratch every tick, never a saved cursor).
  const orderedReap = prioritizeReapCandidates(reap, priorityNames);
  const passStartedAt = clockNow();
  let budgetExhausted = false;
  let deferred = 0;

  let stopped = 0;
  let alreadyGone = 0;
  let failures = 0;
  let anomalies = 0;
  let backstopWritten = 0;
  const done = [];
  const wouldBackstop = [];
  for (const { session, reason } of orderedReap) {
    // Budget check BEFORE any work for this candidate — dry runs are diagnostic-only (no `claude stop` spawn,
    // no daemon-tick timing at stake) and are deliberately exempt, so `--dry-run`/a planning read always shows
    // the FULL candidate set regardless of the production budget.
    if (!dryRun && !budgetExhausted) {
      const stopsSoFar = stopped + alreadyGone + failures;
      if (stopsSoFar >= maxStops || (clockNow() - passStartedAt) >= maxDurationMs) budgetExhausted = true;
    }
    if (budgetExhausted && !dryRun) {
      deferred++;
      continue; // left for the next tick's fresh listing — still a genuine reap candidate, not lost
    }
    // xbv32pg follow-up (epic #3383) — computed for EVERY reap candidate, before the `id`/`dryRun` branches
    // below: a session already independently confirmed done by one of the axes above deserves a durable
    // completion record whether or not `claude stop` itself later succeeds (this is about the SESSION's own
    // work being finished, not about the OS-process stop). Never overwrites a real record — see
    // {@link planBackstopCompletion}'s own doc. A read/parse failure (corrupt record, invalid slug) is treated
    // exactly like every other resolver in this file: unknown, so skip the backstop this tick rather than guess.
    let backstopRecord = null;
    let backstopExpectPrior = null;
    if (backstopCompletion) {
      try {
        // #4090 — a no-outcome reap is THIS reaper's own definite verdict (see STALLED_OUTCOME's own doc for
        // why it outranks a transcript's stray blocked-on-infra mention); derived from the reap `reason` string
        // {@link classifySessionReapWithGroundTruth}'s axis -1 stamps, never re-derived from the session itself.
        const stalled = typeof reason === 'string' && reason.startsWith('no-outcome:');
        // Live incident fix, night of 2026-09-25/26 ET — same derive-from-`reason` discipline as `stalled`
        // above: the Claude-auth-expired axis already ran (inside `sessionReapPlan`, via `authExpiredFor`) to
        // produce this exact reap; re-reading the transcript here would be a second, redundant IO call for a
        // fact `reason` already carries.
        const authExpired = !stalled && typeof reason === 'string' && reason.startsWith('claude-auth-expired:');
        let blockedOnInfra = false;
        if (!stalled && !authExpired && typeof blockedOnInfraFor === 'function') {
          try { blockedOnInfra = blockedOnInfraFor(session) === true; } catch { blockedOnInfra = false; }
        }
        // #4306 Guard 1(b) — does THIS tick's own listing already show a DIFFERENT same-name session that
        // started after this one? A newer generation owns the name even before its own `started` report has
        // necessarily landed (the ~26s listing-lag window `fix-dispatch-claim.mjs`'s own header documents).
        // Compared by `id` (never `sessionId` — see this file's own "WHY `id`, NOT `sessionId`" header section)
        // so two rows for the SAME real session are never mistaken for two generations.
        const thisStartedMs = startedAtMs(session?.startedAt);
        const newerSameNameListed = (Array.isArray(sessions) ? sessions : []).some((other) => (
          other && other !== session && other.name === session.name
          && normalizeHandle(other.id) !== normalizeHandle(session.id)
          && Number.isFinite(thisStartedMs) && startedAtMs(other?.startedAt) > thisStartedMs
        ));
        // #4306 Guard 1(c) — the reaped session's own last CONFIRMED transcript activity, never its listing
        // `startedAt` (see {@link planBackstopCompletion}'s own doc for why a plain start-time comparison is
        // wrong here). Best-effort: `null` (unknown) never blocks the backstop on its own — only a RESOLVABLE
        // later timestamp does.
        let lastActivityMs = null;
        try { lastActivityMs = resolveLastActivityMs(session); } catch { lastActivityMs = null; }
        backstopExpectPrior = readCompletionRecord(session?.name);
        backstopRecord = planBackstopCompletion(
          session, backstopExpectPrior, undefined, blockedOnInfra, stalled, authExpired,
          { newerSameNameListed, lastActivityMs },
        );
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
        // #2647/#2625 fix — reports the ACTUAL outcome the record would carry, never the hardcoded generic
        // one: `backstopRecord.outcome` is `BLOCKED_ON_INFRA_OUTCOME` when the transcript showed that was the
        // session's own intent, {@link UNREPORTED_EXIT_OUTCOME} otherwise — see `planBackstopCompletion`'s doc.
        logFn(`  would write backstop completion record for ${session.name} (outcome: ${backstopRecord.outcome}) — no self-report was ever recorded`);
        wouldBackstop.push({ name: session.name ?? null, outcome: backstopRecord.outcome });
      }
      continue;
    }
    if (backstopRecord) {
      try {
        // #4306 — `expectPrior` (the SAME record `planBackstopCompletion` planned against) makes this write
        // CONDITIONAL: `writeCompletion` re-checks it under the per-name lock immediately before writing, so a
        // `started` report that lands between our read (above) and this write wins — the on-disk record no
        // longer matches what this plan assumed, and nothing is written over it.
        const writeResult = writeCompletionRecord(backstopRecord, undefined, { expectPrior: backstopExpectPrior });
        if (writeResult && typeof writeResult === 'object' && writeResult.written === false) {
          logFn(`  ⚑ skipped backstop completion record for ${session.name} — the on-disk record changed since this reaper planned the write (${writeResult.reason}); a fresher report already owns it`);
        } else {
          backstopWritten++;
          logFn(`  ⚑ wrote backstop completion record for ${session.name} (outcome: ${backstopRecord.outcome}) — no self-report was ever recorded before this reaper concluded it was done (${reason})`);
        }
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
      if (reapedLedger) reapedLedger.add(handle);
      // Rate this now-finished session — best-effort, and NEVER lets a rating failure look like a reap failure
      // (the reap above already succeeded; this is pure bookkeeping on top of it).
      if (typeof rateSession === 'function') {
        try { rateSession(session, { reason }); } catch (e) { logFn(`  ⚠ ${session.name}: run-rating skipped — ${String(e?.message || e).split('\n')[0]}`); }
      }
    } catch (e) {
      // ONE session's stop failing never blocks the rest of the pass (Done-when #3) — the same
      // "couldn't confirm, background service may be restarting" flakiness lease-reaper.mjs already treats
      // as per-candidate, not pass-fatal. Reaches here only after `STOP_RETRY_ATTEMPTS` all failed, so this IS
      // a real (not merely transient) failure — worth saying so, since the retry count is otherwise invisible.
      logFn(`  ⚠ ${handle}: stop failed after ${STOP_RETRY_ATTEMPTS} attempts (${String(e?.message || e).split('\n')[0]}) — left for the next tick`);
      failures++;
    }
  }

  if (reapedLedger && !dryRun) {
    try { reapedLedger.save(); } catch (e) { logFn(`  ⚠ reaped-ledger save failed (non-fatal — next tick re-stops): ${String(e?.message || e).split('\n')[0]}`); }
  }
  return {
    scanned: sessions.length,
    stopped: dryRun ? 0 : stopped,
    alreadyGone: dryRun ? 0 : alreadyGone,
    failures: dryRun ? 0 : failures,
    anomalies,
    backstopWritten: dryRun ? 0 : backstopWritten,
    wouldWriteBackstop: dryRun ? wouldBackstop : undefined,
    // `orderedReap`, NOT the raw `reap` — a `--dry-run` plan is a preview of what a real pass WOULD do,
    // including the ORDER a budget-bounded pass would spend its stops in (see `prioritizeReapCandidates`'s own
    // doc); reporting the plan's own pre-priority order here would silently lie about which candidates a
    // budgeted real pass reaches first.
    wouldStop: dryRun
      ? orderedReap.map((r) => ({ id: normalizeHandle(r.session.id) || null, sessionId: normalizeHandle(r.session.sessionId) || null, name: r.session.name ?? null, reason: r.reason }))
      : undefined,
    collected: dryRun ? undefined : done,
    kept: keep.length,
    // #3383 follow-up — how many reap candidates this PASS's budget didn't reach (0 whenever the whole `reap`
    // list fit inside it, the common case outside a real backlog). Never counted in `stopped`/`failures`/
    // `kept` — they are still-pending reap candidates, not classified `keep`, so a caller must not read a
    // non-zero `deferred` as "nothing left to do".
    deferred: dryRun ? 0 : deferred,
    reapBudget: { maxStops, maxDurationMs, exhausted: budgetExhausted },
    ...(reapedLedger ? { previouslyReaped } : {}),
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
  // `--no-stall-detection` is the same kind of rollback escape hatch, for the #4090 no-net-outcome axis —
  // default ON, since a looping bot that is never stopped is exactly the gap this axis exists to close. (Named
  // "stall", not "no-outcome", so the flag itself doesn't read as a double negative.)
  const noOutcomeFor = flags['no-stall-detection'] ? null : makeNoOutcomeResolver();
  // `--no-chat-spawn-guard` is the same rollback escape hatch, for the #4091 chat-spawn scope guard — default
  // ON: a session with no recorded link is unaffected, so this is safe to run unconditionally.
  const chatSpawnGuardFor = flags['no-chat-spawn-guard'] ? null : makeChatSpawnGuardResolver();
  // `--no-auth-expired-detection` is the same rollback escape hatch, for the Claude-auth-expired axis (live
  // incident, night of 2026-09-25/26 ET) — default ON, same convention as every other axis this epic ships.
  const authExpiredFor = flags['no-auth-expired-detection'] ? null : makeAuthExpiredResolver();
  // Rollback escape hatch for the await record exemption (we:scripts/conveyor/await-verify.mjs).
  const awaitingVerifyFor = flags['no-await-verify-exemption'] ? null : makeAwaitingVerifyResolver();
  // `--no-idle-finished-detection` is the same rollback escape hatch, for the general idle-turn-ended backstop
  // (#4075/xg7m2wq, live incident PR #2724, 2026-09-26) — default ON, same convention as every other axis this
  // epic ships. `--idle-finished-minutes=<n>` overrides `WE_IDLE_FINISHED_MINUTES` for this one invocation.
  const idleFinishedFor = flags['no-idle-finished-detection']
    ? null
    : makeIdleFinishedResolver(flags['idle-finished-minutes'] !== undefined ? { thresholdMs: Number(flags['idle-finished-minutes']) * 60 * 1000 } : {});
  // `--no-pid-dead-detection` is the same rollback escape hatch, for the #ghost-sessions-inflate-cap pid-dead
  // axis — default ON, same convention as every other axis this epic ships.
  const pidDeadFor = flags['no-pid-dead-detection'] ? null : makePidDeadResolver();
  // `--retention-sweep` OPTS IN to the #4089 retention pass — deliberately OPT-IN, not opt-out like this
  // file's other axes: unlike ground-truth/hung-detection/backstop-completion (which only ever change a STOP
  // decision), the retention sweep DELETES files and calls `claude rm` — a materially different blast radius
  // for a caller that invokes this CLI without expecting that. A resident daemon that wants it on every tick
  // calls {@link runRetentionSweepPass} directly (already fully daemon-usable, no CLI needed) rather than
  // relying on this flag. Shares this CLI's own `--dry-run`.
  const runRetention = !!flags['retention-sweep'];
  // `--dispatch-scratch-sweep` OPTS IN to the #4188 dispatch-scratch pass, same deliberate opt-in reasoning as
  // `--retention-sweep` immediately above (it deletes directories and edits `~/.claude.json`). A resident
  // daemon calls {@link runDispatchScratchSweepPass} directly. Shares this CLI's own `--dry-run`.
  const runDispatchScratchSweep = !!flags['dispatch-scratch-sweep'];
  // `--no-run-rating` is the same rollback escape hatch, for #4075/run-rating slice 1's mechanical per-run
  // grading — default ON, same convention as every other axis this epic ships. Never touches the reap decision
  // itself (see the call site inside `runSessionReaperPass`) — only whether a rated row also gets appended to
  // the scorecard store. Rates both PR-kind (`fix`/`ci-heal`/`review`/`inspect`) and item-kind (`conveyor`/
  // `prepare`/`prepare-decision`) sessions alike; a session name this grammar doesn't recognize is skipped,
  // never guessed at.
  const rateSession = flags['no-run-rating'] ? null : (session) => {
    const parsed = parseSessionSlug(session?.name);
    if (!parsed) return;
    const id = /^\d+$/.test(parsed.id) ? Number(parsed.id) : parsed.id;
    rateAndRecordSession({
      sessionName: session.name, sessionId: normalizeHandle(session.sessionId) || null,
      kind: parsed.kind, pr: parsed.itemKind ? null : id, item: parsed.itemKind ? id : null,
    });
  };

  const result = runSessionReaperPass({ groundTruthFor, completionFor, allowedCwd, neverReapWorking, idleThresholdMs, dryRun, hungFor, backstopCompletion, noOutcomeFor, chatSpawnGuardFor, authExpiredFor, idleFinishedFor, awaitingVerifyFor, pidDeadFor, rateSession });
  const retentionResult = runRetention ? runRetentionSweepPass({ dryRun }) : null;
  const dispatchScratchResult = runDispatchScratchSweep ? runDispatchScratchSweepPass({ dryRun }) : null;

  if (result.unreadable) {
    // Matches the pre-#3383 CLI exactly: an unreadable listing means nothing safe to act on — exit clean, no
    // stdout report (the warning already went to stderr inside `runSessionReaperPass`).
    process.exit(0);
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...result, retention: retentionResult, dispatchScratch: dispatchScratchResult }, null, 2) + '\n');
  } else {
    const { scanned, stopped, alreadyGone, failures, anomalies, backstopWritten, wouldStop, wouldWriteBackstop, kept } = result;
    log(
      `session-reaper: ${scanned} session(s) listed · ` +
        `${dryRun ? `${(wouldStop ?? []).length} would stop${(wouldWriteBackstop ?? []).length ? `, ${(wouldWriteBackstop ?? []).length} would get a backstop completion record` : ''}` : `${stopped} stopped${alreadyGone ? `, ${alreadyGone} already gone` : ''}${failures ? `, ${failures} failed` : ''}${anomalies ? `, ${anomalies} anomal${anomalies === 1 ? 'y' : 'ies'}` : ''}${backstopWritten ? `, ${backstopWritten} backstop completion record(s) written` : ''}`} · ${kept} kept`,
    );
    if (retentionResult) {
      log(
        `session-reaper retention: ${retentionResult.scanned} session record set(s) scanned · ` +
          `${dryRun ? `${(retentionResult.wouldDelete ?? []).length} would be deleted, ${(retentionResult.wouldPruneRuns ?? []).length} run record(s) would be pruned` : `${retentionResult.deleted} deleted, ${retentionResult.runsPruned} run record(s) pruned`} · ${retentionResult.kept} kept`,
      );
    }
    if (dispatchScratchResult) {
      log(
        `session-reaper dispatch-scratch: ${dispatchScratchResult.scanned} folder(s) scanned · ` +
          `${dryRun ? `${(dispatchScratchResult.wouldDelete ?? []).length} would be removed` : `${dispatchScratchResult.deleted} removed, ${dispatchScratchResult.trustRevoked} trust entr${dispatchScratchResult.trustRevoked === 1 ? 'y' : 'ies'} revoked`} · ${dispatchScratchResult.kept} kept`,
      );
    }
  }
  // Non-zero exit when a stop we ATTEMPTED actually failed, OR a reap candidate turned out to be missing its
  // `id` (the anomaly case — see the loop above) — mirrors lease-reaper.mjs's own convention, so a cron/loop
  // wrapper can tell a clean sweep from a partial one. `runQuiet` (the runner's own caller) swallows this
  // either way — it is surfaced for anyone invoking the CLI directly.
  process.exit(result.failures > 0 || result.anomalies > 0 ? 1 : 0);
}

/**
 * `node session-reaper.mjs stamp-chat-spawn` — the `.claude/settings.json` `SessionStart` hook's own body (see
 * this file's chat-spawn-link section for the full design). Reads the hook's stdin JSON payload for THIS
 * (newly-starting) session's own `session_id`, and `CLAUDE_CODE_SESSION_ID` from the environment for the
 * inherited parent id. Writes a link only when both are present, filename-safe, AND differ — a session with no
 * inherited id (the top-level chat itself, or a daemon that never had one) has nothing to link, and a session
 * somehow reporting itself as its own parent is a malformed payload, never written. Best-effort and silent on
 * any failure — a hook that fails a session start is a worse outcome than a missed link (matches every other
 * SessionStart hook in this repo's own settings.json, none of which fail the start on their own error).
 * @param {{readStdin?:()=>string, env?:object}} [io]
 */
export function runStampChatSpawnHook({ readStdin = () => readFileSync(0, 'utf8'), env = process.env } = {}) {
  let payload = {};
  try { payload = JSON.parse(readStdin()); } catch { /* best-effort — a malformed/absent payload writes nothing */ }
  const spawnedSessionId = payload?.session_id;
  const spawnedByChatSessionId = env?.CLAUDE_CODE_SESSION_ID;
  if (isSafeSessionId(spawnedSessionId) && isSafeSessionId(spawnedByChatSessionId) && spawnedSessionId !== spawnedByChatSessionId) {
    try { writeChatSpawnLink({ spawnedSessionId, spawnedByChatSessionId }); } catch { /* best-effort */ }
  }
}

/**
 * `node session-reaper.mjs mark-chat-ended` — the `.claude/settings.json` `SessionEnd` hook's own body. Reads
 * the hook's own stdin JSON payload for the ENDING session's `session_id` and marks it. See this file's
 * chat-spawn-link section header for why `SessionEnd` firing at all (regardless of its `reason` field, not
 * independently verified against a live payload in this environment) is treated as "explicitly ended".
 * Best-effort and silent on any failure, same reasoning as {@link runStampChatSpawnHook}.
 * @param {{readStdin?:()=>string}} [io]
 */
export function runMarkChatEndedHook({ readStdin = () => readFileSync(0, 'utf8') } = {}) {
  let payload = {};
  try { payload = JSON.parse(readStdin()); } catch { /* best-effort */ }
  const chatSessionId = payload?.session_id;
  if (isSafeSessionId(chatSessionId)) {
    try { markChatEnded(chatSessionId); } catch { /* best-effort */ }
  }
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [sub] = process.argv.slice(2);
  if (sub === 'stamp-chat-spawn') runStampChatSpawnHook();
  else if (sub === 'mark-chat-ended') runMarkChatEndedHook();
  else main(process.argv.slice(2));
}
